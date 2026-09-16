/* 小账本 server/instrument-catalog.js — 标的目录与分类确认（Phase 4B）
 *
 * 依据：ROADMAP Phase 4B、ACCEPTANCE S4B.1、DECISIONS D-037、ARCHITECTURE §5.2 / §7。
 *
 * 职责边界：
 *   - 检索：先给本地已建标的，再问 provider 拿候选；本地命中在 provider 不可用时仍然可用。
 *   - 预分类：provider 真有的字段（currency / exchange / instrument_type / country /
 *     exchange_timezone）可作为 suggested 预填并标注依据；asset_class / exposure_market /
 *     跟踪指数**不是** provider 字段，provider 未提供就保持空，由用户填写（不编造）。
 *   - 确认与锁定：`classification_status` 由 suggested → confirmed；确认后 provider 的任何变化
 *     都不得改写本地值，只生成带 provenance 的冲突提示。
 *   - 去重：以 (symbol, exchange) 为去重键，同一标的只保留一行事实；稳定 id 供后续多个
 *     证券账户共同引用（4C）。
 *
 * 隐私（AGENTS.md「隐私与网络」/ D-020）：
 *   - 对外只发送公开检索词与公开证券代码（经 contract 的 serialize* 白名单校验）；
 *   - 结果与落库记录里不含账户名、数量、成本或余额 —— 本模块从不读取这些字段。
 *
 * 本模块是纯编排 + 纯校验：不碰 HTTP、不读系统时钟（时间由 ctx.now 注入）、不发真实网络
 * （provider 由调用方传入，4B 固定为离线 fixture）。
 */
'use strict';

const crypto = require('node:crypto');

const Contract = require('./providers/contract');
const Domain = require('../js/domain.js');
const R = require('./repository');
const dbm = require('./db');

// 单条标的写入在事务里原位 upsert；不得删除父记录，否则会级联删除持仓、事件与报价。
// 标的写入路径是同步的（provider 调用在事务之外完成），因此这里可以安全地开事务（不可嵌套）。
function writeInstrument(db, record, now) {
  return dbm.transaction(db, () => R.upsertInstrument(db, record, { now: now }));
}

// 标的来源：外部参考数据 / 用户手工建立（provider 未覆盖时，例如 A 股本土 ETF）。
const SOURCE_PROVIDER = 'provider';
const SOURCE_MANUAL = 'manual';

const MAX_NAME_LENGTH = 120;

// provider 字段 → 本地记录字段（D-037 的映射）。
// 只映射 provider 真有的字段；asset_class / exposure_market / 跟踪指数不在此列。
const PROVIDER_FIELD_MAP = {
  name: 'name',
  currency: 'currency',
  exchange: 'exchange',
  instrumentType: 'instrumentType',
  country: 'country',
  exchangeTimezone: 'exchangeTimezone'
};

/* ------------------------------ 稳定 id ------------------------------ */

// identity key（`symbol@exchange`，大小写与空白归一）→ 标的 id。
// 这是全产品**唯一**的 id 派生实现：其他模块不得另写一套哈希口径。
function stableIdFromKey(key) {
  return 'inst-' + crypto.createHash('sha1').update(String(key || ''), 'utf8').digest('hex').slice(0, 16);
}

// 标的 id 由 identity key 确定性派生：同一个 key 永远得到同一个 id，
// 因此重复检索/重复加入不会凭空多出第二条事实（4C 的持仓可放心引用）。
function stableInstrumentId(symbol, exchange) {
  const key = Domain.instrumentKey(symbol, exchange) || String(symbol || '').trim().toUpperCase();
  return stableIdFromKey(key);
}

// 一条已有标的的 identity key：创建时落库的那个，永久不变。
// 即便后来由 provider 补全了交易所，id 也**不重算** —— 4C 的持仓引用因此永远有效。
// 记录里持久化 identityKey，外部可用它离线复算 id（而不是用"当前交易所"重算）。
function identityKeyOf(record) {
  if (!record) return null;
  if (typeof record.identityKey === 'string' && record.identityKey) return record.identityKey;
  return Domain.instrumentKey(record.symbol, record.exchange);
}

function failure(code, message, retryable) {
  return { ok: false, code: code, message: message, retryable: !!retryable };
}

/* ------------------------------ 载荷校验（纯函数） ------------------------------ */

function trimmed(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function rejectText(v, maxLength) {
  return !!v && (v.length > maxLength || /[\u0000-\u001f\u007f]/.test(v));
}

// POST /api/v1/instruments 的载荷校验。
// 只保留白名单字段；错误码稳定；**不回声任何输入值**（载荷里可能夹带私有文本）。
function parseCreatePayload(body) {
  const b = body || {};
  const symbol = trimmed(b.symbol).toUpperCase();
  if (!Contract.isSymbol(symbol)) return failure('invalid_symbol', '标的代码必须是合法的公开证券代码形状', false);

  const source = b.source == null || b.source === '' ? SOURCE_PROVIDER : trimmed(b.source);
  if (source !== SOURCE_PROVIDER && source !== SOURCE_MANUAL) {
    return failure('invalid_source', '标的来源只能是 provider 或 manual', false);
  }

  const out = { symbol: symbol, source: source };

  // 标的 id 是服务端按 identity key 派生的身份，**不接受客户端指定**（D-039）。
  // 这里显式拒绝而不是静默忽略：悄悄改写客户端提交的身份字段，正是"无声分叉"——
  // 客户端以为自己指定了 id，实际存的是另一个值，4C 的引用就会指向不存在的身份。
  if (b.id != null && trimmed(b.id) !== '') {
    return failure('client_id_forbidden', '标的 id 由服务端按 symbol@exchange 派生，不接受客户端指定', false);
  }
  if (b.currency != null && trimmed(b.currency) !== '') {
    const c = trimmed(b.currency).toUpperCase();
    if (Domain.CURRENCIES.indexOf(c) === -1) return failure('invalid_currency', '标的币种必须是 CNY/HKD/USD', false);
    out.currency = c;
  }
  if (b.exchange != null && trimmed(b.exchange) !== '') {
    const e = trimmed(b.exchange);
    if (!/^[A-Za-z0-9._:-]{1,32}$/.test(e)) return failure('invalid_exchange', '交易所标识不合法', false);
    out.exchange = e;
  }
  if (b.name != null && trimmed(b.name) !== '') {
    const n = trimmed(b.name);
    if (rejectText(n, MAX_NAME_LENGTH)) return failure('invalid_name', '标的名称为空或过长', false);
    out.name = n;
  }
  if (b.instrumentType != null && trimmed(b.instrumentType) !== '') {
    const t = trimmed(b.instrumentType);
    if (rejectText(t, 40)) return failure('invalid_instrument_type', '标的类型为空或过长', false);
    out.instrumentType = t;
  }
  if (b.country != null && trimmed(b.country) !== '') {
    const c = trimmed(b.country);
    if (rejectText(c, 40)) return failure('invalid_country', '上市地区为空或过长', false);
    out.country = c;
  }
  if (b.assetClass != null && trimmed(b.assetClass) !== '') {
    const a = trimmed(b.assetClass);
    if (!Domain.isAssetClass(a)) return failure('invalid_asset_class', '资产类别不在允许的词表内', false);
    out.assetClass = a;
  }
  if (b.exposureMarket != null && trimmed(b.exposureMarket) !== '') {
    const m = trimmed(b.exposureMarket);
    if (!Domain.isExposureMarket(m)) return failure('invalid_exposure_market', '风险敞口市场不在允许的词表内', false);
    out.exposureMarket = m;
  }
  if (b.trackingIndex != null && trimmed(b.trackingIndex) !== '') {
    const t = trimmed(b.trackingIndex);
    if (rejectText(t, MAX_NAME_LENGTH)) return failure('invalid_tracking_index', '跟踪指数为空或过长', false);
    out.trackingIndex = t;
  }
  return { ok: true, value: out };
}

// POST /api/v1/instrument-confirmations 的载荷校验。
// 资产类别与敞口市场是**用户判断**，两项都必须由用户显式给出才能确认（D-037）。
function parseConfirmPayload(body) {
  const b = body || {};
  const id = trimmed(b.instrumentId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return failure('invalid_id', '缺少合法的标的 id', false);

  const assetClass = trimmed(b.assetClass);
  if (!Domain.isAssetClass(assetClass)) return failure('invalid_asset_class', '资产类别不在允许的词表内', false);

  const exposureMarket = trimmed(b.exposureMarket);
  if (!Domain.isExposureMarket(exposureMarket)) {
    return failure('invalid_exposure_market', '风险敞口市场不在允许的词表内', false);
  }

  const out = { instrumentId: id, assetClass: assetClass, exposureMarket: exposureMarket };
  if (b.trackingIndex != null && trimmed(b.trackingIndex) !== '') {
    const t = trimmed(b.trackingIndex);
    if (rejectText(t, MAX_NAME_LENGTH)) return failure('invalid_tracking_index', '跟踪指数为空或过长', false);
    out.trackingIndex = t;
  }
  return { ok: true, value: out };
}

/* ------------------------------ 候选与冲突 ------------------------------ */

// 从 provider 的契约结果里取出 provider 字段快照（不含任何用户判断字段）。
function providerFieldsOf(candidate) {
  const out = {};
  Object.keys(PROVIDER_FIELD_MAP).forEach((k) => {
    out[k] = candidate[k] == null || candidate[k] === '' ? null : candidate[k];
  });
  return out;
}

// 候选（对外的统一形状）：provider 字段 + 预分类建议 + 必须由用户填写的字段清单 + 本地对照。
function buildCandidate(record, now) {
  return {
    symbol: record.symbol,
    name: record.name == null ? null : record.name,
    currency: record.currency,
    exchange: record.exchange == null ? null : record.exchange,
    country: record.country == null ? null : record.country,
    instrumentType: record.instrumentType == null ? null : record.instrumentType,
    exchangeTimezone: record.exchangeTimezone == null ? null : record.exchangeTimezone,
    provenance: record.provenance || null,
    suggestions: Domain.suggestFromProvider(record),
    userJudgementRequired: Domain.USER_JUDGEMENT_FIELDS.slice(),
    fetchedAt: now || null
  };
}

// 冲突：provider 候选与本地记录的**同名**差异，逐条附上 provenance。
// 只报差异、不改值 —— 本地值是否采纳由用户决定（D-037）。
function conflictsFor(record) {
  const candidate = record.providerCandidate;
  if (!candidate) return [];
  const provenance = record.providerProvenance || null;
  return Domain.diffInstrumentFields(record, candidate).map((d) => ({
    field: d.field,
    localValue: d.localValue,
    providerValue: d.providerValue,
    provenance: provenance
  }));
}

// 把候选结果（契约 instrument 结果）与本地记录合并成待写入的标的。
// 规则（比 D-037 的下限更严）：
//   - 本地已有值的字段**一律不覆盖**，只把差异记进 conflicts；
//   - provider 只补全本地为空的字段；
//   - asset_class / exposure_market / 跟踪指数只能来自用户输入，provider 无权写入。
function mergeCandidate(local, fields) {
  const out = {};
  Object.keys(PROVIDER_FIELD_MAP).forEach((k) => {
    const mapped = PROVIDER_FIELD_MAP[k];
    const localValue = local && local[mapped] != null && local[mapped] !== '' ? local[mapped] : null;
    const provided = fields && fields[k] != null && fields[k] !== '' ? fields[k] : null;
    out[mapped] = localValue != null ? localValue : provided;
  });
  return out;
}

/* ------------------------------ 检索 ------------------------------ */

function normSymbol(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

// 检索合并时的本地匹配：与建立流程（repository.findInstrumentByKey）**同一套规则**，
// 否则会出现"本地 `VOO@`（缺交易所）与参考数据 `VOO@NYSE` 各显示一条"的重复候选
// （第二轮复核 G4B-7）。
//   ① 精确 (symbol, exchange) 命中；
//   ② 同代码且一方缺交易所：本地只有一条时安全合并（"先手工建标、后由参考数据补全交易所"的常态）；
//   ③ 同代码存在多个市场：报歧义，**绝不按行顺序任选一条**（那会把跨市场标的算成同一个）。
// 返回 { record, exact } / { record: null } / { ambiguous: [records] }。
function matchLocalRecord(locals, symbol, exchange) {
  const want = Domain.instrumentKey(symbol, exchange);
  if (want) {
    const exact = locals.filter((r) => Domain.instrumentKey(r.symbol, r.exchange) === want);
    if (exact.length) return { record: exact[0], exact: true };
  }
  const sym = normSymbol(symbol);
  if (!sym) return { record: null };
  const loose = locals.filter((r) => normSymbol(r.symbol) === sym && (!r.exchange || !exchange));
  if (loose.length === 1) return { record: loose[0], exact: false };
  if (loose.length > 1) return { ambiguous: loose };
  return { record: null };
}

// 候选里的本地对照（含已确认分类与冲突），供前端显示"已在目录中"。
function localRefOf(rec) {
  return {
    id: rec.id,
    symbol: rec.symbol,
    exchange: rec.exchange == null ? null : rec.exchange,
    classificationStatus: rec.classificationStatus,
    assetClass: rec.assetClass == null ? null : rec.assetClass,
    exposureMarket: rec.exposureMarket == null ? null : rec.exposureMarket,
    name: rec.name == null ? null : rec.name,
    currency: rec.currency,
    conflicts: conflictsFor(rec)
  };
}

// 候选缺的展示字段用本地记录补齐（**只补空、不覆盖**）。
// 只改展示值，不动 suggestions —— 预分类建议必须只反映参考数据真有的值，
// 本地值不能冒充 provider 依据（D-037）。
function fillDisplayFromLocal(cand, rec) {
  ['name', 'currency', 'exchange', 'country', 'instrumentType', 'exchangeTimezone'].forEach((f) => {
    if ((cand[f] == null || cand[f] === '') && rec[f] != null && rec[f] !== '') cand[f] = rec[f];
  });
  return cand;
}

function ambiguityWarning(symbol, records, detail, providerId) {
  return {
    symbol: symbol,
    code: 'ambiguous_instrument',
    detail:
      detail +
      '（本地：' +
      records.map((r) => (r.exchange ? String(r.exchange) : '未注明交易所')).join(' / ') +
      '）',
    retryable: false,
    provider: providerId || null
  };
}

function localMatches(db, query) {
  const needle = String(query || '').toLowerCase();
  if (!needle) return [];
  return R.readInstrumentRecords(db).filter((r) => {
    const hay = (String(r.symbol || '') + ' ' + String(r.name || '')).toLowerCase();
    return hay.indexOf(needle) !== -1;
  });
}

// provider 调用的统一包装：把"adapter 抛异常 / 返回形状不合规"转成显式失败，
// 而不是让它变成 500，也不是静默当成"没搜到"。
function callProvider(fn) {
  try {
    const p = fn();
    if (!p || typeof p.then !== 'function') {
      return Promise.resolve({ status: 'error', code: 'provider_error', detail: 'provider 未返回 Promise', retryable: false });
    }
    return p.then(
      (value) => ({ status: 'ok', value: value }),
      (e) => ({
        status: 'error',
        code: 'provider_error',
        detail: (e && e.name === 'ContractError' ? 'provider 契约违例' : 'provider 调用失败'),
        retryable: false
      })
    );
  } catch (e) {
    return Promise.resolve({ status: 'error', code: 'provider_error', detail: 'provider 调用失败', retryable: false });
  }
}

// 检索：本地缓存 + provider 候选，按去重键合并成唯一候选列表。
// provider 整体失败时仍然返回本地命中，并显式报告 provider 状态（不把失败当空结果）。
function searchCatalog(db, provider, query, ctx) {
  const req = Contract.serializeSearchRequest(query);
  if (!req.ok) return Promise.resolve(failure('invalid_query', req.error.detail, false));

  const now = ctx && ctx.now;
  const locals = localMatches(db, req.query);
  const providerId = (provider && provider.PROVIDER_ID) || (provider && provider.id) || null;

  const searched = callProvider(() => provider.searchInstrument(req.query, ctx));

  return searched.then((res) => {
    const warnings = [];
    const providerCandidates = [];
    let providerStatus = { id: providerId, status: 'ok', code: null, retryable: false };

    if (res.status === 'error') {
      providerStatus = { id: providerId, status: 'error', code: res.code, retryable: res.retryable };
      warnings.push({ symbol: null, code: res.code, detail: res.detail, retryable: res.retryable });
    } else if (!Array.isArray(res.value)) {
      providerStatus = { id: providerId, status: 'error', code: 'invalid_payload', retryable: false };
      warnings.push({
        symbol: null,
        code: 'invalid_payload',
        detail: 'provider 返回了不满足契约的检索结果',
        retryable: false,
        provider: providerId
      });
    } else {
      const list = res.value;
      list.forEach((r) => {
        if (!Contract.isValidResult(r)) {
          warnings.push({
            symbol: null,
            code: 'invalid_payload',
            detail: 'provider 返回了不满足契约的检索结果',
            retryable: false,
            provider: providerId
          });
          if (list.length === 1 && providerStatus.status === 'ok') {
            providerStatus = { id: providerId, status: 'error', code: 'invalid_payload', retryable: false };
          }
          return;
        }
        if (r.kind === 'error') {
          if (r) {
            warnings.push({
              symbol: r.subject,
              code: r.code,
              detail: r.detail,
              retryable: r.retryable,
              provider: providerId
            });
            // 区分"provider 整体失败"与"某一项不合格"：前者是对整个检索的失败响应
            // （单个错误结果且没有 subject），后者带具体代码，只作为该项的 warning。
            const isProviderWide = list.length === 1 && r.subject == null;
            if (isProviderWide && providerStatus.status === 'ok') {
              providerStatus = { id: providerId, status: 'error', code: r.code, retryable: r.retryable };
            }
          }
          return;
        }
        providerCandidates.push(r);
      });
    }

    // 合并：同一标的只出现一条候选；本地已有的附上本地记录（含已确认分类与冲突）。
    // 匹配走 matchLocalRecord（与建立路径同一套规则），因此"本地缺交易所 + 参考数据有交易所"
    // 会合成一条 local+provider，而不是两条重复候选。
    const merged = [];
    const byKey = {};
    const consumed = {}; // 本地 id → 已被某条候选认领（避免同一条本地记录出现两次）
    // 松匹配（本地缺交易所）只有在 provider 对该本地记录也只有一个可能市场时才安全。
    // 先完整计算认领集合，避免按遍历顺序把第一条市场候选错误地并入本地。
    const matches = providerCandidates.map((r) => matchLocalRecord(locals, r.symbol, r.exchange));
    const looseClaims = {};
    matches.forEach((m, index) => {
      if (!m.record || m.exact) return;
      const key = Domain.instrumentKey(providerCandidates[index].symbol, providerCandidates[index].exchange);
      if (!looseClaims[m.record.id]) looseClaims[m.record.id] = {};
      looseClaims[m.record.id][key] = true;
    });
    const warnedLoose = {};
    function push(candidate) {
      const key = Domain.instrumentKey(candidate.symbol, candidate.exchange);
      if (byKey[key]) {
        const prev = byKey[key];
        // 本地命中优先保留本地记录，provider 只补全缺失的展示字段
        if (!prev.provenance && candidate.provenance) prev.provenance = candidate.provenance;
        prev.origin = prev.local ? 'local+provider' : prev.origin;
        return;
      }
      byKey[key] = candidate;
      merged.push(candidate);
    }

    function attachLocal(candidate, rec) {
      candidate.local = localRefOf(rec);
      candidate.origin = 'local+provider';
      fillDisplayFromLocal(candidate, rec);
      consumed[rec.id] = true;
      return candidate;
    }

    providerCandidates.forEach((r, providerIndex) => {
      const cand = buildCandidate(
        {
          symbol: r.symbol,
          name: r.name,
          currency: r.currency,
          exchange: r.exchange,
          country: r.country,
          instrumentType: r.instrumentType,
          exchangeTimezone: r.exchangeTimezone,
          provenance: r.provenance
        },
        now
      );
      cand.origin = 'provider';
      cand.local = null;
      const key = Domain.instrumentKey(r.symbol, r.exchange);
      const m = matches[providerIndex];
      if (m.ambiguous) {
        // 检索是只读的：不能像建立流程那样拒绝，但必须**显式报告歧义**并保持两条事实分离，
        // 绝不按行顺序把候选并到其中一条本地记录上。
        warnings.push(
          ambiguityWarning(r.symbol, m.ambiguous, '本地目录中该代码有多个交易所的记录，本次未与其中任何一条合并', providerId)
        );
      } else if (m.record) {
        const claims = looseClaims[m.record.id] ? Object.keys(looseClaims[m.record.id]) : [];
        if (!m.exact && claims.length > 1) {
          // 同一条本地记录（缺交易所）对应多个市场候选：无法判断它属于哪一个，所有候选都不合并。
          if (!warnedLoose[m.record.id]) {
            warnings.push(
              ambiguityWarning(
                r.symbol,
                [m.record],
                '本地只有一条未注明交易所的记录，参考数据同时返回了多个市场，无法判断它属于哪一个，本次未合并',
                providerId
              )
            );
            warnedLoose[m.record.id] = true;
          }
        } else {
          attachLocal(cand, m.record);
        }
      }
      push(cand);
    });

    locals.forEach((rec) => {
      if (consumed[rec.id]) return;
      const key = Domain.instrumentKey(rec.symbol, rec.exchange);
      const localRef = localRefOf(rec);
      // 兜底：同一去重键已有候选（例如 provider 也在精确键上命中过）时，只补上本地对照。
      if (byKey[key]) {
        const prev = byKey[key];
        if (!prev.local) {
          prev.local = localRef;
          prev.origin = 'local+provider';
          fillDisplayFromLocal(prev, rec);
        }
        consumed[rec.id] = true;
        return;
      }
      const cand = buildCandidate(
        {
          symbol: rec.symbol,
          name: rec.name,
          currency: rec.currency,
          exchange: rec.exchange,
          country: rec.country,
          instrumentType: rec.instrumentType,
          exchangeTimezone: rec.exchangeTimezone,
          provenance: rec.providerProvenance || null
        },
        now
      );
      cand.origin = 'local';
      cand.local = localRef;
      consumed[rec.id] = true;
      push(cand);
    });

    return {
      ok: true,
      query: req.query,
      provider: providerStatus,
      candidates: merged,
      warnings: warnings
    };
  });
}

/* ------------------------------ 建立/刷新标的 ------------------------------ */

// 从 provider 取单个标的的参考数据，返回 { ok, fields, provenance } 或失败对象。
function fetchMetadata(provider, symbol, ctx) {
  return callProvider(() => provider.getInstrumentMetadata(symbol, ctx)).then((res) => {
    if (res.status === 'error') {
      return failure('provider_unavailable', res.detail, res.retryable);
    }
    const r = res.value;
    if (!r || r.kind !== 'instrument') {
      if (r && r.kind === 'error' && r.code === 'not_found') {
        return failure(
          'instrument_not_found',
          '参考数据未收录该代码；如确认标的无误，可用 source=manual 手工建立（provider 覆盖范围有限）',
          false
        );
      }
      return failure(
        'invalid_provider_payload',
        (r && r.kind === 'error' && r.detail) || 'provider 返回了不可入账的标的元数据',
        false
      );
    }
    if (!Contract.isValidResult(r)) {
      return failure('invalid_provider_payload', 'provider 结果不满足契约形状', false);
    }
    if (normSymbol(r.symbol) !== normSymbol(symbol)) {
      return failure('invalid_provider_payload', 'provider 返回的标的代码与请求不一致', false);
    }
    return {
      ok: true,
      value: { fields: Object.assign({}, providerFieldsOf(r), { symbol: r.symbol }), provenance: r.provenance }
    };
  });
}

// 建立或刷新标的。合并规则见 mergeCandidate 的注释。
function createInstrument(db, provider, body, ctx) {
  const parsed = parseCreatePayload(body);
  if (!parsed.ok) return Promise.resolve(parsed);
  const v = parsed.value;
  const now = (ctx && ctx.now) || new Date().toISOString();

  const metaPromise =
    v.source === SOURCE_PROVIDER
      ? fetchMetadata(provider, v.symbol, ctx)
      : Promise.resolve({ ok: true, value: { fields: null, provenance: null } });

  return metaPromise.then((meta) => {
    if (!meta.ok) return meta;

    const fields = meta.value.fields;
    // 手工来源没有 provider 可补全币种，必须自带（币种是估值必需字段）。
    if (v.source === SOURCE_MANUAL && !v.currency) {
      return failure('invalid_currency', '手工建立标的必须提供币种（CNY/HKD/USD）', false);
    }
    // provider 来源：不接受与上游不一致的币种，也不静默二选一。
    if (v.source === SOURCE_PROVIDER && v.currency && fields && fields.currency && v.currency !== fields.currency) {
      return failure('currency_mismatch', '提交的币种与参考数据不一致；请核对后再建立标的', false);
    }
    if (
      v.source === SOURCE_PROVIDER &&
      v.exchange &&
      fields &&
      fields.exchange &&
      trimmed(v.exchange).toUpperCase() !== trimmed(fields.exchange).toUpperCase()
    ) {
      return failure('exchange_mismatch', '提交的交易所与参考数据不一致；请核对后再建立标的', false);
    }

    const symbol = (fields && fields.symbol) || v.symbol;
    const lookupExchange = (fields && fields.exchange) || v.exchange || '';
    let existing;
    try {
      // 退化匹配可能命中不止一条（同代码在 NYSE / HKEX 都上市）：宁可报歧义让用户指明交易所，
      // 也不按行顺序静默合并到第一条上（那会把跨市场标的算成同一个）。
      existing =
        R.findInstrumentByKey(db, symbol, lookupExchange) || R.findInstrumentByKey(db, symbol, v.exchange || '');
    } catch (e) {
      return failure((e && e.code) || 'internal_error', (e && e.message) || '标的查找失败', false);
    }
    const merged = mergeCandidate(existing, fields);

    // 已确认的标的：本地锁定。业务字段与分类**一律不改**，只刷新来源留档与冲突提示（D-037）。
    // 这里必须显式保留 classificationStatus='confirmed'，否则一次"刷新"就会把用户确认过的
    // 分类悄悄退回未确认状态（S4B.1 的核心不变量）。
    if (existing && existing.classificationStatus === 'confirmed') {
      const kept = Object.assign({}, existing, {
        providerCandidate: fields || existing.providerCandidate,
        providerProvenance: meta.value.provenance || existing.providerProvenance,
        source: v.source,
        country: existing.country != null ? existing.country : merged.country,
        exchangeTimezone:
          existing.exchangeTimezone != null
            ? existing.exchangeTimezone
            : fields
              ? fields.exchangeTimezone
              : existing.exchangeTimezone,
        classificationStatus: 'confirmed',
        confirmedAt: existing.confirmedAt,
        createdAt: existing.createdAt,
        // 已确认标的的身份也一并锁定：id 与 identity key 都不重算（D-039）。
        identityKey: identityKeyOf(existing) || existing.identityKey
      });
      kept.conflicts = conflictsFor(kept);
      try {
        const item = writeInstrument(db, kept, now);
        return {
          ok: true,
          item: item,
          duplicated: true,
          preserved: true,
          conflicts: item.conflicts || [],
          suggestions: fields ? Domain.suggestFromProvider(fields) : []
        };
      } catch (e) {
        const code = (e && e.code) || 'internal_error';
        return failure(code, (e && e.message) || '标的写入失败', false);
      }
    }

    // 手工来源：用户填的字段作为本地值（provider 不参与覆盖）
    if (v.source === SOURCE_MANUAL) {
      ['currency', 'exchange', 'name', 'instrumentType', 'country'].forEach((f) => {
        if (v[f] != null && (merged[f] == null || merged[f] === '')) merged[f] = v[f];
      });
    }

    const currency = merged.currency || v.currency;
    if (Domain.CURRENCIES.indexOf(currency) === -1) {
      return failure('invalid_currency', '标的币种必须是 CNY/HKD/USD', false);
    }

    // 身份：已存在就沿用原 id 与 identity key（**永不重算**，即使本次补全了交易所）；
    // 新建才派生一次。客户端无法影响这个值（载荷里的 id 已被拒绝）。
    const identityKey = identityKeyOf(existing) || Domain.instrumentKey(symbol, merged.exchange);

    const record = {
      id: existing ? existing.id : stableIdFromKey(identityKey),
      identityKey: identityKey,
      symbol: symbol,
      exchange: merged.exchange,
      currency: currency,
      name: merged.name,
      instrumentType: merged.instrumentType,
      assetClass: v.assetClass != null ? v.assetClass : existing ? existing.assetClass : null,
      exposureMarket: v.exposureMarket != null ? v.exposureMarket : existing ? existing.exposureMarket : null,
      trackingIndex: v.trackingIndex != null ? v.trackingIndex : existing ? existing.trackingIndex : null,
      // 建立/刷新永远不自动确认分类：确认必须由用户显式发起（ARCHITECTURE §10 classification_unconfirmed）
      classificationStatus: 'suggested',
      source: v.source,
      country: merged.country,
      exchangeTimezone: fields
        ? fields.exchangeTimezone || (existing ? existing.exchangeTimezone : null)
        : existing
          ? existing.exchangeTimezone
          : null,
      providerCandidate: fields || (existing ? existing.providerCandidate : null),
      providerProvenance: meta.value.provenance || (existing ? existing.providerProvenance : null),
      createdAt: existing ? existing.createdAt : now,
      confirmedAt: null
    };
    record.conflicts = conflictsFor(record);

    try {
      const item = writeInstrument(db, record, now);
      return {
        ok: true,
        item: item,
        duplicated: !!existing,
        preserved: !!(existing && existing.classificationStatus === 'confirmed'),
        conflicts: item.conflicts || [],
        suggestions: fields ? Domain.suggestFromProvider(fields) : []
      };
    } catch (e) {
      const code = (e && e.code) || 'internal_error';
      return failure(code, (e && e.message) || '标的写入失败', false);
    }
  });
}

/* ------------------------------ 用户确认与锁定 ------------------------------ */

// 用户确认分类：asset_class / exposure_market（用户判断）落库并把状态锁定为 confirmed。
// 确认时用**已存的 provider 候选**算冲突，不再调用 provider（写接口不外联）。
function confirmInstrument(db, body, ctx) {
  const parsed = parseConfirmPayload(body);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const now = (ctx && ctx.now) || new Date().toISOString();

  const row = R.getInstrument(db, v.instrumentId);
  if (!row) return failure('instrument_not_found', '标的不存在：' + v.instrumentId, false);

  const record = Object.assign({}, row, {
    assetClass: v.assetClass,
    exposureMarket: v.exposureMarket,
    trackingIndex: v.trackingIndex != null ? v.trackingIndex : row.trackingIndex,
    classificationStatus: 'confirmed',
    confirmedAt: now
  });
  record.conflicts = conflictsFor(record);

  try {
    const item = writeInstrument(db, record, now);
    return { ok: true, item: item, conflicts: item.conflicts || [] };
  } catch (e) {
    const code = (e && e.code) || 'internal_error';
    return failure(code, (e && e.message) || '标的确认失败', false);
  }
}

module.exports = {
  SOURCE_PROVIDER: SOURCE_PROVIDER,
  SOURCE_MANUAL: SOURCE_MANUAL,
  stableInstrumentId: stableInstrumentId,
  stableIdFromKey: stableIdFromKey,
  identityKeyOf: identityKeyOf,
  parseCreatePayload: parseCreatePayload,
  parseConfirmPayload: parseConfirmPayload,
  providerFieldsOf: providerFieldsOf,
  conflictsFor: conflictsFor,
  searchCatalog: searchCatalog,
  createInstrument: createInstrument,
  confirmInstrument: confirmInstrument
};
