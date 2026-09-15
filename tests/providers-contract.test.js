/* Phase 4A provider 契约与隐私边界测试
 * 对应 ACCEPTANCE.md S4A.1、ROADMAP Phase 4A、ARCHITECTURE §7、NEXT_AGENT Phase 4A 任务 4/5，
 * 以及 PHASE4A_ACCEPTANCE_GAPS.md 记录的 P0/P1 补口（输入校验、结果校验、asOf 取数、错误一致性）。
 * 全部离线：只依赖固定 fixture 与固定时钟，绝不访问真实行情网络（AGENTS.md 测试门禁）。
 * fixture 中的代码/币对/金额/汇率均为虚构。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const Contract = require('../server/providers/contract');
const Clock = require('../server/providers/clock');
const Fixture = require('../server/providers/fixture');

const NOW = '2026-09-15T08:00:00Z'; // 固定抓取时间
const CLOCK = Clock.fixedClock(NOW);

// 通过/不通过结果校验的基准对象
const VALID_QUOTE = {
  kind: 'quote', symbol: 'VOO', priceMinor: 5000, currency: 'USD',
  priceDate: '2026-09-11', fetchedAt: NOW, provider: 'fixture', status: 'ok'
};
const VALID_FX = {
  kind: 'fx', base: 'USD', quote: 'CNY', rateDecimal: '7.2000',
  rateDate: '2026-09-11', fetchedAt: NOW, provider: 'fixture', status: 'ok'
};

function throwsContract(fn, msg) {
  assert.throws(fn, (e) => e && e.name === 'ContractError' && e.code === 'invalid_payload', msg);
}

/* ------------------------------ 错误分类 ------------------------------ */

test('错误码恰好覆盖 timeout/rate_limit/not_found/invalid_payload/auth 五类', () => {
  const codes = Object.values(Contract.ERRORS).sort();
  assert.deepStrictEqual(codes, ['auth', 'invalid_payload', 'not_found', 'rate_limit', 'timeout']);
  codes.forEach((c) => assert.ok(Contract.isErrorCode(c), c + ' 应为合法错误码'));
  assert.strictEqual(Contract.isErrorCode('network_error'), false);
  assert.strictEqual(Contract.isErrorCode(null), false);
});

test('可重试性：仅 timeout / rate_limit 可重试，其余不可', () => {
  assert.strictEqual(Contract.isRetryable('timeout'), true);
  assert.strictEqual(Contract.isRetryable('rate_limit'), true);
  assert.strictEqual(Contract.isRetryable('not_found'), false);
  assert.strictEqual(Contract.isRetryable('invalid_payload'), false);
  assert.strictEqual(Contract.isRetryable('auth'), false);
});

/* ------------------------------ 形状校验：代码 / 币种 / 币对 / 十进制 ------------------------------ */

test('isSymbol 只接受公开证券代码形状，拒绝夹带', () => {
  ['VOO', '0700.HK', '510300.SS', 'BRK-B'].forEach((s) => assert.ok(Contract.isSymbol(s), s));
  ['', 'V OO', 'foo;DROP', 'a b', 'x'.repeat(17), null, 123, {}].forEach((s) => {
    assert.ok(!Contract.isSymbol(s), JSON.stringify(s));
  });
});

test('isCurrency 只接受 3 位大写币种（小写币种必须被拒绝）', () => {
  ['CNY', 'USD', 'HKD'].forEach((c) => assert.ok(Contract.isCurrency(c), c));
  ['usd', 'cny', 'US', 'USDT', '', null, 123].forEach((c) => {
    assert.ok(!Contract.isCurrency(c), JSON.stringify(c));
  });
});

test('isPair / isPairKey 边界', () => {
  assert.ok(Contract.isPair({ base: 'USD', quote: 'CNY' }));
  assert.ok(!Contract.isPair({ base: 'USD' }));
  assert.ok(!Contract.isPair({ base: 'usd', quote: 'CNY' }));
  assert.ok(!Contract.isPair({ base: 'USD', quote: 'usd' }));
  assert.ok(!Contract.isPair(null));

  assert.ok(Contract.isPairKey('USD/CNY'));
  assert.ok(!Contract.isPairKey('usd/cny'));
  assert.ok(!Contract.isPairKey('USDCNY'));
});

test('isDecimalString 与 isPositiveDecimalString 的差别就在"大于零"', () => {
  assert.ok(Contract.isDecimalString('7.2000'));
  assert.ok(Contract.isDecimalString('7'));
  assert.ok(!Contract.isDecimalString('-7'));
  assert.ok(!Contract.isDecimalString('7.2.0'));
  assert.ok(!Contract.isDecimalString('1e3'));

  assert.ok(Contract.isPositiveDecimalString('7.2000'));
  assert.ok(!Contract.isPositiveDecimalString('0'));
  assert.ok(!Contract.isPositiveDecimalString('0.0000'));
  assert.ok(!Contract.isPositiveDecimalString('0.00'));
  assert.ok(!Contract.isPositiveDecimalString('-7'));
});

test('isDateString 只接受真实存在的 YYYY-MM-DD', () => {
  ['2026-09-11', '2024-02-29'].forEach((d) => assert.ok(Contract.isDateString(d), d));
  ['2026-02-30', '2026-13-01', '2026-00-10', '2026-09-31', '2026-9-1', '2026/09/11', 'bad', '', null, 20260911].forEach((d) => {
    assert.ok(!Contract.isDateString(d), JSON.stringify(d));
  });
});

test('isTimestamp 要求带时区的 ISO 时间，拒绝仅日期与无时区写法', () => {
  ['2026-09-15T08:00:00Z', '2026-09-15T08:00:00.123Z', '2026-09-15T08:00:00+08:00'].forEach((t) => {
    assert.ok(Contract.isTimestamp(t), t);
  });
  ['2026-09-15', '2026-09-15T08:00:00', '2026-09-15T08:00Z', 'bad', '', null].forEach((t) => {
    assert.ok(!Contract.isTimestamp(t), JSON.stringify(t));
  });
});

test('isPositiveSafeInteger 拒绝 0 / 负数 / 小数 / 非整数 / 超安全范围', () => {
  assert.ok(Contract.isPositiveSafeInteger(1));
  assert.ok(Contract.isPositiveSafeInteger(5000));
  [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, '5000', null, undefined].forEach((v) => {
    assert.ok(!Contract.isPositiveSafeInteger(v), String(v));
  });
});

/* ------------------------------ 请求校验 + 序列化（隐私边界核心） ------------------------------ */

test('serializeQuotesRequest 合法输入返回白名单请求', () => {
  const req = Contract.serializeQuotesRequest(['VOO', '0700.HK']);
  assert.deepStrictEqual(req, { ok: true, symbols: ['VOO', '0700.HK'] });
  assert.deepStrictEqual(Object.keys(req), ['ok', 'symbols']);
});

test('serializeQuotesRequest 反例：非数组 / 空数组 / 超限 / 非法项一律整体拒绝', () => {
  const bads = [
    null, undefined, 'VOO', 123, {}, [],
    ['V OO'], ['VOO', null], ['VOO', 123], ['VOO', ''],
    new Array(Contract.MAX_BATCH_SIZE + 1).fill('VOO')
  ];
  bads.forEach((bad) => {
    const req = Contract.serializeQuotesRequest(bad);
    assert.strictEqual(req.ok, false, JSON.stringify(bad));
    assert.strictEqual(req.error.code, 'invalid_payload');
    assert.strictEqual(typeof req.error.detail, 'string');
  });
});

test('serializeQuotesRequest 不回显潜在私有文本（只报第几项不合格）', () => {
  const secret = '汇丰 USD 子账户 VOO 持仓 10 股 成本 450';
  const req = Contract.serializeQuotesRequest([secret]);
  assert.strictEqual(req.ok, false);
  const dump = JSON.stringify(req);
  ['汇丰', '持仓', '成本', '450', '账户'].forEach((k) => {
    assert.ok(!dump.includes(k), '错误产物不得包含私有文本：' + k);
  });
});

test('serializeFxRequest 每个币对只保留 base/quote，剥离金额与账户字段', () => {
  const req = Contract.serializeFxRequest([
    { base: 'USD', quote: 'CNY', amount: '100000', accountName: '汇丰 USD 子账户', balanceMinor: 100000 }
  ]);
  assert.deepStrictEqual(req, { ok: true, pairs: [{ base: 'USD', quote: 'CNY' }] });
  const dump = JSON.stringify(req);
  ['汇丰', '100000', 'accountName', 'balanceMinor', 'amount'].forEach((k) => {
    assert.ok(!dump.includes(k), '序列化产物不得包含：' + k);
  });
});

test('serializeFxRequest 反例：非数组 / 空数组 / 缺字段 / 小写币种一律整体拒绝且不回显', () => {
  const bads = [null, 'USD/CNY', {}, [], [null], [{ base: 'USD' }], [{ base: 'usd', quote: 'CNY' }], [{ base: 'USD', quote: 'cny' }]];
  bads.forEach((bad) => {
    const req = Contract.serializeFxRequest(bad);
    assert.strictEqual(req.ok, false, JSON.stringify(bad));
    assert.strictEqual(req.error.code, 'invalid_payload');
  });

  const req = Contract.serializeFxRequest([{ base: 'USD', quote: 'CNY', note: '汇丰 USD 子账户' }, { base: 'USD' }]);
  assert.strictEqual(req.ok, false);
  assert.ok(!JSON.stringify(req).includes('汇丰'));
});

/* ------------------------------ 结果构造：严格校验 ------------------------------ */

test('quoteResult / fxResult / errorResult 成功形状逐键一致且通过校验', () => {
  const q = Contract.quoteResult({
    symbol: 'VOO', priceMinor: 5000, currency: 'USD',
    priceDate: '2026-09-11', fetchedAt: NOW, provider: 'fixture'
  });
  assert.deepStrictEqual(q, VALID_QUOTE);
  assert.ok(Contract.isValidResult(q));

  const f = Contract.fxResult({
    base: 'USD', quote: 'CNY', rateDecimal: '7.2000',
    rateDate: '2026-09-11', fetchedAt: NOW, provider: 'fixture'
  });
  assert.deepStrictEqual(f, VALID_FX);
  assert.ok(Contract.isValidResult(f));

  const e = Contract.errorResult({ subject: 'VOO', code: 'not_found' });
  assert.deepStrictEqual(e, {
    kind: 'error', subject: 'VOO', code: 'not_found', detail: '', retryable: false
  });
  assert.ok(Contract.isValidResult(e));
});

test('quoteResult 拒绝不可入账的行情（负/零/小数价格、假日期、坏时间、小写币种）', () => {
  const good = { symbol: 'VOO', priceMinor: 5000, currency: 'USD', priceDate: '2026-09-11', fetchedAt: NOW, provider: 'fixture' };
  [
    { ...good, priceMinor: -1 },
    { ...good, priceMinor: 0 },
    { ...good, priceMinor: 1.5 },
    { ...good, priceMinor: '5000' },
    { ...good, priceMinor: NaN },
    { ...good, currency: 'usd' },
    { ...good, symbol: 'V OO' },
    { ...good, priceDate: 'bad' },
    { ...good, priceDate: '2026-02-30' },
    { ...good, fetchedAt: 'bad' },
    { ...good, fetchedAt: '2026-09-15' },
    { ...good, provider: '' },
    null
  ].forEach((bad) => throwsContract(() => Contract.quoteResult(bad), JSON.stringify(bad)));
});

test('fxResult 拒绝不可入账的汇率（0 / 负 / 假日期 / 坏时间）', () => {
  const good = { base: 'USD', quote: 'CNY', rateDecimal: '7.2000', rateDate: '2026-09-11', fetchedAt: NOW, provider: 'fixture' };
  [
    { ...good, rateDecimal: '0' },
    { ...good, rateDecimal: '0.0000' },
    { ...good, rateDecimal: '-7' },
    { ...good, rateDecimal: 7.2 },
    { ...good, rateDate: 'bad' },
    { ...good, rateDate: '2026-02-30' },
    { ...good, fetchedAt: 'bad' },
    { ...good, base: 'usd' },
    { ...good, provider: '' },
    null
  ].forEach((bad) => throwsContract(() => Contract.fxResult(bad), JSON.stringify(bad)));
});

test('errorResult 拒绝未知错误码（无法伪造新的失败语义）', () => {
  throwsContract(() => Contract.errorResult({ code: 'boom' }));
  throwsContract(() => Contract.errorResult({}));
  throwsContract(() => Contract.errorResult({ code: 'network_error' }));
});

test('errorResult 的 retryable 由错误码推导，调用方无法传入不一致的值', () => {
  assert.strictEqual(Contract.errorResult({ code: 'timeout', retryable: false }).retryable, true);
  assert.strictEqual(Contract.errorResult({ code: 'auth', retryable: true }).retryable, false);
});

test('errorResult 的 subject 只保留公开代码 / 币对，私有文本一律置空', () => {
  assert.strictEqual(Contract.errorResult({ subject: '汇丰 USD 子账户', code: 'not_found' }).subject, null);
  assert.strictEqual(Contract.errorResult({ subject: '账户余额 100000', code: 'not_found' }).subject, null);
  assert.strictEqual(Contract.errorResult({ subject: 'VOO', code: 'not_found' }).subject, 'VOO');
  assert.strictEqual(Contract.errorResult({ subject: 'USD/CNY', code: 'timeout' }).subject, 'USD/CNY');
  assert.strictEqual(Contract.errorResult({ code: 'timeout' }).subject, null);
});

test('errorResult 的 detail 强制单行并截断到上限', () => {
  assert.strictEqual(Contract.errorResult({ code: 'timeout', detail: 'a\nb\tc' }).detail, 'a b c');
  assert.strictEqual(Contract.errorResult({ code: 'timeout', detail: '  x  ' }).detail, 'x');
  const long = Contract.errorResult({ code: 'timeout', detail: 'x'.repeat(500) });
  assert.strictEqual(long.detail.length, Contract.MAX_DETAIL_LENGTH);
});

/* ------------------------------ 结果校验 ------------------------------ */

test('isValidResult 拒绝验收指出的全部不可入账形状', () => {
  assert.ok(Contract.isValidResult(VALID_QUOTE));
  assert.ok(Contract.isValidResult(VALID_FX));

  assert.ok(!Contract.isValidResult({ ...VALID_QUOTE, priceMinor: -1 }));
  assert.ok(!Contract.isValidResult({ ...VALID_QUOTE, priceMinor: 1.5 }));
  assert.ok(!Contract.isValidResult({ ...VALID_QUOTE, priceMinor: 0 }));
  assert.ok(!Contract.isValidResult({ ...VALID_QUOTE, priceDate: 'bad' }));
  assert.ok(!Contract.isValidResult({ ...VALID_QUOTE, priceDate: '2026-02-30' }));
  assert.ok(!Contract.isValidResult({ ...VALID_QUOTE, fetchedAt: 'bad' }));
  assert.ok(!Contract.isValidResult({ ...VALID_QUOTE, fetchedAt: '2026-09-15' }));

  assert.ok(!Contract.isValidResult({ ...VALID_FX, rateDecimal: '0' }));
  assert.ok(!Contract.isValidResult({ ...VALID_FX, rateDecimal: '0.0000' }));
  assert.ok(!Contract.isValidResult({ ...VALID_FX, rateDate: 'bad' }));
  assert.ok(!Contract.isValidResult({ ...VALID_FX, fetchedAt: 'bad' }));
});

test('isValidResult 对错误结果要求 retryable 严格等于映射', () => {
  assert.ok(Contract.isValidResult({ kind: 'error', subject: 'VOO', code: 'timeout', detail: '', retryable: true }));
  assert.ok(!Contract.isValidResult({ kind: 'error', subject: 'VOO', code: 'timeout', detail: '', retryable: false }));
  assert.ok(!Contract.isValidResult({ kind: 'error', subject: 'VOO', code: 'auth', detail: '', retryable: true }));
  assert.ok(!Contract.isValidResult({ kind: 'error', subject: '汇丰 USD 子账户', code: 'auth', detail: '', retryable: false }));
  assert.ok(!Contract.isValidResult({ kind: 'error', code: 'boom', retryable: false }));
});

test('isValidResult 拒绝未知 kind、非对象与缺失字段', () => {
  assert.ok(!Contract.isValidResult({ kind: 'unknown' }));
  assert.ok(!Contract.isValidResult(null));
  assert.ok(!Contract.isValidResult(undefined));
  assert.ok(!Contract.isValidResult({ kind: 'quote', symbol: 'VOO' }));
});

test('assertValidResult 对不合格结果抛 ContractError，对合格结果原样返回', () => {
  assert.strictEqual(Contract.assertValidResult(VALID_QUOTE), VALID_QUOTE);
  throwsContract(() => Contract.assertValidResult({ ...VALID_QUOTE, priceMinor: -1 }));
  throwsContract(() => Contract.assertValidResult({ kind: 'unknown' }));
});

/* ------------------------------ fixture adapter：成功 / 各错误场景 ------------------------------ */

test('getEndOfDayQuotes 成功场景返回标的的正确行情，且 provider 不冒充真实数据源', async () => {
  const results = await Fixture.getEndOfDayQuotes(['VOO', '0700.HK', '510300.SS'], '2026-09-15', CLOCK);
  assert.strictEqual(results.length, 3);
  results.forEach((r) => {
    assert.strictEqual(r.kind, 'quote');
    assert.strictEqual(r.fetchedAt, NOW);
    assert.strictEqual(r.provider, Fixture.PROVIDER_ID);
    assert.ok(Contract.isValidResult(r));
  });
  assert.deepStrictEqual(results[0], {
    kind: 'quote', symbol: 'VOO', priceMinor: 4992, currency: 'USD',
    priceDate: '2026-09-14', fetchedAt: NOW, provider: 'fixture', status: 'ok'
  });
  assert.strictEqual(results[1].currency, 'HKD');
  assert.strictEqual(results[2].currency, 'CNY');
});

test('asOf 决定数据日：只取 priceDate <= asOf 的最近有效日', async () => {
  const [today] = await Fixture.getEndOfDayQuotes(['510300.SS'], '2026-09-15', CLOCK);
  assert.strictEqual(today.priceDate, '2026-09-15');
  assert.strictEqual(today.priceMinor, 418);

  const [mon] = await Fixture.getEndOfDayQuotes(['510300.SS'], '2026-09-14', CLOCK);
  assert.strictEqual(mon.priceDate, '2026-09-14');
  assert.strictEqual(mon.priceMinor, 415);

  // 周六：当日无数据，回退到周五
  const [sat] = await Fixture.getEndOfDayQuotes(['510300.SS'], '2026-09-12', CLOCK);
  assert.strictEqual(sat.priceDate, '2026-09-11');
  assert.strictEqual(sat.priceMinor, 412);
});

test('节假日：asOf 命中休市日时回退最近有效交易日且不报错', async () => {
  const [r] = await Fixture.getEndOfDayQuotes(['HOLIDAY.MK'], '2026-09-15', CLOCK);
  assert.strictEqual(r.kind, 'quote');
  assert.strictEqual(r.priceDate, '2026-09-11');
  assert.ok(r.priceDate <= '2026-09-15', '数据日不得晚于请求日');
});

test('反例：asOf 早于数据起始日时返回 not_found，绝不返回未来行情', async () => {
  const results = await Fixture.getEndOfDayQuotes(['510300.SS'], '2026-09-01', CLOCK);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'error');
  assert.strictEqual(results[0].code, 'not_found');
  assert.strictEqual(results[0].subject, '510300.SS');
  assert.strictEqual(results[0].retryable, false);
  assert.ok(!('priceDate' in results[0]), '错误结果不得携带任何行情数据日');

  // 节假日标的同理：数据日 2026-09-11 晚于 asOf 时必须报 not_found，而不是回吐 09-11
  const [holiday] = await Fixture.getEndOfDayQuotes(['HOLIDAY.MK'], '2026-09-01', CLOCK);
  assert.strictEqual(holiday.kind, 'error');
  assert.strictEqual(holiday.code, 'not_found');
});

test('不变量：任何 asOf 下返回的行情数据日都不晚于 asOf', async () => {
  const asOfs = ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-20'];
  for (const asOf of asOfs) {
    const results = await Fixture.getEndOfDayQuotes(['VOO', '0700.HK', '510300.SS', 'HOLIDAY.MK'], asOf, CLOCK);
    assert.strictEqual(results.length, 4);
    results.forEach((r) => {
      if (r.kind === 'quote') {
        assert.ok(r.priceDate <= asOf, `${r.symbol} @${asOf} 返回了未来数据 ${r.priceDate}`);
      }
    });
  }
});

test('getEndOfDayQuotes 未命中标的返回 not_found 且不可重试', async () => {
  const results = await Fixture.getEndOfDayQuotes(['NOPE.ETF'], '2026-09-15', CLOCK);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].kind, 'error');
  assert.strictEqual(results[0].code, 'not_found');
  assert.strictEqual(results[0].subject, 'NOPE.ETF');
  assert.strictEqual(results[0].retryable, false);
});

test('getEndOfDayQuotes 错误场景分别命中 timeout/rate_limit/invalid_payload/auth', async () => {
  const results = await Fixture.getEndOfDayQuotes(['SLOW.ETF', 'LIMITED.ETF', 'BROKEN.ETF', 'AUTH.ETF'], '2026-09-15', CLOCK);
  assert.deepStrictEqual(results.map((r) => r.code), ['timeout', 'rate_limit', 'invalid_payload', 'auth']);
  assert.strictEqual(results[0].retryable, true);  // timeout
  assert.strictEqual(results[1].retryable, true);  // rate_limit
  assert.strictEqual(results[2].retryable, false); // invalid_payload
  assert.strictEqual(results[3].retryable, false); // auth
  results.forEach((r) => assert.ok(Contract.isValidResult(r)));
});

test('非法标的输入返回单个 invalid_payload，不再被当成 not_found', async () => {
  const secret = '汇丰 USD 子账户 VOO 持仓 10 股 成本 450';
  const bads = [null, undefined, 'VOO', 123, {}, [], ['V OO'], ['VOO', null], ['VOO', 123], [secret]];
  for (const bad of bads) {
    const results = await Fixture.getEndOfDayQuotes(bad, '2026-09-15', CLOCK);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].kind, 'error');
    assert.strictEqual(results[0].code, 'invalid_payload');
    assert.strictEqual(results[0].subject, null);
    assert.strictEqual(results[0].retryable, false);
    const dump = JSON.stringify(results[0]);
    ['汇丰', '持仓', '成本', '450', '账户'].forEach((k) => {
      assert.ok(!dump.includes(k), '错误结果不得回显私有文本：' + k);
    });
  }
});

test('不可入账数据（负价格 / 零汇率）被结果校验拦成 invalid_payload', async () => {
  const [q] = await Fixture.getEndOfDayQuotes(['GARBAGE.ETF'], '2026-09-15', CLOCK);
  assert.strictEqual(q.kind, 'error');
  assert.strictEqual(q.code, 'invalid_payload');
  assert.strictEqual(q.retryable, false);
  assert.strictEqual(q.subject, 'GARBAGE.ETF');
  assert.ok(!('priceMinor' in q), '不可入账的价格不得出现在结果里');

  const [f] = await Fixture.getFxRates([{ base: 'III', quote: 'JJJ' }], '2026-09-15', CLOCK);
  assert.strictEqual(f.kind, 'error');
  assert.strictEqual(f.code, 'invalid_payload');
  assert.ok(!('rateDecimal' in f), '不可入账的汇率不得出现在结果里');
});

test('getFxRates 成功、错误与缺币对场景', async () => {
  const ok = await Fixture.getFxRates([{ base: 'USD', quote: 'CNY' }, { base: 'HKD', quote: 'CNY' }], '2026-09-11', CLOCK);
  assert.strictEqual(ok.length, 2);
  assert.strictEqual(ok[0].kind, 'fx');
  assert.strictEqual(ok[0].rateDecimal, '7.2000');
  assert.strictEqual(ok[0].provider, Fixture.PROVIDER_ID);
  assert.strictEqual(ok[0].fetchedAt, NOW);
  assert.strictEqual(ok[1].rateDecimal, '0.9200');

  // asOf 选择最近有效日：09-14 命中第二条
  const [later] = await Fixture.getFxRates([{ base: 'USD', quote: 'CNY' }], '2026-09-14', CLOCK);
  assert.strictEqual(later.rateDate, '2026-09-14');
  assert.strictEqual(later.rateDecimal, '7.1900');

  assert.strictEqual((await Fixture.getFxRates([{ base: 'AAA', quote: 'BBB' }], '2026-09-15', CLOCK))[0].code, 'timeout');

  const miss = await Fixture.getFxRates([{ base: 'USD', quote: 'EUR' }], '2026-09-15', CLOCK);
  assert.strictEqual(miss[0].code, 'not_found');
  assert.strictEqual(miss[0].subject, 'USD/EUR');

  // asOf 早于汇率数据起始日
  const early = await Fixture.getFxRates([{ base: 'USD', quote: 'CNY' }], '2026-09-01', CLOCK);
  assert.strictEqual(early[0].kind, 'error');
  assert.strictEqual(early[0].code, 'not_found');
});

test('非法币对输入返回单个 invalid_payload 且不回显私有文本', async () => {
  const bads = [null, 'USD/CNY', {}, [], [null], [{ base: 'USD' }], [{ base: 'usd', quote: 'CNY' }], [{ base: 'USD', quote: 'CNY', note: '汇丰 USD 子账户' }, { base: 'USD' }]];
  for (const bad of bads) {
    const results = await Fixture.getFxRates(bad, '2026-09-15', CLOCK);
    assert.strictEqual(results.length, 1, JSON.stringify(bad));
    assert.strictEqual(results[0].code, 'invalid_payload');
    assert.strictEqual(results[0].subject, null);
    assert.ok(!JSON.stringify(results[0]).includes('汇丰'));
  }
});

test('非法 asOf 一律 invalid_payload，不用"今天"兜底', async () => {
  const bads = [null, undefined, '2026-9-15', '2026-13-01', '2026-02-30', 'today', 20260915];
  for (const bad of bads) {
    const q = await Fixture.getEndOfDayQuotes(['VOO'], bad, CLOCK);
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].code, 'invalid_payload', String(bad));
    const f = await Fixture.getFxRates([{ base: 'USD', quote: 'CNY' }], bad, CLOCK);
    assert.strictEqual(f[0].code, 'invalid_payload', String(bad));
  }
});

test('缺少有效 ctx.now 返回 invalid_payload，不读真实时钟', async () => {
  for (const ctx of [undefined, null, {}, { now: 'bad' }, { now: '2026-09-15' }, { now: 123 }]) {
    const q = await Fixture.getEndOfDayQuotes(['VOO'], '2026-09-15', ctx);
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].code, 'invalid_payload');
    const f = await Fixture.getFxRates([{ base: 'USD', quote: 'CNY' }], '2026-09-15', ctx);
    assert.strictEqual(f[0].code, 'invalid_payload');
  }
  const lazy = { now: () => NOW };
  const ok = await Fixture.getEndOfDayQuotes(['VOO'], '2026-09-15', lazy);
  assert.strictEqual(ok[0].fetchedAt, NOW);
});

/* ------------------------------ 隐私边界与不变量 ------------------------------ */

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
  const results = await Fixture.getEndOfDayQuotes(['VOO'], '2026-09-15', taintedCtx);
  const q = results[0];
  assert.strictEqual(q.kind, 'quote');
  assert.deepStrictEqual(
    Object.keys(q).sort(),
    ['currency', 'fetchedAt', 'kind', 'priceDate', 'priceMinor', 'provider', 'status', 'symbol'].sort()
  );
  ['accountName', 'quantity', 'costMinor', 'balanceMinor', 'holdings', 'userName', 'cost', 'balance'].forEach((k) => {
    assert.ok(!(k in q), 'quote 结果不应含私有字段 ' + k);
  });
});

test('不变量：所有 asOf 下 fixture 返回的每个结果都通过契约校验', async () => {
  const asOfs = ['2026-09-01', '2026-09-07', '2026-09-11', '2026-09-12', '2026-09-14', '2026-09-15', '2026-12-31'];
  const symbols = Object.keys(Fixture.QUOTES);
  const pairs = Object.keys(Fixture.FX).map((k) => ({ base: k.slice(0, 3), quote: k.slice(4) }));

  for (const asOf of asOfs) {
    const quotes = await Fixture.getEndOfDayQuotes(symbols, asOf, CLOCK);
    assert.strictEqual(quotes.length, symbols.length);
    quotes.forEach((r) => assert.ok(Contract.isValidResult(r), JSON.stringify(r)));

    const fx = await Fixture.getFxRates(pairs, asOf, CLOCK);
    assert.strictEqual(fx.length, pairs.length);
    fx.forEach((r) => assert.ok(Contract.isValidResult(r), JSON.stringify(r)));
  }
});

/* ------------------------------ 固定时钟 ------------------------------ */

test('固定时钟确定性：fetchedAt 恒等于注入时间，不读真实时钟', async () => {
  const a = await Fixture.getEndOfDayQuotes(['VOO'], '2026-09-15', CLOCK);
  const b = await Fixture.getEndOfDayQuotes(['VOO'], '2026-09-15', CLOCK);
  assert.strictEqual(a[0].fetchedAt, NOW);
  assert.strictEqual(b[0].fetchedAt, NOW);

  const c1 = Clock.fixedClock('2026-01-01T00:00:00Z');
  assert.strictEqual(Clock.nowOf(c1), '2026-01-01T00:00:00Z');
  assert.strictEqual(Clock.nowOf(c1), '2026-01-01T00:00:00Z');
});

test('fixedClock 拒绝非法时间戳，避免把无效抓取时间写进行情', () => {
  assert.throws(() => Clock.fixedClock('bad'));
  assert.throws(() => Clock.fixedClock('2026-09-15'));
  assert.throws(() => Clock.fixedClock(undefined));
  assert.strictEqual(Clock.fixedClock(NOW).now, NOW);
});
