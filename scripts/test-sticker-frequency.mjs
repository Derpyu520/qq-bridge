// 发表情频率档位（off / low / normal / high / persona）的回归。
//
// 钉的边界：
//   · 档位同时影响「提示词里的频率说明」与「桥接硬上限」，两处必须同源；
//   · off = 直接 403，且 qq_send_sticker 不再出现在 available tools；
//   · low/normal/high 的每 10 分钟上限与最小间隔真的会拦；被拦时不消耗普通发送额度；
//   · persona = 不设档位上限（只受总发送限额），提示词交给人设、不给固定轮数；
//   · 高级覆盖（maxPer10Min / minGapMs，0 = 关闭）能盖过档位默认值。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
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
  const token = h.getSocialV2State(GROUP).agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, {
    method = 'GET',
    body = null,
    query = '',
    key = GROUP,
    agentToken = token
  } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (agentToken) headers['x-agent-token'] = agentToken;
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
  const sendSticker = (stickerId = 'fixture-sticker') => request('send-sticker', {
    method: 'POST', body: { key: GROUP, stickerId }
  });
  try { await run({ h, request, sendSticker }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('默认 normal：配置/提示词/策略都显示「适中」', async () => {
  await withBridge(async ({ request }) => {
    const cfg = await request('/api/socialV2/config', { agentToken: false });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.data.config.sticker.send.mode, 'normal');
    assert.equal(cfg.data.config.sticker.send.maxPer10Min, null);
    const prompt = await request('prompt');
    assert.equal(prompt.status, 200);
    assert.equal(prompt.data.stickers.sendMode, 'normal');
    assert.match(prompt.data.stickers.strategy, /3~5 轮/);
    assert.match(prompt.data.stickers.sendPolicy, /6 张/);
  });
});

await test('off：发送 403、提示词禁止、available tools 不再列出发送工具', async () => {
  await withBridge(async ({ request, sendSticker }) => {
    const prompt = await request('prompt');
    assert.equal(prompt.data.stickers.sendMode, 'off');
    assert.match(prompt.data.stickers.strategy, /不发表情/);
    assert.equal(prompt.data.enabledTools.includes('qq_send_sticker'), false);
    const out = await sendSticker();
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.match(out.data.error, /不发表情/);
  }, { socialV2: { sticker: { send: { mode: 'off' } } } });
});

await test('档位上限：low 覆盖为每 10 分钟 1 张，第二张 429；被拦不消耗普通发送额度', async () => {
  await withBridge(async ({ h, request, sendSticker }) => {
    const first = await sendSticker();
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await sendSticker();
    assert.equal(second.status, 429, JSON.stringify(second.data));
    assert.match(second.data.error, /每 10 分钟最多 1 张/);
    assert.ok(second.data.retryAfterMs > 0);
    assert.equal(h.calls.customFaces.length, 1, '只应真的发出去一张');
    // 被挡下的那次不能占用普通发送额度（sendTimes 只记成功那次）
    const st = h.getSocialV2State(GROUP);
    assert.equal(st.sendTimes.length, 1);
  }, { socialV2: { sticker: { send: { mode: 'low', maxPer10Min: 1, minGapMs: 0 } } } });
});

await test('最小间隔：normal + 60 秒间隔，第二张 429', async () => {
  await withBridge(async ({ h, sendSticker }) => {
    const first = await sendSticker();
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await sendSticker();
    assert.equal(second.status, 429, JSON.stringify(second.data));
    assert.match(second.data.error, /至少隔 60 秒/);
    assert.equal(h.calls.customFaces.length, 1);
  }, { socialV2: { sticker: { send: { mode: 'normal', maxPer10Min: 0, minGapMs: 60000 } } } });
});

await test('persona：不设档位上限，连续两张都放行；提示词交给人设', async () => {
  await withBridge(async ({ h, request, sendSticker }) => {
    const prompt = await request('prompt');
    assert.equal(prompt.data.stickers.sendMode, 'persona');
    assert.match(prompt.data.stickers.strategy, /人设/);
    assert.doesNotMatch(prompt.data.stickers.strategy, /3~5 轮/);
    assert.match(prompt.data.stickers.sendPolicy, /不设档位频率上限/);
    const a = await sendSticker();
    const b = await sendSticker();
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(b.status, 200, JSON.stringify(b.data));
    assert.equal(h.calls.customFaces.length, 2);
  }, { socialV2: { sticker: { send: { mode: 'persona' } } } });
});

await test('high + 覆盖 2 张：前两张过、第三张 429（覆盖优先于档位默认 15）', async () => {
  await withBridge(async ({ h, sendSticker }) => {
    assert.equal((await sendSticker()).status, 200);
    assert.equal((await sendSticker()).status, 200);
    const third = await sendSticker();
    assert.equal(third.status, 429, JSON.stringify(third.data));
    assert.match(third.data.error, /最多 2 张/);
    assert.equal(h.calls.customFaces.length, 2);
  }, { socialV2: { sticker: { send: { mode: 'high', maxPer10Min: 2, minGapMs: 0 } } } });
});

await test('includeInPrompt=false：不注入摘要/完整策略，但档位单行仍注入', async () => {
  await withBridge(async ({ request }) => {
    const prompt = await request('prompt');
    assert.equal(prompt.status, 200);
    assert.equal(prompt.data.stickers.context, '');
    assert.match(prompt.data.stickers.strategy, /当前档位：少量/);
    assert.doesNotMatch(prompt.data.stickers.strategy, /回表情（最重要）/);
  }, { socialV2: { sticker: { includeInPrompt: false, send: { mode: 'low' } } } });
});

await test('唤醒提示词同样按档位注入（persona / off）', async () => {
  await withBridge(async ({ h }) => {
    const prompt = h.buildWakePromptV2(GROUP, 'timeout');
    assert.match(prompt, /人设/);
    assert.doesNotMatch(prompt, /3~5 轮/);
  }, { socialV2: { sticker: { send: { mode: 'persona' } } } });

  await withBridge(async ({ h }) => {
    const prompt = h.buildWakePromptV2(GROUP, 'timeout');
    assert.match(prompt, /不发表情/);
  }, { socialV2: { sticker: { send: { mode: 'off' } } } });
});

await test('配置接口：合法档位可保存，非法档位归一成 normal', async () => {
  await withBridge(async ({ request }) => {
    const saved = await request('/api/socialV2/config', {
      method: 'POST', agentToken: false, body: { sticker: { send: { mode: 'low' } } }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const cfg = await request('/api/socialV2/config', { agentToken: false });
    assert.equal(cfg.data.config.sticker.send.mode, 'low');
    const bad = await request('/api/socialV2/config', {
      method: 'POST', agentToken: false, body: { sticker: { send: { mode: '乱写' } } }
    });
    assert.equal(bad.status, 200);
    const cfg2 = await request('/api/socialV2/config', { agentToken: false });
    assert.equal(cfg2.data.config.sticker.send.mode, 'normal');
  });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
