// Sabaq's speech server: server-side recognition, the way Tarteel does it (their app streams your voice to
// their GPU servers; Chrome on a computer does the same with Google's). The phone records and cuts the
// recitation into phrases exactly as before, and sends each phrase here instead of running the model
// itself. Here the same model, Tarteel's open Quran Whisper (tarteel-ai/whisper-base-ar-quran, Apache-2.0),
// runs natively, many times faster than in a phone browser.
//
//   cd server && npm install && npm start          -> http://localhost:8787  (site + WebSocket at /asr)
//
// It also serves the Sabaq website itself, so one address (e.g. an HTTPS tunnel or a cloud host) gives the
// phone both the page and the recognition. PORT and THREADS can be set in the environment.
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { pipeline, env } from '@huggingface/transformers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, '..');
const PORT = +process.env.PORT || 8787;
// Tarteel's base Quran model: on a server there is no phone to spare, so the larger, more accurate model
// (on Al-Mulk 1-10: 117/117 words for each of Alafasy, Husary and Minshawi, against 116, 112 and 112 for the
// tiny model the phone runs itself)
const MODEL = process.env.MODEL || 'eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran';
// Live readings (re-read every moment while you recite, only to move the highlight) use the tiny model:
// about 3x faster, so tracking is smoother. Final readings and double-checks, which decide mistakes, use
// the accurate model. LIVE_MODEL=same uses one model for both.
const LIVE_MODEL = process.env.LIVE_MODEL === 'same' ? MODEL : (process.env.LIVE_MODEL || 'Sharjeelbaig/whisper-tiny-ar-quran-onnx');
// Some model builds cannot be told the language (their config lacks the table); Arabic Quran is all they know
async function read(p, audio, extra) {
  if (!p.gen) p.gen = { language: 'ar', task: 'transcribe' };
  try { return await p(audio, Object.assign({}, p.gen, extra)); }
  catch (e) { if (p.gen.language && /language|English-only|<\|ar\|>/.test(String(e && e.message))) { p.gen = {}; return p(audio, Object.assign({}, extra)); } throw e; }
}
// model files are cached outside the app folder (HF_CACHE to choose; a sandboxed folder can hide files from the runtime)
env.cacheDir = process.env.HF_CACHE || path.join(os.tmpdir(), 'sabaq-hf-cache');

// ---- the models. One lane by default: final readings first, then live ones. LANES=2 reads a live reading and
// a final reading side by side; it only helps with plenty of CPU cores or a GPU (measured on a 6-core PC: the
// two models slowed each other down, highlight lag 1.8 s instead of 1.5 s).
let asr = null, asrLive = null, warm = 0;
const t0 = Date.now();
const CORES = os.cpus().length;
const LANES = +process.env.LANES || 1;
const opts = { dtype: 'q8', session_options: { intraOpNumThreads: +process.env.THREADS || Math.max(1, Math.min(4, Math.floor(CORES / LANES))) } };
async function ready(name) {
  const p = await pipeline('automatic-speech-recognition', name, opts);
  await read(p, new Float32Array(16000), {});           // warm up
  return p;
}
const loading = (async () => {
  asr = await ready(MODEL);
  asrLive = LIVE_MODEL === MODEL ? asr : await ready(LIVE_MODEL);
  const t = Date.now(); await read(asrLive, new Float32Array(16000), { max_new_tokens: 8 }); warm = Date.now() - t;
  console.log(`${LANES} lane(s), ${opts.session_options.intraOpNumThreads} threads each; models ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (final: ${MODEL}; live: ${LIVE_MODEL}; a live reading costs ~${warm} ms + text)`);
})();

const queue = [];
const busy = { live: false, final: false, one: false };
function pump() {
  if (!asr || !asrLive) return;
  const take = live => { const i = queue.findIndex(j => (j.kind === 'partial') === live); return i < 0 ? null : queue.splice(i, 1)[0]; };
  if (LANES >= 2) {
    if (!busy.final) { const j = take(false); if (j) run(j, 'final'); }
    if (!busy.live) { const j = take(true); if (j) run(j, 'live'); }
  } else if (!busy.one) {
    const j = take(false) || take(true); if (j) run(j, 'one');
  }
}
async function run(job, lane) {
  busy[lane] = true;
  const t = Date.now();
  let text = '', error;
  try {
    const r = await read(job.kind === 'partial' ? asrLive : asr, job.audio, { max_new_tokens: Math.min(440, Math.ceil(job.audio.length / 16000 * 20) + 16) });
    text = (r && r.text) || '';
  } catch (e) { error = String((e && e.message) || e); }
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
  if (name === 'health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ready: !!(asr && asrLive), warm, queued: queue.length })); return; }
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
  const hello = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ready', warm, threads: 0, server: true, lanes: LANES }));
  if (asr && asrLive) hello(); else loading.then(hello);
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
