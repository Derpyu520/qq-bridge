# 一次性重启脚本：优雅关闭 DeepSeek Harness，等进程退出后重新拉起，
# 再把 SnowLuma 与 qq-bridge 从新目录（D:\dev\fatfishbot）启动起来。
# 由计划任务 DSH-Restart-Once 调用，之后自删该任务。
# 日志：D:\dev\fatfishbot\state\restart-dsh.log

$ErrorActionPreference = 'Continue'
$log = 'D:\dev\fatfishbot\state\restart-dsh.log'
function L($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Add-Content -Path $log -Encoding utf8 }

$exe = 'D:\Program Files\deepseek\DeepSeek Harness.exe'
$snowLuma = 'D:\Program Files\SnowLuma-v2.0.3-win-x64\launcher.bat'
$bridge = 'D:\dev\fatfishbot\start.bat'

L '=== restart requested ==='

$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($procs) {
    $main = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($main) {
        L ("graceful close of pid " + $main.Id)
        $null = $main.CloseMainWindow()
    } else {
        L 'no main window found; will force kill'
    }
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
    }
    $left = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
    if ($left) {
        L ("force killing leftovers: " + ($left.Id -join ','))
        $left | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }
} else {
    L 'deepseek harness not running'
}

Start-Sleep -Seconds 2
for ($i = 1; $i -le 3; $i++) {
    try {
        Start-Process -FilePath $exe -ErrorAction Stop
        L ("relaunched deepseek harness (attempt $i)")
        break
    } catch {
        L ("relaunch failed: " + $_.Exception.Message)
        Start-Sleep -Seconds 5
    }
}

Start-Sleep -Seconds 20

# 服务统一走计划任务（SnowLuma / qq-bridge 都是 AtLogOn 任务）：
# 直接 Start-Process 起 cmd/bat 在计划任务上下文里曾出现工作目录不对、子进程随任务结束被杀的问题，
# 用 Start-ScheduledTask 则让任务自己持有进程，任务状态 Running 期间进程一直活着。
$port5099 = Get-NetTCPConnection -State Listen -LocalPort 5099 -ErrorAction SilentlyContinue
if (-not $port5099) {
    try { Start-ScheduledTask -TaskName 'SnowLuma' -ErrorAction Stop; L 'snowluma task started' }
    catch { L ('snowluma task start failed: ' + $_.Exception.Message) }
} else {
    L 'snowluma already listening on 5099'
}

Start-Sleep -Seconds 12

$port3100 = Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue
if (-not $port3100) {
    try { Start-ScheduledTask -TaskName 'qq-bridge' -ErrorAction Stop; L 'qq-bridge task started' }
    catch { L ('qq-bridge task start failed: ' + $_.Exception.Message) }
} else {
    L 'bridge already listening on 3100'
}

L '=== done ==='
schtasks /Delete /TN "DSH-Restart-Once" /F 2>&1 | Out-Null
