/* ZhuyuanLoveCrop — avatars cut out in this browser. Three steps: 1 drop pictures → 2 crop each one (drag to move,
   wheel / pinch / slider to zoom, turn and flip; a dashed circle shows what round avatars show) → 3 shape (round
   unless changed), size and format, then download one, or all as a ZIP. On a server only the number of pictures is
   reported, never a picture or its name. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const fill = (node, ...kids) => node.replaceChildren(...kids.filter((x) => x != null && x !== false));
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    n.append(...kids.filter((x) => x != null && x !== false));
    return n;
  };
  const onServer = /^https?:$/.test(location.protocol);
  if (onServer) $('#brand').href = '/';
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const TYPE_NAME = { 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/avif': 'AVIF', 'image/bmp': 'BMP', 'image/heic': 'HEIC', 'image/heif': 'HEIF' };
  const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

  // ---------- pictures ----------
  // item: { id, file, src, w, h (as shown, from the file), unreadable, bw, bh (decoded size), crop, touched, result, key, status }
  let items = [], nextId = 1, cur = null;
  const readable = () => items.filter((it) => !it.unreadable);
  // decoded pictures are big; keep the last few
  const bitmaps = new Map();
  async function bitmapOf(it) {
    if (bitmaps.has(it.id)) { const b = bitmaps.get(it.id); bitmaps.delete(it.id); bitmaps.set(it.id, b); return b; }
    const bmp = await createImageBitmap(it.file, { imageOrientation: 'from-image' });
    bitmaps.set(it.id, bmp);
    for (const [id, b] of bitmaps) {
      if (bitmaps.size <= 3) break;
      if (cur && id === cur.id) continue;
      b.close && b.close(); bitmaps.delete(id);
    }
    it.bw = bmp.width; it.bh = bmp.height;
    return bmp;
  }

  // ---------- crop geometry ----------
  // A crop lives in the picture as it's shown (after turning and flipping): rot (0/90/180/270, clockwise),
  // flip (left-right), and a square of side L centred on (cx, cy) in those pixels.
  const dims = (it, c) => (c.rot % 180 ? [it.bh, it.bw] : [it.bw, it.bh]);
  function orient(ctx, it, c) {   // canvas transform: the file's pixels → the picture as shown
    const W = it.bw, H = it.bh;
    if (c.flip) ctx.transform(-1, 0, 0, 1, dims(it, c)[0], 0);
    if (c.rot === 90) ctx.transform(0, 1, -1, 0, H, 0);
    else if (c.rot === 180) ctx.transform(-1, 0, 0, -1, W, H);
    else if (c.rot === 270) ctx.transform(0, -1, 1, 0, 0, W);
  }
  // the crop's square drawn at (x, y) with side D; the rest of the picture is drawn too, around it
  function drawCrop(ctx, bmp, it, c, x, y, D) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(D / c.L, D / c.L);
    ctx.translate(c.L / 2 - c.cx, c.L / 2 - c.cy);
    orient(ctx, it, c);
    ctx.drawImage(bmp, 0, 0);
    ctx.restore();
  }
  // zoomed in: at least a tenth of the short side; zoomed out: the whole picture fits in the square
  function limits(it, c) {
    const [SW, SH] = dims(it, c);
    return { min: Math.max(16, Math.min(SW, SH) / 10), max: Math.max(SW, SH), SW, SH };
  }
  // the picture covers the square along a side where it's big enough, and stays inside it where it isn't
  function clamp(it, c) {
    const { min, max, SW, SH } = limits(it, c);
    c.L = Math.min(max, Math.max(min, c.L));
    const fit = (v, dim) => { const a = c.L / 2, b = dim - c.L / 2; return Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b)); };
    c.cx = fit(c.cx, SW); c.cy = fit(c.cy, SH);
  }
  const hasEmpty = (it) => { if (!it.crop) return false; const [SW, SH] = dims(it, it.crop); return it.crop.L > SW + 0.5 || it.crop.L > SH + 0.5; };
  // a first guess: the largest square, a little above the middle on a portrait (faces sit high);
  // where the browser can find faces, around the biggest face
  async function firstCrop(it, bmp) {
    const c = { rot: 0, flip: false, L: Math.min(it.bw, it.bh), cx: it.bw / 2, cy: it.bh > it.bw ? it.bh * 0.42 : it.bh / 2 };
    if (typeof window.FaceDetector === 'function') {
      try {
        const faces = await new window.FaceDetector({ fastMode: true, maxDetectedFaces: 5 }).detect(bmp);
        const f = faces.map((x) => x.boundingBox).sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (f) { c.L = Math.max(f.width, f.height) * 2.4; c.cx = f.x + f.width / 2; c.cy = f.y + f.height * 0.62; }
      } catch { /* no face finding here */ }
    }
    clamp(it, c);
    return c;
  }

  // ---------- steps ----------
  const S = { step: 1, ran: false };
  const STEP_NAMES = ['放入圖片', '裁切', '輸出與下載'];
  function allowed(n) {
    if (n === 1) return true;
    if (n === 2) return readable().length > 0 && items.every((it) => it.w || it.unreadable);
    return allowed(2) && S.ran;
  }
  function goto(n) {
    if (!allowed(n)) return;
    S.step = n;
    for (let i = 1; i <= 3; i++) $(`#step${i}`).hidden = i !== n;
    if (n === 2) { if (!cur || !items.includes(cur) || cur.unreadable) select(readable()[0]); else sizeStage(); }
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

  const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i.test(f.name);
  const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type);
  const typeName = (f) => TYPE_NAME[f.type] || (isHeic(f) ? 'HEIC' : (f.name.split('.').pop() || '').toUpperCase());
  function add(list) {
    const files = [...list].filter(isImage);
    if (!files.length) { if (list.length) toast('這不是圖片檔'); return; }
    for (const file of files) {
      if (items.some((it) => it.file.name === file.name && it.file.size === file.size)) continue;
      const it = { id: nextId++, file, src: URL.createObjectURL(file), w: 0, h: 0, unreadable: false, crop: null, touched: false, result: null, key: null, status: 'wait' };
      items.push(it);
      const probe = new Image();
      probe.onload = () => { it.w = probe.naturalWidth; it.h = probe.naturalHeight; render(); };
      probe.onerror = () => { it.unreadable = true; render(); };
      probe.src = it.src;
    }
    render();
  }
  function remove(it) {
    items = items.filter((x) => x !== it);
    URL.revokeObjectURL(it.src);
    if (it.result) URL.revokeObjectURL(it.result.url);
    const b = bitmaps.get(it.id);
    if (b) { b.close && b.close(); bitmaps.delete(it.id); }
    if (cur === it) cur = null;
    if (!readable().length && S.step !== 1) goto(1); else render();
  }
  const unreadableText = (it) => (isHeic(it.file)
    ? '這個瀏覽器看不懂 HEIC。iPhone 可到「設定 > 相機 > 格式」選「最相容」，或改用 Safari'
    : '看不懂這張圖片，可能檔案壞了或格式不支援');
  function renderStep1() {
    $('#step1').classList.toggle('has-files', items.length > 0);
    $('#sources').replaceChildren(...items.map((it) => {
      const meta = it.unreadable ? unreadableText(it) : it.w ? `${it.w}×${it.h}・${fmtBytes(it.file.size)}・${typeName(it.file)}` : '讀取中…';
      return el('li', { class: 'src' },
        it.unreadable ? el('span', { class: 'src-th none', text: '?' }) : el('img', { class: 'src-th', src: it.src, alt: '' }),
        el('span', { class: 'src-text' },
          el('span', { class: 'src-name', text: it.file.name, title: it.file.name }),
          el('span', { class: `src-meta${it.unreadable ? ' bad' : ''}`, text: meta, title: meta })),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': `移除 ${it.file.name}`, title: '移除', text: '×', onclick: () => remove(it) }));
    }));
    const ok = readable();
    $('#note1').textContent = !items.length ? '還沒有加入圖片。' : `${ok.length} 張照片${items.length > ok.length ? `・${items.length - ok.length} 張讀不了` : ''}`;
    $('#next1').disabled = !allowed(2);
  }

  // ---------- step 2: the editor ----------
  const stage = $('#stage'), cvs = $('#stageCanvas'), g = cvs.getContext('2d');
  const view = { w: 0, h: 0, dpr: 1, F: 0, fx: 0, fy: 0 };
  let bmpCur = null, dragging = false;
  async function select(it) {
    if (!it) return;
    cur = it; bmpCur = null;
    render();
    let bmp;
    try { bmp = await bitmapOf(it); } catch { it.unreadable = true; cur = null; render(); toast('這張讀不了，先略過'); select(readable()[0]); return; }
    if (cur !== it) return;
    if (!it.crop) { it.crop = await firstCrop(it, bmp); it.first = { ...it.crop }; }
    bmpCur = bmp;
    sizeStage();
    syncZoom(); paintLooks();
  }
  function sizeStage() {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    view.dpr = window.devicePixelRatio || 1;
    view.w = r.width; view.h = r.height;
    cvs.width = Math.round(r.width * view.dpr); cvs.height = Math.round(r.height * view.dpr);
    view.F = Math.min(r.width, r.height) * 0.84;
    view.fx = (r.width - view.F) / 2; view.fy = (r.height - view.F) / 2;
    paint();
  }
  new ResizeObserver(() => { if (S.step === 2) sizeStage(); }).observe(stage);
  let painting = false;
  const queuePaint = () => { if (!painting) { painting = true; requestAnimationFrame(() => { painting = false; paint(); paintLooks(); }); } };
  function paint() {
    const { w, h, dpr, F, fx, fy } = view;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!cur || !bmpCur || !cur.crop) return;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    drawCrop(g, bmpCur, cur, cur.crop, fx, fy, F);
    // everything outside the square steps back
    g.fillStyle = 'rgba(30, 18, 26, .6)';
    g.beginPath(); g.rect(0, 0, w, h); g.rect(fx, fy, F, F); g.fill('evenodd');
    if (dragging) {   // thirds, only while moving
      g.strokeStyle = 'rgba(255, 255, 255, .4)'; g.lineWidth = 1; g.beginPath();
      for (const k of [1, 2]) { g.moveTo(fx + F * k / 3, fy); g.lineTo(fx + F * k / 3, fy + F); g.moveTo(fx, fy + F * k / 3); g.lineTo(fx + F, fy + F * k / 3); }
      g.stroke();
    }
    g.strokeStyle = 'rgba(255, 255, 255, .95)'; g.lineWidth = 1.5;
    g.strokeRect(fx + 0.75, fy + 0.75, F - 1.5, F - 1.5);
    g.setLineDash([6, 5]); g.beginPath(); g.arc(fx + F / 2, fy + F / 2, F / 2 - 0.75, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  }
  function paintLooks() {
    for (const c of $$('#looks canvas')) {
      const d = c.getBoundingClientRect().width || +c.dataset.size, px = Math.round(d * (window.devicePixelRatio || 1));
      if (c.width !== px) { c.width = px; c.height = px; }
      const x = c.getContext('2d');
      x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, px, px);
      if (!cur || !bmpCur || !cur.crop) continue;
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      drawCrop(x, bmpCur, cur, cur.crop, 0, 0, px);
    }
  }
  function changed() {
    if (!cur) return;
    clamp(cur, cur.crop);
    if (!cur.touched) { cur.touched = true; renderThumbs(); }
    syncZoom();
    queuePaint();
  }
  // a point on the stage → the picture's pixels (as shown)
  const toPic = (p) => { const c = cur.crop, k = c.L / view.F; return { u: c.cx - c.L / 2 + (p.x - view.fx) * k, v: c.cy - c.L / 2 + (p.y - view.fy) * k }; };
  // new size, with the picture point under p staying under p
  function zoomTo(L, p = { x: view.fx + view.F / 2, y: view.fy + view.F / 2 }, keep = toPic(p)) {
    const c = cur.crop, lim = limits(cur, c);
    L = Math.min(lim.max, Math.max(lim.min, L));
    c.L = L;
    c.cx = keep.u + L / 2 - (p.x - view.fx) * L / view.F;
    c.cy = keep.v + L / 2 - (p.y - view.fy) * L / view.F;
    changed();
  }
  const local = (e) => { const r = cvs.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pts = new Map();
  let pinch = null;
  const pinchNow = () => {
    const [a, b] = [...pts.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  cvs.addEventListener('pointerdown', (e) => {
    if (!cur || !cur.crop) return;
    cvs.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    if (pts.size === 2) { const n = pinchNow(); pinch = { d: n.d, L: cur.crop.L, keep: toPic(n.m) }; }
    dragging = true; cvs.classList.add('dragging'); queuePaint();
  });
  cvs.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p || !cur) return;
    const q = local(e), c = cur.crop;
    if (pts.size === 1) { const k = c.L / view.F; c.cx -= (q.x - p.x) * k; c.cy -= (q.y - p.y) * k; }
    pts.set(e.pointerId, q);
    if (pts.size === 2 && pinch) { const n = pinchNow(); zoomTo(pinch.L * pinch.d / n.d, n.m, pinch.keep); } else changed();
  });
  const lift = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) { dragging = false; cvs.classList.remove('dragging'); queuePaint(); }
  };
  cvs.addEventListener('pointerup', lift);
  cvs.addEventListener('pointercancel', lift);
  cvs.addEventListener('wheel', (e) => {
    if (!cur || !cur.crop) return;
    e.preventDefault();
    zoomTo(cur.crop.L * Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), local(e));   // ctrlKey: a trackpad pinch
  }, { passive: false });
  cvs.addEventListener('keydown', (e) => {
    if (!cur || !cur.crop) return;
    const c = cur.crop, step = c.L * (e.shiftKey ? 0.1 : 0.02);
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (move) { e.preventDefault(); c.cx += move[0] * step; c.cy += move[1] * step; changed(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(c.L / 1.15); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomTo(c.L * 1.15); }
  });
  // the slider: log scale from "whole picture" (left) to "close up" (right)
  const zoom = $('#zoom');
  function syncZoom() {
    if (!cur || !cur.crop) return;
    const { min, max } = limits(cur, cur.crop);
    const t = max > min ? Math.log(max / cur.crop.L) / Math.log(max / min) : 0;
    zoom.value = Math.round(t * 1000);
    zoom.style.setProperty('--fill', `${t * 100}%`);
  }
  zoom.addEventListener('input', () => {
    if (!cur || !cur.crop) return;
    const { min, max } = limits(cur, cur.crop);
    zoomTo(max * Math.pow(min / max, zoom.value / 1000));
  });
  $('#zoomIn').addEventListener('click', () => cur && cur.crop && zoomTo(cur.crop.L / 1.25));
  $('#zoomOut').addEventListener('click', () => cur && cur.crop && zoomTo(cur.crop.L * 1.25));
  // turning the picture as shown: a flipped picture turns the other way underneath
  function turn(dir) {
    if (!cur || !cur.crop) return;
    const c = cur.crop, [SW, SH] = dims(cur, c);
    c.rot = (c.rot + 90 * (c.flip ? -dir : dir) + 360) % 360;
    [c.cx, c.cy] = dir === 1 ? [SH - c.cy, c.cx] : [c.cy, SW - c.cx];
    changed();
  }
  $('#rotL').addEventListener('click', () => turn(-1));
  $('#rotR').addEventListener('click', () => turn(1));
  $('#flip').addEventListener('click', () => {
    if (!cur || !cur.crop) return;
    cur.crop.flip = !cur.crop.flip; cur.crop.cx = dims(cur, cur.crop)[0] - cur.crop.cx;
    changed();
  });
  $('#reset').addEventListener('click', () => { if (cur && cur.first) { cur.crop = { ...cur.first }; changed(); } });

  function renderThumbs() {
    const ok = readable();
    $('#picsSet').hidden = ok.length < 2;
    $('#picCount').textContent = `${ok.length} 張`;
    $('#thumbs').replaceChildren(...ok.map((it, i) => el('li', {},
      el('button', { type: 'button', class: it === cur ? 'current' : null, title: it.file.name, 'aria-label': `第 ${i + 1} 張：${it.file.name}`, 'aria-current': it === cur ? 'true' : null, onclick: () => { if (it !== cur) select(it); } },
        el('img', { src: it.src, alt: '' }),
        it.touched ? el('span', { class: 'mark', text: '✓', 'aria-hidden': 'true' }) : null))));
  }
  function renderStep2() {
    renderThumbs();
    const ok = readable(), i = ok.indexOf(cur);
    $('#note2').textContent = ok.length > 1 && i >= 0 ? `第 ${i + 1}／${ok.length} 張・${cur.file.name}` : cur ? cur.file.name : '';
    $('#nextPic').hidden = !(ok.length > 1 && i >= 0 && i < ok.length - 1);
  }
  $('#nextPic').addEventListener('click', () => { const ok = readable(); select(ok[ok.indexOf(cur) + 1]); });

  // ---------- step 3: shape, size, format, download ----------
  function settings() {
    return { shape: $('input[name=shape]:checked').value, size: +$('input[name=size]:checked').value, fmt: $('input[name=fmt]:checked').value, bg: $('input[name=bg]:checked').value };
  }
  function syncSettingsUI() {
    const s = settings(), jpeg = $('#fmtJpeg');
    // a round avatar needs transparent corners, which JPEG can't hold
    jpeg.disabled = s.shape === 'circle';
    if (jpeg.disabled && jpeg.checked) $('input[name=fmt][value="image/png"]').checked = true;
    const t = settings();
    $('#fmtHelp').textContent = t.shape === 'circle' ? '圓形以外是透明的，所以不能用 JPEG' : t.fmt === 'image/jpeg' ? 'JPEG 不能透明，空白的地方會是白色' : '';
    $('#bgSet').hidden = !readable().some(hasEmpty);
  }
  for (const n of $$('input[name=shape], input[name=size], input[name=fmt], input[name=bg]')) n.addEventListener('change', () => { syncSettingsUI(); startRun(); });

  let running = false;
  const keyOf = (it, s) => JSON.stringify([s, it.crop]);
  function startRun() {
    syncSettingsUI();
    const s = settings();
    for (const it of readable()) if (it.key !== keyOf(it, s)) it.status = 'wait';
    if (!running) loop();
    render();
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  const encode = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), type, q));
  async function renderAvatar(it, s) {
    const bmp = await bitmapOf(it);
    if (!it.crop) it.crop = await firstCrop(it, bmp);
    const c = it.crop, out = s.size;
    // drawn big first, then halved towards the target, so shrinking a large photo stays smooth
    let m = out;
    while (m * 2 <= Math.min(c.L, 4096)) m *= 2;
    let cv = canvas(m, m);
    const x = cv.getContext('2d');
    const bg = s.bg === 'none' && s.fmt === 'image/jpeg' ? '#ffffff' : s.bg;
    if (bg !== 'none') { x.fillStyle = bg; x.fillRect(0, 0, m, m); }
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    drawCrop(x, bmp, it, c, 0, 0, m);
    while (m > out) {
      const n = m / 2, nv = canvas(n, n), nx = nv.getContext('2d');
      nx.imageSmoothingEnabled = true; nx.imageSmoothingQuality = 'high';
      nx.drawImage(cv, 0, 0, n, n);
      cv.width = 0; cv = nv; m = n;
    }
    if (s.shape === 'circle') {
      const cx = cv.getContext('2d');
      cx.globalCompositeOperation = 'destination-in';
      cx.beginPath(); cx.arc(out / 2, out / 2, out / 2, 0, Math.PI * 2); cx.fill();
    }
    const blob = await encode(cv, s.fmt, s.fmt === 'image/png' ? undefined : 0.92);
    cv.width = 0;
    return blob;
  }
  async function loop() {
    running = true;
    for (;;) {
      const it = items.find((x) => x.status === 'wait' && !x.unreadable);
      if (!it) break;
      const s = settings(), key = keyOf(it, s);
      it.status = 'busy';
      render();
      let blob = null;
      try { blob = await renderAvatar(it, s); } catch { blob = null; }
      if (!items.includes(it)) continue;
      if (it.status !== 'busy' || keyOf(it, settings()) !== key) { it.status = 'wait'; continue; }   // changed meanwhile
      if (blob) {
        if (it.result) URL.revokeObjectURL(it.result.url);
        it.result = { blob, url: URL.createObjectURL(blob), size: blob.size, s };
        it.key = keyOf(it, s); it.status = 'done';
        count(it);
      } else it.status = 'error';
      render();
    }
    running = false;
    render();
  }
  function renderStep3() {
    const ok = readable(), done = ok.filter((it) => it.status === 'done');
    const busy = ok.filter((it) => it.status === 'busy' || it.status === 'wait').length;
    const s = settings();
    fill($('#sum'),
      el('span', {}, el('b', { text: ok.length }), ' 張頭貼'),
      el('span', { text: `${s.size}×${s.size}・${s.shape === 'circle' ? '圓形' : '正方形'}・${TYPE_NAME[s.fmt]}` }),
      busy ? el('span', { text: `${busy} 張處理中…` }) : null);
    $('#results').replaceChildren(...ok.map((it) => row(it, s)));
    $('#note3').textContent = busy ? `${done.length} / ${ok.length} 張完成` : `${done.length} 張完成`;
    $('#zipAll').disabled = !done.length || busy > 0;
    $('#zipAll').textContent = done.length === 1 ? '下載頭貼' : '全部下載（ZIP）';
  }
  function row(it, s) {
    const r = it.result, busy = it.status === 'busy' || it.status === 'wait';
    const sub = el('span', { class: 'size' });
    if (it.status === 'error') { sub.className = 'bad'; sub.textContent = '這張沒辦法輸出，可能檔案太大或壞了'; }
    else if (!r || busy) sub.textContent = it.status === 'busy' ? '處理中…' : '等待中…';
    else {
      sub.append(el('b', { text: `${r.s.size}×${r.s.size}` }), `・${TYPE_NAME[r.s.fmt]}・${fmtBytes(r.size)}`);
      // the cropped area holds fewer pixels than asked for: say it was enlarged
      if (it.crop && it.crop.L < r.s.size * 0.75) sub.append(el('span', { class: 'dim', text: `・原圖範圍只有 ${Math.round(it.crop.L)} px，有放大` }));
    }
    return el('li', { class: 'row' }, el('div', { class: 'row-main' },
      r ? el('img', { class: `th${(r.s.shape === 'circle') ? ' circle' : ''}`, src: r.url, alt: '', width: 56, height: 56 }) : el('span', { class: 'th' }),
      el('span', { class: 'who' }, el('b', { text: it.file.name, title: it.file.name }), sub),
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
  const outName = (it) => `${it.file.name.replace(/\.[^.]+$/, '')}_頭貼.${EXT[it.result.s.fmt]}`;
  function save(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  const download = (it) => save(it.result.blob, outName(it));
  $('#zipAll').addEventListener('click', async () => {
    const done = readable().filter((it) => it.status === 'done');
    if (done.length === 1) { download(done[0]); return; }
    const used = new Set(), files = [];
    for (const it of done) {
      let name = outName(it), n = 2;
      while (used.has(name)) name = outName(it).replace(/(\.[^.]+)$/, ` (${n++})$1`);
      used.add(name);
      files.push({ name, data: new Uint8Array(await it.result.blob.arrayBuffer()) });
    }
    save(ManyZip.make(files), `頭貼-${files.length}張.zip`);
  });
  $('#restart').addEventListener('click', () => {
    for (const it of items) { URL.revokeObjectURL(it.src); if (it.result) URL.revokeObjectURL(it.result.url); }
    for (const b of bitmaps.values()) b.close && b.close();
    bitmaps.clear();
    items = []; cur = null; bmpCur = null; S.ran = false;
    goto(1);
  });

  // ---------- the counter ----------
  // Only a number leaves the browser: one per picture, the first time its avatar is made.
  const counted = new Set();
  function count(it) {
    if (counted.has(it.id) || !onServer) return;
    counted.add(it.id);
    fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ files: 1 }) })
      .then(loadStats).catch(() => {});
  }
  async function loadStats() {
    if (!onServer) return;
    try {
      const r = await fetch('api/stats', { cache: 'no-store' });
      const st = r.ok ? await r.json() : null;
      if (st && st.files > 0) fill($('#heroCount'), '已幫大家裁了 ', el('b', { class: 'hero-num', text: st.files.toLocaleString('zh-TW') }), ' 張頭貼');
    } catch {}
  }
  loadStats();
  render();
})();
