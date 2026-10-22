# ManyTools

本機工具箱：所有處理都在使用者自己的瀏覽器裡完成，檔案不會上傳到任何伺服器。

| 資料夾 | 內容 |
|---|---|
| `home/` | 入口頁（工具清單、處理數量標語） |
| `videotools/` | 影片碼率壓縮：讀取碼率／解析度／幀率／聲音軌，壓到指定碼率（H.264 / H.265，VBR / CBR） |
| `pdftools/` | PDF 壓縮・拆分（ZhuyuanLovePDF），離線版在 `pdftools/local/` |
| `server/` | 選用的小伺服器：放網站檔案＋處理數量計數（只存數字） |

根目錄的 `index.html` 會導到 `home/`。

## 本機執行

```bash
node server/server.js            # http://127.0.0.1:8080/
PORT=80 HOST=0.0.0.0 node server/server.js
```

不需要安裝任何套件。也可以直接雙擊各工具的 `index.html` 使用（這時首頁不會顯示處理數量）。

## 計數

只記錄數量，不記錄檔名或內容，存在 `server/data/stats.json`（可用 `STATS_FILE` 改位置）。

- `GET /api/stats` → `{ video: { files, seconds, savedBytes }, pdf: { files, pages, savedBytes } }`
- `POST /videotools/api/stats/processed`、`POST /pdftools/local/api/stats/processed`

## 影片工具的技術重點

- 解析／封裝：[Mediabunny](https://mediabunny.dev/) 1.60.0（MPL-2.0），放在 `videotools/lib/`。
- 編解碼：瀏覽器內建 WebCodecs，有硬體加速就用硬體。需要 Chrome / Edge 94+，並且是 `https://`、`http://localhost` 或直接開檔（`file://`）。
- 支援輸入：MP4、MOV、MTS / M2TS、MKV。MXF 目前不支援。
- Chrome / Edge 會讓使用者選一個輸出資料夾，直接串流寫到硬碟，幾 GB 的檔案也不會塞爆記憶體；其他瀏覽器則在記憶體裡組好再下載。
- 輸出影像為 8-bit 4:2:0；聲音預設原樣保留（LPCM / AAC 都不重壓）。
