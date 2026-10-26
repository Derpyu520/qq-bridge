@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem NOTE: keep this file ASCII-only. cmd parses .bat bytes with the OEM code page,
rem so UTF-8 Chinese comments get shredded into commands ("'src' is not recognized").
echo Stopping old guard windows...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*start.bat*' -and $_.CommandLine -notlike '*restart.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Stopping old bridge processes...
rem start.bat launches with a relative path (node src/bridge.js), so Win32_Process.CommandLine
rem never contains the repo path. Match by lock-file PID plus a *bridge.js* fallback instead.
powershell -NoProfile -Command "$lock = Join-Path '%~dp0' 'state\bridge.lock'; $pids = @(); if (Test-Path $lock) { $raw = (Get-Content $lock -Raw).Trim(); if ($raw -match '^\d+$') { $pids += [int]$raw } }; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' } | ForEach-Object { $pids += $_.ProcessId }; $pids | Sort-Object -Unique | ForEach-Object { Write-Host ('  kill PID ' + $_); Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
rem Wait until the old instance really exits and releases the console port; otherwise
rem "lock deleted but process still alive" means two instances.
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$live = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' -and $_.CommandLine -notlike '*mcp-*' -and $_.CommandLine -notlike '*node_modules*' }; if ($live) { Write-Host 'Bridge still alive:'; $live | ForEach-Object { Write-Host ('  PID ' + $_.ProcessId + '  ' + $_.CommandLine) }; exit 1 } else { exit 0 }"
if errorlevel 1 (
    echo.
    echo Restart aborted: refusing to risk two instances fighting over messages and state.
    echo Kill the PIDs listed above manually, then retry.
    pause
    exit /b 1
)
del state\bridge.lock 2>nul
start "" cmd /c start.bat
echo Guard window started.
