@echo off
chcp 65001 >nul
cd /d "%~dp0"
title FatFish Bot 启动器
echo ============================================================
echo   FatFish Bot 一键启动
echo   DSH  -^>  SnowLuma  -^>  qq-bridge
echo ============================================================
echo.

rem ── 1) DSH 桌面版 ────────────────────────────────────────────
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness.exe" >nul
if errorlevel 1 (
    echo [1/3] 启动 DSH ...
    start "" "D:\Program Files\deepseek\DeepSeek Harness.exe"
    echo       等待 DSH 初始化 25 秒 ...
    ping -n 26 127.0.0.1 >nul
) else (
    echo [1/3] DSH 已在运行
)

rem ── 2) SnowLuma（OneBot 网关）───────────────────────────────
call :check_port 5099
if errorlevel 1 (
    echo [2/3] 启动 SnowLuma ...
    schtasks /run /tn "SnowLuma" >nul 2>&1
    call :wait_port 5099 40
    if errorlevel 1 (echo       SnowLuma 启动超时，请看它的窗口) else (echo       SnowLuma 就绪)
) else (
    echo [2/3] SnowLuma 已在运行
)

rem ── 3) qq-bridge ─────────────────────────────────────────────
call :check_port 3100
if errorlevel 1 (
    echo [3/3] 启动 qq-bridge ...
    schtasks /run /tn "qq-bridge" >nul 2>&1
    call :wait_port 3100 30
    if errorlevel 1 (echo       桥接启动超时，请看 state\bridge.log) else (echo       桥接就绪)
) else (
    echo [3/3] qq-bridge 已在运行
)

echo.
echo ---------------- 当前状态 ----------------
call :check_port 5099 && echo   SnowLuma      OK   http://127.0.0.1:5099
call :check_port 3000 && echo   OneBot HTTP   OK   127.0.0.1:3000
call :check_port 3001 && echo   OneBot WS     OK   127.0.0.1:3001
call :check_port 3100 && echo   Bot 控制台    OK   http://127.0.0.1:3100
echo.
echo 日志：state\bridge.log    出图：state\images\
echo 停止：双击 stop-all.bat
echo.
pause
exit /b 0

:check_port
netstat -ano | findstr /R /C:":%1 .*LISTENING" >nul
exit /b %errorlevel%

:wait_port
set /a n=0
:wait_loop
call :check_port %1
if not errorlevel 1 exit /b 0
set /a n+=1
if %n% GEQ %2 exit /b 1
ping -n 3 127.0.0.1 >nul
goto wait_loop