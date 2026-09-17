/* 小账本 server/providers/frankfurter.js — 汇率 provider（Phase 4D）
 *
 * 冻结口径（DECISIONS D-036）：**必须**使用 provider-pin 端点 `/v2/providers/ecb/rates`
 * （ECB 参考汇率）。默认端点 `/v2/rates` 是多来源混合值，实测同日数值不同
 * （USD/CNY 6.7071 vs 6.7065，2026-09-17 复测），不满足"ECB 参考汇率"口径，绝不回落。
 *
 * 契约纪律（server/providers/contract.js）：
 *   - 请求序列化前先校验（serializeFxRequest），产物键集合恒为 { base, quote } ——
 *     账户名、余额、数量、成本在结构上不可能进入对外请求（D-020）；
 *   - 结果用 Contract.fxResult **严格构造**，不合格即 invalid_payload；
 *   - 失败语义统一映射到五类错误码；retryable 是派生字段，不由本模块决定。
 *
 * 失败语义映射（写进 SOURCES.md §1.3 与 D-044）：
 *   HTTP 401/403 → auth；404 → not_found；429 → rate_limit；5xx → timeout；
 *   其他非 2xx → invalid_payload；传输层失败（DNS/连接/超时/中止）→ timeout（暂时性、可重试）；
 *   响应不是数组 / 缺该币对 / 字段形状不对 → not_found / invalid_payload。
 *
 * 本模块**只被服务端编排层调用**（market-data.js），自动测试一律注入离线 fixture，不访问真实网络。
 */
'use strict';

const Contract = require('./contract');

const PROVIDER_ID = 'frankfurter';
const ENDPOINT = '/v2/providers/ecb/rates'; // D-036：pin ECB provider 端点
const BASE_URL = 'https://api.frankfurter.dev';
const TIMEOUT_MS = 8000;
const MAX_DECIMAL_SCALE = 8; // 与 Domain.parseDecimal 的定点上限一致

function errorFor(code, detail, subject) {
  return Contract.errorResult({ subject: subject || null, code: code, detail: detail });
}

function mapHttpStatus(status) {
  if (status === 401 || status === 403) return Contract.ERRORS.AUTH;
  if (status === 404) return Contract.ERRORS.NOT_FOUND;
  if (status === 429) return Contract.ERRORS.RATE_LIMIT;
  if (status >= 500) return Contract.ERRORS.TIMEOUT;
  return Contract.ERRORS.INVALID_PAYLOAD;
}

// 上游给的是 JSON number。汇率是账务事实（A-006：禁止二进制浮点承担账务），
// 因此只在能被"最短往返表示"还原为定点字符串时接受，否则判为不可入账（invalid_payload）。
function decimalOf(rate) {
  if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) return null;
  const s = String(rate);
  if (!Contract.isPositiveDecimalString(s)) return null;
  if (s.indexOf('e') !== -1 || s.indexOf('E') !== -1) return null;
  const dot = s.indexOf('.');
  if (dot !== -1 && s.length - dot - 1 > MAX_DECIMAL_SCALE) return null;
  return s;
}

function pairKeyOf(base, quote) {
  return base + '/' + quote;
}

// 按 base 分组：Frankfurter 一次请求只能给一个 base + 多个 quote。
function groupByBase(pairs) {
  const groups = {};
  pairs.forEach((p) => {
    if (!groups[p.base]) groups[p.base] = [];
    if (groups[p.base].indexOf(p.quote) === -1) groups[p.base].push(p.quote);
  });
  return groups;
}

function requestUrl(base, quotes) {
  return (
    BASE_URL +
    ENDPOINT +
    '?base=' +
    encodeURIComponent(base) +
    '&quotes=' +
    encodeURIComponent(quotes.join(','))
  );
}

async function fetchJson(url, options) {
  const opts = options || {};
  const doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, transport: true, detail: '运行时没有可用的 fetch' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow'
    });
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (status < 200 || status >= 300) {
      return { ok: false, transport: false, status: status };
    }
    let body;
    try {
      body = await res.json();
    } catch (e) {
      return { ok: false, transport: false, status: status, badBody: true };
    }
    return { ok: true, body: body };
  } catch (e) {
    // DNS 失败、连接被拒、超时中止等一律是"暂时不可达"，可重试。
    const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
    return { ok: false, transport: true, detail: aborted ? '请求超时' : '网络不可达' };
  } finally {
    clearTimeout(timer);
  }
}

// getFxRates(pairs, asOf, ctx, options) → Promise<Result[]>
//   pairs   ：{ base, quote }[]（先经契约序列化校验，非法整体拒绝）；
//   asOf    ：数据日上限（YYYY-MM-DD）。**绝不返回晚于 asOf 的数据**；晚于 asOf 视为 not_found；
//   ctx     ：{ now }，抓取时间必须带时区（由契约校验）；
//   options ：仅测试注入用（fetch / timeoutMs）。
async function getFxRates(pairs, asOf, ctx, options) {
  const req = Contract.serializeFxRequest(pairs);
  if (!req.ok) return [errorFor(Contract.ERRORS.INVALID_PAYLOAD, req.error.detail)];

  if (!Contract.isDateString(asOf)) {
    return [errorFor(Contract.ERRORS.INVALID_PAYLOAD, '缺少合法的数据日上限 asOf')];
  }
  const now = ctx && ctx.now;
  if (!Contract.isTimestamp(now)) {
    return [errorFor(Contract.ERRORS.INVALID_PAYLOAD, '缺少有效的抓取时间 ctx.now')];
  }

  const groups = groupByBase(req.pairs);
  const byPair = {};
  const bases = Object.keys(groups);

  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    const res = await fetchJson(requestUrl(base, groups[base]), options);
    if (!res.ok) {
      const code = res.transport ? Contract.ERRORS.TIMEOUT : mapHttpStatus(res.status);
      const detail = res.transport
        ? '汇率源暂时不可达（' + (res.detail || '网络错误') + '）'
        : res.badBody
          ? '汇率源返回了非 JSON 响应'
          : '汇率源返回 HTTP ' + res.status;
      // provider 级失败：所有请求到的币对都得到同一个错误码
      groups[base].forEach((quote) => {
        byPair[pairKeyOf(base, quote)] = errorFor(code, detail, pairKeyOf(base, quote));
      });
      continue;
    }
    if (!Array.isArray(res.body)) {
      groups[base].forEach((quote) => {
        byPair[pairKeyOf(base, quote)] = errorFor(
          Contract.ERRORS.INVALID_PAYLOAD,
          '汇率源响应不是数组',
          pairKeyOf(base, quote)
        );
      });
      continue;
    }
    groups[base].forEach((quote) => {
      const key = pairKeyOf(base, quote);
      const hit = res.body.filter(
        (r) => r && r.base === base && r.quote === quote
      )[0];
      if (!hit) {
        byPair[key] = errorFor(Contract.ERRORS.NOT_FOUND, '汇率源未覆盖该币对', key);
        return;
      }
      const rateDecimal = decimalOf(hit.rate);
      if (!rateDecimal) {
        byPair[key] = errorFor(Contract.ERRORS.INVALID_PAYLOAD, '汇率数值不可入账（非定点或超精度）', key);
        return;
      }
      if (!Contract.isDateString(hit.date)) {
        byPair[key] = errorFor(Contract.ERRORS.INVALID_PAYLOAD, '汇率源未给出合法数据日', key);
        return;
      }
      if (hit.date > asOf) {
        byPair[key] = errorFor(Contract.ERRORS.NOT_FOUND, '汇率源数据日晚于请求的数据日上限', key);
        return;
      }
      try {
        byPair[key] = Contract.fxResult({
          base: base,
          quote: quote,
          rateDecimal: rateDecimal,
          rateDate: hit.date,
          fetchedAt: now,
          provider: PROVIDER_ID
        });
      } catch (e) {
        byPair[key] = errorFor(Contract.ERRORS.INVALID_PAYLOAD, '汇率结果不满足契约形状', key);
      }
    });
  }

  return req.pairs.map((p) => byPair[pairKeyOf(p.base, p.quote)]);
}

// 供状态与证据展示使用：固定端点与版本，便于复核"到底 pin 了哪个端点"。
function describe() {
  return {
    id: PROVIDER_ID,
    endpoint: ENDPOINT,
    baseUrl: BASE_URL,
    timeoutMs: TIMEOUT_MS,
    sourceVersion: 'v2-providers-ecb',
    requiresKey: false
  };
}

module.exports = {
  PROVIDER_ID: PROVIDER_ID,
  ENDPOINT: ENDPOINT,
  BASE_URL: BASE_URL,
  describe: describe,
  getFxRates: getFxRates
};
