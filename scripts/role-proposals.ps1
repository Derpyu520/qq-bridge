# 查看 / 批准 / 驳回 bot 自己提的人设建议，以及它记的说话备忘。
#
# 用法：
#   powershell -NoProfile -File scripts\role-proposals.ps1
#   powershell -NoProfile -File scripts\role-proposals.ps1 -Approve <id>
#   powershell -NoProfile -File scripts\role-proposals.ps1 -Reject  <id>
param(
    [string]$Approve,
    [string]$Reject,
    [int]$Port = 3100
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tokenFile = Join-Path $root 'state\console-token'
if (-not (Test-Path $tokenFile)) { Write-Host '找不到 state\console-token（桥接没跑过？）' -ForegroundColor Red; exit 1 }
$token = (Get-Content $tokenFile -Raw).Trim()
$headers = @{ 'x-console-token' = $token }

function Show-Proposals {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/self/proposals" -Headers $headers -Method Get
    Write-Host ''
    Write-Host '=== 人设建议 ===' -ForegroundColor Cyan
    if (-not $r.proposals -or $r.proposals.Count -eq 0) {
        Write-Host '  （没有）' -ForegroundColor DarkGray
    } else {
        foreach ($p in $r.proposals) {
            $color = if ($p.status -eq 'pending') { 'Yellow' } else { 'DarkGray' }
            Write-Host ("  [{0}] {1}  {2}" -f $p.status, $p.id, $p.createdAt) -ForegroundColor $color
            Write-Host ("       {0}" -f $p.text)
            if ($p.rationale) { Write-Host ("       理由：{0}" -f $p.rationale) -ForegroundColor DarkGray }
        }
    }
    Write-Host ''
    Write-Host '=== 说话备忘 ===' -ForegroundColor Cyan
    if (-not $r.notes -or $r.notes.Count -eq 0) {
        Write-Host '  （没有）' -ForegroundColor DarkGray
    } else {
        foreach ($n in $r.notes) { Write-Host ("  [{0}] {1}" -f $n.id, $n.text) }
    }
    Write-Host ''
}

if ($Approve -or $Reject) {
    $id = if ($Approve) { $Approve } else { $Reject }
    $action = if ($Approve) { 'approve' } else { 'reject' }
    $body = @{ id = $id; action = $action } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/self/proposals/decide" -Headers $headers -Method Post -ContentType 'application/json' -Body $body
    if ($r.ok) {
        Write-Host ("已{0}：{1}" -f $(if ($action -eq 'approve') { '批准' } else { '驳回' }), $r.proposal.text) -ForegroundColor Green
        if ($action -eq 'approve') { Write-Host '已写进 roles\小鲸鱼.md 的「附：AI 自荐补充」小节' -ForegroundColor Green }
    } else {
        Write-Host ("失败：{0}" -f $r.error) -ForegroundColor Red
    }
}

Show-Proposals