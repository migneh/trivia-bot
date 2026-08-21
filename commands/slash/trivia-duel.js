'use strict';
/**
 * commands/slash/trivia-duel.js
 * Slash command: /trivia-duel
 * Challenge another user to a 1v1 trivia face-off.
 */

const { SlashCommandBuilder } = require('discord.js');
const { launchDuel } = require('../../utils/duelEngine');
const config = require('../../config.json');

const data = new SlashCommandBuilder()
  .setName('trivia-duel')
  .setDescription('⚔️ تحدَّ لاعباً آخر في مبارزة 1 ضد 1 على رهان نقود وأسئلة سريعة!')
  .addUserOption(opt =>
    opt.setName('opponent')
      .setDescription('اللاعب المراد تحديه')
      .setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName('stake')
      .setDescription('قيمة رهان الدنانير (اختياري، الافتراضي: 0)')
      .setMinValue(0)
      .setMaxValue(5000)
      .setRequired(false)
  )
  .addStringOption(opt => {
    opt.setName('category')
      .setDescription('تصنيف الأسئلة في المبارزة')
      .setRequired(false);
    opt.addChoices({ name: '🌍 جميع التصنيفات', value: 'all' });
    for (const c of config.categories) {
      opt.addChoices({ name: c.nameAr, value: c.id });
    }
    return opt;
  });

async function execute(interaction) {
  const opponent = interaction.options.getUser('opponent');
  const stake = interaction.options.getInteger('stake') ?? 0;
  const category = interaction.options.getString('category') ?? 'all';

  await launchDuel(interaction, opponent, stake, category);
}

module.exports = { data, execute };
