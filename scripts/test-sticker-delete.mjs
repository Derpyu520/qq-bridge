// 删除自己收藏的表情（qq_delete_sticker）的回归。
//
// 钉的边界：
//   · 必须带会话令牌；工具开关 / 全局开关 / 自主权限三档都要真的拦住；
//   · 默认「仅应要求」——群友让删被拒，管理员本人要求（5 分钟 TTL）才直连；
//   · 删除后本地库立即移除，且重新同步确认真没了（verified=true）；
//   · 未知 id / 频率上限 / 功能关闭都返回可读错误，且不产生网关副作用；
//   · MCP 侧登记了注册期开关，控制台关得掉。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const OWNER_PRIVATE = 'private:123';
let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

async function withBridge(run, { socialV2 = {} } = {}) {
  const h = await bridgeHarness({
    config: { socialV2: { proactive: { enabled: false }, ...socialV2 } }
  });
  h.setMode('reserved2');
  const groupToken = h.getSocialV2State(GROUP).agentToken;
  const ownerToken = h.getSocialV2State(OWNER_PRIVATE).agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, {
    token,
    agentToken = true,
    key = GROUP,
    method = 'GET',
    body = null,
    query = ''
  } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    const effectiveToken = token !== undefined ? token : (agentToken ? (key === OWNER_PRIVATE ? ownerToken : groupToken) : '');
    if (effectiveToken) headers['x-agent-token'] = effectiveToken;
    let payload = null;
    if (body !== null) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const path = `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}${query}`;
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  try { await run({ h, request, groupToken, ownerToken }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('owner 直连删除：网关真的被调用，本地库同步移除并 verified=true', async () => {
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(OWNER_PRIVATE, true);
    const before = await request('sticker-list', { key: OWNER_PRIVATE, query: '&count=50' });
    assert.equal(before.status, 200, JSON.stringify(before.data));
    assert.equal(before.data.total, 2);

    const out = await request('delete-sticker', {
      key: OWNER_PRIVATE, method: 'POST',
      body: { key: OWNER_PRIVATE, stickerId: 'fixture-sticker' }
    });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.ok, true);
    assert.equal(out.data.deleted.id, 'fixture-sticker');
    assert.equal(out.data.deleted.desc, '测试表情');
    assert.equal(out.data.verified, true);
    assert.equal(out.data.remaining, 1);
    assert.deepEqual(h.calls.stickerDeletes, ['fixture-sticker']);

    const after = await request('sticker-list', { key: OWNER_PRIVATE, query: '&count=50' });
    assert.equal(after.data.total, 1);
    assert.equal(after.data.stickers.some((s) => s.id === 'fixture-sticker'), false);
    assert.equal(after.data.stickers[0].id, 'fixture-sticker-2');
  });
});

await test('群友让删（非 owner、request 档）→ 403，且不调用网关', async () => {
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(GROUP, false);
    const out = await request('delete-sticker', {
      key: GROUP, method: 'POST',
      body: { key: GROUP, stickerId: 'fixture-sticker' }
    });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.match(out.data.error, /仅应要求|只允许管理员本人/);
    assert.deepEqual(h.calls.stickerDeletes, []);
  });
});

await test('权限不开放 / 工具关闭 / 全局删除关闭 各自 403', async () => {
  // 不开放
  await withBridge(async ({ h, request }) => {
    const perms = await request('/api/bot-perms', {
      method: 'POST', key: GROUP, agentToken: false,
      body: { scope: { deleteSticker: 'none' } }
    });
    assert.equal(perms.status, 200, JSON.stringify(perms.data));
    const out = await request('delete-sticker', {
      key: GROUP, method: 'POST', body: { key: GROUP, stickerId: 'fixture-sticker' }
    });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.match(out.data.error, /不开放/);
    assert.deepEqual(h.calls.stickerDeletes, []);
  });

  // 工具开关
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(OWNER_PRIVATE, true);
    const out = await request('delete-sticker', {
      key: OWNER_PRIVATE, method: 'POST', body: { key: OWNER_PRIVATE, stickerId: 'fixture-sticker' }
    });
    assert.equal(out.status, 403);
    assert.match(out.data.error, /qq_delete_sticker/);
    assert.deepEqual(h.calls.stickerDeletes, []);
  }, { socialV2: { tools: { deleteSticker: false } } });

  // 全局删除开关
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(OWNER_PRIVATE, true);
    const out = await request('delete-sticker', {
      key: OWNER_PRIVATE, method: 'POST', body: { key: OWNER_PRIVATE, stickerId: 'fixture-sticker' }
    });
    assert.equal(out.status, 403);
    assert.match(out.data.error, /删除表情功能已关闭|sticker\.delete/);
    assert.deepEqual(h.calls.stickerDeletes, []);
  }, { socialV2: { sticker: { delete: { enabled: false } } } });
});

await test('没有令牌 → 403（删除不能走控制台操作者通道）', async () => {
  await withBridge(async ({ h, request }) => {
    const out = await request('delete-sticker', {
      key: GROUP, method: 'POST', token: '',
      body: { key: GROUP, stickerId: 'fixture-sticker' }
    });
    assert.equal(out.status, 403);
    assert.match(out.data.error, /令牌/);
    assert.deepEqual(h.calls.stickerDeletes, []);
  });
});

await test('未知 stickerId → 404，且不调用网关、不清空本地库', async () => {
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(OWNER_PRIVATE, true);
    const out = await request('delete-sticker', {
      key: OWNER_PRIVATE, method: 'POST', body: { key: OWNER_PRIVATE, stickerId: 'no-such-sticker' }
    });
    assert.equal(out.status, 404, JSON.stringify(out.data));
    assert.match(out.data.error, /找不到表情/);
    assert.deepEqual(h.calls.stickerDeletes, []);
    const list = await request('sticker-list', { key: OWNER_PRIVATE, query: '&count=50' });
    assert.equal(list.data.total, 2);
  });
});

await test('频率上限：每分钟 1 张，第二张 429', async () => {
  await withBridge(async ({ h, request }) => {
    h.markOwnerSender(OWNER_PRIVATE, true);
    const first = await request('delete-sticker', {
      key: OWNER_PRIVATE, method: 'POST', body: { key: OWNER_PRIVATE, stickerId: 'fixture-sticker' }
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await request('delete-sticker', {
      key: OWNER_PRIVATE, method: 'POST', body: { key: OWNER_PRIVATE, stickerId: 'fixture-sticker-2' }
    });
    assert.equal(second.status, 429, JSON.stringify(second.data));
    assert.match(second.data.error, /每分钟/);
    assert.equal(second.data.retryAfterMs > 0, true);
    assert.deepEqual(h.calls.stickerDeletes, ['fixture-sticker']);
  }, { socialV2: { sticker: { delete: { maxPerMinute: 1, maxPerHour: 0, maxPerDay: 0 } } } });
});

await test('权限表：deleteSticker 默认 request 且封顶 request', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('/api/bot-perms', { key: GROUP, agentToken: false });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    const row = out.data.rows.find((r) => r.key === 'deleteSticker');
    assert.ok(row, '权限表必须有 deleteSticker');
    assert.equal(row.scope, 'request');
    assert.equal(row.maxScope, 'request');
  });
});

await test('MCP：qq_delete_sticker 已注册且挂注册期开关', () => {
  const src = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  assert.match(src, /qq_delete_sticker: 'deleteSticker'/);
  assert.ok(src.includes("'qq_delete_sticker'"));
  assert.match(src, /不可恢复/);
  assert.match(src, /一次只传一个 stickerId/);
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
