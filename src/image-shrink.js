// 把过大的图片压到模型能接受的尺寸再交给 DSH。
//
// 为什么需要：QQ 原图常见 8~12MB，直接塞给模型会超出路由的图片预算，
// DSH 的 image-offload 会把图换成占位符并重试 —— 在 QQ 侧的表现就是「读图一直报错」。
// 本机没有 sharp / ffmpeg，用 Windows 自带的 System.Drawing 缩放，零依赖。
// 非 Windows 或压缩失败时返回 null（调用方保持原图，至少不会比现在更差）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 注意：PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解析，所以脚本必须是纯 ASCII。
const SCRIPT = String.raw`param([string]$In,[string]$Out,[int]$MaxDim,[int]$Quality)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($In)
try {
  $r = [Math]::Min(1.0, [Math]::Min($MaxDim / $src.Width, $MaxDim / $src.Height))
  $w = [int][Math]::Max(1, [Math]::Round($src.Width * $r))
  $h = [int][Math]::Max(1, [Math]::Round($src.Height * $r))
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $w, $h)
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $p = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
    $bmp.Save($Out, $codec, $p)
  } finally { $g.Dispose(); $bmp.Dispose() }
} finally { $src.Dispose() }`;

let cachedScript = null;
function ensureScript() {
  if (cachedScript && fs.existsSync(cachedScript)) return cachedScript;
  const file = path.join(os.tmpdir(), 'qq-bridge-shrink-image.ps1');
  fs.writeFileSync(file, SCRIPT, 'utf8');
  cachedScript = file;
  return file;
}

/**
 * 图片超过阈值时等比缩到 maxDim 并转 JPEG。
 * @param {Buffer} buffer 原始图片
 * @param {{maxBytes?:number,maxDim?:number,quality?:number}} [options]
 * @returns {{buffer: Buffer, mimeType: string, width?: number, height?: number}|null}
 */
export function shrinkImageBuffer(buffer, { maxBytes = 2_000_000, maxDim = 1600, quality = 82 } = {}) {
  if (!buffer || buffer.length <= maxBytes) return null;
  if (process.platform !== 'win32') return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-img-'));
  const inFile = path.join(dir, 'in.bin');
  const outFile = path.join(dir, 'out.jpg');
  try {
    fs.writeFileSync(inFile, buffer);
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ensureScript(), '-In', inFile, '-Out', outFile,
      '-MaxDim', String(maxDim), '-Quality', String(quality),
    ], { timeout: 20000, windowsHide: true, stdio: 'ignore' });
    const out = fs.readFileSync(outFile);
    if (!out || out.length < 100) return null;
    return { buffer: out, mimeType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
