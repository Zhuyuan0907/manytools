/* The image squeezer, shared by worker.js and the page (when a worker can't start, e.g. opened as a file).
   compressImage(file, o) → { blob, width, height, quality, colors, kept }
   o: { type: 'image/jpeg' | 'image/webp' | 'image/png', limit: bytes or 0, maxSide: px or 0, square: bool }
   With a limit it looks for the highest quality that fits; if even low quality is too big it shrinks the
   picture a step and tries again. PNG has no quality setting: its lower steps are fewer colours (UPNG.js).
   A result never comes back bigger than the file it came from (except a photo turned into PNG, which is
   lossless by nature); when re-encoding can't beat the original and nothing about the picture had to
   change, the original itself is handed back (kept: 'smaller').
   Re-encoding drops the photo's metadata (location, camera) along the way. */
(function (root) {
  'use strict';
  const LOW = 0.38, HIGH = 0.95, FREE = 0.85;
  const COLORS = [256, 128, 64];   // PNG steps below lossless; with no limit only 256 is tried

  function canvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function encode(c, type, quality) {
    if (c.convertToBlob) return c.convertToBlob({ type, quality });
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, quality));
  }
  // Distinct colours, counting stops just past max. A picture already within a palette's size gets an exact
  // palette from UPNG's lossless mode; its quantizer could merge distinct flat colours instead.
  function distinct(rgba, max) {
    const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2), seen = new Set();
    for (let i = 0; i < u32.length && seen.size <= max; i++) seen.add(u32[i]);
    return seen.size;
  }

  // The best version of canvas c that is at most goal bytes: { blob, quality | colors }, or { over: the
  // smallest size it got to }. Without a limit only the everyday setting is tried (85%, or 256 colours).
  async function best(c, type, goal, limited) {
    if (type !== 'image/png') {
      const topQ = limited ? HIGH : FREE;
      const top = await encode(c, type, topQ);
      if (top.size <= goal) return { blob: top, quality: topQ };
      if (!limited) return { over: top.size };
      const bottom = await encode(c, type, LOW);
      if (bottom.size > goal) return { over: bottom.size };
      // the best quality that still fits: halve the range a few times
      let lo = LOW, hi = topQ, blob = bottom, quality = LOW;
      for (let i = 0; i < 6; i++) {
        const q = (lo + hi) / 2, b = await encode(c, type, q);
        if (b.size <= goal) { blob = b; quality = q; lo = q; } else hi = q;
      }
      return { blob, quality };
    }
    // lossless first: the browser's own PNG is quick but rarely small, UPNG's is often a third of it
    const w = c.width, h = c.height, rgba = c.getContext('2d').getImageData(0, 0, w, h).data;
    const quick = await encode(c, type);
    const upng = (cnum) => new Blob([root.UPNG.encode([rgba.buffer], w, h, cnum)], { type: 'image/png' });
    const lossless = upng(0), first = lossless.size < quick.size ? lossless : quick;
    if (first.size <= goal) return { blob: first, colors: null };
    const n = distinct(rgba, COLORS[0]);
    let over = first.size;
    for (const cnum of limited ? COLORS : COLORS.slice(0, 1)) {
      if (n <= cnum) continue;   // lossless already is this palette, exactly
      const blob = upng(cnum);
      if (blob.size <= goal) return { blob, colors: cnum };
      over = Math.min(over, blob.size);
    }
    return { over };
  }

  async function compressImage(file, o) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { throw Object.assign(new Error('decode'), { code: 'decode' }); }
    // crop to the centre square first, then fit the longest side
    let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
    if (o.square) { const s = Math.min(sw, sh); sx = Math.round((sw - s) / 2); sy = Math.round((sh - s) / 2); sw = sh = s; }
    let w = sw, h = sh;
    if (o.maxSide && Math.max(w, h) > o.maxSide) { const k = o.maxSide / Math.max(w, h); w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k)); }
    const draw = () => {
      const c = canvas(w, h), g = c.getContext('2d');
      if (o.type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); } // JPEG has no transparency
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
      return c;
    };
    const limited = o.limit > 0, limit = limited ? o.limit : Infinity;
    // nothing about the picture has to change, so the original file is itself a fair answer
    const untouched = () => o.type === file.type && w === bmp.width && h === bmp.height;
    const original = (why) => ({ blob: file, width: w, height: h, quality: null, colors: null, kept: why });
    const result = (r) => ({ blob: r.blob, width: w, height: h, quality: r.quality || null, colors: r.colors || null });
    // at least 2% smaller than the original, or it isn't worth a re-encode; a photo turned into PNG grows
    // by nature, so that only has to meet the limit
    const cap = o.type === 'image/png' && file.type !== 'image/png' ? Infinity : file.size * 0.98;
    try {
      if (untouched() && limited && file.size <= limit) return original('fits');
      let c = draw();
      for (let round = 0; round < 8; round++) {
        const r = await best(c, o.type, Math.min(limit, cap), limited);
        if (r.blob) return result(r);
        if (r.over <= limit) {
          // the limit is met, only "smaller than the original" isn't
          if (untouched()) return original('smaller');
          const r2 = await best(c, o.type, limit, limited);
          if (r2.blob) return result(r2);
        }
        // too big even at low quality: shrink the picture by about what's needed, then try again
        const k = Math.min(0.9, Math.max(0.5, Math.sqrt(limit / r.over) * 0.95));
        w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
        c = draw();
      }
      throw Object.assign(new Error('limit'), { code: 'limit' });
    } finally {
      bmp.close && bmp.close();
    }
  }
  root.compressImage = compressImage;
})(typeof self !== 'undefined' ? self : window);
