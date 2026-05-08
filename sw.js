const CACHE = 'mathapp-shell-v13';
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
  './js/input/pencil.js',
  './js/io/import.js',
  './js/io/export.js',
  './js/io/cropper.js',
  './vendor/idb.js',
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

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
