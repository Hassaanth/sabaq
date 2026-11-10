// Builds bundled word-by-word qari audio for selected surahs.
//   node tools/build-audio.js <dir with node_modules containing lamejs + mpg123-decoder> [surah numbers...]
// Source: Quran.com word-by-word recitation (api.quran.com word audio_url -> audio.qurancdn.com).
// Each word is decoded, mixed to mono 22.05 kHz, trimmed of silence, peak-normalised and re-encoded
// at 32 kbps, then all words of a surah are packed into one file: audio/sNNN.mp3.
// audio/index.js maps every word (in Sabaq's word order) to [byteOffset, byteLength] in that file.
const fs = require('fs'), path = require('path');
const libDir = process.argv[2];
const req = m => require(path.join(libDir, 'node_modules', m));
// lamejs 1.2.1 expects these as globals when loaded from Node
const lsrc = m => path.join(libDir, 'node_modules', 'lamejs', 'src', 'js', m);
global.MPEGMode = require(lsrc('MPEGMode.js'));
global.Lame = require(lsrc('Lame.js'));
global.BitStream = require(lsrc('BitStream.js'));
const lamejs = req('lamejs');
const { MPEGDecoder } = req('mpg123-decoder');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'audio');
fs.mkdirSync(OUT, { recursive: true });

const win = {}; new Function('window', fs.readFileSync(path.join(ROOT, 'quran-data.js'), 'utf8'))(win);
let surahs = process.argv.slice(3).map(Number).filter(Boolean);
if (!surahs.length) { surahs = [1, 67]; for (let s = 78; s <= 114; s++) surahs.push(s); }

const RATE = 22050, KBPS = 32;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, kind, tries = 7) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'sabaq-demo-build' } });
      if (r.status === 404 && kind === 'bin') return null; // no recording for this word
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return kind === 'json' ? await r.json() : new Uint8Array(await r.arrayBuffer());
    } catch (e) { if (i === tries - 1) throw new Error(url + ': ' + e.message); await sleep(1000 * (i + 1)); }
  }
}
async function verses(s) {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const j = await get(`https://api.quran.com/api/v4/verses/by_chapter/${s}?words=true&word_fields=audio_url&per_page=50&page=${page}`, 'json');
    out.push(...j.verses);
    if (!j.pagination || !j.pagination.next_page) break;
  }
  return out;
}

let decoder;
async function process1(bytes) {
  await decoder.reset();
  const { channelData, samplesDecoded, sampleRate } = decoder.decode(bytes);
  if (!samplesDecoded) throw new Error('decode failed');
  const L = channelData[0], R = channelData[1] || channelData[0];
  // mono + resample (linear) to RATE
  const n = Math.floor(samplesDecoded * RATE / sampleRate);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * sampleRate / RATE, i0 = Math.floor(x), f = x - i0, i1 = Math.min(i0 + 1, samplesDecoded - 1);
    const a = (L[i0] + R[i0]) / 2, b = (L[i1] + R[i1]) / 2;
    mono[i] = a + (b - a) * f;
  }
  // trim silence (20 ms windows below -42 dBFS RMS), keep 70 ms padding
  const W = Math.round(RATE * 0.02), thr = Math.pow(10, -42 / 20);
  const loud = w => { let s = 0; for (let i = w; i < Math.min(w + W, n); i++) s += mono[i] * mono[i]; return Math.sqrt(s / W) > thr; };
  let a = 0; while (a < n && !loud(a)) a += W;
  let b = n - W; while (b > a && !loud(b)) b -= W;
  const pad = Math.round(RATE * 0.07);
  a = Math.max(0, a - pad); b = Math.min(n, b + W + pad);
  const seg = mono.subarray(a, b);
  let peak = 0; for (const v of seg) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? Math.min(4, 0.89 / peak) : 1;
  const pcm = new Int16Array(seg.length);
  for (let i = 0; i < seg.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(seg[i] * g * 32767)));
  const enc = new lamejs.Mp3Encoder(1, RATE, KBPS);
  const parts = [];
  for (let i = 0; i < pcm.length; i += 1152) { const o = enc.encodeBuffer(pcm.subarray(i, i + 1152)); if (o.length) parts.push(Buffer.from(o)); }
  const e = enc.flush(); if (e.length) parts.push(Buffer.from(e));
  return { mp3: Buffer.concat(parts), secs: seg.length / RATE };
}

(async () => {
  decoder = new MPEGDecoder(); await decoder.ready;
  const indexPath = path.join(OUT, 'index.js');
  let index = { files: {}, words: {} };
  if (fs.existsSync(indexPath)) { const w = {}; new Function('window', fs.readFileSync(indexPath, 'utf8'))(w); index = w.SABAQ_AUDIO; }
  let totalBytes = 0, totalWords = 0, missing = 0;
  for (const s of surahs) {
    if (index.files[s] && fs.existsSync(path.join(ROOT, index.files[s])) && !process.env.REBUILD) { console.log(`surah ${s}: already built`); continue; }
    const vs = await verses(s);
    const ours = win.QURAN[s - 1].a;
    const urls = [];
    ours.forEach((pair, ai) => {
      const n = pair[0].split(' ').length;
      const v = vs[ai];
      const w = v ? v.words.filter(x => x.char_type_name === 'word') : [];
      // Files are numbered by word position. (The API's audio_url skips a number after each pause mark,
      // which would give every later word the NEXT word's recording, so it is not used.)
      if (w.length === n) w.forEach((x, wi) => urls.push(`https://audio.qurancdn.com/wbw/${String(s).padStart(3, '0')}_${String(ai + 1).padStart(3, '0')}_${String(wi + 1).padStart(3, '0')}.mp3`));
      else { console.log(`  ${s}:${ai + 1} word count differs (${n} vs ${w.length}), no audio for this ayah`); for (let i = 0; i < n; i++) urls.push(null); }
    });
    // download (parallel), then encode (sequential)
    const raw = new Array(urls.length);
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < urls.length) { const i = next++; if (urls[i]) raw[i] = await get(urls[i], 'bin'); }
    }));
    const chunks = [], offs = [];
    let off = 0;
    for (let i = 0; i < urls.length; i++) {
      if (!raw[i]) { offs.push(-1, 0); missing++; continue; }
      const { mp3 } = await process1(raw[i]);
      chunks.push(mp3); offs.push(off, mp3.length); off += mp3.length;
    }
    const file = `audio/s${String(s).padStart(3, '0')}.mp3`;
    fs.writeFileSync(path.join(ROOT, file), Buffer.concat(chunks));
    index.files[s] = file; index.words[s] = offs;
    totalBytes += off; totalWords += urls.length;
    console.log(`surah ${s}: ${urls.length} words, ${(off / 1024).toFixed(0)} KB`);
    fs.writeFileSync(indexPath, '/* Word-by-word recitation audio: Quran.com (audio.qurancdn.com), re-encoded. [byteOffset, byteLength] per word. */\nwindow.SABAQ_AUDIO=' + JSON.stringify(index) + ';\n');
  }
  console.log(`done: ${totalWords} words, ${(totalBytes / 1048576).toFixed(1)} MB, ${missing} without audio`);
  decoder.free();
})().catch(e => { console.error(e); process.exit(1); });
