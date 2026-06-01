'use strict';
/**
 * index.js — Main entry point
 * Startup sequence:
 * 1. Load & validate config.json
 * 2. Load & validate questions.json
 * 3. Init SQLite schema + migrations
 * 4. Corruption detection
 * 5. Load schedule files
 * 6. Register slash commands per guild
 * 7. Start Discord client
 * 8. On ready: resume scheduler, check crashed sessions
 */

const fs   = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');

// ── 1. Load config ─────────────────────────────────────────────────────────
let config;
try {
  config = require('./config.json');
} catch {
  console.error('FATAL: config.json not found or invalid. Copy config.json and fill in your values.');
  process.exit(1);
}

if (!config.discordToken || config.discordToken === 'YOUR_TOKEN_HERE') {
  console.error('FATAL: discordToken not set in config.json');
  process.exit(1);
}
if (!config.clientId || config.clientId === 'YOUR_CLIENT_ID_HERE') {
  console.error('FATAL: clientId not set in config.json');
  process.exit(1);
}

// ── 2. Load & validate questions.json ──────────────────────────────────────
const { initQuestionBank } = require('./utils/questionBank');
const qbWarnings = initQuestionBank();

// ── 3. Init SQLite ──────────────────────────────────────────────────────────
const { initDb } = require('./database/schema');
try {
  initDb();
  console.log('[DB] SQLite ready.');
} catch (err) {
  console.error('FATAL: DB init failed:', err.message);
  process.exit(1);
}

// ── 4. Corruption detection (runs after ready) ──────────────────────────────
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
for (const file of fs.readdirSync(slashDir).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(slashDir, file));
  if (cmd?.data && cmd?.execute) {
    client.commands.set(cmd.data.name, cmd);
    console.log(`[Commands] Loaded slash: ${cmd.data.name}`);
  }
}

// ── Load events ──────────────────────────────────────────────────────────────
const eventsDir = path.join(__dirname, 'events');
for (const file of fs.readdirSync(eventsDir).filter(f => f.endsWith('.js'))) {
  const event = require(path.join(eventsDir, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
  console.log(`[Events] Loaded: ${event.name}`);
}

// ── Post-ready: corruption detection + question bank warnings ────────────────
client.once('ready', async () => {
  // Run corruption detection (async, non-blocking)
  await runCorruptionDetection(client, config);

  // Send question bank warnings to owner log channel
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

  // Attempt to log to owner channel
  try {
    const { logToOwner } = require('./utils/gameEngine');
    await logToOwner(client, `💥 **خطأ حرج [${source}]:** ${err?.message ?? String(err)}`);
  } catch {}

  // Terminate all active sessions atomically before exit
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

  // Write crash file so ready.js can notify channels on next boot
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
}

process.on('uncaughtException', async (err) => {
  console.error('[uncaughtException]', err);
  await emergencyShutdown('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[unhandledRejection]', reason);
  await emergencyShutdown('unhandledRejection', reason);
  // Do not exit — unhandled rejections are recoverable in some cases
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

// ── Login ────────────────────────────────────────────────────────────────────
client.login(config.discordToken).catch(err => {
  console.error('FATAL: Discord login failed:', err.message);
  process.exit(1);
});
