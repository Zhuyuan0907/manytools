/* ZhuyuanLoveExif — what the camera wrote into a photo, read in this browser. No steps: drop photos and look.
   ExifTool (the real one, as WebAssembly, in assets/worker.js) reads every tag; in Safari meta.js. A photo: the
   cards on one screen (exposure, focus, lens, colour, Lightroom edits, body, time and place, file), each thing said
   once however many times the file repeats it, the picture with its histogram and a Lightroom-like zoom; more
   photos: one at a time, a strip of them under the picture.
   Or a Flickr link (assets/flickr.js asks Flickr's API from this browser, never through the server): a photo opens
   like a file, its EXIF as Flickr read it from the original; an album, a gallery, a photostream… opens as a grid
   first; someone's albums or galleries as covers.
   On a server only the number of photos read is reported. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const fill = (node, ...kids) => node.replaceChildren(...kids.filter((x) => x != null && x !== false));
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    n.append(...kids.filter((x) => x != null && x !== false));
    return n;
  };
  const onServer = /^https?:$/.test(location.protocol);
  if (onServer) $('#brand').href = '/';
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const trim0 = (x, d = 1) => String(+(+x).toFixed(d)); // 4.0 → "4", 2.8 → "2.8"

  const RAW = /\.(cr3|cr2|crw|nef|nrw|arw|srf|sr2|raf|orf|ori|rw2|rwl|dng|pef|ptx|srw|3fr|fff|iiq|erf|kdc|dcr|mef|mos|mrw|x3f|gpr|raw)$/i;
  const OTHER = /\.(jpe?g|jpe|png|webp|avif|gif|bmp|heic|heif|hif|tiff?|jxl)$/i;
  const SIDECAR = /\.xmp$/i;
  const isPhoto = (f) => RAW.test(f.name) || OTHER.test(f.name) || /^image\//.test(f.type);
  // what an <img> can show by itself (HEIC and TIFF only in Safari: tried, and the embedded JPEG looked for too)
  const SHOWABLE = /\.(jpe?g|jpe|png|webp|avif|gif|bmp)$/i;
  const extOf = (name) => (name.match(/\.([^.]+)$/) || [, ''])[1].toUpperCase();
  // what a photo is called on screen: its file name, or a Flickr photo's title
  const nameOf = (it) => (it.fk ? it.fk.title || `Flickr ${it.fk.id}` : it.file.name);
  // A phone's browser closes a page that uses too much memory (Safari: "A problem repeatedly occurred"), so there
  // pictures are decoded no bigger than the screen, at most one at full size, and Perl is renewed sooner.
  const SMALL_DEVICE = /iP(hone|ad|od)|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const TOUCH = matchMedia('(pointer: coarse)').matches;
  const FULL_MAX = SMALL_DEVICE ? 4096 : 12000; // long side of the picture a zoom to 100 % decodes
  const DPR = () => Math.min(SMALL_DEVICE ? 3 : 2, window.devicePixelRatio || 1);
  const SCREEN = Math.min(FULL_MAX, Math.ceil(Math.max(screen.width, screen.height) * DPR()));
  // Safari's engine (every browser on iPhone and iPad uses it) runs ExifTool's WebAssembly 10–50 times slower and
  // needs over a gigabyte for it, and an iPhone closes the page. There, meta.js (plain JavaScript) reads every file.
  const ENGINE = new URLSearchParams(location.search).get('engine');
  const WEBKIT = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    || (/AppleWebKit/.test(navigator.userAgent) && !/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)\//.test(navigator.userAgent));
  const JS_ONLY = ENGINE === 'js' || (WEBKIT && ENGINE !== 'exiftool');
  // an iPhone or iPad: a photo picked from 照片 arrives as a JPEG iOS makes from it, without its location (renderSheet)
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // ---------- the engine ----------
  const engine = { state: 'loading', loaded: 0, total: 0 };
  let worker = null, seq = 0;
  const waiting = new Map();
  function startWorker() {
    if (JS_ONLY) { engine.state = 'ready'; showEngine(); return; }
    try {
      worker = new Worker('assets/worker.js');
    } catch { engine.state = 'error'; showEngine(); return; }
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') { engine.loaded = d.loaded; engine.total = d.total; showEngine(); return; }
      if (d.type === 'warm') { engine.state = 'ready'; showEngine(); return; }
      if (d.type === 'ready') return;
      const done = waiting.get(d.id);
      if (done) { waiting.delete(d.id); done(d); }
    };
    worker.onerror = () => {
      engine.state = 'error'; showEngine();
      for (const [, done] of waiting) done({ ok: false, error: 'worker' });
      waiting.clear();
    };
    worker.postMessage({ warm: true, mobile: SMALL_DEVICE });
  }
  const ask = (msg) => new Promise((resolve) => {
    if (!worker) { resolve({ ok: false, error: 'worker' }); return; }
    const id = ++seq;
    waiting.set(id, resolve);
    worker.postMessage({ id, ...msg });
  });
  function showEngine() {
    const n = $('#engine');
    if (engine.state === 'ready') fill(n, el('span', { class: 'ok-dot', 'aria-hidden': 'true' }), '準備好了，照片放進來馬上就看得到');
    else if (engine.state === 'error') fill(n, el('span', { class: 'bad', text: '解析程式沒有載入成功，請重新整理頁面再試一次' }));
    else if (engine.total && engine.loaded < engine.total) fill(n, el('span', { class: 'spinner' }), ` 第一次使用，正在下載解析程式… ${(engine.loaded / 1e6).toFixed(1)} / ${(engine.total / 1e6).toFixed(1)} MB`);
    else fill(n, el('span', { class: 'spinner' }), ' 正在準備解析程式…');
    n.classList.toggle('is-ready', engine.state === 'ready');
    if (cur() && !cur().done) renderInfo();
  }

  // ---------- photos ----------
  // item: { id, file, side (its Lightroom .xmp), raw, kind (image / raw / xmp / flickr), done, ok, error, tags
  //         (ExifTool's), idx (tag name → entries), pv (embedded JPEG), hist, thumb (URL), sheet (the cards),
  //         fk (a Flickr photo: what Flickr said), coll (the Flickr list it came from) }
  // The photo on screen is read whole; the one after it next.
  const items = [];
  let current = -1, nextId = 1, view = 'one';
  const cur = () => items[current];

  // where a file sits, so a RAW file and its .xmp pair up (a folder from the picker or from drag and drop)
  const pathOf = (f) => (f.relPath || f.webkitRelativePath || '').replace(/[^/]*$/, '').toLowerCase();
  const stem = (f) => `${pathOf(f)}${f.name.replace(/\.[^.]+$/, '').toLowerCase()}`;
  function add(files, folder = false) {
    const list = [...files].filter((f) => !/^\._|^\.DS_Store$|^Thumbs\.db$|^desktop\.ini$/i.test(f.name));
    // an album's photos give way to your own (the album stays a click away, up top)
    if (list.length && items.length && items[0].coll) clearItems();
    const known = new Set(items.filter((it) => !it.fk).map((it) => `${pathOf(it.file)}${it.file.name}|${it.file.size}|${it.file.lastModified}`));
    const fresh = [], seen = new Set();
    // Lightroom keeps a RAW file's edit in a .xmp beside it (same name); an .xmp alone still tells how it was edited
    const sides = new Map(list.filter((f) => SIDECAR.test(f.name)).map((f) => [stem(f), f]));
    const photos = list.filter(isPhoto);
    for (const file of photos) {
      const key = `${pathOf(file)}${file.name}|${file.size}|${file.lastModified}`;
      if (known.has(key) || seen.has(key)) continue;
      seen.add(key);
      const raw = RAW.test(file.name);
      const side = raw && !/\.dng$/i.test(file.name) ? sides.get(stem(file)) || null : null;
      if (side) sides.delete(stem(file));
      fresh.push({ id: nextId++, file, side, raw, kind: raw ? 'raw' : 'image', done: false });
    }
    for (const file of sides.values()) fresh.push({ id: nextId++, file, side: null, raw: false, kind: 'xmp', done: false });
    const skipped = list.length - photos.length - list.filter((f) => SIDECAR.test(f.name)).length;
    if (skipped > 0) toast(skipped > 3 || folder ? `有 ${skipped} 個不是照片的檔案，略過了` : `「${list.filter((f) => !isPhoto(f) && !SIDECAR.test(f.name)).map((f) => f.name).join('」「')}」不是照片，略過了`);
    if (!fresh.length) return;
    // in the files' own order (IMG_0001, IMG_0002…), as a shoot happened
    fresh.sort((a, b) => a.file.name.localeCompare(b.file.name, 'en', { numeric: true }));
    const first = items.length;
    items.push(...fresh);
    current = first;
    loupeReset();
    setView('one');
    pumpThumbs();
    if (folder && fresh.length > 1) toast(`${fresh.length} 張照片：用下面的縮圖或鍵盤的 ← → 一張一張看`);
  }
  // a photo out of the set (the × on its thumbnail); the last one gone: back to the start
  function removeItem(it) {
    const i = items.indexOf(it);
    if (i < 0) return;
    items.splice(i, 1);
    const j = fullQ.indexOf(it);
    if (j >= 0) fullQ.splice(j, 1);
    if (views.has(it.id)) { release(views.get(it.id).img); views.delete(it.id); }
    setThumb(it, null);
    if (!items.length) { if (coll || shelf) { current = -1; setView('browse'); } else reset(); return; }
    if (i < current) current--;
    else if (current >= items.length) current = items.length - 1;
    loupeReset();
    setView('one');
  }
  // the photos out (an album's, when your own come in; all of them for 清空)
  function clearItems() {
    loupeReset();
    closeFull();
    for (const it of items) { setThumb(it, null); if (views.has(it.id)) { release(views.get(it.id).img); views.delete(it.id); } }
    items.length = 0; fullQ.length = 0;
    current = -1;
    $('#search').value = '';
    renderThumbs();
  }
  // everything out, Flickr's lists too: the start again
  function reset() {
    clearItems();
    moreOpen = false;
    shelf = null; coll = null;
    $('#viewer').hidden = true;
    $('#browse').hidden = true;
    $('#start').hidden = false;
    view = 'one';
    renderCrumbs();
  }
  $('#clearAll').addEventListener('click', () => {
    const n = items.length;
    if (n < 2 || items[0].coll || confirm(`把這 ${n} 張照片都移除，重新開始？`)) reset();
  });

  // ---------- what the worker does next ----------
  // One job at a time, picked when the last one ends: the photo on screen first, then the one after it (so the next
  // click or → is instant).
  const fullQ = [];
  let running = false;
  function pump() {
    if (running) return;
    let job = null;
    while (!job && fullQ.length) {
      const it = fullQ.shift();
      if (!it.done && !it.busy) job = () => process(it);
    }
    if (!job) return;
    running = true;
    job().catch(() => {}).finally(() => { running = false; pump(); });
  }
  // the one on screen: all of it, next; then its neighbour
  function want(it) {
    if (!it || it.done || it.busy) return;
    const i = fullQ.indexOf(it);
    if (i >= 0) fullQ.splice(i, 1);
    fullQ.unshift(it);
    const next = items[items.indexOf(it) + 1];
    if (next && !next.fk && !next.done && !next.busy && !fullQ.includes(next)) fullQ.splice(1, 0, next);
    pump();
  }

  // meta.js: the whole RAW file when it's open (to find the picture inside), only the start of anything else
  async function readJs(it, open) {
    try {
      const raw = it.raw || /\.(tiff?|dng)$/i.test(it.file.name);
      const r = await ZMeta.read(it.file, { whole: open && raw && it.file.size <= 400e6, head: raw ? 2 << 20 : 262144, preview: raw });
      if (!r) return { ok: false, error: 'format' };
      // a RAW file's Lightroom settings are in its .xmp: those win
      if (it.side) { const x = await ZMeta.read(it.side); if (x) for (const [k, v] of Object.entries(x.tags)) if (/^XMP-/.test(k)) r.tags[k] = v; }
      return { ok: true, tags: r.tags, preview: r.preview || null, thumb: r.thumb, js: true };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  }

  async function process(it) {
    if (it.fk) return readFlickr(it);
    it.busy = true;
    const r = JS_ONLY ? await readJs(it, true) : await ask({ file: it.file, preview: !SHOWABLE.test(it.file.name), side: it.side || null });
    it.reader = r.js ? 'js' : 'exiftool';
    it.busy = false;
    it.done = true;
    it.ok = r.ok;
    if (r.ok) {
      it.tags = r.tags;
      it.idx = indexTags(r.tags);
      it.groups = new Set(Object.keys(r.tags).map((k) => k.split(':')[0]));
      it.pv = r.preview;
      it.sheet = null;
      count(it);
    } else it.error = r.error;
    await prepareImage(it);
    renderThumbs();
    if (it === cur()) { renderInfo(); drawStage(); }
  }

  function select(i) {
    if (i < 0 || i >= items.length) return;
    current = i;
    loupeReset();
    renderThumbs();
    renderInfo();
    drawStage();
    renderCrumbs();
    want(cur());
  }

  // ---------- the tags ----------
  // ExifTool -G1 -l: { "Group:Tag": { desc, val, num? } }. The same tag can come from several groups (EXIF, the
  // maker's notes, XMP…); look in a sensible order.
  const STD = ['ExifIFD', 'IFD0', 'Composite', 'GPS'];
  const rankOf = (g) => {
    const i = STD.indexOf(g);
    if (i >= 0) return i;
    if (/^(XMP|IPTC|Photoshop|ICC|File|JFIF|MPF|IFD1|SubIFD|InteropIFD|QuickTime|Keys|ItemList|UserData|Track|PrintIM|MakerNotes|HEIF|PNG|RIFF)/.test(g)) return 9;
    return 5; // a maker's notes: Canon, Nikon, Sony, FujiFilm…
  };
  const empty = (v) => v == null || (typeof v === 'string' && (!v.trim() || /^(n\/a|unknown( \(\d+\))?|none|0000:00:00 00:00:00)$/i.test(v.trim())));
  function indexTags(tags) {
    const idx = new Map();
    for (const [key, e] of Object.entries(tags)) {
      if (!e || typeof e !== 'object' || !key.includes(':')) continue;
      const [g, name] = key.split(':');
      const v = Array.isArray(e.val) ? e.val.join(', ') : e.val;
      if (!idx.has(name)) idx.set(name, []);
      idx.get(name).push({ g, name, desc: e.desc || name, val: v == null ? '' : String(v), num: e.num, rank: rankOf(g) });
    }
    for (const list of idx.values()) list.sort((a, b) => a.rank - b.rank);
    return idx;
  }
  // first non-empty entry for any of the names; opts.groups limits/orders the groups, opts.notGroups skips some.
  // Lightroom's settings (XMP-crs) share names with the camera's (WhiteBalance, Saturation…): only when asked for.
  function pick(it, names, opts = {}) {
    for (const name of [].concat(names)) {
      let list = it.idx.get(name) || [];
      if (opts.groups) list = opts.groups.flatMap((g) => list.filter((e) => e.g === g || (g === '*maker' && e.rank === 5)));
      else list = list.filter((e) => e.g !== 'XMP-crs');
      if (opts.notGroups) list = list.filter((e) => !opts.notGroups.includes(e.g));
      const e = list.find((x) => !empty(x.val));
      if (e) return e;
    }
    return null;
  }
  const val = (it, names, opts) => { const e = pick(it, names, opts); return e ? e.val : ''; };
  const numOf = (e) => {
    if (!e) return NaN;
    const n = e.num != null ? (typeof e.num === 'number' ? e.num : parseFloat(e.num)) : parseFloat(e.val);
    return Number.isFinite(n) ? n : NaN;
  };
  const num = (it, names, opts) => numOf(pick(it, names, opts));

  // ---------- words ----------
  const map = (table) => (v) => (v in table ? table[v] : v);
  const replaceAll = (rules) => (v) => rules.reduce((s, [re, to]) => s.replace(re, to), v).trim();
  const trProgram = map({
    'Manual': '手動（M）', 'Program AE': '程式自動（P）', 'Aperture-priority AE': '光圈先決（A / Av）',
    'Shutter speed priority AE': '快門先決（S / Tv）', 'Creative (Slow speed)': '創意模式（慢速）',
    'Action (High speed)': '運動模式（高速）', 'Portrait': '人像模式', 'Landscape': '風景模式', 'Bulb': 'B 快門', 'Not Defined': '',
  });
  const trMetering = map({
    'Multi-segment': '多區評價測光', 'Center-weighted average': '中央重點平均測光', 'Spot': '點測光', 'Multi-spot': '多點測光',
    'Partial': '局部測光', 'Average': '平均測光', 'Other': '其他',
  });
  const trWb = replaceAll([
    [/^Auto \(ambience priority\)$/, '自動（氣氛優先）'], [/^Auto \(white priority\)$/, '自動（白色優先）'],
    [/^Auto\d?$/, '自動'], [/^Manual$/, '手動'], [/^Daylight$|^Direct sunlight$|^Sunny$/, '日光'], [/^Cloudy$/, '陰天'], [/^Shade$/, '陰影'],
    [/^Tungsten$|^Incandescent$/, '鎢絲燈'], [/^Fluorescent$/, '螢光燈'], [/^Flash$/, '閃光燈'], [/^Custom\d?$/, '自訂'],
    [/^Kelvin$|^Color Temperature.*$/, '指定色溫'], [/^Multi Auto$/, '多重自動'], [/^Underwater$/, '水中'], [/^Fine Weather$/, '晴天'],
  ]);
  const trFocus = replaceAll([
    [/AI Servo AF/, 'AI Servo 連續對焦'], [/One-?[Ss]hot AF/, 'One-Shot 單次對焦'], [/AI Focus AF/, 'AI Focus 自動切換'],
    [/^Manual Focus|^Manual$|^MF$/, '手動對焦'], [/^AF-C\b/, 'AF-C 連續對焦'], [/^AF-S\b/, 'AF-S 單次對焦'],
    [/^AF-A\b/, 'AF-A 自動切換'], [/^AF-F\b/, 'AF-F 全時對焦'], [/^DMF\b/, 'DMF 對焦後可手動微調'],
    [/^Continuous AF(;.*)?$|^Continuous$/, '連續對焦'], [/^Single AF(;.*)?$|^Single$/, '單次對焦'], [/^Auto$/, '自動'],
    [/\s*\(Focus-priority\)/, '（對焦優先）'], [/\s*\(Release-priority\)/, '（快門優先）'],
    [/\s*\(Live View\)/, '（即時取景）'], [/\s*\(\d+\)$/, ''],
  ]);
  const trDrive = replaceAll([
    [/Single-frame( Shooting)?|Single Frame|^Single$/i, '單張'], [/Continuous( Shooting)?/i, '連拍'], [/Self-timer( Operation)?/i, '自拍'],
    [/;.*$/, ''], [/^Normal$|^Single Shot$/, '單張'], [/\bHigh\b/, '高速'], [/\bLow\b/, '低速'], [/\bSilent\b/, '靜音'], [/, /g, '・'],
  ]);
  const trShutter = replaceAll([
    [/Electronic (First|Front)[- ]Curtain( Shutter)?|^EFCS$/i, '電子前簾'], [/^Mechanical( Shutter)?$/i, '機械快門'],
    [/^Electronic( Shutter)?$/i, '電子快門'], [/^Mechanical\b.*$/i, '機械快門'], [/^On$/, '電子前簾'], [/^Off$/, '機械快門'], [/^Auto \((.+)\)$/, '自動（$1）'], [/^Normal$/, ''],
  ]);
  const trOnOff = (v) => (/\bOff\b|VR-Off/i.test(v) ? '關' : /\bOn\b|VR-On/i.test(v) ? (/OIS Lens|Optical/i.test(v) ? '開（鏡頭防手震）' : '開') : v);
  const trArea = replaceAll([
    [/^AF Point Expansion \((\d+) point\)$/, '擴展對焦點（$1 點）'], [/^AF Point Expansion \(surround\)$/, '擴展對焦點（周圍）'],
    [/^Single-point AF.*$|^Single( Area| Point)?$|^Single-point$/, '單點'], [/^Spot AF$/, '定點'], [/^Large Zone AF.*$/, '大區域'],
    [/^Zone AF$|^Zone$/, '區域'], [/^Flexible Spot.*$/, '自由點'], [/^Wide$/, '廣域'], [/^Center$/, '中央'],
    [/^Auto( Area| AF Point Selection)?$|^Auto-area$/, '自動選擇'], [/^Wide\/Tracking$/, '廣域／追蹤'], [/^Tracking$/, '追蹤'],
    [/^Whole Area AF.*$|^Face \+ Tracking$|^Face Detect AF.*$/, '全區域（追蹤）'], [/^Dynamic( Area)?(.*)$/, '動態區域$2'], [/^(\d+)-area$/, '$1 區自動'],
  ]);
  const trStyleWord = map({
    'Standard': '標準', 'Neutral': '中性', 'Faithful': '忠實', 'Portrait': '人像', 'Landscape': '風景', 'Monochrome': '黑白',
    'Vivid': '鮮豔', 'Auto': '自動', 'Fine Detail': '精緻細節', 'Flat': '平淡', 'Natural': '自然',
  });
  // Fujifilm says "F0/Standard (Provia)": the film's name first
  const trStyle = (v) => {
    const m = v.match(/^F\d+\/([^(]+?)\s*\(([^)]+)\)$/);
    return m ? `${m[2]}（${trStyleWord(m[1])}）` : trStyleWord(v.replace(/;.*$/, ''));
  };
  const trOrient = map({
    'Horizontal (normal)': '', 'Rotate 90 CW': '向右轉 90°', 'Rotate 270 CW': '向左轉 90°', 'Rotate 180': '轉 180°',
    'Mirror horizontal': '左右鏡像', 'Mirror vertical': '上下鏡像', 'Mirror horizontal and rotate 270 CW': '鏡像後向左轉 90°',
    'Mirror horizontal and rotate 90 CW': '鏡像後向右轉 90°',
  });
  const trColor = map({ 'Uncalibrated': '未標示（常見於 Adobe RGB）' });
  function trFlash(v, type) {
    if (/No flash function/i.test(v)) return '沒有閃光燈';
    const fired = /Fired/.test(v) && !/Did not fire/.test(v);
    const mode = /^Auto/.test(v) ? '自動' : /^On/.test(v) ? '強制閃光' : /^Off/.test(v) ? '關閉' : '';
    let s = fired ? '有閃' : '沒閃';
    if (mode) s += `（${mode}）`;
    if (/Red-eye/i.test(v)) s += '・防紅眼';
    if (fired && type) s += /External/i.test(type) ? '・外接閃燈' : /Built-?In/i.test(type) ? '・內建閃燈' : '';
    return s;
  }
  const evText = (v) => (!v || v === '0' || v === '+0' || v === '-0' ? '±0' : /^[+-]/.test(v) ? v : `+${v}`);
  const metres = (s) => s.replace(/(\d+\.\d+)/g, (m) => trim0(m, 2)).replace(/\s*-\s*/g, ' – ').replace(/\binf\b/g, '無限遠');
  const fNum = (x) => (x >= 10 ? String(Math.round(x)) : trim0(x));

  // Sony names its bodies by code in the file
  const SONY = {
    'ILCE-7': 'α7', 'ILCE-7M2': 'α7 II', 'ILCE-7M3': 'α7 III', 'ILCE-7M4': 'α7 IV', 'ILCE-7R': 'α7R', 'ILCE-7RM2': 'α7R II', 'ILCE-7RM3': 'α7R III',
    'ILCE-7RM3A': 'α7R IIIA', 'ILCE-7RM4': 'α7R IV', 'ILCE-7RM4A': 'α7R IVA', 'ILCE-7RM5': 'α7R V', 'ILCE-7S': 'α7S', 'ILCE-7SM2': 'α7S II', 'ILCE-7SM3': 'α7S III',
    'ILCE-7C': 'α7C', 'ILCE-7CM2': 'α7C II', 'ILCE-7CR': 'α7CR', 'ILCE-9': 'α9', 'ILCE-9M2': 'α9 II', 'ILCE-9M3': 'α9 III', 'ILCE-1': 'α1', 'ILCE-1M2': 'α1 II',
    'ILCE-5100': 'α5100', 'ILCE-6000': 'α6000', 'ILCE-6100': 'α6100', 'ILCE-6300': 'α6300', 'ILCE-6400': 'α6400', 'ILCE-6500': 'α6500', 'ILCE-6600': 'α6600',
    'ILCE-6700': 'α6700', 'ILME-FX3': 'FX3', 'ILME-FX30': 'FX30', 'ZV-E10M2': 'ZV-E10 II',
  };
  function cameraName(it) {
    return camLabel(val(it, 'Make'), val(it, ['Model', 'CameraModelName']));
  }
  function lensName(it) {
    const id = val(it, 'LensID', { groups: ['Composite'] }) || val(it, 'LensID');
    const model = val(it, 'LensModel');
    if (id && !/ or |Unknown|^\d+$|^-?\d+ \(/.test(id)) return id;
    return model || val(it, 'LensType') || (id && !/^\d+$/.test(id) ? id : '');
  }
  function sensorName(scale) {
    if (!(scale > 0)) return '';
    if (scale < 0.9) return '中片幅';
    if (scale < 1.15) return '全片幅';
    if (scale < 1.42) return 'APS-H';
    if (scale < 1.75) return 'APS-C';
    if (scale < 2.2) return 'M4/3';
    if (scale < 3.2) return '1 吋';
    return '';
  }
  function dateParts(it) {
    const e = pick(it, ['SubSecDateTimeOriginal', 'DateTimeOriginal', 'SubSecCreateDate', 'CreateDate', 'DateCreated', 'ModifyDate']);
    if (!e) return null;
    const m = e.val.match(/^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)(\.\d+)?(Z|[+-]\d\d:?\d\d)?/);
    if (!m) return null;
    let off = m[8] || val(it, ['OffsetTimeOriginal', 'OffsetTime', 'TimeZone']);
    const wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
    let tz = '';
    const om = (off || '').match(/^([+-])(\d\d):?(\d\d)$/);
    if (om) tz = `UTC${om[1]}${+om[2]}${om[3] !== '00' ? ':' + om[3] : ''}`;
    else if (off === 'Z') tz = 'UTC';
    return { text: `${m[1]}/${+m[2]}/${+m[3]}（週${'日一二三四五六'[wd]}）${m[4]}:${m[5]}:${m[6]}`, tz };
  }
  function gpsOf(it) {
    const lat = num(it, 'GPSLatitude', { groups: ['Composite', 'GPS', 'XMP-exif'] });
    const lon = num(it, 'GPSLongitude', { groups: ['Composite', 'GPS', 'XMP-exif'] });
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
    // the GPS group's own numbers have no sign (that's in the Ref tag); Composite's do
    const comp = pick(it, 'GPSLatitude', { groups: ['Composite'] });
    let la = lat, lo = lon;
    if (!comp) { if (/S/.test(val(it, 'GPSLatitudeRef'))) la = -Math.abs(la); if (/W/.test(val(it, 'GPSLongitudeRef'))) lo = -Math.abs(lo); }
    return { lat: la, lon: lo };
  }
  const DIRS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];

  // ---------- the five numbers across the top ----------
  function expoCells(it) {
    const fl = num(it, 'FocalLength', { groups: ['ExifIFD', 'Composite', '*maker', 'XMP-exif'] });
    const fl35 = num(it, 'FocalLength35efl', { groups: ['Composite'] });
    const scale = num(it, 'ScaleFactor35efl', { groups: ['Composite'] });
    const fn = num(it, ['FNumber', 'Aperture']);
    const maxAp = num(it, 'MaxApertureValue');
    const exp = pick(it, ['ExposureTime', 'ShutterSpeed'], { groups: ['ExifIFD', 'Composite', 'XMP-exif', '*maker'] }) || pick(it, ['ExposureTime', 'ShutterSpeed']);
    const iso = num(it, 'ISO', { groups: ['ExifIFD', 'Composite', '*maker', 'XMP-exif'] });
    const ev = val(it, 'ExposureCompensation', { groups: ['ExifIFD', '*maker', 'XMP-exif'] });
    let expVal = exp ? exp.val.replace(/\s*s(ec)?$/, '') : '';
    if (/^\d+(\.\d+)?$/.test(expVal) && +expVal < 1 && +expVal > 0) {
      const inv = 1 / +expVal;
      if (Math.abs(inv - Math.round(inv)) < 0.02) expVal = `1/${Math.round(inv)}`;
    }
    return [
      { k: '焦距', v: Number.isFinite(fl) ? trim0(fl) : '', u: 'mm', s: Number.isFinite(fl35) && Number.isFinite(fl) && Math.abs(fl35 - fl) > 1 ? `等效 ${Math.round(fl35)} mm` : sensorName(scale) },
      { k: '光圈', v: Number.isFinite(fn) ? `f/${fNum(fn)}` : '', s: Number.isFinite(maxAp) ? (Number.isFinite(fn) && Math.abs(maxAp - fn) < 0.05 ? '全開' : `最大 f/${fNum(maxAp)}`) : '' },
      { k: '快門', v: expVal, u: expVal ? '秒' : '', s: trShutter(val(it, ['ShutterMode', 'ShutterType', 'ElectronicFrontCurtainShutter', 'Shutter'])) },
      { k: 'ISO', v: Number.isFinite(iso) ? String(Math.round(iso)) : '', s: /auto/i.test(val(it, 'ISOSetting')) ? '自動' : '' },
      { k: '曝光補償', v: ev ? evText(ev) : '', u: ev ? 'EV' : '', s: '' },
    ];
  }

  function copyLine(it) {
    const c = expoCells(it);
    return [cameraName(it), lensName(it), c[0].v && `${c[0].v}mm`, c[1].v, c[2].v && `${c[2].v}s`, c[3].v && `ISO ${c[3].v}`, c[4].v && c[4].v !== '±0' ? `${c[4].v} EV` : '']
      .filter(Boolean).join(' · ');
  }

  // ---------- the sheet: everything worth reading, sorted into cards ----------
  // ExifTool hands over hundreds of tags, many of them one thing told several times (EXIF and the maker's notes, a
  // CR3's metadata track, Composite's sums). Each row reads the tags it needs and marks them used; whatever no row
  // used, isn't file structure and isn't a repeat goes to 其他技術資料 at the bottom.
  const WORDS = {
    On: '開', Off: '關', Enable: '開', Enabled: '開', Disable: '關', Disabled: '關', Yes: '是', No: '否', true: '是', false: '否',
    Auto: '自動', Standard: '標準', Normal: '標準', Low: '低', High: '高', Strong: '強', Weak: '弱', Mid: '中', Medium: '中',
    None: '無', Manual: '手動', Single: '單張', Continuous: '連續', Large: '大', Small: '小', Fine: '精細', 'Extra Fine': '超精細',
    Unknown: '不明', Lossless: '無損壓縮', Uncompressed: '不壓縮', Natural: '自然', Vivid: '鮮豔', Enhanced: '加強',
    'Focus Priority': '對焦優先', 'Release Priority': '快門優先', 'Equal Priority': '同等優先', Release: '快門優先', Focus: '對焦優先',
    Full: '滿', Evaluative: '評價測光', Partial: '局部測光', Spot: '點測光', 'Center-weighted average': '中央重點平均測光', Additive: '相加', Average: '平均',
  };
  const tw = (v) => {
    const s = String(v).trim();
    if (Object.hasOwn(WORDS, s)) return WORDS[s];
    let m = s.match(/^(On|Off) \(.+\)$/);
    if (m) return WORDS[m[1]];
    m = s.match(/^([+-]?\d+) \(.+\)$/); // Fujifilm: "0 (normal)", "+1 (medium hard)"
    if (m) return +m[1] === 0 ? '標準' : m[1];
    return s;
  };
  const off = (v) => !v || /^(Off|Disable|Disabled|No|None|Not Used|0)\b/i.test(String(v).trim());
  const sg = (x, d = 0) => (x > 0 ? `+${trim0(x, d)}` : x < 0 ? `−${trim0(-x, d)}` : '0');
  const trSubject = map({ People: '人物', Human: '人物', Animals: '動物', Animal: '動物', Birds: '鳥', Bird: '鳥', Vehicles: '交通工具', Vehicle: '交通工具', Auto: '自動', Airplane: '飛機', Train: '火車', Insect: '昆蟲' });
  const trScene = (v) => ({ Standard: '', Normal: '', Landscape: '風景', Portrait: '人像', Night: '夜景', 'Night Scene': '夜景', Nightview: '夜景', Sports: '運動', Macro: '微距', Sunset: '夕陽' }[v] ?? v);
  const trCity = map({
    'Hong Kong': '香港', Taipei: '台北', Tokyo: '東京', Seoul: '首爾', Beijing: '北京', Shanghai: '上海', Singapore: '新加坡', Bangkok: '曼谷',
    Sydney: '雪梨', Dubai: '杜拜', Delhi: '德里', Moscow: '莫斯科', London: '倫敦', Paris: '巴黎', Berlin: '柏林', Rome: '羅馬',
    'New York': '紐約', Chicago: '芝加哥', Denver: '丹佛', 'Los Angeles': '洛杉磯', Honolulu: '檀香山', Anchorage: '安克拉治',
  });
  const PHONE_MAKE = /^(apple|google|samsung|xiaomi|redmi|huawei|honor|oppo|vivo|oneplus|realme|motorola|hmd|nokia|asus|nothing|fairphone|meizu|zte)\b/i;
  const isPhone = (it) => PHONE_MAKE.test(val(it, 'Make')) || /\b(back|front|rear)\b.*\bcamera\b/i.test(val(it, 'LensModel'));
  function fmtDate(s) {
    const m = String(s || '').match(/^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/);
    if (!m || m[1] === '0000') return '';
    const wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
    return `${m[1]}/${+m[2]}/${+m[3]}（週${'日一二三四五六'[wd]}）${m[4]}:${m[5]}:${m[6]}`;
  }
  // what the camera fixed for the lens while shooting
  const CORRECTIONS = [
    ['周邊亮度', ['PeripheralLightingSetting', 'PeripheralIlluminationCorr', 'VignetteControl', 'VignettingCorrection', 'ShadingCompensation']],
    ['色差', ['ChromaticAberrationSetting', 'ChromaticAberrationCorr', 'LateralChromaticAberration', 'ChromaticAberrationCorrection']],
    ['變形', ['DistortionCorrectionSetting', 'AutoDistortionControl', 'DistortionCorrection2', 'DistortionCorrection']],
    ['繞射', ['DiffractionCorrection', 'DiffractionCompensation']],
    ['數位鏡頭最佳化', ['DigitalLensOptimizerSetting', 'DigitalLensOptimizer']],
    ['鏡頭調變最佳化', ['LensModulationOptimizer']],
  ];
  const HSL = [['Red', '紅'], ['Orange', '橙'], ['Yellow', '黃'], ['Green', '綠'], ['Aqua', '水綠'], ['Blue', '藍'], ['Purple', '紫'], ['Magenta', '洋紅']];

  function buildSheet(it) {
    const used = new Set();
    const use = (...names) => { for (const x of names.flat()) used.add(x); };
    const v = (names, opts) => { use(names); return val(it, names, opts); };
    const n = (names, opts) => { use(names); return num(it, names, opts); };
    const cards = [];
    const card = (id, title, rows, extra = {}) => {
      const list = rows.filter(Boolean);
      if (list.length) cards.push({ id, title, rows: list, ...extra });
    };
    // a row: label, value (text or a node), a hint for the "?", the text for search and the table
    const R = (k, value, hint, text) => (value ? { k, v: value, hint, text: text || (typeof value === 'string' ? value : value.textContent) } : null);
    const chips = (pairs) => {
      const p = pairs.filter(([, x]) => x);
      return p.length ? { node: el('span', { class: 'chips' }, ...p.map(([k, x]) => el('span', { class: 'chip' }, `${k} `, el('b', { text: x })))), text: p.map(([k, x]) => `${k} ${x}`).join('・') } : null;
    };
    const C = (k, c, hint) => (c ? R(k, c.node, hint, c.text) : null);
    const make = val(it, 'Make');
    const phone = isPhone(it);
    const fuji = /fujifilm/i.test(make);

    // already on screen: the camera and lens in the title, the five numbers under it
    use('Make', 'Model', 'CameraModelName', 'UniqueCameraModel', 'LocalizedCameraModel', 'CanonImageType', 'CanonModelID', 'SonyModelID', 'FujiModel', 'FujiModel2',
      'LensID', 'LensModel', 'LensType', 'LensType2', 'LensType3', 'Lens', 'LensSpec', 'LensMake', 'RFLensType', 'LensSpecFeatures', 'LensFormat', 'LensMount',
      'FocalLength', 'FocalLength35efl', 'FocalLengthIn35mmFormat', 'ScaleFactor35efl', 'FocalPlaneXResolution', 'FocalPlaneYResolution', 'FocalPlaneResolutionUnit', 'FocalUnits',
      'FNumber', 'Aperture', 'ApertureValue', 'TargetAperture', 'SonyFNumber', 'SonyFNumber2', 'MaxApertureValue', 'SonyMaxApertureValue',
      'ExposureTime', 'ShutterSpeed', 'ShutterSpeedValue', 'TargetExposureTime', 'SonyExposureTime', 'SonyExposureTime2',
      'ISO', 'ISO2', 'SonyISO', 'ISOSetting', 'ISOSpeed', 'BaseISO', 'AutoISO', 'RecommendedExposureIndex', 'StandardOutputSensitivity', 'SensitivityType',
      'StopsAboveBaseISO', 'ISOExpansion', 'ISOExpansion2', 'ExposureCompensation', 'ExposureStandardAdjustment', 'ExposureDifference', 'ExposureTuning', 'RawExposureBias',
      'ShutterMode', 'ShutterType', 'Shutter', 'ElectronicFrontCurtainShutter');

    // ---- 曝光
    const program = trProgram(v('ExposureProgram')) || tw(v('ShootingMode', { groups: ['Composite'] }) || v('ExposureMode', { groups: ['ExifIFD', '*maker'] }));
    use('ShootingMode', 'CanonExposureMode', 'EasyMode', 'ExposureMode', 'IntelligentAuto', 'ProgramShift', /pentax|ricoh|fujifilm/i.test(make) ? 'PictureMode' : []);
    const aebV = v(['AutoExposureBracketing', 'BracketMode', 'AutoBracketing']);
    const aeb = (aebV && !off(aebV)) || /bracket/i.test(val(it, 'ExposureMode'));
    const aebStep = n(['AEBBracketValue', 'ExposureBracketValue', 'BracketValue']);
    use('BracketShotNumber', 'WBBracketMode', 'WBBracketValueAB', 'WBBracketValueGM', 'FlashExposureBracketValue', 'SequenceNumber', 'SequenceImageNumber', 'SequenceFileNumber', 'SequenceLength', 'SingleFrame');
    const flashV = v('Flash');
    let flash = flashV ? trFlash(flashV, val(it, 'FlashType')) : '';
    if (/有閃/.test(flash)) {
      const fec = num(it, ['FlashExposureComp', 'ConditionalFEC', 'FlashCompensation']);
      if (fec) flash += `・閃燈補償 ${sg(fec, 1)} EV`;
      if (/2nd|rear/i.test(val(it, ['ShutterCurtainHack', 'FlashSetting']))) flash += '・後簾同步';
    }
    use('FlashType', 'FlashExposureComp', 'ConditionalFEC', 'FlashCompensation', 'CanonFlashMode', 'FlashActivity', 'FlashBits', 'FlashGuideNumber', 'FlashExposureLock',
      'ManualFlashOutput', 'RedEyeReduction', 'ShutterCurtainHack', 'FlashMode', 'FlashSetting', 'FlashControlMode', 'FlashSource', 'ExternalFlashStatus',
      'ExternalFlashExposureComp', 'ExternalFlashZoomOverride', 'FlashAction', 'FlashStatus', 'FlashLevel', 'FujiFlashMode', 'SlowSync', 'FlashFired', 'FlashReturn',
      'FlashFunction', 'FlashRedEyeMode', 'FlashGNDistance', 'FlashMasterControlMode', 'FlashGroupAControlMode', 'FlashGroupBControlMode', 'FlashGroupCControlMode',
      'FlashGroupACompensation', 'FlashGroupBCompensation', 'FlashGroupCCompensation', 'FlashOutput', 'FlashChargeLevel');
    let drive = trDrive(v(['DriveMode', 'ContinuousDrive', 'ReleaseMode', 'DriveModeSetting', 'ReleaseMode2', 'ReleaseMode3'], { groups: ['Composite', '*maker'] }));
    const timer = v(['SelfTimer', 'SelfTimer2']);
    if (((timer && !off(timer)) || /self-timer/i.test(val(it, 'ShootingMode', { groups: ['*maker'] }))) && !/自拍/.test(drive)) {
      drive = [drive, `自拍${/\d/.test(timer) ? ` ${timer.replace(/\s*s(ec)?$/, '')} 秒` : ''}`].filter(Boolean).join('・');
    }
    const flicker = v(['AntiFlicker', 'FlickerReduction', 'FlickerReductionShooting']);
    const zoom = n('DigitalZoomRatio');
    use('DigitalZoom', 'BrightnessValue', 'MeasuredEV', 'MeasuredEV2', 'MeasuredLV', 'SceneType', 'SensingMethod', 'FileSource', 'CustomRendered', 'SubjectArea', 'ISOAutoMin', 'ISOAutoMax');
    const lv = n('LightValue', { groups: ['Composite'] });
    const isoAuto = /auto/i.test(val(it, 'ISOSetting')) && num(it, 'ISOAutoMin') > 0 ? `${num(it, 'ISOAutoMin')} – ${num(it, 'ISOAutoMax')}` : '';
    card('expo', '曝光', [
      R('曝光模式', program),
      R('測光', trMetering(v(['MeteringMode', 'MeteringMode2', 'NikonMeteringMode']))),
      R('閃光燈', flash),
      R('驅動', drive),
      R('包圍曝光', aeb ? `開${aebStep ? `・每張差 ${trim0(Math.abs(aebStep), 2)} EV` : ''}` : ''),
      R('自動 ISO 範圍', isoAuto),
      R('防閃爍', flicker && !off(flicker) ? '開' : ''),
      R('場景', tw(trScene(v(['SceneCaptureType', 'SceneMode'])))),
      R('數位變焦', zoom > 1.02 ? `${trim0(zoom, 1)} 倍` : ''),
      R('現場亮度', Number.isFinite(lv) ? `LV ${trim0(lv)}` : '', '光值（LV）：室內約 5～7，陰天戶外約 12，晴天約 15'),
    ]);

    // ---- 對焦
    let fm = v(['FocusMode', 'FocusMode2', 'AFMode'], { groups: ['*maker', 'ExifIFD', 'XMP-exif', 'Composite'] });
    if (/^(Auto|AF)$/i.test(fm) && val(it, 'FocusMode2')) fm = val(it, 'FocusMode2'); // Fujifilm: "Auto" means AF; AF-S/AF-C comes next
    use('FocusContinuous', 'FocusMode2', 'AFMode', 'FocusRange', 'LiveViewShooting');
    const subject = v(['SubjectToDetect', 'SubjectDetection', 'AFSubjectDetection']);
    const eye = v(['EyeDetection', 'EyeDetect']);
    const faces = n('FacesDetected');
    const focusDist = (() => {
      const up = n('FocusDistanceUpper'), lo = n('FocusDistanceLower');
      // Canon writes 655.35 m for "infinity"
      if (Number.isFinite(lo) && lo > 0) return Number.isFinite(up) && up > lo && up < 600 ? `${trim0(lo, 2)} – ${trim0(up, 2)} m` : `${trim0(lo, 2)} m 以上`;
      const d = v(['FocusDistance', 'SubjectDistance', 'FocusDistance2', 'FocusDistanceRange', 'ApproximateFocusDistance']); // the last: Lightroom's
      return d ? metres(/^[\d.]+$/.test(d) ? `${d} m` : d) : '';
    })();
    const micro = v(['AFMicroAdjMode', 'AFFineTune']);
    const microV = n(['AFMicroAdjValue', 'AFFineTuneAdj']);
    const bracketF = v(['FocusBracketing', 'FocusShiftShooting']);
    // where the points were, how many there are: structure, not settings
    use('NumAFPoints', 'ValidAFPoints', 'AFPointsInFocus', 'AFPointsSelected', 'AFPointsUsed', 'FocalPlaneAFPointsUsed', 'AFImageWidth', 'AFImageHeight', 'AFAreaWidths',
      'AFAreaHeights', 'AFAreaXPositions', 'AFAreaYPositions', 'AFAreaXPosition', 'AFAreaYPosition', 'AFAreaWidth', 'AFAreaHeight', 'FocusPixel', 'FocusLocation',
      'FlexibleSpotPosition', 'FocusPositionHorizontal', 'FocusPositionVertical', 'AFCoordinatesAvailable', 'FocusPosition', 'FocusPosition2', 'AFMeasuredDepth',
      'AFConfidence', 'AFPerformance', 'AFStable', 'LensPositionAbsolute', 'FocusPointSchema', 'NumFaceElements', 'FaceInfoOffset', 'FaceInfoLength', 'FaceDetectFrameSize',
      'FacePositions', 'FaceElementTypes', 'FaceElementPositions', 'SubjectDistanceRange', 'AFAreaMode2', 'AFTracking');
    card('focus', '對焦', [
      R('對焦模式', trFocus(fm)),
      R('對焦區域', trArea(v(['AFAreaMode', 'AFAreaModeSetting', 'AFArea', 'FocusArea']))),
      R('偵測主體', subject && !off(subject) ? trSubject(subject) : ''),
      R('眼部偵測', eye ? tw(eye) : ''),
      R('偵測到人臉', faces > 0 ? `${faces} 張` : ''),
      R('對焦距離', focusDist, '鏡頭回報的距離，不一定很精準'),
      R('AF 微調', micro && !off(micro) ? sg(microV || 0) : ''),
      R('對焦包圍', bracketF && !off(bracketF) ? '開' : ''),
    ]);

    // ---- 鏡頭與景深
    const lens35 = v('Lens35efl', { groups: ['Composite'] });
    const range = (() => {
      const m = lens35.match(/^([\d.]+)(?: - ([\d.]+))? mm(?: \(35 mm equivalent: ([\d.]+)(?: - ([\d.]+))? mm\))?/);
      if (!m) {
        // ExifIFD:LensInfo, as numbers: shortest and longest focal length, then the widest aperture at each
        const nums = String((pick(it, 'LensInfo') || {}).num || '').split(/\s+/).map(Number);
        if (!(nums[0] > 0)) return '';
        const fl = nums[1] > nums[0] ? `${trim0(nums[0])} – ${trim0(nums[1])} mm` : `${trim0(nums[0])} mm`;
        const ap = nums[2] > 0 ? (nums[3] > nums[2] + 0.05 ? `f/${fNum(nums[2])}–${fNum(nums[3])}` : `f/${fNum(nums[2])}`) : '';
        return [fl, ap].filter(Boolean).join('　');
      }
      const a = m[2] ? `${trim0(m[1])} – ${trim0(m[2])} mm` : `${trim0(m[1])} mm`;
      const b = m[3] ? (m[4] ? `${Math.round(m[3])} – ${Math.round(m[4])} mm` : `${Math.round(m[3])} mm`) : '';
      return b && b.replace(/ mm$/, '') !== a.replace(/ mm$/, '') && Math.abs(parseFloat(m[3]) - parseFloat(m[1])) > 1 ? `${a}（等效 ${b}）` : a;
    })();
    use('LensInfo', 'MinFocalLength', 'MaxFocalLength', 'MaxAperture', 'MinAperture', 'FocalType', 'MaxApertureAtMinFocal', 'MaxApertureAtMaxFocal', 'LensFStops', 'LensZoomPosition', 'CircleOfConfusion');
    const fov = (() => {
      const m = v('FOV', { groups: ['Composite'] }).match(/^([\d.]+) deg(?: \(([\d.]+) m\))?/);
      return m ? `${trim0(m[1])}°${m[2] ? `（對焦處約 ${trim0(m[2], 2)} m 寬）` : ''}` : '';
    })();
    const dof = (() => {
      const dv = v('DOF', { groups: ['Composite'] });
      let m = dv.match(/^([\d.]+) m \(([\d.]+) - ([\d.]+) m\)/);
      if (m) return `${trim0(m[2], 2)} – ${trim0(m[3], 2)} m（前後 ${trim0(m[1], 2)} m 清楚）`;
      m = dv.match(/^inf \(([\d.]+) m - inf\)/);
      return m ? `${trim0(m[1], 2)} m 到無限遠都清楚` : '';
    })();
    const hyper = n('HyperfocalDistance', { groups: ['Composite'] });
    const mount = v(['LensMount2', 'LensMountType']).replace(/^(\w+)-mount\b/i, '$1 接環');
    const is = v(['ImageStabilization', 'VibrationReduction', 'SteadyShot', 'ImageStabilizationSetting']);
    let isText = is ? trOnOff(is) : '';
    if (isText === '開' && /in-body/i.test(v('VRType'))) isText = '開（機身防手震）';
    use('VRMode', 'VRInfoVersion', 'VRType');
    const corr = CORRECTIONS.map(([k, names]) => [k, v(names)]).filter(([, x]) => x);
    const corrText = corr.length ? corr.filter(([, x]) => !off(x)).map(([k]) => k).join('・') || '都沒開' : '';
    card('lens', '鏡頭與景深', [
      R('焦段', phone ? '' : range), // a phone's LensInfo spans all its cameras
      R('卡口', mount),
      R('視角', fov),
      R('景深', dof, '依焦距、光圈和對焦距離推算'),
      R('超焦距', Number.isFinite(hyper) && hyper > 0 ? `${hyper >= 10 ? Math.round(hyper) : trim0(hyper, 2)} m` : '', '對焦在這個距離，一半距離到無限遠都會清楚'),
      R('防手震', isText),
      R('鏡頭校正', corrText, '拍的時候相機自動修正的鏡頭缺點'),
      R('鏡頭序號', v('LensSerialNumber')),
      R('鏡頭韌體', v('LensFirmwareVersion').replace(/^Ver\.?\s*/i, '')),
    ]);

    // ---- 色彩與風格
    const wbRaw = v('WhiteBalance', { groups: ['*maker', 'ExifIFD', 'XMP-exif'] });
    // Canon keeps the Kelvin setting in ColorTemperature even when another white balance was used: the
    // as-shot temperature is the one that matters, unless the white balance itself was set in Kelvin
    const kelvin = /Kelvin|Color Temp/i.test(wbRaw) ? n(['ColorTemperature', 'ColorTempAsShot']) : n(['ColorTempAsShot', 'ColorTemperatureAuto', 'ColorTemperature', 'WhiteBalanceTemperature']);
    const wb = [wbRaw && trWb(wbRaw), Number.isFinite(kelvin) && kelvin > 1500 && kelvin < 15000 ? `${Math.round(kelvin)} K` : ''].filter(Boolean).join('・');
    const shiftAB = n('WBShiftAB'), shiftGM = n('WBShiftGM');
    const fine = v(['WhiteBalanceFineTune', 'WBShiftAB_GM', 'WhiteBalanceBias']);
    const shift = shiftAB || shiftGM ? `藍黃 ${sg(shiftAB)}・綠洋紅 ${sg(shiftGM)}` : /[1-9]/.test(fine) ? fine.replace(/Red/g, '紅').replace(/Blue/g, '藍') : '';
    use('RedBalance', 'BlueBalance', 'LightSource', 'PrioritySetInAWB', 'WhiteBalance2', 'WhiteBalanceSetup', 'ColorCompensationFilter', 'WBShiftAB_GM_Precise', 'ColorTemperatureSetting');
    const style = v(['PictureStyle', 'PictureControlName', 'CreativeStyle', 'FilmMode', 'PictureMode', 'PhotoStyle', 'FilmSimulation'], { notGroups: ['Pentax'] }) || v('ImageTone'); // Pentax's PictureMode is the exposure mode
    const styleName = fuji ? '底片模擬' : /nikon/i.test(make) ? '優化校準' : /sony/i.test(make) ? '創意風格' : /panasonic/i.test(make) ? '相片格調' : '照片風格';
    const adj = [['對比', 'Contrast'], ['飽和度', 'Saturation'], ['銳利度', 'Sharpness'], ['色調', 'ColorTone'], ['亮度', 'Brightness']].map(([k, name]) => {
      const x = v(name, { groups: ['*maker', 'ExifIFD'] });
      return x && !/^(Normal|Standard|0|[+-]?0 \(.+\))$/i.test(x) ? `${k} ${tw(x)}` : '';
    }).filter(Boolean).join('・');
    use('SharpnessFrequency', 'UnsharpMaskFineness', 'UnsharpMaskThreshold', 'UnsharpMaskStrength', 'PictureStyleUserDef', 'PictureStylePC', 'CustomPictureStyleFileName',
      'PictureControlBase', 'PictureControlAdjust', 'PictureControlQuickAdjust', 'ColorMode', 'PictureEffect', 'PictureEffect2', 'ToneCurve', 'ColorReproduction');
    const devDR = n('DevelopmentDynamicRange');
    const drSet = v(['DynamicRangeSetting', 'DynamicRange']);
    const tone = fuji ? [['亮部', 'HighlightTone'], ['陰影', 'ShadowTone']].map(([k, name]) => { const x = v(name); return x ? `${k} ${tw(x)}` : ''; }).filter(Boolean).join('・') : '';
    const grain = v('GrainEffectRoughness'), grainSize = v('GrainEffectSize');
    const chrome = v('ColorChromeEffect'), chromeBlue = v('ColorChromeFXBlue');
    const clarity = n('Clarity');
    const dr = [['自動亮度優化', 'AutoLightingOptimizer'], ['高光色調優先', 'HighlightTonePriority'], ['動態 D-Lighting', 'ActiveD-Lighting'], ['動態範圍優化', 'DynamicRangeOptimizer']]
      .map(([k, name]) => { const x = v(name); return x ? `${k} ${tw(x)}` : ''; }).filter(Boolean).join('・');
    const hdr = ['HDR', 'HDRSetting', 'HDR-PQ'].map((name) => [name, v(name).replace(/;.*$/, '')]).filter(([, x]) => x && !off(x)).map(([name, x]) => (name === 'HDR-PQ' ? 'HDR PQ' : tw(x))).join('・');
    use('HDREffect');
    const nr = [['高 ISO', ['HighISONoiseReduction', 'HighISONoiseReduction2']], ['長時間曝光', ['LongExposureNoiseReduction', 'LongExposureNoiseReduction2']], ['多張合成', ['MultiFrameNoiseReduction']], fuji ? ['', ['NoiseReduction']] : null]
      .filter(Boolean).map(([k, names]) => { const x = v(names); return x ? `${k ? `${k} ` : ''}${tw(x)}` : ''; }).filter(Boolean).join('・');
    use('MultiFrameNREffect');
    const profile = v('ProfileDescription');
    const space = (() => {
      const p = profile.replace(/^sRGB IEC61966-2[.-]1$|^sRGB built-in$|^sRGB$/i, 'sRGB').replace(/^Adobe RGB \(1998\)$/, 'Adobe RGB');
      const s = p || trColor(v(['ColorSpace', 'ColorSpaceData']));
      return /^(Display P3|DCI-P3|P3|Adobe RGB|ProPhoto|Rec\.? ?2020|BT\.?2020)/i.test(s) ? `${s}（廣色域）` : s;
    })();
    use('ColorSpace', 'ColorSpaceData', 'InteropIndex');
    card('color', '色彩與風格', [
      R(it.groups.has('XMP-crs') ? '拍攝時白平衡' : '白平衡', wb), // Lightroom's own is under 調色參數
      R('白平衡偏移', shift),
      R(styleName, style ? trStyle(style) : ''),
      R('風格微調', adj),
      R('動態範圍', fuji && devDR > 0 ? `DR${devDR}${/auto/i.test(drSet) ? '（自動）' : ''}` : ''),
      R('亮部／陰影', tone),
      R('顆粒效果', grain ? (off(grain) ? '關' : `${tw(grain)}${grainSize && !off(grainSize) ? `・${tw(grainSize)}顆粒` : ''}`) : ''),
      R('彩色效果', chrome ? `${tw(chrome)}${chromeBlue ? `・藍色 ${tw(chromeBlue)}` : ''}` : ''),
      R('清晰度', Number.isFinite(clarity) && (fuji || clarity) ? sg(clarity) : ''),
      R('亮暗部優化', dr),
      R('HDR', hdr),
      R('降噪', nr),
      R('色彩空間', space, /廣色域/.test(space) ? '比一般的 sRGB 能表現更鮮豔的顏色，新的手機和電腦螢幕看得出差別' : ''),
    ]);

    // ---- 調色: what Lightroom / Camera Raw did, kept in XMP (crs:*) when the export includes it
    const crsE = (name) => pick(it, name, { groups: ['XMP-crs'] });
    const crs = (name) => { const e = crsE(name); return e ? e.val : ''; };
    const crsN = (name) => numOf(crsE(name));
    if (it.groups.has('XMP-crs')) {
      // exposure as Lightroom shows it: +0.50
      const slider = (k, name, d = 0) => { const x = crsN(name); return [k, Number.isFinite(x) && x !== 0 ? (d === 2 ? `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}` : sg(x, d)) : '']; };
      const crsWb = { 'As Shot': '原始設定', Custom: '自訂', Auto: '自動', Daylight: '日光', Cloudy: '陰天', Shade: '陰影', Tungsten: '鎢絲燈', Fluorescent: '螢光燈', Flash: '閃光燈' }[crs('WhiteBalance')] || crs('WhiteBalance');
      const temp = crsN('ColorTemperature'), tint = crsN('Tint');
      const hsl = HSL.map(([en, zh]) => {
        const parts = [['色相', 'Hue'], ['飽和度', 'Saturation'], ['明亮度', 'Luminance']].map(([k, p]) => { const x = crsN(`${p}Adjustment${en}`); return Number.isFinite(x) && x ? `${k} ${sg(x)}` : ''; }).filter(Boolean);
        return parts.length ? `${zh}：${parts.join(' ')}` : '';
      }).filter(Boolean).join('；');
      const grade = [['陰影', 'Shadow'], ['中間調', 'Midtone'], ['亮部', 'Highlight'], ['全域', 'Global']].map(([zh, en]) => {
        const sat = crsN(`ColorGrade${en}Sat`), hue = crsN(`ColorGrade${en}Hue`);
        const sat2 = crsN(`SplitToning${en}Saturation`), hue2 = crsN(`SplitToning${en}Hue`);
        const [h, s] = sat > 0 ? [hue, sat] : sat2 > 0 ? [hue2, sat2] : [NaN, 0];
        return s > 0 ? `${zh} ${Math.round(h || 0)}°・${Math.round(s)}` : '';
      }).filter(Boolean).join('；');
      const curve = crs('ToneCurveName2012') || crs('ToneCurveName');
      const curvePts = String(crs('ToneCurvePV2012') || '').split(/,\s*/).map(Number);
      const curved = /custom/i.test(curve) || (curvePts.length > 4 && curvePts.some((x, i) => i % 2 === 0 && x !== curvePts[i + 1]));
      const lensFix = [[crsN('LensProfileEnable') > 0, '描述檔校正'], [crsN('AutoLateralCA') > 0, '移除色差'], [crsN('PerspectiveUpright') > 0, '自動變形校正']].filter(([x]) => x).map(([, k]) => k).join('・');
      const crop = (() => {
        if (!/true/i.test(crs('HasCrop'))) return '';
        const kept = (crsN('CropRight') - crsN('CropLeft')) * (crsN('CropBottom') - crsN('CropTop'));
        const angle = crsN('CropAngle');
        return ['有裁切', kept > 0 && kept < 1 ? `留下約 ${Math.round(kept * 100)}%` : '', angle ? `拉直 ${sg(angle, 1)}°` : ''].filter(Boolean).join('・');
      })();
      const masks = [...it.idx.keys()].some((k) => /^(MaskGroupBased|GradientBased|PaintBased|CircularGradientBased)Corrections/.test(k) && crsE(k));
      card('grade', '調色參數', [
        R('描述檔', /true/i.test(crs('ConvertToGrayscale')) ? '黑白' : crs('LookName') || crs('CameraProfile')),
        R('白平衡', [crsWb, temp > 1500 ? `${Math.round(temp)} K` : '', Number.isFinite(tint) && tint ? `色調 ${sg(tint)}` : ''].filter(Boolean).join('・')),
        C('基本', chips([slider('曝光度', 'Exposure2012', 2), slider('對比', 'Contrast2012'), slider('亮部', 'Highlights2012'), slider('陰影', 'Shadows2012'), slider('白色', 'Whites2012'), slider('黑色', 'Blacks2012')])),
        C('外觀', chips([slider('紋理', 'Texture'), slider('清晰度', 'Clarity2012'), slider('去朦朧', 'Dehaze'), slider('細節飽和度', 'Vibrance'), slider('飽和度', 'Saturation')])),
        R('色調曲線', curved ? '有調整' : ''),
        R('HSL 顏色', hsl),
        R('顏色分級', grade, '色相（角度）・飽和度'),
        C('細節', chips([slider('銳利化', 'Sharpness'), slider('雜訊減少', 'LuminanceSmoothing'), slider('顏色雜訊', 'ColorNoiseReduction')])),
        R('鏡頭校正', lensFix),
        C('效果', chips([slider('暈映', 'PostCropVignetteAmount'), slider('顆粒', 'GrainAmount')])),
        R('裁切', crop),
        R('局部調整', masks ? '有（遮色片）' : ''),
      ], { sub: 'Lightroom／Camera Raw' });
    }

    // ---- 後製: who wrote the file last, and what it was made from
    let firmware = (v(['FirmwareVersion', 'CanonFirmwareVersion', 'FirmwareRevision', 'Firmware']) || '').replace(/^Firmware Version\s*/i, '');
    let software = v(['Software', 'CreatorTool', 'ProcessingSoftware']);
    use('FirmwareVersion2', 'FirmwareVersion3', 'FirmwareVersion51', 'CompressorVersion', 'XMPToolkit');
    let system = '';
    if (phone) {
      if (/^\d[\d.]*$/.test(software)) { system = `${/apple/i.test(make) ? 'iOS' : '版本'} ${software}`; software = ''; }
      else if (/^HDR\+/i.test(software)) software = '';
    } else if (software) {
      // the camera's own firmware written as "Software": "Ver.1.10", "Digital Camera X-S10 Ver1.00", "ILCE-7M3 v3.01"
      const model = val(it, 'Model');
      const ver = software.match(/(?:^|\s)v(?:er)?\.?\s*(\d[\w.]*)$/i) || software.match(/^Firmware Version\s*(\S+)/i);
      if (/^(ver(sion)?\.?\s*)?\d[\w.]*$/i.test(software)) { firmware = firmware || software.replace(/^ver(sion)?\.?\s*/i, ''); software = ''; }
      else if (ver && (/firmware|digital camera/i.test(software) || (model && software.includes(model)))) { firmware = firmware || ver[1]; software = ''; }
    }
    const original = crs('RawFileName') || v(['PreservedFileName', 'OriginalFileName', 'RawFileName']);
    const shotDate = pick(it, ['DateTimeOriginal', 'SubSecDateTimeOriginal', 'CreateDate']);
    const modDate = v(['ModifyDate', 'MetadataDate'], { groups: ['IFD0', 'XMP-xmp', 'ExifIFD'] });
    const changed = modDate && (!shotDate || modDate.slice(0, 19) !== shotDate.val.slice(0, 19)) ? fmtDate(modDate) : '';
    // Lightroom notes "converted from image/x-canon-cr3 to image/jpeg"
    const conv = v('HistoryParameters').match(/converted from image\/(?:x-)?(?:[\w]+-)?([\w]+) to image\/(\w+)/i);
    use('HistoryAction', 'HistoryWhen', 'HistorySoftwareAgent', 'HistoryChanged', 'HistoryInstanceID', 'HistoryParameters', 'DocumentID', 'InstanceID', 'OriginalDocumentID', 'DerivedFromDocumentID',
      'DerivedFromInstanceID', 'DerivedFromOriginalDocumentID', 'MetadataDate', 'Format');
    const edited = !!(software || original || it.groups.has('XMP-crs'));
    card('edit', '後製', [
      R('軟體', software),
      R('原始檔', original),
      R('輸出時間', edited ? changed : ''),
      R('轉檔', conv ? `${conv[1].toUpperCase()} → ${conv[2].toUpperCase()}` : ''),
    ]);

    // ---- 手機
    if (phone) {
      const fl35 = num(it, 'FocalLength35efl', { groups: ['Composite'] }) || num(it, 'FocalLengthIn35mmFormat');
      const base = fl35 / Math.max(1, zoom || 1);
      const front = /front/i.test(val(it, 'LensModel')) || /front/i.test(val(it, 'CameraType'));
      const kind = front ? '前鏡頭（自拍）' : base > 0 ? (base < 20 ? '超廣角鏡頭' : base <= 36 ? '主鏡頭（廣角）' : '長焦鏡頭') : '';
      const frames = n('FrameCount');
      const merged = frames > 1 ? `HDR+ 合成 ${frames} 張` : /HDR/i.test(v('HDRImageType') + val(it, 'CustomRendered')) ? 'HDR 合成'
        : /composite/i.test(v('CompositeImage')) && !/not a/i.test(val(it, 'CompositeImage')) ? '有' : '';
      const gainMap = it.groups.has('XMP-hdrgm') || /GainMap/i.test(v('DirectoryItemSemantic')) || pick(it, 'GainMapImage') ? 'Ultra HDR'
        : it.groups.has('XMP-HDRGainMap') || num(it, 'HDRHeadroom') > 0 ? 'Apple HDR' : '';
      const live = pick(it, ['LivePhotoVideoIndex', 'ContentIdentifier']) ? '有' : '';
      const capture = { Portrait: '人像模式', ProRAW: 'ProRAW', 'Manual Focus': '手動對焦' }[v('ImageCaptureType')] || '';
      const appId = v('Application');
      const app = appId ? `${/GoogleCamera/i.test(appId) ? 'Google 相機' : appId} ${v('AppVersion').replace(/^(\d+\.\d+\.\d+).*/, '$1')}`.trim() : '';
      const android = (v('AndroidRelease').match(/:(\d+(?:\.\d+)?)\//) || [, ''])[1];
      use('CameraType', 'HDRImageType', 'GainMapImage', 'DirectoryItemMime', 'DirectoryItemLength', 'HasExtendedXMP', 'GFileMetadata', 'HDRPlusMakerNote', 'ImageData', 'TimeLogText',
        'SummaryText', 'HDRPSoftware', 'DeviceMake', 'DeviceModel', 'DeviceCodename', 'DeviceHardwareRevision', 'SoftwareDate', 'ImageName', 'HDRHeadroom', 'HDRGain',
        'HDRGainMapVersion', 'LivePhotoVideoIndex', 'ContentIdentifier', 'PhotoIdentifier', 'PhotosAppFeatureFlags', 'RunTimeFlags', 'RunTimeValue', 'RunTimeScale',
        'RunTimeEpoch', 'RunTimeSincePowerUp', 'AccelerationVector', 'AEStable', 'AETarget', 'AEAverage', 'SignalToNoiseRatio', 'SemanticStyle',
        'SemanticStyleRenderingVer', 'SemanticStylePreset', 'MakerNoteVersion', 'HostComputer', 'Version');
      card('phone', '手機拍攝', [
        R('鏡頭', kind),
        R('多張合成', merged, '手機一次拍好幾張再合成一張，暗部比較乾淨、亮部比較不會過曝'),
        R('HDR 顯示', gainMap, '照片裡多存了一張亮度圖，支援 HDR 的螢幕會把亮的地方顯示得更亮'),
        R('Live Photo', live),
        R('拍攝模式', capture),
        R('相機 App', app),
        R('系統', system || (android ? `Android ${android}` : '')),
      ]);
    }

    // ---- 機身
    const shots = n(['ShutterCount', 'ImageCount', 'ShutterCount3', 'ShutterCount2']);
    const mech = n('MechanicalShutterCount');
    const sonyCode = /sony/i.test(make) && SONY[val(it, 'Model')] ? val(it, 'Model') : '';
    const area = v(['ImageArea', 'CropHiSpeed']);
    const temp = (v(['CameraTemperature', 'SensorTemperature', 'BoardTemperature']).match(/^(-?[\d.]+)\s*C$/) || [, ''])[1];
    const ambient = (v('AmbientTemperature').match(/^(-?[\d.]+)\s*C$/) || [, ''])[1];
    const battery = [v('BatteryType'), v(['BatteryLevel', 'BatteryState'])].filter((x) => x && !/^(n\/a)$/i.test(x)).join('・');
    use('InternalSerialNumber', 'BatteryTemperature', 'APS-CSizeCapture', 'ModelReleaseYear', 'CameraE-mountVersion', 'LensE-mountVersion', 'ShotNumberSincePowerUp', 'ControlMode', 'PowerUpTime');
    card('body', '機身', [
      R('型號代號', sonyCode),
      R('感光元件', phone ? '' : sensorName(num(it, 'ScaleFactor35efl', { groups: ['Composite'] }))),
      R('拍攝範圍', /^DX/.test(area) ? 'DX 裁切（APS-C 大小）' : /on/i.test(val(it, 'APS-CSizeCapture')) ? 'APS-C 裁切' : ''),
      R('快門次數', Number.isFinite(shots) && shots > 0 ? `${shots.toLocaleString('zh-TW')} 次${Number.isFinite(mech) && mech > 0 && mech !== shots ? `（機械快門 ${mech.toLocaleString('zh-TW')} 次）` : ''}` : '', '相機拍過幾張，看二手相機常用'),
      R('機身序號', v('SerialNumber', { notGroups: ['XMP-aux'] }) || v('SerialNumber')),
      R('韌體', firmware),
      R('機身溫度', temp ? `${temp}°C${ambient ? `（環境 ${ambient}°C）` : ''}` : ''),
      R('電池', battery),
    ]);

    // ---- 時間與地點
    const d = dateParts(it);
    use('DateTimeOriginal', 'CreateDate', 'ModifyDate', 'SubSecTime', 'SubSecTimeOriginal', 'SubSecTimeDigitized', 'SubSecDateTimeOriginal', 'SubSecCreateDate', 'SubSecModifyDate',
      'OffsetTime', 'OffsetTimeOriginal', 'OffsetTimeDigitized', 'TimeZone', 'DateCreated', 'DateTimeCreated', 'DigitalCreationDateTime', 'DateTimeDigitized', 'SonyDateTime',
      'TimeStamp', 'DateDisplayFormat', 'TimeZoneOffset');
    const city = v('TimeZoneCity');
    const dst = v('DaylightSavings');
    const gps = gpsOf(it);
    const rows = [
      R('拍攝時間', d ? `${d.text}${d.tz ? `　${d.tz}` : ''}` : ''),
      R('相機時區設定', city && !/n\/a/i.test(city) ? `${trCity(city)}${/^(On|Yes)$/i.test(dst) ? '・夏令時間' : ''}` : ''),
      R('修改時間', edited ? '' : changed),
    ];
    if (gps) {
      const alt = n('GPSAltitude', { groups: ['Composite', 'GPS'] });
      const below = /Below/i.test(val(it, 'GPSAltitude')) || /Below/i.test(v('GPSAltitudeRef'));
      const dir = n('GPSImgDirection');
      const speed = n('GPSSpeed');
      const link = el('a', { class: 'map-link', href: `https://www.google.com/maps/search/?api=1&query=${gps.lat.toFixed(6)},${gps.lon.toFixed(6)}`, target: '_blank', rel: 'noopener noreferrer', text: '在 Google 地圖打開 ↗' });
      rows.push(
        R('座標', el('span', {}, `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}　`, link), '', `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`),
        R('海拔', Number.isFinite(alt) ? `${below ? '海平面下 ' : ''}${Math.round(Math.abs(alt)).toLocaleString('zh-TW')} m` : ''),
        R('拍攝方向', Number.isFinite(dir) ? `${Math.round(dir)}°（朝${DIRS[Math.round(((dir % 360) + 360) % 360 / 45) % 8]}）` : ''),
        R('移動速度', speed > 0.5 ? `${trim0(speed, 1)} ${/mph|miles/i.test(v('GPSSpeedRef')) ? 'mph' : /knots/i.test(val(it, 'GPSSpeedRef')) ? '節' : 'km/h'}` : ''),
      );
    }
    for (const name of it.idx.keys()) if (/^GPS/.test(name)) use(name);
    card('when', gps ? '時間與地點' : '時間', rows, gps ? { warn: '這張照片帶著拍攝地點，公開分享原檔前要留意', icon: 'place' } : {});

    // ---- Flickr: where it is, whose, may it be used
    const fk = it.fk;
    if (fk) {
      const out = (href, label) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label });
      const lic = fk.license;
      const cc = lic && /^(CC|公眾領域|沒有已知)/.test(lic.short);
      const orig = (fk.sizes || []).find((x) => x.s === 'o');
      const posted = fk.posted ? new Date(fk.posted * 1000) : null;
      const tags = (fk.tags || []).slice(0, 16);
      card('flickr', 'Flickr', [
        R('標題', out(fk.page, fk.title || '（沒有標題）'), '', fk.title),
        R('作者', fk.owner && fk.owner.name ? out(fk.owner.url, fk.owner.name) : '', '', fk.owner && fk.owner.name),
        R(fk.from ? { album: '相簿', gallery: '藝廊', group: '群組', faves: '最愛', stream: '相片串流' }[fk.from.kind] || '來自' : '相簿', fk.from && fk.from.title ? out(fk.from.link || fk.page, fk.from.title) : '', '', fk.from && fk.from.title),
        R('授權', lic ? (lic.url ? out(lic.url, lic.short) : lic.short) : '', cc ? '可以使用，但要照授權標註作者和出處（下面的「複製標註」）' : lic && lic.id === '0' ? '使用前要先取得作者同意' : '', lic && lic.short),
        R('上傳', posted ? `${posted.getFullYear()}/${posted.getMonth() + 1}/${posted.getDate()}` : ''),
        R('觀看', fk.views ? `${fk.views.toLocaleString('zh-TW')} 次` : ''),
        R('地點', fk.location ? fk.location.place || `${fk.location.lat.toFixed(4)}, ${fk.location.lon.toFixed(4)}` : '', '作者放在 Flickr 地圖上的位置'),
        C('標籤', tags.length ? { node: el('span', { class: 'chips' }, ...tags.map((t) => el('span', { class: 'chip', text: t }))), text: tags.join('・') } : null),
        R('說明', fk.description ? fk.description.slice(0, 300) + (fk.description.length > 300 ? '…' : '') : ''),
        R('連結', el('span', { class: 'fk-acts' },
          out(fk.page, '在 Flickr 打開 ↗'),
          el('button', { type: 'button', class: 'link-btn', onclick: () => copyCredit(it), text: '複製標註' }),
          orig ? out(orig.src, `原檔 ${orig.w.toLocaleString('zh-TW')} × ${orig.h.toLocaleString('zh-TW')} ↗`) : null), '', ''),
      ], { icon: 'flickr' });
    }

    // ---- 影像與檔案
    const type = v('FileType') || extOf(it.file.name);
    const size = v('ImageSize', { groups: ['Composite'] });
    let [iw, ih] = (size.match(/^(\d+)x(\d+)$/) || []).slice(1).map(Number);
    // Flickr: the original's size (when it's shown), else what the camera wrote
    if (fk && !iw) {
      const o = (fk.sizes || []).find((x) => x.s === 'o');
      const ew = n(['ExifImageWidth', 'ImageWidth']), eh = n(['ExifImageHeight', 'ImageHeight']);
      if (o) [iw, ih] = [o.w, o.h];
      else if (ew > 0 && eh > 0) [iw, ih] = [ew, eh];
    }
    const mp = n('Megapixels', { groups: ['Composite'] });
    const ratio = (() => {
      if (!(iw > 0 && ih > 0)) return '';
      const r = Math.max(iw, ih) / Math.min(iw, ih);
      const named = [[1, '1:1'], [1.25, '5:4'], [4 / 3, '4:3'], [1.5, '3:2'], [16 / 9, '16:9'], [2, '2:1'], [2.35, '2.35:1']].find(([x]) => Math.abs(r - x) < 0.015);
      const t = named ? named[1] : `${trim0(r, 2)}:1`;
      return iw < ih ? `${t.split(':').reverse().join(':')}（直的）` : t;
    })();
    const rawKind = it.raw ? [
      /craw/i.test(val(it, 'Quality')) ? 'C-RAW（壓縮）' : tw(v(['NEFCompression', 'RAFCompression']).replace(/^Lossless.*/i, 'Lossless')),
      /compressed/i.test(v('RAWFileType')) && !/uncompressed|lossless/i.test(val(it, 'RAWFileType')) ? '壓縮 RAW' : '',
      (() => { const b = num(it, 'BitsPerSample', { groups: ['FujiIFD', 'SubIFD', 'SubIFD1', 'SubIFD2', 'SubIFD3'] }) || parseInt(v('NEFBitDepth'), 10); return b >= 10 && b <= 16 ? `${b} bit` : ''; })(),
    ] : [(() => { const q = val(it, 'Quality', { groups: ['*maker'] }).trim(); return q && !/raw/i.test(q) ? `畫質 ${tw(q.charAt(0) + q.slice(1).toLowerCase())}` : ''; })()];
    use('FileTypeExtension', 'MIMEType', 'MajorBrand', 'CompatibleBrands', 'MinorVersion', 'ImageWidth', 'ImageHeight', 'ExifImageWidth', 'ExifImageHeight', 'Orientation', 'Rotation',
      'AutoRotate', 'CameraOrientation', 'Quality', 'Quality2', 'RecordMode', 'RawJpgSize', 'RawJpgQuality', 'RAWFileType', 'FileFormat', 'Compression', 'BitsPerSample', 'BitDepth',
      'EncodingProcess', 'ColorComponents', 'YCbCrSubSampling', 'SonyImageWidth', 'SonyImageHeight', 'SonyImageWidthMax', 'SonyImageHeightMax', 'FullImageSize', 'PreviewImageSize',
      'CanonImageSize', 'ImageSizeRAW', 'AspectRatio', 'RawImageAspectRatio', 'CroppedImageWidth', 'CroppedImageHeight', 'CroppedImageLeft', 'CroppedImageTop', 'RawImageCroppedSize',
      'RawImageFullSize', 'RawImageFullWidth', 'RawImageFullHeight', 'RawImageWidth', 'RawImageHeight', 'CompressedBitsPerPixel', 'XResolution', 'YResolution', 'ResolutionUnit',
      'YCbCrPositioning', 'ExifVersion', 'FlashpixVersion', 'ComponentsConfiguration', 'ExifByteOrder', 'InteropVersion', 'ImageUniqueID', 'SRAWQuality', 'MetaImageSize',
      'PrimaryItemReference', 'AvgBitrate', 'DirectoryNumber', 'FileNumber', 'FileIndex', 'FolderNumber', 'NumberOfImages', 'MemoryCardNumber');
    if (fk) card('file', '影像', [
      R('原始尺寸', iw ? `${iw.toLocaleString('zh-TW')} × ${ih.toLocaleString('zh-TW')}・${Math.round((iw * ih) / 1e4).toLocaleString('zh-TW')} 萬畫素` : ''),
      R('原始格式', fk.format ? fk.format.toUpperCase() : ''),
      R('長寬比', ratio),
      R('這裡顯示的', fk.shown ? `${fk.shown.w.toLocaleString('zh-TW')} × ${fk.shown.h.toLocaleString('zh-TW')}（Flickr 上的版本）` : '', '左邊的照片和色階分佈用的是這個版本；Flickr 重新壓縮過，跟原檔會有一點差別'),
    ]);
    else card('file', '影像與檔案', [
      R('檔案', `${it.file.name}・${fmtBytes(it.file.size)}`),
      R('格式', [`${type}${it.raw ? '（RAW 原始檔）' : ''}`, ...rawKind].filter(Boolean).join('・')),
      R('尺寸', iw ? `${iw.toLocaleString('zh-TW')} × ${ih.toLocaleString('zh-TW')}${mp >= 0.01 ? `・${Math.round(mp * 100).toLocaleString('zh-TW')} 萬畫素` : ''}` : ''),
      R('長寬比', ratio),
      R('方向', trOrient(v('Orientation', { groups: ['IFD0', 'ExifIFD', 'XMP-tiff', '*maker'] }))),
      R('內嵌預覽', it.raw && it.pv && it.pv.w ? `${it.pv.w.toLocaleString('zh-TW')} × ${it.pv.h.toLocaleString('zh-TW')} JPEG` : '', '左邊顯示的就是這張相機放在 RAW 檔裡的 JPEG，色階分佈也是用它算的'),
    ]);

    // ---- 作者與說明
    const rating = n('Rating');
    use('RatingPercent', 'Good');
    const desc = v(['ImageDescription', 'Description', 'Caption-Abstract', 'UserComment']).trim();
    const place = [v(['City', 'LocationShownCity']), v(['State', 'Province-State']), v(['Country', 'Country-PrimaryLocationName'])].filter(Boolean).join('・');
    card('author', '作者與說明', [
      R('作者', v(['Artist', 'Creator', 'By-line'])),
      R('擁有者', v('OwnerName')),
      R('版權', v(['Copyright', 'Rights', 'CopyrightNotice'])),
      R('標題', v(['Title', 'ObjectName', 'Headline'])),
      R('說明', /^(OLYMPUS DIGITAL CAMERA|SONY DSC|DCIM|default|Untitled|Picture)$/i.test(desc) ? '' : desc),
      R('關鍵字', v(['Keywords', 'Subject'])),
      R('評分', Number.isFinite(rating) && rating > 0 ? '★'.repeat(Math.min(5, Math.round(rating))) + '☆'.repeat(Math.max(0, 5 - Math.round(rating))) : ''),
      R('旗標', { 1: '已挑選', '-1': '已拒絕' }[n('Pick')] || ''),
      R('標籤', v('Label')),
      R('地點名稱', place),
    ]);

    const order = ['flickr', 'expo', 'focus', 'lens', 'color', 'grade', 'edit', 'phone', 'body', 'when', 'file', 'author'];
    cards.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return { cards, other: leftovers(it, used), total: Object.keys(it.tags).filter((k) => k.includes(':')).length };
  }

  // ---------- 其他技術資料: what no card used, once each ----------
  const ZH = {
    MacroMode: '微距模式', Quality: '畫質', RecordMode: '記錄格式', EasyMode: '拍攝模式', DigitalZoom: '數位變焦', FocusRange: '對焦範圍',
    FocalType: '鏡頭種類', CameraType: '相機類型', ControlMode: '控制方式', BracketMode: '包圍模式', LiveViewShooting: '即時取景拍攝',
    FlashExposureLock: '閃燈曝光鎖定', AntiFlicker: '防閃爍', InternalSerialNumber: '內部序號', ToneCurve: '色調曲線', AFConfigTool: '伺服 AF 情境',
    AFTrackingSensitivity: '追蹤靈敏度', AFAccelDecelTracking: '加速／減速追蹤', AFPointSwitching: '對焦點自動切換', AIServoFirstImage: '伺服 AF 第一張優先',
    AIServoSecondImage: '伺服 AF 第二張起優先', USMLensElectronicMF: '電子手動對焦', AFAssistBeam: '對焦輔助光', OneShotAFRelease: '單次對焦快門優先',
    AutoAFPointSelEOSiTRAF: 'iTR 自動對焦', LensDriveWhenAFImpossible: '無法對焦時鏡頭驅動', SelectAFAreaSelectionMode: '可選的對焦區域',
    AFAreaSelectionMethod: '對焦區域切換方式', OrientationLinkedAF: '直橫向分別對焦點', ManualAFPointSelPattern: '手選對焦點方式',
    AFPointDisplayDuringFocus: '對焦時顯示對焦點', VFDisplayIllumination: '觀景器顯示亮燈', AFStatusViewfinder: '觀景器對焦狀態',
    InitialAFPointInServo: '伺服 AF 起始對焦點', SubjectSwitching: '主體切換', ExposureLevelIncrements: '曝光級數', ISOSpeedIncrements: 'ISO 級數',
    AEBAutoCancel: '包圍曝光自動取消', AEBSequence: '包圍曝光順序', AEBShotCount: '包圍曝光張數', SafetyShift: '安全偏移', ShutterSpeedRange: '可用快門範圍',
    ApertureRange: '可用光圈範圍', SameExposureForNewAperture: '換鏡頭時維持曝光', AELockMeterModeAfterFocus: '對焦後鎖定曝光的測光模式',
    DialDirectionTvAv: '轉盤方向', ShutterReleaseWithoutLens: '沒裝鏡頭時可按快門', ControlRingRotation: '控制環方向', AddAspectRatioInfo: '加入長寬比資訊',
    DefaultEraseOption: '預設刪除選項', RetractLensOnPowerOff: '關機時收鏡', AddIPTCInformation: '加入 IPTC 資訊', AudioCompression: '聲音壓縮',
    MultiExposure: '多重曝光', MultiExposureControl: '多重曝光方式', MultiExposureShots: '多重曝光張數', AmbienceSelection: '氣氛選擇', DualPixelRaw: '雙像素 RAW',
    DustRemovalData: '除塵資料', CameraOrientation: '相機方向', SequenceNumber: '連拍序號', AFFineTune: 'AF 微調', ImageArea: '影像區域',
    Contrast: '對比', Saturation: '飽和度', Sharpness: '銳利度', ColorTone: '色調', WhiteBalance: '白平衡', ColorTemperature: '色溫', FilterEffect: '濾鏡效果',
    ToningEffect: '色調效果', ShootingMode: '拍攝模式', SceneMode: '場景模式', CreativeStyle: '創意風格', PictureEffect: '相片效果', SoftSkinEffect: '美肌效果',
    MultiFrameNoiseReduction: '多張降噪', ReleaseMode: '釋放模式', SelfTimer: '自拍', SelfTimerTime: '自拍秒數', IntervalShooting: '間隔拍攝',
    SilentPhotography: '靜音拍攝', FacesDetected: '偵測到人臉', FocusMode: '對焦模式', AFAreaMode: '對焦區域', MeteringMode: '測光模式',
    ExposureProgram: '曝光模式', FlashMode: '閃燈模式', ImageStabilization: '防手震', Software: '軟體', Artist: '作者', Copyright: '版權',
    OwnerName: '擁有者', SerialNumber: '序號', LensSerialNumber: '鏡頭序號', TimeZoneCity: '時區城市', DaylightSavings: '夏令時間',
    BatteryLevel: '電量', BatteryType: '電池型號', ShutterCount: '快門次數', ImageCount: '拍攝張數', CameraTemperature: '機身溫度',
    PictureStyle: '照片風格', PictureControlName: '優化校準', FilmMode: '底片模擬', DynamicRange: '動態範圍', DynamicRangeSetting: '動態範圍設定',
    HighlightTone: '亮部色調', ShadowTone: '陰影色調', NoiseReduction: '降噪', GrainEffectRoughness: '顆粒效果', ColorChromeEffect: '彩色效果',
    ColorChromeFXBlue: '彩色效果藍', Clarity: '清晰度', 'AF-SPriority': 'AF-S 優先', 'AF-CPriority': 'AF-C 優先', PreAF: '預先對焦',
    BlurWarning: '晃動警告', FocusWarning: '對焦警告', ExposureWarning: '曝光警告', ExposureCount: '曝光次數', ImageGeneration: '影像來源',
    FlickerReduction: '防閃爍', ShutterType: '快門類型', DriveMode: '驅動模式', AutoBracketing: '自動包圍', PictureMode: '拍攝模式',
    TimeZone: '時區', Rating: '評分', Title: '標題', Description: '說明', Keywords: '關鍵字', Creator: '作者', Rights: '版權',
  };
  // file structure, image data, calibration tables and repeats: never shown
  const NOISE_GROUP = /^(File|JFIF|ICC.*|IFD1|InteropIFD|MPF\d*|MPImage\d*|QuickTime|Track\d+|Meta|PrintIM|Composite|SubIFD\d*|FujiIFD|RAF|PanasonicRaw|Photoshop|Adobe|HEIF|ItemList|Keys|UserData|XMP-(x|xmpMM|crs|GContainer|hdrgm|HDRGainMap|GCamera|xmpNote|aux|tiff|exif|exifEX|photoshop|xmp|dc))$/;
  const NOISE_NAME = /Offset$|Offsets$|Length$|ByteCounts?$|Thumbnail|Preview|JpgFromRaw|OtherImage|Matrix|TRC$|^WB_|^ColorTemp[A-Z]|BlackLevel|WhiteLevel|Coefficient|Params|Version(ID)?$|ValidArea|DustRemoval|^VRDOffset|^Zoom(Source|Target)Width|^Sensor(Width|Height|\w*Border)$|^BlackMask|^Crop\w*Margin$|^Measured(RGGB|EV2?)$|LinearityUpperMargin|Layout$|SR2SubIFD|Metering(Image|Width|Height)|^(Red|Blue)Balance$|^CustomControls$|^RawImage|^Tiff|^Sony(Image|Date)|CanonImage(Width|Height)|^FileFormat$|^(WhitePoint|PrimaryChromaticities|Gamma|SubfileType|ReferenceBlackWhite|YCbCrCoefficients|ProcessingSoftware|PhotometricInterpretation|SamplesPerPixel|RowsPerStrip|PlanarConfiguration|CFAPattern2?|CFARepeatPatternDim|RawFormat|Crop(Top|Left|Bottom|Right)|NumWBEntries|DistortionScale|About|TimeSincePowerOn|CameraID|CompositeImage|CodedCharacterSet|ApplicationRecordVersion|TimeCreated|DigitalCreationDate|DigitalCreationTime|CurrentIPTCDigest|IPTCDigest)$|^(LinearityLimit|HighISOMultiplier|WBType|DistortionParam|Accelerometer)|^WB\w*Level$/;
  const NUMBERS = /^(-?\d+(\.\d+)?[ ,;]+){7,}/; // long lists of numbers: tables, not settings
  function leftovers(it, used) {
    const seen = new Set();
    const out = [];
    for (const [name, list] of it.idx) {
      if (used.has(name) || NOISE_NAME.test(name)) continue;
      const e = list.find((x) => !empty(x.val) && !NOISE_GROUP.test(x.g));
      // a zero or -1 is a feature not in use; a bracketed number is ExifTool not knowing a value's name
      // long runs of numbers and very long values are tables; n/a and undef are nothing
      if (!e || /^\(Binary data/.test(e.val) || NUMBERS.test(e.val) || e.val.length > 140 || /^(0|-1|n\/a\b.*|undef)$/i.test(e.val.trim())) continue;
      const label = ZH[name] || e.desc || name;
      const value = /^-?\d+\.\d{5,}$/.test(e.val) ? String(+(+e.val).toPrecision(4)) : tw(e.val.replace(/(, \[\d+\])+/g, ''));
      const key = `${label}|${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ g: e.g, name, label, en: ZH[name] ? e.desc || name : '', val: value, fam: familyOf(e.g) });
    }
    const fams = [...new Set(out.map((r) => r.fam))];
    return fams.flatMap((f) => out.filter((r) => r.fam === f));
  }
  function familyOf(g) {
    if (/^(IFD0|ExifIFD|GPS)$/.test(g)) return 'EXIF';
    if (/^XMP/.test(g)) return 'XMP';
    if (/^IPTC/.test(g)) return 'IPTC';
    const brand = g.replace(/(Custom|Settings|Info\d*|IFD)$/, '').replace(/^FujiFilm$/, 'Fujifilm');
    return /(Custom|Settings)$/.test(g) ? `${brand} 自訂功能` : `${brand} 原廠設定`;
  }

  // a camera's name for people: "Canon EOS R6", "Sony α7 IV"
  function camLabel(make, model) {
    if (/sony/i.test(make) && SONY[model]) model = SONY[model];
    model = model.replace(/^(NIKON|PENTAX|OLYMPUS|FUJIFILM|SAMSUNG|RICOH|LEICA|SIGMA|KODAK|CASIO|HASSELBLAD)\b/, (w) => w[0] + w.slice(1).toLowerCase());
    if (!model) return make;
    const clean = make.replace(/\b(CORPORATION|CORP\.?|IMAGING|COMPANY|CO\.?,?|LTD\.?|INC\.?|DIGITAL SOLUTIONS)\b|,/gi, '').replace(/\s+/g, ' ').trim()
      .replace(/\b([A-Z]{4,})\b/g, (w) => w[0] + w.slice(1).toLowerCase());
    // a model that names its own brand ("Canon EOS R6", "NIKON Z 6", "PENTAX K-70" from Ricoh) stands alone
    if (!clean || model.toLowerCase().includes(clean.toLowerCase().split(' ')[0]) || /^(canon|nikon|pentax|olympus|leica|hasselblad|sigma|kodak|ricoh|samsung|minolta|konica|casio|gopro|dji)\b/i.test(model)) return model;
    return `${clean} ${model}`;
  }
  // ---------- page ----------
  const ICONS = {
    expo: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
    focus: '<path d="M4 8.5V5a1 1 0 0 1 1-1h3.5M15.5 4H19a1 1 0 0 1 1 1v3.5M20 15.5V19a1 1 0 0 1-1 1h-3.5M8.5 20H5a1 1 0 0 1-1-1v-3.5"/><circle cx="12" cy="12" r="2.5"/>',
    lens: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    color: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.9-.8 1.9-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7.3" r="1.2"/><circle cx="15.2" cy="7.8" r="1.2"/>',
    grade: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    edit: '<path d="M15.5 4.5l4 4L9 19H5v-4z"/><path d="M13.5 6.5l4 4"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    body: '<path d="M14.5 4h-5L7.5 6.5H5A2 2 0 0 0 3 8.5v9A2 2 0 0 0 5 19.5h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2.5z"/><circle cx="12" cy="13" r="3.5"/>',
    when: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    place: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    file: '<path d="M14 3H6.5A2 2 0 0 0 4.5 5v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5z"/><path d="M14 3v5.5h5.5"/>',
    author: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c1.4-3.8 4.2-5.8 7.5-5.8s6.1 2 7.5 5.8"/>',
    flickr: '<circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/>',
    more: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  };
  const icon = (id) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, x] of Object.entries({ viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, x);
    s.innerHTML = ICONS[id] || '';
    return s;
  };
  let moreOpen = false;

  function renderInfo() {
    const it = cur();
    if (!it) return;
    const busy = (title, sub) => {
      fill($('#camName'), ...title);
      fill($('#camLens'), sub);
      fill($('#expo'));
      fill($('#sheet'));
      $('#copyLine').disabled = true;
      $('#saveAll').disabled = true;
    };
    if (!it.done) { busy([el('span', { class: 'spinner' }), it.fk ? ' 正在向 Flickr 查詢…' : ' 讀取中…'], it.fk ? nameOf(it) : engine.state === 'ready' ? it.file.name : $('#engine').textContent.trim()); return; }
    if (!it.ok) { busy([it.fk ? 'Flickr 讀不到這張照片' : '讀不到這個檔案'], it.fk ? fkMsg(it.error) : engine.state === 'error' ? '解析程式沒有載入成功，請重新整理頁面再試一次' : '檔案可能壞了，或不是照片'); return; }
    const noCamera = !val(it, ['Make', 'Model']) && !val(it, ['ExposureTime', 'FNumber']);
    $('#camName').textContent = noCamera ? (it.fk && it.fk.exifHidden ? '作者沒有公開拍攝參數' : '沒有相機資訊') : cameraName(it) || '不知道是哪台相機';
    $('#camLens').textContent = noCamera ? (it.fk ? (it.fk.exifHidden ? '這張照片的作者在 Flickr 設定不公開 EXIF，只看得到照片和 Flickr 上的資訊。'
      : 'Flickr 上這張照片沒有拍攝參數：上傳的檔案本身就沒有，例如截圖，或輸出時拿掉了。')
      : `拍攝資料被拿掉了：截圖、修圖 App 輸出、傳過通訊軟體或社群網站的照片常常這樣。要看參數，請用相機或手機裡的原始檔。${IOS ? ' iPhone 從「照片」選的時候，請選「實際大小」，縮小過的參數會不見。' : ''}`)
      : lensName(it) || (/mm$/.test(val(it, 'Lens', { groups: ['Composite'] })) ? `鏡頭 ${metres(val(it, 'Lens', { groups: ['Composite'] }))}` : '鏡頭沒有記錄');
    $('#copyLine').disabled = noCamera;
    $('#saveAll').disabled = false;
    fill($('#expo'), ...(noCamera ? [] : expoCells(it).map((c) => el('li', { class: c.v ? '' : 'none' },
      el('span', { class: 'ex-k', text: c.k }),
      el('span', { class: 'ex-v' }, c.v || '—', c.v && c.u ? el('small', { text: ` ${c.u}` }) : null),
      el('span', { class: 'ex-s', text: c.s || '' })))));
    renderSheet(it);
  }

  function renderSheet(it) {
    if (!it || !it.ok) return;
    const s = it.sheet || (it.sheet = buildSheet(it));
    const raw = $('#search').value.trim();
    const q = raw.toLowerCase();
    const hit = (...parts) => !q || parts.join(' ').toLowerCase().includes(q);
    const cards = s.cards.map((c) => {
      const rows = hit(c.title) ? c.rows : c.rows.filter((r) => hit(r.k, r.text));
      if (!rows.length) return null;
      return el('section', { class: `card c-${c.id}` },
        el('h3', {}, icon(c.icon || c.id), el('span', { text: c.title }), c.sub ? el('small', { text: c.sub }) : null),
        c.warn ? el('p', { class: 'warn', text: c.warn }) : null,
        el('dl', {}, ...rows.flatMap((r) => [
          el('dt', {}, r.k, r.hint ? el('button', { type: 'button', class: 'q', 'aria-label': `${r.k}：${r.hint}`, title: r.hint, text: '?', onclick: () => toast(`${r.k}：${r.hint}`, 5000) }) : null),
          el('dd', {}, r.v)])));
    }).filter(Boolean);
    const other = s.other.filter((r) => hit(r.label, r.en, r.name, r.val, r.fam));
    const open = moreOpen || (q && other.length > 0);
    let more = null;
    if (other.length) {
      const fams = [...new Set(other.map((r) => r.fam))];
      more = el('section', { class: `more${open ? ' open' : ''}` },
        el('button', { type: 'button', class: 'more-head', 'aria-expanded': String(!!open), onclick: () => { moreOpen = !open; renderSheet(cur()); if (moreOpen) $('.more').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } },
          icon('more'), el('b', { text: '其他技術資料' }), el('span', { class: 'cnt', text: `${other.length} 項` }),
          el('small', { text: q ? '' : `相機原廠的細部設定和自訂功能。整份檔案有 ${s.total} 項，重複的都已經合併` }),
          el('span', { class: 'chev', 'aria-hidden': 'true' })),
        open ? el('div', { class: 'more-body' }, ...fams.map((f) => el('div', { class: 'mgrp' },
          el('h4', { text: f }),
          ...other.filter((r) => r.fam === f).map((r) => el('div', { class: 'kv', title: `${r.en ? `${r.en}・` : ''}${r.g}:${r.name}` },
            el('span', { class: 'kv-k', text: r.label }), el('span', { class: 'kv-v', text: r.val })))))) : null);
    }
    // meta.js reads the standard parts; a camera maker's own notes need ExifTool (not in Safari)
    const notes = [];
    if (!q && it.fk && it.fk.exif && it.fk.exif.length) notes.push('參數是 Flickr 從作者上傳的原檔讀出來的；相機原廠的細部資料 Flickr 只留一部分。');
    if (!q && it.reader === 'js' && !isPhone(it) && (it.raw || val(it, 'Make'))) notes.push('Safari 只讀得到標準的 EXIF、GPS 和 XMP；相機原廠的細部資料（快門次數、對焦設定、機身溫度等）請用 Chrome、Edge 或 Firefox 開這個網頁。');
    // iOS gives a web page a JPEG it makes from the photo in 照片 (a HEIC never arrives as itself), minus the location
    if (!q && IOS && !it.fk && !it.raw && /\.jpe?g$/i.test(it.file.name) && (/apple/i.test(val(it, 'Make')) || /^image\.jpe?g$/i.test(it.file.name))) notes.push('從「照片」選進來的照片，iPhone 會先轉成 JPG 再交給網頁（HEIC 原檔不會直接送進來）：拍攝參數大多還在，但位置會被拿掉，Live Photo、Apple HDR 這些也看不到。想看原檔：選照片時點「選擇檔案」，從「檔案」App 裡挑（先在「照片」用分享 → 儲存到檔案），或傳到電腦再看。');
    fill($('#sheet'),
      cards.length ? el('div', { class: 'cards' }, ...cards) : null,
      ...notes.map((t) => el('p', { class: 'reader-note', text: t })),
      more,
      !cards.length && !other.length ? el('p', { class: 'nothing', text: q ? `找不到「${raw}」` : '這個檔案裡沒有資訊' }) : null);
  }

  let searchTimer;
  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { renderSheet(cur()); $('#sheet').scrollTop = 0; }, 90); });

  $('#copyLine').addEventListener('click', async () => {
    const it = cur();
    if (!it || !it.ok) return;
    const text = copyLine(it);
    try { await navigator.clipboard.writeText(text); toast(`已複製：${text}`); } catch { toast(`沒辦法自動複製，請手動選取：${text}`, 9000); }
  });
  $('#saveAll').addEventListener('click', () => {
    const it = cur();
    if (!it || !it.ok) return;
    const s = it.sheet || (it.sheet = buildSheet(it));
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
    const lines = [['分類', '項目', '內容', 'ExifTool 標籤'].map(q).join(',')];
    const c = expoCells(it);
    for (const x of c) if (x.v) lines.push(['拍攝參數', x.k, `${x.v}${x.u ? ` ${x.u}` : ''}`, ''].map(q).join(','));
    for (const cd of s.cards) for (const r of cd.rows) lines.push([cd.title, r.k, r.text, ''].map(q).join(','));
    for (const r of s.other) lines.push([`其他・${r.fam}`, r.label, r.val, `${r.g}:${r.name}`].map(q).join(','));
    // the BOM lets Excel read it as UTF-8
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${(it.fk ? nameOf(it) : it.file.name.replace(/\.[^.]+$/, '')).replace(/[\\/:*?"<>|]+/g, '_')}_參數.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  // ---------- the picture ----------
  // Each photo is decoded once at screen size (a phone keeps a few MB, not the ~100 MB a 24-megapixel photo takes
  // at full size), the last few kept; only the one being zoomed into is decoded at full size, and let go after.
  const views = new Map(); // id → { img, ow, oh }: picture at screen size, size it was decoded from
  let fullRes = null; // { id, img } the one zoomed into
  const sizeOf = (img) => [img.naturalWidth || img.width, img.naturalHeight || img.height];
  const release = (img) => { if (!img) return; if (img.close) img.close(); else if (img.getContext) { img.width = 0; img.height = 0; } };
  function orientOf(it) {
    if (!it.pv || it.pv.orient) return 1; // a file the browser shows itself, or a preview with its own EXIF: the browser turns it
    const o = num(it, 'Orientation', { groups: ['IFD0', '*maker', 'XMP-tiff'] });
    return o >= 1 && o <= 8 ? o : 1;
  }
  const blobOf = (it) => (it.pv ? it.file.slice(it.pv.start, it.pv.end, 'image/jpeg') : it.file);
  // decode, then shrink right away to maxSide (the big one goes); returns { img, ow, oh }
  // Safari never gives back the memory of a full-size createImageBitmap (~100 MB a 24-megapixel photo, every time):
  // there an <img> decodes, is drawn once into a canvas of the size needed, and let go
  const viaImg = async (blob) => {
    const url = URL.createObjectURL(blob);
    try { const im = new Image(); im.decoding = 'async'; im.src = url; await im.decode(); return im; } catch { return null; } finally { URL.revokeObjectURL(url); }
  };
  async function decodeBlob(blob, maxSide) {
    let img = null;
    if (WEBKIT) img = await viaImg(blob);
    else {
      try { img = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { img = await viaImg(blob); }
    }
    if (!img) return null;
    const [ow, oh] = sizeOf(img);
    if (WEBKIT && img instanceof HTMLImageElement) {
      const k = maxSide ? Math.min(1, maxSide / Math.max(ow, oh)) : 1;
      const c = canvas(Math.max(1, Math.round(ow * k)), Math.max(1, Math.round(oh * k)));
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, c.width, c.height);
      img.src = '';
      return { img: c, ow, oh };
    }
    if (!maxSide || Math.max(ow, oh) <= maxSide) return { img, ow, oh };
    const k = maxSide / Math.max(ow, oh), w = Math.max(1, Math.round(ow * k)), h = Math.max(1, Math.round(oh * k));
    let small = null;
    try {
      small = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      if (small.width !== w) { small.close(); small = null; }
    } catch { small = null; }
    if (!small) {
      small = canvas(w, h);
      const c = small.getContext('2d');
      c.imageSmoothingQuality = 'high';
      c.drawImage(img, 0, 0, w, h);
    }
    release(img);
    return { img: small, ow, oh };
  }
  async function viewOf(it) {
    if (views.has(it.id)) { const v = views.get(it.id); views.delete(it.id); views.set(it.id, v); return v; }
    const v = await decodeBlob(blobOf(it), SCREEN);
    if (!v) return null;
    views.set(it.id, v);
    while (views.size > (SMALL_DEVICE ? 2 : 4)) {
      const [id, old] = views.entries().next().value;
      if (id === (cur() && cur().id)) break;
      release(old.img);
      views.delete(id);
    }
    return v;
  }
  function drawOriented(ctx, img, o, w, h) {
    ctx.save();
    switch (o) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, w, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, w, h); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, h); break;
      default:
    }
    const swap = o >= 5;
    ctx.drawImage(img, 0, 0, swap ? h : w, swap ? w : h);
    ctx.restore();
  }
  const oriented = (w, h, o) => (o >= 5 ? [h, w] : [w, h]);

  async function prepareImage(it) {
    const v = await viewOf(it);
    if (!v) { it.noPicture = true; return; }
    it.noPicture = false;
    const o = orientOf(it);
    const [w, h] = oriented(...sizeOf(v.img), o);
    const k = Math.min(1, 400 / Math.max(w, h));
    const small = canvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
    drawOriented(small.getContext('2d'), v.img, o, small.width, small.height);
    it.hist = histogram(small);
    if (!it.thumb) {
      const t = Math.min(1, 132 / Math.max(w, h));
      const th = canvas(Math.max(1, Math.round(w * t)), Math.max(1, Math.round(h * t)));
      th.getContext('2d').drawImage(small, 0, 0, th.width, th.height);
      setThumb(it, th.toDataURL('image/jpeg', 0.8));
      release(th);
    }
    release(small);
  }

  // ---------- the loupe: fit; a click goes to 100 % right there (like Lightroom), drag moves, wheel or pinch zooms ----------
  // One for the stage, one for the full-screen view; the same photo, its own zoom.
  function makeLoupe(box, cv, bar) {
    const L = { it: null, v: null, o: 1, iw: 0, ih: 0, zoomed: false, s: 0, cx: 0, cy: 0, ox: 0, oy: 0, fitS: 1, pad: 8 };
    const ctx = cv.getContext('2d');
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    L.set = (it, v) => {
      if (L.it !== it) { L.zoomed = false; dropFull(); }
      L.it = it; L.v = v;
      if (v) { L.o = orientOf(it); [L.iw, L.ih] = oriented(v.ow, v.oh, L.o); }
      L.paint();
    };
    L.max = () => 4 / DPR(); // 400 %
    L.paint = () => {
      const W = box.clientWidth, H = box.clientHeight, D = DPR();
      if (!W || !H) return;
      if (cv.width !== Math.round(W * D) || cv.height !== Math.round(H * D)) { cv.width = Math.round(W * D); cv.height = Math.round(H * D); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      box.classList.toggle('zoomed', L.zoomed);
      if (!L.v) { showZoom(); return; }
      L.fitS = Math.min((W - 2 * L.pad) / L.iw, (H - 2 * L.pad) / L.ih, 2);
      const s = L.zoomed ? L.s : L.fitS;
      const dw = L.iw * s, dh = L.ih * s;
      L.ox = dw <= W ? (W - dw) / 2 : clamp(W / 2 - L.cx * s, W - dw, 0);
      L.oy = dh <= H ? (H - dh) / 2 : clamp(H / 2 - L.cy * s, H - dh, 0);
      if (L.zoomed) { L.cx = (W / 2 - L.ox) / s; L.cy = (H / 2 - L.oy) / s; }
      // more pixels than the screen-size picture has: the full one (decoded once, on demand)
      const need = s * D * Math.max(L.iw, L.ih) > Math.max(...sizeOf(L.v.img)) * 1.05;
      const hi = need && fullRes && fullRes.id === L.it.id ? fullRes.img : null;
      if (need && !hi) loadFull(L.it);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.save();
      ctx.translate(Math.round(L.ox * D), Math.round(L.oy * D));
      if (!L.zoomed) { ctx.shadowColor = 'rgba(0, 0, 0, .38)'; ctx.shadowBlur = 22 * D; ctx.shadowOffsetY = 5 * D; }
      drawOriented(ctx, hi || L.v.img, L.o, Math.round(dw * D), Math.round(dh * D));
      ctx.restore();
      showZoom();
    };
    // percent of the picture's own pixels, one to one with the screen's
    L.percent = () => Math.round((L.zoomed ? L.s : L.fitS) * DPR() * 100);
    function showZoom() {
      if (!bar) return;
      const on = !!L.v;
      bar.hidden = !on;
      if (!on) return;
      const hint = $('.z-hint', bar);
      if (hint) hint.hidden = L.zoomed || zoomHinted;
      $('.z-pct', bar).textContent = L.zoomed && Math.abs(L.percent() - 100) >= 1 ? `${L.percent()}%` : ''; // 100 %: the button says it
      $('.z-fit', bar).classList.toggle('on', !L.zoomed);
      $('.z-100', bar).classList.toggle('on', L.zoomed && Math.abs(L.percent() - 100) < 1);
    }
    // zoom to scale s keeping the picture point under (x, y) — box coordinates — where it is
    L.zoomAt = (s, x = box.clientWidth / 2, y = box.clientHeight / 2) => {
      if (!L.v) return;
      const cs = L.zoomed ? L.s : L.fitS;
      const px = (x - L.ox) / cs, py = (y - L.oy) / cs;
      const ns = clamp(s, L.fitS, Math.max(L.fitS, L.max()));
      if (ns <= L.fitS * 1.001) { L.zoomed = false; dropFull(); L.paint(); return; }
      L.zoomed = true;
      L.s = ns;
      if (!zoomHinted) { zoomHinted = true; try { localStorage.setItem('exif-zoomed', '1'); } catch {} }
      L.cx = px - (x - box.clientWidth / 2) / ns;
      L.cy = py - (y - box.clientHeight / 2) / ns;
      L.paint();
    };
    // a click: fit ↔ 100 % (a picture smaller than the screen: twice its fit)
    L.toggle = (x, y) => {
      if (L.zoomed) L.zoomAt(0);
      else L.zoomAt(Math.max(1 / DPR(), L.fitS * 2), x, y);
    };
    L.fit = () => { if (L.zoomed) L.zoomAt(0); };
    const pts = new Map();
    let down = null, pinch = null, lastTap = 0;
    const local = (e) => { const r = box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    box.addEventListener('pointerdown', (e) => {
      if (!L.v || e.button > 0) return;
      try { box.setPointerCapture(e.pointerId); } catch {}
      pts.set(e.pointerId, local(e));
      if (pts.size === 1) down = { p: local(e), cx: L.cx, cy: L.cy, moved: false, type: e.pointerType };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s: L.zoomed ? L.s : L.fitS };
        down = null;
      }
    });
    box.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, local(e));
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        L.zoomAt(pinch.s * (d / pinch.d), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        e.preventDefault();
        return;
      }
      if (!down) return;
      const [x, y] = local(e);
      const dx = x - down.p[0], dy = y - down.p[1];
      if (Math.abs(dx) + Math.abs(dy) > 5) down.moved = true;
      if (L.zoomed && down.moved) {
        L.cx = down.cx - dx / L.s;
        L.cy = down.cy - dy / L.s;
        if (!L.raf) L.raf = requestAnimationFrame(() => { L.raf = 0; L.paint(); });
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) pinch = null; return; }
      const d = down;
      down = null;
      if (!d || e.type !== 'pointerup') return;
      const [x, y] = local(e);
      // a sideways swipe on a picture that fits: the next or previous photo (full screen, touch)
      if (d.moved && !L.zoomed && d.type !== 'mouse' && L.swipe && Math.abs(x - d.p[0]) > 50 && Math.abs(x - d.p[0]) > Math.abs(y - d.p[1]) * 1.5) { L.swipe(x < d.p[0] ? 1 : -1); return; }
      if (d.moved) return;
      if (d.type === 'mouse') { L.toggle(x, y); return; }
      if (L.tap) { L.tap(); return; } // the stage on a phone: open the full-screen view
      if (Date.now() - lastTap < 320) { lastTap = 0; L.toggle(x, y); } else lastTap = Date.now();
    };
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    box.addEventListener('wheel', (e) => {
      if (!L.v) return;
      e.preventDefault();
      const [x, y] = local(e);
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018));
      L.zoomAt((L.zoomed ? L.s : L.fitS) * k, x, y);
    }, { passive: false });
    if (bar) {
      $('.z-fit', bar).addEventListener('click', () => L.fit());
      $('.z-100', bar).addEventListener('click', () => L.zoomAt(1 / DPR()));
    }
    return L;
  }
  // "點一下放大到 100%" on the picture until the first zoom, ever
  let zoomHinted = false;
  try { zoomHinted = !!localStorage.getItem('exif-zoomed'); } catch {}
  let fullLoading = 0;
  async function loadFull(it) {
    if (fullLoading === it.id) return;
    fullLoading = it.id;
    const f = await decodeBlob(it.fk ? await bigOf(it) : blobOf(it), FULL_MAX);
    fullLoading = 0;
    if (!f) return;
    // still wanted?
    const on = [stageLoupe, fullLoupe].some((L) => L.it === it && L.zoomed);
    if (!on) { release(f.img); return; }
    dropFull();
    fullRes = { id: it.id, img: f.img };
    stageLoupe.paint();
    if (!$('#full').hidden) fullLoupe.paint();
  }
  function dropFull() {
    if (!fullRes) return;
    if ([stageLoupe, fullLoupe].some((L) => L && L.it && L.it.id === fullRes.id && L.zoomed)) return;
    release(fullRes.img);
    fullRes = null;
  }
  const stageLoupe = makeLoupe($('#stage'), $('#photo'), $('#zoomBar'));
  const fullLoupe = makeLoupe($('#fullBox'), $('#fullCanvas'), $('#fullBar'));
  // a phone: the stage is small, a tap opens the photo full screen (pinch and double-tap zoom there)
  stageLoupe.tap = () => openFull();
  fullLoupe.swipe = (dir) => { select(current + dir); showFull(); };
  function loupeReset() { stageLoupe.zoomed = false; fullLoupe.zoomed = false; dropFull(); }

  let drawSeq = 0;
  async function drawStage() {
    const it = cur();
    const msg = $('#stageMsg');
    const my = ++drawSeq;
    if (!it || !it.done) {
      stageLoupe.set(it, null);
      fill(msg, el('span', { class: 'spinner' }), ' 讀取中…');
      msg.hidden = false;
      drawHist(null);
      return;
    }
    if (it.noPicture || !it.hist) {
      stageLoupe.set(it, null);
      msg.hidden = false;
      const heic = /\.(heic|heif|hif)$/i.test(it.file.name), tiff = /\.tiff?$/i.test(it.file.name);
      fill(msg, el('b', { text: it.kind === 'xmp' ? '這是 Lightroom 的 .xmp 檔' : '這裡沒辦法顯示這張照片' }), el('span', {
        text: it.kind === 'xmp' ? '裡面只有調色設定和拍攝資料，沒有影像。把它的 RAW 檔一起放進來就看得到照片。'
          : it.fk ? '從 Flickr 下載照片沒有成功。參數不受影響。'
          : heic ? '這個瀏覽器看不懂 HEIC，用 Safari 就看得到。參數不受影響。'
            : tiff ? '這個瀏覽器看不懂 TIFF，用 Safari 就看得到。參數不受影響。'
              : it.raw ? '這個 RAW 檔裡沒有放預覽圖。參數不受影響。' : '參數還是看得到。',
      }));
      drawHist(null);
      return;
    }
    msg.hidden = true;
    const v = await viewOf(it);
    if (my !== drawSeq) return;
    stageLoupe.set(it, v);
    drawHist(it.hist);
    if (!$('#full').hidden) showFull();
  }

  // ---------- full screen ----------
  function openFull() {
    const it = cur();
    if (!it || !it.done || it.noPicture) return;
    $('#full').hidden = false;
    document.documentElement.classList.add('full-open');
    showFull();
  }
  async function showFull() {
    const it = cur();
    if ($('#full').hidden || !it) return;
    $('#fullName').textContent = `${nameOf(it)}　${current + 1} / ${items.length}`;
    $('#fullPrev').disabled = current <= 0;
    $('#fullNext').disabled = current >= items.length - 1;
    if (!it.done || it.noPicture) { fullLoupe.set(it, null); return; }
    const v = await viewOf(it);
    if (it === cur()) fullLoupe.set(it, v);
  }
  function closeFull() {
    $('#full').hidden = true;
    document.documentElement.classList.remove('full-open');
    fullLoupe.set(null, null);
    dropFull();
  }
  $('#zFull').addEventListener('click', openFull);
  $('#fullClose').addEventListener('click', closeFull);
  $('#fullPrev').addEventListener('click', () => { select(current - 1); showFull(); });
  $('#fullNext').addEventListener('click', () => { select(current + 1); showFull(); });

  function histogram(cv) {
    const { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256);
    let lo = 0, hi = 0;
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i], G = data[i + 1], B = data[i + 2];
      r[R]++; g[G]++; b[B]++;
      if (R <= 2 && G <= 2 && B <= 2) lo++;
      if (R >= 254 || G >= 254 || B >= 254) hi++;
    }
    const n = data.length / 4;
    return { r, g, b, lo: lo / n, hi: hi / n };
  }

  function drawHist(h) {
    const c = $('#histo');
    const box = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(box.width * dpr)); c.height = Math.max(1, Math.round(box.height * dpr));
    const ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    // quarters: shadows, midtones, highlights
    ctx.fillStyle = 'rgba(255, 255, 255, .08)';
    for (let q = 1; q < 4; q++) ctx.fillRect(Math.round((q / 4) * W), 0, dpr, H);
    const pct = (x) => (x >= 0.1 ? `${x >= 10 ? Math.round(x) : x.toFixed(1)}%` : '');
    $('#clipLo').textContent = h && pct(h.lo * 100) ? `全黑 ${pct(h.lo * 100)}` : '';
    $('#clipHi').textContent = h && pct(h.hi * 100) ? `過曝 ${pct(h.hi * 100)}` : '';
    if (!h) return;
    // a little smoothing (a 400 px picture gives a ragged curve), then the tallest bar away from the two ends sets
    // the scale, so a clipped end doesn't flatten the rest
    const smooth = (ch) => Array.from({ length: 256 }, (_, i) => (ch[Math.max(0, i - 1)] + 2 * ch[i] + ch[Math.min(255, i + 1)]) / 4);
    const chans = [[smooth(h.r), [255, 70, 70]], [smooth(h.g), [60, 225, 110]], [smooth(h.b), [70, 140, 255]]];
    let max = 1;
    for (const [ch] of chans) for (let i = 2; i < 254; i++) max = Math.max(max, ch[i]);
    const y = (x) => H - Math.min(1, x / max) * (H - 3 * dpr);
    const path = (ch) => { ctx.beginPath(); ctx.moveTo(0, H); for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, y(ch[i])); ctx.lineTo(W, H); ctx.closePath(); };
    // light adds up: where all three overlap it's white, two make yellow, cyan or magenta (like Lightroom's, brighter)
    ctx.globalCompositeOperation = 'lighter';
    for (const [ch, [r, g, b]] of chans) {
      path(ch);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, .78)`;
      ctx.fill();
    }
    ctx.lineWidth = dpr;
    for (const [ch, [r, g, b]] of chans) {
      ctx.beginPath();
      for (let i = 0; i < 256; i++) ctx[i ? 'lineTo' : 'moveTo']((i / 255) * W, y(ch[i]));
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, .9)`;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function renderThumbs() {
    if (renderThumbs.t) return;
    // many photos arrive at once: draw the strip once per frame at most
    renderThumbs.t = requestAnimationFrame(() => {
      renderThumbs.t = 0;
      const ul = $('#thumbs');
      fill(ul, ...items.map((it, i) => el('li', {},
        el('button', {
          type: 'button', class: `thumb${i === current ? ' on' : ''}${it.done && !it.ok ? ' bad' : ''}`, title: nameOf(it),
          'aria-label': nameOf(it), 'aria-current': i === current ? 'true' : null, onclick: () => select(i),
        },
        it.thumb ? el('img', { src: it.thumb, alt: '', loading: 'lazy' }) : el('span', { class: 'th-ext', text: it.kind === 'xmp' ? 'XMP' : extOf(it.file.name) }),
        it.busy ? el('span', { class: 'th-busy' }, el('span', { class: 'spinner' })) : null),
        // the one on screen can be taken out (not out of a Flickr album: that's the album)
        i === current && !it.coll ? el('button', { type: 'button', class: 'th-x', title: '移除這張', 'aria-label': `移除 ${nameOf(it)}`, onclick: () => removeItem(it) }, '×') : null)));
      $('.strip').classList.toggle('one', items.length < 2);
      // keep the chosen one in view by scrolling the strip only (scrollIntoView would also move the page on a phone)
      const on = ul.querySelector('.on');
      if (on) {
        if (on.offsetLeft < ul.scrollLeft) ul.scrollLeft = on.offsetLeft - 6;
        else if (on.offsetLeft + on.offsetWidth > ul.scrollLeft + ul.clientWidth) ul.scrollLeft = on.offsetLeft + on.offsetWidth - ul.clientWidth + 6;
      }
    });
  }
  function setThumb(it, url) {
    if (it.thumb && it.thumb.startsWith('blob:')) URL.revokeObjectURL(it.thumb);
    it.thumb = url;
  }

  // ---------- the strip's thumbnails for the photos not opened yet: one at a time, nearest first, after the reading ----------
  // From the little JPEG a camera keeps in the EXIF (no decoding the photo), a RAW file's preview, or else the
  // picture made small (not on a phone: a full-size decode each is too much there). A Flickr photo has Flickr's.
  let thumbing = false;
  async function pumpThumbs() {
    if (thumbing) return;
    thumbing = true;
    try {
      for (;;) {
        const todo = items.filter((it) => !it.fk && !it.thumb && !it.thumbTried && !it.busy && it.kind !== 'xmp');
        if (!todo.length) break;
        if (running) { await new Promise((r) => setTimeout(r, 250)); continue; } // the photo being read goes first
        const at = (it) => Math.abs(items.indexOf(it) - current);
        const it = todo.reduce((a, b) => (at(b) < at(a) ? b : a));
        it.thumbTried = true;
        const url = await smallOf(it);
        if (url && items.includes(it) && !it.thumb) { setThumb(it, url); renderThumbs(); }
        await new Promise((r) => setTimeout(r, 16));
      }
    } finally { thumbing = false; }
  }
  async function smallOf(it) {
    try {
      const r = await ZMeta.read(it.file, { head: it.raw ? 2 << 20 : 262144, preview: it.raw });
      const turn = r && r.tags['IFD0:Orientation'] ? +(r.tags['IFD0:Orientation'].num ?? r.tags['IFD0:Orientation'].val) || 1 : 1;
      let blob = null, o = 1;
      if (r && r.thumb) { blob = it.file.slice(r.thumb.start, r.thumb.end, 'image/jpeg'); o = turn; }
      else if (r && r.preview) { blob = it.file.slice(r.preview.start, r.preview.end, 'image/jpeg'); o = r.preview.orient ? 1 : turn; }
      else if (!it.raw && SHOWABLE.test(it.file.name) && (!SMALL_DEVICE || it.file.size < 4e6)) blob = it.file;
      if (!blob) return null;
      const v = await decodeBlob(blob, 264);
      if (!v) return null;
      const [w, h] = oriented(...sizeOf(v.img), o >= 1 && o <= 8 ? o : 1);
      const k = Math.min(1, 132 / Math.max(w, h));
      const c = canvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      drawOriented(x, v.img, o >= 1 && o <= 8 ? o : 1, c.width, c.height);
      release(v.img);
      const url = c.toDataURL('image/jpeg', 0.8);
      release(c);
      return url;
    } catch { return null; }
  }

  // ---------- Flickr ----------
  // A link to a photo, an album, someone's albums or galleries, a gallery, a photostream, favourites, a group's pool
  // or a collection; assets/flickr.js asks Flickr from here (the link never goes to this site's server). A photo is
  // an item like a file: its EXIF as Flickr read it from the original at upload, its picture Flickr's size that fits
  // the screen (the biggest one for 100 %). A list
  // opens as a grid first (#browse); someone's albums or galleries as covers. Up top, where you are: 月太 的藝廊 ›
  // SITCON 2026 › 3 / 174, each a way back.
  let fkReady = false;
  let shelf = null; // someone's albums or galleries: { view: 'sets', kind, user, title, owner, link, total, page, pages, sets }
  let coll = null; // the list of photos: { view: 'photos', kind, id, title, owner, link, description, total, page, pages, photos }
  let level = 'photos'; // what #browse shows: 'sets' (shelf) or 'photos' (coll)
  const KIND_WORD = { album: '相簿', gallery: '藝廊', stream: '相片串流', faves: '最愛', group: '群組' };
  const FK_ERR = {
    nokey: '這個網站的 Flickr 查詢暫時不能用',
    badurl: '看不懂這個連結，請貼 Flickr 照片、相簿或藝廊的網址',
    notflickr: '這不是 Flickr 的連結',
    short: '這種短網址還看不懂：請在瀏覽器打開它，再複製網址列裡的完整網址',
    unknown: '這種 Flickr 頁面還看不懂：可以貼照片、相簿、相簿列表、藝廊、藝廊列表、相片串流、最愛或群組的網址',
    notfound: '找不到：可能已經刪除、網址不完整，或只有作者的朋友看得到',
    private: '這是不公開的內容，只有作者允許的人看得到',
    busy: '查詢太頻繁了，請過幾分鐘再試',
    flickr: 'Flickr 暫時沒有回應，請稍後再試',
    net: '連不上網路，請檢查連線後再試',
  };
  const fkMsg = (code) => FK_ERR[code && code.message ? code.message : code] || FK_ERR.flickr;
  const fkGet = (params) => (self.ZFlickr ? ZFlickr.get(params) : Promise.reject(new Error('nokey')));
  const FK_URL = /(?:https?:\/\/)?(?:(?:www|m|secure)\.)?(?:flickr\.com|flic\.kr|(?:live|farm\d+)\.staticflickr\.com)\/\S+/i;

  // a photo as an item (its picture comes when it's read)
  function itemOf(p, from) {
    const it = { id: nextId++, file: new File([], `${p.id}.jpg`), side: null, raw: false, kind: 'flickr', done: false, fk: { ...p, sizes: p.sizes || [] } };
    if (from) { it.coll = from; it.fk.from = { kind: from.kind, title: from.title, link: from.link }; }
    setThumb(it, p.thumb || null);
    return it;
  }

  // Flickr's sizes: for the screen the smallest that fills it (the original only when nothing else is big enough,
  // it can be huge), for 100 % the biggest (the original on a computer; on a phone the biggest up to 4096 px)
  const longOf = (x) => Math.max(x.w, x.h);
  function sizesOf(it) {
    const list = (it.fk.sizes || []).filter((x) => x.src && x.w > 0 && x.h > 0 && !/^(sq|q|t|s)$/.test(x.s)).sort((a, b) => longOf(a) - longOf(b));
    const plain = list.filter((x) => x.s !== 'o');
    const show = plain.find((x) => longOf(x) >= Math.min(SCREEN, 2048) * 0.95) || plain[plain.length - 1] || list[0] || null;
    const big = (SMALL_DEVICE ? list.filter((x) => longOf(x) <= FULL_MAX).pop() : list[list.length - 1]) || show;
    return { show, big };
  }
  // pictures from Flickr's own server, the last few kept (the next one is fetched ahead)
  const pics = new Map();
  function picture(src) {
    if (pics.has(src)) return pics.get(src);
    const p = fetch(src, { mode: 'cors', credentials: 'omit' }).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); });
    pics.set(src, p);
    p.catch(() => pics.delete(src));
    while (pics.size > 4) pics.delete(pics.keys().next().value);
    return p;
  }
  async function bigOf(it) {
    const { big, show } = sizesOf(it);
    if (!big || big === show) return it.file;
    try { return await picture(big.src); } catch { return it.file; }
  }

  // Flickr's EXIF: ExifTool's names in ExifTool's groups, values as ExifTool prints them — the shape the cards read
  // (an older answer had numbers for tags and TIFF / EXIF for groups: its labels say which tag)
  const OLD_LABEL = {
    Manufacturer: 'Make', Make: 'Make', Model: 'Model', Aperture: 'FNumber', Exposure: 'ExposureTime', 'ISO Speed': 'ISO', 'Focal Length': 'FocalLength',
    'Exposure Bias': 'ExposureCompensation', Flash: 'Flash', Lens: 'LensModel', 'Lens Model': 'LensModel', 'Date and Time (Original)': 'DateTimeOriginal',
    'Date and Time (Digitized)': 'CreateDate', Software: 'Software', 'White Balance': 'WhiteBalance', 'Exposure Program': 'ExposureProgram',
    'Metering Mode': 'MeteringMode', Latitude: 'GPSLatitude', Longitude: 'GPSLongitude', 'Color Space': 'ColorSpace', Orientation: 'Orientation',
  };
  const OLD_SPACE = { TIFF: 'IFD0', EXIF: 'ExifIFD', GPS: 'GPS' };
  // "25 deg 2' 32.40\" N" → 25.0423
  const degrees = (s) => {
    const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*(?:deg|°)?\s*(?:(\d+(?:\.\d+)?)\s*['′])?\s*(?:(\d+(?:\.\d+)?)\s*["″])?/);
    return m ? +m[1] + (+m[2] || 0) / 60 + (+m[3] || 0) / 3600 : NaN;
  };
  function flickrTags(fk) {
    const t = {};
    const put = (g, name, value, desc, num) => {
      if (value == null || String(value).trim() === '' || t[`${g}:${name}`]) return;
      t[`${g}:${name}`] = { desc: desc || name, val: String(value) };
      if (num !== undefined && Number.isFinite(num)) t[`${g}:${name}`].num = num;
    };
    for (const e of fk.exif || []) {
      const g = OLD_SPACE[e.g] || e.g || 'EXIF';
      let name = e.t;
      if (!name || /^\d+$/.test(name)) name = OLD_LABEL[e.l] || String(e.l || '').replace(/[^A-Za-z0-9]/g, '');
      if (!name) continue;
      let n;
      if (/^GPS(Latitude|Longitude)$/.test(name)) {
        n = degrees(e.r);
        const h = String(e.r).match(/([NSEW])\s*$/);
        if (h) {
          if (g === 'GPS') put(g, `${name}Ref`, { N: 'North', S: 'South', E: 'East', W: 'West' }[h[1]]);
          else if (/[SW]/.test(h[1])) n = -Math.abs(n);
        }
      }
      put(g, name, e.r, e.l, n);
    }
    const has = (name) => Object.keys(t).some((k) => k.endsWith(`:${name}`));
    // what Flickr knows besides: when (if the file doesn't say), where (if it's on Flickr's map), the 35 mm focal length
    if (fk.taken && !has('DateTimeOriginal') && !has('CreateDate')) put('Flickr', 'DateTimeOriginal', fk.taken.replace(/^(\d{4})-(\d\d)-(\d\d)/, '$1:$2:$3'), '拍攝時間（Flickr）');
    if (fk.location && !has('GPSLatitude')) {
      put('Composite', 'GPSLatitude', fk.location.lat.toFixed(6), 'GPS Latitude', fk.location.lat);
      put('Composite', 'GPSLongitude', fk.location.lon.toFixed(6), 'GPS Longitude', fk.location.lon);
    }
    const f35 = Object.entries(t).find(([k]) => k.endsWith(':FocalLengthIn35mmFormat'));
    if (f35 && !has('FocalLength35efl')) put('Composite', 'FocalLength35efl', f35[1].val, 'Focal Length 35efl', parseFloat(f35[1].val));
    return t;
  }

  // one photo: what Flickr says about it, then its picture
  async function readFlickr(it) {
    it.busy = true;
    renderThumbs();
    let d = null;
    try {
      d = await fkGet({ photo: it.fk.id, secret: it.fk.secret || '', sizes: it.fk.sizes.length ? '0' : '1' });
    } catch (e) { it.error = e.message; }
    if (d) {
      it.fk = { ...it.fk, ...d, sizes: d.sizes || it.fk.sizes, from: it.fk.from };
      it.tags = flickrTags(it.fk);
      it.idx = indexTags(it.tags);
      it.groups = new Set(Object.keys(it.tags).map((k) => k.split(':')[0]));
      it.sheet = null;
      it.reader = 'flickr';
      it.ok = true;
      const { show } = sizesOf(it);
      if (show) {
        try {
          const blob = await picture(show.src);
          it.file = new File([blob], `${it.fk.id}.jpg`, { type: blob.type || 'image/jpeg' });
          it.fk.shown = show;
        } catch {}
      }
      count(it);
    }
    it.busy = false;
    it.done = true;
    if (it.ok && it.file.size) await prepareImage(it); else it.noPicture = true;
    renderThumbs();
    if (it === cur()) { renderInfo(); drawStage(); renderCrumbs(); }
    // the next one's picture, ahead (its sizes came with the album)
    const next = items[items.indexOf(it) + 1];
    if (it === cur() && next && next.fk && !next.done && next.fk.sizes.length) { const s = sizesOf(next).show; if (s) picture(s.src).catch(() => {}); }
  }

  // a credit line to paste under the photo where it's used: title, author, licence, link
  async function copyCredit(it) {
    const f = it.fk, lic = f.license;
    const text = lic && lic.id !== '0'
      ? `「${f.title || '照片'}」by ${f.owner.name}，${lic.short}${/^CC/.test(lic.short) ? ' 授權' : ''}，${f.short || f.page}`
      : `「${f.title || '照片'}」© ${f.owner.name}，${f.short || f.page}`;
    try { await navigator.clipboard.writeText(text); toast(`已複製：${text}${lic && lic.id === '0' ? '　這張照片保留所有權利，使用前要先取得作者同意' : ''}`, 6000); } catch { toast(`沒辦法自動複製，請手動選取：${text}`, 9000); }
  }

  // ---------- a link in ----------
  let asking = false;
  async function openFlickr(link, say) {
    if (asking) return;
    asking = true;
    say([el('span', { class: 'spinner' }), ' 正在向 Flickr 查詢…']);
    try {
      const r = await fkGet({ url: link });
      say(null);
      closePop();
      if (r.view === 'photo') openOne(r.photo);
      else if (r.view === 'sets') { shelf = r; coll = null; showBrowse('sets'); }
      else {
        if (!shelf || !sameOwner(shelf, r)) shelf = null;
        coll = r;
        const i = r.focus ? r.photos.findIndex((p) => p.id === r.focus) : -1;
        if (i >= 0) openColl(i);
        else if (r.focus) { showBrowse('photos'); openOne({ id: r.focus, sizes: [] }); }
        else showBrowse('photos');
      }
    } catch (e) { say(fkMsg(e), true); }
    asking = false;
  }
  const sameOwner = (a, b) => !!(a && b && a.owner && b.owner && a.owner.id && a.owner.id === b.owner.id);
  // one photo from a link: with your other photos (not into an album's)
  function openOne(p) {
    if (items.length && items[0].coll) clearItems();
    const had = items.find((x) => x.fk && x.fk.id === p.id);
    current = had ? items.indexOf(had) : items.push(itemOf(p)) - 1;
    loupeReset();
    setView('one');
  }
  // a photo of the grid: the list's photos become the strip
  function openColl(i) {
    if (!(items.length && items[0].coll === coll)) {
      clearItems();
      for (const p of coll.photos) items.push(itemOf(p, coll));
    }
    current = Math.max(0, Math.min(items.length - 1, i));
    loupeReset();
    setView('one');
  }
  // the next page of a list (500 at a time); an album's photos already in the strip get the new ones too
  let paging = false;
  async function more(src) {
    if (paging || !src || src.page >= src.pages) return;
    paging = true;
    renderMore();
    try {
      const r = src.view === 'sets' ? await fkGet({ sets: src.kind, user: src.user, page: src.page + 1 }) : await fkGet({ list: src.kind, id: src.id, page: src.page + 1 });
      src.page = r.page;
      src.pages = r.pages;
      if (src.view === 'sets') src.sets.push(...r.sets);
      else {
        src.photos.push(...r.photos);
        src.videos = (src.videos || 0) + (r.videos || 0);
        if (items.length && items[0].coll === src) { for (const p of r.photos) items.push(itemOf(p, src)); renderThumbs(); }
      }
      paging = false;
      if (view === 'browse') renderBrowse(true);
    } catch (e) { paging = false; toast(fkMsg(e)); renderMore(); }
  }

  // ---------- the grid ----------
  let gridKey = '';
  function showBrowse(l) {
    level = l === 'sets' && shelf ? 'sets' : coll ? 'photos' : 'sets';
    $('#bFilter').value = '';
    gridKey = '';
    setView('browse');
  }
  const ymd = (s) => { const m = String(s).match(/^(\d{4})-(\d\d)-(\d\d)/); return m ? [+m[1], +m[2], +m[3]] : null; };
  function dateSpan(list) {
    const ds = list.map((p) => ymd(p.taken)).filter(Boolean).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    if (!ds.length) return '';
    const [a, b] = [ds[0], ds[ds.length - 1]];
    const one = (d) => `${d[0]}/${d[1]}/${d[2]}`;
    if (a.join() === b.join()) return one(a);
    return a[0] === b[0] ? `${one(a)} – ${b[1]}/${b[2]}` : `${one(a)} – ${one(b)}`;
  }
  function renderBrowse(keep = false) {
    const src = level === 'sets' ? shelf : coll;
    if (!src) return;
    const q = $('#bFilter').value.trim().toLowerCase();
    const n = (x) => x.toLocaleString('zh-TW');
    $('#bTitle').textContent = src.title || (level === 'sets' ? 'Flickr' : KIND_WORD[src.kind]);
    $('#bOpen').href = src.link || 'https://www.flickr.com/';
    let meta;
    if (level === 'sets') {
      meta = [src.owner.name, `${n(src.total)} ${src.kind === 'galleries' ? '個藝廊' : '本相簿'}`];
    } else {
      const lics = new Map();
      for (const p of src.photos) if (p.license) lics.set(p.license, (lics.get(p.license) || 0) + 1);
      const top = [...lics.entries()].sort((a, b) => b[1] - a[1]);
      const owners = new Set(src.photos.map((p) => p.owner).filter(Boolean));
      meta = [
        src.kind === 'album' || src.kind === 'stream' ? src.owner.name : src.kind === 'gallery' ? `${src.owner.name} 選的` : '',
        `${n(src.total)} 張${src.videos ? `（${src.videos} 部影片沒有列出）` : ''}`,
        src.kind !== 'album' && src.kind !== 'stream' && owners.size > 1 ? `${owners.size} 位作者` : '',
        dateSpan(src.photos) ? `拍攝 ${dateSpan(src.photos)}` : '',
        top.length ? (top.length === 1 ? top[0][0] : `${top[0][0]} 等 ${top.length} 種授權`) : '',
        src.views ? `${n(src.views)} 次觀看` : '',
      ];
    }
    $('#bMeta').textContent = meta.filter(Boolean).join('・');
    $('#bDesc').textContent = src.description || '';
    $('#bDesc').hidden = !src.description;
    $('#bFilter').placeholder = level === 'sets' ? (src.kind === 'galleries' ? '找藝廊名稱' : '找相簿名稱') : '篩選標題或作者，例如攝影師的名字';
    const key = `${level}|${src.link}|${q}|${(src.sets || src.photos).length}`;
    if (key !== gridKey) {
      gridKey = key;
      const grid = $('#bGrid');
      if (level === 'sets') {
        const list = src.sets.filter((x) => !q || x.title.toLowerCase().includes(q));
        grid.className = 'b-grid sets';
        fill(grid, ...list.map((x) => el('li', {}, el('button', { type: 'button', class: 'b-set', onclick: () => openSet(x) },
          el('span', { class: 'b-cover' }, x.cover ? el('img', { src: x.cover, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null),
          el('b', { text: x.title || '（沒有名稱）' }),
          el('small', { text: `${n(x.count)} 張` })))));
        $('#bCount').textContent = q ? `${list.length} / ${src.sets.length}` : '';
      } else {
        const opened = items.length && items[0].coll === src ? items[current] : null;
        const list = src.photos.map((p, i) => [p, i]).filter(([p]) => !q || p.title.toLowerCase().includes(q) || (p.owner || '').toLowerCase().includes(q));
        grid.className = 'b-grid photos';
        fill(grid, ...list.map(([p, i]) => {
          const small = (p.sizes || []).find((x) => x.s === 'n');
          return el('li', {}, el('button', { type: 'button', class: `b-photo${opened && opened.fk.id === p.id ? ' on' : ''}`, title: p.title, onclick: () => openColl(i) },
            el('img', { src: small ? small.src : p.thumb, alt: '', loading: 'lazy' }),
            el('span', { class: 'b-cap', text: p.title || ' ' })));
        }));
        $('#bCount').textContent = q ? `${list.length} / ${src.photos.length}${src.page < src.pages ? '（已載入的）' : ''}` : '';
      }
      if (!keep) $('#bScroll').scrollTop = 0;
      const on = $('.b-photo.on', grid);
      if (on && !keep) on.scrollIntoView({ block: 'center' });
    }
    renderMore();
  }
  function renderMore() {
    const src = level === 'sets' ? shelf : coll;
    const box = $('#bMore');
    if (!src || src.page >= src.pages) { fill(box); return; }
    const loaded = level === 'sets' ? src.sets.length : src.photos.length;
    fill(box, paging ? el('span', { class: 'b-loading' }, el('span', { class: 'spinner' }), ' 載入中…')
      : el('button', { type: 'button', class: 'btn small', onclick: () => more(src), text: `再載入（已載入 ${loaded.toLocaleString('zh-TW')} / ${src.total.toLocaleString('zh-TW')}）` }));
  }
  // scrolled to the end: the next page by itself
  new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && view === 'browse') more(level === 'sets' ? shelf : coll); }, { rootMargin: '600px' }).observe($('#bMore'));
  let filterTimer;
  $('#bFilter').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => renderBrowse(), 120); });
  async function openSet(x) {
    if (asking) return;
    asking = true;
    toast(`正在打開「${x.title}」…`, 20000);
    try {
      coll = await fkGet({ list: x.kind, id: x.id });
      $('#toast').hidden = true;
      showBrowse('photos');
    } catch (e) { toast(fkMsg(e)); }
    asking = false;
  }

  // ---------- where you are: the Flickr lists up top ----------
  function renderCrumbs() {
    const nav = $('#crumbs');
    const inColl = view === 'one' && cur() && cur().coll;
    const parts = [];
    if (shelf) parts.push(view === 'browse' && level === 'sets' ? el('b', { text: shelf.title }) : el('button', { type: 'button', onclick: () => showBrowse('sets'), text: shelf.title }));
    if (coll) parts.push(view === 'browse' && level === 'photos' ? el('b', { text: coll.title || KIND_WORD[coll.kind] }) : el('button', { type: 'button', onclick: () => showBrowse('photos'), text: `${coll.title || KIND_WORD[coll.kind]}` }));
    if (inColl && coll === cur().coll) parts.push(el('span', { class: 'cr-n', text: `${current + 1} / ${coll.total.toLocaleString('zh-TW')}` }));
    nav.hidden = !parts.length;
    fill(nav, el('span', { class: 'flk-dots', 'aria-hidden': 'true' }, el('i'), el('i')),
      ...parts.flatMap((x, i) => (i ? [el('span', { class: 'cr-sep', 'aria-hidden': 'true', text: '›' }), x] : [x])));
  }

  // ---------- the two views ----------
  function setView(v) {
    view = v === 'browse' && (coll || shelf) ? 'browse' : 'one';
    if (view === 'one' && !items.length) { if (coll || shelf) view = 'browse'; else { reset(); return; } }
    $('#start').hidden = true;
    $('#viewer').hidden = view !== 'one';
    $('#browse').hidden = view !== 'browse';
    closePop();
    renderCrumbs();
    if (view === 'one') {
      renderThumbs();
      renderInfo();
      drawStage();
      want(cur());
    } else renderBrowse();
  }

  // ---------- the Flickr box: on the start page; in a little panel from 加照片's neighbour, the grid and the top ----------
  const pop = $('#flkPop');
  function openPop(from) {
    pop.hidden = false;
    $('#flkPopMsg').textContent = '';
    const r = from.getBoundingClientRect();
    pop.style.top = `${Math.round(Math.min(window.innerHeight - 120, r.bottom + 8))}px`;
    pop.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)))}px`;
    $('#flkPopUrl').focus();
  }
  function closePop() { pop.hidden = true; }
  const sayIn = (node) => (msg, bad = false) => { fill(node, ...(msg == null ? [] : [].concat(msg))); node.classList.toggle('bad', !!bad); };
  $('#flkForm').addEventListener('submit', (e) => { e.preventDefault(); const u = $('#flkUrl').value.trim(); if (u) openFlickr(u, sayIn($('#flkMsg'))); });
  pop.addEventListener('submit', (e) => { e.preventDefault(); const u = $('#flkPopUrl').value.trim(); if (u) openFlickr(u, sayIn($('#flkPopMsg'))); });
  $('#flkPopClose').addEventListener('click', closePop);
  for (const id of ['#flkAdd', '#bNew']) $(id).addEventListener('click', (e) => { e.stopPropagation(); if (pop.hidden) openPop(e.currentTarget); else closePop(); });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('#flkAdd, #bNew')) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { e.stopImmediatePropagation(); closePop(); } }, true);
  // a Flickr link pasted anywhere (not into a box) opens
  document.addEventListener('paste', (e) => {
    if (!fkReady || (e.target.closest && e.target.closest('input, textarea'))) return;
    const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
    const m = t.match(FK_URL);
    if (!m) return;
    e.preventDefault();
    if ($('#start').hidden) openFlickr(m[0], (msg, bad) => { if (msg == null) $('#toast').hidden = true; else toast(typeof msg === 'string' ? msg : '正在向 Flickr 查詢…', bad ? 6000 : 20000); });
    else { $('#flkUrl').value = m[0]; openFlickr(m[0], sayIn($('#flkMsg'))); }
  });
  // the box shows only with a Flickr key (flickr.json); /exif?flickr=<link> opens one
  if (self.ZFlickr) {
    ZFlickr.ready.then((ok) => {
      fkReady = ok;
      document.documentElement.classList.toggle('fk-on', fkReady);
      const link = new URLSearchParams(location.search).get('flickr');
      if (fkReady && link) { $('#flkUrl').value = link; openFlickr(link, sayIn($('#flkMsg'))); }
    });
  }

  // ---------- input ----------
  $('#fileInput').addEventListener('change', (e) => { add(e.target.files); e.target.value = ''; });
  $('#moreInput').addEventListener('change', (e) => { add(e.target.files); e.target.value = ''; });
  for (const id of ['#folderInput', '#moreFolder']) {
    const inp = $(id);
    if (!inp) continue;
    inp.addEventListener('change', (e) => { add(e.target.files, true); e.target.value = ''; });
  }
  // a folder chooser doesn't exist on phones (the photo picker is the way there)
  if (TOUCH || !('webkitdirectory' in document.createElement('input'))) for (const n of $$('.folder-only')) n.hidden = true;
  const drop = $('#drop'), veil = $('#veil');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; if ($('#start').hidden) veil.hidden = false; else drop.classList.add('is-over'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; drop.classList.remove('is-over'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  // a dropped folder: walk it (and the folders in it) for files, keeping each file's path for the .xmp pairing
  async function filesOf(entry, out, depth = 0) {
    if (out.length > 5000 || depth > 8) return;
    if (entry.isFile) {
      const f = await new Promise((res) => entry.file(res, () => res(null)));
      if (f) { try { f.relPath = entry.fullPath.replace(/^\//, ''); } catch {} out.push(f); }
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      for (const e of batch) await filesOf(e, out, depth + 1);
    }
  }
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; veil.hidden = true; drop.classList.remove('is-over');
    const entries = [...(e.dataTransfer.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    if (entries.some((x) => x && x.isDirectory)) {
      const files = [];
      for (const x of entries) if (x) await filesOf(x, files);
      add(files, true);
    } else add(e.dataTransfer.files);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.target.closest && e.target.closest('input, textarea, select')) || e.altKey || e.ctrlKey || e.metaKey) return;
    const full = !$('#full').hidden;
    if (e.key === 'Escape' && full) { if (fullLoupe.zoomed) fullLoupe.fit(); else closeFull(); return; }
    if (view !== 'one' || !items.length) return;
    const L = full ? fullLoupe : stageLoupe;
    if (e.key === 'z' || e.key === 'Z' || (e.key === ' ' && !e.target.closest('button'))) { e.preventDefault(); L.toggle(); return; }
    if (e.key === 'f' || e.key === 'F') { if (full) closeFull(); else openFull(); return; }
    if (e.key === 'Escape' && L.zoomed) { L.fit(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { if (current < items.length - 1) { e.preventDefault(); select(current + 1); if (full) showFull(); } }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { if (current > 0) { e.preventDefault(); select(current - 1); if (full) showFull(); } }
  });
  let resizeTimer;
  new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!$('#viewer').hidden) { stageLoupe.paint(); drawHist(cur() && cur().hist); } }, 80); }).observe($('#stage'));
  new ResizeObserver(() => { if (!$('#full').hidden) fullLoupe.paint(); }).observe($('#fullBox'));

  // ---------- small things ----------
  let toastTimer;
  function toast(msg, ms = 3500) {
    const n = $('#toast');
    n.textContent = msg; n.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { n.hidden = true; }, ms);
  }
  // the public counter: how many photos were read (no names, no content)
  const counted = new Set();
  let pendingCount = 0, countTimer;
  function count(it) {
    if (counted.has(it.id) || !onServer) return;
    counted.add(it.id);
    pendingCount++;
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      const files = pendingCount; pendingCount = 0;
      fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ files }) }).catch(() => {});
    }, 1500);
  }
  if (onServer) {
    fetch('api/stats', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((st) => {
      if (st && st.files > 0) fill($('#heroCount'), '已幫大家看了 ', el('b', { class: 'hero-num', text: st.files.toLocaleString('zh-TW') }), ' 張照片的參數');
    }).catch(() => {});
  }

  startWorker();
  showEngine();
})();
