'use strict';
/**
 * events/ready.js
 *
 * Fires once when the Discord client is fully connected and ready.
 *
 * ─── Startup sequence ────────────────────────────────────────────────────────
 *
 *  1. Register slash commands for every guild the bot is currently in.
 *  2. Initialise the scheduler (loads schedule files, registers cron jobs).
 *  3. Run corruption detection on player_stats.
 *  4. Check for crashed sessions from the previous run and notify channels.
 *  5. Set bot activity status.
 *
 * ─── Slash command registration ──────────────────────────────────────────────
 *
 *  Commands are registered per-guild (not globally) for instant availability.
 *  Global commands take up to 1 hour to propagate — unacceptable for a bot
 *  that needs to work immediately after joining a new server.
 *
 *  Registration is batched: all guilds are processed concurrently with
 *  Promise.allSettled() so one failing guild doesn't block the rest.
 *
 * ─── Crash session recovery ──────────────────────────────────────────────────
 *
 *  If the bot crashed while sessions were active, index.js writes a
 *  crash_sessions.json file before exiting (via emergencyShutdown).
 *
 *  On the next boot, ready.js reads that file, notifies each affected
 *  channel in Arabic, and deletes the file.
 *
 *  Sessions are NOT resumed — only notifications are sent.
 *  The SQLite archive was written atomically before the crash, so data
 *  is safe regardless.
 */

const { Events, REST, Routes, ActivityType } = require('discord.js');
const fs      = require('node:fs');
const path    = require('node:path');
const config  = require('../config.json');
const { runCorruptionDetection } = require('../database/cache');
const scheduler = require('../scheduler/manager');

// ─── Crash session file path ───────────────────────────────────────────────────
const CRASH_FILE = path.resolve('./data/crash_sessions.json');


// ═══════════════════════════════════════════════════════════════════════════════
// EVENT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  name: Events.ClientReady,
  once: true,

  /**
   * @param {import('discord.js').Client} client
   */
  async execute(client) {
    console.log(`\n✅ Logged in as ${client.user.tag} (${client.user.id})`);
    console.log(`📡 Connected to ${client.guilds.cache.size} guild(s)\n`);

    // ── Step 1: Register slash commands for all guilds ─────────────────────────
    await registerCommandsAllGuilds(client);

    // ── Step 2: Initialise scheduler ──────────────────────────────────────────
    scheduler.init(client);

    // ── Step 3: Corruption detection ──────────────────────────────────────────
    await runCorruptionDetection(client, config);

    // ── Step 4: Notify crashed sessions ───────────────────────────────────────
    await notifyCrashedSessions(client);

    // ── Step 5: Set bot activity ───────────────────────────────────────────────
    client.user.setActivity('!trivia help | /trivia-help', {
      type: ActivityType.Playing,
    });

    console.log('\n🎮 Bot is fully ready.\n');
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// SLASH COMMAND REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load all slash command definitions and register them for every guild
 * the bot is currently in.
 *
 * Uses Promise.allSettled() so a single guild failure (e.g. missing
 * APPLICATIONS_COMMANDS scope) doesn't prevent other guilds from registering.
 *
 * @param {import('discord.js').Client} client
 */
async function registerCommandsAllGuilds(client) {
  const commands = loadCommandData();

  if (commands.length === 0) {
    console.warn('[Ready] No slash commands found to register.');
    return;
  }

  const rest    = new REST({ version: '10' }).setToken(config.discordToken);
  const guilds  = [...client.guilds.cache.values()];

  if (guilds.length === 0) {
    console.warn('[Ready] Bot is not in any guilds — no commands to register.');
    return;
  }

  console.log(`[Ready] Registering ${commands.length} slash command(s) in ${guilds.length} guild(s)...`);

  const results = await Promise.allSettled(
    guilds.map(guild =>
      rest.put(
        Routes.applicationGuildCommands(config.clientId, guild.id),
        { body: commands }
      )
    )
  );

  let successCount = 0;
  let failCount    = 0;

  results.forEach((result, index) => {
    const guild = guilds[index];
    if (result.status === 'fulfilled') {
      successCount++;
    } else {
      failCount++;
      console.error(
        `[Ready] Failed to register commands for guild ${guild.id} (${guild.name}):`,
        result.reason?.message ?? result.reason
      );
    }
  });

  console.log(
    `[Ready] Slash commands registered: ${successCount} succeeded, ${failCount} failed.`
  );
}

/**
 * Load all slash command JSON definitions from commands/slash/.
 * Only includes commands that export both `data` and `execute`.
 *
 * @returns {object[]} array of command JSON objects for the REST API
 */
function loadCommandData() {
  const slashDir = path.join(__dirname, '..', 'commands', 'slash');

  if (!fs.existsSync(slashDir)) {
    console.error('[Ready] commands/slash/ directory not found.');
    return [];
  }

  const commands = [];

  for (const file of fs.readdirSync(slashDir).filter(f => f.endsWith('.js'))) {
    try {
      const cmd = require(path.join(slashDir, file));
      if (cmd?.data && typeof cmd?.execute === 'function') {
        commands.push(cmd.data.toJSON());
      } else {
        console.warn(`[Ready] Skipping ${file} — missing data or execute export.`);
      }
    } catch (err) {
      console.error(`[Ready] Failed to load command file ${file}:`, err.message);
    }
  }

  return commands;
}


// ═══════════════════════════════════════════════════════════════════════════════
// CRASH SESSION RECOVERY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read the crash session file (if it exists), notify each affected channel
 * in Arabic, then delete the file.
 *
 * The crash file is written by emergencyShutdown() in index.js and contains:
 *   [{ guildId: string, channelId: string }, ...]
 *
 * @param {import('discord.js').Client} client
 */
async function notifyCrashedSessions(client) {
  if (!fs.existsSync(CRASH_FILE)) return;

  let crashed = [];
  try {
    crashed = JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8'));
  } catch (err) {
    console.error('[Ready] Failed to read crash_sessions.json:', err.message);
  }

  // Delete the file immediately — even if notifications fail
  try {
    fs.unlinkSync(CRASH_FILE);
  } catch (err) {
    console.error('[Ready] Failed to delete crash_sessions.json:', err.message);
  }

  if (!Array.isArray(crashed) || crashed.length === 0) return;

  console.log(`[Ready] Found ${crashed.length} crashed session(s) — sending notifications...`);

  const notifications = crashed.map(async ({ guildId, channelId }) => {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) return;

      await channel.send({
        content:
          '⚠️ **انتهت الجلسة السابقة** بسبب إعادة تشغيل البوت أو خطأ غير متوقع.\n' +
          'تم حفظ النتائج تلقائياً. يمكنكم بدء جلسة جديدة متى شئتم. 🎮',
      });

      console.log(`[Ready] Crash notification sent → guild ${guildId}, channel ${channelId}`);
    } catch (err) {
      console.error(
        `[Ready] Failed to send crash notification for guild ${guildId}:`,
        err.message
      );
    }
  });

  await Promise.allSettled(notifications);
}
