@echo off
chcp 65001 >nul
cd /d "%~dp0"
title qq-bridge 大肥鱼

rem ── 为什么有这一行 ────────────────────────────────────────────────────────
rem DSH（DeepSeek Harness 桌面版）每次启动都换随机端口（5033 → 9782 → 5744 …），
rem 而本桥接的 dsh.baseUrl 只能写死一个值。端口一变，桥接就连不上 DSH，
rem 表现为「QQ 里发消息，机器人没反应」。
rem dsh-port-mapper.py 每 15 秒看一次 DSH 真正在监听的端口，变了就改写 config.json。
rem 用 PowerShell 起它（隐藏窗口），本窗口留给桥接本身；桥接重启时它会重读新的 baseUrl。
rem 退出：任务管理器里结束 python.exe，或跑 qq-bridge\stop-port-mapper.bat。
rem ─────────────────────────────────────────────────────────────────────────

powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath 'python' -ArgumentList '-X','utf8','\"%~dp0dsh-port-mapper.py\"'" >nul 2>&1

rem 安全加固 state/ 权限（拿不到权限也不会挡住启动）
node scripts\harden-state-acl.mjs --quiet

:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] 桥接已在另一个窗口运行，本窗口退出。
    pause
    exit /b 2
)
echo [%date% %time%] 桥接退出（code %code%），5 秒后重开…
timeout /t 5 /nobreak >nul
goto loop