'use strict';
/**
 * commands/slash/trivia-leaderboard.js
 *
 * Premium, human-like interactive leaderboard.
 * Style inspired by top Discord bots (MEE6, Dank Memer, ProBot).
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
} = require('discord.js');

const config  = require('../../config.json');
const queries = require('../../database/queries');
const { isRebuilding } = require('../../database/cache');
const { getTitle }     = require('../../utils/scoring');

// ─── Constants ────────────────────────────────────────────────────────────────
const LEADERBOARD_LIMIT = 10;
const NAV_TIMEOUT = 3 * 60 * 1000; // 3 minutes

// ─── Time Range Definitions (Fun & Engaging) ──────────────────────────────────
const RANGES = {
  all: {
    label: 'أساطير السيرفر',
    emoji: '🌟',
    color: 0xFFD700, // Gold
    desc: 'قاعة المشاهير.. الأذكى على مر التاريخ! 🏆',
    getStart: () => 0,
  },
  month: {
    label: 'أبطال الشهر',
    emoji: '🗓️',
    color: 0x9B59B6, // Purple
    desc: 'المنافسة محتدمة هذا الشهر.. مين بياخذ المركز الأول؟ 🔥',
    getStart: () => {
      const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.getTime();
    },
  },
  week: {
    label: 'نجوم الأسبوع',
    emoji: '📆',
    color: 0x3498DB, // Blue
    desc: 'ترتيب الأسبوع.. لحق على الصدارة قبل الأحد! 🏃‍♂️💨',
    getStart: () => {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); d.setUTCHours(0, 0, 0, 0); return d.getTime();
    },
  },
  day: {
    label: 'أبطال اليوم',
    emoji: '⚡',
    color: 0xE91E63, // Pink
    desc: 'مين أكثر واحد نشط اليوم؟ 🌅',
    getStart: () => {
      const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime();
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trivia-leaderboard')
    .setDescription('🏆 شوف ترتيبك وترتيب أصدقائك في المسابقة!')
    .addStringOption(opt =>
      opt.setName('range')
        .setDescription('الفترة الزمنية للترتيب')
        .setRequired(false)
        .addChoices(
          { name: '🌟 كل الأوقات (أساطير)', value: 'all' },
          { name: '🗓️ هذا الشهر', value: 'month' },
          { name: '📆 هذا الأسبوع', value: 'week' },
          { name: '⚡ اليوم', value: 'day' }
        )
    )
    .setDMPermission(false),

  async execute(interaction) {
    await interaction.deferReply();
    const range = interaction.options.getString('range') ?? 'month';
    await handleLeaderboard(interaction, interaction.guildId, range);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CORE LEADERBOARD HANDLER (Interactive)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleLeaderboard(interaction, guildId, initialRange) {
  let currentRange = RANGES[initialRange] ? initialRange : 'month';
  const callerId = interaction.user?.id;

  const { embed, components } = await buildLeaderboardUI(guildId, currentRange, callerId);
  const msg = await interaction.editReply({ embeds: [embed], components, fetchReply: true });

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: NAV_TIMEOUT,
  });

  collector.on('collect', async i => {
    if (i.user.id !== callerId) {
      return i.reply({ 
        content: '🛑 هذي القائمة خاصة بصاحبها! اكتب `/trivia-leaderboard` عشان تشوف ترتيبك أنت.', 
        ephemeral: true 
      }).catch(() => {});
    }

    currentRange = i.values[0];
    const { embed: newEmbed, components: newComponents } = await buildLeaderboardUI(guildId, currentRange, callerId);
    await i.update({ embeds: [newEmbed], components: newComponents }).catch(() => {});
  });

  collector.on('end', async () => {
    try {
      const { embed: timeoutEmbed, components: disabledComponents } = await buildLeaderboardUI(guildId, currentRange, callerId, true);
      await interaction.editReply({ embeds: [timeoutEmbed], components: disabledComponents });
    } catch (err) {
      if (err.code !== 10008) console.error('[Leaderboard Timeout]', err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI BUILDER (Modern Discord Style)
// ═══════════════════════════════════════════════════════════════════════════════

async function buildLeaderboardUI(guildId, rangeKey, callerId, disabled = false) {
  const rangeData = RANGES[rangeKey];
  const rebuilding = isRebuilding(guildId);
  const now = Date.now();

  // 1. Fetch Data
  let rows;
  if (rangeKey === 'all') {
    rows = rebuilding ? queries.getTimeRangeLeaderboard(guildId, 0, now, LEADERBOARD_LIMIT) : queries.getAllTimeLeaderboard(guildId, LEADERBOARD_LIMIT);
  } else {
    rows = queries.getTimeRangeLeaderboard(guildId, rangeData.getStart(), now, LEADERBOARD_LIMIT);
  }

  // 2. Build Embed
  const embed = new EmbedBuilder()
    .setTitle(`${rangeData.emoji} ${rangeData.label}`)
    .setColor(rangeData.color)
    .setTimestamp();

  let description = `> ${rangeData.desc}\n\n`;
  
  if (rebuilding) {
    description += '🛠️ *نرتب قاعدة البيانات الحين.. الأرقام بتتحدث تلقائياً!*\n\n';
  }

  if (!rows || rows.length === 0) {
    description += 
      '😴 **الصدرة فاضية وتنتظرك!**\n' +
      'ما في أحد كسب نقاط في هالفترة.\n' +
      'وش تنتظر؟ اكتب `/trivia-start` واثبت إنك الأذكى! 🧠✨';
  } else {
    description += buildRankingLines(rows, rangeKey === 'all', callerId).join('\n');
  }

  embed.setDescription(description);

  // 3. Caller's Rank (Footer - RPG Style)
  if (callerId && rows.length > 0) {
    const userInList = rows.some(r => r.user_id === callerId);
    if (!userInList) {
      const callerStats = queries.getPlayerStats(guildId, callerId);
      const callerPts = callerStats?.total_points ?? 0;
      
      if (rangeKey === 'all' && callerPts > 0) {
        const callerRank = queries.getPlayerRank(guildId, callerId);
        const totalPlayers = queries.getTotalPlayers(guildId);
        if (callerRank && totalPlayers) {
          embed.setFooter({ text: `📊 ترتيبك: #${callerRank} من ${totalPlayers} | 💎 رصيدك: ${formatPoints(callerPts)} نقطة` });
        }
      } else if (rangeKey !== 'all') {
        embed.setFooter({ text: '🏃‍♂️ ما لك مكان في هالترتيب.. لحق على جولة الحين!' });
      }
    }
  }

  // 4. Build Components
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('lb_range_select')
    .setPlaceholder('🔄 غيّر الفترة الزمنية...')
    .setDisabled(disabled)
    .addOptions(Object.entries(RANGES).map(([key, val]) => {
      const opt = new StringSelectMenuOptionBuilder()
        .setLabel(`${val.emoji} ${val.label}`)
        .setValue(key);
      if (key === rangeKey) opt.setDefault(true);
      return opt;
    }));

  const components = [new ActionRowBuilder().addComponents(selectMenu)];

  // If disabled (timeout), add a small note to the embed
  if (disabled) {
    embed.setDescription(description + '\n\n`⏳ انتهت الجلسة، اكتب /trivia-leaderboard لعرض قائمة جديدة.`');
    embed.setColor(0x747F8D); // Grey out
  }

  return { embed, components };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RANKING LOGIC (Clean & Punchy)
// ═══════════════════════════════════════════════════════════════════════════════

function buildRankingLines(rows, showTitle = false, callerId = null) {
  const lines = [];
  let lastScore = null;
  let lastRank = 0;
  let position = 0;

  for (const row of rows) {
    position++;
    if (lastScore === null || row.total_points !== lastScore) lastRank = position;

    const pts = formatPoints(row.total_points);
    const mention = `<@${row.user_id}>`;
    const isCaller = row.user_id === callerId;
    
    // Title (if all-time)
    const titleStr = showTitle ? ` *(${getTitle(row.total_points)})*` : '';
    
    // Caller Highlight
    const callerStr = isCaller ? ' 👀 **(أنت!)**' : '';

    let line = '';

    // Special formatting for Top 3
    if (lastRank === 1) {
      line = `👑 **${mention}** — \`${pts}\` نقطة${titleStr}${callerStr}`;
    } else if (lastRank === 2) {
      line = `🥈 **${mention}** — \`${pts}\` نقطة${titleStr}${callerStr}`;
    } else if (lastRank === 3) {
      line = `🥉 **${mention}** — \`${pts}\` نقطة${titleStr}${callerStr}`;
    } else {
      // Ranks 4-10
      const medal = lastRank <= 10 ? ['4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][lastRank - 4] : `**${lastRank}.**`;
      line = `${medal} ${mention} — **${pts}** نقطة${titleStr}${callerStr}`;
    }

    lines.push(line);
    lastScore = row.total_points;
  }

  return lines;
}

// Format numbers with commas (e.g., 1,250,000)
function formatPoints(pts) {
  if (!pts) return '0';
  const num = Number.isInteger(pts) ? pts : parseFloat(pts.toFixed(1));
  return num.toLocaleString('en-US');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS (For Prefix Router)
// ═══════════════════════════════════════════════════════════════════════════════

async function sendLeaderboard(interaction, guildId, range) {
  await handleLeaderboard(interaction, guildId, range);
}

async function sendAllTimeLeaderboard(interaction, guildId) {
  await handleLeaderboard(interaction, guildId, 'all');
}

module.exports.sendLeaderboard = sendLeaderboard;
module.exports.sendAllTimeLeaderboard = sendAllTimeLeaderboard;
