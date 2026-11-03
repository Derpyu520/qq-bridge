# Code scanning 核查（2026-10-31）

核查对象：GitHub CodeQL 在 `main`、提交 `17c5313` 上报告的 **14 条 open 告警**。以下风险判断来自实际代码与调用边界，不直接以扫描等级代替可利用性判断。

## 处理结论

| 告警 | 扫描等级 | 实际情况 | 本地处理 |
| --- | --- | --- | --- |
| [#3](https://github.com/Derpyu520/qq-bridge/security/code-scanning/3)～[#7](https://github.com/Derpyu520/qq-bridge/security/code-scanning/7)：定时器资源耗尽 | High，共 5 条 | 值得修复。部分配置只有下限，没有有限数与上限校验；超出 Node 定时器范围时会退化为约 1ms，周期任务可能反复触发。主要来源是本地配置及管理员接口，不是任意群聊直接指定延迟。 | 在实际调度点限幅；普通延迟上限 24 小时，批量唤醒上限 1 小时；周期任务保留最小间隔。 |
| [#9](https://github.com/Derpyu520/qq-bridge/security/code-scanning/9)、[#10](https://github.com/Derpyu520/qq-bridge/security/code-scanning/10)：命令行注入 | Critical，共 2 条 | 应收紧配置边界。管理员 HTTP 接口可以修改 `voice.ffmpegPath`，但该接口已有控制台鉴权，AI 令牌不可访问；底层使用 `spawn(program, args)`，没有 shell 拼接。现有证据不足以认定为群聊可触发的远程命令注入。 | HTTP 提交 `voice.ffmpegPath` 返回 400，整次修改不落盘；程序路径只接受本地配置或环境变量，其他语音设置仍可保存。 |
| [#11](https://github.com/Derpyu520/qq-bridge/security/code-scanning/11)：错误信息泄露 | Medium，1 条 | 值得加固。多条异常消息直接进入 HTTP 响应，可能包含本机路径或上游详情；未发现群聊直接读取原始堆栈或本机日志的接口。 | 动态 5xx 错误改为固定提示，详情保留在本机日志；保留 4xx 校验提示、受控的 503 状态说明。 |
| [#1](https://github.com/Derpyu520/qq-bridge/security/code-scanning/1)、[#2](https://github.com/Derpyu520/qq-bridge/security/code-scanning/2)：敏感日志 | High，共 2 条 | 测试语境误报。实际打印的是无令牌请求的数字 HTTP 状态码，没有打印令牌或响应正文。 | 去掉断言的动态状态码附加日志，保留原断言。 |
| [#12](https://github.com/Derpyu520/qq-bridge/security/code-scanning/12)～[#14](https://github.com/Derpyu520/qq-bridge/security/code-scanning/14)：HTML 过滤正则 | High，共 3 条 | 测试语境误报。正则用于提取本地 HTML 中的脚本做语法检查，不承担不可信 HTML 的安全过滤。 | 提取正则增加大小写兼容，支持大写 `SCRIPT` 标签。 |
| [#8](https://github.com/Derpyu520/qq-bridge/security/code-scanning/8)：URL 子串校验 | High，1 条 | 仅存在于媒体测试的模拟抓取器，生产请求另经 SSRF 防护；不是生产域名校验漏洞。 | 模拟抓取器改为解析 URL 并精确比较 `hostname`，消除含糊匹配。 |

## 验证与行为变化

新增离线回归 [`test-code-scanning-boundaries.mjs`](../../scripts/test-code-scanning-boundaries.mjs)，已加入 `npm run test:audit`，覆盖：

- 正常配置默认值，以及超大数、非有限数、非法字符串和递归定时调度。
- 临时 HTTP 服务拒绝修改可执行路径，且保留本地设置与其他可编辑的语音选项。
- 动态 5xx 与嵌套转发预览中的异常不向客户端返回路径或堆栈，诊断详情仍可从本机脱敏日志查看。
- 校验提示、DSH 离线提示、语音限流的 429 重试说明，以及发送失败后的额度回滚仍然有效。

验证结果：`npm run test:audit` **55/55 个脚本通过**；语法检查、`git diff --check` 与工作树隐私扫描（含新增文件）通过。

本轮会改变四项行为：超范围延迟被收敛（零值仍沿用原默认间隔）；HTTP 不再接受 `ffmpegPath` 字段；动态 5xx 与嵌套预览异常详情需查 `state/bridge.log`；语音超频明确返回 429。未连接真实 QQ / DSH，也未向任何会话发送消息。

## 扫描状态

本记录覆盖本轮 `dev` 修复，未手动 dismiss GitHub 告警。离线回归不能替代 CodeQL 复扫；需在 `dev` 上验证扫描结果，正式发布到 `main` 后再确认其告警状态。

若扫描仍报告测试脚本或受控管理员配置，需继续核对新结果的数据流，再决定修正或按实际原因标记，不能仅为了清零告警批量忽略。

## 后续复核（2026-11-01）

发布 PR 复扫新增 #15，仍指向 `sleep()` 的自定义限幅辅助函数。确认所有延迟均经
`boundedTimerDelay()` 限制为有限范围，且异常值回归覆盖后，已按证据单独标记为误报；
未做批量 dismiss。`v0.2.1-r2` 发布前离线回归为 57/57，PR 与 `main` 的 CI、CodeQL 均通过。
