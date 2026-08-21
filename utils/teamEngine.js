'use strict';
/**
 * utils/teamEngine.js
 * Team Trivia Battle Engine (🔴 Red vs 🔵 Blue vs 🟢 Green)
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

const TEAMS = {
  red:   { name: '🔴 فريق الصقور', color: config.colors.teamRed, emoji: '🔴' },
  blue:  { name: '🔵 فريق النمور', color: config.colors.teamBlue, emoji: '🔵' },
  green: { name: '🟢 فريق الأبطال', color: config.colors.teamGreen, emoji: '🟢' },
};

/**
 * Start a Team Trivia Battle
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {number} questionCount
 * @param {string[]} categories
 */
async function startTeamBattle(interaction, questionCount = 10, categories = []) {
  const guildId = interaction.guildId;
  const channel = interaction.channel;

  const cats = categories.length > 0 ? categories : config.categories.map(c => c.id);
  const questions = selectQuestions({ count: questionCount, categories: cats, usedIds: new Set() });

  if (questions.length === 0) {
    await interaction.reply({ content: '❌ لا توجد أسئلة كافية لبدء حرب الفرق.', ephemeral: true });
    return;
  }

  const lobbyEmbed = new EmbedBuilder()
    .setTitle('⚔️ حرب الفرق (Team Trivia Battle)')
    .setDescription(
      'انضم إلى أحد الفرق وتنافس مع فريقك لجمع أكبر عدد من النقاط!\n\n' +
      '🔴 **فريق الصقور**\n' +
      '🔵 **فريق النمور**\n' +
      '🟢 **فريق الأبطال**\n\n' +
      'اختر فريقك بالضغط على الزر أدناه! تبدأ المعركة بعد **35 ثانية**.'
    )
    .setColor(config.colors.purple)
    .setFooter({ text: 'اختر فريقك الآن!' });

  const teamButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('team_pick:red').setLabel('🔴 الصقور').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('team_pick:blue').setLabel('🔵 النمور').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('team_pick:green').setLabel('🟢 الأبطال').setStyle(ButtonStyle.Success)
  );

  const lobbyMsg = await interaction.reply({
    embeds: [lobbyEmbed],
    components: [teamButtons],
    fetchReply: true,
  });

  const playerTeams = new Map(); // userId -> 'red' | 'blue' | 'green'
  const playerScores = new Map(); // userId -> number

  const lobbyCollector = lobbyMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 35000,
  });

  lobbyCollector.on('collect', async (btn) => {
    const teamKey = btn.customId.split(':')[1];
    playerTeams.set(btn.user.id, teamKey);
    playerScores.set(btn.user.id, 0);

    await btn.reply({
      content: `✅ تم انضمامك إلى **${TEAMS[teamKey].name}**!`,
      ephemeral: true,
    });
  });

  lobbyCollector.on('end', async () => {
    if (playerTeams.size < 2) {
      await channel.send('⛔ تم إلغاء حرب الفرق لعدم وجود لاعبين كافيين (مطلوب لاعبان على الأقل).');
      return;
    }

    const teamCounts = { red: 0, blue: 0, green: 0 };
    for (const t of playerTeams.values()) teamCounts[t]++;

    await channel.send(
      `⚔️ **انطلقت حرب الفرق!**\n` +
      `🔴 الصقور: ${teamCounts.red} لاعب | 🔵 النمور: ${teamCounts.blue} لاعب | 🟢 الأبطال: ${teamCounts.green} لاعب`
    );

    runTeamBattleGame(channel, guildId, playerTeams, playerScores, questions);
  });
}

/**
 * Run the team battle questions loop
 */
async function runTeamBattleGame(channel, guildId, playerTeams, playerScores, questions) {
  const teamScores = { red: 0, blue: 0, green: 0 };

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const votes = {}; // userId -> index

    const embed = new EmbedBuilder()
      .setTitle(`⚔️ حرب الفرق — السؤال [${i + 1}/${questions.length}]`)
      .setDescription(`**${q.text}**\n\n📊 **نتائج الفرق الحالية:**\n🔴 الصقور: **${teamScores.red}** | 🔵 النمور: **${teamScores.blue}** | 🟢 الأبطال: **${teamScores.green}**`)
      .setColor(config.colors.purple)
      .setFooter({ text: 'لديك 15 ثانية للإجابة!' });

    const row = new ActionRowBuilder().addComponents(
      q.options.map((opt, idx) =>
        new ButtonBuilder()
          .setCustomId(`team_ans:${idx}`)
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
        if (!playerTeams.has(btn.user.id)) {
          await btn.reply({ content: '⚠️ أنت لست منضماً لأي فريق في هذه الجولة!', ephemeral: true });
          return;
        }

        if (votes[btn.user.id] !== undefined) {
          await btn.reply({ content: '⚠️ لقد أجبت بالفعل!', ephemeral: true });
          return;
        }

        const chosen = parseInt(btn.customId.split(':')[1], 10);
        votes[btn.user.id] = chosen;

        await btn.reply({ content: '✅ تم تسجيل إجابتك لفريقك!', ephemeral: true });
      });

      collector.on('end', () => resolve());
    });

    // Score points
    for (const [userId, chosenIdx] of Object.entries(votes)) {
      if (chosenIdx === q.correctAnswer) {
        const teamKey = playerTeams.get(userId);
        if (teamKey) {
          teamScores[teamKey] += 10;
          playerScores.set(userId, (playerScores.get(userId) || 0) + 10);
        }
      }
    }

    // Reveal buttons
    const revealRow = new ActionRowBuilder().addComponents(
      q.options.map((opt, idx) =>
        new ButtonBuilder()
          .setCustomId(`team_done:${idx}`)
          .setLabel(opt.substring(0, 80))
          .setStyle(idx === q.correctAnswer ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(true)
      )
    );

    try {
      await msg.edit({ components: [revealRow] });
    } catch {}

    await new Promise(r => setTimeout(r, 2000));
  }

  // Determine winning team
  const sortedTeams = Object.entries(teamScores).sort((a, b) => b[1] - a[1]);
  const winningTeamKey = sortedTeams[0][0];
  const winningTeam = TEAMS[winningTeamKey];

  // Find MVP player
  const sortedPlayers = [...playerScores.entries()].sort((a, b) => b[1] - a[1]);
  const mvp = sortedPlayers[0];

  // Award rewards to winning team members
  for (const [userId, teamKey] of playerTeams.entries()) {
    if (teamKey === winningTeamKey) {
      queries.addCoinsAndXp(guildId, userId, 100, 80, 'الفوز في حرب الفرق');
    } else {
      queries.addCoinsAndXp(guildId, userId, 30, 30, 'المشاركة في حرب الفرق');
    }
  }

  // MVP extra bonus
  if (mvp && mvp[1] > 0) {
    queries.addCoinsAndXp(guildId, mvp[0], 100, 100, '⭐ أفضل لاعب MVP في حرب الفرق');
  }

  const finalEmbed = new EmbedBuilder()
    .setTitle('🏆 نتائج حرب الفرق النهائية!')
    .setDescription(
      `🎉 **الفريق الفائز:** **${winningTeam.name}** بمجموع **${teamScores[winningTeamKey]}** نقطة!\n\n` +
      `📊 **الترتيب العام للفرق:**\n` +
      `1️⃣ ${TEAMS[sortedTeams[0][0]].name}: **${sortedTeams[0][1]}** نقطة\n` +
      `2️⃣ ${TEAMS[sortedTeams[1][0]].name}: **${sortedTeams[1][1]}** نقطة\n` +
      `3️⃣ ${TEAMS[sortedTeams[2][0]].name}: **${sortedTeams[2][1]}** نقطة\n\n` +
      (mvp && mvp[1] > 0 ? `⭐ **نجم المعركة (MVP):** <@${mvp[0]}> برصيد **${mvp[1]}** نقطة!` : '')
    )
    .setColor(winningTeam.color)
    .setTimestamp();

  await channel.send({ embeds: [finalEmbed] });
}

module.exports = {
  startTeamBattle,
};
