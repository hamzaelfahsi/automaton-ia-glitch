/**
 * Inference Router
 *
 * Routes inference requests through the model registry using
 * tier-based selection, budget enforcement, and provider-specific
 * message transformation.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEntry,
  SurvivalTier,
  InferenceTaskType,
  ModelProvider,
  ChatMessage,
  ModelPreference,
} from "../types.js";
import { ModelRegistry } from "./registry.js";
import { InferenceBudgetTracker } from "./budget.js";
import { DEFAULT_ROUTING_MATRIX, TASK_TIMEOUTS } from "./types.js";

type Database = BetterSqlite3.Database;

export class InferenceRouter {
  private db: Database;
  private registry: ModelRegistry;
  private budget: InferenceBudgetTracker;
  private coolingDownModels = new Map<string, number>();

  constructor(db: Database, registry: ModelRegistry, budget: InferenceBudgetTracker) {
    this.db = db;
    this.registry = registry;
    this.budget = budget;
  }

  isModelCoolingDown(modelId: string): boolean {
    const expiresAt = this.coolingDownModels.get(modelId);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.coolingDownModels.delete(modelId);
      return false;
    }
    return true;
  }

  markModelCooldown(modelId: string, durationMs: number = 600_000): void {
    this.coolingDownModels.set(modelId, Date.now() + durationMs);
  }

  private isProviderConfigured(provider: ModelProvider): boolean {
    if (provider === "groq") {
      return Boolean(process.env.GROQ_API_KEY);
    }
    if (provider === "gemini") {
      return Boolean(
        process.env.GEMINI_API_KEY ||
        process.env.OPENAI_API_KEY?.startsWith("AIzaSy") ||
        process.env.OPENAI_API_KEY?.startsWith("AQ.")
      );
    }
    if (provider === "openai") {
      const key = process.env.OPENAI_API_KEY;
      return Boolean(key && !key.startsWith("AIzaSy") && !key.startsWith("AQ."));
    }
    if (provider === "anthropic") {
      return Boolean(process.env.ANTHROPIC_API_KEY);
    }
    if (provider === "ollama") {
      return Boolean(process.env.OLLAMA_BASE_URL);
    }
    if (provider === "conway") {
      return true;
    }
    return true;
  }

  /**
   * Get all eligible candidate models for tier and task type,
   * filtering out models currently on rate-limit cooldown or without credentials.
   */
  getCandidates(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry[] {
    const candidates: ModelEntry[] = [];
    const preference = this.getPreference(tier, taskType);
    if (preference && preference.candidates.length > 0) {
      for (const candidateId of preference.candidates) {
        const entry = this.registry.get(candidateId);
        if (entry && entry.enabled && this.isProviderConfigured(entry.provider) && !this.isModelCoolingDown(entry.modelId)) {
          candidates.push(entry);
        }
      }
    }

    const strategy = this.budget.config;
    const fallbackIds: (string | undefined)[] =
      tier === "critical" || tier === "dead"
        ? [strategy.criticalModel, strategy.inferenceModel, strategy.lowComputeModel]
        : [strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel];

    for (const modelId of fallbackIds) {
      if (!modelId) continue;
      const entry = this.registry.get(modelId);
      if (entry && entry.enabled && this.isProviderConfigured(entry.provider) && !candidates.some((c) => c.modelId === entry.modelId) && !this.isModelCoolingDown(entry.modelId)) {
        candidates.push(entry);
      }
    }

    return candidates;
  }

  /**
   * Route an inference request: select model, check budget,
   * transform messages, call inference, record cost.
   * If a model fails with a rate-limit error, fall back to the next candidate.
   */
  async route(
    request: InferenceRequest,
    inferenceChat: (messages: any[], options: any) => Promise<any>,
  ): Promise<InferenceResult> {
    const { messages, taskType, tier, sessionId, turnId, tools } = request;

    let candidates = this.getCandidates(tier, taskType);
    if (candidates.length === 0) {
      // If all candidates are cooling down, clear cooldowns and retry
      if (this.coolingDownModels.size > 0) {
        this.coolingDownModels.clear();
        candidates = this.getCandidates(tier, taskType);
      }
      if (candidates.length === 0) {
        const fallback = this.selectModel(tier, taskType);
        if (fallback) candidates.push(fallback);
      }
    }

    if (candidates.length === 0) {
      return {
        content: "",
        model: "none",
        provider: "other",
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "error",
        toolCalls: undefined,
      };
    }

    let lastError: any;

    for (const model of candidates) {
      // 2. Estimate cost and check budget
      const estimatedTokens = messages.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
      const estimatedCostCents = Math.ceil(
        (estimatedTokens / 1000) * model.costPer1kInput / 100 +
        (request.maxTokens || 1000) / 1000 * model.costPer1kOutput / 100,
      );

      const budgetCheck = this.budget.checkBudget(estimatedCostCents, model.modelId);
      if (!budgetCheck.allowed) {
        continue;
      }

      // 3. Check session budget
      if (request.sessionId && this.budget.config.sessionBudgetCents > 0) {
        const sessionCost = this.budget.getSessionCost(request.sessionId);
        if (sessionCost + estimatedCostCents > this.budget.config.sessionBudgetCents) {
          continue;
        }
      }

      // 4. Transform messages for provider
      const transformedMessages = this.transformMessagesForProvider(messages, model.provider);

      // 5. Build inference options
      const preference = this.getPreference(tier, taskType);
      const maxTokens = request.maxTokens || preference?.maxTokens || model.maxTokens;
      const timeout = TASK_TIMEOUTS[taskType] || 120_000;

      const inferenceOptions: any = {
        model: model.modelId,
        maxTokens,
        tools: tools,
      };

      // 6. Call inference with timeout
      const startTime = Date.now();
      let response: any;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          inferenceOptions.signal = controller.signal;
          response = await inferenceChat(transformedMessages, inferenceOptions);
        } finally {
          clearTimeout(timer);
        }
      } catch (error: any) {
        lastError = error;
        const latencyMs = Date.now() - startTime;
        if (error.name === "AbortError") {
          return {
            content: `Inference timeout after ${timeout}ms`,
            model: model.modelId,
            provider: model.provider,
            inputTokens: 0,
            outputTokens: 0,
            costCents: 0,
            latencyMs,
            finishReason: "timeout",
          };
        }

        const isRateLimit =
          error.message?.includes("429") ||
          error.message?.includes("413") ||
          error.message?.includes("rate_limit") ||
          error.message?.includes("tokens per day") ||
          error.message?.includes("TPD") ||
          error.message?.includes("tokens per minute") ||
          error.message?.includes("TPM") ||
          error.message?.includes("quota") ||
          error.message?.includes("RESOURCE_EXHAUSTED") ||
          error.message?.includes("Circuit breaker is open");

        if (isRateLimit && candidates.length > 1) {
          // Model hit rate limit or quota. Put on 10 min cooldown and try next candidate!
          this.markModelCooldown(model.modelId, 600_000);
          continue;
        }

        throw error;
      }

      const latencyMs = Date.now() - startTime;

      // 7. Calculate actual cost
      const inputTokens = response.usage?.promptTokens || 0;
      const outputTokens = response.usage?.completionTokens || 0;
      const actualCostCents = Math.ceil(
        (inputTokens / 1000) * model.costPer1kInput / 100 +
        (outputTokens / 1000) * model.costPer1kOutput / 100,
      );

      // 8. Record cost
      this.budget.recordCost({
        sessionId,
        turnId: turnId || null,
        model: model.modelId,
        provider: model.provider,
        inputTokens,
        outputTokens,
        costCents: actualCostCents,
        latencyMs,
        tier,
        taskType,
        cacheHit: false,
      });

      // 9. Build result
      return {
        content: response.message?.content || "",
        model: model.modelId,
        provider: model.provider,
        inputTokens,
        outputTokens,
        costCents: actualCostCents,
        latencyMs,
        toolCalls: response.toolCalls,
        finishReason: response.finishReason || "stop",
      };
    }

    throw lastError;
  }

  /**
   * Select the best model for a given tier and task type.
   */
  selectModel(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry | null {
    const candidates = this.getCandidates(tier, taskType);
    if (candidates.length > 0) return candidates[0];

    if (this.coolingDownModels.size > 0) {
      this.coolingDownModels.clear();
      const retry = this.getCandidates(tier, taskType);
      if (retry.length > 0) return retry[0];
    }

    return null;
  }

  /**
   * Transform messages for a specific provider.
   * Handles Anthropic's alternating-role requirement.
   */
  transformMessagesForProvider(messages: ChatMessage[], provider: ModelProvider): ChatMessage[] {
    if (messages.length === 0) {
      throw new Error("Cannot route inference with empty message array");
    }

    if (provider === "anthropic") {
      return this.fixAnthropicMessages(messages);
    }

    // For OpenAI/Conway, merge consecutive same-role messages
    return this.mergeConsecutiveSameRole(messages);
  }

  /**
   * Fix messages for Anthropic's API requirements:
   * 1. Extract system messages
   * 2. Merge consecutive same-role messages
   * 3. Merge consecutive tool messages into a single user message
   *    with multiple tool_result content blocks
   */
  private fixAnthropicMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      // System messages are handled separately by the Anthropic client
      if (msg.role === "system") {
        result.push(msg);
        continue;
      }

      // Tool messages become user messages with tool_result content
      if (msg.role === "tool") {
        const last = result[result.length - 1];
        // If previous message was also a tool (now a user), merge into it
        if (last && last.role === "user" && (last as any)._toolResultMerged) {
          // Append to the merged content
          last.content = last.content + "\n[tool_result:" + (msg.tool_call_id || "unknown") + "] " + msg.content;
          continue;
        }
        // Otherwise create a new user message
        const userMsg: ChatMessage & { _toolResultMerged?: boolean } = {
          role: "user",
          content: "[tool_result:" + (msg.tool_call_id || "unknown") + "] " + msg.content,
          _toolResultMerged: true,
        };
        result.push(userMsg);
        continue;
      }

      // For user/assistant: merge with previous if same role
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }

      result.push({ ...msg });
    }

    // Clean up internal markers
    for (const msg of result) {
      delete (msg as any)._toolResultMerged;
    }

    return result;
  }

  /**
   * Merge consecutive messages with the same role.
   */
  private mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role && msg.role !== "system" && msg.role !== "tool") {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }
      result.push({ ...msg });
    }

    return result;
  }

  private getPreference(tier: SurvivalTier, taskType: InferenceTaskType): ModelPreference | undefined {
    return DEFAULT_ROUTING_MATRIX[tier]?.[taskType];
  }
}
