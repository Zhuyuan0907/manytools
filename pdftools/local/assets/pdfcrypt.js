/* Opens protected PDFs for pdf-lib, which can't decrypt them by itself. Most protected PDFs (transcripts,
   certificates, files from official systems) need no password to open and only restrict editing or printing;
   without this, the engine could not copy their pages and had to turn every page into a picture.
   Standard security handler only: RC4 40–128 bit and AES-128 (revisions 2–4), AES-256 (revisions 5–6).
   PdfCrypt.load(bytes, password) → a PDFDocument with every string and stream decrypted and no /Encrypt.
   Throws when the file uses something else (certificates, unknown crypt filters) or the password is wrong. */
(function () {
  'use strict';
  const N = (n) => PDFLib.PDFName.of(n);
  const PAD = new Uint8Array([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
  const SALT = new Uint8Array([0x73, 0x41, 0x6C, 0x54]);   // "sAlT"
  const EMPTY = new Uint8Array(0);

  const cat = (...parts) => {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

  // ---------- MD5 (RFC 1321) and RC4: small, and not in WebCrypto ----------
  const MD5_K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  function md5(data) {
    const len = data.length, blocks = ((len + 8) >>> 6) + 1, w = new Uint32Array(blocks * 16);
    for (let i = 0; i < len; i++) w[i >> 2] |= data[i] << ((i & 3) * 8);
    w[len >> 2] |= 0x80 << ((len & 3) * 8);
    w[blocks * 16 - 2] = (len * 8) >>> 0;
    w[blocks * 16 - 1] = Math.floor(len / 0x20000000);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < w.length; o += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        const s = MD5_S[(i >> 4) * 4 + (i & 3)];
        F = (F + A + MD5_K[i] + w[o + g]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16), dv = new DataView(out.buffer);
    [a0, b0, c0, d0].forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
    return out;
  }
  function rc4(key, data) {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 255; j = (j + s[i]) & 255;
      const t = s[i]; s[i] = s[j]; s[j] = t;
      out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
    }
    return out;
  }

  // ---------- AES-CBC and SHA-2 through WebCrypto ----------
  const subtle = () => {
    if (!globalThis.crypto || !crypto.subtle) throw new Error('unsupported');   // only on http:// with a LAN address
    return crypto.subtle;
  };
  const aesKey = (raw) => subtle().importKey('raw', raw, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const sha = async (bits, data) => new Uint8Array(await subtle().digest(`SHA-${bits}`, data));
  async function aesEncryptRaw(raw, iv, data) {   // data is whole blocks; WebCrypto's padding block is cut off
    const out = await subtle().encrypt({ name: 'AES-CBC', iv }, await aesKey(raw), data);
    return new Uint8Array(out, 0, data.length);
  }
  async function aesDecrypt(raw, iv, data, padded = true) {
    if (!data.length || data.length % 16) return EMPTY;
    const key = await aesKey(raw);
    if (padded) {
      try { return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, key, data)); }
      catch { /* broken padding: decrypt every block as it is */ }
    }
    // WebCrypto insists on padding: append the block that encrypting "nothing" after our last block yields
    const tail = await subtle().encrypt({ name: 'AES-CBC', iv: data.subarray(data.length - 16) }, key, EMPTY);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, key, cat(data, new Uint8Array(tail))));
  }

  // ---------- keys ----------
  const pad32 = (pw) => cat(pw.subarray(0, 32), PAD.subarray(0, Math.max(0, 32 - pw.length)));
  // revisions 2–4 (algorithm 2): the file key from a user password
  function keyR4(pw, E) {
    const p = new Uint8Array(4);
    new DataView(p.buffer).setInt32(0, E.P, true);
    let k = md5(cat(pad32(pw), E.O.subarray(0, 32), p, E.id, E.R >= 4 && !E.encryptMetadata ? new Uint8Array([255, 255, 255, 255]) : EMPTY));
    if (E.R >= 3) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, E.n));
    return k.slice(0, E.n);
  }
  function isUserKey(key, E) {   // algorithms 4 and 5
    if (E.R === 2) return same(rc4(key, PAD), E.U.subarray(0, 32));
    let x = rc4(key, md5(cat(PAD, E.id)));
    for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
    return same(x, E.U.subarray(0, 16));
  }
  function userFromOwner(pw, E) {   // algorithm 7: the padded user password, recovered with the owner password
    let k = md5(pad32(pw));
    if (E.R >= 3) for (let i = 0; i < 50; i++) k = md5(k);
    k = k.slice(0, E.n);
    let x = E.O.subarray(0, 32);
    if (E.R === 2) return rc4(k, x);
    for (let i = 19; i >= 0; i--) x = rc4(k.map((b) => b ^ i), x);
    return x;
  }
  // revisions 5–6 (algorithm 2.B)
  async function hashR6(pw, salt, udata, R) {
    let K = await sha(256, cat(pw, salt, udata));
    if (R === 5) return K;
    for (let round = 0; ; round++) {
      const one = cat(pw, K, udata), K1 = new Uint8Array(one.length * 64);
      for (let i = 0; i < 64; i++) K1.set(one, i * one.length);
      const E = await aesEncryptRaw(K.subarray(0, 16), K.subarray(16, 32), K1);
      let mod = 0;
      for (let i = 0; i < 16; i++) mod += E[i];
      K = await sha([256, 384, 512][mod % 3], E);
      if (round >= 63 && E[E.length - 1] <= round - 31) break;
    }
    return K.subarray(0, 32);
  }
  async function keyR6(pw, E) {
    const zero = new Uint8Array(16);
    if (same(await hashR6(pw, E.U.subarray(32, 40), EMPTY, E.R), E.U.subarray(0, 32))) {
      return aesDecrypt(await hashR6(pw, E.U.subarray(40, 48), EMPTY, E.R), zero, E.UE.subarray(0, 32), false);
    }
    const u = E.U.subarray(0, 48);
    if (same(await hashR6(pw, E.O.subarray(32, 40), u, E.R), E.O.subarray(0, 32))) {
      return aesDecrypt(await hashR6(pw, E.O.subarray(40, 48), u, E.R), zero, E.OE.subarray(0, 32), false);
    }
    return null;
  }

  // ---------- reading the encryption dictionary straight from the bytes ----------
  // pdf-lib needs the key while it parses (object streams are encrypted as a whole), so the dictionary and
  // the file ID are found first. The encryption dictionary is never inside an object stream.
  function readEncryption(bytes) {
    const s = new TextDecoder('latin1').decode(bytes);
    const parseAt = (pos) => PDFLib.PDFObjectParser.forBytes(bytes.subarray(pos), PDFLib.PDFContext.create()).parseObject();
    const lastMatch = (re) => { let m, last = null; while ((m = re.exec(s))) last = m; return last; };
    let dict;
    const ref = lastMatch(/\/Encrypt\s*(\d+)\s+(\d+)\s+R/g);
    if (ref) {
      const obj = lastMatch(new RegExp(`(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj`, 'g'));
      if (!obj) return null;
      dict = parseAt(obj.index + obj[0].length);
    } else {
      const direct = lastMatch(/\/Encrypt\s*<</g);
      if (!direct) return null;
      dict = parseAt(direct.index + direct[0].length - 2);
    }
    if (!(dict instanceof PDFLib.PDFDict)) return null;
    const idm = lastMatch(/\/ID\s*\[/g);
    let id = EMPTY;
    if (idm) {
      const arr = parseAt(idm.index + idm[0].length - 1);
      const first = arr instanceof PDFLib.PDFArray && arr.size() ? arr.get(0) : null;
      if (first && first.asBytes) id = first.asBytes();
    }
    return { dict, id, ref: ref ? PDFLib.PDFRef.of(+ref[1], +ref[2]) : null };
  }

  async function setup(info, password) {
    const d = info.dict;
    const num = (k) => { const v = d.get(N(k)); return v instanceof PDFLib.PDFNumber ? v.asNumber() : undefined; };
    const bytesOf = (k) => { const v = d.get(N(k)); return v && v.asBytes ? v.asBytes() : EMPTY; };
    if (d.get(N('Filter')) !== N('Standard')) throw new Error('unsupported');
    const V = num('V') || 0, R = num('R') || 2;
    const E = { V, R, O: bytesOf('O'), U: bytesOf('U'), OE: bytesOf('OE'), UE: bytesOf('UE'), P: num('P') | 0, id: info.id,
      encryptMetadata: d.get(N('EncryptMetadata')) !== PDFLib.PDFBool.False };
    E.n = V === 1 ? 5 : V === 2 ? Math.min(16, (num('Length') || 40) >> 3) : V >= 5 ? 32 : 16;
    const method = (name) => {
      if (V < 4) return 'rc4';
      if (!name || name === N('Identity')) return 'none';
      const cf = d.lookup(N('CF')), f = cf instanceof PDFLib.PDFDict ? cf.lookup(name) : null;
      const m = f instanceof PDFLib.PDFDict ? f.get(N('CFM')) : null;
      if (m === N('AESV2')) return 'aes';
      if (m === N('AESV3')) return 'aes256';
      if (m === N('V2')) return 'rc4';
      if (m === N('None')) return 'none';
      throw new Error('unsupported');
    };
    E.stm = method(d.get(N('StmF')));
    E.str = method(d.get(N('StrF')));
    // most protected files open with the empty password; the one the person typed comes first
    for (const pw of [...new Set([password || '', ''])]) {
      if (R >= 5) {
        const key = await keyR6(new TextEncoder().encode(pw.normalize('NFKC')).subarray(0, 127), E);
        if (key) { E.key = key; return E; }
      } else {
        const raw = Uint8Array.from(pw, (c) => c.charCodeAt(0) & 255);
        let key = keyR4(raw, E);
        if (isUserKey(key, E)) { E.key = key; return E; }
        key = keyR4(userFromOwner(raw, E), E);
        if (isUserKey(key, E)) { E.key = key; return E; }
      }
    }
    throw Object.assign(new Error('password'), { code: 'password' });
  }

  function decryptBytes(E, ref, data, method) {
    if (method === 'none') return data;
    const n = ref.objectNumber, g = ref.generationNumber;
    const objKey = (aes) => md5(cat(E.key, new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255]), aes ? SALT : EMPTY))
      .subarray(0, Math.min(E.key.length + 5, 16));
    if (method === 'rc4') return rc4(objKey(false), data);
    if (data.length <= 16) return EMPTY;
    return aesDecrypt(method === 'aes256' ? E.key : objKey(true), data.subarray(0, 16), data.subarray(16));
  }

  // ---------- hooks into pdf-lib's parser, active only while one of our loads runs ----------
  let active = null;
  {
    const P = PDFLib.PDFParser.prototype, header = P.parseIndirectObjectHeader;
    P.parseIndirectObjectHeader = function () {
      const ref = header.call(this);
      if (active) active.lastRef = ref;
      return ref;
    };
    const OSP = PDFLib.PDFObjectStreamParser, forStream = OSP.forStream;
    OSP.forStream = function (raw, wait) {
      const job = active;
      if (!job) return forStream.call(OSP, raw, wait);
      const ref = job.lastRef;
      return {
        async parseIntoContext() {
          const stream = PDFLib.PDFRawStream.of(raw.dict, await decryptBytes(job.E, ref, raw.contents, job.E.stm));
          // objects inside an object stream are not encrypted on their own: remember which they are
          try {
            const first = raw.dict.get(N('First')).asNumber(), count = raw.dict.get(N('N')).asNumber();
            const head = new TextDecoder('latin1').decode(PDFLib.decodePDFRawStream(stream).decode().subarray(0, first)).trim().split(/\s+/);
            for (let i = 0; i < count * 2; i += 2) job.inStreams.add(+head[i]);
          } catch { /* the parser below will complain if the stream is broken */ }
          return forStream.call(OSP, stream, wait).parseIntoContext();
        },
      };
    };
  }

  async function decryptAll(doc, E, encRef, inStreams) {
    const ctx = doc.context;
    const text = async (v, ref) => PDFLib.PDFHexString.of(hex(await decryptBytes(E, ref, v.asBytes(), E.str)));
    const isText = (v) => v instanceof PDFLib.PDFString || v instanceof PDFLib.PDFHexString;
    const walk = async (o, ref) => {
      if (o instanceof PDFLib.PDFDict) {
        const sig = o.get(N('Type')) === N('Sig') || o.has(N('ByteRange'));   // signature values are never encrypted
        for (const [k, v] of o.entries()) {
          if (sig && k === N('Contents')) continue;
          if (isText(v)) o.set(k, await text(v, ref));
          else await walk(v, ref);
        }
      } else if (o instanceof PDFLib.PDFArray) {
        for (let i = 0; i < o.size(); i++) {
          const v = o.get(i);
          if (isText(v)) o.set(i, await text(v, ref));
          else await walk(v, ref);
        }
      }
    };
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (ref === encRef || inStreams.has(ref.objectNumber)) continue;
      if (obj instanceof PDFLib.PDFRawStream) {
        const type = obj.dict.get(N('Type'));
        if (type === N('XRef')) continue;
        await walk(obj.dict, ref);
        if (type === N('Metadata') && !E.encryptMetadata) continue;
        const f = obj.dict.lookup(N('Filter'));
        if (f === N('Crypt') || (f instanceof PDFLib.PDFArray && f.asArray().includes(N('Crypt')))) continue;   // its own (identity) filter
        ctx.assign(ref, PDFLib.PDFRawStream.of(obj.dict, await decryptBytes(E, ref, obj.contents, E.stm)));
      } else if (isText(obj)) ctx.assign(ref, await text(obj, ref));
      else await walk(obj, ref);
    }
    if (encRef) ctx.delete(encRef);
    ctx.trailerInfo.Encrypt = undefined;
  }

  let queue = Promise.resolve();   // one load at a time: the parser hooks share `active`
  function load(bytes, password) {
    const run = queue.then(async () => {
      try {
        return await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
      } catch (err) {
        const info = readEncryption(bytes);
        if (!info) throw err;
        const E = await setup(info, password);
        const job = { E, lastRef: null, inStreams: new Set() };
        active = job;
        let doc;
        try { doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); }
        finally { active = null; }
        await decryptAll(doc, E, info.ref, job.inStreams);
        doc.wasEncrypted = true;
        return doc;
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  window.PdfCrypt = { load, md5, rc4 };
})();
