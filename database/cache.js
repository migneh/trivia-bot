'use strict';
/**
 * database/cache.js
 *
 * Startup corruption detection + async player_stats rebuild.
 *
 * Corruption condition:
 *   A guild has rows in session_history but ZERO rows in player_stats.
 *   This indicates the async post-processing step was interrupted
 *   (bot crash, OOM kill, power loss) after the session was archived
 *   but before player_stats was updated.
 *
 * Recovery strategy:
 *   For each affected guild:
 *     1. Mark guild as "rebuilding" in the rebuildingGuilds Set.
 *     2. Run rebuildPlayerStatsForGuild() asynchronously via setImmediate.
 *     3. Remove from rebuildingGuilds when done.
 *
 * During rebuild:
 *   - isRebuilding(guildId) returns true.
 *   - Leaderboard and profile commands detect this and fall back to
 *     session_history queries, showing a visible Arabic loading note.
 *   - New sessions can still start — the game engine is unaffected.
 */

const queries      = require('./queries');
const { logToOwner } = require('../utils/gameEngine');

/**
 * Set of guild IDs currently undergoing a player_stats rebuild.
 * Checked by leaderboard and profile commands for fallback behaviour.
 * @type {Set<string>}
 */
const rebuildingGuilds = new Set();

/**
 * Run on every bot startup (from index.js after client is ready).
 * Detects orphaned session_history and triggers async rebuilds.
 *
 * @param {import('discord.js').Client} client
 * @param {object} config - the loaded config.json
 */
async function runCorruptionDetection(client, config) {
  let orphaned;
  try {
    orphaned = queries.getGuildsWithOrphanedHistory();
  } catch (err) {
    console.error('[Cache] Corruption detection query failed:', err.message);
    return;
  }

  if (orphaned.length === 0) {
    console.log('[Cache] Corruption check passed — all guilds healthy.');
    return;
  }

  const plural = orphaned.length === 1 ? 'guild' : 'guilds';
  console.warn(`[Cache] ⚠️ Corruption detected in ${orphaned.length} ${plural}:`);
  orphaned.forEach(id => console.warn(`  • ${id}`));

  // Notify owner log channel
  const ownerMsg =
    `⚠️ **كشف تلف في قاعدة البيانات**\n` +
    `${orphaned.length} سيرفر يملك سجلات جلسات بدون إحصائيات لاعبين.\n` +
    `جاري إعادة البناء تلقائياً في الخلفية...\n` +
    orphaned.map(id => `• \`${id}\``).join('\n');

  await logToOwner(client, ownerMsg).catch(() => {});

  // Kick off async rebuilds — one per guild, non-blocking
  for (const guildId of orphaned) {
    scheduleRebuild(client, guildId);
  }
}

/**
 * Schedule an async rebuild for a single guild.
 * Uses setImmediate so it doesn't block the event loop during startup.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 */
function scheduleRebuild(client, guildId) {
  rebuildingGuilds.add(guildId);
  console.log(`[Cache] Rebuild scheduled for guild ${guildId}.`);

  setImmediate(async () => {
    const startMs = Date.now();
    try {
      queries.rebuildPlayerStatsForGuild(guildId);

      const elapsed = Date.now() - startMs;
      console.log(`[Cache] ✅ Rebuild complete for guild ${guildId} (${elapsed}ms).`);

      await logToOwner(
        client,
        `✅ **إعادة البناء اكتملت** لسيرفر \`${guildId}\` في ${elapsed}ms.`
      ).catch(() => {});

    } catch (err) {
      console.error(`[Cache] ❌ Rebuild failed for guild ${guildId}:`, err.message);

      await logToOwner(
        client,
        `❌ **فشلت إعادة البناء** لسيرفر \`${guildId}\`: ${err.message}`
      ).catch(() => {});

    } finally {
      rebuildingGuilds.delete(guildId);
    }
  });
}

/**
 * Check if a guild's player_stats is currently being rebuilt.
 * Used by leaderboard and profile commands to show fallback data.
 *
 * @param {string} guildId
 * @returns {boolean}
 */
function isRebuilding(guildId) {
  return rebuildingGuilds.has(guildId);
}

/**
 * Manually trigger a rebuild for a guild (e.g. after admin request).
 * Safe to call even if the guild is already being rebuilt — skips if so.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @returns {boolean} true if rebuild was scheduled, false if already running
 */
function triggerRebuild(client, guildId) {
  if (rebuildingGuilds.has(guildId)) {
    console.log(`[Cache] Rebuild already in progress for guild ${guildId} — skipping.`);
    return false;
  }
  scheduleRebuild(client, guildId);
  return true;
}

module.exports = {
  runCorruptionDetection,
  isRebuilding,
  triggerRebuild,
};
