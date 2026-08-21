'use strict';
/**
 * database/queries.js
 * All prepared-statement query helpers for Arabic Trivia Bot.
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
 * @param {string} guildId
 * @param {object} fields - column→value pairs to write
 */
function upsertGuildSettings(guildId, fields) {
  const db       = getDb();
  const existing = getGuildSettings(guildId);

  if (!existing) {
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

function getSessionsByGuild(guildId) {
  return getDb()
    .prepare('SELECT * FROM session_history WHERE guild_id = ? ORDER BY ended_at ASC')
    .all(guildId);
}

function countSessionsByGuild(guildId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM session_history WHERE guild_id = ?')
    .get(guildId)?.cnt ?? 0;
}

function getTotalSessionsCount() {
  return getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM session_history')
    .get()?.cnt ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAYER STATS
// ═══════════════════════════════════════════════════════════════════════════

function getPlayerStats(guildId, userId) {
  return getDb()
    .prepare('SELECT * FROM player_stats WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId) ?? null;
}

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

function setPlayerAchievements(guildId, userId, achievementsJson) {
  getDb().prepare(`
    UPDATE player_stats
    SET achievements = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(achievementsJson, guildId, userId);
}

function getCategoryCorrectCounts(guildId, userId) {
  const rows = getDb().prepare(
    'SELECT questions_data FROM session_history WHERE guild_id = ?'
  ).all(guildId);

  const counts = {};
  for (const row of rows) {
    let questions;
    try { questions = JSON.parse(row.questions_data ?? '[]'); } catch { continue; }
    for (const q of questions) {
      if (q.skipped) continue;
      const vote = q.playerAnswers?.[userId];
      if (vote && vote.answerIndex === q.correctAnswer) {
        counts[q.category] = (counts[q.category] ?? 0) + 1;
      }
    }
  }
  return counts;
}

function getAllTimeLeaderboard(guildId, limit = 10) {
  return getDb().prepare(`
    SELECT user_id, total_points, session_count, win_count
    FROM player_stats
    WHERE guild_id = ?
    ORDER BY total_points DESC
    LIMIT ?
  `).all(guildId, limit);
}

function getGlobalLeaderboard(limit = 10) {
  return getDb().prepare(`
    SELECT user_id, SUM(total_points) as total_points, SUM(session_count) as session_count, SUM(win_count) as win_count
    FROM player_stats
    GROUP BY user_id
    ORDER BY total_points DESC
    LIMIT ?
  `).all(limit);
}

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

function getTotalPlayers(guildId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS cnt FROM player_stats WHERE guild_id = ?')
    .get(guildId)?.cnt ?? 0;
}

function getTotalGlobalPlayers() {
  return getDb()
    .prepare('SELECT COUNT(DISTINCT user_id) AS cnt FROM player_stats')
    .get()?.cnt ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// TIME-RANGE LEADERBOARD
// ═══════════════════════════════════════════════════════════════════════════

function getTimeRangeLeaderboard(guildId, fromTs, toTs, limit = 10) {
  const rows = getDb().prepare(`
    SELECT scores_data
    FROM session_history
    WHERE guild_id = ?
      AND ended_at >= ?
      AND ended_at <= ?
  `).all(guildId, fromTs, toTs);

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

function getGuildStats(guildId) {
  const db = getDb();

  const sessionCount = db
    .prepare('SELECT COUNT(*) AS cnt FROM session_history WHERE guild_id = ?')
    .get(guildId)?.cnt ?? 0;

  const totalQuestions = db
    .prepare('SELECT COALESCE(SUM(question_count), 0) AS cnt FROM session_history WHERE guild_id = ?')
    .get(guildId)?.cnt ?? 0;

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

  const activePlayer = db.prepare(`
    SELECT user_id, session_count
    FROM player_stats
    WHERE guild_id = ?
    ORDER BY session_count DESC
    LIMIT 1
  `).get(guildId) ?? null;

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

  const mostMissed = db.prepare(`
    SELECT question_id, zero_vote_count
    FROM question_stats
    WHERE guild_id = ?
    ORDER BY zero_vote_count DESC
    LIMIT 1
  `).get(guildId) ?? null;

  return { sessionCount, totalQuestions, topCat, avgPlayers, activePlayer, hardest, mostMissed };
}

// ═══════════════════════════════════════════════════════════════════════════
// ECONOMY, LEVELING & INVENTORY
// ═══════════════════════════════════════════════════════════════════════════

function getUserEconomy(guildId, userId) {
  const row = getDb().prepare(`
    SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?
  `).get(guildId, userId);

  if (!row) {
    getDb().prepare(`
      INSERT OR IGNORE INTO user_economy
        (guild_id, user_id, coins, gems, xp, level, daily_streak, last_daily_ts, total_earned, items_used)
      VALUES (?, ?, 150, 0, 0, 1, 0, 0, 150, 0)
    `).run(guildId, userId);

    return getDb().prepare(`
      SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId);
  }

  return row;
}

function addCoinsAndXp(guildId, userId, coinsDelta, xpDelta, description = 'Game Reward') {
  const db = getDb();
  getUserEconomy(guildId, userId); // ensure exists

  const user = db.prepare(`SELECT * FROM user_economy WHERE guild_id = ? AND user_id = ?`).get(guildId, userId);
  const newCoins = Math.max(0, user.coins + coinsDelta);
  const newEarned = coinsDelta > 0 ? user.total_earned + coinsDelta : user.total_earned;
  let newXp = user.xp + xpDelta;
  let newLevel = user.level;

  // Level curve: xp required for level L = 100 * L^1.4
  let xpForNext = Math.round(100 * Math.pow(newLevel, 1.4));
  let leveledUp = false;
  while (newXp >= xpForNext) {
    newXp -= xpForNext;
    newLevel++;
    leveledUp = true;
    xpForNext = Math.round(100 * Math.pow(newLevel, 1.4));
  }

  db.prepare(`
    UPDATE user_economy
    SET coins = ?, xp = ?, level = ?, total_earned = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(newCoins, newXp, newLevel, newEarned, guildId, userId);

  if (coinsDelta !== 0) {
    db.prepare(`
      INSERT INTO economy_transactions (guild_id, user_id, type, amount, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(guildId, userId, coinsDelta > 0 ? 'reward' : 'spend', coinsDelta, description, Date.now());
  }

  return { newCoins, newLevel, newXp, leveledUp };
}

function processDailyClaim(guildId, userId) {
  const user = getUserEconomy(guildId, userId);
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const twoDaysMs = 48 * 60 * 60 * 1000;

  const diff = now - user.last_daily_ts;
  if (diff < oneDayMs && user.last_daily_ts !== 0) {
    const nextAvailable = user.last_daily_ts + oneDayMs;
    return { success: false, waitMs: nextAvailable - now, nextAvailable };
  }

  // Calculate streak
  let newStreak = user.daily_streak;
  if (diff <= twoDaysMs && user.last_daily_ts !== 0) {
    newStreak += 1;
  } else {
    newStreak = 1;
  }

  const baseReward = 100;
  const streakBonus = Math.min(newStreak * 25, 250);
  const totalReward = baseReward + streakBonus;

  const db = getDb();
  db.prepare(`
    UPDATE user_economy
    SET coins = coins + ?, daily_streak = ?, last_daily_ts = ?, total_earned = total_earned + ?
    WHERE guild_id = ? AND user_id = ?
  `).run(totalReward, newStreak, now, totalReward, guildId, userId);

  db.prepare(`
    INSERT INTO economy_transactions (guild_id, user_id, type, amount, description, created_at)
    VALUES (?, ?, 'daily', ?, ?, ?)
  `).run(guildId, userId, totalReward, `المكافأة اليومية - سلسلة ${newStreak} يوم`, now);

  return { success: true, reward: totalReward, streak: newStreak };
}

function getUserInventory(guildId, userId) {
  return getDb().prepare(`
    SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? AND count > 0
  `).all(guildId, userId);
}

function addItemToInventory(guildId, userId, itemId, count = 1, price = 0) {
  const db = getDb();
  const user = getUserEconomy(guildId, userId);

  if (price > 0 && user.coins < price * count) {
    return { success: false, reason: 'insufficient_coins', currentCoins: user.coins };
  }

  const runTx = db.transaction(() => {
    if (price > 0) {
      db.prepare(`
        UPDATE user_economy SET coins = coins - ? WHERE guild_id = ? AND user_id = ?
      `).run(price * count, guildId, userId);

      db.prepare(`
        INSERT INTO economy_transactions (guild_id, user_id, type, amount, description, created_at)
        VALUES (?, ?, 'purchase', ?, ?, ?)
      `).run(guildId, userId, -(price * count), `شراء عنصر ${itemId} x${count}`, Date.now());
    }

    db.prepare(`
      INSERT INTO user_inventory (guild_id, user_id, item_id, count, purchased_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET
        count = count + excluded.count
    `).run(guildId, userId, itemId, count, Date.now());
  });

  runTx();
  return { success: true };
}

function useItemFromInventory(guildId, userId, itemId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ? AND count > 0
  `).get(guildId, userId, itemId);

  if (!row) {
    return { success: false, reason: 'item_not_found' };
  }

  db.prepare(`
    UPDATE user_inventory SET count = count - 1 WHERE id = ?
  `).run(row.id);

  db.prepare(`
    UPDATE user_economy SET items_used = items_used + 1 WHERE guild_id = ? AND user_id = ?
  `).run(guildId, userId);

  return { success: true };
}

function transferCoins(guildId, senderId, receiverId, amount) {
  if (amount <= 0) return { success: false, reason: 'invalid_amount' };
  if (senderId === receiverId) return { success: false, reason: 'self_transfer' };

  const db = getDb();
  const sender = getUserEconomy(guildId, senderId);
  if (sender.coins < amount) {
    return { success: false, reason: 'insufficient_coins', currentCoins: sender.coins };
  }

  getUserEconomy(guildId, receiverId); // ensure receiver exists

  const tx = db.transaction(() => {
    db.prepare(`UPDATE user_economy SET coins = coins - ? WHERE guild_id = ? AND user_id = ?`).run(amount, guildId, senderId);
    db.prepare(`UPDATE user_economy SET coins = coins + ? WHERE guild_id = ? AND user_id = ?`).run(amount, guildId, receiverId);

    const now = Date.now();
    db.prepare(`
      INSERT INTO economy_transactions (guild_id, user_id, type, amount, description, created_at)
      VALUES (?, ?, 'transfer_send', ?, ?, ?)
    `).run(guildId, senderId, -amount, `تحويل إلى <@${receiverId}>`, now);

    db.prepare(`
      INSERT INTO economy_transactions (guild_id, user_id, type, amount, description, created_at)
      VALUES (?, ?, 'transfer_recv', ?, ?, ?)
    `).run(guildId, receiverId, amount, `استلام من <@${senderId}>`, now);
  });

  tx();
  return { success: true };
}

function getTopEconomyPlayers(guildId, limit = 10) {
  return getDb().prepare(`
    SELECT user_id, coins, level, xp, daily_streak
    FROM user_economy
    WHERE guild_id = ?
    ORDER BY coins DESC
    LIMIT ?
  `).all(guildId, limit);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLANS SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

function createClan(guildId, leaderId, name, tag, bannerEmoji = '🛡️', description = '') {
  const db = getDb();
  try {
    const clanId = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO clans (guild_id, name, tag, banner_emoji, description, leader_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(guildId, name, tag.toUpperCase(), bannerEmoji, description, leaderId, Date.now());

      db.prepare(`
        INSERT INTO clan_members (guild_id, clan_id, user_id, role, points_contrib, joined_at)
        VALUES (?, ?, ?, 'leader', 0, ?)
      `).run(guildId, info.lastInsertRowid, leaderId, Date.now());

      return info.lastInsertRowid;
    })();

    return { success: true, clanId };
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return { success: false, reason: 'already_exists' };
    }
    throw err;
  }
}

function getClanById(clanId) {
  return getDb().prepare('SELECT * FROM clans WHERE id = ?').get(clanId) ?? null;
}

function getClanByTag(guildId, tag) {
  return getDb().prepare('SELECT * FROM clans WHERE guild_id = ? AND tag = ?').get(guildId, tag.toUpperCase()) ?? null;
}

function getUserClan(guildId, userId) {
  return getDb().prepare(`
    SELECT c.*, cm.role, cm.points_contrib, cm.joined_at
    FROM clan_members cm
    JOIN clans c ON c.id = cm.clan_id
    WHERE cm.guild_id = ? AND cm.user_id = ?
  `).get(guildId, userId) ?? null;
}

function getClanMembers(clanId) {
  return getDb().prepare(`
    SELECT user_id, role, points_contrib, joined_at
    FROM clan_members
    WHERE clan_id = ?
    ORDER BY points_contrib DESC
  `).all(clanId);
}

function addClanMember(guildId, clanId, userId) {
  const existing = getUserClan(guildId, userId);
  if (existing) return { success: false, reason: 'already_in_clan' };

  getDb().prepare(`
    INSERT INTO clan_members (guild_id, clan_id, user_id, role, points_contrib, joined_at)
    VALUES (?, ?, ?, 'member', 0, ?)
  `).run(guildId, clanId, userId, Date.now());

  return { success: true };
}

function removeClanMember(guildId, userId) {
  const member = getUserClan(guildId, userId);
  if (!member) return { success: false, reason: 'not_in_clan' };

  if (member.role === 'leader') {
    // Delete clan if leader leaves
    getDb().transaction(() => {
      getDb().prepare('DELETE FROM clan_members WHERE clan_id = ?').run(member.id);
      getDb().prepare('DELETE FROM clans WHERE id = ?').run(member.id);
    })();
    return { success: true, clanDisbanded: true };
  }

  getDb().prepare('DELETE FROM clan_members WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
  return { success: true, clanDisbanded: false };
}

function addClanPoints(guildId, userId, points) {
  const clan = getUserClan(guildId, userId);
  if (!clan) return;

  getDb().transaction(() => {
    getDb().prepare(`
      UPDATE clan_members SET points_contrib = points_contrib + ? WHERE guild_id = ? AND user_id = ?
    `).run(points, guildId, userId);

    getDb().prepare(`
      UPDATE clans SET score = score + ? WHERE id = ?
    `).run(points, clan.id);
  })();
}

function getTopClans(guildId, limit = 10) {
  return getDb().prepare(`
    SELECT c.*, COUNT(cm.user_id) as member_count
    FROM clans c
    LEFT JOIN clan_members cm ON cm.clan_id = c.id
    WHERE c.guild_id = ?
    GROUP BY c.id
    ORDER BY c.score DESC
    LIMIT ?
  `).all(guildId, limit);
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM PACKS & QUESTIONS
// ═══════════════════════════════════════════════════════════════════════════

function createCustomPack(guildId, packName, displayName, description, iconEmoji, createdBy) {
  try {
    const info = getDb().prepare(`
      INSERT INTO custom_packs (guild_id, pack_name, display_name, description, icon_emoji, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, packName.toLowerCase().trim(), displayName, description, iconEmoji, createdBy, Date.now());
    return { success: true, id: info.lastInsertRowid };
  } catch (err) {
    if (err.message.includes('UNIQUE')) return { success: false, reason: 'pack_exists' };
    throw err;
  }
}

function getCustomPacks(guildId) {
  return getDb().prepare(`
    SELECT cp.*, COUNT(cq.id) as question_count
    FROM custom_packs cp
    LEFT JOIN custom_questions cq ON cq.guild_id = cp.guild_id AND cq.pack_name = cp.pack_name
    WHERE cp.guild_id = ?
    GROUP BY cp.id
    ORDER BY cp.created_at DESC
  `).all(guildId);
}

function insertCustomQuestion(question) {
  return getDb().prepare(`
    INSERT INTO custom_questions
      (id, guild_id, pack_name, category, difficulty, text, options, correct_answer, image_url, created_by, is_approved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    question.id,
    question.guildId,
    question.packName ?? 'general',
    question.category ?? 'custom',
    question.difficulty ?? 'medium',
    question.text,
    JSON.stringify(question.options),
    question.correctAnswer,
    question.imageUrl ?? null,
    question.createdBy,
    Date.now()
  );
}

function getCustomQuestionsByPack(guildId, packName) {
  const rows = getDb().prepare(`
    SELECT * FROM custom_questions WHERE guild_id = ? AND pack_name = ? AND is_approved = 1
  `).all(guildId, packName);

  return rows.map(r => ({
    id: r.id,
    category: r.category,
    difficulty: r.difficulty,
    text: r.text,
    options: JSON.parse(r.options),
    correctAnswer: r.correct_answer,
    imageUrl: r.image_url,
    createdBy: r.created_by,
  }));
}

function getAllCustomQuestions(guildId) {
  return getDb().prepare(`
    SELECT * FROM custom_questions WHERE guild_id = ? ORDER BY created_at DESC
  `).all(guildId);
}

function deleteCustomQuestion(guildId, questionId) {
  return getDb().prepare(`
    DELETE FROM custom_questions WHERE guild_id = ? AND id = ?
  `).run(guildId, questionId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1v1 DUELS
// ═══════════════════════════════════════════════════════════════════════════

function createDuel(guildId, challengerId, opponentId, stake, category, questions) {
  const info = getDb().prepare(`
    INSERT INTO duels (guild_id, challenger_id, opponent_id, stake, category, challenger_score, opponent_score, status, questions_data, played_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', ?, ?)
  `).run(guildId, challengerId, opponentId, stake, category, JSON.stringify(questions), Date.now());

  return info.lastInsertRowid;
}

function getDuelById(duelId) {
  const row = getDb().prepare('SELECT * FROM duels WHERE id = ?').get(duelId);
  if (row) {
    try { row.questions = JSON.parse(row.questions_data); } catch { row.questions = []; }
  }
  return row ?? null;
}

function updateDuel(duelId, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE duels SET ${sets} WHERE id = ?`).run(...Object.values(updates), duelId);
}

// ═══════════════════════════════════════════════════════════════════════════
// DAILY & WEEKLY QUESTS
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_QUEST_TEMPLATES = [
  { id: 'daily_answers_5', title: '🎯 الإجابة على 5 أسئلة صحيحة', type: 'correct_answers', target: 5, rewardCoins: 60, rewardXp: 80 },
  { id: 'daily_streak_3', title: '🔥 تحقيق سلسلة 3 إجابات متتالية', type: 'streak', target: 3, rewardCoins: 80, rewardXp: 100 },
  { id: 'daily_sessions_2', title: '🕹️ المشاركة في جلستين مسابقة', type: 'play_sessions', target: 2, rewardCoins: 70, rewardXp: 90 },
  { id: 'daily_points_50', title: '💰 جمع 50 نقطة في المسابقات', type: 'earn_points', target: 50, rewardCoins: 100, rewardXp: 120 }
];

function getUserQuests(guildId, userId) {
  const db = getDb();
  const now = Date.now();

  // Expire old quests
  db.prepare(`
    DELETE FROM user_quests WHERE guild_id = ? AND user_id = ? AND expires_at < ?
  `).run(guildId, userId, now);

  let quests = db.prepare(`
    SELECT * FROM user_quests WHERE guild_id = ? AND user_id = ?
  `).all(guildId, userId);

  // If user has no active quests, generate daily quests (expires in 24h)
  if (quests.length === 0) {
    const tomorrowMidnight = new Date();
    tomorrowMidnight.setUTCHours(23, 59, 59, 999);
    const expiresAt = tomorrowMidnight.getTime();

    for (const t of DEFAULT_QUEST_TEMPLATES) {
      db.prepare(`
        INSERT OR IGNORE INTO user_quests
          (guild_id, user_id, quest_id, title_ar, quest_type, current_progress, target, reward_coins, reward_xp, is_completed, expires_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?)
      `).run(guildId, userId, t.id, t.title, t.type, t.target, t.rewardCoins, t.rewardXp, expiresAt);
    }

    quests = db.prepare(`
      SELECT * FROM user_quests WHERE guild_id = ? AND user_id = ?
    `).all(guildId, userId);
  }

  return quests;
}

function updateQuestProgress(guildId, userId, questType, increment) {
  const db = getDb();
  db.prepare(`
    UPDATE user_quests
    SET current_progress = MIN(target, current_progress + ?)
    WHERE guild_id = ? AND user_id = ? AND quest_type = ? AND is_completed = 0
  `).run(increment, guildId, userId, questType);
}

function claimQuestReward(guildId, userId, questId) {
  const db = getDb();
  const quest = db.prepare(`
    SELECT * FROM user_quests WHERE guild_id = ? AND user_id = ? AND quest_id = ?
  `).get(guildId, userId, questId);

  if (!quest) return { success: false, reason: 'not_found' };
  if (quest.current_progress < quest.target) return { success: false, reason: 'not_finished' };
  if (quest.is_completed) return { success: false, reason: 'already_claimed' };

  db.transaction(() => {
    db.prepare(`
      UPDATE user_quests SET is_completed = 1 WHERE id = ?
    `).run(quest.id);

    addCoinsAndXp(guildId, userId, quest.reward_coins, quest.reward_xp, `مكافأة مهمة: ${quest.title_ar}`);
  })();

  return { success: true, rewardCoins: quest.reward_coins, rewardXp: quest.reward_xp };
}

// ═══════════════════════════════════════════════════════════════════════════
// SEASONS & BATTLE PASS
// ═══════════════════════════════════════════════════════════════════════════

function getActiveSeason() {
  let season = getDb().prepare('SELECT * FROM seasons WHERE is_active = 1 LIMIT 1').get();
  if (!season) {
    const now = Date.now();
    const seasonEnd = now + (30 * 24 * 60 * 60 * 1000); // 30 days
    getDb().prepare(`
      INSERT INTO seasons (season_number, title, theme, starts_at, ends_at, is_active)
      VALUES (1, 'الموسم الأول: فجر المعرفة', 'الرموز والأساطير العربية', ?, ?, 1)
    `).run(now, seasonEnd);

    season = getDb().prepare('SELECT * FROM seasons WHERE season_number = 1').get();
  }
  return season;
}

function getSeasonPass(guildId, userId, seasonNumber = 1) {
  const db = getDb();
  let pass = db.prepare(`
    SELECT * FROM season_passes WHERE guild_id = ? AND user_id = ? AND season_number = ?
  `).get(guildId, userId, seasonNumber);

  if (!pass) {
    db.prepare(`
      INSERT OR IGNORE INTO season_passes (guild_id, user_id, season_number, xp, tier, is_vip, claimed_rewards)
      VALUES (?, ?, ?, 0, 1, 0, '[]')
    `).run(guildId, userId, seasonNumber);

    pass = db.prepare(`
      SELECT * FROM season_passes WHERE guild_id = ? AND user_id = ? AND season_number = ?
    `).get(guildId, userId, seasonNumber);
  }

  return pass;
}

function addSeasonXp(guildId, userId, xpAmount) {
  const season = getActiveSeason();
  if (!season) return;

  const db = getDb();
  const pass = getSeasonPass(guildId, userId, season.season_number);
  const newXp = pass.xp + xpAmount;
  const newTier = Math.min(20, Math.floor(newXp / 150) + 1);

  db.prepare(`
    UPDATE season_passes SET xp = ?, tier = ? WHERE guild_id = ? AND user_id = ? AND season_number = ?
  `).run(newXp, newTier, guildId, userId, season.season_number);
}

// ═══════════════════════════════════════════════════════════════════════════
// CORRUPTION DETECTION & REBUILD
// ═══════════════════════════════════════════════════════════════════════════

function getGuildsWithOrphanedHistory() {
  return getDb().prepare(`
    SELECT DISTINCT sh.guild_id
    FROM session_history sh
    WHERE NOT EXISTS (
      SELECT 1 FROM player_stats ps WHERE ps.guild_id = sh.guild_id
    )
  `).all().map(r => r.guild_id);
}

function rebuildPlayerStatsForGuild(guildId) {
  const db       = getDb();
  const sessions = db
    .prepare('SELECT * FROM session_history WHERE guild_id = ? ORDER BY ended_at ASC')
    .all(guildId);

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

      for (const q of questionsData) {
        if (q.skipped) continue;
        if (q.playerAnswers?.[userId]?.answerIndex === q.correctAnswer) {
          s.answers += 1;
        }
        if (q.speedWinners?.includes(userId)) {
          s.speedFirstCount += 1;
        }
      }
    }
  }

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
  getTotalSessionsCount,

  // Player stats
  getPlayerStats,
  upsertPlayerStats,
  setPlayerAchievements,
  getCategoryCorrectCounts,
  getAllTimeLeaderboard,
  getGlobalLeaderboard,
  getPlayerRank,
  getTotalPlayers,
  getTotalGlobalPlayers,

  // Time-range leaderboard
  getTimeRangeLeaderboard,

  // Question stats
  upsertQuestionStats,

  // Guild statistics
  getGuildStats,

  // Economy & Inventory
  getUserEconomy,
  addCoinsAndXp,
  processDailyClaim,
  getUserInventory,
  addItemToInventory,
  useItemFromInventory,
  transferCoins,
  getTopEconomyPlayers,

  // Clans
  createClan,
  getClanById,
  getClanByTag,
  getUserClan,
  getClanMembers,
  addClanMember,
  removeClanMember,
  addClanPoints,
  getTopClans,

  // Custom Packs & Questions
  createCustomPack,
  getCustomPacks,
  insertCustomQuestion,
  getCustomQuestionsByPack,
  getAllCustomQuestions,
  deleteCustomQuestion,

  // Duels
  createDuel,
  getDuelById,
  updateDuel,

  // Quests
  getUserQuests,
  updateQuestProgress,
  claimQuestReward,

  // Seasons
  getActiveSeason,
  getSeasonPass,
  addSeasonXp,

  // Corruption detection & rebuild
  getGuildsWithOrphanedHistory,
  rebuildPlayerStatsForGuild,
};
