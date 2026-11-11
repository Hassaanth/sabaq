// Builds index.html for hosting Sabaq as a standalone website (GitHub Pages).
//   node tools/build-site.js
// The page is app.html in a full HTML document. The bundled audio (audio/) is left out: on its own site
// the app plays the qari's word recordings straight from Quran.com, for every word of the Quran.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8').replace(/<script src="audio\/index\.js"><\/script>\s*/, '');
const head = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<meta name="description" content="Recite the Quran from memory; Sabaq follows you word by word and a qari corrects your mistakes.">',
  '<meta name="theme-color" content="#f4f6f3" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#0e1416" media="(prefers-color-scheme: dark)">',
  // GitHub Pages can't send isolation headers: coi-sw.js adds them (several CPU threads for the speech model).
  // First visit: register it and reload once it controls the page; never more than one reload per session.
  '<script>(function(){if(window.crossOriginIsolated||!window.isSecureContext||!("serviceWorker" in navigator))return;var k="sabaq-coi";function once(){try{if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,"1")}catch(e){return}location.reload()}navigator.serviceWorker.register("coi-sw.js").then(function(){if(navigator.serviceWorker.controller)return;navigator.serviceWorker.addEventListener("controllerchange",once)}).catch(function(){})})();</script>',
  '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>',
  '</head>',
  '<body>',
].join('\n');
fs.writeFileSync(path.join(ROOT, 'index.html'), head + '\n' + page + '\n</body>\n</html>\n');
console.log('index.html written');
