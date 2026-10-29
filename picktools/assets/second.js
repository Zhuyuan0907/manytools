/* 照片挑選's second window (/pick/second): every photo as a grid, for another screen — Lightroom's secondary display.
   It draws itself from what the pick tool's window says over a BroadcastChannel ('zt-pick'), so it outlives that
   window: closed or reloaded, this keeps its grid, and photos put in again (there, or in a new tab) show up here on
   their own. The thumbnails come over as copies, so they stay too. Clicks and keys go back to the window it follows.
   Only the cells on screen exist (thousands of photos). */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const num = (n) => n.toLocaleString('zh-TW');
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }
    n.append(...kids.filter((x) => x != null && x !== false));
    return n;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ORIENT = { 2: 'scaleX(-1)', 3: 'rotate(180deg)', 4: 'scaleY(-1)', 5: 'scaleX(-1) rotate(90deg)', 6: 'rotate(90deg)', 7: 'rotate(90deg) scaleX(-1)', 8: 'rotate(-90deg)' };
  const FILTER_NAME = { keep: '留用', none: '未標註旗標', drop: '排除' };
  if (!('BroadcastChannel' in window)) { $('sEmpty').textContent = '這個瀏覽器不能用副螢幕'; return; }
  const bc = new BroadcastChannel('zt-pick');

  let main = null, alive = false;   // the pick tool's window this follows (its id), and whether it's still open
  let mainUsed = 0;   // when that window was last used (two pick windows: the one used last wins)
  let list = [], flags = new Int8Array(0), pos = -1, sel = new Set(), counts = null, filter = 'all';
  const thumbs = new Map();   // key → { url, turn }
  const asked = new Set();
  let cell = 190;
  try { cell = clamp(+localStorage.getItem('zt-pick-second') || 190, 110, 420); } catch {}

  const grid = $('sGrid'), gin = $('sIn');
  let cols = 1, shownPos = -1;
  function draw(follow) {
    const W = grid.clientWidth - 12, H = grid.clientHeight;
    cols = Math.max(1, Math.floor(W / cell));
    const cw = W / cols, ch = Math.round(cw * 0.8) + 26;
    gin.style.height = `${Math.ceil(list.length / cols) * ch + 12}px`;
    if (follow && shownPos !== pos && pos >= 0) {
      // the photo you're on, kept in sight: out of sight, its row comes back to the middle; partly cut off (clicked
      // here, say), just enough to show it, so a double-click's second click lands on the same photo
      const y = 6 + Math.floor(pos / cols) * ch, t = grid.scrollTop;
      if (y + ch <= t || y >= t + H) grid.scrollTop = Math.max(0, y - (H - ch) / 2);
      else if (y < t) grid.scrollTop = y;
      else if (y + ch - 6 > t + H) grid.scrollTop = y + ch - 6 - H;
      shownPos = pos;
    }
    const t = grid.scrollTop, a = Math.max(0, (Math.floor(t / ch) - 1) * cols), b = Math.min(list.length, (Math.ceil((t + H) / ch) + 1) * cols);
    const kids = [], want = [];
    for (let i = a; i < b; i++) {
      const [k, name, dir] = list[i], f = flags[i], th = thumbs.get(k);
      if (!th && alive && !asked.has(k)) { asked.add(k); want.push(k); }
      const img = el('img', { alt: '', draggable: 'false', src: th ? th.url : null, style: th && ORIENT[th.turn] ? `transform: ${ORIENT[th.turn]}` : null });
      kids.push(el('div', { class: `c${f === 1 ? ' is-keep' : f === -1 ? ' is-drop' : ''}${i === pos ? ' cur' : ''}${sel.has(i) ? ' picked' : ''}`, 'data-i': i, 'data-k': k,
        title: dir ? `${name}・${dir}` : name, style: `left:${6 + (i % cols) * cw}px;top:${6 + Math.floor(i / cols) * ch}px;width:${cw - 6}px;height:${ch - 6}px` },
      el('span', { class: 'no', text: num(i + 1) }), el('span', { class: 'pic' }, img), el('span', { class: 'name', text: name })));
    }
    gin.replaceChildren(...kids);
    if (want.length && alive) bc.postMessage({ type: 'want', to: main, keys: want });
    bar();
  }
  function bar() {
    const it = list[pos];
    $('sPos').replaceChildren(...(it ? [el('b', { text: `第 ${num(pos + 1)}／${num(list.length)} 張` }), `・${it[1]}`] : [list.length ? `${num(list.length)} 張` : '副螢幕']),
      filter !== 'all' ? `（只看${FILTER_NAME[filter]}）` : '', sel.size > 1 ? `・選了 ${num(sel.size)} 張` : '');
    $('sCounts').replaceChildren(...(counts ? [el('span', { class: 'n-keep' }, el('i'), '留用 ', el('b', { text: num(counts.keep) })),
      el('span', {}, '未標註旗標 ', el('b', { text: num(counts.none) })), el('span', { class: 'n-drop' }, el('i'), '排除 ', el('b', { text: num(counts.drop) }))] : []));
    // nothing to show: no photos yet, or none in the filter chosen there
    const e = $('sEmpty');
    e.hidden = list.length > 0;
    if (!list.length) e.replaceChildren(...(filter !== 'all' && main ? [filter === 'none' ? '這裡的照片都標好了' : '這裡沒有照片'] : EMPTY));
    $('sState').hidden = alive || !list.length;
  }
  const EMPTY = [...$('sEmpty').childNodes];
  let queued = false, queuedFollow = false;
  const later = (follow) => {
    queuedFollow = queuedFollow || follow;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { const f = queuedFollow; queued = queuedFollow = false; draw(f); });
  };

  bc.onmessage = ({ data: m }) => {
    if (!m || !m.type) return;
    switch (m.type) {
      case 'list': {
        // a new set (or a new order, filter, folder): what it shows from now on, from the window used last
        if (main && alive && m.from !== main && (m.used || 0) < mainUsed) break;
        if (m.from !== main) { watch(m.from); mainUsed = 0; }
        main = m.from; alive = true; mainUsed = Math.max(mainUsed, m.used || 0);
        list = m.list; filter = m.filter;
        const keep = new Set(list.map((x) => x[0]));
        for (const [k, th] of thumbs) if (!keep.has(k)) { URL.revokeObjectURL(th.url); thumbs.delete(k); }
        asked.clear(); shownPos = -1; flags = new Int8Array(list.length); sel = new Set();
        later(true);
        break;
      }
      case 'state':
        if (m.from !== main || m.len !== list.length) return;
        alive = true; pos = m.pos; flags = m.flags; sel = new Set(m.sel); counts = m.counts; filter = m.filter;
        later(true);
        break;
      case 'thumbs':
        for (const t of m.list) {
          if (thumbs.has(t.k)) continue;
          thumbs.set(t.k, { url: URL.createObjectURL(t.blob), turn: t.turn });
          for (const n of gin.querySelectorAll(`[data-k="${CSS.escape(t.k)}"] img`)) { n.src = thumbs.get(t.k).url; n.style.transform = ORIENT[t.turn] || ''; }
        }
        break;
      case 'hello-main': bc.postMessage({ type: 'here' }); break;   // a pick tool page just opened: it should know we're here
      case 'bye': if (m.from === main) { alive = false; bar(); } break;
      case 'close': window.close(); break;
    }
  };
  // that window gone (closed, reloaded, crashed): it held a lock while it lived, and this gets it then
  function watch(id) {
    if (navigator.locks) navigator.locks.request(`zt-pick-main-${id}`, () => { if (main === id && alive) { alive = false; bar(); } }).catch(() => {});
  }
  // here: now, every couple of seconds (the pick tool's button shows it), and gone when closed. With it, the cells on
  // screen still without a thumbnail ask again (an ask can be dropped there when thousands are waiting)
  bc.postMessage({ type: 'hello' });
  setInterval(() => {
    bc.postMessage({ type: 'here' });
    if (!alive) return;
    const keys = [...gin.querySelectorAll('.c')].map((c) => c.dataset.k).filter((k) => !thumbs.has(k));
    if (keys.length) bc.postMessage({ type: 'want', to: main, keys });
  }, 2000);
  addEventListener('pagehide', () => bc.postMessage({ type: 'gone' }));

  grid.addEventListener('scroll', () => later(false), { passive: true });
  addEventListener('resize', () => { shownPos = -1; later(true); });   // a new number of columns: the photo you're on kept in sight
  const tell = (msg) => { if (alive) bc.postMessage({ ...msg, to: main }); };
  grid.addEventListener('click', (e) => { const c = e.target.closest('.c'); if (c) tell({ type: 'go', i: +c.dataset.i }); });
  grid.addEventListener('dblclick', (e) => { if (e.target.closest('.c')) tell({ type: 'loupe' }); });
  const size = (k) => { cell = clamp(Math.round(cell * k), 110, 420); try { localStorage.setItem('zt-pick-second', String(cell)); } catch {} shownPos = -1; draw(true); };
  const full = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else document.documentElement.requestFullscreen().catch(() => {}); };
  $('sSmaller').addEventListener('click', () => size(1 / 1.2));
  $('sBigger').addEventListener('click', () => size(1.2));
  $('sFull').addEventListener('click', full);
  if (!document.fullscreenEnabled) $('sFull').hidden = true;
  // keys work as they do in the pick tool; ↑ ↓ (Shift too) move a row of this grid; F, − and + are this window's own;
  // ? isn't sent (the shortcuts would open over there, behind this)
  addEventListener('keydown', (e) => {
    const k = e.key, plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (plain && (k === 'f' || k === 'F')) { e.preventDefault(); full(); return; }
    if (plain && (k === '-' || k === '+' || k === '=')) { e.preventDefault(); size(k === '-' ? 1 / 1.2 : 1.2); return; }
    if (plain && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); if (list.length && pos >= 0) tell({ type: 'go', i: clamp(pos + (k === 'ArrowUp' ? -cols : cols), 0, list.length - 1) }); return; }
    if (k === '?' || k === 'Tab' || k === 'Escape' && document.fullscreenElement || (e.metaKey || e.ctrlKey) && !/^[zZ]$/.test(k)) return;
    if (k.length === 1 || /^(Arrow|Page|Home|End|Delete|Backspace|Enter|Escape)/.test(k)) {
      e.preventDefault();
      tell({ type: 'key', key: k, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, caps: !!(e.getModifierState && e.getModifierState('CapsLock')) });
    }
  });
  draw(false);
})();
