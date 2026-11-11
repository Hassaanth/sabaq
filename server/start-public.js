// Runs Sabaq's speech server on this computer and makes it reachable from your phone, for free:
//   1. starts the speech server (asr-server.js) unless one is already running on PORT,
//   2. opens a free Cloudflare quick tunnel to it (a public HTTPS address; no account needed),
//   3. publishes that address in asr-url.json on the Sabaq website (git commit + push), so
//      https://hassaanth.github.io/sabaq/ finds the server by itself. The address changes each time the
//      tunnel starts; the website always reads the latest one, and uses its in-browser model when the
//      server isn't running.
//
//   cd server && node start-public.js            (CLOUDFLARED=path\to\cloudflared.exe if not on PATH)
// Keep it running while you recite; Ctrl+C stops everything.
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const PORT = +process.env.PORT || 8787;
const children = [];
const stopAll = () => { for (const c of children) { try { c.kill(); } catch (e) { /* gone */ } } process.exit(0); };
process.on('SIGINT', stopAll); process.on('SIGTERM', stopAll);

async function healthy() {
  try { const r = await fetch(`http://localhost:${PORT}/health`); return r.ok && (await r.json()).ready; } catch (e) { return false; }
}
function findCloudflared() {
  const tries = [process.env.CLOUDFLARED, path.join(os.tmpdir(), 'sabaq-tunnel', 'cloudflared.exe'), 'cloudflared'].filter(Boolean);
  for (const t of tries) { try { execFileSync(t, ['--version'], { stdio: 'ignore' }); return t; } catch (e) { /* next */ } }
  throw new Error('cloudflared not found: install it, or set CLOUDFLARED to its path');
}
function publish(url) {
  const file = path.join(REPO, 'asr-url.json');
  fs.writeFileSync(file, JSON.stringify({ url, updated: new Date().toISOString() }, null, 2) + '\n');
  const git = args => execFileSync('git', args, { cwd: REPO, stdio: 'pipe' }).toString();
  git(['add', 'asr-url.json']);
  try { git(['commit', '-m', 'Speech server address: ' + url, '--', 'asr-url.json']); } catch (e) { /* unchanged */ }
  git(['push', '-q', 'origin', 'HEAD']);
  console.log('Published to the website (live in about a minute):', url);
}

(async () => {
  if (!(await healthy())) {
    console.log('Starting the speech server…');
    const s = spawn(process.execPath, [path.join(HERE, 'asr-server.js')], { stdio: 'inherit', env: process.env });
    children.push(s);
    for (let i = 0; i < 120 && !(await healthy()); i++) await new Promise(r => setTimeout(r, 1000));
    if (!(await healthy())) throw new Error('the speech server did not start');
  } else console.log('Speech server already running on port', PORT);

  console.log('Opening the tunnel…');
  const t = spawn(findCloudflared(), ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(t);
  let done = false;
  const watch = buf => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
    if (m && !done) {
      done = true;
      const url = m[0];
      console.log('Public address:', url);
      // wait until the address answers through Cloudflare, then publish it
      (async () => {
        for (let i = 0; i < 60; i++) { try { const r = await fetch(url + '/health'); if (r.ok) break; } catch (e) { /* not yet */ } await new Promise(r => setTimeout(r, 1000)); }
        try { publish(url); } catch (e) { console.error('Could not publish the address:', e.message); }
        console.log('\nOpen https://hassaanth.github.io/sabaq/ on your phone (or ' + url + ' directly).');
      })();
    }
  };
  t.stdout.on('data', watch); t.stderr.on('data', watch);
  t.on('exit', code => { console.error('The tunnel stopped (' + code + ').'); stopAll(); });
})().catch(e => { console.error(e.message); stopAll(); });
