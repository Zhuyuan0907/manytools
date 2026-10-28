/* The four-step wizard: upload → whole or split → settings → process & download. */
(() => {
  'use strict';
  const { el, fmtMB, fmtLimit, MB } = Core;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const libsOk = Core.ready && window.PDFLib && window.UPNG && window.pako && window.Engine;
  if (!libsOk) $('#libError').hidden = false;
  // The logo goes back to the ZhuyuanTools home page; the offline copy (opened as a file) has no home page.
  if (!/^https?:$/.test(location.protocol)) { $('#brand').removeAttribute('href'); $('#brand').removeAttribute('title'); }

  // Section colours: distinct at a glance on white, readable with white numerals.
  const COLORS = ['#2f7fe0', '#ef8a2a', '#0d9b6c', '#e2483b', '#8e57d6', '#d9468f', '#1499ad', '#b38600'];

  const state = {
    step: 1,
    sources: [],                 // { id, file, name, status, error, pdf, numPages, password, offset, draft, wrong, perms }
    splitMode: 'single',         // 'single' | 'split' | 'direct' (no compression, for taking passwords off)
    modeChosen: false,           // has the student picked one/many files in step 2 yet
    directEach: true,            // 直接輸出 with several files: each on its own (else merged)
    names: new Map(),            // output file names changed in step 4: the name it would have had → the new one
    parts: [],                   // split editor: output files { id, name, custom, text (page ranges) }
    project: null,
    total: 0,
    run: null,
  };
  let seq = 0;

  const toast = (() => {
    let t = null;
    return (msg) => {
      const n = $('#toast');
      n.textContent = msg; n.hidden = false;
      clearTimeout(t); t = setTimeout(() => { n.hidden = true; }, 4200);
    };
  })();

  const stripPdf = (name) => name.replace(/\.pdf$/i, '');
  // Long file names keep their ending visible: "Zhuyuan備審…定稿版本.pdf".
  const nameParts = (name) => {
    const tail = name.length > 12 ? name.slice(-6) : '';
    return [el('span', { class: 'nm-head', text: tail ? name.slice(0, -6) : name }), tail ? el('span', { class: 'nm-tail', text: tail }) : null];
  };
  const safeFile = (name) => (name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  function baseName() {
    const ready = state.sources.filter((s) => s.status === 'ready');
    if (ready.length === 1) return safeFile(stripPdf(ready[0].name)) || '備審資料';
    return '備審資料';
  }

  // ======================= sources (step 1) =======================
  // src.password: the one it opened with; src.draft: what is typed in its box (kept while the list is redrawn);
  // src.perms: pdf.js's permission flags when the file is protected at all (null when it isn't).
  function addFiles(list) {
    const files = [...list];
    if (!files.length) return;
    for (const file of files) {
      const src = { id: ++seq, file, name: file.name, status: 'loading', error: '', pdf: null, numPages: 0, password: '', draft: '', wrong: false, perms: null };
      state.sources.push(src);
      loadSource(src);
    }
    sourcesChanged();
  }

  // passwords that opened a file here already: a file added later may well share one
  const knownPasswords = () => state.sources.map((s) => s.password).filter(Boolean);

  async function loadSource(src, passwords = ['', ...knownPasswords()]) {
    try {
      const bytes = new Uint8Array(await src.file.arrayBuffer());
      if (!Core.isPdfHeader(bytes)) throw Object.assign(new Error('這不是 PDF 檔'), { friendly: true });
      const { pdf, password } = await Core.openWithPasswords(bytes, passwords);
      if (!state.sources.includes(src)) { pdf.destroy(); return false; }
      src.pdf = pdf; src.numPages = pdf.numPages; src.status = 'ready'; src.error = ''; src.password = password; src.wrong = false;
      src.perms = await pdf.getPermissions().catch(() => null);
      return true;
    } catch (e) {
      if (e && e.friendly) { src.status = 'error'; src.error = e.message; }
      else {
        const d = Core.describeOpenError(e);
        src.status = d.needPassword ? 'password' : 'error';
        src.error = d.needPassword ? (src.draft ? '密碼不對' : '需要開啟密碼') : d.message;
        src.wrong = d.needPassword && !!src.draft;
      }
      return false;
    } finally {
      if (!unlocking) sourcesChanged();
    }
  }

  // One 解鎖 for all: every password typed so far is tried on every locked file, its own first. A password that
  // opens one file is tried on the others too, so files sharing one (school documents often do) need it typed once.
  let unlocking = false;
  async function unlockAll() {
    if (unlocking) return;
    const locked = state.sources.filter((s) => s.status === 'password');
    const typed = locked.map((s) => s.draft).filter(Boolean);
    if (!typed.length) { focusLocked(); toast('先在框裡輸入開啟密碼'); return; }
    unlocking = true;
    renderSources();
    let shared = 0;
    for (const s of locked) {
      if (!state.sources.includes(s)) continue;
      const own = s.draft;
      if (await loadSource(s, [...(own ? [own] : []), ...typed, ...knownPasswords()]) && s.password.normalize('NFKC') !== own.normalize('NFKC')) shared++;
    }
    unlocking = false;
    sourcesChanged();
    if (shared) toast(`同一個密碼也打開了另外 ${shared} 個檔案`);
    focusLocked();
  }
  // the next box that still needs something: a wrong password (selected, to type over) or an empty one
  function focusLocked() {
    const s = state.sources.find((x) => x.status === 'password' && x.wrong) || state.sources.find((x) => x.status === 'password' && !x.draft);
    const input = s && document.getElementById('pw' + s.id);
    if (input) { input.focus({ preventScroll: true }); input.select(); }
  }

  let showPw = false;
  const EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  // a show/hide button for password boxes; on: whether they are shown now
  function eyeButton(on, onclick) {
    const b = el('button', { type: 'button', class: 'icon-btn pw-eye', 'aria-pressed': String(on), 'aria-label': '顯示密碼', title: on ? '隱藏密碼' : '顯示密碼', onclick });
    b.innerHTML = on ? EYE_OFF : EYE;
    return b;
  }
  function toggleShowPw() {
    showPw = !showPw;
    for (const i of $$('.src-pw .pw-in')) i.type = showPw ? 'text' : 'password';
    for (const b of $$('.src-pw .pw-eye')) { b.setAttribute('aria-pressed', String(showPw)); b.title = showPw ? '隱藏密碼' : '顯示密碼'; b.innerHTML = showPw ? EYE_OFF : EYE; }
  }
  // what a protected file had, said once it's open (the output never carries it); what it forbade in the tooltip
  const PERM_NAMES = [[4, '列印'], [16, '複製文字'], [8, '修改']];
  function protection(src) {
    if (src.password) return { text: '已解鎖，輸出後不用密碼', title: '原檔有開啟密碼，輸出的檔案不會有' };
    if (!src.perms) return null;
    const no = PERM_NAMES.filter(([f]) => !src.perms.includes(f)).map(([, n]) => n);
    return { text: '有保護，輸出後會拿掉', title: `原檔${no.length ? `不能${no.join('、')}` : '有加密'}，輸出的檔案不會有這個限制` };
  }

  function removeSource(src) {
    const i = state.sources.indexOf(src);
    if (i < 0) return;
    state.sources.splice(i, 1);
    if (src.pdf) src.pdf.destroy();
    sourcesChanged();
  }

  function moveSource(src, d) {
    const i = state.sources.indexOf(src), j = i + d;
    if (j < 0 || j >= state.sources.length) return;
    [state.sources[i], state.sources[j]] = [state.sources[j], state.sources[i]];
    sourcesChanged();
  }

  // Any change to the inputs resets page numbering, cuts and results.
  function sourcesChanged() {
    if (state.run && state.run.running) state.run.job.cancelled = true;
    const ready = state.sources.filter((s) => s.status === 'ready');
    let off = 0;
    for (const s of ready) { s.offset = off; off += s.numPages; }
    state.total = off;
    state.project = { sources: ready, info: [], cache: { key: null, blobs: [] }, outline: null };
    state.parts = [];
    state.names = new Map();
    state.run = null;
    thumbs.invalidate();
    renderSources();
    renderStepper();
  }

  function renderSources() {
    const ol = $('#sources');
    // the list is drawn anew each time: the box being typed in gets its focus and caret back
    const a = document.activeElement;
    const typing = a && a.classList.contains('pw-in') && ol.contains(a) ? { id: a.id, from: a.selectionStart, to: a.selectionEnd } : null;
    ol.replaceChildren(...state.sources.map((src, i) => {
      let meta;
      if (src.status === 'loading') meta = el('div', { class: 'src-meta' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 讀取中…');
      else if (src.status === 'ready') {
        const p = protection(src);
        meta = [el('div', { class: 'src-meta', text: `${src.numPages} 頁・${fmtMB(src.file.size)}` }), p ? el('div', { class: 'src-meta src-lock', title: p.title, text: p.text }) : null];
      }
      else meta = el('div', { class: 'src-meta ' + (src.status === 'password' ? 'warn' : 'bad'), text: unlocking && src.status === 'password' ? '試試看密碼…' : src.error });
      const li = el('li', { class: 'src' },
        el('span', { class: 'src-no', text: String(i + 1) }),
        el('div', { class: 'src-main' }, el('div', { class: 'src-name', title: src.name }, ...nameParts(src.name)), meta),
        el('div', { class: 'src-btns' },
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': '往前移', title: '往前移', disabled: i === 0, onclick: () => moveSource(src, -1), text: '↑' }),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': '往後移', title: '往後移', disabled: i === state.sources.length - 1, onclick: () => moveSource(src, 1), text: '↓' }),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': '移除這個檔案', title: '移除', onclick: () => removeSource(src), text: '✕' })));
      if (src.status === 'password') {
        const input = el('input', { type: showPw ? 'text' : 'password', id: 'pw' + src.id, class: 'pw-in', placeholder: '開啟密碼', autocomplete: 'off',
          spellcheck: 'false', autocapitalize: 'off', 'aria-label': `「${src.name}」的開啟密碼`, 'aria-invalid': src.wrong ? 'true' : null, readonly: unlocking });
        input.value = src.draft;
        input.addEventListener('input', () => { src.draft = input.value; if (src.wrong) { src.wrong = false; input.removeAttribute('aria-invalid'); } });
        const form = el('form', { class: 'src-pw' }, input, eyeButton(showPw, toggleShowPw),
          el('button', { class: 'btn small primary', type: 'submit', disabled: unlocking, text: unlocking ? '解鎖中…' : '解鎖' }));
        form.addEventListener('submit', (ev) => { ev.preventDefault(); unlockAll(); });
        li.append(form);
      }
      return li;
    }));
    if (typing) {
      const n = document.getElementById(typing.id);
      if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(typing.from, typing.to); } catch { /* not a text box any more */ } }
    }
    const ready = state.sources.filter((s) => s.status === 'ready');
    const pending = state.sources.length - ready.length;
    const size = ready.reduce((a, s) => a + s.file.size, 0);
    const locked = state.sources.filter((s) => s.status === 'password').length;
    let note;
    if (!state.sources.length) note = '還沒有加入檔案。';
    else if (pending && (unlocking || state.sources.some((s) => s.status === 'loading'))) note = unlocking ? '解鎖中…' : '讀取中…';
    else if (locked > 1) note = `${locked} 個檔案要密碼：都輸入好，按一次「解鎖」就好`;
    else if (locked) note = '輸入開啟密碼，再按「解鎖」';
    else if (pending) note = '有檔案讀不了，請移除';
    else note = `${ready.length} 個檔案・共 ${state.total} 頁・${fmtMB(size)}` + (ready.length > 1 ? '・會照上面的順序接成一份' : '');
    $('#note1').textContent = note;
    $('#step1').classList.toggle('has-files', state.sources.length > 0);
    $('#next1').disabled = !canReach(2);
  }

  // ======================= steps =======================
  function canReach(step) {
    if (step === 1) return true;
    const srcOk = state.sources.length > 0 && state.sources.every((s) => s.status === 'ready');
    if (step === 2) return srcOk && libsOk;
    if (step === 3) return canReach(2) && outputsPlan().length > 0 && state.splitMode !== 'direct';
    if (step === 4) return canReach(2) && !!state.run;
    return false;
  }

  function go(step) {
    if (!canReach(step)) return;
    state.step = step;
    for (let i = 1; i <= 4; i++) $('#step' + i).hidden = i !== step;
    if (step === 2) renderStep2();
    if (step === 3) { syncSettingsUI(); renderPlan(); }
    if (step === 4) renderRun();
    renderStepper();
    const panel = $('#step' + step);
    const h = panel.querySelector('h2');
    h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }

  const STEP_NAMES = ['上傳檔案', '整份或拆分', '壓縮設定', '處理與下載'];
  const isPhone = () => window.matchMedia('(max-width: 640px)').matches;
  function renderStepper() {
    $('#mStep').replaceChildren(`步驟 ${state.step}／4・`, el('b', { text: STEP_NAMES[state.step - 1] }));
    $$('.stepper button').forEach((b) => {
      const n = +b.dataset.goto;
      b.classList.toggle('current', n === state.step);
      b.classList.toggle('done', n < state.step);
      b.disabled = n !== state.step && !canReach(n);
      if (n === state.step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b && !b.disabled) go(+b.dataset.goto);
  });
  $('#next1').addEventListener('click', () => go(2));
  $('#next2').addEventListener('click', () => (state.splitMode === 'direct' ? startRun() : go(3)));

  // ======================= step 2: one file or several =======================
  // The split editor keeps one list of output files ("parts"), each with a name and its pages.
  // Clicking a page cuts the part there (or joins it back); the page numbers can also be typed.
  function pageLabel(pages) {           // [0,1,2,7] → 第 1–3、8 頁
    const parts = [];
    for (let i = 0; i < pages.length;) {
      let j = i;
      while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
      parts.push(i === j ? `${pages[i] + 1}` : `${pages[i] + 1}–${pages[j] + 1}`);
      i = j + 1;
    }
    return `第 ${parts.join('、')} 頁`;
  }
  function rangeText(pages) {           // [0,1,2,7] → 1-3, 8
    const parts = [];
    for (let i = 0; i < pages.length;) {
      let j = i;
      while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
      parts.push(i === j ? `${pages[i] + 1}` : `${pages[i] + 1}-${pages[j] + 1}`);
      i = j + 1;
    }
    return parts.join(', ');
  }
  // "1-5, 8, 10-" (full-width digits, ～、，to/至 also accepted) → 0-based page list in the typed order.
  function parsePages(text, total) {
    const t = (text || '')
      .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
      .replace(/[~～—–－−至到]/g, '-')
      .replace(/\s*-\s*/g, '-')
      .replace(/[，、；;,\s]+/g, ',');
    const pages = [], seen = new Set();
    for (const part of t.split(',').filter(Boolean)) {
      const m = /^(\d+)(?:-(\d*))?$/.exec(part);
      if (!m) return { pages: [], error: '格式不對，例如 1-5' };
      const a = +m[1];
      const b = m[2] === undefined ? a : m[2] === '' ? total : +m[2];
      if (a < 1 || b < 1) return { pages: [], error: '頁碼從 1 開始' };
      if (a > total || b > total) return { pages: [], error: `只有 ${total} 頁` };
      if (a > b) return { pages: [], error: '前面的頁碼要比較小' };
      for (let g = a - 1; g <= b - 1; g++) if (!seen.has(g)) { seen.add(g); pages.push(g); }
    }
    if (!pages.length) return { pages: [], error: '請輸入頁碼' };
    return { pages, error: '' };
  }

  const newPart = (pages, name) => ({ id: ++seq, name: name || '', custom: !!name, text: rangeText(pages) });
  const allPages = () => Array.from({ length: state.total }, (_, k) => k);
  function sections() {
    return state.parts.map((row, i) => {
      const r = parsePages(row.text, state.total);
      return {
        key: 'p' + row.id, row, index: i, color: COLORS[i % COLORS.length],
        name: row.custom && row.name.trim() ? row.name : `${baseName()}_第${i + 1}份`,
        pages: r.pages, error: r.error, on: true,
        label: r.error ? '' : `${pageLabel(r.pages)}・${r.pages.length} 頁`,
      };
    });
  }

  function outputsPlan() {
    if (!state.total) return [];
    let plan;
    if (state.splitMode === 'direct' && state.directEach) {
      // each file as itself, under its own name
      plan = state.project.sources.map((src) => ({
        title: stripPdf(src.name), filename: /\.pdf$/i.test(src.name) ? src.name : src.name + '.pdf', label: `全部 ${src.numPages} 頁`,
        pages: Array.from({ length: src.numPages }, (_, k) => src.offset + k), src,
      }));
    } else if (state.splitMode !== 'split') {
      const name = state.project.sources.length > 1 ? '備審資料_合併' : `${baseName()}_壓縮`;
      plan = [{ title: baseName(), filename: name + '.pdf', pages: allPages(), label: `全部 ${state.total} 頁` }];
    } else {
      plan = sections().filter((s) => !s.error && s.pages.length).map((s) => ({
        title: s.name, filename: (safeFile(s.name) || `第${s.index + 1}份`) + '.pdf', pages: s.pages, label: s.label, color: s.color,
      }));
    }
    for (const p of plan) { p.key = p.filename; if (state.names.has(p.key)) p.filename = state.names.get(p.key); }
    const seen = new Map();
    for (const p of plan) {
      const k = p.filename.toLowerCase();
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      if (n > 1) p.filename = p.filename.replace(/\.pdf$/, `(${n}).pdf`);
    }
    return plan;
  }

  // Step 2 opens as two big choices, three when a file had a password or protection. "多份檔案" opens the split
  // editor and "直接輸出" its two questions, each with its own "返回".
  function renderStep2() {
    const canDirect = state.project.sources.some((s) => s.password || s.perms);
    if (!canDirect && state.splitMode === 'direct') state.splitMode = 'single';
    const split = state.splitMode === 'split', direct = state.splitMode === 'direct';
    const panel = $('#step2');
    panel.classList.toggle('fill', split);
    panel.classList.toggle('editing', split);
    $('#h2sub').textContent = canDirect ? '分項上傳選「多份檔案」，只要拿掉密碼選「直接輸出」' : '學校要求分項上傳時，選「多份檔案」。';
    $('#pickMode').hidden = split || direct;
    $('#pickMode').classList.toggle('three', canDirect);
    $('#chooseDirect').hidden = !canDirect;
    $('#splitArea').hidden = !split;
    $('#directArea').hidden = !direct;
    $('#next2').hidden = !split && !direct;
    $('#next2').textContent = direct ? '直接輸出 →' : '下一步：壓縮設定 →';
    $('#chooseSingle').classList.toggle('selected', state.splitMode === 'single' && state.modeChosen);
    $('#chooseSplit').classList.toggle('selected', split);
    $('#chooseDirect').classList.toggle('selected', direct);
    if (direct) renderDirect();
    if (split) {
      if (!state.parts.length) state.parts = [newPart(allPages())];
      $('#byFile').hidden = state.project.sources.length < 2;
      thumbs.build();
      renderSectionList();
    }
    updateStep2Footer();
  }
  $('#chooseSingle').addEventListener('click', () => { state.splitMode = 'single'; state.modeChosen = true; renderStep2(); go(3); });
  $('#chooseSplit').addEventListener('click', () => { state.splitMode = 'split'; state.modeChosen = true; renderStep2(); });
  $('#backToSingle').addEventListener('click', () => { state.splitMode = 'single'; renderStep2(); $('#chooseSingle').focus(); });
  $('#chooseDirect').addEventListener('click', () => { state.splitMode = 'direct'; state.modeChosen = true; renderStep2(); });
  $('#backFromDirect').addEventListener('click', () => { state.splitMode = 'single'; renderStep2(); $('#chooseDirect').focus(); });

  // 直接輸出: no compression and two questions (several files apart or merged; the output with no password or a
  // new one), then the files that will come out. The password is the same setting as step 3's.
  function renderDirect() {
    const srcs = state.project.sources;
    $('#dEachSet').hidden = srcs.length < 2;
    $('#lblEach').textContent = `這 ${srcs.length} 個檔案要`;
    $(`input[name="dEach"][value="${state.directEach ? 'each' : 'merge'}"]`).checked = true;
    $(`input[name="dPw"][value="${S.lockOut ? 'new' : 'none'}"]`).checked = true;
    $('#dPwSet').hidden = !S.lockOut;
    if (document.activeElement !== $('#dPw')) $('#dPw').value = S.outPw;
    syncPwHelp();
    const what = (src) => (S.lockOut ? (src.password ? '換成新密碼' : '加上新密碼')
      : src.password ? '拿掉密碼' : src.perms ? '拿掉保護' : '本來就沒有密碼，不會變');
    $('#directOut').replaceChildren(...outputsPlan().map((p) => el('li', {},
      el('b', { class: 'do-name', title: p.filename, text: p.filename }),
      el('span', { class: 'do-meta', text: `${p.label}・${p.src ? what(p.src) : S.lockOut ? '加上新密碼' : '沒有密碼'}` }))));
  }
  $('#directArea').addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.name === 'dEach') state.directEach = t.value === 'each';
    else if (t.name === 'dPw') { S.lockOut = t.value === 'new'; if (S.lockOut) setTimeout(() => $('#dPw').focus(), 0); }
    else return;
    renderDirect();
    updateStep2Footer();
  });
  $('#dPw').addEventListener('input', (ev) => { S.outPw = ev.target.value; renderDirect(); updateStep2Footer(); });

  function updateStep2Footer() {
    const n = outputsPlan().length;
    $('#secCount').textContent = String(state.parts.length);
    $('#mSecCount').textContent = String(state.parts.length);
    const bad = state.splitMode === 'split' && sections().some((s) => s.error);
    const needPw = state.splitMode === 'direct' && S.lockOut && !outPassword();
    $('#note2').textContent = state.splitMode === 'direct' ? (needPw ? '請輸入要設定的密碼' : `將輸出 ${n} 個 PDF・不壓縮`)
      : state.splitMode === 'split' ? (bad ? '有頁碼需要修正' : `將輸出 ${n} 個檔案`) : '點一下就會進到下一步';
    $('#next2').disabled = !n || bad || needPw;
    renderStepper();
  }

  // Phone: show either the pages or the list of output files.
  function showPane(name) {
    $('#splitLayout').dataset.pane = name;
    $$('input[name="mPane"]').forEach((r) => { r.checked = r.value === name; });
  }
  $$('input[name="mPane"]').forEach((r) => r.addEventListener('change', () => showPane(r.value)));

  function partsChanged() {
    thumbs.paint();
    renderSectionList();
    updateStep2Footer();
  }

  // Click on page g: cut the part that runs through g-1 → g, or join it back if g already starts a part.
  function splitAt(g) {
    const secs = sections();
    for (const s of secs) {
      const i = s.pages.indexOf(g - 1);
      if (i >= 0 && s.pages[i + 1] === g) {
        s.row.text = rangeText(s.pages.slice(0, i + 1));
        state.parts.splice(state.parts.indexOf(s.row) + 1, 0, newPart(s.pages.slice(i + 1)));
        partsChanged();
        return;
      }
    }
    const b = secs.find((s) => !s.error && s.pages[0] === g);
    const a = secs.find((s) => !s.error && s !== b && s.pages[s.pages.length - 1] === g - 1);
    if (a && b) {
      a.row.text = rangeText(a.pages.concat(b.pages));
      state.parts = state.parts.filter((r) => r !== b.row);
      partsChanged();
      return;
    }
    toast('這頁不能在這裡切，請改頁碼');
  }

  function setParts(list) {
    state.parts = list.filter((x) => x.pages.length).map((x) => newPart(x.pages, x.name));
    $('#quick').open = false;
    partsChanged();
  }
  function rangesFromStarts(starts, names) {
    const sorted = [...new Set(starts)].filter((g) => g >= 0 && g < state.total).sort((a, b) => a - b);
    if (sorted[0] !== 0) sorted.unshift(0);
    return sorted.map((st, i) => {
      const end = i + 1 < sorted.length ? sorted[i + 1] - 1 : state.total - 1;
      return { pages: Array.from({ length: end - st + 1 }, (_, k) => st + k), name: names ? names.get(st) : '' };
    });
  }
  $('#byOutline').addEventListener('click', async () => {
    const tree = await Engine.outlineTree(state.project);
    let level = tree.filter((n) => n.page != null);
    if (level.length <= 1 && tree.length === 1 && tree[0].items.length) level = tree[0].items.filter((n) => n.page != null);
    if (!level.length) { $('#quick').open = false; toast('這份 PDF 沒有書籤'); return; }
    const names = new Map();
    for (const n of level) if (!names.has(n.page)) names.set(n.page, safeFile(n.title) || '未命名');
    if (!names.has(0)) names.set(0, '封面與目錄');
    setParts(rangesFromStarts([...names.keys()], names));
    toast(`已依書籤拆成 ${state.parts.length} 份`);
  });
  $('#byFile').addEventListener('click', () => {
    const src = state.project.sources;
    setParts(rangesFromStarts(src.map((s) => s.offset), new Map(src.map((s) => [s.offset, safeFile(stripPdf(s.name))]))));
    toast(`已依檔案拆成 ${state.parts.length} 份`);
  });
  $('#applyEvery').addEventListener('click', () => {
    const n = Math.max(1, parseInt($('#everyN').value, 10) || 1);
    const starts = [];
    for (let g = 0; g < state.total; g += n) starts.push(g);
    setParts(rangesFromStarts(starts));
    toast(`已拆成 ${state.parts.length} 份`);
  });
  $('#clearCuts').addEventListener('click', () => { setParts([{ pages: allPages() }]); });
  $('#addSec').addEventListener('click', () => {
    const used = sections().flatMap((s) => s.pages);
    const last = used.length ? Math.max(...used) : -1;
    const rest = last < state.total - 1 ? Array.from({ length: state.total - 1 - last }, (_, k) => last + 1 + k) : [];
    state.parts.push(rest.length ? newPart(rest) : { id: ++seq, name: '', custom: false, text: '' });
    partsChanged();
    const inputs = $$('#sectionList .sec-range');
    const lastInput = inputs[inputs.length - 1];
    if (lastInput) { lastInput.focus(); lastInput.select(); }
    if (isPhone()) showPane('files');
  });

  const ICON_EYE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_TRASH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
  const iconBtn = (svg, label, cls, onclick) => {
    const b = el('button', { class: 'icon-btn sm ' + (cls || ''), type: 'button', title: label, 'aria-label': label, onclick });
    b.innerHTML = svg;
    return b;
  };

  function renderSectionList() {
    const secs = sections();
    $('#sectionList').replaceChildren(...secs.map((s) => {
      const name = el('input', { class: 'sec-name', list: 'secPresets', value: s.row.custom ? s.row.name : '', placeholder: s.name, 'aria-label': `第 ${s.index + 1} 份的檔名`, autocomplete: 'off' });
      name.addEventListener('input', () => { s.row.name = name.value; s.row.custom = !!name.value.trim(); updateStep2Footer(); });
      const rid = 'rng' + s.row.id;
      const range = el('input', { class: 'sec-range', id: rid, value: s.row.text, placeholder: '例如 1-5', autocomplete: 'off', inputmode: 'numeric', 'aria-label': `第 ${s.index + 1} 份的頁碼` });
      const count = el('span', { class: 'sec-pages', text: s.error ? '' : `${s.pages.length} 頁` });
      const err = el('p', { class: 'sec-err', text: s.error, hidden: !s.error });
      const li = el('li', { class: 'sec' + (s.error ? ' bad' : ''), style: { '--c': s.color } });
      range.addEventListener('input', () => {
        s.row.text = range.value;
        const r = parsePages(range.value, state.total);
        li.classList.toggle('bad', !!r.error);
        err.hidden = !r.error; err.textContent = r.error;
        count.textContent = r.error ? '' : `${r.pages.length} 頁`;
        thumbs.paint();
        updateStep2Footer();
      });
      li.append(
        el('div', { class: 'sec-row' }, el('span', { class: 'sec-no', text: String(s.index + 1) }), name, el('span', { class: 'sec-ext', text: '.pdf' })),
        el('div', { class: 'sec-row' },
          el('label', { class: 'sec-lbl', for: rid, text: '頁碼' }), range, count,
          iconBtn(ICON_EYE, '預覽這一份', '', () => {
            const cur = sections().find((x) => x.key === s.key);
            if (cur && !cur.error && cur.pages.length) previewPages((safeFile(cur.name) || `第${cur.index + 1}份`) + '.pdf', cur.pages);
            else toast('先填好頁碼才能預覽');
          }),
          iconBtn(ICON_TRASH, '刪除這一份（這些頁不會輸出）', 'danger', () => {
            state.parts = state.parts.filter((r) => r !== s.row);
            partsChanged();
          })),
        err);
      return li;
    }));
    if (!secs.length) $('#sectionList').append(el('li', { class: 'empty', text: '還沒有任何一份。按「＋ 新增一份」開始。' }));
  }

  // ---------- thumbnails ----------
  const thumbs = {
    built: false, queue: [], busy: false, paused: false, urls: [], token: 0, observer: null, done: new Set(),
    invalidate() {
      this.token++;
      for (const u of this.urls) URL.revokeObjectURL(u);
      this.urls = []; this.queue = []; this.done.clear(); this.built = false;
      if (this.observer) this.observer.disconnect();
      $('#thumbs').replaceChildren();
    },
    build() {
      if (this.built) { this.paint(); return; }
      const box = $('#thumbs');
      this.observer = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) this.request(+e.target.dataset.g);
      }, { root: box, rootMargin: '400px' });
      const frag = document.createDocumentFragment();
      for (let g = 0; g < state.total; g++) {
        const th = el('button', { class: 'thumb', type: 'button', 'data-g': g, 'aria-label': `第 ${g + 1} 頁` },
          el('span', { class: 'cutmark', 'aria-hidden': 'true', text: '✂' }),
          el('span', { class: 'sheet' }, el('span', { class: 'tag', hidden: true })),
          el('span', { class: 'pno', text: String(g + 1) }));
        th.addEventListener('click', () => {
          if (g === 0) { toast('從第 2 頁起才能切'); return; }
          splitAt(g);
        });
        frag.append(th);
        this.observer.observe(th);
      }
      box.replaceChildren(frag);
      this.built = true;
      this.paint();
    },
    paint() {
      if (!this.built) return;
      // each page takes the colour of the first output file it belongs to; pages in none are faded
      const owner = new Map(), first = new Map();
      for (const s of sections()) {
        if (s.error) continue;
        s.pages.forEach((g, k) => { if (!owner.has(g)) owner.set(g, s); if (k === 0 && !first.has(g)) first.set(g, s); });
      }
      $$('#thumbs .thumb').forEach((th) => {
        const g = +th.dataset.g;
        const s = owner.get(g);
        if (s) th.style.setProperty('--c', s.color); else th.style.removeProperty('--c');
        th.classList.toggle('off', !s);
        const tag = th.querySelector('.tag');
        const f = first.get(g);
        tag.hidden = !f;
        if (f) { tag.textContent = String(f.index + 1); tag.style.setProperty('--c', f.color); }
        th.classList.toggle('cut-before', !!f && g > 0);
        th.title = !s ? '這一頁不會輸出' : f && g > 0 ? '從這頁開始新的一份（再點一次取消）' : '點一下，從這頁切開';
      });
    },
    request(g) {
      if (this.done.has(g) || this.queue.includes(g)) return;
      this.queue.push(g);
      this.pump();
    },
    async pump() {
      if (this.busy) return;
      this.busy = true;
      const token = this.token;
      try {
        while (this.queue.length && !this.paused && token === this.token) {
          const g = this.queue.shift();
          if (this.done.has(g)) continue;
          this.done.add(g);
          try { await renderThumb(g, token); } catch (e) { console.warn('thumb', g, e); }
        }
      } finally { this.busy = false; }
    },
  };

  async function renderThumb(g, token) {
    const { src, n } = Engine.locate(state.project, g);
    const page = await src.pdf.getPage(n);
    try {
      const vp1 = page.getViewport({ scale: 1 });
      const scale = (176 * Math.min(2, window.devicePixelRatio || 1)) / vp1.width;
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
      c.width = 0; c.height = 0;
      if (token !== thumbs.token || !blob) return;
      const url = URL.createObjectURL(blob);
      thumbs.urls.push(url);
      const th = $(`#thumbs .thumb[data-g="${g}"]`);
      if (!th) return;
      const sheet = th.querySelector('.sheet');
      sheet.style.setProperty('--ar', String(vp1.width / vp1.height));
      sheet.prepend(el('img', { src: url, alt: '' }));
    } finally { page.cleanup(); }
  }

  // ======================= step 3: settings =======================
  const S = {
    target: Core.store.get('target') || '5',
    customMB: parseFloat(Core.store.get('customMB')) || 6,
    mode: Core.store.get('mode') || 'auto',
    format: Core.store.get('format') || 'jpeg',
    dpi: parseInt(Core.store.get('dpi'), 10) || 150,
    quality: parseInt(Core.store.get('quality'), 10) || 75,
    colors: Core.store.get('colors') != null ? parseInt(Core.store.get('colors'), 10) : 256,
    gray: Core.store.get('gray') === '1',
    keepOriginal: Core.store.get('keepOriginal') !== '0',
    lockOut: false, outPw: '',   // a password for the output: never stored, asked again every time
  };
  // 不壓縮: no limit, the pages stay as they are (people come only to take a password off, to merge or to split)
  const targetMB = () => {
    if (S.target === 'none') return Infinity;
    if (S.target === 'custom') return Number.isFinite(S.customMB) && S.customMB >= 0.2 ? Math.min(Math.round(S.customMB * 10) / 10, 500) : 5;
    return parseFloat(S.target);
  };
  // the password as the PDF standard has it (full-width ＡＢＣ１２３ becomes ABC123): what every reader accepts
  const outPassword = () => (S.lockOut ? S.outPw.normalize('NFKC') : '');
  const snapshot = () => (state.splitMode === 'direct'
    ? { targetMB: Infinity, mode: 'auto', format: 'jpeg', dpi: S.dpi, quality: S.quality, colors: S.colors, gray: false, keepOriginal: true, password: outPassword(), direct: true }
    : { targetMB: targetMB(), mode: S.mode, format: S.format, dpi: S.dpi, quality: S.quality, colors: S.colors, gray: S.gray, keepOriginal: S.keepOriginal, password: outPassword() });

  // Coloured part of a slider track (WebKit has no ::range-progress).
  const fill = (r) => r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  // Advanced settings: always shown on desktop; on phones folded away unless they are in use.
  let advSet = false;
  function syncAdv() {
    const adv = $('#adv');
    if (!isPhone()) { adv.open = true; advSet = false; return; }
    if (!advSet) { adv.open = S.mode === 'manual' || S.format === 'png'; advSet = true; }
  }
  window.addEventListener('resize', () => syncAdv());
  function syncSettingsUI() {
    syncAdv();
    const t = document.querySelector(`input[name="target"][value="${S.target}"]`) || document.querySelector('input[name="target"][value="5"]');
    t.checked = true;
    $('#customWrap').hidden = S.target !== 'custom';
    $('#customMB').value = S.customMB;
    document.querySelector(`input[name="mode"][value="${S.mode}"]`).checked = true;
    document.querySelector(`input[name="format"][value="${S.format}"]`).checked = true;
    $('#dpi').value = S.dpi; $('#dpiOut').textContent = S.dpi + ' DPI';
    $('#quality').value = S.quality; $('#qualityOut').textContent = S.quality;
    fill($('#dpi')); fill($('#quality'));
    $('#colors').value = String(S.colors);
    $('#gray').checked = S.gray;
    $('#keepOriginal').checked = S.keepOriginal;
    const none = S.target === 'none';
    for (const n of $$('.compress-only')) n.hidden = none;
    $('#adv').hidden = none;
    $('#targetHelp').textContent = none ? '頁面原封不動：只拿掉密碼、合併或拆分' : '保守計算，上傳系統一定收得下。';
    $('#lockOut').checked = S.lockOut;
    $('#pwSet').hidden = !S.lockOut;
    if (document.activeElement !== $('#outPw')) $('#outPw').value = S.outPw;
    syncPwHelp();
    const manual = S.mode === 'manual';
    $('#rowDpi').hidden = !manual;
    $('#rowQuality').hidden = !manual || S.format !== 'jpeg';
    $('#rowColors').hidden = !manual || S.format !== 'png';
    $('#modeHelp').textContent = manual
      ? '照你設定的數值轉換一次'
      : '自動找出最清楚又放得下的設定';
    $('#formatHelp').textContent = S.format === 'png'
      ? '無損但較大，適合純文字頁'
      : '檔案最小，適合大多數資料';
  }

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.name === 'target') { S.target = t.value; Core.store.set('target', t.value); if (t.value === 'custom') setTimeout(() => $('#customMB').focus(), 0); }
    else if (t.id === 'customMB') { S.customMB = targetMB(); Core.store.set('customMB', String(S.customMB)); }
    else if (t.name === 'mode') { S.mode = t.value; Core.store.set('mode', t.value); }
    else if (t.name === 'format') { S.format = t.value; Core.store.set('format', t.value); }
    else if (t.id === 'colors') { S.colors = parseInt(t.value, 10); Core.store.set('colors', t.value); }
    else if (t.id === 'gray') { S.gray = t.checked; Core.store.set('gray', t.checked ? '1' : '0'); }
    else if (t.id === 'keepOriginal') { S.keepOriginal = t.checked; Core.store.set('keepOriginal', t.checked ? '1' : '0'); }
    else if (t.id === 'lockOut') { S.lockOut = t.checked; if (t.checked) setTimeout(() => $('#outPw').focus(), 0); }
    else return;
    syncSettingsUI();
    renderPlan();
  });
  $('#customMB').addEventListener('input', (ev) => { S.customMB = parseFloat(ev.target.value); Core.store.set('customMB', ev.target.value); renderPlan(); });
  // the password to set is shown while typed (forgetting it locks the person out), hidden on request
  $('#outPw').addEventListener('input', (ev) => { S.outPw = ev.target.value; syncPwHelp(); renderPlan(); });
  function pairEye(input, button) {
    let shown = true;
    const sync = () => {
      input.type = shown ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(shown)); button.setAttribute('aria-label', '顯示密碼');
      button.title = shown ? '隱藏密碼' : '顯示密碼'; button.innerHTML = shown ? EYE_OFF : EYE;
    };
    button.addEventListener('click', () => { shown = !shown; sync(); });
    sync();
  }
  pairEye($('#outPw'), $('#outPwEye'));
  pairEye($('#dPw'), $('#dPwEye'));
  function syncPwHelp() {
    const pw = outPassword();
    for (const help of [$('#pwHelp'), $('#dPwHelp')]) {
      help.hidden = !S.lockOut;
      // full-width letters and digits (a Chinese keyboard's) are the ordinary ones in a PDF password: say which it is
      if (S.lockOut) help.replaceChildren(el('span', { text: pw && pw !== S.outPw ? `密碼會是「${pw}」（全形字當半形）。` : '忘了就打不開，請記下來。' }), el('span', { text: '要上傳學校系統的檔案先別加' }));
    }
  }
  $('#dpi').addEventListener('input', (ev) => { fill(ev.target); S.dpi = parseInt(ev.target.value, 10); $('#dpiOut').textContent = S.dpi + ' DPI'; Core.store.set('dpi', ev.target.value); });
  $('#quality').addEventListener('input', (ev) => { fill(ev.target); S.quality = parseInt(ev.target.value, 10); $('#qualityOut').textContent = S.quality; Core.store.set('quality', ev.target.value); });

  function renderPlan() {
    const plan = outputsPlan();
    if (!plan.length) { $('#plan').replaceChildren(); return; }
    const names = plan.map((p) => p.filename).join('、');
    const box = $('#plan');
    box.title = plan.map((p) => `${p.filename}（${p.label}）`).join('\n');
    void names;
    const needPw = S.lockOut && !outPassword();
    $('#start').disabled = needPw;
    if (needPw) { box.replaceChildren(el('b', { text: '請輸入要設定的密碼' })); return; }
    box.replaceChildren('將輸出 ', el('b', { text: `${plan.length} 個 PDF` }), S.target === 'none' ? '・不壓縮' : `・每個 ${fmtLimit(targetMB())} 以內`, S.lockOut ? '・加上密碼' : '');
  }
  $('#start').addEventListener('click', () => startRun());

  // ======================= step 4: run =======================
  const signature = () => JSON.stringify({ plan: outputsPlan().map((p) => [p.key, p.pages[0], p.pages.length]), s: snapshot() });   // a renamed file isn't a changed one

  async function startRun() {
    if (state.run && state.run.running) return;
    const plan = outputsPlan();
    if (!plan.length) return;
    const settings = snapshot();
    const run = state.run = {
      outputs: plan.map((p) => ({ ...p, status: 'queued', result: null, error: '', settings })),
      job: { cancelled: false, renderTask: null }, running: true, signature: signature(),
    };
    thumbs.paused = true;
    go(4);
    showAd(false);
    for (const o of run.outputs) {
      if (run.job.cancelled || state.run !== run) { o.status = 'cancelled'; continue; }
      await processOne(run, o);
    }
    run.running = false;
    thumbs.paused = false;
    thumbs.pump();
    if (state.run === run) { renderRun(); showAd(true); }
    reportRun(run.outputs.filter((o) => o.status === 'done'));
  }

  // Sponsor slot: big while the files are processing, compact once they are done.
  let stopAd = null;
  async function showAd(compact) {
    if (!window.Ads) return;
    if (stopAd) stopAd();
    const slot = $('#adSlot');
    slot.classList.toggle('after', compact);
    try { stopAd = await Ads.mount(slot, { compact }); } catch { slot.hidden = true; }
  }

  // ---------- the public counter on the home screen ----------
  // Only counts leave the browser (how many files and pages, bytes saved), never any file content.
  const onServer = /^https?:$/.test(location.protocol);
  function reportRun(done, savedOverride) {
    if (!onServer || !done.length) return;
    const pages = done.reduce((a, o) => a + o.pages.length, 0);
    const srcBytes = state.project.sources.reduce((a, s) => a + s.file.size, 0);
    const outBytes = done.reduce((a, o) => a + o.result.size, 0);
    const saved = savedOverride != null ? savedOverride : Math.max(0, Math.round(srcBytes - outBytes));
    const body = { files: done.length, pages, savedBytes: saved };
    fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
      .then(() => loadStats()).catch(() => {});
  }
  let shownFiles = 0;
  async function loadStats() {
    if (!onServer) return;
    let st;
    try { const r = await fetch('api/stats', { cache: 'no-store' }); if (!r.ok) return; st = await r.json(); } catch { return; }
    // Before the first real file the line keeps its default (免費・免註冊・檔案不上傳) instead of showing 0.
    if (!st || !(st.files > 0)) return;
    const gb = st.savedBytes / 1e9;
    const saved = gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(st.savedBytes / 1e6))} MB`;
    const numEl = el('b', { class: 'hero-num', text: shownFiles.toLocaleString('zh-TW') });
    const line = $('#heroCount');
    line.title = `共 ${st.pages.toLocaleString('zh-TW')} 頁，幫大家省下 ${saved}`;
    line.replaceChildren('已幫大家處理 ', numEl, ' 份 PDF', el('span', { class: 'hero-extra', text: `・省下 ${saved}` }));
    countUp(numEl, shownFiles, st.files);
    shownFiles = st.files;
  }
  function countUp(node, from, to) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || to - from < 2) { node.textContent = to.toLocaleString('zh-TW'); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
      node.textContent = Math.round(from + (to - from) * e).toLocaleString('zh-TW');
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  loadStats();

  async function processOne(run, o) {
    o.status = 'running'; o.error = ''; o.lockFailed = false;
    const t0 = performance.now();
    renderCard(o);
    try {
      o.result = o.settings.direct && o.src ? await unlockedCopy(run, o)
        : await Engine.buildOutput(state.project, { title: o.title, pages: o.pages }, o.settings, run.job, (f, text) => progressCard(o, f, text));
      if (o.settings.password) {
        progressCard(o, 0.99, '加上密碼…');
        try {
          const bytes = await PdfCrypt.lock(new Uint8Array(await o.result.blob.arrayBuffer()), o.settings.password);
          Object.assign(o.result, { blob: new Blob([bytes], { type: 'application/pdf' }), size: bytes.length, over: bytes.length > o.settings.targetMB * MB, locked: true });
        } catch (e) { o.lockFailed = true; throw e; }
      }
      o.result.seconds = (performance.now() - t0) / 1000;
      o.status = 'done';
    } catch (e) {
      if (e instanceof Engine.Cancelled || run.job.cancelled) o.status = 'cancelled';
      else { o.status = 'error'; o.error = (e && e.message) || String(e); console.error(e); }
    }
    if (state.run === run) { renderCard(o); renderRunHeader(); }
  }

  // 直接輸出, one file on its own: the whole file with the protection taken off (forms, attachments, everything else
  // stays), or the file itself when it had none. Should it not decrypt here, a copy of its pages as usual.
  async function unlockedCopy(run, o) {
    const src = o.src;
    if (!src.password && !src.perms) return { blob: src.file, size: src.file.size, method: 'original', over: false, missing: [] };
    try {
      progressCard(o, 0.3, '拿掉密碼…');
      const doc = await PdfCrypt.load(new Uint8Array(await src.file.arrayBuffer()), src.password);
      const bytes = await doc.save({ useObjectStreams: true });
      return { blob: new Blob([bytes], { type: 'application/pdf' }), size: bytes.length, method: 'unlocked', over: false, missing: [] };
    } catch (e) {
      console.warn('whole-file decryption failed, copying the pages instead', e);
      return Engine.buildOutput(state.project, { title: o.title, pages: o.pages }, o.settings, run.job, (f, text) => progressCard(o, f, text));
    }
  }

  async function rerunOne(o, patch) {
    const run = state.run;
    if (!run || run.running) return;
    run.running = true;
    run.job = { cancelled: false, renderTask: null };
    o.settings = { ...o.settings, ...patch };
    o.result = null;
    renderRunHeader();
    await processOne(run, o);
    run.running = false;
    renderRunHeader();
    if (o.status === 'done') reportRun([o], 0);
  }

  function renderRun() {
    const run = state.run;
    const box = $('#outputs');
    box.replaceChildren(...run.outputs.map((o) => { o.card = el('article', { class: 'out' }); renderCard(o); return o.card; }));
    renderRunHeader();
  }

  function renderRunHeader() {
    const run = state.run;
    if (!run) return;
    const done = run.outputs.filter((o) => o.status === 'done');
    const over = done.filter((o) => o.result.over).length;
    // 直接輸出 skipped step 3: back goes to step 2
    const direct = run.outputs[0].settings.direct, back = $('#back4');
    back.dataset.goto = direct ? '2' : '3';
    back.setAttribute('aria-label', direct ? '回去修改' : '回去修改設定');
    back.querySelector('.lbl').textContent = direct ? '回去修改' : '回去修改設定';
    const lim = fmtLimit(run.outputs[0].settings.targetMB);
    let text;
    if (run.running) {
      const i = run.outputs.findIndex((o) => o.status === 'running');
      text = run.outputs.length > 1 ? `處理中 ${i + 1}／${run.outputs.length}，請勿關閉分頁` : '處理中，請勿關閉分頁';
    } else if (run.outputs.every((o) => o.status === 'done')) {
      text = over ? `有 ${over} 個檔案超過上限` : '全部完成，先預覽再下載';
    } else if (run.outputs.some((o) => o.status === 'cancelled')) text = '已停止，可以重新處理';
    else text = '有檔案沒有完成';
    $('#runSummary').textContent = text;
    $('#stopRun').hidden = !run.running;
    $('#restart').hidden = run.running;
    $('#zipAll').hidden = run.running || done.length < 2;
    const stale = !run.running && run.signature !== signature();
    $('#staleNote').hidden = !stale;
    $('#rerun').hidden = run.running || !(stale || run.outputs.some((o) => o.status !== 'done'));
  }

  function progressCard(o, f, text) {
    if (!o.card) return;
    const bar = o.card.querySelector('.progress > span');
    const st = o.card.querySelector('.status');
    if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
    if (st && text) st.textContent = text;
  }

  // The text itself (drawn as outlines, as Figma exports do) was over the limit, so the pages became pictures.
  // Say so, and offer the split that would keep the text as text: the most pages per file such that any run of
  // that many pages keeps its text within 60% of the limit (the rest is for the photos).
  function textAdvice(o, r, main) {
    const limit = o.settings.targetMB * MB, w = r.textHeavy.pageText || [], room = limit * 0.6;
    const perPage = r.textHeavy.bytes / r.textHeavy.pages;
    const fitsEvery = (n) => { for (let i = 0; i + n <= w.length || (i === 0 && n > w.length); i++) if (w.slice(i, i + n).reduce((a, b) => a + b, 0) > room) return false; return true; };
    let pages = 0;
    while (pages < w.length && fitsEvery(pages + 1)) pages++;
    main.append(el('p', { class: 'out-hint', text: `文字是外框（像 Figma 匯出的），光文字就有 ${fmtMB(r.textHeavy.bytes)}，所以整頁轉成了圖片` }));
    if (pages >= 1 && pages < r.textHeavy.pages && state.project.sources.length) {
      main.append(el('div', { class: 'out-fixes' }, el('button', { class: 'btn small', type: 'button', text: `改成每 ${pages} 頁一份，文字保持清晰`, onclick: () => splitEvery(pages) })));
    } else if (pages < 1) {
      main.append(el('p', { class: 'out-hint', text: `上限至少要 ${fmtMB(Math.ceil((perPage / 0.7) / 1e5) * 1e5)}，一頁的文字才放得下` }));
    }
  }
  function splitEvery(n) {
    go(2);
    if (state.splitMode !== 'split') $('#chooseSplit').click();
    $('#everyN').value = n;
    $('#applyEvery').click();
  }

  // what happened to passwords: one was set here, or the originals' password or protection is no longer there
  function lockState(o) {
    if (o.result.locked) return '要輸入你設定的密碼才能打開';
    if (o.result.method === 'original') return '';
    const srcs = new Set(o.pages.map((g) => Engine.locate(state.project, g).src));
    if ([...srcs].some((s) => s.password)) return '原本的密碼拿掉了';
    if ([...srcs].some((s) => s.perms)) return '原本的保護拿掉了';
    return '';
  }

  function describeSetting(s) {
    return s.fmt === 'jpeg' ? `${s.dpi} DPI・JPEG 品質 ${Math.round(s.q * 100)}` : `${s.dpi} DPI・PNG ${s.colors ? s.colors + ' 色' : '無損'}`;
  }

  // One calm row per file: status icon · name and size against the limit · one sentence · buttons.
  // Technical details (DPI, quality, links, time) are folded away under 「詳細」.
  const ICONS = {
    ok: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    over: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 7v6"/><circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none"/></svg>',
    error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    lock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
    unlock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.7-1.5"/></svg>',
    pen: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  };
  // a finished file's name, edited in place: Enter or 好 keeps it, Esc goes back. Kept for a re-run, and used by
  // 下載, the ZIP and the preview (the default names are fixed, 備審資料_合併.pdf and so on)
  function editName(o) {
    const title = o.card.querySelector('.out-title');
    const input = el('input', { class: 'out-name-in', value: stripPdf(o.filename), maxlength: '120', spellcheck: 'false', 'aria-label': '新的檔名' });
    const form = el('form', { class: 'out-name-edit' }, input, el('span', { class: 'out-ext', text: '.pdf' }), el('button', { type: 'submit', class: 'btn small primary', text: '好' }));
    const close = (keep) => { if (!form.isConnected) return; if (keep) rename(o, input.value); renderCard(o); };
    form.addEventListener('submit', (e) => { e.preventDefault(); close(true); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(false); } });
    input.addEventListener('blur', () => setTimeout(() => close(true), 150));
    title.replaceChildren(form);
    input.focus();
    input.select();
  }
  function rename(o, text) {
    const name = safeFile(text.replace(/\.pdf$/i, ''));
    if (!name) return;
    const taken = new Set(state.run.outputs.filter((x) => x !== o).map((x) => x.filename.toLowerCase()));
    let file = name + '.pdf';
    for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${name}(${n}).pdf`;
    o.filename = file;
    state.names.set(o.key, file);
  }
  function renderCard(o) {
    const c = o.card;
    if (!c) return;
    const status = el('span', { class: 'out-status', 'aria-hidden': 'true' });
    const title = el('div', { class: 'out-title' }, el('b', { class: 'out-name', title: o.filename }, ...nameParts(o.filename)), el('span', { class: 'out-pages', text: o.label }));
    const main = el('div', { class: 'out-main' }, title);
    const side = el('div', { class: 'out-actions' });
    c.className = 'out';
    c.replaceChildren(status, main, side);
    if (o.status === 'queued' || o.status === 'running' || o.status === 'cancelled') {
      c.classList.add('busy');
      status.append(el('span', { class: o.status === 'running' ? 'spinner' : 'dot-wait' }));
      main.append(el('div', { class: 'status', role: 'status', text: o.status === 'queued' ? '排隊中…' : o.status === 'cancelled' ? '已停止' : '準備中…' }));
      if (o.status === 'running') main.append(el('div', { class: 'progress' }, el('span')));
      return;
    }
    if (o.status === 'error') {
      c.classList.add('over');
      status.innerHTML = ICONS.error;
      main.append(el('p', { class: 'out-msg bad', text: o.lockFailed ? '沒辦法加上密碼' : '沒有完成', title: o.error }),
        el('p', { class: 'out-hint', text: o.lockFailed ? '關掉「加上開啟密碼」再處理一次' : '可改用手動模式再試' }));
      return;
    }
    const r = o.result, st = o.settings;
    const pen = el('button', { type: 'button', class: 'icon-btn sm out-rename', title: '改檔名', 'aria-label': `改「${o.filename}」的檔名`, onclick: () => editName(o) });
    pen.innerHTML = ICONS.pen;
    const nameEl = title.querySelector('.out-name'), row = el('span', { class: 'out-name-row' });
    nameEl.replaceWith(row);
    row.append(nameEl, pen);
    const limit = st.targetMB * MB, noLimit = !Number.isFinite(limit);
    const fits = !r.over;
    c.classList.add(fits ? 'ok' : 'over');
    status.innerHTML = fits ? ICONS.ok : ICONS.over;
    const pct = Math.min(100, (r.size / limit) * 100);
    main.append(el('div', { class: 'out-size' },
      el('b', { class: 'num', text: fmtMB(r.size) }),
      noLimit ? null : el('span', { class: 'out-limit', text: `／ 上限 ${fmtLimit(st.targetMB)}` }),
      noLimit ? null : el('span', { class: 'mini-meter', 'aria-hidden': 'true' }, el('span', { style: { width: pct.toFixed(1) + '%' } }))));
    // the password: the one set here, or the one the original had, gone
    const lockNote = lockState(o);
    if (lockNote) {
      const icon = el('span', { class: 'lk', 'aria-hidden': 'true' });
      icon.innerHTML = r.locked ? ICONS.lock : ICONS.unlock;
      main.append(el('p', { class: 'out-lock' + (r.locked ? ' on' : '') }, icon, lockNote));
    }

    if (fits) {
      const phrase = {
        original: noLimit ? '跟原檔一樣' : '原檔就符合上限',
        lossless: noLimit ? '頁面原封不動' : '保留原始品質',
        unlocked: '其他內容原封不動',
        smart: '文字清晰，只壓縮圖片',
        compressed: r.setting && r.setting.dpi < 96 ? '已轉成圖片，請預覽看小字' : '已轉成圖片',
      }[r.method];
      main.append(el('p', { class: 'out-msg', text: r.smaller ? '轉成圖片反而更大，保留原本的頁面' : phrase }));
      if (r.textHeavy && r.method === 'compressed') textAdvice(o, r, main);
      // text kept sharp at the photos' expense, or the other way round: one click to see the other balance
      if (r.method === 'smart' && r.setting.dpi < 100) {
        main.append(el('p', { class: 'out-hint', text: `為了讓文字保持清晰，照片壓到 ${r.setting.dpi} DPI，可能有點糊` }),
          el('div', { class: 'out-fixes' }, el('button', { class: 'btn small', type: 'button', text: '改成照片優先（文字也轉成圖片）', onclick: () => rerunOne(o, { keepOriginal: false }) })));
      } else if (r.method === 'compressed' && !st.keepOriginal && !r.textHeavy) {
        main.append(el('div', { class: 'out-fixes' }, el('button', { class: 'btn small', type: 'button', text: '改回文字優先', onclick: () => rerunOne(o, { keepOriginal: true }) })));
      }
    } else {
      main.append(el('p', { class: 'out-msg bad', text: `超過上限 ${fmtMB(r.size - limit)}` }));
      const fixes = el('div', { class: 'out-fixes' });
      if (!st.gray) fixes.append(el('button', { class: 'btn small', type: 'button', text: '轉成灰階再壓', onclick: () => rerunOne(o, { gray: true }) }));
      fixes.append(el('button', { class: 'btn small', type: 'button', text: '回去拆小一點', onclick: () => go(2) }));
      main.append(fixes);
    }
    if (!fits && r.textHeavy && r.method === 'compressed') textAdvice(o, r, main);
    if (r.missing && r.missing.length) {
      main.append(el('p', { class: 'out-msg bad', text: '部分文字可能缺漏，請預覽' }));
    }
    const bits = [];
    if (r.method === 'smart') bits.push(`${r.images} 張圖片・${r.setting.dpi} DPI・品質 ${Math.round(r.setting.q * 100)}`);
    if (r.method === 'compressed') bits.push(describeSetting(r.setting));
    if (st.gray && (r.method === 'compressed' || r.method === 'smart')) bits.push('灰階');
    if (r.method !== 'original' && r.method !== 'unlocked') bits.push(r.linkCount ? `保留 ${r.linkCount} 個連結` : '沒有連結');
    bits.push(`原始 ${fmtMB(state.project.sources.reduce((a, s) => a + s.file.size, 0))}`);
    bits.push(`花了 ${r.seconds < 60 ? Math.max(1, Math.round(r.seconds)) + ' 秒' : (r.seconds / 60).toFixed(1) + ' 分鐘'}`);
    main.append(el('details', { class: 'out-more' }, el('summary', { text: '詳細' }), el('ul', {}, bits.map((b) => el('li', { text: b })))));

    side.append(
      el('button', { class: 'btn', type: 'button', text: '預覽', title: '在新分頁全螢幕預覽', onclick: () => openViewer(o) }),
      el('button', { class: 'btn primary', type: 'button', text: '下載', onclick: () => download(r.blob, o.filename) }));
  }

  $('#stopRun').addEventListener('click', () => {
    const run = state.run;
    if (!run) return;
    run.job.cancelled = true;
    try { run.job.renderTask && run.job.renderTask.cancel(); } catch { /* ignore */ }
  });
  $('#rerun').addEventListener('click', () => startRun());
  $('#zipAll').addEventListener('click', async () => {
    const done = state.run.outputs.filter((o) => o.status === 'done');
    const btn = $('#zipAll');
    btn.disabled = true;
    try {
      const zip = await Engine.makeZip(done.map((o) => ({ name: o.filename, blob: o.result.blob })));
      download(zip, `${baseName()}_備審資料.zip`);
    } finally { btn.disabled = false; }
  });
  $('#restart').addEventListener('click', () => {
    for (const s of state.sources) if (s.pdf) s.pdf.destroy();
    state.sources = [];
    state.splitMode = 'single';
    sourcesChanged();
    go(1);
  });

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  // ======================= viewer in a new tab =======================
  // The viewer asks for its document with postMessage; we answer with the files themselves.
  const viewers = new Map();
  function viewerPages(pages) {
    const p = state.project;
    return pages.map((g) => { const { src, n } = Engine.locate(p, g); return [p.sources.indexOf(src), n]; });
  }
  function openViewerWith(payload) {
    const w = window.open('viewer.html', '_blank');
    if (!w) { toast('請允許彈出視窗後再預覽'); return; }
    viewers.set(w, payload);
  }
  const sourcesPayload = () => state.project.sources.map((s) => ({ file: s.file, password: s.password || '' }));
  // A processed file, with the original pages alongside for comparison.
  function openViewer(o) {
    openViewerWith({ type: 'load', title: o.filename, out: o.result.blob, outPassword: o.result.locked ? o.settings.password : '', compare: o.result.method === 'compressed' || o.result.method === 'smart', sources: sourcesPayload(), pages: viewerPages(o.pages) });
  }
  // Pages of the original files before anything is processed (step 2 previews).
  function previewPages(title, pages) {
    openViewerWith({ type: 'load', title, out: null, draft: true, sources: sourcesPayload(), pages: viewerPages(pages) });
  }
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'viewer-ready') return;
    const payload = viewers.get(e.source);
    if (!payload) return;
    e.source.postMessage(payload, '*');   // kept in the map so a reload of the viewer tab still works
  });

  // ======================= drag & drop =======================
  const drop = $('#drop');
  const input = $('#fileInput');
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'dragend', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('is-over')));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (state.step !== 1) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.run && state.run.running) { e.preventDefault(); e.returnValue = ''; }
  });

  renderSources();
  renderStepper();
  // Hook for automated checks.
  window.__bspdf = { state, addFiles, go, splitAt, startRun, S, syncSettingsUI, outputsPlan };
})();
