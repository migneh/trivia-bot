'use strict';
/**
 * commands/slash/trivia-stats.js
 *
 * Displays comprehensive guild-wide trivia statistics in a single embed.
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *
 *   player_stats    → session count, most active player
 *   question_stats  → hardest question, most missed question
 *   session_history → most played category, avg players (aggregated)
 *
 *   All reads go through queries.getGuildStats() which handles the
 *   cross-table aggregation.
 *
 * ─── Displayed metrics ───────────────────────────────────────────────────────
 *
 *   🎮 إجمالي الجلسات       — total completed sessions
 *   🗂️ أكثر فئة شعبية      — most played category
 *   👥 متوسط اللاعبين/جلسة  — average players per session
 *   🏃 أكثر لاعب نشاطاً    — most sessions participated
 *   😤 أصعب سؤال            — lowest correct answer rate (min 5 appearances)
 *   🫥 أكثر سؤال تجاهلاً   — highest zero-vote count
 *
 * ─── Empty state ─────────────────────────────────────────────────────────────
 *
 *   If no sessions have been played, show a friendly Arabic message
 *   inviting the admins to start the first session.
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

// ─── Category name lookup ─────────────────────────────────────────────────────
const CAT_NAMES = Object.fromEntries(
  config.categories.map(c => [c.id, c.nameAr])
);


// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-stats')
    .setDescription('عرض إحصائيات المسابقة الكاملة في هذا السيرفر')
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    const guildId = interaction.guildId;

    await sendStats(interaction, guildId);
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// STATS SENDER  (exported for prefix router)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch guild stats and send the embed.
 * Exported so the prefix router can call it directly.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | object} interaction
 * @param {string} guildId
 */
async function sendStats(interaction, guildId) {
  let stats;
  try {
    stats = queries.getGuildStats(guildId);
  } catch (err) {
    console.error('[Stats] Failed to fetch guild stats:', err.message);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('⛔ خطأ في جلب الإحصائيات')
          .setDescription(
            'حدث خطأ أثناء قراءة إحصائيات السيرفر من قاعدة البيانات.\n' +
            'يرجى المحاولة مجدداً لاحقاً.'
          )
          .setColor(config.colors.error),
      ],
    });
    return;
  }

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (!stats || stats.sessionCount === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📊 إحصائيات السيرفر')
          .setDescription(
            '**لا توجد إحصائيات بعد!**\n\n' +
            'لم تُلعب أي جلسة مسابقة في هذا السيرفر حتى الآن.\n\n' +
            '🎮 استخدم `/trivia-start` لبدء أول جلسة وتبدأ الإحصائيات بالتجمع تلقائياً!'
          )
          .setColor(config.colors.info)
          .setTimestamp(),
      ],
    });
    return;
  }

  // ── Build embed ─────────────────────────────────────────────────────────────
  const embed = buildStatsEmbed(stats, guildId);
  await interaction.editReply({ embeds: [embed] });
}


// ═══════════════════════════════════════════════════════════════════════════════
// EMBED BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the full stats embed from the aggregated stats object.
 *
 * @param {object} stats - returned by queries.getGuildStats()
 * @param {string} guildId
 * @returns {EmbedBuilder}
 */
function buildStatsEmbed(stats, guildId) {
  const embed = new EmbedBuilder()
    .setTitle('📊 إحصائيات المسابقة في السيرفر')
    .setColor(config.colors.info)
    .setTimestamp();

  // ── General stats ───────────────────────────────────────────────────────────
  embed.addFields(
    {
      name:   '🎮 إجمالي الجلسات',
      value:  formatNumber(stats.sessionCount),
      inline: true,
    },
    {
      name:   '👥 متوسط اللاعبين/جلسة',
      value:  stats.avgPlayers > 0 ? `${stats.avgPlayers} لاعب` : '—',
      inline: true,
    },
    {
      name:   '🗂️ أكثر فئة شعبية',
      value:  stats.topCat
        ? (CAT_NAMES[stats.topCat] ?? stats.topCat)
        : 'لا يوجد بيانات',
      inline: true,
    },
  );

  // ── Most active player ──────────────────────────────────────────────────────
  embed.addFields({
    name:  '🏃 أكثر لاعب نشاطاً',
    value: stats.activePlayer
      ? `<@${stats.activePlayer.user_id}> — **${stats.activePlayer.session_count}** جلسة`
      : 'لا يوجد بيانات',
    inline: false,
  });

  // ── Question insights ───────────────────────────────────────────────────────
  embed.addFields(
    buildHardestQuestionField(stats.hardest),
    buildMostMissedField(stats.mostMissed),
  );

  // ── Total players ───────────────────────────────────────────────────────────
  const totalPlayers = queries.getTotalPlayers(guildId);
  if (totalPlayers > 0) {
    embed.addFields({
      name:   '🌍 إجمالي اللاعبين',
      value:  `**${formatNumber(totalPlayers)}** لاعب شارك في المسابقة`,
      inline: true,
    });
  }

  // ── Top scorer (all-time) ───────────────────────────────────────────────────
  const topScorers = queries.getAllTimeLeaderboard(guildId, 1);
  if (topScorers.length > 0) {
    const top = topScorers[0];
    embed.addFields({
      name:  '⭐ أعلى مجموع نقاط',
      value: `<@${top.user_id}> — **${formatPoints(top.total_points)}** نقطة`,
      inline: true,
    });
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  embed.setFooter({
    text: 'الإحصائيات تُحدَّث تلقائياً بعد كل جلسة',
  });

  return embed;
}


// ═══════════════════════════════════════════════════════════════════════════════
// FIELD BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the "hardest question" embed field.
 * Shows the question ID and correct answer rate.
 *
 * @param {object|null} hardest - from queries.getGuildStats()
 * @returns {{ name: string, value: string, inline: boolean }}
 */
function buildHardestQuestionField(hardest) {
  if (!hardest) {
    return {
      name:   '😤 أصعب سؤال',
      value:  'لا يوجد بيانات كافية (يحتاج 5 ظهورات على الأقل)',
      inline: false,
    };
  }

  const rate       = (hardest.rate * 100).toFixed(1);
  const appearances = hardest.times_appeared;
  const correct    = hardest.correct_count;

  return {
    name:  '😤 أصعب سؤال',
    value:
      `**السؤال:** \`${hardest.question_id}\`\n` +
      `**نسبة الإجابة الصحيحة:** ${rate}% (${correct} من ${appearances} مرة)\n` +
      `*${getRateBadge(hardest.rate)} ${getRateDescription(hardest.rate)}*`,
    inline: false,
  };
}

/**
 * Build the "most missed question" embed field.
 * Shows the question ID and how many times nobody voted on it.
 *
 * @param {object|null} mostMissed - from queries.getGuildStats()
 * @returns {{ name: string, value: string, inline: boolean }}
 */
function buildMostMissedField(mostMissed) {
  if (!mostMissed || mostMissed.zero_vote_count === 0) {
    return {
      name:   '🫥 أكثر سؤال تجاهلاً',
      value:  'لا يوجد أسئلة تجاهلها اللاعبون حتى الآن!',
      inline: false,
    };
  }

  return {
    name:  '🫥 أكثر سؤال تجاهلاً',
    value:
      `**السؤال:** \`${mostMissed.question_id}\`\n` +
      `لم يصوّت عليه أحد **${mostMissed.zero_vote_count}** ${mostMissed.zero_vote_count === 1 ? 'مرة' : 'مرات'}`,
    inline: false,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// FORMATTING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format a number with Arabic locale thousands separator.
 *
 * @param {number} n
 * @returns {string}
 */
function formatNumber(n) {
  if (!n && n !== 0) return '—';
  return Number(n).toLocaleString('ar-SA');
}

/**
 * Format a points value — integer or 1 decimal.
 *
 * @param {number} pts
 * @returns {string}
 */
function formatPoints(pts) {
  if (!pts) return '0';
  return Number.isInteger(pts) ? formatNumber(pts) : pts.toFixed(1);
}

/**
 * Get a difficulty badge emoji based on correct answer rate.
 *
 * @param {number} rate - 0.0 to 1.0
 * @returns {string}
 */
function getRateBadge(rate) {
  if (rate < 0.20) return '🔴';
  if (rate < 0.40) return '🟠';
  if (rate < 0.60) return '🟡';
  return '🟢';
}

/**
 * Get a human-readable difficulty description based on rate.
 *
 * @param {number} rate - 0.0 to 1.0
 * @returns {string}
 */
function getRateDescription(rate) {
  if (rate < 0.20) return 'صعب جداً — أقل من 20% يجيبون صح';
  if (rate < 0.40) return 'صعب — أقل من 40% يجيبون صح';
  if (rate < 0.60) return 'متوسط — أقل من 60% يجيبون صح';
  return 'سهل — أكثر من 60% يجيبون صح';
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports.sendStats = sendStats;
