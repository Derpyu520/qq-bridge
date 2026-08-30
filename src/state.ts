// 运行时状态与文件工具：JSON 原子读写、会话映射、单实例锁、角色状态、活动日志。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, STATE_DIR, STATE_FILE, ROLE_STATE_FILE, ACTIVITY_LOG, LOCK_FILE } from './paths.js';
import type { BridgeState } from './types.js';

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
export function readJsonSafe(file: string, fallback: any, required = false): any {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error instanceof Error ? error.message : String(error)}）`);
    return fallback;
  }
}

// 原子写 JSON 文件：先写唯一临时文件再 rename。
export function atomicWriteJson(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 原子写文本文件。
export function atomicWriteText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 控制台鉴权 token：未配置时自动生成并持久化。
export function loadOrCreateConsoleToken(): string {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

export function readActivityTail(n: number): string {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

export function listRoles(): string[] {
  try {
    return fs
      .readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

export function readRoleState(): { role: string | null; mode: string } {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}

export function writeRoleState(role: string | null, mode: string): void {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}

export function sanitizeRoleName(name: unknown): string {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// ── QQ 会话 ↔ DSH 会话映射 ─────────────────────────────────────────────────
export const state: BridgeState = { sessions: {} };

export function loadState(): void {
  const loaded = readJsonSafe(STATE_FILE, null) as BridgeState | null;
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') {
    state.sessions = loaded.sessions;
  } else {
    state.sessions = {};
  }
}

export function saveState(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
export function acquireLock(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tryCreate = (): boolean => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') stale = true;
          else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError instanceof Error ? readError.message : String(readError)}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}

export function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}
