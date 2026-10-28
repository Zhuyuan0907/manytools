/* ZhuyuanLoveExif: a picture at ½, ¼ … of its size, made off the page from its file (resizing a 24-megapixel picture
   on the page freezes it for a moment). The page draws a zooming frame from the smallest of them still as big as on
   screen.
   In:  { id, blob, w, h }   the file (or the JPEG inside a RAW), and the size the page decoded it at
   Out: { id, levels: [w/2, w/4, …] } down to under 1,200 px on the long side */
'use strict';
self.onmessage = async ({ data: { id, blob, w, h } }) => {
  const levels = [];
  try {
    for (let k = 2; Math.max(w, h) / k * 2 >= 1200; k *= 2) {
      levels.push(await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: Math.max(1, Math.round(w / k)), resizeHeight: Math.max(1, Math.round(h / k)), resizeQuality: 'medium' }));
    }
  } catch { /* what there is */ }
  self.postMessage({ id, levels }, levels);
};
