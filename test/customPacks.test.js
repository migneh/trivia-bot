'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const queries = require('../database/queries');
const customManager = require('../utils/customPacksManager');
const { initDb } = require('../database/schema');

test('Custom Packs & Questions Unit Tests', async (t) => {
  initDb();
  const rand = Math.floor(Math.random() * 100000);
  const guildId = `test_guild_custom_${rand}`;
  const userId = `admin_user_${rand}`;
  const packName = `geo_${rand}`;

  await t.test('validateCustomQuestion checks options and text', () => {
    const invalid = customManager.validateCustomQuestion({
      text: 'قصيرة',
      options: ['1', '2'],
      correctAnswer: 0
    });
    assert.equal(invalid.valid, false);

    const valid = customManager.validateCustomQuestion({
      text: 'ما هي عاصمة المملكة العربية السعودية؟',
      options: ['الرياض', 'جدة', 'الدمام', 'مكة'],
      correctAnswer: 0
    });
    assert.equal(valid.valid, true);
  });

  await t.test('createPack and addCustomQuestion persists to database', () => {
    const packRes = customManager.createPack(guildId, userId, packName, 'جغرافيا العرب', 'حزمة مخصصة');
    assert.equal(packRes.success, true);

    const addRes = customManager.addCustomQuestion(guildId, userId, {
      packName,
      text: 'ما هو أطول نهر في الوطن العربي؟',
      options: ['نهر النيل', 'نهر دجلة', 'نهر الفرات', 'نهر الأردن'],
      correctAnswer: 0,
      difficulty: 'easy'
    });
    assert.equal(addRes.success, true);

    const packQuestions = queries.getCustomQuestionsByPack(guildId, packName);
    assert.equal(packQuestions.length, 1);
    assert.equal(packQuestions[0].correctAnswer, 0);
  });
});
