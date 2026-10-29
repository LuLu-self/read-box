import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinks, safeUrl, makeId, facets, applyFilter, placesOf, rereadDue, youtubeAt, splitSub, duration,
  withOverrides, locationsOf, myMapsCsv } from '../lib/data.mjs';

test('parseLinks finds every link, trims glued punctuation, drops duplicates', () => {
  const t = '看這篇 https://a.example/x?y=1。還有（https://b.example/p）和 https://a.example/x?y=1 ，再見';
  assert.deepEqual(parseLinks(t), ['https://a.example/x?y=1', 'https://b.example/p']);
  assert.deepEqual(parseLinks('沒有連結的筆記'), []);
});

test('safeUrl only lets http(s) through', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://x.example/a'), 'https://x.example/a');
  assert.equal(safeUrl(''), null);
});

test('makeId has the inbox id shape', () => {
  assert.match(makeId(new Date(2026, 9, 29, 9, 5, 7), 0xab), /^20261029-090507-00ab$/);
});

const items = [
  { id: 'a', category: '旅遊', subcategory: '日本 › 大阪', platform: 'threads', title: '大阪章魚燒', ai_ok: true,
    tags: { place_types: ['小吃'], topics: ['章魚燒'] }, places: [{ name: 'わなか', type: '小吃', country: '日本', city: '大阪', district: '難波' }] },
  { id: 'b', category: '旅遊', subcategory: '日本 › 京都', platform: 'instagram', title: '京都住宿', ai_ok: true,
    tags: { place_types: ['住宿'] }, places: [{ name: '某旅館', type: '住宿', country: '日本', area: '京都' }] },
  { id: 'c', category: '理財', subcategory: '', platform: 'web', title: 'Google 財報', ai_ok: true, tags: {} },
  { id: 'd', category: '收件匣', subcategory: '', platform: 'medium', title: '讀不到', ai_ok: false, tags: {} },
  { id: 'e', category: '美食', subcategory: '小吃', platform: 'youtube', title: '大阪美食影片', ai_ok: true, tags: { place_types: ['小吃', '餐廳'] },
    locations: [['日本', '大阪']],
    places: [{ name: '黑門市場', type: '小吃', country: '日本', city: '大阪' }, { name: '某餐廳', type: '餐廳', country: '日本', city: '大阪' },
      { name: '京都某店', type: '小吃', country: '日本', city: '京都' }] },
];

test('facets drill down 旅遊 › 國家 › 地區', () => {
  const f = facets(items, { category: '旅遊', sub: '日本' }, ['旅遊', '理財', '收件匣']);
  assert.deepEqual(f.categories.map((c) => c[0]), ['旅遊', '理財', '收件匣', '美食']);
  assert.deepEqual(f.subs, [['日本', 2]]);
  assert.deepEqual(f.areas.map((a) => a[0]).sort(), ['京都', '大阪']);
});

test('applyFilter combines category, area, place type, search and marks', () => {
  const state = { items: { c: { mark: '封存' } } };
  assert.deepEqual(applyFilter(items, { category: '旅遊', sub: '日本', area: '大阪' }, state).map((i) => i.id), ['a']);
  assert.deepEqual(applyFilter(items, { placeTypes: ['住宿'] }, state).map((i) => i.id), ['b']);
  assert.deepEqual(applyFilter(items, { q: '章魚燒' }, state).map((i) => i.id), ['a']);
  assert.deepEqual(applyFilter(items, {}, state).map((i) => i.id), ['a', 'b', 'd', 'e'], 'archived hidden by default');
  assert.deepEqual(applyFilter(items, { marks: ['封存'] }, state).map((i) => i.id), ['c']);
  assert.deepEqual(applyFilter(items, { unreadable: true }, state).map((i) => i.id), ['d']);
});

test('placesOf lists places in the chosen location, filtered by type', () => {
  const p = placesOf(items, { country: '日本', city: '大阪', types: ['小吃'] });
  assert.deepEqual(p.map((x) => x.name).sort(), ['わなか', '黑門市場']);
});

test('place lens gathers every category that mentions the city', () => {
  const f = { lens: 'place', country: '日本', city: '大阪' };
  assert.deepEqual(applyFilter(items, f, {}).map((i) => i.id), ['a', 'e']);
  const fc = facets(items, f, []);
  assert.deepEqual(fc.countries, [['日本', 3]]);
  assert.deepEqual(fc.cities.map((c) => c[0]).sort(), ['京都', '大阪']);
  assert.deepEqual(Object.fromEntries(fc.types), { 小吃: 2, 餐廳: 1 });
  assert.deepEqual(fc.categories.map((c) => c[0]).sort(), ['旅遊', '美食']);
  assert.deepEqual(applyFilter(items, { ...f, types: ['餐廳'] }, {}).map((i) => i.id), ['e']);
});

test('overrides from state win and move an item to another place', () => {
  const state = { items: { c: { override: { category: '旅遊', subcategory: '日本 › 東京', locations: [['日本', '東京']] } } } };
  const fixed = withOverrides(items, state);
  const c = fixed.find((i) => i.id === 'c');
  assert.equal(c.category, '旅遊');
  assert.deepEqual(locationsOf(c), [['日本', '東京']]);
  assert.deepEqual(applyFilter(fixed, { lens: 'place', country: '日本', city: '東京' }, state).map((i) => i.id), ['c']);
});

test('myMapsCsv quotes cells, guards formulas and starts with a BOM', () => {
  const csv = myMapsCsv([{ name: '=SUM(1)', type: '小吃', country: '日本', city: '大阪', district: '難波', from: 'a', fromTitle: '標題, 有逗號' }], 'https://x/');
  assert.ok(csv.startsWith('\ufeff名稱,地址'));
  assert.ok(csv.includes("'=SUM(1)"));
  assert.ok(csv.includes('"標題, 有逗號"'));
  assert.ok(csv.includes('https://x/read.html#a'));
});

test('rereadDue picks 有用/實踐過 untouched for 30 days', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const state = { items: { a: { mark: '有用', updated_at: '2026-10-01T00:00:00Z' }, b: { mark: '讀過', updated_at: '2026-10-01T00:00:00Z' } } };
  assert.deepEqual(rereadDue(items, state, now).map((i) => i.id), ['a']);
});

test('small formatters', () => {
  assert.equal(youtubeAt('https://www.youtube.com/watch?v=ki5PpBnbE1w', 205), 'https://www.youtube.com/watch?v=ki5PpBnbE1w&t=205s');
  assert.equal(youtubeAt('javascript:x', 1), null);
  assert.deepEqual(splitSub('日本 › 大阪'), ['日本', '大阪']);
  assert.equal(duration(5267), '1:27:47');
});
