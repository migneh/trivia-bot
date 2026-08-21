'use strict';
/**
 * commands/slash/trivia-dashboard.js
 * Slash command: /trivia-dashboard
 * Get direct link to the web control panel and real-time dashboard.
 */

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../../config.json');
const queries = require('../../database/queries');
const { getBankStats } = require('../../utils/questionBank');

const data = new SlashCommandBuilder()
  .setName('trivia-dashboard')
  .setDescription('🌐 احصل على رابط لوحة التحكم المباشرة وإحصائيات المنصة الشاملة');

async function execute(interaction) {
  const bankStats = getBankStats();
  const totalSessions = queries.getTotalSessionsCount();
  const totalPlayers = queries.getTotalGlobalPlayers();

  const embed = new EmbedBuilder()
    .setTitle('🌐 لوحة التحكم التفاعلية والمستكشف المباشر')
    .setDescription(
      'يمكنك استعراض بنك الأسئلة بالكامل (أكثر من 5,000 سؤال)، متابعة الجلسات الحية، والاطلاع على صدارة السيرفرات عبر لوحة الويب الحديثة!\n\n' +
      `📊 **إحصائيات المنصة السريعة:**\n` +
      `• 📚 إجمالي الأسئلة المعتمدة: **${bankStats.totalQuestions.toLocaleString('ar-EG')}** سؤال\n` +
      `• 🕹️ إجمالي الجلسات الملعوبة: **${totalSessions.toLocaleString('ar-EG')}** جلسة\n` +
      `• 👥 إجمالي اللاعبين الفريدين: **${totalPlayers.toLocaleString('ar-EG')}** لاعب\n` +
      `• 🚀 المنفذ المحلي: \`http://localhost:${config.webPort || 3000}\``
    )
    .setColor(config.colors.info)
    .setFooter({ text: 'لوحة التحكم متوافقة مع جميع الأجهزة' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
