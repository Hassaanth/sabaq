// Ayahs that open alike (تبارك الذي: 25:1, 25:10, 25:61, 67:1): starting one with another surah open, the words after
// the shared opening decide which ayah it is; no stop. Recited on from the ayah before, going off into the other
// ayah is still a slip.  node tests/shared-opening.test.js
const fs = require('fs'), path = require('path');
global.window = {}; eval(fs.readFileSync(path.join(__dirname, '..', 'quran-data.js'), 'utf8'));
const E = require('../engine.js'); const M = new E.Mushaf(window.QURAN);
const ayah = (s, a) => M.keys.slice(M.ayahPos[s - 1][a - 1], a < M.surahs[s - 1].ayahs ? M.ayahPos[s - 1][a] : M.surahs[s - 1].end);
const where = p => { const w = M.where(p); return w.surah + ':' + w.ayah; };
let pass = 0, fail = 0;
function run(name, open, words, check) {
  const T = new E.Tracker(M); T.strict = true; T.hint = [M.surahs[open - 1].start, M.surahs[open - 1].end];
  for (const w of words) T.feed([w]); T.flush();
  const stops = T.events.filter(e => e.type === 'stop').map(e => M.disp[e.pos] + ' ' + where(e.pos));
  const ok = check(T, stops);
  console.log((ok ? '  ok   ' : '  FAIL ') + name + '  (at ' + (T.c >= 0 ? where(Math.max(0, T.c - 1)) : '-') + ', stops: ' + (stops.join(', ') || 'none') + ')');
  ok ? pass++ : fail++;
}
run('Mulk 67:1 with Furqan open', 25, ayah(67, 1), (T, st) => !st.length && M.sOf[T.c - 1] === 66);
run('Furqan 25:61 with Mulk open', 67, ayah(25, 61), (T, st) => !st.length && where(T.c - 1) === '25:61');
run('Furqan 25:10 with Mulk open', 67, ayah(25, 10), (T, st) => !st.length && where(T.c - 1) === '25:10');
run('Furqan 25:61 with Furqan open (from its start)', 25, ayah(25, 61), (T, st) => !st.length && where(T.c - 1) === '25:61');
run('Mulk 67:1 then 67:2 with Furqan open', 25, [...ayah(67, 1), ...ayah(67, 2)], (T, st) => !st.length && where(T.c - 1) === '67:2');
// recited on from 25:60 into 25:61, then Mulk's words: a slip between similar ayahs
run('25:60 then 25:61 going on as 67:1: still a slip', 25, [...ayah(25, 60), ...ayah(25, 61).slice(0, 2), ...ayah(67, 1).slice(2)], (T, st) => st.length > 0);
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
