# Read Box 元件寫法

先把 `tokens.css` 整段放進 `<style>`，再組下面的元件。所有顏色都用 CSS 變數，深色會自動跟著換。

## 頁面骨架
```html
<main class="page">
  <div class="top"><span class="mark"><i>R</i>Read Box</span><button class="chip"><span class="dot"></span>已連線</button></div>
  <p class="hello">這週收了 <em>12</em> 篇，<br>有 3 篇該重讀了</p>
  …
</main>
```
`.hello` 裡只有**一個**最重要的數字或關鍵字用 `<em>`（橘色）。

## 主要按鈕（綠，可以按的）
```html
<button class="btn go">收進來</button>
<button class="btn">取消</button>            <!-- 次要：白底黑框 -->
<button class="btn small">篩選</button>
```

## 分類膠囊列（第一層黑底選中、第二層粗框選中）
```html
<div class="row">
  <button aria-pressed="true">旅遊 <small>12</small></button>
  <button aria-pressed="false">美食 <small>5</small></button>
</div>
<div class="row sub">
  <button aria-pressed="true">日本</button><button aria-pressed="false">台灣</button>
</div>
```

## 標籤
```html
<span class="pill">未讀</span>          <!-- 橘：要你注意 -->
<span class="pill dark">讀過</span>     <!-- 黑：一般狀態 -->
<span class="pill soft">約 3 分鐘</span> <!-- 白底灰框：補充資訊 -->
```

## 卡片
```html
<div class="cards">
  <a class="card" href="#">
    <div class="src"><span><b>Threads</b> · @帳號</span><span>2026/10/30 收</span></div>
    <div class="tl">卡片標題用 900 粗體</div>
    <div class="ol">一句話重點，用次要灰</div>
    <div class="tags"><span class="pill">未讀</span><span>旅遊 › 日本</span><span>📍日本 › 大阪</span></div>
  </a>
  <a class="card" data-m="實踐過" href="#">…</a>   <!-- 左側綠條＋綠淡底 -->
</div>
```
`data-m` 可用：讀過、有用、實踐過、封存。

## 提醒框（橘框，一頁最多一個）
```html
<a class="alert" href="#"><span class="pill">該重讀了</span><div><b>焦慮時可以做的 5 個呼吸練習</b><span class="muted">收藏 3 週前</span></div></a>
```

## 區塊標題（一般直線，不要手繪線）
```html
<section class="blk"><h2 class="label">重點</h2><ul><li>第一點</li><li>第二點</li></ul></section>
```

## 地圖按鈕（綠框淡底）
```html
<a class="map" href="https://www.google.com/maps/search/?api=1&query=店名+城市" target="_blank" rel="noopener">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>地圖</a>
```

## 筆記紙（原文、摘錄）
```html
<div class="clip"><h2>原文</h2><blockquote>「摘錄的原文，一字不改。」</blockquote></div>
```

## 提示條
```html
<p class="notice">摘要依據：影片的說明文字，未看影片內容</p>
```

## 對話框
```html
<dialog><h2>標題</h2><label for="x">欄位</label><input class="field" id="x">
  <div class="row-btns"><button class="btn small">取消</button><button class="btn small go">儲存</button></div></dialog>
```
