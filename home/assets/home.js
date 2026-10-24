/* Home page: the live numbers, and the drop area that sends files to the right tool.
   Files never leave this browser: they're handed to the tool page through ManyHandoff (/shared/handoff.js).
   The numbers are totals from the server (see server/server.js); opened as a local file, links point at the
   sibling folders instead and the numbers stay at 0. */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const onServer = /^https?:$/.test(location.protocol);
  if (!onServer) for (const a of document.querySelectorAll('a[data-local]')) a.href = a.dataset.local;
  const TOOL_URL = onServer ? { video: '/video', pdf: '/pdf', image: '/image' }
    : { video: '../videotools/index.html', pdf: '../pdftools/local/index.html', image: '../imagetools/index.html' };
  const TOOL_NAME = { video: '影片碼率壓縮', pdf: 'PDF 壓縮・拆分', image: '圖片壓縮' };

  // ---------- live numbers ----------
  function countUp(node, to) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || to < 2) { node.textContent = to.toLocaleString('zh-TW'); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
      node.textContent = Math.round(to * e).toLocaleString('zh-TW');
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // the header always shows the three numbers; 0 until the server has something
  if (onServer) {
    fetch('api/stats', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((st) => {
        const v = (st && st.video) || {}, p = (st && st.pdf) || {};
        const saved = (v.savedBytes || 0) + (p.savedBytes || 0) + (((st && st.image) || {}).savedBytes || 0);
        countUp($('[data-stat="video.files"]'), v.files || 0);
        countUp($('[data-stat="pdf.files"]'), p.files || 0);
        countUp($('[data-stat="avatar.files"]'), (((st && st.avatar) || {}).files || 0) + (((st && st.crop) || {}).files || 0));   // looked up + cropped
        countUp($('[data-stat="image.files"]'), ((st && st.image) || {}).files || 0);
        if (saved > 0) $('[data-stat="saved"]').textContent = saved >= 1e9 ? `${(saved / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(saved / 1e6))} MB`;
      })
      .catch(() => {});
  }

  // ---------- the tool hiding behind the avatar card ----------
  // Hover and keyboard focus show it by CSS alone; touch screens use the "+1" button, and a tap elsewhere hides it.
  const stack = $('#avatarStack'), peekBtn = $('#peekToggle');
  if (stack && peekBtn) {
    const show = (open) => { stack.classList.toggle('open', open); peekBtn.setAttribute('aria-expanded', String(open)); };
    peekBtn.addEventListener('click', () => show(!stack.classList.contains('open')));
    document.addEventListener('click', (e) => { if (!stack.contains(e.target)) show(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(false); });
  }

  // ---------- drop area → the right tool ----------
  const drop = $('#drop'), pick = $('#pick'), toast = $('#toast');
  let toastTimer;
  function say(text, ms = 3500) {
    toast.textContent = text; toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
  }
  const kindOf = (name, type) => (/pdf$/i.test(type || '') || /\.pdf$/i.test(name) ? 'pdf'
    : /^video\//.test(type || '') || /\.(mp4|mov|m4v|mts|m2ts|ts|mkv|webm|mxf)$/i.test(name) ? 'video'
    : /^image\//.test(type || '') || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i.test(name) ? 'image' : null);
  // Small files travel as themselves; a big video travels as a file handle when the browser has one (no copy).
  const SMALL = 300e6, COPY_LIMIT = 2e9;

  async function route(list) {
    const items = list.filter((x) => x.file);
    if (!items.length) return;
    const kinds = new Set(items.map((x) => kindOf(x.file.name, x.file.type)));
    if (kinds.has(null)) { say('目前只有影片、圖片和 PDF 的工具，這個檔案還沒辦法處理'); return; }
    if (kinds.size > 1) { say('影片、圖片和 PDF 要分開處理，請一次放同一種檔案'); return; }
    const tool = [...kinds][0];
    drop.classList.add('busy');
    const entries = [];
    for (const x of items) {
      const f = x.file;
      if (f.size <= SMALL || (!x.handle && f.size <= COPY_LIMIT)) entries.push({ name: f.name, file: f });
      else if (x.handle) entries.push({ name: f.name, handle: x.handle });
      else entries.push({ name: f.name });
    }
    try { if (window.ManyHandoff && window.indexedDB) await ManyHandoff.send(tool, entries); } catch {}
    say(`帶你到「${TOOL_NAME[tool]}」…`, 8000);
    location.href = TOOL_URL[tool];
  }

  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    const it = e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items[0];
    drop.classList.add('over');
    drop.classList.toggle('pdf', !!it && /pdf/.test(it.type));
    drop.classList.toggle('video', !!it && /^video\//.test(it.type));
    drop.classList.toggle('image', !!it && /^image\//.test(it.type));
  });
  drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over', 'pdf', 'video', 'image'); });
  // anywhere on the page counts as the drop area
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over', 'pdf', 'video', 'image');
    if (!e.dataTransfer) return;
    // Items are only readable during the event, so ask for every handle right now.
    const pending = [...e.dataTransfer.items].filter((it) => it.kind === 'file').map((it) => ({
      file: it.getAsFile(),
      handle: typeof it.getAsFileSystemHandle === 'function' ? it.getAsFileSystemHandle().catch(() => null) : null,
    }));
    Promise.all(pending.map(async (x) => ({ file: x.file, handle: x.handle ? await x.handle : null }))).then(route);
  });

  async function choose() {
    // Chrome/Edge: the picker gives handles, so even a huge clip is handed over without copying it.
    if (typeof window.showOpenFilePicker === 'function') {
      let handles;
      try {
        handles = await window.showOpenFilePicker({ multiple: true, types: [
          { description: '影片', accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.mts', '.m2ts', '.ts', '.mkv', '.webm', '.mxf'] } },
          { description: 'PDF', accept: { 'application/pdf': ['.pdf'] } },
          { description: '圖片', accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.heic', '.heif'] } },
        ] });
      } catch (e) { if (e && e.name === 'AbortError') return; handles = null; }
      if (handles) { route(await Promise.all(handles.map(async (h) => ({ file: await h.getFile(), handle: h })))); return; }
    }
    pick.click();
  }
  drop.addEventListener('click', choose);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
  pick.addEventListener('change', () => { route([...pick.files].map((file) => ({ file, handle: null }))); pick.value = ''; });
  // Coming back with the browser's back button shouldn't leave the area stuck on "busy".
  window.addEventListener('pageshow', () => { drop.classList.remove('busy'); toast.hidden = true; });
})();
