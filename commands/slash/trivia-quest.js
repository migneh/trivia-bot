'use strict';
/**
 * commands/slash/trivia-quest.js
 * Slash command: /trivia-quest
 * View daily and weekly quests and claim rewards.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const queries = require('../../database/queries');
const config  = require('../../config.json');

const data = new SlashCommandBuilder()
  .setName('trivia-quest')
  .setDescription('📜 اعرض مهامك اليومية والأسبوعية واستلم مكافآت الدنانير والـ XP!');

async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const quests = queries.getUserQuests(guildId, userId);

  const questFields = quests.map(q => {
    const statusIcon = q.is_completed ? '✅ مُستلمة' : q.current_progress >= q.target ? '🎁 جاهزة للاستلام!' : `⏳ ${q.current_progress}/${q.target}`;
    return {
      name: `${q.title_ar}`,
      value: `التقدم: **${statusIcon}**\nالمكافأة: 💰 **${q.reward_coins}** دينار | ⭐ **${q.reward_xp}** XP`,
      inline: false,
    };
  });

  const claimable = quests.filter(q => !q.is_completed && q.current_progress >= q.target);

  const embed = new EmbedBuilder()
    .setTitle('📜 قائمة المهام والتحديات اليومية')
    .setDescription(
      `أكمل المهام خلال جلسات المسابقات والمبارزات لكسب مكافآت مجزية!\n` +
      `تنتهي صلاحية المهام وتتجدد يومياً عند منتصف الليل (UTC).`
    )
    .addFields(questFields)
    .setColor(claimable.length > 0 ? config.colors.success : config.colors.info)
    .setTimestamp();

  const components = [];
  if (claimable.length > 0) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('quest_claim_all')
        .setLabel(`🎁 استلام جميع المكافآت (${claimable.length})`)
        .setStyle(ButtonStyle.Success)
    );
    components.push(row);
  }

  const msg = await interaction.reply({
    embeds: [embed],
    components,
    fetchReply: true,
  });

  if (claimable.length === 0) return;

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 45000,
  });

  collector.on('collect', async (btnInt) => {
    if (btnInt.user.id !== userId) {
      await btnInt.reply({ content: '⚠️ هذه المهام تخص لاعباً آخر.', ephemeral: true });
      return;
    }

    let totalCoins = 0;
    let totalXp = 0;

    for (const q of claimable) {
      const res = queries.claimQuestReward(guildId, userId, q.quest_id);
      if (res.success) {
        totalCoins += res.rewardCoins;
        totalXp += res.rewardXp;
      }
    }

    await btnInt.update({
      content: `🎉 **مبروك! تم استلام جميع المكافآت بنجاح!**\n💰 حصلت على: **${totalCoins}** دينار\n⭐ حصلت على: **${totalXp}** XP`,
      components: [],
    });
  });
}

module.exports = { data, execute };
