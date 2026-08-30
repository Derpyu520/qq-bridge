// SnowLuma 进程管理 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行），
// 给 agent 提供 SnowLuma 网关的状态查询与启停工具。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（HTTP get_login_info）
//   start_snowluma    —— 未运行时启动 launcher.bat 并等待网关就绪（最长 90s）
//   stop_snowluma     —— 停止 SnowLuma（按安装目录匹配进程）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

type RawConfig = Record<string, any>;

function loadConfig(): RawConfig {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text) as RawConfig;
  } catch {
    return {};
  }
}

interface HostConfig {
  httpUrl: string;
  httpPort: string;
  token: string;
  launcher: string;
  homeDir: string;
  allowProcessControl: boolean;
}

function getHostConfig(): HostConfig {
  const c = loadConfig();
  const httpUrl = String(c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const launcher = String(c.snowluma?.launcherPath ?? '');
  return {
    httpUrl,
    httpPort: new URL(httpUrl).port || '80',
    token: String(c.snowluma?.accessToken ?? ''),
    launcher,
    homeDir: String(c.snowluma?.homeDir ?? (launcher ? path.dirname(launcher) : '')),
    // 进程控制默认关闭：只有 config.json 显式设置 snowluma.allowProcessControl=true 才允许启停
    allowProcessControl: c.snowluma?.allowProcessControl === true,
  };
}

function getConsolePort(): number {
  try {
    const c = loadConfig();
    return Number(c.consolePort) || 3100;
  } catch {
    return 3100;
  }
}

function readConsoleToken(): string {
  try {
    const c = loadConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

// 进程控制只允许在 closed-agent（仅管理员私聊）模式下使用，防止 chat/reserved 的 agent 被群友诱导启停 SnowLuma。
async function bridgeModeAllowsProcessControl(): Promise<boolean> {
  try {
    const token = readConsoleToken();
    const res = await fetch(`http://127.0.0.1:${getConsolePort()}/api/status`, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { mode?: string };
    return body?.mode === 'closed-agent';
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface GatewayInfo {
  reachable: boolean;
  online?: boolean;
  user_id?: unknown;
  nickname?: unknown;
  retcode?: unknown;
  wording?: unknown;
  httpStatus?: number;
  hint?: string;
  error?: string;
}

async function gatewayInfo(): Promise<GatewayInfo> {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = (await res.json()) as { status?: string; retcode?: number; data?: { user_id?: unknown; nickname?: unknown }; wording?: string };
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function findSnowLumaPids(): number[] {
  // 先按 OneBot HTTP 端口找监听进程，再用安装目录过滤命令行，
  // 避免误杀恰好占用同一端口的其他进程。
  const { httpPort, homeDir } = getHostConfig();
  const portNum = Number(httpPort);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) return [];
  const pids = new Set<number>();
  try {
    const byPort = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${portNum} } | Select-Object -ExpandProperty OwningProcess -Unique`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', byPort], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
    for (const s of String(out).split(/\s+/)) {
      const n = Number(s.trim());
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  } catch {}
  const home = String(homeDir || '').toLowerCase().replace(/\\/g, '/');
  const result: number[] = [];
  for (const pid of pids) {
    try {
      const cmd = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], {
        timeout: 10000,
        windowsHide: true,
        encoding: 'utf8',
      }).trim();
      const cmdLower = String(cmd || '').toLowerCase().replace(/\\/g, '/');
      if (home && cmdLower.includes(home)) result.push(pid);
    } catch {
      // 拿不到命令行时宁可不杀，避免误伤
    }
  }
  return result;
}

const server = new McpServer({ name: 'snowluma-host', version: '0.1.0' });

server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（HTTP 探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只有显式开启进程控制且当前为 closed-agent 时，才暴露本机路径/PID 这类敏感信息。
    const admin = hc.allowProcessControl && (await bridgeModeAllowsProcessControl());
    const extra = admin ? { launcher: hc.launcher, homeDir: hc.homeDir, processPids: findSnowLumaPids() } : {};
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...info, ...extra }, null, 2) }],
    };
  },
);

if (getHostConfig().allowProcessControl) {
  server.tool(
    'start_snowluma',
    '启动 SnowLuma（launcher.bat，独立窗口）并等待 OneBot 网关就绪，最长 90 秒。已在运行时直接返回当前状态。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.launcher) {
        return { content: [{ type: 'text', text: '拒绝：未配置 snowluma.launcherPath。' }], isError: true };
      }
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制仅允许在 closed-agent（管理员私聊）模式下使用。' }], isError: true };
      }
      const before = await gatewayInfo();
      if (before.reachable && before.online) {
        return { content: [{ type: 'text', text: JSON.stringify({ started: false, alreadyOnline: true, info: before }) }] };
      }
      let spawnError: Error | undefined;
      const child = spawn('cmd.exe', ['/c', 'start', '', `"${hc.launcher}"`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => {
        spawnError = err;
      });
      child.unref();
      let info: GatewayInfo | null = null;
      for (let i = 0; i < 45; i += 1) {
        if (spawnError) {
          return { content: [{ type: 'text', text: `启动失败：${spawnError.message ?? String(spawnError)}` }], isError: true };
        }
        await sleep(2000);
        info = await gatewayInfo();
        if (info.reachable && info.online) {
          return { content: [{ type: 'text', text: JSON.stringify({ started: true, readyAfterMs: (i + 1) * 2000, info }) }] };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ started: false, timeout: true, lastInfo: info ?? before }) }] };
    },
  );

  server.tool(
    'stop_snowluma',
    '停止 SnowLuma 进程（按安装目录匹配 node 进程后 taskkill）。谨慎使用：会断开当前 QQ 连接。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制仅允许在 closed-agent（管理员私聊）模式下使用。' }], isError: true };
      }
      const pids = findSnowLumaPids();
      if (pids.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ stopped: false, reason: 'no process found' }) }] };
      }
      const killed: number[] = [];
      for (const pid of pids) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
          killed.push(pid);
        } catch {
          // 进程可能已退出
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ stopped: true, killed }) }] };
    },
  );
}

await server.connect(new StdioServerTransport());
