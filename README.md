# Read Box

我的個人文章收藏網站。在 Threads、Instagram、Facebook、YouTube 或任何網站看到「以後會用到」的內容，分享連結進來，GitHub Actions 就用我的 Claude 訂閱整理：

- **標題、一句話重點、3–5 點重點、原文摘錄**（摘錄會比對原文，對不上就不放）
- **主分類＋次分類**（旅遊會分到「國家 › 地區」）與標籤（地點類型、季節、預算、情境、主題）
- **地點清單**：文章提到的店家、景點，各附 Google 地圖連結（AI 推測的會標明）
- **來源標註**：平台、作者／帳號、原始連結、發布日期、收藏日期
- **讀取狀態誠實標示**：全文／貼文文字／影片說明文字／付費試閱段／只有標題，抓不到就只存卡片和網址

## 架構

```
iPhone 分享捷徑／看板貼上／對 Claude 說「幫我收這篇」
        │  寫入 inbox/<id>.json
        ▼
私人收藏庫 read-box-library ──► Actions（呼叫本 repo 的 analyze.yml，釘在固定 commit）
        │                          ├─ fetch：只讀分享的那一頁，不登入、不繞過登入牆
        │                          ├─ Claude（Sonnet，沒有 shell、沒有網路，只能寫摘要檔）
        │                          └─ publish：不跑 AI，重新檢查後才寫入
        ▼
library/<id>.json|txt、media/<id>/、index.json
        │
        └─► 看板（本 repo 的 GitHub Pages，用我的 token 從私人 repo 讀）
```

這個 repo 只放程式碼，是公開的（GitHub Pages 免費方案需要公開）；收藏內容都在私人的 `read-box-library`。

## 開發

```
pip install trafilatura==2.0.0 pypdf==5.4.0 pillow==11.3.0
python3 -m unittest discover -s action/tests
```

改了 `action/` 或 `analyze.yml` 之後，要把收藏庫 workflow 裡釘的 commit SHA 換成新的才會生效。

架構與做法參考 [GitHub Box](https://github.com/LuLu-self/github-box)。
