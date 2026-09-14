// 角色卡提示词加载与二代模式适配（只读文件，带 mtime 缓存）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ROLE_STATE_FILE } from './paths.js';
import { readRoleState } from './state.js';
import { convertExampleSpacesToComma } from './format.js';

let roleHintCache = { key: '', hint: '' };

export function currentRoleHint(): string {
  try {
    const rs = readRoleState();
    if (!rs.role) return '';
    const roleFile = path.join(ROOT, 'roles', rs.role + '.md');
    if (!fs.existsSync(roleFile)) return '';
    const stateStat = fs.statSync(ROLE_STATE_FILE);
    const roleStat = fs.statSync(roleFile);
    const cacheKey = `${stateStat.mtimeMs}:${roleStat.mtimeMs}`;
    if (roleHintCache.key === cacheKey) return roleHintCache.hint;
    let hint = fs.readFileSync(roleFile, 'utf8');
    if (hint.length > 6000) hint = hint.slice(0, 6000);
    roleHintCache = { key: cacheKey, hint };
    return hint;
  } catch {
    return '';
  }
}

export function currentRoleHintV2(): string {
  const raw = currentRoleHint();
  if (!raw) return '';
  const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
  const lines = raw.split('\n');
  const kept: string[] = [];
  let inExampleSection = false;
  for (const line of lines) {
    if (/^##\s*.*回复示例/.test(line)) {
      inExampleSection = true;
      kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
      continue;
    }
    if (inExampleSection && /^##\s/.test(line)) {
      inExampleSection = false;
    }
    if (inExampleSection) {
      kept.push(convertExampleSpacesToComma(line));
    } else if (!GEN1_ROLE_LINE_RE.test(line)) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}
