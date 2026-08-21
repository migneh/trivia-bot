'use strict';
/**
 * utils/customPacksManager.js
 * Custom question packs & community trivia packs manager.
 */

const queries = require('../database/queries');
const crypto  = require('node:crypto');

/**
 * Validate a custom question object
 * @param {object} q
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCustomQuestion(q) {
  if (!q.text || typeof q.text !== 'string' || q.text.trim().length < 5) {
    return { valid: false, error: 'نص السؤال قصير جداً (أقل من 5 أحرف).' };
  }
  if (!Array.isArray(q.options) || q.options.length !== 4) {
    return { valid: false, error: 'يجب توفير 4 خيارات بالضبط.' };
  }
  for (let i = 0; i < 4; i++) {
    if (typeof q.options[i] !== 'string' || q.options[i].trim().length === 0) {
      return { valid: false, error: `الخيار رقم ${i + 1} فارغ.` };
    }
    if (q.options[i].length > 80) {
      return { valid: false, error: `الخيار رقم ${i + 1} يتجاوز 80 حرفاً.` };
    }
  }
  if (typeof q.correctAnswer !== 'number' || q.correctAnswer < 0 || q.correctAnswer > 3) {
    return { valid: false, error: 'يجب تحديد رقم الإجابة الصحيحة بين 0 و 3.' };
  }
  return { valid: true };
}

/**
 * Add a custom question to a guild pack
 * @param {string} guildId
 * @param {string} userId
 * @param {object} data
 * @returns {object}
 */
function addCustomQuestion(guildId, userId, data) {
  const validation = validateCustomQuestion(data);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const id = `custom_${guildId.slice(-4)}_${crypto.randomBytes(4).toString('hex')}`;
  const packName = (data.packName || 'general').toLowerCase().trim();

  try {
    queries.insertCustomQuestion({
      id,
      guildId,
      packName,
      category: data.category || 'custom',
      difficulty: data.difficulty || 'medium',
      text: data.text.trim(),
      options: data.options.map(o => o.trim()),
      correctAnswer: data.correctAnswer,
      imageUrl: data.imageUrl || null,
      createdBy: userId,
    });

    return { success: true, id, packName };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Create a new custom pack for a guild
 * @param {string} guildId
 * @param {string} userId
 * @param {string} packName
 * @param {string} displayName
 * @param {string} description
 * @param {string} iconEmoji
 * @returns {object}
 */
function createPack(guildId, userId, packName, displayName, description = '', iconEmoji = '📦') {
  const cleanPackName = packName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!cleanPackName || cleanPackName.length < 2) {
    return { success: false, error: 'اسم الحزمة يجب أن يكون بالإنجليزية من حرفين على الأقل.' };
  }

  return queries.createCustomPack(guildId, cleanPackName, displayName, description, iconEmoji, userId);
}

module.exports = {
  validateCustomQuestion,
  addCustomQuestion,
  createPack,
};
