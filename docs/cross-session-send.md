# 跨会话文本发送

这会扩展智能体的发送权限，默认关闭。读取、等待、标读、记忆和唤醒配置仍绑定原会话。

```json
{
  "socialV2": {
    "allowCrossSessionSend": false,
    "allowAnySessionToOwner": false,
    "allowOwnerToWhitelist": true,
    "crossSessionSendPerHour": 20,
    "crossSessionSendGlobalPerHour": 100
  }
}
```

开启总开关后，默认仅 owner 私聊可向白名单目标发送；非 owner 会话向 owner 发送还需显式设置 `allowAnySessionToOwner: true`。来源与目标都必须仍被当前模式和白名单允许。开关只接受布尔值。

仅 `/api/send/group`、`/api/send/private`、`/api/socialV2/send-message`、`/api/socialV2/send-burst` 可使用此授权；每条正文添加桥接生成的 `【来自 group:…】` 或 `【来自 private:…】`。活动日志标注来源、目标和授权尝试条数，控制台以红色显示。标记是来源说明，不代表 owner 认可内容。语音、表情、拍一拍仍禁止跨会话。跨会话不支持引用目标消息（包括 `/api/send/reply`），因为引用解析会把目标聊天原文回传给来源会话；同会话引用不受影响。

DSH 的 SELF_KEY 执行期绑定保持不变：参数含 `key` 的工具仍只能填本会话 key；实际跨会话代发使用 `qq_send_private_message`、`qq_send_group_message` 等不改变 SELF_KEY 的文本工具。HTTP 端点回归不等于真实 DSH 端到端验收。

限频按来源及全局的一小时滚动窗口计算，批量请求按正文条数预占。记录通过 atomicWriteJson 写入 `state/cross-session-send-times.json`，重启不会清零；记录损坏或无法写入时拒绝跨会话。授权判断不扣额度；工具开关、目标静默、正文长度和目标发送频率等本地校验通过后、首次出站前才预占。预占后网关失败或等待期间权限变化不退还额度。额度耗尽返回 HTTP 429 / CROSS_SESSION_RATE_LIMIT；记录损坏或不可写返回 HTTP 503 / CROSS_SESSION_RATE_STORE_UNAVAILABLE，令牌或权限拒绝仍为 403。0 表示禁用；来源上限最多 1000，全局最多 10000，历史表随请求清理过期记录并受此上限约束。限频是发送尝试额度，不是成功送达统计。

分条排队期间每条实际出站前重新检查来源令牌、白名单、模式与开关。已经提交给网关的消息无法撤回。

升级兼容：旧版“不配置即开启”改为显式开启；依赖两个方向的实例应在自己的配置中明确写入三个开关为 true，并设置适合自己的限频。仅修改示例不会迁移现有配置。

`/api/send/group` 和 `/api/send/private` 一次发送一条正文，超过 maxMessageChars 时直接拒绝，不会自动分条；send-message / send-burst 按正文数组条数计额。

限频记录损坏后的恢复由操作者处理：先停止桥接，保留故障文件备份并检查磁盘/权限，再恢复可信的有效记录后重启。没有可信记录时，应先停用跨会话至少一小时，让旧窗口过期，再备份故障文件并以有效空数组初始化后重启。不要在机器人运行中删除记录来反复重置配额；当前没有智能体可调用的清除接口。
