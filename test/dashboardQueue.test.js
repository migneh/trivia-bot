'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  enqueueDashboardEdit,
  clearQueue,
  hasPendingEdits,
  getPendingCount,
} = require('../utils/dashboardQueue');

test('enqueueDashboardEdit: runs edits serially per guild, in order', async () => {
  const order = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const make = (n) => async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 15));
    order.push(n);
    inFlight--;
  };

  const p1 = enqueueDashboardEdit('guild_serial', make(1));
  const p2 = enqueueDashboardEdit('guild_serial', make(2));
  const p3 = enqueueDashboardEdit('guild_serial', make(3));

  await Promise.all([p1, p2, p3]);

  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(maxInFlight, 1, 'edits must never overlap');
  assert.equal(getPendingCount('guild_serial'), 0);
  assert.equal(hasPendingEdits('guild_serial'), false);
});

test('enqueueDashboardEdit: guilds are isolated from each other', async () => {
  const order = [];
  const make = (tag, n) => async () => {
    await new Promise(r => setTimeout(r, 10));
    order.push(`${tag}:${n}`);
  };

  await Promise.all([
    enqueueDashboardEdit('guild_a', make('a', 1)),
    enqueueDashboardEdit('guild_b', make('b', 1)),
    enqueueDashboardEdit('guild_a', make('a', 2)),
  ]);

  assert.deepEqual(order, ['a:1', 'b:1', 'a:2']);
});

test('a failed edit (ignorable Discord error) does not block later edits', async () => {
  const order = [];

  const fail = async () => {
    const err = new Error('Unknown Message');
    err.code = 10008; // ignored by handleEditError
    throw err;
  };

  await enqueueDashboardEdit('guild_fail', fail);
  await enqueueDashboardEdit('guild_fail', async () => order.push('after-fail'));

  assert.deepEqual(order, ['after-fail']);
});

test('clearQueue: resets pending state for a guild', () => {
  enqueueDashboardEdit('guild_clear', async () => {});
  clearQueue('guild_clear');
  assert.equal(getPendingCount('guild_clear'), 0);
  assert.equal(hasPendingEdits('guild_clear'), false);
});
