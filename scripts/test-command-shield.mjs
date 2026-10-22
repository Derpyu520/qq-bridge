// 系统指令屏蔽（command shield）回归。
//
// 覆盖三层：
//   ① 纯函数：识别 `#sl` 及其变体（全角/大小写/@前缀），不误伤 `#slim`/`#命令行` 等；
//   ② SnowLuma 上游关闭：备份、幂等、dry-run、BOM 保留、坏 JSON 不落盘；
//   ③ 端到端（虚拟网关 + 真实控制台 HTTP）：屏蔽消息不进入未读、不投递 prompt，
//      控制台 /api/security 的读写校验与「一键关闭 SnowLuma 状态指令」。
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  COMMAND_SHIELD_DEFAULTS,
  commandTokenPattern,
  matchCommandShield,
  normalizeCommandText,
  validateCommandShieldPatterns
} from '../src/command-shield.js';
import { disableSnowLumaStatusCommands } from '../src/snowluma-status-hardening.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
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

function makeSnowLumaHome(statusCommand) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-status-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const file = path.join(home, 'config', 'onebot_10001.json');
  const body = { mode: 'snapshot', networks: { httpServers: [], wsServers: [] }, keep: 'untouched' };
  if (statusCommand !== undefined) body.statusCommand = statusCommand;
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
  return { home, file };
}

console.log('## 归一化');
await test('全角 ＃／字母 → 半角；零宽字符被清掉', () => {
  assert.equal(normalizeCommandText(' ＃ＳＬ '), '#sl');
  assert.equal(normalizeCommandText('#\u200bsl'), '#sl');
});

console.log('## 命中');
for (const [text, id] of [
  ['#sl', 'snowluma-status'],
  ['#SL', 'snowluma-status'],
  ['＃ｓｌ', 'snowluma-status'],
  ['@小鲸鱼 #sl', 'snowluma-status'],
  ['@小鲸鱼#sl', 'snowluma-status'],
  ['#sl？', 'snowluma-status'],
  ['#sl 看看', 'snowluma-status'],
  ['请执行 #sl', 'snowluma-status'],
  ['#snowluma', 'snowluma-status'],
  ['#status', 'status'],
  ['#状态', 'status'],
  ['#help', 'help'],
  ['#帮助', 'help'],
  ['#帮助！', 'help'],
  ['请用#帮助', 'help'],
  ['#指令', 'help'],
  ['#version', 'version'],
  ['#版本', 'version'],
  ['#重启', 'lifecycle']
]) {
  await test(`拦截：${JSON.stringify(text)} → ${id}`, () => {
    const hit = matchCommandShield(text);
    assert.ok(hit, '应当命中');
    assert.equal(hit.id, id);
    assert.ok(hit.command.startsWith('#'), `command 应只含指令本身，实际 ${JSON.stringify(hit.command)}`);
  });
}

console.log('## 不误伤');
for (const text of [
  '',
  '你好',
  '这个 #slim 包不错',
  '#statusbar 是什么',
  '周报#标签',
  'sl 是啥',
  '＃话题讨论',
  // 边界：下面这些是“话题标签/普通叙述”，不是指令调用。
  '输入#sl试试',
  '#命令行',
  '#版本号',
  '#状态栏',
  '#帮助文档',
  '#版本 2.3 更新了什么',
  '#关于这次活动的通知'
]) {
  await test(`放行：${JSON.stringify(text)}`, () => {
    assert.equal(matchCommandShield(text), null);
  });
}

console.log('## 配置');
await test('enabled=false 时全部放行', () => {
  assert.equal(matchCommandShield('#sl', { enabled: false }), null);
});
await test('extraPatterns 生效（搜索式正则）', () => {
  const hit = matchCommandShield('请查看 /admin 面板', { extraPatterns: ['\\/admin'] });
  assert.ok(hit);
  assert.equal(hit.id, 'extra');
});
await test('坏正则不会抛错，只是不生效', () => {
  assert.equal(matchCommandShield('随便一句正常聊天', { extraPatterns: ['([unclosed'] }), null);
  assert.deepEqual(validateCommandShieldPatterns(['ok', '([bad']), ['([bad']);
});
await test('默认值符合预期（开启、10 分钟通知冷却）', () => {
  assert.equal(COMMAND_SHIELD_DEFAULTS.enabled, true);
  assert.equal(COMMAND_SHIELD_DEFAULTS.notifyOwner, true);
  assert.ok(COMMAND_SHIELD_DEFAULTS.notifyCooldownMs >= 60_000);
});
await test('commandTokenPattern：把 SnowLuma 自定义触发词编译成带边界的规则', () => {
  const pattern = commandTokenPattern('＃查状态');
  assert.ok(pattern, '非空触发词应生成规则');
  assert.ok(matchCommandShield('请 ＃查状态 一下', { extraPatterns: [pattern] }), '自定义触发词应命中');
  assert.equal(matchCommandShield('普通聊天', { extraPatterns: [pattern] }), null);
  assert.equal(commandTokenPattern('   '), null, '空触发词返回 null');
});

console.log('## SnowLuma 上游关闭');
await test('关闭 / 备份 / 幂等 / dry-run / BOM / 坏 JSON 不落盘', () => {
  const { home, file } = makeSnowLumaHome({ enabled: true, swallow: false, cooldownSeconds: 5, trigger: '#sl' });
  const backupDir = path.join(home, 'backups');
  try {
    const r1 = disableSnowLumaStatusCommands(home, { backupDir });
    assert.equal(r1.ok, true);
    assert.equal(r1.changed, 1);
    assert.equal(r1.failed, 0);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.statusCommand.enabled, false);
    assert.equal(after.statusCommand.swallow, true);
    assert.equal(after.statusCommand.trigger, '#sl');
    assert.equal(after.statusCommand.cooldownSeconds, 5);
    assert.equal(after.keep, 'untouched', '其它字段必须原样保留');
    assert.ok(r1.accounts[0].backup && fs.existsSync(r1.accounts[0].backup), '必须留下备份');
    const backup = JSON.parse(fs.readFileSync(r1.accounts[0].backup, 'utf8'));
    assert.equal(backup.statusCommand.enabled, true, '备份里应是修改前的配置');

    const r2 = disableSnowLumaStatusCommands(home, { backupDir });
    assert.equal(r2.changed, 0);
    assert.equal(r2.skipped, 1, '已关闭时幂等跳过');

    // dry-run：只报告，不改盘
    const dry = makeSnowLumaHome({ enabled: true, trigger: '#查状态' });
    try {
      const r3 = disableSnowLumaStatusCommands(dry.home, { backupDir, dryRun: true });
      assert.equal(r3.changed, 1);
      assert.equal(JSON.parse(fs.readFileSync(dry.file, 'utf8')).statusCommand.enabled, true, 'dry-run 不得写盘');
    } finally { fs.rmSync(dry.home, { recursive: true, force: true }); }

    // BOM 保留
    const bomHome = makeSnowLumaHome({ enabled: true, trigger: '#sl' });
    try {
      fs.writeFileSync(bomHome.file, '\uFEFF' + fs.readFileSync(bomHome.file, 'utf8'), 'utf8');
      disableSnowLumaStatusCommands(bomHome.home, { backupDir });
      assert.equal(fs.readFileSync(bomHome.file, 'utf8').charCodeAt(0), 0xFEFF, '原文件有 BOM 时必须保留');
    } finally { fs.rmSync(bomHome.home, { recursive: true, force: true }); }

    // 没有 statusCommand 的配置 = SnowLuma 默认开启，也要补上关闭
    const missing = makeSnowLumaHome(undefined);
    try {
      const r4 = disableSnowLumaStatusCommands(missing.home, { backupDir });
      assert.equal(r4.changed, 1);
      const j = JSON.parse(fs.readFileSync(missing.file, 'utf8'));
      assert.equal(j.statusCommand.enabled, false);
      assert.equal(j.statusCommand.trigger, '#sl');
    } finally { fs.rmSync(missing.home, { recursive: true, force: true }); }

    // 坏 JSON：报错但不覆盖原文件
    const broken = makeSnowLumaHome(undefined);
    try {
      fs.writeFileSync(broken.file, '{ not json', 'utf8');
      const r5 = disableSnowLumaStatusCommands(broken.home, { backupDir });
      assert.equal(r5.ok, false);
      assert.equal(r5.failed, 1);
      assert.equal(fs.readFileSync(broken.file, 'utf8'), '{ not json', '坏 JSON 必须原样保留');
    } finally { fs.rmSync(broken.home, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log('## 端到端（reserved2）');
await test('#sl 不进入未读队列、不投递 prompt，并私聊通知管理员', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const event = {
      self_id: 999,
      user_id: 456,
      message_id: 5001,
      message: [{ type: 'text', data: { text: '#sl' } }],
      raw_message: '#sl',
      sender: { nickname: '测试群友', card: '测试群友' }
    };
    await h.handleIncoming('group', '456', event, h.cfg);
    const st = h.socialV2.conversations.get('group:456');
    assert.equal((st?.unread ?? []).length, 0, '被拦截的指令不得进入未读队列');
    assert.equal(h.calls.prompts.length, 0, '被拦截的指令不得投递给 DSH');

    // 管理员通知走 sendToQQ 队列，给一个 tick 让它落进假网关。
    for (let i = 0; i < 50 && !h.calls.sent.some((m) => m.kind === 'private'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const notice = h.calls.sent.find((m) => m.kind === 'private' && String(m.id) === '123');
    assert.ok(notice, '应按 notifyOwner 配置私聊通知管理员');
    assert.match(notice.text, /已拦截系统指令/);
    assert.match(notice.text, /#sl/);
  } finally { await h.close(); }
});

await test('普通群消息仍照常进入未读队列（屏蔽没有掐断整条进线）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const event = {
      self_id: 999,
      user_id: 456,
      message_id: 5002,
      message: [{ type: 'text', data: { text: '大家好呀' } }],
      raw_message: '大家好呀',
      sender: { nickname: '测试群友', card: '测试群友' }
    };
    await h.handleIncoming('group', '456', event, h.cfg);
    const st = h.getSocialV2State('group:456');
    assert.equal((st.unread ?? []).length, 1, '正常消息应进入未读队列');
  } finally { await h.close(); }
});

console.log('## 控制台 /api/security');
await test('读写校验 + 一键关闭 SnowLuma 状态指令', async () => {
  const sl = makeSnowLumaHome({ enabled: true, swallow: false, cooldownSeconds: 5, trigger: '#sl' });
  const h = await bridgeHarness({ config: { snowluma: { homeDir: sl.home } } });
  try {
    await withServer(h, async (port) => {
      const first = await call(port, '/api/security', { headers: ADMIN });
      assert.equal(first.status, 200);
      assert.equal(first.json.security.commandShield.enabled, true);
      assert.equal(first.json.snowlumaStatus.configured, true);
      assert.equal(first.json.snowlumaStatus.accounts[0].enabled, true);

      const badCooldown = await call(port, '/api/security', {
        method: 'POST', headers: ADMIN, body: { commandShield: { notifyCooldownMs: -1 } }
      });
      assert.equal(badCooldown.status, 400);
      const badRegex = await call(port, '/api/security', {
        method: 'POST', headers: ADMIN, body: { commandShield: { extraPatterns: ['([unclosed'] } }
      });
      assert.equal(badRegex.status, 400);
      const badType = await call(port, '/api/security', {
        method: 'POST', headers: ADMIN, body: { commandShield: { enabled: 'yes' } }
      });
      assert.equal(badType.status, 400);

      const saved = await call(port, '/api/security', {
        method: 'POST', headers: ADMIN,
        body: { commandShield: { enabled: false, notifyOwner: false, notifyCooldownMs: 60000, extraPatterns: ['\\/admin'] } }
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.security.commandShield.enabled, false);
      const persisted = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
      assert.equal(persisted.security.commandShield.enabled, false);
      assert.equal(persisted.security.commandShield.notifyOwner, false);
      assert.equal(persisted.security.commandShield.notifyCooldownMs, 60000);
      assert.deepEqual(persisted.security.commandShield.extraPatterns, ['\\/admin']);

      const disabled = await call(port, '/api/security', {
        method: 'POST', headers: ADMIN, body: { disableSnowLumaStatus: true }
      });
      assert.equal(disabled.status, 200);
      assert.equal(disabled.json.changed, 1);
      assert.equal(disabled.json.requiresSnowLumaRestart, true);
      assert.equal(JSON.parse(fs.readFileSync(sl.file, 'utf8')).statusCommand.enabled, false);
      assert.ok(fs.existsSync(path.join(h.temp, 'state', 'command-shield-backups')), '备份目录必须落在 state/ 下');

      const second = await call(port, '/api/security', { headers: ADMIN });
      assert.equal(second.json.snowlumaStatus.accounts[0].enabled, false);
    });
  } finally {
    await h.close();
    fs.rmSync(sl.home, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
