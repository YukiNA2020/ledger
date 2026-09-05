/* 小账本 Service Worker — 应用壳缓存，离线可用
 * 策略：缓存优先（静态资源版本随 CACHE 版本号更新）；导航请求离线回退 index.html。
 * 注意：修改任何前端文件后需递增 CACHE 版本号以触发更新。
 */
var CACHE = 'ledger-v2.0.0-rc.3';
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './js/core.js',
  './js/db.js',
  './js/charts.js',
  './js/app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
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
      // 仅清理本应用的旧版本缓存（ledger- 前缀且非当前缓存），不影响同源其他应用
      return Promise.all(keys.filter(function (k) { return k.indexOf('ledger-') === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // 永不代理外域（隐私硬约束）
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (resp) {
        if (resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return resp;
      }).catch(function () {
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        throw new Error('offline: ' + url.pathname);
      });
    })
  );
});
