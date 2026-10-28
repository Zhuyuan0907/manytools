/* ZhuyuanLoveMark — PDF watermarks added in this browser. Three steps: 1 drop PDFs → 2 the watermark (text or a
   picture; size, opacity, angle; one in a chosen spot or tiled over the page; on top of the content or under it),
   previewed on the real pages → 3 which pages, optionally "can't be removed" (those pages become pictures), then
   download one, or all as a ZIP. pdf.js draws the previews and pdf-lib writes the files; both libraries and the
   decryption (pdfcrypt.js) are the PDF tool's. On a server only the number of files is reported. */
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
  const libsOk = !!(window.pdfjsLib && window.PDFLib && window.Core && Core.ready);
  if (!libsOk) $('#libError').hidden = false;
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const encode = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), type, q));

  // ---------- files ----------
  // file: { id, file, name, status ('loading' | 'ready' | 'password' | 'error'), error, password, pdf (pdf.js), numPages,
  //         sizes (page → [W, H] in points as shown), run ('wait' | 'busy' | 'done' | 'error'), result, key, thumb }
  let files = [], nextId = 1;
  const ready = () => files.filter((f) => f.status === 'ready');

  // ---------- the watermark ----------
  const M = {
    kind: 'text', text: '機密', font: 'bold', color: '#8c929c', custom: '#0b8c9e', opacity: 35, angle: 45,
    mode: 'single', size: { single: 60, tile: 22 }, pos: [1, 1], gap: 40, layer: 'top', image: null,
  };
  const FONTS = {
    sans: { weight: 500, family: '"Noto Sans TC Web", "PingFang TC", "Microsoft JhengHei", sans-serif' },
    bold: { weight: 700, family: '"Noto Sans TC Web", "PingFang TC", "Microsoft JhengHei", sans-serif' },
    serif: { weight: 700, family: '"Noto Serif TC", "Source Han Serif TC", "Songti TC", "PMingLiU", "MingLiU", serif' },
  };
  const colorOf = (m) => (m.color === 'custom' ? m.custom : m.color);
  const linesOf = (text) => {
    const lines = text.split(/\r?\n/).map((s) => s.replace(/\s+$/, ''));
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.slice(0, 4);
  };
  const markOk = (m) => (m.kind === 'text' ? linesOf(m.text).some((l) => l.trim()) : !!m.image);

  // Text is drawn on a canvas in the chosen font (the site's own Noto Sans TC for 黑體), so the preview and the
  // file look the same and Chinese needs no font inside the PDF. Laid out at 100px, then scaled to widthPx.
  const LH = 125, PAD = 14;
  const meas = canvas(1, 1).getContext('2d');
  function textBox(m) {
    const f = FONTS[m.font], lines = linesOf(m.text);
    meas.font = `${f.weight} 100px ${f.family}`;
    const wide = Math.max(1, ...lines.map((l) => meas.measureText(l).width));
    return { lines, f, bw: wide + PAD * 2, bh: lines.length * LH + PAD * 2 };
  }
  function textMark(m, widthPx) {
    const { lines, f, bw, bh } = textBox(m);
    const k = Math.min(widthPx / bw, 4096 / bh, 4096 / bw, Math.sqrt(9e6 / (bw * bh)));
    const c = canvas(Math.max(1, Math.round(bw * k)), Math.max(1, Math.round(bh * k))), x = c.getContext('2d');
    x.font = `${f.weight} ${100 * k}px ${f.family}`;
    x.fillStyle = colorOf(m); x.textAlign = 'center'; x.textBaseline = 'middle';
    lines.forEach((l, i) => x.fillText(l, c.width / 2, (PAD + LH * (i + 0.5)) * k));
    return c;
  }
  // a picture: kept as a canvas (long side at most 3000px), halved step by step when drawn much smaller
  function imageMark(m, widthPx) {
    let src = m.image.canvas;
    if (widthPx >= src.width) return src;
    while (src.width / 2 >= widthPx * 1.5) {
      const h = canvas(Math.round(src.width / 2), Math.round(src.height / 2)), x = h.getContext('2d');
      x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, h.width, h.height);
      src = h;
    }
    const out = canvas(Math.max(1, Math.round(widthPx)), Math.max(1, Math.round(widthPx * src.height / src.width))), x = out.getContext('2d');
    x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, out.width, out.height);
    return out;
  }
  const ratioOf = (m) => { if (m.kind === 'image') return m.image.canvas.width / m.image.canvas.height; const b = textBox(m); return b.bw / b.bh; };
  let markCache = { key: '', c: null };
  function markFor(m, widthPx) {
    widthPx = Math.max(8, Math.ceil(widthPx / 8) * 8);
    const key = JSON.stringify([m.kind, m.text, m.font, colorOf(m), m.image && m.image.id, widthPx]);
    if (markCache.key !== key) markCache = { key, c: m.kind === 'text' ? textMark(m, widthPx) : imageMark(m, widthPx) };
    return markCache.c;
  }
  // the web font's slices for these characters, before measuring or drawing
  async function fontFor(m) {
    if (m.kind !== 'text') return;
    const f = FONTS[m.font], spec = `${f.weight} 100px ${f.family}`;
    if (document.fonts.check(spec, m.text)) return;
    try { await document.fonts.load(spec, m.text); } catch { /* the fallback font draws it */ }
    markCache.key = '';
  }

  // ---------- where it goes ----------
  // A page as shown is W × H points, origin top left. The watermark is a list of boxes { cx, cy, w, h }, all turned
  // by t (radians, counter-clockwise as seen). Sizes follow the page's short side, so every page looks alike.
  function layout(W, H, m, ar) {
    const t = m.angle * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t), ref = Math.min(W, H), items = [];
    if (m.mode === 'tile') {
      const w = ref * m.size.tile / 100, h = w / ar, g = (0.1 + 0.9 * m.gap / 100) * Math.max(w, h);
      const dx = w + g, dy = h + g, r = Math.hypot(w, h) / 2, R = Math.hypot(W, H) / 2 + r;
      const nx = Math.ceil(R / dx) + 1, ny = Math.ceil(R / dy) + 1;
      for (let j = -ny; j <= ny; j++) {
        for (let i = -nx; i <= nx; i++) {
          const u = (i + (j & 1 ? 0.5 : 0)) * dx, v = j * dy;   // every other row shifted half a step
          const cx = W / 2 + u * cos + v * sin, cy = H / 2 - u * sin + v * cos;
          if (cx > -r && cx < W + r && cy > -r && cy < H + r) items.push({ cx, cy, w, h });
        }
      }
      return { t, items };
    }
    // one: shrunk to fit inside the margins when turned, then put in the chosen spot
    let w = ref * m.size.single / 100, h = w / ar;
    const margin = ref * 0.05, bw = w * Math.abs(cos) + h * Math.abs(sin), bh = w * Math.abs(sin) + h * Math.abs(cos);
    const k = Math.min(1, (W - 2 * margin) / bw, (H - 2 * margin) / bh);
    w *= k; h *= k;
    const ex = bw * k / 2, ey = bh * k / 2, [px, py] = m.pos;
    items.push({ cx: px === 0 ? margin + ex : px === 2 ? W - margin - ex : W / 2, cy: py === 0 ? margin + ey : py === 2 ? H - margin - ey : H / 2, w, h });
    return { t, items };
  }
  // canvas: the boxes drawn at (x0, y0) with k pixels per point
  function drawMarks(ctx, mark, L, x0, y0, k, opacity) {
    ctx.save();
    ctx.globalAlpha = opacity / 100;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    for (const it of L.items) {
      ctx.save();
      ctx.translate(x0 + it.cx * k, y0 + it.cy * k);
      ctx.rotate(-L.t);
      ctx.drawImage(mark, -it.w * k / 2, -it.h * k / 2, it.w * k, it.h * k);
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------- steps ----------
  const S = { step: 1, ran: false };
  const STEP_NAMES = ['放入 PDF', '設定浮水印', '輸出與下載'];
  function allowed(n) {
    if (n === 1) return true;
    if (n === 2) return libsOk && ready().length > 0 && !files.some((f) => f.status === 'loading');
    return allowed(2) && S.ran && markOk(M);
  }
  function goto(n) {
    if (!allowed(n)) return;
    S.step = n;
    for (let i = 1; i <= 3; i++) $(`#step${i}`).hidden = i !== n;
    if (n === 2) { if (!cur.f || !ready().includes(cur.f)) cur = { f: ready()[0], n: 1 }; showPage(); }
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

  // ---------- step 1: files ----------
  const drop = $('#drop'), input = $('#fileInput');
  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (S.step === 1 && e.dataTransfer) add(e.dataTransfer.files); });

  const isPdf = (f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
  function add(list) {
    const picked = [...list].filter(isPdf);
    if (!picked.length) { if (list.length) toast('只能放 PDF 檔'); return; }
    for (const file of picked) {
      if (files.some((f) => f.file.name === file.name && f.file.size === file.size)) continue;
      const f = { id: nextId++, file, name: file.name, status: 'loading', error: '', password: '', draft: '', wrong: false, pdf: null, numPages: 0, sizes: [], run: 'wait', result: null, key: null, thumb: null };
      files.push(f);
      load(f);
    }
    render();
  }
  // f.draft: what is typed in its password box, kept while the list is redrawn. A file is tried without a password
  // and with those that opened other files here (protected files often come in sets with one password).
  const known = () => files.map((f) => f.password).filter(Boolean);
  async function load(f, passwords = ['', ...known()]) {
    try {
      if (!libsOk) throw Object.assign(new Error('程式檔案沒有載入完整'), { friendly: true });
      const bytes = new Uint8Array(await f.file.arrayBuffer());
      if (!Core.isPdfHeader(bytes)) throw Object.assign(new Error('這不是 PDF 檔'), { friendly: true });
      const { pdf, password } = await Core.openWithPasswords(bytes, passwords);
      if (!files.includes(f)) { pdf.destroy(); return false; }
      f.pdf = pdf; f.numPages = pdf.numPages; f.status = 'ready'; f.error = ''; f.password = password; f.wrong = false;
      return true;
    } catch (e) {
      if (e && e.friendly) { f.status = 'error'; f.error = e.message; }
      else {
        const d = Core.describeOpenError(e);
        f.status = d.needPassword ? 'password' : 'error';
        f.error = d.needPassword ? (f.draft ? '密碼不對' : '需要開啟密碼') : d.message;
        f.wrong = d.needPassword && !!f.draft;
      }
      return false;
    } finally {
      if (!unlocking) render();
    }
  }
  // one 解鎖 for all: every typed password on every locked file, its own first
  let unlocking = false;
  async function unlockAll() {
    if (unlocking) return;
    const locked = files.filter((f) => f.status === 'password'), typed = locked.map((f) => f.draft).filter(Boolean);
    if (!typed.length) { toast('先在框裡輸入開啟密碼'); return; }
    unlocking = true;
    render();
    let shared = 0;
    for (const f of locked) {
      if (files.includes(f) && await load(f, [...(f.draft ? [f.draft] : []), ...typed, ...known()]) && f.password.normalize('NFKC') !== f.draft.normalize('NFKC')) shared++;
    }
    unlocking = false;
    render();
    if (shared) toast(`同一個密碼也打開了另外 ${shared} 份`);
    const next = files.find((f) => f.status === 'password' && f.wrong) || files.find((f) => f.status === 'password' && !f.draft);
    const box = next && document.getElementById(`pw${next.id}`);
    if (box) { box.focus({ preventScroll: true }); box.select(); }
  }
  function remove(f) {
    files = files.filter((x) => x !== f);
    if (f.pdf) f.pdf.destroy();
    if (f.result) URL.revokeObjectURL(f.result.url);
    for (const k of [...pageCache.keys()]) if (k.startsWith(`${f.id}:`)) pageCache.delete(k);
    if (cur.f === f) cur = { f: ready()[0], n: 1 };
    if (!ready().length && S.step !== 1) goto(1); else { if (S.step === 2) showPage(); render(); }
  }
  function renderStep1() {
    $('#step1').classList.toggle('has-files', files.length > 0);
    // the box being typed in gets its focus and caret back after the redraw
    const a = document.activeElement;
    const typing = a && a.matches('.src-pw .text-in') ? { id: a.id, from: a.selectionStart, to: a.selectionEnd } : null;
    $('#sources').replaceChildren(...files.map((f) => {
      let meta;
      if (f.status === 'loading') meta = el('span', { class: 'src-meta' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 讀取中…');
      else if (f.status === 'ready') meta = el('span', { class: 'src-meta', text: `${f.numPages} 頁・${fmtBytes(f.file.size)}` });
      else meta = el('span', { class: `src-meta ${f.status === 'password' ? 'warn' : 'bad'}`, text: unlocking && f.status === 'password' ? '試試看密碼…' : f.error });
      const li = el('li', { class: 'src' },
        el('span', { class: 'src-icon', 'aria-hidden': 'true', html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>' }),
        el('span', { class: 'src-text' }, el('span', { class: 'src-name', text: f.name, title: f.name }), meta),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': `移除 ${f.name}`, title: '移除', text: '×', onclick: () => remove(f) }));
      if (f.status === 'password') {
        const id = `pw${f.id}`, pw = el('input', { type: 'password', id, class: 'text-in', placeholder: '開啟密碼', autocomplete: 'off', 'aria-label': `${f.name} 的開啟密碼`, 'aria-invalid': f.wrong ? 'true' : null, readonly: unlocking });
        pw.value = f.draft;
        pw.addEventListener('input', () => { f.draft = pw.value; if (f.wrong) { f.wrong = false; pw.removeAttribute('aria-invalid'); } });
        const form = el('form', { class: 'src-pw' }, pw, el('button', { class: 'btn small primary', type: 'submit', disabled: unlocking, text: unlocking ? '解鎖中…' : '解鎖' }));
        form.addEventListener('submit', (ev) => { ev.preventDefault(); unlockAll(); });
        li.append(form);
      }
      return li;
    }));
    if (typing) {
      const n = document.getElementById(typing.id);
      if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(typing.from, typing.to); } catch { /* not a text box any more */ } }
    }
    const ok = ready(), locked = files.filter((f) => f.status === 'password').length, bad = files.filter((f) => f.status === 'error').length;
    const pages = ok.reduce((a, f) => a + f.numPages, 0);
    $('#note1').textContent = !files.length ? '還沒有加入檔案。'
      : `${ok.length} 份・共 ${pages} 頁${locked ? `・${locked} 份要密碼` : ''}${bad ? `・${bad} 份讀不了` : ''}`;
    $('#next1').disabled = !allowed(2);
  }

  // ---------- step 2: the preview ----------
  const editor = $('#editor'), stage = $('#stage'), cvs = $('#stageCanvas'), g = cvs.getContext('2d');
  let cur = { f: null, n: 1 };
  const view = { w: 0, h: 0, dpr: 1 };
  const phone = window.matchMedia('(max-width: 640px)');
  async function sizeOf(f, n) {
    if (!f.sizes[n]) {
      const p = await f.pdf.getPage(n), vp = p.getViewport({ scale: 1 });
      f.sizes[n] = [vp.width, vp.height];
    }
    return f.sizes[n];
  }
  // rendered pages (content only, transparent where the page paints nothing), the last few
  const pageCache = new Map();
  let renderTask = null;
  async function pageImage(f, n, pxW, pxH, forStage) {
    const key = `${f.id}:${n}:${pxW}x${pxH}`;
    if (pageCache.has(key)) { const c = pageCache.get(key); pageCache.delete(key); pageCache.set(key, c); return c; }
    const p = await f.pdf.getPage(n), [W] = await sizeOf(f, n);
    const c = canvas(pxW, pxH);
    // a newer page on the stage wins over one still being drawn
    if (forStage && renderTask) { try { renderTask.cancel(); } catch { /* done already */ } }
    const task = p.render({ canvasContext: c.getContext('2d'), viewport: p.getViewport({ scale: pxW / W }), background: 'rgba(0,0,0,0)' });
    if (forStage) renderTask = task;
    try { await task.promise; } finally { if (renderTask === task) renderTask = null; }
    pageCache.set(key, c);
    for (const k of pageCache.keys()) { if (pageCache.size <= 8) break; pageCache.delete(k); }
    return c;
  }
  // the stage is as tall as the card and as wide as the page needs (at most half the editor)
  let shown = null;   // { f, n, W, H, img }
  function sizeStage() {
    if (!shown) return;
    const ar = shown.W / shown.H, ed = editor.getBoundingClientRect(), pager = $('#pager').hidden ? 0 : 48;
    stage.classList.toggle('no-pager', !pager);
    if (phone.matches) {
      const w = ed.width, h = Math.min(Math.max(240, (w - 20) / ar + 20 + pager), window.innerHeight * 0.68);
      editor.style.setProperty('--stage-h', `${Math.round(h)}px`);
    } else if (ed.height) {
      const w = Math.min(ed.width * 0.52, Math.max(230, (ed.height - pager - 20) * ar + 20));
      editor.style.setProperty('--stage-w', `${Math.round(w)}px`);
    }
    const r = cvs.getBoundingClientRect();
    if (!r.width || !r.height) return;
    view.dpr = window.devicePixelRatio || 1; view.w = r.width; view.h = r.height;
    cvs.width = Math.round(r.width * view.dpr); cvs.height = Math.round(r.height * view.dpr);
    paint();
  }
  // a resized window first stretches the drawn page, then draws it again at the new size
  let resizeTimer;
  new ResizeObserver(() => {
    if (S.step !== 2) return;
    sizeStage();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (shown && shown.img && Math.abs(shown.img.width - pageRect().w * view.dpr) > 2) showPage(); }, 250);
  }).observe(editor);
  // page rectangle on the stage, in CSS pixels
  const pageRect = () => {
    const k = Math.min((view.w - 20) / shown.W, (view.h - 20) / shown.H);
    return { k, x: (view.w - shown.W * k) / 2, y: (view.h - shown.H * k) / 2, w: shown.W * k, h: shown.H * k };
  };
  async function showPage() {
    const { f, n } = cur;
    if (!f || !f.pdf) return;
    const [W, H] = await sizeOf(f, n);
    if (cur.f !== f || cur.n !== n) return;
    shown = { f, n, W, H, img: shown && shown.f === f && shown.n === n ? shown.img : null };
    renderStep2();
    sizeStage();
    const r = pageRect(), pxW = Math.round(r.w * view.dpr), pxH = Math.round(r.h * view.dpr);
    try {
      const img = await pageImage(f, n, pxW, pxH, true);
      if (shown && shown.f === f && shown.n === n) { shown.img = img; paint(); }
    } catch { /* cancelled by a newer page */ }
  }
  let painting = false;
  const queuePaint = () => { if (!painting) { painting = true; requestAnimationFrame(() => { painting = false; paint(); }); } };
  // what a PDF viewer shows: white paper, the watermark under the content or over it
  function composite(ctx, img, W, H, x, y, k, pxScale, m = M) {
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, W * k, H * k);
    const ok = markOk(m), L = ok ? layout(W, H, m, ratioOf(m)) : null;
    const mark = ok ? markFor(m, L.items[0].w * k * pxScale) : null;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, W * k, H * k); ctx.clip();
    if (ok && m.layer === 'under') drawMarks(ctx, mark, L, x, y, k, m.opacity);
    if (img) ctx.drawImage(img, x, y, W * k, H * k);
    if (ok && m.layer === 'top') drawMarks(ctx, mark, L, x, y, k, m.opacity);
    ctx.restore();
  }
  function paint() {
    const { w, h, dpr } = view;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!shown) return;
    const r = pageRect();
    g.save();
    g.shadowColor = 'rgba(23, 32, 44, .18)'; g.shadowBlur = 14; g.shadowOffsetY = 3;
    g.fillStyle = '#fff'; g.fillRect(r.x, r.y, r.w, r.h);
    g.restore();
    composite(g, shown.img, shown.W, shown.H, r.x, r.y, r.k, dpr);
    if (!shown.img) { g.fillStyle = 'rgba(119, 129, 147, .7)'; g.font = '14px sans-serif'; g.textAlign = 'center'; g.fillText('頁面載入中…', r.x + r.w / 2, r.y + 24); }
  }

  // page turning, across all the files
  function step(d) {
    const ok = ready();
    let fi = ok.indexOf(cur.f), n = cur.n + d;
    if (fi < 0) return;
    if (n < 1) { if (fi === 0) return; fi--; n = ok[fi].numPages; }
    else if (n > ok[fi].numPages) { if (fi === ok.length - 1) return; fi++; n = 1; }
    cur = { f: ok[fi], n };
    showPage();
  }
  $('#prevPage').addEventListener('click', () => step(-1));
  $('#nextPage').addEventListener('click', () => step(1));
  cvs.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); step(1); }
  });
  function renderStep2() {
    const ok = ready(), fi = ok.indexOf(cur.f);
    if (cur.f) {
      $('#pageText').textContent = `第 ${cur.n}／${cur.f.numPages} 頁`;
      $('#prevPage').disabled = fi <= 0 && cur.n <= 1;
      $('#nextPage').disabled = fi === ok.length - 1 && cur.n >= cur.f.numPages;
      $('#pager').hidden = ok.length === 1 && cur.f.numPages === 1;
    }
    const note = !markOk(M) ? (M.kind === 'text' ? '請輸入浮水印的文字' : '請選一張圖片') : ok.length > 1 && fi >= 0 ? `第 ${fi + 1}／${ok.length} 份・${cur.f.name}` : cur.f ? cur.f.name : '';
    $('#note2').textContent = note;
    $('#note2').classList.toggle('warn', !markOk(M));
    $('#next2').disabled = !markOk(M);
  }

  // ---------- step 2: the settings ----------
  const setVal = (id, text) => { $(`#${id}Val`).textContent = text; };
  const fillRange = (r) => r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  function syncSettingsUI() {
    const text = M.kind === 'text';
    $('#textBox').hidden = !text; $('#imageBox').hidden = text;
    $('#fontLine').hidden = !text; $('#colorLine').hidden = !text;
    $('#size').value = M.size[M.mode]; setVal('size', `${M.size[M.mode]}%`);
    $('#size').max = M.mode === 'tile' ? 60 : 100;
    $('#opacity').value = M.opacity; setVal('opacity', `${M.opacity}%`);
    $('#angle').value = M.angle; setVal('angle', `${M.angle}°`);
    $('#gap').value = M.gap;
    for (const r of $$('input[type=range]')) fillRange(r);
    $('#grid9').hidden = M.mode === 'tile'; $('#gapBox').hidden = M.mode !== 'tile';
    $('#layerHelp').textContent = M.layer === 'under' ? '掃描的頁面會把它蓋住' : '';
    $('#layerHelp').hidden = M.layer !== 'under';
    $('#customSw').style.setProperty('--sw', M.custom);
    $('#customSw').classList.toggle('chosen', M.color === 'custom');
    for (const b of $$('#presets button')) b.classList.toggle('on', b.dataset.text === M.text);
    for (const b of $$('#angles button')) b.classList.toggle('on', +b.dataset.angle === M.angle);
  }
  function changed() { syncSettingsUI(); queuePaint(); if (S.step === 2) renderStep2(); renderStepper(); }
  for (const r of $$('input[name=kind], input[name=font], input[name=color], input[name=mode], input[name=pos], input[name=layer]')) {
    r.addEventListener('change', async () => {
      const v = r.value;
      if (r.name === 'kind') { M.kind = v; if (v === 'image' && !M.image) $('#imgInput').click(); }
      if (r.name === 'font') M.font = v;
      if (r.name === 'color') M.color = v;
      if (r.name === 'mode') M.mode = v;
      if (r.name === 'pos') M.pos = v.split(',').map(Number);
      if (r.name === 'layer') M.layer = v;
      changed();
      if (r.name === 'font') { await fontFor(M); queuePaint(); }
    });
  }
  const wmText = $('#wmText');
  wmText.addEventListener('input', async () => { M.text = wmText.value; changed(); await fontFor(M); queuePaint(); });
  $('#presets').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-text]');
    if (!b) return;
    M.text = wmText.value = b.dataset.text;
    changed();
    if (b.dataset.pick) {   // the part to fill in comes selected
      const i = M.text.indexOf(b.dataset.pick);
      wmText.focus(); wmText.setSelectionRange(i, i + b.dataset.pick.length);
    }
    await fontFor(M); queuePaint();
  });
  $('#size').addEventListener('input', (e) => { M.size[M.mode] = +e.target.value; changed(); });
  $('#opacity').addEventListener('input', (e) => { M.opacity = +e.target.value; changed(); });
  $('#angle').addEventListener('input', (e) => {
    let a = +e.target.value;
    for (const s of [-90, -45, 0, 45, 90]) if (Math.abs(a - s) <= 2) a = s;   // the usual angles hold the thumb a little
    M.angle = a; changed();
  });
  $('#angles').addEventListener('click', (e) => { const b = e.target.closest('button[data-angle]'); if (b) { M.angle = +b.dataset.angle; changed(); } });
  $('#gap').addEventListener('input', (e) => { M.gap = +e.target.value; changed(); });
  // the rainbow swatch opens the colour picker
  const customColor = $('#customColor');
  $('#customSw').addEventListener('click', (e) => {
    if (e.target === customColor) return;
    e.preventDefault();
    const radio = $('input[name=color][value=custom]');
    if (!radio.checked) { radio.checked = true; M.color = 'custom'; changed(); }
    try { customColor.showPicker(); } catch { customColor.click(); }
  });
  customColor.addEventListener('input', () => { M.custom = customColor.value; M.color = 'custom'; $('input[name=color][value=custom]').checked = true; changed(); });

  // a picture as the watermark: drawn once onto a canvas (SVG too), long side at most 3000px
  let imageSeq = 0;
  $('#imgInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) { if (!M.image) { M.kind = 'text'; $('input[name=kind][value=text]').checked = true; changed(); } return; }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      let w = img.naturalWidth || 1000, h = img.naturalHeight || 1000;
      const svg = /svg/i.test(file.type) || /\.svg$/i.test(file.name);
      const k = svg ? 2000 / Math.max(w, h) : Math.min(1, 3000 / Math.max(w, h));
      w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
      const c = canvas(w, h), x = c.getContext('2d');
      x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, w, h);
      // transparent anywhere? then it's kept as PNG in the file, otherwise as JPEG
      const px = x.getImageData(0, 0, w, h).data;
      let alpha = false;
      for (let i = 3; i < px.length; i += 4) if (px[i] < 255) { alpha = true; break; }
      if (M.image) URL.revokeObjectURL(M.image.url);
      M.image = { id: ++imageSeq, name: file.name, canvas: c, alpha, url };
      M.kind = 'image'; $('input[name=kind][value=image]').checked = true;
      fill($('#imgThumb'), el('img', { src: url, alt: '' }));
      $('#imgName').textContent = file.name;
      $('#imgMeta').textContent = `${img.naturalWidth}×${img.naturalHeight}${alpha ? '・去背' : ''}・點一下可以換`;
      changed();
    } catch {
      URL.revokeObjectURL(url);
      toast('看不懂這張圖片，換一張試試');
    }
  });

  // ---------- step 3: pages, "can't be removed", the files ----------
  function outSettings() {
    return { pages: $('input[name=pages]:checked').value, list: $('#pageList').value.trim(), flatten: $('#flatten').checked };
  }
  // "1-3, 5, 8-" → page numbers (1-based) in 1..n; null when it can't be read
  function parsePages(text, n) {
    const out = new Set();
    const parts = text.split(/[,，、;；\s]+/).filter(Boolean);
    if (!parts.length) return null;
    for (const p of parts) {
      const m = p.match(/^(\d*)\s*[-–—~～至到]\s*(\d*)$/) || p.match(/^(\d+)$/);
      if (!m) return null;
      let a, b;
      if (m.length === 2) a = b = +m[1];
      else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
      if (!a || !b) return null;
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= Math.min(b, n); i++) out.add(i);
    }
    return out;
  }
  function pagesWanted(o, n) {
    if (o.pages === 'first') return [0];
    if (o.pages === 'custom') { const s = parsePages(o.list, n); return s ? [...s].sort((a, b) => a - b).map((x) => x - 1) : []; }
    return [...Array(n).keys()];
  }
  function syncOutUI() {
    const o = outSettings();
    $('#customPages').hidden = o.pages !== 'custom';
    $('#flattenHelp').hidden = !o.flatten;
    const help = $('#pageHelp');
    const bad = o.pages === 'custom' && o.list && !parsePages(o.list, 1e6);
    help.textContent = bad ? '看不懂這個頁碼，例如「1-3, 5」' : '用逗號分開，連續的頁用「-」';
    help.classList.toggle('bad', !!bad);
  }
  for (const n of $$('input[name=pages], #flatten')) n.addEventListener('change', () => { if (n.value === 'custom' && n.checked) $('#pageList').focus(); startRun(); });
  let listTimer;
  $('#pageList').addEventListener('input', () => { syncOutUI(); clearTimeout(listTimer); listTimer = setTimeout(startRun, 450); });

  let running = false;
  const snapshot = () => ({ ...M, size: { ...M.size }, pos: [...M.pos], image: M.image });
  const keyOf = (f, m, o) => JSON.stringify([{ ...m, image: m.image && m.image.id }, o, f.password]);
  function startRun() {
    syncOutUI();
    const m = snapshot(), o = outSettings();
    for (const f of ready()) if (f.key !== keyOf(f, m, o)) f.run = 'wait';
    if (!running) loop();
    render();
  }

  // ---- writing the files ----
  const { PDFName, PDFArray, PDFDict, PDFRef, PDFNumber } = window.PDFLib || {};
  const N = (s) => PDFName.of(s);
  const num = (x) => { const s = (Math.abs(x) < 1e-9 ? 0 : x).toFixed(4); return s.replace(/\.?0+$/, '') || '0'; };
  // the page's box, as numbers, smallest corner first
  function rectOf(arr) {
    if (!(arr instanceof PDFArray) || arr.size() < 4) return null;
    const v = arr.asArray().slice(0, 4).map((x) => (x instanceof PDFNumber ? x.asNumber() : 0));
    return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  }
  // what a viewer shows: the crop box inside the media box, turned by /Rotate
  function pageGeo(page) {
    const media = rectOf(page.node.MediaBox()) || [0, 0, 612, 792];
    const crop = rectOf(page.node.CropBox()) || media;
    let box = [Math.max(media[0], crop[0]), Math.max(media[1], crop[1]), Math.min(media[2], crop[2]), Math.min(media[3], crop[3])];
    if (box[2] - box[0] <= 0 || box[3] - box[1] <= 0) box = media;
    const rot = ((Math.round((page.getRotation().angle || 0) / 90) * 90) % 360 + 360) % 360;
    const bw = box[2] - box[0], bh = box[3] - box[1];
    return { box, rot, W: rot % 180 ? bh : bw, H: rot % 180 ? bw : bh };
  }
  // the page as shown (origin top left, y down) → PDF user space: x = a·X + c·Y + e, y = b·X + d·Y + f
  function viewToUser([x0, y0, x1, y1], rot) {
    if (rot === 90) return [0, 1, 1, 0, x0, y0];
    if (rot === 180) return [-1, 0, 0, 1, x1, y0];
    if (rot === 270) return [0, -1, -1, 0, x1, y1];
    return [1, 0, 0, -1, x0, y1];
  }
  const then = ([a, b, c, d, e, f], [A, B, C, D, E, F]) => [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
  // an image's unit square → its box on the page as shown, turned by t
  function boxMatrix({ cx, cy, w, h }, t) {
    const cos = Math.cos(t), sin = Math.sin(t);
    return [w * cos, -w * sin, -h * sin, -h * cos, cx - 0.5 * w * cos + 0.5 * h * sin, cy + 0.5 * w * sin + 0.5 * h * cos];
  }
  // Text: one colour with the letters' coverage as its soft mask, so the colour plane packs to almost nothing.
  // A picture: PNG when it has transparency, JPEG otherwise.
  async function embedMark(doc, m, widthPx) {
    const ctx = doc.context;
    if (m.kind === 'image') {
      const c = m.image.canvas;
      if (m.image.alpha) return (await doc.embedPng(new Uint8Array(await (await encode(c, 'image/png')).arrayBuffer()))).ref;
      const opaque = canvas(c.width, c.height), x = opaque.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(c, 0, 0);
      return (await doc.embedJpg(new Uint8Array(await (await encode(opaque, 'image/jpeg', 0.92)).arrayBuffer()))).ref;
    }
    await fontFor(m);
    const c = textMark(m, widthPx), w = c.width, h = c.height;
    const px = c.getContext('2d').getImageData(0, 0, w, h).data, a = new Uint8Array(w * h);
    for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = px[j];
    const hex = colorOf(m), rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const plane = new Uint8Array(w * h * 3);
    for (let i = 0; i < plane.length; i += 3) { plane[i] = rgb[0]; plane[i + 1] = rgb[1]; plane[i + 2] = rgb[2]; }
    const smask = ctx.register(ctx.flateStream(a, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
    return ctx.register(ctx.flateStream(plane, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: smask }));
  }
  // objects nothing points at any more (the old content of pages turned into pictures) leave the file
  function dropUnreachable(doc) {
    const ctx = doc.context, seen = new Set(), todo = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean);
    while (todo.length) {
      const o = todo.pop();
      if (o instanceof PDFRef) { if (!seen.has(o.tag)) { seen.add(o.tag); const v = ctx.lookup(o); if (v) todo.push(v); } }
      else if (o instanceof PDFDict) { for (const [, v] of o.entries()) todo.push(v); }
      else if (o instanceof PDFArray) { for (const v of o.asArray()) todo.push(v); }
      else if (o && o.dict instanceof PDFDict) todo.push(o.dict);
    }
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
  }
  async function buildOutput(f, m, o) {
    const want = pagesWanted(o, f.numPages);
    if (!want.length) return { none: true };
    await fontFor(m);
    const ar = ratioOf(m);
    // pages turned into pictures are drawn first, so pdf.js's drawing and pdf-lib's copy of a big file never
    // need memory at the same time
    const flat = o.flatten ? await flatPages(f, m, want, ar) : null;
    const doc = await PdfCrypt.load(new Uint8Array(await f.file.arrayBuffer()), f.password);
    const pages = doc.getPages();
    if (pages.length !== f.numPages) throw new Error('page count');
    if (flat) await flatten(doc, want, flat);
    else {
      const geos = want.map((i) => pageGeo(pages[i]));
      // sharp enough for the largest page it lands on: 300 dpi
      const widest = Math.max(...geos.map((p) => layout(p.W, p.H, m, ar).items[0].w));
      const img = await embedMark(doc, m, Math.min(4096, Math.max(64, widest * 300 / 72)));
      const ctx = doc.context, op = m.opacity / 100;
      const gs = ctx.register(ctx.obj({ Type: 'ExtGState', ca: op, CA: op }));
      want.forEach((i, j) => {
        const page = pages[i], p = geos[j], L = layout(p.W, p.H, m, ar), toUser = viewToUser(p.box, p.rot);
        const xo = page.node.newXObject('Wm', img), gn = page.node.newExtGState('Gs', gs);
        let ops = `q ${gn} gs\n`;
        for (const it of L.items) ops += `q ${then(boxMatrix(it, L.t), toUser).map(num).join(' ')} cm ${xo} Do Q\n`;
        ops += 'Q\n';
        const ref = ctx.register(ctx.flateStream(ops));
        // pdf-lib has already wrapped the page's own content in q … Q (newXObject normalises the page)
        const contents = page.node.Contents();
        if (contents instanceof PDFArray) { if (m.layer === 'under') contents.insert(0, ref); else contents.push(ref); }
        else page.node.set(N('Contents'), ctx.obj([ref]));
      });
    }
    const bytes = await doc.save({ updateFieldAppearances: false });
    return { blob: new Blob([bytes], { type: 'application/pdf' }), pages: want.length, total: pages.length, unlocked: !!doc.wasEncrypted };
  }
  // "can't be removed": each chosen page drawn with its watermark (200 dpi, at most 12 megapixels) as a JPEG
  async function flatPages(f, m, want, ar) {
    const out = [];
    for (const i of want) {
      const p = await f.pdf.getPage(i + 1), vp1 = p.getViewport({ scale: 1 }), W = vp1.width, H = vp1.height;
      const s = Math.min(200 / 72, 4000 / Math.max(W, H), Math.sqrt(12e6 / (W * H)));
      const pxW = Math.max(1, Math.round(W * s)), pxH = Math.max(1, Math.round(H * s)), k = pxW / W;
      const c = canvas(pxW, pxH), x = c.getContext('2d');
      const L = layout(W, H, m, ar), mark = m.kind === 'text' ? textMark(m, L.items[0].w * k) : imageMark(m, L.items[0].w * k);
      // white paper, then the watermark and the page in the order a viewer draws them
      x.fillStyle = '#fff'; x.fillRect(0, 0, pxW, pxH);
      if (m.layer === 'under') drawMarks(x, mark, L, 0, 0, k, m.opacity);
      await p.render({ canvasContext: x, viewport: p.getViewport({ scale: k }), background: 'rgba(0,0,0,0)' }).promise;
      p.cleanup();
      if (m.layer === 'top') drawMarks(x, mark, L, 0, 0, k, m.opacity);
      out.push({ W, H, jpg: new Uint8Array(await (await encode(c, 'image/jpeg', 0.88)).arrayBuffer()) });
      c.width = 0;
    }
    return out;
  }
  // …which then replace those pages: nothing of the old page is left in the file
  async function flatten(doc, want, flat) {
    const pages = doc.getPages(), ctx = doc.context;
    for (const [j, i] of want.entries()) {
      const { W, H } = flat[j], jpg = await doc.embedJpg(flat[j].jpg);
      flat[j] = null;
      const node = pages[i].node;
      const draw = ctx.register(ctx.flateStream(`q ${num(W)} 0 0 ${num(H)} 0 0 cm /Pg Do Q\n`));
      node.set(N('Contents'), draw);
      node.set(N('Resources'), ctx.obj({ XObject: { Pg: jpg.ref } }));
      node.set(N('MediaBox'), ctx.obj([0, 0, W, H]));
      node.set(N('CropBox'), ctx.obj([0, 0, W, H]));
      node.set(N('Rotate'), ctx.obj(0));
      for (const k2 of ['BleedBox', 'TrimBox', 'ArtBox', 'Annots', 'Group', 'Thumb', 'StructParents']) node.delete(N(k2));
    }
    dropUnreachable(doc);
  }

  async function loop() {
    running = true;
    for (;;) {
      const f = ready().find((x) => x.run === 'wait');
      if (!f) break;
      const m = snapshot(), o = outSettings(), key = keyOf(f, m, o);
      f.run = 'busy';
      render();
      let r = null, err = null;
      try { r = await buildOutput(f, m, o); } catch (e) { err = e; }
      if (!files.includes(f)) continue;
      if (f.run !== 'busy' || keyOf(f, snapshot(), outSettings()) !== key) { f.run = 'wait'; continue; }   // changed meanwhile
      if (f.result) URL.revokeObjectURL(f.result.url);
      if (r && r.blob) {
        f.result = { ...r, url: URL.createObjectURL(r.blob), size: r.blob.size, flat: o.flatten };
        f.run = 'done'; count(f);
      } else {
        f.result = r && r.none ? { none: true } : { error: err && err.code === 'password' ? '密碼不對，回到第 1 步重新解鎖' : '這份沒辦法加浮水印，檔案可能有特殊保護或損壞' };
        f.run = 'error';
      }
      f.key = key;
      thumbOf(f, m, o);
      render();
    }
    running = false;
    render();
  }
  // a small picture of the first watermarked page, made from the preview's own drawing
  async function thumbOf(f, m, o) {
    const want = pagesWanted(o, f.numPages);
    const n = (want.length ? want[0] : 0) + 1, tk = JSON.stringify([n, f.key]);
    if (f.thumbKey === tk) return;
    f.thumbKey = tk;
    try {
      const [W, H] = await sizeOf(f, n), dpr = window.devicePixelRatio || 1, k = Math.min(44 / W, 56 / H) * dpr;
      const pxW = Math.max(1, Math.round(W * k)), pxH = Math.max(1, Math.round(H * k));
      const img = await pageImage(f, n, pxW, pxH), c = canvas(pxW, pxH);
      composite(c.getContext('2d'), img, W, H, 0, 0, k, 1, m);
      if (f.thumbKey === tk) { f.thumb = c.toDataURL('image/png'); render(); }
    } catch { /* no picture then */ }
  }
  function renderStep3() {
    const ok = ready(), done = ok.filter((f) => f.run === 'done');
    const busy = ok.filter((f) => f.run === 'busy' || f.run === 'wait').length;
    const o = outSettings();
    fill($('#sum'),
      el('span', {}, el('b', { text: ok.length }), ' 份 PDF'),
      el('span', { text: `${M.kind === 'text' ? `「${linesOf(M.text).join(' ')}」` : '圖片'}・${M.mode === 'tile' ? '平鋪滿版' : '單個'}${o.flatten ? '・防移除' : ''}` }),
      busy ? el('span', { text: `${busy} 份處理中…` }) : null);
    $('#results').replaceChildren(...ok.map((f) => row(f)));
    $('#note3').textContent = busy ? `${done.length} / ${ok.length} 份完成` : `${done.length} 份完成`;
    $('#zipAll').disabled = !done.length || busy > 0;
    $('#zipAll').textContent = done.length === 1 ? '下載 PDF' : '全部下載（ZIP）';
  }
  function row(f) {
    const r = f.result, busy = f.run === 'busy' || f.run === 'wait';
    const sub = el('span', { class: 'size' });
    if (busy || !r) sub.textContent = f.run === 'busy' ? '處理中…' : '等待中…';
    else if (r.none) { sub.className = 'bad'; sub.textContent = `這份只有 ${f.numPages} 頁，沒有符合的頁碼`; }
    else if (r.error) { sub.className = 'bad'; sub.textContent = r.error; }
    else {
      sub.append(el('b', { text: r.pages === r.total ? `${r.total} 頁都加上了` : `加在 ${r.pages}／${r.total} 頁` }),
        el('span', { class: 'nw', text: `・${fmtBytes(f.file.size)} → ${fmtBytes(r.size)}` }));
      if (r.flat) sub.append(el('span', { class: 'dim', text: '・已合成圖片' }));
      if (f.password) sub.append(el('span', { class: 'dim', text: '・沒有開啟密碼了' }));
      else if (r.unlocked) sub.append(el('span', { class: 'dim', text: '・已移除編輯限制' }));
    }
    return el('li', { class: 'row' }, el('div', { class: 'row-main' },
      f.thumb ? el('img', { class: 'th page', src: f.thumb, alt: '' }) : el('span', { class: 'th page' }),
      el('span', { class: 'who' }, el('b', { text: f.name, title: f.name }), sub),
      el('span', { class: 'row-acts' },
        busy ? el('span', { class: 'spinner', 'aria-label': '處理中' }) : null,
        f.run === 'done' ? el('button', { type: 'button', class: 'btn', text: '下載', onclick: () => download(f) }) : null)));
  }

  // ---------- download, and on to the PDF tool ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  const outName = (f) => `${f.name.replace(/\.pdf$/i, '')}_浮水印.pdf`;
  function save(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  const download = (f) => save(f.result.blob, outName(f));
  function doneNamed() {
    const used = new Set();
    return ready().filter((f) => f.run === 'done').map((f) => {
      let name = outName(f), n = 2;
      while (used.has(name)) name = outName(f).replace(/(\.pdf)$/, ` (${n++})$1`);
      used.add(name);
      return { f, name };
    });
  }
  $('#zipAll').addEventListener('click', async () => {
    const done = doneNamed();
    if (done.length === 1) { download(done[0].f); return; }
    const list = [];
    for (const { f, name } of done) list.push({ name, data: new Uint8Array(await f.result.blob.arrayBuffer()) });
    save(ManyZip.make(list), `浮水印-${list.length}份.zip`);
  });
  // the finished files travel to the PDF tool inside this browser (shared/handoff.js)
  $('#toPdfLink').addEventListener('click', async (e) => {
    const done = doneNamed();
    if (!done.length || !window.ManyHandoff || !window.indexedDB) return;
    e.preventDefault();
    try { await ManyHandoff.send('pdf', done.map(({ f, name }) => ({ name, file: new File([f.result.blob], name, { type: 'application/pdf' }) }))); } catch { /* the link still opens it */ }
    location.href = onServer ? '/pdf' : '../pdftools/local/index.html';
  });
  $('#restart').addEventListener('click', () => {
    for (const f of files) { if (f.pdf) f.pdf.destroy(); if (f.result && f.result.url) URL.revokeObjectURL(f.result.url); }
    pageCache.clear();
    files = []; cur = { f: null, n: 1 }; shown = null; S.ran = false;
    goto(1);
  });

  // ---------- the counter ----------
  // Only a number leaves the browser: one per file, the first time it gets a watermark.
  const counted = new Set();
  function count(f) {
    if (counted.has(f.id) || !onServer) return;
    counted.add(f.id);
    fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ files: 1 }) })
      .then(loadStats).catch(() => {});
  }
  async function loadStats() {
    if (!onServer) return;
    try {
      const r = await fetch('api/stats', { cache: 'no-store' });
      const st = r.ok ? await r.json() : null;
      if (st && st.files > 0) fill($('#heroCount'), '已幫大家加了 ', el('b', { class: 'hero-num', text: st.files.toLocaleString('zh-TW') }), ' 份浮水印');
    } catch {}
  }
  loadStats();
  syncSettingsUI();
  fontFor(M);
  render();
})();
