import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGroupStore, MAX_TEXT_CHARS } from './group-store.mjs';

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-group-store-'));
  const store = createGroupStore({ file: join(dir, 'history.db') });
  try {
    return run(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const NOW = Date.now();
const msg = (over = {}) => ({
  convKey: 'group:681528723',
  messageId: '1001',
  seq: 1,
  ts: NOW,
  userId: '777',
  nickname: '老王',
  kind: 'group',
  text: '在吗',
  ...over,
});

test('落一条就能按会话取回来，顺序是最老在前', () => {
  withStore((store) => {
    store.append(msg({ messageId: '1002', seq: 2, ts: NOW + 100, text: '第二句' }));
    store.append(msg({ messageId: '1001', seq: 1, ts: NOW, text: '第一句' }));
    const rows = store.recent('group:681528723', 10);
    assert.deepEqual(rows.map((r) => r.text), ['第一句', '第二句']);
    assert.equal(rows[0].nickname, '老王');
    assert.equal(rows[0].isSelf, false);
  });
});

test('同一个 message_id 二次到达只落一条', () => {
  withStore((store) => {
    assert.equal(store.append(msg()), true);
    assert.equal(store.append(msg({ text: '重复投递' })), false);
    assert.equal(store.count('group:681528723'), 1);
    assert.equal(store.stats().duplicates, 1);
  });
});

test('没有 message_id 的记录允许重复（宁可多记，不能丢）', () => {
  withStore((store) => {
    assert.equal(store.append(msg({ messageId: undefined })), true);
    assert.equal(store.append(msg({ messageId: undefined })), true);
    assert.equal(store.count('group:681528723'), 2);
  });
});

test('不同会话之间不会串', () => {
  withStore((store) => {
    store.append(msg());
    store.append(msg({ convKey: 'private:3475994805', messageId: 'a', seq: undefined, kind: 'private' }));
    assert.deepEqual(store.recent('group:681528723', 10).map((r) => r.messageId), ['1001']);
    assert.deepEqual(store.recent('private:3475994805', 10).map((r) => r.messageId), ['a']);
    assert.equal(store.recent('group:nobody', 10).length, 0);
  });
});

test('保留期之外的会被清掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-group-store-'));
  const day = 24 * 60 * 60 * 1000;
  const base = 1_760_000_000_000;
  const store = createGroupStore({ file: join(dir, 'history.db'), retentionDays: 7, now: () => base });
  try {
    store.append(msg({ messageId: 'old', ts: base - 30 * day }));
    store.append(msg({ messageId: 'fresh', ts: base - day }));
    assert.equal(store.count('group:681528723'), 1);
    assert.deepEqual(store.recent('group:681528723', 10).map((r) => r.messageId), ['fresh']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('超长文本截断，别把数据库撑爆', () => {
  withStore((store) => {
    store.append(msg({ text: 'x'.repeat(MAX_TEXT_CHARS + 500) }));
    assert.equal(store.recent('group:681528723', 1)[0].text.length, MAX_TEXT_CHARS);
  });
});

test('limit 会被夹在 1..200', () => {
  withStore((store) => {
    for (let i = 0; i < 5; i += 1) store.append(msg({ messageId: `m${i}`, ts: NOW + i }));
    assert.equal(store.recent('group:681528723', 0).length, 1);
    assert.equal(store.recent('group:681528723', 999).length, 5);
  });
});

test('文件打不开时安静地退化成空，不往主流程抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-group-store-'));
  const errors = [];
  // 拿一个目录当数据库文件：sqlite 必然打不开。
  const store = createGroupStore({ file: dir, onError: (error) => errors.push(error) });
  try {
    assert.equal(store.append(msg()), false);
    assert.deepEqual(store.recent('group:681528723', 10), []);
    assert.equal(store.count('group:681528723'), 0);
    assert.ok(store.broken, '错误要留痕');
    assert.ok(errors.length > 0);
    assert.equal(store.prune(), 0);
    assert.equal(store.stats().rows, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});