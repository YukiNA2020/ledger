/* Phase 4D 行情编排层测试（server/market-data.js）
 * 对应 ACCEPTANCE.md S4D.1/S4D.2、ROADMAP Phase 4D 与 DECISIONS D-043/D-044。
 *
 * 覆盖：成功 / 断网（provider 抛异常）/ 超时 / 限额 / 缺标的 / 节假日回退 /
 *       有限重试次数 / 错误响应不覆盖最后有效值 / 不可入账数据拒绝落库 /
 *       自动抓取默认关闭 / 手动值不被自动值覆盖 / provider 原始代码留档 /
 *       Keychain Key 读取路径（不打印、不落盘）。
 *
 * 全部离线：只使用固定 fixture 与注入的假 provider，绝不访问真实网络（AGENTS.md 测试门禁）。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const dbm = require('../server/db');
const migrations = require('../server/migrations');
const R = require('../server/repository');
const MD = require('../server/market-data');
const Fixture = require('../server/providers/fixture');
const Contract = require('../server/providers/contract');
const KeychainKey = require('../server/providers/keychain-key');

const NOW = '2026-09-17T09:00:00Z';

function freshDb() {
  const db = dbm.openDatabase(':memory:');
  migrations.migrate(db);
  return db;
}

function addInstrument(db, id, symbol, exchange, currency) {
  dbm.run(
    db,
    'INSERT INTO instruments (id, symbol, exchange, currency) VALUES (?, ?, ?, ?)',
    [id, symbol, exchange, currency]
  );
  return id;
}

function assertScopeAccounting(scope) {
  assert.strictEqual(
    scope.requested,
    scope.updated + scope.skipped.length + scope.errors.length,
    '每个请求目标必须恰好结算为 updated / skipped / error 之一'
  );
}

function scopeOf(summary, name) {
  return summary.scopes.filter((scope) => scope.scope === name)[0];
}

// 断网模拟：provider 直接抛错（DNS/连接失败），而不是返回结果
function offlineProvider() {
  return () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.example.invalid'));
}

test('S4D.1 汇率自动更新成功：写入价格日、抓取时间、provider 与端点', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      fxFetch: Fixture.getFxRates
    });
    assert.strictEqual(summary.ok, true);
    const fx = summary.scopes.filter((s) => s.scope === 'fx')[0];
    assert.strictEqual(fx.status, 'updated');
    assert.strictEqual(fx.updated, 1);
    assert.strictEqual(fx.attempts, 1);
    assert.strictEqual(fx.items[0].base, 'USD');
    assert.strictEqual(fx.items[0].quote, 'CNY');
    assert.strictEqual(fx.items[0].rateDate, '2026-09-14'); // fixture 最近一个 <= asOf 的点
    assert.strictEqual(fx.items[0].fetchedAt, NOW); // 抓取时间来自 ctx.now，不用内部时钟
    assert.strictEqual(fx.items[0].provider, 'fixture');
    const rows = R.readFxRates(db);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].fetchedAt, NOW);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.1 行情自动更新成功：保存价格日、provider 与原始代码（sourceSymbol）', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-15',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' }],
      quotesFetch: Fixture.getEndOfDayQuotes,
      quotesProviderId: 'fixture'
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.status, 'updated');
    assert.strictEqual(q.updated, 1);
    const rows = R.readQuotes(db);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].priceDate, '2026-09-14');
    assert.strictEqual(rows[0].provider, 'fixture');
    assert.strictEqual(rows[0].sourceSymbol, 'VOO'); // provider 返回的原始代码留档
    assert.strictEqual(rows[0].fetchedAt, NOW);
    assert.strictEqual(rows[0].priceMinor, 4992);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 自动行情抓取默认关闭：D-038 门禁未通过时不发起任何请求', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    let called = 0;
    const spy = (items, asOf, ctx) => {
      called += 1;
      return Fixture.getEndOfDayQuotes(items, asOf, ctx);
    };
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['quotes'],
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' }],
      quotesFetch: spy
      // autoQuotesEnabled 缺省 → false
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.status, 'skipped');
    assert.strictEqual(q.reason, 'auto_fetch_disabled');
    assert.strictEqual(q.attempts, 0);
    assert.strictEqual(called, 0, '门禁未通过时不得调用 provider');
    assert.strictEqual(R.readQuotes(db).length, 0);
    assert.strictEqual(summary.ok, true, '被门禁拦住不算失败');
    assertScopeAccounting(q);
    assert.strictEqual(q.skipped.length, 1, '被门禁拦住的目标也必须逐项记为 skipped');
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 超时：有限重试后仍失败，最后有效值不被覆盖', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    R.upsertManualQuote(
      db,
      { instrumentId: 'inst-voo', priceMinor: 5000, priceDate: '2026-09-14' },
      { now: '2026-09-14T09:00:00Z' }
    );
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'SLOW.ETF' }],
      quotesFetch: Fixture.getEndOfDayQuotes
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.status, 'failed');
    assert.strictEqual(q.attempts, MD.MAX_ATTEMPTS, 'timeout 可重试 → 用满尝试次数');
    assert.strictEqual(q.errors.length, 1);
    assert.strictEqual(q.errors[0].code, 'timeout');
    assert.strictEqual(q.errors[0].retryable, true);
    const rows = R.readQuotes(db);
    assert.strictEqual(rows.length, 1, '失败不得改动已有行');
    assert.strictEqual(rows[0].priceMinor, 5000);
    assert.strictEqual(rows[0].priceDate, '2026-09-14');
    assert.strictEqual(summary.ok, false);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 断网：provider 抛异常按暂时性失败处理，不写库也不抛到上层', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      fxFetch: offlineProvider(),
      pairs: [{ base: 'USD', quote: 'CNY' }]
    });
    const fx = summary.scopes.filter((s) => s.scope === 'fx')[0];
    assert.strictEqual(fx.status, 'failed');
    assert.strictEqual(fx.errors[0].code, 'timeout');
    assert.strictEqual(fx.attempts, MD.MAX_ATTEMPTS);
    assert.strictEqual(R.readFxRates(db).length, 0);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 限额：rate_limit 可重试，重试用尽后如实报告且不覆盖旧值', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    R.upsertManualQuote(
      db,
      { instrumentId: 'inst-voo', priceMinor: 4800, priceDate: '2026-09-11' },
      { now: '2026-09-11T09:00:00Z' }
    );
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'LIMITED.ETF' }],
      quotesFetch: Fixture.getEndOfDayQuotes
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.errors[0].code, 'rate_limit');
    assert.strictEqual(q.attempts, MD.MAX_ATTEMPTS);
    assert.strictEqual(R.readQuotes(db)[0].priceMinor, 4800, '限额失败不得覆盖最后有效值');
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 缺标的：not_found 不写入，且可重试语义为否', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-unknown', 'UNKNOWN.ETF', 'NASDAQ', 'USD');
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-unknown', symbol: 'UNKNOWN.ETF', providerSymbol: 'UNKNOWN.ETF' }],
      quotesFetch: Fixture.getEndOfDayQuotes
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.status, 'failed');
    assert.strictEqual(q.errors[0].code, 'not_found');
    assert.strictEqual(q.errors[0].retryable, false);
    assert.strictEqual(q.attempts, 1, '不可重试的错误不重复请求');
    assert.strictEqual(R.readQuotes(db).length, 0);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 节假日：休市日回退到最近交易日，且绝不返回晚于 asOf 的数据', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-holiday', 'HOLIDAY.MK', 'NYSE', 'USD');
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-15', // fixture 中该标的 09-14/09-15 休市
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-holiday', symbol: 'HOLIDAY.MK', providerSymbol: 'HOLIDAY.MK' }],
      quotesFetch: Fixture.getEndOfDayQuotes
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.status, 'updated');
    assert.strictEqual(q.items[0].priceDate, '2026-09-11');
    assert.ok(q.items[0].priceDate <= '2026-09-15', '绝不返回未来数据');

    // asOf 早于数据起始日 → not_found，不落任何行
    const before = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-01-02',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-holiday', symbol: 'HOLIDAY.MK', providerSymbol: 'HOLIDAY.MK' }],
      quotesFetch: Fixture.getEndOfDayQuotes
    });
    const q2 = before.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q2.errors[0].code, 'not_found');
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 不可入账数据一律拒绝落库（负价格 / 非法汇率 → invalid_payload）', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-garbage', 'GARBAGE.ETF', 'NASDAQ', 'USD');
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-garbage', symbol: 'GARBAGE.ETF', providerSymbol: 'GARBAGE.ETF' }],
      quotesFetch: Fixture.getEndOfDayQuotes
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.errors[0].code, 'invalid_payload');
    assert.strictEqual(R.readQuotes(db).length, 0, '不可入账数据不得写入');

    // 汇率：fixture 的 III/JJJ 定点为 '0'（形状合法但不值钱），契约拒绝
    const fx = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['fx'],
      pairs: [{ base: 'III', quote: 'JJJ' }],
      fxFetch: Fixture.getFxRates
    });
    const fxScope = fx.scopes.filter((s) => s.scope === 'fx')[0];
    assert.strictEqual(fxScope.errors[0].code, 'invalid_payload');
    assert.strictEqual(R.readFxRates(db).length, 0);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 provider 结果不是数组时判为 invalid_payload，而不是当成空结果', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['fx'],
      pairs: [{ base: 'USD', quote: 'CNY' }],
      fxFetch: () => Promise.resolve({ error: 'oops' })
    });
    const fx = summary.scopes.filter((s) => s.scope === 'fx')[0];
    assert.strictEqual(fx.status, 'failed');
    assert.strictEqual(fx.errors[0].code, 'invalid_payload');
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 手动值不被自动值覆盖（D-044 ②）：同一天或更早的手动价格冻结', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    R.upsertManualQuote(
      db,
      { instrumentId: 'inst-voo', priceMinor: 9999, priceDate: '2026-09-14' },
      { now: '2026-09-14T09:00:00Z' }
    );
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' }],
      quotesFetch: Fixture.getEndOfDayQuotes
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.updated, 0);
    assert.strictEqual(q.skipped.length, 1);
    assert.strictEqual(q.skipped[0].reason, 'manual_locked');
    assert.strictEqual(q.reason, 'manual_locked');
    const rows = R.readQuotes(db);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].priceMinor, 9999, '手动确认过的价格不被自动值覆盖');
    assert.strictEqual(rows[0].provider, 'manual');
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 报价的手动锁覆盖「更早」的自动观测（D-044 ②）', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    R.upsertManualQuote(
      db,
      { instrumentId: 'inst-voo', priceMinor: 9999, priceDate: '2026-09-14' },
      { now: '2026-09-14T09:00:00Z' }
    );
    // asOf 打在手动数据日之前：provider 会给出 09-11 这一更早的观测
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-11',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' }],
      quotesFetch: Fixture.getEndOfDayQuotes
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.updated, 0);
    assert.strictEqual(q.skipped.length, 1);
    assert.strictEqual(q.skipped[0].reason, 'manual_locked');
    assert.strictEqual(q.reason, 'manual_locked');
    const rows = R.readQuotes(db);
    assert.strictEqual(rows.length, 1, '更早的自动观测不得写入');
    assert.strictEqual(rows[0].priceDate, '2026-09-14');
    assert.strictEqual(rows[0].priceMinor, 9999);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 汇率的手动锁同样覆盖「更早」的自动观测（与报价同一口径）', async () => {
  const db = freshDb();
  try {
    R.upsertFxRate(
      db,
      { base: 'USD', quote: 'CNY', rateDecimal: '7.1500', rateDate: '2026-09-14' },
      { now: '2026-09-14T09:00:00Z' }
    );
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-11',
      scopes: ['fx'],
      pairs: [{ base: 'USD', quote: 'CNY' }],
      fxFetch: Fixture.getFxRates
    });
    const fx = summary.scopes.filter((s) => s.scope === 'fx')[0];
    assert.strictEqual(fx.updated, 0);
    assert.strictEqual(fx.skipped[0].reason, 'manual_locked');
    assert.strictEqual(fx.reason, 'manual_locked');
    const rows = R.readFxRates(db);
    assert.strictEqual(rows.length, 1, '更早的自动观测不得写入');
    assert.strictEqual(rows[0].rateDate, '2026-09-14');
    assert.strictEqual(rows[0].rateDecimal, '7.1500');
  } finally {
    dbm.closeQuietly(db);
  }
});

test('D-044 ③ 元素键替换：同一标的同一价格日只保留一行，取值不依赖数据库行序', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    R.upsertManualQuote(
      db,
      { instrumentId: 'inst-voo', priceMinor: 4000, priceDate: '2026-09-10' },
      { now: '2026-09-10T09:00:00Z' }
    );
    // 同一个 asOf 连抓两次：第二次价格不同 → 同一元素键（标的 + 价格日）必须被替换而不是并存
    function fetchWith(priceMinor) {
      return (symbols, asOf, ctx) =>
        Fixture.getEndOfDayQuotes(symbols, asOf, ctx).then((out) => {
          out[0].priceMinor = priceMinor;
          return out;
        });
    }
    const target = { instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' };
    await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-14',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [target],
      quotesFetch: fetchWith(4992)
    });
    assert.strictEqual(
      R.readQuotes(db).filter((r) => r.priceDate === '2026-09-14').length,
      1,
      '同一元素键只应有一行'
    );

    await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-14',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [target],
      quotesFetch: fetchWith(5150)
    });
    const same = R.readQuotes(db).filter((r) => r.priceDate === '2026-09-14');
    assert.strictEqual(same.length, 1, '同一元素键第二次写入必须替换，不得并存');
    assert.strictEqual(same[0].priceMinor, 5150, '取值是后写入的那一行，不依赖数据库行序');
    assert.strictEqual(R.readQuotes(db).length, 2, '手动行（09-10）+ 自动行（09-14）各一行');
  } finally {
    dbm.closeQuietly(db);
  }
});

test('D-044 目标推导：只有已持有/已报价的标的成为自动更新目标，本地代码按市场拼成公开代码', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-0700', '0700', 'HKEX', 'HKD');
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    dbm.run(db, 'INSERT INTO asset_accounts (id, name, kind, pool) VALUES (?, ?, ?, ?)', [
      'acc-1',
      '券商',
      'broker',
      'investable'
    ]);
    dbm.run(
      db,
      'INSERT INTO portfolio_openings (id, account_id, instrument_id, quantity) VALUES (?, ?, ?, ?)',
      ['opening-1', 'acc-1', 'inst-0700', '100']
    );

    const derived = MD.marketDataTargets(db);
    assert.deepStrictEqual(
      derived.quoteTargets.map((t) => t.providerSymbol),
      ['0700.HK'],
      '没有持仓/事件/报价的标的不会成为自动更新目标'
    );
    assert.strictEqual(derived.quoteTargets[0].instrumentId, 'inst-0700');
    // 汇率目标：账上出现过的非 CNY 币种 → 对 CNY（CNY 自身不生成币对）
    assert.deepStrictEqual(
      derived.pairs.map((p) => p.base + '/' + p.quote),
      ['HKD/CNY', 'USD/CNY']
    );

    // 纯函数：本地代码 + 交易所 → 公开代码形状
    assert.strictEqual(MD.symbolForProvider({ symbol: '0700', exchange: 'HKEX' }), '0700.HK');
    assert.strictEqual(MD.symbolForProvider({ symbol: '600519', exchange: 'SSE' }), '600519.SS');
    assert.strictEqual(MD.symbolForProvider({ symbol: '000001', exchange: 'SZSE' }), '000001.SS');
    assert.strictEqual(MD.symbolForProvider({ symbol: 'VOO', exchange: 'NYSE' }), 'VOO');
    assert.strictEqual(
      MD.symbolForProvider({ symbol: 'VOO.US', exchange: 'NYSE' }),
      'VOO.US',
      '已是带后缀的公开代码不再二次拼接'
    );
    assert.strictEqual(MD.symbolForProvider({ symbol: '', exchange: 'NYSE' }), null);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('S4D.2 汇率同样遵守手动锁：手动登记过的币对不被同一天或更早的自动值覆盖', async () => {
  const db = freshDb();
  try {
    R.upsertFxRate(
      db,
      { base: 'USD', quote: 'CNY', rateDecimal: '7.1500', rateDate: '2026-09-14' },
      { now: '2026-09-14T09:00:00Z' }
    );
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['fx'],
      pairs: [{ base: 'USD', quote: 'CNY' }],
      fxFetch: Fixture.getFxRates
    });
    const fx = summary.scopes.filter((s) => s.scope === 'fx')[0];
    assert.strictEqual(fx.skipped[0].reason, 'manual_locked');
    const rows = R.readFxRates(db);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].rateDecimal, '7.1500');
    assert.strictEqual(rows[0].provider, 'manual');
  } finally {
    dbm.closeQuietly(db);
  }
});

test('自动更新的 provider 不得冒充 manual 来源（写入被拒）', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    assert.throws(
      () => R.upsertProviderQuote(db, {
        instrumentId: 'inst-voo',
        priceMinor: 5000,
        priceDate: '2026-09-14',
        provider: 'manual'
      }),
      (e) => e && e.code === 'invalid_provider'
    );
    assert.throws(
      () => R.upsertProviderFxRate(db, {
        base: 'USD', quote: 'CNY', rateDecimal: '7.1', rateDate: '2026-09-14', provider: 'manual'
      }),
      (e) => e && e.code === 'invalid_provider'
    );
  } finally {
    dbm.closeQuietly(db);
  }
});

test('无目标时不发请求（no_targets），也不会被当成失败', async () => {
  const db = freshDb();
  try {
    let called = 0;
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      fxFetch: () => {
        called += 1;
        return Promise.resolve([]);
      },
      quotesFetch: () => {
        called += 1;
        return Promise.resolve([]);
      },
      autoQuotesEnabled: true
    });
    assert.strictEqual(called, 0);
    assert.strictEqual(summary.ok, true);
    summary.scopes.forEach((s) => {
      assert.strictEqual(s.status, 'skipped');
      assert.ok(['no_targets', 'auto_fetch_disabled'].indexOf(s.reason) !== -1);
      if (s.reason === 'no_targets') assert.strictEqual(s.requested, 0, 'no_targets 只允许用于 requested=0');
    });
  } finally {
    dbm.closeQuietly(db);
  }
});

test('作用域归一：未知作用域被忽略、空数组退化为全部作用域', () => {
  assert.deepStrictEqual(MD.normalizeScopes(['quotes']), ['quotes']);
  assert.deepStrictEqual(MD.normalizeScopes(['quotes', 'quotes']), ['quotes']);
  assert.deepStrictEqual(MD.normalizeScopes(['nope', 'fx']), ['fx']);
  assert.deepStrictEqual(MD.normalizeScopes([]), ['fx', 'quotes']);
  assert.deepStrictEqual(MD.normalizeScopes(null), ['fx', 'quotes']);
});

test('请求产物只含公开代码：provider 收到的输入里没有任何账户/持仓字段', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    let seen = null;
    await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-17',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' }],
      quotesFetch: (items, asOf, ctx) => {
        seen = { items: items, asOf: asOf, ctx: ctx };
        return Fixture.getEndOfDayQuotes(items, asOf, ctx);
      }
    });
    assert.deepStrictEqual(seen.items, ['VOO']);
    assert.deepStrictEqual(Object.keys(seen.ctx).sort(), ['asOf', 'now']);
    // 请求产物里不得出现任何账户/持仓/成本字段名
    const dump = JSON.stringify(seen);
    ['accountId', 'accountName', 'balanceMinor', 'costMinor', 'quantity'].forEach((k) => {
      assert.strictEqual(dump.indexOf(k), -1, '请求产物不得含 ' + k);
    });
  } finally {
    dbm.closeQuietly(db);
  }
});

test('provider 返回未请求的标的时显式拒绝写入（不得张冠李戴）', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-15',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' }],
      // provider 回了一个我们没请求的代码
      quotesFetch: (items, asOf, ctx) => Fixture.getEndOfDayQuotes(['0700.HK'], asOf, ctx)
    });
    const q = summary.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(q.updated, 0);
    assert.strictEqual(q.errors[0].code, Contract.ERRORS.INVALID_PAYLOAD);
    assert.strictEqual(R.readQuotes(db).length, 0);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('4D 反例：汇率 provider 返回未请求币对时整批拒绝，不得把 HKD/CNY 写成 USD/CNY 的结果', async () => {
  const db = freshDb();
  try {
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-18',
      scopes: ['fx'],
      pairs: [{ base: 'USD', quote: 'CNY' }],
      fxFetch: () => Promise.resolve([Contract.fxResult({
        base: 'HKD', quote: 'CNY', rateDecimal: '0.9200', rateDate: '2026-09-18',
        fetchedAt: NOW, provider: 'bad-fixture'
      })])
    });
    const fx = scopeOf(summary, 'fx');
    assert.strictEqual(fx.status, 'failed');
    assert.strictEqual(fx.updated, 0);
    assert.strictEqual(fx.errors.length, 1);
    assert.strictEqual(fx.errors[0].subject, 'USD/CNY');
    assert.strictEqual(fx.errors[0].code, 'invalid_payload');
    assert.strictEqual(R.readFxRates(db).length, 0);
    assertScopeAccounting(fx);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('4D 反例：provider 漏返回目标时生成明确错误，部分成功也不能伪装成整批成功', async () => {
  const db = freshDb();
  try {
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-18',
      scopes: ['fx'],
      pairs: [{ base: 'USD', quote: 'CNY' }, { base: 'HKD', quote: 'CNY' }],
      fxFetch: () => Promise.resolve([Contract.fxResult({
        base: 'USD', quote: 'CNY', rateDecimal: '7.1900', rateDate: '2026-09-18',
        fetchedAt: NOW, provider: 'partial-fixture'
      })])
    });
    const fx = scopeOf(summary, 'fx');
    assert.strictEqual(fx.status, 'partial');
    assert.strictEqual(fx.requested, 2);
    assert.strictEqual(fx.updated, 1);
    assert.strictEqual(fx.errors.length, 1);
    assert.strictEqual(fx.errors[0].subject, 'HKD/CNY');
    assert.match(fx.errors[0].detail, /未返回/);
    assert.strictEqual(R.readFxRates(db).length, 1);
    assertScopeAccounting(fx);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('4D 反例：报价 provider 返回空数组时是 missing error，不是 skipped(no_targets)', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-18',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' }],
      quotesFetch: () => Promise.resolve([])
    });
    const q = scopeOf(summary, 'quotes');
    assert.strictEqual(q.status, 'failed');
    assert.strictEqual(q.reason, null);
    assert.strictEqual(q.errors.length, 1);
    assert.strictEqual(q.errors[0].subject, 'VOO');
    assert.match(q.errors[0].detail, /未返回/);
    assert.strictEqual(R.readQuotes(db).length, 0);
    assertScopeAccounting(q);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('4D 反例：同一请求键的重复结果被拒绝，不能重复写入或把 updated 计成 2', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    const row = Contract.quoteResult({
      symbol: 'VOO', priceMinor: 5000, currency: 'USD', priceDate: '2026-09-18',
      fetchedAt: NOW, provider: 'duplicate-fixture'
    });
    const summary = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-18',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' }],
      quotesFetch: () => Promise.resolve([row, Object.assign({}, row)])
    });
    const q = scopeOf(summary, 'quotes');
    assert.strictEqual(q.status, 'failed');
    assert.strictEqual(q.updated, 0);
    assert.match(q.errors[0].detail, /重复结果/);
    assert.strictEqual(R.readQuotes(db).length, 0);
    assertScopeAccounting(q);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('4D 反例：报价与汇率数据日晚于 asOf 时均拒绝入库', async () => {
  const db = freshDb();
  try {
    addInstrument(db, 'inst-voo', 'VOO', 'NYSE', 'USD');
    const quotes = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-18',
      scopes: ['quotes'],
      autoQuotesEnabled: true,
      quoteTargets: [{ instrumentId: 'inst-voo', symbol: 'VOO', providerSymbol: 'VOO' }],
      quotesFetch: () => Promise.resolve([Contract.quoteResult({
        symbol: 'VOO', priceMinor: 5000, currency: 'USD', priceDate: '2026-09-19',
        fetchedAt: NOW, provider: 'future-fixture'
      })])
    });
    const q = scopeOf(quotes, 'quotes');
    assert.strictEqual(q.status, 'failed');
    assert.match(q.errors[0].detail, /晚于 asOf/);
    assert.strictEqual(R.readQuotes(db).length, 0);
    assertScopeAccounting(q);

    const rates = await MD.refreshMarketData({
      db: db,
      now: NOW,
      asOf: '2026-09-18',
      scopes: ['fx'],
      pairs: [{ base: 'USD', quote: 'CNY' }],
      fxFetch: () => Promise.resolve([Contract.fxResult({
        base: 'USD', quote: 'CNY', rateDecimal: '7.1900', rateDate: '2026-09-19',
        fetchedAt: NOW, provider: 'future-fixture'
      })])
    });
    const fx = scopeOf(rates, 'fx');
    assert.strictEqual(fx.status, 'failed');
    assert.match(fx.errors[0].detail, /晚于 asOf/);
    assert.strictEqual(R.readFxRates(db).length, 0);
    assertScopeAccounting(fx);
  } finally {
    dbm.closeQuietly(db);
  }
});

test('Keychain Key 读取路径：不存在时降级为未配置，密钥内容不外泄', () => {
  // 用注入的 reader/has 覆盖真实 Keychain，测试只验证"路径与降级"，不触碰真实钥匙串。
  const notFound = KeychainKey.providerKeyStatus({
    hasSecret: () => false,
    env: {}
  });
  assert.strictEqual(notFound.configured, false);
  assert.strictEqual(notFound.service, KeychainKey.DEFAULT_SERVICE);
  assert.strictEqual(notFound.error, null);

  const found = KeychainKey.providerKeyStatus({ hasSecret: () => true, env: {} });
  assert.strictEqual(found.configured, true);
  assert.strictEqual(JSON.stringify(found).indexOf('secret-value'), -1);

  // 读取到密钥时只返回给调用方，不在状态对象里出现
  const key = KeychainKey.readProviderKey({ readSecret: () => 'secret-value', env: {} });
  assert.strictEqual(key, 'secret-value');
  // 密钥不存在 → null（不抛错，调用方降级）
  assert.strictEqual(KeychainKey.readProviderKey({ readSecret: () => null, env: {} }), null);
  // 服务名可用环境变量覆盖，且不返回给响应
  assert.strictEqual(
    KeychainKey.serviceName({ [KeychainKey.SERVICE_ENV]: 'custom.service' }),
    'custom.service'
  );
});
