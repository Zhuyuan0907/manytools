/* 影片碼率壓縮 — everything runs in this browser tab.
   Reading/demuxing/muxing: Mediabunny. Decoding/encoding: the browser's WebCodecs (hardware when available).
   Nothing about the video leaves the computer; on a server only the counts (files, seconds, bytes saved) are sent.
   Four steps: 1 drop files → 2 read each file's details → 3 settings + estimate → 4 encode and save. */
(() => {
  'use strict';
  const MB = window.Mediabunny;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    n.append(...kids.filter((k) => k != null && k !== false));
    return n;
  };
  const onServer = /^https?:$/.test(location.protocol);
  if (onServer) $('#brand').href = '/';

  // ---------- formatting ----------
  const fmtBytes = (b) => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
  const mbps = (bps) => bps >= 1e8 ? String(Math.round(bps / 1e6)) : (bps / 1e6).toFixed(1).replace(/\.0$/, '');
  const fmtRate = (bps) => bps >= 1e6 ? `${mbps(bps)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
  const fmtDur = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
  };
  const fmtFps = (f) => {
    if (!f) return '—';
    for (const [n, label] of [[23.976, '23.98'], [29.97, '29.97'], [59.94, '59.94'], [119.88, '119.88']]) if (Math.abs(f - n) < 0.02) return label;
    return String(Math.round(f * 100) / 100);
  };
  const pct = (a, b) => Math.max(0, Math.round((1 - a / b) * 100));

  // avc1.PPCCLL / hvc1.P.x.Lnnn → readable profile names; broadcast people care about 4:2:2 / 10-bit.
  function describeCodec(codec, str) {
    if (codec === 'avc' && str && /^avc[13]\.[0-9a-f]{6}/i.test(str)) {
      const p = parseInt(str.slice(5, 7), 16), lv = parseInt(str.slice(9, 11), 16) / 10;
      const prof = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' }[p] || `Profile ${p}`;
      return { name: 'H.264', detail: `${prof} @ L${lv}`, deep: p >= 110 };
    }
    if (codec === 'hevc' && str) {
      const m = /^(?:hvc1|hev1)\.[A-C]?(\d+)\.[^.]*\.([LH])(\d+)/i.exec(str);
      if (m) {
        const prof = { 1: 'Main', 2: 'Main 10', 3: 'Main Still', 4: 'Range Ext' }[m[1]] || `Profile ${m[1]}`;
        return { name: 'H.265', detail: `${prof} @ L${(+m[3] / 30).toFixed(1).replace(/\.0$/, '')}`, deep: +m[1] !== 1 };
      }
      return { name: 'H.265', detail: '', deep: false };
    }
    const names = { avc: 'H.264', hevc: 'H.265', prores: 'ProRes', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', mpeg2: 'MPEG-2' };
    return { name: names[codec] || (codec ? codec.toUpperCase() : '不支援'), detail: '', deep: false };
  }
  function describeAudio(codec) {
    if (!codec) return '不支援';
    if (codec.startsWith('pcm')) {
      const m = /pcm-([suf])(\d+)/.exec(codec);
      return m ? `LPCM ${m[2]}-bit${m[1] === 'f' ? ' float' : ''}` : 'LPCM';
    }
    return { aac: 'AAC', mp3: 'MP3', opus: 'Opus', ac3: 'AC-3', eac3: 'E-AC-3', flac: 'FLAC', vorbis: 'Vorbis', dts: 'DTS' }[codec] || codec.toUpperCase();
  }
  const chLabel = (n) => ({ 1: '單聲道', 2: '立體聲' }[n] || `${n} 聲道`);
  function colorInfo(cs, hdr) {
    if (hdr) return ['HDR', cs && cs.transfer === 'arib-std-b67' ? 'HLG' : 'PQ'];
    if (cs && cs.primaries === 'bt2020') return ['SDR', 'BT.2020'];
    return ['SDR', 'BT.709'];
  }
  function resName(w, h) {
    const s = Math.min(w, h), l = Math.max(w, h), v = h > w ? '直式 ' : '';
    if (s >= 2160) return v + (l >= 4096 ? 'DCI 4K' : '4K UHD');
    if (s >= 1080) return v + 'Full HD';
    if (s >= 720) return v + 'HD';
    return v + 'SD';
  }

  // ---------- browser support ----------
  const support = $('#support');
  const hasCodecs = !!(window.VideoEncoder && window.VideoDecoder && MB);
  if (!MB) {
    support.textContent = '程式檔案不完整，請重新下載整個資料夾。';
    support.hidden = false;
  } else if (!hasCodecs) {
    support.textContent = window.isSecureContext === false
      ? '影片編碼只能在 https 網址使用，請用正式網址開啟這個頁面。'
      : '這個瀏覽器不支援影片編碼。請改用最新版的 Chrome 或 Edge。';
    support.hidden = false;
  }
  const canPickFolder = typeof window.showDirectoryPicker === 'function';

  // H.265 encoding depends on the computer's hardware; disable the choice when it isn't there.
  (async () => {
    if (!hasCodecs) return;
    let ok = false;
    try { ok = await MB.canEncodeVideo('hevc', { width: 1920, height: 1080, quality: new MB.Quality({ bitrate: 12e6 }) }); } catch {}
    if (!ok) {
      $('#hevcOpt input').disabled = true;
      $('#codecHelp').textContent = '這台電腦不支援 H.265 編碼，請用 H.264';
    }
  })();

  // ---------- state ----------
  const S = { step: 1, items: [], sel: null, running: false, hasRun: false, stop: false, dir: null, queue: [], t0: 0 };
  let nextId = 1;
  const valid = (it) => it.status === 'ready';

  function settings() {
    return {
      rate: Math.max(0.5, parseFloat($('#rate').value) || 12) * 1e6,
      mode: $('input[name=mode]:checked').value,
      codec: $('input[name=codec]:checked').value,
      res: $('#res').value === '0' ? null : $('#res').value.split('x').map(Number),
      gop: +$('#gop').value,
      audio: $('#audio').value,
      fmt: $('#fmt').value,
    };
  }

  // ---------- steps ----------
  const STEP_NAMES = ['放入影片', '影片資訊', '壓縮設定', '處理與下載'];
  function allowed(n) {
    if (S.running) return n === 4;
    if (n === 1) return true;
    if (n === 2) return S.items.length > 0;
    if (n === 3) return S.items.some(valid);
    return S.hasRun;
  }
  function goto(n) {
    if (!allowed(n)) return;
    S.step = n;
    for (let i = 1; i <= 4; i++) $(`#step${i}`).hidden = i !== n;
    render();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b && !b.disabled) goto(+b.dataset.goto);
  });
  function renderStepper() {
    for (const b of $$('.stepper button')) {
      const n = +b.dataset.goto;
      b.classList.toggle('current', n === S.step);
      b.classList.toggle('done', n < S.step || (n === 4 && S.hasRun && !S.running && S.step !== 4));
      b.disabled = !allowed(n);
      b.setAttribute('aria-current', n === S.step ? 'step' : 'false');
    }
    $('#mStep').replaceChildren(`步驟 ${S.step}／4・`, el('b', { text: STEP_NAMES[S.step - 1] }));
  }
  function render() {
    renderStepper();
    if (S.step === 1) renderStep1();
    if (S.step === 2) renderStep2();
    if (S.step === 3) renderStep3();
    if (S.step === 4) renderStep4();
  }

  // ---------- step 1: adding files ----------
  const drop = $('#drop'), fileInput = $('#fileInput');
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addFiles(e.dataTransfer.files); });
  // Dropping a file anywhere else on the page adds it too, instead of the browser opening it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (!S.running && e.dataTransfer) addFiles(e.dataTransfer.files); });
  $('#addMore').addEventListener('click', () => fileInput.click());
  $('#next1').addEventListener('click', () => goto(2));

  function addFiles(list) {
    if (S.running) return;
    let first = null;
    for (const file of list) {
      if (S.items.some((it) => it.file.name === file.name && it.file.size === file.size)) continue;
      const it = { id: nextId++, file, status: 'loading', info: null, error: '', thumb: null, run: null, result: null };
      S.items.push(it);
      first = first || it;
      probe(it);
    }
    if (!first) return;
    S.sel = first;
    render();
  }

  function removeItem(it) {
    if (S.running) return;
    const i = S.items.indexOf(it);
    S.items.splice(i, 1);
    try { it.input && it.input.dispose(); } catch {}
    if (it.result && it.result.url) URL.revokeObjectURL(it.result.url);
    if (S.sel === it) S.sel = S.items[Math.min(i, S.items.length - 1)] || null;
    if (!S.items.length) goto(1); else render();
  }

  function srcMeta(it) {
    if (it.status === 'loading') return '讀取中…';
    if (it.status === 'error') return it.short || '無法處理';
    return `${fmtBytes(it.file.size)}・${it.info.format}・${fmtDur(it.info.duration)}・${fmtRate(it.info.vRate)}`;
  }
  function renderStep1() {
    const n = S.items.length;
    $('#step1').classList.toggle('has-files', n > 0);
    $('#sources').replaceChildren(...S.items.map((it, k) => el('li', { class: 'src' },
      el('span', { class: 'src-no', text: k + 1 }),
      el('span', { class: 'src-text' },
        el('span', { class: 'src-name', text: it.file.name, title: it.file.name }),
        el('span', { class: `src-meta${it.status === 'error' ? ' bad' : ''}`, text: srcMeta(it), title: it.error || srcMeta(it) })),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': `移除 ${it.file.name}`, title: '移除', text: '×', onclick: () => removeItem(it) }))));
    const size = S.items.reduce((a, it) => a + it.file.size, 0);
    $('#note1').textContent = n ? `${n} 支影片・共 ${fmtBytes(size)}` : '還沒有加入影片。';
    $('#next1').disabled = !n;
  }

  // the counter line in the hero, like the PDF tool's: only totals, never anything about a file
  let shownFiles = 0;
  async function loadStats() {
    if (!onServer) return;
    let st;
    try { const r = await fetch('api/stats', { cache: 'no-store' }); if (!r.ok) return; st = await r.json(); } catch { return; }
    if (!st || !(st.files > 0)) return;
    const gb = st.savedBytes / 1e9;
    const saved = gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(st.savedBytes / 1e6))} MB`;
    const num = el('b', { class: 'hero-num', text: shownFiles.toLocaleString('zh-TW') });
    $('#heroCount').replaceChildren('已幫大家處理 ', num, ' 支影片', el('span', { class: 'hero-extra', text: `・省下 ${saved}` }));
    countUp(num, shownFiles, st.files);
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

  // ---------- reading the file's details ----------
  async function probe(it) {
    const ext = (it.file.name.split('.').pop() || '').toLowerCase();
    try {
      if (!MB) throw new Error('程式檔案不完整');
      const input = new MB.Input({ source: new MB.BlobSource(it.file), formats: MB.ALL_FORMATS });
      it.input = input;
      if (!(await input.canRead())) {
        it.short = ext === 'mxf' ? 'MXF 格式目前不支援' : '看不懂這個檔案';
        throw new Error(ext === 'mxf'
          ? 'MXF 格式目前不支援。請在機器上改錄 MP4（XAVC S / HS），或先轉成 MOV / MP4。'
          : '看不懂這個檔案，可能不是影片，或是不支援的格式。');
      }
      const format = await input.getFormat();
      const isTs = format.name === 'MPEG Transport Stream';
      const duration = await input.computeDuration();
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) { it.short = '沒有影像'; throw new Error('這個檔案裡沒有影像。'); }
      const aTracks = await input.getAudioTracks();

      // Transport streams have no sample table, so sample the first few thousand packets instead of the whole file.
      const vStats = await vt.computePacketStats(isTs ? 3000 : undefined);
      const vCodec = await vt.getCodec();
      const vStr = await vt.getCodecParameterString();
      const cs = await vt.getColorSpace().catch(() => null);
      const hdr = await vt.hasHighDynamicRange().catch(() => false);
      const audio = [];
      for (const at of aTracks) {
        const codec = await at.getCodec();
        let rate = 0;
        try { rate = (await at.computePacketStats(isTs ? 1500 : undefined)).averageBitrate; } catch {}
        audio.push({ codec, channels: await at.getNumberOfChannels(), sampleRate: await at.getSampleRate(), rate });
      }
      it.info = {
        format: format.name === 'QuickTime File Format' ? 'MOV' : isTs ? 'MTS' : format.name,
        isMov: format.name === 'QuickTime File Format',
        duration,
        overall: duration > 0 ? (it.file.size * 8) / duration : 0,
        codec: describeCodec(vCodec, vStr),
        width: await vt.getDisplayWidth(), height: await vt.getDisplayHeight(),
        fps: vStats.averagePacketRate,
        vRate: vStats.averageBitrate,
        cs, hdr,
        canDecode: await vt.canDecode(),
        audio,
      };
      it.status = it.info.canDecode ? 'ready' : 'error';
      if (!it.info.canDecode) { it.short = '這台電腦無法解碼'; it.error = `這台電腦的瀏覽器無法解碼這種影像（${it.info.codec.name} ${it.info.codec.detail}）。`; }
      render();
      if (it.info.canDecode) await thumbnail(it, vt, duration);
    } catch (e) {
      it.status = 'error';
      it.error = e && e.message ? e.message : String(e);
    }
    render();
  }

  async function thumbnail(it, vt, duration) {
    try {
      const sink = new MB.CanvasSink(vt, { width: 320, height: 180, fit: 'contain' });
      const start = await vt.getFirstTimestamp().catch(() => 0);
      const w = await sink.getCanvas(start + Math.min(duration * 0.1, 3));
      if (!w) return;
      const c = document.createElement('canvas');
      c.width = 320; c.height = 180;
      c.getContext('2d').drawImage(w.canvas, 0, 0, 320, 180);
      it.thumb = c;
    } catch {}
  }
  function thumbCanvas(it, w, h, cls) {
    const c = el('canvas', { class: cls, width: w, height: h, 'aria-hidden': 'true' });
    if (it.thumb) c.getContext('2d').drawImage(it.thumb, 0, 0, w, h);
    return c;
  }

  // ---------- step 2: details ----------
  $('#next2').addEventListener('click', () => goto(3));
  function renderStep2() {
    const list = $('#flist');
    list.replaceChildren(...S.items.map((it) => {
      const sub = it.status === 'loading' ? '讀取中…'
        : it.status === 'error' ? '無法處理'
        : null;
      return el('li', {},
        el('div', { class: `fitem${S.sel === it ? ' on' : ''}${it.status === 'error' ? ' err' : ''}`, role: 'button', tabindex: '0', 'aria-pressed': String(S.sel === it),
          onclick: () => { S.sel = it; renderStep2(); },
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.sel = it; renderStep2(); } } },
          thumbCanvas(it, 128, 72),
          el('span', { class: 'fi-text' },
            el('span', { class: 'fi-name', text: it.file.name, title: it.file.name }),
            sub ? el('span', { class: 'fi-sub', text: sub })
              : el('span', { class: 'fi-sub' }, el('b', { text: fmtRate(it.info.vRate) }), `・${it.info.height}p・${fmtDur(it.info.duration)}`)),
          el('button', { type: 'button', class: 'icon-btn', 'aria-label': `移除 ${it.file.name}`, title: '移除', text: '×',
            onclick: (e) => { e.stopPropagation(); removeItem(it); } })));
    }));
    renderDetail(S.sel);
    const ok = S.items.filter(valid), loading = S.items.filter((it) => it.status === 'loading').length;
    const size = S.items.reduce((a, it) => a + it.file.size, 0);
    $('#note2').replaceChildren(el('b', { text: `${S.items.length} 支影片` }), `・共 ${fmtBytes(size)}`, loading ? `・${loading} 支讀取中` : '');
    $('#next2').disabled = !ok.length || loading > 0;
  }

  function renderDetail(it) {
    const box = $('#detail');
    if (!it) { box.replaceChildren(); return; }
    if (it.status === 'loading') { box.replaceChildren(el('p', { class: 'd-loading', text: '正在讀取影片資訊…' })); return; }
    const i = it.info;
    const head = el('div', { class: 'd-head' },
      el('span', { class: 'd-name', text: it.file.name, title: it.file.name }),
      el('span', { class: 'd-meta', text: i ? `${i.format}・${fmtBytes(it.file.size)}・${fmtDur(i.duration)}` : fmtBytes(it.file.size) }));
    if (it.status === 'error' && !i) {
      box.replaceChildren(el('div', { class: 'd-top' }, thumbCanvas(it, 320, 180, 'd-thumb'), head), el('p', { class: 'd-msg bad', text: it.error }));
      return;
    }
    const s = settings();
    const est = estimate(it, s);
    head.append(
      el('span', { class: 'd-rate-label', text: '影像碼率' }),
      el('span', { class: 'd-rate' }, mbps(i.vRate), el('small', { text: 'Mbps' })),
      s.rate < i.vRate * 0.97
        ? el('span', { class: 'd-sub' }, el('span', { text: `壓到 ${mbps(s.rate)} Mbps，` }), el('span', { text: `大約可以省下 ${pct(est, it.file.size)}%` }))
        : el('span', { class: 'd-sub' }, el('span', { text: `目前設定的 ${mbps(s.rate)} Mbps，` }), el('span', { text: '沒有比原始低' })));
    const [cName, cSub] = colorInfo(i.cs, i.hdr);
    const tile = (label, value, sub) => el('div', {}, el('dt', { text: label }), el('dd', { title: value }, value, el('small', { text: sub || ' ' })));
    const tiles = el('dl', { class: 'tiles' },
      tile('解析度', `${i.width} × ${i.height}`, resName(i.width, i.height)),
      tile('幀率', `${fmtFps(i.fps)} fps`),
      tile('影像編碼', i.codec.name, i.codec.detail),
      tile('色彩', cName, cSub),
      tile('長度', fmtDur(i.duration)),
      tile('檔案大小', fmtBytes(it.file.size)),
      tile('封裝格式', i.format),
      tile('整體碼率', fmtRate(i.overall), '含聲音'));
    const audio = el('div', { class: 'audio-row' }, el('span', { class: 'a-label', text: '聲音' }),
      ...(i.audio.length ? i.audio.map((a, n) => el('span', { class: 'atrack' },
        i.audio.length > 1 ? el('span', { class: 'a-no', text: n + 1 }) : null,
        el('b', { text: describeAudio(a.codec) }),
        el('span', { text: [chLabel(a.channels), a.sampleRate ? `${a.sampleRate / 1000} kHz` : '', a.rate ? fmtRate(a.rate) : ''].filter(Boolean).join('・') })))
        : [el('span', { class: 'atrack' }, el('span', { text: '沒有聲音' }))]));
    const kids = [el('div', { class: 'd-top' }, thumbCanvas(it, 320, 180, 'd-thumb'), head, audio), tiles];
    if (it.status === 'error') kids.splice(1, 0, el('p', { class: 'd-msg bad', text: it.error }));
    else if (i.hdr || i.codec.deep) kids.splice(1, 0, el('p', { class: 'd-msg warn', text: `這是 ${i.hdr ? 'HDR' : '10-bit / 4:2:2'} 素材，輸出會轉成 8-bit 4:2:0${i.hdr ? ' SDR' : ''}。` }));
    box.replaceChildren(...kids);
  }

  // ---------- step 3: settings + estimate ----------
  // A big number with −/+, and a slider from 1 Mbps to a little above the highest source bitrate,
  // with a tick where the original sits.
  const rateInput = $('#rate'), rateRange = $('#rateRange'), slider = $('.rate-slider');
  let rateTouched = false;
  const clampRate = (v) => Math.min(400, Math.max(0.5, Math.round(v * 2) / 2));
  function paintSlider() {
    const min = +rateRange.min, max = +rateRange.max, v = Math.min(max, Math.max(min, +rateRange.value));
    slider.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
  }
  function syncRate(v, from, byUser = true) {
    v = clampRate(v);
    if (byUser) rateTouched = true;
    if (from !== 'input') rateInput.value = v;
    if (from !== 'range') rateRange.value = v;
    paintSlider();
    if (S.step === 3) renderStep3();
  }
  function layoutSlider(maxSrc, count) {
    const src = maxSrc / 1e6;
    const max = src > 0 && Number.isFinite(src) ? Math.max(10, Math.ceil((src * 1.25) / 5) * 5) : 30;
    if (+rateRange.max !== max) {
      rateRange.max = max;
      $('#scaleMax').textContent = `${max} Mbps`;
      rateRange.value = Math.min(max, +rateInput.value);
    }
    const mark = $('#srcMark');
    mark.hidden = !(src > 0 && Number.isFinite(src));
    if (!mark.hidden) {
      mark.style.setProperty('--m', Math.min(1, (src - 1) / (max - 1)));
      $('#srcMarkText').textContent = `${count > 1 ? '原始最高' : '原始'} ${mbps(maxSrc)}`;
    }
    paintSlider();
  }
  rateInput.addEventListener('input', () => { const v = parseFloat(rateInput.value); if (v > 0) syncRate(v, 'input'); });
  rateInput.addEventListener('change', () => syncRate(parseFloat(rateInput.value) || 12));
  rateRange.addEventListener('input', () => syncRate(+rateRange.value, 'range'));
  for (const b of $$('.nudge')) b.addEventListener('click', () => syncRate((parseFloat(rateInput.value) || 12) + +b.dataset.nudge));
  for (const n of $$('.settings input[type=radio], .settings select')) n.addEventListener('change', renderStep3);
  syncRate(12, null, false);

  // Camera rates are exact fractions (60000/1001…); the measured average is a hair off, so snap to the nearest one.
  const STD_FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 100, 120000 / 1001, 120];
  function snapFps(f) {
    if (!(f > 0)) return 0;
    const best = STD_FPS.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
    return Math.abs(best - f) / best < 0.003 ? best : f;
  }
  // An exact output size. When the picture's shape differs (a landscape clip into 1080×1920, 16:9 into DCI),
  // it's fitted whole with black bars rather than stretched or cropped.
  function outputDims(i, s) {
    if (!s.res) return null;
    const [width, height] = s.res;
    if (width === i.width && height === i.height) return null;
    const same = Math.abs(width / height - i.width / i.height) < 0.01;
    return { width, height, fit: same ? 'fill' : 'contain', bars: !same, bigger: width * height > i.width * i.height * 1.01 };
  }
  function audioRate(i, s) {
    if (s.audio === 'none') return 0;
    if (s.audio === 'aac') return i.audio.length * 320e3;
    return i.audio.reduce((a, t) => a + (t.rate || 0), 0);
  }
  const estimate = (it, s) => ((s.rate + audioRate(it.info, s)) * it.info.duration) / 8 * 1.01;
  function plan(it, s) {
    const i = it.info;
    const notes = [];
    let skip = false;
    if (s.rate >= i.vRate * 0.97) { notes.push(['bad', `原始只有 ${fmtRate(i.vRate)}，目標要更低才會變小，這支會跳過`]); skip = true; }
    else if (s.rate < i.vRate * 0.2) notes.push(['warn', '不到原始的 2 成，畫面可能明顯變糊，建議先試一支']);
    if (i.hdr || i.codec.deep) notes.push(['warn', `${i.hdr ? 'HDR' : '10-bit / 4:2:2'} 素材會轉成 8-bit 4:2:0${i.hdr ? ' SDR' : ''}`]);
    if (!canPickFolder && it.file.size > 1.5e9) notes.push(['warn', '大檔案會佔用很多記憶體，建議改用 Chrome 或 Edge']);
    const dims = outputDims(i, s);
    if (dims && dims.bars) notes.push(['warn', (i.height > i.width) !== (dims.height > dims.width)
      ? `原始是${i.height > i.width ? '直式' : '橫式'} ${i.width}×${i.height}，輸出會加上黑邊` : `原始比例是 ${i.width}×${i.height}，輸出會加上黑邊`]);
    if (dims && dims.bigger) notes.push(['warn', `比原始的 ${i.width}×${i.height} 大，畫質不會變好`]);
    return { est: estimate(it, s), notes, skip };
  }
  const todoList = (s) => S.items.filter((it) => valid(it) && !plan(it, s).skip);

  function renderStep3() {
    if (S.step !== 3) return;
    const s = settings();
    const ok = S.items.filter(valid);
    const rates = ok.map((it) => it.info.vRate);
    // Until the user picks a number: 12 Mbps, or 6 成 of the lowest source when 12 wouldn't shrink anything.
    if (!rateTouched && rates.length && s.rate >= Math.min(...rates) * 0.97) {
      syncRate(Math.max(1, Math.round(Math.min(...rates) * 0.6 / 1e6)), null, false);
      return;
    }
    layoutSlider(rates.length ? Math.max(...rates) : 0, rates.length);

    const todo = todoList(s);
    const src = todo.reduce((a, it) => a + it.file.size, 0), est = todo.reduce((a, it) => a + plan(it, s).est, 0);
    const cell = (label, value, cls) => el('div', cls ? { class: cls } : {}, el('dt', { text: label }), el('dd', { text: value }));
    $('#total').replaceChildren(
      cell(todo.length > 1 ? `原始（${todo.length} 支）` : '原始大小', todo.length ? fmtBytes(src) : '—'),
      cell('預估輸出', todo.length ? fmtBytes(est) : '—'),
      cell('省下', todo.length ? `${pct(est, src)}%` : '—', 'big'));
    $('#plist').replaceChildren(...ok.map((it) => {
      const p = plan(it, s), dims = outputDims(it.info, s);
      return el('li', { class: `pitem${p.skip ? ' skip' : ''}` },
        el('span', { class: 'p-name', text: it.file.name, title: it.file.name }),
        el('span', { class: 'p-rate' }, `${mbps(it.info.vRate)} → `, el('b', { text: `${mbps(s.rate)} Mbps` }), dims ? `・${dims.width}×${dims.height}` : ''),
        el('span', { class: 'p-size' }, p.skip ? '跳過' : fmtBytes(p.est), p.skip ? null : el('small', { text: `-${pct(p.est, it.file.size)}%` })),
        ...p.notes.map(([cls, t]) => el('span', { class: `p-note ${cls}`, text: t, title: t })));
    }));
    $('#note3').textContent = !todo.length ? '沒有可以壓縮的影片，請把目標碼率調低'
      : canPickFolder ? '按下開始後，選一個存放的資料夾' : '壓好會自動下載';
    $('#runAll').disabled = !todo.length || !hasCodecs;
    $('#runAll').textContent = todo.length > 1 ? `開始壓縮 ${todo.length} 支 →` : '開始壓縮 →';
  }

  // ---------- step 4: running ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  $('#runAll').addEventListener('click', async () => {
    const s = settings();
    const todo = todoList(s);
    if (!todo.length || S.running) return;
    // One folder for the whole batch, so multi-GB files stream straight to disk instead of into memory.
    let dir = null;
    if (canPickFolder) {
      try { dir = await window.showDirectoryPicker({ id: 'manytools-video-out', mode: 'readwrite', startIn: 'videos' }); }
      catch (e) { if (e && e.name === 'AbortError') { toast('沒有選擇存放的資料夾，已取消'); return; } dir = null; }
    }
    for (const it of S.items) { if (it.result && it.result.url) URL.revokeObjectURL(it.result.url); it.run = null; it.result = null; }
    for (const it of todo) { it.run = 'wait'; it.progress = 0; }
    Object.assign(S, { running: true, hasRun: true, stop: false, dir, queue: todo, t0: performance.now(), settings: s });
    goto(4);
    for (const it of todo) {
      if (S.stop) { it.run = 'stopped'; continue; }
      await runOne(it, s, dir);
      renderStep4();
    }
    S.running = false;
    render();
    const done = todo.filter((it) => it.run === 'done');
    if (done.length) toast(dir ? `完成 ${done.length} 支，已存到「${dir.name}」` : `完成 ${done.length} 支`);
  });
  $('#stopRun').addEventListener('click', () => {
    S.stop = true;
    const cur = S.queue.find((it) => it.run === 'running');
    if (cur && cur.conversion) cur.conversion.cancel().catch(() => {});
  });
  $('#restart').addEventListener('click', () => {
    for (const it of S.items) { try { it.input && it.input.dispose(); } catch {} if (it.result && it.result.url) URL.revokeObjectURL(it.result.url); }
    Object.assign(S, { items: [], sel: null, hasRun: false, queue: [] });
    goto(1);
  });

  function outName(it, s, ext) {
    const base = it.file.name.replace(/\.[^.]+$/, '');
    return `${base}_${mbps(s.rate)}M.${ext}`;
  }
  async function freeName(dir, name) {
    const dot = name.lastIndexOf('.');
    for (let n = 1; n < 100; n++) {
      const cand = n === 1 ? name : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
      try { await dir.getFileHandle(cand); } catch { return cand; }
    }
    return name;
  }

  async function runOne(it, s, dir) {
    const i = it.info;
    it.run = 'running'; it.progress = 0; it.speed = 0; it.err = '';
    renderStep4();
    const useMov = s.fmt === 'mov' || (s.fmt === 'auto' && i.isMov);
    let name = outName(it, s, useMov ? 'mov' : 'mp4'), fileHandle = null, writable = null, target;
    const t0 = performance.now();
    try {
      if (dir) {
        name = await freeName(dir, name);
        fileHandle = await dir.getFileHandle(name, { create: true });
        writable = await fileHandle.createWritable();
        target = new MB.StreamTarget(writable, { chunked: true });
      } else {
        target = new MB.BufferTarget();
      }
      const fastStart = dir ? false : 'in-memory';
      const format = useMov ? new MB.MovOutputFormat({ fastStart }) : new MB.Mp4OutputFormat({ fastStart });
      const output = new MB.Output({ format, target });
      const video = {
        codec: s.codec,
        quality: new MB.Quality({ bitrate: Math.round(s.rate), bitrateMode: s.mode }),
        keyFrameInterval: s.gop,
        forceTranscode: true,
      };
      // Without a frame rate the browser's encoder assumes 30 fps and a 59.94p file comes out at twice the bitrate.
      const fps = snapFps(i.fps);
      if (fps) video.frameRate = fps;
      const dims = outputDims(i, s);
      if (dims) Object.assign(video, { width: dims.width, height: dims.height, fit: dims.fit });
      const audio = s.audio === 'none' ? { discard: true }
        : s.audio === 'aac' ? { codec: 'aac', quality: new MB.Quality({ bitrate: 320e3 }), forceTranscode: true }
        : {};
      const conv = await MB.Conversion.init({ input: it.input, output, video, audio, showWarnings: false });
      if (!conv.isValid || !conv.utilizedTracks.some((t) => t.isVideoTrack())) {
        const r = conv.discardedTracks.find((d) => d.track.isVideoTrack());
        throw new Error(r && r.reason === 'no_encodable_target_codec'
          ? `這台電腦無法用 ${s.codec === 'hevc' ? 'H.265' : 'H.264'} 編碼這個解析度，請換編碼格式或調低解析度`
          : r && r.reason === 'undecodable_source_codec' ? '這台電腦的瀏覽器無法解碼這種影像' : '這支影片無法轉換');
      }
      it.conversion = conv;
      if (S.stop) await conv.cancel();
      conv.onProgress = (p, t) => {
        const secs = (performance.now() - t0) / 1000;
        it.progress = p;
        it.speed = secs > 1 ? t / secs : 0;
        progressTick(it);
      };
      await conv.execute();
      const seconds = (performance.now() - t0) / 1000;
      let size, url = null;
      if (dir) size = (await fileHandle.getFile()).size;
      else {
        const blob = new Blob([target.buffer], { type: useMov ? 'video/quicktime' : 'video/mp4' });
        size = blob.size;
        url = URL.createObjectURL(blob);
        el('a', { href: url, download: name }).click();
      }
      it.run = 'done';
      it.result = { name, size, seconds, url };
      reportRun(i.duration, Math.max(0, it.file.size - size)).then(loadStats);
    } catch (e) {
      const canceled = S.stop || (MB.ConversionCanceledError && e instanceof MB.ConversionCanceledError);
      if (writable) { try { await writable.abort(); } catch {} }
      if (dir && fileHandle) { try { await dir.removeEntry(name); } catch {} }
      it.run = canceled ? 'stopped' : 'fail';
      it.err = canceled ? '' : (e && e.message ? e.message : String(e));
    } finally {
      it.conversion = null;
    }
  }

  // overall progress weighs each file by its length
  function overall() {
    const q = S.queue, total = q.reduce((a, it) => a + it.info.duration, 0) || 1;
    const doneDur = q.reduce((a, it) => a + (it.run === 'done' || it.run === 'fail' || it.run === 'stopped' ? it.info.duration : it.run === 'running' ? it.info.duration * it.progress : 0), 0);
    const p = doneDur / total, secs = (performance.now() - S.t0) / 1000;
    const left = p > 0.02 && secs > 3 ? (secs / p) * (1 - p) : 0;
    return { p, left };
  }

  function statusText(it) {
    if (it.run === 'wait') return '等待中';
    if (it.run === 'running') {
      const left = it.speed > 0 ? (it.info.duration * (1 - it.progress)) / it.speed : 0;
      return `${Math.floor(it.progress * 100)}%` + (it.speed ? `・${it.speed.toFixed(it.speed < 10 ? 1 : 0)} 倍速` : '・準備中') + (left > 1 ? `・剩下約 ${fmtDur(left)}` : '');
    }
    if (it.run === 'stopped') return '已停止，沒有輸出檔案';
    return '';
  }

  function renderStep4() {
    if (S.step !== 4) return;
    const q = S.queue, done = q.filter((it) => it.run === 'done');
    const finished = !S.running;
    $('#h4p').textContent = !finished ? '處理中請不要關閉這個分頁'
      : !done.length ? (S.stop ? '已停止' : '沒有完成的影片')
      : S.dir ? `${done.length === q.length ? '全部完成' : `完成 ${done.length} 支`}，檔案存在「${S.dir.name}」資料夾`
      : `${done.length === q.length ? '全部完成' : `完成 ${done.length} 支`}，檔案已經下載`;
    $('#stopRun').hidden = finished;
    $('#restart').hidden = !finished;
    $('#back4').disabled = !finished;

    const ov = $('#overall');
    if (finished) {
      const src = done.reduce((a, it) => a + it.file.size, 0), out = done.reduce((a, it) => a + it.result.size, 0);
      ov.replaceChildren(
        el('span', { class: 'ov-text' }, done.length ? `${fmtBytes(src)} → ${fmtBytes(out)}，省下 ` : '沒有完成的影片', done.length ? el('b', { text: `${pct(out, src)}%` }) : null),
        el('span', { class: 'ov-sub', text: `完成 ${done.length} / ${q.length} 支` }));
    } else {
      const { p, left } = overall();
      const idx = q.findIndex((it) => it.run === 'running');
      ov.replaceChildren(
        el('span', { class: 'ov-text', id: 'ovText' }, `正在處理第 ${Math.max(1, idx + 1)} / ${q.length} 支・`, el('b', { id: 'ovPct', text: `${Math.floor(p * 100)}%` })),
        el('span', { class: 'ov-sub', id: 'ovLeft', text: left ? `全部剩下約 ${fmtDur(left)}` : '' }),
        el('div', { class: 'progress' }, el('span', { id: 'ovBar', style: `width:${(p * 100).toFixed(1)}%` })));
    }
    $('#rlist').replaceChildren(...q.map((it) => {
      const r = it.result, cls = it.run === 'done' ? 'ok' : it.run === 'fail' ? 'bad' : it.run === 'running' ? 'busy' : '';
      const status = el('span', { class: 'out-status', 'aria-hidden': 'true' });
      if (it.run === 'running') status.append(el('span', { class: 'spinner' }));
      else if (it.run === 'done') status.textContent = '✓';
      else if (it.run === 'fail') status.textContent = '!';
      else status.append(el('span', { class: 'dot-wait' }));
      const main = el('div', { class: 'out-main' },
        el('div', { class: 'out-title' }, el('b', { class: 'out-name', text: it.file.name, title: it.file.name }), el('span', { class: 'out-meta', text: `原 ${fmtBytes(it.file.size)}・${fmtRate(it.info.vRate)}` })));
      if (r) main.append(el('div', { class: 'out-size' }, el('b', { text: fmtBytes(r.size) }), el('span', { class: 'saved', text: `小了 ${pct(r.size, it.file.size)}%` }), el('span', { class: 'out-rate', text: `平均 ${fmtRate((r.size * 8) / it.info.duration)}・${r.name}` })));
      else if (it.run === 'fail') main.append(el('span', { class: 'out-msg bad', text: it.err, title: it.err }));
      else if (it.run === 'running') main.append(el('div', { class: 'progress' }, el('span', { style: `width:${(it.progress * 100).toFixed(1)}%` })), el('span', { class: 'status', text: statusText(it) }));
      else main.append(el('span', { class: 'status', text: statusText(it) }));
      const act = el('div', { class: 'out-actions' });
      if (r && r.url) act.append(el('a', { class: 'btn primary', href: r.url, download: r.name, text: '下載' }));
      else if (r) act.append(el('span', { class: 'tag', text: '已存檔' }));
      return el('li', { class: `out ${cls}`, 'data-id': it.id }, status, main, act);
    }));
    renderStepper();
  }

  // cheap update while encoding: only the numbers and bars that move
  let tickPending = false;
  function progressTick(it) {
    if (tickPending || S.step !== 4 || it.run !== 'running') return;
    tickPending = true;
    requestAnimationFrame(() => {
      tickPending = false;
      if (it.run !== 'running') return;
      const row = $(`.out[data-id="${it.id}"]`);
      if (row && $('.progress > span', row)) { $('.progress > span', row).style.width = `${(it.progress * 100).toFixed(1)}%`; $('.status', row).textContent = statusText(it); }
      const { p, left } = overall();
      if ($('#ovPct')) {
        $('#ovPct').textContent = `${Math.floor(p * 100)}%`;
        $('#ovBar').style.width = `${(p * 100).toFixed(1)}%`;
        $('#ovLeft').textContent = left ? `全部剩下約 ${fmtDur(left)}` : '';
      }
    });
  }

  // ---------- the public counter on the home page ----------
  // Only numbers leave the browser (one file, its length in seconds, bytes saved), never any file content or name.
  function reportRun(seconds, savedBytes) {
    if (!onServer) return Promise.resolve();
    return fetch('api/stats/processed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: 1, seconds: Math.round(seconds), savedBytes: Math.round(savedBytes) }), keepalive: true,
    }).catch(() => {});
  }

  window.addEventListener('beforeunload', (e) => { if (S.running) { e.preventDefault(); e.returnValue = ''; } });
  render();
})();
