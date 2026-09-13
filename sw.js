/* Offline cache for Dollar Logger.
 *
 * Strategy: network-first, cache as fallback.
 *
 * The obvious approach is cache-first - serve the saved copy, only hit the
 * network on a miss. It is fast, and it is wrong here: after a deploy the phone
 * keeps serving the old app until something breaks the cache, which is exactly
 * the "it's still old" failure. The cache exists to make the app work with no
 * signal, not to pin it to an old version.
 *
 * So when online we always take the fresh copy and refresh the cache with it;
 * offline we fall back to whatever was saved last. The whole app is a few KB,
 * so the cost is a few hundred milliseconds on a connection you already have.
 */
var CACHE = 'dollar-logger-v12';
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './signin.js',
  './api.js',
  './manifest.webmanifest',
  './icons/icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      // Take over straight away instead of waiting for every tab to close.
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

  // Only ever touch our own files. Google sign-in and the API must go straight
  // to the network - caching those would serve a stale token or stale entries.
  if (new URL(e.request.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(function (res) {
        // Keep the cache current, so the offline copy is the newest one seen.
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        // Offline: serve what we have. A navigation with nothing cached for
        // that exact URL still gets the app shell back.
        return caches.match(e.request).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
  );
});

/* A budget alert from the server. The payload was encrypted to this device's
   key, and the browser has already decrypted it by the time it arrives here. */
self.addEventListener('push', function (e) {
  var msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Dollar Logger', {
    body: msg.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: msg.url || './' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return clients.openWindow(url);
  }));
});
