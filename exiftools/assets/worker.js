/* ZhuyuanLoveExif worker: reads photos' metadata with ExifTool (the real Perl one, running as WebAssembly), and
   finds the biggest JPEG a RAW file carries inside (meta.js) so the page has something to show. Nothing leaves
   the browser. The Perl runtime (7.5 MB gzipped, 25 MB unpacked) is compiled once per page while it downloads.
   Not used in Safari (see meta.js); sets of photos are read by meta.js too, which is quicker for what they need.
   In:  { warm, mobile }                         start the runtime (mobile: keep Perl's memory smaller)
        { id, file, preview, side }             one photo, everything; side: its Lightroom .xmp, merged in
   Out: { id, ok, tags, preview: { start, end, w, h, orient } | null, ms }   or   { id, ok: false, error }
        { type: 'progress', loaded, total }, { type: 'ready' }, { type: 'warm' } while the runtime loads */
'use strict';
importScripts('../lib/exiftool-13.42.js?v=3', 'meta.js');

const WASM = '../lib/zeroperl-1.0.10.wasm.gz', WASM_SIZE = 7550139;
const IN_MEMORY = 400e6;
// -G1: the group each tag came from (IFD0, ExifIFD, Canon, Composite…); -a: keep duplicates from different groups;
// -l: label, printed value and number for each. The file system's own dates are the browser's to tell, not Perl's.
const ARGS = ['-json', '-G1', '-a', '-l', '--System:all', '--ExifTool:all'];
// Perl's memory only grows (about 15 MB a photo); past this the interpreter is replaced by a fresh one. A phone's
// browser closes a page that uses too much, so there it's replaced sooner.
let PERL_LIMIT = 260e6;

// ---------- the runtime: compiled while it downloads, the bytes never kept ----------
let compiled = null;
function load() {
  if (!compiled) {
    compiled = (async () => {
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
      const wasm = new Response(res.body.pipeThrough(count).pipeThrough(new DecompressionStream('gzip')), { headers: { 'Content-Type': 'application/wasm' } });
      self.__zeroperl = WebAssembly.compileStreaming ? await WebAssembly.compileStreaming(wasm) : await WebAssembly.compile(await wasm.arrayBuffer());
      postMessage({ type: 'ready' });
    })();
    compiled.catch(() => { compiled = null; });
  }
  return compiled;
}
// the library asks for the WASM's bytes; it's compiled already (self.__zeroperl), so it gets none
const wasmFetch = async () => { await load(); return new Response(new ArrayBuffer(0)); };
const parse = (file, opts) => ExifTool.parseMetadata(file, { fetch: wasmFetch, transform: (d) => JSON.parse(d), ...opts });
const extOf = (name) => ((name.match(/\.([a-z0-9]{1,5})$/i) || [, 'bin'])[1]).toLowerCase();
const warmRun = () => ExifTool.parseMetadata({ name: 'warm.jpg', data: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]) }, { args: ['-json'], fetch: wasmFetch });
// after each job: a grown interpreter goes, and a fresh one starts while nothing else is waiting
function tidy() {
  const mem = self.__perlMem;
  if (mem && mem.buffer.byteLength > PERL_LIMIT) {
    ExifTool.drop();
    queue = queue.then(() => warmRun().catch(() => {}));
  }
}

// ---------- one job at a time ----------
let queue = Promise.resolve();
self.onmessage = (e) => {
  const { id, file, preview, side, warm, mobile } = e.data;
  if (warm) {
    if (mobile) PERL_LIMIT = 120e6;
    // fetch the runtime and run it once on nothing: Perl's first start is the slow one (~3 s), so it happens
    // while the page is being looked at rather than on the first photo
    queue = queue.then(async () => {
      try { await warmRun(); } catch {}
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
      const more = side ? [{ name: `side.${extOf(side.name)}`, data: new Uint8Array(await side.arrayBuffer()) }] : undefined;
      const r = await parse(bytes ? { name: file.name, data: bytes } : file, { args: ARGS, more });
      if (!r.success) throw new Error(r.error || 'exiftool');
      const list = Array.isArray(r.data) ? r.data : [r.data];
      const tags = list[0] || {};
      // a RAW file's Lightroom settings live in its .xmp: those win over anything the file says in XMP
      if (side && list[1]) for (const [k, v] of Object.entries(list[1])) if (/^XMP-/.test(k)) tags[k] = v;
      const pv = preview ? ZMeta.biggestJpeg(bytes || new Uint8Array(await file.arrayBuffer())) : null;
      postMessage({ id, ok: true, tags, preview: pv, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
    tidy();
  });
};
