// Dev-only stand-in for the browser's SpeechRecognition (loaded by serve.js at /?fakesr=ios or /?fakesr=android).
// Lets the real app be driven with the result patterns phones produce:
//   ios:     one growing result that is never marked final while listening
//   android: one final result per phrase, each repeating all the earlier text
// Drive it from the console: await __say(['هل','أتاك', ...], {pause: 1500}) ; __endSession()
(function () {
  const mode = new URLSearchParams(location.search).get('fakesr') || 'ios';
  let current = null;
  class FakeSR {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = ''; this.heard = []; this.done = []; }
    start() { current = this; this.heard = []; this.done = []; setTimeout(() => this.onstart && this.onstart(), 5); }
    stop() { setTimeout(() => this.onend && this.onend(), 5); }
    _emit() {
      let results;
      if (mode === 'android') {
        // finished phrases (each final one repeats everything before it) + the phrase in progress
        results = this.done.map(t => Object.assign([{ transcript: t }], { isFinal: true }));
        if (this.heard.length) results.push(Object.assign([{ transcript: this.heard.join(' ') }], { isFinal: false }));
      } else {
        const all = [...this.done, ...this.heard].join(' ');
        results = [Object.assign([{ transcript: all }], { isFinal: false })];
      }
      this.onresult && this.onresult({ results });
    }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // say words one at a time (gap ms apart), then end the phrase with a pause
  window.__say = async (words, opts = {}) => {
    for (const w of words) { current.heard.push(w); current._emit(); await sleep(opts.gap || 250); }
    if (mode === 'android') { const prev = current.done[current.done.length - 1] || ''; current.done.push((prev ? prev + ' ' : '') + current.heard.join(' ')); current.heard = []; current._emit(); }
    else { current.done.push(...current.heard); current.heard = []; }
    await sleep(opts.pause || 0);
  };
  window.__endSession = () => { const c = current; c.onend && c.onend(); };
  window.__fakeMode = mode;
})();
