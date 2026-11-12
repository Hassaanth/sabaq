// Sabaq's speech server: server-side recognition, the way Tarteel does it (their app streams your voice to
// their servers, where NVIDIA NeMo FastConformer models run; Chrome on a computer does the same with Google's).
// The phone records and cuts the recitation into phrases, uploads the audio, and gets the words back.
//
// Two kinds of model, chosen by measurement on real recitation (Al-Mulk 1-10, Alafasy / Husary / Minshawi):
//  - NVIDIA's Arabic FastConformer, CTC (stt_ar_fastconformer_hybrid_large_pc_v1.0, CC-BY-4.0, credit:
//    NVIDIA; int8 export for sherpa-onnx). 117/114/117 of 117 words, and it reads only the audio you said:
//    31 ms for 1 s of audio, 152 ms for 7 s. Used for the live readings that move the highlight and for
//    each phrase's reading.
//  - Tarteel's Whisper base Quran model (tarteel-ai/whisper-base-ar-quran, Apache-2.0): 117/117/117, but about
//    1.5 s per reading (Whisper always hears 30 s). Used only for the double-check before a stop: a different
//    kind of model, so the two readings are independent.
// If the FastConformer can't be loaded, the server falls back to Whisper for everything.
//
//   cd server && npm install && npm start          -> http://localhost:8787  (site + WebSocket at /asr)
//
// It also serves the Sabaq website itself, so one address (e.g. an HTTPS tunnel or a cloud host) gives the
// phone both the page and the recognition. PORT and THREADS can be set in the environment.
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { pipeline, env } from '@huggingface/transformers';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, '..');
const PORT = +process.env.PORT || 8787;
const MODEL = process.env.MODEL || 'eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran';
const FALLBACK_LIVE = 'Sharjeelbaig/whisper-tiny-ar-quran-onnx';
// Some model builds cannot be told the language (their config lacks the table); Arabic Quran is all they know
async function read(p, audio, extra) {
  if (!p.gen) p.gen = { language: 'ar', task: 'transcribe' };
  try { return await p(audio, Object.assign({}, p.gen, extra)); }
  catch (e) { if (p.gen.language && /language|English-only|<\|ar\|>/.test(String(e && e.message))) { p.gen = {}; return p(audio, Object.assign({}, extra)); } throw e; }
}
// model files are cached outside the app folder (HF_CACHE to choose; a sandboxed folder can hide files from the runtime)
env.cacheDir = process.env.HF_CACHE || path.join(os.tmpdir(), 'sabaq-hf-cache');
// (checked: neither word is in the Quran; شكرا is, 34:13, so it stays)
const NOT_QURAN = new Set(['نهاية', 'الدرس']);
const CORES = os.cpus().length;
const THREADS = +process.env.THREADS || Math.max(1, Math.min(4, CORES >> 1 || 1));

// ---- NVIDIA Arabic FastConformer (CTC), via sherpa-onnx; downloaded once, checked against its published hashes
const CTC_DIR = path.join(env.cacheDir, 'fastconformer-ar-ctc');
const CTC_URL = 'https://github.com/OmarrGhorab/openbot-personal/releases/download/models-fastconformer-ar-v1/';
const CTC_FILES = {
  'model.int8.onnx': 'ce25098a710db5bf44284530707559f7b4be9b12cfc550816b5f9cc869a3c121',
  'tokens.txt': 'b5d39b52143723e71d997ed5dd8a68aa5facbd0a7c84a47669f83b0033d33164',
};
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function loadCtc() {
  if (process.env.NO_CTC) return null;
  fs.mkdirSync(CTC_DIR, { recursive: true });
  for (const [name, hash] of Object.entries(CTC_FILES)) {
    const file = path.join(CTC_DIR, name);
    if (fs.existsSync(file) && sha256(file) === hash) continue;
    console.log('downloading', name, '…');
    const r = await fetch(CTC_URL + name);
    if (!r.ok) throw new Error('download ' + name + ': HTTP ' + r.status);
    fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
    if (sha256(file + '.part') !== hash) throw new Error(name + ': checksum mismatch');
    fs.renameSync(file + '.part', file);
  }
  const sherpa = require('sherpa-onnx-node');
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { nemoCtc: { model: path.join(CTC_DIR, 'model.int8.onnx') }, tokens: path.join(CTC_DIR, 'tokens.txt'), numThreads: THREADS, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
  });
  // (with how long ago the last letter was heard: 0.3 s later with no new letter, the last word is finished,
  // so the phone can move the highlight on at once instead of waiting for the next word)
  const fn = async audio => {
    const st = rec.createStream(); st.acceptWaveform({ samples: audio, sampleRate: 16000 }); await rec.decodeAsync(st);
    const r = rec.getResult(st), ts = r.timestamps || [];
    // (on silence or noise the model sometimes writes "نهاية الدرس" / "شكرا الدرس" ("end of the lesson",
    // "thanks, the lesson"): words from its training data; the ones not in the Quran are dropped)
    return { text: (r.text || '').split(/\s+/).filter(w => w && !NOT_QURAN.has(w)).join(' '), gap: ts.length ? Math.max(0, audio.length / 16000 - ts[ts.length - 1]) : null };
  };
  await fn(new Float32Array(16000)); // warm up
  return fn;
}
async function loadWhisper(name) {
  const p = await pipeline('automatic-speech-recognition', name, { dtype: 'q8', session_options: { intraOpNumThreads: THREADS } });
  await read(p, new Float32Array(16000), {});
  return async audio => { const r = await read(p, audio, { max_new_tokens: Math.min(440, Math.ceil(audio.length / 16000 * 20) + 16) }); return (r && r.text) || ''; };
}

// ---- models and lanes. "fast" reads live readings and phrase readings; "slow" reads the double-checks, so live
// tracking never waits behind one.
const read$ = { fast: null, slow: null };
let warm = 0, LANES = 1, NAMES = {};
const t0 = Date.now();
const loading = (async () => {
  let ctc = null;
  try { ctc = await loadCtc(); } catch (e) { console.error('FastConformer not available (' + e.message + '); using Whisper only.'); }
  const whisper = await loadWhisper(MODEL);
  if (ctc) { read$.fast = ctc; read$.slow = whisper; LANES = 2; NAMES = { live: 'fastconformer-ctc', final: 'fastconformer-ctc', verify: 'whisper-base' }; }
  else { read$.fast = await loadWhisper(FALLBACK_LIVE); read$.slow = whisper; LANES = 1; NAMES = { live: 'whisper-tiny', final: 'whisper-base', verify: 'whisper-base' }; }
  const t = Date.now(); await read$.fast(new Float32Array(16000)); warm = Date.now() - t;
  console.log(`models ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(NAMES)}, ${THREADS} threads; a live reading costs ~${warm} ms`);
})();
// which model reads which kind of job
const modelFor = kind => (NAMES.live === 'fastconformer-ctc' ? (kind === 'verify' ? read$.slow : read$.fast) : (kind === 'partial' ? read$.fast : read$.slow));
const laneFor = kind => (LANES >= 2 ? (kind === 'verify' ? 'slow' : 'fast') : 'one');

const queue = [];
const busy = { fast: false, slow: false, one: false };
const lives = new Set(); // connections streaming a phrase as it is recited
function pump() {
  if (!read$.fast || !read$.slow) return;
  for (const lane of LANES >= 2 ? ['fast', 'slow'] : ['one']) {
    if (busy[lane]) continue;
    // phrase readings and double-checks first, then live readings
    let i = queue.findIndex(j => laneFor(j.kind) === lane && j.kind !== 'partial');
    if (i < 0) i = queue.findIndex(j => laneFor(j.kind) === lane);
    if (i >= 0) { run(queue.splice(i, 1)[0], lane); continue; }
    if (lane === 'fast') { const job = liveJob(); if (job) run(job, lane); }
  }
}
// The newest audio of a streamed phrase, if 80 ms more of it arrived since its last reading (or a pause began:
// its last word is then complete), with the faint noise after it (see below)
function liveJob() {
  for (const ws of lives) {
    const L = ws.live;
    if (!L || ws.readyState !== 1) { lives.delete(ws); continue; }
    const s = ws.segs.get(L.seg);
    if (!s || s.len < 8000) continue;
    if (!(s.len - L.done >= 1280 || (L.whole && !L.doneWhole && s.len > L.done))) continue;
    const audio = new Float32Array(s.len + PAD); let o = 0;
    for (const p of s.parts) { audio.set(p, o); o += p.length; }
    audio.set(NOISE, s.len);
    L.done = s.len; L.doneWhole = L.whole;
    // (round robin between connections)
    lives.delete(ws); lives.add(ws);
    return { ws, kind: 'partial', seg: L.seg, whole: L.whole, pad: PAD, audio };
  }
  return null;
}
async function run(job, lane) {
  busy[lane] = true;
  const t = Date.now();
  let text = '', gap = null, error;
  try { const r = await modelFor(job.kind)(job.audio); if (typeof r === 'string') text = r; else { text = r.text; gap = r.gap == null ? null : Math.max(0, r.gap - (job.pad || 0) / 16000); } } catch (e) { error = String((e && e.message) || e); }
  busy[lane] = false;
  if (job.ws.readyState === 1) job.ws.send(JSON.stringify({ type: 'result', id: job.id, kind: job.kind, seg: job.seg, text, gap, whole: job.whole, len: job.audio.length - (job.pad || 0), error, ms: Date.now() - t, secs: (job.audio.length - (job.pad || 0)) / 16000 }));
  pump();
}
loading.then(pump);

// ---- the website (same files GitHub Pages serves)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const FILES = new Set(['index.html', 'app.js', 'engine.js', 'quran-data.js', 'asr-worker.js', 'coi-sw.js']);
const server = http.createServer((req, res) => {
  let name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  // (the Sabaq website on GitHub Pages checks this from its own address: allow it)
  if (name === 'health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }); res.end(JSON.stringify({ ready: !!(read$.fast && read$.slow), warm, queued: queue.length, models: NAMES, stream: LANES >= 2 ? 3 : 2 })); return; }
  if (!FILES.has(name)) { res.writeHead(404); res.end('not found'); return; }
  // (no cross-origin isolation headers: Safari would then refuse the in-browser fallback model's code)
  res.writeHead(200, { 'content-type': TYPES[path.extname(name)], 'cache-control': 'no-cache' });
  fs.createReadStream(path.join(SITE, name)).pipe(res);
});

// ---- the recognition. Binary messages = [uint32 header length][JSON header][int16 PCM, 16 kHz mono]:
//   {t:'chunk', seg} + pcm         more audio of phrase `seg` (each sample is sent once)
//   {t:'run', id, kind, seg, len}  read phrase `seg` from its start up to `len` samples (live or final)
//   {t:'full', id, kind, seg} + pcm read this audio as it is (the double-check, with its own context)
const PAD = Math.round(16000 * (process.env.PAD != null ? +process.env.PAD : 0.6));
const NOISE = new Float32Array(PAD); { let x = 12345; for (let i = 0; i < PAD; i++) { x = (x * 1103515245 + 12345) >>> 0; NOISE[i] = (x / 4294967296 - 0.5) * 0.003; } }
const toFloat = (pcm) => { const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1); const a = new Float32Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s[i] / 32768; return a; };
const wss = new WebSocketServer({ server, path: '/asr', maxPayload: 16000 * 2 * 32 + 4096 });
wss.on('connection', ws => {
  const segs = new Map(); // seg -> { parts: Float32Array[], len }
  ws.segs = segs; ws.live = null;
  const hello = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ready', warm, threads: 0, server: true, lanes: LANES, models: NAMES, stream: LANES >= 2 ? 3 : 2 }));
  if (read$.fast && read$.slow) hello(); else loading.then(hello);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
    const n = buf.readUInt32LE(0);
    let head; try { head = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); } catch (e) { return; }
    const pcm = buf.subarray(4 + n);
    if (head.t === 'chunk') {
      let s = segs.get(head.seg);
      if (!s) { s = { parts: [], len: 0 }; segs.set(head.seg, s); while (segs.size > 8) segs.delete(segs.keys().next().value); }
      const a = toFloat(pcm); s.parts.push(a); s.len += a.length;
      // {live: 1}: the phrase being recited now, streamed; whole: its audio ends in a short pause
      if (head.live && LANES >= 2) {
        if (!ws.live || ws.live.seg !== head.seg) { if (ws.live && head.seg < ws.live.seg) return; ws.live = { seg: head.seg, done: 0, whole: false, doneWhole: false }; }
        ws.live.whole = !!head.whole;
        lives.add(ws); pump();
      }
      return;
    }
    let audio;
    // the phrase's reading: it is no longer streamed
    if (head.kind === 'final' && ws.live && ws.live.seg <= head.seg) ws.live = null;
    if (head.t === 'full') audio = toFloat(pcm);
    else {
      const s = segs.get(head.seg); if (!s) return;
      const len = Math.min(head.len || s.len, s.len);
      // A live reading gets 0.6 s of faint room noise after the audio: an offline model holds back the newest word
      // at the very end of what it hears; with a little "after" it writes it out ~0.2 s sooner, and makes up half as
      // many words at the end (measured on Al-Mulk 2-5: 6.5% of readings instead of 13.5%).
      const pad = head.kind === 'partial' && LANES >= 2 ? PAD : 0;
      audio = new Float32Array(len + pad); let o = 0;
      for (const p of s.parts) { if (o >= len) break; const take = Math.min(p.length, len - o); audio.set(p.subarray(0, take), o); o += take; }
      if (pad) audio.set(NOISE.subarray(0, pad), len);
      head.pad = pad;
    }
    // a newer live reading replaces one still waiting (it would be stale anyway); the phone is told, so it
    // can keep several readings on their way (the next one is always already here when the model is free)
    if (head.kind === 'partial') {
      const i = queue.findIndex(j => j.ws === ws && j.kind === 'partial');
      if (i >= 0) { const old = queue.splice(i, 1)[0]; ws.send(JSON.stringify({ type: 'result', kind: 'partial', seg: old.seg, dropped: true })); }
    }
    queue.push({ ws, id: head.id, kind: head.kind, seg: head.seg, whole: head.whole, pad: head.pad || 0, audio });
    pump();
  });
  ws.on('close', () => { lives.delete(ws); for (let i = queue.length - 1; i >= 0; i--) if (queue[i].ws === ws) queue.splice(i, 1); });
});

server.listen(PORT, () => console.log(`Sabaq speech server on http://localhost:${PORT} (WebSocket /asr)`));
