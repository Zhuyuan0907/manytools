/* ZhuyuanLoveCut — a video editor in the browser, made after Adobe Premiere Pro's Editing workspace: for cutting the
   parts worth keeping out of a dashcam's recordings (and anything else), joining them, and saving an MP4.
   Three modes as Premiere's header has them: 匯入 (put files in) → 編輯 (the workspace: 來源 and 節目 monitors, the
   專案 panel, 工具, the 時間軸 with V1–V3 / A1–A3, 音訊錶) → 匯出. Premiere's tools, keys and words: 選取 V, 向前軌道
   選取 A, 波紋編輯 B, 滾動編輯 N, 比率伸縮 R, 剃刀 C, 外滑 Y, 內滑 U, 手形 H, 縮放 Z, 文字 T; I / O, 插入 , 覆蓋 .,
   提取 ; 擷取 ', ⌘K, 波紋刪除, J K L, 靠齊, 連結的選取, 效果控制項 (運動, 不透明度, 速度, 音量), 速度/持續時間.
   Media are read with Mediabunny (engine.js) and played by the browser's own <video> / <audio> elements, one pair per
   track, kept in step with one clock (a video they can't play as it is, a dashcam's .TS, is first copied into an MP4
   that they can, in a worker); the sound goes through Web Audio (volume, mute, solo, the meters). The film is
   made by engine.js: copied as it is when it can be (one camera's clips), else drawn and encoded frame by frame.
   The project is kept in this browser (IndexedDB) without the files: put the same files in again and the clips come
   back (Premiere's offline media and relinking). Nothing is uploaded; on a server only the count of films saved is. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    n.append(...kids.filter((x) => x != null && x !== false));
    return n;
  };
  const fill = (n, ...kids) => n.replaceChildren(...kids.filter((x) => x != null && x !== false));
  const svgUse = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#${id}`); s.append(u); return s; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const fmtClock = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };
  const pad2 = (n) => String(n).padStart(2, '0');
  const onServer = /^https?:$/.test(location.protocol);
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const ON_PHONE = matchMedia('(pointer: coarse) and (max-width: 600px), (pointer: coarse) and (orientation: landscape) and (max-height: 500px)').matches;
  const CAN_SAVE = typeof window.showSaveFilePicker === 'function';
  const E = window.CutEngine;
  if (onServer) { $('#brand').href = '/'; $('#pnBack').href = '/'; }
  let toastTimer = 0;
  function toast(msg, ms = 2800) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  if (ON_PHONE) {
    document.body.classList.add('is-phone');
    $('#phoneNote').hidden = false; $('#ws').hidden = true;
  }
  // Safari: after a drag and drop, the next press comes as a mousedown with no pointerdown (the pointer still thought
  // down from the drag), and the click would be lost — the pointerdown made up from the mousedown (and a capture that
  // can't be had then is no reason to fail the press over). Not for the mousedown a tap makes after its own pointer events.
  let lastPointerDown = -1e9, lastTouch = -1e9;
  addEventListener('pointerdown', (e) => { lastPointerDown = e.timeStamp; if (e.pointerType !== 'mouse') lastTouch = e.timeStamp; }, true);
  addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') lastTouch = e.timeStamp; }, true);
  addEventListener('mousedown', (e) => {
    if (Math.abs(e.timeStamp - lastPointerDown) < 100 || e.timeStamp - lastTouch < 1500) return;
    const pe = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, button: e.button, buttons: e.buttons, detail: e.detail, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
    if (!e.target.dispatchEvent(pe)) e.preventDefault();
  }, true);
  const setCapture = Element.prototype.setPointerCapture;
  Element.prototype.setPointerCapture = function (id) { try { setCapture.call(this, id); } catch {} };

  // ---------- time ----------
  // A sequence counts frames: its rate as a fraction (29.97 is 30000/1001), clips start and last whole frames. Timecode
  // as Premiere writes it: drop-frame with semicolons for 29.97 and 59.94 (00;00;00;03), else colons.
  const RATES = [[23.976, 24000, 1001], [24, 24, 1], [25, 25, 1], [29.97, 30000, 1001], [30, 30, 1], [50, 50, 1], [59.94, 60000, 1001], [60, 60, 1], [120, 120, 1]];
  function rateOf(fps) {
    let best = RATES[4], d = 1e9;
    for (const r of RATES) { const x = Math.abs(r[0] - fps); if (x < d) { d = x; best = r; } }
    return d < 0.6 ? { num: best[1], den: best[2] } : { num: Math.max(1, Math.round(fps)), den: 1 };
  }
  const fpsOf = (r) => r.num / r.den;
  function tcOf(frames, r) {
    frames = Math.max(0, Math.round(frames));
    const fps = fpsOf(r), nom = Math.round(fps), drop = r.den === 1001 && (nom === 30 || nom === 60) ? (nom === 60 ? 4 : 2) : 0;
    let f = frames;
    if (drop) {
      const per10 = nom * 600 - drop * 9, perMin = nom * 60 - drop, d = Math.floor(f / per10), m = f % per10;
      f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0);
    }
    const ff = f % nom, ss = Math.floor(f / nom) % 60, mm = Math.floor(f / (nom * 60)) % 60, hh = Math.floor(f / (nom * 3600));
    const sep = drop ? ';' : ':';
    return `${pad2(hh)}${sep}${pad2(mm)}${sep}${pad2(ss)}${sep}${pad2(ff)}`;
  }
  // typed timecode → frames ("1;02;03" is 1 minute 2 seconds 3 frames; one number alone is frames)
  function framesOfTc(text, r) {
    const parts = String(text).trim().split(/[:;.,]/).filter((x) => x !== '').map(Number);
    if (!parts.length || parts.some((x) => !Number.isFinite(x) || x < 0)) return null;
    const nom = Math.round(fpsOf(r));
    while (parts.length < 4) parts.unshift(0);
    const [h, m, s, f] = parts.slice(-4);
    const nominal = ((h * 60 + m) * 60 + s) * nom + f;
    if (r.den === 1001 && (nom === 30 || nom === 60)) { const drop = nom === 60 ? 4 : 2, mins = h * 60 + m; return nominal - drop * (mins - Math.floor(mins / 10)); }
    return nominal;
  }

  // ---------- the project ----------
  // media: { id, key, file, name, size, mod, kind ('video' | 'audio' | 'still'), info (engine.probe), dur (s), w, h,
  //          rate, hasV, hasA, url, poster (canvas), peaks, hover (frames for scrubbing), off (no file), cant (this
  //          browser can't show it), conv (0–1 while an MP4 it can show is made of it, else null), mp4 (that MP4, used
  //          from then on: url and info are its), kept (the MP4 is in the browser's private files), from (the file's
  //          own format, when it plays as an MP4), srcIn / srcOut (the 來源 monitor's marks, s) }
  // seq:   { name, rate, w, h, clips, markers, in, out (frames | null), tracks: { V1: { lock, out, sync }, A1: { lock,
  //          mute, solo, sync } … }, targets (track names), patch: { v, a } }
  // clip:  { id, mid, track, start, dur (frames), in (s, into the media), speed (1 = 100%), link (the clip of the same
  //          take on the other kind of track), off (disabled), fit (scaled to the frame), pitch (keep the voice's pitch
  //          when faster or slower), fx: { x, y (its centre, in the sequence's pixels), scale, rot, opacity, vol (dB) },
  //          text: { value, size, color } for a title }
  const VT = ['V1', 'V2', 'V3'], AT = ['A1', 'A2', 'A3'], ALL_T = [...VT, ...AT];
  const P = { name: '未命名', media: [], seq: null, n: 0, seqN: 0 };
  const S = { mode: 'import', focus: 'tl', tool: 'sel', sel: new Set(), snap: true, link: true, thumbs: true, waves: true, prjView: 'icons', prjSel: new Set(), srcMedia: null, clipboard: null };
  const uid = () => `${Date.now().toString(36)}${(P.n++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const mediaById = (id) => P.media.find((m) => m.id === id) || null;
  const clipById = (id) => (P.seq ? P.seq.clips.find((c) => c.id === id) || null : null);
  const isV = (t) => t[0] === 'V';
  const fr2s = (f, r = P.seq.rate) => (f * r.den) / r.num;
  const s2fr = (s, r = P.seq.rate) => Math.round((s * r.num) / r.den);
  const cEnd = (c) => c.start + c.dur;
  const defaultFx = (seq) => ({ x: seq.w / 2, y: seq.h / 2, scale: 100, rot: 0, opacity: 100, vol: 0 });
  const seqEnd = () => (P.seq ? P.seq.clips.reduce((e, c) => Math.max(e, cEnd(c)), 0) : 0);
  // how long the clip's media lets it be at its speed (stills and titles: as long as wanted)
  function mediaRoom(c) {
    const m = mediaById(c.mid);
    if (!m || m.kind === 'still' || c.text) return { before: Infinity, after: Infinity };
    const used = fr2s(c.dur) * c.speed;
    return { before: c.in / c.speed, after: Math.max(0, m.dur - c.in - used) / c.speed };
  }

  function newSeq(m) {
    const rate = m && m.rate ? m.rate : { num: 30, den: 1 }, w = m && m.w ? m.w : 1920, h = m && m.h ? m.h : 1080;
    const seq = { name: `序列 ${pad2(++P.seqN)}`, rate, w: w - (w % 2), h: h - (h % 2), clips: [], markers: [], in: null, out: null, tracks: {}, targets: ['V1', 'A1'], patch: { v: 'V1', a: 'A1' } };
    for (const t of VT) seq.tracks[t] = { lock: false, out: true, sync: true };
    for (const t of AT) seq.tracks[t] = { lock: false, mute: false, solo: false, sync: true };
    P.seq = seq;
    S.sel.clear();
    PH.frame = 0;
    return seq;
  }

  // ---------- undo: the sequence as it was before each change ----------
  const H = { undo: [], redo: [], before: null, label: '' };
  const snapSeq = () => (P.seq ? JSON.parse(JSON.stringify({ ...P.seq, targets: [...P.seq.targets] })) : null);
  function begin(label) { H.before = snapSeq(); H.label = label; }
  function commit(label) {
    if (P.seq) relinkCuts();
    if (!H.before && !label) return;
    H.undo.push({ label: label || H.label, seq: H.before, at: Date.now() });
    if (H.undo.length > 200) H.undo.shift();
    H.redo.length = 0;
    H.before = null;
    changed();
  }
  function doUndo() {
    const u = H.undo.pop();
    if (!u) { toast('沒有可以復原的'); return; }
    H.redo.push({ label: u.label, seq: snapSeq() });
    P.seq = u.seq;
    afterHistory(); toast(`復原：${u.label}`, 1600);
  }
  function doRedo() {
    const r = H.redo.pop();
    if (!r) { toast('沒有可以重做的'); return; }
    H.undo.push({ label: r.label, seq: snapSeq() });
    P.seq = r.seq;
    afterHistory(); toast(`重做：${r.label}`, 1600);
  }
  function afterHistory() {
    for (const id of [...S.sel]) if (!clipById(id)) S.sel.delete(id);
    changed();
  }
  // something changed: everything that shows the sequence, and the save
  function changed() {
    renderTimeline(); renderPrjName(); PL.refresh(); renderFx(); renderInfo(); renderMarks(); renderHist(); renderTabs(); keepLater();
    $('#projDirty').hidden = false;
  }

  // ---------- kept in this browser ----------
  const db = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('zt-cut', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    return {
      async get(k) { const d = await open(); return new Promise((res) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); },
      async put(k, v) { const d = await open(); return new Promise((res) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = tx.onerror = tx.onabort = () => res(); }); },
      async del(k) { const d = await open(); return new Promise((res) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = tx.onerror = tx.onabort = () => res(); }); },
    };
  })();
  let keepTimer = 0;
  function keepLater() { clearTimeout(keepTimer); keepTimer = setTimeout(keepNow, 800); }
  function keepNow() {
    const media = P.media.map((m) => ({ id: m.id, key: m.key, name: m.name, size: m.size, mod: m.mod, kind: m.kind, dur: m.dur, w: m.w, h: m.h, rate: m.rate, hasV: m.hasV, hasA: m.hasA, from: m.from, srcIn: m.srcIn, srcOut: m.srcOut }));
    db.put('project', { v: 1, name: P.name, seqN: P.seqN, media, seq: P.seq, at: Date.now() }).catch(() => {});
  }
  async function restore() {
    let p = null;
    try { p = await db.get('project'); } catch {}
    if (!p || !p.media || !p.media.length) return false;
    P.name = p.name || '未命名'; P.seqN = p.seqN || 0;
    P.media = p.media.map((m) => ({ ...m, file: null, info: null, url: null, poster: null, peaks: null, off: true, conv: null, mp4: null, kept: false }));
    P.seq = p.seq || null;
    return true;
  }

  // ---------- 匯入 ----------
  const KIND = (f) => (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name) ? 'still' : /^audio\//.test(f.type) || /\.(mp3|m4a|wav|aac|flac|ogg|opus)$/i.test(f.name) ? 'audio' : 'video');
  const keyOf = (f) => `${f.name}|${f.size}|${f.lastModified}`;
  let reading = 0;
  function readingNote(text) {
    $('#impReading').hidden = !text;
    if (text) $('#impReadingText').textContent = text;
  }
  // does this browser play it (a dashcam's H.265 doesn't play everywhere). Preload auto: Safari loads nothing at all
  // for a 'metadata' element that isn't in the page; where only the metadata comes (iPad), a second after it will do —
  // a format the browser can't play fails with an error straight away
  function canPlay(m, tries = m.info && m.info.video && m.info.video.canDecode ? 3 : 1) {
    return new Promise((ok) => {
      const v = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
      let done = false;
      const end = (r) => { if (done) return; done = true; v.removeAttribute('src'); v.load(); ok(r); };
      v.muted = true; v.preload = 'auto';
      v.onloadeddata = () => end(m.kind === 'audio' || v.videoWidth > 0);
      v.onloadedmetadata = () => setTimeout(() => end(m.kind === 'audio' || v.videoWidth > 0), 1000);
      // (tried again after an error when the browser can decode the video: its first ones can fail as its player starts up)
      v.onerror = () => { if (done) return; done = true; v.removeAttribute('src'); v.load(); if (tries > 1) setTimeout(() => canPlay(m, tries - 1).then(ok), 500 * (4 - tries)); else ok(false); };
      setTimeout(() => end(!v.error && (v.readyState === 0 || m.kind === 'audio' || v.videoWidth > 0)), 5000);
      v.src = m.url;
    });
  }
  async function importFiles(files) {
    files = [...files].filter((f) => f && f.size > 0);
    if (!files.length) return;
    reading++;
    let added = 0, relinked = 0, bad = [];
    const fresh = [];
    for (const [i, f] of files.entries()) {
      readingNote(`正在讀取 ${i + 1}／${files.length}：${f.name}`);
      // (an offline item is relinked by name, size and date; by name and size when the date differs, as a copy's may)
      const key = keyOf(f), old = P.media.find((m) => m.key === key) || P.media.find((m) => m.off && m.name === f.name && m.size === f.size);
      if (old && !old.off) continue;
      if (old) { old.key = key; old.mod = f.lastModified; }
      const m = old || { id: uid(), key, name: f.name, size: f.size, mod: f.lastModified, kind: KIND(f), srcIn: null, srcOut: null };
      m.file = f; m.url = URL.createObjectURL(f); m.off = false;
      try {
        if (m.kind === 'still') {
          const bmp = await createImageBitmap(f);
          m.w = bmp.width; m.h = bmp.height; m.dur = 5; m.hasV = true; m.hasA = false; m.bitmap = bmp;
          const c = document.createElement('canvas'), k = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
          c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          m.poster = c;
        } else {
          const info = await E.probe(f);
          if (!info) throw new Error('unreadable');
          m.info = info; m.dur = info.duration;
          m.hasV = !!info.video; m.hasA = !!info.audio;
          if (!m.hasV) m.kind = 'audio';
          if (m.hasV) { m.w = info.video.width; m.h = info.video.height; m.rate = rateOf(info.video.fps); }
          // a dashcam's .TS no browser plays as it is (nor every browser an MKV): when its pictures can be decoded,
          // an MP4 that plays is made of it after this (convertLater)
          m.cant = /transport/i.test(info.format) || !(await canPlay(m));
          m.conv = m.cant && m.hasV && info.video.canDecode && !/^(MP4|QuickTime)/i.test(info.format) ? 0 : null;
          m.from = m.mp4 = null; m.kept = false;
          if (m.hasV && info.video.canDecode) m.poster = await E.thumb(info, Math.min(1, m.dur / 3), 320).catch(() => null);
        }
      } catch (e) {
        console.error(e);
        bad.push(f.name);
        if (!old) { URL.revokeObjectURL(m.url); continue; }
      }
      if (old) relinked++; else { P.media.push(m); added++; }
      fresh.push(m);
    }
    reading--;
    readingNote('');
    renderPrj();
    if (bad.length) toast(`讀不到：${bad.slice(0, 3).join('、')}${bad.length > 3 ? ` 等 ${bad.length} 個` : ''}`, 5000);
    else if (relinked && !added) toast(`接回 ${relinked} 個離線的媒體`);
    else if (added) toast(`匯入 ${added} 個項目${relinked ? `・接回 ${relinked} 個` : ''}`);
    const cants = fresh.filter((m) => m.cant && m.conv == null), convs = fresh.filter((m) => m.conv != null);
    if (cants.length) toast(`這個瀏覽器不能播放「${cants[0].name}」（${(cants[0].info && cants[0].info.video && cants[0].info.video.codec || '').toUpperCase() || '這種格式'}）：可以用 Safari 或 Edge 打開，或仍然直接輸出`, 7000);
    else if (convs.length) toast(`瀏覽器不能直接播放${convs.length > 1 ? `這 ${convs.length} 支${convs.every((m) => /transport/i.test(m.info.format)) ? ' TS ' : ''}影片` : `「${convs[0].name}」`}，正在轉成 MP4（畫面和聲音照原檔，不重新壓縮）`, 6000);
    for (const m of convs) convertLater(m);
    // the sound's shape for the waveforms, in the background (a converted video's: from its MP4, when it's made)
    for (const m of fresh) if (m.hasA && !m.peaks && m.info && m.conv == null) wave(m);
    if (fresh.length && S.mode === 'import') setMode('edit');
    keepLater(); renderTimeline(); PL.refresh(); renderTabs();
  }
  const wave = (m) => E.peaks(m.info, 100).then((pk) => { m.peaks = pk; renderTimeline(); if (S.srcMedia === m) SRC.drawWave(); }).catch(() => {});
  // A video the browser can't play as it is (a dashcam's .TS): its packets copied into an MP4 that it can (E.remux, in
  // a worker), one video at a time, its progress on its item. The MP4 is what's played, shown and made into the film
  // from then on — the same pictures and sound. Kept in the browser's private files where it can be, so the video is
  // back by itself next time; taken away with the video
  const CONV = { queue: [], cur: null, hooks: null };
  const pctOf = (m) => `${Math.floor((m.conv || 0) * 100)}%`;
  const slateName = (m) => (!m ? '' : m.conv != null ? `${m.name}・${pctOf(m)}` : m.name);
  function convertLater(m) { if (CONV.cur !== m && !CONV.queue.includes(m)) CONV.queue.push(m); convertNext(); }
  async function convertNext() {
    if (CONV.cur || !CONV.queue.length) return;
    const m = CONV.cur = CONV.queue.shift(), name = `${m.id}.mp4`;
    CONV.hooks = { progress: (p) => { m.conv = p; paintConv(m); } };
    try {
      const r = await E.remux(m.file, name, CONV.hooks);
      if (mediaById(m.id) !== m) { if (r.disk) E.unkeep(name); return; }
      if (r.dropped.length) console.warn('轉成 MP4 時沒有帶過去：', r.dropped);
      await useMp4(m, r.file, r.disk);
    } catch (e) {
      if (!(e && e.canceled) && mediaById(m.id) === m) {
        console.error(e);
        m.conv = null; renderPrj(); PL.refresh(); renderMeta(); if (S.srcMedia === m) SRC.open(m, true);
        toast(`「${m.name}」沒辦法轉成 MP4，這個瀏覽器不能預覽它（仍然可以直接輸出）`, 6000);
      }
    } finally { CONV.cur = null; CONV.hooks = null; convertNext(); }
  }
  function stopConverting(ms) {
    CONV.queue = CONV.queue.filter((m) => !ms.includes(m));
    if (CONV.cur && ms.includes(CONV.cur) && CONV.hooks && CONV.hooks.cancel) CONV.hooks.cancel();
  }
  // the MP4 in use from now on
  async function useMp4(m, file, kept) {
    const info = await E.probe(file);
    if (!info || !info.video) throw new Error('unreadable MP4');
    m.off = false;
    if (m.url) URL.revokeObjectURL(m.url);
    if (!m.from) m.from = (m.info && m.info.format) || 'MPEG Transport Stream';
    m.mp4 = file; m.kept = kept; m.url = URL.createObjectURL(file); m.info = info; m.dur = info.duration; m.hasA = !!info.audio; m.hover = null;
    m.cant = !(await canPlay(m));
    // (a browser that won't play it from its private files plays a copy of it in memory)
    if (m.cant && kept) { URL.revokeObjectURL(m.url); m.url = URL.createObjectURL(new Blob([await file.arrayBuffer()], { type: 'video/mp4' })); m.cant = !(await canPlay(m)); }
    m.conv = null;
    if (!m.poster && info.video.canDecode) m.poster = await E.thumb(info, Math.min(1, m.dur / 3), 320).catch(() => null);
    if (m.hasA && !m.peaks) wave(m);
    renderPrj(); renderTimeline(); PL.refresh(); renderMeta(); keepLater();
    if (S.srcMedia === m) SRC.open(m, true);
    if (S.mode === 'export' && P.seq && !EX.running) refreshExport(false);
  }
  // its progress where it shows: its item, the monitors' notes
  function paintConv(m) {
    for (const n of $$(`[data-id="${m.id}"] .pi-conv`, prjItems)) { n.style.setProperty('--p', pctOf(m)); n.textContent = `轉換中 ${pctOf(m)}`; }
    for (const n of $$(`[data-id="${m.id}"] .pl-conv`, prjItems)) n.textContent = mediaLine(m);
    if (PL.slateM === m) $('#prgOfflineName').textContent = slateName(m);
    if (SRC.m === m) { const s = $('#srcSlate span'); if (s) s.textContent = slateName(m); }
    if (S.srcMedia === m || (S.prjSel.size === 1 && S.prjSel.has(m.id))) renderMeta();
  }
  const fileIn = $('#fileIn');
  const pickFiles = () => fileIn.click();
  fileIn.addEventListener('change', () => { const fs = [...fileIn.files]; fileIn.value = ''; importFiles(fs); });
  $('#impPick').addEventListener('click', (e) => { e.stopPropagation(); pickFiles(); });
  $('#impDrop').addEventListener('click', pickFiles);
  $('#impDrop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles(); } });
  $('#prjImport').addEventListener('click', pickFiles);
  // files dropped anywhere: imported (onto the timeline: placed there too)
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e) || ON_PHONE) return; dragDepth++; $('#dropcover').hidden = !!e.target.closest('#tlTracks') || S.mode === 'export'; });
  addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropcover').hidden = true; });
  addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); $('#dropcover').hidden = !!e.target.closest('#tlTracks') || S.mode === 'export'; } });
  addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#dropcover').hidden = true;
    if (S.mode === 'export' || ON_PHONE) return;
    const files = [...e.dataTransfer.files], onTl = e.target.closest('#tlTracks');
    const at = onTl ? dropFrame(e) : null;
    await importFiles(files);
    if (onTl) {
      const ms = files.map((f) => P.media.find((m) => m.key === keyOf(f))).filter((m) => m && !m.off);
      if (ms.length) placeMedia(ms.filter(Boolean), at, null, 'overwrite', '匯入到時間軸');
    }
  });

  // ---------- 專案 panel ----------
  const prjItems = $('#prjItems');
  const labelOf = (m) => (m.kind === 'still' ? 'var(--c-still)' : m.kind === 'audio' ? 'var(--c-audio)' : 'var(--c-video)');
  function mediaLine(m) {
    if (m.off) return '離線';
    if (m.conv != null) return `轉換中 ${pctOf(m)}`;
    if (m.kind === 'still') return `${m.w}×${m.h}`;
    const v = m.info && m.info.video;
    return [v ? `${m.w}×${m.h}` : '', v ? `${(Math.round(fpsOf(m.rate) * 100) / 100)} fps` : '', m.hasA ? '有聲音' : ''].filter(Boolean).join('・');
  }
  function renderPrj() {
    const q = $('#prjSearch').value.trim().toLowerCase(), list = P.media.filter((m) => !q || m.name.toLowerCase().includes(q));
    for (const id of [...S.prjSel]) if (!mediaById(id)) S.prjSel.delete(id);
    $('#prjCount').textContent = S.prjSel.size ? `已選取 ${S.prjSel.size} 個項目，共 ${P.media.length} 個` : `${P.media.length} 個項目`;
    $('#prjDelete').disabled = !S.prjSel.size;
    prjItems.className = `prj-items ${S.prjView}`;
    if (!P.media.length) {
      fill(prjItems, el('div', { class: 'prj-empty' }, el('b', { text: '匯入媒體以開始' }), el('span', { text: '把影片拖到這裡，或在這裡按兩下' })));
      return;
    }
    const dur = (m) => (m.kind === 'still' ? '' : m.rate ? tcOf(Math.round(m.dur * fpsOf(m.rate)), m.rate) : fmtClock(m.dur));
    if (S.prjView === 'list') {
      fill(prjItems, el('div', { class: 'pl-head' }, el('span', { text: '名稱' }), el('span', { text: '影格速率' }), el('span', { text: '媒體持續時間' }), el('span', { text: '影片資訊' })),
        ...list.map((m) => el('div', { class: `pl-row${S.prjSel.has(m.id) ? ' sel' : ''}${m.off ? ' off' : ''}`, 'data-id': m.id, draggable: m.off ? null : 'true', title: m.name },
          el('span', { class: 'pl-name', style: `--c:${labelOf(m)}` }, el('i'), m.name), el('span', { text: m.rate ? `${Math.round(fpsOf(m.rate) * 100) / 100} fps` : '' }),
          el('span', { text: dur(m) }), el('span', { class: m.conv != null ? 'pl-conv' : null, text: mediaLine(m) }))));
      return;
    }
    fill(prjItems, ...list.map((m) => {
      const pic = el('div', { class: 'pi-pic' });
      if (m.poster) { const c = document.createElement('canvas'); c.width = m.poster.width; c.height = m.poster.height; c.getContext('2d').drawImage(m.poster, 0, 0); pic.append(c); }
      else if (m.kind === 'audio') pic.append(Object.assign(svgUse('i-aud'), { classList: 'pi-aud' }));
      pic.append(el('span', { class: 'pi-badge', style: `--c:${labelOf(m)}` }));
      if (m.kind !== 'still') pic.append(el('span', { class: 'pi-dur', text: dur(m) }));
      if (m.conv != null) pic.append(el('span', { class: 'pi-conv', style: `--p:${pctOf(m)}`, text: `轉換中 ${pctOf(m)}` }));
      return el('div', { class: `pi${S.prjSel.has(m.id) ? ' sel' : ''}${m.off ? ' off' : ''}${m.cant && m.conv == null ? ' cant' : ''}`, 'data-id': m.id, draggable: m.off ? null : 'true', title: `${m.name}\n${mediaLine(m)}` }, pic, el('span', { class: 'pi-name', text: m.name }));
    }));
  }
  $('#prjSearch').addEventListener('input', renderPrj);
  $('#prjIconsV').addEventListener('click', () => { S.prjView = 'icons'; $('#prjIconsV').classList.add('on'); $('#prjListV').classList.remove('on'); renderPrj(); });
  $('#prjListV').addEventListener('click', () => { S.prjView = 'list'; $('#prjListV').classList.add('on'); $('#prjIconsV').classList.remove('on'); renderPrj(); });
  $('#prjZoom').addEventListener('input', (e) => { prjItems.style.setProperty('--tile', `${e.target.value}px`); });
  // a click selects (the items keep their place, so a double-click still lands on the same one)
  function paintPrjSel() {
    for (const n of $$('[data-id]', prjItems)) n.classList.toggle('sel', S.prjSel.has(n.dataset.id));
    $('#prjCount').textContent = S.prjSel.size ? `已選取 ${S.prjSel.size} 個項目，共 ${P.media.length} 個` : `${P.media.length} 個項目`;
    $('#prjDelete').disabled = !S.prjSel.size;
  }
  prjItems.addEventListener('click', (e) => {
    const it = e.target.closest('[data-id]');
    if (!it) { S.prjSel.clear(); paintPrjSel(); return; }
    const id = it.dataset.id;
    if (e.shiftKey || e.metaKey || e.ctrlKey) { if (S.prjSel.has(id)) S.prjSel.delete(id); else S.prjSel.add(id); }
    else { S.prjSel.clear(); S.prjSel.add(id); }
    paintPrjSel(); renderMeta();
  });
  prjItems.addEventListener('dblclick', (e) => {
    const it = e.target.closest('[data-id]');
    if (!it) { pickFiles(); return; }
    const m = mediaById(it.dataset.id);
    if (m && m.off) { toast('這個媒體離線了：把同一個檔案再匯入一次就會接回來'); pickFiles(); return; }
    if (m) SRC.open(m);
  });
  // hovering a thumbnail scrubs through the clip, as Premiere's icon view does
  prjItems.addEventListener('pointermove', (e) => {
    const pic = e.target.closest('.pi-pic'), it = pic && pic.closest('[data-id]');
    if (!it || e.buttons) return;
    const m = mediaById(it.dataset.id);
    if (!m || m.off || m.conv != null || m.kind !== 'video' || !m.info || !m.info.video.canDecode) return;
    const r = pic.getBoundingClientRect(), x = clamp((e.clientX - r.left) / r.width, 0, 0.999);
    if (!m.hover) {
      m.hover = [];
      const N = 24, times = Array.from({ length: N }, (_, i) => (m.dur * (i + 0.5)) / N);
      E.thumbs(m.info, times, 90, (i, c) => { m.hover[i] = c; }).catch(() => {});
    }
    const c = m.hover[Math.floor(x * 24)], cv = pic.querySelector('canvas');
    if (c && cv) { cv.width = c.width; cv.height = c.height; cv.getContext('2d').drawImage(c, 0, 0); }
  });
  // (the poster frame back when the pointer leaves)
  prjItems.addEventListener('pointerleave', () => {
    for (const n of $$('.pi[data-id]', prjItems)) { const m = mediaById(n.dataset.id), cv = n.querySelector('canvas'); if (m && m.poster && cv) { cv.width = m.poster.width; cv.height = m.poster.height; cv.getContext('2d').drawImage(m.poster, 0, 0); } }
  });
  prjItems.addEventListener('dragstart', (e) => {
    const it = e.target.closest('[data-id]');
    if (!it) return;
    const id = it.dataset.id;
    if (!S.prjSel.has(id)) { S.prjSel.clear(); S.prjSel.add(id); paintPrjSel(); }
    DRAG.media = [...S.prjSel].map(mediaById).filter((m) => m && !m.off);
    DRAG.only = null; DRAG.range = null;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', DRAG.media.map((m) => m.name).join('\n'));
  });
  prjItems.addEventListener('dragend', () => { DRAG.media = null; endDropGhost(); });
  function removeMedia(ids) {
    const used = P.seq ? P.seq.clips.filter((c) => ids.includes(c.mid)) : [];
    if (used.length && !confirm(`時間軸上有 ${used.length} 個剪輯用到這些項目，會一起拿掉。要清除嗎？`)) return;
    if (used.length) { begin('清除'); P.seq.clips = P.seq.clips.filter((c) => !ids.includes(c.mid)); commit(); }
    const gone = ids.map(mediaById).filter(Boolean);
    stopConverting(gone);
    for (const m of gone) { if (S.srcMedia === m) SRC.close(); if (m.url) URL.revokeObjectURL(m.url); if (m.kept) E.unkeep(`${m.id}.mp4`); }
    P.media = P.media.filter((m) => !ids.includes(m.id));
    S.prjSel.clear();
    renderPrj(); keepLater(); renderTimeline(); PL.refresh();
  }
  $('#prjDelete').addEventListener('click', () => removeMedia([...S.prjSel]));
  function renderPrjName() {
    $('#prjTabName').textContent = `專案：${P.name}`;
    $('#prjFile').textContent = `${P.name}.prproj`;
    $('#projName').textContent = P.name;
  }

  // ---------- monitors: the frame as big as fits (or a zoom level), the mini ruler ----------
  const fitScale = (view, w, h) => Math.min(Math.max(40, view.clientWidth - 8) / w, Math.max(30, view.clientHeight - 8) / h);
  // (zoomed in, the point of the picture under `at` — the view's middle unless a pinch says where — stays where it is)
  function fitFrame(view, frame, w, h, zoom, at) {
    const vw = Math.max(40, view.clientWidth - 8), vh = Math.max(30, view.clientHeight - 8);
    const s = zoom === 'fit' ? fitScale(view, w, h) : +zoom / 100;
    const vb = view.getBoundingClientRect(), fb = frame.getBoundingClientRect();
    const ax = at ? at.x : vb.left + view.clientWidth / 2, ay = at ? at.y : vb.top + view.clientHeight / 2;
    const rx = fb.width ? (ax - fb.left) / fb.width : 0.5, ry = fb.height ? (ay - fb.top) / fb.height : 0.5;
    frame.style.width = `${Math.round(w * s)}px`; frame.style.height = `${Math.round(h * s)}px`;
    const zoomed = zoom !== 'fit' && (w * s > vw || h * s > vh);
    view.classList.toggle('zoomed', zoomed);
    if (zoomed) { const nb = frame.getBoundingClientRect(); view.scrollLeft += nb.left + rx * nb.width - ax; view.scrollTop += nb.top + ry * nb.height - ay; }
    return s;
  }
  function miniDrag(mini, total, seek) {
    mini.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      mini.setPointerCapture(e.pointerId);
      const go = (ev) => { const r = mini.getBoundingClientRect(); seek(clamp((ev.clientX - r.left) / r.width, 0, 1) * total()); };
      go(e);
      mini.onpointermove = (ev) => { if (ev.buttons) go(ev); };
      mini.onpointerup = () => { mini.onpointermove = null; mini.onpointerup = null; };
    });
  }
  // a timecode you can drag (scrub) or click and type into, as Premiere's blue ones
  function tcScrub(node, get, set, rate) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || node.querySelector('input')) return;
      const x0 = e.clientX, f0 = get();
      let moved = false;
      node.setPointerCapture(e.pointerId);
      node.onpointermove = (ev) => { const d = Math.round((ev.clientX - x0) / 2); if (Math.abs(ev.clientX - x0) > 2) moved = true; if (moved) set(f0 + d); };
      node.onpointerup = () => {
        node.onpointermove = node.onpointerup = null;
        if (moved) return;
        const r = rate(), input = el('input', { class: 'tc-edit', value: node.textContent, style: `width:${node.offsetWidth + 16}px;font:inherit;color:inherit;background:#111;border:1px solid var(--blue);padding:0 2px` });
        const old = node.textContent;
        node.textContent = ''; node.append(input); input.select();
        const done = (ok) => { if (!input.isConnected) return; const f = ok ? framesOfTc(input.value, r) : null; input.remove(); node.textContent = old; if (f != null) set(f); };
        input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
        input.addEventListener('blur', () => done(true));
      };
    });
  }

  // ---------- Web Audio: every sound through a gain (volume, mute, solo), the meters on the mix ----------
  const AU = { ctx: null, master: null, an: [], nodes: new Map(), peak: [0, 0], hold: [0, 0], holdAt: [0, 0] };
  function audioCtx() {
    if (!AU.ctx) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        AU.ctx = ctx; AU.master = ctx.createGain();
        const split = ctx.createChannelSplitter(2);
        AU.an = [ctx.createAnalyser(), ctx.createAnalyser()];
        for (const a of AU.an) a.fftSize = 1024;
        AU.master.connect(ctx.destination); AU.master.connect(split);
        split.connect(AU.an[0], 0); split.connect(AU.an[1], 1);
      } catch { AU.ctx = null; }
    }
    if (AU.ctx && AU.ctx.state === 'suspended') AU.ctx.resume().catch(() => {});
    return AU.ctx;
  }
  function gainOf(elm) {
    if (AU.nodes.has(elm)) return AU.nodes.get(elm);
    const ctx = audioCtx();
    if (!ctx) return null;
    try { const src = ctx.createMediaElementSource(elm), g = ctx.createGain(); src.connect(g); g.connect(AU.master); AU.nodes.set(elm, g); return g; } catch { return null; }
  }
  function setGain(elm, v) { const g = gainOf(elm); if (g) { g.gain.value = v; elm.volume = 1; } else elm.volume = clamp(v, 0, 1); }
  const dbGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));
  // the meters: two bars, 0 to −60 dB, green to yellow to red, a peak line held a moment
  const meterCv = $('#meterCv');
  let meterRaf = 0;
  function drawMeters() {
    meterRaf = 0;
    const r = meterCv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (!r.width) return;
    if (meterCv.width !== Math.round(r.width * dpr) || meterCv.height !== Math.round(r.height * dpr)) { meterCv.width = Math.round(r.width * dpr); meterCv.height = Math.round(r.height * dpr); }
    const g = meterCv.getContext('2d'), W = r.width, Hh = r.height;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, Hh);
    const top = 4, bot = Hh - 4, y = (db) => top + ((bot - top) * Math.min(60, -db)) / 60;
    g.fillStyle = '#7a7a7a'; g.font = '9px sans-serif'; g.textAlign = 'right';
    for (let db = 0; db >= -54; db -= 6) { g.fillText(String(db), 15, y(db) + 3); g.fillStyle = '#3c3c3c'; g.fillRect(17, Math.round(y(db)), 3, 1); g.fillStyle = '#7a7a7a'; }
    const now = performance.now(), buf = new Float32Array(1024);
    for (let i = 0; i < 2; i++) {
      let pk = 0;
      if (AU.ctx && (PL.playing || SRC.playing())) { AU.an[i].getFloatTimeDomainData(buf); for (let k = 0; k < buf.length; k++) { const v = Math.abs(buf[k]); if (v > pk) pk = v; } }
      const db = pk > 0 ? 20 * Math.log10(pk) : -90;
      AU.peak[i] = Math.max(db, AU.peak[i] - 1.2);
      if (AU.peak[i] >= AU.hold[i] || now - AU.holdAt[i] > 1200) { AU.hold[i] = AU.peak[i]; AU.holdAt[i] = now; }
      const x = 22 + i * 10, w = 8;
      g.fillStyle = '#1a1a1a'; g.fillRect(x, top, w, bot - top);
      if (AU.peak[i] > -60) {
        const grd = g.createLinearGradient(0, bot, 0, top);
        grd.addColorStop(0, '#1e9b3c'); grd.addColorStop(0.75, '#2fbf4a'); grd.addColorStop(0.86, '#d8c21a'); grd.addColorStop(1, '#e03a2f');
        g.fillStyle = grd; g.fillRect(x, y(AU.peak[i]), w, bot - y(AU.peak[i]));
      }
      if (AU.hold[i] > -60) { g.fillStyle = AU.hold[i] > -3 ? '#ff5a4a' : '#d8d8d8'; g.fillRect(x, Math.round(y(AU.hold[i])), w, 1); }
    }
    if (PL.playing || SRC.playing() || AU.peak.some((p) => p > -60)) meterRaf = requestAnimationFrame(drawMeters);
  }
  const metersOn = () => { if (!meterRaf) meterRaf = requestAnimationFrame(drawMeters); };

  // ---------- 來源 monitor ----------
  const SRC = {
    m: null, el: null, still: 0, raf: 0, shuttle: 0, shuttleTimer: 0,
    rate() { return (this.m && this.m.rate) || { num: 30, den: 1 }; },
    fps() { return fpsOf(this.rate()); },
    dur() { return this.m ? this.m.dur : 0; },
    time() { return !this.m ? 0 : this.m.kind === 'still' ? this.still : this.el ? this.el.currentTime : 0; },
    playing() { return !!(this.el && !this.el.paused); },
    // (quiet: shown again in place — the tab and the keys stay where they are)
    open(m, quiet) {
      this.close();
      if (!m || m.off) return;
      this.m = m; S.srcMedia = m;
      const frame = $('#srcFrame');
      if (m.kind === 'still') {
        frame.append(el('img', { src: m.url, alt: '' }));
      } else if (m.kind === 'video' && m.cant) {
        // nothing to play (yet): a note where the picture would be
        frame.append(el('div', { class: 'mon-off', id: 'srcSlate' }, el('b', { text: m.conv != null ? '正在轉成 MP4' : '無法預覽' }), el('span', { text: slateName(m) })));
      } else {
        const v = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
        v.preload = 'auto'; v.playsInline = true; v.src = m.url;
        v.addEventListener('play', () => { this.loop(); setPlayBtn('#srcTransport', true); metersOn(); });
        v.addEventListener('pause', () => { setPlayBtn('#srcTransport', false); this.render(); });
        v.addEventListener('seeked', () => this.render());
        v.addEventListener('loadedmetadata', () => { if (m.srcIn != null) v.currentTime = m.srcIn; this.render(); });
        this.el = v;
        frame.append(v);
        if (m.kind === 'audio') { const cv = el('canvas', { class: 'src-wave' }); frame.append(cv); this.drawWave(); }
      }
      $('#srcEmpty').hidden = true;
      $('#srcTabName').textContent = `來源：${m.name}`;
      $('#srcDragV').disabled = !m.hasV; $('#srcDragA').disabled = !m.hasA;
      if (!quiet) { showTab('src', 'src'); setFocus('src'); }
      this.fit(); this.render(); renderMeta();
    },
    close() {
      if (this.el) { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); }
      this.el = null; this.m = null; S.srcMedia = null; this.still = 0;
      fill($('#srcFrame'));
      $('#srcEmpty').hidden = false;
      $('#srcTabName').textContent = '來源：(無剪輯)';
      this.render(); renderMeta();
    },
    // (the picture's size in the view: w, h and the scale k)
    size() { const m = this.m, aud = !m || m.kind === 'audio'; return { w: !aud && m.w ? m.w : 16, h: !aud && m.h ? m.h : 9 }; },
    fit(at) {
      const m = this.m, { w, h } = this.size();
      this.k = fitFrame($('#srcView'), $('#srcFrame'), w, h, $('#srcZoom').value, at);
      if (m && m.kind === 'audio') this.drawWave();
    },
    drawWave() {
      const cv = $('#srcFrame .src-wave'), m = this.m;
      if (!cv || !m) return;
      const r = $('#srcFrame').getBoundingClientRect(), dpr = devicePixelRatio || 1;
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      const g = cv.getContext('2d');
      g.fillStyle = '#0d0d0d'; g.fillRect(0, 0, cv.width, cv.height);
      if (!m.peaks) return;
      g.fillStyle = '#5b8ed6';
      const mid = cv.height / 2, n = m.peaks.length;
      for (let x = 0; x < cv.width; x++) {
        const a = Math.floor((x / cv.width) * n), b = Math.max(a + 1, Math.floor(((x + 1) / cv.width) * n));
        let p = 0; for (let i = a; i < b; i++) if (m.peaks[i] > p) p = m.peaks[i];
        const h = Math.max(1, p * mid * 0.95); g.fillRect(x, mid - h, 1, h * 2);
      }
    },
    seek(t) {
      if (!this.m) return;
      t = clamp(t, 0, Math.max(0, this.dur() - 1e-3));
      if (this.m.kind === 'still') this.still = t; else if (this.el) this.el.currentTime = t;
      this.render();
    },
    seekFrame(f) { this.seek((f + 0.25) / this.fps()); },
    frame() { return Math.round(this.time() * this.fps()); },
    toggle() {
      if (!this.el) return;
      this.stopShuttle();
      if (this.el.paused) { audioCtx(); gainOf(this.el); const o = this.m.srcOut; if (o != null && this.time() >= o - 0.05) this.seek(this.m.srcIn || 0); this.el.playbackRate = 1; this.el.play().catch(() => {}); }
      else this.el.pause();
    },
    shuttleBy(dir) {
      if (!this.el) return;
      if (dir === 0) { this.stopShuttle(); this.el.pause(); return; }
      this.shuttle = Math.sign(this.shuttle) === dir ? clamp(this.shuttle * 2, -8, 8) : dir;
      if (this.shuttle > 0) { clearInterval(this.shuttleTimer); this.el.playbackRate = this.shuttle; audioCtx(); gainOf(this.el); this.el.play().catch(() => {}); }
      else { this.el.pause(); clearInterval(this.shuttleTimer); const sp = -this.shuttle; this.shuttleTimer = setInterval(() => { const t = this.time() - (sp * 0.1); if (t <= 0) { this.stopShuttle(); this.seek(0); } else this.seek(t); }, 100); }
    },
    stopShuttle() { this.shuttle = 0; clearInterval(this.shuttleTimer); if (this.el) this.el.playbackRate = 1; },
    step(n) { if (!this.m) return; if (this.el) this.el.pause(); this.seekFrame(this.frame() + n); },
    loop() {
      cancelAnimationFrame(this.raf);
      const go = () => {
        this.render();
        const o = this.m && this.m.srcOut;
        if (this.el && !this.el.paused && o != null && this.time() >= o && this.time() < o + 0.25) this.el.pause();
        if (this.playing()) this.raf = requestAnimationFrame(go);
      };
      this.raf = requestAnimationFrame(go);
    },
    mark(which) {
      const m = this.m;
      if (!m) return;
      const t = this.time();
      if (which === 'in') { m.srcIn = t; if (m.srcOut != null && m.srcOut <= t) m.srcOut = null; }
      else if (which === 'out') { m.srcOut = t; if (m.srcIn != null && m.srcIn >= t) m.srcIn = null; }
      else if (which === 'clearIn') m.srcIn = null;
      else if (which === 'clearOut') m.srcOut = null;
      else { m.srcIn = null; m.srcOut = null; }
      this.render(); keepLater();
    },
    range() {
      const m = this.m;
      if (!m) return null;
      if (m.kind === 'still') return [0, 5];
      const a = m.srcIn != null ? m.srcIn : 0, b = m.srcOut != null ? m.srcOut : m.dur;
      return b - a > 1e-3 ? [a, b] : null;
    },
    render() {
      const m = this.m, r = this.rate(), fps = fpsOf(r);
      $('#srcTc').textContent = tcOf(Math.round(this.time() * fps), r);
      const rg = this.range();
      $('#srcDur').textContent = tcOf(rg ? Math.round((rg[1] - rg[0]) * fps) : 0, r);
      const d = this.dur() || 1;
      $('#srcPh').style.left = `${(this.time() / d) * 100}%`;
      const io = $('#srcIo'), on = !!(m && (m.srcIn != null || m.srcOut != null));
      io.classList.toggle('on', on);
      if (on) { const a = m.srcIn != null ? m.srcIn : 0, b = m.srcOut != null ? m.srcOut : d; io.style.left = `${(a / d) * 100}%`; io.style.width = `${((b - a) / d) * 100}%`; }
      const has = !!m;
      for (const b of $$('#srcTransport button')) b.disabled = !has || (m.kind === 'still' && !['insert', 'overwrite', 'frame', 'full'].includes(b.dataset.act));
    },
  };
  miniDrag($('#srcMini'), () => SRC.dur(), (t) => { if (SRC.el) SRC.el.pause(); SRC.seek(t); });
  tcScrub($('#srcTc'), () => SRC.frame(), (f) => SRC.seekFrame(f), () => SRC.rate());
  $('#srcZoom').addEventListener('change', () => SRC.fit());
  function setPlayBtn(sel, on) { const b = $(`${sel} .t-play`); b.firstElementChild.firstElementChild.setAttribute('href', on ? '#i-stop' : '#i-play'); }
  // drag what's marked in the 來源 monitor onto the timeline (all of it, or only the picture or only the sound)
  for (const [id, only] of [['#srcFrame', null], ['#srcDragV', 'v'], ['#srcDragA', 'a']]) {
    const n = $(id);
    if (id === '#srcFrame') n.setAttribute('draggable', 'true');
    n.addEventListener('dragstart', (e) => {
      if (!SRC.m) { e.preventDefault(); return; }
      DRAG.media = [SRC.m]; DRAG.only = only; DRAG.range = SRC.range();
      e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', SRC.m.name);
    });
    n.addEventListener('dragend', () => { DRAG.media = null; endDropGhost(); });
  }

  // ---------- 節目 monitor: the sequence played ----------
  // Each video track has two <video> elements (the clip on screen and the next one, ready), an <img> for stills and a
  // block for a title; each audio track two <audio>. The clock is the page's own: every element is kept within a frame
  // or two of where it should be, a clip's speed is its element's playbackRate (beyond 8×, and backwards, it seeks).
  const PH = { frame: 0 };
  const layersEl = $('#layers');
  const PL = {
    playing: false, rate: 1, wall0: 0, f0: 0, raf: 0, lay: {}, aud: {}, k: 1, shuttle: 0,
    init() {
      const mk = (tag) => { const e = document.createElement(tag); e.preload = 'auto'; e.playsInline = true; if (tag === 'video') e.muted = true; e.hidden = true; return e; };
      for (const t of VT) {
        const L = { vids: [mk('video'), mk('video')], img: el('img', { alt: '', hidden: '' }), ttl: el('div', { class: 'ttl', hidden: '' }) };
        for (const v of L.vids) { layersEl.append(v); v.addEventListener('seeked', () => seekDone(v)); v.addEventListener('loadedmetadata', () => seekDone(v)); v.addEventListener('error', () => this.retry(v)); }
        layersEl.append(L.img, L.ttl);
        this.lay[t] = L;
      }
      for (const t of AT) {
        const els = [mk('audio'), mk('audio')];
        for (const a of els) { a.addEventListener('seeked', () => seekDone(a)); a.addEventListener('loadedmetadata', () => seekDone(a)); a.addEventListener('error', () => this.retry(a)); }
        this.aud[t] = { els };
      }
    },
    // a file the player gave up on (Safari can, with several videos open at once, or short of memory): loaded again a
    // moment later and put back where it was to be (_want) — a few tries for each file, and again when it's wanted
    retry(e) {
      const src = e.getAttribute('src');
      if (!src) return;
      if (e._src !== src) { e._src = src; e._tries = 0; }
      if (e._tries >= 3 || e._retrying) return;
      e._tries++; e._retrying = true;
      if (e._want == null) e._want = e.currentTime;
      setTimeout(() => { e._retrying = false; if (e.getAttribute('src') === src) e.load(); }, 300 * e._tries);
    },
    fps() { return P.seq ? fpsOf(P.seq.rate) : 30; },
    endFrame() { return seqEnd(); },
    fitKey: '',
    size() { return P.seq ? { w: P.seq.w, h: P.seq.h } : { w: 16, h: 9 }; },
    fit(at) {
      if (!P.seq) { fitFrame($('#prgView'), $('#prgFrame'), 16, 9, 'fit'); this.k = 1; this.fitKey = ''; return; }
      this.k = fitFrame($('#prgView'), $('#prgFrame'), P.seq.w, P.seq.h, $('#prgZoom').value, at);
      this.fitKey = `${P.seq.w}x${P.seq.h}`;
      this.show(PH.frame, true);
    },
    // (a new sequence, or one of another size: the frame fitted again first)
    refresh() { if (P.seq && this.fitKey !== `${P.seq.w}x${P.seq.h}`) this.fit(); else if (!P.seq && this.fitKey) this.fit(); if (this.playing) return; this.show(PH.frame, true); renderPh(); },
    // the clip showing on a track at a frame (a disabled clip, a hidden track: none)
    at(track, f) {
      if (!P.seq) return null;
      const tr = P.seq.tracks[track];
      if (isV(track) ? !tr.out : tr.mute || (AT.some((t) => P.seq.tracks[t].solo) && !tr.solo)) return null;
      for (const c of P.seq.clips) if (c.track === track && !c.off && f >= c.start && f < cEnd(c)) return c;
      return null;
    },
    next(track, f) {
      let best = null;
      for (const c of P.seq.clips) if (c.track === track && !c.off && c.start >= f && (!best || c.start < best.start)) best = c;
      return best;
    },
    srcTime(c, f) { return c.in + fr2s(f - c.start) * c.speed; },
    // an element for the clip: the one already holding it, else the other
    pick(els, c, m) {
      let e = els.find((x) => x.dataset.cid === c.id);
      if (!e) {
        e = els.find((x) => x.hidden && x.dataset.cid !== this.nextId(els)) || els.find((x) => x.hidden) || els[0];
        e.dataset.cid = c.id;
        if (e.dataset.mid !== m.id) { e.dataset.mid = m.id; e.src = m.url; }
      }
      return e;
    },
    nextId(els) { return els._next || ''; },
    place(node, c, m) {
      const seq = P.seq, k = this.k, fx = c.fx;
      if (c.text) {
        node.textContent = c.text.value;
        node.style.cssText = `color:${c.text.color};font-size:${c.text.size * (fx.scale / 100) * k}px;opacity:${fx.opacity / 100};transform:translate(-50%,-50%) translate(${fx.x * k}px,${fx.y * k}px) rotate(${fx.rot}deg);transform-origin:0 0;left:0;top:0;text-align:center`;
        return;
      }
      const base = c.fit ? Math.min(seq.w / m.w, seq.h / m.h) : 1, s = base * (fx.scale / 100) * k, w = m.w * s, h = m.h * s;
      const fade = this.fade(c);
      node.style.cssText = `width:${w}px;height:${h}px;opacity:${(fx.opacity / 100) * fade};transform:translate(${fx.x * k - w / 2}px,${fx.y * k - h / 2}px) rotate(${fx.rot}deg);transform-origin:50% 50%;object-fit:fill`;
    },
    fade(c) {
      const tr = P.seq.trans || [];
      let a = 1;
      for (const t of tr) {
        if (t.out === c.id && PH.frame > cEnd(c) - t.dur) a = Math.min(a, (cEnd(c) - PH.frame) / t.dur);
        if (t.in === c.id && PH.frame < c.start + t.dur) a = Math.min(a, (PH.frame - c.start) / t.dur);
      }
      return clamp(a, 0, 1);
    },
    // a frame shown: every track's element set (when still, each on its frame exactly)
    show(f, exact) {
      const seq = P.seq;
      let slate = null; // a clip that can't be shown: why (offline, its MP4 being made, a format this browser can't play)
      for (const t of VT) {
        const L = this.lay[t];
        const c = seq ? this.at(t, Math.floor(f)) : null, m = c ? mediaById(c.mid) : null;
        if (!c || (!c.text && (!m || m.off || m.cant))) {
          for (const v of L.vids) { if (!v.hidden) { v.hidden = true; v.pause(); } }
          L.img.hidden = true; L.ttl.hidden = true;
          if (c && !slate) slate = { t: !m || m.off ? '媒體離線' : m.conv != null ? '正在轉成 MP4' : '無法預覽', m };
          continue;
        }
        if (c.text) { L.ttl.hidden = false; this.place(L.ttl, c, null); L.img.hidden = true; for (const v of L.vids) { v.hidden = true; v.pause(); } continue; }
        if (m.kind === 'still') { if (L.img.dataset.mid !== m.id) { L.img.src = m.url; L.img.dataset.mid = m.id; } L.img.hidden = false; this.place(L.img, c, m); L.ttl.hidden = true; for (const v of L.vids) { v.hidden = true; v.pause(); } continue; }
        L.img.hidden = true; L.ttl.hidden = true;
        const v = this.pick(L.vids, c, m);
        for (const o of L.vids) if (o !== v && !o.hidden) { o.hidden = true; o.pause(); }
        v.hidden = false;
        this.place(v, c, m);
        if (exact) seekTo(v, this.srcTime(c, Math.floor(f)) + 0.25 / (m.rate ? fpsOf(m.rate) : 30));
        if (exact && v.error) { v._tries = 0; this.retry(v); }
      }
      $('#prgOffline').hidden = !slate;
      this.slateM = slate ? slate.m : null;
      if (slate) { $('#prgOfflineT').textContent = slate.t; $('#prgOfflineName').textContent = slateName(slate.m); }
      // sound: kept ready on the right spot (it only plays while playing)
      for (const t of AT) {
        const A = this.aud[t], c = seq ? this.at(t, Math.floor(f)) : null, m = c ? mediaById(c.mid) : null;
        if (!c || !m || m.off || !m.hasA || m.conv != null) { for (const a of A.els) { if (!a.paused) a.pause(); a.hidden = true; } continue; }
        const a = this.pick(A.els, c, m);
        for (const o of A.els) if (o !== a) { if (!o.paused) o.pause(); o.hidden = true; }
        a.hidden = false;
        if (exact) seekTo(a, this.srcTime(c, Math.floor(f)));
        if (exact && a.error) { a._tries = 0; this.retry(a); }
      }
      placeXf();
    },
    gainFor(c) {
      const fade = this.fade(c);
      return dbGain(c.fx.vol) * fade;
    },
    toggle() { if (this.playing) this.stop(); else this.play(1); },
    play(rate) {
      if (!P.seq || !P.seq.clips.length) return;
      SRC.el && SRC.el.pause();
      audioCtx();
      if (rate > 0 && PH.frame >= this.endFrame() - 1) PH.frame = 0;
      this.rate = rate; this.playing = true; this.wall0 = performance.now(); this.f0 = PH.frame;
      setPlayBtn('#prgTransport', true);
      metersOn();
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.tick());
    },
    stop() {
      if (!this.playing) return;
      this.playing = false; this.shuttle = 0;
      cancelAnimationFrame(this.raf);
      for (const t of VT) for (const v of this.lay[t].vids) v.pause();
      for (const t of AT) for (const a of this.aud[t].els) a.pause();
      PH.frame = clamp(Math.round(PH.frame), 0, Math.max(0, this.endFrame()));
      setPlayBtn('#prgTransport', false);
      this.show(PH.frame, true);
      renderPh(true); renderInfo();
    },
    tick() {
      if (!this.playing) return;
      const fps = this.fps(), end = this.endFrame(), io = P.seq;
      let f = this.f0 + ((performance.now() - this.wall0) / 1000) * fps * this.rate;
      // playing from inside the in–out range stops at the out point (as Premiere does when looping is off)
      const stopAt = io.out != null && this.f0 < io.out ? io.out : end;
      if (this.rate > 0 && f >= stopAt) { PH.frame = stopAt; this.stop(); return; }
      if (this.rate < 0 && f <= 0) { PH.frame = 0; this.stop(); return; }
      PH.frame = f;
      this.show(f, false);
      const fi = Math.floor(f);
      for (const t of VT) {
        const L = this.lay[t], c = this.at(t, fi), m = c && mediaById(c.mid);
        if (c && m && !m.off && !m.cant && m.kind === 'video') {
          const v = L.vids.find((x) => x.dataset.cid === c.id);
          if (v) this.drive(v, this.srcTime(c, f), c.speed * this.rate, 0.2);
        }
        // the next clip on this track, ready on its first frame in the other element
        const n = this.next(t, fi + 1), nm = n && mediaById(n.mid);
        if (n && nm && !nm.off && !nm.cant && nm.kind === 'video' && (n.start - f) / (fps * Math.abs(this.rate)) < 1.5) {
          if (!L.vids.some((x) => x.dataset.cid === n.id)) {
            const spare = L.vids.find((x) => x.hidden);
            if (spare) { spare.dataset.cid = n.id; if (spare.dataset.mid !== nm.id) { spare.dataset.mid = nm.id; spare.src = nm.url; } seekTo(spare, n.in); }
          }
        }
      }
      for (const t of AT) {
        const A = this.aud[t], c = this.at(t, fi), m = c && mediaById(c.mid);
        if (c && m && !m.off && m.hasA) {
          const a = A.els.find((x) => x.dataset.cid === c.id);
          if (a) {
            const r = c.speed * this.rate;
            if (r > 0 && r <= 4) { a.preservesPitch = !!c.pitch; setGain(a, this.gainFor(c)); this.drive(a, this.srcTime(c, f), r, 0.3); }
            else if (!a.paused) a.pause();
          }
        }
        const n = this.next(t, fi + 1), nm = n && mediaById(n.mid);
        if (n && nm && !nm.off && nm.hasA && (n.start - f) / (fps * Math.abs(this.rate)) < 1.5 && !A.els.some((x) => x.dataset.cid === n.id)) {
          const spare = A.els.find((x) => x.hidden);
          if (spare) { spare.dataset.cid = n.id; if (spare.dataset.mid !== nm.id) { spare.dataset.mid = nm.id; spare.src = nm.url; } seekTo(spare, n.in); }
        }
      }
      renderPh(false);
      this.raf = requestAnimationFrame(() => this.tick());
    },
    // keep an element playing at a rate, on time (forwards up to 8×; faster or backwards by seeking)
    drive(e, want, rate, tol) {
      if (rate > 0 && rate <= 8) {
        if (Math.abs(e.playbackRate - rate) > 1e-3) e.playbackRate = rate;
        if (e.error) { e._want = want; this.retry(e); return; }
        if (e.paused) { if (e.readyState < 1) e._want = want; else if (Math.abs(e.currentTime - want) > 0.05) e.currentTime = want; e.play().catch(() => {}); }
        else if (Math.abs(e.currentTime - want) > tol * Math.max(1, rate)) e.currentTime = want;
      } else {
        if (!e.paused) e.pause();
        seekTo(e, want);
      }
    },
    shuttleBy(dir) {
      if (dir === 0) { this.stop(); return; }
      this.shuttle = Math.sign(this.shuttle) === dir ? clamp(this.shuttle * 2, -8, 8) : dir;
      const f = PH.frame;
      this.stop(); PH.frame = f;
      this.play(this.shuttle);
    },
  };
  // one seek at a time (scrubbing doesn't pile seeks up): the latest kept for when the one in flight is done — and for
  // when the file has loaded, as Safari drops a seek made before that
  function seekTo(e, t) {
    if (!Number.isFinite(t)) return;
    t = Math.max(0, t);
    if (e.seeking || e.readyState < 1 || e.error) { e._want = t; return; }
    if (Math.abs(e.currentTime - t) > 0.001) e.currentTime = t;
  }
  function seekDone(e) { if (e._want != null) { const t = e._want; e._want = null; if (Math.abs(e.currentTime - t) > 0.001) e.currentTime = t; } }
  PL.init();
  miniDrag($('#prgMini'), () => Math.max(1, PL.endFrame()), (f) => { PL.stop(); setPh(f); });
  tcScrub($('#prgTc'), () => Math.round(PH.frame), (f) => { PL.stop(); setPh(f); }, () => (P.seq ? P.seq.rate : { num: 30, den: 1 }));
  tcScrub($('#tlTc'), () => Math.round(PH.frame), (f) => { PL.stop(); setPh(f); }, () => (P.seq ? P.seq.rate : { num: 30, den: 1 }));
  $('#prgZoom').addEventListener('change', () => PL.fit());

  // ---------- zooming the monitors: 適合 or Premiere's levels (10–400%) from the menu; ⌘/Ctrl-scroll or a pinch for
  // anything from 適合 to 800%, about the pointer. Zoomed in, the picture is dragged about (or scrolled) ----------
  const MONS = { prg: { mon: () => PL, view: $('#prgView'), sel: $('#prgZoom'), ready: () => !!P.seq }, src: { mon: () => SRC, view: $('#srcView'), sel: $('#srcZoom'), ready: () => !!SRC.m } };
  function setZoom(which, z, at) {
    const M = MONS[which], sel = M.sel;
    if (z === 'fit') sel.value = 'fit';
    else {
      const pct = String(Math.round(z)), preset = [...sel.options].find((o) => o.value === pct && !o.hidden);
      if (preset) sel.value = pct;
      else { const o = sel.querySelector('.z-free'); o.value = pct; o.textContent = `${pct}%`; sel.value = pct; }
    }
    M.mon().fit(at);
  }
  for (const which of Object.keys(MONS)) {
    const M = MONS[which], view = M.view;
    // to z% (from k, the scale it's at); shrinking past what fits is 適合
    const zoomBy = (f, at) => {
      if (!M.ready()) return;
      const { w, h } = M.mon().size(), fit = fitScale(view, w, h), k = M.sel.value === 'fit' ? fit : M.mon().k || fit, z = clamp(k * f, 0.1, 8);
      setZoom(which, f < 1 && z <= fit * 1.001 ? 'fit' : z * 100, at);
    };
    // (a pinch comes as ⌃-scroll, exp(−Δ/100) a step, followed one to one; a mouse's notch is about a fifth)
    let g = 0;
    view.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;   // (a plain wheel scrolls a zoomed picture)
      e.preventDefault();
      if (g) return;
      const d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
      zoomBy(Math.exp(-clamp(d, -25, 25) / 100), { x: e.clientX, y: e.clientY });
    }, { passive: false });
    // (Safari pinches with gesture events)
    view.addEventListener('gesturestart', (e) => { e.preventDefault(); g = 1; });
    view.addEventListener('gesturechange', (e) => { e.preventDefault(); if (!g) return; zoomBy(e.scale / g, { x: e.clientX, y: e.clientY }); g = e.scale; });
    view.addEventListener('gestureend', (e) => { e.preventDefault(); g = 0; });
    view.addEventListener('pointerdown', (e) => {
      if (!view.classList.contains('zoomed') || (e.button !== 0 && e.button !== 1) || e.target.closest('#xf') || (which === 'prg' && S.tool === 'type')) return;
      e.preventDefault();
      view.setPointerCapture(e.pointerId);
      view.classList.add('panning');
      const x0 = e.clientX, y0 = e.clientY, l0 = view.scrollLeft, t0 = view.scrollTop;
      view.onpointermove = (ev) => { view.scrollLeft = l0 - (ev.clientX - x0); view.scrollTop = t0 - (ev.clientY - y0); };
      view.onpointerup = view.onpointercancel = () => { view.onpointermove = view.onpointerup = view.onpointercancel = null; view.classList.remove('panning'); };
    });
  }
  // ---------- full screen (Premiere's ⌃`): the monitor under the pointer, else 節目, with its controls ----------
  const fullEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  function toggleFull(which) {
    if (fullEl()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const f = which ? $(`[data-panel="${which}"]`) : hoverFrame && (hoverFrame.id === 'fSrc' || hoverFrame.id === 'fPrg') ? hoverFrame : $('#fPrg'), go = f.requestFullscreen || f.webkitRequestFullscreen;
    if (!go) { toast('這個瀏覽器不能全螢幕'); return; }
    Promise.resolve(go.call(f)).catch(() => toast('這個瀏覽器不能全螢幕'));
  }
  const onFull = () => {
    const f = fullEl();
    for (const b of $$('.t-full')) { const on = !!f && f.contains(b); b.querySelector('use').setAttribute('href', on ? '#i-full-x' : '#i-full'); b.title = on ? '結束全螢幕 (Esc)' : `全螢幕 (${K('⌃`')})`; }
    requestAnimationFrame(() => { PL.fit(); SRC.fit(); placeXf(); });
  };
  document.addEventListener('fullscreenchange', onFull);
  document.addEventListener('webkitfullscreenchange', onFull);
  function setPh(f, keepView) {
    if (!P.seq) return;
    PH.frame = clamp(Math.round(f), 0, Math.max(0, seqEnd()));
    PL.show(PH.frame, true);
    renderPh(true, keepView);
    renderInfo();
  }

  // the selected clip's box on the 節目 monitor: drag it to move (位置), a corner to scale (縮放)
  const xf = $('#xf');
  function xfClip() {
    if (!P.seq || S.sel.size !== 1 || S.mode !== 'edit') return null;
    const c = clipById([...S.sel][0]);
    if (!c || !isV(c.track) || c.off || PH.frame < c.start || PH.frame >= cEnd(c)) return null;
    return c;
  }
  function xfRect(c) {
    const m = mediaById(c.mid), k = PL.k, fx = c.fx;
    if (c.text) { const t = PL.lay[c.track].ttl; return { w: t.offsetWidth, h: t.offsetHeight, x: fx.x * k, y: fx.y * k }; }
    if (!m) return null;
    const base = c.fit ? Math.min(P.seq.w / m.w, P.seq.h / m.h) : 1, s = base * (fx.scale / 100) * k;
    return { w: m.w * s, h: m.h * s, x: fx.x * k, y: fx.y * k };
  }
  function placeXf() {
    const c = xfClip(), r = c && xfRect(c);
    if (!r) { xf.hidden = true; return; }
    const fr = $('#prgFrame'), view = $('#prgView'), fb = fr.getBoundingClientRect(), vb = view.getBoundingClientRect();
    xf.hidden = false;
    xf.style.cssText = `left:${fb.left - vb.left + view.scrollLeft + r.x - r.w / 2}px;top:${fb.top - vb.top + view.scrollTop + r.y - r.h / 2}px;width:${r.w}px;height:${r.h}px;transform:rotate(${c.fx.rot}deg)`;
  }
  xf.addEventListener('pointerdown', (e) => {
    const c = xfClip();
    if (!c || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    xf.setPointerCapture(e.pointerId);
    const h = e.target.dataset.h, x0 = e.clientX, y0 = e.clientY, fx0 = { ...c.fx }, k = PL.k, r = xfRect(c);
    const cx = xf.getBoundingClientRect().left + xf.offsetWidth / 2, cy = xf.getBoundingClientRect().top + xf.offsetHeight / 2;
    const d0 = Math.hypot(x0 - cx, y0 - cy) || 1;
    begin(h ? '縮放' : '位置');
    xf.onpointermove = (ev) => {
      if (h) c.fx.scale = Math.max(1, Math.round(fx0.scale * (Math.hypot(ev.clientX - cx, ev.clientY - cy) / d0) * 10) / 10);
      else { c.fx.x = Math.round((fx0.x + (ev.clientX - x0) / k) * 10) / 10; c.fx.y = Math.round((fx0.y + (ev.clientY - y0) / k) * 10) / 10; }
      PL.show(PH.frame, false); renderFx();
    };
    xf.onpointerup = () => { xf.onpointermove = xf.onpointerup = null; if (c.fx.x !== fx0.x || c.fx.y !== fx0.y || c.fx.scale !== fx0.scale) commit(); else H.before = null; };
    void r;
  });
  new ResizeObserver(() => { PL.fit(); SRC.fit(); placeXf(); }).observe($('#ws'));

  // ---------- 時間軸: geometry ----------
  // Tracks top to bottom V3 V2 V1 | A1 A2 A3 | 主要; a frame is ppf pixels wide; x0 the first frame on the left.
  const TL = { ppf: 2, x0: 0, y0: 0, tall: { V1: true, A1: true }, gap: null };
  const tlTracks = $('#tlTracks'), tlClips = $('#tlClips'), tlRows = $('#tlRows'), tlHeads = $('#tlHeads');
  const ORDER = ['V3', 'V2', 'V1', 'A1', 'A2', 'A3'];
  const trackH = (t) => (TL.tall[t] ? (isV(t) ? 52 : 46) : 26);
  function rowsY() {
    const y = {};
    let at = 0;
    for (const t of ORDER) { y[t] = at; at += trackH(t) + (t === 'V1' ? 3 : 1); }
    y.master = at; y.total = at + 26;
    return y;
  }
  const viewW = () => tlTracks.clientWidth || 600;
  const fx2 = (f) => (f - TL.x0) * TL.ppf;
  const xf2 = (x) => TL.x0 + x / TL.ppf;
  const total = () => Math.max(seqEnd() + Math.round(viewW() / TL.ppf * 0.3), Math.round(viewW() / TL.ppf));
  function trackAtY(y) {
    const Y = rowsY();
    y += TL.y0;
    for (const t of ORDER) if (y >= Y[t] && y < Y[t] + trackH(t) + 1) return t;
    return y < 0 ? 'V3' : null;
  }
  function zoomTo(ppf, anchorX) {
    const min = Math.max(0.005, viewW() / Math.max(30, seqEnd() * 1.1 + 30) / 4), max = 24;
    ppf = clamp(ppf, min, max);
    const f = xf2(anchorX);
    TL.ppf = ppf;
    TL.x0 = Math.max(0, f - anchorX / ppf);
    renderTimeline();
  }
  function zoomFit() {
    const end = Math.max(seqEnd(), 30);
    TL.ppf = clamp((viewW() - 20) / end, 0.005, 24);
    TL.x0 = 0;
    renderTimeline();
  }
  function scrollTo(x0) { TL.x0 = clamp(x0, 0, Math.max(0, total() - viewW() / TL.ppf)); renderTimeline(); }
  // keep the playhead on screen: a page forward when it runs off (Premiere's page scroll)
  function followPh() {
    const x = fx2(PH.frame), w = viewW();
    if (x > w - 2 || x < 0) { TL.x0 = Math.max(0, PH.frame - (x < 0 ? w * 0.5 : 4) / TL.ppf); return true; }
    return false;
  }

  // ---------- 時間軸: drawn ----------
  const clipEls = new Map();
  function clipLabel(c, m) {
    if (c.text) return c.text.value.split('\n')[0] || '文字';
    const pct = Math.round(c.speed * 10000) / 100;
    return `${m ? m.name : '（媒體不見了）'}${c.link ? (isV(c.track) ? ' [V]' : ' [A]') : ''}${c.speed !== 1 ? ` [${pct}%]` : ''}`;
  }
  const fxUsed = (c) => { const d = defaultFx(P.seq); return c.speed !== 1 || c.fit || ['x', 'y', 'scale', 'rot', 'opacity', 'vol'].some((k) => Math.abs(c.fx[k] - d[k]) > 1e-6); };
  function renderTimeline() {
    const seq = P.seq;
    $('#tlEmpty').hidden = !!(seq && seq.clips.length) || !!seq;
    $('#tlEmpty').hidden = !!seq;
    $('#zs').style.visibility = seq ? 'visible' : 'hidden';
    renderHeads();
    if (!seq) { fill(tlRows); fill(tlClips); clipEls.clear(); drawRuler(); renderPh(false); return; }
    const Y = rowsY(), W = viewW();
    // rows
    fill(tlRows, ...ORDER.map((t) => el('div', { class: `trow${t === 'V1' ? ' sep' : ''}`, style: `top:${Y[t] - TL.y0}px;height:${trackH(t) + (t === 'V1' ? 3 : 1)}px` })),
      el('div', { class: 'trow master', style: `top:${Y.master - TL.y0}px;height:26px` }),
      TL.gap ? el('div', { class: 'gap-sel', style: `position:absolute;left:${fx2(TL.gap.a)}px;width:${(TL.gap.b - TL.gap.a) * TL.ppf}px;top:${Y[TL.gap.track] - TL.y0}px;height:${trackH(TL.gap.track)}px;background:rgba(255,255,255,.12);box-shadow:inset 0 0 0 1px #8a8a8a` }) : null);
    // clips (only those on screen exist)
    const seen = new Set();
    for (const c of seq.clips) {
      const x = fx2(c.start), w = c.dur * TL.ppf;
      if (x > W + 50 || x + w < -50) continue;
      seen.add(c.id);
      let n = clipEls.get(c.id);
      const m = mediaById(c.mid);
      if (!n) { n = el('div', { class: 'clip', 'data-id': c.id }, el('i', { class: 'clip-fx', text: 'fx' }), el('span', { class: 'clip-name' })); clipEls.set(c.id, n); }
      const kind = c.text ? 'txt' : !isV(c.track) ? 'aud' : m && m.kind === 'still' ? 'still' : '';
      n.className = `clip${kind ? ` ${kind}` : ''}${S.sel.has(c.id) ? ' sel' : ''}${!c.text && (!m || m.off) ? ' off' : ''}${c.off ? ' dis' : ''}${DRAGTL.ghost && DRAGTL.ghost.has(c.id) ? ' ghost' : ''}`;
      const left = Math.max(-2, x), right = Math.min(W + 2, x + w);
      n.style.cssText = `left:${x}px;width:${Math.max(2, w)}px;top:${Y[c.track] - TL.y0 + 1}px;height:${trackH(c.track) - 2}px`;
      n.firstElementChild.classList.toggle('on', fxUsed(c));
      const name = n.querySelector('.clip-name');
      name.textContent = clipLabel(c, m);
      name.style.left = `${Math.max(18, left - x + 18)}px`;
      // the sound's shape (audio), the first frame (a tall video track)
      let cv = n.querySelector('canvas');
      const needWave = !isV(c.track) && S.waves && m && m.peaks, needThumb = isV(c.track) && TL.tall[c.track] && S.thumbs && m && m.poster && !c.text;
      if (needWave || needThumb) {
        if (!cv) { cv = el('canvas'); n.insertBefore(cv, n.firstChild); }
        if (needWave) drawWave(cv, c, m, left - x, right - left);
        else drawThumb(cv, c, m, n);
      } else if (cv) cv.remove();
      if (!n.parentNode) tlClips.append(n);
    }
    for (const [id, n] of clipEls) if (!seen.has(id)) { n.remove(); clipEls.delete(id); }
    // transitions
    for (const t of $$('.trans', tlClips)) t.remove();
    for (const t of seq.trans || []) {
      const a = clipById(t.out), b = clipById(t.in), c = a || b;
      if (!c) continue;
      const at = a ? cEnd(a) : b.start, x = fx2(at - (a && b ? t.dur / 2 : a ? t.dur : 0));
      tlClips.append(el('div', { class: `trans${S.trans === t.id ? ' sel' : ''}`, 'data-trans': t.id, title: `${t.kind === 'cross' ? '交叉溶解' : '黑場轉場'}（${(t.dur / fpsOf(seq.rate)).toFixed(2)} 秒）`, style: `left:${x}px;width:${t.dur * TL.ppf}px;top:${Y[c.track] - TL.y0 + 3}px;height:${trackH(c.track) - 6}px` }));
    }
    tlClips.style.height = tlRows.style.height = `${Y.total}px`;
    drawRuler();
    renderPh(false);
    renderZs();
  }
  function drawWave(cv, c, m, ox, w) {
    const h = trackH(c.track) - 2, dpr = devicePixelRatio || 1;
    w = Math.max(1, Math.round(w));
    cv.style.cssText = `position:absolute;left:${ox}px;top:0;width:${w}px;height:${h}px;pointer-events:none`;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const pk = m.peaks, per = 100, top = TL.tall[c.track] ? 13 : 9, mid = top + (h - top) / 2, amp = (h - top) / 2 - 1, gain = dbGain(c.fx.vol);
    g.fillStyle = 'rgba(14,30,52,.62)';
    const spf = fr2s(1) * c.speed;
    for (let x = 0; x < w; x++) {
      const f = xf2(fx2(c.start) + ox + x) - c.start, s0 = c.in + f * spf, s1 = s0 + spf / TL.ppf;
      const a = Math.max(0, Math.floor(s0 * per)), b = Math.min(pk.length, Math.max(a + 1, Math.ceil(s1 * per)));
      let p = 0;
      for (let i = a; i < b; i++) if (pk[i] > p) p = pk[i];
      const hh = Math.max(0.5, Math.min(1, p * gain) * amp);
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
  }
  function drawThumb(cv, c, m, n) {
    const h = trackH(c.track) - 18, w = Math.round((h * m.w) / m.h), dpr = devicePixelRatio || 1;
    cv.style.cssText = `position:absolute;left:2px;top:15px;width:${w}px;height:${h}px;pointer-events:none`;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.getContext('2d').drawImage(m.poster, 0, 0, cv.width, cv.height); }
    void n;
  }
  // the header of each track: source patch, lock, the track's name (targeted: blue), sync lock, eye / M S
  function renderHeads() {
    const seq = P.seq, Y = rowsY();
    if (!seq) { fill(tlHeads); return; }
    const btn = (cls, on, title, icon, act, t) => el('button', { type: 'button', class: `th-btn ${cls}${on ? ' on' : ''}`, title, 'data-act': act, 'data-t': t }, svgUse(icon));
    fill(tlHeads, ...ORDER.map((t) => {
      const tr = seq.tracks[t], patched = isV(t) ? seq.patch.v === t : seq.patch.a === t;
      const kids = [el('span', { class: 'th-patch', title: '來源修補：插入、覆蓋放到這一軌', 'data-act': 'patch', 'data-t': t }, el('b', { class: patched ? 'on' : '', text: isV(t) ? 'V1' : 'A1' })),
        btn('lock', tr.lock, tr.lock ? '解除軌道鎖定' : '切換軌道鎖定', 'i-lock', 'lock', t),
        el('span', { class: `th-name${seq.targets.includes(t) ? ' on' : ''}`, title: '目標軌道：⌘K、貼上、提取、擷取作用在這一軌', 'data-act': 'target', 'data-t': t, text: t }),
        btn('sync', tr.sync, '切換同步鎖定：插入、波紋編輯時這一軌一起移動', 'i-sync', 'sync', t)];
      if (isV(t)) kids.push(btn('eye', tr.out, '切換軌道輸出', tr.out ? 'i-eye' : 'i-eyeoff', 'out', t));
      else kids.push(el('button', { type: 'button', class: `th-ms m${tr.mute ? ' on' : ''}`, title: '將軌道靜音', 'data-act': 'mute', 'data-t': t, text: 'M' }), el('button', { type: 'button', class: `th-ms s${tr.solo ? ' on' : ''}`, title: '獨奏軌道', 'data-act': 'solo', 'data-t': t, text: 'S' }));
      return el('div', { class: `th${t === 'V1' ? ' sep' : ''}${tr.lock ? ' locked' : ''}`, 'data-t': t, style: `top:${Y[t] - TL.y0}px;height:${trackH(t) + (t === 'V1' ? 3 : 1)}px` }, ...kids);
    }), el('div', { class: 'th th-master', style: `top:${Y.master - TL.y0}px;height:26px` }, el('span', { text: '主要' }), el('b', { class: 'scrub', 'data-master': '1', title: '主要音量（dB）：拖曳調整', text: (seq.master || 0).toFixed(1) })));
  }
  tlHeads.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !P.seq) return;
    const t = b.dataset.t, tr = P.seq.tracks[t], act = b.dataset.act;
    begin('軌道');
    if (act === 'patch') { if (isV(t)) P.seq.patch.v = P.seq.patch.v === t ? null : t; else P.seq.patch.a = P.seq.patch.a === t ? null : t; }
    else if (act === 'target') { const i = P.seq.targets.indexOf(t); if (i >= 0) P.seq.targets.splice(i, 1); else P.seq.targets.push(t); }
    else if (act === 'lock') { tr.lock = !tr.lock; if (tr.lock) for (const c of P.seq.clips) if (c.track === t) S.sel.delete(c.id); }
    else if (act === 'sync') tr.sync = !tr.sync;
    else if (act === 'out') tr.out = !tr.out;
    else if (act === 'mute') tr.mute = !tr.mute;
    else if (act === 'solo') tr.solo = !tr.solo;
    H.before = null;   // track switches aren't undone (as in Premiere)
    renderTimeline(); PL.refresh(); keepLater();
  });
  tlHeads.addEventListener('dblclick', (e) => { const h = e.target.closest('.th[data-t]'); if (!h || e.target.closest('[data-act]')) return; TL.tall[h.dataset.t] = !TL.tall[h.dataset.t]; renderTimeline(); });
  // the master volume: drag it
  tlHeads.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-master]');
    if (!b || !P.seq) return;
    e.preventDefault();
    const x0 = e.clientX, v0 = P.seq.master || 0;
    b.setPointerCapture(e.pointerId);
    b.onpointermove = (ev) => { P.seq.master = clamp(Math.round((v0 + (ev.clientX - x0) / 4) * 10) / 10, -60, 15); b.textContent = P.seq.master.toFixed(1); applyMaster(); };
    b.onpointerup = () => { b.onpointermove = b.onpointerup = null; keepLater(); };
  });
  function applyMaster() { if (AU.master) AU.master.gain.value = dbGain(P.seq ? P.seq.master || 0 : 0); }

  // the ruler: timecodes and ticks, the in–out range, markers, the render bar (yellow under clips that play back as
  // they are), the playhead's head
  const rulerCv = $('#rulerCv');
  function drawRuler() {
    const r = $('#ruler').getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (!r.width) return;
    if (rulerCv.width !== Math.round(r.width * dpr) || rulerCv.height !== Math.round(r.height * dpr)) { rulerCv.width = Math.round(r.width * dpr); rulerCv.height = Math.round(r.height * dpr); }
    const g = rulerCv.getContext('2d'), W = r.width, Hh = r.height;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, Hh);
    const seq = P.seq;
    if (!seq) return;
    const fps = fpsOf(seq.rate), nom = Math.round(fps);
    // in–out
    if (seq.in != null || seq.out != null) {
      const a = seq.in != null ? seq.in : 0, b = seq.out != null ? seq.out : Math.max(seqEnd(), a + 1);
      g.fillStyle = '#4b4b4b'; g.fillRect(fx2(a), 22, (b - a) * TL.ppf, 14);
    }
    // ticks: labels at least 90 px apart
    const steps = [1, 2, 5, 10, nom / 2, nom, nom * 2, nom * 5, nom * 10, nom * 15, nom * 30, nom * 60, nom * 120, nom * 300, nom * 600, nom * 1800, nom * 3600];
    const major = steps.find((s) => s * TL.ppf >= 90) || steps[steps.length - 1];
    const minorN = [10, 5, 4, 2, 1].find((n) => (major / n) * TL.ppf >= 7 && Number.isInteger(major / n)) || 1, minor = major / minorN;
    const f0 = Math.floor(TL.x0 / minor) * minor, f1 = xf2(W) + minor;
    g.fillStyle = '#6a6a6a';
    for (let f = f0; f <= f1; f += minor) { const x = Math.round(fx2(f)) + 0.5; const big = Math.round(f) % Math.round(major) === 0; g.fillRect(x - 0.5, big ? 13 : 17, 1, big ? 9 : 5); }
    g.fillStyle = '#9b9b9b'; g.font = '10.5px "Adobe Clean", "Source Sans 3 Web", sans-serif'; g.textBaseline = 'top';
    for (let f = Math.floor(TL.x0 / major) * major; f <= f1; f += major) g.fillText(tcOf(f, seq.rate), Math.round(fx2(f)) + 3, 2);
    // markers
    for (const mk of seq.markers) { const x = fx2(mk.f); if (x < -10 || x > W + 10) continue; g.fillStyle = '#4fae4f'; g.beginPath(); g.moveTo(x - 5, 22); g.lineTo(x + 5, 22); g.lineTo(x + 5, 28); g.lineTo(x, 33); g.lineTo(x - 5, 28); g.closePath(); g.fill(); }
    // the render bar
    g.fillStyle = '#c9ad0e';
    for (const c of seq.clips) if (isV(c.track) && !c.off) g.fillRect(fx2(c.start), Hh - 3, c.dur * TL.ppf, 3);
  }
  function renderPh(followed, keepView) {
    const seq = P.seq, fps = seq ? seq.rate : { num: 30, den: 1 };
    const f = PH.frame;
    if (seq && followed && !keepView && followPh()) { renderTimeline(); return; }
    if (seq && PL.playing && followPh()) { renderTimeline(); return; }
    const x = fx2(f);
    $('#tlPh').style.left = `${x}px`; $('#tlPh').hidden = !seq;
    $('#phHead').style.left = `${x}px`; $('#phHead').hidden = !seq;
    const tc = tcOf(Math.floor(f), fps);
    $('#tlTc').textContent = tc; $('#prgTc').textContent = tc;
    const end = Math.max(1, seqEnd());
    $('#prgPh').style.left = `${clamp(f / end, 0, 1) * 100}%`;
    const io = $('#prgIo'), on = !!(seq && (seq.in != null || seq.out != null));
    io.classList.toggle('on', on);
    if (on) { const a = seq.in != null ? seq.in : 0, b = seq.out != null ? seq.out : end; io.style.left = `${(a / end) * 100}%`; io.style.width = `${((b - a) / end) * 100}%`; }
    const span = seq && seq.in != null && seq.out != null ? seq.out - seq.in : seqEnd();
    $('#prgDur').textContent = tcOf(span, fps);
    placeXf();
  }
  // Premiere's zoom scroll bar
  function renderZs() {
    const zs = $('#zs'), bar = $('#zsBar'), w = zs.clientWidth, T = total(), vis = viewW() / TL.ppf;
    const bw = Math.max(24, (vis / T) * w), bx = (TL.x0 / Math.max(1, T - vis)) * (w - bw);
    bar.style.left = `${clamp(bx, 0, w - bw)}px`; bar.style.width = `${Math.min(w, bw)}px`;
  }
  $('#zs').addEventListener('pointerdown', (e) => {
    if (!P.seq) return;
    const zs = $('#zs'), bar = $('#zsBar'), h = e.target.closest('.zs-h'), x0 = e.clientX, w = zs.clientWidth;
    const T = total(), vis = viewW() / TL.ppf, start = TL.x0, ppf0 = TL.ppf;
    zs.setPointerCapture(e.pointerId);
    if (!e.target.closest('#zsBar')) { scrollTo(((e.clientX - zs.getBoundingClientRect().left) / w) * T - vis / 2); return; }
    bar.style.cursor = 'grabbing';
    zs.onpointermove = (ev) => {
      const dx = ev.clientX - x0;
      if (!h) { scrollTo(start + (dx / w) * T); return; }
      // an end dragged: the other end stays, the view zooms
      const visF = clamp(vis + (h.classList.contains('r') ? 1 : -1) * (dx / w) * T, 10, T * 4);
      TL.ppf = clamp(viewW() / visF, 0.005, 24);
      TL.x0 = h.classList.contains('l') ? Math.max(0, start + vis - viewW() / TL.ppf) : start;
      renderTimeline();
      void ppf0;
    };
    zs.onpointerup = () => { zs.onpointermove = zs.onpointerup = null; bar.style.cursor = ''; };
  });
  // the wheel scrolls the timeline sideways (with ⌥ or a pinch it zooms, with ⇧ up and down)
  tlTracks.addEventListener('wheel', (e) => {
    if (!P.seq) return;
    e.preventDefault();
    const x = e.clientX - tlTracks.getBoundingClientRect().left;
    if (e.altKey || e.ctrlKey) { zoomTo(TL.ppf * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), x); return; }
    if (e.shiftKey) { TL.y0 = clamp(TL.y0 + e.deltaY, 0, Math.max(0, rowsY().total - tlTracks.clientHeight)); renderTimeline(); return; }
    scrollTo(TL.x0 + (e.deltaX + e.deltaY) / TL.ppf);
  }, { passive: false });
  $('#ruler').addEventListener('wheel', (e) => { if (!P.seq) return; e.preventDefault(); const x = e.clientX - $('#ruler').getBoundingClientRect().left; if (e.altKey || e.ctrlKey) zoomTo(TL.ppf * Math.exp(-e.deltaY * 0.004), x); else scrollTo(TL.x0 + (e.deltaX + e.deltaY) / TL.ppf); }, { passive: false });
  // the ruler: click or drag to move the playhead
  $('#ruler').addEventListener('pointerdown', (e) => {
    if (!P.seq || e.button !== 0) return;
    setFocus('tl');
    const ruler = $('#ruler');
    ruler.setPointerCapture(e.pointerId);
    PL.stop();
    const go = (ev) => { const x = ev.clientX - ruler.getBoundingClientRect().left; let f = xf2(x); if (S.snap && ev.shiftKey) f = snapFrame(f, []).f; setPh(f, true); };
    go(e);
    ruler.onpointermove = (ev) => { if (ev.buttons) go(ev); };
    ruler.onpointerup = () => { ruler.onpointermove = ruler.onpointerup = null; };
  });

  // ---------- 時間軸: what edits do to the sequence ----------
  const clipsOn = (t) => P.seq.clips.filter((c) => c.track === t).sort((a, b) => a.start - b.start);
  const unlocked = (t) => !P.seq.tracks[t].lock;
  function cloneClip(c, patch) { return { ...JSON.parse(JSON.stringify(c)), id: uid(), ...patch }; }
  // a clip cut in two at a frame: the right part a new clip; when its partner is cut at the same frame in the same edit,
  // the two right parts are linked as the left ones are (relinkCuts, at the end of the edit)
  const CUTS = new Map();   // the clip cut → its right part, during an edit
  function cutAt(c, f) {
    if (f <= c.start || f >= cEnd(c)) return null;
    const right = cloneClip(c, { start: f, dur: cEnd(c) - f, in: c.in + fr2s(f - c.start) * c.speed, link: null });
    c.dur = f - c.start;
    P.seq.clips.push(right);
    CUTS.set(c.id, right);
    return right;
  }
  function relinkCuts() {
    for (const [id, right] of CUTS) {
      const c = clipById(id), pr = c && c.link && CUTS.get(c.link);
      if (pr && clipById(right.id) && clipById(pr.id) && pr.start === right.start) { right.link = pr.id; pr.link = right.id; }
    }
    CUTS.clear();
  }
  function splitLinked(clips, f) {
    const pairs = new Map();
    for (const c of clips) { const r = cutAt(c, f); if (r) pairs.set(c.id, r); }
    for (const [id, r] of pairs) { const c = clipById(id); if (c.link && pairs.has(c.link)) r.link = pairs.get(c.link).id; }
    return pairs;
  }
  // nothing on a track between two frames (what's partly in the way is trimmed, cut in two, or taken out)
  function clearRange(t, a, b, keep = new Set()) {
    for (const c of clipsOn(t)) {
      if (keep.has(c.id) || cEnd(c) <= a || c.start >= b) continue;
      if (c.start >= a && cEnd(c) <= b) { removeClip(c); continue; }
      if (c.start < a && cEnd(c) > b) { const r = cutAt(c, b); c.dur = a - c.start; void r; continue; }
      if (c.start < a) { c.dur = a - c.start; continue; }
      const d = b - c.start;
      c.in += fr2s(d) * c.speed; c.start = b; c.dur -= d;
    }
  }
  function removeClip(c) {
    P.seq.clips = P.seq.clips.filter((x) => x !== c);
    for (const x of P.seq.clips) if (x.link === c.id) x.link = null;
    if (P.seq.trans) P.seq.trans = P.seq.trans.filter((t) => t.in !== c.id && t.out !== c.id);
    S.sel.delete(c.id);
  }
  // room made at a frame on the tracks that move together (unlocked, sync-locked): clips across it cut, the rest pushed on
  function makeRoom(f, len, tracks) {
    for (const t of tracks) splitLinked(clipsOn(t), f);
    for (const c of P.seq.clips) if (tracks.includes(c.track) && c.start >= f) c.start += len;
    for (const mk of P.seq.markers) if (mk.f >= f) mk.f += len;
  }
  const syncTracks = (extra = []) => ALL_T.filter((t) => unlocked(t) && (P.seq.tracks[t].sync || extra.includes(t)));
  // close a span on the moving tracks; refused when a clip that isn't moving is in the way
  function closeSpan(a, b, tracks) {
    const len = b - a;
    if (len <= 0) return true;
    for (const t of tracks) for (const c of clipsOn(t)) if (c.start < b && cEnd(c) > a) return false;
    for (const c of P.seq.clips) if (tracks.includes(c.track) && c.start >= b) c.start -= len;
    for (const mk of P.seq.markers) if (mk.f >= b) mk.f -= len; else if (mk.f >= a) mk.f = a;
    return true;
  }
  const linkedOf = (c) => (c.link ? clipById(c.link) : null);
  function withLinks(ids) {
    const out = new Set(ids);
    if (S.link) for (const id of ids) { const c = clipById(id), l = c && linkedOf(c); if (l && unlocked(l.track)) out.add(l.id); }
    return out;
  }

  // media placed on the timeline (from the 專案 panel, the 來源 monitor, files dropped): each its picture on a video
  // track and its sound on an audio track, linked, one after another from a frame; overwriting what's there, or
  // inserted (what's after moves on)
  const DRAG = { media: null, only: null, range: null };
  function placeMedia(ms, at, only, mode, label, range, tracks) {
    ms = ms.filter(Boolean);
    if (!ms.length) return;
    if (!P.seq) { newSeq(ms.find((m) => m.hasV && m.kind === 'video') || ms[0]); TL.x0 = 0; renderTabs(); }
    begin(label);
    const seq = P.seq;
    let f = Math.max(0, at == null ? Math.round(PH.frame) : Math.round(at));
    const vT = tracks && tracks.v !== undefined ? tracks.v : seq.patch.v, aT = tracks && tracks.a !== undefined ? tracks.a : seq.patch.a;
    const placed = [];
    for (const m of ms) {
      const rg = range || (m.kind === 'still' ? [0, 5] : [m.srcIn != null && ms.length === 1 && range !== null ? m.srcIn : 0, m.dur]);
      const dur = Math.max(1, s2fr(rg[1] - rg[0]));
      const parts = [];
      if (m.hasV && only !== 'a' && vT && unlocked(vT)) parts.push(vT);
      if (m.hasA && only !== 'v' && aT && unlocked(aT)) parts.push(aT);
      if (!parts.length) continue;
      if (mode === 'insert') makeRoom(f, dur, syncTracks(parts));
      else for (const t of parts) clearRange(t, f, f + dur);
      const made = parts.map((t) => ({ id: uid(), mid: m.id, track: t, start: f, dur, in: rg[0], speed: 1, link: null, off: false, fit: false, pitch: false, fx: defaultFx(seq) }));
      if (made.length === 2) { made[0].link = made[1].id; made[1].link = made[0].id; }
      seq.clips.push(...made);
      placed.push(...made);
      f += dur;
    }
    S.sel = new Set(placed.map((c) => c.id));
    commit();
    PH.frame = f;
    if (TL.ppf <= 0.0051 || seq.clips.length === placed.length) zoomFit(); else renderPh(true);
    PL.refresh();
  }
  // , and . : what's marked in the 來源 monitor, at the playhead
  function srcEdit(mode) {
    const m = SRC.m;
    if (!m) { toast('先在來源監看器打開一個剪輯'); return; }
    const rg = SRC.range();
    if (!rg) return;
    placeMedia([m], PH.frame, null, mode, mode === 'insert' ? '插入' : '覆蓋', rg);
  }
  // ; and ' : the timeline's in–out range taken out of the targeted tracks (擷取 closes it up)
  function liftExtract(extract) {
    const seq = P.seq;
    if (!seq || seq.in == null || seq.out == null || seq.out <= seq.in) { toast('先在時間軸標記入點和出點（I、O）'); return; }
    const tracks = seq.targets.filter(unlocked);
    if (!tracks.length) { toast('沒有目標軌道：點軌道名稱（V1、A1…）讓它變藍'); return; }
    begin(extract ? '擷取' : '提取');
    for (const t of tracks) clearRange(t, seq.in, seq.out);
    if (extract) {
      const moving = syncTracks(tracks);
      if (!closeSpan(seq.in, seq.out, moving)) { closeSpan(seq.in, seq.out, tracks); }
      PH.frame = seq.in; seq.out = null; seq.in = null;
    }
    commit();
  }
  // ⌘K: cut at the playhead (the selected clips, or the targeted tracks; ⇧ every track)
  function addEdit(all) {
    if (!P.seq) return;
    const f = Math.round(PH.frame);
    const sel = [...S.sel].map(clipById).filter(Boolean);
    const list = all ? P.seq.clips.filter((c) => unlocked(c.track)) : sel.length ? [...withLinks(sel.map((c) => c.id))].map(clipById) : P.seq.clips.filter((c) => P.seq.targets.includes(c.track) && unlocked(c.track));
    const hit = list.filter((c) => f > c.start && f < cEnd(c));
    if (!hit.length) return;
    begin('增加編輯'); splitLinked(hit, f); commit();
  }
  function deleteSel(ripple) {
    const seq = P.seq;
    if (!seq) return;
    if (TL.gap && !S.sel.size) {
      const g = TL.gap;
      begin('波紋刪除');
      if (!closeSpan(g.a, g.b, syncTracks([g.track]))) { H.before = null; toast('其他軌道在這段有剪輯，不能波紋刪除'); return; }
      TL.gap = null; commit(); return;
    }
    if (S.trans) { begin('清除'); seq.trans = (seq.trans || []).filter((t) => t.id !== S.trans); S.trans = null; commit(); return; }
    const ids = [...S.sel].filter((id) => { const c = clipById(id); return c && unlocked(c.track); });
    if (!ids.length) return;
    begin(ripple ? '波紋刪除' : '清除');
    const gone = ids.map(clipById);
    for (const c of gone) removeClip(c);
    if (ripple) {
      // each stretch taken out closes up, the latest first
      const spans = [];
      for (const c of gone.sort((a, b) => b.start - a.start)) {
        const last = spans[spans.length - 1];
        if (last && cEnd(c) >= last.a) last.a = Math.min(last.a, c.start); else spans.push({ a: c.start, b: cEnd(c), tracks: new Set([c.track]) });
        spans[spans.length - 1].tracks.add(c.track);
      }
      for (const sp of spans) if (!closeSpan(sp.a, sp.b, syncTracks([...sp.tracks]))) { toast('其他軌道在這段有剪輯，後面沒有補上來'); }
    }
    S.sel.clear();
    commit();
  }
  function setLink(on) {
    const sel = [...S.sel].map(clipById).filter(Boolean);
    if (!sel.length) return;
    begin(on ? '連結' : '取消連結');
    if (on) {
      const v = sel.find((c) => isV(c.track)), a = sel.find((c) => !isV(c.track));
      if (!v || !a) { H.before = null; toast('選一個影片剪輯和一個聲音剪輯再連結'); return; }
      for (const c of P.seq.clips) if (c.link === v.id || c.link === a.id) c.link = null;
      v.link = a.id; a.link = v.id;
    } else for (const c of sel) { const l = linkedOf(c); if (l) l.link = null; c.link = null; }
    commit();
  }
  function setEnabled() {
    const sel = [...S.sel].map(clipById).filter(Boolean);
    if (!sel.length) return;
    begin('啟用');
    const to = sel.some((c) => !c.off);
    for (const c of sel) c.off = to;
    commit();
  }
  function copySel(cut) {
    const sel = [...withLinks(S.sel)].map(clipById).filter(Boolean);
    if (!sel.length) return;
    const t0 = Math.min(...sel.map((c) => c.start));
    S.clipboard = sel.map((c) => ({ ...JSON.parse(JSON.stringify(c)), start: c.start - t0 }));
    if (cut) deleteSel(false);
    toast(cut ? `剪下 ${sel.length} 個剪輯` : `拷貝 ${sel.length} 個剪輯`, 1400);
  }
  function paste() {
    if (!P.seq || !S.clipboard) return;
    begin('貼上');
    const f = Math.round(PH.frame), map = new Map(), made = [];
    for (const c of S.clipboard) { if (!unlocked(c.track)) continue; clearRange(c.track, f + c.start, f + c.start + c.dur); const n = { ...JSON.parse(JSON.stringify(c)), id: uid(), start: f + c.start }; map.set(c.id, n.id); made.push(n); }
    for (const n of made) n.link = n.link && map.has(n.link) ? map.get(n.link) : null;
    P.seq.clips.push(...made);
    S.sel = new Set(made.map((c) => c.id));
    PH.frame = f + Math.max(...made.map((c) => c.start + c.dur - f));
    commit();
  }

  // ---------- 時間軸: the pointer, by tool ----------
  const DRAGTL = { ghost: null };
  function snapTargets(exclude) {
    const seq = P.seq, t = [Math.round(PH.frame)];
    for (const c of seq.clips) if (!exclude.has(c.id)) t.push(c.start, cEnd(c));
    if (seq.in != null) t.push(seq.in);
    if (seq.out != null) t.push(seq.out);
    for (const mk of seq.markers) t.push(mk.f);
    return t;
  }
  // a frame pulled to the nearest edit, playhead, mark or marker within 8 px
  function snapFrame(f, edges, exclude = new Set()) {
    if (!S.snap || !P.seq) return { f, d: 0, at: null };
    const tg = snapTargets(exclude), lim = 8 / TL.ppf;
    const cands = edges.length ? edges : [f];
    let best = null;
    for (const e of cands) for (const t of tg) { const d = t - e; if (Math.abs(d) <= lim && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t }; }
    return best ? { f: f + best.d, d: best.d, at: best.at } : { f, d: 0, at: null };
  }
  function showSnap(at) { const s = $('#tlSnap'); if (at == null) { s.hidden = true; return; } s.hidden = false; s.style.left = `${fx2(at)}px`; }
  function hitAt(e) {
    const r = tlTracks.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const track = trackAtY(y), f = xf2(x);
    if (!P.seq || !track) return { x, y, track, f, clip: null, edge: null };
    const near = 6 / TL.ppf, list = clipsOn(track);
    let clip = null, edge = null;
    for (const c of list) {
      const dl = Math.abs(f - c.start) * TL.ppf, dr = Math.abs(f - cEnd(c)) * TL.ppf;
      if (f >= c.start - near && f <= cEnd(c) + near) {
        if (dr <= 6 && f <= cEnd(c) + near && (!clip || dr < 6)) { clip = c; edge = 'out'; if (f <= cEnd(c)) break; continue; }
        if (dl <= 6 && f >= c.start - near) { clip = c; edge = 'in'; if (f >= c.start) break; continue; }
        if (f >= c.start && f < cEnd(c)) { clip = c; edge = null; break; }
      }
    }
    // the edge on the side of the cut the pointer is on (left half: the clip ending there; right half: the one starting)
    if (clip && edge) {
      const other = list.find((c) => c !== clip && (edge === 'out' ? c.start === cEnd(clip) : cEnd(c) === clip.start));
      if (other) { if (edge === 'out' && f > cEnd(clip)) { clip = other; edge = 'in'; } else if (edge === 'in' && f < clip.start) { clip = other; edge = 'out'; } }
    }
    const tr = hitTrans(e);
    return { x, y, track, f, clip, edge, trans: tr };
  }
  const hitTrans = (e) => { const n = e.target.closest && e.target.closest('[data-trans]'); return n ? n.dataset.trans : null; };
  const cursorFor = (h) => {
    const tool = S.tool;
    if (!h.clip) return '';
    if (h.edge && ['sel', 'rip', 'roll', 'rate'].includes(tool)) return tool === 'rip' ? 'cur-rip' : tool === 'roll' ? 'cur-roll' : tool === 'rate' ? 'cur-rate' : 'cur-trim';
    return '';
  };
  tlTracks.addEventListener('pointermove', (e) => {
    if (e.buttons || !P.seq) return;
    const h = hitAt(e);
    tlTracks.dataset.cur = cursorFor(h);
    tlTracks.style.cursor = tlTracks.dataset.cur ? (h.edge === 'in' ? 'w-resize' : 'e-resize') : '';
  });
  tlTracks.addEventListener('pointerdown', (e) => {
    if (!P.seq || e.button !== 0) return;
    setFocus('tl');
    const h = hitAt(e);
    PL.stop();
    TL.gap = null; S.trans = null;
    if (h.trans) { S.trans = h.trans; S.sel.clear(); renderTimeline(); renderFx(); return; }
    const tool = S.tool;
    if (tool === 'hand') return handDrag(e);
    if (tool === 'zoom') { zoomTo(TL.ppf * (e.altKey ? 0.5 : 2), h.x); return; }
    if (tool === 'razor') return razorAt(h, e);
    if (tool === 'trk' || tool === 'trkb') return trackSelect(h, e, tool === 'trkb');
    if (h.clip && !unlocked(h.clip.track)) return;
    if (tool === 'slip' && h.clip) return slipDrag(h, e);
    if (tool === 'slide' && h.clip) return slideDrag(h, e);
    if (h.clip && h.edge && (tool === 'sel' || tool === 'rip' || tool === 'roll' || tool === 'rate')) {
      const mode = tool === 'rate' ? 'rate' : tool === 'roll' ? 'roll' : tool === 'rip' || e.metaKey || e.ctrlKey ? 'ripple' : 'trim';
      return trimDrag(h, e, mode);
    }
    if (h.clip) return clipDown(h, e);
    // empty: a gap selected (click), or a box drawn round clips
    return marquee(h, e);
  });
  tlTracks.addEventListener('dblclick', (e) => {
    const h = hitAt(e);
    if (!h.clip || S.tool !== 'sel') return;
    const m = mediaById(h.clip.mid);
    if (h.clip.text) { showTab('src', 'fx'); return; }
    if (m && !m.off) { SRC.open(m); SRC.seek(PL.srcTime(h.clip, clamp(Math.round(PH.frame), h.clip.start, cEnd(h.clip) - 1))); }
  });
  function capture(e, move, up) {
    tlTracks.setPointerCapture(e.pointerId);
    tlTracks.onpointermove = move;
    tlTracks.onpointerup = (ev) => { tlTracks.onpointermove = tlTracks.onpointerup = null; showSnap(null); up(ev); };
  }
  function clipDown(h, e) {
    const c = h.clip;
    if (e.shiftKey) { const ids = e.altKey ? [c.id] : [...withLinks([c.id])]; const on = S.sel.has(c.id); for (const id of ids) on ? S.sel.delete(id) : S.sel.add(id); renderTimeline(); renderFx(); renderInfo(); return; }
    if (!S.sel.has(c.id)) { S.sel = new Set(e.altKey ? [c.id] : withLinks([c.id])); renderTimeline(); renderFx(); renderInfo(); }
    moveDrag(h, e, e.altKey);
  }
  // dragging clips: along (snapping), and up or down a track (a linked clip's partner goes the same number of tracks
  // the other way from the middle); dropped they overwrite what's there (⌘: inserted, what's after moves on)
  function moveDrag(h, e, alone) {
    const ids = alone ? new Set([h.clip.id]) : withLinks(S.sel);
    const moving = [...ids].map(clipById).filter((c) => c && unlocked(c.track));
    if (!moving.length) return;
    const orig = moving.map((c) => ({ c, start: c.start, track: c.track }));
    const x0 = e.clientX, y0 = e.clientY, grabbed = h.clip;
    let df = 0, dt = 0, moved = false, dup = e.altKey && !alone ? false : false;
    const edges0 = moving.flatMap((c) => [c.start, cEnd(c)]);
    DRAGTL.ghost = null;
    capture(e, (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      if (!moved) { moved = true; begin(e.altKey && !alone ? '拷貝' : '移動'); }
      const raw = Math.round((ev.clientX - x0) / TL.ppf);
      const minStart = Math.min(...orig.map((o) => o.start));
      let d = Math.max(-minStart, raw);
      const sn = snapFrame(0, edges0.map((x) => x + d), ids);
      if (sn.at != null) d += sn.d;
      d = Math.max(-minStart, d);
      showSnap(sn.at != null ? sn.at : null);
      // tracks: rows moved, measured from the grabbed clip
      const tNow = trackAtY(ev.clientY - tlTracks.getBoundingClientRect().top);
      let steps = 0;
      if (tNow && isV(tNow) === isV(grabbed.track)) { const list = isV(tNow) ? VT : AT, a = list.indexOf(orig.find((o) => o.c === grabbed).track), b = list.indexOf(tNow); steps = b - a; }
      // every clip stays on a track of its kind that exists and isn't locked
      for (let s = steps; ; s += s > 0 ? -1 : 1) { if (orig.every((o) => { const list = isV(o.track) ? VT : AT, i = list.indexOf(o.track) + s; return i >= 0 && i < 3 && unlocked(list[i]); })) { steps = s; break; } if (s === 0) { steps = 0; break; } }
      df = d; dt = steps;
      for (const o of orig) { const list = isV(o.track) ? VT : AT; o.c.start = o.start + df; o.c.track = list[list.indexOf(o.track) + dt]; }
      renderTimeline();
      PL.refresh();
    }, (ev) => {
      if (!moved) {
        // a click: just this clip (and its partner) selected
        if (!e.shiftKey) { S.sel = new Set(e.altKey ? [grabbed.id] : withLinks([grabbed.id])); renderTimeline(); renderFx(); renderInfo(); }
        return;
      }
      const insert = ev.metaKey || ev.ctrlKey, copy = e.altKey && !alone;
      // put the clips where they were taken from, then place them for real
      const placed = orig.map((o) => ({ ...o, to: o.c.start, tt: o.c.track }));
      for (const o of placed) { o.c.start = o.start; o.c.track = o.track; }
      let list = placed.map((o) => o.c);
      if (copy) {
        const map = new Map();
        list = placed.map((o) => { const n = cloneClip(o.c, {}); map.set(o.c.id, n.id); return n; });
        list.forEach((n, i) => { n.link = placed[i].c.link && map.has(placed[i].c.link) ? map.get(placed[i].c.link) : null; });
      } else P.seq.clips = P.seq.clips.filter((c) => !ids.has(c.id));
      if (insert) {
        const at = Math.min(...placed.map((o) => o.to)), len = Math.max(...placed.map((o) => o.to + o.c.dur)) - at;
        makeRoom(at, len, syncTracks(placed.map((o) => o.tt)));
      } else for (const [i, o] of placed.entries()) clearRange(o.tt, o.to, o.to + list[i].dur);
      placed.forEach((o, i) => { list[i].start = o.to; list[i].track = o.tt; });
      P.seq.clips.push(...list);
      S.sel = new Set(list.map((c) => c.id));
      commit();
      void dup;
    });
  }
  // trimming an edge: 修剪 (the selection tool: up to the neighbour and the media's end), 波紋 (B, or ⌘: what's after
  // moves along), 滾動 (N: the cut moves, both sides trimmed), 比率伸縮 (R: the clip's speed changes instead)
  function trimDrag(h, e, mode) {
    let c = h.clip, edge = h.edge;
    const fps = fpsOf(P.seq.rate);
    // 滾動 at a cut between two clips: the left one's end and the right one's start together
    let other = null;
    if (mode === 'roll') {
      other = clipsOn(c.track).find((x) => (edge === 'out' ? x.start === cEnd(c) : cEnd(x) === c.start));
      if (!other) mode = 'trim';
      else if (edge === 'in') { const t = c; c = other; other = t; edge = 'out'; }
    }
    const part = S.link && !e.altKey ? linkedOf(c) : null;
    const pair = part && (edge === 'out' ? cEnd(part) === cEnd(c) : part.start === c.start) && unlocked(part.track) ? part : null;
    const otherPair = other && S.link && !e.altKey ? linkedOf(other) : null;
    const items = [c, pair].filter(Boolean);
    const o = items.map((x) => ({ x, start: x.start, dur: x.dur, in: x.in, speed: x.speed }));
    const oo = [other, otherPair].filter(Boolean).map((x) => ({ x, start: x.start, dur: x.dur, in: x.in }));
    // how far it can go
    let lo = -Infinity, hi = Infinity;
    for (const it of o) {
      const x = it.x, room = mediaRoom(x), neighbours = clipsOn(x.track).filter((y) => y !== x && !oo.some((q) => q.x === y));
      if (edge === 'out') {
        lo = Math.max(lo, 1 - x.dur);
        if (mode !== 'rate') hi = Math.min(hi, Math.floor(room.after * fps + 1e-6));
        if (mode === 'trim' || mode === 'rate') { const n = neighbours.find((y) => y.start >= cEnd(x)); if (n) hi = Math.min(hi, n.start - cEnd(x)); }
      } else {
        hi = Math.min(hi, x.dur - 1);
        if (mode !== 'rate') lo = Math.max(lo, -Math.floor(room.before * fps + 1e-6));
        if (mode === 'trim' || mode === 'rate') { const p = neighbours.filter((y) => cEnd(y) <= x.start).pop(); lo = Math.max(lo, p ? cEnd(p) - x.start : -x.start); }
        if (mode === 'ripple') lo = Math.max(lo, -x.start - 0);
      }
    }
    for (const it of oo) { const room = mediaRoom(it.x); hi = Math.min(hi, it.dur - 1); lo = Math.max(lo, -Math.floor(room.before * fps + 1e-6)); }
    if (mode === 'ripple') {
      // what moves (later clips on the tracks that move together) mustn't run into what doesn't
      const at = edge === 'out' ? cEnd(c) : c.start, tracks = syncTracks(items.map((x) => x.track));
      for (const t of tracks) {
        const later = clipsOn(t).filter((y) => y.start >= at && !items.includes(y)), stay = clipsOn(t).filter((y) => y.start < at && !items.includes(y));
        if (!later.length) continue;
        const gap = later[0].start - Math.max(0, ...stay.map(cEnd));
        lo = Math.max(lo, edge === 'out' ? -gap : -Infinity);
        if (edge === 'in') hi = Math.min(hi, gap + 0);
      }
    }
    const x0 = e.clientX;
    const edgeF = edge === 'out' ? cEnd(c) : c.start;
    let d = 0, moved = false;
    const laterIds = new Set();
    if (mode === 'ripple') { const at = edge === 'out' ? cEnd(c) : c.start; for (const y of P.seq.clips) if (syncTracks(items.map((x) => x.track)).includes(y.track) && y.start >= at && !items.includes(y)) laterIds.add(y.id); }
    const laterOrig = [...laterIds].map((id) => { const y = clipById(id); return { y, start: y.start }; });
    capture(e, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      if (!moved) { moved = true; begin(mode === 'rate' ? '比率伸縮' : mode === 'roll' ? '滾動編輯' : mode === 'ripple' ? '波紋修剪' : '修剪'); }
      let want = Math.round((ev.clientX - x0) / TL.ppf);
      const sn = snapFrame(edgeF + want, [], new Set([...items, ...oo.map((q) => q.x)].map((x) => x.id)));
      if (sn.at != null) want = sn.at - edgeF;
      d = clamp(want, lo, hi);
      showSnap(sn.at != null && d === want ? sn.at : null);
      for (const it of o) {
        const x = it.x;
        if (mode === 'rate') {
          const nd = it.dur + (edge === 'out' ? d : -d);
          x.speed = (it.speed * it.dur) / nd; x.dur = nd;
          if (edge === 'in') x.start = it.start + d;
        } else if (edge === 'out') x.dur = it.dur + d;
        else if (mode === 'ripple') { x.in = it.in + fr2s(d) * it.speed; x.dur = it.dur - d; }
        else { x.start = it.start + d; x.in = it.in + fr2s(d) * it.speed; x.dur = it.dur - d; }
      }
      for (const it of oo) { it.x.start = it.start + d; it.x.in = it.in + fr2s(d) * it.x.speed; it.x.dur = it.dur - d; }
      if (mode === 'ripple') { const sh = edge === 'out' ? d : -d; for (const l of laterOrig) l.y.start = l.start + sh; }
      renderTimeline();
      // the frame at the edit, on the 節目 monitor
      const show = edge === 'out' ? (mode === 'ripple' && edge === 'in' ? c.start : cEnd(c) - 1) : c.start;
      PL.show(clamp(show, 0, Math.max(0, seqEnd() - 1)), true);
    }, () => {
      if (!moved) { if (!S.sel.has(c.id)) { S.sel = new Set(withLinks([c.id])); renderTimeline(); renderFx(); } return; }
      if (mode === 'ripple') for (const mk of P.seq.markers) if (mk.f >= edgeF) mk.f += edge === 'out' ? d : -d;
      if (d === 0) { H.before = null; renderTimeline(); PL.refresh(); return; }
      commit();
    });
  }
  // 外滑 (Y): the clip stays, what part of its media it shows slides
  function slipDrag(h, e) {
    const c = h.clip, part = S.link && !e.altKey ? linkedOf(c) : null, items = [c, part].filter(Boolean);
    const o = items.map((x) => ({ x, in: x.in })), fps = fpsOf(P.seq.rate);
    let lo = -Infinity, hi = Infinity;
    for (const it of o) { const r = mediaRoom(it.x); lo = Math.max(lo, -Math.floor(r.before * fps + 1e-6)); hi = Math.min(hi, Math.floor(r.after * fps + 1e-6)); }
    const x0 = e.clientX;
    let d = 0;
    begin('外滑');
    capture(e, (ev) => {
      d = clamp(-Math.round((ev.clientX - x0) / TL.ppf), lo, hi);
      for (const it of o) it.x.in = it.in + fr2s(d) * it.x.speed;
      renderTimeline(); PL.show(c.start, true);
    }, () => { if (d) commit(); else H.before = null; PL.refresh(); });
  }
  // 內滑 (U): the clip moves between its neighbours, which are trimmed to keep up
  function slideDrag(h, e) {
    const c = h.clip, part = S.link && !e.altKey ? linkedOf(c) : null, items = [c, part].filter(Boolean), fps = fpsOf(P.seq.rate);
    const prevs = items.map((x) => clipsOn(x.track).find((y) => cEnd(y) === x.start) || null), nexts = items.map((x) => clipsOn(x.track).find((y) => y.start === cEnd(x)) || null);
    const o = items.map((x, i) => ({ x, start: x.start, p: prevs[i] && { y: prevs[i], dur: prevs[i].dur }, n: nexts[i] && { y: nexts[i], start: nexts[i].start, dur: nexts[i].dur, in: nexts[i].in } }));
    let lo = -Infinity, hi = Infinity;
    for (const it of o) {
      const free = clipsOn(it.x.track).filter((y) => y !== it.x && y !== (it.p && it.p.y) && y !== (it.n && it.n.y));
      if (it.p) { lo = Math.max(lo, 1 - it.p.dur); hi = Math.min(hi, Math.floor(mediaRoom(it.p.y).after * fps + 1e-6)); } else { const b = free.filter((y) => cEnd(y) <= it.start).pop(); lo = Math.max(lo, (b ? cEnd(b) : 0) - it.start); }
      if (it.n) { hi = Math.min(hi, it.n.dur - 1); lo = Math.max(lo, -Math.floor(mediaRoom(it.n.y).before * fps + 1e-6)); } else { const a = free.find((y) => y.start >= cEnd(it.x)); if (a) hi = Math.min(hi, a.start - cEnd(it.x)); }
    }
    const x0 = e.clientX;
    let d = 0;
    begin('內滑');
    capture(e, (ev) => {
      d = clamp(Math.round((ev.clientX - x0) / TL.ppf), lo, hi);
      for (const it of o) {
        it.x.start = it.start + d;
        if (it.p) it.p.y.dur = it.p.dur + d;
        if (it.n) { it.n.y.start = it.n.start + d; it.n.y.in = it.n.in + fr2s(d) * it.n.y.speed; it.n.y.dur = it.n.dur - d; }
      }
      renderTimeline(); PL.show(c.start, true);
    }, () => { if (d) commit(); else H.before = null; PL.refresh(); });
  }
  // 剃刀 (C): the clip cut where clicked (and its linked partner; ⌥ alone; ⇧ every track)
  function razorAt(h, e) {
    if (!h.track) return;
    let f = Math.round(h.f);
    const sn = snapFrame(f, []);
    if (sn.at != null) f = sn.at;
    const list = e.shiftKey ? P.seq.clips.filter((c) => unlocked(c.track)) : h.clip && unlocked(h.clip.track) ? [h.clip, !e.altKey && S.link ? linkedOf(h.clip) : null].filter(Boolean) : [];
    const hit = list.filter((c) => f > c.start && f < cEnd(c));
    if (!hit.length) return;
    begin('剃刀'); splitLinked(hit, f); commit();
  }
  // 向前／向後軌道選取 (A, ⇧A): everything from there on (⇧: that track only), then dragged as with the selection tool
  function trackSelect(h, e, back) {
    const f = h.f, one = e.shiftKey;
    const pick = P.seq.clips.filter((c) => unlocked(c.track) && (!one || c.track === h.track) && (back ? c.start < f : cEnd(c) > f));
    if (!pick.length) return;
    S.sel = new Set(pick.map((c) => c.id));
    renderTimeline(); renderFx(); renderInfo();
    const g = pick.find((c) => c.track === h.track) || pick[0];
    moveDrag({ ...h, clip: g }, e, false);
  }
  function handDrag(e) {
    const x0 = e.clientX, y0 = e.clientY, s0 = TL.x0, t0 = TL.y0;
    tlTracks.classList.add('drag');
    capture(e, (ev) => { TL.x0 = Math.max(0, s0 - (ev.clientX - x0) / TL.ppf); TL.y0 = clamp(t0 - (ev.clientY - y0), 0, Math.max(0, rowsY().total - tlTracks.clientHeight)); renderTimeline(); }, () => tlTracks.classList.remove('drag'));
  }
  function marquee(h, e) {
    const box = $('#tlMarquee'), r = tlTracks.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const before = e.shiftKey ? new Set(S.sel) : new Set();
    let moved = false;
    capture(e, (ev) => {
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return;
      moved = true;
      const L = Math.min(x0, x1), T = Math.min(y0, y1), Wd = Math.abs(x1 - x0), Ht = Math.abs(y1 - y0);
      box.hidden = false; box.style.cssText = `left:${L}px;top:${T}px;width:${Wd}px;height:${Ht}px`;
      const Y = rowsY(), sel = new Set(before);
      for (const c of P.seq.clips) {
        if (!unlocked(c.track)) continue;
        const cx = fx2(c.start), cw = c.dur * TL.ppf, cy = Y[c.track] - TL.y0, ch = trackH(c.track);
        if (cx < L + Wd && cx + cw > L && cy < T + Ht && cy + ch > T) for (const id of withLinks([c.id])) sel.add(id);
      }
      S.sel = sel; renderTimeline();
    }, () => {
      box.hidden = true;
      if (!moved) {
        S.sel.clear();
        // a click in a gap between clips selects the gap (Delete closes it up)
        if (h.track) {
          const list = clipsOn(h.track), f = h.f, before2 = list.filter((c) => cEnd(c) <= f).pop(), after = list.find((c) => c.start > f);
          if (after && (!before2 || f >= cEnd(before2))) TL.gap = { track: h.track, a: before2 ? cEnd(before2) : 0, b: after.start };
        }
        renderTimeline();
      }
      renderFx(); renderInfo();
    });
  }

  // dropping media dragged from the 專案 panel or the 來源 monitor: where it'll land shown as it's dragged
  function dropFrame(e) {
    const r = tlTracks.getBoundingClientRect();
    let f = Math.max(0, Math.round(xf2(e.clientX - r.left)));
    if (P.seq && S.snap) { const sn = snapFrame(f, []); if (sn.at != null) f = sn.at; }
    return f;
  }
  function dropTracks(e) {
    if (!P.seq) return null;
    const t = trackAtY(e.clientY - tlTracks.getBoundingClientRect().top);
    if (!t) return null;
    const i = (isV(t) ? VT : AT).indexOf(t);
    return isV(t) ? { v: t, a: AT[i] } : { v: VT[i], a: t };
  }
  let ghostEls = [];
  function endDropGhost() { for (const g of ghostEls) g.remove(); ghostEls = []; tlTracks.classList.remove('drop-on'); }
  tlTracks.addEventListener('dragover', (e) => {
    if (!DRAG.media) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    tlTracks.classList.add('drop-on');
    if (!P.seq) return;
    const f = dropFrame(e), tr = dropTracks(e) || { v: P.seq.patch.v, a: P.seq.patch.a }, Y = rowsY();
    endDropGhost(); tlTracks.classList.add('drop-on');
    let at = f;
    for (const m of DRAG.media) {
      const rg = DRAG.range || (m.kind === 'still' ? [0, 5] : [0, m.dur]), dur = Math.max(1, s2fr(rg[1] - rg[0]));
      for (const [t, has] of [[tr.v, m.hasV && DRAG.only !== 'a'], [tr.a, m.hasA && DRAG.only !== 'v']]) {
        if (!t || !has) continue;
        const g = el('div', { class: 'clip ghost', style: `left:${fx2(at)}px;width:${dur * TL.ppf}px;top:${Y[t] - TL.y0 + 1}px;height:${trackH(t) - 2}px;--c:${isV(t) ? 'var(--c-video)' : 'var(--c-audio)'};opacity:.6` }, el('span', { class: 'clip-name', text: m.name }));
        tlClips.append(g); ghostEls.push(g);
      }
      at += dur;
    }
  });
  tlTracks.addEventListener('dragleave', (e) => { if (!tlTracks.contains(e.relatedTarget)) endDropGhost(); });
  tlTracks.addEventListener('drop', (e) => {
    if (!DRAG.media) return;
    e.preventDefault(); e.stopPropagation();
    const ms = DRAG.media, only = DRAG.only, range = DRAG.range;
    const f = P.seq ? dropFrame(e) : 0, tr = dropTracks(e);
    DRAG.media = null; endDropGhost();
    placeMedia(ms, f, only, e.metaKey || e.ctrlKey ? 'insert' : 'overwrite', e.metaKey || e.ctrlKey ? '插入' : '覆蓋', range, tr);
  });
  new ResizeObserver(() => { renderTimeline(); drawMeters(); }).observe($('#tl'));

  // ---------- 效果控制項: the selected clip's Motion, Opacity, Speed, Volume (and a title's text) ----------
  // Values in Premiere's blue: drag sideways to change them (⇧ ten times faster), click to type.
  function scrubber(get, set, opts) {
    const fmt = opts.fmt || ((v) => String(Math.round(v * 10) / 10));
    const n = el('span', { class: 'scrub', text: fmt(get()), title: '拖曳調整，或按一下輸入' });
    n.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX, v0 = get();
      let moved = false;
      n.setPointerCapture(e.pointerId);
      n.onpointermove = (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < 2) return;
        if (!moved) { moved = true; begin(opts.label); }
        const v = clamp(v0 + (ev.clientX - x0) * (opts.step || 1) * (ev.shiftKey ? 10 : 1), opts.min ?? -Infinity, opts.max ?? Infinity);
        set(Math.round(v * 100) / 100, true);
        n.textContent = fmt(get());
      };
      n.onpointerup = () => {
        n.onpointermove = n.onpointerup = null;
        if (moved) { commit(); return; }
        const input = el('input', { class: 'scrub-in', value: String(Math.round(get() * 100) / 100) });
        n.replaceWith(input); input.select();
        const done = (ok) => {
          if (!input.isConnected) return;
          const v = parseFloat(input.value);
          input.replaceWith(n);
          if (ok && Number.isFinite(v)) { begin(opts.label); set(clamp(v, opts.min ?? -Infinity, opts.max ?? Infinity), false); commit(); }
          n.textContent = fmt(get());
        };
        input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
        input.addEventListener('blur', () => done(true));
      };
    });
    return n;
  }
  function liveFx() { PL.show(PH.frame, !PL.playing); renderTimeline(); }
  // a clip's speed changed (its media stays the same; the clip gets longer or shorter): not past the next clip
  function applySpeed(c, speed, ripple) {
    speed = clamp(speed, 0.01, 100);
    const was = c.dur, want = Math.max(1, Math.round((c.dur * c.speed) / speed));
    let dur = want;
    if (!ripple) { const n = clipsOn(c.track).find((y) => y.start >= cEnd(c) && y !== c); if (n) dur = Math.min(dur, n.start - c.start); }
    c.speed = speed; c.dur = dur;
    if (ripple && dur !== was) for (const y of P.seq.clips) if (y !== c && syncTracks([c.track]).includes(y.track) && y.start >= c.start + was && y.id !== c.link) y.start += dur - was;
    return dur;
  }
  function renderFx() {
    const body = $('#fxBody'), seq = P.seq;
    if (!seq) { fill(body, el('p', { class: 'fx-empty', text: '(沒有序列)' })); return; }
    if (S.trans) {
      const t = (seq.trans || []).find((x) => x.id === S.trans);
      if (!t) { S.trans = null; return renderFx(); }
      const fps = fpsOf(seq.rate);
      fill(body, el('p', { class: 'fx-clip', text: '黑場轉場' }), el('div', { class: 'fx-row' }, el('span', { text: '持續時間' }), scrubber(() => t.dur / fps, (v) => { t.dur = Math.max(2, Math.round(v * fps)); liveFx(); }, { label: '轉場持續時間', step: 0.05, min: 0.1, max: 10, fmt: (v) => `${v.toFixed(2)} 秒` })));
      return;
    }
    const sel = [...S.sel].map(clipById).filter(Boolean);
    const pair = sel.length === 2 && sel[0].link === sel[1].id;
    if (sel.length !== 1 && !pair) { fill(body, el('p', { class: 'fx-empty', text: sel.length ? '選一個剪輯，這裡會顯示它的效果' : '選一個剪輯，這裡會顯示它的效果' })); return; }
    const v = sel.find((c) => isV(c.track)), a = sel.find((c) => !isV(c.track)), main = v || a, m = mediaById(main.mid);
    const grp = (name, on, reset, ...rows) => el('div', { class: 'fx-grp' }, el('b', {}, el('i', { class: 'fx-tag', text: 'fx' }), name, reset ? el('button', { type: 'button', class: 'fx-reset', title: '重設', onclick: reset, text: '重設' }) : null), ...rows);
    const row = (label, ...vals) => el('div', { class: 'fx-row' }, el('span', { text: label }), el('span', { class: 'fx-vals' }, ...vals));
    const val = (c, key, label, o = {}) => scrubber(() => c.fx[key], (x) => { c.fx[key] = x; liveFx(); }, { label, ...o });
    const kids = [el('p', { class: 'fx-clip' }, `${seq.name} ＊ `, el('span', { text: clipLabel(main, m) }))];
    if (v) {
      const d = defaultFx(seq);
      kids.push(grp('運動', true, () => { begin('重設運動'); Object.assign(v.fx, { x: d.x, y: d.y, scale: 100, rot: 0 }); v.fit = false; commit(); },
        row('位置', val(v, 'x', '位置', { fmt: (x) => x.toFixed(1) }), val(v, 'y', '位置', { fmt: (x) => x.toFixed(1) })),
        row('縮放', val(v, 'scale', '縮放', { min: 0, max: 1000, step: 0.5, fmt: (x) => x.toFixed(1) })),
        row('旋轉', val(v, 'rot', '旋轉', { step: 0.5, fmt: (x) => `${x.toFixed(1)}°` })),
        v.text ? null : el('label', { class: 'fx-row chk', style: 'padding-left:30px' }, el('input', { type: 'checkbox', checked: v.fit ? '' : null, onchange: (e) => { begin('縮放為影格大小'); v.fit = e.target.checked; commit(); } }), el('span', { text: '縮放為影格大小' }))));
      kids.push(grp('不透明度', true, () => { begin('重設不透明度'); v.fx.opacity = 100; commit(); }, row('不透明度', val(v, 'opacity', '不透明度', { min: 0, max: 100, step: 0.5, fmt: (x) => `${x.toFixed(1)} %` }))));
      if (!v.text && m && m.kind === 'video') kids.push(grp('時間重對應', true, null, row('速度', scrubber(() => v.speed * 100, (x) => { applySpeed(v, x / 100, false); const l = linkedOf(v); if (l) { l.speed = v.speed; l.dur = v.dur; } liveFx(); }, { label: '速度', min: 1, max: 10000, step: 1, fmt: (x) => `${x.toFixed(2)} %` }))));
      if (v.text) {
        const ta = el('textarea', { class: 'fx-text', rows: '3' });
        ta.value = v.text.value;
        let t0 = null;
        ta.addEventListener('focus', () => { t0 = snapSeq(); });
        ta.addEventListener('input', () => { v.text.value = ta.value; liveFx(); });
        ta.addEventListener('blur', () => { if (t0 && JSON.stringify(t0) !== JSON.stringify(snapSeq())) { H.before = t0; commit('文字'); } t0 = null; });
        ta.addEventListener('keydown', (e) => e.stopPropagation());
        const color = el('input', { type: 'color', class: 'fx-color', value: v.text.color });
        color.addEventListener('change', () => { begin('文字顏色'); v.text.color = color.value; commit(); });
        kids.push(grp('文字', true, null, ta, row('大小', scrubber(() => v.text.size, (x) => { v.text.size = x; liveFx(); }, { label: '文字大小', min: 8, max: 600, step: 0.5, fmt: (x) => x.toFixed(0) })), row('顏色', color)));
      }
    }
    if (a) kids.push(grp('音量', true, () => { begin('重設音量'); a.fx.vol = 0; commit(); }, row('層級', scrubber(() => a.fx.vol, (x) => { a.fx.vol = x; liveFx(); }, { label: '音量', min: -60, max: 15, step: 0.2, fmt: (x) => (x <= -60 ? '-∞ dB' : `${x.toFixed(1)} dB`) })),
      el('label', { class: 'fx-row chk', style: 'padding-left:30px' }, el('input', { type: 'checkbox', checked: a.pitch ? '' : null, onchange: (e) => { begin('保持音訊音高'); a.pitch = e.target.checked; commit(); } }), el('span', { text: '變速時保持音訊音高（預覽）' }))));
    if (main.speed !== 1 && a) kids.push(el('p', { class: 'fx-note', text: '輸出時，變速的聲音音高會跟著變（快轉時一般會關掉聲音）。' }));
    fill(body, ...kids);
  }

  // ---------- 中繼資料, 資訊, 標記, 步驟記錄 ----------
  function kv(pairs) { return el('dl', { class: 'kv' }, ...pairs.filter((p) => p && p[1] != null && p[1] !== '').flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })])); }
  function renderMeta() {
    const body = $('#metaBody'), m = S.srcMedia || (S.prjSel.size === 1 ? mediaById([...S.prjSel][0]) : null);
    if (!m) { fill(body, el('p', { class: 'none', text: '在專案面板選一個項目' })); return; }
    const v = m.info && m.info.video, a = m.info && m.info.audio;
    fill(body, el('p', { class: 'kv-h', text: m.name }), kv([
      ['類型', m.kind === 'still' ? '圖片' : m.kind === 'audio' ? '聲音' : '影片'], ['大小', fmtBytes(m.size)], ['修改日期', m.mod ? new Date(m.mod).toLocaleString('zh-TW') : ''],
      ['格式', m.from || (m.info && m.info.format) || ''], ['長度', m.kind === 'still' ? '' : fmtClock(m.dur)],
      ['狀態', m.off ? '離線（再匯入一次同一個檔案就會接回來）' : m.conv != null ? `正在轉成瀏覽器能播放的 MP4（${pctOf(m)}）` : m.cant ? '這個瀏覽器不能播放，可以直接輸出' : m.mp4 ? '可以播放（轉成了 MP4，畫面和聲音照原檔）' : '可以播放'],
      ...(m.mp4 && !m.off ? [['轉檔', `${fmtBytes(m.mp4.size)} 的 MP4，${m.kept ? '存在這個瀏覽器裡，下次不用再轉；清除這個項目就會刪掉' : '在記憶體裡，關掉分頁就沒了'}`]] : [])]),
      v ? el('p', { class: 'kv-h', text: '影片' }) : null,
      v ? kv([['編碼', `${v.codec ? v.codec.toUpperCase() : ''}${v.str ? `（${v.str}）` : ''}`], ['畫面', `${m.w} × ${m.h}${v.rotation ? `（轉 ${v.rotation}°）` : ''}`], ['影格速率', `${Math.round(fpsOf(m.rate) * 1000) / 1000} fps`], ['位元速率', v.bitrate ? `${(v.bitrate / 1e6).toFixed(1)} Mbps` : '']]) : null,
      a ? el('p', { class: 'kv-h', text: '聲音' }) : null,
      a ? kv([['編碼', `${a.codec ? a.codec.toUpperCase() : ''}${a.str ? `（${a.str}）` : ''}`], ['取樣率', `${a.sampleRate} Hz`], ['聲道', a.channels === 1 ? '單聲道' : a.channels === 2 ? '立體聲' : `${a.channels} 聲道`]]) : null);
  }
  function renderInfo() {
    const body = $('#infoBody'), seq = P.seq;
    if (!seq) { fill(body, el('p', { class: 'none', text: '(沒有序列)' })); return; }
    const sel = [...S.sel].map(clipById).filter(Boolean), r = seq.rate;
    const c = sel.length === 1 || (sel.length === 2 && sel[0].link === sel[1].id) ? sel.find((x) => isV(x.track)) || sel[0] : null;
    fill(body, c ? el('p', { class: 'kv-h', text: clipLabel(c, mediaById(c.mid)) }) : null,
      c ? kv([['類型', c.text ? '文字' : isV(c.track) ? '影片' : '聲音'], ['軌道', c.track], ['開始', tcOf(c.start, r)], ['結束', tcOf(cEnd(c), r)], ['持續時間', tcOf(c.dur, r)], ['媒體入點', `${c.in.toFixed(2)} 秒`], ['速度', `${Math.round(c.speed * 10000) / 100} %`]]) : sel.length ? el('p', { class: 'kv-h', text: `已選取 ${sel.length} 個剪輯` }) : null,
      el('p', { class: 'kv-h', text: seq.name }),
      kv([['畫面', `${seq.w} × ${seq.h}`], ['影格速率', `${Math.round(fpsOf(r) * 1000) / 1000} fps`], ['播放磁頭', tcOf(PH.frame, r)], ['長度', tcOf(seqEnd(), r)], ['入點', seq.in != null ? tcOf(seq.in, r) : '—'], ['出點', seq.out != null ? tcOf(seq.out, r) : '—']]));
  }
  function renderMarks() {
    const body = $('#marksBody'), seq = P.seq;
    if (!seq || !seq.markers.length) { fill(body, el('p', { class: 'none', text: '按 M 在播放磁頭增加標記' })); return; }
    fill(body, ...seq.markers.slice().sort((a, b) => a.f - b.f).map((mk) => el('div', { class: 'mrow', 'data-mk': mk.id, title: '按一下移到這裡，按兩下編輯' }, el('i'), el('span', { class: 'tc', text: tcOf(mk.f, seq.rate) }), el('span', { text: mk.name || mk.note || '' }))));
  }
  $('#marksBody').addEventListener('click', (e) => { const r = e.target.closest('[data-mk]'); if (!r) return; const mk = P.seq.markers.find((x) => x.id === r.dataset.mk); if (mk) { PL.stop(); setPh(mk.f); } });
  $('#marksBody').addEventListener('dblclick', (e) => { const r = e.target.closest('[data-mk]'); if (r) editMarker(r.dataset.mk); });
  // a marker on the ruler double-clicked: its dialog
  $('#ruler').addEventListener('dblclick', (e) => {
    if (!P.seq) return;
    const x = e.clientX - $('#ruler').getBoundingClientRect().left, mk = P.seq.markers.find((m) => Math.abs(fx2(m.f) - x) <= 5);
    if (mk) editMarker(mk.id);
  });
  function renderHist() {
    const body = $('#histBody');
    const rows = [el('div', { class: `hrow${!H.undo.length ? ' on' : ''}`, 'data-h': '0', text: '開始' }), ...H.undo.map((u, i) => el('div', { class: `hrow${i === H.undo.length - 1 ? ' on' : ''}`, 'data-h': String(i + 1), text: u.label })), ...H.redo.slice().reverse().map((r, i) => el('div', { class: 'hrow fut', 'data-r': String(i + 1), text: r.label }))];
    fill(body, ...rows);
  }
  $('#histBody').addEventListener('click', (e) => {
    const r = e.target.closest('.hrow');
    if (!r) return;
    if (r.dataset.h != null) { const want = +r.dataset.h; while (H.undo.length > want) doUndo(); }
    else if (r.dataset.r != null) { const n = +r.dataset.r; for (let i = 0; i < n; i++) doRedo(); }
  });

  // ---------- 標記 ----------
  // (M on a marker opens it, as Premiere's M M does)
  function addMarker() {
    if (!P.seq) return;
    const f = Math.round(PH.frame), at = P.seq.markers.find((mk) => mk.f === f);
    if (at) { editMarker(at.id); return; }
    begin('增加標記');
    P.seq.markers.push({ id: uid(), f, name: '', note: '' });
    commit();
  }
  function editMarker(id) {
    const mk = P.seq.markers.find((x) => x.id === id);
    if (!mk) return;
    const d = $('#dlgMarker');
    $('#mkName').value = mk.name; $('#mkNote').value = mk.note; $('#mkAt').textContent = `位置：${tcOf(mk.f, P.seq.rate)}`;
    d.showModal();
    $('#mkOk').onclick = () => { begin('標記'); mk.name = $('#mkName').value; mk.note = $('#mkNote').value; commit(); };
    $('#mkDel').onclick = () => { begin('清除標記'); P.seq.markers = P.seq.markers.filter((x) => x !== mk); commit(); d.close(); };
    $('#mkCancel').onclick = () => d.close();
  }
  function goMarker(dir) {
    if (!P.seq || !P.seq.markers.length) return;
    const f = Math.round(PH.frame), list = P.seq.markers.map((m) => m.f).sort((a, b) => a - b);
    const to = dir > 0 ? list.find((x) => x > f) : list.filter((x) => x < f).pop();
    if (to != null) { PL.stop(); setPh(to); }
  }

  // ---------- 黑場轉場 (⌘D): the picture (and sound) dips to black and back at the cut nearest the playhead ----------
  function addTransition() {
    const seq = P.seq;
    if (!seq) return;
    const f = Math.round(PH.frame), fps = fpsOf(seq.rate), dur = Math.round(fps);
    const tracks = seq.targets.filter((t) => isV(t) && unlocked(t));
    let done = 0;
    begin('套用轉場');
    seq.trans = seq.trans || [];
    for (const t of tracks.length ? tracks : ['V1']) {
      const list = clipsOn(t);
      // the cut, start or end nearest the playhead
      let best = null;
      for (const c of list) for (const at of [c.start, cEnd(c)]) if (!best || Math.abs(at - f) < Math.abs(best.at - f)) best = { at, c };
      if (!best || Math.abs(best.at - f) > fps * 2) continue;
      const a = list.find((c) => cEnd(c) === best.at) || null, b = list.find((c) => c.start === best.at) || null;
      const add = (out, inn) => {
        if (seq.trans.some((x) => x.out === (out && out.id) && x.in === (inn && inn.id))) return;
        seq.trans.push({ id: uid(), kind: 'dip', out: out ? out.id : null, in: inn ? inn.id : null, dur: Math.min(dur, out ? out.dur : dur, inn ? inn.dur : dur) });
        done++;
      };
      add(a, b);
      // the sound fades with it
      const la = a && linkedOf(a), lb = b && linkedOf(b);
      if (la || lb) add(la, lb);
    }
    if (!done) { H.before = null; toast('把播放磁頭移到兩個剪輯之間的剪接點，再按 ⌘D'); return; }
    commit();
  }
  // fades for a clip from its transitions (frames → seconds for the film)
  function fadesOf(c) {
    let fi = 0, fo = 0;
    for (const t of P.seq.trans || []) {
      const two = t.out && t.in && clipById(t.out) && clipById(t.in), half = two ? t.dur / 2 : t.dur;
      if (t.out === c.id) fo = Math.max(fo, half);
      if (t.in === c.id) fi = Math.max(fi, half);
    }
    return { fadeIn: fr2s(fi), fadeOut: fr2s(fo) };
  }
  PL.fade = function (c) {
    let a = 1;
    const f = PH.frame;
    for (const t of P.seq.trans || []) {
      const two = t.out && t.in && clipById(t.out) && clipById(t.in), half = two ? t.dur / 2 : t.dur;
      if (t.out === c.id && f > cEnd(c) - half) a = Math.min(a, (cEnd(c) - f) / half);
      if (t.in === c.id && f < c.start + half) a = Math.min(a, (f - c.start) / half);
    }
    return clamp(a, 0, 1);
  };

  // ---------- 文字 (T): click on the 節目 monitor, a title there (5 seconds, on the first free video track) ----------
  $('#prgView').addEventListener('pointerdown', (e) => {
    if (S.tool !== 'type' || !P.seq || e.target.closest('#xf')) return;
    const fr = $('#prgFrame').getBoundingClientRect();
    if (e.clientX < fr.left || e.clientX > fr.right || e.clientY < fr.top || e.clientY > fr.bottom) return;
    e.preventDefault();   // (the focus goes to the title's text, not to the page)
    const seq = P.seq, f = Math.round(PH.frame), dur = Math.round(fpsOf(seq.rate) * 5);
    const t = ['V2', 'V3', 'V1'].find((tr) => unlocked(tr) && !clipsOn(tr).some((c) => c.start < f + dur && cEnd(c) > f));
    if (!t) { toast('V2、V3 在這段都有東西了'); return; }
    begin('文字');
    const c = { id: uid(), mid: null, track: t, start: f, dur, in: 0, speed: 1, link: null, off: false, fit: false, pitch: false, fx: { ...defaultFx(seq), x: (e.clientX - fr.left) / PL.k, y: (e.clientY - fr.top) / PL.k }, text: { value: '新增文字', size: Math.round(seq.h / 12), color: '#ffffff' } };
    seq.clips.push(c);
    S.sel = new Set([c.id]);
    commit();
    setTool('sel');
    showTab('src', 'fx');
    const ta = $('#fxBody .fx-text');
    if (ta) { ta.focus(); ta.select(); }
  });

  // ---------- panels: tabs, focus, edges to drag, ` to fill the frame ----------
  function showTab(panel, tab) {
    const fr = $(`[data-panel="${panel}"]`);
    if (!fr) return;
    for (const t of $$('.tab', fr)) t.classList.toggle('on', t.dataset.tab === tab);
    for (const b of $$('.tab-body', fr)) b.hidden = b.dataset.body !== tab;
    if (tab === 'src') SRC.fit();
    if (tab === 'fx') renderFx();
    if (tab === 'meta') renderMeta();
    if (tab === 'info') renderInfo();
    if (tab === 'marks') renderMarks();
    if (tab === 'hist') renderHist();
  }
  document.addEventListener('click', (e) => {
    const menu = e.target.closest('.tab-menu');
    if (menu) { e.stopPropagation(); panelMenu(menu.dataset.menu, e); return; }
    const x = e.target.closest('.tab-x');
    if (x) { e.stopPropagation(); closeSeq(); return; }
    const t = e.target.closest('.tab');
    if (t) { const fr = t.closest('[data-panel]'); showTab(fr.dataset.panel, t.dataset.tab); }
  });
  function setFocus(name) {
    S.focus = name;
    for (const f of $$('.frame')) f.classList.toggle('focus', f.dataset.panel === name);
  }
  for (const f of $$('.frame')) f.addEventListener('pointerdown', () => { if (['src', 'prg', 'tl', 'prj'].includes(f.dataset.panel)) setFocus(f.dataset.panel); }, true);
  function renderTabs() {
    const seq = P.seq;
    $('#prgTabName').textContent = seq ? `節目：${seq.name}` : '節目：(無序列)';
    $('#tlTabName').textContent = seq ? seq.name : '(無序列)';
    $('#exSeqName').textContent = seq ? seq.name : '';
    $('#mExport').disabled = !(seq && seq.clips.length);
    for (const b of $$('#prgTransport button')) b.disabled = !seq;
  }
  // the gaps between panels: dragged, they resize (kept for next time)
  const LAYOUT = 'zt-cut-layout';
  try { const v = JSON.parse(localStorage.getItem(LAYOUT)) || {}; for (const k of ['top-h', 'src-w', 'prj-w']) if (v[k]) $('#ws').style.setProperty(`--${k}`, v[k]); } catch {}
  for (const rz of $$('.rz')) {
    rz.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      rz.setPointerCapture(e.pointerId); rz.classList.add('on');
      const ws = $('#ws'), which = rz.dataset.rz;
      rz.onpointermove = (ev) => {
        if (which === 'top') { const r = ws.getBoundingClientRect(); ws.style.setProperty('--top-h', `${clamp(((ev.clientY - r.top) / r.height) * 100, 18, 80)}%`); }
        else if (which === 'src') { const r = $('#rowTop').getBoundingClientRect(); ws.style.setProperty('--src-w', `${clamp(((ev.clientX - r.left) / r.width) * 100, 15, 85)}%`); }
        else { const r = $('#rowBot').getBoundingClientRect(); ws.style.setProperty('--prj-w', `${clamp(((ev.clientX - r.left) / r.width) * 100, 12, 60)}%`); }
      };
      rz.onpointerup = () => {
        rz.onpointermove = rz.onpointerup = null; rz.classList.remove('on');
        try { localStorage.setItem(LAYOUT, JSON.stringify({ 'top-h': ws.style.getPropertyValue('--top-h'), 'src-w': ws.style.getPropertyValue('--src-w'), 'prj-w': ws.style.getPropertyValue('--prj-w') })); } catch {}
      };
    });
  }
  let hoverFrame = null;
  addEventListener('pointermove', (e) => { hoverFrame = e.target.closest && e.target.closest('.frame'); }, { passive: true });
  document.addEventListener('dblclick', (e) => { const t = e.target.closest && e.target.closest('.frame .tab'); if (t && !e.target.closest('.tab-menu, .tab-x')) { hoverFrame = t.closest('.frame'); toggleMax(); } });
  function toggleMax() {
    const ws = $('#ws'), on = ws.classList.contains('max');
    for (const f of $$('.frame')) f.classList.remove('maxed');
    if (on) ws.classList.remove('max');
    else { const f = hoverFrame || $(`[data-panel="${S.focus}"]`); if (!f || f.id === 'fTools' || f.id === 'fMeter') return; ws.classList.add('max'); f.classList.add('maxed'); }
    requestAnimationFrame(() => { PL.fit(); SRC.fit(); renderTimeline(); });
  }

  // ---------- 工具 ----------
  const TOOLS = {
    sel: ['i-sel', '選取工具', 'V'], trk: ['i-trk', '向前軌道選取工具', 'A'], trkb: ['i-trkb', '向後軌道選取工具', '⇧A'],
    rip: ['i-rip', '波紋編輯工具', 'B'], roll: ['i-roll', '滾動編輯工具', 'N'], rate: ['i-rate', '比率伸縮工具', 'R'], razor: ['i-razor', '剃刀工具', 'C'],
    slip: ['i-slip', '外滑工具', 'Y'], slide: ['i-slide', '內滑工具', 'U'], hand: ['i-hand', '手形工具', 'H'], zoom: ['i-zoom', '縮放工具', 'Z'], type: ['i-type', '文字工具', 'T'],
  };
  const GROUPS = { trk: ['trk', 'trkb'], rip: ['rip', 'roll', 'rate'], slip: ['slip', 'slide'], hand: ['hand', 'zoom'] };
  const groupOf = (t) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(t)) || null;
  function setTool(t) {
    S.tool = t;
    const g = groupOf(t);
    for (const b of $$('#fTools .tool')) {
      const mine = b.dataset.group ? b.dataset.group === g : b.dataset.tool === t;
      if (b.dataset.group && b.dataset.group === g) { b.dataset.tool = t; b.firstElementChild.firstElementChild.setAttribute('href', `#${TOOLS[t][0]}`); b.title = `${TOOLS[t][1]} (${TOOLS[t][2]})`; }
      b.classList.toggle('on', mine);
    }
    tlTracks.className = `tl-tracks${t !== 'sel' ? ` t-${t}` : ''}`;
    $('#prgView').style.cursor = t === 'type' ? 'text' : '';
  }
  let flyTimer = 0;
  function flyout(b) {
    const g = b.dataset.group, fly = $('#flyout'), r = b.getBoundingClientRect();
    fill(fly, ...GROUPS[g].map((t) => el('button', { type: 'button', class: S.tool === t ? 'on' : '', 'data-t': t }, svgUse(TOOLS[t][0]), el('span', { text: TOOLS[t][1] }), el('em', { text: TOOLS[t][2] }))));
    fly.hidden = false;
    fly.style.left = `${r.right + 4}px`; fly.style.top = `${Math.min(r.top, innerHeight - fly.offsetHeight - 8)}px`;
  }
  $('#fTools').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.tool');
    if (!b) return;
    if (b.dataset.group) { clearTimeout(flyTimer); flyTimer = setTimeout(() => flyout(b), 350); }
  });
  $('#fTools').addEventListener('pointerup', (e) => {
    const b = e.target.closest('.tool');
    clearTimeout(flyTimer);
    if (!b || !$('#flyout').hidden) return;
    setTool(b.dataset.tool);
  });
  $('#fTools').addEventListener('contextmenu', (e) => { const b = e.target.closest('.tool'); if (b && b.dataset.group) { e.preventDefault(); flyout(b); } });
  $('#flyout').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) { setTool(b.dataset.t); $('#flyout').hidden = true; } });

  // ---------- dialogs ----------
  function speedDialog() {
    const sel = [...S.sel].map(clipById).filter((c) => c && !c.text);
    if (!sel.length) { toast('先選剪輯'); return; }
    const main = sel.find((c) => isV(c.track)) || sel[0], d = $('#dlgSpeed'), r = P.seq.rate;
    let link = true;
    const sp = $('#spSpeed'), du = $('#spDur');
    sp.value = String(Math.round(main.speed * 10000) / 100);
    du.value = tcOf(main.dur, r); du.disabled = sel.length > 2;
    $('#spPitch').checked = !!(sel.find((c) => !isV(c.track)) || {}).pitch;
    $('#spRipple').checked = false;
    $('#spLink').classList.add('on'); $('#spLink').setAttribute('aria-pressed', 'true');
    $('#spLink').onclick = () => { link = !link; $('#spLink').classList.toggle('on', link); $('#spLink').setAttribute('aria-pressed', String(link)); };
    sp.oninput = () => { const v = parseFloat(sp.value); if (link && v > 0) du.value = tcOf(Math.max(1, Math.round((main.dur * main.speed * 100) / v)), r); };
    du.oninput = () => { const f = framesOfTc(du.value, r); if (link && f > 0) sp.value = String(Math.round(((main.dur * main.speed) / f) * 10000) / 100); };
    d.showModal(); sp.select();
    $('#spCancel').onclick = () => d.close();
    $('#spOk').onclick = (e) => {
      e.preventDefault();
      const v = parseFloat(sp.value);
      if (!(v > 0)) { sp.focus(); return; }
      begin('速度/持續時間');
      const ripple = $('#spRipple').checked;
      const done = new Set();
      for (const c of sel) {
        if (done.has(c.id)) continue;
        applySpeed(c, v / 100, ripple);
        done.add(c.id);
        const l = linkedOf(c);
        if (l && sel.includes(l)) { l.speed = c.speed; l.dur = c.dur; done.add(l.id); }
        if (!isV(c.track)) c.pitch = $('#spPitch').checked;
      }
      commit();
      d.close();
    };
  }
  function seqDialog() {
    const seq = P.seq;
    if (!seq) return;
    const d = $('#dlgSeq');
    $('#sqName').value = seq.name; $('#sqW').value = seq.w; $('#sqH').value = seq.h;
    const fps = fpsOf(seq.rate), opt = [...$('#sqFps').options].reduce((b, o) => (Math.abs(+o.value - fps) < Math.abs(+b.value - fps) ? o : b));
    $('#sqFps').value = opt.value; $('#sqFps').disabled = seq.clips.length > 0;
    d.showModal();
    $('#sqCancel').onclick = () => d.close();
    $('#sqOk').onclick = (e) => {
      e.preventDefault();
      const w = Math.round(+$('#sqW').value / 2) * 2, h = Math.round(+$('#sqH').value / 2) * 2;
      if (!(w >= 16 && h >= 16)) return;
      begin('序列設定');
      const kx = w / seq.w, ky = h / seq.h;
      for (const c of seq.clips) { c.fx.x *= kx; c.fx.y *= ky; }
      seq.name = $('#sqName').value.trim() || seq.name; seq.w = w; seq.h = h;
      if (!seq.clips.length) seq.rate = rateOf(+$('#sqFps').value);
      commit(); d.close(); PL.fit(); renderTabs();
    };
  }
  function closeSeq() {
    if (!P.seq) return;
    if (P.seq.clips.length && !confirm(`關閉「${P.seq.name}」？上面的剪輯會拿掉（之後無法復原）。`)) return;
    PL.stop();
    P.seq = null; S.sel.clear(); H.undo.length = 0; H.redo.length = 0;
    changed(); PL.fit();
  }
  $('#keysOk').onclick = () => $('#dlgKeys').close();
  $('#bKeys').addEventListener('click', () => $('#dlgKeys').showModal());

  // ---------- menus (right-click, and each panel's ≡) ----------
  const K = (k) => (MAC ? k : k.replace('⌘', 'Ctrl+').replace('⌃', 'Ctrl+').replace('⌥', 'Alt+').replace('⇧', 'Shift+').replace('⌫', 'Delete'));
  // on Windows the keys as Windows writes them (Ctrl, Alt, Shift)
  if (!MAC) {
    for (const k of $$('kbd')) k.textContent = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' }[k.textContent] || k.textContent;
    for (const k of $$('kbd')) { const b = k.previousElementSibling; if (k.textContent === 'Ctrl' && b && b.tagName === 'KBD' && b.textContent === 'Shift') k.after(b); }   // Ctrl+Shift, Windows's order
    for (const n of $$('[title]')) if (/[⌘⌥⇧]/.test(n.title)) n.title = K(n.title);
  }
  function cmenu(x, y, items) {
    const mnu = $('#cmenu');
    fill(mnu, ...items.filter(Boolean).map((it) => (it === '-' ? el('hr') : el('button', { type: 'button', class: it.check ? 'chk-on' : '', disabled: it.disabled ? '' : null, onclick: () => { mnu.hidden = true; it.act(); } }, el('span', { text: it.label }), it.key ? el('em', { text: K(it.key) }) : null))));
    mnu.hidden = false;
    mnu.style.left = `${Math.min(x, innerWidth - mnu.offsetWidth - 6)}px`;
    mnu.style.top = `${Math.min(y, innerHeight - mnu.offsetHeight - 6)}px`;
  }
  addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#cmenu')) $('#cmenu').hidden = true;
    if (!e.target.closest('#flyout') && !e.target.closest('.tool.grp')) $('#flyout').hidden = true;
  }, true);
  tlTracks.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!P.seq) return;
    const h = hitAt(e);
    if (h.trans) { S.trans = h.trans; renderTimeline(); cmenu(e.clientX, e.clientY, [{ label: '清除', key: '⌫', act: () => deleteSel(false) }]); return; }
    if (h.clip) {
      const c = h.clip;
      if (!S.sel.has(c.id)) { S.sel = new Set(withLinks([c.id])); renderTimeline(); renderFx(); renderInfo(); }
      const m = mediaById(c.mid), linked = [...S.sel].some((id) => clipById(id) && clipById(id).link);
      cmenu(e.clientX, e.clientY, [
        { label: '剪下', key: '⌘X', act: () => copySel(true) }, { label: '拷貝', key: '⌘C', act: () => copySel(false) }, { label: '貼上', key: '⌘V', act: paste, disabled: !S.clipboard },
        { label: '清除', key: '⌫', act: () => deleteSel(false) }, { label: '波紋刪除', key: '⇧⌫', act: () => deleteSel(true) }, '-',
        { label: '啟用', key: '⇧E', check: !c.off, act: setEnabled }, linked ? { label: '取消連結', key: '⌘L', act: () => setLink(false) } : { label: '連結', key: '⌘L', act: () => setLink(true), disabled: S.sel.size !== 2 }, '-',
        { label: '速度/持續時間…', key: '⌘R', act: speedDialog, disabled: !!c.text }, { label: '縮放為影格大小', check: !!c.fit, act: () => { begin('縮放為影格大小'); const to = !c.fit; for (const id of S.sel) { const x = clipById(id); if (x && isV(x.track)) x.fit = to; } commit(); }, disabled: !isV(c.track) || !!c.text }, '-',
        { label: '在來源監看器中開啟', act: () => { if (m && !m.off) { SRC.open(m); SRC.seek(c.in); } }, disabled: !m || m.off }, { label: '在專案中顯示', act: () => { if (m) { S.prjSel = new Set([m.id]); showTab('prj', 'prj'); renderPrj(); } }, disabled: !m },
      ]);
      return;
    }
    S.sel.clear(); TL.gap = null;
    marqueeGap(h);
    cmenu(e.clientX, e.clientY, [{ label: '波紋刪除', act: () => deleteSel(true), disabled: !TL.gap }, { label: '貼上', key: '⌘V', act: paste, disabled: !S.clipboard }]);
  });
  function marqueeGap(h) {
    if (!h.track) return;
    const list = clipsOn(h.track), f = h.f, b0 = list.filter((c) => cEnd(c) <= f).pop(), a0 = list.find((c) => c.start > f);
    if (a0 && (!b0 || f >= cEnd(b0))) TL.gap = { track: h.track, a: b0 ? cEnd(b0) : 0, b: a0.start };
    renderTimeline();
  }
  $('#ruler').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!P.seq) return;
    cmenu(e.clientX, e.clientY, [{ label: '標記入點', key: 'I', act: () => markSeq('in') }, { label: '標記出點', key: 'O', act: () => markSeq('out') }, { label: '清除入點和出點', key: '⌥X', act: () => markSeq('clear') }, '-',
      { label: '增加標記', key: 'M', act: addMarker }, { label: '清除所有標記', act: () => { begin('清除所有標記'); P.seq.markers = []; commit(); }, disabled: !P.seq.markers.length }]);
  });
  prjItems.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const it = e.target.closest('[data-id]'), m = it && mediaById(it.dataset.id);
    if (!m) { cmenu(e.clientX, e.clientY, [{ label: '匯入…', key: '⌘I', act: pickFiles }, '-', { label: '新增專案（全部清空）', act: newProject }]); return; }
    if (!S.prjSel.has(m.id)) { S.prjSel = new Set([m.id]); paintPrjSel(); }
    cmenu(e.clientX, e.clientY, [{ label: '在來源監看器中開啟', act: () => SRC.open(m), disabled: m.off }, { label: '從剪輯新增序列', act: () => { if (P.seq && P.seq.clips.length && !confirm('換成新的序列？目前的序列會關掉。')) return; P.seq = null; placeMedia([m], 0, null, 'overwrite', '新增序列'); }, disabled: m.off }, '-',
      { label: '插入到時間軸', key: ',', act: () => placeMedia([...S.prjSel].map(mediaById).filter((x) => x && !x.off), PH.frame, null, 'insert', '插入'), disabled: m.off }, { label: '覆蓋到時間軸', key: '.', act: () => placeMedia([...S.prjSel].map(mediaById).filter((x) => x && !x.off), PH.frame, null, 'overwrite', '覆蓋'), disabled: m.off }, '-',
      { label: '重新命名…', act: () => { const n = prompt('名稱', m.name); if (n && n.trim()) { m.name = n.trim(); renderPrj(); renderTimeline(); keepLater(); } } }, { label: '清除', key: '⌫', act: () => removeMedia([...S.prjSel]) }]);
  });
  function panelMenu(which, e) {
    const x = e.clientX, y = e.clientY;
    if (which === 'src') cmenu(x, y, [{ label: '清除入點和出點', key: '⌥X', act: () => SRC.mark('clear'), disabled: !SRC.m }, { label: '關閉', act: () => SRC.close(), disabled: !SRC.m }]);
    else if (which === 'prg') cmenu(x, y, [{ label: '適合', act: () => { $('#prgZoom').value = 'fit'; PL.fit(); } }, { label: '100%', act: () => { $('#prgZoom').value = '100'; PL.fit(); } }]);
    else if (which === 'tl') cmenu(x, y, [{ label: '序列設定…', act: seqDialog, disabled: !P.seq }, { label: '關閉序列', act: closeSeq, disabled: !P.seq }]);
    else if (which === 'prj') cmenu(x, y, [{ label: '匯入…', key: '⌘I', act: pickFiles }, { label: '重新命名專案…', act: () => { const n = prompt('專案名稱', P.name); if (n && n.trim()) { P.name = n.trim(); renderPrjName(); keepLater(); } } }, '-', { label: '新增專案（全部清空）', act: newProject }]);
  }
  $('#tSet').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); cmenu(r.left, r.bottom + 4, [{ label: '顯示影片縮圖', check: S.thumbs, act: () => { S.thumbs = !S.thumbs; renderTimeline(); } }, { label: '顯示音訊波形', check: S.waves, act: () => { S.waves = !S.waves; renderTimeline(); } }, '-', { label: '展開所有軌道', act: () => { for (const t of ORDER) TL.tall[t] = true; renderTimeline(); } }, { label: '最小化所有軌道', act: () => { for (const t of ORDER) TL.tall[t] = false; renderTimeline(); } }]); });
  $('#tSnap').addEventListener('click', () => toggleSnap());
  $('#tLink').addEventListener('click', () => { S.link = !S.link; $('#tLink').classList.toggle('on', S.link); $('#tLink').setAttribute('aria-pressed', String(S.link)); });
  $('#tMark').addEventListener('click', addMarker);
  function toggleSnap() { S.snap = !S.snap; $('#tSnap').classList.toggle('on', S.snap); $('#tSnap').setAttribute('aria-pressed', String(S.snap)); toast(S.snap ? '靠齊：開' : '靠齊：關', 1200); }
  function newProject() {
    if (P.media.length && !confirm('清空整個專案（匯入的媒體和序列）？')) return;
    PL.stop(); SRC.close();
    stopConverting(P.media);
    for (const m of P.media) if (m.url) URL.revokeObjectURL(m.url);
    E.kept().then((kept) => { for (const name of kept.keys()) E.unkeep(name); });
    P.media = []; P.seq = null; P.name = '未命名'; P.seqN = 0; S.sel.clear(); S.prjSel.clear(); H.undo.length = 0; H.redo.length = 0;
    db.del('project').catch(() => {});
    renderPrj(); changed(); PL.fit(); $('#projDirty').hidden = true;
    setMode('import');
  }

  // ---------- the transport buttons ----------
  function markSeq(which) {
    const seq = P.seq;
    if (!seq) return;
    begin(which === 'in' ? '標記入點' : which === 'out' ? '標記出點' : '清除入點和出點');
    const f = Math.round(PH.frame);
    if (which === 'in') { seq.in = f; if (seq.out != null && seq.out <= f) seq.out = null; }
    else if (which === 'out') { seq.out = Math.max(1, f); if (seq.in != null && seq.in >= seq.out) seq.in = null; }
    else if (which === 'clearIn') seq.in = null;
    else if (which === 'clearOut') seq.out = null;
    else { seq.in = null; seq.out = null; }
    commit();
  }
  function editPoints() { const s = new Set([0]); for (const c of P.seq.clips) { s.add(c.start); s.add(cEnd(c)); } return [...s].sort((a, b) => a - b); }
  function goEdit(dir) {
    if (!P.seq) return;
    const f = Math.round(PH.frame), pts = editPoints();
    const to = dir > 0 ? pts.find((x) => x > f) : pts.filter((x) => x < f).pop();
    if (to != null) { PL.stop(); setPh(to); }
  }
  async function exportFrame(which) {
    try {
      let cv, name;
      if (which === 'src') {
        const m = SRC.m;
        if (!m) return;
        if (m.kind === 'still') { cv = m.poster; name = m.name; }
        else { cv = await E.thumb(m.info, SRC.time(), m.w); name = `${m.name.replace(/\.[^.]+$/, '')}_${tcOf(SRC.frame(), SRC.rate()).replace(/[:;]/g, '')}`; }
      } else {
        if (!P.seq) return;
        cv = await E.still(planFor(Math.round(PH.frame), Math.round(PH.frame) + 1), fr2s(Math.round(PH.frame)), P.seq.w);
        name = `${P.seq.name}_${tcOf(PH.frame, P.seq.rate).replace(/[:;]/g, '')}`;
      }
      if (!cv) { toast('這個影格讀不到'); return; }
      const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/png' }) : await new Promise((r) => cv.toBlob(r, 'image/png'));
      const a = el('a', { href: URL.createObjectURL(blob), download: `${name}.png` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast('匯出影格：已下載 PNG', 1800);
    } catch (e) { console.error(e); toast('匯出影格沒有成功'); }
  }
  $('#srcTransport').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || !SRC.m) return;
    const a = b.dataset.act;
    if (a === 'play') SRC.toggle(); else if (a === 'in' || a === 'out') SRC.mark(a); else if (a === 'goin') SRC.seek(SRC.m.srcIn || 0); else if (a === 'goout') SRC.seek(SRC.m.srcOut != null ? SRC.m.srcOut : SRC.dur());
    else if (a === 'sb') SRC.step(-1); else if (a === 'sf') SRC.step(1); else if (a === 'insert') srcEdit('insert'); else if (a === 'overwrite') srcEdit('overwrite'); else if (a === 'frame') exportFrame('src'); else if (a === 'full') toggleFull('src');
    else if (a === 'mark') toast('來源剪輯的標記：這個版本只在時間軸上加標記', 2200);
  });
  $('#prgTransport').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || !P.seq) return;
    const a = b.dataset.act;
    if (a === 'play') PL.toggle(); else if (a === 'in' || a === 'out') markSeq(a); else if (a === 'mark') addMarker();
    else if (a === 'goin') { PL.stop(); setPh(P.seq.in != null ? P.seq.in : 0); } else if (a === 'goout') { PL.stop(); setPh(P.seq.out != null ? P.seq.out : seqEnd()); }
    else if (a === 'sb') { PL.stop(); setPh(PH.frame - 1); } else if (a === 'sf') { PL.stop(); setPh(PH.frame + 1); }
    else if (a === 'lift') liftExtract(false); else if (a === 'extract') liftExtract(true); else if (a === 'frame') exportFrame('prg'); else if (a === 'full') toggleFull('prg');
  });

  // ---------- keys: Premiere Pro's (the 來源 monitor's when it has the focus) ----------
  function selectAll() { if (!P.seq) return; S.sel = new Set(P.seq.clips.filter((c) => unlocked(c.track)).map((c) => c.id)); renderTimeline(); renderFx(); renderInfo(); }
  // X: in and out around the clip under the playhead (on a targeted track)
  function markClip() {
    const f = Math.round(PH.frame), t = P.seq.targets.find((tr) => PL.at(tr, f)) || ALL_T.find((tr) => PL.at(tr, f)), c = t && PL.at(t, f);
    if (!c) return;
    begin('標記剪輯'); P.seq.in = c.start; P.seq.out = cEnd(c); commit();
  }
  function onKey(e) {
    if (ON_PHONE || S.mode !== 'edit' || $$('dialog[open]').length) return;
    const t = e.target;
    if (t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k, mod = e.metaKey || e.ctrlKey, sh = e.shiftKey, alt = e.altKey;
    const src = S.focus === 'src' && SRC.m;
    let done = true;
    if (e.ctrlKey && !e.metaKey && (k === '`' || e.code === 'Backquote')) { e.preventDefault(); toggleFull(); return; }
    if (mod) {
      switch (lk) {
        case 'z': if (sh) doRedo(); else doUndo(); break;
        case 'y': doRedo(); break;
        case 'k': addEdit(sh); break;
        case 'a': if (sh) { S.sel.clear(); renderTimeline(); renderFx(); } else selectAll(); break;
        case 'c': copySel(false); break;
        case 'x': copySel(true); break;
        case 'v': paste(); break;
        case 'r': speedDialog(); break;
        case 'l': setLink(![...S.sel].some((id) => clipById(id) && clipById(id).link)); break;
        case 'i': pickFiles(); break;
        case 'm': if (sh) goMarker(-1); else setMode('export'); break;
        case 'd': addTransition(); break;
        case 'e': if (sh) exportFrame(src ? 'src' : 'prg'); else done = false; break;
        default: done = false;
      }
      if (done) e.preventDefault();
      return;
    }
    if (sh && /^Digit[1-5]$/.test(e.code)) {
      const n = +e.code.slice(5);
      if (n === 1) { showTab('prj', 'prj'); setFocus('prj'); } else if (n === 2) { showTab('src', 'src'); setFocus('src'); } else if (n === 3) setFocus('tl'); else if (n === 4) setFocus('prg'); else { showTab('src', 'fx'); }
      e.preventDefault(); return;
    }
    const phX = fx2(PH.frame);
    switch (lk) {
      case ' ': if (src) SRC.toggle(); else PL.toggle(); break;
      case 'j': if (src) SRC.shuttleBy(-1); else PL.shuttleBy(-1); break;
      case 'k': if (src) SRC.shuttleBy(0); else PL.shuttleBy(0); break;
      case 'l': if (src) SRC.shuttleBy(1); else PL.shuttleBy(1); break;
      case 'ArrowLeft': if (src) SRC.step(sh ? -5 : -1); else { PL.stop(); setPh(PH.frame - (sh ? 5 : 1)); } break;
      case 'ArrowRight': if (src) SRC.step(sh ? 5 : 1); else { PL.stop(); setPh(PH.frame + (sh ? 5 : 1)); } break;
      case 'ArrowUp': if (!src) goEdit(-1); else done = false; break;
      case 'ArrowDown': if (!src) goEdit(1); else done = false; break;
      case 'Home': if (src) SRC.seek(0); else { PL.stop(); setPh(0); } break;
      case 'End': if (src) SRC.seek(SRC.dur()); else { PL.stop(); setPh(seqEnd()); } break;
      case 'i': if (alt) { if (src) SRC.mark('clearIn'); else markSeq('clearIn'); } else if (sh) { if (src) SRC.seek(SRC.m.srcIn || 0); else if (P.seq) { PL.stop(); setPh(P.seq.in != null ? P.seq.in : 0); } } else if (src) SRC.mark('in'); else markSeq('in'); break;
      case 'o': if (alt) { if (src) SRC.mark('clearOut'); else markSeq('clearOut'); } else if (sh) { if (src) SRC.seek(SRC.m.srcOut != null ? SRC.m.srcOut : SRC.dur()); else if (P.seq) { PL.stop(); setPh(P.seq.out != null ? P.seq.out : seqEnd()); } } else if (src) SRC.mark('out'); else markSeq('out'); break;
      case 'x': if (alt) { if (src) SRC.mark('clear'); else markSeq('clear'); } else if (!src && P.seq) markClip(); else done = false; break;
      case ',': srcEdit('insert'); break;
      case '.': srcEdit('overwrite'); break;
      case ';': liftExtract(false); break;
      case "'": liftExtract(true); break;
      case 'v': setTool('sel'); break;
      case 'a': setTool(sh ? 'trkb' : 'trk'); break;
      case 'b': setTool('rip'); break;
      case 'n': setTool('roll'); break;
      case 'r': setTool('rate'); break;
      case 'c': setTool('razor'); break;
      case 'y': setTool('slip'); break;
      case 'u': setTool('slide'); break;
      case 'h': setTool('hand'); break;
      case 'z': setTool('zoom'); break;
      case 't': setTool('type'); break;
      case 'm': if (sh) goMarker(1); else addMarker(); break;
      case 's': toggleSnap(); break;
      case 'e': if (sh && !src) setEnabled(); else done = false; break;
      case '=': case '+': zoomTo(TL.ppf * 1.6, phX >= 0 && phX <= viewW() ? phX : viewW() / 2); break;
      case '-': case '_': zoomTo(TL.ppf / 1.6, phX >= 0 && phX <= viewW() ? phX : viewW() / 2); break;
      case '\\': zoomFit(); break;
      case 'Delete': case 'Backspace': deleteSel(sh || alt); break;
      case 'Escape': S.sel.clear(); TL.gap = null; S.trans = null; renderTimeline(); renderFx(); break;
      case '`': toggleMax(); break;
      case '?': $('#dlgKeys').showModal(); break;
      default: done = false;
    }
    if (done) e.preventDefault();
  }
  addEventListener('keydown', onKey);

  // ---------- modes: 匯入 / 編輯 / 匯出 ----------
  function setMode(mode) {
    if (mode === 'export' && !(P.seq && P.seq.clips.length)) { toast('先在時間軸放一些剪輯'); return; }
    if (EX.running) return;
    PL.stop(); if (SRC.el) SRC.el.pause();
    S.mode = mode;
    $('#modeImport').hidden = mode !== 'import';
    $('#ws').hidden = mode !== 'edit' || ON_PHONE;
    $('#modeExport').hidden = mode !== 'export';
    for (const b of $$('.modes button')) b.classList.toggle('on', b.dataset.mode === mode);
    if (mode === 'edit') requestAnimationFrame(() => { PL.fit(); SRC.fit(); renderTimeline(); drawMeters(); placeXf(); });
    if (mode === 'export') enterExport();
  }
  $('.modes').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b && !b.disabled) setMode(b.dataset.mode); });
  $('#bFull').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else document.documentElement.requestFullscreen().catch(() => {}); });

  // ---------- 匯出 ----------
  // The sequence (or its in–out range) to an MP4: 不重新編碼 when every clip can go out as it is (one camera's clips on
  // V1, no speed or Motion changes, no gaps), else drawn and encoded at the size and bit rate chosen.
  const EX = { running: false, cancel: false, why: '', copyClips: null, withAudio: true, audioCodec: undefined, prevT: 0, prevTimer: 0, handle: null };
  function exRange() {
    const seq = P.seq, end = seqEnd();
    if ($('#exRange').value === 'io' && (seq.in != null || seq.out != null)) return [seq.in != null ? seq.in : 0, seq.out != null ? seq.out : end];
    return [0, end];
  }
  function planFor(a, b) {
    const seq = P.seq, r = seq.rate, font = '"Noto Sans TC Web", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
    const live = (c) => !c.off && c.start < b && cEnd(c) > a;
    const layers = VT.filter((t) => seq.tracks[t].out).map((t) => seq.clips.filter((c) => c.track === t && live(c)).sort((x, y) => x.start - y.start).map((c) => {
      const m = mediaById(c.mid), f = fadesOf(c), base = { start: fr2s(c.start), end: fr2s(cEnd(c)), srcIn: c.in, speed: c.speed, fx: { ...c.fx }, ...f };
      if (c.text) return { ...base, kind: 'text', text: { ...c.text, font } };
      if (!m || m.off) return null;
      const fit = c.fit ? Math.min(seq.w / m.w, seq.h / m.h) : 1;
      if (m.kind === 'still') return m.bitmap ? { ...base, kind: 'still', img: m.bitmap, w: m.w, h: m.h, fit } : null;
      return m.info && m.info.video ? { ...base, kind: 'video', info: m.info, w: m.w, h: m.h, fit } : null;
    }).filter(Boolean));
    const solo = AT.some((t) => seq.tracks[t].solo), master = dbGain(seq.master || 0);
    const audio = seq.clips.filter((c) => !isV(c.track) && live(c) && !seq.tracks[c.track].mute && (!solo || seq.tracks[c.track].solo)).map((c) => {
      const m = mediaById(c.mid);
      if (!m || m.off || !m.hasA || !m.info || !m.info.audio) return null;
      return { info: m.info, start: fr2s(c.start), end: fr2s(cEnd(c)), srcIn: c.in, speed: c.speed, gain: dbGain(c.fx.vol) * master, ...fadesOf(c) };
    }).filter(Boolean);
    return { fps: fpsOf(r), fpsExact: r.num / r.den, width: seq.w, height: seq.h, t0: fr2s(a), t1: fr2s(b), layers, audio };
  }
  // why the clips can't simply be copied out ('' when they can)
  async function copyReason(a, b) {
    const seq = P.seq, live = (c) => !c.off && c.start < b && cEnd(c) > a;
    const vs = seq.clips.filter((c) => isV(c.track) && live(c) && seq.tracks[c.track].out).sort((x, y) => x.start - y.start);
    if (!vs.length) return '範圍裡沒有影片';
    if (vs.some((c) => c.track !== 'V1')) return '有 V2、V3 的畫面（子母畫面、文字）';
    if (vs.some((c) => c.text)) return '有文字';
    const ms = vs.map((c) => mediaById(c.mid));
    if (ms.some((m) => !m || m.off)) return '有離線的媒體';
    if (ms.some((m) => m.kind !== 'video')) return '有圖片';
    if (vs.some((c) => c.speed !== 1)) return '有變速的剪輯';
    const d = defaultFx(seq);
    if (vs.some((c) => c.fit || ['x', 'y', 'scale', 'rot', 'opacity'].some((k) => Math.abs(c.fx[k] - d[k]) > 1e-6))) return '有調過位置、縮放、旋轉或不透明度的剪輯';
    if (ms.some((m) => m.w !== seq.w || m.h !== seq.h)) return '有和序列大小不同的影片';
    if ((seq.trans || []).some((t) => vs.some((c) => c.id === t.in || c.id === t.out))) return '有轉場';
    if (vs[0].start > a || vs.some((c, i) => i && c.start !== cEnd(vs[i - 1])) || cEnd(vs[vs.length - 1]) < b) return '中間有空隙（空隙在時間軸上是黑畫面）';
    const solo = AT.some((t) => seq.tracks[t].solo);
    const as = seq.clips.filter((c) => !isV(c.track) && live(c) && !seq.tracks[c.track].mute && (!solo || seq.tracks[c.track].solo));
    if (as.some((c) => c.track !== 'A1')) return '有 A2、A3 的聲音';
    for (const c of as) { const v = linkedOf(c); if (!v || !vs.includes(v) || v.start !== c.start || v.dur !== c.dur || Math.abs(v.in - c.in) > 1e-6 || c.speed !== 1 || c.fx.vol !== 0) return '聲音另外剪過或調過音量'; }
    if (as.length && as.length !== vs.length) return '有的片段拿掉了聲音、有的沒有';
    if ((seq.master || 0) !== 0) return '調過主要音量';
    EX.withAudio = as.length > 0 && ms.every((m) => m.hasA);
    EX.copyClips = vs.map((c) => ({ info: mediaById(c.mid).info, srcIn: c.in + fr2s(Math.max(0, a - c.start)), srcOut: c.in + fr2s(Math.min(cEnd(c), b) - c.start) }));
    const why = await E.copyCheck(EX.copyClips);
    return why === 'mixed' ? '片段來自不同的相機或設定' : why === 'audio-mixed' ? '片段的聲音格式不一樣' : why ? '這些影片不能直接接起來' : '';
  }
  function exSize(preset) {
    const seq = P.seq;
    const target = preset === '1080' ? 1080 : preset === '720' ? 720 : null;
    if (!target || seq.h <= target) return { w: seq.w, h: seq.h };
    const h = target, w = Math.round((seq.w * h) / seq.h / 2) * 2;
    return { w, h };
  }
  const defaultRate = (h, preset) => { const hi = h >= 2000 ? 45 : h >= 1400 ? 24 : h >= 1000 ? 16 : 8; return preset === 'mid' ? Math.max(2, Math.round(hi / 2)) : hi; };
  async function enterExport() {
    const seq = P.seq;
    $('#exName').value = $('#exName').dataset.seq === seq.name && $('#exName').value ? $('#exName').value : seq.name;
    $('#exName').dataset.seq = seq.name;
    $('#exRange').querySelector('[value="io"]').disabled = seq.in == null && seq.out == null;
    if ($('#exRange').value === 'io' && seq.in == null && seq.out == null) $('#exRange').value = 'all';
    $('#exLoc').textContent = CAN_SAVE ? '按匯出時選擇（直接存進你選的資料夾）' : '下載到瀏覽器的下載資料夾';
    if (EX.audioCodec === undefined) EX.audioCodec = await E.audioCodec();
    const hevc = await E.canVideo('hevc', seq.w, seq.h, 12e6);
    $('#exFormat').querySelector('[value="hevc"]').disabled = !hevc;
    await refreshExport(true);
  }
  async function refreshExport(fresh) {
    const seq = P.seq, [a, b] = exRange();
    EX.why = await copyReason(a, b);
    const pre = $('#exPreset');
    pre.querySelector('[value="copy"]').disabled = !!EX.why;
    if (fresh && !EX.why) pre.value = 'copy';
    if (pre.value === 'copy' && EX.why) pre.value = 'high';
    const p = pre.value, copy = p === 'copy', { w, h } = exSize(p);
    if (!copy && (fresh || $('#exRate').dataset.p !== p)) { $('#exRate').value = String(defaultRate(h, p)); $('#exRate').dataset.p = p; }
    $('#exRate').disabled = copy; $('#exFormat').disabled = copy;
    $('#exRateV').textContent = copy ? '和原檔一樣' : `${$('#exRate').value} Mbps`;
    $('#exSize').textContent = `${w} × ${h}`;
    $('#exFps').textContent = `${Math.round(fpsOf(seq.rate) * 1000) / 1000} fps`;
    const ac = EX.audioCodec;
    $('#exAudio').textContent = copy ? (EX.withAudio ? '和原檔一樣（不重新編碼）' : '沒有聲音') : ac === 'aac' ? 'AAC，48 kHz，立體聲' : ac === 'opus' ? 'Opus，48 kHz，立體聲（這個瀏覽器不能編 AAC）' : '沒有聲音（這個瀏覽器不能編碼聲音）';
    $('#exAudioRate').textContent = copy ? '—' : '192 kbps';
    const why = $('#exWhy');
    why.className = `ex-why${EX.why && fresh ? '' : ''}`;
    why.textContent = copy ? '不重新編碼：片段直接接起來，幾秒就好、畫質和原檔一模一樣。每段的開頭會對齊到它前面最近的關鍵影格（行車記錄器通常每 0.5～1 秒一個），所以可能早一點點開始。'
      : EX.why ? `要重新編碼（${EX.why}）：每個影格重新畫、重新壓縮，畫質由位元速率決定，時間大約和影片一樣長或更短。` : '重新編碼：每個影格重新畫、重新壓縮。想要最快、畫質不變，選「不重新編碼」。';
    const secs = fr2s(b - a);
    let est;
    if (copy) est = EX.copyClips.reduce((s, c) => { const m = P.media.find((x) => x.info === c.info); return s + (m ? ((m.mp4 ? m.mp4.size : m.size) * (c.srcOut - c.srcIn)) / Math.max(0.1, m.dur) : 0); }, 0);
    else est = ((+$('#exRate').value * 1e6 + (ac ? 192e3 : 0)) * secs) / 8;
    $('#exEst').textContent = `約 ${fmtBytes(est)}`;
    $('#exDur').textContent = `長度 ${tcOf(b - a, seq.rate)}`;
    const fmt = copy ? '原檔的編碼（不重新編碼）' : $('#exFormat').value === 'hevc' ? 'HEVC（H.265）' : 'H.264';
    $('#exSum').textContent = `輸出：${$('#exName').value || seq.name}.mp4\n影片：${w} × ${h}，${Math.round(fpsOf(seq.rate) * 1000) / 1000} fps，${fmt}${copy ? '' : `，${$('#exRate').value} Mbps`}\n聲音：${$('#exAudio').textContent}\n範圍：${tcOf(a, seq.rate)} – ${tcOf(b, seq.rate)}（${fmtClock(secs)}）`;
    if (fresh) EX.prevT = a;
    drawExPrev();
  }
  for (const id of ['#exPreset', '#exRange', '#exFormat']) $(id).addEventListener('change', () => refreshExport(false));
  $('#exRate').addEventListener('input', () => refreshExport(false));
  $('#exName').addEventListener('input', () => { const s = $('#exSum').textContent.split('\n'); s[0] = `輸出：${$('#exName').value || P.seq.name}.mp4`; $('#exSum').textContent = s.join('\n'); });
  // the preview: the frame at a point of the range (drag on it to look elsewhere)
  function drawExPrev() {
    clearTimeout(EX.prevTimer);
    EX.prevTimer = setTimeout(async () => {
      if (S.mode !== 'export' || !P.seq) return;
      const [a, b] = exRange(), f = clamp(Math.round(EX.prevT), a, Math.max(a, b - 1)), view = $('#exPrevView');
      $('#exTc').textContent = tcOf(f, P.seq.rate);
      try {
        const k = Math.min((view.clientWidth - 8) / P.seq.w, (view.clientHeight - 8) / P.seq.h);
        const cv = await E.still(planFor(f, f + 1), fr2s(f), Math.max(64, Math.round(P.seq.w * k * (devicePixelRatio || 1))));
        let c = view.querySelector('canvas');
        if (!c) { c = el('canvas'); view.append(c); }
        c.width = cv.width; c.height = cv.height; c.getContext('2d').drawImage(cv, 0, 0);
        c.style.cssText = `width:${Math.round(P.seq.w * k)}px;height:${Math.round(P.seq.h * k)}px`;
      } catch (e) { console.error(e); }
    }, 120);
  }
  $('#exPrevView').addEventListener('pointerdown', (e) => {
    const v = $('#exPrevView'), [a, b] = exRange();
    v.setPointerCapture(e.pointerId);
    const go = (ev) => { const r = v.getBoundingClientRect(); EX.prevT = a + clamp((ev.clientX - r.left) / r.width, 0, 1) * (b - a); $('#exTc').textContent = tcOf(EX.prevT, P.seq.rate); drawExPrev(); };
    go(e);
    v.onpointermove = (ev) => { if (ev.buttons) go(ev); };
    v.onpointerup = () => { v.onpointermove = v.onpointerup = null; };
  });
  function exProgress(p, what, t0) {
    const secs = (performance.now() - t0) / 1000, left = p > 0.02 ? (secs / p) * (1 - p) : 0;
    $('#exBar').style.setProperty('--p', `${Math.round(p * 1000) / 10}%`);
    $('#exProgT').textContent = what === 'finishing' ? '收尾中…' : `${Math.floor(p * 100)}%${left > 1 ? `・剩下約 ${fmtClock(left)}` : ''}`;
  }
  async function runExport() {
    if (EX.running || !P.seq) return;
    const seq = P.seq, [a, b] = exRange(), preset = $('#exPreset').value;
    // (the film is made from the MP4s: a video still being converted, first)
    const busy = P.media.find((m) => m.conv != null && seq.clips.some((c) => c.mid === m.id && !c.off && c.start < b && cEnd(c) > a));
    if (busy) { toast(`「${busy.name}」還在轉成 MP4（${pctOf(busy)}），轉好再匯出`, 4000); return; }
    $('#exProgT').textContent = ''; $('#exProg').hidden = true;
    let name = `${($('#exName').value.trim() || seq.name).replace(/[\\/:*?"<>|]/g, '_')}.mp4`;
    let writable = null, handle = null;
    if (CAN_SAVE) {
      try { handle = await window.showSaveFilePicker({ suggestedName: name, id: 'zt-cut', startIn: 'videos', types: [{ description: 'MP4 影片', accept: { 'video/mp4': ['.mp4'] } }] }); writable = await handle.createWritable(); name = handle.name; }
      catch (e) { if (e && e.name === 'AbortError') return; handle = null; writable = null; }
    }
    EX.running = true; EX.cancel = false;
    for (const b2 of $$('.modes button')) b2.disabled = true;
    $('#exGo').disabled = true; $('#exCancel').hidden = false; $('#exProg').hidden = false; $('#exBar').parentElement.classList.remove('done');
    const t0 = performance.now(), hooks = { progress: (p, w) => exProgress(p, w, t0), canceled: () => EX.cancel };
    exProgress(0, '', t0);
    let ok = false;
    try {
      let buffer = null;
      if (preset === 'copy') {
        if (await copyReason(a, b)) throw new Error('copy');
        const r = await E.copy(EX.copyClips, { writable, audio: EX.withAudio }, hooks);
        buffer = r.buffer;
      } else {
        const { w, h } = exSize(preset);
        buffer = await E.render(planFor(a, b), { codec: $('#exFormat').value, bitrate: +$('#exRate').value * 1e6, width: w, height: h, audioCodec: EX.audioCodec, audioBitrate: 192e3, writable }, hooks);
      }
      let size = 0;
      if (writable) size = (await handle.getFile()).size;
      else { const blob = new Blob([buffer], { type: 'video/mp4' }); size = blob.size; const u = URL.createObjectURL(blob); const link = el('a', { href: u, download: name }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(u), 120000); }
      $('#exBar').style.setProperty('--p', '100%'); $('#exBar').parentElement.classList.add('done');
      $('#exProgT').textContent = `${writable ? '存好了' : '開始下載了'}：${name}（${fmtBytes(size)}，花了 ${fmtClock((performance.now() - t0) / 1000)}）`;
      ok = true;
      count(fr2s(b - a));
    } catch (e) {
      if (e && e.canceled) { $('#exProgT').textContent = '已取消'; if (handle && handle.remove) handle.remove().catch(() => {}); }
      else { console.error(e); $('#exProgT').textContent = `沒有成功${e && e.message === 'copy' ? '：這些片段不能直接接起來，請改用重新編碼' : /encod|codec/i.test(String(e && e.message)) ? '：這台電腦不能用這個格式編碼，換 H.264 或調低大小' : ''}`; if (handle && handle.remove) handle.remove().catch(() => {}); }
      try { if (writable) await writable.abort(); } catch {}
    } finally {
      EX.running = false;
      for (const b2 of $$('.modes button')) b2.disabled = false;
      renderTabs();
      $('#exGo').disabled = false; $('#exCancel').hidden = true;
      if (ok) toast('匯出完成', 2000);
    }
  }
  $('#exGo').addEventListener('click', runExport);
  $('#exCancel').addEventListener('click', () => { EX.cancel = true; $('#exProgT').textContent = '取消中…'; });
  addEventListener('beforeunload', (e) => { if (EX.running) { e.preventDefault(); e.returnValue = ''; } });
  // only a number leaves the browser: films saved, and their seconds
  function count(seconds) {
    if (!onServer) return;
    fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ files: 1, seconds: Math.round(seconds) }) }).catch(() => {});
  }

  // ---------- off we go ----------
  async function init() {
    setTool('sel'); setFocus('tl');
    if (ON_PHONE) { $('#modeImport').hidden = true; $('#modeExport').hidden = true; return; }
    const had = await restore().catch(() => false);
    // the MP4s of converted videos, kept in this browser: those videos are back at once (any others are taken away)
    const back = [];
    for (const [name, h] of await E.kept()) { const m = had && P.media.find((x) => `${x.id}.mp4` === name); if (m) back.push([m, h]); else E.unkeep(name); }
    renderPrj(); renderPrjName(); renderTabs(); renderFx(); renderMeta(); renderInfo(); renderMarks(); renderHist();
    if (had) {
      setMode(P.seq ? 'edit' : 'import');
      if (P.seq) requestAnimationFrame(() => zoomFit());
      toast(back.length === P.media.length ? '上次的剪輯在這裡' : '上次的剪輯在這裡：把同樣的影片再放進來就會接回去（媒體離線）', 6500);
      $('#projDirty').hidden = true;
    } else setMode('import');
    (async () => { for (const [m, h] of back) { try { await useMp4(m, await h.getFile(), true); } catch (e) { console.error(e); E.unkeep(`${m.id}.mp4`); } } })();
    // files dropped on the home page
    if (window.ManyHandoff && window.indexedDB) {
      ManyHandoff.takeAll('cut').then(async (entries) => {
        if (!entries || !entries.length) return;
        const files = [];
        for (const en of entries) { try { if (en.file) files.push(en.file); else if (en.handle) files.push(await en.handle.getFile()); } catch {} }
        if (files.length) importFiles(files);
      }).catch(() => {});
    }
  }
  init();
  // for the automated checks (?test): a look at the state, nothing to change it with
  if (/[?&]test\b/.test(location.search)) window.__cut = { P, S, PH, TL, H, seqEnd };
})();
