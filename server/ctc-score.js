// How well do given words fit a stretch of recitation? The fast model (NVIDIA's Arabic FastConformer, CTC) gives,
// for every 80 ms of audio, a probability for each of its 1024 word pieces and for "nothing new". Its reading is
// the most likely piece at each moment. To check a suspected mistake, the correct words are lined up with the
// same audio (forced alignment, as Tilawa does with its phoneme model): if they fit almost as well as what the
// model wrote, the "mistake" was the model's own garble; if they fit far worse, the reciter said something else.
//
// The audio features are NeMo's own (log-mel, 80 bands, per-band normalised), computed here, so onnxruntime can
// run the model directly and return those probabilities (sherpa-onnx only returns the text).
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);

// ---- NeMo AudioToMelSpectrogramPreprocessor: 16 kHz, 25 ms Hann window, 10 ms hop, n_fft 512, 80 slaney mel
// bands, pre-emphasis 0.97, log(x + 2^-24), each band normalised over the utterance
const SR = 16000, NFFT = 512, HOP = 160, WIN = 400, NMEL = 80, NBIN = NFFT / 2 + 1;
const hzToMel = f => (f < 1000 ? f * 3 / 200 : 15 + Math.log(f / 1000) * 27 / Math.log(6.4));
const melToHz = m => (m < 15 ? m * 200 / 3 : 1000 * Math.exp((m - 15) * Math.log(6.4) / 27));
const FB = (() => {
  const mels = []; const lo = hzToMel(0), hi = hzToMel(SR / 2);
  for (let i = 0; i < NMEL + 2; i++) mels.push(melToHz(lo + (hi - lo) * i / (NMEL + 1)));
  const fb = new Float32Array(NMEL * NBIN);
  for (let m = 0; m < NMEL; m++) {
    const enorm = 2 / (mels[m + 2] - mels[m]);
    for (let k = 0; k < NBIN; k++) {
      const f = k * SR / NFFT;
      const lower = (f - mels[m]) / (mels[m + 1] - mels[m]), upper = (mels[m + 2] - f) / (mels[m + 2] - mels[m + 1]);
      fb[m * NBIN + k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
  }
  return fb;
})();
const WINDOW = (() => { const w = new Float32Array(NFFT), off = (NFFT - WIN) >> 1; for (let n = 0; n < WIN; n++) w[off + n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (WIN - 1)); return w; })();
const REV = (() => { const r = new Uint16Array(NFFT), bits = Math.log2(NFFT); for (let i = 0; i < NFFT; i++) { let x = i, y = 0; for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
const COS = new Float64Array(NFFT / 2), SIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) { COS[i] = Math.cos(2 * Math.PI * i / NFFT); SIN[i] = -Math.sin(2 * Math.PI * i / NFFT); }
function fft(re, im) {
  for (let i = 0; i < NFFT; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let s = 0; s < NFFT; s += size) for (let k = 0; k < half; k++) {
      const c = COS[k * step], d = SIN[k * step], a = s + k, b = a + half;
      const xr = re[b] * c - im[b] * d, xi = re[b] * d + im[b] * c;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
}
export function features(audio) {
  const N = audio.length, T = Math.floor(N / HOP) + 1, pad = NFFT >> 1;
  const x = new Float32Array(N + 2 * pad);
  for (let i = 0; i < N; i++) x[pad + i] = i ? audio[i] - 0.97 * audio[i - 1] : audio[0];
  const out = new Float32Array(NMEL * T), re = new Float64Array(NFFT), im = new Float64Array(NFFT), pw = new Float64Array(NBIN);
  for (let t = 0; t < T; t++) {
    const o = t * HOP;
    for (let i = 0; i < NFFT; i++) { re[i] = (x[o + i] || 0) * WINDOW[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < NBIN; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < NMEL; m++) { let s = 0; const r = m * NBIN; for (let k = 0; k < NBIN; k++) s += FB[r + k] * pw[k]; out[m * T + t] = Math.log(s + 5.960464477539063e-8); }
  }
  for (let m = 0; m < NMEL; m++) {
    let mean = 0; for (let t = 0; t < T; t++) mean += out[m * T + t]; mean /= T;
    let v = 0; for (let t = 0; t < T; t++) { const d = out[m * T + t] - mean; v += d * d; }
    const sd = Math.sqrt(v / Math.max(1, T - 1)) + 1e-5;
    for (let t = 0; t < T; t++) out[m * T + t] = (out[m * T + t] - mean) / sd;
  }
  return { data: out, T };
}

// ---- letters as the Sabaq tracker compares them (engine.js norm): no diacritics, one alif, ي for ى, ه for ة ...
const DIAC = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
export const fold = s => String(s).replace(DIAC, '').replace(/[آأإٱٲٳٵ]/g, 'ا').replace(/[ىی]/g, 'ي').replace(/ة/g, 'ه')
  .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ک/g, 'ك').replace(/ء/g, '').replace(/[^ا-ي ]/g, '');

export async function loadScorer(modelFile, tokensFile, threads = 2) {
  const ort = require('onnxruntime-node');
  const sess = await ort.InferenceSession.create(modelFile, { intraOpNumThreads: threads, graphOptimizationLevel: 'all' });
  const toks = fs.readFileSync(tokensFile, 'utf8').split('\n').filter(Boolean).map(l => l.slice(0, l.lastIndexOf(' ')));
  const V = toks.length, BLANK = toks.indexOf('<blk>');
  // what each piece writes, in folded letters (' ' = the start of a word); '' = nothing (blank, <unk>, a mark)
  const strS = toks.map((t, i) => (i === BLANK || t === '<unk>' ? '' : fold(t.replace(/▁/g, ' '))));
  // (without word gaps: a join in recitation (wasl) or in the Quran's spelling (أمن = أم من) is not a difference)
  const strN = strS.map(s => s.replace(/ /g, ''));
  const emptyS = strS.map(s => s === ''), emptyN = strN.map(s => s === '');
  async function logprobs(audio) {
    const f = features(audio);
    const r = await sess.run({ audio_signal: new ort.Tensor('float32', f.data, [1, NMEL, f.T]), length: new ort.Tensor('int64', BigInt64Array.from([BigInt(f.T)]), [1]) });
    const lp = r.logprobs; const T = lp.dims[1];
    return { lp: lp.data, T };
  }
  function greedy({ lp, T }) {
    let prev = -1, out = '';
    for (let t = 0; t < T; t++) { let b = 0, bv = -Infinity; const o = t * V; for (let v = 0; v < V; v++) if (lp[o + v] > bv) { bv = lp[o + v]; b = v; } if (b !== prev && b !== BLANK) out += toks[b]; prev = b; }
    return out.replace(/▁/g, ' ').trim();
  }
  // How much worse (in log-probability, >= 0) the audio fits when `words` must be said somewhere in it, in this
  // order, than the model's own best reading. Everything outside those words is left to the model's best reading.
  function cost({ lp, T }, words, gaps = false) {
    const str = gaps ? strS : strN, empty = gaps ? emptyS : emptyN;
    const target = words.map(w => (gaps ? ' ' : '') + fold(w).replace(/ /g, '')).join('');
    const L = target.length;
    // pieces that can be written at each point of the target
    const starts = Array.from({ length: L }, () => []);
    for (let k = 0; k < V; k++) { const s = str[k]; if (!s) continue; for (let i = 0; i + s.length <= L; i++) if (target.startsWith(s, i)) starts[i].push(k, i + s.length); }
    const NEG = -1e30;
    let B = new Float64Array(L + 1).fill(NEG), K = new Float64Array(L + 1).fill(NEG), Kt = new Int32Array(L + 1).fill(-1);
    let nB = new Float64Array(L + 1), nK = new Float64Array(L + 1), nKt = new Int32Array(L + 1);
    let free0 = 0, free1 = NEG, best = 0;
    for (let t = 0; t < T; t++) {
      const o = t * V; let G = -Infinity, E = -Infinity;
      for (let v = 0; v < V; v++) { const x = lp[o + v]; if (x > G) G = x; if (empty[v] && x > E) E = x; }
      best += G;
      // (before the words start, the frame is the model's best reading)
      B[0] = Math.max(B[0], free0);
      nB.fill(NEG); nK.fill(NEG); nKt.fill(-1);
      for (let i = 0; i <= L; i++) {
        const stay = Math.max(B[i], K[i]);
        if (stay > NEG) nB[i] = stay + E;
        if (K[i] > NEG) { const c = K[i] + lp[o + Kt[i]]; if (c > nK[i]) { nK[i] = c; nKt[i] = Kt[i]; } }
      }
      for (let i = 0; i < L; i++) {
        const st = starts[i]; if (!st.length) continue;
        for (let q = 0; q < st.length; q += 2) {
          const k = st[q], j = st[q + 1];
          const from = Kt[i] === k ? B[i] : Math.max(B[i], K[i]);
          if (from <= NEG) continue;
          const c = from + lp[o + k];
          if (c > nK[j]) { nK[j] = c; nKt[j] = k; }
        }
      }
      free0 += G;
      free1 = Math.max(free1 + G, nB[L], nK[L]);
      [B, nB] = [nB, B]; [K, nK] = [nK, K]; [Kt, nKt] = [nKt, Kt];
    }
    return free1 <= NEG / 2 ? 1e9 : Math.max(0, best - free1);
  }
  return { logprobs, greedy, cost, V, BLANK };
}
