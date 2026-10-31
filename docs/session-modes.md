# 按会话的三种状态

控制台会话列表可切换 normal / muted / blocked。管理接口为 `POST /api/session/mute`，JSON 参数为 `{ "key": "group:456", "mode": "muted" }`，仅控制台可调用。无效 mode 返回 400。

- normal：按现有白名单和模式调度。
- muted：消息与拍一拍仍进入有界 recent/unread 缓冲，记录一行活动日志；不执行聊天中的管理命令、不回答挂起问题、不启动黑话学习，不新增模型投递或 AI 出站。
- blocked：消息和拍一拍在解析、入库和活动记录前丢弃。

进入 muted / blocked 会清除待执行的普通队列与二代唤醒定时器；异步创建会话或解析媒体结束后也会再次校验。已被 DSH 接受的推理无法通过此开关收回费用，其后续 AI 回复受发送守卫拦截。

恢复 normal 会重建已有有限睡眠和主动机会计划，不逐条回放历史消息；首次唤醒未真正投递时仍可在下一条消息触发 bootstrap。取消的唤醒回滚额度和有限睡眠状态。静默期间缓冲仍受 `socialV2.context.unreadLimit`（默认 30）等现有上限约束，不保证永久保存聊天全文；恢复后的正常唤醒可能看到缓冲内的静默历史。

配置存储仍为 `state/session-modes.json`，使用 atomicWriteJson。此功能独立于全局角色 silent 模式和全局 AI 暂停。

管理员私聊也遵循相同语义：设为 muted / blocked 后，QQ 内的 /silent、/active、其他管理命令以及审批/提问回答都不会处理。请在控制台“会话与审批”的状态下拉中恢复为“正常”；QQ 的 /active 是全局角色开关，不能解除按会话静默。
