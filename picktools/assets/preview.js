/* 照片挑選's previews, as Lightroom's "standard previews": each photo decoded once, here (off the page's thread), and
   kept as a small JPEG the size it's shown at, with a thumbnail from the same decode. Stepping through then shows a
   sharp photo at once; only zooming to 100% needs the whole 24 MP photo.
   Decoded with WebCodecs' ImageDecoder where there is one: Firefox's createImageBitmap of a file, even here, holds the
   page itself for the whole decode (half a second a photo); the frame comes turned the photo's way in every browser. */
const can = new Map();   // type → ImageDecoder takes it
async function decoded(blob, type) {
  if (typeof ImageDecoder === 'function') {
    if (!can.has(type)) can.set(type, await ImageDecoder.isTypeSupported(type).catch(() => false));
    if (can.get(type)) {
      const d = new ImageDecoder({ data: blob.stream(), type });
      try {
        const { image } = await d.decode();
        return { src: image, w: image.displayWidth, h: image.displayHeight, done: () => image.close() };
      } finally { d.close(); }
    }
  }
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(blob); }
  return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
}
self.onmessage = async ({ data: { blob, type, long } }) => {
  try {
    const p = await decoded(blob, type || blob.type || 'image/jpeg');
    const out = async (side, q) => {
      const k = Math.min(1, side / Math.max(p.w, p.h)), w = Math.max(1, Math.round(p.w * k)), h = Math.max(1, Math.round(p.h * k));
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
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
