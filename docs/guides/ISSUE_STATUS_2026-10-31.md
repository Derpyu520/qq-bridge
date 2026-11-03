# 2026-10-31 未关闭 issues 核查

核查起点为 `dev` 的 `4c9f0b6`，覆盖当时全部 62 个未关闭 issues 的正文、讨论及相关 PR 状态。
本轮最终交付分支为 `fix-a/dev`，以下状态指该分支的代码与回归结论，不代表这些改动已发布到 `main`。
按维护者确认的分组处理 A、B、C1；C2 已关闭，C3 仅关闭 #96/#21、#81 搁置，C4 保持不变。
功能建议、环境报告和无法复现的上游问题保留各自结论。

## 逐项结果

| Issue | 状态 | 核查结论与依据 |
| --- | --- | --- |
| [#129](https://github.com/Derpyu520/qq-bridge/issues/129) | 讨论 | 人格提示词分享；角色卡和注入节奏已有功能，社区内容讨论仍开放 |
| [#117](https://github.com/Derpyu520/qq-bridge/issues/117) | 已有修复 | 唤醒已注入完整角色卡，PR #100/#118 已合并；`test-role-injection-cadence.mjs` 覆盖首次、换卡、重建会话与节奏 |
| [#116](https://github.com/Derpyu520/qq-bridge/issues/116) | 保持设计 | 研究结果只补解释，转正需管理员审核；符合 `RULES.md`，不能把模型的 confirmed 当成人工授权 |
| [#115](https://github.com/Derpyu520/qq-bridge/issues/115) | 本轮修复 | 移除控制台、自愈、发现诊断和默认语音 CLI 输出中的令牌片段 |
| [#114](https://github.com/Derpyu520/qq-bridge/issues/114) | 本轮修复 | 成功唤醒后清除限频补发计时器，避免重复开回合 |
| [#113](https://github.com/Derpyu520/qq-bridge/issues/113) | 本轮修复 | 机器人发送记录不再标为管理员，管理员身份仍由真实发送者判定 |
| [#112](https://github.com/Derpyu520/qq-bridge/issues/112) | 已有修复 | 可选的本地 `VOICE.md` 已有存在性检查；前轮干净 CI 已通过完整套件 |
| [#111](https://github.com/Derpyu520/qq-bridge/issues/111) | 环境排障 | 保留 fake-ip 地址拒绝，新增明确诊断与真实 DNS 配置指引，见安装指南；与 #40 相同 |
| [#110](https://github.com/Derpyu520/qq-bridge/issues/110) | 本轮修复 | 凭据读取失败不再永久缓存 null；缺失、损坏后修复文件即可重新探测 |
| [#109](https://github.com/Derpyu520/qq-bridge/issues/109) | 本轮修复 | 已读状态不再吞掉忙碌期间积压的私聊、@、点名与拍一拍唤醒；普通概率唤醒仍可按水位跳过 |
| [#107](https://github.com/Derpyu520/qq-bridge/issues/107) | 本轮修复 | 非管理员斜杠命令静默忽略；可用 `ignore.sendQQ` 按发送者过滤，管理员不受忽略名单影响 |
| [#106](https://github.com/Derpyu520/qq-bridge/issues/106) | 功能建议 | 第三方 MCP 授权尚未实现；当前三个命名空间的白名单是明确安全边界 |
| [#105](https://github.com/Derpyu520/qq-bridge/issues/105) | 需复现 | 腾讯官方 bot 的工具挂载问题涉及额外适配；现有 OneBot 夹具不足以证明该部署可用，需对应预设与注册清单 |
| [#104](https://github.com/Derpyu520/qq-bridge/issues/104) | 本轮修复 | 回合错误保留本地诊断；二代不自动把上游错误发往群聊，其他模式使用通用提示并节流 |
| [#102](https://github.com/Derpyu520/qq-bridge/issues/102) | 项目分享 | 第三方启动器；不属于本仓库故障，本轮未引入自动启停外部程序 |
| [#101](https://github.com/Derpyu520/qq-bridge/issues/101) | 使用咨询 | 无故障复现内容；账号风险不能通过桥接代码保证消除 |
| [#97](https://github.com/Derpyu520/qq-bridge/issues/97) | 需上游复现 | 插件注册表与 RPC 作用域不一致的报告尚无本仓库隔离复现；补安装上下文核对指引，保留预设 fail-closed |
| [#96](https://github.com/Derpyu520/qq-bridge/issues/96) | 按维护者要求关闭 | 没有正文、版本与日志，不将关闭视作已复现或代码修复 |
| [#94](https://github.com/Derpyu520/qq-bridge/issues/94) | 兼容性咨询 | TIM 没有可验证复现，当前依赖 QQ/SnowLuma 的支持范围，未宣称 TIM 可用 |
| [#92](https://github.com/Derpyu520/qq-bridge/issues/92) | 功能建议 | 管理员与群聊并行使用不同模式需要路由设计，尚未接入生产链路 |
| [#91](https://github.com/Derpyu520/qq-bridge/issues/91) | 环境排障 | `js-yaml` 已在依赖与锁文件声明；补充源码包需要先运行 `npm install` 的排障说明 |
| [#90](https://github.com/Derpyu520/qq-bridge/issues/90) | 本轮修复 | 为带有效令牌的 owner 私聊开放有限媒体路由，仍检查目标白名单；其他会话、模式和管理端点均不放行 |
| [#81](https://github.com/Derpyu520/qq-bridge/issues/81) | 按维护者要求搁置 | 不继续复现或改动该部署问题，保留 issue 开放 |
| [#80](https://github.com/Derpyu520/qq-bridge/issues/80) | 补充修复 | PR #78 已覆盖二代结构净化，本轮补齐一代/普通聊天的文本与昵称拼装；不把净化视为提示注入的完整防线 |
| [#77](https://github.com/Derpyu520/qq-bridge/issues/77) | 环境已定位 | 原帖最终讨论确认安装与服务运行用户不同，导致 `DSH_HOME` 不同；已补指南，不再按 npm 全面不兼容定性 |
| [#75](https://github.com/Derpyu520/qq-bridge/issues/75) | 项目分享 | lite 后端 fork 的体验与功能分享；未整体合入 |
| [#72](https://github.com/Derpyu520/qq-bridge/issues/72) | 功能建议 | provider 格式错误后改变上下文补跑尚未实现；自动重试会增加成本和重复副作用，需要单独设计 |
| [#71](https://github.com/Derpyu520/qq-bridge/issues/71) | 本轮修复 | 关闭端点跟随时，仅接受与所配置 HTTP/WS 地址分别匹配的令牌，避免跨实例串凭据 |
| [#70](https://github.com/Derpyu520/qq-bridge/issues/70) | 本轮修复 | 唤醒常见别名显式规范化；未知键、冲突键和无意义的 keyword 布尔值明确失败 |
| [#69](https://github.com/Derpyu520/qq-bridge/issues/69) | 功能清单 | 衍生模块提案；其中参数容错见 #66，其余未整体合入 |
| [#68](https://github.com/Derpyu520/qq-bridge/issues/68) | 功能建议 | QQ 文件收发未实现；保持当前不暴露文件上传下载的工具边界 |
| [#67](https://github.com/Derpyu520/qq-bridge/issues/67) | 功能建议 | 输入状态宽限窗口未实现，现有等待逻辑不等同正在打字检测 |
| [#66](https://github.com/Derpyu520/qq-bridge/issues/66) | 本轮修复 | 工具 schema 改为严格校验，未知参数不再静默丢弃；受支持别名显式声明并纳入会话边界检查 |
| [#64](https://github.com/Derpyu520/qq-bridge/issues/64) | 扩展分享 | 控制台、ComfyUI 与语音扩展候选，未整体合入 |
| [#61](https://github.com/Derpyu520/qq-bridge/issues/61) | 已有修复 | 活跃预设中已移除失效 cwd 变量；`DSH_021_ADAPTATION.md` 与预设回归覆盖 |
| [#59](https://github.com/Derpyu520/qq-bridge/issues/59) | 功能建议 | 实时 TTS/音色克隆未实现；现有语音发送只使用语音库 |
| [#58](https://github.com/Derpyu520/qq-bridge/issues/58) | 功能建议 | macOS/NapCat PR #65 已关闭且未合并，当前仍以 Windows 为支持范围 |
| [#56](https://github.com/Derpyu520/qq-bridge/issues/56) | 已有修复并补充 | PR #63 已实现端点发现和 rebind；本轮补自动发现关闭开关及离线验证 |
| [#55](https://github.com/Derpyu520/qq-bridge/issues/55) | 已有修复 | 不支持的思考强度已可去字段重试，保持配置 provider/model；本轮新增可执行回归证明 |
| [#54](https://github.com/Derpyu520/qq-bridge/issues/54) | 本轮修复 | ACL 改为先授权、再断继承、最后移除宽松授权；失败与空 DACL 不再判成功，手动命令同步顺序 |
| [#53](https://github.com/Derpyu520/qq-bridge/issues/53) | 项目分享 | 衍生版贡献征询，现有部分能力有独立实现，未整体合入该 fork |
| [#52](https://github.com/Derpyu520/qq-bridge/issues/52) | 主要适配已覆盖 | 桌面版随机端口与失效 cwd 变量已有对应修复；不据此宣称所有安装形态已实测 |
| [#42](https://github.com/Derpyu520/qq-bridge/issues/42) | 已有修复 | `isSilentMarker()` 已在各模式的转发分流前统一处理，closed-agent 纯静默标记也不会自动外发 |
| [#40](https://github.com/Derpyu520/qq-bridge/issues/40) | 环境排障 | 与 #111 同类 fake-ip/DNS 冲突；补诊断与配置指引，保留 SSRF 防护 |
| [#39](https://github.com/Derpyu520/qq-bridge/issues/39) | 已有修复 | 失效 cwd 变量已移除，与 #61 相同 |
| [#38](https://github.com/Derpyu520/qq-bridge/issues/38) | 功能分享 | 唤醒、跨会话摘要、ASR 等组合提案，未整体合入 |
| [#35](https://github.com/Derpyu520/qq-bridge/issues/35) | 功能建议 | 可选 Pi 后端尚未实现，不属于当前 DSH 桥接回归 |
| [#34](https://github.com/Derpyu520/qq-bridge/issues/34) | 主要原因已有修复 | 讨论后段定位桌面版端口变化，对应 #56；其他截图中的异常仍需具体日志区分 |
| [#32](https://github.com/Derpyu520/qq-bridge/issues/32) | 已有修复 | 会话退役有有界超时，控制流关闭与失败取消均有 `test-audit-protocol.mjs` 覆盖 |
| [#31](https://github.com/Derpyu520/qq-bridge/issues/31) | 讨论 | 实时 TTS 与自主交流体验，未作为本轮故障修复扩展后端 |
| [#29](https://github.com/Derpyu520/qq-bridge/issues/29) | 已有修复 | 唤醒提示明确机器人昵称和身份，`test-issue-regressions.mjs` 覆盖 |
| [#27](https://github.com/Derpyu520/qq-bridge/issues/27) | 功能建议 | 多 QQ 通道共享一个 DSH 上下文尚未实现，当前继续逐会话隔离 |
| [#26](https://github.com/Derpyu520/qq-bridge/issues/26) | 已有修复 | 回合外事件不再永久建忙 collector，租约和结束帧回归已覆盖 |
| [#23](https://github.com/Derpyu520/qq-bridge/issues/23) | 已有修复 | 与 #11/#26 同类，已有 collector 生命周期和判忙回归 |
| [#21](https://github.com/Derpyu520/qq-bridge/issues/21) | 按维护者要求关闭 | 无正文，不将关闭视作已复现或代码修复 |
| [#20](https://github.com/Derpyu520/qq-bridge/issues/20) | 项目分享 | 忙态故障已有独立修复；共享记忆、快照等额外能力未整体合入 |
| [#19](https://github.com/Derpyu520/qq-bridge/issues/19) | 已有修复并补充 | HTTP/WS 独立令牌、重连与忙态已有实现；本轮补 #71 地址绑定和离线令牌配对回归 |
| [#17](https://github.com/Derpyu520/qq-bridge/issues/17) | 已有修复 | 搜索已优先 DeepSeek，RSS 作为兜底；空结果诊断和缓存已有回归，服务端真实可用性仍依赖外部网络 |
| [#15](https://github.com/Derpyu520/qq-bridge/issues/15) | 功能建议 | 腾讯官方 QQ bot 协议适配未实现，不能把现有 OneBot v11 接口视为直接支持 |
| [#11](https://github.com/Derpyu520/qq-bridge/issues/11) | 已有修复 | 回合起始时间、租约与 collector 生命周期修复已由 `test-issue-regressions.mjs` 等覆盖 |
| [#9](https://github.com/Derpyu520/qq-bridge/issues/9) | 本轮文档修复 | 补齐 DSH 0.1.2～0.1.4 的 persona schema 不兼容说明和历史版本范围 |
| [#3](https://github.com/Derpyu520/qq-bridge/issues/3) | 已有修复 | 当前客户端已使用 Cookie、斜杠 RPC 和 remote.mux；旧协议与历史标签范围已有明确说明 |

## 验证与限制

本轮新增桥接、MCP 与运行时三组隔离回归，并纳入 `npm run test:audit`。
离线套件不枚举本机 DSH 安装包，避免宿主机包规模影响测试时限；工具权限和预设的离线断言继续执行，
升级 DSH 后仍应单独运行 `npm run scan:tool-names` 对账实际工具名。
凭据、服务端、令牌与 ACL 都由测试夹具模拟；未对用户机器执行真实 ACL 收紧、DSH 升降级或 QQ 发送。
完整离线套件结果为 `Audit suite: 54/54 scripts passed.`；桥接跟进 16 组、MCP 跟进 14 组、
运行时跟进 11 组全部通过。129 个 JS/MJS/CJS 文件语法、9 个 JSON 解析和默认规则隐私扫描通过。
远端 CI 以 `fix-a/dev` 对应提交的运行结果为准。

维护者指定的关闭范围共 35 条：A 组 15 条、B 组 6 条、C1 组 12 条，以及 #96/#21。
在修复提交并完成验证后执行关闭；C2 保持已关闭，其他条目不在本轮关闭范围。

本轮保留 #97/#105 等待对应部署资料；#81 搁置。#96/#21 仅按维护者要求关闭，
没有因其他测试通过而标记为已修复。C4 功能建议保持各自范围，未以放开私有地址、
跨群令牌或本地工具权限来绕过当前边界。
