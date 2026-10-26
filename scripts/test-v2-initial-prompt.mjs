// 二代仿真「会话初始提示词」回归：操作者在控制台为某个群/私聊预写环境说明，
// 只在该会话**首次唤醒**（bootstrap）时注入给 AI。
//
// 钉住的边界（每一条都对应一个具体的失败形态）：
//   1. 读写与持久化：进程重启后仍在；key 归一化（group:0456 → group:456）；
//   2. 注入时机：只有 bootstrap 唤醒带它，后续 question/timeout/admin 唤醒都不带；
//      别的会话更不会串台（跨群体泄露是这里最不能犯的错）；
//   3. 管理面隔离：带 agent token 的 AI 完全读不到也改不了（含 GET 列表）；
//   4. 输入校验：非法 key / 超长 / 非字符串一律 400；缺 text 不得被当成"清空"；
//   5. 数据安全：文件损坏时降级为只读，绝不把原文件覆盖成空对象；
//   6. 首次唤醒语义：控制台「立即唤醒」在未 bootstrap 的会话上必须升级成 bootstrap，
//      否则这条会话永远拿不到引导与初始提示词。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { readConsoleBundle } from './console-source.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const ADMIN = { 'x-console-token': 'fixture-console-token' };

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: response.statusCode, body: data, json });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const ENV_TEXT = '这是一个二次元 + 技术混合的群：群友喜欢玩梗、聊模型和本地部署。\n氛围轻松，别长篇大论；有人问配置问题要直接给结论。';

// ── 1. 保存 / 读取 / key 归一化 / 持久化 ─────────────────────────────────────
await test('保存后可读回、key 归一化，并在重启后从文件恢复', async () => {
  const h = await bridgeHarness();
  let persisted = '';
  let savedKey = '';
  try {
    await withServer(h, async (port) => {
      const created = await call(port, '/api/socialV2/initial-prompt', {
        method: 'POST', headers: ADMIN, body: { key: 'group:0456', text: ENV_TEXT }
      });
      assert.equal(created.status, 200, '管理员应能保存初始提示词');
      assert.equal(created.json.ok, true);
      assert.equal(created.json.key, 'group:456', 'key 必须归一化（去前导零）');
      assert.equal(created.json.chars, ENV_TEXT.length);
      savedKey = created.json.key;

      // 内存态立即可见（AI 的下一次 bootstrap 就能拿到）
      assert.equal(h.getInitialPrompt('group:456')?.text, ENV_TEXT);

      const read = await call(port, '/api/socialV2/initial-prompt?key=group%3A456', { headers: ADMIN });
      assert.equal(read.status, 200);
      assert.equal(read.json.exists, true);
      assert.equal(read.json.text, ENV_TEXT, '读回内容必须逐字一致（含段落换行）');

      const list = await call(port, '/api/socialV2/initial-prompt', { headers: ADMIN });
      assert.equal(list.status, 200);
      assert.equal(list.json.entries.length, 1);
      assert.equal(list.json.entries[0].key, 'group:456');
      assert.ok(list.json.entries[0].preview.length <= 80, '列表只给预览，不回整段内容');
      assert.ok(Number.isInteger(list.json.maxChars) && list.json.maxChars > 0, '列表返回当前字数上限');

      // 落盘：键是归一后的 key，内容是原文
      const file = path.join(h.temp, 'state', 'initial-prompts.json');
      assert.ok(fs.existsSync(file), '必须写入 state/initial-prompts.json');
      persisted = fs.readFileSync(file, 'utf8');
      const onDisk = JSON.parse(persisted);
      assert.equal(onDisk['group:456'].text, ENV_TEXT);
      assert.ok(onDisk['group:456'].updatedAt > 0, '记录更新时间');
    });
  } finally { await h.close(); }

  // 重启：用上一次落盘的文件新建一个桥接实例
  const h2 = await bridgeHarness({ files: { 'state/initial-prompts.json': persisted } });
  try {
    assert.equal(h2.getInitialPrompt(savedKey)?.text, ENV_TEXT, '重启后从 state/initial-prompts.json 恢复');
  } finally { await h2.close(); }
});

// ── 2. 只在首次唤醒注入，且不串会话 ───────────────────────────────────────────
await test('初始提示词只出现在 bootstrap 唤醒，且只给配置的那个会话', async () => {
  const h = await bridgeHarness();
  try {
    const r = h.setInitialPrompt('group:456', ENV_TEXT);
    assert.equal(r.ok, true);

    const bootstrap = h.buildWakePromptV2('group:456', 'bootstrap');
    assert.ok(bootstrap.includes(ENV_TEXT), 'bootstrap 唤醒必须带操作者预写的环境说明');
    assert.ok(bootstrap.includes('群聊环境'), '注入段要有可识别的标题');
    assert.ok(bootstrap.includes('仅本次首次唤醒参考'), '注入段要说明只在首次唤醒参考');
    assert.ok(bootstrap.includes('不是群友发的消息'), '要告诉 AI 这不是群友发言（防提示注入误读）');

    for (const reason of ['question', 'atMention', 'timeout', 'replyCheck', 'proactiveCheck', 'poke', 'admin', 'keyword:小鲸鱼']) {
      assert.ok(!h.buildWakePromptV2('group:456', reason).includes(ENV_TEXT), `${reason} 唤醒不得重复注入初始提示词`);
    }
    assert.ok(!h.buildWakePromptV2('group:999', 'bootstrap').includes(ENV_TEXT), '不得串到别的会话');

    // 私聊用「私聊环境」标签，方便 AI 分清群里还是私聊
    h.setInitialPrompt('private:123', '这是管理员私聊，直接说结论即可。');
    const priv = h.buildWakePromptV2('private:123', 'bootstrap');
    assert.ok(priv.includes('私聊环境') && priv.includes('这是管理员私聊'));

    // 删除后不再注入
    assert.equal(h.setInitialPrompt('group:456', '').deleted, true);
    assert.ok(!h.buildWakePromptV2('group:456', 'bootstrap').includes(ENV_TEXT), '删除后 bootstrap 不得再注入');
  } finally { await h.close(); }
});

// ── 3. 管理面隔离：AI（agent token）读不到也改不了 ────────────────────────────
await test('agent token 既读不到初始提示词，也改不了它', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.setInitialPrompt('group:456', ENV_TEXT);
    await withServer(h, async (port) => {
      const asAgent = { ...ADMIN, 'x-agent-token': 'fixture-agent-token', 'x-agent-call': '1' };
      const readOne = await call(port, '/api/socialV2/initial-prompt?key=group%3A456', { headers: asAgent });
      assert.equal(readOne.status, 403, 'agent token 读单条必须 403');
      const readList = await call(port, '/api/socialV2/initial-prompt', { headers: asAgent });
      assert.equal(readList.status, 403, 'agent token 列全部必须 403');
      const write = await call(port, '/api/socialV2/initial-prompt', {
        method: 'POST', headers: asAgent, body: { key: 'group:456', text: 'AI 自己改掉的内容' }
      });
      assert.equal(write.status, 403, 'agent token 写必须 403');
      assert.equal(h.getInitialPrompt('group:456')?.text, ENV_TEXT, '被拒后内容不得改变');

      // 仅控制台令牌（管理端）可以
      const admin = await call(port, '/api/socialV2/initial-prompt?key=group%3A456', { headers: ADMIN });
      assert.equal(admin.status, 200);
      assert.equal(admin.json.text, ENV_TEXT);
    });
  } finally { await h.close(); }
});

// ── 4. 输入校验 ───────────────────────────────────────────────────────────────
await test('非法 key / 超长 / 缺 text 都被拒，且不会误删已有内容', async () => {
  const h = await bridgeHarness({ config: { socialV2: { initialPromptMaxChars: 100 } } });
  try {
    assert.equal(h.initialPromptMaxChars(), 100);
    assert.equal(h.setInitialPrompt('group:456', 'x'.repeat(100)).ok, true, '正好到上限允许');
    assert.equal(h.setInitialPrompt('group:456', 'x'.repeat(101)).ok, false, '超上限必须拒绝');
    assert.equal(h.getInitialPrompt('group:456').text.length, 100, '被拒的写入不得覆盖原有内容');

    await withServer(h, async (port) => {
      for (const key of ['', 'group:', 'group:abc', 'private:0', 'group:-1', 'wechat:123', 'group:9007199254740993']) {
        const res = await call(port, '/api/socialV2/initial-prompt', { method: 'POST', headers: ADMIN, body: { key, text: 'x' } });
        assert.equal(res.status, 400, `非法 key「${key}」必须 400，实际 ${res.status}`);
      }
      const badType = await call(port, '/api/socialV2/initial-prompt', { method: 'POST', headers: ADMIN, body: { key: 'group:456', text: { a: 1 } } });
      assert.equal(badType.status, 400, 'text 非字符串必须 400');

      // 缺 text 且没写 delete:true —— 绝不能被当成"清空"（否则一次漏字段的调用就删了内容）
      const missing = await call(port, '/api/socialV2/initial-prompt', { method: 'POST', headers: ADMIN, body: { key: 'group:456' } });
      assert.equal(missing.status, 400, '缺 text 必须 400 而不是静默删除');
      assert.equal(h.getInitialPrompt('group:456')?.text.length, 100, '缺 text 的请求不得删除已有内容');

      const tooLong = await call(port, '/api/socialV2/initial-prompt', { method: 'POST', headers: ADMIN, body: { key: 'group:456', text: 'y'.repeat(101) } });
      assert.equal(tooLong.status, 400);
      assert.match(tooLong.json.error, /过长|上限/, '错误信息要说明是超长');

      const byDelete = await call(port, '/api/socialV2/initial-prompt', { method: 'POST', headers: ADMIN, body: { key: 'group:456', delete: true } });
      assert.equal(byDelete.status, 200);
      assert.equal(byDelete.json.deleted, true);
      assert.equal(h.getInitialPrompt('group:456'), null);

      // 空内容保存 = 删除（文本域清空后点保存的自然语义）
      h.setInitialPrompt('group:456', 'abc');
      const empty = await call(port, '/api/socialV2/initial-prompt', { method: 'POST', headers: ADMIN, body: { key: 'group:456', text: '   \n  ' } });
      assert.equal(empty.status, 200);
      assert.equal(empty.json.deleted, true, '空白内容等于删除');
    });
  } finally { await h.close(); }
});

// ── 5. 字数上限收敛 ───────────────────────────────────────────────────────────
await test('initialPromptMaxChars 的越界配置被收敛到 100~8000', async () => {
  const cases = [[1, 100], [50, 100], [2000, 2000], [99999, 8000], ['300', 300], [-5, 2000], ['abc', 2000], [0, 2000]];
  for (const [input, expected] of cases) {
    const h = await bridgeHarness({ config: { socialV2: { initialPromptMaxChars: input } } });
    try { assert.equal(h.initialPromptMaxChars(), expected, `initialPromptMaxChars=${JSON.stringify(input)}`); }
    finally { await h.close(); }
  }
});

// ── 6. 文件损坏时只读降级，绝不覆盖原文件 ────────────────────────────────────
await test('initial-prompts.json 损坏时降级为只读，保存失败且原文件保持不变', async () => {
  const broken = '{ this is not json';
  const h = await bridgeHarness({ files: { 'state/initial-prompts.json': broken } });
  try {
    assert.equal(h.getInitialPrompt('group:456'), null, '损坏文件不产生条目');
    await withServer(h, async (port) => {
      const list = await call(port, '/api/socialV2/initial-prompt', { headers: ADMIN });
      assert.equal(list.json.writable, false, '损坏时应标记为不可写');
      const save = await call(port, '/api/socialV2/initial-prompt', { method: 'POST', headers: ADMIN, body: { key: 'group:456', text: 'abc' } });
      assert.equal(save.status, 500, '只读降级下保存必须失败');
      assert.equal(h.getInitialPrompt('group:456'), null, '失败后内存也要回滚');
      const onDisk = fs.readFileSync(path.join(h.temp, 'state', 'initial-prompts.json'), 'utf8');
      assert.equal(onDisk, broken, '原文件必须原样保留，等待人工修复');
    });
  } finally { await h.close(); }
});

// ── 7. 控制台「立即唤醒」在首次唤醒时升级为 bootstrap ────────────────────────
await test('手动唤醒在会话未 bootstrap 时必须走 bootstrap（否则初始提示词永远发不出去）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    h.setInitialPrompt('group:456', ENV_TEXT);
    await withServer(h, async (port) => {
      const first = await call(port, '/api/socialV2/wake', { method: 'POST', headers: ADMIN, body: { key: 'group:456', reason: 'admin' } });
      assert.equal(first.status, 200);
      assert.equal(first.json.reason, 'bootstrap', '首次唤醒必须走 bootstrap');
      assert.equal(first.json.firstWake, true);
      assert.equal(first.json.requestedReason, 'admin', '仍回显操作者请求的原因');

      const second = await call(port, '/api/socialV2/wake', { method: 'POST', headers: ADMIN, body: { key: 'group:456', reason: 'admin' } });
      assert.equal(second.status, 200);
      assert.equal(second.json.reason, 'admin', '已 bootstrap 过则保持原原因');
      assert.equal(second.json.firstWake, false);
    });
    // 真正投递出去的 prompt 里必须带初始提示词（content 是 [{type:'text', text}]）
    for (let i = 0; i < 50 && !h.calls.prompts.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.calls.prompts.length >= 1, 'bootstrap 必须真的投递一次 prompt');
    const delivered = h.calls.prompts
      .map((p) => (Array.isArray(p.content) ? p.content.map((c) => String(c?.text ?? '')).join('\n') : String(p.text ?? p.prompt ?? '')))
      .join('\n---\n');
    assert.ok(delivered.includes(ENV_TEXT), 'bootstrap 投递给 DSH 的 prompt 必须包含环境说明');
  } finally { await h.close(); }
});

// ── 8. 端到端：真实进线消息 → bootstrap 唤醒 → 投递的 prompt 带环境说明 ────────
await test('端到端：群消息进线触发的首次唤醒，投递给 DSH 的 prompt 带初始提示词', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 1000 } } } });
  try {
    h.setMode('reserved2');
    h.setInitialPrompt('group:456', ENV_TEXT);
    const event = {
      self_id: 999,
      user_id: 123,
      message_id: 4242,
      message: [{ type: 'text', data: { text: '大家好' } }],
      raw_message: '大家好',
      sender: { nickname: '测试群友', card: '测试群友' }
    };
    await h.handleIncoming('group', '456', event, h.cfg);
    for (let i = 0; i < 100 && !h.calls.prompts.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.calls.prompts.length, 1, '首条消息应触发恰好一次 bootstrap 唤醒');
    const delivered = h.calls.prompts[0].content.map((c) => String(c?.text ?? '')).join('\n');
    assert.ok(delivered.includes('【引导唤醒】'), '首次唤醒走的是 bootstrap 文案');
    assert.ok(delivered.includes(ENV_TEXT), 'bootstrap prompt 必须带操作者预写的环境说明');

    // 第二条消息（非首次唤醒）不得再注入
    const second = { ...event, message_id: 4243, message: [{ type: 'text', data: { text: '有没有人在' } }], raw_message: '有没有人在' };
    await h.handleIncoming('group', '456', second, h.cfg);
    for (let i = 0; i < 100 && h.calls.prompts.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    if (h.calls.prompts.length >= 2) {
      const text2 = h.calls.prompts[1].content.map((c) => String(c?.text ?? '')).join('\n');
      assert.ok(!text2.includes(ENV_TEXT), '第二次唤醒不得重复注入初始提示词');
    }
  } finally { await h.close(); }
});

// ── 9. 控制台静态接线（无浏览器环境下的替代回归） ────────────────────────────
await test('控制台有初始提示词面板，且事件/接口都已接线', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = readConsoleBundle(root);
  for (const id of ['v2InitPromptKey', 'v2InitPromptText', 'v2InitPromptLoad', 'v2InitPromptSave', 'v2InitPromptClear', 'v2InitPromptMsg', 'v2InitPromptCount', 'v2InitPromptMax']) {
    const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
    assert.equal(n, 1, `控制台元素 ${id} 必须存在且唯一（实际 ${n} 处）`);
  }
  assert.match(html, /getElementById\('v2InitPromptSave'\)\.addEventListener/, '保存按钮已绑定事件');
  assert.match(html, /api\('\/api\/socialV2\/initial-prompt'/, '面板调用 /api/socialV2/initial-prompt');
  assert.match(html, /仅在首次唤醒|只在.*首次唤醒/, '面板要说明"仅首次唤醒生效"这一关键行为');
  // 面板不得在页面加载时自动请求接口（否则离线 fixture 与请求基线都会变）
  assert.ok(!/window\.addEventListener\('load'[\s\S]{0,400}initial-prompt/.test(html), '面板不应在页面加载时自动拉取');
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
