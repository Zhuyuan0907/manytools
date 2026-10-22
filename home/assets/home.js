/* The counter line on the home page. Reads only totals from the server (see server/server.js);
   opened as a local file it keeps the default line. */
(() => {
  'use strict';
  if (!/^https?:$/.test(location.protocol)) return;
  const line = document.getElementById('count');

  function countUp(node, to) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || to < 2) { node.textContent = to.toLocaleString('zh-TW'); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
      node.textContent = Math.round(to * e).toLocaleString('zh-TW');
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  fetch('../api/stats', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((st) => {
      const v = (st && st.video) || {}, p = (st && st.pdf) || {};
      // Before the first real file the line keeps its default instead of showing 0.
      if (!(v.files > 0) && !(p.files > 0)) return;
      const parts = ['已在大家自己的電腦上處理'];
      const nums = [];
      if (v.files > 0) {
        const b = document.createElement('b');
        parts.push(b, '部影片');
        nums.push([b, v.files]);
      }
      if (p.files > 0) {
        const span = document.createElement('span');
        span.className = 'pdf';
        const b = document.createElement('b');
        span.append(v.files > 0 ? '、' : '', b, '份 PDF');
        parts.push(span);
        nums.push([b, p.files]);
      }
      const saved = (v.savedBytes || 0) + (p.savedBytes || 0);
      if (saved > 1e9) parts.push(`・共省下 ${(saved / 1e9).toFixed(1)} GB`);
      line.replaceChildren(...parts);
      for (const [b, n] of nums) countUp(b, n);
    })
    .catch(() => {});
})();
