#!/usr/bin/env node
/* ManyTools static server + the public counters. No dependencies: `node server/server.js`.
   Serves the repo root, and keeps only totals (files, seconds/pages, bytes saved) per tool — never file content.
     GET  /api/stats                          → { video: {...}, pdf: {...} }   (home page)
     GET  /videotools/api/stats               → video totals
     POST /videotools/api/stats/processed     ← { files, seconds, savedBytes }
     GET  /pdftools/local/api/stats           → pdf totals   (same shape the PDF tool already expects)
     POST /pdftools/local/api/stats/processed ← { files, pages, savedBytes }
   Env: PORT (default 8080), HOST (default 127.0.0.1), STATS_FILE (default server/data/stats.json). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'data', 'stats.json');
const TOOLS = { '/videotools': 'video', '/pdftools/local': 'pdf' };
const FIELDS = { video: ['files', 'seconds', 'savedBytes'], pdf: ['files', 'pages', 'savedBytes'] };
// Upper bounds for one report, so a single bad request can't inflate the counters much.
const LIMITS = { files: 50, seconds: 6 * 3600 * 50, pages: 5000, savedBytes: 200e9 };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

let stats = { video: {}, pdf: {} };
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

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function handleApi(req, res, url) {
  if (url === '/api/stats' && req.method === 'GET') return send(res, 200, stats), true;
  for (const [prefix, tool] of Object.entries(TOOLS)) {
    if (url === `${prefix}/api/stats` && req.method === 'GET') return send(res, 200, stats[tool]), true;
    if (url === `${prefix}/api/stats/processed` && req.method === 'POST') {
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
  if (/\/api\/ads\/event$/.test(url) && req.method === 'POST') return send(res, 204, ''), true;
  return false;
}

function serveFile(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url); } catch { return send(res, 400, 'bad path', 'text/plain'); }
  let file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return send(res, 403, 'forbidden', 'text/plain');
  // never serve the counters file or dotfiles
  if (file.startsWith(path.join(__dirname, 'data')) || /(^|[\\/])\./.test(path.relative(ROOT, file))) return send(res, 404, 'not found', 'text/plain');
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!url.endsWith('/')) { res.writeHead(301, { Location: url + '/' }); return res.end(); }
      file = path.join(file, 'index.html');
    }
    fs.stat(file, (err2, st2) => {
      if (err2 || !st2.isFile()) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st2.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
}

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url.includes('/api/') && handleApi(req, res, url)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
  serveFile(req, res, url);
}).listen(PORT, HOST, () => console.log(`ManyTools on http://${HOST}:${PORT}/`));
