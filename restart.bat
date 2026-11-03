@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping this checkout's bridge instance (verified PID only)...
node "%~dp0scripts\stop-bridge-instance.mjs"
if errorlevel 1 (
    echo.
    echo Restart aborted: could not prove/stop the old instance. See messages above.
    pause
    exit /b 1
)
start "" cmd /c "%~dp0start.bat"
echo Guard window started.
