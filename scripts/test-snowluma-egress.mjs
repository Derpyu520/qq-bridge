// SnowLuma 旁路发送审计（src/snowluma-egress.js）的离线单测。
// 目标：只读判断 SnowLuma 内置 #sl 状态命令是否开启，绝不把「读不到/解析失败」当成「安全」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { auditSnowLumaEgress, inspectOneBotConfig } from '../src/snowluma-egress.js';

function makeTempConfig(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-egress-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'config', name), content);
  }
  return dir;
}

test('显式关闭 #sl：视为安全', () => {
  const info = inspectOneBotConfig({ statusCommand: { enabled: false, trigger: '#sl' } }, 'a.json');
  assert.equal(info.file, 'a.json');
  assert.equal(info.statusCommand.enabled, false);
  assert.equal(info.statusCommand.defaulted, false);
});

test('显式开启 #sl：记录触发词、冷却与 swallow', () => {
  const info = inspectOneBotConfig({
    statusCommand: { enabled: true, trigger: '#sl', swallow: false, cooldownSeconds: 5 },
  }, 'b.json');
  assert.equal(info.statusCommand.enabled, true);
  assert.equal(info.statusCommand.trigger, '#sl');
  assert.equal(info.statusCommand.swallow, false);
  assert.equal(info.statusCommand.cooldownSeconds, 5);
  assert.equal(info.statusCommand.defaulted, false);
});

test('缺少 statusCommand 时按 SnowLuma 默认（开启 #sl）处理', () => {
  const info = inspectOneBotConfig({}, 'c.json');
  assert.equal(info.statusCommand.enabled, true, 'SnowLuma 的默认值是 enabled:true，不能当成关闭');
  assert.equal(info.statusCommand.defaulted, true);
  assert.equal(info.statusCommand.trigger, '#sl');
  assert.equal(info.statusCommand.cooldownSeconds, 5);
});

test('enabled 不是布尔值时按默认开启处理（不静默放行脏配置）', () => {
  const info = inspectOneBotConfig({ statusCommand: { enabled: 'false' } }, 'd.json');
  assert.equal(info.statusCommand.enabled, true);
  assert.equal(info.statusCommand.defaulted, true);
});

test('扫描 onebot*.json：只报告开启的文件，关闭的文件保留在 files 里', () => {
  const dir = makeTempConfig({
    'onebot.json': JSON.stringify({ statusCommand: { enabled: false } }),
    'onebot_123456.json': JSON.stringify({ statusCommand: { enabled: true, trigger: '#sl' } }),
    'other.json': JSON.stringify({ statusCommand: { enabled: true } }),
  });
  try {
    const audit = auditSnowLumaEgress({ homeDir: dir });
    assert.equal(audit.checked, true);
    assert.equal(audit.ok, true);
    assert.equal(audit.enabled, true);
    assert.equal(audit.files.length, 2);
    assert.equal(audit.findings.length, 1);
    assert.match(audit.findings[0].file, /onebot_123456\.json$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('全部关闭：enabled=false，不是「未知」', () => {
  const dir = makeTempConfig({
    'onebot.json': JSON.stringify({ statusCommand: { enabled: false } }),
    'onebot_1.json': JSON.stringify({ statusCommand: { enabled: false } }),
  });
  try {
    const audit = auditSnowLumaEgress({ homeDir: dir });
    assert.equal(audit.checked, true);
    assert.equal(audit.ok, true);
    assert.equal(audit.enabled, false);
    assert.deepEqual(audit.findings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配置目录不存在：checked=false、enabled=null，不能报告为安全', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-missing-'));
  try {
    const audit = auditSnowLumaEgress({ homeDir: dir });
    assert.equal(audit.checked, false);
    assert.equal(audit.ok, false);
    assert.equal(audit.enabled, null);
    assert.ok(audit.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没有 onebot*.json：同样返回未知，而不是关闭', () => {
  const dir = makeTempConfig({ 'other.json': '{}' });
  try {
    const audit = auditSnowLumaEgress({ homeDir: dir });
    assert.equal(audit.checked, false);
    assert.equal(audit.enabled, null);
    assert.ok(audit.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON 损坏：ok=false、enabled=null，不能因为解析失败就放行', () => {
  const dir = makeTempConfig({
    'onebot.json': '{ not valid json',
  });
  try {
    const audit = auditSnowLumaEgress({ homeDir: dir });
    assert.equal(audit.checked, true);
    assert.equal(audit.ok, false);
    assert.equal(audit.enabled, null);
    assert.equal(audit.files.length, 1);
    assert.equal(audit.files[0].ok, false);
    assert.ok(audit.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未配置 homeDir：返回未知，不抛出', () => {
  const audit = auditSnowLumaEgress({ homeDir: '' });
  assert.equal(audit.checked, false);
  assert.equal(audit.enabled, null);
  assert.ok(audit.reason);
});
