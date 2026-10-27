/* ZhuyuanLoveExif look worker: decodes a photo small, once, for two things — a thumbnail, and how the finished
   picture looks (brightness, contrast, warmth, colour, clipped ends), so a set of photos can be compared by what
   they look like and not only by what their sliders say. The full-size decode is let go right away.
   In:  { id, blob, orient }        orient: the RAW's orientation to apply to its preview (1 = as it comes)
   Out: { id, ok, thumb: Blob, look: { L, contrast, warm, tint, chroma, hi, lo, hist } }   or   { id, ok: false }
   Also loaded by the page itself: Safari keeps the memory of every full-size createImageBitmap, so there the page
   decodes through <img> and measures with ZLook.measure (no worker). */
(() => {
  'use strict';
  const SIDE = 256; // the measuring size, long side
  const THUMB = 240;

  // sRGB 0–255 → CIE L*a*b* (D65), through a table for the linear part
  const LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function measure(data) {
    let n = 0, sL = 0, sL2 = 0, sa = 0, sb = 0, sc = 0, hi = 0, lo = 0;
    const hist = new Uint32Array(32);
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i], G = data[i + 1], B = data[i + 2];
      const r = LIN[R], g = LIN[G], b = LIN[B];
      const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
      const fy = f(y);
      const L = 116 * fy - 16, A = 500 * (f(x) - fy), Bb = 200 * (fy - f(z));
      sL += L; sL2 += L * L; sa += A; sb += Bb; sc += Math.hypot(A, Bb); n++;
      hist[Math.min(31, Math.max(0, Math.floor(L / 100 * 32)))]++;
      if (R >= 254 || G >= 254 || B >= 254) hi++;
      if (R <= 2 && G <= 2 && B <= 2) lo++;
    }
    const mL = sL / n;
    return { L: mL, contrast: Math.sqrt(Math.max(0, sL2 / n - mL * mL)), warm: sb / n, tint: sa / n, chroma: sc / n, hi: hi / n, lo: lo / n, hist: [...hist].map((v) => v / n) };
  }
  function oriented(ctx, img, o, w, h) {
    switch (o) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, w, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, w, h); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, h); break;
      default:
    }
    const swap = o >= 5;
    ctx.drawImage(img, 0, 0, swap ? h : w, swap ? w : h);
  }
  function draw(img, o, side) {
    const iw = img.width, ih = img.height;
    const [w0, h0] = o >= 5 ? [ih, iw] : [iw, ih];
    const k = Math.min(1, side / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = new OffscreenCanvas(w, h);
    oriented(c.getContext('2d'), img, o, w, h);
    return c;
  }

  self.ZLook = { measure, SIDE, THUMB };
  if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    let queue = Promise.resolve();
    self.onmessage = (e) => {
      const { id, blob, orient } = e.data;
      queue = queue.then(async () => {
        let img = null;
        try {
          img = await createImageBitmap(blob, { imageOrientation: 'from-image' });
          // shrink first: everything after works on a few hundred pixels
          const big = Math.max(img.width, img.height);
          if (big > SIDE * 2) {
            const k = (SIDE * 2) / big;
            const small = await createImageBitmap(img, { resizeWidth: Math.round(img.width * k), resizeHeight: Math.round(img.height * k), resizeQuality: 'medium' });
            img.close();
            img = small;
          }
          const o = orient >= 1 && orient <= 8 ? orient : 1;
          const m = draw(img, o, SIDE);
          const look = measure(m.getContext('2d').getImageData(0, 0, m.width, m.height).data);
          const t = draw(img, o, THUMB);
          const thumb = await t.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
          postMessage({ id, ok: true, thumb, look, w: t.width, h: t.height });
        } catch {
          postMessage({ id, ok: false });
        } finally {
          if (img && img.close) img.close();
        }
      });
    };
  }
})();
