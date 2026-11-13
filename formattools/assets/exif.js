/* ZhuyuanLoveFormat's photo information: a picture's EXIF block as it is (the TIFF-shaped bytes) from a JPEG, a HEIC /
   HEIF / AVIF, a PNG or a WebP; made right for the converted picture (upright, its new size, the old thumbnail gone, the
   place taken out when asked); and put into the new JPEG. Also whether a HEIC's colours are Display P3 (an iPhone's),
   which its decoder needs to know. Only the bytes needed are read.
   ZExif.read(file) → Promise<{ tiff: Uint8Array | null, p3: boolean }>
   ZExif.fit(tiff, { w, h, gps }) → Uint8Array (a copy; gps false: the place taken out)
   ZExif.intoJpeg(blob, tiff) → Promise<Blob | null>   (null: too big for a JPEG's EXIF segment) */
(() => {
  'use strict';
  const bytes = async (file, a, b) => new Uint8Array(await file.slice(a, Math.min(b, file.size)).arrayBuffer());
  const latin = (u, a, n) => { let s = ''; for (let i = 0; i < n && a + i < u.length; i++) s += String.fromCharCode(u[a + i]); return s; };
  const be16 = (u, p) => (u[p] << 8) | u[p + 1];
  const be32 = (u, p) => ((u[p] << 24) >>> 0) + (u[p + 1] << 16) + (u[p + 2] << 8) + u[p + 3];
  const beN = (u, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u[p + i]; return v; };
  const isTiff = (u, p = 0) => u.length >= p + 8 && ((u[p] === 0x49 && u[p + 1] === 0x49 && u[p + 2] === 42) || (u[p] === 0x4d && u[p + 1] === 0x4d && u[p + 3] === 42));
  // (some writers put "Exif\0\0" before the TIFF header)
  const tiffAt = (u) => (isTiff(u) ? u : u.length > 6 && latin(u, 0, 4) === 'Exif' && isTiff(u, 6) ? u.subarray(6) : null);

  // ---------- JPEG: the APP1 "Exif" segment ----------
  async function jpeg(file) {
    let p = 2;
    while (p + 4 <= file.size) {
      const h = await bytes(file, p, p + 4);
      if (h[0] !== 0xff) return null;
      const m = h[1], len = be16(h, 2);
      if (m === 0xda || m === 0xd9) return null;   // the picture itself: no EXIF before it
      if (m === 0xe1 && len > 8) {
        const seg = await bytes(file, p + 4, p + 2 + len);
        if (latin(seg, 0, 4) === 'Exif') return tiffAt(seg);
      }
      p += 2 + len;
    }
    return null;
  }

  // ---------- HEIC / HEIF / AVIF: the 'Exif' item, and the colours ----------
  // children of a box: [type, start of its contents, end]
  function boxes(u, a, b) {
    const out = [];
    while (a + 8 <= b) {
      let size = be32(u, a), head = 8;
      const type = latin(u, a + 4, 4);
      if (size === 1) { size = beN(u, a + 8, 8); head = 16; } else if (size === 0) size = b - a;
      if (size < head || a + size > b) break;
      out.push([type, a + head, a + size]);
      a += size;
    }
    return out;
  }
  // an ICC profile's name (its 'desc' tag: plain text, or UTF-16 in a 'mluc')
  function iccName(u) {
    if (u.length < 132) return '';
    const n = be32(u, 128);
    for (let i = 0; i < n && 132 + i * 12 + 12 <= u.length; i++) {
      const e = 132 + i * 12;
      if (latin(u, e, 4) !== 'desc') continue;
      const o = be32(u, e + 4), t = latin(u, o, 4);
      if (t === 'desc') return latin(u, o + 12, Math.min(be32(u, o + 8), 200)).replace(/\0.*$/, '');
      if (t === 'mluc' && be32(u, o + 8) > 0) {
        const len = be32(u, o + 20), at = o + be32(u, o + 24);
        let s = '';
        for (let k = 0; k + 1 < len && k < 400; k += 2) s += String.fromCharCode(be16(u, at + k));
        return s;
      }
    }
    return '';
  }
  async function heif(file) {
    // the 'meta' box, near the start
    let p = 0, meta = null;
    while (p + 16 <= file.size && p < 8e6) {
      const h = await bytes(file, p, p + 16);
      let size = be32(h, 0);
      const type = latin(h, 4, 4);
      if (size === 1) size = beN(h, 8, 8); else if (size === 0) size = file.size - p;
      if (size < 8) break;
      if (type === 'meta') { meta = await bytes(file, p, p + size); break; }
      p += size;
    }
    if (!meta) return { tiff: null, p3: false };
    const top = boxes(meta, 12, meta.length);   // (meta is a full box: 4 bytes of version and flags first)
    const get = (t) => top.find((x) => x[0] === t);
    // the colours: Display P3 marked as primaries 12 (nclx) or by its profile's name
    let p3 = false;
    const iprp = get('iprp'), ipco = iprp && boxes(meta, iprp[1], iprp[2]).find((x) => x[0] === 'ipco');
    if (ipco) for (const [t, a, b] of boxes(meta, ipco[1], ipco[2])) {
      if (t !== 'colr') continue;
      const kind = latin(meta, a, 4);
      if (kind === 'nclx' && be16(meta, a + 4) === 12) p3 = true;
      if ((kind === 'prof' || kind === 'rICC') && /P3/i.test(iccName(meta.subarray(a + 4, b)))) p3 = true;
    }
    // which item is the EXIF
    const iinf = get('iinf');
    let exifId = null;
    if (iinf) {
      const v = meta[iinf[1]], first = iinf[1] + 4 + (v === 0 ? 2 : 4);
      for (const [t, a] of boxes(meta, first, iinf[2])) {
        if (t !== 'infe') continue;
        const iv = meta[a];
        if (iv < 2) continue;
        const id = iv === 2 ? be16(meta, a + 4) : be32(meta, a + 4), q = a + 4 + (iv === 2 ? 2 : 4) + 2;
        if (latin(meta, q, 4) === 'Exif') { exifId = id; break; }
      }
    }
    const iloc = get('iloc');
    if (exifId == null || !iloc) return { tiff: null, p3 };
    // where it is: its extents, in the file or in the meta box's own data ('idat')
    let q = iloc[1];
    const v = meta[q]; q += 4;
    const offSize = meta[q] >> 4, lenSize = meta[q] & 15, baseSize = meta[q + 1] >> 4, idxSize = v > 0 ? meta[q + 1] & 15 : 0;
    q += 2;
    const count = v < 2 ? be16(meta, q) : be32(meta, q);
    q += v < 2 ? 2 : 4;
    for (let i = 0; i < count; i++) {
      const id = v < 2 ? be16(meta, q) : be32(meta, q);
      q += v < 2 ? 2 : 4;
      const method = v > 0 ? be16(meta, q) & 15 : 0;
      if (v > 0) q += 2;
      q += 2;   // data_reference_index
      const base = beN(meta, q, baseSize); q += baseSize;
      const n = be16(meta, q); q += 2;
      const ext = [];
      for (let k = 0; k < n; k++) {
        q += idxSize;
        const off = beN(meta, q, offSize); q += offSize;
        const len = beN(meta, q, lenSize); q += lenSize;
        ext.push([base + off, len]);
      }
      if (id !== exifId) continue;
      const idat = get('idat'), parts = [];
      for (const [off, len] of ext) {
        if (method === 1 && idat) parts.push(meta.subarray(idat[1] + off, idat[1] + off + len));
        else if (method === 0) parts.push(await bytes(file, off, off + (len || file.size - off)));
      }
      const all = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
      let at = 0;
      for (const x of parts) { all.set(x, at); at += x.length; }
      // (the item starts with where its TIFF header is)
      if (all.length < 4) return { tiff: null, p3 };
      const skip = be32(all, 0);
      return { tiff: tiffAt(all.subarray(4 + skip)) || tiffAt(all.subarray(4)), p3 };
    }
    return { tiff: null, p3 };
  }

  // ---------- PNG ('eXIf') and WebP ('EXIF') ----------
  async function png(file) {
    let p = 8;
    while (p + 12 <= file.size) {
      const h = await bytes(file, p, p + 8), len = be32(h, 0), type = latin(h, 4, 4);
      if (type === 'eXIf') return tiffAt(await bytes(file, p + 8, p + 8 + len));
      if (type === 'IDAT' || type === 'IEND') return null;
      p += 12 + len;
    }
    return null;
  }
  async function webp(file) {
    let p = 12;
    while (p + 8 <= file.size) {
      const h = await bytes(file, p, p + 8), type = latin(h, 0, 4), len = h[4] | (h[5] << 8) | (h[6] << 16) | (h[7] << 24);
      if (type === 'EXIF') return tiffAt(await bytes(file, p + 8, p + 8 + len));
      p += 8 + len + (len & 1);
    }
    return null;
  }

  async function read(file) {
    try {
      const h = await bytes(file, 0, 16);
      if (h[0] === 0xff && h[1] === 0xd8) return { tiff: await jpeg(file), p3: false };
      if (latin(h, 4, 4) === 'ftyp') return await heif(file);
      if (h[0] === 0x89 && latin(h, 1, 3) === 'PNG') return { tiff: await png(file), p3: false };
      if (latin(h, 0, 4) === 'RIFF' && latin(h, 8, 4) === 'WEBP') return { tiff: await webp(file), p3: false };
    } catch {}
    return { tiff: null, p3: false };
  }

  // ---------- made right for the new picture ----------
  const SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];   // bytes per value, by TIFF type
  function fit(tiff, o) {
    const t = tiff.slice(), le = t[0] === 0x49, dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const u16 = (p) => dv.getUint16(p, le), u32 = (p) => dv.getUint32(p, le);
    const inside = (p, n) => p >= 8 && p + n <= t.length;
    const ifd0 = u32(4);
    if (!inside(ifd0, 2)) return t;
    let n = u16(ifd0);
    if (!inside(ifd0, 2 + n * 12 + 4)) return t;
    const setNum = (e, v) => { if (u16(e + 2) === 3) dv.setUint16(e + 8, v, le); else if (u16(e + 2) === 4) dv.setUint32(e + 8, v, le); };
    for (let i = 0; i < n; i++) {
      const e = ifd0 + 2 + i * 12, tag = u16(e);
      if (tag === 0x0112) setNum(e, 1);   // upright: the pixels were turned already
      if (tag === 0x8769) {   // the Exif directory: the picture's size
        const x = u32(e + 8);
        if (!inside(x, 2)) continue;
        const m = u16(x);
        for (let j = 0; j < m && inside(x + 2 + j * 12, 12); j++) {
          const f = x + 2 + j * 12, ft = u16(f);
          if (ft === 0xa002 && o.w) setNum(f, o.w);
          if (ft === 0xa003 && o.h) setNum(f, o.h);
        }
      }
    }
    // the old thumbnail (IFD1) goes: it's the old picture, maybe the other way up
    dv.setUint32(ifd0 + 2 + n * 12, 0, le);
    if (o.gps === false) {
      for (let i = 0; i < n; i++) {
        const e = ifd0 + 2 + i * 12;
        if (u16(e) !== 0x8825) continue;
        // the GPS directory and every value it points to, blanked…
        const g = u32(e + 8);
        if (inside(g, 2)) {
          const m = u16(g);
          for (let j = 0; j < m && inside(g + 2 + j * 12, 12); j++) {
            const f = g + 2 + j * 12, size = (SIZES[u16(f + 2)] || 1) * u32(f + 4);
            if (size > 4 && inside(u32(f + 8), size)) t.fill(0, u32(f + 8), u32(f + 8) + size);
          }
          t.fill(0, g, Math.min(t.length, g + 2 + m * 12 + 4));
        }
        // …and the entry that pointed to it taken out of IFD0
        const end = ifd0 + 2 + n * 12 + 4;
        t.copyWithin(e, e + 12, end);
        n--;
        dv.setUint16(ifd0, n, le);
        t.fill(0, end - 12, end);
        break;
      }
    }
    return t;
  }

  // ---------- into the JPEG: an APP1 segment after the JFIF one (where cameras and editors put it) ----------
  async function intoJpeg(blob, tiff) {
    const len = 2 + 6 + tiff.length;
    if (len > 0xffff) return null;
    const u = new Uint8Array(await blob.arrayBuffer());
    if (u[0] !== 0xff || u[1] !== 0xd8) return null;
    let at = 2;
    if (u[2] === 0xff && u[3] === 0xe0) at = 4 + be16(u, 4);
    const seg = new Uint8Array(len + 2);
    seg.set([0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    seg.set(tiff, 10);
    return new Blob([u.subarray(0, at), seg, u.subarray(at)], { type: 'image/jpeg' });
  }

  window.ZExif = { read, fit, intoJpeg };
})();
