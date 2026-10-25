/* Shared by index.html and viewer.html: pdf.js setup that also works when the page is opened
   straight from disk (file://), font-table loading, and small helpers. Nothing here talks to a server. */
(function () {
  'use strict';
  const Core = {};
  Core.MB = 1000 * 1000;
  Core.ready = typeof window.pdfjsLib !== 'undefined' && typeof window.__PDFJS_WORKER_SRC === 'string';
  // lib/ and data/ sit next to this file's assets/ folder; other tools (PDF watermark) load it from /pdf/assets/
  const HOME = (() => { try { return new URL('..', document.currentScript.src).href; } catch { return ''; } })();

  // ---------- pdf.js worker ----------
  // Browsers refuse to start a worker from a file:// URL, so start it from an in-memory copy.
  // If a worker cannot start, or starts but never answers, pdf.js runs on the main thread instead
  // (lib/pdf.worker.min.js loaded as an ordinary script: slower, but it always works).
  let mainThread = null;
  Core.useMainThread = () => {
    if (!mainThread) {
      mainThread = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = HOME + 'lib/pdf.worker.min.js';
        s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerPort = null; Core.workerMode = 'main'; resolve(); };
        s.onerror = () => reject(new Error('lib/pdf.worker.min.js 載入失敗'));
        document.head.append(s);
      });
    }
    return mainThread;
  };
  if (Core.ready) {
    try {
      const url = URL.createObjectURL(new Blob([window.__PDFJS_WORKER_SRC], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.addEventListener('error', () => { Core.useMainThread().catch(() => {}); });
      pdfjsLib.GlobalWorkerOptions.workerPort = w;
      Core.workerMode = 'worker';
    } catch (e) {
      Core.useMainThread().catch(() => {});
    }
  }

  // ---------- font tables (CJK cmaps, standard fonts) ----------
  // Loaded on demand through <script> tags from data/, which also works on file:// pages.
  window.__pdfData = window.__pdfData || { store: {} };
  const dataCache = new Map();
  const misses = new Set();
  Core.assetMisses = misses;
  function decodeB64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function loadData(key) {
    if (!dataCache.has(key)) {
      dataCache.set(key, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = HOME + 'data/' + key + '.js';
        s.onload = () => {
          const b64 = window.__pdfData.store[key];
          delete window.__pdfData.store[key];
          s.remove();
          if (b64) resolve(decodeB64(b64)); else reject(new Error('empty ' + key));
        };
        s.onerror = () => { s.remove(); reject(new Error('missing ' + key)); };
        document.head.append(s);
      }));
    }
    // pdf.js may hand the buffer to its worker; give it a copy so the cache stays intact.
    return dataCache.get(key).then((u8) => u8.slice());
  }
  class CMapFactory {
    async fetch({ name }) {
      try {
        return { cMapData: await loadData('cmaps/' + name + '.bcmap'), compressionType: pdfjsLib.CMapCompressionType.BINARY };
      } catch (e) { misses.add(name); throw e; }
    }
  }
  class FontFactory {
    async fetch({ filename }) {
      try { return await loadData('standard_fonts/' + filename); }
      catch (e) { misses.add(filename); throw e; }
    }
  }

  function getDocument(data, password) {
    return pdfjsLib.getDocument({
      data,
      password: password || undefined,
      isEvalSupported: false,
      CMapReaderFactory: CMapFactory,
      StandardFontDataFactory: FontFactory,
      cMapUrl: HOME + 'data/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: HOME + 'data/standard_fonts/',
      useWorkerFetch: false,
    });
  }
  // Returns a pdf.js loading task. If the worker has not answered within 8 seconds, the file is
  // opened again on the main thread, so an unresponsive worker can never leave the page waiting.
  Core.openPdf = function (data, password) {
    let current = null;
    let destroyed = false;
    const copy = data && data.slice ? data.slice() : data;   // pdf.js may take ownership of the buffer
    const promise = (async () => {
      if (mainThread) await mainThread;
      current = getDocument(data, password);
      if (Core.workerMode === 'main') return current.promise;
      let timer;
      const stall = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('worker-stalled')), 8000); });
      try {
        return await Promise.race([current.promise, stall]);
      } catch (e) {
        if (!e || e.message !== 'worker-stalled' || destroyed) throw e;
        try { current.destroy(); } catch { /* ignore */ }
        await Core.useMainThread();
        current = getDocument(copy, password);
        return current.promise;
      } finally { clearTimeout(timer); }
    })();
    return { promise, destroy: () => { destroyed = true; return current ? current.destroy() : Promise.resolve(); } };
  };

  // Turn pdf.js open errors into sentences a student can act on.
  Core.describeOpenError = function (e) {
    if (e && e.name === 'PasswordException') {
      return { needPassword: true, message: e.code === 2 ? '密碼不正確' : '需要開啟密碼' };
    }
    if (e && (e.name === 'InvalidPDFException' || e.name === 'MissingPDFException')) {
      return { message: '檔案損壞，無法讀取' };
    }
    return { message: '讀取失敗' };
  };

  // ---------- helpers ----------
  Core.fmtMB = (bytes, digits) => {
    if (bytes < 100 * 1000) return Math.max(1, Math.round(bytes / 1000)) + ' KB';
    const v = bytes / Core.MB;
    return v.toFixed(digits ?? (v < 10 ? 2 : 1)) + ' MB';
  };
  Core.fmtLimit = (mb) => (Math.round(mb * 10) / 10) + ' MB';
  Core.el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) n.style.setProperty(prop, val); else n.style[prop] = val;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  };
  Core.nextFrame = () => new Promise((r) => setTimeout(r, 0));
  Core.store = {
    get(k) { try { return localStorage.getItem('bspdf:' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('bspdf:' + k, v); } catch { /* storage unavailable */ } },
  };
  Core.isPdfHeader = (bytes) => new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(1024, bytes.length))).includes('%PDF');

  window.Core = Core;
})();
