'use strict';
/**
 * commands/slash/trivia-leaderboard.js
 *
 * Displays the trivia leaderboard for the guild.
 *
 * ─── Time ranges ─────────────────────────────────────────────────────────────
 *
 *   day    → current UTC calendar day (00:00 → now)
 *   week   → current UTC calendar week (Sunday 00:00 → now)
 *   month  → current UTC calendar month (1st 00:00 → now)
 *   (none) → defaults to 'month'
 *
 *   All time boundaries are calculated in UTC to match how session_history
 *   stores ended_at timestamps (Unix ms, UTC).
 *
 * ─── Data source routing ─────────────────────────────────────────────────────
 *
 *   all-time → player_stats cache (O(log n) via index — fast)
 *   day / week / month → session_history (indexed by guild_id + ended_at)
 *
 *   During a player_stats rebuild (corruption recovery):
 *   all-time also falls back to session_history with a visible Arabic note.
 *
 * ─── Tie handling ─────────────────────────────────────────────────────────────
 *
 *   Players with identical scores share the same rank.
 *   The next rank after a tie group skips accordingly.
 *   Example: two players at 500pts are both 🥈 → next is 4th, not 3rd.
 *
 * ─── Display limit ───────────────────────────────────────────────────────────
 *
 *   Top 10 players shown by default.
 *   The calling user's rank is always shown at the bottom if they are
 *   outside the top 10 (all-time only — not available for time-ranges).
 *
 * ─── Available to all members ────────────────────────────────────────────────
 *
 *   No permission requirement — anyone can view the leaderboard.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');

const config  = require('../../config.json');
const queries = require('../../database/queries');
const { isRebuilding } = require('../../database/cache');
const { getTitle }     = require('../../utils/scoring');

// ─── Display constants ────────────────────────────────────────────────────────
const LEADERBOARD_LIMIT = 10;
const RANK_MEDALS       = ['🥇', '🥈', '🥉'];
const RANK_EMOJIS       = ['4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// ─── Time range definitions ────────────────────────────────────────────────────
const TIME_RANGES = {
  day: {
    labelAr: 'اليوم',
    emoji:   '📅',
    getStart: () => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    },
  },
  week: {
    labelAr: 'هذا الأسبوع',
    emoji:   '📆',
    getStart: () => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back to Sunday
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    },
  },
  month: {
    labelAr: 'هذا الشهر',
    emoji:   '🗓️',
    getStart: () => {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    },
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-leaderboard')
    .setDescription('عرض لوحة المتصدرين في المسابقة')
    .addStringOption(opt =>
      opt
        .setName('range')
        .setDescription('الفترة الزمنية للمتصدرين')
        .setRequired(false)
        .addChoices(
          { name: '📅 اليوم',        value: 'day'   },
          { name: '📆 هذا الأسبوع',  value: 'week'  },
          { name: '🗓️ هذا الشهر',   value: 'month' },
        )
    )
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    const guildId = interaction.guildId;
    const range   = interaction.options.getString('range') ?? 'month';

    await sendLeaderboard(interaction, guildId, range);
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// LEADERBOARD BUILDER  (exported for use by prefix router)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build and send the leaderboard embed.
 * Exported so the prefix router can call it directly without duplicating logic.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 *   Either a real slash interaction or a prefix shim object.
 * @param {string} guildId
 * @param {string} range - 'day' | 'week' | 'month' | anything else → month
 */
async function sendLeaderboard(interaction, guildId, range) {
  const now         = Date.now();
  const rebuilding  = isRebuilding(guildId);
  const validRange  = TIME_RANGES[range] ? range : 'month';

  // ── Fetch leaderboard rows ─────────────────────────────────────────────────
  let rows;

  if (validRange in TIME_RANGES) {
    // Time-range query: always from session_history (indexed)
    const startTs = TIME_RANGES[validRange].getStart();
    rows = queries.getTimeRangeLeaderboard(guildId, startTs, now, LEADERBOARD_LIMIT);
  } else {
    // Should never reach here — validRange is always one of the known keys
    rows = [];
  }

  // ── Build embed ────────────────────────────────────────────────────────────
  const rangeInfo  = TIME_RANGES[validRange];
  const embedTitle = `${rangeInfo.emoji} المتصدرون — ${rangeInfo.labelAr}`;

  const embed = new EmbedBuilder()
    .setTitle(embedTitle)
    .setColor(config.colors.success)
    .setTimestamp();

  // ── Format rankings ────────────────────────────────────────────────────────
  const lines = buildRankingLines(rows);

  let description = '';

  if (rebuilding) {
    description += '⚙️ *جاري إعادة بناء إحصائيات اللاعبين — البيانات مؤقتة*\n\n';
  }

  if (lines.length === 0) {
    description += `لا يوجد لاعبون في هذه الفترة بعد.\nابدأ جلسة باستخدام \`/trivia-start\`! 🎮`;
  } else {
    description += lines.join('\n');
  }

  embed.setDescription(description);

  // ── Caller's own rank (time-range only) ────────────────────────────────────
  // For time-ranges: check if the calling user appears in the results.
  // If not, note their absence (we don't have per-user time-range rank efficiently).
  const callerId = interaction.user?.id;
  if (callerId && rows.length > 0) {
    const userInList = rows.some(r => r.user_id === callerId);
    if (!userInList) {
      embed.setFooter({
        text: `أنت لست في القائمة خلال هذه الفترة — شارك في جلسة للحصول على نقاط!`,
      });
    }
  }

  await interaction.editReply({ embeds: [embed] });
}


// ═══════════════════════════════════════════════════════════════════════════════
// ALL-TIME LEADERBOARD  (separate export for profile/stats use)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build and send the all-time leaderboard from player_stats cache.
 * Falls back to session_history aggregation during rebuild.
 *
 * Includes the calling user's rank if they are outside the top N.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 * @param {string} guildId
 * @param {number} [limit]
 */
async function sendAllTimeLeaderboard(interaction, guildId, limit = LEADERBOARD_LIMIT) {
  const now        = Date.now();
  const rebuilding = isRebuilding(guildId);

  // During rebuild: fall back to session_history (from the beginning of time)
  let rows;
  if (rebuilding) {
    rows = queries.getTimeRangeLeaderboard(guildId, 0, now, limit);
  } else {
    rows = queries.getAllTimeLeaderboard(guildId, limit);
  }

  const embed = new EmbedBuilder()
    .setTitle('🏆 المتصدرون — كل الأوقات')
    .setColor(config.colors.success)
    .setTimestamp();

  const lines = buildRankingLines(rows, true /* showTitle */);

  let description = '';
  if (rebuilding) {
    description += '⚙️ *جاري إعادة بناء الإحصائيات — البيانات مؤقتة*\n\n';
  }

  description += lines.length > 0
    ? lines.join('\n')
    : 'لا يوجد لاعبون بعد.\nكن أول من يشارك! 🎮';

  embed.setDescription(description);

  // ── Caller's rank if outside top N ────────────────────────────────────────
  const callerId = interaction.user?.id;
  if (callerId && rows.length >= limit) {
    const userInList = rows.some(r => r.user_id === callerId);
    if (!userInList) {
      const callerRank   = queries.getPlayerRank(guildId, callerId);
      const totalPlayers = queries.getTotalPlayers(guildId);
      const callerStats  = queries.getPlayerStats(guildId, callerId);
      const callerPts    = callerStats?.total_points ?? 0;

      if (callerRank && totalPlayers) {
        embed.setFooter({
          text:
            `مركزك: ${callerRank} من ${totalPlayers} لاعب` +
            (callerPts > 0 ? ` — ${formatPoints(callerPts)} نقطة` : ''),
        });
      }
    }
  }

  await interaction.editReply({ embeds: [embed] });
}


// ═══════════════════════════════════════════════════════════════════════════════
// RANKING LINE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build an array of formatted ranking strings from leaderboard rows.
 * Handles ties correctly: tied players share a rank, next rank skips.
 *
 * @param {{ user_id: string, total_points: number, session_count?: number }[]} rows
 * @param {boolean} showTitle - if true, show player title from scoring.js
 * @returns {string[]}
 */
function buildRankingLines(rows, showTitle = false) {
  if (!rows || rows.length === 0) return [];

  const lines    = [];
  let lastScore  = null;
  let lastRank   = 0;
  let position   = 0;

  for (const row of rows) {
    position++;

    // Assign rank — same score = same rank (tie handling)
    if (lastScore === null || row.total_points !== lastScore) {
      lastRank = position;
    }

    const medal   = getRankDisplay(lastRank);
    const pts     = formatPoints(row.total_points);
    const mention = `<@${row.user_id}>`;

    let line = `${medal} ${mention} — **${pts}** نقطة`;

    // Optionally show player title
    if (showTitle) {
      const title = getTitle(row.total_points);
      line += ` *(${title})*`;
    }

    lines.push(line);
    lastScore = row.total_points;
  }

  return lines;
}

/**
 * Get the display string for a rank position.
 * Ranks 1-3 get medals, 4-10 get number emojis, beyond 10 get bold numbers.
 *
 * @param {number} rank - 1-based
 * @returns {string}
 */
function getRankDisplay(rank) {
  if (rank <= 3)  return RANK_MEDALS[rank - 1];
  if (rank <= 10) return RANK_EMOJIS[rank - 4];
  return `**${rank}.**`;
}

/**
 * Format a points number for display.
 * Integer → plain number, float → 1 decimal place.
 *
 * @param {number} pts
 * @returns {string}
 */
function formatPoints(pts) {
  if (!pts) return '0';
  return Number.isInteger(pts) ? String(pts) : pts.toFixed(1);
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports.sendLeaderboard       = sendLeaderboard;
module.exports.sendAllTimeLeaderboard = sendAllTimeLeaderboard;
