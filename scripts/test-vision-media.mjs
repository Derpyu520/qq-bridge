// 视觉/图片链路自检脚本：
// 1. 校验配置默认模型为 DeepSeek-V4-Flash-Vision-Exp
// 2. 校验 safe-fetch 的 SSRF 防护（本机地址应被拒绝）
// 3. 若桥接运行中，校验 /api/images/message 端点可用（用二代 agent token）
// 运行：node scripts/test-vision-media.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const config = readJson(path.join(ROOT, 'config.json'));
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. 配置
check('config.dsh.model 为视觉模型', config.dsh?.model === 'deepseek-v4-flash-vision-exp', `当前 ${config.dsh?.model}`);
check('config.dsh.reasoningEffort 为 max', config.dsh?.reasoningEffort === 'max', `当前 ${config.dsh?.reasoningEffort}`);
check('config.socialV2.tools.getImages 默认开启', config.socialV2?.tools?.getImages !== false);

// 2. safe-fetch SSRF
try {
  await safeFetchBuffer('http://127.0.0.1/');
  check('safe-fetch 拒绝本机地址', false, '未抛出异常');
} catch (error) {
  check('safe-fetch 拒绝本机地址', /内网|本机|禁止/.test(String(error?.message ?? error)), error?.message);
}

// 3. 桥接端点（可选）
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const socialV2File = path.join(ROOT, 'state', 'social-v2.json');
if (fs.existsSync(consoleTokenFile) && fs.existsSync(socialV2File)) {
  try {
    const consoleToken = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    const social = JSON.parse(fs.readFileSync(socialV2File, 'utf8'));
    const conv = social?.conversations ? Object.entries(social.conversations)[0] : null;
    if (conv) {
      const [key, st] = conv;
      const agentToken = st?.agentToken;
      const messageId = st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;
      if (agentToken && messageId) {
        const url = `http://127.0.0.1:${config.consolePort || 3100}/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`;
        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        check('桥接 /api/images/message 端点可访问', res.ok === true && body.ok === true, `HTTP ${res.status}`);
      } else {
        console.log('⚠️ 跳过桥接端点检查：没有可用 agentToken/messageId');
      }
    }
  } catch (error) {
    console.log(`⚠️ 桥接端点检查跳过：${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过桥接端点检查：缺少 state/console-token 或 state/social-v2.json');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
