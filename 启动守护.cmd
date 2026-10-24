@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 qq-bridge guard...
echo 这个窗口不要关，关了 guard 就停了。
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0guard.ps1"
echo.
echo guard 已退出，按任意键关闭窗口。
pause >nul
