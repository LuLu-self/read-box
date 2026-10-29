import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCategory, addSub, renameCategory, renameSub, removeCategory, removeSub, reassign, suggestFor, moveCategory } from '../lib/taxonomy.mjs';

const tax = { v: 1, categories: [{ name: '旅遊', subs: [] }, { name: '美食', subs: ['小吃'] }, { name: '收件匣', subs: [] }] };
const items = [
  { id: 'a', category: '美食', subcategory: '小吃', title: '大阪章魚燒' },
  { id: 'b', category: '收件匣', subcategory: '', title: '咖啡手沖入門', tags: { topics: ['咖啡'] } },
];

test('add category goes before 收件匣 and rejects duplicates and bad names', () => {
  const r = addCategory(tax, '咖啡');
  assert.deepEqual(r.tax.categories.map((c) => c.name), ['旅遊', '美食', '咖啡', '收件匣']);
  assert.ok(addCategory(tax, '美食').error);
  assert.ok(addCategory(tax, 'a›b').error);
  assert.ok(addCategory(tax, '').error);
});

test('rename category moves its items through overrides', () => {
  const r = renameCategory(tax, { v: 1, items: {} }, items, '美食', '吃吃喝喝');
  assert.equal(r.tax.categories[1].name, '吃吃喝喝');
  assert.deepEqual(r.state.items.a.override, { category: '吃吃喝喝', subcategory: '小吃' });
  assert.ok(renameCategory(tax, {}, items, '收件匣', 'x').error);
  assert.ok(renameCategory(tax, {}, items, '旅遊', 'x').error);
});

test('rename and remove sub-category', () => {
  const r = renameSub(tax, {}, items, '美食', '小吃', '路邊攤');
  assert.deepEqual(r.tax.categories[1].subs, ['路邊攤']);
  assert.equal(r.state.items.a.override.subcategory, '路邊攤');
  const d = removeSub(tax, {}, items, '美食', '小吃');
  assert.deepEqual(d.tax.categories[1].subs, []);
  assert.equal(d.state.items.a.override.subcategory, '');
  assert.deepEqual(addSub(tax, '美食', '甜點').tax.categories[1].subs, ['小吃', '甜點']);
});

test('remove category sends items to the chosen target', () => {
  const r = removeCategory(tax, {}, items, '美食', '收件匣');
  assert.deepEqual(r.tax.categories.map((c) => c.name), ['旅遊', '收件匣']);
  assert.equal(r.moved, 1);
  assert.equal(r.state.items.a.override.category, '收件匣');
  assert.ok(removeCategory(tax, {}, items, '收件匣').error);
});

test('reassign keeps other state and suggestions match keywords', () => {
  const s = reassign({ v: 1, items: { b: { mark: '有用', override: { locations: [['日本', '大阪']] } } } }, [items[1]], '咖啡', '');
  assert.equal(s.items.b.mark, '有用');
  assert.deepEqual(s.items.b.override.locations, [['日本', '大阪']]);
  assert.deepEqual(suggestFor(items, { name: '咖啡', subs: [] }).map((i) => i.id), ['b']);
  assert.deepEqual(moveCategory(tax, '美食', -1).tax.categories.map((c) => c.name), ['美食', '旅遊', '收件匣']);
});
