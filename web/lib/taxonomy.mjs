// Pure edits on taxonomy.json and the matching state.json overrides (tested in node).
// Category changes never rewrite library entries: items follow through overrides in state.json,
// and the pipeline reads taxonomy.json for every new item.

export const INBOX = '收件匣';
// 旅遊 keeps 國家 › 城市 as its sub-categories; the pipeline relies on the name.
export const FIXED = new Set([INBOX, '旅遊']);
const NAME_RE = /^[^\s›/\\<>"]{1}[^›/\\<>"]{0,19}$/u;

export function validName(name) {
  const n = String(name || '').trim();
  return NAME_RE.test(n) ? n : null;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

export function addCategory(tax, name) {
  const n = validName(name);
  if (!n) return { error: '名稱 1–20 個字，不能有 › / \\ < > "' };
  if (tax.categories.some((c) => c.name === n)) return { error: '已經有這個分類' };
  const t = clone(tax);
  const inboxAt = t.categories.findIndex((c) => c.name === INBOX);
  t.categories.splice(inboxAt < 0 ? t.categories.length : inboxAt, 0, { name: n, subs: [] });
  return { tax: t };
}

export function addSub(tax, cat, name) {
  const n = validName(name);
  if (!n) return { error: '名稱 1–20 個字，不能有 › / \\ < > "' };
  const t = clone(tax);
  const c = t.categories.find((x) => x.name === cat);
  if (!c) return { error: '找不到分類' };
  if (c.subs.includes(n)) return { error: '已經有這個次分類' };
  c.subs.push(n);
  return { tax: t };
}

export function moveCategory(tax, name, delta) {
  const t = clone(tax);
  const i = t.categories.findIndex((c) => c.name === name);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= t.categories.length) return { tax: t };
  [t.categories[i], t.categories[j]] = [t.categories[j], t.categories[i]];
  return { tax: t };
}

// Overrides that point the given items at a new category/sub; existing location overrides stay.
export function reassign(state, items, category, subcategory = '') {
  const s = clone(state || { v: 1, items: {} });
  s.v = 1; s.items = s.items || {};
  const now = new Date().toISOString();
  for (const i of items) {
    const prev = s.items[i.id] || {};
    s.items[i.id] = { ...prev, override: { ...(prev.override || {}), category, subcategory }, updated_at: now };
  }
  return s;
}

export function renameCategory(tax, state, items, from, to) {
  const n = validName(to);
  if (!n) return { error: '名稱 1–20 個字，不能有 › / \\ < > "' };
  if (FIXED.has(from)) return { error: `${from}不能改名` };
  if (tax.categories.some((c) => c.name === n)) return { error: '已經有這個分類' };
  const t = clone(tax);
  const c = t.categories.find((x) => x.name === from);
  if (!c) return { error: '找不到分類' };
  c.name = n;
  const moved = items.filter((i) => i.category === from);
  return { tax: t, state: moved.length ? reassignKeepSub(state, moved, n) : state };
}

function reassignKeepSub(state, items, category) {
  const s = clone(state || { v: 1, items: {} });
  s.v = 1; s.items = s.items || {};
  const now = new Date().toISOString();
  for (const i of items) {
    const prev = s.items[i.id] || {};
    s.items[i.id] = { ...prev, override: { ...(prev.override || {}), category, subcategory: i.subcategory || '' }, updated_at: now };
  }
  return s;
}

export function renameSub(tax, state, items, cat, from, to) {
  const n = validName(to);
  if (!n) return { error: '名稱 1–20 個字，不能有 › / \\ < > "' };
  const t = clone(tax);
  const c = t.categories.find((x) => x.name === cat);
  if (!c || !c.subs.includes(from)) return { error: '找不到次分類' };
  if (c.subs.includes(n)) return { error: '已經有這個次分類' };
  c.subs = c.subs.map((x) => (x === from ? n : x));
  const moved = items.filter((i) => i.category === cat && i.subcategory === from);
  return { tax: t, state: moved.length ? reassign(state, moved, cat, n) : state };
}

// Removing a category moves its items to `target` (收件匣 by default); 收件匣 itself stays.
export function removeCategory(tax, state, items, name, target = INBOX) {
  if (FIXED.has(name)) return { error: `${name}不能刪除` };
  if (!tax.categories.some((c) => c.name === target) || target === name) return { error: '請選要搬去的分類' };
  const t = clone(tax);
  t.categories = t.categories.filter((c) => c.name !== name);
  const moved = items.filter((i) => i.category === name);
  return { tax: t, state: moved.length ? reassign(state, moved, target, '') : state, moved: moved.length };
}

export function removeSub(tax, state, items, cat, sub) {
  const t = clone(tax);
  const c = t.categories.find((x) => x.name === cat);
  if (!c) return { error: '找不到分類' };
  c.subs = c.subs.filter((x) => x !== sub);
  const moved = items.filter((i) => i.category === cat && i.subcategory === sub);
  return { tax: t, state: moved.length ? reassign(state, moved, cat, '') : state, moved: moved.length };
}

// Items that may belong to a (new) category: the name or a sub-category appears in the title,
// one-line summary, topics or why-saved. A keyword hint for LuLu to confirm, never applied by itself.
export function suggestFor(items, cat) {
  const words = [cat.name, ...(cat.subs || [])].map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
  return items.filter((i) => i.category !== cat.name && words.some((w) =>
    [i.title, i.one_line, i.why, ...(i.tags?.topics || [])].join(' ').toLowerCase().includes(w)));
}
