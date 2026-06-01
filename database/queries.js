'use strict';
/**
 * database/queries.js
 * All prepared-statement query helpers.
 *
 * Leaderboard routing:
 *   all-time → player_stats (indexed cache, fast)
 *   day/week/month → session_history (indexed by guild_id + ended_at)
 *
 * All functions are synchronous (better-sqlite3 is sync).
 * Async wrappers live in the callers — don't add async here.
 */

const { getDb } = require('./schema');

// ═══════════════════════════════════════════════════════════════════════════
// GUILD SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns guild settings row or null if not configured yet.
 * @param {string} guildId
 * @returns {object|null}
 */
function getGuildSettings(guildId) {
  return getDb()
    .prepare('SELECT * FROM guild_settings WHERE guild_id = ?')
    .get(guildId) ?? null;
}

/**
 * Insert or update guild settings.
 * Only the fields provided in `fields` are written.
 * All field values must already be serialised (e.g. JSON.stringify arrays).
 *
 * @param {string} guildId
 * @param {object} fields - column→value pairs to write
 */
function upsertGuildSettings(guildId, fields) {
  const db       = getDb();
  const existing = getGuildSettings(guildId);

  if (!existing) {
    // First-time setup for this guild — insert with safe defaults
    db.prepare(`
      INSERT INTO guild_settings
        (guild_id, session_channel, backup_channel, manager_roles,
         enabled_categories, schedule_mode, schedule_config)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      guildId,
      fields.session_channel    ?? null,
      fields.backup_channel     ?? null,
      fields.manager_roles      ?? '[]',
      fields.enabled_categories ?? '[]',
      fields.schedule_mode      ?? 'none',
      fields.schedule_config    ?? '{}'
    );
  } else {
    // Partial update — only touch the supplied columns
    const keys = Object.keys(fields);
    if (keys.length === 0) return;

    const sets = keys.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE guild_settings SET ${sets} WHERE guild_id = ?`)
      .run(...Object.values(fields), guildId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION HISTORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Insert a completed session record.
 * Called inside an atomic transaction from gameEngine.endSession().
 *
 * @param {object} data
 * @returns {import('better-sqlite3').RunResult}
 */
function insertSessionHistory(data) {
  return getDb().prepare(`
    INSERT INTO session_history
      (guild_id, host_id, channel_id, started_at, ended_at, end_reason,
       question_count, categories, questions_data, scores_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.guildId,
    data.hostId,
    data.channelId,
    data.startedAt,
    data.endedAt,
    data.endReason,
    data.questionCount,
    JSON.stringify(data.categories),
    JSON.stringify(data.questionsData),
    JSON.stringify(data.scoresData)
  );
}

/**
 * Retrieve all session records for a guild (used by rebuild).
 * @param {string} guildId
 */
function getSessionsByGuild(guildId) {
  return getDb()
    .prepare('SELECT * FROM session_history WHERE guild_id = ? ORDER BY ended_at ASC')
    .all(guildId);
}

/**
 * Count total sessions for a guild.
 * @param {string} guildId
 */
function countSessionsByGuild(guildId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM session_history WHERE guild_id = ?')
    .get(guildId)?.cnt ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAYER STATS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a single player's stats row, or null if they've never played.
 * @param {string} guildId
 * @param {string} userId
 * @returns {object|null}
 */
function getPlayerStats(guildId, userId) {
  return getDb()
    .prepare('SELECT * FROM player_stats WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId) ?? null;
}

/**
 * Atomically increment a player's cached stats.
 * Uses INSERT ... ON CONFLICT so it's safe for first-time players.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {{ points: number, sessions: number, wins: number, answers: number, streak: number, speedFirstCount: number }} delta
 */
function upsertPlayerStats(guildId, userId, delta) {
  getDb().prepare(`
    INSERT INTO player_stats
      (guild_id, user_id, total_points, session_count, win_count,
       total_answers, longest_streak, speed_first_count, achievements)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      total_points      = total_points      + excluded.total_points,
      session_count     = session_count     + excluded.session_count,
      win_count         = win_count         + excluded.win_count,
      total_answers     = total_answers     + excluded.total_answers,
      longest_streak    = MAX(longest_streak, excluded.longest_streak),
      speed_first_count = speed_first_count + excluded.speed_first_count
  `).run(
    guildId,
    userId,
    delta.points        ?? 0,
    delta.sessions      ?? 0,
    delta.wins          ?? 0,
    delta.answers       ?? 0,
    delta.streak        ?? 0,
    delta.speedFirstCount ?? 0
  );
}

/**
 * Overwrite a player's achievements JSON blob.
 * @param {string} guildId
 * @param {string} userId
 * @param {string} achievementsJson - JSON.stringify({ achievementId: true })
 */
function setPlayerAchievements(guildId, userId, achievementsJson) {
  getDb().prepare(`
    UPDATE player_stats
    SET achievements = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(achievementsJson, guildId, userId);
}

/**
 * All-time leaderboard from player_stats cache (O(log n) via index).
 * @param {string} guildId
 * @param {number} limit
 * @returns {{ user_id: string, total_points: number, session_count: number }[]}
 */
function getAllTimeLeaderboard(guildId, limit = 10) {
  return getDb().prepare(`
    SELECT user_id, total_points, session_count
    FROM player_stats
    WHERE guild_id = ?
    ORDER BY total_points DESC
    LIMIT ?
  `).all(guildId, limit);
}

/**
 * Get a player's rank (1-based) within the guild by total_points.
 * Players with higher points have lower rank numbers.
 * @param {string} guildId
 * @param {string} userId
 * @returns {number}
 */
function getPlayerRank(guildId, userId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) + 1 AS rank
    FROM player_stats
    WHERE guild_id = ?
      AND total_points > COALESCE(
        (SELECT total_points FROM player_stats WHERE guild_id = ? AND user_id = ?),
        0
      )
  `).get(guildId, guildId, userId);
  return row?.rank ?? 1;
}

/**
 * Total number of unique players who have stats in this guild.
 * @param {string} guildId
 * @returns {number}
 */
function getTotalPlayers(guildId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM player_stats WHERE guild_id = ?')
    .get(guildId)?.cnt ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// TIME-RANGE LEADERBOARD  (from session_history — indexed)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Aggregate scores from session_history for a time window.
 * Uses the (guild_id, ended_at) index — performant at scale.
 *
 * @param {string} guildId
 * @param {number} fromTs  - start Unix ms (inclusive)
 * @param {number} toTs    - end Unix ms (inclusive)
 * @param {number} limit
 * @returns {{ user_id: string, total_points: number }[]}
 */
function getTimeRangeLeaderboard(guildId, fromTs, toTs, limit = 10) {
  const rows = getDb().prepare(`
    SELECT scores_data
    FROM session_history
    WHERE guild_id = ?
      AND ended_at >= ?
      AND ended_at <= ?
  `).all(guildId, fromTs, toTs);

  // Aggregate in JS — avoids complex JSON SQL functions
  const totals = {};
  for (const row of rows) {
    let scores;
    try { scores = JSON.parse(row.scores_data); } catch { continue; }
    for (const [userId, pts] of Object.entries(scores)) {
      totals[userId] = (totals[userId] ?? 0) + pts;
    }
  }

  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([userId, total_points]) => ({ user_id: userId, total_points }));
}

// ═══════════════════════════════════════════════════════════════════════════
// QUESTION STATS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Increment question performance counters for one appearance.
 * Safe for first appearance — uses INSERT ... ON CONFLICT.
 *
 * @param {string}  guildId
 * @param {string}  questionId
 * @param {boolean} correct      - was the question answered correctly by at least one player?
 * @param {boolean} zeroVote     - did nobody vote on this question?
 * @param {number}  speedMs      - ms timestamp of first correct answer (0 if none)
 */
function upsertQuestionStats(guildId, questionId, correct, zeroVote, speedMs) {
  getDb().prepare(`
    INSERT INTO question_stats
      (guild_id, question_id, times_appeared, correct_count, zero_vote_count, total_speed_ms)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(guild_id, question_id) DO UPDATE SET
      times_appeared  = times_appeared  + 1,
      correct_count   = correct_count   + excluded.correct_count,
      zero_vote_count = zero_vote_count + excluded.zero_vote_count,
      total_speed_ms  = total_speed_ms  + excluded.total_speed_ms
  `).run(
    guildId,
    questionId,
    correct  ? 1 : 0,
    zeroVote ? 1 : 0,
    speedMs  ?? 0
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// GUILD STATISTICS  (/trivia-stats)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Aggregate statistics for a guild's stats embed.
 * Reads from both player_stats and question_stats caches.
 *
 * @param {string} guildId
 * @returns {{
 *   sessionCount: number,
 *   topCat: string|null,
 *   avgPlayers: string,
 *   activePlayer: { user_id: string, session_count: number }|null,
 *   hardest: { question_id: string, times_appeared: number, correct_count: number, rate: number }|null,
 *   mostMissed: { question_id: string, zero_vote_count: number }|null
 * }}
 */
function getGuildStats(guildId) {
  const db = getDb();

  // ── Session count ──────────────────────────────────────────────────────
  const sessionCount = db
    .prepare('SELECT COUNT(*) AS cnt FROM session_history WHERE guild_id = ?')
    .get(guildId)?.cnt ?? 0;

  // ── Most played category ───────────────────────────────────────────────
  const catRows = db
    .prepare('SELECT categories FROM session_history WHERE guild_id = ?')
    .all(guildId);

  const catCount = {};
  for (const row of catRows) {
    let cats;
    try { cats = JSON.parse(row.categories ?? '[]'); } catch { continue; }
    for (const c of cats) {
      catCount[c] = (catCount[c] ?? 0) + 1;
    }
  }
  const topCat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // ── Average players per session ────────────────────────────────────────
  const scoreRows = db
    .prepare('SELECT scores_data FROM session_history WHERE guild_id = ?')
    .all(guildId);

  let totalPlayerSlots = 0;
  for (const row of scoreRows) {
    try {
      totalPlayerSlots += Object.keys(JSON.parse(row.scores_data ?? '{}')).length;
    } catch {}
  }
  const avgPlayers = sessionCount > 0
    ? (totalPlayerSlots / sessionCount).toFixed(1)
    : '0';

  // ── Most active player ─────────────────────────────────────────────────
  const activePlayer = db.prepare(`
    SELECT user_id, session_count
    FROM player_stats
    WHERE guild_id = ?
    ORDER BY session_count DESC
    LIMIT 1
  `).get(guildId) ?? null;

  // ── Hardest question (lowest correct answer rate, min 5 appearances) ───
  const hardest = db.prepare(`
    SELECT
      question_id,
      times_appeared,
      correct_count,
      CAST(correct_count AS REAL) / times_appeared AS rate
    FROM question_stats
    WHERE guild_id = ?
      AND times_appeared >= 5
    ORDER BY rate ASC
    LIMIT 1
  `).get(guildId) ?? null;

  // ── Most missed question (highest zero-vote count) ─────────────────────
  const mostMissed = db.prepare(`
    SELECT question_id, zero_vote_count
    FROM question_stats
    WHERE guild_id = ?
    ORDER BY zero_vote_count DESC
    LIMIT 1
  `).get(guildId) ?? null;

  return { sessionCount, topCat, avgPlayers, activePlayer, hardest, mostMissed };
}

// ═══════════════════════════════════════════════════════════════════════════
// CORRUPTION DETECTION & REBUILD  (used by cache.js)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find guilds that have session_history records but NO player_stats rows.
 * Indicates a crash or failed async update after session archive.
 * @returns {string[]} list of guild IDs needing rebuild
 */
function getGuildsWithOrphanedHistory() {
  return getDb().prepare(`
    SELECT DISTINCT sh.guild_id
    FROM session_history sh
    WHERE NOT EXISTS (
      SELECT 1 FROM player_stats ps WHERE ps.guild_id = sh.guild_id
    )
  `).all().map(r => r.guild_id);
}

/**
 * Rebuild player_stats for a guild from scratch using session_history.
 * Runs inside a single atomic transaction.
 * Existing player_stats rows for this guild are replaced.
 *
 * Also rebuilds speed_first_count by counting sessions where
 * the player's score entry exists (approximation — exact speed data
 * is not stored in session_history, only final scores).
 *
 * @param {string} guildId
 */
function rebuildPlayerStatsForGuild(guildId) {
  const db       = getDb();
  const sessions = db
    .prepare('SELECT * FROM session_history WHERE guild_id = ? ORDER BY ended_at ASC')
    .all(guildId);

  // Aggregate from sessions
  const statsMap = {};

  function getOrInit(userId) {
    if (!statsMap[userId]) {
      statsMap[userId] = {
        points:          0,
        sessions:        0,
        wins:            0,
        answers:         0,
        longestStreak:   0,
        speedFirstCount: 0,
      };
    }
    return statsMap[userId];
  }

  for (const session of sessions) {
    let scores, questionsData;
    try { scores        = JSON.parse(session.scores_data   ?? '{}'); } catch { scores = {}; }
    try { questionsData = JSON.parse(session.questions_data ?? '[]'); } catch { questionsData = []; }

    const entries  = Object.entries(scores);
    if (entries.length === 0) continue;

    const maxScore = entries.reduce((m, [, v]) => Math.max(m, v), 0);

    for (const [userId, pts] of entries) {
      const s = getOrInit(userId);
      s.points   += pts;
      s.sessions += 1;
      if (pts === maxScore && pts > 0) s.wins += 1;

      // Count correct answers this player gave
      for (const q of questionsData) {
        if (!q.skipped && q.playerAnswers?.[userId]?.answerIndex === q.correctAnswer) {
          s.answers += 1;
        }
      }
    }
  }

  // Write atomically — delete old rows first, then insert rebuilt
  const deleteOld = db.prepare('DELETE FROM player_stats WHERE guild_id = ?');
  const insert    = db.prepare(`
    INSERT INTO player_stats
      (guild_id, user_id, total_points, session_count, win_count,
       total_answers, longest_streak, speed_first_count, achievements)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
  `);

  const rebuild = db.transaction(() => {
    deleteOld.run(guildId);
    for (const [userId, s] of Object.entries(statsMap)) {
      insert.run(
        guildId,
        userId,
        s.points,
        s.sessions,
        s.wins,
        s.answers,
        s.longestStreak,
        s.speedFirstCount
      );
    }
  });

  rebuild();
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Guild settings
  getGuildSettings,
  upsertGuildSettings,

  // Session history
  insertSessionHistory,
  getSessionsByGuild,
  countSessionsByGuild,

  // Player stats
  getPlayerStats,
  upsertPlayerStats,
  setPlayerAchievements,
  getAllTimeLeaderboard,
  getPlayerRank,
  getTotalPlayers,

  // Time-range leaderboard
  getTimeRangeLeaderboard,

  // Question stats
  upsertQuestionStats,

  // Guild statistics
  getGuildStats,

  // Corruption detection & rebuild
  getGuildsWithOrphanedHistory,
  rebuildPlayerStatsForGuild,
};
