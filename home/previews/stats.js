/* Home-page previews: fill [data-stat] with the server's totals (video.files, pdf.files, saved).
   Elements keep their placeholder text when there is nothing to show yet. */
(() => {
  'use strict';
  if (!/^https?:$/.test(location.protocol)) return;
  const fmtSaved = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
  function countUp(node, to, suffix = '') {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || to < 2) { node.textContent = to.toLocaleString('zh-TW') + suffix; return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
      node.textContent = Math.round(to * e).toLocaleString('zh-TW') + suffix;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  fetch('/api/stats', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((st) => {
      if (!st) return;
      const v = st.video || {}, p = st.pdf || {};
      const saved = (v.savedBytes || 0) + (p.savedBytes || 0);
      for (const n of document.querySelectorAll('[data-stat]')) {
        const k = n.dataset.stat;
        if (k === 'video.files' && v.files > 0) countUp(n, v.files);
        if (k === 'pdf.files' && p.files > 0) countUp(n, p.files);
        if (k === 'saved' && saved > 0) n.textContent = fmtSaved(saved);
      }
      document.documentElement.classList.toggle('has-stats', v.files > 0 || p.files > 0);
    })
    .catch(() => {});
})();
