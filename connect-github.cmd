@echo off
setlocal
cd /d "%~dp0"
set GIT_TERMINAL_PROMPT=0
set "PROXY1=https://ghproxy.net/https://github.com/Derpyu520/qq-bridge.git"
set "PROXY2=https://gh-proxy.com/https://github.com/Derpyu520/qq-bridge.git"

echo ============================================
echo  Connect this qq-bridge folder to GitHub
echo  Repo: https://github.com/Derpyu520/qq-bridge
echo ============================================
echo.

set "GIT=git"
where git >nul 2>nul
if errorlevel 1 set "GIT="

if not defined GIT (
  rem DSH ships a portable git under %USERPROFILE%\.dsh\dsh-ops\bash-ipc.
  for /d %%D in ("%USERPROFILE%\.dsh\dsh-ops\bash-ipc\*") do (
    if not defined GIT if exist "%%~fD\ucrt64\bin\git.exe" set "GIT=%%~fD\ucrt64\bin\git.exe"
  )
)

if not defined GIT (
  echo [ERROR] git not found.
  echo         Install Git for Windows: https://git-scm.com/download/win
  pause
  exit /b 1
)

"%GIT%" --version >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git exists but cannot run: %GIT%
  pause
  exit /b 1
)

if exist ".git" (
  "%GIT%" rev-parse --verify HEAD >nul 2>nul
  if not errorlevel 1 (
    echo [INFO] .git already has commits. This script will NOT reset your local history.
    echo [INFO] Only fetch/update the origin remote.
    "%GIT%" remote get-url origin >nul 2>nul
    if errorlevel 1 (
      "%GIT%" remote add origin https://github.com/Derpyu520/qq-bridge.git
    ) else (
      "%GIT%" remote set-url origin https://github.com/Derpyu520/qq-bridge.git
    )
    "%GIT%" -c credential.helper= fetch --depth=1 --no-tags "%PROXY1%" main
    if errorlevel 1 "%GIT%" -c credential.helper= fetch --depth=1 --no-tags "%PROXY2%" main
    if errorlevel 1 (
      echo [ERROR] git fetch failed. Check network/proxy and try again.
      pause
      exit /b 1
    )
    for /f "tokens=1" %%H in (.git\FETCH_HEAD) do set "FETCHED=%%H"
    "%GIT%" update-ref refs/remotes/origin/main %FETCHED%
    echo.
    echo [OK] Fetched origin/main. Your local files were not changed.
    "%GIT%" status --short
    pause
    exit /b 0
  )
  echo [INFO] .git exists but has no commits; continuing setup.
)

echo [1/6] git init
"%GIT%" init
if errorlevel 1 (
  echo [ERROR] git init failed.
  pause
  exit /b 1
)

echo [2/6] set origin
"%GIT%" remote get-url origin >nul 2>nul
if errorlevel 1 (
  "%GIT%" remote add origin https://github.com/Derpyu520/qq-bridge.git
) else (
  "%GIT%" remote set-url origin https://github.com/Derpyu520/qq-bridge.git
)
if errorlevel 1 (
  echo [ERROR] could not set origin.
  pause
  exit /b 1
)

echo [3/6] fetch latest main via GitHub proxy
"%GIT%" -c credential.helper= fetch --depth=1 --no-tags "%PROXY1%" main
if errorlevel 1 (
  echo [WARN] proxy 1 failed, trying proxy 2...
  "%GIT%" -c credential.helper= fetch --depth=1 --no-tags "%PROXY2%" main
)
if errorlevel 1 (
  echo [ERROR] git fetch failed. Check network/proxy and try again.
  pause
  exit /b 1
)

for /f "tokens=1" %%H in (.git\FETCH_HEAD) do set "FETCHED=%%H"
if not defined FETCHED (
  echo [ERROR] fetch returned no commit.
  pause
  exit /b 1
)
"%GIT%" update-ref refs/remotes/origin/main %FETCHED%

echo [4/6] set local main to upstream (working files stay as they are)
"%GIT%" reset --mixed origin/main
if errorlevel 1 (
  echo [ERROR] git reset failed.
  pause
  exit /b 1
)

echo [5/6] rename branch to main and track origin/main
"%GIT%" branch -M main
"%GIT%" branch --set-upstream-to=origin/main main
if errorlevel 1 (
  echo [ERROR] could not set upstream.
  pause
  exit /b 1
)

echo [6/6] done
echo.
echo [OK] This folder is now connected to GitHub.
echo      Your local TTS/guard/config changes are still uncommitted.
echo.
echo Next steps (optional):
echo   git status
echo   git add -A
echo   git commit -m "local: TTS + guard + config"
echo.
"%GIT%" status --short
pause
