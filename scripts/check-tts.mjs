#!/usr/bin/env node
// edge-tts 链路自检：只合成、不发送。
// 用法：node scripts/check-tts.mjs [文本...]
// 会打印每次的耗时、时长、峰值电平，并判断是否“有声音”（防出现静音却发送成功的情况）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokenFile = path.join(ROOT, 'state/console-token');
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
if (!token) {
  console.error('✗ 读不到 state/console-token（控制台没启动过？）');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const target = (cfg.allow?.groups?.[0] && `group:${cfg.allow.groups[0]}`)
  || (cfg.allow?.private?.[0] && `private:${cfg.allow.private[0]}`);
if (!target) {
  console.error('✗ config.json 里没有白名单会话，无法调用合成接口');
  process.exit(1);
}

const DEFAULT_CASES = [
  '在的，我这不就在这儿嘛。',
  '好家伙，一只海狮歪着脑袋、张大嘴叫唤扭来扭去的样子，看着就像在说，无聊死了。',
  '今天有点累，早点睡吧，明天再聊。'
];
const cases = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CASES;

function probeWav(file) {
  const r = spawnSync(cfg.tts?.ffmpegPath || 'ffmpeg', [
    '-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'
  ], { encoding: 'utf8' });
  const text = `${r.stderr ?? ''}`;
  const peak = /max_volume: (-?[\d.]+) dB/.exec(text)?.[1];
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(text)?.[1];
  return { peakDb: peak ? Number(peak) : null, meanDb: mean ? Number(mean) : null };
}

let fail = 0;
for (const [i, text] of cases.entries()) {
  const started = Date.now();
  let res;
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.consolePort ?? 3100}/api/voice/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ target, text, dryRun: true })
    });
    res = await r.json();
  } catch (error) {
    console.error(`✗ [${i + 1}] 请求失败：${error?.message ?? error}`);
    fail += 1;
    continue;
  }
  const ms = Date.now() - started;
  if (!res.ok) {
    console.error(`✗ [${i + 1}] 合成失败：${res.error}`);
    fail += 1;
    continue;
  }
  const { peakDb, meanDb } = probeWav(res.file);
  // edge-tts 正常输出峰值在 -1 ~ -10 dB 之间；低于 -40 dB 基本就是静音（历史踩过）
  const silent = peakDb !== null && peakDb < -40;
  if (silent) fail += 1;
  console.log(
    `${silent ? '✗' : '✓'} [${i + 1}] ${ms}ms · ${res.detail} · peak=${peakDb ?? '?'}dB / mean=${meanDb ?? '?'}dB${res.cached ? ' · 缓存' : ''}`
  );
  console.log(`    ${text}`);
}

console.log(`\n${cases.length - fail}/${cases.length} 通过${fail ? `（${fail} 项失败）` : ''}`);
if (fail) process.exitCode = 1;
