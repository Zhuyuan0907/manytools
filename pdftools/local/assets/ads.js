/* Sponsor slot shown while PDFs are being processed. Ads come from ads.json (see ads/README.md);
   with two or more active ads they rotate. Only anonymous impression/click counts go to the server. */
(() => {
  'use strict';
  const { el } = Core;
  const onServer = /^https?:$/.test(location.protocol);

  // Used when ads.json cannot be read (for example the offline copy opened as a file).
  const DEFAULT = {
    rotateSeconds: 8,
    ads: [{
      id: 'atomroute', active: true, weight: 1, sponsor: 'AtomRoute Global Network',
      banner: { wide: 'ads/atomroute/banner-wide.png', narrow: 'ads/atomroute/banner-mid.png', alt: 'AtomRoute Global Network：網路・雲端・主機・機房' },
      logo: 'ads/atomroute/logo.png', icon: 'ads/atomroute/mark.png',
      partner: { text: '由 AtomRoute Global Network (US) LLC 提供' },
      cta: '前往官網', url: 'https://www.atomroute.com/',
      theme: { bg: '#f2f0ff', fg: '#1f1846', accent: '#7d70e5', accent2: '#9a8ff0' },
    }],
  };

  const today = new Date().toISOString().slice(0, 10);
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
  const safePath = (p) => (typeof p === 'string' && /^[\w./-]+$/.test(p) && !p.includes('..') ? p : null);
  const color = (c, d) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : d);

  function usable(ad) {
    if (!ad || ad.active !== true || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(ad.id || '') || !safeUrl(ad.url)) return false;
    if (!ad.headline && !(ad.banner && safePath(ad.banner.wide))) return false;
    if (ad.start && today < ad.start) return false;
    if (ad.end && today > ad.end) return false;
    return true;
  }
  // Weighted order: heavier ads tend to come first; the rest follow.
  function order(ads) {
    return ads.map((a) => ({ a, k: Math.random() ** (1 / Math.max(0.1, Number(a.weight) || 1)) }))
      .sort((x, y) => y.k - x.k).map((x) => x.a);
  }

  let config = null;
  async function load() {
    if (config) return config;
    let c = null;
    if (onServer) {
      try {
        const r = await fetch('ads.json', { cache: 'no-cache' });
        if (r.ok) c = await r.json();
      } catch { c = null; }
    }
    if (!c || !Array.isArray(c.ads)) c = DEFAULT;
    config = { rotate: Math.max(4, Number(c.rotateSeconds) || 8), ads: order(c.ads.filter(usable)) };
    return config;
  }

  const seen = new Set();
  function track(id, type) {
    if (!onServer) return;
    if (type === 'impression') { if (seen.has(id)) return; seen.add(id); }
    try {
      fetch('api/ads/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, type }), keepalive: true }).catch(() => {});
    } catch { /* counting is best effort */ }
  }

  // Banner ads: the advertiser's own artwork. A wide strip on desktop, a taller crop on phones,
  // and just the logo in the compact spot shown after processing.
  function bannerCard(ad) {
    const t = ad.theme || {};
    const bn = ad.banner;
    const wide = safePath(bn.wide), narrow = safePath(bn.narrow) || wide, logo = safePath(ad.logo);
    const a = el('a', {
      class: 'ad-card ad-bcard', href: safeUrl(ad.url), target: '_blank', rel: 'noopener sponsored',
      style: { '--ad-bg': color(t.bg, '#f4f7fa'), '--ad-fg': color(t.fg, '#17202c'), '--ad-accent': color(t.accent, '#0d9b6c') },
      onclick: () => track(ad.id, 'click'),
    });
    const pic = el('picture', { class: 'ad-banner' },
      el('source', { media: '(max-width: 760px)', srcset: narrow }),
      el('img', { src: wide, alt: bn.alt || ad.sponsor || '', loading: 'eager' }));
    const by = (ad.partner && ad.partner.text) || (ad.sponsor ? `由 ${ad.sponsor} 提供` : '');
    const foot = el('div', { class: 'ad-foot' },
      el('span', { class: 'ad-label', text: '贊助' }),
      logo ? el('img', { class: 'ad-foot-logo', src: logo, alt: ad.sponsor || '' }) : null,
      el('span', { class: 'ad-by', text: by }),
      el('span', { class: 'ad-go' }, el('span', { text: ad.cta || '了解更多' }), el('span', { class: 'ad-arrow', 'aria-hidden': 'true', text: '→' })));
    a.append(pic, foot);
    return a;
  }

  // The shared ad layout: copy on the left, a brand-coloured panel with the icon and button on the right.
  function card(ad) {
    if (ad.banner && safePath(ad.banner.wide)) return bannerCard(ad);
    const t = ad.theme || {};
    const accent = color(t.accent, '#0d9b6c');
    const a = el('a', {
      class: 'ad-card', href: safeUrl(ad.url), target: '_blank', rel: 'noopener sponsored',
      style: { '--ad-bg': color(t.bg, '#ffffff'), '--ad-fg': color(t.fg, '#17202c'), '--ad-accent': accent, '--ad-accent2': color(t.accent2, accent) },
      onclick: () => track(ad.id, 'click'),
    });
    const icon = safePath(ad.icon), logo = safePath(ad.logo);
    const partner = ad.partner || {};
    const pLogo = safePath(partner.logo);
    const body = el('div', { class: 'ad-body' },
      el('div', { class: 'ad-top' },
        el('span', { class: 'ad-label', text: '贊助' }),
        logo ? el('img', { class: 'ad-logo', src: logo, alt: ad.sponsor || '' }) : el('b', { class: 'ad-sponsor', text: ad.sponsor || '' })),
      el('strong', { class: 'ad-headline', text: ad.headline }),
      ad.tagline ? el('p', { class: 'ad-tagline', text: ad.tagline }) : null,
      Array.isArray(ad.points) && ad.points.length
        ? el('ul', { class: 'ad-points' }, ad.points.slice(0, 3).map((p) => el('li', { text: String(p) })))
        : null,
      partner.text || pLogo
        ? el('div', { class: 'ad-partner' }, ...(pLogo
          ? [el('span', { text: '由' }), el('img', { src: pLogo, alt: partner.name || '' }), el('span', { text: '提供' })]
          : [el('span', { text: partner.text })]))
        : null);
    const side = el('div', { class: 'ad-side' },
      icon ? el('img', { class: 'ad-icon', src: icon, alt: '' }) : null,
      el('span', { class: 'ad-cta' }, el('span', { text: ad.cta || '了解更多' }), el('span', { class: 'ad-arrow', 'aria-hidden': 'true', text: '→' })));
    a.append(body, side);
    return a;
  }

  // Mount into a slot; rotates while visible, pauses on hover/focus. Returns a stop function.
  async function mount(slot, { compact = false } = {}) {
    const cfg = await load();
    if (!cfg.ads.length) { slot.hidden = true; return () => {}; }
    slot.hidden = false;
    slot.classList.toggle('compact', compact);
    const stage = el('div', { class: 'ad-stage' });
    const dots = el('div', { class: 'ad-dots', role: 'tablist', 'aria-label': '切換廣告' });
    slot.replaceChildren(...(cfg.ads.length > 1 ? [stage, dots] : [stage]));
    let i = 0, timer = null, paused = false;
    const show = (k) => {
      i = (k + cfg.ads.length) % cfg.ads.length;
      const ad = cfg.ads[i];
      stage.replaceChildren(card(ad));
      [...dots.children].forEach((d, n) => d.setAttribute('aria-selected', String(n === i)));
      track(ad.id, 'impression');
    };
    cfg.ads.forEach((ad, n) => dots.append(el('button', { type: 'button', class: 'ad-dot', role: 'tab', 'aria-label': `第 ${n + 1} 則：${ad.sponsor || ''}`, onclick: () => { show(n); restart(); } })));
    const tick = () => { if (!paused && !document.hidden) show(i + 1); };
    const restart = () => { clearInterval(timer); if (cfg.ads.length > 1) timer = setInterval(tick, cfg.rotate * 1000); };
    slot.onmouseenter = () => { paused = true; };
    slot.onmouseleave = () => { paused = false; };
    slot.onfocusin = () => { paused = true; };
    slot.onfocusout = () => { paused = false; };
    show(0);
    restart();
    return () => { clearInterval(timer); };
  }

  window.Ads = { mount, load };
})();
