/* ZhuyuanLoveImage — squeeze pictures under a size limit, all in this browser (compress.js does the work, in
   worker.js when a worker can start). Pictures re-run by themselves when a setting changes. On a server only
   the counts (pictures, bytes saved) are reported, never a picture or its name. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
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
  const pct = (a, b) => Math.max(0, Math.round((1 - a / b) * 100));
  const TYPE_NAME = { 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/png': 'PNG' };
  const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

  // ---------- settings ----------
  function settings() {
    const lv = $('input[name=limit]:checked').value;
    const mb = lv === 'custom' ? Math.max(0.05, parseFloat($('#customMB').value) || 3) : +lv;
    return { limit: Math.round(mb * 1e6), fmt: $('input[name=fmt]:checked').value, maxSide: +$('#maxSide').value, square: $('#square').checked };
  }
  // "same as the file" keeps JPEG/PNG/WebP; anything else (GIF, BMP, AVIF, HEIC) becomes JPEG
  const outType = (file, s) => (s.fmt !== 'same' ? s.fmt : TYPE_NAME[file.type] ? file.type : 'image/jpeg');
  function summarize() {
    const s = settings();
    $('#optsSum').textContent = [s.limit ? `${fmtBytes(s.limit)} 以內` : '不限大小', s.fmt === 'same' ? '同原檔' : TYPE_NAME[s.fmt],
      s.maxSide ? `最長 ${s.maxSide}px` : '原尺寸', s.square ? '正方形' : null].filter(Boolean).join('・');
  }
  const optsBox = $('#opts');
  if (matchMedia('(max-width: 640px)').matches) optsBox.open = false;
  let settingsTimer;
  function settingsChanged() {
    $('#customBox').hidden = $('input[name=limit]:checked').value !== 'custom';
    summarize();
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => { for (const it of items) if (it.status !== 'error' || it.code === 'limit') it.status = 'wait'; restart(); }, 350);
  }
  for (const n of $$('input[name=limit], input[name=fmt], #maxSide, #square')) n.addEventListener('change', settingsChanged);
  $('#customMB').addEventListener('input', settingsChanged);
  summarize();

  // ---------- the engine: a worker when possible, the page otherwise ----------
  let worker = null;
  const pending = new Map();
  let seq = 0;
  try {
    const ver = ((document.querySelector('script[src*="compress.js"]') || {}).src || '').split('?')[1];
    worker = new Worker(`assets/worker.js${ver ? `?${ver}` : ''}`);
    worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
    worker.onerror = () => { worker = null; for (const [, p] of pending) p({ ok: false, code: 'retry' }); pending.clear(); };
  } catch { worker = null; }
  async function squeeze(file, opts) {
    if (worker) {
      const res = await new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); worker.postMessage({ id, file, opts }); });
      if (res.code !== 'retry') return res;
    }
    try { return { ok: true, ...(await window.compressImage(file, opts)) }; }
    catch (err) { return { ok: false, code: err.code || 'error' }; }
  }

  // ---------- pictures ----------
  let items = [], nextId = 1;
  const drop = $('#drop'), input = $('#fileInput');
  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer) add(e.dataTransfer.files); });

  const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i.test(f.name);
  function add(list) {
    const files = [...list].filter(isImage);
    if (!files.length) { if (list.length) toast('這不是圖片檔'); return; }
    for (const file of files) {
      if (items.some((it) => it.file.name === file.name && it.file.size === file.size)) continue;
      const it = { id: nextId++, file, src: URL.createObjectURL(file), status: 'wait', open: false, w: 0, h: 0 };
      items.push(it);
      const probe = new Image();
      probe.onload = () => { it.w = probe.naturalWidth; it.h = probe.naturalHeight; render(); };
      probe.src = it.src;
    }
    if (items.length === 1) items[0].open = true;
    else for (const it of items) if (it.autoOpen) it.open = false;
    if (items.length === 1) items[0].autoOpen = true;
    restart();
  }
  function remove(it) {
    items = items.filter((x) => x !== it);
    URL.revokeObjectURL(it.src);
    if (it.result && it.result.url) URL.revokeObjectURL(it.result.url);
    render();
  }
  $('#clearAll').addEventListener('click', () => { for (const it of [...items]) remove(it); restart(); });

  // one picture at a time; a settings change starts a new pass and the old one stops at its next step
  let pass = 0, running = false;
  function restart() { pass++; render(); if (!running) loop(); }
  async function loop() {
    running = true;
    for (;;) {
      const it = items.find((x) => x.status === 'wait');
      if (!it) break;
      const my = pass, s = settings();
      it.status = 'busy';
      render();
      const type = outType(it.file, s);
      // already within the limit and nothing asked to change: hand back the original, untouched
      const resize = s.maxSide && Math.max(it.w, it.h) > s.maxSide;
      if (s.limit && it.file.size <= s.limit && !s.square && !resize && type === it.file.type) {
        setResult(it, { kept: true, blob: it.file, width: it.w, height: it.h, quality: null, type });
        continue;
      }
      const r = await squeeze(it.file, { type, limit: s.limit, maxSide: s.maxSide, square: s.square });
      if (my !== pass && it.status === 'wait') continue; // settings changed meanwhile; this one runs again
      if (!items.includes(it)) continue;
      if (r.ok) setResult(it, { kept: false, blob: r.blob, width: r.width, height: r.height, quality: r.quality, type });
      else { it.status = 'error'; it.code = r.code; render(); }
    }
    running = false;
    render();
  }
  function setResult(it, r) {
    if (it.result && it.result.url && !it.result.kept) URL.revokeObjectURL(it.result.url);
    it.result = { ...r, url: r.kept ? it.src : URL.createObjectURL(r.blob), size: r.blob.size };
    it.status = 'done';
    count(it);
    render();
  }

  // ---------- results ----------
  function errText(it) {
    if (it.code === 'limit') return '壓不到這麼小，請把上限調大或縮小尺寸';
    if (/\.(heic|heif)$/i.test(it.file.name) || /hei[cf]/i.test(it.file.type)) return '這個瀏覽器看不懂 HEIC。iPhone 可到「設定 > 相機 > 格式」選「最相容」，或改用 Safari';
    return '看不懂這張圖片，可能檔案壞了或格式不支援';
  }
  function render() {
    const box = $('#results');
    $('#tool').classList.toggle('has-results', items.length > 0);
    if (!items.length) {
      box.replaceChildren(el('div', { class: 'empty' },
        el('span', { class: 'ring', html: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-4.5-4.5L8 20"/></svg>' }),
        el('b', { text: '壓好的圖片會出現在這裡' }),
        el('span', { text: '放進來就會自動壓，改設定也會馬上重算' })));
    } else {
      const done = items.filter((it) => it.status === 'done');
      const src = done.reduce((a, it) => a + it.file.size, 0), out = done.reduce((a, it) => a + it.result.size, 0);
      const busy = items.filter((it) => it.status === 'busy' || it.status === 'wait').length;
      box.replaceChildren(
        el('p', { class: 'sum' }, el('span', {}, el('b', { text: items.length }), ' 張'),
          done.length ? el('span', {}, `${fmtBytes(src)} → `, el('b', { text: fmtBytes(out) }), `，省下 ${pct(out, src)}%`) : null,
          busy ? el('span', { text: `${busy} 張處理中…` }) : null),
        el('ol', { class: 'list' }, ...items.map(row)));
    }
    const done = items.filter((it) => it.status === 'done');
    $('#note').textContent = !items.length ? '還沒有加入圖片。' : `${items.length} 張・${done.length} 張完成`;
    // one picture comes as itself; only two or more are worth a ZIP
    $('#zipAll').disabled = !done.length;
    $('#zipAll').textContent = done.length === 1 ? '下載圖片' : '全部下載（ZIP）';
    $('#clearAll').disabled = !items.length;
    $('.panel-foot').classList.toggle('solo', items.length <= 1);
  }

  function row(it) {
    const r = it.result, busy = it.status === 'busy' || it.status === 'wait';
    const sub = el('span', { class: 'size' });
    if (busy) sub.textContent = it.status === 'busy' ? '壓縮中…' : '等待中…';
    else if (it.status === 'error') { sub.className = 'bad'; sub.textContent = errText(it); sub.title = errText(it); }
    else if (r.kept) sub.append(`${fmtBytes(it.file.size)}・原檔就在上限內，不用壓縮`);
    else sub.append(`${fmtBytes(it.file.size)} → `, el('b', { text: fmtBytes(r.size) }), ' ', el('span', { class: 'saved', text: `-${pct(r.size, it.file.size)}%` }), el('span', { class: 'dim', text: `・${r.width}×${r.height}` }));
    const toggle = () => { if (it.status !== 'done') return; it.open = !it.open; it.autoOpen = false; render(); };
    const main = el('div', { class: 'row-main', role: 'button', tabindex: '0', 'aria-expanded': String(!!it.open), onclick: toggle,
      onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } } },
      it.status === 'error' ? el('span', { class: 'th none', text: '?' }) : el('img', { class: 'th', src: r && !r.kept ? r.url : it.src, alt: '', width: 56, height: 56 }),
      el('span', { class: 'who' }, el('b', { text: it.file.name, title: it.file.name }), sub),
      el('span', { class: 'row-acts' },
        busy ? el('span', { class: 'spinner', 'aria-label': '處理中' }) : null,
        it.status === 'done' ? el('button', { type: 'button', class: 'btn', text: '下載', onclick: (e) => { e.stopPropagation(); download(it); } }) : null,
        !busy ? el('button', { type: 'button', class: 'icon-btn sm', title: '移除', 'aria-label': `移除 ${it.file.name}`, text: '×', onclick: (e) => { e.stopPropagation(); remove(it); } }) : null));
    const li = el('li', { class: `row${it.open && it.status === 'done' ? ' open' : ''}` }, main);
    if (it.open && it.status === 'done') li.append(detail(it));
    return li;
  }

  function detail(it) {
    const r = it.result;
    const cmp = el('div', { class: 'compare' },
      el('img', { src: r.url, alt: '壓縮後' }),
      el('img', { class: 'before', src: it.src, alt: '原圖' }),
      el('span', { class: 'line' }), el('span', { class: 'tag l', text: '原圖' }), el('span', { class: 'tag r', text: '壓縮後' }));
    const slider = el('input', { type: 'range', min: 0, max: 100, value: 50, 'aria-label': '左右拖曳比較原圖和壓縮後' });
    slider.addEventListener('input', () => cmp.style.setProperty('--x', `${slider.value}%`));
    cmp.append(slider);
    return el('div', { class: 'row-detail' }, cmp, el('p', { class: 'facts' },
      el('span', {}, '原圖 ', el('b', { text: it.w ? `${it.w}×${it.h}` : '—' }), `・${fmtBytes(it.file.size)}`),
      el('span', {}, '壓縮後 ', el('b', { text: `${r.width}×${r.height}` }), `・${fmtBytes(r.size)}`),
      el('span', { text: `${TYPE_NAME[r.type] || r.type}${r.quality ? `・畫質 ${Math.round(r.quality * 100)}%` : ''}` }),
      r.kept ? null : el('span', { text: '拍攝地點等資料已移除' }),
      !r.kept && r.type === 'image/jpeg' && /png|webp|gif|avif/.test(it.file.type) ? el('span', { text: '透明的地方會變成白色' }) : null));
  }

  // ---------- download ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  const outName = (it) => (it.result.kept ? it.file.name : `${it.file.name.replace(/\.[^.]+$/, '')}_壓縮.${EXT[it.result.type] || 'jpg'}`);
  function save(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  const download = (it) => save(it.result.blob, outName(it));
  $('#zipAll').addEventListener('click', async () => {
    const done = items.filter((it) => it.status === 'done');
    if (done.length === 1) { download(done[0]); return; }
    const used = new Set(), files = [];
    for (const it of done) {
      let name = outName(it), n = 2;
      while (used.has(name)) name = outName(it).replace(/(\.[^.]+)$/, ` (${n++})$1`);
      used.add(name);
      files.push({ name, data: new Uint8Array(await it.result.blob.arrayBuffer()) });
    }
    save(ManyZip.make(files), `圖片壓縮-${files.length}張.zip`);
  });

  // ---------- the counter ----------
  // Only numbers leave the browser: one per picture (the first time it's done) and the bytes it saved.
  const counted = new Set();
  function count(it) {
    if (counted.has(it.id) || !onServer) return;
    counted.add(it.id);
    fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ files: 1, savedBytes: Math.max(0, it.file.size - it.result.size) }) }).then(loadStats).catch(() => {});
  }
  async function loadStats() {
    if (!onServer) return;
    try {
      const r = await fetch('api/stats', { cache: 'no-store' });
      const st = r.ok ? await r.json() : null;
      if (st && st.files > 0) {
        const gb = st.savedBytes / 1e9;
        $('#heroCount').replaceChildren('已幫大家壓了 ', el('b', { class: 'hero-num', text: st.files.toLocaleString('zh-TW') }), ' 張圖片',
          st.savedBytes > 0 ? el('span', { class: 'hero-extra', text: `・省下 ${gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(st.savedBytes / 1e6))} MB`}` }) : null);
      }
    } catch {}
  }
  loadStats();
  render();
})();
