/* ZhuyuanLoveExif — what the camera wrote into a photo, read in this browser. No steps: drop photos and look.
   ExifTool (the real one, as WebAssembly, in assets/worker.js) reads every tag. This page picks what a photographer
   looks for (重點: exposure, lens, depth of field, shutter count, place), keeps everything else in a searchable list
   (全部), and shows the picture with its histogram — for a RAW file, the JPEG the camera put inside it.
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
  // first non-empty entry for any of the names; opts.groups limits/orders the groups, opts.notGroups skips some
  function pick(it, names, opts = {}) {
    for (const name of [].concat(names)) {
      let list = it.idx.get(name) || [];
      if (opts.groups) list = opts.groups.flatMap((g) => list.filter((e) => e.g === g || (g === '*maker' && e.rank === 5)));
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
    [/^Electronic( Shutter)?$/i, '電子快門'], [/^On$/, '電子前簾'], [/^Off$/, '機械快門'], [/^Auto \((.+)\)$/, '自動（$1）'], [/^Normal$/, ''],
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

  function cameraName(it) {
    const make = val(it, 'Make'), model = val(it, ['Model', 'CameraModelName']);
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

  // ---------- 重點 ----------
  function keyGroups(it) {
    const groups = [];
    const row = (label, value, hint) => (value ? [label, value, hint] : null);

    // 拍攝設定
    const program = trProgram(val(it, 'ExposureProgram')) || val(it, ['ShootingMode', 'ExposureMode']);
    const bracket = /bracket/i.test(val(it, 'ExposureMode')) ? '・包圍曝光' : '';
    const wbRaw = val(it, 'WhiteBalance', { groups: ['*maker', 'ExifIFD', 'XMP-exif'] });
    // Canon keeps the Kelvin setting in ColorTemperature even when another white balance was used: the
    // as-shot temperature is the one that matters, unless the white balance itself was set in Kelvin
    const kelvin = /Kelvin|Color Temp/i.test(wbRaw) ? num(it, ['ColorTemperature', 'ColorTempAsShot']) : num(it, ['ColorTempAsShot', 'ColorTemperature', 'WhiteBalanceTemperature']);
    const wb = [wbRaw && trWb(wbRaw), Number.isFinite(kelvin) && kelvin > 1500 && kelvin < 15000 ? `${Math.round(kelvin)} K` : ''].filter(Boolean).join('・');
    const flashV = val(it, 'Flash');
    const fec = val(it, ['FlashExposureComp', 'ConditionalFEC']);
    const flash = flashV ? trFlash(flashV, val(it, 'FlashType')) + (/有閃/.test(trFlash(flashV)) && fec && !/^[+-]?0(\.0+)?$/.test(fec) ? `・閃燈補償 ${evText(fec)}` : '') : '';
    const focusDist = (() => {
      const up = num(it, 'FocusDistanceUpper'), lo = num(it, 'FocusDistanceLower');
      // Canon writes 655.35 m for "infinity"
      if (Number.isFinite(lo) && lo > 0) return Number.isFinite(up) && up > lo && up < 600 ? `${trim0(lo, 2)} – ${trim0(up, 2)} m` : `${trim0(lo, 2)} m 以上`;
      const d = val(it, ['FocusDistance', 'SubjectDistance', 'FocusDistance2']);
      return d ? metres(d) : '';
    })();
    groups.push({
      title: '拍攝設定', rows: [
        row('曝光模式', program && program + bracket),
        row('測光', trMetering(val(it, 'MeteringMode'))),
        row('對焦模式', trFocus(val(it, ['FocusMode', 'FocusMode2', 'AFMode'], { groups: ['*maker', 'ExifIFD', 'XMP-exif', 'Composite'] }))),
        row('對焦區域', trArea(val(it, ['AFAreaMode', 'AFAreaModeSetting', 'AFArea', 'FocusArea']))),
        row('對焦距離', focusDist, '鏡頭回報的距離，不一定很精準'),
        row('白平衡', wb),
        row('閃光燈', flash),
        row('驅動', trDrive(val(it, ['DriveMode', 'ContinuousDrive', 'ReleaseMode', 'DriveModeSetting'], { groups: ['Composite', '*maker'] }))),
        row('快門方式', trShutter(val(it, ['ShutterMode', 'ShutterType', 'ElectronicFrontCurtainShutter']))),
        row('防手震', trOnOff(val(it, ['ImageStabilization', 'VibrationReduction', 'SteadyShot', 'ImageStabilizationSetting']))),
        row('照片風格', (() => { const s = val(it, ['PictureStyle', 'PictureControlName', 'CreativeStyle', 'FilmMode', 'PictureMode', 'PhotoStyle', 'FilmSimulation', 'ImageTone'], { notGroups: ['Pentax'] }) || val(it, 'ImageTone'); return s ? trStyle(s) : ''; })()), // Pentax's PictureMode is the exposure mode
      ],
    });

    // 鏡頭與景深
    const lens35 = val(it, 'Lens35efl', { groups: ['Composite'] });
    const range = (() => {
      const m = lens35.match(/^([\d.]+)(?: - ([\d.]+))? mm(?: \(35 mm equivalent: ([\d.]+)(?: - ([\d.]+))? mm\))?/);
      if (!m) {
        // ExifIFD:LensInfo, as numbers: shortest and longest focal length, then the widest aperture at each
        const n = String((pick(it, 'LensInfo') || {}).num || '').split(/\s+/).map(Number);
        if (!(n[0] > 0)) return '';
        const fl = n[1] > n[0] ? `${trim0(n[0])} – ${trim0(n[1])} mm` : `${trim0(n[0])} mm`;
        const ap = n[2] > 0 ? (n[3] > n[2] + 0.05 ? `f/${fNum(n[2])}–${fNum(n[3])}` : `f/${fNum(n[2])}`) : '';
        return [fl, ap].filter(Boolean).join('　');
      }
      const a = m[2] ? `${trim0(m[1])} – ${trim0(m[2])} mm` : `${trim0(m[1])} mm`;
      const b = m[3] ? (m[4] ? `${Math.round(m[3])} – ${Math.round(m[4])} mm` : `${Math.round(m[3])} mm`) : '';
      return b && b.replace(/ mm$/, '') !== a.replace(/ mm$/, '') && Math.abs(parseFloat(m[3]) - parseFloat(m[1])) > 1 ? `${a}（等效 ${b}）` : a;
    })();
    const fov = (() => {
      const v = val(it, 'FOV', { groups: ['Composite'] });
      const m = v.match(/^([\d.]+) deg(?: \(([\d.]+) m\))?/);
      return m ? `${trim0(m[1])}°${m[2] ? `（對焦處約 ${trim0(m[2], 2)} m 寬）` : ''}` : '';
    })();
    const dof = (() => {
      const v = val(it, 'DOF', { groups: ['Composite'] });
      let m = v.match(/^([\d.]+) m \(([\d.]+) - ([\d.]+) m\)/);
      if (m) return `${trim0(m[2], 2)} – ${trim0(m[3], 2)} m（前後 ${trim0(m[1], 2)} m 清楚）`;
      m = v.match(/^inf \(([\d.]+) m - inf\)/);
      return m ? `${trim0(m[1], 2)} m 到無限遠都清楚` : '';
    })();
    const hyper = num(it, 'HyperfocalDistance', { groups: ['Composite'] });
    const lv = num(it, 'LightValue', { groups: ['Composite'] });
    groups.push({
      title: '鏡頭與景深', rows: [
        row('鏡頭', lensName(it)),
        row('焦段', range),
        row('視角', fov),
        row('景深', dof, '依焦距、光圈和對焦距離推算'),
        row('超焦距', Number.isFinite(hyper) && hyper > 0 ? `${hyper >= 10 ? Math.round(hyper) : trim0(hyper, 2)} m` : '', '對焦在這個距離，一半距離到無限遠都會清楚'),
        row('光值', Number.isFinite(lv) ? `LV ${trim0(lv)}` : '', '現場有多亮：室內約 5～7，陰天戶外約 12，晴天約 15'),
      ],
    });

    // 機身
    const shots = num(it, ['ShutterCount', 'ImageCount', 'ShutterCount3', 'ShutterCount2']);
    const mech = num(it, 'MechanicalShutterCount');
    // the camera's firmware, or the program that last wrote the file (an editor, a phone's OS, a transfer tool)
    let firmware = (val(it, ['FirmwareVersion', 'CanonFirmwareVersion', 'FirmwareRevision', 'Firmware']) || '').replace(/^Firmware Version\s*/i, '');
    let software = val(it, ['Software', 'CreatorTool', 'ProcessingSoftware']);
    if (!firmware && software) {
      const model = val(it, 'Model');
      const ver = software.match(/(?:^|\s)v(?:er)?\.?\s*(\d[\w.]*)$/i);
      if (/^Apple$/i.test(val(it, 'Make')) && /^\d[\d.]*$/.test(software)) { firmware = `iOS ${software}`; software = ''; }
      else if (/^(ver\.?\s*)?\d[\w.]*$/i.test(software)) { firmware = software.replace(/^ver\.?\s*/i, ''); software = ''; }
      else if (ver && (/firmware|digital camera/i.test(software) || (model && software.includes(model)))) { firmware = ver[1]; software = ''; }
    }
    if (/^(ver(sion)?\.?\s*)?\d[\w.]*$/i.test(software)) { firmware = firmware || software.replace(/^ver(sion)?\.?\s*/i, ''); software = ''; }
    const temp = (val(it, ['CameraTemperature', 'SensorTemperature', 'BoardTemperature']).match(/^(-?[\d.]+)\s*C$/) || [, ''])[1];
    groups.push({
      title: '機身', rows: [
        row('快門次數', Number.isFinite(shots) && shots > 0 ? `${shots.toLocaleString('zh-TW')} 次${Number.isFinite(mech) && mech > 0 && mech !== shots ? `（機械快門 ${mech.toLocaleString('zh-TW')} 次）` : ''}` : '', '相機拍過幾張，看二手相機常用'),
        row('機身序號', val(it, 'SerialNumber', { notGroups: ['XMP-aux'] }) || val(it, 'SerialNumber')),
        row('鏡頭序號', val(it, 'LensSerialNumber')),
        row('韌體', firmware),
        row('機身溫度', temp && `${temp}°C`),
        row('擁有者', val(it, 'OwnerName')),
        row('作者', val(it, ['Artist', 'Creator', 'By-line'])),
        row('版權', val(it, ['Copyright', 'Rights', 'CopyrightNotice'])),
      ],
    });

    // 影像
    const w = num(it, ['ImageWidth', 'ExifImageWidth'], { groups: ['Composite', 'File', 'ExifIFD', 'IFD0'] });
    const size = val(it, 'ImageSize', { groups: ['Composite'] });
    const [iw, ih] = (size.match(/^(\d+)x(\d+)$/) || []).slice(1).map(Number);
    const mp = num(it, 'Megapixels', { groups: ['Composite'] });
    const ratio = (() => {
      if (!(iw > 0 && ih > 0)) return '';
      const r = Math.max(iw, ih) / Math.min(iw, ih);
      const named = [[1, '1:1'], [1.25, '5:4'], [4 / 3, '4:3'], [1.5, '3:2'], [16 / 9, '16:9'], [2, '2:1'], [2.35, '2.35:1']].find(([x]) => Math.abs(r - x) < 0.015);
      const t = named ? named[1] : `${trim0(r, 2)}:1`;
      return iw < ih ? t.split(':').reverse().join(':') + '（直的）' : t;
    })();
    const type = val(it, 'FileType') || extOf(it.file.name);
    const profile = val(it, 'ProfileDescription');
    const rating = num(it, 'Rating');
    groups.push({
      title: '影像', rows: [
        row('尺寸', iw ? `${iw.toLocaleString('zh-TW')} × ${ih.toLocaleString('zh-TW')}${mp >= 0.01 ? `・${Math.round(mp * 100).toLocaleString('zh-TW')} 萬畫素` : ''}` : (Number.isFinite(w) ? `${w}` : '')),
        row('長寬比', ratio),
        row('檔案', `${type}${it.raw ? '（RAW 原始檔）' : ''}・${fmtBytes(it.file.size)}`),
        row('色彩空間', profile || trColor(val(it, 'ColorSpace'))),
        row('方向', trOrient(val(it, 'Orientation', { groups: ['IFD0', 'ExifIFD', 'XMP-tiff', '*maker'] }))),
        row('軟體', software),
        row('評分', Number.isFinite(rating) && rating > 0 ? '★'.repeat(Math.min(5, Math.round(rating))) + '☆'.repeat(Math.max(0, 5 - Math.round(rating))) : ''),
      ],
    });

    // 位置
    const gps = gpsOf(it);
    if (gps) {
      const alt = num(it, 'GPSAltitude', { groups: ['Composite', 'GPS'] });
      const below = /Below/i.test(val(it, 'GPSAltitude')) || /Below/i.test(val(it, 'GPSAltitudeRef'));
      const dir = num(it, 'GPSImgDirection');
      const link = el('a', { class: 'map-link', href: `https://www.google.com/maps/search/?api=1&query=${gps.lat.toFixed(6)},${gps.lon.toFixed(6)}`, target: '_blank', rel: 'noopener noreferrer', text: '在 Google 地圖打開 ↗' });
      groups.push({
        title: '拍攝位置', warn: '這張照片帶著拍攝地點，公開分享原檔前要留意', rows: [
          row('座標', el('span', {}, `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}　`, link)),
          row('海拔', Number.isFinite(alt) ? `${below ? '海平面下 ' : ''}${Math.round(Math.abs(alt)).toLocaleString('zh-TW')} m` : ''),
          row('拍攝方向', Number.isFinite(dir) ? `${Math.round(dir)}°（朝${DIRS[Math.round(((dir % 360) + 360) % 360 / 45) % 8]}）` : ''),
        ],
      });
    }
    for (const g of groups) g.rows = g.rows.filter(Boolean);
    return groups.filter((g) => g.rows.length);
  }

  // the five numbers across the top
  function expoCells(it) {
    const fl = num(it, 'FocalLength', { groups: ['ExifIFD', 'Composite', '*maker', 'XMP-exif'] });
    const fl35 = num(it, 'FocalLength35efl', { groups: ['Composite'] });
    const scale = num(it, 'ScaleFactor35efl', { groups: ['Composite'] });
    const fn = num(it, ['FNumber', 'Aperture']);
    const maxAp = num(it, 'MaxApertureValue');
    const exp = pick(it, ['ExposureTime', 'ShutterSpeed'], { groups: ['ExifIFD', 'Composite', 'XMP-exif', '*maker'] }) || pick(it, ['ExposureTime', 'ShutterSpeed']);
    const iso = num(it, 'ISO', { groups: ['ExifIFD', 'Composite', '*maker', 'XMP-exif'] });
    const ev = val(it, 'ExposureCompensation', { groups: ['ExifIFD', '*maker', 'XMP-exif'] });
    const sensor = sensorName(scale);
    const flSub = Number.isFinite(fl35) && Number.isFinite(fl) && Math.abs(fl35 - fl) > 1
      ? [`等效 ${Math.round(fl35)} mm`, sensor].filter(Boolean).join('・') : sensor;
    let expVal = exp ? exp.val.replace(/\s*s(ec)?$/, '') : '';
    if (/^\d+(\.\d+)?$/.test(expVal) && +expVal < 1 && +expVal > 0) {
      const inv = 1 / +expVal;
      if (Math.abs(inv - Math.round(inv)) < 0.02) expVal = `1/${Math.round(inv)}`;
    }
    const meter = trMetering(val(it, 'MeteringMode'));
    return [
      { k: '焦距', v: Number.isFinite(fl) ? trim0(fl) : '', u: 'mm', s: flSub },
      { k: '光圈', v: Number.isFinite(fn) ? `f/${fNum(fn)}` : '', s: Number.isFinite(maxAp) ? (Number.isFinite(fn) && Math.abs(maxAp - fn) < 0.05 ? '最大光圈（全開）' : `鏡頭最大 f/${fNum(maxAp)}`) : '' },
      { k: '快門', v: expVal, u: expVal ? '秒' : '', s: trShutter(val(it, ['ShutterMode', 'ShutterType'])) },
      { k: 'ISO', v: Number.isFinite(iso) ? String(Math.round(iso)) : '', s: '' },
      { k: '曝光補償', v: ev ? evText(ev) : '', u: ev ? 'EV' : '', s: meter },
    ];
  }

  function copyLine(it) {
    const c = expoCells(it);
    return [cameraName(it), lensName(it), c[0].v && `${c[0].v}mm`, c[1].v, c[2].v && `${c[2].v}s`, c[3].v && `ISO ${c[3].v}`, c[4].v && c[4].v !== '±0' ? `${c[4].v} EV` : '']
      .filter(Boolean).join(' · ');
  }

  // ---------- 全部 ----------
  const ZH = {
    Make: '品牌', Model: '機型', LensModel: '鏡頭型號', LensID: '鏡頭', LensType: '鏡頭類型', Lens: '焦段', LensMake: '鏡頭品牌',
    LensInfo: '鏡頭規格', LensSpec: '鏡頭規格', LensSerialNumber: '鏡頭序號', SerialNumber: '機身序號', InternalSerialNumber: '內部序號',
    FocalLength: '焦距', FocalLength35efl: '焦距（含 35mm 等效）', FocalLengthIn35mmFormat: '35mm 等效焦距', ScaleFactor35efl: '片幅係數',
    Lens35efl: '焦段（含 35mm 等效）', FNumber: '光圈', Aperture: '光圈', ApertureValue: '光圈值', MaxApertureValue: '鏡頭最大光圈',
    ExposureTime: '快門速度', ShutterSpeed: '快門速度', ShutterSpeedValue: '快門速度值', ISO: 'ISO 感光度', ExposureCompensation: '曝光補償',
    ExposureProgram: '曝光模式', ExposureMode: '曝光方式', MeteringMode: '測光模式', Flash: '閃光燈', FlashExposureComp: '閃燈曝光補償',
    FlashType: '閃燈類型', ConditionalFEC: '閃燈曝光補償', RedEyeReduction: '防紅眼', ShutterCurtainHack: '閃燈同步',
    WhiteBalance: '白平衡', ColorTemperature: '色溫', FocusMode: '對焦模式', AFAreaMode: '對焦區域模式', FocusDistance: '對焦距離',
    FocusDistanceUpper: '對焦距離（上限）', FocusDistanceLower: '對焦距離（下限）', SubjectDistance: '主體距離',
    AFPointsInFocus: '合焦的對焦點', NumAFPoints: '對焦點數量', SubjectToDetect: '偵測主體', EyeDetection: '眼部偵測',
    DateTimeOriginal: '拍攝時間', CreateDate: '建立時間', ModifyDate: '修改時間', OffsetTime: '時區', OffsetTimeOriginal: '拍攝時區',
    OffsetTimeDigitized: '建立時區', SubSecTime: '修改時間（秒以下）', SubSecTimeOriginal: '拍攝時間（秒以下）', SubSecTimeDigitized: '建立時間（秒以下）',
    SubSecDateTimeOriginal: '拍攝時間', SubSecCreateDate: '建立時間', SubSecModifyDate: '修改時間',
    Orientation: '方向', ImageWidth: '寬度', ImageHeight: '高度', ExifImageWidth: '寬度', ExifImageHeight: '高度', ImageSize: '影像尺寸',
    Megapixels: '百萬畫素', XResolution: '水平解析度', YResolution: '垂直解析度', ResolutionUnit: '解析度單位', ColorSpace: '色彩空間',
    Software: '軟體', Artist: '作者', Copyright: '版權', OwnerName: '擁有者', ShutterCount: '快門次數', MechanicalShutterCount: '機械快門次數',
    ImageCount: '拍攝張數', CameraTemperature: '機身溫度', SensorTemperature: '感光元件溫度', BatteryLevel: '電量',
    FirmwareVersion: '韌體版本', CanonFirmwareVersion: '韌體版本', PictureStyle: '照片風格', PictureControlName: '優化校準',
    CreativeStyle: '創意風格', FilmMode: '底片模擬', DriveMode: '驅動模式', ContinuousDrive: '連拍模式', ShutterMode: '快門方式',
    ShutterType: '快門類型', ImageStabilization: '防手震', VibrationReduction: '防手震（VR）', SteadyShot: '防手震',
    DOF: '景深', FOV: '視角', HyperfocalDistance: '超焦距', CircleOfConfusion: '模糊圈', LightValue: '光值',
    GPSLatitude: '緯度', GPSLongitude: '經度', GPSAltitude: '海拔高度', GPSPosition: '座標', GPSImgDirection: '拍攝方向',
    GPSDateTime: 'GPS 時間', GPSSpeed: '移動速度', GPSVersionID: 'GPS 版本', GPSLatitudeRef: '南北緯', GPSLongitudeRef: '東西經',
    GPSAltitudeRef: '高度基準', Rating: '評分', Title: '標題', Description: '說明', ImageDescription: '影像說明', UserComment: '使用者註解',
    Keywords: '關鍵字', Subject: '關鍵字', Creator: '作者', Rights: '版權', CreatorTool: '建立軟體', FileType: '檔案格式',
    FileTypeExtension: '副檔名', MIMEType: 'MIME 類型', ExifByteOrder: '位元組順序', ExifVersion: 'EXIF 版本', BitsPerSample: '每色位元數',
    Compression: '壓縮方式', SceneCaptureType: '場景類型', SensingMethod: '感光方式', CustomRendered: '影像處理', DigitalZoomRatio: '數位變焦',
    Contrast: '對比', Saturation: '飽和度', Sharpness: '銳利度', GainControl: '增益控制', Quality: '畫質', RecordMode: '記錄格式',
    AspectRatio: '長寬比', ThumbnailImage: '縮圖', PreviewImage: '預覽圖', JpgFromRaw: '內嵌 JPEG', ProfileDescription: '色彩描述檔',
    ImageUniqueID: '影像唯一 ID', AutoLightingOptimizer: '自動亮度優化', HighISONoiseReduction: '高 ISO 降噪',
    LongExposureNoiseReduction: '長曝降噪', WB_RGGBLevels: '白平衡 RGGB 比例', RedBalance: '紅色增益', BlueBalance: '藍色增益',
    SensitivityType: '感光度類型', RecommendedExposureIndex: '建議曝光指數', FocalPlaneXResolution: '焦平面水平解析度',
    FocalPlaneYResolution: '焦平面垂直解析度', FocalPlaneResolutionUnit: '焦平面解析度單位', ShootingMode: '拍攝模式', Rotation: '旋轉',
    HostComputer: '拍攝裝置', ComponentsConfiguration: '色彩組成', FlashpixVersion: 'Flashpix 版本', HDRSetting: 'HDR',
    AFConfigTool: '人工智慧伺服 AF 特性', ElectronicFrontCurtainShutter: '電子前簾快門', LensFirmwareVersion: '鏡頭韌體版本',
  };
  const GROUP_NAME = {
    IFD0: 'EXIF 基本資料', ExifIFD: 'EXIF 拍攝資料', Composite: 'ExifTool 推算的值', GPS: 'GPS 位置', IFD1: '縮圖', InteropIFD: 'EXIF 相容資訊',
    File: '檔案', JFIF: 'JFIF', MPF0: '多張影像（MPF）', Photoshop: 'Photoshop', IPTC: 'IPTC', ICC_Profile: '色彩描述檔（ICC）',
    'ICC-header': '色彩描述檔（標頭）', 'ICC-view': '色彩描述檔（觀看條件）', 'ICC-meas': '色彩描述檔（量測）', QuickTime: '檔案容器',
    PrintIM: '列印資訊', MakerNotes: '原廠資料',
  };
  const groupName = (g) => GROUP_NAME[g]
    || (/^XMP-/.test(g) ? `XMP（${g.slice(4)}）` : /^Track(\d+)$/.test(g) ? `資料軌 ${g.slice(5)}` : /^SubIFD\d*$/.test(g) ? 'RAW 子影像'
      : /Custom$/.test(g) ? `${g.replace(/Custom$/, '')} 自訂功能` : rankOf(g) === 5 ? `原廠資料（${g}）` : g);
  const groupRank = (g) => (g === 'ExifIFD' ? 0 : g === 'IFD0' ? 1 : g === 'Composite' ? 2 : rankOf(g) === 5 ? 3 : g === 'GPS' ? 4 : /^XMP/.test(g) ? 5 : g === 'File' ? 8 : /^(Track|QuickTime)/.test(g) ? 9 : 6);
  const shownValue = (v) => {
    const m = v.match(/^\(Binary data (\d+) bytes/);
    return m ? `內嵌資料（${fmtBytes(+m[1])}）` : v;
  };

  function allRows(it) {
    const groups = new Map();
    for (const [key, e] of Object.entries(it.tags)) {
      if (!e || typeof e !== 'object' || !key.includes(':')) continue;
      const [g, name] = key.split(':');
      const v = Array.isArray(e.val) ? e.val.join(', ') : String(e.val ?? '');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ g, name, label: ZH[name] || e.desc || name, sub: ZH[name] ? e.desc || name : '', val: shownValue(v) });
    }
    return [...groups.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0])).map(([g, rows]) => ({ g, title: groupName(g), rows }));
  }

  // ---------- page ----------
  function renderInfo() {
    const it = cur();
    if (!it) return;
    $('#stageName').textContent = `${it.file.name}・${fmtBytes(it.file.size)}`;
    const view = $('input[name=view]:checked').value;
    const noCamera = it.done && it.ok && !val(it, ['Make', 'Model']) && !val(it, ['ExposureTime', 'FNumber']);
    if (!it.done) {
      fill($('#camName'), el('span', { class: 'spinner' }), ' 讀取中…');
      fill($('#camLens'), engine.state === 'ready' ? it.file.name : $('#engine').textContent.trim());
      fill($('#expo'));
      fill($('#when'));
      fill($('#keyList'));
      fill($('#allList'));
      $('#allTab').textContent = '全部';
      $('#copyLine').disabled = true;
      $('#saveAll').hidden = true;
      return;
    }
    if (!it.ok) {
      $('#camName').textContent = '讀不到這個檔案';
      $('#camLens').textContent = engine.state === 'error' ? '解析程式沒有載入成功，請重新整理頁面再試一次' : '檔案可能壞了，或不是照片';
      fill($('#expo')); fill($('#when')); fill($('#keyList')); fill($('#allList'));
      $('#allTab').textContent = '全部';
      $('#copyLine').disabled = true;
      $('#saveAll').hidden = true;
      return;
    }
    $('#camName').textContent = noCamera ? '沒有相機資訊' : cameraName(it) || '不知道是哪台相機';
    $('#camLens').textContent = noCamera ? '可能是截圖、從網路下載的圖，或拍攝資料被軟體清掉了' : lensName(it) || (/mm$/.test(val(it, 'Lens', { groups: ['Composite'] })) ? `鏡頭 ${metres(val(it, 'Lens', { groups: ['Composite'] }))}` : '鏡頭沒有記錄');
    $('#copyLine').disabled = noCamera;
    fill($('#expo'), ...(noCamera ? [] : expoCells(it).map((c) => el('li', { class: c.v ? '' : 'none' },
      el('span', { class: 'ex-k', text: c.k }),
      el('span', { class: 'ex-v' }, c.v || '—', c.v && c.u ? el('small', { text: ` ${c.u}` }) : null),
      el('span', { class: 'ex-s', text: c.s || '' })))));
    const d = dateParts(it);
    fill($('#when'), ...(d ? [el('span', { class: 'when-k', text: '拍攝時間' }), el('b', { text: d.text }), d.tz ? el('span', { class: 'when-tz', text: d.tz }) : null] : []));
    const n = Object.keys(it.tags).filter((k) => k.includes(':')).length;
    $('#allTab').textContent = `全部 ${n} 項`;
    $('#saveAll').hidden = view !== 'all';

    // the groups flow in columns inside an element of their own height, so the list scrolls down, not sideways
    fill($('#keyList'), el('div', { class: 'cols' }, ...keyGroups(it).map((g) => el('section', { class: 'grp' },
      el('h3', { text: g.title }),
      g.warn ? el('p', { class: 'warn', text: g.warn }) : null,
      el('dl', {}, ...g.rows.flatMap(([k, v, hint]) => [
        el('dt', { title: hint || null }, k, hint ? el('button', { type: 'button', class: 'q', 'aria-label': `${k}：${hint}`, text: '?', onclick: () => toast(`${k}：${hint}`, 5000) }) : null),
        el('dd', {}, v)]))))));
    renderAll(it);
  }

  function renderAll(it) {
    const q = $('#search').value.trim().toLowerCase();
    const groups = allRows(it);
    let shown = 0;
    const out = [];
    for (const g of groups) {
      const rows = q ? g.rows.filter((r) => `${r.label} ${r.sub} ${r.name} ${r.val} ${g.title}`.toLowerCase().includes(q)) : g.rows;
      if (!rows.length) continue;
      shown += rows.length;
      out.push(el('section', { class: 'grp' },
        el('h3', {}, g.title, el('span', { class: 'cnt', text: `${rows.length}` })),
        el('dl', {}, ...rows.flatMap((r) => [el('dt', { title: `${g.g}:${r.name}` }, r.label, r.sub ? el('small', { text: r.sub }) : null), el('dd', { text: r.val })]))));
    }
    if (!shown) out.push(el('p', { class: 'nothing', text: q ? `找不到「${$('#search').value.trim()}」` : '這個檔案裡沒有資訊' }));
    fill($('#allList'), ...out);
  }

  function setView() {
    const all = $('input[name=view]:checked').value === 'all';
    $('#keyList').hidden = all;
    $('#allList').hidden = !all;
    $('#search').hidden = !all;
    $('#saveAll').hidden = !all || !(cur() && cur().ok);
    if (all) $('#allList').scrollTop = 0; else $('#keyList').scrollTop = 0;
  }
  for (const r of $$('input[name=view]')) r.addEventListener('change', setView);
  let searchTimer;
  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (cur() && cur().ok) renderAll(cur()); }, 90); });

  $('#copyLine').addEventListener('click', async () => {
    const it = cur();
    if (!it || !it.ok) return;
    const text = copyLine(it);
    try { await navigator.clipboard.writeText(text); toast(`已複製：${text}`); } catch { toast(`沒辦法自動複製，請手動選取：${text}`, 9000); }
  });
  $('#saveAll').addEventListener('click', () => {
    const it = cur();
    if (!it || !it.ok) return;
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [['分類', '名稱', '英文名稱', '值', 'ExifTool 標籤'].map(q).join(',')];
    for (const g of allRows(it)) for (const r of g.rows) lines.push([g.title, r.label, r.sub || r.label, r.val, `${g.g}:${r.name}`].map(q).join(','));
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
    ctx.clearRect(0, 0, c.width, c.height);
    const pct = (x) => (x >= 0.1 ? `${x >= 10 ? Math.round(x) : x.toFixed(1)}%` : '');
    $('#clipLo').textContent = h && pct(h.lo * 100) ? `暗部全黑 ${pct(h.lo * 100)}` : '';
    $('#clipHi').textContent = h && pct(h.hi * 100) ? `亮部過曝 ${pct(h.hi * 100)}` : '';
    if (!h) return;
    // the tallest bar away from the two ends sets the scale, so a clipped end doesn't flatten the rest
    let max = 1;
    for (const ch of [h.r, h.g, h.b]) for (let i = 2; i < 254; i++) max = Math.max(max, ch[i]);
    const W = c.width, H = c.height;
    ctx.globalCompositeOperation = 'screen';
    for (const [ch, color] of [[h.r, 'rgba(255, 84, 72, .9)'], [h.g, 'rgba(76, 214, 110, .9)'], [h.b, 'rgba(72, 132, 255, .9)']]) {
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, ch[i] / max) * (H - 2 * dpr));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
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
    if (e.target.closest('input, textarea, select') || e.altKey || e.ctrlKey || e.metaKey) return;
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
