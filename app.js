/* Sabaq app: UI, speech input, rendering. The tracking logic lives in engine.js. */
(() => {
  'use strict';
  const E = window.SabaqEngine;
  const M = new E.Mushaf(window.QURAN);
  const { PENDING, CORRECT, CLOSE, UNCLEAR, WRONG, MISSED } = E;
  const TENTATIVE = 6;
  const SUSPECT = 7; // a live reading suggests a mistake here; the double-check has not decided yet (never a stop by itself)

  // Timing marks for each live reading (?debug=1 shows them on screen; tests read window.__sabaqDiag):
  //  e2e   newest audio of the reading reached the page -> its words came back from the server
  //  wait  server: audio arrived -> model started on it;  ms  the model's own time
  //  net   e2e - wait - ms: the network both ways plus the phone's own queueing
  //  align words came back -> Quran position updated;  paint  words came back -> highlight drawn
  const Diag = { on: /[?&]debug=1/.test(location.search), rows: [], pending: null,
    add(r) { this.rows.push(r); if (this.rows.length > 300) this.rows.shift(); },
    med(k) { const a = this.rows.map(r => r[k]).filter(v => v != null).sort((x, y) => x - y); return a.length ? Math.round(a[a.length >> 1]) : null; },
    p90(k) { const a = this.rows.map(r => r[k]).filter(v => v != null).sort((x, y) => x - y); return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * 0.9))]) : null; },
    summary() { const o = { n: this.rows.length }; for (const k of ['e2e', 'wait', 'ms', 'net', 'align', 'paint']) o[k] = this.med(k) + '/' + this.p90(k); return o; } };
  window.__sabaqDiag = Diag;

  let T = new E.Tracker(M); // committed state
  let P = null;             // live preview (committed + words still being recognised)

  const $ = id => document.getElementById(id);
  const main = $('main'), quranEl = $('quran');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const AR = '٠١٢٣٤٥٦٧٨٩';
  const toAr = n => String(n).replace(/\d/g, d => AR[d]);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('sabaq.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('sabaq.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  // ---------------------------------------------------------------- rendering
  let shown = -1, spans = [], lastVis = null, curSpan = null, lastCursor = -2;

  // One soft highlight that glides from word to word (instead of a box blinking on each word in turn)
  const glide = document.createElement('span');
  glide.className = 'glide'; glide.setAttribute('aria-hidden', 'true');
  // The word being said fills in (right to left, as it is read) at the reciter's own pace, like karaoke captions,
  // so the page moves with the voice between the moments a word is confirmed. It never fills completely and never
  // moves on by itself: the next word is highlighted only once it is heard. It waits while the reciter is silent
  // or holds a long madd. Pace: seconds per letter, learnt from each step from one word to the next.
  const fill = document.createElement('span');
  fill.className = 'fill'; glide.append(fill);
  const pace = { perLetter: 0.12, p: -1, at: 0, dur: 0, startedAt: 0, frozen: false, w: 0 };
  const FILL_TO = 0.85;
  function startFill(sp) {
    fill.style.transition = 'none'; fill.style.width = '0'; pace.frozen = false; pace.w = 0;
    if (!sp) { pace.p = -1; return; }
    const p = +sp.dataset.p, now = performance.now();
    if (pace.p >= 0 && p === pace.p + 1) {
      const dt = (now - pace.at) / 1000, L = Math.max(2, M.keys[pace.p].length);
      if (dt > 0.12 && dt < 3) pace.perLetter = Math.min(0.3, Math.max(0.035, 0.7 * pace.perLetter + 0.3 * dt / L));
    }
    pace.p = p; pace.at = now;
    pace.dur = Math.max(0.25, Math.max(2, M.keys[p].length) * pace.perLetter);
    runFill(0, pace.dur);
  }
  function runFill(from, secs) {
    fill.style.transition = 'none'; fill.style.width = (from * 100).toFixed(1) + '%';
    void fill.offsetWidth;
    fill.style.transition = 'width ' + Math.max(0.05, secs).toFixed(2) + 's cubic-bezier(.3,.6,.5,1)';
    fill.style.width = (FILL_TO * 100) + '%';
    pace.startedAt = performance.now(); pace.from = from;
  }
  // silence (the reciter stopped, or is thinking): the fill waits where it is, and goes on when the voice does
  setInterval(() => {
    if (pace.p < 0 || Input.kind !== 'model' || !ModelMic.on) return;
    const quiet = !ModelMic.inSpeech || ModelMic.silence >= 200;
    if (quiet && !pace.frozen) {
      const gw = glide.getBoundingClientRect().width || 1;
      pace.w = Math.min(FILL_TO, fill.getBoundingClientRect().width / gw);
      fill.style.transition = 'none'; fill.style.width = (pace.w * 100).toFixed(1) + '%'; pace.frozen = true;
    } else if (!quiet && pace.frozen) {
      pace.frozen = false;
      runFill(pace.w, pace.dur * (FILL_TO - pace.w) / FILL_TO);
    }
  }, 80);
  let glideAt = null, glideSpan = null;
  function moveGlide(sp) {
    if (sp !== glideSpan) startFill(sp);
    glideSpan = sp;
    if (!sp) { glide.style.opacity = '0'; glideAt = null; return; }
    const r = sp.getBoundingClientRect(), q = quranEl.getBoundingClientRect();
    const x = r.left - q.left, y = r.top - q.top, w = r.width, h = r.height;
    const jump = !glideAt || Math.abs(glideAt.y - y) > 4;   // a new line: appear there, don't slide across
    if (jump) glide.style.transition = 'none';
    glide.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    glide.style.width = w + 'px'; glide.style.height = h + 'px';
    glide.style.opacity = '1';
    if (jump) { void glide.offsetWidth; glide.style.transition = ''; }
    glideAt = { y };
  }
  window.addEventListener('resize', () => { glideAt = null; glideSpan = null; render(false); });

  // Live recognisers revise their guesses as you speak and briefly drop a word they had. Progress already
  // shown is held for a moment, so words don't flick back to grey and the highlight doesn't step back,
  // unless you really went back (a restart) or a word was judged.
  const hold = { c: -1, tc: -1, until: 0 };
  // The tracker holds the newest word back until it hears the next one (to rule out a misheard word). For the
  // display only, a held word that clearly is the next word of the text counts as reached: the highlight then
  // keeps pace with the voice instead of trailing a word behind. Mistakes are still judged as before.
  function heldAhead(view) {
    if (view.c < 0 || T.stopped >= 0) return 0;
    let k = 0;
    while (view.qi + k < view.q.length && view.c + k < M.N && M.matchPair(view.q, view.qi + k, view.c + k).s >= 0.84) k++;
    return k;
  }
  // How fast the reciter is going: words the highlight moved on in the last 4 s
  const steps = [], stepAt = { c: -1 };
  function wordsPerSec() { const now = performance.now(); while (steps.length && now - steps[0] > 4000) steps.shift(); return steps.length / 4; }
  window.__sabaqPace = wordsPerSec;
  // Reciting fast (hadr), waiting for the next word to be heard starting puts the highlight a word behind the voice.
  // There, the word being said is passed as soon as the live reading has it in full (all its letters, as the text
  // has it), before the next word starts. At a slower pace a long madd can still be going on after the model has
  // named the word, so the highlight waits for the next word as before. (Display only: nothing is judged from it.)
  // word check (see judgeNow): the correct words fit within SCORE_FIT of the model's own reading: no mistake;
  // they miss by SCORE_SLIP or more: a mistake
  const SCORE_FIT = 4, SCORE_SLIP = 12;
  const FAST_WPS = 1.3;
  function tailDone(c) {
    const t = ModelMic.tailNow;
    if (!t || c < 0 || c >= M.N || T.stopped >= 0 || Input.kind !== 'model' || !ModelMic.inSpeech || t.seg !== ModelMic.seg || performance.now() - t.at > 700) return false;
    // (at a slower pace, only once two live readings in a row have the word in full: not on its first sound)
    if (wordsPerSec() < FAST_WPS && !(t.n >= 2)) return false;
    // (and not on a word ending in a long vowel (madd) or marked with a madd sign: a madd is held after the model has
    // already written the whole word; at a fast pace madds are short)
    if (wordsPerSec() < FAST_WPS && (/[اويه]/.test(M.keys[c].slice(-2).replace(/ه$/, "")) || /[اوي]/.test(M.keys[c].slice(-2)) || /ٓ/.test(M.disp[c]))) return false;
    if (c + 1 >= M.N || M.ayahStart[c + 1]) return false; // (an ayah's last word is held long at any pace)
    const k = M.keys[c];
    return t.w === k || (t.w.length >= k.length && E.sim(t.w, k) >= 0.9);
  }
  function shownCursor(view) {
    let c = view.c + heldAhead(view);
    if (tailDone(c)) c++;
    const now = performance.now();
    if (c < hold.c && now < hold.until && T.c >= hold.tc && T.c <= hold.c && T.stopped < 0 && view.c >= 0) c = hold.c;
    else if (c !== hold.c) hold.until = now + 1200;
    hold.c = c; hold.tc = T.c;
    if (stepAt.c >= 0 && c > stepAt.c && c - stepAt.c <= 3) for (let i = stepAt.c; i < c; i++) steps.push(now);
    stepAt.c = c;
    return c;
  }

  function buildSurah(si) {
    const su = M.surahs[si];
    shown = si;
    $('surahAr').textContent = 'سُورَةُ ' + su.ar;
    $('surahMeta').textContent = `${su.n} · ${su.en} · ${su.tr} · ${su.ayahs} ayahs`;
    $('surahLabel').textContent = su.en;
    $('bism').hidden = su.n === 1 || su.n === 9;
    quranEl.classList.toggle('big', su.end - su.start < 120);
    const frag = document.createDocumentFragment();
    spans = new Array(su.end - su.start);
    const one = su.end - su.start <= 160;          // a short surah stays one flowing block
    let sec = null, inSec = 0;
    const newSec = () => { sec = document.createElement('div'); sec.className = 'sec'; frag.append(sec); inSec = 0; };
    newSec();
    for (let p = su.start; p < su.end; p++) {
      const sp = document.createElement('span');
      sp.className = 'w s0';
      sp.dataset.p = p;
      sp.textContent = M.disp[p];
      spans[p - su.start] = sp;
      sec.append(sp, ' '); inSec++;
      if (p + 1 === su.end || M.ayahStart[p + 1]) {
        const a = document.createElement('span');
        a.className = 'aya';
        a.textContent = '۝' + toAr(M.aOf[p]);
        a.setAttribute('aria-label', 'ayah ' + M.aOf[p]);
        sec.append(a, ' ');
        if (!one && inSec >= 70 && p + 1 < su.end) newSec();   // sections of whole ayahs, ~70+ words each
      }
    }
    glide.style.opacity = '0'; glideSpan = null;
    quranEl.replaceChildren(glide, frag);
    lastVis = new Int8Array(su.end - su.start).fill(-1);
    hold.c = -1;
    curSpan = null; lastCursor = -2;
    main.scrollTop = 0;
    store.set('surah', su.n);
    Qari.preload(su.n);
  }

  function visual(view, p, hc) {
    const s = view.state[p];
    let v;
    if (p === ModelMic.suspectAt && T.state[p] === PENDING && T.stopped !== p) v = SUSPECT;
    else if (s === PENDING && T.state[p] === PENDING && p < hc && p >= view.c) v = TENTATIVE; // held progress
    else if (view === T) v = s;
    else if (T.state[p] !== PENDING) v = T.state[p];
    else v = s === PENDING ? PENDING : TENTATIVE; // preview words are not settled: show progress, never a mistake
    // (tens: 1 fixed, 2 stopped here now, 4 needed the qari: a mistake that stays marked)
    if ((v === CORRECT || v === TENTATIVE) && T.fixed.has(p)) v = CORRECT + 10;
    else if (T.flagged.has(p) && p !== T.stopped && (v === UNCLEAR || v === PENDING || v === TENTATIVE)) v = UNCLEAR + 40;
    if (p === T.stopped) v += 20;
    return v;
  }
  function classFor(v) {
    const f = (v / 10) | 0;
    return 'w s' + (v % 10) + (f & 2 ? ' stopw' : f & 1 ? ' fx' : '') + (f & 4 ? ' hlp' : '');
  }

  function anchorOf(view) {
    let c = view.c;
    if (c < 0) return -1;
    if (c >= M.N || (shown >= 0 && c === M.surahs[shown].end && view.state[c] === PENDING)) c--;
    return c;
  }

  // Updates arrive many times a second (live readings, previews, timers): they are drawn once per frame.
  let renderQueued = false, renderFollow = false;
  function render(follow = true) {
    renderFollow = renderFollow || follow;
    if (renderQueued) return;
    renderQueued = true;
    const go = () => { if (!renderQueued) return; renderQueued = false; const f = renderFollow; renderFollow = false; renderNow(f); };
    requestAnimationFrame(go);
    setTimeout(go, 120); // (a background tab gets no animation frames)
  }
  function renderNow(follow) {
    if (shown >= 0) T.hint = [M.surahs[shown].start, M.surahs[shown].end]; // (finding your place prefers the open surah)
    const view = P || T;
    const a = anchorOf(view);
    if (a >= 0 && M.sOf[a] !== shown) buildSurah(M.sOf[a]);
    const su = M.surahs[shown];
    const c = shownCursor(view);
    for (let p = su.start; p < su.end; p++) {
      const v = visual(view, p, c), i = p - su.start;
      if (lastVis[i] !== v) { lastVis[i] = v; spans[i].className = classFor(v); }
    }
    if (curSpan) curSpan.classList.remove('cur');
    curSpan = null;
    if (c >= su.start && c < su.end) { curSpan = spans[c - su.start]; curSpan.classList.add('cur'); }
    const g = curSpan && !(T.strict && T.stopped >= 0) ? curSpan : null;
    if (g !== glideSpan || !glideAt) moveGlide(g);   // (measuring the page costs a layout: only when it moved)
    if (follow && curSpan && c !== lastCursor) followCursor();
    lastCursor = c;
    renderTally();
    renderStatus();
    if (Diag.pending) { const d = Diag.pending; Diag.pending = null; d.paint = performance.now() - d.rx; Diag.add(d); }
  }

  let userScrolledAt = 0;
  ['wheel', 'touchmove', 'keydown'].forEach(ev => main.addEventListener(ev, () => { userScrolledAt = Date.now(); }, { passive: true }));
  function followCursor() {
    if (Date.now() - userScrolledAt < 3500) return;
    const r = curSpan.getBoundingClientRect(), mr = main.getBoundingClientRect();
    const y = r.top - mr.top;
    if (y < mr.height * 0.16 || y > mr.height * 0.46) {
      main.scrollTo({ top: main.scrollTop + y - mr.height * 0.32, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  function counts() {
    const s = { ok: 0, close: 0, unclear: 0, wrong: 0, missed: 0 };
    const st = T.state;
    for (let p = 0; p < st.length; p++) {
      const v = st[p];
      if (v === CORRECT) s.ok++; else if (v === CLOSE) s.close++; else if (v === UNCLEAR) s.unclear++;
      else if (v === WRONG) s.wrong++; else if (v === MISSED) s.missed++;
    }
    return s;
  }
  function renderTally() {
    const s = counts();
    $('nOk').textContent = s.ok + s.close + s.unclear;
    $('nCheck').textContent = s.close;
    $('nMiss').textContent = s.wrong + s.missed;
  }

  function where(p) { const w = M.where(p); return `${M.surahs[w.surah - 1].en} ${w.surah}:${w.ayah}`; }
  function renderStatus() {
    const view = P || T, st = $('status'), tx = $('statusText');
    const live = Input.active();
    const locked = view.c >= 0;
    if (T.strict && T.stopped >= 0) {
      st.dataset.live = 'stopped';
      const p = T.stopped;
      const w = document.createElement('bdi'); w.className = 'stopword'; w.lang = 'ar'; w.dir = 'rtl'; w.textContent = M.disp[p];
      const at = M.where(p);
      if (Qari.speaking === p) {
        tx.replaceChildren(document.createTextNode('Listen to the qari: '), w);
      } else if (Coach.waiting() && Coach.pos === p) {
        const n = Coach.secsLeft();
        tx.replaceChildren(document.createTextNode(n ? 'Stopped. Say the word yourself (' + n + ')' : 'Stopped. Listening to your try…'));
      } else {
        tx.replaceChildren(document.createTextNode('Your turn: say '), w, document.createTextNode(' or the whole ayah (' + at.surah + ':' + at.ayah + '), then carry on.'));
      }
      return;
    }
    if (live && Input.kind === 'model' && !ModelMic.ready && ModelMic.remote) {
      st.dataset.live = 'finding'; tx.textContent = ModelMic.retries ? 'Reconnecting to Sabaq\'s speech server… Keep reciting; nothing is lost.' : 'Connecting to Sabaq\'s speech server… You can start reciting.'; return;
    }
    if (live && Input.kind === 'model' && !ModelMic.ready) {
      st.dataset.live = 'finding';
      const pct = ModelMic.loadPct();
      tx.textContent = pct ? 'Getting the Quran speech model ready: ' + pct + '% (first time only, about 38 MB). You can start reciting.'
        : 'Getting the Quran speech model ready… You can start reciting.';
      return;
    }
    // Sabaq's own model: say when a phrase was heard and is still being read (slower phones)
    const reading = live && Input.kind === 'model' && (ModelMic.finals.length > 0 || ModelMic.busyKind === 'final' || ModelMic.busyKind === 'verify');
    if (live && !locked) { st.dataset.live = 'finding'; tx.textContent = reading ? 'Heard you. Working out what you recited…' : 'Listening. Keep reciting and Sabaq will find where you are.'; return; }
    if (live) { st.dataset.live = 'on'; tx.textContent = 'Following you · ' + where(Math.min(view.c, M.N - 1)) + (reading ? ' · reading…' : ''); return; }
    st.dataset.live = 'off';
    if (!locked) {
      tx.replaceChildren(document.createTextNode('Tap the mic and recite from any surah. No mic? '), demoLink());
      return;
    }
    tx.textContent = (T.c >= M.N ? 'Finished the Quran' : 'Ready at ' + where(T.c)) + '. Tap the mic to continue, or tap any word to start there.';
  }
  function demoLink() {
    const b = document.createElement('button');
    b.className = 'link'; b.type = 'button'; b.textContent = 'Watch the demo';
    b.addEventListener('click', () => { audio(); playDemo(); });
    return b;
  }

  // ---------------------------------------------------------------- sounds (generated, no audio files)
  let actx = null;
  function audio() {
    try {
      if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; actx = new C(); }
      if (actx.state !== 'running') actx.resume().catch(() => {});
      return actx;
    } catch (e) { return null; }
  }
  function tone(a, freq, at, dur, type, vol) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(a.destination);
    o.start(at); o.stop(at + dur + 0.02);
  }
  // A low two-note "uh-uh": clearly a stop, without being harsh for a child.
  function soundStop() { const a = audio(); if (!a) return; const t = a.currentTime + 0.01; tone(a, 311, t, 0.16, 'triangle', 0.35); tone(a, 233, t + 0.19, 0.3, 'triangle', 0.35); }
  // A bright rising "ding-ding" for a fixed word.
  function soundFixed() { const a = audio(); if (!a) return; const t = a.currentTime + 0.01; tone(a, 880, t, 0.18, 'sine', 0.25); tone(a, 1318.5, t + 0.12, 0.32, 'sine', 0.22); }

  // ---------------------------------------------------------------- the qari: word-by-word recitation
  // Bundled packs (audio/index.js + audio/sNNN.mp3) cover the demo surahs. Elsewhere it falls back to
  // Quran.com's word audio, which works when the app runs on its own site (not inside claude.ai).
  const pad3 = n => String(n).padStart(3, '0');
  const Qari = {
    packs: {}, cache: new Map(), speaking: -1, gateUntil: 0, soundUntil: 0, source: null,
    async buffer(p) {
      if (this.cache.has(p)) return this.cache.get(p);
      const a = audio(); if (!a) return null;
      const w = M.where(p), si = w.surah - 1, idx = p - M.surahs[si].start;
      const A = window.SABAQ_AUDIO;
      let bytes = null;
      if (A && A.files[w.surah]) {
        const off = A.words[w.surah][idx * 2], len = A.words[w.surah][idx * 2 + 1];
        if (off < 0) return null;
        if (!this.packs[w.surah]) this.packs[w.surah] = fetch(A.files[w.surah]).then(r => { if (!r.ok) throw new Error('pack ' + r.status); return r.arrayBuffer(); });
        try { bytes = (await this.packs[w.surah]).slice(off, off + len); } catch (e) { delete this.packs[w.surah]; }
      }
      if (!bytes) {
        const wordNo = p - M.ayahPos[si][w.ayah - 1] + 1;
        try {
          const r = await fetch(`https://audio.qurancdn.com/wbw/${pad3(w.surah)}_${pad3(w.ayah)}_${pad3(wordNo)}.mp3`);
          if (r.ok) bytes = await r.arrayBuffer();
        } catch (e) { /* offline, or blocked inside claude.ai */ }
      }
      if (!bytes) return null;
      try {
        const buf = await a.decodeAudioData(bytes);
        this.cache.set(p, buf);
        return buf;
      } catch (e) { return null; }
    },
    // Recite word p. While the qari speaks (and a moment after), what the mic hears is ignored,
    // so the qari's own voice through the speaker is not taken as the reciter's.
    async play(p, delayMs = 0) {
      const a = audio();
      // ignore the mic from now, while the recording loads
      const before = this.gateUntil;
      this.gateUntil = Math.max(before, Date.now() + delayMs + 1500);
      // "Listen" from now until the qari has finished, so "Your turn" only shows once the reciter can speak
      this.speaking = p; render(false);
      const buf = await this.buffer(p);
      if (!buf || !a) { this.gateUntil = before; this.speaking = -1; render(false); toast('No qari recording for this word here.', 3000); return false; }
      if (this.source) { try { this.source.stop(); } catch (e) { /* ended */ } }
      const src = a.createBufferSource(), g = a.createGain();
      g.gain.value = 1;
      src.buffer = buf; src.connect(g).connect(a.destination);
      const startAt = a.currentTime + delayMs / 1000;
      src.start(startAt);
      this.source = src;
      const listenMs = delayMs + buf.duration * 1000 + 450;
      this.gateUntil = Date.now() + listenMs;
      // "Your turn" appears exactly when the mic is listening again (timer-based, so it also works if the
      // browser keeps audio muted and never reports the end of playback)
      const done = () => { if (this.source === src) { this.source = null; this.speaking = -1; render(false); } };
      setTimeout(done, listenMs + 20);
      return true;
    },
    preload(surahNo) {
      const A = window.SABAQ_AUDIO;
      if (!A || !A.files[surahNo] || this.packs[surahNo]) return;
      this.packs[surahNo] = fetch(A.files[surahNo]).then(r => { if (!r.ok) throw new Error('pack ' + r.status); return r.arrayBuffer(); });
      this.packs[surahNo].catch(() => { delete this.packs[surahNo]; });
    },
    gated() { return Date.now() < this.gateUntil; },
    // browser recognition also ignores what it hears during the stop sound
    gatedAny() { return Date.now() < Math.max(this.gateUntil, this.soundUntil); },
    quiet() { return new Promise(res => { const tick = () => (this.gated() ? setTimeout(tick, 100) : res()); tick(); }); },
  };

  // ---------------------------------------------------------------- teacher mode: after a stop
  // The reciter first gets 3 seconds to find the word themselves. If they say it, it is ticked and they
  // carry on. If they don't (or say it wrong), the qari recites it; then they repeat the word or the
  // whole ayah and move on. An attempt still being heard or transcribed when the 3 s end is waited for.
  const Coach = {
    pos: -1, played: false, until: 0, timer: 0, started: 0,
    stop(p, state) {
      if (p !== this.pos || T.stopped !== p) { this.pos = p; this.played = false; this.until = 0; }
      if (this.until && Date.now() - this.started < 2500) return; // words still being said in the same breath, not a new try
      clearTimeout(this.timer);
      // a wrong try after the grace, or after the qari already said it: correct at once
      if (this.played || (this.until && Date.now() > this.started + 300)) { this.until = 0; this.qari(); return; }
      this.started = Date.now(); this.until = Date.now() + 3000;
      // the stop sound is not the reciter (browser recognition; Sabaq's own mic cancels its echo, and
      // muting it here would cut the reciter's phrase in half)
      Qari.soundUntil = Date.now() + 650;
      toast(state === MISSED ? 'Stop. A word was skipped. Can you say it?'
        : state === WRONG ? 'Stop. That word is not right. Can you say it?'
        : 'Stop. Not quite right. Say it again.', 3000);
      this.tick();
    },
    tick() {
      clearTimeout(this.timer);
      if (T.stopped !== this.pos || !T.strict) { this.until = 0; render(false); return; } // fixed, or moved on
      const busy = attemptInFlight();
      // Still reciting 2 s after the stop sounded: they may have carried on (a fast reciter who knows the word was
      // right, or a misheard word). If the words now heard are the ones after the stopped word, they are followed
      // (it stays marked for review), instead of waiting for them to pause for the qari. A try at the word itself
      // is still judged first; if they pause instead, the qari recites the word as before.
      if (busy && ModelMic.inSpeech && Date.now() - this.started > 2000) T.letContinue = true;
      // (never while the reciter is speaking: what the mic hears while the qari plays is thrown away, so the qari
      // would erase their correction; 15 s is only a limit for a reading that never comes back)
      if (Date.now() >= this.until && (!busy || (Date.now() > this.until + 15000 && !(ModelMic.on && ModelMic.inSpeech)))) { this.until = 0; this.qari(); return; }
      this.timer = setTimeout(() => this.tick(), 150);
      renderStatus();
    },
    qari() {
      this.played = true;
      T.letContinue = true; // having heard the word, carrying on with the next words is allowed
      Qari.play(this.pos, 150);
    },
    waiting() { return this.until > 0 && T.stopped === this.pos; },
    secsLeft() { return Math.max(0, Math.ceil((this.until - Date.now()) / 1000)); },
    reset() { clearTimeout(this.timer); this.pos = -1; this.played = false; this.until = 0; },
  };
  // the reciter is mid-attempt: words on screen not yet settled, or audio still being heard / transcribed
  function attemptInFlight() {
    if (P) return true;
    if (Feed.pending.length) return true;
    if (Input.kind === 'model' && ModelMic.on && (ModelMic.inSpeech || ModelMic.busy || ModelMic.finals.length)) return true;
    return false;
  }

  const canVibrate = () => !!navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive);

  // ---------------------------------------------------------------- toasts & events
  let toastTimer = 0, lastRestartToast = 0;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg; t.dataset.show = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.dataset.show = '0'; }, ms);
  }
  function handleEvents() {
    for (const e of T.drainEvents()) {
      if (e.type === 'restart' && Date.now() - lastRestartToast > 4000) { lastRestartToast = Date.now(); toast('Repeat noticed. Not counted as a mistake.'); }
      else if (e.type === 'locked') toast('Found you: ' + where(e.pos));
      else if (e.type === 'relocated') toast('Moved to ' + where(e.pos));
      else if (e.type === 'stop') {
        soundStop();
        if (canVibrate()) { try { navigator.vibrate([70, 50, 70]); } catch (err) { /* not allowed */ } }
        Coach.stop(e.pos, e.state);
        report('stop', { word: M.disp[e.pos], at: where(e.pos), state: e.state, wps: +wordsPerSec().toFixed(2) });
      }
      else if (e.type === 'moveOn') {
        toast((e.continued ? 'Carrying on. ' : e.auto ? 'Moving on after 3 tries. ' : 'Moving on. ') + M.disp[e.pos] + ' is marked for review.', 3200);
        Coach.reset(); render(false);
      }
      else if (e.type === 'selfCorrected') {
        if (T.strict && T.fixed.has(e.pos)) { soundFixed(); toast('Correct. Carry on.'); }
        else toast('You corrected yourself. Mistake cleared.');
      }
      else if (e.type === 'mistake' && !T.strict && canVibrate()) { try { navigator.vibrate(18); } catch (err) { /* not allowed */ } }
    }
  }

  // ---------------------------------------------------------------- words in
  // When teacher mode stops you mid-phrase (from the live words), the words already used are skipped
  // when that phrase settles, so they are not judged twice.
  let phraseSkip = 0, idleTimer = 0;
  // wholePhrase: the text is a complete phrase (Claude dictation), so nothing carries over to the next one.
  // fromModel: words from Sabaq's own model; the qari's voice was already kept out at the microphone
  function commit(text, wholePhrase, fromModel) {
    let words = E.tokenize(text);
    const k = Math.min(phraseSkip, words.length);
    if (Qari.gatedAny() && !fromModel) words = [];  // the qari was speaking: that is not the reciter
    else words = words.slice(k);
    phraseSkip = wholePhrase ? 0 : phraseSkip - k;
    P = null;
    if (words.length) { T.feed(words); handleEvents(); }
    render();
    // A word still being weighed when the reciter pauses (e.g. the last word of an ayah) is judged
    // after a short silence, so a slip at the end of an ayah is still caught.
    clearTimeout(idleTimer);
    if (T.qi < T.q.length) idleTimer = setTimeout(() => { if (!P) { T.flush(); handleEvents(); render(); } }, 1100);
  }
  // The highlight sits on the word being said: the word after the last one heard in full. It moves on when the
  // next word is heard starting, never sooner: a word the model already names (it often names a word from its
  // first sound) may still be going on (a long madd), so the word being said (tail) only keeps the phrase open.
  // before: words of an earlier phrase still being judged (a double-check takes 1-3 s). The preview follows them
  // without stopping anywhere, so the highlight keeps moving with the reciter meanwhile; the judgement decides.
  function preview(text, fromModel, tail, before) {
    if (E.tokenize(text).length || tail) clearTimeout(idleTimer); // only real new speech postpones the end-of-phrase check
    if (Qari.gatedAny() && !fromModel) { phraseSkip = Math.max(phraseSkip, E.tokenize(text).length); return; }
    const words = E.tokenize(text).slice(phraseSkip);
    if (!words.length) { P = null; render(); return; }  // (render coalesces: cheap)
    P = T.clone();
    if (before) { P.strict = false; P.feed(E.tokenize(before)); }
    // (reciting fast: the highlight carries on past a suspected word, which shows as being checked, instead of
    // waiting on it until the phrase ends and the double-check is done; a confirmed mistake still stops there)
    if (fromModel && wordsPerSec() >= FAST_WPS) P.strict = false;
    P.feed(words);
    // (not on the model's live guesses: they are often garbled mid-phrase; its final result decides)
    if (T.strict && !fromModel && P.events.some(e => e.type === 'stop')) {
      // stop right now, on the live words, instead of waiting for the phrase to settle
      T = P; P = null; phraseSkip += words.length;
      handleEvents();
    }
    render();
  }
  function settle() { P = null; T.flush(); handleEvents(); render(); }
  // Two readings of the same phrase, word by word: aligned (edit distance), and where they differ, the word
  // (or absence of a word) that the tracker accepts without a mistake is kept, judged with the two words that
  // follow. Where neither fits, the first reading's word stays (a mistake both heard).
  function consensus(a, b) {
    const n = a.length, m = b.length, D = [];
    for (let i = 0; i <= n; i++) { D.push(new Float64Array(m + 1)); D[i][0] = i; }
    for (let j = 0; j <= m; j++) D[0][j] = j;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : E.sim(a[i - 1], b[j - 1]) >= 0.5 ? 0.6 : 1.2;
      D[i][j] = Math.min(D[i - 1][j - 1] + sub, D[i - 1][j] + 1, D[i][j - 1] + 1);
    }
    const cols = [];
    for (let i = n, j = m; i > 0 || j > 0;) {
      if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : E.sim(a[i - 1], b[j - 1]) >= 0.5 ? 0.6 : 1.2)) { cols.push([a[i - 1], b[j - 1]]); i--; j--; }
      else if (i > 0 && (j === 0 || D[i][j] === D[i - 1][j] + 1)) { cols.push([a[i - 1], null]); i--; }
      else { cols.push([null, b[j - 1]]); j--; }
    }
    cols.reverse();
    const out = [];
    // (judged as the end of the phrase, which it is: a last word is then judged too)
    const fits = words => { const C = T.clone(); C.feed(words); C.flush(); return !C.events.some(e => e.type === 'stop' || e.type === 'mistake'); };
    for (let k = 0; k < cols.length; k++) {
      const [x, y] = cols[k];
      if (x === y) { out.push(x); continue; }
      const next = []; for (let q = k + 1; q < cols.length && next.length < 2; q++) { const w = cols[q][0] || cols[q][1]; if (w) next.push(w); }
      const opts = [x, y].filter((w, i, all) => all.indexOf(w) === i);   // first reading's word first
      let pick = x;
      for (const w of opts) { const cand = w ? [...out, w, ...next] : [...out, ...next]; if (fits(cand)) { pick = w; break; } }
      if (pick) out.push(pick);
    }
    return out;
  }

  // Where, in a reading of a phrase, the words already locked in (from earlier readings of it) end: the
  // position after the best match of their last words, near where counting would put it. -1: not found.
  // (wide: anywhere in the reading, for a second reading that starts with the end of the previous phrase)
  function alignAfter(words, locked, wide) {
    const n = locked.length; if (!n) return 0;
    let best = -1, bestScore = 0;
    for (let j = wide ? 1 : Math.max(1, n - 3); j <= (wide ? words.length : Math.min(words.length, n + 3)); j++) {
      // (the same word as the tracker sees it: a reading may spell it a little differently, زين / زينا)
      let sc = 0; for (let k = 1; k <= Math.min(3, n, j); k++) { const a = words[j - k], b = locked[n - k]; if (a === b || E.sim(a, b) >= 0.7) sc++; else break; }
      if (sc > bestScore || (sc && sc === bestScore && Math.abs(j - n) < Math.abs(best - n))) { best = j; bestScore = sc; }
    }
    return best;
  }

  // How many of these words can be locked in: feeding them changes nothing but marking words right (no
  // mistake, no stop, nothing unclear), counting only the words the tracker has already confirmed.
  function cleanFeed(words) {
    const C = T.clone();
    C.feed(words);
    // (an extra word the tracker set aside, or a repeat, is not simply right either: the final reading decides)
    // (stopped, going back to correct is what the reciter was asked to do: those words lock in as they come)
    if (T.stopped >= 0 && C.events.some(e => e.type === 'restart') && !C.events.some(e => e.type === 'stop' || e.type === 'mistake' || e.type === 'relocated') && C.stats.extras === T.stats.extras && C.lost.length <= T.lost.length)
      return Math.max(0, words.length - (C.q.length - C.qi));
    if (C.events.some(e => e.type === 'stop' || e.type === 'mistake' || e.type === 'relocated' || e.type === 'restart')) return 0;
    if (C.stats.extras > T.stats.extras) return 0;
    // (a word the tracker could not place, kept aside in case the reciter moved elsewhere, is not right either)
    if (C.lost.length > T.lost.length || (T.c >= 0 && C.c < T.c)) return 0;
    const a = T.state, b = C.state;
    // (carrying on after a stop marks the words between "not clearly heard": that is fine to lock in)
    const carried = C.events.some(e => e.type === 'moveOn' && e.continued);
    for (let p = 0; p < b.length; p++) if (b[p] !== a[p] && b[p] !== CORRECT && !(carried && b[p] === UNCLEAR)) return 0;
    // locked words must have moved the cursor on by as many words
    const ok = Math.max(0, words.length - (C.q.length - C.qi));
    return T.c >= 0 && C.c - T.c < ok ? Math.max(0, C.c - T.c) : ok;
  }

  // ---------------------------------------------------------------- speech input
  // 1) Claude dictation (when hosted on claude.ai)  2) the browser's own speech recognition  3) typing
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const Input = {
    dict: null, rec: null, kind: 'none', srRefused: false, state: 'idle', want: false, okOnce: false, lastError: null, restartTimer: 0, sim: null,
    active() { return this.state !== 'idle'; },
  };
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
    } catch (e) { /* not available: the screen may sleep */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Input.state !== 'idle') keepAwake(true); });
  function setMic(state) {
    keepAwake(state !== 'idle');
    Input.state = state;
    const b = $('micBtn');
    b.dataset.state = state;
    b.setAttribute('aria-label', state === 'idle' ? 'Start listening' : 'Stop listening');
    renderStatus();
  }

  if (SR) Input.kind = 'webspeech';
  (async () => {
    try {
      const d = window.claude && window.claude.use ? await window.claude.use('dictation') : null;
      if (!d) return;
      Input.dict = d; Input.kind = 'dictation';
      d.onFinal(({ text }) => commit(text, true));
      d.onPartial(({ text }) => preview(text));
      d.onState(({ state, reason }) => {
        if (state === 'idle') {
          setMic('idle'); settle();
          const msg = {
            not_granted: 'Microphone access is off for this page. Turn it on in the page\'s Permissions menu, or type instead.',
            unavailable: 'Arabic dictation is not available here. Use Chrome on a computer or Android, or type instead.',
            upstream_error: 'The microphone or speech service stopped. Tap the mic to try again.',
            rate_limited: 'Too many dictations at once. Try again in a moment.',
            time_limit: 'Listening stopped after an hour. Tap the mic to continue.',
          }[reason];
          if (msg) toast(msg, 5000);
        } else setMic(state === 'listening' ? 'listening' : 'starting');
      });
    } catch (e) { /* no dictation in this view */ }
  })();

  // (window.__fakeIOS is set only by the dev-only tests/fake-sr.js)
  const IS_IOS = !!window.__fakeIOS || /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_SAFARI = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
  // Inside claude.ai the page can't load the model (only Claude dictation is available there).
  const IN_CLAUDE = !!(window.claude && typeof window.claude.use === 'function');
  const MODEL_OK = !IN_CLAUDE && !!(window.Worker && window.WebAssembly && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  // Which recogniser to use. "auto": the browser's own live recognition wherever it exists (Google's in
  // Chrome/Edge/Android, Apple's in Safari on iPhone and Mac): it streams each word back at once, which is
  // what makes tracking instant. Sabaq's own Quran model where there is none (Firefox), or where it is
  // refused (iPhone allows Apple's only while Siri is on): slower, but it works everywhere.
  function chooseKind() {
    if (Input.dict) return 'dictation';
    const pref = store.get('recognizer2', 'auto');
    if (pref === 'browser' && SR) return 'webspeech';
    if (pref === 'model' && MODEL_OK) return 'model';
    if (SR && !Input.srRefused && !(IS_IOS || IS_SAFARI)) return 'webspeech';
    return MODEL_OK ? 'model' : SR ? 'webspeech' : 'none';
  }
  // The browser's live recognition was refused: carry on with Sabaq's own model, in the same tap.
  function liveRefused(code, midway) {
    Input.srRefused = true; Input.want = false;
    if (!MODEL_OK) { toast('Speech recognition is not available here (' + code + ').', 6000); return false; }
    Input.kind = 'model';
    ModelMic.start();
    toast(IS_IOS || IS_SAFARI
      ? (midway ? 'Continuing with Sabaq\'s own speech model. ' : 'Using Sabaq\'s own speech model (a little slower). ')
        + 'For instant tracking like on a computer, turn on Siri (Settings › Siri), then reload.'
      : 'Using Sabaq\'s own speech model instead of the browser\'s (' + code + ').', 9000);
    const n = $('srNote'); if (n) n.hidden = false;
    return true;
  }

  function startListening() {
    if (Input.sim) stopSim();
    Input.kind = chooseKind();
    if (Input.kind === 'dictation') {
      setMic('starting');
      Input.dict.start({ language: 'ar' }).catch(err => {
        setMic('idle');
        const code = err && err.code;
        if (code === 'not_granted') toast('Microphone access was declined. You can type instead.', 5000);
        else if (code === 'unavailable') { toast('Arabic dictation is not available here. Try the demo or type instead.', 5000); }
        else if (code !== 'stopped' && code !== 'dismissed') toast('Could not start listening. Tap the mic to try again.', 4000);
      });
      return;
    }
    if (Input.kind === 'model') { ModelMic.start(); return; }
    if (Input.kind === 'webspeech') { startWebSpeech(); return; }
    if (IN_CLAUDE) { showSiteNote(); toast('The microphone is blocked inside Claude. Use the Sabaq website (link at the top).', 7000); return; }
    toast('This browser has no speech recognition. Use Chrome or Safari, or type instead.', 5000);
    openType();
  }
  function stopListening() {
    if (Input.sim) { stopSim(); return; }
    if (Input.kind === 'model') { ModelMic.stop(); return; }
    if (Input.kind === 'dictation' && Input.dict) { Input.dict.stop().catch(() => {}); return; }
    Input.want = false;
    clearTimeout(Input.restartTimer);
    if (Input.rec) { try { Input.rec.stop(); } catch (e) { /* already stopped */ } }
    else { setMic('idle'); settle(); }
  }

  // ---- turning a growing transcript into settled words (browser speech recognition)
  // Everything except the last two words is treated as settled (iPhone may never mark results final);
  // the last two stay live (previewed). A short silence settles them too and judges them.
  const Feed = {
    fed: 0, pending: [], timer: 0,
    reset() { this.fed = 0; this.pending = []; clearTimeout(this.timer); },
    ingest(words, allFinal) {
      const settled = allFinal ? words.length : Math.max(0, words.length - 2);
      if (words.length < this.fed) this.fed = words.length; // the transcript was revised shorter
      if (settled > this.fed) { commit(words.slice(this.fed, settled).join(' ')); this.fed = settled; }
      this.pending = words.slice(this.fed);
      preview(this.pending.join(' '));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.settle(), 900);
    },
    settle() {
      clearTimeout(this.timer);
      if (this.pending.length) {
        const p = this.pending;
        this.fed += p.length; this.pending = [];
        commit(p.join(' '));
      }
      if (!P && T.qi < T.q.length) { T.flush(); handleEvents(); render(); }
    },
  };

  // ---- the browser's own speech recognition (Chrome, Edge, Android; Safari only if chosen)
  function makeRec() {
    const rec = new SR();
    rec.lang = 'ar-SA';
    rec.continuous = !IS_IOS;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => { if (Input.kind === 'webspeech') setMic('listening'); };
    rec.onresult = e => {
      Input.okOnce = true;
      const parts = [];
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.trim();
        if (!t) continue;
        if (parts.length && t.startsWith(parts[parts.length - 1])) parts[parts.length - 1] = t; // Android repeats
        else parts.push(t);
      }
      const last = e.results[e.results.length - 1];
      Feed.ingest(E.tokenize(parts.join(' ')), !!(last && last.isFinal));
    };
    rec.onerror = e => {
      const code = e.error;
      if (code === 'no-speech' || code === 'aborted') return; // silence: onend restarts
      if (code === 'service-not-allowed' || code === 'not-allowed' || code === 'language-not-supported') {
        Input.want = false;
        if (IN_CLAUDE) { showSiteNote(); toast('The microphone is blocked inside Claude. Use the Sabaq website (link at the top).', 7000); return; }
        // refused (iPhone: Siri is off; or a restart without a tap was refused): the model takes over now
        if (code !== 'not-allowed' || !Input.okOnce) { if (liveRefused(code, Input.okOnce)) return; }
        if (Input.okOnce) {
          toast('Listening paused. Tap the mic to go on.', 5000);
        } else {
          toast((code === 'not-allowed' ? 'Microphone access was blocked' : 'Speech recognition is not available here') + ' (' + code + ').', 6000);
        }
      } else if (code === 'audio-capture') {
        toast('No microphone input. Another app may be using the microphone.', 5000);
      } else if (code === 'network') {
        toast('Speech recognition needs an internet connection.', 4000);
      } else {
        toast('Speech recognition error: ' + code + '. Tap the mic to try again.', 5000);
      }
    };
    rec.onend = () => {
      Feed.settle();
      Feed.reset();
      if (Input.kind === 'model') { Input.rec = null; return; }
      if (Input.want) {
        clearTimeout(Input.restartTimer);
        Input.restartTimer = setTimeout(restartWebSpeech, IS_IOS ? 150 : 0);
        return;
      }
      Input.rec = null; setMic('idle'); settle();
    };
    return rec;
  }
  function restartWebSpeech() {
    if (!Input.want) { Input.rec = null; setMic('idle'); settle(); return; }
    try { Input.rec.start(); return; } catch (e) { /* this one can't restart: use a fresh one */ }
    try { Input.rec = makeRec(); Input.rec.start(); }
    catch (e) {
      Input.want = false; Input.rec = null; setMic('idle'); settle();
      toast('Listening paused. Tap the mic to go on.', 4000);
    }
  }
  function startWebSpeech() {
    Input.want = true; Input.okOnce = false;
    Feed.reset();
    Input.rec = makeRec();
    setMic('starting');
    try { Input.rec.start(); }
    catch (err) { Input.want = false; Input.rec = null; setMic('idle'); toast('Could not start the microphone.', 4000); }
  }

  // ---- Sabaq's speech server: recognition on a server, the way Tarteel does it (and Google for Chrome).
  // Same messages as the in-browser worker. Each phrase's audio is uploaded once, as it grows (16-bit,
  // 32 KB/s); a reading then only names the phrase and how much of it to read.
  class RemoteASR {
    constructor(url, onFail) {
      this.onmessage = null; this.sent = new Map(); this.queue = []; this.open = false; this.ended = false;
      const ws = this.ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
      const fail = (wasOpen) => { if (this.ended) return; this.ended = true; clearTimeout(timer); onFail(wasOpen); };
      const timer = setTimeout(() => { if (!this.open) { try { ws.close(); } catch (e) { /* gone */ } fail(false); } }, 5000);
      ws.onopen = () => { this.open = true; clearTimeout(timer); for (const b of this.queue.splice(0)) ws.send(b); };
      ws.onmessage = e => { if (typeof e.data === 'string' && this.onmessage) { try { this.onmessage({ data: JSON.parse(e.data) }); } catch (err) { /* bad message */ } } };
      ws.onclose = () => fail(this.open);
    }
    send(head, pcm) {
      let h = new TextEncoder().encode(JSON.stringify(head));
      if (h.length % 2) h = new TextEncoder().encode(JSON.stringify(head) + ' ');
      const n = pcm ? pcm.length : 0, buf = new ArrayBuffer(4 + h.length + n * 2);
      new DataView(buf).setUint32(0, h.length, true);
      new Uint8Array(buf, 4, h.length).set(h);
      if (n) { const o = new Int16Array(buf, 4 + h.length, n); for (let i = 0; i < n; i++) { const v = pcm[i]; o[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : v * 32767; } }
      if (this.open) this.ws.send(buf); else this.queue.push(buf);
    }
    postMessage(m) {
      if (m.type !== 'run') return; // the server has its own model
      if (m.kind === 'verify' || m.seg < 0) { this.send({ t: 'full', kind: m.kind, seg: m.seg, windows: m.windows }, m.audio); return; }
      const done = this.sent.get(m.seg) || 0;
      if (m.audio.length > done) { this.send({ t: 'chunk', seg: m.seg }, m.audio.subarray(done)); this.sent.set(m.seg, m.audio.length); }
      while (this.sent.size > 8) this.sent.delete(this.sent.keys().next().value);
      this.send({ t: 'run', kind: m.kind, seg: m.seg, len: m.audio.length, whole: !!m.whole, cap: m.cap });
    }
    // streaming: more audio of the phrase being recited (the server reads it as it comes)
    sendChunk(seg, pcm, whole, cap) {
      this.send({ t: 'chunk', seg, live: 1, whole: !!whole, cap }, pcm);
      this.sent.set(seg, (this.sent.get(seg) || 0) + pcm.length);
      while (this.sent.size > 8) this.sent.delete(this.sent.keys().next().value);
    }
    terminate() { this.ended = true; try { this.ws.close(); } catch (e) { /* gone */ } }
  }
  // Where the speech server is: ?asr=wss://… (remembered; ?asr=off to stop), else the site's own server when
  // the page is served by one (it answers /health), else none (the model runs in the browser).
  let asrServer = null, reportTo = null;
  async function findServer() {
    try {
      const q = new URLSearchParams(location.search).get('asr');
      if (q) store.set('asrServer', q === 'off' ? '' : q);
      const saved = store.get('asrServer', null);
      if (saved !== null) { asrServer = saved || null; return; }
      if (IN_CLAUDE) return;
      const r = await fetch('health', { cache: 'no-store' }).catch(() => null);
      if (r && r.ok && /json/.test(r.headers.get('content-type') || '')) { asrServer = location.origin.replace(/^http/, 'ws') + location.pathname.replace(/[^/]*$/, '') + 'asr'; return; }
      // A server announced on this site: a computer running Sabaq's server (server/start-public.js) publishes its
      // current public address in asr-url.json. Used only if it answers now; otherwise the in-browser model.
      // (a query that changes every time: GitHub Pages' cache could otherwise hand out an address up to 10 minutes old)
      const a = await fetch('asr-url.json?t=' + Date.now(), { cache: 'no-store' }).then(x => (x.ok ? x.json() : null)).catch(() => null);
      if (a && /^https:\/\//.test(a.url || '')) {
        const base = a.url.replace(/\/+$/, ''), ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
        reportTo = base;
        const h = await fetch(base + '/health', { cache: 'no-store', mode: 'cors', signal: ctl.signal }).then(x => (x.ok ? x.json() : null)).catch(() => null);
        clearTimeout(t);
        if (h && h.ready) asrServer = base.replace(/^https/, 'wss') + '/asr';
      }
    } catch (e) { /* no server here */ }
  }
  const asrServerReady = findServer();

  // Short technical reports to the speech server's log (browser, microphone result, errors; never audio or words),
  // so a problem on someone's iPhone can be seen from the server. Off with ?report=off.
  const reportOff = /[?&]report=off/.test(location.search);
  function report(what, data) {
    if (reportOff) return;
    const base = asrServer ? asrServer.replace(/^ws/, 'http').replace(/\/asr$/, '') : reportTo || (location.protocol === 'https:' || location.hostname === 'localhost' ? location.origin + location.pathname.replace(/[^/]*$/, '') : null);
    if (!base) return;
    try {
      const body = JSON.stringify(Object.assign({ what, t: Math.round(performance.now()), ua: navigator.userAgent.slice(0, 160) }, data || {}));
      const url = base.replace(/\/+$/, '') + '/report';
      if (!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' })))) fetch(url, { method: 'POST', body, mode: 'cors', keepalive: true }).catch(() => {});
    } catch (e) { /* best effort */ }
  }
  window.addEventListener('error', e => report('error', { msg: String(e.message).slice(0, 200), at: (e.filename || '').split('/').pop() + ':' + e.lineno }));
  window.addEventListener('unhandledrejection', e => report('error', { msg: String(e.reason && (e.reason.message || e.reason)).slice(0, 200) }));
  asrServerReady.then(() => report('page', { server: asrServer, secure: window.isSecureContext, modelOk: MODEL_OK, ios: IS_IOS, kind: chooseKind(),
    worklet: typeof AudioWorkletNode === 'function', ctx: !!(window.AudioContext || window.webkitAudioContext), from: location.host }));

  // ---- Sabaq's own speech recognition: the microphone is recorded here, cut into phrases where the
  // reciter pauses, and each phrase is transcribed by Tarteel's Quran Whisper model in a worker.
  // While a phrase is still being recited, it is transcribed every ~1.2 s for live tracking.
  const SLOW_MS = +new URLSearchParams(location.search).get('slowms') || 5000; // (dev: ?slowms= tests the slow-device mode)
  const ModelMic = {
    worker: null, ready: false, failed: false, files: {}, stream: null, src: null, node: null, sink: null,
    on: false, seg: 0, inSpeech: false, suspectAt: -1, inflightF: null, retries: 0, buf: [], len: 0, pre: [], preLen: 0, run: 0, silence: 0,
    floor: 0.004, busy: false, finals: [], partial: null, lastPartial: 0, rs: null, frame: [], frameLen: 0, ms: [],
    busyKind: '', slowCached: false, chunkCached: 7, busyP: false, unsent: [], unsentLen: 0, streamSeg: -1, inflightP: 0, srvStream: 0, lastLive: { seg: -1, len: 0 }, judging: null, busyF: false, lanes: 1, pendingFinal: new Set(), cutNow: false, cutAt: 0, cutMid: new Set(), costA: 1000, perSec: [], agree: { seg: -1, prev: [], done: 0, locked: [] }, judgedSeg: 0, threads: 1, chain: Promise.resolve(), audioOf: new Map(), verifyWait: null, frames: 0, level: 0, recent: [], voicedN: 0, ctx: null, nonzero: false, watch: 0, rebuilt: false,

    loadPct() {
      let l = 0, t = 0;
      for (const k in this.files) { l += this.files[k].loaded; t += this.files[k].total; }
      return t ? Math.min(99, Math.round(l / t * 100)) : 0;
    },
    init(local) {
      if (this.worker) return;
      if (!local && asrServer) {
        this.remote = true;
        this.worker = new RemoteASR(asrServer, wasOpen => this.lost(wasOpen));
        this.worker.onmessage = e => this.onMessage(e.data);
        return;
      }
      this.remote = false;
      this.worker = new Worker('asr-worker.js', { type: 'module' });
      this.worker.onmessage = e => this.onMessage(e.data);
      this.worker.onerror = () => {
        // Under cross-origin isolation some browsers refuse the model's code (Safari): undo it and reload once
        let tried = false; try { tried = !!sessionStorage.getItem('sabaq-unisolate'); } catch (err) { tried = true; }
        if (self.crossOriginIsolated && navigator.serviceWorker && !tried) {
          try { sessionStorage.setItem('sabaq-unisolate', '1'); } catch (err) { /* fine */ }
          toast('Setting up the speech model for this browser…', 4000);
          navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))).finally(() => location.reload());
          return;
        }
        this.failed = true; toast('The speech model could not start in this browser. Try reloading the page.', 7000); this.stop();
      };
      const slowX = +(new URLSearchParams(location.search).get('asrslow') || 0);
      this.worker.postMessage({ type: 'load', slow: slowX > 1 ? slowX : 0 });
    },
    // The server connection dropped (a tunnel hiccup, the server restarting, the phone switching networks).
    // Reconnect first (the phrase in progress is re-sent in full); only after ~7 s of failed tries does the
    // slower model on the phone take over, said on screen, and the server is tried again every 15 s.
    lost(wasOpen) {
      this.worker = null; this.ready = false; this.busy = false; this.busyKind = ''; this.busyP = this.busyF = false; this.inflightP = 0;
      this.streamSeg = -1; this.unsent = []; this.unsentLen = 0; this.lastLive = { seg: -1, len: 0 };
      if (this.verifyWait) { const f = this.verifyWait; this.verifyWait = null; f(null); }
      if (this.inflightF && this.inflightF.seg >= 0) this.finals.unshift(this.inflightF);
      this.inflightF = null;
      this.retries = (this.retries || 0) + 1;
      const waits = [300, 1000, 2000, 4000];
      if (this.retries <= waits.length) {
        this.remote = true;
        if (this.retries === 1 && wasOpen) toast('Reconnecting to Sabaq\'s speech server…', 3000);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { if (!this.worker) this.init(); }, waits[this.retries - 1]);
        renderStatus(); return;
      }
      this.retries = 0; this.remote = false; this.pendingFinal.clear();
      report('server-lost', { server: asrServer });
      toast('Can\'t reach Sabaq\'s speech server. Using the slower model on this phone for now; Sabaq switches back when the server returns.', 7000);
      this.init(true); renderStatus();
      clearInterval(this.probeTimer);
      this.probeTimer = setInterval(async () => {
        if (this.remote || !asrServer) { clearInterval(this.probeTimer); return; }
        if (this.inSpeech || this.busy || this.finals.length) return;   // (not in the middle of a phrase)
        const base = asrServer.replace(/^ws/, 'http').replace(/\/asr$/, '');
        const h = await fetch(base + '/health', { cache: 'no-store', mode: 'cors' }).then(x => (x.ok ? x.json() : null)).catch(() => null);
        if (!h || !h.ready || this.remote || this.inSpeech || this.busy) return;
        clearInterval(this.probeTimer);
        try { this.worker && this.worker.terminate(); } catch (e) { /* gone */ }
        this.worker = null; this.ready = false; this.init();
        toast('Back on Sabaq\'s speech server.', 2500);
      }, 15000);
    },
    onMessage(m) {
      if (m.type === 'bye') return; // the server is restarting: its closing connection starts the reconnect
      if (m.type === 'progress') {
        if (m.total) this.files[m.file] = { loaded: m.loaded, total: m.total };
        if (this.on) renderStatus();
      } else if (m.type === 'ready') {
        this.updateSpeed(); this.ready = true; this.retries = 0; this.threads = m.threads || 1; this.lanes = m.lanes || 1; this.srvStream = m.stream || 0; this.inflightP = 0; this.models = m.models || null; this.canScore = !!m.score; if (m.warm) this.costA = m.warm; renderStatus(); this.pump();
      } else if (m.type === 'error') {
        this.failed = true;
        toast('Could not download the speech model. Check the connection and tap the mic again.', 6000);
        this.worker.terminate(); this.worker = null; this.stop();
      } else if (m.type === 'result') {
        if (this.twoLanes()) { if (m.kind === 'partial') { this.inflightP = Math.max(0, this.inflightP - 1); this.busyP = this.inflightP >= this.maxP(); } else { this.busyF = false; this.busyKind = ''; } this.busy = this.busyP || this.busyF; }
        else { this.busy = false; this.busyKind = ''; }
        if (m.ms && m.kind !== 'score') {
          this.ms.push(m.ms); if (this.ms.length > 8) this.ms.shift();
          // cost of a reading ~ a (fixed: the model always hears 30 s) + b per second of audio (writing it out)
          if (m.secs > 1.5) { this.perSec.push(Math.max(0, (m.ms - this.costA) / m.secs)); if (this.perSec.length > 6) this.perSec.shift(); }
        }
        // (a live reading the server replaced by a newer one; or one older than a reading already used)
        if (m.dropped) { this.pump(); return; }
        if (m.kind === 'partial' && m.len != null) {
          if (m.seg === this.lastLive.seg && m.len <= this.lastLive.len) { this.pump(); return; }
          this.lastLive = { seg: m.seg, len: m.len };
        }
        if (m.kind !== 'partial') this.inflightF = null;
        let d = null;
        if (m.kind === 'partial' && m.cap != null) { const rx = performance.now(); d = { seg: m.seg, rx, e2e: rx - m.cap, wait: m.wait, ms: m.ms, net: rx - m.cap - (m.wait || 0) - (m.ms || 0) }; }
        if (window.__asrLog) window.__asrLog.push({ kind: m.kind, seg: m.seg, ms: m.ms, secs: m.secs, at: performance.now(), text: m.text + (m.gap != null ? '  (gap ' + m.gap.toFixed(2) + ')' : '') }); // dev-only test log
        if (m.kind === 'final') this.chain = this.chain.then(() => this.judge(m.text, m.seg)).catch(() => {});
        else if (m.kind === 'verify' || m.kind === 'verifyc') { const f = this.verifyWait; this.verifyWait = null; if (f) f(m.text); }
        else if (m.kind === 'score') { const f = this.verifyWait; this.verifyWait = null; if (f) f(m.error ? null : m.costs); }
        else {
          const whole = m.whole != null ? !!m.whole : this.partialWhole, gap = m.gap;
          // (two lanes: the earlier phrase may not be judged yet, or is being double-checked; its words come
          // first, so this one only moves the highlight for now, at once, and locks nothing in)
          if ([...this.pendingFinal].some(x => x < m.seg) || (this.judging != null && this.judging < m.seg)) this.peek(m.text, m.seg, whole, gap);
          else this.chain = this.chain.then(() => { this.live(m.text, m.seg, whole, gap); if (d) { d.align = performance.now() - d.rx; Diag.pending = d; render(false); } }).catch(() => {});
        }
        this.updateSpeed(); this.showSpeed();
        this.pump();
        if (!this.on && !this.busy && !this.finals.length) settle();
      }
    },
    async start() {
      const a = audio(); // inside the tap: lets the qari play later (iPhone)
      if (!a) { toast('Audio is not available in this browser.', 4000); return; }
      setMic('starting');
      await Promise.race([asrServerReady, new Promise(r => setTimeout(r, 4000))]);
      // (no server when the page opened, e.g. it was restarting: look again now, and use it if it is back)
      if (!asrServer) { await Promise.race([findServer(), new Promise(r => setTimeout(r, 5000))]); if (asrServer && this.worker && !this.remote) { try { this.worker.terminate(); } catch (e) { /* gone */ } this.worker = null; this.ready = false; } }
      this.init();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      } catch (err) {
        setMic('idle');
        report('mic-failed', { name: err && err.name, msg: String(err && err.message).slice(0, 160) });
        toast(IS_IOS ? 'Microphone blocked. Allow it for this site: Settings › Safari › Microphone, then reload.'
          : 'Microphone access was blocked. Allow it in the browser and try again.', 7000);
        return;
      }
      this.on = true; this.inSpeech = false; this.buf = []; this.len = 0; this.pre = []; this.preLen = 0; this.run = 0; this.silence = 0;
      this.frame = []; this.recent = []; this.frames = 0; this.level = 0; this.rebuilt = false;
      await this.connect(a);
      this.stream.getAudioTracks().forEach(t => { t.onended = () => { if (this.on) { toast('The microphone stopped.', 4000); this.stop(); } }; });
      setMic('listening');
      this.meter();
      clearInterval(this.diagTimer);
      this.diagTimer = setInterval(() => { if (!this.on) { clearInterval(this.diagTimer); return; } if (Diag.rows.length) report('timing', Object.assign(Diag.summary(), { wps: +wordsPerSec().toFixed(2), remote: !!this.remote })); }, 30000);
      setTimeout(() => report('mic', { capture: this.capture, rate: this.rate, ctx: this.ctx && this.ctx.state, frames: this.frames, level: +this.level.toFixed(4), remote: !!this.remote, ready: this.ready, server: asrServer }), 4000);
    },
    // iPhone Safari pauses the microphone (and may close the connection) when the page goes to the background or
    // the screen locks. Going away: the phrase being heard is finished now (so it is judged, not glued to what
    // comes after). Coming back: the audio is resumed and checked; a microphone the system took away needs a tap.
    onVisibility() {
      if (!this.on) return;
      if (document.visibilityState === 'hidden') { if (this.inSpeech) this.endSegment(); return; }
      const tr = this.stream && this.stream.getAudioTracks()[0];
      if (!tr || tr.readyState === 'ended') { toast('The microphone paused while Sabaq was in the background. Tap the mic to carry on.', 5000); this.stop(); return; }
      if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      if (this.remote && !this.worker) this.init();
      this.frames = 0; this.rebuilt = false; clearTimeout(this.watch); this.watch = setTimeout(() => this.check(), 2000);
    },
    // mic -> processor (kept running through a silent gain) -> 16 kHz frames
    async connect(a) {
      this.ctx = a;
      if (a.state !== 'running') { try { await a.resume(); } catch (e) { /* tried */ } }
      a.onstatechange = () => { if (this.on && this.ctx === a && a.state !== 'running' && a.state !== 'closed') a.resume().catch(() => {}); };
      this.src = a.createMediaStreamSource(this.stream);
      this.sink = a.createGain(); this.sink.gain.value = 0;
      // (the microphone runs at the device's rate, usually 48 kHz on iPhone, 44.1 or 48 kHz elsewhere, lower over
      // some Bluetooth headsets: it is converted to the 16 kHz the model was trained on. Above ~19 kHz, sound above
      // 7 kHz is first filtered out (a 4th-order low-pass), so "s"/"sh" hiss can't fold into the speech band)
      const fsIn = a.sampleRate, w = 2 * Math.PI * 7600 / fsIn, cw = Math.cos(w);
      const sec = Q => { const al = Math.sin(w) / (2 * Q), a0 = 1 + al; return { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0, a1: -2 * cw / a0, a2: (1 - al) / a0 }; };
      this.rs = { ratio: fsIn / 16000, pos: 0, acc: 0, n: 0, last: 0, s1: 0, s2: 0, t1: 0, t2: 0,
        lp: fsIn > 19000 ? [sec(0.5412), sec(1.3066)] : null };   // (4th-order Butterworth: flat to ~6 kHz)
      this.rate = fsIn;
      this.nonzero = false; this.frames = 0;
      // An AudioWorklet hands the audio over every ~21 ms on the audio thread (nothing is lost while the page is
      // busy); the older ScriptProcessor only every ~85 ms. The older one stays as the fallback.
      this.node = null;
      if (!this.noWorklet && a.audioWorklet && typeof AudioWorkletNode === 'function') {
        try {
          if (!a.__sabaqCap) {
            const code = 'class C extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(1024);this.n=0}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===1024){this.port.postMessage(this.b,[this.b.buffer]);this.b=new Float32Array(1024);this.n=0}}}return true}}registerProcessor("sabaq-cap",C);';
            const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
            await a.audioWorklet.addModule(url); URL.revokeObjectURL(url); a.__sabaqCap = true;
          }
          this.node = new AudioWorkletNode(a, 'sabaq-cap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          this.node.port.onmessage = e => this.onAudio(e.data);
          this.capture = 'worklet';
        } catch (e) { this.node = null; }
      }
      if (!this.node) {
        this.node = a.createScriptProcessor(4096, 1, 1); // (2048 drops audio on a busy slow phone)
        this.node.onaudioprocess = e => this.onAudio(e.inputBuffer.getChannelData(0));
        this.capture = 'script';
      }
      this.src.connect(this.node); this.node.connect(this.sink); this.sink.connect(a.destination);
      // iPhone: the audio engine can come up "interrupted" or deliver only silence once the mic switches it
      // to recording. If no real sound arrives within 2 s, rebuild the path once in a fresh audio context
      // (allowed without a tap while the microphone is in use).
      clearTimeout(this.watch);
      this.watch = setTimeout(() => this.check(), 2000);
    },
    async check() {
      if (!this.on) return;
      // audio is flowing (a silent room can be true digital silence with noise suppression on)
      if (this.frames > 0 && this.ctx.state === 'running') return;
      report('mic-silent', { capture: this.capture, ctx: this.ctx && this.ctx.state, frames: this.frames, rebuilt: this.rebuilt });
      if (this.rebuilt) { toast('The microphone is not sending sound. Close other apps using it, then tap the mic again.', 6000); return; }
      this.rebuilt = true;
      this.noWorklet = true; // (the rebuild uses the older, proven capture path)
      this.unhook();
      const C = window.AudioContext || window.webkitAudioContext;
      let fresh = null; try { fresh = new C(); } catch (e) { /* none */ }
      if (fresh) await this.connect(fresh);
    },
    unhook() {
      try { if (this.node) { this.node.onaudioprocess = null; if (this.node.port) this.node.port.onmessage = null; this.node.disconnect(); } if (this.src) this.src.disconnect(); if (this.sink) this.sink.disconnect(); } catch (e) { /* gone */ }
      if (this.ctx && this.ctx !== actx) { const c = this.ctx; c.onstatechange = null; c.close().catch(() => {}); }
      this.src = this.node = this.sink = null;
    },
    // the mic button's ring follows the voice, so the reciter can see they are being heard
    meter() {
      const b = $('micBtn');
      const tick = () => {
        if (!this.on) { b.style.removeProperty('--lvl'); return; }
        const v = Math.min(1, Math.max(0, Math.log10(Math.max(this.level, 1e-4) / Math.max(this.floor * 2, 0.002)) / 1.2));
        b.style.setProperty('--lvl', v.toFixed(2));
        b.dataset.hear = this.inSpeech ? '1' : '0';
        this.level *= 0.8;
        setTimeout(tick, 60);
      };
      tick();
    },
    stop() {
      if (this.inSpeech) this.endSegment();
      this.on = false;
      clearTimeout(this.watch);
      this.unhook();
      $('micBtn').dataset.hear = '0';
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      this.stream = this.src = this.node = this.sink = null;
      setMic('idle');
      if (!this.busy && !this.finals.length) settle();
    },
    // resample to 16 kHz (averaging the input samples that fall in each output sample) in 20 ms frames
    onAudio(input) {
      if (!this.on) return;
      if (!this.nonzero) for (let i = 0; i < input.length; i += 64) if (input[i] !== 0) { this.nonzero = true; break; }
      const rs = this.rs, f = rs.lp;
      const out = v => { this.frame.push(v); if (this.frame.length === 320) { this.onFrame(Float32Array.from(this.frame)); this.frame = []; } };
      for (let i = 0; i < input.length; i++) {
        let x = input[i];
        if (f) {
          const g = f[0], h = f[1];
          let y = g.b0 * x + rs.s1; rs.s1 = g.b1 * x - g.a1 * y + rs.s2; rs.s2 = g.b2 * x - g.a2 * y; x = y;
          y = h.b0 * x + rs.t1; rs.t1 = h.b1 * x - h.a1 * y + rs.t2; rs.t2 = h.b2 * x - h.a2 * y; x = y;
        }
        if (rs.ratio < 1) { // (fewer than 16000 samples a second: fill in between them)
          while (rs.pos < 1) { out(rs.last + (x - rs.last) * rs.pos); rs.pos += rs.ratio; }
          rs.pos -= 1; rs.last = x; continue;
        }
        rs.acc += x; rs.n++;
        rs.pos += 1;
        if (rs.pos >= rs.ratio) { rs.pos -= rs.ratio; out(rs.acc / rs.n); rs.acc = 0; rs.n = 0; }
      }
    },
    // voice activity: a phrase starts on 60 ms of sound above the noise floor and ends after 650 ms of quiet
    onFrame(f) {
      if (Qari.gated()) {
        // the qari is speaking: drop what the mic hears (and forget words of the dropped phrase already used)
        if (this.inSpeech || this.len) phraseSkip = 0;
        this.inSpeech = false; this.buf = []; this.len = 0; this.pre = []; this.preLen = 0; this.run = 0; this.partial = null;
        this.unsent = []; this.unsentLen = 0;
        return;
      }
      let e = 0; for (let i = 0; i < f.length; i++) e += f[i] * f[i];
      const rms = Math.sqrt(e / f.length);
      this.frames++; this.level = Math.max(rms, this.level * 0.85);
      // Noise floor = the quietest moment of the last ~3 s, so a fan, an air conditioner or a noisy room
      // raises it (the old floor only learned from quiet frames and could get stuck "always speaking").
      this.recent.push(rms); if (this.recent.length > 150) this.recent.shift();
      // (frozen while a phrase is heard: the gaps between words are not the room, and a raised floor would
      // cut off soft word endings; it may still go down)
      if (this.frames % 10 === 0) {
        let mn = Infinity; for (const v of this.recent) if (v < mn) mn = v;
        if (!this.inSpeech || mn < this.floor) this.floor = Math.max(0.0008, mn);
      }
      const thr = Math.max(0.006, this.floor * 3);
      const voiced = rms > thr;
      if (!this.inSpeech) {
        this.pre.push(f); this.preLen += f.length;
        while (this.preLen > 16000 * 0.35) this.preLen -= this.pre.shift().length;
        this.run = voiced ? this.run + 1 : 0;
        if (this.run >= 3) {
          if (window.__asrLog) window.__asrLog.push({ kind: "vad", seg: this.seg + 1, at: performance.now(), text: "speech start (" + this.capture + "), pre " + (this.preLen / 16000).toFixed(2) + "s, ctx " + (this.ctx && this.ctx.baseLatency) + " out " + (this.ctx && this.ctx.outputLatency) }); // dev-only
          this.inSpeech = true; this.seg++; this.silence = 0; this.voicedN = this.run; this.lastPartialLen = 0;
          this.buf = this.pre; this.len = this.preLen; this.pre = []; this.preLen = 0;
          this.lastPartial = performance.now();
          // (a phrase is streamed from its first sample, or not at all: the server must have it whole)
          this.streamSeg = this.streaming() ? this.seg : -1;
          if (this.streamSeg >= 0) { this.unsent = this.buf.slice(); this.unsentLen = this.len; }
        }
        return;
      }
      this.buf.push(f); this.len += f.length;
      if (voiced) this.voicedN++;
      this.silence = voiced ? 0 : this.silence + 20;
      // streaming to the server: every 40 ms of audio (the server reads it whenever its model is free)
      if (this.streamSeg === this.seg && this.streaming()) {
        this.unsent.push(f); this.unsentLen += f.length;
        if (this.unsentLen >= 640 && this.silence < 650) {
          const out = new Float32Array(this.unsentLen); let o = 0;
          for (const b of this.unsent) { out.set(b, o); o += b.length; }
          this.unsent = []; this.unsentLen = 0;
          this.worker.sendChunk(this.seg, out, this.silence >= 100, Math.round(performance.now()));
        }
      }
      if (this.silence >= 650) { this.endSegment(); return; }
      // (streaming to the server: after 7 s only at a real pause, 300 ms: at fast recitation a 160 ms gap can fall
      // between two words of one breath, leaving a word alone in a sliver of audio that both models mishear)
      // A long phrase is cut sooner (the small model drops the last words of long phrases): after 7 s at a
      // short pause between words (160 ms, longer than the stops inside a word), after 14 s at a 100 ms
      // pause (never inside a fading word ending), and at 25 s regardless.
      // (an early cut waits for the next short gap between words: cutting inside a word garbles it, and both
      // readings would then hear the same garble; after 1.5 s it cuts anyway and the word at the cut is not judged)
      const cutGap = this.cutNow && this.silence >= 160, cutLate = false;
      if (cutGap || cutLate || (this.len >= 16000 * this.chunkSecs() && this.silence >= (this.streaming() ? 300 : 160)) || (this.len >= 16000 * 14 && this.silence >= 100) || this.len >= 16000 * 25) {
        if (cutLate && !cutGap) this.cutMid.add(this.seg);
        this.cutNow = false;
        this.endSegment(); this.inSpeech = true; this.seg++; this.silence = 0; this.lastPartial = performance.now(); this.lastPartialLen = 0;
        this.streamSeg = this.streaming() ? this.seg : -1;
        // 12 s without a pause may be room noise, not recitation: let the floor learn the last 3 s
        let mn = Infinity; for (const v of this.recent) if (v < mn) mn = v; this.floor = Math.max(0.0008, mn);
        return;
      }
      // live reading of the phrase so far, whenever the model is free (on a slow phone that is back to back);
      // not in a long pause that may be the end of the phrase, so the final reading never waits behind one.
      // The best moment is the short pause between two words (the last word is then complete): read there too.
      const fast = this.remote && this.srvStream >= 2;
      const due = this.silence < 200 && performance.now() - this.lastPartial > (fast ? 80 : this.remote ? (this.costA < 150 ? 120 : 200) : 500);
      const gap = this.silence >= 100 && this.silence < 300;
      if (!(this.streamSeg === this.seg && this.streaming()) && (this.twoLanes() ? !this.busyP : (!this.busy && !this.finals.length)) && !this.slowDevice() && (due || gap) && this.len > (this.lastPartialLen || 0) + (fast ? 1280 : 3200) && this.len > 16000 * (fast ? 0.5 : this.remote ? 0.6 : 1.2)) {
        this.lastPartial = performance.now(); this.lastPartialLen = this.len;
        // (if the audio so far ends in a short pause, its last word is complete: the reading keeps it)
        this.partial = { kind: 'partial', seg: this.seg, audio: this.join(), whole: this.silence >= 100, cap: Math.round(performance.now()) };
        this.pump();
      }
    },
    join() {
      const out = new Float32Array(this.len); let o = 0;
      for (const b of this.buf) { out.set(b, o); o += b.length; }
      return out;
    },
    endSegment() {
      // keep the whole phrase, including the quiet end: soft final syllables (a fading madd) live there
      const audioSeg = this.join();
      const voicedN = this.voicedN; this.voicedN = 0;
      this.unsent = []; this.unsentLen = 0;
      this.inSpeech = false; this.buf = []; this.len = 0; this.silence = 0; this.partial = null;
      // a click, a cough or a door is not a phrase: at least 0.2 s of clear sound
      if (audioSeg.length > 16000 * 0.25 && voicedN >= 10) {
        this.audioOf.set(this.seg, audioSeg); if (this.audioOf.size > 6) this.audioOf.delete(this.audioOf.keys().next().value);
        this.pendingFinal.add(this.seg);
        this.finals.push({ kind: 'final', seg: this.seg, audio: audioSeg.slice() }); this.pump();
      }
    },
    // A live reading of the phrase so far (re-read every moment while the reciter is speaking). Its last word
    // is dropped (the audio may end mid-word). Words that are simply the right words are locked in (tracked
    // for good) at once: nothing to judge, so no risk of a false mistake. Anything that looks wrong waits for
    // the phrase's final reading and its double-check (two live readings of the same audio often share a
    // garbled word, so their agreeing proves nothing). The rest is shown as a preview.
    live(text, seg, whole, gap) {
      if (seg <= this.judgedSeg) return;
      const all = E.tokenize(text), words = whole ? all : all.slice(0, -1), tail = whole ? null : all[all.length - 1] || null;
      const A = this.agree.seg === seg ? this.agree : (this.agree = { seg, prev: [], done: 0, locked: [] });
      A.prev = words;
      this.tailNow = tail ? { seg, w: tail, at: performance.now(), n: this.tailNow && this.tailNow.seg === seg && this.tailNow.w === tail ? this.tailNow.n + 1 : 1 } : null;
      // Readings of the same phrase don't always start alike (one may add or drop a garbled first word), so
      // where the locked-in words end is found by matching them, never by counting.
      const start0 = alignAfter(words, A.locked);
      const start = start0 >= 0 ? start0 : Math.min(A.locked.length, words.length); // (not found: by position)
      let n = start;
      // (only words the tracker has confirmed: the last word or two still wait for what follows them, and
      // locking those in could lock in a garbled word before it is judged)
      // (before your place is found, one try: each try searches the whole Quran, and nothing locks in until then)
      for (let j = words.length; j > n; j--) { const ok = cleanFeed(words.slice(start, j)); if (ok > 0) { n = start + ok; break; } if (T.c < 0) break; }
      if (window.__asrLog) window.__asrLog.push({ kind: 'live', seg, at: performance.now(), text: 'locked ' + start + '->' + n + ' of ' + words.length + ' | T.c=' + T.c + ' q=' + T.q.length + ' qi=' + T.qi }); // dev-only
      if (n > start) {
        const fresh = words.slice(start, n); A.locked.push(...fresh); A.done = A.locked.length; P = null; T.feed(fresh);
        if (window.__asrLog) window.__asrLog.push({ kind: 'live', seg, at: performance.now(), text: '  fed [' + fresh.join(' ') + '] -> c=' + T.c + ' events ' + T.events.map(e => e.type + '@' + e.pos + (e.to != null ? '->' + e.to : '')).join(',') }); // dev-only
        handleEvents();
      }
      // A mistake shown by a live reading (and confirmed by the words after it): don't wait for the reciter to
      // pause; end the phrase now, so its final reading and double-check (and the stop) come at once. The
      // double-check still decides: a garble in one reading never stops anyone.
      if (T.strict && T.c >= 0 && seg === this.seg && this.inSpeech && words.length > n) {
        const stopAt = ws => { const C = T.clone(); C.feed(ws); const st = C.events.find(e => e.type === 'stop'); return st ? st.pos : -1; };
        const rest = words.slice(n);
        let at = stopAt(rest);
        // (a word split in two right after the mistake, e.g. بمصابيح heard as "ذب مصابيح", hides it: allow one stray word)
        for (let i = 1; i <= 2 && at < 0 && rest.length >= 3; i++) at = stopAt(rest.filter((_, k) => k !== i));
        if (at >= 0 && A.cutFor !== at) { A.cutFor = at; this.cutNow = true; this.cutAt = performance.now(); }
        if (window.__asrLog) window.__asrLog.push({ kind: 'live', seg, at: performance.now(), text: '  suspect ' + (at >= 0 ? M.disp[at] : '-') + ' (before: ' + (A.suspect >= 0 ? M.disp[A.suspect] : '-') + ') rest=[' + rest.join(' ') + ']' + (this.cutNow ? ' CUT' : '') }); // dev-only
        A.suspect = at;
        if (this.suspectAt !== at) { this.suspectAt = at; render(false); }
      }
      if (seg === this.seg && this.inSpeech && (words.length > n || tail)) preview(words.slice(n).join(' '), true, tail);
      else { P = null; render(); }
    },
    // A live reading shown without locking anything in (an earlier phrase is still being judged)
    peek(text, seg, whole, gap) {
      if (seg !== this.seg || !this.inSpeech) return;
      const all = E.tokenize(text), words = whole ? all : all.slice(0, -1);
      this.tailNow = !whole && all.length ? { seg, w: all[all.length - 1], at: performance.now(), n: this.tailNow && this.tailNow.seg === seg && this.tailNow.w === all[all.length - 1] ? this.tailNow.n + 1 : 1 } : null;
      // (the phrase before this one is still being judged, or its final reading is on its way: its words so far)
      const A = this.agree;
      const before = this.judging != null && this.judgingText ? this.judgingText : A.seg < seg && A.prev.length ? this.unlocked(A.prev.join(' '), A.seg) : null;
      if (all.length) preview(words.join(' '), true, whole ? null : all[all.length - 1], before);
    },
    // the words of a final reading that were not already locked in from live readings
    unlocked(text, seg, wide) {
      const w = E.tokenize(text);
      const A = this.agree;
      if (A.seg !== seg || !A.locked.length) return w.join(' ');
      // (wide: only where the locked words' last 2+ are found, else as before)
      let at = alignAfter(w, A.locked, false);
      if (wide) { const W = alignAfter(w, A.locked, true); if (W >= 0 && (at < 0 || W > at)) { const k = Math.min(2, A.locked.length); let sc = 0; for (let i = 1; i <= k; i++) if (w[W - i] && (w[W - i] === A.locked[A.locked.length - i] || E.sim(w[W - i], A.locked[A.locked.length - i]) >= 0.7)) sc++; if (sc === k) at = W; } }
      return w.slice(at >= 0 ? at : Math.min(A.locked.length, w.length)).join(' ');
    },
    // ms to read L seconds of audio on this device
    cost(L) { const b = this.perSec.length ? this.perSec.slice().sort((x, y) => x - y)[this.perSec.length >> 1] : 110; return this.costA + b * L; },
    // Fast device: re-read the phrase every moment (smooth live tracking). Slow device (most phones): that
    // would fall further and further behind, so each stretch of audio is read once, in chunks cut at the
    // gaps between words, long enough that the device keeps up (the delay then stays the same).
    // (live re-reading keeps up while reading 7 s of audio takes under ~70% of those 7 s)
    slowDevice() { return this.slowCached; },
    updateSpeed() { this.slowCached = this.cost(7) > SLOW_MS; this.chunkCached = this.computeChunk(); },
    chunkSecs() { return this.chunkCached || 7; },
    computeChunk() {
      if (!this.slowCached) return 7;
      const b = this.perSec.length ? this.perSec.slice().sort((x, y) => x - y)[this.perSec.length >> 1] / 1000 : 0.11;
      const L = (this.costA / 1000) / Math.max(0.15, 0.75 - b);   // a + b*L <= 0.75*L
      return Math.min(7, Math.max(2.5, L));
    },
    showSpeed() {
      const el = $('asrSpeed'); if (!el || !this.ms.length) return;
      const avg = this.ms.reduce((a, b) => a + b, 0) / this.ms.length;
      el.textContent = (this.remote ? 'Sabaq speech server: ' : 'Speech model on this device: ') + (avg / 1000).toFixed(1) + ' s per reading' + (this.remote ? '' : this.threads > 1 ? ' (' + this.threads + ' threads)' : ' (1 thread)')
        + (this.slowDevice() ? '; reading in ' + this.chunkSecs().toFixed(1) + ' s chunks to keep up' : '; live reading') + ' (7 s of recitation: ' + (this.cost(7) / 1000).toFixed(1) + ' s).';
    },
    // A phrase's words, in order. In teacher mode, a result that would stop the reciter is checked first:
    // the same audio is transcribed again, shifted by half a second of silence. The small model sometimes
    // garbles a word once (تفاوت -> "تفاق"); a real slip (الجنوب) is heard the same way both times.
    // Only when both readings show the mistake does Sabaq stop.
    async judge(text, seg) {
      this.judging = seg;
      this.snapCur = null;
      if (T.stopped >= 0) this.snaps = [];
      try { await this.judgeNow(text, seg); } finally { this.judging = null; this.judgingText = null; if (this.snapCur) { (this.snaps = this.snaps || []).push(this.snapCur); if (this.snaps.length > 3) this.snaps.shift(); } if (this.suspectAt >= 0) { this.suspectAt = -1; render(false); } }
    },
    async judgeNow(text, seg) {
      this.judgedSeg = Math.max(this.judgedSeg, seg);
      this.pendingFinal.delete(seg);
      const midCut = this.cutMid.delete(seg);
      if (midCut) text = E.tokenize(text).slice(0, -1).join(' ');
      const full = E.tokenize(text);
      text = this.unlocked(text, seg);
      this.judgingText = text;
      // (what the tracker was before this phrase's judged words, to go back to if the next phrase needs it)
      this.snapCur = { seg, T: T.clone(), text, locked: this.agree.seg === seg ? this.agree.locked.slice() : [] };
      // (nothing new: still arm the end-of-phrase check, which judges a slip on the ayah's last word)
      if (!text.trim()) { commit('', true, true); return; }
      const stopsWith = t => { const C = T.clone(); const n0 = C.events.length; C.feed(E.tokenize(t)); C.flush(); return C.events.slice(n0).find(e => e.type === 'stop') || null; };
      const audioSeg = this.audioOf.get(seg);
      if (window.__asrLog) { const st0 = stopsWith(text); window.__asrLog.push({ kind: 'judge', seg, at: performance.now(), text: 'rest=[' + text + '] done=' + this.agree.done + ' prev=[' + this.agree.prev.join(' ') + '] T.c=' + (T.c >= 0 ? M.disp[T.c] : '-') + ' pendingQ=' + T.q.slice(T.qi).join(' ') + (st0 ? ' STOP@' + M.disp[st0.pos] + ' st=' + st0.state : '') }); } // dev-only
      const st1 = T.strict && audioSeg ? stopsWith(text) : null;
      if (!st1) { commit(text, true, true); return; }
      // On the speech server, live readings come from a different (faster) model than this final reading: if one
      // of them already flagged this very word, two independent models agree. Stop now, without a third reading.
      if (this.remote && this.models && this.models.live !== this.models.final && this.agree.seg === seg && this.agree.cutFor === st1.pos) {
        commit(text, true, true);
        if (!P) { clearTimeout(idleTimer); T.flush(); handleEvents(); render(); }
        return;
      }
      // the second reading also hears the end of the previous phrase: a different context makes the model
      // decode afresh (a garble caused by how the audio was cut, or by a fast join, is then not repeated)
      const prev = this.audioOf.get(seg - 1);
      // Word check (the way Tilawa checks a mistake): the fast model's own scores for this audio say how well the
      // CORRECT words fit it, next to what it wrote. The words around the suspected one must be found in the audio
      // in order. They fit about as well as its own reading: it garbled them, the reciter was right; no stop. They
      // fit far worse: the reciter said something else; stop now. In between: the second model reads it (below).
      // (measured on 1076 words by 4 qaris: correct words fit within 4 in 99.5%; a wrong, skipped or near-miss word
      // misses by 12 or more in 95-100%; see server/ctc-score.js)
      if (this.remote && this.canScore && audioSeg && st1.pos >= 0 && st1.pos < M.N) {
        // (runs of 3 with the word, to say it fits; both runs of 2 missing, to say it is a slip. A phrase of only one
        // or two words (a reciter who pauses after بلى) has no neighbours to check: there the word alone decides. In a
        // longer phrase the word alone could fit by chance somewhere else (يخلق in "خلق السماوات"), so it is not used)
        const p = st1.pos, R = [[p - 2, p], [p - 1, p + 1], [p - 1, p], [p, p + 1], [p, p]].map(([a, b]) => [Math.max(0, a), Math.min(M.N - 1, b)]);
        const t0 = performance.now();
        const costs = await this.verify(audioSeg, prev ? prev.subarray(Math.max(0, prev.length - 24000)) : null, 'score', R.map(([a, b]) => M.keys.slice(a, b + 1)));
        if (costs && costs.length === 5) {
          const short = full.length <= 2;
          const fit = Math.min(costs[0], costs[1], short ? costs[4] : Infinity), slip = Math.min(costs[2], costs[3], short ? costs[4] : Infinity), ms = Math.round(performance.now() - t0);
          const decided = fit <= SCORE_FIT ? 'fits' : slip >= SCORE_SLIP ? 'slip' : 'unsure';
          if (window.__asrLog) window.__asrLog.push({ kind: 'judge', seg, at: performance.now(), text: 'word check at ' + M.disp[p] + ': fit ' + fit + ' slip ' + slip + ' -> ' + decided + ' (' + ms + ' ms)' }); // dev-only
          report('check', { word: M.disp[p], at: where(p), fit, slip, decided, ms, wps: +wordsPerSec().toFixed(2) });
          if (decided === 'slip') {
            commit(text, true, true);
            if (!P) { clearTimeout(idleTimer); T.flush(); handleEvents(); render(); }
            return;
          }
          if (decided === 'fits') {
            const strict = T.strict; T.strict = false;
            try { commit(text, true, true); T.flush(); } finally { T.strict = strict; }
            // (the words of the run that fit were said: whatever the reading made of them)
            const [a, b] = costs[0] === fit ? R[0] : costs[1] === fit ? R[1] : R[4];
            for (let x = a; x <= b; x++) if (T.state[x] !== CORRECT && T.state[x] !== PENDING && (x >= p || T.state[x] !== UNCLEAR)) T._mark(x, CORRECT);
            handleEvents(); render();
            return;
          }
        }
      }
      // (Whisper can get stuck repeating a phrase, or time out: a broken second reading confirms nothing. Then the
      // fast model reads the same audio again, with the end of the previous phrase in front: a different decoding)
      // (a repeated run of 3+ words, e.g. "اليك البصوخاس ان ينقضني اليك البصوخاس ان", is Whisper looping too)
      const broken = t => { const w = E.tokenize(t || ''); if (!w.length || (w.length > 6 && new Set(w).size <= w.length / 3)) return true;
        const seen = new Set(); for (let i = 0; i + 3 <= w.length; i++) { const g = w.slice(i, i + 3).join(' '); if (seen.has(g)) return true; seen.add(g); } return false; };
      const read2 = async (audio, ctx) => {
        let a = await this.verify(audio, ctx);
        if (broken(a) && this.remote && this.models && this.models.verify && this.models.verify !== this.models.live) {
          if (window.__asrLog) window.__asrLog.push({ kind: 'judge', seg, at: performance.now(), text: 'second reading broken, reading again with the fast model' }); // dev-only
          a = await this.verify(audio, ctx, 'verifyc');
        }
        if (window.__asrLog) window.__asrLog.push({ kind: 'verify', seg, text: a, at: performance.now() }); // dev-only test log
        return a;
      };
      let altRest = null;
      // The suspected word may belong to the PREVIOUS phrase: fast recitation cuts phrases between any two words, so
      // a word can end up alone in a 0.3 s phrase and be misheard there, and the tracker only judges a word once it
      // hears the words after it, which arrive in this phrase. Checking only this phrase's audio would then confirm
      // nothing. So the tracker goes back to where the previous phrase began (nothing was shown as a mistake since),
      // the double-check reads both phrases' audio together, and both phrases are judged again from both readings.
      // (the latest earlier phrase that began before the suspected word (the word at the cursor when a phrase began may
      // have been said at the end of the phrase before it), up to 3 phrases and 14 s back; a phrase
      // in between may have been only a breath or a cough)
      const snaps = this.snaps || [];
      let k = snaps.length - 1;
      while (k >= 0 && !(snaps[k].T.c <= st1.pos)) k--;
      const S = k >= 0 ? snaps[k] : null;
      let span = null;
      if (S && S.T.c > 0 && T.stopped < 0) {
        span = [];
        for (let g = S.from != null ? S.from : S.seg; g <= seg; g++) { const a = this.audioOf.get(g); if (a) span.push(a); else if (g === S.seg || g === seg) { span = null; break; } }
        if (span && span.reduce((n, a) => n + a.length, 0) > 16000 * 14) span = null;
      }
      if (span) {
        clearTimeout(idleTimer);
        const both = new Float32Array(span.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of span) { both.set(a, o); o += a.length; }
        const pp = this.audioOf.get((S.from != null ? S.from : S.seg) - 1);
        const alt2 = await read2(both, pp ? pp.subarray(Math.max(0, pp.length - 24000)) : null);
        let w2 = E.tokenize(alt2 || '');
        if (midCut) w2 = w2.slice(0, -1);
        // (that reading also has the words already tracked before the previous phrase's judged part, and maybe the
        // context's: it is cut after the Quran's own words just before that point)
        let at = alignAfter(w2, M.keys.slice(Math.max(0, S.T.c - 3), S.T.c), true);
        // (or where the words that come next start: Whisper sometimes leaves out the first word of what it hears)
        for (let i = 0; at < 0 && i < Math.min(3, w2.length); i++) for (let d = 0; d < 3 && S.T.c + d < M.N; d++) if (E.sim(w2[i], M.keys[S.T.c + d]) >= (d ? 0.84 : 0.7)) { at = i; break; }
        if (at >= 0 && !broken(alt2)) {
          const strict = T.strict;
          T = S.T.clone(); T.strict = strict; P = null;
          const said = [...E.tokenize(S.text)];
          for (const q of snaps.slice(k + 1)) said.push(...q.locked, ...E.tokenize(q.text));
          text = [...said, ...this.snapCur.locked, ...E.tokenize(text)].join(' ');
          altRest = w2.slice(at).join(' ');
          // (these phrases are now one: going back again later starts where they began)
          this.snapCur = { seg, from: S.from != null ? S.from : S.seg, T: S.T.clone(), text, locked: [] };
          if (window.__asrLog) window.__asrLog.push({ kind: 'judge', seg, at: performance.now(), text: 'went back ' + (seg - S.seg) + ' phrase(s): first [' + text + '] second [' + altRest + ']' }); // dev-only
        }
      }
      if (altRest == null) {
        const ctxAudio = prev ? prev.subarray(Math.max(0, prev.length - 24000)) : null;
        const alt = await read2(audioSeg, ctxAudio);
        // drop the words of that context: the second reading starts where this phrase's first word is found
        let altW = alt ? E.tokenize(alt) : [];
        if (midCut) altW = altW.slice(0, -1);
        if (prev && full.length) { const i = altW.indexOf(full[0]); if (i > 0 && i <= 6) altW = altW.slice(i); }
        altRest = altW.length ? this.unlocked(altW.join(' '), seg, !!prev) : '';
      }
      // The second reading, by a different model, hears no mistake at all (and as many words): the first reading was
      // garbled as a whole (fast recitation can turn "وهو حسير ولقد زينا" into "بسم الله الرحمن الرحيم"), and
      // mending it word by word would keep its garbage. No stop: a stop needs both readings to hear the mistake.
      const altN = E.tokenize(altRest).length;
      const fitsAll = t => { const C = T.clone(); const n0 = C.events.length; C.feed(E.tokenize(t)); C.flush(); return !C.events.slice(n0).some(e => /^(stop|mistake|relocated)$/.test(e.type)) && C.stats.extras === T.stats.extras && C.lost.length <= T.lost.length; };
      { const w = E.tokenize(altRest);
        if (w.length > 2 && T.c >= 0 && !fitsAll(altRest) && !(E.sim(w[0], M.keys[T.c]) >= 0.5) && fitsAll(w.slice(1).join(' '))) altRest = w.slice(1).join(' '); }
      if (altN && altN >= E.tokenize(text).length - 1 && fitsAll(altRest)) {
        if (window.__asrLog) window.__asrLog.push({ kind: 'judge', seg, at: performance.now(), text: 'second reading clean: [' + altRest + ']' }); // dev-only
        commit(altRest, true, true); return;
      }
      // Consensus of the two readings: wherever they differ, keep the word that fits the text. A mistake
      // is then left only where both readings heard it (a real slip); a word garbled in one reading only
      // (each reading tends to garble a different word) is not one.
      const merged = altRest.trim() ? consensus(E.tokenize(text), E.tokenize(altRest)).join(' ') : text;
      if (window.__asrLog) window.__asrLog.push({ kind: 'judge', seg, at: performance.now(), text: 'consensus=[' + merged + ']' }); // dev-only
      const stM = stopsWith(merged);
      if (!stM) { commit(merged, true, true); return; }
      // Both readings can miss a word yet disagree about what was said there (one hears nothing, the other another
      // word; or two unrelated words): that word's audio is unclear, not a slip. A real slip sounds the same to both:
      // a skipped word is missing from both, a wrong word is heard alike. Then no stop: the word is marked "not
      // clearly heard" (not counted as a mistake) and the reciter is followed on. (A phone mic, a reciter's own
      // voice and joined words (idgham, a dropped hamzat al-wasl) garble words at any pace, not only when fast.)
      if (altRest.trim()) {
        const at = t => { const C = T.clone(); C.feed(E.tokenize(t)); C.flush(); const st = C.events.find(e => e.type === 'stop');
          return !st || st.pos > stM.pos ? 'ok' : st.pos < stM.pos ? null : C.heard.has(stM.pos) ? C.heard.get(stM.pos).replace(/ /g, '') : ''; };
        const h1 = at(text), h2 = at(altRest);
        const alike = (h1 === '' && h2 === '') || (h1 && h2 && h1 !== 'ok' && h2 !== 'ok' && E.sim(h1, h2) >= 0.6);
        // (one reading clearly heard a different word of the Quran there, e.g. أمره for يخلق; the other ran it into the
        // word before: that is a slip, not unclear audio)
        const realWord = h => !!h && h !== 'ok' && h.length >= 3 && M.keySet.has(h) && E.sim(h, M.keys[stM.pos]) < 0.5;
        if (realWord(h1) || realWord(h2)) { /* a real other word: stop as before */ } else
        if (h1 != null && h2 != null && !alike) {
          if (window.__asrLog) window.__asrLog.push({ kind: 'judge', seg, at: performance.now(), text: 'readings disagree at ' + M.disp[stM.pos] + ' [' + h1 + '] [' + h2 + ']: not clearly heard, no stop' }); // dev-only
          report('unclear', { word: M.disp[stM.pos], at: where(stM.pos), h1, h2, wps: +wordsPerSec().toFixed(2) });
          const strict = T.strict; T.strict = false;
          try { commit(merged, true, true); T.flush(); } finally { T.strict = strict; }
          if (T.state[stM.pos] !== CORRECT) T._mark(stM.pos, UNCLEAR);
          handleEvents(); render();
          return;
        }
      }
      // both readings show the mistake: stop now (the reciter has paused; no need to wait for more words)
      commit(merged, true, true);
      if (!P) { clearTimeout(idleTimer); T.flush(); handleEvents(); render(); }
    },
    verify(audioSeg, before, kind = 'verify', windows) {
      return new Promise(res => {
        const lead = before ? before.length : 8000;
        const pad = new Float32Array(lead + audioSeg.length + 4800);
        if (before) pad.set(before, 0);
        pad.set(audioSeg, lead);
        const timer = setTimeout(() => { if (this.verifyWait === done) this.verifyWait = null; res(null); }, 25000);
        const done = t => { clearTimeout(timer); res(t); };
        this.verifyWait = done;
        this.finals.unshift({ kind, seg: -1, audio: pad, windows }); // before any later phrase
        this.pump();
      });
    },
    twoLanes() { return !!(this.remote && this.lanes >= 2); },
    streaming() { return !!(this.remote && this.ready && this.srvStream >= 3 && this.worker && this.worker.sendChunk); },
    maxP() { return this.srvStream >= 2 ? 2 : 1; },
    pump() {
      if (!this.ready || !this.worker) return;
      if (this.twoLanes()) {
        // the server reads a final reading and a live reading side by side
        if (!this.busyF && this.finals.length) {
          const job = this.finals.shift(); this.busyF = true; this.busyKind = job.kind; this.inflightF = job; renderStatus();
          this.worker.postMessage({ type: 'run', kind: job.kind, seg: job.seg, audio: job.audio, windows: job.windows });
        }
        if (!this.busyP && this.partial) {
          const job = this.partial; this.partial = null; this.partialWhole = !!job.whole;
          this.inflightP++; this.busyP = this.inflightP >= this.maxP();
          this.worker.postMessage({ type: 'run', kind: job.kind, seg: job.seg, audio: job.audio, whole: job.whole, cap: job.cap });
        }
        this.busy = this.busyF || this.busyP;
        return;
      }
      if (this.busy) return;
      const job = this.finals.shift() || this.partial;
      if (job === this.partial) { this.partial = null; this.partialWhole = !!job.whole; }
      if (!job) return;
      this.busy = true; this.busyKind = job.kind;
      if (job.kind !== 'partial') { renderStatus(); if (this.remote) this.inflightF = job; }
      this.worker.postMessage({ type: 'run', kind: job.kind, seg: job.seg, audio: job.audio }, [job.audio.buffer]);
    },
  };

  document.addEventListener('visibilitychange', () => ModelMic.onVisibility());
  window.addEventListener('pagehide', () => { if (ModelMic.on) ModelMic.stop(); });

  // ?debug=1: the timing marks on screen, once a second
  if (Diag.on) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));z-index:99;font:11px/1.35 ui-monospace,monospace;background:var(--paper,#fff);color:var(--ink,#000);opacity:.88;padding:4px 6px;border-radius:6px;pointer-events:none;white-space:pre';
    document.body.append(box);
    setInterval(() => { const s = Diag.summary(); box.textContent = 'live readings ' + s.n + ' (median/p90 ms)\nround trip ' + s.e2e + '  model ' + s.ms + '\nserver wait ' + s.wait + '  net ' + s.net + '\nalign ' + s.align + '  drawn ' + s.paint + '\npace ' + wordsPerSec().toFixed(1) + ' words/s' + (wordsPerSec() >= FAST_WPS ? ' (fast)' : '') + '\nmic ' + (ModelMic.capture || '-') + ' ' + (ModelMic.rate || '-') + ' Hz' + (ModelMic.remote ? ' · server' : ' · on phone'); }, 1000);
  }

  // Inside claude.ai, phones (and browsers without Claude dictation) can't use the microphone: say where it works.
  function showSiteNote() { if (IN_CLAUDE) $('siteNote').hidden = false; }
  if (IN_CLAUDE && (IS_IOS || /Android/i.test(navigator.userAgent))) showSiteNote();
  if (IN_CLAUDE) setTimeout(() => { if (!Input.dict) showSiteNote(); }, 11000); // claude.use answers within 10 s

  // On the website, start downloading the speech model right away where it will be used (cached after once)
  if (!IN_CLAUDE && chooseKind() === 'model') asrServerReady.then(() => setTimeout(() => ModelMic.init(), 300));

  // recogniser choice (type dialog)
  function syncRecSel() { const s = $('recSel'); if (s) s.value = store.get('recognizer2', 'auto'); }
  $('recSel').addEventListener('change', e => { store.set('recognizer2', e.target.value); toast('Speech recognition: ' + e.target.selectedOptions[0].textContent); });
  if (!MODEL_OK) $('recSel').querySelector('option[value="model"]').disabled = true;
  syncRecSel();

  // ---------------------------------------------------------------- simulated recitation
  // phrases: arrays of words; each word is "heard" in turn, a phrase settles at its end, like real speech.
  // items: arrays of words, or {w: [...], pause: ms} to pause after the phrase (e.g. to react to a stop)
  function playPhrases(items, gap = 260) {
    if (Input.state !== 'idle' && !Input.sim) stopListening();
    stopSim();
    const token = {};
    Input.sim = token;
    setMic('listening');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    (async () => {
      for (const it of items) {
        const ph = Array.isArray(it) ? it : it.w;
        for (let i = 1; i <= ph.length; i++) {
          await sleep(gap);
          if (Input.sim !== token) return;
          if (i < ph.length) preview(ph.slice(0, i).join(' '));
          else commit(ph.join(' '));
        }
        if (it.pause) { await sleep(it.pause); if (Input.sim !== token) return; }
        // wait while the reciter stays silent (3 s), the qari says the word, and the mic opens again
        if (it.afterQari && T.strict) {
          for (let w = 0; w < 25 && T.stopped < 0 && Input.sim === token; w++) await sleep(100); // a slip at the end of an ayah is judged after a pause
          while (T.stopped >= 0 && !Coach.played && Input.sim === token) await sleep(100);
          await sleep(300); await Qari.quiet(); await sleep(250); if (Input.sim !== token) return;
        }
      }
      if (Input.sim === token) stopSim();
    })();
  }
  function stopSim() {
    if (!Input.sim) return;
    Input.sim = null;
    setMic('idle'); settle();
  }
  function clean(s, a) { return window.QURAN[s - 1].a[a - 1][1].replace(/_/g, ' ').split(' '); }
  function playBuruj() {
    closeAll();
    T = new E.Tracker(M); P = null; phraseSkip = 0; Coach.reset();
    T.strict = teachBtn.getAttribute('aria-pressed') === 'true';
    lastVis && lastVis.fill(-1);
    const a = n => clean(85, n);
    const slip = a(17).slice(); slip[slip.length - 1] = 'الجنوب';   // جنوب instead of جنود
    playPhrases([a(12), a(13), a(14), a(15), a(16), { w: slip, afterQari: true }, ['الجنود'], a(18), a(19)]);
    toast('Al-Buruj: listen for the qari after "الجنوب"', 3200);
  }
  function playDemo() {
    closeAll();
    T = new E.Tracker(M); P = null; phraseSkip = 0; Coach.reset();
    T.strict = teachBtn.getAttribute('aria-pressed') === 'true';
    lastVis && lastVis.fill(-1);
    const a1 = clean(67, 1), a2 = clean(67, 2), a3 = clean(67, 3), a4 = clean(67, 4), a5 = clean(67, 5);
    const k = a1.indexOf('كل');
    const skip = a1.filter((w, i) => i !== k);                               // "...wa huwa 'ala shay'in qadir": kulli skipped
    const slip = a3.slice(); slip[slip.length - 1] = 'قطور';                 // close to فطور: a "check", not a stop
    const wrong = a4.slice(); wrong[wrong.length - 1] = 'عليم';              // a different word: a stop
    playPhrases([
      ['أعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم'],
      ['بسم', 'الله', 'الرحمن', 'الرحيم'],
      { w: skip, pause: 1700 },                                                // stopped: finds the word within 3 s, no qari
      a1.slice(k - 2),                                                         // goes back: "wa huwa 'ala kulli shay'in qadir"
      a2.slice(0, 4),                                                          // stops mid-ayah...
      a2,                                                                      // ...and restarts it: forgiven
      ...(T.strict ? [a3.slice(0, 8), a3.slice(8)] : [slip.slice(0, 8), slip.slice(8)]), // (outside teacher mode: a "check")
      { w: wrong, afterQari: true },                                           // a different word, then silence: the qari says it
      a4.slice(-2),                                                            // repeats "wa huwa hasir" and carries on
      a5.slice(0, 6),
    ]);
    toast('Demo: a student reciting Al-Mulk from memory', 3200);
  }

  // ---------------------------------------------------------------- dialogs
  function closeAll() { document.querySelectorAll('dialog[open]').forEach(d => d.close()); }
  document.querySelectorAll('dialog').forEach(d => {
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  });
  function openType() { closeAll(); $('typeDlg').showModal(); }

  // surah picker
  function buildSurahList(filter) {
    const f = (filter || '').trim().toLowerCase();
    const list = $('surahList');
    const frag = document.createDocumentFragment();
    if (!f) {
      const any = document.createElement('button');
      any.type = 'button'; any.className = 'srow anywhere';
      any.innerHTML = '<span class="n">∞</span><span class="nm"><b>Recite from anywhere</b><small>Start reciting any surah, from any ayah. Sabaq finds you.</small></span>';
      any.addEventListener('click', () => { T.unlock(); P = null; closeAll(); render(false); toast('Start reciting anywhere'); });
      frag.append(any);
    }
    const fnorm = E.norm(f);
    for (const su of M.surahs) {
      if (f && !(String(su.n) === f || su.en.toLowerCase().includes(f) || su.tr.toLowerCase().includes(f) || (fnorm && E.norm(su.ar).includes(fnorm)))) continue;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'srow';
      if (su.n - 1 === shown) b.setAttribute('aria-current', 'true');
      b.innerHTML = `<span class="n">${su.n}</span><span class="nm"><b></b><small></small></span><span class="ar" lang="ar"></span>`;
      b.querySelector('b').textContent = su.en;
      b.querySelector('small').textContent = `${su.tr} · ${su.ayahs} ayahs`;
      b.querySelector('.ar').textContent = su.ar;
      b.addEventListener('click', () => {
        closeAll();
        T.setPosition(su.start); P = null;
        buildSurah(su.n - 1); render(false);
        toast('Starting at ayah 1. Tap any word to start from it.');
      });
      frag.append(b);
    }
    list.replaceChildren(frag);
  }
  $('surahBtn').addEventListener('click', () => {
    closeAll(); $('surahSearch').value = ''; buildSurahList('');
    $('surahDlg').showModal();
    const cur = $('surahList').querySelector('[aria-current="true"]');
    if (cur) cur.scrollIntoView({ block: 'center' });
  });
  $('surahSearch').addEventListener('input', e => buildSurahList(e.target.value));

  // word detail
  const STATE_INFO = {
    [PENDING]: ['Not recited yet', '', 'Tap "Start here" to begin reciting from this word.'],
    [CORRECT]: ['Recited', 'ok', 'Recited correctly.'],
    [CLOSE]: ['Check', 'check', 'What was heard is close to this word, so it is not counted as a mistake. It may be a pronunciation slip or the recognizer. Worth a listen.'],
    [UNCLEAR]: ['Not clearly heard', '', 'The recognizer did not catch this word. Speech recognition often drops short words, so it is not counted as a mistake.'],
    [WRONG]: ['Wrong word', 'miss', 'A different word was said here.'],
    [MISSED]: ['Skipped', 'miss', 'This word was skipped.'],
  };
  function openWord(p) {
    const st = T.state[p], w = M.where(p);
    const info = st === CORRECT && T.fixed.has(p) ? ['Fixed', 'ok', 'A mistake here (missed or wrong at first), then recited correctly.']
      : T.flagged.has(p) && st !== CORRECT && st !== WRONG && st !== MISSED ? ['Needed help', 'miss', 'You were stopped on this word and the qari recited it for you.'] : STATE_INFO[st];
    $('wordDlgTitle').textContent = `${M.surahs[w.surah - 1].en} · ayah ${w.ayah}`;
    const body = $('wordBody');
    body.replaceChildren();
    const big = document.createElement('div'); big.className = 'word-big'; big.lang = 'ar'; big.textContent = M.disp[p];
    const pill = document.createElement('span'); pill.className = 'pill ' + info[1]; pill.textContent = info[0];
    const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = info[2];
    body.append(big, pill);
    const heard = T.heard.get(p);
    if (heard && st !== CORRECT && st !== PENDING) {
      const h = document.createElement('p'); h.className = 'hint';
      h.append('Heard: ');
      const hs = document.createElement('span'); hs.className = 'heard'; hs.lang = 'ar'; hs.dir = 'rtl'; hs.textContent = heard;
      h.append(hs);
      body.append(h);
    }
    body.append(hint);
    const foot = $('wordFoot');
    foot.replaceChildren();
    if (st === CLOSE || st === WRONG || st === MISSED || st === UNCLEAR) {
      const ok = document.createElement('button'); ok.className = 'btn'; ok.type = 'button'; ok.textContent = 'I said it right';
      ok.addEventListener('click', () => { T.state[p] = CORRECT; T.heard.delete(p); closeAll(); render(false); toast('Marked as recited'); });
      foot.append(ok);
    }
    const hear = document.createElement('button'); hear.className = 'btn'; hear.type = 'button'; hear.textContent = 'Listen';
    hear.addEventListener('click', () => { audio(); Qari.play(p); });
    foot.append(hear);
    const go = document.createElement('button'); go.className = 'btn primary'; go.type = 'button'; go.textContent = 'Start here';
    go.addEventListener('click', () => { T.setPosition(p); P = null; phraseSkip = 0; closeAll(); render(false); toast('Recite from ' + where(p)); });
    foot.append(go);
    closeAll();
    $('wordDlg').showModal();
  }
  quranEl.addEventListener('click', e => {
    const sp = e.target.closest('.w');
    if (sp) openWord(+sp.dataset.p);
  });

  // summary
  function openSummary() {
    const s = counts();
    const judged = s.ok + s.close + s.wrong + s.missed;
    const body = $('sumBody');
    body.replaceChildren();
    if (!judged && !s.unclear) {
      const p = document.createElement('p'); p.className = 'hint';
      p.textContent = 'Nothing recited yet. Tap the mic and start reciting, or watch the demo.';
      body.append(p);
    } else {
      const acc = judged ? Math.round((s.ok + s.close) / judged * 100) : 100;
      const score = document.createElement('div'); score.className = 'score';
      score.innerHTML = '<div><b></b><small>accuracy</small></div><div><b></b><small>mistakes</small></div><div><b></b><small>to check</small></div>';
      const bs = score.querySelectorAll('b');
      bs[0].textContent = acc + '%'; bs[1].textContent = s.wrong + s.missed; bs[2].textContent = s.close;
      const facts = document.createElement('div'); facts.className = 'facts';
      const fact = (n, label) => { const sp = document.createElement('span'); const b = document.createElement('b'); b.textContent = n; sp.append(b, ' ' + label); facts.append(sp); };
      fact(s.ok + s.close + s.unclear, 'words recited');
      fact(T.stats.restarts, T.stats.restarts === 1 ? 'repeat or restart, not counted against you' : 'repeats or restarts, not counted against you');
      if (T.fixed.size) fact(T.fixed.size, T.fixed.size === 1 ? 'mistake fixed after a stop or self-correction' : 'mistakes fixed after a stop or self-correction');
      else if (T.stats.selfCorrected) fact(T.stats.selfCorrected, T.stats.selfCorrected === 1 ? 'mistake you corrected yourself' : 'mistakes you corrected yourself');
      if (s.unclear) fact(s.unclear, s.unclear === 1 ? 'word the recognizer did not catch, not counted' : 'words the recognizer did not catch, not counted');
      body.append(score, facts);
      const rows = [];
      for (let p = 0; p < T.state.length; p++) if (T.state[p] === WRONG || T.state[p] === MISSED || T.state[p] === CLOSE || (T.flagged.has(p) && T.state[p] !== CORRECT)) rows.push(p);
      if (rows.length) {
        const lab = document.createElement('div'); lab.className = 'section-label'; lab.textContent = 'Review';
        const list = document.createElement('div'); list.className = 'mlist';
        for (const p of rows.slice(0, 60)) {
          const w = M.where(p), st = T.state[p], info = T.flagged.has(p) && st !== WRONG && st !== MISSED && st !== CLOSE ? ['Needed help', 'miss'] : STATE_INFO[st];
          const b = document.createElement('button'); b.type = 'button'; b.className = 'mrow';
          b.innerHTML = '<span class="ref"></span><span class="wd" lang="ar"></span><span class="pill"></span>';
          b.querySelector('.ref').textContent = w.surah + ':' + w.ayah;
          const wd = b.querySelector('.wd'); wd.textContent = M.disp[p];
          const heard = T.heard.get(p);
          if (heard) { const sm = document.createElement('small'); sm.textContent = 'heard ' + heard; wd.append(sm); }
          const pill = b.querySelector('.pill'); pill.className = 'pill ' + info[1]; pill.textContent = info[0];
          b.addEventListener('click', () => { closeAll(); if (M.sOf[p] !== shown) buildSurah(M.sOf[p]); render(false); spans[p - M.surahs[shown].start].scrollIntoView({ block: 'center' }); openWord(p); });
          list.append(b);
        }
        body.append(lab, list);
      }
    }
    closeAll();
    $('sumDlg').showModal();
  }
  $('resetBtn').addEventListener('click', () => {
    const at = T.c;
    const strict = T.strict;
    T = new E.Tracker(M); P = null; phraseSkip = 0; Coach.reset(); T.strict = strict;
    if (at >= 0 && shown >= 0) T.setPosition(M.surahs[shown].start);
    closeAll(); render(false); main.scrollTop = 0;
    toast('Cleared. Ready to start again.');
  });

  // ---------------------------------------------------------------- controls
  $('micBtn').addEventListener('click', () => { if (Input.state === 'idle') startListening(); else stopListening(); audio(); });
  $('finishBtn').addEventListener('click', () => {
    if (Input.state !== 'idle') stopListening();
    settle();
    openSummary();
  });
  $('typeBtn').addEventListener('click', openType);
  $('demoBtn').addEventListener('click', () => { audio(); playDemo(); });
  $('burujBtn').addEventListener('click', () => { audio(); playBuruj(); });
  $('simGo').addEventListener('click', () => {
    const words = $('simText').value.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { $('simText').focus(); return; }
    closeAll();
    const phrases = [];
    for (let i = 0; i < words.length; i += 5) phrases.push(words.slice(i, i + 5));
    playPhrases(phrases, 220);
  });
  const teachBtn = $('teachBtn');
  function setTeacher(on) {
    teachBtn.setAttribute('aria-pressed', String(on));
    T.strict = on;
    if (!on) T.stopped = -1;
    store.set('teacher', on);
    if (shown >= 0) render(false);
  }
  teachBtn.addEventListener('click', () => {
    audio();
    const on = teachBtn.getAttribute('aria-pressed') !== 'true';
    setTeacher(on);
    toast(on ? 'Teacher mode: Sabaq stops you with a sound at each mistake' : 'Teacher mode off: mistakes are marked, you keep going', 3200);
  });
  const memBtn = $('memBtn');
  function setMemorize(on) {
    memBtn.setAttribute('aria-pressed', String(on));
    quranEl.classList.toggle('memorize', on);
    store.set('memorize', on);
  }
  memBtn.addEventListener('click', () => {
    const on = memBtn.getAttribute('aria-pressed') !== 'true';
    setMemorize(on);
    toast(on ? 'Memorization mode: words appear as you recite them' : 'Showing the full text');
  });
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || e.repeat || document.querySelector('dialog[open]')) return;
    if (e.target.closest && e.target.closest('input, textarea, button')) return;
    e.preventDefault();
    if (Input.state === 'idle') startListening(); else stopListening();
  });

  // iPhone: when the keyboard opens (keyboard dictation), fit the app into the space above it
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fit = () => {
      const covered = window.innerHeight - vv.height > 120;
      if (covered) { document.documentElement.style.setProperty('--app-h', vv.height + 'px'); window.scrollTo(0, 0); }
      else document.documentElement.style.removeProperty('--app-h');
    };
    vv.addEventListener('resize', fit);
  }

  // ---------------------------------------------------------------- start
  const startSurah = Math.min(114, Math.max(1, +store.get('surah', 67) || 67));
  setMemorize(!!store.get('memorize', false));
  setTeacher(store.get('teacher', true) !== false);
  buildSurah(startSurah - 1);
  render(false);
})();
