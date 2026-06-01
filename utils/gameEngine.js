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
  } catch {
    // Swallow all errors — log channel issues must not crash the bot
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
  const sorted    = sm.getSortedScores(session.guildId);

  // Build top entries with tie-aware rank extension
  const topEntries = [];
  let rank      = 1;
  let prevScore = null;

  for (let i = 0; i < sorted.length; i++) {
    const [userId, score] = sorted[i];

    // Assign rank: same score = same rank
    if (prevScore !== null && score !== prevScore) {
      rank = topEntries.length + 1;
    }

    // Stop if rank > 5 AND this score is different from the last shown
    if (rank > 5 && (prevScore === null || score !== prevScore)) break;

    topEntries.push({ userId, score, rank });
    prevScore = score;
  }

  const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

  const rankLines = topEntries.map(e => {
    const medal = rankEmojis[e.rank - 1] ?? `**${e.rank}.**`;
    const pts   = Number.isInteger(e.score) ? e.score : e.score.toFixed(1);
    return `${medal} <@${e.userId}> — **${pts}** نقطة`;
  });

  return new EmbedBuilder()
    .setTitle(`📊 لوحة الجلسة — السؤال ${session.currentIndex + 1} من ${session.questionCount}`)
    .setColor(config.colors.info)
    .addFields(
      {
        name:   '🗳️ الأصوات',
        value:  voteCount === 0 ? 'لم يصوّت أحد بعد' : `${voteCount} لاعب صوّت`,
        inline: true,
      },
      {
        name:   '🏆 المتصدرون',
        value:  rankLines.length ? rankLines.join('\n') : 'لا يوجد نقاط بعد',
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
  const diff    = DIFF_NAMES[question.difficulty] ?? question.difficulty;

  const embed = new EmbedBuilder()
    .setTitle(`❓ السؤال ${session.currentIndex + 1} من ${session.questionCount}`)
    .setDescription(question.text)
    .setColor(config.colors.info)
    .addFields(
      { name: '📂 الفئة',    value: catName, inline: true },
      { name: '⚡ الصعوبة', value: diff,    inline: true },
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

  const medals  = ['🥇', '🥈', '🥉'];
  const podium  = [];
  const rest    = [];
  let lastScore = null;
  let lastRank  = 0;
  let position  = 0;

  for (const [userId, score] of sorted) {
    position++;
    if (lastScore !== score) lastRank = position;

    const pts   = Number.isInteger(score) ? score : score.toFixed(1);
    const entry = `**${lastRank}.** <@${userId}> — **${pts}** نقطة`;

    if (lastRank <= 3) {
      podium.push(`${medals[lastRank - 1]} ${entry}`);
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
    // Discord field value limit: 1024 chars — split if needed
    const chunks = [];
    let chunk    = [];
    let len      = 0;
    for (const line of rest.slice(0, 50)) {
      if (len + line.length + 1 > 1000) {
        chunks.push(chunk.join('\n'));
        chunk = [];
        len   = 0;
      }
      chunk.push(line);
      len += line.length + 1;
    }
    if (chunk.length) chunks.push(chunk.join('\n'));

    for (let i = 0; i < chunks.length; i++) {
      embed.addFields({
        name:  i === 0 ? '📋 بقية الترتيب' : '​', // zero-width space for continuation
        value: chunks[i],
      });
    }
  }

  return embed;
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
      .setLabel(opt.substring(0, 80)) // Discord button label max = 80 chars
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
    await s.dashboardMessage.edit({ embeds: [buildDashboardEmbed(s)] });
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
  // Post dashboard first so it appears above the question
  try {
    const dashMsg = await channel.send({ embeds: [buildDashboardEmbed(session)] });
    sm.updateSession(session.guildId, { dashboardMessage: dashMsg });
  } catch (err) {
    console.error('[GameEngine] Failed to post dashboard:', err.message);
    // Non-fatal — proceed without dashboard
  }

  // Fetch the latest session state (may have changed during await)
  const latestSession = sm.getSession(session.guildId);
  if (!latestSession) return; // was killed in the meantime

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
  const guildId  = session.guildId;
  const question = session.questions[session.currentIndex];

  // Clear votes for the new question
  sm.updateSession(guildId, { currentVotes: {}, stopPhase: 'voting' });

  const embed = buildQuestionEmbed(session, question);
  const row   = buildAnswerButtons(question);

  let qMsg;
  try {
    qMsg = await channel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('[GameEngine] Failed to post question:', err.message);
    // Attempt channel loss recovery
    const currentSession = sm.getSession(guildId);
    if (currentSession && !currentSession.isEnding) {
      await handleChannelLoss(client, currentSession);
    }
    return;
  }

  sm.updateSession(guildId, { questionMessage: qMsg });

  // Begin vote collection
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
  const session     = sm.getSession(guildId);
  if (!session) return;

  const timeLimitMs = session.timeLimitSec * 1000;

  const collector = qMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time:          timeLimitMs,
  });

  collector.on('collect', async (interaction) => {
    // Always defer immediately — Discord gives 3 seconds before timeout
    await interaction.deferReply({ ephemeral: true });

    const currentSession = sm.getSession(guildId);
    if (!currentSession || currentSession.isEnding) return;

    const userId = interaction.user.id;

    // Reject double votes
    if (currentSession.currentVotes[userId]) {
      await interaction.editReply({
        content: '⚠️ لقد أجبت بالفعل على هذا السؤال — لا يمكن تغيير الإجابة.',
      });
      return;
    }

    const answerIndex = parseInt(interaction.customId.split(':')[1], 10);
    const now         = Date.now();

    // Initialise player if first action in session
    sm.ensurePlayer(guildId, userId);

    // Record the vote
    currentSession.currentVotes[userId] = { answerIndex, timestampMs: now };

    // Track for completion bonus
    sm.markAnswered(guildId, userId, currentSession.currentIndex);

    await interaction.editReply({ content: '✅ تم تسجيل إجابتك!' });
  });

  collector.on('end', async (_, reason) => {
    // 'time' = timer expired naturally — process results
    // 'messageDelete' / other = question message gone, skip gracefully
    const currentSession = sm.getSession(guildId);
    if (!currentSession || currentSession.isEnding) return;

    await revealAndAdvance(client, currentSession, qMsg, question);
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
  const guildId   = session.guildId;
  const votes     = session.currentVotes;
  const voteCount = Object.keys(votes).length;

  // ── Minimum player check (question 1 only) ──────────────────────────────
  if (session.currentIndex === 0) {
    const uniqueVoters = Object.keys(votes).length;
    if (uniqueVoters < 2) {
      await endSession(client, session, 'insufficient_players');
      return;
    }
  }

  // ── Idle detection ────────────────────────────────────────────────────────
  const newZeroCount = voteCount === 0
    ? session.consecutiveZeroVotes + 1
    : 0;

  sm.updateSession(guildId, {
    consecutiveZeroVotes: newZeroCount,
    stopPhase:            'revealing',
  });

  if (newZeroCount >= config.idleQuestionsThreshold) {
    // Reveal first, then end — so players see the answer
    await revealButtons(qMsg, question);
    await endSession(client, session, 'idle');
    return;
  }

  // ── Reveal answer buttons ─────────────────────────────────────────────────
  await revealButtons(qMsg, question);

  // ── Score calculation ─────────────────────────────────────────────────────
  const correctVotes = Object.entries(votes)
    .filter(([, v]) => v.answerIndex === question.correctAnswer)
    .map(([userId, v]) => ({ userId, timestampMs: v.timestampMs }));

  const speedRanks = assignSpeedRanks(correctVotes);
  const isLastQ    = session.currentIndex === session.questionCount - 1;

  // Track which players ranked 1st in speed this question
  const speedFirstThisQuestion = new Set();

  for (const [userId, vote] of Object.entries(votes)) {
    const isCorrect = vote.answerIndex === question.correctAnswer;
    const streak    = sm.updateStreak(guildId, userId, isCorrect);

    if (!isCorrect) continue;

    const rankInfo       = speedRanks.get(userId) ?? { rank: 0, tieCount: 1 };
    const completionEarned = isLastQ && sm.hasCompletionBonus(guildId, userId);

    const { finalScore } = calculateScore({
      difficulty:       question.difficulty,
      streakCount:      streak,
      speedRank:        rankInfo.rank,
      speedTieCount:    rankInfo.tieCount,
      isLastQuestion:   isLastQ,
      completionEarned,
    });

    sm.addPoints(guildId, userId, finalScore);

    if (rankInfo.rank === 1) {
      speedFirstThisQuestion.add(userId);
    }
  }

  // Reset streaks for wrong answerers (already done in updateStreak)
  // Ensure players who didn't vote also get streak reset
  for (const userId of [...session.scores.keys()]) {
    if (!votes[userId]) {
      sm.updateStreak(guildId, userId, false);
    }
  }

  // ── Update question_stats (async, non-blocking) ───────────────────────────
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

  // ── Dashboard update (once, after reveal) ─────────────────────────────────
  scheduleDashboardUpdate(guildId);

  // ── Stop-during-reveal check ──────────────────────────────────────────────
  const afterReveal = sm.getSession(guildId);
  if (!afterReveal || afterReveal.isEnding) return;

  if (afterReveal.stopRequested && afterReveal.stopPhase === 'revealing') {
    // Let the reveal finish (already shown), then stop
    await sleep(config.autoAdvanceDelayMs);
    const afterWait = sm.getSession(guildId);
    if (afterWait && !afterWait.isEnding) {
      await endSession(client, afterWait, 'stopped');
    }
    return;
  }

  // ── Auto-advance delay ────────────────────────────────────────────────────
  await sleep(config.autoAdvanceDelayMs);

  const afterDelay = sm.getSession(guildId);
  if (!afterDelay || afterDelay.isEnding) return;

  // Stop requested during delay
  if (afterDelay.stopRequested) {
    await endSession(client, afterDelay, 'stopped');
    return;
  }

  // ── Advance to next question or end ───────────────────────────────────────
  const nextIndex = afterDelay.currentIndex + 1;
  if (nextIndex >= afterDelay.questionCount) {
    await endSession(client, afterDelay, 'completed');
    return;
  }

  sm.updateSession(guildId, { currentIndex: nextIndex });

  const channel = await fetchChannel(client, afterDelay.channelId);
  if (!channel) {
    const latest = sm.getSession(guildId);
    if (latest && !latest.isEnding) await handleChannelLoss(client, latest);
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

  // Disable the current question's buttons (no colour reveal)
  try {
    if (session.questionMessage) {
      const question    = session.questions[session.currentIndex];
      const disabledRow = buildAnswerButtons(question, true, null);
      // Override all to Secondary (grey) to indicate skip
      const greyRow = new ActionRowBuilder().addComponents(
        question.options.map((opt, i) =>
          new ButtonBuilder()
            .setCustomId(`trivia_answer:${i}`)
            .setLabel(opt.substring(0, 80))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        )
      );
      await session.questionMessage.edit({ components: [greyRow] });
    }
  } catch {}

  // Mark as skipped
  session.skippedIndexes.add(session.currentIndex);
  sm.updateSession(guildId, {
    currentVotes:         {},
    consecutiveZeroVotes: 0, // skips don't count toward idle threshold
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
    if (latest && !latest.isEnding) await handleChannelLoss(client, latest);
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

  // Re-read from Map in case it was updated since the caller's reference
  const current = sm.getSession(guildId);
  if (!current || current.isEnding) return;

  // Set guard immediately — prevents any concurrent endSession call
  sm.updateSession(guildId, { isEnding: true });
  clearQueue(guildId);

  // ── Disable current question buttons ────────────────────────────────────
  try {
    if (current.questionMessage) {
      const q   = current.questions[current.currentIndex];
      const row = buildAnswerButtons(q, true, q.correctAnswer);
      await current.questionMessage.edit({ components: [row] });
    }
  } catch {}

  // ── Build data snapshots ─────────────────────────────────────────────────
  const scoresData = Object.fromEntries(current.scores);
  const hasScores  = Object.values(scoresData).some(v => v > 0);

  // Snapshot each question with per-player vote data
  const questionsData = current.questions.map((q, idx) => ({
    id:            q.id,
    category:      q.category,
    difficulty:    q.difficulty,
    correctAnswer: q.correctAnswer,
    skipped:       current.skippedIndexes.has(idx),
    // Store all votes for this question as recorded at session end
    playerAnswers: idx === current.currentIndex
      ? { ...current.currentVotes }
      : {},
  }));

  // ── Atomic SQLite archive ────────────────────────────────────────────────
  try {
    runTransaction(() => {
      queries.insertSessionHistory({
        guildId,
        hostId:        current.hostId,
        channelId:     current.channelId,
        startedAt:     current.startedAt,
        endedAt:       Date.now(),
        endReason:     reason,
        questionCount: current.questionCount,
        categories:    current.categories,
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
    // Continue — we still need to clear memory and notify the channel
  }

  // ── Clear from memory (before posting results to avoid state leaks) ──────
  sm.deleteSession(guildId);

  // ── Post result messages to channel ─────────────────────────────────────
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

    // Show results only if at least one player scored
    if (hasScores) {
      await channel?.send({
        embeds: [buildResultsEmbed(current, scoresData, reason)],
      }).catch(() => {});
    }

  } else if (reason === 'channel_lost') {
    // Results already attempted via backup/DM in handleChannelLoss
    // Don't try the main channel again

  } else {
    // completed | stopped | crash | scheduled_override
    await channel?.send({
      embeds: [buildResultsEmbed(current, scoresData, reason)],
    }).catch(() => {});
  }

  // ── Async post-processing (non-blocking) ─────────────────────────────────
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
  const sorted   = Object.entries(scoresData).sort((a, b) => b[1] - a[1]);
  const winnerId = sorted[0]?.[1] > 0 ? sorted[0]?.[0] : null;

  for (const [userId, points] of Object.entries(scoresData)) {
    if (points < 0) continue; // sanity guard

    const isWin = userId === winnerId;

    // Count correct answers this session for this player
    let correctCount   = 0;
    let speedFirstCount = 0;

    for (const q of questionsData) {
      if (q.skipped) continue;
      const vote = q.playerAnswers?.[userId];
      if (vote && vote.answerIndex === q.correctAnswer) {
        correctCount++;
      }
    }

    // Speed-first count is approximated from in-session data
    // (exact per-question speed rank not stored in questionsData — this is for achievement tracking)

    const longestStreak = session.streaks?.get(userId) ?? 0;

    try {
      queries.upsertPlayerStats(guildId, userId, {
        points,
        sessions:        1,
        wins:            isWin ? 1 : 0,
        answers:         correctCount,
        streak:          longestStreak,
        speedFirstCount: 0, // tracked separately via question_stats if needed
      });
    } catch (err) {
      console.error(`[GameEngine] upsertPlayerStats failed for ${userId}:`, err.message);
    }
  }

  // Evaluate achievements for all participants
  await evaluateAchievements(client, guildId, session, scoresData, questionsData, sorted);
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
  for (const [userId] of Object.entries(scoresData)) {
    try {
      const stats = queries.getPlayerStats(guildId, userId);
      if (!stats) continue;

      let achievements = {};
      try { achievements = JSON.parse(stats.achievements ?? '{}'); } catch {}

      const newUnlocks = [];
      const winCount   = stats.win_count;
      const sessions   = stats.session_count;
      const answers    = stats.total_answers;
      const maxStreak  = session.streaks?.get(userId) ?? 0;

      // ── Win achievements ───────────────────────────────────────────────
      if (!achievements.first_win  && winCount >= 1)  { achievements.first_win  = true; newUnlocks.push('first_win'); }
      if (!achievements.win_5      && winCount >= 5)  { achievements.win_5      = true; newUnlocks.push('win_5'); }
      if (!achievements.win_10     && winCount >= 10) { achievements.win_10     = true; newUnlocks.push('win_10'); }
      if (!achievements.win_25     && winCount >= 25) { achievements.win_25     = true; newUnlocks.push('win_25'); }
      if (!achievements.win_50     && winCount >= 50) { achievements.win_50     = true; newUnlocks.push('win_50'); }

      // ── Session count achievements ─────────────────────────────────────
      if (!achievements.sessions_5   && sessions >= 5)   { achievements.sessions_5   = true; newUnlocks.push('sessions_5'); }
      if (!achievements.sessions_20  && sessions >= 20)  { achievements.sessions_20  = true; newUnlocks.push('sessions_20'); }
      if (!achievements.sessions_50  && sessions >= 50)  { achievements.sessions_50  = true; newUnlocks.push('sessions_50'); }
      if (!achievements.sessions_100 && sessions >= 100) { achievements.sessions_100 = true; newUnlocks.push('sessions_100'); }

      // ── Answer count achievements ──────────────────────────────────────
      if (!achievements.answers_10   && answers >= 10)   { achievements.answers_10   = true; newUnlocks.push('answers_10'); }
      if (!achievements.answers_50   && answers >= 50)   { achievements.answers_50   = true; newUnlocks.push('answers_50'); }
      if (!achievements.answers_100  && answers >= 100)  { achievements.answers_100  = true; newUnlocks.push('answers_100'); }
      if (!achievements.answers_250  && answers >= 250)  { achievements.answers_250  = true; newUnlocks.push('answers_250'); }
      if (!achievements.answers_500  && answers >= 500)  { achievements.answers_500  = true; newUnlocks.push('answers_500'); }
      if (!achievements.answers_1000 && answers >= 1000) { achievements.answers_1000 = true; newUnlocks.push('answers_1000'); }

      // ── Points achievements ────────────────────────────────────────────
      const totalPts = stats.total_points;
      if (!achievements.points_500   && totalPts >= 500)   { achievements.points_500   = true; newUnlocks.push('points_500'); }
      if (!achievements.points_2000  && totalPts >= 2000)  { achievements.points_2000  = true; newUnlocks.push('points_2000'); }
      if (!achievements.points_5000  && totalPts >= 5000)  { achievements.points_5000  = true; newUnlocks.push('points_5000'); }
      if (!achievements.points_10000 && totalPts >= 10000) { achievements.points_10000 = true; newUnlocks.push('points_10000'); }

      // ── Streak achievements (in-session streak) ────────────────────────
      if (!achievements.streak_3  && maxStreak >= 3)  { achievements.streak_3  = true; newUnlocks.push('streak_3'); }
      if (!achievements.streak_5  && maxStreak >= 5)  { achievements.streak_5  = true; newUnlocks.push('streak_5'); }
      if (!achievements.streak_10 && maxStreak >= 10) { achievements.streak_10 = true; newUnlocks.push('streak_10'); }
      if (!achievements.streak_15 && maxStreak >= 15) { achievements.streak_15 = true; newUnlocks.push('streak_15'); }
      if (!achievements.streak_20 && maxStreak >= 20) { achievements.streak_20 = true; newUnlocks.push('streak_20'); }

      // ── Perfect session ────────────────────────────────────────────────
      if (!achievements.perfect_session) {
        const nonSkipped = questionsData.filter(q => !q.skipped);
        const allCorrect = nonSkipped.length > 0 && nonSkipped.every(q =>
          q.playerAnswers?.[userId]?.answerIndex === q.correctAnswer
        );
        if (allCorrect) {
          achievements.perfect_session = true;
          newUnlocks.push('perfect_session');
        }
      }

      // ── First answer (ever) ────────────────────────────────────────────
      if (!achievements.first_answer && answers >= 1) {
        achievements.first_answer = true;
        newUnlocks.push('first_answer');
      }

      // ── Time-based: night owl / early bird ────────────────────────────
      const sessionHour = new Date(session.startedAt).getUTCHours();
      if (!achievements.night_owl && sessionHour >= 0 && sessionHour < 4) {
        achievements.night_owl = true;
        newUnlocks.push('night_owl');
      }
      if (!achievements.early_bird && sessionHour >= 4 && sessionHour < 6) {
        achievements.early_bird = true;
        newUnlocks.push('early_bird');
      }

      // ── Persist new achievements ───────────────────────────────────────
      if (newUnlocks.length > 0) {
        queries.setPlayerAchievements(guildId, userId, JSON.stringify(achievements));

        // DM each new achievement — skip silently if DMs closed
        for (const achId of newUnlocks) {
          const achDef = config.achievements.find(a => a.id === achId);
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
            // DMs disabled — silently skip (no fallback to channel)
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
  const guildId      = session.guildId;
  const settings     = queries.getGuildSettings(guildId);
  const backupId     = settings?.backup_channel;
  const hostId       = session.hostId;

  // Archive and end the session first
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
    } catch {}
  }

  // Try DM to host
  try {
    const host = await client.users.fetch(hostId);
    await host.send(errorMsg);
    await logToOwner(client, `⚠️ [${guildId}] Channel loss — DMed host <@${hostId}>.`);
    return;
  } catch {}

  // All fallbacks failed — log only
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
