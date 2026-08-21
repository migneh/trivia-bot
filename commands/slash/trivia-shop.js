'use strict';
/**
 * commands/slash/trivia-shop.js
 * Slash command: /trivia-shop
 * Interactive Shop catalog to buy power-ups and cosmetics.
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
} = require('discord.js');

const config = require('../../config.json');
const queries = require('../../database/queries');
const economyManager = require('../../utils/economyManager');

const data = new SlashCommandBuilder()
  .setName('trivia-shop')
  .setDescription('🛍️ تصفح واشترِ القدرات الخاصة ووسائل المساعدة من متجر المسابقات!');

async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const userEcon = queries.getUserEconomy(guildId, userId);
  const items = economyManager.getAllShopItems();

  const embed = new EmbedBuilder()
    .setTitle('🛍️ متجر القدرات والعناصر الخاصة')
    .setDescription(
      `رصيدك الحالي: 💰 **${userEcon.coins}** دينار\n\n` +
      items.map(it => `**${it.emoji} ${it.nameAr}** — 💰 **${it.price}** دينار\n${it.descriptionAr}`).join('\n\n') +
      '\n\nاختر العنصر الذي تريد شراءه من القائمة أدناه:'
    )
    .setColor(config.colors.gold)
    .setFooter({ text: 'استخدم /trivia-inventory لعرض حقيبتك' })
    .setTimestamp();

  const select = new StringSelectMenuBuilder()
    .setCustomId('shop_buy_select')
    .setPlaceholder('اختر عنصراً لشرائه...')
    .addOptions(
      items.map(it =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${it.nameAr} (${it.price} دينار)`)
          .setDescription(it.descriptionAr.substring(0, 100))
          .setValue(it.id)
          .setEmoji(it.emoji)
      )
    );

  const row = new ActionRowBuilder().addComponents(select);

  const msg = await interaction.reply({
    embeds: [embed],
    components: [row],
    fetchReply: true,
  });

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 60000,
  });

  collector.on('collect', async (selInt) => {
    if (selInt.user.id !== userId) {
      await selInt.reply({ content: '⚠️ هذا المتجر مفتوح للاعب آخر.', ephemeral: true });
      return;
    }

    const selectedItemId = selInt.values[0];
    const buyResult = economyManager.buyItem(guildId, userId, selectedItemId, 1);

    if (!buyResult.success) {
      if (buyResult.reason === 'insufficient_coins') {
        await selInt.reply({
          content: `❌ ليس لديك رصيد كافٍ من الدنانير! رصيدك: **${buyResult.currentCoins}** دينار.`,
          ephemeral: true,
        });
      } else {
        await selInt.reply({ content: '❌ حدث خطأ أثناء إتمام الشراء.', ephemeral: true });
      }
      return;
    }

    const item = economyManager.getShopItem(selectedItemId);
    const updatedEcon = queries.getUserEconomy(guildId, userId);

    await selInt.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ تم الشراء بنجاح!')
          .setDescription(
            `لقد اشتريت **${item.emoji} ${item.nameAr}** بنجاح!\n\n` +
            `💰 تم خصم: **${item.price}** دينار\n` +
            `💳 رصيدك المتبقي: **${updatedEcon.coins}** دينار`
          )
          .setColor(config.colors.success),
      ],
      ephemeral: true,
    });
  });
}

module.exports = { data, execute };
