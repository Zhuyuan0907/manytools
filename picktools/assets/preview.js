/* 照片挑選's previews, as Lightroom's "standard previews": each photo decoded once, here (off the page's thread), and
   kept as a small JPEG the size it's shown at, with a thumbnail from the same decode. Stepping through then shows a
   sharp photo at once; only zooming to 100% needs the whole 24 MP photo.
   Firefox decodes with WebCodecs' ImageDecoder: its createImageBitmap of a file, even here, holds the page itself for
   the whole decode (half a second a photo). Elsewhere createImageBitmap, drawn into a Display P3 canvas where there is
   one, so wide-gamut photos (an iPhone's, P3 or Adobe RGB exports) keep their colours. */
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
let P3 = null;   // a Display P3 canvas works here
function context(c) {
  if (P3 !== false) {
    try { const g = c.getContext('2d', { colorSpace: 'display-p3' }); if (g && (!g.getContextAttributes || g.getContextAttributes().colorSpace === 'display-p3')) { P3 = true; return g; } } catch {}
    P3 = false;
  }
  return c.getContext('2d');
}
self.onmessage = async ({ data: { blob, type, long, decoder } }) => {
  try {
    const p = (decoder && (await viaDecoder(blob, type || blob.type || 'image/jpeg'))) || (await viaBitmap(blob));
    const out = async (side, q) => {
      const k = Math.min(1, side / Math.max(p.w, p.h)), w = Math.max(1, Math.round(p.w * k)), h = Math.max(1, Math.round(p.h * k));
      const c = new OffscreenCanvas(w, h), g = context(c);
      g.fillStyle = '#1f1f20';   // what's see-through (a PNG's) on the loupe's own grey, not black
      g.fillRect(0, 0, w, h);
      g.imageSmoothingQuality = 'high';
      g.drawImage(p.src, 0, 0, w, h);
      return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: q }), w, h };
    };
    let pv, th;
    try { pv = await out(long, 0.9); th = await out(320, 0.8); } finally { p.done(); }
    self.postMessage({ blob: pv.blob, w: pv.w, h: pv.h, fw: p.w, fh: p.h, thumb: th.blob });
  } catch (e) {
    self.postMessage({ error: String((e && e.message) || e) });
  }
};
