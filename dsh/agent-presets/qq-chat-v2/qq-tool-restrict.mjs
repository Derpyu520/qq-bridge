// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
// 本文件是 agent preset 内相对插件，随 preset 装载进每个 QQ agent 的 scope。
// 作用：
//  1) 用 tools.restrict 把已知的开发/管理工具从工具列表隐藏；
//  2) 用 tools.guard 白名单兜底：即使未来新增 dev_* 工具，也会在执行时被拒绝。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // dsh-super-injector / 开发注入器（当前 DSH 0.1.1-rc.2 实际注册的全局工具）
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_mode_set',
  'dev_mode_status',
  'dev_mode_subagent',
  'dev_plugin_status',
  'dev_router_mode',
  'dev_router_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])

export function apply(ctx) {
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      // 名字不存在时跳过；执行期白名单仍然兜底。
      console.error(`[qq-tool-restrict] skip restrict ${name}: ${error?.message ?? error}`)
    }
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return
    if (SAFE_EXACT.has(name)) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
