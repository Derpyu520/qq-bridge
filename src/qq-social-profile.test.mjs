// QQ 资料 / 头像 / QQ 空间的纯逻辑回归（无网络、无文件系统）。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROFILE_LIMITS,
  accountYears,
  cleanText,
  isQqId,
  normalizeQqId,
  normalizeQzoneContent,
  normalizeQzonePostArgs,
  normalizeQzoneTargetUins,
  normalizeUgcRight,
  onlineStatusLabel,
  sanitizeProfile,
  sanitizeQzoneFeed,
  sanitizeQzoneFeedList,
  sanitizeQzonePostList,
  stripQzoneFeedText,
  ugcRightLabel
} from './qq-social-profile.mjs';

test('QQ 号规范化：只认十进制，不接受 0/空白/@/超长', () => {
  assert.equal(normalizeQqId(1000000001), '1000000001');
  assert.equal(normalizeQqId(' 12345 '), '12345');
  for (const bad of [0, '0', '', null, undefined, '12a', '-1', '1234567890123', '@123']) {
    assert.throws(() => normalizeQqId(bad), /1~12 位数字/);
  }
  assert.equal(isQqId('123'), true);
  assert.equal(isQqId('0123'), false);
});

test('cleanText：去控制字符/零宽字符、折叠空白、保留换行、限长加省略号', () => {
  assert.equal(cleanText('  a\u0000b  \u200b c ', 100), 'a b c');
  assert.equal(cleanText('第一行\n\n第二行', 100), '第一行\n\n第二行');
  assert.equal([...cleanText('1234567890', 5)].length, 5);
  assert.ok(cleanText('1234567890', 5).endsWith('…'));
});

test('资料白名单：只保留聊天需要的字段，uid/企业/电量等一概不出现', () => {
  const raw = {
    user_id: 1000000001,
    uid: 'u_abc',
    qid: 'qid_abc',
    nickname: '科技虫',
    remark: 'm',
    sex: 'male',
    age: 0,
    long_nick: "here's to the crime",
    qq_level: 59,
    level: 59,
    reg_time: 1451640197,
    is_vip: false,
    vip_level: 0,
    status: 40,
    batteryStatus: 88,
    qidian_enterprise_name: '某公司',
    customStatus: { id: 1 }
  };
  const p = sanitizeProfile(raw, { now: Date.UTC(2026, 0, 1) });
  assert.equal(p.userId, '1000000001');
  assert.equal(p.nickname, '科技虫');
  assert.equal(p.sexLabel, '男');
  assert.equal(p.level, 59);
  assert.equal(p.signature, "here's to the crime");
  assert.equal(p.online.label, '隐身');
  assert.equal(p.accountYears, 10);
  for (const key of ['uid', 'qid', 'batteryStatus', 'qidian_enterprise_name', 'customStatus', 'reg_time']) {
    assert.equal(key in p, false, `不应透传 ${key}`);
  }
});

test('资料容错：缺失字段为 null，脏 QQ 号返回 null，超长签名被截断', () => {
  assert.equal(sanitizeProfile({ nickname: '无号' }), null);
  assert.equal(sanitizeProfile(null), null);
  const p = sanitizeProfile({ user_id: '123', nickname: 'n'.repeat(80), long_nick: 's'.repeat(500), age: 999, status: 'x' });
  assert.equal([...p.nickname].length, PROFILE_LIMITS.nickname);
  assert.equal([...p.signature].length, PROFILE_LIMITS.signature);
  assert.equal(p.age, null);
  assert.equal(p.online.label, '未知');
  assert.equal(p.accountYears, null);
});

test('在线状态码映射与 Q 龄计算（未来/过早时间一律 null）', () => {
  assert.equal(onlineStatusLabel(10), '在线');
  assert.equal(onlineStatusLabel(50), '忙碌');
  assert.equal(onlineStatusLabel(999), '未知');
  assert.equal(accountYears(0), null);
  assert.equal(accountYears(Date.now() / 1000 + 86400), null);
  assert.equal(accountYears(Date.UTC(1999, 0, 1) / 1000), null);
  assert.equal(accountYears(Date.UTC(2020, 5, 1) / 1000, Date.UTC(2026, 4, 1)), 5);
});

test('可见范围：只认 1/4/16/64/128，默认 1，中文标签唯一一份', () => {
  assert.equal(normalizeUgcRight(undefined), 1);
  assert.equal(normalizeUgcRight('4'), 4);
  assert.equal(ugcRightLabel(16), '部分好友可见');
  assert.equal(ugcRightLabel(64), '仅自己可见');
  for (const bad of [0, 2, 32, 'public', 999]) assert.throws(() => normalizeUgcRight(bad), /ugcRight/);
  // 16/128 必须带名单；其它范围传了名单也忽略。
  assert.throws(() => normalizeQzoneTargetUins([], { ugcRight: 16 }), /targetUins/);
  assert.deepEqual(normalizeQzoneTargetUins(['111', '111', 'bad', 222], { ugcRight: 16 }), [111, 222]);
  assert.deepEqual(normalizeQzoneTargetUins([111], { ugcRight: 1 }), []);
});

test('说说正文：保留换行、拒绝空白、超长直接报错（不悄悄截断）', () => {
  assert.equal(normalizeQzoneContent('第一段\n第二段'), '第一段\n第二段');
  assert.throws(() => normalizeQzoneContent('   \n  '), /不能为空/);
  assert.throws(() => normalizeQzoneContent('字'.repeat(11), { maxChars: 10 }), /最多 10 字/);
});

test('好友动态 HTML 清洗：抽正文、去作者/时间/浏览计数', () => {
  const html = '<div class="user-info"><a class="f-name">示例群友</a>'
    + '<span class="state">昨天 23:43</span></div>'
    + '<div class="f-info"> 示例群友，没有手也没有脚 </div>'
    + '<span>浏览3次</span><span>共 1 人觉得很赞</span><span>评论</span>';
  const text = stripQzoneFeedText(html, { nickname: '示例群友' });
  assert.equal(text, '示例群友，没有手也没有脚');
  // 「评论区」是正文，不能被当成按钮截断；结尾的按钮串只从尾部剥。
  assert.equal(stripQzoneFeedText('<div>评论区笑死</div><span>点赞</span><span>评论</span>'), '评论区笑死');
  assert.equal(stripQzoneFeedText('<div>今天去看了海</div><span>点赞 评论 转发</span>'), '今天去看了海');
});

test('好友动态：坏数据被丢弃，图片数量只算内容图（头像不算）', () => {
  const feed = {
    uin: 1000000001,
    nickname: '科技虫',
    time: 1792942998,
    appid: 311,
    html: '<a class="user-avatar q_namecard"><img src="https://qlogo2.store.qq.com/qzone/1000000001/1000000001/50?1"></a>'
      + '<div>今天去看了海</div><img src="https://photo.store.qq.com/b.jpg"><img src="https://photo.store.qq.com/c.jpg">'
  };
  const item = sanitizeQzoneFeed(feed);
  assert.equal(item.userId, '1000000001');
  assert.equal(item.text, '今天去看了海');
  assert.equal(item.imageCount, 2);
  // 只有头像、没有内容图的动态不该显示 imageCount
  const avatarOnly = sanitizeQzoneFeed({ uin: 1, html: '<img src="https://qlogo2.store.qq.com/qzone/1/1/50">' });
  assert.equal('imageCount' in avatarOnly, false);
  assert.equal(sanitizeQzoneFeed(null), null);
  const list = sanitizeQzoneFeedList({ data: { feeds: [feed, { nope: 1 }] } }, { limit: 1 });
  assert.equal(list.returned, 1);
  assert.equal(list.truncated, true);
});

test('说说列表：两种外层形状都认，条数被 limit 夹住', () => {
  const raw = {
    data: {
      total: 12,
      msglist: [
        { tid: 't1', content: '第一', time: 1792942998, comment_num: 2, is_private: false, images: [{}, {}] },
        { tid: 't2', content: '第二', time: 1792854760, comment_num: 0, is_private: true, images: [] }
      ]
    }
  };
  const out = sanitizeQzonePostList(raw, { limit: 1 });
  assert.equal(out.total, 12);
  assert.equal(out.returned, 1);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.posts[0], { tid: 't1', content: '第一', time: 1792942998, commentCount: 2, private: false, imageCount: 2 });
  const flat = sanitizeQzonePostList([{ tid: 't3', content: '裸数组' }], { limit: 5 });
  assert.equal(flat.posts[0].content, '裸数组');
});

test('发说说参数归一：图片数量/总大小、权限名单、正文一起校验', () => {
  const args = normalizeQzonePostArgs({ content: '今天也要好好摸鱼', images: ['a.png'] }, {
    resolveMedia: (name) => ({ name, rel: name, bytes: 10 })
  });
  assert.equal(args.ugcRight, 1);
  assert.deepEqual(args.targetUins, []);
  assert.deepEqual(args.images.map((i) => i.name), ['a.png']);
  assert.throws(() => normalizeQzonePostArgs({ content: 'x', images: Array.from({ length: 10 }, (_, i) => `${i}.png`) }), /最多 9 张/);
  assert.throws(() => normalizeQzonePostArgs({ content: 'x', ugcRight: 128 }), /targetUins/);
  assert.throws(() => normalizeQzonePostArgs({ content: 'x', images: ['big.png'] }, {
    resolveMedia: () => ({ name: 'big.png', bytes: 13 * 1024 * 1024 })
  }), /总大小/);
});
