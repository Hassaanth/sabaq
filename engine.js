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
  // Differences only in long-vowel letters (ا و ي) are spelling variants (داود / داوود), not recitation. So are
  // the ways words sound when joined (wasl), as a recogniser may write them:
  //   ta marbuta read on is "t" (مرة -> "مرت"); the lam of al- before a sun letter is not said (الشمس -> "اشمس");
  //   a dropped hamzat al-wasl (الخلاق -> "لخلاق", already only an alif); a final nun merged into the next word
  //   (idgham: من يقول -> "مي يقول").
  const collapse = x => x.replace(/(.)\1+/g, '$1');
  const vow = x => collapse(x.replace(/^([وفبك]?)ال(?=[تثدذرزسشصضطظلن])/, '$1ا').replace(/[ته]$/, 'ه').replace(/ا/g, ''));
  const spellingOnly = (a, b) => {
    const va = vow(a), vb = vow(b);
    if (va.length >= 2 && va === vb) return true;
    if (a.length >= 3 && collapse(a) === collapse(b)) return true; // شييا / شيا
    if (b.length >= 2 && b.endsWith('ن') && va.length >= 1 && va === vow(b.slice(0, -1))) return true;
    return false;
  };
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
    // Ta marbuta read on (wasl) is said "t": مرة -> "مرت", نعمة -> "نعمت". Same word.
    if (a.length === b.length && a.length >= 3 && a.slice(0, -1) === b.slice(0, -1)) { const x = a[a.length - 1] + b[b.length - 1]; if (x === 'هت' || x === 'ته') v = Math.max(v, 0.92); }
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
      // ayah starts by their first word (ayahs that open alike: تبارك الذي, يا ايها الذين امنوا ...)
      this.byFirst = new Map();
      for (let p = 0; p < keys.length; p++) if (ayahStart[p]) { const l = this.byFirst.get(keys[p]); if (l) l.push(p); else this.byFirst.set(keys[p], [p]); }
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
      if ((best.s < STRONG || (best.nt === 2 && best.s < 1)) && p + 1 < this.N && r.length >= 4) {
        const k2 = this.keys[p + 1], firsts = [k], seconds = [k2];
        if (/^[اي]$/.test(k[k.length - 1]) && k.length >= 3) firsts.push(k.slice(0, -1));
        if (k.endsWith('ن') && k.length >= 2) firsts.push(k.slice(0, -1));
        if (k2.startsWith('ال')) { seconds.push(k2.slice(1)); if ('تثدذرزسشصضطظلن'.includes(k2[2])) seconds.push(k2.slice(2)); }
        else if (k2.startsWith('ا') && k2.length >= 4) seconds.push(k2.slice(1));
        const cr = collapse(r);
        for (const f of firsts) for (const g of seconds) if (cr === collapse(f + g)) { best = { s: 0.95, nr: 1, nt: 2, blend: true }; break; }
      }
      // Two words recited joined (wasl) are often written by the recogniser as one word with the join
      // blurred: هل أتاك -> "الأتاك". The second word is there in full; the first is only "not clearly heard".
      // (also when the joined form scored as a near match above: البصاكرتين for البصر كرتين)
      if ((best.s < STRONG || (best.nt === 2 && best.s < 1)) && p + 1 < this.N) {
        const k2 = this.keys[p + 1];
        if (k2.length >= 3 && r.length > k2.length && r.endsWith(k2) && sim(r.slice(0, r.length - k2.length), k) >= 0.5) {
          best = { s: Math.max(STRONG, best.nt === 2 ? best.s : 0), nr: 1, nt: 2, blend: true };
        } else if (k2.length >= 4 && r.length > k2.length) {
          // recited fast, the second word is also blurred a little: من تفاوت -> "انتفوت"
          for (let L = k2.length - 1; L <= k2.length + 1 && !best.blend; L++) {
            if (L < 3 || L >= r.length - 1) continue;
            if (sim(r.slice(r.length - L), k2) >= 0.75 && sim(r.slice(0, r.length - L), k) >= 0.5) best = { s: STRONG, nr: 1, nt: 2, blend: true };
          }
        }
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
        // the surah open on the screen is the likely one: a phrase several surahs share (الحمد لله الذي) goes there
        if (opts.within && first >= opts.within[0] && first < opts.within[1]) r.score += 0.5;
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
      this.flagged = new Set(); // words the reciter was stopped on (teacher mode): they stay marked
      this.heardCount = 0;    // words heard so far
      this.stopHeard = -99;   // heardCount when the last stop signal was given
      this.stopWord = null;   // what was heard when the reciter was stopped (null: the word was skipped)
      this.attempts = 0;      // wrong attempts at the stopped word
      this.noRewindBefore = 0; // words before this index in q have already been re-read once after locating
      this.journal = [];      // recent marks, with what each word was before (to undo a move between alike ayahs)
    }
    clone() {
      const t = new Tracker.__Shell();
      t.m = this.m; t.state = this.state.slice(); t.heard = new Map(this.heard);
      t.c = this.c; t.q = this.q.slice(); t.qi = this.qi; t.lost = this.lost.slice();
      t.events = []; t.stats = Object.assign({}, this.stats); t.sawBismillah = this.sawBismillah;
      t.strict = this.strict; t.stopped = this.stopped; t.fixed = new Set(this.fixed); t.flagged = new Set(this.flagged);
      t.heardCount = this.heardCount; t.stopHeard = this.stopHeard; t.stopWord = this.stopWord; t.attempts = this.attempts; t.noRewindBefore = this.noRewindBefore; t.letContinue = this.letContinue; t.hint = this.hint; t.stopQ = this.stopQ; t.journal = this.journal.slice();
      return t;
    }
    setPosition(p) { this.c = p; this.lost = []; this.q = this.q.slice(this.qi); this.qi = 0; this.stopped = -1; this.noRewindBefore = 0; }
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
      this.stopped = -1; this.fixed.clear(); this.flagged.clear(); this.journal = [];
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
      this.journal.push({ p, st: prev, h: this.heard.get(p), fx: this.fixed.has(p), fl: this.flagged.has(p) });
      if (this.journal.length > 64) this.journal.shift();
      // A word already recited correctly is never downgraded on a later pass by a soft judgement.
      if (prev === CORRECT && (st === CLOSE || st === UNCLEAR || st === MISSED)) return;
      if (st === CORRECT && (prev === WRONG || prev === MISSED || prev === CLOSE)) {
        this.stats.selfCorrected++;
        this.heard.delete(p);
        if (prev !== CLOSE || this.stopped === p || this.flagged.has(p)) this.fixed.add(p);
        if (this.stopped === p) this.stopped = -1;
        this.events.push({ type: 'selfCorrected', pos: p });
      }
      this.state[p] = st;
      if (heard && st !== CORRECT) this.heard.set(p, heard);
      if (st === WRONG || st === MISSED) this.events.push({ type: 'mistake', pos: p, state: st });
    }
    _accept(p, m, r) {
      for (let k = 0; k < m.nt; k++) this._mark(p + k, m.blend && k === 0 && this.state[p] !== CORRECT ? UNCLEAR : CORRECT);
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
      { const so = this._sharedOpening(c, r, final); if (so === 'wait') return 'wait'; if (so) return true; }
      // Stopped here, the qari has already said the word, and the reciter carries on with the words that
      // follow it (three in a row, after at most two stray words still on their way): let them. The word
      // stays marked for review. A stop (even a false one, from a misheard word) can then never trap them.
      if (this.strict && this.stopped === c && this.letContinue) {
        const far = Math.min(m.N - 1, c + 30);
        for (let j = 0; j <= 2 && r + j < q.length; j++) {
          // a word said here that is (close to) the stopped word itself is the fix, not a stray word
          if (m.matchPair(q, r + j, c).s >= NEAR) break;
          let waiting = false;
          for (let p = c + 1; p <= far; p++) {     // the nearest place the reciter has got to
            const mm = m.matchPair(q, r + j, p);
            if (mm.s < STRONG) continue;
            const k = this._conf(r + j + mm.nr, p + mm.nt);
            if (k >= 2) {
              this.stopped = -1; this.attempts = 0; this.letContinue = false;
              // Words recited while stopped were not followed. Those that were heard (said after the stop, in order)
              // are simply right; the rest are "not clearly heard", never "skipped".
              const said = this.q.slice(Math.min(this.stopQ != null ? this.stopQ : r + j, r + j), r + j);
              let si = 0;
              for (let x = c + 1; x < p; x++) {
                if (this.state[x] !== PENDING) continue;
                let hit = -1;
                for (let i = si; i < said.length; i++) if (sim(said[i], m.keys[x]) >= STRONG) { hit = i; break; }
                if (hit >= 0) { this._mark(x, CORRECT); si = hit + 1; } else this._mark(x, UNCLEAR);
              }
              // carrying on from the very next word right after the qari: the word itself was most likely said and
              // clipped by the recogniser (a reply's first word often is): "not clearly heard", not "missed"
              if (p === c + 1 && j === 0 && this.state[c] === MISSED) this._mark(c, UNCLEAR);
              this.events.push({ type: 'moveOn', pos: c, auto: true, continued: true });
              this._accept(p, mm, r + j);
              return true;
            }
            if (!final && r + j + mm.nr + 2 > q.length) waiting = true;
          }
          if (waiting) return 'wait'; // the next words are not heard yet
        }
      }
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
        const kk = this._conf(r + mm.nr, p + mm.nt);
        // Teacher mode: going back far, to the middle of an ayah, on a word or two that happen to match (a similar
        // phrase two ayahs back: "من يحيي العظام" for a slip "أن يحيي الموتى") is not a restart unless 3 words in a
        // row confirm it. Going back to an ayah's start, or a few words, is as easy as before.
        if (back && this.strict && c - p > 8 && !m.ayahStart[p] && kk < 2) continue;
        H.push({ t: back ? 'back' : 'fwd', p, mm, k: kk, base: mm.s - cost });
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
          if (d.blend) { this._accept(c, d, r); return true; }
          // A spelling-only difference is recogniser noise. A changed consonant (الجنوب for الجنود) is a slip.
          const st = spellingOnly(q.slice(r, r + d.nr).join(''), m.keys.slice(c, c + d.nt).join('')) ? CORRECT : CLOSE;
          for (let k = 0; k < d.nt; k++) this._mark(c + k, st, heardAt(r, d.nr));
          if (this.strict && this.state[c] === CLOSE) { if (this._stop(c, true)) return 'stop'; this.qi = r + d.nr; return true; }
          this.c = c + d.nt; this.qi = r + d.nr; this.lost.length = 0;
          return true;
        }
        case 'sub': {
          // Stopped here: only a word like this one (or the same mistake again) is a try at it. Anything else
          // (the reciter carrying on regardless, a stray sound) neither counts as a try nor marks the word.
          if (this.strict && c === this.stopped) {
            const h = q[r], sw = this.stopWord;
            const isTry = d.s >= 0.5 || (sw && (h === sw || sim(h, sw) >= 0.8));
            if (!isTry) { this.qi = r + 1; return true; }
          }
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
          this._mark(x, sv >= STRONG || (sv >= NEAR && spellingOnly(h, T[j])) ? CORRECT : sv >= NEAR ? CLOSE : WRONG, h);
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
    // Ayahs that open with the same words (تبارك الذي: 25:1, 25:10, 25:61, 67:1; يا ايها الذين امنوا ...): the reciter was
    // placed in one of them from its first words (the open surah's, or the first found); the words that follow show
    // which one they are reciting. Moving there is no mistake, in the same surah or another. Only within an ayah's
    // first 4 words, when those were heard as the text has them, and when the next two words heard fit the other ayah
    // and not this one. (Stopped on the word where the two part, from an earlier try: the stop is undone.) Not when
    // the reciter got to this ayah by reciting the one before it: then the place is certain, and going on with the
    // other ayah's words is a slip between similar ayahs (mutashabihat), judged as before.
    _sharedOpening(c, r, final) {
      const m = this.m, q = this.q;
      if (c <= 0 || c >= m.N || m.ayahStart[c] || r >= q.length) return false;
      if (this.stopped >= 0 && this.stopped !== c) return false;
      let s = c; while (s > 0 && !m.ayahStart[s]) s--;
      const k = c - s;
      if (k < 1 || k > 4 || sim(q[r], m.keys[c]) >= STRONG) return false;
      for (let x = s; x < c; x++) if (this.state[x] !== CORRECT) return false;
      if (s > 0 && this.state[s - 1] !== PENDING) return false;
      const starts = m.byFirst.get(m.keys[s]);
      if (!starts || starts.length < 2) return false;
      let best = -1, bs = 0, need = false;
      for (const A of starts) {
        if (A === s || A + k + 1 >= m.N) continue;
        let same = true; for (let i = 1; i < k; i++) if (m.keys[A + i] !== m.keys[s + i]) { same = false; break; }
        if (!same || m.ayahStart[A + k]) continue;
        const s1 = sim(q[r], m.keys[A + k]); if (s1 < STRONG) continue;
        let sc = s1;
        if (r + 1 < q.length) { const s2 = sim(q[r + 1], m.keys[A + k + 1]); if (s2 < STRONG) continue; sc += s2; }
        else if (!final) { need = true; continue; }
        // (alike: the open surah's, then the nearest)
        if (this.hint && A >= this.hint[0] && A < this.hint[1]) sc += 0.01;
        sc -= Math.abs(A - s) * 1e-9;
        if (sc > bs) { bs = sc; best = A; }
      }
      if (best < 0) return need ? 'wait' : false;
      // Undo what this arrival marked on s..c, back to how each word was before it: marks from an earlier pass
      // over this ayah stay. The arrival began with the last mark on the ayah's first word.
      const J = this.journal; let from = -1;
      for (let i = J.length - 1; i >= 0; i--) if (J[i].p === s) { from = i; break; }
      for (let x = s; x <= c; x++) {
        let e = null;
        if (from >= 0) { for (let i = from; i < J.length; i++) if (J[i].p === x) { e = J[i]; break; } if (!e) continue; }
        this.state[x] = e ? e.st : PENDING;
        if (e && e.h != null) this.heard.set(x, e.h); else this.heard.delete(x);
        if (e && e.fx) this.fixed.add(x); else this.fixed.delete(x);
        if (e && e.fl) this.flagged.add(x); else this.flagged.delete(x);
      }
      if (this.stopped === c) { this.stopped = -1; this.attempts = 0; this.letContinue = false; }
      for (let i = 0; i < k; i++) this._mark(best + i, CORRECT);
      this.c = best + k; this.lost.length = 0;
      this.events.push({ type: 'relocated', pos: best, from: s, opening: true });
      return true;
    }
    _stop(p, attempt) {
      const again = this.stopped === p;
      if (!again) { this.attempts = 0; this.letContinue = false; this.stopWord = this.heard.has(p) ? this.heard.get(p).replace(/ /g, '') : null; this.stopQ = this.qi; }
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
      this.flagged.add(p);
      this.events.push({ type: 'stop', pos: p, state: this.state[p] });
      return true;
    }

    _relocate() {
      // Not placed yet, with a surah open (hint): starting it from the top is the usual case, and its first two
      // words, clearly heard, are enough. The highlight then starts on the third word, not three words late.
      if (this.c < 0 && this.hint && this.lost.length === 2) {
        const s0 = this.hint[0], q = this.q, L = this.lost;
        if (s0 + 1 < this.hint[1] && sim(q[L[0]], this.m.keys[s0]) >= STRONG && sim(q[L[1]], this.m.keys[s0 + 1]) >= STRONG) {
          this.c = s0; this.qi = L[0]; this.lost.length = 0; this.noRewindBefore = q.length;
          this.events.push({ type: 'locked', pos: s0 });
          return true;
        }
      }
      if (this.lost.length < 3) return false;
      if (this.stopped >= 0 && this.lost.length < 10) return false; // stopped: don't drift ahead unless clearly elsewhere
      const words = this.lost.map(i => this.q[i]);
      const res = this.m.locate(words, { near: this.c, within: this.c < 0 ? this.hint : null });
      if (!res) return false;
      if (res.ambiguous && this.lost.length < 10) return false;
      const wasLocked = this.c >= 0;
      // A jump forward within the surah you are reciting is a skip, however far (memorization: every word
      // counts). Teacher mode stops you at the first skipped word; otherwise the skipped words are marked
      // and tracking follows you. Going back (review) or to another surah is a deliberate move. Once the
      // qari has said the stopped word, carrying on from further ahead is allowed (as in _decide).
      const target = anchor0(res);
      const skipping = wasLocked && target > this.c && this.m.sOf[target] === this.m.sOf[this.c];
      if (skipping && this.strict && !(this.stopped >= 0 && this.letContinue)) {
        if (this.stopped !== this.c) this._mark(this.c, MISSED);
        this.lost.length = 0;
        this._stop(this.c, false);
        return true;
      }
      if (wasLocked && this.strict && this.stopped < 0 && this.m.sOf[target] !== this.m.sOf[this.c] && this.c - this.m.ayahPos[this.m.sOf[this.c]][this.m.aOf[this.c] - 1] >= 2 && !(this.c + 1 < this.m.N && this.m.ayahStart[this.c + 1])) {
        this._mark(this.c, WRONG, this.q[this.lost[0]]);
        this.lost.length = 0;
        this._stop(this.c, true);
        return true;
      }
      if (this.stopped >= 0) {
        // relocating while stopped (the reciter carried on elsewhere): the stop is over; the word stays marked
        this.events.push({ type: 'moveOn', pos: this.stopped, auto: true, continued: true });
        this.stopped = -1; this.attempts = 0; this.letContinue = false;
      }
      if (skipping && !this.strict) for (let p = this.c; p < target; p++) if (this.state[p] === PENDING) this._mark(p, MISSED);
      // Found it. Re-read the located words with the normal rules from the first clearly heard word, so
      // a mistake in the phrase that was used to find the place (often the very first ayah) still counts.
      // Each word is re-read at most once (no loops).
      const anchor = res.pairs.find(x => x[2] >= STRONG && (x[3] || 1) === 1 && (x[4] || 1) === 1);
      if (anchor && this.lost[anchor[0]] >= this.noRewindBefore) {
        const first = anchor[1];
        if (!wasLocked && this.sawBismillah && first === this.m.pos(1, 2)) {
          for (let p = this.m.pos(1, 1); p < first; p++) this._mark(p, CORRECT);
        }
        this.noRewindBefore = this.q.length;
        this.c = first;
        this.qi = this.lost[anchor[0]];
        this.lost.length = 0;
        this.events.push({ type: wasLocked ? 'relocated' : 'locked', pos: first });
        return true;
      }
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
      this.noRewindBefore = Math.max(0, this.noRewindBefore - drop);
      if (this.stopQ != null) this.stopQ = Math.max(0, this.stopQ - drop);
    }
  }
  function anchor0(res) {
    const a = res.pairs.find(x => x[2] >= STRONG && (x[3] || 1) === 1 && (x[4] || 1) === 1);
    return a ? a[1] : res.pairs[0][1];
  }
  Tracker.__Shell = function () {};
  Tracker.__Shell.prototype = Tracker.prototype;

  return { Mushaf, Tracker, norm, tokenize, sim, PENDING, CORRECT, CLOSE, UNCLEAR, WRONG, MISSED };
});
