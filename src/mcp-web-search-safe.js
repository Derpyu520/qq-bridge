// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：搜时事/新闻/网络用语/梗、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - 所有出网请求（搜索的每个通道也一样）都走同一条 safeFetch 受限链路，不直接用 fetch。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
//
// 本地补丁 2026-10-10「多通道搜索」：
//   原实现只查 cn.bing.com 网页垂直，且只取 <li class="b_algo"> 前 8 条。实测有两种退化：
//     1) 查询词有 4~5 个中文词时只回实体导航卡（百科/官网），没有事件内容；
//     2) 以拉丁字母开头的实体被搜索引擎拆词（“C罗” → C 语言教程）。
//   结果里又没有日期、没有新闻垂直，模型常据此回「没搜到」。现在并行查三个通道：
//     360资讯（news.so.com，直连真 URL，含来源/时间）→ 搜狗资讯（含相对时间）
//     → Bing 网页（原通道，保留兜底，兼容既有测试对 512000/`?q=` 的断言）。
//   新闻条目优先；全部通道都没结果时返回一句可读的空结果说明（不再静默给空数组），
//   全部通道都出错时才作为工具错误抛出。
// 本地补丁 2026-10-10「多通道搜索 · 配额」：
//   上线前实测发现「新闻通道条数多 ⇒ 网页垂直全被挤掉」：查「登dua郎」时 360资讯回 8 条无关
//   手游页，而 Bing 网页里正确的哔哩哔哩/知乎条目一条都进不了结果。改为按类配额
//   （新闻 ≤5、网页 ≤3，缺位互相补齐），并在 note 里说明本次结果来自哪些通道、是否含新闻。
// 本地补丁 2026-10-10「多通道搜索 · 意图词与相关性排序」（+searchnews7）：
//   真实轮实测残留：模型把 query 写长（例：「韩国 银行 AI 攻击 CrowdStrike 后续 细节」）时，
//   360资讯 退化成 1 条 2024 年无关旧闻、Bing 网页整页回「韩国_百度百科 / Korea.net / 外交部国家概况」；
//   旧的 filterRelevant 只要求「命中 1 个查询词」就放行，这类垃圾照样通关。三处改动：
//     1) 意图词剥离：发查询前去掉只表意图、不带实体的词（后续/细节/进展/最新/有没有…），
//        剩余内容词 ≥2 个时才剥（避免把「AI 新闻」剥成「AI」）；
//     2) 相关性打分排序：标题命中 2 分、摘要命中 1 分、有日期 +1 分；「百科/官网概况」类域名在
//        只命中 1 个标题词时 −2 分（专题页/事件词条命中多个词不受影响），score ≤0 视为跑题丢弃
//        （全被丢时退回原列表，宁可带噪声也不空手）；
//     3) 自适应短查询重搜：整轮没有任何「强相关（score ≥4）」条目时，自动用「去掉动作词后的前 3 个词」
//        再查一次 360 资讯（仅新闻单通道，避免反爬）；重搜结果里只有强相关条目才补进结果（否则等于往一堆跑题结果里再塞 8 条跑题结果），并在 note 里说明。
import { safeFetch } from './safe-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.2.0-r3+searchnews7';
const MAX_RESULTS = 8;
// 通道配额：新闻类通道合起来最多 5 条、网页垂直最多 3 条，避免「新闻条数多就把网页结果挤出去」
// （实测「登dua郎」这类词：360资讯回 8 条无关手游页，而 Bing 网页里正确的百科/知乎条目一条都进不来）。
// 任一通道条目不足时，剩余的槽位由另一类补齐（下面 primary/reserve 两段合并）。
const NEWS_QUOTA = 5;
const WEB_QUOTA = 3;
// 同一站点最多 2 条（见 limitByDomain）。
const DOMAIN_QUOTA = 2;
const MAX_SNIPPET = 240;
const SEARCH_FETCH_CHARS = 512000;
const SOGOU_BASE = 'https://news.sogou.com';
// score ≥ STRONG_SCORE 视为「强相关」：约等于「标题命中 2 个词」或「标题 1 词 + 摘要 2 词」+ 日期。
const STRONG_SCORE = 4;

// 只表意图、不带实体信息的词：它们把 query 拉长、又不给搜索引擎任何线索（实测「后续/细节/进展」
// 会把 360资讯 的召回打到接近 0）。只在剩余内容词 ≥2 个时剥离，避免把「AI 新闻」剥成「AI」。
const INTENT_WORDS = new Set([
  '后续', '后续进展', '细节', '进展', '最新', '消息', '新闻', '情况', '详情', '有没有', '爆出',
  '怎么', '怎样', '咋样', '如何', '什么', '哪些', '是否', '真的', '现在', '目前', '今天', '昨天',
  '最近', '相关', '报道', '原因', '结果', '回应', '回事', '怎么样', '一下', '请问', '知道',
]);

// 生成短查询时优先丢掉的「动作/属性词」：留下的多为主体词（国家/机构/人名/产品名）。
const ACTION_WORDS = new Set([
  '攻击', '事件', '泄露', '调查', '报道', '宣布', '回应', '声明', '进展', '细节', '后续', '情况',
  '最新', '消息', '新闻', '措施', '影响', '原因', '结果', '发生', '出现', '导致',
]);

// 「概况/词条」类域名：它们对任何含国家/机构名的查询都可能命中，但通常不含事件信息。
const GENERIC_HOSTS = [
  'baike.baidu.com', 'baike.so.com', 'zh.wikipedia.org', 'wikipedia.org',
  'korea.net', 'mfa.gov.cn', 'visitkorea.or.kr',
];

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', times: '×', copy: '©', reg: '®', deg: '°', laquo: '«', raquo: '»',
  bull: '•', prime: '′', permil: '‰', sect: '§', para: '¶', dagger: '†', euro: '€', pound: '£',
  yen: '¥', cent: '¢', trade: '™', infin: '∞', ne: '≠', le: '≤', ge: '≥', minus: '−',
  sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾', alpha: 'α', beta: 'β', pi: 'π',
  iexcl: '¡', iquest: '¿', szlig: 'ß', aring: 'å', eacute: 'é', uuml: 'ü', oslash: 'ø',
};

function codepointToString(code, fallback) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

// 数值实体（&#183; / &#xB7;）与常见命名实体一起解掉；原实现只解 6 个命名实体，
// 新闻/搜索标题里高频的 &#183;、&ensp;、&mdash; 会原样漏进模型上下文。
function decodeEntities(input) {
  return String(input ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => codepointToString(parseInt(hex, 16), match))
    .replace(/&#(\d+);/g, (match, dec) => codepointToString(Number(dec), match))
    .replace(/&([a-z][a-z0-9]{1,10});/gi, (match, name) => {
      const value = HTML_ENTITIES[name.toLowerCase()];
      return value === undefined ? match : value;
    });
}

function decodeHtml(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text ?? '').match(pattern);
    if (match) return match;
  }
  return null;
}

function cleanUrl(raw) {
  const url = decodeEntities(String(raw ?? '')).trim().replace(/^\/\//, 'https://');
  return /^https?:\/\//i.test(url) ? url : '';
}

function pickDate(text) {
  const match = String(text ?? '').match(
    /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}[-/月]\d{1,2}日|\d+\s*(?:分钟|小时|天)前|\d+\s*(?:minutes?|hours?|days?)\s*ago)/i,
  );
  return match ? match[1].trim() : '';
}

function hostOf(url) {
  try {
    return new URL(String(url ?? '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// 同一站点最多占几条：360 资讯在冷门词上会整页回同一个站（实测「登dua郎」前 8 条有 7 条是
// 九游网的一款无关手游），单站配额能把这些垃圾挤掉、让其它站点（含 Bing 网页）的正确条目进来。
function limitByDomain(items, perHost = DOMAIN_QUOTA) {
  const used = new Map();
  const out = [];
  for (const item of items) {
    const host = hostOf(item?.url);
    if (host) {
      const count = used.get(host) ?? 0;
      if (count >= perHost) continue;
      used.set(host, count + 1);
    }
    out.push(item);
  }
  return out;
}

function queryTokens(query) {
  return String(query ?? '')
    .split(/[\s,，、。;；:：!！?？()（）[\]【】"'“”|/\\-]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2);
}

// 内容词＝查询词去掉意图词；剥完不足 2 个就认为意图词本身可能是主体（如「AI 新闻」），不剥。
function contentTokens(query) {
  const tokens = queryTokens(query);
  if (tokens.length < 2) return tokens;
  const stripped = tokens.filter((token) => !INTENT_WORDS.has(token));
  return stripped.length >= 2 ? stripped : tokens;
}

// 短查询：优先丢掉动作/属性词，取剩下的前 3 个（多为国家/机构/人名/产品名这类主体词）。
function pickShortQuery(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 3) return '';
  const filtered = tokens.filter((token) => !ACTION_WORDS.has(token));
  const base = filtered.length >= 2 ? filtered : tokens;
  const short = base.slice(0, 3).join(' ');
  return short === tokens.join(' ') ? '' : short;
}

// 相关性打分：标题命中权重 2、摘要命中 1、有日期 +1；「概况/词条」类域名若只命中 1 个标题词
// （score ≤2）再 −2 —— 于是「韩国（大韩民国）_百度百科」「Korea.net 韩国概况」这类跑题条目
// 会被丢到 0 分以下，而真正的事件页面（标题含多个查询词）不受影响。
function scoreItem(item, tokens) {
  const title = String(item?.title ?? '').toLowerCase();
  const snippet = String(item?.snippet ?? '').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 2;
    else if (snippet.includes(token)) score += 1;
  }
  if (item?.date) score += 1;
  const host = hostOf(item?.url);
  if (score <= 2 && host && GENERIC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) score -= 2;
  return score;
}

// 按相关性排序并丢掉跑题条目（score ≤0）；全被丢时退回原列表（宁可带噪声也不空手）。
// 同分时新闻通道优先于网页垂直，其次保持通道内的原始顺序。
function rankRelevant(items, tokens) {
  if (!tokens.length) return items;
  const entries = items.map((item, index) => ({ item, index, score: scoreItem(item, tokens) }));
  const kept = entries.filter((entry) => entry.score > 0);
  const usable = kept.length ? kept : entries;
  usable.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aWeb = a.item?.channel === 'Bing网页' ? 1 : 0;
    const bWeb = b.item?.channel === 'Bing网页' ? 1 : 0;
    if (aWeb !== bWeb) return aWeb - bWeb;
    return a.index - b.index;
  });
  return usable.map((entry) => entry.item);
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = String(item?.url ?? '').replace(/[#?].*$/, '').toLowerCase() || String(item?.title ?? '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// 360 资讯搜索：结果页的每条新闻是一个 <li class="res-list ...">，
// 标题在 <h3 class="g-title js-title"><a href="真 URL">，直连真 URL（不是跳转壳）。
function parse360News(html) {
  const items = [];
  const blocks = String(html ?? '').split(/<li[^>]*class="[^"]*res-list/i).slice(1);
  for (const block of blocks) {
    const chunk = block.slice(0, 6000);
    const heading = firstMatch(chunk, [/<h3[^>]*>([\s\S]*?)<\/h3>/i]);
    const title = heading ? decodeHtml(heading[1]) : '';
    const hrefInHeading = heading ? firstMatch(heading[1], [/href="(https?:\/\/[^"]+)"/i]) : null;
    const hrefFallback = firstMatch(chunk, [/<a[^>]+href="(https?:\/\/[^"]+)"/i]);
    const url = cleanUrl(hrefInHeading ? hrefInHeading[1] : hrefFallback ? hrefFallback[1] : '');
    const desc = firstMatch(chunk, [
      /<p[^>]*class="[^"]*(?:res-desc|res-summary|summary|desc)[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
      /<p[^>]*>([\s\S]*?)<\/p>/i,
      /<div[^>]*class="[^"]*(?:res-desc|res-summary|summary|desc)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ]);
    const snippet = desc ? decodeHtml(desc[1]).slice(0, MAX_SNIPPET) : '';
    const from = firstMatch(chunk, [
      /class="[^"]*(?:res-source|res-site|source|site|from)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|a|div|p|cite)>/i,
    ]);
    const source = from ? decodeHtml(from[1]).slice(0, 40) : '';
    if (!title || !url) continue;
    items.push({ title, url, snippet, source, date: pickDate(chunk) });
    if (items.length >= MAX_RESULTS) break;
  }
  return items;
}

// 搜狗资讯搜索：每条结果是一个 <h3 class="vr-title">，外链是 /link?url=... 跳转壳，
// 真 URL 要再抓一次壳页（壳页里有 window.location.replace / meta refresh）。
function parseSogouNews(html) {
  const items = [];
  const blocks = String(html ?? '').split(/<h3[^>]*class="[^"]*vr-title/i).slice(1);
  for (const block of blocks) {
    const chunk = block.slice(0, 6000);
    const anchor = firstMatch(chunk, [/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i]);
    if (!anchor) continue;
    let url = cleanUrl(anchor[1]);
    if (!url && String(anchor[1] ?? '').trim().startsWith('/')) url = SOGOU_BASE + String(anchor[1]).trim();
    const title = decodeHtml(anchor[2]);
    const desc = firstMatch(chunk, [
      /<p[^>]*class="[^"]*(?:star-wiki|txt-info|summary)[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
      /<div[^>]*class="[^"]*txt-info[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<p[^>]*>([\s\S]*?)<\/p>/i,
    ]);
    const snippet = desc ? decodeHtml(desc[1]).slice(0, MAX_SNIPPET) : '';
    const from = firstMatch(chunk, [
      /class="[^"]*(?:news-from|from|source|site|account)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|a|div|p)>/i,
    ]);
    const source = from ? decodeHtml(from[1]).slice(0, 40) : '';
    if (!title || !url) continue;
    items.push({ title, url, snippet, source, date: pickDate(chunk) });
    if (items.length >= MAX_RESULTS) break;
  }
  return items;
}

// 把最多 limit 条搜狗跳转壳换成真 URL；失败就保留壳链接（模型仍可 web_fetch 打开）。
async function resolveSogouLinks(items, limit = 3) {
  const targets = items.filter((item) => /sogou\.com\/link\?/i.test(item.url)).slice(0, limit);
  await Promise.allSettled(targets.map(async (item) => {
    try {
      const res = await safeFetch(item.url, 20000);
      const body = String(res?.body ?? '');
      const found = firstMatch(body, [
        /window\.location\.replace\(\s*["']([^"']+)["']/i,
        /window\.location\.href\s*=\s*["']([^"']+)["']/i,
        /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'\s>]+)/i,
      ]);
      const real = cleanUrl(found ? found[1] : '');
      if (real && !/sogou\.com/i.test(real)) item.url = real;
    } catch {
      // 解析失败就保留跳转壳，不影响其它通道
    }
  }));
  return items;
}

// 反爬/验证页识别：搜狗在连续查询后会把 IP 打到 https://www.sogou.com/antispider/?... —— HTTP 200、
// 页面却是验证壳、一条结果都没有。不显式报错的话，模型会把「通道被拦」当成「世界上没这条新闻」。
function blockedReason(res, body) {
  const where = `${String(res?.url ?? '')}\n${String(body ?? '').slice(0, 3000)}`;
  if (/antispider/i.test(where)) return '被反爬拦截（该通道要求人工验证）';
  if (/请输入验证码|安全验证|访问过于频繁|人机验证/.test(where)) return '被反爬拦截（要求验证码/人机验证）';
  return '';
}

async function search360News(query) {
  const url = new URL('https://news.so.com/ns');
  url.searchParams.set('q', query);
  const res = await safeFetch(url.toString(), SEARCH_FETCH_CHARS);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`360资讯 HTTP ${res.statusCode}`);
  const items = parse360News(res.body);
  if (!items.length) {
    const blocked = blockedReason(res, res.body);
    if (blocked) throw new Error(blocked);
  }
  return items;
}

async function searchSogouNews(query) {
  const url = new URL(`${SOGOU_BASE}/news`);
  url.searchParams.set('query', query);
  const res = await safeFetch(url.toString(), SEARCH_FETCH_CHARS);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜狗资讯 HTTP ${res.statusCode}`);
  const items = parseSogouNews(res.body);
  if (!items.length) {
    const blocked = blockedReason(res, res.body);
    if (blocked) throw new Error(blocked);
  }
  return resolveSogouLinks(items);
}

// 原 Bing 网页通道：作为兜底保留（也是 test-audit-security-mcp 夹具依赖的通道）。
async function searchBingWeb(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  // 搜索也使用同一条受限传输链路，重定向必须重新校验，正文最多 512K 字符。
  const res = await safeFetch(url.toString(), SEARCH_FETCH_CHARS);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Bing 搜索服务 HTTP ${res.statusCode}`);
  const html = res.body;
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]).slice(0, MAX_SNIPPET) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet, source: '', date: '' });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

// 名字沿用 bingSearch：调用点（web_search handler）与既有测试都不必改。
async function bingSearch(query) {
  const tokens = contentTokens(query);
  // 实际发出去的查询：内容词 ≥2 个时用剥离意图词后的版本，否则原样（保持既有测试对 `?q=` 的断言）。
  const primary = tokens.length >= 2 ? tokens.join(' ') : sanitizeQuery(query);
  const channels = [
    { name: '360资讯', news: true, run: (q) => search360News(q) },
    { name: '搜狗资讯', news: true, run: (q) => searchSogouNews(q) },
    { name: 'Bing网页', news: false, run: (q) => searchBingWeb(q) },
  ];
  const settled = await Promise.allSettled(channels.map((channel) => channel.run(primary)));
  const counts = {};
  const errors = [];
  let news = [];
  let web = [];
  settled.forEach((outcome, index) => {
    const channel = channels[index];
    if (outcome.status === 'fulfilled' && Array.isArray(outcome.value)) {
      counts[channel.name] = outcome.value.length;
      const target = channel.news ? news : web;
      for (const item of outcome.value) target.push({ ...item, channel: channel.name });
    } else {
      counts[channel.name] = 0;
      const reason = outcome.status === 'rejected' ? outcome.reason?.message ?? outcome.reason : '返回格式异常';
      errors.push(`${channel.name}: ${reason}`);
    }
  });
  // 三个通道全挂＝工具故障，必须报错；否则模型会把「服务坏了」当成「世界上没这件事」。
  if (!news.length && !web.length && errors.length === channels.length) {
    throw new Error(errors.join(' | '));
  }
  // 自适应短查询重搜：整轮连一条「强相关（score ≥4）」都没有时，说明长查询把两个通道都打退了
  // （实测「韩国 银行 AI 攻击 CrowdStrike 后续 细节」→ 360 只剩 1 条 2024 年旧闻、Bing 全是
  // 「韩国_百度百科/Korea.net/外交部国家概况」）。用主体词重查一次 360 资讯（单通道，避免反爬）。
  const scored = [...news, ...web].map((item) => scoreItem(item, tokens));
  const strongCount = scored.filter((score) => score >= STRONG_SCORE).length;
  let retried = '';
  if (strongCount === 0 && tokens.length >= 3) {
    const shortQuery = pickShortQuery(tokens);
    if (shortQuery) {
      try {
        const extra = await search360News(shortQuery);
        const strongExtra = extra.filter((item) => scoreItem({ ...item, channel: '360资讯' }, tokens) >= STRONG_SCORE);
        if (strongExtra.length) {
          news = news.concat(strongExtra.map((item) => ({ ...item, channel: '360资讯' })));
          counts['360资讯'] = (counts['360资讯'] ?? 0) + strongExtra.length;
          retried = shortQuery;
        }
      } catch {
        // 重搜是 best-effort：失败就沿用第一轮结果，不额外报错
      }
    }
  }
  const newsRanked = rankRelevant(limitByDomain(dedupe(news)), tokens);
  const webRanked = rankRelevant(limitByDomain(dedupe(web)), tokens);
  const newsPicked = newsRanked.slice(0, NEWS_QUOTA);
  const webPicked = webRanked.slice(0, WEB_QUOTA);
  const overflow = [...newsRanked.slice(NEWS_QUOTA), ...webRanked.slice(WEB_QUOTA)];
  const results = rankRelevant(dedupe([...newsPicked, ...webPicked, ...overflow]), tokens).slice(0, MAX_RESULTS);
  const report = { query, channels: counts, results };
  const extras = [];
  if (primary !== sanitizeQuery(query)) extras.push(`已去掉意图词后搜索：「${primary}」`);
  if (retried) extras.push(`首轮无强相关结果，已自动改用「${retried}」重搜并补入强相关条目`);
  if (!results.length) {
    report.note = `所有通道都没有返回结果（已尝试 ${channels.map((channel) => channel.name).join('、')}）。可以换更短的关键词（主体 + 事件，2~4 个词）重试，或直接用 web_fetch 打开你确定存在的具体站点（新闻首页/官网/百科）；不要凭记忆编造标题、日期或链接。`;
  } else if (!news.length && web.length) {
    report.note = '只命中网页垂直、没有新闻条目：内容可能是旧页面（多见于老梗、百科词条），引用前先确认时间。';
  } else {
    report.note = `结果来自${newsPicked.length ? '新闻' : '网页'}通道（新闻 ${news.length} 条 / 网页 ${web.length} 条，取前 ${results.length} 条，按相关度排序）：引用时带上来源与日期；若条目与问题无关，请换关键词重搜，不要把无关条目硬套成答案。`;
  }
  if (extras.length) report.note = `${report.note}（${extras.join('；')}）`;
  if (errors.length) report.errors = errors;
  return report;
}

const server = new McpServer({ name: 'web-search-safe', version: VERSION });

server.tool(
  'web_search',
  '只读联网搜索：并行查 360资讯/搜狗资讯/Bing网页，返回标题/URL/摘要/来源/日期（按相关度排序，新闻优先）。会自动去掉「后续/细节/进展」这类意图词；若首轮无强相关结果，会自动用更短的关键词重搜一次。适合时事新闻、事实性问题、网络用语/梗的含义。只读网络公开页面，不执行任何本地操作。',
  { query: z.string().describe('要搜索的关键词：主体 + 事件，2~4 个词最好（不要写成整句问句，不要带「后续/细节/进展」这类意图词）') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingSearch(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
