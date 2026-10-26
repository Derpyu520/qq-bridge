#!/usr/bin/env node
// 真实 SnowLuma/OneBot 网关冒烟（P1）：群签到、点赞、分享卡片、改口。
// 会向 owner 私聊发送测试文本/卡片，并在一个白名单群签到一次。
// 用法：node scripts/smoke-gateway-p1.mjs --yes
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
if (!process.argv.includes('--yes')) {
  console.log('DRY RUN: 该脚本会发送真实 QQ 消息/签到，确认后加 --yes 运行。');
  process.exit(0);
}
const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = String(cfg.snowluma?.accessToken || '');
const owner = Number(cfg.ownerQQ);
const group = Number((cfg.allow?.groups || [])[0] || 0);
const results = [];

async function action(name, params = {}) {
  const res = await fetch(`${base}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`${name}: ${body.wording || body.retcode || res.status}`);
  }
  return body.data;
}

async function step(name, fn) {
  try {
    const data = await fn();
    const summary = Array.isArray(data)
      ? { arrayLength: data.length }
      : (data && typeof data === 'object' ? { keys: Object.keys(data).slice(0, 8) } : data);
    results.push({ name, ok: true, data: summary });
    console.log(`✅ ${name}`);
    return data;
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.error(`❌ ${name}: ${error?.message ?? error}`);
    return null;
  }
}

await step('get_status', () => action('get_status'));
await step('get_group_list', () => action('get_group_list'));
if (group) await step(`get_group_member_list(${group})`, () => action('get_group_member_list', { group_id: group }));
if (group) await step(`set_group_sign(${group})`, () => action('set_group_sign', { group_id: group }));
if (owner) await step(`send_like(${owner})`, () => action('send_like', { user_id: owner, times: 1 }));

let sentId = null;
if (owner) {
  sentId = await step('send_private_msg(测试原句)', async () => {
    const data = await action('send_private_msg', { user_id: owner, message: '冒烟测试：原句' });
    return data?.message_id ?? null;
  });
}
if (sentId != null) {
  await step('delete_msg(撤回原句)', () => action('delete_msg', { message_id: Number(sentId) }));
  await step('send_private_msg(改口后)', () => action('send_private_msg', { user_id: owner, message: '冒烟测试：改口后的句子' }));
}
if (owner) {
  await step('send_tuwen_ark(分享卡片)', () => action('send_tuwen_ark', {
    user_id: owner,
    title: 'QQ Bridge 冒烟测试',
    desc: 'P1 分享卡片真实网关测试',
    jump_url: 'https://example.com/',
    preview_url: 'https://example.com/'
  }));
}

const failed = results.filter((x) => !x.ok);
console.log('\nSUMMARY');
console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
if (failed.length) process.exitCode = 1;
