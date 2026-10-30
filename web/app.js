'use strict';

import { loadCfg, saveCfg, clearCfg, DEFAULT_REPO, getJson, repoStatus, putFile, listDir, deleteFile } from './lib/gh.mjs';
import { parseLinks, safeUrl, makeId, isoLocal, shortDate, duration, facets, applyFilter, placesOf, rereadDue,
  thisWeek, markOf, withOverrides, myMapsCsv, MYMAPS_MAX_ROWS, MARKS, PLATFORM_LABEL, KIND_LABEL } from './lib/data.mjs';
import { el, brandMark } from './lib/ui.mjs';
import { deleteItems } from './lib/remove.mjs';

const $ = (id) => document.getElementById(id);
const PENDING_KEY = 'readbox.pending';
const VIEW_KEY = 'readbox.view';
const LENS_KEY = 'readbox.lens';
const COLS_KEY = 'readbox.cols';
const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';

const EMPTY_F = { lens: 'cat', category: '', sub: '', area: '', country: '', city: '', types: [], q: '',
  platforms: [], marks: [], placeTypes: [], unreadable: false };
const S = { raw: [], items: [], state: { items: {} }, categories: [], failed: [], f: { ...EMPTY_F },
  view: 'cards', loaded: false, error: '', sharedBody: '', picked: null, cols: 1 };

function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage blocked */ } }
function recall(key, dflt) { try { return JSON.parse(localStorage.getItem(key)) ?? dflt; } catch { return dflt; } }

// ------------------------------------------------------------------ data

async function load() {
  const cfg = loadCfg();
  renderConn(cfg);
  if (!cfg) { S.error = 'no-cfg'; render(); return; }
  const [idx, st, tax, failed] = await Promise.all([getJson(cfg, 'index.json'), getJson(cfg, 'state.json'),
    getJson(cfg, 'taxonomy.json'), listDir(cfg, 'inbox/failed')]);
  if (idx.status === 401 || idx.status === 403) S.error = 'auth';
  else if (idx.status === 404) S.error = (await repoStatus(cfg)) === 200 ? 'empty' : 'no-repo';
  else if (!idx.data) S.error = 'unavailable';
  else { S.error = ''; S.raw = Array.isArray(idx.data.items) ? idx.data.items : []; }
  S.state = st.data && typeof st.data === 'object' ? st.data : { items: {} };
  S.items = withOverrides(S.raw, S.state);
  S.categories = (tax.data?.categories || []).map((c) => c.name);
  S.failed = await loadFailed(cfg, failed);
  S.loaded = true;
  prunePending();
  render();
}

// Captures the pipeline could not keep (nothing readable and no title): shown once, then dismissed.
async function loadFailed(cfg, files) {
  const out = [];
  for (const f of files.filter((x) => x.name.endsWith('.json')).slice(-20)) {
    const r = await getJson(cfg, f.path);
    if (r.data) out.push({ ...f, url: safeUrl(r.data.url), error: String(r.data.error || '沒有收進來'), at: r.data.captured_at });
  }
  return out;
}

// ------------------------------------------------------------------ capture

function pending() { const p = recall(PENDING_KEY, []); return Array.isArray(p) ? p : []; }

function prunePending() {
  const done = new Set([...S.raw.map((i) => i.id), ...S.failed.map((f) => f.name.replace(/\.json$/, ''))]);
  store(PENDING_KEY, pending().filter((p) => !done.has(p.id) && Date.now() - Date.parse(p.at) < 2 * 3600000));
}

async function capture(links, note) {
  const cfg = loadCfg();
  if (!cfg) { openSettings('先連結收藏庫，再收藏。'); return false; }
  // body: article text the iPhone shortcut read from Safari (what LuLu could see, paywall or not).
  const body = links.length === 1 ? S.sharedBody : '';
  S.sharedBody = '';
  const jobs = links.length ? links.map((url) => ({ url, text: body })) : [{ url: '', text: note }];
  $('cap-btn').disabled = true;
  $('cap-hint').textContent = `送出中…（${jobs.length} 個）`;
  let ok = 0;
  for (const job of jobs) {
    const now = new Date();
    const id = makeId(now);
    const cap = { v: 1, url: job.url, captured_at: isoLocal(now), why: '', text: job.text, client: 'board@1' };
    const res = await putFile(cfg, `inbox/${id}.json`, JSON.stringify(cap, null, 2) + '\n', `capture: ${job.url || '筆記'}`.slice(0, 120));
    const label = job.url || job.text.slice(0, 40);
    if (res.ok) {
      ok++;
      store(PENDING_KEY, [{ id, url: job.url, at: now.toISOString() }, ...pending()].slice(0, 50));
      $('sent').prepend(el('li', {}, el('span', { class: 'pill dark', text: '已收' }), el('span', { text: label })));
    } else {
      $('sent').prepend(el('li', {}, el('span', { class: 'pill', text: '沒收到' }),
        el('span', { text: `${label}（${res.status === 401 ? 'token 失效' : res.message || 'GitHub ' + res.status}）` })));
    }
  }
  $('cap-btn').disabled = false;
  $('cap-hint').textContent = ok === jobs.length
    ? `收好了 ${ok} 個，整理約需 2–5 分鐘。` : `${ok} 個成功、${jobs.length - ok} 個失敗，失敗的可以再按一次。`;
  render();
  if (ok) schedulePoll();
  return ok === jobs.length;
}

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const started = Date.now();
  const tick = async () => {
    await load();
    if (pending().length && Date.now() - started < 12 * 60000) pollTimer = setTimeout(tick, 30000);
  };
  pollTimer = setTimeout(tick, 45000);
}

function onSubmit(e) {
  e.preventDefault();
  const text = $('links').value.trim();
  if (!text) { $('cap-hint').textContent = '先貼上連結或文字。'; return; }
  const links = parseLinks(text);
  capture(links, links.length ? '' : text).then((allOk) => { if (allOk) $('links').value = ''; });
}

// Shared from the iPhone shortcut or the desktop bookmark: ?u=<link>[&body=<article text>]
// or ?text=<shared text>.
function fromQuery() {
  const p = new URLSearchParams(location.search);
  const shared = [p.get('u'), p.get('text')].filter(Boolean).join('\n');
  if (!shared) return;
  history.replaceState(null, '', location.pathname);
  S.sharedBody = (p.get('body') || '').trim().slice(0, 60000);
  $('links').value = shared;
  if (loadCfg() && parseLinks(shared).length) $('capture').requestSubmit();
  else $('links').focus();
}

// ------------------------------------------------------------------ render

function renderConn(cfg) {
  $('conn').textContent = cfg ? cfg.repo.split('/')[1] : '還沒連結';
  $('settings-btn').dataset.ok = cfg ? '1' : '0';
}

function chipButton(label, count, pressed, onClick) {
  return el('button', { type: 'button', 'aria-pressed': String(pressed), onclick: onClick },
    label, count != null ? el('small', { text: String(count) }) : null);
}

function fillRow(id, entries, isOn, onPick, show = entries.length > 0) {
  $(id).hidden = !show;
  $(id).replaceChildren(...entries.map(([v, n]) => chipButton(v, n, isOn(v), () => onPick(v))));
}

function renderRows() {
  const f = S.f;
  const fc = facets(S.items, f, S.categories);
  const place = f.lens === 'place';
  $('l-cat').setAttribute('aria-pressed', String(!place));
  $('l-place').setAttribute('aria-pressed', String(place));

  // 依地點看: 國家 → 城市 → 地點類型, with categories as a secondary row.
  fillRow('countries', fc.countries, (v) => f.country === v, (v) => setF({ country: f.country === v ? '' : v, city: '', types: [] }), place);
  fillRow('cities', fc.cities, (v) => f.city === v, (v) => setF({ city: f.city === v ? '' : v, types: [] }), place && !!f.country && fc.cities.length > 0);
  fillRow('types', fc.types, (v) => f.types.includes(v),
    (v) => setF({ types: f.types.includes(v) ? f.types.filter((x) => x !== v) : [...f.types, v] }), place && !!f.country && fc.types.length > 0);
  if (place && !fc.countries.length) {
    $('countries').hidden = false;
    $('countries').replaceChildren(el('span', { class: 'muted', style: 'font-size:13px', text: '還沒有收藏提到地點。收旅遊或美食文章後，這裡會出現國家和城市。' }));
  }

  const all = chipButton('全部', place ? null : S.items.length, !f.category, () => setF({ category: '', sub: '', area: '' }));
  $('cats').replaceChildren(all, ...fc.categories.map(([c, n]) => chipButton(c, n, f.category === c,
    () => setF({ category: f.category === c ? '' : c, sub: '', area: '' }))));

  // 依分類看: 次分類 (旅遊 drills 國家 › 城市), and for other categories a 地區 row.
  fillRow('subs', place ? [] : fc.subs, (v) => f.sub === v, (v) => setF({ sub: f.sub === v ? '' : v, area: '' }), !place && !!f.category && fc.subs.length > 0);
  fillRow('areas', place ? [] : fc.areas, (v) => f.area === v, (v) => setF({ area: f.area === v ? '' : v }), !place && !!f.sub && fc.areas.length > 0);
  const locs = !place && f.category && f.category !== '旅遊'
    ? fc.cities.length && f.country ? fc.cities.map(([c, n]) => [`${f.country} › ${c}`, n]) : fc.countries : [];
  fillRow('locs', locs, (v) => v === f.country || v === `${f.country} › ${f.city}`, (v) => {
    const [c, ci = ''] = v.split(' › ');
    if (ci) setF({ city: f.city === ci ? '' : ci });
    else setF({ country: f.country === c ? '' : c, city: '' });
  }, locs.length > 0);

  const active = [
    ...f.platforms.map((x) => [PLATFORM_LABEL[x] || x, () => setF({ platforms: f.platforms.filter((y) => y !== x) })]),
    ...f.marks.map((x) => [x, () => setF({ marks: f.marks.filter((y) => y !== x) })]),
    ...f.placeTypes.map((x) => [x, () => setF({ placeTypes: f.placeTypes.filter((y) => y !== x) })]),
    ...(f.unreadable ? [['只看讀不到的', () => setF({ unreadable: false })]] : []),
  ];
  $('filter-btn').textContent = active.length ? `篩選 (${active.length})` : '篩選';
  $('active').replaceChildren(...active.map(([t, fn]) => el('button', { class: 'on', type: 'button', onclick: fn, text: `${t} ✕` })));
  $('q-clear').hidden = !f.q;

  const toggle = (box, values, chosen, key, labels = {}) => box.replaceChildren(...values.map(([v, n]) =>
    chipButton(labels[v] || v, n, chosen.includes(v), () => setF({ [key]: chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v] }))));
  toggle($('f-platforms'), fc.platforms, f.platforms, 'platforms', PLATFORM_LABEL);
  toggle($('f-marks'), MARKS.map((m) => [m, S.items.filter((i) => markOf(S.state, i.id) === m).length]), f.marks, 'marks');
  toggle($('f-places'), fc.placeTypes, f.placeTypes, 'placeTypes');
  $('f-read').replaceChildren(chipButton('只看讀不到的', S.items.filter((i) => !i.ai_ok).length, f.unreadable,
    () => setF({ unreadable: !f.unreadable })));
}

function card(i, cfg) {
  const mark = markOf(S.state, i.id);
  const who = [i.platform === 'web' ? i.author : i.author, i.handle && i.platform !== 'web' ? `@${i.handle}` : ''].filter(Boolean).join(' ');
  const src = el('div', { class: 'src' },
    el('span', {}, brandMark(i, cfg), who ? ` · ${who}` : '', i.kind === 'video' && i.duration ? ` · ${duration(i.duration)}` : ''),
    el('span', { text: `${shortDate(i.captured_at)} 收` }));
  const where = (i.locations || []).slice(0, 2).map((l) => l.filter(Boolean).join(' › '));
  const tags = el('div', { class: 'tags' },
    mark === '未讀' ? el('span', { class: 'pill', text: '未讀' }) : el('span', { class: 'pill dark', text: mark }),
    !i.ai_ok ? el('span', { text: i.fetch_status === 'failed' ? '讀不到' : '只有卡片' }) : null,
    i.basis === '試閱段' ? el('span', { text: '只有試閱' }) : null,
    i.category ? el('span', { text: [i.category, i.category === '旅遊' ? '' : i.subcategory].filter(Boolean).join(' › ') }) : null,
    ...where.map((w) => el('span', { text: `📍${w}` })),
    ...(i.tags?.place_types || []).slice(0, 3).map((t) => el('span', { text: t })),
    i.kind && !['social', 'article'].includes(i.kind) ? el('span', { text: KIND_LABEL[i.kind] || i.kind }) : null);
  const body = [src, el('div', { class: 'tl', text: i.title }), i.one_line ? el('div', { class: 'ol', text: i.one_line }) : null, tags];
  const m = mark === '未讀' ? null : mark;
  if (!S.picked) return el('a', { class: 'card', href: `read.html#${encodeURIComponent(i.id)}`, 'data-m': m }, ...body);
  // 選取模式: the whole card toggles its checkbox instead of opening the item.
  const on = S.picked.has(i.id);
  const box = el('input', { type: 'checkbox', class: 'tick', 'aria-label': `選取：${i.title}` });
  box.checked = on;
  box.addEventListener('change', () => { if (box.checked) S.picked.add(i.id); else S.picked.delete(i.id); render(); });
  return el('label', { class: `card${on ? ' picked' : ''}`, 'data-m': m }, box, ...body);
}

// ------------------------------------------------------------------ batch delete

function setPicking(on) {
  S.picked = on ? new Set() : null;
  if (on && S.view !== 'cards') setView('cards'); else render();
}

function renderPickBar(shown) {
  const on = !!S.picked;
  $('pick-btn').textContent = on ? '完成' : '選取';
  $('pick-btn').setAttribute('aria-pressed', String(on));
  $('pick-bar').hidden = !on;
  if (!on) return;
  // Keep only what is still on screen, so 刪除 never touches cards hidden by a filter.
  const ids = new Set(shown.map((i) => i.id));
  for (const id of S.picked) if (!ids.has(id)) S.picked.delete(id);
  const n = S.picked.size;
  $('pick-n').textContent = n ? `已選 ${n} 篇` : '點卡片來選取';
  $('pick-all').textContent = n && n === shown.length ? '全不選' : '全選';
  $('pick-del').disabled = !n;
}

function openBatchDelete() {
  const n = S.picked?.size || 0;
  if (!n) return;
  $('bd-text').textContent = `選取的 ${n} 篇會從看板移除，收藏庫裡的內容和圖片也會一起刪掉，刪了就找不回來。`;
  $('bd-msg').textContent = '';
  $('bd-go').disabled = false;
  $('batch-del').showModal();
}

async function batchDelete() {
  const cfg = loadCfg();
  const ids = [...(S.picked || [])];
  if (!cfg || !ids.length) return;
  $('bd-go').disabled = true;
  $('bd-msg').textContent = `刪除中…（${ids.length} 篇）`;
  const r = await deleteItems(cfg, ids);
  if (!r.state) { $('bd-msg').textContent = '沒刪成功，請再試一次'; $('bd-go').disabled = false; return; }
  S.state = r.state;
  S.items = withOverrides(S.raw, S.state);
  $('batch-del').close();
  setPicking(false);
  $('stats').textContent = r.ok ? `刪掉 ${ids.length} 篇了。` : `已從看板移除 ${ids.length} 篇；有幾篇的檔案還沒排進刪除，之後再刪一次就好。`;
}

function emptyText() {
  return {
    'no-cfg': '還沒連結收藏庫。按右上角「還沒連結」，貼上收藏庫名稱和 token。',
    auth: 'token 失效或沒有權限，請到右上角重新貼上。',
    'no-repo': '找不到收藏庫，或 token 沒有它的權限。請到右上角確認。',
    empty: '還沒有收藏。貼上第一個連結試試看。',
    unavailable: '暫時連不到 GitHub，稍後再試。',
  }[S.error] || '';
}

function mapLink(url) {
  const a = el('a', { class: 'map', href: safeUrl(url), target: '_blank', rel: 'noopener noreferrer' });
  a.innerHTML = PIN; // fixed icon markup, no data
  a.append('地圖');
  return a;
}

function failedBox(cfg) {
  if (!S.failed.length) return null;
  return el('div', { class: 'reread', style: 'flex-direction:column;align-items:stretch;gap:6px' },
    el('b', { text: `有 ${S.failed.length} 個沒收進來` }),
    ...S.failed.map((f) => el('div', { style: 'display:flex;gap:8px;align-items:center;font-size:13px;min-width:0' },
      el('div', { style: 'flex:1;min-width:0;overflow-wrap:anywhere' },
        f.url ? el('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer', text: f.url }) : '（沒有連結）',
        el('div', { class: 'muted', text: f.error })),
      el('button', { class: 'btn small', type: 'button', text: '知道了', onclick: async (e) => {
        e.target.disabled = true;
        if (await deleteFile(cfg, f.path, f.sha, `dismiss: ${f.name}`)) { S.failed = S.failed.filter((x) => x !== f); render(); }
        else e.target.disabled = false;
      } }))));
}

function render() {
  renderRows();
  const cfg = loadCfg();
  const list = $('list');
  const shown = applyFilter(S.items, S.f, S.state);
  const due = rereadDue(S.items, S.state);
  $('reread').hidden = !due.length;
  if (due.length) {
    const d = due[0];
    $('reread').href = `read.html#${encodeURIComponent(d.id)}`;
    $('reread').replaceChildren(el('span', { class: 'pill', text: '該重讀了' }),
      el('div', {}, el('b', { text: d.title }), el('span', { text: `${due.length > 1 ? `還有 ${due.length - 1} 篇 · ` : ''}${d.category}` })));
  }
  $('failed').replaceChildren(...[failedBox(cfg)].filter(Boolean));
  if (S.items.length) {
    $('hello').replaceChildren('這週收了 ', el('em', { text: String(thisWeek(S.items)) }), ' 篇，', el('br'),
      due.length ? `有 ${due.length} 篇該重讀了` : `總共 ${S.items.length} 篇`);
  }

  const places = placesOf(shown, S.f);
  $('export').hidden = S.view !== 'places' || !places.length;
  $('export-n').textContent = `${places.length} 個地點`;

  if (S.view === 'places') {
    list.className = 'places';
    delete list.dataset.cols;
    list.replaceChildren(...(places.length ? places.map((p) => el('div', { class: 'place' },
      el('span', { class: 'pill dark', text: p.type }),
      el('div', { class: 'nm' }, el('b', { text: p.name }),
        el('div', { class: 'loc', text: [p.country, p.city, p.district].filter(Boolean).join(' › ') }),
        el('a', { href: `read.html#${encodeURIComponent(p.from)}`, text: `出自：${p.fromTitle}` })),
      safeUrl(p.map_url) ? mapLink(p.map_url) : null))
      : [el('p', { class: 'empty', text: S.items.length ? '這些收藏裡沒有提到店家或景點。' : emptyText() })]));
  } else {
    const waiting = !S.picked && !S.f.category && !S.f.q && !S.f.country ? pending() : [];
    list.className = 'cards';
    if (S.cols > 1) list.dataset.cols = String(S.cols); else delete list.dataset.cols;
    list.replaceChildren(
      ...waiting.map((p) => el('div', { class: 'card pending' },
        el('div', { class: 'src' }, el('span', { text: '整理中…' }), el('span', { text: shortDate(p.at) })),
        el('div', { class: 'tl', text: p.url || '筆記' }))),
      ...(shown.length ? shown.map((i) => card(i, cfg))
        : [el('p', { class: 'empty', text: S.items.length ? '沒有符合的收藏，換個條件試試。' : (S.loaded || S.error ? emptyText() : '載入中…') })]));
  }
  $('stats').textContent = S.items.length ? `顯示 ${shown.length} / ${S.items.length} 篇` : '';
  renderPickBar(S.view === 'cards' ? shown : []);
  $('cols').hidden = S.view !== 'cards';
  for (const b of $('cols').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.cols) === S.cols));
}

function setF(patch) { Object.assign(S.f, patch); if ('lens' in patch) store(LENS_KEY, patch.lens); render(); }

function setView(view) {
  S.view = view;
  if (view !== 'cards') S.picked = null;
  store(VIEW_KEY, view);
  $('v-cards').setAttribute('aria-pressed', String(view === 'cards'));
  $('v-places').setAttribute('aria-pressed', String(view === 'places'));
  render();
}

// ------------------------------------------------------------------ export

let csvUrl = null;
function openExport() {
  const places = placesOf(applyFilter(S.items, S.f, S.state), S.f);
  const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
  if (csvUrl) URL.revokeObjectURL(csvUrl);
  csvUrl = URL.createObjectURL(new Blob([myMapsCsv(places, base)], { type: 'text/csv;charset=utf-8' }));
  const where = [S.f.country, S.f.city, ...S.f.types].filter(Boolean).join(' › ') || '全部';
  $('mm-download').href = csvUrl;
  $('mm-download').setAttribute('download', `read-box-${where.replace(/[ ›/\\:*?"<>|]+/g, '-')}.csv`);
  $('mm-n').textContent = `${where}：${Math.min(places.length, MYMAPS_MAX_ROWS)} 個地點${places.length > MYMAPS_MAX_ROWS ? `（超過 ${MYMAPS_MAX_ROWS} 個的部分沒有放進去，請縮小範圍）` : ''}`;
  $('mymaps').showModal();
}

// ------------------------------------------------------------------ settings

function openSettings(msg = '') {
  const cfg = loadCfg();
  $('s-repo').value = cfg?.repo || DEFAULT_REPO;
  $('s-token').value = '';
  $('s-token').placeholder = cfg ? '已儲存（要換才重新貼）' : 'github_pat_…';
  $('s-err').textContent = msg;
  const base = `${location.origin}${location.pathname}`;
  $('s-shortcut').textContent = `${base}?u=`;
  $('s-bookmarklet').href = `javascript:location.href='${base}?u='+encodeURIComponent(location.href)`;
  $('settings').showModal();
}

async function saveSettings() {
  const cfg = loadCfg();
  const repo = $('s-repo').value.trim();
  const token = $('s-token').value.trim() || cfg?.token || '';
  if (!saveCfg(repo, token)) { $('s-err').textContent = '收藏庫要寫成「帳號/repo」，token 不能空白。'; return; }
  const st = await repoStatus(loadCfg());
  if (st !== 200) {
    $('s-err').textContent = st === 401 ? 'token 無效，請重新複製。' : st === 404 ? '找不到收藏庫，或 token 沒有勾這個 repo。' : `GitHub 回應 ${st}，請稍後再試。`;
    return;
  }
  $('settings').close();
  load();
}

// ------------------------------------------------------------------ appearance

const THEME_KEY = 'readbox.theme';
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  try { if (choice === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, choice); } catch { /* storage blocked */ }
  for (const b of document.querySelectorAll('[data-theme-choice]')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
}
for (const b of document.querySelectorAll('[data-theme-choice]')) b.addEventListener('click', () => applyTheme(b.dataset.themeChoice));
applyTheme(document.documentElement.dataset.theme || 'auto');

// ------------------------------------------------------------------ wiring

$('capture').addEventListener('submit', onSubmit);
$('links').addEventListener('input', () => {
  const n = parseLinks($('links').value).length;
  $('cap-hint').textContent = $('links').value.trim() ? (n ? `找到 ${n} 個連結` : '沒有連結，會存成筆記') : '';
});
$('q').addEventListener('input', (e) => setF({ q: e.target.value }));
$('q-clear').addEventListener('click', () => { $('q').value = ''; setF({ q: '' }); });
$('l-cat').addEventListener('click', () => setF({ lens: 'cat', country: '', city: '', types: [] }));
$('l-place').addEventListener('click', () => setF({ lens: 'place', sub: '', area: '', category: '' }));
$('settings-btn').addEventListener('click', () => openSettings());
$('s-save').addEventListener('click', saveSettings);
$('s-cancel').addEventListener('click', () => $('settings').close());
$('s-logout').addEventListener('click', () => { clearCfg(); $('settings').close(); S.raw = []; S.items = []; load(); });
$('filter-btn').addEventListener('click', () => $('filters').showModal());
$('f-done').addEventListener('click', () => $('filters').close());
$('f-clear').addEventListener('click', () => setF({ platforms: [], marks: [], placeTypes: [], unreadable: false }));
$('v-cards').addEventListener('click', () => setView('cards'));
$('v-places').addEventListener('click', () => setView('places'));
$('export-btn').addEventListener('click', openExport);
$('mm-cancel').addEventListener('click', () => $('mymaps').close());
for (const b of $('cols').querySelectorAll('button')) {
  b.addEventListener('click', () => { S.cols = Number(b.dataset.cols); store(COLS_KEY, S.cols); render(); });
}
$('pick-btn').addEventListener('click', () => setPicking(!S.picked));
$('pick-cancel').addEventListener('click', () => setPicking(false));
$('pick-all').addEventListener('click', () => {
  const shown = applyFilter(S.items, S.f, S.state);
  S.picked = new Set(S.picked.size === shown.length ? [] : shown.map((i) => i.id));
  render();
});
$('pick-del').addEventListener('click', openBatchDelete);
$('bd-cancel').addEventListener('click', () => $('batch-del').close());
$('bd-go').addEventListener('click', batchDelete);

// Browsers may autofill the search box from saved form data; never start with a hidden filter.
$('q').value = '';
S.view = recall(VIEW_KEY, 'cards') === 'places' ? 'places' : 'cards';
S.f.lens = recall(LENS_KEY, 'cat') === 'place' ? 'place' : 'cat';
S.cols = [1, 2, 3].includes(recall(COLS_KEY, 1)) ? recall(COLS_KEY, 1) : 1;
setView(S.view);
load().then(fromQuery);
if (pending().length) schedulePoll();
// Some autofill lands after load; clear it unless LuLu is typing.
setTimeout(() => { if ($('q').value && document.activeElement !== $('q')) { $('q').value = ''; setF({ q: '' }); } }, 800);
