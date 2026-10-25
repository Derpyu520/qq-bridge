// 仿真提示词改写（src/preset-prompt.js）的离线单测。
// 这些检查保证「控制台改仿真提示词」不会破坏 YAML、不会丢别的条目、不会改变提示词语义。
// 不连 DSH、不连 QQ、不写任何生产文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';
import {
  PRESET_BLOCKING_SUBSTRINGS,
  PRESET_REQUIRED_MARKERS,
  extractPresetPrefix,
  locatePresetPromptBlock,
  presetBlockingSubstrings,
  presetPromptBlockers,
  presetPromptWarnings,
  renderPresetPromptYaml,
} from '../src/preset-prompt.js';

const PRESET_PATH = new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url);
const source = fs.readFileSync(PRESET_PATH, 'utf8');
const originalPrefix = extractPresetPrefix(source);

// 回归：内置预设必须满足**它自己那一代**的硬性不变量。
//
// 背景：保存/还原的校验曾经对两代预设用同一份清单（那份清单是照二代写的），
// 结果一代预设（qq-chat）在控制台里 100% 存不进去、也还原不了 ——
// 报错还说它「缺少安全不变量」，而它从来就没打算有那些工具面表述。
// 这条测试同时钉住两件事：① 每代预设都能通过自己的清单；② 清单本身没写错字。
test('每代内置预设都满足自己那一代的安全不变量', () => {
  for (const [name, gen] of [['qq-chat', 'v1'], ['qq-chat-v2', 'v2']]) {
    const text = fs.readFileSync(new URL(`../dsh/agent-presets/${name}/agent.cordis.yml`, import.meta.url), 'utf8');
    const prefix = extractPresetPrefix(text);
    assert.equal(typeof prefix, 'string', `${name} 应能抽出 persona.prefix`);
    const blockers = presetPromptBlockers(prefix, gen);
    assert.deepEqual(blockers, [], `${name}（${gen}）不应有阻断项，实际：${blockers.join('；')}`);
  }
});

test('一代与二代的硬性不变量清单确实不同（防止又合并成一份）', () => {
  assert.notDeepEqual(presetBlockingSubstrings('v1'), presetBlockingSubstrings('v2'));
  // 二代的工具面不变量不应该出现在一代清单里
  assert.ok(!presetBlockingSubstrings('v1').includes('你没有本地工具'));
});

test('真实预设能定位到 persona 的 prefix 块', () => {
  const loc = locatePresetPromptBlock(source);
  assert.ok(loc, '应能定位 prefix 块');
  assert.equal(loc.lines[loc.keyLine].trim(), 'prefix: >-');
  assert.ok(loc.blockEnd > loc.keyLine + 1, 'prefix 块应包含内容行');
  assert.ok(loc.entryEnd > loc.blockEnd, 'persona 条目应在 prefix 块之后还有内容');
});

test('抽出的是 YAML 解析后的真实字符串（折叠标量已展开）', () => {
  assert.equal(typeof originalPrefix, 'string');
  assert.ok(originalPrefix.length > 2000, `提示词应有实质内容，实际 ${originalPrefix.length} 字符`);
  for (const marker of PRESET_REQUIRED_MARKERS) {
    assert.ok(originalPrefix.includes(marker), `内置提示词应包含安全基线段落：${marker}`);
  }
  assert.ok(originalPrefix.includes('{{model}}'), '应保留模板变量');
});

test('原样写回是幂等的，且不改变提示词语义', () => {
  const rewritten = renderPresetPromptYaml(source, originalPrefix);
  assert.equal(extractPresetPrefix(rewritten), originalPrefix, '读回应与原提示词逐字一致');
  // 再写一次仍稳定
  assert.equal(renderPresetPromptYaml(rewritten, originalPrefix), rewritten);
});

test('改写只动 prefix，其它条目与文件头注释原样保留', () => {
  const next = renderPresetPromptYaml(source, `${originalPrefix}\n\n【新增段落】测试内容。`);
  const before = yaml.load(source);
  const after = yaml.load(next);
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id), '条目 id 顺序不变');
  for (const id of before.map((row) => row.id)) {
    if (id === 'persona') continue;
    assert.deepEqual(after.find((row) => row.id === id), before.find((row) => row.id === id), `条目 ${id} 不应被改动`);
  }
  assert.deepEqual(
    after.find((row) => row.id === 'persona').config.suffix,
    before.find((row) => row.id === 'persona').config.suffix,
    'persona 的 suffix 不应被改动',
  );
  // 文件头注释（前 6 行）必须原样保留
  assert.deepEqual(next.split('\n').slice(0, 6), source.split('\n').slice(0, 6), '文件头注释应保留');
  assert.ok(next.includes('prefix: |-'), '应使用字面量块写回');
});

test('特殊内容可安全往返（空行、缩进、Markdown、模板变量、CJK 标点）', () => {
  const tricky = [
    '# 标题',
    '',
    '- 列表项：含冒号: 和 # 井号',
    '    - 缩进 4 空格的子项',
    '',
    '```js',
    'const a = 1; // { 括号 } 也不能破坏 YAML',
    '```',
    '',
    '【中文段落】含全角标点：，。！？——以及 {{model}} / {{cwd}} 变量',
    '结尾不留多余空行',
  ].join('\n');
  // 必须在保留安全不变量的前提下追加特殊内容，否则会被阻断校验拦下
  const next = renderPresetPromptYaml(source, `${originalPrefix}\n\n${tricky}`);
  assert.equal(extractPresetPrefix(next), `${originalPrefix}\n\n${tricky}`);
  const rows = yaml.load(next);
  assert.equal(rows.length, yaml.load(source).length, '其它条目数量不变');
});

test('危险输入被拒绝，且不产生半截结果', () => {
  assert.throws(() => renderPresetPromptYaml(source, ''), /不能为空/);
  assert.throws(() => renderPresetPromptYaml(source, '   \n  \n'), /不能为空/);
  assert.throws(() => renderPresetPromptYaml(source, 'x'.repeat(200 * 1024)), /过长/);
  assert.throws(() => renderPresetPromptYaml('foo: bar\n', 'x'), /无法定位/);
  assert.throws(() => renderPresetPromptYaml('- id: other\n  config:\n    prefix: >-\n      x\n', 'x'), /无法定位/);
});

test('删掉安全不变量或正文过短时阻断保存（保护 AI 效果与自家测试）', () => {
  // 正文过短
  assert.throws(() => renderPresetPromptYaml(source, '太短了'), /过短/);
  // 逐条移除安全不变量，必须被拦住
  for (const needle of PRESET_BLOCKING_SUBSTRINGS) {
    const tampered = originalPrefix.replace(needle, '（已删除）');
    assert.throws(
      () => renderPresetPromptYaml(source, tampered),
      new RegExp(`缺少安全不变量「${needle}」`),
      `删除「${needle}」后仍被允许保存`,
    );
  }
  // 只做无损追加则应当通过
  assert.doesNotThrow(() => renderPresetPromptYaml(source, `${originalPrefix}\n\n【补充】一句新规则。`));
  const clean = presetPromptBlockers(originalPrefix);
  assert.deepEqual(clean, [], `内置提示词不应有阻断项，实际：${clean.join('；')}`);
});

test('写回沿用文件主导行尾，且不吞掉块尾空行', () => {
  const next = renderPresetPromptYaml(source, originalPrefix);
  const crlf = (next.match(/\r\n/g) ?? []).length;
  const lfOnly = (next.match(/\n/g) ?? []).length - crlf;
  assert.ok(crlf > 0, 'CRLF 文件写回后应仍使用 CRLF');
  assert.equal(lfOnly, 0, '写回后不应残留/新增 LF-only 行');
  assert.ok(next.includes('prefix: |-\r\n'), '新增行应使用 CRLF');
  // 块之后的内容（空行、注释、后续条目）必须逐字保留
  const before = locatePresetPromptBlock(source);
  const after = locatePresetPromptBlock(next);
  assert.deepEqual(
    next.split('\n').slice(after.blockEnd),
    source.split('\n').slice(before.blockEnd),
    'prefix 块之后的内容应逐字不变（含块尾空行与注释）',
  );
  assert.ok(source.split('\n').slice(before.blockEnd).some((l) => l.trim() === ''), '样本应确实包含块尾空行，否则该断言无意义');
});

test('只含空格/Tab 的行也能安全往返（不会被当成空行读丢）', () => {
  // 取**够用的**头部行而不是固定前 3 行：预设正文会随迭代增删段落，
  // 写死行数会让"改预设"顺手把这条测试弄挂，而它想验证的其实是空白行往返。
  const head = originalPrefix.split('\n');
  const needed = presetBlockingSubstrings('v2');
  let take = 0;
  for (let i = 0; i < head.length && take === 0; i += 1) {
    if (needed.every((s) => head.slice(0, i + 1).join('\n').includes(s))) take = i + 1;
  }
  assert.ok(take > 0, '前置条件：内置预设的头部若干行里应当已经覆盖全部安全不变量');
  const spaced = [
    ...head.slice(0, take),
    '   ',
    '\t',
    ' 带前后空格的正文 ',
    '正常一行',
  ].join('\n');
  const next = renderPresetPromptYaml(source, spaced);
  assert.equal(extractPresetPrefix(next), spaced, '空白行必须原样保留');
});

test('缺少安全基线段落时给出警告（但不阻断保存）', () => {
  assert.deepEqual(presetPromptWarnings(originalPrefix), [], '内置提示词不应有警告');
  const stripped = originalPrefix.replace(/【二代仿真模式 —— 安全规则[^\n]*\n/, '');
  const warnings = presetPromptWarnings(stripped);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /安全规则/);
  assert.ok(presetPromptWarnings('').some((w) => /内容为空/.test(w)));
});
