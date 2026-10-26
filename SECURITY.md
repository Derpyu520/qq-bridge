# 安全策略

## 报告问题

**不要开公开 issue。** 请用 GitHub 的
[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库页 → Security → Report a vulnerability），或在仓库主页找到维护者联系方式私下发。

请附：影响版本、复现步骤、最小 PoC、你判断的影响面（是否能远程触发、是否需要 owner 权限）。
我们会在确认后 7 天内回复处理计划。

## 支持范围

| 在范围内 | 不在范围内 |
| --- | --- |
| 桥接进程的鉴权绕过（控制台 token、agent token、会话 key 伪造） | 你自己把控制台端口暴露到公网 |
| 白名单/模式绕过导致的越权发送 | QQ 账号本身被盗、SnowLuma 自身的漏洞 |
| MCP 工具面的提示词注入导致越权动作 | 模型被诱导说出不当内容（属内容策略） |
| 路径穿越（语音库、媒体库、头像目录） | 你手动改 `state/` 或 `config.json` 造成的问题 |
| SSRF（资料/头像/空间抓取、联网搜索） | 第三方依赖未修复的漏洞（请同时上游报告） |

## 默认安全设计（改代码前先读）

- **默认拒绝**：`config.allow` 为空时，除非显式 `allowAllWhenEmpty: true`，否则不处理任何会话。
- **控制台只监听本机**：`consolePort` 默认 3100，`consoleToken` 必须自己设置；不要把端口映射到公网。
- **agent token 每会话独立**：工具调用必须带会话 token，换会话不能复用。
- **MCP 只暴露安全子集**：QQ 动作全部走桥接进程内的白名单与权限闸门，DSH 侧拿不到原始 OneBot 通道。
- **管理员动作三档**：`none`（不开放）/ `request`（仅应要求，其他人要求走确认卡）/ `persona`（人设自主，可被 `persona_veto` 驳回）。
- **出站收敛**：资料/头像只从固定域名抓；搜索走固定 API；本地文件只允许 `state/`、`audio/`、`media/`、`assets/` 白名单目录，并做 realpath 复核。
- **凭据只在本机**：`config.json` / `state/` 不入库；Windows 上 `state/` 用 ACL 收紧（`npm run harden-acl`）。

完整威胁模型与已知风险见 [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md)。

## 部署建议

- 桥接、DSH、SnowLuma 都只监听 `127.0.0.1`；需要远程访问请走 SSH 隧道或反向代理 + 鉴权。
- 控制台 token 用随机长串；`config.json` 权限设成仅当前用户可读。
- 公网部署前先读 [docs/guides/PRIVACY.md](docs/guides/PRIVACY.md) 与 `RULES.md`。
