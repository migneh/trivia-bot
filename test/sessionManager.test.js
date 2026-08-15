'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

const sm = require('../utils/sessionManager');

const GUILD = 'guild_test_1';

function makeSession(questionCount = 3) {
  return {
    hostId: 'host_1',
    channelId: 'channel_1',
    categories: ['general'],
    questionCount,
    timeLimitSec: 10,
    questions: Array.from({ length: questionCount }, (_, i) => ({
      id: `q_${i}`,
      category: 'general',
      difficulty: 'easy',
      text: `سؤال ${i}`,
      options: ['أ', 'ب', 'ج', 'د'],
      correctAnswer: 0,
    })),
  };
}

test('createSession: only one session per guild', () => {
  sm.deleteSession(GUILD);
  assert.equal(sm.hasSession(GUILD), false);

  assert.equal(sm.createSession(GUILD, makeSession()), true);
  assert.equal(sm.hasSession(GUILD), true);

  // Second create while active → rejected
  assert.equal(sm.createSession(GUILD, makeSession()), false);

  const s = sm.getSession(GUILD);
  assert.ok(s);
  assert.equal(s.questionCount, 3);
  assert.equal(s.questionResults.length, 3);
  assert.deepEqual([...s.questionResults], [null, null, null]);

  sm.deleteSession(GUILD);
  assert.equal(sm.hasSession(GUILD), false);
  assert.equal(sm.getSession(GUILD), null);
});

test('ensurePlayer / addPoints / getSortedScores', () => {
  sm.createSession(GUILD, makeSession());

  sm.ensurePlayer(GUILD, 'u1');
  sm.ensurePlayer(GUILD, 'u2');
  assert.equal(sm.getPlayerScore(GUILD, 'u1'), 0);

  sm.addPoints(GUILD, 'u1', 25);
  sm.addPoints(GUILD, 'u1', 10);
  sm.addPoints(GUILD, 'u2', 5);

  assert.equal(sm.getPlayerScore(GUILD, 'u1'), 35);
  const sorted = sm.getSortedScores(GUILD);
  assert.deepEqual(sorted, [['u1', 35], ['u2', 5]]);

  sm.deleteSession(GUILD);
});

test('updateStreak: increments on correct, resets on wrong, survives skips', () => {
  sm.createSession(GUILD, makeSession());

  assert.equal(sm.updateStreak(GUILD, 'u1', true), 1);
  assert.equal(sm.updateStreak(GUILD, 'u1', true), 2);
  assert.equal(sm.getPlayerStreak(GUILD, 'u1'), 2);

  assert.equal(sm.updateStreak(GUILD, 'u1', false), 0);
  assert.equal(sm.getPlayerStreak(GUILD, 'u1'), 0);

  sm.deleteSession(GUILD);
});

test('hasCompletionBonus: requires answering every non-skipped question since join', () => {
  sm.createSession(GUILD, makeSession(3));

  sm.ensurePlayer(GUILD, 'u1');

  // Question 0 answered → complete up to index 0
  sm.markAnswered(GUILD, 'u1', 0);
  assert.equal(sm.hasCompletionBonus(GUILD, 'u1'), true);

  // Advance to question 1 without answering → incomplete
  sm.updateSession(GUILD, { currentIndex: 1 });
  assert.equal(sm.hasCompletionBonus(GUILD, 'u1'), false);

  // Question 1 skipped → complete again (skips are neutral)
  sm.updateSession(GUILD, { skippedIndexes: new Set([1]) });
  assert.equal(sm.hasCompletionBonus(GUILD, 'u1'), true);

  // Advance to question 2 without answering (q1 skipped) → incomplete
  sm.updateSession(GUILD, { currentIndex: 2 });
  assert.equal(sm.hasCompletionBonus(GUILD, 'u1'), false);

  // Answer question 2 → complete (q0 answered, q1 skipped, q2 answered)
  sm.markAnswered(GUILD, 'u1', 2);
  assert.equal(sm.hasCompletionBonus(GUILD, 'u1'), true);

  sm.deleteSession(GUILD);
});

test('recordQuestionResult: stores results in question order', () => {
  sm.createSession(GUILD, makeSession(2));

  sm.recordQuestionResult(GUILD, 0, {
    votes: { u1: { answerIndex: 0, timestampMs: 1 } },
    speedWinners: ['u1'],
    startedAt: 100,
  });

  const s = sm.getSession(GUILD);
  assert.deepEqual(s.questionResults[0].speedWinners, ['u1']);
  assert.equal(s.questionResults[1], null);

  sm.deleteSession(GUILD);
});
