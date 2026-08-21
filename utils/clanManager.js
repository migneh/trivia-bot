'use strict';
/**
 * utils/clanManager.js
 * Clan system logic, clan level calculation and rewards.
 */

const queries = require('../database/queries');

/**
 * Format clan tag: [TAG]
 * @param {string} tag
 * @returns {string}
 */
function formatClanTag(tag) {
  return `[${tag.toUpperCase()}]`;
}

/**
 * Calculate clan level based on score
 * Clan level: 1 + floor(score / 500)
 * @param {number} score
 * @returns {number}
 */
function getClanLevel(score) {
  return Math.max(1, Math.floor(score / 500) + 1);
}

/**
 * Create a new clan
 * @param {string} guildId
 * @param {string} leaderId
 * @param {string} name
 * @param {string} tag
 * @param {string} bannerEmoji
 * @param {string} description
 * @returns {object}
 */
function createNewClan(guildId, leaderId, name, tag, bannerEmoji = '🛡️', description = '') {
  // Validate tag length (2 to 5 characters, alphanumeric)
  const cleanTag = tag.trim().toUpperCase();
  if (cleanTag.length < 2 || cleanTag.length > 5) {
    return { success: false, reason: 'invalid_tag_length' };
  }

  // Validate name length (3 to 24 characters)
  const cleanName = name.trim();
  if (cleanName.length < 3 || cleanName.length > 24) {
    return { success: false, reason: 'invalid_name_length' };
  }

  // Check if leader is already in a clan
  const existingClan = queries.getUserClan(guildId, leaderId);
  if (existingClan) {
    return { success: false, reason: 'already_in_clan' };
  }

  // Check if user has enough coins (e.g. 500 coins to create a clan)
  const economy = queries.getUserEconomy(guildId, leaderId);
  const clanCost = 500;
  if (economy.coins < clanCost) {
    return { success: false, reason: 'insufficient_coins', cost: clanCost, currentCoins: economy.coins };
  }

  // Deduct cost and create clan
  queries.addCoinsAndXp(guildId, leaderId, -clanCost, 50, `إنشاء كلان ${cleanName}`);
  const result = queries.createClan(guildId, leaderId, cleanName, cleanTag, bannerEmoji, description);

  return result;
}

module.exports = {
  formatClanTag,
  getClanLevel,
  createNewClan,
};
