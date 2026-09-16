/* Phase 4B 标的目录 API 端到端测试（临时数据库，虚构数据）
 *
 * 对应 ACCEPTANCE.md S4B.1 的完整验收链路（走真实 HTTP 入口，不绕过路由）：
 *   检索 → 预分类（suggested）→ 用户确认（confirmed）→ 再刷新不覆盖确认值；
 *   缺失/冲突元数据明确提示；同一标的不重复创建事实。
 * 另覆盖 ARCHITECTURE §5.6（服务端唯一写入者）、D-026（写接口必须声明 Content-Type）、
 * D-037（本地锁定）、以及"4B 不碰持仓写接口"的边界（portfolio-openings / security-events 仍 501）。
 *
 * 全部离线：provider 固定为 fixture，绝不访问真实行情网络。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const api = require('../server/api');
const config = require('../server/config');
const Catalog = require('../server/instrument-catalog');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';
const NOW = '2026-09-15T08:00:00Z';

// 与 server-phase3.test.js 同构：真实起服务、真实走 HTTP。
async function startServer(ctx) {
  Object.assign(ctx, {
    host: config.HOST,
    port: 0,
    token: TOKEN,
    repoRoot: config.REPO_ROOT,
    backupKeep: config.BACKUP_KEEP,
    backupMinIntervalMs: config.BACKUP_MIN_INTERVAL_MS,
    keychainService: 'com.ledger.local.test',
    keychainAccount: 'test',
    startedAt: NOW,
    providerNow: () => NOW, // 固定抓取时间，保证 provenance 可断言
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = http.createServer(api.createHandlerEntry(ctx));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, config.HOST, resolve);
  });
  const port = server.address().port;
  ctx.port = port;
  return {
    port: port,
    origin: 'http://127.0.0.1:' + port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function request(port, method, pathname, body, opts) {
  const o = opts || {};
  const headers = Object.assign(
    { 'X-Ledger-Token': TOKEN, Origin: 'http://127.0.0.1:' + port },
    o.headers || {}
  );
  let payload = null;
  if (body != null && o.json !== false) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  } else if (body != null) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: config.HOST, port: port, method: method, path: pathname, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const post = (port, path, body, opts) => request(port, 'POST', path, body, opts);
const get = (port, path) => request(port, 'GET', path);

/* ============================== S4B.1 主链路 ============================== */

test('S4B.1 主链路：检索 → 建立（suggested）→ 确认（confirmed）→ 再刷新不覆盖确认值', async (t) => {
  const ctx = setup('ledger-p4b-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  // 1) 检索：provider 候选进入目录（本地还没有）
  const search = await get(port, '/api/v1/instruments/search?q=vanguard');
  assert.strictEqual(search.status, 200);
  assert.strictEqual(search.json.ok, true);
  assert.strictEqual(search.json.provider.status, 'ok');
  assert.strictEqual(search.json.candidates.length, 1);
  const cand = search.json.candidates[0];
  assert.strictEqual(cand.symbol, 'VOO');
  assert.strictEqual(cand.origin, 'provider');
  assert.strictEqual(cand.local, null);
  assert.ok(cand.userJudgementRequired.indexOf('assetClass') !== -1);
  assert.ok(
    cand.suggestions.some((s) => s.field === 'currency' && s.value === 'USD' && s.basis === 'provider.currency'),
    '预分类建议必须带 provider 依据'
  );

  // 2) 建立标的：预填为 suggested，分类留空等用户填
  const created = await post(port, '/api/v1/instruments', { symbol: 'VOO' });
  assert.strictEqual(created.status, 201);
  const item = created.json.item;
  assert.strictEqual(item.classificationStatus, 'suggested');
  assert.strictEqual(item.assetClass, null);
  assert.strictEqual(item.exposureMarket, null);
  assert.strictEqual(item.currency, 'USD');
  assert.strictEqual(item.name, 'Vanguard S&P 500 ETF');
  assert.strictEqual(item.providerProvenance.fetchedAt, NOW);
  assert.ok(/^[0-9a-f]{64}$/.test(item.providerProvenance.payloadHash));

  // 3) 用户确认：asset_class / exposure_market 是用户判断，两项都提交
  const confirmed = await post(port, '/api/v1/instrument-confirmations', {
    instrumentId: item.id,
    assetClass: 'broad_equity',
    exposureMarket: 'US'
  });
  assert.strictEqual(confirmed.status, 201);
  assert.strictEqual(confirmed.json.item.classificationStatus, 'confirmed');
  assert.strictEqual(confirmed.json.item.assetClass, 'broad_equity');
  assert.strictEqual(confirmed.json.item.exposureMarket, 'US');
  assert.strictEqual(confirmed.json.item.confirmedAt, NOW);

  // 4) 外部元数据再刷新：已确认分类不得被覆盖，也不得退回 suggested
  const refreshed = await post(port, '/api/v1/instruments', { symbol: 'VOO' });
  assert.strictEqual(refreshed.status, 201);
  assert.strictEqual(refreshed.json.preserved, true, '必须显式报告保留了已确认分类');
  assert.strictEqual(refreshed.json.item.id, item.id, '标的不重复创建');
  assert.strictEqual(refreshed.json.item.classificationStatus, 'confirmed');
  assert.strictEqual(refreshed.json.item.assetClass, 'broad_equity');
  assert.strictEqual(refreshed.json.item.exposureMarket, 'US');
  assert.strictEqual(refreshed.json.item.confirmedAt, NOW);

  // 5) 目录里只有这一条事实
  const list = await get(port, '/api/v1/instruments');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.json.items.filter((r) => r.symbol === 'VOO').length, 1);
});

/* ============================== 检索接口 ============================== */

test('检索接口：provider 报错时仍返回本地命中，并显式暴露 provider 状态', async (t) => {
  const ctx = setup('ledger-p4b-degrade-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  await post(port, '/api/v1/instruments', { symbol: 'VOO' });
  const res = await get(port, '/api/v1/instruments/search?q=SLOW');
  // SLOW 触发 provider 整体失败（fixture 的错误场景），但本地命中仍应返回
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.provider.status, 'error');
  assert.strictEqual(res.json.provider.code, 'timeout');
  assert.strictEqual(res.json.provider.retryable, true);
  assert.strictEqual(res.json.warnings.length >= 1, true);
});

test('检索接口：非法/空检索词返回 400 invalid_query', async (t) => {
  const ctx = setup('ledger-p4b-badq-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));

  for (const p of ['/api/v1/instruments/search', '/api/v1/instruments/search?q=', '/api/v1/instruments/search?q=%20%20']) {
    const res = await get(srv.port, p);
    assert.strictEqual(res.status, 400, p);
    assert.strictEqual(res.json.error.code, 'invalid_query', p);
  }
});

test('检索接口：非法检索词被拒且不回显输入原文（隐私边界）', async (t) => {
  const ctx = setup('ledger-p4b-privacy-in-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));

  // 载荷里可能被误传成检索词的私有文本（含 ; 等非法字符）必须整体拒绝，且错误响应不得回显
  const dirty = '我的账户 001;DROP';
  const res = await get(srv.port, '/api/v1/instruments/search?q=' + encodeURIComponent(dirty));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error.code, 'invalid_query');
  assert.ok(JSON.stringify(res.json).indexOf('我的账户') === -1, '错误响应不得回显输入原文');
  assert.ok(JSON.stringify(res.json).indexOf('DROP') === -1, '错误响应不得回显输入原文');

  // 中文检索词本身是合法的（真实场景要支持按中文名称检索），只是没有命中而已
  const zh = await get(srv.port, '/api/v1/instruments/search?q=' + encodeURIComponent('茅台'));
  assert.strictEqual(zh.status, 200);
  assert.deepStrictEqual(zh.json.candidates, []);
});

/* ============================== 建立接口 ============================== */

test('建立接口：写请求必须声明 Content-Type（D-026），且不落库', async (t) => {
  const ctx = setup('ledger-p4b-ctype-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const noType = await post(port, '/api/v1/instruments', JSON.stringify({ symbol: 'VOO' }), {
    json: false,
    headers: { 'Content-Type': 'text/plain' }
  });
  assert.strictEqual(noType.status, 415);
  assert.strictEqual(noType.json.error.code, 'invalid_content_type');

  const list = await get(port, '/api/v1/instruments');
  assert.strictEqual(list.json.items.length, 0, '被拒的请求不得改动数据');
});

test('建立接口：校验失败一律 4xx，且稳定错误码 + 不写入', async (t) => {
  const ctx = setup('ledger-p4b-validate-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const cases = [
    [{ symbol: 'not a symbol' }, 400, 'invalid_symbol'],
    [{ symbol: 'VOO', source: 'other' }, 400, 'invalid_source'],
    [{ symbol: 'VOO', assetClass: '现金' }, 400, 'invalid_asset_class'],
    [{ symbol: 'VOO', exposureMarket: '日本' }, 400, 'invalid_exposure_market'],
    [{ symbol: 'VOO', currency: 'HKD' }, 400, 'currency_mismatch'],
    [{ symbol: '159915.SZ', source: 'manual' }, 400, 'invalid_currency'],
    [{ symbol: 'NOPE.ZZ' }, 404, 'instrument_not_found'],
    [{ symbol: 'BADMETA.ETF' }, 422, 'invalid_provider_payload']
  ];
  for (const [body, status, code] of cases) {
    const res = await post(port, '/api/v1/instruments', body);
    assert.strictEqual(res.status, status, JSON.stringify(body));
    assert.strictEqual(res.json.error.code, code, JSON.stringify(body));
    assert.ok(res.json.error.message, '必须给出可读原因');
  }
  const list = await get(port, '/api/v1/instruments');
  assert.strictEqual(list.json.items.length, 0, '所有失败请求都不得写入');
});

test('建立接口：provider 未覆盖的标的可用 source=manual 手工建立（币种必填）', async (t) => {
  const ctx = setup('ledger-p4b-manual-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  // fixture 未收录的 A 股本土 ETF 代码：provider 来源应 404
  const byProvider = await post(port, '/api/v1/instruments', { symbol: '159915.SZ' });
  assert.strictEqual(byProvider.status, 404);
  assert.strictEqual(byProvider.json.error.code, 'instrument_not_found');

  const manual = await post(port, '/api/v1/instruments', {
    symbol: '159915.SZ',
    source: 'manual',
    currency: 'CNY',
    name: '创业板 ETF',
    exchange: 'SZSE'
  });
  assert.strictEqual(manual.status, 201);
  assert.strictEqual(manual.json.item.source, 'manual');
  assert.strictEqual(manual.json.item.currency, 'CNY');
  assert.strictEqual(manual.json.item.classificationStatus, 'suggested');

  const again = await post(port, '/api/v1/instruments', {
    symbol: '159915.SZ',
    source: 'manual',
    currency: 'CNY'
  });
  assert.strictEqual(again.json.duplicated, true, '重复建立必须命中既有标的');
  const list = await get(port, '/api/v1/instruments');
  assert.strictEqual(list.json.items.filter((r) => r.symbol === '159915.SZ').length, 1);
});

/* ============================== 确认接口 ============================== */

test('确认接口：缺分类 / 分类不在词表 / 标的不存在，分别给出稳定错误码', async (t) => {
  const ctx = setup('ledger-p4b-confirm-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const created = await post(port, '/api/v1/instruments', { symbol: 'VOO' });
  const id = created.json.item.id;

  const noClass = await post(port, '/api/v1/instrument-confirmations', { instrumentId: id, exposureMarket: 'US' });
  assert.strictEqual(noClass.status, 400);
  assert.strictEqual(noClass.json.error.code, 'invalid_asset_class');

  const noMarket = await post(port, '/api/v1/instrument-confirmations', { instrumentId: id, assetClass: 'broad_equity' });
  assert.strictEqual(noMarket.status, 400);
  assert.strictEqual(noMarket.json.error.code, 'invalid_exposure_market');

  const badMarket = await post(port, '/api/v1/instrument-confirmations', {
    instrumentId: id, assetClass: 'broad_equity', exposureMarket: '美国'
  });
  assert.strictEqual(badMarket.status, 400);

  const missing = await post(port, '/api/v1/instrument-confirmations', {
    instrumentId: 'inst-nope', assetClass: 'broad_equity', exposureMarket: 'US'
  });
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.json.error.code, 'instrument_not_found');

  // 全部失败之后标的仍是未确认、无分类
  const list = await get(port, '/api/v1/instruments');
  const row = list.json.items.find((r) => r.id === id);
  assert.strictEqual(row.classificationStatus, 'suggested');
  assert.ok(!row.assetClass || row.assetClass === '');
});

test('确认接口：冲突提示带 provider 候选值与 provenance，本地值不被改写', async (t) => {
  const ctx = setup('ledger-p4b-conflict-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  // 手工建立并自定义名称，再让 provider 拉一次（名称不同）→ 应产生冲突提示
  await post(port, '/api/v1/instruments', {
    symbol: '2800.HK', source: 'manual', currency: 'HKD', name: '盈富基金'
  });
  await post(port, '/api/v1/instruments', { symbol: '2800.HK' });

  const list = await get(port, '/api/v1/instruments');
  const row = list.json.items.find((r) => r.symbol === '2800.HK');

  const confirmed = await post(port, '/api/v1/instrument-confirmations', {
    instrumentId: row.id, assetClass: 'broad_equity', exposureMarket: 'HK'
  });
  assert.strictEqual(confirmed.status, 201);
  assert.strictEqual(confirmed.json.item.name, '盈富基金', '本地名称不得被 provider 覆盖');
  const nameConflict = confirmed.json.conflicts.find((c) => c.field === 'name');
  assert.ok(nameConflict, '名称差异必须作为冲突提示');
  assert.strictEqual(nameConflict.providerValue, 'Tracker Fund of Hong Kong');
  assert.ok(nameConflict.provenance, '冲突提示必须带 provenance');
  assert.strictEqual(nameConflict.provenance.fetchedAt, NOW);
});

/* ============================== 边界：不碰 4C/4D ============================== */

test('4B 不提前实现持仓与行情写入：portfolio-openings / security-events / market-data 仍返回 501', async (t) => {
  const ctx = setup('ledger-p4b-scope-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const paths = [
    '/api/v1/portfolio-openings',
    '/api/v1/security-events',
    '/api/v1/market-data/refresh'
  ];
  for (const p of paths) {
    const res = await post(port, p, {});
    assert.strictEqual(res.status, 501, p + ' 应为 501（属后续阶段）');
    assert.ok(res.json.error && res.json.error.message, p + ' 应说明所属阶段');
  }
});

test('标的目录接口不夹带账户/持仓字段，也不把私有文本写进响应', async (t) => {
  const ctx = setup('ledger-p4b-privacy-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const search = await get(port, '/api/v1/instruments/search?q=voo');
  const created = await post(port, '/api/v1/instruments', { symbol: 'VOO' });
  ['accountName', 'accountId', 'quantity', 'costMinor', 'balanceMinor'].forEach((k) => {
    assert.strictEqual(JSON.stringify(search.json).indexOf(k), -1, '检索响应不得含 ' + k);
    assert.strictEqual(JSON.stringify(created.json).indexOf(k), -1, '建立响应不得含 ' + k);
  });
  // 稳定 id 由去重键派生，可复核
  assert.strictEqual(created.json.item.id, Catalog.stableInstrumentId('VOO', 'NYSE'));
});

/* ==================== 4B 复核补口：身份、去重与歧义（真实 HTTP） ==================== */

test('建立接口：客户端指定的 id 被拒（400 client_id_forbidden），id 只能由服务端派生', async (t) => {
  const ctx = setup('ledger-p4b-idforge-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  // 复核反例原文：{"symbol":"VOO","id":"client-chosen-id"}
  const forged = await post(port, '/api/v1/instruments', { symbol: 'VOO', id: 'client-chosen-id' });
  assert.strictEqual(forged.status, 400);
  assert.strictEqual(forged.json.error.code, 'client_id_forbidden');
  assert.strictEqual(forged.json.error.retryable, false);
  assert.strictEqual(JSON.stringify(forged.json).indexOf('client-chosen-id'), -1, '错误响应不得回显客户端 id');

  // 没有落库：目录里还是空的
  let state = await get(port, '/api/v1/state');
  assert.deepStrictEqual(state.json.assets.instruments, [], '被拒请求不得写入任何标的');

  // 同一请求去掉 id：拿到约定中的派生 id
  const ok = await post(port, '/api/v1/instruments', { symbol: 'VOO' });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.item.id, Catalog.stableIdFromKey('VOO@NYSE'));
  assert.strictEqual(ok.json.item.identityKey, 'VOO@NYSE');

  // 伪造 id 也进不来：即便 id 长得像派生值也不行（服务端只看 symbol@exchange）
  const fakeDerived = await post(port, '/api/v1/instruments', {
    symbol: '2800.HK',
    id: Catalog.stableInstrumentId('2800.HK', 'HKEX')
  });
  assert.strictEqual(fakeDerived.status, 400);
  assert.strictEqual(fakeDerived.json.error.code, 'client_id_forbidden');
});

test('全量 /state 写入：重复去重键整体回滚（409），已存数据不被清空', async (t) => {
  const ctx = setup('ledger-p4b-state-dup-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const base = () => ({
    accounts: [],
    categories: [],
    txns: [],
    settings: {},
    assets: {
      schemaVersion: 1,
      assetAccounts: [],
      assetUnits: [],
      assetTransfers: [],
      liabilities: [],
      entitlements: [],
      instruments: [],
      holdings: [],
      quotes: [],
      fxRates: []
    }
  });

  const seed = base();
  seed.assets.instruments = [{ id: 'inst-a', symbol: 'VOO', exchange: 'NYSE', currency: 'USD' }];
  const first = await request(port, 'PUT', '/api/v1/state', seed);
  assert.strictEqual(first.status, 200);

  // 复核反例原文：inst-a → VOO/NYSE 与 inst-b → voo/nyse 同时落库
  const dup = base();
  dup.assets.instruments = [
    { id: 'inst-a', symbol: 'VOO', exchange: 'NYSE', currency: 'USD' },
    { id: 'inst-b', symbol: 'voo', exchange: 'nyse', currency: 'USD' }
  ];
  const rejected = await request(port, 'PUT', '/api/v1/state', dup);
  assert.strictEqual(rejected.status, 409, '重复标的必须是可修正的冲突，不能报 500');
  assert.strictEqual(rejected.json.error.code, 'duplicate_instrument');

  // 整体回滚：上一次写入的状态原样保留
  const state = await get(port, '/api/v1/state');
  assert.strictEqual(state.json.assets.instruments.length, 1);
  assert.strictEqual(state.json.assets.instruments[0].id, 'inst-a');
});

test('缺交易所时同代码跨市场报 409 ambiguous_instrument，要求用户指明交易所', async (t) => {
  const ctx = setup('ledger-p4b-ambig-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  // 目录里同时存在 NYSE 与 HKEX 的 CROSS
  const nyse = await post(port, '/api/v1/instruments', {
    symbol: 'CROSS',
    source: 'manual',
    currency: 'USD',
    exchange: 'NYSE'
  });
  assert.strictEqual(nyse.status, 201, JSON.stringify(nyse.json));
  const hkex = await post(port, '/api/v1/instruments', {
    symbol: 'CROSS',
    source: 'manual',
    currency: 'HKD',
    exchange: 'HKEX'
  });
  assert.strictEqual(hkex.status, 201, JSON.stringify(hkex.json));

  // 既不报错也不静默合并：报歧义
  const ambiguous = await post(port, '/api/v1/instruments', {
    symbol: 'CROSS',
    source: 'manual',
    currency: 'USD'
  });
  assert.strictEqual(ambiguous.status, 409, JSON.stringify(ambiguous.json));
  assert.strictEqual(ambiguous.json.error.code, 'ambiguous_instrument');
  assert.ok(ambiguous.json.error.message.indexOf('交易所') !== -1, '提示必须说清怎么解决');

  // 两行都在，且行数没有因为报错而变化
  const state = await get(port, '/api/v1/state');
  assert.strictEqual(state.json.assets.instruments.length, 2);

  // 指明交易所后照常命中同一行（不是新建第三行）
  const again = await post(port, '/api/v1/instruments', {
    symbol: 'CROSS',
    source: 'manual',
    currency: 'USD',
    exchange: 'NYSE'
  });
  assert.strictEqual(again.status, 201);
  assert.strictEqual(again.json.item.id, nyse.json.item.id);
  assert.strictEqual(again.json.duplicated, true);
  const after = await get(port, '/api/v1/state');
  assert.strictEqual(after.json.assets.instruments.length, 2);
});

test('先手工建无交易所标的、后补交易所：HTTP 层 id 与 identityKey 都不变', async (t) => {
  const ctx = setup('ledger-p4b-idkey-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const manual = await post(port, '/api/v1/instruments', {
    symbol: 'CROSS',
    source: 'manual',
    currency: 'USD'
  });
  assert.strictEqual(manual.status, 201);
  const firstId = manual.json.item.id;
  assert.strictEqual(firstId, Catalog.stableIdFromKey('CROSS@'));
  assert.strictEqual(manual.json.item.identityKey, 'CROSS@');

  const backfilled = await post(port, '/api/v1/instruments', {
    symbol: 'CROSS',
    source: 'manual',
    currency: 'USD',
    exchange: 'HKEX'
  });
  assert.strictEqual(backfilled.status, 201);
  assert.strictEqual(backfilled.json.item.id, firstId, 'id 一旦分配不得重算');
  assert.strictEqual(backfilled.json.item.identityKey, 'CROSS@', 'identityKey 是首次创建时的值');
  assert.strictEqual(backfilled.json.item.exchange, 'HKEX');

  // 外部可复算：拿 identityKey 就能算出 id（不需要知道当时的交易所）
  assert.strictEqual(Catalog.stableIdFromKey(backfilled.json.item.identityKey), firstId);
  const state = await get(port, '/api/v1/state');
  assert.strictEqual(state.json.assets.instruments.length, 1, '补全交易所不得产生第二行事实');
});
