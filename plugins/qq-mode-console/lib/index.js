// QQ 桥接模式控制台（host 插件，只暴露一个 settings 命名空间）。
//
// 这个插件**没有 browser/client 半**，不会生成 WebUI 设置卡片；用户通过桥接控制台
// 切换模式，桥接进程通过 DSH settings API 读写。本插件不修改任何 WebUI 内核。
//
// ⚠️ DSH 0.2.0 起，命名空间**不再需要注册**。
//   0.1.x 有 `ctx.settings.register(ns, schema, opts)`；0.2.0 已经删掉它，
//   `SettingsForms` 的公开面只剩 configure / writable / documentPath /
//   prepareDocument / describe / update / replace / mutate。命名空间改为
//   **从 profile 的 loader entry 推导**（dsh-settings 的
//   `configEditor.configuration()` → `ns: entry.options.id`），一个命名空间要能被
//   读写，只需要：
//     ① 存在一个 loader entry，其 **id 恰好等于命名空间名** —— 见 cordis.patch.yml
//        的 `id: qq-mode`（不是 `qq-mode-console`）；
//     ② 该 entry 的插件模块导出 `Config`（schema 读的就是 fiber.runtime.Config）；
//     ③ `Config` 里至少有一个字段带 `volatile` 标记。
//   所以本插件的 `apply()` 在 0.2.0 下是**空操作**，命名空间照样出现在
//   `settings/describe` 里、照样可写（2026-09-29 在 0.2.0-rc.2 上实测：
//   describe 列出 `qq-mode`，update 写回成功并返回 SettingsNamespaceView）。
//   这里保留一个显式空实现 + 诊断日志，是为了让"这个 entry 确实被装配了"可观测，
//   同时避免有人照着旧注释把 `settings.register` 加回来（那会让 apply 抛
//   TypeError，虽然会被下面这句早退挡住，但日志会开始说谎）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

// 诊断日志写系统临时目录，**不要**按相对层级往上爬。
//
// 历史坑：这里曾经是 path.join(__dirname, '..', '..', '..', 'state', ...)。
// 插件是以 `link:<DSH_HOME>/plugins/qq-mode-console` 装进 profile 的，往上是
// <DSH_HOME>/..，于是在任何非作者机器上都会在用户主目录旁凭空拉出一个 state/ 目录，
// 只有作者机器上恰好指回仓库时才"看起来正常"。可用 QQ_MODE_DIAG 覆盖路径（空字符串=关闭）。
const DIAG = process.env.QQ_MODE_DIAG ?? path.join(os.tmpdir(), 'qq-mode-plugin.log');

function diag(msg) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const name = 'qq-mode-console';
// 命名空间属于 settings seam：声明依赖让 entry 等 settings 就绪后再 activate。
export const inject = ['settings'];

export const QQMODE_NAMESPACE = 'qq-mode';

/**
 * 独立的 schema（历史遗留：0.1.x 的 `settings.register()` 需要它）。
 * 现在**不参与** DSH 的 settings 定位（那用的是下面导出的 `Config`），
 * 但仓库里的静态测试会用它验证非法 mode 被拒绝，故保留。
 */
export const QqModeSchema = z.object({
  // `simulation` 是规范名，`chat`/`reserved`/`reserved2` 是历史拼写。
  // 两者都必须能被**存进设置**：桥接在输入侧把它们归一到同一个内部值（见 bridge.js 的
  // MODE_INPUT_ALIASES），但这里如果只列历史名，用户在 DSH 设置里写 `simulation` 会被
  // schema 直接拒掉，而 schema 校验失败会把整个命名空间一起打掉 —— 连 ownerQQ 都读不到，
  // 桥接只能回退本地 mode.json 且**没有任何提示**。默认值保持 `reserved2`（不改变现有用户行为）。
  mode: z.union([
    z.const('chat'), z.const('closed-agent'), z.const('reserved'), z.const('reserved2'), z.const('simulation')
  ]).default('reserved2'),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json'),
});

/**
 * 这个插件**作为 loader entry 的 Config** 暴露出去的模式设置。
 *
 * 为什么必须有它、而且字段必须带 `volatile`：
 *   DSH 定位 settings 命名空间的方式（0.1.7 起成立，0.2.0 更加是唯一路径）是
 *   （dsh-settings/lib/index.js）：
 *       const entry = configEditor.entries().find((row) => row.options.id === ns);
 *       const schema = entry?.fiber?.runtime?.Config;
 *       if (!entry || !schema) throw new Error(`No configurable plugin entry "${ns}"`);
 *       const form = volatileForm(schema);   // 只保留 meta.volatile 的字段，否则抛
 *                                            // "Plugin entry ... has no volatile fields"
 *   也就是说，一个命名空间要能被**写入**，必须同时满足三点：
 *     ① 存在一个 loader entry，其 **id 恰好等于命名空间名** —— 所以 cordis.patch.yml 里
 *        这条 entry 的 id 是 `qq-mode`（不是 `qq-mode-console`）；
 *     ② 该 entry 的插件模块导出了 `Config`（schema(entry) 读的就是 fiber.runtime.Config）；
 *     ③ `Config` 里至少有一个字段带 `volatile` 标记。
 *   0.1.5 时代只有 `ctx.settings.register()`，而 entry id 与命名空间不同名 —— 于是桥接的
 *   「模式写穿 DSH 设置」永远抛 `No configurable plugin entry "qq-mode"`：模式只在本地生效，
 *   下一次 DSH 轮询就把它覆盖回滚（只在有人从控制台改模式时才会暴露）。
 *   这里补齐 ②③；① 在 cordis.patch.yml。
 *
 * `.extra('volatile', true)` 是 DSH 的"可热改、不重挂载"标记。这里**刻意不写 `.volatile()`**：
 * 那只是 schemastery 的一个语法糖（dsh-client-ui-theme 的 client.js 里就是
 * `Schema.prototype.volatile = function () { return this.extra('volatile', true) }`），
 * 而它只存在于 DSH 自带的那份 schemastery；本仓库钉的 `^3.18.1` 解析出来的
 * 那份**没有**这个方法 —— 写 `.volatile()` 会让桥接自己的静态测试直接
 * `TypeError: .volatile is not a function`（实测）。`.extra` 两边都有，行为完全一致。
 */
export const Config = z.object({
  mode: z.union([
    z.const('chat'), z.const('closed-agent'), z.const('reserved'), z.const('reserved2'), z.const('simulation')
  ]).default('reserved2').extra('volatile', true),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json').extra('volatile', true),
});

/**
 * 装配钩子。0.2.0 下**不需要做任何事**：命名空间由 entry id + `Config` 推导
 * （见文件头注释）。这里只记一行诊断，证明 entry 真的被装配过。
 *
 * 刻意不调用 `ctx.settings.register(...)`：该方法在 0.2.0 已不存在。
 * 也不要改成 `ctx.settings.configure({ auto: false })` —— 那会关掉自动设置页策略，
 * 与我们要的默认行为相反（默认 auto=true）。本插件没有 client 半，本来也不会渲染卡片；
 * 命名空间的可读写性与设置页无关。
 */
export function apply(ctx) {
  diag(`apply called; settings service=${typeof ctx.settings}; namespace=${QQMODE_NAMESPACE} (0.2.0: no registration needed)`);
}

