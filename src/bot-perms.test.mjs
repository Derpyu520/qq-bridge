// 「机器人自主操作」权限模型的离线回归（v2：按自主程度分档）。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOT_PERM_ROWS,
  BOT_SCOPES,
  BOT_SCOPE_LABELS,
  DEFAULT_VETO_PROBABILITY,
  allowsSelfService,
  defaultBotPerms,
  describeBotPerms,
  normalizeBotPerms,
  parseVetoRate,
  permissionKeysForAction,
  resolveActionScope,
  scopeOf,
  strictestScope
} from './bot-perms.mjs';

test('默认值：身份类与小动作「不开放」，跨会话「仅应要求」，表情「人设自主」', () => {
  const { scope, unlocked, migrated } = normalizeBotPerms(null);
  for (const key of ['setGroupCard', 'setQqNickname', 'setQqSignature', 'setQqAvatar', 'recallOwnMessage', 'setOnlineStatus']) {
    assert.equal(scope[key], 'none', key);
  }
  for (const key of ['crossSessionSend', 'crossSessionControl', 'crossSessionDelegate']) {
    assert.equal(scope[key], 'request', key);
  }
  assert.equal(scope.collectSticker, 'persona');
  assert.equal(scope.stickerNote, 'persona');
  assert.deepEqual(unlocked, []);
  assert.deepEqual(migrated, []);
});

test('三档枚举与界面文案是唯一一份', () => {
  assert.deepEqual([...BOT_SCOPES], ['none', 'request', 'persona']);
  assert.deepEqual({ ...BOT_SCOPE_LABELS }, { none: '不开放', request: '仅应要求', persona: '人设自主' });
  assert.ok(DEFAULT_VETO_PROBABILITY > 0 && DEFAULT_VETO_PROBABILITY < 1);
});

test('旧值迁移：off→none、owner→request、all→persona，并报告迁移过的键', () => {
  const { scope, migrated } = normalizeBotPerms({
    setGroupCard: 'all',
    setQqNickname: 'owner',
    recallOwnMessage: 'off',
    crossSessionSend: 'owner',
    collectSticker: 'all'
  });
  assert.equal(scope.setGroupCard, 'persona');
  assert.equal(scope.setQqNickname, 'request');
  assert.equal(scope.recallOwnMessage, 'none');
  assert.equal(scope.collectSticker, 'persona');
  // 改昵称封顶在 request：旧值 all 也不该把它推到 persona
  assert.equal(scope.setQqNickname, 'request');
  assert.deepEqual(migrated.sort(), ['collectSticker', 'crossSessionSend', 'recallOwnMessage', 'setGroupCard', 'setQqNickname'].sort());
});

test('归一：未知键丢弃、非法值回退默认、合法新值保留', () => {
  const { scope, unknown } = normalizeBotPerms({
    setGroupCard: 'persona',
    recallOwnMessage: 'REQUEST',
    collectSticker: 'none',
    nope: 'persona',
    setQqNickname: 'whatever'
  });
  assert.deepEqual(unknown, ['nope']);
  assert.equal(scope.setGroupCard, 'persona');
  assert.equal(scope.recallOwnMessage, 'request');
  assert.equal(scope.collectSticker, 'none');
  assert.equal(scope.setQqNickname, 'none'); // 非法值回退默认
});

test('封顶：账号级/跨会话动作最高只能到 request，解除封顶后才放行', () => {
  const capped = normalizeBotPerms({ setQqAvatar: 'persona', setOnlineStatus: 'persona', crossSessionSend: 'persona' });
  assert.equal(capped.scope.setQqAvatar, 'request');
  assert.equal(capped.scope.setOnlineStatus, 'request');
  assert.equal(capped.scope.crossSessionSend, 'request');

  const unlocked = normalizeBotPerms({ unlocked: ['setQqAvatar'], scope: { setQqAvatar: 'persona' } });
  assert.equal(unlocked.scope.setQqAvatar, 'persona');
  assert.deepEqual(unlocked.unlocked, ['setQqAvatar']);

  // 可自主的三项本来就没有封顶
  const free = normalizeBotPerms({ setGroupCard: 'persona', recallOwnMessage: 'persona', collectSticker: 'persona' });
  assert.equal(free.scope.setGroupCard, 'persona');
  assert.equal(free.scope.recallOwnMessage, 'persona');
  assert.equal(free.scope.collectSticker, 'persona');
});

test('unlocked 只认已知键，且不影响别的项', () => {
  const { unlocked } = normalizeBotPerms({ unlocked: ['setQqAvatar', 'nope', 'setQqAvatar'], scope: {} });
  assert.deepEqual(unlocked, ['setQqAvatar']);
});

test('scopeOf：未知键回退默认、旧值也能读、超封顶夹回去', () => {
  assert.equal(scopeOf({ scope: {} }, 'setQqAvatar'), 'none');
  assert.equal(scopeOf({ scope: {} }, 'collectSticker'), 'persona');
  assert.equal(scopeOf({ scope: {} }, 'nope'), 'none');
  assert.equal(scopeOf({ scope: { setQqAvatar: 'all' } }, 'setQqAvatar'), 'request');
  assert.equal(scopeOf({ scope: { setQqAvatar: 'persona' }, unlocked: ['setQqAvatar'] }, 'setQqAvatar'), 'persona');
});

test('strictestScope：取最严格的一档', () => {
  assert.equal(strictestScope(['persona', 'request']), 'request');
  assert.equal(strictestScope(['persona', 'none']), 'none');
  assert.equal(strictestScope(['persona', 'persona']), 'persona');
  assert.equal(strictestScope([]), 'none');
  assert.equal(strictestScope(['persona', 'garbage']), 'persona');
});

test('动作 → 权限键：改签名与改昵称是两项', () => {
  assert.deepEqual(permissionKeysForAction('setQqProfile', { nickname: 'x' }), ['setQqNickname']);
  assert.deepEqual(permissionKeysForAction('setQqProfile', { personalNote: '' }), ['setQqSignature']);
  assert.deepEqual(permissionKeysForAction('setQqProfile', { nickname: 'x', personalNote: 'y' }), ['setQqNickname', 'setQqSignature']);
  assert.deepEqual(permissionKeysForAction('recallMessage', {}), ['recallOwnMessage']);
  assert.deepEqual(permissionKeysForAction('setOnlineStatus', {}), ['setOnlineStatus']);
  assert.deepEqual(permissionKeysForAction('unknown', {}), []);
});

test('同时改昵称与签名：任一为不开放就不算放开', () => {
  const perms = normalizeBotPerms({ setQqNickname: 'request', setQqSignature: 'none' });
  assert.equal(resolveActionScope(perms, 'setQqProfile', { nickname: 'a', personalNote: 'b' }).scope, 'none');
  const both = normalizeBotPerms({ setQqNickname: 'request', setQqSignature: 'request' });
  assert.equal(resolveActionScope(both, 'setQqProfile', { nickname: 'a', personalNote: 'b' }).scope, 'request');
});

test('allowsSelfService 矩阵：不开放永不直连，仅应要求看发送者，人设自主都放行', () => {
  assert.equal(allowsSelfService('none', { senderIsOwner: true }), false);
  assert.equal(allowsSelfService('none', { senderIsOwner: false }), false);
  assert.equal(allowsSelfService('request', { senderIsOwner: true }), true);
  assert.equal(allowsSelfService('request', { senderIsOwner: false }), false);
  assert.equal(allowsSelfService('persona', { senderIsOwner: true }), true);
  assert.equal(allowsSelfService('persona', { senderIsOwner: false }), true);
  assert.equal(allowsSelfService('whatever', { senderIsOwner: true }), false);
});

test('parseVetoRate：百分比、小数、整数、越界与垃圾值', () => {
  assert.equal(parseVetoRate('15%'), 0.15);
  assert.equal(parseVetoRate('0.15'), 0.15);
  assert.equal(parseVetoRate('15'), 0.15);
  assert.equal(parseVetoRate('100%'), 1);
  assert.equal(parseVetoRate('0%'), 0);
  assert.equal(parseVetoRate('250%'), 1);
  assert.equal(parseVetoRate(''), DEFAULT_VETO_PROBABILITY);
  assert.equal(parseVetoRate('随便'), DEFAULT_VETO_PROBABILITY);
  assert.equal(parseVetoRate('', 0), 0);
});

test('describeBotPerms 覆盖每一行，带当前值、封顶与解锁标记', () => {
  const rows = describeBotPerms(normalizeBotPerms({ setGroupCard: 'all' }));
  assert.equal(rows.length, BOT_PERM_ROWS.length);
  const card = rows.find((r) => r.key === 'setGroupCard');
  assert.equal(card.scope, 'persona');
  assert.equal(card.maxScope, 'persona');
  assert.equal(card.unlocked, false);
  assert.equal(rows.find((r) => r.key === 'setQqAvatar').scope, 'none');
  assert.equal(rows.find((r) => r.key === 'setQqAvatar').maxScope, 'request');
  assert.ok(rows.every((r) => r.label && r.group && r.maxScope));
});

test('defaultBotPerms 返回一份可改的副本', () => {
  const a = defaultBotPerms();
  a.setQqAvatar = 'persona';
  assert.equal(defaultBotPerms().setQqAvatar, 'none');
});
