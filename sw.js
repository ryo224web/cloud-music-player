// アプリ本体をキャッシュしてオフラインでも起動できるようにする
// （音声データは IndexedDB に保存するのでここでは扱わない）
const VERSION = 'boxmusic-v1';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-512.png',
  'js/app.js',
  'js/auth.js',
  'js/box.js',
  'js/cache.js',
  'js/config.js',
  'js/db.js',
  'js/eq.js',
  'js/library.js',
  'js/lyrics.js',
  'js/player.js',
  'js/playlists.js',
  'js/tags.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同じサイトのファイルは「ネット優先・失敗したらキャッシュ」
// （更新がすぐ反映され、オフラインでも起動できる）
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
