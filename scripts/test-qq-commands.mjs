// QQ 指令表 / 解析器单测（纯函数，不需要连网）。
// 运行：node scripts/test-qq-commands.mjs
import assert from 'node:assert/strict';
import {
  parseCommand,
  renderHelp,
  commandAllowed,
  findCommand,
  unknownCommandHint,
  COMMANDS
} from '../src/qq-commands.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

console.log('parseCommand');

check('普通指令', () => {
  const r = parseCommand('/状态');
  assert.equal(r.cmd.name, 'status');
  assert.equal(r.args, '');
});

check('带参数', () => {
  const r = parseCommand('/潜水 30');
  assert.equal(r.cmd.name, 'sleep');
  assert.equal(r.args, '30');
});

check('全角斜杠', () => {
  const r = parseCommand('／帮助');
  assert.equal(r.cmd.name, 'help');
});

check('英文别名', () => {
  assert.equal(parseCommand('/h').cmd.name, 'help');
  assert.equal(parseCommand('/?').cmd.name, 'help');
  assert.equal(parseCommand('/new').cmd.name, 'reset');
});

check('中文别名', () => {
  assert.equal(parseCommand('/重置').cmd.name, 'reset');
  assert.equal(parseCommand('/调机器人 签到 签到').cmd.name, 'call');
  assert.equal(parseCommand('/调机器人 签到 签到').args, '签到 签到');
});

check('大小写无关', () => {
  assert.equal(parseCommand('/STATUS').cmd.name, 'status');
});

check('先 @ 机器人再跟指令', () => {
  const r = parseCommand('@小鲸鱼 /状态', { botName: '小鲸鱼' });
  assert.equal(r.cmd.name, 'status');
});

check('不是指令返回 null', () => {
  assert.equal(parseCommand('你好啊'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('   '), null);
  assert.equal(parseCommand('/'), null);
});

check('未知指令：cmd 为 null 但认得出来是指令', () => {
  const r = parseCommand('/不存在的指令');
  assert.equal(r.cmd, null);
  assert.equal(r.rawName, '不存在的指令');
});

check('自定义前缀', () => {
  assert.equal(parseCommand('!状态', { prefixes: ['!'] }).cmd.name, 'status');
  assert.equal(parseCommand('/状态', { prefixes: ['!'] }), null);
});

console.log('commandAllowed');

check('owner 才能用管理指令', () => {
  const reset = findCommand('reset');
  assert.equal(commandAllowed(reset, { isOwner: false, isGroup: true }), false);
  assert.equal(commandAllowed(reset, { isOwner: true, isGroup: true }), true);
});

check('公开指令谁都能用', () => {
  const help = findCommand('help');
  assert.equal(commandAllowed(help, { isOwner: false, isGroup: true }), true);
  assert.equal(commandAllowed(help, { isOwner: false, isGroup: false }), true);
});

console.log('renderHelp');

check('管理员看到的指令比群友多', () => {
  const owner = renderHelp({ isOwner: true, isGroup: true });
  const member = renderHelp({ isOwner: false, isGroup: true });
  assert.ok(owner.includes('重置'), '管理员帮助应含重置');
  assert.ok(!member.includes('重置'), '群友帮助不应含重置');
  assert.ok(member.includes('帮助'));
  assert.ok(member.includes('部分管理指令仅管理员可用'));
});

check('每个指令都有 name/usage/desc', () => {
  for (const cmd of COMMANDS) {
    assert.ok(cmd.name, '缺少 name');
    assert.ok(cmd.usage, `${cmd.name} 缺少 usage`);
    assert.ok(cmd.desc, `${cmd.name} 缺少 desc`);
    assert.ok(cmd.category, `${cmd.name} 缺少 category`);
  }
});

check('别名不重复', () => {
  const seen = new Map();
  for (const cmd of COMMANDS) {
    for (const alias of [cmd.name, ...(cmd.aliases ?? [])]) {
      const key = String(alias).toLowerCase();
      assert.ok(!seen.has(key), `别名冲突：${alias} 同时属于 ${seen.get(key)} 与 ${cmd.name}`);
      seen.set(key, cmd.name);
    }
  }
});

console.log('unknownCommandHint');

check('群友未知指令给提示，管理员返回 null（转 DSH）', () => {
  assert.ok(unknownCommandHint('foo', { isOwner: false }));
  assert.equal(unknownCommandHint('model', { isOwner: true }), null);
});

console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
