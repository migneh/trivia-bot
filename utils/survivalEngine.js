'use strict';
/**
 * utils/survivalEngine.js
 * Survival / Battle Royale Game Engine (3 Lives Sudden Death)
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

/**
 * Start a Survival Battle Royale session
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {number} questionCount
 * @param {string[]} categories
 */
async function startSurvivalSession(interaction, questionCount = 15, categories = []) {
  const guildId = interaction.guildId;
  const channel = interaction.channel;

  const cats = categories.length > 0 ? categories : config.categories.map(c => c.id);
  const questions = selectQuestions({ count: questionCount, categories: cats, usedIds: new Set() });

  if (questions.length === 0) {
    await interaction.reply({ content: '❌ لا توجد أسئلة كافية لبدء طور البقاء.', ephemeral: true });
    return;
  }

  // Lobby: 30 seconds for players to join
  const lobbyEmbed = new EmbedBuilder()
    .setTitle('❤️ طور البقاء (Survival Battle Royale)')
    .setDescription(
      '🔥 **قواعد طور البقاء:**\n' +
      '• يبدأ كل لاعب بـ **3 قلوب (❤️❤️❤️)**.\n' +
      '• كل إجابة خاطئة أو تفويت للسؤال يفقدك قلباً واحداً.\n' +
      '• عند نفاد القلوب تخرج من المسابقة فوراً 💀.\n' +
      '• آخر صامد يفوز بلقب بطل البقاء والجائزة الكبرى!\n\n' +
      'اضغط على زر **انضمام** للمشاركة! تبدأ الجلسة بعد **30 ثانية**.'
    )
    .setColor(config.colors.error)
    .setFooter({ text: 'طور البقاء الحصري' });

  const joinBtn = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('survival_join')
      .setLabel('❤️ انضمام للمواجهة')
      .setStyle(ButtonStyle.Danger)
  );

  const lobbyMsg = await interaction.reply({
    embeds: [lobbyEmbed],
    components: [joinBtn],
    fetchReply: true,
  });

  const players = new Map(); // userId -> { lives: 3, username: string, correctCount: 0 }
  players.set(interaction.user.id, { lives: 3, username: interaction.user.username, correctCount: 0 });

  const lobbyCollector = lobbyMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30000,
  });

  lobbyCollector.on('collect', async (btn) => {
    if (players.has(btn.user.id)) {
      await btn.reply({ content: '✅ أنت منضم بالفعل لطور البقاء!', ephemeral: true });
      return;
    }

    players.set(btn.user.id, { lives: 3, username: btn.user.username, correctCount: 0 });
    await btn.reply({ content: '🔥 تم انضمامك لطور البقاء! لديك 3 قلوب ❤️❤️❤️.', ephemeral: true });
  });

  lobbyCollector.on('end', async () => {
    if (players.size < 2) {
      await channel.send('⛔ تم إلغاء طور البقاء لعدم وجود لاعبين كافيين (مطلوب لاعبان على الأقل).');
      return;
    }

    await channel.send(`⚔️ **بدأت معركة البقاء بمشاركة ${players.size} مقاتلاً!** حظاً موفقاً للجميع.`);
    runSurvivalGame(channel, guildId, players, questions);
  });
}

/**
 * Run the survival match loop
 */
async function runSurvivalGame(channel, guildId, players, questions) {
  for (let i = 0; i < questions.length; i++) {
    const alivePlayers = [...players.entries()].filter(([, p]) => p.lives > 0);

    if (alivePlayers.length <= 1) break;

    const q = questions[i];
    const votes = {}; // userId -> index

    // Format lives status
    const statusLines = alivePlayers.map(([id, p]) => {
      const hearts = '❤️'.repeat(p.lives);
      return `<@${id}>: ${hearts}`;
    }).join(' | ');

    const embed = new EmbedBuilder()
      .setTitle(`❤️ طور البقاء — السؤال ${i + 1}/${questions.length} (الصامدون: ${alivePlayers.length})`)
      .setDescription(`**${q.text}**\n\n📊 **القلوب المتبقية:**\n${statusLines}`)
      .setColor(config.colors.error)
      .setFooter({ text: 'لديك 15 ثانية للإجابة قبل خسارة قلب!' });

    const row = new ActionRowBuilder().addComponents(
      q.options.map((opt, idx) =>
        new ButtonBuilder()
          .setCustomId(`survival_ans:${idx}`)
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

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 15000,
    });

    await new Promise((resolve) => {
      collector.on('collect', async (btn) => {
        const p = players.get(btn.user.id);
        if (!p || p.lives <= 0) {
          await btn.reply({ content: '💀 أنت خارج المنافسة أو لست مسجلاً!', ephemeral: true });
          return;
        }

        if (votes[btn.user.id] !== undefined) {
          await btn.reply({ content: '⚠️ لقد أجبت بالفعل!', ephemeral: true });
          return;
        }

        const chosen = parseInt(btn.customId.split(':')[1], 10);
        votes[btn.user.id] = chosen;

        await btn.reply({ content: '✅ تم تسجيل إجابتك!', ephemeral: true });

        // Check if all alive answered
        const allAnswered = alivePlayers.every(([id]) => votes[id] !== undefined);
        if (allAnswered) collector.stop('all_answered');
      });

      collector.on('end', () => resolve());
    });

    // Deduct lives for wrong/missing answers
    const eliminatedThisRound = [];
    for (const [id, p] of alivePlayers) {
      const ans = votes[id];
      if (ans === q.correctAnswer) {
        p.correctCount++;
      } else {
        p.lives--;
        if (p.lives <= 0) eliminatedThisRound.push(id);
      }
    }

    // Reveal
    const revealRow = new ActionRowBuilder().addComponents(
      q.options.map((opt, idx) =>
        new ButtonBuilder()
          .setCustomId(`survival_done:${idx}`)
          .setLabel(opt.substring(0, 80))
          .setStyle(idx === q.correctAnswer ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(true)
      )
    );

    try {
      await msg.edit({ components: [revealRow] });
    } catch {}

    if (eliminatedThisRound.length > 0) {
      const elimMentions = eliminatedThisRound.map(id => `<@${id}>`).join(', ');
      await channel.send(`💀 **تم إقصاء:** ${elimMentions} بسبب نفاد القلوب!`);
    }

    await new Promise(r => setTimeout(r, 2500));
  }

  // End of survival
  const remaining = [...players.entries()].filter(([, p]) => p.lives > 0);
  let winner = null;

  if (remaining.length === 1) {
    winner = remaining[0];
  } else if (remaining.length > 1) {
    // Tie breaker by most lives, then correct answers
    remaining.sort((a, b) => b[1].lives - a[1].lives || b[1].correctCount - a[1].correctCount);
    winner = remaining[0];
  } else {
    // If all died, find who survived the longest
    const all = [...players.entries()].sort((a, b) => b[1].correctCount - a[1].correctCount);
    winner = all[0];
  }

  if (winner) {
    const winnerId = winner[0];
    const jackpotCoins = 300 + (players.size * 50);
    const jackpotXp = 250 + (players.size * 30);

    queries.addCoinsAndXp(guildId, winnerId, jackpotCoins, jackpotXp, '👑 الفوز ببطولة البقاء');

    const endEmbed = new EmbedBuilder()
      .setTitle('👑 بطل طور البقاء (The Ultimate Survivor)!')
      .setDescription(
        `🏆 تهانينا لـ <@${winnerId}> على الصمود والفوز ببطولة البقاء!\n\n` +
        `💰 **الجائزة الكبرى:** **${jackpotCoins}** دينار ذهبي\n` +
        `⭐ **الخبرة:** **${jackpotXp}** XP\n` +
        `🎯 **إجمالي الإجابات الصحيحة:** ${winner[1].correctCount}`
      )
      .setColor(config.colors.gold)
      .setTimestamp();

    await channel.send({ embeds: [endEmbed] });
  }
}

module.exports = {
  startSurvivalSession,
};
