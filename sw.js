// Network-first for the app's own files (so edits show up), cache fallback when offline.
// no-cache revalidates past GitHub Pages' 10-minute max-age, so a deploy never mixes old and new modules.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' })
    .then(r => { const copy = r.clone(); caches.open('echo').then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
