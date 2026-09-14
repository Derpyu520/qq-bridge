// 桥接进程的文件路径常量与工具路径解析。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const STATE_DIR = path.join(ROOT, 'state');
export const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
export const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
export const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
export const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
export const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
export const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
export const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
export const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
export const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
export const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
export const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');
