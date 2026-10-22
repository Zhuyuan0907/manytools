/* 影片碼率壓縮 — everything runs in this browser tab.
   Reading/demuxing/muxing: Mediabunny. Decoding/encoding: the browser's WebCodecs (hardware when available).
   Nothing about the video leaves the computer; on a server only the counts (files, seconds, bytes saved) are sent. */
(() => {
  'use strict';
  const MB = window.Mediabunny;
  const $ = (s, root = document) => root.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  };

  // ---------- formatting ----------
  const fmtBytes = (b) => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
  const fmtRate = (bps) => bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
  const fmtDur = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
  };
  const fmtFps = (f) => {
    if (!f) return '—';
    for (const [n, label] of [[23.976, '23.98'], [29.97, '29.97'], [59.94, '59.94']]) if (Math.abs(f - n) < 0.02) return label;
    return String(Math.round(f * 100) / 100);
  };

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
        return { name: 'H.265 / HEVC', detail: `${prof} @ L${(+m[3] / 30).toFixed(1).replace(/\.0$/, '')}`, deep: +m[1] !== 1 };
      }
      return { name: 'H.265 / HEVC', detail: '', deep: false };
    }
    const names = { avc: 'H.264', hevc: 'H.265 / HEVC', prores: 'ProRes', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', mpeg2: 'MPEG-2' };
    return { name: names[codec] || (codec ? codec.toUpperCase() : '不支援的格式'), detail: '', deep: false };
  }
  function describeAudio(codec) {
    if (!codec) return '不支援';
    if (codec.startsWith('pcm')) {
      const m = /pcm-([suf])(\d+)/.exec(codec);
      return m ? `LPCM ${m[2]}-bit${m[1] === 'f' ? ' float' : ''}` : 'LPCM';
    }
    return { aac: 'AAC', mp3: 'MP3', opus: 'Opus', ac3: 'Dolby AC-3', eac3: 'Dolby E-AC-3', flac: 'FLAC', vorbis: 'Vorbis', dts: 'DTS' }[codec] || codec.toUpperCase();
  }
  const chLabel = (n) => ({ 1: '單聲道', 2: '立體聲' }[n] || `${n} 聲道`);
  function colorLabel(cs, hdr) {
    if (hdr) return cs && cs.transfer === 'arib-std-b67' ? 'HDR（HLG）' : 'HDR（PQ）';
    if (cs && cs.primaries === 'bt2020') return 'BT.2020';
    return 'SDR（BT.709）';
  }

  // ---------- browser support ----------
  const support = $('#support');
  const hasCodecs = !!(window.VideoEncoder && window.VideoDecoder && MB);
  if (!MB) {
    support.textContent = '程式檔案不完整，請重新下載整個資料夾。';
    support.hidden = false;
  } else if (!hasCodecs) {
    support.textContent = '這個瀏覽器不支援影片編碼（WebCodecs）。請改用最新版的 Chrome 或 Edge 開啟。';
    support.hidden = false;
  }
  const canPickFolder = typeof window.showDirectoryPicker === 'function';

  // H.265 encoding depends on the computer's hardware; hide the choice when it isn't there.
  (async () => {
    if (!hasCodecs) return;
    let ok = false;
    try { ok = await MB.canEncodeVideo('hevc', { width: 1920, height: 1080, quality: new MB.Quality({ bitrate: 12e6 }) }); } catch {}
    if (!ok) {
      const opt = $('#hevcOpt');
      opt.querySelector('input').disabled = true;
      opt.querySelector('small').textContent = '這台電腦不支援 H.265 編碼';
    }
  })();

  // ---------- state ----------
  const items = [];
  let nextId = 1;
  let running = false;

  function settings() {
    return {
      rate: Math.max(0.5, parseFloat($('#rate').value) || 12) * 1e6,
      mode: $('input[name=mode]:checked').value,
      codec: $('input[name=codec]:checked').value,
      res: +$('#res').value,
      gop: +$('#gop').value,
      audio: $('#audio').value,
      fmt: $('#fmt').value,
    };
  }

  // ---------- settings controls ----------
  const rateInput = $('#rate'), rateRange = $('#rateRange');
  function syncRate(v, from) {
    v = Math.min(200, Math.max(0.5, v));
    if (from !== 'input') rateInput.value = v;
    if (from !== 'range') rateRange.value = Math.min(+rateRange.max, Math.max(+rateRange.min, v));
    for (const b of document.querySelectorAll('#rateChips button')) b.classList.toggle('on', +b.dataset.rate === v);
    renderAllPlans();
  }
  rateInput.addEventListener('input', () => { const v = parseFloat(rateInput.value); if (v > 0) syncRate(v, 'input'); });
  rateInput.addEventListener('change', () => syncRate(parseFloat(rateInput.value) || 12));
  rateRange.addEventListener('input', () => syncRate(+rateRange.value, 'range'));
  $('#rateChips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) syncRate(+b.dataset.rate); });
  for (const n of document.querySelectorAll('.settings input[type=radio], .settings select')) n.addEventListener('change', renderAllPlans);
  syncRate(12);

  // Grey out the chips that are above every loaded file's video bitrate (they wouldn't compress anything).
  function markChips() {
    const rates = items.filter((it) => it.info && it.info.vRate).map((it) => it.info.vRate);
    const max = rates.length ? Math.max(...rates) : Infinity;
    for (const b of document.querySelectorAll('#rateChips button')) b.classList.toggle('over', +b.dataset.rate * 1e6 >= max);
  }

  // ---------- adding files ----------
  const drop = $('#drop'), fileInput = $('#fileInput');
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  // Dropping a file anywhere else on the page shouldn't navigate away from it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (!drop.contains(e.target)) addFiles(e.dataTransfer.files); });

  function addFiles(list) {
    for (const file of list) {
      if (items.some((it) => it.file.name === file.name && it.file.size === file.size && it.status !== 'done')) continue;
      const it = { id: nextId++, file, status: 'loading', info: null, error: '' };
      items.push(it);
      it.node = makeCard(it);
      $('#files').append(it.node);
      probe(it);
    }
    document.body.classList.toggle('has-files', items.length > 0);
    updateSummary();
  }

  function makeCard(it) {
    const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
    $('.fname', node).textContent = it.file.name;
    $('.fmeta', node).textContent = `${fmtBytes(it.file.size)}・讀取中…`;
    $('.info', node).append(el('p', { class: 'loading', text: '正在讀取影片資訊…' }));
    $('.remove', node).addEventListener('click', () => removeItem(it));
    $('.cancel', node).addEventListener('click', () => { if (it.conversion) it.conversion.cancel().catch(() => {}); it.canceled = true; });
    return node;
  }

  function removeItem(it) {
    if (it.status === 'running') return;
    items.splice(items.indexOf(it), 1);
    it.node.remove();
    try { it.input && it.input.dispose(); } catch {}
    document.body.classList.toggle('has-files', items.length > 0);
    markChips();
    updateSummary();
  }

  // ---------- reading the file's details ----------
  async function probe(it) {
    const ext = (it.file.name.split('.').pop() || '').toLowerCase();
    try {
      if (!MB) throw new Error('程式檔案不完整');
      const input = new MB.Input({ source: new MB.BlobSource(it.file), formats: MB.ALL_FORMATS });
      it.input = input;
      if (!(await input.canRead())) {
        throw new Error(ext === 'mxf'
          ? 'MXF 格式目前不支援。請在機器上改錄 MP4（XAVC S / XAVC HS），或先用剪接軟體轉成 MOV / MP4。'
          : '看不懂這個檔案，可能不是影片或格式不支援。');
      }
      const format = await input.getFormat();
      const isTs = format.name === 'MPEG Transport Stream';
      const duration = await input.computeDuration();
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) throw new Error('這個檔案裡沒有影像。');
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
        format: format.name === 'QuickTime File Format' ? 'MOV' : format.name === 'MPEG Transport Stream' ? 'MTS / TS' : format.name,
        isMov: format.name === 'QuickTime File Format',
        duration,
        overall: duration > 0 ? (it.file.size * 8) / duration : 0,
        vCodec, vStr, codec: describeCodec(vCodec, vStr),
        width: await vt.getDisplayWidth(), height: await vt.getDisplayHeight(),
        fps: vStats.averagePacketRate,
        vRate: vStats.averageBitrate,
        cs, hdr,
        canDecode: await vt.canDecode(),
        audio,
      };
      it.status = it.info.canDecode ? 'ready' : 'error';
      if (!it.info.canDecode) it.error = `這台電腦的瀏覽器無法解碼這種影像（${it.info.codec.name} ${it.info.codec.detail}）。`;
      renderInfo(it);
      thumbnail(it, vt, duration);
    } catch (e) {
      it.status = 'error';
      it.error = e && e.message ? e.message : String(e);
      $('.info', it.node).replaceChildren();
      $('.fmeta', it.node).textContent = fmtBytes(it.file.size);
    }
    markChips();
    renderPlan(it);
    updateSummary();
  }

  async function thumbnail(it, vt, duration) {
    if (!it.info.canDecode) return;
    try {
      const sink = new MB.CanvasSink(vt, { width: 320, height: 180, fit: 'contain' });
      const start = await vt.getFirstTimestamp().catch(() => 0);
      const w = await sink.getCanvas(start + Math.min(duration * 0.1, 3));
      if (!w) return;
      const c = $('.thumb canvas', it.node);
      c.width = 320; c.height = 180;
      c.getContext('2d').drawImage(w.canvas, 0, 0, 320, 180);
    } catch {}
  }

  function renderInfo(it) {
    const i = it.info;
    $('.fmeta', it.node).textContent = `${fmtBytes(it.file.size)}・${i.format}・${fmtDur(i.duration)}`;
    const cell = (label, value, sub, cls) => {
      const dd = el('dd', { text: value });
      if (sub) dd.append(el('small', { text: sub }));
      return el('div', cls ? { class: cls } : {}, el('dt', { text: label }), dd);
    };
    const kids = [
      cell('影像碼率', fmtRate(i.vRate), i.overall ? `整體 ${fmtRate(i.overall)}` : '', 'hl'),
      cell('解析度', `${i.width} × ${i.height}`, `${fmtFps(i.fps)} fps`),
      cell('影像編碼', i.codec.name, i.codec.detail),
      cell('色彩', colorLabel(i.cs, i.hdr), i.cs && i.cs.fullRange ? 'Full range' : ''),
      cell('長度', fmtDur(i.duration), fmtBytes(it.file.size)),
    ];
    if (!i.audio.length) kids.push(cell('聲音', '沒有聲音'));
    i.audio.forEach((a, n) => kids.push(cell(i.audio.length > 1 ? `聲音軌 ${n + 1}` : '聲音',
      describeAudio(a.codec), [chLabel(a.channels), a.sampleRate ? `${a.sampleRate / 1000} kHz` : '', a.rate ? fmtRate(a.rate) : ''].filter(Boolean).join('・'))));
    $('.info', it.node).replaceChildren(...kids);
  }

  // ---------- the plan for each file under the current settings ----------
  function outputDims(i, s) {
    const short = Math.min(i.width, i.height);
    if (!s.res || s.res >= short) return null;
    const k = s.res / short;
    return { width: Math.round((i.width * k) / 2) * 2, height: Math.round((i.height * k) / 2) * 2 };
  }
  // Camera rates are exact fractions (60000/1001…); the measured average is a hair off, so snap to the nearest one.
  const STD_FPS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 100, 120000 / 1001, 120];
  function snapFps(f) {
    if (!(f > 0)) return 0;
    const best = STD_FPS.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
    return Math.abs(best - f) / best < 0.003 ? best : f;
  }
  function audioRate(i, s) {
    if (s.audio === 'none') return 0;
    if (s.audio === 'aac') return i.audio.length * 320e3;
    return i.audio.reduce((a, t) => a + (t.rate || 0), 0);
  }
  function plan(it) {
    const i = it.info, s = settings();
    const estBytes = ((s.rate + audioRate(i, s)) * i.duration) / 8 * 1.01;
    const notes = [];
    let skip = false;
    if (s.rate >= i.vRate * 0.97) { notes.push(['bad', '目標碼率沒有比原始低，壓了也不會變小。請把目標調低。']); skip = true; }
    else if (s.rate < i.vRate * 0.2) notes.push(['warn', '目標碼率不到原始的 2 成，畫面可能明顯變糊，建議先試一支看看。']);
    if (i.hdr || i.codec.deep) notes.push(['warn', `原檔是 ${i.hdr ? 'HDR' : '10-bit / 4:2:2'}，輸出會轉成 8-bit 4:2:0${i.hdr ? ' SDR' : ''}。`]);
    if (!canPickFolder && it.file.size > 1.5e9) notes.push(['warn', '這個瀏覽器不能直接存到資料夾，大檔案會佔用很多記憶體。建議用 Chrome 或 Edge。']);
    return { estBytes, notes, skip, dims: outputDims(i, s) };
  }
  function renderPlan(it) {
    const box = $('.plan', it.node);
    if (it.status === 'error') {
      box.replaceChildren(el('span', { class: 'note bad', text: it.error }));
      $('.remove', it.node).hidden = false;
      return;
    }
    if (!it.info || it.status === 'running' || it.status === 'done') { if (it.status !== 'done') box.replaceChildren(); return; }
    const p = plan(it), s = settings();
    it.skip = p.skip;
    const res = p.dims ? `${p.dims.width}×${p.dims.height}` : `${it.info.width}×${it.info.height}`;
    box.replaceChildren(
      el('span', {}, '影像 ', el('b', { text: fmtRate(it.info.vRate) }), el('span', { class: 'arrow', text: ' → ' }), el('b', { text: fmtRate(s.rate) })),
      el('span', {}, '預估 ', el('b', { text: `${fmtBytes(p.estBytes)}` }), p.skip ? '' : `（省下約 ${Math.max(0, Math.round((1 - p.estBytes / it.file.size) * 100))}%）`),
      el('span', { text: `${s.codec === 'hevc' ? 'H.265' : 'H.264'}・${res}` }),
      ...p.notes.map(([cls, t]) => el('span', { class: `note ${cls}`, text: t })),
    );
  }
  function renderAllPlans() { for (const it of items) renderPlan(it); updateSummary(); }

  function updateSummary() {
    const todo = items.filter((it) => it.status === 'ready' && !it.skip);
    const loading = items.some((it) => it.status === 'loading');
    $('#runAll').disabled = running || !todo.length || !hasCodecs;
    $('#runAll').textContent = running ? '處理中…' : todo.length > 1 ? `開始壓縮（${todo.length} 支）` : '開始壓縮';
    let note;
    if (!items.length) note = '還沒有加入影片。';
    else if (loading) note = '正在讀取影片資訊…';
    else if (!todo.length) note = items.every((it) => it.status === 'done') ? '全部處理完成。' : '沒有可以壓縮的影片。';
    else {
      const est = todo.reduce((a, it) => a + plan(it).estBytes, 0), src = todo.reduce((a, it) => a + it.file.size, 0);
      note = `${fmtBytes(src)} → 約 ${fmtBytes(est)}`;
    }
    $('#sumNote').textContent = note;
  }

  // ---------- running ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  $('#runAll').addEventListener('click', async () => {
    const todo = items.filter((it) => it.status === 'ready' && !it.skip);
    if (!todo.length || running) return;
    // One folder for the whole batch, so multi-GB files stream straight to disk instead of into memory.
    let dir = null;
    if (canPickFolder) {
      try { dir = await window.showDirectoryPicker({ id: 'manytools-video-out', mode: 'readwrite', startIn: 'videos' }); }
      catch (e) { if (e && e.name === 'AbortError') { toast('沒有選擇存放的資料夾，已取消。'); return; } dir = null; }
    }
    running = true;
    updateSummary();
    const s = settings();
    for (const it of todo) {
      if (it.status !== 'ready') continue;
      await runOne(it, s, dir);
    }
    running = false;
    updateSummary();
    const done = todo.filter((it) => it.status === 'done');
    if (done.length) toast(dir ? `完成 ${done.length} 支，已存到「${dir.name}」資料夾。` : `完成 ${done.length} 支。`);
  });

  function outName(it, s, ext) {
    const base = it.file.name.replace(/\.[^.]+$/, '');
    const mbps = Math.round((s.rate / 1e6) * 10) / 10;
    return `${base}_${mbps}M.${ext}`;
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
    const node = it.node, i = it.info;
    it.status = 'running'; it.canceled = false;
    node.classList.add('is-running');
    $('.remove', node).hidden = true;
    $('.result', node).hidden = true;
    renderPlan(it);
    const prog = $('.prog', node), bar = $('.bar i', prog), ptext = $('.prog-text', prog);
    prog.hidden = false; bar.style.width = '0%'; ptext.textContent = '準備中…';

    const useMov = s.fmt === 'mov' || (s.fmt === 'auto' && i.isMov);
    const ext = useMov ? 'mov' : 'mp4';
    let name = outName(it, s, ext), fileHandle = null, writable = null, target;
    try {
      if (dir) {
        name = await freeName(dir, name);
        fileHandle = await dir.getFileHandle(name, { create: true });
        writable = await fileHandle.createWritable();
        target = new MB.StreamTarget(writable, { chunked: true });
      } else {
        target = new MB.BufferTarget();
      }
      const format = useMov ? new MB.MovOutputFormat({ fastStart: dir ? false : 'in-memory' }) : new MB.Mp4OutputFormat({ fastStart: dir ? false : 'in-memory' });
      const output = new MB.Output({ format, target });
      const dims = outputDims(i, s);
      const video = {
        codec: s.codec,
        quality: new MB.Quality({ bitrate: Math.round(s.rate), bitrateMode: s.mode }),
        keyFrameInterval: s.gop,
        forceTranscode: true,
      };
      // Without a frame rate the browser's encoder assumes 30 fps and a 59.94p file comes out at twice the bitrate.
      const fps = snapFps(i.fps);
      if (fps) video.frameRate = fps;
      if (dims) Object.assign(video, dims, { fit: 'fill' });
      const audio = s.audio === 'none' ? { discard: true }
        : s.audio === 'aac' ? { codec: 'aac', quality: new MB.Quality({ bitrate: 320e3 }), forceTranscode: true }
        : {};
      const conv = await MB.Conversion.init({ input: it.input, output, video, audio, showWarnings: false });
      if (!conv.isValid || !conv.utilizedTracks.some((t) => t.isVideoTrack())) {
        const r = conv.discardedTracks.find((d) => d.track.isVideoTrack());
        throw new Error(r && r.reason === 'no_encodable_target_codec'
          ? `這台電腦無法用 ${s.codec === 'hevc' ? 'H.265' : 'H.264'} 編碼這個解析度，請換編碼格式或調低解析度。`
          : r && r.reason === 'undecodable_source_codec' ? '這台電腦的瀏覽器無法解碼這種影像。' : '這支影片無法轉換。');
      }
      it.conversion = conv;
      const t0 = performance.now();
      conv.onProgress = (p, t) => {
        const el = (performance.now() - t0) / 1000;
        const speed = el > 1 ? t / el : 0;
        const left = speed > 0 ? (i.duration - t) / speed : 0;
        bar.style.width = `${(p * 100).toFixed(1)}%`;
        ptext.textContent = `${Math.floor(p * 100)}%` + (speed ? `・${speed.toFixed(speed < 10 ? 1 : 0)} 倍速・剩下約 ${fmtDur(left)}` : '');
      };
      await conv.execute();
      const seconds = (performance.now() - t0) / 1000;
      let size, blob = null;
      if (dir) size = (await fileHandle.getFile()).size;
      else { blob = new Blob([target.buffer], { type: useMov ? 'video/quicktime' : 'video/mp4' }); size = blob.size; }
      it.status = 'done';
      showResult(it, { name, size, seconds, blob, dir });
      reportRun(i.duration, Math.max(0, it.file.size - size));
    } catch (e) {
      const canceled = it.canceled || (e && e.name === 'ConversionCanceledError') || e instanceof (MB.ConversionCanceledError || function () {});
      if (writable) { try { await writable.abort(); } catch {} }
      if (dir && fileHandle) { try { await dir.removeEntry(name); } catch {} }
      it.status = canceled ? 'ready' : 'error';
      it.error = canceled ? '' : (e && e.message ? e.message : String(e));
      const r = $('.result', node);
      r.className = 'result err';
      r.replaceChildren(el('b', { text: canceled ? '已取消' : '處理失敗' }), el('span', { text: canceled ? '可以調整設定後再試一次。' : it.error }));
      r.hidden = false;
    } finally {
      it.conversion = null;
      prog.hidden = true;
      node.classList.remove('is-running');
      $('.remove', node).hidden = false;
      renderPlan(it);
    }
  }

  function showResult(it, { name, size, seconds, blob, dir }) {
    const node = it.node, r = $('.result', node);
    node.classList.add('is-done');
    const saved = Math.max(0, Math.round((1 - size / it.file.size) * 100));
    const rate = it.info.duration > 0 ? (size * 8) / it.info.duration : 0;
    const kids = [
      el('b', { text: '完成' }),
      el('span', {}, `${fmtBytes(it.file.size)} → `, el('b', { text: fmtBytes(size) }), `（小了 ${saved}%）`),
      el('span', { text: `整體 ${fmtRate(rate)}・花了 ${fmtDur(seconds)}` }),
      el('span', { class: 'spacer' }),
    ];
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = el('a', { class: 'btn small primary', href: url, download: name, text: '下載' });
      kids.push(a);
      a.click();
    } else {
      kids.push(el('span', { text: `已存到「${dir.name}/${name}」` }));
    }
    r.className = 'result';
    r.replaceChildren(...kids);
    r.hidden = false;
  }

  // ---------- the public counter on the home page ----------
  // Only numbers leave the browser (one file, its length in seconds, bytes saved), never any file content or name.
  const onServer = /^https?:$/.test(location.protocol);
  function reportRun(seconds, savedBytes) {
    if (!onServer) return;
    fetch('api/stats/processed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: 1, seconds: Math.round(seconds), savedBytes: Math.round(savedBytes) }), keepalive: true,
    }).catch(() => {});
  }

  window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });
})();
