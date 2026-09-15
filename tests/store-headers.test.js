/* js/store.js 请求头契约测试（Node 环境，stub 掉 fetch 与 document）
 *
 * 锁定一个真实踩过的缺陷：DELETE /api/v1/state 没有请求体，
 * 早期实现只在"有 body"时才设置 Content-Type，导致服务端按非法写请求拒绝（415），
 * 前端「清空账本」静默失败并抛成未处理的 Promise 拒绝。
 *
 * 这里不启动服务，只验证前端发出的请求头符合服务端契约：
 *   - 所有写方法（POST/PUT/PATCH/DELETE）都必须声明 Content-Type: application/json；
 *   - 只读方法不声明 Content-Type；
 *   - 只有写请求带会话令牌，读请求不带。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const TOKEN = 'unit-session-token-abcdef';

// store.js 在模块加载时抓取 globalThis 上的 document/fetch，因此必须先装好桩再 require
const calls = [];
globalThis.document = {
  querySelector() {
    return { getAttribute: () => TOKEN };
  }
};
globalThis.fetch = function (url, init) {
  calls.push({ url: url, init: init });
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({})
  });
};

const Store = require(path.join(__dirname, '..', 'js', 'store.js'));

function lastCall() {
  return calls[calls.length - 1];
}

function headerKeys(init) {
  return Object.keys(init.headers || {}).map((k) => k.toLowerCase());
}

test('写方法一律声明 JSON：PUT/POST/DELETE 都带 Content-Type（含无请求体的 DELETE）', async () => {
  calls.length = 0;

  await Store.saveAll({ accounts: [], categories: [], txns: [], settings: {} });
  assert.strictEqual(lastCall().init.method, 'PUT');
  assert.strictEqual(lastCall().init.headers['Content-Type'], 'application/json', 'PUT 必须声明 JSON');

  await Store.clearAll();
  assert.strictEqual(lastCall().init.method, 'DELETE');
  assert.strictEqual(lastCall().init.headers['Content-Type'], 'application/json',
    '无请求体的 DELETE 同样必须声明 JSON，否则服务端按非法写请求 415 拒绝');
  assert.strictEqual(lastCall().init.body, undefined, 'DELETE 不应带请求体');

  await Store.listBackups();
  const getCall = calls[calls.length - 1];
  assert.strictEqual(getCall.init.method, 'GET');
  assert.ok(headerKeys(getCall.init).indexOf('content-type') === -1, '只读请求不应声明 Content-Type');
});

test('会话令牌只随写请求发送，读请求不带（避免无谓地把令牌扩散到 GET）', async () => {
  calls.length = 0;

  await Store.loadRaw();
  assert.ok(headerKeys(lastCall().init).indexOf('x-ledger-token') === -1, 'GET 不应带令牌');

  await Store.saveAll({ accounts: [], categories: [], txns: [], settings: {} });
  assert.strictEqual(lastCall().init.headers['X-Ledger-Token'], TOKEN, '写请求必须带令牌');
});

test('缺少会话令牌时进入只读降级：写入被本地拒绝且不发出任何请求', async () => {
  const originalQuery = globalThis.document.querySelector;
  const origFetch = globalThis.fetch;
  globalThis.document.querySelector = () => null; // 模拟未注入令牌（例如 file:// 直开）
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    throw new Error('只读降级时不应发出任何请求');
  };
  Store.resetDetection();
  try {
    await assert.rejects(
      () => Store.saveAll({ accounts: [], categories: [], txns: [], settings: {} }),
      /只读模式/
    );
    assert.strictEqual(requests, 0, '只读降级必须在发请求前就拒绝');
    assert.strictEqual(Store.info().mode, Store.MODE_LOCAL);
    assert.strictEqual(Store.info().reason, 'no-session-token');
  } finally {
    globalThis.document.querySelector = originalQuery;
    globalThis.fetch = origFetch;
    Store.resetDetection();
  }
});

test('幂等键透传：saveAll 指定 idempotencyKey 时写入 Idempotency-Key 头', async () => {
  calls.length = 0;
  await Store.saveAll({ accounts: [], categories: [], txns: [], settings: {} }, { idempotencyKey: 'k-1' });
  assert.strictEqual(lastCall().init.headers['Idempotency-Key'], 'k-1');
});

test('网络层失败立即降级只读：先报 unreachable，后续写入在本地拒绝且不再发请求', async () => {
  const origFetch = globalThis.fetch;
  Store.resetDetection();
  try {
    // 阶段一：服务可达，保存成功（模式缓存为 api）
    globalThis.fetch = function (url, init) {
      calls.push({ url: url, init: init });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    await Store.saveAll({ accounts: [], categories: [], txns: [], settings: {} });
    assert.strictEqual(Store.info().mode, Store.MODE_API);

    // 阶段二：服务中途停止（fetch 在网络层 reject）。
    // 修复前：detect() 缓存的 api 模式不会更新，写入失败后界面仍以为自己是可写模式，
    // 乐观更新挂在页面上、刷新后凭空消失（S2 缺陷）。
    globalThis.fetch = function () {
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    await assert.rejects(
      () => Store.saveAll({ accounts: [], categories: [], txns: [], settings: {} }),
      (err) => err.code === 'unreachable'
    );
    assert.strictEqual(Store.info().mode, Store.MODE_LOCAL, '网络层失败必须立刻降级为只读');
    assert.strictEqual(Store.info().reason, 'unreachable');
    assert.strictEqual(Store.info().readonly, true);

    // 阶段三：降级后的写入在本地直接拒绝，不发任何请求
    let requests = 0;
    globalThis.fetch = function () {
      requests += 1;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    await assert.rejects(
      () => Store.saveAll({ accounts: [], categories: [], txns: [], settings: {} }),
      /只读模式/
    );
    assert.strictEqual(requests, 0, '只读降级后不得再发出写请求');
  } finally {
    globalThis.fetch = origFetch;
    Store.resetDetection();
  }
});

test('高风险覆盖写入透传：forceBackup 出现在 PUT /state 请求体中', async () => {
  calls.length = 0;
  Store.resetDetection();
  try {
    await Store.saveAll(
      { accounts: [], categories: [], txns: [], settings: {} },
      { forceBackup: true }
    );
    const put = lastCall();
    assert.strictEqual(put.init.method, 'PUT');
    const body = JSON.parse(put.init.body);
    assert.strictEqual(body.forceBackup, true, '恢复等高风险覆盖写入必须携带 forceBackup 标志');
    assert.ok(body.state, '请求体仍必须包含完整 state');

    // 普通保存不携带该标志：避免每次记账都产生一份备份
    await Store.saveAll({ accounts: [], categories: [], txns: [], settings: {} });
    assert.strictEqual(JSON.parse(lastCall().init.body).forceBackup, false);
  } finally {
    Store.resetDetection();
  }
});
