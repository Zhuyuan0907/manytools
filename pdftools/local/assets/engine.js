/* The processing pipeline. Turns a "project" (one or more source PDFs, viewed as one long run of pages)
   into output PDFs, one per section. Every step runs in this browser tab; no data leaves the computer.

   For each output file:
     1. If it can stay as it is (the original file, or a lossless page copy) and that fits the limit, keep it:
        text stays sharp and selectable.
     2. Otherwise flatten each page to an image and search a quality ladder for the best version that fits. */
(function () {
  'use strict';
  const { MB } = Core;
  const SAFETY = 0.98;              // keep 2% headroom under the stated limit
  const MAX_PIXELS = 15_000_000;    // per rendered page; stays under iOS canvas limits
  const PAGE_OVERHEAD = 900;        // bytes of PDF structure per page, estimated before assembling
  const DOC_OVERHEAD = 6000;

  const JPEG_LADDER = [
    [200, .85], [180, .82], [165, .80], [150, .77], [140, .74], [130, .71], [120, .68], [110, .65],
    [100, .62], [96, .57], [90, .52], [84, .48], [78, .44], [72, .40], [66, .36], [60, .32],
  ].map(([dpi, q]) => ({ fmt: 'jpeg', dpi, q }));
  const PNG_LADDER = [
    [150, 0], [150, 256], [140, 128], [130, 64], [120, 64], [120, 32], [110, 32], [100, 32],
    [100, 16], [90, 16], [84, 16], [78, 16], [72, 16], [72, 8], [66, 8], [60, 8],
  ].map(([dpi, colors]) => ({ fmt: 'png', dpi, colors }));

  class Cancelled extends Error { constructor() { super('cancelled'); this.name = 'Cancelled'; } }
  const check = (job) => { if (job && job.cancelled) throw new Cancelled(); };

  // ---------- page addressing ----------
  function locate(project, g) {
    for (const s of project.sources) {
      if (g < s.offset + s.numPages) return { src: s, n: g - s.offset + 1 };
    }
    throw new Error('page out of range ' + g);
  }

  async function resolveDest(src, dest) {
    try {
      const d = typeof dest === 'string' ? await src.pdf.getDestination(dest) : dest;
      if (!Array.isArray(d)) return null;
      const ref = d[0];
      const idx = ref && typeof ref === 'object' ? await src.pdf.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
      return idx == null ? null : src.offset + idx;
    } catch { return null; }
  }

  // Size and links of a page, cached per project.
  async function pageInfo(project, g, page) {
    if (project.info[g]) return project.info[g];
    const { src, n } = locate(project, g);
    const pg = page || await src.pdf.getPage(n);
    const vp1 = pg.getViewport({ scale: 1 });
    const links = [];
    let annots = [];
    try { annots = await pg.getAnnotations({ intent: 'display' }); } catch { /* no annotations */ }
    for (const a of annots) {
      if (a.subtype !== 'Link' || !Array.isArray(a.rect)) continue;
      const r = vp1.convertToViewportRectangle(a.rect);
      const x1 = Math.min(r[0], r[2]), x2 = Math.max(r[0], r[2]);
      const y1 = Math.min(r[1], r[3]), y2 = Math.max(r[1], r[3]);
      const rect = [x1, vp1.height - y2, x2, vp1.height - y1];   // in the flattened page's coordinates
      const raw = a.rect.slice();                                 // in the original page's own coordinates
      if (a.url) links.push({ rect, raw, url: a.url });
      else if (a.dest) {
        const target = await resolveDest(src, a.dest);
        if (target != null) links.push({ rect, raw, page: target });
      }
    }
    const info = { wPt: vp1.width, hPt: vp1.height, links };
    project.info[g] = info;
    if (!page) pg.cleanup();
    return info;
  }

  // Bookmarks of all sources, with destinations resolved to global page numbers.
  async function outlineTree(project) {
    if (project.outline) return project.outline;
    const all = [];
    for (const src of project.sources) {
      let items = null;
      try { items = await src.pdf.getOutline(); } catch { items = null; }
      if (!items) continue;
      const walk = async (list) => {
        const out = [];
        for (const it of list) {
          out.push({
            title: it.title || '',
            url: it.url || null,
            page: it.dest ? await resolveDest(src, it.dest) : null,
            items: it.items && it.items.length ? await walk(it.items) : [],
          });
        }
        return out;
      };
      all.push(...await walk(items));
    }
    project.outline = all;
    return all;
  }

  // Keep the bookmarks that point into this output; children of dropped parents move up a level.
  function filterOutline(nodes, localOf) {
    const out = [];
    for (const n of nodes) {
      const kids = filterOutline(n.items, localOf);
      const local = n.page != null ? localOf.get(n.page) : undefined;
      if (local !== undefined || n.url) out.push({ title: n.title, url: n.url, page: local, items: kids });
      else out.push(...kids);
    }
    return out;
  }

  function writeOutline(doc, nodes, pages) {
    if (!nodes.length) return 0;
    const { PDFHexString, PDFName } = PDFLib;
    const ctx = doc.context;
    let count = 0;
    const build = (items, parentRef) => {
      const refs = items.map(() => ctx.nextRef());
      items.forEach((it, i) => {
        const dict = { Title: PDFHexString.fromText(it.title), Parent: parentRef };
        if (it.url) dict.A = { Type: 'Action', S: 'URI', URI: uriString(it.url) };
        else if (it.page !== undefined && pages[it.page]) dict.Dest = [pages[it.page].ref, 'Fit'];
        if (i > 0) dict.Prev = refs[i - 1];
        if (i < items.length - 1) dict.Next = refs[i + 1];
        if (it.items.length) {
          const kids = build(it.items, refs[i]);
          dict.First = kids[0]; dict.Last = kids[kids.length - 1]; dict.Count = -kids.length;
        }
        ctx.assign(refs[i], ctx.obj(dict));
        count++;
      });
      return refs;
    };
    const root = ctx.nextRef();
    const top = build(nodes, root);
    ctx.assign(root, ctx.obj({ Type: 'Outlines', First: top[0], Last: top[top.length - 1], Count: top.length }));
    doc.catalog.set(PDFName.of('Outlines'), root);
    return count;
  }

  // PDFString.of() writes its value verbatim: escape \ ( ) and percent-encode anything non-ASCII.
  function uriString(url) {
    const safe = url.replace(/[^\x21-\x7e]/g, (ch) => encodeURIComponent(ch)).replace(/[\\()]/g, '\\$&');
    return PDFLib.PDFString.of(safe);
  }

  function addLink(doc, page, rect, target) {
    const action = target.url
      ? { A: { Type: 'Action', S: 'URI', URI: uriString(target.url) } }
      : { Dest: [target.pageRef, 'Fit'] };
    const annot = doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: rect.map((v) => Math.round(v * 100) / 100), Border: [0, 0, 0], ...action,
    });
    page.node.addAnnot(doc.context.register(annot));
  }

  // ---------- rendering ----------
  function toGray(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114 + 500) / 1000 | 0;
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    ctx.putImageData(img, 0, 0);
  }

  async function renderPage(project, g, dpi, gray, job) {
    const { src, n } = locate(project, g);
    const page = await src.pdf.getPage(n);
    try {
      const info = await pageInfo(project, g, page);
      const scale = Math.min(dpi / 72, Math.sqrt(MAX_PIXELS / (info.wPt * info.hPt)));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const task = page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff', annotationMode: pdfjsLib.AnnotationMode.ENABLE });
      if (job) job.renderTask = task;
      try { await task.promise; }
      catch (e) { if (job && job.cancelled) throw new Cancelled(); throw e; }
      finally { if (job) job.renderTask = null; }
      if (gray) toGray(ctx, canvas.width, canvas.height);
      return { canvas, info };
    } finally {
      page.cleanup();
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片編碼失敗，頁面可能太大'))), type, quality);
    });
  }

  // Shrink step by step (halving) so thin strokes stay smooth, then draw at the exact size.
  function drawScaled(src, sw, sh, dw, dh) {
    let cur = src, cw = sw, ch = sh;
    const temps = [];
    while (cw / 2 >= dw && ch / 2 >= dh) {
      const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
      const t = document.createElement('canvas');
      t.width = nw; t.height = nh;
      const tc = t.getContext('2d');
      tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
      tc.drawImage(cur, 0, 0, nw, nh);
      temps.push(t); cur = t; cw = nw; ch = nh;
    }
    const out = document.createElement('canvas');
    out.width = dw; out.height = dh;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, dw, dh);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, dw, dh);
    for (const t of temps) { t.width = 0; t.height = 0; }
    return out;
  }

  // ---------- image encoding ----------
  function parsePng(bytes) {
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8, ihdr = null, plte = null;
    const idat = [];
    while (pos + 8 <= bytes.length) {
      const len = dv.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const data = bytes.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') ihdr = { w: dv.getUint32(pos + 8), h: dv.getUint32(pos + 12), depth: bytes[pos + 16], ctype: bytes[pos + 17], interlace: bytes[pos + 20] };
      else if (type === 'PLTE') plte = data;
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      pos += 12 + len;
    }
    if (!ihdr || !idat.length) return null;
    let total = 0;
    for (const c of idat) total += c.length;
    const data = new Uint8Array(total);
    let o = 0;
    for (const c of idat) { data.set(c, o); o += c.length; }
    return { ...ihdr, plte, data };
  }

  function embedFlateImage(doc, { w, h, depth, colorSpace, colors, data }) {
    const dict = doc.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: depth,
      ColorSpace: colorSpace, Filter: 'FlateDecode',
      DecodeParms: { Predictor: 15, Colors: colors, BitsPerComponent: depth, Columns: w },
    });
    return doc.context.register(PDFLib.PDFRawStream.of(dict, data));
  }

  // PNG straight into the PDF: its compressed rows are valid Flate data with PNG predictors.
  function embedPngDirect(doc, bytes) {
    const p = parsePng(bytes);
    if (!p || p.interlace || p.depth > 8 || ![0, 2, 3].includes(p.ctype)) return null;
    let colorSpace;
    if (p.ctype === 0) colorSpace = 'DeviceGray';
    else if (p.ctype === 2) colorSpace = 'DeviceRGB';
    else {
      if (!p.plte || p.plte.length < 3) return null;
      let hex = '';
      for (let i = 0; i < p.plte.length; i++) hex += p.plte[i].toString(16).padStart(2, '0');
      colorSpace = ['Indexed', 'DeviceRGB', p.plte.length / 3 - 1, PDFLib.PDFHexString.of(hex)];
    }
    return embedFlateImage(doc, { w: p.w, h: p.h, depth: p.depth, colorSpace, colors: p.ctype === 2 ? 3 : 1, data: p.data });
  }

  // Lossless grayscale: one byte per pixel with PNG row filters, deflated, embedded as DeviceGray.
  function encodeGrayLossless(rgba, w, h) {
    const rowLen = w + 1;
    const out = new Uint8Array(rowLen * h);
    const cur = new Uint8Array(w), prev = new Uint8Array(w);
    const cand = [new Uint8Array(w), new Uint8Array(w), new Uint8Array(w), new Uint8Array(w)];
    for (let y = 0; y < h; y++) {
      const base = y * w * 4;
      for (let x = 0; x < w; x++) cur[x] = rgba[base + x * 4];
      let best = 0, bestSum = Infinity;
      for (let f = 0; f < 4; f++) {
        const c = cand[f];
        let sum = 0;
        for (let x = 0; x < w; x++) {
          const a = x ? cur[x - 1] : 0, b = prev[x], cc = x ? prev[x - 1] : 0;
          let v;
          if (f === 0) v = cur[x];
          else if (f === 1) v = cur[x] - a;
          else if (f === 2) v = cur[x] - b;
          else {
            const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
            v = cur[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc);
          }
          v &= 255; c[x] = v; sum += v < 128 ? v : 256 - v;
        }
        if (sum < bestSum) { bestSum = sum; best = f; }
      }
      out[y * rowLen] = best === 3 ? 4 : best;
      out.set(cand[best], y * rowLen + 1);
      prev.set(cur);
    }
    return pako.deflate(out, { level: 6 });
  }

  async function encodeFrom(src, sw, sh, info, s, gray) {
    let dw = Math.max(1, Math.round(info.wPt * s.dpi / 72));
    let dh = Math.max(1, Math.round(info.hPt * s.dpi / 72));
    if (dw > sw || dh > sh) { dw = sw; dh = sh; }   // never upscale
    const c = (dw === sw && dh === sh && src instanceof HTMLCanvasElement) ? src : drawScaled(src, sw, sh, dw, dh);
    try {
      if (s.fmt === 'jpeg') {
        const blob = await canvasToBlob(c, 'image/jpeg', s.q);
        return { kind: 'jpeg', blob, size: blob.size };
      }
      const rgba = c.getContext('2d').getImageData(0, 0, dw, dh).data;
      if (s.colors === 0 && gray) {
        const data = encodeGrayLossless(rgba, dw, dh);
        return { kind: 'gray', data, w: dw, h: dh, size: data.length };
      }
      // UPNG's quantizer can merge distinct flat colours when a page has fewer colours than the
      // palette; such pages get an exact palette from the lossless path instead.
      let cnum = s.colors;
      if (cnum) {
        const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
        const seen = new Set();
        for (let i = 0; i < u32.length && seen.size <= cnum; i++) seen.add(u32[i]);
        if (seen.size <= cnum) cnum = 0;
      }
      const png = new Uint8Array(UPNG.encode([rgba.buffer], dw, dh, cnum));
      return { kind: 'png', data: png, size: png.length };
    } finally {
      if (c !== src) { c.width = 0; c.height = 0; }
    }
  }

  // ---------- assembling a flattened PDF ----------
  async function assembleFlat(project, pagesG, images, title, job) {
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.create();
    const pages = [];
    for (let i = 0; i < pagesG.length; i++) {
      check(job);
      const info = project.info[pagesG[i]], im = images[i];
      const page = doc.addPage([info.wPt, info.hPt]);
      let ref = null;
      if (im.kind === 'jpeg') {
        const img = await doc.embedJpg(new Uint8Array(await im.blob.arrayBuffer()));
        page.drawImage(img, { x: 0, y: 0, width: info.wPt, height: info.hPt });
      } else {
        ref = im.kind === 'gray'
          ? embedFlateImage(doc, { w: im.w, h: im.h, depth: 8, colorSpace: 'DeviceGray', colors: 1, data: im.data })
          : embedPngDirect(doc, im.data);
        if (ref) {
          const name = page.node.newXObject('Im', ref);
          page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(info.wPt, 0, 0, info.hPt, 0, 0), PDFLib.drawObject(name), PDFLib.popGraphicsState());
        } else {
          const img = await doc.embedPng(im.data);
          page.drawImage(img, { x: 0, y: 0, width: info.wPt, height: info.hPt });
        }
      }
      pages.push(page);
      if (i % 8 === 7) await Core.nextFrame();
    }
    const localOf = new Map(pagesG.map((g, i) => [g, i]));
    let linkCount = 0;
    pagesG.forEach((g, i) => {
      for (const l of project.info[g].links) {
        if (l.url) { addLink(doc, pages[i], l.rect, { url: l.url }); linkCount++; }
        else if (localOf.has(l.page)) { addLink(doc, pages[i], l.rect, { pageRef: pages[localOf.get(l.page)].ref }); linkCount++; }
      }
    });
    const marks = writeOutline(doc, filterOutline(await outlineTree(project), localOf), pages);
    finishMeta(doc, title);
    const bytes = await doc.save({ useObjectStreams: true });
    return { bytes, linkCount, marks };
  }

  function finishMeta(doc, title) {
    doc.setTitle(title);
    doc.setCreator('ZhuyuanLovePDF');
    doc.setProducer('ZhuyuanLovePDF（pdf.js + pdf-lib，於瀏覽器內處理）');
  }

  // ---------- lossless slimming ----------
  // Things that change no pixel, letter or line. storeOnce (every output, cheap): identical images, fonts and
  // drawings kept once. slimDoc (only when the copy is still too big): streams deflated again, raw images given
  // PNG row filters or a palette, thumbnails and editing apps' private data dropped.
  const REDEFLATE = new Set(['FlateDecode', 'LZWDecode', 'ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode']);
  const nativeDeflate = typeof CompressionStream === 'function'
    ? async (data) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
    : null;
  // the strongest setting for small streams; the browser's own zlib (several times faster) for big ones
  const deflate = (data) => (data.length > 256 * 1024 && nativeDeflate ? nativeDeflate(data) : pako.deflate(data, { level: 9 }));

  // Samples per pixel of an image, whatever its colour space, or null when unknown.
  function samplesOf(dict) {
    if (dict.get(N_('ImageMask')) === PDFLib.PDFBool.True) return 1;
    let cs = dict.lookup(N_('ColorSpace'));
    if (cs instanceof PDFLib.PDFArray && cs.size()) {
      const kind = cs.get(0);
      if (kind === N_('ICCBased')) { const icc = cs.lookup(1); return icc instanceof PDFLib.PDFRawStream ? num(icc.dict.get(N_('N'))) : null; }
      if (kind === N_('Indexed') || kind === N_('Separation') || kind === N_('CalGray')) return 1;
      if (kind === N_('CalRGB') || kind === N_('Lab')) return 3;
      if (kind === N_('DeviceN')) { const names = cs.lookup(1); return names instanceof PDFLib.PDFArray ? names.size() : null; }
      cs = kind;
    }
    return { DeviceGray: 1, CalGray: 1, DeviceRGB: 3, CalRGB: 3, DeviceCMYK: 4 }[cs instanceof PDFLib.PDFName ? cs.decodeText() : ''] || null;
  }

  // PNG row filters: for each row, the one of the five whose output has the smallest sum of absolute values.
  function filterRows(raw, rowLen, rows, bpp) {
    const out = new Uint8Array((rowLen + 1) * rows);
    // filters one row into dst (or only measures it); gives up once the cost passes limit
    const run = (f, y, dst, limit) => {
      const cur = y * rowLen, up = cur - rowLen;
      let sum = 0;
      for (let x = 0; x < rowLen; x++) {
        const v0 = raw[cur + x], a = x >= bpp ? raw[cur + x - bpp] : 0, b = y ? raw[up + x] : 0;
        let v;
        if (f === 0) v = v0;
        else if (f === 1) v = v0 - a;
        else if (f === 2) v = v0 - b;
        else if (f === 3) v = v0 - ((a + b) >> 1);
        else {
          const c = y && x >= bpp ? raw[up + x - bpp] : 0, p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = v0 - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
        v &= 255;
        if (dst) dst[x] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= limit) break;
      }
      return sum;
    };
    for (let y = 0; y < rows; y++) {
      let best = 0, bestSum = Infinity;
      for (let f = 0; f < 5; f++) { const sum = run(f, y, null, bestSum); if (sum < bestSum) { bestSum = sum; best = f; } }
      const at = y * (rowLen + 1);
      out[at] = best;
      run(best, y, out.subarray(at + 1, at + 1 + rowLen), Infinity);
    }
    return out;
  }

  // An RGB image with 256 colours or fewer, as the exact same picture with a palette: one index per pixel,
  // packed to 1, 2 or 4 bits when there are that few colours. The palette is built on the image's own colour space.
  function toPalette(raw, W, H, base, ctx) {
    const px = W * H, idx = new Uint8Array(px), map = new Map(), plte = [];
    for (let i = 0, j = 0; i < px; i++, j += 3) {
      const c = (raw[j] << 16) | (raw[j + 1] << 8) | raw[j + 2];
      let k = map.get(c);
      if (k === undefined) {
        if (plte.length === 256) return null;
        k = plte.length; map.set(c, k); plte.push(c);
      }
      idx[i] = k;
    }
    const n = plte.length, depth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
    let data = idx;
    if (depth < 8) {   // rows start on a byte, as PDF wants
      const per = 8 / depth, rowLen = Math.ceil(W / per);
      data = new Uint8Array(rowLen * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * rowLen + ((x / per) | 0)] |= idx[y * W + x] << (8 - depth * ((x % per) + 1));
    }
    let hex = '';
    for (const c of plte) hex += c.toString(16).padStart(6, '0');
    return { data, bpc: depth, colorSpace: ctx.obj([N_('Indexed'), base, n - 1, PDFLib.PDFHexString.of(hex)]) };
  }

  // pdf-lib writes every object it holds, referenced or not: drop what nothing points to any more.
  function dropUnreachable(doc) {
    const ctx = doc.context, seen = new Set(), todo = [];
    const visit = (o) => {
      if (o instanceof PDFLib.PDFRef) { if (!seen.has(o)) { seen.add(o); todo.push(o); } }
      else if (o instanceof PDFLib.PDFDict) for (const [, v] of o.entries()) visit(v);
      else if (o instanceof PDFLib.PDFArray) for (let i = 0; i < o.size(); i++) visit(o.get(i));
      else if (o instanceof PDFLib.PDFStream) visit(o.dict);
    };
    visit(ctx.trailerInfo.Root); visit(ctx.trailerInfo.Info);
    while (todo.length) visit(ctx.lookup(todo.pop()));
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref)) ctx.delete(ref);
  }

  // Returns whether anything changed.
  async function slimDoc(doc, job, progress) {
    const ctx = doc.context, all = ctx.enumerateIndirectObjects();
    let changed = false;
    for (let k = 0; k < all.length; k++) {
      const [ref, obj] = all[k];
      if (k % 8 === 0) { check(job); progress(k / all.length); await Core.nextFrame(); }
      const dict = obj instanceof PDFLib.PDFRawStream ? obj.dict : obj instanceof PDFLib.PDFDict ? obj : null;
      if (!dict) continue;
      // display never uses these: editing apps' private data, page thumbnails, per-object XMP metadata
      for (const key of ['PieceInfo', 'Thumb', 'Metadata']) {
        if (!dict.has(N_(key)) || (key === 'Metadata' && dict === doc.catalog) || (key === 'Thumb' && dict.get(N_('Type')) !== N_('Page'))) continue;
        dict.delete(N_(key));
        changed = true;
      }
      if (!(obj instanceof PDFLib.PDFRawStream)) continue;
      const type = dict.get(N_('Type'));
      if (type === N_('XRef') || type === N_('ObjStm') || type === N_('Metadata')) continue;
      let f = dict.lookup(N_('Filter'));
      f = f === undefined ? [] : f instanceof PDFLib.PDFArray ? f.asArray() : [f];
      const names = f.map((x) => (x instanceof PDFLib.PDFName ? x.decodeText() : '?'));
      if (!names.every((n) => REDEFLATE.has(n))) continue;          // JPEG, JPEG 2000, fax, JBIG2 stay as they are
      const parms = dict.lookup(N_('DecodeParms'));
      if (parms && (names.length !== 1 || !(parms instanceof PDFLib.PDFDict))) continue;
      const before = obj.contents.length;
      if (before < 200) continue;
      let data;
      try { data = names.length ? PDFLib.decodePDFRawStream(obj).decode() : obj.contents; } catch { continue; }
      // the decoded bytes keep any PNG/TIFF predictor, so its parameters carry over (minus LZW's own)
      const predictor = parms ? num(parms.get(N_('Predictor'))) || 1 : 1;
      const keep = {};
      if (parms) for (const [key, v] of parms.entries()) if (key !== N_('EarlyChange')) keep[key.decodeText()] = v;
      const tries = [{ bytes: await deflate(data), parms: parms ? keep : null }];
      // raw images: PNG row filters, and a palette when there are few colours
      const W = num(dict.get(N_('Width'))), H = num(dict.get(N_('Height')));
      const bpc = dict.get(N_('ImageMask')) === PDFLib.PDFBool.True ? 1 : num(dict.get(N_('BitsPerComponent')));
      const spp = dict.get(N_('Subtype')) === N_('Image') && predictor === 1 ? samplesOf(dict) : null;
      if (spp && W && H && [1, 2, 4, 8, 16].includes(bpc)) {
        const rowLen = Math.ceil((W * spp * bpc) / 8);
        if (data.length >= rowLen * H) {
          const raw = data.subarray(0, rowLen * H);
          tries.push({ bytes: await deflate(filterRows(raw, rowLen, H, Math.max(1, (spp * bpc) >> 3))), parms: { Predictor: 15, Colors: spp, BitsPerComponent: bpc, Columns: W } });
          // a colour-key /Mask or a /Decode array would mean something else on palette indexes
          if (spp === 3 && bpc === 8 && !dict.has(N_('Decode')) && !(dict.lookup(N_('Mask')) instanceof PDFLib.PDFArray)) {
            const pal = toPalette(raw, W, H, dict.get(N_('ColorSpace')), ctx);
            if (pal) tries.push({ bytes: await deflate(pal.data), parms: null, colorSpace: pal.colorSpace, bpc: pal.bpc });
          }
        }
      }
      const best = tries.reduce((a, b) => (b.bytes.length < a.bytes.length ? b : a));
      if (best.bytes.length > before * 0.97) continue;               // not worth touching
      dict.set(N_('Filter'), N_('FlateDecode'));
      if (best.parms) dict.set(N_('DecodeParms'), ctx.obj(best.parms)); else dict.delete(N_('DecodeParms'));
      if (best.colorSpace) { dict.set(N_('ColorSpace'), best.colorSpace); dict.set(N_('BitsPerComponent'), PDFLib.PDFNumber.of(best.bpc)); }
      ctx.assign(ref, PDFLib.PDFRawStream.of(dict, best.bytes));
      changed = true;
    }
    if (changed) dropUnreachable(doc);
    return changed;
  }

  // Identical streams (images, fonts, drawings), fonts and indirect arrays are kept once and shared; repeated
  // passes catch fonts whose parts only became identical in the previous pass. Typical of merged files and of
  // apps that embed the same logo or font again on every page.
  const SHARE_TYPES = new Set(['Font', 'FontDescriptor', 'ExtGState', 'Encoding']);
  function storeOnce(doc) {
    const ctx = doc.context;
    const hash = (b) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619); return h >>> 0; };
    const fix = (o, map) => {
      if (o instanceof PDFLib.PDFDict) {
        for (const [k, v] of o.entries()) { if (v instanceof PDFLib.PDFRef) { if (map.has(v)) o.set(k, map.get(v)); } else fix(v, map); }
      } else if (o instanceof PDFLib.PDFArray) {
        for (let i = 0; i < o.size(); i++) { const v = o.get(i); if (v instanceof PDFLib.PDFRef) { if (map.has(v)) o.set(i, map.get(v)); } else fix(v, map); }
      } else if (o instanceof PDFLib.PDFStream) fix(o.dict, map);
    };
    let shared = 0;
    for (let pass = 0; pass < 4; pass++) {
      const seen = new Map(), map = new Map();
      for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        let key;
        if (obj instanceof PDFLib.PDFRawStream) {
          if (obj.dict.get(N_('Type')) === N_('Metadata')) continue;
          key = `s${obj.contents.length}:${hash(obj.contents)}:${obj.dict.toString().replace(/\/Length \d+/, '')}`;
        } else if (obj instanceof PDFLib.PDFDict) {
          const t = obj.get(N_('Type'));
          if (!(t instanceof PDFLib.PDFName) || !SHARE_TYPES.has(t.decodeText())) continue;
          key = `d${obj.toString()}`;
        } else if (obj instanceof PDFLib.PDFArray) key = `a${obj.toString()}`;
        else continue;
        const first = seen.get(key);
        if (!first) { seen.set(key, { ref, obj }); continue; }
        if (obj instanceof PDFLib.PDFRawStream) {
          const a = first.obj.contents, b = obj.contents;
          let same = a.length === b.length;
          for (let i = 0; same && i < a.length; i++) same = a[i] === b[i];
          if (!same) continue;
        }
        map.set(ref, first.ref);
      }
      if (!map.size) break;
      for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj, map);
      for (const k of ['Root', 'Info']) if (map.has(ctx.trailerInfo[k])) ctx.trailerInfo[k] = map.get(ctx.trailerInfo[k]);
      for (const ref of map.keys()) ctx.delete(ref);
      shared += map.size;
    }
    return shared;
  }

  // ---------- lossless page copies ----------
  // pdf-lib copy of a source with internal-link annotations and page back-references removed,
  // so copying a few pages never drags other pages along. Internal links are re-added afterwards.
  // Protected sources are decrypted first (pdfcrypt.js), with the password typed for them, if any.
  async function libDoc(src) {
    if (!src.libDocPromise) {
      src.libDocPromise = (async () => {
        const bytes = new Uint8Array(await src.file.arrayBuffer());
        const doc = window.PdfCrypt
          ? await PdfCrypt.load(bytes, src.password)
          : await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
        const { PDFName, PDFArray, PDFDict } = PDFLib;
        const N = (s) => PDFName.of(s);
        for (const page of doc.getPages()) {
          const annots = page.node.lookup(N('Annots'));
          page.node.delete(N('B'));
          if (!(annots instanceof PDFArray)) continue;
          const keep = [];
          for (let i = 0; i < annots.size(); i++) {
            const ref = annots.get(i);
            const dict = annots.lookup(i);
            if (!(dict instanceof PDFDict)) continue;
            if (dict.get(N('Subtype')) === N('Link')) {
              if (dict.has(N('Dest'))) continue;
              const a = dict.lookup(N('A'));
              if (a instanceof PDFDict && a.get(N('S')) === N('GoTo')) continue;
            }
            dict.delete(N('P'));
            keep.push(ref);
          }
          page.node.set(N('Annots'), doc.context.obj(keep));
        }
        return doc;
      })();
    }
    return src.libDocPromise;
  }

  async function buildLossless(project, pagesG, title, job) {
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.create();
    const pages = [];
    let unlocked = false;
    // copy consecutive runs from the same source in one call
    let i = 0;
    while (i < pagesG.length) {
      check(job);
      const { src } = locate(project, pagesG[i]);
      const run = [];
      while (i < pagesG.length && locate(project, pagesG[i]).src === src) { run.push(pagesG[i] - src.offset); i++; }
      const from = await libDoc(src);
      unlocked = unlocked || !!from.wasEncrypted;
      const copied = await doc.copyPages(from, run);
      for (const p of copied) pages.push(doc.addPage(p));
    }
    const localOf = new Map(pagesG.map((g, k) => [g, k]));
    let linkCount = 0;
    for (let k = 0; k < pagesG.length; k++) {
      const info = await pageInfo(project, pagesG[k]);
      for (const l of info.links) {
        if (l.url) linkCount++;   // URI links travel with the copied page
        else if (localOf.has(l.page)) { addLink(doc, pages[k], l.raw, { pageRef: pages[localOf.get(l.page)].ref }); linkCount++; }
      }
    }
    writeOutline(doc, filterOutline(await outlineTree(project), localOf), pages);
    finishMeta(doc, title);
    try { storeOnce(doc); } catch (e) { console.warn('sharing identical objects skipped', e); }
    const bytes = await doc.save({ useObjectStreams: true });
    return { bytes, linkCount, doc, unlocked };
  }

  // ---------- stage 1: shrink the images, keep text and vector graphics as they are ----------
  // Online compressors ("same quality, smaller file") work this way. Each image's effective DPI is
  // measured from where the page content draws it; images sharper than needed are resampled and
  // re-encoded. Text, lines, links and bookmarks are untouched, so they stay crisp and selectable.
  const SMART_LADDER = [
    [220, .85], [200, .82], [180, .80], [160, .78], [150, .75], [135, .72], [120, .70],
    [110, .66], [100, .62], [90, .58], [80, .52], [72, .46], [66, .40], [60, .32],
  ].map(([dpi, q]) => ({ dpi, q }));
  const SMART_TOP = SMART_LADDER[0].dpi;

  const N_ = (n) => PDFLib.PDFName.of(n);
  const num = (o) => (o instanceof PDFLib.PDFNumber ? o.asNumber() : null);
  function decodedBytes(stream) {
    if (stream instanceof PDFLib.PDFRawStream) return PDFLib.decodePDFRawStream(stream).decode();
    if (stream && typeof stream.getUnencodedContents === 'function') return stream.getUnencodedContents();
    return new Uint8Array(0);
  }

  // Minimal content-stream reader: tracks q/Q/cm and reports every "/Name Do" with the current matrix.
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
  function walkContent(str, onDo) {
    const n = str.length;
    let i = 0;
    let ctm = [1, 0, 0, 1, 0, 0];
    const saved = [];
    const ops = [];
    const skipString = () => {          // at "(": skip a literal string with nesting and escapes
      let depth = 1; i++;
      while (i < n && depth) {
        const ch = str.charCodeAt(i);
        if (ch === 92) i += 2;
        else { if (ch === 40) depth++; else if (ch === 41) depth--; i++; }
      }
    };
    while (i < n) {
      const c = str.charCodeAt(i);
      if (WS.has(c)) { i++; continue; }
      if (c === 37) { while (i < n && str[i] !== '\n' && str[i] !== '\r') i++; continue; }
      if (c === 40) { skipString(); ops.push(null); continue; }
      if (c === 60) {
        if (str.charCodeAt(i + 1) === 60) {          // << dict >>
          let depth = 1; i += 2;
          while (i < n && depth) {
            if (str.charCodeAt(i) === 40) { skipString(); continue; }
            if (str.startsWith('<<', i)) { depth++; i += 2; } else if (str.startsWith('>>', i)) { depth--; i += 2; } else i++;
          }
        } else { const j = str.indexOf('>', i); i = j < 0 ? n : j + 1; }
        ops.push(null); continue;
      }
      if (c === 91) {                                  // [ array ]
        let depth = 1; i++;
        while (i < n && depth) {
          const ch = str.charCodeAt(i);
          if (ch === 40) { skipString(); continue; }
          if (ch === 91) depth++; else if (ch === 93) depth--;
          i++;
        }
        ops.push(null); continue;
      }
      if (c === 47) {                                  // /Name
        let j = i + 1;
        while (j < n && !WS.has(str.charCodeAt(j)) && !DELIM.has(str.charCodeAt(j))) j++;
        ops.push({ name: str.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) });
        i = j; continue;
      }
      if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
        let j = i + 1;
        while (j < n && /[0-9.]/.test(str[j])) j++;
        ops.push(parseFloat(str.slice(i, j)));
        i = j; continue;
      }
      let j = i;
      while (j < n && !WS.has(str.charCodeAt(j)) && !DELIM.has(str.charCodeAt(j))) j++;
      if (j === i) { i++; ops.length = 0; continue; }   // stray delimiter
      const op = str.slice(i, j);
      i = j;
      if (op === 'q') saved.push(ctm);
      else if (op === 'Q') { if (saved.length) ctm = saved.pop(); }
      else if (op === 'cm' && ops.length >= 6) {
        const m = ops.slice(-6);
        if (m.every((v) => typeof v === 'number')) ctm = mul(m, ctm);
      } else if (op === 'Do' && ops.length && ops[ops.length - 1] && ops[ops.length - 1].name) {
        onDo(ops[ops.length - 1].name, ctm);
      } else if (op === 'BI') {                        // inline image: jump past its binary data
        const id = str.indexOf('ID', i);
        if (id < 0) break;
        const end = str.slice(id + 3).search(/\sEI(\s|$)/);
        i = end < 0 ? n : id + 3 + end + 3;
      }
      ops.length = 0;
    }
  }
  function mul(m, n) {
    return [
      m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
    ];
  }

  // Every image XObject drawn by the pages, with the lowest DPI it is shown at (= the largest size).
  function collectImages(doc) {
    const ctx = doc.context;
    const found = new Map();
    const latin1 = new TextDecoder('latin1');
    const visit = (contentStr, resources, ctm0, depth, seenForms) => {
      if (!(resources instanceof PDFLib.PDFDict)) return;
      const xobjs = resources.lookup(N_('XObject'));
      if (!(xobjs instanceof PDFLib.PDFDict)) return;
      walkContent(contentStr, (name, ctm) => {
        const ref = xobjs.get(N_(name));
        const obj = ref instanceof PDFLib.PDFRef ? ctx.lookup(ref) : ref;
        if (!(obj instanceof PDFLib.PDFRawStream)) return;
        const sub = obj.dict.get(N_('Subtype'));
        const m = mul(ctm, ctm0);
        if (sub === N_('Image') && ref instanceof PDFLib.PDFRef) {
          const W = num(obj.dict.get(N_('Width'))), H = num(obj.dict.get(N_('Height')));
          const wPt = Math.hypot(m[0], m[1]), hPt = Math.hypot(m[2], m[3]);
          if (!W || !H || wPt < 0.5 || hPt < 0.5) return;
          const dpi = Math.min(W / (wPt / 72), H / (hPt / 72));
          const e = found.get(ref.toString()) || { ref, stream: obj, W, H, dpi: Infinity };
          e.dpi = Math.min(e.dpi, dpi);
          found.set(ref.toString(), e);
        } else if (sub === N_('Form') && depth < 8 && !seenForms.has(ref)) {
          const fm = obj.dict.lookup(N_('Matrix'));
          const fmat = fm instanceof PDFLib.PDFArray && fm.size() === 6 ? fm.asArray().map((v) => num(v) ?? 0) : [1, 0, 0, 1, 0, 0];
          const res = obj.dict.lookup(N_('Resources')) || resources;
          let str = '';
          try { str = latin1.decode(decodedBytes(obj)); } catch { return; }
          visit(str, res, mul(fmat, m), depth + 1, new Set([...seenForms, ref]));
        }
      });
    };
    for (const page of doc.getPages()) {
      let res = page.node.lookup(N_('Resources'));
      const contents = page.node.lookup(N_('Contents'));
      const parts = contents instanceof PDFLib.PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents];
      let str = '';
      for (const part of parts) { try { str += latin1.decode(decodedBytes(part)) + '\n'; } catch { /* unreadable part */ } }
      visit(str, res, [1, 0, 0, 1, 0, 0], 0, new Set());
    }
    return [...found.values()];
  }

  // Colour space of an image → number of components, or null when we should leave the image alone.
  function colorInfo(doc, cs) {
    const ctx = doc.context;
    if (cs instanceof PDFLib.PDFRef) cs = ctx.lookup(cs);
    if (cs === N_('DeviceRGB') || cs === N_('CalRGB')) return { comps: 3 };
    if (cs === N_('DeviceGray') || cs === N_('CalGray')) return { comps: 1 };
    if (cs instanceof PDFLib.PDFArray && cs.size()) {
      const kind = cs.get(0);
      if (kind === N_('ICCBased')) {
        const icc = cs.lookup(1);
        const n = icc instanceof PDFLib.PDFRawStream ? num(icc.dict.get(N_('N'))) : null;
        return n === 3 || n === 1 ? { comps: n } : null;
      }
      if (kind === N_('CalRGB')) return { comps: 3 };
      if (kind === N_('CalGray')) return { comps: 1 };
      if (kind === N_('Indexed') && cs.size() >= 4) {
        const base = colorInfo(doc, cs.get(1));
        const hival = num(cs.lookup(2));
        let lut = cs.lookup(3);
        let bytes = null;
        if (lut instanceof PDFLib.PDFHexString || lut instanceof PDFLib.PDFString) bytes = lut.asBytes();
        else if (lut instanceof PDFLib.PDFRawStream) { try { bytes = decodedBytes(lut); } catch { bytes = null; } }
        if (!base || base.indexed || hival == null || !bytes) return null;
        return { comps: 1, indexed: { base: base.comps, hival, lut: bytes } };
      }
    }
    return null;   // CMYK, Lab, Separation, DeviceN, patterns: leave as they are
  }

  function unpredictPng(data, colors, bpc, columns) {
    const bpp = Math.max(1, (colors * bpc) >> 3);
    const rowLen = Math.ceil((colors * bpc * columns) / 8);
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    for (let r = 0; r < rows; r++) {
      const f = data[r * (rowLen + 1)];
      const src = r * (rowLen + 1) + 1, dst = r * rowLen, prev = dst - rowLen;
      for (let i = 0; i < rowLen; i++) {
        const x = data[src + i];
        const a = i >= bpp ? out[dst + i - bpp] : 0;
        const b = r ? out[prev + i] : 0;
        const c = r && i >= bpp ? out[prev + i - bpp] : 0;
        let v;
        if (f === 0) v = x;
        else if (f === 1) v = x + a;
        else if (f === 2) v = x + b;
        else if (f === 3) v = x + ((a + b) >> 1);
        else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
        out[dst + i] = v & 255;
      }
    }
    return out;
  }

  // Decode one image stream into something a canvas can draw. Returns null for kinds we skip.
  async function decodeImage(doc, stream) {
    const d = stream.dict;
    if (d.get(N_('ImageMask')) === PDFLib.PDFBool.True || d.has(N_('Mask')) || d.has(N_('Decode'))) return null;
    let filter = d.lookup(N_('Filter'));
    if (filter instanceof PDFLib.PDFArray) filter = filter.size() === 1 ? filter.get(0) : null;
    const bpc = num(d.get(N_('BitsPerComponent')));
    const W = num(d.get(N_('Width'))), H = num(d.get(N_('Height')));
    const ci = colorInfo(doc, d.lookup(N_('ColorSpace')));
    if (!W || !H || !ci) return null;
    if (filter === N_('DCTDecode')) {
      if (ci.indexed) return null;
      const bmp = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }));
      return { source: bmp, w: bmp.width, h: bmp.height, kind: 'photo' };
    }
    if (filter !== N_('FlateDecode') || bpc !== 8) return null;
    let raw = decodedBytes(stream);
    const parms = d.lookup(N_('DecodeParms'));
    const pred = parms instanceof PDFLib.PDFDict ? num(parms.get(N_('Predictor'))) || 1 : 1;
    if (pred >= 10) raw = unpredictPng(raw, ci.comps, 8, W);
    else if (pred !== 1) return null;
    const px = W * H;
    if (raw.length < px * ci.comps) return null;
    const rgba = new Uint8ClampedArray(px * 4);
    if (ci.indexed) {
      const { base, lut, hival } = ci.indexed;
      for (let i = 0; i < px; i++) {
        const k = Math.min(raw[i], hival) * base;
        if (base === 3) { rgba[i * 4] = lut[k]; rgba[i * 4 + 1] = lut[k + 1]; rgba[i * 4 + 2] = lut[k + 2]; }
        else rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = lut[k];
        rgba[i * 4 + 3] = 255;
      }
    } else if (ci.comps === 3) {
      for (let i = 0; i < px; i++) { rgba[i * 4] = raw[i * 3]; rgba[i * 4 + 1] = raw[i * 3 + 1]; rgba[i * 4 + 2] = raw[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
    } else {
      for (let i = 0; i < px; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = raw[i]; rgba[i * 4 + 3] = 255; }
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
    return { source: c, w: W, h: H, kind: 'flate' };
  }

  // Few distinct colours (logos, charts, screenshots of text) → keep lossless; otherwise JPEG.
  function looksGraphic(ctx2d, w, h) {
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
    const d = ctx2d.getImageData(0, 0, w, h).data;
    const seen = new Set();
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        if (seen.size > 256) return false;
      }
    }
    return true;
  }

  function jpegStream(doc, oldDict, bytes, w, h) {
    const dict = imageDict(doc, oldDict, { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
    return PDFLib.PDFRawStream.of(dict, bytes);
  }
  function pngStream(doc, oldDict, pngBytes) {
    const p = parsePng(pngBytes);
    if (!p || p.interlace || p.depth > 8 || ![0, 2, 3].includes(p.ctype)) return null;
    let cs;
    if (p.ctype === 0) cs = 'DeviceGray';
    else if (p.ctype === 2) cs = 'DeviceRGB';
    else {
      if (!p.plte) return null;
      let hex = '';
      for (let i = 0; i < p.plte.length; i++) hex += p.plte[i].toString(16).padStart(2, '0');
      cs = ['Indexed', 'DeviceRGB', p.plte.length / 3 - 1, PDFLib.PDFHexString.of(hex)];
    }
    const colors = p.ctype === 2 ? 3 : 1;
    const dict = imageDict(doc, oldDict, {
      Width: p.w, Height: p.h, ColorSpace: cs, BitsPerComponent: p.depth, Filter: 'FlateDecode',
      DecodeParms: { Predictor: 15, Colors: colors, BitsPerComponent: p.depth, Columns: p.w },
    });
    return PDFLib.PDFRawStream.of(dict, p.data);
  }
  // Carry over what still applies (soft mask, interpolation, rendering intent); drop the rest.
  function imageDict(doc, oldDict, fields) {
    const lit = { Type: 'XObject', Subtype: 'Image', ...fields };
    const dict = doc.context.obj(lit);
    for (const key of ['SMask', 'Interpolate', 'Intent', 'Name', 'OC', 'StructParent']) {
      const v = oldDict.get(N_(key));
      if (v !== undefined) dict.set(N_(key), v);
    }
    return dict;
  }
  function grayMaskStream(doc, oldDict, canvas) {
    const w = canvas.width, h = canvas.height;
    const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const data = encodeGrayLossless(rgba, w, h);
    const dict = doc.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode',
      DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: w },
    });
    for (const key of ['Matte']) { const v = oldDict.get(N_(key)); if (v !== undefined) dict.set(N_(key), v); }
    return PDFLib.PDFRawStream.of(dict, data);
  }

  // Prepare every resizable image once (decoded and pre-shrunk to the top rung), so each probe of the
  // ladder only has to resample and encode.
  async function prepareImages(doc, gray, job, progress) {
    const list = collectImages(doc).filter((e) => e.dpi > 60 && e.W * e.H > 40000);
    const ready = [];
    for (let k = 0; k < list.length; k++) {
      check(job);
      const e = list[k];
      progress(k / Math.max(1, list.length), `分析圖片 ${k + 1}／${list.length}`);
      let dec = null;
      try { dec = await decodeImage(doc, e.stream); } catch { dec = null; }
      if (!dec) continue;
      const f = Math.min(1, SMART_TOP / e.dpi);
      const tw = Math.max(1, Math.round(dec.w * f)), th = Math.max(1, Math.round(dec.h * f));
      const base = drawScaled(dec.source, dec.w, dec.h, tw, th);
      if (dec.source.close) dec.source.close(); else { dec.source.width = 0; dec.source.height = 0; }
      if (gray) toGray(base.getContext('2d'), tw, th);
      const graphic = dec.kind === 'flate' && looksGraphic(base.getContext('2d'), tw, th);
      const blob = await canvasToBlob(base, graphic ? 'image/png' : 'image/jpeg', 0.92);
      base.width = 0; base.height = 0;
      // soft mask (transparency): shrink it the same way and keep it lossless
      let mask = null;
      const smRef = e.stream.dict.get(N_('SMask'));
      const sm = smRef instanceof PDFLib.PDFRef ? doc.context.lookup(smRef) : null;
      if (sm instanceof PDFLib.PDFRawStream) {
        try {
          const md = await decodeImage(doc, sm);
          if (md) {
            const mw = Math.max(1, Math.round(md.w * f)), mh = Math.max(1, Math.round(md.h * f));
            mask = { ref: smRef, stream: sm, canvas: drawScaled(md.source, md.w, md.h, mw, mh), scale: mw / md.w };
            if (md.source.close) md.source.close(); else { md.source.width = 0; md.source.height = 0; }
          }
        } catch { mask = null; }
      }
      ready.push({ ...e, blob, tw, th, graphic, origBytes: e.stream.contents.length, mask });
      if (k % 4 === 3) await Core.nextFrame();
    }
    return ready;
  }

  // Encode every prepared image for one rung. Only keeps an image when the new version is smaller.
  async function encodeImagesAt(doc, prepared, rung, job, onImage) {
    const out = [];
    for (let k = 0; k < prepared.length; k++) {
      check(job);
      const e = prepared[k];
      // the cached copy is at min(original, top rung) DPI; scale it down to this rung
      const scale = Math.min(1, rung.dpi / Math.min(e.dpi, SMART_TOP));
      const w = Math.max(1, Math.round(e.tw * scale)), h = Math.max(1, Math.round(e.th * scale));
      const bmp = await createImageBitmap(e.blob);
      const c = drawScaled(bmp, bmp.width, bmp.height, w, h);
      if (bmp.close) bmp.close();
      let stream = null, size = Infinity;
      try {
        if (e.graphic) {
          const rgba = c.getContext('2d').getImageData(0, 0, w, h).data;
          const png = new Uint8Array(UPNG.encode([rgba.buffer], w, h, 0));
          stream = pngStream(doc, e.stream.dict, png);
        }
        if (!stream) {
          const blob = await canvasToBlob(c, 'image/jpeg', rung.q);
          stream = jpegStream(doc, e.stream.dict, new Uint8Array(await blob.arrayBuffer()), w, h);
        }
        size = stream.contents.length;
      } finally { c.width = 0; c.height = 0; }
      let maskStream = null, maskSize = 0;
      if (e.mask) {
        const mw = Math.max(1, Math.round(e.mask.canvas.width * scale)), mh = Math.max(1, Math.round(e.mask.canvas.height * scale));
        const mc = drawScaled(e.mask.canvas, e.mask.canvas.width, e.mask.canvas.height, mw, mh);
        maskStream = grayMaskStream(doc, e.mask.stream.dict, mc);
        mc.width = 0; mc.height = 0;
        maskSize = maskStream.contents.length;
      }
      const before = e.origBytes + (e.mask ? e.mask.stream.contents.length : 0);
      if (size + maskSize < before * 0.95) out.push({ e, stream, maskStream, saved: before - size - maskSize });
      onImage(k + 1);
    }
    return out;
  }

  function applyImages(doc, encoded) {
    for (const { e, stream, maskStream } of encoded) {
      doc.context.assign(e.ref, stream);
      if (maskStream && e.mask) doc.context.assign(e.mask.ref, maskStream);
    }
  }
  function restoreImages(doc, encoded) {
    for (const { e } of encoded) {
      doc.context.assign(e.ref, e.stream);
      if (e.mask) doc.context.assign(e.mask.ref, e.mask.stream);
    }
  }

  // Try to fit by shrinking images only. Returns a result, or null when even the lowest rung is too big.
  async function imageOnly(doc, baseBytes, targetBytes, gray, job, progress) {
    progress(0.02, '分析圖片…');
    const prepared = await prepareImages(doc, gray, job, (f, t) => progress(0.02 + 0.3 * f, t));
    if (!prepared.length) return null;
    const totalOrig = prepared.reduce((a, e) => a + e.origBytes + (e.mask ? e.mask.stream.contents.length : 0), 0);
    if (baseBytes - totalOrig + 2000 > targetBytes) return null;          // the non-image part alone is too big
    let probe = 0;
    const tryRung = async (idx) => {
      probe++;
      const r = SMART_LADDER[idx];
      const enc = await encodeImagesAt(doc, prepared, r, job, (k) =>
        progress(0.32 + 0.6 * Math.min(1, (probe - 1 + k / prepared.length) / 5), `壓縮圖片 ${r.dpi} DPI・品質 ${Math.round(r.q * 100)}`));
      const est = baseBytes - enc.reduce((a, x) => a + x.saved, 0);
      return { idx, enc, est };
    };
    // the lowest rung first: if that does not fit, stop right away and flatten pages instead
    const last = SMART_LADDER.length - 1;
    let best = await tryRung(last);
    if (best.est > targetBytes) return null;
    let lo = 0, hi = last - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = await tryRung(mid);
      if (r.est <= targetBytes) { best = r; hi = mid - 1; } else lo = mid + 1;
    }
    for (let idx = best.idx; ; idx++) {
      check(job);
      const r = idx === best.idx ? best : await tryRung(idx);
      applyImages(doc, r.enc);
      progress(0.95, '組合 PDF…');
      const bytes = await doc.save({ useObjectStreams: true });
      if (bytes.length <= targetBytes) {
        // make sure the rewritten file still opens before handing it out
        const test = await Core.openPdf(bytes.slice()).promise;
        test.destroy();
        return { bytes, setting: SMART_LADDER[idx], images: r.enc.length };
      }
      restoreImages(doc, r.enc);
      if (idx >= last) return null;
    }
  }

  // ---------- one output file ----------
  // out: { title, pages: [global page indexes] }   settings: { targetMB, mode, format, dpi, quality, colors, gray, keepOriginal }
  async function buildOutput(project, out, settings, job, progress) {
    const targetBytes = Math.floor(settings.targetMB * MB * SAFETY);
    const N = out.pages.length;
    Core.assetMisses.clear();
    const done = (r) => ({ ...r, over: r.size > settings.targetMB * MB, missing: [...Core.assetMisses] });

    // Stage 0: keep it as it is when that already fits.
    // Stage 1: shrink only the images (text and vector graphics untouched) and search for the best fit.
    // Stage 2: flatten every page to an image — always fits, text becomes part of the picture.
    // The pages as they are (the original file, or a lossless copy of the pages) are also the yardstick for
    // stage 2: a flattened file has to be smaller than them, or they are handed out instead.
    let rasterProgress = progress;
    const whole = project.sources.length === 1 && N === project.sources[0].numPages && out.pages.every((g, i) => g === i);
    const src0 = project.sources[0];
    let asIs = whole && !src0.password ? { blob: src0.file, size: src0.file.size, method: 'original' } : null;
    if (settings.keepOriginal && asIs && asIs.size <= targetBytes) {
      progress(1, '原檔就符合上限');
      return done(asIs);
    }
    if (settings.keepOriginal || !asIs) {
      try {
        progress(0.01, '整理頁面…');
        const base = await buildLossless(project, out.pages, out.title, job);
        const copy = { blob: new Blob([base.bytes], { type: 'application/pdf' }), size: base.bytes.length, method: 'lossless', linkCount: base.linkCount, unlocked: base.unlocked };
        if (!asIs || copy.size < asIs.size) asIs = copy;
        if (settings.keepOriginal) {
          if (copy.size <= targetBytes) {
            progress(1, '不用壓縮就符合');
            return done(copy);
          }
          // still too big: slim it without changing anything visible, and check again
          // (a failure here only skips the slimming: every change it makes is complete on its own)
          const slim = await slimDoc(base.doc, job, (f) => progress(0.01 + 0.07 * f, '無損瘦身…'))
            .catch((e) => { if (e instanceof Cancelled) throw e; console.warn('lossless slimming skipped', e); return false; });
          if (slim) {
            const bytes = await base.doc.save({ useObjectStreams: true });
            if (bytes.length < copy.size) {
              base.bytes = bytes;
              Object.assign(copy, { blob: new Blob([bytes], { type: 'application/pdf' }), size: bytes.length });
              if (copy.size < asIs.size) asIs = copy;
            }
            if (copy.size <= targetBytes) {
              progress(1, '無損瘦身就符合');
              return done(copy);
            }
          }
          if (settings.mode === 'auto') {
            const r = await imageOnly(base.doc, base.bytes.length, targetBytes, settings.gray, job, (f, t) => progress(0.08 + 0.37 * f, t));
            if (r) {
              progress(1, '完成');
              return done({ blob: new Blob([r.bytes], { type: 'application/pdf' }), size: r.bytes.length, method: 'smart', setting: r.setting, images: r.images, linkCount: base.linkCount, unlocked: base.unlocked });
            }
            rasterProgress = (f, t) => progress(0.45 + 0.55 * f, t);
            progress(0.45, '改用整頁轉圖片…');
          }
        }
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        console.warn('stage 0/1 unavailable, flattening pages', e);
      }
    }

    // 2. flatten and compress
    check(job);
    let images, setting;
    // Aim under the limit and at least 2% under the pages as they are. Whatever comes out, the version
    // within the limit wins, and when both or neither are, the smaller one.
    const goal = Math.min(targetBytes, asIs ? Math.floor(asIs.size * 0.98) : Infinity);
    const fits = (r) => r.size <= targetBytes;
    const finish = (flat) => done(asIs && (fits(asIs) !== fits(flat) ? fits(asIs) : asIs.size <= flat.size) ? { ...asIs, smaller: true } : flat);
    if (settings.mode === 'manual') {
      setting = settings.format === 'jpeg'
        ? { fmt: 'jpeg', dpi: settings.dpi, q: settings.quality / 100 }
        : { fmt: 'png', dpi: settings.dpi, colors: settings.colors };
      images = [];
      for (let k = 0; k < N; k++) {
        check(job);
        rasterProgress(0.03 + 0.9 * k / N, `轉成圖片 ${k + 1}／${N}`);
        const r = await renderPage(project, out.pages[k], setting.dpi, settings.gray, job);
        try { images.push(await encodeFrom(r.canvas, r.canvas.width, r.canvas.height, r.info, setting, settings.gray)); }
        finally { r.canvas.width = 0; r.canvas.height = 0; }
      }
      rasterProgress(0.95, '組合 PDF…');
      const a = await assembleFlat(project, out.pages, images, out.title, job);
      return finish({ blob: new Blob([a.bytes], { type: 'application/pdf' }), size: a.bytes.length, method: 'compressed', setting, linkCount: a.linkCount });
    }

    // Auto: render each page once at the top rung (cached across outputs and re-runs),
    // then binary-search the ladder by re-encoding the cached copies.
    const ladder = settings.format === 'png' ? PNG_LADDER : JPEG_LADDER;
    const cacheKey = settings.format + (settings.gray ? '|gray' : '');
    if (project.cache.key !== cacheKey) project.cache = { key: cacheKey, blobs: [] };
    const cacheType = settings.format === 'png' ? 'image/png' : 'image/jpeg';
    for (let k = 0; k < N; k++) {
      check(job);
      const g = out.pages[k];
      if (project.cache.blobs[g]) continue;
      rasterProgress(0.03 + 0.5 * k / N, `轉成圖片 ${k + 1}／${N}`);
      const r = await renderPage(project, g, ladder[0].dpi, settings.gray, job);
      try { project.cache.blobs[g] = await canvasToBlob(r.canvas, cacheType, 0.92); }
      finally { r.canvas.width = 0; r.canvas.height = 0; }
    }

    const maxProbes = Math.ceil(Math.log2(ladder.length + 1)) + 1;
    let probe = 0;
    const describe = (s) => s.fmt === 'jpeg' ? `${s.dpi} DPI・品質 ${Math.round(s.q * 100)}` : `${s.dpi} DPI・${s.colors ? s.colors + ' 色' : '無損'}`;
    const encodeAll = async (idx, limit) => {
      probe++;
      const s = ladder[idx];
      const base = 0.55 + 0.38 * Math.min(probe - 1, maxProbes - 1) / maxProbes;
      const span = 0.38 / maxProbes;
      const imgs = [];
      let sum = 0;
      for (let k = 0; k < N; k++) {
        check(job);
        const g = out.pages[k];
        const bmp = await createImageBitmap(project.cache.blobs[g]);
        let im;
        try { im = await encodeFrom(bmp, bmp.width, bmp.height, project.info[g], s, settings.gray); }
        finally { if (bmp.close) bmp.close(); }
        imgs.push(im);
        sum += im.size;
        rasterProgress(base + span * (k + 1) / N, `找最佳畫質 ${describe(s)}`);
        if (limit != null && sum + DOC_OVERHEAD + N * PAGE_OVERHEAD > limit) return null;
      }
      return imgs;
    };

    let lo = 0, hi = ladder.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const imgs = await encodeAll(mid, goal);
      if (imgs) { best = { idx: mid, imgs }; hi = mid - 1; } else lo = mid + 1;
    }
    // not even the lowest rung beats the pages as they are, and those fit: no need to assemble anything
    if (!best && asIs && fits(asIs)) return done({ ...asIs, smaller: true });
    let idx = best ? best.idx : ladder.length - 1;
    images = best ? best.imgs : await encodeAll(idx, null);
    for (;;) {
      rasterProgress(0.95, '組合 PDF…');
      let a = await assembleFlat(project, out.pages, images, out.title, job);
      if (a.bytes.length <= goal || idx >= ladder.length - 1) {
        setting = ladder[idx];
        // Below ~120 DPI, shrinking the cached copy makes thin strokes lighter than a direct render.
        // Re-render straight at the chosen resolution and keep that version if it still fits.
        if (setting.dpi < 120 && a.bytes.length <= goal) {
          const sharp = [];
          for (let k = 0; k < N; k++) {
            check(job);
            rasterProgress(0.95 + 0.04 * k / N, `讓小字更清楚 ${k + 1}／${N}`);
            const r = await renderPage(project, out.pages[k], setting.dpi, settings.gray, job);
            try { sharp.push(await encodeFrom(r.canvas, r.canvas.width, r.canvas.height, r.info, setting, settings.gray)); }
            finally { r.canvas.width = 0; r.canvas.height = 0; }
          }
          const alt = await assembleFlat(project, out.pages, sharp, out.title, job);
          if (alt.bytes.length <= goal) a = alt;
        }
        return finish({ blob: new Blob([a.bytes], { type: 'application/pdf' }), size: a.bytes.length, method: 'compressed', setting, linkCount: a.linkCount });
      }
      idx++;
      images = await encodeAll(idx, null);
    }
  }

  // ---------- ZIP (stored, no compression: PDFs are already compressed) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  async function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const name = enc.encode(f.name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(local.buffer, name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
      central.push(cd.buffer, name);
      offset += 30 + name.length + data.length;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.byteLength;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  window.Engine = { buildOutput, outlineTree, locate, makeZip, Cancelled, JPEG_LADDER, PNG_LADDER };
})();
