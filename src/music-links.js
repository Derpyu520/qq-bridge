// 音乐 app 分享链接构造器。不伪造卡片，只生成「去听」的跳转/搜索链接。
// 模型给歌名（+歌手/歌曲 id），这里按平台拼出真实可点的 URL。
//
// 为什么不做成「真·歌曲卡片」：那种卡片需要音乐平台的 appid + 签名，得接后端，
// 而且本质是伪装成系统消息——用户明确选了「给音乐 app 的歌曲分享链接」这一项，
// 所以这里就老老实实给链接。

const PLATFORMS = {
  netease: {
    name: '网易云音乐',
    search: (q) => `https://music.163.com/#/search/m/?s=${enc(q)}`,
    song: (id) => `https://music.163.com/song?id=${id}`
  },
  qq: {
    name: 'QQ音乐',
    search: (q) => `https://y.qq.com/portal/search.html#t=song&w=${enc(q)}`,
    song: (id) => `https://y.qq.com/n/ryqq/songDetail/${id}`
  },
  kugou: {
    name: '酷狗音乐',
    search: (q) => `https://www.kugou.com/search/?keyword=${enc(q)}`
  },
  spotify: {
    name: 'Spotify',
    search: (q) => `https://open.spotify.com/search/${enc(q)}`
  },
  apple: {
    name: 'Apple Music',
    search: (q) => `https://music.apple.com/us/search?term=${enc(q)}`
  }
};

function enc(s) { return encodeURIComponent(String(s ?? '').trim()); }

export function buildMusicShare({ platform = 'netease', song, artist = '', id = '' } = {}) {
  const key = PLATFORMS[platform] ? platform : 'netease';
  const p = PLATFORMS[key];
  const songText = String(song ?? '').trim();
  if (!songText && !id) throw new Error('至少需要 song（歌名）或 id（歌曲 id）之一');
  let url;
  if (id) {
    url = p.song ? p.song(String(id).trim()) : p.search(songText + (artist ? ' ' + String(artist).trim() : ''));
  } else {
    const q = artist ? `${songText} ${String(artist).trim()}` : songText;
    url = p.search(q);
  }
  const label = [songText, String(artist).trim()].filter(Boolean).join(' - ') || `${p.name}搜索`;
  const hint = id ? `点开直接听《${songText || id}》` : `在${p.name}里搜「${label}」`;
  return { platform: key, platformName: p.name, song: songText, artist: String(artist).trim(), url, label, hint };
}

export function renderMusicShare(r) {
  return `🎵 ${r.label}\n${r.hint}：${r.url}\n（${r.platformName}）`;
}
