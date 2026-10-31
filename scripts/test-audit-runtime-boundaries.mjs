// 离线验证会话资料与语音库路径边界，不连接 QQ/DSH 或读取真实配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSlangContext, createSlangEntry, loadSlang, saveSlang, upsertSlangEntry
} from '../src/slang-learner.js';
import { applyStickerNote, formatStickerList, stickerForScope } from '../src/sticker-lib.js';
import { safeJoinLibrary } from '../src/voice-core.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-runtime-boundaries-'));
try {
  check('createSlangEntry preserves the submitting conversation scope', () => {
    const entry = createSlangEntry({ content: '测试梗', meaning: 'A 的私有含义', status: 'confirmed', scope: 'group:101' });
    assert.equal(entry.scope, 'group:101');
    assert.match(buildSlangContext([entry], 8, 'group:101'), /A 的私有含义/);
    assert.equal(buildSlangContext([entry], 8, 'group:202'), '');
    assert.equal(createSlangEntry({ content: '旧全局词' }).scope, 'global');
  });

  check('identical slang terms remain independent across conversations', () => {
    const entries = [];
    const a = upsertSlangEntry(entries, '同一个梗', {
      scope: 'group:101', meaning: 'A 的含义', status: 'confirmed', evidence: [{ text: 'A 的语境' }]
    });
    const b = upsertSlangEntry(entries, '同一个梗', {
      scope: 'group:202', meaning: 'B 的含义', status: 'confirmed', evidence: [{ text: 'B 的语境' }]
    });
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.notEqual(a.entry.id, b.entry.id);
    assert.equal(entries.length, 2);
    const again = upsertSlangEntry(entries, '同一个梗', { scope: 'group:101', evidence: [{ text: 'A 的新语境' }] });
    assert.equal(again.created, false);
    assert.equal(again.entry.count, 2);
    assert.equal(entries[1].count, 1);
    const contextB = buildSlangContext(entries, 8, 'group:202');
    assert.match(contextB, /B 的含义/);
    assert.doesNotMatch(contextB, /A 的含义/);
    assert.deepEqual(entries[1].evidence, [{ text: 'B 的语境' }]);
    const file = path.join(tmp, 'slang.json');
    saveSlang(file, entries);
    assert.deepEqual(loadSlang(file).map((e) => e.scope), ['group:101', 'group:202']);
  });

  check('scoped slang never overwrites a legacy global definition', () => {
    const entries = [createSlangEntry({ content: '同词', meaning: '公开解释', status: 'confirmed' })];
    const result = upsertSlangEntry(entries, '同词', { scope: 'private:303', meaning: '私聊解释' });
    assert.equal(result.created, true);
    assert.equal(entries[0].scope, 'global');
    assert.equal(entries[0].meaning, '公开解释');
    assert.equal(result.entry.scope, 'private:303');
  });

  check('slang identity uses its stored normalized content', () => {
    const entries = [];
    const content = '长'.repeat(70);
    upsertSlangEntry(entries, content, { scope: 'group:101' });
    upsertSlangEntry(entries, content, { scope: 'group:101' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].count, 2);
  });

  const sticker = {
    id: 'test-face', desc: 'QQ 公共备注', localNote: 'A 私有笔记', usage: 'A 私有用法',
    tags: ['A私有标签'], noteScope: 'group:101', lastContext: '最近使用的私有语境'
  };
  check('sticker list and image metadata hide other conversations notes', () => {
    const hidden = stickerForScope(sticker, 'group:202');
    assert.equal(hidden.desc, 'QQ 公共备注');
    assert.equal(hidden.localNote, '');
    assert.equal(hidden.usage, '');
    assert.equal(hidden.lastContext, '');
    assert.deepEqual(hidden.tags, []);
    assert.doesNotMatch(JSON.stringify(hidden), /group:101/);
    assert.equal(stickerForScope(sticker, 'group:101').localNote, 'A 私有笔记');
    assert.equal(stickerForScope(sticker, 'group:101').lastContext, '');
    assert.equal(stickerForScope(sticker).lastContext, '最近使用的私有语境');
    assert.equal(formatStickerList([sticker], '私有', 10, 'group:202').matched, 0);
    assert.equal(formatStickerList([sticker], '私有', 10, 'group:101').matched, 1);
    assert.equal(formatStickerList([sticker], '私有', 10).matched, 1);
    assert.equal(sticker.localNote, 'A 私有笔记');
  });

  check('partial sticker updates cannot reassign another scopes private fields', () => {
    const changed = applyStickerNote([sticker], sticker.id, { noteScope: 'group:202', tags: ['B标签'] }).entry;
    assert.equal(changed.noteScope, 'group:202');
    assert.equal(changed.localNote, '');
    assert.equal(changed.usage, '');
    assert.equal(changed.lastContext, '');
    assert.deepEqual(changed.tags, ['B标签']);
    assert.equal(changed.desc, 'QQ 公共备注');
    const sameScope = applyStickerNote([sticker], sticker.id, { tags: ['新标签'] }).entry;
    assert.equal(sameScope.localNote, 'A 私有笔记');
    assert.equal(sameScope.noteScope, 'group:101');
  });

  const library = path.join(tmp, 'library');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(library);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(library, 'inside'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, path.join(library, 'escape'), linkType);
  fs.symlinkSync(path.join(library, 'inside'), path.join(library, 'alias'), linkType);
  check('new audio paths reject a symlink parent escaping the library', () => {
    assert.equal(safeJoinLibrary(library, 'escape/new.mp3'), null);
    assert.equal(safeJoinLibrary(library, 'escape/new/sub/new.mp3'), null);
    assert.equal(safeJoinLibrary(library, '../outside/new.mp3'), null);
    assert.equal(safeJoinLibrary(library, 'alias/new.mp3'), path.join(library, 'inside', 'new.mp3'));
    assert.equal(safeJoinLibrary(library, 'new/sub/new.mp3'), path.join(library, 'new', 'sub', 'new.mp3'));
    assert.equal(safeJoinLibrary(path.join(tmp, 'new-library'), 'new.mp3'), path.join(tmp, 'new-library', 'new.mp3'));
  });
  check('dangling library links fail closed for new files', () => {
    fs.symlinkSync(path.join(outside, 'missing'), path.join(library, 'dangling'), linkType);
    assert.equal(safeJoinLibrary(library, 'dangling/new.mp3'), null);
  });
} finally {
  // tmp is created by this test directly below os.tmpdir(); junctions are not traversed by rm.
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nRuntime boundary regressions: ${passed} passed`);
