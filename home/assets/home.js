/* ZhuyuanTools home: two sides, 日常 and 拍攝 — the same page with different tools — behind one switch (three bands
   sweep across from the bottom left to the top right as it changes),
   the live numbers, and dropping files: on the drop area or viewfinder they go to the right tool (photos ask which
   one), on a tool they go straight to it.
   Files never leave this browser: they're handed to the tool page through ManyHandoff (/shared/handoff.js) — as
   file handles where the browser has them (Chrome, Edge: nothing is copied, a folder stays a folder), else as files.
   The numbers are totals from the server (see server/server.js). Opened as a local file, links point at the sibling
   folders and there's no /photo address. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const onServer = /^https?:$/.test(location.protocol);
  if (!onServer) for (const a of $$('a[data-local]')) a.href = a.dataset.local;
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const num = (n) => n.toLocaleString('zh-TW');

  let toastTimer;
  function say(text, ms = 3800) {
    const t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- big screens: the same page, larger ----------
  // Laid out for about 1420 × 770 (ultra-wide: 1900 × 640); a bigger screen at 100 % gets it scaled up (CSS zoom), as
  // far as its height allows. Not across two screens: the hinge's position (env()) isn't zoomed.
  // Ctrl/⌘ + and − change the device pixel ratio and the window's size in CSS px together: that's the visitor zooming,
  // and z is fitted to the size before it (k), so their zoom isn't undone.
  let dpr = devicePixelRatio, cssW = innerWidth, k = 1;
  function fitZoom() {
    const W = innerWidth * k, H = innerHeight * k;
    const ultra = matchMedia('(min-aspect-ratio: 21/10) and (min-width: 1900px)').matches;
    const z = matchMedia('(horizontal-viewport-segments: 2)').matches ? 1
      : ultra ? Math.max(1, Math.min(W / 1900, H / 640, 2.6)) : Math.max(1, Math.min(W / 1420, H / 770, 2.6));
    root.style.setProperty('--z', z.toFixed(3));
  }
  fitZoom();
  addEventListener('resize', () => {
    if (devicePixelRatio !== dpr && innerWidth !== cssW) k *= devicePixelRatio / dpr;
    dpr = devicePixelRatio; cssW = innerWidth;
    fitZoom();
  });

  // ---------- the two sides ----------
  const SIDES = { daily: { path: '/', title: 'ZhuyuanTools・小小ㄉ工具箱', theme: '#f4f7fa' }, photo: { path: '/photo', title: 'ZhuyuanTools・拍攝', theme: '#f4f7fa' } };
  let side = root.dataset.world === 'photo' ? 'photo' : 'daily';
  function tabs(to) {
    for (const b of $$('.switch [role="tab"]')) {
      const on = b.dataset.world === to;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  function paint() {
    tabs(side);
    document.title = SIDES[side].title;
    $('meta[name="theme-color"]').content = SIDES[side].theme;
  }
  paint();
  // remembered 拍攝 opened at /: say so in the address too
  if (onServer && side === 'photo' && location.pathname === '/') history.replaceState({ side }, '', '/photo');

  let moving = false, popped = false, settle = 0;
  // how: 'push' (a new address), 'pop' (Back/Forward already moved it)
  async function turn(to, how = 'push') {
    if (moving || to === side) return;
    moving = true;
    // the other side's characters: their font slices start loading now, not after the swap
    if (document.fonts) document.fonts.load('700 1em "Noto Sans TC Web"', $(`#${to}`).textContent).catch(() => {});
    $('#switch').dataset.to = to;   // the switch moves at once, above the sweep
    tabs(to);
    if (onServer && how === 'push') history.pushState({ side: to }, '', SIDES[to].path);   // the address at once too
    const swap = () => {
      side = to;
      root.dataset.world = to;
      delete $('#switch').dataset.to;
      paint();
      if (scrollY) scrollTo(0, 0);   // the other side opens at its top (hidden under the band)
      try { localStorage.setItem('zt-world', to); } catch {}
      const sec = $(`#${to}`);
      sec.classList.remove('enter', 'fade');
      sec.classList.add(calm() ? 'fade' : 'enter');
      clearTimeout(settle);
      settle = setTimeout(() => sec.classList.remove('enter', 'fade'), 900);
    };
    if (calm()) swap(); else await sweep(to, swap);
    moving = false;
    // Back or Forward pressed during the sweep: follow the address now
    if (popped) {
      popped = false;
      const at = location.pathname === '/photo' ? 'photo' : 'daily';
      if (onServer && at !== side) turn(at, 'pop');
    }
  }
  for (const b of $$('.switch [role="tab"]')) b.addEventListener('click', () => turn(b.dataset.world));
  // the arrow keys move between the two (a tab list)
  $('#switch').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    if (moving) return;   // like clicks, keys wait for the sweep (focus stays on the tab being selected)
    const to = e.key === 'Home' ? 'daily' : e.key === 'End' ? 'photo' : side === 'daily' ? 'photo' : 'daily';
    turn(to);
    $(`.switch [data-world="${to}"]`).focus();
  });
  addEventListener('popstate', () => {
    if (moving) { popped = true; return; }
    turn(location.pathname === '/photo' ? 'photo' : 'daily', 'pop');
  });

  // ---------- the sweep ----------
  // Three bands cross the screen from the bottom left to the top right, under the header and footer (which stay): two
  // in the colours of the side you're going to, then a pale one that covers everything — it stops there until the new
  // side has been drawn (two frames), and only then moves on and uncovers it. Each band is a long strip turned 45°,
  // moved by its transform only (smooth on a phone too).
  const sweepBox = $('#sweep');
  const SWEEP = { photo: ['#e8630a', '#ffd6b3', '#fff8f2'], daily: ['#2468e0', '#cddcfa', '#f5f8fe'] };
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  async function sweep(to, atCovered) {
    const W = innerWidth, H = innerHeight;
    const across = (W + H) / Math.SQRT2;          // the screen measured along the sweep
    const thick = across * 1.25, long = Math.hypot(W, H) * 2;
    const far = (thick + across) / 2 + 8;
    const at = (d) => `translate(${(d * Math.SQRT1_2).toFixed(1)}px, ${(-d * Math.SQRT1_2).toFixed(1)}px) rotate(45deg)`;
    const DUR = 420, STEP = 45;
    const bands = $$('i', sweepBox);
    bands.forEach((band, i) => Object.assign(band.style, { width: `${long}px`, height: `${thick}px`, marginLeft: `${-long / 2}px`, marginTop: `${-thick / 2}px`, background: SWEEP[to][i] }));
    sweepBox.hidden = false;
    const runs = bands.slice(0, 2).map((band, i) => band.animate([{ transform: at(-far) }, { transform: at(far) }], { duration: DUR, delay: i * STEP, easing: 'cubic-bezier(.45, 0, .2, 1)', fill: 'both' }));
    const last = bands[2];
    const inn = last.animate([{ transform: at(-far) }, { transform: at(0) }], { duration: DUR * 0.55, delay: 2 * STEP, easing: 'cubic-bezier(.45, 0, 1, 1)', fill: 'both' });
    try { await inn.finished; } catch {}
    atCovered();
    await frame(); await frame();   // the new side is on screen under the band
    const out = last.animate([{ transform: at(0) }, { transform: at(far) }], { duration: DUR * 0.6, easing: 'cubic-bezier(0, 0, .2, 1)', fill: 'forwards' });
    inn.cancel();
    try { await out.finished; } catch {}
    sweepBox.hidden = true;
    for (const r of [...runs, out]) r.cancel();
  }

  // ---------- live numbers ----------
  function countUp(node, to) {
    if (calm() || to < 2) { node.textContent = num(to); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
      node.textContent = num(Math.round(to * e));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  if (onServer) {
    fetch('/api/stats', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((st) => {
        const f = (k) => ((st && st[k]) || {}).files || 0;
        // a count of 0 isn't shown (「0 部影片」 says nothing); a line with nothing left stays hidden
        const set = (key, n) => {
          for (const node of $$(`[data-stat="${key}"]`)) {
            const part = node.closest('.n-c');
            if (part) part.hidden = !n;
            if (n) countUp(node, n);
          }
        };
        set('video.files', f('video'));
        set('pdf.files', f('pdf') + f('watermark'));      // compressed + watermarked
        set('avatar.files', f('avatar') + f('crop'));     // looked up + cropped
        set('photo.files', f('image') + f('exif') + f('pick'));   // compressed + read + picked
        for (const p of $$('.nums')) p.hidden = !$$('.n-c:not([hidden])', p).length;
      })
      .catch(() => {});
  }

  // ---------- files in ----------
  const TOOL_URL = {
    video: ['/video', '../videotools/index.html'], pdf: ['/pdf', '../pdftools/local/index.html'], watermark: ['/watermark', '../watermarktools/index.html'],
    avatar: ['/avatar', '../avatartools/index.html'], crop: ['/crop', '../croptools/index.html'], image: ['/image', '../imagetools/index.html'],
    exif: ['/exif', '../exiftools/index.html'], rename: ['/rename', '../renametools/index.html'], pick: ['/pick', '../picktools/index.html'],
  };
  const TOOL_NAME = { video: '影片碼率壓縮', pdf: 'PDF 壓縮・拆分', watermark: 'PDF 浮水印', avatar: 'Gravatar 頭貼查詢', crop: '頭貼裁切', image: '圖片壓縮', exif: '照片參數查看', rename: '照片改名稱', pick: '照片挑選' };
  const RAW = /\.(cr3|cr2|crw|nef|nrw|arw|srf|sr2|raf|orf|ori|rw2|rwl|dng|pef|ptx|srw|3fr|fff|iiq|erf|kdc|dcr|mef|mos|mrw|x3f|gpr)$/i;
  const kindOf = (name, type) => (/\.zip$/i.test(name) || /zip/.test(type || '') ? 'zip'
    : RAW.test(name) ? 'raw'
    : /pdf$/i.test(type || '') || /\.pdf$/i.test(name) ? 'pdf'
    : /^video\//.test(type || '') || /\.(mp4|mov|m4v|mts|m2ts|ts|mkv|webm|mxf)$/i.test(name) ? 'video'
    : /^image\//.test(type || '') || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif|hif)$/i.test(name) ? 'image' : 'other');
  // what each tool can open
  const TAKES = {
    video: ['video'], pdf: ['pdf'], watermark: ['pdf'], avatar: [], crop: ['image'],
    image: ['image'], exif: ['image', 'raw'], rename: ['image', 'raw', 'video', 'other'], pick: ['image', 'zip'],
  };
  const PHOTO_TOOLS = ['pick', 'rename', 'image', 'exif'];
  const HIDDEN = (n) => n.startsWith('.') || /^(__MACOSX|thumbs\.db|desktop\.ini)$/i.test(n);

  // A drop: everything asked for now (the items are gone once the event is over), folders walked after.
  // → { tops: [{ name, handle?, dir? }], files: [{ file, path, kind }] }
  function grab(dt) {
    const items = [...dt.items].filter((i) => i.kind === 'file');
    return items.map((i) => ({
      entry: typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null,
      file: i.getAsFile(),
      handle: typeof i.getAsFileSystemHandle === 'function' ? i.getAsFileSystemHandle().catch(() => null) : null,
    }));
  }
  function walk(entry, out) {
    return new Promise((done) => {
      if (HIDDEN(entry.name)) { done(); return; }
      if (entry.isFile) { entry.file((f) => { out.push({ file: f, path: entry.fullPath.replace(/^\//, ''), kind: kindOf(f.name, f.type) }); done(); }, () => done()); return; }
      const rd = entry.createReader(), kids = [];
      const more = () => rd.readEntries(async (got) => {
        if (got.length) { kids.push(...got); more(); return; }
        for (let i = 0; i < kids.length; i += 64) await Promise.all(kids.slice(i, i + 64).map((k) => walk(k, out)));
        done();
      }, () => done());
      more();
    });
  }
  async function open(grabbed) {
    const set = { tops: [], files: [] };
    for (const g of grabbed) {
      const handle = g.handle ? await g.handle : null;
      if (g.entry && g.entry.isDirectory) {
        set.tops.push({ name: g.entry.name, dir: handle && handle.kind === 'directory' ? handle : null, folder: true });
        await walk(g.entry, set.files);
      } else if (g.file && !HIDDEN(g.file.name)) {
        set.tops.push({ name: g.file.name, handle: handle && handle.kind === 'file' ? handle : null });
        set.files.push({ file: g.file, path: g.file.name, kind: kindOf(g.file.name, g.file.type) });
      }
    }
    set.kinds = new Set(set.files.map((f) => f.kind));
    set.folders = set.tops.some((t) => t.folder);
    set.bytes = set.files.reduce((a, f) => a + f.file.size, 0);
    set.count = (kinds) => set.files.filter((f) => kinds.includes(f.kind)).length;
    return set;
  }
  const fromPicker = (files) => {
    const set = { tops: files.map((f) => ({ name: f.name })), files: files.map((f) => ({ file: f, path: f.name, kind: kindOf(f.name, f.type) })) };
    set.kinds = new Set(set.files.map((f) => f.kind));
    set.folders = false;
    set.bytes = files.reduce((a, f) => a + f.size, 0);
    set.count = (kinds) => set.files.filter((f) => kinds.includes(f.kind)).length;
    return set;
  };

  // Handing over. Handles copy nothing (a whole Drive download, a big video); without them the files themselves are
  // stored for the tool page, which copies them, so that's kept to a sensible size.
  const COPY_LIMIT = 2e9;
  async function hand(tool, set) {
    const takes = TAKES[tool];
    const useful = set.files.filter((f) => takes.includes(f.kind));
    const handles = set.tops.length && set.tops.every((t) => t.handle || t.dir);
    let entries;
    if ((tool === 'pick' || tool === 'rename') && handles) {
      entries = set.tops.map((t) => (t.dir ? { name: t.name, dir: t.dir } : { name: t.name, handle: t.handle }));
    } else if (!set.folders && handles && (set.bytes > 300e6 || tool === 'video')) {
      entries = set.tops.filter((t, i) => takes.includes(set.files[i].kind)).map((t) => ({ name: t.name, handle: t.handle }));
    } else if (useful.reduce((a, f) => a + f.file.size, 0) <= COPY_LIMIT) {
      entries = useful.map((f) => ({ name: f.file.name, file: f.file, path: f.path }));
    } else {
      entries = useful.map((f) => ({ name: f.file.name }));   // too much to copy: the tool asks for them again
    }
    try { if (window.ManyHandoff && window.indexedDB) await ManyHandoff.send(tool, entries); } catch {}
    say(`帶你到「${TOOL_NAME[tool]}」…`, 8000);
    location.href = TOOL_URL[tool][onServer ? 0 : 1];
  }

  // where a set of files goes, from the drop area (daily), the viewfinder (photo) or a tool
  async function route(set, target) {
    if (!set.files.length) { say('沒有找到檔案'); return; }
    const k = set.kinds;
    if (target) {
      const ok = set.files.some((f) => TAKES[target].includes(f.kind));
      if (!ok) { say(`「${TOOL_NAME[target]}」不能開這種檔案`); return; }
      hand(target, set);
      return;
    }
    const photos = set.count(['image', 'raw', 'zip']);
    if (k.has('video') && k.size === 1) { hand('video', set); return; }
    if (k.has('pdf') && k.size === 1) { hand('pdf', set); return; }
    if (photos && photos === set.files.length - set.count(['other'])) {
      if (side !== 'photo') await turn('photo');
      ask(set);
      return;
    }
    if (photos && set.folders) { if (side !== 'photo') await turn('photo'); ask(set); return; }
    say(k.has('other') && k.size === 1 ? '這種檔案還沒有工具可以處理' : '影片、PDF 和照片要分開放，請一次放同一種');
  }

  // ---------- photos in: which tool ----------
  const dlg = $('#ask');
  let asking = null;
  // 照片挑選 is for a computer: a phone isn't offered it (the CSS hides it the same way)
  const PHONE = matchMedia('(pointer: coarse) and (max-width: 640px), (pointer: coarse) and (orientation: landscape) and (max-height: 500px)');
  function ask(set) {
    const n = set.count(['image', 'raw']), zips = set.count(['zip']), raw = set.count(['raw']), phone = PHONE.matches;
    // a ZIP (a Drive download): only 照片挑選 reads it as it is
    if (zips && !n) { if (phone) say('ZIP 要用電腦開「照片挑選」，手機請選照片'); else hand('pick', set); return; }
    asking = set;
    const can = { pick: !phone && (n - raw > 0 || zips > 0), rename: true, image: n - raw > 0, exif: n > 0 };
    let best = !phone && (n >= 20 || zips) ? 'pick' : raw === n ? 'exif' : n <= 3 ? 'exif' : 'image';
    if (!can[best]) best = PHOTO_TOOLS.find((t) => can[t]);
    const what = [n ? `${num(n)} 張照片` : '', zips ? `${num(zips)} 個 ZIP` : '', set.folders ? `來自 ${set.tops.filter((t) => t.folder).length} 個資料夾` : ''].filter(Boolean).join('・');
    $('#askN').textContent = what;
    for (const b of $$('.opt', dlg)) {
      b.disabled = !can[b.dataset.tool];
      b.classList.toggle('best', b.dataset.tool === best);
    }
    $('#askWhy').textContent = best === 'pick' ? (zips ? 'ZIP 只有照片挑選可以直接讀' : '這麼多張，通常先挑出要的')
      : raw === n ? '只有 RAW 檔：可以看參數或改名稱，不能壓縮'
      : n <= 3 ? '幾張照片：看看參數，或壓到上限內' : '';
    dlg.showModal();
    $('.opt.best', dlg).focus();
  }
  const outside = (e) => { const r = dlg.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  let downOut = false;
  dlg.addEventListener('pointerdown', (e) => { downOut = e.target === dlg && outside(e); });
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('.opt');
    if (b && !b.disabled && asking) { const set = asking; asking = null; dlg.close(); hand(b.dataset.tool, set); return; }
    // the backdrop (the card's own padding is the dialog element too; a drag that ends outside isn't a click outside)
    if (e.target === dlg && downOut && outside(e)) dlg.close();
  });
  dlg.addEventListener('keydown', (e) => {
    const i = '1234'.indexOf(e.key);
    if (i >= 0) { const b = $$('.opt', dlg)[i]; if (b && !b.disabled) b.click(); }
  });
  dlg.addEventListener('close', () => { asking = null; });

  // ---------- dropping ----------
  // over a tool: that tool lights up and says so; anywhere else: the side's own drop area
  let dragDepth = 0, lit = null;
  const zone = () => $(side === 'photo' ? '#dropPhoto' : '#drop');
  function light(el) {
    if (lit === el) return;
    if (lit) { lit.classList.remove('target'); const tag = $('.drop-tag', lit); if (tag) tag.remove(); }
    lit = el;
    if (el) { el.classList.add('target'); el.append(Object.assign(document.createElement('span'), { className: 'drop-tag', textContent: '放開就用這個' })); }
  }
  function clearDrag() {
    dragDepth = 0;
    light(null);
    for (const z of $$('.drop')) z.classList.remove('over', 'pdf', 'video', 'image');
  }
  addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) dragDepth++; });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) clearDrag(); });
  addEventListener('dragover', (e) => {
    e.preventDefault();
    const tool = e.target.closest && e.target.closest('[data-tool]');
    light(tool);
    const z = zone();
    z.classList.toggle('over', !tool);
    const it = e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items[0];
    z.classList.toggle('pdf', !tool && !!it && /pdf/.test(it.type));
    z.classList.toggle('video', !tool && !!it && /^video\//.test(it.type));
    z.classList.toggle('image', !tool && !!it && /^image\//.test(it.type));
  });
  addEventListener('drop', async (e) => {
    e.preventDefault();
    const tool = e.target.closest && e.target.closest('[data-tool]');
    const target = tool ? tool.dataset.tool : null;
    clearDrag();
    if (!e.dataTransfer || moving) return;
    const grabbed = grab(e.dataTransfer);
    const z = tool || zone();
    z.classList.add('busy');
    try { route(await open(grabbed), target); } finally { z.classList.remove('busy'); }
  });

  // a click or a tap: the file picker (the folder picker too, in Chrome, from the viewfinder)
  const pick = $('#pick');
  async function choose() {
    if (typeof window.showOpenFilePicker === 'function') {
      let handles;
      try {
        handles = await window.showOpenFilePicker({ multiple: true, id: `zt-${side}`, types: side === 'photo'
          ? [{ description: '照片', accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif', '.hif', '.dng', '.cr3', '.cr2', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf', '.rw2', '.rwl', '.pef', '.srw', '.3fr', '.iiq', '.x3f'] } }, { description: 'ZIP', accept: { 'application/zip': ['.zip'] } }]
          : [{ description: '影片', accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.mts', '.m2ts', '.ts', '.mkv', '.webm', '.mxf'] } }, { description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      } catch (e) { if (e && e.name === 'AbortError') return; handles = null; }
      if (handles) {
        const files = await Promise.all(handles.map((h) => h.getFile()));
        const set = fromPicker(files);
        set.tops = handles.map((h, i) => ({ name: files[i].name, handle: h }));
        route(set, null);
        return;
      }
    }
    pick.accept = ACCEPT[side];
    pick.click();
  }
  for (const z of [$('#drop'), $('#dropPhoto')]) {
    z.addEventListener('click', choose);
    z.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
  }
  const ACCEPT = {
    photo: 'image/*,.heic,.heif,.hif,.avif,.dng,.cr3,.cr2,.crw,.nef,.nrw,.arw,.srf,.sr2,.raf,.orf,.rw2,.rwl,.pef,.srw,.3fr,.iiq,.x3f,.zip,application/zip',
    daily: 'video/*,.mp4,.mov,.m4v,.mts,.m2ts,.ts,.mkv,.webm,.mxf,application/pdf,.pdf',
  };
  pick.addEventListener('change', () => { const fs = [...pick.files]; pick.value = ''; if (fs.length) route(fromPicker(fs), null); });

  // Back brings this page back as it was left
  addEventListener('pageshow', (e) => {
    for (const z of $$('.busy')) z.classList.remove('busy');
    $('#toast').hidden = true;
    if (e.persisted) clearDrag();
  });
})();
