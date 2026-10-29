# Read Box

## Project goal

LuLu 的個人文章收藏網站：把在 Threads、IG、FB、YouTube、一般網站看到、以後會用到的內容收進自己的私人 repo，GitHub Actions 用自己的 Claude 訂閱寫標題、摘要、分類與地點。個人自用；架構沿用 GitHub Box（`LuLu-self/github-box`），但兩邊互不修改。

## Stack

- Python 3（pipeline，標準函式庫＋trafilatura、pypdf、Pillow，全部釘版本）
- 原生 HTML／CSS／ES modules（看板，無 build、無第三方 JS）
- GitHub Actions reusable workflow + GitHub Pages
- 資料：私人 repo `read-box-library`（`library/<id>.json|txt`、`media/<id>/`、`index.json`、`taxonomy.json`）
- Test：`python3 -m unittest discover -s action/tests && node --test 'web/tests/*.test.mjs'`；看板 e2e：`LIB=<read-box-library 路徑> node web/tests/e2e/board.cjs`（GitHub API 用 mock）

## File layout

- `action/scripts/` — `items.py`（列 inbox）、`fetch.py`（各平台讀取，不用 AI）、`prompt.py`、`validate.py`、`publish.py`（唯一寫入）、`taxonomy.py`、`common.py`
- `action/prompts/analyze.md` — 給 Claude 的提示詞
- `.github/workflows/analyze.yml` — reusable workflow：plan → process（fetch＋Claude）→ publish
- `web/` — 看板（GitHub Pages）：`index.html`＋`app.js`（列表、篩選、地點、收藏框、設定）、`read.html`＋`read.js`（單篇、標記、筆記）、`lib/data.mjs`（純函式）、`lib/gh.mjs`（GitHub API）

## Constraints

- 收藏庫呼叫 `analyze.yml` 一律釘 40 字元 SHA，不用 `@main`；改 pipeline 後要到收藏庫換 SHA 才生效。
- Claude 步驟不給 Bash、網路、MCP；只能讀 `$IN`、寫 `$OUT/summary.json`。網頁內容一律視為不可信資料。
- 不登入、不繞過登入牆或機器人驗證、不批次爬取；只抓 LuLu 分享的那一頁。IG／FB／YouTube 照各平台條款；YouTube 只用官方 API 與 oEmbed，不下載影片。
- 不存影片檔；圖片縮到長邊 1600px。
- 測試資料一律自製，不把別人的貼文放進這個公開 repo。
- 看板存 token 的頁面不載入任何第三方 JS；localStorage key 用 `readbox.*`，不可和 GitHub Box 的 `repobox.*` 共用。

## Conventions

- Conventional commits（`type(scope): 摘要`）；README 用繁體中文。
- GitHub Actions：最上層 `permissions: contents: read`，需要時才在 job 提高；`uses:` 釘 40 字元 SHA 並註明版本。
