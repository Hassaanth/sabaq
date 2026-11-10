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
  '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>',
  '</head>',
  '<body>',
].join('\n');
fs.writeFileSync(path.join(ROOT, 'index.html'), head + '\n' + page + '\n</body>\n</html>\n');
console.log('index.html written');
