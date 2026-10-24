/* ZhuyuanLoveAvatar — Gravatar avatars from email addresses, worked out in this browser.
   How Gravatar finds a picture: trim the address, lower-case it, hash it (SHA-256 now, MD5 on older systems),
   then ask https://gravatar.com/avatar/<hash>. Only that hash goes to Gravatar; the address never reaches us.
   On a server only a count of looked-up addresses is reported, nothing else. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    n.append(...kids.filter((x) => x != null && x !== false));
    return n;
  };
  const onServer = /^https?:$/.test(location.protocol);
  if (onServer) $('#brand').href = '/';
  const GRAVATAR = 'https://gravatar.com/avatar/';
  const PROFILE = 'https://api.gravatar.com/v3/profiles/';

  // ---------- hashes ----------
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  // MD5 isn't in Web Crypto; older Gravatar integrations still use it, so here's the plain algorithm (RFC 1321).
  const md5 = (() => {
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
    return (text) => {
      const msg = new TextEncoder().encode(text), len = msg.length;
      const words = (((len + 8) >>> 6) + 1) * 16;
      const w = new Uint32Array(words);
      for (let i = 0; i < len; i++) w[i >> 2] |= msg[i] << ((i % 4) * 8);
      w[len >> 2] |= 0x80 << ((len % 4) * 8);
      w[words - 2] = (len * 8) >>> 0;
      w[words - 1] = Math.floor(len / 0x20000000);
      let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
      for (let off = 0; off < words; off += 16) {
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
          let F, g;
          if (i < 16) { F = (B & C) | (~B & D); g = i; }
          else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
          else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * i) % 16; }
          F = (F + A + K[i] + w[off + g]) >>> 0;
          const s = S[(i >> 4) * 4 + (i % 4)];
          A = D; D = C; C = B;
          B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
      }
      return [a0, b0, c0, d0].map((x) => [0, 8, 16, 24].map((s) => ((x >>> s) & 255).toString(16).padStart(2, '0')).join('')).join('');
    };
  })();

  // ---------- options ----------
  const DEFAULTS = [
    ['mp', '預設人像'], ['identicon', '幾何圖案'], ['monsterid', '小怪獸'], ['wavatar', '臉譜'],
    ['retro', '像素'], ['robohash', '機器人'], ['blank', '透明'], ['404', '不顯示'],
  ];
  const opts = () => ({
    size: +$('input[name=size]:checked').value,
    d: ($('input[name=def]:checked') || { value: 'mp' }).value, // the picker is built a moment after load
    r: $('input[name=rating]:checked').value,
    hash: $('input[name=hash]:checked').value,
  });
  const hashOf = (e, o) => (o.hash === 'md5' ? e.md5 : e.sha);
  const urlOf = (e, o, size = o.size) => `${GRAVATAR}${hashOf(e, o)}?s=${size}&d=${encodeURIComponent(o.d)}&r=${o.r}`;

  // the default-image picker shows the real images, drawn for a sample address
  (async () => {
    const sample = await sha256('sample@tools.zhuyuan.tw');
    $('#defaults').replaceChildren(...DEFAULTS.map(([v, label], i) => el('label', { class: 'def', title: label },
      el('input', { type: 'radio', name: 'def', value: v, checked: i === 0 ? '' : null, 'aria-label': label }),
      el('span', {}, v === '404' ? el('b', { class: 'none', text: '不顯示' })
        : el('img', { src: `${GRAVATAR}${sample}?s=96&d=${v}&f=y`, alt: '', loading: 'lazy', width: 48, height: 48 })))));
    for (const n of $$('input[name=def]')) n.addEventListener('change', () => { $('#defName').textContent = DEFAULTS.find(([v]) => v === n.value)[1]; render(); });
  })();
  for (const n of $$('input[name=size], input[name=hash]')) n.addEventListener('change', render);
  // phones: the options fold into one line under the results; a summary says what's chosen
  const optsBox = $('#opts');
  if (matchMedia('(max-width: 640px)').matches) optsBox.open = false;
  function summarize() {
    const o = opts();
    $('#optsSum').textContent = `${o.size}px・${DEFAULTS.find(([v]) => v === o.d)[1]}・${o.r.toUpperCase()}・${o.hash === 'md5' ? 'MD5' : 'SHA-256'}`;
  }
  for (const n of $$('input[name=rating]')) n.addEventListener('change', () => { for (const e of list) check(e); render(); });

  // ---------- reading the addresses ----------
  const EMAIL = /[^\s@<>()[\],;:"'，；、]+@[^\s@<>()[\],;:"'，；、]+\.[^\s@<>()[\],;:"'，；、]+/g;
  let list = [];
  const known = new Map(); // normalized address → entry, so editing the text doesn't redo finished lookups
  const area = $('#emails');
  let parseTimer;
  area.addEventListener('input', () => { clearTimeout(parseTimer); parseTimer = setTimeout(parse, 250); });

  async function parse() {
    const found = [...new Set((area.value.match(EMAIL) || []).map((x) => x.trim().toLowerCase().replace(/\.+$/, '')))];
    const next = [];
    for (const email of found) {
      let e = known.get(email);
      if (!e) {
        e = { email, sha: await sha256(email), md5: md5(email), status: 'wait', profile: undefined, open: false };
        known.set(email, e);
        check(e);
      }
      next.push(e);
    }
    // one address opens by itself; with several, only the ones you open stay open
    for (const e of next) {
      if (next.length === 1) { if (!e.open) { e.open = true; e.autoOpen = true; } }
      else if (e.autoOpen) { e.open = false; e.autoOpen = false; }
    }
    list = next;
    render();
    scheduleCount();
  }

  // Does this address have its own picture? d=404 makes Gravatar answer 404 when it doesn't.
  function check(e) {
    const o = opts(), img = new Image(), token = {};
    e.token = token; e.status = 'wait';
    img.onload = () => { if (e.token !== token) return; e.status = 'yes'; loadProfile(e); render(); };
    img.onerror = () => { if (e.token !== token) return; e.status = 'no'; render(); };
    img.src = `${GRAVATAR}${e.sha}?s=80&d=404&r=${o.r}`;
  }

  // public profile (name, job, place) — Gravatar allows 100 of these an hour without a key, so only for real avatars
  let profilesLeft = 40;
  async function loadProfile(e) {
    if (e.profile !== undefined || profilesLeft <= 0) return;
    profilesLeft--;
    e.profile = null;
    try {
      const r = await fetch(PROFILE + e.sha);
      if (r.status === 429) { profilesLeft = 0; return; }
      if (r.ok) { e.profile = await r.json(); render(); }
    } catch {}
  }

  // ---------- results ----------
  const ICON = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
  };
  const downloadable = (e, o) => e.status === 'yes' || (e.status === 'no' && o.d !== '404');

  function render() {
    const o = opts();
    summarize();
    const box = $('#results');
    $('#tool').classList.toggle('has-results', list.length > 0);
    if (!list.length) {
      box.replaceChildren(el('div', { class: 'empty' },
        el('span', { class: 'ring', html: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>' }),
        el('b', { text: area.value.trim() ? '還沒看到完整的 Email' : '頭貼會出現在這裡' }),
        el('span', { text: area.value.trim() ? '格式像 name@example.com 就可以' : '輸入 Email 就會出現，一次可以放很多個' })));
    } else {
      const yes = list.filter((e) => e.status === 'yes').length, wait = list.filter((e) => e.status === 'wait').length;
      const sum = el('p', { class: 'sum' }, el('span', {}, el('b', { text: list.length }), ' 個 Email'), el('span', {}, el('b', { text: yes }), ' 個有自訂頭貼'), wait ? el('span', { text: `${wait} 個查詢中…` }) : null);
      box.replaceChildren(sum, el('ol', { class: 'list' }, ...list.map((e) => row(e, o))));
    }
    const yes = list.filter((e) => e.status === 'yes').length;
    $('#note').textContent = !list.length ? '還沒有輸入 Email。' : `${list.length} 個 Email・${yes} 個有自訂頭貼`;
    $('#copyAll').disabled = !list.length;
    $('#zipAll').disabled = !list.some((e) => downloadable(e, o));
    $('.panel-foot').classList.toggle('solo', list.length <= 1);
  }

  function thumb(e, o, size, cls) {
    if (e.status === 'wait') return el('span', { class: `${cls} none`, text: '…' });
    if (e.status === 'no' && o.d === '404') return el('span', { class: `${cls} none`, text: '沒有' });
    return el('img', { class: cls, src: urlOf(e, o, size), alt: `${e.email} 的頭貼`, width: size / 2, height: size / 2 });
  }

  function row(e, o) {
    const p = e.profile;
    const sub = e.status === 'wait' ? '查詢中…' : e.status === 'yes' ? (p && p.display_name) || '有自訂頭貼' : o.d === '404' ? '沒有自訂頭貼' : `沒有自訂頭貼，顯示${DEFAULTS.find(([v]) => v === o.d)[1]}`;
    const toggle = () => { e.open = !e.open; e.autoOpen = false; render(); };
    const main = el('div', { class: 'row-main', role: 'button', tabindex: '0', 'aria-expanded': String(e.open), onclick: toggle,
      onkeydown: (ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggle(); } } },
      thumb(e, o, 104, 'av'),
      el('span', { class: 'who' }, el('b', { text: e.email, title: e.email }), el('span', { text: sub })),
      el('span', { class: 'row-acts' },
        el('span', { class: `badge ${e.status === 'yes' ? 'yes' : e.status === 'no' ? 'no' : 'wait'}`, text: e.status === 'yes' ? '有頭貼' : e.status === 'no' ? '沒有' : '查詢中' }),
        el('button', { type: 'button', class: 'icon-btn sm', title: '複製網址', 'aria-label': `複製 ${e.email} 的頭貼網址`, html: ICON.copy,
          onclick: (ev) => { ev.stopPropagation(); copy(urlOf(e, o), '已複製頭貼網址'); } }),
        downloadable(e, o) ? el('button', { type: 'button', class: 'icon-btn sm', title: '下載', 'aria-label': `下載 ${e.email} 的頭貼`, html: ICON.down,
          onclick: (ev) => { ev.stopPropagation(); downloadOne(e); } }) : null));
    const li = el('li', { class: `row${e.open ? ' open' : ''}` }, main);
    if (e.open) li.append(detail(e, o));
    return li;
  }

  function detail(e, o) {
    const p = e.profile, url = urlOf(e, o), h = hashOf(e, o);
    const facts = el('div', { class: 'facts' });
    if (p) {
      facts.append(el('div', { class: 'prof' },
        el('b', { text: p.display_name || e.email }),
        [p.job_title, p.company].filter(Boolean).length ? el('span', { text: [p.job_title, p.company].filter(Boolean).join('・') }) : null,
        p.location ? el('span', { text: p.location }) : null,
        p.profile_url ? el('a', { href: p.profile_url, target: '_blank', rel: 'noopener', text: 'Gravatar 個人頁面 ↗' }) : null));
    }
    // how the address became a picture
    facts.append(el('dl', { class: 'steps' },
      el('dt', { text: '整理後' }), el('dd', { text: e.email, title: e.email }),
      el('dt', { text: o.hash === 'md5' ? 'MD5' : 'SHA-256' }), el('dd', { text: h, title: h }),
      el('dt', { text: '網址' }), el('dd', { text: url, title: url })));
    const html = `<img src="${url}" width="${o.size}" height="${o.size}" alt="頭貼">`;
    const copies = el('div', { class: 'copies' },
      el('button', { type: 'button', class: 'btn', text: '複製網址', onclick: () => copy(url, '已複製頭貼網址') }),
      el('button', { type: 'button', class: 'btn', text: '複製雜湊', onclick: () => copy(h, `已複製 ${o.hash === 'md5' ? 'MD5' : 'SHA-256'} 雜湊`) }),
      el('button', { type: 'button', class: 'btn', text: '複製 HTML', onclick: () => copy(html, '已複製 HTML') }),
      el('button', { type: 'button', class: 'btn', text: '複製 Markdown', onclick: () => copy(`![頭貼](${url})`, '已複製 Markdown') }),
      downloadable(e, o) ? el('button', { type: 'button', class: 'btn primary', text: `下載 ${o.size}px`, onclick: () => downloadOne(e) }) : null);
    return el('div', { class: 'row-detail' }, thumb(e, o, Math.min(320, o.size * 2), 'big'), facts, copies);
  }

  // ---------- copy, download, zip ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); }
    catch {
      const t = el('textarea', { style: 'position:fixed;opacity:0' }); t.value = text; document.body.append(t); t.select();
      try { document.execCommand('copy'); toast(msg); } catch { toast('瀏覽器不讓複製，請手動選取'); }
      t.remove();
    }
  }
  const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, '_');
  const extOf = (type) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type] || 'png');
  function save(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  async function fetchImage(e, o) {
    const r = await fetch(urlOf(e, o));
    if (!r.ok) throw new Error(String(r.status));
    return r.blob();
  }
  async function downloadOne(e) {
    const o = opts();
    try { const b = await fetchImage(e, o); save(b, `${safeName(e.email)}.${extOf(b.type)}`); }
    catch { toast('下載失敗，請稍後再試'); }
  }

  $('#copyAll').addEventListener('click', () => {
    const o = opts();
    copy(list.map((e) => `${e.email}\t${urlOf(e, o)}`).join('\n'), `已複製 ${list.length} 行，可以直接貼到試算表`);
  });

  $('#zipAll').addEventListener('click', async () => {
    const o = opts(), todo = list.filter((e) => downloadable(e, o));
    const btn = $('#zipAll'), label = btn.textContent;
    btn.disabled = true;
    const files = [];
    let failed = 0;
    for (let i = 0; i < todo.length; i++) {
      btn.textContent = `打包中 ${i + 1} / ${todo.length}`;
      try { const b = await fetchImage(todo[i], o); files.push({ name: `${safeName(todo[i].email)}.${extOf(b.type)}`, data: new Uint8Array(await b.arrayBuffer()) }); }
      catch { failed++; }
    }
    btn.textContent = label; btn.disabled = false;
    if (!files.length) { toast('下載失敗，請稍後再試'); return; }
    save(ManyZip.make(files), `gravatar-${files.length}.zip`);
    toast(failed ? `已打包 ${files.length} 張，${failed} 張沒抓到` : `已打包 ${files.length} 張頭貼`);
  });

  // ---------- the counter ----------
  // Only a number leaves the browser: how many new addresses were looked up, never the addresses or hashes.
  const counted = new Set();
  let countTimer;
  function scheduleCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      const fresh = list.filter((e) => e.status !== 'wait' && !counted.has(e.email));
      if (!fresh.length) { if (list.some((e) => e.status === 'wait')) scheduleCount(); return; }
      for (const e of fresh) counted.add(e.email);
      if (!onServer) return;
      fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: fresh.length }), keepalive: true })
        .then(loadStats).catch(() => {});
    }, 1800);
  }
  async function loadStats() {
    if (!onServer) return;
    try {
      const r = await fetch('api/stats', { cache: 'no-store' });
      const st = r.ok ? await r.json() : null;
      if (st && st.files > 0) $('#heroCount').replaceChildren('已幫大家查了 ', el('b', { class: 'hero-num', text: st.files.toLocaleString('zh-TW') }), ' 個頭貼');
    } catch {}
  }
  loadStats();
  render();
})();
