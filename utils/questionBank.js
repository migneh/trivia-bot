'use strict';
/**
 * utils/questionBank.js
 *
 * Loads, validates, and indexes questions.json at bot startup.
 * The entire file is parsed once into memory — never re-read per session.
 *
 * ─── Validation rules ────────────────────────────────────────────────────────
 *
 *   Each question must have:
 *     id           — string, unique across the whole file
 *     category     — must match a known category id in config.json
 *     difficulty   — 'easy' | 'medium' | 'hard'
 *     text         — non-empty string (supports Discord markdown + emoji)
 *     options      — array of exactly 4 strings, each ≤ 80 chars
 *     correctAnswer— integer 0–3
 *
 *   Optional:
 *     imageUrl     — validated at session start by imageValidator.js
 *
 *   Invalid questions are skipped; bot starts normally with valid ones only.
 *   All warnings are returned for logging to console + owner log channel.
 *
 * ─── Indexing ────────────────────────────────────────────────────────────────
 *
 *   After loading, questions are indexed by category for O(1) pool lookup.
 *   selectQuestions() shuffles randomly and shuffles each question's options,
 *   updating correctAnswer to match the new option order.
 *
 * ─── No-repeat guarantee ─────────────────────────────────────────────────────
 *
 *   selectQuestions() accepts a usedIds Set and excludes already-used questions.
 *   The session manager tracks usedQuestionIds in memory per session.
 */

const fs     = require('node:fs');
const path   = require('node:path');
const config = require('../config.json');

// ─── Known valid sets ──────────────────────────────────────────────────────────
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const VALID_CATEGORIES   = new Set(config.categories.map(c => c.id));

// ─── Module-level state ───────────────────────────────────────────────────────
/** @type {object[]} All valid questions loaded at startup */
let allQuestions = [];

/** @type {Object.<string, object[]>} Questions indexed by category id */
let byCategory = {};

/** @type {boolean} Whether initQuestionBank() has been called */
let initialised = false;


// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate a single question object.
 * Returns an array of error strings — empty array means valid.
 *
 * @param {object} q - raw question object from JSON
 * @param {Set<string>} seenIds - ids already validated (for duplicate detection)
 * @returns {string[]} list of validation errors (empty = valid)
 */
function validateQuestion(q, seenIds) {
  const errors = [];

  // ── id ──────────────────────────────────────────────────────────────────────
  if (!q.id || typeof q.id !== 'string' || q.id.trim() === '') {
    errors.push('missing or empty id');
  } else if (seenIds.has(q.id)) {
    errors.push(`duplicate id: "${q.id}"`);
  }

  // ── text ─────────────────────────────────────────────────────────────────────
  if (!q.text || typeof q.text !== 'string' || q.text.trim() === '') {
    errors.push('missing or empty text');
  }

  // ── category ─────────────────────────────────────────────────────────────────
  if (!VALID_CATEGORIES.has(q.category)) {
    errors.push(`unknown category: "${q.category}" (known: ${[...VALID_CATEGORIES].join(', ')})`);
  }

  // ── difficulty ────────────────────────────────────────────────────────────────
  if (!VALID_DIFFICULTIES.has(q.difficulty)) {
    errors.push(`invalid difficulty: "${q.difficulty}" (must be easy | medium | hard)`);
  }

  // ── options ───────────────────────────────────────────────────────────────────
  if (!Array.isArray(q.options)) {
    errors.push('options must be an array');
  } else if (q.options.length !== 4) {
    errors.push(`options must have exactly 4 entries (got ${q.options.length})`);
  } else {
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      if (typeof opt !== 'string' || opt.trim() === '') {
        errors.push(`options[${i}] is empty or not a string`);
      } else if (opt.length > 80) {
        // Discord button label limit — hard cap
        errors.push(`options[${i}] exceeds 80 characters (${opt.length} chars): "${opt.substring(0, 30)}..."`);
      }
    }
  }

  // ── correctAnswer ─────────────────────────────────────────────────────────────
  if (
    typeof q.correctAnswer !== 'number' ||
    !Number.isInteger(q.correctAnswer)  ||
    q.correctAnswer < 0                 ||
    q.correctAnswer > 3
  ) {
    errors.push(`correctAnswer must be integer 0–3 (got: ${JSON.stringify(q.correctAnswer)})`);
  }

  // ── imageUrl (optional) ───────────────────────────────────────────────────────
  if (q.imageUrl !== undefined && q.imageUrl !== null) {
    if (typeof q.imageUrl !== 'string') {
      errors.push('imageUrl must be a string if provided');
    } else {
      try {
        new URL(q.imageUrl);
      } catch {
        errors.push(`imageUrl is not a valid URL: "${q.imageUrl}"`);
      }
    }
  }

  return errors;
}


// ═══════════════════════════════════════════════════════════════════════════════
// LOADING & INDEXING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load and validate questions.json.
 * Returns validated questions and a list of warning strings for logging.
 *
 * @returns {{ questions: object[], warnings: string[] }}
 */
function loadAndValidate() {
  const filePath = path.resolve('questions.json');

  // ── File existence ────────────────────────────────────────────────────────────
  if (!fs.existsSync(filePath)) {
    return {
      questions: [],
      warnings:  ['questions.json not found — no questions available'],
    };
  }

  // ── JSON parse ────────────────────────────────────────────────────────────────
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return {
      questions: [],
      warnings:  [`questions.json parse error: ${err.message}`],
    };
  }

  if (!Array.isArray(raw)) {
    return {
      questions: [],
      warnings:  ['questions.json must be a JSON array at the top level'],
    };
  }

  // ── Per-question validation ───────────────────────────────────────────────────
  const seenIds  = new Set();
  const warnings = [];
  const valid    = [];

  for (let i = 0; i < raw.length; i++) {
    const q      = raw[i];
    const label  = q?.id ? `id="${q.id}"` : `index ${i}`;
    const errors = validateQuestion(q, seenIds);

    if (errors.length > 0) {
      warnings.push(`[Q ${label}] ${errors.join(' | ')}`);
      continue; // skip invalid question
    }

    seenIds.add(q.id);
    valid.push(q);
  }

  return { questions: valid, warnings };
}

/**
 * Initialise the question bank.
 * Must be called once at bot startup (from index.js).
 *
 * @returns {string[]} validation warnings (empty = all good)
 */
function initQuestionBank() {
  const { questions, warnings } = loadAndValidate();

  allQuestions = questions;
  byCategory   = {};

  for (const q of allQuestions) {
    if (!byCategory[q.category]) byCategory[q.category] = [];
    byCategory[q.category].push(q);
  }

  initialised = true;

  // Summary log
  const catSummary = Object.entries(byCategory)
    .map(([cat, qs]) => `${cat}:${qs.length}`)
    .join(', ');

  console.log(
    `[QuestionBank] Loaded ${allQuestions.length} valid questions` +
    (allQuestions.length > 0 ? ` — ${catSummary}` : '') +
    (warnings.length > 0 ? ` | ⚠️ ${warnings.length} warning(s)` : ' ✅')
  );

  if (warnings.length > 0) {
    warnings.forEach(w => console.warn(`  [QuestionBank] ${w}`));
  }

  return warnings;
}


// ═══════════════════════════════════════════════════════════════════════════════
// SHUFFLE UTILITY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In-place Fisher-Yates shuffle.
 * Returns the same array (mutated) for convenience.
 *
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j     = Math.floor(Math.random() * (i + 1));
    const tmp   = arr[i];
    arr[i]      = arr[j];
    arr[j]      = tmp;
  }
  return arr;
}


// ═══════════════════════════════════════════════════════════════════════════════
// QUESTION SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get all valid questions matching the given categories,
 * excluding already-used ids.
 *
 * @param {string[]} categories  - list of category ids to include
 * @param {Set<string>} usedIds  - question ids to exclude
 * @returns {object[]} eligible questions (not shuffled)
 */
function getEligibleQuestions(categories, usedIds = new Set()) {
  if (!initialised) throw new Error('[QuestionBank] initQuestionBank() not called');

  const pool = [];
  for (const cat of categories) {
    const qs = byCategory[cat] ?? [];
    for (const q of qs) {
      if (!usedIds.has(q.id)) pool.push(q);
    }
  }
  return pool;
}

/**
 * Select up to `count` questions randomly from the eligible pool.
 *
 * Each selected question's options are shuffled randomly,
 * and correctAnswer is updated to match the new position.
 * This means the shuffled question objects are safe to send to Discord
 * without any further transformation.
 *
 * @param {string[]} categories    - category ids to draw from
 * @param {number}   count         - how many questions to select
 * @param {Set<string>} [usedIds]  - question ids to exclude (default: empty)
 *
 * @returns {object[]} selected questions with shuffled options
 *   (at most `count` items — may be fewer if pool is smaller)
 */
function selectQuestions(categories, count, usedIds = new Set()) {
  const pool = getEligibleQuestions(categories, usedIds);

  // Shuffle the pool to randomise selection order
  shuffle(pool);

  // Take up to `count` questions
  const selected = pool.slice(0, count);

  // Shuffle each question's options and update correctAnswer index
  return selected.map(q => {
    const originalCorrectText = q.options[q.correctAnswer];
    const shuffledOptions     = shuffle([...q.options]);
    const newCorrectIndex     = shuffledOptions.indexOf(originalCorrectText);

    return {
      ...q,
      options:       shuffledOptions,
      correctAnswer: newCorrectIndex,
    };
  });
}

/**
 * Count available (eligible) questions across the given categories.
 * Used to warn hosts when the requested count exceeds the pool.
 *
 * @param {string[]} categories
 * @param {Set<string>} [usedIds]
 * @returns {number}
 */
function countEligible(categories, usedIds = new Set()) {
  return getEligibleQuestions(categories, usedIds).length;
}

/**
 * Get all loaded questions (for stats or admin inspection).
 * Returns a shallow copy — do not mutate.
 *
 * @returns {object[]}
 */
function getAllQuestions() {
  return [...allQuestions];
}

/**
 * Get the count of valid questions per category.
 * Used by /trivia-stats and setup wizard.
 *
 * @returns {Object.<string, number>} { categoryId: count }
 */
function getCountsByCategory() {
  return Object.fromEntries(
    Object.entries(byCategory).map(([cat, qs]) => [cat, qs.length])
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  initQuestionBank,
  selectQuestions,
  countEligible,
  getEligibleQuestions,
  getAllQuestions,
  getCountsByCategory,
  shuffle,               // exported for use in other modules if needed
};
