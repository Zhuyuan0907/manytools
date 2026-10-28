# ZhuyuanTools・小小ㄉ工具箱

專門針對自己造出一個比較好用的輪子出來 owo，希望對你也有一點幫助。

本機工具箱：所有處理都在使用者自己的瀏覽器裡完成，檔案不會上傳到任何伺服器。

| 資料夾 | 網址 | 內容 |
|---|---|---|
| `home/` | `/` | 入口頁（工具清單、處理數量標語）。電腦上同類的工具躲在卡片後面（PDF 後面是 PDF 浮水印；圖片壓縮後面是照片參數查看和批次改檔名，兩條頁籤一上一下；Gravatar 後面是頭貼裁切），平常只露出一條寫著名字的頁籤（「06 PDF 浮水印」），滑鼠移上去才滑出來（照片的兩張一起往上排開）；手機上沒有 hover，八個工具照順序平鋪 |
| `videotools/` | `/video` | 影片碼率壓縮：放入影片 → 影片資訊 → 壓縮設定 → 處理與下載 |
| `pdftools/` | `/pdf` | PDF 壓縮・拆分（ZhuyuanLovePDF），網站用的是 `pdftools/local/`。有密碼的 PDF：每個檔案的密碼都輸入好按一次「解鎖」，輸入的密碼會拿去試所有鎖住的檔案（同一組密碼只要輸入一次，之後加進來的檔案也會先試），全形字當半形；只禁止列印、複製的檔案一樣會拿掉保護。輸出的檔案不會帶原本的密碼或保護（不會原封不動交回受保護的原檔）。放進來的檔案有密碼或保護時，第 2 步多一個「直接輸出」（不壓縮，只拿掉密碼）：問兩件事（好幾個檔案要各自輸出、檔名不變，還是合成一份；輸出的檔案不用密碼，還是設一個新密碼），列出會輸出哪些檔案，跳過壓縮設定直接到下載；各自輸出時整份檔案解密後存回去（表單、附件都在），本來就沒保護的檔案原封不動交回。第 3 步的上限也可以選「不壓縮」，只拿掉密碼、合併或拆分。第 4 步每個檔案的檔名旁邊有 ✎ 可以改名（合併時預設是固定的「備審資料_合併.pdf」），下載、ZIP、預覽都用新名字，回去改設定重新處理也會留著。也可以幫輸出的檔案「加上開啟密碼」（`assets/pdfcrypt.js` 的 `PdfCrypt.lock`：AES-256，PDF 標準的第 6 版，Acrobat X 以後都能開；這個密碼同時是擁有者密碼，不限制列印、複製）；密碼不存起來 |
| `watermarktools/` | `/watermark` | PDF 浮水印（ZhuyuanLoveMark）：文字（機密、草稿、僅供○○使用…）或圖片 Logo，大小、透明度、角度、顏色，單個放在九宮格的位置或平鋪滿版，蓋在內容上面或墊在下面，旁邊直接預覽實際頁面；可以只加在某幾頁、選「防止被移除」把頁面合成圖片，一次處理很多份、打包下載。PDF 函式庫和解密（`pdfcrypt.js`）借用 `/pdf` 的。首頁上它躲在 PDF 卡片後面，滑鼠移上去才滑出來（手機先點一下露出來的邊） |
| `avatartools/` | `/avatar` | Gravatar 頭貼查詢（ZhuyuanLoveAvatar）：Email 在瀏覽器裡轉成 SHA-256／MD5，查頭貼、公開資料，複製網址或打包下載 |
| `croptools/` | `/crop` | 頭貼裁切（ZhuyuanLoveCrop）：拖曳、縮放、旋轉對準臉（虛線圓是圓形頭貼看得到的範圍），輸出圓形去背（預設）或正方形，PNG／JPEG／WebP，一次可以處理很多張、打包下載。首頁上它躲在 Gravatar 卡片後面，滑鼠移上去才滑出來（手機先點一下露出來的邊） |
| `imagetools/` | `/image` | 圖片壓縮（ZhuyuanLoveImage）：壓到指定大小以內（找上限內畫質最高的設定），可換 JPEG／WebP／PNG、縮小尺寸、裁成正方形頭貼，打包下載 |
| `exiftools/` | `/exif` | 照片參數查看（ZhuyuanLoveExif）：不分步驟，照片丟進去就看到。一張：一個畫面放全部，焦距、光圈、快門、ISO、曝光補償五個大數字，下面按類別分成卡片（曝光、對焦、鏡頭與景深、色彩與風格、Lightroom 調色參數、後製、手機拍攝、機身、時間與地點、影像與檔案、作者），重複的只顯示一次，其餘原廠細部設定收在「其他技術資料」；照片點一下放大到 100%（像 Lightroom：約 0.26 秒的平滑放大，點的那一點一直留在游標下面，再點一下一樣平滑地縮回全圖；滑鼠滾輪一格也是平滑的，觸控板和兩指縮放直接跟手），拖曳移動、滾輪或兩指縮放，F 全螢幕，手機點一下全螢幕、兩下放大、左右滑換張。很多張或整個資料夾：一次一張，下面一排縮圖，← → 換張（下一張先讀好）。也可以貼 Flickr 連結（照片、相簿、相簿列表、藝廊、藝廊列表、相片串流、最愛、群組、收藏集、短網址、圖片網址都可以；在任何地方按貼上也行，`/exif?flickr=<連結>` 直接打開）：相簿類先出現格狀總覽（標題、作者、張數、拍攝日期、授權，可以用標題或攝影師名字篩選，捲到底自動載入下一批），點一張就和自己的照片一樣看參數，上面一排「誰的相簿 › 哪本相簿 › 第幾張」可以一路點回去；Flickr 卡片有標題、作者、所在相簿、授權（CC 會提示要標註）、上傳日期、觀看次數、地點、標籤、說明，「複製標註」複製一行「標題 by 作者，授權，短網址」，可下載的照片有原檔連結。參數是 Flickr 從原檔讀出來的（`flickr.photos.getExif`），照片和色階用 Flickr 上最接近螢幕大小的版本，放大到 100% 時換成最大的版本。查詢經過本站伺服器（`server/flickr.js`），因為 Flickr API 金鑰不能放進網頁；伺服器只轉問 Flickr、暫存答案一陣子、不記錄，照片本身由瀏覽器直接從 Flickr 載入。金鑰放在 `server/data/flickr.json`（`{ "key": "…" }`，不進 git，換了不用重開）或環境變數 `FLICKR_KEY`。沒有金鑰時用 Flickr 的 oEmbed（不需要金鑰）：只能看單張照片的照片（1024 px）、標題、作者和授權，沒有拍攝參數，也不能列出相簿、藝廊。讀檔：Chrome、Edge、Firefox 一張用 [ExifTool](https://exiftool.org) 13.42 的 WebAssembly 版（`exiftools/lib/`，第一次下載 7.5 MB），Safari（含所有 iPhone、iPad 上的瀏覽器）用 `assets/meta.js`（自己寫的 JavaScript 讀取器：EXIF、GPS、Apple 原廠資料、XMP、色彩描述檔，JPEG／HEIC／CR3／RAF／TIFF 類 RAW／.xmp）——Safari 跑 WebAssembly 的 Perl 慢 10～50 倍、要用 1 GB 以上記憶體，iPhone 會把頁面關掉。HEIC 照片：Safari 自己就看得懂；Chrome、Edge、Firefox 看不懂，改用 libheif（`lib/libheif-1.23.5.*`，WebAssembly，LGPL，第一次多下載約 0.6 MB）在 `assets/heic.js` 這個獨立的 worker 裡解碼，只有遇到 HEIC 才載入，閒置 20 秒就關掉放掉記憶體；同一張的螢幕大小和 100% 只解一次（iPhone 17 的 2,400 萬畫素約 3 秒）。縮圖上的 × 移除那張、「清空」回到開頭。iPhone 從「照片」選進來的照片會被 iOS 轉成 JPG 並拿掉位置（HEIC 原檔不會送進網頁），頁面會說明並教人從「檔案」App 選原檔。首頁上它躲在圖片壓縮卡片後面；首頁拖進 RAW 檔也會直接帶來這裡 |
| `renametools/` | `/rename` | 照片批次改檔名（ZhuyuanLoveRename）：整個資料夾一次改名，例如 `IMG_4678.CR3` → `竺原-4678.CR3`。新檔名用 `{號碼}`（原檔名裡的號碼，取最長的一串數字）、`{流水號}`（照拍攝時間或檔名排，可設起始和位數）、`{日期}`、`{時間}`、`{相機}`（從照片的 EXIF，用照片參數查看的 `meta.js` 只讀檔案開頭）、`{原檔名}` 組合；同一張的 RAW、JPG、.xmp 一起改成同一個名字；同一個資料夾裡撞名的自動加 -2、-3，已經是新名字的不動；每個檔案改名前後都列出來（幾千個也不卡，只畫看得到的那幾行）。電腦版 Chrome、Edge 直接在原資料夾改名（File System Access 的 `move()`，輪流換名或只改大小寫會先借一個暫時的名字，絕不蓋掉別的檔案），改完可以「復原」、下載對照表 CSV；其他瀏覽器和手機原檔不動，只有一個檔案改名時直接下載那個檔案，兩個以上打包成 ZIP 下載（`shared/zip.js` 的 `ManyZip.files`：檔案只讀一遍算檢查碼，ZIP 只指向原檔，4 GB 以上用 ZIP64）。首頁上它和照片參數查看一起躲在圖片壓縮卡片後面 |
| `fonts/` | `/fonts` | 共用字型：Noto Sans TC（思源黑體，SIL OFL），自己網站提供，不從 Google 載入；蘋果裝置會直接用蘋方 |
| `shared/` | `/shared` | 共用程式：`handoff.js` 把首頁拖進來的檔案交給工具頁（只在使用者的瀏覽器裡，IndexedDB／檔案控制代碼，不上傳）；`mobile-nav.js` 手機版的「上一步」；`tools-nav.js` 每個工具第一步標題下的「其他工具」連結（同一張首頁卡片上的排前面、加外框，手機不顯示）；`zip.js` 打包 ZIP |
| `server/` | — | 小伺服器：網址對應＋處理數量計數（只存數字）＋照片參數查看的 Flickr 查詢（`flickr.js`） |

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
- `POST /video/api/stats/processed`、`POST /pdf/api/stats/processed`、`POST /avatar/api/stats/processed`、`POST /image/api/stats/processed`、`POST /crop/api/stats/processed`、`POST /watermark/api/stats/processed`、`POST /exif/api/stats/processed`、`POST /rename/api/stats/processed`（改名的檔案數，不加進首頁的數字）
- 首頁的「頭貼」數量是查詢（avatar）加裁切（crop），「PDF」數量是壓縮（pdf）加浮水印（watermark），「圖片」數量是壓縮（image）加看參數（exif）

## Flickr 查詢

- `GET /exif/api/flickr/status` → `{ key: true | false }`
- `GET /exif/api/flickr/rest?method=flickr.photos.getInfo&photo_id=…` → Flickr API 的回答（伺服器加上金鑰；只允許照片參數查看用到的公開、唯讀方法）
- `GET /exif/api/flickr/oembed?url=<Flickr 連結>` → Flickr oEmbed（不需要金鑰）
- 答案暫存在記憶體（10 分鐘到一天，看是什麼），每個訪客 10 分鐘內最多 400 次新的查詢，全部加起來一小時 3,300 次（Flickr 一把金鑰一小時 3,600 次）

## 影片工具的技術重點

- 解析／封裝：[Mediabunny](https://mediabunny.dev/) 1.60.0（MPL-2.0），放在 `videotools/lib/`。
- 編解碼：瀏覽器內建 WebCodecs，有硬體加速就用硬體。需要 Chrome / Edge 94+，並且是 `https://`、`http://localhost` 或直接開檔（`file://`）；用 `http://` 加區網 IP 開啟時瀏覽器會擋掉編碼功能。
- 支援輸入：MP4、MOV、MTS / M2TS、MKV。MXF 目前不支援。
- Chrome / Edge 會讓使用者選一個輸出資料夾，直接串流寫到硬碟，幾 GB 的檔案也不會塞爆記憶體；其他瀏覽器則在記憶體裡組好再下載。
- 輸出影像為 8-bit 4:2:0；聲音預設原樣保留（LPCM / AAC 都不重壓）。
