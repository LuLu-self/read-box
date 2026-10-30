'use strict';

import { loadCfg, getJson, updateJson, putFile } from './lib/gh.mjs';
import { withOverrides, makeId, isoLocal } from './lib/data.mjs';
import { el } from './lib/ui.mjs';
import { deleteItems } from './lib/remove.mjs';
import { INBOX, FIXED, addCategory, addSub, moveCategory, reassign, renameCategory, renameSub, removeCategory,
  removeSub, suggestFor } from './lib/taxonomy.mjs';

const $ = (id) => document.getElementById(id);
const DEFAULT = { v: 1, categories: ['旅遊', '美食', '運動', '健康', '語言', '生活', '工作', '學習成長', '心理', '人際關係', '理財', '科技與 AI', INBOX]
  .map((name) => ({ name, subs: [] })) };
const EMPTY_STATE = { v: 1, items: {} };
const S = { cfg: loadCfg(), tax: DEFAULT, state: EMPTY_STATE, raw: [], items: [], ai: {} };

const say = (t, err = false) => { $('msg').textContent = t; $('msg').className = err ? 'err' : 'muted'; };

async function load() {
  if (!S.cfg) { say('還沒連結收藏庫，請回首頁設定。', true); return; }
  const [tax, st, idx, ai] = await Promise.all([getJson(S.cfg, 'taxonomy.json'), getJson(S.cfg, 'state.json'),
    getJson(S.cfg, 'index.json'), getJson(S.cfg, 'suggestions.json')]);
  S.ai = ai.data && typeof ai.data === 'object' ? ai.data : {};
  if (tax.data?.categories) S.tax = tax.data;
  S.state = st.data || EMPTY_STATE;
  S.raw = idx.data?.items || [];
  S.items = withOverrides(S.raw, S.state);
  render();
}

// Run a pure edit, then write taxonomy.json and (if it changed) state.json. Each write re-applies the
// edit on the latest file so a change made elsewhere in the meantime is not lost.
async function apply(edit, done) {
  const probe = edit(S.tax, S.state, S.items);
  if (probe.error) { say(probe.error, true); return false; }
  say('儲存中…');
  const t = await updateJson(S.cfg, 'taxonomy.json', (cur) => {
    const r = edit(cur?.categories ? cur : S.tax, S.state, S.items);
    return r.tax || cur;
  }, 'taxonomy: 分類設定', DEFAULT);
  if (!t.ok) { say('分類沒存到，請再試一次（token 要有寫入權限）', true); return false; }
  if (probe.state && probe.state !== S.state) {
    const s = await updateJson(S.cfg, 'state.json', (cur) => edit(t.data, cur || EMPTY_STATE, S.items).state || cur,
      'state: 分類搬移', EMPTY_STATE);
    if (!s.ok) { say('分類存好了，但收藏沒搬成功，請再試一次', true); return false; }
    S.state = s.data;
  }
  S.tax = t.data;
  S.items = withOverrides(S.raw, S.state);
  say(done || '已儲存');
  render();
  return true;
}

// Ask the pipeline's AI which saved items fit this category; results land in suggestions.json.
async function askAi(name) {
  const now = new Date();
  const cap = { v: 1, url: '', text: '', captured_at: isoLocal(now), client: 'board@1', suggest_for: name };
  const r = await putFile(S.cfg, `inbox/${makeId(now)}.json`, JSON.stringify(cap, null, 2) + '\n', `suggest: ${name}`);
  say(r.ok ? `已請 AI 找「${name}」的收藏，約 2–5 分鐘後重新整理這頁` : 'AI 請求沒送出，請再試一次', !r.ok);
}

function renderAi() {
  const byId = new Map(S.items.map((i) => [i.id, i]));
  const blocks = Object.entries(S.ai).map(([name, v]) => {
    const picks = (v.items || []).map((x) => ({ ...x, item: byId.get(x.id) })).filter((x) => x.item && x.item.category !== name);
    if (!picks.length || !S.tax.categories.some((c) => c.name === name)) return null;
    const box = el('div', { class: 'pick' }, ...picks.map((x) => el('label', {}, el('input', { type: 'checkbox', value: x.id, checked: true }),
      el('span', {}, x.item.title, el('small', { text: `${x.reason}　（現在在：${x.item.category}）` })))));
    return el('div', { class: 'cat' }, el('div', { class: 'cat-head' }, el('b', { text: `可能屬於「${name}」` })), box,
      el('div', { class: 'row-btns', style: 'margin:0' },
        el('button', { class: 'btn small', type: 'button', text: '不用了', onclick: () => dropAi(name) }),
        el('button', { class: 'btn small go', type: 'button', text: '搬進來', onclick: () => {
          const ids = new Set(checked(box));
          if (!ids.size) return;
          apply((t, s, items) => ({ tax: t, state: reassign(s, items.filter((i) => ids.has(i.id)), name, '') }), `已搬 ${ids.size} 篇到「${name}」`)
            .then((ok) => { if (ok) dropAi(name); });
        } })));
  }).filter(Boolean);
  $('ai').hidden = !blocks.length;
  $('ai-list').replaceChildren(...blocks);
}

async function dropAi(name) {
  const r = await updateJson(S.cfg, 'suggestions.json', (cur) => { const c = { ...(cur || {}) }; delete c[name]; return c; }, `suggest: 清除 ${name}`, {});
  if (r.ok) { S.ai = r.data; renderAi(); }
}

function count(cat, sub) {
  return S.items.filter((i) => i.category === cat && (sub == null || i.subcategory === sub)).length;
}

function catBlock(c, n) {
  const fixed = FIXED.has(c.name);
  const subInput = el('input', { maxlength: '20', placeholder: c.name === '旅遊' ? '旅遊的次分類是國家 › 城市，自動產生' : `新增「${c.name}」的次分類`, 'aria-label': `新增${c.name}的次分類`, disabled: c.name === '旅遊' });
  return el('div', { class: 'cat' },
    el('div', { class: 'cat-head' },
      el('b', {}, c.name, el('small', { text: `　${count(c.name)} 篇` })),
      el('button', { class: 'btn small', type: 'button', text: '↑', 'aria-label': '上移', disabled: n === 0,
        onclick: () => apply((t) => moveCategory(t, c.name, -1)) }),
      el('button', { class: 'btn small', type: 'button', text: '↓', 'aria-label': '下移', disabled: n === S.tax.categories.length - 1,
        onclick: () => apply((t) => moveCategory(t, c.name, 1)) }),
      c.name === INBOX ? null : el('button', { class: 'btn small', type: 'button', text: 'AI 找', title: '請 AI 從所有收藏找出可能屬於這個分類的', onclick: () => askAi(c.name) }),
      fixed ? null : el('button', { class: 'btn small', type: 'button', text: '改名', onclick: () => {
        const to = prompt(`把「${c.name}」改成：`, c.name);
        if (to && to.trim() !== c.name) apply((t, s, items) => renameCategory(t, s, items, c.name, to.trim()), `已改名，${count(c.name)} 篇跟著搬過去`);
      } }),
      fixed ? null : el('button', { class: 'btn small', type: 'button', text: '刪除', onclick: () => {
        const others = S.tax.categories.map((x) => x.name).filter((x) => x !== c.name);
        const n2 = count(c.name);
        const to = n2 ? prompt(`「${c.name}」裡有 ${n2} 篇，要搬到哪個分類？（輸入分類名稱）\n${others.join('、')}`, INBOX) : INBOX;
        if (to == null) return;
        if (!n2 && !confirm(`確定刪除「${c.name}」？`)) return;
        apply((t, s, items) => removeCategory(t, s, items, c.name, to.trim()), `已刪除，${n2} 篇搬到「${to.trim()}」`);
      } })),
    el('div', { class: 'subs' }, ...c.subs.map((sub) => el('button', { class: 'sub', type: 'button', text: `${sub} ${count(c.name, sub)}`,
      title: '點一下改名或刪除', onclick: () => {
        const to = prompt(`次分類「${sub}」改成什麼？（清空並按確定 = 刪除）`, sub);
        if (to == null) return;
        if (!to.trim()) apply((t, s, items) => removeSub(t, s, items, c.name, sub), '已刪除次分類');
        else if (to.trim() !== sub) apply((t, s, items) => renameSub(t, s, items, c.name, sub, to.trim()), '已改名');
      } }))),
    c.name === '旅遊' || c.name === INBOX ? null : el('div', { class: 'add' }, subInput, el('button', { class: 'btn small', type: 'button', text: '新增',
      onclick: () => { const v = subInput.value.trim(); if (v) apply((t) => addSub(t, c.name, v), `已新增「${v}」`); } })));
}

function options(sel, values, keep) {
  sel.replaceChildren(...values.map(([v, label]) => el('option', { value: v, text: label })));
  if (values.some(([v]) => v === keep)) sel.value = keep;
}

function itemRow(i) {
  return el('label', {}, el('input', { type: 'checkbox', value: i.id }),
    el('span', {}, i.title, el('small', { text: [i.category, i.subcategory].filter(Boolean).join(' › ') })));
}

function renderMove() {
  const cats = S.tax.categories.map((c) => c.name);
  options($('from-cat'), cats.map((c) => [c, `${c}（${count(c)}）`]), $('from-cat').value || INBOX);
  const fc = S.tax.categories.find((c) => c.name === $('from-cat').value);
  const fromSubs = [...new Set(S.items.filter((i) => i.category === fc?.name).map((i) => i.subcategory || ''))];
  options($('from-sub'), [['*', '全部次分類'], ...fromSubs.map((s) => [s, s || '（沒有次分類）'])], $('from-sub').value || '*');
  options($('to-cat'), cats.map((c) => [c, c]), $('to-cat').value || cats[0]);
  renderTarget();
  const list = S.items.filter((i) => i.category === $('from-cat').value && ($('from-sub').value === '*' || (i.subcategory || '') === $('from-sub').value));
  $('move-list').replaceChildren(...(list.length ? list.map(itemRow) : [el('p', { class: 'muted', style: 'margin:0;font-size:13px', text: '這裡沒有收藏。' })]));
}

// Changing the destination must not reset the ticked items above it.
function renderTarget() {
  const tc = S.tax.categories.find((c) => c.name === $('to-cat').value);
  options($('to-sub'), [['', '不指定次分類'], ...(tc?.subs || []).map((s) => [s, s])], $('to-sub').value);
}

function render() {
  $('cats').replaceChildren(...S.tax.categories.map(catBlock));
  renderMove();
  renderAi();
}

function checked(box) { return [...box.querySelectorAll('input:checked')].map((x) => x.value); }

function showSuggest(name) {
  const cat = S.tax.categories.find((c) => c.name === name);
  const list = cat ? suggestFor(S.items, cat) : [];
  $('suggest').hidden = !list.length;
  if (!list.length) return;
  $('suggest-title').textContent = `可能屬於「${name}」的收藏`;
  $('suggest-list').replaceChildren(...list.map(itemRow));
  $('suggest-go').onclick = () => {
    const ids = new Set(checked($('suggest-list')));
    if (!ids.size) return;
    apply((t, s, items) => ({ tax: t, state: reassign(s, items.filter((i) => ids.has(i.id)), name, '') }), `已搬 ${ids.size} 篇到「${name}」`)
      .then((ok) => { if (ok) $('suggest').hidden = true; });
  };
}

$('add-cat').addEventListener('click', async () => {
  const v = $('new-cat').value.trim();
  if (!v) return;
  if (await apply((t) => addCategory(t, v), `已新增「${v}」`)) { $('new-cat').value = ''; showSuggest(v); askAi(v); }
});
$('suggest-skip').addEventListener('click', () => { $('suggest').hidden = true; });
for (const id of ['from-cat', 'from-sub']) $(id).addEventListener('change', renderMove);
$('to-cat').addEventListener('change', renderTarget);
$('pick-all').addEventListener('click', () => { for (const x of $('move-list').querySelectorAll('input')) x.checked = true; });
$('move-go').addEventListener('click', () => {
  const ids = new Set(checked($('move-list')));
  if (!ids.size) { say('先勾選要搬的收藏', true); return; }
  const cat = $('to-cat').value, sub = $('to-sub').value;
  apply((t, s, items) => ({ tax: t, state: reassign(s, items.filter((i) => ids.has(i.id)), cat, sub) }),
    `已搬 ${ids.size} 篇到「${[cat, sub].filter(Boolean).join(' › ')}」`);
});

$('del-go').addEventListener('click', async () => {
  const ids = checked($('move-list'));
  if (!ids.length) { say('先勾選要刪除的收藏', true); return; }
  if (!confirm(`刪除勾選的 ${ids.length} 篇？收藏庫裡的內容和圖片也會一起刪掉。`)) return;
  say('刪除中…');
  const r = await deleteItems(S.cfg, ids);
  if (r.state) { S.state = r.state; S.items = withOverrides(S.raw, S.state); render(); }
  say(r.ok ? `已刪除 ${ids.length} 篇` : '有幾篇沒刪成功，請再試一次', !r.ok);
});

load();
