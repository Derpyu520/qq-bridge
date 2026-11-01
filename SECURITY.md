# 安全策略

qq-bridge 会接触本机 OneBot 接入令牌、DSH 会话 Cookie 与控制台令牌，
并把群聊内容交给大模型处理。**请按"能读你账号"的标准对待本程序的任何权限缺口。**

---

## 报告漏洞

**不要在本仓库公开 issue 里贴漏洞细节、可用 PoC、token 或真实 QQ 号/群号。**

请用 GitHub 的私密漏洞上报：

> <https://github.com/Derpyu520/qq-bridge/security/advisories/new>

在这个页面里写清楚：影响版本、复现步骤、影响面（能读到什么/能做什么）、以及你建议的修法（如果有）。
不要求你先写好补丁。

如果你不确定某个问题算不算漏洞，**也走这个渠道问**，比开公开 issue 好。

## 响应方式（据实说明）

这是一个单人维护的项目。**没有 SLA、没有 72 小时承诺**。承诺只有一条：
只要报告有效，修完之后会在 release notes 里写明，并在 advisory 里登记你的贡献（除非你要求匿名）。

- 受支持版本：**最新一个 release 线**（当前 `v0.2.1-rN`）。更早的版本只做"是否受影响"的确认，不单独发补丁。
- 已公开讨论过、上游已有 CVE 的依赖问题：走 Dependabot，不必单独上报。

---

## 明确在范围内（In scope）

| 类别 | 例子 |
| --- | --- |
| **凭据泄漏** | token / Cookie / 签名密钥出现在日志、错误信息、模型上下文、控制台响应或返回值里（CWE-532） |
| **权限提升** | 未带 `x-agent-token` 的假智能体调用被当成管理端全权（confused deputy）；控制台鉴权 fail-open |
| **SSRF / 内网探测** | `web_fetch`、`safe-fetch`、`web_search` 能访问私网/回环/云元数据地址，或跟随重定向绕过校验 |
| **铁律 L7 被突破** | QQ 会话的 agent 拿到了本地执行能力（shell / 文件读写 / 插件装载 / 子进程），见 [RULES.md](RULES.md) |
| **越权访问会话** | 一个群/私聊能读到另一个会话的消息、记忆或状态；`/api/status` 之类把 ownerQQ、白名单、其它群活动回给模型 |
| **路径穿越 / 任意写** | 语音库、上传、控制台静态资源、`state/` 写入相关的路径处理 |
| **提示注入导致的真实副作用** | 群友一句话就能让 agent 改配置、绕过白名单、往外发消息或读本机文件 |
| **依赖供应链** | 依赖本身被投毒，或 `postinstall` 补丁被利用（见 [NOTICE.md](NOTICE.md)） |

## 不在范围内（Out of scope）

- **SnowLuma / QQ 客户端本身的问题**（注入失败、闪退、账号风控）——那是上游项目，请报给 [SnowLuma](https://github.com/SnowLuma/SnowLuma)。
- **错误配置白名单，或显式启用 `allowAllWhenEmpty`** 导致的不安全开放——这是配置问题，见 [RULES.md](RULES.md)。
- 需要"攻击者已经能改本机文件/已有管理员权限"才能触发的场景。
- 缺少安全响应头、缺少 HTTPS、没有 `helmet` 之类的加固建议（本程序默认只监听 `127.0.0.1`）。
- 已由 Dependabot 登记、且**未被本程序实际调用路径触达**的依赖告警——欢迎说明为什么可达，那会升级为有效报告。

---

## 部署侧的硬要求（这些不满足就不是"漏洞"，是误配）

1. 控制台令牌、`config.json`、`state/` **不要**放到对 `BUILTIN\Users` 可读的位置（本程序启动时会尝试收紧 ACL，见 `src/state-acl.mjs`）。
2. **白名单必配**。默认空白名单拒绝所有会话；只有显式设置 `allowAllWhenEmpty: true` 才会在空白名单时开放，该配置应谨慎使用。
3. 不要把 DSH 的控制台或桥接端口暴露到公网。

---

## English summary

This project handles local OneBot access tokens and DSH session cookies. Please
report security issues **privately** via
[GitHub Security Advisories](https://github.com/Derpyu520/qq-bridge/security/advisories/new) —
never in a public issue, and never with live tokens or real QQ numbers.

In scope: credential leakage, privilege escalation (confused deputy / auth bypass), SSRF, breaking the
"no local execution in QQ sessions" invariant (L7), cross-session data access, path traversal, and
prompt-injection with real side effects. Out of scope: upstream SnowLuma/QQ client bugs, and unsafe
operator configuration such as enabling `allowAllWhenEmpty` or exposing local services publicly.

This is a single-maintainer project: **no SLA**. Valid reports are fixed and credited in release notes.
