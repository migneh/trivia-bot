'use strict';
/**
 * commands/slash/trivia-survival.js
 * Slash command: /trivia-survival
 * Launch a 3-lives Battle Royale survival game mode.
 */

const { SlashCommandBuilder } = require('discord.js');
const { startSurvivalSession } = require('../../utils/survivalEngine');
const sm = require('../../utils/sessionManager');
const config = require('../../config.json');

const data = new SlashCommandBuilder()
  .setName('trivia-survival')
  .setDescription('❤️ أطلق طور البقاء (Survival) — 3 قلوب وآخر لاعب صامد يفوز!')
  .addIntegerOption(opt =>
    opt.setName('questions')
      .setDescription('عدد أسئلة المواجهة (الافتراضي: 15)')
      .setMinValue(5)
      .setMaxValue(30)
      .setRequired(false)
  );

async function execute(interaction) {
  const guildId = interaction.guildId;

  // Check if standard session is active
  if (sm.getSession(guildId)) {
    await interaction.reply({
      content: '⚠️ توجد جلسة مسابقة نشطة بالفعل في هذا السيرفر! انتظر حتى تنتهي.',
      ephemeral: true,
    });
    return;
  }

  const questionCount = interaction.options.getInteger('questions') ?? 15;
  await startSurvivalSession(interaction, questionCount, []);
}

module.exports = { data, execute };
