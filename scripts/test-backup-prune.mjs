// state/backups 的命名与收敛，钉住三件事：
//   ① 新老两种备份写法都归到同一个原件名下（分组键）；
//   ② 每个原件只留最近 keep 份，且刚备份的那份有冷却期不会被立刻清掉；
//   ③ 被删的永远是「更旧的那几份」，不是名字排在前面的。
//
// 为什么要测：2026-10-26 之前备份名是手写的（`bridge.js.bak-restart-selfheal-20261026-095857`、
// `config.json.bak-wake-limit-1792979576643`、`sessions.json.bak-bindtest-20261026-001707`），
// 一个原件四五种写法，清理逻辑只要按「.bak 之前那截」分组就会把同一原件拆成好几组，
// 于是永远删不掉。这组测试就是防止有人再往名字里乱加东西。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupGroupKey, pruneStateBackups } from './backup-state.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backup-prune-'));

function seed(dir, names, baseDate = new Date(2020, 0, 1)) {
  names.forEach((name, i) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    const t = (baseDate.getTime() + i * 60_000) / 1000;
    fs.utimesSync(file, t, t);   // 每份差一分钟，顺序确定
  });
}

test('分组键：新写法与老写法都归到原件上', () => {
  const cases = new Map([
    ['config.json.20261026-131500.bak', 'config.json'],
    ['config.json.20261026-131500-wake-limit.bak', 'config.json'],
    ['config.json.bak-wake-limit-1792979576643', 'config.json'],
    ['bridge.js.bak-restart-selfheal-20261026-095857', 'bridge.js'],
    ['sessions.json.bak-bindtest-20261026-001707', 'sessions.json'],
    ['sticker-lib.js.20261025-001041-before-slim.bak', 'sticker-lib.js'],
  ]);
  for (const [file, want] of cases) assert.equal(backupGroupKey(file), want, `${file} 应归到 ${want}`);
});

test('不认识的写法整名当归，宁可少删', () => {
  assert.equal(backupGroupKey('weird.bak.something'), 'weird');
  assert.equal(backupGroupKey('plain.json.bak'), 'plain.json');
});

test('同一原件只留最近 keep 份，旧的两份被删', () => {
  const dir = tmp();
  seed(dir, [
    'probe.js.20200101-000001.bak',
    'probe.js.20200102-000001-old.bak',
    'probe.js.20200103-000001-mid.bak',
    'probe.js.20200104-000001-new.bak',
    'probe.js.bak-legacy-20200105',
  ]);
  const removed = pruneStateBackups({ dir, keep: 3 });
  assert.deepEqual(removed.sort(), ['probe.js.20200101-000001.bak', 'probe.js.20200102-000001-old.bak']);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, [
    'probe.js.20200103-000001-mid.bak',
    'probe.js.20200104-000001-new.bak',
    'probe.js.bak-legacy-20200105',
  ]);
});

test('刚备份的那份有冷却期，超了份数也不立刻删', () => {
  const dir = tmp();
  seed(dir, [
    'probe.js.20200101-000001.bak',
    'probe.js.20200102-000001.bak',
    'probe.js.20200103-000001.bak',
    'probe.js.20200104-000001.bak',
  ]);
  // 把最新那份的 mtime 改成现在：它代表"刚备份完"
  const fresh = path.join(dir, 'probe.js.20200104-000001.bak');
  const now = Date.now() / 1000;
  fs.utimesSync(fresh, now, now);
  const removed = pruneStateBackups({ dir, keep: 1 });
  assert.ok(!removed.includes('probe.js.20200104-000001.bak'), '刚备份的那份不该被删');
  assert.ok(fs.existsSync(fresh), '文件还在盘上');
});

test('dryRun 只报告不删', () => {
  const dir = tmp();
  seed(dir, ['a.json.20200101-000001.bak', 'a.json.20200102-000001.bak', 'a.json.20200103-000001.bak']);
  const removed = pruneStateBackups({ dir, keep: 1, dryRun: true });
  assert.equal(removed.length, 2);
  assert.equal(fs.readdirSync(dir).length, 3, 'dryRun 不许真删');
});

test('目录不存在时返回空数组，不抛', () => {
  assert.deepEqual(pruneStateBackups({ dir: path.join(os.tmpdir(), 'backup-prune-no-such-dir') }), []);
});

test('非备份文件不参与分组，也不被删', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
  seed(dir, ['b.json.20200101-000001.bak', 'b.json.20200102-000001.bak']);
  pruneStateBackups({ dir, keep: 1 });
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('b.json')).length, 1);
});