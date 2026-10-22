// qq_wait_for_messages 的「漏消息窗口」回归（2026-10-18 修）。
//
// 真实故障：模型在思考/发消息那几秒里到达的消息，会落进等待窗口的缝里 ——
//   旧实现按 `seq > 请求开始时的 lastUnreadSeq` 取 newMessages，于是这些消息
//   ① 本次不返回；② 下次请求的基线已经越过它们 ⇒ 永远不会展示给模型；
//   ③ 又因为 readThroughSeq 是连续游标，它们会把水位永久钉住。
// 实测会话末段：readThroughSeq 卡在 185，而模型已经看过 205；期间有人 @ 也没进本回合。
//
// 本文件验证修复后的契约：凡未进水位的一律补发、从最老的开始、被上限截断时 partial=true。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const seqs = (messages) => Array.from(messages, (m) => m.seq);
let failures = 0;
let tests = 0;

async function withBridge(run, config = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    // 沉睡前观察是另一条闸门（qq_mark_read 会因此 400）；这里要测的是水位，先关掉。
    wake: { preSleepWaitEnabled: false },
    proactive: { enabled: false },
    sticker: { enabled: false },
    ...config
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { body, token = st.agentToken, key = KEY, query = '' } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (token) headers['x-agent-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}${query}`,
      method: body === undefined ? 'GET' : 'POST', headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = (text) => {
    const cur = h.getSocialV2State(KEY);
    const seq = cur.lastUnreadSeq + 1;
    h.appendSocialV2Message(KEY, 'fixture-person', text, text, false, false, `fixture-${seq}`, [], '789');
    return seq;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try { await run({ h, st, request, append, sleep }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

async function test(name, run, config) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 1. 核心：思考期间到达的消息必须在下次等待里补上 ─────────────────────────
await test('思考期间到达的消息不再漏：等待返回从水位起连续的一段', async () => {
  await withBridge(async ({ h, st, request, append, sleep }) => {
    append('第一条'); append('第二条');
    // 模型显式读了一次 → 水位 2
    const read = await request('unread');
    assert.equal(read.data.readThroughSeq, 2);

    // 模型在思考/发消息期间，群友又说了两句（seq 3、4）—— 这两条以前会永远消失
    append('思考期间来的A'); append('思考期间来的B');

    // 模型开始等待，等待期间再来一句（seq 5）才触发 arrived
    const waiting = request('wait', { body: { purpose: 'messages', timeoutMs: 800, quietMs: 0, minNewMessages: 1 } });
    await sleep(60);
    append('等待期间来的C');
    const result = await waiting;

    assert.equal(result.status, 200);
    assert.equal(result.data.arrived, true);
    assert.deepEqual(seqs(result.data.newMessages), [3, 4, 5], '3/4（思考期间）必须和 5（等待期间）一起补发');
    assert.equal(result.data.readThroughSeq, 5, '水位必须一次推到最新，不能卡在 2');
    assert.equal(result.data.partial, undefined, '没被截断时不该带 partial');
    // 收尾可以直接提交这个水位
    const marked = await request('mark-read', { body: { throughSeq: 5 } });
    assert.equal(marked.status, 200);
    assert.equal(marked.data.readThroughSeq, 5);
    assert.equal(st.unread.length, 0);
  });
});

// ── 2. 就是那个卡死场景：水位不能因为一条缝而永久停住 ──────────────────────
await test('反复出现「思考期间到达」也不会把水位钉死', async () => {
  await withBridge(async ({ h, request, append, sleep }) => {
    append('a'); // seq 1
    let lastThrough = (await request('unread')).data.readThroughSeq;
    assert.equal(lastThrough, 1);
    for (let round = 1; round <= 3; round += 1) {
      append(`思考期-${round}`);
      const waiting = request('wait', { body: { purpose: 'messages', timeoutMs: 800, quietMs: 0, minNewMessages: 1 } });
      await sleep(50);
      append(`等待期-${round}`);
      const result = await waiting;
      const expectThrough = 1 + round * 2;
      assert.equal(result.data.readThroughSeq, expectThrough, `第 ${round} 轮水位应推进到 ${expectThrough}`);
      assert.ok(result.data.readThroughSeq > lastThrough, '水位必须单调前进');
      lastThrough = result.data.readThroughSeq;
    }
  });
});

// ── 3. reply 用途同样不该漏 ─────────────────────────────────────────────────
await test('reply 用途也把未进水位的消息带上（只是不算沉睡前观察）', async () => {
  await withBridge(async ({ request, append }) => {
    append('第一条');
    await request('unread'); // 水位 1
    append('漏网之鱼'); // seq 2 未进水位
    const result = await request('wait', { body: { purpose: 'reply', timeoutMs: 300, quietMs: 0 } });
    assert.equal(result.status, 200);
    assert.deepEqual(seqs(result.data.newMessages), [2]);
    assert.equal(result.data.purpose, 'reply');
    assert.equal(result.data.preSleepWaitSatisfied, false, 'reply 用途绝不授予沉睡前观察');
  });
});

// ── 4. 上限与 partial：一次别倒太多，但不能跳着给 ──────────────────────────
await test('积压超过上限时从最老开始给，并标记 partial', async () => {
  // 说明：unread 缓冲默认只留 30 条，被挤掉的老消息会被水位「跳过」（既有设计：
  // 挤掉的等于不会再展示）。所以要让补发真的触到上限，得先把缓冲开大。
  await withBridge(async ({ h, st, request, append, sleep }) => {
    h.cfg.socialV2.context.unreadLimit = 60;
    append('已读的一条');
    await request('unread'); // 水位 1
    for (let i = 0; i < 60; i += 1) append(`积压-${i}`); // seq 2..61
    const waiting = request('wait', { body: { purpose: 'messages', timeoutMs: 800, quietMs: 0, minNewMessages: 1 } });
    await sleep(60);
    append('触发的最后一条'); // seq 62
    const result = await waiting;
    const seqList = seqs(result.data.newMessages);
    assert.equal(result.data.partial, true, '被截断必须显式标记');
    assert.equal(seqList.length, 50, '一次最多给 waitCap 条（min(50, max(12, unreadLimit))）');
    assert.ok(seqList[0] < 10, `必须从最老的那端开始给，实际起点 ${seqList[0]}`);
    for (let i = 1; i < seqList.length; i += 1) {
      assert.equal(seqList[i], seqList[i - 1] + 1, '必须是连续一段（水位是连续游标，跳着给就卡住）');
    }
    assert.equal(result.data.readThroughSeq, seqList[seqList.length - 1], '水位只推进到已展示的最后一条');
    assert.ok(st.unread.length > 0, '没展示完的必须还在未读里');
    // 续读：afterSeq=readThroughSeq 接着往后拿
    const rest = await request('unread', { query: `&afterSeq=${result.data.readThroughSeq}` });
    assert.equal(rest.status, 200);
    assert.equal(rest.data.messages[0].seq, result.data.readThroughSeq + 1, '续读要从水位之后开始');
    assert.ok(rest.data.readThroughSeq > result.data.readThroughSeq, '续读后水位继续前进');
  });
});

// ── 5. 收尾闸门的状态直接告诉模型（别让它靠猜，更别用短等待去凑）─────────────
await test('短等待不算沉睡前观察：canSleepNow=false 且 hint 给出正确的 timeoutMs', async () => {
  await withBridge(async ({ request }) => {
    // 沉睡前观察默认要 180s；这里故意用 300ms 的短等待去"凑"，闸门不该认
    const result = await request('wait', { body: { purpose: 'messages', timeoutMs: 300, quietMs: 0, minNewMessages: 1 } });
    assert.equal(result.status, 200);
    assert.equal(result.data.canSleepNow, false, '刚发过消息不可能立刻放行');
    assert.equal(result.data.countsAsObservation, false, 'timeoutMs < 观察窗口 ⇒ 不算观察');
    assert.match(result.data.hint, /qq_wait_for_messages\(timeoutMs=180000\)/, '必须给出该发的准确参数');
    assert.match(result.data.hint, /不达标/, '要点明本次不达标');
    assert.match(result.data.hint, /还需约 \d+ 秒/, '要给出还差多少秒');
  }, { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 180000 } });
});

await test('闸门放行时明确说「可以直接收尾」', async () => {
  await withBridge(async ({ request, append, sleep }) => {
    append('一句话');
    await sleep(260); // 观察窗口配成 200ms，安静够了
    const result = await request('wait', { body: { purpose: 'messages', timeoutMs: 200, quietMs: 0, minNewMessages: 1 } });
    assert.equal(result.status, 200);
    assert.equal(result.data.canSleepNow, true, `安静满窗口后应放行：${JSON.stringify(result.data.hint)}`);
    assert.match(result.data.hint, /可以直接收尾/);
    assert.doesNotMatch(result.data.hint, /还不能收尾/);
  }, { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 200 } });
});

await test('purpose=reply 不带收尾闸门字段（免得误导首答前就去睡）', async () => {
  await withBridge(async ({ request, append }) => {
    append('在吗');
    const result = await request('wait', { body: { purpose: 'reply', timeoutMs: 200, quietMs: 0 } });
    assert.equal(result.status, 200);
    assert.equal(result.data.canSleepNow, undefined);
    assert.equal(result.data.countsAsObservation, undefined);
    assert.equal(result.data.hint, undefined);
    assert.equal(result.data.preSleepWaitRemainingMs, undefined);
  }, { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 180000 } });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
