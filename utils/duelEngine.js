'use strict';
/**
 * utils/duelEngine.js
 * 1v1 Interactive Live Duel Engine
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const config     = require('../config.json');
const queries    = require('../database/queries');
const { selectQuestions } = require('./questionBank');

// Active duels in memory: duelId -> DuelState
const activeDuels = new Map();

/**
 * Handle a 1v1 Duel challenge flow
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').User} opponent
 * @param {number} stake
 * @param {string} category
 */
async function launchDuel(interaction, opponent, stake = 0, category = 'all') {
  const guildId = interaction.guildId;
  const challenger = interaction.user;

  if (opponent.id === challenger.id || opponent.bot) {
    await interaction.reply({
      content: '❌ لا يمكنك مبارزة نفسك أو البوتات!',
      ephemeral: true,
    });
    return;
  }

  // Check funds
  const challengerEcon = queries.getUserEconomy(guildId, challenger.id);
  if (stake > 0 && challengerEcon.coins < stake) {
    await interaction.reply({
      content: `❌ ليس لديك رصيد كافٍ من الدنانير للمبارزة! رصيدك: **${challengerEcon.coins}** دينار.`,
      ephemeral: true,
    });
    return;
  }

  const opponentEcon = queries.getUserEconomy(guildId, opponent.id);
  if (stake > 0 && opponentEcon.coins < stake) {
    await interaction.reply({
      content: `❌ الخصم <@${opponent.id}> لا يملك رصيداً كافياً (${opponentEcon.coins} دينار)!`,
      ephemeral: true,
    });
    return;
  }

  // Select 5 questions
  const selected = selectQuestions({
    count: 5,
    categories: category === 'all' ? config.categories.map(c => c.id) : [category],
    usedIds: new Set(),
  });

  if (selected.length < 5) {
    await interaction.reply({
      content: '❌ لا توجد أسئلة كافية لبدء المبارزة في هذا التصنيف.',
      ephemeral: true,
    });
    return;
  }

  const duelId = queries.createDuel(guildId, challenger.id, opponent.id, stake, category, selected);

  const inviteEmbed = new EmbedBuilder()
    .setTitle('🥊 تحدي مبارزة 1 ضد 1!')
    .setDescription(
      `قام <@${challenger.id}> بتحدي <@${opponent.id}> في مبارزة معلومات!\n\n` +
      `📌 **التصنيف:** ${category === 'all' ? 'جميع التصنيفات 🌍' : category}\n` +
      `💰 **الرهان:** **${stake}** دينار\n` +
      `❓ **عدد الأسئلة:** 5 أسئلة سريعة\n\n` +
      `هل تقبل التحدي يا <@${opponent.id}>؟ لديك 45 ثانية للرد.`
    )
    .setColor(config.colors.gold)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`duel_accept:${duelId}`)
      .setLabel('⚔️ قبول المبارزة')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`duel_decline:${duelId}`)
      .setLabel('❌ رفض')
      .setStyle(ButtonStyle.Danger)
  );

  const message = await interaction.reply({
    content: `<@${opponent.id}>`,
    embeds: [inviteEmbed],
    components: [row],
    fetchReply: true,
  });

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 45000,
  });

  collector.on('collect', async (btnInt) => {
    if (btnInt.user.id !== opponent.id && btnInt.user.id !== challenger.id) {
      await btnInt.reply({ content: '⚠️ هذا التحدي ليس موجهاً إليك!', ephemeral: true });
      return;
    }

    if (btnInt.customId.startsWith('duel_decline')) {
      if (btnInt.user.id !== opponent.id && btnInt.user.id !== challenger.id) return;
      collector.stop('declined');
      queries.updateDuel(duelId, { status: 'declined' });
      await btnInt.update({
        content: `❌ تم رفض/إلغاء التحدي بواسطة <@${btnInt.user.id}>.`,
        embeds: [],
        components: [],
      });
      return;
    }

    if (btnInt.customId.startsWith('duel_accept')) {
      if (btnInt.user.id !== opponent.id) {
        await btnInt.reply({ content: '⚠️ يجب أن يقبل الخصم التحدي.', ephemeral: true });
        return;
      }

      collector.stop('accepted');
      await btnInt.update({
        content: '🔥 **تم قبول التحدي! تبدأ المبارزة خلال 3 ثوانٍ...**',
        embeds: [],
        components: [],
      });

      // Deduct stakes if any
      if (stake > 0) {
        queries.addCoinsAndXp(guildId, challenger.id, -stake, 0, `رهان مبارزة #${duelId}`);
        queries.addCoinsAndXp(guildId, opponent.id, -stake, 0, `رهان مبارزة #${duelId}`);
      }

      setTimeout(() => {
        runDuelMatch(interaction.channel, duelId, guildId, challenger, opponent, selected, stake);
      }, 3000);
    }
  });

  collector.on('end', async (_, reason) => {
    if (reason === 'time') {
      queries.updateDuel(duelId, { status: 'expired' });
      try {
        await message.edit({
          content: '⏳ انتهت مهلة قبول المبارزة ولم يستجب الخصم.',
          embeds: [],
          components: [],
        });
      } catch {}
    }
  });
}

/**
 * Execute the 5-question match loop
 */
async function runDuelMatch(channel, duelId, guildId, challenger, opponent, questions, stake) {
  let challengerScore = 0;
  let opponentScore = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const votes = {}; // userId -> { index, timeMs }

    const embed = new EmbedBuilder()
      .setTitle(`🥊 المبارزة [${i + 1}/5] — ${challenger.username} 🆚 ${opponent.username}`)
      .setDescription(`**${q.text}**`)
      .setColor(config.colors.info)
      .setFooter({ text: `النتيجة الحالية: ${challenger.username} (${challengerScore}) - ${opponent.username} (${opponentScore})` });

    const row = new ActionRowBuilder().addComponents(
      q.options.map((opt, idx) =>
        new ButtonBuilder()
          .setCustomId(`duel_ans:${idx}`)
          .setLabel(opt.substring(0, 80))
          .setStyle(ButtonStyle.Primary)
      )
    );

    let msg;
    try {
      msg = await channel.send({ embeds: [embed], components: [row] });
    } catch {
      break;
    }

    const qCollector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 15000,
    });

    await new Promise((resolve) => {
      qCollector.on('collect', async (btn) => {
        if (btn.user.id !== challenger.id && btn.user.id !== opponent.id) {
          await btn.reply({ content: '⚠️ أنت لست طرفاً في هذه المبارزة!', ephemeral: true });
          return;
        }

        if (votes[btn.user.id]) {
          await btn.reply({ content: '⚠️ لقد أجبت بالفعل!', ephemeral: true });
          return;
        }

        const chosen = parseInt(btn.customId.split(':')[1], 10);
        votes[btn.user.id] = { index: chosen, timeMs: Date.now() };

        await btn.reply({ content: '✅ تم تسجيل إجابتك!', ephemeral: true });

        // If both answered, advance immediately
        if (votes[challenger.id] && votes[opponent.id]) {
          qCollector.stop('both_answered');
        }
      });

      qCollector.on('end', () => resolve());
    });

    // Score evaluation
    const cVote = votes[challenger.id];
    const oVote = votes[opponent.id];

    if (cVote && cVote.index === q.correctAnswer) challengerScore += 10;
    if (oVote && oVote.index === q.correctAnswer) opponentScore += 10;

    // Speed bonus if both correct
    if (cVote && oVote && cVote.index === q.correctAnswer && oVote.index === q.correctAnswer) {
      if (cVote.timeMs < oVote.timeMs) challengerScore += 2;
      else if (oVote.timeMs < cVote.timeMs) opponentScore += 2;
    }

    // Reveal buttons
    const revealRow = new ActionRowBuilder().addComponents(
      q.options.map((opt, idx) =>
        new ButtonBuilder()
          .setCustomId(`duel_done:${idx}`)
          .setLabel(opt.substring(0, 80))
          .setStyle(idx === q.correctAnswer ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(true)
      )
    );

    try {
      await msg.edit({ components: [revealRow] });
    } catch {}

    // Short pause between questions
    await new Promise(r => setTimeout(r, 2000));
  }

  // Match Conclusion
  let winnerId = null;
  let resultText = '';

  if (challengerScore > opponentScore) {
    winnerId = challenger.id;
    resultText = `🎉 **الفائز هو <@${challenger.id}> بنتيجة (${challengerScore} - ${opponentScore})!**`;
  } else if (opponentScore > challengerScore) {
    winnerId = opponent.id;
    resultText = `🎉 **الفائز هو <@${opponent.id}> بنتيجة (${opponentScore} - ${challengerScore})!**`;
  } else {
    resultText = `🤝 **تعادل بطولي بين <@${challenger.id}> و <@${opponent.id}> بنتيجة (${challengerScore} - ${opponentScore})!**`;
  }

  // Payout pot
  const pot = stake * 2;
  if (winnerId && pot > 0) {
    queries.addCoinsAndXp(guildId, winnerId, pot, 100, `جائزة الفوز بالمبارزة #${duelId}`);
  } else if (!winnerId && stake > 0) {
    // Refund on tie
    queries.addCoinsAndXp(guildId, challenger.id, stake, 20, 'استرداد رهان التعادل');
    queries.addCoinsAndXp(guildId, opponent.id, stake, 20, 'استرداد رهان التعادل');
  }

  queries.updateDuel(duelId, {
    challenger_score: challengerScore,
    opponent_score: opponentScore,
    winner_id: winnerId,
    status: 'completed',
  });

  const finalEmbed = new EmbedBuilder()
    .setTitle('🏆 نتيجة المبارزة النهائية')
    .setDescription(
      `${resultText}\n\n` +
      `👤 **<@${challenger.id}>:** ${challengerScore} نقطة\n` +
      `👤 **<@${opponent.id}>:** ${opponentScore} نقطة\n\n` +
      (pot > 0 ? `💰 **الجائزة الموزعة:** **${pot}** دينار ذهبي!` : '')
    )
    .setColor(config.colors.gold)
    .setTimestamp();

  await channel.send({ embeds: [finalEmbed] });
}

module.exports = {
  launchDuel,
};
