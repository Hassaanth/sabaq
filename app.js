/* Sabaq app: UI, speech input, rendering. The tracking logic lives in engine.js. */
(() => {
  'use strict';
  const E = window.SabaqEngine;
  const M = new E.Mushaf(window.QURAN);
  const { PENDING, CORRECT, CLOSE, UNCLEAR, WRONG, MISSED } = E;
  const TENTATIVE = 6;

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
    for (let p = su.start; p < su.end; p++) {
      const sp = document.createElement('span');
      sp.className = 'w s0';
      sp.dataset.p = p;
      sp.textContent = M.disp[p];
      spans[p - su.start] = sp;
      frag.append(sp, ' ');
      if (p + 1 === su.end || M.ayahStart[p + 1]) {
        const a = document.createElement('span');
        a.className = 'aya';
        a.textContent = '۝' + toAr(M.aOf[p]);
        a.setAttribute('aria-label', 'ayah ' + M.aOf[p]);
        frag.append(a, ' ');
      }
    }
    quranEl.replaceChildren(frag);
    lastVis = new Int8Array(su.end - su.start).fill(-1);
    curSpan = null; lastCursor = -2;
    main.scrollTop = 0;
    store.set('surah', su.n);
    Qari.preload(su.n);
  }

  function visual(view, p) {
    const s = view.state[p];
    let v;
    if (view === T) v = s;
    else if (T.state[p] !== PENDING) v = T.state[p];
    else v = s === PENDING ? PENDING : TENTATIVE; // preview words are not settled: show progress, never a mistake
    if (v === CORRECT && T.fixed.has(p)) v += 10;
    if (p === T.stopped) v += 20;
    return v;
  }
  function classFor(v) {
    return 'w s' + (v % 10) + (v >= 20 ? ' stopw' : v >= 10 ? ' fx' : '');
  }

  function anchorOf(view) {
    let c = view.c;
    if (c < 0) return -1;
    if (c >= M.N || (shown >= 0 && c === M.surahs[shown].end && view.state[c] === PENDING)) c--;
    return c;
  }

  function render(follow = true) {
    const view = P || T;
    const a = anchorOf(view);
    if (a >= 0 && M.sOf[a] !== shown) buildSurah(M.sOf[a]);
    const su = M.surahs[shown];
    for (let p = su.start; p < su.end; p++) {
      const v = visual(view, p), i = p - su.start;
      if (lastVis[i] !== v) { lastVis[i] = v; spans[i].className = classFor(v); }
    }
    if (curSpan) curSpan.classList.remove('cur');
    curSpan = null;
    const c = view.c;
    if (c >= su.start && c < su.end) { curSpan = spans[c - su.start]; curSpan.classList.add('cur'); }
    if (follow && curSpan && c !== lastCursor) followCursor();
    lastCursor = c;
    renderTally();
    renderStatus();
  }

  let userScrolledAt = 0;
  ['wheel', 'touchmove', 'keydown'].forEach(ev => main.addEventListener(ev, () => { userScrolledAt = Date.now(); }, { passive: true }));
  function followCursor() {
    if (Date.now() - userScrolledAt < 3500) return;
    const r = curSpan.getBoundingClientRect(), mr = main.getBoundingClientRect();
    const y = r.top - mr.top;
    if (y < mr.height * 0.18 || y > mr.height * 0.62) {
      main.scrollTo({ top: main.scrollTop + y - mr.height * 0.33, behavior: reduceMotion ? 'auto' : 'smooth' });
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
        tx.replaceChildren(document.createTextNode('Listen: '), w);
      } else {
        const again = document.createElement('button');
        again.className = 'link'; again.type = 'button'; again.textContent = 'Hear it again';
        again.addEventListener('click', () => { audio(); Qari.play(p); });
        const on = document.createElement('button');
        on.className = 'link'; on.type = 'button'; on.textContent = 'Move on';
        on.addEventListener('click', () => { T.moveOn(); P = null; phraseSkip = 0; handleEvents(); render(); });
        tx.replaceChildren(document.createTextNode('Your turn: say '), w, document.createTextNode(' or the whole ayah (' + at.surah + ':' + at.ayah + '). '), again, document.createTextNode(' · '), on);
      }
      return;
    }
    if (live && !locked) { st.dataset.live = 'finding'; tx.textContent = 'Listening. Keep reciting and Sabaq will find where you are.'; return; }
    if (live) { st.dataset.live = 'on'; tx.textContent = 'Following you · ' + where(Math.min(view.c, M.N - 1)); return; }
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
    packs: {}, cache: new Map(), speaking: -1, gateUntil: 0, source: null,
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
      const buf = await this.buffer(p);
      if (!buf || !a) { this.gateUntil = before; toast('No qari recording for this word in this demo.', 3000); return false; }
      if (this.source) { try { this.source.stop(); } catch (e) { /* ended */ } }
      const src = a.createBufferSource(), g = a.createGain();
      g.gain.value = 1;
      src.buffer = buf; src.connect(g).connect(a.destination);
      const startAt = a.currentTime + delayMs / 1000;
      src.start(startAt);
      this.source = src;
      this.gateUntil = Date.now() + delayMs + buf.duration * 1000 + 450;
      setTimeout(() => { this.speaking = p; render(false); }, delayMs);
      const done = () => { if (this.source === src) { this.source = null; this.speaking = -1; render(false); } };
      src.onended = done;
      // if the browser keeps audio muted (no tap yet, or blocked), "ended" may never come: end the listen state anyway
      setTimeout(done, delayMs + buf.duration * 1000 + 300);
      return true;
    },
    preload(surahNo) {
      const A = window.SABAQ_AUDIO;
      if (!A || !A.files[surahNo] || this.packs[surahNo]) return;
      this.packs[surahNo] = fetch(A.files[surahNo]).then(r => { if (!r.ok) throw new Error('pack ' + r.status); return r.arrayBuffer(); });
      this.packs[surahNo].catch(() => { delete this.packs[surahNo]; });
    },
    gated() { return Date.now() < this.gateUntil; },
    quiet() { return new Promise(res => { const tick = () => (this.gated() ? setTimeout(tick, 100) : res()); tick(); }); },
  };

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
        toast(e.state === MISSED ? 'Stop. A word was skipped. Listen, then say it.'
          : e.state === WRONG ? 'Stop. That is a different word. Listen, then say it.'
          : 'Stop. Not quite right. Listen, then say it.', 3200);
        Qari.play(e.pos, 520);
      }
      else if (e.type === 'moveOn') {
        toast((e.auto ? 'Moving on after 3 tries. ' : 'Moving on. ') + M.disp[e.pos] + ' is marked for review.', 3200);
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
  function commit(text, wholePhrase) {
    let words = E.tokenize(text);
    const k = Math.min(phraseSkip, words.length);
    if (Qari.gated()) words = [];  // the qari was speaking: that is not the reciter
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
  function preview(text) {
    if (E.tokenize(text).length) clearTimeout(idleTimer); // only real new speech postpones the end-of-phrase check
    if (Qari.gated()) { phraseSkip = Math.max(phraseSkip, E.tokenize(text).length); return; }
    const words = E.tokenize(text).slice(phraseSkip);
    if (!words.length) { if (P) { P = null; render(); } return; }
    P = T.clone();
    P.feed(words);
    if (T.strict && P.events.some(e => e.type === 'stop')) {
      // stop right now, on the live words, instead of waiting for the phrase to settle
      T = P; P = null; phraseSkip += words.length;
      handleEvents();
    }
    render();
  }
  function settle() { P = null; T.flush(); handleEvents(); render(); }

  // ---------------------------------------------------------------- speech input
  // 1) Claude dictation (when hosted on claude.ai)  2) the browser's own speech recognition  3) typing
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const Input = {
    dict: null, rec: null, kind: 'none', state: 'idle', want: false, fed: 0, sim: null,
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

  function startListening() {
    if (Input.sim) stopSim();
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
    if (Input.kind === 'webspeech') { startWebSpeech(); return; }
    toast('This browser has no speech recognition. Use Chrome or Safari, or type instead.', 5000);
    openType();
  }
  function stopListening() {
    if (Input.sim) { stopSim(); return; }
    if (Input.kind === 'dictation' && Input.dict) { Input.dict.stop().catch(() => {}); return; }
    if (Input.rec) { Input.want = false; try { Input.rec.stop(); } catch (e) { /* already stopped */ } }
  }

  function settlePending() {
    clearTimeout(Input.settleTimer);
    if (Input.pending && Input.pending.length) {
      const p = Input.pending;
      Input.fed += p.length; Input.pending = [];
      commit(p.join(' '));
    }
    // silence: judge whatever is still being weighed (e.g. the last word of an ayah)
    if (!P && T.qi < T.q.length) { T.flush(); handleEvents(); render(); }
  }
  // Browser speech recognition. Chrome on Android repeats earlier results inside later ones,
  // and every browser ends sessions on silence, so results are rebuilt and the session restarted.
  function startWebSpeech() {
    const rec = new SR();
    rec.lang = 'ar-SA';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    Input.rec = rec; Input.want = true; Input.fed = 0; Input.pending = [];
    rec.onstart = () => setMic('listening');
    // The whole session's transcript is rebuilt on every event (Android repeats earlier results inside
    // later ones). Everything except the last two words is treated as settled, because iPhone Safari
    // may not mark results final until it stops; the last two stay live (previewed) until settled.
    rec.onresult = e => {
      Input.heardAt = Date.now();
      const parts = [];
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.trim();
        if (!t) continue;
        if (parts.length && t.startsWith(parts[parts.length - 1])) parts[parts.length - 1] = t;
        else parts.push(t);
      }
      const words = E.tokenize(parts.join(' '));
      const last = e.results[e.results.length - 1];
      const settled = last && last.isFinal ? words.length : Math.max(0, words.length - 2);
      if (words.length < Input.fed) Input.fed = words.length; // the transcript was revised shorter
      if (settled > Input.fed) { commit(words.slice(Input.fed, settled).join(' ')); Input.fed = settled; }
      Input.pending = words.slice(Input.fed);
      preview(Input.pending.join(' '));
      // a short silence settles the last words too (and judges them), so a slip at the end of an ayah is caught
      clearTimeout(Input.settleTimer);
      Input.settleTimer = setTimeout(settlePending, 900);
    };
    rec.onerror = e => {
      if (e.error === 'service-not-allowed') {
        Input.want = false;
        toast(/iPhone|iPad/.test(navigator.userAgent)
          ? 'Speech recognition is off. On iPhone: Settings > General > Keyboard > turn on Enable Dictation, then try again.'
          : 'Speech recognition is blocked here. Open the Sabaq website directly, or type instead.', 7000);
      } else if (e.error === 'not-allowed') {
        Input.want = false;
        toast(/iPhone|iPad/.test(navigator.userAgent)
          ? 'Microphone blocked. On iPhone: Settings > Safari > Microphone > Allow, then reload.'
          : 'Microphone access was blocked. Allow it in the browser, or type instead.', 7000);
      } else if (e.error === 'language-not-supported') {
        Input.want = false;
        toast('This browser cannot recognise Arabic speech. Try Chrome, or type instead.', 5000);
      } else if (e.error === 'network') toast('Speech recognition needs an internet connection.', 4000);
    };
    rec.onend = () => {
      // the browser ends a session after silence: carry on with a new one (the words so far are settled)
      settlePending(); // the last words of the session were never settled: they are now
      if (Input.want) {
        Input.fed = 0;
        try { rec.start(); return; } catch (err) { toast('Listening paused. Tap the mic to keep going.', 4000); }
      }
      Input.rec = null; setMic('idle'); settle();
    };
    setMic('starting');
    try { rec.start(); } catch (err) { setMic('idle'); toast('Could not start the microphone.', 4000); }
  }

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
        if (it.afterQari) { await sleep(1300); await Qari.quiet(); await sleep(250); if (Input.sim !== token) return; }
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
    T = new E.Tracker(M); P = null; phraseSkip = 0;
    T.strict = teachBtn.getAttribute('aria-pressed') === 'true';
    lastVis && lastVis.fill(-1);
    const a = n => clean(85, n);
    const slip = a(17).slice(); slip[slip.length - 1] = 'الجنوب';   // جنوب instead of جنود
    playPhrases([a(12), a(13), a(14), a(15), a(16), { w: slip, afterQari: true }, ['الجنود'], a(18), a(19)]);
    toast('Al-Buruj: listen for the qari after "الجنوب"', 3200);
  }
  function playDemo() {
    closeAll();
    T = new E.Tracker(M); P = null; phraseSkip = 0;
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
      { w: skip, afterQari: true },
      a1.slice(k - 2),                                                         // goes back: "wa huwa 'ala kulli shay'in qadir"
      a2.slice(0, 4),                                                          // stops mid-ayah...
      a2,                                                                      // ...and restarts it: forgiven
      slip.slice(0, 8), slip.slice(8),
      wrong,
      { w: a5.slice(0, 2), afterQari: true },
      a4.slice(-2),                                                            // "wa huwa hasir"
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
    const info = st === CORRECT && T.fixed.has(p) ? ['Fixed', 'ok', 'This word was missed or wrong at first, then recited correctly.'] : STATE_INFO[st];
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
      for (let p = 0; p < T.state.length; p++) if (T.state[p] === WRONG || T.state[p] === MISSED || T.state[p] === CLOSE) rows.push(p);
      if (rows.length) {
        const lab = document.createElement('div'); lab.className = 'section-label'; lab.textContent = 'Review';
        const list = document.createElement('div'); list.className = 'mlist';
        for (const p of rows.slice(0, 60)) {
          const w = M.where(p), st = T.state[p], info = STATE_INFO[st];
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
    T = new E.Tracker(M); P = null; phraseSkip = 0; T.strict = strict;
    if (at >= 0 && shown >= 0) T.setPosition(M.surahs[shown].start);
    closeAll(); render(false); main.scrollTop = 0;
    toast('Cleared. Ready to start again.');
  });

  // ---------------------------------------------------------------- controls
  $('micBtn').addEventListener('click', () => { audio(); if (Input.state === 'idle') startListening(); else stopListening(); });
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

  // ---------------------------------------------------------------- start
  const startSurah = Math.min(114, Math.max(1, +store.get('surah', 67) || 67));
  setMemorize(!!store.get('memorize', false));
  setTeacher(store.get('teacher', true) !== false);
  buildSurah(startSurah - 1);
  render(false);
})();
