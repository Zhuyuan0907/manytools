# 廣告設定（ads.json）

處理 PDF 的等待時間會顯示 `ads.json` 裡的廣告；有兩則以上時會自動輪播。改完存檔，重新整理網頁就生效，不用重新部署。

## 新增一則廣告
1. 在 `ads/` 底下開一個資料夾（例如 `ads/my-brand/`），放入：
   - `logo.png`：橫式 logo（建議 960×200 左右，透明背景）
   - `icon.png`：方形圖示（建議 256×256，手機版會用到）
2. 複製 `ads.json` 裡的 `example-template`，改成你的內容，並把 `active` 設成 `true`。

## 兩種版型
- **橫幅廣告**（有 `banner` 欄位）：直接顯示廣告主自己的橫幅圖。電腦版用 `banner.wide`（建議 1800×300，重要內容放左半邊，空間不夠時會從右邊裁掉），手機用 `banner.narrow`（建議 1200×400）。處理完成後縮成一條，只顯示 `logo`。
- **文字廣告**（沒有 `banner`）：用 `headline`、`tagline`、`points` 排版。

## 欄位
| 欄位 | 說明 |
|---|---|
| `id` | 英文小寫、數字、`-`、`_`、`.`，用來統計曝光與點擊，必須唯一 |
| `active` | `true` 才會顯示 |
| `weight` | 輪播權重，數字越大越常排在前面（預設 1） |
| `banner` | 選填。`wide` 寬版圖、`narrow` 手機版圖、`alt` 圖片說明文字 |
| `sponsor` | 廣告主名稱（顯示在「贊助」旁，也是 logo 的替代文字） |
| `logo` / `icon` | 圖片路徑（相對於網站根目錄；只能放本機檔案，外部網址會被安全設定擋下） |
| `headline` | 主標（建議 16 字內；手機上只顯示一行，太長會變成「…」） |
| `tagline` | 副標（建議 20 字內，同樣只顯示一行） |
| `points` | 重點條列（0～3 條，每條建議 10 字內） |
| `cta` | 按鈕文字 |
| `url` | 點擊後開啟的網址（新分頁） |
| `theme` | `bg` 內容區背景、`fg` 文字色、`accent` 與 `accent2` 右側色塊的漸層色（`accent` 也是重點色） |
| `partner` | 選填。`text`（例如「由 AtomRoute Global Network (US) LLC 提供」）顯示在廣告下方；文字廣告也可以放 `logo` |
| `start` / `end` | 上架與下架日期（`YYYY-MM-DD`，留空代表不限） |

`rotateSeconds`：每則廣告停留的秒數（最少 4 秒）。

曝光與點擊次數記錄在伺服器的 `/var/lib/bspdf-web/stats.json` 的 `ads` 欄位。
離線版（直接開 index.html）讀不到 ads.json，會顯示程式內建的預設廣告。
