// DSH 适配总验证（0.2.1 版）。
//
// 沿革：0.1.5 建立（verify-dsh-015-adaptation.mjs）→ 0.2.0 改名
// （verify-dsh-020-adaptation.mjs）→ 0.2.1 改名到本文件名。文件名里的版本号
// 是**它验的 DSH 版本**，不是仓库版本；一个自称 015 却在验 0.2.0 的脚本只会误导人。
// `npm run verify:adaptation` 的入口名保持不变，所以既有调用不受影响。
//
// 0.2.1 实测结论（2026-10-22）：§5 的活 DSH 契约**逐项未漂移**——铸造 Cookie 鉴权、
// settings/describe + settings/update、agentPresets/list、session/create+selectModel、
// session/projections、control baseline 的 projections 形状、stopSessionWork、
// $events ready 帧、session/modelCatalog、斜杠式 endpoint 全部照旧。
// 唯一漂移在**工具面**：0.2.1 新增 `working_directory`（dsh-base 默认挂载，全局层继承）
// 以及 terminal / session-query / plugin_market 一族，守卫名单已同轮补齐。
//
// 覆盖：
//   §1 仓库侧 preset persona schema
//   §2 部署侧 bundle patch / 守卫实现（preset 与 provider 行）
//   §3 版本身份一致性
//   §4 语法检查
//   §5 **运行中的 DSH 0.2.0 实测**（本文件的核心）：
//        · 鉴权：本机签名密钥离线铸造 Cookie
//        · settings/describe 可用，`qq-mode` 命名空间在列且可写
//          （0.2.0 删除了 ctx.settings.register()，命名空间改由 entry id + Config 推导）
//        · agentPresets/list 含 qq-chat / qq-chat-v2
//        · session/create 挂 preset + selectModel(deepseek-flash)
//        · session/projections 一元 RPC 可用（读队列的主路径）
//        · session/control 开场 baseline 是 value.projections[<id>].values.inbox
//          （**不再是** 0.1.7 的 value.queues[<id>] —— 认错形状会让每次退役会话都抛错）
//        · stopSessionWork 在真实会话上成功返回（这条是本次适配的核心回归）
//        · $events ready 帧
//        · session/modelCatalog 形状
//        · 点号 endpoint 仍不可用（协议确为斜杠式）
//
// 不依赖 SnowLuma；不改动任何用户状态（探测会话会被 archive，探测工作区建在系统临时目录）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dshModulesDir } from './dsh-modules.mjs';
import { discoverDshSessionCookie, NodeApiClient, unwrap } from '../src/dsh-client.js';

const ROOT = process.cwd();
const DSH_MODULES = dshModulesDir();
const DSH_HOME = path.join(os.homedir(), '.dsh');
const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

let pass = 0, fail = 0;
const results = [];
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}
/** 环境不允许断言时显式记为跳过，而不是假装通过。 */
function skip(label, why) {
  results.push(`⏭ ${label} — ${why}`);
  return false;
}

// ── 1. 仓库侧：preset persona schema ────────────────────────────────────────
const persona = await import(pathToFileURL(path.join(DSH_MODULES, '@deepseek-ai/dsh-persona/lib/index.js')).href);
const YAML = await import(pathToFileURL(path.join(DSH_MODULES, 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;

let oldRejected = false;
try { persona.Config({ text: 'x' }); } catch { oldRejected = true; }
check('dsh-persona 仍拒绝旧字段 text（故障前提成立）', oldRejected);

/** DSH 0.2.1 的 agent loop 只注册这两个提示词变量（0.2.0 还有 `cwd`）。 */
const DSH_PROMPT_VARIABLES = new Set(['provider', 'model']);

for (const p of ['qq-chat', 'qq-chat-v2']) {
  const f = path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml');
  const row = yaml.load(fs.readFileSync(f, 'utf8')).find((r) => r.id === 'persona');
  let schemaOk = false;
  try { persona.Config(row.config); schemaOk = true; } catch {}
  check(`preset ${p}: persona.config 通过 DSH schema`, schemaOk);
  // 未知变量不是"渲染成空"而是 fail loud：回合直接 error、模型一次都不跑。
  // 所以这里必须钉住「只用 DSH 真注册过的变量」，而不只是「有 {{model}}」。
  const usedVars = [...new Set([...JSON.stringify(row.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]))];
  const unknownVars = usedVars.filter((v) => !DSH_PROMPT_VARIABLES.has(v));
  check(`preset ${p}: 只引用 DSH 已注册的提示词变量`,
    unknownVars.length === 0 && /\{\{model\}\}/.test(row.config.prefix),
    unknownVars.length ? `未知变量: ${unknownVars.join(', ')}` : usedVars.join(', '));
}

// ── 2. 部署侧：DSH 0.1.7 的 preset 机制 ──────────────────────────────────────
// 0.1.5 时这一节比的是 ~/.dsh/.agent-presets/<p>/ 下的安装副本；0.1.7 起该目录
// **完全不再被读取**（注册表既不扫目录也不接受 preset 路径），preset 变成 bundle
// patch 插入的一条 @deepseek-ai/dsh-agent-preset 行。因此这里改成核对：
//   ① bundle patch 与仓库权威源一致（生成器 --check，防手改/忘重新生成）；
//   ② bundle 已注册进 profile（link: 依赖 + bundles + node_modules junction，
//      守卫行的裸说明符就靠这个 junction 解析）；
//   ③ 守卫实现只有一份且 fail-closed。
const norm = (s) => s.replace(/\r\n/g, '\n');
const presetPatches = await import(pathToFileURL(path.join(ROOT, 'scripts/build-agent-preset-patches.mjs')).href);
for (const { file, changed } of presetPatches.buildPatches({ check: true, log: () => {} })) {
  check(`${path.relative(ROOT, file)} 与仓库源一致（未漂移）`, !changed);
}
for (const p of ['qq-chat', 'qq-chat-v2']) {
  const doc = yaml.load(fs.readFileSync(presetPatches.patchFileFor(p), 'utf8'));
  const row = doc?.[0]?.insert?.[0];
  check(`patch ${p}: 是 @deepseek-ai/dsh-agent-preset 行`, row?.name === '@deepseek-ai/dsh-agent-preset');
  check(`patch ${p}: config.id = ${p}`, row?.config?.id === p);
  const source = yaml.load(fs.readFileSync(path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml'), 'utf8'));
  const srcPersona = source.find((r) => r.id === 'persona');
  const patchPersona = (row?.config?.plugins ?? []).find((r) => r.id === 'persona');
  check(`patch ${p}: persona.prefix 与源逐字一致`, norm(srcPersona?.config?.prefix ?? '') === norm(patchPersona?.config?.prefix ?? ''));
  const guardRow = (row?.config?.plugins ?? []).find((r) => r.id === 'qq-tool-restrict');
  check(`patch ${p}: 守卫行用 Profile 目录可解析的裸说明符`, guardRow?.name === presetPatches.GUARD_SPECIFIER);
}

// 守卫脚本必须是 fail-closed 的：非法工具名要被拒绝，而不是放行（权威实现只有一份）。
const canonicalGuardPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const guard = fs.readFileSync(canonicalGuardPath, 'utf8');
// 断言只看**可执行代码**：守卫的注释里会写「cordis_define/… 在 0.1.7 已被删除」做历史说明，
// 直接扫原文会把这段说明误判成「还在使用旧工具名」（实测误报）。必须**先剥块注释**
// （/∗ … ∗/ 与 JSDoc 的 ` * ` 行）**再剥行注释**，否则块注释里的旧名仍会被扫到。
// 剥行注释必须按 /\r?\n/ 切行：JS 的 `.` 不匹配 \r，CRLF 下 split('\n') 会让行尾留 \r，
// /\/\/.*$/ 的 `$` 够不到行尾。
const guardCode = guard
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('守卫：非法工具名 fail-closed（不接受裸 return 放行）', !/typeof name !== 'string'[^\n]*\)\s*return\s*$/m.test(guardCode));
check('守卫：不额外放行 web_search/web_fetch', !/'(?:web_search|web_fetch)'/.test(guardCode));
check('守卫：拒绝 0.1.7 已删除的 cordis 旧工具名（避免静默失效）', !/cordis_(?:define|undefine|run|stop)/.test(guardCode));

// 0.2.0 工具面重新对账的结果（扫描器与守卫必须一致）。
// 三类必须覆盖，来源见 plugins/qq-agent-presets/qq-tool-restrict.mjs 的长注释：
//   ① 全局层默认启用、仿真会话真的会继承的 MCP 资源工具
//   ② 派生 agent / 执行外部代码
//   ③ 插件装载权（= 任意代码执行）与无人值守的自我调度
const GUARD_020_NAMES = [
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
];
/** 0.2.1 对账新增的名字（见守卫长注释里 2026-10-22 那段）。 */
const GUARD_021_NAMES = [
  // dsh-base 0.2.1 默认挂载 ⇒ 全局层继承
  'working_directory',
  // dsh-tool-terminal：终端 = shell
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  // dsh-tool-session-query：跨会话读事件正文
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  // 装载权 / 写盘起进程 / team 家族
  'plugin_market', 'create_worktree', 'wait_agent',
];
const guardMod = await import(pathToFileURL(canonicalGuardPath).href);
const guardNames = new Set(guardMod.RESTRICTED_TOOL_NAMES ?? []);
const optionalNames = new Set(guardMod.OPTIONAL_BUNDLE_TOOL_NAMES ?? []);
const missingFromGuard = GUARD_020_NAMES.filter((n) => !guardNames.has(n));
check('守卫已覆盖 0.2.0 新增的危险工具名', missingFromGuard.length === 0, missingFromGuard.join(', ') || `${guardNames.size} 个名字`);
const missingFromGuard021 = GUARD_021_NAMES.filter((n) => !guardNames.has(n));
check('守卫已覆盖 0.2.1 新增的危险工具名', missingFromGuard021.length === 0, missingFromGuard021.join(', ') || `${GUARD_021_NAMES.length} 个名字`);

// 守卫名单里的每个名字都必须是 DSH 真实注册的工具：`tools.restrict()` 对未知名字会抛错，
// 而守卫逐个 try/catch 只打日志 ⇒ 拼错的名字 = 静默 no-op。
// 扫描器（scripts/scan-dsh-tool-names.mjs）与 test-preset-local-tools.mjs 共用
// scripts/dsh-tool-names.mjs 这一份抽取实现，所以这里直接复用，不会出现两套口径。
const { collectDshToolNames } = await import(pathToFileURL(path.join(ROOT, 'scripts/dsh-tool-names.mjs')).href);
const scanned = collectDshToolNames();
if (scanned.names.size === 0) {
  skip('守卫名单与 DSH 真实工具名对账', '未扫到任何 DSH 包（DSH 未安装？）');
} else {
  const fabricated = [...guardNames]
    .filter((n) => !n.startsWith('dev_') && !optionalNames.has(n) && !scanned.names.has(n));
  check('守卫名单无拼错的假名（restrict 不会静默失效）', fabricated.length === 0, fabricated.join(', ') || `扫过 ${scanned.packages.length} 个包`);
}

const patch = fs.readFileSync(path.join(DSH_HOME, 'profiles/web/cordis.patch.yml'), 'utf8');
const patchDoc = yaml.load(patch);
const mcpIds = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert.map((x) => x.id));
check('profile patch 含 3 个 MCP 且无重复', mcpIds.length === 3 && new Set(mcpIds).size === 3, mcpIds.join(', '));
const snowlumaEntry = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert).find((x) => x.id === 'mcp-snowluma');
check('mcp-snowluma 带 toolCallTimeoutMs=725000', snowlumaEntry?.config?.toolCallTimeoutMs === 725000);
check('mcp 路径指向本仓库', mcpIds.every((id) => {
  const e = patchDoc.filter((x) => x?.insert).flatMap((x) => x.insert).find((y) => y.id === id);
  return String(e.config.args[0]).includes('qq-bridge');
}));

const pkg = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'profiles/web/package.json'), 'utf8'));
check('profile bundles 含 qq-mode-console', pkg.dsh.profile.bundles.includes('qq-mode-console'));
check('qq-mode-console link 依赖已注册', String(pkg.dependencies['qq-mode-console'] ?? '').startsWith('link:'));
check('qq-mode-console 已 link 进 node_modules', fs.existsSync(path.join(DSH_HOME, 'profiles/web/node_modules/qq-mode-console')));

// ── 3. 仓库配置：模型 ───────────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
check('config.json dsh.model = deepseek-flash', cfg.dsh?.model === 'deepseek-flash', `当前 ${cfg.dsh?.model}`);
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
// 只看可执行代码，忽略注释（注释里会提到旧名做历史说明）。
// 注意必须按 /\r?\n/ 切行：JS 的 `.` 不匹配 \r，CRLF 文件直接 split('\n') 会让行尾留 \r，
// 导致 /\/\/.*$/ 的 `$` 够不到行尾、注释根本剥不掉（曾因此误报）。
const stripComments = (src) => src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const bridgeCode = stripComments(bridgeSrc);
check('bridge.js 可执行代码无 deepseek-v4-flash-vision-exp 残留', !bridgeCode.includes('deepseek-v4-flash-vision-exp'));
check('bridge.js 可执行代码无 router-standard 残留', !bridgeCode.includes('router-standard'));
// setup-dsh.mjs 曾被漏改：0.1.5 适配只清了 bridge.js，脚本里仍在写死已下线的 preset 名。
const setupCode = stripComments(fs.readFileSync(path.join(ROOT, 'scripts/setup-dsh.mjs'), 'utf8'));
check('setup-dsh.mjs 可执行代码无 router-standard 残留', !setupCode.includes('router-standard'));
check('setup-dsh.mjs 新装默认 closedAgentPreset 留空（交给 DSH 默认 preset）', /closedAgentPreset:\s*''/.test(setupCode));
check('bridge.js 默认模型为 deepseek-flash', /model:\s*'deepseek-flash'/.test(bridgeCode));
check('bridge.js 不再有「无参创建会话」兜底', !/sessions\.create\(\{\}\)/.test(bridgeCode));
check('bridge.js 含 preset 清单/默认 preset 解析', bridgeSrc.includes('resolvePresetName') && bridgeSrc.includes('refreshPresetList'));

// 安全不变量回归防线：群聊/仿真会话在 preset 缺失时必须 fail-closed。
// 旧实现会在 preset 不在 DSH 清单里时静默回退到 DSH 默认 preset（standard，含 bash/
// 文件读写），把本地工具暴露给 QQ 群 —— 与 RULES.md「无本地工具」的承诺直接矛盾。
check('preset 解析带 strict 开关', /resolvePresetName\(name, \{ strict = false \} = \{\}\)/.test(bridgeCode));
check('非 closed-agent 模式以 strict 解析 preset', /resolvePresetName\(wanted, \{ strict: true \}\)/.test(bridgeCode));
check('群聊模式缺少 preset 时拒绝建会话（fail-closed）', /strictPreset && !preset/.test(bridgeCode));
check('群聊模式不再重试「无 preset」建会话', /strictPreset \? \[true\] : \[true, false\]/.test(bridgeCode));

// ── 3b. 版本身份一致性 ──────────────────────────────────────────────────────
// v0.1.5 曾带着自称 0.1.2-alpha.1 的 package-lock.json 发布出去（package.json 却是
// 0.1.5），三个 MCP server 的 serverInfo.version 也停在 0.1.0。版本漂移没有防线就会
// 复发，这里把「所有对外自称的版本号必须等于 package.json」固定下来。
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pluginPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/qq-mode-console/package.json'), 'utf8'));
check('package-lock.json 顶层 version 与 package.json 一致', lockJson.version === pkgJson.version, `lock=${lockJson.version} pkg=${pkgJson.version}`);
check('package-lock.json packages[""] version 与 package.json 一致', lockJson.packages?.['']?.version === pkgJson.version, `lock=${lockJson.packages?.['']?.version}`);
check('qq-mode-console 插件版本与主包一致', pluginPkg.version === pkgJson.version, `plugin=${pluginPkg.version}`);
for (const f of ['src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js']) {
  const m = /new McpServer\(\{[^}]*version:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  check(`${f} 的 MCP serverInfo.version 与主包一致`, m?.[1] === pkgJson.version, `声明=${m?.[1]} 主包=${pkgJson.version}`);
}

// ── 4. 语法检查 ─────────────────────────────────────────────────────────────
// 注意 spawnSync 在受限环境（DSH 沙箱的 workspace-write）会以 EPERM 失败——
// 那是**环境**不允许起子进程，不是文件有语法错。这种情况显式记为跳过，
// 否则会输出一串假失败，把真正的失败淹掉（实测踩过）。
const SYNTAX_FILES = ['src/bridge.js', 'src/dsh-client.js', 'src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js', 'src/slang-learner.js', 'src/self-test.js', 'scripts/setup-dsh.mjs'];
{
  const probe = spawnSync(process.execPath, ['--check', path.join(ROOT, 'src/dsh-client.js')], { encoding: 'utf8' });
  if (probe.error?.code === 'EPERM') {
    skip(`${SYNTAX_FILES.length} 个文件的语法检查`, '本环境不允许 spawn 子进程（EPERM）；请在普通终端重跑');
  } else {
    for (const f of SYNTAX_FILES) {
      const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
      check(`${f} 语法正确`, r.status === 0, (r.stderr || '').split('\n')[0]);
    }
  }
}

// ── 5. 运行中的 DSH 0.2.0 ───────────────────────────────────────────────────
// 鉴权走与桥接生产代码同一条路：用 ~/.dsh 里持久化的签名密钥离线铸造会话 Cookie。
// 旧写法（从 ~/.dsh/guard/logs/server-*.out.log 里抓 `?token=`）在 0.1.7 已经死了：
//   · 进程启动 token 是现生成的 32 字节随机数，只存在内存 WeakMap 里，不落盘；
//   · guard 插件退役后也没有启动器再把 `dsh web` 的 stdout 重定向到那个目录，
//     日志里剩下的是**上一个进程**的陈旧 token，换 Cookie 只会得到 401。
const cookie = discoverDshSessionCookie(BASE);
check('本机签名密钥 → 铸造会话 Cookie 成功', Boolean(cookie), cookie ? `${cookie.length} 字节` : '读不到 browser-session 密钥');
async function rpc(e, a) {
  const r = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'v' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  return (await r.json()).result;
}
const st = await rpc('settings/describe', {});
check('settings/describe 可用', st.ok === true);
const dm = st.value?.namespaces?.find((n) => n.ns === 'agent-default-model');
check('DSH 全局默认模型 = deepseek-flash', dm?.value?.model === 'deepseek-flash', `当前 ${dm?.value?.model}`);
const ap = await rpc('agentPresets/list', {});
const presetIds = ap.value?.presets?.map((p) => p.id) ?? [];
check('agentPresets/list 含 qq-chat 与 qq-chat-v2', presetIds.includes('qq-chat') && presetIds.includes('qq-chat-v2'), presetIds.join(', '));
// 0.1.7 把设置命名空间从 `agent-presets` 改名为 `agent-preset-registry`，而且「用户默认」
// 是易失字段 selectedDefault，不会出现在 describe 的 value 里。部署默认由 registry 行的
// config.default 决定（dsh-web-app 的 patch 写的是 standard）。桥接在 closedAgentPreset
// 留空时依赖的正是它，所以这里断言「注册表已装载」+「standard 预设存在」这两件可观测的事。
const registryNs = st.value?.namespaces?.find((n) => n.ns === 'agent-preset-registry');
check('preset 注册表命名空间已装载', registryNs !== undefined, st.value?.namespaces?.map((n) => n.ns).filter((n) => n.includes('preset')).join(', '));
check('closed-agent 兜底所需的 standard 预设可用', presetIds.includes('standard'), presetIds.join(', '));

// ── 5a. qq-mode 命名空间（0.2.0 删除了 ctx.settings.register()）──────────────
// 0.2.0 里命名空间**不再需要注册**：它由 profile 里 id 恰好等于命名空间名的 loader
// entry + 该插件导出的 Config（含 volatile 字段）推导出来。这条断言把「模式能写穿
// DSH 设置」的可观测结果钉住 —— 它一旦坏掉，控制台改模式只在本地生效，下一次
// DSH 轮询就回滚，而且不会有任何提示。
const qqMode = st.value?.namespaces?.find((n) => n.ns === 'qq-mode');
check('settings/describe 列出 qq-mode 命名空间', qqMode !== undefined, st.value?.namespaces?.map((n) => n.ns).length + ' 个命名空间');
if (qqMode) {
  check('qq-mode 带 mode 字段', typeof qqMode.value?.mode === 'string', JSON.stringify(qqMode.value));
  check('qq-mode 带 revision（写入所需）', Number.isInteger(qqMode.revision), String(qqMode.revision));
  // settings/update 是**多参数** RPC：args 是 { ns, patch, expectedRevision } 平铺，
  // 不是 { request: {...} }（传 request 会被网关拒为
  // `gateway/arguments-invalid: missing "ns", "patch"; unexpected "request"`）。
  const writeBack = await rpc('settings/update', {
    ns: 'qq-mode', patch: { mode: qqMode.value.mode }, expectedRevision: qqMode.revision,
  });
  check(
    'settings/update 可写 qq-mode（参数为平铺多参数，非 request 包装）',
    writeBack.ok === true,
    writeBack.ok ? `mode=${writeBack.value?.value?.mode}` : `${writeBack.error?.code}: ${writeBack.error?.message}`,
  );
}

// ── 5b. session/projections：读会话队列的主路径 ──────────────────────────────
const probeDir = path.join(os.tmpdir(), 'qq-bridge-verify-020');
fs.rmSync(probeDir, { recursive: true, force: true });
fs.mkdirSync(probeDir, { recursive: true });
const api = new NodeApiClient(BASE, undefined, {});
await api.ensureAuth();

let probeSessionId = null;
try {
  const created = unwrap(await api.sessions.create({ cwd: probeDir, agentPreset: 'qq-chat-v2' }), 'session.create');
  probeSessionId = created.sessionId;
  check('session/create 挂 qq-chat-v2 preset 成功', typeof probeSessionId === 'string' && probeSessionId.length > 0, probeSessionId);
  unwrap(await api.sessions.selectModel({
    sessionId: probeSessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max'
  }), 'session.selectModel');
  check('session/selectModel(deepseek-flash) 被接受', true);

  const projections = await api.callUnary('session/projections', { sessionId: probeSessionId });
  check('session/projections 一元 RPC 可用', projections.result?.ok === true,
    projections.result?.ok ? '' : `${projections.result?.error?.code}: ${projections.result?.error?.message}`);
  const values = projections.result?.value?.values;
  check('session/projections 返回 values.inbox（next-turn / next-step）',
    values?.inbox !== undefined && Array.isArray(values.inbox['next-turn']) && Array.isArray(values.inbox['next-step']),
    Object.keys(values ?? {}).slice(0, 6).join(','));

  // ── 5c. control baseline 形状（0.2.0 的核心断裂点）────────────────────────
  const url = new URL('/api/remote.mux', BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const baseline = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie: api.cookie } });
    const streamId = randomUUID();
    const timer = setTimeout(() => { try { socket.close(); } catch {} reject(new Error('control baseline 超时')); }, 15_000);
    const finish = (err, value) => { clearTimeout(timer); try { socket.close(); } catch {} err ? reject(err) : resolve(value); };
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/control', payload: { args: {} } })));
    socket.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.streamId !== streamId) return;
      if (m.type === 'item' && m.value?.type === 'baseline') finish(null, m.value);
      else if (m.type === 'error' || m.type === 'end') finish(new Error(`control ${m.type}${m.error?.code ? ` (${m.error.code})` : ''}`));
    });
    socket.addEventListener('error', () => finish(new Error('control socket error')));
  }).catch((error) => { skip('session/control 开场 baseline 形状', error.message); return null; });
  if (baseline) {
    const bv = baseline.value;
    check('control baseline 是 value.projections（0.2.0 形状）',
      bv !== null && typeof bv?.projections === 'object' && bv.projections !== null);
    check('control baseline 不再有 value.queues（0.1.7 形状已废弃）',
      bv !== null && !Object.hasOwn(bv ?? {}, 'queues'));
    const sample = bv?.projections?.[probeSessionId]?.values;
    check('baseline 里探测会话的投影带 inbox', sample?.inbox !== undefined,
      Object.keys(sample ?? {}).slice(0, 6).join(','));
  }

  // ── 5d. 核心回归：退役会话不再抛 baseline 结构错 ─────────────────────────
  // 0.2.0 之前这段代码读 `value.queues[<id>]`，形状一变就**每次**退役都抛
  // "invalid session/control baseline"，队列清不掉、旧任务继续在 DSH 里跑，
  // 而桥接日志里只有一行警告。这条断言就是那次断裂的回归网。
  let retireError = null;
  let retired = null;
  try { retired = await api.stopSessionWork(probeSessionId); }
  catch (error) { retireError = error; }
  check('stopSessionWork 在真实会话上成功返回（不再抛 baseline 结构错）',
    retireError === null, retireError?.message ?? `removed=${retired?.removed}`);

  // ── 5e. $events ready 帧 ─────────────────────────────────────────────────
  const readyFrame = await new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { cookie: api.cookie } });
    const streamId = randomUUID();
    const timer = setTimeout(() => { try { socket.close(); } catch {} resolve(null); }, 10_000);
    const finish = (value) => { clearTimeout(timer); try { socket.close(); } catch {} resolve(value); };
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } })));
    socket.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.streamId !== streamId || m.type !== 'item') return;
      if (m.value?.type === 'ready') finish(m.value);
    });
    socket.addEventListener('error', () => finish(null));
  });
  check('$events 下发 ready 帧并带 clientId',
    typeof readyFrame?.clientId === 'string' && readyFrame.clientId.length > 0,
    readyFrame ? `${String(readyFrame.clientId).slice(0, 8)}…` : '未收到 ready 帧');

  // ── 5f. session/modelCatalog 形状 ────────────────────────────────────────
  const catalog = await api.callUnary('session/modelCatalog', {});
  check('session/modelCatalog 可用且给出模型分组', catalog.result?.ok === true && Array.isArray(catalog.result?.value?.groups),
    catalog.result?.ok ? `${catalog.result.value.groups.length} 组` : `${catalog.result?.error?.code}`);

  // ── 5g. preset 真跑一个回合：提示词变量可解析（0.2.1 断裂点回归网）──────────
  // 0.2.1 把 `cwd` 从 agent loop 的提示词变量表里删掉了（只剩 provider / model）。
  // system prompt 对未知变量是 fail loud ⇒ 回合在 turn/start 后立刻 error，
  // 模型一次都不跑，QQ 上表现为「完全不回」。静态断言只能看出"写了什么变量"，
  // 只有真跑一回合才能证明它**可解析**。
  let turnSessionId = null;
  try {
    const turnSession = unwrap(await api.sessions.create({ cwd: probeDir, agentPreset: 'qq-chat-v2' }), 'session.create(turn)');
    turnSessionId = turnSession.sessionId;
    await api.sessions.selectModel({ sessionId: turnSessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
    const turn = await new Promise((resolve) => {
      const socket = new WebSocket(url, { headers: { cookie: api.cookie } });
      const streamId = randomUUID();
      let text = '';
      const timer = setTimeout(() => { try { socket.close(); } catch {} resolve({ reason: null, text, timeout: true }); }, 90_000);
      const finish = (value) => { clearTimeout(timer); try { socket.close(); } catch {} resolve(value); };
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: turnSessionId } } } } }));
        setTimeout(() => {
          api.sessions.prompt({ sessionId: turnSessionId, mode: 'queue', content: [{ type: 'text', text: '只回复两个字：收到' }] }).catch(() => {});
        }, 800);
      });
      socket.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.streamId !== streamId || m.type !== 'item') return;
        const e = m.value?.type === 'event' ? m.value.event : null;
        if (!e) return;
        if (e.type === 'assistant/message') {
          for (const block of e.data?.message?.content ?? []) if (block?.type === 'text') text += block.text;
        }
        if (e.type === 'turn/end') finish({ reason: e.data?.reason, text });
      });
      socket.addEventListener('error', () => finish({ reason: null, text, error: true }));
    });
    const kind = typeof turn.reason === 'string' ? turn.reason : turn.reason?.kind;
    const why = turn.reason?.error?.message;
    check('preset 真跑一回合：提示词变量可解析且正常结束',
      kind === 'completed' && turn.text.length > 0,
      kind === 'completed' ? `text=${JSON.stringify(turn.text.slice(0, 24))}` : `${kind ?? 'no turn/end'}${why ? `: ${why}` : ''}`);
  } catch (error) {
    check('preset 真跑一回合：提示词变量可解析且正常结束', false, error?.message ?? String(error));
  } finally {
    if (turnSessionId) { try { await api.callUnary('workspace/archiveSession', { sessionId: turnSessionId }); } catch {} }
  }
} catch (error) {
  check('DSH 实测段无未捕获异常', false, error?.message ?? String(error));
} finally {
  if (probeSessionId) {
    try { await api.callUnary('session/cancel', { sessionId: probeSessionId }); } catch {}
    try { await api.callUnary('workspace/archiveSession', { sessionId: probeSessionId }); } catch {}
  }
  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
}

// 点号 endpoint（旧协议）应返回纯文本 404（不是 JSON 信封）——证明协议确为斜杠式
const dotRes = await fetch(`${BASE}/api/session.list`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'v-dot', method: 'session.list', payload: { args: { _request: {} } } }),
});
const dotBody = await dotRes.text();
check('点号 endpoint /api/session.list 不可用（旧协议已废弃）', dotRes.status === 404 && /not found/i.test(dotBody), `HTTP ${dotRes.status}`);

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
// 用 process.exitCode 而不是 process.exit()：后者会在 undici 的 keep-alive socket
// 仍在关闭途中强行拆掉事件循环，在 Windows 上触发 libuv 断言
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c）。
// 结果是「断言全过但退出码非 0」，CI 会误判失败。设 exitCode 让循环自然排空即可。
process.exitCode = fail === 0 ? 0 : 1;
