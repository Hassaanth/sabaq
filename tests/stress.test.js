// Run: node tests/stress.test.js
// Simulates noisy recitations of many surahs: repeats/restarts, recogniser drops, spelling noise,
// plus deliberately planted real mistakes. Measures false alarms and how many real mistakes are caught.
const fs = require('fs'), path = require('path');
const E = require('../engine.js');
const win = {}; new Function('window', fs.readFileSync(path.join(__dirname, '..', 'quran-data.js'), 'utf8'))(win);
const M = new E.Mushaf(win.QURAN);

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];
const vocab = [...new Set(M.keys.filter(k => k.length >= 4))];

function simulate(s, plantMistakes) {
  const su = M.surahs[s - 1];
  const heard = [], planted = new Map(); // pos -> 'wrong' | 'missed'
  for (let a = 1; a <= su.ayahs; a++) {
    const p0 = M.pos(s, a);
    const w = win.QURAN[s - 1].a[a - 1][1].split(' ');
    for (let i = 0; i < w.length; i++) {
      const p = p0 + i;
      const parts = w[i].split('_');
      // a restart: go back 2-5 words (within the ayah) and say them again
      if (i > 3 && rnd() < 0.03) { const b = 2 + Math.floor(rnd() * 4); for (let j = Math.max(0, i - b); j < i; j++) heard.push(...w[j].split('_')); }
      if (plantMistakes && i > 0 && i < w.length - 1 && w[i].length >= 4 && rnd() < 0.015) {
        if (rnd() < 0.5) {
          let x; do { x = pick(vocab); } while (E.sim(x, M.keys[p]) >= 0.5);
          heard.push(x); planted.set(p, 'wrong'); continue;
        }
        // skip 3 words that are not small ones
        if (i + 3 < w.length && w.slice(i, i + 3).every(t => t.length >= 4)) {
          for (let j = 0; j < 3; j++) planted.set(p + j, 'missed');
          i += 2; continue;
        }
      }
      if (M.keys[p].length <= 3 && rnd() < 0.04) continue;                        // recogniser drops a small word
      if (rnd() < 0.01) heard.push(pick(['اه', 'ممم', 'يعني']));                  // stray sound / filler
      for (const part of parts) heard.push(rnd() < 0.05 ? part.replace(/ا/, '') : part); // spelling noise
    }
  }
  return { heard, planted, from: su.start, to: su.end };
}

function run(s, plant, chunk) {
  const sim = simulate(s, plant);
  const t = new E.Tracker(M);
  t.setPosition(sim.from);
  for (let i = 0; i < sim.heard.length; i += chunk) {
    t.feed(sim.heard.slice(i, i + chunk));
    if (rnd() < 0.3) { const pv = t.clone(); pv.feed(sim.heard.slice(i + chunk, i + chunk + 3)); } // live preview, discarded
  }
  t.flush();
  let falseRed = 0, caught = 0, plantedN = sim.planted.size, pending = 0;
  for (let p = sim.from; p < sim.to; p++) {
    const st = t.state[p], red = st === E.WRONG || st === E.MISSED;
    if (sim.planted.has(p)) { if (red || st === E.CLOSE) caught++; }
    else if (red) falseRed++;
    if (st === E.PENDING) pending++;
  }
  return { words: sim.to - sim.from, falseRed, caught, plantedN, pending };
}

const surahs = [1, 2, 3, 12, 18, 36, 55, 56, 67, 78, 112, 113, 114];
let tot = { words: 0, falseRed: 0, caught: 0, plantedN: 0, pending: 0 };
for (const plant of [false, true]) {
  for (const s of surahs) {
    for (const chunk of [3, 7]) {
      const r = run(s, plant, chunk);
      for (const k in tot) tot[k] += r[k];
      if (r.falseRed || r.pending) console.log(`  surah ${s} plant=${plant} chunk=${chunk}:`, r);
    }
  }
}
const fa = tot.falseRed / tot.words * 100, rec = tot.caught / tot.plantedN * 100;
console.log(`\n${tot.words} words tracked | false red flags: ${tot.falseRed} (${fa.toFixed(3)}%) | planted mistakes caught: ${tot.caught}/${tot.plantedN} (${rec.toFixed(1)}%) | untracked words: ${tot.pending}`);
const ok = fa < 0.1 && rec >= 90 && tot.pending / tot.words < 0.002;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
