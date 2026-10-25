// 会话绑定的执行期强制：让 QQ MCP 工具只服务**当前会话**。
//
// ── 这个插件做什么 ──────────────────────────────────────────────────────────
//
// 它按 DSH 宿主给的 agent scope 取出可信的会话身份（sessionId 里编码的 QQ key），
// 再用这个身份去挂载 snowluma MCP server（把 key 通过 env 传给子进程），
// 而不是让桥接在**全局**注册一个「谁调都能用」的 MCP server。
//
// 与 qq-tool-restrict.mjs 的关系：
//   · qq-tool-restrict 在**执行期**做白名单 + key 比对（对 tools.guard 可见的 exec）；
//   · 本插件在**装配期**保证 MCP 进程拿到的 key 就是当前会话的 key。
// 两层互补：即便某一层因 DSH 版本变化失效，另一层仍然拦得住。
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { decodeSelfKey } from './qq-self-key.mjs';

export const name = 'qq-self-key-scope';
export const inject = ['tools'];

export async function apply(ctx) {
  // 通过运行中的 DSH 入口解析依赖，确保 scopeOf 用的是宿主自己的 Symbol。
  const requireHost = createRequire(pathToFileURL(process.argv[1]));
  const { scopeOf } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-scope')).href);
  const agent = scopeOf(ctx);
  const key = decodeSelfKey(agent?.id ?? agent?.session?.id);
  if (!key) {
    // 不是桥接绑定的会话：拒绝挂载，绝不退化成「谁都能用」的 MCP。
    throw new Error('QQ MCP 需要桥接绑定的 agent scope（sessionId 形如 qqb-g-<群号>）');
  }
  const mcp = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-mcp-client')).href);
  await mcp.apply(ctx, {
    transport: 'stdio',
    serverName: 'snowluma',
    command: process.execPath,
    args: [fileURLToPath(new URL('../../src/mcp-snowluma-safe.js', import.meta.url))],
    env: { QQ_BRIDGE_SELF_KEY: key },
    cwd: '',
    toolCallTimeoutMs: 725000,
    failOnStartupError: true,
    maxInstructionBytes: 65536,
    reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 10 }
  });
}
