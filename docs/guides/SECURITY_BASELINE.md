# 安全基线与威胁模型（qq-bridge → QSH）

> 本文把项目里**已经实现的**安全边界、**已知的**残余风险、以及**每次发布必须回归**的
> 检查项集中到一处。与之配套的承诺性文档是 [../RULES.md](../RULES.md)（面向使用者的
> 权限说明）；本文偏工程实现，供改动代码前后对照。
>
> 维护规则：任何改动如果改变了下面任一条目，**必须在同一个 PR 里更新本文**。

---

## 一、威胁模型（我们要防谁、防什么）

| 威胁主体 | 能力假设 | 我们不防的 |
| --- | --- | --- |
| **QQ 群友 / 陌生人** | 能给机器人发任意文本、图片、表情、拍一拍；能尝试提示注入 | 他们能看到的公开信息 |
| **被注入的模型** | 会尝试调用任意工具名、传任意参数、尝试外发本机内容 | —— |
| **本机其他用户** | 能登录同一台机器，能读文件系统 | 已取得管理员/root 的主体 |
| **本机其他进程 / 浏览器页面** | 能访问 `127.0.0.1`，能构造任意 HTTP 请求 | 已能读写本项目 `state/` 的主体 |
| **DSH 侧 agent（QQ 会话）** | 拥有 MCP 工具面，但**没有**本地工具 | —— |

**不在此模型的范围内**：QQ 账号本身被盗、SnowLuma 网关被攻陷、DSH 本体漏洞、
操作系统级攻击者。这些情况下本项目无法提供额外保护，README 中已声明。

---

## 二、已实现的边界（按攻击面）

### 1. 准入（谁能触发 agent）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 白名单 | `src/bridge.js` `allowed()` | `deny` 优先于 `allow`；两侧统一 `String()` 比较（兼容 OneBot int64 的数字/字符串差异）；allow 为空时返回 `allowAllWhenEmpty`（**默认 false**） |
| 模式门 | `modeAllowed()` / `isSessionAllowedInCurrentMode()` | 会话 key 必须严格匹配 `^(group\|private):\d+$`；`closed-agent` 只放行 `private:<ownerQQ>` |
| 配置失败 | `loadConfig()` | `config.json` 缺失/解析失败 → **fail-fast 退出**（不是"用默认值继续跑"） |
| 管理员识别 | `handleIncoming()` | `String(event.user_id) === String(cfg.ownerQQ ?? '')`；未配置 `ownerQQ` 时启动日志明确告警（审批/管理命令/封闭 agent 全部不可用） |

### 2. 工具面（agent 能做什么）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 预设工具守卫 | `plugins/qq-agent-presets/qq-tool-restrict.mjs`（唯一权威实现，`dsh/agent-presets/*/qq-tool-restrict.mjs` 只是 re-export 壳） | 两道闸门：① 注册期 `tools.restrict({deny})` 把本地执行/宿主运行期工具**从模型 schema 里隐藏**（67 个名字，2026-09-29 按 DSH 0.2.0-rc.2 真实工具清单重新对账）；② 执行期 `tools.guard` 精确白名单：仅 `mcp__snowluma__*` / `mcp__snowluma-host__*` / `mcp__web-search-safe__*` + `ask_user_question` / `todo_write`；空/未知名字一律拒绝；内置 `tool-web` 的 search/fetch 关闭。对账工具：`npm run scan:tool-names`（**每次升级 DSH 后应跑一次**：`tools.restrict` 对不存在的名字会抛错并被逐个 try/catch 吞掉 ⇒ 假名 = 静默失效；新版本新增的能力若不补进名单 = 漏隐藏） |
| 预设 fail-closed | `resolvePresetName()` + `ensureSession()` | 群聊/仿真会话拿不到受限预设时**拒绝建会话**，绝不回退到含本地工具的 DSH 默认预设；只有 `closed-agent`（管理员私聊）允许回退 |
| 发送强制白名单 | 所有 `/api/send/*`、`/api/socialV2/send-*` | 目标必须命中 `allow.groups` / `allow.private`（每次都重新校验，不做缓存） |
| 动态 ACL | `resolveVoicePathForV2()` / `voicePathInsideLibrary()` | 语音只能取语音库目录内的文件；贴纸只能发收藏库内的表情；图片只能读 SnowLuma home 内的本地文件（realpath 复核防符号链接逃逸） |
| **只探测、不部署**（L6 设计不变量） | `mcp-host-server.js` | 该 MCP server **只提供 `snowluma_status`（只读探活 `get_login_info`）**。⚠️ **v0.1.5 起删除了 `start_snowluma` / `stop_snowluma` 与 `snowluma.allowProcessControl`**：SnowLuma EULA §5.4 规定「将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**」须事先书面授权，原生组件属**专有组件**。⇒ 本程序不安装、不复制、不打包、不程序化启停 SnowLuma；用户自行安装与启动。详见 `NOTICE.md` 与 `QSH-plan/QSH_PLAN.md` §6.0 |

### 3. 出站内容（模型能说什么、能发什么）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 敏感信息拦截 | `auditAndSend()` / `SENSITIVE_RE` / `assertOutboundAuditOk()` | 回复含本机路径、UNC、凭据赋值形态 → **整条拦截不发**；语音按文件名审计；错误文本、审批理由、工具名同样过审 |
| 会话令牌防外发 | `redactKnownTokensOnly()` + `onebotSend()` | 所有已知 agent token 在发送前脱敏；文本里若仍出现已知令牌则**直接抛错不发** |
| CQ 注入 | `onebotSend()` | 出站文本一律包成 `{type:'text'}` 段并做 `[CQ:` → `[CQ：` 转义，杜绝 CQ 码注入 |
| @ 限制 | `onebotSend()` | `atUserId` 只接受正整数，禁止 `@all` |
| 发送限流 | `socialV2.send.*` / `voice.*` / `sticker.collect.*` | 每分钟/每小时硬上限，超限拒绝并退避 |

### 4. 控制台（本机最高权限入口）

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 只监听回环 | `server.listen(port, '127.0.0.1')` | 永不绑 `0.0.0.0` |
| 令牌门 | 请求最前面 | **所有**路由（读+写）都要 `x-console-token` 或 `?token=`；未配置时启动自动生成 192 bit 随机值 |
| 定长比较 | `crypto.timingSafeEqual` | 比较前先比长度，避免 `!==` 短路带来的时延侧信道 |
| Host 校验 | 请求最前面 | Host 必须是 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，否则 403（DNS rebinding 硬化） |
| CSRF | 非 GET 请求 | 必须 `content-type: application/json`；若带 `Origin`，其 host 必须等于本机 |
| agent 令牌隔离 | 请求前缀白名单 | 带 `x-agent-token` 的请求默认拒绝，仅放行 `/api/status`、`/api/socialV2/*`、`/api/send/*`、`/api/images/*`、`/api/authorize/read`；管理端点（人格/提示词/思考强度/白名单/重启/令牌）一律 403 |
| 空令牌拒绝 | `x-agent-token === ''` | 一律 403，避免"空 = 管理端"的绕过 |
| 写操作不挂 GET | 全路由审查 | 会触发副作用的接口（表情强制同步、语音同步）一律 POST；GET 只读 |
| 请求体限制 | `readBody()` | 声明长度或实际累计超过 1 MB → 413；30 秒读取超时 |
| 安全响应头 | 全部响应 | `X-Frame-Options: DENY`、CSP、`nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store` |

### 5. 秘密与落盘

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 原子写 | `atomicWriteJson/Text()` | 唯一随机临时名 + rename（Windows EPERM 退避重试），不会写坏配置 |
| Windows ACL 收紧 | `hardenStateDirAcl()` + `scripts/harden-state-acl.mjs` | Windows 上 `mode: 0o600` 是**空操作**，因此启动时切断 `state/` 的继承链，只保留当前用户/SYSTEM/Administrators。改 ACL 需要 WRITE_DAC —— **目录属主通常本来就有，所以一般不弹 UAC**；失败时用 `Start-Process -Verb RunAs` 提权重试一次（`--elevated` 短路自身，杜绝递归），再失败就打印可复制命令并**以 0 退出、绝不阻断启动**。控制台「访问与安全」页显示告警条与「重新检测」按钮 |
| 令牌不回显 | 日志/活动/工具日志 | 控制台令牌只打前 6 位；活动日志与工具调用参数过 `redactSensitiveText` / `redactSensitive`（递归处理 JSON 字符串叶子） |
| 令牌只发回环 | `dsh-client.ensureAuth()` | DSH launch token 换 Cookie 时必须放进 URL，因此**默认拒绝非回环 baseUrl**；远程部署需显式 `dsh.allowRemote: true` |
| 路径校验（读点） | `roleRawContent()` 等 | 人格名在**读取点**也做 `sanitizeRoleName` + `path.resolve` 包含性校验（`state/current-role.json` 是用户可直接编辑的文件） |
| 原型污染 | 记忆写入/加载 | `__proto__` / `constructor` / `prototype` 键在写入与加载两侧都被拒绝；配置合并用对象展开（不触发 setter） |

### 6. 与 DSH 沙箱的 ACL 交互（DSH 0.2.0 起；**这是有意的取舍，不是缺陷**）

DSH 的 Windows 文件沙箱按**能力 SID** 授权：SID 由 `sha256(规范化工作区路径)` 派生
（形如 `S-1-4-<a>-<b>`；同一个工作区路径每次会话派生出同一个 SID，**重命名工作区会换一个**），
沙箱进程跑在 `WRITE_RESTRICTED` + Low 完整性的令牌里，**写权限要靠工作区根上那条
可继承 ACE 沿继承链传下来**。DSH 只在首次进入工作区时下发一次
（之后有 exact-ACE 跳过，不会重新下发），也从不修改任何对象的保护标志。

由此产生一条必须知道的交互：

| 事实 | 后果 |
| --- | --- |
| `harden-state-acl.mjs` 用 `/inheritance:r` 切断 `state/` 与 `config.json` 的继承链 | 这两处的 DACL 里**没有**能力 SID ⇒ **DSH 沙箱会话写不进去**（EPERM / Access denied），而无沙箱终端完全正常 |
| 这是收紧凭据的**唯一手段**（Windows 上 `mode 0o600` 是空操作） | 取舍明确：**保住凭据不外泄** > 沙箱内可写 |

因此本项目的规矩是：**任何从沙箱里跑的东西都不得写 `state/`**。
测试夹具、探针、self-test 的临时产物一律落在系统临时目录
（见 `scripts/probe-auth.mjs` 的 `probeWorkspaceDir`）。

诊断：`npm run diagnose:acl` —— 只读扫描，列出全部被切断继承的路径并分成
「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类。

> ⛔ **绝不要用 `/inheritance:e` 去"修好" `state/` 的沙箱写入**：恢复继承会把父目录的
> 可继承 ACE 一起带回来，其中包含 `NT AUTHORITY\Authenticated Users: Modify` 与
> `BUILTIN\Users: ReadAndExecute` —— 那正是收紧时要摘掉的两条，等于把控制台令牌、
> SnowLuma OneBot 令牌与全部 QQ 聊天记录重新开放给本机任何已登录用户。

> ⚠️ 已知的**非预期**收紧（2026-09-29 实测）：`plugins/qq-agent-presets/**` 与
> `plugins/qq-mode-console/**` 的内容也被切断了继承（`plugins/` 自身没有）。
> **本仓库没有任何脚本这么做**，来源不明（手工 icacls 或仓库外工具）。
> 它的副作用是沙箱会话里改不动 L7 守卫（`qq-tool-restrict.mjs`）。
> 这两处不含凭据，恢复继承不涉及泄密风险 —— 是否恢复由使用者决定（`npm run diagnose:acl`
> 会打印命令）。`state/` 不在此列。

### 7. 网络

`src/safe-fetch.js`（仅暴露给 agent 的只读联网）：

- 只允许 `http` / `https`；拒绝 URL 内嵌凭据；拒绝 `file:` / `gopher:` 等 scheme
- 解析出的**每一个** DNS 结果都要过私有地址判定（含 IPv4-mapped IPv6、NAT64、6to4、ULA、link-local、zone-id、十进制/八进制/十六进制 IPv4）
- **连接到已校验的 IP**，同时保留原 `Host` 与 TLS SNI ⇒ 关闭 DNS rebinding 的检查-连接间隙
- 每一跳重定向都重新校验，最多 5 跳，重定向响应体立即销毁
- 响应体大小与图片像素上限；图片按 magic number 校验
- 不读取任何代理环境变量（不存在 `HTTP_PROXY` 绕过）

---

## 三、已知残余风险（明确不修 / 修不了，必须让用户知道）

| # | 风险 | 现状与缓解 | 为什么不修 |
| --- | --- | --- | --- |
| R1 | **敏感信息审计是启发式的** | 能抓"带赋值关系的凭据"和本机路径；抓不到任意形态的秘密 | 通用秘密检测无法在没有密钥的情况下做对；硬边界在白名单与工具面，审计是兜底 |
| R2 | **`state/` 里的令牌是明文** | Windows 已用 ACL 收紧；Linux 用 `0700` | 引入凭据库/DPAPI 会显著提高部署门槛，列为 QSH 里程碑 M2 的候选（口令派生已规划） |
| R3 | **贴纸备注跨会话共享** | 只有注入路径做了加固，未做会话隔离 | 单一账号的贴纸库本就是全局的；多群互害场景很少 |
| R4 | **远程停止不是原子的** | `session/control` + `updateQueue` + `cancel` 是尽力而为，已执行的工具副作用无法回滚 | DSH 协议没有事务语义 |
| R5 | **离线队列不保证送达** | 每会话最多 50 条，进程退出即丢 | 一致性代价过高；README 已写明 |
| R6 | **预设不变量检查是子串存在性** | 防误删，不防恶意 | 能改这个文件的人本来就是管理员，真正的硬边界在工具守卫与白名单 |
| R7 | **`self-test.js` 只证明链路通** | 不做断言 | 它是连通性探针，不是回归套件（回归在 `npm run test:audit`） |
| R8 | **单人维护、无外部安全审计** | 有离线回归 + 本文档 | 计划在 QSH v1.0 发布前做一次外部/对抗式复审 |
| R9 | **`state/` 的 ACL 收紧可能失败**（未提权且目录属主权限被策略收走时） | `scripts/harden-state-acl.mjs` 会自动提权重试一次；仍失败则明确告警 + 给出可复制命令 + 控制台告警条 | 改 ACL 属于需要特权的操作；**降级为"明确告警"而不是"阻断启动"**是刻意的取舍（否则用户会为了能启动而关掉整条安全链路）。QSH M2 会用口令派生 + HttpOnly Cookie 把最敏感的控制台凭据从明文落盘里拿掉 |
| R10 | **收紧 `state/` 后，DSH 沙箱会话写不进 `state/`**（见 §2.6） | 有意取舍，非缺陷；诊断见 `npm run diagnose:acl` | 两者不可兼得：能力 SID 只能靠继承下发，而切断继承正是防"本机其他用户读令牌"的唯一手段。**代价已被接受并写进文档**，项目自己的测试夹具/探针据此改用系统临时目录 |
| R11 | **`plugins/**` 内容被意外切断继承，沙箱里改不动 L7 守卫** | 来源不明（本仓库无此脚本）；`npm run diagnose:acl` 会列出并打印恢复命令 | 该处不含凭据，恢复继承无泄密风险；但若不恢复，被沙箱约束的 DSH agent 就无法维护工具守卫 —— 需要人工在无沙箱终端改 |

---

## 四、发布前必须跑的检查（回归清单）

```bash
npm run test:audit          # 30 个离线回归脚本（含安全专项），必须全绿
npm run verify:adaptation   # DSH 适配一致性（preset/工具守卫/MCP 挂载/活 DSH 实测）
npm run verify:persona      # 人格配置一致性
npm run diagnose:acl        # ACL 收紧路径盘点（只读；需在**无沙箱**终端跑，见 §2.6）
npm run scan:tool-names     # 守卫名单 vs 已安装 DSH 的真实工具名（每次升级 DSH 后跑）
node --check src/bridge.js  # 语法门禁（大文件改动后必跑）
```

安全专项必须覆盖（缺一不可）：

- [x] 白名单/黑名单/空白名单 fail-closed（含单复数与字符串/数字两种写法）
- [x] `closed-agent` 只对 `private:<ownerQQ>` 放行；模式切换会退役旧会话
- [x] 预设清单不可用时**拒绝**建群聊会话（不回退到默认预设）
- [x] agent token 无法访问任何管理端点；空 agent token 被拒
- [x] 控制台伪造 `Host` 被拒；错令牌（含错长度、大小写、尾空格）被拒
- [x] `/api/authorize/read` 空令牌被拒
- [x] agent 令牌只能读自己会话；跨会话读返回 403
- [x] 语音只能取语音库内的文件（含 `allowAbsolutePath=true` 与相对穿越两种情形）
- [x] 出站文本命中敏感信息时整条拦截；含已知会话令牌时直接抛错
- [x] SSRF：scheme、URL 凭据、私有 IP、重定向、超时、大小限制（11 项）
- [x] 桥接 `200 + {ok:false}` 会被 MCP 当作失败上报（不产生静默假成功）
- [x] 旧只读工具在非 `closed-agent` 模式下 fail-closed
- [x] `state/` ACL 助手：非阻断、防递归、`start.bat` 纯 ASCII+CRLF 且先于桥接调用（**结构级断言**）
- [ ] **`state/` ACL 的真实 icacls/UAC 行为**：需在普通终端手动复跑 `node scripts/harden-state-acl.mjs` 确认（沙箱/CI 里改 ACL 会被拒，无法自动化）

---

## 五、改动检查单（每个 PR 自问）

1. 这次改动有没有让某个"不确定"变成"放行"？（违反 fail-closed 即阻断）
2. 有没有新增一个**只有控制台该用**的端点却没进 agent 白名单的默认拒绝？
3. 有没有新增读写文件的路径参数？它是否做了包含性校验与 realpath？
4. 有没有把外部数据（QQ 内容、文件名、配置值）直接插进 HTML / 日志 / 提示词？
5. 新增的定时器、Map/Set、监听器，在会话退役与进程退出路径上都清理了吗？
6. 是否更新了对应的测试与本文档？
