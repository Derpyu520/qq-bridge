# qq-bridge guard

`guard.ps1` / `guard.cmd` 是 qq-bridge 的轻量守护脚本，只负责 **qq-bridge 本体**，不安装、不启动、不控制 SnowLuma。

## 做什么

- 每 20 秒检查一次：
  - `node src/bridge.js` 进程
  - `state/bridge.lock` 里的 PID 是否还活着
  - 控制台端口 `3100` 是否在监听
- 三者都没有时，重新运行 `start.bat`。
- 清理 PID 已失效的 `state/bridge.lock`，避免新实例被旧锁挡住。
- 探测 SnowLuma 的 `3000` / `3001` / `5099`，只写日志：
  - OneBot 没就绪 → `WARN`
  - SnowLuma 完全没运行 → `ERROR`，提示你手动开 `launcher.bat`
- 日志写到 `state/guard.log`，超过 5 MB 自动切成 `guard.log.1`。
- 用 `state/guard.lock` 保证只有一个 guard 在跑。

## 为什么不守护 SnowLuma

SnowLuma 是第三方运行时，仓库的 `README.md` / `LICENSE` 明确写了桥接只探测、不部署（EULA §5.4）。所以 guard 不会自动启动 SnowLuma；它只在日志里告诉你 3000/3001 没起来。

## 用法

双击：

```text
qq-bridge\guard.cmd
```

或手动：

```powershell
cd D:\Documents\deepseek-harness\default-workspace\qq-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\guard.ps1
```

常用参数：

```powershell
# 30 秒检查一次
.\guard.ps1 -IntervalSec 30

# 只看一次状态，不启动任何东西
.\guard.ps1 -Once -ProbeOnly

# 不检查 SnowLuma 端口
.\guard.ps1 -NoSnowLuma
```

## 开机自启

把 `guard.cmd` 的快捷方式放进：

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

或者用任务计划程序，触发器选“登录时”，操作指向 `guard.cmd`，起始目录填 `qq-bridge` 目录。

## 注意

- 不要同时开多个 guard；第二个会直接退出。
- `start.bat` 自己已经在“桥接崩溃 → 5 秒后重启”的循环里；guard 是第二层，负责 `start.bat` 窗口被关掉、机器重启后没起来等情况。
- 如果 guard 是从 DSH 的沙箱终端里启动的，子进程可能被沙箱拦截（`spawn EPERM`）。请直接双击 `guard.cmd`，或在普通 PowerShell 窗口运行。
