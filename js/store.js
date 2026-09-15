/* 小账本 store.js — 前端存储门面（Phase 2）
 *
 * 目标（ROADMAP Phase 2 / ACCEPTANCE S2.1）：SQLite 成为唯一事实源，IndexedDB 不再是 v3 事实源。
 *
 * 单一事实源策略（绝不双写）：
 *   - 本地服务可达 → 全部读写走 /api/v1，完全不触碰 IndexedDB；
 *   - 本地服务不可达 → 进入「只读降级」：仍可查看与导出既有数据，但拒绝任何写入。
 *
 * 为什么降级时禁止写入：若允许写入 IndexedDB，服务恢复后两份数据必然分叉，
 * 正是 ARCHITECTURE §9 明确禁止的"长期双向写入"。因此宁可只读并显著提示。
 *
 * 应用锁（v2 遗留能力）：锁开启时交易必须以密文落盘。API 模式下由前端先加密再提交，
 * 服务端只保存密文对象（{enc:1,...}），磁盘上不存在明文交易。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Store = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var g = typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : window;

  var MODE_UNKNOWN = 'unknown';
  var MODE_API = 'api';
  var MODE_LOCAL = 'local';
  var API_BASE = '/api/v1';
  var PROBE_TIMEOUT_MS = 1500;
  var TOKEN_PLACEHOLDER = '__LEDGER_SESSION_TOKEN__';

  var mode = MODE_UNKNOWN;
  var reason = '';
  var health = null;
  var detectPromise = null;

  function db() {
    /* global DB */
    return g.DB || null;
  }

  function readSessionToken() {
    try {
      var el = g.document && g.document.querySelector('meta[name="ledger-session-token"]');
      var value = el && el.getAttribute('content');
      if (!value || value === TOKEN_PLACEHOLDER) return null;
      return value;
    } catch (_) {
      return null;
    }
  }

  function resetDetection() {
    mode = MODE_UNKNOWN;
    reason = '';
    health = null;
    detectPromise = null;
  }

  // 探活：服务可达才允许使用 API 模式
  function detect(force) {
    if (!force && mode !== MODE_UNKNOWN) return Promise.resolve(mode);
    if (!force && detectPromise) return detectPromise;

    var token = readSessionToken();
    if (!token) {
      mode = MODE_LOCAL;
      reason = 'no-session-token';
      return Promise.resolve(mode);
    }
    if (typeof g.fetch !== 'function') {
      mode = MODE_LOCAL;
      reason = 'fetch-unavailable';
      return Promise.resolve(mode);
    }

    var controller = typeof g.AbortController === 'function' ? new g.AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, PROBE_TIMEOUT_MS);

    detectPromise = g
      .fetch(API_BASE + '/health', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller ? controller.signal : undefined
      })
      .then(function (res) {
        if (!res.ok) throw new Error('health ' + res.status);
        return res.json();
      })
      .then(function (body) {
        clearTimeout(timer);
        mode = MODE_API;
        reason = '';
        health = body;
        return mode;
      })
      .catch(function (err) {
        clearTimeout(timer);
        mode = MODE_LOCAL;
        reason = err && err.name === 'AbortError' ? 'timeout' : err && err.message ? err.message : 'unreachable';
        health = null;
        return mode;
      });

    return detectPromise;
  }

  // 服务中途不可达（网络层失败）时立即降级为只读：
  // detect() 的模式结论是缓存的，若不主动改写，后续写入仍会尝试请求并在
  // UI 上留下"看似成功实则未落盘"的乐观更新（S2 修复）。
  function markUnreachable() {
    mode = MODE_LOCAL;
    reason = 'unreachable';
    health = null;
    detectPromise = null;
  }

  function apiFetch(pathname, options) {
    var opts = options || {};
    var method = opts.method || 'GET';
    var headers = opts.headers || {};
    if (opts.token !== false) {
      var token = readSessionToken();
      if (!token) return Promise.reject(new Error('缺少本地会话令牌，无法写入'));
      headers['X-Ledger-Token'] = token;
    }
    // 所有写方法都必须声明 JSON：DELETE 这类无请求体的写同样要过服务端的 Content-Type 校验，
    // 否则会被判成非法写请求（415）。
    if (opts.body != null || (method !== 'GET' && method !== 'HEAD')) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    return g
      .fetch(API_BASE + pathname, {
        method: method,
        cache: 'no-store',
        credentials: 'omit',
        headers: headers,
        body: opts.body == null ? undefined : JSON.stringify(opts.body)
      })
      .catch(function (err) {
        // fetch 只在网络层失败时 reject（服务停止/端口不可达）：
        // 此时把缓存模式降级为只读，后续写入在本地直接拒绝。
        markUnreachable();
        var e = new Error('本地服务不可达，已切换为只读模式');
        e.code = 'unreachable';
        e.retryable = true;
        throw e;
      })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            if (!res.ok) {
              var err = new Error(
                body && body.error && body.error.message ? body.error.message : '请求失败 ' + res.status
              );
              err.code = body && body.error ? body.error.code : 'http_' + res.status;
              err.retryable = !!(body && body.error && body.error.retryable);
              err.status = res.status;
              throw err;
            }
            return body;
          });
      });
  }

  function isFreshState(state) {
    if (!state || typeof state !== 'object') return false;
    if (state.settings != null) return false;
    var legacyEmpty = (!state.accounts || state.accounts.length === 0) && (!state.txns || state.txns.length === 0);
    var a = state.assets || {};
    var keys = ['assetAccounts', 'assetUnits', 'liabilities', 'entitlements', 'instruments', 'holdings', 'quotes', 'fxRates'];
    var assetsEmpty = keys.every(function (k) {
      return !a[k] || a[k].length === 0;
    });
    return legacyEmpty && assetsEmpty;
  }

  // 与 DB.loadRaw() 形状完全一致：{accounts, categories, txns, settings, assets}
  function loadRaw() {
    return detect().then(function (current) {
      if (current === MODE_LOCAL) {
        var legacy = db();
        if (!legacy) return Promise.reject(new Error('本地服务未运行，且浏览器存储不可用'));
        return legacy.loadRaw();
      }
      return apiFetch('/state', { token: false }).then(function (state) {
        // 全新数据库返回与"浏览器首次使用"一致的空形状，让上层沿用默认账本与首次保存逻辑
        if (isFreshState(state)) {
          return { accounts: undefined, categories: undefined, txns: undefined, settings: undefined, assets: undefined };
        }
        return state;
      });
    });
  }

  function encryptIfLocked(state) {
    var legacy = db();
    var locked = state && state.settings && state.settings.lock && state.settings.lock.enabled;
    if (!locked) return Promise.resolve(state);
    if (!legacy || !legacy.hasMemoryKey || !legacy.hasMemoryKey()) {
      return Promise.reject(new Error('locked'));
    }
    return legacy.encryptTxns(state.txns).then(function (blob) {
      return {
        accounts: state.accounts,
        categories: state.categories,
        txns: blob,
        settings: state.settings,
        assets: state.assets
      };
    });
  }

  function saveAll(state, options) {
    var opts = options || {};
    return detect().then(function (current) {
      if (current === MODE_LOCAL) {
        var err = new Error('本地服务未运行，当前为只读模式，已拒绝写入');
        err.code = 'readonly';
        throw err;
      }
      return encryptIfLocked(state).then(function (payload) {
        return apiFetch('/state', {
          method: 'PUT',
          // forceBackup：高风险覆盖写入（如 JSON 恢复）时为 true，
          // 服务端会先强制留一份恢复前备份再覆盖，不受写后备份节流影响（S3 修复）
          body: { state: payload, forceBackup: opts.forceBackup === true },
          idempotencyKey: opts.idempotencyKey
        });
      });
    });
  }

  function get(key) {
    return detect().then(function (current) {
      if (current === MODE_LOCAL) {
        var legacy = db();
        if (!legacy) return Promise.reject(new Error('存储不可用'));
        return legacy.get(key);
      }
      return apiFetch('/state', { token: false }).then(function (state) {
        return state ? state[key] : undefined;
      });
    });
  }

  function set(key, value) {
    return detect().then(function (current) {
      if (current === MODE_LOCAL) {
        var err = new Error('本地服务未运行，当前为只读模式，已拒绝写入');
        err.code = 'readonly';
        throw err;
      }
      // 单键写入通过整体状态接口完成：服务端是唯一写入者，避免出现部分字段更新
      return apiFetch('/state', { token: false }).then(function (state) {
        var next = state && !isFreshState(state) ? state : {};
        next[key] = value;
        return apiFetch('/state', { method: 'PUT', body: { state: next } });
      });
    });
  }

  function clearAll() {
    return detect().then(function (current) {
      if (current === MODE_LOCAL) {
        var err = new Error('本地服务未运行，当前为只读模式，已拒绝清空');
        err.code = 'readonly';
        throw err;
      }
      return apiFetch('/state', { method: 'DELETE' });
    });
  }

  function info() {
    return {
      mode: mode,
      reason: reason,
      readonly: mode === MODE_LOCAL,
      factSource: mode === MODE_API ? 'sqlite' : 'indexeddb',
      schemaVersion: health ? health.schemaVersion : null,
      serviceUrl: mode === MODE_API ? API_BASE : null
    };
  }

  function listBackups() {
    return detect().then(function (current) {
      if (current === MODE_LOCAL) return { items: [] };
      return apiFetch('/backups', { token: false });
    });
  }

  function overview(asOf) {
    var q = asOf ? '?asOf=' + encodeURIComponent(asOf) : '';
    return detect().then(function (current) {
      if (current === MODE_LOCAL) return null;
      return apiFetch('/overview' + q, { token: false });
    });
  }

  return {
    MODE_UNKNOWN: MODE_UNKNOWN,
    MODE_API: MODE_API,
    MODE_LOCAL: MODE_LOCAL,
    API_BASE: API_BASE,
    detect: detect,
    resetDetection: resetDetection,
    readSessionToken: readSessionToken,
    loadRaw: loadRaw,
    saveAll: saveAll,
    get: get,
    set: set,
    clearAll: clearAll,
    info: info,
    listBackups: listBackups,
    overview: overview
  };
});
