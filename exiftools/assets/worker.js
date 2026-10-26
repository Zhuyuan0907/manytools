/* ZhuyuanLoveExif worker: reads a photo's metadata with ExifTool (the real Perl one, running as WebAssembly), and
   finds the biggest JPEG a RAW file carries inside so the page has something to show. Nothing leaves the browser.
   The Perl runtime (7.5 MB gzipped, 25 MB unpacked) is fetched once per page and kept here.
   In:  { id, file, preview }    preview: also look for an embedded JPEG
   Out: { id, ok, tags, preview: { start, end, w, h, orient } | null, ms }   or   { id, ok: false, error }
        { type: 'progress', loaded, total }, { type: 'ready' } while the runtime loads */
'use strict';
importScripts('../lib/exiftool-13.42.js');

const WASM = '../lib/zeroperl-1.0.10.wasm.gz', WASM_SIZE = 7550139;
const IN_MEMORY = 400e6;
// -G1: the group each tag came from (IFD0, ExifIFD, Canon, Composite…); -a: keep duplicates from different groups;
// -l: label, printed value and number for each. The file system's own dates are the browser's to tell, not Perl's.
const ARGS = ['-json', '-G1', '-a', '-l', '--System:all', '--ExifTool:all'];

let runtime = null;
function load() {
  if (!runtime) {
    runtime = (async () => {
      const res = await fetch(WASM);
      if (!res.ok) throw new Error('runtime ' + res.status);
      const total = +res.headers.get('Content-Length') || WASM_SIZE;
      let loaded = 0, last = 0;
      const count = new TransformStream({
        transform(chunk, c) {
          loaded += chunk.byteLength;
          if (Date.now() - last > 120) { last = Date.now(); postMessage({ type: 'progress', loaded, total }); }
          c.enqueue(chunk);
        },
      });
      const bytes = await new Response(res.body.pipeThrough(count).pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      postMessage({ type: 'ready' });
      return bytes;
    })();
    runtime.catch(() => { runtime = null; });
  }
  return runtime;
}
const wasmFetch = async () => new Response(await load(), { headers: { 'Content-Type': 'application/wasm' } });

// ---------- the biggest JPEG inside a file ----------
// RAW files keep one or more JPEG previews next to the sensor data (often a full-size one). Walk every FF D8 FF:
// segments up to the scan, then the entropy-coded data to FF D9. Only baseline/progressive JPEGs count — the
// lossless ones (SOF3) are the raw data itself in CR2 and DNG, which a browser can't show.
function exifOrientation(u, p, len) {
  // APP1 "Exif\0\0" + TIFF header: find tag 0x0112 in IFD0
  if (len < 16 || u[p + 4] !== 0x45 || u[p + 5] !== 0x78 || u[p + 6] !== 0x69 || u[p + 7] !== 0x66) return 0;
  const t = p + 10, le = u[t] === 0x49;
  const r16 = (o) => (le ? u[o] | (u[o + 1] << 8) : (u[o] << 8) | u[o + 1]);
  const r32 = (o) => (le ? (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16)) + u[o + 3] * 0x1000000 : u[o] * 0x1000000 + ((u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]));
  const ifd = t + r32(t + 4), end = p + 2 + len;
  if (ifd + 2 > end) return 0;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (r16(e) === 0x0112) return r16(e + 8) || 0;
  }
  return 0;
}
function jpegAt(u, s) {
  const n = u.length;
  let p = s + 2, w = 0, h = 0, sof = 0, orient = 0;
  for (;;) {
    if (p + 4 > n || u[p] !== 0xFF) return null;
    while (u[p + 1] === 0xFF && p + 4 < n) p++;
    const m = u[p + 1];
    if (m === 0xD9) return null;
    if (m < 0xC0 || m === 0xFF) return null;
    const len = (u[p + 2] << 8) | u[p + 3];
    if (len < 2 || p + 2 + len > n) return null;
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) { sof = m; h = (u[p + 5] << 8) | u[p + 6]; w = (u[p + 7] << 8) | u[p + 8]; }
    else if (m === 0xE1 && !orient) orient = exifOrientation(u, p, len);
    p += 2 + len;
    if (m !== 0xDA) continue;
    // entropy-coded data: stuffed FF 00 and restart markers belong to it; FF D9 ends the image; any other marker
    // (progressive JPEGs: more tables, the next scan) goes back to reading segments
    for (;;) {
      p = u.indexOf(0xFF, p);
      if (p < 0 || p + 1 >= n) return null;
      const x = u[p + 1];
      if (x === 0x00 || (x >= 0xD0 && x <= 0xD7) || x === 0xFF) { p += x === 0xFF ? 1 : 2; continue; }
      if (x === 0xD9) return sof && w && h && sof <= 0xC2 ? { start: s, end: p + 2, w, h, orient } : { skip: p + 2 };
      break;
    }
  }
}
function biggestJpeg(u) {
  let best = null;
  for (let i = u.indexOf(0xFF); i >= 0 && i + 3 < u.length; i = u.indexOf(0xFF, i + 1)) {
    if (u[i + 1] !== 0xD8 || u[i + 2] !== 0xFF) continue;
    const j = jpegAt(u, i);
    if (!j) continue;
    if (j.skip) { i = j.skip - 1; continue; }
    if (!best || j.w * j.h > best.w * best.h) best = j;
    i = j.end - 1; // a preview's own little thumbnail sits inside it; it's never the biggest
  }
  return best;
}

// ---------- one file at a time ----------
let queue = Promise.resolve();
self.onmessage = (e) => {
  const { id, file, preview, warm } = e.data;
  if (warm) {
    // fetch the runtime and run it once on nothing: Perl's first start is the slow one (~3 s), so it happens
    // while the page is being looked at rather than on the first photo
    queue = queue.then(async () => {
      try { await ExifTool.parseMetadata({ name: 'warm.jpg', data: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]) }, { args: ['-json'], fetch: wasmFetch }); } catch {}
      postMessage({ type: 'warm' });
    });
    return;
  }
  queue = queue.then(async () => {
    const t0 = performance.now();
    try {
      // Perl reads a file in memory about three times faster than through the browser's File (a CR3: 1.4 s vs
      // 4.8 s), and the preview search needs the bytes anyway. Past a few hundred MB, the File is gentler.
      const bytes = file.size <= IN_MEMORY ? new Uint8Array(await file.arrayBuffer()) : null;
      const r = await ExifTool.parseMetadata(bytes ? { name: file.name, data: bytes } : file, { args: ARGS, fetch: wasmFetch, transform: (d) => JSON.parse(d) });
      if (!r.success) throw new Error(r.error || 'exiftool');
      const tags = (Array.isArray(r.data) ? r.data[0] : r.data) || {};
      const pv = preview ? biggestJpeg(bytes || new Uint8Array(await file.arrayBuffer())) : null;
      postMessage({ id, ok: true, tags, preview: pv, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
  });
};
