/* ZhuyuanLoveExif — what the camera wrote into a photo, read in this browser. No steps: drop photos and look.
   ExifTool (the real one, as WebAssembly, in assets/worker.js) reads every tag. One photo: the cards on one screen
   (exposure, focus, lens, colour, Lightroom edits, body, time and place, file), each thing said once however many
   times the file repeats it, the picture with its histogram and a Lightroom-like zoom. Many photos or a folder:
   整組統整 — Lightroom's sliders and the finished pictures added up (style, how alike they are, what to check),
   read a batch at a time from only the part of each file that holds metadata (assets/look.js measures the pixels).
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
  // item: { id, file, side (its Lightroom .xmp), raw, kind (image / raw / xmp), done, ok, error, tags (ExifTool's),
  //         idx (tag name → entries), pv (embedded JPEG), hist, thumb (URL), rec (numbers for 整組統整),
  //         look (how the finished picture looks), sheet (the cards) }
  // A photo on screen is read whole (done); the others in a set only where their metadata is (rec), a batch at a time.
  const items = [];
  let current = -1, nextId = 1, view = 'one';
  const cur = () => items[current];

  // where a file sits, so a RAW file and its .xmp pair up (a folder from the picker or from drag and drop)
  const pathOf = (f) => (f.relPath || f.webkitRelativePath || '').replace(/[^/]*$/, '').toLowerCase();
  const stem = (f) => `${pathOf(f)}${f.name.replace(/\.[^.]+$/, '').toLowerCase()}`;
  function add(files, folder = false) {
    const list = [...files].filter((f) => !/^\._|^\.DS_Store$|^Thumbs\.db$|^desktop\.ini$/i.test(f.name));
    const known = new Set(items.map((it) => `${pathOf(it.file)}${it.file.name}|${it.file.size}|${it.file.lastModified}`));
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
    $('#start').hidden = true;
    if (items.length >= 2) {
      for (const it of items) if (!it.rec && !scanQ.includes(it)) scanQ.push(it);
      for (const it of items) wantLook(it);
    }
    showModes();
    current = first;
    setView(folder || fresh.length >= 6 ? 'set' : 'one');
    renderThumbs();
    pump();
  }

  // ---------- what the worker does next ----------
  // One job at a time, picked when the last one ends: the photo on screen first (all of it), then the rest of a set
  // a batch at a time (only their metadata), so a big folder never keeps the photo you clicked waiting long.
  const fullQ = [], scanQ = [];
  let running = false;
  // a batch at a time, so a photo you click gets its turn soon
  const BATCH = 12;
  function takeBatch() {
    const out = [];
    while (scanQ.length && out.length < BATCH) {
      const it = scanQ.shift();
      if (!it.rec && !it.done && !it.busy) out.push(it);
    }
    return out;
  }
  function pump() {
    if (running) return;
    let job = null;
    while (!job && fullQ.length) {
      const it = fullQ.shift();
      if (!it.done && !it.busy) job = () => process(it);
    }
    if (!job && scanQ.length) {
      const batch = takeBatch();
      if (batch.length) job = () => scanBatch(batch);
    }
    if (!job) { showProgress(); return; }
    running = true;
    job().catch(() => {}).finally(() => { running = false; pump(); });
  }
  // the one on screen: all of it, next
  function want(it) {
    if (!it || it.done || it.busy) return;
    const i = fullQ.indexOf(it);
    if (i >= 0) fullQ.splice(i, 1);
    fullQ.unshift(it);
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
      const flat = {};
      for (const [k, e] of Object.entries(r.tags)) if (e && typeof e === 'object' && k.includes(':')) flat[k] = e.num !== undefined ? e.num : e.val;
      it.rec = recOf(it, flat);
      count(it);
      wantLook(it);
      changed();
    } else it.error = r.error;
    await prepareImage(it);
    renderThumbs();
    if (it === cur()) { renderInfo(); drawStage(); }
  }

  // a set: only where each file keeps its metadata, with meta.js (a few milliseconds a photo, in any browser)
  async function scanBatch(batch) {
    for (const it of batch) {
      if (it.done) continue; // read whole meanwhile
      it.busy = true;
      const r = await readJs(it, false);
      it.busy = false;
      if (it.done) continue;
      if (!r.ok) { it.scanFailed = true; continue; }
      const flat = {};
      for (const [k, e] of Object.entries(r.tags)) if (e && typeof e === 'object' && k.includes(':')) flat[k] = e.num !== undefined ? e.num : e.val;
      it.rec = recOf(it, flat);
      it.pvScan = r.preview;
      it.exifThumb = r.thumb;
      count(it);
      wantLook(it);
    }
    changed();
    renderThumbs();
  }

  function select(i) {
    if (i < 0 || i >= items.length) return;
    current = i;
    loupeReset();
    renderThumbs();
    renderInfo();
    drawStage();
    if (view === 'one') want(cur());
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

    // ---- 影像與檔案
    const type = v('FileType') || extOf(it.file.name);
    const size = v('ImageSize', { groups: ['Composite'] });
    const [iw, ih] = (size.match(/^(\d+)x(\d+)$/) || []).slice(1).map(Number);
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
    card('file', '影像與檔案', [
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

    const order = ['expo', 'focus', 'lens', 'color', 'grade', 'edit', 'phone', 'body', 'when', 'file', 'author'];
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

  // ---------- 整組統整: each photo as numbers ----------
  // From ExifTool's tags (a scan's plain numbers, or a full read's): the shot, the file, and Lightroom's sliders.
  const SLIDERS = {
    Exposure2012: ['曝光度', -2, 2, 2], Contrast2012: ['對比', -100, 100], Highlights2012: ['亮部', -100, 100], Shadows2012: ['陰影', -100, 100],
    Whites2012: ['白色', -100, 100], Blacks2012: ['黑色', -100, 100], Texture: ['紋理', -100, 100], Clarity2012: ['清晰度', -100, 100],
    Dehaze: ['去朦朧', -100, 100], Vibrance: ['細節飽和度', -100, 100], Saturation: ['飽和度', -100, 100],
    Sharpness: ['銳利化', 0, 150], LuminanceSmoothing: ['雜訊減少', 0, 100], ColorNoiseReduction: ['顏色雜訊', 0, 100],
    PostCropVignetteAmount: ['暈映', -100, 100], GrainAmount: ['顆粒', 0, 100],
  };
  const ZONES = [['Shadow', '陰影'], ['Midtone', '中間調'], ['Highlight', '亮部'], ['Global', '全域']];
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
  function recOf(it, flat) {
    const by = new Map();
    for (const [k, v] of Object.entries(flat)) {
      const i = k.indexOf(':');
      if (i < 0) continue;
      const n = k.slice(i + 1);
      if (!by.has(n)) by.set(n, []);
      by.get(n).push([k.slice(0, i), v]);
    }
    const ok = (v) => v !== undefined && v !== null && v !== '' && !(typeof v === 'string' && /^(n\/a|unknown)$/i.test(v.trim()));
    const get = (names, groups) => {
      for (const n of [].concat(names)) {
        const l = by.get(n);
        if (!l) continue;
        const c = groups ? groups.flatMap((g) => l.filter(([gg]) => gg === g || (g === '*maker' && rankOf(gg) === 5))) : l.filter(([g]) => g !== 'XMP-crs');
        const x = c.find(([, v]) => ok(v));
        if (x) return x[1];
      }
      return undefined;
    };
    const crs = (n) => { const l = by.get(n); const x = l && l.find(([g]) => g === 'XMP-crs'); return x ? x[1] : undefined; };
    const N = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
    const S = (v) => (v == null ? '' : String(Array.isArray(v) ? v.join(', ') : v).trim());
    const make = S(get('Make')), lensModel = S(get('LensModel')), lensId = get('LensID', ['Composite']);
    const size = S(get('ImageSize', ['Composite'])).match(/(\d+)\D+(\d+)/);
    const space = (() => {
      const p = S(get('ProfileDescription'));
      if (p) return /^sRGB/i.test(p) ? 'sRGB' : /Display P3|^P3/i.test(p) ? 'Display P3' : /Adobe RGB/i.test(p) ? 'Adobe RGB' : /ProPhoto/i.test(p) ? 'ProPhoto RGB' : p;
      const c = N(get('ColorSpace'));
      return c === 1 ? 'sRGB' : c === 2 ? 'Adobe RGB' : '';
    })();
    const r = {
      cam: camLabel(make, S(get(['Model', 'CameraModelName']))),
      lens: lensModel || (typeof lensId === 'string' && !/^\d+$/.test(lensId) ? lensId : ''),
      fl: N(get('FocalLength', ['ExifIFD', 'Composite', '*maker', 'XMP-exif'])),
      fl35: N(get('FocalLengthIn35mmFormat')) || N(get('FocalLength35efl', ['Composite'])),
      fn: N(get(['FNumber', 'Aperture'])),
      exp: N(get(['ExposureTime', 'ShutterSpeed'])),
      iso: N(get('ISO', ['ExifIFD', 'Composite', '*maker', 'XMP-exif'])),
      date: S(get(['DateTimeOriginal', 'SubSecDateTimeOriginal', 'CreateDate', 'DateCreated'])),
      orient: N(get('Orientation', ['IFD0', '*maker', 'XMP-tiff'])) || 1,
      w: size ? +size[1] : N(get(['ImageWidth', 'ExifImageWidth'], ['File', 'IFD0', 'ExifIFD'])),
      h: size ? +size[2] : N(get(['ImageHeight', 'ExifImageHeight'], ['File', 'IFD0', 'ExifIFD'])),
      space,
      software: S(get(['Software', 'CreatorTool'])),
      rating: N(get('Rating')),
      pick: N(get('Pick')),
      phone: PHONE_MAKE.test(make) || /\b(back|front|rear)\b.*\bcamera\b/i.test(lensModel),
      crs: null,
    };
    if (by.size && [...by.values()].some((l) => l.some(([g]) => g === 'XMP-crs')) && !/^false$/i.test(S(crs('HasSettings')) || 'true')) {
      const s = {};
      for (const k of Object.keys(SLIDERS)) s[k] = N(crs(k));
      const pts = S(crs('ToneCurvePV2012')).split(/[,\s]+/).map(Number).filter(Number.isFinite);
      const lift = pts.length >= 4 ? pts[1] : 0;
      const curved = pts.length > 4 || (pts.length === 4 && (pts[1] !== 0 || pts[3] !== 255));
      const rgbCurve = ['Red', 'Green', 'Blue'].some((c) => S(crs(`ToneCurvePV2012${c}`)).split(/[,\s]+/).length > 4);
      const zone = (en) => {
        let h = N(crs(`ColorGrade${en}Hue`)), sat = N(crs(`ColorGrade${en}Sat`));
        if (!(sat > 0) && (en === 'Shadow' || en === 'Highlight')) { h = N(crs(`SplitToning${en}Hue`)); sat = N(crs(`SplitToning${en}Saturation`)); }
        return sat > 0 ? [h || 0, sat] : [0, 0];
      };
      const kept = /^true$/i.test(S(crs('HasCrop'))) ? (N(crs('CropRight')) - N(crs('CropLeft'))) * (N(crs('CropBottom')) - N(crs('CropTop'))) : 1;
      r.crs = {
        s,
        pv: N(crs('ProcessVersion')),
        profile: S(crs('LookName')) || S(crs('CameraProfile')),
        bw: /^true$/i.test(S(crs('ConvertToGrayscale'))),
        wb: S(crs('WhiteBalance')),
        temp: N(crs('ColorTemperature')), tint: N(crs('Tint')),
        incTemp: N(crs('IncrementalTemperature')), incTint: N(crs('IncrementalTint')),
        hsl: HSL.map(([en]) => [N(crs(`HueAdjustment${en}`)) || 0, N(crs(`SaturationAdjustment${en}`)) || 0, N(crs(`LuminanceAdjustment${en}`)) || 0]),
        grade: ZONES.map(([en]) => zone(en)),
        curved, lift, rgbCurve,
        crop: Number.isFinite(kept) && kept > 0 && kept < 0.995 ? kept : 0,
        angle: N(crs('CropAngle')) || 0,
        lensProfile: N(crs('LensProfileEnable')) > 0,
        ca: N(crs('AutoLateralCA')) > 0,
        upright: N(crs('PerspectiveUpright')) > 0 || /^(Auto|Full|Level|Vertical|Guided)/i.test(S(crs('PerspectiveUpright'))),
        masks: [...by.keys()].some((k) => /^(MaskGroupBased|GradientBased|PaintBased|CircularGradientBased)Corrections/.test(k)),
        raw: N(crs('ColorTemperature')) > 0 || /\.(cr3|cr2|nef|arw|raf|orf|rw2|dng|pef|srw)$/i.test(S(crs('RawFileName'))),
      };
    }
    return r;
  }

  // ---------- 整組統整: the set ----------
  const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const mad = (a) => { const m = med(a); return med(a.map((x) => Math.abs(x - m))) * 1.4826; };
  const share = (n, d) => (d ? n / d : 0);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const hueName = (h) => ['紅', '橙', '黃', '黃綠', '綠', '青綠', '青', '藍', '藍紫', '紫', '洋紅', '桃紅'][Math.round((((h % 360) + 360) % 360) / 30) % 12];
  const circMean = (pairs) => { let x = 0, y = 0; for (const [h, w] of pairs) { x += Math.cos(h * Math.PI / 180) * w; y += Math.sin(h * Math.PI / 180) * w; } return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360; };
  const tally = (list) => { const m = new Map(); for (const x of list) if (x) m.set(x, (m.get(x) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  // how far each finished picture is from the set: robust (median and MAD), with a floor so a very even set
  // doesn't flag tiny differences — numbers in CIE Lab units
  const LOOKS = [
    ['L', '亮度', 0, 100, 5, (x) => trim0(x, 0)],
    ['contrast', '對比', 0, 40, 3, (x) => trim0(x, 0)],
    ['warm', '冷暖', -20, 40, 3.5, (x) => sg(x, 0)],
    ['chroma', '色彩濃度', 0, 60, 4, (x) => trim0(x, 0)],
  ];

  function summarize() {
    const all = items.filter((it) => it.rec);
    const ed = all.filter((it) => it.rec.crs);
    const fin = all.filter((it) => it.look && !it.look.camera);
    const out = { n: items.length, read: all.length, ed, fin, all, failed: items.filter((it) => it.scanFailed && !it.rec).length };
    // ---- the sliders
    out.sliders = Object.entries(SLIDERS).map(([k, [label, lo, hi, d]]) => {
      const pts = ed.map((it) => [it, it.rec.crs.s[k]]).filter(([, v]) => v !== null);
      const vals = pts.map(([, v]) => v);
      return { k, label, lo, hi, d: d || 0, pts, med: med(vals), used: vals.filter((v) => v !== 0).length, n: vals.length };
    });
    const S = Object.fromEntries(out.sliders.map((x) => [x.k, x]));
    out.S = S;
    // ---- white balance
    out.temps = ed.filter((it) => it.rec.crs.temp > 1500).map((it) => [it, it.rec.crs.temp]);
    out.tints = ed.filter((it) => it.rec.crs.tint !== null).map((it) => [it, it.rec.crs.tint]);
    out.wbModes = tally(ed.map((it) => ({ 'As Shot': '原始設定', Custom: '自訂', Auto: '自動' }[it.rec.crs.wb] || it.rec.crs.wb)));
    // ---- profile, HSL, colour grading, effects
    out.profiles = tally(ed.map((it) => (it.rec.crs.bw ? `${it.rec.crs.profile || '黑白'}（黑白）` : it.rec.crs.profile || '沒有記錄')));
    out.hsl = HSL.map(([en, zh], i) => ({ en, zh, ch: [0, 1, 2].map((j) => { const v = ed.map((it) => it.rec.crs.hsl[i][j]); return { mean: mean(v), used: v.filter((x) => x !== 0).length }; }) }));
    out.grade = ZONES.map(([en, zh], i) => {
      const on = ed.filter((it) => it.rec.crs.grade[i][1] > 0);
      return { en, zh, used: on.length, hue: circMean(on.map((it) => it.rec.crs.grade[i])), sat: mean(on.map((it) => it.rec.crs.grade[i][1])) };
    });
    const count = (f) => ed.filter((it) => f(it.rec.crs)).length;
    out.fx = {
      curved: count((c) => c.curved), lift: count((c) => c.lift >= 8), rgbCurve: count((c) => c.rgbCurve), bw: count((c) => c.bw),
      grain: count((c) => c.s.GrainAmount > 0), vignette: count((c) => c.s.PostCropVignetteAmount < 0), vignetteUp: count((c) => c.s.PostCropVignetteAmount > 0),
      crop: count((c) => c.crop > 0), angle: count((c) => Math.abs(c.angle) >= 0.1), lens: count((c) => c.lensProfile), ca: count((c) => c.ca),
      upright: count((c) => c.upright), masks: count((c) => c.masks),
      cropKept: med(ed.filter((it) => it.rec.crs.crop > 0).map((it) => it.rec.crs.crop)),
    };
    // ---- the finished pictures (pixels)
    out.looks = LOOKS.map(([k, label, lo, hi, tol, fmt]) => {
      const pts = fin.map((it) => [it, it.look[k]]);
      const vals = pts.map(([, v]) => v);
      return { k, label, lo, hi, tol, fmt, pts, med: med(vals), mad: Math.max(tol, mad(vals)) };
    });
    // ---- the shots
    out.cams = tally(all.map((it) => it.rec.cam));
    out.lenses = tally(all.map((it) => it.rec.lens));
    const bucket = (v, edges, labels) => { if (!(v > 0)) return null; const i = edges.findIndex((e) => v <= e); return labels[i < 0 ? labels.length - 1 : i]; };
    const hist = (fn, labels) => { const t = new Map(labels.map((l) => [l, 0])); for (const it of all) { const b = fn(it.rec); if (b) t.set(b, t.get(b) + 1); } return [...t.entries()]; };
    const eq = (r) => r.fl35 || r.fl;
    const FOCAL = ['≤16', '24', '35', '50', '85', '135', '200', '300+'], APER = ['f/1.4', 'f/2', 'f/2.8', 'f/4', 'f/5.6', 'f/8', 'f/11+'], ISOS = ['≤200', '400', '800', '1600', '3200', '6400', '12800+'];
    out.focal = hist((r) => bucket(eq(r), [18, 28, 40, 60, 100, 160, 250], FOCAL), FOCAL);
    out.aperture = hist((r) => bucket(r.fn, [1.6, 2.2, 3.1, 4.4, 6.2, 8.8], APER), APER);
    out.isos = hist((r) => bucket(r.iso, [200, 400, 800, 1600, 3200, 6400], ISOS), ISOS);
    const dates = all.map((it) => it.rec.date.slice(0, 10)).filter((d) => /^\d{4}:\d\d:\d\d$/.test(d)).sort();
    out.dates = dates.length ? [dates[0], dates[dates.length - 1]] : null;
    out.style = styleOf(out);
    out.method = methodOf(out);
    out.lookSame = lookOf(out);
    out.checks = checksOf(out);
    out.odd = oddOnes(out);
    return out;
  }

  // what the set's edits have in common, in words
  function styleOf(o) {
    const tags = [];
    const n = o.ed.length;
    const S = o.S;
    const m = (k) => S[k].med;
    const often = (k, f) => share(S[k].pts.filter(([, v]) => f(v)).length, S[k].n) >= 0.5;
    if (n) {
      if (m('Exposure2012') >= 0.3) tags.push(['整體提亮', `曝光度中位數 ${sg(m('Exposure2012'), 2)}`]);
      else if (m('Exposure2012') <= -0.3) tags.push(['整體壓暗', `曝光度中位數 ${sg(m('Exposure2012'), 2)}`]);
      if (m('Highlights2012') <= -40) tags.push(['亮部壓很多', `亮部中位數 ${sg(m('Highlights2012'))}`]);
      else if (m('Highlights2012') <= -15) tags.push(['亮部壓低', `亮部中位數 ${sg(m('Highlights2012'))}`]);
      if (m('Shadows2012') >= 40) tags.push(['暗部大幅提亮', `陰影中位數 ${sg(m('Shadows2012'))}`]);
      else if (m('Shadows2012') >= 15) tags.push(['暗部提亮', `陰影中位數 ${sg(m('Shadows2012'))}`]);
      if (m('Contrast2012') >= 15) tags.push(['高對比', `對比中位數 ${sg(m('Contrast2012'))}`]);
      else if (m('Contrast2012') <= -15) tags.push(['低對比', `對比中位數 ${sg(m('Contrast2012'))}`]);
      if (m('Blacks2012') <= -15) tags.push(['黑色壓深', `黑色中位數 ${sg(m('Blacks2012'))}`]);
      if (share(o.fx.lift, n) >= 0.5) tags.push(['霧面黑', `${o.fx.lift} 張用色調曲線把最暗處提起來`]);
      else if (m('Blacks2012') >= 15) tags.push(['黑色提起', `黑色中位數 ${sg(m('Blacks2012'))}`]);
      if (m('Whites2012') >= 15) tags.push(['白色提亮', `白色中位數 ${sg(m('Whites2012'))}`]);
      if (m('Clarity2012') >= 15) tags.push(['清晰度加強', `清晰度中位數 ${sg(m('Clarity2012'))}`]);
      else if (m('Clarity2012') <= -10) tags.push(['柔和（清晰度降低）', `清晰度中位數 ${sg(m('Clarity2012'))}`]);
      if (m('Texture') <= -15) tags.push(['肌理柔化', `紋理中位數 ${sg(m('Texture'))}`]);
      if (m('Dehaze') >= 10) tags.push(['去朦朧', `去朦朧中位數 ${sg(m('Dehaze'))}`]);
      else if (m('Dehaze') <= -10) tags.push(['加朦朧感', `去朦朧中位數 ${sg(m('Dehaze'))}`]);
      const sat = m('Saturation') + m('Vibrance') / 2;
      if (sat >= 12) tags.push(['顏色加濃', `飽和度 ${sg(m('Saturation'))}、細節飽和度 ${sg(m('Vibrance'))}（中位數）`]);
      else if (sat <= -10) tags.push(['降飽和', `飽和度 ${sg(m('Saturation'))}、細節飽和度 ${sg(m('Vibrance'))}（中位數）`]);
      // HSL habits: a colour moved the same way in at least half the photos
      const h = Object.fromEntries(o.hsl.map((c) => [c.en, c]));
      const habit = (en, j, f) => share(h[en].ch[j].used, n) >= 0.4 && f(h[en].ch[j].mean);
      if (habit('Orange', 2, (v) => v >= 6)) tags.push(['膚色提亮', `橙色明亮度平均 ${sg(h.Orange.ch[2].mean)}`]);
      if (habit('Orange', 1, (v) => v <= -6)) tags.push(['膚色降飽和', `橙色飽和度平均 ${sg(h.Orange.ch[1].mean)}`]);
      if (habit('Green', 1, (v) => v <= -12)) tags.push(['綠色降飽和', `綠色飽和度平均 ${sg(h.Green.ch[1].mean)}`]);
      if (habit('Green', 0, (v) => v <= -10)) tags.push(['綠色偏黃', `綠色色相平均 ${sg(h.Green.ch[0].mean)}`]);
      if (habit('Blue', 2, (v) => v <= -10)) tags.push(['藍天壓暗', `藍色明亮度平均 ${sg(h.Blue.ch[2].mean)}`]);
      if (habit('Blue', 1, (v) => v <= -12)) tags.push(['藍色降飽和', `藍色飽和度平均 ${sg(h.Blue.ch[1].mean)}`]);
      if (habit('Blue', 0, (v) => v <= -10) || habit('Aqua', 0, (v) => v >= 10)) tags.push(['藍色偏青', `藍色色相平均 ${sg(h.Blue.ch[0].mean)}`]);
      const [gs, , gh] = o.grade;
      const tealOrange = share(gs.used, n) >= 0.4 && share(gh.used, n) >= 0.4 && gs.hue >= 160 && gs.hue <= 250 && gh.hue >= 15 && gh.hue <= 75;
      if (tealOrange) tags.push(['青橙色調', `陰影偏${hueName(gs.hue)}、亮部偏${hueName(gh.hue)}（顏色分級）`]);
      else for (const z of o.grade) if (share(z.used, n) >= 0.4 && z.sat >= 4) tags.push([`${z.zh}偏${hueName(z.hue)}`, `顏色分級：${z.zh} ${Math.round(z.hue)}°、飽和 ${Math.round(z.sat)}（${z.used} 張）`]);
      if (share(o.fx.grain, n) >= 0.5) tags.push(['加顆粒', `${o.fx.grain} 張，顆粒中位數 ${trim0(med(o.ed.map((it) => it.rec.crs.s.GrainAmount).filter((v) => v > 0)), 0)}`]);
      if (share(o.fx.vignette, n) >= 0.5) tags.push(['加暗角', `${o.fx.vignette} 張用了裁切後暈映`]);
      if (share(o.fx.bw, n) >= 0.5) tags.push(['黑白', `${o.fx.bw} 張是黑白`]);
    }
    // what the finished pictures look like (works without Lightroom data too)
    const L = Object.fromEntries(o.looks.map((x) => [x.k, x]));
    if (o.fin.length >= 2) {
      if (L.warm.med >= 14) tags.push(['畫面偏暖', `冷暖中位數 ${sg(L.warm.med, 0)}（正值偏黃橘）`]);
      else if (L.warm.med <= 1) tags.push(['畫面偏冷', `冷暖中位數 ${sg(L.warm.med, 0)}（負值偏藍）`]);
      if (L.chroma.med <= 12 && !tags.some(([t]) => /黑白/.test(t))) tags.push(['淡雅低彩', `色彩濃度中位數 ${trim0(L.chroma.med, 0)}`]);
      else if (L.chroma.med >= 32) tags.push(['色彩濃郁', `色彩濃度中位數 ${trim0(L.chroma.med, 0)}`]);
      if (L.L.med >= 62) tags.push(['明亮', `亮度中位數 ${trim0(L.L.med, 0)}`]);
      else if (L.L.med <= 38) tags.push(['偏暗、低調', `亮度中位數 ${trim0(L.L.med, 0)}`]);
    }
    // a name people use for the combination, only when the pieces really are there
    const has = (t) => tags.some(([x]) => x === t);
    let like = '';
    if (has('青橙色調')) like = '電影感的青橙色調';
    else if ((has('霧面黑') || has('黑色提起')) && (has('加顆粒') || has('低對比'))) like = '底片感（霧面黑、低對比或顆粒）';
    else if ((has('整體提亮') || has('明亮')) && (has('低對比') || has('暗部提亮')) && (has('降飽和') || has('淡雅低彩'))) like = '日系清透（提亮、低對比、淡色）';
    else if (has('高對比') && (has('黑色壓深') || has('清晰度加強'))) like = '高對比、硬朗的街拍感';
    return { tags, like, profile: o.profiles[0] && share(o.profiles[0][1], o.ed.length) >= 0.5 ? o.profiles[0][0] : '' };
  }

  // 調法: the parts of an edit a preset carries (profile, HSL, colour grading, look sliders, effects) — exposure and
  // tone fixes differ photo to photo by nature, so they don't count against it
  function methodOf(o) {
    const ed = o.ed;
    if (ed.length < 3) return null;
    const vec = (c) => [
      ...c.hsl.flat().map((v) => v / 10),
      ...c.grade.flatMap(([h, s]) => [Math.cos(h * Math.PI / 180) * s / 6, Math.sin(h * Math.PI / 180) * s / 6]),
      (c.s.Vibrance || 0) / 12, (c.s.Saturation || 0) / 12, (c.s.Clarity2012 || 0) / 12, (c.s.Texture || 0) / 12, (c.s.Dehaze || 0) / 10,
      (c.s.GrainAmount || 0) / 10, (c.s.PostCropVignetteAmount || 0) / 12, c.lift / 10,
    ];
    const vs = ed.map((it) => vec(it.rec.crs));
    const center = vs[0].map((_, i) => med(vs.map((v) => v[i])));
    const profile = o.profiles[0] ? o.profiles[0][0] : '';
    const bw = share(o.fx.bw, ed.length) >= 0.5;
    const per = ed.map((it, i) => {
      const c = it.rec.crs;
      const why = [];
      const d = Math.sqrt(vs[i].reduce((a, x, j) => a + (x - center[j]) ** 2, 0) / 4);
      const p = c.bw ? `${c.profile || '黑白'}（黑白）` : c.profile || '沒有記錄';
      if (p !== profile) why.push(`描述檔是 ${p}，這組多是 ${profile}`);
      if (c.bw !== bw) why.push(c.bw ? '這張是黑白' : '這張是彩色，這組多是黑白');
      if (d > 1.6) why.push('HSL、顏色分級或質感的調法和其他張不一樣');
      return { it, d, why };
    });
    const same = per.filter((x) => !x.why.length).length;
    return { same, n: ed.length, per };
  }
  // 成品: do the finished pictures look alike (brightness, contrast, warmth, colour)
  function lookOf(o) {
    if (o.fin.length < 3) return null;
    const per = o.fin.map((it) => {
      const why = [];
      let z = 0;
      for (const x of o.looks) {
        const d = it.look[x.k] - x.med;
        const zz = d / x.mad;
        if (Math.abs(zz) >= 2.5) {
          z = Math.max(z, Math.abs(zz));
          why.push({ L: d > 0 ? '比其他張亮很多' : '比其他張暗很多', contrast: d > 0 ? '對比比其他張強' : '對比比其他張弱', warm: d > 0 ? '比其他張暖（偏黃橘）' : '比其他張冷（偏藍）', chroma: d > 0 ? '顏色比其他張濃' : '顏色比其他張淡' }[x.k]
            + `（${x.label} ${x.fmt(it.look[x.k])}，這組大多在 ${x.fmt(x.med)} 左右）`);
        }
      }
      return { it, z, why };
    });
    const same = per.filter((x) => !x.why.length).length;
    const spread = o.looks.map((x) => ({ label: x.label, r: mad(x.pts.map(([, v]) => v)) / x.tol }));
    return { same, n: o.fin.length, per, spread };
  }
  const level = (same, n) => (share(same, n) >= 0.9 ? ['很一致', 'good'] : share(same, n) >= 0.7 ? ['大致一致', 'ok'] : ['差異比較大', 'warn']);

  // things worth a look, each with the photos it's about
  function checksOf(o) {
    const out = [];
    const add = (lvl, title, why, list) => { if (list.length) out.push({ lvl, title, why, list }); };
    add('warn', '亮部過曝', '最亮的地方變成全白，沒有細節了（超過 2% 的畫面）', o.fin.filter((it) => it.look.hi > 0.02));
    add('warn', '暗部死黑', '最暗的地方變成全黑（超過 5% 的畫面）', o.fin.filter((it) => it.look.lo > 0.05));
    add('warn', '高感光度但降噪很少', 'ISO 3200 以上、雜訊減少不到 10，放大看可能有雜訊', o.ed.filter((it) => it.rec.iso >= 3200 && it.rec.crs.raw && (it.rec.crs.s.LuminanceSmoothing || 0) < 10));
    add('info', '亮部和陰影都拉很重', '亮部 −80 以下、陰影 +60 以上，容易出現不自然的 HDR 感或光暈', o.ed.filter((it) => (it.rec.crs.s.Highlights2012 || 0) <= -80 && (it.rec.crs.s.Shadows2012 || 0) >= 60));
    add('info', '質感調得很重', '清晰度 +50、去朦朧 +40 或紋理 +60 以上，可能看起來太銳利、太硬', o.ed.filter((it) => { const s = it.rec.crs.s; return (s.Clarity2012 || 0) >= 50 || (s.Dehaze || 0) >= 40 || (s.Texture || 0) >= 60; }));
    add('info', '顏色加得很濃', '飽和度 +40 或細節飽和度 +60 以上，膚色和天空容易過頭', o.ed.filter((it) => (it.rec.crs.s.Saturation || 0) >= 40 || (it.rec.crs.s.Vibrance || 0) >= 60));
    const wide = o.all.filter((it) => it.kind !== 'xmp' && !it.raw && it.rec.space && it.rec.space !== 'sRGB');
    add('info', '不是 sRGB', '上傳網路或社群前建議輸出成 sRGB，不然有些地方看起來會偏灰、偏淡', o.all.filter((it) => !it.raw && /Adobe RGB|ProPhoto/.test(it.rec.space)));
    if (wide.length && wide.length < o.all.filter((it) => !it.raw && it.kind !== 'xmp').length) add('info', '色彩空間不一樣', `這組裡混了 ${tally(o.all.filter((it) => !it.raw && it.rec.space).map((it) => it.rec.space)).map(([k, v]) => `${k}（${v}）`).join('、')}`, wide);
    const longs = o.all.filter((it) => !it.raw && it.kind === 'image' && it.rec.w > 0).map((it) => [it, Math.max(it.rec.w, it.rec.h)]);
    const commonLong = tally(longs.map(([, l]) => l))[0];
    if (commonLong && longs.length >= 3 && share(commonLong[1], longs.length) >= 0.5) add('info', '輸出尺寸不一樣', `這組大多長邊 ${commonLong[0].toLocaleString('zh-TW')} px，這幾張不同`, longs.filter(([, l]) => l !== commonLong[0]).map(([it]) => it));
    if (o.ed.length >= 3 && share(o.fx.lens, o.ed.length) >= 0.6) add('info', '沒開鏡頭校正', '這組多數有開「啟用描述檔校正」，這幾張沒有', o.ed.filter((it) => !it.rec.crs.lensProfile));
    const noData = o.all.filter((it) => !it.rec.crs && !it.raw && it.kind === 'image' && /lightroom|camera raw|photoshop/i.test(it.rec.software));
    add('info', 'Lightroom 輸出，但沒帶調色參數', '輸出時「中繼資料」要選「全部」，調色參數才會一起存進照片', noData);
    return out;
  }
  // the photos most unlike the rest, and why
  function oddOnes(o) {
    const m = new Map();
    const put = (it, z, why) => { const x = m.get(it) || { it, z: 0, why: [] }; x.z = Math.max(x.z, z); x.why.push(...why); m.set(it, x); };
    if (o.lookSame) for (const x of o.lookSame.per) if (x.why.length) put(x.it, x.z, x.why);
    if (o.method) for (const x of o.method.per) if (x.why.length) put(x.it, 2 + x.d, x.why);
    return [...m.values()].sort((a, b) => b.z - a.z).slice(0, 12);
  }

  // the summary as a few sentences, for the page and to copy
  function verdict(o) {
    const st = o.style;
    const parts = [];
    if (o.ed.length) {
      const words = st.tags.map(([t]) => t);
      parts.push(`${o.read} 張裡，${o.ed.length === o.read ? '每張' : `${o.ed.length} 張`}都帶著 Lightroom 的調色參數。`);
      if (words.length) parts.push(`常用的調法：${words.slice(0, 8).join('、')}${words.length > 8 ? '等' : ''}。`);
      if (st.profile) parts.push(`描述檔多用 ${st.profile}。`);
      if (st.like) parts.push(`整體接近「${st.like}」。`);
    } else {
      parts.push(o.read ? `這 ${o.read} 張沒有 Lightroom 的調色參數，下面用照片本身的亮度、冷暖和色彩來比。` : '');
      const words = st.tags.map(([t]) => t);
      if (words.length) parts.push(`看起來：${words.join('、')}。`);
    }
    return parts.filter(Boolean).join('');
  }

  // ---------- 整組統整: the page ----------
  const byId = (id) => items.find((it) => it.id === +id);
  const SWATCH = { Red: '#e5484d', Orange: '#f08a24', Yellow: '#f2c21b', Green: '#46a758', Aqua: '#12a594', Blue: '#3e63dd', Purple: '#8e4ec6', Magenta: '#d6409f' };
  const jitter = (it) => ((it.id * 2654435761) % 997) / 997; // the same small offset every time, so dots don't jump
  let ink = null;
  function paintStrip(track, hot, size) {
    const P = track.plot;
    if (!P) return;
    if (size) track.size = size;
    const [W, H] = track.size || [track.clientWidth, track.clientHeight], D = Math.min(2, window.devicePixelRatio || 1);
    const cv = track.firstChild;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * D)) { cv.width = Math.round(W * D); cv.height = Math.round(H * D); }
    if (!ink) { const cs = getComputedStyle(document.documentElement); ink = { dot: cs.getPropertyValue('--accent').trim() || '#c48a06', hot: cs.getPropertyValue('--accent-strong').trim() || '#8f6408', line: cs.getPropertyValue('--ink').trim() || '#17202c', zero: cs.getPropertyValue('--line-strong').trim() || '#dbcfb7', ring: '#fff' }; }
    const c = cv.getContext('2d');
    c.setTransform(D, 0, 0, D, 0, 0);
    c.clearRect(0, 0, W, H);
    const pad = 6, x = (v) => pad + ((Math.min(P.hi, Math.max(P.lo, v)) - P.lo) / (P.hi - P.lo)) * (W - 2 * pad);
    if (P.lo < 0 && P.hi > 0) { c.fillStyle = ink.zero; c.fillRect(Math.round(x(0)), 3, 1, H - 6); }
    track.hits = P.pts.map(([it, v]) => ({ it, x: x(v), y: H * (0.2 + jitter(it) * 0.6), text: `${P.label} ${P.fmt(v)}` }));
    const r = TOUCH ? 5.5 : 4.5;
    for (const h of track.hits) {
      c.beginPath(); c.arc(h.x, h.y, r + 1.5, 0, 7); c.fillStyle = ink.ring; c.fill();
      c.beginPath(); c.arc(h.x, h.y, r, 0, 7); c.fillStyle = h === hot ? ink.hot : ink.dot; c.globalAlpha = h === hot ? 1 : 0.82; c.fill(); c.globalAlpha = 1;
    }
    if (hot) { c.beginPath(); c.arc(hot.x, hot.y, r + 2.5, 0, 7); c.strokeStyle = ink.hot; c.lineWidth = 1.5; c.stroke(); }
    if (P.pts.length) { c.fillStyle = ink.line; c.fillRect(Math.round(x(P.m)) - 1, 1, 2, H - 2); }
  }
  // the dot nearest the pointer, if close enough
  function hitAt(track, e) {
    const r = track.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let best = null, bd = TOUCH ? 22 : 12;
    for (const h of track.hits || []) { const d = Math.hypot(h.x - px, (h.y - py) * 0.6); if (d < bd) { bd = d; best = h; } }
    return best;
  }
  // one row of a strip plot: each photo a dot on the slider's scale, the median a line. The dots are drawn on a
  // canvas (paintStrip, once the row has its width): hundreds of photos × twenty rows as elements took the page
  // a second or more to lay out each time the summary changed.
  function strip(label, pts, lo, hi, fmt, note) {
    const vals = pts.map(([, v]) => v);
    const m = med(vals);
    const track = el('div', { class: 'st-track', role: 'img', 'aria-label': `${label}：${pts.length} 張，中位數 ${vals.length ? fmt(m) : '—'}` }, el('canvas'));
    track.plot = { pts, lo, hi, fmt, label, m };
    return el('div', { class: 'st' },
      el('span', { class: 'st-k' }, label, note ? el('small', { text: note }) : null),
      track,
      el('span', { class: 'st-v', title: '中位數' }, vals.length ? fmt(m) : '—'));
  }
  const fmtS = (d) => (v) => (d === 2 ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}` : sg(v, d));
  const usedNote = (x) => (x.n ? (x.used === x.n ? '每張都調' : x.used ? `${x.used}/${x.n} 張` : '都沒調') : '');
  function bars(entries, unit = '張') {
    const max = Math.max(1, ...entries.map(([, n]) => n));
    return el('div', { class: 'bars' }, ...entries.map(([k, n]) => el('div', { class: `bar${n ? '' : ' zero'}`, title: `${k}：${n} ${unit}` },
      el('span', { class: 'bar-n', text: n ? String(n) : '' }),
      el('span', { class: 'bar-col' }, el('span', { class: 'bar-fill', style: `height:${Math.max(n ? 4 : 0, (n / max) * 100)}%` })),
      el('span', { class: 'bar-k', text: k }))));
  }
  function tallyList(list, total, max = 5) {
    const top = list.slice(0, max), rest = list.slice(max).reduce((a, [, n]) => a + n, 0);
    return el('ul', { class: 'tally' }, ...[...top, ...(rest ? [['其他', rest]] : [])].map(([k, n]) => el('li', {},
      el('span', { class: 'ta-k', text: k }), el('span', { class: 'ta-bar' }, el('span', { style: `width:${(n / Math.max(1, total)) * 100}%` })), el('span', { class: 'ta-n', text: `${n}` }))));
  }
  const thumbBtn = (it, cls = 'mini') => el('button', { type: 'button', class: cls, 'data-id': it.id, title: it.file.name, 'aria-label': `打開 ${it.file.name}` },
    it.thumb ? el('img', { src: it.thumb, alt: '', loading: 'lazy' }) : el('span', { text: extOf(it.file.name) || 'XMP' }));
  function thumbRow(list, max = 6) {
    return el('div', { class: 'minis' }, ...list.slice(0, max).map((it) => thumbBtn(it)), list.length > max ? el('span', { class: 'more-n', text: `+${list.length - max}` }) : null);
  }
  const scard = (id, title, sub, ...kids) => el('section', { class: `card s-card c-${id}` }, el('h3', {}, icon(id), el('span', { text: title }), sub ? el('small', { text: sub }) : null), ...kids);
  const row = (k, v, note) => (v ? el('div', { class: 'fx' }, el('span', { class: 'fx-k', text: k }), el('span', { class: 'fx-v', text: v }), note ? el('small', { text: note }) : null) : null);

  let lastSummary = null, checksOpen = false;
  function renderSummary() {
    summaryDirty = false;
    const o = summarize();
    lastSummary = o;
    const keep = [$('#sMain').scrollTop, $('#sCards').scrollTop];
    const reading = items.filter((it) => !it.rec && !it.scanFailed && !(it.done && !it.ok)).length;
    const lookLeft = lookQ.length + looking;
    // ---- left: the verdict
    const left = [];
    const fmtD = (d) => d.replace(/^(\d{4}):(\d\d):(\d\d)$/, (_, y, m, dd) => `${y}/${+m}/${+dd}`);
    left.push(el('div', { class: 's-head' },
      el('h2', {}, '這組照片', el('span', { class: 's-n', text: `${o.n} 張` })),
      el('p', { class: 's-meta', text: [o.dates ? (o.dates[0] === o.dates[1] ? fmtD(o.dates[0]) : `${fmtD(o.dates[0])} – ${fmtD(o.dates[1])}`) : '', o.ed.length ? `${o.ed.length} 張有 Lightroom 調色參數` : ''].filter(Boolean).join('・') })));
    if (reading || lookLeft) {
      const done = o.n - reading;
      left.push(el('div', { class: 's-prog', role: 'status' },
        el('span', { class: 'spinner' }),
        el('span', { text: reading ? `讀取中 ${done} / ${o.n}` : `正在看每張照片的亮度和色彩，還有 ${lookLeft} 張` }),
        el('span', { class: 's-prog-bar' }, el('span', { style: `width:${(reading ? done / o.n : 1 - lookLeft / Math.max(1, o.n)) * 100}%` }))));
    }
    const words = verdict(o);
    if (words || o.style.tags.length) {
      left.push(el('section', { class: 's-block s-style' },
        el('h3', { text: o.ed.length ? '調色風格' : '成品風格' }),
        o.style.tags.length ? el('ul', { class: 'chips s-chips' }, ...o.style.tags.map(([t, why]) => el('li', { class: 'chip', title: why }, t))) : null,
        el('p', { class: 's-words', text: words })));
    }
    const meters = [];
    const meter = (title, x, unit, hint) => {
      const [w, cls] = level(x.same, x.n);
      return el('div', { class: `meter m-${cls}` },
        el('div', { class: 'm-top' }, el('b', { text: title }), el('span', { class: 'm-word', text: w })),
        el('span', { class: 'm-bar' }, el('span', { style: `width:${share(x.same, x.n) * 100}%` })),
        el('p', { class: 'm-note', text: `${x.same} / ${x.n} 張${unit}` }), hint ? el('p', { class: 'm-hint', text: hint }) : null);
    };
    if (o.method) meters.push(meter('調法一致', o.method, '用同一套調法', '比的是描述檔、HSL、顏色分級、質感和效果；曝光、亮部、陰影本來就會每張不同，不算在內'));
    if (o.lookSame) meters.push(meter('成品一致', o.lookSame, '的亮度、對比、冷暖和色彩接近', '直接量每張照片的成品，沒有 Lightroom 資料也能比'));
    if (meters.length) left.push(el('section', { class: 's-block' }, el('h3', { text: '一致性' }), ...meters));
    if (o.checks.length) {
      // the first few (problems before notes); the rest a tap away, so a phone reaches the charts
      const shown = checksOpen ? o.checks : o.checks.slice(0, 3);
      left.push(el('section', { class: 's-block' }, el('h3', { text: '檢查與建議' }),
        el('ul', { class: 'checks' }, ...shown.map((c) => el('li', { class: `ck ck-${c.lvl}` },
          el('div', { class: 'ck-top' }, el('b', { text: c.title }), el('span', { class: 'ck-n', text: `${c.list.length} 張` })),
          el('p', { text: c.why }), thumbRow(c.list)))),
        o.checks.length > 3 ? el('button', { type: 'button', class: 'link-btn ck-more', onclick: () => { checksOpen = !checksOpen; renderSummary(); } }, checksOpen ? '收起來' : `還有 ${o.checks.length - 3} 項`) : null));
    }
    if (o.odd.length) {
      left.push(el('section', { class: 's-block' }, el('h3', { text: '和其他張最不一樣' }),
        el('ul', { class: 'odd' }, ...o.odd.slice(0, 8).map((x) => el('li', {},
          thumbBtn(x.it, 'mini odd-t'),
          el('div', {}, el('b', { text: x.it.file.name }), ...x.why.slice(0, 3).map((w) => el('p', { text: w }))))))));
    }
    left.push(el('div', { class: 's-acts' },
      el('button', { type: 'button', class: 'btn small', onclick: copySummary }, '複製總結'),
      el('button', { type: 'button', class: 'btn small', onclick: () => saveSet(o) }, '存成表格')));

    // ---- right: the details
    const cards = [];
    const S = o.S;
    if (o.ed.length) {
      const sl = (k) => strip(S[k].label, S[k].pts, S[k].lo, S[k].hi, fmtS(S[k].d), usedNote(S[k]));
      cards.push(scard('grade', '基本調整', '每個點是一張照片，直線是中位數', ...['Exposure2012', 'Contrast2012', 'Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012'].map(sl)));
      cards.push(scard('color', '外觀與色彩', '', ...['Texture', 'Clarity2012', 'Dehaze', 'Vibrance', 'Saturation'].map(sl)));
      const wb = [];
      if (o.temps.length) wb.push(strip('色溫', o.temps, 2000, 10000, (v) => `${Math.round(v)} K`, `${o.temps.length} 張`));
      if (o.tints.length) wb.push(strip('色調', o.tints, -60, 60, (v) => sg(v), ''));
      const inc = o.ed.filter((it) => it.rec.crs.incTemp !== null).map((it) => [it, it.rec.crs.incTemp]);
      if (inc.length) wb.push(strip('色溫（JPEG）', inc, -100, 100, (v) => sg(v), `${inc.length} 張`));
      cards.push(scard('when', '白平衡', o.wbModes.map(([k, n]) => `${k} ${n}`).join('・'), ...wb));
      cards.push(scard('lens', '描述檔', '', tallyList(o.profiles, o.ed.length)));
      cards.push(scard('color', 'HSL', '平均調了多少', el('div', { class: 'hsl' },
        el('span'), el('span', { class: 'hsl-h', text: '色相' }), el('span', { class: 'hsl-h', text: '飽和度' }), el('span', { class: 'hsl-h', text: '明亮度' }),
        ...o.hsl.flatMap((c) => [
          el('span', { class: 'hsl-c' }, el('i', { style: `background:${SWATCH[c.en]}` }), c.zh),
          ...c.ch.map((x) => el('span', { class: `hsl-v${x.used ? '' : ' none'}`, title: x.used ? `${x.used} 張有調，平均 ${sg(x.mean, 1)}` : '都沒調' },
            el('span', { class: 'hsl-bar' }, el('span', { class: x.mean < 0 ? 'neg' : 'pos', style: `width:${Math.min(50, (Math.abs(x.mean) / 30) * 50)}%` })),
            el('small', { text: x.used ? sg(x.mean, 0) : '' }))),
        ]))));
      cards.push(scard('grade', '顏色分級', '', el('ul', { class: 'zones' }, ...o.grade.map((z) => el('li', { class: z.used ? '' : 'none' },
        el('i', { style: z.used ? `background:hsl(${Math.round(z.hue)} ${Math.min(90, 30 + z.sat * 2)}% 55%)` : '' }),
        el('b', { text: z.zh }),
        el('span', { text: z.used ? `偏${hueName(z.hue)}（${Math.round(z.hue)}°）・飽和 ${trim0(z.sat, 0)}・${z.used} 張` : '沒有用' }))))));
      cards.push(scard('focus', '細節', '', ...['Sharpness', 'LuminanceSmoothing', 'ColorNoiseReduction'].map(sl)));
      const n = o.ed.length, f = o.fx;
      const of = (x) => (x ? `${x} 張（${pct(share(x, n))}）` : '');
      cards.push(scard('edit', '效果與校正', '', sl('PostCropVignetteAmount'), sl('GrainAmount'),
        el('div', { class: 'fxs' },
          row('色調曲線', of(f.curved)), row('霧面黑', of(f.lift), '曲線把最暗處提起來'), row('RGB 曲線', of(f.rgbCurve)), row('黑白', of(f.bw)),
          row('裁切', of(f.crop), f.crop ? `留下約 ${pct(f.cropKept)}` : ''), row('拉直', of(f.angle)),
          row('鏡頭描述檔校正', of(f.lens)), row('移除色差', of(f.ca)), row('自動變形校正', of(f.upright)), row('局部調整（遮色片）', of(f.masks)))));
    } else {
      cards.push(scard('grade', '沒有讀到 Lightroom 的調色參數', '', el('ul', { class: 'tips' },
        el('li', { text: 'Lightroom 輸出 JPEG 時，「中繼資料」選「全部」，調色參數才會跟著存進照片。' }),
        el('li', { text: 'RAW 檔的調色存在 Lightroom 的目錄裡：在圖庫選取照片按 Ctrl+S（Mac 是 ⌘S）寫出 .xmp 檔，再連同 RAW 一起放進來。' }),
        el('li', { text: '社群網站和通訊軟體傳過的照片，這些資料通常都被拿掉了。' }))));
    }
    if (o.fin.length) {
      cards.push(scard('expo', '成品看起來', `量 ${o.fin.length} 張成品的像素`, ...o.looks.map((x) => strip(x.label, x.pts, x.lo, x.hi, x.fmt, ''))));
    }
    const shots = o.all.filter((it) => it.rec.fn || it.rec.fl || it.rec.iso).length;
    if (shots) {
      cards.push(scard('body', '拍攝概況', `${shots} 張有拍攝資料`,
        el('h4', { text: '焦段（等效）' }), bars(o.focal),
        el('h4', { text: '光圈' }), bars(o.aperture),
        el('h4', { text: 'ISO' }), bars(o.isos),
        o.cams.length ? el('h4', { text: '相機' }) : null, o.cams.length ? tallyList(o.cams, o.all.length) : null,
        o.lenses.length ? el('h4', { text: '鏡頭' }) : null, o.lenses.length ? tallyList(o.lenses, o.all.length) : null));
    }
    cards.push(scard('file', '所有照片', '點一張看它的參數', el('div', { class: 'grid' }, ...items.map((it) => thumbBtn(it, `gthumb${it.rec && it.rec.crs ? ' has-crs' : ''}`)))));
    fill($('#sMain'), ...left);
    // columns of my own, each card into the shortest so far (CSS columns re-balance hundreds of dots very slowly)
    const box = $('#sCards');
    const n = Math.max(1, Math.floor((box.clientWidth - 36 + 12) / (330 + 12)));
    const cols = Array.from({ length: n }, () => el('div', { class: 's-col' }));
    fill(box, el('div', { class: 's-cols', style: `grid-template-columns:repeat(${n}, minmax(0, 1fr))` }, ...cols));
    // measure them all at once in the first column (one layout), then deal them out
    cols[0].append(...cards);
    const hs = cards.map((c) => c.offsetHeight), sums = cols.map(() => 0);
    cards.forEach((c, i) => { const j = sums.indexOf(Math.min(...sums)); cols[j].append(c); sums[j] += hs[i] + 12; });
    // all the sizes first, then the drawing (reading a size after a canvas changed lays the page out again)
    const tracks = $$('.st-track', box), sizes = tracks.map((t) => [t.clientWidth, t.clientHeight]);
    tracks.forEach((t, i) => paintStrip(t, null, sizes[i]));
    [$('#sMain').scrollTop, box.scrollTop] = keep;
    showModes();
  }

  // dots and thumbnails: hover for which photo it is, click to open it
  const tip = $('#tip');
  function showTip(target, hit) {
    const it = hit ? hit.it : byId(target.dataset.id);
    if (!it) return;
    const text = hit ? hit.text : target.dataset.v;
    fill(tip, it.thumb ? el('img', { src: it.thumb, alt: '' }) : null, el('b', { text: it.file.name }), text ? el('span', { text }) : null,
      TOUCH ? el('button', { type: 'button', class: 'btn small', onclick: () => openItem(it) }, '看這張') : null);
    tip.hidden = false;
    const tr = target.getBoundingClientRect();
    const r = hit ? { left: tr.left + hit.x - 6, top: tr.top + hit.y - 6, width: 12, height: 12, bottom: tr.top + hit.y + 6 } : tr, t = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.width / 2, y = r.top - t.height - 8;
    if (y < 8) y = r.bottom + 8;
    x = Math.max(8, Math.min(innerWidth - t.width - 8, x));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  let hotTrack = null, hot = null;
  const cool = () => { if (hotTrack) { const t = hotTrack; hotTrack = hot = null; paintStrip(t); } };
  $('#summary').addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = e.target.closest('.st-track');
    if (t) {
      const h = hitAt(t, e);
      if (h !== hot || t !== hotTrack) { cool(); if (h) { hotTrack = t; hot = h; paintStrip(t, h); showTip(t, h); } else tip.hidden = true; }
      t.style.cursor = h ? 'pointer' : '';
      return;
    }
    if (hotTrack) { cool(); tip.hidden = true; }
  });
  $('#summary').addEventListener('pointerover', (e) => { const d = e.target.closest('.mini, .gthumb'); if (d && e.pointerType === 'mouse') showTip(d); });
  $('#summary').addEventListener('pointerout', (e) => { if (e.pointerType === 'mouse' && e.target.closest('.mini, .gthumb')) tip.hidden = true; });
  $('#summary').addEventListener('click', (e) => {
    const t = e.target.closest('.st-track');
    if (t) {
      const h = hitAt(t, e);
      if (!h) { tip.hidden = true; cool(); return; }
      // a finger on a little dot: first say which photo, the button in the tip opens it
      if (TOUCH) { cool(); hotTrack = t; hot = h; paintStrip(t, h); showTip(t, h); return; }
      openItem(h.it);
      return;
    }
    const d = e.target.closest('.mini, .gthumb');
    if (!d) { tip.hidden = true; cool(); return; }
    const it = byId(d.dataset.id);
    if (it) openItem(it);
  });
  // a new width: the columns and the dots again
  let sumW = 0, sumT = 0;
  new ResizeObserver(() => { const w = $('#sCards').clientWidth; if (view === 'set' && Math.abs(w - sumW) > 8) { sumW = w; clearTimeout(sumT); sumT = setTimeout(renderSummary, 120); } }).observe($('#sCards'));
  $('#sCards').addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
  $('#sMain').addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
  function openItem(it) {
    tip.hidden = true;
    const i = items.indexOf(it);
    if (i < 0) return;
    setView('one');
    select(i);
  }

  function copySummary() {
    const o = lastSummary || summarize();
    const lines = [`這組照片 ${o.n} 張`, verdict(o)];
    if (o.method) lines.push(`調法一致：${level(o.method.same, o.method.n)[0]}（${o.method.same}/${o.method.n} 張）`);
    if (o.lookSame) lines.push(`成品一致：${level(o.lookSame.same, o.lookSame.n)[0]}（${o.lookSame.same}/${o.lookSame.n} 張）`);
    for (const c of o.checks) lines.push(`・${c.title}：${c.list.length} 張（${c.list.slice(0, 5).map((it) => it.file.name).join('、')}${c.list.length > 5 ? '…' : ''}）`);
    const text = lines.filter(Boolean).join('\n');
    navigator.clipboard.writeText(text).then(() => toast('已複製總結'), () => toast('沒辦法自動複製', 4000));
  }
  function saveSet(o) {
    const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const keys = Object.keys(SLIDERS);
    const head = ['檔名', '相機', '鏡頭', '焦距', '等效焦距', '光圈', '快門', 'ISO', '拍攝時間', '描述檔', '白平衡', '色溫', '色調', ...keys.map((k) => SLIDERS[k][0]), '黑白', '色調曲線', '裁切留下', '拉直', '局部調整', '成品亮度', '成品對比', '成品冷暖', '成品色彩濃度', '過曝比例', '死黑比例'];
    const lines = [head.map(q).join(',')];
    for (const it of items) {
      const r = it.rec || {}, c = r.crs, l = it.look && !it.look.camera ? it.look : null;
      const n1 = (x, d = 1) => (x == null || !Number.isFinite(x) ? '' : trim0(x, d));
      lines.push([
        it.file.name, r.cam, r.lens, n1(r.fl), n1(r.fl35, 0), r.fn ? `f/${fNum(r.fn)}` : '', r.exp ? (r.exp < 1 ? `1/${Math.round(1 / r.exp)}` : `${trim0(r.exp, 1)}`) : '', n1(r.iso, 0), (r.date || '').replace(/^(\d{4}):(\d\d):(\d\d)/, '$1/$2/$3'),
        c ? c.profile : '', c ? c.wb : '', c && c.temp ? Math.round(c.temp) : '', c && c.tint !== null ? c.tint : '',
        ...keys.map((k) => (c && c.s[k] !== null ? c.s[k] : '')),
        c ? (c.bw ? '是' : '') : '', c ? (c.curved ? '有' : '') : '', c && c.crop ? pct(c.crop) : '', c && c.angle ? trim0(c.angle, 2) : '', c ? (c.masks ? '有' : '') : '',
        l ? trim0(l.L, 1) : '', l ? trim0(l.contrast, 1) : '', l ? trim0(l.warm, 1) : '', l ? trim0(l.chroma, 1) : '', l ? pct(l.hi) : '', l ? pct(l.lo) : '',
      ].map(q).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `整組統整_${o.n}張.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
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
    if (!it.done) { busy([el('span', { class: 'spinner' }), ' 讀取中…'], engine.state === 'ready' ? it.file.name : $('#engine').textContent.trim()); return; }
    if (!it.ok) { busy(['讀不到這個檔案'], engine.state === 'error' ? '解析程式沒有載入成功，請重新整理頁面再試一次' : '檔案可能壞了，或不是照片'); return; }
    const noCamera = !val(it, ['Make', 'Model']) && !val(it, ['ExposureTime', 'FNumber']);
    $('#camName').textContent = noCamera ? '沒有相機資訊' : cameraName(it) || '不知道是哪台相機';
    $('#camLens').textContent = noCamera ? '拍攝資料被拿掉了：截圖、修圖 App 輸出、傳過通訊軟體或社群網站的照片常常這樣。要看參數，請用相機或手機裡的原始檔。'
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
    const note = it.reader === 'js' && !isPhone(it) && (it.raw || val(it, 'Make')) && !q
      ? el('p', { class: 'reader-note', text: 'Safari 只讀得到標準的 EXIF、GPS 和 XMP；相機原廠的細部資料（快門次數、對焦設定、機身溫度等）請用 Chrome、Edge 或 Firefox 開這個網頁。' }) : null;
    fill($('#sheet'),
      cards.length ? el('div', { class: 'cards' }, ...cards) : null,
      note,
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
    const a = el('a', { href: URL.createObjectURL(blob), download: `${it.file.name.replace(/\.[^.]+$/, '')}_參數.csv` });
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
  let fullLoading = 0;
  async function loadFull(it) {
    if (fullLoading === it.id) return;
    fullLoading = it.id;
    const f = await decodeBlob(blobOf(it), FULL_MAX);
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
    $('#fullName').textContent = `${it.file.name}　${current + 1} / ${items.length}`;
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
          type: 'button', class: `thumb${i === current ? ' on' : ''}${it.done && !it.ok ? ' bad' : ''}`, title: it.file.name,
          'aria-label': it.file.name, 'aria-current': i === current ? 'true' : null, onclick: () => select(i),
        },
        it.thumb ? el('img', { src: it.thumb, alt: '', loading: 'lazy' }) : el('span', { class: 'th-ext', text: it.kind === 'xmp' ? 'XMP' : extOf(it.file.name) }),
        it.busy && !it.rec ? el('span', { class: 'th-busy' }, el('span', { class: 'spinner' })) : null))));
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

  // ---------- the look worker: each photo small, for its thumbnail and how it looks (only for a set) ----------
  let lookWorker = null, looking = 0;
  const lookQ = [], lookWait = new Map();
  function lookSource(it) {
    if (it.kind === 'xmp') return null;
    // Safari: a JPEG's own little thumbnail is enough to measure and to show, and costs no full-size decode
    // (it is stored as the camera held it: the photo's orientation turns it)
    if (WEBKIT && it.exifThumb) return { blob: it.file.slice(it.exifThumb.start, it.exifThumb.end, 'image/jpeg'), orient: (it.rec && it.rec.orient) || 1, camera: false, small: true };
    const pv = it.pv || it.pvScan;
    // a RAW file: the camera's JPEG inside (how it looked straight from the camera, not after editing)
    if (pv) return { blob: it.file.slice(pv.start, pv.end, 'image/jpeg'), orient: pv.orient ? 1 : (it.rec && it.rec.orient) || 1, camera: true };
    if (it.raw) return null;
    return { blob: it.file, orient: 1, camera: false };
  }
  function wantLook(it) {
    if (items.length < 2 || it.look || it.lookFailed || it.lookQueued) return;
    // a RAW file waits for its scan, which finds the preview inside it
    if (it.raw && !it.pv && !it.pvScan) { if (it.rec || it.done) it.lookFailed = true; return; }
    if (WEBKIT) { it.lookQueued = true; lookQ.push(it); pumpLookHere(); return; }
    if (!lookWorker) {
      try { lookWorker = new Worker('assets/look.js'); } catch { it.lookFailed = true; return; }
      lookWorker.onmessage = (e) => { const done = lookWait.get(e.data.id); if (done) { lookWait.delete(e.data.id); done(e.data); } };
      lookWorker.onerror = () => { for (const [, done] of lookWait) done({ ok: false }); lookWait.clear(); };
    }
    it.lookQueued = true;
    lookQ.push(it);
    pumpLook();
  }
  function pumpLook() {
    // two in flight: the worker always has the next one ready
    while (looking < 2 && lookQ.length) {
      const it = lookQ.shift();
      const src = lookSource(it);
      if (!src) { it.lookFailed = true; continue; }
      looking++;
      const id = String(it.id);
      new Promise((resolve) => { lookWait.set(id, resolve); lookWorker.postMessage({ id, blob: src.blob, orient: src.orient }); }).then((d) => {
        looking--;
        if (d.ok) {
          it.look = { ...d.look, camera: src.camera };
          if (!it.thumb || !it.done) setThumb(it, URL.createObjectURL(d.thumb));
        } else it.lookFailed = true;
        renderThumbs();
        changed();
        pumpLook();
      });
    }
  }

  // Safari: the same, here, one photo at a time (see decodeBlob)
  async function pumpLookHere() {
    if (looking) return;
    looking = 1;
    while (lookQ.length) {
      // a full-size decode only while 整組統整 is open (a phone has little memory to spare); thumbnails any time
      const i = view === 'set' ? 0 : lookQ.findIndex((x) => { const sx = lookSource(x); return !sx || sx.small; });
      if (i < 0) break;
      const it = lookQ.splice(i, 1)[0];
      const src = lookSource(it);
      if (!src) { it.lookFailed = true; continue; }
      const im = await viaImg(src.blob);
      if (!im) { it.lookFailed = true; continue; }
      const o = src.orient >= 1 && src.orient <= 8 ? src.orient : 1;
      const [w0, h0] = oriented(im.naturalWidth, im.naturalHeight, o);
      const make = (side) => { const k = Math.min(1, side / Math.max(w0, h0)); const c = canvas(Math.max(1, Math.round(w0 * k)), Math.max(1, Math.round(h0 * k))); drawOriented(c.getContext('2d'), im, o, c.width, c.height); return c; };
      const m = make(ZLook.SIDE), t = make(ZLook.THUMB);
      im.src = '';
      it.look = { ...ZLook.measure(m.getContext('2d').getImageData(0, 0, m.width, m.height).data), camera: src.camera };
      if (!it.thumb || !it.done) setThumb(it, t.toDataURL('image/jpeg', 0.8));
      release(m); release(t);
      renderThumbs();
      changed();
      await new Promise((r) => setTimeout(r, 30)); // let the page breathe between photos
    }
    looking = 0;
    changed();
  }

  // ---------- 逐張 / 整組 ----------
  let summaryDirty = false, summaryTimer = 0;
  function changed() {
    summaryDirty = true;
    if (view !== 'set' || summaryTimer) return;
    // while photos keep arriving, redraw a couple of times a second, not for each
    summaryTimer = setTimeout(() => { summaryTimer = 0; if (view === 'set') renderSummary(); }, running || looking ? (items.length > 150 ? 1500 : 700) : 80);
  }
  function showModes() {
    const m = $('#modes');
    m.hidden = items.length < 2;
    if (m.hidden) return;
    const left = items.filter((it) => !it.rec && !it.scanFailed && !(it.done && !it.ok)).length + lookQ.length + looking;
    fill($('#setCount'), left ? el('span', { class: 'spinner' }) : null, ` ${items.length} 張`);
    for (const b of $$('button', m)) b.setAttribute('aria-selected', String(b.dataset.mode === view));
  }
  const showProgress = () => { showModes(); if (view === 'set' && summaryDirty) changed(); };
  function setView(v) {
    view = v === 'set' && items.length >= 2 ? 'set' : 'one';
    $('#viewer').hidden = view !== 'one';
    $('#summary').hidden = view !== 'set';
    tip.hidden = true;
    showModes();
    if (view === 'one') {
      renderThumbs();
      renderInfo();
      drawStage();
      want(cur());
    } else {
      renderSummary();
      if (WEBKIT) pumpLookHere();
    }
  }
  for (const b of $$('#modes button')) b.addEventListener('click', () => setView(b.dataset.mode));

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
    if (view !== 'one') return;
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
