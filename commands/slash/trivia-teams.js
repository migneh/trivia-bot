'use strict';
/**
 * commands/slash/trivia-teams.js
 * Slash command: /trivia-teams
 * Launch a Team Battle (Red vs Blue vs Green).
 */

const { SlashCommandBuilder } = require('discord.js');
const { startTeamBattle } = require('../../utils/teamEngine');
const sm = require('../../utils/sessionManager');

const data = new SlashCommandBuilder()
  .setName('trivia-teams')
  .setDescription('⚔️ أطلق حرب الفرق (الصقور 🔴 ضد النمور 🔵 ضد الأبطال 🟢)!')
  .addIntegerOption(opt =>
    opt.setName('questions')
      .setDescription('عدد أسئلة الجلسة (الافتراضي: 10)')
      .setMinValue(5)
      .setMaxValue(25)
      .setRequired(false)
  );

async function execute(interaction) {
  const guildId = interaction.guildId;

  if (sm.getSession(guildId)) {
    await interaction.reply({
      content: '⚠️ توجد جلسة مسابقة نشطة بالفعل في هذا السيرفر!',
      ephemeral: true,
    });
    return;
  }

  const questionCount = interaction.options.getInteger('questions') ?? 10;
  await startTeamBattle(interaction, questionCount, []);
}

module.exports = { data, execute };
