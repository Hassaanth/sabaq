// Dev-only fake microphone (loaded by serve.js at /?fakemic=1). getUserMedia returns a stream that plays
// whatever the test schedules, so recitation audio goes through Sabaq's real microphone path:
// capture -> resample -> voice detection -> Quran model -> tracker.
//   await __play([{ url: 'https://verses.quran.com/Alafasy/mp3/067001.mp3' }, { silence: 1500 }])
//   await __play([{ word: [85, 17, 1] }, { word: [85, 1, 3] }])   // words from the bundled qari packs
(function () {
  const ctx = new AudioContext();
  window.__fakeCtx = ctx;
  const dest = ctx.createMediaStreamDestination();
  navigator.mediaDevices.getUserMedia = async () => { if (ctx.state !== 'running') await ctx.resume(); return dest.stream; };
  const cache = {};
  const decodeUrl = url => (cache[url] = cache[url] || fetch(url).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)));
  const packs = {};
  async function word(s, a, w) {
    const A = window.SABAQ_AUDIO, Q = window.QURAN;
    let i = 0; for (let k = 0; k < a - 1; k++) i += Q[s - 1].a[k][0].split(' ').length; i += w - 1;
    packs[s] = packs[s] || fetch(A.files[s]).then(r => r.arrayBuffer());
    const buf = await packs[s], off = A.words[s][i * 2], len = A.words[s][i * 2 + 1];
    return ctx.decodeAudioData(buf.slice(off, off + len));
  }
  // Faster (or slower) recitation, same voice: WSOLA time-stretch (pitch kept), for testing fast reciters.
  //   { url, from, to, rate: 1.6 } plays that part 1.6x as fast
  function stretch(buf, from, dur, rate) {
    const sr = buf.sampleRate, x = buf.getChannelData(0).subarray(Math.floor(from * sr), Math.floor((from + dur) * sr));
    const N = Math.round(0.04 * sr), Hs = N >> 1, tol = Math.round(0.012 * sr);
    const outLen = Math.floor(x.length / rate), y = new Float32Array(outLen + N), wsum = new Float32Array(outLen + N);
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    let prev = 0; // input position of the previous frame
    for (let o = 0; o + N < outLen + N; o += Hs) {
      const nominal = Math.round(o * rate);
      let best = nominal;
      if (o > 0) {
        // the frame that best continues the previous one (its natural next hop), within the tolerance
        const want = prev + Hs; let bc = -Infinity;
        for (let d = -tol; d <= tol; d += 2) {
          const p = nominal + d; if (p < 0 || p + N > x.length) continue;
          let c = 0; for (let i = 0; i < N; i += 4) { const q = want + i; if (q < x.length) c += x[p + i] * x[q]; }
          if (c > bc) { bc = c; best = p; }
        }
      }
      if (best + N > x.length) break;
      for (let i = 0; i < N; i++) { y[o + i] += x[best + i] * win[i]; wsum[o + i] += win[i]; }
      prev = best;
    }
    const out = ctx.createBuffer(1, outLen, sr), ch = out.getChannelData(0);
    for (let i = 0; i < outLen; i++) ch[i] = wsum[i] > 1e-3 ? y[i] / wsum[i] : 0;
    return out;
  }
  let queueEnd = 0; // audio-clock time when everything scheduled so far has played
  window.__play = async items => {
    if (ctx.state !== 'running') await ctx.resume();
    // Everything is timed on the audio clock (it can run slower than the wall clock in a background tab):
    // a pause is then a real pause in what the microphone hears, never swallowed by audio still queued.
    let t = Math.max(ctx.currentTime + 0.05, queueEnd);
    for (const it of items) {
      if (it.silence) { t += it.silence / 1000; continue; }
      let buf = it.url ? await decodeUrl(it.url) : await word(...it.word);
      // { url, from, to } in ms plays just that part (e.g. exact words cut from a full-surah recitation)
      let from = (it.from || 0) / 1000, dur = it.to != null ? (it.to - (it.from || 0)) / 1000 : buf.duration - from;
      if (it.rate && it.rate !== 1) { buf = stretch(buf, from, dur, it.rate); from = 0; dur = buf.duration; }
      // (decoding can take seconds the first time: never schedule into the past, which would shorten a pause)
      if (t < ctx.currentTime + 0.05) { const late = ctx.currentTime + 0.05 - t; t += late; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest);
      src.start(t, from, dur);
      window.__played = window.__played || []; window.__played.push({ at: t, url: it.url, from: it.from || 0, to: it.to }); // (for lag measurements)
      t += dur + (it.gap || 0) / 1000;
    }
    queueEnd = t;
    while (ctx.currentTime < t) await new Promise(r => setTimeout(r, 20));
  };
})();
