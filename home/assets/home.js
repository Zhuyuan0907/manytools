/* Home page: tool links and the counter line. The counter reads only totals from the server
   (see server/server.js); opened as a local file the links point at the sibling folders instead. */
(() => {
  'use strict';
  const onServer = /^https?:$/.test(location.protocol);
  if (!onServer) {
    for (const a of document.querySelectorAll('a[data-local]')) a.href = a.dataset.local;
    return;
  }
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
  const span = (cls, ...kids) => { const s = document.createElement('span'); if (cls) s.className = cls; s.append(...kids); return s; };

  fetch('api/stats', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((st) => {
      const v = (st && st.video) || {}, p = (st && st.pdf) || {};
      // Before the first real file the line keeps its default instead of showing 0.
      if (!(v.files > 0) && !(p.files > 0)) return;
      const pill = span('pill', '已在大家的電腦上處理');
      const nums = [];
      if (v.files > 0) {
        const b = document.createElement('b');
        pill.append(span('', b, '部影片'));
        nums.push([b, v.files]);
      }
      if (p.files > 0) {
        const b = document.createElement('b');
        pill.append(span('pdf', v.files > 0 ? '・' : '', b, '份 PDF'));
        nums.push([b, p.files]);
      }
      const saved = (v.savedBytes || 0) + (p.savedBytes || 0);
      if (saved >= 1e9) pill.append(span('saved', `・省下 ${(saved / 1e9).toFixed(1)} GB`));
      line.replaceChildren(pill);
      for (const [b, n] of nums) countUp(b, n);
    })
    .catch(() => {});
})();
