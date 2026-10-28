/* ZhuyuanLoveExif's Flickr links. A link in (a photo, an album, someone's albums or galleries, a gallery, a
   photostream, favourites, a group's pool, a collection), what it holds out; for each photo what Flickr knows: its EXIF
   (Flickr read it from the original at upload), title, author, licence, place, views.
   Asked through this site's server (server/flickr.js), which holds the Flickr API key: a key in a page would be
   anyone's. The pictures themselves come straight from Flickr (live.staticflickr.com) to this browser.
   Without a key the server can still ask Flickr's oEmbed: for one photo its title, author, licence and a 1024 px
   picture — no EXIF, no lists ('basic'). Opened from disk, no Flickr at all.
   ZFlickr.ready → Promise<'full' | 'basic' | false>
   ZFlickr.get({ url }) → { view: 'photo', photo } | a photos page | a sets page
   ZFlickr.get({ list: kind, id, page }) → a photos page: { view: 'photos', kind, id, title, owner, link, description,
                                                            total, page, pages, photos: [photo] }
   ZFlickr.get({ sets: 'albums' | 'galleries', user, page }) → { view: 'sets', …, sets: [{ kind, id, title, count, cover }] }
   ZFlickr.get({ photo: id, secret, sizes }) → one photo, all of it (exif: [{ g, t, l, r }], exifHidden, exifNoKey…)
   Errors are Error(code): nokey, needkey, badurl, notflickr, short, unknown, notfound, private, busy, flickr, net. */
(() => {
  'use strict';
  const API = 'api/flickr/rest';
  const PER_PAGE = 500; // the most Flickr lists in one call
  const SIZES = ['sq', 'q', 't', 's', 'n', 'w', 'm', 'z', 'c', 'l', 'h', 'k', '3k', '4k', '5k', '6k', 'o'];
  const LIST_SIZES = ['q', 'n', 'z', 'c', 'l', 'h', 'k', '3k', '4k', '5k', '6k', 'o'];
  const EXTRAS = [...LIST_SIZES.map((s) => `url_${s}`), 'o_dims', 'media', 'date_taken', 'owner_name', 'path_alias', 'license', 'views'].join(',');
  const HOUR = 3600e3;
  void SIZES;

  let mode = false;
  const ready = !/^https?:$/.test(location.protocol) ? Promise.resolve(false) : fetch('api/flickr/status', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (mode = j ? (j.key ? 'full' : 'basic') : false))
    .catch(() => false);

  // ---------- calls, kept for the visit ----------
  class FlickrError extends Error {
    constructor(code, flickr = 0) { super(code); this.code = code; this.flickr = flickr; }
  }
  const cache = new Map(); // "method?params" → { at, ttl, p }
  function call(method, params = {}, ttl = 30 * 60e3) {
    if (mode !== 'full') return Promise.reject(new FlickrError('nokey'));
    const id = `${method}?${new URLSearchParams(Object.entries(params).sort()).toString()}`;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.p;
    const p = fetch(`${API}?${new URLSearchParams({ method, ...params })}`)
      .then(async (r) => {
        let j = null;
        try { j = await r.json(); } catch {}
        if (r.status === 429) throw new FlickrError('busy');
        if (!j) throw new FlickrError('flickr');
        if (j.stat !== 'ok') throw new FlickrError(j.code === 100 ? 'nokey' : 'api', j.code);
        return j;
      }, () => { throw new FlickrError('net'); });
    cache.set(id, { at: Date.now(), ttl, p });
    p.catch(() => cache.delete(id));
    if (cache.size > 1500) { const now = Date.now(); for (const [k, v] of cache) if (now - v.at > v.ttl || cache.size > 1000) cache.delete(k); }
    return p;
  }

  // ---------- links ----------
  const B58 = '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  function base58(s) {
    let n = 0n;
    for (const c of String(s)) {
      const i = B58.indexOf(c);
      if (i < 0) return '';
      n = n * 58n + BigInt(i);
    }
    return n > 0n ? n.toString() : '';
  }
  function short(id) {
    let n = BigInt(id), s = '';
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    return `https://flic.kr/p/${s}`;
  }
  const userUrl = (user) => `https://www.flickr.com/photos/${user}/`;
  // a link → what it points at: { kind, … } or { error }
  function parse(input) {
    let s = String(input || '').trim();
    const found = s.match(/https?:\/\/[^\s<>"'，。、）)]+/i) || s.match(/(?:www\.|m\.)?(?:flickr\.com|flic\.kr|(?:live|farm\d+)\.staticflickr\.com)\/[^\s<>"'，。、）)]*/i);
    if (found) s = found[0];
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    let u, seg;
    try { u = new URL(s); seg = u.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x)); } catch { return { error: 'badurl' }; }
    const host = u.hostname.toLowerCase();
    // the picture's own address: live.staticflickr.com/65535/53212345678_1a2b3c4d5e_b.jpg
    if (/(^|\.)staticflickr\.com$/.test(host)) {
      const m = (seg[seg.length - 1] || '').match(/^(\d+)_([0-9a-f]+)(?:_\w+)?\.\w+$/i);
      return m ? { kind: 'photo', id: m[1], secret: m[2] } : { error: 'badurl' };
    }
    if (host === 'flic.kr' || host === 'www.flic.kr') {
      if (seg[0] === 'p' && seg[1]) { const id = base58(seg[1]); return id ? { kind: 'photo', id } : { error: 'badurl' }; }
      if (seg[0] === 's' && seg[1]) { const id = base58(seg[1]); return id ? { kind: 'album', id } : { error: 'badurl' }; }
      return { error: 'short' };
    }
    if (!/(^|\.)flickr\.com$/.test(host)) return { error: 'notflickr' };
    const q = u.searchParams;
    if (seg[0] === 'photo.gne') {
      if (/^\d+$/.test(q.get('id') || '')) return { kind: 'photo', id: q.get('id') };
      const id = base58(q.get('short') || '');
      return id ? { kind: 'photo', id } : { error: 'badurl' };
    }
    if (seg[0] === 'short_urls.gne' && q.get('photoset')) { const id = base58(q.get('photoset')); return id ? { kind: 'album', id } : { error: 'badurl' }; }
    if (seg[0] === 'photos' && seg[1]) {
      const user = seg[1], what = (seg[2] || '').toLowerCase();
      if (/^\d+$/.test(what)) {
        // a photo seen in an album: the album, opened at that photo
        const inAlbum = seg[3] === 'in' && (seg[4] || '').match(/^(?:album|set)-(\d+)$/);
        return inAlbum ? { kind: 'album', id: inAlbum[1], focus: what } : { kind: 'photo', id: what };
      }
      if (what === 'albums' || what === 'sets') return /^\d+$/.test(seg[3] || '') ? { kind: 'album', id: seg[3], focus: seg[4] === 'with' && /^\d+$/.test(seg[5] || '') ? seg[5] : '' } : { kind: 'albums', user };
      if (what === 'galleries') return seg[3] && /^\d+$/.test(seg[3]) ? { kind: 'gallery', url: `${userUrl(user)}galleries/${seg[3]}/` } : { kind: 'galleries', user };
      if (what === 'collections') return /^\d+$/.test(seg[3] || '') ? { kind: 'collection', user, id: seg[3] } : { kind: 'albums', user };
      if (what === 'favorites') return { kind: 'faves', user };
      if (!what || /^page\d+$/.test(what) || what === 'with') return { kind: 'stream', user };
      return { error: 'unknown' };
    }
    if (seg[0] === 'people' && seg[1]) return { kind: 'stream', user: seg[1] };
    if (seg[0] === 'groups' && seg[1]) return { kind: 'group', url: `https://www.flickr.com/groups/${seg[1]}/` };
    return { error: 'unknown' };
  }

  // ---------- shapes for the page ----------
  const text = (x) => String((x && typeof x === 'object' ? x._content : x) || '');
  // Flickr's descriptions are HTML: plain text
  const plain = (html) => text(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|#039|apos|nbsp);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#039': "'", apos: "'", nbsp: ' ' }[e]))
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(+d); } catch { return ''; } }).replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  const staticUrl = (server, id, secret, size) => `https://live.staticflickr.com/${server}/${id}_${secret}_${size}.jpg`;

  let licenses = null;
  async function licenseMap() {
    if (licenses) return licenses;
    try {
      const r = await call('flickr.photos.licenses.getInfo', {}, 24 * HOUR);
      licenses = new Map(r.licenses.license.map((l) => [String(l.id), { id: String(l.id), name: l.name, url: l.url || '', short: shortLicense(l) }]));
    } catch { return new Map(); }
    return licenses;
  }
  // "CC BY 4.0", "CC0", "公眾領域"… from the licence's address
  function shortLicense(l) {
    const u = String(l.url || '');
    let m = u.match(/creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/);
    if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
    if (/publicdomain\/zero/.test(u)) return 'CC0';
    if (/publicdomain\/mark/.test(u)) return '公眾領域';
    if (/commons\/usage/.test(u)) return '沒有已知的版權限制';
    if (/usa\.gov/.test(u)) return '美國政府著作';
    if (String(l.id) === '0' || /all rights reserved/i.test(l.name)) return '保留所有權利';
    return l.name;
  }

  // a listed photo (an album's, a gallery's, a stream's), with the sizes the extras brought
  function listed(p, lic, ownerName) {
    const sizes = [];
    for (const s of LIST_SIZES) {
      const src = p[`url_${s}`];
      if (src) sizes.push({ s, w: +p[`width_${s}`] || 0, h: +p[`height_${s}`] || 0, src });
    }
    const l = lic.get(String(p.license));
    return {
      id: String(p.id), secret: p.secret, title: text(p.title).trim(), media: p.media || 'photo',
      owner: p.ownername || ownerName || '', ownerId: p.owner || '', taken: p.datetaken || '', views: +p.views || 0,
      license: l ? l.short : '', thumb: p.url_q || staticUrl(p.server, p.id, p.secret, 'q'), sizes,
    };
  }
  const pagesOf = (o) => ({ page: +o.page || 1, pages: +o.pages || 1, total: +o.total || 0 });

  // ---------- photos pages ----------
  async function lookupUser(user) {
    if (/^\d+@N\d\d$/.test(user)) {
      const r = await call('flickr.people.getInfo', { user_id: user }, 6 * HOUR);
      return { id: user, name: text(r.person.realname) || text(r.person.username), alias: r.person.path_alias || user };
    }
    const r = await call('flickr.urls.lookupUser', { url: userUrl(user) }, 6 * HOUR);
    return { id: r.user.id, name: text(r.user.username), alias: user };
  }
  async function photosPage(kind, id, page = 1, extra = {}) {
    const lic = await licenseMap();
    const base = { extras: EXTRAS, per_page: String(PER_PAGE), page: String(page) };
    const out = { view: 'photos', kind, id, title: '', owner: { name: '', url: '' }, link: '', description: '', views: 0 };
    let list, pg;
    if (kind === 'album') {
      const [info, r] = await Promise.all([
        call('flickr.photosets.getInfo', { photoset_id: id }, 10 * 60e3).catch(() => null),
        call('flickr.photosets.getPhotos', { photoset_id: id, ...base }, 10 * 60e3),
      ]);
      const set = r.photoset;
      const alias = (set.photo[0] && set.photo[0].pathalias) || set.owner;
      out.title = text(set.title).trim();
      out.owner = { name: set.ownername || (info && text(info.photoset.username)) || '', url: userUrl(alias), id: set.owner };
      out.link = `${userUrl(alias)}albums/${set.id}/`;
      if (info) { out.description = plain(info.photoset.description); out.views = +info.photoset.count_views || 0; }
      list = set.photo.map((p) => listed(p, lic, out.owner.name));
      pg = pagesOf(set);
    } else if (kind === 'gallery') {
      const [info, r] = await Promise.all([
        call('flickr.galleries.getInfo', { gallery_id: id }, 10 * 60e3),
        call('flickr.galleries.getPhotos', { gallery_id: id, ...base }, 10 * 60e3),
      ]);
      const g = info.gallery;
      out.title = text(g.title).trim();
      out.owner = { name: g.username || '', url: userUrl(g.owner), id: g.owner };
      out.link = g.url || '';
      out.description = plain(g.description);
      out.views = +g.count_views || 0;
      list = r.photos.photo.map((p) => listed(p, lic));
      pg = pagesOf(r.photos);
    } else if (kind === 'stream' || kind === 'faves') {
      const u = await lookupUser(id);
      const r = kind === 'stream'
        ? await call('flickr.people.getPublicPhotos', { user_id: u.id, ...base }, 5 * 60e3)
        : await call('flickr.favorites.getPublicList', { user_id: u.id, ...base }, 5 * 60e3);
      out.id = u.id;
      out.title = kind === 'stream' ? `${u.name} 的照片` : `${u.name} 的最愛`;
      out.owner = { name: u.name, url: userUrl(u.alias), id: u.id };
      out.link = kind === 'stream' ? userUrl(u.alias) : `${userUrl(u.alias)}favorites/`;
      list = r.photos.photo.map((p) => listed(p, lic, kind === 'stream' ? u.name : ''));
      pg = pagesOf(r.photos);
    } else if (kind === 'group') {
      const [info, r] = await Promise.all([
        call('flickr.groups.getInfo', { group_id: id }, HOUR).catch(() => null),
        call('flickr.groups.pools.getPhotos', { group_id: id, ...base }, 5 * 60e3),
      ]);
      out.title = info ? text(info.group.name) : '群組';
      out.owner = { name: '', url: '' };
      out.link = `https://www.flickr.com/groups/${(info && info.group.path_alias) || id}/pool/`;
      if (info) out.description = plain(info.group.description);
      list = r.photos.photo.map((p) => listed(p, lic));
      pg = pagesOf(r.photos);
    } else throw new FlickrError('badurl');
    return { ...out, ...pg, ...extra, photos: list.filter((p) => p.media !== 'video'), videos: list.filter((p) => p.media === 'video').length };
  }

  // ---------- sets pages: someone's albums or galleries ----------
  async function setsPage(kind, user, page = 1, only = null) {
    const u = await lookupUser(user);
    const out = { view: 'sets', kind, user: u.id, title: kind === 'galleries' ? `${u.name} 的藝廊` : `${u.name} 的相簿`, owner: { name: u.name, url: userUrl(u.alias), id: u.id } };
    if (kind === 'galleries') {
      const r = await call('flickr.galleries.getList', { user_id: u.id, per_page: String(PER_PAGE), page: String(page), primary_photo_extras: 'url_q,url_n' }, 10 * 60e3);
      const g = r.galleries;
      return {
        ...out, link: `${userUrl(u.alias)}galleries/`, ...pagesOf(g),
        sets: (g.gallery || []).map((x) => ({
          kind: 'gallery', id: x.id, title: text(x.title).trim(), count: (+x.count_photos || 0), description: plain(x.description), link: x.url,
          cover: (x.primary_photo_extras && (x.primary_photo_extras.url_n || x.primary_photo_extras.url_q)) || (x.primary_photo_id ? staticUrl(x.primary_photo_server, x.primary_photo_id, x.primary_photo_secret, 'n') : ''),
          updated: +x.date_update || +x.date_create || 0,
        })),
      };
    }
    const r = await call('flickr.photosets.getList', { user_id: u.id, per_page: String(PER_PAGE), page: String(page), primary_photo_extras: 'url_q,url_n' }, 10 * 60e3);
    const s = r.photosets;
    let sets = (s.photoset || []).map((x) => ({
      kind: 'album', id: String(x.id), title: text(x.title).trim(), count: (+x.photos || 0), description: plain(x.description), link: `${userUrl(u.alias)}albums/${x.id}/`,
      cover: (x.primary_photo_extras && (x.primary_photo_extras.url_n || x.primary_photo_extras.url_q)) || staticUrl(x.server, x.primary, x.secret, 'n'),
      updated: +x.date_update || +x.date_create || 0, views: +x.count_views || 0,
    }));
    let pg = pagesOf(s);
    if (only) { const at = new Map(only.ids.map((id, i) => [id, i])); sets = sets.filter((x) => at.has(x.id)).sort((a, b) => at.get(a.id) - at.get(b.id)); pg = { page: 1, pages: 1, total: sets.length }; }
    return { ...out, link: `${userUrl(u.alias)}albums/`, ...pg, sets, ...(only ? { title: only.title, link: only.link, description: only.description } : {}) };
  }
  async function collection(user, id) {
    const u = await lookupUser(user);
    const r = await call('flickr.collections.getTree', { collection_id: id, user_id: u.id }, 10 * 60e3);
    const c = (r.collections.collection || [])[0];
    if (!c) throw new FlickrError('api', 1);
    const ids = [];
    const walk = (x) => { for (const s of x.set || []) ids.push(String(s.id)); for (const k of x.collection || []) walk(k); };
    walk(c);
    return setsPage('albums', user, 1, { ids, title: text(c.title), link: `${userUrl(u.alias)}collections/${id}/`, description: plain(c.description) });
  }

  // ---------- without a key: Flickr's oEmbed, one photo at a time ----------
  async function oembed(id) {
    const id2 = `oembed ${id}`;
    const hit = cache.get(id2);
    if (hit) return hit.p;
    const p = fetch(`api/flickr/oembed?url=${encodeURIComponent(short(id))}`)
      .then(async (r) => {
        if (r.status === 429) throw new FlickrError('busy');
        if (r.status === 404) throw new FlickrError('api', 1);
        const j = r.ok ? await r.json().catch(() => null) : null;
        if (!j || !j.url) throw new FlickrError('flickr');
        return j;
      }, () => { throw new FlickrError('net'); });
    cache.set(id2, { at: Date.now(), ttl: HOUR, p });
    p.catch(() => cache.delete(id2));
    return p;
  }
  // its picture (1024 px) and thumbnail share one secret; the bigger sizes have their own, which oEmbed doesn't tell
  function fromOembed(o, id) {
    const m = String(o.url).match(/\/(\d+)_([0-9a-f]+)(?:_[a-z0-9]+)?\.\w+$/i) || [];
    const lic = o.license ? { id: String(o.license_id == null ? '' : o.license_id), name: o.license, url: o.license_url || '' } : null;
    if (lic) lic.short = shortLicense(lic);
    return {
      id: String(id), secret: m[2] || '', title: String(o.title || '').trim(), description: '',
      owner: { name: o.author_name || '', username: '', id: '', url: o.author_url || '' },
      page: o.web_page || '', short: short(id), posted: 0, taken: '', views: 0, comments: 0, format: '',
      media: o.type === 'video' ? 'video' : 'photo', license: lic, tags: [], location: null, canDownload: false,
      exif: [], exifHidden: false, exifNoKey: true, camera: '', thumb: o.thumbnail_url || '',
      sizes: [
        o.thumbnail_url ? { s: 'q', w: +o.thumbnail_width || 150, h: +o.thumbnail_height || 150, src: o.thumbnail_url } : null,
        { s: 'l', w: +o.width || 0, h: +o.height || 0, src: o.url },
      ].filter(Boolean),
    };
  }

  // ---------- what a link holds ----------
  async function resolve(link) {
    const w = parse(link);
    if (w.error) throw new FlickrError(w.error);
    if (mode === 'basic') {
      // a photo seen in an album (…/in/album-…, …/albums/…/with/…) is still that one photo
      const id = w.kind === 'photo' ? w.id : w.kind === 'album' && w.focus ? w.focus : '';
      if (!id) throw new FlickrError('needkey');
      return { view: 'photo', photo: fromOembed(await oembed(id), id) };
    }
    switch (w.kind) {
      case 'photo': {
        const p = (await call('flickr.photos.getInfo', w.secret ? { photo_id: w.id, secret: w.secret } : { photo_id: w.id })).photo;
        const o = p.owner || {};
        const lic = (await licenseMap()).get(String(p.license));
        return {
          view: 'photo',
          photo: { id: String(p.id), secret: p.secret, title: text(p.title).trim(), media: p.media || 'photo', owner: o.realname || o.username || '', ownerId: o.nsid || '', taken: (p.dates && p.dates.taken) || '', views: +p.views || 0, license: lic ? lic.short : '', thumb: staticUrl(p.server, p.id, p.secret, 'q'), sizes: [] },
        };
      }
      case 'album': return photosPage('album', w.id, 1, w.focus ? { focus: w.focus } : {});
      case 'gallery': {
        const g = (await call('flickr.urls.lookupGallery', { url: w.url }, 6 * HOUR)).gallery;
        return photosPage('gallery', g.id);
      }
      case 'group': {
        const g = (await call('flickr.urls.lookupGroup', { url: w.url }, 6 * HOUR)).group;
        return photosPage('group', g.id);
      }
      case 'stream': case 'faves': return photosPage(w.kind, w.user);
      case 'albums': case 'galleries': return setsPage(w.kind, w.user);
      case 'collection': return collection(w.user, w.id);
      default: throw new FlickrError('unknown');
    }
  }

  // ---------- one photo, all of it ----------
  const SIZE_OF_LABEL = {
    Square: 'sq', 'Large Square': 'q', Thumbnail: 't', Small: 's', 'Small 320': 'n', 'Small 400': 'w', Medium: 'm', 'Medium 640': 'z',
    'Medium 800': 'c', Large: 'l', 'Large 1600': 'h', 'Large 2048': 'k', 'X-Large 3K': '3k', 'X-Large 4K': '4k', 'X-Large 5K': '5k', 'X-Large 6K': '6k', Original: 'o',
  };
  async function photo(id, secret, withSizes) {
    if (mode === 'basic') return fromOembed(await oembed(id), id);
    const base = secret ? { photo_id: id, secret } : { photo_id: id };
    const [info, exif, sizes] = await Promise.allSettled([
      call('flickr.photos.getInfo', base),
      call('flickr.photos.getExif', base),
      withSizes ? call('flickr.photos.getSizes', { photo_id: id }) : Promise.resolve(null),
    ]);
    if (info.status !== 'fulfilled') throw info.reason;
    const p = info.value.photo;
    const o = p.owner || {};
    const loc = p.location;
    const lic = (await licenseMap()).get(String(p.license)) || null;
    const out = {
      id: String(p.id), secret: p.secret, title: text(p.title).trim(), description: plain(p.description),
      owner: { name: o.realname || o.username || '', username: o.username || '', id: o.nsid || '', url: userUrl(o.path_alias || o.nsid) },
      page: ((p.urls && p.urls.url) || []).map((x) => x._content).find(Boolean) || `${userUrl(o.path_alias || o.nsid)}${p.id}/`, short: short(p.id),
      posted: +(p.dates && p.dates.posted) || 0, taken: (p.dates && +p.dates.takenunknown !== 1 && p.dates.taken) || '',
      views: +p.views || 0, comments: +(p.comments && text(p.comments)) || 0, format: p.originalformat || '', media: p.media || 'photo',
      license: lic, tags: (p.tags && p.tags.tag ? p.tags.tag.map((t) => t.raw || text(t)).filter(Boolean) : []).slice(0, 40),
      location: loc && loc.latitude ? { lat: +loc.latitude, lon: +loc.longitude, accuracy: +loc.accuracy || 0, place: [...new Set(['locality', 'county', 'region', 'country'].map((k) => text(loc[k])).filter(Boolean))].join('・') } : null,
      canDownload: !!(p.usage && +p.usage.candownload === 1),
      exif: [], exifHidden: false, camera: '', sizes: null,
    };
    if (exif.status === 'fulfilled') {
      const ph = exif.value.photo;
      out.camera = ph.camera || '';
      out.exif = (ph.exif || []).map((e) => ({ g: e.tagspace, t: String(e.tag), l: e.label, r: text(e.raw), c: text(e.clean) }));
    } else if (exif.reason && exif.reason.flickr === 2) out.exifHidden = true;
    if (sizes.status === 'fulfilled' && sizes.value) {
      out.sizes = (sizes.value.sizes.size || []).filter((s) => s.media !== 'video' && SIZE_OF_LABEL[s.label])
        .map((s) => ({ s: SIZE_OF_LABEL[s.label], w: +s.width || 0, h: +s.height || 0, src: s.source }));
    }
    return out;
  }

  // ---------- what the page asks ----------
  const KINDS = new Set(['album', 'gallery', 'stream', 'faves', 'group']);
  async function get(q) {
    if (!(await ready)) throw new Error('nokey');
    const page = Math.max(1, Math.min(200, parseInt(q.page, 10) || 1));
    let job;
    if (q.url != null) job = () => resolve(String(q.url).slice(0, 2000));
    else if (KINDS.has(q.list) && /^[\w@-]{1,80}$/.test(q.id || '')) job = () => photosPage(q.list, q.id, page);
    else if (/^(albums|galleries)$/.test(q.sets || '') && /^[\w@-]{1,80}$/.test(q.user || '')) job = () => setsPage(q.sets, q.user, page);
    else if (/^\d{1,20}$/.test(q.photo || '')) job = () => photo(q.photo, /^[0-9a-f]{1,32}$/i.test(q.secret || '') ? q.secret : '', q.sizes !== '0');
    else throw new Error('badurl');
    try { return await job(); } catch (e) {
      if (!(e instanceof FlickrError)) { console.error('flickr:', e); throw new Error('flickr'); }
      // Flickr's own codes: 1 not found (photo, album, user…), 2 not allowed
      throw new Error(e.code === 'api' ? (e.flickr === 1 ? 'notfound' : e.flickr === 2 ? 'private' : 'flickr') : e.code);
    }
  }

  self.ZFlickr = { ready, get, parse };
})();
