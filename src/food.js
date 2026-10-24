// 食物推荐：有人问「早/中/晚吃啥」时，挑一样吃的（偶尔玩梗）。
//
// 设计：
// - 按餐次分池（早/午/晚/夜宵），另有「随便/再加一个」的万能池
// - 梗按 memeRatio 概率混入（默认 30%），梗要短、要莫名其妙，不解释
// - 记住最近 15 次，避免连续推同一样
import fs from 'node:fs';
import path from 'node:path';

const POOLS = {
  breakfast: ['豆浆油条', '小笼包', '煎饼果子', '肠粉', '皮蛋瘦肉粥', '胡辣汤', '热干面', '包子+豆浆', '茶叶蛋+粥', '三明治', '鸡蛋灌饼', '豆腐脑', '生煎', '锅贴', '面线糊', '葱油饼', '燕麦牛奶', '饭团', '牛肉粉', '烧麦'],
  lunch: ['黄焖鸡米饭', '番茄牛腩面', '隆江猪脚饭', '麻辣香锅', '沙县小吃', '螺蛳粉', '兰州拉面', '日式咖喱饭', '寿司', '盖浇饭', '炒饭', '汉堡套餐', '鸡肉卷', '酸辣粉', '水煮肉片', '铁板炒面', '卤肉饭', '酸菜鱼', '烤肉拌饭', '关东煮'],
  dinner: ['火锅', '烧烤', '酸菜鱼', '小龙虾', '家常小炒', '饺子', '麻辣烫', '部队锅', '烤鱼', '猪肚鸡', '椰子鸡', '干锅花菜', '回锅肉+米饭', '砂锅粥', '牛排', '披萨', '寿喜烧', '串串香', '卤味拼盘', '清蒸鱼'],
  lateNight: ['烧烤', '小龙虾', '炒粉', '泡面', '关东煮', '麻辣烫', '炒饭', '烤冷面', '炸鸡', '粥+咸菜', '凉皮', '煎饺', '螺蛳粉', '烤肠', '便利店饭团'],
  any: ['随便吃点什么', '楼下那家', '泡面', '外卖凑单', '剩菜', '水煮蛋', '面包', '水果', '便利店', '自己煮面']
};

const MEMES = [
  '吃我一拳',
  '铝热剂',
  '奥玛·基里曼·波',
  '西北风',
  '空气',
  '我的铁拳',
  '大嘴巴子',
  '一手王八拳',
  '吃我一记上勾拳',
  '赛博汉堡',
  '数据面条',
  '电费',
  'CPU 烧饼',
  '吃点亏',
  '吃点苦',
  '吃点教训',
  '铁饼',
  '柠檬',
  '一口气',
  '闭门羹',
  '回头草',
  '哑巴亏',
  '板砖',
  '一发入魂',
  '战术核弹'
];

const MEAL_LABEL = { breakfast: '早饭', lunch: '午饭', dinner: '晚饭', lateNight: '夜宵', any: '这顿' };

export function createFoodPicker({ stateDir, log = () => {} }) {
  const FILE = path.join(stateDir, 'food-history.json');
  let history = null;

  function loadHistory() {
    if (history) return history;
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      history = Array.isArray(raw?.picks) ? raw.picks : [];
    } catch {
      history = [];
    }
    return history;
  }

  function saveHistory() {
    try {
      fs.writeFileSync(FILE, JSON.stringify({ picks: history.slice(-30) }, null, 2), 'utf8');
    } catch (error) {
      log(`[food] 历史写盘失败：${error?.message ?? error}`);
    }
  }

  function guessMeal(now = new Date()) {
    const h = now.getHours();
    if (h >= 5 && h < 10) return 'breakfast';
    if (h >= 10 && h < 15) return 'lunch';
    if (h >= 17 && h < 21) return 'dinner';
    if (h >= 21 || h < 2) return 'lateNight';
    return 'any';
  }

  /**
   * 抽一份推荐。
   * asker 用来区分「谁问的」：不同人各问各的，只有同一个人重复问才算「你又问」。
   * @returns {{ name, kind:'dish'|'meme', meal, label, alternates: string[], memeRatio: number, asker: string|null, timesToday: number }}
   */
  function pick({ meal, memeRatio = 0.3, now = new Date(), asker = '' } = {}) {
    const m = POOLS[meal] ? meal : guessMeal(now);
    const pool = POOLS[m];
    const hist = loadHistory();
    const recent = new Set(hist.slice(-15).map((x) => x && x.name).filter(Boolean));
    const fresh = pool.filter((x) => !recent.has(x));
    const candidates = fresh.length ? fresh : pool;

    const ratio = Math.min(0.9, Math.max(0, Number(memeRatio)));
    const useMeme = Math.random() < ratio;
    const chosenPool = useMeme ? MEMES.filter((x) => !recent.has(x)) : candidates;
    const source = chosenPool.length ? chosenPool : (useMeme ? MEMES : pool);
    const name = source[Math.floor(Math.random() * source.length)];

    const altPool = (useMeme ? candidates : pool).filter((x) => x !== name && !recent.has(x));
    const alternates = [];
    while (alternates.length < 2 && altPool.length) {
      alternates.push(altPool.splice(Math.floor(Math.random() * altPool.length), 1)[0]);
    }

    const who = String(asker || '').trim();
    const today = new Date(now).toDateString();
    const timesToday = who
      ? hist.filter((x) => x && x.asker === who && new Date(x.at || 0).toDateString() === today).length + 1
      : 0;

    hist.push({ name, kind: useMeme ? 'meme' : 'dish', meal: m, at: new Date().toISOString(), asker: who || null });
    if (hist.length > 30) hist.splice(0, hist.length - 30);
    saveHistory();

    return { name, kind: useMeme ? 'meme' : 'dish', meal: m, label: MEAL_LABEL[m], alternates, memeRatio: ratio, asker: who || null, timesToday };
  }

  return { pick, guessMeal, pools: POOLS };
}
