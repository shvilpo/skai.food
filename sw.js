const VERSION = 'skai-food-v10';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/ai.js',
  './js/db.js',
  './js/foods.js',
  './js/seed.js',
  './js/util.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Свои файлы: stale-while-revalidate — открывается мгновенно из кэша,
// свежая версия подтягивается в фоне к следующему открытию.
// Чужие домены (API) не трогаем.
self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== self.location.origin) return;
  ev.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(ev.request);
      // cache: 'no-cache' — ревалидируем у сервера, минуя HTTP-кэш браузера,
      // иначе фоновое обновление может перечитать устаревшую копию файла.
      const refresh = fetch(ev.request, { cache: 'no-cache' })
        .then(resp => {
          if (resp.ok) cache.put(ev.request, resp.clone());
          return resp;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
