/* 小账本 Service Worker — 应用壳缓存，离线可用
 * 策略：
 *   - 静态资源（JS/CSS/图标）：缓存优先，版本随 CACHE 号更新；
 *   - HTML：网络优先。index.html 由本地服务按会话注入 session token，
 *     缓存里的 HTML 令牌必然过期（服务每次重启都会换新令牌），命中缓存会导致
 *     刷新后写请求全部 401（S1 修复，2026-09-14）。只有网络不可达时才回退到
 *     「脱敏后的」缓存壳（令牌已替换回占位符 → 前端进入只读降级，不会误用旧令牌）。
 * 注意：修改任何前端文件后需递增 CACHE 版本号以触发更新。
 * Phase 2：/api/ 请求一律不接管（本地服务提供事实源，缓存响应会导致读到过期财务数据）。
 */
var CACHE = 'ledger-v2.3.13-phase4e';
var ASSETS = [
  './styles.css',
  './js/core.js',
  './js/db.js',
  './js/store.js',
  './js/charts.js',
  './js/domain.js',
  './js/app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

var TOKEN_PLACEHOLDER = '__LEDGER_SESSION_TOKEN__';
var TOKEN_META_RE = /(<meta\s+name="ledger-session-token"\s+content=")[^"]*(")/i;
var HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8' };

// HTML 缓存副本必须脱敏：把注入的真实令牌替换回占位符。
// 这样离线回退页面不会带着过期令牌去写（写也只会在健康探测失败后进入只读降级），
// 真实令牌也不会随 Cache Storage 落盘。
function sanitizeHtml(text) {
  return TOKEN_META_RE.test(text) ? text.replace(TOKEN_META_RE, '$1' + TOKEN_PLACEHOLDER + '$2') : text;
}

function putHtml(text) {
  var safe = sanitizeHtml(text);
  return caches.open(CACHE).then(function (c) {
    return Promise.all([
      c.put('./', new Response(safe, { headers: HTML_HEADERS })),
      c.put('./index.html', new Response(safe, { headers: HTML_HEADERS }))
    ]);
  });
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS).then(function () {
        // 预取首页并脱敏后缓存，作为离线回退壳（失败不阻塞安装）
        return fetch('./').then(function (resp) {
          return resp.ok ? resp.text().then(putHtml) : null;
        }).catch(function () { return null; });
      });
    }).then(function () { return self.skipWaiting(); })
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
  // 本地 API 是唯一事实源，必须直连；缓存或回退会读到过期财务数据
  if (url.pathname.indexOf('/api/') === 0) return;

  var isHtml = e.request.mode === 'navigate' ||
    url.pathname === '/' || url.pathname === '' ||
    /\.html?$/i.test(url.pathname);
  if (isHtml) {
    // HTML 网络优先：在线时永远拿服务端新页面（带当前会话令牌），
    // 只有本地服务未启动时才回退到脱敏缓存壳。
    e.respondWith(
      fetch(e.request).catch(function () {
        return caches.match('./index.html', { ignoreSearch: true }).then(function (hit) {
          if (hit) return hit;
          return new Response(
            '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>小账本</title></head>' +
            '<body style="font-family:system-ui;padding:40px;line-height:1.8">' +
            '<h2>本地服务未运行</h2><p>小账本的数据保存在本地 SQLite，需要先启动本地服务：</p>' +
            '<p><code>node server/main.js</code> 或双击 <code>start.command</code>，然后刷新本页。</p></body></html>',
            { status: 503, headers: HTML_HEADERS }
          );
        });
      })
    );
    return;
  }

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
        throw new Error('offline: ' + url.pathname);
      });
    })
  );
});
