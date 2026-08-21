'use strict';
/**
 * commands/slash/trivia-economy.js
 * Slash command: /trivia-economy
 * View balance, transfer coins, or view the wealth leaderboard.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const queries = require('../../database/queries');
const config = require('../../config.json');

const data = new SlashCommandBuilder()
  .setName('trivia-economy')
  .setDescription('💰 نظام الاقتصاد والدنانير الذهبية')
  .addSubcommand(sub =>
    sub.setName('balance')
      .setDescription('💳 عرض رصيدك من الدنانير ومستواك الحالي')
      .addUserOption(opt => opt.setName('user').setDescription('المستخدم المراد الاستعلام عنه (اختياري)'))
  )
  .addSubcommand(sub =>
    sub.setName('transfer')
      .setDescription('💸 تحويل دنانير ذهبية إلى لاعب آخر')
      .addUserOption(opt => opt.setName('recipient').setDescription('اللاعب المستلم').setRequired(true))
      .addIntegerOption(opt => opt.setName('amount').setDescription('المبلغ المراد تحويله').setMinValue(1).setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('top')
      .setDescription('🏆 قائمة أثرياء السيرفر (أكثر اللاعبين امتلاكاً للدنانير)')
  );

async function execute(interaction) {
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === 'balance') {
    const target = interaction.options.getUser('user') || interaction.user;
    const econ = queries.getUserEconomy(guildId, target.id);

    const embed = new EmbedBuilder()
      .setTitle(`💳 المحفظة المالية — ${target.username}`)
      .setThumbnail(target.displayAvatarURL())
      .setColor(config.colors.gold)
      .addFields(
        { name: '💰 الدنانير الذهبية', value: `**${econ.coins.toLocaleString('ar-EG')}** دينار`, inline: true },
        { name: '⭐ المستوى والخبرة', value: `المستوى **${econ.level}** (${econ.xp} XP)`, inline: true },
        { name: '🔥 السلسلة اليومية', value: `**${econ.daily_streak}** أيام`, inline: true },
        { name: '📈 إجمالي ما كسبه', value: `**${econ.total_earned.toLocaleString('ar-EG')}** دينار`, inline: true }
      )
      .setFooter({ text: 'استخدم /trivia-daily للحصول على مكافأتك اليومية!' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'transfer') {
    const recipient = interaction.options.getUser('recipient');
    const amount = interaction.options.getInteger('amount');
    const senderId = interaction.user.id;

    if (recipient.id === senderId || recipient.bot) {
      await interaction.reply({ content: '❌ لا يمكنك تحويل الدنانير لنفسك أو للبوتات!', ephemeral: true });
      return;
    }

    const res = queries.transferCoins(guildId, senderId, recipient.id, amount);
    if (!res.success) {
      if (res.reason === 'insufficient_coins') {
        await interaction.reply({
          content: `❌ ليس لديك رصيد كافٍ! رصيدك: **${res.currentCoins}** دينار.`,
          ephemeral: true,
        });
      } else {
        await interaction.reply({ content: '❌ فشلت عملية التحويل.', ephemeral: true });
      }
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('💸 تم التحويل بنجاح!')
      .setDescription(
        `قام <@${senderId}> بتحويل 💰 **${amount.toLocaleString('ar-EG')}** دينار إلى <@${recipient.id}> بنجاح!`
      )
      .setColor(config.colors.success)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (sub === 'top') {
    const top = queries.getTopEconomyPlayers(guildId, 10);

    if (!top || top.length === 0) {
      await interaction.reply('لا توجد بيانات اقتصادية بعد في هذا السيرفر.');
      return;
    }

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const lines = top.map((p, idx) => {
      const medal = medals[idx] || `**${idx + 1}.**`;
      return `${medal} <@${p.user_id}> — 💰 **${p.coins.toLocaleString('ar-EG')}** دينار (المستوى ${p.level})`;
    });

    const embed = new EmbedBuilder()
      .setTitle('👑 قائمة أثرياء السيرفر (Top Wealth)')
      .setDescription(lines.join('\n'))
      .setColor(config.colors.gold)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
}

module.exports = { data, execute };
