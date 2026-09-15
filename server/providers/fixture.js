/* 小账本 provider fixture adapter — Phase 4A 交付（ROADMAP.md）
 *
 * 一个"不发任何真实网络请求"的假 provider，用于：
 *   1. 验证 adapter 契约（统一结果形状、错误分类）可被第三方实现；
 *   2. 覆盖成功 / 超时 / 限额 / 缺标的 / 无效载荷 / 鉴权 / 节假日回退等场景；
 *   3. 作为 4B–4E 各阶段自动测试的固定数据源（AGENTS.md「自动测试不得访问真实行情网络」）。
 *
 * 输入只接受公开证券代码 / 币对（经 Contract.serialize* 白名单归一化），
 * 时间经 ctx.now 注入（见 clock.js），本模块零网络、零时钟副作用。
 *
 * fixture 里的金额/汇率为虚构数据，仅用于口径核对，不来自任何真实行情。
 */
'use strict';

var Contract = require('./contract');
var Clock = require('./clock');

/* ------------------------------ 固定 fixture 数据 ------------------------------ */

// 行情 fixture：symbol → 成功数据 或 错误码字符串（timeout/rate_limit/invalid_payload/auth）。
// priceDate 为"最近有效交易日"（2026-09-11 周五）；未命中的 symbol 一律 not_found（缺标的）。
var QUOTES = {
  'VOO': { priceMinor: 5000, currency: 'USD', priceDate: '2026-09-11', provider: 'stooq' },
  '0700.HK': { priceMinor: 38800, currency: 'HKD', priceDate: '2026-09-11', provider: 'stooq' },
  '510300.SS': { priceMinor: 412, currency: 'CNY', priceDate: '2026-09-11', provider: 'stooq' },
  // 节假日：asOf=2026-09-14 当天休市，返回最近交易日 2026-09-11，不报错（D-007 接受最近有效交易日）。
  'HOLIDAY.US': { priceMinor: 2000, currency: 'USD', priceDate: '2026-09-11', provider: 'stooq' },
  // 错误场景：用合法但虚构的代码标记，命中即返回对应错误码。
  'SLOW.ETF': 'timeout',
  'LIMITED.ETF': 'rate_limit',
  'BROKEN.ETF': 'invalid_payload',
  'AUTH.ETF': 'auth'
};

// 汇率 fixture："BASE/QUOTE" → 成功数据 或 错误码字符串。
var FX = {
  'USD/CNY': { rateDecimal: '7.2000', rateDate: '2026-09-11', provider: 'frankfurter' },
  'HKD/CNY': { rateDecimal: '0.9200', rateDate: '2026-09-11', provider: 'frankfurter' },
  'USD/HKD': { rateDecimal: '7.8200', rateDate: '2026-09-11', provider: 'frankfurter' },
  // 错误场景：AAA/BBB 等为合法 3 字母但无真实含义的虚构币种，命中即返回对应错误码。
  'AAA/BBB': 'timeout',
  'CCC/DDD': 'rate_limit',
  'EEE/FFF': 'invalid_payload',
  'GGG/HHH': 'auth'
};

function pairKey(base, quote) {
  return base + '/' + quote;
}

/* ------------------------------ adapter 接口实现 ------------------------------ */

// getEndOfDayQuotes(symbols, asOf, ctx) → Promise<Result[]>
//   symbols：公开证券代码数组；asOf：'YYYY-MM-DD'；ctx：{ now }。
//   每个输入产生一个结果：成功（quote）或错误（not_found / 命中错误场景）。
function getEndOfDayQuotes(symbols, asOf, ctx) {
  var req = Contract.serializeQuotesRequest(symbols); // 白名单：只保留公开代码
  var now = Clock.nowOf(ctx);
  return Promise.resolve(req.symbols.map(function (sym) {
    var entry = QUOTES[sym];
    if (entry == null) {
      return Contract.errorResult({ subject: sym, code: Contract.ERRORS.NOT_FOUND, detail: 'fixture 未覆盖该标的' });
    }
    if (typeof entry === 'string') {
      return Contract.errorResult({ subject: sym, code: entry });
    }
    return Contract.quoteResult({
      symbol: sym,
      priceMinor: entry.priceMinor,
      currency: entry.currency,
      priceDate: entry.priceDate,
      fetchedAt: now,
      provider: entry.provider
    });
  }));
}

// getFxRates(pairs, asOf, ctx) → Promise<Result[]>
//   pairs：{ base, quote }[]；其余同 getEndOfDayQuotes。
function getFxRates(pairs, asOf, ctx) {
  var req = Contract.serializeFxRequest(pairs); // 白名单：每个 pair 只保留 base/quote
  var now = Clock.nowOf(ctx);
  return Promise.resolve(req.pairs.map(function (p) {
    var key = pairKey(p.base, p.quote);
    var entry = FX[key];
    if (entry == null) {
      return Contract.errorResult({ subject: key, code: Contract.ERRORS.NOT_FOUND, detail: 'fixture 未覆盖该币对' });
    }
    if (typeof entry === 'string') {
      return Contract.errorResult({ subject: key, code: entry });
    }
    return Contract.fxResult({
      base: p.base,
      quote: p.quote,
      rateDecimal: entry.rateDecimal,
      rateDate: entry.rateDate,
      fetchedAt: now,
      provider: entry.provider
    });
  }));
}

module.exports = {
  QUOTES: QUOTES,
  FX: FX,
  getEndOfDayQuotes: getEndOfDayQuotes,
  getFxRates: getFxRates
};
