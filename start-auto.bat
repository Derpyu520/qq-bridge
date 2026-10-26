@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
rem Local patch (not upstream): the DSH desktop app picks a random local port on
rem every launch, so sync config.json -> dsh.baseUrl before starting the bridge.
node "%~dp0scripts\sync-dsh-port.mjs"
if errorlevel 1 echo [start-auto] DSH port not found; using the existing config.json value.
call "%~dp0start.bat"
endlocal
