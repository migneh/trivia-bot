'use strict';
/**
 * commands/slash/trivia-profile.js
 *
 * Displays a player's comprehensive RPG trivia profile:
 *  - Title, Rank, Level & XP
 *  - Coins & Clan
 *  - Win rate & Longest streak
 *  - Achievements & Badges
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');

const config  = require('../../config.json');
const queries = require('../../database/queries');
const { getTitle }     = require('../../utils/scoring');
const { isRebuilding } = require('../../database/cache');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-profile')
    .setDescription('عرض الملف الشخصي والإحصائيات ورتبة اللاعب في المسابقة')
    .addUserOption(opt =>
      opt
        .setName('user')
        .setDescription('اللاعب الذي تريد عرض ملفه (اتركه فارغاً لعرض ملفك)')
        .setRequired(false)
    )
    .setDMPermission(false),

  async execute(interaction) {
    await interaction.deferReply();

    const guildId   = interaction.guildId;
    const target    = interaction.options.getUser('user') ?? interaction.user;
    const isSelf    = target.id === interaction.user.id;
    const rebuilding = isRebuilding(guildId);

    // ── Fetch stats & economy ──────────────────────────────────────────────────
    let stats = queries.getPlayerStats(guildId, target.id);
    const econ = queries.getUserEconomy(guildId, target.id);
    const clan = queries.getUserClan(guildId, target.id);

    if (!stats && rebuilding) {
      stats = buildStatsFromHistory(guildId, target.id);
    }

    const totalPoints   = stats?.total_points   ?? 0;
    const sessionCount  = stats?.session_count  ?? 0;
    const winCount      = stats?.win_count       ?? 0;
    const totalAnswers  = stats?.total_answers  ?? 0;
    const longestStreak = stats?.longest_streak ?? 0;

    let achievements = {};
    try { achievements = JSON.parse(stats?.achievements ?? '{}'); } catch {}

    const title        = getTitle(totalPoints);
    const totalPlayers = queries.getTotalPlayers(guildId);
    const rank         = totalPoints > 0
      ? queries.getPlayerRank(guildId, target.id)
      : null;

    const unlockedAchs = config.achievements
      .filter(a => achievements[a.id] === true)
      .map(a => `🏅 **${a.nameAr}** — ${a.descriptionAr}`);

    const winRate = sessionCount > 0
      ? `${((winCount / sessionCount) * 100).toFixed(1)}%`
      : '—';

    const ptsDisplay = Number.isInteger(totalPoints)
      ? totalPoints.toLocaleString('ar-SA')
      : totalPoints.toFixed(1);

    const rankDisplay = rank
      ? `**#${rank}** من ${totalPlayers} لاعب`
      : totalPlayers > 0
        ? `خارج الترتيب (${totalPlayers} لاعب)`
        : 'أول لاعب في السيرفر!';

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
      econ,
      clan,
    });

    await interaction.editReply({ embeds: [embed] });
  },
};

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
    econ,
    clan,
  } = opts;

  const embedTitle = isSelf
    ? `👤 ملفك الشخصي`
    : `👤 ملف اللاعب — ${target.username}`;

  let description = '';
  if (neverPlayed) {
    description =
      isSelf
        ? '🌱 لم تشارك في أي مسابقة بعد.\nابدأ بالمشاركة لتصعد في لوحة الصدارة وتكسب الدنانير!'
        : `🌱 **${target.username}** لم يشارك في أي جلسة بعد.`;
  }
  if (rebuilding) {
    description = (description ? description + '\n\n' : '') +
      '⚙️ *جاري إعادة بناء الإحصائيات — البيانات المعروضة مؤقتة*';
  }

  const fields = [
    {
      name:   '🎖️ اللقب الحالي',
      value:  title,
      inline: true,
    },
    {
      name:   '⭐ المستوى والخبرة',
      value:  `المستوى **${econ?.level || 1}** (${econ?.xp || 0} XP)`,
      inline: true,
    },
    {
      name:   '💰 الرصيد المالي',
      value:  `**${(econ?.coins || 0).toLocaleString('ar-EG')}** دينار`,
      inline: true,
    },
    {
      name:   '🏆 المركز العام',
      value:  rank,
      inline: true,
    },
    {
      name:   '🛡️ الكلان',
      value:  clan ? `${clan.banner_emoji} **${clan.name}** [${clan.tag}]` : 'بدون كلان',
      inline: true,
    },
    {
      name:   '🔥 السلسلة اليومية',
      value:  `**${econ?.daily_streak || 0}** يوم متتالي`,
      inline: true,
    },
    {
      name:   '🎮 الجلسات والانتصارات',
      value:  sessionCount > 0 ? `${sessionCount} جلسة (${winCount} فوز — ${winRate})` : '—',
      inline: true,
    },
    {
      name:   '✅ إجابات صحيحة',
      value:  totalAnswers > 0 ? `${totalAnswers} إجابة` : '—',
      inline: true,
    },
    {
      name:   '⚡ أطول سلسلة بالمسابقات',
      value:  longestStreak > 0 ? `${longestStreak} إجابة متتالية` : '—',
      inline: true,
    },
  ];

  const achValue = unlockedAchs.length > 0
    ? unlockedAchs.slice(0, 8).join('\n') + (unlockedAchs.length > 8 ? `\n... و **${unlockedAchs.length - 8}** إنجاز إضافي` : '')
    : '🔒 لم يتم فتح أي إنجازات بعد.';

  fields.push({
    name:   `🏅 الإنجازات المفتوحة (${unlockedAchs.length} / ${config.achievements.length})`,
    value:  achValue,
    inline: false,
  });

  const embed = new EmbedBuilder()
    .setTitle(embedTitle)
    .setThumbnail(target.displayAvatarURL({ size: 128 }))
    .setColor(neverPlayed ? config.colors.info : config.colors.gold)
    .addFields(fields)
    .setTimestamp()
    .setFooter({
      text: `بيانات اللاعب • ${target.username}`,
      iconURL: target.displayAvatarURL({ size: 32 }),
    });

  if (description) {
    embed.setDescription(description);
  }

  return embed;
}

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

    const maxScore = Math.max(...Object.values(scores));
    if (pts === maxScore && pts > 0) winCount++;

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
    longest_streak: 0,
    achievements:   '{}',
  };
}
