const CACHE = 'mathapp-shell-v70';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/editor.js',
  './js/db.js',
  './js/settings.js',
  './js/page-model.js',
  './js/render/grid.js',
  './js/render/worksheet.js',
  './js/render/strokes.js',
  './js/render/graph.js',
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
  './vendor/map-polyfill.mjs',
  './vendor/pdf.worker.shim.mjs',
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

// Fetch strategy — NETWORK-FIRST for every same-origin GET (HTML, JS, CSS,
// images), with the precached shell as the offline fallback:
//   - Online: always fetch the live file and refresh the cache, so a deploy
//     is picked up on the very next launch. Previously JS/CSS were served
//     stale-while-revalidate, which left the installed PWA a load (or more)
//     behind after every deploy — a fix would land on the server but the kid
//     kept running the old cached build until a second reload happened to
//     swap it in. Network-first removes that lag entirely and means we no
//     longer depend on bumping the cache version to ship a change.
//   - Offline / fetch failure: fall back to the cached copy (and to
//     index.html for navigations) so the app still opens with no connection.
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

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          // Navigations are cached under './index.html' so the SPA shell is
          // always available offline regardless of the requested route.
          const key = isHTML ? './index.html' : event.request;
          caches.open(CACHE).then((c) => c.put(key, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then(
          (hit) => hit || (isHTML ? caches.match('./index.html') : undefined)
        )
      )
  );
});
