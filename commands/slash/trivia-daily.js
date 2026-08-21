'use strict';
/**
 * commands/slash/trivia-daily.js
 * Slash command: /trivia-daily
 * Claim daily rewards and maintain daily streak.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const queries = require('../../database/queries');
const config  = require('../../config.json');

const data = new SlashCommandBuilder()
  .setName('trivia-daily')
  .setDescription('🎁 استلم مكافأتك اليومية وحافظ على سلسلتك لكسب المزيد من الدنانير!');

async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const result = queries.processDailyClaim(guildId, userId);

  if (!result.success) {
    const hoursLeft = Math.ceil(result.waitMs / (1000 * 60 * 60));
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('⏳ المكافأة غير جاهزة بعد')
          .setDescription(`لقد استلمت مكافأتك اليومية بالفعل!\nيمكنك الاستلام مجدداً بعد حوالي **${hoursLeft}** ساعة.`)
          .setColor(config.colors.warning),
      ],
      ephemeral: true,
    });
    return;
  }

  const user = queries.getUserEconomy(guildId, userId);

  const embed = new EmbedBuilder()
    .setTitle('🎁 تم استلام المكافأة اليومية بنجاح!')
    .setDescription(
      `حصلت على **${result.reward}** دينار ذهبي! 💰\n\n` +
      `🔥 **سلسلتك اليومية:** **${result.streak}** أيام متتالية\n` +
      `💳 **رصيدك الإجمالي:** **${user.coins}** دينار`
    )
    .setColor(config.colors.success)
    .setFooter({ text: 'عُد غداً لزيادة سلسلتك ومضاعفة المكافأة!' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
