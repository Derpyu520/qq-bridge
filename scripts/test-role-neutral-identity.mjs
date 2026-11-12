// 身份归属回归：桥接注入的人格卡必须是"你是谁"的唯一来源。
// 背景：二代预设的 persona 里曾写死「你只代表 DeepSeek 的鲸鱼形象（大肥鱼/鲸鱼娘）」，
// 而 persona 属于 system prompt、每轮都在；人格卡只在唤醒时按节奏注入（默认每 4 次唤醒
// 才全量一次）。结果是写死的那句在权重和出现频率上都压过人格卡，换角色卡也换不掉自称。
// 同理，qq_get_self_image 曾固定返回某一张厂商素材图，模型一调工具就把别家形象认成自己。
// 这里钉住三件事：预设不再写死厂商形象、身份判定交回角色卡、形象素材按角色名解析。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const PRESET_SOURCE = 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml';
const PRESET_PATCH = 'plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml';

// 写死厂商形象的说法。允许出现在"教模型别这么干"的语境里，
// 所以只断言 persona / 工具描述这类"对模型描述你是谁"的文本。
const VENDOR_IDENTITY = [
  /只代表\s*DeepSeek/,
  /鲸鱼娘/,
  /DeepSeek\s*小鲸鱼/,
  /不冒充\s*Claude/,
];

test('二代预设的 persona 不再写死任何厂商形象', () => {
  const text = read(PRESET_SOURCE);
  for (const pattern of VENDOR_IDENTITY) {
    assert.doesNotMatch(text, pattern, `persona 里残留写死身份的表达：${pattern}`);
  }
});

test('persona 把身份判定明确交回桥接注入的角色卡', () => {
  const text = read(PRESET_SOURCE);
  assert.match(text, /你的名字、形象与自称一律以桥接注入的【当前角色】卡为准/);
  // 反冒充的意图不能被一起删掉，只是判定基准从写死名单变成"角色卡之外"。
  assert.match(text, /不冒充角色卡之外的其他模型、其他厂商、官方客服或官方数字人/);
});

test('生成的 patch 与权威源同步，不会只改一边', () => {
  // patch.yml 头部声明"由脚本生成，请勿手工编辑"。只改源不改生成物，
  // 装到 DSH 上的仍然是旧 persona，所以两边必须带同一句判定基准。
  const source = read(PRESET_SOURCE);
  const patch = read(PRESET_PATCH);
  const clause = /你的名字、形象与自称一律以桥接注入的【当前角色】卡为准[^。\n]*。/;
  assert.match(source, clause);
  assert.match(patch, clause, 'patch.yml 落后于 agent.cordis.yml：请重跑 build-agent-preset-patches.mjs');
  for (const pattern of VENDOR_IDENTITY) {
    assert.doesNotMatch(patch, pattern, `patch.yml 里残留写死身份的表达：${pattern}`);
  }
});

test('qq_get_self_image 的工具描述不再写死厂商形象', () => {
  const text = read('src', 'mcp-snowluma-safe.js');
  const at = text.indexOf("'qq_get_self_image'");
  assert.notEqual(at, -1, '找不到 qq_get_self_image 的注册处');
  const description = text.slice(at, at + 900);
  for (const pattern of VENDOR_IDENTITY) {
    assert.doesNotMatch(description, pattern, `工具描述里残留写死身份的表达：${pattern}`);
  }
  assert.match(description, /跟随当前角色/);
});

test('形象素材按当前角色名解析，且不再回退到任何写死的图', () => {
  const text = read('src', 'bridge.js');
  // 锚定处理分支本身：这个路径名在别处还出现在一个白名单数组里，只 indexOf 一次会取错块。
  const at = text.indexOf("req.method === 'GET' && url.pathname === '/api/socialV2/self-image'");
  assert.notEqual(at, -1, '找不到 self-image 的 GET 处理分支');
  const block = text.slice(at, at + 1800);
  assert.match(block, /sanitizeRoleName\(roleState\.role\)/, '角色名未经 sanitize 就拼路径');
  assert.match(block, /assetsDir \+ path\.sep/, '缺少 assets 目录包含校验（current-role.json 可被手改）');
  assert.doesNotMatch(block, /path\.join\(ROOT, 'assets', '[^']*\.png'\)/, '仍在拼接写死的素材文件名');
  assert.match(block, /没有配图/, '缺图时应如实告知模型，而不是发一张别家形象');
});
