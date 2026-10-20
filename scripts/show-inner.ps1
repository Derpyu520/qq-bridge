# 查看大肥鱼的「内在状态」：日记 / 心情好感度 / 未兑现的约定。
#
# 数据来源（桥接实时写的 JSON，无需登录控制台）：
#   state\diary.json      { "<会话key>": { entries: [...] } }
#   state\heart.json      { "<会话key>": { affinity, mood, history } }
#   state\promises.json   { "<会话key>": { items: [...] } }
#
# 用法：
#   powershell -NoProfile -File scripts\show-inner.ps1                 # 全部会话，日记最后 10 条
#   powershell -NoProfile -File scripts\show-inner.ps1 -Key private:438669432
#   powershell -NoProfile -File scripts\show-inner.ps1 -Limit 50
#   powershell -NoProfile -File scripts\show-inner.ps1 -DiaryOnly
param(
    [string]$Key = '',
    [int]$Limit = 10,
    [switch]$DiaryOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root 'state'

function Read-Json($name) {
    $p = Join-Path $stateDir $name
    if (-not (Test-Path $p)) { return @{} }
    try {
        $text = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
        if (-not $text.Trim()) { return @{} }
        return $text | ConvertFrom-Json
    } catch {
        Write-Host "读取 $name 失败：$($_.Exception.Message)" -ForegroundColor Red
        return @{}
    }
}

function Format-Time($ms) {
    if (-not $ms) { return '-' }
    return [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$ms).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
}

$diary = Read-Json 'diary.json'
$heart = Read-Json 'heart.json'
$promises = Read-Json 'promises.json'

$keys = @()
foreach ($src in @($diary, $heart, $promises)) {
    if ($src) { $keys += $src.PSObject.Properties.Name }
}
$keys = $keys | Sort-Object -Unique
if ($Key) { $keys = $keys | Where-Object { $_ -eq $Key } }
if (-not $keys) { Write-Host '还没有任何内在状态数据（AI 写日记/更新心情/记约定后才会有）' -ForegroundColor Yellow; exit 0 }

foreach ($k in $keys) {
    Write-Host ''
    Write-Host "══ $k ══" -ForegroundColor Cyan

    if (-not $DiaryOnly) {
        $h = $heart.$k
        if ($h) {
            $label = @{ happy = '高兴'; calm = '平静'; low = '低落'; sad = '难过'; irritated = '烦躁'; excited = '兴奋'; tired = '疲惫' }[$h.mood.label]
            if (-not $label) { $label = $h.mood.label }
            Write-Host ("心情：{0}{1}｜好感度：{2}/10（{3}/100）" -f $label,
                $(if ($h.mood.reason) { "（$($h.mood.reason)）" } else { '' }),
                $h.affinity.level, $h.affinity.score) -ForegroundColor Green
        }

        $p = $promises.$k
        if ($p -and $p.items) {
            $open = @($p.items | Where-Object { $_.status -eq 'open' })
            if ($open.Count) {
                Write-Host '未完成的约定：' -ForegroundColor Yellow
                foreach ($item in $open) {
                    $flag = if ($item.dueAt -le [DateTimeOffset]::Now.ToUnixTimeMilliseconds()) { '（已到期）' } else { '' }
                    Write-Host ("  · {0}  [{1}]{2}" -f $item.text, (Format-Time $item.dueAt), $flag)
                }
            }
        }
    }

    $d = $diary.$k
    if ($d -and $d.entries) {
        $entries = @($d.entries | Sort-Object -Property at -Descending | Select-Object -First $Limit)
        Write-Host "日记（最近 $($entries.Count) 条）："
        foreach ($e in $entries) {
            $levelText = @{ normal = '普通'; important = '重要'; critical = '非常重要' }[$e.level]
            $ttl = if ($e.expiresAt) { '到期 ' + (Format-Time $e.expiresAt) } else { '永不遗忘' }
            Write-Host ("  [{0}|{1}|{2}] {3}" -f $levelText, (Format-Time $e.at), $ttl, $e.text)
            if ($e.unsaid) { Write-Host ("      没说出口：{0}" -f $e.unsaid) -ForegroundColor DarkGray }
        }
    }
}
Write-Host ''
