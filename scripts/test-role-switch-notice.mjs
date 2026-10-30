// 人格切换事件的离线回归（不连 DSH、不发 QQ）：
//   ① 首次见到某会话不提示（那时没有「旧人设」）
//   ② 换角色后，该会话下一次唤醒带【人格切换事件】，写明旧名 → 新名，并注入新卡正文
//   ③ 只改卡内容（角色名不变）时提示的是【角色卡更新】
//   ④ 同一次切换只提示一次
//   ⑤ 切换事件按会话隔离：A 群切过，不影响 B 群
//   ⑥ 未启用角色时不产生任何提示
//   ⑦ 同一次唤醒内的重复构建（8s 去重窗口）两份提示词都带同样的说明
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const OTHER = 'group:789';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}

// 关掉去重窗口，让每次调用都是独立一次唤醒（生产默认 8000ms）
const noDedupe = { role: { injectDedupeWindowMs: 0 } };

const filesFor = (role) => ({
  'roles/测试人格.md': '# 测试人格\n\n- 称呼：叫他「宝宝」。\n',
  'roles/另一个人格.md': '# 另一个人格\n\n- 称呼：叫他「老板」。\n',
  'state/current-role.json': JSON.stringify({ role, mode: 'active' })
});

const switchRole = (h, role) => fs.writeFileSync(
  path.join(h.temp, 'state/current-role.json'),
  JSON.stringify({ role, mode: 'active' })
);

await test('首次见到该会话不提示切换', async () => {
  const h = await bridgeHarness({ config: noDedupe, files: filesFor('测试人格') });
  try {
    assert.doesNotMatch(h.buildWakePromptV2(KEY, 'atMention'), /人格切换事件/);
  } finally { await h.close(); }
});

await test('换角色后下一次唤醒带切换事件，并注入新卡正文', async () => {
  const h = await bridgeHarness({ config: noDedupe, files: filesFor('测试人格') });
  try {
    h.buildWakePromptV2(KEY, 'atMention');
    switchRole(h, '另一个人格');
    const prompt = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(prompt, /【人格切换事件】/);
    assert.match(prompt, /「测试人格」/, '应写明旧人格名');
    assert.match(prompt, /「另一个人格」/, '应写明新人格名');
    assert.match(prompt, /不要沿用旧人设/, '要点明上下文里的是旧人设说的');
    assert.match(prompt, /叫他「老板」/, '切换后应同时注入新卡正文（全量）');
  } finally { await h.close(); }
});

await test('只改卡内容时提示「角色卡更新」而不是换人设', async () => {
  const h = await bridgeHarness({ config: noDedupe, files: filesFor('测试人格') });
  try {
    h.buildWakePromptV2(KEY, 'atMention');
    const card = path.join(h.temp, 'roles/测试人格.md');
    fs.writeFileSync(card, '# 测试人格\n\n- 称呼：叫他「小宝」。\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(card, future, future);
    const prompt = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(prompt, /【角色卡更新】/);
    assert.doesNotMatch(prompt, /人格切换事件/, '角色名没变，不该说成换人设');
    assert.match(prompt, /叫他「小宝」/, '改卡后应注入新正文');
  } finally { await h.close(); }
});

await test('同一次切换只提示一次', async () => {
  const h = await bridgeHarness({ config: noDedupe, files: filesFor('测试人格') });
  try {
    h.buildWakePromptV2(KEY, 'atMention');
    switchRole(h, '另一个人格');
    assert.match(h.buildWakePromptV2(KEY, 'atMention'), /【人格切换事件】/);
    assert.doesNotMatch(h.buildWakePromptV2(KEY, 'atMention'), /【人格切换事件】/, '第二次唤醒不该重复提示');
  } finally { await h.close(); }
});

await test('切换事件按会话隔离', async () => {
  const h = await bridgeHarness({ config: noDedupe, files: filesFor('测试人格') });
  try {
    h.buildWakePromptV2(KEY, 'atMention');
    switchRole(h, '另一个人格');
    assert.match(h.buildWakePromptV2(KEY, 'atMention'), /【人格切换事件】/, 'A 会话应收到提示');
    assert.doesNotMatch(h.buildWakePromptV2(OTHER, 'atMention'), /【人格切换事件】/, 'B 会话没切过，不该收到提示');
  } finally { await h.close(); }
});

await test('未启用角色时不产生任何提示', async () => {
  const h = await bridgeHarness({ config: noDedupe, files: { 'state/current-role.json': JSON.stringify({ role: null, mode: 'active' }) } });
  try {
    const prompt = h.buildWakePromptV2(KEY, 'atMention');
    assert.doesNotMatch(prompt, /人格切换事件/);
    assert.doesNotMatch(prompt, /【当前角色】/);
  } finally { await h.close(); }
});

await test('同一次唤醒的重复构建两份提示词都带切换说明（默认 8s 去重）', async () => {
  const h = await bridgeHarness({ files: filesFor('测试人格') }); // 默认去重窗口
  try {
    h.buildWakePromptV2(KEY, 'atMention');
    switchRole(h, '另一个人格');
    const first = h.buildWakePromptV2(KEY, 'atMention');
    const second = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(first, /【人格切换事件】/);
    assert.match(second, /【人格切换事件】/, '投递与复核两份提示词都要带，否则模型可能恰好没看到');
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n人格切换事件回归：全部通过');
}
