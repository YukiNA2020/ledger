/* 小账本 db.js — 数据层：IndexedDB kv 封装 + 应用锁加密（PBKDF2 + AES-GCM）
 * 存储键：accounts / categories / txns / settings / assets（v3 资产集合，Phase 1 新增）
 * txns 明文为数组；开启应用锁后为 { enc:1, alg, kdf, iter, salt, iv, data(base64) }。
 * 浏览器不支持 IndexedDB（如部分 file:// 场景）时自动退化为 localStorage。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.DB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 注意：工厂函数位于包装函数的实参位置，词法上不在其作用域内，
  // 不能引用包装参数 root；全局对象在此自行获取。
  var g = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : window);

  var DB_NAME = 'ledger-db', STORE = 'kv', DB_VERSION = 1;
  var useFallback = false;
  var _db = null;
  var _key = null; // 解锁后的内存 AES-GCM CryptoKey，永不落盘

  /* ---------------------- 基础 kv ---------------------- */

  function open() {
    if (useFallback) return Promise.resolve();
    if (_db) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      if (!g.indexedDB) { useFallback = true; return resolve(); }
      var req = g.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { _db = req.result; resolve(); };
      req.onerror = function () { useFallback = true; resolve(); };
    });
  }

  function idbOp(mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx = _db.transaction(STORE, mode);
      var store = tx.objectStore(STORE);
      var out = fn(store);
      tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function get(key) {
    return open().then(function () {
      if (useFallback) {
        var raw = g.localStorage.getItem('ledger:' + key);
        return raw == null ? undefined : JSON.parse(raw);
      }
      return new Promise(function (resolve, reject) {
        var tx = _db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function set(key, val) {
    return open().then(function () {
      if (useFallback) {
        g.localStorage.setItem('ledger:' + key, JSON.stringify(val));
        return;
      }
      return new Promise(function (resolve, reject) {
        var tx = _db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function del(key) {
    return open().then(function () {
      if (useFallback) { g.localStorage.removeItem('ledger:' + key); return; }
      return new Promise(function (resolve, reject) {
        var tx = _db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function clearAll() {
    return open().then(function () {
      if (useFallback) {
        var keys = [];
        for (var i = 0; i < g.localStorage.length; i++) {
          var key = g.localStorage.key(i);
          if (key && key.indexOf('ledger:') === 0) keys.push(key);
        }
        keys.forEach(function (k) { g.localStorage.removeItem(k); });
        return;
      }
      return new Promise(function (resolve, reject) {
        var tx = _db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------------------- 加密 ---------------------- */

  var ITER = 210000;

  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return g.btoa(s);
  }
  function unb64(s) {
    var bin = g.atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function deriveKey(password, saltBytes, iter) {
    var enc = new TextEncoder();
    return g.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (km) {
        return g.crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: saltBytes, iterations: iter || ITER, hash: 'SHA-256' },
          km,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      });
  }

  function encryptJSON(key, obj) {
    var iv = g.crypto.getRandomValues(new Uint8Array(12));
    var data = new TextEncoder().encode(JSON.stringify(obj));
    return g.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data).then(function (cipher) {
      return { enc: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: ITER, iv: b64(iv.buffer), data: b64(cipher) };
    });
  }

  function decryptJSON(key, blob) {
    var iv = unb64(blob.iv);
    return g.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, unb64(blob.data)).then(function (plain) {
      return JSON.parse(new TextDecoder().decode(plain));
    });
  }

  /* ---------------------- 应用锁 ---------------------- */

  // 设置密码并派生密钥（密钥仅存内存），返回盐与迭代参数（存入 settings.lock）
  function makeLockParams(password) {
    var salt = g.crypto.getRandomValues(new Uint8Array(16));
    return deriveKey(password, salt).then(function (key) {
      _key = key;
      return { salt: b64(salt.buffer), iter: ITER };
    });
  }

  // 尝试解锁：成功则内存持有 key，返回解密后的 txns
  function unlock(password, lockParams, txnsBlob) {
    return deriveKey(password, unb64(lockParams.salt), lockParams.iter).then(function (key) {
      return decryptJSON(key, txnsBlob).then(function (txns) {
        _key = key;
        return txns;
      });
    });
  }

  function hasMemoryKey() { return !!_key; }
  function dropMemoryKey() { _key = null; }

  /* ---------------------- 状态读写 ---------------------- */

  // 读取全部原始存储（不做解密）：{accounts, categories, txns, settings, assets}
  // assets 在旧版本存储中可能不存在（undefined），由调用方归一化为空集合。
  function loadRaw() {
    return Promise.all([get('accounts'), get('categories'), get('txns'), get('settings'), get('assets')])
      .then(function (r) {
        return { accounts: r[0], categories: r[1], txns: r[2], settings: r[3], assets: r[4] };
      });
  }

  // 全量保存。state.txns 为数组；若 lockEnabled 且内存有密钥 → 加密落盘。
  // state.assets 仅在有值时写入，兼容只保存 v2 四键的旧调用方。
  function saveAll(state) {
    var jobs = [
      set('accounts', state.accounts),
      set('categories', state.categories),
      set('settings', state.settings)
    ];
    if (state.assets != null) jobs.push(set('assets', state.assets));
    var txnsJob;
    if (state.settings && state.settings.lock && state.settings.lock.enabled && _key) {
      txnsJob = encryptJSON(_key, state.txns).then(function (blob) { return set('txns', blob); });
    } else {
      txnsJob = set('txns', state.txns);
    }
    jobs.push(txnsJob);
    return Promise.all(jobs);
  }

  return {
    open: open,
    get: get,
    set: set,
    del: del,
    clearAll: clearAll,
    loadRaw: loadRaw,
    saveAll: saveAll,
    makeLockParams: makeLockParams,
    unlock: unlock,
    deriveKey: deriveKey,
    encryptJSON: encryptJSON,
    decryptJSON: decryptJSON,
    hasMemoryKey: hasMemoryKey,
    dropMemoryKey: dropMemoryKey,
    usingFallback: function () { return useFallback; }
  };
});
