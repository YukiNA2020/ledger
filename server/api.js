/* 小账本 server/api.js — 本地服务 HTTP 层（Phase 2）
 *
 * 依据 ARCHITECTURE §4.2 / §5.6 / §8：
 *   - 只提供版本化 /api/v1 接口，并托管静态前端；
 *   - 本地 HTTP 服务只监听 loopback，并用随机 session token 防止其他本机网页跨站调用写接口；
 *   - 写接口校验 Origin、Content-Type 和 session token；
 *   - 不返回任何 CORS 头，也不处理预检，跨源页面既发不出写请求也读不到响应；
 *   - 错误响应包含稳定错误码、用户可读信息与是否可重试（§5.6）。
 *
 * 隐私：日志只记录方法、路径、状态码与耗时，绝不记录请求体或财务数据。
 * 领域逻辑不复制：overview 直接复用前端同一份 js/domain.js（DECISIONS T-001）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dbm = require('./db');
const R = require('./repository');
const Recommendations = require('./recommendations');
const Decisions = require('./decisions');
const backupLib = require('./backup');
const keychain = require('./keychain');
const migrations = require('./migrations');
const Catalog = require('./instrument-catalog');
// Phase 4B 的标的检索/元数据 provider 固定为离线 fixture（不发真实网络）。
// 真实行情源要等 4D 通过 D-038 门禁后才允许接入；届时这里换成真实 provider 即可，
// 上层的 catalog 模块与前端不需要改。
const FixtureProvider = require('./providers/fixture');
const FrankfurterProvider = require('./providers/frankfurter');
const ProviderContract = require('./providers/contract');
const KeychainKey = require('./providers/keychain-key');
const MarketData = require('./market-data');
const Domain = require('../js/domain.js');
const Core = require('../js/core.js');
// 5E-5（D-052）：新建议在 gate 区封存生成时的知识卡解释版本；与前端同一份静态目录。
const Knowledge = require('../js/knowledge.js');

const API_PREFIX = '/api/v1';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const TOKEN_HEADER = 'x-ledger-token';
const TOKEN_PLACEHOLDER = '__LEDGER_SESSION_TOKEN__';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

// 后续阶段拥有的写接口：URL 资源边界保持稳定，但实现留给对应阶段。
// Phase 3 已实现：institutions / accounts / account-units / asset-transfers / liabilities / entitlements
// 与 monthly-closes（ROADMAP Phase 3 工作项 1–6）。
// Phase 4C 已实现：portfolio-openings / security-events（D-042）。
// Phase 4D 已实现：quotes（手动补价）与 market-data/refresh（汇率自动更新；行情自动抓取受 D-038 门禁，
// 默认关闭 → 该作用域返回 200 + skipped(auto_fetch_disabled)，不发起任何请求）。
// Phase 5B 已实现：risk-assessments（追加式风险评估写入 + 只读查询，D-047）。
// 注意：本表已不含 market-data/refresh —— 它在 4D 被实现，不再是"留给后续阶段"的占位。
// Phase 5D 已实现：recommendations（不可变建议产物 + 正式建议门禁，D-049）。
// 注意：本表已不含 POST /api/v1/recommendations —— 它在 5D 被实现，不再是"留给后续阶段"的占位。
const DEFERRED_WRITES = {};

/* ------------------------------ 校验 ------------------------------ */

const POOLS = ['safety', 'investable', 'restricted', 'entitlement'];
const INSTITUTION_KINDS = ['bank', 'broker', 'government', 'other'];

function newResourceId(prefix) {
  return prefix + '-' + crypto.randomBytes(8).toString('hex');
}

function isYm(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

// 金额：null（无明确余额）或非负安全整数（最小货币单位）
function validMinor(v) {
  return v == null || (Number.isSafeInteger(v) && v >= 0);
}

function lastDayOfMonth(ym) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return localDateStr(new Date(y, m, 0));
}

// 应急金覆盖的交易依据（D-034）：结账月份及其前两个完整自然月的必要支出（分）。
// 复用浏览器同一份 js/core.js（D-025）——服务端不另写一套聚合，否则覆盖月数会与
// 决策台显示的口径分叉。交易为密文（应用锁）时 available=false，绝不虚构金额。
function necessaryBasisFromState(state, month) {
  const months = [];
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  for (let i = 2; i >= 0; i -= 1) {
    const d = new Date(y, m - 1 - i, 1);
    months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }
  const txns = Array.isArray(state.txns) ? state.txns : null;
  if (!txns) {
    return {
      available: false,
      reason: 'txns_encrypted',
      months: months,
      monthlyMinor: {},
      counted: 0,
      avgNecessaryMinor: null
    };
  }
  const categories = Array.isArray(state.categories) ? state.categories : [];
  const monthlyMinor = {};
  let total = 0;
  let counted = 0;
  months.forEach((ym) => {
    const agg = Core.aggregate(txns, {
      year: Number(ym.slice(0, 4)),
      month: Number(ym.slice(5, 7)),
      categories: categories
    });
    const need = agg && Number.isFinite(agg.need) && agg.need > 0 ? agg.need : 0;
    monthlyMinor[ym] = need;
    if (need > 0) {
      total += need;
      counted += 1;
    }
  });
  return {
    available: true,
    reason: counted ? null : 'no_necessary_expense',
    months: months,
    monthlyMinor: monthlyMinor,
    counted: counted,
    avgNecessaryMinor: counted ? Math.round(total / counted) : null
  };
}

function validateResourcePayload(body, spec) {
  // spec: [{key, required, kind: 'name'|'currency'|'pool'|'minor'|'date'|'kind', code}]
  const out = {};
  for (const rule of spec) {
    const raw = body ? body[rule.key] : undefined;
    if (rule.kind === 'name') {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (!s) return { error: rule.code || 'invalid_name' };
      if (s.length > 120) return { error: 'invalid_name' };
      out[rule.key] = s;
    } else if (rule.kind === 'currency') {
      if (raw != null && Domain.CURRENCIES.indexOf(raw) === -1) return { error: rule.code || 'invalid_currency' };
      out[rule.key] = raw == null ? 'CNY' : raw;
    } else if (rule.kind === 'pool') {
      if (raw != null && POOLS.indexOf(raw) === -1) return { error: rule.code || 'invalid_pool' };
      out[rule.key] = raw == null ? 'safety' : raw;
    } else if (rule.kind === 'minor') {
      if (!validMinor(raw)) return { error: rule.code || 'invalid_amount' };
      out[rule.key] = raw == null ? null : raw;
    } else if (rule.kind === 'date') {
      if (raw != null && !isDateStr(raw)) return { error: rule.code || 'invalid_date' };
      out[rule.key] = raw == null ? null : raw;
    } else if (rule.kind === 'institutionKind') {
      if (raw != null && INSTITUTION_KINDS.indexOf(raw) === -1) return { error: rule.code || 'invalid_kind' };
      out[rule.key] = raw == null ? 'other' : raw;
    } else if (rule.kind === 'decimal') {
      // 定点十进制（如汇率）：必须是正数的十进制字符串，不接受浮点或科学计数法。
      // 注意 Domain.parseDecimal 返回定点对象 {v, s}，判正要看 v。
      const s = raw == null ? '' : String(raw).trim();
      const v = Domain.parseDecimal(s);
      if (!v || !(v.v > 0)) return { error: rule.code || 'invalid_decimal' };
      out[rule.key] = s;
    } else if (rule.kind === 'text') {
      // 可选的有界文本：空串与缺省都归一为 null，超长直接拒绝
      const s = raw == null ? '' : String(raw).trim();
      if (s.length > 120) return { error: rule.code || 'invalid_text' };
      out[rule.key] = s || null;
    } else {
      out[rule.key] = raw == null ? null : raw;
    }
  }
  return { value: out };
}

/* ------------------------------ 基础工具 ------------------------------ */

function localDateStr(now) {
  const d = now instanceof Date ? now : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload == null ? null : payload);
  const headers = Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  res.end(body);
}

function fail(res, status, code, message, retryable) {
  sendJson(res, status, { error: { code: code, message: message, retryable: !!retryable } });
}

/* ---------------------- 标的目录（Phase 4B）错误映射 ---------------------- */

// catalog 模块只返回稳定错误码，HTTP 状态由这里集中决定（ARCHITECTURE §5.6）。
const CATALOG_ERROR_STATUS = {
  invalid_query: 400,
  invalid_symbol: 400,
  invalid_source: 400,
  invalid_id: 400,
  client_id_forbidden: 400,
  invalid_currency: 400,
  invalid_exchange: 400,
  invalid_name: 400,
  invalid_instrument_type: 400,
  invalid_country: 400,
  invalid_asset_class: 400,
  invalid_exposure_market: 400,
  invalid_tracking_index: 400,
  currency_mismatch: 400,
  exchange_mismatch: 400,
  instrument_not_found: 404,
  duplicate_instrument: 409,
  ambiguous_instrument: 409,
  invalid_provider_payload: 422,
  provider_unavailable: 503,
  internal_error: 500
};

// 领域层错误码 → HTTP 状态（handler 抛错时的集中映射）。
// 关键：仓储层的重复/歧义是**客户端可修正**的冲突，不能像未预期异常那样报 500 —— 前端要能
// 区分"这次写入被拒绝了，数据没动"和"服务端出错了"。未知码一律 500。
const DOMAIN_ERROR_STATUS = {
  invalid_json: 400,
  invalid_state: 400,
  invalid_assets: 400,
  invalid_asset_collection: 400,
  invalid_id: 400,
  invalid_symbol: 400,
  invalid_instrument: 400,
  invalid_currency: 400,
  invalid_exchange: 400,
  invalid_classification_status: 400,
  invalid_asset_class: 400,
  invalid_exposure_market: 400,
  invalid_event: 400,
  invalid_event_type: 400,
  invalid_event_date: 400,
  invalid_event_amount: 400,
  invalid_quantity: 400,
  invalid_opening: 400,
  invalid_amount: 400,
  invalid_date: 400,
  // 全量写入路径（PUT /state / 恢复）的 catch 只查本表：期初/事件校验可能抛出的
  // 未知引用码也必须归位 4xx，否则"引用了不存在账户"会被误报成 500（G4C-3 连带）
  unknown_account: 422,
  unknown_instrument: 422,
  invalid_account_type: 422,
  payload_too_large: 413,
  duplicate_instrument: 409,
  ambiguous_instrument: 409,
  duplicate_event: 409,
  duplicate_opening: 409,
  idempotency_conflict: 409,
  insufficient_holdings: 409,
  // Phase 4D：报价与行情写入路径新增的错误码。规则同样是"客户端可修正 → 4xx，
  // 服务端出错 → 5xx"——`invalid_price`/`invalid_price_date` 是载荷问题（400），
  // `currency_mismatch` 是"载荷与既有事实冲突、需要改请求"（422），
  // 自动更新不覆盖手动值不是错误（返回 200 + skipped），所以这里没有对应条目。
  invalid_quote: 400,
  invalid_instrument_id: 400,
  invalid_price: 400,
  invalid_price_date: 400,
  invalid_fx: 400,
  invalid_provider: 400,
  currency_mismatch: 422,
  // Phase 5B（D-047）：风险评估写路径。5A 冻结的稳定错误码在这里获得唯一一份 HTTP 映射，
  // 页面与 API 客户端不另写第二套判断（不变量 3）；全部属"客户端可修正" → 4xx。
  invalid_answers: 400,
  unknown_question: 400,
  unknown_option: 400,
  duplicate_answer: 400,
  missing_answer: 400,
  invalid_assessment_date: 400,
  invalid_reassess_reason: 400,
  invalid_rule_version: 400,
  duplicate_assessment: 409,
  // Phase 5C（D-048）：目标版本与认可标的映射的写入路径。规则同 5B ——
  // 「载荷形状/日期不合法」400，「与既有事实冲突且客户端可修正」409/422，
  // 只有服务端自己算不出来的（invalid_valuation_input）才是 5xx。
  invalid_target_template: 400,
  invalid_proportion: 400,
  invalid_approved_instruments: 400,
  invalid_target_payload: 400,
  invalid_target_record: 400,
  invalid_effective_date: 400,
  invalid_mapping_payload: 400,
  duplicate_mapping: 400,
  assessment_expired: 409,
  no_valid_assessment: 409,
  invalid_assessment_records: 409,
  duplicate_target: 409,
  instrument_already_mapped: 409,
  class_mismatch: 422,
  invalid_assessment_ref: 422,
  classification_unconfirmed: 422,
  invalid_valuation_input: 500,
  // Phase 5D（D-049）：建议写入口的载荷问题 400、引用不存在 409、「同一输入已有另一条产物」409；
  // invalid_recommendation_output 只可能是服务端自己算错 → 500。
  // 门禁不满足（行情过期 / 月结非正式 / 快照哈希不符…）**不是 HTTP 错误**：
  // 响应仍是 200 + status:'estimate' + formalRecommendation:null，页面才能同时给出估算与待办。
  invalid_new_funds_request: 400,
  invalid_new_funds: 400,
  recommendation_amount_overflow: 422,
  unknown_close: 409,
  unknown_snapshot: 409,
  unknown_target: 409,
  unknown_assessment: 409,
  no_target: 409,
  snapshot_hash_mismatch: 409,
  close_not_formal: 409,
  target_assessment_mismatch: 409,
  invalid_recommendation_record: 400,
  invalid_recommendation_output: 500,
  duplicate_recommendation: 409,
  // Phase 6B（D-057）：决策状态机写路径。载荷形状 / note 缺失 400、未知引用按
  // 「路径资源 404、载荷引用 422」分口径、状态与冲突 409 —— 全部是客户端可修正的 4xx；
  // 服务端算不出的仍是 5xx（沿用 invalid_valuation_input）。
  invalid_decision_payload: 400,
  deviation_note_required: 400,
  invalid_decision_record: 400,
  unknown_decision: 404,
  illegal_transition: 409,
  recommendation_not_formal: 409,
  recommendation_stale: 409,
  no_linked_events: 409,
  has_linked_events: 409,
  event_already_linked: 409,
  link_not_active: 409,
  illegal_state_for_link: 409,
  invalid_link_target: 409,
  linked_event_missing: 409,
  unknown_recommendation: 422,
  unknown_security_event: 422
};

// 幂等键必须绑定“同一路径的同一份请求语义”，不能让同一个 key 悄悄吞掉另一笔事件。
// 对象键排序后再哈希，避免 JSON 字段顺序不同被误判为不同请求。
// 规范化与 sha256 口径唯一取自仓储（建议产物的 payload_hash 用同一份，D-025）。
function canonicalJson(value) {
  return R.canonicalJson(value);
}

function requestFingerprint(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function catalogFail(res, result) {
  const status = CATALOG_ERROR_STATUS[result.code] || 500;
  return fail(res, status, result.code, result.message || '标的目录操作失败', !!result.retryable);
}

// provider 需要抓取时间：生产环境用真实当前时间（带时区），测试可用 ctx.providerNow 注入固定时间。
function providerCtx(ctx) {
  return { now: typeof ctx.providerNow === 'function' ? ctx.providerNow() : new Date().toISOString() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'invalid_json' }));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

/* ------------------------------ 路由 ------------------------------ */

function createHandler(ctx) {
  const api = {};

  api['GET /api/v1/health'] = (req, res) => {
    sendJson(res, 200, {
      ok: true,
      app: 'ledger',
      layer: 'local-service',
      schemaVersion: migrations.currentVersion(ctx.db),
      latestSchemaVersion: migrations.LATEST_VERSION,
      policy: {
        host: ctx.host,
        port: ctx.port,
        factSource: 'sqlite',
        writesRequireToken: true,
        cors: 'disabled',
        cloudAi: false
      },
      startedAt: ctx.startedAt
    });
  };

  api['GET /api/v1/state'] = (req, res) => {
    try {
      const state = R.readState(ctx.db);
      sendJson(res, 200, state, { 'X-Ledger-Schema': String(migrations.currentVersion(ctx.db)) });
    } catch (err) {
      return upsertFailDispatcher(err, res);
    }
  };

  api['PUT /api/v1/state'] = async (req, res) => {
    const body = await readBody(req);
    const bodyWrapsState = body && typeof body === 'object' && !Array.isArray(body) &&
      Object.prototype.hasOwnProperty.call(body, 'state');
    const state = bodyWrapsState ? body.state : body;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return fail(res, 400, 'invalid_state', 'state 必须是对象', false);
    }
    // 幂等键：同一 Idempotency-Key 重复提交直接返回首次结果（§5.6）
    const idemKey = req.headers['idempotency-key'];
    if (idemKey) {
      const cached = R.findIdempotent(ctx.db, String(idemKey), 'PUT', '/api/v1/state');
      if (cached) return sendJson(res, 200, cached, { 'X-Ledger-Idempotent': 'replay' });
    }
    // 高风险覆盖写入（如前端 JSON 恢复）：先把当前数据强制备份一份再覆盖。
    // 与写后节流备份（createBackupAfterWrite）不同，这条路径不受 60 秒节流限制，
    // 否则恢复前 60 秒内刚写过数据时，被覆盖的版本将无备份可回滚（S3 修复）。
    let preImport = null;
    if (body && body.forceBackup === true) {
      try {
        preImport = await backupLib.createBackup(ctx.db, ctx.paths, { reason: 'pre-import' });
      } catch (err) {
        return fail(
          res,
          503,
          'backup_failed',
          '覆盖前备份失败，已中止写入：' + (err && err.message ? err.message : String(err)),
          true
        );
      }
    }
    // 页面五键保存不表达删除追加式事实。由仓储在同一个 SQLite 事务里读取并保留
    // 调用方未显式给出的集合，避免客户端 GET→PUT 之间的并发新增被旧快照覆盖。
    // 未携带该显式标志时仍保持历史「缺键即清空」语义，供旧备份完整恢复使用。
    R.writeState(ctx.db, state, {
      preserveMissingCompanionCollections: bodyWrapsState && body.preserveCompanionCollections === true
    });
    let backup = null;
    try {
      backup = await backupLib.createBackupAfterWrite(ctx.db, ctx.paths, {
        minIntervalMs: ctx.backupMinIntervalMs
      });
    } catch (err) {
      // backup_failed：不阻止本次写入结果，但必须作为可见状态返回并提示修复（§10）
      ctx.logger.warn('写后备份失败：' + (err && err.message ? err.message : String(err)));
      backup = { created: false, reason: 'failed', error: err && err.message ? err.message : String(err) };
    }
    const payload = {
      ok: true,
      schemaVersion: migrations.currentVersion(ctx.db),
      backup: backup,
      preImportBackup: preImport ? preImport.name : null
    };
    if (idemKey) R.rememberIdempotent(ctx.db, String(idemKey), 'PUT', '/api/v1/state', payload);
    sendJson(res, 200, payload);
  };

  api['DELETE /api/v1/state'] = async (req, res) => {
    // 清空属于高风险批量操作：先做一次可恢复备份（AGENTS.md 外部写入与高风险操作）
    let pre = null;
    try {
      pre = await backupLib.createBackup(ctx.db, ctx.paths, { reason: 'pre-clear' });
    } catch (err) {
      return fail(
        res,
        503,
        'backup_failed',
        '清空前备份失败，已中止清空：' + (err && err.message ? err.message : String(err)),
        true
      );
    }
    R.clearAll(ctx.db);
    sendJson(res, 200, { ok: true, preClearBackup: pre.name });
  };

  api['GET /api/v1/overview'] = (req, res) => {
    const state = R.readState(ctx.db);
    // 判定日与其余端点同一口径：ctx.today 可注入（测试固定时钟），否则取服务端本地日。
    // 5E-6 发现：此处曾直用 localDateStr()，注入时钟时与 /targets/current 的 blocker 集合错位。
    const asOf = isDateStr(req.query.asOf)
      ? req.query.asOf
      : (typeof ctx.today === 'function' ? ctx.today() : localDateStr());
    const overview = Domain.computeOverview(state.assets, {
      now: asOf,
      settings: state.settings || {}
    });
    sendJson(res, 200, overview);
  };

  api['GET /api/v1/institutions'] = (req, res) => {
    sendJson(res, 200, { items: R.readInstitutionList(ctx.db) });
  };
  api['GET /api/v1/accounts'] = (req, res) => {
    sendJson(res, 200, { items: R.readAssetAccounts(ctx.db) });
  };
  api['GET /api/v1/account-units'] = (req, res) => {
    sendJson(res, 200, { items: R.readAssetUnits(ctx.db) });
  };
  api['GET /api/v1/asset-transfers'] = (req, res) => {
    sendJson(res, 200, { items: R.readAssetTransfers(ctx.db) });
  };
  api['GET /api/v1/liabilities'] = (req, res) => {
    sendJson(res, 200, { items: R.readLiabilities(ctx.db) });
  };
  api['GET /api/v1/entitlements'] = (req, res) => {
    sendJson(res, 200, { items: R.readEntitlements(ctx.db) });
  };

  /* ------------------------- Phase 3：资产资源写入 ------------------------- */
  // 单条 upsert：资源录入页逐条编辑用；id 缺省时服务端生成。
  // 校验（api 层）+ 领域校验（repository 层）都在 transaction 内完成（§5.6）。

  function upsertFail(res, err) {
    const code = (err && err.code) || 'internal_error';
    // 状态码集中归位：未知引用 422、客户端可修正的冲突 409（DOMAIN_ERROR_STATUS）、
    // 其余领域校验 400、未预期异常 500 —— 前端必须能区分"写入被拒"和"服务出错"。
    let status;
    if (code === 'unknown_account' || code === 'unknown_unit' || code === 'unknown_instrument') {
      status = 422;
    } else if (code === 'internal_error' || /^(?:ERR_)?SQLITE_/.test(code)) {
      // SQLite 约束/执行错误与无 code 的编程异常属于未预期服务端失败，
      // 不能伪装成“请求字段不合法”，也不能把底层错误码/SQL 细节回显给客户端。
      return fail(res, 500, 'internal_error', '写入失败', false);
    } else {
      // 历史领域错误（如 same_unit / same_currency）尚未全部进入集中表，仍按 400 兼容。
      status = DOMAIN_ERROR_STATUS[code] || 400;
    }
    return fail(res, status, code, err && err.message ? err.message : '写入失败', false);
  }

  function newResourcePayload(body, spec, idPrefix) {
    const checked = validateResourcePayload(body, spec);
    if (checked.error) return checked;
    // 客户端可携带 id 做「编辑已有资源」；格式受限（资源 id 全部由前缀+hex 构成），
    // 缺省或未提供时由服务端生成 —— 同 id 重复提交即幂等更新（§5.6 upsert 语义）
    const clientId = body && typeof body.id === 'string' ? body.id.trim() : '';
    if (clientId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) {
        return { error: 'invalid_id' };
      }
      checked.value.id = clientId;
    }
    if (!checked.value.id) checked.value.id = newResourceId(idPrefix);
    return checked;
  }

  api['POST /api/v1/institutions'] = async (req, res) => {
    const body = await readBody(req);
    const checked = validateResourcePayload(body, [
      { key: 'name', kind: 'name', code: 'invalid_name' },
      { key: 'kind', kind: 'institutionKind' }
    ]);
    if (checked.error) return fail(res, 400, checked.error, '机构字段不合法：' + checked.error, false);
    try {
      const row = dbm.transaction(ctx.db, () =>
        R.upsertInstitution(ctx.db, checked.value, { now: new Date().toISOString() })
      );
      return sendJson(res, 201, { ok: true, item: row });
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  api['POST /api/v1/accounts'] = async (req, res) => {
    const body = await readBody(req);
    const checked = newResourcePayload(
      body,
      [
        { key: 'name', kind: 'name', code: 'invalid_name' },
        { key: 'kind', kind: 'text' },
        { key: 'pool', kind: 'pool' },
        { key: 'status', kind: 'text' },
        { key: 'institution', kind: 'text' },
        { key: 'institutionKind', kind: 'institutionKind' }
      ],
      'acct'
    );
    if (checked.error) return fail(res, 400, checked.error, '账户字段不合法：' + checked.error, false);
    try {
      dbm.transaction(ctx.db, () => R.upsertAssetAccount(ctx.db, checked.value, { now: new Date().toISOString() }));
    } catch (err) {
      return upsertFail(res, err);
    }
    const item = R.readAssetAccounts(ctx.db).find((a) => a.id === checked.value.id) || null;
    return sendJson(res, 201, { ok: true, item: item });
  };

  api['POST /api/v1/account-units'] = async (req, res) => {
    const body = await readBody(req);
    const checked = newResourcePayload(
      body,
      [
        { key: 'accountId', kind: 'name', code: 'invalid_account' },
        { key: 'currency', kind: 'currency' },
        { key: 'balanceMinor', kind: 'minor' },
        { key: 'asOf', kind: 'date' },
        { key: 'sourceType', kind: 'text' }
      ],
      'unit'
    );
    if (checked.error) return fail(res, 400, checked.error, '余额单元字段不合法：' + checked.error, false);
    try {
      dbm.transaction(ctx.db, () => R.upsertAssetUnit(ctx.db, checked.value, { now: new Date().toISOString() }));
    } catch (err) {
      return upsertFail(res, err);
    }
    const item = R.readAssetUnits(ctx.db).find((u) => u.id === checked.value.id) || null;
    return sendJson(res, 201, { ok: true, item: item });
  };

  api['POST /api/v1/asset-transfers'] = async (req, res) => {
    const body = await readBody(req);
    const checked = newResourcePayload(
      body,
      [
        { key: 'fromUnitId', kind: 'name', code: 'invalid_from_unit' },
        { key: 'toUnitId', kind: 'name', code: 'invalid_to_unit' },
        { key: 'fromAmountMinor', kind: 'minor' },
        { key: 'toAmountMinor', kind: 'minor' },
        { key: 'occurredOn', kind: 'date' },
        { key: 'sourceType', kind: 'text' },
        { key: 'note', kind: 'text' }
      ],
      'xfer'
    );
    if (checked.error || !checked.value.occurredOn || checked.value.fromAmountMinor <= 0 || checked.value.toAmountMinor <= 0) {
      return fail(res, 400, checked.error || 'invalid_transfer', '换汇字段不合法：' + (checked.error || '金额和日期必填'), false);
    }
    try {
      const item = dbm.transaction(ctx.db, () =>
        R.upsertAssetTransfer(ctx.db, checked.value, { now: new Date().toISOString() })
      );
      return sendJson(res, 201, { ok: true, item: item });
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  api['POST /api/v1/liabilities'] = async (req, res) => {
    const body = await readBody(req);
    const checked = newResourcePayload(
      body,
      [
        { key: 'name', kind: 'name', code: 'invalid_name' },
        { key: 'accountId', kind: 'text' },
        { key: 'currency', kind: 'currency' },
        { key: 'balanceMinor', kind: 'minor' },
        { key: 'dueDate', kind: 'date' },
        { key: 'termType', kind: 'text' },
        { key: 'asOf', kind: 'date' }
      ],
      'liab'
    );
    if (checked.error) return fail(res, 400, checked.error, '负债字段不合法：' + checked.error, false);
    try {
      dbm.transaction(ctx.db, () => R.upsertLiability(ctx.db, checked.value, { now: new Date().toISOString() }));
    } catch (err) {
      return upsertFail(res, err);
    }
    const item = R.readLiabilities(ctx.db).find((l) => l.id === checked.value.id) || null;
    return sendJson(res, 201, { ok: true, item: item });
  };

  api['POST /api/v1/entitlements'] = async (req, res) => {
    const body = await readBody(req);
    const checked = newResourcePayload(
      body,
      [
        { key: 'name', kind: 'name', code: 'invalid_name' },
        { key: 'kind', kind: 'text' },
        { key: 'jurisdiction', kind: 'text' },
        { key: 'status', kind: 'text' },
        { key: 'balanceMinor', kind: 'minor' },
        { key: 'valuationType', kind: 'text' },
        { key: 'asOf', kind: 'date' },
        { key: 'sourceRef', kind: 'text' }
      ],
      'ent'
    );
    if (checked.error) return fail(res, 400, checked.error, '权益字段不合法：' + checked.error, false);
    try {
      dbm.transaction(ctx.db, () => R.upsertEntitlement(ctx.db, checked.value, { now: new Date().toISOString() }));
    } catch (err) {
      return upsertFail(res, err);
    }
    const item = R.readEntitlements(ctx.db).find((e) => e.id === checked.value.id) || null;
    return sendJson(res, 201, { ok: true, item: item });
  };

  /* ------------------------- Phase 3：月度结账 ------------------------- */

  api['GET /api/v1/monthly-closes'] = (req, res) => {
    sendJson(res, 200, { items: R.listMonthlyCloses(ctx.db) });
  };

  api['POST /api/v1/monthly-closes'] = async (req, res) => {
    const body = await readBody(req);
    const month = body && isYm(body.month) ? body.month : localDateStr().slice(0, 7);
    if (!isYm(month)) return fail(res, 400, 'invalid_month', 'month 必须是 YYYY-MM', false);

    // 结账数据截止到该月最后一天；核对口径完全复用 domain.computeCloseChecklist
    //（内含 computeOverview），保证决策台与月结页的「估算/正式」永远一致（D-001）
    const asOf = lastDayOfMonth(month);
    const state = R.readState(ctx.db);
    const settings = state.settings || {};
    let checklist;
    try {
      checklist = Domain.computeCloseChecklist(state.assets, { now: asOf, settings: settings });
    } catch (err) {
      return fail(res, 400, 'invalid_assets', '存量数据无法生成核对清单：' + (err && err.message ? err.message : String(err)), false);
    }

    // 正式结账必须有明确估值（无任何缺项）；否则只能保存为估算（§5.3）
    if (body && body.status === 'formal' && !checklist.canComplete) {
      return fail(res, 409, 'close_blocked', '存在未核对项，不能正式结账；可先保存为估算', false);
    }
    const status = body && body.status === 'formal' ? 'formal' : checklist.canComplete ? 'formal' : 'estimate';

    const overview = Domain.computeOverview(state.assets, { now: asOf, settings: settings });
    // 月均必要支出由服务端从现金流事实重算（D-034）；前端传值与 settings 只作为
    // 交易为密文等无法重算时的回落，且回落来源会记进快照，便于追溯口径。
    const basis = necessaryBasisFromState(state, month);
    const clientAvg = body && Number.isSafeInteger(body.avgNecessaryMinor) && body.avgNecessaryMinor > 0
      ? body.avgNecessaryMinor
      : null;
    const settingsAvg = typeof settings.avgNecessaryMinor === 'number' && settings.avgNecessaryMinor > 0
      ? settings.avgNecessaryMinor
      : null;
    const avgNecessary = basis.avgNecessaryMinor != null ? basis.avgNecessaryMinor : clientAvg || settingsAvg;
    const emergencySource = basis.avgNecessaryMinor != null ? 'txns' : clientAvg ? 'client' : settingsAvg ? 'settings' : null;
    const emergencyMonths = avgNecessary
      ? Domain.emergencyCoverageMonths(overview.pools.safetyMinor, avgNecessary)
      : null;
    const emergency = {
      avgNecessaryMinor: avgNecessary,
      coverageMonths: emergencyMonths,
      source: emergencySource,
      basis: basis
    };

    // Phase 4E：把本期收益归因一并封存进快照。基准 = **上一个已结账月**的快照（asOf 即它的 dataCutoff），
    // 与 D-034 ③「结账相关口径以封存事实为准、不按今天的口径倒推」同纪律。
    // 没有任何更早的结账记录时 baseline = null，领域层整段不出归因（unavailable='no_baseline'），
    // 宁可说"还没有可比的已结账月"，也不编一个基准出来。
    // G4E-1（复核补口）：基准的**内容**也必须来自封存快照 —— 先按 sha256 校验快照原文与封存哈希一致，
    // 再提取封存的逐持仓明细（数量/价格/汇率/事件计数）交给领域层。校验失败或明细缺失时显式标注
    // detailsUnavailable，绝不从当前事实表按历史日期重算期初（回填旧日期事实不得改写已结账月）。
    const priorCloses = R.listMonthlyCloses(ctx.db).filter((c) => String(c.month) < String(month));
    const prior = priorCloses.length ? priorCloses[0] : null;
    let attributionBaseline = null;
    if (prior && prior.dataCutoff && prior.snapshot) {
      attributionBaseline = {
        asOf: prior.dataCutoff,
        month: prior.month,
        closeId: prior.id,
        snapshotId: prior.snapshot.id,
        payloadHash: prior.snapshot.payloadHash,
        status: prior.status,
        positions: null,
        detailsUnavailable: null
      };
      const raw = R.getCloseSnapshot(ctx.db, prior.snapshot.id);
      if (!raw || !raw.payloadJson) {
        attributionBaseline.detailsUnavailable = 'baseline_details_missing';
      } else {
        const actualHash = crypto.createHash('sha256').update(raw.payloadJson).digest('hex');
        if (prior.snapshot.payloadHash && actualHash !== prior.snapshot.payloadHash) {
          attributionBaseline.detailsUnavailable = 'baseline_hash_mismatch';
        } else {
          let priorPayload = null;
          try { priorPayload = JSON.parse(raw.payloadJson); } catch (_) { priorPayload = null; }
          const derived = priorPayload
            ? Domain.baselinePositionsFromSnapshot(priorPayload)
            : { positions: null, unavailable: 'baseline_details_missing' };
          if (derived.unavailable) attributionBaseline.detailsUnavailable = derived.unavailable;
          else attributionBaseline.positions = derived.positions;
        }
      }
    }
    const attribution = Domain.computeReturnAttribution(state.assets, {
      now: asOf,
      settings: settings,
      baseline: attributionBaseline
    });
    // G4E-1：把「基准月末时点的逐持仓明细」也封存进本期快照（as-of 口径，绝不取未来价格），
    // 作为**下一期**归因的期初基准事实。checklist.facts.holdings 是 Phase 3「结账时点最新价」
    // 口径，不能拿来做期初，因此这里单独算一份。
    const attributionPositions = Domain.computeAttributionBaselinePositions(state.assets, asOf);

    const nowIso = new Date().toISOString();
    const closeId = R.getMonthlyCloseByMonth(ctx.db, month) || newResourceId('close');
    const snapshotId = newResourceId('snap');
    const payloadJson = JSON.stringify({
      month: month,
      asOf: asOf,
      status: status,
      overview: overview,
      checklist: checklist,
      emergencyCoverageMonths: emergencyMonths,
      emergency: emergency,
      // Phase 4E 追加字段（纯追加）：旧快照没有这些键，读取方必须容忍它们缺失。
      // attributionPositions：基准月末时点的逐持仓明细（as-of 口径），供下期归因作期初基准。
      attribution: attribution,
      attributionPositions: attributionPositions
    });
    const payloadHash = crypto.createHash('sha256').update(payloadJson).digest('hex');

    try {
      dbm.transaction(ctx.db, () => {
        R.upsertMonthlyClose(ctx.db, {
          id: closeId,
          month: month,
          status: status,
          blockers: checklist.items,
          summary: {
            totalAssetsMinor: overview.totalAssetsMinor,
            totalLiabilitiesMinor: overview.totalLiabilitiesMinor,
            netWorthMinor: overview.netWorthMinor,
            valuationStatus: checklist.valuationStatus,
            emergencyCoverageMonths: emergencyMonths,
            avgNecessaryMinor: avgNecessary
          },
          completedAt: nowIso,
          dataCutoff: asOf
        });
        R.insertCloseSnapshot(ctx.db, {
          id: snapshotId,
          closeId: closeId,
          month: month,
          capturedAt: nowIso,
          snapshotType: 'monthly_close',
          payloadJson: payloadJson,
          payloadHash: payloadHash
        });
      });
    } catch (err) {
      return upsertFail(res, err);
    }

    return sendJson(res, 201, {
      ok: true,
      close: {
        id: closeId,
        month: month,
        status: status,
        completedAt: nowIso,
        dataCutoff: asOf,
        canComplete: checklist.canComplete,
        blockers: checklist.items
      },
      snapshot: { id: snapshotId, payloadHash: payloadHash, capturedAt: nowIso },
      // 归因随结账响应一起返回，省掉一次 close-snapshots 往返；它同时已封存进快照 payload。
      attribution: attribution
    });
  };

  api['GET /api/v1/instruments'] = (req, res) => {
    sendJson(res, 200, { items: R.readInstruments(ctx.db) });
  };

  /* ---------- Phase 4B：标的检索、目录建立与分类确认 ---------- */

  // 只读检索：本地已建标的 + provider 候选，按去重键合并（provider 失败时本地命中仍可用）。
  // 检索词走 query string；对外只发送公开检索词，不含任何账户/持仓信息。
  api['GET /api/v1/instruments/search'] = (req, res) => {
    const q = (req.query && req.query.q) || '';
    return Catalog.searchCatalog(ctx.db, FixtureProvider, q, providerCtx(ctx)).then((result) => {
      if (!result.ok) return catalogFail(res, result);
      return sendJson(res, 200, {
        ok: true,
        query: result.query,
        provider: result.provider,
        candidates: result.candidates,
        warnings: result.warnings
      });
    });
  };

  // 建立/刷新标的：默认从 provider 参考数据补全（source 缺省即 provider）；
  // provider 未覆盖的标的用 source=manual 手工建立（币种必填）。
  // 一律落成 suggested —— 分类确认必须由用户显式发起（ARCHITECTURE §10）。
  api['POST /api/v1/instruments'] = async (req, res) => {
    const body = await readBody(req);
    const result = await Catalog.createInstrument(ctx.db, FixtureProvider, body, providerCtx(ctx));
    if (!result.ok) return catalogFail(res, result);
    return sendJson(res, 201, {
      ok: true,
      item: result.item,
      duplicated: !!result.duplicated,
      preserved: !!result.preserved,
      conflicts: result.conflicts || [],
      suggestions: result.suggestions || []
    });
  };

  // 用户确认分类：asset_class / exposure_market 是用户判断，两项必填；
  // 确认后 classification_status 锁定为 confirmed，外部元数据变化只能产生冲突提示。
  api['POST /api/v1/instrument-confirmations'] = async (req, res) => {
    const body = await readBody(req);
    const result = Catalog.confirmInstrument(ctx.db, body, providerCtx(ctx));
    if (!result.ok) return catalogFail(res, result);
    return sendJson(res, 201, {
      ok: true,
      item: result.item,
      conflicts: result.conflicts || []
    });
  };
  api['GET /api/v1/holdings'] = (req, res) => {
    sendJson(res, 200, { items: R.readHoldings(ctx.db) });
  };

  /* ---------- Phase 4C：持仓账本与证券事件（D-042） ---------- */

  // 期初持仓快照：同一 (账户, 标的) 只允许一行事实；同 id 重复提交即幂等更新。
  // 标的分类未确认（suggested）时允许写入，响应带 warning：§10 的语义是阻塞正式估值，不是拒绝录入。
  api['POST /api/v1/portfolio-openings'] = async (req, res) => {
    const body = await readBody(req);
    const checked = newResourcePayload(
      body,
      [
        { key: 'accountId', kind: 'name', code: 'invalid_account' },
        { key: 'instrumentId', kind: 'name', code: 'invalid_instrument_id' },
        { key: 'quantity', kind: 'decimal', code: 'invalid_quantity' },
        { key: 'costMinor', kind: 'minor' },
        { key: 'asOf', kind: 'date' }
      ],
      'open'
    );
    if (checked.error) return fail(res, 400, checked.error, '期初快照字段不合法：' + checked.error, false);
    try {
      const item = dbm.transaction(ctx.db, () => R.upsertPortfolioOpening(ctx.db, checked.value));
      const ins = R.getInstrument(ctx.db, checked.value.instrumentId);
      return sendJson(res, 201, {
        ok: true,
        item: item,
        warning: ins && ins.classificationStatus !== 'confirmed' ? 'classification_unconfirmed' : null
      });
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  // 证券事件（buy/sell/dividend/fee）：追加式事实，同 id 重放 → 409 duplicate_event；
  // HTTP 层重试用 Idempotency-Key 回放首次响应（§5.6）。
  // 事件绝不写 txns：证券事件不是现金流，现金余额仍由余额单元人工核对（D-034/S4C.1）。
  api['POST /api/v1/security-events'] = async (req, res) => {
    const body = await readBody(req);
    const idemKey = req.headers['idempotency-key'];
    const fingerprint = requestFingerprint(body);
    if (idemKey) {
      const cached = R.findIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/security-events');
      if (cached) {
        // 新格式把请求指纹与响应一起保存；旧数据库中的直接响应仍可兼容回放。
        if (cached.__requestFingerprint) {
          if (!safeEqual(cached.__requestFingerprint, fingerprint)) {
            return fail(res, 409, 'idempotency_conflict', '同一 Idempotency-Key 已用于不同的证券事件', false);
          }
          return sendJson(res, 200, cached.response, { 'X-Ledger-Idempotent': 'replay' });
        }
        return sendJson(res, 200, cached, { 'X-Ledger-Idempotent': 'replay' });
      }
    }
    const payload = body && typeof body === 'object' ? body : {};
    const clientId = typeof payload.id === 'string' ? payload.id.trim() : '';
    if (!payload.id) payload.id = newResourceId('sev');
    else if (clientId && !/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) {
      return fail(res, 400, 'invalid_id', '事件 id 不合法', false);
    }
    try {
      // 事件事实与幂等记录必须在同一个事务提交：任一写入失败都整体回滚，
      // 避免“事件已落库、幂等键没记住”导致重试产生第二笔事实。
      const response = dbm.transaction(ctx.db, () => {
        const item = R.upsertSecurityEvent(ctx.db, payload);
        const ins = R.getInstrument(ctx.db, payload.instrumentId);
        const result = {
          ok: true,
          item: item,
          warning: ins && ins.classificationStatus !== 'confirmed' ? 'classification_unconfirmed' : null
        };
        if (idemKey) {
          R.rememberIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/security-events', {
            __requestFingerprint: fingerprint,
            response: result
          });
        }
        return result;
      });
      return sendJson(res, 201, response);
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  api['GET /api/v1/security-events'] = (req, res) => {
    sendJson(res, 200, { items: R.readSecurityEvents(ctx.db) });
  };

  /* ---------- Phase 5B：风险评估与复评机制（D-047） ---------- */

  // 客户端只提交原始答案 / 评估日期 / 复评原因；双评分、等级、上限、硬封顶与到期日
  // 全部由服务端用 5A 冻结领域规则重算（PHASE5_BREAKDOWN §5.3）。载荷里出现任何派生字段
  // （capacityScore / riskCeiling / status…）都会被领域入口的精确键白名单拒绝。
  // 追加式写入：同 id 重放 → 409 duplicate_assessment；HTTP 重试由 Idempotency-Key 回放，
  // 评估事实与幂等记录同一事务提交（沿用 G4C-7 纪律）。
  api['POST /api/v1/risk-assessments'] = async (req, res) => {
    const body = await readBody(req);
    const idemKey = req.headers['idempotency-key'];
    const fingerprint = requestFingerprint(body);
    if (idemKey) {
      const cached = R.findIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/risk-assessments');
      if (cached) {
        if (cached.__requestFingerprint) {
          if (!safeEqual(cached.__requestFingerprint, fingerprint)) {
            return fail(res, 409, 'idempotency_conflict', '同一 Idempotency-Key 已用于不同的风险评估', false);
          }
          return sendJson(res, 200, cached.response, { 'X-Ledger-Idempotent': 'replay' });
        }
        return sendJson(res, 200, cached, { 'X-Ledger-Idempotent': 'replay' });
      }
    }
    const today = typeof ctx.today === 'function' ? ctx.today() : localDateStr();
    const computed = Domain.computeRiskAssessment(body && typeof body === 'object' ? body : {}, { today: today });
    if (!computed.ok) {
      const code = (computed.error && computed.error.code) || 'invalid_answers';
      const status = DOMAIN_ERROR_STATUS[code] || 400;
      // detail 只报结构问题，不回显答案原文（5A 口径）
      return fail(res, status, code, '风险评估请求不合法：' + (computed.error && computed.error.detail ? computed.error.detail : code), false);
    }
    const record = Object.assign({ id: newResourceId('ra') }, computed.record, {
      createdAt: typeof ctx.nowIso === 'function' ? ctx.nowIso() : new Date().toISOString()
    });
    try {
      const response = dbm.transaction(ctx.db, () => {
        const item = R.insertRiskAssessment(ctx.db, record);
        const result = { ok: true, item: item };
        if (idemKey) {
          R.rememberIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/risk-assessments', {
            __requestFingerprint: fingerprint,
            response: result
          });
        }
        return result;
      });
      return sendJson(res, 201, response);
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  api['GET /api/v1/risk-assessments'] = (req, res) => {
    const rows = R.readRiskAssessments(ctx.db);
    const items = [];
    let invalidCount = 0;
    rows.forEach((row) => {
      const checked = Domain.validateRiskAssessmentRecord(row);
      if (checked.ok) items.push(checked.record);
      else invalidCount += 1;
    });
    // 历史列表也必须走重算闸：被篡改或当前规则目录无法解释的记录不向页面暴露为
    // 可用评估，但通过 invalidCount / total 留下显式证据，不能静默消失（D-047 ⑥）。
    sendJson(res, 200, { items: items, invalidCount: invalidCount, total: rows.length });
  };

  // 当前有效评估的只读视图：由确定性领域规则选出（服务端不读客户端时钟；
  // 判定日与 POST 同一口径：ctx.today 可注入（测试固定时钟），否则取服务端本地日；
  // asOf 仅供页面预览某一天的有效性判定）。过期只使评估失效，绝不删除历史。
  api['GET /api/v1/risk-assessments/current'] = (req, res) => {
    const items = R.readRiskAssessments(ctx.db);
    const serverToday = typeof ctx.today === 'function' ? ctx.today() : localDateStr();
    const hasAsOf = Object.prototype.hasOwnProperty.call(req.query, 'asOf');
    if (hasAsOf && !isDateStr(req.query.asOf)) {
      return fail(res, 400, 'invalid_assessment_date', 'asOf 必须是真实存在的 YYYY-MM-DD', false);
    }
    const now = hasAsOf ? req.query.asOf : serverToday;
    const sel = Domain.selectCurrentAssessment(items, now);
    if (!sel.ok) {
      const code = (sel.error && sel.error.code) || 'invalid_assessment_date';
      return fail(res, DOMAIN_ERROR_STATUS[code] || 400, code, '无法判定当前评估：' + (sel.error && sel.error.detail ? sel.error.detail : code), false);
    }
    sendJson(res, 200, {
      ok: true,
      now: now,
      status: sel.status,
      current: sel.current ? { assessment: sel.current.record, validity: sel.current.validity } : null,
      expiredRef: sel.expiredRef,
      invalidCount: sel.invalidCount,
      total: items.length
    });
  };

  /* ------------------------- Phase 5C：目标配置与认可标的映射 ------------------------- */
  // 目标版本的数值全部由服务端按「当前有效评估的上限 + 5A 冻结模板」派生（D-048 ①）：
  // 载荷只允许 effectiveFrom，出现 level / classes / templateVersion 等派生字段即在入口拒绝。
  // 历史目标永不 UPDATE：评估或模板变化时追加新版本，旧版本继续可读（§6.2 工作项 5）。
  api['GET /api/v1/targets'] = (req, res) => {
    const rows = R.readAllocationTargets(ctx.db);
    const assessments = {};
    R.readRiskAssessments(ctx.db).forEach((a) => { assessments[a.id] = a; });
    const items = [];
    let invalidCount = 0;
    rows.forEach((row) => {
      const checked = Domain.validateAllocationTargetRecord(row, assessments[row.assessmentId] || null);
      if (checked.ok) items.push(checked.record);
      else invalidCount += 1;
    });
    // 与 5B 的历史列表同一纪律：被篡改或无法按冻结契约解释的记录不冒充可用目标，但显式留痕。
    sendJson(res, 200, { items: items, invalidCount: invalidCount, total: rows.length });
  };

  api['POST /api/v1/targets'] = async (req, res) => {
    const body = await readBody(req);
    const idemKey = req.headers['idempotency-key'];
    const fingerprint = requestFingerprint(body);
    if (idemKey) {
      const cached = R.findIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/targets');
      if (cached) {
        if (cached.__requestFingerprint) {
          if (!safeEqual(cached.__requestFingerprint, fingerprint)) {
            return fail(res, 409, 'idempotency_conflict', '同一 Idempotency-Key 已用于另一次目标生成', false);
          }
          return sendJson(res, 200, cached.response, { 'X-Ledger-Idempotent': 'replay' });
        }
        return sendJson(res, 200, cached, { 'X-Ledger-Idempotent': 'replay' });
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'invalid_target_payload', '目标生成请求必须是 JSON 对象', false);
    }
    const payload = body;
    const hasEffectiveFrom = Object.prototype.hasOwnProperty.call(payload, 'effectiveFrom');
    if (!hasEffectiveFrom && Object.keys(payload).length !== 0) {
      return fail(res, 400, 'invalid_target_payload', '目标生成请求只接受可选的 effectiveFrom 字段', false);
    }
    if (hasEffectiveFrom && !Domain.isCalendarDate(payload.effectiveFrom)) {
      return fail(res, 400, 'invalid_effective_date', 'effectiveFrom 必须是真实存在的 YYYY-MM-DD', false);
    }
    const today = typeof ctx.today === 'function' ? ctx.today() : localDateStr();
    const sel = Domain.selectCurrentAssessment(R.readRiskAssessments(ctx.db), today);
    if (!sel.ok) {
      return fail(res, DOMAIN_ERROR_STATUS[(sel.error && sel.error.code) || ''] || 400,
        (sel.error && sel.error.code) || 'invalid_assessment_date',
        '无法判定当前评估：' + (sel.error && sel.error.detail ? sel.error.detail : ''), false);
    }
    if (sel.status !== 'current') {
      const code = sel.status === 'all_expired' ? 'assessment_expired'
        : sel.status === 'invalid_records' ? 'invalid_assessment_records' : 'no_valid_assessment';
      const message = sel.status === 'all_expired' ? '风险评估已过期，请先复评再生成目标配置'
        : sel.status === 'invalid_records' ? '已保存的评估与当前规则复核不一致，不能据此生成目标'
          : '还没有有效的风险评估，不能生成目标配置';
      return fail(res, DOMAIN_ERROR_STATUS[code] || 409, code, message, false);
    }
    const computed = Domain.computeAllocationTarget(sel.current.record, {
      today: today,
      effectiveFrom: hasEffectiveFrom ? payload.effectiveFrom : undefined
    });
    if (!computed.ok) {
      const code = (computed.error && computed.error.code) || 'invalid_target_record';
      return fail(res, DOMAIN_ERROR_STATUS[code] || 400, code,
        '无法生成目标配置：' + (computed.error && computed.error.detail ? computed.error.detail : code), false);
    }
    // 自然键（评估 + 模板版本 + 生效日）已有目标 → 不追加第二行，直接回放既有版本。
    const existing = R.readAllocationTargets(ctx.db).filter((t) =>
      t.assessmentId === computed.target.assessmentId &&
      t.templateVersion === computed.target.templateVersion &&
      t.effectiveFrom === computed.target.effectiveFrom)[0];
    if (existing) {
      const checkedExisting = Domain.validateAllocationTargetRecord(existing, sel.current.record);
      if (!checkedExisting.ok) {
        return fail(res, 409, 'duplicate_target', '该评估在此生效日已有目标版本，且内容与当前规则不一致', false);
      }
      return sendJson(res, 200, { ok: true, created: false, item: checkedExisting.record, assessmentId: sel.current.record.id });
    }
    const record = Object.assign({ id: newResourceId('at'), createdAt: typeof ctx.nowIso === 'function' ? ctx.nowIso() : new Date().toISOString() }, computed.target);
    try {
      const response = dbm.transaction(ctx.db, () => {
        const item = R.insertAllocationTarget(ctx.db, record, { assessment: sel.current.record });
        const result = { ok: true, created: true, item: item, assessmentId: sel.current.record.id };
        if (idemKey) {
          R.rememberIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/targets', {
            __requestFingerprint: fingerprint,
            response: result
          });
        }
        return result;
      });
      return sendJson(res, 201, response);
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  // 当前生效目标 + 当前配置偏离 + 认可标的映射的只读组合视图。
  // 页面不再自己算第二遍（不变量 3 / D-025）：估值只走 computeOverview 这一遍，
  // 比例与偏离由 5C 领域函数在同一份估值结果上派生；blockers / canAdvise 原样透传总览。
  api['GET /api/v1/targets/current'] = (req, res) => {
    const serverToday = typeof ctx.today === 'function' ? ctx.today() : localDateStr();
    const hasAsOf = Object.prototype.hasOwnProperty.call(req.query, 'asOf');
    if (hasAsOf && !isDateStr(req.query.asOf)) {
      return fail(res, 400, 'invalid_assessment_date', 'asOf 必须是真实存在的 YYYY-MM-DD', false);
    }
    const now = hasAsOf ? req.query.asOf : serverToday;
    const state = R.readState(ctx.db);
    const assessmentSel = Domain.selectCurrentAssessment(state.riskAssessments, now);
    if (!assessmentSel.ok) {
      return fail(res, 400, (assessmentSel.error && assessmentSel.error.code) || 'invalid_assessment_date',
        '无法判定当前评估：' + (assessmentSel.error && assessmentSel.error.detail ? assessmentSel.error.detail : ''), false);
    }
    const currentAssessment = assessmentSel.status === 'current' ? assessmentSel.current.record : null;
    const tsel = Domain.selectCurrentTarget(state.allocationTargets, currentAssessment, now);
    const base = {
      ok: true,
      now: now,
      status: tsel.ok ? tsel.status : 'invalid_records',
      assessmentStatus: assessmentSel.status,
      assessment: currentAssessment,
      validity: assessmentSel.status === 'current' ? assessmentSel.current.validity : null,
      target: null,
      allocation: null,
      mapping: null,
      missingClasses: [],
      invalidCount: tsel.ok ? tsel.invalidCount : 0,
      total: tsel.ok ? tsel.total : 0,
      versions: { ruleVersion: Domain.RISK_RULE_VERSION, targetVersion: Domain.RISK_TARGET_VERSION }
    };
    if (!tsel.ok || tsel.status !== 'current') {
      // 没有生效目标时仍然返回映射与评估状态：维护认可标的不依赖目标是否已生成。
      const view = R.readApprovedMappingView(ctx.db);
      base.mapping = {
        rows: view.rows, validCount: view.validCount, issueCount: view.issueCount,
        invalidCount: view.invalidCount, total: view.total
      };
      return sendJson(res, 200, base);
    }
    const target = tsel.current.target;
    const reassessed = Domain.validateAllocationTargetRecord(target, currentAssessment);
    if (!reassessed.ok) {
      return fail(res, 409, (reassessed.error && reassessed.error.code) || 'invalid_target_record',
        '目标版本与所引用评估不一致：' + (reassessed.error && reassessed.error.detail ? reassessed.error.detail : ''), false);
    }
    const overview = Domain.computeOverview(state.assets, { now: now, settings: state.settings || {} });
    const deviation = Domain.computeAllocationDeviation(target, overview);
    if (!deviation.ok) {
      return fail(res, 500, 'invalid_valuation_input', '无法在当前估值结果上计算类别偏离', false);
    }
    const view = R.readApprovedMappingView(ctx.db);
    const missing = Domain.classesMissingMapping(target, view);
    sendJson(res, 200, Object.assign(base, {
      target: target,
      allocation: deviation,
      mapping: {
        rows: view.rows, validCount: view.validCount, issueCount: view.issueCount,
        invalidCount: view.invalidCount, total: view.total
      },
      missingClasses: missing.ok ? missing.missingClasses : []
    }));
  };

  api['GET /api/v1/approved-instruments'] = (req, res) => {
    const view = R.readApprovedMappingView(ctx.db);
    sendJson(res, 200, {
      ok: true,
      rows: view.rows,
      byClass: view.byClass,
      validCount: view.validCount,
      issueCount: view.issueCount,
      invalidCount: view.invalidCount,
      total: view.total
    });
  };

  // 用户判断的唯一写入口：按「整类替换」建模（顺序即用户给的顺序）。
  // 行情 / 目录 provider 的刷新路径不经过这里，也不写这张表 —— 刷新不可能加入、删除或改写认可标的。
  api['POST /api/v1/approved-instruments'] = async (req, res) => {
    const body = await readBody(req);
    const idemKey = req.headers['idempotency-key'];
    const fingerprint = requestFingerprint(body);
    if (idemKey) {
      const cached = R.findIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/approved-instruments');
      if (cached) {
        if (cached.__requestFingerprint) {
          if (!safeEqual(cached.__requestFingerprint, fingerprint)) {
            return fail(res, 409, 'idempotency_conflict', '同一 Idempotency-Key 已用于另一份认可标的清单', false);
          }
          return sendJson(res, 200, cached.response, { 'X-Ledger-Idempotent': 'replay' });
        }
        return sendJson(res, 200, cached, { 'X-Ledger-Idempotent': 'replay' });
      }
    }
    const checked = Domain.validateApprovedMappingRequest(body && typeof body === 'object' ? body : {});
    if (!checked.ok) {
      const code = (checked.error && checked.error.code) || 'invalid_mapping_payload';
      return fail(res, DOMAIN_ERROR_STATUS[code] || 400, code,
        '认可标的请求不合法：' + (checked.error && checked.error.detail ? checked.error.detail : code), false);
    }
    try {
      const response = dbm.transaction(ctx.db, () => {
        const items = R.replaceApprovedInstrumentClass(ctx.db, checked.assetClass, checked.instrumentIds, {
          now: typeof ctx.nowIso === 'function' ? ctx.nowIso() : new Date().toISOString()
        });
        const result = { ok: true, assetClass: checked.assetClass, items: items };
        if (idemKey) {
          R.rememberIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/approved-instruments', {
            __requestFingerprint: fingerprint,
            response: result
          });
        }
        return result;
      });
      return sendJson(res, 200, response);
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  /* ------------------------- Phase 5D：新增资金优先再平衡与正式建议门禁 -------------------------
   * 服务端重新读取全部事实并按 D-049 的七条门禁逐项判定；客户端提交的当前比例、分数、目标、
   * blocker 与认可标的一律不采信（`approvedInstruments` 出现在载荷即 400）。
   * 门禁不过不是 HTTP 错误：响应仍是 200 + status:'estimate' + formalRecommendation:null，
   * 页面据此显示估算与待办；前端的按钮禁用永远不能代替这道服务端门禁（§7.3）。
   */
  api['POST /api/v1/recommendations'] = async (req, res) => {
    const body = await readBody(req);
    const idemKey = req.headers['idempotency-key'];
    const fingerprint = requestFingerprint(body);
    if (idemKey) {
      const cached = R.findIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/recommendations');
      if (cached) {
        if (cached.__requestFingerprint) {
          if (!safeEqual(cached.__requestFingerprint, fingerprint)) {
            return fail(res, 409, 'idempotency_conflict', '同一 Idempotency-Key 已用于另一次建议请求', false);
          }
          return sendJson(res, 200, cached.response, { 'X-Ledger-Idempotent': 'replay' });
        }
        return sendJson(res, 200, cached, { 'X-Ledger-Idempotent': 'replay' });
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'invalid_new_funds_request', '建议请求必须是 JSON 对象', false);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'approvedInstruments')) {
      return fail(res, 400, 'invalid_approved_instruments',
        '认可标的只由服务端从本机事实读取，不接受请求体提交的映射', false);
    }
    const checked = Domain.validateRecommendationRequest(body);
    if (!checked.ok) {
      const code = (checked.error && checked.error.code) || 'invalid_new_funds_request';
      return fail(res, DOMAIN_ERROR_STATUS[code] || 400, code,
        '建议请求不合法：' + (checked.error && checked.error.detail ? checked.error.detail : code), false);
    }
    const today = typeof ctx.today === 'function' ? ctx.today() : localDateStr();
    const state = R.readState(ctx.db);
    const snap = R.getCloseSnapshot(ctx.db, body.snapshotRef.snapshotId);
    const close = R.listMonthlyCloses(ctx.db).find(c => c.id === body.snapshotRef.closeId) || null;
    const capture = Recommendations.normalizeInput({
      algorithmVersion: Recommendations.ALGORITHM_VERSION,
      request: body, asOf: today, assets: state.assets, settings: state.settings || {},
      riskAssessments: state.riskAssessments, allocationTargets: state.allocationTargets,
      approvedInstruments: state.approvedInstruments, close, snapshot: snap
    });
    let computed;
    try { computed = Recommendations.calculate(capture); } catch (err) { return upsertFail(res, err); }
    const { versions, allocation } = computed;
    const partial = {
      id: '', createdAt: typeof ctx.nowIso === 'function' ? ctx.nowIso() : new Date().toISOString(),
      status: computed.status,
      ruleVersion: versions.ruleVersion, targetVersion: versions.targetVersion,
      assessmentId: versions.assessmentId, targetId: versions.targetId,
      closeId: versions.closeId, snapshotId: versions.snapshotId, snapshotPayloadHash: versions.snapshotPayloadHash,
      dataCutoff: versions.dataCutoff, asOf: versions.asOf,
      requestedNewFundsMinor: allocation.requestedNewFundsMinor,
      newFundsAvailableMinor: allocation.newFundsAvailableMinor,
      allocatableNewFundsMinor: allocation.allocatableNewFundsMinor,
      allocatedTotalMinor: allocation.allocatedTotalMinor,
      inputHash: '',
      // D-052：explanationVersion 是 gate 区的可选封存键（与 checks / capture 并列）。
      // 不进 capture → 不改变 inputHash / id / 重放等式；旧记录没有此键照常有效，也永不回填。
      gate: { checks: computed.checks, capture, explanationVersion: Knowledge.EXPLANATION_VERSION },
      todos: computed.todos, result: computed.result
    };
    partial.inputHash = R.recommendationInputHash(partial);
    partial.id = R.recommendationRecordId(partial.inputHash);
    const existed = !!R.getRecommendation(ctx.db, partial.id);
    try {
      const item = dbm.transaction(ctx.db, () => {
        const stored = R.insertRecommendation(ctx.db, partial);
        const result = recommendationResponse(stored, existed);
        if (idemKey) {
          R.rememberIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/recommendations', {
            __requestFingerprint: fingerprint,
            response: result
          });
        }
        return result;
      });
      return sendJson(res, existed ? 200 : 201, item);
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  // 建议产物的响应形状：正式建议与估算互斥，绝不同时给出两份数字让人猜哪份作数
  function recommendationResponse(record, created) {
    const formal = record.status === 'formal' ? record.result : null;
    return {
      ok: true,
      created: !created,
      id: record.id,
      status: record.status,
      inputHash: record.inputHash,
      recommendation: record,
      formalRecommendation: formal,
      estimate: formal ? null : record.result
    };
  }

  // Phase 6B：创建 / 事件响应的统一装配。created:false 时回放既有决策的完整详情
  //（不套用本次 intent / note）；eventMonths 由事件发生月派生（契约 §5）。
  function decisionMutationResponse(db, result, ctx) {
    if (!result.created) {
      const detail = Decisions.decisionDetailResponse(db, result.decisionId, ctx);
      return {
        ok: true,
        created: false,
        decision: detail.decision,
        events: detail.events,
        links: detail.links,
        execution: detail.execution,
        recommendation: detail.recommendation,
        snapshots: detail.snapshots,
        timeline: detail.timeline
      };
    }
    const eventMonths = Array.from(new Set(result.events.map((e) => String(e.occurredAt).slice(0, 7)))).sort();
    return {
      ok: true,
      created: true,
      decision: Object.assign({}, result.decision, { eventMonths: eventMonths }),
      events: result.events,
      links: result.links.map((l) => ({
        id: l.id,
        securityEventId: l.securityEventId,
        linkedOn: l.linkedOn,
        unlinkedOn: l.unlinkedOn,
        note: l.note
      })),
      execution: result.execution
    };
  }

  api['GET /api/v1/recommendations'] = (req, res) => {
    const view = R.readRecommendationView(ctx.db);
    // 与 5B / 5C 的列表同一纪律：复核不过或封存哈希被改动的行不冒充可用建议，但显式留痕
    sendJson(res, 200, {
      items: view.items,
      invalidCount: view.invalidCount,
      total: view.total,
      versions: { ruleVersion: Domain.RISK_RULE_VERSION, targetVersion: Domain.RISK_TARGET_VERSION }
    });
  };

  /* ------------------------- Phase 6B：决策状态机、事件与只读视图（D-057） -------------------------
   * 创建：唯一对象是一条 formal 建议；一条建议最多一条决策（自然幂等 created:false）。
   * intent 缺省 → 两步式 proposed（零事件、无快照）；accepted/deferred/dismissed → 一步创建
   * 并追加首条事件。接受门禁（adviceStaleness + 5D 门禁复放 + G5-R1 引用一致）与事件、
   * 快照、幂等记录在同一事务提交；失败整体回滚（契约 §2.2 / §6.4 / §8.6）。
   */
  api['POST /api/v1/decisions'] = async (req, res) => {
    const body = await readBody(req);
    const idemKey = req.headers['idempotency-key'];
    const fingerprint = requestFingerprint(body);
    if (idemKey) {
      const cached = R.findIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/decisions');
      if (cached) {
        if (cached.__requestFingerprint) {
          if (!safeEqual(cached.__requestFingerprint, fingerprint)) {
            return fail(res, 409, 'idempotency_conflict', '同一 Idempotency-Key 已用于另一次决策请求', false);
          }
          return sendJson(res, 200, cached.response, { 'X-Ledger-Idempotent': 'replay' });
        }
        return sendJson(res, 200, cached, { 'X-Ledger-Idempotent': 'replay' });
      }
    }
    const today = typeof ctx.today === 'function' ? ctx.today() : localDateStr();
    const nowIso = typeof ctx.nowIso === 'function' ? ctx.nowIso() : new Date().toISOString();
    try {
      const payload = dbm.transaction(ctx.db, () => {
        const result = Decisions.createDecision(ctx.db, body, { today: today, nowIso: nowIso });
        const out = decisionMutationResponse(ctx.db, result, { today: today });
        if (idemKey) {
          R.rememberIdempotent(ctx.db, String(idemKey), 'POST', '/api/v1/decisions', {
            __requestFingerprint: fingerprint,
            response: out
          });
        }
        return out;
      });
      return sendJson(res, payload.created ? 201 : 200, payload);
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  // 列表：有效决策 + 过滤（state / month / recommendationId / from / to）+ invalidCount 留痕。
  // 过滤参数不合法会以领域错误码抛出：同步 handler 也必须走集中错误映射，不能炸掉进程。
  api['GET /api/v1/decisions'] = (req, res) => {
    const today = typeof ctx.today === 'function' ? ctx.today() : localDateStr();
    try {
      sendJson(res, 200, Decisions.decisionListResponse(ctx.db, req.query || {}, { today: today }));
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  api['GET /api/v1/quotes'] = (req, res) => {
    sendJson(res, 200, { items: R.readQuotes(ctx.db) });
  };
  api['GET /api/v1/fx-rates'] = (req, res) => {
    sendJson(res, 200, { items: R.readFxRates(ctx.db) });
  };

  // 手动汇率录入（Phase 3 补充，D-034）：Phase 3 的页面必须能独立把外币余额折算成 CNY，
  // 自动行情 provider 属于 Phase 4；这里只维护「币对 + 汇率 + 汇率日」这一条事实。
  api['POST /api/v1/fx-rates'] = async (req, res) => {
    const body = await readBody(req);
    const checked = validateResourcePayload(body, [
      { key: 'base', kind: 'currency', code: 'invalid_base' },
      { key: 'quote', kind: 'currency', code: 'invalid_quote' },
      { key: 'rateDecimal', kind: 'decimal', code: 'invalid_rate' },
      { key: 'rateDate', kind: 'date', code: 'invalid_rate_date' },
      { key: 'provider', kind: 'text' },
      { key: 'status', kind: 'text' }
    ]);
    if (checked.error) return fail(res, 400, checked.error, '汇率字段不合法：' + checked.error, false);
    if (!checked.value.rateDate) return fail(res, 400, 'invalid_rate_date', '汇率日期不能为空', false);
    try {
      const item = dbm.transaction(ctx.db, () => R.upsertFxRate(ctx.db, checked.value, { now: new Date().toISOString() }));
      return sendJson(res, 201, { ok: true, item: item });
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  // 手动补价（Phase 4D，D-044）：行情源不可用/未覆盖时的兜底入口。
  // 落库来源固定为 'manual'（用户显式事实），自动更新不得覆盖同一天或更早的手动值。
  // 字段校验统一交给仓储层的单条写入路径（与全量写入共用同一套口径），API 只做载荷形状判断。
  api['POST /api/v1/quotes'] = async (req, res) => {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'invalid_quote', '报价载荷必须是对象', false);
    }
    try {
      const item = dbm.transaction(ctx.db, () =>
        R.upsertManualQuote(
          ctx.db,
          {
            instrumentId: body.instrumentId,
            priceMinor: body.priceMinor,
            priceDate: body.priceDate,
            currency: body.currency,
            sourceSymbol: body.sourceSymbol
          },
          { now: new Date().toISOString() }
        )
      );
      return sendJson(res, 201, { ok: true, item: item, source: 'manual' });
    } catch (err) {
      return upsertFail(res, err);
    }
  };

  // 行情与汇率刷新（Phase 4D）。响应语义是「一次刷新尝试的报告」，不是「必须拿到数据」：
  // provider 超时/限额/缺标的等外部失败返回 200 + ok:false + 逐作用域 errors（含 retryable），
  // 让前端能显示"这次没成、用的是上次的值"，而不是把外部不可达伪装成客户端错误（D-044）。
  // 自动行情抓取受 D-038 门禁约束：开关只从服务端 settings 读取（不信任请求体），默认关闭。
  api['POST /api/v1/market-data/refresh'] = async (req, res) => {
    const body = await readBody(req);
    if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
      return fail(res, 400, 'invalid_json', '刷新载荷必须是对象', false);
    }
    const rawScopes = body && body.scopes != null ? body.scopes : null;
    if (rawScopes != null && !Array.isArray(rawScopes)) {
      return fail(res, 400, 'invalid_scope', 'scopes 必须是数组', false);
    }
    if (Array.isArray(rawScopes)) {
      const unknown = rawScopes.filter((s) => MarketData.SCOPES.indexOf(s) === -1);
      if (unknown.length) {
        return fail(res, 400, 'invalid_scope', '未知作用域：' + unknown.join(', '), false);
      }
    }
    const stamp = providerCtx(ctx).now;
    const asOfRaw = body && body.asOf != null ? String(body.asOf) : localDateStr(new Date(stamp));
    if (!ProviderContract.isDateString(asOfRaw)) {
      return fail(res, 400, 'invalid_date', 'asOf 必须是真实存在的 YYYY-MM-DD 日期', false);
    }

    const state = R.readState(ctx.db);
    const settings = (state && state.settings) || {};
    const autoQuotes = settings.marketDataAutoQuotes === true;
    const fetcher = ctx.marketDataFetcher || {};

    // Key 只在真要发起自动行情抓取时才读，且只取"有没有配好"（密钥内容不进响应、不进日志）。
    const keyStatus = autoQuotes && !fetcher.quotes ? KeychainKey.providerKeyStatus() : null;

    let summary;
    try {
      summary = await MarketData.refreshMarketData({
        db: ctx.db,
        now: stamp,
        asOf: asOfRaw,
        scopes: Array.isArray(rawScopes) && rawScopes.length ? rawScopes : undefined,
        autoQuotesEnabled: autoQuotes,
        fxDisabled: fetcher.fxDisabled === true,
        fxFetch: fetcher.fx || undefined,
        quotesFetch: fetcher.quotes || undefined,
        quotesProviderId: fetcher.quotesProviderId || null,
        quotesEndpoint: fetcher.quotesEndpoint || null
      });
    } catch (err) {
      return fail(res, 500, 'market_data_failed', (err && err.message) || '刷新失败', true);
    }
    if (keyStatus) summary.marketDataKey = keyStatus;
    return sendJson(res, 200, summary);
  };

  api['GET /api/v1/backups'] = (req, res) => {
    sendJson(res, 200, {
      items: backupLib.listBackups(ctx.paths.backupDir),
      keep: ctx.backupKeep,
      dailyGuaranteed: true
    });
  };

  api['POST /api/v1/backups'] = async (req, res) => {
    try {
      const result = await backupLib.createBackup(ctx.db, ctx.paths, { reason: 'manual' });
      sendJson(res, 201, { ok: true, backup: result });
    } catch (err) {
      fail(res, 503, 'backup_failed', err && err.message ? err.message : String(err), true);
    }
  };

  api['POST /api/v1/restores'] = async (req, res) => {
    const body = await readBody(req);
    const name = String((body && body.file) || '');
    if (!name || name.indexOf('/') !== -1 || name.indexOf('\\') !== -1 || name.indexOf('..') !== -1) {
      return fail(res, 400, 'invalid_backup_name', '只接受 backups 目录内的备份文件名', false);
    }
    const abs = path.join(ctx.paths.backupDir, name);
    const result = await backupLib.restoreBackup(ctx.db, ctx.paths, abs, { log: ctx.logger.info });
    if (!result.ok) {
      return fail(res, 409, 'restore_failed', result.reason, true);
    }
    ctx.db = result.db;
    sendJson(res, 200, {
      ok: true,
      restoredFrom: result.restoredFrom,
      preRestoreBackup: result.preRestoreBackup,
      schemaVersion: migrations.currentVersion(ctx.db)
    });
  };

  api['GET /api/v1/keychain/status'] = (req, res) => {
    // 只返回读取路径是否可用，绝不返回任何密钥内容（ARCHITECTURE §8）
    const check = keychain.selfCheck(ctx.keychainService, ctx.keychainAccount);
    sendJson(res, 200, {
      available: check.available,
      readable: check.readable,
      keychains: check.keychains || 0,
      probe: check.probe || { status: 'skipped' },
      note: 'Phase 4 才真正读取行情 API Key；本接口只做可用性探测'
    });
  };

  return api;
}

/* ------------------------------ 静态资源 ------------------------------ */

function serveStatic(req, res, ctx) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://' + ctx.host).pathname);
  } catch (_) {
    return fail(res, 400, 'invalid_path', '请求路径无法解析', false);
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // 先按未归一化的路径段判断，任何".."或 .git 段一律拒绝（不做路径拼接后再兜底）
  const rawSegments = pathname.split(/[/\\]/).filter(Boolean);
  if (rawSegments.some((s) => s === '..' || s === '.git')) {
    return fail(res, 403, 'forbidden_path', '拒绝访问该路径', false);
  }

  const rel = path.normalize(pathname).replace(/^[/\\]+/, '');
  if (!rel) return fail(res, 404, 'not_found', '资源不存在', false);
  const abs = path.join(ctx.repoRoot, rel);
  if (abs !== ctx.repoRoot && !abs.startsWith(ctx.repoRoot + path.sep)) {
    return fail(res, 403, 'forbidden_path', '拒绝访问仓库之外的路径', false);
  }
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.db' || /\.db-(wal|shm)$/.test(abs)) {
    return fail(res, 403, 'forbidden_path', '拒绝通过 HTTP 提供数据库文件', false);
  }

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (_) {
    return fail(res, 404, 'not_found', '资源不存在', false);
  }
  if (!stat.isFile()) return fail(res, 404, 'not_found', '资源不存在', false);

  const isHtml = ext === '.html' || ext === '.htm';
  let body;
  try {
    body = fs.readFileSync(abs);
  } catch (err) {
    return fail(res, 500, 'read_failed', '读取资源失败', true);
  }

  // 前端需要 session token 才能写；只在同源页面里注入，跨源页面读不到响应体
  if (isHtml) {
    body = Buffer.from(
      body.toString('utf8').split(TOKEN_PLACEHOLDER).join(ctx.token),
      'utf8'
    );
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    // HTML 携带 token 且静态资源需要随版本更新：一律不缓存
    'Cache-Control': isHtml || ext === '.js' || ext === '.css' ? 'no-store' : 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

/* ------------------------------ 请求入口 ------------------------------ */

// 结账快照明细（Phase 3 补充，D-034）：ACCEPTANCE 要求「每个金额都能下钻到余额、估值或交易来源」，
// 因此历史结账必须能取回封存时的单元级事实，而不是只给一个哈希。
// 只读接口：路径含参数，走下面的正则路由，不进入精确匹配表。
function readCloseSnapshotHandler(ctx, rawId, res) {
  let id = '';
  try {
    id = decodeURIComponent(String(rawId));
  } catch (_) {
    return fail(res, 400, 'invalid_id', '快照 id 不合法', false);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(res, 400, 'invalid_id', '快照 id 不合法', false);
  const row = R.getCloseSnapshot(ctx.db, id);
  if (!row) return fail(res, 404, 'snapshot_not_found', '快照不存在：' + id, false);
  // D-045 ⑨：读取方只有在「原文 sha256 == 封存哈希」时才能使用快照内容。
  // 结账重算路径已有同一校验；只读接口也必须返回校验结论，否则浏览器会把篡改后的
  // payload 与旧 payloadHash 一起展示，造成「看似可追溯、实际已失真」。
  const actualPayloadHash = crypto.createHash('sha256').update(row.payloadJson).digest('hex');
  const hashValid = !!row.payloadHash && actualPayloadHash === row.payloadHash;
  let payload = null;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch (_) {
    payload = null;
  }
  return sendJson(res, 200, {
    ok: true,
    snapshot: {
      id: row.id,
      closeId: row.closeId,
      month: row.month,
      capturedAt: row.capturedAt,
      snapshotType: row.snapshotType,
      payloadHash: row.payloadHash,
      hashValid: hashValid,
      integrityStatus: hashValid ? 'valid' : 'mismatch',
      payloadJson: row.payloadJson,
      payload: payload
    }
  });
}

// Phase 6B：决策事件（POST，路径参数）。写接口走同一道 token / Origin / Content-Type 门禁；
// 幂等键绑定「同一路径的同一份请求语义」，事件端点没有自然幂等，页面必须带 Idempotency-Key。
async function handleDecisionEvent(ctx, rawId, req, res) {
  let decisionId = '';
  try {
    decisionId = decodeURIComponent(String(rawId));
  } catch (_) {
    return fail(res, 400, 'invalid_id', '决策 id 不合法', false);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(decisionId)) {
    return fail(res, 400, 'invalid_id', '决策 id 不合法', false);
  }
  const body = await readBody(req);
  const idemKey = req.headers['idempotency-key'];
  const eventPath = '/api/v1/decisions/' + decisionId + '/events';
  const fingerprint = requestFingerprint(body);
  if (idemKey) {
    const cached = R.findIdempotent(ctx.db, String(idemKey), 'POST', eventPath);
    if (cached) {
      if (cached.__requestFingerprint) {
        if (!safeEqual(cached.__requestFingerprint, fingerprint)) {
          return fail(res, 409, 'idempotency_conflict', '同一 Idempotency-Key 已用于另一次决策事件', false);
        }
        return sendJson(res, 200, cached.response, { 'X-Ledger-Idempotent': 'replay' });
      }
      return sendJson(res, 200, cached, { 'X-Ledger-Idempotent': 'replay' });
    }
  }
  const today = typeof ctx.today === 'function' ? ctx.today() : localDateStr();
  const nowIso = typeof ctx.nowIso === 'function' ? ctx.nowIso() : new Date().toISOString();
  try {
    const payload = dbm.transaction(ctx.db, () => {
      const result = Decisions.appendDecisionEvent(ctx.db, decisionId, body, { today: today, nowIso: nowIso });
      const eventMonths = Array.from(new Set(result.events.map((e) => String(e.occurredAt).slice(0, 7)))).sort();
      const out = {
        ok: true,
        decision: Object.assign({}, result.decision, { eventMonths: eventMonths }),
        events: result.events,
        links: result.links.map((l) => ({
          id: l.id,
          securityEventId: l.securityEventId,
          linkedOn: l.linkedOn,
          unlinkedOn: l.unlinkedOn,
          note: l.note
        })),
        execution: result.execution
      };
      if (idemKey) {
        R.rememberIdempotent(ctx.db, String(idemKey), 'POST', eventPath, {
          __requestFingerprint: fingerprint,
          response: out
        });
      }
      return out;
    });
    return sendJson(res, 200, payload);
  } catch (err) {
    return upsertFailDispatcher(err, res);
  }
}

// Phase 6B：决策详情（GET，路径参数）。任一复核失败 → 400 invalid_decision_record（fail closed）。
function handleDecisionDetail(ctx, rawId, res) {
  let decisionId = '';
  try {
    decisionId = decodeURIComponent(String(rawId));
  } catch (_) {
    return fail(res, 400, 'invalid_id', '决策 id 不合法', false);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(decisionId)) {
    return fail(res, 400, 'invalid_id', '决策 id 不合法', false);
  }
  const today = typeof ctx.today === 'function' ? ctx.today() : localDateStr();
  try {
    return sendJson(res, 200, Decisions.decisionDetailResponse(ctx.db, decisionId, { today: today }));
  } catch (err) {
    return upsertFailDispatcher(err, res);
  }
}

// 路径参数路由没有 api 表内的 upsertFail 闭包：集中同一套错误码 → HTTP 状态映射。
function upsertFailDispatcher(err, res) {
  const code = (err && err.code) || 'internal_error';
  if (code === 'internal_error' || /^(?:ERR_)?SQLITE_/.test(code)) {
    return fail(res, 500, 'internal_error', '写入失败', false);
  }
  const status = DOMAIN_ERROR_STATUS[code] || 400;
  return fail(res, status, code, err && err.message ? err.message : '写入失败', false);
}

function isAllowedOrigin(origin, port) {
  if (!origin) return true; // 非浏览器客户端（如 curl）不带 Origin，由 token 把关
  const allowed = ['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port];
  return allowed.indexOf(String(origin)) !== -1;
}

function checkWrite(req, ctx) {
  const token = req.headers[TOKEN_HEADER];
  if (!token || !safeEqual(String(token), String(ctx.token))) {
    return { status: 401, code: 'token_required', message: '写请求缺少或携带无效的本地会话令牌', retryable: false };
  }
  if (!isAllowedOrigin(req.headers.origin, ctx.port)) {
    return { status: 403, code: 'origin_rejected', message: '写请求来源不被信任', retryable: false };
  }
  const ct = String(req.headers['content-type'] || '').trim();
  if (!/^application\/json(\s*;|$)/i.test(ct)) {
    return {
      status: 415,
      code: 'invalid_content_type',
      message: '写请求必须使用 Content-Type: application/json',
      retryable: false
    };
  }
  return null;
}

function createHandlerEntry(ctx) {
  const api = createHandler(ctx);
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  return function handle(req, res) {
    const started = Date.now();
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://' + ctx.host).pathname;
    } catch (_) {
      pathname = '/';
    }
    const query = {};
    try {
      new URL(req.url, 'http://' + ctx.host).searchParams.forEach((v, k) => {
        query[k] = v;
      });
    } catch (_) {
      /* 查询串无法解析时按空处理 */
    }

    res.on('finish', () => {
      ctx.logger.info(req.method + ' ' + pathname + ' -> ' + res.statusCode + ' (' + (Date.now() - started) + 'ms)');
    });

    if (pathname.indexOf(API_PREFIX) !== 0) {
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, ctx);
      return fail(res, 405, 'method_not_allowed', '静态资源只支持 GET', false);
    }

    // 不提供 CORS 能力：预检一律拒绝，跨源页面无法发起写请求
    if (req.method === 'OPTIONS') {
      return fail(res, 405, 'preflight_not_supported', '本服务不提供跨源访问', false);
    }

    const key = req.method + ' ' + pathname;
    const handler = api[key];
    if (handler) {
      if (WRITE_METHODS.has(req.method)) {
        const denied = checkWrite(req, ctx);
        if (denied) return fail(res, denied.status, denied.code, denied.message, denied.retryable);
      }
      req.query = query;
      const result = handler(req, res);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          if (res.headersSent) return;
          const code = err && err.code ? err.code : 'internal_error';
          const status = DOMAIN_ERROR_STATUS[code] || 500;
          ctx.logger.error('处理 ' + key + ' 失败：' + (err && err.message ? err.message : String(err)));
          fail(res, status, code, err && err.message ? err.message : '服务内部错误', status >= 500);
        });
      }
      return undefined;
    }

    // 带路径参数的只读接口：结账快照明细（金额下钻）
    const snapshotMatch = /^GET \/api\/v1\/close-snapshots\/([^/]+)$/.exec(key);
    if (snapshotMatch) {
      return readCloseSnapshotHandler(ctx, snapshotMatch[1], res);
    }

    // Phase 6B：决策事件（POST 写接口，先过写门禁）与决策详情（GET 只读）
    const decisionEventMatch = /^POST \/api\/v1\/decisions\/([^/]+)\/events$/.exec(key);
    if (decisionEventMatch) {
      const denied = checkWrite(req, ctx);
      if (denied) return fail(res, denied.status, denied.code, denied.message, denied.retryable);
      return handleDecisionEvent(ctx, decisionEventMatch[1], req, res);
    }
    const decisionDetailMatch = /^GET \/api\/v1\/decisions\/([^/]+)$/.exec(key);
    if (decisionDetailMatch) {
      return handleDecisionDetail(ctx, decisionDetailMatch[1], res);
    }

    // 后端冻结但尚未实现的写接口：保持资源边界可见，明确告知所属阶段
    if (DEFERRED_WRITES[key]) {
      return fail(
        res,
        501,
        'not_implemented',
        key + ' 属于 ' + DEFERRED_WRITES[key] + ' 的交付范围，本阶段只提供读取',
        false
      );
    }

    if (pathname.indexOf(API_PREFIX) === 0) {
      return fail(res, 404, 'not_found', '未知接口：' + key, false);
    }
    return fail(res, 404, 'not_found', '资源不存在', false);
  };
}

module.exports = {
  API_PREFIX,
  TOKEN_HEADER,
  TOKEN_PLACEHOLDER,
  DEFERRED_WRITES,
  createHandlerEntry,
  isAllowedOrigin,
  localDateStr
};
