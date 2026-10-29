# 开机自启与 SnowLuma 的 hook

## 任务清单（登录触发）

| 任务 | 动作 |
| --- | --- |
| `dsh-desktop` | 直接运行 `D:\Program Files\deepseek\DeepSeek Harness.exe` |
| `SnowLuma` | `cmd /c start-hook.bat`（工作目录 `D:\Program Files\SnowLuma-v2.0.3-win-x64`） |
| `qq-bridge` | `cmd /c start.bat`（工作目录 `D:\dev\fatfishbot`） |

## 关键点：`SNOWLUMA_HOOK_AUTOLOAD=1`

SnowLuma 只有开启 hook 自动加载，才会把原生模块注入到已登录的 QQ 进程；注入成功后才会监听
OneBot 的 3000/3001。它的配置项在 `config/runtime.json` 的 `hookAutoLoad`，但**优先读环境变量**
`SNOWLUMA_HOOK_AUTOLOAD`。

所以计划任务不能直接 `node.exe index.mjs`，必须经过 `start-hook.bat`：

```bat
@echo off
cd /d "%~dp0"
set SNOWLUMA_HOOK_AUTOLOAD=1
node.exe index.mjs
```

症状：QQ 明明在线，但 `3000/3001` 不监听，启动器一直提示 "OneBot 还没起来"。
原因就是任务没带这个环境变量，SnowLuma 认为不需要自动注入。

## 排查顺序

1. `netstat -ano | findstr ":3000 .*LISTENING"` 有没有输出
2. SnowLuma 日志 `logs\snowluma-<date>.log` 里有没有 `[OneBot] listening`
3. `schtasks /end /tn SnowLuma` → `schtasks /run /tn SnowLuma`，等 20 秒再看 3000/3001
4. 还是不行：确认 QQ 已登录的是机器人账号 2829202658（不是小号），必要时重启 QQ
## 已知坑：装/更新插件会冲掉 MCP 条目

在桌面 profile 上安装或更新插件（例如 `@tencent-connect/dsh-qqbot`）时，DSH 会重写
`~/.dsh/profiles/desktop/cordis.patch.yml`，把 `setup-dsh.mjs` 写进去的 3 个 MCP 条目
（`mcp-snowluma` / `mcp-snowluma-host` / `mcp-web-search-safe`）冲掉。

症状：QQ 里 @ bot 没反应；`bridge.log` 只有「AI 内部输出（不自动转发）」，没有
「工具统一发送 … 成功」。DSH 会话日志里能看到：

```
Error: unknown tool "mcp__snowluma__qq_send_message"
```

修复：

```powershell
cd D:\dev\fatfishbot
node scripts/setup-dsh.mjs desktop
```

`start.bat` 现在会在启动时跑 `scripts/check-dsh-mcp.mjs` 自检，缺条目就自动重新注册。
`bridge.js` 也会在检测到 unknown tool 时私聊提醒 ownerQQ（10 分钟一次）。