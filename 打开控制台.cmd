@echo off
setlocal
set "ROOT=%~dp0"
set "TOKEN="
if exist "%ROOT%state\console-token" (
  for /f "usebackq delims=" %%t in ("%ROOT%state\console-token") do set "TOKEN=%%t"
)
if not defined TOKEN (
  echo console token not found: %ROOT%state\console-token
  pause
  exit /b 1
)
start "" "http://127.0.0.1:3100/?token=%TOKEN%"
