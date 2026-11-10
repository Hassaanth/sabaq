// Builds quran-data.js from the two alquran.cloud (Tanzil) editions.
// Usage: node tools/build-data.js <uthmani.json> <simple-clean.json> <out.js>
const fs = require('fs');
const [, , uPath, cPath, outPath] = process.argv;
const U = JSON.parse(fs.readFileSync(uPath, 'utf8')).data.surahs;
const C = JSON.parse(fs.readFileSync(cPath, 'utf8')).data.surahs;
const LETTER = /[ء-غف-يٱ-ۓ]/;
const tok = s => s.replace(/﻿/g, '').trim().split(/\s+/).filter(t => LETTER.test(t));
const BISM_C = ['بسم', 'الله', 'الرحمن', 'الرحيم'];
const VOC = new Set(['يا', 'ويا', 'فيا', 'ها', 'وي']);
let merged = 0, mismatch = 0, stripped = 0, words = 0;
const out = U.map((su, si) => {
  const sc = C[si];
  const ayahs = su.ayahs.map((a, ai) => {
    let u = tok(a.text), c = tok(sc.ayahs[ai].text);
    if (su.number !== 1 && ai === 0 && BISM_C.every((w, i) => c[i] === w)) {
      c = c.slice(4); u = u.slice(4); stripped++;
    }
    if (u.length !== c.length) {
      // Simple script splits vocatives ("يا أيها"); Uthmani joins them ("يَٰٓأَيُّهَا"). Merge with "_".
      let need = c.length - u.length; const m = [];
      for (let j = 0; j < c.length; j++) {
        if (need > 0 && VOC.has(c[j]) && j + 1 < c.length) { m.push(c[j] + '_' + c[j + 1]); j++; need--; }
        else m.push(c[j]);
      }
      if (m.length === u.length) { merged++; c = m; } else { mismatch++; u = null; }
    }
    words += c.length;
    // [display words or null (use clean), clean words]
    return [(u || c.map(w => w.replace('_', ' '))).join(' '), c.join(' ')];
  });
  return { n: su.number, ar: su.name.replace(/^سُورَةُ\s*/, ''), en: su.englishName, tr: su.englishNameTranslation, a: ayahs };
});
fs.writeFileSync(outPath, '/* Quran text: Tanzil Project (tanzil.net), via alquran.cloud. Uthmani display + simple-clean matching. */\nwindow.QURAN=' + JSON.stringify(out) + ';\n');
console.log({ surahs: out.length, words, bismillahStripped: stripped, vocativeMerged: merged, uthmaniTokenMismatchFallbacks: mismatch, bytes: fs.statSync(outPath).size });
