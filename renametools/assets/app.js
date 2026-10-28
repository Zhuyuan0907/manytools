/* ZhuyuanLoveRename — a whole folder of photos renamed in this browser, without going back to Lightroom:
   IMG_4678.CR3 → 竺原-4678.CR3. Three steps: 1 a folder in → 2 the new name ({號碼} the number already in the name,
   {流水號} a running number, {日期} {時間} {相機} from the photo, {原檔名}), every file's before and after →
   3 renamed. Files of one shot (IMG_4678.CR3, .JPG, .xmp) keep one name.
   Chrome and Edge on a computer rename the files where they are (File System Access: a folder picked or dropped,
   then FileSystemHandle.move), with an undo while the page is open; elsewhere the files stay as they are and a ZIP of
   renamed copies is downloaded. Nothing is uploaded; on a server only the number of files renamed is reported. */
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
  const num = (n) => n.toLocaleString('zh-TW');
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const PHONE = matchMedia('(max-width: 640px), (pointer: coarse) and (max-width: 900px)').matches;
  // renaming in place: Chrome and Edge on a computer
  const CAN_MOVE = typeof window.showDirectoryPicker === 'function' && typeof window.FileSystemFileHandle === 'function' && !PHONE;

  let toastTimer;
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- the files ----------
  // src: { kind: 'dir' (renamed in place) | 'files' (ZIP), name, roots: [{ handle, name }], entries, dirs }
  // entry: { dir ('' or 'sub/folder'), name, base, inner, ext, type, file, group }
  // dirs: dir → { handle, names: Set of every name in it, lower case }   (in place only)
  let src = null;
  const RAW = /^(cr3|cr2|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|dng|srw|3fr|iiq|x3f|erf|mef|mos|kdc|dcr|rwl|gpr)$/i;
  const PHOTO = /^(jpe?g|heic|heif|hif|avif|png|tiff?|webp|gif|bmp)$/i;
  const JUNK = /^(\..*|thumbs\.db|desktop\.ini|icon\r)$/i;
  const JUNK_DIR = /^(\..*|\$recycle\.bin|system volume information|@eadir|.*\.lrdata)$/i;
  function entryOf(dir, name, file) {
    const dot = name.lastIndexOf('.');
    let base = dot > 0 ? name.slice(0, dot) : name, inner = '';
    const ext = dot > 0 ? name.slice(dot) : '';
    // a sidecar named after the whole file: IMG_4678.CR3.xmp goes with IMG_4678.CR3
    if (/^\.xmp$/i.test(ext)) {
      const d2 = base.lastIndexOf('.');
      if (d2 > 0 && (RAW.test(base.slice(d2 + 1)) || PHOTO.test(base.slice(d2 + 1)))) { inner = base.slice(d2); base = base.slice(0, d2); }
    }
    return { dir, name, base, inner, ext, type: ext ? ext.slice(1).toUpperCase().replace(/^JPEG$/, 'JPG') : '沒有副檔名', file, group: null };
  }

  // a folder this browser may rename in: everything in it, its folders too (not hidden ones, not Lightroom's)
  async function readDirs(roots) {
    const entries = [], dirs = new Map();
    let seen = 0;
    async function walk(h, rel, depth) {
      const names = new Set(), files = [], sub = [];
      dirs.set(rel, { handle: h, names });
      for await (const [name, k] of h.entries()) {
        names.add(name.toLowerCase());
        if (k.kind === 'file') { if (!JUNK.test(name)) files.push([name, k]); } else if (depth < 8 && !JUNK_DIR.test(name)) sub.push([name, k]);
      }
      for (let i = 0; i < files.length; i += 64) {
        const got = await Promise.all(files.slice(i, i + 64).map(([name, k]) => k.getFile().then((f) => [name, f], () => null)));
        for (const g of got) if (g) entries.push(entryOf(rel, g[0], g[1]));
        seen += got.length;
        reading(`正在看資料夾裡有什麼… ${num(seen)} 個檔案`);
      }
      for (const [name, k] of sub) await walk(k, rel ? `${rel}/${name}` : name, depth + 1);
    }
    for (const r of roots) await walk(r.handle, roots.length > 1 ? r.name : '', 0);
    return { entries, dirs };
  }
  // files from a file box or a drop, where nothing can be renamed in place
  async function readEntries(list) {
    const entries = [];
    const walk = (en, rel) => new Promise((done) => {
      if (en.isFile) { en.file((f) => { if (!JUNK.test(f.name)) entries.push(entryOf(rel, f.name, f)); done(); }, () => done()); return; }
      if (JUNK_DIR.test(en.name)) { done(); return; }
      const rd = en.createReader(), kids = [];
      const more = () => rd.readEntries(async (got) => {
        if (got.length) { kids.push(...got); more(); return; }
        const here = rel ? `${rel}/${en.name}` : en.name;
        for (const k of kids) await walk(k, here);
        done();
      }, () => done());
      more();
    });
    for (const x of list) {
      if (x.entry) await walk(x.entry, '');
      else if (x.file && !JUNK.test(x.file.name)) {
        // a folder chosen in the file box: its own name first in webkitRelativePath
        const rel = (x.file.webkitRelativePath || '').split('/').slice(1, -1).join('/');
        entries.push(entryOf(rel, x.file.name, x.file));
      }
    }
    // one folder dropped: its insides are the top level
    const tops = new Set(entries.map((e) => e.dir.split('/')[0]));
    if (tops.size === 1 && !tops.has('')) { const t = [...tops][0]; for (const e of entries) e.dir = e.dir === t ? '' : e.dir.slice(t.length + 1); }
    return entries;
  }

  // the shots: one name for IMG_4678.CR3, IMG_4678.JPG, IMG_4678.xmp
  let groups = [];
  const collator = new Intl.Collator('zh-Hant-TW', { numeric: true, sensitivity: 'base' });
  function makeGroups() {
    const by = new Map();
    for (const e of src.entries) {
      const k = `${e.dir}\0${e.base.toLowerCase()}`;
      let g = by.get(k);
      if (!g) { g = { dir: e.dir, base: e.base, files: [], main: null, number: digitsOf(e.base), meta: null }; by.set(k, g); }
      g.files.push(e); e.group = g;
    }
    groups = [...by.values()];
    const rank = (e) => (RAW.test(e.type) ? 0 : PHOTO.test(e.type) ? 1 : /^XMP$/.test(e.type) ? 3 : 2);
    for (const g of groups) {
      g.files.sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name));
      g.main = g.files.find((e) => !/^XMP$/.test(e.type)) || g.files[0];
    }
    groups.sort((a, b) => collator.compare(a.dir, b.dir) || collator.compare(a.base, b.base));
  }
  // the number already in a name: the longest run of digits (IMG_4678-2 → 4678, 1K0A4537 → 4537), the last of equals
  function digitsOf(base) {
    let best = '';
    for (const m of base.matchAll(/\d+/g)) if (m[0].length >= best.length) best = m[0];
    return best;
  }

  // ---------- what's in each photo: when, which camera ----------
  // read only when the name needs it, the first part of each file (ZMeta from the photo tool, light)
  const meta = { busy: false, done: 0, all: 0, gen: 0 };
  const needsMeta = () => /\{(日期|時間|相機)\}/.test(S.tpl) || (/\{流水號\}/.test(S.tpl) && S.order === 'time');
  const tagOf = (tags, names) => {
    for (const n of names) for (const k in tags) if (k.endsWith(`:${n}`) && tags[k].val) return String(tags[k].val);
    return '';
  };
  async function readMeta() {
    if (meta.busy || !needsMeta() || !self.ZMeta) return;
    const todo = groups.filter((g) => !g.meta);
    if (!todo.length) return;
    meta.busy = true; meta.done = 0; meta.all = todo.length;
    const gen = meta.gen;
    let i = 0, last = 0;
    const one = async (g) => {
      const f = g.main.file, m = { cam: '', when: null };
      if (RAW.test(g.main.type) || PHOTO.test(g.main.type)) {
        try {
          const r = await ZMeta.read(f, { light: true });
          if (r) {
            const t = tagOf(r.tags, ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'DateCreated', 'ModifyDate']);
            const d = t.match(/^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d):(\d\d)/);
            if (d && d[1] !== '0000') m.when = { y: d[1], mo: d[2], d: d[3], h: d[4], mi: d[5], s: d[6], ts: Date.UTC(+d[1], d[2] - 1, +d[3], +d[4], +d[5], +d[6]) + (+(tagOf(r.tags, ['SubSecTimeOriginal']) || 0) / 1000) };
            m.cam = tagOf(r.tags, ['Model']).replace(/\s+/g, ' ').trim();
          }
        } catch { /* not readable: the file's own time */ }
      }
      if (!m.when) {
        const t = new Date(f.lastModified || 0), p = (x) => String(x).padStart(2, '0');
        m.when = { y: String(t.getFullYear()), mo: p(t.getMonth() + 1), d: p(t.getDate()), h: p(t.getHours()), mi: p(t.getMinutes()), s: p(t.getSeconds()), ts: Date.UTC(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds()), file: true };
      }
      g.meta = m;
      meta.done++;
      const now = Date.now();
      if (now - last > 250) { last = now; update(); }
    };
    const workers = Array.from({ length: 6 }, async () => { while (i < todo.length && gen === meta.gen) await one(todo[i++]); });
    await Promise.all(workers);
    if (gen !== meta.gen) return; // another folder came in meanwhile
    meta.busy = false;
    update();
  }

  // ---------- the rule ----------
  const SAVED = 'zr-rename';
  const S = { step: 1, tpl: '{號碼}', start: 1, pad: 3, order: 'time', datefmt: 'ymd', ext: 'keep', off: new Set(), show: 'all', ran: false, stale: false };
  try { Object.assign(S, JSON.parse(localStorage.getItem(SAVED)) || {}, { off: new Set(), show: 'all' }); } catch {}
  const remember = () => { try { localStorage.setItem(SAVED, JSON.stringify({ tpl: S.tpl, start: S.start, pad: S.pad, order: S.order, datefmt: S.datefmt, ext: S.ext })); } catch {} };
  const DATE = { ymd: (w) => `${w.y}${w.mo}${w.d}`, 'y-m-d': (w) => `${w.y}-${w.mo}-${w.d}`, ymd2: (w) => `${w.y.slice(2)}${w.mo}${w.d}` };
  const TOKEN = {
    號碼: (g) => g.number,
    流水號: (g) => String(g.seq).padStart(S.pad, '0'),
    日期: (g) => (g.meta ? DATE[S.datefmt](g.meta.when) : null),
    時間: (g) => (g.meta ? `${g.meta.when.h}${g.meta.when.mi}${g.meta.when.s}` : null),
    相機: (g) => (g.meta ? g.meta.cam : null),
    原檔名: (g) => g.base,
  };
  const WHY = { 號碼: '檔名裡沒有號碼', 相機: '讀不到相機型號', 日期: '讀不到日期', 時間: '讀不到時間' };
  // characters no system allows in a name, and Windows' trailing dots and spaces
  const clean = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  const extOf = (x) => (S.ext === 'lower' ? x.toLowerCase() : S.ext === 'upper' ? x.toUpperCase() : x);
  // → { base } or { wait } (still reading) or { bad: why }
  function baseFor(g) {
    let bad = '', wait = false;
    const out = S.tpl.replace(/\{([^{}]+)\}/g, (m, k) => {
      const f = TOKEN[k];
      if (!f) return m;
      const v = f(g);
      if (v === null) { wait = true; return ''; }
      if (!v) { bad = bad || WHY[k] || '讀不到'; return ''; }
      return clean(String(v));
    });
    if (wait) return { wait: true };
    if (bad) return { bad };
    const base = clean(out);
    if (!base) return { bad: '新檔名是空的' };
    if (base.length > 200) return { bad: '新檔名太長' };
    return { base };
  }

  // every file's new name. Two shots can't end up with one name in one folder, nor take the name of a file that stays:
  // the later one gets -2, -3… Shots whose name can't be made stay as they are.
  let plan = { rows: [], moves: [], counts: {} };
  function compute() {
    const on = (e) => !S.off.has(e.type);
    const live = groups.filter((g) => g.files.some(on));
    // order: by time (when known) or by name; the running number follows it
    const byName = (a, b) => collator.compare(a.dir, b.dir) || collator.compare(a.base, b.base);
    const ordered = S.order === 'time' && live.every((g) => g.meta) ? [...live].sort((a, b) => a.meta.when.ts - b.meta.when.ts || byName(a, b)) : live;
    ordered.forEach((g, i) => { g.seq = S.start + i; });
    // names taken in each folder: in place, every file in it that won't move; for a ZIP, nothing yet
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) {
        const t = new Set();
        if (src.kind === 'dir') {
          const moving = new Set(src.entries.filter((e) => e.dir === dir && on(e)).map((e) => e.name.toLowerCase()));
          for (const n of src.dirs.get(dir).names) if (!moving.has(n)) t.add(n);
        }
        taken.set(dir, t);
      }
      return taken.get(dir);
    };
    const res = new Map();
    for (const g of ordered) {
      const r = baseFor(g);
      res.set(g, r);
      if (!r.base) for (const e of g.files) if (on(e)) takenIn(g.dir).add(e.name.toLowerCase());
    }
    // shots already named this way keep their names; the others take theirs in order
    const on2 = (g) => g.files.filter(on);
    const keeps = (g) => { const r = res.get(g); return !!r.base && on2(g).every((e) => `${r.base}${extOf(e.inner)}${extOf(e.ext)}` === e.name); };
    const named = new Map();
    for (const g of [...ordered].sort((x, y) => keeps(y) - keeps(x))) {
      const r = res.get(g), files = on2(g);
      let state = r.wait ? 'wait' : r.bad ? 'bad' : '', sfx = '', names = files.map((e) => e.name);
      if (r.base) {
        const t = takenIn(g.dir);
        const want = (x) => files.map((e) => `${r.base}${x}${extOf(e.inner)}${extOf(e.ext)}`);
        for (let n = 2; want(sfx).some((nm) => t.has(nm.toLowerCase())); n++) sfx = `-${n}`;
        names = want(sfx);
        for (const nm of names) t.add(nm.toLowerCase());
        if (sfx) state = 'dup';
      }
      named.set(g, { files, names, state, sfx });
    }
    const counts = { files: 0, move: 0, same: 0, dup: 0, bad: 0, wait: 0 };
    const rows = [], moves = [];
    for (const g of ordered) {
      const r = res.get(g), { files, names, state, sfx } = named.get(g);
      counts.files += files.length;
      files.forEach((e, i) => {
        const same = names[i] === e.name;
        if (state === 'bad') counts.bad++; else if (state === 'wait') counts.wait++; else if (same) counts.same++; else { counts.move++; if (state === 'dup') counts.dup++; }
        if (!same && state !== 'bad' && state !== 'wait') moves.push({ dir: e.dir, from: e.name, to: names[i] });
        rows.push({ e, to: names[i], state: state || (same ? 'same' : ''), why: r.bad || '', sfx, side: e !== g.main });
      });
    }
    plan = { rows, moves, counts, live: ordered };
  }

  // ---------- steps ----------
  const STEP_NAMES = ['放入照片', '新檔名', '改名'];
  function allowed(n) {
    if (n === 1) return !run.busy;
    if (n === 2) return !!(src && src.entries.length) && !run.busy && !loading;
    return S.ran && !run.busy;
  }
  async function goto(n) {
    if (!allowed(n)) return;
    // renamed in place since: look at the folder again
    if (n === 2 && S.stale && src.kind === 'dir') { S.stale = false; await load(src.roots, 'dir'); return; }
    S.step = n;
    for (let i = 1; i <= 3; i++) $(`#step${i}`).hidden = i !== n;
    if (n === 2) { syncRule(); update(); readMeta(); }
    renderStepper();
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-goto]'); if (b && !b.disabled) goto(+b.dataset.goto); });
  $('#next1').addEventListener('click', () => goto(2));
  function renderStepper() {
    for (const b of $$('.stepper button')) {
      const n = +b.dataset.goto;
      b.classList.toggle('current', n === S.step);
      b.classList.toggle('done', n < S.step);
      b.disabled = !allowed(n);
      b.setAttribute('aria-current', n === S.step ? 'step' : 'false');
    }
    $('#mStep').replaceChildren(`步驟 ${S.step}／3・`, el('b', { text: STEP_NAMES[S.step - 1] }));
    $('#back3').disabled = !allowed(2);
  }

  // ---------- step 1: a folder ----------
  let loading = false;
  function reading(text) {
    $('#reading').hidden = !text;
    $('#step1').classList.toggle('busy', !!text);
    if (text) $('#readingText').textContent = text;
  }
  // roots: [{ handle, name }] to rename in place, or a list of { entry } / { file } for a ZIP
  async function load(list, kind) {
    loading = true;
    renderStepper();
    reading('正在看資料夾裡有什麼…');
    try {
      if (kind === 'dir') {
        const { entries, dirs } = await readDirs(list);
        src = { kind, name: list.length === 1 ? list[0].name : `${list.length} 個資料夾`, roots: list, entries, dirs };
      } else {
        const entries = await readEntries(list);
        const top = list.length === 1 && list[0].entry && list[0].entry.isDirectory ? list[0].entry.name
          : (list[0] && list[0].file && list[0].file.webkitRelativePath ? list[0].file.webkitRelativePath.split('/')[0] : '');
        src = { kind, name: top, roots: [], entries, dirs: null };
      }
    } catch (e) {
      console.error(e);
      src = null;
      toast('讀不到這個資料夾，請再選一次');
    }
    loading = false;
    reading('');
    if (src && !src.entries.length) { toast('這裡面沒有檔案'); src = null; }
    S.off = new Set();
    meta.gen++; meta.busy = false;
    if (src) makeGroups(); else groups = [];
    renderStep1();
    renderTypes();
    if (src) { S.step = 1; await goto(2); } else renderStepper();
  }
  function renderStep1() {
    const n = src ? src.entries.length : 0;
    $('#step1').classList.toggle('has-files', n > 0);
    $('#note1').textContent = !src ? '還沒有放入照片。' : `${src.name ? `「${src.name}」・` : ''}${num(groups.length)} 張・${num(n)} 個檔案`;
    $('#next1').disabled = !allowed(2);
  }
  function modeText() {
    $('#modeNote').replaceChildren(...(CAN_MOVE
      ? [el('b', { text: '直接改原本的檔案' }), '，改完可以復原。']
      : [el('b', { text: '原檔不會動' }), '：改好名的檔案打包成 ZIP 下載。', PHONE ? '' : '用電腦版 Chrome 或 Edge 可以直接改原檔。']));
    $('#how3b').textContent = CAN_MOVE ? '直接改好' : '下載改好的';
    $('#how3s').textContent = CAN_MOVE ? '原地改名，改錯可以復原' : '打包成 ZIP，原檔不動';
    $('#pickFiles').hidden = PHONE;
  }
  async function pickFolder() {
    if (!CAN_MOVE) { (PHONE ? $('#fileInput') : $('#dirInput')).click(); return; }
    let h;
    try { h = await window.showDirectoryPicker({ id: 'zr-rename', mode: 'readwrite', startIn: 'pictures' }); } catch (e) { if (e.name !== 'AbortError') toast('沒辦法打開這個資料夾'); return; }
    load([{ handle: h, name: h.name }], 'dir');
  }
  const drop = $('#drop');
  drop.addEventListener('click', pickFolder);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFolder(); } });
  $('#pickFiles').addEventListener('click', () => $('#fileInput').click());
  for (const id of ['#fileInput', '#dirInput']) {
    $(id).addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) load(fs.map((file) => ({ file })), 'files'); });
  }
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (S.step !== 1 || loading || !e.dataTransfer) return;
    // ask for everything now: a drop's items are gone once this handler returns
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const handles = CAN_MOVE && items.length && items[0].getAsFileSystemHandle ? items.map((i) => i.getAsFileSystemHandle()) : null;
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    const files = [...e.dataTransfer.files];
    (async () => {
      const hs = handles ? await Promise.all(handles.map((p) => p.catch(() => null))) : [];
      // folders only: rename them where they are; loose files: a ZIP
      if (hs.length && hs.every((h) => h && h.kind === 'directory')) return load(hs.map((h) => ({ handle: h, name: h.name })), 'dir');
      if (CAN_MOVE && hs.some((h) => h && h.kind === 'file')) toast('一個一個放的檔案會打包成 ZIP；要直接改原檔，請拖整個資料夾進來', 6000);
      if (entries.some(Boolean)) return load(entries.filter(Boolean).map((entry) => ({ entry })), 'files');
      if (files.length) return load(files.map((file) => ({ file })), 'files');
    })();
  });

  // ---------- step 2: the rule, and every file before → after ----------
  const tpl = $('#tpl');
  function syncRule() {
    tpl.value = S.tpl;
    $('#seqStart').value = S.start; $('#seqPad').value = S.pad;
    for (const [name, v] of [['order', S.order], ['datefmt', S.datefmt], ['ext', S.ext], ['show', S.show]]) {
      const r = $(`input[name="${name}"][value="${v}"]`);
      if (r) r.checked = true;
    }
  }
  tpl.addEventListener('input', () => { S.tpl = tpl.value; remember(); update(); readMeta(); });
  $('#tokens').addEventListener('click', (e) => {
    const b = e.target.closest('.token');
    if (!b) return;
    const a = tpl.selectionStart ?? tpl.value.length, z = tpl.selectionEnd ?? a;
    tpl.value = tpl.value.slice(0, a) + b.dataset.t + tpl.value.slice(z);
    tpl.focus();
    tpl.setSelectionRange(a + b.dataset.t.length, a + b.dataset.t.length);
    tpl.dispatchEvent(new Event('input'));
  });
  const intIn = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  $('#seqStart').addEventListener('input', (e) => { S.start = intIn(e.target.value, 0, 999999, 1); remember(); update(); });
  $('#seqPad').addEventListener('input', (e) => { S.pad = intIn(e.target.value, 1, 8, 3); remember(); update(); });
  document.addEventListener('change', (e) => {
    const r = e.target;
    if (r.type !== 'radio' || !['order', 'datefmt', 'ext', 'show'].includes(r.name)) return;
    S[r.name] = r.value;
    if (r.name === 'show') { $('#plist').scrollTop = 0; drawList(); return; }
    remember(); update(); readMeta();
  });

  function renderTypes() {
    if (!src) { fill($('#types')); return; }
    const by = new Map();
    for (const e of src.entries) by.set(e.type, (by.get(e.type) || 0) + 1);
    const types = [...by].sort((a, b) => b[1] - a[1]);
    fill($('#types'), ...types.map(([t, n]) => el('button', {
      type: 'button', class: 'type', 'aria-pressed': String(!S.off.has(t)), disabled: types.length === 1 ? '' : null,
      title: S.off.has(t) ? `${t} 不改` : `點一下不改 ${t}`,
      onclick: (e) => { if (S.off.has(t)) S.off.delete(t); else S.off.add(t); e.currentTarget.setAttribute('aria-pressed', String(!S.off.has(t))); update(); },
    }, t, el('small', { text: num(n) }))));
  }

  // everything that depends on the rule
  function update() {
    if (!src) return;
    compute();
    const c = plan.counts, inPlace = src.kind === 'dir';
    for (const b of $$('.token')) b.classList.toggle('on', S.tpl.includes(b.dataset.t));
    $('#seqSet').hidden = !/\{流水號\}/.test(S.tpl);
    $('#dateSet').hidden = !/\{日期\}/.test(S.tpl);
    const shots = plan.live.length;
    fill($('#srcLine'), `${src.name ? `「${src.name}」裡` : ''}${num(shots)} 張照片（${num(c.files)} 個檔案）・`,
      el('b', { text: inPlace ? '直接改原檔，可以復原' : '原檔不動，下載 ZIP' }));
    // the first one that changes, as the example
    const ex = plan.rows.find((r) => !r.side && (r.state === '' || r.state === 'dup' || r.state === 'wait')) || plan.rows.find((r) => !r.side && r.state !== 'same') || plan.rows[0];
    fill($('#example'), ex ? el('span', { class: 'ex-old', text: ex.e.name }) : null,
      ex ? (ex.state === 'bad' ? el('span', { class: 'ex-new bad', text: `${ex.why}：這種檔案不會改` })
        : ex.state === 'wait' ? el('span', { class: 'ex-new', text: '…' }) : el('span', { class: 'ex-new', text: `→ ${ex.to}` })) : null);
    tpl.classList.toggle('bad', !!ex && ex.state === 'bad' && c.move === 0);
    // the counts above the list
    const parts = [el('span', {}, '會改 ', el('b', { text: num(c.move) }), ' 個')];
    if (meta.busy) parts.push(el('span', {}, el('span', { class: 'spinner' }), ` 讀取拍攝資料 ${num(meta.done)}／${num(meta.all)}`));
    if (c.same) parts.push(el('span', {}, '不變 ', el('b', { text: num(c.same) })));
    if (c.dup) parts.push(el('span', { class: 'warn' }, '重複加了編號 ', el('b', { text: num(c.dup) })));
    if (c.bad) parts.push(el('span', { class: 'bad' }, '不會改 ', el('b', { text: num(c.bad) })));
    fill($('#pvSum'), ...parts);
    $('#warnTab').textContent = `要注意的 ${num(c.dup + c.bad)}`;
    $('#go').disabled = !c.move || meta.busy || c.wait > 0;
    $('#go').textContent = inPlace ? `開始改名 ${num(c.move)} 個檔案 →` : `打包下載（ZIP）→`;
    $('#note2').textContent = c.wait ? '正在讀取拍攝資料…' : !c.move ? '這個規則不會改到任何檔案' : inPlace ? '改完可以復原' : `原檔不會動・${fmtBytes(plan.rows.reduce((a, r) => a + r.e.file.size, 0))}`;
    drawList();
  }

  // the list: only the rows on screen are made
  const plist = $('#plist'), plistIn = $('#plistIn');
  let shown = [];
  function drawList() {
    shown = S.show === 'warn' ? plan.rows.filter((r) => r.state === 'dup' || r.state === 'bad') : plan.rows;
    const h = parseFloat(getComputedStyle(plist).getPropertyValue('--row')) || 38;
    const fileTime = /\{(日期|時間)\}/.test(S.tpl) || (/\{流水號\}/.test(S.tpl) && S.order === 'time');
    plistIn.style.height = `${shown.length * h}px`;
    if (!shown.length) { fill(plistIn, el('p', { class: 'plist-empty', text: S.show === 'warn' ? '沒有要注意的檔案' : '沒有要改的檔案' })); return; }
    const top = plist.scrollTop, a = Math.max(0, Math.floor(top / h) - 6), b = Math.min(shown.length, Math.ceil((top + plist.clientHeight) / h) + 6);
    const kids = [];
    for (let i = a; i < b; i++) {
      const r = shown[i];
      const g = r.e.group;
      const tag = r.state === 'bad' ? el('span', { class: 'tag bad', text: r.why })
        : r.state === 'dup' ? el('span', { class: 'tag warn', title: '同一個資料夾裡已經有這個名字', text: `重複，加了 ${r.sfx}` })
          : r.state === 'same' ? el('span', { class: 'tag', text: '不變' })
            : fileTime && g.meta && g.meta.when.file && !r.side ? el('span', { class: 'tag', title: '檔案裡沒有拍攝時間，用的是檔案的修改時間', text: '用檔案時間' }) : null;
      kids.push(el('div', { class: `pr ${r.state}`, style: `top:${i * h}px` },
        el('span', { class: 'old', title: r.e.dir ? `${r.e.dir}/${r.e.name}` : r.e.name }, r.e.dir ? el('i', { text: `${r.e.dir}/` }) : null, r.e.name),
        el('span', { class: 'arr', 'aria-hidden': 'true', text: '→' }),
        el('span', { class: 'new', title: r.to, text: r.state === 'wait' ? '…' : r.state === 'bad' ? r.e.name : r.to }),
        tag));
    }
    plistIn.replaceChildren(...kids);
  }
  let drawing = 0;
  plist.addEventListener('scroll', () => { if (!drawing) drawing = requestAnimationFrame(() => { drawing = 0; drawList(); }); });
  new ResizeObserver(() => { if (S.step === 2) drawList(); }).observe(plist);

  // ---------- step 3: rename ----------
  const run = { busy: false, done: 0, all: 0, log: [], fails: [], blob: null, zipName: '', mode: '' };
  $('#go').addEventListener('click', async () => {
    if (!src || !plan.moves.length || run.busy) return;
    if (src.kind === 'dir') {
      // permission to change the files: asked once, for the whole folder (the picker already asked)
      for (const r of src.roots) {
        let p = 'denied';
        try { p = await r.handle.queryPermission({ mode: 'readwrite' }); if (p !== 'granted') p = await r.handle.requestPermission({ mode: 'readwrite' }); } catch {}
        if (p !== 'granted') { toast('要允許「編輯檔案」才能改名'); return; }
      }
      renameAll(plan.moves, 'rename');
    } else zipAll();
  });
  window.addEventListener('beforeunload', (e) => { if (run.busy) { e.preventDefault(); e.returnValue = ''; } });

  function showRun() {
    S.ran = true; S.step = 3;
    for (let i = 1; i <= 3; i++) $(`#step${i}`).hidden = i !== 3;
    renderStepper();
  }
  function progress() {
    const p = run.all ? Math.round((run.done / run.all) * 100) : 0;
    $('#barFill').style.setProperty('--p', `${run.mode === 'zip' ? run.pct : p}%`);
    $('#bigNum').textContent = run.mode === 'zip' ? `${run.pct}%` : num(run.done);
    $('#bigOf').textContent = run.mode === 'zip' ? '' : `／ ${num(run.all)}`;
  }

  // in place, folder by folder. A name another file still has waits until that file has moved; a ring (A → B,
  // B → A) or a change of case only goes through a temporary name. A file never overwrites another.
  const ERR = { NotAllowedError: '沒有權限改這個檔案', NoModificationAllowedError: '檔案正在被其他程式使用', InvalidStateError: '檔案正在被其他程式使用', NotFoundError: '找不到這個檔案（被移走或改名了？）', exists: '已經有同名的檔案', copy: '複製時出錯，原檔沒有動' };
  let noMove = false;
  async function exists(dh, name) {
    try { await dh.getFileHandle(name); return true; } catch (e) { if (e.name === 'NotFoundError' || e.name === 'TypeError') return false; throw e; }
  }
  async function mv(dh, from, to) {
    const fh = await dh.getFileHandle(from);
    if (from.toLowerCase() !== to.toLowerCase() && await exists(dh, to)) throw new Error('exists');
    if (!noMove && typeof fh.move === 'function') {
      try { await fh.move(to); return; } catch (e) { if (e.name !== 'NotSupportedError' && !(e instanceof TypeError)) throw e; noMove = true; }
    }
    // no move() here: copy, check, then delete the original
    const file = await fh.getFile();
    const nh = await dh.getFileHandle(to, { create: true });
    try {
      const w = await nh.createWritable();
      await file.stream().pipeTo(w);
      if ((await nh.getFile()).size !== file.size) throw new Error('copy');
    } catch (e) { try { await dh.removeEntry(to); } catch {} throw e.message === 'copy' ? e : new Error('copy'); }
    await dh.removeEntry(from);
  }
  const tmpName = (name, i) => `.zr-${Date.now().toString(36)}-${i}${name.slice(name.lastIndexOf('.'))}`;
  async function renameIn(dir, ops, log, fails) {
    const dh = src.dirs.get(dir).handle;
    const names = new Set();
    for await (const n of dh.keys()) names.add(n.toLowerCase());
    let pending = ops.map((o) => ({ ...o, was: o.from })), t = 0;
    const tick = () => { run.done++; if (run.done % 25 === 0 || run.done === run.all) progress(); };
    while (pending.length) {
      const next = [];
      let moved = 0;
      for (const op of pending) {
        const lf = op.from.toLowerCase(), lt = op.to.toLowerCase();
        if (lf !== lt && names.has(lt)) { next.push(op); continue; }
        try {
          if (lf === lt) { const tmp = tmpName(op.from, t++); await mv(dh, op.from, tmp); await mv(dh, tmp, op.to); }
          else await mv(dh, op.from, op.to);
          names.delete(lf); names.add(lt);
          log.push({ dir, from: op.was, to: op.to });
        } catch (e) {
          console.error(e);
          fails.push({ dir, name: op.was, why: ERR[e.message] || ERR[e.name] || '改不了' });
        }
        moved++; tick();
      }
      if (!moved && next.length) {
        // waiting on a name no other move frees: someone else's file is there now
        const freed = new Set(next.map((o) => o.from.toLowerCase()));
        const stuck = next.filter((o) => !freed.has(o.to.toLowerCase()));
        if (stuck.length) {
          for (const o of stuck) { fails.push({ dir, name: o.was, why: ERR.exists }); tick(); }
          pending = next.filter((o) => !stuck.includes(o));
          continue;
        }
        // a ring: one steps aside
        const op = next[0], tmp = tmpName(op.from, t++);
        try { await mv(dh, op.from, tmp); names.delete(op.from.toLowerCase()); names.add(tmp.toLowerCase()); op.from = tmp; }
        catch (e) { fails.push({ dir, name: op.was, why: ERR[e.message] || ERR[e.name] || '改不了' }); next.shift(); tick(); }
      }
      pending = next;
    }
  }
  async function renameAll(ops, what) {
    run.busy = true; run.mode = what; run.done = 0; run.all = ops.length; run.fails = [];
    const log = [];
    showRun();
    $('#h3t').textContent = what === 'undo' ? '正在改回原本的檔名' : '正在改名';
    fill($('#bigWhat'), '不要關掉這個分頁');
    $('#doneLine').textContent = '';
    $('#after').hidden = true; $('#fails').hidden = true; $('#bar').classList.remove('done');
    progress();
    const byDir = new Map();
    for (const o of ops) { if (!byDir.has(o.dir)) byDir.set(o.dir, []); byDir.get(o.dir).push(o); }
    for (const [dir, list] of byDir) await renameIn(dir, list, log, run.fails);
    run.busy = false;
    S.stale = true;
    run.log = what === 'undo' ? [] : log;
    progress();
    $('#bar').classList.add('done');
    const where = src.name ? `「${src.name}」裡` : '';
    if (what === 'undo') {
      $('#h3t').textContent = '改回來了';
      fill($('#bigWhat'), `${where}的檔案都換回原本的名字。`);
      $('#doneLine').textContent = '可以回去換一個規則重新改。';
    } else {
      $('#h3t').textContent = run.fails.length ? `改好了，${num(run.fails.length)} 個沒改成` : '改好了';
      fill($('#bigWhat'), '個檔案換了新名字', where ? `（${where.slice(0, -1)}）` : '', '。');
      $('#doneLine').textContent = '改錯了可以按「復原」改回去；關掉這頁就不能復原了，需要的話先下載對照表。';
      count(log.length);
    }
    $('#bigNum').textContent = num(log.length);
    $('#bigOf').textContent = '';
    fill($('#fails'), ...run.fails.slice(0, 500).map((f) => el('li', {}, el('b', { text: f.dir ? `${f.dir}/${f.name}` : f.name }), `：${f.why}`)));
    $('#fails').hidden = !run.fails.length;
    $('#undo').hidden = what === 'undo' || !log.length;
    $('#again').hidden = true;
    $('#csv').hidden = what === 'undo' || !log.length;
    $('#after').hidden = false;
    renderStepper();
  }
  $('#undo').addEventListener('click', () => {
    if (run.busy || !run.log.length) return;
    renameAll(run.log.slice().reverse().map((x) => ({ dir: x.dir, from: x.to, to: x.from })), 'undo');
  });

  // a ZIP of renamed copies (every browser): the files are read once for their checksums, nothing big kept in memory
  async function zipAll() {
    const rows = plan.rows.filter((r) => r.state !== 'wait');
    const list = rows.map((r) => ({ name: r.e.dir ? `${r.e.dir}/${r.to}` : r.to, file: r.e.file }));
    const total = list.reduce((a, x) => a + x.file.size, 0);
    run.busy = true; run.mode = 'zip'; run.pct = 0; run.log = plan.moves.map((m) => ({ dir: m.dir, from: m.from, to: m.to }));
    showRun();
    $('#h3t').textContent = '正在打包';
    fill($('#bigWhat'), `${num(list.length)} 個檔案・${fmtBytes(total)}・不要關掉這個分頁`);
    $('#doneLine').textContent = '';
    $('#after').hidden = true; $('#fails').hidden = true; $('#bar').classList.remove('done');
    progress();
    try {
      run.blob = await ManyZip.files(list, (d, a) => { run.pct = a ? Math.floor((d / a) * 100) : 100; progress(); });
    } catch (e) {
      console.error(e);
      run.busy = false;
      $('#h3t').textContent = '打包失敗';
      fill($('#bigWhat'), '有檔案讀不到了（被移走或改名了？），請回到第一步重新放入。');
      renderStepper();
      return;
    }
    run.busy = false;
    run.zipName = `${src.name || '照片'}-改名.zip`;
    save(run.blob, run.zipName);
    run.pct = 100; progress();
    $('#bar').classList.add('done');
    $('#h3t').textContent = '開始下載了';
    fill($('#bigWhat'), el('b', { text: run.zipName }), `・${num(list.length)} 個檔案，其中 ${num(plan.moves.length)} 個換了新名字`);
    $('#doneLine').textContent = '原本的檔案沒有動。解壓縮之後，就是改好名的照片。';
    $('#bigNum').textContent = num(plan.moves.length);
    $('#bigOf').textContent = '個新檔名';
    $('#undo').hidden = true; $('#again').hidden = false; $('#csv').hidden = !run.log.length;
    $('#after').hidden = false;
    count(plan.moves.length);
    renderStepper();
  }
  function save(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  }
  $('#again').addEventListener('click', () => { if (run.blob) save(run.blob, run.zipName); });
  // before → after, for a spreadsheet (and for undoing by hand later)
  $('#csv').addEventListener('click', () => {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [['資料夾', '原本的檔名', '新的檔名'].map(q).join(','), ...run.log.map((x) => [x.dir || '.', x.from, x.to].map(q).join(','))];
    save(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${src && src.name ? src.name : '改名'}-對照表.csv`);
  });
  $('#restart').addEventListener('click', () => {
    if (run.busy) return;
    src = null; groups = []; S.ran = false; S.stale = false; run.log = []; run.blob = null;
    renderStep1(); renderTypes(); goto(1);
  });

  // ---------- the counter ----------
  // Only a number leaves the browser: how many files got a new name.
  function count(n) {
    if (!onServer || !n) return;
    fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ files: n }) })
      .then(loadStats).catch(() => {});
  }
  async function loadStats() {
    if (!onServer) return;
    try {
      const r = await fetch('api/stats', { cache: 'no-store' });
      const st = r.ok ? await r.json() : null;
      if (st && st.files > 0) fill($('#heroCount'), '已幫大家改了 ', el('b', { class: 'hero-num', text: num(st.files) }), ' 個檔名');
    } catch {}
  }

  modeText();
  loadStats();
  renderStep1();
  renderStepper();
})();
