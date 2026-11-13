/* 影片剪輯's media engine: what's in a file, its pictures and the shape of its sound, and the finished film — with
   Mediabunny (reading media files, writing MP4) and the browser's WebCodecs (decoding, encoding; the graphics card's
   when it has them). Nothing leaves the computer. app.js uses it as window.CutEngine.
   The film is made one of two ways:
     render: every frame drawn — the tracks stacked bottom to top, each clip where its Motion puts it, the sound of every
             audible clip mixed at 48 kHz — and encoded (H.264 or HEVC; AAC, else Opus). Frame-accurate; anything goes.
     copy:   the clips' own packets copied one after another, nothing decoded or encoded: a dashcam's clips (one camera,
             one format) come out in seconds, as they were. A clip can only start on a key frame, so each starts at the
             key frame at or before its in point. */
(() => {
  'use strict';
  const MB = window.Mediabunny;
  if (!MB) return;
  const E = {};
  const EPS = 1e-4;

  // ---------- what's in a file ----------
  E.probe = async (file) => {
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    let v = null, a = null;
    try { v = await input.getPrimaryVideoTrack(); } catch {}
    try { a = await input.getPrimaryAudioTrack(); } catch {}
    if (!v && !a) { input.dispose && input.dispose(); return null; }
    const info = { input, duration: 0, video: null, audio: null, format: '' };
    try { info.duration = await input.computeDuration(); } catch {}
    try { info.format = (await input.getFormat()).name || ''; } catch {}
    if (v) {
      let st = null;
      try { st = await v.computePacketStats(150); } catch {}
      info.video = {
        track: v, codec: v.codec, str: await v.getCodecParameterString().catch(() => ''),
        width: v.displayWidth, height: v.displayHeight, codedWidth: v.codedWidth, codedHeight: v.codedHeight, rotation: v.rotation || 0,
        fps: st && st.averagePacketRate ? st.averagePacketRate : 30, bitrate: st ? st.averageBitrate : 0,
        start: await v.getFirstTimestamp().catch(() => 0), canDecode: await v.canDecode().catch(() => false),
      };
    }
    if (a) {
      info.audio = {
        track: a, codec: a.codec, str: await a.getCodecParameterString().catch(() => ''), sampleRate: a.sampleRate, channels: a.numberOfChannels,
        start: await a.getFirstTimestamp().catch(() => 0), canDecode: await a.canDecode().catch(() => false),
      };
    }
    return info;
  };

  // ---------- pictures ----------
  // one frame, width px wide (the height as the frame's shape has it)
  E.thumb = async (info, t, width) => {
    if (!info.video || !info.video.canDecode) return null;
    const sink = new MB.CanvasSink(info.video.track, { width, poolSize: 0 });
    const w = await sink.getCanvas(Math.max(info.video.start, Math.min(t, info.duration - 0.05)));
    return w ? w.canvas : null;
  };
  // frames at times (for a clip's filmstrip on the timeline)
  E.thumbs = async (info, times, height, onEach) => {
    if (!info.video || !info.video.canDecode || !times.length) return;
    const sink = new MB.CanvasSink(info.video.track, { height, poolSize: 0 });
    let i = 0;
    for await (const w of sink.canvasesAtTimestamps(times.map((t) => Math.max(info.video.start, Math.min(t, info.duration - 0.05))))) {
      if (onEach(i++, w && w.canvas) === false) break;
    }
  };

  // ---------- the shape of the sound: the loudest of both channels, perSecond times a second ----------
  E.peaks = async (info, perSecond = 100) => {
    const a = info.audio;
    if (!a || !a.canDecode) return null;
    const n = Math.ceil(Math.max(info.duration, 0.1) * perSecond) + 1, out = new Float32Array(n);
    const sink = new MB.AudioBufferSink(a.track);
    for await (const { buffer, timestamp } of sink.buffers()) {
      const sr = buffer.sampleRate, d0 = buffer.getChannelData(0), d1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : d0;
      const step = sr / perSecond;
      let b = Math.floor(timestamp * perSecond), next = (b + 1 - timestamp * perSecond) * step, m = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = Math.max(d0[i] < 0 ? -d0[i] : d0[i], d1[i] < 0 ? -d1[i] : d1[i]);
        if (v > m) m = v;
        if (i + 1 >= next) { if (b >= 0 && b < n && m > out[b]) out[b] = m; b++; next += step; m = 0; }
      }
      if (b >= 0 && b < n && m > out[b]) out[b] = m;
    }
    return out;
  };

  // ---------- key frames (where a copied clip can start) ----------
  E.keyTimes = async (info) => {
    if (!info.video) return [];
    const sink = new MB.EncodedPacketSink(info.video.track), keys = [];
    for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) if (p.type === 'key') keys.push(p.timestamp);
    return keys.sort((x, y) => x - y);
  };

  // ---------- the film ----------
  class Canceled extends Error { constructor() { super('canceled'); this.canceled = true; } }
  E.Canceled = Canceled;

  // a clip's frames in order, the one showing at a time picked (faster clips skip, slower ones repeat)
  class Feed {
    constructor(clip) {
      this.sink = new MB.VideoSampleSink(clip.info.video.track);
      const from = Math.max(0, clip.srcIn - 0.001), to = clip.srcIn + (clip.end - clip.start) * clip.speed + 0.5;
      this.it = this.sink.samples(from, to)[Symbol.asyncIterator]();
      this.cur = null; this.next = null; this.done = false;
    }
    async pull() { if (this.done) return null; const r = await this.it.next(); if (r.done) { this.done = true; return null; } return r.value; }
    async at(t) {
      if (!this.next && !this.done) this.next = await this.pull();
      while (this.next && this.next.timestamp <= t + EPS) {
        if (this.cur) this.cur.close();
        this.cur = this.next;
        this.next = await this.pull();
      }
      return this.cur || this.next;
    }
    close() { if (this.cur) this.cur.close(); if (this.next) this.next.close(); this.cur = this.next = null; try { this.it.return && this.it.return(); } catch {} }
  }

  // a clip drawn where its Motion says: its own size × its scale, its centre at (x, y), turned, see-through
  function place(g, clip, k, drawAt) {
    const fx = clip.fx, s = (clip.fit || 1) * (fx.scale / 100) * k, w = clip.w * s, h = clip.h * s;
    let alpha = fx.opacity / 100;
    if (clip.fadeIn && clip.t < clip.start + clip.fadeIn) alpha *= Math.max(0, (clip.t - clip.start) / clip.fadeIn);
    if (clip.fadeOut && clip.t > clip.end - clip.fadeOut) alpha *= Math.max(0, (clip.end - clip.t) / clip.fadeOut);
    if (alpha <= 0.001) return;
    g.save();
    g.globalAlpha = alpha;
    g.translate(fx.x * k, fx.y * k);
    if (fx.rot) g.rotate((fx.rot * Math.PI) / 180);
    drawAt(-w / 2, -h / 2, w, h, s);
    g.restore();
  }
  function drawText(g, clip, k) {
    const t = clip.text, size = t.size * (clip.fx.scale / 100) * k;
    g.save();
    g.globalAlpha = clip.fx.opacity / 100;
    g.translate(clip.fx.x * k, clip.fx.y * k);
    if (clip.fx.rot) g.rotate((clip.fx.rot * Math.PI) / 180);
    g.font = `700 ${size}px ${t.font}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = String(t.value || '').split('\n'), lh = size * 1.2;
    g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 3 * k; g.shadowOffsetY = 1 * k;
    g.fillStyle = t.color;
    lines.forEach((ln, i) => g.fillText(ln, 0, (i - (lines.length - 1) / 2) * lh));
    g.restore();
  }
  const clipAt = (layer, t) => layer.find((c) => t >= c.start - EPS && t < c.end - EPS) || null;

  // one composited frame of the plan at time t, onto a canvas (匯出影格, the export's first look)
  E.still = async (plan, t, width) => {
    const k = width / plan.width, W = Math.round(width), H = Math.round(plan.height * k);
    const cv = new OffscreenCanvas(W, H), g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (const layer of plan.layers) {
      const c = clipAt(layer, t);
      if (!c) continue;
      c.t = t;
      if (c.kind === 'text') { drawText(g, c, k); continue; }
      if (c.kind === 'still') { place(g, c, k, (x, y, w, h) => g.drawImage(c.img, x, y, w, h)); continue; }
      const feed = new Feed(c);
      try {
        const s = await feed.at(c.srcIn + (t - c.start) * c.speed);
        if (s) place(g, c, k, (x, y, w, h) => s.draw(g, x, y, w, h));
      } finally { feed.close(); }
    }
    return cv;
  };

  // the sound of the plan's clips, mixed: chunks of 48 kHz stereo
  class Reader {
    constructor(track, from, to) {
      this.it = new MB.AudioBufferSink(track).buffers(Math.max(0, from), to)[Symbol.asyncIterator]();
      this.chunks = []; this.done = false; this.end = Math.max(0, from); this.k = 0;
    }
    async ensure(t) {
      while (!this.done && this.end < t) {
        const r = await this.it.next();
        if (r.done) { this.done = true; break; }
        const { buffer, timestamp } = r.value, n = buffer.numberOfChannels;
        this.chunks.push({ t: timestamp, sr: buffer.sampleRate, len: buffer.length, l: buffer.getChannelData(0), r: n > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0) });
        this.end = timestamp + buffer.length / buffer.sampleRate;
      }
    }
    drop(t) { while (this.chunks.length > 2 && this.chunks[0].t + this.chunks[0].len / this.chunks[0].sr < t) { this.chunks.shift(); this.k = Math.max(0, this.k - 1); } }
    get(s, out) {
      const cs = this.chunks;
      for (let tries = 0; tries < cs.length; tries++) {
        const c = cs[this.k];
        if (!c) { this.k = 0; continue; }
        const p = (s - c.t) * c.sr;
        if (p < 0) { if (this.k > 0) { this.k--; continue; } break; }
        if (p >= c.len) { if (this.k < cs.length - 1) { this.k++; continue; } break; }
        const i = p | 0, f = p - i, j = i + 1 < c.len ? i + 1 : i;
        out[0] = c.l[i] + (c.l[j] - c.l[i]) * f; out[1] = c.r[i] + (c.r[j] - c.r[i]) * f;
        return;
      }
      out[0] = 0; out[1] = 0;
    }
    close() { try { this.it.return && this.it.return(); } catch {} this.chunks = []; }
  }
  class Mixer {
    constructor(clips, t0) { this.clips = clips.map((c) => ({ ...c, reader: null })); this.t0 = t0; }
    async render(at, dur) {
      const SR = 48000, n = Math.max(1, Math.round(dur * SR)), L = new Float32Array(n), R = new Float32Array(n), v = [0, 0];
      const ta = this.t0 + at, tb = ta + n / SR;
      for (const c of this.clips) {
        if (c.end <= ta || c.start >= tb) { if (c.reader && c.end <= ta) { c.reader.close(); c.reader = null; } continue; }
        if (!c.reader) c.reader = new Reader(c.info.audio.track, c.srcIn + Math.max(0, ta - c.start) * c.speed - 0.2, c.srcIn + (c.end - c.start) * c.speed + 0.2);
        const i0 = Math.max(0, Math.ceil((c.start - ta) * SR)), i1 = Math.min(n, Math.ceil((c.end - ta) * SR));
        if (i1 <= i0) continue;
        const map = (i) => c.srcIn + (ta + i / SR - c.start) * c.speed;
        await c.reader.ensure(map(i1) + 0.05);
        c.reader.drop(map(i0) - 0.1);
        for (let i = i0; i < i1; i++) {
          let gain = c.gain;
          const tt = ta + i / SR;
          if (c.fadeIn && tt < c.start + c.fadeIn) gain *= (tt - c.start) / c.fadeIn;
          if (c.fadeOut && tt > c.end - c.fadeOut) gain *= (c.end - tt) / c.fadeOut;
          c.reader.get(map(i), v);
          L[i] += v[0] * gain; R[i] += v[1] * gain;
        }
      }
      const data = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { data[2 * i] = Math.max(-1, Math.min(1, L[i])); data[2 * i + 1] = Math.max(-1, Math.min(1, R[i])); }
      return new MB.AudioSample({ data, format: 'f32', numberOfChannels: 2, sampleRate: SR, timestamp: at });
    }
    close() { for (const c of this.clips) if (c.reader) c.reader.close(); }
  }

  // which audio codec this browser can encode: AAC (everywhere but Linux Chrome), else Opus
  E.audioCodec = async () => {
    for (const c of ['aac', 'opus']) { try { if (await MB.canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: 192e3 })) return c; } catch {} }
    return null;
  };
  E.canVideo = async (codec, width, height, bitrate) => { try { return await MB.canEncodeVideo(codec, { width, height, bitrate }); } catch { return false; } };

  function makeOutput(opts) {
    const target = opts.writable ? new MB.StreamTarget(opts.writable, { chunked: true }) : new MB.BufferTarget();
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: opts.writable ? false : 'in-memory' }), target });
    return { target, output };
  }

  // plan: { fps, fpsExact, width, height, t0, t1, layers: [[clip…]] (bottom first), audio: [clip…] }
  // opts: { codec, bitrate, width, height, audioCodec, audioBitrate, writable }
  // hooks: { progress(p, text), canceled() }
  E.render = async (plan, opts, hooks) => {
    const W = opts.width || plan.width, H = opts.height || plan.height, fps = plan.fps, k = W / plan.width;
    const { target, output } = makeOutput(opts);
    const canvas = new OffscreenCanvas(W, H), g = canvas.getContext('2d', { alpha: false });
    g.imageSmoothingQuality = 'high';
    const vsrc = new MB.CanvasSource(canvas, { codec: opts.codec, quality: new MB.Quality({ bitrate: opts.bitrate }), keyFrameInterval: 2 });
    output.addVideoTrack(vsrc, { frameRate: plan.fpsExact || fps });
    let asrc = null;
    if (plan.audio.length && opts.audioCodec) {
      asrc = new MB.AudioSampleSource({ codec: opts.audioCodec, quality: new MB.Quality({ bitrate: opts.audioBitrate || 192e3 }) });
      output.addAudioTrack(asrc);
    }
    const feeds = new Map(), mixer = asrc ? new Mixer(plan.audio, plan.t0) : null;
    try {
      await output.start();
      const N = Math.max(1, Math.round((plan.t1 - plan.t0) * fps)), total = N / fps;
      let audioAt = 0;
      for (let f = 0; f < N; f++) {
        if (hooks.canceled()) throw new Canceled();
        const t = plan.t0 + f / fps;
        g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
        for (const layer of plan.layers) {
          const c = clipAt(layer, t);
          if (!c) continue;
          c.t = t;
          if (c.kind === 'text') { drawText(g, c, k); continue; }
          if (c.kind === 'still') { place(g, c, k, (x, y, w, h) => g.drawImage(c.img, x, y, w, h)); continue; }
          let feed = feeds.get(c);
          if (!feed) { feed = new Feed(c); feeds.set(c, feed); }
          const s = await feed.at(c.srcIn + (t - c.start) * c.speed + EPS);
          if (s) place(g, c, k, (x, y, w, h) => s.draw(g, x, y, w, h));
        }
        // clips that have ended let their decoders go
        for (const [c, feed] of feeds) if (t >= c.end - EPS) { feed.close(); feeds.delete(c); }
        await vsrc.add(f / fps, 1 / fps);
        if (mixer) {
          while (audioAt < Math.min(total, (f + 1) / fps + 0.25) - 1e-6) {
            const d = Math.min(0.5, total - audioAt), smp = await mixer.render(audioAt, d);
            await asrc.add(smp); smp.close();
            audioAt += d;
          }
        }
        if (f % 3 === 0 || f === N - 1) hooks.progress((f + 1) / N);
      }
      for (const feed of feeds.values()) feed.close();
      feeds.clear();
      hooks.progress(1, 'finishing');
      await output.finalize();
      return target.buffer || null;
    } catch (e) {
      for (const feed of feeds.values()) feed.close();
      try { await output.cancel(); } catch {}
      throw e;
    } finally { if (mixer) mixer.close(); }
  };

  // can the clips go out as they are? One video codec and set-up for all, the same for the sound
  E.copyCheck = async (clips) => {
    if (!clips.length) return 'empty';
    const sameBytes = (a, b) => { if (!a && !b) return true; if (!a || !b) return false; const x = new Uint8Array(a.buffer ? a.buffer : a, a.byteOffset || 0, a.byteLength), y = new Uint8Array(b.buffer ? b.buffer : b, b.byteOffset || 0, b.byteLength); if (x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
    let v0 = null, a0 = null, audio = null;
    for (const c of clips) {
      if (!c.info.video) return 'novideo';
      const v = await c.info.video.track.getDecoderConfig();
      if (!v) return 'config';
      if (!v0) v0 = v;
      else if (v.codec !== v0.codec || v.codedWidth !== v0.codedWidth || v.codedHeight !== v0.codedHeight || !sameBytes(v.description, v0.description)) return 'mixed';
      const has = !!c.info.audio;
      if (audio === null) audio = has;
      else if (audio !== has) return 'audio-mixed';
      if (has) {
        const a = await c.info.audio.track.getDecoderConfig();
        if (!a) return 'config';
        if (!a0) a0 = a;
        else if (a.codec !== a0.codec || a.sampleRate !== a0.sampleRate || a.numberOfChannels !== a0.numberOfChannels || !sameBytes(a.description, a0.description)) return 'audio-mixed';
      }
    }
    return '';
  };

  // clips: [{ info, srcIn, srcOut }] played one after another; → { buffer, cuts: [the real start of each clip] }
  E.copy = async (clips, opts, hooks) => {
    const first = clips[0], vt = first.info.video.track;
    const vcfg = await vt.getDecoderConfig();
    const withAudio = opts.audio !== false && !!first.info.audio, acfg = withAudio ? await first.info.audio.track.getDecoderConfig() : null;
    const { target, output } = makeOutput(opts);
    const vOut = new MB.EncodedVideoPacketSource(first.info.video.codec);
    output.addVideoTrack(vOut, { rotation: first.info.video.rotation || 0 });
    let aOut = null;
    if (withAudio) { aOut = new MB.EncodedAudioPacketSource(first.info.audio.codec); output.addAudioTrack(aOut); }
    const total = clips.reduce((s, c) => s + (c.srcOut - c.srcIn), 0);
    let tOut = 0, firstV = true, firstA = true, done = 0;
    const cuts = [];
    try {
      await output.start();
      for (const c of clips) {
        const vs = new MB.EncodedPacketSink(c.info.video.track);
        const key = (await vs.getKeyPacket(c.srcIn + EPS, { verifyKeyPackets: true })) || (await vs.getFirstKeyPacket());
        if (!key) continue;
        const start = key.timestamp;
        cuts.push(start);
        let end = start, p = key;
        while (p) {
          if (hooks.canceled()) throw new Canceled();
          if (p !== key && p.timestamp >= c.srcOut - EPS) break;
          await vOut.add(p.clone({ timestamp: p.timestamp - start + tOut }), firstV ? { decoderConfig: vcfg } : undefined);
          firstV = false;
          end = Math.max(end, p.timestamp + p.duration);
          p = await vs.getNextPacket(p);
          if (++done % 30 === 0) hooks.progress(Math.min(0.99, (tOut + (end - start)) / total));
        }
        if (aOut) {
          const as = new MB.EncodedPacketSink(c.info.audio.track);
          let q = await as.getPacket(start + EPS);
          if (q && q.timestamp < start - EPS) q = await as.getNextPacket(q);
          while (q && q.timestamp < end - EPS) {
            await aOut.add(q.clone({ timestamp: q.timestamp - start + tOut }), firstA ? { decoderConfig: acfg } : undefined);
            firstA = false;
            q = await as.getNextPacket(q);
          }
        }
        tOut += end - start;
      }
      hooks.progress(1, 'finishing');
      await output.finalize();
      return { buffer: target.buffer || null, cuts, duration: tOut };
    } catch (e) {
      try { await output.cancel(); } catch {}
      throw e;
    }
  };

  window.CutEngine = E;
})();
