// 关闭 SnowLuma 自带的“状态指令”（默认触发词 `#sl`，可在 SnowLuma 里改）。
//
// 为什么必须单独做这一步：
//   SnowLuma 命中该指令时会**自己**往群里回一条系统信息（版本 / 平台-架构 / 运行时长），
//   这条回复发生在 OneBot 适配器交给桥接之前，桥接的出站审计根本看不到；
//   桥接的 commandShield（src/command-shield.js）只能丢弃进线消息、阻止 AI 复述，
//   却拦不住 SnowLuma 已经发出去的那一条。
//
// 本脚本只改 SnowLuma 的 OneBot 配置（config/onebot_<QQ号>.json），把
// `statusCommand.enabled` 置为 false、`swallow` 置为 true，并保留原触发词/冷却时间。
// 修改前会把原文件备份到 qq-bridge/state/command-shield-backups/，可随时还原。
//
// 用法：
//   node scripts/harden-snowluma-status.mjs            # 自动从 config.json 的 snowluma.homeDir 找
//   node scripts/harden-snowluma-status.mjs <SnowLuma目录>
//   node scripts/harden-snowluma-status.mjs --dry-run  # 只看会改什么，不写盘
//
// ⚠️ 两点运行约束：
//   1. 需要**重启 SnowLuma** 才生效（配置在实例创建时读取）。
//   2. 本脚本会写 qq-bridge/state/，而 state/ 的 ACL 被收紧了 —— DSH 沙箱里的会话
//      写不进去，请在普通终端运行（与 scripts/harden-state-acl.mjs 相同）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOneBotStatusCommands } from '../src/snowluma-conn.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CFG_PATH = path.join(ROOT, 'config.json');
const BACKUP_DIR = path.join(ROOT, 'state', 'command-shield-backups');

function readConfigFile() {
  try {
    let text = fs.readFileSync(CFG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const explicitHome = args.find((a) => !a.startsWith('-')) ?? '';
const home = String(
  explicitHome
  || process.env.SNOWLUMA_HOME
  || readConfigFile()?.snowluma?.homeDir
  || ''
).trim();

if (!home) {
  console.error('找不到 SnowLuma 目录：请在 qq-bridge/config.json 配好 snowluma.homeDir，或直接传路径：');
  console.error('  node scripts/harden-snowluma-status.mjs "F:\\path\\to\\SnowLuma"');
  process.exit(1);
}

const entries = readOneBotStatusCommands(home);
if (entries.length === 0) {
  console.error(`未在 ${path.join(home, 'config')} 找到可读的 onebot_<QQ号>.json。`);
  console.error('请确认路径指向 SnowLuma 安装目录（其下应有 config/ 与 onebot_*.json），且 SnowLuma 已登录过目标账号。');
  process.exit(1);
}

let changed = 0;
let failed = 0;
for (const entry of entries) {
  const name = path.basename(entry.file);
  const prev = entry.statusCommand ?? null;
  if (prev && prev.enabled === false) {
    console.log(`✓ ${name}：状态指令已关闭，无需改动`);
    continue;
  }

  let raw;
  try {
    raw = fs.readFileSync(entry.file, 'utf8');
  } catch (error) {
    console.error(`✗ ${name}：读取失败（${error?.message ?? error}）`);
    failed += 1;
    continue;
  }
  const hasBom = raw.charCodeAt(0) === 0xFEFF;
  const body = hasBom ? raw.slice(1) : raw;
  let obj;
  try {
    obj = JSON.parse(body);
  } catch (error) {
    console.error(`✗ ${name}：不是合法 JSON（${error?.message ?? error}），已跳过（未改动）`);
    failed += 1;
    continue;
  }

  const old = obj.statusCommand && typeof obj.statusCommand === 'object' && !Array.isArray(obj.statusCommand)
    ? obj.statusCommand
    : {};
  const next = {
    enabled: false,
    // 即使将来有人把 enabled 改回 true，也不要再把原消息继续投递给 agent。
    swallow: true,
    cooldownSeconds: Number.isInteger(old.cooldownSeconds) && old.cooldownSeconds >= 0 ? old.cooldownSeconds : 5,
    trigger: typeof old.trigger === 'string' && old.trigger.trim() ? old.trigger : '#sl'
  };
  const trigger = next.trigger;

  if (dryRun) {
    console.log(`· ${name}：将关闭状态指令（trigger=${trigger}，原 enabled=${prev ? prev.enabled : '未配置（默认开启）'}）`);
    changed += 1;
    continue;
  }

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(BACKUP_DIR, `onebot_${entry.uin}.status-${stamp}.json`);
    fs.writeFileSync(backup, (hasBom ? '\uFEFF' : '') + body, 'utf8');

    obj.statusCommand = next;
    const tmp = `${entry.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, (hasBom ? '\uFEFF' : '') + JSON.stringify(obj, null, 2) + '\n', 'utf8');
    try {
      fs.renameSync(tmp, entry.file);
    } catch (error) {
      // 不留半成品在 SnowLuma 的 config 目录里（那个目录不属于本仓库）。
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
    changed += 1;
    console.log(`✓ ${name}：已关闭状态指令（trigger=${trigger}），备份在 ${backup}`);
  } catch (error) {
    console.error(`✗ ${name}：写入失败（${error?.message ?? error}）`);
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      console.error('  这通常是因为在 DSH 沙箱里运行（state/ 与 SnowLuma 安装目录都受 ACL 约束）。请换普通终端重跑本脚本。');
    }
    failed += 1;
  }
}

if (dryRun) {
  console.log(`\n[dry-run] 共 ${entries.length} 个账号配置，其中 ${changed} 个需要关闭；未写任何文件。`);
} else if (changed === 0 && failed === 0) {
  console.log('\n全部账号的状态指令都已关闭，无需改动。');
} else {
  console.log(`\n完成：${changed} 个已关闭，${failed} 个失败。`);
  console.log('⚠️ 需要重启 SnowLuma 才生效；若之后在 SnowLuma 设置页重新保存了 OneBot 配置，可能把它改回开启——再跑一次本脚本即可。');
}
process.exitCode = failed ? 1 : 0;
