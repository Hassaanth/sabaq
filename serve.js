// Local dev server: node serve.js  ->  http://localhost:5173
// Serves app.html wrapped in the same document skeleton claude.ai artifacts use.
// The microphone works on localhost; on a phone it needs HTTPS (see README).
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 5173, ROOT = __dirname;
// COI=1: serve with cross-origin isolation headers (what coi-sw.js adds on the real site), for testing threads
const COI = process.env.COI ? { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' } : {};
const SKELETON_HEAD = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';
const TYPES = { '.mp3': 'audio/mpeg', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const ALLOWED = new Set(['app.js', 'engine.js', 'quran-data.js', 'asr-worker.js', 'tests/fake-sr.js', 'tests/fake-mic.js', 'coi-sw.js']);
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const fake = /[?&]fakesr=/.test(req.url); // dev only: test phone speech patterns with tests/fake-sr.js
  const fakeMic = /[?&]fakemic=/.test(req.url); // dev only: feed audio through the real mic path with tests/fake-mic.js
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, Object.assign({ 'content-type': TYPES['.html'], 'cache-control': 'no-store' }, COI));
    let page = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
    if (fakeMic) page = page.replace('<script src="app.js">', '<script src="tests/fake-mic.js"></script><script src="app.js">');
    if (fake) page = page.replace('<script src="app.js">', '<script src="tests/fake-sr.js"></script><script src="app.js">');
    res.end(SKELETON_HEAD + page + '</body></html>');
    return;
  }
  const name = url.replace(/^\/+/, '');
  if (!ALLOWED.has(name) && !/^audio\/(s\d{3}\.mp3|index\.js)$/.test(name)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, Object.assign({ 'content-type': TYPES[path.extname(name)], 'cache-control': 'no-store' }, COI));
  fs.createReadStream(path.join(ROOT, name)).pipe(res);
}).listen(PORT, () => console.log(`Sabaq running at http://localhost:${PORT}`));
