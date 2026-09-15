/* 小账本 provider fixture adapter — Phase 4A 交付（ROADMAP.md）
 *
 * 一个"不发任何真实网络请求"的假 provider，用于：
 *   1. 验证 adapter 契约（统一结果形状、严格校验、错误分类）可被第三方实现；
 *   2. 覆盖成功 / 超时 / 限额 / 缺标的 / 无效载荷 / 鉴权 / 节假日回退 / 不可入账数据等场景；
 *   3. 作为 4B–4E 各阶段自动测试的固定数据源（AGENTS.md「自动测试不得访问真实行情网络」）。
 *
 * 输入只接受公开证券代码 / 币对（经 Contract.serialize* 白名单 + 校验归一化），
 * 时间经 ctx.now 注入（见 clock.js），本模块零网络、零时钟副作用。
 *
 * asOf 语义（D-007「打开应用时自动获取最近有效日终行情」）：
 *   每个标的/币对持有一条按日期升序的时间序列；adapter 只取 priceDate <= asOf 的最近一条，
 *   因此在休市日（周末/节假日）自然回退到最近有效交易日，绝不会返回 asOf 之后的数据。
 *
 * fixture 里的代码、币对、金额、汇率为虚构数据，仅用于口径核对，不来自任何真实行情。
 */
'use strict';

var Contract = require('./contract');
var Clock = require('./clock');

// fixture 自身的 provider 标识：故意不冒充任何真实数据源（Stooq 等已实测不可用，见 SOURCES.md）。
var PROVIDER_ID = 'fixture';

/* ------------------------------ 固定 fixture 数据 ------------------------------ */

// 行情序列：symbol → { currency, points: [{ priceDate, priceMinor }] } 或 错误码字符串。
// points 必须按 priceDate 升序；未命中的 symbol 一律 not_found（缺标的）。
var QUOTES = {
  'VOO': {
    currency: 'USD',
    points: [
      { priceDate: '2026-09-10', priceMinor: 5010 },
      { priceDate: '2026-09-11', priceMinor: 5000 },
      { priceDate: '2026-09-14', priceMinor: 4992 }
    ]
  },
  '0700.HK': {
    currency: 'HKD',
    points: [
      { priceDate: '2026-09-11', priceMinor: 38800 },
      { priceDate: '2026-09-14', priceMinor: 39050 },
      { priceDate: '2026-09-15', priceMinor: 39210 }
    ]
  },
  '510300.SS': {
    currency: 'CNY',
    points: [
      { priceDate: '2026-09-11', priceMinor: 412 },
      { priceDate: '2026-09-14', priceMinor: 415 },
      { priceDate: '2026-09-15', priceMinor: 418 }
    ]
  },
  // 节假日：该标的在 2026-09-14 / 2026-09-15 休市，asOf 命中休市日时回退最近交易日 2026-09-11。
  'HOLIDAY.MK': {
    currency: 'USD',
    points: [
      { priceDate: '2026-09-10', priceMinor: 2010 },
      { priceDate: '2026-09-11', priceMinor: 2000 }
    ]
  },
  // 不可入账数据：负价格必须被结果校验拦下并转为 invalid_payload，绝不允许落库。
  'GARBAGE.ETF': {
    currency: 'USD',
    points: [{ priceDate: '2026-09-11', priceMinor: -1 }]
  },
  // 错误场景：用合法但虚构的代码标记，命中即返回对应错误码。
  'SLOW.ETF': 'timeout',
  'LIMITED.ETF': 'rate_limit',
  'BROKEN.ETF': 'invalid_payload',
  'AUTH.ETF': 'auth'
};

// 汇率序列："BASE/QUOTE" → { points: [{ rateDate, rateDecimal }] } 或 错误码字符串。
var FX = {
  'USD/CNY': {
    points: [
      { rateDate: '2026-09-11', rateDecimal: '7.2000' },
      { rateDate: '2026-09-14', rateDecimal: '7.1900' }
    ]
  },
  'HKD/CNY': {
    points: [{ rateDate: '2026-09-11', rateDecimal: '0.9200' }]
  },
  'USD/HKD': {
    points: [{ rateDate: '2026-09-11', rateDecimal: '7.8200' }]
  },
  // 不可入账汇率：0 不是有效汇率，必须被结果校验拦下。
  'III/JJJ': {
    points: [{ rateDate: '2026-09-11', rateDecimal: '0' }]
  },
  // 错误场景：AAA/BBB 等为合法 3 字母但无真实含义的虚构币种，命中即返回对应错误码。
  'AAA/BBB': 'timeout',
  'CCC/DDD': 'rate_limit',
  'EEE/FFF': 'invalid_payload',
  'GGG/HHH': 'auth'
};

function pairKey(base, quote) {
  return base + '/' + quote;
}

/* ------------------------------ 内部工具 ------------------------------ */

// 从时间序列中取 dateField <= asOf 的最近一条；没有则为 null（asOf 早于可得数据起始日）。
// ISO 日期字符串可直接字典序比较。
function pickLatest(points, asOf, dateField) {
  var best = null;
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    if (p[dateField] <= asOf && (best === null || p[dateField] > best[dateField])) best = p;
  }
  return best;
}

// asOf 必须是真实存在的 YYYY-MM-DD；非法直接整体拒绝，不用"今天"兜底。
function badAsOf(asOf) {
  if (!Contract.isDateString(asOf)) return 'asOf 必须是真实存在的 YYYY-MM-DD 日期';
  return null;
}

// 请求/前置条件不合格时的统一出口：返回单个 invalid_payload 结果。
// detail 只含形状说明，不回显任何输入原文。
function reject(detail) {
  return Contract.errorResult({ subject: null, code: Contract.ERRORS.INVALID_PAYLOAD, detail: detail });
}

/* ------------------------------ adapter 接口实现 ------------------------------ */

// getEndOfDayQuotes(symbols, asOf, ctx) → Promise<Result[]>
//   symbols：公开证券代码数组；asOf：'YYYY-MM-DD'；ctx：{ now }。
//   每个输入产生一个结果：成功（quote，priceDate <= asOf）或错误（not_found / 命中错误场景 / invalid_payload）。
function getEndOfDayQuotes(symbols, asOf, ctx) {
  var req = Contract.serializeQuotesRequest(symbols); // 白名单 + 校验：非法输入不进 adapter
  if (!req.ok) return Promise.resolve([reject(req.error.detail)]);

  var asOfError = badAsOf(asOf);
  if (asOfError) return Promise.resolve([reject(asOfError)]);

  var now = Clock.nowOf(ctx);
  if (!Contract.isTimestamp(now)) return Promise.resolve([reject('缺少有效的抓取时间 ctx.now')]);

  return Promise.resolve(req.symbols.map(function (sym) {
    var entry = QUOTES[sym];
    if (entry == null) {
      return Contract.errorResult({ subject: sym, code: Contract.ERRORS.NOT_FOUND, detail: 'fixture 未收录该公开代码' });
    }
    if (typeof entry === 'string') {
      return Contract.errorResult({ subject: sym, code: entry });
    }
    var point = pickLatest(entry.points, asOf, 'priceDate');
    if (point === null) {
      return Contract.errorResult({
        subject: sym,
        code: Contract.ERRORS.NOT_FOUND,
        detail: 'asOf 早于该标的可得数据起始日'
      });
    }
    try {
      return Contract.quoteResult({
        symbol: sym,
        priceMinor: point.priceMinor,
        currency: entry.currency,
        priceDate: point.priceDate,
        fetchedAt: now,
        provider: PROVIDER_ID
      });
    } catch (e) {
      // provider 返回不可入账数据：转成稳定的 invalid_payload，绝不落库。
      return Contract.errorResult({
        subject: sym,
        code: Contract.ERRORS.INVALID_PAYLOAD,
        detail: 'fixture 记录了不可入账的行情数据'
      });
    }
  }));
}

// getFxRates(pairs, asOf, ctx) → Promise<Result[]>
//   pairs：{ base, quote }[]；其余同 getEndOfDayQuotes。
function getFxRates(pairs, asOf, ctx) {
  var req = Contract.serializeFxRequest(pairs); // 白名单：每个 pair 只保留 base/quote
  if (!req.ok) return Promise.resolve([reject(req.error.detail)]);

  var asOfError = badAsOf(asOf);
  if (asOfError) return Promise.resolve([reject(asOfError)]);

  var now = Clock.nowOf(ctx);
  if (!Contract.isTimestamp(now)) return Promise.resolve([reject('缺少有效的抓取时间 ctx.now')]);

  return Promise.resolve(req.pairs.map(function (p) {
    var key = pairKey(p.base, p.quote);
    var entry = FX[key];
    if (entry == null) {
      return Contract.errorResult({ subject: key, code: Contract.ERRORS.NOT_FOUND, detail: 'fixture 未收录该公开币对' });
    }
    if (typeof entry === 'string') {
      return Contract.errorResult({ subject: key, code: entry });
    }
    var point = pickLatest(entry.points, asOf, 'rateDate');
    if (point === null) {
      return Contract.errorResult({
        subject: key,
        code: Contract.ERRORS.NOT_FOUND,
        detail: 'asOf 早于该币对可得数据起始日'
      });
    }
    try {
      return Contract.fxResult({
        base: p.base,
        quote: p.quote,
        rateDecimal: point.rateDecimal,
        rateDate: point.rateDate,
        fetchedAt: now,
        provider: PROVIDER_ID
      });
    } catch (e) {
      return Contract.errorResult({
        subject: key,
        code: Contract.ERRORS.INVALID_PAYLOAD,
        detail: 'fixture 记录了不可入账的汇率数据'
      });
    }
  }));
}

module.exports = {
  PROVIDER_ID: PROVIDER_ID,
  QUOTES: QUOTES,
  FX: FX,
  getEndOfDayQuotes: getEndOfDayQuotes,
  getFxRates: getFxRates
};
