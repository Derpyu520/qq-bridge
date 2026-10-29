@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup.
node scripts\harden-state-acl.mjs --quiet
rem 自检：DSH profile 里必须有 snowluma MCP 条目。装/更新插件会重写 profile，
rem 冲掉之后模型调用 qq_* 工具会变成 unknown tool，群里就发不出话。
node scripts\check-dsh-mcp.mjs >nul 2>&1
if errorlevel 1 (
    echo [start] profile 缺少 snowluma MCP 条目，自动重新注册...
    node scripts\setup-dsh.mjs desktop
)

rem 等待 DSH 就绪：开机自启时桥接可能比桌面版先跑。没等到就只会连旧端口，一直重试。
rem 最多等 5 分钟，超时也继续（用户可能暂时不开 DSH），之后重启桥接即可。
set /a tries=0
:waitdsh
node scripts\detect-dsh-port.mjs --require >nul 2>&1
if not errorlevel 1 goto loop
set /a tries+=1
if %tries% GEQ 60 (
    echo [%date% %time%] 等待 DSH 超时（5 分钟），先启动桥接；DSH 起来后重启桥接即可。
    goto loop
)
ping -n 6 127.0.0.1 >nul
goto waitdsh

:loop
rem DSH desktop picks a fresh local port on every launch; re-point config.json
rem at the live one. Never blocks startup: on failure the old baseUrl is kept.
node scripts\detect-dsh-port.mjs
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
ping -n 6 127.0.0.1 >nul
goto loop