const CACHE_NAME = 'therapy-call-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/call.html',
  '/manifest.json',
  '/styles.css', // если у вас есть внешний CSS
  '/socket.io/socket.io.js'  // (опционально)
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});