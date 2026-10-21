# 看最近生成的图用了什么 prompt。
#
# 数据来源：state/images/nai-*.json（每次生图时旁挂的元数据，含 prompt / negative / 模型 / 尺寸 / 步数）。
# 旧图（这个功能加上之前生成的）没有旁挂文件，会标「无记录」。
#
# 用法：
#   powershell -NoProfile -File scripts\show-images.ps1            # 最近 10 张，只看 prompt
#   powershell -NoProfile -File scripts\show-images.ps1 -Limit 30
#   powershell -NoProfile -File scripts\show-images.ps1 -Full     # 连负面词、采样器一起看
param(
    [int]$Limit = 10,
    [switch]$Full
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'state\images'
if (-not (Test-Path $dir)) { Write-Host '还没有生成过图片（state\images 不存在）' -ForegroundColor Yellow; exit 0 }

$files = Get-ChildItem $dir -Filter '*.png' | Sort-Object LastWriteTime -Descending | Select-Object -First $Limit
if (-not $files) { Write-Host '还没有生成过图片' -ForegroundColor Yellow; exit 0 }

foreach ($f in $files) {
    $metaPath = [System.IO.Path]::ChangeExtension($f.FullName, '.json')
    Write-Host ''
    Write-Host ("══ {0}  {1}  {2:N0} KB ══" -f $f.Name, $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'), ($f.Length / 1KB)) -ForegroundColor Cyan
    if (-not (Test-Path $metaPath)) {
        Write-Host '  （无记录：这张图生成于元数据功能上线之前）' -ForegroundColor DarkGray
        continue
    }
    $m = Get-Content $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ("模型：{0}  {1}x{2}  steps={3}  sampler={4}  guidance={5}" -f $m.model, $m.width, $m.height, $m.steps, $m.sampler, $m.guidance)
    Write-Host 'Prompt:'
    Write-Host ("  {0}" -f $m.prompt) -ForegroundColor Green
    if ($Full) {
        Write-Host 'Negative:'
        Write-Host ("  {0}" -f $m.negative) -ForegroundColor DarkGray
    }
}
Write-Host ''
