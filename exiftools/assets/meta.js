/* ZhuyuanLoveExif's own metadata reader, in plain JavaScript: EXIF (IFD0, Exif, GPS, Apple's maker notes), XMP
   (Lightroom's crs settings and the rest), the colour profile's name, in JPEG, HEIC / AVIF, CR3, RAF and the
   TIFF-shaped RAW files (DNG, NEF, ARW, CR2, ORF, RW2, PEF…), and Lightroom .xmp files.
   Why: Safari runs ExifTool's Perl (WebAssembly) 10–50 times slower and with over a gigabyte of memory, and an
   iPhone closes the page. This reads only the bytes it needs, in milliseconds. It doesn't know the makers' own
   notes (shutter count and such) — ExifTool does, where it runs well.
   Output is ExifTool's shape (-G1 -l): { 'Group:Tag': { desc, val, num } }, so the page treats both alike.
   ZMeta.read(file) → Promise<{ tags, type } | null>    (null: not a format this knows) */
(() => {
  'use strict';
  const bytes = async (file, a, b) => new Uint8Array(await file.slice(a, Math.min(b, file.size)).arrayBuffer());
  const latin = (u, a, n) => { let s = ''; for (let i = 0; i < n && a + i < u.length; i++) s += String.fromCharCode(u[a + i]); return s; };
  const utf8 = new TextDecoder('utf-8');
  const words = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const trimNum = (x, d) => String(+(+x).toFixed(d));
  const N0 = (v) => (Number.isFinite(+v) ? +v : 0);

  function Out() {
    const t = {};
    return {
      t,
      set(g, name, val, num, desc) {
        if (val === undefined || val === null || val === '') return;
        const e = { desc: desc || words(name), val };
        if (num !== undefined && num !== null && String(num) !== String(val)) e.num = num;
        t[`${g}:${name}`] = e;
      },
      get(g, name) { const e = t[`${g}:${name}`]; return e ? (e.num !== undefined ? e.num : e.val) : undefined; },
      has(g, name) { return `${g}:${name}` in t; },
    };
  }

  // ---------- TIFF / EXIF ----------
  const pick = (table) => (v) => [table[v] !== undefined ? table[v] : `Unknown (${v})`, v];
  const ORIENT = { 1: 'Horizontal (normal)', 2: 'Mirror horizontal', 3: 'Rotate 180', 4: 'Mirror vertical', 5: 'Mirror horizontal and rotate 270 CW', 6: 'Rotate 90 CW', 7: 'Mirror horizontal and rotate 90 CW', 8: 'Rotate 270 CW' };
  const FLASH = {
    0x0: 'No Flash', 0x1: 'Fired', 0x5: 'Fired, Return not detected', 0x7: 'Fired, Return detected', 0x8: 'On, Did not fire', 0x9: 'On, Fired',
    0xd: 'On, Return not detected', 0xf: 'On, Return detected', 0x10: 'Off, Did not fire', 0x14: 'Off, Did not fire, Return not detected',
    0x18: 'Auto, Did not fire', 0x19: 'Auto, Fired', 0x1d: 'Auto, Fired, Return not detected', 0x1f: 'Auto, Fired, Return detected',
    0x20: 'No flash function', 0x30: 'Off, No flash function', 0x41: 'Fired, Red-eye reduction', 0x45: 'Fired, Red-eye reduction, Return not detected',
    0x47: 'Fired, Red-eye reduction, Return detected', 0x49: 'On, Red-eye reduction', 0x4d: 'On, Red-eye reduction, Return not detected',
    0x4f: 'On, Red-eye reduction, Return detected', 0x50: 'Off, Red-eye reduction', 0x58: 'Auto, Did not fire, Red-eye reduction',
    0x59: 'Auto, Fired, Red-eye reduction', 0x5d: 'Auto, Fired, Red-eye reduction, Return not detected', 0x5f: 'Auto, Fired, Red-eye reduction, Return detected',
  };
  const frac = (x) => {
    if (!x) return '0';
    const s = x > 0 ? '+' : '-', a = Math.abs(x);
    for (const d of [1, 2, 3]) { const n = Math.round(a * d); if (Math.abs(n / d - a) < 0.005) return d === 1 ? `${s}${n}` : `${s}${n}/${d}`; }
    return `${s}${trimNum(a, 2)}`;
  };
  const expo = (t) => (t > 0 && t < 0.25001 ? `1/${Math.round(1 / t)}` : trimNum(t, 1));
  const mm = (x) => `${(+x).toFixed(1)} mm`;
  const dms = (a) => { if (!Array.isArray(a)) return [String(a), a]; const d = a[0] + a[1] / 60 + (a[2] || 0) / 3600; return [`${Math.floor(a[0])} deg ${Math.floor(a[1])}' ${(a[2] || 0).toFixed(2)}"`, d]; };
  // tag → [name, print] — the EXIF tags the page reads; others are left out on purpose
  const EXIF = {
    0x010e: ['ImageDescription'], 0x010f: ['Make'], 0x0110: ['Model'], 0x0112: ['Orientation', pick(ORIENT)], 0x011a: ['XResolution'], 0x011b: ['YResolution'],
    0x0128: ['ResolutionUnit', pick({ 1: 'None', 2: 'inches', 3: 'cm' })], 0x0131: ['Software'], 0x0132: ['ModifyDate'], 0x013b: ['Artist'], 0x013c: ['HostComputer'],
    0x0100: ['ImageWidth'], 0x0101: ['ImageHeight'], 0x8298: ['Copyright'], 0xc614: ['UniqueCameraModel'],
    0x829a: ['ExposureTime', (v) => [expo(v), v]], 0x829d: ['FNumber', (v) => [trimNum(v, 1), v]],
    0x8822: ['ExposureProgram', pick({ 0: 'Not Defined', 1: 'Manual', 2: 'Program AE', 3: 'Aperture-priority AE', 4: 'Shutter speed priority AE', 5: 'Creative (Slow speed)', 6: 'Action (High speed)', 7: 'Portrait', 8: 'Landscape', 9: 'Bulb' })],
    0x8827: ['ISO'], 0x8830: ['SensitivityType', pick({ 0: 'Unknown', 1: 'Standard Output Sensitivity', 2: 'Recommended Exposure Index', 3: 'ISO Speed', 4: 'Standard Output Sensitivity and Recommended Exposure Index', 5: 'Standard Output Sensitivity and ISO Speed', 6: 'Recommended Exposure Index and ISO Speed', 7: 'Standard Output Sensitivity, Recommended Exposure Index and ISO Speed' })],
    0x8832: ['RecommendedExposureIndex'], 0x9000: ['ExifVersion', (v) => [latin(v, 0, 4), latin(v, 0, 4)]], 0x9003: ['DateTimeOriginal'], 0x9004: ['CreateDate'],
    0x9010: ['OffsetTime'], 0x9011: ['OffsetTimeOriginal'], 0x9012: ['OffsetTimeDigitized'],
    0x9201: ['ShutterSpeedValue', (v) => [expo(2 ** -v), 2 ** -v]], 0x9202: ['ApertureValue', (v) => [trimNum(2 ** (v / 2), 1), 2 ** (v / 2)]], 0x9203: ['BrightnessValue', (v) => [trimNum(v, 2), v]],
    0x9204: ['ExposureCompensation', (v) => [frac(v), v]], 0x9205: ['MaxApertureValue', (v) => [trimNum(2 ** (v / 2), 1), 2 ** (v / 2)]],
    0x9206: ['SubjectDistance', (v) => [`${trimNum(v, 3)} m`, v]],
    0x9207: ['MeteringMode', pick({ 0: 'Unknown', 1: 'Average', 2: 'Center-weighted average', 3: 'Spot', 4: 'Multi-spot', 5: 'Multi-segment', 6: 'Partial', 255: 'Other' })],
    0x9208: ['LightSource', pick({ 0: 'Unknown', 1: 'Daylight', 2: 'Fluorescent', 3: 'Tungsten (Incandescent)', 4: 'Flash', 9: 'Fine Weather', 10: 'Cloudy', 11: 'Shade', 17: 'Standard Light A', 21: 'D65', 255: 'Other' })],
    0x9209: ['Flash', pick(FLASH)], 0x920a: ['FocalLength', (v) => [mm(v), v]], 0x9214: ['SubjectArea', (v) => [[].concat(v).join(' '), [].concat(v).join(' ')]],
    0x9290: ['SubSecTime'], 0x9291: ['SubSecTimeOriginal'], 0x9292: ['SubSecTimeDigitized'],
    0xa001: ['ColorSpace', pick({ 1: 'sRGB', 2: 'Adobe RGB', 0xfffd: 'Wide Gamut RGB', 0xfffe: 'ICC Profile', 0xffff: 'Uncalibrated' })],
    0xa002: ['ExifImageWidth'], 0xa003: ['ExifImageHeight'], 0xa20e: ['FocalPlaneXResolution'], 0xa20f: ['FocalPlaneYResolution'],
    0xa210: ['FocalPlaneResolutionUnit', pick({ 1: 'None', 2: 'inches', 3: 'cm', 4: 'mm', 5: 'um' })],
    0xa217: ['SensingMethod', pick({ 1: 'Monochrome area', 2: 'One-chip color area', 3: 'Two-chip color area', 4: 'Three-chip color area', 5: 'Color sequential area', 7: 'Trilinear', 8: 'Color sequential linear' })],
    0xa401: ['CustomRendered', pick({ 0: 'Normal', 1: 'Custom', 2: 'HDR (no original saved)', 3: 'HDR (original saved)', 4: 'Original (for HDR)', 6: 'Panorama', 7: 'Portrait HDR', 8: 'Portrait' })],
    0xa402: ['ExposureMode', pick({ 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' })], 0xa403: ['WhiteBalance', pick({ 0: 'Auto', 1: 'Manual' })],
    0xa404: ['DigitalZoomRatio', (v) => [trimNum(v, 4), v]], 0xa405: ['FocalLengthIn35mmFormat', (v) => [`${v} mm`, v]],
    0xa406: ['SceneCaptureType', pick({ 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night', 4: 'Other' })],
    0xa408: ['Contrast', pick({ 0: 'Normal', 1: 'Low', 2: 'High' })], 0xa409: ['Saturation', pick({ 0: 'Normal', 1: 'Low', 2: 'High' })], 0xa40a: ['Sharpness', pick({ 0: 'Normal', 1: 'Soft', 2: 'Hard' })],
    0xa40c: ['SubjectDistanceRange', pick({ 0: 'Unknown', 1: 'Macro', 2: 'Close', 3: 'Distant' })], 0xa420: ['ImageUniqueID'], 0xa430: ['OwnerName'], 0xa431: ['SerialNumber'],
    0xa432: ['LensInfo', (v) => { const [a, b, c, d] = v; const f = a === b ? `${trimNum(a, 2)}mm` : `${trimNum(a, 2)}-${trimNum(b, 2)}mm`; const n = !c ? ' f/?' : c === d || !d ? ` f/${trimNum(c, 1)}` : ` f/${trimNum(c, 1)}-${trimNum(d, 1)}`; return [f + n, v.map((x) => trimNum(x || 0, 9)).join(' ')]; }],
    0xa433: ['LensMake'], 0xa434: ['LensModel'], 0xa435: ['LensSerialNumber'],
    0xa460: ['CompositeImage', pick({ 0: 'Unknown', 1: 'Not a Composite Image', 2: 'General Composite Image', 3: 'Composite Image Captured While Shooting' })],
  };
  const GPS = {
    0x00: ['GPSVersionID', (v) => [[].concat(v).join('.'), [].concat(v).join(' ')]], 0x01: ['GPSLatitudeRef', pick({ N: 'North', S: 'South' })], 0x02: ['GPSLatitude', dms],
    0x03: ['GPSLongitudeRef', pick({ E: 'East', W: 'West' })], 0x04: ['GPSLongitude', dms], 0x05: ['GPSAltitudeRef', pick({ 0: 'Above Sea Level', 1: 'Below Sea Level' })],
    0x06: ['GPSAltitude', (v) => [`${trimNum(v, 1)} m`, v]], 0x07: ['GPSTimeStamp', (v) => [[].concat(v).map((x, i) => (i < 2 ? String(Math.floor(x)).padStart(2, '0') : String(+x.toFixed(2)).padStart(2, '0'))).join(':'), null]],
    0x0c: ['GPSSpeedRef', pick({ K: 'km/h', M: 'mph', N: 'knots' })], 0x0d: ['GPSSpeed'], 0x10: ['GPSImgDirectionRef', pick({ T: 'True North', M: 'Magnetic North' })],
    0x11: ['GPSImgDirection'], 0x17: ['GPSDestBearingRef', pick({ T: 'True North', M: 'Magnetic North' })], 0x18: ['GPSDestBearing'], 0x1d: ['GPSDateStamp'],
    0x1f: ['GPSHPositioningError', (v) => [`${trimNum(v, 3)} m`, v]],
  };
  // Apple's maker notes (iPhone, iPad): the ones that say how the picture was made
  const APPLE = {
    0x0001: ['MakerNoteVersion'], 0x0008: ['AccelerationVector', (v) => [[].concat(v).join(' '), null]], 0x000a: ['HDRImageType', pick({ 3: 'HDR Image', 4: 'Original Image' })],
    0x000c: ['FocusDistanceRange', (v) => { const a = [].concat(v); return a.length === 2 ? [`${Math.min(...a).toFixed(2)} - ${Math.max(...a).toFixed(2)} m`, a.join(' ')] : [a.join(' '), null]; }],
    0x0011: ['ContentIdentifier'], 0x0014: ['ImageCaptureType', pick({ 1: 'ProRAW', 2: 'Portrait', 10: 'Photo', 11: 'Manual Focus', 12: 'Scene' })],
    0x0017: ['LivePhotoVideoIndex'], 0x0021: ['HDRHeadroom'], 0x002d: ['ColorTemperature'], 0x002e: ['CameraType', pick({ 0: 'Back Wide Angle', 1: 'Back Normal', 6: 'Front' })],
    0x0030: ['HDRGain'],
  };
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
  // u: bytes, base: where the TIFF header starts (offsets count from there); group of the first IFD
  function tiff(u, base, out, first = 'IFD0', ctx = {}) {
    if (base + 8 > u.length) return;
    const le = u[base] === 0x49;
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
    const magic = u16(base + 2);
    if (![42, 0x4f52, 0x5352, 0x55].includes(magic)) return; // TIFF, Olympus ORF (both), Panasonic RW2
    const seen = new Set();
    const value = (type, count, at) => {
      const n = SIZE[type] || 1;
      if (at + n * count > u.length || at < 0) return undefined;
      if (type === 2) return latin(u, at, count).replace(/\0+[\s\S]*$/, '').trim();
      if (type === 7 || type === 1 || type === 6) return count > 4 && type === 7 ? u.subarray(at, at + count) : count === 1 ? u[at] : [...u.subarray(at, at + count)];
      const one = (o) => {
        switch (type) {
          case 3: return u16(o);
          case 4: case 13: return u32(o);
          case 5: { const d = u32(o + 4); return d ? u32(o) / d : 0; }
          case 8: return dv.getInt16(o, le);
          case 9: return dv.getInt32(o, le);
          case 10: { const d = dv.getInt32(o + 4, le); return d ? dv.getInt32(o, le) / d : 0; }
          case 11: return dv.getFloat32(o, le);
          case 12: return dv.getFloat64(o, le);
          case 16: case 18: return Number(dv.getBigUint64(o, le));
          case 17: return Number(dv.getBigInt64(o, le));
          default: return u[o];
        }
      };
      if (count === 1) return one(at);
      const a = [];
      for (let i = 0; i < Math.min(count, 64); i++) a.push(one(at + i * n));
      return a;
    };
    const ifd = (off, group, table, offBase = base) => {
      const at = offBase + off;
      if (seen.has(at) || at + 2 > u.length || at < 0) return;
      seen.add(at);
      const n = u16(at);
      for (let i = 0; i < n && i < 512; i++) {
        const e = at + 2 + i * 12;
        if (e + 12 > u.length) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const sz = (SIZE[type] || 1) * count;
        const vAt = sz <= 4 ? e + 8 : offBase + u32(e + 8);
        if (tag === 0x8769 && group === 'IFD0') { ifd(u32(e + 8), 'ExifIFD', EXIF); continue; }
        if (tag === 0x8825) { ifd(u32(e + 8), 'GPS', GPS); continue; }
        if (tag === 0x02bc) { ctx.xmp = utf8.decode(u.subarray(vAt, vAt + count)); continue; } // XMP inside a TIFF / DNG
        if (tag === 0x8773) { ctx.icc = u.subarray(vAt, vAt + count); continue; }
        if (tag === 0x927c && group === 'ExifIFD') { if (latin(u, vAt, 9) === 'Apple iOS') ifd(14, 'Apple', APPLE, vAt); continue; }
        // the full-size image of a RAW file is in a sub-IFD (IFD0 is often a thumbnail): its size is the photo's
        if (tag === 0x014a && group === 'IFD0') {
          for (let k = 0; k < Math.min(count, 8); k++) {
            const so = base + (count === 1 ? u32(e + 8) : u32(vAt + k * 4));
            if (so + 2 > u.length || so < 0) continue;
            let w = 0, h = 0;
            for (let j = 0, m = u16(so); j < m && so + 2 + j * 12 + 12 <= u.length; j++) {
              const q = so + 2 + j * 12, tg = u16(q), ty = u16(q + 2);
              if (tg === 0x0100) w = ty === 3 ? u16(q + 8) : u32(q + 8);
              if (tg === 0x0101) h = ty === 3 ? u16(q + 8) : u32(q + 8);
            }
            if (w * h > (ctx.big ? ctx.big[0] * ctx.big[1] : 0)) ctx.big = [w, h];
          }
          continue;
        }
        // Panasonic's RW2 keeps the EXIF in the JPEG it carries
        if (tag === 0x002e && magic === 0x55 && group === 'IFD0') { ctx.inner = u.subarray(vAt, vAt + count); continue; }
        if (tag >= 0x0004 && tag <= 0x0007 && magic === 0x55 && group === 'IFD0') { // RW2: the sensor's borders (top, left, bottom, right)
          const r = (ctx.rw2 = ctx.rw2 || [0, 0, 0, 0]);
          r[tag - 4] = u16(e + 8);
          if (r[2] > r[0] && r[3] > r[1]) ctx.big = [r[3] - r[1], r[2] - r[0]];
          continue;
        }
        const def = table[tag];
        if (!def) continue;
        const v = value(type, count, vAt);
        if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
        const [val, num] = def[1] ? def[1](v) : [Array.isArray(v) ? v.join(' ') : v, undefined];
        out.set(group, def[0], typeof val === 'number' ? +val.toFixed(10) : val, num);
      }
    };
    ifd(u32(base + 4), first, first === 'GPS' ? GPS : EXIF);
    // IFD1, after IFD0: the little JPEG thumbnail (for a set's thumbnails and measuring, without decoding the photo)
    if (first === 'IFD0' && ctx.abs !== undefined) {
      const a0 = base + u32(base + 4);
      if (a0 + 2 <= u.length) {
        const next = a0 + 2 + u16(a0) * 12;
        if (next + 4 <= u.length && u32(next)) {
          const a1 = base + u32(next);
          let off = 0, len = 0;
          for (let j = 0, m = a1 + 2 <= u.length ? u16(a1) : 0; j < m && a1 + 2 + j * 12 + 12 <= u.length; j++) {
            const q = a1 + 2 + j * 12, tg = u16(q);
            if (tg === 0x0201) off = u32(q + 8);
            if (tg === 0x0202) len = u32(q + 8);
          }
          if (off && len > 500) ctx.thumb = { start: ctx.abs + base + off, end: ctx.abs + base + off + len };
        }
      }
    }
  }

  // ---------- XMP: a small XML reader (no DOM in workers), then RDF → ExifTool's group:Tag ----------
  const NS = {
    'http://ns.adobe.com/camera-raw-settings/1.0/': 'crs', 'http://ns.adobe.com/xap/1.0/': 'xmp', 'http://ns.adobe.com/xap/1.0/mm/': 'xmpMM',
    'http://ns.adobe.com/exif/1.0/aux/': 'aux', 'http://ns.adobe.com/exif/1.0/': 'exif', 'http://cipa.jp/exif/1.0/': 'exifEX', 'http://ns.adobe.com/tiff/1.0/': 'tiff',
    'http://purl.org/dc/elements/1.1/': 'dc', 'http://ns.adobe.com/photoshop/1.0/': 'photoshop', 'http://ns.adobe.com/xmp/1.0/DynamicMedia/': 'xmpDM',
    'http://ns.adobe.com/hdr-gain-map/1.0/': 'hdrgm', 'http://ns.apple.com/HDRGainMap/1.0/': 'HDRGainMap', 'http://ns.google.com/photos/1.0/container/': 'GContainer',
    'http://ns.google.com/photos/1.0/camera/': 'GCamera', 'http://ns.adobe.com/lightroom/1.0/': 'lr', 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/': 'iptcCore',
    'http://ns.apple.com/pixeldatainfo/1.0/': 'apdi', 'http://ns.adobe.com/xmp/note/': 'xmpNote',
  };
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const ent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()]));
  function xml(text) {
    const root = { kids: [], attrs: {}, ns: {} };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const top = stack[stack.length - 1];
      if (m[6] !== undefined) { if (m[6].trim()) top.text = (top.text || '') + ent(m[6]); continue; }
      if (m[1] !== undefined) { top.text = (top.text || '') + m[1]; continue; }
      if (!m[3]) continue;
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const node = { name: m[3], attrs: {}, kids: [], ns: { ...top.ns } };
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const v = ent(a[2] !== undefined ? a[2] : a[3]);
        if (a[1] === 'xmlns') node.ns[''] = v; else if (a[1].startsWith('xmlns:')) node.ns[a[1].slice(6)] = v; else node.attrs[a[1]] = v;
      }
      top.kids.push(node);
      if (!m[5]) stack.push(node);
    }
    return root;
  }
  const uriOf = (node, qname) => { const i = qname.indexOf(':'); return i < 0 ? [node.ns[''] || '', qname] : [node.ns[qname.slice(0, i)] || '', qname.slice(i + 1)]; };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function xmp(text, out) {
    if (!text) return;
    const start = text.indexOf('<x:xmpmeta'), s2 = start < 0 ? text.indexOf('<rdf:RDF') : start;
    if (s2 < 0) return;
    const tree = xml(text.slice(s2));
    const groupOf = (uri, prefix) => `XMP-${NS[uri] || prefix || 'unknown'}`;
    const put = (group, name, v) => {
      if (v === undefined || v === null || v === '') return;
      // ExifTool's name for Lightroom's colour temperature, and for each part of a struct (Look + Name → LookName)
      if (group === 'XMP-crs' && name === 'Temperature') name = 'ColorTemperature';
      const key = `${group}:${name}`;
      if (out.t[key] && Array.isArray(out.t[key].val)) { out.t[key].val.push(v); return; }
      if (out.t[key] && group !== 'XMP-crs') { const old = out.t[key].val; out.t[key] = { desc: out.t[key].desc, val: [].concat(old, v) }; return; }
      if (v === 'True' || v === 'False') { out.set(group, name, v === 'True'); return; }
      const fr = typeof v === 'string' && v.trim().match(/^([+-]?\d+)\/(\d+)$/);
      if (fr && +fr[2]) { const x = +fr[1] / +fr[2]; out.set(group, name, /^(FNumber|ApertureValue|FocalLength|MaxApertureValue)$/.test(name) ? +x.toFixed(2) : v, x); return; }
      const n = typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v.trim()) ? parseFloat(v) : undefined;
      out.set(group, name, v, n !== undefined && String(n) !== v ? n : undefined);
    };
    // a property: plain text, a list (rdf:Seq / Bag / Alt), or a struct (fields flatten into Name+Field)
    const prop = (node, group, name) => {
      const [kuri] = uriOf(node, node.name);
      const g = group || groupOf(kuri, node.name.split(':')[0]);
      const list = node.kids.find((k) => /^rdf:(Seq|Bag|Alt)$/.test(k.name));
      if (list) {
        const vals = [];
        for (const li of list.kids.filter((k) => k.name === 'rdf:li')) {
          const desc = li.kids.find((k) => k.name === 'rdf:Description');
          if (desc || li.kids.length || Object.keys(li.attrs).some((a) => a.includes(':') && !a.startsWith('xml:') && !a.startsWith('rdf:'))) struct(desc || li, g, name, true);
          else if (li.text !== undefined) vals.push(li.text.trim());
        }
        if (vals.length) out.t[`${g}:${name}`] = { desc: words(name), val: list.name === 'rdf:Alt' ? vals[0] : vals };
        return;
      }
      const inner = node.kids.find((k) => k.name === 'rdf:Description');
      if (inner || node.attrs['rdf:parseType'] === 'Resource' || Object.keys(node.attrs).some((a) => !a.startsWith('rdf:') && !a.startsWith('xml:') && a.includes(':'))) { struct(inner || node, g, name, false); return; }
      put(g, name, (node.text || '').trim());
    };
    const struct = (node, g, prefix, many) => {
      for (const [a, v] of Object.entries(node.attrs)) {
        if (a.startsWith('rdf:') || a.startsWith('xml:') || !a.includes(':')) continue;
        const nm = prefix + cap(uriOf(node, a)[1]);
        if (many) { const key = `${g}:${nm}`; out.t[key] = { desc: words(nm), val: [].concat(out.t[key] ? out.t[key].val : [], v) }; } else put(g, nm, v);
      }
      for (const k of node.kids) {
        if (k.name.startsWith('rdf:')) continue;
        const nm = prefix + cap(uriOf(k, k.name)[1]);
        const fields = k.kids.some((x) => !x.name.startsWith('rdf:') || x.name === 'rdf:Description') || Object.keys(k.attrs).some((a) => a.includes(':') && !a.startsWith('rdf:') && !a.startsWith('xml:'));
        if (fields && !k.kids.some((x) => /^rdf:(Seq|Bag|Alt)$/.test(x.name))) { struct(k.kids.find((x) => x.name === 'rdf:Description') || k, g, nm, many); continue; }
        if (many && !k.kids.length) { const key = `${g}:${nm}`; out.t[key] = { desc: words(nm), val: [].concat(out.t[key] ? out.t[key].val : [], (k.text || '').trim()) }; } else prop(k, g, nm);
      }
    };
    const walk = (node) => {
      for (const k of node.kids) {
        if (k.name === 'rdf:Description') {
          for (const [a, v] of Object.entries(k.attrs)) {
            if (a.startsWith('rdf:') || a.startsWith('xml:') || !a.includes(':')) continue;
            const [uri, local] = uriOf(k, a);
            put(groupOf(uri, a.split(':')[0]), cap(local), v);
          }
          for (const p of k.kids) { const [, local] = uriOf(p, p.name); prop(p, null, cap(local)); }
        } else walk(k);
      }
    };
    walk(tree);
  }

  // ---------- ICC: the profile's name ----------
  function icc(u, out) {
    if (!u || u.length < 132) return;
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const n = dv.getUint32(128);
    for (let i = 0; i < n && 132 + i * 12 + 12 <= u.length; i++) {
      const e = 132 + i * 12;
      if (latin(u, e, 4) !== 'desc') continue;
      const off = dv.getUint32(e + 4), type = latin(u, off, 4);
      let s = '';
      if (type === 'desc') s = latin(u, off + 12, dv.getUint32(off + 8)).replace(/\0[\s\S]*$/, '');
      else if (type === 'mluc' && off + 28 <= u.length) {
        const len = dv.getUint32(off + 20), at = off + dv.getUint32(off + 24);
        for (let j = 0; j + 1 < len && at + j + 1 < u.length; j += 2) s += String.fromCharCode(dv.getUint16(at + j));
      }
      out.set('ICC_Profile', 'ProfileDescription', s.replace(/\0+/g, '').trim());
      return;
    }
  }

  // ---------- containers ----------
  // JPEG: the segments before the image data
  function jpeg(u, at, out, ctx) {
    let p = at + 2;
    const iccParts = [], ext = new Map();
    while (p + 4 <= u.length && u[p] === 0xFF) {
      const m = u[p + 1];
      if (m === 0xFF) { p++; continue; }
      if (m === 0xDA || m === 0xD9) break;
      const len = (u[p + 2] << 8) | u[p + 3], d = p + 4, end = Math.min(u.length, p + 2 + len);
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC && !out.has('File', 'ImageWidth')) {
        out.set('File', 'ImageHeight', (u[d + 1] << 8) | u[d + 2]);
        out.set('File', 'ImageWidth', (u[d + 3] << 8) | u[d + 4]);
      } else if (m === 0xE1) {
        const head = latin(u, d, 40);
        if (head.startsWith('Exif\0')) tiff(u, d + 6, out, 'IFD0', ctx);
        else if (head.startsWith('http://ns.adobe.com/xap/1.0/\0')) ctx.xmp = utf8.decode(u.subarray(d + 29, end));
        else if (head.startsWith('http://ns.adobe.com/xmp/extension/\0')) {
          // extended XMP: a GUID, the full length and this piece's offset, then the piece (Lightroom's big settings)
          const q = d + 35, dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
          ext.set(dv.getUint32(q + 36), u.subarray(q + 40, end));
        }
      } else if (m === 0xE2 && latin(u, d, 12) === 'ICC_PROFILE\0') iccParts[u[d + 12]] = u.subarray(d + 14, end);
      p += 2 + len;
    }
    if (iccParts.length) { const parts = iccParts.filter(Boolean); const all = new Uint8Array(parts.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of parts) { all.set(x, o); o += x.length; } ctx.icc = all; }
    if (ext.size) ctx.xmpExt = [...ext.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => utf8.decode(x)).join('');
  }
  // ISO boxes (HEIC, AVIF, CR3): [type, payload start, end]
  function* boxes(u, a, b) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    while (a + 8 <= b) {
      let size = dv.getUint32(a), hdr = 8;
      const type = latin(u, a + 4, 4);
      if (size === 1) { size = Number(dv.getBigUint64(a + 8)); hdr = 16; } else if (size === 0) size = b - a;
      if (size < hdr) return;
      yield [type, a + hdr, Math.min(b, a + size), a];
      a += size;
    }
  }
  async function heif(file, u, out, ctx) {
    const dv = () => new DataView(u.buffer, u.byteOffset, u.byteLength);
    let meta = null;
    for (const [type, s, e, a] of boxes(u, 0, u.length)) {
      if (type === 'ftyp') out.set('File', 'MajorBrand', latin(u, s, 4).trim());
      if (type === 'meta') { meta = [s + 4, e, a]; break; }
    }
    if (!meta) return;
    if (meta[1] > u.length - 8 && meta[1] <= file.size) { u = await bytes(file, 0, meta[1] + 16); }
    const D = dv();
    let primary = 0, idat = null;
    const items = new Map(), loc = new Map(), props = [], assoc = new Map();
    for (const [type, s, e] of boxes(u, meta[0], meta[1])) {
      const v = u[s];
      if (type === 'pitm') primary = v ? D.getUint32(s + 4) : D.getUint16(s + 4);
      else if (type === 'idat') idat = [s, e];
      else if (type === 'iinf') {
        const at = s + 4 + (v ? 4 : 2);
        for (const [t2, s2] of boxes(u, at, e)) {
          if (t2 !== 'infe') continue;
          const iv = u[s2];
          if (iv < 2) continue;
          const id = iv === 2 ? D.getUint16(s2 + 4) : D.getUint32(s2 + 4);
          const p0 = s2 + 4 + (iv === 2 ? 2 : 4) + 2;
          const itype = latin(u, p0, 4);
          let q = p0 + 4; while (q < e && u[q]) q++;
          let ctype = ''; if (itype === 'mime') { let r = q + 1; while (r < e && u[r]) r++; ctype = latin(u, q + 1, r - q - 1); }
          items.set(id, { type: itype, ctype });
        }
      } else if (type === 'iloc') {
        const os = u[s + 4] >> 4, ls = u[s + 4] & 15, bs = u[s + 5] >> 4, is = v === 1 || v === 2 ? u[s + 5] & 15 : 0;
        const rd = (o, n) => (n === 0 ? 0 : n === 4 ? D.getUint32(o) : n === 8 ? Number(D.getBigUint64(o)) : n === 2 ? D.getUint16(o) : 0);
        let p = s + 6;
        const count = v < 2 ? D.getUint16(p) : D.getUint32(p); p += v < 2 ? 2 : 4;
        for (let i = 0; i < count && p < e; i++) {
          const id = v < 2 ? D.getUint16(p) : D.getUint32(p); p += v < 2 ? 2 : 4;
          let method = 0; if (v === 1 || v === 2) { method = D.getUint16(p) & 15; p += 2; }
          p += 2; // data reference index
          const baseOff = rd(p, bs); p += bs;
          const n = D.getUint16(p); p += 2;
          const ext = [];
          for (let j = 0; j < n; j++) { p += is; const off = rd(p, os); p += os; const len = rd(p, ls); p += ls; ext.push([baseOff + off, len]); }
          loc.set(id, { method, ext });
        }
      } else if (type === 'iprp') {
        for (const [t2, s2, e2] of boxes(u, s, e)) {
          if (t2 === 'ipco') for (const [t3, s3, e3] of boxes(u, s2, e2)) props.push([t3, s3, e3]);
          if (t2 === 'ipma') {
            const pv = u[s2], flags = u[s2 + 3];
            let p = s2 + 4;
            const n = D.getUint32(p); p += 4;
            for (let i = 0; i < n && p < e2; i++) {
              const id = pv < 1 ? D.getUint16(p) : D.getUint32(p); p += pv < 1 ? 2 : 4;
              const c = u[p++];
              const list = [];
              for (let j = 0; j < c; j++) { const x = flags & 1 ? D.getUint16(p) & 0x7fff : u[p] & 0x7f; p += flags & 1 ? 2 : 1; list.push(x); }
              assoc.set(id, list);
            }
          }
        }
      }
    }
    const read = async (id) => {
      const l = loc.get(id);
      if (!l) return null;
      const parts = [];
      for (const [off, len] of l.ext) parts.push(l.method === 1 && idat ? u.subarray(idat[0] + off, idat[0] + off + len) : await bytes(file, off, off + len));
      const all = new Uint8Array(parts.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of parts) { all.set(x, o); o += x.length; }
      return all;
    };
    for (const pi of assoc.get(primary) || []) {
      const p = props[pi - 1];
      if (!p) continue;
      const [t, s] = p;
      if (t === 'ispe') { out.set('File', 'ImageWidth', D.getUint32(s + 4)); out.set('File', 'ImageHeight', D.getUint32(s + 8)); }
      if (t === 'irot') { const r = u[s] & 3; out.set('QuickTime', 'Rotation', ['Horizontal (normal)', 'Rotate 270 CW', 'Rotate 180', 'Rotate 90 CW'][r], r); }
      if (t === 'colr' && /^(prof|rICC)$/.test(latin(u, s, 4))) ctx.icc = u.subarray(s + 4, p[2]);
    }
    for (const [id, it] of items) {
      if (it.type === 'Exif') {
        const d = await read(id);
        if (d && d.length > 8) { const off = new DataView(d.buffer, d.byteOffset).getUint32(0); tiff(d, 4 + off, out, 'IFD0', ctx); }
      } else if (it.type === 'mime' && /rdf\+xml|xmp/i.test(it.ctype)) {
        const d = await read(id);
        if (d) ctx.xmp = (ctx.xmp || '') + utf8.decode(d);
      }
    }
  }
  // Canon CR3: the EXIF sits in CMT boxes in a uuid box inside moov; XMP in its own uuid box
  async function cr3(file, u, out, ctx) {
    const CANON = '85c0b687820f11e08111f4ce462b6a48', XMPU = 'be7acfcb97a942e89c71999491e3afac';
    const hex = (a) => [...u.subarray(a, a + 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
    for (const [type, s, e] of boxes(u, 0, u.length)) {
      if (type === 'moov') {
        if (e > u.length) u = await bytes(file, 0, e);
        for (const [t2, s2, e2] of boxes(u, s, e)) {
          if (t2 !== 'uuid' || hex(s2) !== CANON) continue;
          for (const [t3, s3, e3] of boxes(u, s2 + 16, e2)) {
            const sub = u.subarray(s3, e3);
            if (t3 === 'CMT1') tiff(sub, 0, out, 'IFD0', ctx);
            else if (t3 === 'CMT2') tiff(sub, 0, out, 'ExifIFD', ctx);
            else if (t3 === 'CMT4') tiff(sub, 0, out, 'GPS', ctx);
          }
        }
      } else if (type === 'uuid' && hex(s) === XMPU) ctx.xmp = utf8.decode((e <= u.length ? u : await bytes(file, 0, e)).subarray(s + 16, e));
    }
  }

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

  // ---------- what ExifTool works out from the rest (Composite) ----------
  function composite(out) {
    const g = (names, groups = ['ExifIFD', 'IFD0', 'XMP-exif', 'XMP-tiff', 'XMP-aux', 'XMP-exifEX']) => { for (const n of [].concat(names)) for (const gr of groups) { const v = out.get(gr, n); if (v !== undefined && v !== '') return v; } return undefined; };
    const N = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
    const w = N(out.get('File', 'ImageWidth') ?? g(['ExifImageWidth', 'ImageWidth'])), h = N(out.get('File', 'ImageHeight') ?? g(['ExifImageHeight', 'ImageHeight']));
    const fw = N(g('ExifImageWidth') ?? w), fh = N(g('ExifImageHeight') ?? h);
    if (w > 0 && h > 0) { out.set('Composite', 'ImageSize', `${w}x${h}`, `${w} ${h}`); out.set('Composite', 'Megapixels', trimNum(w * h / 1e6, 1), w * h / 1e6); }
    const fn = N(g('FNumber')), t = N(g('ExposureTime')), iso = N(g(['ISO', 'ISOSpeedRatings', 'RecommendedExposureIndex'])), fl = N(g('FocalLength'));
    let f35 = N(g('FocalLengthIn35mmFormat'));
    if (fn > 0) out.set('Composite', 'Aperture', trimNum(fn, 1), fn);
    if (t > 0) out.set('Composite', 'ShutterSpeed', expo(t), t);
    // no 35 mm focal length (most cameras): the sensor's size from the focal plane resolution, as ExifTool does
    const unit = { 2: 25.4, 3: 10, 4: 1, 5: 0.001 }[out.get('ExifIFD', 'FocalPlaneResolutionUnit')];
    const fx = N(g('FocalPlaneXResolution')), fy = N(g('FocalPlaneYResolution')) || fx;
    const diag = unit && fx > 0 && fw > 0 && fh > 0 ? Math.hypot((fw / fx) * unit, (fh / fy) * unit) : NaN;
    const scale = fl > 0 && f35 > 0 ? f35 / fl : diag > 4 ? Math.hypot(24, 36) / diag : NaN;
    if (!(f35 > 0) && scale > 0 && fl > 0) f35 = fl * scale;
    if (scale > 0) {
      out.set('Composite', 'ScaleFactor35efl', trimNum(scale, 1), scale);
      out.set('Composite', 'FocalLength35efl', `${fl.toFixed(1)} mm (35 mm equivalent: ${f35.toFixed(1)} mm)`, f35);
      const c = Math.sqrt(24 * 24 + 36 * 36) / (scale * 1440);
      out.set('Composite', 'CircleOfConfusion', `${c.toFixed(3)} mm`, c);
      out.set('Composite', 'FOV', `${(2 * Math.atan(36 / (2 * f35)) * 180 / Math.PI).toFixed(1)} deg`, 2 * Math.atan(36 / (2 * f35)) * 180 / Math.PI);
      if (fn > 0) {
        const H = (fl * fl) / (fn * c) / 1000;
        out.set('Composite', 'HyperfocalDistance', `${H.toFixed(2)} m`, H);
        const d = N(g(['SubjectDistance', 'ApproximateFocusDistance'])); // the second: Lightroom's, in XMP
        if (d > 0 && d < 1e5) {
          const k = (fn * c * (d * 1000 - fl)) / (fl * fl);
          const near = d / (1 + k), far = k < 1 ? d / (1 - k) : Infinity;
          out.set('Composite', 'DOF', far === Infinity ? `inf (${near.toFixed(2)} m - inf)` : `${(far - near).toFixed(2)} m (${near.toFixed(2)} - ${far.toFixed(2)} m)`, `${near} ${far === Infinity ? 'inf' : far}`);
        }
      }
    }
    if (fn > 0 && t > 0 && iso > 0) { const lv = Math.log2((fn * fn) / t) - Math.log2(iso / 100); out.set('Composite', 'LightValue', trimNum(lv, 1), lv); }
    const lens = g(['LensModel', 'Lens']);
    if (lens) out.set('Composite', 'LensID', lens);
    // GPS with its sign (the GPS group keeps that in the Ref tags)
    const lat = out.get('GPS', 'GPSLatitude'), lon = out.get('GPS', 'GPSLongitude');
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const sl = /S/.test(out.get('GPS', 'GPSLatitudeRef')) ? -lat : lat, so = /W/.test(out.get('GPS', 'GPSLongitudeRef')) ? -lon : lon;
      out.set('Composite', 'GPSLatitude', `${dms([Math.abs(sl), 0, 0])[0]}`, sl);
      out.set('Composite', 'GPSLongitude', `${dms([Math.abs(so), 0, 0])[0]}`, so);
      const alt = out.get('GPS', 'GPSAltitude');
      if (Number.isFinite(alt)) out.set('Composite', 'GPSAltitude', `${alt.toFixed(1)} m ${out.get('GPS', 'GPSAltitudeRef') === 1 ? 'Below' : 'Above'} Sea Level`, out.get('GPS', 'GPSAltitudeRef') === 1 ? -alt : alt);
    }
    const dto = g('DateTimeOriginal');
    if (dto) {
      const sub = g('SubSecTimeOriginal'), off = g('OffsetTimeOriginal');
      out.set('Composite', 'SubSecDateTimeOriginal', `${dto}${sub !== undefined ? `.${sub}` : ''}${off || ''}`);
    }
  }

  // ---------- one file ----------
  // opts.head: how much to read first (the rest only where needed); opts.whole: all of it (to find a RAW's preview)
  async function read(file, opts = {}) {
    const out = Out(), ctx = {};
    const name = file.name.toLowerCase();
    let head = await bytes(file, 0, opts.whole ? file.size : opts.head || 262144);
    let type = '';
    if (/\.xmp$/.test(name)) { type = 'XMP'; ctx.xmp = utf8.decode(await bytes(file, 0, file.size)); }
    else if (head[0] === 0xFF && head[1] === 0xD8) {
      type = 'JPEG';
      // metadata past the first megabyte (a big extended XMP): read on until the image data starts
      let p = 2;
      for (;;) {
        if (p + 4 > head.length) { if (head.length >= file.size || p > 64e6) break; head = await bytes(file, 0, Math.min(file.size, p + (2 << 20))); continue; }
        if (head[p] !== 0xFF) break;
        const m = head[p + 1];
        if (m === 0xFF) { p++; continue; }
        if (m === 0xDA || m === 0xD9) break;
        p += 2 + ((head[p + 2] << 8) | head[p + 3]);
      }
      ctx.abs = 0; // offsets in this JPEG are offsets in the file
      jpeg(head, 0, out, ctx);
    } else if (latin(head, 4, 4) === 'ftyp') {
      const brand = latin(head, 8, 4);
      if (brand === 'crx ') { type = 'CR3'; await cr3(file, head, out, ctx); }
      else if (/^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis)$/.test(brand)) { type = /avi/.test(brand) ? 'AVIF' : 'HEIC'; await heif(file, head, out, ctx); }
      else return null;
    } else if (latin(head, 0, 16) === 'FUJIFILMCCD-RAW ') {
      type = 'RAF';
      const dv = new DataView(head.buffer, head.byteOffset), off = dv.getUint32(84), len = dv.getUint32(88);
      const j = off + len <= head.length ? head.subarray(off, off + len) : await bytes(file, off, off + Math.min(len, 8 << 20));
      jpeg(j, 0, out, ctx);
      // the RAF's own directory: tag 0x111 is the size of the image after the camera's crop (height, width)
      try {
        const dOff = dv.getUint32(92), dLen = Math.min(dv.getUint32(96), 65536);
        const d = await bytes(file, dOff, dOff + dLen), dd = new DataView(d.buffer, d.byteOffset);
        for (let q = 4, k = 0, n = dd.getUint32(0); k < n && q + 4 <= d.length; k++) {
          const tg = dd.getUint16(q), sz = dd.getUint16(q + 2);
          if (tg === 0x111 && sz >= 4) { out.set('File', 'ImageHeight', dd.getUint16(q + 4)); out.set('File', 'ImageWidth', dd.getUint16(q + 6)); }
          q += 4 + sz;
        }
      } catch {}
    } else if ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4D && head[1] === 0x4D)) {
      type = (name.match(/\.([a-z0-9]+)$/) || [, 'tiff'])[1].toUpperCase();
      // a DNG or TIFF can keep its XMP anywhere: read it whole when it isn't huge
      if (/^(DNG|TIF|TIFF)$/.test(type) && file.size <= 80e6 && file.size > head.length) head = await bytes(file, 0, file.size);
      tiff(head, 0, out, 'IFD0', ctx);
      if (ctx.inner) jpeg(ctx.inner, 0, out, ctx);
      if (ctx.big && ctx.big[0] * ctx.big[1] > (N0(out.get('IFD0', 'ImageWidth')) * N0(out.get('IFD0', 'ImageHeight')))) { out.set('File', 'ImageWidth', ctx.big[0]); out.set('File', 'ImageHeight', ctx.big[1]); }
    } else return null;
    out.set('File', 'FileType', type);
    if (ctx.xmp) xmp(ctx.xmp, out);
    if (ctx.xmpExt) xmp(ctx.xmpExt, out);
    if (ctx.icc) icc(ctx.icc, out);
    composite(out);
    return { tags: out.t, type, preview: opts.preview && type !== 'JPEG' ? biggestJpeg(head) : null, thumb: ctx.thumb || null };
  }
  self.ZMeta = { read, biggestJpeg };
})();
