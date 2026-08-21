'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const queries = require('../database/queries');
const clanManager = require('../utils/clanManager');
const { initDb } = require('../database/schema');

test('Clans & Alliances Unit Tests', async (t) => {
  initDb();
  const rand = Math.floor(Math.random() * 100000);
  const guildId = `test_guild_clans_${rand}`;
  const leaderId = `user_leader_${rand}`;
  const memberId = `user_member_${rand}`;
  const tag = `T${rand.toString().slice(-3)}`;

  await t.test('clanManager validates tag length and requirements', () => {
    const shortTag = clanManager.createNewClan(guildId, leaderId, 'الفرسان', 'X');
    assert.equal(shortTag.success, false);
    assert.equal(shortTag.reason, 'invalid_tag_length');
  });

  await t.test('createNewClan creates clan and registers leader', () => {
    queries.addCoinsAndXp(guildId, leaderId, 2000, 0);
    const res = clanManager.createNewClan(guildId, leaderId, `صقور ${rand}`, tag, '🦅', 'كلان الصقور');
    assert.equal(res.success, true);
    assert.ok(res.clanId);

    const clan = queries.getUserClan(guildId, leaderId);
    assert.ok(clan);
    assert.equal(clan.tag, tag);
    assert.equal(clan.role, 'leader');
  });

  await t.test('addClanMember and clan points accumulation', () => {
    const clan = queries.getClanByTag(guildId, tag);
    assert.ok(clan);

    const joinRes = queries.addClanMember(guildId, clan.id, memberId);
    assert.equal(joinRes.success, true);

    queries.addClanPoints(guildId, memberId, 150);

    const updatedClan = queries.getClanById(clan.id);
    assert.ok(updatedClan.score >= 150);

    const top = queries.getTopClans(guildId, 5);
    assert.ok(top.length > 0);
  });
});
