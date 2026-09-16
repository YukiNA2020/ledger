/* 小账本 provider adapter 契约 — Phase 4A「数据源决策与适配器契约」交付（ROADMAP.md）
 *
 * 目的：把「外部行情 / 汇率 provider」与产品其余部分解耦，并用类型与形状把隐私边界焊死。
 *
 * 设计要点（DECISIONS T-002/T-003、ARCHITECTURE §7、AGENTS.md「隐私与网络」）：
 *   - 输入只能是公开证券代码 / 币对（base+quote），不接收任何账户名、数量、成本、余额或持仓字段；
 *     请求在序列化**之前**逐项校验，非法输入一律变成稳定的 invalid_payload，不会流进 adapter 被当成 not_found；
 *   - 输出统一结果：成功结果带原始代码、价格/汇率、数据日、抓取时间、provider；
 *     错误结果至少区分 timeout / rate_limit / not_found / invalid_payload / auth；
 *   - 结果构造是严格的：价格必须是正的安全整数、汇率必须大于零、日期必须是真实存在的 YYYY-MM-DD、
 *     抓取时间必须是带时区的 ISO 时间戳、retryable 必须严格等于错误码映射 —— 不可入账的数据在构造时就抛错，
 *     不允许以"形状看起来对"的姿态进入持久层（4D 落库前的最后一道闸门）；
 *   - 错误结果的 subject 只允许公开代码 / 币对形状，其他字符串（可能是误传的账户名等私有文本）一律置空；
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

// 契约违例：结果构造失败或未知错误码。只由本模块抛出，detail 只描述"哪个字段不合格"，
// 绝不回显字段取值（取值可能是误传的私有财务文本）。
function ContractError(code, detail) {
  this.name = 'ContractError';
  this.code = isErrorCode(code) ? code : ERRORS.INVALID_PAYLOAD;
  this.detail = detail;
  this.message = 'provider 契约校验失败：' + detail;
}
ContractError.prototype = Object.create(Error.prototype);
ContractError.prototype.constructor = ContractError;

/* ------------------------------ 形状校验 ------------------------------ */

// 公开证券代码：字母数字开头，可含 . _ -（VOO、0700.HK、510300.SS、BRK-B）。
// 有意排除空白、引号、参数分隔符等，从形状上拒绝夹带私有字段。
var SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

// 币种：3 位大写字母（MVP 限 CNY/HKD/USD，契约层只约束形状，币种白名单由上层 D-008 决定）。
var CURRENCY_RE = /^[A-Z]{3}$/;

// 定点十进制字符串："10"、"10.55"；不接受科学计数法 / 负数 / 前导符号（与 js/domain.js 语义一致）。
var DECIMAL_RE = /^\d+(\.\d+)?$/;

// 日期：严格 YYYY-MM-DD（形状），真实存在性另由 isDateString 校验。
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 时间戳：必须带日期 + 时分秒 + 时区（Z 或 ±HH:MM）。捕获各字段后再做真实值域校验，
// 避免 Date.parse 把 2026-02-30 或 24:00:00 静默归一到下一个有效时刻。
var TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/;

// 币对键：'USD/CNY'，只用于错误结果的 subject。
var PAIR_KEY_RE = /^[A-Z]{3}\/[A-Z]{3}$/;

// 单批请求上限：一次请求最多多少只标的 / 多少组币对。
var MAX_BATCH_SIZE = 200;

// 错误 detail 的最大长度（防御性：避免 adapter 把上游整段响应原文塞进 detail）。
var MAX_DETAIL_LENGTH = 160;

function isSymbol(v) {
  return typeof v === 'string' && SYMBOL_RE.test(v);
}

function isCurrency(v) {
  return typeof v === 'string' && CURRENCY_RE.test(v);
}

// 币对：{ base, quote } 两个币种代码，不含任何其他字段。
function isPair(v) {
  return !!v && typeof v === 'object' && isCurrency(v.base) && isCurrency(v.quote);
}

function isDecimalString(v) {
  return typeof v === 'string' && DECIMAL_RE.test(v);
}

// 大于零的定点十进制：拒绝 '0'、'0.0000'、'0.00' 这类"形状合法但不值钱"的汇率。
function isPositiveDecimalString(v) {
  return isDecimalString(v) && /[1-9]/.test(v);
}

// 正的安全整数：金额只允许正整数最小货币单位；拒绝 0、负数、小数、NaN、Infinity、超出安全整数范围。
function isPositiveSafeInteger(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainRecord(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  var proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// 结果是跨 provider 的安全边界，必须只含契约白名单键；否则 adapter 夹带的账户、数量、成本等
// 私人字段可能穿过 assertValidResult 进入日志或持久层。
function hasExactKeys(v, expected) {
  if (!isPlainRecord(v)) return false;
  var actual = Object.keys(v).sort();
  var wanted = expected.slice().sort();
  if (actual.length !== wanted.length) return false;
  for (var i = 0; i < actual.length; i++) {
    if (actual[i] !== wanted[i]) return false;
  }
  return true;
}

// 真实存在的日历日：'2026-02-30'、'2026-13-01'、'2026-9-1' 一律拒绝。
function isDateString(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  var y = Number(v.slice(0, 4));
  var m = Number(v.slice(5, 7));
  var d = Number(v.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 有效 ISO 时间戳：形状必须带时区，且时间本身可被解析（拒绝 '2026-09-15T99:00:00Z'）。
function isTimestamp(v) {
  if (typeof v !== 'string') return false;
  var match = TIMESTAMP_RE.exec(v);
  if (!match || !isDateString(match[1])) return false;
  var hour = Number(match[2]);
  var minute = Number(match[3]);
  var second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[6] !== 'Z') {
    var offsetHour = Number(match[8]);
    var offsetMinute = Number(match[9]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(v));
}

function isPairKey(v) {
  return typeof v === 'string' && PAIR_KEY_RE.test(v);
}

/* ------------------------------ 请求校验 + 序列化（隐私边界核心） ------------------------------ */

// 失败请求：detail 只含"第 N 项 / 形状说明"，绝不回显输入原文。
// 这一点很重要：输入里可能是误传的账户名、备注或整段持仓文本，回显即等于把私有事实写进错误对象。
function invalidRequest(detail) {
  return { ok: false, error: { code: ERRORS.INVALID_PAYLOAD, detail: detail } };
}

function okRequest(key, values) {
  var r = { ok: true };
  r[key] = values;
  return r;
}

// 行情请求：必须是公开证券代码数组。非数组、空数组、超限、任一项形状不合格都整体拒绝。
// 返回 { ok: true, symbols: [...] } 或 { ok: false, error: { code, detail } }。
function serializeQuotesRequest(symbols) {
  if (!Array.isArray(symbols)) return invalidRequest('行情请求必须是公开证券代码数组');
  if (symbols.length === 0) return invalidRequest('行情请求不能为空数组');
  if (symbols.length > MAX_BATCH_SIZE) return invalidRequest('行情请求超过单批上限 ' + MAX_BATCH_SIZE);
  var out = [];
  for (var i = 0; i < symbols.length; i++) {
    if (!isSymbol(symbols[i])) return invalidRequest('第 ' + i + ' 项不是合法的公开证券代码形状');
    out.push(symbols[i]); // 原样保留（不再 String() 强转），保证产物与通过校验的输入完全一致
  }
  return okRequest('symbols', out);
}

// 汇率请求：必须是 { base, quote } 数组，币种为 3 位大写字母。
// 每个 pair 只保留 base/quote 两个键 —— 夹带的金额、账户名、余额在结构上不可能进入产物。
function serializeFxRequest(pairs) {
  if (!Array.isArray(pairs)) return invalidRequest('汇率请求必须是公开币对数组');
  if (pairs.length === 0) return invalidRequest('汇率请求不能为空数组');
  if (pairs.length > MAX_BATCH_SIZE) return invalidRequest('汇率请求超过单批上限 ' + MAX_BATCH_SIZE);
  var out = [];
  for (var i = 0; i < pairs.length; i++) {
    if (!isPair(pairs[i])) return invalidRequest('第 ' + i + ' 项不是合法的公开币对形状');
    out.push({ base: pairs[i].base, quote: pairs[i].quote });
  }
  return okRequest('pairs', out);
}

/* ------------------------------ 统一结果形状（严格构造） ------------------------------ */

function requireOrThrow(cond, detail) {
  if (!cond) throw new ContractError(ERRORS.INVALID_PAYLOAD, detail);
}

// 报价成功结果：原始代码、价格（最小货币单位）、币种、数据日（交易日）、抓取时间、provider。
// 任一项不满足即抛 ContractError：不可入账的数据不允许构造出"看起来是成功结果"的对象。
function quoteResult(o) {
  requireOrThrow(!!o && typeof o === 'object', 'quoteResult 需要对象');
  requireOrThrow(isSymbol(o.symbol), 'quote.symbol 不是合法的公开证券代码形状');
  requireOrThrow(isPositiveSafeInteger(o.priceMinor), 'quote.priceMinor 必须是正的安全整数（最小货币单位）');
  requireOrThrow(isCurrency(o.currency), 'quote.currency 必须是 3 位大写币种代码');
  requireOrThrow(isDateString(o.priceDate), 'quote.priceDate 必须是真实存在的 YYYY-MM-DD 日期');
  requireOrThrow(isTimestamp(o.fetchedAt), 'quote.fetchedAt 必须是带时区的 ISO 时间戳');
  requireOrThrow(nonEmptyString(o.provider), 'quote.provider 必须是非空字符串');
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

// 汇率成功结果：币对、定点汇率字符串（必须 > 0）、汇率日、抓取时间、provider。
function fxResult(o) {
  requireOrThrow(!!o && typeof o === 'object', 'fxResult 需要对象');
  requireOrThrow(isCurrency(o.base), 'fx.base 必须是 3 位大写币种代码');
  requireOrThrow(isCurrency(o.quote), 'fx.quote 必须是 3 位大写币种代码');
  requireOrThrow(isPositiveDecimalString(o.rateDecimal), 'fx.rateDecimal 必须是大于零的定点十进制字符串');
  requireOrThrow(isDateString(o.rateDate), 'fx.rateDate 必须是真实存在的 YYYY-MM-DD 日期');
  requireOrThrow(isTimestamp(o.fetchedAt), 'fx.fetchedAt 必须是带时区的 ISO 时间戳');
  requireOrThrow(nonEmptyString(o.provider), 'fx.provider 必须是非空字符串');
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

// 错误结果的 subject 只接受公开代码 / 币对形状；其他字符串一律置空。
// 这是隐私边界的第二道闸：即便上游 adapter 误把账户名当 subject 传进来，也不会写进结果。
function safeSubject(v) {
  if (isSymbol(v) || isPairKey(v)) return v;
  return null;
}

// 错误 detail 只描述失败原因，且强制单行、去控制字符、截断到上限。
function safeDetail(v) {
  if (v == null) return '';
  var s = String(v)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_DETAIL_LENGTH ? s.slice(0, MAX_DETAIL_LENGTH) : s;
}

// 错误结果：稳定错误码 + 用户可读 detail（detail 只描述失败原因，绝不携带私人财务事实）。
// retryable 不是入参 —— 它由错误码映射推导，调用方无法伪造不一致的重试语义。
function errorResult(o) {
  o = o || {};
  requireOrThrow(isErrorCode(o.code), 'errorResult 需要五类稳定错误码之一');
  return {
    kind: 'error',
    subject: safeSubject(o.subject),
    code: o.code,
    detail: safeDetail(o.detail),
    retryable: isRetryable(o.code)
  };
}

/* ------------------------------ 结果形状校验 ------------------------------ */

// 校验一个结果对象是否满足契约形状（供 fixture 自检，以及 4D 接真实 provider 时"先校验响应再落库"）。
// 判定标准与构造函数的严格程度保持一致：通过这里就等于可以入账。
function isValidResult(r) {
  if (!isPlainRecord(r)) return false;
  if (r.kind === 'quote') {
    return hasExactKeys(r, ['kind', 'symbol', 'priceMinor', 'currency', 'priceDate', 'fetchedAt', 'provider', 'status']) &&
      isSymbol(r.symbol) &&
      isPositiveSafeInteger(r.priceMinor) &&
      isCurrency(r.currency) &&
      isDateString(r.priceDate) &&
      isTimestamp(r.fetchedAt) &&
      nonEmptyString(r.provider) &&
      r.status === 'ok';
  }
  if (r.kind === 'fx') {
    return hasExactKeys(r, ['kind', 'base', 'quote', 'rateDecimal', 'rateDate', 'fetchedAt', 'provider', 'status']) &&
      isCurrency(r.base) && isCurrency(r.quote) &&
      isPositiveDecimalString(r.rateDecimal) &&
      isDateString(r.rateDate) &&
      isTimestamp(r.fetchedAt) &&
      nonEmptyString(r.provider) &&
      r.status === 'ok';
  }
  if (r.kind === 'error') {
    return hasExactKeys(r, ['kind', 'subject', 'code', 'detail', 'retryable']) &&
      isErrorCode(r.code) &&
      r.retryable === isRetryable(r.code) &&
      (r.subject === null || isSymbol(r.subject) || isPairKey(r.subject)) &&
      typeof r.detail === 'string' &&
      r.detail === safeDetail(r.detail);
  }
  return false;
}

// 断言式校验：不合格即抛 ContractError（4D 落库前调用，替代"看起来没问题就写"）。
function assertValidResult(r) {
  if (!isValidResult(r)) throw new ContractError(ERRORS.INVALID_PAYLOAD, '结果不满足 provider 契约形状');
  return r;
}

module.exports = {
  ERRORS: ERRORS,
  RETRYABLE: RETRYABLE,
  MAX_BATCH_SIZE: MAX_BATCH_SIZE,
  MAX_DETAIL_LENGTH: MAX_DETAIL_LENGTH,
  ContractError: ContractError,
  isErrorCode: isErrorCode,
  isRetryable: isRetryable,
  isSymbol: isSymbol,
  isCurrency: isCurrency,
  isPair: isPair,
  isPairKey: isPairKey,
  isDecimalString: isDecimalString,
  isPositiveDecimalString: isPositiveDecimalString,
  isPositiveSafeInteger: isPositiveSafeInteger,
  isDateString: isDateString,
  isTimestamp: isTimestamp,
  serializeQuotesRequest: serializeQuotesRequest,
  serializeFxRequest: serializeFxRequest,
  quoteResult: quoteResult,
  fxResult: fxResult,
  errorResult: errorResult,
  isValidResult: isValidResult,
  assertValidResult: assertValidResult
};
