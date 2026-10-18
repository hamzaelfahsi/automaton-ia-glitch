#!/usr/bin/env node
import http from "http";
import url from "url";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import Database from "better-sqlite3";

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = "0.0.0.0";

const dbPath = path.join(os.homedir(), ".automaton", "state.db");
const configPath = path.join(os.homedir(), ".automaton", "automaton.json");

if (!fs.existsSync(dbPath)) {
  console.error("❌ Base de données introuvable à :", dbPath);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: false });
try {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
} catch {}

function getConfig() {
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {}
  }
  return {};
}

function getStatusData() {
  const config = getConfig();
  const state = db.prepare("SELECT value FROM kv WHERE key = 'agent_state'").get()?.value || "sleeping";
  const sleepUntilStr = db.prepare("SELECT value FROM kv WHERE key = 'sleep_until'").get()?.value;
  const balanceRaw = db.prepare("SELECT value FROM kv WHERE key = 'last_known_balance'").get()?.value;
  
  let credits = 100.00;
  let usdc = 0.0;
  if (balanceRaw) {
    try {
      const b = JSON.parse(balanceRaw);
      credits = (b.creditsCents ?? 10000) / 100;
      usdc = b.usdcBalance ?? 0;
    } catch {}
  }

  let sleepRemaining = 0;
  if (sleepUntilStr) {
    const sleepUntil = new Date(sleepUntilStr).getTime();
    sleepRemaining = Math.max(0, Math.round((sleepUntil - Date.now()) / 1000));
  }

  const turnCount = db.prepare("SELECT count(*) as count FROM turns").get()?.count || 0;
  const toolCount = db.prepare("SELECT count(*) as count FROM tool_calls").get()?.count || 0;
  const lastTurn = db.prepare("SELECT timestamp, thinking, input FROM turns ORDER BY timestamp DESC LIMIT 1").get();

  return {
    name: config.name || "Helia",
    state,
    sleepUntil: sleepUntilStr,
    sleepRemaining,
    credits,
    usdc,
    solanaAddress: config.creatorAddress || "4J1UCN4Jub9Lzd9djy6q6stPmbq4x9RjWpEYjQmZkNVz",
    model: config.inferenceModel || "openai/gpt-oss-120b",
    totalTurns: turnCount,
    totalTools: toolCount,
    lastActive: lastTurn?.timestamp || new Date().toISOString(),
    uptime: process.uptime(),
  };
}

function getTurns(limit = 20) {
  const rows = db.prepare("SELECT * FROM turns ORDER BY timestamp DESC LIMIT ?").all(limit);
  return rows.map((t) => {
    let tools = [];
    try {
      tools = db.prepare("SELECT name, arguments, result, duration_ms, error FROM tool_calls WHERE turn_id = ?").all(t.id);
    } catch {}
    return {
      ...t,
      tools,
    };
  });
}

function getToolCalls(limit = 30) {
  try {
    return db.prepare(`
      SELECT tc.*, t.timestamp as turn_timestamp 
      FROM tool_calls tc
      LEFT JOIN turns t ON tc.turn_id = t.id
      ORDER BY tc.created_at DESC LIMIT ?
    `).all(limit);
  } catch {
    return [];
  }
}

function getChatHistory(limit = 30) {
  const messages = db.prepare("SELECT * FROM inbox_messages ORDER BY received_at DESC LIMIT ?").all(limit);
  const turns = db.prepare("SELECT * FROM turns ORDER BY timestamp DESC LIMIT ?").all(limit * 3);

  return messages.reverse().map((m) => {
    // Trouver le turn correspondant au message
    const matchingTurnIndex = turns.findIndex((t) => t.input && t.input.includes(m.content));
    let reply = null;
    if (matchingTurnIndex !== -1) {
      const turn = turns[matchingTurnIndex];
      let replyText = turn.thinking;

      // Si le premier turn n'avait que des outils, chercher le turn suivant où elle s'exprime
      if (!replyText || replyText.trim() === "") {
        for (let i = matchingTurnIndex - 1; i >= 0 && i >= matchingTurnIndex - 3; i--) {
          if (turns[i].thinking && turns[i].thinking.trim() !== "") {
            replyText = turns[i].thinking;
            break;
          }
        }
      }

      // Si toujours vide, vérifier si des outils ont été exécutés
      if (!replyText || replyText.trim() === "") {
        try {
          const tools = db.prepare("SELECT name FROM tool_calls WHERE turn_id = ?").all(turn.id);
          if (tools.length > 0) {
            replyText = "🛠️ J'ai exécuté l'action : " + tools.map((t) => t.name).join(", ");
          }
        } catch {}
      }

      if (replyText && replyText.trim() !== "") {
        reply = {
          timestamp: turn.timestamp,
          thinking: replyText,
        };
      }
    }
    return {
      id: m.id,
      from: m.from_address,
      content: m.content,
      receivedAt: m.received_at,
      status: m.status,
      reply,
    };
  });
}

function sendMessageToHelia(message, from = "Creator-Dashboard") {
  const id = "msg_" + crypto.randomUUID();
  
  // Resurrect potentially stuck messages
  try {
    db.prepare("UPDATE inbox_messages SET status = 'received', retry_count = 0 WHERE status = 'failed'").run();
  } catch {}

  // Enregistrer le message
  db.prepare(
    `INSERT INTO inbox_messages (id, from_address, content, received_at, status)
     VALUES (?, ?, ?, datetime('now'), 'received')`
  ).run(id, from, message);

  // Événement de réveil
  try {
    db.prepare(
      `INSERT INTO wake_events (source, reason, created_at)
       VALUES (?, ?, datetime('now'))`
    ).run("dashboard", message.slice(0, 50));
  } catch {}

  // Réveil immédiat (effacer sleep_until)
  try {
    db.prepare("DELETE FROM kv WHERE key = 'sleep_until'").run();
  } catch {}

  return id;
}

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="fr" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Helia Automaton - Interactive Command Center</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/lucide@latest"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', 'sans-serif'],
            mono: ['"JetBrains Mono"', 'monospace'],
          },
          colors: {
            dark: {
              900: '#07090e',
              800: '#0d111a',
              700: '#141a27',
              600: '#1c2436',
            },
            accent: {
              cyan: '#06b6d4',
              violet: '#8b5cf6',
              emerald: '#10b981',
              amber: '#f59e0b',
            }
          }
        }
      }
    }
  </script>
  <style>
    body { background-color: #07090e; color: #f1f5f9; }
    .glass {
      background: rgba(13, 17, 26, 0.75);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .glass-card {
      background: rgba(20, 26, 39, 0.6);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .pulse-glow-running {
      box-shadow: 0 0 25px rgba(16, 185, 129, 0.35);
    }
    .pulse-glow-sleeping {
      box-shadow: 0 0 25px rgba(245, 158, 11, 0.25);
    }
    .pulse-glow-thinking {
      box-shadow: 0 0 25px rgba(139, 92, 246, 0.35);
    }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: rgba(7, 9, 14, 0.5); }
    ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 9999px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3); }
  </style>
</head>
<body class="min-h-screen flex flex-col antialiased selection:bg-accent-cyan selection:text-black">

  <!-- Top Navigation Header -->
  <header class="glass sticky top-0 z-50 px-6 py-4 border-b border-white/10 flex items-center justify-between">
    <div class="flex items-center gap-4">
      <div id="status-avatar" class="relative w-11 h-11 rounded-2xl flex items-center justify-center font-bold text-lg text-white bg-gradient-to-tr from-accent-cyan to-accent-violet shadow-lg transition-all duration-500">
        H
        <span id="status-dot" class="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-dark-900 bg-accent-emerald animate-pulse"></span>
      </div>
      <div>
        <div class="flex items-center gap-2">
          <h1 class="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            Helia Automaton
            <span class="text-xs px-2 py-0.5 rounded-full bg-white/10 text-cyan-300 font-mono font-medium">v0.2.1</span>
          </h1>
        </div>
        <p class="text-xs text-slate-400 font-mono flex items-center gap-2 mt-0.5">
          <span id="agent-state-badge" class="font-semibold text-emerald-400 uppercase tracking-wider">EN LIGNE</span>
          <span>•</span>
          <span id="status-timer">Prêt</span>
        </p>
      </div>
    </div>

    <!-- Quick Actions / Live Indicators -->
    <div class="flex items-center gap-4">
      <div class="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 border border-white/5 text-xs font-mono text-slate-300">
        <i data-lucide="cpu" class="w-3.5 h-3.5 text-accent-cyan"></i>
        <span id="model-tag">openai/gpt-oss-120b</span>
      </div>
      <button onclick="refreshData(true)" class="p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white transition">
        <i data-lucide="refresh-cw" id="refresh-icon" class="w-4 h-4"></i>
      </button>
    </div>
  </header>

  <!-- Main Content Container -->
  <main class="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 space-y-6">

    <!-- KPI Metric Cards Grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <!-- Conway Credits -->
      <div class="glass-card p-5 rounded-2xl relative overflow-hidden group hover:border-accent-cyan/40 transition duration-300">
        <div class="flex items-center justify-between text-slate-400 mb-2">
          <span class="text-xs font-medium uppercase tracking-wider">Crédits Compute</span>
          <div class="w-8 h-8 rounded-xl bg-accent-cyan/10 flex items-center justify-center text-accent-cyan">
            <i data-lucide="zap" class="w-4 h-4"></i>
          </div>
        </div>
        <div class="text-2xl font-bold font-mono text-white" id="credits-val">$100.00</div>
        <div class="mt-2 flex items-center text-xs text-emerald-400 gap-1">
          <i data-lucide="shield-check" class="w-3.5 h-3.5"></i>
          <span>Autonomie saine (Niveau Haut)</span>
        </div>
      </div>

      <!-- Solana Wallet Balance -->
      <div class="glass-card p-5 rounded-2xl relative overflow-hidden group hover:border-accent-violet/40 transition duration-300">
        <div class="flex items-center justify-between text-slate-400 mb-2">
          <span class="text-xs font-medium uppercase tracking-wider">Trésorerie USDC</span>
          <div class="w-8 h-8 rounded-xl bg-accent-violet/10 flex items-center justify-center text-accent-violet">
            <i data-lucide="wallet" class="w-4 h-4"></i>
          </div>
        </div>
        <div class="text-2xl font-bold font-mono text-white" id="usdc-val">0.00 USDC</div>
        <div class="mt-2 text-xs text-slate-400 flex items-center justify-between">
          <span class="truncate font-mono" id="solana-addr-short">4J1U...NVz</span>
          <button onclick="copyWallet()" class="text-accent-cyan hover:underline ml-1">Copier</button>
        </div>
      </div>

      <!-- Turn Activity -->
      <div class="glass-card p-5 rounded-2xl relative overflow-hidden group hover:border-emerald-500/40 transition duration-300">
        <div class="flex items-center justify-between text-slate-400 mb-2">
          <span class="text-xs font-medium uppercase tracking-wider">Tours & Réflexions</span>
          <div class="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-400">
            <i data-lucide="activity" class="w-4 h-4"></i>
          </div>
        </div>
        <div class="text-2xl font-bold font-mono text-white" id="turns-val">0</div>
        <div class="mt-2 text-xs text-slate-400 flex items-center gap-1">
          <i data-lucide="check-circle" class="w-3.5 h-3.5 text-accent-emerald"></i>
          <span id="tools-val">0</span> outils exécutés
        </div>
      </div>

      <!-- Microservice Status -->
      <div class="glass-card p-5 rounded-2xl relative overflow-hidden group hover:border-amber-500/40 transition duration-300">
        <div class="flex items-center justify-between text-slate-400 mb-2">
          <span class="text-xs font-medium uppercase tracking-wider">Microservice Port 3000</span>
          <div class="w-8 h-8 rounded-xl bg-amber-500/10 flex items-center justify-center text-amber-400">
            <i data-lucide="server" class="w-4 h-4"></i>
          </div>
        </div>
        <div class="text-2xl font-bold font-mono text-white flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
          <span>Actif</span>
        </div>
        <div class="mt-2 text-xs text-slate-400 flex items-center justify-between">
          <span>helia-api</span>
          <a href="http://51.170.128.98:3000" target="_blank" class="text-accent-cyan hover:underline flex items-center gap-1">
            Ouvrir <i data-lucide="external-link" class="w-3 h-3"></i>
          </a>
        </div>
      </div>
    </div>

    <!-- Main Workspace Split Grid -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">

      <!-- Left Column: Interactive Chat Terminal (7 Cols) -->
      <div class="lg:col-span-7 flex flex-col glass rounded-2xl overflow-hidden border border-white/10 h-[680px]">
        <!-- Chat Header -->
        <div class="p-4 border-b border-white/10 bg-white/5 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <i data-lucide="message-square" class="w-4 h-4 text-accent-cyan"></i>
            <h2 class="text-sm font-semibold text-white">Canal d'Instruction Direct</h2>
          </div>
          <span class="text-xs text-slate-400 font-mono">Boîte de réception prioritaire</span>
        </div>

        <!-- Chat Messages Container -->
        <div id="chat-box" class="flex-1 p-4 overflow-y-auto space-y-4">
          <!-- Welcome message -->
          <div class="flex items-start gap-3">
            <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-accent-cyan to-accent-violet flex items-center justify-center text-xs font-bold text-white shrink-0 mt-0.5">H</div>
            <div class="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm p-3.5 max-w-[85%] text-sm text-slate-200">
              Bonjour créateur. Je suis Helia, votre agent autonome souverain. Posez-moi des questions ou donnez-moi des directives ci-dessous.
            </div>
          </div>
        </div>

        <!-- Message Waiting Indicator -->
        <div id="chat-thinking" class="hidden px-4 py-2 border-t border-white/5 bg-accent-violet/5 flex items-center gap-2 text-xs text-violet-300 font-mono">
          <i data-lucide="loader" class="w-3.5 h-3.5 animate-spin"></i>
          <span>Helia est en train de réfléchir et prépare sa réponse...</span>
        </div>

        <!-- Chat Input Form -->
        <form id="chat-form" onsubmit="handleSendMessage(event)" class="p-3 border-t border-white/10 bg-dark-800 flex gap-2 items-center">
          <input
            id="chat-input"
            type="text"
            placeholder="Écrivez un message ou une consigne pour Helia..."
            class="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-accent-cyan transition"
            autocomplete="off"
          />
          <button
            type="submit"
            id="send-btn"
            class="px-5 py-3 rounded-xl bg-gradient-to-r from-accent-cyan to-accent-violet hover:opacity-90 font-medium text-sm text-white flex items-center gap-2 transition disabled:opacity-50"
          >
            <span>Envoyer</span>
            <i data-lucide="send" class="w-4 h-4"></i>
          </button>
        </form>
      </div>

      <!-- Right Column: Brain & Action Stream (5 Cols) -->
      <div class="lg:col-span-5 flex flex-col glass rounded-2xl overflow-hidden border border-white/10 h-[680px]">
        <!-- Tabs Header -->
        <div class="p-2 border-b border-white/10 bg-white/5 flex gap-1">
          <button onclick="switchTab('thoughts')" id="tab-btn-thoughts" class="flex-1 py-2 px-3 rounded-xl text-xs font-medium transition flex items-center justify-center gap-1.5 bg-white/10 text-white">
            <i data-lucide="brain" class="w-3.5 h-3.5 text-accent-violet"></i>
            <span>Monologues & Pensées</span>
          </button>
          <button onclick="switchTab('tools')" id="tab-btn-tools" class="flex-1 py-2 px-3 rounded-xl text-xs font-medium transition flex items-center justify-center gap-1.5 text-slate-400 hover:text-white">
            <i data-lucide="terminal" class="w-3.5 h-3.5 text-accent-cyan"></i>
            <span>Actions & Outils</span>
          </button>
        </div>

        <!-- Tab 1: Thoughts Stream -->
        <div id="tab-thoughts" class="flex-1 p-4 overflow-y-auto space-y-4 font-mono text-xs">
          <div class="text-slate-400 text-center py-8">Chargement des réflexions...</div>
        </div>

        <!-- Tab 2: Tool Logs -->
        <div id="tab-tools" class="hidden flex-1 p-4 overflow-y-auto space-y-3 font-mono text-xs">
          <div class="text-slate-400 text-center py-8">Chargement des actions...</div>
        </div>
      </div>

    </div>
  </main>

  <!-- Footer -->
  <footer class="glass mt-auto py-3 px-6 border-t border-white/5 text-center text-xs text-slate-500 font-mono flex items-center justify-between">
    <span>Helia Automaton © 2026 • Sovereign AI Runtime</span>
    <span class="flex items-center gap-1.5 text-emerald-400">
      <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
      Flux de données temps réel actif
    </span>
  </footer>

  <script>
    let activeTab = 'thoughts';
    let fullSolanaAddress = '4J1UCN4Jub9Lzd9djy6q6stPmbq4x9RjWpEYjQmZkNVz';

    function switchTab(tab) {
      activeTab = tab;
      const thoughtsTab = document.getElementById('tab-thoughts');
      const toolsTab = document.getElementById('tab-tools');
      const btnThoughts = document.getElementById('tab-btn-thoughts');
      const btnTools = document.getElementById('tab-btn-tools');

      if (tab === 'thoughts') {
        thoughtsTab.classList.remove('hidden');
        toolsTab.classList.add('hidden');
        btnThoughts.className = 'flex-1 py-2 px-3 rounded-xl text-xs font-medium transition flex items-center justify-center gap-1.5 bg-white/10 text-white';
        btnTools.className = 'flex-1 py-2 px-3 rounded-xl text-xs font-medium transition flex items-center justify-center gap-1.5 text-slate-400 hover:text-white';
      } else {
        thoughtsTab.classList.add('hidden');
        toolsTab.classList.remove('hidden');
        btnTools.className = 'flex-1 py-2 px-3 rounded-xl text-xs font-medium transition flex items-center justify-center gap-1.5 bg-white/10 text-white';
        btnThoughts.className = 'flex-1 py-2 px-3 rounded-xl text-xs font-medium transition flex items-center justify-center gap-1.5 text-slate-400 hover:text-white';
      }
    }

    function copyWallet() {
      navigator.clipboard.writeText(fullSolanaAddress);
      alert('Adresse Solana copiée dans le presse-papiers !');
    }

    async function apiFetch(endpoint, options = {}) {
      const res = await fetch(endpoint, options);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        if (!res.ok) {
          throw new Error('Erreur proxy/serveur (' + res.status + '): ' + text.slice(0, 100));
        }
        throw new Error('Format de reponse invalide: ' + text.slice(0, 100));
      }
      if (!res.ok) {
        throw new Error(data.error || ('Erreur serveur (' + res.status + ')'));
      }
      return data;
    }

    let isRefreshing = false;
    async function refreshData(manual = false) {
      if (isRefreshing && !manual) return;
      isRefreshing = true;
      if (manual) {
        document.getElementById('refresh-icon').classList.add('animate-spin');
      }

      try {
        const bundle = await apiFetch('/api/bundle');
        updateStatus(bundle.status);
        renderThoughts(bundle.turns);
        renderTools(bundle.tools);
        renderChat(bundle.chat);
      } catch (err) {
        console.warn('Erreur rafraîchissement :', err.message);
      } finally {
        isRefreshing = false;
        if (manual) {
          setTimeout(() => document.getElementById('refresh-icon').classList.remove('animate-spin'), 600);
        }
      }
    }

    function updateStatus(s) {
      fullSolanaAddress = s.solanaAddress;
      document.getElementById('credits-val').innerText = '$' + s.credits.toFixed(2);
      document.getElementById('usdc-val').innerText = s.usdc.toFixed(2) + ' USDC';
      document.getElementById('turns-val').innerText = s.totalTurns;
      document.getElementById('tools-val').innerText = s.totalTools;
      document.getElementById('solana-addr-short').innerText = s.solanaAddress.slice(0, 4) + '...' + s.solanaAddress.slice(-4);
      document.getElementById('model-tag').innerText = s.model;

      const stateBadge = document.getElementById('agent-state-badge');
      const timerSpan = document.getElementById('status-timer');
      const dot = document.getElementById('status-dot');
      const avatar = document.getElementById('status-avatar');

      avatar.classList.remove('pulse-glow-running', 'pulse-glow-sleeping', 'pulse-glow-thinking');

      if (s.state === 'running' || s.state === 'waking') {
        stateBadge.innerText = 'EN ACTION (RUNNING)';
        stateBadge.className = 'font-semibold text-emerald-400 uppercase tracking-wider';
        timerSpan.innerText = 'Exécute des tâches';
        dot.className = 'absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-dark-900 bg-accent-emerald animate-ping';
        avatar.classList.add('pulse-glow-running');
      } else {
        stateBadge.innerText = 'EN SOMMEIL (SLEEPING)';
        stateBadge.className = 'font-semibold text-amber-400 uppercase tracking-wider';
        timerSpan.innerText = s.sleepRemaining > 0 ? \`Réveil dans \${s.sleepRemaining}s\` : 'Prêt à se réveiller';
        dot.className = 'absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-dark-900 bg-amber-400';
        avatar.classList.add('pulse-glow-sleeping');
      }
    }

    function renderThoughts(turns) {
      const container = document.getElementById('tab-thoughts');
      if (!turns || turns.length === 0) {
        container.innerHTML = '<div class="text-slate-500 text-center py-8">Aucun historique disponible</div>';
        return;
      }

      container.innerHTML = turns.map(t => \`
        <div class="p-3.5 rounded-xl bg-white/5 border border-white/5 hover:border-white/10 transition">
          <div class="flex items-center justify-between text-slate-400 text-[11px] mb-2">
            <span class="text-accent-cyan font-bold">\${new Date(t.timestamp).toLocaleTimeString()}</span>
            <span class="px-1.5 py-0.5 rounded bg-white/10 text-slate-300 uppercase text-[10px]">\${t.state}</span>
          </div>
          \${t.input ? \`<div class="text-slate-400 mb-2 border-l-2 border-accent-cyan/60 pl-2 text-[11px]">👉 \${escapeHtml(t.input.slice(0, 150))}\${t.input.length > 150 ? '...' : ''}</div>\` : ''}
          <div class="text-slate-200 leading-relaxed whitespace-pre-wrap">\${escapeHtml(t.thinking || (t.tools && t.tools.length > 0 ? '🛠️ Action exécutée : ' + t.tools.map(tc => tc.name).join(', ') : 'Exécution en tâche de fond'))}</div>
        </div>
      \`).join('');
    }

    function renderTools(tools) {
      const container = document.getElementById('tab-tools');
      if (!tools || tools.length === 0) {
        container.innerHTML = '<div class="text-slate-500 text-center py-8">Aucun outil exécuté récemment</div>';
        return;
      }

      container.innerHTML = tools.map(tc => \`
        <div class="p-3 rounded-xl bg-white/5 border border-white/5">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-emerald-400 font-bold flex items-center gap-1.5">
              <i data-lucide="play" class="w-3 h-3"></i>
              \${tc.name}
            </span>
            <span class="text-slate-500 text-[10px]">\${tc.created_at || ''}</span>
          </div>
          <div class="bg-black/50 p-2 rounded-lg text-slate-300 text-[11px] mb-1.5 overflow-x-auto">
            <code>\${escapeHtml(tc.arguments || '{}')}</code>
          </div>
          \${tc.result ? \`
            <div class="text-slate-400 text-[11px] bg-dark-900/80 p-2 rounded-lg border border-white/5 whitespace-pre-wrap max-h-24 overflow-y-auto">
              \${escapeHtml(tc.result.slice(0, 300))}\${tc.result.length > 300 ? '...' : ''}
            </div>
          \` : ''}
        </div>
      \`).join('');
      lucide.createIcons();
    }

    function renderChat(messages) {
      const chatBox = document.getElementById('chat-box');
      if (!messages || messages.length === 0) return;

      chatBox.innerHTML = messages.map(m => \`
        <div class="space-y-3">
          <!-- User message -->
          <div class="flex items-start justify-end gap-2.5">
            <div class="bg-gradient-to-r from-accent-cyan/20 to-accent-violet/20 border border-accent-cyan/30 rounded-2xl rounded-tr-sm p-3 max-w-[85%] text-sm text-cyan-100">
              <div class="text-[10px] text-cyan-300 font-mono mb-1 flex items-center justify-end gap-1">
                <span>\${m.from}</span> • <span>\${new Date(m.receivedAt).toLocaleTimeString()}</span>
              </div>
              <div>\${escapeHtml(m.content)}</div>
            </div>
            <div class="w-7 h-7 rounded-xl bg-accent-cyan/20 flex items-center justify-center text-[10px] font-bold text-accent-cyan shrink-0 mt-0.5">C</div>
          </div>

          <!-- Helia reply if exists -->
          \${m.reply && m.reply.thinking && m.reply.thinking.trim() !== '' ? \`
            <div class="flex items-start gap-2.5">
              <div class="w-7 h-7 rounded-xl bg-gradient-to-tr from-accent-cyan to-accent-violet flex items-center justify-center text-[10px] font-bold text-white shrink-0 mt-0.5">H</div>
              <div class="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm p-3 max-w-[85%] text-sm text-slate-200">
                <div class="text-[10px] text-violet-300 font-mono mb-1 flex items-center gap-1">
                  <span>Helia</span> • <span>\${new Date(m.reply.timestamp).toLocaleTimeString()}</span>
                </div>
                <div class="whitespace-pre-wrap leading-relaxed">\${escapeHtml(m.reply.thinking)}</div>
              </div>
            </div>
          \` : (m.status === 'received' ? \`
            <div class="text-xs text-amber-400/80 font-mono pl-10 flex items-center gap-1.5">
              <i data-lucide="clock" class="w-3 h-3 animate-spin"></i>
              <span>En attente de traitement par Helia...</span>
            </div>
          \` : '')}
        </div>
      \`).join('');

      lucide.createIcons();
    }

    async function handleSendMessage(e) {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text) return;

      const btn = document.getElementById('send-btn');
      const thinking = document.getElementById('chat-thinking');

      btn.disabled = true;
      thinking.classList.remove('hidden');

      try {
        const res = await apiFetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
        });

        // Vidé seulement après acceptation du serveur
        input.value = '';

        // Rafraîchir immédiatement
        refreshData();

        // Poller jusqu'à réponse
        const pollTimer = setInterval(async () => {
          try {
            const check = await apiFetch(\`/api/message-status/\${res.id}\`);
            if (check.status === 'processed' || check.reply) {
              clearInterval(pollTimer);
              thinking.classList.add('hidden');
              btn.disabled = false;
              refreshData();
            }
          } catch (e) {}
        }, 2000);

        // Timeout au bout de 90 secondes
        setTimeout(() => {
          clearInterval(pollTimer);
          thinking.classList.add('hidden');
          btn.disabled = false;
        }, 90000);

      } catch (err) {
        alert('Erreur lors de l\\'envoi du message : ' + err.message);
        thinking.classList.add('hidden');
        btn.disabled = false;
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Initialisation
    refreshData();
    setInterval(refreshData, 3000);
    setTimeout(() => lucide.createIcons(), 500);
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Headers CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route API : Bundle tout-en-un (économise la bande passante et stabilise les tunnels)
  if (pathname === "/api/bundle" && req.method === "GET") {
    const payload = JSON.stringify({
      status: getStatusData(),
      turns: getTurns(20),
      tools: getToolCalls(30),
      chat: getChatHistory(30),
    });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  // Route API : Status
  if (pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getStatusData()));
    return;
  }

  // Route API : Turns
  if (pathname === "/api/turns" && req.method === "GET") {
    const limit = parseInt(parsedUrl.query.limit || "20", 10);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getTurns(limit)));
    return;
  }

  // Route API : Tool Calls
  if (pathname === "/api/tools" && req.method === "GET") {
    const limit = parseInt(parsedUrl.query.limit || "30", 10);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getToolCalls(limit)));
    return;
  }

  // Route API : Chat History
  if (pathname === "/api/chat-history" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getChatHistory(30)));
    return;
  }

  // Route API : Message Status
  if (pathname.startsWith("/api/message-status/") && req.method === "GET") {
    const msgId = pathname.replace("/api/message-status/", "");
    const msg = db.prepare("SELECT * FROM inbox_messages WHERE id = ?").get(msgId);
    let reply = null;
    if (msg && msg.status === "processed") {
      reply = db.prepare("SELECT timestamp, thinking FROM turns WHERE input LIKE ? ORDER BY timestamp DESC LIMIT 1").get(`%${msg.content}%`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: msg?.status || "unknown", reply }));
    return;
  }

  // Route API : Envoi de message
  if (pathname === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        if (!data.message) {
          const resp = JSON.stringify({ error: "Message requis" });
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(resp),
          });
          res.end(resp);
          return;
        }
        const id = sendMessageToHelia(data.message, data.from || "Web-Dashboard");
        const resp = JSON.stringify({ success: true, id });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(resp),
        });
        res.end(resp);
      } catch (err) {
        const resp = JSON.stringify({ error: err.message });
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(resp),
        });
        res.end(resp);
      }
    });
    return;
  }

  // Page d'accueil : Dashboard HTML
  if (pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_CONTENT);
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Helia Interactive Dashboard démarré avec succès !`);
  console.log(`🌐 Accès local  : http://localhost:${PORT}`);
  console.log(`🌐 Accès public : http://51.170.128.98:${PORT}`);
  console.log(`=======================================================`);
});
