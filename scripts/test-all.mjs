#!/usr/bin/env node
/**
 * 串跑 scripts/test-*.mjs 和 scripts/verify-*.mjs，只打印汇总。
 * 每个脚本的完整输出落到 state/test-all/<名字>.log，失败时把最后 20 行贴出来。
 *
 * 用法：
 *   node scripts/test-all.mjs            # 全部跑
 *   node scripts/test-all.mjs --only token,voice
 *   node scripts/test-all.mjs --list
 *   node scripts/test-all.mjs --fail-fast
 */

import { readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'state', 'test-all');
const TIMEOUT_MS = 180_000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};

/**
 * 默认跳过的两类：
 *  - 要连真实设备/服务（麦克风、GUI、SnowLuma、正在跑的 DSH）；
 *  - 要额外依赖或参数（Playwright、@deepseek-ai/dsh-persona、某个端口）。
 * 跳过的都写明原因，用 --all 强制全跑。
 */
const SKIP_RULES = [
  [/^(test-voice(:|-gui|-system|-edge|-preview|-volume)|test-voice-gui)/, '要麦克风/播报设备'],
  [/^test-dsh-v2-wait/, '要正在跑的 DSH'],
  [/^test-dsh-session-retire/, '要正在跑的 DSH'],
  [/^test-qq-mode-plugin/, '要装进 DSH profile 跑'],
  [/^test-mux-reconnect/, '要真 SnowLuma 连接'],
  [/^test-vision-media/, '要百炼 key 与真实图片 URL'],
  [/^test-stickers/, '要真实表情缓存'],
  [/^test-console-ui/, '要 Playwright'],
  [/^test-dsh-auth/, '要正在跑的 DSH（端口写死 3080，会飘）'],
  [/^test-onebot-connection/, '要真 SnowLuma 在 3003'],
  [/^verify-dsh-021-adaptation/, '要 @deepseek-ai/dsh-persona（本机没装）'],
  [/^verify-persona-config/, '要 @deepseek-ai/dsh-persona（本机没装）'],
  [/^verify-agent-presets-017/, '要正在跑的 DSH'],
  [/^verify-session-log/, '要传会话文件路径参数'],
];

function skipReason(name) {
  for (const [re, why] of SKIP_RULES) if (re.test(name)) return why;
  return '';
}

function collect() {
  const dir = path.join(ROOT, 'scripts');
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => f.startsWith('test-') || f.startsWith('verify-'))
    .filter((f) => f !== 'test-all.mjs')
    .sort();
  return names.map((f) => {
    const name = f.replace(/\.mjs$/, '');
    return { file: f, name, skip: skipReason(name) };
  });
}

const all = collect();
if (flag('--list')) {
  for (const t of all) console.log(`${t.skip ? '·' : '*'}\t${t.name}${t.skip ? `\t(${t.skip})` : ''}`);
  console.log(`\n共 ${all.length} 个（* 默认跑，· 默认跳过、要 --all 或 --only 点名）`);
  process.exit(0);
}

const only = value('--only');
const runAll = flag('--all');
const picked = only
  ? all.filter((t) => only.split(',').map((s) => s.trim()).some((k) => t.name.includes(k)))
  : all.filter((t) => runAll || !t.skip);
const skipped = only ? [] : all.filter((t) => !runAll && t.skip);

if (!picked.length) {
  console.error('没有匹配的测试。用 --list 看有哪些。');
  process.exit(1);
}
if (skipped.length) {
  console.log(`跳过 ${skipped.length} 个（要设备/服务/依赖）：`);
  for (const t of skipped) console.log(`  · ${t.name} —— ${t.skip}`);
  console.log('');
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const t0 = Date.now();

for (const [i, t] of picked.entries()) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join('scripts', t.file)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const ms = Date.now() - started;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  writeFileSync(path.join(OUT_DIR, `${t.name}.log`), out, 'utf8');
  const code = r.status === null ? 'timeout' : r.status;
  const ok = code === 0;
  results.push({ ...t, code, ok, ms, out });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${String(i + 1).padStart(2)}/${picked.length} ${t.name} (${ms}ms)\n`);
  if (!ok && flag('--fail-fast')) break;
}

const failed = results.filter((r) => !r.ok);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n${'-'.repeat(56)}`);
console.log(`跑 ${results.length} 个，通过 ${results.length - failed.length}，失败 ${failed.length}，共 ${secs}s`);
if (failed.length) {
  for (const f of failed) {
    console.log(`\n### ${f.name} (exit ${f.code})`);
    const tail = f.out.trimEnd().split('\n').slice(-20).join('\n');
    console.log(tail || '(无输出)');
  }
  console.log(`\n完整日志在 ${path.relative(ROOT, OUT_DIR)}/`);
}
process.exit(failed.length ? 1 : 0);