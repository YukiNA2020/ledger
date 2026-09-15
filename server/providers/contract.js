/* 小账本 provider adapter 契约 — Phase 4A「数据源决策与适配器契约」交付（ROADMAP.md）
 *
 * 目的：把「外部行情 / 汇率 provider」与产品其余部分解耦，并用类型与形状把隐私边界焊死。
 *
 * 设计要点（DECISIONS T-002/T-003、ARCHITECTURE §7、AGENTS.md「隐私与网络」）：
 *   - 输入只能是公开证券代码 / 币对（base+quote），不接收任何账户名、数量、成本、余额或持仓字段；
 *   - 输出统一结果：成功结果带原始代码、价格/汇率、数据日、抓取时间、provider；
 *     错误结果至少区分 timeout / rate_limit / not_found / invalid_payload / auth；
 *   - 所有时间由调用方经 ctx.now 注入（固定时钟），本模块不读真实时钟；
 *   - 定点十进制：价格用最小货币单位整数（priceMinor），汇率用定点十进制字符串（rateDecimal）；
 *   - 纯逻辑：无网络、无 DOM、无存储，node 可单测。
 *
 * 接口全集（ARCHITECTURE §7，供 4B–4E 逐步实现）：
 *   getEndOfDayQuotes(symbols, asOf, ctx)   → Promise<Result[]>   （4A 起）
 *   getFxRates(pairs, asOf, ctx)            → Promise<Result[]>   （4A 起）
 *   searchInstrument(query, ctx)            → Promise<Result[]>   （4B）
 *   getInstrumentMetadata(symbol, ctx)      → Promise<Result>     （4B）
 */
'use strict';

/* ------------------------------ 错误分类 ------------------------------ */

// 稳定错误码：契约要求至少覆盖这五类（NEXT_AGENT Phase 4A 任务 4）
var ERRORS = {
  TIMEOUT: 'timeout',
  RATE_LIMIT: 'rate_limit',
  NOT_FOUND: 'not_found',
  INVALID_PAYLOAD: 'invalid_payload',
  AUTH: 'auth'
};

// 可重试性：只有瞬态错误（超时 / 限额）值得重试；其余重试无意义或有害。
var RETRYABLE = {
  timeout: true,
  rate_limit: true,
  not_found: false,
  invalid_payload: false,
  auth: false
};

function isErrorCode(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(RETRYABLE, code);
}

function isRetryable(code) {
  return RETRYABLE[code] === true;
}

/* ------------------------------ 公开代码 / 币对校验 ------------------------------ */

// 公开证券代码：字母数字开头，可含 . _ -（VOO、0700.HK、510300.SS、BRK-B）。
// 有意排除空白、引号、参数分隔符等，从形状上拒绝夹带私有字段。
var SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

// 币种：3 位大写字母（MVP 限 CNY/HKD/USD，契约层只约束形状，币种白名单由上层 D-008 决定）。
var CURRENCY_RE = /^[A-Z]{3}$/;

// 定点十进制字符串："10"、"10.55"；不接受科学计数法 / 负数 / 前导符号（与 js/domain.js 语义一致）。
var DECIMAL_RE = /^\d+(\.\d+)?$/;

function isSymbol(v) {
  return typeof v === 'string' && SYMBOL_RE.test(v);
}

function isCurrency(v) {
  return typeof v === 'string' && CURRENCY_RE.test(v);
}

// 币对：{ base, quote } 两个币种代码，不含任何其他字段。
function isPair(v) {
  return !!v && typeof v === 'object' && v !== null &&
    isCurrency(v.base) && isCurrency(v.quote);
}

function isDecimalString(v) {
  return typeof v === 'string' && DECIMAL_RE.test(v);
}

/* ------------------------------ 请求序列化（隐私边界核心） ------------------------------ */

// 白名单构造：不管上层传入什么，产物只含公开代码数组。
// 私有字段（账户名、数量、成本、余额、完整持仓）在结构上不可能进入产物。
function serializeQuotesRequest(symbols) {
  return { symbols: (symbols || []).map(String) };
}

// 白名单构造：每个 pair 只保留 base/quote 两个键。
function serializeFxRequest(pairs) {
  return { pairs: (pairs || []).map(function (p) {
    return { base: String(p && p.base), quote: String(p && p.quote) };
  }) };
}

/* ------------------------------ 统一结果形状 ------------------------------ */

// 报价成功结果：原始代码、价格（最小货币单位）、币种、数据日（交易日）、抓取时间、provider。
function quoteResult(o) {
  return {
    kind: 'quote',
    symbol: o.symbol,
    priceMinor: o.priceMinor,
    currency: o.currency,
    priceDate: o.priceDate,
    fetchedAt: o.fetchedAt,
    provider: o.provider,
    status: 'ok'
  };
}

// 汇率成功结果：币对、定点汇率字符串、汇率日、抓取时间、provider。
function fxResult(o) {
  return {
    kind: 'fx',
    base: o.base,
    quote: o.quote,
    rateDecimal: o.rateDecimal,
    rateDate: o.rateDate,
    fetchedAt: o.fetchedAt,
    provider: o.provider,
    status: 'ok'
  };
}

// 错误结果：稳定错误码 + 用户可读 detail（detail 只描述失败原因，绝不携带私人财务事实）。
// subject 标识是哪一个公开代码 / 币对失败（可选，仍只含公开代码 / 币对）。
function errorResult(o) {
  return {
    kind: 'error',
    subject: o.subject != null ? String(o.subject) : null,
    code: o.code,
    detail: o.detail != null ? String(o.detail) : '',
    retryable: isRetryable(o.code)
  };
}

/* ------------------------------ 结果形状校验 ------------------------------ */

// 校验一个结果对象是否满足契约形状（供 fixture 自检，以及 4D 接真实 provider 时"先校验响应再落库"）。
function isValidResult(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.kind === 'quote') {
    return isSymbol(r.symbol) &&
      typeof r.priceMinor === 'number' && isFinite(r.priceMinor) &&
      isCurrency(r.currency) &&
      typeof r.priceDate === 'string' &&
      typeof r.fetchedAt === 'string' &&
      typeof r.provider === 'string' && r.provider.length > 0 &&
      r.status === 'ok';
  }
  if (r.kind === 'fx') {
    return isCurrency(r.base) && isCurrency(r.quote) &&
      isDecimalString(r.rateDecimal) &&
      typeof r.rateDate === 'string' &&
      typeof r.fetchedAt === 'string' &&
      typeof r.provider === 'string' && r.provider.length > 0 &&
      r.status === 'ok';
  }
  if (r.kind === 'error') {
    return isErrorCode(r.code) && (r.retryable === true || r.retryable === false);
  }
  return false;
}

module.exports = {
  ERRORS: ERRORS,
  RETRYABLE: RETRYABLE,
  isErrorCode: isErrorCode,
  isRetryable: isRetryable,
  isSymbol: isSymbol,
  isCurrency: isCurrency,
  isPair: isPair,
  isDecimalString: isDecimalString,
  serializeQuotesRequest: serializeQuotesRequest,
  serializeFxRequest: serializeFxRequest,
  quoteResult: quoteResult,
  fxResult: fxResult,
  errorResult: errorResult,
  isValidResult: isValidResult
};
