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

  // ── Version 2: Economy, XP & Leveling, Inventory ──────────────────────────
  function migration_v2() {
    db.exec(`
      -- User economy balance, XP and levels per guild
      CREATE TABLE IF NOT EXISTS user_economy (
        guild_id          TEXT    NOT NULL,
        user_id           TEXT    NOT NULL,
        coins             INTEGER NOT NULL DEFAULT 100,
        gems              INTEGER NOT NULL DEFAULT 0,
        xp                INTEGER NOT NULL DEFAULT 0,
        level             INTEGER NOT NULL DEFAULT 1,
        daily_streak      INTEGER NOT NULL DEFAULT 0,
        last_daily_ts     INTEGER NOT NULL DEFAULT 0,
        total_earned      INTEGER NOT NULL DEFAULT 100,
        items_used        INTEGER NOT NULL DEFAULT 0,
        equipped_title    TEXT    DEFAULT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_economy_coins
        ON user_economy (guild_id, coins DESC);

      CREATE INDEX IF NOT EXISTS idx_user_economy_level
        ON user_economy (guild_id, level DESC, xp DESC);

      -- User inventory for purchased items and power-ups
      CREATE TABLE IF NOT EXISTS user_inventory (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT    NOT NULL,
        user_id           TEXT    NOT NULL,
        item_id           TEXT    NOT NULL,
        count             INTEGER NOT NULL DEFAULT 1,
        purchased_at      INTEGER NOT NULL,
        UNIQUE (guild_id, user_id, item_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_inv_lookup
        ON user_inventory (guild_id, user_id);

      -- Transaction audit log
      CREATE TABLE IF NOT EXISTS economy_transactions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT    NOT NULL,
        user_id           TEXT    NOT NULL,
        type              TEXT    NOT NULL, -- reward | purchase | transfer_send | transfer_recv | daily | duel_win | duel_loss
        amount            INTEGER NOT NULL,
        description       TEXT    NOT NULL,
        created_at        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_econ_tx_user
        ON economy_transactions (guild_id, user_id, created_at DESC);
    `);
  },

  // ── Version 3: Clans & Alliances System ───────────────────────────────────
  function migration_v3() {
    db.exec(`
      -- Clans table per guild
      CREATE TABLE IF NOT EXISTS clans (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT    NOT NULL,
        name              TEXT    NOT NULL,
        tag               TEXT    NOT NULL,
        banner_emoji      TEXT    NOT NULL DEFAULT '🛡️',
        description       TEXT    DEFAULT '',
        leader_id         TEXT    NOT NULL,
        score             INTEGER NOT NULL DEFAULT 0,
        coins             INTEGER NOT NULL DEFAULT 0,
        level             INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL,
        UNIQUE (guild_id, name),
        UNIQUE (guild_id, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_clans_guild_score
        ON clans (guild_id, score DESC);

      -- Clan membership
      CREATE TABLE IF NOT EXISTS clan_members (
        guild_id          TEXT    NOT NULL,
        clan_id           INTEGER NOT NULL,
        user_id           TEXT    NOT NULL,
        role              TEXT    NOT NULL DEFAULT 'member', -- leader | coleader | elder | member
        points_contrib    INTEGER NOT NULL DEFAULT 0,
        joined_at         INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id),
        FOREIGN KEY (clan_id) REFERENCES clans(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_clan_members_lookup
        ON clan_members (clan_id, points_contrib DESC);
    `);
  },

  // ── Version 4: Custom Questions & Packs ───────────────────────────────────
  function migration_v4() {
    db.exec(`
      -- Guild custom packs
      CREATE TABLE IF NOT EXISTS custom_packs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT    NOT NULL,
        pack_name         TEXT    NOT NULL,
        display_name      TEXT    NOT NULL,
        description       TEXT    DEFAULT '',
        icon_emoji        TEXT    DEFAULT '📦',
        created_by        TEXT    NOT NULL,
        created_at        INTEGER NOT NULL,
        UNIQUE (guild_id, pack_name)
      );

      -- Custom questions added by server admins / community
      CREATE TABLE IF NOT EXISTS custom_questions (
        id                TEXT    PRIMARY KEY,
        guild_id          TEXT    NOT NULL,
        pack_name         TEXT    NOT NULL DEFAULT 'general',
        category          TEXT    NOT NULL DEFAULT 'custom',
        difficulty        TEXT    NOT NULL DEFAULT 'medium',
        text              TEXT    NOT NULL,
        options           TEXT    NOT NULL, -- JSON array of 4 options
        correct_answer    INTEGER NOT NULL, -- 0..3
        image_url         TEXT    DEFAULT NULL,
        created_by        TEXT    NOT NULL,
        is_approved       INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_custom_q_pack
        ON custom_questions (guild_id, pack_name);
    `);
  },

  // ── Version 5: Duels, Seasons, Quests & Tournaments ───────────────────────
  function migration_v5() {
    db.exec(`
      -- 1v1 Duels
      CREATE TABLE IF NOT EXISTS duels (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT    NOT NULL,
        challenger_id     TEXT    NOT NULL,
        opponent_id       TEXT    NOT NULL,
        stake             INTEGER NOT NULL DEFAULT 0,
        category          TEXT    NOT NULL DEFAULT 'general',
        challenger_score  INTEGER NOT NULL DEFAULT 0,
        opponent_score    INTEGER NOT NULL DEFAULT 0,
        winner_id         TEXT    DEFAULT NULL,
        status            TEXT    NOT NULL DEFAULT 'pending', -- pending | active | completed | declined | expired
        questions_data    TEXT    DEFAULT '[]',
        played_at         INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_duels_guild
        ON duels (guild_id, played_at DESC);

      -- Daily & Weekly Quests
      CREATE TABLE IF NOT EXISTS user_quests (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT    NOT NULL,
        user_id           TEXT    NOT NULL,
        quest_id          TEXT    NOT NULL,
        title_ar          TEXT    NOT NULL,
        quest_type        TEXT    NOT NULL, -- play_sessions | correct_answers | streak | win_duel | earn_points
        current_progress  INTEGER NOT NULL DEFAULT 0,
        target            INTEGER NOT NULL,
        reward_coins      INTEGER NOT NULL,
        reward_xp         INTEGER NOT NULL,
        is_completed      INTEGER NOT NULL DEFAULT 0,
        expires_at        INTEGER NOT NULL,
        UNIQUE (guild_id, user_id, quest_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_quests
        ON user_quests (guild_id, user_id, is_completed);

      -- Seasons & Battle Pass
      CREATE TABLE IF NOT EXISTS seasons (
        season_number     INTEGER PRIMARY KEY,
        title             TEXT    NOT NULL,
        theme             TEXT    NOT NULL,
        starts_at         INTEGER NOT NULL,
        ends_at           INTEGER NOT NULL,
        is_active         INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS season_passes (
        guild_id          TEXT    NOT NULL,
        user_id           TEXT    NOT NULL,
        season_number     INTEGER NOT NULL,
        xp                INTEGER NOT NULL DEFAULT 0,
        tier              INTEGER NOT NULL DEFAULT 1,
        is_vip            INTEGER NOT NULL DEFAULT 0,
        claimed_rewards   TEXT    NOT NULL DEFAULT '[]', -- JSON array of tier numbers claimed
        PRIMARY KEY (guild_id, user_id, season_number)
      );

      -- Tournaments
      CREATE TABLE IF NOT EXISTS tournaments (
        id                TEXT    PRIMARY KEY,
        guild_id          TEXT    NOT NULL,
        title             TEXT    NOT NULL,
        status            TEXT    NOT NULL DEFAULT 'registering', -- registering | in_progress | completed | cancelled
        max_players       INTEGER NOT NULL DEFAULT 8,
        current_round     INTEGER NOT NULL DEFAULT 1,
        bracket_json      TEXT    NOT NULL DEFAULT '{}',
        winner_id         TEXT    DEFAULT NULL,
        prize_pool        INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL
      );
    `);
  },

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
