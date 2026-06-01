'use strict';
/**
 * utils/gameEngine.js
 *
 * Core game loop:
 *   startSession → postQuestion → collectVotes → revealAndAdvance
 *   → [next question | endSession]
 *
 * All Discord interaction handlers call deferReply()/deferUpdate()
 * immediately before any async work (per Discord's 3-second rule).
 *
 * Session state mutations go through sessionManager — gameEngine
 * never accesses the sessions Map directly.
 *
 * Atomic archive guarantee:
 *   endSession() writes session_history inside a single SQLite
 *   transaction before clearing memory. Either the full archive
 *   commits or nothing is written.
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
const { enqueueDashboardEdit, clearQueue } = require('./dashboardQueue');
const queries = require('../database/queries');
const { runTransaction } = require('../database/schema');

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

// Pre-build category name lookup from config
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

// Discord and UI limits
const BUTTON_LABEL_MAX_CHARS = 80;
const EMBED_FIELD_MAX_CHARS = 1024;
const EMBED_FIELD_SAFE_LIMIT = 1000;
const TOP_RANK_DISPLAY = 5;
const RANK_EMOJIS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
const PODIUM_MEDALS = ['🥇', '🥈', '🥉'];
const MAX_REST_DISPLAY = 50;

// Achievement cache to avoid repeated lookups
let achievementCache = null;

/**
 * Get cached achievement definitions from config
 * @returns {Array} Achievement definitions
 */
function getAchievementDefinitions() {
  if (!achievementCache) {
    achievementCache = config.achievements || [];
  }
  return achievementCache;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION & HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a session is valid and not ending
 * @param {object} session
 * @returns {boolean}
 */
function isValidSession(session) {
  return session && !session.isEnding;
}

/**
 * Determine if session should show special end message
 * @param {string} reason
 * @returns {boolean}
 */
function hasSpecialEndMessage(reason) {
  return ['insufficient_players', 'idle'].includes(reason);
}

/**
 * Format score for display (handle decimals)
 * @param {number} score
 * @returns {string}
 */
function formatScore(score) {
  return Number.isInteger(score) ? score.toString() : score.toFixed(1);
}

/**
 * Build top leaderboard entries with tie-aware ranking
 * @param {Array} sorted - Sorted scores array
 * @returns {Array} Top entries with rank info
 */
function buildTopLeaderboard(sorted) {
  const topEntries = [];
  let rank = 1;
  let prevScore = null;

  for (let i = 0; i < sorted.length; i++) {
    const [userId, score] = sorted[i];

    // Assign rank: same score = same rank
    if (prevScore !== null && score !== prevScore) {
      rank = topEntries.length + 1;
    }

    // Stop if rank > 5 AND this score is different from the last shown
    if (rank > TOP_RANK_DISPLAY && (prevScore === null || score !== prevScore)) break;

    topEntries.push({ userId, score, rank });
    prevScore = score;
  }

  return topEntries;
}

// ═══════════════════════════════════════════════════════════════════════════
// OWNER LOG HELPER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send a message to the configured owner log channel.
 * Fails silently — never throws.
 *
 * @param {import('discord.js').Client} client
 * @param {string|object} message - string or Discord message options
 */
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

/**
 * Build the live dashboard embed shown alongside each question.
 * Shows vote count and top-5 leaderboard (ties extend beyond 5).
 *
 * @param {import('./sessionManager').SessionState} session
 * @returns {EmbedBuilder}
 */
function buildDashboardEmbed(session) {
  const voteCount = Object.keys(session.currentVotes).length;
  const sorted = sm.getSortedScores(session.guildId);
  const topEntries = buildTopLeaderboard(sorted);

  const rankLines = topEntries.map(e => {
    const medal = RANK_EMOJIS[e.rank - 1] ?? `**${e.rank}.**`;
    const pts = formatScore(e.score);
    return `${medal} <@${e.userId}> — **${pts}** نقطة`;
  });

  return new EmbedBuilder()
    .setTitle(`📊 لوحة الجلسة — السؤال ${session.currentIndex + 1} من ${session.questionCount}`)
    .setColor(config.colors.info)
    .addFields(
      {
        name: '🗳️ الأصوات',
        value: voteCount === 0 ? 'لم يصوّت أحد بعد' : `${voteCount} لاعب صوّت`,
        inline: true,
      },
      {
        name: '🏆 المتصدرون',
        value: rankLines.length ? rankLines.join('\n') : 'لا يوجد نقاط بعد',
        inline: false,
      }
    )
    .setTimestamp();
}

/**
 * Build the question embed for a single question.
 *
 * @param {import('./sessionManager').SessionState} session
 * @param {object} question
 * @returns {EmbedBuilder}
 */
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

  if (question.imageUrl) {
    embed.setImage(question.imageUrl);
  }

  return embed;
}

/**
 * Build the results embed shown at session end.
 * Includes podium (🥇🥈🥉), full rankings, and tie handling.
 *
 * @param {import('./sessionManager').SessionState} session
 * @param {Object.<string,number>} scoresData - userId → final points
 * @param {string} reason - end reason key
 * @returns {EmbedBuilder}
 */
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

    const pts = formatScore(score);
    const entry = `**${lastRank}.** <@${userId}> — **${pts}** نقطة`;

    if (lastRank <= 3) {
      podium.push(`${PODIUM_MEDALS[lastRank - 1]} ${entry}`);
    } else {
      rest.push(entry);
    }
    lastScore = score;
  }

  const winner = sorted[0];
  let description = '';
  if (winner && winner[1] > 0) {
    description = `🎉 **مبروك <@${winner[0]}> على الفوز بهذه الجلسة!**\n\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🏆 نتائج الجلسة')
    .setDescription(description + (podium.join('\n') || 'لا يوجد لاعبون بنقاط في هذه الجلسة.'))
    .setColor(reason === 'completed' ? config.colors.success : config.colors.warning)
    .setFooter({ text: REASON_FOOTER[reason] ?? reason })
    .setTimestamp();

  if (rest.length > 0) {
    const chunks = chunkText(rest.slice(0, MAX_REST_DISPLAY), EMBED_FIELD_SAFE_LIMIT);
    for (let i = 0; i < chunks.length; i++) {
      embed.addFields({
        name: i === 0 ? '📋 بقية الترتيب' : '​',
        value: chunks[i],
      });
    }
  }

  return embed;
}

/**
 * Split text array into chunks respecting character limit
 * @param {string[]} lines - Lines to chunk
 * @param {number} limit - Character limit per chunk
 * @returns {string[]} Chunked text
 */
function chunkText(lines, limit) {
  const chunks = [];
  let chunk = [];
  let len = 0;

  for (const line of lines) {
    if (len + line.length + 1 > limit) {
      if (chunk.length > 0) {
        chunks.push(chunk.join('\n'));
      }
      chunk = [];
      len = 0;
    }
    chunk.push(line);
    len += line.length + 1;
  }

  if (chunk.length > 0) {
    chunks.push(chunk.join('\n'));
  }

  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUTTON BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the 4-option answer button row.
 *
 * Active state:   all Primary (blue), enabled
 * Revealed state: correct → Success (green), all others → Danger (red)
 *
 * @param {object}  question
 * @param {boolean} disabled    - true after time expires
 * @param {number|null} correctIdx - index of correct answer (for reveal)
 * @returns {ActionRowBuilder}
 */
function buildAnswerButtons(question, disabled = false, correctIdx = null) {
  const buttons = question.options.map((opt, i) => {
    let style = ButtonStyle.Primary;
    if (disabled) {
      style = i === correctIdx ? ButtonStyle.Success : ButtonStyle.Danger;
    }

    return new ButtonBuilder()
      .setCustomId(`trivia_answer:${i}`)
      .setLabel(opt.substring(0, BUTTON_LABEL_MAX_CHARS))
      .setStyle(style)
      .setDisabled(disabled);
  });

  return new ActionRowBuilder().addComponents(buttons);
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD UPDATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enqueue a dashboard edit for the guild.
 * Uses dashboardQueue to serialise edits and avoid rate limits.
 *
 * @param {string} guildId
 */
function scheduleDashboardUpdate(guildId) {
  enqueueDashboardEdit(guildId, async () => {
    const s = sm.getSession(guildId);
    if (!s?.dashboardMessage) return;
    try {
      await s.dashboardMessage.edit({ embeds: [buildDashboardEmbed(s)] });
    } catch (err) {
      console.error('[GameEngine] Failed to update dashboard:', err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE GAME LOOP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start a session: post the initial dashboard, then post question 1.
 *
 * @param {import('discord.js').Client} client
 * @param {import('./sessionManager').SessionState} session
 * @param {import('discord.js').TextChannel} channel
 */
async function startSession(client, session, channel) {
  try {
    const dashMsg = await channel.send({ embeds: [buildDashboardEmbed(session)] });
    sm.updateSession(session.guildId, { dashboardMessage: dashMsg });
  } catch (err) {
    console.error('[GameEngine] Failed to post dashboard:', err.message);
  }

  const latestSession = sm.getSession(session.guildId);
  if (!isValidSession(latestSession)) return;

  await postQuestion(client, latestSession, channel);
}

/**
 * Post the current question embed + answer buttons.
 * Resets currentVotes for the new question.
 *
 * @param {import('discord.js').Client} client
 * @param {import('./sessionManager').SessionState} session
 * @param {import('discord.js').TextChannel} channel
 */
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
    if (isValidSession(currentSession)) {
      await handleChannelLoss(client, currentSession);
    }
    return;
  }

  sm.updateSession(guildId, { questionMessage: qMsg });
  await collectVotes(client, guildId, qMsg, question);
}

/**
 * Attach a button collector to the question message.
 * Handles vote recording, duplicate-vote rejection, and expired-vote rejection.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {import('discord.js').Message} qMsg
 * @param {object} question
 */
async function collectVotes(client, guildId, qMsg, question) {
  const session = sm.getSession(guildId);
  if (!isValidSession(session)) return;

  const timeLimitMs = session.timeLimitSec * 1000;

  const collector = qMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeLimitMs,
  });

  collector.on('collect', async (interaction) => {
    await interaction.deferReply({ ephemeral: true });

    const currentSession = sm.getSession(guildId);
    if (!isValidSession(currentSession)) return;

    const userId = interaction.user.id;

    if (currentSession.currentVotes[userId]) {
      await interaction.editReply({
        content: '⚠️ لقد أجبت بالفعل على هذا السؤال — لا يمكن تغيير الإجابة.',
      });
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

/**
 * Called when the vote timer expires.
 * 1. Check minimum-player rule (question 1 only).
 * 2. Track consecutive zero-vote questions (idle detection).
 * 3. Disable buttons and reveal correct/wrong answers.
 * 4. Calculate and award scores (base + difficulty + streak + speed + completion).
 * 5. Update dashboard.
 * 6. Check stop-during-reveal.
 * 7. Wait autoAdvanceDelayMs.
 * 8. Advance to next question or end session.
 *
 * @param {import('discord.js').Client} client
 * @param {import('./sessionManager').SessionState} session
 * @param {import('discord.js').Message} qMsg
 * @param {object} question
 */
async function revealAndAdvance(client, session, qMsg, question) {
  const guildId = session.guildId;
  const votes = session.currentVotes;
  const voteCount = Object.keys(votes).length;

  // ── Minimum player check (question 1 only) ───────────────────────────
  if (session.currentIndex === 0 && voteCount < 2) {
    await endSession(client, session, 'insufficient_players');
    return;
  }

  // ── Idle detection ───────────────────────────────────────────────────
  const newZeroCount = voteCount === 0 ? session.consecutiveZeroVotes + 1 : 0;

  sm.updateSession(guildId, {
    consecutiveZeroVotes: newZeroCount,
    stopPhase: 'revealing',
  });

  if (newZeroCount >= config.idleQuestionsThreshold) {
    await revealButtons(qMsg, question);
    await endSession(client, session, 'idle');
    return;
  }

  // ── Reveal answer buttons ────────────────────────────────────────────
  await revealButtons(qMsg, question);

  // ── Score calculation ────────────────────────────────────────────────
  const correctVotes = Object.entries(votes)
    .filter(([, v]) => v.answerIndex === question.correctAnswer)
    .map(([userId, v]) => ({ userId, timestampMs: v.timestampMs }));

  const speedRanks = assignSpeedRanks(correctVotes);
  const isLastQ = session.currentIndex === session.questionCount - 1;
  const speedFirstThisQuestion = new Set();

  // Process scores for correct answers only
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

    if (rankInfo.rank === 1) {
      speedFirstThisQuestion.add(userId);
    }
  }

  // Reset streaks for non-voters
  for (const userId of [...session.scores.keys()]) {
    if (!votes[userId]) {
      sm.updateStreak(guildId, userId, false);
    }
  }

  // ── Update question_stats (async, non-blocking) ──────────────────────
  const firstCorrectTs = correctVotes.length > 0
    ? Math.min(...correctVotes.map(v => v.timestampMs))
    : 0;

  setImmediate(() => {
    try {
      queries.upsertQuestionStats(
        guildId,
        question.id,
        correctVotes.length > 0,
        voteCount === 0,
        firstCorrectTs
      );
    } catch (err) {
      console.error('[GameEngine] upsertQuestionStats failed:', err.message);
    }
  });

  // ── Dashboard update ─────────────────────────────────────────────────
  scheduleDashboardUpdate(guildId);

  // ── Stop-during-reveal check ─────────────────────────────────────────
  const afterReveal = sm.getSession(guildId);
  if (!isValidSession(afterReveal)) return;

  if (afterReveal.stopRequested && afterReveal.stopPhase === 'revealing') {
    await sleep(config.autoAdvanceDelayMs);
    const afterWait = sm.getSession(guildId);
    if (isValidSession(afterWait)) {
      await endSession(client, afterWait, 'stopped');
    }
    return;
  }

  // ── Auto-advance delay ───────────────────────────────────────────────
  await sleep(config.autoAdvanceDelayMs);

  const afterDelay = sm.getSession(guildId);
  if (!isValidSession(afterDelay)) return;

  if (afterDelay.stopRequested) {
    await endSession(client, afterDelay, 'stopped');
    return;
  }

  // ── Advance to next question or end ──────────────────────────────────
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

/**
 * Disable buttons and colour-code the correct/wrong answers.
 * Fails silently if the message was deleted.
 *
 * @param {import('discord.js').Message} qMsg
 * @param {object} question
 */
async function revealButtons(qMsg, question) {
  try {
    const revealRow = buildAnswerButtons(question, true, question.correctAnswer);
    await qMsg.edit({ components: [revealRow] });
  } catch {
    // Message deleted or no permission — continue anyway
  }
}

/**
 * Skip the current question immediately.
 * - No correct answer reveal.
 * - No score changes.
 * - Streak unaffected for all players.
 * - Marks question index as skipped (excluded from completion bonus calc).
 * - Advances without the 3-second delay.
 *
 * @param {import('discord.js').Client} client
 * @param {import('./sessionManager').SessionState} session
 * @param {import('discord.js').TextChannel|null} channel
 */
async function skipQuestion(client, session, channel) {
  const guildId = session.guildId;

  try {
    if (session.questionMessage) {
      const question = session.questions[session.currentIndex];
      const greyRow = new ActionRowBuilder().addComponents(
        question.options.map((opt, i) =>
          new ButtonBuilder()
            .setCustomId(`trivia_answer:${i}`)
            .setLabel(opt.substring(0, BUTTON_LABEL_MAX_CHARS))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        )
      );
      await session.questionMessage.edit({ components: [greyRow] });
    }
  } catch {
    // Silently ignore edit failures
  }

  session.skippedIndexes.add(session.currentIndex);
  sm.updateSession(guildId, {
    currentVotes: {},
    consecutiveZeroVotes: 0,
  });

  const nextIndex = session.currentIndex + 1;
  if (nextIndex >= session.questionCount) {
    await endSession(client, session, 'completed');
    return;
  }

  sm.updateSession(guildId, { currentIndex: nextIndex });

  if (!channel) {
    channel = await fetchChannel(client, session.channelId);
  }
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

/**
 * End a session for any reason.
 *
 * Execution order:
 *  1. Guard against double-end (isEnding flag).
 *  2. Clear dashboard queue.
 *  3. Disable current question buttons.
 *  4. Build scores snapshot and questions snapshot.
 *  5. ATOMIC SQLite transaction: write session_history.
 *  6. Delete session from memory.
 *  7. Fetch channel and post result message(s).
 *  8. Async post-processing: player_stats → achievements → question_stats.
 *
 * @param {import('discord.js').Client} client
 * @param {import('./sessionManager').SessionState} session
 * @param {string} reason
 */
async function endSession(client, session, reason) {
  const guildId = session.guildId;

  const current = sm.getSession(guildId);
  if (!current || current.isEnding) return;

  sm.updateSession(guildId, { isEnding: true });
  clearQueue(guildId);

  // ── Disable current question buttons ──────────────────────────────────
  try {
    if (current.questionMessage) {
      const q = current.questions[current.currentIndex];
      const row = buildAnswerButtons(q, true, q.correctAnswer);
      await current.questionMessage.edit({ components: [row] });
    }
  } catch {
    // Silently ignore
  }

  // ── Build data snapshots ─────────────────────────────────────────────
  const scoresData = Object.fromEntries(current.scores);
  const hasScores = Object.values(scoresData).some(v => v > 0);

  const questionsData = current.questions.map((q, idx) => ({
    id: q.id,
    category: q.category,
    difficulty: q.difficulty,
    correctAnswer: q.correctAnswer,
    skipped: current.skippedIndexes.has(idx),
    playerAnswers: idx === current.currentIndex ? { ...current.currentVotes } : {},
    speedWinners: idx === current.currentIndex ? [...current.speedFirstThisQuestion ?? []] : [],
  }));

  // ── Atomic SQLite archive ────────────────────────────────────────────
  try {
    runTransaction(() => {
      queries.insertSessionHistory({
        guildId,
        hostId: current.hostId,
        channelId: current.channelId,
        startedAt: current.startedAt,
        endedAt: Date.now(),
        endReason: reason,
        questionCount: current.questionCount,
        categories: current.categories,
        questionsData,
        scoresData,
      });
    });
  } catch (err) {
    console.error('[GameEngine] CRITICAL: Atomic session archive failed:', err.message);
    await logToOwner(client,
      `💥 **فشل أرشفة الجلسة** للسيرفر \`${guildId}\`\n` +
      `السبب: \`${reason}\`\nالخطأ: ${err.message}`
    );
  }

  sm.deleteSession(guildId);

  // ── Post result messages to channel ──────────────────────────────────
  const channel = await fetchChannel(client, current.channelId);

  if (reason === 'insufficient_players') {
    await channel?.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⛔ انتهت الجلسة — لاعبون غير كافيون')
          .setDescription(
            'انتهت الجلسة بسبب عدم كفاية اللاعبين.\n' +
            'يجب أن يصوّت **لاعبان على الأقل** على السؤال الأول لاستمرار الجلسة.'
          )
          .setColor(config.colors.error),
      ],
    }).catch(() => {});

  } else if (reason === 'idle') {
    await channel?.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('😴 انتهت الجلسة — عدم النشاط')
          .setDescription(
            `لم يُجب أحد على **${config.idleQuestionsThreshold}** أسئلة متتالية.\n` +
            'تم إنهاء الجلسة تلقائياً.'
          )
          .setColor(config.colors.warning),
      ],
    }).catch(() => {});

    if (hasScores) {
      await channel?.send({
        embeds: [buildResultsEmbed(current, scoresData, reason)],
      }).catch(() => {});
    }

  } else if (reason !== 'channel_lost') {
    await channel?.send({
      embeds: [buildResultsEmbed(current, scoresData, reason)],
    }).catch(() => {});
  }

  // ── Async post-processing (non-blocking) ─────────────────────────────
  setImmediate(() =>
    asyncPostProcess(client, guildId, current, scoresData, questionsData, reason)
      .catch(err => console.error('[GameEngine] asyncPostProcess error:', err.message))
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ASYNC POST-PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update player_stats and evaluate achievements after a session ends.
 * Runs asynchronously (via setImmediate) — does not block the game loop.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {import('./sessionManager').SessionState} session - snapshot at end time
 * @param {Object.<string,number>} scoresData
 * @param {object[]} questionsData
 * @param {string} reason
 */
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
      if (vote && vote.answerIndex === q.correctAnswer) {
        correctCount++;
      }
      if (q.speedWinners?.includes(userId)) {
        speedFirstCount++;
      }
    }

    const longestStreak = session.streaks?.get(userId) ?? 0;

    try {
      queries.upsertPlayerStats(guildId, userId, {
        points,
        sessions: 1,
        wins: isWin ? 1 : 0,
        answers: correctCount,
        streak: longestStreak,
        speedFirstCount,
      });
    } catch (err) {
      console.error(`[GameEngine] upsertPlayerStats failed for ${userId}:`, err.message);
    }
  }

  await evaluateAchievements(client, guildId, session, scoresData, questionsData, sorted);
}

/**
 * Check and unlock a single achievement
 * @param {object} achievements - Current achievements object
 * @param {string} achId - Achievement ID
 * @param {boolean} condition - Unlock condition
 * @param {Array} newUnlocks - Array to track new unlocks
 * @returns {boolean} True if unlocked
 */
function checkAchievement(achievements, achId, condition, newUnlocks) {
  if (!achievements[achId] && condition) {
    achievements[achId] = true;
    newUnlocks.push(achId);
    return true;
  }
  return false;
}

/**
 * Evaluate and unlock achievements for all players who participated.
 * Sends DM notifications for new unlocks.
 * Fails silently per player — one failure doesn't block the rest.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {import('./sessionManager').SessionState} session
 * @param {Object.<string,number>} scoresData
 * @param {object[]} questionsData
 * @param {[string, number][]} sortedScores - sorted [userId, score] pairs
 */
async function evaluateAchievements(client, guildId, session, scoresData, questionsData, sortedScores) {
  const achievements_defs = getAchievementDefinitions();
  const achievementMap = new Map(achievements_defs.map(a => [a.id, a]));

  for (const [userId] of Object.entries(scoresData)) {
    try {
      const stats = queries.getPlayerStats(guildId, userId);
      if (!stats) continue;

      let achievements = {};
      try {
        achievements = JSON.parse(stats.achievements ?? '{}');
      } catch {
        achievements = {};
      }

      const newUnlocks = [];
      const winCount = stats.win_count;
      const sessions = stats.session_count;
      const answers = stats.total_answers;
      const maxStreak = session.streaks?.get(userId) ?? 0;
      const totalPts = stats.total_points;

      // ── Win achievements ─────────────────────────────────────────────
      checkAchievement(achievements, 'first_win', winCount >= 1, newUnlocks);
      checkAchievement(achievements, 'win_5', winCount >= 5, newUnlocks);
      checkAchievement(achievements, 'win_10', winCount >= 10, newUnlocks);
      checkAchievement(achievements, 'win_25', winCount >= 25, newUnlocks);
      checkAchievement(achievements, 'win_50', winCount >= 50, newUnlocks);

      // ── Session count achievements ───────────────────────────────────
      checkAchievement(achievements, 'sessions_5', sessions >= 5, newUnlocks);
      checkAchievement(achievements, 'sessions_20', sessions >= 20, newUnlocks);
      checkAchievement(achievements, 'sessions_50', sessions >= 50, newUnlocks);
      checkAchievement(achievements, 'sessions_100', sessions >= 100, newUnlocks);

      // ── Answer count achievements ────────────────────────────────────
      checkAchievement(achievements, 'answers_10', answers >= 10, newUnlocks);
      checkAchievement(achievements, 'answers_50', answers >= 50, newUnlocks);
      checkAchievement(achievements, 'answers_100', answers >= 100, newUnlocks);
      checkAchievement(achievements, 'answers_250', answers >= 250, newUnlocks);
      checkAchievement(achievements, 'answers_500', answers >= 500, newUnlocks);
      checkAchievement(achievements, 'answers_1000', answers >= 1000, newUnlocks);

      // ── Points achievements ──────────────────────────────────────────
      checkAchievement(achievements, 'points_500', totalPts >= 500, newUnlocks);
      checkAchievement(achievements, 'points_2000', totalPts >= 2000, newUnlocks);
      checkAchievement(achievements, 'points_5000', totalPts >= 5000, newUnlocks);
      checkAchievement(achievements, 'points_10000', totalPts >= 10000, newUnlocks);

      // ── Streak achievements ──────────────────────────────────────────
      checkAchievement(achievements, 'streak_3', maxStreak >= 3, newUnlocks);
      checkAchievement(achievements, 'streak_5', maxStreak >= 5, newUnlocks);
      checkAchievement(achievements, 'streak_10', maxStreak >= 10, newUnlocks);
      checkAchievement(achievements, 'streak_15', maxStreak >= 15, newUnlocks);
      checkAchievement(achievements, 'streak_20', maxStreak >= 20, newUnlocks);

      // ── Perfect session ──────────────────────────────────────────────
      if (!achievements.perfect_session) {
        const nonSkipped = questionsData.filter(q => !q.skipped);
        const allCorrect = nonSkipped.length > 0 && nonSkipped.every(q =>
          q.playerAnswers?.[userId]?.answerIndex === q.correctAnswer
        );
        checkAchievement(achievements, 'perfect_session', allCorrect, newUnlocks);
      }

      // ── First answer (ever) ──────────────────────────────────────────
      checkAchievement(achievements, 'first_answer', answers >= 1, newUnlocks);

      // ── Time-based: night owl / early bird ───────────────────────────
      const sessionHour = new Date(session.startedAt).getUTCHours();
      checkAchievement(achievements, 'night_owl', sessionHour >= 0 && sessionHour < 4, newUnlocks);
      checkAchievement(achievements, 'early_bird', sessionHour >= 4 && sessionHour < 6, newUnlocks);

      // ── Persist new achievements ─────────────────────────────────────
      if (newUnlocks.length > 0) {
        queries.setPlayerAchievements(guildId, userId, JSON.stringify(achievements));

        for (const achId of newUnlocks) {
          const achDef = achievementMap.get(achId);
          if (!achDef) continue;

          try {
            const user = await client.users.fetch(userId);
            await user.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle('🏅 إنجاز جديد مفتوح!')
                  .setDescription(`**${achDef.nameAr}**\n${achDef.descriptionAr}`)
                  .setColor(config.colors.success)
                  .setTimestamp(),
              ],
            });
          } catch {
            // DMs disabled — silently skip
          }
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

/**
 * Handle loss of access to the session channel mid-session.
 *
 * Fallback chain:
 *  1. End the session (archives to SQLite).
 *  2. Try backup channel.
 *  3. Try DM to host.
 *  4. Log to owner channel regardless.
 *
 * @param {import('discord.js').Client} client
 * @param {import('./sessionManager').SessionState} session
 */
async function handleChannelLoss(client, session) {
  const guildId = session.guildId;
  const settings = queries.getGuildSettings(guildId);
  const backupId = settings?.backup_channel;
  const hostId = session.hostId;

  if (!session.isEnding) {
    await endSession(client, session, 'channel_lost');
  }

  const errorMsg = {
    embeds: [
      new EmbedBuilder()
        .setTitle('📵 انتهت الجلسة — فُقد الوصول للقناة')
        .setDescription(
          'فقد البوت صلاحية الإرسال في قناة الجلسة.\n' +
          'تم حفظ النتائج وإنهاء الجلسة تلقائياً.'
        )
        .setColor(config.colors.error),
    ],
  };

  // Try backup channel
  if (backupId) {
    try {
      const backup = await client.channels.fetch(backupId);
      if (backup?.isTextBased()) {
        await backup.send(errorMsg);
        await logToOwner(client, `⚠️ [${guildId}] Channel loss — notified backup channel <#${backupId}>.`);
        return;
      }
    } catch {
      // Backup channel fetch failed
    }
  }

  // Try DM to host
  try {
    const host = await client.users.fetch(hostId);
    await host.send(errorMsg);
    await logToOwner(client, `⚠️ [${guildId}] Channel loss — DMed host <@${hostId}>.`);
    return;
  } catch {
    // DM failed
  }

  // All fallbacks failed
  await logToOwner(client,
    `⚠️ **[${guildId}] Channel loss — all fallbacks failed.** ` +
    `No backup channel, host DMs closed.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch a text channel by ID. Returns null on any error.
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @returns {Promise<import('discord.js').TextChannel|null>}
 */
async function fetchChannel(client, channelId) {
  if (!client || !channelId) return null;
  try {
    return await client.channels.fetch(channelId);
  } catch {
    return null;
  }
}

/**
 * Async sleep.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Session lifecycle
  startSession,
  skipQuestion,
  endSession,

  // Embed builders (used by leaderboard, profile, scheduler)
  buildResultsEmbed,
  buildDashboardEmbed,

  // Owner log (used by cache.js, index.js, events)
  logToOwner,
};
