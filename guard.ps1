<#
.SYNOPSIS
    Keeps qq-bridge alive and reports SnowLuma reachability.

.DESCRIPTION
    This is a small, dependency-free Windows watchdog. It does NOT install,
    start, stop or deploy SnowLuma (see qq-bridge/README.md, EULA note).
    It only:
      * checks whether the qq-bridge process / state/bridge.lock / port 3100
        is alive;
      * starts start.bat again if the bridge is gone;
      * probes SnowLuma on 3000/3001/5099 and logs a warning when it is down.

    The bridge itself already restarts after a crash inside start.bat. This
    guard covers the cases start.bat cannot: its console window was closed,
    the machine rebooted, or the bridge never came back.

.PARAMETER IntervalSec
    Seconds between checks. Default 20. Minimum 5.

.PARAMETER Once
    Run one check and exit (useful with -ProbeOnly).

.PARAMETER ProbeOnly
    Report only; never start anything.

.PARAMETER NoSnowLuma
    Skip the SnowLuma port/process probe.

.EXAMPLE
    .\guard.ps1
    .\guard.ps1 -IntervalSec 30
    .\guard.ps1 -Once -ProbeOnly
#>
[CmdletBinding()]
param(
    [int]$IntervalSec = 20,
    [switch]$Once,
    [switch]$ProbeOnly,
    [switch]$NoSnowLuma
)

$ErrorActionPreference = 'Continue'
$Root       = $PSScriptRoot
$StateDir   = Join-Path $Root 'state'
$LogFile    = Join-Path $StateDir 'guard.log'
$LockFile   = Join-Path $StateDir 'guard.lock'
$BridgeLock = Join-Path $StateDir 'bridge.lock'
$BridgeBat  = Join-Path $Root 'start.bat'

if ($IntervalSec -lt 5) { $IntervalSec = 5 }
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

$script:LastBridgeStart = [datetime]::MinValue
$script:LastSnowWarn    = [datetime]::MinValue
$script:LastSnowDown    = [datetime]::MinValue

function Write-GuardLog {
    param(
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level = 'INFO',
        [string]$Message
    )
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try {
        if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 5MB)) {
            Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.1') -Force -ErrorAction SilentlyContinue
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    } catch {}
    Write-Host $line
}

function Test-TcpPort {
    param(
        [int]$Port,
        [int]$TimeoutMs = 700
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch {}
    }
}

function Get-NodeProcesses {
    try {
        return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)
    } catch {
        return @()
    }
}

function Get-BridgeState {
    param([object[]]$Nodes)

    $procs = @($Nodes | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match 'bridge\.js' -and
        $_.CommandLine -notmatch 'mcp-|node_modules'
    })

    $lockPid = $null
    if (Test-Path -LiteralPath $BridgeLock) {
        try {
            $raw = (Get-Content -LiteralPath $BridgeLock -Raw -ErrorAction Stop).Trim()
            if ($raw -match '^\d+$') { $lockPid = [int]$raw }
        } catch {}
    }

    $lockAlive = $false
    if ($null -ne $lockPid) {
        $lockAlive = $null -ne (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)
    }

    $portOpen = Test-TcpPort -Port 3100
    $healthy = ($procs.Count -gt 0) -or $lockAlive -or $portOpen

    return [pscustomobject]@{
        Healthy   = $healthy
        PortOpen  = $portOpen
        LockPid   = $lockPid
        LockAlive = $lockAlive
        Pids      = @($procs | ForEach-Object { $_.ProcessId })
    }
}

function Get-SnowLumaState {
    param([object[]]$Nodes)

    $procs = @($Nodes | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match 'snowluma' -and
        $_.CommandLine -match 'index\.mjs'
    })

    $web   = Test-TcpPort -Port 5099
    $http  = Test-TcpPort -Port 3000
    $ws    = Test-TcpPort -Port 3001
    $alive = ($procs.Count -gt 0) -or $web -or $http -or $ws

    return [pscustomobject]@{
        Alive      = $alive
        OneBot     = ($http -or $ws)
        Web        = $web
        Http       = $http
        Ws         = $ws
        ProcessIds = @($procs | ForEach-Object { $_.ProcessId })
    }
}

function Start-Bridge {
    if ($ProbeOnly) {
        Write-GuardLog WARN 'PROBE: bridge is down; would start start.bat.'
        return
    }

    $now = Get-Date
    if (($now - $script:LastBridgeStart).TotalSeconds -lt 45) {
        Write-GuardLog WARN 'bridge is down, but a start was attempted less than 45s ago; waiting.'
        return
    }

    if (-not (Test-Path -LiteralPath $BridgeBat)) {
        Write-GuardLog ERROR "start.bat not found: $BridgeBat"
        return
    }

    # A dead PID in bridge.lock makes the next bridge refuse to start.
    $state = Get-BridgeState -Nodes @()
    if ($null -ne $state.LockPid -and -not $state.LockAlive -and -not $state.PortOpen) {
        Remove-Item -LiteralPath $BridgeLock -Force -ErrorAction SilentlyContinue
        Write-GuardLog WARN "removed stale bridge.lock (PID $($state.LockPid) is gone)."
    }

    $script:LastBridgeStart = $now
    Write-GuardLog INFO 'starting qq-bridge via start.bat ...'
    try {
        Start-Process -FilePath 'cmd.exe' `
            -ArgumentList '/c', ('"' + $BridgeBat + '"') `
            -WorkingDirectory $Root `
            -WindowStyle Minimized | Out-Null
    } catch {
        Write-GuardLog ERROR ("failed to start qq-bridge: " + $_.Exception.Message)
    }
}

# Single-instance guard lock. The handle stays open for the whole run.
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open(
        $LockFile,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    $lockStream.SetLength(0)
    $pidBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$PID)
    $lockStream.Write($pidBytes, 0, $pidBytes.Length)
    $lockStream.Flush()
} catch {
    Write-Host ("Cannot lock guard lock file: " + $_.Exception.Message)
    Write-Host "If another guard window is already open, close it first. If not, delete state\guard.lock and retry."
    exit 1
}

try {
    Write-GuardLog INFO ("guard started: pid=$PID interval=${IntervalSec}s root=$Root")

    while ($true) {
        $nodes  = Get-NodeProcesses
        $bridge = Get-BridgeState -Nodes $nodes

        if ($bridge.Healthy) {
            Write-GuardLog INFO ("bridge OK (pids={0}; port3100={1}; lockPid={2})" -f (($bridge.Pids -join ',')), $bridge.PortOpen, $bridge.LockPid)
        } else {
            Write-GuardLog WARN 'bridge is DOWN (no process, no live lock, port 3100 closed).'
            Start-Bridge
        }

        if (-not $NoSnowLuma) {
            $snow = Get-SnowLumaState -Nodes $nodes
            if ($snow.Alive -and $snow.OneBot) {
                Write-GuardLog INFO ("SnowLuma OK (pids={0}; 3000={1}; 3001={2}; 5099={3})" -f (($snow.ProcessIds -join ',')), $snow.Http, $snow.Ws, $snow.Web)
            } elseif ($snow.Alive) {
                $now = Get-Date
                if (($now - $script:LastSnowWarn).TotalSeconds -ge 60) {
                    Write-GuardLog WARN ("SnowLuma process/WebUI is alive, but OneBot is NOT ready (3000={0}; 3001={1}; 5099={2}). This guard will not start SnowLuma; fix it in SnowLuma." -f $snow.Http, $snow.Ws, $snow.Web)
                    $script:LastSnowWarn = $now
                }
            } else {
                $now = Get-Date
                if (($now - $script:LastSnowDown).TotalSeconds -ge 300) {
                    Write-GuardLog ERROR 'SnowLuma is not running. Start launcher.bat manually; this guard intentionally does not deploy/start SnowLuma.'
                    $script:LastSnowDown = $now
                }
            }
        }

        if ($Once) { break }
        Start-Sleep -Seconds $IntervalSec
    }
} finally {
    Write-GuardLog INFO 'guard stopped.'
    if ($null -ne $lockStream) {
        try { $lockStream.Dispose() } catch {}
    }
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
