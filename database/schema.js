'use strict';
/**
 * database/schema.js
 * Schema initialisation and migration runner using pragma user_version.
 * Migrations are append-only — never destructive.
 * Each migration function is indexed at position (version - 1).
 */

const Database = require('better-sqlite3');
const path     = require('node:path');
const fs       = require('node:fs');
const config   = require('../config.json');

/** @type {import('better-sqlite3').Database | null} */
let db = null;

function getDb() {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}

// ─── Migration definitions ─────────────────────────────────────────────────
// Index 0 = migration to version 1, index 1 = migration to version 2, etc.
// NEVER modify existing entries. ONLY append new ones.

const MIGRATIONS = [

  // ── Version 1: Initial schema ─────────────────────────────────────────────
  function migration_v1() {
    db.exec(`
      -- Per-guild configuration
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id            TEXT PRIMARY KEY,
        session_channel     TEXT,
        backup_channel      TEXT,
        manager_roles       TEXT    NOT NULL DEFAULT '[]',
        enabled_categories  TEXT    NOT NULL DEFAULT '[]',
        schedule_mode       TEXT    NOT NULL DEFAULT 'none',
        schedule_config     TEXT    NOT NULL DEFAULT '{}'
      );

      -- Source of truth for every session ever played.
      -- Written in a single atomic transaction at session end.
      CREATE TABLE IF NOT EXISTS session_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id        TEXT    NOT NULL,
        host_id         TEXT    NOT NULL,
        channel_id      TEXT    NOT NULL,
        started_at      INTEGER NOT NULL,   -- Unix ms
        ended_at        INTEGER NOT NULL,   -- Unix ms
        end_reason      TEXT    NOT NULL,   -- completed | stopped | idle | crash | insufficient_players | channel_lost | scheduled_override
        question_count  INTEGER NOT NULL,
        categories      TEXT    NOT NULL,   -- JSON array of category ids
        questions_data  TEXT    NOT NULL,   -- JSON array of question snapshots
        scores_data     TEXT    NOT NULL    -- JSON object { userId: totalPoints }
      );

      -- Primary index: time-range leaderboard queries (day/week/month)
      CREATE INDEX IF NOT EXISTS idx_session_guild_ended
        ON session_history (guild_id, ended_at);

      -- Secondary index: all sessions for a guild (rebuild, stats)
      CREATE INDEX IF NOT EXISTS idx_session_guild_id
        ON session_history (guild_id);

      -- Pre-aggregated player performance cache per guild.
      -- Updated asynchronously after session_history write.
      -- Source of truth for all-time leaderboard and profile queries.
      CREATE TABLE IF NOT EXISTS player_stats (
        guild_id            TEXT    NOT NULL,
        user_id             TEXT    NOT NULL,
        total_points        REAL    NOT NULL DEFAULT 0,
        session_count       INTEGER NOT NULL DEFAULT 0,
        win_count           INTEGER NOT NULL DEFAULT 0,
        total_answers       INTEGER NOT NULL DEFAULT 0,
        longest_streak      INTEGER NOT NULL DEFAULT 0,
        speed_first_count   INTEGER NOT NULL DEFAULT 0,   -- times ranked 1st in speed
        achievements        TEXT    NOT NULL DEFAULT '{}', -- JSON object { achievementId: true }
        PRIMARY KEY (guild_id, user_id)
      );

      -- Index for all-time leaderboard ranking
      CREATE INDEX IF NOT EXISTS idx_player_stats_rank
        ON player_stats (guild_id, total_points DESC);

      -- Index for most-active-player stat
      CREATE INDEX IF NOT EXISTS idx_player_stats_sessions
        ON player_stats (guild_id, session_count DESC);

      -- Per-guild question performance tracking.
      -- Updated asynchronously after player_stats.
      CREATE TABLE IF NOT EXISTS question_stats (
        guild_id          TEXT    NOT NULL,
        question_id       TEXT    NOT NULL,
        times_appeared    INTEGER NOT NULL DEFAULT 0,
        correct_count     INTEGER NOT NULL DEFAULT 0,
        zero_vote_count   INTEGER NOT NULL DEFAULT 0,   -- questions where nobody voted
        total_speed_ms    INTEGER NOT NULL DEFAULT 0,   -- sum of first-correct ms timestamps (for avg)
        PRIMARY KEY (guild_id, question_id)
      );

      -- Index for stat lookups and hardest-question queries
      CREATE INDEX IF NOT EXISTS idx_question_stats_lookup
        ON question_stats (guild_id, question_id);

      CREATE INDEX IF NOT EXISTS idx_question_stats_rate
        ON question_stats (guild_id, times_appeared, correct_count);
    `);
  },

  // ── Version 2: Example future migration (append here when needed) ──────────
  // function migration_v2() {
  //   db.exec(`ALTER TABLE player_stats ADD COLUMN new_column TEXT DEFAULT 'value';`);
  // },

];

// ─── Init & migration runner ───────────────────────────────────────────────

function initDb() {
  const dbPath = path.resolve(config.databasePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Performance pragmas — set before any schema work
  db.pragma('journal_mode = WAL');      // WAL mode for concurrent reads
  db.pragma('synchronous = NORMAL');    // Safe balance of durability and speed
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -32000');     // 32 MB page cache
  db.pragma('busy_timeout = 5000');     // Wait up to 5s if DB is locked

  const currentVersion = db.pragma('user_version', { simple: true });
  const targetVersion  = config.schemaVersion;

  if (currentVersion === targetVersion) {
    console.log(`[DB] Schema up to date (v${targetVersion}).`);
    return db;
  }

  if (currentVersion > targetVersion) {
    throw new Error(
      `[DB] DB version (${currentVersion}) is ahead of code schemaVersion (${targetVersion}). ` +
      `Did you downgrade the bot? Aborting to prevent data corruption.`
    );
  }

  // Run each pending migration in a transaction
  for (let v = currentVersion; v < targetVersion; v++) {
    const migrateFn = MIGRATIONS[v];
    if (!migrateFn) {
      throw new Error(`[DB] Missing migration function for version ${v + 1}. Add it to MIGRATIONS array.`);
    }

    console.log(`[DB] Applying migration: v${v} → v${v + 1}...`);

    const runMigration = db.transaction(() => {
      migrateFn();
      db.pragma(`user_version = ${v + 1}`);
    });

    runMigration();
    console.log(`[DB] Migration to v${v + 1} complete.`);
  }

  console.log(`[DB] All migrations applied. Schema is now v${targetVersion}.`);
  return db;
}

// ─── Utility: run a block inside a transaction ─────────────────────────────
// Used by gameEngine.js for atomic session archiving.

function runTransaction(fn) {
  return getDb().transaction(fn)();
}

module.exports = { initDb, getDb, runTransaction };
