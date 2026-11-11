// Sabaq's own speech recognition: runs Tarteel's Quran-trained Whisper model (tiny, int8 ONNX, ~38 MB)
// in the browser with Transformers.js. Used where the browser's speech recognition is missing or
// unreliable (iPhone, Safari, Firefox). The model is downloaded once from Hugging Face and then cached.
// Model: tarteel-ai/whisper-tiny-ar-quran (Apache-2.0), ONNX conversion Sharjeelbaig/whisper-tiny-ar-quran-onnx.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

env.allowLocalModels = false;
const MODEL = 'Sharjeelbaig/whisper-tiny-ar-quran-onnx';
let asr = null, loading = null, device = 'wasm', slow = 0, threads = 1;

function load(want, dtype, threads) {
  if (!loading) {
    device = want || 'wasm';
    // several CPU threads when the page is cross-origin isolated (see coi-sw.js); one otherwise
    try { env.backends.onnx.wasm.numThreads = threads = threads || (self.crossOriginIsolated ? Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 2)) : 1); } catch (e) { /* older build */ }
    loading = pipeline('automatic-speech-recognition', MODEL, {
      dtype: dtype || 'q8',
      device,
      progress_callback: p => {
        if (p && p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded || 0, total: p.total || 0 });
      },
    }).then(async p => {
      // one warm-up run on a second of silence: the first real phrase is then as fast as the rest
      try { await p(new Float32Array(16000), { language: 'ar', task: 'transcribe' }); } catch (e) { /* fine */ }
      // a second short run, timed: the fixed cost of one reading on this device
      let warm = 0;
      try { const t = performance.now(); await p(new Float32Array(16000), { language: 'ar', task: 'transcribe', max_new_tokens: 8 }); warm = performance.now() - t; } catch (e) { /* fine */ }
      if (slow > 1) { await new Promise(res => setTimeout(res, warm * (slow - 1))); warm *= slow; } // dev only
      asr = p; postMessage({ type: 'ready', device, threads, warm: Math.round(warm) });
    })
      .catch(err => { loading = null; postMessage({ type: 'error', message: String((err && err.message) || err) }); });
  }
  return loading;
}

self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'load') { slow = m.slow || 0; load(m.device, m.dtype, m.threads); return; }
  if (m.type === 'run') {
    await load();
    if (!asr) { postMessage({ type: 'result', id: m.id, kind: m.kind, seg: m.seg, text: '', error: 'model not loaded' }); return; }
    const t0 = performance.now();
    try {
      // at most ~20 tokens per second of audio: a confused model can't loop on for seconds (448 tokens)
      const r = await asr(m.audio, { language: 'ar', task: 'transcribe', max_new_tokens: Math.min(440, Math.ceil(m.audio.length / 16000 * 20) + 16) });
      if (slow > 1) await new Promise(res => setTimeout(res, (performance.now() - t0) * (slow - 1))); // dev only
      postMessage({ type: 'result', id: m.id, kind: m.kind, seg: m.seg, text: (r && r.text) || '', ms: Math.round(performance.now() - t0), secs: m.audio.length / 16000 });
    } catch (err) {
      postMessage({ type: 'result', id: m.id, kind: m.kind, seg: m.seg, text: '', error: String((err && err.message) || err) });
    }
  }
};
