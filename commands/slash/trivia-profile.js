'use strict';
/**
 * commands/slash/trivia-profile.js
 *
 * Displays a player's public trivia profile.
 *
 * ─── Content ─────────────────────────────────────────────────────────────────
 *
 *   🎖️  Current title (based on all-time points, from config.json titles)
 *   ⭐  Total all-time points
 *   🏆  All-time rank ("المركز X من Y لاعب")
 *   🎮  Sessions participated
 *   🥇  Sessions won
 *   ✅  Total correct answers
 *   🔥  Longest streak achieved in a single session
 *   🏅  All unlocked achievements (name + description)
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 *
 *   Primary:  player_stats cache (fast, indexed).
 *   Fallback: session_history aggregation during rebuild (isRebuilding()).
 *             A visible Arabic note is shown when fallback is active.
 *
 * ─── Never-played user ───────────────────────────────────────────────────────
 *
 *   If the target user has no stats row: show profile with all zeros/empty.
 *   No error — per spec: "If the user has never played: show profile embed
 *   with all stats at zero/empty."
 *
 * ─── Self vs other ───────────────────────────────────────────────────────────
 *
 *   /trivia-profile            → own profile
 *   /trivia-profile @someone   → someone else's public profile
 *   Public stats only — no private data exposed.
 *
 * ─── Available to all members ────────────────────────────────────────────────
 *
 *   No permission requirement.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');

const config  = require('../../config.json');
const queries = require('../../database/queries');
const { getTitle }     = require('../../utils/scoring');
const { isRebuilding } = require('../../database/cache');


// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-profile')
    .setDescription('عرض الملف الشخصي لأحد اللاعبين في المسابقة')
    .addUserOption(opt =>
      opt
        .setName('user')
        .setDescription('اللاعب الذي تريد عرض ملفه (اتركه فارغاً لعرض ملفك)')
        .setRequired(false)
    )
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    const guildId   = interaction.guildId;
    const target    = interaction.options.getUser('user') ?? interaction.user;
    const isSelf    = target.id === interaction.user.id;
    const rebuilding = isRebuilding(guildId);

    // ── Fetch stats ────────────────────────────────────────────────────────────
    let stats = queries.getPlayerStats(guildId, target.id);

    // During rebuild: fall back to session_history aggregation
    if (!stats && rebuilding) {
      stats = buildStatsFromHistory(guildId, target.id);
    }

    // ── Parse data (safe defaults for never-played users) ─────────────────────
    const totalPoints   = stats?.total_points   ?? 0;
    const sessionCount  = stats?.session_count  ?? 0;
    const winCount      = stats?.win_count       ?? 0;
    const totalAnswers  = stats?.total_answers  ?? 0;
    const longestStreak = stats?.longest_streak ?? 0;

    let achievements = {};
    try { achievements = JSON.parse(stats?.achievements ?? '{}'); } catch {}

    // ── Rank calculation ───────────────────────────────────────────────────────
    const title        = getTitle(totalPoints);
    const totalPlayers = queries.getTotalPlayers(guildId);
    const rank         = totalPoints > 0
      ? queries.getPlayerRank(guildId, target.id)
      : null;

    // ── Achievement list ───────────────────────────────────────────────────────
    const unlockedAchs = config.achievements
      .filter(a => achievements[a.id] === true)
      .map(a => `🏅 **${a.nameAr}** — ${a.descriptionAr}`);

    // ── Win rate ───────────────────────────────────────────────────────────────
    const winRate = sessionCount > 0
      ? `${((winCount / sessionCount) * 100).toFixed(1)}%`
      : '—';

    // ── Points formatting ──────────────────────────────────────────────────────
    const ptsDisplay = Number.isInteger(totalPoints)
      ? totalPoints.toLocaleString('ar-SA')
      : totalPoints.toFixed(1);

    // ── Rank display ───────────────────────────────────────────────────────────
    const rankDisplay = rank
      ? `**#${rank}** من ${totalPlayers} لاعب`
      : totalPlayers > 0
        ? `خارج الترتيب (${totalPlayers} لاعب)`
        : 'أول لاعب في السيرفر!';

    // ── Build embed ────────────────────────────────────────────────────────────
    const embed = buildProfileEmbed({
      target,
      isSelf,
      title,
      totalPoints:    ptsDisplay,
      rank:           rankDisplay,
      sessionCount,
      winCount,
      winRate,
      totalAnswers,
      longestStreak,
      unlockedAchs,
      rebuilding,
      neverPlayed: !stats,
    });

    await interaction.editReply({ embeds: [embed] });
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// EMBED BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the full profile embed.
 *
 * @param {object} opts
 * @returns {EmbedBuilder}
 */
function buildProfileEmbed(opts) {
  const {
    target,
    isSelf,
    title,
    totalPoints,
    rank,
    sessionCount,
    winCount,
    winRate,
    totalAnswers,
    longestStreak,
    unlockedAchs,
    rebuilding,
    neverPlayed,
  } = opts;

  // ── Title bar ──────────────────────────────────────────────────────────────
  const embedTitle = isSelf
    ? `👤 ملفك الشخصي`
    : `👤 ملف اللاعب — ${target.username}`;

  // ── Description ────────────────────────────────────────────────────────────
  let description = '';
  if (neverPlayed) {
    description =
      isSelf
        ? '🌱 لم تشارك في أي جلسة بعد.\nابدأ بالمشاركة لتظهر إحصائياتك هنا!'
        : `🌱 **${target.username}** لم يشارك في أي جلسة بعد.`;
  }
  if (rebuilding) {
    description = (description ? description + '\n\n' : '') +
      '⚙️ *جاري إعادة بناء الإحصائيات — البيانات المعروضة مؤقتة*';
  }

  // ── Fields ─────────────────────────────────────────────────────────────────
  const fields = [
    {
      name:   '🎖️ اللقب الحالي',
      value:  title,
      inline: true,
    },
    {
      name:   '⭐ إجمالي النقاط',
      value:  `**${totalPoints}** نقطة`,
      inline: true,
    },
    {
      name:   '🏆 المركز',
      value:  rank,
      inline: true,
    },
    {
      name:   '🎮 الجلسات',
      value:  sessionCount > 0 ? `${sessionCount} جلسة` : '—',
      inline: true,
    },
    {
      name:   '🥇 الانتصارات',
      value:  winCount > 0 ? `${winCount} فوز (${winRate})` : '—',
      inline: true,
    },
    {
      name:   '✅ إجابات صحيحة',
      value:  totalAnswers > 0 ? `${totalAnswers} إجابة` : '—',
      inline: true,
    },
    {
      name:   '🔥 أطول سلسلة',
      value:  longestStreak > 0 ? `${longestStreak} إجابة متتالية` : '—',
      inline: true,
    },
  ];

  // ── Achievements field ─────────────────────────────────────────────────────
  const achValue = unlockedAchs.length > 0
    ? unlockedAchs.join('\n')
    : '🔒 لم يتم فتح أي إنجازات بعد.';

  // Split achievements if too long for one field (Discord limit: 1024 chars)
  const achChunks = splitIntoChunks(achValue, 1024);
  achChunks.forEach((chunk, i) => {
    fields.push({
      name:   i === 0 ? `🏅 الإنجازات (${unlockedAchs.length} / ${config.achievements.length})` : '​',
      value:  chunk,
      inline: false,
    });
  });

  // ── Build embed ────────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle(embedTitle)
    .setThumbnail(target.displayAvatarURL({ size: 128 }))
    .setColor(neverPlayed ? config.colors.info : config.colors.success)
    .addFields(fields)
    .setTimestamp()
    .setFooter({
      text: rebuilding
        ? '⚙️ الإحصائيات تُعاد بناؤها في الخلفية'
        : `بيانات محدّثة • ${target.username}`,
      iconURL: target.displayAvatarURL({ size: 32 }),
    });

  if (description) {
    embed.setDescription(description);
  }

  return embed;
}


// ═══════════════════════════════════════════════════════════════════════════════
// REBUILD FALLBACK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a lightweight stats object from session_history during a rebuild.
 * Returns null if the player has no history.
 *
 * This is an approximation — streak and speed data are not available
 * from session_history alone.
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {object|null}
 */
function buildStatsFromHistory(guildId, userId) {
  const sessions = queries.getSessionsByGuild(guildId);
  if (!sessions.length) return null;

  let totalPoints  = 0;
  let sessionCount = 0;
  let winCount     = 0;
  let totalAnswers = 0;
  let participated = false;

  for (const session of sessions) {
    let scores, questionsData;
    try { scores = JSON.parse(session.scores_data ?? '{}'); } catch { continue; }
    try { questionsData = JSON.parse(session.questions_data ?? '[]'); } catch { questionsData = []; }

    if (!(userId in scores)) continue;

    participated = true;
    const pts    = scores[userId] ?? 0;
    totalPoints += pts;
    sessionCount++;

    // Check if winner
    const maxScore = Math.max(...Object.values(scores));
    if (pts === maxScore && pts > 0) winCount++;

    // Count correct answers
    for (const q of questionsData) {
      if (!q.skipped && q.playerAnswers?.[userId]?.answerIndex === q.correctAnswer) {
        totalAnswers++;
      }
    }
  }

  if (!participated) return null;

  return {
    total_points:   totalPoints,
    session_count:  sessionCount,
    win_count:      winCount,
    total_answers:  totalAnswers,
    longest_streak: 0, // not available from history
    achievements:   '{}',
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Split a string into chunks of at most maxLen characters.
 * Splits on newline boundaries where possible.
 *
 * @param {string} str
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitIntoChunks(str, maxLen) {
  if (str.length <= maxLen) return [str];

  const lines  = str.split('\n');
  const chunks = [];
  let   current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
