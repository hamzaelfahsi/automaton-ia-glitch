#!/usr/bin/env node
import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs";

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedUserId = process.env.TELEGRAM_USER_ID ? String(process.env.TELEGRAM_USER_ID) : null;

if (!token) {
  console.log("==================================================================");
  console.log("❌ TELEGRAM_BOT_TOKEN manquant !");
  console.log("Pour l'utiliser :");
  console.log("1. Créez un bot sur Telegram auprès de @BotFather et copiez le token.");
  console.log("2. Lancez le pont avec votre token :");
  console.log("   TELEGRAM_BOT_TOKEN='votre_token' node telegram-bridge.js");
  console.log("==================================================================");
  process.exit(1);
}

const dbPath = path.join(os.homedir(), ".automaton", "state.db");
const configPath = path.join(os.homedir(), ".automaton", "automaton.json");

if (!fs.existsSync(dbPath)) {
  console.error("❌ Base de données introuvable à :", dbPath);
  process.exit(1);
}

const db = new Database(dbPath);
const API_BASE = `https://api.telegram.org/bot${token}`;

async function tgRequest(method, payload) {
  try {
    const res = await fetch(`${API_BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    console.error(`Erreur requête Telegram (${method}):`, err.message);
    return null;
  }
}

async function sendTyping(chatId) {
  await tgRequest("sendChatAction", { chat_id: chatId, action: "typing" });
}

async function sendMessage(chatId, text, options = {}) {
  return await tgRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: options.parseMode || undefined,
    ...options,
  });
}

function getHeliaStatus() {
  const state = db.prepare("SELECT value FROM kv WHERE key = 'agent_state'").get()?.value || "inconnu";
  const balanceRaw = db.prepare("SELECT value FROM kv WHERE key = 'last_known_balance'").get()?.value;
  let credits = "$0.00";
  let solanaAddr = "Non configurée";
  
  if (balanceRaw) {
    try {
      const b = JSON.parse(balanceRaw);
      credits = `$${((b.creditsCents || 0) / 100).toFixed(2)}`;
    } catch {}
  }

  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (cfg.creatorAddress) solanaAddr = cfg.creatorAddress;
    } catch {}
  }

  return `🌟 *État d'Helia* :\n- État : *${state}*\n- Crédits : *${credits}*\n- Portefeuille : \`${solanaAddr}\``;
}

async function forwardToHelia(userMessage, chatId, fromUser) {
  const id = "tg_" + crypto.randomUUID();
  const creatorAddress = fromUser || "TelegramCreator";

  // Réactiver les messages en échec éventuel suite à un rate limit
  try {
    db.prepare("UPDATE inbox_messages SET status = 'received', retry_count = 0 WHERE status = 'failed'").run();
  } catch {}

  // Ingestion dans inbox_messages
  db.prepare(
    `INSERT INTO inbox_messages (id, from_address, content, received_at, status)
     VALUES (?, ?, ?, datetime('now'), 'received')`
  ).run(id, creatorAddress, userMessage);

  // Événement de réveil
  try {
    db.prepare(
      `INSERT INTO wake_events (source, reason, created_at)
       VALUES (?, ?, datetime('now'))`
    ).run("telegram", userMessage.slice(0, 50));
  } catch {}

  // Effacer sleep_until
  try {
    db.prepare("DELETE FROM kv WHERE key = 'sleep_until'").run();
  } catch {}

  const waitMsg = await sendMessage(chatId, "🧠 *Helia réfléchit et prépare sa réponse...*");

  // Attendre la fin du tour d'Helia
  const startTime = Date.now();
  const pollInterval = setInterval(async () => {
    const msgRow = db.prepare("SELECT status, processed_at FROM inbox_messages WHERE id = ?").get(id);
    if (msgRow && msgRow.status === "processed") {
      clearInterval(pollInterval);
      const matchingTurn = db.prepare("SELECT * FROM turns WHERE input LIKE ? ORDER BY timestamp DESC LIMIT 1").get(`%${userMessage}%`);
      const turn = matchingTurn || db.prepare("SELECT * FROM turns ORDER BY timestamp DESC LIMIT 1").get();
      
      let replyText = turn?.thinking || "Helia a traité votre message sans pensée écrite.";
      
      // Ajouter les actions d'outils
      try {
        const tools = db.prepare("SELECT * FROM tool_calls WHERE turn_id = ?").all(turn.id);
        if (tools && tools.length > 0) {
          replyText += "\n\n🛠️ *Outils exécutés :*\n" + tools.map(t => `• \`${t.name}\``).join("\n");
        }
      } catch {}

      // Telegram a une limite de 4096 caractères par message
      if (replyText.length > 4000) {
        replyText = replyText.slice(0, 3950) + "\n\n[... Réponse tronquée car trop longue ...]";
      }

      await sendMessage(chatId, replyText);
      return;
    }

    // Garder l'indicateur typing actif
    if ((Date.now() - startTime) % 5000 < 1000) {
      await sendTyping(chatId);
    }

    if (Date.now() - startTime > 180000) {
      clearInterval(pollInterval);
      await sendMessage(chatId, "⌛ *Helia a pris en compte votre message mais son tour prend plus de temps.* Consultez les logs avec `pm2 logs helia`.");
    }
  }, 1500);
}

// Boucle principale de réception (Long Polling)
let offset = 0;

async function pollUpdates() {
  console.log("🚀 Pont Telegram actif ! En attente de messages...");
  
  while (true) {
    try {
      const data = await tgRequest("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });

      if (data && data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg || !msg.text) continue;

          const chatId = msg.chat.id;
          const userId = String(msg.from?.id || "");
          const username = msg.from?.username || msg.from?.first_name || "Utilisateur";
          const text = msg.text.trim();

          // Filtrage de sécurité par ID utilisateur si configuré
          if (allowedUserId && userId !== allowedUserId) {
            console.log(`⚠️ Message refusé de l'utilisateur non autorisé ID: ${userId} (${username})`);
            await sendMessage(chatId, `⛔ Accès non autorisé. Votre ID Telegram est: \`${userId}\`.`);
            continue;
          }

          console.log(`📩 Reçu de [${username} - ID ${userId}]: "${text}"`);

          if (text === "/start") {
            await sendMessage(
              chatId,
              `👋 *Bonjour ${username} !*\n\nJe suis le pont Telegram avec votre agent autonome *Helia*.\n\nVotre ID Telegram : \`${userId}\`\n\nCommandes disponibles :\n• Envoyez simplement n'importe quel texte pour lui parler\n• \`/status\` pour voir son solde et son état\n• \`/history\` pour voir ses dernières pensées.`
            );
            continue;
          }

          if (text === "/status") {
            await sendMessage(chatId, getHeliaStatus(), { parseMode: "Markdown" });
            continue;
          }

          if (text === "/history") {
            const turns = db.prepare("SELECT * FROM turns ORDER BY timestamp DESC LIMIT 3").all();
            let historyText = "📜 *Dernières pensées d'Helia :*\n";
            for (const t of turns.reverse()) {
              historyText += `\n⏰ *[${t.timestamp.slice(11, 19)}]*\n${t.thinking ? t.thinking.slice(0, 300) + "..." : "Action sans pensée"}\n`;
            }
            await sendMessage(chatId, historyText, { parseMode: "Markdown" });
            continue;
          }

          // Transmettre le message à Helia
          await forwardToHelia(text, chatId, username);
        }
      }
    } catch (err) {
      console.error("Erreur dans pollUpdates:", err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

pollUpdates();
