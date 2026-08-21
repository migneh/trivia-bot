'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const queries = require('../database/queries');
const economyManager = require('../utils/economyManager');
const { initDb } = require('../database/schema');

test('Economy & Shop Unit Tests', async (t) => {
  initDb();
  const rand = Math.floor(Math.random() * 100000);
  const guildId = `test_guild_econ_${rand}`;
  const userId1 = `user_econ_1_${rand}`;
  const userId2 = `user_econ_2_${rand}`;

  await t.test('getUserEconomy creates user with starting balance', () => {
    const user = queries.getUserEconomy(guildId, userId1);
    assert.equal(typeof user.coins, 'number');
    assert.ok(user.coins >= 100);
    assert.equal(user.level, 1);
  });

  await t.test('addCoinsAndXp correctly calculates level up and rewards', () => {
    const res = queries.addCoinsAndXp(guildId, userId1, 50, 300, 'Test reward');
    assert.equal(typeof res.newCoins, 'number');
    assert.ok(res.newLevel >= 1);
  });

  await t.test('transferCoins moves balance between users safely', () => {
    queries.addCoinsAndXp(guildId, userId1, 200, 0);
    const beforeSender = queries.getUserEconomy(guildId, userId1).coins;
    const beforeRecv = queries.getUserEconomy(guildId, userId2).coins;

    const res = queries.transferCoins(guildId, userId1, userId2, 50);
    assert.equal(res.success, true);

    const afterSender = queries.getUserEconomy(guildId, userId1).coins;
    const afterRecv = queries.getUserEconomy(guildId, userId2).coins;

    assert.equal(afterSender, beforeSender - 50);
    assert.equal(afterRecv, beforeRecv + 50);
  });

  await t.test('transferCoins rejects self transfer and insufficient balance', () => {
    const selfRes = queries.transferCoins(guildId, userId1, userId1, 10);
    assert.equal(selfRes.success, false);
    assert.equal(selfRes.reason, 'self_transfer');

    const poorRes = queries.transferCoins(guildId, userId1, userId2, 999999);
    assert.equal(poorRes.success, false);
    assert.equal(poorRes.reason, 'insufficient_coins');
  });

  await t.test('Shop item purchases and inventory management', () => {
    queries.addCoinsAndXp(guildId, userId1, 1000, 0);
    const buyRes = economyManager.buyItem(guildId, userId1, 'fifty_fifty', 1);
    assert.equal(buyRes.success, true);

    const inv = queries.getUserInventory(guildId, userId1);
    const item = inv.find(i => i.item_id === 'fifty_fifty');
    assert.ok(item);
    assert.ok(item.count >= 1);

    const useRes = economyManager.useItem(guildId, userId1, 'fifty_fifty');
    assert.equal(useRes.success, true);
  });
});
