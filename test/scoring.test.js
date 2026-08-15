'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

const { calculateScore, assignSpeedRanks, getTitle } = require('../utils/scoring');

test('calculateScore: base + easy difficulty, no bonuses', () => {
  const r = calculateScore({
    difficulty: 'easy',
    streakCount: 1,
    speedRank: 0,
    speedTieCount: 1,
    isLastQuestion: false,
    completionEarned: false,
  });
  assert.equal(r.subtotal, 15);         // 10 base + 5 easy
  assert.equal(r.streakBonus, 0);
  assert.equal(r.speedBonus, 0);
  assert.equal(r.completionBonus, 0);
  assert.equal(r.finalScore, 15);
});

test('calculateScore: documented worked example (hard, streak 6, speed 1st, last Q)', () => {
  const r = calculateScore({
    difficulty: 'hard',
    streakCount: 6,
    speedRank: 1,
    speedTieCount: 1,
    isLastQuestion: true,
    completionEarned: true,
  });
  assert.equal(r.subtotal, 30);         // 10 base + 20 hard
  assert.equal(r.streakBonus, 5);       // MIN(6-1, 5)
  assert.equal(r.afterStreak, 35);
  assert.equal(r.speedBonus, 5);        // 5 / 1
  assert.equal(r.afterSpeed, 40);
  assert.equal(r.completionBonus, 20);
  assert.equal(r.finalScore, 60);
});

test('calculateScore: streak bonus starts at 2nd consecutive and caps at 5', () => {
  const streak2 = calculateScore({ difficulty: 'easy', streakCount: 2, speedRank: 0, speedTieCount: 1, isLastQuestion: false, completionEarned: false });
  assert.equal(streak2.streakBonus, 1);

  const streak20 = calculateScore({ difficulty: 'easy', streakCount: 20, speedRank: 0, speedTieCount: 1, isLastQuestion: false, completionEarned: false });
  assert.equal(streak20.streakBonus, 5);
});

test('calculateScore: speed bonus splits equally on ties', () => {
  const r = calculateScore({ difficulty: 'medium', streakCount: 1, speedRank: 1, speedTieCount: 2, isLastQuestion: false, completionEarned: false });
  assert.equal(r.speedBonus, 2.5);      // 5 / 2
  assert.equal(r.finalScore, 22.5);     // 10 + 10 + 2.5
});

test('calculateScore: completion bonus only on the last question', () => {
  const last = calculateScore({ difficulty: 'easy', streakCount: 1, speedRank: 0, speedTieCount: 1, isLastQuestion: true, completionEarned: true });
  assert.equal(last.completionBonus, 20);

  const notLast = calculateScore({ difficulty: 'easy', streakCount: 1, speedRank: 0, speedTieCount: 1, isLastQuestion: false, completionEarned: true });
  assert.equal(notLast.completionBonus, 0);
});

test('assignSpeedRanks: empty and single answerer', () => {
  assert.equal(assignSpeedRanks([]).size, 0);
  assert.equal(assignSpeedRanks(null).size, 0);

  const m = assignSpeedRanks([{ userId: 'a', timestampMs: 100 }]);
  assert.deepEqual(m.get('a'), { rank: 1, tieCount: 1 });
});

test('assignSpeedRanks: ordering and tie handling', () => {
  const m = assignSpeedRanks([
    { userId: 'slow', timestampMs: 300 },
    { userId: 'fast1', timestampMs: 100 },
    { userId: 'fast2', timestampMs: 100 },
    { userId: 'mid', timestampMs: 200 },
  ]);

  // Two players tie for 1st at 100ms → both rank 1, tieCount 2.
  assert.deepEqual(m.get('fast1'), { rank: 1, tieCount: 2 });
  assert.deepEqual(m.get('fast2'), { rank: 1, tieCount: 2 });
  // Next player is rank 3 (ranks advance by group size).
  assert.deepEqual(m.get('mid'), { rank: 3, tieCount: 1 });
  // 4th answerer is outside the top 3 → excluded.
  assert.equal(m.has('slow'), false);
});

test('getTitle: matches by cumulative points with descending lookup', () => {
  assert.equal(getTitle(0), '🌱 المبتدئ');
  assert.equal(getTitle(99), '🌱 المبتدئ');
  assert.equal(getTitle(100), '📖 المتعلم');
  assert.equal(getTitle(1000), '🎯 المحترف');
  assert.equal(getTitle(99999), '☀️ الشمس التي لا تغيب');
  assert.equal(getTitle(undefined), '🌱 المبتدئ');
});
