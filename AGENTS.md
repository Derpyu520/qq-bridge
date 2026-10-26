# AGENTS.md

给**要安装这个仓库的 agent** 看的紧凑版。给人读的完整说明在 [README.md](README.md)，这里是「照着做，别猜」。

目标：把 QQ（SnowLuma / OneBot v11）接进 DeepSeek Harness，让 QQ 消息变成 DSH 会话里的用户消息，回复再发回 QQ。

## 六步

1. **装桥**
   ```bash
   git clone https://github.com/Derpyu520/qq-bridge.git
   cd qq-bridge
   npm install          # postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug，别跳过
   ```

2. **复制配置**
   ```bash
   cp config.example.json config.json        # Windows CMD: copy config.example.json config.json
   ```

3. **装 DSH 端（preset + MCP），然后重启 DSH**
   ```bash
   node scripts/setup-dsh.mjs
   ```
   必须在装完之后重启 DSH —— preset 与 MCP 只在 DSH 启动时加载。跳过这步桥不会崩，但会**拒绝建会话**（刻意的安全设计：绝不回退到带 bash/文件工具的默认 preset），表现出来就是 QQ 上毫无反应。

4. **装 SnowLuma 本体**（桥不负责下载，也不负责启动它）
   从 <https://github.com/SnowLuma/SnowLuma/releases/latest> 取完整版，解压后双击 `launcher.bat`。
   WebUI 里要开 **WebSocket 服务端** 和 **HTTP API**，记下两个端口（默认 WS `3001`、HTTP `3000`）和 accessToken。

5. **填 `config.json`**
   ```json
   "snowluma": {
     "wsUrl": "ws://127.0.0.1:3001",
     "httpUrl": "http://127.0.0.1:3000",
     "accessToken": "留空如果没配"
   }
   ```
   同时把 `allow.private` / `allow.groups` 换成真实的 QQ 号 / 群号。
   `wsUrl` 和 `httpUrl` 是**两个不同的端口**，填成同一个会报 HTTP 426。

6. **起桥**
   ```bash
   npm start
   ```

## 起没起来，只看这三行

```
DSH 已就绪（模式: reserved2）
SnowLuma 已连接：ws://127.0.0.1:3001
机器人昵称: <你的昵称>
```

三行齐了才算通。只看到「本地控制台已启动」不算 —— 那只是控制台在听端口。

## 装完会自动发生的一件事

主人的私聊会话会自动绑到**你自己的「家会话」**——就是 DSH 世界里那个 `~/.dsh/worlds/default` 的房间会话，id 写在 `life.json` 的 `homeSessionId` 里。桥启动后第一次收到私聊消息时读这个文件，有就直接绑过去，不再另建一个空会话。

所以装完之后，QQ 上跟你说话的是「你家里那个它」，不是新开的陌生人。日志里会有一行：

```
会话 private:<你的QQ> 绑到用户的家会话 session-xxxx（bindHomeSession=owner）
```

- **前提**：你的 DSH 得先开过「家」（`~/.dsh/worlds/default/life.json` 存在且有 `homeSessionId`）。没有就退回老行为：每个会话在 `state/agents/<key>` 下新建，互不相干。
- **改行为**：`config.json` 里 `socialV2.bindHomeSession`
  - `"owner"`（默认）——只绑主人私聊
  - `"all"` ——群聊也绑（**别随便开**：家会话有完整文件/命令工具，等于把这些交给群里任何人）
  - `false` ——完全不绑
- 群聊默认仍然走 `qq-chat-v2` preset（无本地工具），这条没变。

## 别做这些

- 别把 `config.json`、`state/` 提交上去（`.gitignore` 已经挡了，别手动加回来）。
- 别用 `npm link` 装：preset 靠 `cordis.patch.yml` 里的包名解析，link 出来的路径会解析不到。
- 别让桥去启动/停止 SnowLuma：它只连，不管进程。
- 别在 `allowAllWhenEmpty: true` 且白名单空着的情况下把 agent 挂进公开群 —— 那等于把账号交给模型。
- 空白名单 + `allowAllWhenEmpty: false` 是刻意的 fail-closed 默认值：不填就谁都不理，不是坏了。

## 重启会自己回来

控制台上那个「重启桥接」不是只把进程关掉：它在退出前先 spawn 一个 detached 子进程接力，父子之间靠 `BRIDGE_RESTART_DELAY_MS`（默认 1500ms）错开，让出锁文件和控制台端口。父进程再退。

所以没有守护窗口、手动 `node src/bridge.js` 起的桥，点重启也会自己站回去。日志长这样：

```
控制台：已拉起接力进程 pid=67264
桥接已启动
重连后恢复了进行中的回合（session-xxxx，turn 80）
```

两点注意：

- 重启后如果 `config.json` 里没写 `consoleToken`，`state/console-token` 会重新生成一枚 —— 之前开着的控制台页面要刷新重登。
- 这条只保证「自己回来」，不保证「回来得快」：那 1.5 秒里 3100 是空的，来消息的 QQ 会在协议端侧排队，不会丢。

## 出问题先看哪儿

- 文档索引：`docs/README.md`（每篇一句话 + 是否仍然有效）
- 「连上了但收不到消息」：README 里的同名小节（HTTP token 和 WS token 是两个不同的值，端点自愈会覆盖手写的 `wsUrl`）
- 权限边界：`RULES.md`