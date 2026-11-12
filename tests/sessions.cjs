// Realistic sessions through the real microphone path (fake mic + simulated reciter), each in a fresh page,
// iPhone-sized, CPU slowed (SLOW, default 4). Prints what the reciter would see: tally, marks, key moments.
const fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PW_DIR + '/node_modules/playwright');
const SESSIONS = {
  // the qari corrects a skipped word, the reciter repeats from it: stop, qari, fixed
  skipword: { open: 67, rate: 1, script: [{ tap: true }, { pause: 2000 }, '67:1', { pause: 1200 }, '67:2', { pause: 1000 }, '67:3:1-6', '67:3:8-18', { until: 'Your turn', max: 15000 }, { pause: 600 }, '67:3:7-18', { pause: 5000 }, { tap: true }],
    expect: r => r.marks.fixed && r.marks.fixed.length === 1 && !r.marks.wrong && !r.marks.missed },
  // the user's example: "tabarakalladhi biyadihi" then "malakutu kulli shay'in wa ilayhi turja'un" (36:83)
  wrongayah: { open: 67, rate: 1, script: [{ tap: true }, { pause: 2000 }, '67:1:1-3', { s: 36, a: 83, w: [4, 8] }, { pause: 6000 }, { tap: true }],
    expect: r => !!(r.marks.wrong || r.marks.missed || r.timeline.some(l => /Stop|Your turn|not right/.test(l))) },
  // skip: 67:2 to "ahsanu 'amala", then 67:3 from "alladhi khalaqa"
  skipayah: { open: 67, rate: 1, script: [{ tap: true }, { pause: 2000 }, '67:2:1-8', '67:3:1-6', { pause: 6000 }, { tap: true }],
    expect: r => r.timeline.some(l => /Stop|Your turn|skipped|missed/i.test(l)) },
  // fast and fluent: 67:1-5 at 1.7x, short breaths; nothing should be marked
  fast: { open: 67, rate: 1.7, script: [{ tap: true }, { pause: 1500 }, '67:1', { pause: 300 }, '67:2', { pause: 300 }, '67:3', { pause: 300 }, '67:4', { pause: 300 }, '67:5', { pause: 3000 }, { tap: true }],
    expect: r => r.tally.startsWith('60/') && !r.marks.wrong && !r.marks.missed && !r.marks.fixed },
  // hesitant: stops mid-ayah, thinks, restarts the ayah, carries on; nothing should be marked
  restart: { open: 67, rate: 1, script: [{ tap: true }, { pause: 1500 }, '67:1', { pause: 800 }, '67:2:1-5', { pause: 2500 }, '67:2', { pause: 700 }, '67:3:1-9', { pause: 3000 }, { tap: true }],
    expect: r => !r.marks.wrong && !r.marks.missed && !r.marks.fixed },
};
(async () => {
  const P = process.env.PROJ, only = (process.env.ONLY || '').split(',').filter(Boolean);
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
  let pass = 0, n = 0;
  for (const [name, S] of Object.entries(SESSIONS)) {
    if (only.length && !only.includes(name)) continue;
    const ctx = await browser.newContext({ colorScheme: process.env.DARK ? 'dark' : 'light', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    await ctx.addInitScript({ content: fs.readFileSync(path.join(P, 'tests/fake-mic.js'), 'utf8') + '\n' + fs.readFileSync(path.join(P, 'tests/user-sim.js'), 'utf8') + `
      window.__asrLog = []; window.__simRate = ${S.rate};
      localStorage.setItem('sabaq.recognizer2', JSON.stringify('model')); localStorage.setItem('sabaq.surah', ${S.open});
      localStorage.setItem('sabaq.asrServer', JSON.stringify(${JSON.stringify(process.env.ASR || 'ws://localhost:8787/asr')}));` });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: +(process.env.SLOW || 4) });
    await page.goto(process.env.URL || 'http://localhost:8787/');
    await page.waitForTimeout(2500);
    const r = await page.evaluate(async script => { __sim.startRecording(); const t0 = performance.now(); await __sim.run(script); const rep = __sim.report(); rep.asr = __asrLog.filter(x => x.kind !== 'partial' && !/^locked|^  suspect/.test(x.text)).map(x => ((x.at - t0) / 1000).toFixed(1) + ' ' + x.kind + ' ' + x.seg + ' ' + (x.text || '')); return rep; }, S.script);
    if (process.env.SHOT) { await page.evaluate(() => { const w = document.querySelector('.w.fx') || document.querySelector('.w.s4'); if (w) w.scrollIntoView({ block: 'center' }); }); await page.waitForTimeout(400); await page.screenshot({ path: process.env.SHOT + '-' + name + '.png' }); }
    const ok = S.expect(r) && !errs.filter(e => !/404/.test(e)).length;
    n++; if (ok) pass++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name + '  tally ' + r.tally + '  marks ' + JSON.stringify(r.marks));
    if (!ok || process.env.VERBOSE) console.log(r.timeline.filter(l => !/^\S+ Following you · Al-Mulk 67:\d+( · reading…)?  @/.test(l)).slice(0, 60).join('\n'));
    if (process.env.ASRLOG) console.log(r.asr.join(String.fromCharCode(10)));
    if (errs.length) console.log('  errors: ' + errs.slice(0, 4).join(' | '));
    await ctx.close();
  }
  console.log(pass + '/' + n + ' sessions passed');
  await browser.close();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
