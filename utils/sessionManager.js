'use strict';
/**
 * utils/sessionManager.js
 *
 * In-memory session state, scoped per guild ID.
 */

/** @type {Map<string, SessionState>} */
const sessions = new Map();

/**
 * @typedef {object} SessionState
 * @property {string}   guildId
 * @property {string}   hostId
 * @property {string}   channelId
 * @property {number}   startedAt
 * @property {string[]} categories
 * @property {number}   questionCount
 * @property {number}   timeLimitSec
 * @property {object[]} questions
 * @property {number}   currentIndex
 * @property {Set<string>} usedQuestionIds
 * @property {Map<string,number>}  scores
 * @property {Map<string,number>}  streaks
 * @property {Map<string,number>}  joinIndex
 * @property {Map<string,Set<number>>} answeredSinceJoin
 * @property {Set<number>}  skippedIndexes
 * @property {Array<object>} history
 * @property {Object.<string,{answerIndex:number,timestampMs:number}>} currentVotes
 * @property {number}   consecutiveZeroVotes
 * @property {boolean}  stopRequested
 * @property {string|null} stopPhase
 * @property {object|null} questionMessage
 * @property {object|null} dashboardMessage
 * @property {boolean}  isEnding
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CORE CRUD
// ═══════════════════════════════════════════════════════════════════════════════

function hasSession(guildId) {
  return sessions.has(guildId);
}

function getSession(guildId) {
  return sessions.get(guildId) ?? null;
}

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

function updateSession(guildId, fields) {
  const s = sessions.get(guildId);
  if (!s) return;
  Object.assign(s, fields);
}

function deleteSession(guildId) {
  sessions.delete(guildId);
}

function getAllActiveSessions() {
  return [...sessions.values()];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYER STATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function ensurePlayer(guildId, userId) {
  const s = sessions.get(guildId);
  if (!s) return;

  const isNew = !s.scores.has(userId);

  if (isNew) {
    s.scores.set(userId, 0);
    s.streaks.set(userId, 0);
    s.joinIndex.set(userId, s.currentIndex);
    s.answeredSinceJoin.set(userId, new Set());
  }
}

function addPoints(guildId, userId, pts) {
  const s = sessions.get(guildId);
  if (!s) return;
  ensurePlayer(guildId, userId);
  s.scores.set(userId, (s.scores.get(userId) ?? 0) + pts);
}

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

function markAnswered(guildId, userId, questionIndex) {
  const s = sessions.get(guildId);
  if (!s) return;
  const set = s.answeredSinceJoin.get(userId);
  if (set) set.add(questionIndex);
}

function hasCompletionBonus(guildId, userId) {
  const s = sessions.get(guildId);
  if (!s) return false;

  const joinIdx  = s.joinIndex.get(userId) ?? 0;
  const answered = s.answeredSinceJoin.get(userId) ?? new Set();

  for (let i = joinIdx; i <= s.currentIndex; i++) {
    if (s.skippedIndexes.has(i)) continue; 
    if (!answered.has(i)) return false;
  }

  return true;
}

function getPlayerScore(guildId, userId) {
  return sessions.get(guildId)?.scores.get(userId) ?? 0;
}

function getPlayerStreak(guildId, userId) {
  return sessions.get(guildId)?.streaks.get(userId) ?? 0;
}

function getSortedScores(guildId) {
  const s = sessions.get(guildId);
  if (!s) return [];
  return [...s.scores.entries()].sort((a, b) => b[1] - a[1]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  hasSession,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  getAllActiveSessions,
  ensurePlayer,
  addPoints,
  updateStreak,
  markAnswered,
  hasCompletionBonus,
  getPlayerScore,
  getPlayerStreak,
  getSortedScores,
};
