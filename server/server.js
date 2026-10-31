#!/usr/bin/env node
/* ZhuyuanTools static server + the public counters. No dependencies: `node server/server.js`.
   Clean URLs, each tool still in its own folder:
     /       → home/ (its 拍攝 side at /photo)            /video → videotools/            /pdf → pdftools/local/     /avatar → avatartools/     /image → imagetools/     /crop → croptools/     /watermark → watermarktools/     /exif → exiftools/     /rename → renametools/     /pick → picktools/     /fonts → fonts/     /shared → shared/
   A tool's page is served at /video (no trailing slash) with <base href="/video/"> injected, so its relative
   asset paths keep working both here and when the folder is opened straight from disk.
   Counters keep only totals (files, seconds/pages, bytes saved) per tool — never file content:
     GET  /api/stats                → { video: {...}, pdf: {...} }   (home page)
     GET  /video/api/stats          → video totals
     POST /video/api/stats/processed ← { files, seconds, savedBytes }
     GET  /pdf/api/stats            → pdf totals   (the shape the PDF tool already expects)
     POST /pdf/api/stats/processed  ← { files, pages, savedBytes }
     GET  /avatar/api/stats         → avatar totals
     POST /avatar/api/stats/processed ← { files }   (emails looked up)
     POST /image/api/stats/processed  ← { files, savedBytes }
     POST /crop/api/stats/processed   ← { files }   (avatars cropped)
     POST /watermark/api/stats/processed ← { files }   (PDFs watermarked)
     POST /exif/api/stats/processed   ← { files }   (photos read)
     POST /rename/api/stats/processed ← { files }   (files renamed)
     POST /pick/api/stats/processed   ← { files }   (picked photos saved)
   The photo tool's Flickr links are asked from here (server/flickr.js), so the API key stays on this machine:
     GET  /exif/api/flickr/status, /exif/api/flickr/rest?method=…, /exif/api/flickr/oembed?url=…
   照片挑選's second window is /pick/second. Its demo, /pick/demo, is the one place photos come from this server:
   demo.zip at the top of the site (not in git), unpacked once into server/data/pick-demo, each photo served on its
   own (with byte ranges, so the page reads just the start of each for its time and thumbnail):
     GET  /pick/demo/list.json → [{ name, size, mtime }]      GET /pick/demo/<name> → the photo
   Env: PORT (default 8080), HOST (default 127.0.0.1), STATS_FILE (default server/data/stats.json). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const flickr = require('./flickr');

const ROOT = path.resolve(__dirname, '..');
const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'data', 'stats.json');

// route → folder. The root mount must stay last. /fonts is shared by every page and never changes, and neither do
// the photo tool's libraries (version in each file name; its 7.5 MB Perl runtime shouldn't be fetched twice).
const MOUNTS = [
  { route: '/video', dir: path.join(ROOT, 'videotools'), tool: 'video' },
  { route: '/pdf', dir: path.join(ROOT, 'pdftools', 'local'), tool: 'pdf' },
  { route: '/avatar', dir: path.join(ROOT, 'avatartools'), tool: 'avatar' },
  { route: '/image', dir: path.join(ROOT, 'imagetools'), tool: 'image' },
  { route: '/crop', dir: path.join(ROOT, 'croptools'), tool: 'crop' },
  { route: '/watermark', dir: path.join(ROOT, 'watermarktools'), tool: 'watermark' },
  { route: '/exif/lib', dir: path.join(ROOT, 'exiftools', 'lib'), immutable: true },
  { route: '/exif', dir: path.join(ROOT, 'exiftools'), tool: 'exif' },
  { route: '/rename', dir: path.join(ROOT, 'renametools'), tool: 'rename' },
  { route: '/pick', dir: path.join(ROOT, 'picktools'), tool: 'pick' },
  { route: '/fonts', dir: path.join(ROOT, 'fonts'), immutable: true },
  { route: '/shared', dir: path.join(ROOT, 'shared') },
  { route: '', dir: path.join(ROOT, 'home') },
];
// Old addresses from before the clean URLs.
const LEGACY = [
  [/^\/home(\/(index\.html)?)?$/, '/'],
  [/^\/index\.html$/, '/'],
  [/^\/videotools(\/(index\.html)?)?$/, '/video'],
  [/^\/pdftools(\/(local(\/(index\.html)?)?)?)?$/, '/pdf'],
  [/^\/avatartools(\/(index\.html)?)?$/, '/avatar'],
  [/^\/imagetools(\/(index\.html)?)?$/, '/image'],
  [/^\/croptools(\/(index\.html)?)?$/, '/crop'],
  [/^\/watermarktools(\/(index\.html)?)?$/, '/watermark'],
  [/^\/exiftools(\/(index\.html)?)?$/, '/exif'],
  [/^\/renametools(\/(index\.html)?)?$/, '/rename'],
  [/^\/picktools(\/(index\.html)?)?$/, '/pick'],
  [/^\/pick\/second(\.html|\/)$/, '/pick/second'],
  [/^\/pick\/demo\/(index\.html)?$/, '/pick/demo'],
  [/^\/photo\/$/, '/photo'],
];

const FIELDS = { video: ['files', 'seconds', 'savedBytes'], pdf: ['files', 'pages', 'savedBytes'], avatar: ['files'], image: ['files', 'savedBytes'], crop: ['files'], watermark: ['files'], exif: ['files'], rename: ['files'], pick: ['files'] };
// Upper bounds for one report, so a single bad request can't inflate the counters much. A rename is one report for
// a whole folder, a pick the whole batch saved.
const LIMITS = { files: 50, seconds: 6 * 3600 * 50, pages: 5000, savedBytes: 200e9 };
const TOOL_LIMITS = { rename: { files: 20000 }, pick: { files: 20000 } };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.ico': 'image/x-icon',
};

let stats = { video: {}, pdf: {}, avatar: {}, image: {}, crop: {}, watermark: {}, exif: {}, rename: {}, pick: {} };
try { stats = { ...stats, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) }; } catch {}
for (const [k, fields] of Object.entries(FIELDS)) for (const f of fields) stats[k][f] = +stats[k][f] || 0;

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    const tmp = STATS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stats));
    fs.renameSync(tmp, STATS_FILE);
  }, 500);
}

const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { ...HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function redirect(res, to) { res.writeHead(301, { ...HEADERS, Location: to }); res.end(); }

function handleApi(req, res, url) {
  if (url === '/api/stats' && req.method === 'GET') return send(res, 200, stats), true;
  for (const { route, tool } of MOUNTS) {
    if (!tool) continue;
    if (url === `${route}/api/stats` && req.method === 'GET') return send(res, 200, stats[tool]), true;
    if (url === `${route}/api/stats/processed` && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
      req.on('end', () => {
        let d;
        try { d = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
        for (const f of FIELDS[tool]) {
          const v = Math.floor(+d[f]);
          if (Number.isFinite(v) && v > 0) stats[tool][f] += Math.min(v, (TOOL_LIMITS[tool] || LIMITS)[f] || LIMITS[f]);
        }
        save();
        send(res, 200, stats[tool]);
      });
      return true;
    }
  }
  // the PDF tool's ad counters: accepted and ignored here
  if (url === '/pdf/api/ads/event' && req.method === 'POST') return send(res, 204, ''), true;
  return false;
}

// Cloudflare tells browsers to keep CSS and JS for hours whatever we send, which pairs a fresh page with an old
// stylesheet. So each page names its stylesheets, scripts and images with ?v=<file time>: a changed file gets a
// new address and is fetched right away, an unchanged one stays cached.
function fileFor(urlPath, pageDir) {
  if (!urlPath.startsWith('/')) return path.join(pageDir, urlPath);
  for (const { route: r, dir } of MOUNTS) {
    if (r && !urlPath.startsWith(`${r}/`)) continue;
    return path.join(dir, urlPath.slice(r.length));
  }
  return null;
}
function versioned(html, pageDir) {
  return html.replace(/(<(?:script|link|img)\b[^>]*?\s(?:src|href)=")([^"?#:]+\.(?:css|js|svg|png|jpg|webp))(")/gi, (m, a, u, b) => {
    let st;
    try { const f = fileFor(u, pageDir); st = f && fs.statSync(f); } catch { return m; }
    return st ? `${a}${u}?v=${Math.round(st.mtimeMs).toString(36)}${b}` : m;
  });
}

// the 拍攝 side of the home page, shared as a link: its own title, words and picture
const PHOTO_DESC = '拍完照，剩下的交給這裡：照片挑選、改名稱、圖片壓縮、參數查看。照片只在你的電腦裡處理，不會上傳。';
const photoSide = (html) => html
  .replace(/<title>[^<]*<\/title>/, '<title>ZhuyuanTools・拍攝</title>')
  .replace(/(<meta property="og:title" content=")[^"]*/, '$1ZhuyuanTools・拍攝')
  .replace(/(<meta (?:name="description"|property="og:description") content=")[^"]*/g, `$1${PHOTO_DESC}`)
  .replace(/(<meta property="og:url" content=")[^"]*/, '$1https://tools.zhuyuan.tw/photo')
  .replace(/(<meta property="og:image" content=")[^"]*/, '$1https://tools.zhuyuan.tw/assets/og-photo.png');

// ---------- 照片挑選's demo photos ----------
const DEMO_ZIP = path.join(ROOT, 'demo.zip');
const DEMO_DIR = path.join(__dirname, 'data', 'pick-demo');
const DEMO_PHOTO = /\.(jpe?g|png|webp|heic|heif)$/i;
let demoReady = null;   // Promise<Map name → { size, mtime }> | null
// demo.zip's photos into DEMO_DIR, again only when the ZIP changed (its size and time, in .stamp)
function demoPhotos() {
  if (demoReady) return demoReady;
  demoReady = (async () => {
    const zst = await fs.promises.stat(DEMO_ZIP);
    const stamp = `${zst.size}:${Math.round(zst.mtimeMs)}`;
    let fresh = false;
    try { fresh = (await fs.promises.readFile(path.join(DEMO_DIR, '.stamp'), 'utf8')) === stamp; } catch {}
    if (!fresh) {
      await fs.promises.rm(DEMO_DIR, { recursive: true, force: true });
      await fs.promises.mkdir(DEMO_DIR, { recursive: true });
      await unzipPhotos(DEMO_ZIP, DEMO_DIR);
      await fs.promises.writeFile(path.join(DEMO_DIR, '.stamp'), stamp);
    }
    const list = new Map();
    for (const name of (await fs.promises.readdir(DEMO_DIR)).sort()) {
      if (!DEMO_PHOTO.test(name)) continue;
      const st = await fs.promises.stat(path.join(DEMO_DIR, name));
      list.set(name, { size: st.size, mtime: Math.round(st.mtimeMs) });
    }
    return list;
  })();
  // no demo.zip (yet): try again next time; a broken one: once per start, not on every request
  demoReady.catch((e) => { if (e.code === 'ENOENT') demoReady = null; else console.error('照片挑選 demo:', e.message); });
  return demoReady;
}
// a ZIP's photos (stored or deflated; ZIP64 sizes too) into a folder, flat, by their own names
async function unzipPhotos(zipFile, dir) {
  const zlib = require('zlib');
  const fh = await fs.promises.open(zipFile, 'r');
  try {
    const { size } = await fh.stat();
    const read = async (pos, len) => { const b = Buffer.alloc(len); await fh.read(b, 0, len, pos); return b; };
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    const e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (e < 0) throw new Error('not a zip');
    let cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xffffffff && e >= 20 && tail.readUInt32LE(e - 20) === 0x07064b50) {
      const r = await read(Number(tail.readBigUInt64LE(e - 12)), 56);
      cdSize = Number(r.readBigUInt64LE(40)); cdOff = Number(r.readBigUInt64LE(48));
    }
    const cd = await read(cdOff, cdSize);
    const used = new Set();
    for (let q = 0; q + 46 <= cd.length && cd.readUInt32LE(q) === 0x02014b50;) {
      const method = cd.readUInt16LE(q + 10), nl = cd.readUInt16LE(q + 28), xl = cd.readUInt16LE(q + 30), cl = cd.readUInt16LE(q + 32);
      const usize0 = cd.readUInt32LE(q + 24);
      let csize = cd.readUInt32LE(q + 20), lho = cd.readUInt32LE(q + 42);
      // ZIP64: what didn't fit in 32 bits is in extra field 1, in this order
      for (let x = q + 46 + nl; x + 4 <= q + 46 + nl + xl;) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 1) { let y = x + 4; if (usize0 === 0xffffffff) y += 8; if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(y)); y += 8; } if (lho === 0xffffffff) lho = Number(cd.readBigUInt64LE(y)); }
        x += 4 + len;
      }
      const name = path.basename(cd.toString('utf8', q + 46, q + 46 + nl).replace(/\\/g, '/'));
      q += 46 + nl + xl + cl;
      if (!DEMO_PHOTO.test(name) || name.startsWith('.') || (method !== 0 && method !== 8) || !csize || !usize0) continue;
      // the same name in two folders: the second one gets " (2)"
      let file = name;
      for (let k = 2; used.has(file.toLowerCase()); k++) file = name.replace(/(\.[^.]+)$/, ` (${k})$1`);
      used.add(file.toLowerCase());
      // one bad photo is left out, not the whole demo
      try {
        const lh = await read(lho, 30);
        const at = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const steps = [fs.createReadStream(zipFile, { start: at, end: at + csize - 1 }), ...(method === 8 ? [zlib.createInflateRaw()] : []), fs.createWriteStream(path.join(dir, file))];
        await require('stream').promises.pipeline(steps);
      } catch (e) {
        console.error(`照片挑選 demo: ${name} left out (${e.message})`);
        await fs.promises.rm(path.join(dir, file), { force: true });
      }
    }
  } finally { await fh.close(); }
}
// a file in pieces (Range: bytes=a-b), as browsers and Cloudflare ask for big files
function sendRanged(req, res, file, size, type, cache) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], size - 1); } else start = Math.max(0, size - +m[2]);
    if (start > end) { res.writeHead(416, { ...HEADERS, 'Content-Range': `bytes */${size}` }); return res.end(); }
    code = 206;
  }
  const head = { ...HEADERS, 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) };
  if (req.method === 'HEAD' || !size) { res.writeHead(code, head); return res.end(); }
  // a file gone or unreadable is a 404, not the server's end; a client that leaves closes the file
  const rs = fs.createReadStream(file, { start, end });
  rs.once('error', () => { if (!res.headersSent) send(res, 404, 'not found', 'text/plain; charset=utf-8'); });
  rs.once('open', () => { res.writeHead(code, head); require('stream').pipeline(rs, res, () => {}); });
}
// the demo page: the pick tool, called what it is when shared
const demoPage = (html) => html
  .replace(/<title>[^<]*<\/title>/, '<title>ZhuyuanLovePick・照片挑選（示範）</title>')
  .replace(/(<meta property="og:title" content=")[^"]*/, '$1ZhuyuanLovePick・照片挑選（示範）')
  .replace(/(<meta property="og:url" content=")[^"]*/, '$1https://tools.zhuyuan.tw/pick/demo');
function routeDemo(req, res, p) {
  if (p === '/pick/demo') return serveFile(req, res, path.join(ROOT, 'picktools', 'index.html'), '/pick/', false, demoPage), true;
  if (!p.startsWith('/pick/demo/')) return false;
  const name = p.slice('/pick/demo/'.length);
  demoPhotos().then((list) => {
    if (name === 'list.json') return send(res, 200, [...list].map(([n, x]) => ({ name: n, ...x })));
    const it = list.get(name);
    if (!it) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    sendRanged(req, res, path.join(DEMO_DIR, name), it.size, TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream', 'public, max-age=86400');
  }, () => (name === 'list.json' ? send(res, 200, []) : send(res, 404, 'not found', 'text/plain; charset=utf-8')));
  return true;
}

function serveFile(req, res, file, base, immutable, edit) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const head = { ...HEADERS, 'Content-Type': type, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (path.extname(file).toLowerCase() === '.html') {
      return fs.readFile(file, 'utf8', (e, html) => {
        if (e) return send(res, 500, 'error', 'text/plain');
        // a tool's own index.html, served at /video: point its relative paths into /video/
        if (base) html = html.replace(/<head>/i, `<head>\n<base href="${base}">`);
        if (edit) html = edit(html);
        const out = Buffer.from(versioned(html, path.dirname(file)));
        res.writeHead(200, { ...head, 'Content-Length': out.length });
        res.end(req.method === 'HEAD' ? undefined : out);
      });
    }
    res.writeHead(200, { ...head, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function route(req, res, url) {
  let p;
  try { p = decodeURIComponent(url); } catch { return send(res, 400, 'bad path', 'text/plain'); }
  for (const [re, to] of LEGACY) if (re.test(p)) return redirect(res, to);
  // the home page's 拍攝 side has its own address
  if (p === '/photo') return serveFile(req, res, path.join(ROOT, 'home', 'index.html'), null, false, photoSide);
  // 照片挑選's second window, and its demo
  if (p === '/pick/second') return serveFile(req, res, path.join(ROOT, 'picktools', 'second.html'), '/pick/');
  if (routeDemo(req, res, p)) return;
  for (const { route: r, dir, tool, immutable } of MOUNTS) {
    if (tool) {
      if (p === r) return serveFile(req, res, path.join(dir, 'index.html'), `${r}/`);
      if (p === `${r}/` || p === `${r}/index.html`) return redirect(res, r);
    }
    if (r && !p.startsWith(`${r}/`)) continue;
    const rel = p.slice(r.length);
    if (rel === '/' || rel === '') return serveFile(req, res, path.join(dir, 'index.html'));
    if (rel === '/index.html') return redirect(res, r || '/');
    const file = path.normalize(path.join(dir, rel));
    // stay inside the mount; no dotfiles
    if (!file.startsWith(dir + path.sep) || /(^|[\\/])\./.test(path.relative(dir, file))) return send(res, 404, 'not found', 'text/plain');
    return serveFile(req, res, file, null, immutable);
  }
  send(res, 404, 'not found', 'text/plain');
}

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (flickr.handle(req, res, url, send)) return;
  if (url.includes('/api/') && handleApi(req, res, url)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
  route(req, res, url);
}).listen(PORT, HOST, () => {
  console.log(`ZhuyuanTools on http://${HOST}:${PORT}/`);
  demoPhotos().then((l) => console.log(`照片挑選 demo: ${l.size} photos`), () => {});   // unpacked before anyone asks
});
