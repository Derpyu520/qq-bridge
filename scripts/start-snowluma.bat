@echo off
chcp 65001 >nul
cd /d "D:\Program Files\SnowLuma-v2.0.3-win-x64"
set SNOWLUMA_HOOK_AUTOLOAD=1
"D:\Program Files\SnowLuma-v2.0.3-win-x64\node.exe" index.mjs > "D:\dev\fatfishbot\state\snowluma-stdout.log" 2>&1
echo [start-snowluma] exited with %errorlevel% >> "D:\dev\fatfishbot\state\snowluma-stdout.log"
pause