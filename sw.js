'use strict';

// Offline support: caches the site's own files only. It never sees or touches notes,
// and never contacts any other origin.
// Bump VERSION when files are added or removed so old caches are cleaned up.
const VERSION = 'nota-v1';
const FILES = [
  './',
  'index.html',
  'about.html',
  'style.css',
  'theme.js',
  'app.js',
  'manifest.webmanifest',
  'fonts/Nunito-latin-variable.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))),
  );
});

// Stale-while-revalidate: answer from the cache right away, refresh it in the background.
// Changes to the site therefore show up on the next visit.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return network;
    }),
  );
});
