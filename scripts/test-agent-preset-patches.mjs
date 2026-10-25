// 钉住 DSH 0.1.7 preset 装配的「防漂移」契约（纯离线，不需要 DSH 在跑）：
//   1. bundle patch（plugins/qq-agent-presets/presets/*.patch.yml）与仓库权威源
//      （dsh/agent-presets/<preset>/{preset.yml,agent.cordis.yml}）逐字一致；
//   2. patch 的形状符合新机制：insert 一条 @deepseek-ai/dsh-agent-preset 行，
//      config 里带 id/name/description/order/plugins；
//   3. 守卫行只能用「从 profile 目录可解析」的引用方式（裸说明符），
//      不允许任何相对/绝对路径子行名 —— 那正是 0.1.7 下静默装不上的坑；
//   4. 安全边界（qq-tool-restrict 的 fail-closed 白名单）一份实现、两个 preset 共用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  BUNDLE_DIR, GUARD_SPECIFIER, PRESETS, RELATIVE_ROW_REWRITES, REPO_ROOT,
  buildPatches, patchFileFor, presetRowId,
} from './build-agent-preset-patches.mjs';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
}

const read = (p) => fs.readFileSync(p, 'utf8');
const load = (p) => yaml.load(read(p));

console.log('## 1. 产物与源不漂移（--check 语义）');
{
  const results = buildPatches({ check: true, log: () => {} });
  for (const { file, changed } of results) {
    ok(!changed, `${path.relative(REPO_ROOT, file)} 与源一致（不一致请跑 node scripts/build-agent-preset-patches.mjs）`);
  }
}

console.log('## 2. patch 形状符合 DSH 0.1.7 的 preset 机制');
for (const name of PRESETS) {
  const file = patchFileFor(name);
  ok(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} 存在`);
  const doc = load(file);
  ok(Array.isArray(doc) && doc.length === 1 && Array.isArray(doc[0]?.insert), `${name}: 顶层是 [ { insert: [...] } ]`);
  const row = doc[0].insert[0];
  ok(row.id === presetRowId(name), `${name}: 行 id = ${presetRowId(name)}（非 preset 名，便于按行定位）`);
  ok(row.name === '@deepseek-ai/dsh-agent-preset', `${name}: 行 name = @deepseek-ai/dsh-agent-preset`);
  ok(row.config?.id === name, `${name}: config.id = ${name}（桥接按这个 id 解析 preset）`);
  const meta = load(path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'preset.yml'));
  ok(row.config.name === meta.name && row.config.description === meta.description && row.config.order === meta.order,
    `${name}: preset.yml 的 name/description/order 原样带进 config`);
  ok(Array.isArray(row.config.plugins) && row.config.plugins.length > 0, `${name}: config.plugins 非空（新机制里必填）`);

  // 与源行列表逐字对比：只允许**已登记**的相对行名被改写（见 build 脚本的
  // RELATIVE_ROW_REWRITES）。这里按同一张表来算期望值，避免每加一个相对行插件
  // 就要同步改一次测试。
  const source = load(path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml'));
  const expected = structuredClone(source);
  for (const r of expected) {
    const rewritten = RELATIVE_ROW_REWRITES.get(r.name);
    if (rewritten !== undefined) r.name = rewritten;
  }
  assert.deepEqual(row.config.plugins, expected, `${name}: config.plugins 必须与 agent.cordis.yml 完全一致（已登记的相对行名除外）`);
  ok(true, `${name}: config.plugins 与 agent.cordis.yml 逐字一致（${expected.length} 行）`);

  // 人格正文是产品本体：单独再钉一次，防止「顺手改写/截断」。
  const srcPersona = source.find((r) => r.id === 'persona');
  const patchPersona = row.config.plugins.find((r) => r.id === 'persona');
  ok(typeof srcPersona?.config?.prefix === 'string' && srcPersona.config.prefix === patchPersona?.config?.prefix,
    `${name}: persona.prefix 逐字一致（${srcPersona?.config?.prefix?.length ?? 0} 字符）`);
}

console.log('## 3. 守卫行引用方式：只用「profile 目录可解析」的裸说明符');
for (const name of PRESETS) {
  const row = load(patchFileFor(name))[0].insert[0];
  const guard = row.config.plugins.find((r) => r.id === 'qq-tool-restrict');
  ok(guard !== undefined, `${name}: 有 qq-tool-restrict 守卫行`);
  ok(guard?.name === GUARD_SPECIFIER, `${name}: 守卫行 name = ${GUARD_SPECIFIER}`);
  const bad = row.config.plugins.filter((r) => typeof r.name === 'string' && (r.name.startsWith('.') || path.isAbsolute(r.name)));
  ok(bad.length === 0, `${name}: 没有任何相对/绝对路径子行名（0.1.7 下会按 profile 目录解析而装不上）${bad.length ? `：${bad.map((r) => r.name).join(', ')}` : ''}`);
  const guardFile = path.join(BUNDLE_DIR, GUARD_SPECIFIER.slice('qq-agent-presets/'.length));
  ok(fs.existsSync(guardFile), `${name}: 守卫实现存在（${path.relative(REPO_ROOT, guardFile)}）`);
}

console.log('## 4. bundle 声明与安全边界');
{
  const pkg = JSON.parse(read(path.join(BUNDLE_DIR, 'package.json')));
  const patches = pkg.dsh?.bundle?.patch;
  ok(Array.isArray(patches), 'qq-agent-presets 的 dsh.bundle.patch 是数组（一个 bundle 可带多层 patch）');
  for (const name of PRESETS) {
    const declared = `./presets/${name}.patch.yml`;
    ok(patches?.includes(declared), `bundle 列出了 ${declared}`);
    ok(fs.existsSync(path.join(BUNDLE_DIR, declared)), `${declared} 存在`);
  }

  const canonical = path.join(BUNDLE_DIR, 'qq-tool-restrict.mjs');
  const canonicalText = read(canonical);
  for (const needle of ["const SAFE_PREFIXES", "'mcp__snowluma__'", "'mcp__web-search-safe__'", 'SAFE_EXACT', 'return `工具 "']) {
    ok(canonicalText.includes(needle), `权威守卫包含 ${needle}`);
  }
  // 一份实现：两个 preset 目录下的同名文件必须是 re-export 壳，且导出同名成员。
  const canonicalMod = await import(pathToFileURL(canonical).href);
  for (const name of PRESETS) {
    const shim = path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'qq-tool-restrict.mjs');
    ok(/^export \* from '\.\.\/\.\.\/\.\.\/plugins\/qq-agent-presets\/qq-tool-restrict\.mjs'$/m.test(read(shim).trim()),
      `${name}/qq-tool-restrict.mjs 是指向唯一实现的 re-export 壳`);
    const shimMod = await import(pathToFileURL(shim).href);
    assert.equal(shimMod.apply, canonicalMod.apply, `${name}: 壳与实现在同一模块实例上`);
    assert.equal(shimMod.name, 'qq-tool-restrict');
    assert.deepEqual(shimMod.inject, ['tools']);
  }
  ok(true, 're-export 壳与权威实现导出同一份 apply/inject');

  // fail-closed 复检（独立于 test-audit-setup-guards.mjs 的那份假 ctx 测试）。
  let guardFn;
  const restricted = [];
  canonicalMod.apply({ tools: { restrict: ({ deny }) => restricted.push(...deny), guard: (fn) => { guardFn = fn; } } });
  ok(restricted.includes('pwsh') && restricted.includes('dev_install_package'), 'restrict 名单含本地执行面与开发注入器工具');
  for (const name of ['ask_user_question', 'todo_write', 'mcp__snowluma__qq_send_message', 'mcp__web-search-safe__web_fetch']) {
    assert.equal(guardFn({ name }), undefined, `白名单应放行 ${name}`);
  }
  ok(true, '白名单放行 QQ MCP 与无害模型侧工具');
  let deniedAll = true;
  for (const name of ['bash', 'read', 'write', 'dev_future_unknown_tool', 'mcp__other__x', '', null, undefined, 123]) {
    if (typeof guardFn({ name }) !== 'string') deniedAll = false;
  }
  ok(deniedAll, '非法/未知/空工具名一律拒绝（fail-closed）');
}

console.log(failures === 0 ? '\n✅ agent preset patch 契约通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
