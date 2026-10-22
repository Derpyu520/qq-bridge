// 铁律 L7 的注册期断言：仿真会话的 preset **不得包含本地执行能力**。
//
// 为什么必须有这个文件
// --------------------
// `QSH_PLAN.md` §0.1 的结论是：QQ 动作闸门全部跑在桥接进程内，而 OneBot 的
// 127.0.0.1:3000 HTTP 接口可被任何本机进程用 Bearer token 直接调用。因此
// **"仿真会话拿不到 shell"是整个分层安全模型唯一的真边界**。
//
// 但在此之前没有任何断言检查过这件事：
//   · `test-audit-setup-guards.mjs` 把工具名**喂**给 guard，验证它拒绝——这证明
//     guard 逻辑对，**不证明本地工具已从工具清单里隐藏**；
//   · `probe-tools.mjs` 只断言"模型某一轮没有调用本地工具"——**没调用 ≠ 不在清单里**。
//
// 本测试补上注册期那一半：从**真实 preset 文件**里解析出 preset 组成，断言
// 工具守卫被挂载，并且守卫的 restrict 名单覆盖每一个已知本地执行工具。
// 它不依赖运行中的 DSH，因此可以进 `npm run test:audit`，每次回归都跑。
//
// 口径说明：这里断言的是"preset 声明会隐藏/拒绝这些名字"。真正的端到端断言
// （注册出来的清单里确实没有）需要活的 DSH，属 `probe-tools.mjs` 的范畴。

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { collectDshToolNames as collectDshToolNamesShared } from './dsh-tool-names.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRESETS_DIR = path.join(ROOT, 'dsh', 'agent-presets');

/** 仿真模式使用的 preset（不允许有任何本地执行能力）。 */
const SIMULATION_PRESETS = ['qq-chat', 'qq-chat-v2'];

/** 封闭 agent 的 preset：按设计**允许**完整本地工具面。 */
const CLOSED_AGENT_PRESETS = ['qsh-closed'];

/**
 * 本地执行能力清单。
 *
 * ⚠️ 这里**必须**含每一个能执行本地命令、读写本地文件或派生 agent 的工具名。
 * 名字取自 DSH 0.1.7-rc.2 实际注册的工具（见 qq-tool-restrict.mjs 的注释）。
 * 2026-09-27 的对账替换：`cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop`
 * 在 0.1.7 里已不存在（dsh-tool-cordis 现在只注册 cordis_inspect_list/query），
 * 同一轮补上 `load_workspace_dependencies`（自带 Python/Node/pnpm 路径）与
 * `list_subagent_models`（派生 agent 家族）。
 *
 * 两类失败模式，本文件都要防：
 *   ① **漏**（本地工具不在守卫名单里 ⇒ 留在 schema）——由 test 3 对账 RESTRICTED_TOOL_NAMES 防；
 *   ② **拼错假名**（名字根本不存在 ⇒ `tools.restrict` 抛错被吞 ⇒ 静默失效）——
 *      由 test 6 用「假 restrict 会对未知名字抛错」来防。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（用 `scripts/scan-dsh-tool-names.mjs`
 * 从安装包里抽真实工具名双向求差）。旧名字全部还在（0 假名），新增 13 个危险语义名字：
 *   · 全局层默认启用、仿真会话真的会继承的三个 MCP 资源工具
 *     （`dsh-base` 的 `mcp-resources` 行没被 disabled）；
 *   · 派生 agent / 执行外部代码：subagent_codex / subagent_claude_code /
 *     spawn_teammate / team_task_*（现只在 DSH 自带 preset 里挂，列进来当回归网）；
 *   · plugin_manager（插件装载权 = 任意代码执行）；
 *   · schedule_*（无人值守的自我调度）。
 */
const LOCAL_EXECUTION_TOOLS = [
  'pwsh', 'bash',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep',
  'load_workspace_dependencies',
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  'cordis_inspect_list', 'cordis_inspect_query',
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  // 0.2.0 新增对账
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 0.2.1 新增对账（2026-10-22）：working_directory 由 dsh-base 默认挂载（全局层继承），
  // terminal 一族 = shell，session_* 能跨会话读事件正文，plugin_market = 装载权。
  'working_directory',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  'plugin_market', 'create_worktree', 'wait_agent',
  // 按需安装的可选组合包才注册的名字：0.2.1 起默认不存在，但一旦装上就要挡，
  // 所以仍在名单里；对账时按「可选项」处理（见下方 OPTIONAL_BUNDLE_TOOLS）。
  'subagent_codex', 'subagent_claude_code',
];

/** 0.2.1 起 Codex / Claude Code 改为按需安装：这组名字默认扫不到，不算拼错假名。 */
const OPTIONAL_BUNDLE_TOOLS = new Set(['subagent_codex', 'subagent_claude_code']);

/**
 * 工具名 → 真实存在与否。抽取实现在 `scripts/dsh-tool-names.mjs`（唯一实现，
 * 与 `scan-dsh-tool-names.mjs` 共用），用来抓"拼错的假名"。
 *
 * 历史坑：本测试过去自带一份**模糊**抽取器（全文件乱扫 `name: 'x'` + 只认少数
 * 包名前缀 + 只读包根目录的 cordis.patch.yml）。0.2.0 对账时它把 10 个**真实存在**
 * 的工具名报成假名：`dsh-mcp-resources` / `dsh-experimental-tool-agent-team` 不匹配
 * 它的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而非包根。
 * 误判方向很危险——它会逼人把真名字从守卫名单里删掉，等于自己拆掉安全边界。
 * 现在只保留一条实现，两边不可能再漂移。
 */
function collectDshToolNames() {
  const { names } = collectDshToolNamesShared();
  return names.size === 0 ? null : new Set(names.keys());
}
/** 允许出现在名单里、但不属于"本地执行"语义的名字（开发/注入器）。 */
const DEV_TOOL_PREFIX = /^dev_/;

/** 允许出现的 MCP 命名空间前缀（QQ 动作面）。 */
const EXPECTED_SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
];

function readPreset(id) {
  const dir = path.join(PRESETS_DIR, id);
  assert.ok(fs.existsSync(dir), `preset 目录存在：${id}`);
  const cordis = path.join(dir, 'agent.cordis.yml');
  assert.ok(fs.existsSync(cordis), `preset 有 agent.cordis.yml：${id}`);
  return { dir, yml: fs.readFileSync(cordis, 'utf8'), cordis };
}

// ---------------------------------------------------------------------------
test('模拟会话的 preset 都挂了工具守卫（否则 L7 没有任何载体）', () => {
  for (const id of SIMULATION_PRESETS) {
    const { yml } = readPreset(id);
    assert.match(
      yml,
      /qq-tool-restrict/,
      `${id} 必须挂载 qq-tool-restrict（L7 的落点），否则本地工具会随全局层继承进来`,
    );
    // 源文件里仍是 preset 目录内的相对名；DSH 0.1.7 下真正装进 DSH 的是 bundle patch
    // （scripts/build-agent-preset-patches.mjs 生成），那里会把它改写成从 profile 目录
    // 可解析的 `qq-agent-presets/qq-tool-restrict.mjs`——这条断言钉的是"源里必须有守卫行"，
    // 改写结果由 test-agent-preset-patches.mjs 钉住。
    assert.match(yml, /\.\/qq-tool-restrict\.mjs/, `${id} 的守卫要指向本目录的 .mjs`);
  }
});

test('模拟会话的 preset 不得挂载 tool-web 的 search/fetch', () => {
  for (const id of SIMULATION_PRESETS) {
    const { yml } = readPreset(id);
    const webRow = /id:\s*tool-web[\s\S]{0,200}/.exec(yml);
    assert.ok(webRow, `${id} 应有 tool-web 条目`);
    assert.match(webRow[0], /search:\s*false/, `${id}: tool-web.search 必须为 false`);
    assert.match(webRow[0], /fetch:\s*false/, `${id}: tool-web.fetch 必须为 false`);
  }
});

test('守卫的 restrict 名单覆盖每一个已知本地执行工具', async () => {
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const guardPath = path.join(dir, 'qq-tool-restrict.mjs');
    assert.ok(fs.existsSync(guardPath), `${id} 的守卫文件存在`);

    // 用假 tools 服务调用真实守卫，捕获它实际下发的 restrict 请求。
    const restricted = new Set();
    const fakeTools = {
      restrict({ deny }) { for (const n of deny ?? []) restricted.add(n); },
      guard(fn) { this._guard = fn; },
    };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    const violations = LOCAL_EXECUTION_TOOLS.filter((t) => !restricted.has(t));
    assert.deepEqual(
      violations, [],
      `${id}: 以下本地执行工具未出现在 restrict 名单里，会留在模型的工具清单中：`
      + `${violations.join(', ')}。注册期隐藏失败 ⇒ §5.2 的 L7 断言不成立。`,
    );

    // 执行期白名单也必须拒绝它们（restrict 与 guard 是两道，不能只靠一道）。
    assert.equal(typeof fakeTools._guard, 'function', `${id}: 守卫注册了执行期白名单`);
    for (const tool of LOCAL_EXECUTION_TOOLS) {
      const verdict = fakeTools._guard({ name: tool });
      assert.ok(
        typeof verdict === 'string' && verdict.length > 0,
        `${id}: 本地工具 "${tool}" 必须在执行期被拒绝，实际返回 ${JSON.stringify(verdict)}`,
      );
    }
  }
});

test('守卫导出的名单与本测试的清单一致（防两份名单各自漂移）', async () => {
  // 先前这个测试只是"复制"名单的前 19 个名字，导致守卫里多出的 7 个名字
  // 从来没被断言过。现在改为**导入**守卫自己导出的数组，两边不可能漂移。
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const mod = await import(pathToFileURL(path.join(dir, 'qq-tool-restrict.mjs')).href);
    assert.ok(
      Array.isArray(mod.RESTRICTED_TOOL_NAMES) && mod.RESTRICTED_TOOL_NAMES.length > 0,
      `${id}: 守卫必须导出 RESTRICTED_TOOL_NAMES，供测试对账`,
    );
    const missing = LOCAL_EXECUTION_TOOLS.filter((t) => !mod.RESTRICTED_TOOL_NAMES.includes(t));
    assert.deepEqual(missing, [],
      `${id}: 守卫导出的名单缺少本地执行工具：${missing.join(', ')}`);
    // 反向：名单里不该混入"允许的无害工具"。
    for (const allowed of ['ask_user_question', 'todo_write']) {
      assert.ok(!mod.RESTRICTED_TOOL_NAMES.includes(allowed),
        `${id}: ${allowed} 是无害模型侧工具，不应出现在 restrict 名单里（会与 SAFE_EXACT 自相矛盾）`);
    }
  }
});

test('守卫名单里的每个名字都是 DSH 真实注册的工具（防拼错假名静默失效）', async () => {
  // 为什么必须测：`tools.restrict()` 对未知名字会**抛错**，而守卫逐个 try/catch
  // 只打日志 ⇒ 拼错的名字 = **静默 no-op**。这正是本名单初版的真实缺陷：
  // pwsh_persistent / bash_persistent / cordis / goal_write / goal_read 五个假名
  // 让整批限制悄悄少生效，而套件当时全绿。
  const dshNames = collectDshToolNames();
  if (dshNames === null) {
    console.log('  ⏭  跳过：未找到 DSH 工具包（设 DSH_TOOL_PACKAGES 指向 @deepseek-ai 目录即可启用）');
    return;
  }
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const mod = await import(pathToFileURL(path.join(dir, 'qq-tool-restrict.mjs')).href);
    const fabricated = mod.RESTRICTED_TOOL_NAMES
      .filter((n) => !DEV_TOOL_PREFIX.test(n) && !OPTIONAL_BUNDLE_TOOLS.has(n) && !dshNames.has(n));
    assert.deepEqual(fabricated, [],
      `${id}: 以下名字在 DSH 已安装的工具包里找不到 ⇒ restrict 会抛错并被吞掉，`
      + `限制静默失效：${fabricated.join(', ')}`);
  }
});

test('守卫仍放行 QQ MCP 命名空间与无害模型侧工具', async () => {
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const guardPath = path.join(dir, 'qq-tool-restrict.mjs');
    const fakeTools = { restrict() {}, guard(fn) { this._guard = fn; } };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    for (const prefix of EXPECTED_SAFE_PREFIXES) {
      assert.equal(
        fakeTools._guard({ name: `${prefix}some_tool` }), undefined,
        `${id}: MCP 前缀 ${prefix} 应放行`,
      );
    }
    for (const name of ['ask_user_question', 'todo_write']) {
      assert.equal(fakeTools._guard({ name }), undefined, `${id}: ${name} 应放行`);
    }
    // 未知工具名必须 fail-closed。
    for (const name of ['', null, undefined, 'mcp__unknown__x', 'totally_new_tool']) {
      assert.ok(
        typeof fakeTools._guard({ name }) === 'string',
        `${id}: 未知工具 ${JSON.stringify(name)} 必须被拒绝（fail-closed）`,
      );
    }
  }
});

test('封闭 agent 的预设在创建后必须与仿真 preset 明确区分', () => {
  // qsh-closed 由 ADR 0003 定义为**故意**拥有完整本地工具面：它的守卫只负责
  // "哪些 QQ 动作可见"，不负责"本地工具权限边界"。
  //
  // ⚠️ 这条断言初版是**恒真**的：qsh-closed 还不存在，`if (!exists) continue`
  // 直接跳过整个函数体，永远不会失败——一个永远不会失败的测试不如没有。
  // 现在改为显式记录"尚未创建"，并且一旦创建就执行真实断言。
  const present = CLOSED_AGENT_PRESETS.filter((id) => fs.existsSync(path.join(PRESETS_DIR, id)));
  if (present.length === 0) {
    // 不是失败，但必须让人看见"这条闸门还没被真正覆盖"。
    console.log('  ⏭  qsh-closed 尚未创建（ADR 0003 待落地）；此项覆盖暂为空，不是通过。');
    return;
  }
  for (const id of present) {
    const yml = fs.readFileSync(path.join(PRESETS_DIR, id, 'agent.cordis.yml'), 'utf8');
    assert.match(yml, /qq-tool-restrict/, `${id} 也应挂守卫（用于 QQ 动作可见性）`);
    // 与仿真 preset 的关键区别：封闭 agent 必须能拿到本地工具 ⇒
    // 它的守卫不得把本地执行工具写进 restrict 名单。
    const guard = fs.readFileSync(path.join(PRESETS_DIR, id, 'qq-tool-restrict.mjs'), 'utf8');
    for (const tool of ['pwsh', 'read', 'write']) {
      assert.ok(
        !new RegExp(`['"]${tool}['"]`).test(guard),
        `${id}: 封闭 agent 需要本地工具，守卫不应把 "${tool}" 列入 restrict`,
      );
    }
  }
});
