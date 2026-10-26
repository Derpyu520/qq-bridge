// 每会话主动概率调整的接口级回归：POST /api/socialV2/proactive + GET /api/sessions。
//
// 只起虚拟桥接（bridgeHarness），不碰真实 QQ / DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const TOKEN = 'fixture-console-token';
const GROUP_KEY = 'group:456';

async function fixture(run) {
  const h = await bridgeHarness({
    config: {
      allow: { private: ['123'], groups: ['456'] },
      adminOps: { enabled: true, maxPerMinute: 99, vetoProbability: 0 }
    }
  });
  h.setMode('reserved2');
  h.setSelfIdentity('大肥鱼', '999');
  // /api/sessions 只列 DSH 已建会话；这里补一个，模拟"这个群已经聊过"。
  h.state.sessions[GROUP_KEY] = 'session-fixture';
  h.getSocialV2State(GROUP_KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const call = (method, urlPath, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: { 'content-type': 'application/json', 'x-console-token': TOKEN, ...headers }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    await run({ h, get: (p) => call('GET', p), post: (p, b, headers) => call('POST', p, b, headers) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

test('设置 0.2：接口回读、会话状态、落盘三处一致', async () => {
  await fixture(async ({ h, get, post }) => {
    const r = await post('/api/socialV2/proactive', { key: GROUP_KEY, delta: 0.2 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.proactiveDelta, 0.2);

    const s = await get('/api/sessions');
    const row = (s.data.sessions || []).find((x) => x.key === GROUP_KEY);
    assert.ok(row, `会话列表应含 ${GROUP_KEY}：${JSON.stringify(s.data)}`);
    assert.equal(row.proactiveDelta, 0.2);

    assert.equal(h.getSocialV2State(GROUP_KEY).proactiveDelta, 0.2);

    const saved = JSON.parse(fs.readFileSync(path.join(h.tempDir, 'state/social-v2.json'), 'utf8'));
    assert.equal(saved.conversations[GROUP_KEY].proactiveDelta, 0.2, '应随 social-v2.json 持久化');
  });
});

test('超出 ±1 的调整被夹回；负数可以调低', async () => {
  await fixture(async ({ post }) => {
    const high = await post('/api/socialV2/proactive', { key: GROUP_KEY, delta: 5 });
    assert.equal(high.data.proactiveDelta, 1);
    const low = await post('/api/socialV2/proactive', { key: GROUP_KEY, delta: -5 });
    assert.equal(low.data.proactiveDelta, -1);
    const lower = await post('/api/socialV2/proactive', { key: GROUP_KEY, delta: -0.3 });
    assert.equal(lower.data.proactiveDelta, -0.3);
  });
});

test('模型（agent token）不能改这个值', async () => {
  await fixture(async ({ post }) => {
    const r = await post('/api/socialV2/proactive', { key: GROUP_KEY, delta: 0.5 }, { 'x-agent-token': 'anything' });
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.match(String(r.data?.error ?? ''), /只允许管理员/);
  });
});

test('key 非法：400', async () => {
  await fixture(async ({ post }) => {
    const r = await post('/api/socialV2/proactive', { key: 'nope', delta: 0.2 });
    assert.equal(r.status, 400);
    assert.match(String(r.data?.error ?? ''), /key 格式/);
  });
});
