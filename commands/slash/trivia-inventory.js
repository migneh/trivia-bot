'use strict';
/**
 * commands/slash/trivia-inventory.js
 * Slash command: /trivia-inventory
 * View purchased items and bag contents.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const queries = require('../../database/queries');
const economyManager = require('../../utils/economyManager');
const config = require('../../config.json');

const data = new SlashCommandBuilder()
  .setName('trivia-inventory')
  .setDescription('🎒 اعرض حقيبة أدواتك وقدراتك المشتراة من المتجر!');

async function execute(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const inv = queries.getUserInventory(guildId, userId);
  const userEcon = queries.getUserEconomy(guildId, userId);

  if (!inv || inv.length === 0) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🎒 حقيبة الأدوات فارغة')
          .setDescription(
            `ليس لديك أي أدوات أو قدرات حالياً.\n` +
            `رصيدك: 💰 **${userEcon.coins}** دينار\n\n` +
            `استخدم </trivia-shop:0> لشراء وسائل مساعدة وقدرات خاصة!`
          )
          .setColor(config.colors.info),
      ],
      ephemeral: true,
    });
    return;
  }

  const lines = inv.map(row => {
    const item = economyManager.getShopItem(row.item_id);
    const name = item ? `${item.emoji} ${item.nameAr}` : row.item_id;
    return `• **${name}** — العدد: **x${row.count}**`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🎒 حقيبة <@${userId}> الخاصة`)
    .setDescription(
      `💳 الرصيد: 💰 **${userEcon.coins}** دينار | 💎 **${userEcon.gems}** جوهرة\n\n` +
      `📦 **العناصر المتوفرة:**\n` +
      lines.join('\n')
    )
    .setColor(config.colors.gold)
    .setFooter({ text: 'تُفعّل القدرات تلقائياً أو عند بدء الجلسة القادمة' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
