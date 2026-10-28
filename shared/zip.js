/* A minimal ZIP writer: stored entries (no compression — meant for files that are already compressed, like
   images), UTF-8 names. ManyZip.make([{ name, data: Uint8Array }]) → Blob. Used by the avatar and image tools.
   ManyZip.files([{ name, file: File|Blob }], onProgress?) → Promise<Blob>: the same for files of any size and number
   (ZIP64 past 4 GB or 65,535 files). Each file is read once, a piece at a time, for its checksum; the Blob only
   points at the files, so nothing big is held in memory and the browser streams it from disk when it saves.
   onProgress(bytesDone, bytesAll). Used by the rename tool.
   An entry can also be { name, raw: { data: Blob, method, crc, size }, lastModified }: a file taken as it is out of
   another ZIP (its packed bytes, packing method and checksum), so nothing is unpacked or read twice (the pick tool). */
(() => {
  'use strict';
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
      local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(local.buffer, name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + size;
    }
    const centralSize = central.reduce((a, x) => a + (x.byteLength || x.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  // CRC-32, eight bytes a step (the byte-at-a-time loop above is fine for small files, too slow for gigabytes)
  const T8 = (() => {
    const t = new Uint32Array(256 * 8);
    t.set(CRC);
    for (let i = 0; i < 256; i++) for (let k = 1; k < 8; k++) { const c = t[(k - 1) * 256 + i]; t[k * 256 + i] = CRC[c & 255] ^ (c >>> 8); }
    return t;
  })();
  function crcMore(c, u8) {
    let i = 0;
    const n = u8.length, end8 = n - (n % 8);
    for (; i < end8; i += 8) {
      const a = (c ^ (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24))) >>> 0;
      c = T8[1792 + (a & 255)] ^ T8[1536 + ((a >>> 8) & 255)] ^ T8[1280 + ((a >>> 16) & 255)] ^ T8[1024 + (a >>> 24)]
        ^ T8[768 + u8[i + 4]] ^ T8[512 + u8[i + 5]] ^ T8[256 + u8[i + 6]] ^ T8[u8[i + 7]];
    }
    for (; i < n; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return c >>> 0;
  }
  async function crcOf(file, tick) {
    let c = 0xffffffff;
    const r = file.stream().getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      c = crcMore(c, value);
      tick(value.length);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  const BIG = 0xffffffff;
  const u64 = (dv, at, v) => { dv.setUint32(at, v % 4294967296, true); dv.setUint32(at + 4, Math.floor(v / 4294967296), true); };
  async function zipFiles(list, onProgress) {
    const enc = new TextEncoder(), parts = [], central = [];
    const all = list.reduce((a, x) => a + (x.raw ? x.raw.data.size : x.file.size), 0);
    let done = 0, offset = 0, last = 0;
    const tick = (n) => { done += n; const now = Date.now(); if (onProgress && now - last > 120) { last = now; onProgress(done, all); } };
    for (const f of list) {
      const raw = f.raw, data = raw ? raw.data : f.file, name = enc.encode(f.name);
      const size = raw ? raw.size : f.file.size, csize = data.size, method = raw ? raw.method : 0;
      const crc = raw ? (tick(csize), raw.crc) : await crcOf(f.file, tick);
      const t = new Date(f.lastModified || (f.file && f.file.lastModified) || Date.now());
      const dosTime = (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1);
      const dosDate = ((Math.max(1980, t.getFullYear()) - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate();
      const big = size >= BIG || csize >= BIG, far = offset >= BIG;
      const local = new DataView(new ArrayBuffer(30 + (big ? 20 : 0)));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, big ? 45 : 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, method, true);
      local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
      local.setUint32(18, big ? BIG : csize, true); local.setUint32(22, big ? BIG : size, true); local.setUint16(26, name.length, true);
      if (big) { local.setUint16(28, 20, true); local.setUint16(30, 1, true); local.setUint16(32, 16, true); u64(local, 34, size); u64(local, 42, csize); }
      parts.push(new Uint8Array(local.buffer, 0, 30), name, big ? new Uint8Array(local.buffer, 30, 20) : null, data);
      // the central entry: ZIP64 fields only for what doesn't fit in 32 bits
      const extra = (big ? 16 : 0) + (far ? 8 : 0);
      const c = new DataView(new ArrayBuffer(46 + (extra ? 4 + extra : 0)));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 45, true); c.setUint16(6, big || far ? 45 : 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, method, true);
      c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
      c.setUint32(20, big ? BIG : csize, true); c.setUint32(24, big ? BIG : size, true); c.setUint16(28, name.length, true);
      c.setUint16(30, extra ? 4 + extra : 0, true); c.setUint32(42, far ? BIG : offset, true);
      if (extra) {
        let q = 50;
        c.setUint16(46, 1, true); c.setUint16(48, extra, true);
        if (big) { u64(c, q, size); u64(c, q + 8, csize); q += 16; }
        if (far) u64(c, q, offset);
      }
      central.push(new Uint8Array(c.buffer, 0, 46), name, extra ? new Uint8Array(c.buffer, 46) : null);
      offset += 30 + name.length + (big ? 20 : 0) + csize;
    }
    const cdSize = central.reduce((a, x) => a + (x ? x.length : 0), 0), n = list.length;
    const z64 = n >= 0xffff || offset >= BIG || cdSize >= BIG;
    const tail = [];
    if (z64) {
      const r = new DataView(new ArrayBuffer(56 + 20));
      r.setUint32(0, 0x06064b50, true); u64(r, 4, 44); r.setUint16(12, 45, true); r.setUint16(14, 45, true);
      u64(r, 24, n); u64(r, 32, n); u64(r, 40, cdSize); u64(r, 48, offset);
      r.setUint32(56, 0x07064b50, true); u64(r, 64, offset + cdSize); r.setUint32(72, 1, true);
      tail.push(r.buffer);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, Math.min(n, 0xffff), true); end.setUint16(10, Math.min(n, 0xffff), true);
    end.setUint32(12, Math.min(cdSize, BIG), true); end.setUint32(16, Math.min(offset, BIG), true);
    tail.push(end.buffer);
    if (onProgress) onProgress(all, all);
    return new Blob([...parts, ...central, ...tail].filter(Boolean), { type: 'application/zip' });
  }
  window.ManyZip = { make: makeZip, files: zipFiles };
})();
