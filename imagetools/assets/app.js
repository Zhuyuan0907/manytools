/* ZhuyuanLoveImage — squeeze pictures under a size limit, all in this browser (compress.js does the work, in
   worker.js when a worker can start). Three steps: 1 drop pictures → 2 settings → 3 preview and download.
   Pictures are compressed when step 3 opens, and again only if a setting changed. On a server only the counts
   (pictures, bytes saved) are reported, never a picture or its name. */
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
  const fmtLimit = (b) => `${+(b / 1e6).toFixed(2)} MB`;
  const pct = (a, b) => Math.max(0, Math.round((1 - a / b) * 100));
  const TYPE_NAME = { 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/avif': 'AVIF', 'image/bmp': 'BMP', 'image/heic': 'HEIC', 'image/heif': 'HEIF' };
  const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
  const KEEPABLE = ['image/jpeg', 'image/webp', 'image/png'];

  // ---------- settings ----------
  function settings() {
    const lv = $('input[name=limit]:checked').value;
    const mb = lv === 'custom' ? Math.max(0.05, parseFloat($('#customMB').value) || 3) : +lv;
    return { limit: Math.round(mb * 1e6), fmt: $('input[name=fmt]:checked').value, maxSide: +$('#maxSide').value, square: $('#square').checked };
  }
  // "same as the file" keeps JPEG/PNG/WebP; anything else (GIF, BMP, AVIF, HEIC) becomes JPEG
  const outType = (file, s) => (s.fmt !== 'same' ? s.fmt : KEEPABLE.includes(file.type) ? file.type : 'image/jpeg');
  const keyOf = (s) => JSON.stringify(s);
  for (const n of $$('input[name=limit], input[name=fmt], #maxSide, #square')) n.addEventListener('change', () => { $('#customBox').hidden = $('input[name=limit]:checked').value !== 'custom'; render(); });
  $('#customMB').addEventListener('input', render);

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

  // ---------- steps ----------
  const S = { step: 1, ran: false };
  const STEP_NAMES = ['放入圖片', '壓縮設定', '預覽與下載'];
  let items = [], nextId = 1;
  const readable = () => items.filter((it) => !it.unreadable);
  function allowed(n) {
    if (n === 1) return true;
    if (n === 2) return readable().length > 0 && items.every((it) => it.w || it.unreadable);
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

  const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i.test(f.name);
  const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type);
  const typeName = (f) => TYPE_NAME[f.type] || (isHeic(f) ? 'HEIC' : (f.name.split('.').pop() || '').toUpperCase());
  function add(list) {
    const files = [...list].filter(isImage);
    if (!files.length) { if (list.length) toast('這不是圖片檔'); return; }
    for (const file of files) {
      if (items.some((it) => it.file.name === file.name && it.file.size === file.size)) continue;
      const it = { id: nextId++, file, src: URL.createObjectURL(file), status: 'wait', open: false, w: 0, h: 0, unreadable: false, key: null };
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
    if (it.result && !it.result.kept) URL.revokeObjectURL(it.result.url);
    if (!readable().length && S.step !== 1) goto(1); else render();
  }
  const unreadableText = (it) => (isHeic(it.file)
    ? '這個瀏覽器看不懂 HEIC。iPhone 可到「設定 > 相機 > 格式」選「最相容」，或改用 Safari'
    : '看不懂這張圖片，可能檔案壞了或格式不支援');
  function renderStep1() {
    $('#step1').classList.toggle('has-files', items.length > 0);
    $('#sources').replaceChildren(...items.map((it) => {
      const meta = it.unreadable ? unreadableText(it) : it.w ? `${fmtBytes(it.file.size)}・${it.w}×${it.h}・${typeName(it.file)}` : '讀取中…';
      return el('li', { class: 'src' },
        it.unreadable ? el('span', { class: 'src-th none', text: '?' }) : el('img', { class: 'src-th', src: it.src, alt: '' }),
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
    const s = settings(), ok = readable();
    const kept = ok.filter((it) => s.limit && it.file.size <= s.limit && !s.square && !(s.maxSide && Math.max(it.w, it.h) > s.maxSide) && outType(it.file, s) === it.file.type);
    const lines = [];
    lines.push(s.limit ? el('li', {}, '壓到 ', el('b', { text: `${fmtLimit(s.limit)} 以內` }), '，畫質盡量保留') : el('li', {}, '不限大小，用 ', el('b', { text: '85% 畫質' }), '重新存檔'));
    if (kept.length) lines.push(el('li', {}, el('b', { text: `${kept.length} 張` }), '原本就符合，直接給原檔'));
    lines.push(el('li', {}, '輸出成 ', el('b', { text: s.fmt === 'same' ? '原本的格式' : TYPE_NAME[s.fmt] }), s.fmt === 'same' && ok.some((it) => !KEEPABLE.includes(it.file.type)) ? '（GIF、HEIC 這類轉成 JPEG）' : ''));
    if (s.maxSide) lines.push(el('li', {}, '最長邊縮到 ', el('b', { text: `${s.maxSide} px` })));
    if (s.square) lines.push(el('li', {}, '從中間', el('b', { text: '裁成正方形' })));
    if (s.fmt === 'image/jpeg' && ok.some((it) => /png|webp|gif/.test(it.file.type))) lines.push(el('li', { class: 'warn' }, '透明的地方會變成白色'));
    if (items.length > ok.length) lines.push(el('li', { class: 'warn' }, `${items.length - ok.length} 張讀不了，會略過`));
    $('#plan').replaceChildren(...lines);
    $('#note2').textContent = `${ok.length} 張・共 ${fmtBytes(ok.reduce((a, it) => a + it.file.size, 0))}`;
    $('#next2').textContent = ok.length > 1 ? `開始壓縮 ${ok.length} 張 →` : '開始壓縮 →';
  }

  // ---------- step 3: compress, preview, download ----------
  let pass = 0, running = false;
  function startRun() {
    const key = keyOf(settings());
    for (const it of readable()) if (it.key !== key) { it.status = 'wait'; it.key = key; }
    pass++;
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
      const type = outType(it.file, s);
      // already within the limit and nothing asked to change: hand back the original, untouched
      const resize = s.maxSide && Math.max(it.w, it.h) > s.maxSide;
      let r;
      if (s.limit && it.file.size <= s.limit && !s.square && !resize && type === it.file.type) r = { ok: true, kept: true, blob: it.file, width: it.w, height: it.h, quality: null };
      else r = await squeeze(it.file, { type, limit: s.limit, maxSide: s.maxSide, square: s.square });
      if (!items.includes(it)) continue;
      if (it.key !== key) { it.status = 'wait'; continue; } // settings changed meanwhile; this one runs again
      if (r.ok) setResult(it, { ...r, type });
      else { it.status = 'error'; it.code = r.code; }
      render();
    }
    running = false;
    render();
  }
  function setResult(it, r) {
    if (it.result && !it.result.kept) URL.revokeObjectURL(it.result.url);
    it.result = { kept: !!r.kept, blob: r.blob, width: r.width, height: r.height, quality: r.quality, type: r.type, url: r.kept ? it.src : URL.createObjectURL(r.blob), size: r.blob.size };
    it.status = 'done';
    count(it);
  }

  function renderStep3() {
    const ok = readable(), done = ok.filter((it) => it.status === 'done');
    const busy = ok.filter((it) => it.status === 'busy' || it.status === 'wait').length;
    if (ok.length === 1 && !ok[0].touched) ok[0].open = true;
    const src = done.reduce((a, it) => a + it.file.size, 0), out = done.reduce((a, it) => a + it.result.size, 0);
    fill($('#sum'), 
      el('span', {}, el('b', { text: ok.length }), ' 張'),
      done.length ? el('span', {}, `${fmtBytes(src)} → `, el('b', { text: fmtBytes(out) }), `，省下 ${pct(out, src)}%`) : null,
      busy ? el('span', { text: `${busy} 張壓縮中…` }) : null);
    $('#h3p').textContent = busy ? '壓縮中，圖片只在你的電腦裡處理' : ok.length > 1 ? '點一張圖，左右拖動比較原圖和壓縮後' : '左右拖動比較原圖和壓縮後';
    $('#results').replaceChildren(...ok.map(row));
    $('#note3').textContent = busy ? `${done.length} / ${ok.length} 張完成` : `${done.length} 張完成`;
    // one picture comes as itself; only two or more are worth a ZIP
    $('#zipAll').disabled = !done.length || busy > 0;
    $('#zipAll').textContent = done.length === 1 ? '下載圖片' : '全部下載（ZIP）';
  }
  const errText = (it) => (it.code === 'limit' ? '壓不到這麼小，請把上限調大或縮小尺寸' : '這張沒辦法壓縮，可能檔案壞了');
  function row(it) {
    const r = it.result, busy = it.status === 'busy' || it.status === 'wait';
    const sub = el('span', { class: 'size' });
    if (busy) sub.textContent = it.status === 'busy' ? '壓縮中…' : '等待中…';
    else if (it.status === 'error') { sub.className = 'bad'; sub.textContent = errText(it); }
    else if (r.kept) sub.append(`${fmtBytes(it.file.size)}・原檔就在上限內，不用壓縮`);
    else sub.append(`${fmtBytes(it.file.size)} → `, el('b', { text: fmtBytes(r.size) }), ' ', el('span', { class: 'saved', text: `-${pct(r.size, it.file.size)}%` }), el('span', { class: 'dim', text: `・${r.width}×${r.height}` }));
    const toggle = () => { if (it.status !== 'done') return; it.open = !it.open; it.touched = true; render(); };
    const main = el('div', { class: 'row-main', role: 'button', tabindex: '0', 'aria-expanded': String(!!it.open), onclick: toggle,
      onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } } },
      el('img', { class: 'th', src: r && !r.kept ? r.url : it.src, alt: '', width: 56, height: 56 }),
      el('span', { class: 'who' }, el('b', { text: it.file.name, title: it.file.name }), sub),
      el('span', { class: 'row-acts' },
        busy ? el('span', { class: 'spinner', 'aria-label': '處理中' }) : null,
        it.status === 'done' ? el('button', { type: 'button', class: 'btn', text: '下載', onclick: (e) => { e.stopPropagation(); download(it); } }) : null));
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
    const done = readable().filter((it) => it.status === 'done');
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
  $('#restart').addEventListener('click', () => {
    for (const it of items) { URL.revokeObjectURL(it.src); if (it.result && !it.result.kept) URL.revokeObjectURL(it.result.url); }
    items = []; S.ran = false;
    goto(1);
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
        fill($('#heroCount'), '已幫大家壓了 ', el('b', { class: 'hero-num', text: st.files.toLocaleString('zh-TW') }), ' 張圖片',
          st.savedBytes > 0 ? el('span', { class: 'hero-extra', text: `・省下 ${gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(st.savedBytes / 1e6))} MB`}` }) : null);
      }
    } catch {}
  }
  window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });
  loadStats();
  render();
})();
