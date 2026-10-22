// B 站视频解析：视频信息 + 热评 + 字幕（登录态）。
//
// 实测结论（2026-10）：
// - `view` / `x/v2/reply` / `playurl` 匿名可用；但 `player/v2` 的 AI 字幕**必须登录**
//   （匿名返回 0 条，带 Cookie 后 ai-zh 就有）。
// - 字幕 URL 形如 `ai-zh://aisubtitle.hdslb.com/...`，要剥掉协议头补 https。
// - 所有请求都要带 Referer: https://www.bilibili.com/ 和桌面 UA，否则容易 412。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const BASE = 'https://api.bilibili.com';
const TV = { 'user-agent': UA, referer: 'https://www.bilibili.com/' };

function fmtDuration(sec) {
  const n = Math.max(0, Number(sec) || 0);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)} 亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  return String(v);
}

function normalizeSubUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  u = u.replace(/^[a-zA-Z0-9_-]+:\/\//, '');
  if (u.startsWith('//')) u = `https:${u}`;
  else if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

export function createBiliClient({ getConfig, stateDir, log = () => {} }) {
  const CACHE_FILE = path.join(stateDir, 'bili-cache.json');
  let cache = null;
  let lastAt = 0;

  const cfg = () => ({ enabled: true, cookie: '', minIntervalMs: 60000, maxVideoMinutes: 30, cacheTtlMs: 24 * 3600 * 1000, ...(getConfig()?.bilibili ?? {}) });

  function loadCache() {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (!cache || typeof cache !== 'object') cache = {};
    } catch {
      cache = {};
    }
    return cache;
  }

  function saveCache() {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8'); } catch (error) { log(`[bili] 缓存写盘失败：${error?.message ?? error}`); }
  }

  function headers() {
    const c = cfg();
    const h = { ...TV };
    const cookie = String(c.cookie || '').trim();
    if (cookie) h.cookie = cookie;
    return h;
  }

  async function getJson(url, timeoutMs = 15000) {
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 412) throw new Error('B 站风控（412）：请求太快或被判定异常，等一会再试');
    const json = await res.json().catch(() => ({}));
    if (json.code !== 0 && json.code !== undefined) throw new Error(`B 站接口返回 ${json.code}：${json.message || '未知错误'}`);
    return json.data;
  }

  // 两道节流，语义不同：
  // - 视频之间：minIntervalMs（默认 60s）——这是账号级礼貌间隔，防连续刷链接被风控；
  // - 同一个视频内部（view → 字幕 → 评论）：800ms，只是别把三个请求打在同一毫秒。
  async function throttleVideo() {
    const c = cfg();
    const gap = Math.max(0, Number(c.minIntervalMs) || 60000) - (Date.now() - lastAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    lastAt = Date.now();
  }

  async function spread() {
    await new Promise((r) => setTimeout(r, 800));
  }

  /** 支持完整链接 / b23.tv 短链 / BV 号 / av 号 */
  async function parseTarget(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('链接或 BV 号不能为空');
    let url = raw;
    const bv = raw.match(/BV[0-9A-Za-z]{10}/);
    if (bv) return { bvid: bv[0] };
    const av = raw.match(/av(\d+)/i);
    if (av) return { aid: Number(av[1]) };
    if (!/^https?:\/\//i.test(raw)) throw new Error('看不出这是 B 站链接或 BV 号');
    // 短链：跟随重定向拿最终 URL
    if (/b23\.tv/i.test(raw)) {
      try {
        const res = await fetch(raw, { headers: headers(), redirect: 'follow', signal: AbortSignal.timeout(15000) });
        url = res.url || raw;
      } catch { /* 用原串继续匹配 */ }
      const m = url.match(/BV[0-9A-Za-z]{10}/);
      if (m) return { bvid: m[0] };
    }
    const m = url.match(/BV[0-9A-Za-z]{10}/) || url.match(/(?:video\/av|^|\/)av(\d+)/i);
    if (m) return m[0].startsWith('BV') ? { bvid: m[0] } : { aid: Number(m[1]) };
    throw new Error('链接里没有找到 BV/av 号');
  }

  async function fetchComments(aid, limit) {
    try {
      const data = await getJson(`${BASE}/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${Math.min(20, limit * 2)}&pn=1`);
      const list = Array.isArray(data?.replies) ? data.replies : [];
      return list
        .filter((r) => r && r.content && r.content.message)
        .slice(0, limit)
        .map((r) => ({ user: r.member?.uname || '匿名', like: Number(r.like) || 0, text: String(r.content.message).replace(/\s+/g, ' ').slice(0, 200) }));
    } catch (error) {
      log(`[bili] 拿评论失败（不影响总结）：${error?.message ?? error}`);
      return [];
    }
  }

  // ── wbi 签名 ───────────────────────────────────────────────────────────────
  // 实测：`/x/player/v2`（未签名）对同一视频有时给 8 条字幕、有时给 1 条且 subtitle_url 为空；
  // 换成带 w_rid 签名的 `/x/player/wbi/v2` 后稳定返回 8 条且 URL 齐全。
  // 这就是「明明有 AI 字幕却报没字幕」的根因。
  const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  let wbiKeys = null;
  let wbiAt = 0;

  async function getWbiMixin() {
    if (wbiKeys && Date.now() - wbiAt < 6 * 3600 * 1000) return wbiKeys;
    const nav = await getJson(`${BASE}/x/web-interface/nav`);
    const img = nav?.wbi_img?.img_url || '';
    const sub = nav?.wbi_img?.sub_url || '';
    const raw = img.split('/').pop().split('.')[0] + sub.split('/').pop().split('.')[0];
    if (raw.length < 64) throw new Error('拿不到 wbi 密钥（nav 未返回 wbi_img）');
    wbiKeys = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
    wbiAt = Date.now();
    return wbiKeys;
  }

  function signQuery(params, mixin) {
    const wts = Math.floor(Date.now() / 1000);
    const all = { ...params, wts };
    const query = Object.keys(all).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    const wRid = crypto.createHash('md5').update(query + mixin).digest('hex');
    return `${query}&w_rid=${wRid}`;
  }

  async function fetchSubtitle(bvid, cid, aid) {
    let subs = [];
    // 优先 wbi 签名端点；失败再退回未签名
    try {
      const mixin = await getWbiMixin();
      const qs = signQuery({ bvid, cid, ...(aid ? { aid } : {}) }, mixin);
      const data = await getJson(`${BASE}/x/player/wbi/v2?${qs}`);
      subs = data?.subtitle?.subtitles || [];
    } catch (error) {
      log(`[bili] wbi 字幕接口失败，退回未签名：${String(error?.message ?? error).slice(0, 100)}`);
    }
    if (!subs.length) {
      try {
        const data = await getJson(`${BASE}/x/player/v2?bvid=${bvid}&cid=${cid}${aid ? `&aid=${aid}` : ''}`);
        subs = data?.subtitle?.subtitles || [];
      } catch (error) {
        log(`[bili] 未签名字幕接口也失败：${String(error?.message ?? error).slice(0, 100)}`);
      }
    }
    if (!subs.length) return null;
    // 有些条目 subtitle_url 为空（服务端偶发），跳过它们
    const usable = subs.filter((s) => String(s.subtitle_url || s.subtitleUrl || '').trim());
    if (!usable.length) {
      log(`[bili] 有 ${subs.length} 条字幕记录但 URL 全为空（通常是未登录/被风控）`);
      return null;
    }
    const pick = usable.find((s) => /^zh-Hans$/i.test(s.lan)) || usable.find((s) => /^zh-CN$/i.test(s.lan))
      || usable.find((s) => /^ai-zh$/i.test(s.lan)) || usable.find((s) => String(s.lan).startsWith('zh')) || usable[0];
    const url = normalizeSubUrl(pick.subtitle_url || pick.subtitleUrl || '');
    if (!url) return null;
    try {
      const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20000) });
      if (!res.ok) { log(`[bili] 字幕文件 HTTP ${res.status}`); return null; }
      const body = await res.json().catch(() => null);
      const items = Array.isArray(body?.body) ? body.body : [];
      if (!items.length) return null;
      const text = items.map((x) => String(x.content || '').trim()).filter(Boolean).join('\n');
      return { lan: pick.lan || 'zh', langName: pick.lan_doc || '', text };
    } catch (error) {
      log(`[bili] 字幕文件拉取失败：${String(error?.message ?? error).slice(0, 120)}`);
      return null;
    }
  }

  /**
   * 解析一个视频，返回给模型看的 digest（不是最终摘要，摘要由模型自己写）。
   */
  async function digest(input) {
    const c = cfg();
    if (c.enabled === false) throw new Error('B 站解析已关闭（config.bilibili.enabled）');
    const target = await parseTarget(input);
    const key = target.bvid || `av${target.aid}`;
    const cached = loadCache()[key];
    if (cached && Date.now() - Number(cached.at) < Number(c.cacheTtlMs || 86400000)) {
      log(`[bili] 命中缓存 ${key}`);
      return { ...cached.value, cached: true };
    }

    await throttleVideo();
    const query = target.bvid ? `bvid=${target.bvid}` : `aid=${target.aid}`;
    const view = await getJson(`${BASE}/x/web-interface/view?${query}`);
    if (!view) throw new Error('拿不到视频信息（可能已删除或仅限登录）');

    const bvid = view.bvid;
    const cid = view.cid;
    const duration = Number(view.duration) || 0;
    const maxSec = Math.max(60, Number(c.maxVideoMinutes) || 30) * 60;
    const truncated = duration > maxSec;

    await spread();
    const subtitle = await fetchSubtitle(bvid, cid, view.aid);
    await spread();
    const comments = await fetchComments(view.aid, 8);

    const desc = String(view.desc || '').replace(/\r/g, '').trim();
    const rawTitle = String(view.title || '').trim();
    const lines = [];
    lines.push(rawTitle.startsWith('《') ? rawTitle : `《${rawTitle}》`);
    lines.push(`UP：${view.owner?.name || '未知'} ｜ 时长 ${fmtDuration(duration)} ｜ 播放 ${fmtCount(view.stat?.view)} ｜ 点赞 ${fmtCount(view.stat?.like)} ｜ 投币 ${fmtCount(view.stat?.coin)} ｜ 发布 ${new Date((view.pubdate || 0) * 1000).toLocaleDateString('zh-CN')}`);
    if (Array.isArray(view.pages) && view.pages.length > 1) {
      lines.push(`分P（${view.pages.length}）：${view.pages.slice(0, 6).map((p) => `${p.page}.${p.part}`).join(' / ')}${view.pages.length > 6 ? ' …' : ''}`);
    }
    if (desc) lines.push(`简介：\n${desc.slice(0, 1200)}`);
    if (Array.isArray(view.tags) && view.tags.length) { /* 不在 view 里，忽略 */ }

    let transcriptText = '';
    if (subtitle?.text) {
      const maxChars = Math.max(1000, Number(c.maxTranscriptChars) || 8000);
      transcriptText = subtitle.text.length > maxChars ? `${subtitle.text.slice(0, maxChars)}\n…（字幕过长已截断）` : subtitle.text;
      lines.push(`字幕（${subtitle.langName || subtitle.lan}，${subtitle.text.length} 字${truncated ? `，视频超 ${Math.round(maxSec / 60)} 分钟已截断` : ''}）：\n${transcriptText}`);
    } else {
      lines.push('字幕：无（拿不到 AI 字幕或 UP 没传；只能依据标题/简介/评论总结）');
    }
    if (comments.length) {
      lines.push(`热评（${comments.length} 条）：\n${comments.map((x) => `- [${x.like} 赞] ${x.user}：${x.text}`).join('\n')}`);
    }

    const value = {
      bvid,
      title: view.title,
      owner: view.owner?.name || '',
      duration,
      durationText: fmtDuration(duration),
      viewCount: Number(view.stat?.view) || 0,
      likeCount: Number(view.stat?.like) || 0,
      pubdate: Number(view.pubdate) || 0,
      hasSubtitle: Boolean(subtitle?.text),
      truncated,
      digest: lines.join('\n\n')
    };
    const store = loadCache();
    store[key] = { at: Date.now(), value };
    cache = store;
    saveCache();
    log(`[bili] 解析完成 ${bvid} 《${String(view.title).slice(0, 20)}》 字幕=${value.hasSubtitle ? '有' : '无'} 评论=${comments.length}`);
    return { ...value, cached: false };
  }

  return { digest, parseTarget, config: cfg };
}
