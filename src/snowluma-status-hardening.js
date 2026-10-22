// 关闭 SnowLuma 自带“状态指令”的共享实现。
//
// 背景：SnowLuma 命中状态指令（默认 `#sl`）时，会**自己**往会话里回一条系统信息
// （版本 / 平台-架构 / 运行时长）。这条回复发生在 OneBot 适配器把事件交给桥接之前，
// 桥接的出站审计（auditAndSend / SENSITIVE_RE）完全看不到；桥接只能：
//   ① 进线侧丢弃该消息（src/command-shield.js）；
//   ② 把 SnowLuma 侧的 statusCommand 关掉（本模块）。
//
// 本模块被两个入口共用：
//   - scripts/harden-snowluma-status.mjs（命令行，可 --dry-run）
//   - 控制台「访问与安全 → 系统指令屏蔽」的「关闭 SnowLuma 状态指令」按钮
//     （POST /api/security { disableSnowLumaStatus: true }）
// 修改前一律把原文件备份到调用方指定的目录（控制台传 state/command-shield-backups/）。
import fs from 'node:fs';
import path from 'node:path';
import { readOneBotStatusCommands } from './snowluma-conn.js';

export const SNOWLUMA_STATUS_DEFAULT_TRIGGER = '#sl';
export const SNOWLUMA_STATUS_DEFAULT_COOLDOWN_SECONDS = 5;

function readJsonPreservingBom(file) {
  let text = fs.readFileSync(file, 'utf8');
  const hasBom = text.charCodeAt(0) === 0xFEFF;
  if (hasBom) text = text.slice(1);
  return { hasBom, text, json: JSON.parse(text) };
}

function writeJsonAtomic(file, json, hasBom) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, (hasBom ? '\uFEFF' : '') + JSON.stringify(json, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    // 不在 SnowLuma 的 config 目录里留半成品。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/**
 * 把每个账号 OneBot 配置里的 `statusCommand` 置为关闭。
 *
 * @param {string} homeDir SnowLuma 安装目录（其下有 config/onebot_<QQ>.json）
 * @param {object} [options]
 * @param {string} [options.backupDir] 备份目录；实际写盘时必填
 * @param {boolean} [options.dryRun] 只返回将要做的改动，不写任何文件
 * @returns {{
 *   ok:boolean, homeDir:string, dryRun:boolean,
 *   accounts:Array<{uin:string,file:string,trigger:string,changed:boolean,skipped:boolean,backup:string|null,error:string|null}>,
 *   changed:number, failed:number, skipped:number
 * }}
 */
export function disableSnowLumaStatusCommands(homeDir, { backupDir = '', dryRun = false } = {}) {
  const result = {
    ok: true,
    homeDir: String(homeDir ?? ''),
    dryRun: dryRun === true,
    accounts: [],
    changed: 0,
    failed: 0,
    skipped: 0
  };
  const entries = readOneBotStatusCommands(homeDir);
  for (const entry of entries) {
    const account = {
      uin: entry.uin,
      file: entry.file,
      trigger: String(entry.statusCommand?.trigger || SNOWLUMA_STATUS_DEFAULT_TRIGGER),
      changed: false,
      skipped: false,
      backup: null,
      error: null
    };
    result.accounts.push(account);

    if (entry.error) {
      // 读不动/坏 JSON：不能当成“已经关闭”，否则脚本会报成功而实际上它可能还开着。
      account.error = `读取/解析配置失败：${entry.error}`;
      result.failed += 1;
      continue;
    }
    if (entry.statusCommand && entry.statusCommand.enabled === false) {
      account.skipped = true;
      result.skipped += 1;
      continue;
    }

    if (dryRun === true) {
      account.changed = true;
      result.changed += 1;
      continue;
    }
    if (!backupDir) {
      account.error = '未指定备份目录（实际写盘必须备份）';
      result.failed += 1;
      continue;
    }

    try {
      const { hasBom, text, json } = readJsonPreservingBom(entry.file);
      const prev = json.statusCommand && typeof json.statusCommand === 'object' && !Array.isArray(json.statusCommand)
        ? json.statusCommand
        : {};
      const next = {
        enabled: false,
        // 即使将来有人把 enabled 改回 true，也别再把原消息继续投递给 agent。
        swallow: true,
        cooldownSeconds: Number.isInteger(prev.cooldownSeconds) && prev.cooldownSeconds >= 0
          ? prev.cooldownSeconds
          : SNOWLUMA_STATUS_DEFAULT_COOLDOWN_SECONDS,
        trigger: typeof prev.trigger === 'string' && prev.trigger.trim()
          ? prev.trigger
          : SNOWLUMA_STATUS_DEFAULT_TRIGGER
      };

      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = path.join(backupDir, `onebot_${entry.uin}.status-${stamp}.json`);
      fs.writeFileSync(backup, (hasBom ? '\uFEFF' : '') + text, 'utf8');

      json.statusCommand = next;
      writeJsonAtomic(entry.file, json, hasBom);

      account.changed = true;
      account.backup = backup;
      account.trigger = next.trigger;
      result.changed += 1;
    } catch (error) {
      account.error = String(error?.message ?? error);
      result.failed += 1;
    }
  }
  result.ok = result.failed === 0;
  return result;
}

export default { disableSnowLumaStatusCommands, SNOWLUMA_STATUS_DEFAULT_TRIGGER, SNOWLUMA_STATUS_DEFAULT_COOLDOWN_SECONDS };
