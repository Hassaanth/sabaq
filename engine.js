/*
 * Sabaq tracking engine.
 *
 * Takes the words a speech recognizer hears and works out where the reciter is in the Quran.
 * It is built so it does NOT flag a mistake on weak evidence:
 *   - Repeats and restarts (going back to re-begin an ayah) are recognised and never penalised.
 *   - A word is only judged after the next words confirm what happened (lookahead).
 *   - Small words the recogniser may simply have dropped are marked "not clearly heard", not "missed".
 *   - Near-matches are shown as "check" (amber) with what was heard, not as hard errors.
 *   - If it loses you, it searches the whole Quran for where you are and re-locks.
 *
 * Works in the browser (window.SabaqEngine) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SabaqEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- word states ----------
  const PENDING = 0, CORRECT = 1, CLOSE = 2, UNCLEAR = 3, WRONG = 4, MISSED = 5;

  // ---------- thresholds ----------
  const STRONG = 0.84;  // same word (one letter off in a word under 7 letters is usually a DIFFERENT word: النار / الناس)
  const NEAR = 0.5;     // similar word: possible pronunciation slip or recogniser noise
  const CONFIRM = 0.7;  // threshold for a lookahead word to count as confirmation
  const BACK = 60;      // how far back (words) a restart can be recognised locally
  const FWD = 12;       // how far forward a skip can be recognised locally
  const MAXCONF = 4;    // lookahead words used to compare explanations

  // ---------- normalisation ----------
  const DIAC = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
  function norm(w) {
    return String(w)
      .replace(DIAC, '')
      .replace(/[آأإٱٲٳٵ]/g, 'ا') // alif forms -> ا
      .replace(/[ىی]/g, 'ي') // ى / Farsi yeh -> ي
      .replace(/ة/g, 'ه')         // ة -> ه
      .replace(/ؤ/g, 'و')         // ؤ -> و
      .replace(/ئ/g, 'ي')         // ئ -> ي
      .replace(/ک/g, 'ك')         // keheh -> ك
      .replace(/ء/g, '')               // lone hamza
      .replace(/[^ا-ي]/g, '');
  }
  function tokenize(text) {
    return String(text || '').split(/[\s،؛؟.,!?;:()\-"'«»]+/).map(norm).filter(Boolean);
  }
  const skel = k => k.replace(/ا/g, '') || k;

  function lev(a, b) {
    const la = a.length, lb = b.length;
    if (!la) return lb; if (!lb) return la;
    let prev = new Array(lb + 1), cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }
  // Differences only in long-vowel letters (ا و ي) are spelling variants (داود / داوود), not recitation.
  const spellingOnly = (a, b) => { const v = x => x.replace(/[اوي]/g, ''); return v(a).length >= 2 && v(a) === v(b); };
  const simCache = new Map();
  function sim(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const ck = a < b ? a + '|' + b : b + '|' + a;
    let v = simCache.get(ck);
    if (v !== undefined) return v;
    v = 1 - lev(a, b) / Math.max(a.length, b.length);
    // Alif spelling differences (ذلك / ذالك, الرحمن / الرحمان) are spelling, not recitation.
    const sa = skel(a), sb = skel(b);
    if (sa.length >= 2 && sa === sb) v = Math.max(v, 0.92);
    if (simCache.size > 200000) simCache.clear();
    simCache.set(ck, v);
    return v;
  }

  // Muqatta'at (disjoined letters) are recited by letter name: الم -> "الف لام ميم".
  const LETTER_NAME = { 'ا': 'الف', 'ل': 'لام', 'م': 'ميم', 'ص': 'صاد', 'ر': 'را', 'ك': 'كاف', 'ه': 'ها', 'ي': 'يا', 'ع': 'عين', 'ط': 'طا', 'س': 'سين', 'ح': 'حا', 'ق': 'قاف', 'ن': 'نون' };
  const MUQ_KEYS = new Set(['الم', 'المص', 'الر', 'المر', 'كهيعص', 'طه', 'طسم', 'طس', 'يس', 'ص', 'حم', 'عسق', 'ق', 'ن']);

  // Phrases reciters often say that are not part of the text being tracked.
  const FILLERS = [
    ['اعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم'],
    ['بسم', 'الله', 'الرحمن', 'الرحيم'],
    ['صدق', 'الله', 'العظيم'],
    ['امين'],
  ];

  // Hesitation sounds a recogniser may write down. (Only those that are not Quran words are used.)
  const HESITATION = ['اه', 'اها', 'اوه', 'امم', 'اممم', 'مم', 'ممم', 'همم', 'هممم', 'اا', 'ااا', 'ايي', 'يعني', 'اعني'];

  // ---------- Mushaf: the text + a whole-Quran index ----------
  class Mushaf {
    constructor(data) {
      const keys = [], disp = [], sOf = [], aOf = [], ayahStart = [];
      this.surahs = [];
      this.ayahPos = [];
      for (const su of data) {
        const sIdx = this.surahs.length;
        const info = { n: su.n, ar: su.ar, en: su.en, tr: su.tr, start: keys.length, ayahs: su.a.length };
        const ap = [];
        su.a.forEach((pair, ai) => {
          const d = pair[0].split(' '), c = pair[1].split(' ');
          ap.push(keys.length);
          for (let w = 0; w < c.length; w++) {
            keys.push(norm(c[w]));
            disp.push(d[w]);
            sOf.push(sIdx); aOf.push(ai + 1); ayahStart.push(w === 0 ? 1 : 0);
          }
        });
        info.end = keys.length;
        this.surahs.push(info);
        this.ayahPos.push(ap);
      }
      this.N = keys.length;
      this.keys = keys; this.disp = disp;
      this.sOf = Uint8Array.from(sOf); this.aOf = Uint16Array.from(aOf); this.ayahStart = Uint8Array.from(ayahStart);
      // muqatta'at: first word of an ayah, whose key is a letter group
      this.muq = new Map();
      for (let p = 0; p < this.N; p++) {
        if (this.ayahStart[p] && this.aOf[p] <= 2 && MUQ_KEYS.has(keys[p])) {
          this.muq.set(p, [...keys[p]].map(ch => LETTER_NAME[ch] || ch).join(''));
        }
      }
      const keySet = new Set(keys);
      this.keySet = keySet;
      this.hesitation = new Set(HESITATION.filter(h => !keySet.has(h)));
      // inverted index on the alif-insensitive skeleton
      this.index = new Map();
      for (let p = 0; p < this.N; p++) {
        const k = skel(keys[p]);
        let l = this.index.get(k);
        if (!l) this.index.set(k, (l = []));
        l.push(p);
      }
    }
    pos(surahNo, ayahNo) { return this.ayahPos[surahNo - 1][ayahNo - 1]; }
    where(p) { return { surah: this.sOf[p] + 1, ayah: this.aOf[p] }; }

    /* Best match of recognised word(s) q[i..] against text word(s) at p.
       Handles a recogniser splitting one word in two (يا أيها), merging two words, and letter names. */
    matchPair(q, i, p) {
      const r = q[i];
      if (r === undefined || p < 0 || p >= this.N) return { s: 0, nr: 1, nt: 1 };
      const k = this.keys[p];
      let best = { s: sim(r, k), nr: 1, nt: 1 };
      if (best.s >= 1) return best;
      const spoken = this.muq.get(p);
      if (spoken) {
        let cat = '';
        for (let n = 1; n <= 5 && i + n - 1 < q.length; n++) {
          cat += q[i + n - 1];
          const s = sim(cat, spoken);
          if (s > best.s) best = { s, nr: n, nt: 1 };
        }
      }
      if (best.s < STRONG && i + 1 < q.length) {
        const s = sim(r + q[i + 1], k);
        if (s >= STRONG && s > best.s + 0.05) best = { s, nr: 2, nt: 1 };
      }
      if (best.s < STRONG && p + 1 < this.N) {
        const s = sim(r, k + this.keys[p + 1]);
        if (s >= STRONG && s > best.s + 0.05) best = { s, nr: 1, nt: 2 };
      }
      return best;
    }

    /* Find where in the Quran a run of recognised words comes from.
       Returns { pairs:[[i,p,s]...], end, score, ambiguous } or null. */
    locate(words, opts) {
      opts = opts || {};
      const near = opts.near == null ? -1 : opts.near;
      const n = words.length;
      if (n < 3) return null;
      const votes = new Map(); // start offset -> {v, i, p} (first contributing pair)
      for (let i = 0; i < n; i++) {
        const list = this.index.get(skel(words[i]));
        if (!list || list.length > 5000) continue;
        for (const p of list) {
          const v = p - i;
          const e = votes.get(v);
          if (e) { e.v++; } else votes.set(v, { v: 1, i, p });
        }
      }
      const cands = [...votes.values()].filter(e => e.v >= 2).sort((a, b) => b.v - a.v).slice(0, 60);
      const results = [];
      for (const c of cands) {
        const r = this._align(words, c.i, c.p);
        if (!r) continue;
        const first = r.pairs[0][1];
        if (near >= 0 && first >= near - 300 && first <= near + 600) r.score += 0.6 - Math.abs(first - near) / 2000;
        if (this.ayahStart[first]) r.score += 0.3;
        results.push(r);
      }
      if (!results.length) return null;
      results.sort((a, b) => b.score - a.score || a.pairs[0][1] - b.pairs[0][1]);
      const best = results[0];
      const strong = best.pairs.filter(x => x[2] >= STRONG).length;
      if (best.pairs.length < 3 || strong < 3 || best.raw < 2.4) return null;
      const bp = best.pairs[0][1];
      const rival = results.find(r => Math.abs(r.pairs[0][1] - bp) > n + 2);
      best.ambiguous = !!rival && best.score - rival.score < 0.35;
      return best;
    }

    _align(words, i0, p0) {
      // backward extension from the anchor
      const pairs = [];
      let i = i0, p = p0;
      while (i > 0 && p > 0) {
        const s1 = sim(words[i - 1], this.keys[p - 1]);
        if (s1 >= NEAR) { i--; p--; pairs.unshift([i, p, s1]); continue; }
        if (i > 1) {
          const s2 = sim(words[i - 2] + words[i - 1], this.keys[p - 1]);
          if (s2 >= STRONG) { i -= 2; p--; pairs.unshift([i, p, s2]); continue; }
        }
        break;
      }
      const lead = i;
      // forward greedy alignment
      i = i0; p = p0;
      let raw = 0, penalty = 0;
      for (const x of pairs) raw += x[2] >= STRONG ? x[2] : x[2] - 0.4;
      while (i < words.length && p < this.N) {
        const m = this.matchPair(words, i, p);
        // a near-miss keeps the alignment going but is weak evidence for this location
        if (m.s >= NEAR) { pairs.push([i, p, m.s, m.nr, m.nt]); raw += m.s >= STRONG ? m.s : m.s - 0.4; i += m.nr; p += m.nt; continue; }
        if (sim(words[i], this.keys[p + 1] || '') >= STRONG) { p++; penalty += 0.5; continue; } // text word not heard
        i++; penalty += 0.25; // extra / misheard word
      }
      if (!pairs.length) return null;
      return { pairs, end: p, raw, score: raw - penalty - lead * 0.1 };
    }
  }

  // ---------- Tracker ----------
  class Tracker {
    constructor(mushaf) {
      this.m = mushaf;
      this.state = new Uint8Array(mushaf.N);
      this.heard = new Map();
      this.c = -1;          // index of the next expected word; -1 = not locked yet
      this.q = [];          // normalised recognised words
      this.qi = 0;          // next unprocessed index in q
      this.lost = [];       // indices in q of words that did not fit
      this.events = [];
      this.stats = { restarts: 0, selfCorrected: 0, fillers: 0, extras: 0 };
      this.sawBismillah = false;
      // Teacher mode: stop at the first mistake and wait until that word is recited correctly.
      this.strict = false;
      this.stopped = -1;      // position we are stopped at, or -1
      this.fixed = new Set(); // words that were wrong/skipped and then recited correctly
      this.heardCount = 0;    // words heard so far
      this.stopHeard = -99;   // heardCount when the last stop signal was given
      this.stopWord = null;   // what was heard when the reciter was stopped (null: the word was skipped)
      this.attempts = 0;      // wrong attempts at the stopped word
    }
    clone() {
      const t = new Tracker.__Shell();
      t.m = this.m; t.state = this.state.slice(); t.heard = new Map(this.heard);
      t.c = this.c; t.q = this.q.slice(); t.qi = this.qi; t.lost = this.lost.slice();
      t.events = []; t.stats = Object.assign({}, this.stats); t.sawBismillah = this.sawBismillah;
      t.strict = this.strict; t.stopped = this.stopped; t.fixed = new Set(this.fixed);
      t.heardCount = this.heardCount; t.stopHeard = this.stopHeard; t.stopWord = this.stopWord; t.attempts = this.attempts;
      return t;
    }
    setPosition(p) { this.c = p; this.lost = []; this.q = this.q.slice(this.qi); this.qi = 0; this.stopped = -1; }
    /* Teacher mode: carry on past the word you are stopped at (it stays marked for review). */
    moveOn() {
      if (this.stopped < 0) return;
      const p = this.stopped;
      this.stopped = -1; this.c = p + 1; this.qi = this.q.length; this.lost.length = 0;
      this.events.push({ type: 'moveOn', pos: p });
    }
    unlock() { this.c = -1; this.lost = []; }
    reset() {
      this.state.fill(0); this.heard.clear(); this.q = []; this.qi = 0; this.lost = [];
      this.events = []; this.stats = { restarts: 0, selfCorrected: 0, fillers: 0, extras: 0 };
      this.stopped = -1; this.fixed.clear();
    }
    feed(words) {
      for (const w of words) { const n = norm(w); if (n && !this.m.hesitation.has(n)) { this.q.push(n); this.heardCount++; } }
      this._run(false);
      this._compact();
    }
    flush() { this._run(true); this._compact(); }
    drainEvents() { const e = this.events; this.events = []; return e; }

    summary(from, to) {
      const s = { correct: 0, close: 0, unclear: 0, wrong: 0, missed: 0, pending: 0 };
      for (let p = from; p < to; p++) {
        const v = this.state[p];
        if (v === CORRECT) s.correct++; else if (v === CLOSE) s.close++; else if (v === UNCLEAR) s.unclear++;
        else if (v === WRONG) s.wrong++; else if (v === MISSED) s.missed++; else s.pending++;
      }
      return s;
    }

    // ---- internals ----
    _mark(p, st, heard) {
      const prev = this.state[p];
      // A word already recited correctly is never downgraded on a later pass by a soft judgement.
      if (prev === CORRECT && (st === CLOSE || st === UNCLEAR || st === MISSED)) return;
      if (st === CORRECT && (prev === WRONG || prev === MISSED || prev === CLOSE)) {
        this.stats.selfCorrected++;
        this.heard.delete(p);
        if (prev !== CLOSE || this.stopped === p) this.fixed.add(p);
        if (this.stopped === p) this.stopped = -1;
        this.events.push({ type: 'selfCorrected', pos: p });
      }
      this.state[p] = st;
      if (heard && st !== CORRECT) this.heard.set(p, heard);
      if (st === WRONG || st === MISSED) this.events.push({ type: 'mistake', pos: p, state: st });
    }
    _accept(p, m, r) {
      for (let k = 0; k < m.nt; k++) this._mark(p + k, CORRECT);
      this.c = p + m.nt;
      this.qi = r + m.nr;
      this.lost.length = 0;
    }
    _conf(i, p) {
      // how many of the following words confirm the hypothesis (0..MAXCONF)
      // Tolerates one stray heard word or one dropped small text word along the way.
      const q = this.q, M = this.m;
      let k = 0, slack = 1;
      while (k < MAXCONF && i < q.length && p < M.N) {
        const m = M.matchPair(q, i, p);
        if (m.s >= CONFIRM) { k++; i += m.nr; p += m.nt; continue; }
        if (!slack || k === 0) break;
        slack--;
        if (i + 1 < q.length && M.matchPair(q, i + 1, p).s >= CONFIRM) { i++; continue; }
        if (M.keys[p].length <= 3 && M.matchPair(q, i, p + 1).s >= CONFIRM) { p++; continue; }
        break;
      }
      return k;
    }
    _filler(r, final) {
      const q = this.q;
      for (const f of FILLERS) {
        let i = 0;
        while (i < f.length && r + i < q.length && sim(q[r + i], f[i]) >= STRONG) i++;
        if (i === f.length) return f.length;
        if (i > 0 && r + i === q.length) { // ran out of words mid-phrase
          if (!final) return -1;
          if (i >= 2) return i;
        }
      }
      return 0;
    }
    _run(final) {
      const m = this.m;
      let guard = 0;
      while (this.qi < this.q.length && guard++ < 100000) {
        const r = this.qi, avail = this.q.length - r;
        const locked = this.c >= 0 && this.c < m.N;
        if (locked) {
          const d = m.matchPair(this.q, r, this.c);
          if (d.s >= STRONG) { this._accept(this.c, d, r); continue; }
        }
        const f = this._filler(r, final);
        if (f < 0) return; // wait: might be the start of a bismillah/isti'adha
        if (f > 0) {
          if (this.q[r] === 'بسم') this.sawBismillah = true;
          this.stats.fillers++; this.qi += f; continue;
        }
        if (locked) {
          // wait for context before judging (teacher mode judges after one confirming word, to stop you fast)
          if (!final && avail < (this.strict ? 2 : 3)) return;
          const res = this._decide(r, final);
          if (res === 'wait' || res === 'stop') return;
          if (res) continue;
        }
        this.lost.push(r); this.qi++;
        if (this.lost.length > 14) this.lost.shift();
        this._relocate();
      }
    }

    _decide(r, final) {
      const m = this.m, q = this.q, c = this.c;
      const avail = q.length - r;
      const d = m.matchPair(q, r, c);
      const H = [];
      if (d.s >= NEAR) H.push({ t: 'near', k: this._conf(r + d.nr, c + d.nt), base: d.s + 0.2 });
      H.push({ t: 'sub', k: this._conf(r + 1, c + 1), base: 0.35 });
      H.push({ t: 'ins', k: this._conf(r + 1, c), base: 0.45 });
      let lo = Math.max(0, c - BACK);
      const hi = Math.min(m.N - 1, c + FWD);
      // Stopped: the reciter may go back to the start of this ayah (or the one before), however long it is.
      if (this.stopped >= 0) lo = Math.min(lo, m.ayahPos[m.sOf[c]][Math.max(0, m.aOf[c] - 2)]);
      for (let p = lo; p <= hi; p++) {
        if (p === c) continue;
        const mm = m.matchPair(q, r, p);
        if (mm.s < STRONG) continue;
        const back = p < c;
        // Restarts are cheap. Skips cost per skipped word, but a small word is far more likely
        // to have been dropped by the recogniser than skipped by the reciter.
        let cost = 0;
        if (back) cost = 0.01 + (c - p) * 0.005;
        else for (let x = c; x < p; x++) cost += m.keys[x].length <= 3 ? 0.04 : 0.15;
        H.push({ t: back ? 'back' : 'fwd', p, mm, k: this._conf(r + mm.nr, p + mm.nt), base: mm.s - cost });
      }
      for (const h of H) h.score = h.base + h.k;
      H.sort((a, b) => b.score - a.score);
      // How much confirmation we demand: normally 1 following word; at the very end of input, what exists.
      const lookahead = avail - 1;
      let best = H.find(h => h.k >= 1);
      if (best && !final && avail < (this.strict ? 4 : 7)) {
        // Two different explanations fit equally well so far (e.g. a phrase that occurs twice):
        // wait for more words instead of guessing.
        const same = (a, b) => (a.t === 'near' || a.t === 'sub') && (b.t === 'near' || b.t === 'sub');
        const rival = H.find(h => h !== best && h.k >= 1 && !same(h, best));
        if (rival && rival.k === best.k && best.score - rival.score < 0.3) return 'wait';
      }
      if (!best && final && lookahead === 0) {
        // No following words at all (end of recitation). Only accept clear-cut cases.
        if (d.s >= NEAR) best = H.find(h => h.t === 'near');
        else best = H.find(h => (h.t === 'back' || h.t === 'fwd') && h.mm.s >= 0.95 && m.keys[h.p].length >= 4 && Math.abs(h.p - c) <= 3);
        // A real (Quran) word, clearly different, said where this word belongs as the very last thing: a substitution.
        if (!best && q[r].length >= 3 && m.keySet.has(q[r])) best = H.find(h => h.t === 'sub');
      }
      if (!best) return false;
      const heardAt = (i, n) => q.slice(i, i + n).join(' ');
      switch (best.t) {
        case 'near': {
          // Stopped here and corrected: a new attempt that is close (and not the same mistake again)
          // is accepted, so a recogniser's slightly different spelling of the right word lets you move on.
          if (this.strict && c === this.stopped && this._lenient(q.slice(r, r + d.nr).join(''), d.s)) { this._accept(c, d, r); return true; }
          // A spelling-only difference is recogniser noise. A changed consonant (الجنوب for الجنود) is a slip.
          const st = spellingOnly(q.slice(r, r + d.nr).join(''), m.keys.slice(c, c + d.nt).join('')) ? CORRECT : CLOSE;
          for (let k = 0; k < d.nt; k++) this._mark(c + k, st, heardAt(r, d.nr));
          if (this.strict && this.state[c] === CLOSE) { if (this._stop(c, true)) return 'stop'; this.qi = r + d.nr; return true; }
          this.c = c + d.nt; this.qi = r + d.nr; this.lost.length = 0;
          return true;
        }
        case 'sub': {
          this._mark(c, d.s >= NEAR ? CLOSE : WRONG, heardAt(r, 1));
          if (this.strict && (this.state[c] === WRONG || this.state[c] === CLOSE)) { if (this._stop(c, true)) return 'stop'; this.qi = r + 1; return true; }
          this.c = c + 1; this.qi = r + 1; this.lost.length = 0;
          return true;
        }
        case 'ins': {
          this.stats.extras++; this.qi = r + 1;
          return true;
        }
        case 'back': {
          this.stats.restarts++;
          this.events.push({ type: 'restart', from: c, to: best.p });
          this._accept(best.p, best.mm, r);
          return true;
        }
        case 'fwd': {
          const stopAt = this._judgeGap(c, best.p, r);
          if (stopAt >= 0) { if (this._stop(stopAt, this._gapAttempt)) return 'stop'; return true; }
          this._accept(best.p, best.mm, r);
          return true;
        }
      }
      return false;
    }

    /* Text words c..p-1 were passed over. Words heard just before (that did not fit) are lined up
       against them: a similar one -> "check", a different one in the same slot -> "wrong",
       nothing heard -> "missed" (or "not clearly heard" for one or two small words). */
    _judgeGap(c, p, r) {
      const m = this.m, q = this.q, span = p - c;
      const heard = [];
      for (let j = this.lost.length - 1, idx = r - 1; j >= 0 && heard.length < span; j--, idx--) {
        if (this.lost[j] !== idx) break;
        heard.unshift(q[idx]);
      }
      const a = heard.length, T = [];
      for (let x = c; x < p; x++) T.push(m.keys[x]);
      const isRepeat = heard.map(h => {
        for (let x = Math.max(0, c - 6); x <= Math.min(m.N - 1, p + 2); x++) if ((x < c || x >= p) && sim(h, m.keys[x]) >= STRONG) return true;
        return false;
      });
      // Monotonic alignment: similar words pair by similarity; a dissimilar heard word can still pair
      // as a substitution (small score, slightly preferring longer text words, as small ones get dropped).
      const dp = [], bk = [];
      for (let i = 0; i <= a; i++) { dp.push(new Array(span + 1).fill(0)); bk.push(new Array(span + 1).fill(0)); }
      for (let i = 1; i <= a; i++) for (let j = 1; j <= span; j++) {
        const sv = sim(heard[i - 1], T[j - 1]);
        let v = dp[i - 1][j], b = 1;
        if (dp[i][j - 1] > v) { v = dp[i][j - 1]; b = 2; }
        // a heard word that is really a repeat of nearby text is not a substitution
        const pv = sv >= NEAR ? sv : isRepeat[i - 1] ? 0 : 0.1 + (T[j - 1].length > 3 ? 0.02 : 0);
        if (dp[i - 1][j - 1] + pv > v) { v = dp[i - 1][j - 1] + pv; b = 3; }
        dp[i][j] = v; bk[i][j] = b;
      }
      const pairOf = new Array(span).fill(-1);
      for (let i = a, j = span; i > 0 && j > 0;) {
        const b = bk[i][j];
        if (b === 3) { pairOf[j - 1] = i - 1; i--; j--; } else if (b === 1) i--; else j--;
      }
      // Not-heard words are "not clearly heard" (not a mistake) when they are all small words and
      // never more than two in a row: a reciter skips runs, a recogniser drops scattered small words.
      // Each run of consecutive not-heard words is judged on its own.
      const soft = new Array(span).fill(false);
      for (let j = 0; j < span;) {
        if (pairOf[j] >= 0) { j++; continue; }
        let e = j; while (e < span && pairOf[e] < 0) e++;
        const ok = e - j <= 2 && T.slice(j, e).every(t => t.length <= 3);
        for (let x = j; x < e; x++) soft[x] = ok;
        j = e;
      }
      // Teacher mode: every skipped word counts (it stops you), and judging ends at the first mistake.
      for (let j = 0; j < span; j++) {
        const x = c + j;
        if (pairOf[j] >= 0) {
          const h = heard[pairOf[j]], sv = sim(h, T[j]);
          this._mark(x, sv >= STRONG ? CORRECT : sv >= NEAR ? CLOSE : WRONG, h);
        } else if (this.state[x] === PENDING) this._mark(x, soft[j] && !this.strict ? UNCLEAR : MISSED);
        if (this.strict && (this.state[x] === WRONG || this.state[x] === MISSED || this.state[x] === CLOSE)) {
          this._gapAttempt = pairOf[j] >= 0; // something was said for this word (vs. skipped)
          return x;
        }
      }
      return -1;
    }

    /* Teacher mode: hold the reciter at word p. Words heard after it were said past the mistake,
       so they are dropped; the next words must recite p (or restart before it). */
    _lenient(attempt, s) {
      return this.stopWord == null ? s >= NEAR : attempt !== this.stopWord && s >= 0.6;
    }

    /* Returns true if the reciter is now stopped at p; false if, after 3 wrong tries at the same word,
       they are let through (the word stays marked for review). */
    _stop(p, attempt) {
      const again = this.stopped === p;
      if (!again) { this.attempts = 0; this.stopWord = this.heard.has(p) ? this.heard.get(p).replace(/ /g, '') : null; }
      if (attempt) this.attempts++;
      if (again && attempt && this.attempts >= 3) {
        this.stopped = -1; this.c = p + 1; this.lost.length = 0;
        this.events.push({ type: 'moveOn', pos: p, auto: true });
        return false;
      }
      this.c = p;
      this.qi = this.q.length;
      this.lost.length = 0;
      this.stopped = p;
      // Words already on their way when the signal sounded would re-trigger it at once: stay stopped,
      // but signal again only if the reciter keeps going for 5 more words.
      // A fresh attempt at the word itself (said wrong again) is always corrected again.
      if (again && !attempt && this.heardCount - this.stopHeard < 5) return true;
      this.stopHeard = this.heardCount;
      this.events.push({ type: 'stop', pos: p, state: this.state[p] });
      return true;
    }

    _relocate() {
      if (this.lost.length < 3) return false;
      if (this.stopped >= 0 && this.lost.length < 10) return false; // stopped: don't drift ahead unless clearly elsewhere
      const words = this.lost.map(i => this.q[i]);
      const res = this.m.locate(words, { near: this.c });
      if (!res) return false;
      if (res.ambiguous && this.lost.length < 10) return false;
      const wasLocked = this.c >= 0;
      for (const [i, p, s, nr, nt] of res.pairs) {
        const st = s >= STRONG ? CORRECT : CLOSE;
        for (let k = 0; k < (nt || 1); k++) this._mark(p + k, st, st === CLOSE ? words[i] : null);
      }
      const first = res.pairs[0][1];
      // Bismillah was said before Al-Fatiha 1:2 -> ayah 1 was recited.
      if (!wasLocked && this.sawBismillah && first === this.m.pos(1, 2)) {
        for (let p = this.m.pos(1, 1); p < first; p++) this._mark(p, CORRECT);
      }
      this.c = res.end;
      this.lost.length = 0;
      this.events.push({ type: wasLocked ? 'relocated' : 'locked', pos: first });
      return true;
    }

    _compact() {
      const drop = this.qi - 64;
      if (drop < 256) return;
      this.q = this.q.slice(drop);
      this.qi -= drop;
      this.lost = this.lost.map(i => i - drop).filter(i => i >= 0);
    }
  }
  Tracker.__Shell = function () {};
  Tracker.__Shell.prototype = Tracker.prototype;

  return { Mushaf, Tracker, norm, tokenize, sim, PENDING, CORRECT, CLOSE, UNCLEAR, WRONG, MISSED };
});
