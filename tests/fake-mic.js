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
  let queueEnd = 0; // audio-clock time when everything scheduled so far has played
  window.__play = async items => {
    if (ctx.state !== 'running') await ctx.resume();
    // Everything is timed on the audio clock (it can run slower than the wall clock in a background tab):
    // a pause is then a real pause in what the microphone hears, never swallowed by audio still queued.
    let t = Math.max(ctx.currentTime + 0.05, queueEnd);
    for (const it of items) {
      if (it.silence) { t += it.silence / 1000; continue; }
      const buf = it.url ? await decodeUrl(it.url) : await word(...it.word);
      // (decoding can take seconds the first time: never schedule into the past, which would shorten a pause)
      if (t < ctx.currentTime + 0.05) { const late = ctx.currentTime + 0.05 - t; t += late; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest);
      // { url, from, to } in ms plays just that part (e.g. exact words cut from a full-surah recitation)
      const from = (it.from || 0) / 1000, dur = it.to != null ? (it.to - (it.from || 0)) / 1000 : buf.duration - from;
      src.start(t, from, dur);
      window.__played = window.__played || []; window.__played.push({ at: t, url: it.url, from: it.from || 0, to: it.to }); // (for lag measurements)
      t += dur + (it.gap || 0) / 1000;
    }
    queueEnd = t;
    while (ctx.currentTime < t) await new Promise(r => setTimeout(r, 20));
  };
})();
