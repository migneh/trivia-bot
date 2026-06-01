'use strict';
/**
 * events/guildDelete.js
 *
 * Fires when the bot leaves or is removed from a guild.
 *
 * ─── Actions ─────────────────────────────────────────────────────────────────
 *
 *  1. Log the departure to console.
 *  2. Delete all registered slash commands for that guild.
 *     (Prevents ghost commands showing in server settings.)
 *  3. Cancel any active cron jobs / countdown timers for the guild.
 *  4. Notify the owner log channel.
 *
 * ─── What is NOT done ─────────────────────────────────────────────────────────
 *
 *  ✗ No SQLite data is deleted.
 *    Per spec: "retain all guild data in all three tables — no automatic deletion."
 *    Data is available immediately if the bot rejoins the guild.
 *
 *  ✗ No active session termination.
 *    If the bot was removed mid-session, Discord automatically invalidates
 *    the bot's permissions. The session collector will fail on next tick,
 *    triggering handleChannelLoss() which archives the session.
 *    If somehow a session is still in sm when this fires, we end it cleanly.
 *
 * ─── Partial guild objects ────────────────────────────────────────────────────
 *
 *   Discord.js may emit guildDelete with a partial Guild object if the guild
 *   was not cached (e.g. unavailable server). We only need guild.id, which
 *   is always present even on partial objects.
 *
 * ─── Slash command deletion ───────────────────────────────────────────────────
 *
 *   Sending an empty array to the guild commands endpoint deletes all
 *   application commands registered for that guild.
 *   This is a fire-and-forget operation — failure is logged but not fatal.
 */

const { Events, REST, Routes } = require('discord.js');
const config    = require('../config.json');
const sm        = require('../utils/sessionManager');
const scheduler = require('../scheduler/manager');
const { endSession, logToOwner } = require('../utils/gameEngine');


// ═══════════════════════════════════════════════════════════════════════════════
// EVENT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  name: Events.GuildDelete,
  once: false,

  /**
   * @param {import('discord.js').Guild} guild
   */
  async execute(guild) {
    const guildId   = guild.id;
    const guildName = guild.name ?? 'Unknown Guild';

    console.log(`[GuildDelete] Left: "${guildName}" (${guildId})`);

    // ── Step 1: End any active session for this guild ─────────────────────────
    await endActiveSession(guild.client, guildId);

    // ── Step 2: Cancel scheduler jobs ─────────────────────────────────────────
    try {
      scheduler.removeSchedule(guildId);
      console.log(`[GuildDelete] Scheduler cancelled for guild ${guildId}.`);
    } catch (err) {
      console.error(`[GuildDelete] Failed to cancel scheduler for guild ${guildId}:`, err.message);
    }

    // ── Step 3: Delete slash commands ─────────────────────────────────────────
    await deleteGuildCommands(guildId, guildName);

    // ── Step 4: Notify owner ───────────────────────────────────────────────────
    await logToOwner(
      guild.client,
      `⚠️ **Bot removed from guild:**\n` +
      `**Name:** ${guildName}\n` +
      `**ID:** \`${guildId}\`\n` +
      `*All guild data retained in database.*`
    );
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVE SESSION CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * If a session is active for this guild when the bot is removed,
 * end it immediately to ensure the session is archived to SQLite.
 *
 * In practice this is rare — Discord invalidates bot permissions
 * instantly on removal, so the active collector will fail first.
 * This is a safety net for edge cases.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 */
async function endActiveSession(client, guildId) {
  const session = sm.getSession(guildId);
  if (!session) return;

  console.log(`[GuildDelete] Active session found for guild ${guildId} — ending it.`);

  try {
    await endSession(client, session, 'channel_lost');
  } catch (err) {
    console.error(
      `[GuildDelete] Failed to end session for guild ${guildId}:`,
      err.message
    );
    // Force-remove from memory even if endSession threw
    sm.deleteSession(guildId);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SLASH COMMAND DELETION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Delete all slash commands registered for a guild by sending
 * an empty commands array to the Discord API.
 *
 * Fails silently — if the bot was force-removed, it may no longer have
 * permission to manage guild commands.
 *
 * @param {string} guildId
 * @param {string} guildName - for logging only
 */
async function deleteGuildCommands(guildId, guildName) {
  try {
    const rest = new REST({ version: '10' }).setToken(config.discordToken);

    await rest.put(
      Routes.applicationGuildCommands(config.clientId, guildId),
      { body: [] }
    );

    console.log(
      `[GuildDelete] Slash commands deleted for guild ${guildId} (${guildName}).`
    );

  } catch (err) {
    // Common causes:
    //   50001 — Missing Access (expected when forcibly removed)
    //   10004 — Unknown Guild (guild deleted entirely, not just bot removed)
    const expectedCodes = new Set([50001, 10004, 50013]);

    if (!expectedCodes.has(err.code)) {
      console.error(
        `[GuildDelete] Failed to delete commands for guild ${guildId}:`,
        err.message
      );
    } else {
      console.log(
        `[GuildDelete] Command deletion skipped for guild ${guildId} ` +
        `(expected error ${err.code}: ${err.message}).`
      );
    }
  }
}
