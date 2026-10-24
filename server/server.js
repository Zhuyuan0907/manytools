#!/usr/bin/env node
/* ZhuyuanTools static server + the public counters. No dependencies: `node server/server.js`.
   Clean URLs, each tool still in its own folder:
     /       → home/            /video → videotools/            /pdf → pdftools/local/     /avatar → avatartools/     /image → imagetools/     /fonts → fonts/     /shared → shared/
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
   Env: PORT (default 8080), HOST (default 127.0.0.1), STATS_FILE (default server/data/stats.json). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'data', 'stats.json');

// route → folder. The root mount must stay last. /fonts is shared by every page and never changes.
const MOUNTS = [
  { route: '/video', dir: path.join(ROOT, 'videotools'), tool: 'video' },
  { route: '/pdf', dir: path.join(ROOT, 'pdftools', 'local'), tool: 'pdf' },
  { route: '/avatar', dir: path.join(ROOT, 'avatartools'), tool: 'avatar' },
  { route: '/image', dir: path.join(ROOT, 'imagetools'), tool: 'image' },
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
];

const FIELDS = { video: ['files', 'seconds', 'savedBytes'], pdf: ['files', 'pages', 'savedBytes'], avatar: ['files'], image: ['files', 'savedBytes'] };
// Upper bounds for one report, so a single bad request can't inflate the counters much.
const LIMITS = { files: 50, seconds: 6 * 3600 * 50, pages: 5000, savedBytes: 200e9 };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

let stats = { video: {}, pdf: {}, avatar: {}, image: {} };
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
          if (Number.isFinite(v) && v > 0) stats[tool][f] += Math.min(v, LIMITS[f]);
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

function serveFile(req, res, file, base, immutable) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const head = { ...HEADERS, 'Content-Type': type, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (base) {
      // the tool's own index.html, served at /video: point its relative paths into /video/
      return fs.readFile(file, 'utf8', (e, html) => {
        if (e) return send(res, 500, 'error', 'text/plain');
        const out = Buffer.from(html.replace(/<head>/i, `<head>\n<base href="${base}">`));
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
  if (url.includes('/api/') && handleApi(req, res, url)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
  route(req, res, url);
}).listen(PORT, HOST, () => console.log(`ZhuyuanTools on http://${HOST}:${PORT}/`));
