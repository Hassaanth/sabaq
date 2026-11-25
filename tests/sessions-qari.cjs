// Corrections after the qari and ayahs that open alike, run through the real microphone path with recited audio
// (tests/user-sim.js); driven like tests/sessions.cjs (fake mic + speech server).
// Corrections after the qari: the reciter waits for "Your turn" (the qari said the word), then corrects in different ways
const W = { s: 36, a: 82, w: [2, 2] };   // a wrong word (أمره) in place of يخلق (36:81 word 9)
const fixed = r => r.marks.fixed && r.marks.fixed.length === 1 && !r.marks.wrong && !r.marks.missed && +r.tally.split('/')[0] >= 40;
const pre = [{ tap: true }, { pause: 1500 }, '36:79', { pause: 700 }, '36:80', { pause: 700 }, '36:81:1-8', W, '36:81:10'];
const post = [{ pause: 700 }, '36:82', { pause: 700 }, '36:83', { pause: 4000 }, { tap: true }];
module.exports = {
  // after the qari: the whole ayah again from its start
  'qari-ayah': { open: 36, rate: 1, script: [...pre, { until: 'Your turn', max: 15000 }, { pause: 400 }, '36:81', ...post], expect: fixed },
  // after the qari: two words back
  'qari-back2': { open: 36, rate: 1, script: [...pre, { until: 'Your turn', max: 15000 }, { pause: 400 }, '36:81:7-14', ...post], expect: fixed },
  // after the qari: the word alone, a breath, then the ayah again from its start
  'qari-word-ayah': { open: 36, rate: 1, script: [...pre, { until: 'Your turn', max: 15000 }, { pause: 400 }, '36:81:9', { pause: 900 }, '36:81', ...post], expect: fixed },
  // after the qari, with another reciter's voice (Husary)
  'qari-ayah-husary': { open: 36, rate: 1, reciter: 6, script: [...pre, { until: 'Your turn', max: 15000 }, { pause: 400 }, '36:81', ...post], expect: fixed },
};
// ayahs that open alike, with the other surah open (recited audio)
Object.assign(module.exports, {
  'open-mulk-in-furqan': { open: 25, rate: 1, script: [{ tap: true }, { pause: 1500 }, '67:1', { pause: 700 }, '67:2', { pause: 4000 }, { tap: true }], expect: r => !r.marks.wrong && !r.marks.missed && !r.marks.check && !r.timeline.some(l => /Stopped/.test(l)) && +r.tally.split('/')[0] >= 15 },
  'open-furqan61-in-mulk': { open: 67, rate: 1, script: [{ tap: true }, { pause: 1500 }, '25:61', { pause: 700 }, '25:62', { pause: 4000 }, { tap: true }], expect: r => !r.marks.wrong && !r.marks.missed && !r.marks.check && !r.timeline.some(l => /Stopped/.test(l)) && +r.tally.split('/')[0] >= 15 },
});
// leaving a surah unfinished for another one is a mistake where the reciter left; a finished surah is not
const went = r => r.timeline.some(l => /You went into Al-Fil/.test(l)) && r.marks.wrong && r.marks.wrong.length === 1;
Object.assign(module.exports, {
  'veer-ikhlas-fil': { open: 112, rate: 1, script: [{ tap: true }, { pause: 1500 }, '112:1', { pause: 700 }, '105:1', { pause: 6000 }, { tap: true }], expect: went },
  'veer-ikhlas-fil-mulk-open': { open: 67, rate: 1, script: [{ tap: true }, { pause: 1500 }, '112:1', { pause: 700 }, '105:1', { pause: 6000 }, { tap: true }], expect: went },
  'finish-ikhlas-then-fil': { open: 112, rate: 1, script: [{ tap: true }, { pause: 1500 }, '112:1', { pause: 600 }, '112:2', { pause: 600 }, '112:3', { pause: 600 }, '112:4', { pause: 900 }, '105:1', { pause: 600 }, '105:2', { pause: 4000 }, { tap: true }],
    expect: r => !r.marks.wrong && !r.marks.missed && !r.timeline.some(l => /Stop/.test(l)) && r.timeline.some(l => /Al-Fil 105/.test(l)) },
});
