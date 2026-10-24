@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0guard.ps1" %*
echo.
echo guard exited. Press any key to close this window.
pause >nul
