'use strict';
/**
 * index.js — Main entry point for Arabic Trivia Bot & Platform
 * Startup sequence:
 * 1. Load & validate config.json
 * 2. Load & validate questions.json
 * 3. Init SQLite schema + migrations (v1 to v5)
 * 4. Start HTTP Web Dashboard & REST API
 * 5. Load slash commands & event listeners
 * 6. Start Discord client & background services
 */

const fs   = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');

// ── 1. Load config ─────────────────────────────────────────────────────────
let config;
try {
  config = require('./config.json');
} catch {
  console.error('FATAL: config.json not found or invalid.');
  process.exit(1);
}

// ── 2. Load & validate questions.json ──────────────────────────────────────
const { initQuestionBank } = require('./utils/questionBank');
const qbWarnings = initQuestionBank();

// ── 3. Init SQLite ──────────────────────────────────────────────────────────
const { initDb } = require('./database/schema');
try {
  initDb();
  console.log('[DB] SQLite database initialized and migrations up to date.');
} catch (err) {
  console.error('FATAL: DB init failed:', err.message);
  process.exit(1);
}

// ── 4. Corruption detection ────────────────────────────────────────────────
const { runCorruptionDetection } = require('./database/cache');

// ── 5. Client setup ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();

// ── Load slash commands ──────────────────────────────────────────────────────
const slashDir = path.join(__dirname, 'commands', 'slash');
if (fs.existsSync(slashDir)) {
  for (const file of fs.readdirSync(slashDir).filter(f => f.endsWith('.js'))) {
    const cmd = require(path.join(slashDir, file));
    if (cmd?.data && cmd?.execute) {
      client.commands.set(cmd.data.name, cmd);
      console.log(`[Commands] Loaded slash: ${cmd.data.name}`);
    }
  }
}

// ── Load events ──────────────────────────────────────────────────────────────
const eventsDir = path.join(__dirname, 'events');
if (fs.existsSync(eventsDir)) {
  for (const file of fs.readdirSync(eventsDir).filter(f => f.endsWith('.js'))) {
    const event = require(path.join(eventsDir, file));
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
    console.log(`[Events] Loaded event: ${event.name}`);
  }
}

// ── 6. Start Web Dashboard & REST API ───────────────────────────────────────
const { createWebServer } = require('./web/server');
const webServer = createWebServer(client);
const webPort = config.webPort || 3000;

webServer.listen(webPort, '0.0.0.0', () => {
  console.log(`[Web] 🚀 Web Dashboard & REST API listening on http://0.0.0.0:${webPort}`);
});

// ── Post-ready: corruption detection + question bank warnings ────────────────
client.once('ready', async () => {
  await runCorruptionDetection(client, config);

  if (qbWarnings.length) {
    const { logToOwner } = require('./utils/gameEngine');
    const msg =
      `⚠️ **تحذيرات قاعدة الأسئلة (${qbWarnings.length}):**\n` +
      qbWarnings.slice(0, 20).map(w => `• ${w}`).join('\n') +
      (qbWarnings.length > 20 ? `\n... و${qbWarnings.length - 20} تحذير إضافي` : '');
    await logToOwner(client, msg).catch(() => {});
  }
});

// ── Global error handlers ────────────────────────────────────────────────────

async function emergencyShutdown(source, err) {
  console.error(`[${source}]`, err);

  try {
    const { logToOwner } = require('./utils/gameEngine');
    await logToOwner(client, `💥 **خطأ حرج [${source}]:** ${err?.message ?? String(err)}`);
  } catch {}

  const { getAllActiveSessions } = require('./utils/sessionManager');
  const { endSession }           = require('./utils/gameEngine');

  const activeSessions = getAllActiveSessions();

  for (const session of activeSessions) {
    try {
      await endSession(client, session, 'crash');
    } catch (e) {
      console.error(`[EmergencyShutdown] Failed to end session for guild ${session.guildId}:`, e.message);
    }
  }

  if (activeSessions.length > 0) {
    try {
      const crashData = activeSessions.map(s => ({
        guildId:   s.guildId,
        channelId: s.channelId,
      }));
      const crashFile = path.resolve('./data/crash_sessions.json');
      fs.mkdirSync(path.dirname(crashFile), { recursive: true });
      fs.writeFileSync(crashFile, JSON.stringify(crashData, null, 2));
      console.log(`[EmergencyShutdown] Crash file written for ${activeSessions.length} session(s).`);
    } catch (e) {
      console.error('[EmergencyShutdown] Failed to write crash file:', e.message);
    }
  }

  try {
    webServer.close();
  } catch {}
}

process.on('uncaughtException', async (err) => {
  console.error('[uncaughtException]', err);
  await emergencyShutdown('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[unhandledRejection]', reason);
  await emergencyShutdown('unhandledRejection', reason);
});

process.on('SIGTERM', async () => {
  console.log('[SIGTERM] Graceful shutdown initiated...');
  await emergencyShutdown('SIGTERM', new Error('Process terminated (SIGTERM)'));
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[SIGINT] Graceful shutdown initiated...');
  await emergencyShutdown('SIGINT', new Error('Process terminated (SIGINT)'));
  process.exit(0);
});

// ── Login if token is configured ─────────────────────────────────────────────
if (config.discordToken && config.discordToken !== 'YOUR_TOKEN_HERE') {
  client.login(config.discordToken).catch(err => {
    console.error('FATAL: Discord login failed:', err.message);
  });
} else {
  console.log('ℹ️ Bot token is not configured in config.json. Web Dashboard & API are running independently.');
}

module.exports = { client, webServer };
