/* Offline cache for Dollar Logger.
   Bump CACHE whenever you change the app files, or phones keep the old copy. */
var CACHE = 'dollar-logger-v3';
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './signin.js',
  './manifest.webmanifest',
  './icons/icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;

  // Only ever serve our own files from cache. Google auth and Drive API calls
  // must go straight to the network - caching them would hand back stale
  // entries or a dead token.
  if (new URL(e.request.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); }).catch(function () {});
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      });
    })
  );
});
