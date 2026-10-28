/* Reading view. Pages only, as large as the window allows: two pages side by side
   on wide screens, one page at a time on a phone held upright. The first page (the cover) stands alone.
   Files arrive from the main page with postMessage; nothing leaves the computer. */
(() => {
  'use strict';
  const { el } = Core;
  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const spreadEl = $('#spread');

  const V = { loaded: false, out: null, sources: null, pages: null, origDocs: [], N: 0, cur: 1, token: 0 };

  // ---------- documents ----------
  function origDoc(i) {
    if (!V.origDocs[i]) {
      const s = V.sources[i];
      V.origDocs[i] = s.file.arrayBuffer().then((buf) => Core.openPdf(new Uint8Array(buf), s.password).promise);
    }
    return V.origDocs[i];
  }
  async function getPage(p) {
    if (V.out) return V.out.getPage(p);
    const [si, n] = V.pages[p - 1];
    return (await origDoc(si)).getPage(n);
  }

  // ---------- which pages are on screen ----------
  const twoUp = () => window.innerWidth >= 700 && window.innerWidth > window.innerHeight;
  // Book order: 1 | 2–3 | 4–5 | … ; one page at a time when the screen is narrow.
  const startOf = (p) => (!twoUp() || p <= 1 ? Math.max(1, p) : p % 2 === 0 ? p : p - 1);
  function visible(start) {
    if (!twoUp() || start === 1) return [start];
    return start + 1 <= V.N ? [start, start + 1] : [start];
  }
  const nextStart = (d) => {
    const s = startOf(V.cur);
    if (!twoUp()) return s + d;
    if (d > 0) return s === 1 ? 2 : s + 2;
    return s <= 2 ? 1 : s - 2;
  };

  // ---------- render cache ----------
  const cache = new Map();
  const CACHE_MAX = 10;
  function remember(key, canvas) {
    cache.set(key, canvas);
    while (cache.size > CACHE_MAX) {
      const [k, old] = cache.entries().next().value;
      cache.delete(k); old.width = 0; old.height = 0;
    }
  }
  const inflight = new Map();
  function renderCanvas(p, page, scale) {
    const key = `${p}:${scale.toFixed(3)}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      remember(key, c);
      return c;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  // ---------- layout: fit the visible pages into the stage ----------
  async function render(dir) {
    if (!V.loaded) return;
    const token = ++V.token;
    const nums = visible(startOf(V.cur));
    let pages;
    try { pages = await Promise.all(nums.map(getPage)); }
    catch { spreadEl.replaceChildren(el('div', { class: 'pg' }, el('div', { class: 'err', text: '這一頁無法顯示' }))); return; }
    if (token !== V.token) return;
    const sizes = pages.map((pg) => pg.getViewport({ scale: 1 }));
    const r = stage.getBoundingClientRect();
    const cs = getComputedStyle(stage);
    const gap = nums.length > 1 ? parseFloat(getComputedStyle(spreadEl).columnGap) || 0 : 0;
    const availW = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - gap;
    const availH = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const sumW = sizes.reduce((a, s) => a + s.width, 0);
    const maxH = Math.max(...sizes.map((s) => s.height));
    const scale = Math.max(0.05, Math.min(availW / sumW, availH / maxH));
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    spreadEl.className = 'spread' + (dir ? (dir > 0 ? ' anim-next' : ' anim-prev') : '');
    const boxes = nums.map((p, i) => el('div', {
      class: 'pg',
      style: { width: Math.floor(sizes[i].width * scale) + 'px', height: Math.floor(sizes[i].height * scale) + 'px' },
    }));
    spreadEl.replaceChildren(...boxes);
    updateNav(nums);
    await Promise.all(nums.map(async (p, i) => {
      const sc = Math.min(scale * dpr, Math.sqrt(24_000_000 / (sizes[i].width * sizes[i].height)));
      try {
        const c = await renderCanvas(p, pages[i], sc);
        if (token !== V.token) return;
        const copy = document.createElement('canvas');
        copy.width = c.width; copy.height = c.height;
        copy.getContext('2d').drawImage(c, 0, 0);
        boxes[i].append(copy);
      } catch {
        if (token === V.token) boxes[i].append(el('div', { class: 'err', text: '這一頁無法顯示' }));
      }
    }));
    if (token === V.token) prefetch(scale * dpr);
  }

  // Warm the cache for the next spread so turning the page feels instant.
  async function prefetch(scale) {
    const n = nextStart(1);
    if (n > V.N) return;
    for (const p of visible(n)) {
      try { const pg = await getPage(p); await renderCanvas(p, pg, scale); } catch { /* ignore */ }
    }
  }

  function updateNav(nums) {
    const a = nums[0], b = nums[nums.length - 1];
    $('#plabel').textContent = (a === b ? `${a}` : `${a}–${b}`) + ` / ${V.N}`;
    $('#prevBtn').disabled = startOf(V.cur) <= 1;
    $('#nextBtn').disabled = nextStart(1) > V.N;
  }

  function goTo(p, dir) {
    const target = startOf(Math.max(1, Math.min(V.N, p)));
    if (target === startOf(V.cur)) return;
    V.cur = target;
    render(dir);
  }
  const turn = (d) => { const n = nextStart(d); if (n >= 1 && n <= V.N) goTo(n, d); };

  // ---------- page turning: buttons, edges, keys, swipe, wheel ----------
  $('#prevBtn').addEventListener('click', () => turn(-1));
  $('#nextBtn').addEventListener('click', () => turn(1));
  stage.addEventListener('click', (e) => {
    const x = e.clientX / window.innerWidth;
    if (x < 0.4) turn(-1); else if (x > 0.6) turn(1);
  });
  document.addEventListener('keydown', (e) => {
    if (!V.loaded || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); turn(1); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { e.preventDefault(); turn(-1); }
    else if (k === 'Home') { e.preventDefault(); goTo(1, -1); }
    else if (k === 'End') { e.preventDefault(); goTo(V.N, 1); }
  });
  let sx = null, sy = null;
  stage.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { sx = e.clientX; sy = e.clientY; } });
  stage.addEventListener('pointerup', (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = sy = null;
    if (Math.abs(dx) > 50 && Math.abs(dy) < 60) turn(dx < 0 ? 1 : -1);
  });
  let wheelAcc = 0, wheelLock = 0;
  stage.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;            // let the browser zoom
    e.preventDefault();
    const now = performance.now();
    if (now < wheelLock) return;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 80) { turn(wheelAcc > 0 ? 1 : -1); wheelAcc = 0; wheelLock = now + 280; }
  }, { passive: false });
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => render(), 120); });

  // ---------- loading ----------
  // The waiting card always says what is happening and for how long, and offers a way out.
  let stageText = '等待主頁面傳送檔案', stageStart = performance.now(), ticker = null, rescue = null;
  function setStage(text) {
    stageText = text;
    if (!ticker) {
      stageStart = performance.now();
      ticker = setInterval(paintStage, 1000);
      rescue = setTimeout(offerRescue, 25000);
    }
    paintStage();
  }
  function paintStage() {
    const secs = Math.round((performance.now() - stageStart) / 1000);
    const p = $('#waitBox .stage-text');
    if (p) p.textContent = `${stageText}…（${secs} 秒）`;
  }
  function stopStage() { clearInterval(ticker); clearTimeout(rescue); ticker = null; rescue = null; }
  function offerRescue() {
    if (!$('#waiting').hidden && $('#waitBox .stage-text')) {
      $('#waitBox').append(
        el('p', { class: 'muted', text: '等太久了？可以重試，或直接選檔案' }),
        el('div', { class: 'wait-actions' },
          el('button', { type: 'button', class: 'pick ghost', text: '重試', onclick: retry }),
          pickLabel()));
    }
  }
  function retry() {
    stopStage();
    V.loaded = false; V.out = null; V.origDocs = [];
    $('#waitBox').replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('p', { class: 'stage-text' }));
    setStage('等待主頁面傳送檔案');
    if (window.opener) { try { window.opener.postMessage({ type: 'viewer-ready' }, '*'); } catch { /* opener gone */ } }
  }

  async function load(d) {
    if (V.loaded) return;
    V.loaded = true;
    try {
      const title = d.title || 'PDF';
      document.title = `預覽：${title}${d.draft ? '（未壓縮）' : ''}`;
      V.sources = d.sources || null;
      V.pages = d.pages || null;
      setStage('讀取檔案');
      if (d.out) {
        const bytes = new Uint8Array(await d.out.arrayBuffer());
        setStage('開啟 PDF');
        V.out = await Core.openPdf(bytes, d.outPassword).promise;   // a password set in step 3, if any
        V.N = V.out.numPages;
      } else {
        if (!V.sources || !V.pages || !V.pages.length) throw new Error('沒有可預覽的頁面');
        V.N = V.pages.length;
        setStage('開啟 PDF');
        await origDoc(V.pages[0][0]);
      }
      stopStage();
      $('#waiting').hidden = true;
      V.cur = 1;
      render();
      stage.focus({ preventScroll: true });
    } catch (e) {
      stopStage();
      V.loaded = false;
      showPicker(Core.describeOpenError(e).message);
    }
  }

  function pickLabel() {
    const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', 'aria-label': '選擇要閱讀的 PDF' });
    input.addEventListener('change', () => {
      if (!input.files[0]) return;
      stopStage(); V.loaded = false;
      $('#waitBox').replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('p', { class: 'stage-text' }));
      load({ title: input.files[0].name, out: input.files[0] });
    });
    return el('label', { class: 'pick' }, '選擇 PDF', input);
  }
  function showPicker(msg) {
    stopStage();
    $('#waitBox').replaceChildren(
      el('p', { text: msg || '請回主頁面按「預覽」開啟' }),
      el('p', { text: '或直接選一個 PDF 閱讀' }),
      el('div', { class: 'wait-actions' }, window.opener ? el('button', { type: 'button', class: 'pick ghost', text: '重試', onclick: retry }) : null, pickLabel()));
    $('#waiting').hidden = false;
  }
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f && !V.loaded) load({ title: f.name, out: f });
  });

  window.addEventListener('message', (e) => {
    if (!window.opener || e.source !== window.opener) return;
    if (e.data && e.data.type === 'load') load(e.data);
  });
  if (window.opener) {
    setStage('等待主頁面傳送檔案');
    try { window.opener.postMessage({ type: 'viewer-ready' }, '*'); } catch { /* opener gone */ }
    setTimeout(() => { if (!V.loaded) showPicker('主頁面沒有回應，請重試'); }, 6000);
  } else {
    showPicker();
  }

  window.__viewer = V;
})();
