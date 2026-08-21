'use strict';
/**
 * utils/economyManager.js
 * Economy, XP, Leveling, Shop and Inventory system.
 */

const queries = require('../database/queries');
const config  = require('../config.json');

/**
 * Get shop item definition by ID
 * @param {string} itemId
 * @returns {object|null}
 */
function getShopItem(itemId) {
  return config.shopItems?.find(item => item.id === itemId) ?? null;
}

/**
 * Get all available shop items
 * @returns {Array}
 */
function getAllShopItems() {
  return config.shopItems || [];
}

/**
 * Calculate XP required for a given level
 * Level curve: xp = round(100 * L^1.4)
 * @param {number} level
 * @returns {number}
 */
function getXpForLevel(level) {
  const base = config.economy?.levelBaseXp || 100;
  const exp = config.economy?.levelExponent || 1.4;
  return Math.round(base * Math.pow(level, exp));
}

/**
 * Award question answer rewards (Coins + XP)
 * @param {string} guildId
 * @param {string} userId
 * @param {boolean} isCorrect
 * @param {boolean} isFirstSpeed
 * @returns {object}
 */
function awardQuestionReward(guildId, userId, isCorrect, isFirstSpeed = false) {
  if (!isCorrect) return { coins: 0, xp: 0, leveledUp: false };

  let coins = config.economy?.coinsPerCorrect || 15;
  let xp = config.economy?.xpPerCorrect || 25;

  if (isFirstSpeed) {
    coins += 10;
    xp += 15;
  }

  const result = queries.addCoinsAndXp(guildId, userId, coins, xp, 'إجابة صحيحة في المسابقة');

  // Also update quest progress for correct answers
  queries.updateQuestProgress(guildId, userId, 'correct_answers', 1);

  // Also add Season XP
  queries.addSeasonXp(guildId, userId, xp);

  return { coins, xp, ...result };
}

/**
 * Award session end rewards (winner bonus + participation bonus)
 * @param {string} guildId
 * @param {string} userId
 * @param {boolean} isWinner
 * @param {number} score
 * @returns {object}
 */
function awardSessionEndReward(guildId, userId, isWinner, score) {
  let coins = isWinner ? (config.economy?.coinsPerWin || 120) : 25;
  let xp = isWinner ? (config.economy?.xpPerWin || 150) : 40;

  // Additional bonus based on score
  if (score > 0) {
    coins += Math.min(Math.floor(score / 5), 100);
    xp += Math.min(Math.floor(score / 4), 120);
  }

  const result = queries.addCoinsAndXp(
    guildId,
    userId,
    coins,
    xp,
    isWinner ? '🏆 الفوز بجلسة المسابقة' : 'المشاركة في جلسة المسابقة'
  );

  // Update quests
  queries.updateQuestProgress(guildId, userId, 'play_sessions', 1);
  if (score > 0) {
    queries.updateQuestProgress(guildId, userId, 'earn_points', Math.floor(score));
  }

  // Add clan points
  queries.addClanPoints(guildId, userId, Math.floor(score));

  // Add season XP
  queries.addSeasonXp(guildId, userId, xp);

  return { coins, xp, ...result };
}

/**
 * Buy an item from the shop
 * @param {string} guildId
 * @param {string} userId
 * @param {string} itemId
 * @param {number} count
 * @returns {object}
 */
function buyItem(guildId, userId, itemId, count = 1) {
  const item = getShopItem(itemId);
  if (!item) return { success: false, reason: 'invalid_item' };

  return queries.addItemToInventory(guildId, userId, itemId, count, item.price);
}

/**
 * Use a powerup item
 * @param {string} guildId
 * @param {string} userId
 * @param {string} itemId
 * @returns {object}
 */
function useItem(guildId, userId, itemId) {
  const item = getShopItem(itemId);
  if (!item) return { success: false, reason: 'invalid_item' };

  return queries.useItemFromInventory(guildId, userId, itemId);
}

module.exports = {
  getShopItem,
  getAllShopItems,
  getXpForLevel,
  awardQuestionReward,
  awardSessionEndReward,
  buyItem,
  useItem,
};
