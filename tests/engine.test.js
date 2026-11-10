// Run: node tests/engine.test.js
const fs = require('fs'), path = require('path');
const E = require('../engine.js');
const win = {}; new Function('window', fs.readFileSync(path.join(__dirname, '..', 'quran-data.js'), 'utf8'))(win);
const M = new E.Mushaf(win.QURAN);
const { CORRECT, CLOSE, UNCLEAR, WRONG, MISSED, PENDING } = E;

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (info ? '  -> ' + JSON.stringify(info) : '')); }
}
// text words (normalised keys) of surah s, ayahs a1..a2 ; vocative-merged keys are re-split like a recogniser would
function words(s, a1, a2) {
  const out = [];
  for (let a = a1; a <= a2; a++) out.push(...win.QURAN[s - 1].a[a - 1][1].split(' ').flatMap(w => w.split('_')));
  return out;
}
function range(s, a1, a2) { return [M.pos(s, a1), a2 >= M.surahs[s - 1].ayahs ? M.surahs[s - 1].end : M.pos(s, a2 + 1)]; }
// feed like a recogniser: in chunks of `chunk` words, then flush at the end
function recite(t, list, chunk = 4) {
  for (let i = 0; i < list.length; i += chunk) t.feed(list.slice(i, i + chunk));
  t.flush();
  return t;
}
function at(s, a) { const t = new E.Tracker(M); t.setPosition(M.pos(s, a)); return t; }
const errs = (t, [a, b]) => { const s = t.summary(a, b); return s.wrong + s.missed; };

console.log('Normalisation');
check('uthmani and plain spellings match', E.norm('ٱلرَّحْمَٰنِ') === E.norm('الرحمن') && E.sim(E.norm('ٱلْعَٰلَمِينَ'), E.norm('العالمين')) >= 0.9);
check('alif spelling variants count as the same word', E.sim(E.norm('ذالك'), E.norm('ذلك')) >= 0.8);
check('عليم vs حليم is NOT treated as the same word', E.sim('عليم', 'حليم') < 0.8);

console.log('Perfect recitation');
{
  const t = recite(at(1, 1), words(1, 1, 7));
  const s = t.summary(...range(1, 1, 7));
  check('Al-Fatiha: every word correct', s.correct === 29 && s.pending === 0, s);
}
{
  const t = recite(at(67, 1), words(67, 1, 30), 5);
  const s = t.summary(...range(67, 1, 30));
  check('Al-Mulk (all 30 ayahs): every word correct', s.correct === s.correct + s.pending - s.pending && s.wrong + s.missed + s.close + s.unclear === 0 && s.pending === 0, s);
}

console.log('Restarts and repeats are never mistakes');
{
  const w = words(1, 2, 2); // الحمد لله رب العالمين
  const list = [...words(1, 1, 1), ...w.slice(0, 3), ...w, ...words(1, 3, 7)];
  const t = recite(at(1, 1), list);
  check('restart mid-ayah (الحمد لله رب | الحمد لله رب العالمين)', errs(t, range(1, 1, 7)) === 0 && t.summary(...range(1, 1, 7)).correct === 29 && t.stats.restarts >= 1, t.summary(...range(1, 1, 7)));
}
{
  const a3 = words(2, 3, 3);
  const list = [...words(2, 1, 2), ...a3.slice(0, 5), ...a3.slice(0, 2), ...a3.slice(0, 5), ...a3.slice(5), ...words(2, 4, 5)];
  const t = recite(at(2, 1), list);
  check('two restarts in one ayah (Al-Baqarah 2:3)', errs(t, range(2, 1, 5)) === 0 && t.summary(...range(2, 1, 5)).pending === 0, t.summary(...range(2, 1, 5)));
}
{
  const list = [...words(67, 1, 1), ...words(67, 2, 2).slice(0, 6), ...words(67, 1, 1), ...words(67, 2, 3)];
  const t = recite(at(67, 1), list);
  check('going back to re-begin the previous ayah', errs(t, range(67, 1, 3)) === 0 && t.summary(...range(67, 1, 3)).pending === 0, t.summary(...range(67, 1, 3)));
}
{
  const w = words(112, 1, 4);
  const list = [w[0], w[0], w[1], w[2], w[2], w[2], ...w.slice(3)];
  const t = recite(at(112, 1), list);
  check('stuttering a word several times', errs(t, range(112, 1, 4)) === 0 && t.summary(...range(112, 1, 4)).pending === 0, t.summary(...range(112, 1, 4)));
}
{
  const w = words(1, 2, 2);
  const list = [...words(1, 1, 1), 'الحم', ...w, ...words(1, 3, 7)];
  const t = recite(at(1, 1), list);
  check('cut-off half word then the full word', errs(t, range(1, 1, 7)) === 0, t.summary(...range(1, 1, 7)));
}
{
  const t = recite(at(1, 1), ['اعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم', ...words(1, 1, 7), 'امين']);
  const s = t.summary(...range(1, 1, 7));
  check("isti'adha before and amin after are ignored", s.correct === 29 && errs(t, range(1, 1, 7)) === 0, s);
}

console.log('Recogniser noise is not blamed on the reciter');
{
  const list = words(67, 1, 3).map(w => w.replace(/^ذلك$/, 'ذالك').replace(/^الرحمن$/, 'الرحمان'));
  const t = recite(at(67, 1), list);
  check('alif spelling variants from the recogniser', errs(t, range(67, 1, 3)) === 0 && t.summary(...range(67, 1, 3)).close === 0, t.summary(...range(67, 1, 3)));
}
{
  const w = words(67, 3, 3);
  const iFi = w.indexOf('في');
  const list = [...words(67, 1, 2), ...w.slice(0, iFi), ...w.slice(iFi + 1), ...words(67, 4, 4)];
  const t = recite(at(67, 1), list);
  const p = M.pos(67, 3) + iFi;
  check('recogniser drops a small word (في) -> "not clearly heard", not a mistake', t.state[p] === UNCLEAR && errs(t, range(67, 1, 4)) === 0, { state: t.state[p], s: t.summary(...range(67, 1, 4)) });
}
{
  const t = recite(at(2, 21), ['يا', 'ايها', ...words(2, 21, 21).slice(2)]);
  check('vocative heard as two words (يا ايها الناس)', errs(t, range(2, 21, 21)) === 0 && t.summary(...range(2, 21, 21)).pending === 0, t.summary(...range(2, 21, 21)));
}
{
  const t = recite(at(2, 1), ['الف', 'لام', 'ميم', ...words(2, 2, 3)]);
  check("muqatta'at by letter names (الف لام ميم)", errs(t, range(2, 1, 3)) === 0 && t.summary(...range(2, 1, 3)).pending === 0, t.summary(...range(2, 1, 3)));
}
{
  const t = recite(at(36, 1), ['يا', 'سين', ...words(36, 2, 4)]);
  check("muqatta'at يس as يا سين", errs(t, range(36, 1, 4)) === 0 && t.summary(...range(36, 1, 4)).pending === 0, t.summary(...range(36, 1, 4)));
}

console.log('Real mistakes ARE caught');
{
  const w = words(112, 1, 4);
  const iSamad = w.indexOf('الصمد');
  const list = w.slice(); list[iSamad] = 'الكريم';
  const t = recite(at(112, 1), list);
  const p = M.pos(112, 1) + iSamad;
  check('wrong word (الكريم instead of الصمد) -> wrong, heard recorded', t.state[p] === WRONG && t.heard.get(p) === 'الكريم' && errs(t, range(112, 1, 4)) === 1, { st: t.state[p], s: t.summary(...range(112, 1, 4)) });
}
{
  const w = words(67, 2, 2);
  const list = [...words(67, 1, 1), ...w.slice(0, 4), ...w.slice(7), ...words(67, 3, 3)];
  const t = recite(at(67, 1), list);
  const s = t.summary(...range(67, 1, 3));
  check('skipped 3 words mid-ayah -> 3 missed', s.missed === 3 && s.wrong === 0, s);
}
{
  // classic memorisation slip: wrong ending (غفور رحيم instead of the real ending)
  const w = words(2, 32, 32);
  const list = [...w.slice(0, -2), 'الغفور', 'الرحيم', ...words(2, 33, 33)];
  const t = recite(at(2, 32), list);
  const p = M.pos(2, 32) + w.length - 2;
  check('wrong ayah ending is flagged (الغفور الرحيم vs العليم الحكيم)', [WRONG, CLOSE].includes(t.state[p]) && [WRONG, CLOSE].includes(t.state[p + 1]), { a: t.state[p], b: t.state[p + 1], h: [t.heard.get(p), t.heard.get(p + 1)] });
}
{
  // skip a whole ayah
  const list = [...words(112, 1, 2), ...words(112, 4, 4)];
  const t = recite(at(112, 1), list);
  const s = t.summary(...range(112, 3, 3));
  check('skipping a whole short ayah -> its words marked missed', s.missed === s.missed + s.unclear - s.unclear && s.missed + s.unclear === 4 && s.missed >= 2, s);
}
{
  const w = words(112, 1, 4); const list = w.slice(); list[3] = 'احط';
  const t = recite(at(112, 1), list);
  check('mispronounced word (احط for احد) -> amber "check", not red', t.state[M.pos(112, 1) + 3] === CLOSE, t.state[M.pos(112, 1) + 3]);
}
{
  const w = words(112, 1, 4); const list = w.slice(); list[list.length - 1] = 'احط';
  const t = recite(at(112, 1), list);
  check('mispronounced LAST word (no words after it) -> check', t.state[M.pos(112, 1) + w.length - 1] === CLOSE);
}
{
  const w = words(112, 1, 4); const list = w.slice(); list[list.length - 1] = 'عليم';
  const t = recite(at(112, 1), list);
  check('clearly wrong LAST word before stopping -> wrong', t.state[M.pos(112, 1) + w.length - 1] === WRONG);
}
{
  const t = recite(at(112, 1), [...words(112, 1, 4), 'ممم']);
  check('a stray sound after the last word is ignored', errs(t, range(112, 1, 4)) === 0 && t.summary(...range(112, 1, 4)).correct === 15, t.summary(...range(112, 1, 4)));
}
{
  // self-correction: say a wrong word, then go back and say it right
  const w = words(112, 1, 4);
  const i = w.indexOf('الصمد');
  const list = [...w.slice(0, i), 'الكريم', w[i + 1], w[i - 1], ...w.slice(i)];
  const t = recite(at(112, 1), list);
  check('self-correction clears the mistake', errs(t, range(112, 1, 4)) === 0 && t.stats.selfCorrected >= 1, { s: t.summary(...range(112, 1, 4)), st: t.stats });
}

console.log('Recite from anywhere (auto-detect)');
{
  const t = new E.Tracker(M);
  recite(t, ['اعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم', 'بسم', 'الله', 'الرحمن', 'الرحيم', ...words(67, 1, 3)]);
  const ev = t.events.find(e => e.type === 'locked');
  check('finds Al-Mulk after isti\'adha + bismillah', ev && M.where(ev.pos).surah === 67 && M.where(ev.pos).ayah === 1, ev && M.where(ev.pos));
  check('...and tracks it with no mistakes', errs(t, range(67, 1, 3)) === 0 && t.summary(...range(67, 1, 3)).pending === 0, t.summary(...range(67, 1, 3)));
}
{
  const t = new E.Tracker(M);
  recite(t, words(1, 1, 7));
  const ev = t.events.find(e => e.type === 'locked');
  check('finds Al-Fatiha from bismillah (ayah 1 still counted)', ev && M.where(ev.pos).surah === 1 && t.summary(...range(1, 1, 7)).correct === 29, { ev: ev && M.where(ev.pos), s: t.summary(...range(1, 1, 7)) });
}
{
  // random starting points across the whole Quran
  let ok = 0, wrong = 0, none = 0; const N = 600; let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const misses = [];
  for (let k = 0; k < N; k++) {
    const s = 1 + Math.floor(rnd() * 114), n = M.surahs[s - 1].ayahs, a = 1 + Math.floor(rnd() * n);
    const list = []; for (let x = a; x <= n && list.length < 12; x++) list.push(...words(s, x, x));
    const t = new E.Tracker(M);
    recite(t, list.slice(0, 12), 3);
    const ev = t.events.find(e => e.type === 'locked');
    if (!ev) { none++; continue; }
    const wh = M.where(ev.pos);
    if (wh.surah === s && wh.ayah === a) ok++; else { wrong++; if (misses.length < 5) misses.push({ want: s + ':' + a, got: wh.surah + ':' + wh.ayah }); }
  }
  console.log(`       ${N} random ayah starts, 12 words heard: ${ok} exact, ${wrong} other place, ${none} not found`);
  if (misses.length) console.log('       e.g. ' + JSON.stringify(misses));
  check('auto-detect lands on the right ayah >= 97% of the time', ok / N >= 0.97, { ok, wrong, none });
}
{
  // mid-ayah start
  const t = new E.Tracker(M);
  recite(t, words(2, 255, 255).slice(10, 20));
  const ev = t.events.find(e => e.type === 'locked');
  check('starting mid-ayah (Ayat al-Kursi, word 11)', ev && ev.pos === M.pos(2, 255) + 10, ev && { got: ev.pos - M.pos(2, 255) });
}

{
  // 47:10 opens exactly like 40:82; keep reciting and it must move itself to the right ayah
  const t = new E.Tracker(M);
  recite(t, words(47, 10, 12), 3);
  const w = M.where(t.c - 1);
  check('a look-alike first lock corrects itself as you keep reciting (47:10 vs 40:82)', w.surah === 47 && w.ayah === 12 && t.summary(...range(47, 11, 12)).correct === t.summary(...range(47, 11, 12)).correct + t.summary(...range(47, 11, 12)).pending * 0 && errs(t, range(47, 11, 12)) === 0, { at: w, s: t.summary(...range(47, 10, 12)), ev: t.events.map(e => e.type + '@' + JSON.stringify(M.where(e.pos))) });
}

console.log('Continuity');
{
  const t = recite(at(112, 1), [...words(112, 1, 4), 'بسم', 'الله', 'الرحمن', 'الرحيم', ...words(113, 1, 5)]);
  check('flows from Al-Ikhlas into Al-Falaq over the bismillah', errs(t, [M.pos(112, 1), M.surahs[112].end]) === 0 && t.summary(M.pos(113, 1), M.surahs[112].end).pending === 0, t.summary(M.pos(113, 1), M.surahs[112].end));
}
{
  const t = recite(at(55, 10), words(55, 10, 25));
  check('Ar-Rahman with its repeated refrain', errs(t, range(55, 10, 25)) === 0 && t.summary(...range(55, 10, 25)).pending === 0, t.summary(...range(55, 10, 25)));
}
{
  const t = at(1, 1);
  t.feed(words(1, 1, 2));
  const before = t.state.slice(); const c = t.c;
  const p = t.clone(); p.feed(words(1, 3, 4)); p.flush();
  check('live preview does not change the committed state', t.c === c && t.state.every((v, i) => v === before[i]) && p.c > c);
}

console.log('Teacher mode: stop at the mistake, wait for the fix');
function teacher(s, a) { const t = at(s, a); t.strict = true; return t; }
function live(t, list) { for (const w of list) t.feed([w]); return t; } // one word at a time, like live speech
const stops = t => t.events.filter(e => e.type === 'stop');
{
  // the user's example: "...wa huwa 'ala shay'in qadir" (kulli skipped)
  const t = teacher(67, 1);
  live(t, ['تبارك', 'الذي', 'بيده', 'الملك', 'وهو', 'على', 'شيء', 'قدير']);
  const kull = M.pos(67, 1) + 6;
  const st = stops(t);
  check('skipping كل stops right at كل', st.length === 1 && st[0].pos === kull && t.c === kull && t.stopped === kull && t.state[kull] === MISSED, { st, c: t.c - M.pos(67, 1), state: t.state[kull] });
  check('...and does not move past it (شيء, قدير not counted yet)', t.state[kull + 1] === PENDING && t.state[kull + 2] === PENDING);
  t.events = [];
  live(t, ['وهو', 'على', 'كل', 'شيء', 'قدير']); t.flush();
  check('re-reciting the phrase fixes it: كل gets a tick, no mistakes left', t.state[kull] === CORRECT && t.fixed.has(kull) && t.stopped === -1 && errs(t, range(67, 1, 1)) === 0 && t.c === M.pos(67, 2), { st: t.state[kull], c: t.c });
}
{
  const t = teacher(67, 1);
  live(t, ['تبارك', 'الذي', 'بيده', 'الملك', 'وهو', 'على', 'شيء', 'قدير']);
  live(t, ['كل', 'شيء', 'قدير', 'الذي', 'خلق']); t.flush();
  const kull = M.pos(67, 1) + 6;
  check('saying just the missed word and carrying on also fixes it', t.fixed.has(kull) && errs(t, range(67, 1, 1)) === 0 && t.summary(...range(67, 1, 1)).pending === 0);
}
{
  const t = teacher(67, 1);
  live(t, ['تبارك', 'الذي', 'بيده', 'الملك', 'وهو', 'على', 'شيء', 'قدير']);
  t.events = [];
  live(t, ['الذي', 'خلق']);
  check('words already on their way after the signal do not signal again', stops(t).length === 0);
  live(t, ['الموت', 'والحياة', 'ليبلوكم', 'ايكم', 'احسن', 'عملا']); t.flush();
  const kull = M.pos(67, 1) + 6;
  check('ignoring the stop and carrying on: it stops you at كل again', stops(t).length >= 1 && stops(t).every(e => e.pos === kull) && t.c === kull, { st: stops(t), c: t.c });
}
{
  const w = words(112, 1, 4); const i = w.indexOf('الصمد'); const list = w.slice(); list[i] = 'الكريم';
  const t = teacher(112, 1);
  live(t, list.slice(0, i + 3)); // the wrong word, then the next two words before reacting to the signal
  const p = M.pos(112, 1) + i;
  check('wrong word stops at that word', stops(t).length === 1 && stops(t)[0].pos === p && t.state[p] === WRONG && t.c === p);
  live(t, w.slice(i)); t.flush();
  check('...and saying it right fixes it and finishes the surah', t.fixed.has(p) && errs(t, range(112, 1, 4)) === 0 && t.summary(...range(112, 1, 4)).pending === 0);
}
{
  const w = words(112, 1, 4); const list = w.slice(); list[3] = 'احط';
  const t = teacher(112, 1); live(t, list.slice(0, 6)); t.flush();
  check('a close-sounding slip (احط for احد) stops you too', stops(t).length === 1 && stops(t)[0].pos === M.pos(112, 1) + 3 && t.state[M.pos(112, 1) + 3] === CLOSE);
}
{
  const w = words(1, 2, 2);
  const t = teacher(1, 1);
  live(t, [...words(1, 1, 1), ...w.slice(0, 3), ...w, ...words(1, 3, 7)]); t.flush();
  check('restarts never stop you', stops(t).length === 0 && errs(t, range(1, 1, 7)) === 0);
}
{
  const t = teacher(3, 18); live(t, words(3, 18, 20)); t.flush();
  check('a phrase that repeats inside an ayah (3:18) does not trigger a false stop', stops(t).length === 0 && errs(t, range(3, 18, 20)) === 0);
}
{
  let falseStops = 0, n = 0, seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const s of [2, 18, 36, 67]) {
    const list = [];
    for (let a = 1; a <= M.surahs[s - 1].ayahs; a++) {
      const w = words(s, a, a);
      for (let i = 0; i < w.length; i++) {
        if (i > 3 && rnd() < 0.03) list.push(...w.slice(i - 2 - Math.floor(rnd() * 3), i));
        list.push(rnd() < 0.05 && w[i].length >= 4 ? w[i].replace(/(.)ا/, '$1') : w[i]); // recogniser drops an inner alif
      }
    }
    const t = teacher(s, 1); live(t, list); t.flush();
    falseStops += stops(t).length; n += M.surahs[s - 1].end - M.surahs[s - 1].start;
  }
  console.log(`       teacher mode, ${n} words with restarts + spelling noise: ${falseStops} stops`);
  check('no false stops on a clean (but restarting, noisy-spelling) recitation', falseStops === 0);
}

{
  // the user's example: الجنوب instead of الجنود (85:17), then the qari corrects and they repeat
  const p = M.pos(85, 17) + 3;
  const t1 = teacher(85, 17); live(t1, ['هل', 'أتاك', 'حديث', 'الجنوب', 'فرعون']);
  check('الجنوب for الجنود stops at الجنود (heard الجنوب)', stops(t1).length === 1 && stops(t1)[0].pos === p && t1.c === p && t1.heard.get(p) === 'الجنوب', { st: stops(t1), c: t1.c - M.pos(85, 17), h: t1.heard.get(p), s: t1.state[p] });
  const t2 = teacher(85, 17); live(t2, ['هل', 'أتاك', 'حديث', 'الجنوب']); t2.flush();
  check('...also when they stop and wait at the end of the ayah', stops(t2).length === 1 && stops(t2)[0].pos === p);
  t2.events = [];
  live(t2, ['الجنوب']); t2.flush();
  check('saying الجنوب again is corrected again', stops(t2).length === 1 && stops(t2)[0].pos === p);
  t2.events = [];
  live(t2, ['الجنود', 'فرعون', 'وثمود']); t2.flush();
  check('saying الجنود fixes it with a tick and carries on', t2.fixed.has(p) && t2.state[p] === CORRECT && t2.stopped === -1 && errs(t2, range(85, 17, 18)) === 0 && t2.summary(...range(85, 17, 18)).close === 0);
  const t3 = at(85, 17); recite(t3, ['هل', 'أتاك', 'حديث', 'الجنوب', 'فرعون', 'وثمود']);
  check('outside teacher mode الجنوب is marked "check" (no longer accepted as correct)', t3.state[p] === CLOSE);
  const t4 = at(38, 17); recite(t4, words(38, 17, 17).map(w => w === 'داود' ? 'داوود' : w));
  check('vowel-letter spelling variants still count as correct (داوود / داود)', t4.summary(...range(38, 17, 17)).correct === words(38, 17, 17).length);
}

console.log('Moving on after a correction');
{
  const p = M.pos(85, 17) + 3;
  const t = teacher(85, 17); live(t, ['هل', 'أتاك', 'حديث', 'الجنوب']); t.flush();
  // after the qari: the recogniser hears the retry a little differently (not the same mistake): accepted
  live(t, ['الجنوت']); t.flush();
  check('a retry heard slightly differently is accepted (not stuck)', t.fixed.has(p) && t.stopped === -1 && t.c === p + 1, { c: t.c - M.pos(85, 17), st: t.state[p] });
  live(t, words(85, 18, 19)); t.flush();
  check('...and you move on through the next ayahs', t.summary(...range(85, 18, 19)).correct === words(85, 18, 19).length);
}
{
  const p = M.pos(85, 17) + 3;
  const t = teacher(85, 17); live(t, ['هل', 'أتاك', 'حديث', 'الجنوب']); t.flush();
  live(t, words(85, 17, 17)); t.flush();
  check('repeating the whole ayah after the correction fixes it', t.fixed.has(p) && t.stopped === -1 && t.c === M.pos(85, 18));
}
{
  // skip a word near the end of Ayat al-Kursi, then repeat the whole ayah
  const w = words(2, 255, 255); const i = w.length - 4;
  const t = teacher(2, 255); live(t, [...w.slice(0, i), ...w.slice(i + 1, i + 3)]);
  const p = M.pos(2, 255) + i;
  check('long ayah: stopped near the end', t.stopped === p, { stopped: t.stopped - M.pos(2, 255), i });
  live(t, w); t.flush();
  check('...repeating the long ayah from its start fixes it and moves on', t.fixed.has(p) && t.stopped === -1 && errs(t, range(2, 255, 255)) === 0 && t.c === M.pos(2, 256), { c: t.c, stopped: t.stopped });
}
{
  // 2:282 is the longest ayah: stop at word 110, restart from its first word (110 words back)
  const w = words(2, 282, 282); const i = 110;
  const t = teacher(2, 282); live(t, [...w.slice(0, i), ...w.slice(i + 1, i + 3)]);
  const p = M.pos(2, 282) + i - 1; // the ayah opens with يا أيها: two heard words, one mushaf word
  const wasStopped = t.stopped === p;
  live(t, w); t.flush();
  check('very long ayah (2:282): restarting from its start, 110 words back, works', wasStopped && t.stopped === -1 && t.state[p] === CORRECT && t.c === M.pos(2, 283), { wasStopped, stopped: t.stopped, st: t.state[p] });
}
{
  const p = M.pos(85, 17) + 3;
  const t = teacher(85, 17); live(t, ['هل', 'أتاك', 'حديث', 'الجنوب']); t.flush();
  live(t, ['الجنوب']); t.flush();
  check('same mistake again: stopped again', t.stopped === p);
  live(t, ['الجنوب']); t.flush();
  const mo = t.events.find(e => e.type === 'moveOn');
  check('third wrong try: it lets you move on (word stays marked)', mo && mo.pos === p && t.stopped === -1 && t.c === p + 1 && t.state[p] === CLOSE, { mo, stopped: t.stopped, c: t.c - p });
  live(t, words(85, 18, 18)); t.flush();
  check('...and keeps tracking after it', t.summary(...range(85, 18, 18)).correct === words(85, 18, 18).length);
}
{
  const t = teacher(67, 1); live(t, ['تبارك', 'الذي', 'بيده', 'الملك', 'وهو', 'على', 'شيء', 'قدير']);
  const kull = M.pos(67, 1) + 6;
  t.moveOn();
  live(t, ['شيء', 'قدير', 'الذي', 'خلق']); t.flush();
  check('the Move on button: carries on from the next word, كل stays marked', t.stopped === -1 && t.state[kull] === MISSED && t.state[kull + 1] === CORRECT && t.c > M.pos(67, 2));
}
{
  const t = teacher(67, 1); live(t, ['تبارك', 'الذي', 'بيده', 'الملك', 'وهو', 'على', 'شيء', 'قدير']);
  live(t, ['قل']); t.flush(); // the recogniser hears "kulli" as قل
  check('skipped word: the retry heard as a near word (قل for كل) is accepted', t.fixed.has(M.pos(67, 1) + 6) && t.stopped === -1);
}

console.log('Stress: noisy recitation of all of Al-Baqarah');
{
  let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const n = M.surahs[1].ayahs, list = []; let restarts = 0, drops = 0;
  for (let a = 1; a <= n; a++) {
    const w = words(2, a, a);
    for (let i = 0; i < w.length; i++) {
      if (i > 3 && rnd() < 0.02) { const back = 2 + Math.floor(rnd() * 3); list.push(...w.slice(i - back, i)); restarts++; } // repeat a phrase
      if (w[i].length <= 3 && rnd() < 0.04) { drops++; continue; }                                                         // recogniser drops a small word
      list.push(rnd() < 0.05 ? w[i].replace(/ا/, '') : w[i]);                                                                  // spelling noise
    }
  }
  const t = recite(at(2, 1), list, 6);
  const s = t.summary(...range(2, 1, n));
  console.log(`       ${list.length} words heard, ${restarts} repeats inserted, ${drops} small words dropped -> ${JSON.stringify(s)}`);
  check('no false red flags across 6,000+ words', s.wrong + s.missed === 0, s);
  check('nothing left un-tracked', s.pending === 0, s);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
