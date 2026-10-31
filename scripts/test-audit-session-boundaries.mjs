// Isolated peers and temporary files only; never connect to QQ or DSH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const OTHER = 'group:789';
const config = { slang: { enabled: true, autoResearch: false }, sendDelayMs: 0 };
const slang = [
  { id: 'global', content: '公共词', meaning: '公共解释', status: 'confirmed', scope: 'global' },
  { id: 'own', content: '本群词', meaning: '本群解释', status: 'confirmed', scope: KEY },
  { id: 'other', content: '同名词', meaning: 'other-group-private-meaning', status: 'confirmed', scope: OTHER },
];
const stickers = [{ id: 'scoped-sticker', source: 'manual', url: 'https://public.invalid/sticker',
  noteScope: OTHER, localNote: 'other-group-private-note', tags: ['private-tag'], usage: 'private-usage' }];

function call(server, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        ...(token ? { 'x-agent-call': '1', 'x-agent-token': token } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

{
  const h = await bridgeHarness({ config, files: { 'state/slang.json': slang, 'state/stickers.json': stickers } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const token = h.getSocialV2State(KEY).agentToken;
    for (const pathname of [`/api/socialV2/slang/query?key=${KEY}`, `/api/socialV2/prompt?key=${KEY}`]) {
      const res = await call(server, pathname, token);
      assert.equal(res.status, 200, pathname);
      const entries = res.json.entries || res.json.slang?.entries;
      assert.deepEqual(entries.map((e) => e.id).sort(), ['global', 'own']);
      assert.ok(!JSON.stringify(res.json).includes('other-group-private-meaning'));
    }
    const submitted = await call(server, '/api/socialV2/slang/submit', token, { key: KEY, content: '同名词' });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.entry.status, 'candidate');
    assert.ok(!JSON.stringify(submitted.json).includes('other-group-private-meaning'));
    const stored = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/slang.json'), 'utf8'));
    assert.equal(stored.filter((e) => e.content === '同名词').length, 2);
    assert.equal(stored.find((e) => e.id === 'other').scope, OTHER);

    for (const body of [undefined, { key: KEY, query: '' }]) {
      const res = await call(server, `/api/socialV2/sticker-list${body ? '' : `?key=${KEY}`}`, token, body);
      assert.equal(res.status, 200);
      const sticker = res.json.stickers.find((e) => e.id === 'scoped-sticker');
      assert.ok(sticker);
      assert.equal(sticker.localNote, '');
      assert.deepEqual(sticker.tags, []);
      assert.equal(sticker.usage, '');
    }
    const search = await call(server, `/api/socialV2/sticker-list?key=${KEY}&query=private-tag`, token);
    assert.equal(search.json.matched, 0, 'private tags must not become a search oracle');
    const admin = await call(server, '/api/stickers');
    assert.equal(admin.json.stickers.find((e) => e.id === 'scoped-sticker').localNote, 'other-group-private-note');
    console.log('PASS scoped slang and sticker HTTP responses exclude other conversations');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

{
  const h = await bridgeHarness({ config });
  try {
    const first = await h.ensureSlangLearnerSession(KEY);
    assert.equal(await h.ensureSlangLearnerSession(KEY), first);
    const second = await h.ensureSlangLearnerSession(OTHER);
    assert.notEqual(second, first, 'changing scope must not reuse model conversation history');
    assert.equal(h.calls.created.length, 2);
    assert.ok(h.calls.forgotten.includes(first), 'retired learner streams must be unsubscribed');
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/slang-session.json'), 'utf8'));
    assert.equal(saved.scope, OTHER);
    console.log('PASS learner model history is replaced when the conversation scope changes');
  } finally { await h.close(); }
}

for (const change of ['pause', 'disable', 'silent']) {
  const h = await bridgeHarness({ config });
  try {
    h.setMode('reserved2');
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    h.bot.sendGroupMessage = async () => {
      entered();
      await new Promise((resolve) => { release = resolve; });
    };
    const blocker = h.sendToQQ(KEY, 'operator fixture');
    await started;
    const queued = h.sendMessagesV2(KEY, ['queued AI output'], []);
    const rejected = assert.rejects(queued, /AI 已暂停、关闭或进入静默模式/);
    if (change === 'pause') h.socialV2.paused = true;
    if (change === 'disable') h.cfg.socialV2.enabled = false;
    if (change === 'silent') fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ mode: 'silent' }));
    release();
    await blocker;
    await rejected;
    assert.equal(h.calls.http.filter((entry) => /send_group_msg/.test(entry.url)).length, 0);
    console.log(`PASS queued AI sends stop after ${change}`);
  } finally { await h.close(); }
}

{
  const entries = [
    { id: 'a', content: '同名词', scope: KEY, status: 'candidate', evidence: [{ text: 'first-group-private-evidence' }] },
    { id: 'b', content: '同名词', scope: OTHER, status: 'candidate', evidence: [{ text: 'second-group-private-evidence' }] },
    { id: 'untargeted', content: '无关词', scope: KEY, status: 'candidate', meaning: 'unchanged' },
  ];
  const h = await bridgeHarness({ config, files: { 'state/slang.json': entries } });
  try {
    const pending = h.runSlangResearch(h.getSlangEntries().slice(0, 2));
    const complete = async (index, output) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const prompt = h.calls.prompts[index];
        if (prompt && h.completeLearnerTurn(prompt.sessionId, JSON.stringify(output))) return prompt;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error('learner fixture never registered a waiter');
    };
    const first = await complete(0, [
      { content: '同名词', meaning: 'first meaning', confirmed: true },
      { content: '无关词', meaning: 'must not overwrite untargeted record', confirmed: true },
    ]);
    const second = await complete(1, [{ content: '同名词', meaning: 'second meaning', confirmed: true }]);
    await pending;
    assert.notEqual(first.sessionId, second.sessionId);
    assert.ok(JSON.stringify(first.content).includes('first-group-private-evidence'));
    assert.ok(!JSON.stringify(first.content).includes('second-group-private-evidence'));
    assert.ok(JSON.stringify(second.content).includes('second-group-private-evidence'));
    assert.ok(!JSON.stringify(second.content).includes('first-group-private-evidence'));
    const result = h.getSlangEntries();
    assert.equal(result.find((e) => e.id === 'a').meaning, 'first meaning');
    assert.equal(result.find((e) => e.id === 'b').meaning, 'second meaning');
    assert.equal(result.find((e) => e.id === 'untargeted').meaning, 'unchanged');
    console.log('PASS research batches isolate evidence and update only their requested record IDs');
  } finally { await h.close(); }
}

for (const change of ['pause', 'disable', 'mode', 'reset']) {
  const h = await bridgeHarness({ config });
  const server = h.startConsoleServer();
  let release;
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    const token = h.getSocialV2State(KEY).agentToken;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    h.bot.getGroupMemberList = async () => {
      entered();
      await new Promise((resolve) => { release = resolve; });
      return [{ user_id: 111 }];
    };
    let sent = 0;
    h.bot.raw = async () => { sent++; return {}; };
    const response = call(server, '/api/socialV2/send-poke', token, { key: KEY, targetUserId: '111' });
    await started;
    if (change === 'pause') h.socialV2.paused = true;
    if (change === 'disable') h.cfg.socialV2.enabled = false;
    if (change === 'mode') h.setMode('chat');
    if (change === 'reset') h.retireSession(KEY);
    release();
    const result = await response;
    assert.notEqual(result.status, 200);
    assert.equal(sent, 0, 'poke must recheck permissions after member lookup');
    console.log(`PASS pending member lookup cannot send a poke after ${change}`);
  } finally {
    release?.();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}
