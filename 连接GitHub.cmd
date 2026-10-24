@echo off
setlocal
cd /d "%~dp0"
set GIT_TERMINAL_PROMPT=0

echo ============================================
echo  Connect this qq-bridge folder to GitHub
echo  Repo: https://github.com/Derpyu520/qq-bridge
echo ============================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git not found. Install Git for Windows first.
  pause
  exit /b 1
)

if exist ".git" (
  echo [INFO] .git already exists. This script will NOT reset your local history.
  echo [INFO] Only fetch/update the origin remote.
  git remote get-url origin >nul 2>nul
  if errorlevel 1 (
    git remote add origin https://github.com/Derpyu520/qq-bridge.git
  ) else (
    git remote set-url origin https://github.com/Derpyu520/qq-bridge.git
  )
  git fetch origin main
  if errorlevel 1 (
    echo [ERROR] git fetch failed. Check network/proxy and try again.
    pause
    exit /b 1
  )
  echo.
  echo [OK] Fetched origin/main. Your local files were not changed.
  git status --short
  pause
  exit /b 0
)

echo [1/6] git init
git init
if errorlevel 1 (
  echo [ERROR] git init failed.
  pause
  exit /b 1
)

echo [2/6] add origin
git remote add origin https://github.com/Derpyu520/qq-bridge.git
if errorlevel 1 (
  echo [ERROR] could not add origin.
  pause
  exit /b 1
)

echo [3/6] fetch latest main
git fetch origin main
if errorlevel 1 (
  echo [ERROR] git fetch failed. Check network/proxy and try again.
  pause
  exit /b 1
)

echo [4/6] set local main to upstream (working files stay as they are)
git reset --mixed origin/main
if errorlevel 1 (
  echo [ERROR] git reset failed.
  pause
  exit /b 1
)

echo [5/6] rename branch to main and track origin/main
git branch -M main
git branch --set-upstream-to=origin/main main
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
git status --short
pause
