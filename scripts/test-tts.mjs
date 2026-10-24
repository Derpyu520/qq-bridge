import fs from 'node:fs';
import { normalizeTtsConfig, prepareTtsText, synthesizeTts } from '../src/tts.js';

let failures = 0;
function check(ok, name, detail = '') {
  if (ok) console.log(`ok   ${name}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}

const cfg = normalizeTtsConfig({ enabled: true, voice: 'zh-CN-XiaoxiaoNeural', maxChars: 20, cacheDir: 'audio/.tts-cache' });
check(cfg.enabled === true, 'config enabled');
check(cfg.maxChars === 20, 'config maxChars');
check(cfg.cacheDir.endsWith('audio\\.tts-cache') || cfg.cacheDir.endsWith('audio/.tts-cache'), 'config cacheDir');

check(prepareTtsText('  你好，  世界。 ') === '你好，世界。', 'text normalizes whitespace');
let longRejected = false;
try { prepareTtsText('这'.repeat(21), 20); } catch { longRejected = true; }
check(longRejected, 'text over maxChars rejected');

const result = await synthesizeTts('这是一条 TTS 测试语音。', {
  enabled: true,
  provider: 'edge',
  voice: 'zh-CN-XiaoxiaoNeural',
  cacheDir: 'audio/.tts-cache'
});
check(fs.existsSync(result.path), 'audio file exists', result.path);
check(fs.statSync(result.path).size > 1000, 'audio file has bytes', `${fs.statSync(result.path).size}`);
console.log(`file ${result.path} (${result.bytes} bytes, cached=${result.cached})`);

if (failures) process.exit(1);
console.log('TTS test passed');
