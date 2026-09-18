/* 小账本 server/market-data.js — 行情与汇率编排层（Phase 4D）
 *
 * 职责：把「取数（provider）→ 契约校验（contract.assertValidResult）→ 合并（Domain.planMarketMerge）
 * → 落库（repository）」串成一条可测试、可审计的链路，并处理失败兜底与有限重试。
 *
 * 硬边界（NEXT_AGENT / D-038 / D-044）：
 *   1. **自动行情抓取默认关闭**：D-038 门禁未通过时，quotes 作用域一律 skipped(auto_fetch_disabled)，
 *      不发起任何请求；行情继续以「手动补价 + 本地缓存」为唯一事实来源。
 *   2. 汇率侧只有一个通过门禁的源：Frankfurter pin ECB 端点（D-036）。
 *   3. 落库前必须经 contract.assertValidResult；不可入账的数据一律拒绝写入。
 *   4. 任何失败（超时/限额/缺标的/非法载荷/认证/传输错误）**不改动任何已有行**，只报告；
 *      "陈旧"由 Domain.MAX_STALE_DAYS 判定（quote_stale / fx_stale blocker），不靠写入时打标。
 *   5. provider 只收到公开代码/币对（D-020）；本模块返回的摘要里也不含账户名、余额、数量、成本。
 *   6. 无内部时钟：now / asOf 一律由调用方传入（AGENTS.md）。
 *
 * 结果形状：
 *   { ok, asOf, now, scopes: [ { scope, status, provider, endpoint, requested, updated,
 *                               skipped: [{subject, reason}], errors: [{subject, code, detail, retryable}],
 *                               attempts, items: [...] } ] }
 *   status ∈ updated | partial | failed | skipped
 */
'use strict';

const Contract = require('./providers/contract');
const Frankfurter = require('./providers/frankfurter');
const Domain = require('../js/domain.js');
const R = require('./repository');

// 有限重试次数：整批失败时最多再试 1 次（共 2 次尝试）。
const MAX_ATTEMPTS = 2;

function providerSubject(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.kind === 'fx' && r.base && r.quote) return r.base + '/' + r.quote;
  if (r.kind === 'quote' && r.symbol) return r.symbol;
  return r.subject == null ? null : r.subject;
}

// provider 调用的一次尝试。provider 抛异常（传输层问题）按"暂时性失败"记录为 timeout，
// 而不是让异常穿透到 HTTP 层变成 500 —— 外部不可达不是本地的程序缺陷。
async function callProvider(fetchFn, items, ctx) {
  try {
    const out = await fetchFn(items, ctx.asOf, ctx);
    if (!Array.isArray(out)) {
      return [Contract.errorResult({
        subject: null,
        code: Contract.ERRORS.INVALID_PAYLOAD,
        detail: 'provider 返回了非数组结果'
      })];
    }
    return out;
  } catch (e) {
    return [Contract.errorResult({
      subject: null,
      code: Contract.ERRORS.TIMEOUT,
      detail: 'provider 调用失败（按暂时性失败处理）'
    })];
  }
}

// 有限重试：**只在整批都失败、且至少一个错误可重试时**整批重试。
// 理由：部分成功时整批重发会重复消耗限额，并可能对已成功项造成第二次写入；
// 而"整批失败"意味着这一轮取数根本没成，重试不会引入重复事实。
async function fetchWithRetry(fetchFn, items, ctx, maxAttempts) {
  let attempts = 0;
  let results = [];
  while (attempts < maxAttempts) {
    attempts += 1;
    results = await callProvider(fetchFn, items, ctx);
    const allErrors = results.length > 0 && results.every((r) => r && r.kind === 'error');
    const retryable = results.some((r) => r && r.kind === 'error' && r.retryable === true);
    if (!allErrors || !retryable) break;
  }
  return { results: results, attempts: attempts };
}

function fxKey(value) {
  if (!value || !value.base || !value.quote) return null;
  return String(value.base) + '/' + String(value.quote);
}

function quoteKey(value) {
  if (!value) return null;
  if (value.kind === 'quote') return value.symbol || null;
  if (value.kind === 'error') return value.subject || null;
  return value.providerSymbol || null;
}

function resultKey(result, kind) {
  if (!result || typeof result !== 'object') return null;
  if (result.kind === 'error') return result.subject || null;
  return kind === 'fx' ? fxKey(result) : quoteKey(result);
}

function requestSubject(item, kind) {
  return kind === 'fx' ? fxKey(item) : quoteKey(item);
}

function uniqueRequests(items, kind) {
  const out = [];
  const seen = new Set();
  (items || []).forEach((item) => {
    const key = requestSubject(item, kind);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out;
}

function requestError(subject, detail, code) {
  return Contract.errorResult({
    subject: subject,
    code: code || Contract.ERRORS.INVALID_PAYLOAD,
    detail: detail
  });
}

// 把 provider 的批量返回严格对齐到请求键：每个请求目标最终恰好得到一个成功、跳过或错误。
// 这样既不会把未请求结果写进库，也不会把漏返回伪装成成功；调用方还能稳定满足
// requested = updated + skipped + errors（4D 独立复核）。
function reconcileResults(requests, results, options) {
  const opts = options || {};
  const kind = opts.kind;
  const asOf = opts.asOf;
  const wanted = uniqueRequests(requests, kind);
  const wantedKeys = new Set(wanted.map((item) => requestSubject(item, kind)));
  const failAll = (detail, code) => wanted.map((item) =>
    requestError(requestSubject(item, kind), detail, code)
  );

  const valid = [];
  for (const result of results || []) {
    try {
      Contract.assertValidResult(result);
      valid.push(result);
    } catch (_) {
      return failAll('provider 返回了不满足契约的结果，整批已拒绝写入');
    }
  }

  // subject 为空表示整批级错误（如传输失败）。为每个请求目标复制一份错误，避免
  // requested=2、errors=1 这种“少结算一个目标”的假成功报告。
  const globalError = valid.find((result) => result.kind === 'error' && !result.subject);
  if (globalError) {
    return wanted.map((item) => requestError(
      requestSubject(item, kind),
      globalError.detail,
      globalError.code
    ));
  }

  const groups = new Map();
  let hasUnexpected = false;
  valid.forEach((result) => {
    const key = resultKey(result, kind);
    if (!key || !wantedKeys.has(key)) {
      hasUnexpected = true;
      return;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  });
  if (hasUnexpected) {
    return failAll('provider 返回了未请求或无法绑定的结果，整批已拒绝写入');
  }

  return wanted.map((item) => {
    const subject = requestSubject(item, kind);
    const matches = groups.get(subject) || [];
    if (matches.length === 0) {
      return requestError(subject, 'provider 未返回该请求目标');
    }
    if (matches.length > 1) {
      return requestError(subject, 'provider 对同一请求目标返回了重复结果');
    }
    const result = matches[0];
    if (result.kind === kind) {
      const dataDate = kind === 'fx' ? result.rateDate : result.priceDate;
      if (dataDate > asOf) {
        return requestError(subject, 'provider 数据日晚于 asOf，已拒绝写入');
      }
    }
    return result;
  });
}

// 逐条结果的处理：先过契约校验（不合格一律拒绝写入），再交给 apply 落库。
function applyResults(results, apply) {
  const errors = [];
  const skipped = [];
  const items = [];
  results.forEach((r) => {
    let valid = true;
    try {
      Contract.assertValidResult(r);
    } catch (e) {
      valid = false;
    }
    if (!valid) {
      errors.push({
        subject: providerSubject(r),
        code: Contract.ERRORS.INVALID_PAYLOAD,
        detail: '结果不满足 provider 契约形状，已拒绝写入',
        retryable: false
      });
      return;
    }
    if (r.kind === 'error') {
      errors.push({ subject: r.subject, code: r.code, detail: r.detail, retryable: r.retryable });
      return;
    }
    let outcome;
    try {
      outcome = apply(r);
    } catch (e) {
      errors.push({
        subject: providerSubject(r),
        code: (e && e.code) || Contract.ERRORS.INVALID_PAYLOAD,
        detail: (e && e.message) || '写入被拒绝',
        retryable: false
      });
      return;
    }
    if (outcome && outcome.status === 'updated') {
      items.push(outcome.item);
    } else {
      skipped.push({
        subject: providerSubject(r),
        reason: (outcome && outcome.reason) || 'skipped'
      });
    }
  });
  return { errors: errors, skipped: skipped, items: items };
}

function scopeStatus(requested, updated, skippedCount, errorCount) {
  if (requested === 0) return 'skipped';
  if (errorCount > 0 && updated === 0 && skippedCount === 0) return 'failed';
  if (errorCount > 0) return 'partial';
  if (updated === 0) return 'skipped';
  return 'updated';
}

function scopeSummary(spec, requested, applied, attempts, skippedReason) {
  const status = scopeStatus(requested, applied.items.length, applied.skipped.length, applied.errors.length);
  const skipReasons = Array.from(new Set(applied.skipped.map((row) => row.reason).filter(Boolean)));
  let reason = null;
  if (status === 'skipped') {
    if (skippedReason) reason = skippedReason;
    else if (requested === 0) reason = 'no_targets';
    else if (skipReasons.length === 1) reason = skipReasons[0];
    else reason = 'skipped';
  }
  // provider/endpoint 以**实际写入的行**为准（注入离线 provider 时不能冒充 Frankfurter）；
  // 没有写入行时回退到这一轮声明的 provider。
  const itemProvider = applied.items.length ? applied.items[0].provider : null;
  return {
    scope: spec.scope,
    status: status,
    provider: itemProvider || spec.provider || null,
    endpoint: spec.endpoint || null,
    asOf: spec.asOf,
    requested: requested,
    updated: applied.items.length,
    skipped: applied.skipped,
    errors: applied.errors,
    attempts: attempts,
    reason: reason,
    items: applied.items
  };
}

function emptyScope(spec, subjects, reason) {
  const list = Array.isArray(subjects) ? subjects : [];
  return {
    scope: spec.scope,
    status: 'skipped',
    provider: spec.provider || null,
    endpoint: spec.endpoint || null,
    asOf: spec.asOf,
    requested: list.length,
    updated: 0,
    skipped: list.map((subject) => ({ subject: subject, reason: reason })),
    errors: [],
    attempts: 0,
    reason: reason,
    items: []
  };
}

/* ------------------------------ 作用域：汇率 ------------------------------ */

// 汇率自动更新（D-036）：唯一通过 D-038 门禁的源。
async function refreshFxScope(db, options) {
  const opts = options || {};
  const spec = {
    scope: 'fx',
    provider: opts.providerId || null,
    endpoint: opts.endpoint || null,
    asOf: opts.asOf
  };
  const pairs = uniqueRequests(Array.isArray(opts.pairs) ? opts.pairs : [], 'fx');
  const subjects = pairs.map((pair) => fxKey(pair));
  if (!pairs.length) return emptyScope(spec, [], 'no_targets');
  if (typeof opts.fetchFn !== 'function') {
    // 没有可用的 provider（例如用户关掉了自动更新，或该作用域尚未配置 provider）。
    return emptyScope(spec, subjects, opts.disabledReason || 'provider_not_configured');
  }

  const fetched = await fetchWithRetry(opts.fetchFn, pairs, { now: opts.now, asOf: opts.asOf }, MAX_ATTEMPTS);
  const reconciled = reconcileResults(pairs, fetched.results, { kind: 'fx', asOf: opts.asOf });
  const applied = applyResults(reconciled, (r) =>
    R.upsertProviderFxRate(
      db,
      {
        base: r.base,
        quote: r.quote,
        rateDecimal: r.rateDecimal,
        rateDate: r.rateDate,
        fetchedAt: r.fetchedAt,
        provider: r.provider,
        status: 'ok'
      },
      { now: opts.now }
    )
  );
  return scopeSummary(spec, pairs.length, applied, fetched.attempts, null);
}

/* ------------------------------ 作用域：报价 ------------------------------ */

// 报价自动更新：**默认关闭**（D-038 门禁未通过）。
// 即便调用方显式打开，也必须先注入一个真实 provider；否则返回 provider_not_configured。
async function refreshQuotesScope(db, options) {
  const opts = options || {};
  const spec = {
    scope: 'quotes',
    provider: opts.providerId || null,
    endpoint: opts.endpoint || null,
    asOf: opts.asOf
  };
  const targets = uniqueRequests(Array.isArray(opts.targets) ? opts.targets : [], 'quotes');
  const subjects = targets.map((target) => target.providerSymbol);
  if (!opts.autoEnabled) return emptyScope(spec, subjects, 'auto_fetch_disabled');
  if (!targets.length) return emptyScope(spec, [], 'no_targets');
  if (typeof opts.fetchFn !== 'function') return emptyScope(spec, subjects, 'provider_not_configured');

  const symbols = targets.map((t) => t.providerSymbol);
  const byProviderSymbol = {};
  targets.forEach((t) => {
    byProviderSymbol[t.providerSymbol] = t;
  });

  const fetched = await fetchWithRetry(opts.fetchFn, symbols, { now: opts.now, asOf: opts.asOf }, MAX_ATTEMPTS);
  const reconciled = reconcileResults(targets, fetched.results, { kind: 'quote', asOf: opts.asOf });
  const applied = applyResults(reconciled, (r) => {
    const target = byProviderSymbol[r.symbol];
    if (!target) {
      throw Object.assign(new Error('provider 返回了未请求的标的，已拒绝写入'), {
        code: Contract.ERRORS.INVALID_PAYLOAD
      });
    }
    return R.upsertProviderQuote(
      db,
      {
        instrumentId: target.instrumentId,
        priceMinor: r.priceMinor,
        currency: r.currency,
        priceDate: r.priceDate,
        fetchedAt: r.fetchedAt,
        provider: r.provider,
        status: 'ok',
        // 原始代码：provider 侧的原形（D-044 追溯要求），与本地 symbol 可能不同形
        sourceSymbol: r.symbol
      },
      { now: opts.now }
    );
  });
  return scopeSummary(spec, targets.length, applied, fetched.attempts, null);
}

/* ------------------------------ 目标推导 ------------------------------ */

// 从当前事实推导更新目标（不猜测"用户可能想看什么"）：
//   汇率：账上出现过的非 CNY 币种 → 对 CNY；外加已登记过的币对原方向。
//   报价：有持仓事实（期初/证券事件）或已有报价的标的。
// providerSymbol 的映射规则：本地 symbol + exchange 拼成公开代码形状（如 0700 + HKEX → 0700.HK）。
// 这是"请求产物只允许公开代码"的具体化，且**只**用在自动抓取开启时。
function symbolForProvider(instrument) {
  const symbol = instrument && instrument.symbol ? String(instrument.symbol) : '';
  const exchange = instrument && instrument.exchange ? String(instrument.exchange).toUpperCase() : '';
  if (!symbol) return null;
  if (symbol.indexOf('.') !== -1) return symbol; // 已经是带市场后缀的公开代码
  if (exchange === 'HKEX') return symbol + '.HK';
  if (exchange === 'SSE' || exchange === 'SZSE') return symbol + '.SS';
  return symbol;
}

function marketDataTargets(db) {
  const state = R.readState(db);
  const assets = (state && state.assets) || {};
  const pairs = Domain.requiredFxPairs(assets);
  const instrumentById = {};
  (assets.instruments || []).forEach((i) => {
    if (i && i.id) instrumentById[i.id] = i;
  });
  const targets = [];
  Domain.requiredQuoteSymbols(assets).forEach((t) => {
    const providerSymbol = symbolForProvider(instrumentById[t.instrumentId] || t);
    if (!providerSymbol) return;
    targets.push({
      instrumentId: t.instrumentId,
      symbol: t.symbol,
      exchange: t.exchange,
      providerSymbol: providerSymbol
    });
  });
  return { pairs: pairs, quoteTargets: targets };
}

/* ------------------------------ 编排入口 ------------------------------ */

const SCOPES = Domain.MARKET_SCOPES; // ['fx', 'quotes']

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) return SCOPES.slice();
  const out = [];
  scopes.forEach((s) => {
    if (SCOPES.indexOf(s) !== -1 && out.indexOf(s) === -1) out.push(s);
  });
  return out;
}

// refreshMarketData(options) → Promise<summary>
//   options: { db, now, asOf, scopes, autoQuotesEnabled, fxDisabled, pairs, quoteTargets,
//              fxFetch, quotesFetch, fxProviderId, fxEndpoint, quotesProviderId, quotesEndpoint }
async function refreshMarketData(options) {
  const opts = options || {};
  const db = opts.db;
  if (!db) throw new Error('refreshMarketData 需要 db');
  if (!Contract.isTimestamp(opts.now)) throw new Error('refreshMarketData 需要带时区的 now');
  if (!Contract.isDateString(opts.asOf)) throw new Error('refreshMarketData 需要 YYYY-MM-DD 的 asOf');

  const requested = normalizeScopes(opts.scopes);
  const derived = marketDataTargets(db);
  const pairs = Array.isArray(opts.pairs) ? opts.pairs : derived.pairs;
  const quoteTargets = Array.isArray(opts.quoteTargets) ? opts.quoteTargets : derived.quoteTargets;

  const scopes = [];
  // 只有走真实 provider 时才声明 Frankfurter 的端点（注入离线 provider 时不得冒充）。
  const usingRealFx = !opts.fxFetch;
  for (let i = 0; i < requested.length; i++) {
    const name = requested[i];
    if (name === 'fx') {
      scopes.push(
        await refreshFxScope(db, {
          asOf: opts.asOf,
          now: opts.now,
          pairs: pairs,
          fetchFn: opts.fxDisabled ? null : opts.fxFetch || Frankfurter.getFxRates,
          disabledReason: opts.fxDisabled ? 'auto_fetch_disabled' : 'provider_not_configured',
          providerId: opts.fxProviderId || (usingRealFx ? Frankfurter.PROVIDER_ID : null),
          endpoint: opts.fxEndpoint || (usingRealFx ? Frankfurter.ENDPOINT : null)
        })
      );
    } else if (name === 'quotes') {
      scopes.push(
        await refreshQuotesScope(db, {
          asOf: opts.asOf,
          now: opts.now,
          targets: quoteTargets,
          autoEnabled: opts.autoQuotesEnabled === true,
          fetchFn: opts.quotesFetch || null,
          providerId: opts.quotesProviderId,
          endpoint: opts.quotesEndpoint
        })
      );
    }
  }

  const ok = scopes.every((s) => s.status === 'updated' || s.status === 'skipped');
  return {
    ok: ok,
    asOf: opts.asOf,
    now: opts.now,
    scopeOrder: requested,
    scopes: scopes
  };
}

module.exports = {
  MAX_ATTEMPTS: MAX_ATTEMPTS,
  SCOPES: SCOPES,
  normalizeScopes: normalizeScopes,
  marketDataTargets: marketDataTargets,
  symbolForProvider: symbolForProvider,
  reconcileResults: reconcileResults,
  refreshMarketData: refreshMarketData,
  // 供测试单独驱动某一路径
  refreshFxScope: refreshFxScope,
  refreshQuotesScope: refreshQuotesScope
};
