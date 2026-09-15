/* Phase 4A provider 契约与隐私边界测试
 * 对应 ACCEPTANCE.md S4A.1、ROADMAP Phase 4A、ARCHITECTURE §7、NEXT_AGENT Phase 4A 任务 4/5。
 * 全部离线：只依赖固定 fixture 与固定时钟，绝不访问真实行情网络（AGENTS.md 测试门禁）。
 * fixture 中的代码/币对/金额均为虚构。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const Contract = require('../server/providers/contract');
const Clock = require('../server/providers/clock');
const Fixture = require('../server/providers/fixture');

const ASOF = '2026-09-14';          // 请求日（周一，用于节假日回退断言）
const NOW = '2026-09-15T08:00:00Z'; // 固定抓取时间

const CLOCK = Clock.fixedClock(NOW);

/* ------------------------------ 错误分类 ------------------------------ */

test('错误码恰好覆盖 timeout/rate_limit/not_found/invalid_payload/auth 五类', () => {
  const codes = Object.values(Contract.ERRORS).sort();
  assert.deepStrictEqual(codes, ['auth', 'invalid_payload', 'not_found', 'rate_limit', 'timeout']);
  codes.forEach((c) => assert.ok(Contract.isErrorCode(c), c + ' 应为合法错误码'));
  assert.strictEqual(Contract.isErrorCode('network_error'), false);
});

test('可重试性：仅 timeout / rate_limit 可重试，其余不可', () => {
  assert.strictEqual(Contract.isRetryable('timeout'), true);
  assert.strictEqual(Contract.isRetryable('rate_limit'), true);
  assert.strictEqual(Contract.isRetryable('not_found'), false);
  assert.strictEqual(Contract.isRetryable('invalid_payload'), false);
  assert.strictEqual(Contract.isRetryable('auth'), false);
});

/* ------------------------------ 公开代码 / 币对校验 ------------------------------ */

test('isSymbol 只接受公开证券代码形状，拒绝夹带', () => {
  ['VOO', '0700.HK', '510300.SS', 'BRK-B'].forEach((s) => assert.ok(Contract.isSymbol(s), s));
  ['', 'V OO', 'foo;DROP', 'a b', 'x'.repeat(17)].forEach((s) => assert.ok(!Contract.isSymbol(s), JSON.stringify(s)));
});

test('isCurrency / isPair / isDecimalString 边界', () => {
  assert.ok(Contract.isCurrency('CNY'));
  assert.ok(Contract.isCurrency('USD'));
  assert.ok(!Contract.isCurrency('usd'));
  assert.ok(!Contract.isCurrency('US'));
  assert.ok(!Contract.isCurrency('USDT'));

  assert.ok(Contract.isPair({ base: 'USD', quote: 'CNY' }));
  assert.ok(!Contract.isPair({ base: 'USD' }));
  assert.ok(!Contract.isPair({ base: 'usd', quote: 'CNY' }));
  assert.ok(!Contract.isPair(null));

  assert.ok(Contract.isDecimalString('7.2000'));
  assert.ok(Contract.isDecimalString('7'));
  assert.ok(!Contract.isDecimalString('-7'));
  assert.ok(!Contract.isDecimalString('7.2.0'));
  assert.ok(!Contract.isDecimalString('1e3'));
});

/* ------------------------------ 结果形状 ------------------------------ */

test('quoteResult / fxResult / errorResult 形状逐键一致且通过校验', () => {
  const q = Contract.quoteResult({
    symbol: 'VOO', priceMinor: 5000, currency: 'USD',
    priceDate: '2026-09-11', fetchedAt: NOW, provider: 'stooq'
  });
  assert.deepStrictEqual(q, {
    kind: 'quote', symbol: 'VOO', priceMinor: 5000, currency: 'USD',
    priceDate: '2026-09-11', fetchedAt: NOW, provider: 'stooq', status: 'ok'
  });
  assert.ok(Contract.isValidResult(q));

  const f = Contract.fxResult({
    base: 'USD', quote: 'CNY', rateDecimal: '7.2000',
    rateDate: '2026-09-11', fetchedAt: NOW, provider: 'frankfurter'
  });
  assert.deepStrictEqual(f, {
    kind: 'fx', base: 'USD', quote: 'CNY', rateDecimal: '7.2000',
    rateDate: '2026-09-11', fetchedAt: NOW, provider: 'frankfurter', status: 'ok'
  });
  assert.ok(Contract.isValidResult(f));

  const e = Contract.errorResult({ subject: 'VOO', code: 'not_found' });
  assert.deepStrictEqual(e, {
    kind: 'error', subject: 'VOO', code: 'not_found', detail: '', retryable: false
  });
  assert.ok(Contract.isValidResult(e));
});

test('isValidResult 拒绝未知 kind 与未知错误码', () => {
  assert.ok(!Contract.isValidResult({ kind: 'unknown' }));
  assert.ok(!Contract.isValidResult({ kind: 'error', code: 'boom', retryable: false }));
  assert.ok(!Contract.isValidResult(null));
});

/* ------------------------------ 请求序列化与隐私边界 ------------------------------ */

test('serializeQuotesRequest 产物只含公开代码数组，结构上无法携带私有字段', () => {
  const req = Contract.serializeQuotesRequest(['VOO', '0700.HK']);
  assert.deepStrictEqual(req, { symbols: ['VOO', '0700.HK'] });
  assert.deepStrictEqual(Object.keys(req), ['symbols']);
});

test('serializeFxRequest 每个币对只保留 base/quote，剥离金额与账户字段', () => {
  const req = Contract.serializeFxRequest([
    { base: 'USD', quote: 'CNY', amount: '100000', accountName: '汇丰 USD 子账户', balanceMinor: 100000 }
  ]);
  assert.deepStrictEqual(req, { pairs: [{ base: 'USD', quote: 'CNY' }] });
});

test('adapter 结果对象只含契约白名单键，绝不混入 ctx 中的私有财务事实', async () => {
  // 模拟一个被"污染"的 ctx：塞满账户名、数量、成本、余额、完整持仓等私人字段。
  const taintedCtx = {
    now: NOW,
    accountName: '汇丰 USD 子账户',
    quantity: '10',
    costMinor: 45000,
    balanceMinor: 100000,
    holdings: [{ symbol: 'VOO', quantity: '10', costMinor: 45000 }],
    userName: '镜雪'
  };
  const results = await Fixture.getEndOfDayQuotes(['VOO'], ASOF, taintedCtx);
  const q = results[0];
  assert.strictEqual(q.kind, 'quote');
  assert.deepStrictEqual(
    Object.keys(q).sort(),
    ['currency', 'fetchedAt', 'kind', 'priceDate', 'priceMinor', 'provider', 'status', 'symbol'].sort()
  );
  // 明确的私有字段名一个都不许出现。
  ['accountName', 'quantity', 'costMinor', 'balanceMinor', 'holdings', 'userName', 'cost', 'balance'].forEach((k) => {
    assert.ok(!(k in q), 'quote 结果不应含私有字段 ' + k);
  });
});

/* ------------------------------ fixture adapter：成功 / 各错误场景 ------------------------------ */

test('getEndOfDayQuotes 成功场景返回三只标的的正确行情', async () => {
  const results = await Fixture.getEndOfDayQuotes(['VOO', '0700.HK', '510300.SS'], ASOF, CLOCK);
  assert.strictEqual(results.length, 3);
  results.forEach((r) => {
    assert.strictEqual(r.kind, 'quote');
    assert.strictEqual(r.fetchedAt, NOW);
    assert.strictEqual(r.provider, 'stooq');
    assert.strictEqual(r.priceDate, '2026-09-11');
    assert.ok(Contract.isValidResult(r));
  });
  assert.strictEqual(results[0].symbol, 'VOO');
  assert.strictEqual(results[0].priceMinor, 5000);
  assert.strictEqual(results[0].currency, 'USD');
  assert.strictEqual(results[1].currency, 'HKD');
  assert.strictEqual(results[2].currency, 'CNY');
});

test('getEndOfDayQuotes 未命中标的返回 not_found 且不可重试', async () => {
  const results = await Fixture.getEndOfDayQuotes(['NOPE.ETF'], ASOF, CLOCK);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'error');
  assert.strictEqual(results[0].code, 'not_found');
  assert.strictEqual(results[0].subject, 'NOPE.ETF');
  assert.strictEqual(results[0].retryable, false);
});

test('getEndOfDayQuotes 错误场景分别命中 timeout/rate_limit/invalid_payload/auth', async () => {
  const results = await Fixture.getEndOfDayQuotes(['SLOW.ETF', 'LIMITED.ETF', 'BROKEN.ETF', 'AUTH.ETF'], ASOF, CLOCK);
  const codes = results.map((r) => r.code);
  assert.deepStrictEqual(codes, ['timeout', 'rate_limit', 'invalid_payload', 'auth']);
  assert.strictEqual(results[0].retryable, true);  // timeout
  assert.strictEqual(results[1].retryable, true);  // rate_limit
  assert.strictEqual(results[2].retryable, false); // invalid_payload
  assert.strictEqual(results[3].retryable, false); // auth
  results.forEach((r) => assert.ok(Contract.isValidResult(r)));
});

test('节假日：asOf 当天休市时返回最近有效交易日且不报错', async () => {
  const results = await Fixture.getEndOfDayQuotes(['HOLIDAY.US'], ASOF, CLOCK);
  assert.strictEqual(results[0].kind, 'quote');
  assert.strictEqual(results[0].priceDate, '2026-09-11');
  assert.ok(results[0].priceDate < ASOF, '数据日应早于请求日（回退最近有效交易日）');
});

test('getFxRates 成功与错误场景（含缺币对）', async () => {
  const ok = await Fixture.getFxRates([{ base: 'USD', quote: 'CNY' }, { base: 'HKD', quote: 'CNY' }], ASOF, CLOCK);
  assert.strictEqual(ok.length, 2);
  assert.strictEqual(ok[0].kind, 'fx');
  assert.strictEqual(ok[0].rateDecimal, '7.2000');
  assert.strictEqual(ok[0].provider, 'frankfurter');
  assert.strictEqual(ok[0].fetchedAt, NOW);
  assert.strictEqual(ok[1].rateDecimal, '0.9200');

  const err = await Fixture.getFxRates([{ base: 'AAA', quote: 'BBB' }], ASOF, CLOCK);
  assert.strictEqual(err[0].code, 'timeout');

  const miss = await Fixture.getFxRates([{ base: 'USD', quote: 'EUR' }], ASOF, CLOCK);
  assert.strictEqual(miss[0].code, 'not_found');
  assert.strictEqual(miss[0].subject, 'USD/EUR');
});

/* ------------------------------ 固定时钟 ------------------------------ */

test('固定时钟确定性：fetchedAt 恒等于注入时间，不读真实时钟', async () => {
  const a = await Fixture.getEndOfDayQuotes(['VOO'], ASOF, CLOCK);
  const b = await Fixture.getEndOfDayQuotes(['VOO'], ASOF, CLOCK);
  assert.strictEqual(a[0].fetchedAt, NOW);
  assert.strictEqual(b[0].fetchedAt, NOW);
  // fixedClock 两次读 now 均恒定。
  const c1 = Clock.fixedClock('2026-01-01T00:00:00Z');
  assert.strictEqual(Clock.nowOf(c1), '2026-01-01T00:00:00Z');
  assert.strictEqual(Clock.nowOf(c1), '2026-01-01T00:00:00Z');
});
