'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createWebServer } = require('../web/server');
const { initQuestionBank } = require('../utils/questionBank');
const { initDb } = require('../database/schema');

test('Web Dashboard & REST API Unit Tests', async (t) => {
  initDb();
  initQuestionBank();
  const server = createWebServer();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  function fetchUrl(path) {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      }).on('error', reject);
    });
  }

  await t.test('GET / returns HTML dashboard', async () => {
    const res = await fetchUrl('/');
    assert.equal(res.status, 200);
    assert.ok(res.data.includes('بوت مسابقات المعرفة'));
  });

  await t.test('GET /api/v1/stats returns valid JSON', async () => {
    const res = await fetchUrl('/api/v1/stats');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.data);
    assert.equal(json.success, true);
    assert.ok(json.stats.totalQuestions >= 5000);
  });

  await t.test('GET /api/v1/questions returns paginated questions', async () => {
    const res = await fetchUrl('/api/v1/questions?page=1&limit=5');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.data);
    assert.equal(json.success, true);
    assert.equal(json.questions.length, 5);
  });

  await t.test('GET /api/v1/shop returns shop catalog', async () => {
    const res = await fetchUrl('/api/v1/shop');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.data);
    assert.equal(json.success, true);
    assert.ok(json.items.length > 0);
  });

  await new Promise((resolve) => server.close(resolve));
});
