# 打印 QQ 会话在 DSH 里的原始日志（桥接发给 QQ 的报错会被打码，这里看的是未打码原文）。
#
# 背景：桥接出站文本会过 src/sensitive.js 的 SENSITIVE_RE，形如 C:\... 的本机路径会被替换成
# 「（含敏感信息，已隐藏）」，state/bridge.log 里也是打码后的。DSH 侧的会话日志才是原文。
#
# 用法：
#   powershell -NoProfile -File scripts\show-qq-session-log.ps1            # 最近一个 QQ 会话，最后 60 行
#   powershell -NoProfile -File scripts\show-qq-session-log.ps1 -Lines 200
#   powershell -NoProfile -File scripts\show-qq-session-log.ps1 -ErrorsOnly
#   powershell -NoProfile -File scripts\show-qq-session-log.ps1 -SessionId session-1e8f0dfd-...
param(
    [int]$Lines = 60,
    [switch]$ErrorsOnly,
    [string]$SessionId = ''
)

$ErrorActionPreference = 'Stop'
$sessionsRoot = Join-Path $env:USERPROFILE '.dsh\sessions'

if (-not (Test-Path $sessionsRoot)) {
    Write-Host "找不到 DSH 会话目录：$sessionsRoot" -ForegroundColor Red
    exit 1
}

# QQ 会话的 workspace 目录有两种历史形态：老仓库路径（qq-bridge-state-agents）与新路径（fatfishbot）。
$candidates = Get-ChildItem $sessionsRoot -Directory |
    Where-Object { $_.Name -like '*qq-bridge-state-agents*' -or $_.Name -like '*fatfishbot*' }

if (-not $candidates) {
    Write-Host "没找到 QQ 会话目录（--qq-bridge-state-agents-- / --fatfishbot--）" -ForegroundColor Yellow
    Write-Host "现有目录："
    Get-ChildItem $sessionsRoot -Directory | Select-Object -ExpandProperty Name
    exit 1
}

$files = foreach ($dir in $candidates) {
    Get-ChildItem $dir.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $z = Join-Path $_.FullName 'session.v4.jsonl.zstd'
        if (Test-Path $z) { [pscustomobject]@{ SessionId = $_.Name; Path = $z; Time = (Get-Item $z).LastWriteTime } }
    }
}

if ($SessionId) { $files = $files | Where-Object { $_.SessionId -like "*$SessionId*" } }
if (-not $files) { Write-Host "没有匹配的 session 日志" -ForegroundColor Yellow; exit 1 }

$pick = $files | Sort-Object Time -Descending | Select-Object -First 1
Write-Host ("会话: {0}" -f $pick.SessionId) -ForegroundColor Cyan
Write-Host ("日志: {0}（{1:yyyy-MM-dd HH:mm:ss}）" -f $pick.Path, $pick.Time) -ForegroundColor DarkGray

$zstd = @(
    'D:\ProgramData\Miniconda\Library\bin\zstd.exe',
    (Get-Command zstd -ErrorAction SilentlyContinue).Source
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $zstd) {
    Write-Host "没找到 zstd.exe；可以手动解压后查看：`n  <上述路径> 是一个 zstd 压缩的 JSONL" -ForegroundColor Yellow
    exit 1
}

$tmp = Join-Path $env:TEMP ("qq-session-{0}.jsonl" -f $pick.SessionId)
& $zstd -d -f -q -o $tmp $pick.Path 2>&1 | Out-Null

$content = Get-Content $tmp -Encoding utf8
if ($ErrorsOnly) {
    $content = $content | Where-Object { $_ -match '"kind":"error"|/error|出错' }
    $Lines = 200
}
$content | Select-Object -Last $Lines
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
