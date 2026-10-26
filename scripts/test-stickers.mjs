// 表情包体系自检：
// 1) sticker-lib 纯函数（合并/查找/格式化/笔记/使用统计）
// 2) 配置项与 MCP 工具描述存在性
// 3) 可选 live 模式：QQ_BRIDGE_TEST_LIVE=1 时调用 SnowLuma 拉取收藏表情并验证 safeFetchBuffer 可抓图
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  stickerPersonaScore,
  buildStickerStrategyHint,
  STICKER_SEND_MODES,
  STICKER_SEND_MODE_ORDER,
  normalizeStickerSendMode,
  resolveStickerSendPolicy,
  describeStickerSendPolicy,
  buildStickerFrequencyLine,
  applyStickerNote,
  markStickerUsed
} from '../src/sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## sticker-lib 纯函数');
{
  const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
  ok(raw && raw.id === 'a' && raw.desc === '笑死' && raw.localNote === '嘲讽', 'normalizeStickerEntry 基本字段');
  ok(normalizeStickerEntry({}) === null, '空记录返回 null');
}

{
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' }
  ]);
  ok(base.length === 2, 'merge 新增两条');
  const merged = mergeStickerLibrary(base, [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }
  ]);
  ok(merged.length === 1, 'merge 会移除 QQ 端已删除的表情');
  ok(merged[0].id === 'a' && merged[0].url === 'https://x/a2' && merged[0].desc === '笑哭', 'merge 更新 QQ 字段');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }
  ]);
  ok(findSticker(list, 'a')?.id === 'a', '按 emoji_id 查找');
  ok(findSticker(list, 'abc')?.id === 'a', '按 md5 大小写不敏感查找');
  ok(findSticker(list, 'https://x/b')?.id === 'b', '按 URL 查找');
  ok(findSticker(list, '不存在') === null, '找不到返回 null');
}

{
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', md5: 'GHI', desc: '', localNote: '无语' })
  ];
  const all = formatStickerList(list, '', 10);
  ok(all.total === 3 && all.stickers.length === 3, 'formatStickerList 总数');
  const q = formatStickerList(list, '生气', 10);
  ok(q.matched === 1 && q.stickers[0].id === 'b', 'formatStickerList 按备注搜索');
  const q2 = formatStickerList(list, '无语', 10);
  ok(q2.matched === 1 && q2.stickers[0].id === 'c', 'formatStickerList 按本地笔记搜索');
  const ctx = buildStickerContext(list, 8);
  ok(ctx.includes('笑死') && ctx.includes('生气'), 'buildStickerContext 包含备注');
  ok(buildStickerStrategyHint().includes('qq_send_sticker'), '策略提示包含发送工具');
  ok(buildStickerStrategyHint().includes('qq_delete_sticker'), '策略提示包含删除工具（清理收藏）');
  ok(buildStickerStrategyHint().includes('不可恢复'), '策略提示说明删除不可恢复');
}

console.log('## 表情清单按人格优先');
{
  // 复现真实场景：13 张用过很多次的旧图 + 16 张刚收、useCount=0 的角色专属图。
  // 旧排序下专属图一张都进不了前 8，模型只好拿别人的图凑。
  const used = Array.from({ length: 13 }, (_, i) => normalizeStickerEntry({
    emoji_id: 'u' + i, resId: 'u' + i, url: 'https://x/u' + i, desc: '旧图' + i, useCount: 5
  }));
  const mine = Array.from({ length: 16 }, (_, i) => normalizeStickerEntry({
    emoji_id: 'm' + i, resId: 'm' + i, url: 'https://x/m' + i, desc: '测试角色甲专属 图' + i, useCount: 0
  }));
  const list = [...used, ...mine];

  const legacy = buildStickerContext(list, 8);
  ok(!legacy.includes('测试角色甲专属'), '不传 persona 时保持旧行为：专属仍排不进前 8');
  ok(buildStickerContext(list, 8).includes('【可用表情包】'), '第三参数可省略（兼容旧调用）');

  const scoped = buildStickerContext(list, 8, { persona: '测试角色甲' });
  const shown = [...scoped.matchAll(/^- 测试角色甲专属 图\d+$/gm)].length;
  ok(shown === 8, `persona 优先：8 个槽全给专属（实际 ${shown}）`);
  ok(scoped.includes('其中 8 个标了「测试角色甲」'), '提示词说明这几个是该角色自己的图');

  // 没登记别名的新人格也要能命中（靠公共子串），否则收一张新表情又得改代码
  ok(stickerPersonaScore(
    normalizeStickerEntry({ emoji_id: 's', resId: 's', url: 'https://x/s', desc: '测试角色甲专属 在座的都是垃圾' }),
    '测试角色甲'
  ) > 0, '公共子串兜底：测试角色甲 ↔ 测试角色甲专属');

  // 别名：角色名跟备注对不上（小鲸鱼 ↔ 备注里的 deepseek）
  const duo = [
    normalizeStickerEntry({ emoji_id: 'q', resId: 'q', url: 'https://x/q', desc: 'deepseek 白饭图', useCount: 0 }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', desc: '猫猫震惊', useCount: 99 })
  ];
  ok(buildStickerContext(duo, 1, { persona: '小鲸鱼' }).includes('deepseek 白饭图'), '别名命中：小鲸鱼 → deepseek');
  ok(buildStickerContext(duo, 1).includes('猫猫震惊'), '同一份数据不传 persona 时仍按 useCount 排');

  // 没有任何专属表情的角色：退回普通列表，不能把摘要变空
  const plain = [normalizeStickerEntry({ emoji_id: 'p', resId: 'p', url: 'https://x/p', desc: '猫猫震惊', useCount: 3 })];
  ok(buildStickerContext(plain, 8, { persona: '测试角色乙' }).includes('猫猫震惊'), '没有专属表情时退回普通列表（不饿死）');
  ok(buildStickerContext(plain, 8, { persona: '测试角色乙' }).includes('都是常用/有备注的'), '无匹配时不虚构“标了你的名字”');

  // 传入不存在的角色名也别崩
  ok(buildStickerContext(list, 8, { persona: '' }).includes('【可用表情包】'), 'persona 为空等价旧行为');
}

console.log('## 发送频率档位');
{
  ok(JSON.stringify(STICKER_SEND_MODE_ORDER) === JSON.stringify(['off', 'low', 'normal', 'high', 'persona']), '档位顺序固定：off/low/normal/high/persona');
  ok(STICKER_SEND_MODES.persona.label === '完全根据人设来', 'persona 档中文名');
  ok(normalizeStickerSendMode('PERSONA') === 'persona', '档位大小写不敏感');
  ok(normalizeStickerSendMode('乱写') === 'normal', '非法档位回退 normal');
  ok(normalizeStickerSendMode(undefined) === 'normal', '缺省档位是 normal');

  const low = resolveStickerSendPolicy('low');
  ok(low.maxPer10Min === 2 && low.minGapMs === 45000, 'low = 2 张 / 45 秒');
  const normal = resolveStickerSendPolicy('normal');
  ok(normal.maxPer10Min === 6 && normal.minGapMs === 3000, 'normal = 6 张 / 3 秒');
  const high = resolveStickerSendPolicy('high');
  ok(high.maxPer10Min === 15 && high.minGapMs === 1000, 'high = 15 张 / 1 秒');
  const off = resolveStickerSendPolicy('off');
  ok(off.maxPer10Min === 0 && off.minGapMs === 0, 'off = 不发表情');
  const persona = resolveStickerSendPolicy('persona');
  ok(persona.maxPer10Min === null && persona.minGapMs === 0, 'persona 默认不设档位上限');
  const overridden = resolveStickerSendPolicy('low', { maxPer10Min: 0, minGapMs: 0 });
  ok(overridden.maxPer10Min === 0 && overridden.minGapMs === 0, '高级覆盖 0 = 关闭该项');
  const personaCapped = resolveStickerSendPolicy('persona', { maxPer10Min: 3 });
  ok(personaCapped.maxPer10Min === 3, 'persona 也能被高级覆盖兜底');
  ok(describeStickerSendPolicy(persona).includes('人设'), 'describeStickerSendPolicy 描述 persona');
  ok(describeStickerSendPolicy(normal).includes('6 张'), 'describeStickerSendPolicy 描述上限');

  ok(buildStickerStrategyHint('low').includes('8~12 轮'), 'low 提示词给 8~12 轮');
  ok(buildStickerStrategyHint('normal').includes('3~5 轮'), 'normal 提示词给 3~5 轮');
  ok(buildStickerStrategyHint('high').includes('1~2 轮'), 'high 提示词给 1~2 轮');
  ok(buildStickerStrategyHint('off').includes('不要调用 qq_send_sticker'), 'off 提示词明确禁止发送');
  ok(!buildStickerStrategyHint('off').includes('qq_send_sticker 一条只能一张'), 'off 提示词不再教怎么发');
  const personaHint = buildStickerStrategyHint('persona');
  ok(personaHint.includes('人设') && !personaHint.includes('3~5 轮'), 'persona 提示词交给人设、不给固定轮数');
  for (const mode of STICKER_SEND_MODE_ORDER) {
    ok(buildStickerStrategyHint(mode).includes('表情包策略'), `${mode} 提示词有策略标题`);
  }
  ok(buildStickerFrequencyLine('low').includes('8~12 轮'), '单行档位提示：low');
  ok(buildStickerFrequencyLine('persona').includes('人设'), '单行档位提示：persona');
  ok(buildStickerFrequencyLine('off').includes('不要调用 qq_send_sticker'), '单行档位提示：off');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }
  ]);
  const noted = applyStickerNote(list, 'a', { note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
  ok(noted.entry.localNote === '嘲讽用' && noted.entry.tags.includes('怼人'), 'applyStickerNote 写入本地认知');
  const used = markStickerUsed(noted.entries, 'a', '接梗');
  ok(used.entry.useCount === 1 && used.entry.lastContext === '接梗', 'markStickerUsed 记录使用');
}

console.log('## 配置文件');
{
  // 读**模板**而不是运行中的 config.json：后者是用户自己改过的（例如本机把
  // setStickerRemark 打开了），拿它断言「默认值」会永远红，且红得没有意义。
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const tools = cfg.socialV2?.tools ?? {};
  ok(tools.listStickers === true, 'config.example listStickers=true');
  ok(tools.getStickerImage === true, 'config.example getStickerImage=true');
  ok(tools.sendSticker === true, 'config.example sendSticker=true');
  ok(tools.stickerNote === true, 'config.example stickerNote=true');
  ok(tools.collectSticker === true, 'config.example collectSticker=true');
  ok(tools.deleteSticker === true, 'config.example deleteSticker=true（默认开启）');
  ok(tools.setStickerRemark === false, 'config.example setStickerRemark=false（默认禁用）');
  ok(cfg.socialV2?.sticker?.enabled === true, 'config.example sticker.enabled=true');
  const del = cfg.socialV2?.sticker?.delete ?? {};
  ok(del.enabled === true && del.maxPerMinute === 1 && del.maxPerHour === 5 && del.maxPerDay === 20, 'config.example sticker.delete 默认 1/5/20');
  const send = cfg.socialV2?.sticker?.send ?? {};
  ok(send.mode === 'normal' && send.maxPer10Min === null && send.minGapMs === null, 'config.example sticker.send 默认 normal（高级覆盖为 null）');
  ok(!('sendCaptionMaxChars' in (cfg.socialV2?.sticker ?? {})), 'config.example sticker 不再包含 sendCaptionMaxChars');
}

console.log('## 表情单气泡约束');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const sendStickerBlock = mcp.slice(mcp.indexOf("'qq_send_sticker'"), mcp.indexOf("'qq_sticker_note'"));
  ok(!sendStickerBlock.includes('message: z.string()'), 'qq_send_sticker MCP 不再接受 message 参数');
  ok(sendStickerBlock.includes('不能在同一气泡里附带文字'), 'qq_send_sticker 描述强调单气泡');
  const hint = buildStickerStrategyHint();
  ok(hint.includes('不能在同一气泡里附带文字'), '策略提示禁止同气泡混文字');
  ok(!hint.includes('先发一句话再发一张'), '策略提示不再引导“先发一句话再发一张”');
}

console.log('## MCP 工具描述存在性');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  for (const name of ['qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_sticker_note', 'qq_set_sticker_remark', 'qq_collect_sticker', 'qq_delete_sticker']) {
    ok(mcp.includes(`'${name}'`) || mcp.includes(`"${name}"`), `MCP 工具 ${name} 已注册`);
  }
  ok(mcp.includes("qq_delete_sticker: 'deleteSticker'"), 'qq_delete_sticker 登记了注册期开关');
}

console.log('## bridge 路由/函数存在性');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  for (const s of ['/api/socialV2/sticker-list', '/api/socialV2/sticker-image', '/api/socialV2/sticker-note', '/api/socialV2/send-sticker', '/api/socialV2/sticker-remark', '/api/socialV2/delete-sticker', '/api/stickers', 'syncStickerLibrary', 'sendStickerV2', 'deleteStickerV2', 'stickerDeleteQuota']) {
    ok(bridge.includes(s), `bridge 包含 ${s}`);
  }
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：SnowLuma 收藏表情链路');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const res = await fetch(`${base}/fetch_custom_face_detail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 5 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    ok(res.ok && body.status === 'ok' && body.retcode === 0, 'fetch_custom_face_detail 调用成功');
    const items = Array.isArray(body.data) ? body.data : [];
    ok(items.length > 0, `返回 ${items.length} 个收藏表情`);
    if (items.length > 0) {
      const { safeFetchBuffer } = await import('../src/safe-fetch.js');
      try {
        const img = await safeFetchBuffer(items[0].url, 4 * 1024 * 1024);
        ok(img.buffer.length > 0, `可抓取表情图片字节（${img.buffer.length} bytes）`);
      } catch (e) {
        ok(false, `safeFetchBuffer 抓取表情失败: ${e.message}`);
      }
    }
  } catch (e) {
    ok(false, `live 链路异常: ${e.message}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
