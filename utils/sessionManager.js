'use strict';
/**
 * utils/gameEngine.js
 *
 * Core game loop:
 *   startSession → postQuestion → collectVotes → revealAndAdvance
 *   → [next question | endSession]
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const config  = require('../config.json');
const sm      = require('./sessionManager');
const { calculateScore, assignSpeedRanks } = require('./scoring');
const queries = require('../database/queries');
const { runTransaction } = require('../database/schema');

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const CAT_NAMES = Object.fromEntries(
  config.categories.map(c => [c.id, c.nameAr])
);

const DIFF_NAMES = { easy: 'سهل 🟢', medium: 'متوسط 🟡', hard: 'صعب 🔴' };

const REASON_FOOTER = {
  completed:            '✅ انتهت الجلسة بنجاح',
  stopped:              '⏹️ أُوقفت الجلسة مبكراً — النقاط المكتسبة فقط',
  crash:                '💥 انتهت الجلسة بسبب خطأ غير متوقع',
  idle:                 '😴 انتهت الجلسة بسبب عدم النشاط',
  insufficient_players: '⛔ انتهت الجلسة — لاعبون غير كافيون',
  channel_lost:         '📵 انتهت الجلسة — فُقد الوصول للقناة',
  scheduled_override:   '📅 أُوقفت الجلسة بسبب جلسة مجدولة',
};

const BUTTON_LABEL_MAX_CHARS = 80;
const EMBED_FIELD_SAFE_LIMIT = 1000;
const TOP_RANK_DISPLAY = 5;
const RANK_EMOJIS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
const PODIUM_MEDALS = ['🥇', '🥈', '🥉'];
const MAX_REST_DISPLAY = 50;

let achievementCache = null;

function getAchievementDefinitions() {
  if (!achievementCache) achievementCache = config.achievements || [];
  return achievementCache;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION & HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function isValidSession(session) {
  return session && !session.isEnding;
}

function formatScore(score) {
  return Number.isInteger(score) ? score.toString() : score.toFixed(1);
}

/**
 * Shuffle array in place (Fisher-Yates algorithm)
 */
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function buildTopLeaderboard(sorted) {
  const topEntries = [];
  let rank = 1;
  let prevScore = null;

  for (let i = 0; i < sorted.length; i++) {
    const [userId, score] = sorted[i];
    if (prevScore !== null && score !== prevScore) rank = topEntries.length + 1;
    if (rank > TOP_RANK_DISPLAY && (prevScore === null || score !== prevScore)) break;
    topEntries.push({ userId, score, rank });
    prevScore = score;
  }
  return topEntries;
}

// ═══════════════════════════════════════════════════════════════════════════
// OWNER LOG HELPER
// ═══════════════════════════════════════════════════════════════════════════

async function logToOwner(client, message) {
  if (!config.ownerLogChannelId) return;
  try {
    const ch = await client.channels.fetch(config.ownerLogChannelId);
    if (ch?.isTextBased()) {
      const payload = typeof message === 'string' ? { content: message } : message;
      await ch.send(payload);
    }
  } catch (err) {
    console.error('[GameEngine] Failed to log to owner:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EMBED BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

function buildDashboardEmbed(session) {
  const sorted = sm.getSortedScores(session.guildId);
  const topEntries = buildTopLeaderboard(sorted);

  const rankLines = topEntries.map(e => {
    const medal = RANK_EMOJIS[e.rank - 1] ?? `**${e.rank}.**`;
    return `${medal} <@${e.userId}> — **${formatScore(e.score)}** نقطة`;
  });

  return new EmbedBuilder()
    .setTitle(`📊 لوحة النقاط — بعد السؤال ${session.currentIndex + 1}`)
    .setColor(config.colors.info)
    .setDescription(rankLines.length ? rankLines.join('\n') : 'لا يوجد نقاط بعد')
    .setTimestamp();
}

function buildQuestionEmbed(session, question) {
  const catName = CAT_NAMES[question.category] ?? question.category;
  const diff = DIFF_NAMES[question.difficulty] ?? question.difficulty;

  const embed = new EmbedBuilder()
    .setTitle(`❓ السؤال ${session.currentIndex + 1} من ${session.questionCount}`)
    .setDescription(question.text)
    .setColor(config.colors.info)
    .addFields(
      { name: '📂 الفئة', value: catName, inline: true },
      { name: '⚡ الصعوبة', value: diff, inline: true },
    )
    .setFooter({ text: `⏱️ لديك ${session.timeLimitSec} ثانية للإجابة` });

  if (question.imageUrl) embed.setImage(question.imageUrl);
  return embed;
}

function buildResultsEmbed(session, scoresData, reason) {
  const sorted = Object.entries(scoresData).sort((a, b) => b[1] - a[1]);
  const podium = [];
  const rest = [];
  let lastScore = null;
  let lastRank = 0;
  let position = 0;

  for (const [userId, score] of sorted) {
    position++;
    if (lastScore !== score) lastRank = position;
    const entry = `**${lastRank}.** <@${userId}> — **${formatScore(score)}** نقطة`;
    if (lastRank <= 3) podium.push(`${PODIUM_MEDALS[lastRank - 1]} ${entry}`);
    else rest.push(entry);
    lastScore = score;
  }

  const winner = sorted[0];
  let description = (winner && winner[1] > 0) ? `🎉 **مبروك <@${winner[0]}> على الفوز بهذه الجلسة!**\n\n` : '';

  const embed = new EmbedBuilder()
    .setTitle('🏆 نتائج الجلسة النهائية')
    .setDescription(description + (podium.join('\n') || 'لا يوجد لاعبون بنقاط في هذه الجلسة.'))
    .setColor(reason === 'completed' ? config.colors.success : config.colors.warning)
    .setFooter({ text: REASON_FOOTER[reason] ?? reason })
    .setTimestamp();

  if (rest.length > 0) {
    const chunks = chunkText(rest.slice(0, MAX_REST_DISPLAY), EMBED_FIELD_SAFE_LIMIT);
    for (let i = 0; i < chunks.length; i++) {
      embed.addFields({ name: i === 0 ? '📋 بقية الترتيب' : '\u200B', value: chunks[i] });
    }
  }
  return embed;
}

function chunkText(lines, limit) {
  const chunks = [];
  let chunk = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > limit) {
      if (chunk.length > 0) chunks.push(chunk.join('\n'));
      chunk = [];
      len = 0;
    }
    chunk.push(line);
    len += line.length + 1;
  }
  if (chunk.length > 0) chunks.push(chunk.join('\n'));
  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUTTON BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

function buildAnswerButtons(question, disabled = false, correctIdx = null) {
  const buttons = question.options.map((opt, i) => {
    let style = ButtonStyle.Primary;
    if (disabled) style = i === correctIdx ? ButtonStyle.Success : ButtonStyle.Danger;
    return new ButtonBuilder()
      .setCustomId(`trivia_answer:${i}`)
      .setLabel(opt.substring(0, BUTTON_LABEL_MAX_CHARS))
      .setStyle(style)
      .setDisabled(disabled);
  });
  return new ActionRowBuilder().addComponents(buttons);
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE GAME LOOP
// ═══════════════════════════════════════════════════════════════════════════

async function startSession(client, session, channel) {
  // 1. خلط الأسئلة عشوائياً لضمان عدم التكرار
  const shuffledQuestions = shuffleArray([...session.questions]);
  sm.updateSession(session.guildId, { questions: shuffledQuestions });

  const latestSession = sm.getSession(session.guildId);
  if (!isValidSession(latestSession)) return;
  
  await postQuestion(client, latestSession, channel);
}

async function postQuestion(client, session, channel) {
  const guildId = session.guildId;
  const question = session.questions[session.currentIndex];

  sm.updateSession(guildId, { currentVotes: {}, stopPhase: 'voting' });

  const embed = buildQuestionEmbed(session, question);
  const row = buildAnswerButtons(question);

  let qMsg;
  try {
    qMsg = await channel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('[GameEngine] Failed to post question:', err.message);
    const currentSession = sm.getSession(guildId);
    if (isValidSession(currentSession)) await handleChannelLoss(client, currentSession);
    return;
  }

  sm.updateSession(guildId, { questionMessage: qMsg });
  await collectVotes(client, guildId, qMsg, question);
}

async function collectVotes(client, guildId, qMsg, question) {
  const session = sm.getSession(guildId);
  if (!isValidSession(session)) return;

  const timeLimitMs = session.timeLimitSec * 1000;

  const collector = qMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: i => i.customId.startsWith('trivia_answer:'),
    time: timeLimitMs,
  });

  collector.on('collect', async (interaction) => {
    if (interaction.deferred || interaction.replied) return;

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      if (err.code !== 40060) console.error('[collectVotes defer error]', err);
      return;
    }

    const currentSession = sm.getSession(guildId);
    if (!isValidSession(currentSession)) return;

    const userId = interaction.user.id;

    if (currentSession.currentVotes[userId]) {
      await interaction.editReply({ content: '⚠️ لقد أجبت بالفعل على هذا السؤال — لا يمكن تغيير الإجابة.' });
      return;
    }

    const answerIndex = parseInt(interaction.customId.split(':')[1], 10);
    const now = Date.now();

    sm.ensurePlayer(guildId, userId);
    currentSession.currentVotes[userId] = { answerIndex, timestampMs: now };
    sm.markAnswered(guildId, userId, currentSession.currentIndex);

    await interaction.editReply({ content: '✅ تم تسجيل إجابتك!' });
  });

  collector.on('end', async () => {
    const currentSession = sm.getSession(guildId);
    if (isValidSession(currentSession)) {
      await revealAndAdvance(client, currentSession, qMsg, question);
    }
  });
}

async function revealAndAdvance(client, session, qMsg, question) {
  const guildId = session.guildId;
  const votes = session.currentVotes;
  const voteCount = Object.keys(votes).length;

  if (session.currentIndex === 0 && voteCount < 2) {
    await endSession(client, session, 'insufficient_players');
    return;
  }

  const newZeroCount = voteCount === 0 ? session.consecutiveZeroVotes + 1 : 0;
  sm.updateSession(guildId, { consecutiveZeroVotes: newZeroCount, stopPhase: 'revealing' });

  if (newZeroCount >= config.idleQuestionsThreshold) {
    await revealButtons(qMsg, question);
    await endSession(client, session, 'idle');
    return;
  }

  await revealButtons(qMsg, question);

  const correctVotes = Object.entries(votes)
    .filter(([, v]) => v.answerIndex === question.correctAnswer)
    .map(([userId, v]) => ({ userId, timestampMs: v.timestampMs }));

  const speedRanks = assignSpeedRanks(correctVotes);
  const isLastQ = session.currentIndex === session.questionCount - 1;
  const speedFirstThisQuestion = new Set();

  for (const [userId, vote] of Object.entries(votes)) {
    const isCorrect = vote.answerIndex === question.correctAnswer;
    const streak = sm.updateStreak(guildId, userId, isCorrect);
    if (!isCorrect) continue;

    const rankInfo = speedRanks.get(userId) ?? { rank: 0, tieCount: 1 };
    const completionEarned = isLastQ && sm.hasCompletionBonus(guildId, userId);

    const { finalScore } = calculateScore({
      difficulty: question.difficulty,
      streakCount: streak,
      speedRank: rankInfo.rank,
      speedTieCount: rankInfo.tieCount,
      isLastQuestion: isLastQ,
      completionEarned,
    });

    sm.addPoints(guildId, userId, finalScore);
    if (rankInfo.rank === 1) speedFirstThisQuestion.add(userId);
  }

  for (const userId of [...session.scores.keys()]) {
    if (!votes[userId]) sm.updateStreak(guildId, userId, false);
  }

  // ── حفظ تاريخ السؤال ──
  sm.updateSession(guildId, {
    history: [
      ...(session.history || []),
      {
        questionId: question.id,
        correctAnswer: question.correctAnswer,
        votes: { ...votes },
        speedWinners: [...speedFirstThisQuestion],
      }
    ]
  });

  // ── إرسال لوحة الجلسة كرسالة جديدة بعد كل سؤال ──
  const latestSession = sm.getSession(guildId);
  if (latestSession) {
    try {
      // إرسال رسالة جديدة تماماً بدلاً من تعديل القديمة
      await qMsg.channel.send({ embeds: [buildDashboardEmbed(latestSession)] });
    } catch (err) {
      console.error('[GameEngine] Failed to send new dashboard:', err.message);
    }
  }

  const firstCorrectTs = correctVotes.length > 0 ? Math.min(...correctVotes.map(v => v.timestampMs)) : 0;
  setImmediate(() => {
    try {
      queries.upsertQuestionStats(guildId, question.id, correctVotes.length > 0, voteCount === 0, firstCorrectTs);
    } catch (err) {
      console.error('[GameEngine] upsertQuestionStats failed:', err.message);
    }
  });

  const afterReveal = sm.getSession(guildId);
  if (!isValidSession(afterReveal)) return;

  if (afterReveal.stopRequested && afterReveal.stopPhase === 'revealing') {
    await sleep(config.autoAdvanceDelayMs);
    const afterWait = sm.getSession(guildId);
    if (isValidSession(afterWait)) await endSession(client, afterWait, 'stopped');
    return;
  }

  await sleep(config.autoAdvanceDelayMs);

  const afterDelay = sm.getSession(guildId);
  if (!isValidSession(afterDelay)) return;
  if (afterDelay.stopRequested) {
    await endSession(client, afterDelay, 'stopped');
    return;
  }

  const nextIndex = afterDelay.currentIndex + 1;
  if (nextIndex >= afterDelay.questionCount) {
    await endSession(client, afterDelay, 'completed');
    return;
  }

  sm.updateSession(guildId, { currentIndex: nextIndex });

  const channel = await fetchChannel(client, afterDelay.channelId);
  if (!channel) {
    const latest = sm.getSession(guildId);
    if (isValidSession(latest)) await handleChannelLoss(client, latest);
    return;
  }

  await postQuestion(client, sm.getSession(guildId), channel);
}

async function revealButtons(qMsg, question) {
  if (!qMsg || !qMsg.editable) return;
  try {
    const revealRow = buildAnswerButtons(question, true, question.correctAnswer);
    await qMsg.edit({ components: [revealRow] });
  } catch {}
}

async function skipQuestion(client, session, channel) {
  const guildId = session.guildId;
  try {
    if (session.questionMessage) {
      const question = session.questions[session.currentIndex];
      const greyRow = new ActionRowBuilder().addComponents(
        question.options.map((opt, i) =>
          new ButtonBuilder().setCustomId(`trivia_answer:${i}`).setLabel(opt.substring(0, BUTTON_LABEL_MAX_CHARS)).setStyle(ButtonStyle.Secondary).setDisabled(true)
        )
      );
      await session.questionMessage.edit({ components: [greyRow] });
    }
  } catch {}

  session.skippedIndexes.add(session.currentIndex);
  sm.updateSession(guildId, { currentVotes: {}, consecutiveZeroVotes: 0 });

  const nextIndex = session.currentIndex + 1;
  if (nextIndex >= session.questionCount) {
    await endSession(client, session, 'completed');
    return;
  }

  sm.updateSession(guildId, { currentIndex: nextIndex });
  if (!channel) channel = await fetchChannel(client, session.channelId);
  if (!channel) {
    const latest = sm.getSession(guildId);
    if (isValidSession(latest)) await handleChannelLoss(client, latest);
    return;
  }
  await postQuestion(client, sm.getSession(guildId), channel);
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION END
// ═══════════════════════════════════════════════════════════════════════════

async function endSession(client, session, reason) {
  const guildId = session.guildId;
  const current = sm.getSession(guildId);
  if (!current || current.isEnding) return;

  sm.updateSession(guildId, { isEnding: true });

  try {
    if (current.questionMessage) {
      const q = current.questions[current.currentIndex];
      const row = buildAnswerButtons(q, true, q.correctAnswer);
      await current.questionMessage.edit({ components: [row] });
    }
  } catch {}

  const scoresData = Object.fromEntries(current.scores);

  const questionsData = current.questions.map((q, idx) => {
    const qHistory = current.history?.[idx] || {};
    return {
      id: q.id,
      category: q.category,
      difficulty: q.difficulty,
      correctAnswer: q.correctAnswer,
      skipped: current.skippedIndexes.has(idx),
      playerAnswers: qHistory.votes || (idx === current.currentIndex ? { ...current.currentVotes } : {}),
      speedWinners: qHistory.speedWinners || [],
    };
  });

  try {
    runTransaction(() => {
      queries.insertSessionHistory({
        guildId, hostId: current.hostId, channelId: current.channelId,
        startedAt: current.startedAt, endedAt: Date.now(), endReason: reason,
        questionCount: current.questionCount, categories: current.categories,
        questionsData, scoresData,
      });
    });
  } catch (err) {
    console.error('[GameEngine] CRITICAL: Atomic session archive failed:', err.message);
    await logToOwner(client, `💥 **فشل أرشفة الجلسة** للسيرفر \`${guildId}\`\nالسبب: \`${reason}\`\nالخطأ: ${err.message}`);
  }

  sm.deleteSession(guildId);

  const channel = await fetchChannel(client, current.channelId);

  if (reason === 'insufficient_players') {
    await channel?.send({ embeds: [new EmbedBuilder().setTitle('⛔ انتهت الجلسة — لاعبون غير كافيون').setDescription('انتهت الجلسة بسبب عدم كفاية اللاعبين.\nيجب أن يصوّت **لاعبان على الأقل** على السؤال الأول لاستمرار الجلسة.').setColor(config.colors.error)] }).catch(() => {});
  } else if (reason !== 'channel_lost') {
    if (reason === 'idle') {
      await channel?.send({ embeds: [new EmbedBuilder().setTitle('😴 انتهت الجلسة — عدم النشاط').setDescription(`لم يُجب أحد على **${config.idleQuestionsThreshold}** أسئلة متتالية.\nتم إنهاء الجلسة تلقائياً.`).setColor(config.colors.warning)] }).catch(() => {});
    }

    // إرسال النتيجة النهائية دائماً
    await channel?.send({
      embeds: [buildResultsEmbed(current, scoresData, reason)],
    }).catch(() => {});
  }

  setImmediate(() =>
    asyncPostProcess(client, guildId, current, scoresData, questionsData, reason)
      .catch(err => console.error('[GameEngine] asyncPostProcess error:', err.message))
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ASYNC POST-PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

async function asyncPostProcess(client, guildId, session, scoresData, questionsData, reason) {
  const sorted = Object.entries(scoresData).sort((a, b) => b[1] - a[1]);
  const winnerId = sorted[0]?.[1] > 0 ? sorted[0]?.[0] : null;

  for (const [userId, points] of Object.entries(scoresData)) {
    if (points < 0) continue;
    const isWin = userId === winnerId;
    let correctCount = 0;
    let speedFirstCount = 0;

    for (const q of questionsData) {
      if (q.skipped) continue;
      const vote = q.playerAnswers?.[userId];
      if (vote && vote.answerIndex === q.correctAnswer) correctCount++;
      if (q.speedWinners?.includes(userId)) speedFirstCount++;
    }

    const longestStreak = session.streaks?.get(userId) ?? 0;

    try {
      queries.upsertPlayerStats(guildId, userId, {
        points, sessions: 1, wins: isWin ? 1 : 0,
        answers: correctCount, streak: longestStreak, speedFirstCount,
      });
    } catch (err) {
      console.error(`[GameEngine] upsertPlayerStats failed for ${userId}:`, err.message);
    }
  }

  await evaluateAchievements(client, guildId, session, scoresData, questionsData, sorted);
}

function checkAchievement(achievements, achId, condition, newUnlocks) {
  if (!achievements[achId] && condition) {
    achievements[achId] = true;
    newUnlocks.push(achId);
    return true;
  }
  return false;
}

async function evaluateAchievements(client, guildId, session, scoresData, questionsData, sortedScores) {
  const achievements_defs = getAchievementDefinitions();
  const achievementMap = new Map(achievements_defs.map(a => [a.id, a]));

  for (const [userId] of Object.entries(scoresData)) {
    try {
      const stats = queries.getPlayerStats(guildId, userId);
      if (!stats) continue;

      let achievements = {};
      try { achievements = JSON.parse(stats.achievements ?? '{}'); } catch { achievements = {}; }

      const newUnlocks = [];
      const winCount = stats.win_count || 0;
      const sessions = stats.session_count || 0;
      const answers = stats.total_answers || 0;
      const totalPts = stats.total_points || 0;
      
      const currentSessionStreak = session.streaks?.get(userId) ?? 0;
      const allTimeMaxStreak = Math.max(stats.max_streak || 0, currentSessionStreak);

      checkAchievement(achievements, 'first_win', winCount >= 1, newUnlocks);
      checkAchievement(achievements, 'win_5', winCount >= 5, newUnlocks);
      checkAchievement(achievements, 'win_10', winCount >= 10, newUnlocks);
      checkAchievement(achievements, 'win_25', winCount >= 25, newUnlocks);
      checkAchievement(achievements, 'win_50', winCount >= 50, newUnlocks);

      checkAchievement(achievements, 'sessions_5', sessions >= 5, newUnlocks);
      checkAchievement(achievements, 'sessions_20', sessions >= 20, newUnlocks);
      checkAchievement(achievements, 'sessions_50', sessions >= 50, newUnlocks);
      checkAchievement(achievements, 'sessions_100', sessions >= 100, newUnlocks);

      checkAchievement(achievements, 'answers_10', answers >= 10, newUnlocks);
      checkAchievement(achievements, 'answers_50', answers >= 50, newUnlocks);
      checkAchievement(achievements, 'answers_100', answers >= 100, newUnlocks);
      checkAchievement(achievements, 'answers_250', answers >= 250, newUnlocks);
      checkAchievement(achievements, 'answers_500', answers >= 500, newUnlocks);
      checkAchievement(achievements, 'answers_1000', answers >= 1000, newUnlocks);

      checkAchievement(achievements, 'points_500', totalPts >= 500, newUnlocks);
      checkAchievement(achievements, 'points_2000', totalPts >= 2000, newUnlocks);
      checkAchievement(achievements, 'points_5000', totalPts >= 5000, newUnlocks);
      checkAchievement(achievements, 'points_10000', totalPts >= 10000, newUnlocks);

      checkAchievement(achievements, 'streak_3', allTimeMaxStreak >= 3, newUnlocks);
      checkAchievement(achievements, 'streak_5', allTimeMaxStreak >= 5, newUnlocks);
      checkAchievement(achievements, 'streak_10', allTimeMaxStreak >= 10, newUnlocks);
      checkAchievement(achievements, 'streak_15', allTimeMaxStreak >= 15, newUnlocks);
      checkAchievement(achievements, 'streak_20', allTimeMaxStreak >= 20, newUnlocks);

      if (!achievements.perfect_session) {
        const nonSkipped = questionsData.filter(q => !q.skipped);
        const allCorrect = nonSkipped.length > 0 && nonSkipped.every(q =>
          q.playerAnswers?.[userId]?.answerIndex === q.correctAnswer
        );
        checkAchievement(achievements, 'perfect_session', allCorrect, newUnlocks);
      }

      checkAchievement(achievements, 'first_answer', answers >= 1, newUnlocks);

      const sessionHour = new Date(session.startedAt).getUTCHours();
      checkAchievement(achievements, 'night_owl', sessionHour >= 0 && sessionHour < 4, newUnlocks);
      checkAchievement(achievements, 'early_bird', sessionHour >= 4 && sessionHour < 6, newUnlocks);

      if (newUnlocks.length > 0) {
        queries.setPlayerAchievements(guildId, userId, JSON.stringify(achievements));

        for (const achId of newUnlocks) {
          const achDef = achievementMap.get(achId);
          if (!achDef) continue;
          try {
            const user = await client.users.fetch(userId);
            await user.send({
              embeds: [new EmbedBuilder().setTitle('🏅 إنجاز جديد مفتوح!').setDescription(`**${achDef.nameAr}**\n${achDef.descriptionAr}`).setColor(config.colors.success).setTimestamp()],
            });
          } catch {}
        }
      }
    } catch (err) {
      console.error(`[GameEngine] evaluateAchievements failed for user ${userId}:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHANNEL LOSS HANDLER
// ═══════════════════════════════════════════════════════════════════════════

async function handleChannelLoss(client, session) {
  const guildId = session.guildId;
  const settings = queries.getGuildSettings(guildId);
  const backupId = settings?.backup_channel;
  const hostId = session.hostId;

  if (!session.isEnding) await endSession(client, session, 'channel_lost');

  const errorMsg = {
    embeds: [new EmbedBuilder().setTitle('📵 انتهت الجلسة — فُقد الوصول للقناة').setDescription('فقد البوت صلاحية الإرسال في قناة الجلسة.\nتم حفظ النتائج وإنهاء الجلسة تلقائياً.').setColor(config.colors.error)],
  };

  if (backupId) {
    try {
      const backup = await client.channels.fetch(backupId);
      if (backup?.isTextBased()) {
        await backup.send(errorMsg);
        await logToOwner(client, `⚠️ [${guildId}] Channel loss — notified backup channel <#${backupId}>.`);
        return;
      }
    } catch {}
  }

  try {
    const host = await client.users.fetch(hostId);
    await host.send(errorMsg);
    await logToOwner(client, `⚠️ [${guildId}] Channel loss — DMed host <@${hostId}>.`);
    return;
  } catch {}

  await logToOwner(client, `⚠️ **[${guildId}] Channel loss — all fallbacks failed.** No backup channel, host DMs closed.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES & EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

async function fetchChannel(client, channelId) {
  if (!client || !channelId) return null;
  try { return await client.channels.fetch(channelId); } catch { return null; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  startSession, skipQuestion, endSession,
  buildResultsEmbed, buildDashboardEmbed, logToOwner,
};
