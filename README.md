# ZhuyuanTools・小小ㄉ工具箱

專門針對自己造出一個比較好用的輪子出來 owo，希望對你也有一點幫助。

本機工具箱：所有處理都在使用者自己的瀏覽器裡完成，檔案不會上傳到任何伺服器。

| 資料夾 | 網址 | 內容 |
|---|---|---|
| `home/` | `/` | 入口頁（工具清單、處理數量標語） |
| `videotools/` | `/video` | 影片碼率壓縮：放入影片 → 影片資訊 → 壓縮設定 → 處理與下載 |
| `pdftools/` | `/pdf` | PDF 壓縮・拆分（ZhuyuanLovePDF），網站用的是 `pdftools/local/` |
| `watermarktools/` | `/watermark` | PDF 浮水印（ZhuyuanLoveMark）：文字（機密、草稿、僅供○○使用…）或圖片 Logo，大小、透明度、角度、顏色，單個放在九宮格的位置或平鋪滿版，蓋在內容上面或墊在下面，旁邊直接預覽實際頁面；可以只加在某幾頁、選「防止被移除」把頁面合成圖片，一次處理很多份、打包下載。PDF 函式庫和解密（`pdfcrypt.js`）借用 `/pdf` 的。首頁上它躲在 PDF 卡片後面，滑鼠移上去才滑出來（手機先點一下露出來的邊） |
| `avatartools/` | `/avatar` | Gravatar 頭貼查詢（ZhuyuanLoveAvatar）：Email 在瀏覽器裡轉成 SHA-256／MD5，查頭貼、公開資料，複製網址或打包下載 |
| `croptools/` | `/crop` | 頭貼裁切（ZhuyuanLoveCrop）：拖曳、縮放、旋轉對準臉（虛線圓是圓形頭貼看得到的範圍），輸出正方形或圓形去背，PNG／JPEG／WebP，一次可以處理很多張、打包下載。首頁上它躲在 Gravatar 卡片後面，滑鼠移上去才滑出來（手機先點一下露出來的邊） |
| `imagetools/` | `/image` | 圖片壓縮（ZhuyuanLoveImage）：壓到指定大小以內（找上限內畫質最高的設定），可換 JPEG／WebP／PNG、縮小尺寸、裁成正方形頭貼，打包下載 |
| `exiftools/` | `/exif` | 照片參數查看（ZhuyuanLoveExif）：不分步驟，照片丟進去就看到焦距、光圈、快門、ISO、鏡頭、快門次數、景深、拍攝位置，「全部」列出每一項（可搜尋、存成 CSV）；RAW 檔（CR3、NEF、ARW、RAF、DNG…）顯示相機放在裡面的預覽圖和色階分佈。用的是 [ExifTool](https://exiftool.org) 13.42 的 WebAssembly 版（`exiftools/lib/`，第一次使用下載 7.5 MB，之後瀏覽器會記住）。首頁上它躲在圖片壓縮卡片後面；首頁拖進 RAW 檔也會直接帶來這裡 |
| `fonts/` | `/fonts` | 共用字型：Noto Sans TC（思源黑體，SIL OFL），自己網站提供，不從 Google 載入；蘋果裝置會直接用蘋方 |
| `shared/` | `/shared` | 共用程式：`handoff.js` 把首頁拖進來的檔案交給工具頁（只在使用者的瀏覽器裡，IndexedDB／檔案控制代碼，不上傳） |
| `server/` | — | 小伺服器：網址對應＋處理數量計數（只存數字） |

## 執行

```bash
node server/server.js            # http://127.0.0.1:8080/
PORT=8090 HOST=0.0.0.0 node server/server.js
```

不需要安裝任何套件。正式機用 systemd 的 `manytools.service`（port 8090），再由 Cloudflare Tunnel 接到 https://tools.zhuyuan.tw/ 。
舊網址（`/home/index.html`、`/videotools/`、`/pdftools/local/`）和資料夾名稱（`/watermarktools/`、`/exiftools/` 等）會自動轉到新網址。
各工具的 `index.html` 也可以直接雙擊開啟（這時首頁不會顯示處理數量）。

## 計數

只記錄數量，不記錄檔名或內容，存在 `server/data/stats.json`（可用 `STATS_FILE` 改位置）。

- `GET /api/stats` → `{ video: { files, seconds, savedBytes }, pdf: { files, pages, savedBytes } }`
- `POST /video/api/stats/processed`、`POST /pdf/api/stats/processed`、`POST /avatar/api/stats/processed`、`POST /image/api/stats/processed`、`POST /crop/api/stats/processed`、`POST /watermark/api/stats/processed`、`POST /exif/api/stats/processed`
- 首頁的「頭貼」數量是查詢（avatar）加裁切（crop），「PDF」數量是壓縮（pdf）加浮水印（watermark），「圖片」數量是壓縮（image）加看參數（exif）

## 影片工具的技術重點

- 解析／封裝：[Mediabunny](https://mediabunny.dev/) 1.60.0（MPL-2.0），放在 `videotools/lib/`。
- 編解碼：瀏覽器內建 WebCodecs，有硬體加速就用硬體。需要 Chrome / Edge 94+，並且是 `https://`、`http://localhost` 或直接開檔（`file://`）；用 `http://` 加區網 IP 開啟時瀏覽器會擋掉編碼功能。
- 支援輸入：MP4、MOV、MTS / M2TS、MKV。MXF 目前不支援。
- Chrome / Edge 會讓使用者選一個輸出資料夾，直接串流寫到硬碟，幾 GB 的檔案也不會塞爆記憶體；其他瀏覽器則在記憶體裡組好再下載。
- 輸出影像為 8-bit 4:2:0；聲音預設原樣保留（LPCM / AAC 都不重壓）。
