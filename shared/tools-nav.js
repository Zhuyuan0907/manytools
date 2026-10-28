/* "其他工具" under each tool's headline (step 1, screens wider than a phone): the other tools one click away, the
   ones on the same side of the home page (日常 or 拍攝) first and outlined, so nobody goes back to the home page to
   find them. Works off the markup alone — .hero-text — and the page's own palette variables; data-tool names the
   page itself.
   <script src="/shared/tools-nav.js" data-tool="image"></script> (phones have the home page's tiles instead). */
(() => {
  'use strict';
  const me = document.currentScript, here = me && me.dataset.tool;
  const host = document.querySelector('.hero-text');
  if (!host || !here) return;
  const onServer = /^https?:$/.test(location.protocol);
  // [tool, name, address, address when the folder is opened from disk, kind — the home page's side it's on], in the
  // home page's order
  const TOOLS = [
    ['video', '影片碼率壓縮', '/video', '../videotools/index.html', 'daily'],
    ['pdf', 'PDF 壓縮・拆分', '/pdf', '../pdftools/local/index.html', 'daily'],
    ['watermark', 'PDF 浮水印', '/watermark', '../watermarktools/index.html', 'daily'],
    ['avatar', 'Gravatar 頭貼查詢', '/avatar', '../avatartools/index.html', 'daily'],
    ['crop', '頭貼裁切', '/crop', '../croptools/index.html', 'daily'],
    ['pick', '照片挑選', '/pick', '../picktools/index.html', 'photo'],
    ['rename', '照片批次改檔名', '/rename', '../renametools/index.html', 'photo'],
    ['image', '圖片壓縮', '/image', '../imagetools/index.html', 'photo'],
    ['exif', '照片參數查看', '/exif', '../exiftools/index.html', 'photo'],
  ];
  const mine = TOOLS.find((t) => t[0] === here);
  if (!mine) return;
  const kin = (t) => t[4] === mine[4];
  const others = TOOLS.filter((t) => t !== mine).sort((a, b) => kin(b) - kin(a));

  const css = document.createElement('style');
  css.textContent = `
    .also { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 2px; margin-top: -2px; color: var(--muted, #778193); font-size: .82rem; line-height: 1.5; }
    .also > span { margin-right: 4px; }
    .also a { color: var(--accent-strong, inherit); text-decoration: none; font-weight: 600; padding: 1px 7px; border-radius: 6px; white-space: nowrap; }
    .also a:hover { background: var(--accent-soft, rgba(0, 0, 0, .05)); }
    .also a.kin { box-shadow: inset 0 0 0 1px var(--line-strong, #ddd); }
    .has-files .also { display: none; }
    @media (max-width: 640px) { .also { display: none; } }`;
  document.head.append(css);

  const p = document.createElement('p');
  p.className = 'also';
  const label = document.createElement('span');
  label.textContent = '其他工具';
  p.append(label);
  for (const t of others) {
    const a = document.createElement('a');
    a.href = onServer ? t[2] : t[3];
    a.textContent = t[1];
    if (kin(t)) a.className = 'kin';
    p.append(a);
  }
  host.append(p);
})();
