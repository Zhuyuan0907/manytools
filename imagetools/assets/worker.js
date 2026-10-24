/* Runs compress.js off the page so a big photo doesn't freeze it while it's encoded several times. */
self.window = self; // UPNG.js finds pako on window and puts itself there
importScripts('../lib/pako.min.js', '../lib/UPNG.min.js', `compress.js${self.location.search}`); // compress.js: same version as the page asked for
self.onmessage = async (e) => {
  const { id, file, opts } = e.data;
  try {
    const r = await self.compressImage(file, opts);
    self.postMessage({ id, ok: true, ...r });
  } catch (err) {
    self.postMessage({ id, ok: false, code: err.code || 'error', message: String(err && err.message) });
  }
};
