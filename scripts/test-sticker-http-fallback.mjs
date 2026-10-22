// 表情库同步的「WS 挂掉」兜底回归（2026-10-18）。
//
// 真实故障：`fetch_custom_face_detail` 原来只走 SnowLuma 的 WS action。WS 重连窗口里
// 同步必然失败 —— 日志实测 33 次同步 16 次失败（≈48%，全是 WS closed），
// 表现就是"收藏表情时有时无"，以及 qq_get_sticker_image 报「找不到表情」。
// 而同一个网关的 HTTP 口一直可用（onebotSend / fetch_ptt_text 都在用）。
//
// 本文件验证：WS 正常时走 WS（不多打一次 HTTP）；WS 失败时自动改走 HTTP，且结果标 via=http。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 一个只用来"演 WS 挂掉"的客户端：除了被桥接订阅的事件方法，request 一律抛错。
class WsDownBot {
  onPrivateMessage() {}
  onGroupMessage() {}
  onNotice() {}
  onEvent() {}
  onEventError() {}
  async request() { throw new Error('SnowLuma WebSocket closed before opening'); }
  async getImage() { return null; }
  async fetchFaceEntity() { return null; }
  async sendPrivateMessage() {}
  async sendGroupMessage() {}
  async connect() {}
  close() {}
}

// 一个"WS 正常"的客户端：返回合法的收藏表情数组。
class WsUpBot extends WsDownBot {
  async request(action) {
    if (action === 'fetch_custom_face_detail') {
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'ws-fixture-sticker', resId: 'ws-fixture-sticker', url: 'https://public.invalid/ws-sticker', md5: '11223344556677889900AABBCCDDEEFF', desc: 'WS 表情' }] };
    }
    return { status: 'ok', retcode: 0, data: {} };
  }
}

const httpCalls = (h) => h.calls.http.filter((c) => String(c.url).endsWith('/fetch_custom_face_detail'));

await test('WS 正常时走 WS，不额外打 HTTP', async () => {
  const h = await bridgeHarness({ globals: { SnowLumaWebSocketClient: WsUpBot } });
  try {
    h.setMode('reserved2');
    const synced = await h.syncStickerLibrary(true);
    assert.ok(synced, '同步应当成功');
    assert.equal(synced.via, 'ws');
    assert.equal(synced.entries.length, 1);
    assert.equal(synced.entries[0].id, 'ws-fixture-sticker');
    assert.equal(httpCalls(h).length, 0, 'WS 成功时不该再打 HTTP（不增加正常路径延迟）');
  } finally { await h.close(); }
});

await test('WS 挂了自动改走 OneBot HTTP，结果标 via=http', async () => {
  const h = await bridgeHarness({ globals: { SnowLumaWebSocketClient: WsDownBot } });
  try {
    h.setMode('reserved2');
    const synced = await h.syncStickerLibrary(true);
    assert.ok(synced, 'WS 失败时必须有兜底，而不是整条链路失败');
    assert.equal(synced.via, 'http');
    assert.equal(synced.entries.length, 1);
    assert.equal(synced.entries[0].id, 'http-fixture-sticker');
    assert.equal(synced.entries[0].desc, 'HTTP 兜底表情');
    const calls = httpCalls(h);
    assert.equal(calls.length, 1, '应当只打一次 HTTP');
    assert.deepEqual(calls[0].body, { count: 100 }, '要带上与 WS 路径相同的参数');
  } finally { await h.close(); }
});

await test('HTTP 兜底也失败时仍然返回 null（不炸、不清空本地库）', async () => {
  const h = await bridgeHarness({
    globals: {
      SnowLumaWebSocketClient: WsDownBot,
      // 覆盖 harness 的通用 fetch：模拟 HTTP 口也连不上
      fetch: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3000'); }
    }
  });
  try {
    h.setMode('reserved2');
    const synced = await h.syncStickerLibrary(true);
    assert.equal(synced, null, '两条路都失败时按原约定返回 null（调用方用缓存）');
  } finally { await h.close(); }
});

await test('HTTP 返回的不是数组时不合并（防拿坏数据清空表情库）', async () => {
  const h = await bridgeHarness({
    globals: {
      SnowLumaWebSocketClient: WsDownBot,
      // 覆盖 harness 的通用 fetch：让 HTTP 兜底返回一个对象而不是数组
      fetch: async (url) => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', retcode: 0, data: { not: 'an array' } })
      })
    }
  });
  try {
    h.setMode('reserved2');
    const synced = await h.syncStickerLibrary(true);
    assert.equal(synced, null);
  } finally { await h.close(); }
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
