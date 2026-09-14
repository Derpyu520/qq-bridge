// 群内机器人名册单测：用假的 OneBot 调用器覆盖「权威 is_robot / 启发式兜底 / 手工名单 / 缓存」四条路径。
// 运行：node scripts/test-bot-registry.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBotRegistry, DEFAULT_NAME_PATTERNS } from '../src/bot-registry.js';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbots-'));
function stateFile(tag) {
  return path.join(tmpDir, `${tag}.json`);
}

// SnowLuma 的 get_group_member_list 形状（含 is_robot，见 formatGroupMember）
const AUTHORITATIVE_MEMBERS = [
  { user_id: 1001, nickname: '小明', card: '', role: 'member', is_robot: false },
  { user_id: 1002, nickname: '签到机器人', card: '', role: 'member', is_robot: true },
  { user_id: 1003, nickname: '普通昵称', card: '群管小助手', role: 'admin', is_robot: true },
  { user_id: 1004, nickname: '小红', card: '', role: 'member', is_robot: false }
];

// 老网关：没有 is_robot 字段 → 只能靠昵称猜
const LEGACY_MEMBERS = [
  { user_id: 2001, nickname: '小明', card: '' },
  { user_id: 2002, nickname: '点歌Bot', card: '' },
  { user_id: 2003, nickname: '普通昵称', card: '群管小助手' },
  { user_id: 2004, nickname: '小红', card: '' }
];

function makeCall(members, counter) {
  return async (action, params) => {
    assert.equal(action, 'get_group_member_list');
    assert.ok(params.group_id, 'group_id 必须传');
    if (counter) counter.n++;
    return members;
  };
}

console.log('权威 is_robot 模式');

await check('只把 is_robot=true 的人当机器人', async () => {
  const reg = createBotRegistry({ call: makeCall(AUTHORITATIVE_MEMBERS), stateFile: stateFile('a') });
  assert.equal(await reg.refresh('9001', { force: true }), true);
  assert.equal(reg.isBot('9001', 1002), true);
  assert.equal(reg.isBot('9001', 1003), true);
  assert.equal(reg.isBot('9001', 1001), false);
  assert.equal(reg.isBot('9001', 1004), false);
  assert.equal(reg.meta('9001').authoritative, true);
  assert.equal(reg.list('9001').length, 2);
});

await check('群名片里带"助手"但 is_robot=false 的人不算机器人（权威优先）', async () => {
  const reg = createBotRegistry({ call: makeCall([
    { user_id: 1100, nickname: '人类', card: '助手小王', is_robot: false }
  ]), stateFile: stateFile('b') });
  await reg.refresh('9002', { force: true });
  assert.equal(reg.isBot('9002', 1100), false);
});

console.log('老网关启发式兜底');

await check('无 is_robot 字段时按昵称猜，并标 authoritative=false', async () => {
  const reg = createBotRegistry({ call: makeCall(LEGACY_MEMBERS), stateFile: stateFile('c'), cfg: {} });
  await reg.refresh('9003', { force: true });
  assert.equal(reg.meta('9003').authoritative, false);
  assert.equal(reg.isBot('9003', 2002), true, '点歌Bot 应被识别');
  assert.equal(reg.isBot('9003', 2003), true, '群管小助手 应被识别');
  assert.equal(reg.isBot('9003', 2001), false);
  const info = reg.botInfo('9003', 2002);
  assert.equal(info.source, 'heuristic');
});

await check('默认启发式关键词非空', () => {
  assert.ok(DEFAULT_NAME_PATTERNS.length > 0);
});

console.log('手工名单');

await check('config.bots.known 里的 QQ 永远算机器人', async () => {
  const reg = createBotRegistry({
    call: makeCall(AUTHORITATIVE_MEMBERS),
    stateFile: stateFile('d'),
    cfg: { known: [{ qq: 1001, name: '手工登记的机器人' }] }
  });
  await reg.refresh('9004', { force: true });
  assert.equal(reg.isBot('9004', 1001), true, '即 is_robot=false 也要认');
  assert.equal(reg.botInfo('9004', 1001).source, 'manual');
});

await check('名单外的群也能查到手工机器人', async () => {
  const reg = createBotRegistry({
    call: makeCall(AUTHORITATIVE_MEMBERS),
    stateFile: stateFile('e'),
    cfg: { known: [{ qq: 8888, name: '外群机器人' }] }
  });
  assert.equal(reg.isBot('9999', 8888), true);
  assert.equal(reg.botInfo('9999', 8888).source, 'manual');
});

console.log('刷新与缓存');

await check('TTL 内不重复请求；force 会重新拉', async () => {
  const counter = { n: 0 };
  const reg = createBotRegistry({ call: makeCall(AUTHORITATIVE_MEMBERS, counter), stateFile: stateFile('f'), cfg: { refreshMs: 600000 } });
  await reg.refresh('9005', { force: true });
  assert.equal(counter.n, 1);
  await reg.refresh('9005');
  assert.equal(counter.n, 1, 'TTL 内不应重复请求');
  await reg.refresh('9005', { force: true });
  assert.equal(counter.n, 2, 'force 应重新请求');
});

await check('OneBot 报错时不抛异常，名册保持原样', async () => {
  let fail = false;
  const reg = createBotRegistry({
    call: async () => { if (fail) throw new Error('网关挂了'); return AUTHORITATIVE_MEMBERS; },
    stateFile: stateFile('g')
  });
  await reg.refresh('9006', { force: true });
  assert.equal(reg.isBot('9006', 1002), true);
  fail = true;
  assert.equal(await reg.refresh('9006', { force: true }), false, '失败应返回 false 而不是抛错');
  assert.equal(reg.isBot('9006', 1002), true, '旧名册应保留');
});

await check('autoDetect=false 时完全不请求网关', async () => {
  const counter = { n: 0 };
  const reg = createBotRegistry({ call: makeCall(AUTHORITATIVE_MEMBERS, counter), stateFile: stateFile('h'), cfg: { autoDetect: false } });
  assert.equal(await reg.refresh('9007', { force: true }), false);
  assert.equal(counter.n, 0);
});

console.log('持久化与查询');

await check('名册落盘并在新实例中恢复', async () => {
  const file = stateFile('persist');
  const reg1 = createBotRegistry({ call: makeCall(AUTHORITATIVE_MEMBERS), stateFile: file });
  await reg1.refresh('9008', { force: true });
  assert.ok(fs.existsSync(file), '状态文件应已写入');

  const reg2 = createBotRegistry({ call: makeCall([]), stateFile: file });
  assert.equal(reg2.isBot('9008', 1002), true, '新实例应恢复名册');
  assert.equal(reg2.meta('9008').authoritative, true);
});

await check('findByNickname 支持模糊匹配与 QQ 号', async () => {
  const reg = createBotRegistry({ call: makeCall(AUTHORITATIVE_MEMBERS), stateFile: stateFile('i') });
  await reg.refresh('9009', { force: true });
  assert.equal(reg.findByNickname('9009', '签到').qq, '1002');
  assert.equal(reg.findByNickname('9009', '1003').name, '群管小助手');
  assert.equal(reg.findByNickname('9009', '不存在'), null);
});

await check('markBot 运行时登记', async () => {
  const reg = createBotRegistry({ call: makeCall([]), stateFile: stateFile('j') });
  assert.equal(reg.isBot('9010', 4321), false);
  reg.markBot('9010', 4321, '野生机器人');
  assert.equal(reg.isBot('9010', 4321), true);
  assert.equal(reg.findByNickname('9010', '野生').name, '野生机器人');
});

await check('空群成员列表不覆盖已有名册', async () => {
  const file = stateFile('k');
  const reg = createBotRegistry({ call: makeCall(AUTHORITATIVE_MEMBERS), stateFile: file });
  await reg.refresh('9011', { force: true });
  const reg2 = createBotRegistry({ call: makeCall([]), stateFile: file });
  assert.equal(await reg2.refresh('9011', { force: true }), false, '空列表应视为失败');
  assert.equal(reg2.isBot('9011', 1002), true);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n通过 ${passed} 项${process.exitCode ? '，有失败' : '，全部通过'}`);
