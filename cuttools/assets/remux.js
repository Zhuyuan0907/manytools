/* 影片剪輯: a video the browser can't play as it is (a dashcam's .TS), its packets copied into an MP4 that it can —
   nothing decoded or encoded, so a 3-minute recording takes seconds and every frame stays as recorded. Here, off the
   page, because the copying would hold the page still meanwhile. The MP4 goes into the browser's own private files
   (OPFS) when it has them and there's room, else it's kept in memory; either way it never leaves the computer.
   page → { file, name (in the private files), disk (try them) } · { cancel: true }
   → page { progress } · { done, file (the MP4: a File on disk or a Blob), disk, dropped (tracks left out) } · { error, canceled } */
importScripts('/video/lib/mediabunny.min.js');
const MB = self.Mediabunny;
let conv = null, stop = false;

// the private files, written through a sync handle (every browser that has them: Chrome, Firefox, Safari 15.2 on)
async function onDisk(name) {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('cut-mp4', { create: true });
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  await h.truncate(0);
  let open = true;
  const shut = async () => { if (open) { open = false; await h.flush(); await h.close(); } };
  return {
    writable: new WritableStream({ async write(c) { await h.write(c.data, { at: c.position }); }, close: shut }),
    done: async () => { await shut(); return fh.getFile(); },
    drop: async () => { try { await shut(); } catch {} try { await dir.removeEntry(name); } catch {} },
  };
}
// in memory: the pieces in order (the size of the media data is filled in over its place at the end)
function inMemory() {
  const parts = [];
  let size = 0;
  return {
    writable: new WritableStream({
      write(c) {
        const d = c.data;
        let at = c.position, off = 0;
        if (at < size) {
          for (const p of parts) {
            if (off >= d.length) break;
            if (at >= p.at && at < p.at + p.d.length) { const n = Math.min(d.length - off, p.at + p.d.length - at); p.d.set(d.subarray(off, off + n), at - p.at); at += n; off += n; }
          }
        }
        if (off < d.length) { if (at !== size) throw new Error('gap'); parts.push({ at, d: d.slice(off) }); size += d.length - off; }
      },
    }),
    done: async () => new Blob(parts.map((p) => p.d), { type: 'video/mp4' }),
    drop: async () => { parts.length = 0; },
  };
}

// the file read 16 MiB at a time, the last few pieces kept: Firefox reads a TS twice as fast this way as through
// Mediabunny's BlobSource (its stream readers start over as the picture and the sound are read side by side)
function pieces(file, size = 16 * 2 ** 20, keep = 4) {
  const got = new Map();
  const piece = (i) => {
    let p = got.get(i);
    if (p) { got.delete(i); got.set(i, p); return p; }
    p = file.slice(i * size, Math.min(file.size, (i + 1) * size)).arrayBuffer().then((b) => new Uint8Array(b));
    got.set(i, p);
    if (got.size > keep) got.delete(got.keys().next().value);
    return p;
  };
  return new MB.StreamSource({
    getSize: () => file.size,
    prefetchProfile: 'fileSystem',
    read: async (start, end) => {
      const i0 = Math.floor(start / size), i1 = Math.floor((end - 1) / size);
      if (i0 === i1) return (await piece(i0)).subarray(start - i0 * size, end - i0 * size);
      const out = new Uint8Array(end - start);
      for (let i = i0; i <= i1; i++) { const p = await piece(i), a = Math.max(start, i * size), z = Math.min(end, (i + 1) * size); out.set(p.subarray(a - i * size, z - i * size), a - start); }
      return out;
    },
  });
}

async function convert(file, sink) {
  const input = new MB.Input({ source: pieces(file), formats: MB.ALL_FORMATS });
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: false }), target: new MB.StreamTarget(sink.writable, { chunked: true, chunkSize: 8 * 2 ** 20 }) });
  conv = await MB.Conversion.init({ input, output });
  if (!conv.isValid) throw new Error(`nothing to copy (${conv.discardedTracks.map((t) => t.reason).join(', ')})`);
  let shown = -1;
  conv.onProgress = (p) => { const q = Math.floor(p * 200); if (q !== shown) { shown = q; self.postMessage({ progress: p }); } };
  if (stop) throw new Error('canceled');
  await conv.execute();
  return conv.discardedTracks.map((t) => `${t.track.type}: ${t.reason}`);
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.cancel) { stop = true; if (conv) Promise.resolve().then(() => conv.cancel()).catch(() => {}); return; }
  let sink = null, disk = false;
  try {
    if (d.disk) { try { sink = await onDisk(d.name); disk = true; } catch { sink = null; } }
    let dropped;
    try { dropped = await convert(d.file, sink || (sink = inMemory())); }
    catch (err) {
      if (stop || !disk) throw err;
      // no room in the private files (a private window has little): again, in memory
      await sink.drop(); disk = false; sink = inMemory();
      dropped = await convert(d.file, sink);
    }
    self.postMessage({ done: true, file: await sink.done(), disk, dropped });
  } catch (err) {
    if (sink) await sink.drop();
    self.postMessage({ error: String((err && err.message) || err), canceled: stop });
  }
};
