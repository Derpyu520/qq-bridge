@echo off
rem Fully restart DeepSeek Harness (DSH).
rem
rem Why this exists: closing the DSH window only hides it to the tray. Its MCP
rem child processes keep running with the tool schema they were spawned with, so
rem new/changed MCP tools (qq_list_assets / qq_view_asset) never load until the
rem whole app is restarted. This script stops every DSH process, waits for the
rem locks to clear, then relaunches the same executable.
rem
rem ASCII-only on purpose: non-ASCII text in .cmd is decoded with the console
rem code page and turns into mojibake (see scripts/test-encoding.mjs).
chcp 65001 >nul
setlocal
set "EXE="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1).Path"`) do set "EXE=%%P"
if not defined EXE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe" set "EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if not defined EXE if exist "%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe" set "EXE=%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe"
if not defined EXE (
  echo Could not find DeepSeek Harness. Start it once, or edit this file and set EXE.
  exit /b 1
)
echo Stopping DeepSeek Harness...
powershell -NoProfile -Command "Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force"
timeout /t 5 /nobreak >nul
echo Starting: %EXE%
start "" "%EXE%"
endlocal
exit /b 0
