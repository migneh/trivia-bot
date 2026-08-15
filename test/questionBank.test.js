'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  initQuestionBank,
  validateQuestion,
  selectQuestions,
  countEligible,
  getEligibleQuestions,
  getAllQuestions,
  getCountsByCategory,
} = require('../utils/questionBank');

// ─── Validation (pure — no question bank initialisation needed) ───────────────

function validQuestion(overrides = {}) {
  return {
    id: 'q_test_1',
    category: 'general',
    difficulty: 'easy',
    text: 'سؤال تجريبي؟',
    options: ['أ', 'ب', 'ج', 'د'],
    correctAnswer: 0,
    ...overrides,
  };
}

test('validateQuestion: accepts a well-formed question', () => {
  assert.deepEqual(validateQuestion(validQuestion(), new Set()), []);
});

test('validateQuestion: rejects missing/empty/duplicate ids', () => {
  assert.notDeepEqual(validateQuestion(validQuestion({ id: '' }), new Set()), []);
  assert.notDeepEqual(validateQuestion(validQuestion({ id: 42 }), new Set()), []);
  assert.notDeepEqual(validateQuestion(validQuestion(), new Set(['q_test_1'])), []);
});

test('validateQuestion: rejects unknown category and invalid difficulty', () => {
  assert.notDeepEqual(validateQuestion(validQuestion({ category: 'nonsense' }), new Set()), []);
  assert.notDeepEqual(validateQuestion(validQuestion({ difficulty: 'expert' }), new Set()), []);
});

test('validateQuestion: enforces exactly 4 non-empty options ≤ 80 chars', () => {
  assert.notDeepEqual(validateQuestion(validQuestion({ options: ['أ', 'ب', 'ج'] }), new Set()), []);
  assert.notDeepEqual(validateQuestion(validQuestion({ options: ['أ', 'ب', 'ج', 'د', 'هـ'] }), new Set()), []);
  assert.notDeepEqual(validateQuestion(validQuestion({ options: ['', 'ب', 'ج', 'د'] }), new Set()), []);
  assert.notDeepEqual(validateQuestion(validQuestion({ options: ['x'.repeat(81), 'ب', 'ج', 'د'] }), new Set()), []);
});

test('validateQuestion: rejects out-of-range / non-integer correctAnswer', () => {
  assert.notDeepEqual(validateQuestion(validQuestion({ correctAnswer: 4 }), new Set()), []);
  assert.notDeepEqual(validateQuestion(validQuestion({ correctAnswer: -1 }), new Set()), []);
  assert.notDeepEqual(validateQuestion(validQuestion({ correctAnswer: 1.5 }), new Set()), []);
});

test('validateQuestion: rejects malformed imageUrl', () => {
  assert.notDeepEqual(validateQuestion(validQuestion({ imageUrl: 'not a url' }), new Set()), []);
  assert.deepEqual(validateQuestion(validQuestion({ imageUrl: 'https://example.com/a.png' }), new Set()), []);
});

// ─── Selection (needs the shipped question bank) ─────────────────────────────

const warnings = initQuestionBank();

test('initQuestionBank: shipped questions.json loads without validation warnings', () => {
  assert.deepEqual(warnings, []);
  const counts = getCountsByCategory();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.ok(total >= 1000, `expected a large bank, got ${total}`);
});

test('selectQuestions: returns the requested count with intact, shuffled options', () => {
  const selected = selectQuestions(['gaming'], 5);
  assert.equal(selected.length, 5);

  const byId = new Map(getAllQuestions().map(q => [q.id, q]));
  const used = new Set();

  for (const q of selected) {
    assert.equal(q.options.length, 4);
    assert.ok(Number.isInteger(q.correctAnswer) && q.correctAnswer >= 0 && q.correctAnswer <= 3);
    assert.equal(new Set(q.options).size, 4, 'options must remain unique after shuffle');

    // correctAnswer must point at the original correct text after re-shuffling
    const original = byId.get(q.id);
    assert.ok(original, 'selected question must exist in the bank');
    assert.equal(q.options[q.correctAnswer], original.options[original.correctAnswer]);

    assert.ok(!used.has(q.id), 'no duplicate questions within one selection');
    used.add(q.id);
  }
});

test('selectQuestions: respects the usedIds no-repeat guarantee', () => {
  const first = selectQuestions(['sports'], 5);
  const usedIds = new Set(first.map(q => q.id));

  const second = selectQuestions(['sports'], 5, usedIds);
  for (const q of second) {
    assert.ok(!usedIds.has(q.id));
  }
});

test('selectQuestions: returns fewer questions when the pool is smaller', () => {
  const eligible = countEligible(['sports']);
  const selected = selectQuestions(['sports'], eligible + 100);
  assert.equal(selected.length, eligible);
});

test('getEligibleQuestions: excludes used ids and filters by category', () => {
  const all = getEligibleQuestions(['gaming']);
  assert.ok(all.length > 0);
  assert.ok(all.every(q => q.category === 'gaming'));

  const used = new Set(all.slice(0, 3).map(q => q.id));
  const filtered = getEligibleQuestions(['gaming'], used);
  assert.equal(filtered.length, all.length - 3);
});
