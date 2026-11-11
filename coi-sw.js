// Sabaq's service worker: makes the website "cross-origin isolated", which GitHub Pages can't do with
// its own headers. Isolation lets the speech model use several CPU threads (faster on phones).
// It only adds two headers to Sabaq's own pages and scripts; nothing is cached, everything else is untouched.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (new URL(r.url).origin !== self.location.origin) return;           // other sites: straight to the network
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  e.respondWith(fetch(r).then(res => {
    if (!res || res.status === 0 || res.type === 'opaqueredirect') return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
