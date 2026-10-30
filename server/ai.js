/* 照片挑選's AI 初選: the page sends a few small photos (768 px JPEGs, a set taken one after another) and the user's
   standard; this writes the question, asks the AI and gives back its verdicts, checked. The AI is reached through
   agy2api (an Antigravity relay, OpenAI style) on the owner's network; its address, key and the access codes stay
   here, in server/data/ai.json (gitignored, read again when it changes):
     { "base": "<agy2api's OpenAI-style address, ending in /v1>", "key": "…", "codes": ["…"], "models": ["gemini-3-flash", …] }
   The photos go through and are forgotten; nothing is logged. A visitor needs one of the codes (the quota is the
   owner's); a code may make 3,000 calls a day, four at a time.
     GET  /pick/api/ai/status  (X-Code: …)  → { on, ok (the code's good), models: [{ id, label }] }
     POST /pick/api/ai/judge   ← { code, model, std, photos: [{ jpg, burst, note }] }
                               → { photos: [{ n, verdict: 'keep' | 'maybe' | 'drop', rank?, issues, why }], summary }
   AI_MOCK=1 answers without asking anyone (for tests). */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONF_FILE = path.join(__dirname, 'data', 'ai.json');
const MOCK = process.env.AI_MOCK === '1';
const MODELS = [
  { id: 'gemini-3-flash', label: '快（Gemini 3 Flash）' },
  { id: 'gemini-3.8-flash-low', label: '仔細（Gemini 3.8 Flash，慢）' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
];
let confCache = { at: -1, conf: null };
function conf() {
  if (MOCK) return { base: 'mock', key: 'mock', codes: ['test'], models: MODELS.map((m) => m.id) };
  let st;
  try { st = fs.statSync(CONF_FILE); } catch { return null; }
  if (st.mtimeMs !== confCache.at) {
    let c = null;
    try { c = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')); } catch {}
    confCache = { at: st.mtimeMs, conf: c && c.base && c.key ? c : null };
  }
  return confCache.conf;
}
const models = (c) => MODELS.filter((m) => !Array.isArray(c.models) || c.models.includes(m.id));
function codeOk(c, code) {
  const codes = Array.isArray(c.codes) ? c.codes : [];
  if (!codes.length) return false;
  const b = Buffer.from(String(code || '').slice(0, 64));
  return codes.some((x) => { const a = Buffer.from(String(x)); return a.length === b.length && crypto.timingSafeEqual(a, b); });
}

// each code: 3,000 calls a day, four at a time; everyone: eight at a time
const DAY = 864e5;
const used = new Map();   // code → { day, n, now }
let busy = 0;
function take(code) {
  const d = Math.floor(Date.now() / DAY);
  let u = used.get(code);
  if (!u || u.day !== d) used.set(code, (u = { day: d, n: 0, now: 0 }));
  if (u.n >= 3000 || u.now >= 4 || busy >= 8) return null;
  u.n++; u.now++; busy++;
  return () => { u.now--; busy--; };
}

// ---------- the question ----------
// Three jobs, three different questions (what "good" means depends on what the photos are for):
//   review: the photos will be put up for everyone (an event's Flickr album). Not the best are wanted, only what mustn't
//           go up is stopped: 可以放 / 要看一下 / 不能放. Everything passes unless something's wrong.
//   select: many photos (a game, a whole event) down to the good ones: 精選 / 備選 / 不要, as strict as asked.
//   best:   a few photos of one thing (a portrait, a post): ranked, the best one first: 第一 / 備選 / 不要.
// Then the user's own taste (what matters, tilted or straight, foreground), and a rule of their own in words.
const TASKS = {
  review: { say: '這些照片要公開放到網路上（例如活動的 Flickr 相簿）。你不是在挑最好看的，而是找出「不適合公開」的照片：預設都可以放，只有真的有問題才擋下。', labels: ['可以放', '要看一下', '不能放'], hint: ['沒有問題', '可能有問題，請使用者確認（說出疑慮）', '明顯不適合公開'] },
  select: { say: '要從大量照片（例如一場比賽、一整場活動）中挑出精選，只留有看頭的。', labels: ['精選', '備選', '不要'], hint: ['值得放進精選', '還可以，交給使用者決定', '有問題，或比不上同組的其他張'] },
  best: { say: '這幾張是同一個主題拍的（例如人像、要發 IG 的照片），要選出最好看的那一張。請互相比較，排出名次（rank：1 是最好）。', labels: ['第一', '備選', '不要'], hint: ['最好的一張（只有一張）', '接近第一，也可以用', '明顯比較差'] },
};
const STRICT = { 1: '寬鬆：一般好的照片都可以「精選」', 2: '一般：好照片才「精選」，普通的「備選」', 3: '嚴格：只有最精彩的才「精選」，大部分「不要」' };
const AVOID = {
  awkward: '尷尬的瞬間：正在吃東西、嘴巴大開、閉眼或眨眼、怪表情、打哈欠、挖鼻子',
  indecent: '不雅：走光、露出內衣、不雅的姿勢或手勢',
  privacy: '隱私：看得清楚的螢幕內容、證件、手機畫面、密碼、個人資料、車牌',
  nophoto: '不想被拍的人：有「不拍照」標示（貼紙、名牌、掛繩顏色）的人清楚入鏡，或明顯在躲鏡頭',
  negative: '負面形象：睡覺、看起來很無聊、低頭滑手機、場面冷清',
  broken: '技術失敗：糊到看不清楚、全黑、全白',
};
const FOCUS = {
  moment: '瞬間：動作、手勢、互動的高峰（運動：出手、扣籃、表情最用力的那一刻）',
  face: '表情：自然、專注或笑；嘴巴半開、怪表情算缺點',
  eyes: '眼神：眼睛睜開，看著重點或鏡頭',
  whole: '主體完整：主角（和球、道具）不被擋住，不切到頭和手腳',
  story: '故事性：看得出在做什麼（投影片、攤位、比分、場地）',
  clean: '背景乾淨：沒有雜物、路人、穿幫',
  light: '光線：主體受光好、有層次，膚色好看',
  frame: '構圖：主體位置、線條、留白安排得好',
  mood: '氛圍：情緒、顏色、整體的感覺',
};
const TILT = { straight: '要正：水平線、建築、門框要正，歪的算缺點', any: '斜的也可以：有意的傾斜不算缺點', love: '喜歡斜：有張力的斜構圖加分' };
const FG = { no: '不要前景：前景的人或東西擋住算缺點', any: '有沒有前景都可以', love: '喜歡前景：有前景、有層次加分' };
const ISSUES = ['失焦', '手震', '閉眼', '表情不佳', '吃東西', '不雅', '隱私', '不拍照', '被擋住', '切到人', '構圖歪', '背景亂', '太暗', '過曝', '同組有更好的', '沒有重點'];
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const taskOf = (std) => (TASKS[std.task] ? std.task : 'select');

function question(std, photos) {
  const task = taskOf(std), T = TASKS[task], n = photos.length, keep = [0, 1, 2].includes(+std.keep) ? +std.keep : 1;
  const bursts = new Map();
  photos.forEach((p, i) => { if (p.burst) { if (!bursts.has(p.burst)) bursts.set(p.burst, []); bursts.get(p.burst).push(i + 1); } });
  const groups = [...bursts.values()].filter((g) => g.length > 1);
  const list = (keys, dict) => (Array.isArray(keys) ? keys : []).filter((k) => dict[k]).map((k) => `  - ${dict[k]}`);
  const focus = list(std.focus, FOCUS), avoid = list(std.avoid, AVOID);
  const notes = photos.map((p, i) => (p.note ? `  - 照片 ${i + 1}：${clip(p.note, 80)}` : '')).filter(Boolean);
  const burstRule = !groups.length ? '' : keep
    ? `連拍組（同一瞬間連拍的幾張，或幾乎一樣的照片）：${groups.map((g) => g.join('、')).join('；')}。每組最多 ${keep} 張「${T.labels[0]}」，其他寫「同組有更好的」。`
    : `連拍組（同一瞬間連拍的幾張）：${groups.map((g) => g.join('、')).join('；')}。重複不算問題，各自判斷。`;
  const rules = task === 'review'
    ? [`擋下這些（只擋這些，其他都「${T.labels[0]}」）：`, ...(avoid.length ? avoid : [`  - ${AVOID.broken}`])]
    : ['規則：', `1. 先看硬傷：主體失焦或手震、主要人物閉眼或眨眼、主體太暗或過曝看不清，就「${T.labels[2]}」（明顯是故意的動態模糊、剪影除外）。`,
      task === 'select' ? `2. 嚴格度：${STRICT[std.strict] || STRICT[2]}。` : '2. 只能有一張「第一」，其他依跟它的差距給「備選」或「不要」，並給每張 rank。',
      '3. 理由要具體，指出照片裡的東西（誰、哪裡、什麼動作），不要寫「構圖不錯」這種空話。',
      focus.length ? `重視：\n${focus.join('\n')}` : '重視：照一般好照片的標準', `構圖：${TILT[std.tilt] || TILT.any}`, `前景：${FG[std.fg] || FG.any}`];
  return `你是攝影的選片助理，像資深攝影師幫人看照片。下面是依時間順序拍的 ${n} 張照片，編號 1 到 ${n}。
任務：${T.say}
${burstRule}
替每張照片決定（verdict 只用這三個詞）：
${T.labels.map((l, i) => `- ${l}：${T.hint[i]}`).join('\n')}

${rules.join('\n')}${std.extra ? `\n使用者自己的規則（最優先）：${clip(std.extra, 200)}` : ''}
${notes.length ? `\n這台電腦先量到的（供參考，以你看到的為準）：\n${notes.join('\n')}\n` : ''}
只回 JSON，不要別的字：{"photos":[{"n":1,"verdict":"${T.labels.join('|')}",${task === 'best' ? '"rank":1,' : ''}"issues":[],"why":"20 字內，具體"}],"summary":"這一組的建議，40 字內"}
issues 盡量用這些詞：${ISSUES.join('、')}`;
}

// the answer, checked: one verdict for each photo (keep, maybe, drop, whatever the job's words), a few short words.
// Models wander: the word with more after it ("備選（同組有更好的）"), an everyday word for it, a comma too many. A photo
// left out, or a word not understood, is "maybe" (the user looks); only an answer with nothing usable fails.
const V = ['keep', 'maybe', 'drop'];
const LIKE = [/^(不留|不要|不能|不放|不適合|刪|捨|擋|排除|drop|reject|no)/i, /^(可留|備選|待定|要看|再看|疑慮|考慮|maybe|check)/i, /^(留|保留|可以|可放|放|精選|第一|最佳|通過|keep|ok|yes|best)/i];
function verdictOf(w, L) {
  w = String(w || '').trim();
  const i = L.findIndex((l) => w === l || w.startsWith(l));
  if (i >= 0) return V[i];
  for (const [k, re] of LIKE.entries()) if (re.test(w)) return V[2 - k];
  return null;
}
function readAnswer(text, n, task = 'select') {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j;
  const body = s.slice(a, b + 1);
  try { j = JSON.parse(body); } catch { try { j = JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch { return null; } }
  if (!j || !Array.isArray(j.photos) || !j.photos.length) return null;
  const L = TASKS[task].labels, out = [];
  for (let i = 1; i <= n; i++) {
    const p = j.photos.find((x) => x && +x.n === i) || j.photos[i - 1];
    if (!p) { out.push({ n: i, verdict: 'maybe', issues: [], why: '（AI 沒有說這張）' }); continue; }
    const v = verdictOf(p.verdict, L) || 'maybe';
    const rank = Math.floor(+p.rank);
    out.push({ n: i, verdict: v, ...(task === 'best' && rank > 0 ? { rank } : {}), issues: (Array.isArray(p.issues) ? p.issues : []).map((x) => clip(x, 12)).filter(Boolean).slice(0, 5), why: clip(p.why, 60) });
  }
  if (task === 'best') {   // one first: the best-ranked of those called first (or of all)
    const firsts = out.filter((p) => p.verdict === 'keep'), pool = firsts.length ? firsts : out;
    const top = pool.slice().sort((x, y) => (x.rank || 99) - (y.rank || 99))[0];
    for (const p of firsts) if (p !== top) p.verdict = 'maybe';
    top.verdict = 'keep';
  }
  return { photos: out, summary: clip(j.summary, 120) };
}

async function askAI(c, model, prompt, photos, task) {
  const content = [{ type: 'text', text: prompt }];
  photos.forEach((p, i) => { content.push({ type: 'text', text: `照片 ${i + 1}` }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${p.jpg}` } }); });
  const body = JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0.2 });
  for (let attempt = 0; ; attempt++) {
    let r, text;
    try {
      r = await fetch(`${String(c.base).replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` }, body, signal: AbortSignal.timeout(150000) });
      text = await r.text();
    } catch { if (attempt < 1) continue; return { code: 502, body: { error: 'net' } }; }
    if ((r.status === 429 || r.status >= 500) && attempt < 1) { await new Promise((ok) => setTimeout(ok, 4000)); continue; }
    if (r.status === 429) return { code: 429, body: { error: 'quota' } };
    if (!r.ok) return { code: 502, body: { error: /无可用凭证|no.*credential/i.test(text) ? 'nocred' : 'ai', status: r.status } };
    let j;
    try { j = JSON.parse(text); } catch { return { code: 502, body: { error: 'ai' } }; }
    const said = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    const ans = readAnswer(said, photos.length, task);
    if (ans) return { code: 200, body: { ...ans, model } };
    // a model taken away answers in words ("… is no longer available"); a garbled answer is asked once more
    if (/no longer available|not available|switch to/i.test(String(said))) return { code: 502, body: { error: 'model' } };
    if (attempt < 1) continue;
    return { code: 502, body: { error: 'answer' } };
  }
}

function mock(photos, task) {
  const seen = new Set();
  return { code: 200, body: { model: 'mock', summary: `（測試）${task}：每組連拍留第一張`, photos: photos.map((p, i) => {
    const first = p.burst && !seen.has(p.burst);
    if (p.burst) seen.add(p.burst);
    const v = task === 'best' ? (i === 0 ? 'keep' : i < 3 ? 'maybe' : 'drop') : p.burst ? (first ? 'keep' : 'drop') : ['keep', 'maybe', 'drop'][i % 3];
    return { n: i + 1, verdict: v, ...(task === 'best' ? { rank: i + 1 } : {}), issues: v === 'drop' ? [p.burst ? '同組有更好的' : '沒有重點'] : [], why: `測試 ${i + 1}` };
  }) } };
}

function readBody(req, max) {
  return new Promise((ok, no) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { no(new Error('big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', no);
  });
}

async function judge(req, c) {
  let d;
  try { d = JSON.parse(await readBody(req, 8e6)); } catch { return { code: 400, body: { error: 'bad' } }; }
  if (!codeOk(c, d.code)) return { code: 401, body: { error: 'code' } };
  const photos = Array.isArray(d.photos) ? d.photos : [];
  if (!photos.length || photos.length > 10) return { code: 400, body: { error: 'count' } };
  for (const p of photos) if (!p || typeof p.jpg !== 'string' || p.jpg.length > 600000 || !/^[A-Za-z0-9+/=]+$/.test(p.jpg.slice(0, 200))) return { code: 400, body: { error: 'photo' } };
  const list = models(c), model = (list.find((m) => m.id === d.model) || list[0] || MODELS[0]).id;
  const std = d.std && typeof d.std === 'object' ? d.std : {}, task = taskOf(std);
  const clean = photos.map((p) => ({ jpg: p.jpg, burst: Math.max(0, Math.min(99, Math.floor(+p.burst) || 0)), note: clip(p.note, 80) }));
  const done = take(String(d.code));
  if (!done) return { code: 429, body: { error: 'busy' } };
  try { return MOCK ? mock(clean, task) : await askAI(c, model, question(std, clean), clean, task); } finally { done(); }
}

// → true when it answered
function handle(req, res, url, send) {
  if (!url.startsWith('/pick/api/ai/')) return false;
  const c = conf(), what = url.slice('/pick/api/ai/'.length);
  if (what === 'status' && req.method === 'GET') {
    send(res, 200, c ? { on: true, ok: codeOk(c, req.headers['x-code']), models: models(c) } : { on: false, ok: false, models: [] });
    return true;
  }
  if (what === 'judge' && req.method === 'POST') {
    if (!c) return send(res, 503, { error: 'off' }), true;
    judge(req, c).then((r) => send(res, r.code, r.body), () => send(res, 500, { error: 'server' }));
    return true;
  }
  send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle, question, readAnswer };
