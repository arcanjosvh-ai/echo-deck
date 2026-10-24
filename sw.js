// Network-first for the app's own files (so edits show up), cache fallback when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request)
    .then(r => { const copy = r.clone(); caches.open('echo').then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
