'use strict';

import { loadCfg, getJson, getText, getBlobUrl, updateJson, putFile } from './lib/gh.mjs';
import { safeUrl, shortDate, duration, youtubeAt, makeId, isoLocal, MARKS, PLATFORM_LABEL, KIND_LABEL, BASIS_NOTE } from './lib/data.mjs';
import { el, brandMark } from './lib/ui.mjs';

const $ = (id) => document.getElementById(id);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';

const ext = (href, text, cls) => (safeUrl(href) ? el('a', { href: safeUrl(href), target: '_blank', rel: 'noopener noreferrer', class: cls, text }) : null);

function mapLink(url) {
  if (!safeUrl(url)) return null;
  const a = el('a', { class: 'map', href: safeUrl(url), target: '_blank', rel: 'noopener noreferrer' });
  a.innerHTML = PIN; // fixed icon markup, no data
  a.append('地圖');
  return a;
}

function section(title, ...kids) {
  return el('section', { class: 'blk' }, el('h2', { class: 'label', text: title }), ...kids);
}

function list(items, cls = 'dots') {
  return el('ul', { class: cls }, ...items.map((t) => el('li', {}, el('span', { text: t }))));
}

// ------------------------------------------------------------------ marks

let state = { items: {} };

function markBlock(cfg, id) {
  const cur = () => state.items?.[id] || {};
  const status = el('span', { id: 'save-state', class: 'muted' });
  const marks = el('div', { class: 'marks' });
  const stars = el('div', { class: 'stars', 'aria-label': '星等' });
  const note = el('textarea', { class: 'field', id: 'note', placeholder: '我的筆記（只有你看得到）', maxlength: '2000' });
  note.value = cur().note || '';

  const paint = () => {
    const c = cur();
    marks.replaceChildren(...MARKS.map((m) => el('button', {
      type: 'button', class: m === '實踐過' ? 'done' : null, 'aria-pressed': String((c.mark || '未讀') === m),
      onclick: () => save({ mark: m }), text: m })));
    stars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => el('button', {
      type: 'button', class: (c.stars || 0) >= n ? 'on' : null, 'aria-label': `${n} 星`,
      onclick: () => save({ stars: c.stars === n ? 0 : n }), text: '★' })));
  };

  async function save(patch) {
    status.textContent = '儲存中…';
    const res = await updateJson(cfg, 'state.json', (s) => {
      s.v = 1; s.items = s.items || {};
      s.items[id] = { ...(s.items[id] || {}), ...patch, updated_at: new Date().toISOString() };
      return s;
    }, `mark: ${id}`, { v: 1, items: {} });
    if (res.ok) { state = res.data; status.textContent = '已儲存'; paint(); }
    else status.textContent = res.status === 401 || res.status === 403 ? '沒存到：token 沒有寫入權限' : '沒存到，請再試一次';
  }

  paint();
  const saveNote = el('button', { class: 'btn small', type: 'button', text: '儲存筆記', onclick: () => save({ note: note.value.slice(0, 2000) }) });
  return section('我的標記', marks, stars, note, el('div', { class: 'row-btns', style: 'margin:0;justify-content:space-between;align-items:center' }, status, saveNote));
}

// ------------------------------------------------------------------ fix category / place

const DEFAULT_CATS = ['旅遊', '美食', '運動', '健康', '語言', '生活', '工作', '學習成長', '心理', '人際關係', '理財', '科技與 AI', '收件匣'];

// LuLu's corrections go to state.json as an override; the AI result stays untouched underneath.
function fixBlock(cfg, e, categories) {
  const cur = state.items?.[e.id]?.override || {};
  const loc0 = cur.locations?.[0] || (e.locations?.[0]) || [];
  const cat = el('select', { class: 'field', id: 'fx-cat' },
    ...(categories.length ? categories : DEFAULT_CATS).map((c) => el('option', { value: c, text: c })));
  cat.value = cur.category || e.category;
  const sub = el('input', { class: 'field', id: 'fx-sub', maxlength: '20', placeholder: '次分類（可空白）' });
  sub.value = (cur.subcategory ?? e.subcategory ?? '').includes('›') ? '' : (cur.subcategory ?? e.subcategory ?? '');
  const country = el('input', { class: 'field', id: 'fx-country', maxlength: '20', placeholder: '國家，例如 日本' });
  const city = el('input', { class: 'field', id: 'fx-city', maxlength: '30', placeholder: '城市，例如 大阪' });
  country.value = loc0[0] || ''; city.value = loc0[1] || '';
  const msg = el('span', { class: 'muted', style: 'font-size:13px' });
  const dlg = el('dialog', {},
    el('h2', { text: '改分類／改地點' }),
    el('p', { class: 'muted', style: 'margin:0;font-size:13px', text: '你改的會優先於 AI，之後重新整理這篇也不會被蓋掉。' }),
    el('label', { for: 'fx-cat', text: '主分類' }), cat,
    el('label', { for: 'fx-sub', text: '次分類' }), sub,
    el('label', { for: 'fx-country', text: '地點' }),
    el('div', { style: 'display:flex;gap:8px' }, country, city),
    el('div', { class: 'row-btns' }, msg,
      el('button', { class: 'btn small', type: 'button', text: '恢復 AI 的分類', onclick: () => save(null) }),
      el('button', { class: 'btn small', type: 'button', text: '取消', onclick: () => dlg.close() }),
      el('button', { class: 'btn small go', type: 'button', text: '儲存', onclick: () => {
        const c = country.value.trim(), ci = city.value.trim();
        const subVal = cat.value === '旅遊' ? [c, ci].filter(Boolean).join(' › ') : sub.value.trim();
        save({ category: cat.value, subcategory: subVal, locations: c ? [[c, ci]] : [] });
      } })));
  async function save(override) {
    msg.textContent = '儲存中…';
    const res = await updateJson(cfg, 'state.json', (s) => {
      s.v = 1; s.items = s.items || {};
      const item = { ...(s.items[e.id] || {}), updated_at: new Date().toISOString() };
      if (override) item.override = override; else delete item.override;
      s.items[e.id] = item;
      return s;
    }, `fix: ${e.id}`, { v: 1, items: {} });
    if (res.ok) location.reload();
    else msg.textContent = '沒存到，請再試一次';
  }
  document.body.append(dlg);
  return el('button', { class: 'btn small', type: 'button', text: '改分類／改地點', onclick: () => dlg.showModal() });
}

// Re-run fetch + AI for this item: a capture with redo_of replaces the entry under the same id.
function redoButton(cfg, e) {
  const btn = el('button', { class: 'btn small', type: 'button', text: '重新整理這篇' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const now = new Date();
    const cap = { v: 1, url: e.url || '', captured_at: isoLocal(now), why: '', text: '', client: 'board@1', redo_of: e.id };
    if (!cap.url) { btn.textContent = '筆記不用重新整理'; return; }
    const res = await putFile(cfg, `inbox/${makeId(now)}.json`, JSON.stringify(cap, null, 2) + '\n', `redo: ${e.id}`);
    btn.textContent = res.ok ? '已送出，約 2–5 分鐘後重新整理頁面' : '沒送出，請再試一次';
    if (!res.ok) btn.disabled = false;
  });
  return btn;
}

// ------------------------------------------------------------------ page

async function main() {
  const id = decodeURIComponent(location.hash.slice(1));
  const cfg = loadCfg();
  if (!cfg) { $('msg').textContent = '還沒連結收藏庫，請回首頁按右上角設定。'; return; }
  if (!ID_RE.test(id)) { $('msg').textContent = '找不到這篇收藏。'; return; }
  const [entry, st, tax] = await Promise.all([getJson(cfg, `library/${id}.json`), getJson(cfg, 'state.json'), getJson(cfg, 'taxonomy.json')]);
  if (!entry.data) {
    $('msg').textContent = entry.status === 404 ? '找不到這篇收藏，可能還在整理中。' : entry.status === 401 ? 'token 失效，請回首頁重新設定。' : '暫時連不到 GitHub。';
    return;
  }
  state = st.data || { items: {} };
  const e = { ...entry.data };
  const o = state.items?.[e.id]?.override;
  if (o) Object.assign(e, { category: o.category || e.category, subcategory: o.subcategory ?? e.subcategory,
    locations: o.locations?.length ? o.locations : e.locations, overridden: true });
  const ai = e.ai || {};
  document.title = `${e.title} · Read Box`;
  $('msg').hidden = true;
  const chip = $('kind-chip');
  chip.hidden = false;
  chip.textContent = `${PLATFORM_LABEL[e.platform] || e.platform} · ${KIND_LABEL[e.kind] || e.kind}`;

  const who = [e.author, e.handle && e.platform !== 'web' ? `@${e.handle}` : ''].filter(Boolean).join(' ');
  const srcLine = el('div', { class: 'src2' },
    brandMark(e, cfg),
    who ? ` · ${who}` : '', e.published_at ? ` · 發布 ${shortDate(e.published_at)}` : '', ` · 收藏 ${shortDate(e.captured_at)}`,
    e.captures?.length > 1 ? ` · 收過 ${e.captures.length} 次` : '');

  const art = $('art');
  const parts = [srcLine, el('h1', { text: e.title })];
  if (ai.one_line || e.one_line_fallback) parts.push(el('p', { class: 'lead', text: ai.one_line || e.one_line_fallback }));
  if (e.why) parts.push(el('p', { class: 'why' }, el('span', { class: 'pill dark', text: '為什麼收' }), el('span', { text: e.why })));
  const basisNote = BASIS_NOTE[e.fetch?.basis] ?? '';
  if (basisNote) parts.push(el('p', { class: 'notice', text: basisNote }));
  if (e.notice) parts.push(el('p', { class: 'notice', text: e.notice }));
  if (!e.ai && e.fetch?.status !== 'failed' && e.ai_error) parts.push(el('p', { class: 'notice', text: 'AI 摘要這次沒有完成，內容已保存，之後可以重跑。' }));

  // Images (private repo → blob URLs).
  if (e.images?.length) {
    const gal = el('div', { class: 'gallery' });
    parts.push(gal);
    for (const p of e.images) {
      getBlobUrl(cfg, p).then((u) => { if (u) gal.append(el('img', { src: u, alt: '', loading: 'lazy' })); });
    }
  }

  // canonical_url has the share-tracking parameters removed.
  const original = safeUrl(e.canonical_url) || safeUrl(e.url);
  const btns = el('div', { class: 'vbtns' },
    original ? ext(original, e.has_video ? `到 ${PLATFORM_LABEL[e.platform] || '原網站'} 看影片` : '打開原文', 'btn go') : null,
    e.duration ? el('span', { class: 'muted', text: `影片長度 ${duration(e.duration)}` }) : null);
  parts.push(btns);

  if (ai.key_points?.length) parts.push(section('重點', list(ai.key_points)));

  if (e.chapters?.length && e.platform === 'youtube') {
    parts.push(section('章節', el('ul', {}, ...e.chapters.map((c) => el('li', { class: 'chap' },
      ext(youtubeAt(e.url, c.t), `▶ ${duration(c.t) || '0:00'}`), el('span', { text: c.label }))))));
  }

  if (e.places?.length) {
    parts.push(section('地點', el('p', { class: 'muted', style: 'margin:0;font-size:12px', text: '地圖連結由店名與地區搜尋，請點開確認是不是同一家。' }),
      ...e.places.map((p) => el('div', { class: 'place' }, el('span', { class: 'pill dark', text: p.type }),
        el('div', { class: 'nm' }, el('b', { text: p.name }), el('small', { text: [p.country, p.area, p.address].filter(Boolean).join(' · ') })),
        mapLink(p.map_url)))));
  }
  if (e.source_map_links?.length) {
    parts.push(section('原文附的地圖連結', el('ul', {}, ...e.source_map_links.map((u) => el('li', {}, ext(u, u))))));
  }

  const extra = Object.entries(ai.extra || {});
  if (extra.length) parts.push(section(e.category || '補充', el('dl', { class: 'kv' }, ...extra.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]))));
  if (ai.actions?.length) parts.push(section('可以怎麼用', list(ai.actions)));

  const tags = [...(ai.tags?.topics || []), ...(ai.tags?.scenarios || []), ...(ai.tags?.seasons || []), ai.tags?.budget].filter(Boolean);
  const badges = el('div', { class: 'badges' },
    e.category ? el('span', { class: 'pill dark', text: [e.category, e.category === '旅遊' ? '' : e.subcategory].filter(Boolean).join(' › ') }) : null,
    ...(e.locations || []).map((l) => el('span', { class: 'pill dark', text: `📍${l.filter(Boolean).join(' › ')}` })),
    ai.confidence && ai.confidence !== '高' ? el('span', { class: 'pill soft', text: `分類把握：${ai.confidence}` }) : null,
    ai.nature ? el('span', { class: 'pill soft', text: ai.nature }) : null,
    ai.sponsored === '可能業配' ? el('span', { class: 'pill', text: '可能業配' }) : null,
    e.reading_minutes ? el('span', { class: 'pill soft', text: `約 ${e.reading_minutes} 分鐘` }) : null,
    ...tags.map((t) => el('span', { class: 'pill soft', text: t })));
  parts.push(badges);

  // Original text: quotes on note paper, full text on demand.
  const clip = el('div', { class: 'clip' }, el('h2', { text: '原文' }),
    ...(ai.quotes || []).map((q) => el('blockquote', { text: `「${q}」` })));
  if (ai.image_text) clip.append(el('details', {}, el('summary', { text: '圖片裡的文字' }), el('p', { class: 'fulltext', text: ai.image_text })));
  if (e.fetch?.text_chars) {
    const d = el('details', {}, el('summary', { text: `看全文（${e.fetch.text_chars} 字）` }));
    d.addEventListener('toggle', async () => {
      if (!d.open || d.dataset.loaded) return;
      d.dataset.loaded = '1';
      const t = await getText(cfg, `library/${e.id}.txt`);
      d.append(el('p', { class: 'fulltext', text: t.text ?? '讀不到全文。' }));
    }, { once: false });
    clip.append(d);
  } else if (!ai.quotes?.length) {
    clip.append(el('p', { class: 'muted', style: 'margin:0', text: e.fetch?.reason || '沒有保存到原文文字。' }));
  }
  if (original) clip.append(el('p', { style: 'margin:8px 0 0;font-size:13px;overflow-wrap:anywhere' }, '原始連結：', ext(original, original)));
  parts.push(clip);

  parts.push(markBlock(cfg, e.id));
  const cats = (tax.data?.categories || []).map((c) => c.name);
  parts.push(el('div', { class: 'vbtns' }, fixBlock(cfg, e, cats), redoButton(cfg, e),
    e.overridden ? el('span', { class: 'muted', style: 'font-size:13px', text: '分類／地點是你改過的' }) : null));
  art.replaceChildren(...parts);
  art.hidden = false;
}

window.addEventListener('hashchange', () => location.reload());
main();
