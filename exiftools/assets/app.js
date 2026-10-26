/* ZhuyuanLoveExif — what the camera wrote into a photo, read in this browser. No steps: drop photos and look.
   ExifTool (the real one, as WebAssembly, in assets/worker.js) reads every tag. This page sorts what matters into
   cards on one screen (exposure, focus, lens, colour, Lightroom edits, body, time and place, file), says each thing
   once however many times the file repeats it, keeps the maker's remaining settings in one folded list, and shows
   the picture with its histogram — for a RAW file, the JPEG the camera put inside it.
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
  const isPhoto = (f) => RAW.test(f.name) || OTHER.test(f.name) || /^image\//.test(f.type);
  // what an <img> can show by itself (HEIC and TIFF only in Safari: tried, and the embedded JPEG looked for too)
  const SHOWABLE = /\.(jpe?g|jpe|png|webp|avif|gif|bmp)$/i;
  const extOf = (name) => (name.match(/\.([^.]+)$/) || [, ''])[1].toUpperCase();

  // ---------- the engine ----------
  const engine = { state: 'loading', loaded: 0, total: 0 };
  let worker = null, seq = 0;
  const waiting = new Map();
  function startWorker() {
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
    worker.postMessage({ warm: true });
  }
  const readTags = (file, preview) => new Promise((resolve) => {
    if (!worker) { resolve({ ok: false, error: 'worker' }); return; }
    const id = ++seq;
    waiting.set(id, resolve);
    worker.postMessage({ id, file, preview });
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
  // item: { id, file, raw, done, ok, error, tags (ExifTool's), idx (tag name → entries), pv (embedded JPEG),
  //         orient (to apply ourselves), small (canvas ≤ 400 px, for the histogram), thumb (data URL), hist }
  const items = [];
  let current = -1, nextId = 1;
  const cur = () => items[current];

  function add(files) {
    const list = [...files];
    const skipped = list.filter((f) => !isPhoto(f));
    const fresh = list.filter(isPhoto).map((file) => ({ id: nextId++, file, raw: RAW.test(file.name), done: false }));
    if (skipped.length) toast(`「${skipped.map((f) => f.name).join('」「')}」不是照片，略過了`);
    if (!fresh.length) return;
    items.push(...fresh);
    $('#start').hidden = true;
    $('#viewer').hidden = false;
    select(items.length - fresh.length);
    renderThumbs();
    for (const it of fresh) process(it);
  }

  async function process(it) {
    const r = await readTags(it.file, !SHOWABLE.test(it.file.name));
    it.done = true;
    it.ok = r.ok;
    if (r.ok) {
      it.tags = r.tags;
      it.idx = indexTags(r.tags);
      it.groups = new Set(Object.keys(r.tags).map((k) => k.split(':')[0]));
      it.pv = r.preview;
      count(it);
    } else it.error = r.error;
    await prepareImage(it);
    renderThumbs();
    if (it === cur()) { renderInfo(); drawStage(); }
  }

  function select(i) {
    if (i < 0 || i >= items.length) return;
    current = i;
    renderThumbs();
    renderInfo();
    drawStage();
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
    const make = val(it, 'Make');
    let model = val(it, ['Model', 'CameraModelName']);
    if (/sony/i.test(make) && SONY[model]) model = SONY[model];
    model = model.replace(/^(NIKON|PENTAX|OLYMPUS|FUJIFILM|SAMSUNG|RICOH|LEICA|SIGMA|KODAK|CASIO|HASSELBLAD)\b/, (w) => w[0] + w.slice(1).toLowerCase()); // "NIKON Z 6" → "Nikon Z 6"
    if (!model) return make;
    const clean = make.replace(/\b(CORPORATION|CORP\.?|IMAGING|COMPANY|CO\.?,?|LTD\.?|INC\.?|DIGITAL SOLUTIONS)\b|,/gi, '').replace(/\s+/g, ' ').trim()
      .replace(/\b([A-Z]{4,})\b/g, (w) => w[0] + w.slice(1).toLowerCase());
    // a model that names its own brand ("Canon EOS R6", "NIKON Z 6", "PENTAX K-70" from Ricoh) stands alone
    if (!clean || model.toLowerCase().includes(clean.toLowerCase().split(' ')[0]) || /^(canon|nikon|pentax|olympus|leica|hasselblad|sigma|kodak|ricoh|samsung|minolta|konica|casio|gopro|dji)\b/i.test(model)) return model;
    return `${clean} ${model}`;
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
    fill($('#sheet'),
      cards.length ? el('div', { class: 'cards' }, ...cards) : null,
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
  const decoded = new Map(); // id → { img, url }, the last few
  function orientOf(it) {
    if (!it.pv || it.pv.orient) return 1; // a file the browser shows itself, or a preview with its own EXIF: the browser turns it
    const o = num(it, 'Orientation', { groups: ['IFD0', '*maker', 'XMP-tiff'] });
    return o >= 1 && o <= 8 ? o : 1;
  }
  async function decode(it) {
    if (decoded.has(it.id)) return decoded.get(it.id);
    const blob = it.pv ? it.file.slice(it.pv.start, it.pv.end, 'image/jpeg') : it.file;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { URL.revokeObjectURL(url); return null; }
    const d = { img, url };
    decoded.set(it.id, d);
    while (decoded.size > 3) {
      const [id, old] = decoded.entries().next().value;
      if (id === (cur() && cur().id)) break;
      URL.revokeObjectURL(old.url);
      decoded.delete(id);
    }
    return d;
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
  const orientedSize = (img, o) => (o >= 5 ? [img.naturalHeight, img.naturalWidth] : [img.naturalWidth, img.naturalHeight]);

  async function prepareImage(it) {
    const d = await decode(it);
    if (!d) { it.noPicture = true; return; }
    const o = orientOf(it);
    const [w, h] = orientedSize(d.img, o);
    const k = Math.min(1, 400 / Math.max(w, h));
    const small = canvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
    drawOriented(small.getContext('2d'), d.img, o, small.width, small.height);
    it.small = small;
    it.hist = histogram(small);
    const t = Math.min(1, 132 / Math.max(w, h));
    const th = canvas(Math.max(1, Math.round(w * t)), Math.max(1, Math.round(h * t)));
    th.getContext('2d').drawImage(small, 0, 0, th.width, th.height);
    it.thumb = th.toDataURL('image/jpeg', 0.8);
  }

  let drawSeq = 0;
  async function drawStage() {
    const it = cur();
    const c = $('#photo'), msg = $('#stageMsg');
    const my = ++drawSeq;
    if (!it || !it.done) {
      c.hidden = true;
      fill(msg, el('span', { class: 'spinner' }), ' 讀取中…');
      msg.hidden = false;
      drawHist(null);
      return;
    }
    if (it.noPicture || !it.small) {
      c.hidden = true;
      msg.hidden = false;
      const heic = /\.(heic|heif|hif)$/i.test(it.file.name), tiff = /\.tiff?$/i.test(it.file.name);
      fill(msg, el('b', { text: '這裡沒辦法顯示這張照片' }), el('span', {
        text: heic ? '這個瀏覽器看不懂 HEIC，用 Safari 就看得到。參數不受影響。'
          : tiff ? '這個瀏覽器看不懂 TIFF，用 Safari 就看得到。參數不受影響。'
            : it.raw ? '這個 RAW 檔裡沒有放預覽圖。參數不受影響。' : '參數還是看得到。',
      }));
      drawHist(null);
      return;
    }
    msg.hidden = true;
    const d = await decode(it);
    if (my !== drawSeq || !d) return;
    const o = orientOf(it);
    const [w, h] = orientedSize(d.img, o);
    const box = $('#stage').getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = Math.min((box.width - 16) / w, (box.height - 16) / h, 2);
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
    c.style.width = `${cw}px`; c.style.height = `${ch}px`;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    drawOriented(ctx, d.img, o, c.width, c.height);
    c.hidden = false;
    drawHist(it.hist);
  }

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
    const ul = $('#thumbs');
    fill(ul, ...items.map((it, i) => el('li', {},
      el('button', {
        type: 'button', class: `thumb${i === current ? ' on' : ''}${it.done && !it.ok ? ' bad' : ''}`, title: it.file.name,
        'aria-label': it.file.name, 'aria-current': i === current ? 'true' : null, onclick: () => select(i),
      },
      it.thumb ? el('img', { src: it.thumb, alt: '' }) : el('span', { class: 'th-ext', text: extOf(it.file.name) }),
      !it.done ? el('span', { class: 'th-busy' }, el('span', { class: 'spinner' })) : null))));
    $('.strip').classList.toggle('one', items.length < 2);
    // keep the chosen one in view by scrolling the strip only (scrollIntoView would also move the page on a phone)
    const on = ul.querySelector('.on');
    if (on) {
      if (on.offsetLeft < ul.scrollLeft) ul.scrollLeft = on.offsetLeft - 6;
      else if (on.offsetLeft + on.offsetWidth > ul.scrollLeft + ul.clientWidth) ul.scrollLeft = on.offsetLeft + on.offsetWidth - ul.clientWidth + 6;
    }
  }

  // ---------- input ----------
  $('#fileInput').addEventListener('change', (e) => { add(e.target.files); e.target.value = ''; });
  $('#moreInput').addEventListener('change', (e) => { add(e.target.files); e.target.value = ''; });
  const drop = $('#drop'), veil = $('#veil');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; if ($('#start').hidden) veil.hidden = false; else drop.classList.add('is-over'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; drop.classList.remove('is-over'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; veil.hidden = true; drop.classList.remove('is-over');
    add(e.dataTransfer.files);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.target.closest && e.target.closest('input, textarea, select')) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { if (current < items.length - 1) { e.preventDefault(); select(current + 1); } }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { if (current > 0) { e.preventDefault(); select(current - 1); } }
  });
  let resizeTimer;
  new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!$('#viewer').hidden) drawStage(); }, 120); }).observe($('#stage'));

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
