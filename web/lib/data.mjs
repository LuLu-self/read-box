// Pure helpers for the board: link parsing, filters, facets, labels. No DOM, no network
// (tested with `node --test web/tests`).

export const MARKS = ['未讀', '讀過', '有用', '實踐過', '封存'];
export const PLATFORM_LABEL = { threads: 'Threads', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube',
  medium: 'Medium', web: '網站', note: '我的筆記' };
export const KIND_LABEL = { social: '貼文', video: '影片', article: '文章', bookmark: '網址書籤', pdf: 'PDF', note: '筆記' };
export const BASIS_NOTE = {
  全文: '', 貼文文字: '', 貼上的文字: '依你貼上的文字整理',
  說明文字: '摘要依據：貼文或影片的說明文字，未看影片內容',
  試閱段: '只有試閱內容（付費或會員文章），摘要依試閱段整理',
  標題與簡介: '只讀到標題與簡介，摘要可能不完整',
  無: '讀不到內容，請點原文連結查看',
};
export const SEP = ' › ';

// Every http(s) link in pasted text, in order, without duplicates. Trailing punctuation that
// chat apps glue onto links (）。，) is trimmed.
export function parseLinks(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"'「」『』（）()。，、！？；：…》〉【】]+/gi)) {
    let u = m[0].replace(/[.,;:!?。，、；：！？…》〉】]+$/u, '');
    try { u = new URL(u).href; } catch { continue; }
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

// Links shown on the page come from fetched data: only http(s) ever becomes an href.
export function safeUrl(u) {
  try {
    const x = new URL(String(u || ''));
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch { return null; }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function makeId(d, rnd) {
  const r = (rnd ?? Math.floor(Math.random() * 0x10000)).toString(16).padStart(4, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${r}`;
}

export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function shortDate(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function duration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export const markOf = (state, id) => state?.items?.[id]?.mark || '未讀';

// 旅遊 sub-categories are "國家 › 地區"; others are a single name.
export function splitSub(sub) {
  const [a = '', b = ''] = String(sub || '').split('›').map((s) => s.trim());
  return [a, b];
}

function countBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hant'));
}

// Options for each filter row, counted over what the earlier rows already selected.
export function facets(items, f, categories = []) {
  const inCat = f.category ? items.filter((i) => i.category === f.category) : items;
  const level1 = countBy(inCat, (i) => splitSub(i.subcategory)[0]);
  const inSub = f.sub ? inCat.filter((i) => splitSub(i.subcategory)[0] === f.sub) : [];
  const level2 = f.sub ? countBy(inSub, (i) => splitSub(i.subcategory)[1]) : [];
  const cats = countBy(items, (i) => i.category);
  const order = new Map(categories.map((c, n) => [c, n]));
  cats.sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99));
  return {
    categories: cats, subs: level1, areas: level2,
    platforms: countBy(items, (i) => i.platform),
    placeTypes: countBy(items.flatMap((i) => i.tags?.place_types || []), (t) => t),
  };
}

function haystack(i) {
  return [i.title, i.one_line, i.why, i.author, i.handle, i.site_name, i.category, i.subcategory,
    ...(i.tags?.topics || []), ...(i.tags?.scenarios || []), ...(i.places || []).map((p) => `${p.name} ${p.area} ${p.country}`)]
    .join(' ').toLowerCase();
}

export function applyFilter(items, f, state) {
  const q = String(f.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => {
    if (f.category && i.category !== f.category) return false;
    const [s1, s2] = splitSub(i.subcategory);
    if (f.sub && s1 !== f.sub) return false;
    if (f.area && s2 !== f.area) return false;
    if (f.platforms?.length && !f.platforms.includes(i.platform)) return false;
    if (f.marks?.length && !f.marks.includes(markOf(state, i.id))) return false;
    if (!f.marks?.includes('封存') && markOf(state, i.id) === '封存') return false;
    if (f.placeTypes?.length && !(i.tags?.place_types || []).some((t) => f.placeTypes.includes(t))) return false;
    if (f.unreadable && i.ai_ok) return false;
    if (q.length) { const h = haystack(i); if (!q.every((w) => h.includes(w))) return false; }
    return true;
  });
}

// Every place across the filtered items, with the article it came from.
export function placesOf(items, placeTypes = []) {
  const out = [];
  for (const i of items) {
    for (const p of i.places || []) {
      if (placeTypes.length && !placeTypes.includes(p.type)) continue;
      out.push({ ...p, from: i.id, fromTitle: i.title });
    }
  }
  return out.sort((a, b) => `${a.country}${a.area}${a.type}`.localeCompare(`${b.country}${b.area}${b.type}`, 'zh-Hant'));
}

// Items marked 有用 or 實踐過 that LuLu has not touched for 30 days come back as 該重讀了.
export function rereadDue(items, state, now = Date.now()) {
  return items.filter((i) => {
    const s = state?.items?.[i.id];
    if (!s || !['有用', '實踐過'].includes(s.mark)) return false;
    const t = Date.parse(s.updated_at || '');
    return !Number.isNaN(t) && now - t > 30 * 86400000;
  });
}

export function thisWeek(items, now = Date.now()) {
  return items.filter((i) => now - Date.parse(i.captured_at || '') < 7 * 86400000).length;
}

export function youtubeAt(url, sec) {
  const u = safeUrl(url);
  if (!u) return null;
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(u) || /\/shorts\/([A-Za-z0-9_-]{11})/.exec(u);
  return m ? `https://www.youtube.com/watch?v=${m[1]}&t=${Math.max(0, sec | 0)}s` : null;
}
