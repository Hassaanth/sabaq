// Sabaq's own speech recognition: runs Tarteel's Quran-trained Whisper model (tiny, int8 ONNX, ~38 MB)
// in the browser with Transformers.js. Used where the browser's speech recognition is missing or
// unreliable (iPhone, Safari, Firefox). The model is downloaded once from Hugging Face and then cached.
// Model: tarteel-ai/whisper-tiny-ar-quran (Apache-2.0), ONNX conversion Sharjeelbaig/whisper-tiny-ar-quran-onnx.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

env.allowLocalModels = false;
const MODEL = 'Sharjeelbaig/whisper-tiny-ar-quran-onnx';
let asr = null, loading = null, device = 'wasm';

function load(want, dtype) {
  if (!loading) {
    device = want || 'wasm';
    loading = pipeline('automatic-speech-recognition', MODEL, {
      dtype: dtype || 'q8',
      device,
      progress_callback: p => {
        if (p && p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded || 0, total: p.total || 0 });
      },
    }).then(async p => {
      // one warm-up run on a second of silence: the first real phrase is then as fast as the rest
      try { await p(new Float32Array(16000), { language: 'ar', task: 'transcribe' }); } catch (e) { /* fine */ }
      asr = p; postMessage({ type: 'ready', device });
    })
      .catch(err => { loading = null; postMessage({ type: 'error', message: String((err && err.message) || err) }); });
  }
  return loading;
}

self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'load') { load(m.device, m.dtype); return; }
  if (m.type === 'run') {
    await load();
    if (!asr) { postMessage({ type: 'result', id: m.id, kind: m.kind, seg: m.seg, text: '', error: 'model not loaded' }); return; }
    const t0 = performance.now();
    try {
      const r = await asr(m.audio, { language: 'ar', task: 'transcribe' });
      postMessage({ type: 'result', id: m.id, kind: m.kind, seg: m.seg, text: (r && r.text) || '', ms: Math.round(performance.now() - t0), secs: m.audio.length / 16000 });
    } catch (err) {
      postMessage({ type: 'result', id: m.id, kind: m.kind, seg: m.seg, text: '', error: String((err && err.message) || err) });
    }
  }
};
