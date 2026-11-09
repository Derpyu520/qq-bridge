// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'audit/test-audit-bridge.mjs', 'audit/test-audit-protocol.mjs', 'audit/test-audit-protocol-helpers.mjs',
  'audit/test-audit-security.mjs', 'audit/test-audit-security-mcp.mjs',
  // 网络、DSH 探测、跨会话资料与发送队列的边界回归。
  'audit/test-audit-network-boundaries.mjs', 'audit/test-audit-dsh-endpoints.mjs',
  'audit/test-audit-runtime-boundaries.mjs', 'audit/test-audit-session-boundaries.mjs',
  'tests/offline/test-code-scanning-boundaries.mjs',
  // 未关闭 GitHub issues 的确认修复与既有修复证明。
  'tests/offline/test-issue-followup-bridge.mjs', 'tests/offline/test-issue-followup-mcp.mjs', 'tests/offline/test-issue-followup-runtime.mjs',
  'audit/test-audit-setup.mjs', 'audit/test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/tests/live/test-dsh-session-retire.mjs）。
  'tests/offline/test-dsh-inbox-projection.mjs',
  // 活体适配验证自身的离线协议回归：必要端点不能假通过，超时后必须停止并归档。
  'tests/offline/test-adaptation-probes.mjs',
  'tests/offline/test-md-to-plain.mjs', 'tests/offline/test-slang-learn.mjs', 'tests/offline/test-mux-reconnect.mjs',
  // 启动器只能停止经锁/PID 验证的本实例，不能按全机进程名误杀其他项目。
  'tests/offline/test-restart-instance.mjs',
  'tests/offline/test-token-economy.mjs', 'tests/offline/test-qq-model-view.mjs', 'tests/offline/test-qq-preset-contract.mjs',
  'tests/offline/test-reply-wait.mjs', 'tests/offline/test-preset-prompt.mjs', 'tests/offline/test-installed-preset-sync.mjs', 'tests/offline/test-role-card.mjs',
  'tests/offline/test-scripts-index.mjs',
  // 角色卡注入节奏：首次/换卡/新会话必须全量，其余只给一行提醒（#118）。
  'tests/offline/test-role-injection-cadence.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、reserved2 落库丢表情识别字段（R16）。
  'audit/test-audit-regressions.mjs',
  // 交付链路：普通聊天图片/文本按会话 FIFO；断线期间完成的回复按 seq 游标补发并去重。
  'tests/offline/test-delivery-regressions.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'tests/offline/test-media-search.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'tests/offline/test-issue-regressions.mjs',
  // 二代「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'tests/offline/test-v2-initial-prompt.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'tests/offline/test-token-usage.mjs', 'tests/offline/test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'tests/offline/test-voice.mjs',
  // QQ 文件（OneBot file 段）：文件名净化/下载目录/文本内联/DSH uploadFile/端点与工具开关
  'tests/offline/test-qq-file.mjs',
  // agentGuard：排除路径/危险命令护栏 + qq-chat-tools preset 与 allowLocalTools 契约
  'tests/offline/test-qq-agent-guard.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'tests/offline/test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'tests/offline/test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'tests/offline/test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'tests/offline/test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'tests/offline/test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'tests/offline/test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'tests/offline/test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'tests/offline/test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 RULES.md 与 docs/guides/SECURITY_BASELINE.md），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'tests/offline/test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'tests/offline/test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'tests/offline/test-snowluma-upstream-health.mjs',
  // 已有离线安全/协议测试也纳入持续回归，避免仅在手工运行时发现退化。
  'tests/offline/test-agent-preset-patches.mjs', 'tests/offline/test-tool-restrict-guard.mjs', 'tests/offline/test-tool-surface.mjs',
  'tests/offline/test-media-normalize.mjs', 'tests/offline/test-stickers.mjs', 'tests/offline/test-forward.mjs',
  'tests/offline/test-v2-wait.mjs', 'tests/offline/test-time-awareness.mjs', 'tests/offline/test-wait-backlog.mjs',
  '../src/core/session-router.test.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
