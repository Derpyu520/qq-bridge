// 日志与文本安全处理：stdout + state/bridge.log 双写，统一敏感信息脱敏。
import fs from 'node:fs';
import { SENSITIVE_RE } from './sensitive.js';
import { STATE_DIR, BRIDGE_LOG, ACTIVITY_LOG } from './paths.js';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
export const KNOWN_AGENT_TOKENS = new Set<string>();

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***。
export function redactSensitiveText(text: unknown): string {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
export function escapeCqText(text: unknown): string {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
export function unquoteJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 主日志：stdout + bridge.log，自动脱敏。
export function log(...args: unknown[]): void {
  const line = `${new Date().toISOString().slice(11, 19)} [bridge] ${args.map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`.replace(/[\r\n]+/g, ' ');
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(BRIDGE_LOG, line + '\n');
    const raw = fs.readFileSync(BRIDGE_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 2000) fs.writeFileSync(BRIDGE_LOG, lines.slice(-2000).join('\n'));
  } catch {}
}

// QQ 活动日志：每次收发追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
export function appendActivity(line: unknown): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(11, 19);
    fs.appendFileSync(ACTIVITY_LOG, `[${ts}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 500) fs.writeFileSync(ACTIVITY_LOG, lines.slice(-500).join('\n'));
  } catch {}
}
