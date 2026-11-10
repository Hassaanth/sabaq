// Dev-only stand-in for the browser's SpeechRecognition (loaded by serve.js at /?fakesr=ios or /?fakesr=android).
// Lets the real app be driven with the result patterns phones produce:
//   ios:     results are never marked final while listening, and (continuous off) each phrase ends the session
//   android: one final result per phrase, each repeating all the earlier text; the session keeps going
// Extra flags: &firstfail=1  the first start fails with service-not-allowed (Dictation off)
//              &refuse=1     restarts after the first session are refused with service-not-allowed
// Drive it from the console: await __say(['هل','أتاك', ...], {pause: 1500}) ; __endSession()
(function () {
  const qs = new URLSearchParams(location.search);
  const mode = qs.get('fakesr') || 'ios', firstFail = qs.get('firstfail') === '1', refuse = qs.get('refuse') === '1';
  let current = null, starts = 0;
  class FakeSR {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = ''; this.heard = []; this.done = []; this.live = false; }
    start() {
      if (this.live) throw new Error('InvalidStateError: already started');
      starts++;
      current = this; this.heard = []; this.done = [];
      if ((firstFail && starts === 1) || (refuse && starts > 1)) {
        setTimeout(() => { this.onerror && this.onerror({ error: 'service-not-allowed' }); this.onend && this.onend(); }, 5);
        return;
      }
      this.live = true;
      setTimeout(() => this.onstart && this.onstart(), 5);
    }
    stop() { this.live = false; setTimeout(() => this.onend && this.onend(), 5); }
    _emit() {
      let results;
      if (mode === 'android') {
        results = this.done.map(t => Object.assign([{ transcript: t }], { isFinal: true }));
        if (this.heard.length) results.push(Object.assign([{ transcript: this.heard.join(' ') }], { isFinal: false }));
      } else {
        results = [Object.assign([{ transcript: [...this.done, ...this.heard].join(' ') }], { isFinal: false })];
      }
      this.onresult && this.onresult({ results });
    }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  window.__say = async (words, opts = {}) => {
    const c = current;
    if (!c || !c.live) { window.__dropped = (window.__dropped || 0) + words.length; await sleep(opts.pause || 0); return; } // nobody listening
    for (const w of words) { c.heard.push(w); c._emit(); await sleep(opts.gap || 250); }
    if (mode === 'android') { const prev = c.done[c.done.length - 1] || ''; c.done.push((prev ? prev + ' ' : '') + c.heard.join(' ')); c.heard = []; c._emit(); }
    else {
      c.done.push(...c.heard); c.heard = [];
      if (!c.continuous) { await sleep(80); c.live = false; c.onend && c.onend(); } // iPhone: the phrase ends the session
    }
    await sleep(opts.pause || 0);
  };
  window.__endSession = () => { const c = current; c.live = false; c.onend && c.onend(); };
  window.__fakeMode = mode;
  window.__fakeIOS = mode === 'ios';
  window.__starts = () => starts;
})();
