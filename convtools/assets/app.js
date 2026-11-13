/* ZhuyuanLoveConvert — videos from one format to another, all in this browser tab: MOV, MKV, TS, WebM, MP4… in;
   MP4, MOV, WebM or GIF out, or only the sound as MP3, M4A or WAV. Reading and writing: Mediabunny. Decoding and
   encoding: the browser's WebCodecs; MP3 (no browser has it), and AAC where the browser has none (Firefox, Chrome on
   Linux), by Mediabunny's WebAssembly encoders (lib/, fetched when needed); GIF by gifenc. What the new format can
   hold is copied as it is (MOV → MP4 in seconds, nothing lost); the rest is re-encoded. Three steps: 1 drop files →
   2 settings → 3 convert and save. On a server only the counts (files, seconds) are reported. */
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
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const fmtDur = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
  const SHORT = { MP4: 'MP4', 'QuickTime File Format': 'MOV', Matroska: 'MKV', WebM: 'WebM', 'MPEG Transport Stream': 'TS', Ogg: 'OGG', WAVE: 'WAV', MP3: 'MP3', ADTS: 'AAC', FLAC: 'FLAC' };
  const CODEC = { avc: 'H.264', hevc: 'H.265', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'AC-3', eac3: 'E-AC-3' };
  const codecName = (c) => CODEC[c] || (/^pcm/.test(c || '') ? 'PCM' : (c || '').toUpperCase());

  // ---------- the formats ----------
  const FMT = {
    mp4: { name: 'MP4', ext: 'mp4', mime: 'video/mp4', help: 'H.264＋AAC，手機、電腦、網站、LINE 都能播' },
    mov: { name: 'MOV', ext: 'mov', mime: 'video/quicktime', help: 'Apple 的格式，Mac、iPhone、Final Cut 用' },
    webm: { name: 'WebM', ext: 'webm', mime: 'video/webm', help: 'VP9＋Opus，網頁用；舊的 iPhone 可能不能播' },
    gif: { name: 'GIF', ext: 'gif', mime: 'image/gif', help: '會動的圖，可以貼在訊息、簡報裡；沒有聲音' },
    mp3: { name: 'MP3', ext: 'mp3', mime: 'audio/mpeg', help: '只留聲音，什麼都能播' },
    m4a: { name: 'M4A', ext: 'm4a', mime: 'audio/mp4', help: '只留聲音（AAC），iPhone、Apple 音樂用' },
    wav: { name: 'WAV', ext: 'wav', mime: 'audio/wav', help: '只留聲音，不壓縮、不失真，檔案很大' },
  };
  const SOUND = ['mp3', 'm4a', 'wav'];
  // what each format takes as it is, and what the rest becomes
  const TAKES = { mp4: { v: ['avc', 'hevc'], a: ['aac', 'mp3'] }, mov: { v: ['avc', 'hevc'], a: ['aac'] }, webm: { v: ['vp8', 'vp9', 'av1'], a: ['opus', 'vorbis'] }, mp3: { a: ['mp3'] }, m4a: { a: ['aac'] }, wav: { a: [] } };
  const INTO = { mp4: { v: 'avc', a: 'aac' }, mov: { v: 'avc', a: 'aac' }, webm: { v: 'vp9', a: 'opus' }, mp3: { a: 'mp3' }, m4a: { a: 'aac' }, wav: { a: 'pcm-s16' } };
  const QUALITY = { high: MB && MB.QUALITY_HIGH, medium: MB && MB.QUALITY_MEDIUM, low: MB && MB.QUALITY_LOW };

  // ---------- what this browser can do ----------
  const support = $('#support');
  const hasCodecs = !!MB && typeof window.VideoEncoder === 'function';
  if (!MB) { support.textContent = '這個頁面沒有載入完整，請重新整理。'; support.hidden = false; }
  else if (!hasCodecs) {
    support.textContent = !window.isSecureContext ? '影片編碼只能在 https 網址使用，請用正式網址開啟這個頁面。' : '這個瀏覽器不支援影片編碼：只能做不用重新壓縮的轉檔。請改用最新版的 Chrome、Edge 或 Safari。';
    support.hidden = false;
  }
  const canPickFolder = typeof window.showDirectoryPicker === 'function', canPickFile = typeof window.showSaveFilePicker === 'function';
  const CAN = { avc: false, vp9: false, vp8: false, aac: false, opus: false, ready: false };
  (async () => {
    if (!MB) return;
    const t = async (f) => { try { return !!(await f()); } catch { return false; } };
    if (hasCodecs) {
      CAN.avc = await t(() => MB.canEncodeVideo('avc', { width: 1280, height: 720, bitrate: 4e6 }));
      CAN.vp9 = await t(() => MB.canEncodeVideo('vp9', { width: 1280, height: 720, bitrate: 4e6 }));
      CAN.vp8 = CAN.vp9 || (await t(() => MB.canEncodeVideo('vp8', { width: 1280, height: 720, bitrate: 4e6 })));
    }
    CAN.aac = await t(() => MB.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192e3 }));
    CAN.opus = await t(() => MB.canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000, bitrate: 128e3 }));
    CAN.ready = true;
    render();
  })();
  // Mediabunny's own encoders, fetched the first time they're needed
  const libs = {};
  function lib(file, name) {
    return libs[file] || (libs[file] = new Promise((ok, no) => {
      if (window[name]) { ok(window[name]); return; }
      const s = document.createElement('script');
      s.src = `lib/${file}`;
      s.onload = () => (window[name] ? ok(window[name]) : no(new Error(file)));
      s.onerror = () => { delete libs[file]; no(new Error(file)); };
      document.head.append(s);
    }));
  }
  let mp3On = null, aacOn = null;
  const needMp3 = () => mp3On || (mp3On = lib('mediabunny-mp3-encoder-1.60.0.min.js', 'MediabunnyMp3Encoder').then((m) => m.registerMp3Encoder()));
  const needAac = () => (CAN.aac ? Promise.resolve() : aacOn || (aacOn = lib('mediabunny-aac-encoder-1.60.0.min.js', 'MediabunnyAacEncoder').then((m) => m.registerAacEncoder())));
  // (a conversion can open with a sample of no frames, which those encoders ask the size of and copy: nothing, not an error)
  if (MB && MB.AudioSample) {
    const AS = MB.AudioSample.prototype, size = AS.allocationSize, copy = AS.copyTo;
    AS.allocationSize = function (o) { return this.numberOfFrames ? size.call(this, o) : 0; };
    AS.copyTo = function (dest, o) { if (this.numberOfFrames) return copy.call(this, dest, o); };
  }

  // ---------- state ----------
  const S = { step: 1, items: [], running: false, hasRun: false, stop: false, queue: [], t0: 0, dir: null };
  let nextId = 1;
  const ready = () => S.items.filter((it) => it.status === 'ready');
  function settings() {
    return {
      fmt: $('input[name=fmt]:checked').value, q: $('input[name=q]:checked').value, ab: +$('input[name=ab]:checked').value, res: +$('#res').value,
      gif: { from: Math.max(0, parseFloat($('#gifFrom').value) || 0), len: +$('#gifLen').value, w: +$('#gifW').value, fps: +$('#gifFps').value },
    };
  }
  for (const n of $$('input[name=fmt], input[name=q], input[name=ab], #res, #gifFrom, #gifLen, #gifW, #gifFps')) n.addEventListener('change', () => render());

  // ---------- steps ----------
  const STEP_NAMES = ['放入影片', '轉檔設定', '轉檔與下載'];
  function allowed(n) {
    if (S.running) return n === 3;
    if (n === 1) return true;
    if (n === 2) return ready().length > 0 && !S.items.some((it) => it.status === 'loading');
    return S.hasRun;
  }
  function goto(n) {
    if (!allowed(n)) return;
    S.step = n;
    for (let i = 1; i <= 3; i++) $(`#step${i}`).hidden = i !== n;
    render();
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-goto]'); if (b && !b.disabled) goto(+b.dataset.goto); });
  function renderStepper() {
    for (const b of $$('.stepper button')) {
      const n = +b.dataset.goto;
      b.classList.toggle('current', n === S.step);
      b.classList.toggle('done', n < S.step || (n === 3 && S.hasRun && !S.running && S.step !== 3));
      b.disabled = !allowed(n);
      b.setAttribute('aria-current', n === S.step ? 'step' : 'false');
    }
    $('#mStep').replaceChildren(`步驟 ${S.step}／3・`, el('b', { text: STEP_NAMES[S.step - 1] }));
  }
  function render() {
    renderStepper();
    if (S.step === 1) renderStep1();
    if (S.step === 2) renderStep2();
    if (S.step === 3) renderStep3();
  }

  // ---------- step 1: adding files ----------
  const drop = $('#drop'), fileInput = $('#fileInput');
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (!S.running && e.dataTransfer) addFiles(e.dataTransfer.files); });
  $('#next1').addEventListener('click', () => goto(2));

  function addFiles(list) {
    if (S.running || !MB) return;
    let added = 0;
    for (const file of list) {
      if (S.items.some((it) => it.file.name === file.name && it.file.size === file.size)) continue;
      const it = { id: nextId++, file, status: 'loading', info: null, input: null, error: '', run: null, progress: 0, result: null };
      S.items.push(it);
      added++;
      probe(it);
    }
    if (added) render();
  }
  function removeItem(it) {
    if (S.running) return;
    S.items = S.items.filter((x) => x !== it);
    try { it.input && it.input.dispose(); } catch {}
    if (it.result && it.result.url) URL.revokeObjectURL(it.result.url);
    if (!S.items.length) goto(1); else render();
  }
  // what's in a file: its format, length, picture and sound
  async function probe(it) {
    const ext = (it.file.name.match(/\.([a-z0-9]+)$/i) || [])[1];
    try {
      const input = new MB.Input({ source: new MB.BlobSource(it.file), formats: MB.ALL_FORMATS });
      const format = (await input.getFormat()).name;
      const v = await input.getPrimaryVideoTrack().catch(() => null), a = await input.getPrimaryAudioTrack().catch(() => null);
      if (!v && !a) throw new Error('empty');
      const info = { format: SHORT[format] || format, duration: await input.computeDuration().catch(() => 0), video: null, audio: null };
      if (v) {
        const st = await v.computePacketStats(120).catch(() => null);
        info.video = { codec: v.codec, w: v.displayWidth, h: v.displayHeight, fps: st && st.averagePacketRate ? st.averagePacketRate : 0, canDecode: await v.canDecode().catch(() => false) };
      }
      if (a) info.audio = { codec: a.codec, rate: a.sampleRate, ch: a.numberOfChannels, canDecode: await a.canDecode().catch(() => false) };
      it.input = input; it.info = info; it.status = 'ready';
    } catch (e) {
      it.status = 'error';
      it.error = /avi|wmv|flv|rmvb?|asf|vob/i.test(ext || '') ? `讀不了 ${ext.toUpperCase()}：瀏覽器打不開這種舊格式` : '讀不了這個檔案：可能不是影片，或格式不支援';
    }
    render();
  }
  function srcMeta(it) {
    if (it.status === 'loading') return '讀取中…';
    if (it.status === 'error') return it.error;
    const i = it.info;
    return [fmtBytes(it.file.size), i.format, fmtDur(i.duration), i.video ? `${i.video.w}×${i.video.h}` : '只有聲音', i.video ? codecName(i.video.codec) : codecName(i.audio.codec)].join('・');
  }
  function renderStep1() {
    const n = S.items.length;
    $('#step1').classList.toggle('has-files', n > 0);
    $('#sources').replaceChildren(...S.items.map((it, k) => el('li', { class: 'src' },
      el('span', { class: 'src-no', text: k + 1 }),
      el('span', { class: 'src-text' },
        el('span', { class: 'src-name', text: it.file.name, title: it.file.name }),
        el('span', { class: `src-meta${it.status === 'error' ? ' bad' : ''}`, text: srcMeta(it), title: srcMeta(it) })),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': `移除 ${it.file.name}`, title: '移除', text: '×', onclick: () => removeItem(it) }))));
    const size = S.items.reduce((a, it) => a + it.file.size, 0), bad = S.items.filter((it) => it.status === 'error').length;
    $('#note1').textContent = n ? `${n} 支・共 ${fmtBytes(size)}${bad ? `・${bad} 支讀不了` : ''}` : '還沒有加入影片。';
    $('#next1').disabled = !allowed(2);
  }

  // ---------- step 2: settings, and what will happen to each file ----------
  // a file's plan for the settings: what's copied, what's re-encoded, or why it's skipped
  function planOf(it, s) {
    const i = it.info, f = s.fmt;
    if (f === 'gif') return i.video ? { gif: true } : { skip: '沒有畫面' };
    if (SOUND.includes(f)) return i.audio ? { sound: true, copyA: TAKES[f].a.includes(i.audio.codec) } : { skip: '沒有聲音' };
    const size = i.video && s.res && Math.min(i.video.w, i.video.h) > s.res ? fitTo(i.video, s.res) : null;
    return { copyV: !i.video || (s.q === 'orig' && !size && TAKES[f].v.includes(i.video.codec)), copyA: !i.audio || TAKES[f].a.includes(i.audio.codec), size };
  }
  // the shorter side to `p` pixels, both sides even
  const fitTo = (v, p) => { const k = p / Math.min(v.w, v.h); return { w: Math.round((v.w * k) / 2) * 2, h: Math.round((v.h * k) / 2) * 2 }; };
  const videoInto = (f) => (f === 'webm' && !CAN.vp9 ? 'vp8' : INTO[f].v);
  // why a plan can't be done in this browser ('' when it can)
  function cannot(it, s, pl) {
    const i = it.info, f = s.fmt;
    if (pl.skip) return pl.skip;
    if (pl.gif) return i.video.canDecode ? '' : `這個瀏覽器解不開 ${codecName(i.video.codec)} 的畫面`;
    if (i.video && !pl.copyV && !pl.sound) {
      if (!i.video.canDecode) return `這個瀏覽器解不開 ${codecName(i.video.codec)} 的畫面（換 Safari 或 Edge 試試）`;
      if (CAN.ready && !CAN[videoInto(f)]) return `這個瀏覽器不能編碼 ${codecName(videoInto(f))}`;
    }
    if (i.audio && !pl.copyA && !i.audio.canDecode) return `這個瀏覽器解不開 ${codecName(i.audio.codec)} 的聲音`;
    if (f === 'webm' && i.audio && !pl.copyA && CAN.ready && !CAN.opus) return '這個瀏覽器不能編碼 Opus 聲音';
    return '';
  }
  function renderStep2() {
    const s = settings(), f = s.fmt, items = ready();
    for (const lab of $$('[data-fmt]')) {
      const k = lab.dataset.fmt, off = CAN.ready && k === 'webm' && !CAN.vp8;
      lab.querySelector('input').disabled = off;
      lab.title = off ? '這個瀏覽器不能編碼 WebM（Safari），請用 Chrome、Edge 或 Firefox' : FMT[k].help;
    }
    $('#fmtHelp').textContent = FMT[f].help;
    const video = !SOUND.includes(f) && f !== 'gif';
    $('#qSet').hidden = !video;
    $('#resSet').hidden = !video;
    $('#abSet').hidden = !(f === 'mp3' || f === 'm4a');
    $('#gifSet').hidden = f !== 'gif';
    $('#qHelp').textContent = { orig: '能不重新壓縮就不壓：幾秒就好、畫質和原檔一樣', high: '重新壓縮，畫質接近原檔', medium: '重新壓縮，檔案小一些', low: '檔案最小，適合傳訊息' }[s.q];
    const plans = items.map((it) => ({ it, pl: planOf(it, s) })).map((x) => ({ ...x, why: cannot(x.it, s, x.pl) }));
    const okp = plans.filter((x) => !x.why);
    const line = (cls, ...words) => el('li', { class: cls }, el('span', {}, ...words));
    const lines = [];
    if (f === 'gif') {
      const g = s.gif;
      lines.push(line(null, '從 ', el('b', { text: fmtDur(g.from) }), ' 開始的 ', el('b', { text: `${g.len} 秒` }), `做成 GIF，寬 ${g.w}、每秒 ${g.fps} 張`));
      const short = okp.filter((x) => x.it.info.duration < g.from + g.len);
      if (short.length) lines.push(line('warn', `${short.length} 支沒有那麼長，做到影片結束`));
    } else if (SOUND.includes(f)) {
      const copy = okp.filter((x) => x.pl.copyA).length;
      lines.push(line(null, '只留聲音，存成 ', el('b', { text: FMT[f].name }), f === 'wav' ? '（不壓縮）' : copy === okp.length && okp.length ? '（原本就是，直接拿出來）' : `（${s.ab / 1000} kbps）`));
    } else {
      const copy = okp.filter((x) => x.pl.copyV), enc = okp.filter((x) => !x.pl.copyV);
      if (copy.length) lines.push(line(null, el('b', { text: `${copy.length} 支` }), `直接換成 ${FMT[f].name}，不重新壓縮（幾秒就好、畫質不變）`));
      if (enc.length) lines.push(line(null, el('b', { text: `${enc.length} 支` }), `重新壓縮成 ${codecName(videoInto(f))}，時間大約和影片一樣長`));
      const sound = okp.filter((x) => x.it.info.audio && !x.pl.copyA);
      if (sound.length) lines.push(line(null, '聲音轉成 ', el('b', { text: codecName(INTO[f].a) })));
      if (okp.some((x) => x.pl.size)) lines.push(line(null, '解析度縮到 ', el('b', { text: `${s.res}p` })));
    }
    for (const x of plans.filter((y) => y.why)) lines.push(line('warn', `${x.it.file.name}：${x.why}，會略過`));
    $('#plan').replaceChildren(...lines);
    $('#note2').textContent = `${items.length} 支・共 ${fmtBytes(items.reduce((a, it) => a + it.file.size, 0))}`;
    $('#runAll').disabled = !okp.length || S.running;
    // (only when it changes: a click that blurs the GIF's number box re-renders this, and WebKit drops a click whose
    // button's text was replaced under it)
    setText($('#runAll'), okp.length > 1 ? `開始轉檔 ${okp.length} 支 →` : '開始轉檔 →');
  }

  // ---------- step 3: convert and save ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  function outName(it, f) {
    const base = it.file.name.replace(/\.[^.]+$/, ''), ext = FMT[f].ext, same = it.file.name.toLowerCase().endsWith(`.${ext}`);
    return `${base}${same ? '_轉檔' : ''}.${ext}`;
  }
  async function freeName(dir, name) {
    const dot = name.lastIndexOf('.');
    for (let n = 1; n < 100; n++) {
      const cand = n === 1 ? name : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
      try { await dir.getFileHandle(cand); } catch { return cand; }
    }
    return name;
  }
  $('#runAll').addEventListener('click', async () => {
    const s = settings(), todo = ready().filter((it) => !cannot(it, s, planOf(it, s)));
    if (!todo.length || S.running) return;
    // Chrome, Edge: straight to disk (one file: where to save it; several: a folder), so big files never sit in memory
    let dir = null, handle = null;
    if (todo.length === 1 && canPickFile) {
      try { handle = await window.showSaveFilePicker({ suggestedName: outName(todo[0], s.fmt), id: 'manytools-convert-out', startIn: 'videos', types: [{ description: FMT[s.fmt].name, accept: { [FMT[s.fmt].mime]: [`.${FMT[s.fmt].ext}`] } }] }); }
      catch (e) { if (e && e.name === 'AbortError') return; handle = null; }
    } else if (todo.length > 1 && canPickFolder) {
      try { dir = await window.showDirectoryPicker({ id: 'manytools-convert-out', mode: 'readwrite', startIn: 'videos' }); }
      catch (e) { if (e && e.name === 'AbortError') { toast('沒有選擇存放的資料夾，已取消'); return; } dir = null; }
    }
    for (const it of S.items) { if (it.result && it.result.url) URL.revokeObjectURL(it.result.url); it.run = null; it.result = null; it.err = ''; }
    for (const it of todo) { it.run = 'wait'; it.progress = 0; }
    Object.assign(S, { running: true, hasRun: true, stop: false, dir, queue: todo, t0: performance.now() });
    goto(3);
    for (const it of todo) {
      if (S.stop) { it.run = 'stopped'; continue; }
      await runOne(it, s, dir, handle);
      renderStep3();
    }
    S.running = false;
    render();
    const done = todo.filter((it) => it.run === 'done');
    if (done.length) toast(dir ? `完成 ${done.length} 支，已存到「${dir.name}」` : handle ? `完成，已存成「${handle.name}」` : `完成 ${done.length} 支`);
  });
  $('#stopRun').addEventListener('click', () => {
    S.stop = true;
    const cur = S.queue.find((it) => it.run === 'running');
    if (cur && cur.conversion) cur.conversion.cancel().catch(() => {});
  });
  $('#restart').addEventListener('click', () => {
    for (const it of S.items) { try { it.input && it.input.dispose(); } catch {} if (it.result && it.result.url) URL.revokeObjectURL(it.result.url); }
    Object.assign(S, { items: [], hasRun: false, queue: [] });
    goto(1);
  });

  // a frame rate the encoder should be told (without one it assumes 30 fps and a 60 fps file gets half the bit rate)
  function snapFps(f) {
    if (!f) return 0;
    for (const n of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) if (Math.abs(f - n) < 0.05) return n;
    return Math.round(f * 100) / 100;
  }
  async function runOne(it, s, dir, handle) {
    const i = it.info, f = s.fmt, pl = planOf(it, s);
    it.run = 'running'; it.progress = 0; it.speed = 0; it.err = '';
    renderStep3();
    let name = outName(it, f), fileHandle = handle, writable = null;
    const t0 = performance.now();
    try {
      if (dir) { name = await freeName(dir, name); fileHandle = await dir.getFileHandle(name, { create: true }); }
      if (fileHandle) { writable = await fileHandle.createWritable(); name = fileHandle.name; }
      let blob = null;
      if (pl.gif) blob = await gif(it, s, writable);
      else {
        if (pl.sound || (i.audio && !pl.copyA)) { if (INTO[f].a === 'mp3') await needMp3(); if (INTO[f].a === 'aac') await needAac(); }
        const target = writable ? new MB.StreamTarget(writable, { chunked: true }) : new MB.BufferTarget();
        const fastStart = writable ? false : 'in-memory';
        const format = f === 'mp4' || f === 'm4a' ? new MB.Mp4OutputFormat({ fastStart }) : f === 'mov' ? new MB.MovOutputFormat({ fastStart })
          : f === 'webm' ? new MB.WebMOutputFormat() : f === 'mp3' ? new MB.Mp3OutputFormat() : new MB.WavOutputFormat();
        const output = new MB.Output({ format, target });
        let video = { discard: true };
        if (!pl.sound && i.video) {
          video = pl.copyV ? {} : { codec: videoInto(f), quality: QUALITY[s.q === 'orig' ? 'high' : s.q], keyFrameInterval: 2, forceTranscode: true };
          const fps = !pl.copyV && snapFps(i.video.fps);
          if (fps) video.frameRate = fps;
          if (pl.size) Object.assign(video, { width: pl.size.w, height: pl.size.h, fit: 'contain' });
        }
        let audio = {};
        if (i.audio && !pl.copyA) {
          const into = INTO[f].a, rates = into === 'mp3' ? [32000, 44100, 48000] : into === 'aac' ? [44100, 48000] : null;
          audio = { codec: into, forceTranscode: true };
          if (into !== 'pcm-s16') audio.bitrate = SOUND.includes(f) ? s.ab : into === 'opus' ? 128e3 : 192e3;
          if (rates && !rates.includes(i.audio.rate)) audio.sampleRate = 48000;
        }
        const conv = await MB.Conversion.init({ input: it.input, output, video, audio, showWarnings: false });
        const need = pl.sound ? (t) => t.isAudioTrack() : (t) => t.isVideoTrack();
        if (!conv.isValid || ((pl.sound || i.video) && !conv.utilizedTracks.some(need))) {
          const r = conv.discardedTracks.find((d) => need(d.track)) || conv.discardedTracks[0];
          throw new Error(r && r.reason === 'undecodable_source_codec' ? '這個瀏覽器解不開這種影像或聲音'
            : r && r.reason === 'no_encodable_target_codec' ? `這個瀏覽器不能編碼成 ${FMT[f].name}` : '這支影片沒辦法轉成這個格式');
        }
        it.conversion = conv;
        if (S.stop) await conv.cancel();
        conv.onProgress = (p) => {
          const secs = (performance.now() - t0) / 1000;
          it.progress = p;
          it.speed = secs > 1 ? (p * i.duration) / secs : 0;
          progressTick(it);
        };
        await conv.execute();
        if (!writable) blob = new Blob([target.buffer], { type: FMT[f].mime });
      }
      let size, url = null;
      if (fileHandle) size = (await fileHandle.getFile()).size;
      else {
        size = blob.size;
        url = URL.createObjectURL(blob);
        el('a', { href: url, download: name }).click();
      }
      it.run = 'done';
      it.result = { name, size, url, seconds: (performance.now() - t0) / 1000, copied: !pl.gif && !pl.sound && pl.copyV };
      report(pl.gif ? Math.min(s.gif.len, i.duration) : i.duration);
    } catch (e) {
      const canceled = S.stop || (MB.ConversionCanceledError && e instanceof MB.ConversionCanceledError) || (e && e.canceled);
      if (writable) { try { await writable.abort(); } catch {} }
      if (dir && fileHandle) { try { await dir.removeEntry(fileHandle.name); } catch {} }
      else if (handle && handle.remove) { try { await handle.remove(); } catch {} }
      it.run = canceled ? 'stopped' : 'fail';
      it.err = canceled ? '' : (e && e.message) || String(e);
      if (!canceled) console.error(e);
    } finally {
      it.conversion = null;
    }
  }

  // ---------- GIF: frames at the chosen rate and width, each with its own 256 colours ----------
  async function gif(it, s, writable) {
    const g = s.gif, i = it.info;
    const { GIFEncoder, quantize, applyPalette } = await import(new URL('lib/gifenc-1.0.3.esm.js', document.baseURI).href);
    const track = await it.input.getPrimaryVideoTrack();
    const w = Math.min(g.w, i.video.w), h = Math.max(2, Math.round((w * i.video.h) / i.video.w));
    const from = clamp(g.from, 0, Math.max(0, i.duration - 0.1)), to = Math.min(i.duration, from + g.len);
    const n = Math.max(1, Math.floor((to - from) * g.fps)), times = Array.from({ length: n }, (_, k) => from + k / g.fps);
    const sink = new MB.CanvasSink(track, { width: w, height: h, fit: 'contain', poolSize: 1 });
    const enc = GIFEncoder(), delay = Math.round(1000 / g.fps), t0 = performance.now();
    let k = 0;
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      if (S.stop) throw Object.assign(new Error('canceled'), { canceled: true });
      if (frame) {
        const data = frame.canvas.getContext('2d').getImageData(0, 0, w, h).data;
        const palette = quantize(data, 256);
        enc.writeFrame(applyPalette(data, palette), w, h, { palette, delay });
      }
      it.progress = ++k / n;
      const secs = (performance.now() - t0) / 1000;
      it.speed = secs > 1 ? (k / g.fps) / secs : 0;
      progressTick(it);
      await new Promise((r) => setTimeout(r));   // (the page draws between frames)
    }
    enc.finish();
    const bytes = enc.bytes();
    if (writable) { await writable.write(bytes); await writable.close(); return null; }
    return new Blob([bytes], { type: 'image/gif' });
  }

  function overall() {
    const q = S.queue, total = q.reduce((a, it) => a + Math.max(1, it.info.duration), 0) || 1;
    const doneDur = q.reduce((a, it) => a + (['done', 'fail', 'stopped'].includes(it.run) ? Math.max(1, it.info.duration) : it.run === 'running' ? Math.max(1, it.info.duration) * it.progress : 0), 0);
    const p = doneDur / total, secs = (performance.now() - S.t0) / 1000;
    return { p, left: p > 0.02 && secs > 3 ? (secs / p) * (1 - p) : 0 };
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
  function renderStep3() {
    if (S.step !== 3) return;
    const q = S.queue, done = q.filter((it) => it.run === 'done'), finished = !S.running;
    $('#h3p').textContent = !finished ? '處理中請不要關閉這個分頁'
      : !done.length ? (S.stop ? '已停止' : '沒有完成的檔案')
      : S.dir ? `${done.length === q.length ? '全部完成' : `完成 ${done.length} 支`}，檔案存在「${S.dir.name}」資料夾`
      : `${done.length === q.length ? '全部完成' : `完成 ${done.length} 支`}，${done.some((it) => it.result.url) ? '檔案已經下載' : '檔案已經存好'}`;
    $('#stopRun').hidden = finished;
    $('#restart').hidden = !finished;
    $('#back3').disabled = !finished;
    const ov = $('#overall');
    if (finished) {
      const src = done.reduce((a, it) => a + it.file.size, 0), out = done.reduce((a, it) => a + it.result.size, 0);
      ov.replaceChildren(
        el('span', { class: 'ov-text' }, done.length ? `${fmtBytes(src)} → ` : '沒有完成的檔案', done.length ? el('b', { text: fmtBytes(out) }) : null),
        el('span', { class: 'ov-sub', text: `完成 ${done.length} / ${q.length} 支` }));
    } else {
      const { p, left } = overall(), idx = q.findIndex((it) => it.run === 'running');
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
        el('div', { class: 'out-title' }, el('b', { class: 'out-name', text: it.file.name, title: it.file.name }), el('span', { class: 'out-meta', text: `原 ${fmtBytes(it.file.size)}・${it.info.format}` })));
      if (r) main.append(el('div', { class: 'out-size' }, el('b', { text: fmtBytes(r.size) }), el('span', { class: 'saved', text: r.copied ? '沒有重新壓縮' : `花了 ${fmtDur(r.seconds)}` }), el('span', { class: 'out-rate', text: r.name })));
      else if (it.run === 'fail') main.append(el('span', { class: 'out-msg bad', text: it.err, title: it.err }));
      else if (it.run === 'running') main.append(el('div', { class: 'progress' }, el('span', { style: `width:${(it.progress * 100).toFixed(1)}%` })), el('span', { class: 'status', text: statusText(it) }));
      else main.append(el('span', { class: 'status', text: statusText(it) }));
      const act = el('div', { class: 'out-actions' });
      if (r && r.url) act.append(el('a', { class: 'btn primary', href: r.url, download: r.name, text: '下載' }));
      else if (r) act.append(el('span', { class: 'tag', text: '已存檔' }));
      return el('li', { class: `out ${cls}`, 'data-id': it.id }, status, main, act);
    }));
    $('#note3').textContent = finished ? '' : `${done.length} / ${q.length} 支完成`;
    renderStepper();
  }
  // cheap update while converting: only the numbers and bars that move
  let tickPending = false;
  function progressTick(it) {
    if (tickPending || S.step !== 3 || it.run !== 'running') return;
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

  // ---------- the counter ----------
  // Only numbers leave the browser: one file and its length in seconds, never anything about it.
  function report(seconds) {
    if (!onServer) return;
    fetch('api/stats/processed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ files: 1, seconds: Math.round(seconds) }) }).then(loadStats).catch(() => {});
  }
  async function loadStats() {
    if (!onServer) return;
    try {
      const r = await fetch('api/stats', { cache: 'no-store' });
      const st = r.ok ? await r.json() : null;
      if (st && st.files > 0) $('#heroCount').replaceChildren('已幫大家轉了 ', el('b', { class: 'hero-num', text: st.files.toLocaleString('zh-TW') }), ' 支影片');
    } catch {}
  }
  window.addEventListener('beforeunload', (e) => { if (S.running) { e.preventDefault(); e.returnValue = ''; } });
  loadStats();
  render();
})();
