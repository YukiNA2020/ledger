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
 * 4B 追加（标的检索与元数据）：
 *   searchInstrument(query, ctx) / getInstrumentMetadata(symbol, ctx) 使用 CATALOG 数据集，
 *   字段严格按 D-037 的 provider 字段映射（symbol / instrument_name / currency / exchange /
 *   mic_code / instrument_type / country / exchange_timezone），并逐条附带 provenance
 *   （endpoint / sourceVersion / sourceRef / fetchedAt / payloadHash，payloadHash 由响应字段重算可复核）。
 *   CATALOG 只提供 provider 真有的字段：asset_class、exposure_market、跟踪指数**不在其中**，
 *   它们属于用户判断，由本地确认流程填写（4B 服务层负责，provider 无权生成）。
 *
 * fixture 里的代码、币对、金额、汇率为虚构数据，仅用于口径核对，不来自任何真实行情。
 * 名称与交易所形状与 SOURCES.md §4 记录的参考数据探测结果一致，便于离线核对字段映射。
 */
'use strict';

var crypto = require('node:crypto');

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

/* ---------------------- 标的检索与元数据数据集（4B） ---------------------- */

// 参考数据端点与版本：形状对齐 D-037 选定的参考数据来源（真实接入属 4D 门禁之后）。
var METADATA_ENDPOINT = '/symbol_search';
var METADATA_SOURCE_VERSION = 'fixture-reference-v1';

// CATALOG：公开标的的参考数据。
// 每条记录只含 provider 真有的字段；缺项一律写 null（不得用空串或猜测值冒充）。
// instrumentType = 'ETF' / 'Common Stock' 等上游原样取值，不由本模块翻译成资产类别。
var CATALOG = {
  VOO: {
    symbol: 'VOO',
    name: 'Vanguard S&P 500 ETF',
    currency: 'USD',
    exchange: 'NYSE',
    micCode: 'ARCX',
    instrumentType: 'ETF',
    country: 'United States',
    exchangeTimezone: 'America/New_York'
  },
  '0700.HK': {
    symbol: '0700.HK',
    name: 'Tencent Holdings Ltd',
    currency: 'HKD',
    exchange: 'HKEX',
    micCode: 'XHKG',
    instrumentType: 'Common Stock',
    country: 'Hong Kong',
    exchangeTimezone: 'Asia/Hong_Kong'
  },
  '2800.HK': {
    symbol: '2800.HK',
    name: 'Tracker Fund of Hong Kong',
    currency: 'HKD',
    exchange: 'HKEX',
    micCode: 'XHKG',
    instrumentType: 'ETF',
    country: 'Hong Kong',
    exchangeTimezone: 'Asia/Hong_Kong'
  },
  '510300.SS': {
    symbol: '510300.SS',
    name: 'Huatai-PB CSI 300 ETF',
    currency: 'CNY',
    exchange: 'SSE',
    micCode: 'XSHG',
    instrumentType: 'ETF',
    country: 'China',
    exchangeTimezone: 'Asia/Shanghai'
  },
  // 上游字段缺失的标的：可用于证明"provider 没给就不编造"，缺项必须是 null。
  'MYSTERY.ETF': {
    symbol: 'MYSTERY.ETF',
    name: null,
    currency: 'USD',
    exchange: null,
    micCode: null,
    instrumentType: null,
    country: null,
    exchangeTimezone: null
  },
  // 元数据不可入账：币种形状非法，必须在结果构造时被拦下（不落库）。
  'BADMETA.ETF': {
    symbol: 'BADMETA.ETF',
    name: 'Broken Metadata Fund',
    currency: 'usd',
    exchange: 'NYSE',
    micCode: 'ARCX',
    instrumentType: 'ETF',
    country: 'United States',
    exchangeTimezone: 'America/New_York'
  },
  // 错误场景：命中即返回对应错误码（检索与元数据同用）。
  'AUTH.ETF': 'auth',
  'SLOWMETA.ETF': 'timeout'
};

// 检索词触发的 provider 级失败（不是"没搜到"，而是这次调用整体失败）。
// 用大写虚构词，避免与真实证券名称冲突。
var SEARCH_ERRORS = {
  SLOW: 'timeout',
  LIMITED: 'rate_limit',
  UNAUTHORIZED: 'auth'
};

// 原始响应摘要：对上游字段做规范化序列化后取 sha256，任何一条 provenance 都可被重算复核。
function payloadHashOf(record) {
  var canonical = JSON.stringify({
    symbol: record.symbol,
    instrument_name: record.name,
    currency: record.currency,
    exchange: record.exchange,
    mic_code: record.micCode,
    instrument_type: record.instrumentType,
    country: record.country,
    exchange_timezone: record.exchangeTimezone
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// 上游原始代码形状（D-037 的 sourceRef）：原始 symbol + exchange + mic_code。
function sourceRefOf(record) {
  return [record.symbol, record.exchange || 'NA', record.micCode || 'NA'].join('@');
}

// 把一条参考数据记录构造成契约结果（含 provenance）。
// 上游字段不可入账时由 instrumentResult 抛 ContractError，由调用方转成稳定的 invalid_payload。
function candidateResult(record, now) {
  return Contract.instrumentResult({
    symbol: record.symbol,
    name: record.name,
    currency: record.currency,
    exchange: record.exchange,
    country: record.country,
    instrumentType: record.instrumentType,
    exchangeTimezone: record.exchangeTimezone,
    provenance: {
      provider: PROVIDER_ID,
      endpoint: METADATA_ENDPOINT,
      sourceVersion: METADATA_SOURCE_VERSION,
      sourceRef: sourceRefOf(record),
      fetchedAt: now,
      payloadHash: payloadHashOf(record)
    }
  });
}

// 检索结果上限：单次检索最多返回多少条候选（防止上游把整本清单塞回来）。
var MAX_SEARCH_RESULTS = 20;

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

// searchInstrument(query, ctx) → Promise<Result[]>
//   query：公开的证券名称或代码片段（经 Contract.serializeSearchRequest 校验 + 归一化，只保留检索词本身）；
//   ctx：{ now }。命中返回 instrument 结果数组（≤ MAX_SEARCH_RESULTS），没有命中返回空数组，
//   provider 级失败返回单个 error 结果 —— "没搜到"与"这次调用失败"必须可区分。
function searchInstrument(query, ctx) {
  var req = Contract.serializeSearchRequest(query); // 白名单 + 校验：非法输入不进 adapter
  if (!req.ok) return Promise.resolve([reject(req.error.detail)]);

  var now = Clock.nowOf(ctx);
  if (!Contract.isTimestamp(now)) return Promise.resolve([reject('缺少有效的抓取时间 ctx.now')]);

  var errorCode = SEARCH_ERRORS[req.query.toUpperCase()];
  if (errorCode) {
    return Promise.resolve([
      Contract.errorResult({
        subject: null,
        code: errorCode,
        detail: 'fixture 记录的检索失败场景'
      })
    ]);
  }

  var needle = req.query.toLowerCase();
  var results = [];
  Object.keys(CATALOG).forEach(function (symbol) {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    var record = CATALOG[symbol];
    if (typeof record === 'string') return; // 错误场景记录不作为候选返回
    var haystack = (record.symbol + ' ' + (record.name || '')).toLowerCase();
    if (haystack.indexOf(needle) === -1) return;
    try {
      results.push(candidateResult(record, now));
    } catch (e) {
      // 上游元数据不可入账：转成稳定的 invalid_payload，绝不让"看起来是候选"的坏数据流出去。
      results.push(
        Contract.errorResult({
          subject: record.symbol,
          code: Contract.ERRORS.INVALID_PAYLOAD,
          detail: 'fixture 记录了不可入账的标的元数据'
        })
      );
    }
  });
  return Promise.resolve(results);
}

// getInstrumentMetadata(symbol, ctx) → Promise<Result>
//   单个标的的参考数据；未收录返回 not_found，上游字段不可入账返回 invalid_payload。
function getInstrumentMetadata(symbol, ctx) {
  var req = Contract.serializeMetadataRequest(symbol);
  if (!req.ok) return Promise.resolve(reject(req.error.detail));

  var now = Clock.nowOf(ctx);
  if (!Contract.isTimestamp(now)) return Promise.resolve(reject('缺少有效的抓取时间 ctx.now'));

  var record = CATALOG[req.symbol];
  if (record == null) {
    return Promise.resolve(
      Contract.errorResult({
        subject: req.symbol,
        code: Contract.ERRORS.NOT_FOUND,
        detail: 'fixture 未收录该公开代码'
      })
    );
  }
  if (typeof record === 'string') {
    return Promise.resolve(Contract.errorResult({ subject: req.symbol, code: record }));
  }
  try {
    return Promise.resolve(candidateResult(record, now));
  } catch (e) {
    return Promise.resolve(
      Contract.errorResult({
        subject: req.symbol,
        code: Contract.ERRORS.INVALID_PAYLOAD,
        detail: 'fixture 记录了不可入账的标的元数据'
      })
    );
  }
}

module.exports = {
  PROVIDER_ID: PROVIDER_ID,
  QUOTES: QUOTES,
  FX: FX,
  CATALOG: CATALOG,
  METADATA_ENDPOINT: METADATA_ENDPOINT,
  METADATA_SOURCE_VERSION: METADATA_SOURCE_VERSION,
  payloadHashOf: payloadHashOf,
  sourceRefOf: sourceRefOf,
  getEndOfDayQuotes: getEndOfDayQuotes,
  getFxRates: getFxRates,
  searchInstrument: searchInstrument,
  getInstrumentMetadata: getInstrumentMetadata
};
