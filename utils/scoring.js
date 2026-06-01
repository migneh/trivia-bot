'use strict';
/**
 * utils/scoring.js
 *
 * All scoring logic for the trivia bot.
 *
 * ─── Mandatory calculation order ────────────────────────────────────────────
 *
 *   subtotal     = pointsPerCorrect + difficultyPoints[difficulty]
 *   afterStreak  = subtotal + streakBonus
 *   afterSpeed   = afterStreak + speedBonus
 *   finalScore   = afterSpeed + completionBonus
 *
 * ─── Streak bonus rules ──────────────────────────────────────────────────────
 *
 *   Starts accumulating from the 2nd consecutive correct answer (startsAtConsecutive = 2).
 *   Capped at maxBonus (default 5).
 *   Formula: bonus = MIN(streakCount - 1, maxBonus)
 *   Example: streak of 6 → bonus = MIN(5, 5) = 5
 *
 * ─── Speed bonus rules ───────────────────────────────────────────────────────
 *
 *   Awarded only to the first 3 correct answerers by timestamp.
 *   Ties at the same millisecond split the bonus pool equally.
 *   Example: two players tie for 1st → each gets 5/2 = 2.5 points.
 *   No speed bonus if nobody answers correctly.
 *
 * ─── Completion bonus rules ──────────────────────────────────────────────────
 *
 *   +20 points on the final question only.
 *   Requires answering every non-skipped question from joinIndex onward.
 *   Not awarded on early stop (endSession called with reason='stopped').
 *
 * ─── Title rules ─────────────────────────────────────────────────────────────
 *
 *   Based on all-time cumulative points from player_stats.
 *   Defined entirely in config.json under "titles".
 *   Sorted descending by minPoints — first match wins.
 */

const config = require('../config.json');

// ─── Pre-sort titles once at load time ────────────────────────────────────────
// Sorted descending so the first match is always the highest qualifying title.
const SORTED_TITLES = [...config.titles].sort((a, b) => b.minPoints - a.minPoints);

// ─── Difficulty points lookup (with safe fallback) ────────────────────────────
const DIFFICULTY_PTS = config.difficultyPoints ?? { easy: 5, medium: 10, hard: 20 };

// ─── Speed bonus pool ─────────────────────────────────────────────────────────
const SPEED_POOL = [
  config.speedBonuses?.first  ?? 5,
  config.speedBonuses?.second ?? 3,
  config.speedBonuses?.third  ?? 1,
];

// ─── Streak config ────────────────────────────────────────────────────────────
const STREAK_MAX   = config.streakBonus?.maxBonus           ?? 5;
const STREAK_START = config.streakBonus?.startsAtConsecutive ?? 2;

// ─── Base points ──────────────────────────────────────────────────────────────
const BASE_PTS         = config.pointsPerCorrect ?? 10;
const COMPLETION_BONUS = config.completionBonus  ?? 20;


// ═══════════════════════════════════════════════════════════════════════════════
// SCORE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate the total points earned for a single correct answer.
 *
 * @param {object} opts
 * @param {string}  opts.difficulty       - 'easy' | 'medium' | 'hard'
 * @param {number}  opts.streakCount      - streak count AFTER this answer (updated by updateStreak)
 * @param {number}  opts.speedRank        - 1-based rank among correct answerers (0 = unranked)
 * @param {number}  opts.speedTieCount    - how many players share this exact speed rank
 * @param {boolean} opts.isLastQuestion   - true if this is the final question of the session
 * @param {boolean} opts.completionEarned - true if the player qualifies for completion bonus
 *
 * @returns {{
 *   subtotal:        number,
 *   streakBonus:     number,
 *   speedBonus:      number,
 *   completionBonus: number,
 *   afterStreak:     number,
 *   afterSpeed:      number,
 *   finalScore:      number,
 * }}
 */
function calculateScore(opts) {
  const {
    difficulty,
    streakCount,
    speedRank,
    speedTieCount,
    isLastQuestion,
    completionEarned,
  } = opts;

  // ── Step 1: Base + difficulty ──────────────────────────────────────────────
  const diffPts  = DIFFICULTY_PTS[difficulty] ?? 0;
  const subtotal = BASE_PTS + diffPts;

  // ── Step 2: Streak bonus ───────────────────────────────────────────────────
  // Bonus starts accumulating from the Nth consecutive correct answer.
  // streakCount is already incremented for this answer when calculateScore is called.
  let streakBonus = 0;
  if (streakCount >= STREAK_START) {
    streakBonus = Math.min(streakCount - 1, STREAK_MAX);
  }
  const afterStreak = subtotal + streakBonus;

  // ── Step 3: Speed bonus ────────────────────────────────────────────────────
  // speedRank 0 = not in the top 3 (or nobody answered correctly)
  let speedBonus = 0;
  if (speedRank >= 1 && speedRank <= 3) {
    const poolValue = SPEED_POOL[speedRank - 1] ?? 0;
    // Split equally among tied players at the same rank
    speedBonus = poolValue / Math.max(1, speedTieCount);
  }
  const afterSpeed = afterStreak + speedBonus;

  // ── Step 4: Completion bonus (last question only) ──────────────────────────
  const completionBonus = (isLastQuestion && completionEarned) ? COMPLETION_BONUS : 0;
  const finalScore      = afterSpeed + completionBonus;

  return {
    subtotal,
    streakBonus,
    speedBonus,
    completionBonus,
    afterStreak,
    afterSpeed,
    finalScore,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SPEED RANK ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assign speed ranks to all correct answerers.
 *
 * Rules:
 * - Sorted ascending by timestampMs (earliest = best).
 * - Players with identical timestamps share a rank.
 * - Only ranks 1, 2, 3 are tracked (speed bonus only for top 3).
 * - Players outside top 3 are not included in the returned Map.
 *
 * @param {{ userId: string, timestampMs: number }[]} correctAnswerers
 *   Array of players who answered correctly, with their vote timestamps.
 *
 * @returns {Map<string, { rank: number, tieCount: number }>}
 *   Map from userId to their speed rank info.
 *   Only contains entries for players with rank 1, 2, or 3.
 */
function assignSpeedRanks(correctAnswerers) {
  if (!correctAnswerers || correctAnswerers.length === 0) {
    return new Map();
  }

  // Sort ascending by timestamp — earliest first
  const sorted = [...correctAnswerers].sort((a, b) => a.timestampMs - b.timestampMs);

  const rankMap = new Map();
  let rank      = 1;
  let i         = 0;

  while (i < sorted.length && rank <= 3) {
    const currentTs = sorted[i].timestampMs;

    // Find all players tied at this timestamp
    const tiedGroup = [];
    let j = i;
    while (j < sorted.length && sorted[j].timestampMs === currentTs) {
      tiedGroup.push(sorted[j]);
      j++;
    }

    // Assign rank to every player in the tied group
    for (const entry of tiedGroup) {
      rankMap.set(entry.userId, { rank, tieCount: tiedGroup.length });
    }

    // Advance rank by the number of tied players
    rank += tiedGroup.length;
    i     = j;
  }

  return rankMap;
}


// ═══════════════════════════════════════════════════════════════════════════════
// TITLE RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the display title for a player based on their all-time points.
 * Titles are defined in config.json under "titles".
 *
 * @param {number} totalPoints - all-time accumulated points from player_stats
 * @returns {string} the title name (e.g. "🏆 البطل")
 */
function getTitle(totalPoints) {
  const pts = totalPoints ?? 0;
  // SORTED_TITLES is sorted descending — first match is the highest qualifying title
  const match = SORTED_TITLES.find(t => pts >= t.minPoints);
  // Fallback to the first title (minPoints = 0) if nothing matched
  return match?.name ?? config.titles[0]?.name ?? 'المبتدئ';
}


// ═══════════════════════════════════════════════════════════════════════════════
// WORKED EXAMPLE (documented for reference)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Player on a 6-answer streak (streakCount = 6), Hard question,
// answered 1st (alone), final question, completed all non-skipped questions:
//
//   subtotal       = 10 + 20          = 30
//   streakBonus    = MIN(6-1, 5)      = 5
//   afterStreak    = 30 + 5           = 35
//   speedBonus     = 5 / 1            = 5   (rank 1, no tie)
//   afterSpeed     = 35 + 5           = 40
//   completionBonus= 20               (last question, all answered)
//   finalScore     = 40 + 20          = 60
//
// Two players tie for 1st place (same ms), Hard question, streak 2:
//
//   subtotal       = 10 + 20          = 30
//   streakBonus    = MIN(2-1, 5)      = 1
//   afterStreak    = 30 + 1           = 31
//   speedBonus     = 5 / 2            = 2.5  (rank 1, tieCount 2)
//   afterSpeed     = 31 + 2.5         = 33.5
//   completionBonus= 0                (not last question)
//   finalScore     = 33.5


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  calculateScore,
  assignSpeedRanks,
  getTitle,
};
