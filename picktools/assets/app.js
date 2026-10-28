/* ZhuyuanLovePick — culling thousands of photos in the browser: what a photo team gets from Google Drive, picked by
   keyboard. Three steps: 1 ZIPs (Drive's download, as it is), folders or photos in → 2 one photo at a time, the way
   Lightroom Classic's Library does it: P 留用, X 排除, U takes the flag off, ← →, Z for 100 % (it stays on while you
   go through a burst), G for a grid, I for the photo's details in the corner → 3 the kept ones saved into a folder
   (Chrome, Edge) or a ZIP, one photo as itself.
   A ZIP is read where it lies: its directory, then each photo's first part for the time, camera and the little
   thumbnail the camera put in it. A photo is unpacked only to be shown or saved. Photos are sorted by when they were
   taken, everyone's together. The marks are kept in this browser (IndexedDB) by name and size, so the same photos
   dropped in again, unpacked or not, come back marked. Nothing is uploaded; on a server only the number of photos
   saved is reported. */
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
  if (onServer) $('#brand').href = '/photo';   // the home page's 拍攝 side
  const num = (n) => n.toLocaleString('zh-TW');
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const PHONE = matchMedia('(max-width: 640px), (pointer: coarse) and (max-width: 900px)').matches;
  // Safari (and every browser on an iPhone) shows HEIC itself; elsewhere the photo tool's libheif worker turns it into a picture
  const WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Android/.test(navigator.userAgent);
  // saving straight into a folder: Chrome and Edge on a computer
  const CAN_DIR = typeof window.showDirectoryPicker === 'function' && !PHONE;
  const collator = new Intl.Collator('zh-Hant-TW', { numeric: true, sensitivity: 'base' });

  let toastTimer;
  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- ZIP files, read where they lie ----------
  const bytesOf = async (blob, a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer());
  const u64 = (dv, p) => dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
  const strict = new TextDecoder('utf-8', { fatal: true }), loose = new TextDecoder('utf-8');
  let big5 = null;
  try { big5 = new TextDecoder('big5'); } catch {}
  // names are UTF-8 when flagged; Windows' own ZIPs here are often Big5
  const zipName = (b, flags) => { if (flags & 0x800) return loose.decode(b); try { return strict.decode(b); } catch { return (big5 || loose).decode(b); } };
  // → [{ zip, path, method, crc, csize, size, lho, mod, data }]   data: where the bytes start (-1: not looked yet)
  async function readZip(file) {
    const n = Math.min(file.size, 22 + 65535 + 20);
    const tail = await bytesOf(file, file.size - n, file.size), dv = new DataView(tail.buffer);
    let p = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { p = i; break; }
    if (p < 0) throw new Error('not a zip');
    let cdSize = dv.getUint32(p + 12, true), cdOff = dv.getUint32(p + 16, true);
    if ((dv.getUint16(p + 10, true) === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) && p >= 20 && dv.getUint32(p - 20, true) === 0x07064b50) {
      const at = u64(dv, p - 12);
      const r = await bytesOf(file, at, at + 56), rv = new DataView(r.buffer);
      if (rv.getUint32(0, true) === 0x06064b50) { cdSize = u64(rv, 40); cdOff = u64(rv, 48); }
    }
    const cd = await bytesOf(file, cdOff, cdOff + cdSize), cv = new DataView(cd.buffer);
    const out = [];
    for (let q = 0; q + 46 <= cd.length && cv.getUint32(q, true) === 0x02014b50;) {
      const flags = cv.getUint16(q + 8, true), method = cv.getUint16(q + 10, true), time = cv.getUint16(q + 12, true), date = cv.getUint16(q + 14, true);
      const crc = cv.getUint32(q + 16, true), nl = cv.getUint16(q + 28, true), xl = cv.getUint16(q + 30, true), cl = cv.getUint16(q + 32, true);
      let csize = cv.getUint32(q + 20, true), size = cv.getUint32(q + 24, true), lho = cv.getUint32(q + 42, true);
      // ZIP64: what didn't fit in 32 bits is in extra field 1, in this order
      for (let x = q + 46 + nl, xe = Math.min(x + xl, cd.length); x + 4 <= xe;) {
        const id = cv.getUint16(x, true), len = cv.getUint16(x + 2, true);
        if (id === 1) {
          let y = x + 4;
          if (size === 0xffffffff) { size = u64(cv, y); y += 8; }
          if (csize === 0xffffffff) { csize = u64(cv, y); y += 8; }
          if (lho === 0xffffffff) lho = u64(cv, y);
        }
        x += 4 + len;
      }
      const path = zipName(cd.subarray(q + 46, q + 46 + nl), flags);
      q += 46 + nl + xl + cl;
      // folders; locked entries and other packings can't be read
      if (path.endsWith('/') || flags & 1 || (method !== 0 && method !== 8)) continue;
      const mod = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
      out.push({ zip: file, path: path.replace(/\\/g, '/'), method, crc, csize, size, lho, mod, data: -1 });
    }
    return out;
  }
  async function dataStart(z) {
    if (z.data < 0) {
      const h = await bytesOf(z.zip, z.lho, z.lho + 30), v = new DataView(h.buffer);
      if (v.getUint32(0, true) !== 0x04034b50) throw new Error('zip entry');
      z.data = z.lho + 30 + v.getUint16(26, true) + v.getUint16(28, true);
    }
    return z.data;
  }
  // the first `max` bytes of a deflated piece that may stop mid-stream
  async function inflateHead(u8, max) {
    const r = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    let n = 0;
    try { while (n < max) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; } } catch { /* cut short: what came out is enough */ }
    r.cancel().catch(() => {});
    const out = new Uint8Array(n);
    let p = 0;
    for (const x of parts) { out.set(x, p); p += x.length; }
    return out;
  }
  const inflate = (blob) => new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();

  // ---------- the photos ----------
  // it: { key, name, path, dir, size, mod, src (its source), file | z, heic, t (when taken, wall clock as UTC ms),
  //       when (text), cam, lens, ss, fn, iso, fl (the exposure, as text), orient, w, h (as shown),
  //       thumb (Blob | null: none in the file | undefined: not read), turn (the thumbnail still needs the photo's
  //       orientation), n (place in the sorted list) }
  let items = [];
  const byKey = new Map();
  let sources = [];   // { id, name, kind: 'zip' | 'folder' | 'files', n }
  let skipped = { raw: 0, other: 0, same: 0 };
  let srcSeq = 0;
  const PHOTO = /\.(jpe?g|png|webp|gif|avif|heic|heif|hif)$/i;
  const HEIC = /\.(heic|heif|hif)$/i;
  const RAW = /\.(cr3|cr2|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|dng|srw|3fr|iiq|x3f|erf|mef|mos|kdc|dcr|rwl|gpr)$/i;
  const HIDDEN = (path) => path.split('/').some((s) => s.startsWith('.') || /^__MACOSX$/i.test(s));
  const keyOf = (name, size) => `${name.toLowerCase()}|${size}`;
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

  function addPhoto(found, src, path, size, mod, file, z) {
    if (HIDDEN(path)) return;
    const name = baseName(path);
    if (!PHOTO.test(name)) { if (RAW.test(name)) skipped.raw++; else if (!/^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(name)) skipped.other++; return; }
    const key = keyOf(name, size);
    if (byKey.has(key) || found.has(key)) { skipped.same++; return; }
    found.set(key, { key, name, path, dir: '', size, mod, src, file: file || null, z: z || null, heic: HEIC.test(name), t: null, when: '', cam: '', lens: '', ss: '', fn: '', iso: '', fl: '', orient: 1, w: 0, h: 0, thumb: undefined, turn: 1, n: 0 });
  }
  // a dropped folder, walked
  function walk(entry, found, src) {
    return new Promise((done) => {
      if (entry.isFile) {
        entry.file((f) => { addPhoto(found, src, entry.fullPath.replace(/^\//, ''), f.size, f.lastModified, f); done(); }, () => done());
        return;
      }
      if (HIDDEN(entry.name)) { done(); return; }
      const rd = entry.createReader(), kids = [];
      const more = () => rd.readEntries(async (got) => {
        if (got.length) { kids.push(...got); more(); return; }
        const files = kids.filter((k) => k.isFile);
        for (let i = 0; i < files.length; i += 64) await Promise.all(files.slice(i, i + 64).map((k) => walk(k, found, src)));
        for (const k of kids) if (!k.isFile) await walk(k, found, src);
        reading(`正在打開… ${num(found.size)} 張`);
        done();
      }, () => done());
      more();
    });
  }

  // a folder handle from the home page (Chrome, Edge): walked the same way
  async function walkDir(h, prefix, found, src) {
    const files = [], subs = [];
    for await (const [name, k] of h.entries()) { if (HIDDEN(name)) continue; (k.kind === 'file' ? files : subs).push([name, k]); }
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(files.slice(i, i + 64).map(async ([name, k]) => {
        try { const f = await k.getFile(); addPhoto(found, src, `${prefix}/${name}`, f.size, f.lastModified, f); } catch {}
      }));
    }
    reading(`正在打開… ${num(found.size)} 張`);
    for (const [name, k] of subs) await walkDir(k, `${prefix}/${name}`, found, src);
  }

  // list: [{ entry } | { file, path? } | { dir }] from a drop, the file boxes or the home page
  let loading = false;
  async function add(list) {
    if (loading || export_.busy) return;
    loading = true;
    const back = S.step;
    if (S.step !== 1) goto(1, true);
    renderStepper();
    reading('正在打開…');
    const found = new Map(), added = [];
    skipped = { raw: 0, other: 0, same: 0 };
    const loose = { id: ++srcSeq, name: '', kind: 'files', n: 0 };
    try {
      for (const x of list) {
        if (x.dir) {
          const src = { id: ++srcSeq, name: x.dir.name, kind: 'folder', n: 0 };
          const before = found.size;
          await walkDir(x.dir, x.dir.name, found, src);
          src.n = found.size - before;
          if (src.n) added.push(src);
          continue;
        }
        if (x.entry && x.entry.isDirectory) {
          const src = { id: ++srcSeq, name: x.entry.name, kind: 'folder', n: 0 };
          const before = found.size;
          await walk(x.entry, found, src);
          src.n = found.size - before;
          if (src.n) added.push(src);
          continue;
        }
        const f = x.file || await new Promise((r) => x.entry.file(r, () => r(null)));
        if (!f) continue;
        if (/\.zip$/i.test(f.name) || /zip/.test(f.type)) {
          const src = { id: ++srcSeq, name: f.name, kind: 'zip', n: 0 };
          let ents;
          try { ents = await readZip(f); } catch { toast(`「${f.name}」打不開，可能沒下載完`, 5000); continue; }
          const before = found.size;
          for (const z of ents) addPhoto(found, src, z.path, z.size, z.mod, null, z);
          src.n = found.size - before;
          if (src.n) added.push(src);
          continue;
        }
        // a file of a folder chosen in the file box carries its folder in webkitRelativePath (from the home page: path)
        const rel = (x.path && x.path.includes('/') ? x.path : f.webkitRelativePath) || '';
        if (rel) {
          const top = rel.split('/')[0];
          let src = added.find((s) => s.kind === 'folder' && s.name === top && s.box);
          if (!src) { src = { id: ++srcSeq, name: top, kind: 'folder', n: 0, box: true }; added.push(src); }
          const before = found.size;
          addPhoto(found, src, rel, f.size, f.lastModified, f);
          src.n += found.size - before;
        } else {
          const before = found.size;
          addPhoto(found, loose, f.name, f.size, f.lastModified, f);
          loose.n += found.size - before;
        }
      }
    } catch (e) { console.error(e); toast('有些檔案讀不到'); }
    if (loose.n) added.push(loose);
    const fresh = [...found.values()];
    if (fresh.length) {
      await readAll(fresh);
      for (const it of fresh) byKey.set(it.key, it);
      items = items.concat(fresh);
      sources = sources.concat(added.filter((s) => s.n));
      placeDirs();
      sortItems();
    }
    loading = false;
    reading('');
    const skip = [skipped.raw ? `${num(skipped.raw)} 個 RAW 檔` : '', skipped.other ? `${num(skipped.other)} 個不是照片的檔案` : '', skipped.same ? `${num(skipped.same)} 張重複的` : ''].filter(Boolean);
    if (!fresh.length) toast(skipped.same && !skipped.raw && !skipped.other ? '這些照片已經放進來了' : '裡面沒有找到照片（JPG、HEIC、PNG）', 5000);
    else if (skip.length) toast(`加了 ${num(fresh.length)} 張・略過 ${skip.join('、')}`, 5000);
    renderStep1();
    if (fresh.length) { rebuildView(back === 2 ? current() : firstOpen()); goto(2); } else if (back !== 1 && items.length) goto(back); else renderStepper();
  }
  // Folders are shown from where the photos part ways: "SITCON 2027/王小明/…" with everyone under "SITCON 2027"
  // reads as "王小明".
  function placeDirs() {
    const dirs = items.map((it) => it.path.split('/').slice(0, -1));
    let common = dirs.length ? dirs[0].length : 0;
    for (const d of dirs) { let k = 0; while (k < common && k < d.length && d[k] === dirs[0][k]) k++; common = k; }
    items.forEach((it, i) => { it.dir = dirs[i].slice(common).join('/'); });
  }
  function sortItems() {
    const byDir = (a, b) => collator.compare(a.dir, b.dir) || collator.compare(a.name, b.name);
    items.sort(S.sort === 'folder' ? byDir : (a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || byDir(a, b));
    items.forEach((it, i) => { it.n = i; });
  }

  // ---------- what's in each photo: when, which camera, its thumbnail ----------
  const HEAD = 196608;   // the EXIF reader's first look
  async function headOf(it) {
    if (it.file) return { file: it.file, bytes: null };
    const z = it.z, want = Math.min(z.csize, z.method ? HEAD + 65536 : HEAD);
    const buf = await bytesOf(z.zip, z.lho, z.lho + 30 + 4096 + want), v = new DataView(buf.buffer);
    if (v.getUint32(0, true) !== 0x04034b50) throw new Error('zip entry');
    const off = 30 + v.getUint16(26, true) + v.getUint16(28, true);
    z.data = z.lho + off;
    const raw = off + want <= buf.length ? buf.subarray(off, off + want) : await bytesOf(z.zip, z.data, z.data + want);
    const bytes = z.method ? await inflateHead(raw, HEAD) : raw;
    return { file: new File([bytes], it.name, { lastModified: z.mod }), bytes };
  }
  function tagsBy(tags) {
    const m = {};
    for (const k in tags) { const n = k.slice(k.indexOf(':') + 1); if (!(n in m)) m[n] = tags[k]; }
    return m;
  }
  const valOf = (e) => (e ? (e.num !== undefined ? e.num : e.val) : undefined);
  const pad2 = (x) => String(x).padStart(2, '0');
  async function readOne(it) {
    let r = null, head = null;
    try {
      head = await headOf(it);
      if (self.ZMeta) r = await ZMeta.read(head.file, { light: true, head: HEAD });
    } catch { /* unreadable: the file's own time, no thumbnail */ }
    const m = r ? tagsBy(r.tags) : {};
    const dt = String(valOf(m.DateTimeOriginal) || valOf(m.CreateDate) || '').match(/^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d):(\d\d)/);
    if (dt && dt[1] !== '0000') {
      const sub = String(valOf(m.SubSecTimeOriginal) ?? '').replace(/\D/g, '');
      it.t = Date.UTC(+dt[1], dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6]) + (sub ? +`0.${sub}` * 1000 : 0);
      it.when = `${+dt[2]}/${+dt[3]} ${dt[4]}:${dt[5]}:${dt[6]}`;
    } else {
      const d = new Date(it.mod || 0);
      it.t = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
      it.when = `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}（檔案時間）`;
    }
    it.cam = String(valOf(m.Model) || '').replace(/\s+/g, ' ').trim();
    it.lens = String(valOf(m.LensModel) || valOf(m.Lens) || '').replace(/\s+/g, ' ').trim();
    // as Lightroom writes them: 1/250 秒 (ƒ / 4.0)，ISO 2500 / 85 mm
    if (m.ExposureTime) it.ss = String(m.ExposureTime.val).replace(/ ?s$/, '');
    const fn = m.FNumber ? +valOf(m.FNumber) : 0;
    if (fn > 0) it.fn = fn >= 10 ? String(Math.round(fn)) : fn.toFixed(1);
    if (m.ISO) it.iso = String(valOf(m.ISO));
    const fl = m.FocalLength ? +valOf(m.FocalLength) : 0;
    if (fl > 0) it.fl = `${+fl.toFixed(1)} mm`;
    it.orient = clamp(+valOf(m.Orientation) || 1, 1, 8);
    const w = +valOf(m.ExifImageWidth) || +valOf(m.ImageWidth) || 0, h = +valOf(m.ExifImageHeight) || +valOf(m.ImageHeight) || 0;
    if (w > 0 && h > 0) { const side = it.orient >= 5; it.w = side ? h : w; it.h = side ? w : h; }
    it.thumb = null;
    const th = r && r.thumb;
    if (th && th.end > th.start && th.end - th.start < 300000) {
      if (it.file) it.thumb = it.file.slice(th.start, th.end, 'image/jpeg');
      else if (!it.z.method && head) it.thumb = it.z.zip.slice(it.z.data + th.start, it.z.data + th.end, 'image/jpeg');
      else if (head && head.bytes && th.end <= head.bytes.length) it.thumb = new Blob([head.bytes.slice(th.start, th.end)], { type: 'image/jpeg' });
      if (it.thumb) it.turn = it.orient;
    }
  }
  async function readAll(list) {
    let i = 0, done = 0, last = 0;
    const one = async () => {
      while (i < list.length) {
        const it = list[i++];
        await readOne(it);
        done++;
        const now = Date.now();
        if (now - last > 150) { last = now; reading(`讀取拍攝時間 ${num(done)}／${num(list.length)}`); }
      }
    };
    await Promise.all(Array.from({ length: 6 }, one));
  }

  // ---------- marks, kept in this browser ----------
  const marks = new Map();   // key → 1 留用 | -1 排除
  const db = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('zt-pick', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('marks');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    return {
      async load() {
        const d = await open();
        await new Promise((res) => {
          const rq = d.transaction('marks').objectStore('marks').openCursor();
          rq.onsuccess = () => { const c = rq.result; if (c) { marks.set(c.key, c.value); c.continue(); } else res(); };
          rq.onerror = () => res();
        });
      },
      async put(list) {   // [[key, 1 | -1 | 0]]
        const d = await open(), tx = d.transaction('marks', 'readwrite'), st = tx.objectStore('marks');
        for (const [k, v] of list) { if (v) st.put(v, k); else st.delete(k); }
        await new Promise((r) => { tx.oncomplete = tx.onerror = tx.onabort = r; });
      },
    };
  })();
  let kept = true;
  const markReady = db.load().catch(() => { kept = false; });
  function save(list) {
    db.put(list).catch(() => { if (kept) { kept = false; toast('這個瀏覽器記不住旗標（可能是無痕模式），關掉前記得存好', 6000); } });
  }
  const flagOf = (it) => marks.get(it.key) || 0;

  const undo = [];
  function mark(list, f, advance) {
    list = list.filter(Boolean);
    if (!list.length) return;
    const ch = list.map((it) => ({ it, from: flagOf(it), to: f })).filter((c) => c.from !== c.to);
    if (ch.length) {
      undo.push({ ch, at: current() });
      if (undo.length > 300) undo.shift();
      for (const c of ch) if (c.to) marks.set(c.it.key, c.to); else marks.delete(c.it.key);
      save(ch.map((c) => [c.it.key, c.to]));
    }
    flash(f, list.length);
    if (advance && list.length === 1) {
      if (pos < view.length - 1 || !matches(view[pos])) go(1);
      else toast('這是最後一張了');
    }
    refresh();
  }
  function doUndo() {
    const u = undo.pop();
    if (!u) { toast('沒有可以復原的'); return; }
    for (const c of u.ch) if (c.from) marks.set(c.it.key, c.from); else marks.delete(c.it.key);
    save(u.ch.map((c) => [c.it.key, c.from]));
    // back on the photo it was on, even if the filter had let it go
    const at = u.at || u.ch[0].it;
    if (!view.includes(at)) { view.splice(lowerBound(at), 0, at); }
    pos = view.indexOf(at);
    sel.clear();
    show();
    refresh();
    toast(u.ch.length > 1 ? `復原了 ${num(u.ch.length)} 張` : '復原了');
  }

  // ---------- what's shown: the filter, the folder, the order ----------
  const SAVED = 'zt-pick';
  const S = { step: 1, filter: 'all', folder: '', sort: 'time', auto: true, info: true, cell: 190, tip: true, grid: false, take: 'keep', lay: 'flat' };
  const KEPT = ['sort', 'auto', 'info', 'cell', 'tip', 'lay'];
  try { const o = JSON.parse(localStorage.getItem(SAVED)) || {}; for (const k of KEPT) if (k in o) S[k] = o[k]; } catch {}
  const remember = () => { try { localStorage.setItem(SAVED, JSON.stringify(Object.fromEntries(KEPT.map((k) => [k, S[k]])))); } catch {} };
  let view = [];   // the photos shown, in order
  let pos = 0;
  const sel = new Set();   // the grid's selection (beside the current one)
  const inFolder = (it) => !S.folder || it.dir === S.folder;
  const matches = (it) => inFolder(it) && (S.filter === 'all' || (S.filter === 'none' ? !flagOf(it) : flagOf(it) === (S.filter === 'keep' ? 1 : -1)));
  const current = () => view[pos] || null;
  const firstOpen = () => items.find((it) => !flagOf(it)) || items[0] || null;
  // where `it` would go in the view, by its place in the sorted list
  function lowerBound(it) { let a = 0, b = view.length; while (a < b) { const m = (a + b) >> 1; if (view[m].n < it.n) a = m + 1; else b = m; } return a; }
  function rebuildView(stay) {
    view = items.filter(matches);
    pos = 0;
    if (stay) { const i = view.indexOf(stay); pos = i >= 0 ? i : Math.min(lowerBound(stay), Math.max(0, view.length - 1)); }
    sel.clear();
  }
  // A photo that no longer fits the filter (marked while only unmarked ones show) stays until you move off it.
  function go(d) {
    if (!view.length) return;
    let next = pos + d;
    const from = view[pos];
    if (from && !matches(from)) { view.splice(pos, 1); if (d > 0) next = pos; }
    pos = clamp(next, 0, Math.max(0, view.length - 1));
    sel.clear();
    show();
    refresh();
  }
  function goTo(i) { const from = view[pos]; if (from && i !== pos && !matches(from)) { view.splice(pos, 1); if (i > pos) i--; } pos = clamp(i, 0, Math.max(0, view.length - 1)); show(); refresh(); }

  // ---------- steps ----------
  const STEP_NAMES = ['放入照片', '挑照片', '存下來'];
  function allowed(n) {
    if (export_.busy) return n === 3;
    if (n === 1) return true;
    if (n === 2) return items.length > 0 && !loading;
    return items.length > 0 && !loading && counts().keep + counts().none > 0;
  }
  function goto(n, force) {
    if (!force && !allowed(n)) return;
    const was = S.step;
    S.step = n;
    for (let i = 1; i <= 3; i++) $(`#step${i}`).hidden = i !== n;
    document.body.classList.toggle('culling', n === 2);
    if (n === 2) { if (was !== 2) { if (!current()) rebuildView(firstOpen()); requestAnimationFrame(() => { layout(); show(); refresh(); }); tip(); } }
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (n === 3) renderStep3();
    renderStepper();
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-goto]'); if (b && !b.disabled) goto(+b.dataset.goto); });
  $('#next1').addEventListener('click', () => goto(2));
  for (const b of $$('.go2')) b.addEventListener('click', () => goto(3));
  function renderStepper() {
    for (const b of $$('.stepper button')) {
      const n = +b.dataset.goto;
      b.classList.toggle('current', n === S.step);
      b.classList.toggle('done', n < S.step);
      b.disabled = n !== S.step && !allowed(n);
      b.setAttribute('aria-current', n === S.step ? 'step' : 'false');
    }
    $('#mStep').replaceChildren(`步驟 ${S.step}／3・`, el('b', { text: STEP_NAMES[S.step - 1] }));
  }

  // ---------- step 1 ----------
  function reading(text) {
    $('#reading').hidden = !text;
    $('#step1').classList.toggle('busy', !!text);
    if (text) $('#readingText').textContent = text;
  }
  function counts() {
    let keep = 0, drop = 0;
    for (const it of items) { const f = flagOf(it); if (f === 1) keep++; else if (f === -1) drop++; }
    return { all: items.length, keep, drop, none: items.length - keep - drop };
  }
  function renderStep1() {
    const n = items.length, c = counts();
    $('#step1').classList.toggle('has-files', n > 0);
    $('#sources').hidden = !n;
    $('#how').hidden = n > 0;
    fill($('#srcList'), ...sources.map((s) => el('li', { class: `src ${s.kind}` },
      el('span', { class: 'src-ic', 'aria-hidden': 'true', text: s.kind === 'zip' ? 'ZIP' : s.kind === 'folder' ? '▤' : '▢' }),
      el('span', { class: 'src-name', text: s.name || '一些照片' }),
      el('span', { class: 'src-n', text: `${num(s.n)} 張` }),
      el('button', { type: 'button', class: 'icon-btn src-x', 'aria-label': `拿掉 ${s.name || '這些照片'}`, title: '拿掉', onclick: () => removeSource(s), text: '×' }))));
    const done = c.keep + c.drop;
    fill($('#srcSum'), '共 ', el('b', { text: num(n) }), ' 張照片', done ? el('span', {}, '・已經標了 ', el('b', { text: num(done) }), ' 張，會接著挑・') : null,
      done ? el('button', { type: 'button', class: 'link-btn', onclick: clearMarks, text: '清掉這些照片的旗標' }) : null);
    $('#drop .drop-title .d-desk').textContent = n ? '再加 ZIP 或資料夾：拖進這裡' : '把 ZIP 或資料夾拖進這裡';
    $('#note1').replaceChildren(...(!n ? ['還沒有放入照片。'] : ['共 ', el('b', { text: num(n) }), ` 張・${sources.length} 個來源`]));
    $('#next1').disabled = !allowed(2);
    $('#next1').textContent = done ? '接著挑 →' : '開始挑 →';
    renderFolders();
    $('#sort').value = S.sort;
  }
  function removeSource(s) {
    if (loading) return;
    sources = sources.filter((x) => x !== s);
    items = items.filter((it) => { if (it.src !== s) return true; byKey.delete(it.key); forget(it); return false; });
    placeDirs(); sortItems();
    if (S.folder && !items.some((it) => it.dir === S.folder)) S.folder = '';
    rebuildView(firstOpen());
    renderStep1(); renderStepper();
  }
  function clearMarks() {
    const c = counts();
    if (!confirm(`清掉這 ${num(items.length)} 張照片的旗標（留用 ${num(c.keep)}、排除 ${num(c.drop)}）？`)) return;
    const ch = items.filter(flagOf).map((it) => ({ it, from: flagOf(it), to: 0 }));
    for (const x of ch) marks.delete(x.it.key);
    save(ch.map((x) => [x.it.key, 0]));
    undo.push({ ch, at: null });
    rebuildView(items[0]);
    renderStep1();
    toast('旗標清掉了（挑照片時按 ⌘Z 可以復原）');
  }
  const drop = $('#drop');
  const pickFiles = () => $('#fileInput').click();
  drop.addEventListener('click', pickFiles);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(); } });
  $('#pickFiles').addEventListener('click', pickFiles);
  $('#pickDir').addEventListener('click', () => $('#dirInput').click());
  $('#pickDir').hidden = PHONE;
  for (const id of ['#fileInput', '#dirInput']) {
    $(id).addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) add(fs.map((file) => ({ file }))); });
  }
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'));
  window.addEventListener('dragover', (e) => e.preventDefault());
  // anywhere on the page, in step 1 or 2: more photos
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (S.step === 3 || loading || !e.dataTransfer) return;
    const its = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const entries = its.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    const files = [...e.dataTransfer.files];
    if (entries.length && entries.every(Boolean)) add(entries.map((entry) => ({ entry })));
    else if (files.length) add(files.map((file) => ({ file })));
  });

  // ---------- step 2: the photo ----------
  const stage = $('#stage'), frame = $('#frame');
  let fit = { left: 0, top: 0, w: 1, h: 1, s: 1 };
  const Z = { on: false, k: 1, x: 0, y: 0, cx: 0.5, cy: 0.5 };   // zoom over the fitted photo; cx, cy: the spot looked at
  const ORIENT = { 1: '', 2: 'scaleX(-1)', 3: 'rotate(180deg)', 4: 'scaleY(-1)', 5: 'scaleX(-1) rotate(90deg)', 6: 'rotate(90deg)', 7: 'rotate(90deg) scaleX(-1)', 8: 'rotate(-90deg)' };
  const dpr = () => window.devicePixelRatio || 1;
  // the photo's own size, as shown: from the decoded picture, else the camera's numbers, else its thumbnail's shape
  const dims = (it) => (it.w && it.h ? [it.w, it.h] : [3, 2]);
  function layout() {
    const it = current();
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!it || !W || !H) return;
    const [w, h] = dims(it);
    const s = Math.min(W / w, H / h);
    fit = { left: Math.round((W - w * s) / 2), top: Math.round((H - h * s) / 2), w: Math.round(w * s), h: Math.round(h * s), s };
    Object.assign(frame.style, { left: `${fit.left}px`, top: `${fit.top}px`, width: `${fit.w}px`, height: `${fit.h}px` });
    const ph = frame.querySelector('.ph');
    if (ph) {
      const side = it.turn >= 5;
      Object.assign(ph.style, { width: `${side ? fit.h : fit.w}px`, height: `${side ? fit.w : fit.h}px`, transform: `translate(-50%, -50%) ${ORIENT[it.turn] || ''}` });
    }
    if (Z.on) zoomAtSpot(false);
    else { Z.k = 1; Z.x = 0; Z.y = 0; apply(false); }
  }
  // 100 %: a pixel of the photo on a pixel of the screen (at least twice the fitted size)
  const k100 = () => { const it = current(); return Math.max(2, (it && it.w ? it.w / fit.w : 1) / dpr()); };
  function apply(animate) {
    frame.classList.toggle('glide', !!animate);
    frame.style.transform = `translate(${Z.x}px, ${Z.y}px) scale(${Z.k})`;
    stage.classList.toggle('zoomed', Z.on);
    const z = $('#stZoom');
    z.hidden = !Z.on;
    if (Z.on) z.textContent = `${Math.round((Z.k * fit.w * dpr()) / (current().w || fit.w) * 100)}%`;
    $('#bZoom').textContent = Z.on ? '全圖' : '100%';
    $('#bZoom').title = Z.on ? '回到全圖（Z 或空白鍵）' : '放大到 100%（Z 或空白鍵）';
  }
  function clampPan() {
    const W = stage.clientWidth, H = stage.clientHeight, w = fit.w * Z.k, h = fit.h * Z.k;
    Z.x = w <= W ? (W - w) / 2 - fit.left : clamp(Z.x, W - fit.left - w, -fit.left);
    Z.y = h <= H ? (H - h) / 2 - fit.top : clamp(Z.y, H - fit.top - h, -fit.top);
    // the spot in the middle of the screen, kept for the next photo
    Z.cx = clamp((W / 2 - fit.left - Z.x) / (fit.w * Z.k), 0, 1);
    Z.cy = clamp((H / 2 - fit.top - Z.y) / (fit.h * Z.k), 0, 1);
  }
  // zoom to k with the photo's point under (px, py) staying there
  function zoomAt(k, px, py, animate) {
    const u = (px - fit.left - Z.x) / Z.k, v = (py - fit.top - Z.y) / Z.k;
    Z.k = k; Z.x = px - fit.left - u * k; Z.y = py - fit.top - v * k;
    Z.on = k > 1.001;
    clampPan();
    if (!Z.on) { Z.k = 1; Z.x = 0; Z.y = 0; }
    apply(animate);
  }
  // after moving on: the same spot of the next photo, at 100 %
  function zoomAtSpot(animate) {
    const W = stage.clientWidth, H = stage.clientHeight;
    Z.k = k100();
    Z.x = W / 2 - fit.left - Z.cx * fit.w * Z.k; Z.y = H / 2 - fit.top - Z.cy * fit.h * Z.k;
    clampPan(); apply(animate);
  }
  function toggleZoom(px, py) {
    if (!current()) return;
    if (Z.on) { Z.on = false; Z.k = 1; Z.x = 0; Z.y = 0; apply(true); return; }
    const W = stage.clientWidth, H = stage.clientHeight;
    zoomAt(k100(), px ?? W / 2, py ?? H / 2, true);
    full(current());
  }

  // pictures: an <img> for each photo near the current one, decoded ahead; the thumbnail stands in meanwhile
  const KEEP = PHONE ? 3 : WEBKIT ? 4 : 6;
  const pics = new Map();   // it → { img, url, ready, ok }
  let heicWorker = null, heicSeq = 0, heicIdle = 0;
  const heicJobs = new Map();
  function heicJpeg(it, maxSide) {
    if (!heicWorker) {
      heicWorker = new Worker(onServer ? '/exif/assets/heic.js' : '../exiftools/assets/heic.js');
      heicWorker.onmessage = ({ data }) => { const j = heicJobs.get(data.id); if (j) { heicJobs.delete(data.id); data.error ? j.rej(new Error(data.error)) : j.res(data); } };
    }
    clearTimeout(heicIdle);
    return blobOf(it).then((b) => new Promise((res, rej) => {
      const id = ++heicSeq;
      heicJobs.set(id, { res, rej });
      heicWorker.postMessage({ id, file: b instanceof File ? b : new File([b], it.name), maxSide, p3: false });
    })).then(async ({ bmp }) => {
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    }).finally(() => { clearTimeout(heicIdle); heicIdle = setTimeout(() => { if (!heicJobs.size && heicWorker) { heicWorker.terminate(); heicWorker = null; } }, 20000); });
  }
  const unpacked = new Map();   // it → Promise<Blob>: deflated photos, the last few
  function blobOf(it) {
    if (it.file) return Promise.resolve(it.file);
    const z = it.z;
    if (!z.method) return dataStart(z).then((d) => z.zip.slice(d, d + z.csize));
    let p = unpacked.get(it);
    if (p) unpacked.delete(it);
    else p = dataStart(z).then((d) => inflate(z.zip.slice(d, d + z.csize)));
    unpacked.set(it, p);
    while (unpacked.size > KEEP + 2) unpacked.delete(unpacked.keys().next().value);
    return p;
  }
  function pic(it) {
    let p = pics.get(it);
    if (p) { pics.delete(it); pics.set(it, p); return p; }
    const img = new Image();
    img.className = 'photo'; img.alt = ''; img.draggable = false; img.decoding = 'async';
    p = { img, url: null, ok: false };
    p.ready = (async () => {
      const b = it.heic && !WEBKIT ? await heicJpeg(it, 4096) : await blobOf(it);
      if (!pics.has(it)) return false;
      p.url = URL.createObjectURL(b);
      img.src = p.url;
      await img.decode();
      if (img.naturalWidth) { it.w = img.naturalWidth; it.h = img.naturalHeight; }
      p.ok = true;
      return true;
    })().catch(() => false);
    pics.set(it, p);
    for (const [k, old] of pics) {
      if (pics.size <= KEEP) break;
      if (k === current()) continue;
      pics.delete(k);
      old.img.removeAttribute('src');
      if (old.url) URL.revokeObjectURL(old.url);
    }
    return p;
  }
  function forget(it) {
    const p = pics.get(it);
    if (p) { pics.delete(it); p.img.removeAttribute('src'); if (p.url) URL.revokeObjectURL(p.url); }
    if (it.thumbUrl) { URL.revokeObjectURL(it.thumbUrl); it.thumbUrl = null; }
    unpacked.delete(it);
  }
  function full(it) { if (it) pic(it); }

  let showGen = 0, preTimer = 0;
  function show() {
    const it = current();
    const gen = ++showGen;
    $('#stEmpty').hidden = !!it;
    if (!it) {
      frame.replaceChildren();
      $('#stEmpty').textContent = !items.length ? '還沒有照片' : S.filter === 'none' ? '這裡的照片都標好了' : '這裡沒有照片';
      info(null);
      drawStrip(); drawGrid(); queueSecond();
      return;
    }
    const p = pic(it);
    const kids = [];
    if (!p.ok) {
      const t = thumbUrl(it);
      if (t) kids.push(el('img', { class: 'ph', src: t, alt: '' }));
      else wantThumb(it);
    }
    kids.push(p.img);
    p.img.classList.toggle('in', p.ok);
    frame.replaceChildren(...kids);
    layout();
    if (!p.ok) {
      stage.classList.add('loading');
      p.ready.then((ok) => {
        if (gen !== showGen) return;
        stage.classList.remove('loading');
        if (!ok) { $('#stEmpty').hidden = false; $('#stEmpty').textContent = '這張打不開'; return; }
        layout();
        p.img.classList.add('in');
        const ph = frame.querySelector('.ph');
        if (ph) setTimeout(() => { if (gen === showGen) ph.remove(); }, 200);
      });
    } else stage.classList.remove('loading');
    info(it);
    drawStrip(); drawGrid(); queueSecond();
    // the next ones (and the one before), once you stop for a moment
    clearTimeout(preTimer);
    preTimer = setTimeout(async () => {
      for (const d of [1, 2, -1, 3]) {
        if (gen !== showGen) return;
        const n = view[pos + d];
        if (n) await pic(n).ready;
      }
    }, p.ok ? 60 : 160);
  }
  // the photo's details in the top-left corner, as Lightroom's info overlay: name, exposure, lens, then when and whose
  function details(it) {
    const exp = [it.ss ? [el('span', { class: 'frac', text: it.ss }), ' 秒'] : [], it.fn ? `${it.ss ? ' ' : ''}(ƒ / ${it.fn})` : '', it.iso ? `${it.ss || it.fn ? '，' : ''}ISO ${it.iso}` : ''].flat().filter(Boolean);
    return [
      el('b', { text: it.name }),
      exp.length ? el('span', {}, ...exp) : null,
      it.fl || it.lens ? el('span', { text: it.fl && it.lens ? `${it.fl} (${it.lens})` : it.fl || it.lens }) : null,
      el('span', { text: [it.when, it.cam, it.dir].filter(Boolean).join('・') }),
    ];
  }
  function info(it) {
    const f = it ? flagOf(it) : 0;
    $('#ovFlag').className = `ov-flag${f === 1 ? ' is-keep' : f === -1 ? ' is-drop' : ''}`;
    for (const [b, on] of [[$('#bKeep'), f === 1], [$('#bDrop'), f === -1]]) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.disabled = !it; }
    if (it) fill($('#ov'), ...details(it)); else fill($('#ov'));
    fill($('#stPos'), ...(it ? [el('b', { text: `第 ${num(pos + 1)}／${num(view.length)} 張` }), `・${it.name}`] : []));
  }
  // "標示為留用", Lightroom's word for it, in the middle for a moment
  const SAID = { 1: '標示為留用', '-1': '設為排除', 0: '取消旗標' };
  function flash(f, n = 1) {
    const m = $('#stMsg');
    m.className = 'st-msg';
    void m.offsetWidth;
    fill(m, el('i', { 'aria-hidden': 'true' }), n > 1 ? `${num(n)} 張${SAID[f]}` : SAID[f]);
    m.className = `st-msg ${f === 1 ? 'is-keep' : f === -1 ? 'is-drop' : 'is-none'} on`;
  }
  function setInfo(on) {
    S.info = on;
    remember();
    $('#step2').classList.toggle('no-info', !on);
    $('#bInfo').classList.toggle('on', on);
    $('#bInfo').setAttribute('aria-pressed', String(on));
  }
  setInfo(S.info);

  // ---------- thumbnails: the camera's own, else made from the photo (one at a time, the ones on screen first) ----------
  function thumbUrl(it) {
    if (!it.thumbUrl && it.thumb) it.thumbUrl = URL.createObjectURL(it.thumb);
    return it.thumbUrl || null;
  }
  const thumbQ = [];
  let thumbBusy = false;
  function wantThumb(it) {
    if (it.thumb || it.thumbTried) return;
    const i = thumbQ.indexOf(it);
    if (i >= 0) thumbQ.splice(i, 1);
    thumbQ.push(it);
    if (thumbQ.length > 200) thumbQ.shift();
    pumpThumbs();
  }
  async function pumpThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    while (thumbQ.length) {
      const it = thumbQ.pop();
      if (it.thumb || it.thumbTried || !byKey.has(it.key)) continue;
      it.thumbTried = true;
      try {
        const b = it.heic && !WEBKIT ? await heicJpeg(it, 320) : await blobOf(it);
        const img = new Image();
        const url = URL.createObjectURL(b);
        img.src = url;
        await img.decode();
        const s = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, c.width, c.height);
        if (!it.w && !it.heic) { it.w = img.naturalWidth; it.h = img.naturalHeight; }
        img.removeAttribute('src');
        URL.revokeObjectURL(url);
        it.thumb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
        it.turn = 1;
        for (const d of [document, ...(swOpen() ? [sw.document] : [])]) for (const n of $$(`[data-k="${CSS.escape(it.key)}"] img`, d)) { n.src = thumbUrl(it); n.style.transform = ''; }
      } catch { /* stays blank */ }
    }
    thumbBusy = false;
  }
  function thumbImg(it) {
    const u = thumbUrl(it);
    if (!u) { wantThumb(it); return el('img', { alt: '', draggable: 'false' }); }
    const t = it.turn > 1 ? ORIENT[it.turn] : '';
    return el('img', { src: u, alt: '', draggable: 'false', style: t ? `transform: ${t}` : null });
  }
  const cellClass = (it, base) => {
    const f = flagOf(it);
    return `${base}${f === 1 ? ' is-keep' : f === -1 ? ' is-drop' : ''}${it === current() ? ' cur' : ''}${sel.has(it) ? ' picked' : ''}`;
  };

  // ---------- the strip under the photo (only what's on screen is made: thousands of photos) ----------
  const strip = $('#strip'), stripIn = $('#stripIn');
  const cellW = () => parseFloat(getComputedStyle(strip).getPropertyValue('--cell')) || 76;
  let stripPos = -1;
  function drawStrip(follow = true) {
    if (S.step !== 2 || S.grid) return;
    const cw = cellW(), W = strip.clientWidth;
    stripIn.style.width = `${view.length * cw}px`;
    if (follow && stripPos !== pos) {
      // keep the current one in view, a few cells from the edge
      const x = pos * cw, l = strip.scrollLeft;
      if (x < l + cw * 2 || x > l + W - cw * 3) strip.scrollLeft = x - W / 2 + cw / 2;
      stripPos = pos;
    }
    const l = strip.scrollLeft, a = Math.max(0, Math.floor(l / cw) - 4), b = Math.min(view.length, Math.ceil((l + W) / cw) + 4);
    const kids = [];
    for (let i = a; i < b; i++) {
      const it = view[i];
      kids.push(el('button', { type: 'button', class: cellClass(it, 'cell'), style: `left:${i * cw}px`, 'data-i': i, 'data-k': it.key, tabindex: '-1', title: it.name }, thumbImg(it)));
    }
    stripIn.replaceChildren(...kids);
  }
  strip.addEventListener('scroll', () => drawStrip(false), { passive: true });
  strip.addEventListener('click', (e) => { const c = e.target.closest('.cell'); if (c) goTo(+c.dataset.i); });
  // a mouse wheel scrolls the strip sideways
  strip.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

  // ---------- the grid ----------
  const grid = $('#grid'), gridIn = $('#gridIn');
  let cols = 1, gridPos = -1;
  function gridSize() {
    const W = grid.clientWidth - 16, min = PHONE ? 104 : 168;
    cols = Math.max(1, Math.floor(W / min));
    const cw = W / cols;
    return { cw, ch: Math.round(cw * 0.86) + 22 };
  }
  function drawGrid(follow = true) {
    if (S.step !== 2 || !S.grid) return;
    const { cw, ch } = gridSize(), H = grid.clientHeight;
    const rows = Math.ceil(view.length / cols);
    gridIn.style.height = `${rows * ch + 16}px`;
    if (follow && gridPos !== pos) {
      const y = Math.floor(pos / cols) * ch, t = grid.scrollTop;
      if (y < t) grid.scrollTop = y; else if (y + ch > t + H) grid.scrollTop = y + ch - H + 16;
      gridPos = pos;
    }
    const t = grid.scrollTop, a = Math.max(0, (Math.floor(t / ch) - 2) * cols), b = Math.min(view.length, (Math.ceil((t + H) / ch) + 2) * cols);
    const kids = [];
    for (let i = a; i < b; i++) {
      const it = view[i];
      kids.push(el('button', { type: 'button', class: cellClass(it, 'gcell'), tabindex: '-1', 'data-i': i, 'data-k': it.key, title: `${it.name}${it.dir ? `・${it.dir}` : ''}`,
        style: `left:${8 + (i % cols) * cw}px;top:${8 + Math.floor(i / cols) * ch}px;width:${cw - 8}px;height:${ch - 8}px` },
      el('span', { class: 'g-pic' }, thumbImg(it)), el('span', { class: 'g-name', text: it.name })));
    }
    gridIn.replaceChildren(...kids);
  }
  grid.addEventListener('scroll', () => drawGrid(false), { passive: true });
  let anchor = null;
  grid.addEventListener('click', (e) => {
    const c = e.target.closest('.gcell');
    if (!c) return;
    const i = +c.dataset.i, it = view[i];
    if (e.shiftKey) {
      const a = view.indexOf(anchor || current()), lo = Math.min(a, i), hi = Math.max(a, i);
      sel.clear();
      for (let k = lo; k <= hi; k++) sel.add(view[k]);
      pos = i;
    } else if (e.metaKey || e.ctrlKey) {
      if (!sel.size && current()) sel.add(current());
      if (sel.has(it)) sel.delete(it); else sel.add(it);
      pos = i; anchor = it;
    } else { sel.clear(); pos = i; anchor = it; }
    show(); refresh();
  });
  grid.addEventListener('dblclick', (e) => { if (e.target.closest('.gcell')) setGrid(false); });
  function setGrid(on) {
    if (S.grid === on || !items.length) return;
    S.grid = on;
    if (!on) sel.clear();
    $('#grid').hidden = !on;
    stage.hidden = on;
    strip.hidden = on;
    $('#bGrid').classList.toggle('on', on);
    $('#bLoupe').classList.toggle('on', !on);
    $('#bZoom').hidden = on;
    stripPos = gridPos = swPos = -1;
    requestAnimationFrame(() => { if (on) { drawGrid(); grid.focus({ preventScroll: true }); } else { layout(); show(); } refresh(); });
  }
  $('#bGrid').addEventListener('click', () => setGrid(true));
  $('#bLoupe').addEventListener('click', () => setGrid(false));
  const targets = () => (sel.size > 1 ? view.filter((it) => sel.has(it)) : current() ? [current()] : []);

  // ---------- the second window: every photo as a grid, for another screen (Lightroom's secondary display) ----------
  // second.html is an empty page; this window draws into it (it has the photos, and the thumbnails' blob: addresses
  // work there too), keeps the photo you're on in sight, and takes its clicks and keys back. Only the cells on screen
  // exist, as in the grid here.
  let sw = null, swPos = -1, swCols = 1, swQueued = false;
  const swOpen = () => !!sw && !sw.closed;
  const FILTER_NAME = { keep: '留用', none: '未標記', drop: '排除' };
  function secondButton() {
    const on = swOpen();
    $('#bSecond').classList.toggle('on', on);
    $('#bSecond').setAttribute('aria-pressed', String(on));
  }
  function toggleSecond() {
    if (swOpen()) { sw.close(); sw = null; secondButton(); return; }
    const w = window.open('second.html', 'zt-pick-second', `popup,width=${Math.min(screen.availWidth, 1280)},height=${Math.min(screen.availHeight, 820)}`);
    if (!w) { toast('瀏覽器擋下了新視窗：請允許這個網站開彈出式視窗', 5000); return; }
    // two screens (Chrome, Edge): put it on the other one, full size (the browser asks first)
    if (screen.isExtended && window.getScreenDetails) {
      window.getScreenDetails().then((d) => {
        const other = d.screens.find((x) => x !== d.currentScreen);
        if (other && !w.closed) { w.moveTo(other.availLeft, other.availTop); w.resizeTo(other.availWidth, other.availHeight); }
      }).catch(() => {});
    }
  }
  // second.html calls this when it's loaded (or reloaded)
  function attachSecond(w) {
    sw = w; swPos = -1;
    const d = w.document, g = d.getElementById('sGrid');
    g.addEventListener('scroll', () => drawSecond(false), { passive: true });
    w.addEventListener('resize', () => drawSecond(false));
    g.addEventListener('click', (e) => { const c = e.target.closest('.c'); if (c) { sel.clear(); goTo(+c.dataset.i); } });
    g.addEventListener('dblclick', (e) => { if (e.target.closest('.c') && S.grid) setGrid(false); });
    const size = (k) => { S.cell = clamp(Math.round(S.cell * k), 110, 420); remember(); swPos = -1; drawSecond(); };
    const full = () => { if (d.fullscreenElement) d.exitFullscreen().catch(() => {}); else d.documentElement.requestFullscreen().catch(() => {}); };
    d.getElementById('sSmaller').addEventListener('click', () => size(1 / 1.2));
    d.getElementById('sBigger').addEventListener('click', () => size(1.2));
    d.getElementById('sFull').addEventListener('click', full);
    // its keys work as they do here; ↑ ↓ move a row of its own grid (here they'd flag)
    w.addEventListener('keydown', (e) => {
      const k = e.key, plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (plain && (k === 'f' || k === 'F')) { e.preventDefault(); full(); return; }
      if (plain && (k === '-' || k === '+' || k === '=')) { e.preventDefault(); size(k === '-' ? 1 / 1.2 : 1.2); return; }
      if (plain && !S.grid && (k === 'ArrowUp' || k === 'ArrowDown') && S.step === 2) { e.preventDefault(); goTo(pos + (k === 'ArrowUp' ? -swCols : swCols)); return; }
      onKey(e);
    });
    w.addEventListener('pagehide', () => { if (sw === w) { sw = null; secondButton(); } });
    secondButton();
    drawSecond();
  }
  window.ZtPickSecond = { attach: attachSecond };
  // this page going away leaves the other one with nothing to show
  window.addEventListener('pagehide', () => {
    if (!swOpen()) return;
    try { const l = sw.document.getElementById('sLost'); l.textContent = '「照片挑選」的視窗關掉或重新整理了。這個視窗可以關掉，回去再按一次「副螢幕」。'; l.hidden = false; } catch {}
  });
  function queueSecond() {
    if (!sw || swQueued) return;
    swQueued = true;
    queueMicrotask(() => { swQueued = false; drawSecond(); });
  }
  function drawSecond(follow = true) {
    if (!swOpen()) { if (sw) { sw = null; secondButton(); } return; }
    const d = sw.document, g = d.getElementById('sGrid'), gin = d.getElementById('sIn');
    if (!g || !gin) return;
    const W = g.clientWidth - 12, H = g.clientHeight;
    swCols = Math.max(1, Math.floor(W / S.cell));
    const cw = W / swCols, ch = Math.round(cw * 0.8) + 26;
    gin.style.height = `${Math.ceil(view.length / swCols) * ch + 12}px`;
    if (follow && swPos !== pos) {
      // the photo you're on, kept in sight: when it leaves, its row comes back to the middle
      const y = 6 + Math.floor(pos / swCols) * ch, t = g.scrollTop;
      if (y < t || y + ch > t + H) g.scrollTop = Math.max(0, y - (H - ch) / 2);
      swPos = pos;
    }
    const t = g.scrollTop, a = Math.max(0, (Math.floor(t / ch) - 1) * swCols), b = Math.min(view.length, (Math.ceil((t + H) / ch) + 1) * swCols);
    const kids = [];
    for (let i = a; i < b; i++) {
      const it = view[i];
      kids.push(el('div', { class: cellClass(it, 'c'), 'data-i': i, 'data-k': it.key, title: `${it.name}${it.dir ? `・${it.dir}` : ''}`,
        style: `left:${6 + (i % swCols) * cw}px;top:${6 + Math.floor(i / swCols) * ch}px;width:${cw - 6}px;height:${ch - 6}px` },
      el('span', { class: 'no', text: num(i + 1) }), el('span', { class: 'pic' }, thumbImg(it)), el('span', { class: 'name', text: it.name })));
    }
    gin.replaceChildren(...kids);
    const it = current(), c = counts();
    fill(d.getElementById('sPos'), ...(it ? [el('b', { text: `第 ${num(pos + 1)}／${num(view.length)} 張` }), `・${it.name}`] : ['還沒有照片']),
      S.filter !== 'all' ? `（只看${FILTER_NAME[S.filter]}）` : '', sel.size > 1 ? `・選了 ${num(sel.size)} 張` : '');
    fill(d.getElementById('sCounts'), el('span', { class: 'n-keep' }, el('i'), '留用 ', el('b', { text: num(c.keep) })),
      el('span', {}, '未標記 ', el('b', { text: num(c.none) })), el('span', { class: 'n-drop' }, el('i'), '排除 ', el('b', { text: num(c.drop) })));
    d.getElementById('sEmpty').hidden = view.length > 0;
  }
  $('#bSecond').addEventListener('click', toggleSecond);
  $('#bSecond').hidden = PHONE;

  // ---------- the keys, the first times in (until a photo is flagged with one) ----------
  let tipTimer = 0;
  function tip() {
    const t = $('#stTip');
    if (!S.tip || PHONE) { t.hidden = true; return; }
    t.hidden = false; t.classList.remove('out');
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => t.classList.add('out'), 9000);
  }
  function tipDone() {
    if (S.tip) { S.tip = false; remember(); }
    $('#stTip').classList.add('out');
  }

  // ---------- the filmstrip's header: counts, filter, folder, order ----------
  function refresh() {
    if (S.step !== 2) return;
    const c = counts();
    $('#nAll').textContent = num(c.all); $('#nNone').textContent = num(c.none); $('#nKeep').textContent = num(c.keep); $('#nDrop').textContent = num(c.drop);
    for (const b of $$('.tl')) { const on = b.dataset.f === S.filter; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    $('#doneFill').style.width = `${c.all ? ((c.keep + c.drop) / c.all) * 100 : 0}%`;
    $('#doneBar').title = `決定了 ${num(c.keep + c.drop)}／${num(c.all)} 張`;
    const n = c.keep;
    for (const b of $$('.go2')) { b.disabled = !allowed(3); b.textContent = n ? `存下 ${num(n)} 張 →` : '存下來 →'; }
    if (S.grid) drawGrid(); else drawStrip();
    queueSecond();
    info(current());
    if (S.grid && sel.size > 1) { fill($('#stPos'), el('b', { text: `選了 ${num(sel.size)} 張` }), '・P、X、U 一起標'); $('#bKeep').disabled = $('#bDrop').disabled = false; }
  }
  $('#tally').addEventListener('click', (e) => {
    const b = e.target.closest('.tl');
    if (!b || b.dataset.f === S.filter) return;
    S.filter = b.dataset.f;
    const at = current();
    rebuildView(at && matches(at) ? at : null);
    stripPos = gridPos = swPos = -1;
    show(); refresh();
  });
  function renderFolders() {
    const by = new Map();
    for (const it of items) by.set(it.dir, (by.get(it.dir) || 0) + 1);
    const dirs = [...by.keys()].sort(collator.compare);
    $('#folderWrap').hidden = dirs.length < 2;
    fill($('#folder'), el('option', { value: '', text: `全部資料夾（${num(items.length)}）` }),
      ...dirs.map((d) => el('option', { value: d, text: `${d || '（最上層）'}（${num(by.get(d))}）`, selected: d === S.folder ? '' : null })));
  }
  $('#folder').addEventListener('change', (e) => {
    S.folder = e.target.value;
    rebuildView(current() && matches(current()) ? current() : null);
    stripPos = gridPos = swPos = -1;
    show(); refresh();
    e.target.blur();
  });
  document.addEventListener('change', (e) => {
    const r = e.target;
    if (r.type !== 'radio') return;
    if (r.name === 'take' || r.name === 'lay') { S[r.name] = r.value; if (r.name === 'lay') remember(); renderStep3(); }
  });
  $('#sort').addEventListener('change', (e) => { S.sort = e.target.value; remember(); const at = current(); sortItems(); rebuildView(at); stripPos = gridPos = swPos = -1; show(); refresh(); e.target.blur(); });
  $('#auto').checked = S.auto;
  $('#auto').addEventListener('change', (e) => { S.auto = e.target.checked; remember(); e.target.blur(); });
  $('#bKeep').addEventListener('click', () => mark(targets(), flagOf(current()) === 1 && sel.size <= 1 ? 0 : 1, S.auto));
  $('#bDrop').addEventListener('click', () => mark(targets(), flagOf(current()) === -1 && sel.size <= 1 ? 0 : -1, S.auto));
  $('#bZoom').addEventListener('click', () => toggleZoom());
  $('#bKeys').addEventListener('click', () => $('#keys').showModal());
  $('#bInfo').addEventListener('click', () => setInfo(!S.info));
  // a mouse click leaves focus on a button, and the next Space or arrow would go to it
  $('#step2').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && e.detail > 0) b.blur(); });

  // full screen: the whole step, side panel too
  function fullScreen() {
    const p = $('#step2');
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (p.requestFullscreen) p.requestFullscreen().catch(() => toast('這個瀏覽器不能全螢幕'));
    else toast('這個瀏覽器不能全螢幕');
  }
  $('#bFull').addEventListener('click', fullScreen);
  if (!document.fullscreenEnabled) $('#bFull').hidden = true;
  document.addEventListener('fullscreenchange', () => { requestAnimationFrame(() => { layout(); drawStrip(); drawGrid(); }); });

  // ---------- pointer: click to zoom at that spot, drag to look around, swipe to move on (touch) ----------
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('button') || !current()) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, zx: Z.x, zy: Z.y, moved: false, t: performance.now() };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved && Z.on) { Z.x = drag.zx + dx; Z.y = drag.zy + dy; clampPan(); apply(false); stage.classList.add('grabbing'); }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    stage.classList.remove('grabbing');
    if (e.type === 'pointercancel') return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved) {
      const r = stage.getBoundingClientRect();
      toggleZoom(e.clientX - r.left, e.clientY - r.top);
    } else if (!Z.on && e.pointerType !== 'mouse' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  // pinch on a trackpad (ctrl + wheel) zooms; two fingers, zoomed in, look around
  stage.addEventListener('wheel', (e) => {
    if (!current()) return;
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey) {
      e.preventDefault();
      const k = clamp(Z.k * Math.exp(-e.deltaY * 0.01), 1, k100() * 4);
      zoomAt(k, e.clientX - r.left, e.clientY - r.top, false);
      if (Z.on) full(current());
    } else if (Z.on) {
      e.preventDefault();
      Z.x -= e.deltaX; Z.y -= e.deltaY;
      clampPan(); apply(false);
    }
  }, { passive: false });
  let resizeTimer = 0;
  new ResizeObserver(() => { cancelAnimationFrame(resizeTimer); resizeTimer = requestAnimationFrame(() => { if (S.step === 2) { layout(); drawStrip(); drawGrid(); } }); }).observe($('#viewer'));

  // ---------- keys ----------
  function onKey(e) {
    if (S.step !== 2 || $('#keys').open) return;
    if (e.target.closest && e.target.closest('input[type="text"], select, textarea')) return;
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && (k === 'z' || k === 'Z') && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
    if (mod || e.altKey) return;
    if (!view.length && !/^[gGiI?]$/.test(k)) return;
    const advance = S.auto || e.shiftKey || (e.getModifierState && e.getModifierState('CapsLock'));
    const one = () => (sel.size > 1 && S.grid ? targets() : [current()]);
    let done = true;
    switch (k) {
      case 'ArrowRight': if (S.grid && e.shiftKey) extend(1); else go(1); break;
      case 'ArrowLeft': if (S.grid && e.shiftKey) extend(-1); else go(-1); break;
      case 'ArrowUp': if (S.grid) { if (e.shiftKey) extend(-cols); else go(-cols); } else mark(one(), 1, advance); break;
      case 'ArrowDown': if (S.grid) { if (e.shiftKey) extend(cols); else go(cols); } else mark(one(), -1, advance); break;
      case 'p': case 'P': mark(one(), 1, advance); tipDone(); break;
      case 'x': case 'X': case 'Delete': case 'Backspace': mark(one(), -1, advance); tipDone(); break;
      case 'u': case 'U': case '0': mark(one(), 0, advance); tipDone(); break;
      case '`': mark(one(), flagOf(current()) === 1 && one().length === 1 ? 0 : 1, advance); tipDone(); break;
      case 'i': case 'I': setInfo(!S.info); break;
      case 'z': case 'Z': case ' ': if (S.grid) setGrid(false); else toggleZoom(); break;
      case 'g': case 'G': if (e.shiftKey) toggleSecond(); else setGrid(!S.grid); break;
      case 'e': case 'E': case 'Enter': if (S.grid) setGrid(false); else done = false; break;
      case 'Escape': if (S.grid && sel.size > 1) { sel.clear(); refresh(); } else if (Z.on) toggleZoom(); else if (S.grid) setGrid(false); else done = false; break;
      case 'f': case 'F': fullScreen(); break;
      case 'Home': goTo(0); break;
      case 'End': goTo(view.length - 1); break;
      case 'PageDown': go(S.grid ? cols * 4 : 10); break;
      case 'PageUp': go(S.grid ? -cols * 4 : -10); break;
      case '?': $('#keys').showModal(); break;
      default: done = false;
    }
    if (done) { e.preventDefault(); if (document.activeElement && document.activeElement.matches('button') && !document.activeElement.closest('dialog')) document.activeElement.blur(); }
  }
  document.addEventListener('keydown', onKey);
  function extend(d) {
    if (!sel.size && current()) sel.add(current());
    if (!anchor) anchor = current();
    const a = view.indexOf(anchor), i = clamp(pos + d, 0, view.length - 1);
    sel.clear();
    for (let k = Math.min(a, i); k <= Math.max(a, i); k++) sel.add(view[k]);
    pos = i;
    show(); refresh();
  }

  // ---------- step 3: the kept ones out ----------
  const export_ = { busy: false, n: 0, done: 0, skipped: 0, fails: [], to: '' };
  const takeList = () => items.filter((it) => (S.take === 'keep' ? flagOf(it) === 1 : flagOf(it) !== -1));
  // names in the output: the same name twice (two cameras' IMG_0001) gets -2
  function namesFor(list) {
    const used = new Set(), out = new Map();
    for (const it of list) {
      const dir = S.lay === 'dirs' ? it.dir : '';
      const dot = it.name.lastIndexOf('.'), base = dot > 0 ? it.name.slice(0, dot) : it.name, ext = dot > 0 ? it.name.slice(dot) : '';
      let name = it.name;
      for (let n = 2; used.has(`${dir}/${name}`.toLowerCase()); n++) name = `${base}-${n}${ext}`;
      used.add(`${dir}/${name}`.toLowerCase());
      out.set(it, { dir, name });
    }
    return out;
  }
  function renderStep3() {
    if (export_.busy) return;
    const c = counts(), list = takeList(), bytes = list.reduce((a, it) => a + it.size, 0);
    $('#takeKeep').textContent = `標「留用」的 ${num(c.keep)} 張`;
    $('#takeNot').textContent = `沒標「排除」的 ${num(c.keep + c.none)} 張`;
    for (const [name, v] of [['take', S.take], ['lay', S.lay]]) { const r = $(`input[name="${name}"][value="${v}"]`); if (r) r.checked = true; }
    const dirs = new Set(list.map((it) => it.dir));
    $$('input[name="lay"]').forEach((r) => { r.disabled = dirs.size < 2; });
    fill($('#takeLine'), el('b', { text: `${num(list.length)} 張` }), `・${fmtBytes(bytes)}・`, list.length === 1 ? '直接下載這張' : CAN_DIR ? '存進你選的資料夾' : '打包成 ZIP 下載');
    const same = list.length - new Set(list.map((it) => it.name.toLowerCase())).size;
    $('#outHelp').textContent = list.length === 1 ? '' : CAN_DIR
      ? `選一個資料夾（可以新建一個空的），照片會原封不動複製進去${same && S.lay === 'flat' ? `；同名的 ${num(same)} 張會加上 -2` : ''}。資料夾裡已經有的同一張會跳過，所以多挑幾張再存一次也可以。`
      : `照片原封不動打包${same && S.lay === 'flat' ? `；同名的 ${num(same)} 張會加上 -2` : ''}。用電腦版 Chrome 或 Edge 可以直接存進資料夾，不用再解壓。`;
    const go = $('#go');
    go.disabled = !list.length;
    go.textContent = list.length === 1 ? '下載這張 →' : CAN_DIR ? '選資料夾，存進去 →' : `下載 ZIP（${num(list.length)} 張）→`;
    $('#goZip').hidden = !(CAN_DIR && list.length > 1);
    $('#note3').textContent = !list.length ? (S.take === 'keep' ? '還沒有標「留用」的照片' : '每一張都標了「排除」') : '';
  }
  $('#go').addEventListener('click', () => { const list = takeList(); if (list.length === 1) saveOne(list[0]); else if (CAN_DIR) saveDir(list); else saveZip(list); });
  $('#goZip').addEventListener('click', () => saveZip(takeList()));
  $('#again').addEventListener('click', () => { $('#after').hidden = true; $('#big').hidden = true; $('#outSets').hidden = false; $('#fails').hidden = true; renderStep3(); renderFoot3(true); });
  function renderFoot3(on) { $('#go').hidden = !on; $('#goZip').hidden = !on || !(CAN_DIR && takeList().length > 1); $('#back3').disabled = !on; }
  function progress() {
    const e = export_;
    $('#bigNum').textContent = num(e.done);
    $('#bigOf').textContent = `／${num(e.n)} 張`;
    $('#barFill').style.setProperty('--p', `${e.n ? (e.done / e.n) * 100 : 0}%`);
    $('#bar').classList.toggle('done', !e.busy && e.done === e.n);
  }
  function begin(n, what) {
    Object.assign(export_, { busy: true, n, done: 0, skipped: 0, fails: [] });
    $('#outSets').hidden = true; $('#big').hidden = false; $('#after').hidden = true; $('#fails').hidden = true;
    fill($('#bigWhat'), what);
    renderFoot3(false); renderStepper(); progress();
  }
  function finish(what) {
    export_.busy = false;
    fill($('#bigWhat'), ...what);
    progress();
    const f = export_.fails;
    $('#fails').hidden = !f.length;
    fill($('#fails'), ...f.slice(0, 50).map((x) => el('li', {}, el('b', { text: x.name }), `：${x.why}`)));
    $('#after').hidden = false;
    $('#back3').disabled = false;
    renderStepper();
    count(export_.done - export_.skipped - export_.fails.length);
  }
  function download(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  }
  async function saveOne(it) {
    begin(1, '準備檔案…');
    try { download(await blobOf(it), it.name); export_.done = 1; finish(['開始下載了：', el('b', { text: it.name })]); }
    catch { export_.fails.push({ name: it.name, why: '讀不到' }); finish(['沒有存成功']); }
  }
  async function saveDir(list) {
    let root;
    try { root = await window.showDirectoryPicker({ id: 'zt-pick', mode: 'readwrite', startIn: 'pictures' }); }
    catch (e) { if (e.name !== 'AbortError') toast('沒辦法打開這個資料夾'); return; }
    const names = namesFor(list);
    begin(list.length, el('span', {}, '存進「', el('b', { text: root.name }), '」…'));
    window.addEventListener('beforeunload', hold);
    const dirs = new Map([['', root]]);
    const dirOf = async (d) => {
      if (!dirs.has(d)) dirs.set(d, (async () => { let h = root; for (const part of d.split('/')) h = await h.getDirectoryHandle(part.replace(/[\\:*?"<>|]/g, '_'), { create: true }); return h; })());
      return dirs.get(d);
    };
    let i = 0;
    const one = async () => {
      while (i < list.length) {
        const it = list[i++], { dir, name } = names.get(it);
        try {
          const d = await dirOf(dir);
          // already there (saved before): skipped; a different file with that name: a new name
          let target = name;
          for (let n = 2; ; n++) {
            let fh = null;
            try { fh = await d.getFileHandle(target); } catch {}
            if (!fh) break;
            if ((await fh.getFile()).size === it.size) { target = null; break; }
            const dot = name.lastIndexOf('.');
            target = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
          }
          if (target === null) export_.skipped++;
          else {
            const w = await (await d.getFileHandle(target, { create: true })).createWritable();
            try {
              if (it.z && it.z.method) { const at = await dataStart(it.z); await it.z.zip.slice(at, at + it.z.csize).stream().pipeThrough(new DecompressionStream('deflate-raw')).pipeTo(w); }
              else await (await blobOf(it)).stream().pipeTo(w);
            } catch (e) { try { await w.abort(); } catch {} throw e; }
          }
        } catch (e) { console.error(e); export_.fails.push({ name: it.name, why: /quota|space/i.test(String(e && e.message)) ? '磁碟空間不夠' : '沒有存成功' }); }
        export_.done++;
        progress();
      }
    };
    await Promise.all([one(), one(), one()]);
    window.removeEventListener('beforeunload', hold);
    const ok = export_.done - export_.fails.length - export_.skipped, where = ['「', el('b', { text: root.name }), '」'];
    finish(!ok && export_.skipped ? [`這 ${num(export_.skipped)} 張本來就都在`, ...where, '裡了']
      : ['存好 ', el('b', { text: `${num(ok)} 張` }), ' 到', ...where, export_.skipped ? `・${num(export_.skipped)} 張本來就在裡面` : '']);
  }
  async function saveZip(list) {
    const names = namesFor(list);
    begin(list.length, '打包中…');
    window.addEventListener('beforeunload', hold);
    try {
      const entries = [];
      for (const it of list) {
        const { dir, name } = names.get(it), path = dir ? `${dir}/${name}` : name;
        if (it.z) { const at = await dataStart(it.z); entries.push({ name: path, raw: { data: it.z.zip.slice(at, at + it.z.csize), method: it.z.method, crc: it.z.crc, size: it.z.size }, lastModified: it.z.mod }); }
        else entries.push({ name: path, file: it.file });
      }
      const all = entries.reduce((a, x) => a + (x.raw ? x.raw.data.size : x.file.size), 0);
      const blob = await ManyZip.files(entries, (d) => { export_.done = Math.min(list.length, Math.round((d / all) * list.length)); progress(); });
      export_.done = list.length;
      download(blob, `挑好的照片-${list.length}張.zip`);
      finish(['開始下載了：', el('b', { text: `${num(list.length)} 張` }), `，${fmtBytes(blob.size)}`]);
    } catch (e) {
      console.error(e);
      export_.fails.push({ name: 'ZIP', why: '打包失敗' });
      finish(['沒有打包成功']);
    }
    window.removeEventListener('beforeunload', hold);
  }
  function hold(e) { e.preventDefault(); e.returnValue = ''; }

  // ---------- the counter ----------
  // Only a number leaves the browser: how many photos were saved.
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
      if (st && st.files > 0) fill($('#heroCount'), '已幫大家挑出 ', el('b', { class: 'hero-num', text: num(st.files) }), ' 張照片');
    } catch {}
  }

  markReady.then(() => { renderStep1(); renderStepper(); });
  // photos dropped on the home page (/shared/handoff.js): files, or on Chrome and Edge file and folder handles
  if (window.ManyHandoff && window.indexedDB) {
    ManyHandoff.takeAll('pick').then(async (entries) => {
      if (!entries || !entries.length) return;
      const list = [], missed = [];
      for (const e of entries) {
        try {
          if (e.dir) list.push({ dir: e.dir });
          else if (e.handle) list.push({ file: await e.handle.getFile() });
          else if (e.file) list.push({ file: e.file, path: e.path });
          else missed.push(e.name);
        } catch { missed.push(e.name); }
      }
      await markReady.catch(() => {});
      if (list.length) await add(list);
      if (missed.length) toast(`有 ${num(missed.length)} 個沒辦法從首頁帶過來，請在這裡再放一次`, 6000);
    }).catch(() => {});
  }
  loadStats();
  renderStep1();
  renderStepper();
})();
