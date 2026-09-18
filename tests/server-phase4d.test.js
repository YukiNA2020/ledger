/* Phase 4D 行情与汇率 API 端到端测试（临时数据库，虚构数据）
 *
 * 对应 ACCEPTANCE.md S4D.1 / S4D.2 的完整验收链路（走真实 HTTP 入口，不绕过路由）：
 *   建账户 → 建标的 → 期初 10 → POST /market-data/refresh（注入离线 provider）
 *   → 汇率写入并可从 GET /fx-rates 读回 → 行情侧受 D-038 门禁保持 skipped
 *   → 手动补价 → 失败不覆盖 → 备份恢复往返无损。
 * 另覆盖拒绝路径：非法 scopes / asOf、请求体不能打开自动抓取、
 * 自动抓取开启但 provider 未配置、Key 只报告"是否配置"。
 *
 * 全部离线：只使用固定 fixture 与注入的假 provider，绝不访问真实行情网络（AGENTS.md）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const api = require('../server/api');
const config = require('../server/config');
const Fixture = require('../server/providers/fixture');
const KeychainKey = require('../server/providers/keychain-key');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';
const NOW = '2026-09-17T09:00:00Z';

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
    providerNow: () => NOW,
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
  if (body != null) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: config.HOST, port: port, method: method, path: pathname, headers: headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, json: json });
        });
      }
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const post = (port, path, body, opts) => request(port, 'POST', path, body, opts);
const get = (port, path) => request(port, 'GET', path);
const put = (port, path, body, opts) => request(port, 'PUT', path, body, opts);

// 断网模拟：provider 直接抛错（DNS/连接失败），而不是返回结果
const offlineProvider = () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.example.invalid'));

// 前置：账户 + 手工标的（USD），返回 { accountId, instrumentId }
async function seedAccountAndInstrument(port) {
  const acc = await post(port, '/api/v1/accounts', {
    name: '测试券商',
    kind: 'broker',
    pool: 'investable'
  });
  assert.strictEqual(acc.status, 201, '建账户应成功');
  const ins = await post(port, '/api/v1/instruments', {
    symbol: 'VOO',
    currency: 'USD',
    source: 'manual',
    name: '标普500 ETF'
  });
  assert.strictEqual(ins.status, 201, '手工建标的应成功');
  return { accountId: acc.json.item.id, instrumentId: ins.json.item.id };
}

// 让该标的进入「需要行情」的集合：期初持仓（D-044 目标推导只看事实）
async function seedOpening(port, accountId, instrumentId) {
  const res = await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId,
    instrumentId: instrumentId,
    quantity: '10',
    asOf: '2026-09-01'
  });
  assert.strictEqual(res.status, 201, '期初持仓应成功');
}

function scopeOf(summary, name) {
  return summary.scopes.filter((s) => s.scope === name)[0];
}

/* ============================== S4D.1 汇率自动更新 ============================== */

test('S4D.1 汇率自动更新（真实入口）：写入汇率日与抓取时间；行情侧受 D-038 门禁保持 skipped', async (t) => {
  const ctx = setup('ledger-p4d-fx-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  await seedAccountAndInstrument(port);
  ctx.marketDataFetcher = { fx: Fixture.getFxRates };

  const res = await post(port, '/api/v1/market-data/refresh', {
    scopes: ['fx', 'quotes'],
    asOf: '2026-09-17'
  });
  assert.strictEqual(res.status, 200);
  const summary = res.json;
  assert.strictEqual(summary.asOf, '2026-09-17');
  assert.strictEqual(summary.now, NOW);

  const fx = scopeOf(summary, 'fx');
  assert.strictEqual(fx.status, 'updated');
  assert.strictEqual(fx.updated, 1);
  assert.strictEqual(fx.attempts, 1);
  assert.strictEqual(fx.provider, 'fixture');
  assert.strictEqual(fx.endpoint, null, '注入离线 provider 时不冒充 Frankfurter 端点');
  assert.strictEqual(fx.items[0].base, 'USD');
  assert.strictEqual(fx.items[0].quote, 'CNY');
  assert.strictEqual(fx.items[0].rateDate, '2026-09-14');
  assert.strictEqual(fx.items[0].rateDecimal, '7.1900');
  assert.strictEqual(fx.items[0].fetchedAt, NOW, '抓取时间来自服务端注入的 now');

  // 行情侧：D-038 门禁未通过 → 默认关闭，且不发起任何请求
  const quotes = scopeOf(summary, 'quotes');
  assert.strictEqual(quotes.status, 'skipped');
  assert.strictEqual(quotes.reason, 'auto_fetch_disabled');
  assert.strictEqual(quotes.attempts, 0);
  assert.strictEqual(summary.ok, true, '被门禁拦住不算失败');

  // 事实可直读
  const fxRows = await get(port, '/api/v1/fx-rates');
  assert.strictEqual(fxRows.status, 200);
  assert.strictEqual(fxRows.json.items.length, 1);
  assert.strictEqual(fxRows.json.items[0].rateDecimal, '7.1900');
  assert.strictEqual(fxRows.json.items[0].provider, 'fixture');
  const quoteRows = await get(port, '/api/v1/quotes');
  assert.strictEqual(quoteRows.json.items.length, 0, '门禁未通过不得写入任何报价');

  // D-020：刷新报告里不得出现账户名、余额、数量、成本
  const dump = JSON.stringify(summary);
  ['accountId', '测试券商', 'balanceMinor', 'costMinor', 'quantity', '10'].forEach((k) => {
    assert.strictEqual(dump.indexOf(k), -1, '刷新报告不得含 ' + k);
  });
});

/* ============================== S4D.2 手动补价兜底 ============================== */

test('S4D.2 手动补价兜底：可写入、可读回、同日替换；非法载荷按错误码拒绝', async (t) => {
  const ctx = setup('ledger-p4d-manual-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { instrumentId } = await seedAccountAndInstrument(port);

  // 合法补价
  const ok = await post(port, '/api/v1/quotes', {
    instrumentId: instrumentId,
    priceMinor: 4992,
    priceDate: '2026-09-14'
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.source, 'manual');
  assert.strictEqual(ok.json.item.provider, 'manual', '补价的来源固定为 manual');
  assert.strictEqual(ok.json.item.currency, 'USD', '币种由标的推导，不经调用方声明');

  // 同一天再次补价 → 替换，不并存
  const again = await post(port, '/api/v1/quotes', {
    instrumentId: instrumentId,
    priceMinor: 5010,
    priceDate: '2026-09-14'
  });
  assert.strictEqual(again.status, 201);
  const rows = await get(port, '/api/v1/quotes');
  assert.strictEqual(rows.json.items.length, 1, '同一元素键只保留一行');
  assert.strictEqual(rows.json.items[0].priceMinor, 5010);

  // 另一天 → 各留一行（手动事实是「这一天」的确认值）
  const other = await post(port, '/api/v1/quotes', {
    instrumentId: instrumentId,
    priceMinor: 4800,
    priceDate: '2026-09-11'
  });
  assert.strictEqual(other.status, 201);
  assert.strictEqual((await get(port, '/api/v1/quotes')).json.items.length, 2);

  // 拒绝路径
  const cases = [
    [{ priceMinor: 4992, priceDate: '2026-09-14' }, 400, 'invalid_instrument_id'],
    [{ instrumentId: instrumentId, priceMinor: 0, priceDate: '2026-09-14' }, 400, 'invalid_price'],
    [{ instrumentId: instrumentId, priceMinor: 4992, priceDate: '2026-13-01' }, 400, 'invalid_price_date'],
    [
      { instrumentId: instrumentId, priceMinor: 4992, priceDate: '2026-09-14', currency: 'HKD' },
      422,
      'currency_mismatch'
    ],
    [{ instrumentId: 'inst-nope', priceMinor: 4992, priceDate: '2026-09-14' }, 422, 'unknown_instrument']
  ];
  for (const [body, status, code] of cases) {
    const bad = await post(port, '/api/v1/quotes', body);
    assert.strictEqual(bad.status, status, code + ' 应返回 ' + status);
    assert.strictEqual(bad.json.error.code, code);
  }
  const notObject = await post(port, '/api/v1/quotes', []);
  assert.strictEqual(notObject.status, 400);
  assert.strictEqual(notObject.json.error.code, 'invalid_quote');

  // 被拒的写入不得留下痕迹
  assert.strictEqual((await get(port, '/api/v1/quotes')).json.items.length, 2);
});

test('4C 反例：显式错误资产集合类型被拒绝，不能把 holdings/quotes/fxRates 静默清空', async (t) => {
  const ctx = setup('ledger-p4c-collection-shape-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);
  await seedOpening(port, accountId, instrumentId);

  const quote = await post(port, '/api/v1/quotes', {
    instrumentId: instrumentId,
    priceMinor: 4992,
    priceDate: '2026-09-14'
  });
  assert.strictEqual(quote.status, 201);
  const fx = await post(port, '/api/v1/fx-rates', {
    base: 'USD', quote: 'CNY', rateDecimal: '7.1900', rateDate: '2026-09-14'
  });
  assert.strictEqual(fx.status, 201);

  for (const key of ['holdings', 'quotes', 'fxRates']) {
    const state = (await get(port, '/api/v1/state')).json;
    state.assets[key] = {};
    const rejected = await put(port, '/api/v1/state', { state: state });
    assert.strictEqual(rejected.status, 400, key + ' 错误类型必须返回 400');
    assert.strictEqual(rejected.json.error.code, 'invalid_asset_collection');
    assert.ok(rejected.json.error.message.indexOf(key) >= 0, '错误应点名集合：' + key);

    const after = (await get(port, '/api/v1/state')).json;
    assert.strictEqual(after.assets.holdings.length, 1, key + ' 被拒后期初不得丢失');
    assert.strictEqual(after.assets.quotes.length, 1, key + ' 被拒后报价不得丢失');
    assert.strictEqual(after.assets.fxRates.length, 1, key + ' 被拒后汇率不得丢失');
  }
});

test('4C 反例：根 state 数组与显式空 assets 均在清库前拒绝，既有事实原样保留', async (t) => {
  const ctx = setup('ledger-p4c-root-shape-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);
  await seedOpening(port, accountId, instrumentId);
  assert.strictEqual((await post(port, '/api/v1/quotes', {
    instrumentId: instrumentId, priceMinor: 4992, priceDate: '2026-09-14'
  })).status, 201);
  assert.strictEqual((await post(port, '/api/v1/fx-rates', {
    base: 'USD', quote: 'CNY', rateDecimal: '7.1900', rateDate: '2026-09-14'
  })).status, 201);

  const baseline = (await get(port, '/api/v1/state')).json;
  const cases = [
    { body: [], code: 'invalid_state', label: 'raw state=[]' },
    { body: { state: [] }, code: 'invalid_state', label: 'wrapped state=[]' },
    { body: { state: Object.assign({}, baseline, { assets: null }) }, code: 'invalid_assets', label: 'assets=null' },
    { body: { state: Object.assign({}, baseline, { assets: [] }) }, code: 'invalid_assets', label: 'assets=[]' },
    { body: { state: Object.assign({}, baseline, { assets: 'bad-assets' }) }, code: 'invalid_assets', label: 'assets=string' },
    { body: { state: Object.assign({}, baseline, { assets: {} }) }, code: 'invalid_assets', label: 'assets={}' }
  ];
  for (const row of cases) {
    const rejected = await put(port, '/api/v1/state', row.body);
    assert.strictEqual(rejected.status, 400, row.label + ' 必须返回 400');
    assert.strictEqual(rejected.json.error.code, row.code, row.label + ' 错误码');
    assert.deepStrictEqual((await get(port, '/api/v1/state')).json, baseline, row.label + ' 不得改变既有事实');
  }
});

/* ============================== D-038 启用门禁 ============================== */

test('D-038 请求体不能打开自动行情抓取：开关只从服务端 settings 读取', async (t) => {
  const ctx = setup('ledger-p4d-gate-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);
  await seedOpening(port, accountId, instrumentId);

  let calls = 0;
  ctx.marketDataFetcher = {
    quotes: (symbols, asOf, c) => {
      calls += 1;
      return Fixture.getEndOfDayQuotes(symbols, asOf, c);
    },
    quotesProviderId: 'fixture'
  };

  // 请求体里塞满"打开开关"的字段：服务端一律不信
  const res = await post(port, '/api/v1/market-data/refresh', {
    scopes: ['quotes'],
    asOf: '2026-09-17',
    autoQuotesEnabled: true,
    autoQuotes: true,
    marketDataAutoQuotes: true,
    quotesFetch: 'client-supplied'
  });
  assert.strictEqual(res.status, 200);
  const quotes = scopeOf(res.json, 'quotes');
  assert.strictEqual(quotes.status, 'skipped');
  assert.strictEqual(quotes.reason, 'auto_fetch_disabled');
  assert.strictEqual(calls, 0, '门禁未通过时不得调用 provider');
  assert.strictEqual((await get(port, '/api/v1/quotes')).json.items.length, 0);
});

test('D-038 服务端开关打开并注入 provider：行情写入 provider 与原始代码；失败不覆盖既有值', async (t) => {
  const ctx = setup('ledger-p4d-on-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);
  await seedOpening(port, accountId, instrumentId);

  // 开关写在服务端 settings（不是请求体）
  const before = await get(port, '/api/v1/state');
  const st = before.json;
  st.settings = Object.assign({}, st.settings || {}, { marketDataAutoQuotes: true });
  const saved = await put(port, '/api/v1/state', { state: st });
  assert.strictEqual(saved.status, 200);

  ctx.marketDataFetcher = { quotes: Fixture.getEndOfDayQuotes, quotesProviderId: 'fixture' };
  const first = await post(port, '/api/v1/market-data/refresh', {
    scopes: ['quotes'],
    asOf: '2026-09-15'
  });
  assert.strictEqual(first.status, 200);
  const q1 = scopeOf(first.json, 'quotes');
  assert.strictEqual(q1.status, 'updated');
  assert.strictEqual(q1.updated, 1);
  assert.strictEqual(q1.provider, 'fixture');
  assert.strictEqual(q1.items[0].priceDate, '2026-09-14');
  assert.strictEqual(q1.items[0].sourceSymbol, 'VOO', 'provider 原始代码留档');

  const rows = await get(port, '/api/v1/quotes');
  assert.strictEqual(rows.json.items.length, 1);
  assert.strictEqual(rows.json.items[0].provider, 'fixture');
  assert.strictEqual(rows.json.items[0].sourceSymbol, 'VOO');
  assert.strictEqual(rows.json.items[0].priceMinor, 4992);

  // 同一元素键上的自动值可被更新的观测替换（不是永久冻结）
  ctx.marketDataFetcher = {
    quotes: (symbols, asOf, c) =>
      Fixture.getEndOfDayQuotes(symbols, asOf, c).then((out) => {
        out[0].priceMinor = 5150;
        return out;
      }),
    quotesProviderId: 'fixture'
  };
  await post(port, '/api/v1/market-data/refresh', { scopes: ['quotes'], asOf: '2026-09-15' });
  const replaced = await get(port, '/api/v1/quotes');
  assert.strictEqual(replaced.json.items.length, 1, '同一元素键仍只有一行');
  assert.strictEqual(replaced.json.items[0].priceMinor, 5150);

  // provider 超时 → 200 + ok:false + retryable，绝不改动已有行
  ctx.marketDataFetcher = { quotes: offlineProvider, quotesProviderId: 'fixture' };
  const failed = await post(port, '/api/v1/market-data/refresh', {
    scopes: ['quotes'],
    asOf: '2026-09-17'
  });
  assert.strictEqual(failed.status, 200, '外部不可达不是客户端错误');
  assert.strictEqual(failed.json.ok, false);
  const q2 = scopeOf(failed.json, 'quotes');
  assert.strictEqual(q2.status, 'failed');
  assert.strictEqual(q2.attempts, 2, '可重试的失败用满有限重试次数');
  assert.strictEqual(q2.errors[0].code, 'timeout');
  assert.strictEqual(q2.errors[0].retryable, true);
  const after = await get(port, '/api/v1/quotes');
  assert.strictEqual(after.json.items.length, 1);
  assert.strictEqual(after.json.items[0].priceMinor, 5150, '失败不得覆盖最后有效值');
});

test('手动价格锁定时顶层刷新原因是 manual_locked，不得误报 no_targets', async (t) => {
  const ctx = setup('ledger-p4d-manual-reason-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);
  await seedOpening(port, accountId, instrumentId);

  const state = (await get(port, '/api/v1/state')).json;
  state.settings = Object.assign({}, state.settings || {}, { marketDataAutoQuotes: true });
  assert.strictEqual((await put(port, '/api/v1/state', { state: state })).status, 200);
  assert.strictEqual((await post(port, '/api/v1/quotes', {
    instrumentId: instrumentId,
    priceMinor: 9999,
    priceDate: '2026-09-14'
  })).status, 201);

  ctx.marketDataFetcher = { quotes: Fixture.getEndOfDayQuotes, quotesProviderId: 'fixture' };
  const refreshed = await post(port, '/api/v1/market-data/refresh', {
    scopes: ['quotes'],
    asOf: '2026-09-15'
  });
  assert.strictEqual(refreshed.status, 200);
  const quotes = scopeOf(refreshed.json, 'quotes');
  assert.strictEqual(quotes.requested, 1);
  assert.strictEqual(quotes.status, 'skipped');
  assert.strictEqual(quotes.reason, 'manual_locked');
  assert.strictEqual(quotes.skipped[0].reason, 'manual_locked');
  const stored = (await get(port, '/api/v1/quotes')).json.items;
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].provider, 'manual');
  assert.strictEqual(stored[0].priceMinor, 9999);
});

test('自动行情开关打开但 provider 未配置：skipped(provider_not_configured)，Key 只报告是否配置', async (t) => {
  const ctx = setup('ledger-p4d-noprovider-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);
  await seedOpening(port, accountId, instrumentId);

  const before = await get(port, '/api/v1/state');
  const st = before.json;
  st.settings = Object.assign({}, st.settings || {}, { marketDataAutoQuotes: true });
  await put(port, '/api/v1/state', { state: st });

  // 不注入 ctx.marketDataFetcher：等价于"没有通过门禁的真实源"
  const res = await post(port, '/api/v1/market-data/refresh', {
    scopes: ['quotes'],
    asOf: '2026-09-17'
  });
  assert.strictEqual(res.status, 200);
  const quotes = scopeOf(res.json, 'quotes');
  assert.strictEqual(quotes.status, 'skipped');
  assert.strictEqual(quotes.reason, 'provider_not_configured');
  assert.strictEqual(quotes.attempts, 0);

  // Key 状态只报"有没有配好"，形状固定，不含密钥内容
  const key = res.json.marketDataKey;
  assert.ok(key && typeof key === 'object', '应报告 Key 状态');
  assert.strictEqual(typeof key.configured, 'boolean');
  assert.strictEqual(typeof key.service, 'string');
  assert.deepStrictEqual(Object.keys(key).sort(), ['configured', 'error', 'service']);
  assert.strictEqual(typeof KeychainKey.DEFAULT_SERVICE, 'string');
  assert.strictEqual((await get(port, '/api/v1/quotes')).json.items.length, 0);
});

/* ============================== 参数校验 ============================== */

test('刷新参数校验：scopes 形状/未知作用域/asOf 真实性/请求体类型', async (t) => {
  const ctx = setup('ledger-p4d-args-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const cases = [
    [{ scopes: 'fx' }, 400, 'invalid_scope'],
    [{ scopes: ['fx', 'crypto'] }, 400, 'invalid_scope'],
    [{ scopes: ['fx'], asOf: '2026-13-01' }, 400, 'invalid_date'],
    [{ scopes: ['fx'], asOf: '2026-09-31' }, 400, 'invalid_date'],
    [[], 400, 'invalid_json']
  ];
  for (const [body, status, code] of cases) {
    const res = await post(port, '/api/v1/market-data/refresh', body);
    assert.strictEqual(res.status, status, code + ' 应返回 ' + status);
    assert.strictEqual(res.json.error.code, code);
  }

  // 合法：无 scopes 时退化为全部作用域（无目标 → 都是 skipped，不算失败）
  const ok = await post(port, '/api/v1/market-data/refresh', { asOf: '2026-09-17' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json.scopeOrder, ['fx', 'quotes']);
});

/* ============================== 备份 / 恢复往返 ============================== */

test('备份恢复往返：quotes 与 fx_rates 一并往返，来源标记不丢', async (t) => {
  const ctx = setup('ledger-p4d-backup-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);
  await seedOpening(port, accountId, instrumentId);

  // 备份点：一条手动补价 + 一条自动汇率
  const quoted = await post(port, '/api/v1/quotes', {
    instrumentId: instrumentId,
    priceMinor: 4992,
    priceDate: '2026-09-14'
  });
  assert.strictEqual(quoted.status, 201);
  ctx.marketDataFetcher = { fx: Fixture.getFxRates };
  const refreshed = await post(port, '/api/v1/market-data/refresh', {
    scopes: ['fx'],
    asOf: '2026-09-17'
  });
  assert.strictEqual(scopeOf(refreshed.json, 'fx').status, 'updated');

  const backup = await post(port, '/api/v1/backups', {});
  assert.strictEqual(backup.status, 201);
  const backupName = backup.json.backup.name;

  // 备份后改动两条事实
  await post(port, '/api/v1/quotes', {
    instrumentId: instrumentId,
    priceMinor: 5150,
    priceDate: '2026-09-14'
  });
  const manualFx = await post(port, '/api/v1/fx-rates', {
    base: 'USD',
    quote: 'CNY',
    rateDecimal: '7.0000',
    rateDate: '2026-09-17'
  });
  assert.strictEqual(manualFx.status, 201);
  assert.strictEqual((await get(port, '/api/v1/quotes')).json.items[0].priceMinor, 5150);

  // 恢复到备份点
  const restore = await post(port, '/api/v1/restores', { file: backupName });
  assert.strictEqual(restore.status, 200);
  assert.strictEqual(restore.json.ok, true);

  const quoteRows = await get(port, '/api/v1/quotes');
  assert.strictEqual(quoteRows.json.items.length, 1, '报价回到备份点');
  assert.strictEqual(quoteRows.json.items[0].priceMinor, 4992);
  assert.strictEqual(quoteRows.json.items[0].provider, 'manual');
  const fxRows = await get(port, '/api/v1/fx-rates');
  assert.strictEqual(fxRows.json.items.length, 1, '汇率回到备份点');
  assert.strictEqual(fxRows.json.items[0].rateDecimal, '7.1900');
  assert.strictEqual(fxRows.json.items[0].provider, 'fixture', '来源标记随备份往返');
});
