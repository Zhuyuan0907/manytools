/* ZhuyuanLoveFormat — pictures from one format to another, all in this browser: HEIC (an iPhone's), PNG, WebP, GIF,
   AVIF, BMP, JPG in; JPG, PNG or WebP out (AVIF where the browser can write it). Three steps: 1 drop pictures →
   2 settings → 3 download. Pictures are converted when step 3 opens, and again only if a setting changed.
   Decoding: the browser's own (Safari's HEIC too); HEIC elsewhere with libheif, the photo tool's worker
   (/exif/assets/heic.js). Encoding: a canvas. A JPG keeps the photo's EXIF (exif.js): upright, its new size, the
   place taken out unless asked to keep it. On a server only the count of pictures is reported, never a picture or
   its name. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const fill = (node, ...kids) => node.replaceChildren(...kids.filter((x) => x != null && x !== false));
  const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
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
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const TYPE_NAME = { 'image/jpeg': 'JPG', 'image/webp': 'WebP', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/avif': 'AVIF', 'image/bmp': 'BMP', 'image/heic': 'HEIC', 'image/heif': 'HEIF', 'image/tiff': 'TIFF' };
  const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png', 'image/avif': 'avif' };
  const FMT_HELP = {
    'image/jpeg': '照片最適合，到處都能開、都能上傳',
    'image/png': '不失真、保留透明背景，檔案比較大',
    'image/webp': '同畫質比 JPG 小，新的網站和 App 都支援',
    'image/avif': '比 WebP 再小一些，舊的軟體可能打不開',
  };
  // an iPhone or an iPad: its Safari draws at most 16.7 million pixels on a canvas
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const MAX_AREA = IOS ? 16777216 : 268435456;
  const canPickFolder = typeof window.showDirectoryPicker === 'function';

  // ---------- what this browser can write: WebP (not Safari), AVIF (hardly any) ----------
  function canvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function encode(c, type, quality) {
    if (c.convertToBlob) return c.convertToBlob({ type, quality });
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), type, quality));
  }
  const writes = {};
  (async () => {
    for (const t of ['image/webp', 'image/avif']) {
      // (a canvas without a context can't be encoded at all)
      try { const c = canvas(2, 2); c.getContext('2d').fillRect(0, 0, 1, 1); writes[t] = (await encode(c, t, 0.8)).type === t; } catch { writes[t] = false; }
    }
    $('#avifOpt').hidden = !writes['image/avif'];
    if (!writes['image/webp']) { $('#webpOpt input').disabled = true; $('#webpOpt').title = '這個瀏覽器不能存 WebP（Safari），請改用 Chrome、Edge 或 Firefox'; }
    render();
  })();

  // ---------- settings ----------
  function settings() {
    return { type: $('input[name=fmt]:checked').value, quality: +$('input[name=q]:checked').value, bg: $('input[name=bg]:checked').value, maxSide: +$('#maxSide').value, meta: $('input[name=meta]:checked').value };
  }
  const keyOf = (s) => JSON.stringify(s);
  for (const n of $$('input[name=fmt], input[name=q], input[name=bg], input[name=meta], #maxSide')) n.addEventListener('change', render);

  // ---------- steps ----------
  const S = { step: 1, ran: false };
  const STEP_NAMES = ['放入圖片', '轉檔設定', '下載'];
  let items = [], nextId = 1;
  const readable = () => items.filter((it) => !it.unreadable);
  function allowed(n) {
    if (n === 1) return true;
    if (n === 2) return readable().length > 0 && items.every((it) => it.w || it.unreadable || it.heic);
    return allowed(2) && S.ran;
  }
  function goto(n) {
    if (!allowed(n)) return;
    S.step = n;
    for (let i = 1; i <= 3; i++) $(`#step${i}`).hidden = i !== n;
    if (n === 3) startRun();
    render();
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-goto]'); if (b && !b.disabled) goto(+b.dataset.goto); });
  $('#next1').addEventListener('click', () => goto(2));
  $('#next2').addEventListener('click', () => { S.ran = true; goto(3); });
  function renderStepper() {
    for (const b of $$('.stepper button')) {
      const n = +b.dataset.goto;
      b.classList.toggle('current', n === S.step);
      b.classList.toggle('done', n < S.step);
      b.disabled = !allowed(n);
      b.setAttribute('aria-current', n === S.step ? 'step' : 'false');
    }
    $('#mStep').replaceChildren(`步驟 ${S.step}／3・`, el('b', { text: STEP_NAMES[S.step - 1] }));
  }
  function render() {
    renderStepper();
    if (S.step === 1) renderStep1();
    if (S.step === 2) renderStep2();
    if (S.step === 3) renderStep3();
  }

  // ---------- step 1: pictures ----------
  const drop = $('#drop'), input = $('#fileInput');
  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (S.step === 1 && e.dataTransfer) add(e.dataTransfer.files); });

  const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif|tiff?)$/i.test(f.name);
  const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type);
  const typeName = (f) => TYPE_NAME[f.type] || (isHeic(f) ? 'HEIC' : (f.name.split('.').pop() || '').toUpperCase());
  function add(list) {
    const files = [...list].filter(isImage);
    if (!files.length) { if (list.length) toast('這不是圖片檔'); return; }
    for (const file of files) {
      if (items.some((it) => it.file.name === file.name && it.file.size === file.size)) continue;
      const it = { id: nextId++, file, src: URL.createObjectURL(file), status: 'wait', w: 0, h: 0, heic: false, unreadable: false, key: null };
      items.push(it);
      // its size (and that it opens): an <img> knows; a HEIC only Safari's does, the others get it from libheif later
      const probe = new Image();
      probe.onload = () => { it.w = probe.naturalWidth; it.h = probe.naturalHeight; render(); };
      probe.onerror = () => { if (isHeic(file)) it.heic = true; else it.unreadable = true; render(); };
      probe.src = it.src;
    }
    render();
  }
  function remove(it) {
    items = items.filter((x) => x !== it);
    URL.revokeObjectURL(it.src);
    if (it.result) URL.revokeObjectURL(it.result.url);
    if (!readable().length && S.step !== 1) goto(1); else render();
  }
  const thumb = (it, cls) => (it.heic || it.unreadable ? el('span', { class: `${cls} none`, text: it.heic ? 'HEIC' : '?' }) : el('img', { class: cls, src: it.src, alt: '' }));
  function renderStep1() {
    $('#step1').classList.toggle('has-files', items.length > 0);
    $('#sources').replaceChildren(...items.map((it) => {
      const meta = it.unreadable ? '看不懂這張圖片，可能檔案壞了或格式不支援' : it.w ? `${fmtBytes(it.file.size)}・${it.w}×${it.h}・${typeName(it.file)}` : it.heic ? `${fmtBytes(it.file.size)}・HEIC（iPhone 照片）` : '讀取中…';
      return el('li', { class: 'src' }, thumb(it, 'src-th'),
        el('span', { class: 'src-text' },
          el('span', { class: 'src-name', text: it.file.name, title: it.file.name }),
          el('span', { class: `src-meta${it.unreadable ? ' bad' : ''}`, text: meta, title: meta })),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': `移除 ${it.file.name}`, title: '移除', text: '×', onclick: () => remove(it) }));
    }));
    const ok = readable(), size = ok.reduce((a, it) => a + it.file.size, 0);
    $('#note1').textContent = !items.length ? '還沒有加入圖片。' : `${ok.length} 張圖片・共 ${fmtBytes(size)}${items.length > ok.length ? `・${items.length - ok.length} 張讀不了` : ''}`;
    $('#next1').disabled = !allowed(2);
  }

  // ---------- step 2: settings, and what will happen ----------
  function renderStep2() {
    const s = settings(), ok = readable(), jpg = s.type === 'image/jpeg';
    $('#fmtHelp').textContent = FMT_HELP[s.type];
    $('#qSet').hidden = s.type === 'image/png';
    $('#qHelp').textContent = s.quality >= 0.9 ? '幾乎看不出差別，檔案比較大' : s.quality >= 0.8 ? '一般用途，大小適中' : '檔案小，細節會少一點';
    $('#bgSet').hidden = !jpg;
    $('#metaSet').hidden = !jpg;
    const line = (cls, ...words) => el('li', { class: cls }, el('span', {}, ...words));
    const lines = [line(null, '轉成 ', el('b', { text: TYPE_NAME[s.type] }), s.type === 'image/png' ? '，不失真' : `，畫質 ${Math.round(s.quality * 100)}%`)];
    const same = ok.filter((it) => it.file.type === s.type);
    if (same.length) lines.push(line(null, el('b', { text: `${same.length} 張` }), `原本就是 ${TYPE_NAME[s.type]}，會重新存一次`));
    if (s.maxSide) lines.push(line(null, '最長邊縮到 ', el('b', { text: `${s.maxSide} px` }), '（比較小的不放大）'));
    if (jpg) lines.push(line(null, s.meta === 'none' ? '拍攝資訊' : s.meta === 'all' ? '拍攝時間、相機和位置' : '拍攝時間、相機', el('b', { text: s.meta === 'none' ? '都拿掉' : s.meta === 'all' ? '都保留' : '保留，位置拿掉' })));
    else lines.push(line('warn', `${TYPE_NAME[s.type]} 不帶拍攝資訊（時間、相機、位置）`));
    if (jpg && ok.some((it) => /png|webp|gif|avif/.test(it.file.type))) lines.push(line('warn', `透明的地方會變成${s.bg === '#000000' ? '黑色' : '白色'}`));
    if (IOS && ok.some((it) => it.w * it.h > MAX_AREA)) lines.push(line('warn', 'iPhone、iPad 上超過 1600 萬像素的會縮小'));
    if (items.length > ok.length) lines.push(line('warn', `${items.length - ok.length} 張讀不了，會略過`));
    $('#plan').replaceChildren(...lines);
    $('#note2').textContent = `${ok.length} 張・共 ${fmtBytes(ok.reduce((a, it) => a + it.file.size, 0))}`;
    setText($('#next2'), ok.length > 1 ? `開始轉檔 ${ok.length} 張 →` : '開始轉檔 →');   // (only when it changes: WebKit drops a click on a button whose text was just replaced)
  }

  // ---------- decoding: the browser's own, else libheif for a HEIC ----------
  // (libheif in a worker of its own, the photo tool's, fetched on the first HEIC; ended when idle: its memory only grows)
  let heicWorker = null, heicSeq = 0, heicIdle = 0;
  const heicJobs = new Map();
  function heicDecode(file, maxSide, p3) {
    return new Promise((resolve) => {
      if (!heicWorker) {
        try { heicWorker = new Worker(onServer ? '/exif/assets/heic.js' : '../exiftools/assets/heic.js'); } catch { resolve(null); return; }
        heicWorker.onmessage = ({ data: d }) => {
          const done = heicJobs.get(d.id);
          heicJobs.delete(d.id);
          if (done) done(d.bmp ? { bmp: d.bmp, w: d.w, h: d.h } : null);
          if (!heicJobs.size) { clearTimeout(heicIdle); heicIdle = setTimeout(() => { if (heicWorker && !heicJobs.size) { heicWorker.terminate(); heicWorker = null; } }, 15000); }
        };
        heicWorker.onerror = () => { for (const [, done] of heicJobs) done(null); heicJobs.clear(); heicWorker.terminate(); heicWorker = null; };
      }
      clearTimeout(heicIdle);
      const id = ++heicSeq;
      heicJobs.set(id, resolve);
      heicWorker.postMessage({ id, file, maxSide, p3: !!p3 });
    });
  }
  async function decode(it, maxSide, p3) {
    try { return await createImageBitmap(it.file, { imageOrientation: 'from-image' }); } catch {}
    if (isHeic(it.file) || it.heic) {
      const r = await heicDecode(it.file, maxSide, p3);
      if (r) return r.bmp;
    }
    throw Object.assign(new Error('decode'), { code: 'decode' });
  }

  // ---------- one picture ----------
  async function convert(it, s) {
    const jpg = s.type === 'image/jpeg', heic = isHeic(it.file) || it.heic;
    // its EXIF (for a JPG) and, for a HEIC, whether its colours are Display P3
    const info = (jpg && s.meta !== 'none') || heic ? await ZExif.read(it.file) : { tiff: null, p3: false };
    const bmp = await decode(it, s.maxSide, info.p3);
    try {
      let w = bmp.width, h = bmp.height;
      let k = s.maxSide && Math.max(w, h) > s.maxSide ? s.maxSide / Math.max(w, h) : 1;
      if (w * h * k * k > MAX_AREA) k = Math.sqrt(MAX_AREA / (w * h));
      w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
      const c = canvas(w, h), g = c.getContext('2d');
      if (jpg) { g.fillStyle = s.bg; g.fillRect(0, 0, w, h); }   // JPG has no transparency
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, w, h);
      let blob = await encode(c, s.type, s.type === 'image/png' ? undefined : s.quality);
      if (blob.type !== s.type) throw Object.assign(new Error('encode'), { code: 'encode' });
      let kept = false;
      if (jpg && s.meta !== 'none' && info.tiff) {
        const withExif = await ZExif.intoJpeg(blob, ZExif.fit(info.tiff, { w, h, gps: s.meta === 'all' }));
        if (withExif) { blob = withExif; kept = true; }
      }
      return { ok: true, blob, width: w, height: h, type: s.type, kept, shrunk: k < 1 && !(s.maxSide && Math.max(bmp.width, bmp.height) > s.maxSide) };
    } finally { if (bmp.close) bmp.close(); }
  }

  // ---------- step 3: convert, then download ----------
  let running = false;
  function startRun() {
    const key = keyOf(settings());
    for (const it of readable()) if (it.key !== key) { it.status = 'wait'; it.key = key; }
    if (!running) loop();
  }
  async function loop() {
    running = true;
    for (;;) {
      const it = items.find((x) => x.status === 'wait' && !x.unreadable);
      if (!it) break;
      const s = settings(), key = keyOf(s);
      it.status = 'busy';
      render();
      let r;
      try { r = await convert(it, s); } catch (e) { r = { ok: false, code: (e && e.code) || 'error' }; console.error(e); }
      if (!items.includes(it)) continue;
      if (it.key !== key) { it.status = 'wait'; continue; }   // settings changed meanwhile; this one runs again
      if (r.ok) {
        if (it.result) URL.revokeObjectURL(it.result.url);
        it.result = { ...r, url: URL.createObjectURL(r.blob), size: r.blob.size };
        it.status = 'done';
        if (it.heic && !it.w) { it.w = r.width; it.h = r.height; }
        count(it);
      } else { it.status = 'error'; it.code = r.code; }
      render();
    }
    running = false;
    render();
  }

  function renderStep3() {
    const ok = readable(), done = ok.filter((it) => it.status === 'done');
    const busy = ok.filter((it) => it.status === 'busy' || it.status === 'wait').length;
    const src = done.reduce((a, it) => a + it.file.size, 0), out = done.reduce((a, it) => a + it.result.size, 0);
    fill($('#sum'),
      el('span', {}, el('b', { text: ok.length }), ' 張'),
      done.length ? el('span', {}, `${fmtBytes(src)} → `, el('b', { text: fmtBytes(out) })) : null,
      busy ? el('span', { text: `${busy} 張轉檔中…` }) : null);
    $('#h3p').textContent = busy ? '轉檔中，圖片只在你的電腦裡處理' : done.length ? '轉好的圖片在這裡，可以一張一張下載' : '';
    $('#results').replaceChildren(...ok.map(row));
    $('#note3').textContent = busy ? `${done.length} / ${ok.length} 張完成` : `${done.length} 張完成`;
    // one picture comes as itself; two or more go into a folder (Chrome, Edge) or a ZIP
    const many = done.length > 1, folder = many && canPickFolder;
    $('#saveAll').disabled = !done.length || busy > 0;
    setText($('#saveAll'), !many ? '下載圖片' : folder ? '存到資料夾…' : '全部下載（ZIP）');
    $('#zipAlt').hidden = !folder || busy > 0;
  }
  const errText = (it) => (it.code === 'decode' ? (isHeic(it.file) ? '這張 HEIC 打不開，可能檔案壞了' : '看不懂這張圖片，可能檔案壞了')
    : it.code === 'encode' ? `這個瀏覽器不能存成 ${TYPE_NAME[settings().type]}` : '這張沒辦法轉檔');
  function row(it) {
    const r = it.result, busy = it.status === 'busy' || it.status === 'wait';
    const sub = el('span', { class: 'size' });
    if (busy) sub.textContent = it.status === 'busy' ? '轉檔中…' : '等待中…';
    else if (it.status === 'error') { sub.className = 'bad'; sub.textContent = errText(it); }
    else sub.append(`${fmtBytes(it.file.size)} → `, el('b', { text: fmtBytes(r.size) }), el('span', { class: 'dim', text: `・${r.width}×${r.height}${r.kept ? '・保留拍攝資訊' : ''}${r.shrunk ? '・縮小了（iPhone、iPad 的上限）' : ''}` }));
    return el('li', { class: 'row' }, el('div', { class: 'row-main' },
      r && it.status === 'done' ? el('img', { class: 'th', src: r.url, alt: '', width: 56, height: 56 }) : thumb(it, 'th'),
      el('span', { class: 'who' }, el('b', { text: it.status === 'done' ? `${it.file.name} → ${outName(it)}` : it.file.name, title: it.file.name }), sub),
      el('span', { class: 'row-acts' },
        busy ? el('span', { class: 'spinner', 'aria-label': '處理中' }) : null,
        it.status === 'done' ? el('button', { type: 'button', class: 'btn', text: '下載', onclick: () => download(it) }) : null)));
  }

  // ---------- download ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  const outName = (it) => `${it.file.name.replace(/\.[^.]+$/, '')}.${EXT[it.result.type] || 'jpg'}`;
  function save(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  const download = (it) => save(it.result.blob, outName(it));
  // (two pictures of the same name get " (2)")
  function names(done) {
    const used = new Set();
    return done.map((it) => {
      let name = outName(it), n = 2;
      while (used.has(name.toLowerCase())) name = outName(it).replace(/(\.[^.]+)$/, ` (${n++})$1`);
      used.add(name.toLowerCase());
      return [it, name];
    });
  }
  async function zip() {
    const files = [];
    for (const [it, name] of names(readable().filter((x) => x.status === 'done'))) files.push({ name, data: new Uint8Array(await it.result.blob.arrayBuffer()) });
    save(ManyZip.make(files), `圖片轉檔-${files.length}張.zip`);
  }
  async function toFolder() {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'manytools-format-out', mode: 'readwrite', startIn: 'pictures' }); }
    catch (e) { if (e && e.name !== 'AbortError') zip(); return; }
    let n = 0;
    for (const [it, name0] of names(readable().filter((x) => x.status === 'done'))) {
      let name = name0, k = 2;
      // (a file of that name already there stays: this one gets " (2)")
      for (;;) { try { await dir.getFileHandle(name); name = name0.replace(/(\.[^.]+)$/, ` (${k++})$1`); } catch { break; } }
      try {
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(it.result.blob); await w.close(); n++;
      } catch {}
    }
    toast(`已存 ${n} 張到「${dir.name}」`);
  }
  $('#saveAll').addEventListener('click', () => {
    const done = readable().filter((it) => it.status === 'done');
    if (done.length === 1) download(done[0]); else if (canPickFolder) toFolder(); else zip();
  });
  $('#zipAlt').addEventListener('click', zip);
  $('#restart').addEventListener('click', () => {
    for (const it of items) { URL.revokeObjectURL(it.src); if (it.result) URL.revokeObjectURL(it.result.url); }
    items = []; S.ran = false;
    goto(1);
  });

  // ---------- the counter ----------
  // Only numbers leave the browser: one per picture, the first time it's converted.
  const counted = new Set();
  function count(it) {
    if (counted.has(it.id) || !onServer) return;
    counted.add(it.id);
    fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ files: 1 }) }).then(loadStats).catch(() => {});
  }
  async function loadStats() {
    if (!onServer) return;
    try {
      const r = await fetch('api/stats', { cache: 'no-store' });
      const st = r.ok ? await r.json() : null;
      if (st && st.files > 0) fill($('#heroCount'), '已幫大家轉了 ', el('b', { class: 'hero-num', text: st.files.toLocaleString('zh-TW') }), ' 張圖片');
    } catch {}
  }
  window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });
  loadStats();
  render();
})();
