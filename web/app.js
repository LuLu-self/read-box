'use strict';

import { loadCfg, saveCfg, clearCfg, DEFAULT_REPO, getJson, repoStatus, putFile } from './lib/gh.mjs';
import { parseLinks, safeUrl, makeId, isoLocal, shortDate, duration, facets, applyFilter, placesOf, rereadDue,
  thisWeek, markOf, MARKS, PLATFORM_LABEL, KIND_LABEL } from './lib/data.mjs';

const $ = (id) => document.getElementById(id);
const PENDING_KEY = 'readbox.pending';
const VIEW_KEY = 'readbox.view';
const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';

const S = {
  items: [], state: { items: {} }, categories: [],
  f: { category: '', sub: '', area: '', q: '', platforms: [], marks: [], placeTypes: [], unreadable: false },
  view: 'cards', loaded: false, error: '',
};

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k);
  return n;
}

function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage blocked */ } }
function recall(key, dflt) { try { return JSON.parse(localStorage.getItem(key)) ?? dflt; } catch { return dflt; } }

// ------------------------------------------------------------------ data

async function load() {
  const cfg = loadCfg();
  renderConn(cfg);
  if (!cfg) { S.error = 'no-cfg'; render(); return; }
  const [idx, st, tax] = await Promise.all([getJson(cfg, 'index.json'), getJson(cfg, 'state.json'), getJson(cfg, 'taxonomy.json')]);
  if (idx.status === 401 || idx.status === 403) S.error = 'auth';
  else if (idx.status === 404) S.error = (await repoStatus(cfg)) === 200 ? 'empty' : 'no-repo';
  else if (!idx.data) S.error = 'unavailable';
  else { S.error = ''; S.items = Array.isArray(idx.data.items) ? idx.data.items : []; }
  S.state = st.data && typeof st.data === 'object' ? st.data : { items: {} };
  S.categories = (tax.data?.categories || []).map((c) => c.name);
  S.loaded = true;
  prunePending();
  render();
}

// ------------------------------------------------------------------ capture

function pending() { const p = recall(PENDING_KEY, []); return Array.isArray(p) ? p : []; }

function prunePending() {
  const ids = new Set(S.items.map((i) => i.id));
  const fresh = pending().filter((p) => !ids.has(p.id) && Date.now() - Date.parse(p.at) < 2 * 3600000);
  store(PENDING_KEY, fresh);
}

async function capture(links, note, why) {
  const cfg = loadCfg();
  if (!cfg) { openSettings('先連結收藏庫，再收藏。'); return false; }
  const jobs = links.length ? links.map((url) => ({ url, text: '' })) : [{ url: '', text: note }];
  $('cap-btn').disabled = true;
  $('cap-hint').textContent = `送出中…（${jobs.length} 個）`;
  let ok = 0;
  const sent = $('sent');
  for (const job of jobs) {
    const now = new Date();
    const id = makeId(now);
    const cap = { v: 1, url: job.url, captured_at: isoLocal(now), why, text: job.text, client: 'board@1' };
    const res = await putFile(cfg, `inbox/${id}.json`, JSON.stringify(cap, null, 2) + '\n',
      `capture: ${job.url || '筆記'}`.slice(0, 120));
    const label = job.url || job.text.slice(0, 40);
    if (res.ok) {
      ok++;
      store(PENDING_KEY, [{ id, url: job.url, at: now.toISOString() }, ...pending()].slice(0, 50));
      sent.prepend(el('li', {}, el('span', { class: 'pill dark', text: '已收' }), el('span', { text: label })));
    } else {
      sent.prepend(el('li', {}, el('span', { class: 'pill', text: '沒收到' }),
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
  const why = $('why').value.trim().slice(0, 200);
  if (!text) { $('cap-hint').textContent = '先貼上連結或文字。'; return; }
  const links = parseLinks(text);
  capture(links, links.length ? '' : text, why).then((allOk) => {
    if (allOk) { $('links').value = ''; $('why').value = ''; }
  });
}

// Shared from the iPhone shortcut or the desktop bookmark: ?u=<link>&why=<text> or ?text=<shared text>.
function fromQuery() {
  const p = new URLSearchParams(location.search);
  const shared = [p.get('u'), p.get('text')].filter(Boolean).join('\n');
  if (!shared) return;
  history.replaceState(null, '', location.pathname);
  $('links').value = shared;
  $('why').value = (p.get('why') || '').slice(0, 200);
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

function renderRows() {
  const fc = facets(S.items, S.f, S.categories);
  $('cats').replaceChildren(
    chipButton('全部', S.items.length, !S.f.category, () => setF({ category: '', sub: '', area: '' })),
    ...fc.categories.map(([c, n]) => chipButton(c, n, S.f.category === c, () => setF({ category: c, sub: '', area: '' }))));
  $('subs').hidden = !S.f.category || !fc.subs.length;
  $('subs').replaceChildren(...fc.subs.map(([s, n]) => chipButton(s, n, S.f.sub === s,
    () => setF({ sub: S.f.sub === s ? '' : s, area: '' }))));
  $('areas').hidden = !S.f.sub || !fc.areas.length;
  $('areas').replaceChildren(...fc.areas.map(([a, n]) => chipButton(a, n, S.f.area === a,
    () => setF({ area: S.f.area === a ? '' : a }))));

  const active = [
    ...S.f.platforms.map((x) => [PLATFORM_LABEL[x] || x, () => setF({ platforms: S.f.platforms.filter((y) => y !== x) })]),
    ...S.f.marks.map((x) => [x, () => setF({ marks: S.f.marks.filter((y) => y !== x) })]),
    ...S.f.placeTypes.map((x) => [x, () => setF({ placeTypes: S.f.placeTypes.filter((y) => y !== x) })]),
    ...(S.f.unreadable ? [['只看讀不到的', () => setF({ unreadable: false })]] : []),
  ];
  $('filter-btn').textContent = active.length ? `篩選 (${active.length})` : '篩選';
  $('active').replaceChildren(...active.map(([t, fn]) => el('button', { class: 'on', type: 'button', onclick: fn, text: `${t} ✕` })));

  const toggle = (box, values, chosen, key, labels = {}) => box.replaceChildren(...values.map(([v, n]) =>
    chipButton(labels[v] || v, n, chosen.includes(v), () => {
      setF({ [key]: chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v] });
      renderRows();
    })));
  toggle($('f-platforms'), fc.platforms, S.f.platforms, 'platforms', PLATFORM_LABEL);
  toggle($('f-marks'), MARKS.map((m) => [m, S.items.filter((i) => markOf(S.state, i.id) === m).length]), S.f.marks, 'marks');
  toggle($('f-places'), fc.placeTypes, S.f.placeTypes, 'placeTypes');
  $('f-read').replaceChildren(chipButton('只看讀不到的', S.items.filter((i) => !i.ai_ok).length, S.f.unreadable,
    () => { setF({ unreadable: !S.f.unreadable }); renderRows(); }));
}

function card(i) {
  const mark = markOf(S.state, i.id);
  const who = [i.author, i.handle && i.platform !== 'web' ? `@${i.handle}` : ''].filter(Boolean).join(' ');
  const src = el('div', { class: 'src' },
    el('span', {}, el('b', { text: i.platform === 'web' ? (i.site_name || '網站') : (PLATFORM_LABEL[i.platform] || i.platform) }),
      who ? ` · ${who}` : '', i.kind === 'video' && i.duration ? ` · ${duration(i.duration)}` : ''),
    el('span', { text: `${shortDate(i.captured_at)} 收` }));
  const tags = el('div', { class: 'tags' },
    mark === '未讀' ? el('span', { class: 'pill', text: '未讀' }) : el('span', { class: 'pill dark', text: mark }),
    !i.ai_ok ? el('span', { text: i.fetch_status === 'failed' ? '讀不到' : '只有卡片' }) : null,
    i.basis === '試閱段' ? el('span', { text: '只有試閱' }) : null,
    i.category ? el('span', { text: [i.category, i.subcategory].filter(Boolean).join(' › ') }) : null,
    ...(i.tags?.place_types || []).slice(0, 3).map((t) => el('span', { text: t })),
    i.kind && i.kind !== 'social' && i.kind !== 'article' ? el('span', { text: KIND_LABEL[i.kind] || i.kind }) : null);
  return el('a', { class: 'card', href: `read.html#${encodeURIComponent(i.id)}`, 'data-m': mark === '未讀' ? null : mark },
    src, el('div', { class: 'tl', text: i.title }), i.one_line ? el('div', { class: 'ol', text: i.one_line }) : null, tags);
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

function render() {
  renderRows();
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
  if (S.items.length) {
    const week = thisWeek(S.items);
    $('hello').replaceChildren('這週收了 ', el('em', { text: String(week) }), ' 篇，', el('br'),
      due.length ? `有 ${due.length} 篇該重讀了` : `總共 ${S.items.length} 篇`);
  }

  const waiting = pending().filter((p) => !S.f.category && !S.f.q);
  const nodes = waiting.map((p) => el('div', { class: 'card pending' },
    el('div', { class: 'src' }, el('span', { text: '整理中…' }), el('span', { text: shortDate(p.at) })),
    el('div', { class: 'tl', text: p.url || '筆記' })));

  if (S.view === 'places') {
    const places = placesOf(shown, S.f.placeTypes);
    list.className = 'places';
    list.replaceChildren(...(places.length ? places.map((p) => el('div', { class: 'place' },
      el('span', { class: 'pill dark', text: p.type }),
      el('div', { class: 'nm' }, el('b', { text: p.name }),
        el('a', { href: `read.html#${encodeURIComponent(p.from)}`, text: `${[p.country, p.area].filter(Boolean).join(' › ')}　出自：${p.fromTitle}` })),
      safeUrl(p.map_url) ? mapLink(p.map_url) : null))
      : [el('p', { class: 'empty', text: S.items.length ? '這些文章裡沒有提到地點。' : emptyText() })]));
  } else {
    list.className = 'cards';
    list.replaceChildren(...nodes, ...(shown.length ? shown.map(card)
      : [el('p', { class: 'empty', text: S.items.length ? '沒有符合的收藏，換個條件試試。' : (S.loaded || S.error ? emptyText() : '載入中…') })]));
  }
  $('stats').textContent = S.items.length ? `顯示 ${shown.length} / ${S.items.length} 篇` : '';
}

function mapLink(url) {
  const a = el('a', { class: 'map', href: safeUrl(url), target: '_blank', rel: 'noopener noreferrer' });
  a.innerHTML = PIN; // fixed icon markup, no data
  a.append('地圖');
  return a;
}

function setF(patch) { Object.assign(S.f, patch); render(); }

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

// ------------------------------------------------------------------ wiring

$('capture').addEventListener('submit', onSubmit);
$('links').addEventListener('input', () => {
  const n = parseLinks($('links').value).length;
  $('cap-hint').textContent = $('links').value.trim() ? (n ? `找到 ${n} 個連結` : '沒有連結，會存成筆記') : '';
});
$('q').addEventListener('input', (e) => setF({ q: e.target.value }));
$('settings-btn').addEventListener('click', () => openSettings());
$('s-save').addEventListener('click', saveSettings);
$('s-cancel').addEventListener('click', () => $('settings').close());
$('s-logout').addEventListener('click', () => { clearCfg(); $('settings').close(); S.items = []; load(); });
$('filter-btn').addEventListener('click', () => $('filters').showModal());
$('f-done').addEventListener('click', () => $('filters').close());
$('f-clear').addEventListener('click', () => { setF({ platforms: [], marks: [], placeTypes: [], unreadable: false }); renderRows(); });
for (const [id, view] of [['v-cards', 'cards'], ['v-places', 'places']]) {
  $(id).addEventListener('click', () => {
    S.view = view;
    store(VIEW_KEY, view);
    $('v-cards').setAttribute('aria-pressed', String(view === 'cards'));
    $('v-places').setAttribute('aria-pressed', String(view === 'places'));
    render();
  });
}
S.view = recall(VIEW_KEY, 'cards') === 'places' ? 'places' : 'cards';
$('v-cards').setAttribute('aria-pressed', String(S.view === 'cards'));
$('v-places').setAttribute('aria-pressed', String(S.view === 'places'));

render();
load().then(fromQuery);
if (pending().length) schedulePoll();
