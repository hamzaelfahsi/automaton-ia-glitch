#!/usr/bin/env node
import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs";

const args = process.argv.slice(2);
const dbPath = path.join(os.homedir(), ".automaton", "state.db");
const configPath = path.join(os.homedir(), ".automaton", "automaton.json");

if (!fs.existsSync(dbPath)) {
  console.error("Erreur: base de données introuvable à", dbPath);
  process.exit(1);
}

const db = new Database(dbPath);

// Option --history
if (args[0] === "--history" || args[0] === "-h") {
  const turns = db.prepare("SELECT * FROM turns ORDER BY timestamp DESC LIMIT 10").all();
  console.log("=== Dernières pensées et actions d'Helia ===");
  for (const t of turns.reverse()) {
    console.log(`\n[${t.timestamp}] (${t.state})`);
    if (t.input) console.log(`👉 Entrée: ${t.input}`);
    if (t.thinking) console.log(`🧠 Pensée: ${t.thinking}`);
  }
  process.exit(0);
}

const message = args.join(" ");
if (!message) {
  console.log("Usage: node talk.js <votre message>");
  console.log('Exemple: node talk.js "Bonjour Helia, présente-toi !"');
  console.log("Historique: node talk.js --history");
  process.exit(1);
}

let creatorAddress = "Creator";
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (cfg.creatorAddress) creatorAddress = cfg.creatorAddress;
  } catch {}
}

const id = "msg_" + crypto.randomUUID();

// Enregistrer dans inbox_messages
db.prepare(
  `INSERT INTO inbox_messages (id, from_address, content, received_at, status)
   VALUES (?, ?, ?, datetime('now'), 'received')`
).run(id, creatorAddress, message);

// Insérer un événement de réveil
try {
  db.prepare(
    `INSERT INTO wake_events (source, reason, created_at)
     VALUES (?, ?, datetime('now'))`
  ).run("creator", message.slice(0, 50));
} catch {}

// Effacer l'horloge de sommeil
try {
  db.prepare("DELETE FROM kv WHERE key = 'sleep_until'").run();
} catch {}

console.log(`\n💬 Message envoyé à Helia : "${message}"`);
console.log("⏳ Helia se réveille et prépare sa réponse...");

// Attente et suivi de la réponse en direct pendant 45 secondes max
const startTurnCount = db.prepare("SELECT COUNT(*) as count FROM turns").get().count;
const startTime = Date.now();

const checkInterval = setInterval(() => {
  const currentTurnCount = db.prepare("SELECT COUNT(*) as count FROM turns").get().count;
  if (currentTurnCount > startTurnCount) {
    clearInterval(checkInterval);
    const lastTurn = db.prepare("SELECT * FROM turns ORDER BY timestamp DESC LIMIT 1").get();
    console.log("\n================ REPONSE D'HELIA ================");
    if (lastTurn.thinking) {
      console.log(lastTurn.thinking);
    }
    try {
      const tools = db.prepare("SELECT * FROM tool_calls WHERE turn_id = ?").all(lastTurn.id);
      if (tools && tools.length > 0) {
        console.log("\n🛠️ Actions / Outils exécutés :");
        for (const t of tools) {
          console.log(`- ${t.name}: ${t.args}`);
          if (t.result) console.log(`  Résultat: ${String(t.result).slice(0, 200)}...`);
        }
      }
    } catch {}
    console.log("=================================================\n");
    process.exit(0);
  }

  if (Date.now() - startTime > 45000) {
    clearInterval(checkInterval);
    console.log("\n⌛ Helia traite votre message en arrière-plan. Suivez les logs avec : pm2 logs helia\n");
    process.exit(0);
  }
}, 1000);
