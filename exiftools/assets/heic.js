/* ZhuyuanLoveExif: HEIC pictures for the browsers that can't show them (Chrome, Edge, Firefox; Safari can).
   libheif (lib/libheif-1.23.5.*, LGPL; see lib/LICENSES.txt) decodes the photo here, off the page. Nothing leaves
   the browser. The page starts this worker on the first HEIC it can't show and ends it when it has been idle
   (WebAssembly memory only grows). The last photo's pixels are kept, so its screen-size picture, then its 100 %
   one (or its thumbnail, then the picture) cost one decode, not two.
   In:  { id, file, maxSide, p3 }   p3: the photo is in Display P3 (an iPhone's), its colours are marked so
   Out: { id, bmp, w, h }   bmp no bigger than maxSide, w × h the photo's own size   or   { id, error } */
'use strict';
importScripts('../lib/libheif-1.23.5.js');

let lib = null;
function load() {
  if (!lib) {
    lib = (async () => {
      const res = await fetch('../lib/libheif-1.23.5.wasm.gz');
      if (!res.ok) throw new Error('libheif ' + res.status);
      const wasmBinary = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      return libheif({ wasmBinary });   // a worker may compile a module this size at once
    })();
  }
  return lib;
}

let last = null;   // { key, pixels }: the photo decoded last
async function decode(file, p3) {
  const key = [file.name, file.size, file.lastModified, !!p3].join('|');
  if (last && last.key === key) return last.pixels;
  last = null;
  const heif = await load();
  const decoder = new heif.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
    const image = images.find((im) => im.is_primary()) || images[0];
    if (!image) throw new Error('no picture in the file');
    const w = image.get_width(), h = image.get_height();
    const px = await new Promise((resolve, reject) => image.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (d) => (d ? resolve(d) : reject(new Error('decode')))));
    let pixels;
    try { pixels = new ImageData(px.data, w, h, { colorSpace: p3 ? 'display-p3' : 'srgb' }); } catch { pixels = new ImageData(px.data, w, h); }
    last = { key, pixels };
    return pixels;
  } finally {
    for (const im of images) try { im.free(); } catch { /* already gone */ }
    if (decoder.decoder) try { heif.heif_context_free(decoder.decoder); } catch { /* already gone */ }
  }
}

self.onmessage = async ({ data: { id, file, maxSide, p3 } }) => {
  try {
    const pixels = await decode(file, p3), w = pixels.width, h = pixels.height;
    const k = maxSide ? Math.min(1, maxSide / Math.max(w, h)) : 1;
    const bmp = await createImageBitmap(pixels, k < 1 ? { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high' } : {});
    self.postMessage({ id, bmp, w, h }, [bmp]);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
