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
];

const FIELDS = { video: ['files', 'seconds', 'savedBytes'], pdf: ['files', 'pages', 'savedBytes'], avatar: ['files'], image: ['files', 'savedBytes'], crop: ['files'], watermark: ['files'], exif: ['files'], rename: ['files'], pick: ['files'] };
// Upper bounds for one report, so a single bad request can't inflate the counters much. A rename is one report for
// a whole folder, a pick the whole batch saved.
const LIMITS = { files: 50, seconds: 6 * 3600 * 50, pages: 5000, savedBytes: 200e9 };
const TOOL_LIMITS = { rename: { files: 20000 }, pick: { files: 20000 } };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.ico': 'image/x-icon',
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

function serveFile(req, res, file, base, immutable) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const head = { ...HEADERS, 'Content-Type': type, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (path.extname(file).toLowerCase() === '.html') {
      return fs.readFile(file, 'utf8', (e, html) => {
        if (e) return send(res, 500, 'error', 'text/plain');
        // a tool's own index.html, served at /video: point its relative paths into /video/
        if (base) html = html.replace(/<head>/i, `<head>\n<base href="${base}">`);
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
  if (p === '/photo') return serveFile(req, res, path.join(ROOT, 'home', 'index.html'));
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
}).listen(PORT, HOST, () => console.log(`ZhuyuanTools on http://${HOST}:${PORT}/`));
