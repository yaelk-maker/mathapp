const CACHE = 'mathapp-shell-v43';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/editor.js',
  './js/db.js',
  './js/page-model.js',
  './js/render/grid.js',
  './js/render/worksheet.js',
  './js/render/strokes.js',
  './js/input/keypad.js',
  './js/input/hebrew-keypad.js',
  './js/input/english-keypad.js',
  './js/input/pencil.js',
  './js/io/import.js',
  './js/io/export.js',
  './js/io/cropper.js',
  './js/ui/dialog.js',
  './js/ui/system-keyboard.js',
  './vendor/idb.js',
  // pdf.js — used lazily by js/io/import.js when the kid uploads a PDF.
  // Precaching the worker too so PDF import works fully offline.
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/splash-1668x2388.png',
  './icons/splash-2388x1668.png',
  './icons/splash-1620x2160.png',
  './icons/splash-2160x1620.png',
  './icons/splash-1024x1366.png',
  './icons/splash-1366x1024.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        SHELL.map((url) =>
          cache.add(url).catch(() => {
            // Tolerate missing files during early development; they'll be cached on first fetch.
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   - HTML / navigation requests: network-first, fall back to cached
//     index.html when offline. This way every page load on a live
//     connection picks up the latest shell — the kid never gets
//     stuck on an old build because the SW was caching index.html
//     too aggressively.
//   - JS / CSS / images: stale-while-revalidate. Serve cached
//     immediately for speed, then fetch a fresh copy in the
//     background and update the cache so the next load is current.
//   - Cross-origin requests: passthrough (browser handles them).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isHTML =
    event.request.mode === 'navigate' ||
    event.request.destination === 'document' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html');

  if (isHTML) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(event.request).then((hit) => hit || caches.match('./index.html'))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((hit) => {
      const networked = fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => null);
      return hit || networked || caches.match('./index.html');
    })
  );
});
