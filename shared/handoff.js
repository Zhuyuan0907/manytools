/* Hands files dropped on the home page to a tool page — inside this browser only, nothing is uploaded.
   Home page:  ManyHandoff.send(tool, entries) keeps them in IndexedDB, then the page navigates to the tool.
   Tool page:  <script src="/shared/handoff.js" data-tool="video" data-input="#fileInput"></script> (after the
               tool's own scripts) picks them up on load, clears the record and feeds the tool's file input.
   An entry is { name, file } (the File itself; fine for normal sizes) or { name, handle } (a file handle from
   Chrome/Edge, so a multi-GB video isn't copied). Records older than ten minutes are ignored. */
(() => {
  'use strict';
  const DB = 'manytools-handoff', STORE = 'pending', KEY = 'next', MAX_AGE = 10 * 60 * 1000;

  function openDb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function run(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => { db.close(); resolve(req && req.result); };
      t.onerror = t.onabort = () => { db.close(); reject(t.error); };
    });
  }

  async function send(tool, entries) {
    await run('readwrite', (st) => st.put({ tool, at: Date.now(), entries }, KEY));
  }

  async function take(tool) {
    let rec;
    try { rec = await run('readonly', (st) => st.get(KEY)); } catch { return null; }
    if (!rec) return null;
    await run('readwrite', (st) => st.delete(KEY)).catch(() => {});
    if (rec.tool !== tool || Date.now() - rec.at > MAX_AGE) return null;
    const files = [], missed = [];
    for (const e of rec.entries || []) {
      if (e.file) { files.push(e.file); continue; }
      try { files.push(await e.handle.getFile()); } catch { missed.push(e.name); }
    }
    return { files, missed };
  }

  function notice(text) {
    const n = document.createElement('div');
    n.setAttribute('role', 'status');
    n.textContent = text;
    n.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:50;max-width:calc(100vw - 32px);'
      + 'padding:10px 18px;border-radius:12px;background:#17202c;color:#fff;font-size:.92rem;box-shadow:0 8px 24px rgba(0,0,0,.2)';
    document.body.append(n);
    setTimeout(() => n.remove(), 6000);
  }

  window.ManyHandoff = { send, take };

  // On a tool page: pick up what the home page left and hand it to the tool's own file input.
  const me = document.currentScript;
  if (me && me.dataset.tool && window.indexedDB) {
    take(me.dataset.tool).then((got) => {
      if (!got) return;
      const input = document.querySelector(me.dataset.input || 'input[type=file]');
      if (got.files.length && input) {
        const dt = new DataTransfer();
        for (const f of got.files) dt.items.add(f);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (got.missed.length) notice(`「${got.missed.join('」「')}」沒辦法從首頁帶過來，請在這裡再選一次`);
    }).catch(() => {});
  }
})();
