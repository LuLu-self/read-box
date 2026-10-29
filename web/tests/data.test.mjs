import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinks, safeUrl, makeId, facets, applyFilter, placesOf, rereadDue, youtubeAt, splitSub, duration } from '../lib/data.mjs';

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
    tags: { place_types: ['小吃'], topics: ['章魚燒'] }, places: [{ name: 'わなか', type: '小吃', country: '日本', area: '難波' }] },
  { id: 'b', category: '旅遊', subcategory: '日本 › 京都', platform: 'instagram', title: '京都住宿', ai_ok: true,
    tags: { place_types: ['住宿'] }, places: [{ name: '某旅館', type: '住宿', country: '日本', area: '京都' }] },
  { id: 'c', category: '理財', subcategory: '', platform: 'web', title: 'Google 財報', ai_ok: true, tags: {} },
  { id: 'd', category: '收件匣', subcategory: '', platform: 'medium', title: '讀不到', ai_ok: false, tags: {} },
];

test('facets drill down 旅遊 › 國家 › 地區', () => {
  const f = facets(items, { category: '旅遊', sub: '日本' }, ['旅遊', '理財', '收件匣']);
  assert.deepEqual(f.categories.map((c) => c[0]), ['旅遊', '理財', '收件匣']);
  assert.deepEqual(f.subs, [['日本', 2]]);
  assert.deepEqual(f.areas.map((a) => a[0]).sort(), ['京都', '大阪']);
});

test('applyFilter combines category, area, place type, search and marks', () => {
  const state = { items: { c: { mark: '封存' } } };
  assert.deepEqual(applyFilter(items, { category: '旅遊', sub: '日本', area: '大阪' }, state).map((i) => i.id), ['a']);
  assert.deepEqual(applyFilter(items, { placeTypes: ['住宿'] }, state).map((i) => i.id), ['b']);
  assert.deepEqual(applyFilter(items, { q: '章魚燒' }, state).map((i) => i.id), ['a']);
  assert.deepEqual(applyFilter(items, {}, state).map((i) => i.id), ['a', 'b', 'd'], 'archived hidden by default');
  assert.deepEqual(applyFilter(items, { marks: ['封存'] }, state).map((i) => i.id), ['c']);
  assert.deepEqual(applyFilter(items, { unreadable: true }, state).map((i) => i.id), ['d']);
});

test('placesOf lists places with their article, filtered by type', () => {
  const p = placesOf(items, ['小吃']);
  assert.equal(p.length, 1);
  assert.equal(p[0].from, 'a');
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
