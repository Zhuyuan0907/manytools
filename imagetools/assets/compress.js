/* The image squeezer, shared by worker.js and the page (when a worker can't start, e.g. opened as a file).
   compressImage(file, o) → { blob, width, height, quality, kept }
   o: { type: 'image/jpeg' | 'image/webp' | 'image/png', limit: bytes or 0, maxSide: px or 0, square: bool }
   With a limit it looks for the highest quality that fits; if even low quality is too big it shrinks the
   picture a step and tries again. Re-encoding drops the photo's metadata (location, camera) along the way. */
(function (root) {
  'use strict';
  const LOW = 0.38, HIGH = 0.95, FREE = 0.85;

  function canvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function encode(c, type, quality) {
    if (c.convertToBlob) return c.convertToBlob({ type, quality });
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, quality));
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
    const lossy = o.type !== 'image/png';
    try {
      let c = draw();
      if (!o.limit) {
        const blob = await encode(c, o.type, lossy ? FREE : undefined);
        return { blob, width: w, height: h, quality: lossy ? FREE : null };
      }
      for (let round = 0; round < 8; round++) {
        let smallest;
        if (!lossy) {
          const b = await encode(c, o.type);
          if (b.size <= o.limit) return { blob: b, width: w, height: h, quality: null };
          smallest = b.size;
        } else {
          const top = await encode(c, o.type, HIGH);
          if (top.size <= o.limit) return { blob: top, width: w, height: h, quality: HIGH };
          const bottom = await encode(c, o.type, LOW);
          if (bottom.size <= o.limit) {
            // the best quality that still fits: halve the range a few times
            let lo = LOW, hi = HIGH, best = bottom, bestQ = LOW;
            for (let i = 0; i < 6; i++) {
              const q = (lo + hi) / 2, b = await encode(c, o.type, q);
              if (b.size <= o.limit) { best = b; bestQ = q; lo = q; } else hi = q;
            }
            return { blob: best, width: w, height: h, quality: bestQ };
          }
          smallest = bottom.size;
        }
        // too big even at low quality: shrink the picture by about what's needed, then try again
        const k = Math.min(0.9, Math.max(0.5, Math.sqrt(o.limit / smallest) * 0.95));
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
