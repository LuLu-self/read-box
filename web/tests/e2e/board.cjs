// End-to-end check of the board against a library folder, with GitHub's API mocked.
// Usage: LIB=<path to read-box-library clone> OUT=<screenshot dir> node web/tests/e2e/board.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const WEB = path.resolve(__dirname, '../..');
const LIB = process.env.LIB;
const OUT = process.env.OUT || '/tmp';
const puts = [];
let state = null;

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
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
  const index = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8'));

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

    const yt = index.items.find((i) => i.platform === 'youtube') || index.items[0];
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
  srv.close();
  if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
  console.log('\nall passed');
})();
