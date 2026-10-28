/* The photo tool's Flickr links, asked from here so a Flickr API key never reaches a browser.
     GET /exif/api/flickr/status            → { key: true | false }
     GET /exif/api/flickr/rest?method=…&…   → Flickr's API answer, as is (with a key; read-only public methods only)
     GET /exif/api/flickr/oembed?url=<link> → Flickr's oEmbed for one photo or album (no key needed): title, author,
                                               licence, a 1024 px picture. Flickr gives no EXIF or photo lists this way.
   The key: FLICKR_KEY, or server/data/flickr.json { "key": "<32 hex>" } (gitignored; read again when it changes, so
   no restart). Pictures don't come through here: the browser loads them from live.staticflickr.com itself.
   Answers are kept a while (Flickr allows 3,600 calls an hour per key, shared by everyone), and each visitor gets
   a fair share. Nothing is logged. FLICKR_API / FLICKR_OEMBED point elsewhere, for tests. */
'use strict';
const fs = require('fs');
const path = require('path');

const API = process.env.FLICKR_API || 'https://api.flickr.com/services/rest/';
const OEMBED = process.env.FLICKR_OEMBED || 'https://www.flickr.com/services/oembed/';
const KEY_FILE = path.join(__dirname, 'data', 'flickr.json');
const UA = 'ZhuyuanTools/1.0 (+https://tools.zhuyuan.tw/exif)';
const MIN = 60e3, HOUR = 3600e3;

let keyCache = { at: -1, key: '' };
function key() {
  if (/^[0-9a-f]{32}$/i.test(process.env.FLICKR_KEY || '')) return process.env.FLICKR_KEY;
  let st;
  try { st = fs.statSync(KEY_FILE); } catch { return ''; }
  if (st.mtimeMs !== keyCache.at) {
    let k = '';
    try { k = String(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).key || '').trim(); } catch {}
    keyCache = { at: st.mtimeMs, key: /^[0-9a-f]{32}$/i.test(k) ? k : '' };
  }
  return keyCache.key;
}

// what the page asks, and for how long an answer stays good
const METHODS = {
  'flickr.photos.getInfo': 30 * MIN, 'flickr.photos.getExif': 6 * HOUR, 'flickr.photos.getSizes': 6 * HOUR,
  'flickr.photos.licenses.getInfo': 24 * HOUR,
  'flickr.urls.lookupUser': 24 * HOUR, 'flickr.urls.lookupGallery': 24 * HOUR, 'flickr.urls.lookupGroup': 24 * HOUR,
  'flickr.people.getInfo': 6 * HOUR, 'flickr.people.getPublicPhotos': 10 * MIN,
  'flickr.photosets.getList': 10 * MIN, 'flickr.photosets.getInfo': 10 * MIN, 'flickr.photosets.getPhotos': 10 * MIN,
  'flickr.galleries.getList': 10 * MIN, 'flickr.galleries.getInfo': 10 * MIN, 'flickr.galleries.getPhotos': 10 * MIN,
  'flickr.favorites.getPublicList': 10 * MIN, 'flickr.groups.getInfo': 6 * HOUR, 'flickr.groups.pools.getPhotos': 10 * MIN,
  'flickr.collections.getTree': 30 * MIN,
};

// answers kept: "what was asked" → { at, ttl, p: Promise<{ code, body }> }
const cache = new Map();
// (a failed answer isn't kept: a typo'd album, or Flickr down for a minute, shouldn't stick)
function kept(id, ttl, make, good = (r) => r.code === 200) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < hit.ttl) { cache.delete(id); cache.set(id, hit); return hit.p; }
  const p = make();
  cache.set(id, { at: Date.now(), ttl, p });
  p.then((r) => { if (!good(r)) cache.delete(id); }, () => cache.delete(id));
  while (cache.size > 3000) cache.delete(cache.keys().next().value);
  return p;
}

// fair shares: a visitor may make 400 new calls in 10 minutes, everyone together 3,300 an hour (the key's limit is 3,600)
const recent = new Map(); // ip → [times]
const all = [];
function allowed(ip) {
  const now = Date.now();
  while (all.length && now - all[0] > HOUR) all.shift();
  const mine = (recent.get(ip) || []).filter((t) => now - t < 10 * MIN);
  if (all.length >= 3300 || mine.length >= 400) return false;
  mine.push(now); all.push(now); recent.set(ip, mine);
  if (recent.size > 5000) for (const [k, v] of recent) if (!v.length || now - v[v.length - 1] > 10 * MIN) recent.delete(k);
  return true;
}
const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');

async function ask(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    return { code: r.status, body: text };
  } catch { return { code: 502, body: JSON.stringify({ stat: 'fail', code: -1, message: 'net' }) }; }
}

function rest(q, ip) {
  const k = key();
  if (!k) return Promise.resolve({ code: 200, body: JSON.stringify({ stat: 'fail', code: 100, message: 'no key' }) });
  const method = q.get('method');
  if (!METHODS[method]) return Promise.resolve({ code: 400, body: JSON.stringify({ stat: 'fail', code: 112, message: 'not allowed' }) });
  const params = [];
  for (const [n, v] of q) {
    if (n === 'method' || !/^[a-z_]{1,32}$/.test(n) || /^(api_key|format|nojsoncallback|jsoncallback|auth_token|api_sig|oauth_\w*)$/.test(n)) continue;
    params.push([n, String(v).slice(0, 2000)]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const id = `${method}?${new URLSearchParams(params)}`;
  const hit = cache.get(id);
  if (!(hit && Date.now() - hit.at < hit.ttl) && !allowed(ip)) return Promise.resolve({ code: 429, body: JSON.stringify({ stat: 'fail', code: 429, message: 'busy' }) });
  const u = new URL(API);
  u.search = new URLSearchParams([['method', method], ['api_key', k], ['format', 'json'], ['nojsoncallback', '1'], ...params]).toString();
  // Flickr says "ok" or "fail" inside an HTTP 200
  return kept(id, METHODS[method], () => ask(u), (r) => r.code === 200 && !/"stat"\s*:\s*"fail"/.test(r.body));
}

// only links to Flickr itself go to the oEmbed service; the answer is cut down to what the page uses
const OE_HOSTS = /^(?:(?:www|m|secure)\.)?flickr\.com$|^(?:www\.)?flic\.kr$/i;
const OE_FIELDS = ['type', 'flickr_type', 'title', 'author_name', 'author_url', 'width', 'height', 'url', 'web_page', 'web_page_short_url',
  'thumbnail_url', 'thumbnail_width', 'thumbnail_height', 'license', 'license_url', 'license_id'];
function oembed(q, ip) {
  let link;
  try { link = new URL(String(q.get('url') || '').slice(0, 1000)); } catch { return Promise.resolve({ code: 400, body: '{"error":"badurl"}' }); }
  if (!/^https?:$/.test(link.protocol) || !OE_HOSTS.test(link.hostname) || link.username || link.password || link.port) return Promise.resolve({ code: 400, body: '{"error":"notflickr"}' });
  link.hash = '';
  const id = `oembed ${link.href}`;
  const hit = cache.get(id);
  if (!(hit && Date.now() - hit.at < hit.ttl) && !allowed(ip)) return Promise.resolve({ code: 429, body: '{"error":"busy"}' });
  return kept(id, HOUR, async () => {
    const u = new URL(OEMBED);
    u.search = new URLSearchParams({ format: 'json', url: link.href }).toString();
    const r = await ask(u);
    if (r.code === 404) return { code: 404, body: '{"error":"notfound"}' };
    if (r.code !== 200) return { code: 502, body: '{"error":"flickr"}' };
    let j;
    try { j = JSON.parse(r.body); } catch { return { code: 502, body: '{"error":"flickr"}' }; }
    const out = {};
    for (const f of OE_FIELDS) if (j[f] != null) out[f] = j[f];
    return { code: 200, body: JSON.stringify(out) };
  });
}

// → true when it answered
function handle(req, res, url, send) {
  if (!url.startsWith('/exif/api/flickr/')) return false;
  if (req.method !== 'GET') return send(res, 405, { error: 'method' }), true;
  const q = new URL(req.url, 'http://x').searchParams;
  const what = url.slice('/exif/api/flickr/'.length);
  if (what === 'status') return send(res, 200, { key: !!key() }), true;
  const job = what === 'rest' ? rest(q, ipOf(req)) : what === 'oembed' ? oembed(q, ipOf(req)) : null;
  if (!job) return send(res, 404, { error: 'not found' }), true;
  job.then((r) => send(res, r.code, r.body), () => send(res, 502, { error: 'flickr' }));
  return true;
}

module.exports = { handle };
