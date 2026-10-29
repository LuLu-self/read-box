// End-to-end check of the board against a library folder, with GitHub's API mocked.
// Usage: LIB=<path to read-box-library clone> OUT=<screenshot dir> [BASE=<deployed URL>] node web/tests/e2e/board.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const WEB = path.resolve(__dirname, '../..');
const LIB = process.env.LIB;
const OUT = process.env.OUT || '/tmp';
const puts = [];
const deletes = [];
let state = null;

// Synthetic items with places, so the place lens and export are exercised even on a library
// that has no travel posts yet. They exist only inside this test.
const SYN = [
  { id: 'syn-osaka-1', title: '測試：大阪小吃清單', one_line: '測試資料', category: '旅遊', subcategory: '日本 › 大阪', platform: 'threads',
    kind: 'social', captured_at: '2026-10-29T10:00:00+08:00', ai_ok: true, fetch_status: 'full', basis: '貼文文字',
    tags: { place_types: ['小吃'] }, locations: [['日本', '大阪']],
    places: [{ name: '測試章魚燒', type: '小吃', country: '日本', city: '大阪', district: '難波', map_url: 'https://www.google.com/maps/search/?api=1&query=x' }] },
  { id: 'syn-osaka-2', title: '測試：大阪美食影片', one_line: '測試資料', category: '美食', subcategory: '餐廳店家', platform: 'youtube',
    kind: 'video', captured_at: '2026-10-29T09:00:00+08:00', ai_ok: true, fetch_status: 'full', basis: '說明文字',
    tags: { place_types: ['餐廳', '小吃'] }, locations: [['日本', '大阪'], ['日本', '京都']],
    places: [{ name: '測試燒肉', type: '餐廳', country: '日本', city: '大阪', district: '', map_url: 'https://www.google.com/maps/search/?api=1&query=y' },
      { name: '測試京都抹茶', type: '咖啡甜點', country: '日本', city: '京都', district: '', map_url: 'https://www.google.com/maps/search/?api=1&query=z' }] },
];
const FAILED = { v: 1, url: 'https://www.instagram.com/p/TEST/', captured_at: '2026-10-29T11:00:00+08:00', error: '讀不到內容，也沒有任何標題資訊，所以沒有收進來（測試）' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
      if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
      fs.createReadStream(file).pipe(res);
    }).listen(0, () => resolve(srv));
  });
}

async function mockGitHub(page) {
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const m = /^\/repos\/LuLu-self\/read-box-library(?:\/contents\/(.+))?$/.exec(url.pathname);
    if (!m) return route.fulfill({ status: 404, body: '{}' });
    if (!m[1]) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"private":true}' });
    const rel = decodeURIComponent(m[1]);
    if (req.method() === 'DELETE') { deletes.push(rel); return route.fulfill({ status: 200, body: '{}' }); }
    if (rel === 'inbox/failed') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(deletes.length ? [] : [{ type: 'file', name: 'x.json', path: 'inbox/failed/x.json', sha: 's' }]) });
    }
    if (rel === 'inbox/failed/x.json') return route.fulfill({ status: 200, body: JSON.stringify(FAILED) });
    if (rel === 'index.json') {
      const idx = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8'));
      idx.items = [...SYN, ...idx.items];
      return route.fulfill({ status: 200, body: JSON.stringify(idx) });
    }
    const syn = SYN.find((x) => rel === `library/${x.id}.json`);
    if (syn) return route.fulfill({ status: 200, body: JSON.stringify({ ...syn, url: 'https://www.threads.com/@t/post/X', captures: [], fetch: { status: 'full', basis: syn.basis, text_chars: 0 }, ai: { one_line: '測試資料' }, images: [] }) });
    if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData());
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      puts.push({ rel, text });
      if (rel === 'state.json') state = text;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ content: { sha: 'new' } }) });
    }
    if (rel === 'state.json') {
      if (!state) return route.fulfill({ status: 404, body: '{}' });
      const raw = (req.headers()['accept'] || '').includes('raw');
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: raw ? state : JSON.stringify({ sha: 'old', content: Buffer.from(state).toString('base64') }) });
    }
    const file = path.join(LIB, rel);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({ status: 200, body: fs.readFileSync(file) });
  });
}

(async () => {
  // BASE=<deployed URL> checks the live Pages site instead of a local server.
  const srv = process.env.BASE ? null : await serve();
  const base = process.env.BASE ? process.env.BASE.replace(/\/$/, '') : `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
  const index = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8'));
  index.items = [...SYN, ...index.items];

  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockGitHub(page);
    await page.goto(base + '/index.html');
    await page.evaluate(() => localStorage.setItem('readbox.cfg', JSON.stringify({ repo: 'LuLu-self/read-box-library', token: 't' })));
    await page.reload();
    await page.waitForSelector('.card');
    const n = await page.locator('#list .card').count();
    check(n === index.items.length, `${scheme}: list shows ${n}/${index.items.length} cards`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${scheme}: no horizontal scroll`);
    await page.screenshot({ path: `${OUT}/home-${scheme}.png`, fullPage: true });

    if (scheme === 'light') {
      const cat = index.items.find((i) => i.category === '理財') ? '理財' : index.items[0].category;
      const want = index.items.filter((i) => i.category === cat).length;
      await page.locator('#cats button', { hasText: cat }).click();
      check(await page.locator('#list .card').count() === want, `filter ${cat} shows ${want}`);
      await page.locator('#cats button', { hasText: '全部' }).click();
      await page.fill('#q', '財報');
      check(await page.locator('#list .card').count() >= 1, 'search 財報 finds something');
      await page.fill('#q', '');

      // Autofill guard: a value typed into the search box by the browser is cleared on load.
      check(await page.inputValue('#q') === '', 'search box starts empty');
      check(await page.locator('.card .brand svg').count() > 0, 'brand logos on cards');
      check((await page.textContent('#failed')).includes('沒收進來'), 'skipped capture is reported');
      await page.locator('#failed button', { hasText: '知道了' }).click();
      await page.waitForFunction(() => !document.querySelector('#failed').textContent.includes('沒收進來'));
      check(deletes.includes('inbox/failed/x.json'), 'dismiss deletes the failed capture');

      // Place lens: 日本 › 大阪 gathers 旅遊 and 美食, then filter by type and export.
      await page.click('#l-place');
      await page.locator('#countries button', { hasText: '日本' }).click();
      await page.locator('#cities button', { hasText: '大阪' }).click();
      check(await page.locator('#list .card').count() === 2, 'place lens 日本 › 大阪 shows both categories');
      await page.locator('#types button', { hasText: '餐廳' }).click();
      check(await page.locator('#list .card').count() === 1, 'type 餐廳 narrows to one');
      await page.click('#v-places');
      check(await page.locator('#list .place').count() === 1, 'shop list shows only 大阪 餐廳');
      await page.click('#export-btn');
      const href = await page.getAttribute('#mm-download', 'href');
      const csv = await page.evaluate(async (u) => (await fetch(u)).text(), href);
      check(csv.includes('測試燒肉') && !csv.includes('測試京都抹茶'), 'export CSV has only the filtered place');
      await page.click('#mm-cancel');
      await page.click('#v-cards');
      await page.click('#l-cat');

      await page.fill('#links', '看這兩篇 https://example.com/a?utm_source=x 還有 https://example.com/b 。');
      await page.fill('#why', '測試');
      await page.click('#cap-btn');
      await page.waitForFunction(() => document.querySelectorAll('#sent li').length === 2);
      const caps = puts.filter((p) => p.rel.startsWith('inbox/'));
      check(caps.length === 2, `capture wrote ${caps.length} inbox files`);
      const c0 = JSON.parse(caps[0].text);
      check(c0.v === 1 && c0.url === 'https://example.com/a?utm_source=x' && c0.why === '測試', 'capture JSON shape');
      await page.fill('#links', '只是一段筆記');
      await page.click('#cap-btn');
      await page.waitForFunction(() => document.querySelectorAll('#sent li').length === 3);
      const note = JSON.parse(puts.filter((p) => p.rel.startsWith('inbox/')).at(-1).text);
      check(note.url === '' && note.text === '只是一段筆記', 'text without link is saved as a note');
    }

    const yt = index.items.find((i) => i.platform === 'youtube' && !i.id.startsWith('syn-')) || index.items[0];
    await page.goto(`${base}/read.html#${yt.id}`);
    await page.waitForSelector('h1');
    check((await page.textContent('h1')) === yt.title, `${scheme}: detail title`);
    if (yt.platform === 'youtube') check(await page.locator('.chap a').count() > 0, `${scheme}: youtube chapters link`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${scheme}: detail no horizontal scroll`);
    await page.screenshot({ path: `${OUT}/detail-${scheme}.png`, fullPage: true });
    if (scheme === 'light') {
      await page.locator('.marks button', { hasText: '有用' }).click();
      await page.waitForFunction(() => document.getElementById('save-state').textContent === '已儲存');
      check(JSON.parse(state).items[yt.id].mark === '有用', 'mark saved to state.json');
      await page.locator('button', { hasText: '改分類／改地點' }).click();
      await page.selectOption('#fx-cat', '旅遊');
      await page.fill('#fx-country', '日本');
      await page.fill('#fx-city', '東京');
      await page.locator('dialog button', { hasText: '儲存' }).click();
      await page.waitForFunction(() => document.body.textContent.includes('分類／地點是你改過的'));
      const ov = JSON.parse(state).items[yt.id].override;
      check(ov.category === '旅遊' && ov.locations[0][1] === '東京' && ov.subcategory === '日本 › 東京', 'override saved');
      await page.locator('button', { hasText: '重新整理這篇' }).click();
      await page.waitForFunction(() => document.body.textContent.includes('已送出'));
      const redo = JSON.parse(puts.filter((p) => p.rel.startsWith('inbox/')).at(-1).text);
      check(redo.redo_of === yt.id, 'redo capture written');
      await page.goto(base + '/index.html');
      await page.click('#l-place');
      await page.locator('#countries button', { hasText: '日本' }).click();
      await page.locator('#cities button', { hasText: '東京' }).click();
      check(await page.locator('#list .card').count() === 1, 'overridden item appears under 東京');
      await page.click('#l-cat');
      const unread = index.items.find((i) => !i.ai_ok);
      if (unread) {
        await page.goto(`${base}/read.html#${unread.id}`);
        await page.waitForFunction((t) => document.querySelector('h1')?.textContent === t, unread.title);
        check((await page.textContent('#art')).includes('讀不到內容'), 'unreadable item explains itself');
      }
    }
    check(errors.length === 0, `${scheme}: no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }
  await browser.close();
  if (srv) srv.close();
  if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
  console.log('\nall passed');
})();
