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
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { pipeline, env } from '@huggingface/transformers';
import { loadScorer } from './ctc-score.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, '..');
const PORT = +process.env.PORT || 8787;
// ---- settings (all from the environment, so the same file runs on this PC or a cloud host)
//   PORT, THREADS (model threads), PAD (seconds of faint noise after a live reading, default 0.6),
//   MAX_CONNS (simultaneous reciters, default 24), MAX_JOBS (queued phrase readings + double-checks per reciter,
//   default 6), ORIGINS (comma list of sites allowed to connect, e.g. https://hassaanth.github.io; empty = any),
//   LOG_EVERY (seconds between activity summaries, default 60; 0 = off)
const MAX_CONNS = +process.env.MAX_CONNS || 24;
const MAX_JOBS = +process.env.MAX_JOBS || 6;
const ORIGINS = (process.env.ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const LOG_EVERY = process.env.LOG_EVERY != null ? +process.env.LOG_EVERY : 60;
// RECORD=1: keep the recordings a page opened with ?record=1 sends (for testing; in server/recordings)
const RECORD = process.env.RECORD === '1';
const REC_DIR = path.join(HERE, 'recordings');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
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
// (the live readings get more: they are what the highlight waits for. 8 threads read 6.6 s of audio in 117 ms, 4 in
// 143 ms, on a 12-core PC; Whisper's double-checks keep their own THREADS)
const FAST_THREADS = +process.env.FAST_THREADS || Math.max(THREADS, Math.min(8, CORES - THREADS));

// ---- NVIDIA Arabic FastConformer (CTC), via sherpa-onnx. The files live in server/models/pc (CTC_DIR to choose):
// model.int8.onnx and tokens.txt, built by build-ctc-model.py from NVIDIA's own checkpoint (see the README). If
// they are missing and CTC_URL is set (a folder holding both files), they are downloaded there once.
const CTC_DIR = process.env.CTC_DIR || path.join(HERE, 'models', 'pc');
const CTC_URL = process.env.CTC_URL || '';
let scorer = null;
async function loadCtc() {
  if (process.env.NO_CTC) return null;
  fs.mkdirSync(CTC_DIR, { recursive: true });
  for (const name of ['model.int8.onnx', 'tokens.txt']) {
    const file = path.join(CTC_DIR, name);
    if (fs.existsSync(file)) continue;
    if (!CTC_URL) throw new Error(file + ' is missing (build it with build-ctc-model.py, or set CTC_URL)');
    console.log('downloading', name, '…');
    const r = await fetch(CTC_URL.replace(/\/?$/, '/') + name);
    if (!r.ok) throw new Error('download ' + name + ': HTTP ' + r.status);
    fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
    fs.renameSync(file + '.part', file);
  }
  // (the same model, run directly, for how well given words fit the audio: see ctc-score.js)
  try { scorer = await loadScorer(path.join(CTC_DIR, 'model.int8.onnx'), path.join(CTC_DIR, 'tokens.txt'), THREADS); await scorer.logprobs(new Float32Array(16000)); }
  catch (e) { scorer = null; console.error('word check not available:', e.message); }
  const sherpa = require('sherpa-onnx-node');
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { nemoCtc: { model: path.join(CTC_DIR, 'model.int8.onnx') }, tokens: path.join(CTC_DIR, 'tokens.txt'), numThreads: FAST_THREADS, provider: 'cpu', debug: 0 },
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
  if (ctc) { read$.fast = ctc; read$.slow = whisper; LANES = 2; NAMES = { live: 'fastconformer-ctc', final: 'fastconformer-ctc', verify: 'whisper-base' }; if (scorer) NAMES.score = 'fastconformer-ctc'; }
  else { read$.fast = await loadWhisper(FALLBACK_LIVE); read$.slow = whisper; LANES = 1; NAMES = { live: 'whisper-tiny', final: 'whisper-base', verify: 'whisper-base' }; }
  const t = Date.now(); await read$.fast(new Float32Array(16000)); warm = Date.now() - t;
  console.log(`models ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(NAMES)}, ${FAST_THREADS}/${THREADS} threads; a live reading costs ~${warm} ms`);
})();
// which model reads which kind of job
const modelFor = kind => (NAMES.live === 'fastconformer-ctc' ? (kind === 'verify' ? read$.slow : read$.fast) : (kind === 'partial' ? read$.fast : read$.slow));
const laneFor = kind => (kind === 'track' || (kind === 'score' && scorer && LANES >= 2) ? 'track' : LANES >= 2 ? (kind === 'verify' ? 'slow' : 'fast') : 'one');

// rolling timings per kind of reading (for /health and the log): model time, and wait from audio in to model start
const stats = { started: Date.now(), jobs: 0, errors: 0, dropped: 0, refused: 0, by: {} };
function note(kind, ms, wait) {
  const b = stats.by[kind] || (stats.by[kind] = { n: 0, ms: [], wait: [] });
  b.n++; b.ms.push(ms); b.wait.push(wait); if (b.ms.length > 200) { b.ms.shift(); b.wait.shift(); }
}
const pct = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const summary = () => Object.fromEntries(Object.entries(stats.by).map(([k, b]) => [k, { n: b.n, msMedian: pct(b.ms, 0.5), msP90: pct(b.ms, 0.9), waitMedian: pct(b.wait, 0.5), waitP90: pct(b.wait, 0.9) }]));
const queue = [];
const busy = { fast: false, slow: false, one: false, track: false };
const lastServed = { fast: null, slow: null, one: null, track: null };
const lives = new Set(); // connections streaming a phrase as it is recited
function pump() {
  if (!read$.fast || !read$.slow) return;
  for (const lane of LANES >= 2 ? (scorer ? ['fast', 'slow', 'track'] : ['fast', 'slow']) : ['one']) {
    if (busy[lane]) continue;
    // phrase readings and double-checks first, then live readings
    // (reciters take turns on each lane: someone with many queued phrases can't hold up everyone else)
    const mine = j => laneFor(j.kind) === lane;
    const pick = f => { let k = queue.findIndex(j => mine(j) && f(j) && j.ws !== lastServed[lane]); if (k < 0) k = queue.findIndex(j => mine(j) && f(j)); return k; };
    let i = pick(j => j.kind !== 'partial');
    if (i < 0) i = pick(() => true);
    if (i >= 0) { run(queue.splice(i, 1)[0], lane); continue; }
    if (lane === 'fast') { const job = liveJob(); if (job) run(job, lane); }
    if (lane === 'track') { const job = trackJob(); if (job) run(job, lane); }
  }
}
// The newest audio of a streamed phrase, if 80 ms more of it arrived since its last reading (or a pause began:
// its last word is then complete), with the faint noise after it (see below)
const LIVE_WIN = Math.round(16000 * (+process.env.LIVE_WIN || 5)), LIVE_FROM = Math.round(16000 * (+process.env.LIVE_FROM || 7));
function liveJob() {
  for (const ws of lives) {
    const L = ws.live;
    if (!L || ws.readyState !== 1) { lives.delete(ws); continue; }
    const s = ws.segs.get(L.seg);
    if (!s || s.len < 8000) continue;
    if (!(s.len - L.done >= 1280 || (L.whole && !L.doneWhole && s.len > L.done))) continue;
    // (a long phrase: only its last LIVE_WIN s. Reading the whole phrase every time costs more and more as it grows
    // (83 ms between readings at its start, 365 ms 15 s in), and the highlight falls behind a reciter who recites two
    // ayahs in one breath. The page finds where these words join the ones it already has. The phrase's final
    // reading still reads all of it.)
    const from = s.len > LIVE_FROM && !L.full ? s.len - LIVE_WIN : 0, n = s.len - from;
    L.full = false;
    const audio = new Float32Array(n + PAD); let o = 0, skip = from;
    for (const p of s.parts) { if (skip >= p.length) { skip -= p.length; continue; } const part = p.subarray(skip); skip = 0; audio.set(part, o); o += part.length; }
    audio.set(NOISE, n);
    L.done = s.len; L.doneWhole = L.whole;
    // (round robin between connections)
    lives.delete(ws); lives.add(ws);
    return { ws, kind: 'partial', seg: L.seg, whole: L.whole, pad: PAD, audio, rx: s.rx, cap: s.cap, len: s.len, skip: from / 16000 };
  }
  return null;
}
// Frame-by-frame following of a streamed phrase: the last 2 s of its audio (whatever the phrase's length, so each
// costs the same, ~50 ms), lined up with the words the page expects next, whenever 40 ms more audio came in. Its
// own lane, beside the live readings: those still give the words and the mistakes; this only places the highlight.
// (off unless TRACK=1: measured in the app, it placed the highlight no sooner than the live readings already do)
const TRACK = process.env.TRACK === '1';
const TRACK_SECS = +process.env.TRACK_SECS || 2, TRACK_PAD = Math.round(16000 * (process.env.TRACK_PAD != null ? +process.env.TRACK_PAD : 0.3));
function trackJob() {
  if (!TRACK) return null;
  for (const ws of lives) {
    const L = ws.live;
    if (!L || ws.readyState !== 1 || !L.win) continue;
    const s = ws.segs.get(L.seg);
    if (!s || s.len < 4800 || s.len - (L.tdone || 0) < 640) continue;
    const n = Math.min(s.len, Math.round(16000 * TRACK_SECS)), audio = new Float32Array(n + TRACK_PAD);
    let o = 0, skip = s.len - n;
    for (const p of s.parts) { if (skip >= p.length) { skip -= p.length; continue; } const part = p.subarray(skip); skip = 0; const take = Math.min(part.length, n - o); audio.set(part.subarray(0, take), o); o += take; if (o >= n) break; }
    audio.set(NOISE.subarray(0, TRACK_PAD), n);
    L.tdone = s.len;
    lives.delete(ws); lives.add(ws);
    return { ws, kind: 'track', seg: L.seg, pad: TRACK_PAD, audio, win: L.win, rx: s.rx, cap: s.cap };
  }
  return null;
}
async function run(job, lane) {
  busy[lane] = true; lastServed[lane] = job.ws;
  const t = Date.now();
  let text = '', gap = null, error;
  let costs, track;
  try {
    // frame-by-frame following: where in the expected words the reciter is now (see trackJob)
    if (job.kind === 'track') {
      const lp = await scorer.logprobs(job.audio), tr = scorer.track(lp, job.win.words, 0, 0.5);
      if (tr) track = { base: job.win.base, w: tr.w, begun: tr.begun, excess: tr.excess };
    } else if (job.kind === 'score') { if (!scorer) throw new Error('no word check'); const lp = await scorer.logprobs(job.audio); costs = job.windows.map(w => +scorer.cost(lp, w).toFixed(2)); }
    else { const r = await modelFor(job.kind)(job.audio); if (typeof r === 'string') text = r; else { text = r.text; gap = r.gap == null ? null : Math.max(0, r.gap - (job.pad || 0) / 16000); } }
  } catch (e) { error = String((e && e.message) || e); }
  busy[lane] = false;
  const ms = Date.now() - t, wait = job.rx ? t - job.rx : 0;
  stats.jobs++; if (error) { stats.errors++; log('reading failed (' + job.kind + '):', error); } note(job.kind, ms, wait);
  // timings: wait = from the newest audio arriving to the model starting on it; ms = the model's own time;
  // cap = the phone's clock stamp of that audio, sent back so the phone can measure the whole round trip
  if (job.ws.readyState === 1) job.ws.send(JSON.stringify({ type: 'result', id: job.id, kind: job.kind, seg: job.seg, text, gap, costs, track, whole: job.whole, len: job.len != null ? job.len : job.audio.length - (job.pad || 0), skip: job.skip || undefined, error, ms, wait, cap: job.cap, secs: (job.audio.length - (job.pad || 0)) / 16000 }));
  pump();
}
loading.then(pump);

// ---- the website (same files GitHub Pages serves)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const FILES = new Set(['index.html', 'app.js', 'engine.js', 'quran-data.js', 'asr-worker.js', 'coi-sw.js']);
const server = http.createServer((req, res) => {
  let name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  // (the Sabaq website on GitHub Pages checks this from its own address: allow it)
  if (name === 'health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }); const m = process.memoryUsage();
    res.end(JSON.stringify({ ready: !!(read$.fast && read$.slow) && !closing, warm, queued: queue.length, models: NAMES, stream: LANES >= 2 ? 3 : 2,
      conns: wss.clients.size, maxConns: MAX_CONNS, busy, threads: THREADS, cores: CORES, uptime: Math.round((Date.now() - stats.started) / 1000),
      rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), jobs: stats.jobs, errors: stats.errors, refused: stats.refused, timings: summary() })); return; }
  // a phone's short technical report (see report() in app.js): logged, nothing kept
  if (name === 'report') {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, cors); res.end(); return; }
    let body = '';
    req.on('data', c => { if (body.length < 4000) body += c; });
    req.on('end', () => { res.writeHead(204, cors); res.end(); let j = null; try { j = JSON.parse(body); } catch (e) { /* not ours */ } if (j && typeof j.what === 'string') log('phone ' + j.what.slice(0, 20) + ':', JSON.stringify(j).slice(0, 600)); });
    return;
  }
  // Recording for testing (the page opened with ?record=1; kept only when this server runs with RECORD=1): 16 kHz
  // 16-bit audio in pieces, appended to recordings/<session>.pcm, with an index of when each piece began
  if (name === 'record') {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const q = new URL(req.url, 'http://x').searchParams, sid = q.get('sid') || '', i = +q.get('i'), t = +q.get('t');
    if (req.method !== 'POST' || !RECORD || !/^[a-z0-9]{4,24}$/.test(sid) || !Number.isFinite(i) || !Number.isFinite(t)) { req.resume(); res.writeHead(RECORD ? 400 : 403, cors); res.end(); return; }
    const parts = []; let n = 0, over = false;
    req.on('data', c => { n += c.length; if (n > 16000 * 2 * 12) over = true; else parts.push(c); });
    req.on('end', () => {
      res.writeHead(over ? 413 : 204, cors); res.end();
      if (over || !n) return;
      try {
        fs.mkdirSync(REC_DIR, { recursive: true });
        const used = fs.readdirSync(REC_DIR).reduce((s, f) => s + fs.statSync(path.join(REC_DIR, f)).size, 0);
        if (used > 500 * 1048576) return; // (at most 500 MB in all)
        const file = path.join(REC_DIR, sid + '.pcm'), at = fs.existsSync(file) ? fs.statSync(file).size : 0;
        fs.appendFileSync(file, Buffer.concat(parts));
        fs.appendFileSync(path.join(REC_DIR, sid + '.txt'), JSON.stringify({ i, t, byteAt: at, bytes: n, rx: new Date().toISOString() }) + '\n');
        if (i === 0) log('recording a session for testing:', sid);
      } catch (e) { log('recording failed:', e.message); }
    });
    return;
  }
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
// (a message's bytes can sit at an odd position in memory, where 16-bit samples can't be read in place: copy them)
const toFloat = (pcm) => { if (pcm.byteOffset % 2) pcm = Buffer.from(pcm); const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1); const a = new Float32Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s[i] / 32768; return a; };
let closing = false;
const wss = new WebSocketServer({ server, path: '/asr', maxPayload: 16000 * 2 * 32 + 4096,
  verifyClient: (info, cb) => {
    if (closing) return cb(false, 503, 'restarting');
    if (ORIGINS.length && info.origin && !ORIGINS.includes(info.origin) && !ORIGINS.includes('*')) { stats.refused++; return cb(false, 403, 'origin not allowed'); }
    if (wss.clients.size >= MAX_CONNS) { stats.refused++; log('busy: refused a connection (' + wss.clients.size + ' open)'); return cb(false, 503, 'busy'); }
    cb(true);
  } });
// a phone that vanished (tunnel dropped, phone locked) without closing its connection is let go within ~40 s
const beat = setInterval(() => { for (const ws of wss.clients) { if (ws.alive === false) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) { /* gone */ } } }, 20000);
wss.on('connection', (ws, req) => {
  ws.alive = true; ws.on('pong', () => { ws.alive = true; });
  ws.on('error', e => log('connection error:', e && e.message));
  log('reciter connected (' + wss.clients.size + ' open)' + (req && req.headers.origin ? ' from ' + req.headers.origin : ''));
  const segs = new Map(); // seg -> { parts: Float32Array[], len }
  ws.segs = segs; ws.live = null;
  const hello = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ready', warm, threads: 0, server: true, lanes: LANES, models: NAMES, stream: LANES >= 2 ? 3 : 2, score: scorer ? 1 : 0, track: TRACK && scorer && LANES >= 2 ? 1 : 0 }));
  if (read$.fast && read$.slow) hello(); else loading.then(hello);
  ws.on('message', (data, isBinary) => { try { onMessage(data, isBinary); } catch (e) { console.error('bad message:', e && e.message); } });
  const onMessage = (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
    const n = buf.readUInt32LE(0);
    let head; try { head = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); } catch (e) { return; }
    const pcm = buf.subarray(4 + n);
    if (head.t === 'chunk') {
      let s = segs.get(head.seg);
      if (!s) { s = { parts: [], len: 0 }; segs.set(head.seg, s); while (segs.size > 8) segs.delete(segs.keys().next().value); }
      // (one phrase holds at most 40 s: the phone cuts phrases at 25 s, so more is a broken client)
      if (s.len > 16000 * 40) return;
      const a = toFloat(pcm); s.parts.push(a); s.len += a.length; s.rx = Date.now(); s.cap = head.cap;
      // {live: 1}: the phrase being recited now, streamed; whole: its audio ends in a short pause
      if (head.live && LANES >= 2) {
        if (!ws.live || ws.live.seg !== head.seg) { if (ws.live && head.seg < ws.live.seg) return; ws.live = { seg: head.seg, done: 0, whole: false, doneWhole: false, win: ws.live && ws.live.win }; }
        ws.live.whole = !!head.whole;
        if (head.full) ws.live.full = true; // (the page couldn't place a reading of the phrase's end: read all of it once)
        // (the words expected next, for following the reciter frame by frame: see ctc-score.js track)
        const W = head.win;
        if (W && Array.isArray(W.words) && W.words.length && W.words.length <= 40 && W.words.every(x => typeof x === 'string' && x.length <= 40) && Number.isInteger(W.base)) ws.live.win = { base: W.base, words: W.words };
        lives.add(ws); pump();
      }
      return;
    }
    let audio;
    // the phrase's reading: it is no longer streamed
    if (head.kind === 'final' && ws.live && ws.live.seg <= head.seg) ws.live = null;
    // (a word check: up to 8 runs of up to 8 words, on audio sent with it)
    if (head.kind === 'score') {
      const ok = Array.isArray(head.windows) && head.windows.length && head.windows.length <= 8 && head.windows.every(w => Array.isArray(w) && w.length && w.length <= 8 && w.every(x => typeof x === 'string' && x.length <= 40));
      if (!ok || !scorer || head.t !== 'full') { ws.send(JSON.stringify({ type: 'result', id: head.id, kind: 'score', seg: head.seg, error: 'no word check' })); return; }
    }
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
    // (each reciter may have only so many phrase readings and double-checks waiting)
    if (head.kind !== 'partial' && queue.filter(j => j.ws === ws && j.kind !== 'partial').length >= MAX_JOBS) {
      stats.dropped++; ws.send(JSON.stringify({ type: 'result', id: head.id, kind: head.kind, seg: head.seg, text: '', error: 'busy' })); return;
    }
    queue.push({ ws, id: head.id, kind: head.kind, seg: head.seg, whole: head.whole, pad: head.pad || 0, audio, rx: Date.now(), cap: head.cap, windows: head.windows });
    pump();
  };
  ws.on('close', () => { log('reciter left (' + wss.clients.size + ' open)'); segs.clear(); lives.delete(ws); for (let i = queue.length - 1; i >= 0; i--) if (queue[i].ws === ws) queue.splice(i, 1); });
});

server.listen(PORT, () => log(`Sabaq speech server on http://localhost:${PORT} (WebSocket /asr), up to ${MAX_CONNS} reciters` + (ORIGINS.length ? ', sites: ' + ORIGINS.join(' ') : '')));
if (LOG_EVERY > 0) setInterval(() => { if (stats.jobs) log('activity:', wss.clients.size, 'connected,', queue.length, 'queued,', JSON.stringify(summary()), 'rss', Math.round(process.memoryUsage().rss / 1048576) + 'MB'); }, LOG_EVERY * 1000).unref();
// Graceful stop (a cloud host sends SIGTERM before replacing the server): no new reciters, the open ones are told
// (their phones reconnect by themselves), readings in progress finish (up to 3 s), then exit.
function shutdown(sig) {
  if (closing) return; closing = true; log(sig + ': stopping');
  clearInterval(beat);
  for (const ws of wss.clients) { try { ws.send(JSON.stringify({ type: 'bye' })); ws.close(1012, 'restarting'); } catch (e) { /* gone */ } }
  server.close();
  const end = Date.now() + 3000;
  const wait = () => ((busy.fast || busy.slow || busy.one) && Date.now() < end ? setTimeout(wait, 100) : process.exit(0));
  wait();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => { stats.errors++; log('unhandled:', e && (e.stack || e.message || e)); });
