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
  const fn = async audio => { const st = rec.createStream(); st.acceptWaveform({ samples: audio, sampleRate: 16000 }); await rec.decodeAsync(st); return rec.getResult(st).text || ''; };
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
function pump() {
  if (!read$.fast || !read$.slow) return;
  for (const lane of LANES >= 2 ? ['fast', 'slow'] : ['one']) {
    if (busy[lane]) continue;
    // phrase readings and double-checks first, then live readings
    let i = queue.findIndex(j => laneFor(j.kind) === lane && j.kind !== 'partial');
    if (i < 0) i = queue.findIndex(j => laneFor(j.kind) === lane);
    if (i >= 0) run(queue.splice(i, 1)[0], lane);
  }
}
async function run(job, lane) {
  busy[lane] = true;
  const t = Date.now();
  let text = '', error;
  try { text = await modelFor(job.kind)(job.audio); } catch (e) { error = String((e && e.message) || e); }
  busy[lane] = false;
  if (job.ws.readyState === 1) job.ws.send(JSON.stringify({ type: 'result', id: job.id, kind: job.kind, seg: job.seg, text, error, ms: Date.now() - t, secs: job.audio.length / 16000 }));
  pump();
}
loading.then(pump);

// ---- the website (same files GitHub Pages serves)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const FILES = new Set(['index.html', 'app.js', 'engine.js', 'quran-data.js', 'asr-worker.js', 'coi-sw.js']);
const server = http.createServer((req, res) => {
  let name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  // (the Sabaq website on GitHub Pages checks this from its own address: allow it)
  if (name === 'health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' }); res.end(JSON.stringify({ ready: !!(read$.fast && read$.slow), warm, queued: queue.length, models: NAMES })); return; }
  if (!FILES.has(name)) { res.writeHead(404); res.end('not found'); return; }
  // (no cross-origin isolation headers: Safari would then refuse the in-browser fallback model's code)
  res.writeHead(200, { 'content-type': TYPES[path.extname(name)], 'cache-control': 'no-cache' });
  fs.createReadStream(path.join(SITE, name)).pipe(res);
});

// ---- the recognition. Binary messages = [uint32 header length][JSON header][int16 PCM, 16 kHz mono]:
//   {t:'chunk', seg} + pcm         more audio of phrase `seg` (each sample is sent once)
//   {t:'run', id, kind, seg, len}  read phrase `seg` from its start up to `len` samples (live or final)
//   {t:'full', id, kind, seg} + pcm read this audio as it is (the double-check, with its own context)
const toFloat = (pcm) => { const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1); const a = new Float32Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s[i] / 32768; return a; };
const wss = new WebSocketServer({ server, path: '/asr', maxPayload: 16000 * 2 * 32 + 4096 });
wss.on('connection', ws => {
  const segs = new Map(); // seg -> { parts: Float32Array[], len }
  const hello = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ready', warm, threads: 0, server: true, lanes: LANES, models: NAMES }));
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
      return;
    }
    let audio;
    if (head.t === 'full') audio = toFloat(pcm);
    else {
      const s = segs.get(head.seg); if (!s) return;
      const len = Math.min(head.len || s.len, s.len);
      audio = new Float32Array(len); let o = 0;
      for (const p of s.parts) { if (o >= len) break; const take = Math.min(p.length, len - o); audio.set(p.subarray(0, take), o); o += take; }
    }
    // a newer live reading of the same phrase replaces one still waiting (it would be stale anyway)
    if (head.kind === 'partial') { const i = queue.findIndex(j => j.ws === ws && j.kind === 'partial'); if (i >= 0) queue.splice(i, 1); }
    queue.push({ ws, id: head.id, kind: head.kind, seg: head.seg, audio });
    pump();
  });
  ws.on('close', () => { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].ws === ws) queue.splice(i, 1); });
});

server.listen(PORT, () => console.log(`Sabaq speech server on http://localhost:${PORT} (WebSocket /asr)`));
