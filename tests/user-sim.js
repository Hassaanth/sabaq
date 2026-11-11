// Dev-only: a simulated person reciting into Sabaq (loaded by serve.js at /?fakemic=1&usersim=1).
// Real recitation (Mishary Alafasy, Quran.com) is cut at exact word boundaries and played into the app's real
// microphone path (tests/fake-mic.js), following a script of what the person says:
//   await __sim.run([ '67:1', {pause: 2000}, '67:2:1-4', '67:2', {s: 36, a: 83, w: [3, 4]}, '67:3:5' ])
//     '67:1'      the whole ayah          '67:2:1-4'  words 1-4 of 67:2       '67:3:5'  word 5 only
//     {pause: ms} silence (thinking, stuck, waiting for the qari)   {tap: true} tap the mic (stop / start)
//     {until: 'text', max: ms}  wait until the status line contains text (e.g. 'Your turn')
// It records what the app shows over time: status line, toasts, highlighted word, marks.
(function () {
  const timings = {};
  async function surah(s) {
    if (timings[s]) return timings[s];
    const j = await fetch('https://api.qurancdn.com/api/qdc/audio/reciters/7/audio_files?chapter=' + s + '&segments=true').then(r => r.json());
    const f = j.audio_files[0], ayahs = {};
    for (const v of f.verse_timings) ayahs[+v.verse_key.split(':')[1]] = v.segments.filter(x => x.length >= 3).map(x => [x[1], x[2]]);
    return (timings[s] = { url: f.audio_url, ayahs });
  }
  function parse(it) {
    if (typeof it !== 'string') return it;
    const [s, a, w] = it.split(':').map(String);
    if (!w) return { s: +s, a: +a };
    const [w1, w2] = w.split('-').map(Number);
    return { s: +s, a: +a, w: [w1, w2 || w1] };
  }
  const log = [];
  let rec = null, t0 = 0;
  function startRecording() {
    log.length = 0; t0 = performance.now();
    let last = '';
    rec = setInterval(() => {
      const st = document.getElementById('statusText').textContent.replace(/\s+/g, ' ').slice(0, 70);
      const toast = document.getElementById('toast'); const tt = toast.dataset.show === '1' ? toast.textContent.slice(0, 60) : '';
      const cur = document.querySelector('.w.cur');
      const line = st + (tt ? '  [' + tt + ']' : '') + (cur ? '  @' + cur.textContent : '');
      if (line !== last) { last = line; log.push(((performance.now() - t0) / 1000).toFixed(1) + 's ' + line); }
    }, 100);
  }
  function note(text) { log.push(((performance.now() - t0) / 1000).toFixed(1) + 's >>> ' + text); }
  let lastEnd = null;
  async function run(script, opts = {}) {
    if (!rec) startRecording();
    for (let raw of script) {
      const it = parse(raw);
      if (it.pause) { note('(silent ' + it.pause + ' ms)'); await __play([{ silence: it.pause }]); continue; }
      if (it.tap) { note('(taps the mic)'); document.getElementById('micBtn').click(); await new Promise(r => setTimeout(r, 300)); continue; }
      if (it.until) {
        note('(waits for "' + it.until + '")');
        const end = performance.now() + (it.max || 15000);
        while (performance.now() < end && !document.getElementById('statusText').textContent.includes(it.until)) await new Promise(r => setTimeout(r, 100));
        continue;
      }
      const t = await surah(it.s), segs = t.ayahs[it.a];
      const [w1, w2] = it.w || [1, segs.length];
      note('says ' + it.s + ':' + it.a + (it.w ? ' words ' + w1 + '-' + w2 : ''));
      // a person who skips or swaps a word still finishes the word before it: a short natural gap at a jump
      const jump = lastEnd != null && Math.abs(segs[w1 - 1][0] - lastEnd) > 40;
      await __play([...(jump ? [{ silence: 120 }] : []), { url: t.url, from: segs[w1 - 1][0], to: segs[w2 - 1][1] }]);
      lastEnd = segs[w2 - 1][1];
    }
  }
  function marks() {
    const out = {};
    for (const w of document.querySelectorAll('.w')) {
      const m = /s(\d)/.exec(w.className), s = m ? +m[1] : 0;
      const k = w.classList.contains('fx') ? 'fixed' : ({ 2: 'check', 3: 'unclear', 4: 'wrong', 5: 'missed' })[s];
      if (k) (out[k] = out[k] || []).push(w.textContent);
    }
    return out;
  }
  function report() {
    clearInterval(rec); rec = null;
    return { tally: ['nOk', 'nCheck', 'nMiss'].map(id => document.getElementById(id).textContent).join('/'), marks: marks(), timeline: log.slice() };
  }
  // Highlight lag: recite ayahs straight through and measure, for every word, how long after it was said
  // (end of the word in the audio) the highlight moved past it. Timed on the audio clock.
  async function lag(s, a1, a2) {
    const t = await surah(s), ctx = window.__fakeCtx, passed = new Map();
    // (a DOM observer fires the moment the highlight moves; timers are throttled in a background tab)
    const seen = () => { const c = document.querySelector('.w.cur'); const p = c ? +c.dataset.p : -1; for (let q = p - 1; q >= 0 && !passed.has(q); q--) passed.set(q, ctx.currentTime); };
    const mo = new MutationObserver(seen); mo.observe(document.getElementById('quran'), { subtree: true, attributes: true, attributeFilter: ['class'] });
    const watch = Promise.resolve(); let on = true;
    const first = t.ayahs[a1][0][0], last = t.ayahs[a2][t.ayahs[a2].length - 1][1];
    window.__played = [];
    await __play([{ url: t.url, from: first, to: last }, { silence: 6000 }]);
    on = false; await watch; mo.disconnect();
    const start = window.__played[0].at, base = M_pos(s, a1), lags = [];
    let i = 0;
    for (let a = a1; a <= a2; a++) for (const [, end] of t.ayahs[a]) { const p = base + i++; const said = start + (end - first) / 1000; lags.push(passed.has(p) ? passed.get(p) - said : null); }
    const ok = lags.filter(x => x != null).sort((x, y) => x - y), q = f => ok.length ? ok[Math.min(ok.length - 1, Math.floor(f * ok.length))].toFixed(1) + 's' : '-';
    return { words: lags.length, followed: ok.length, median: q(0.5), p90: q(0.9), max: q(0.999), lags: lags.map(x => x == null ? 'x' : x.toFixed(1)).join(' ') };
  }
  // position of a word in the whole Quran (first word of ayah a of surah s), from the page's own data
  function M_pos(s, a) { let p = 0; const Q = window.QURAN; for (let k = 0; k < s - 1; k++) for (const ay of Q[k].a) p += ay[0].split(' ').length; for (let k = 0; k < a - 1; k++) p += Q[s - 1].a[k][0].split(' ').length; return p; }
  window.__sim = { run, report, startRecording, surah, lag };
})();
