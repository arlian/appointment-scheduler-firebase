// Service worker: utamakan jaringan, cadangkan cache agar tetap bisa dibuka offline.
const CACHE = 'jadwal-treatment-v25';
const ASSETS = ['./', './index.html', './style.css', './app.js', './firebase-config.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    // cache: 'reload' memaksa tiap aset diambil dari jaringan, bukan dari HTTP
    // cache browser. Tanpa ini menaikkan versi CACHE saja tidak cukup: isinya
    // bisa diisi ulang dengan file lama yang masih tersimpan di browser, dan
    // HP tetap membuka tampilan lama walau kodenya sudah dirilis.
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      // ignoreSearch: agar ?action=add tetap dapat index.html dari cache
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
