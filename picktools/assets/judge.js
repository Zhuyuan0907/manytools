/* 照片挑選's AI 初選, the part done on this computer (nothing leaves it): each photo decoded once, small (its long
   side 1024 px), and measured — how sharp its sharpest part is (a shaken or missed photo has no sharp part; a
   shallow-focus one still has one), how bright it is, how much is blown out or black — with a fingerprint of how it
   looks, to tell the frames of a burst (and a 320 px thumbnail, for a photo with none). For the AI: a 768 px JPEG
   of it, made when it's sent.
   Firefox decodes with WebCodecs' ImageDecoder (its createImageBitmap holds the page even from here; see preview.js). */
const can = new Map();   // type → ImageDecoder takes it
async function viaDecoder(blob, type) {
  if (typeof ImageDecoder !== 'function') return null;
  if (!can.has(type)) can.set(type, await ImageDecoder.isTypeSupported(type).catch(() => false));
  if (!can.get(type)) return null;
  const d = new ImageDecoder({ data: blob.stream(), type });
  try {
    const { image } = await d.decode();
    return { src: image, w: image.displayWidth, h: image.displayHeight, done: () => image.close() };
  } catch { return null; } finally { d.close(); }
}
async function viaBitmap(blob) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(blob); }
  return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
}
function draw(p, side) {
  const k = Math.min(1, side / Math.max(p.w, p.h)), w = Math.max(1, Math.round(p.w * k)), h = Math.max(1, Math.round(p.h * k));
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#808080';   // what's see-through (a PNG's): mid grey, neither bright nor dark
  g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(p.src, 0, 0, w, h);
  return { c, g, w, h };
}

// The measures. Sharpness: the Laplacian's energy (how much each pixel differs from its four neighbours, squared) in
// an 8 × n grid of tiles; the mean of the three sharpest tiles, as its root (in grey levels). Brightness: the mean
// luma, and the shares of it at 250+ (blown out) and 8 and under (black). The look: a 64-bit difference hash of a
// 9 × 8 shrink (bursts differ in a few bits) and the colours of a 4 × 4 grid.
function measure(d, w, h) {
  const n = w * h, Y = new Float32Array(n);
  let sum = 0, hi = 0, lo = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    Y[i] = y; sum += y;
    if (y >= 250) hi++; else if (y <= 8) lo++;
  }
  const TX = 8, TY = Math.max(4, Math.round((8 * h) / w)), tiles = new Float64Array(TX * TY), cnt = new Uint32Array(TX * TY);
  for (let y = 1; y < h - 1; y++) {
    const ty = Math.min(TY - 1, Math.floor((y * TY) / h)), row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x, l = 4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - w] - Y[i + w], t = ty * TX + Math.min(TX - 1, Math.floor((x * TX) / w));
      tiles[t] += l * l; cnt[t]++;
    }
  }
  const e = [...tiles].map((v, i) => (cnt[i] ? v / cnt[i] : 0)).sort((a, b) => b - a);
  const sharp = Math.sqrt((e[0] + e[1] + e[2]) / 3);
  const cell = (x0, x1, y0, y1, ch) => {   // the mean of a box (ch: 'y', or 0 1 2 for r g b)
    let s = 0, c = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += ch === 'y' ? Y[y * w + x] : d[(y * w + x) * 4 + ch]; c++; }
    return c ? s / c : 0;
  };
  const g9 = [];
  for (let r = 0; r < 8; r++) for (let q = 0; q < 9; q++) g9.push(cell(Math.floor((q * w) / 9), Math.floor(((q + 1) * w) / 9), Math.floor((r * h) / 8), Math.floor(((r + 1) * h) / 8), 'y'));
  let hash = '';
  for (let r = 0; r < 8; r++) {
    let v = 0;
    for (let q = 0; q < 8; q++) v = (v << 1) | (g9[r * 9 + q] < g9[r * 9 + q + 1] ? 1 : 0);
    hash += (v >>> 0).toString(16).padStart(2, '0');
  }
  const sig = [];
  for (let r = 0; r < 4; r++) for (let q = 0; q < 4; q++) for (const ch of [0, 1, 2]) sig.push(Math.round(cell(Math.floor((q * w) / 4), Math.floor(((q + 1) * w) / 4), Math.floor((r * h) / 4), Math.floor(((r + 1) * h) / 4), ch)));
  return { sharp: Math.round(sharp * 10) / 10, mean: Math.round(sum / n), hi: Math.round((hi / n) * 1000) / 1000, lo: Math.round((lo / n) * 1000) / 1000, hash, sig };
}

self.onmessage = async ({ data: { id, blob, type, mode, decoder, thumb } }) => {
  try {
    const p = (decoder && (await viaDecoder(blob, type || blob.type || 'image/jpeg'))) || (await viaBitmap(blob));
    try {
      if (mode === 'ai') {
        const { c } = draw(p, 768);
        self.postMessage({ id, jpg: await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 }) });
        return;
      }
      const { g, w, h } = draw(p, 1024);
      const m = measure(g.getImageData(0, 0, w, h).data, w, h);
      // a photo with no thumbnail of its own gets one from this decode (320 px, as the page's)
      const th = thumb ? await draw(p, 320).c.convertToBlob({ type: 'image/jpeg', quality: 0.8 }) : null;
      self.postMessage({ id, m, fw: p.w, fh: p.h, thumb: th });
    } finally { p.done(); }
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
