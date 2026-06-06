'use strict';
/**
 * utils/sessionManager.js
 *
 * In-memory session state, scoped per guild ID.
 * Enforces the hard limit of ONE active session per guild at any time.
 *
 * All state is stored here — gameEngine.js reads and mutates through
 * these helpers only. No direct Map access from outside this module.
 *
 * ─── Session lifecycle ───────────────────────────────────────────────────────
 *
 *  createSession()   → session added to Map
 *       │
 *  postQuestion()    → updateSession({ questionMessage, currentVotes: {} })
 *  collectVotes()    → ensurePlayer(), direct mutation of currentVotes
 *  revealAndAdvance()→ updateStreak(), addPoints(), updateSession({ history })
 *       │
 *  endSession()      → updateSession({ isEnding: true }) → deleteSession()
 *
 * ─── Mid-session join handling ───────────────────────────────────────────────
 *
 *  ensurePlayer() is called on every button press.
 *  If userId is new: joinIndex is set to currentIndex,
 *  scores/streaks initialised to 0.
 *  Reconnecting players retain their previous state (scores, streaks, joinIndex) 
 *  to preserve their completion bonus and progress.
 *
 * ─── Completion bonus tracking ───────────────────────────────────────────────
 *
 *  answeredSinceJoin: Map<userId, Set<questionIndex>>
 *  skippedIndexes:    Set<questionIndex>
 *
 *  hasCompletionBonus() returns true if the player answered every
 *  non-skipped question from their joinIndex to currentIndex (inclusive).
 */

/** @type {Map<string, SessionState>} */
const sessions = new Map();

/**
 * @typedef {object} SessionState
 * @property {string}   guildId
 * @property {string}   hostId
 * @property {string}   channelId
 * @property {number}   startedAt              - Unix ms
 * @property {string[]} categories
 * @property {number}   questionCount
 * @property {number}   timeLimitSec
 * @property {object[]} questions              - full shuffled question list
 * @property {number}   currentIndex           - 0-based question pointer
 * @property {Set<string>} usedQuestionIds
 * @property {Map<string,number>}  scores       - userId → accumulated points
 * @property {Map<string,number>}  streaks      - userId → current streak count
 * @property {Map<string,number>}  joinIndex    - userId → question index on join
 * @property {Map<string,Set<number>>} answeredSinceJoin - userId → Set of answered qIndexes
 * @property {Set<number>}  skippedIndexes     - question indexes that were skipped
 * @property {Array<object>} history           - Array of past question results { questionId, correctAnswer, votes, speedWinners }
 * @property {Object.<string,{answerIndex:number,timestampMs:number}>} currentVotes
 * @property {number}   consecutiveZeroVotes
 * @property {boolean}  stopRequested
 * @property {string|null} stopPhase           - 'voting' | 'revealing' | null
 * @property {object|null} questionMessage     - Discord Message for current question
 * @property {object|null} dashboardMessage    - Discord Message for dashboard
 * @property {boolean}  isEnding              - guard against double-end race
 */

// ═══════════════════════════════════════════════════════════════════════════
// CORE CRUD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a guild has an active session.
 * @param {string} guildId
 * @returns {boolean}
 */
function hasSession(guildId) {
  return sessions.has(guildId);
}

/**
 * Get the active session for a guild, or null.
 * @param {string} guildId
 * @returns {SessionState|null}
 */
function getSession(guildId) {
  return sessions.get(guildId) ?? null;
}

/**
 * Create a new session for a guild.
 * Returns false if a session already exists (prevents double-start).
 *
 * @param {string} guildId
 * @param {{
 *   hostId: string,
 *   channelId: string,
 *   categories: string[],
 *   questionCount: number,
 *   timeLimitSec: number,
 *   questions: object[]
 * }} data
 * @returns {boolean} true if created, false if already exists
 */
function createSession(guildId, data) {
  if (sessions.has(guildId)) return false;

  /** @type {SessionState} */
  const state = {
    guildId,
    hostId:                data.hostId,
    channelId:             data.channelId,
    startedAt:             Date.now(),
    categories:            data.categories,
    questionCount:         data.questionCount,
    timeLimitSec:          data.timeLimitSec,
    questions:             data.questions,
    currentIndex:          0,
    usedQuestionIds:       new Set(data.questions.map(q => q.id)),
    scores:                new Map(),
    streaks:               new Map(),
    joinIndex:             new Map(),
    answeredSinceJoin:     new Map(),
    skippedIndexes:        new Set(),
    history:               [],
    currentVotes:          {},
    consecutiveZeroVotes:  0,
    stopRequested:         false,
    stopPhase:             null,
    questionMessage:       null,
    dashboardMessage:      null,
    isEnding:              false,
  };

  sessions.set(guildId, state);
  return true;
}

/**
 * Merge fields into an existing session.
 * Only updates the fields provided — all other state preserved.
 *
 * @param {string} guildId
 * @param {Partial<SessionState>} fields
 */
function updateSession(guildId, fields) {
  const s = sessions.get(guildId);
  if (!s) return;
  Object.assign(s, fields);
}

/**
 * Delete a session from memory.
 * Called by endSession() after archiving to SQLite.
 *
 * @param {string} guildId
 */
function deleteSession(guildId) {
  sessions.delete(guildId);
}

/**
 * Return a snapshot array of all active sessions.
 * Used by emergencyShutdown() to end all sessions on crash.
 *
 * @returns {SessionState[]}
 */
function getAllActiveSessions() {
  return [...sessions.values()];
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAYER STATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialise or re-initialise a player's state for the current session.
 *
 * Called on every button press before recording the vote.
 * If the player is new: sets joinIndex to currentIndex, zeroes scores/streaks.
 * If the player is already in the session: does nothing (preserves state).
 *
 * @param {string} guildId
 * @param {string} userId
 */
function ensurePlayer(guildId, userId) {
  const s = sessions.get(guildId);
  if (!s) return;

  const isNew = !s.scores.has(userId);

  if (isNew) {
    // First-time join
    s.scores.set(userId, 0);
    s.streaks.set(userId, 0);
    s.joinIndex.set(userId, s.currentIndex);
    s.answeredSinceJoin.set(userId, new Set());
  }
  // Note: we intentionally do NOT reset joinIndex on re-vote or reconnect.
  // joinIndex is only set once: on the player's very first vote in the session.
  // This ensures players don't lose their completion bonus if they disconnect briefly.
}

/**
 * Add points to a player's session score.
 * Initialises the player if needed.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} pts - may be fractional (speed tie splits)
 */
function addPoints(guildId, userId, pts) {
  const s = sessions.get(guildId);
  if (!s) return;
  ensurePlayer(guildId, userId);
  s.scores.set(userId, (s.scores.get(userId) ?? 0) + pts);
}

/**
 * Update a player's streak counter.
 * Correct answer → increments streak.
 * Wrong answer   → resets streak to 0.
 * Skipped question → does NOT call updateStreak (streak unaffected).
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {boolean} correct
 * @returns {number} new streak count (after update)
 */
function updateStreak(guildId, userId, correct) {
  const s = sessions.get(guildId);
  if (!s) return 0;
  ensurePlayer(guildId, userId);

  if (correct) {
    const newStreak = (s.streaks.get(userId) ?? 0) + 1;
    s.streaks.set(userId, newStreak);
    return newStreak;
  } else {
    s.streaks.set(userId, 0);
    return 0;
  }
}

/**
 * Record that a player answered the current question.
 * Used for completion bonus tracking.
 *
 * Must be called AFTER ensurePlayer() for the userId.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} questionIndex
 */
function markAnswered(guildId, userId, questionIndex) {
  const s = sessions.get(guildId);
  if (!s) return;
  const set = s.answeredSinceJoin.get(userId);
  if (set) set.add(questionIndex);
}

/**
 * Check if a player qualifies for the session completion bonus.
 *
 * A player qualifies if they answered every non-skipped question
 * from their joinIndex up to and including currentIndex.
 *
 * @param {string} guildId
 * @param {string} userId
 * @returns {boolean}
 */
function hasCompletionBonus(guildId, userId) {
  const s = sessions.get(guildId);
  if (!s) return false;

  const joinIdx  = s.joinIndex.get(userId) ?? 0;
  const answered = s.answeredSinceJoin.get(userId) ?? new Set();

  for (let i = joinIdx; i <= s.currentIndex; i++) {
    if (s.skippedIndexes.has(i)) continue; // skipped questions don't count
    if (!answered.has(i)) return false;
  }

  return true;
}

/**
 * Get the current session score for a player (0 if not present).
 * @param {string} guildId
 * @param {string} userId
 * @returns {number}
 */
function getPlayerScore(guildId, userId) {
  return sessions.get(guildId)?.scores.get(userId) ?? 0;
}

/**
 * Get the current streak for a player (0 if not present).
 * @param {string} guildId
 * @param {string} userId
 * @returns {number}
 */
function getPlayerStreak(guildId, userId) {
  return sessions.get(guildId)?.streaks.get(userId) ?? 0;
}

/**
 * Get a sorted snapshot of all scores in the session.
 * Returns array of [userId, score] pairs, highest score first.
 *
 * @param {string} guildId
 * @returns {[string, number][]}
 */
function getSortedScores(guildId) {
  const s = sessions.get(guildId);
  if (!s) return [];
  return [...s.scores.entries()].sort((a, b) => b[1] - a[1]);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Core CRUD
  hasSession,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  getAllActiveSessions,

  // Player state
  ensurePlayer,
  addPoints,
  updateStreak,
  markAnswered,
  hasCompletionBonus,
  getPlayerScore,
  getPlayerStreak,
  getSortedScores,
};
