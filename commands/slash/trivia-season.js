'use strict';
/**
 * commands/slash/trivia-season.js
 * Slash command: /trivia-season
 * View Season Battle Pass progress and tier rewards.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const queries = require('../../database/queries');
const config  = require('../../config.json');

const data = new SlashCommandBuilder()
  .setName('trivia-season')
  .setDescription('🌟 اعرض تصريح الموسم (Battle Pass) ومستواك في المسار الموسمي!');

async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const season = queries.getActiveSeason();
  const pass = queries.getSeasonPass(guildId, userId, season.season_number);

  const daysLeft = Math.max(0, Math.ceil((season.ends_at - Date.now()) / (1000 * 60 * 60 * 24)));

  // Progress Bar for current tier
  const xpInTier = pass.xp % 150;
  const percent = Math.min(100, Math.round((xpInTier / 150) * 100));
  const fullBlocks = Math.round(percent / 10);
  const emptyBlocks = 10 - fullBlocks;
  const progressBar = '🟩'.repeat(fullBlocks) + '⬛'.repeat(emptyBlocks);

  const embed = new EmbedBuilder()
    .setTitle(`🌟 ${season.title}`)
    .setDescription(
      `الموضوع: **${season.theme}**\n` +
      `الأيام المتبقية على نهاية الموسم: **${daysLeft}** يوم\n\n` +
      `🎖️ **المستوى الموسمي (Tier):** **${pass.tier}** / 20\n` +
      `⭐ **الخبرة الموسمية:** ${xpInTier}/150 XP\n` +
      `${progressBar} **${percent}%**\n\n` +
      `👑 **حالة التصريح:** ${pass.is_vip ? '⭐ تصريح VIP الذهبي مفعّل!' : '🆓 المسار المجاني (يمكنك ترقيته من المتجر /trivia-shop)'}`
    )
    .setColor(pass.is_vip ? config.colors.gold : config.colors.purple)
    .addFields(
      { name: '🎁 مكافأة المستوى 5', value: '💰 300 دينار ذهبي', inline: true },
      { name: '🎁 مكافأة المستوى 10', value: '🛡️ 2x درع السلسلة + 500 دينار', inline: true },
      { name: '🎁 مكافأة المستوى 20 (القمة)', value: '👑 لقب "فارس المعرفة" + 2000 دينار', inline: true }
    )
    .setFooter({ text: 'اكسب Season XP من خلال الإجابة على الأسئلة والمشاركة في المسابقات' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
