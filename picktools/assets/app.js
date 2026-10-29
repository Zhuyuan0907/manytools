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
  const NUM = new Intl.NumberFormat('zh-TW');
  const num = (n) => NUM.format(n);
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const PHONE = matchMedia('(max-width: 640px), (pointer: coarse) and (max-width: 900px)').matches;
  // /pick/demo: 60 photos from this site, for people to try it without photos of their own (no counting there)
  const DEMO = onServer && /^\/pick\/demo\/?$/.test(location.pathname);
  // a phone (a finger on a small screen, as the home page tells): not offered this tool, only told to use a computer
  const ON_PHONE = matchMedia('(pointer: coarse) and (max-width: 600px), (pointer: coarse) and (orientation: landscape) and (max-height: 500px)').matches;
  if (ON_PHONE) {
    document.body.classList.add('is-phone');
    $('#phoneNote').hidden = false;
    $('#pnBack').href = onServer ? '/photo' : '../home/index.html';
    if (DEMO) $('.pn-url b').textContent = 'tools.zhuyuan.tw/pick/demo';
    $('#pnCopy').addEventListener('click', () => {
      const url = `https://${$('.pn-url b').textContent}`;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('網址複製好了'), () => toast(url));
    });
  }
  // Safari (and every browser on an iPhone) shows HEIC itself; elsewhere the photo tool's libheif worker turns it into a picture
  // Lightroom's own type on this computer: its spacing as it is (the overlay's is tuned to match it in Source Sans 3)
  try {
    const g = document.createElement('canvas').getContext('2d'), w = (f) => { g.font = `40px ${f}`; return g.measureText('1K0A3827.CR3 mm').width; };
    if (['"Myriad Pro"', '"Myriad Web Pro"'].some((f) => w(`${f}, monospace`) !== w('monospace'))) document.documentElement.classList.add('myriad');
  } catch {}
  const WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Android/.test(navigator.userAgent);
  const FIREFOX = /Firefox\//.test(navigator.userAgent);
  const MAC = /Mac/.test(navigator.platform || navigator.userAgent);
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
  // it: { key, name, path, dir, size, mod, src (its source), file | z | url (a demo photo on this site), heic,
  //       t (when taken, wall clock as UTC ms),
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

  function addPhoto(found, src, path, size, mod, file, z, url) {
    if (HIDDEN(path)) return;
    const name = baseName(path);
    if (!PHOTO.test(name)) { if (RAW.test(name)) skipped.raw++; else if (!/^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(name)) skipped.other++; return; }
    const key = keyOf(name, size);
    if (byKey.has(key) || found.has(key)) { skipped.same++; return; }
    found.set(key, { key, name, path, dir: '', size, mod, src, file: file || null, z: z || null, url: url || null, heic: HEIC.test(name), t: null, when: '', cam: '', lens: '', ss: '', fn: '', iso: '', fl: '', orient: 1, w: 0, h: 0, thumb: undefined, turn: 1, n: 0 });
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

  // list: [{ entry } | { file, path? } | { dir } | { url, name, size, mod }] from a drop, the file boxes, the home page
  // or the demo
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
    const web = { id: ++srcSeq, name: '示範照片', kind: 'demo', n: 0 };
    try {
      for (const x of list) {
        if (x.url) {
          const before = found.size;
          addPhoto(found, web, x.name, x.size, x.mod, null, null, x.url);
          web.n += found.size - before;
          continue;
        }
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
    if (web.n) added.push(web);
    const fresh = [...found.values()];
    if (fresh.length) {
      await readAll(fresh);
      for (const it of fresh) byKey.set(it.key, it);
      items = items.concat(fresh);
      sources = sources.concat(added.filter((s) => s.n));
      const inChosen = S.folder ? items.find((it) => it.dir === S.folder) : null;
      placeDirs();
      if (inChosen) S.folder = inChosen.dir;
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
  const WEB_HEAD = 65536;   // a demo photo's (over the network)
  // where a JPEG's EXIF block (APP1) ends, or 0
  function exifEnd(b) {
    for (let i = 2; i + 4 <= b.length && b[i] === 0xff;) {
      const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78) return i + 2 + len;   // "Ex"if
      if (m === 0xda) break;
      i += 2 + len;
    }
    return 0;
  }
  async function headOf(it) {
    if (it.file) return { file: it.file, bytes: null };
    // a demo photo: its first 64 KB, asked for by byte range, and the rest of the camera's EXIF block (where the
    // thumbnail is) if it runs on
    if (it.url) {
      const get = async (a, b) => {
        const r = await fetch(it.url, { headers: { Range: `bytes=${a}-${b - 1}` } });
        if (!r.ok) throw new Error(`${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      let bytes = await get(0, WEB_HEAD);
      const end = Math.min(exifEnd(bytes), HEAD);
      if (end > bytes.length && bytes.length === WEB_HEAD) { const more = await get(WEB_HEAD, end), all = new Uint8Array(end); all.set(bytes); all.set(more, WEB_HEAD); bytes = all; }
      bytes = bytes.subarray(0, HEAD);
      return { file: new File([bytes], it.name, { lastModified: it.mod }), bytes };
    }
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
      else if (it.z && !it.z.method && head) it.thumb = it.z.zip.slice(it.z.data + th.start, it.z.data + th.end, 'image/jpeg');
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
      const last = pos >= view.length - 1;
      if (!last || !matches(view[pos])) go(1);
      if (last && view.length) toast('這是最後一張了');
    }
    refresh();
  }
  function doUndo() {
    let u = undo.pop();
    // photos taken out since (their source removed) stay out
    while (u && !(u.ch = u.ch.filter((c) => byKey.get(c.it.key) === c.it)).length) u = undo.pop();
    if (!u) { toast('沒有可以復原的'); return; }
    if (u.at && byKey.get(u.at.key) !== u.at) u.at = null;
    for (const c of u.ch) if (c.from) marks.set(c.it.key, c.from); else marks.delete(c.it.key);
    save(u.ch.map((c) => [c.it.key, c.from]));
    // back on the photo it was on, even if the filter had let it go
    const at = u.at || u.ch[0].it;
    if (!view.includes(at)) { view.splice(lowerBound(at), 0, at); viewGen++; }
    pos = view.indexOf(at);
    sel.clear();
    show();
    refresh();
    toast(u.ch.length > 1 ? `復原了 ${num(u.ch.length)} 張` : '復原了');
  }

  // ---------- what's shown: the filter, the folder, the order ----------
  const SAVED = 'zt-pick';
  const S = { step: 1, filter: 'all', folder: '', sort: 'time', auto: true, info: true, tip: true, grid: false, take: 'keep', lay: 'flat', flags: false, film: true };
  const KEPT = ['sort', 'auto', 'info', 'tip', 'lay', 'flags', 'film'];
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
    viewGen++;
    view = items.filter(matches);
    pos = 0;
    if (stay) { const i = view.indexOf(stay); pos = i >= 0 ? i : Math.min(lowerBound(stay), Math.max(0, view.length - 1)); }
    sel.clear();
  }
  // Photos that no longer fit the filter (marked while only unmarked ones show, one or a grid's selection) stay until
  // you move off them.
  function go(d) {
    if (!view.length) return;
    if (d) pvDir = d > 0 ? 1 : -1;
    let next = pos + d;
    if (view.some((it) => !matches(it))) {
      const from = view[pos], before = view.slice(0, pos).filter(matches).length;
      view = view.filter(matches); viewGen++;
      next = before + d - (from && !matches(from) && d > 0 ? 1 : 0);
    }
    pos = clamp(next, 0, Math.max(0, view.length - 1));
    sel.clear();
    show();
    refresh();
  }
  function goTo(i) {
    const to = view[i];
    if (view.some((it) => it !== to && !matches(it))) { view = view.filter((it) => it === to || matches(it)); viewGen++; if (to) i = view.indexOf(to); }
    pos = clamp(i, 0, Math.max(0, view.length - 1));
    sel.clear();
    show(); refresh();
  }

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
    // back in step 3 after a save: ready to save again (unless a save is still going)
    if (n === 3) { if (was !== 3 && !export_.busy) fresh3(); else renderStep3(); }
    if (n === 1 && was !== 1) renderStep1();
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
  function counts(list = items) {
    let keep = 0, drop = 0;
    for (const it of list) { const f = flagOf(it); if (f === 1) keep++; else if (f === -1) drop++; }
    return { all: list.length, keep, drop, none: list.length - keep - drop };
  }
  // the filter's numbers: in the folder chosen
  const shownCounts = () => (S.folder ? counts(items.filter(inFolder)) : counts());
  function renderStep1() {
    const n = items.length, c = counts();
    $('#step1').classList.toggle('has-files', n > 0);
    $('#sources').hidden = !n;
    $('#how').hidden = n > 0;
    fill($('#srcList'), ...sources.map((s) => el('li', { class: `src ${s.kind}` },
      el('span', { class: 'src-ic', 'aria-hidden': 'true', text: s.kind === 'zip' ? 'ZIP' : s.kind === 'folder' ? '▤' : s.kind === 'demo' ? '示範' : '▢' }),
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
  }
  function removeSource(s) {
    if (loading) return;
    sources = sources.filter((x) => x !== s);
    items = items.filter((it) => { if (it.src !== s) return true; byKey.delete(it.key); forget(it); return false; });
    placeDirs(); sortItems();
    if (S.folder && !items.some((it) => it.dir === S.folder)) S.folder = '';
    rebuildView(firstOpen());
    renderStep1(); renderStepper(); queueSecond();
  }
  function clearMarks() {
    const c = counts();
    if (!confirm(`清掉這 ${num(items.length)} 張照片的旗標（留用 ${num(c.keep)}、排除 ${num(c.drop)}）？`)) return;
    const ch = items.filter(flagOf).map((it) => ({ it, from: flagOf(it), to: 0 }));
    for (const x of ch) marks.delete(x.it.key);
    save(ch.map((x) => [x.it.key, 0]));
    undo.push({ ch, at: null });
    rebuildView(items[0]);
    renderStep1(); queueSecond();
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
  // 100 %: a pixel of the photo on a pixel of the screen (a photo about the screen's size or smaller: twice the fitted size)
  const k100 = () => { const it = current(), k = (it && it.w ? it.w / fit.w : 1) / dpr(); return k > 1.2 ? k : 2; };
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

  // pictures: an <img> for each photo near the current one, decoded ahead; the thumbnail stands in meanwhile. With
  // previews (below) the whole photo is only for zooming in, so only a few are kept.
  const PV = typeof OffscreenCanvas === 'function' && typeof Worker === 'function' && typeof createImageBitmap === 'function';
  const KEEP = PV ? 3 : PHONE ? 3 : WEBKIT ? 4 : 6;
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
    if (z && !z.method) return dataStart(z).then((d) => z.zip.slice(d, d + z.csize));
    // deflated in a ZIP, or a demo photo to download: the last few kept
    let p = unpacked.get(it);
    if (p) unpacked.delete(it);
    else {
      p = z ? dataStart(z).then((d) => inflate(z.zip.slice(d, d + z.csize))) : fetch(it.url).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); });
      p.catch(() => { if (unpacked.get(it) === p) unpacked.delete(it); });
    }
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
    pvDrop(it); pvBad.delete(it);
  }
  // the whole photo, to zoom in: over the preview, there as soon as it's decoded
  function full(it) {
    if (!it) return;
    const p = pic(it);
    if (it !== current() || S.grid) return;
    if (!frame.contains(p.img)) { p.img.classList.remove('in'); frame.append(p.img); }
    p.ready.then((ok) => ok && p.img.decode().catch(() => {})).then(() => { if (p.ok && current() === it && frame.contains(p.img)) { p.img.classList.add('in'); stage.classList.remove('loading'); } });
  }

  // ---------- previews, as Lightroom's standard previews ----------
  // A 24 MP photo on screen means decoding 96 MB (about half a second) and moving it to the screen, which is what made
  // holding → stutter. A preview the size it's shown at (assets/preview.js, in workers, off the page's thread) decodes
  // in a tenth of that. They're made ahead, the way you're going, a few at a time, the thumbnail from the same decode.
  let pvSrc = null, pvFails = 0;
  if (PV) fetch('assets/preview.js').then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b) pvSrc = URL.createObjectURL(new Blob([b], { type: 'text/javascript' })); }).catch(() => {});
  const PV_WORKERS = WEBKIT ? 2 : clamp((navigator.hardwareConcurrency || 4) - 2, 1, 4);
  const previews = new Map();   // it → { url, long }
  const pvBad = new Set(), pvBusy = new Set(), pvWait = new Map(), pvWorkers = [];
  const pvStale = new Set();   // made for a smaller window: shown until a bigger one is ready
  let pvUrgent = [], pvPlanned = [], pvThumbs = [], pvDir = 1, pvOn = PV;
  const pvNo = (it) => !pvOn || pvBad.has(it) || (it.heic && !WEBKIT);
  // its long side in screen pixels, fitted to the photo's place
  let stageW = 0, stageH = 0;   // the photo's place when last seen (the grid hides it)
  function pvLong(it) {
    if (stage.clientWidth) { stageW = stage.clientWidth; stageH = stage.clientHeight; }
    const W = stageW || innerWidth, H = stageH || innerHeight, [w, h] = dims(it);
    return Math.min(3600, Math.ceil(Math.max(w, h) * Math.min(W / w, H / h) * dpr()));
  }
  // asked for by what's waiting for it (the photo on screen): first in line
  function pvAsk(it, urgent) {
    if (pvNo(it)) return Promise.resolve(null);
    const v = previews.get(it);
    if (v && !pvStale.has(it)) return Promise.resolve(v);
    let w = pvWait.get(it);
    if (!w) { let res; w = { p: new Promise((r) => { res = r; }) }; w.res = res; pvWait.set(it, w); }
    if (urgent && !pvBusy.has(it)) {
      pvUrgent = [it, ...pvUrgent.filter((x) => x !== it)].slice(0, 6);
      // WebKit (slow previews, workers renewed anyway): every worker busy with photos further on, one stops for this
      if (WEBKIT && pvWorkers.length >= PV_WORKERS && pvWorkers.every((x) => x.busy)) {
        const wk = pvWorkers.find((x) => x.stop && x.job && x.job.it !== it && Math.abs(view.indexOf(x.job.it) - pos) > 1);
        if (wk) { const st = wk.stop; wk.w.terminate(); pvWorkers.splice(pvWorkers.indexOf(wk), 1); st(); }
      }
    }
    pvPump();
    return w.p;
  }
  // the next ones the way you're going (a few behind too); a demo photo is a download, so only the next one
  function pvPlan() {
    if (!pvOn || S.step !== 2) return;
    const out = [], cur = current(), ahead = cur && cur.url ? (scrub ? 0 : 1) : 30;
    // a held key: from where you'll be in about 0.7 s
    const from = scrub && !(cur && cur.url) ? Math.max(1, Math.ceil(scrubRate * 0.7)) : 1;
    for (let d = from; d < from + ahead; d++) for (const k of d <= 2 && !(cur && cur.url) ? [pvDir * d, -pvDir * d] : [pvDir * d]) {
      const x = view[pos + k];
      if (!x || pvBusy.has(x) || pvNo(x)) continue;
      const v = previews.get(x);
      if (v && v.long < pvLong(x) * 0.85) pvStale.add(x);
      if (!v || pvStale.has(x)) out.push(x);
    }
    pvPlanned = out;
    pvUrgent = pvUrgent.filter((x) => Math.abs(view.indexOf(x) - pos) <= 3);
    const next = view[pos + pvDir];
    for (const wk of pvWorkers) if (wk.job && wk.job.ctl && wk.job.it !== cur && wk.job.it !== next) wk.job.ctl.abort();
    pvPump();
  }
  function pvPump() {
    for (;;) {
      const ok = (x) => x && (!previews.has(x) || pvStale.has(x)) && !pvBusy.has(x) && !pvNo(x) && byKey.has(x.key);
      if (!pvFreeOk()) return;
      let it = null;
      while (!it && pvUrgent.length) { const x = pvUrgent.shift(); if (ok(x)) it = x; }
      while (!it && pvThumbs.length) { const x = pvThumbs.pop(); if (ok(x) && !x.thumb && !previews.has(x)) it = x; }
      while (!it && pvPlanned.length) { const x = pvPlanned.shift(); if (ok(x)) it = x; }
      if (!it) { pvIdle(); return; }
      const wk = pvFree();
      if (!wk) return;
      pvRun(wk, it);
    }
  }
  // nothing to make for a while: the workers go (and the memory of their last decodes with them)
  let pvIdleTimer = 0;
  function pvIdle() {
    clearTimeout(pvIdleTimer);
    pvIdleTimer = setTimeout(() => { for (const wk of [...pvWorkers]) if (!wk.busy) { wk.w.terminate(); pvWorkers.splice(pvWorkers.indexOf(wk), 1); } }, 15000);
  }
  // a worker to take a job: while keys repeat fast, only one at a time (the rest of the machine draws the moving)
  const pvFreeOk = () => pvOn && !(scrub && pvWorkers.some((x) => x.busy)) && (pvWorkers.some((x) => !x.busy) || pvWorkers.length < PV_WORKERS);
  function pvFree() {
    const x = pvWorkers.find((v) => !v.busy);
    if (x || pvWorkers.length >= PV_WORKERS) return x || null;
    try { const v = { w: new Worker(pvSrc || 'assets/preview.js'), busy: false, done: 0 }; pvWorkers.push(v); return v; } catch { pvOn = false; return null; }
  }
  async function pvRun(wk, it) {
    wk.busy = true; pvBusy.add(it);
    // a demo photo is a download: stopped if you've moved past it before it's here
    const ctl = it.url ? new AbortController() : null;
    wk.job = { it, ctl };
    let r;
    try {
      const blob = it.url ? await demoBlob(it, ctl.signal) : await blobOf(it), long = pvLong(it);
      const ext = (/\.([^.]+)$/.exec(it.name) || [])[1] || '', type = { png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif' }[ext.toLowerCase()] || blob.type || 'image/jpeg';
      r = await new Promise((res) => {
        const t = setTimeout(() => res({ error: 'timeout', dead: true }), 20000);
        wk.stop = () => { clearTimeout(t); res({ error: 'stopped', aborted: true }); };
        wk.w.onmessage = ({ data }) => { clearTimeout(t); res(data); };
        wk.w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); clearTimeout(t); res({ error: 'worker', dead: true }); };
        wk.w.postMessage({ blob, type, long, decoder: FIREFOX });
      });
      r.long = long;
    } catch (e) { r = { error: String(e), aborted: !!(ctl && ctl.signal.aborted) }; }
    pvBusy.delete(it); wk.busy = false; wk.job = null; wk.stop = null;
    const drop = () => { wk.w.terminate(); const i = pvWorkers.indexOf(wk); if (i >= 0) pvWorkers.splice(i, 1); };
    if (r.dead) { drop(); if (++pvFails >= 4) pvOn = false; }
    // WebKit keeps a decoded photo's memory until its worker goes: a fresh one every other photo
    else if (WEBKIT && ++wk.done >= 2) drop();
    const w = pvWait.get(it);
    pvWait.delete(it);
    if (!byKey.has(it.key) || r.aborted) { if (w) w.res(null); pvPump(); return; }
    if (r.error) { pvBad.add(it); pvStale.delete(it); if (!it.thumb) wantThumbHere(it); if (w) w.res(null); }
    else {
      const old = previews.get(it), v = { url: URL.createObjectURL(r.blob), long: r.long };
      previews.set(it, v);
      pvStale.delete(it);
      if (!it.w) { it.w = r.fw; it.h = r.fh; }
      if (!it.thumb && r.thumb) { it.thumb = r.thumb; it.turn = 1; thumbArrived(it); }
      pvTrim();
      if (w) w.res(v);
      // a bigger one for the photo on screen (the window grew): swapped in; the next ones decoded, ready to show
      if (it === current() && old && !S.grid && !Z.on) {
        const d = pvImg(it);
        d.ready.then((ok) => { const f = frame.firstElementChild; if (ok && it === current() && !Z.on && (!f || f.classList.contains('pv') || f.classList.contains('ph'))) { d.img.classList.add('in'); frame.replaceChildren(d.img); layout(); } });
      } else if (!(scrub && WEBKIT) && (it === view[pos + pvDir] || it === view[pos + 2 * pvDir])) pvImg(it);
      if (old) setTimeout(() => URL.revokeObjectURL(old.url), 3000);
    }
    pvPump();
  }
  // a demo photo's download (kept with the deflated ones, so the whole photo needn't download again)
  function demoBlob(it, signal) {
    const p = unpacked.get(it);
    if (p) return p;
    return fetch(it.url, { signal }).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); }).then((b) => {
      unpacked.set(it, Promise.resolve(b));
      while (unpacked.size > KEEP + 2) unpacked.delete(unpacked.keys().next().value);
      return b;
    });
  }
  // kept: the ones nearest the photo you're on (each a few hundred KB)
  function pvTrim() {
    if (previews.size <= (WEBKIT ? 120 : 240)) return;
    const c = current(), far = [...previews.keys()].sort((a, b) => Math.abs(b.n - (c ? c.n : 0)) - Math.abs(a.n - (c ? c.n : 0)));
    for (const x of far.slice(0, 40)) pvDrop(x);
  }
  function pvDrop(it) {
    const v = previews.get(it);
    if (v) { previews.delete(it); URL.revokeObjectURL(v.url); }
    const d = pvImgs.get(it);
    if (d) { pvImgs.delete(it); d.img.removeAttribute('src'); }
  }
  // decoded previews, ready to show: the photo on screen and the next few
  const pvImgs = new Map();   // it → { img, url, ok, ready }
  function pvImg(it) {
    const v = previews.get(it);
    if (!v) return null;
    let d = pvImgs.get(it);
    if (d && d.url === v.url) { pvImgs.delete(it); pvImgs.set(it, d); return d; }
    const img = new Image();
    img.className = 'photo pv'; img.alt = ''; img.draggable = false; img.decoding = 'async'; img.src = v.url;
    d = { img, url: v.url, ok: false };
    d.ready = img.decode().then(() => { d.ok = true; return true; }, () => false);
    pvImgs.set(it, d);
    for (const [k, o] of pvImgs) { if (pvImgs.size <= (WEBKIT ? 4 : 8)) break; if (k === current()) continue; pvImgs.delete(k); o.img.removeAttribute('src'); }
    return d;
  }

  // What's on screen: the best there is right away (the whole photo if it's decoded, else its preview, else the
  // thumbnail), the better one swapped in when it's ready. Moves faster than anyone looks (a held arrow) decode nothing
  // big for the photos passed over; the next previews are decoded ahead, so those show sharp at once.
  let showGen = 0, preTimer = 0, settleTimer = 0, lastShow = 0, lastIt = null, scrub = false, scrubRate = 0, scrubEnd = 0;
  function show() {
    const it = current();
    const gen = ++showGen;
    $('#stEmpty').hidden = !!it;
    clearTimeout(settleTimer); clearTimeout(preTimer);
    if (!it) {
      frame.replaceChildren();
      $('#stEmpty').textContent = !items.length ? '還沒有照片' : S.filter === 'none' ? '這裡的照片都標好了' : '這裡沒有照片';
      info(null);
      drawStrip(); drawGrid(); queueSecond();
      return;
    }
    const now = performance.now();
    if (it !== lastIt) {
      const gap = now - lastShow;
      scrub = gap < 170;
      scrubRate = scrub ? (scrubRate ? scrubRate * 0.7 + (1000 / gap) * 0.3 : 1000 / gap) : 0;   // moves a second
      lastShow = now; lastIt = it;
      clearTimeout(scrubEnd);
      scrubEnd = setTimeout(() => { scrub = false; scrubRate = 0; pvPlan(); }, 200);
    }
    const p = pics.get(it), useFull = Z.on || pvNo(it);
    const v = previews.get(it);
    if (v && !S.grid && v.long < pvLong(it) * 0.85) pvStale.add(it);   // made for a smaller window: a bigger one is asked for below
    let best = null;
    if (v && !(p && p.ok && (useFull || pvStale.has(it)))) { const d = pvImg(it); if (d.ok) best = d.img; }
    if (!best && p && p.ok && !useFull && (!v || WEBKIT || pvStale.has(it))) best = p.img;   // no preview (yet): the whole photo, as decoded at the pause
    if (best) { best.classList.add('in'); frame.replaceChildren(best); }
    else {
      const t = thumbUrl(it);
      frame.replaceChildren(...(t ? [el('img', { class: 'ph', src: t, alt: '' })] : []));
      if (!t) wantThumb(it);
    }
    layout();
    stage.classList.toggle('loading', !best);
    const swap = (img) => {
      if (gen !== showGen) return;
      img.classList.add('in');
      // zoomed in: a preview that comes now goes under the whole photo (never over it)
      if (Z.on && img.classList.contains('pv')) { const f = pics.get(it); if (f && frame.contains(f.img)) { if (!frame.contains(img)) frame.prepend(img); return; } }
      frame.replaceChildren(img);
      layout();
      stage.classList.remove('loading');
    };
    const fail = () => { if (gen === showGen) { stage.classList.remove('loading'); $('#stEmpty').hidden = false; $('#stEmpty').textContent = '這張打不開'; } };
    const later = (fn) => { settleTimer = setTimeout(() => { if (gen === showGen) fn(); }, 170); };
    if (useFull) {
      // decoded again first if it's been let go of, so painting it never holds the page
      const go = () => { const q = pic(it); q.ready.then((ok) => (ok ? q.img.decode().then(() => swap(q.img), () => swap(q.img)) : fail())); };
      if (scrub && !Z.on) later(go); else go();
    } else if (!best || (pvStale.has(it) && best.classList.contains('pv'))) {
      const go = () => pvAsk(it, true).then((x) => {
        if (gen !== showGen) return;
        if (!x) { show(); return; }   // no preview for this one: the whole photo, then
        const d = pvImg(it);
        if (d) d.ready.then((ok) => (ok ? swap(d.img) : fail()));
      });
      // a preview already made decodes quickly (not in WebKit while moving, where decoding holds the page)
      const showPv = () => { const d = pvImg(it); if (d) d.ready.then((ok) => { if (ok) swap(d.img); }); };
      if (v && !best) { if (scrub && WEBKIT) later(showPv); else showPv(); }
      if (!v || pvStale.has(it)) { if (scrub) later(go); else go(); }
    }
    info(it);
    drawStrip(); drawGrid(); queueSecond();
    if (pvOn) {
      // previews: the next ones made, and the next two decoded, ready to show; after a moment on this one, the whole
      // photo too, so zooming in is instant
      pvPlan();
      if (!(scrub && WEBKIT)) for (const d of [1, 2]) { const n = view[pos + d * pvDir]; if (n && previews.has(n) && !pvNo(n)) pvImg(n); }
      // (In WebKit, which can decode on the page's own thread, only when a moment's rest still shows the thumbnail:
      // the previews keep up there too, and a whole photo decoded on a timer can hold the next key)
      preTimer = setTimeout(() => {
        if (gen !== showGen || Z.on || S.grid) return;
        const f0 = frame.firstElementChild;
        if (WEBKIT && f0 && !f0.classList.contains('ph')) return;
        const q = pic(it);
        q.ready.then((ok) => { const f = frame.firstElementChild; if (ok && gen === showGen && !Z.on && (!f || f.classList.contains('ph'))) q.img.decode().then(() => swap(q.img), () => swap(q.img)); });
      }, WEBKIT ? 600 : 900);
    } else {
      // the next ones (and the one before), once you stop for a moment: as many as the pictures kept, so none of them
      // pushes out the next; a demo photo is a download, so only the next one
      preTimer = setTimeout(async () => {
        for (const d of it.url ? [1] : [1, 2, -1, 3].slice(0, KEEP - 1)) {
          if (gen !== showGen) return;
          const n = view[pos + d];
          if (n) await pic(n).ready;
        }
      }, p && p.ok ? 60 : 160);
    }
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
    renderSrc();
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
    if (!pvNo(it)) { if (!previews.has(it)) { pvThumbs = [...pvThumbs.filter((x) => x !== it), it].slice(-200); pvPump(); } return; }
    wantThumbHere(it);
  }
  // made here instead (no previews, or this one can't have one)
  function wantThumbHere(it) {
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
        thumbArrived(it);
      } catch { /* stays blank */ }
    }
    thumbBusy = false;
  }
  // a thumbnail made: into the filmstrip's and the grid's cells, and to the second window
  function thumbArrived(it) {
    for (const n of $$(`#gridIn [data-k="${CSS.escape(it.key)}"] img`)) { n.src = thumbUrl(it); n.style.transform = ''; }
    const sc = stripCells.get(it);
    if (sc) fitThumb(sc, it);
    if (current() === it) { const ph = frame.querySelector('.ph'); if (ph) { ph.src = thumbUrl(it); layout(); } }
    // the second window gets it too (asked for or not), so it has it after this page closes
    if (swWant.delete(it.key) || swOpen()) sendThumbs([it]);
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

  // ---------- the filmstrip, as Lightroom's ----------
  // Square grey cells edge to edge, the number and the flag at the top, the photo in a thin frame; the one you're on
  // lighter, its photo matted. Moving with the keys keeps it in the middle and the strip glides under it (Lightroom
  // centres it too), so holding → runs smoothly instead of jumping a screen at a time; a click in the strip leaves it
  // where it is, unless the cell clicked is at an end. Only the cells on screen exist, each made once and kept while
  // it's in sight: a move changes classes, not cells, so no thumbnail is made or decoded again.
  const film = $('#film'), strip = $('#strip'), stripIn = $('#stripIn'), filmBar = $('#filmBar'), filmThumb = $('#filmThumb');
  const CELL = 77;
  const stripCells = new Map();   // item → its cell
  let stripX = 0, stripTo = 0, stripRaf = 0, stripT = 0, stripPos = -1, stripClick = false;
  const stripMax = () => Math.max(0, view.length * CELL - strip.clientWidth);
  const stripCentre = (i) => clamp(i * CELL + CELL / 2 - strip.clientWidth / 2, 0, stripMax());
  const filmOn = () => S.step === 2 && !film.hidden && !$('#step2').classList.contains('no-film');
  function drawStrip(follow = true) {
    if (!filmOn()) return;
    if (follow && stripPos !== pos) {
      const W = strip.clientWidth, x = pos * CELL - stripX, to = stripCentre(pos);
      if (stripPos < 0 || Math.abs(to - stripX) > W * 1.5) { stripX = stripTo = to; cancelAnimationFrame(stripRaf); stripRaf = 0; }   // a new list, or far: there at once
      else if (!(stripClick && x >= CELL && x <= W - CELL * 2)) glideStrip(to);
      stripPos = pos;
    }
    stripClick = false;
    placeStrip();
  }
  // towards `to`, a little each frame (an eased follow: a new move while it glides just moves the goal)
  function glideStrip(to) {
    stripTo = clamp(to, 0, stripMax());
    if (stripRaf) return;
    stripT = 0;
    const step = (t) => {
      const dt = stripT ? Math.min(50, t - stripT) : 16;
      stripT = t;
      const d = stripTo - stripX;
      if (Math.abs(d) < 0.4) { stripX = stripTo; stripRaf = 0; placeStrip(); return; }
      stripX += d * (1 - Math.exp(-dt / 55));
      placeStrip();
      stripRaf = requestAnimationFrame(step);
    };
    stripRaf = requestAnimationFrame(step);
  }
  function placeStrip() {
    const dpr = devicePixelRatio || 1, x = Math.round(stripX * dpr) / dpr;
    stripIn.style.transform = `translate3d(${-x}px, 0, 0)`;
    fillStrip();
    // the scrollbar: its thumb as long as the share of the strip on screen
    const W = strip.clientWidth, total = view.length * CELL, T = filmBar.clientWidth;
    filmThumb.hidden = total <= W;
    if (total > W) {
      const tw = Math.max(24, Math.round((T * W) / total));
      filmThumb.style.width = `${tw}px`;
      filmThumb.style.transform = `translateX(${Math.round(((T - tw) * stripX) / Math.max(1, total - W))}px)`;
    }
  }
  function fillStrip() {
    const W = strip.clientWidth, a = Math.max(0, Math.floor(stripX / CELL) - 3), b = Math.min(view.length, Math.ceil((stripX + W) / CELL) + 3);
    const shown = new Set();
    for (let i = a; i < b; i++) {
      const it = view[i];
      shown.add(it);
      let c = stripCells.get(it);
      if (!c) { c = stripCell(it); stripCells.set(it, c); stripIn.append(c); }
      if (c.$i !== i) { c.$i = i; c.style.left = `${i * CELL}px`; c.dataset.i = i; c.firstChild.textContent = i + 1; }
      const k = cellClass(it, 'cell');
      if (c.className !== k) c.className = k;
    }
    for (const [it, c] of stripCells) if (!shown.has(it)) { c.remove(); stripCells.delete(it); }
  }
  function stripCell(it) {
    const c = el('div', { class: 'cell', 'data-k': it.key, title: it.name, role: 'button', 'aria-label': it.name }, el('span', { class: 'c-no' }), el('span', { class: 'c-pic' }));
    fitThumb(c, it);
    return c;
  }
  // the photo in its frame: as big as fits a 60 px square, its own shape (a camera's 4:3 thumbnail of a 3:2 photo is
  // cropped to 3:2), turned the photo's way
  function fitThumb(c, it) {
    const box = c.lastChild, [w, h] = dims(it), k = 60 / Math.max(w, h), fw = Math.round(w * k), fh = Math.round(h * k);
    box.style.width = `${fw}px`; box.style.height = `${fh}px`;
    const u = thumbUrl(it);
    if (!u) { wantThumb(it); box.replaceChildren(); return; }
    const img = el('img', { src: u, alt: '', draggable: 'false' });
    if (it.turn > 1) img.style.cssText = it.turn >= 5 ? `width:${fh}px;height:${fw}px;left:${(fw - fh) / 2}px;top:${(fh - fw) / 2}px;transform:${ORIENT[it.turn]}` : `transform:${ORIENT[it.turn]}`;
    box.replaceChildren(img);
  }
  // a click: that photo, the strip staying put (re-centred only for a cell at an end)
  strip.addEventListener('click', (e) => { if (stripDragged) { stripDragged = false; return; } const c = e.target.closest('.cell'); if (c) { stripClick = true; pickCell(+c.dataset.i, e); } });
  // a finger (or pen) drags it sideways; a tap still picks
  let stripDragged = false;
  strip.addEventListener('pointerdown', (e) => {
    stripDragged = false;
    if (e.pointerType === 'mouse') return;
    const x0 = e.clientX, s0 = stripX;
    const move = (ev) => { if (Math.abs(ev.clientX - x0) > 8) stripDragged = true; if (stripDragged) scrollStrip(s0 - (ev.clientX - x0)); };
    const up = () => { strip.removeEventListener('pointermove', move); strip.removeEventListener('pointerup', up); strip.removeEventListener('pointercancel', up); };
    strip.setPointerCapture(e.pointerId);
    strip.addEventListener('pointermove', move); strip.addEventListener('pointerup', up); strip.addEventListener('pointercancel', up);
  });
  // the wheel, a trackpad's swipe, the scrollbar and the end arrows scroll it freely (until the next move)
  function scrollStrip(x, smooth) { if (smooth) glideStrip(x); else { cancelAnimationFrame(stripRaf); stripRaf = 0; stripX = stripTo = clamp(x, 0, stripMax()); placeStrip(); } }
  strip.addEventListener('wheel', (e) => { e.preventDefault(); scrollStrip(stripX + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 30 : 1)); }, { passive: false });
  $('#filmPrev').addEventListener('click', () => scrollStrip(stripX - strip.clientWidth + CELL, true));
  $('#filmNext').addEventListener('click', () => scrollStrip(stripX + strip.clientWidth - CELL, true));
  filmBar.addEventListener('click', () => {});   // a tap target to a finger's touch adjustment (not the cells above it)
  filmBar.addEventListener('pointerdown', (e) => {
    const T = filmBar.clientWidth, tw = filmThumb.offsetWidth, total = view.length * CELL, W = strip.clientWidth;
    const per = Math.max(1, total - W) / Math.max(1, T - tw), r = filmBar.getBoundingClientRect(), tx = filmThumb.getBoundingClientRect().left - r.left;
    if (e.target !== filmThumb) { scrollStrip(stripX + (e.clientX - r.left < tx ? -W : W), true); return; }
    const x0 = e.clientX, s0 = stripX;
    filmBar.setPointerCapture(e.pointerId);
    const move = (ev) => scrollStrip(s0 + (ev.clientX - x0) * per);
    const up = () => { filmBar.removeEventListener('pointermove', move); filmBar.removeEventListener('pointerup', up); filmBar.removeEventListener('pointercancel', up); };
    filmBar.addEventListener('pointermove', move); filmBar.addEventListener('pointerup', up); filmBar.addEventListener('pointercancel', up);
  });
  // ▼ under it (F6): the filmstrip away and back, as Lightroom's
  function toggleFilm() {
    const off = $('#step2').classList.toggle('no-film');
    S.film = !off; remember();
    stripPos = -1;
    requestAnimationFrame(() => { layout(); drawStrip(); });
  }
  $('#togFilm').addEventListener('click', toggleFilm);
  $('#step2').classList.toggle('no-film', !S.film);
  // ▲ at the top (F5): the bar with the name and the steps away and back
  function toggleTop() { document.body.classList.toggle('no-top'); requestAnimationFrame(() => { layout(); stripPos = -1; drawStrip(); drawGrid(); }); }
  $('#togTop').addEventListener('click', toggleTop);

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
    // nothing in this filter: say so here too (the photo's own message is hidden with it)
    if (!view.length) { gridIn.style.height = `${grid.clientHeight}px`; gridIn.replaceChildren(el('p', { class: 'st-empty', text: $('#stEmpty').textContent })); return; }
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
  grid.addEventListener('click', (e) => { const c = e.target.closest('.gcell'); if (c) pickCell(+c.dataset.i, e); });
  // a click on a photo, in the grid or in the filmstrip: that one; with Shift a range, with ⌘/Ctrl one more (in the
  // grid); a double-click opens it (taken from the second click: the first redraws the grid's cells, no dblclick comes)
  function pickCell(i, e) {
    const it = view[i];
    if (!it) return;
    if (e.detail === 2 && !e.shiftKey && !e.metaKey && !e.ctrlKey) { sel.clear(); goTo(i); setGrid(false); return; }
    if (e.shiftKey && S.grid) {
      const a = view.indexOf(rangeFrom()), lo = Math.min(a, i), hi = Math.max(a, i);
      sel.clear();
      for (let k = lo; k <= hi; k++) sel.add(view[k]);
      pos = i;
    } else if ((e.metaKey || e.ctrlKey) && S.grid) {
      if (!sel.size && current()) sel.add(current());
      if (sel.has(it)) sel.delete(it); else sel.add(it);
      pos = i; anchor = it;
    } else { sel.clear(); anchor = it; goTo(i); return; }
    show(); refresh();
  }
  // where a Shift range starts: the photo it started from while that selection lasts, else the one you're on
  const rangeFrom = () => (sel.size > 1 && view.includes(anchor) ? anchor : (anchor = current()));
  function setGrid(on, quiet) {
    if (S.grid === on || !items.length) return;
    if (!quiet) record();
    S.grid = on;
    if (!on) sel.clear();
    $('#grid').hidden = !on;
    stage.hidden = on;
    $('#bGrid').classList.toggle('on', on);
    $('#bLoupe').classList.toggle('on', !on);
    $('#bZoom').hidden = on;
    stripPos = gridPos = -1;
    requestAnimationFrame(() => { if (on) { drawGrid(); grid.focus({ preventScroll: true }); } else { layout(); show(); } refresh(); });
  }
  $('#bGrid').addEventListener('click', () => setGrid(true));
  $('#bGridH').addEventListener('click', () => setGrid(true));
  $('#bLoupe').addEventListener('click', () => setGrid(false));
  const targets = () => (sel.size > 1 ? view.filter((it) => sel.has(it)) : current() ? [current()] : []);

  // ---------- the second window (/pick/second): every photo as a grid, for another screen (Lightroom's secondary display) ----------
  // It's its own page and draws itself; the two talk over a BroadcastChannel. So it keeps going when this page closes or
  // reloads, and shows the next set of photos put in here (or in another tab) without being touched. From here: the list
  // (key, name, folder) when it changes, the state (where you are, the flags, the counts) on every move, and the
  // thumbnails it asks for, as copies (they outlive this page). From there: clicks and keys, taken as if pressed here.
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('zt-pick') : null;
  const ME = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  let swSeen = 0, swLapse = 0, viewGen = 0, sentGen = -1, sentAny = false, swQueued = false, usedAt = 0;
  const swWant = new Set();
  const swOpen = () => Date.now() - swSeen < 6000;
  // when this page was last used: with two pick pages open, the second window follows the one used last
  for (const t of ['focus', 'keydown', 'pointerdown']) addEventListener(t, () => { usedAt = Date.now(); }, true);
  // held while this page lives: the second window waits on it, so it knows when this page is gone even if 'bye' isn't
  // heard (Firefox can drop it when the tab's process closes)
  if (navigator.locks) navigator.locks.request(`zt-pick-main-${ME}`, () => new Promise(() => {})).catch(() => {});
  const post = (type, extra) => { if (bc) bc.postMessage({ type, from: ME, ...extra }); };
  function secondButton() {
    const on = swOpen();
    $('#bSecond').classList.toggle('on', on);
    $('#bSecond').setAttribute('aria-pressed', String(on));
  }
  function toggleSecond() {
    if (!bc) { toast('這個瀏覽器不能開副螢幕'); return; }
    if (swOpen()) { post('close'); swSeen = 0; secondButton(); return; }
    const w = window.open(onServer ? 'second' : 'second.html', 'zt-pick-second', `popup,width=${Math.min(screen.availWidth, 1280)},height=${Math.min(screen.availHeight, 820)}`);
    if (!w) { toast('瀏覽器擋下了新視窗：請允許這個網站開彈出式視窗', 5000); return; }
    // two screens (Chrome, Edge): put it on the other one, full size (the browser asks first)
    if (screen.isExtended && window.getScreenDetails) {
      window.getScreenDetails().then((d) => {
        const other = d.screens.find((x) => x !== d.currentScreen);
        if (other && !w.closed) { w.moveTo(other.availLeft, other.availTop); w.resizeTo(other.availWidth, other.availHeight); }
      }).catch(() => {});
    }
  }
  function sendList() {
    sentGen = viewGen; sentAny = true;
    post('list', { list: view.map((it) => [it.key, it.name, it.dir]), filter: S.filter, used: document.hasFocus() ? Date.now() : usedAt });
  }
  function sendState() {
    const flags = new Int8Array(view.length);
    view.forEach((it, i) => { flags[i] = flagOf(it); });
    const picked = S.grid && sel.size > 1 ? view.reduce((a, it, i) => (sel.has(it) ? (a.push(i), a) : a), []) : [];
    post('state', { len: view.length, pos, flags, sel: picked, counts: shownCounts(), filter: S.filter });
  }
  async function sendThumbs(list) {
    const out = [];
    for (const it of list) { try { out.push({ k: it.key, blob: new Blob([await it.thumb.arrayBuffer()], { type: 'image/jpeg' }), turn: it.turn }); } catch {} }
    if (out.length) post('thumbs', { list: out });
  }
  function queueSecond() {
    // nobody listening; or a fresh page with no photos yet, and the other window keeps what it shows
    if (!bc || !swOpen() || swQueued || (!items.length && !sentAny)) return;
    swQueued = true;
    queueMicrotask(() => { swQueued = false; if (viewGen !== sentGen) sendList(); sendState(); });
  }
  if (bc) {
    bc.onmessage = ({ data: m }) => {
      if (!m || !m.type) return;
      if (m.type === 'hello' || m.type === 'here') {
        const was = swOpen();
        swSeen = Date.now();
        if (!was) secondButton();
        // and off again when it stops being heard (closed without a word, or gone with its process)
        clearTimeout(swLapse); swLapse = setTimeout(secondButton, 6100);
        // a second window that just opened (or hadn't been heard from): what we have
        if ((m.type === 'hello' || !was) && items.length) { sentGen = -1; queueSecond(); }
        return;
      }
      if (m.type === 'gone') { swSeen = 0; secondButton(); return; }
      if (m.to !== ME) return;
      if (m.type !== 'want') usedAt = Date.now();   // used from the second window: still the page in use
      if (m.type === 'want') {
        const ready = [];
        for (const k of m.keys) { const it = byKey.get(k); if (!it) continue; if (it.thumb) ready.push(it); else { swWant.add(k); wantThumb(it); } }
        sendThumbs(ready);
      } else if (m.type === 'go') { if (S.step === 2 && view[m.i]) { sel.clear(); goTo(m.i); } }
      else if (m.type === 'loupe') { if (S.grid) setGrid(false); }
      else if (m.type === 'key') {
        // the shortcuts open here: a key from there closes them, as it would here
        const d = $('#keys');
        if (d.open) { if (m.key === 'Escape' || m.key === '?' || m.key === 'Enter') d.close(); return; }
        onKey({ key: m.key, shiftKey: m.shift, metaKey: m.meta, ctrlKey: m.ctrl, altKey: m.alt, target: document.body, preventDefault() {}, getModifierState: (x) => x === 'CapsLock' && m.caps });
      }
    };
    post('hello-main');
    // the window you're using is the one it follows
    addEventListener('focus', () => { if ((items.length || sentAny) && swOpen()) { sentGen = -1; queueSecond(); } });
    addEventListener('pagehide', () => post('bye'));
  }
  $('#bSecond').addEventListener('click', toggleSecond);
  $('#bSecond').hidden = PHONE || !bc;

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

  // ---------- the filmstrip's header, as Lightroom's ----------
  function refresh() {
    if (S.step !== 2) return;
    const c = counts();
    for (const b of $$('.go2')) { b.disabled = !allowed(3); b.textContent = c.keep ? `存下 ${num(c.keep)} 張 →` : '存下來 →'; }
    drawStrip();
    if (S.grid) drawGrid();
    queueSecond();
    info(current());
    renderFilter();
    if (S.grid && sel.size > 1) $('#bKeep').disabled = $('#bDrop').disabled = false;
  }
  // the source and what's in it: "上次讀入  79 張相片 /選取了 1 張相片 /export-1.jpg ▾" (a folder chosen: its name;
  // a filter on: "N 張相片中的 n 張")
  function renderSrc() {
    const it = current(), all = S.folder ? items.filter(inFolder).length : items.length, n = S.grid && sel.size > 1 ? sel.size : it ? 1 : 0;
    $('#srcName').textContent = S.folder ? S.folder : '上次讀入';
    fill($('#stPos'), `${S.filter === 'all' ? `${num(all)} 張相片` : `${num(all)} 張相片中的 ${num(view.length)} 張`} /選取了 ${num(n)} 張相片 /`, it ? el('b', { text: it.name }) : null);
  }
  // the filter: its menu (Lightroom's presets, our four, with how many each), the switch beside it (on and off,
  // ⌘L), and the flags that show when "過濾器:" is clicked
  const FILTERS = [['all', '關閉過濾器'], ['keep', '已標註旗標'], ['none', '未標註旗標'], ['drop', '排除']];
  let lastFilter = 'keep', filterSig = '';
  function renderFilter() {
    const f = shownCounts(), n = { all: 0, keep: f.keep, none: f.none, drop: f.drop };
    const sig = `${S.filter}|${n.keep}|${n.none}|${n.drop}`;
    if (sig !== filterSig) {
      filterSig = sig;
      fill($('#filterSel'), ...FILTERS.map(([v, t]) => el('option', { value: v, text: v === 'all' ? t : `${t}（${num(n[v])}）`, selected: v === S.filter ? '' : null })));
      $('#filterSel').value = S.filter;
    }
    const on = S.filter !== 'all';
    $('#bFilterOn').classList.toggle('on', on);
    $('#bFilterOn').setAttribute('aria-checked', String(on));
    for (const b of $$('.fh-flag')) { const x = b.dataset.f === S.filter; b.classList.toggle('on', x); b.setAttribute('aria-pressed', String(x)); }
  }
  function setFilter(f) {
    if (f === S.filter) return;
    record();
    if (f !== 'all') lastFilter = f;
    S.filter = f;
    const at = current();
    rebuildView(at && matches(at) ? at : null);
    stripPos = gridPos = -1;
    show(); refresh();
  }
  $('#filterSel').addEventListener('change', (e) => { setFilter(e.target.value); e.target.blur(); });
  $('#bFilterOn').addEventListener('click', () => setFilter(S.filter === 'all' ? lastFilter : 'all'));
  $('#fhFlags').addEventListener('click', (e) => { const b = e.target.closest('.fh-flag'); if (b) setFilter(S.filter === b.dataset.f ? 'all' : b.dataset.f); });
  $('#bFilterLbl').addEventListener('click', () => {
    S.flags = $('#fhFlags').hidden; remember();
    $('#fhFlags').hidden = !S.flags;
    $('#bFilterLbl').setAttribute('aria-expanded', String(S.flags));
  });
  $('#fhFlags').hidden = !S.flags;
  $('#bFilterLbl').setAttribute('aria-expanded', String(!!S.flags));
  // the source menu (click the source or the ▾): all the photos put in, or one folder; and the order
  function renderFolders() {
    const by = new Map();
    for (const it of items) by.set(it.dir, (by.get(it.dir) || 0) + 1);
    const dirs = [...by.keys()].sort(collator.compare), mark = (on) => (on ? '✓ ' : '\u3000 ');
    const fmark = (on) => (MAC ? '' : mark(on));   // a Mac's menu checks the chosen one itself
    fill($('#srcMenu'), el('option', { value: 'f:', text: `${fmark(!S.folder)}上次讀入（${num(items.length)}）` }),
      ...(dirs.length > 1 ? dirs.map((d) => el('option', { value: `f:${d}`, text: `${fmark(!!d && S.folder === d)}${d || '（最上層）'}（${num(by.get(d))}）`, disabled: d ? null : '' })) : []),
      el('hr'),
      el('option', { value: 's:time', text: `${mark(S.sort === 'time')}依拍攝時間排序` }),
      el('option', { value: 's:folder', text: `${mark(S.sort === 'folder')}依資料夾排序` }));
    $('#srcMenu').value = `f:${S.folder}`;
  }
  function setFolder(d) {
    if (d === S.folder) return;
    record();
    S.folder = d;
    rebuildView(current() && matches(current()) ? current() : null);
    stripPos = gridPos = -1;
    show(); refresh();
  }
  function setSort(v) {
    if (v === S.sort) return;
    S.sort = v; remember();
    const at = current(); sortItems(); rebuildView(at); stripPos = gridPos = -1; show(); refresh();
  }
  $('#srcMenu').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v.startsWith('f:')) setFolder(v.slice(2)); else if (v.startsWith('s:')) setSort(v.slice(2));
    renderFolders();
    e.target.blur();
  });
  // "1", the main window: its views (Lightroom's menu), and what's ours (the details, auto-advance, the keys)
  function renderWinMenu() {
    const mark = (on) => (on ? '✓ ' : '\u3000 ');
    fill($('#winMenu'), el('option', { value: 'grid', text: `${mark(S.grid)}格點　G` }), el('option', { value: 'loupe', text: `${mark(!S.grid)}放大　E` }),
      el('hr'), el('option', { value: 'full', text: `${mark(!!document.fullscreenElement)}全螢幕　F` }),
      el('option', { value: 'film', text: `${mark(!$('#step2').classList.contains('no-film'))}底片顯示窗格　F6` }),
      el('hr'), el('option', { value: 'info', text: `${mark(S.info)}照片資訊　I` }), el('option', { value: 'auto', text: `${mark(S.auto)}自動前進` }),
      el('hr'), el('option', { value: 'keys', text: '\u3000 快捷鍵…　?' }));
    $('#winMenu').selectedIndex = -1;
  }
  for (const t of ['pointerdown', 'focus', 'keydown']) $('#winMenu').addEventListener(t, renderWinMenu);
  for (const m of $$('.fhead select')) { m.addEventListener('pointerdown', () => { m.$mouse = true; }); m.addEventListener('blur', () => { m.$mouse = false; }); }
  $('#winMenu').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.blur();
    if (v === 'grid') setGrid(true); else if (v === 'loupe') setGrid(false); else if (v === 'full') fullScreen(); else if (v === 'film') toggleFilm();
    else if (v === 'info') setInfo(!S.info); else if (v === 'auto') { S.auto = !S.auto; remember(); $('#auto').checked = S.auto; } else if (v === 'keys') $('#keys').showModal();
    renderWinMenu();
  });
  renderWinMenu();
  // ← → in the header, as Lightroom's: back and forward through where you've been (the filter, the folder, grid or
  // one photo), like a browser's
  const hist = [], fut = [];
  const here = () => ({ filter: S.filter, folder: S.folder, grid: S.grid });
  function record() { hist.push(here()); if (hist.length > 60) hist.shift(); fut.length = 0; histButtons(); }
  function histButtons() { $('#bBack').disabled = !hist.length; $('#bFwd').disabled = !fut.length; }
  function travel(from, to) {
    if (!from.length) return;
    to.push(here());
    let v;
    do {
      v = from.pop();
      if (v.folder && !items.some((it) => it.dir === v.folder)) v.folder = '';   // its photos taken out since
    } while (from.length && v.filter === S.filter && v.folder === S.folder && v.grid === S.grid);   // nothing would change: further
    if (v.filter === S.filter && v.folder === S.folder && v.grid === S.grid) { to.pop(); histButtons(); return; }
    if (v.filter !== S.filter || v.folder !== S.folder) {
      if (v.filter !== 'all') lastFilter = v.filter;
      S.filter = v.filter; S.folder = v.folder;
      const at = current();
      rebuildView(at && matches(at) ? at : null);
      stripPos = gridPos = -1;
    }
    if (v.grid !== S.grid) setGrid(v.grid, true); else { show(); refresh(); }
    renderFolders(); histButtons();
  }
  $('#bBack').addEventListener('click', () => travel(hist, fut));
  $('#bFwd').addEventListener('click', () => travel(fut, hist));
  document.addEventListener('change', (e) => {
    const r = e.target;
    if (r.type !== 'radio') return;
    if (r.name === 'take' || r.name === 'lay') { S[r.name] = r.value; if (r.name === 'lay') remember(); renderStep3(); }
  });
  $('#auto').checked = S.auto;
  $('#auto').addEventListener('change', (e) => { S.auto = e.target.checked; remember(); e.target.blur(); });
  $('#bKeep').addEventListener('click', () => mark(targets(), flagOf(current()) === 1 && sel.size <= 1 ? 0 : 1, S.auto));
  $('#bDrop').addEventListener('click', () => mark(targets(), flagOf(current()) === -1 && sel.size <= 1 ? 0 : -1, S.auto));
  $('#bZoom').addEventListener('click', () => toggleZoom());
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
  let resizeShow = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeTimer);
    resizeTimer = requestAnimationFrame(() => { if (S.step === 2) { layout(); stripPos = -1; drawStrip(); drawGrid(); } });
    // once it's done resizing: the photo again, so a preview made for a smaller window is made bigger
    clearTimeout(resizeShow);
    resizeShow = setTimeout(() => {
      if (S.step !== 2 || S.grid) return;
      const it = current(), v = it && previews.get(it);
      if (v && !Z.on && v.long < pvLong(it) * 0.85) show(); else pvPlan();   // the next ones remade at the new size too
    }, 300);
  }).observe($('#viewer'));

  // ---------- keys ----------
  function onKey(e) {
    if (S.step !== 2 || $('#keys').open) return;
    // the folder or order menu still focused (opened, then closed without a change): the culling keys are for the photos
    const menu = e.target.closest && e.target.closest('select');
    if (menu && menu.closest('.fhead')) {
      if (e.key === 'Tab' || (!menu.$mouse && (e.key === ' ' || e.key === 'Enter'))) return;
      menu.blur();
      // blurring doesn't stop the menu's own handling of this key (an arrow would change it)
      if (/^(Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End)$/.test(e.key)) e.preventDefault();
    } else if (menu && !e.metaKey && !e.ctrlKey && !e.altKey && /^(ArrowLeft|ArrowRight|Home|End|Delete|Backspace|[pPxXuU`0iIzZgGeEfF?])$/.test(e.key)) menu.blur();
    else if (e.target.closest && e.target.closest('input[type="text"], select, textarea')) return;
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && (k === 'z' || k === 'Z') && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
    // ⌘L: the filter off and back on (Lightroom's 開啟/關閉過濾器)
    if (mod && !e.altKey && (k === 'l' || k === 'L')) { e.preventDefault(); setFilter(S.filter === 'all' ? lastFilter : 'all'); return; }
    if (mod || e.altKey) return;
    if (!view.length && !/^([gGiIeE?]|Enter|Escape|F5|F6)$/.test(k)) return;
    const advance = S.auto || e.shiftKey || (e.getModifierState && e.getModifierState('CapsLock'));
    const one = () => (sel.size > 1 && S.grid ? targets() : [current()]);
    let done = true;
    switch (k) {
      case 'ArrowRight': if (S.grid && e.shiftKey) extend(1); else go(1); break;
      case 'ArrowLeft': if (S.grid && e.shiftKey) extend(-1); else go(-1); break;
      case 'ArrowUp': if (S.grid) { if (e.shiftKey) extend(-cols); else go(-cols); } else done = false; break;
      case 'ArrowDown': if (S.grid) { if (e.shiftKey) extend(cols); else go(cols); } else done = false; break;
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
      case 'F5': toggleTop(); break;
      case 'F6': toggleFilm(); break;
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
    const a = view.indexOf(rangeFrom()), i = clamp(pos + d, 0, view.length - 1);
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
    fill($('#takeLine'), el('b', { text: `${num(list.length)} 張` }), ...(list.length ? [`・${fmtBytes(bytes)}・`, list.length === 1 ? '直接下載這張' : CAN_DIR ? '存進你選的資料夾' : '打包成 ZIP 下載'] : []));
    const same = list.length - new Set(list.map((it) => it.name.toLowerCase())).size;
    $('#outHelp').textContent = list.length <= 1 ? '' : CAN_DIR
      ? `選一個資料夾（可以新建一個空的），照片會原封不動複製進去${same && S.lay === 'flat' ? `；同名的 ${num(same)} 張會加上 -2` : ''}。資料夾裡已經有的同一張會跳過，所以多挑幾張再存一次也可以。`
      : `照片原封不動打包${same && S.lay === 'flat' ? `；同名的 ${num(same)} 張會加上 -2` : ''}。用電腦版 Chrome 或 Edge 可以直接存進資料夾，不用再解壓。`;
    const go = $('#go');
    go.disabled = !list.length;
    go.textContent = !list.length ? '存下來 →' : list.length === 1 ? '下載這張 →' : CAN_DIR ? '選資料夾，存進去 →' : `下載 ZIP（${num(list.length)} 張）→`;
    $('#goZip').hidden = go.hidden || !(CAN_DIR && list.length > 1);
    $('#note3').textContent = !list.length ? (S.take === 'keep' ? '還沒有標「留用」的照片' : '每一張都標了「排除」') : '';
  }
  $('#go').addEventListener('click', () => { const list = takeList(); if (list.length === 1) saveOne(list[0]); else if (CAN_DIR) saveDir(list); else saveZip(list); });
  $('#goZip').addEventListener('click', () => saveZip(takeList()));
  function fresh3() { $('#after').hidden = true; $('#big').hidden = true; $('#outSets').hidden = false; $('#fails').hidden = true; renderFoot3(true); renderStep3(); }
  $('#again').addEventListener('click', fresh3);
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
      const entries = [], net = list.filter((it) => !it.z && !it.file).length;
      let got = 0;
      for (const it of list) {
        const { dir, name } = names.get(it), path = dir ? `${dir}/${name}` : name;
        if (it.z) { const at = await dataStart(it.z); entries.push({ name: path, raw: { data: it.z.zip.slice(at, at + it.z.csize), method: it.z.method, crc: it.z.crc, size: it.z.size }, lastModified: it.z.mod }); }
        else if (it.file) entries.push({ name: path, file: it.file });
        else {
          // a demo photo: downloaded first, one by one (one that doesn't come is left out, and listed)
          fill($('#bigWhat'), `下載照片 ${num(++got)}／${num(net)}…`);
          try { entries.push({ name: path, file: await blobOf(it) }); } catch { export_.fails.push({ name: it.name, why: '下載不到' }); }
        }
      }
      if (!entries.length) throw new Error('nothing to pack');
      if (got) fill($('#bigWhat'), '打包中…');
      const all = entries.reduce((a, x) => a + (x.raw ? x.raw.data.size : x.file.size), 0), n = entries.length;
      const blob = await ManyZip.files(entries, (d) => { export_.done = Math.min(n, Math.round((d / all) * n)); progress(); });
      export_.done = list.length;
      download(blob, `挑好的照片-${n}張.zip`);
      finish(['開始下載了：', el('b', { text: `${num(n)} 張` }), `，${fmtBytes(blob.size)}`]);
    } catch (e) {
      console.error(e);
      if (!export_.fails.length) export_.fails.push({ name: 'ZIP', why: '打包失敗' });
      finish(['沒有打包成功']);
    }
    window.removeEventListener('beforeunload', hold);
  }
  function hold(e) { e.preventDefault(); e.returnValue = ''; }

  // ---------- the counter ----------
  // Only a number leaves the browser: how many photos were saved.
  function count(n) {
    if (!onServer || !n || DEMO) return;
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
  // the demo: its photos listed by the server, read like a folder (only each photo's start, until it's looked at)
  async function startDemo() {
    document.body.classList.add('demo');
    $('#demoTag').hidden = false;
    reading('正在準備示範照片…');
    let list = [];
    try { const r = await fetch('demo/list.json', { cache: 'no-store' }); if (r.ok) list = await r.json(); } catch {}
    reading('');
    if (!list.length) { toast('示範照片還沒準備好，請晚一點再試', 6000); return; }
    await markReady.catch(() => {});
    // ?v: a new demo.zip is new photos to the browser's (and Cloudflare's) cache, though the names stay
    await add(list.map((x) => ({ url: `demo/${encodeURIComponent(x.name)}?v=${Math.round(x.mtime)}`, name: x.name, size: x.size, mod: x.mtime })));
  }
  if (DEMO && !ON_PHONE) startDemo();
  loadStats();
  renderStep1();
  renderStepper();
})();
