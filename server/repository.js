/* 小账本 server/repository.js — SQLite repository（Phase 2）
 *
 * 职责：把前端的全量内存状态（旧账本四键 + v3 十类资产事实集合，4C 起含 securityEvents）与 SQLite 正规表互相转换。
 *
 * 设计要点：
 *  1. 单一写入者：所有写操作都在 transaction() 内完成全量替换，因此重复写入天然幂等，不会出现半新半旧。
 *  2. 零数据丢失：每个集合只把「已建模的字段」写成真列，其余未知字段原样存入 extra_json；
 *     读取时先还原因定字段、再合并 extra_json，未知字段不会丢。
 *  3. 机构归一：领域模型的 assetAccounts.institution 是自由文本（如"香港汇丰"），
 *     落库时按名称确定性派生 institutions 行并建立 institution_id 关联，读取时还原文本。
 *  4. 加密交易：txns 若为密文对象（{enc:1,...}）则整体存入 service_meta，txns 表清空；
 *     明文数组才拆成 txns 行。锁定时磁盘上不存在明文交易（保持既有 P0 承诺）。
 *  5. 领域逻辑不复制：overview 由调用方传入 Domain.computeOverview 计算，repository 只负责取事实。
 */
'use strict';

const crypto = require('node:crypto');
const { transaction, all, get, run, tableExists } = require('./db');
const Domain = require('../js/domain.js');
const Recommendations = require('./recommendations');

// 资产集合的形状以前端 js/domain.js 为唯一来源（DECISIONS T-001：服务与浏览器共用同一份领域代码）。
// 这里不复制键名与版本号：一旦前端调整集合结构，服务端读回形状自动跟随，不会静默分叉。
const EMPTY_ASSETS = Domain.emptyAssets();
const ASSETS_SCHEMA_VERSION = EMPTY_ASSETS.schemaVersion;
const ASSET_KEYS = Object.keys(EMPTY_ASSETS).filter((k) => k !== 'schemaVersion');
const LEGACY_KEYS = ['accounts', 'categories', 'txns', 'settings'];
const TXNS_BLOB_META_KEY = 'txns_encrypted_blob';

/* ------------------------------ 通用助手 ------------------------------ */

const N = (v) => (v === undefined ? null : v);
const STR = (v) => (v === undefined || v === null ? null : String(v));
const NUM = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const BOOL = (v) => (v ? 1 : 0);
// 真实存在的日历日（与 providers/contract.isDateString 同口径，复核 G4C-5）：
// 光有形状正则会接受 '2026-02-30'、'2026-13-01' —— 事件排序和期初边界会建立在非法时间上。
const isDateStr = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

// 标的 id / 代码的形状（与目录接口同一口径）。全量写入路径也必须满足 ——
// 只靠"过滤掉不合法行"会让非法数据悄悄消失或变形（第二轮复核 G4B-5）。
const INSTRUMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INSTRUMENT_SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
const INSTRUMENT_EXCHANGE_RE = /^[A-Za-z0-9._:-]{1,32}$/;

function extraJson(obj, known) {
  const extra = {};
  Object.keys(obj || {}).forEach((k) => {
    if (known.indexOf(k) === -1) extra[k] = obj[k];
  });
  return Object.keys(extra).length ? JSON.stringify(extra) : null;
}

function mergeExtra(row, target) {
  if (row && row.extra_json) {
    try {
      const extra = JSON.parse(row.extra_json);
      Object.keys(extra).forEach((k) => {
        target[k] = extra[k];
      });
    } catch (_) {
      // extra_json 损坏时不静默丢弃：读回失败由调用方在完整性检查中暴露
    }
  }
  return target;
}

const KNOWN = {
  assetAccounts: ['id', 'name', 'kind', 'pool', 'status', 'institution'],
  assetUnits: ['id', 'accountId', 'currency', 'balanceMinor', 'asOf', 'sourceType'],
  assetTransfers: [
    'id',
    'fromUnitId',
    'toUnitId',
    'fromCurrency',
    'toCurrency',
    'fromAmountMinor',
    'toAmountMinor',
    'occurredOn',
    'sourceType',
    'note',
    'createdAt'
  ],
  liabilities: ['id', 'name', 'currency', 'balanceMinor', 'dueDate', 'termType', 'asOf', 'accountId'],
  entitlements: [
    'id',
    'name',
    'kind',
    'jurisdiction',
    'status',
    'balanceMinor',
    'valuationType',
    'asOf',
    'sourceRef'
  ],
  instruments: [
    'id',
    'symbol',
    'exchange',
    'currency',
    'name',
    'instrumentType',
    'assetClass',
    'exposureMarket',
    'classificationStatus'
  ],
  holdings: ['id', 'accountId', 'instrumentId', 'quantity', 'costMinor', 'asOf'],
  securityEvents: [
    'id',
    'accountId',
    'instrumentId',
    'eventType',
    'quantity',
    'priceMinor',
    'feeMinor',
    'amountMinor',
    'currency',
    'occurredAt'
  ],
  quotes: ['instrumentId', 'priceMinor', 'currency', 'priceDate', 'fetchedAt', 'provider', 'status', 'sourceSymbol'],
  fxRates: ['base', 'quote', 'rateDecimal', 'rateDate', 'fetchedAt', 'provider', 'status'],
  // Phase 5B：/state 顶层独立集合（不并入 assets）；行字段白名单由领域层
  // validateRiskAssessmentRecord 精确自有键校验，这里只登记形状。
  riskAssessments: [
    'id', 'ruleVersion', 'answers', 'capacityScore', 'willingnessScore',
    'capacityLevel', 'willingnessLevel', 'ceiling', 'ceilingSource', 'hardCaps',
    'explainCodes', 'assessedAt', 'expiry', 'reason', 'createdAt'
  ],
  // Phase 5C：/state 顶层独立集合。目标版本承载派生值与所引用评估，
  // 认可标的承载用户判断；两者的字段白名单由领域层精确自有键校验，这里只登记形状。
  allocationTargets: [
    'id', 'templateVersion', 'ruleVersion', 'level', 'classes',
    'assessmentId', 'assessedAt', 'assessmentExpiry', 'effectiveFrom', 'createdAt'
  ],
  approvedInstruments: ['id', 'assetClass', 'instrumentId', 'position', 'createdAt', 'updatedAt'],
  accounts: ['id', 'name', 'type', 'color', 'initialBalance', 'order', 'aliases', 'deleted'],
  categories: ['id', 'type', 'name', 'icon', 'parent', 'keywords'],
  txns: [
    'id',
    'date',
    'time',
    'type',
    'amount',
    'account',
    'accountTo',
    'category',
    'merchant',
    'note',
    'source',
    'rawId',
    'status',
    'mappedTo',
    'refundFlag',
    'transferHalf'
  ]
};

function institutionIdFor(name) {
  return 'inst-' + crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 16);
}

/* ------------------------------ 写入：机构与资产账户 ------------------------------ */

function writeInstitutionsAndAccounts(db, list, ctx) {
  const insStmt = db.prepare(
    'INSERT INTO institutions (id, name, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING'
  );
  const findIns = db.prepare('SELECT id FROM institutions WHERE name = ?');
  const accStmt = db.prepare(
    `INSERT INTO asset_accounts (id, institution_id, name, kind, pool, status, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const now = ctx.now;
  (list || []).forEach((a) => {
    if (!a || !a.id) return;
    let institutionId = null;
    const text = typeof a.institution === 'string' ? a.institution.trim() : '';
    if (text) {
      insStmt.run(institutionIdFor(text), text, STR(a.kind) || 'other', now);
      const row = findIns.get(text);
      institutionId = row ? row.id : null;
    }
    accStmt.run(
      String(a.id),
      institutionId,
      STR(a.name) || '',
      STR(a.kind) || 'other',
      STR(a.pool) || 'safety',
      STR(a.status) || 'active',
      extraJson(a, KNOWN.assetAccounts)
    );
  });
}

function readAssetAccounts(db) {
  const ins = {};
  all(db, 'SELECT id, name FROM institutions').forEach((r) => {
    ins[r.id] = r.name;
  });
  return all(db, 'SELECT * FROM asset_accounts ORDER BY rowid').map((row) => {
    const out = { id: row.id, name: row.name, kind: row.kind, pool: row.pool, status: row.status };
    if (row.institution_id && ins[row.institution_id]) out.institution = ins[row.institution_id];
    return mergeExtra(row, out);
  });
}

/* ------------------------------ 写入：其余资产集合 ------------------------------ */

function writeAssetUnits(db, list) {
  const st = db.prepare(
    `INSERT INTO account_units (id, account_id, currency, balance_minor, as_of, source_type, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  (list || []).forEach((u) => {
    if (!u || !u.id) return;
    st.run(
      String(u.id),
      String(u.accountId),
      STR(u.currency) || 'CNY',
      NUM(u.balanceMinor),
      STR(u.asOf),
      STR(u.sourceType),
      extraJson(u, KNOWN.assetUnits)
    );
  });
}

function readAssetUnits(db) {
  return all(db, 'SELECT * FROM account_units ORDER BY rowid').map((row) => {
    const out = {
      id: row.id,
      accountId: row.account_id,
      currency: row.currency,
      balanceMinor: row.balance_minor,
      asOf: row.as_of,
      sourceType: row.source_type
    };
    return mergeExtra(row, out);
  });
}

function writeAssetTransfers(db, list, options) {
  const opts = options || {};
  // 币种绝不采信载荷里的重复字段：两端币种一律由关联余额单元推导（D-034）。
  // 全量写入路径过去直接信任载荷中的 fromCurrency/toCurrency，实测可以写出
  // 「转出单元实际是 HKD、记录却写 USD→HKD」这类与事实矛盾的历史；这里改为
  // 缺失单元或同币种直接拒绝，让不一致的数据无法落库。
  const unitCurrency = {};
  all(db, 'SELECT id, currency FROM account_units').forEach((row) => {
    unitCurrency[String(row.id)] = row.currency;
  });
  const st = db.prepare(
    `INSERT INTO asset_transfers
       (id, from_unit_id, to_unit_id, from_currency, to_currency,
        from_amount_minor, to_amount_minor, occurred_on, source_type, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  (list || []).forEach((t) => {
    if (!t || !t.id) return;
    const fromId = String(t.fromUnitId);
    const toId = String(t.toUnitId);
    if (fromId === toId) {
      throw Object.assign(new Error('换汇转出与转入子账户不能相同'), { code: 'same_unit' });
    }
    const fromCurrency = unitCurrency[fromId];
    const toCurrency = unitCurrency[toId];
    if (!fromCurrency || !toCurrency) {
      throw Object.assign(
        new Error('换汇关联的币种子账户不存在：' + (fromCurrency ? toId : fromId)),
        { code: 'unknown_unit' }
      );
    }
    if (fromCurrency === toCurrency) {
      throw Object.assign(new Error('换汇两端必须使用不同币种'), { code: 'same_currency' });
    }
    st.run(
      String(t.id),
      fromId,
      toId,
      fromCurrency,
      toCurrency,
      NUM(t.fromAmountMinor),
      NUM(t.toAmountMinor),
      String(t.occurredOn),
      STR(t.sourceType) || 'manual',
      STR(t.note),
      STR(t.createdAt) || opts.now || new Date().toISOString()
    );
  });
}

function readAssetTransfers(db) {
  return all(db, 'SELECT * FROM asset_transfers ORDER BY occurred_on DESC, created_at DESC').map((row) => ({
    id: row.id,
    fromUnitId: row.from_unit_id,
    toUnitId: row.to_unit_id,
    fromCurrency: row.from_currency,
    toCurrency: row.to_currency,
    fromAmountMinor: row.from_amount_minor,
    toAmountMinor: row.to_amount_minor,
    occurredOn: row.occurred_on,
    sourceType: row.source_type,
    note: row.note,
    createdAt: row.created_at
  }));
}

function writeLiabilities(db, list) {
  const st = db.prepare(
    `INSERT INTO liabilities (id, account_id, name, currency, balance_minor, due_date, term_type, as_of, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  (list || []).forEach((l) => {
    if (!l || !l.id) return;
    st.run(
      String(l.id),
      l.accountId ? String(l.accountId) : null,
      STR(l.name) || '',
      STR(l.currency) || 'CNY',
      NUM(l.balanceMinor),
      STR(l.dueDate),
      STR(l.termType),
      STR(l.asOf),
      extraJson(l, KNOWN.liabilities)
    );
  });
}

function readLiabilities(db) {
  return all(db, 'SELECT * FROM liabilities ORDER BY rowid').map((row) => {
    const out = {
      id: row.id,
      name: row.name,
      currency: row.currency,
      balanceMinor: row.balance_minor,
      termType: row.term_type,
      asOf: row.as_of
    };
    if (row.account_id) out.accountId = row.account_id;
    if (row.due_date) out.dueDate = row.due_date;
    return mergeExtra(row, out);
  });
}

function writeEntitlements(db, list) {
  const st = db.prepare(
    `INSERT INTO entitlements (id, name, kind, jurisdiction, status, balance_minor, valuation_type, as_of, source_ref, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  (list || []).forEach((e) => {
    if (!e || !e.id) return;
    st.run(
      String(e.id),
      STR(e.name) || '',
      STR(e.kind) || '',
      STR(e.jurisdiction),
      STR(e.status),
      NUM(e.balanceMinor),
      STR(e.valuationType),
      STR(e.asOf),
      STR(e.sourceRef),
      extraJson(e, KNOWN.entitlements)
    );
  });
}

function readEntitlements(db) {
  return all(db, 'SELECT * FROM entitlements ORDER BY rowid').map((row) => {
    const out = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      balanceMinor: row.balance_minor,
      asOf: row.as_of
    };
    if (row.jurisdiction) out.jurisdiction = row.jurisdiction;
    if (row.status) out.status = row.status;
    if (row.valuation_type) out.valuationType = row.valuation_type;
    if (row.source_ref) out.sourceRef = row.source_ref;
    return mergeExtra(row, out);
  });
}

// 全量写入（PUT /state、JSON 恢复、备份还原）必须与目录接口遵守同一条不变量：
// 同一 (symbol, exchange) 只允许一行事实。
//
// **整体拒绝**而不是静默丢行（第二轮复核 G4B-5）：早期实现用 `.filter((i) => i && i.id)` 把没有 id
// 的记录悄悄扔掉、把空白代码写成空字符串 —— 用户看不到任何错误，却少了数据。现在写入前逐条验证
// id / symbol / currency，任一条不合格就抛错，由外层事务整体回滚（writeState 全程在一个事务内）。
// 数据库侧另有 uq_instruments_dedupe 唯一索引兜底（迁移 v4）。
function writeInstruments(db, list) {
  const rows = Array.isArray(list) ? list : [];
  const byId = {};
  const byKey = {};

  // 第一遍：逐条验证并归一（不合格立即抛错 → 整体回滚，绝不静默丢行）
  const normalized = rows.map((i, idx) => {
    const at = '第 ' + (idx + 1) + ' 条';
    if (!i || typeof i !== 'object' || Array.isArray(i)) {
      throw Object.assign(new Error('标的记录必须是对象（' + at + '）'), { code: 'invalid_instrument' });
    }
    const id = i.id == null ? '' : String(i.id).trim();
    if (!id) throw Object.assign(new Error('标的缺少 id（' + at + '）'), { code: 'invalid_id' });
    if (!INSTRUMENT_ID_RE.test(id)) {
      throw Object.assign(new Error('标的 id 不合法（' + at + '）'), { code: 'invalid_id' });
    }
    if (byId[id]) {
      throw Object.assign(new Error('标的 id 重复写入：' + id), { code: 'duplicate_instrument' });
    }
    byId[id] = true;

    const symbol = i.symbol == null ? '' : String(i.symbol).trim().toUpperCase();
    if (!INSTRUMENT_SYMBOL_RE.test(symbol)) {
      throw Object.assign(new Error('标的代码不合法（' + at + '）：需为公开证券代码形状'), {
        code: 'invalid_symbol'
      });
    }

    // 币种是估值必需字段：缺失或不在白名单一律拒绝，不用"默认 CNY"蒙过去
    const currency = i.currency == null ? '' : String(i.currency).trim().toUpperCase();
    if (Domain.CURRENCIES.indexOf(currency) === -1) {
      throw Object.assign(new Error('标的币种必须是 CNY/HKD/USD（' + at + '）'), { code: 'invalid_currency' });
    }

    const exchangeText = i.exchange == null ? '' : String(i.exchange).trim();
    if (exchangeText && !INSTRUMENT_EXCHANGE_RE.test(exchangeText)) {
      throw Object.assign(new Error('标的交易所标识不合法（' + at + '）'), { code: 'invalid_exchange' });
    }
    const exchange = exchangeText ? exchangeText.toUpperCase() : null;

    const statusText = i.classificationStatus == null || i.classificationStatus === ''
      ? 'suggested'
      : String(i.classificationStatus).trim();
    if (statusText !== 'suggested' && statusText !== 'confirmed') {
      throw Object.assign(new Error('标的分类状态不合法（' + at + '）'), { code: 'invalid_classification_status' });
    }
    const assetClass = i.assetClass == null || i.assetClass === '' ? null : String(i.assetClass).trim();
    const exposureMarket = i.exposureMarket == null || i.exposureMarket === ''
      ? null
      : String(i.exposureMarket).trim();
    if (assetClass != null && !Domain.isAssetClass(assetClass)) {
      throw Object.assign(new Error('标的资产类别不在允许词表内（' + at + '）'), { code: 'invalid_asset_class' });
    }
    if (exposureMarket != null && !Domain.isExposureMarket(exposureMarket)) {
      throw Object.assign(new Error('标的风险敞口市场不在允许词表内（' + at + '）'), {
        code: 'invalid_exposure_market'
      });
    }
    if (statusText === 'confirmed' && (assetClass == null || exposureMarket == null)) {
      throw Object.assign(new Error('已确认标的必须同时包含资产类别与风险敞口市场（' + at + '）'), {
        code: assetClass == null ? 'invalid_asset_class' : 'invalid_exposure_market'
      });
    }

    return {
      raw: i,
      id: id,
      symbol: symbol,
      exchange: exchange,
      currency: currency,
      classificationStatus: statusText,
      assetClass: assetClass,
      exposureMarket: exposureMarket
    };
  });

  // 第二遍：去重键（与领域口径一致：symbol / exchange 去空白后大写，缺交易所按空串参与）
  normalized.forEach((n) => {
    const key = Domain.instrumentKey(n.symbol, n.exchange);
    if (byKey[key]) {
      throw Object.assign(
        new Error('同一标的重复写入：' + key + '（' + byKey[key] + ' 与 ' + n.id + '）'),
        { code: 'duplicate_instrument' }
      );
    }
    byKey[key] = n.id;
  });

  const st = db.prepare(
    `INSERT INTO instruments (id, symbol, exchange, currency, name, instrument_type, asset_class, exposure_market, classification_status, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  normalized.forEach((n) => {
    const i = n.raw;
    st.run(
      n.id,
      n.symbol,
      n.exchange,
      n.currency,
      STR(i.name),
      STR(i.instrumentType),
      n.assetClass,
      n.exposureMarket,
      n.classificationStatus,
      extraJson(i, KNOWN.instruments)
    );
  });
}

function readInstruments(db) {
  return all(db, 'SELECT * FROM instruments ORDER BY rowid').map((row) => {
    const out = {
      id: row.id,
      symbol: row.symbol,
      currency: row.currency,
      classificationStatus: row.classification_status
    };
    if (row.exchange) out.exchange = row.exchange;
    if (row.name) out.name = row.name;
    if (row.instrument_type) out.instrumentType = row.instrument_type;
    if (row.asset_class) out.assetClass = row.asset_class;
    if (row.exposure_market) out.exposureMarket = row.exposure_market;
    return mergeExtra(row, out);
  });
}

/* -------- 标的单条写入（Phase 4B）：稳定 id、按去重键保证同一标的只有一行 -------- */

// 标的的业务列（其余字段一律进 extra_json，保持零丢失）。
const INSTRUMENT_COLUMNS = [
  'id', 'symbol', 'exchange', 'currency', 'name',
  'instrument_type', 'asset_class', 'exposure_market', 'classification_status'
];

// 完整还原一行标的（含 null 字段），供目录模块做比较/合并。
// 公开读取接口 readInstruments 保持既有形状不变（只在有值时给出可选字段）。
function hydrateInstrument(row) {
  const out = {
    id: row.id,
    symbol: row.symbol,
    exchange: row.exchange,
    currency: row.currency,
    name: row.name,
    instrumentType: row.instrument_type,
    assetClass: row.asset_class,
    exposureMarket: row.exposure_market,
    classificationStatus: row.classification_status
  };
  return mergeExtra(row, out);
}

function readInstrumentRecords(db) {
  return all(db, 'SELECT * FROM instruments ORDER BY rowid').map(hydrateInstrument);
}

function getInstrument(db, id) {
  if (!id) return null;
  const row = get(db, 'SELECT * FROM instruments WHERE id = ?', [String(id)]);
  return row ? hydrateInstrument(row) : null;
}

// 按去重键找已有标的：先精确匹配 (symbol@exchange)，再退化为「同一代码且任一方交易所为空」。
// 退化匹配是为了避免"先手工建标的、后由 provider 补全交易所"时凭空多出第二行事实。
// 但同一代码可能在多个交易所都上市（NYSE / HKEX ...）：此时**必须报歧义**——
// 按行顺序静默选中第一条会把跨市场标的合并错，而且结果取决于数据库行顺序。
function findInstrumentByKey(db, symbol, exchange) {
  const records = readInstrumentRecords(db);
  const want = Domain.instrumentKey(symbol, exchange);
  if (!want) return null;

  const exact = records.filter((r) => Domain.instrumentKey(r.symbol, r.exchange) === want);
  if (exact.length > 1) {
    // 唯一索引下不应出现；真出现说明库被手工改过，必须暴露而不是任选一行。
    throw Object.assign(new Error('同一标的在目录中存在重复记录：' + want), { code: 'duplicate_instrument' });
  }
  if (exact.length === 1) return exact[0];

  const sym = String(symbol == null ? '' : symbol).trim().toUpperCase();
  const loose = records.filter(
    (r) => String(r.symbol || '').trim().toUpperCase() === sym && (!r.exchange || !exchange)
  );
  if (loose.length > 1) {
    throw Object.assign(
      new Error(
        '该代码在多个交易所都有记录（' +
          loose.map((r) => (r.exchange ? String(r.exchange) : '未注明交易所')).join(' / ') +
          '），请指明交易所后再操作'
      ),
      { code: 'ambiguous_instrument' }
    );
  }
  return loose.length === 1 ? loose[0] : null;
}

// 单条标的 upsert：
//   - 以 id 为冲突键（同 id 重复提交即幂等更新）；
//   - 以 (symbol, exchange) 为去重键：写入前删除同键的其他 id 行，
//     从写入路径上保证"同一标的不重复创建事实"（而不是靠调用方自觉）；
//   - 未知字段进 extra_json，读回时零丢失。
function upsertInstrument(db, item, options) {
  const opts = options || {};
  if (!item || !item.id) throw Object.assign(new Error('缺少标的 id'), { code: 'invalid_id' });
  const id = String(item.id);
  if (!INSTRUMENT_ID_RE.test(id)) throw Object.assign(new Error('标的 id 不合法'), { code: 'invalid_id' });
  const symbol = STR(item.symbol || '').trim().toUpperCase();
  if (!symbol) throw Object.assign(new Error('标的代码不能为空'), { code: 'invalid_symbol' });
  if (!INSTRUMENT_SYMBOL_RE.test(symbol)) {
    throw Object.assign(new Error('标的代码不合法：需为公开证券代码形状'), { code: 'invalid_symbol' });
  }
  const exchangeText = item.exchange == null ? '' : String(item.exchange).trim();
  if (exchangeText && !INSTRUMENT_EXCHANGE_RE.test(exchangeText)) {
    throw Object.assign(new Error('标的交易所标识不合法'), { code: 'invalid_exchange' });
  }
  const exchange = exchangeText ? exchangeText.toUpperCase() : null;
  const currency = item.currency == null ? '' : String(item.currency).trim().toUpperCase();
  if (Domain.CURRENCIES.indexOf(currency) === -1) {
    throw Object.assign(new Error('标的币种必须是 CNY/HKD/USD'), { code: 'invalid_currency' });
  }
  const status = item.classificationStatus == null || item.classificationStatus === ''
    ? 'suggested'
    : String(item.classificationStatus).trim();
  if (status !== 'suggested' && status !== 'confirmed') {
    throw Object.assign(new Error('标的分类状态不合法'), { code: 'invalid_classification_status' });
  }
  const assetClass = item.assetClass == null || item.assetClass === '' ? null : String(item.assetClass).trim();
  const exposureMarket = item.exposureMarket == null || item.exposureMarket === ''
    ? null
    : String(item.exposureMarket).trim();
  if (assetClass != null && !Domain.isAssetClass(assetClass)) {
    throw Object.assign(new Error('标的资产类别不在允许词表内'), { code: 'invalid_asset_class' });
  }
  if (exposureMarket != null && !Domain.isExposureMarket(exposureMarket)) {
    throw Object.assign(new Error('标的风险敞口市场不在允许词表内'), { code: 'invalid_exposure_market' });
  }
  if (status === 'confirmed' && (assetClass == null || exposureMarket == null)) {
    throw Object.assign(new Error('已确认标的必须同时包含资产类别与风险敞口市场'), {
      code: assetClass == null ? 'invalid_asset_class' : 'invalid_exposure_market'
    });
  }

  // 去重键：同一 (symbol, exchange) 只允许一行。
  // 这里**不静默删除**冲突行 —— 那会连带丢掉已确认的分类；改为显式报错，
  // 由调用方先用 findInstrumentByKey 解析出既有标的后再写入（catalog 模块就是这么做的）。
  const key = Domain.instrumentKey(symbol, exchange);
  const clash = readInstrumentRecords(db).find(
    (r) => r.id !== id && Domain.instrumentKey(r.symbol, r.exchange) === key
  );
  if (clash) {
    throw Object.assign(new Error('同一标的已存在：' + clash.id), { code: 'duplicate_instrument' });
  }

  const extra = {
    trackingIndex: item.trackingIndex == null ? null : String(item.trackingIndex),
    source: item.source == null ? null : String(item.source),
    // 身份 key（D-039）：首次创建时派生、之后永久不变；id 可由它离线复算
    // （补全交易所后 id 不重算，因此不能用"当前交易所"反推）。
    identityKey: item.identityKey == null ? null : String(item.identityKey),
    country: item.country == null ? null : String(item.country),
    exchangeTimezone: item.exchangeTimezone == null ? null : String(item.exchangeTimezone),
    providerCandidate: item.providerCandidate || null,
    providerProvenance: item.providerProvenance || null,
    conflicts: item.conflicts || null,
    createdAt: item.createdAt || opts.now || new Date().toISOString(),
    updatedAt: opts.now || new Date().toISOString(),
    confirmedAt: item.confirmedAt || null
  };
  Object.keys(extra).forEach((k) => {
    if (extra[k] === null || extra[k] === undefined) delete extra[k];
  });

  // 不能用“先删后插”模拟 upsert：instruments 是持仓、事件、报价的父表，DELETE 会触发
  // ON DELETE CASCADE，把 4C/4D 已存在的事实一并删掉。原位 UPDATE 才能保持稳定 id 的引用语义。
  run(
    db,
    `INSERT INTO instruments (id, symbol, exchange, currency, name, instrument_type, asset_class, exposure_market, classification_status, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       symbol = excluded.symbol,
       exchange = excluded.exchange,
       currency = excluded.currency,
       name = excluded.name,
       instrument_type = excluded.instrument_type,
       asset_class = excluded.asset_class,
       exposure_market = excluded.exposure_market,
       classification_status = excluded.classification_status,
       extra_json = excluded.extra_json`,
    [
      id,
      symbol,
      exchange,
      currency,
      STR(item.name),
      STR(item.instrumentType),
      assetClass,
      exposureMarket,
      status,
      Object.keys(extra).length ? JSON.stringify(extra) : null
    ]
  );
  return hydrateInstrument(get(db, 'SELECT * FROM instruments WHERE id = ?', [id]));
}

// 期初快照逐字段校验（单条 upsert 与全量写入**共用同一套口径**，复核 G4C-3——
// 两条路径校验分叉是 4B 已踩过的坑：当初单条要求 currency、全量却 || 'CNY' 兜底）：
//   - 必须是对象；id 必填且符合形状；
//   - accountId / instrumentId 必填且真实存在（unknown_account / unknown_instrument）；
//   - quantity 必须为正定点数；costMinor 可选非负整数；asOf 可选真实日历日。
// 返回归一化后的行（quantity 去空白、asOf 归一为字符串或 null），非法即抛领域错误。
function validateOpeningRow(db, o, at) {
  const where = at || '该期初快照';
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    throw Object.assign(new Error('期初快照必须是对象（' + where + '）'), { code: 'invalid_opening' });
  }
  const id = o.id == null ? '' : String(o.id).trim();
  if (!id || !OPENING_ID_RE.test(id)) {
    throw Object.assign(new Error('期初快照 id 不合法（' + where + '）'), { code: 'invalid_id' });
  }
  if (!o.accountId || !o.instrumentId) {
    throw Object.assign(new Error('期初快照必须同时指向账户与标的（' + where + '）'), { code: 'invalid_opening' });
  }
  const account = get(db, 'SELECT id, kind FROM asset_accounts WHERE id = ?', [String(o.accountId)]);
  if (!account) {
    throw Object.assign(new Error('期初快照关联的账户不存在（' + where + '）'), { code: 'unknown_account' });
  }
  if (account.kind !== 'broker') {
    throw Object.assign(new Error('期初持仓只能关联证券账户（kind=broker）（' + where + '）'), {
      code: 'invalid_account_type'
    });
  }
  if (!get(db, 'SELECT id FROM instruments WHERE id = ?', [String(o.instrumentId)])) {
    throw Object.assign(new Error('期初快照关联的标的不存在（' + where + '）'), { code: 'unknown_instrument' });
  }
  const q = Domain.parseDecimal(o.quantity);
  if (!q || !(q.v > 0)) {
    throw Object.assign(new Error('期初数量必须为正定点数（' + where + '）'), { code: 'invalid_quantity' });
  }
  if (o.costMinor != null && (!Number.isSafeInteger(o.costMinor) || o.costMinor < 0)) {
    throw Object.assign(new Error('期初成本必须是非负整数（最小货币单位）（' + where + '）'), { code: 'invalid_amount' });
  }
  if (o.asOf != null && !isDateStr(o.asOf)) {
    throw Object.assign(new Error('期初核对日期必须是真实存在的 YYYY-MM-DD（' + where + '）'), { code: 'invalid_date' });
  }
  return {
    id: id,
    accountId: String(o.accountId),
    instrumentId: String(o.instrumentId),
    quantity: String(o.quantity).trim(),
    costMinor: o.costMinor == null ? null : o.costMinor,
    asOf: o.asOf == null ? null : String(o.asOf),
    extra: extraJson(o, KNOWN.holdings)
  };
}

function insertOpeningRow(db, row) {
  run(
    db,
    `INSERT INTO portfolio_openings (id, account_id, instrument_id, quantity, cost_minor, as_of, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.accountId, row.instrumentId, row.quantity, row.costMinor, row.asOf, row.extra]
  );
}

// 全量写入路径（PUT /state、JSON 恢复、备份还原）：与单条 upsert 同一套校验（G4C-3）。
// 两遍写入：第一遍逐条验证归一（缺 id / 非法数量 / 未知引用一律抛错，绝不静默丢行或
// 变形落库），同 id 与同 (账户, 标的) 键在第一遍即拒绝；第二遍才插入，由调用方事务
// 整体回滚。数据库层另有 v6 唯一索引 uq_portfolio_openings_dedupe 兜底。
function writeOpenings(db, list) {
  const rows = Array.isArray(list) ? list : [];
  const seenId = {};
  const seenKey = {};
  const normalized = rows.map((o, idx) => {
    const row = validateOpeningRow(db, o, '第 ' + (idx + 1) + ' 条');
    if (seenId[row.id]) {
      throw Object.assign(new Error('期初快照 id 重复写入：' + row.id + '（第 ' + (idx + 1) + ' 条）'), {
        code: 'duplicate_opening'
      });
    }
    seenId[row.id] = true;
    const key = row.accountId + '|' + row.instrumentId;
    if (seenKey[key]) {
      throw Object.assign(
        new Error('同一账户下同一标的只能有一行期初快照：' + row.accountId + ' / ' + row.instrumentId + '（第 ' + (idx + 1) + ' 条）'),
        { code: 'duplicate_opening' }
      );
    }
    seenKey[key] = true;
    return row;
  });
  normalized.forEach((row) => insertOpeningRow(db, row));
}

function readOpenings(db) {
  return all(db, 'SELECT * FROM portfolio_openings ORDER BY rowid').map((row) => {
    const out = {
      id: row.id,
      accountId: row.account_id,
      instrumentId: row.instrument_id,
      quantity: row.quantity,
      costMinor: row.cost_minor,
      asOf: row.as_of
    };
    return mergeExtra(row, out);
  });
}

/* ------------------------ 证券事件（Phase 4C，D-042） ------------------------ */

const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPENING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 读回全部证券事件（occurred_at 升序，便于重放与展示）。
function readSecurityEvents(db) {
  return all(db, 'SELECT * FROM security_events ORDER BY occurred_at ASC, rowid ASC').map((row) => {
    const out = {
      id: row.id,
      accountId: row.account_id,
      instrumentId: row.instrument_id,
      eventType: row.event_type,
      quantity: row.quantity,
      priceMinor: row.price_minor,
      feeMinor: row.fee_minor,
      amountMinor: row.amount_minor,
      currency: row.currency,
      occurredAt: row.occurred_at
    };
    return mergeExtra(row, out);
  });
}

// 单条事件写入前的逐字段校验（api 层已做形状校验，这里做领域校验——同一套口径两道闸）：
//   - 事件类型在词表内；occurred_at 是 YYYY-MM-DD；
//   - buy/sell：quantity 必填且为正定点数（≤8 位小数），amount_minor 禁止携带（不冗余落库）；
//   - dividend/fee：amount_minor 必填且为正整数（最小货币单位），quantity 可选；
//   - price_minor / fee_minor 可选非负整数；
//   - 币种由标的 currency 推导，不采信载荷冗余字段（D-034/D-042）。
function validateEventRow(db, e, at) {
  const where = at || '该事件';
  if (!e || typeof e !== 'object' || Array.isArray(e)) {
    throw Object.assign(new Error('证券事件必须是对象（' + where + '）'), { code: 'invalid_event' });
  }
  const id = e.id == null ? '' : String(e.id).trim();
  if (!id) throw Object.assign(new Error('证券事件缺少 id（' + where + '）'), { code: 'invalid_id' });
  if (!EVENT_ID_RE.test(id)) {
    throw Object.assign(new Error('证券事件 id 不合法（' + where + '）'), { code: 'invalid_id' });
  }
  if (!e.accountId || !e.instrumentId) {
    throw Object.assign(new Error('证券事件必须同时指向账户与标的（' + where + '）'), { code: 'invalid_event' });
  }
  const account = get(db, 'SELECT id, kind FROM asset_accounts WHERE id = ?', [String(e.accountId)]);
  if (!account) {
    throw Object.assign(new Error('事件关联的账户不存在（' + where + '）'), { code: 'unknown_account' });
  }
  if (account.kind !== 'broker') {
    throw Object.assign(new Error('证券事件只能关联证券账户（kind=broker）（' + where + '）'), {
      code: 'invalid_account_type'
    });
  }
  if (!get(db, 'SELECT id FROM instruments WHERE id = ?', [String(e.instrumentId)])) {
    throw Object.assign(new Error('事件关联的标的不存在（' + where + '）'), { code: 'unknown_instrument' });
  }
  const eventType = String(e.eventType || '').trim();
  if (Domain.SECURITY_EVENT_TYPES.indexOf(eventType) === -1) {
    throw Object.assign(new Error('证券事件类型不在词表内：' + eventType + '（' + where + '）'), {
      code: 'invalid_event_type'
    });
  }
  if (!isDateStr(e.occurredAt)) {
    throw Object.assign(new Error('事件日期必须是 YYYY-MM-DD（' + where + '）'), { code: 'invalid_event_date' });
  }
  let quantity = null;
  if (eventType === 'buy' || eventType === 'sell') {
    const q = Domain.parseDecimal(e.quantity);
    if (!q || !(q.v > 0)) {
      throw Object.assign(new Error('买卖事件的数量必须为正定点数（' + where + '）'), { code: 'invalid_quantity' });
    }
    if (e.amountMinor != null) {
      throw Object.assign(new Error('买卖事件不得携带总额 amountMinor（金额由数量×单价推导）'), {
        code: 'invalid_event_amount'
      });
    }
    quantity = String(e.quantity).trim();
  } else {
    if (!Number.isSafeInteger(e.amountMinor) || e.amountMinor <= 0) {
      throw Object.assign(new Error('分红/费用事件的总额必须是正整数（最小货币单位）'), {
        code: 'invalid_event_amount'
      });
    }
    if (e.quantity != null && String(e.quantity).trim() !== '') {
      const q = Domain.parseDecimal(e.quantity);
      if (!q || !(q.v > 0)) {
        throw Object.assign(new Error('分红/费用事件携带数量时必须为正定点数（' + where + '）'), {
          code: 'invalid_quantity'
        });
      }
      quantity = String(e.quantity).trim();
    }
  }
  if (e.priceMinor != null && (!Number.isSafeInteger(e.priceMinor) || e.priceMinor < 0)) {
    throw Object.assign(new Error('每股价格必须是非负整数（' + where + '）'), { code: 'invalid_amount' });
  }
  if (e.feeMinor != null && (!Number.isSafeInteger(e.feeMinor) || e.feeMinor < 0)) {
    throw Object.assign(new Error('手续费必须是非负整数（' + where + '）'), { code: 'invalid_amount' });
  }
  return {
    id: id,
    accountId: String(e.accountId),
    instrumentId: String(e.instrumentId),
    eventType: eventType,
    quantity: quantity,
    priceMinor: e.priceMinor == null ? null : e.priceMinor,
    feeMinor: e.feeMinor == null ? null : e.feeMinor,
    amountMinor: eventType === 'buy' || eventType === 'sell' ? null : e.amountMinor,
    occurredAt: String(e.occurredAt),
    // 未知扩展字段必须随全量写入/备份往返保留；currency 属于可推导冗余字段，
    // 已列入 KNOWN，绝不进入 extra_json 覆盖数据库从标的推导出的币种。
    extra: extraJson(e, KNOWN.securityEvents)
  };
}

function insertEventRow(db, ev) {
  // 币种由标的推导：事件行的 currency 只用于展示与审计，绝不影响估值折算（估值取标的币种）
  const ins = get(db, 'SELECT currency FROM instruments WHERE id = ?', [ev.instrumentId]);
  run(
    db,
    `INSERT INTO security_events
       (id, account_id, instrument_id, event_type, quantity, price_minor, fee_minor, amount_minor, currency, occurred_at, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ev.id,
      ev.accountId,
      ev.instrumentId,
      ev.eventType,
      ev.quantity,
      ev.priceMinor,
      ev.feeMinor,
      ev.amountMinor,
      ins ? ins.currency : null,
      ev.occurredAt,
      ev.extra
    ]
  );
}

// 单条事件 upsert（POST /api/v1/security-events，调用方负责 transaction）：
//   - 同 id 重放 → duplicate_event（409，明确拒绝，不静默吞）——HTTP 层重试用 Idempotency-Key；
//   - 账户/标的不存在 → unknown_account / unknown_instrument（422）；
//   - 写入前用 deriveHoldings(strict) 全量重放：卖出超过当时推导数量 → insufficient_holdings（409）。
function upsertSecurityEvent(db, e) {
  const ev = validateEventRow(db, e);
  if (get(db, 'SELECT id FROM security_events WHERE id = ?', [ev.id])) {
    throw Object.assign(new Error('证券事件已存在：' + ev.id + '（同一事件不得重复提交）'), {
      code: 'duplicate_event'
    });
  }
  insertEventRow(db, ev);
  // 全量重放校验：唯一推导实现 + strict 卖出检查（D-025），不合格即抛错回滚
  Domain.deriveHoldings(readOpenings(db), readSecurityEvents(db), { strict: true });
  return getSecurityEvent(db, ev.id);
}

function getSecurityEvent(db, id) {
  const row = get(db, 'SELECT * FROM security_events WHERE id = ?', [String(id)]);
  if (!row) return null;
  return readSecurityEvents(db).find((e) => e.id === String(id)) || null;
}

// 期初快照单条写入（POST /api/v1/portfolio-openings，调用方负责 transaction）：
//   - 同 id 幂等更新；同一 (accountId, instrumentId) 出现第二行 → duplicate_opening（409）；
//   - 逐字段校验与全量写入共用 validateOpeningRow（G4C-3）；
//   - 写入后（新建或更新都一样）在同一事务内做 strict 全时间线重放（G4C-2）：
//     降低期初数量可能让既有卖出变成超额事件、移动 asOf 会改变日期边界——
//     任何导致矛盾账本的期初修改都在这里被拒绝并随事务回滚，绝不落库。
function upsertPortfolioOpening(db, o) {
  const row = validateOpeningRow(db, o);
  const clash = get(
    db,
    'SELECT id FROM portfolio_openings WHERE account_id = ? AND instrument_id = ? AND id <> ?',
    [row.accountId, row.instrumentId, row.id]
  );
  if (clash) {
    throw Object.assign(
      new Error('该账户下同一标的已有期初快照：' + clash.id + '（同一持仓只能有一行期初事实）'),
      { code: 'duplicate_opening' }
    );
  }
  run(
    db,
    `INSERT INTO portfolio_openings (id, account_id, instrument_id, quantity, cost_minor, as_of, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id,
       instrument_id = excluded.instrument_id,
       quantity = excluded.quantity,
       cost_minor = excluded.cost_minor,
       as_of = excluded.as_of,
       extra_json = excluded.extra_json`,
    [row.id, row.accountId, row.instrumentId, row.quantity, row.costMinor, row.asOf, row.extra]
  );
  // strict 重放（D-042 ①/D-025）：唯一推导实现 + 卖出不越界，失败抛错由事务整体回滚
  Domain.deriveHoldings(readOpenings(db), readSecurityEvents(db), { strict: true });
  return readOpenings(db).find((h) => h.id === row.id) || null;
}

// 全量写入路径（PUT /state、JSON 恢复、备份还原）：与单条写入同一套校验口径，
// 逐条验证（不合格整体抛错回滚，绝不静默丢行——与 writeInstruments 同纪律），
// id 重复 → duplicate_event；最后以 strict 重放守住"任何时刻持有数量不为负"。
function writeSecurityEvents(db, list) {
  const rows = Array.isArray(list) ? list : [];
  const seen = {};
  const normalized = rows.map((e, idx) => {
    const ev = validateEventRow(db, e, '第 ' + (idx + 1) + ' 条');
    if (seen[ev.id]) {
      throw Object.assign(new Error('证券事件 id 重复写入：' + ev.id), { code: 'duplicate_event' });
    }
    seen[ev.id] = true;
    return ev;
  });
  normalized.forEach((ev) => insertEventRow(db, ev));
  if (normalized.length) {
    Domain.deriveHoldings(readOpenings(db), readSecurityEvents(db), { strict: true });
  }
}

/* ------------------------------ 风险评估（Phase 5B，D-047） ------------------------------ */

// 评估行 = 一次评估的封存事实：id 永久唯一，历史行绝不 UPDATE（复评即追加新行）。
// 形状与派生值一致性共用领域层 validateRiskAssessmentRecord（唯一实现，D-025）：
// 单条 API 写入、全量 PUT /state、备份恢复三条路径走同一道闸，不合格整体回滚。
// 服务端只消费白名单字段，载荷上的 extra/未知键在领域入口已被拒绝。

const RISK_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validateRiskAssessmentRow(rec, atLabel) {
  const label = atLabel ? atLabel + ' ' : '';
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    throw Object.assign(new Error(label + '评估记录必须是对象'), { code: 'invalid_answers' });
  }
  if (typeof rec.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(rec.id)) {
    throw Object.assign(new Error(label + '评估 id 不合法'), { code: 'invalid_id' });
  }
  if (typeof rec.createdAt !== 'string' || !RISK_ISO_RE.test(rec.createdAt)) {
    throw Object.assign(new Error(label + 'createdAt 必须是带时区的 ISO 时间戳'), { code: 'invalid_answers' });
  }
  const v = Domain.validateRiskAssessmentRecord(rec);
  if (!v.ok) {
    throw Object.assign(
      new Error(label + '评估记录未通过领域校验：' + (v.error && v.error.detail ? v.error.detail : v.error && v.error.code)),
      { code: (v.error && v.error.code) || 'invalid_answers' }
    );
  }
  return v.record;
}

function hydrateRiskAssessment(row) {
  return {
    id: row.id,
    ruleVersion: row.rule_version,
    answers: JSON.parse(row.answers_json),
    capacityScore: row.capacity_score,
    willingnessScore: row.willingness_score,
    capacityLevel: row.capacity_level,
    willingnessLevel: row.willingness_level,
    ceiling: row.risk_ceiling,
    ceilingSource: row.ceiling_source,
    hardCaps: JSON.parse(row.hard_caps_json),
    explainCodes: JSON.parse(row.explain_codes_json),
    assessedAt: row.assessed_at,
    expiry: row.expiry,
    reason: row.reason,
    createdAt: row.created_at
  };
}

// 读取全部评估：确定性排序（assessedAt 降序 → createdAt 降序 → id 升序），与行序无关。
function readRiskAssessments(db) {
  const rows = all(db, 'SELECT * FROM risk_assessments').map(hydrateRiskAssessment);
  return Domain.sortRiskAssessments(rows);
}

function getRiskAssessment(db, id) {
  const row = get(db, 'SELECT * FROM risk_assessments WHERE id = ?', [id]);
  return row ? hydrateRiskAssessment(row) : null;
}

// 追加一条评估：同 id 重放 → duplicate_assessment（409，API 层翻译），绝不覆盖历史。
function insertRiskAssessment(db, rec) {
  const row = validateRiskAssessmentRow(rec);
  if (get(db, 'SELECT id FROM risk_assessments WHERE id = ?', [row.id])) {
    throw Object.assign(new Error('同 id 的风险评估已存在（历史评估不可覆盖）：' + row.id), { code: 'duplicate_assessment' });
  }
  run(
    db,
    `INSERT INTO risk_assessments (id, rule_version, answers_json, capacity_score, willingness_score,
       capacity_level, willingness_level, risk_ceiling, ceiling_source, hard_caps_json,
       explain_codes_json, assessed_at, expiry, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.ruleVersion,
      JSON.stringify(row.answers),
      row.capacityScore,
      row.willingnessScore,
      row.capacityLevel,
      row.willingnessLevel,
      row.ceiling,
      row.ceilingSource,
      JSON.stringify(row.hardCaps),
      JSON.stringify(row.explainCodes),
      row.assessedAt,
      row.expiry,
      row.reason,
      row.createdAt
    ]
  );
  return getRiskAssessment(db, row.id);
}

// 全量写入路径：逐条校验（任一条非法整体回滚，绝不静默丢行），id 重复 → duplicate_assessment。
function writeRiskAssessments(db, list) {
  const rows = Array.isArray(list) ? list : [];
  const seen = {};
  const normalized = rows.map((r, idx) => {
    const rec = validateRiskAssessmentRow(r, '第 ' + (idx + 1) + ' 条');
    if (seen[rec.id]) {
      throw Object.assign(new Error('风险评估 id 重复写入：' + rec.id), { code: 'duplicate_assessment' });
    }
    seen[rec.id] = true;
    return rec;
  });
  normalized.forEach((rec) => {
    run(
      db,
      `INSERT INTO risk_assessments (id, rule_version, answers_json, capacity_score, willingness_score,
         capacity_level, willingness_level, risk_ceiling, ceiling_source, hard_caps_json,
         explain_codes_json, assessed_at, expiry, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.id, rec.ruleVersion, JSON.stringify(rec.answers), rec.capacityScore, rec.willingnessScore,
        rec.capacityLevel, rec.willingnessLevel, rec.ceiling, rec.ceilingSource, JSON.stringify(rec.hardCaps),
        JSON.stringify(rec.explainCodes), rec.assessedAt, rec.expiry, rec.reason, rec.createdAt
      ]
    );
  });
}

/* ------------------------------ 目标配置与认可标的（Phase 5C，D-048） ------------------------------ */

// 目标版本 = 「哪一份评估 + 哪个模板/规则版本 + 何时生效」的封存事实（追加式，历史行永不 UPDATE）。
// 派生值（level / classes）全部来自服务端按 5A 冻结模板的映射，客户端提交的任何派生值都不被采信；
// 单条 API 写入、全量 PUT /state、备份恢复三条路径共用 Domain.validateAllocationTargetRecord。

const TARGET_ISO_RE = RISK_ISO_RE;

function validateAllocationTargetRow(rec, assessment, atLabel) {
  const label = atLabel ? atLabel + ' ' : '';
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    throw Object.assign(new Error(label + '目标记录必须是对象'), { code: 'invalid_target_record' });
  }
  if (typeof rec.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(rec.id)) {
    throw Object.assign(new Error(label + '目标 id 不合法'), { code: 'invalid_id' });
  }
  if (typeof rec.createdAt !== 'string' || !TARGET_ISO_RE.test(rec.createdAt)) {
    throw Object.assign(new Error(label + 'createdAt 必须是带时区的 ISO 时间戳'), { code: 'invalid_target_record' });
  }
  // 目标必须能在事实源里找到它引用的那一份评估（第 1 个参数为 undefined 时是纯形状复核）。
  // 缺引用要在领域闸之前显式拒绝：SQL 的 RESTRICT 只能给出「外键失败」这种无法解释的信息。
  if (assessment === null) {
    throw Object.assign(new Error(label + '目标引用的风险评估不存在'), { code: 'invalid_assessment_ref' });
  }
  const v = Domain.validateAllocationTargetRecord(rec, assessment);
  if (!v.ok) {
    throw Object.assign(
      new Error(label + '目标记录未通过领域校验：' + (v.error && v.error.detail ? v.error.detail : v.error && v.error.code)),
      { code: (v.error && v.error.code) || 'invalid_target_record' }
    );
  }
  return v.record;
}

function hydrateAllocationTarget(row) {
  return {
    id: row.id,
    templateVersion: row.template_version,
    ruleVersion: row.rule_version,
    level: row.level,
    classes: JSON.parse(row.classes_json),
    assessmentId: row.assessment_id,
    assessedAt: row.assessed_at,
    assessmentExpiry: row.assessment_expiry,
    effectiveFrom: row.effective_from,
    createdAt: row.created_at
  };
}

// 读取全部目标版本：确定性排序（effectiveFrom 降序 → createdAt 降序 → id 升序），与行序无关。
function readAllocationTargets(db) {
  const rows = all(db, 'SELECT * FROM allocation_targets').map(hydrateAllocationTarget);
  return Domain.sortAllocationTargets(rows) || [];
}

function getAllocationTarget(db, id) {
  const row = get(db, 'SELECT * FROM allocation_targets WHERE id = ?', [id]);
  return row ? hydrateAllocationTarget(row) : null;
}

// 追加一个目标版本：同自然键重放 → duplicate_target（API 翻译成 200 created:false），
// 绝不覆盖历史目标；所引用的评估必须真实存在（RESTRICT 之外先给领域层一次显式判定）。
function insertAllocationTarget(db, rec, options) {
  const assessment = options && options.assessment !== undefined
    ? options.assessment
    : getRiskAssessment(db, rec && rec.assessmentId);
  const row = validateAllocationTargetRow(rec, assessment);
  const dup = get(
    db,
    'SELECT id, classes_json FROM allocation_targets WHERE assessment_id = ? AND template_version = ? AND effective_from = ?',
    [row.assessmentId, row.templateVersion, row.effectiveFrom]
  );
  if (dup) {
    if (JSON.stringify(JSON.parse(dup.classes_json)) === JSON.stringify(row.classes) && dup.id === row.id) {
      return getAllocationTarget(db, row.id); // 同一内容同 id 重放（幂等恢复路径）
    }
    throw Object.assign(new Error('该评估在此生效日已有目标版本（历史目标不可覆盖）'), { code: 'duplicate_target' });
  }
  run(
    db,
    `INSERT INTO allocation_targets (id, template_version, rule_version, level, classes_json,
       assessment_id, assessed_at, assessment_expiry, effective_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.templateVersion, row.ruleVersion, row.level, JSON.stringify(row.classes),
      row.assessmentId, row.assessedAt, row.assessmentExpiry, row.effectiveFrom, row.createdAt
    ]
  );
  return getAllocationTarget(db, row.id);
}

// 全量写入路径：逐条按「记录 + 所引用评估」复核（任一条非法整体回滚，绝不静默丢行）。
function writeAllocationTargets(db, list) {
  const rows = Array.isArray(list) ? list : [];
  const seen = {};
  const normalized = rows.map((r, idx) => {
    const rec = validateAllocationTargetRow(r, getRiskAssessment(db, r && r.assessmentId), '第 ' + (idx + 1) + ' 条');
    if (seen[rec.id]) {
      throw Object.assign(new Error('目标版本 id 重复写入：' + rec.id), { code: 'duplicate_target' });
    }
    seen[rec.id] = true;
    const natural = Domain.allocationTargetNaturalKey(rec);
    if (seen['nk:' + natural]) {
      throw Object.assign(new Error('同一评估 + 模板版本 + 生效日存在两个目标版本'), { code: 'duplicate_target' });
    }
    seen['nk:' + natural] = true;
    return rec;
  });
  normalized.forEach((rec) => {
    run(
      db,
      `INSERT INTO allocation_targets (id, template_version, rule_version, level, classes_json,
         assessment_id, assessed_at, assessment_expiry, effective_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.id, rec.templateVersion, rec.ruleVersion, rec.level, JSON.stringify(rec.classes),
        rec.assessmentId, rec.assessedAt, rec.assessmentExpiry, rec.effectiveFrom, rec.createdAt
      ]
    );
  });
}

/* 认可标的映射：只有用户判断写入本表，provider 刷新路径不涉及这里任何一列（§6.2 工作项 7）。
 * id 由「类别 + 标的」确定性导出：同一份清单重复写入得到同一批行与同一批 id（幂等），
 * 而不是每次点击都换一套主键。 */

function approvedInstrumentId(assetClass, instrumentId) {
  return 'aim-' + crypto.createHash('sha256').update(String(assetClass) + '|' + String(instrumentId)).digest('hex').slice(0, 16);
}

function validateApprovedInstrumentRow(rec, atLabel) {
  const label = atLabel ? atLabel + ' ' : '';
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    throw Object.assign(new Error(label + '认可标的记录必须是对象'), { code: 'invalid_mapping_payload' });
  }
  if (typeof rec.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(rec.id)) {
    throw Object.assign(new Error(label + '认可标的 id 不合法'), { code: 'invalid_id' });
  }
  ['createdAt', 'updatedAt'].forEach((k) => {
    if (typeof rec[k] !== 'string' || !TARGET_ISO_RE.test(rec[k])) {
      throw Object.assign(new Error(label + k + ' 必须是带时区的 ISO 时间戳'), { code: 'invalid_mapping_payload' });
    }
  });
  const v = Domain.validateApprovedInstrumentRecord(rec);
  if (!v.ok) {
    throw Object.assign(
      new Error(label + '认可标的未通过领域校验：' + (v.error && v.error.detail ? v.error.detail : v.error && v.error.code)),
      { code: (v.error && v.error.code) || 'invalid_mapping_payload' }
    );
  }
  return v.record;
}

function hydrateApprovedInstrument(row) {
  return {
    id: row.id,
    assetClass: row.asset_class,
    instrumentId: row.instrument_id,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// 只读用户判断本身（不 join 标的）：/state、备份与恢复走这一份，保证往返无损。
function readApprovedInstruments(db) {
  const rows = all(db, 'SELECT * FROM approved_instruments').map(hydrateApprovedInstrument);
  return Domain.sortApprovedInstruments(rows) || [];
}

// 引用完整性在**读取时**判定（不写回）：标的被删 / 分类回到 suggested / 类别被改，
// 映射行保持原样并显式给出失效原因，绝不静默丢行或自动改写用户判断。
function readApprovedMappingView(db) {
  return Domain.checkApprovedMapping(readApprovedInstruments(db), readInstruments(db));
}

function writeApprovedInstruments(db, list) {
  const rows = Array.isArray(list) ? list : [];
  const seen = {};
  const slots = {};
  const normalized = rows.map((r, idx) => {
    const rec = validateApprovedInstrumentRow(r, '第 ' + (idx + 1) + ' 条');
    if (seen[rec.id]) {
      throw Object.assign(new Error('认可标的 id 重复写入：' + rec.id), { code: 'invalid_mapping_payload' });
    }
    seen[rec.id] = true;
    if (seen['i:' + rec.instrumentId]) {
      throw Object.assign(new Error('同一标的被映射了多次：' + rec.instrumentId), { code: 'instrument_already_mapped' });
    }
    seen['i:' + rec.instrumentId] = true;
    const slot = rec.assetClass + '|' + rec.position;
    if (slots[slot]) {
      throw Object.assign(new Error('类别 ' + rec.assetClass + ' 的排序位置 ' + rec.position + ' 重复'), {
        code: 'invalid_mapping_payload'
      });
    }
    slots[slot] = true;
    return rec;
  });
  // 引用校验按整表一次做（全量写入的 instruments 已先落库）：失效引用在恢复路径同样要挡下。
  const view = Domain.checkApprovedMapping(normalized, readInstruments(db));
  if (view.ok !== true) {
    throw Object.assign(new Error('认可标的不符合冻结契约'), { code: 'invalid_mapping_payload' });
  }
  if (view.invalidCount) {
    throw Object.assign(new Error('认可标的记录字段不符合冻结契约'), { code: 'invalid_mapping_payload' });
  }
  const broken = view.rows.filter((r) => r.status !== 'ok');
  if (broken.length) {
    const first = broken[0];
    throw Object.assign(
      new Error('认可标的引用不成立（' + first.issues.join('/') + '）：类别 ' + first.assetClass),
      { code: first.issues[0] === 'instrument_missing' ? 'unknown_instrument' : first.issues[0] }
    );
  }
  normalized.forEach((rec) => {
    run(
      db,
      `INSERT INTO approved_instruments (id, asset_class, instrument_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [rec.id, rec.assetClass, rec.instrumentId, rec.position, rec.createdAt, rec.updatedAt]
    );
  });
}

// 整类替换（用户判断的最小维护语义）：只动这一类，其它类别不受影响；
// 未变化的行保留 created_at，位置变化才写 updated_at —— 重复提交同一份清单不产生任何漂移。
function replaceApprovedInstrumentClass(db, assetClass, instrumentIds, options) {
  const opts = options || {};
  const now = opts.now || new Date().toISOString();
  const req = Domain.validateApprovedMappingRequest({ assetClass: assetClass, instrumentIds: instrumentIds });
  if (!req.ok) {
    throw Object.assign(new Error('认可标的载荷不合法：' + req.error.detail), { code: req.error.code });
  }
  const instruments = readInstruments(db);
  const byId = {};
  instruments.forEach((i) => { if (i && i.id && !byId[i.id]) byId[i.id] = i; });
  const existing = readApprovedInstruments(db).filter((r) => r.assetClass === req.assetClass);
  const existingById = {};
  existing.forEach((r) => { existingById[r.id] = r; });
  // 与全量写入同一道领域闸（D-025）：先构造候选行，再让领域层判定引用是否成立。
  // 未变化的行必须保留 updated_at；否则同一清单重复提交会制造虚假的用户修改时间。
  const candidates = req.instrumentIds.map((id, idx) => {
    const rowId = approvedInstrumentId(req.assetClass, id);
    const previous = existingById[rowId];
    return {
      id: rowId,
      assetClass: req.assetClass,
      instrumentId: id,
      position: idx,
      createdAt: previous ? previous.createdAt : now,
      updatedAt: previous && previous.position === idx ? previous.updatedAt : now
    };
  });
  const view = Domain.checkApprovedMapping(candidates, instruments);
  if (!view.ok) {
    throw Object.assign(new Error('认可标的载荷不合法'), { code: 'invalid_mapping_payload' });
  }
  const broken = view.rows.filter((r) => r.status !== 'ok')[0];
  if (broken) {
    const code = broken.issues[0] === 'instrument_missing' ? 'unknown_instrument' : broken.issues[0];
    throw Object.assign(new Error('认可标的引用不成立：' + broken.issues.join('/')), { code: code });
  }
  const conflicting = req.instrumentIds.filter((id) => {
    const row = get(db, 'SELECT asset_class FROM approved_instruments WHERE instrument_id = ?', [id]);
    return !!row && row.asset_class !== req.assetClass;
  });
  if (conflicting.length) {
    throw Object.assign(new Error('该标的已映射在其他资产类别下，不能同时属于两个类别'), {
      code: 'instrument_already_mapped'
    });
  }
  // 先整类删除再按新顺序插入：类别内 position 唯一（uq_approved_instruments_slot），
  // 逐行 UPDATE 交换顺序会在语句之间瞬时撞到这个唯一约束。
  // created_at 从旧行带过来，所以「重复提交同一份清单」既不换 id 也不换创建时间（幂等）。
  run(db, 'DELETE FROM approved_instruments WHERE asset_class = ?', [req.assetClass]);
  candidates.forEach((c) => {
    run(
      db,
      `INSERT INTO approved_instruments (id, asset_class, instrument_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.id, c.assetClass, c.instrumentId, c.position, c.createdAt, c.updatedAt]
    );
  });
  return readApprovedInstruments(db).filter((r) => r.assetClass === req.assetClass);
}

/* ------------------------------ Phase 5D：建议产物（不可变计算结果） ------------------------------

 * 一行 = 一次建议。id 由 input_hash 确定性导出，因此「同一份输入重复请求」回到同一行；
 * 事实变了才产生新的一行。历史行永不 UPDATE（Phase 6 接管的是这份封存草案本身）。
 *
 * payload_hash 的口径：sha256(canonicalJson(record))。canonicalJson 也在本文件导出，
 * server/api.js 复用同一份实现（D-025：哈希口径不得各写一遍）。
 */

const canonicalJson = Recommendations.canonicalJson;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function recommendationInputHash(record) {
  if (record.gate && record.gate.capture) return Recommendations.hash(Recommendations.normalizeInput(record.gate.capture));
  // 旧 2.4.10 产物仅用于无损保存，读取视图会标记为未验证，不能冒充可重放建议。
  // 以下仅保留旧记录的哈希口径；它没有覆盖全部事实，不能用于新建议。
  return sha256Hex(canonicalJson({
    ruleVersion: record.ruleVersion,
    targetVersion: record.targetVersion,
    assessmentId: record.assessmentId,
    targetId: record.targetId,
    closeId: record.closeId,
    snapshotId: record.snapshotId,
    snapshotPayloadHash: record.snapshotPayloadHash,
    dataCutoff: record.dataCutoff,
    asOf: record.asOf,
    requestedNewFundsMinor: record.requestedNewFundsMinor,
    newFundsAvailableMinor: record.newFundsAvailableMinor,
    allocatableNewFundsMinor: record.allocatableNewFundsMinor,
    allocatedTotalMinor: record.allocatedTotalMinor,
    status: record.status
  }));
}

function recommendationRecordId(inputHash) {
  return 'rec-' + String(inputHash).slice(0, 16);
}

// D-052：同一份输入（inputHash 不含解释版本）回到同一行。比较幂等相等时把 gate 区的
// explanationVersion 剥掉：升级后重复请求不得因「新记录多一个封存键」误报 duplicate，
// 也绝不因此回填 / 覆盖旧记录 —— 返回的永远是库里原来那条（未封存的照旧未封存）。
function withoutExplanationVersion(rec) {
  if (!rec || !rec.gate || !Object.prototype.hasOwnProperty.call(rec.gate, 'explanationVersion')) return rec;
  const gate = Object.assign({}, rec.gate);
  delete gate.explanationVersion;
  return Object.assign({}, rec, { gate });
}

function validateRecommendationRow(rec, atLabel) {
  const label = atLabel ? atLabel + ' ' : '';
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    throw Object.assign(new Error(label + '建议记录必须是对象'), { code: 'invalid_recommendation_record' });
  }
  const v = Domain.validateRecommendationRecord(rec);
  if (!v.ok) {
    throw Object.assign(
      new Error(label + '建议记录未通过领域复核：' + (v.error && v.error.detail ? v.error.detail : v.error && v.error.code)),
      { code: (v.error && v.error.code) || 'invalid_recommendation_record' }
    );
  }
  if (typeof rec.id !== 'string' || !INSTRUMENT_ID_RE.test(rec.id)) {
    throw Object.assign(new Error(label + '建议 id 不合法'), { code: 'invalid_id' });
  }
  if (!TARGET_ISO_RE.test(rec.createdAt)) {
    throw Object.assign(new Error(label + 'createdAt 必须是带时区的 ISO 时间戳'), { code: 'invalid_recommendation_record' });
  }
  if (!isDateStr(rec.dataCutoff) || !isDateStr(rec.asOf)) {
    throw Object.assign(new Error(label + '数据截止日与判定日必须是真实日历日'), { code: 'invalid_recommendation_record' });
  }
  if (rec.gate.capture) validateCapturedRecommendation(rec);
  return v.record;
}

function validateCapturedRecommendation(rec) {
  const out = Recommendations.calculate(rec.gate.capture);
  if (rec.inputHash !== recommendationInputHash(rec) || rec.id !== recommendationRecordId(rec.inputHash) ||
      canonicalJson(out.result) !== canonicalJson(rec.result) || canonicalJson(out.checks) !== canonicalJson(rec.gate.checks) ||
      canonicalJson(out.todos) !== canonicalJson(rec.todos) || out.status !== rec.status ||
      ['requestedNewFundsMinor','newFundsAvailableMinor','allocatableNewFundsMinor','allocatedTotalMinor'].some(k => out.allocation[k] !== rec[k])) {
    throw Object.assign(new Error('建议与封存输入重放结果不一致'), { code: 'invalid_recommendation_record' });
  }
}

function validateRecommendationReferences(db, rec) {
  if (!rec.gate.capture) return;
  const snap = getCloseSnapshot(db, rec.snapshotId);
  const close = get(db, 'SELECT id FROM monthly_closes WHERE id = ?', [rec.closeId]);
  if (!close || !snap || snap.closeId !== rec.closeId || snap.payloadHash !== rec.snapshotPayloadHash ||
      snap.payloadJson !== rec.gate.capture.snapshot.payloadJson) {
    throw Object.assign(new Error('建议引用的月结快照缺失或已改变'), { code: 'invalid_recommendation_record' });
  }
  // G5-R1：引用链必须与封存输入交叉一致。单条记录合法 + SQL 外键「存在」并不保证审计链
  // 自洽：恢复可以保留 id、只换内容，于是「按评估 / 目标 id 下钻」得到的事实与建议
  // gate.capture 里同一 id 的不可变版本互相矛盾，读取视图却仍显示 formal / invalidCount=0。
  // 只核对本条建议**引用**的那两份不可变记录；资产与认可映射是可变事实，按 capture
  // 保留历史，绝不在此要求它们等于当前状态（否则历史建议永远无法保留）。
  const sealedAssessment = Array.isArray(rec.gate.capture.riskAssessments)
    ? rec.gate.capture.riskAssessments.filter((a) => a && a.id === rec.assessmentId)[0]
    : undefined;
  const liveAssessment = getRiskAssessment(db, rec.assessmentId);
  if (!liveAssessment || !sealedAssessment ||
      canonicalJson(liveAssessment) !== canonicalJson(sealedAssessment)) {
    throw Object.assign(
      new Error('建议引用的风险评估与封存记录不是同一份不可变事实'),
      { code: 'invalid_recommendation_record' }
    );
  }
  const sealedTarget = Array.isArray(rec.gate.capture.allocationTargets)
    ? rec.gate.capture.allocationTargets.filter((t) => t && t.id === rec.targetId)[0]
    : undefined;
  const liveTarget = getAllocationTarget(db, rec.targetId);
  if (!liveTarget || !sealedTarget || canonicalJson(liveTarget) !== canonicalJson(sealedTarget)) {
    throw Object.assign(
      new Error('建议引用的目标配置与封存记录不是同一份不可变事实'),
      { code: 'invalid_recommendation_record' }
    );
  }
}

function hydrateRecommendation(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    ruleVersion: row.rule_version,
    targetVersion: row.target_version,
    assessmentId: row.assessment_id,
    targetId: row.target_id,
    closeId: row.close_id,
    snapshotId: row.snapshot_id,
    snapshotPayloadHash: row.snapshot_hash,
    dataCutoff: row.data_cutoff,
    asOf: row.as_of,
    requestedNewFundsMinor: row.requested_new_funds_minor,
    newFundsAvailableMinor: row.available_new_funds_minor,
    allocatableNewFundsMinor: row.allocatable_new_funds_minor,
    allocatedTotalMinor: row.allocated_total_minor,
    inputHash: row.input_hash,
    gate: JSON.parse(row.gate_json),
    todos: JSON.parse(row.todos_json),
    result: JSON.parse(row.result_json)
  };
}

// 原始行（不复核、不算哈希）：/state 与备份要做到无损往返，语义复核在读取视图与写入闸各做一次。
function readRecommendationRows(db) {
  const rows = all(db, 'SELECT * FROM recommendations').map((row) => {
    let rec = null;
    try {
      rec = hydrateRecommendation(row);
    } catch (_) {
      // 结构损坏（JSON 列不合法）也必须可见：返回 null 让上层计入 invalidCount，绝不静默丢行
      rec = null;
    }
    return { record: rec, payloadHash: row.payload_hash };
  });
  return rows;
}

// /state 与备份用的集合：可解析的记录按冻结顺序给出（无法解析的行由读取视图计入 invalidCount 显式报告）
function readRecommendations(db) {
  return readRecommendationRows(db)
    .filter((row) => !!row.record)
    .map((row) => row.record)
    .sort(Domain.compareRecommendations);
}

// 建议列表的读取视图：逐条按冻结契约复核 + 按 payload_hash 判封存原文是否被动过。
// 与 GET /close-snapshots/:id 同一纪律（G4E-1）：哈希不符的行不得冒充可用建议，但显式留痕。
function readRecommendationView(db) {
  const rows = readRecommendationRows(db);
  const items = [];
  let invalidCount = 0;
  rows.forEach((row) => {
    if (!row.record) { invalidCount += 1; return; }
    const checked = Domain.validateRecommendationRecord(row.record);
    const sealed = checked.ok && sha256Hex(canonicalJson(checked.record)) === row.payloadHash;
    if (!sealed) { invalidCount += 1; return; }
    try {
      if (!checked.record.gate.capture) throw new Error('legacy_unverified');
      validateCapturedRecommendation(checked.record);
      validateRecommendationReferences(db, checked.record);
    } catch (_) { invalidCount += 1; return; }
    items.push(Object.assign(checked.record, { payloadHash: row.payloadHash }));
  });
  items.sort(Domain.compareRecommendations);
  return { items: items, invalidCount: invalidCount, total: rows.length };
}

function getRecommendation(db, id) {
  const row = get(db, 'SELECT * FROM recommendations WHERE id = ?', [String(id)]);
  if (!row) return null;
  let rec = null;
  try {
    rec = hydrateRecommendation(row);
  } catch (_) {
    rec = null;
  }
  return rec ? { record: rec, payloadHash: row.payload_hash } : null;
}

function insertRecommendation(db, rec) {
  const row = validateRecommendationRow(rec);
  validateRecommendationReferences(db, row);
  if (row.inputHash !== recommendationInputHash(row) || row.id !== recommendationRecordId(row.inputHash)) {
    throw Object.assign(new Error('建议记录的 id / inputHash 与所绑定输入不一致'), { code: 'invalid_recommendation_record' });
  }
  const payloadHash = sha256Hex(canonicalJson(row));
  const dup = get(db, 'SELECT id, payload_hash FROM recommendations WHERE input_hash = ?', [row.inputHash]);
  if (dup) {
    const stored = getRecommendation(db, dup.id);
    if (stored && dup.id === row.id && sha256Hex(canonicalJson(stored.record)) === stored.payloadHash) {
      const existing = validateRecommendationRow(stored.record);
      const incoming = Object.assign({}, row, { createdAt: existing.createdAt });
      if (canonicalJson(withoutExplanationVersion(existing)) === canonicalJson(withoutExplanationVersion(incoming))) {
        return Object.assign(existing, { payloadHash: stored.payloadHash });
      }
    }
    throw Object.assign(new Error('同一份输入已有另一条建议产物（历史建议不可覆盖）'), { code: 'duplicate_recommendation' });
  }
  run(
    db,
    `INSERT INTO recommendations (id, status, rule_version, target_version, assessment_id, target_id,
       close_id, snapshot_id, snapshot_hash, data_cutoff, as_of,
       requested_new_funds_minor, available_new_funds_minor, allocatable_new_funds_minor, allocated_total_minor,
       input_hash, gate_json, todos_json, result_json, payload_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.status, row.ruleVersion, row.targetVersion, row.assessmentId, row.targetId,
      row.closeId, row.snapshotId, row.snapshotPayloadHash, row.dataCutoff, row.asOf,
      row.requestedNewFundsMinor, row.newFundsAvailableMinor, row.allocatableNewFundsMinor, row.allocatedTotalMinor,
      row.inputHash, JSON.stringify(row.gate), JSON.stringify(row.todos), JSON.stringify(row.result),
      payloadHash, row.createdAt
    ]
  );
  const stored = getRecommendation(db, row.id);
  if (!stored) throw Object.assign(new Error('建议写入后读不回来'), { code: 'internal_error' });
  return Object.assign(stored.record, { payloadHash: stored.payloadHash });
}

// 全量写入路径（PUT /state / 恢复）：逐条领域复核 + 引用必须在本事务此刻可见，
// 任一条非法整体回滚，绝不静默丢行（与 5B / 5C 同一纪律）。
function writeRecommendations(db, list) {
  const rows = Array.isArray(list) ? list : [];
  const seen = {};
  const normalized = rows.map((r, idx) => {
    const rec = validateRecommendationRow(r, '第 ' + (idx + 1) + ' 条');
    if (seen[rec.id]) {
      throw Object.assign(new Error('建议 id 重复写入：' + rec.id), { code: 'duplicate_recommendation' });
    }
    seen[rec.id] = true;
    if (seen['h:' + rec.inputHash]) {
      throw Object.assign(new Error('同一份输入存在两条建议产物'), { code: 'duplicate_recommendation' });
    }
    seen['h:' + rec.inputHash] = true;
    return rec;
  });
  normalized.forEach((rec) => {
    insertRecommendation(db, rec);
  });
}

/* ------------------------------ 写入/读取：报价（Phase 4D） ------------------------------ */

// 报价行的形状与引用校验，两条写入路径（单条 / 全量 / 自动更新）共用同一套口径
// —— 4B/4C 的教训是「同一张表两条写入路径两套规则」必然产生补口问题。
// 币种不采信载荷（D-042 ⑤ 的延伸）：由标的推导；载荷给了不同值 → 显式拒绝而不是静默改写。
function validateQuoteRow(q, currencies) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) {
    throw Object.assign(new Error('报价记录必须是对象'), { code: 'invalid_quote' });
  }
  const instrumentId = String(q.instrumentId == null ? '' : q.instrumentId).trim();
  if (!instrumentId) throw Object.assign(new Error('报价缺少 instrumentId'), { code: 'invalid_instrument_id' });
  if (!INSTRUMENT_ID_RE.test(instrumentId)) {
    throw Object.assign(new Error('报价的 instrumentId 形状不合法'), { code: 'invalid_instrument_id' });
  }
  const derived = currencies ? currencies[instrumentId] : undefined;
  if (currencies && derived === undefined) {
    throw Object.assign(new Error('报价引用了不存在的标的：' + instrumentId), { code: 'unknown_instrument' });
  }
  const priceMinor = NUM(q.priceMinor);
  if (!Number.isSafeInteger(priceMinor) || priceMinor <= 0) {
    throw Object.assign(new Error('报价必须是大于 0 的最小货币单位整数'), { code: 'invalid_price' });
  }
  const priceDate = String(q.priceDate == null ? '' : q.priceDate).trim();
  if (!isDateStr(priceDate)) {
    throw Object.assign(new Error('价格日必须是真实存在的 YYYY-MM-DD 日期'), { code: 'invalid_price_date' });
  }
  const declared = String(q.currency == null ? '' : q.currency).trim();
  if (declared && derived !== undefined && declared !== derived) {
    throw Object.assign(
      new Error('报价币种与标的币种不一致（标的为 ' + derived + '）'),
      { code: 'currency_mismatch' }
    );
  }
  const currency = derived !== undefined ? derived : declared;
  if (Domain.CURRENCIES.indexOf(currency) === -1) {
    throw Object.assign(new Error('报价币种必须是 CNY/HKD/USD'), { code: 'invalid_currency' });
  }
  const out = { instrumentId: instrumentId, priceMinor: priceMinor, priceDate: priceDate, currency: currency };
  const fetchedAt = STR(q.fetchedAt);
  const provider = STR(q.provider);
  const status = STR(q.status);
  const sourceSymbol = STR(q.sourceSymbol);
  if (fetchedAt != null) out.fetchedAt = fetchedAt;
  if (provider != null) out.provider = provider;
  if (status != null) out.status = status;
  if (sourceSymbol != null) out.sourceSymbol = sourceSymbol;
  return out;
}

function instrumentCurrencyMap(db) {
  const map = {};
  all(db, 'SELECT id, currency FROM instruments').forEach((r) => {
    map[r.id] = r.currency;
  });
  return map;
}

// 全量写入（PUT /state、JSON 恢复、备份还原）：两遍写入，逐条验证归一后整体插入。
// 任一条不合格即抛错，由 writeState 的事务整体回滚 —— 绝不 `.filter()` 静默丢行（G4B-5）。
// 元素键（标的, 价格日）的唯一性不在这里强制：v1 的 uq_quotes_dedupe 明确允许同一价格日
// 不同 provider 并存（见 migrations v7 注释），收紧会拒绝合法的历史状态；该不变量由
// 单条写入路径（upsertManualQuote / upsertProviderQuote）按元素键替换来维持（D-044）。
function writeQuotes(db, list, ctx) {
  const currencies = (ctx && ctx.currencies) || instrumentCurrencyMap(db);
  const rows = [];
  (list || []).forEach((q) => {
    rows.push(validateQuoteRow(q, currencies));
  });
  const st = db.prepare(
    `INSERT INTO quotes (instrument_id, price_minor, currency, price_date, fetched_at, provider, status, source_symbol)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  rows.forEach((q) => {
    st.run(
      q.instrumentId,
      q.priceMinor,
      q.currency,
      q.priceDate,
      N(q.fetchedAt),
      N(q.provider),
      N(q.status),
      N(q.sourceSymbol)
    );
  });
}

function readQuotes(db) {
  return all(db, 'SELECT * FROM quotes ORDER BY rowid').map((row) => {
    const out = {
      instrumentId: row.instrument_id,
      priceMinor: row.price_minor,
      currency: row.currency
    };
    if (row.price_date != null) out.priceDate = row.price_date;
    if (row.fetched_at != null) out.fetchedAt = row.fetched_at;
    if (row.provider != null) out.provider = row.provider;
    if (row.status != null) out.status = row.status;
    if (row.source_symbol != null) out.sourceSymbol = row.source_symbol;
    return out;
  });
}

// 元素键上「先替换再插入」：跨 provider 一起替换，保证同一 (标的, 价格日) 只剩一行，
// 从而 Domain.findQuote 的"最近价格日 + 行序"取值是确定性的（D-044 ③）。
function replaceQuoteRows(db, instrumentId, priceDate) {
  run(db, 'DELETE FROM quotes WHERE instrument_id = ? AND price_date = ?', [instrumentId, priceDate]);
}

// 手动补价（D-044 ①）：用户显式事实，总是生效；provider 固定为 'manual'，
// 不接受调用方用别的方式绕过来源标记（否则手动值会被后续自动更新当成可覆盖行）。
function upsertManualQuote(db, q, options) {
  const opts = options || {};
  const row = validateQuoteRow(
    Object.assign({}, q, { provider: Domain.MANUAL_PROVIDER, status: (q && q.status) || 'ok' }),
    opts.currencies || instrumentCurrencyMap(db)
  );
  replaceQuoteRows(db, row.instrumentId, row.priceDate);
  run(
    db,
    `INSERT INTO quotes (instrument_id, price_minor, currency, price_date, fetched_at, provider, status, source_symbol)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.instrumentId,
      row.priceMinor,
      row.currency,
      row.priceDate,
      opts.now || new Date().toISOString(),
      Domain.MANUAL_PROVIDER,
      row.status || 'ok',
      N(row.sourceSymbol)
    ]
  );
  return readQuotes(db).filter(
    (x) => x.instrumentId === row.instrumentId && x.priceDate === row.priceDate
  )[0] || null;
}

// 自动更新的写入（D-044 ②）：手动行是用户显式事实，自动源不得写入**同一天或更早**的观测。
// 判定把该标的的**全部**既有报价交给 Domain.planMarketMerge（不是只挑同键行）：
// 手动冻结的是「该标的在手动数据日及更早」这一段观测，与汇率侧规则保持同一口径；
// 元素键（标的, 价格日）上的替换仍由写入路径强制（replaceQuoteRows），跨 provider 一起替换。
// 失败/不接受的行永远不会走到这里 —— 编排层先过契约校验与 planMarketMerge。
function upsertProviderQuote(db, q, options) {
  const opts = options || {};
  const row = validateQuoteRow(q, opts.currencies || instrumentCurrencyMap(db));
  if (!row.provider || row.provider === Domain.MANUAL_PROVIDER) {
    throw Object.assign(new Error('自动更新的报价必须带真实 provider'), { code: 'invalid_provider' });
  }
  const existing = readQuotes(db).filter((x) => x.instrumentId === row.instrumentId);
  const plan = Domain.planMarketMerge('quotes', existing, [row]);
  if (!plan.write.length) {
    return { status: 'skipped', reason: plan.skip[0] ? plan.skip[0].reason : 'not_writable', item: null };
  }
  replaceQuoteRows(db, row.instrumentId, row.priceDate);
  run(
    db,
    `INSERT INTO quotes (instrument_id, price_minor, currency, price_date, fetched_at, provider, status, source_symbol)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.instrumentId,
      row.priceMinor,
      row.currency,
      row.priceDate,
      opts.now || new Date().toISOString(),
      row.provider,
      row.status || 'ok',
      N(row.sourceSymbol)
    ]
  );
  const item = readQuotes(db).filter(
    (x) => x.instrumentId === row.instrumentId && x.priceDate === row.priceDate
  )[0] || null;
  return { status: 'updated', reason: null, item: item };
}

// 汇率行的形状校验，单条 / 全量 / 自动更新三条路径共用（错误码与 Phase 3 的 upsertFxRate 保持一致，
// 前端与既有测试对此已有关联断言）。定点汇率保留原始字符串：Domain.parseDecimal 返回的是
// {v,s} 对象，直接 String() 会写进 "[object Object]"（P3-5）。
function validateFxRow(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    throw Object.assign(new Error('汇率记录必须是对象'), { code: 'invalid_fx' });
  }
  const base = STR(r.base);
  const quote = STR(r.quote);
  if (Domain.CURRENCIES.indexOf(base) === -1 || Domain.CURRENCIES.indexOf(quote) === -1) {
    throw Object.assign(new Error('汇率币种必须是 CNY/HKD/USD'), { code: 'invalid_currency' });
  }
  if (base === quote) {
    throw Object.assign(new Error('汇率的两端币种不能相同'), { code: 'same_currency' });
  }
  const rateText = typeof r.rateDecimal === 'string' ? r.rateDecimal.trim() : String(r.rateDecimal == null ? '' : r.rateDecimal);
  const rate = Domain.parseDecimal(rateText);
  if (!rate || !(rate.v > 0)) {
    throw Object.assign(new Error('汇率必须是大于 0 的定点十进制数'), { code: 'invalid_rate' });
  }
  const rateDate = STR(r.rateDate);
  if (!isDateStr(rateDate)) {
    throw Object.assign(new Error('汇率日期必须是真实存在的 YYYY-MM-DD 日期'), { code: 'invalid_rate_date' });
  }
  const out = { base: base, quote: quote, rateDecimal: rateText, rateDate: rateDate };
  const fetchedAt = STR(r.fetchedAt);
  const provider = STR(r.provider);
  const status = STR(r.status);
  if (fetchedAt != null) out.fetchedAt = fetchedAt;
  if (provider != null) out.provider = provider;
  if (status != null) out.status = status;
  return out;
}

// 全量写入（PUT /state、JSON 恢复、备份还原）：两遍写入逐条验证，任一条不合格整体回滚。
// 旧实现会静默跳过缺 base/quote 的行、并把非法汇率写成 '0' —— 用户看不到错误却少了数据（G4B-5 同类）。
function writeFxRates(db, list) {
  const rows = (list || []).map((r) => validateFxRow(r));
  const st = db.prepare(
    `INSERT INTO fx_rates (base, "quote", rate_decimal, rate_date, fetched_at, provider, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  rows.forEach((r) => {
    st.run(r.base, r.quote, r.rateDecimal, r.rateDate, N(r.fetchedAt), N(r.provider), N(r.status));
  });
}

function readFxRates(db) {
  return all(db, 'SELECT * FROM fx_rates ORDER BY rowid').map((row) => {
    const out = { base: row.base, quote: row.quote, rateDecimal: row.rate_decimal };
    if (row.rate_date != null) out.rateDate = row.rate_date;
    if (row.fetched_at != null) out.fetchedAt = row.fetched_at;
    if (row.provider != null) out.provider = row.provider;
    if (row.status != null) out.status = row.status;
    return out;
  });
}

/* ------------------------------ 写入：旧账本四键 ------------------------------ */

function writeAccounts(db, list) {
  const st = db.prepare(
    `INSERT INTO ledger_accounts (id, name, type, color, initial_balance_minor, order_index, aliases_json, deleted, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  (list || []).forEach((a) => {
    if (!a || !a.id) return;
    st.run(
      String(a.id),
      STR(a.name),
      STR(a.type),
      STR(a.color),
      NUM(a.initialBalance),
      NUM(a.order),
      Array.isArray(a.aliases) ? JSON.stringify(a.aliases) : null,
      BOOL(a.deleted),
      extraJson(a, KNOWN.accounts)
    );
  });
}

function readAccounts(db) {
  return all(db, 'SELECT * FROM ledger_accounts ORDER BY rowid').map((row) => {
    const out = { id: row.id };
    if (row.name != null) out.name = row.name;
    if (row.type != null) out.type = row.type;
    if (row.color != null) out.color = row.color;
    if (row.initial_balance_minor != null) out.initialBalance = row.initial_balance_minor;
    if (row.order_index != null) out.order = row.order_index;
    if (row.aliases_json != null) {
      try {
        out.aliases = JSON.parse(row.aliases_json);
      } catch (_) {
        /* 损坏的 aliases 不静默改写为其他值 */
      }
    }
    if (row.deleted) out.deleted = true;
    return mergeExtra(row, out);
  });
}

function writeCategories(db, list) {
  const st = db.prepare(
    `INSERT INTO categories (id, type, name, icon, parent_id, keywords_json, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  (list || []).forEach((c) => {
    if (!c || !c.id) return;
    st.run(
      String(c.id),
      STR(c.type),
      STR(c.name),
      STR(c.icon),
      STR(c.parent),
      Array.isArray(c.keywords) ? JSON.stringify(c.keywords) : null,
      extraJson(c, KNOWN.categories)
    );
  });
}

function readCategories(db) {
  return all(db, 'SELECT * FROM categories ORDER BY rowid').map((row) => {
    const out = { id: row.id };
    if (row.type != null) out.type = row.type;
    if (row.name != null) out.name = row.name;
    if (row.icon != null) out.icon = row.icon;
    if (row.parent_id != null) out.parent = row.parent_id;
    if (row.keywords_json != null) {
      try {
        out.keywords = JSON.parse(row.keywords_json);
      } catch (_) {
        /* 同上：损坏数据保留原样，不替换 */
      }
    }
    return mergeExtra(row, out);
  });
}

function writeTxns(db, list) {
  const st = db.prepare(
    `INSERT INTO txns (id, occurred_on, occurred_time, txn_type, amount_minor, account_id, account_to,
                       category_id, merchant, note, source, raw_id, status, mapped_to,
                       refund_flag, transfer_half, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const fp = db.prepare(
    'INSERT INTO dedup_fingerprints (fingerprint, txn_id) VALUES (?, ?) ON CONFLICT(fingerprint) DO UPDATE SET txn_id = excluded.txn_id'
  );
  const seen = {};
  (list || []).forEach((t) => {
    if (!t || !t.id) return;
    st.run(
      String(t.id),
      STR(t.date),
      STR(t.time),
      STR(t.type),
      NUM(t.amount),
      t.account ? String(t.account) : null,
      t.accountTo ? String(t.accountTo) : null,
      t.category ? String(t.category) : null,
      STR(t.merchant),
      STR(t.note),
      STR(t.source),
      STR(t.rawId),
      STR(t.status),
      t.mappedTo ? String(t.mappedTo) : null,
      BOOL(t.refundFlag),
      BOOL(t.transferHalf),
      extraJson(t, KNOWN.txns)
    );
    // 确定性重复指纹：同来源同原始单号（§5.4 的"自动拦截"依据）
    if (t.rawId && t.source && !seen[t.source + '|' + t.rawId]) {
      seen[t.source + '|' + t.rawId] = true;
      fp.run(t.source + '|' + t.rawId, String(t.id));
    }
  });
}

function readTxns(db) {
  return all(db, 'SELECT * FROM txns ORDER BY rowid').map((row) => {
    const out = { id: row.id };
    if (row.occurred_on != null) out.date = row.occurred_on;
    if (row.occurred_time) out.time = row.occurred_time;
    if (row.txn_type != null) out.type = row.txn_type;
    if (row.amount_minor != null) out.amount = row.amount_minor;
    if (row.account_id != null) out.account = row.account_id;
    if (row.account_to != null) out.accountTo = row.account_to;
    if (row.category_id != null) out.category = row.category_id;
    if (row.merchant != null) out.merchant = row.merchant;
    if (row.note != null) out.note = row.note;
    if (row.source != null) out.source = row.source;
    if (row.raw_id != null) out.rawId = row.raw_id;
    if (row.status) out.status = row.status;
    if (row.mapped_to != null) out.mappedTo = row.mapped_to;
    if (row.refund_flag) out.refundFlag = true;
    if (row.transfer_half) out.transferHalf = true;
    return mergeExtra(row, out);
  });
}

function writeSettings(db, settings) {
  const json = JSON.stringify(settings && typeof settings === 'object' ? settings : {});
  run(
    db,
    `INSERT INTO app_settings (id, json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    [json, new Date().toISOString()]
  );
}

function readSettings(db) {
  const row = get(db, 'SELECT json FROM app_settings WHERE id = 1');
  if (!row) return undefined;
  try {
    return JSON.parse(row.json);
  } catch (_) {
    return undefined;
  }
}

function readTxnsBlob(db) {
  const row = get(db, 'SELECT meta_value FROM service_meta WHERE meta_key = ?', [TXNS_BLOB_META_KEY]);
  if (!row || !row.meta_value) return null;
  try {
    return JSON.parse(row.meta_value);
  } catch (_) {
    return null;
  }
}

function writeTxnsBlob(db, blob) {
  run(
    db,
    `INSERT INTO service_meta (meta_key, meta_value) VALUES (?, ?)
     ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value`,
    [TXNS_BLOB_META_KEY, JSON.stringify(blob)]
  );
}

/* ------------------------ Phase 6B：决策状态机、事件与关联（D-057） ------------------------
 *
 * 一行决策绑定一条建议（uq_decisions_recommendation 兜底）；事件只追加（UNIQUE(decision_id, seq)），
 * 每次状态变化封存一份快照。快照 / 事件行的完整性口径（契约 §4.5）：
 *   - snapshot_hash = sha256(snapshot_json 原文)；snapshot_json 必须是 canonicalJson 文本；
 *   - payload_hash = sha256(canonicalJson(事件行去掉 payload_hash 自身))；
 * 读取（列表 / 详情 / /state / 备份恢复）时逐条复算，任一条不过即 invalid_decision_record。
 */

function hydrateDecisionRow(row) {
  return {
    id: row.id,
    recommendationId: row.recommendation_id,
    state: row.state,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hydrateDecisionEventRow(row) {
  return {
    id: row.id,
    decisionId: row.decision_id,
    seq: row.seq,
    fromState: row.from_state,
    toState: row.to_state,
    reasonCode: row.reason_code,
    note: row.note,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actor: row.actor,
    snapshot: JSON.parse(row.snapshot_json),
    snapshotHash: row.snapshot_hash,
    payloadHash: row.payload_hash
  };
}

function hydrateDecisionLinkRow(row) {
  return {
    id: row.id,
    decisionId: row.decision_id,
    securityEventId: row.security_event_id,
    linkedOn: row.linked_on,
    linkedAt: row.linked_at,
    note: row.note,
    unlinkedOn: row.unlinked_on,
    unlinkedAt: row.unlinked_at,
    unlinkNote: row.unlink_note
  };
}

// 契约 §4.2：snapshot_hash = SHA-256(snapshot_json 的 UTF-8 字节)，snapshot_json 必须 canonical。
function decisionSnapshotHash(snapshot) {
  return sha256Hex(canonicalJson(snapshot));
}

// 事件行自身的防篡改哈希：覆盖除 payload_hash 外的全部字段（含快照引用与哈希）。
function decisionEventPayloadHash(event) {
  const copy = Object.assign({}, event);
  delete copy.payloadHash;
  return sha256Hex(canonicalJson(copy));
}

function readDecisionRows(db) {
  return all(db, 'SELECT * FROM decisions ORDER BY created_at ASC, id ASC').map((row) => {
    try {
      return hydrateDecisionRow(row);
    } catch (_) {
      return null;
    }
  });
}

function readDecisionEvents(db) {
  return all(db, 'SELECT * FROM decision_events ORDER BY decision_id ASC, seq ASC').map((row) => {
    try {
      return hydrateDecisionEventRow(row);
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

function readDecisionLinks(db) {
  return all(db, 'SELECT * FROM decision_links ORDER BY decision_id ASC, linked_on ASC, id ASC').map((row) => {
    try {
      return hydrateDecisionLinkRow(row);
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

function getDecisionRow(db, id) {
  const row = get(db, 'SELECT * FROM decisions WHERE id = ?', [String(id)]);
  return row ? hydrateDecisionRow(row) : null;
}

function getDecisionEvents(db, decisionId) {
  return all(db, 'SELECT * FROM decision_events WHERE decision_id = ? ORDER BY seq ASC', [String(decisionId)])
    .map((row) => hydrateDecisionEventRow(row));
}

function insertDecisionRow(db, decision) {
  run(
    db,
    `INSERT INTO decisions (id, recommendation_id, state, last_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [decision.id, decision.recommendationId, decision.state, decision.lastSeq, decision.createdAt, decision.updatedAt]
  );
}

function insertDecisionEventRow(db, event) {
  run(
    db,
    `INSERT INTO decision_events
       (id, decision_id, seq, from_state, to_state, reason_code, note, occurred_at, recorded_at, actor, snapshot_json, snapshot_hash, payload_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.decisionId,
      event.seq,
      event.fromState,
      event.toState,
      event.reasonCode,
      event.note,
      event.occurredAt,
      event.recordedAt,
      event.actor,
      canonicalJson(event.snapshot),
      event.snapshotHash,
      event.payloadHash
    ]
  );
}

function updateDecisionForRow(db, decision) {
  run(
    db,
    'UPDATE decisions SET state = ?, last_seq = ?, updated_at = ? WHERE id = ?',
    [decision.state, decision.lastSeq, decision.updatedAt, decision.id]
  );
}

// 决策读取复核（契约 §4.5）：链式一致 + 快照原文哈希 + 事件防篡改哈希 + 建议引用复核。
// 任何一条不过 → invalid_decision_record；列表把失败行计入 invalidCount，详情接口直接 400。
function validateDecisionWithIntegrity(db, decision, events, links, validRecommendationIds) {
  const chain = Domain.validateDecisionEventChain(decision, events);
  if (!chain.ok) return chain;
  for (const event of chain.events) {
    if (Domain.DECISION_HASH_RE.test(event.snapshotHash) !== true ||
        decisionSnapshotHash(event.snapshot) !== event.snapshotHash) {
      return { ok: false, error: { code: 'invalid_decision_record', detail: '快照原文与封存哈希不一致：' + event.id } };
    }
    if (decisionEventPayloadHash(event) !== event.payloadHash) {
      return { ok: false, error: { code: 'invalid_decision_record', detail: '事件行内容与封存哈希不一致：' + event.id } };
    }
  }
  if (!validRecommendationIds.has(decision.recommendationId)) {
    return { ok: false, error: { code: 'invalid_decision_record', detail: '决策引用的建议不存在或复核失败：' + decision.recommendationId } };
  }
  for (const link of links) {
    const checked = Domain.validateDecisionLinkRecord(link);
    if (!checked.ok) return checked;
  }
  return { ok: true, decision: decision, events: chain.events, links: links };
}

// 全库决策的有效读取视图：{ decision, events, links } 逐条复核，失败行显式留痕。
function readValidatedDecisions(db) {
  const decisions = readDecisionRows(db).filter(Boolean);
  const events = readDecisionEvents(db);
  const links = readDecisionLinks(db);
  const validRecommendationIds = new Set(readRecommendationView(db).items.map((r) => r.id));
  const out = [];
  let invalidCount = 0;
  decisions.forEach((decision) => {
    const dEvents = events.filter((e) => e.decisionId === decision.id);
    const dLinks = links.filter((l) => l.decisionId === decision.id);
    const checked = validateDecisionWithIntegrity(db, decision, dEvents, dLinks, validRecommendationIds);
    if (!checked.ok) {
      invalidCount += 1;
      return;
    }
    out.push(checked);
  });
  return { items: out, invalidCount: invalidCount, total: decisions.length };
}

// 全量写入（PUT /state / JSON 恢复）：三集合逐条复核，任一条非法整体回滚，绝不静默丢行。
// 引用规则（契约 §6.4）：decision.recommendationId 必须存在于本次写入的建议集合（建议先写入）；
// 关联行指向的证券事件必须存在且为 buy（security_events 先写入）；删除仍被关联行引用的
// 事件（含已解绑行）→ linked_event_missing 整体拒绝。
function writeDecisions(db, collections) {
  const decisions = collections.decisions || [];
  const decisionEvents = collections.decisionEvents || [];
  const decisionLinks = collections.decisionLinks || [];
  if (!decisions.length && !decisionEvents.length && !decisionLinks.length) return;

  const decisionIds = new Set();
  const recommendationIds = new Set();
  decisions.forEach((d) => {
    const checked = Domain.validateDecisionRecord(d);
    if (!checked.ok) {
      throw Object.assign(new Error('决策记录不合法：' + checked.error.detail), { code: checked.error.code });
    }
    if (decisionIds.has(d.id)) {
      throw Object.assign(new Error('同一决策 id 在写入集合中出现两次：' + d.id), { code: 'invalid_decision_record' });
    }
    if (recommendationIds.has(d.recommendationId)) {
      throw Object.assign(new Error('同一条建议被两条决策绑定：' + d.recommendationId), { code: 'invalid_decision_record' });
    }
    decisionIds.add(d.id);
    recommendationIds.add(d.recommendationId);
  });
  recommendationIds.forEach((recId) => {
    if (!get(db, 'SELECT id FROM recommendations WHERE id = ?', [recId])) {
      throw Object.assign(new Error('决策引用的建议不存在：' + recId), { code: 'unknown_recommendation' });
    }
  });

  const eventIds = new Set();
  const eventsByDecision = new Map();
  decisionEvents.forEach((e) => {
    const checked = Domain.validateDecisionEventRecord(e);
    if (!checked.ok) {
      throw Object.assign(new Error('决策事件不合法：' + checked.error.detail), { code: checked.error.code });
    }
    if (!decisionIds.has(e.decisionId)) {
      throw Object.assign(new Error('事件指向的决策不在写入集合中：' + e.decisionId), { code: 'invalid_decision_record' });
    }
    const eventKey = e.decisionId + ':' + e.seq;
    if (eventIds.has(e.id) || eventIds.has('seq:' + eventKey)) {
      throw Object.assign(new Error('决策事件 id 或 seq 重复：' + e.id), { code: 'invalid_decision_record' });
    }
    eventIds.add(e.id);
    eventIds.add('seq:' + eventKey);
    if (!eventsByDecision.has(e.decisionId)) eventsByDecision.set(e.decisionId, []);
    eventsByDecision.get(e.decisionId).push(e);
  });
  decisions.forEach((d) => {
    const chain = Domain.validateDecisionEventChain(d, eventsByDecision.get(d.id) || []);
    if (!chain.ok) {
      throw Object.assign(new Error('决策事件链不完整：' + chain.error.detail), { code: chain.error.code });
    }
    chain.events.forEach((e) => {
      if (decisionSnapshotHash(e.snapshot) !== e.snapshotHash || decisionEventPayloadHash(e) !== e.payloadHash) {
        throw Object.assign(new Error('决策事件封存哈希与内容不一致：' + e.id), { code: 'invalid_decision_record' });
      }
    });
  });

  const linkIds = new Set();
  const activeEventLinks = new Set();
  const linkEventIds = new Set();
  decisionLinks.forEach((l) => {
    const checked = Domain.validateDecisionLinkRecord(l);
    if (!checked.ok) {
      throw Object.assign(new Error('关联行不合法：' + checked.error.detail), { code: checked.error.code });
    }
    if (!decisionIds.has(l.decisionId)) {
      throw Object.assign(new Error('关联行指向的决策不在写入集合中：' + l.decisionId), { code: 'invalid_decision_record' });
    }
    if (linkIds.has(l.id)) {
      throw Object.assign(new Error('关联行 id 重复：' + l.id), { code: 'invalid_decision_record' });
    }
    linkIds.add(l.id);
    linkEventIds.add(l.securityEventId);
    if (l.unlinkedOn == null) {
      if (activeEventLinks.has(l.securityEventId)) {
        throw Object.assign(new Error('同一证券事件被两条活动关联占用：' + l.securityEventId), { code: 'event_already_linked' });
      }
      activeEventLinks.add(l.securityEventId);
    }
  });
  linkEventIds.forEach((eventId) => {
    const ev = get(db, 'SELECT id, event_type FROM security_events WHERE id = ?', [eventId]);
    if (!ev || ev.event_type !== 'buy') {
      throw Object.assign(new Error('关联行引用的证券事件不存在或不是 buy：' + eventId), { code: 'linked_event_missing' });
    }
  });

  decisions.forEach((d) => insertDecisionRow(db, d));
  decisionEvents.forEach((e) => insertDecisionEventRow(db, e));
  decisionLinks.forEach((l) => {
    run(
      db,
      `INSERT INTO decision_links
         (id, decision_id, security_event_id, linked_on, linked_at, note, unlinked_on, unlinked_at, unlink_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [l.id, l.decisionId, l.securityEventId, l.linkedOn, l.linkedAt, l.note, l.unlinkedOn, l.unlinkedAt, l.unlinkNote]
    );
  });
}

/* ------------------------------ 全量读写 ------------------------------ */

const CLEAR_ORDER = [
  // Phase 6 的三张决策表在头部清空：decision_links 引用 security_events（RESTRICT）、
  // decision_events / decisions 引用 recommendations（CASCADE / RESTRICT），
  // 必须先于 recommendations 与 security_events 清空，否则 RESTRICT 会让整表重置失败。
  'decision_links',
  'decision_events',
  'decisions',
  // Phase 5D 的建议产物引用 risk_assessments / allocation_targets（ON DELETE RESTRICT），
  // 必须最先清空；它引用的快照与月结在本表**没有**外键（封存审计引用），顺序上前置也无副作用。
  'recommendations',
  // Phase 5C 的两张表引用 risk_assessments / instruments（ON DELETE RESTRICT），
  // 必须最先清空，否则 RESTRICT 会让整表重置失败（外键在语句级即时检查）。
  'allocation_targets',
  'approved_instruments',
  'close_snapshots',
  'monthly_closes',
  'asset_transfers',
  'risk_assessments',
  'dedup_candidates',
  'dedup_fingerprints',
  'security_events',
  'portfolio_openings',
  'quotes',
  'fx_rates',
  'account_units',
  'liabilities',
  'entitlements',
  'instruments',
  'asset_accounts',
  'institutions',
  'txns',
  'categories',
  'ledger_accounts',
  'app_settings'
];

function clearState(db) {
  CLEAR_ORDER.forEach((t) => {
    run(db, 'DELETE FROM ' + t);
  });
  run(db, 'DELETE FROM service_meta WHERE meta_key = ?', [TXNS_BLOB_META_KEY]);
  // sqlite_sequence 仅在有 AUTOINCREMENT 表时存在
  if (tableExists(db, 'sqlite_sequence')) run(db, 'DELETE FROM sqlite_sequence');
}

function normalizeAssets(raw, explicitlyProvided) {
  // 旧备份可能完全缺少 assets 或其中的新集合键：缺失键继续按空数组兼容。
  // 但 assets 一旦显式存在，就必须是非空普通对象；不能把 null / [] / '' / {}
  // 解释成“清空全部事实”。这项校验必须发生在 clearState 之前（4C 独立复核 P0）。
  if (explicitlyProvided && (
    !raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0
  )) {
    throw Object.assign(new Error('assets 必须是非空对象'), { code: 'invalid_assets' });
  }
  const out = {};
  ASSET_KEYS.forEach((k) => {
    if (raw && Object.prototype.hasOwnProperty.call(raw, k) && !Array.isArray(raw[k])) {
      throw Object.assign(new Error('资产集合 ' + k + ' 必须是数组'), {
        code: 'invalid_asset_collection'
      });
    }
    out[k] = raw && Array.isArray(raw[k]) ? raw[k] : [];
  });
  return out;
}

// 读取全量状态，形状与前端 DB.loadRaw() 完全一致
function readState(db) {
  const blob = readTxnsBlob(db);
  return {
    accounts: readAccounts(db),
    categories: readCategories(db),
    txns: blob == null ? readTxns(db) : blob,
    settings: readSettings(db),
    // 形状必须与前端 DB.loadRaw() 完全一致：assets 带 schemaVersion，
    // 且键集与 js/domain.js 的 ASSET_KEYS 一一对应（前端 normalizeAssets 依赖 schemaVersion）。
    assets: {
      schemaVersion: ASSETS_SCHEMA_VERSION,
      assetAccounts: readAssetAccounts(db),
      assetUnits: readAssetUnits(db),
      assetTransfers: readAssetTransfers(db),
      liabilities: readLiabilities(db),
      entitlements: readEntitlements(db),
      instruments: readInstruments(db),
      holdings: readOpenings(db),
      quotes: readQuotes(db),
      fxRates: readFxRates(db),
      securityEvents: readSecurityEvents(db)
    },
    // Phase 5B：风险评估是账务事实之外的独立集合，不并入 assets（ASSET_KEYS 与
    // assets.schemaVersion=1 是已冻结契约）。旧调用方缺省该键 → 全量写入后为空，
    // 与「旧库迁移后评估为空、不伪造默认评估」同一口径。
    riskAssessments: readRiskAssessments(db),
    // Phase 5C：目标版本与用户认可标的同样是 /state 顶层独立集合（同一口径）。
    allocationTargets: readAllocationTargets(db),
    approvedInstruments: readApprovedInstruments(db),
    // Phase 5D：建议产物是服务端算出的不可变计算结果，同样独立成集合（不参与 assets.schemaVersion）
    recommendations: readRecommendations(db),
    // Phase 6B：决策状态机三集合（决策 / 事件 / 关联行）—— /state 与备份的无损往返集合。
    decisions: readDecisionRows(db).filter(Boolean),
    decisionEvents: readDecisionEvents(db),
    decisionLinks: readDecisionLinks(db),
    monthlyCloses: listMonthlyCloses(db),
    closeSnapshots: readCloseSnapshots(db)
  };
}

// 全量写入：单事务、先清后写。相同输入重复写入结果一致（幂等）。
function writeState(db, state, options) {
  const opts = options || {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw Object.assign(new Error('state 必须是对象'), { code: 'invalid_state' });
  }
  const src = state;
  const hasAssets = Object.prototype.hasOwnProperty.call(src, 'assets');
  const assets = normalizeAssets(src.assets, hasAssets);
  const now = opts.now || new Date().toISOString();
  return transaction(db, () => {
    // UI 的旧五键全量保存不表达删除 5B/5C 追加式事实。缺失集合必须在本事务内
    // 先读后写，不能由客户端 GET 后带回，否则两次 HTTP 请求之间的并发写入会丢失。
    // 默认仍是「缺键即清空」；只有 API 明确传入该选项时才保留。
    const preservedCompanions = {};
    if (opts.preserveMissingCompanionCollections === true) {
      if (!Object.prototype.hasOwnProperty.call(src, 'riskAssessments')) {
        preservedCompanions.riskAssessments = readRiskAssessments(db);
      }
      if (!Object.prototype.hasOwnProperty.call(src, 'allocationTargets')) {
        preservedCompanions.allocationTargets = readAllocationTargets(db);
      }
      if (!Object.prototype.hasOwnProperty.call(src, 'approvedInstruments')) {
        preservedCompanions.approvedInstruments = readApprovedInstruments(db);
      }
      if (!Object.prototype.hasOwnProperty.call(src, 'recommendations')) {
        preservedCompanions.recommendations = readRecommendations(db);
      }
      // Phase 6B（6B，D-057）：决策三集合与建议同处一份事务保留清单 —— 记账的普通保存
      // 绝不表达「删掉用户的决策历史」。
      ['decisions', 'decisionEvents', 'decisionLinks'].forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(src, key)) {
          preservedCompanions[key] = key === 'decisions'
            ? readDecisionRows(db).filter(Boolean)
            : key === 'decisionEvents' ? readDecisionEvents(db) : readDecisionLinks(db);
        }
      });
    }
    for (const key of ['monthlyCloses', 'closeSnapshots']) {
      if (opts.preserveMissingCompanionCollections === true && !Object.prototype.hasOwnProperty.call(src, key)) {
        preservedCompanions[key] = key === 'monthlyCloses' ? listMonthlyCloses(db) : readCloseSnapshots(db);
      }
    }
    clearState(db);
    writeCloseHistory(db,
      Object.prototype.hasOwnProperty.call(src, 'monthlyCloses') ? src.monthlyCloses : preservedCompanions.monthlyCloses,
      Object.prototype.hasOwnProperty.call(src, 'closeSnapshots') ? src.closeSnapshots : preservedCompanions.closeSnapshots);
    writeSettings(db, src.settings);
    writeAccounts(db, Array.isArray(src.accounts) ? src.accounts : []);
    writeCategories(db, Array.isArray(src.categories) ? src.categories : []);
    if (Array.isArray(src.txns)) {
      writeTxns(db, src.txns);
    } else if (src.txns && typeof src.txns === 'object') {
      // 应用锁开启：只落密文，txns 表保持为空
      writeTxnsBlob(db, src.txns);
    }
    const ctx = { now: now };
    writeInstitutionsAndAccounts(db, assets.assetAccounts, ctx);
    writeAssetUnits(db, assets.assetUnits);
    writeAssetTransfers(db, assets.assetTransfers, { now: now });
    writeLiabilities(db, assets.liabilities);
    writeEntitlements(db, assets.entitlements);
    writeInstruments(db, assets.instruments);
    writeOpenings(db, assets.holdings);
    // 证券事件在期初快照之后写入：writeSecurityEvents 末尾的 strict 重放依赖期初数量
    writeSecurityEvents(db, assets.securityEvents);
    writeQuotes(db, assets.quotes);
    writeFxRates(db, assets.fxRates);
    // 风险评估显式存在时逐条校验写入（缺省 = 清空，与 assets 各集合的兼容语义一致）；
    // 存在但不是数组 → 显式拒绝，不静默丢弃（与 normalizeAssets 同纪律）。
    const riskAssessments = Object.prototype.hasOwnProperty.call(src, 'riskAssessments')
      ? src.riskAssessments : preservedCompanions.riskAssessments;
    if (riskAssessments !== undefined) {
      if (!Array.isArray(riskAssessments)) {
        throw Object.assign(new Error('riskAssessments 必须是数组'), { code: 'invalid_asset_collection' });
      }
      writeRiskAssessments(db, riskAssessments);
    }
    // Phase 5C 的两个集合与评估同一纪律：显式存在才逐条校验写入（任一条非法整体回滚），
    // 缺省 = 清空，存在但不是数组 = 显式拒绝。目标必须能在同一份载荷里找到它引用的评估。
    const allocationTargets = Object.prototype.hasOwnProperty.call(src, 'allocationTargets')
      ? src.allocationTargets : preservedCompanions.allocationTargets;
    if (allocationTargets !== undefined) {
      if (!Array.isArray(allocationTargets)) {
        throw Object.assign(new Error('allocationTargets 必须是数组'), { code: 'invalid_asset_collection' });
      }
      writeAllocationTargets(db, allocationTargets);
    }
    const approvedInstruments = Object.prototype.hasOwnProperty.call(src, 'approvedInstruments')
      ? src.approvedInstruments : preservedCompanions.approvedInstruments;
    if (approvedInstruments !== undefined) {
      if (!Array.isArray(approvedInstruments)) {
        throw Object.assign(new Error('approvedInstruments 必须是数组'), { code: 'invalid_asset_collection' });
      }
      writeApprovedInstruments(db, approvedInstruments);
    }
    // 建议产物排在评估与目标之后：它按 RESTRICT 引用两者，必须在同一事务里能看到被引用的行。
    const recommendations = Object.prototype.hasOwnProperty.call(src, 'recommendations')
      ? src.recommendations : preservedCompanions.recommendations;
    if (recommendations !== undefined) {
      if (!Array.isArray(recommendations)) {
        throw Object.assign(new Error('recommendations 必须是数组'), { code: 'invalid_asset_collection' });
      }
      writeRecommendations(db, recommendations);
    }
    // Phase 6B：决策三集合最后写入 —— decisions 按 RESTRICT 引用建议、decision_links 按
    // RESTRICT 引用证券事件，两者必须已在同一事务内可见（契约 §6.4 写入顺序）。
    // 显式存在才逐条校验写入；缺省 = 清空（与评估 / 目标 / 建议同一兼容语义）；非数组 = 显式拒绝。
    const decisionCollections = {};
    ['decisions', 'decisionEvents', 'decisionLinks'].forEach((key) => {
      const value = Object.prototype.hasOwnProperty.call(src, key)
        ? src[key] : preservedCompanions[key];
      if (value !== undefined && !Array.isArray(value)) {
        throw Object.assign(new Error(key + ' 必须是数组'), { code: 'invalid_asset_collection' });
      }
      decisionCollections[key] = value === undefined ? [] : value;
    });
    writeDecisions(db, decisionCollections);
    return { ok: true };
  });
}

function clearAll(db, options) {
  const opts = options || {};
  return transaction(db, () => {
    clearState(db);
    run(db, 'DELETE FROM idempotency_keys');
    return { ok: true, clearedAt: opts.now || new Date().toISOString() };
  });
}

/* ------------------------------ 只读资源视图（§5.6） ------------------------------ */

function readHoldings(db) {
  const ins = {};
  readInstruments(db).forEach((i) => {
    ins[i.id] = i;
  });
  const accs = {};
  readAssetAccounts(db).forEach((a) => {
    accs[a.id] = a;
  });
  const quotes = readQuotes(db);

  // 持仓数量只有一份推导口径（D-025）：有证券事件时展示推导数量
  // （期初 + Σ买入 − Σ卖出），无事件时期初快照本身就是推导结果，零回归。
  const openings = readOpenings(db);
  const events = readSecurityEvents(db);
  let rows;
  if (events.length > 0) {
    rows = Domain.deriveHoldings(openings, events).holdings.map((h) => ({
      id: h.openingId || 'derived:' + h.accountId + ':' + h.instrumentId,
      accountId: h.accountId,
      instrumentId: h.instrumentId,
      quantity: h.quantity,
      costMinor: h.openingCostMinor,
      asOf: h.openingAsOf,
      openingId: h.openingId,
      openingQuantity: h.openingQuantity,
      firstActivityAt: h.firstActivityAt,
      lastEventAt: h.lastEventAt,
      eventCounts: h.counts,
      oversellEvents: h.oversellEvents,
      boundarySkippedEvents: h.boundarySkippedEvents
    }));
  } else {
    rows = openings;
  }

  return rows.map((h) => {
    const instrument = ins[h.instrumentId] || null;
    const quote = quotes
      .filter((q) => q.instrumentId === h.instrumentId)
      .sort((a, b) => String(b.priceDate || '').localeCompare(String(a.priceDate || '')))[0];
    const out = {
      id: h.id,
      accountId: h.accountId,
      accountName: accs[h.accountId] ? accs[h.accountId].name : null,
      instrumentId: h.instrumentId,
      symbol: instrument ? instrument.symbol : null,
      assetClass: instrument ? instrument.assetClass || null : null,
      classificationStatus: instrument ? instrument.classificationStatus : null,
      quantity: h.quantity,
      costMinor: h.costMinor,
      asOf: h.asOf,
      latestQuote: quote || null
    };
    // 推导路径的附加字段（openingId / eventCounts / lastEventAt 等）必须透传，
    // 否则"数量从哪来"这条追溯链在接口响应里断掉。
    Object.keys(h).forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(out, k)) return;
      out[k] = h[k];
    });
    return out;
  });
}

function readInstitutionList(db) {
  const rows = all(db, 'SELECT id, name, kind FROM institutions ORDER BY rowid');
  const accounts = readAssetAccounts(db);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    accountCount: accounts.filter((a) => a.institution === r.name).length
  }));
}

/* ------------------------------ 幂等键（§5.6） ------------------------------ */

function findIdempotent(db, key, method, path) {
  const row = get(
    db,
    'SELECT response_json, method, path FROM idempotency_keys WHERE idempotency_key = ?',
    [key]
  );
  if (!row) return null;
  if (row.method !== method || row.path !== path) return null;
  if (row.response_json == null) return null;
  try {
    return JSON.parse(row.response_json);
  } catch (_) {
    return null;
  }
}

function rememberIdempotent(db, key, method, path, response) {
  run(
    db,
    'INSERT INTO idempotency_keys (idempotency_key, method, path, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
    [key, method, path, JSON.stringify(response == null ? null : response), new Date().toISOString()]
  );
}

/* ------------------------------ 服务元数据 ------------------------------ */

function getMeta(db, key) {
  const row = get(db, 'SELECT meta_value FROM service_meta WHERE meta_key = ?', [key]);
  return row ? row.meta_value : null;
}

function setMeta(db, key, value) {
  run(
    db,
    `INSERT INTO service_meta (meta_key, meta_value) VALUES (?, ?)
     ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value`,
    [key, value == null ? null : String(value)]
  );
}

/* ------------------------------ Phase 3：单条资源写入 ------------------------------ */

// 说明：writeState 是"全量替换"，资源级 POST 是"单条 upsert"。两者互为补充：
//   - 资源级写入用于资产录入页的逐条编辑（POST /api/v1/accounts 等）；
//   - 都必须在 transaction 内执行（调用方负责），保持"服务端是唯一写入者"。
// upsert 一律用 ON CONFLICT DO UPDATE，绝不用 INSERT OR REPLACE——
// REPLACE 是"删了再插"，会触发 account_units 等子表的 ON DELETE CASCADE，静默清掉余额。

function upsertInstitution(db, item, options) {
  const opts = options || {};
  const name = STR(item.name || '').trim();
  if (!name) throw Object.assign(new Error('机构名称不能为空'), { code: 'invalid_name' });
  const kind = STR(item.kind) || 'other';
  const id = item.id ? String(item.id) : institutionIdFor(name);
  run(
    db,
    `INSERT INTO institutions (id, name, kind, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET kind = excluded.kind`,
    [id, name, kind, opts.now || new Date().toISOString()]
  );
  return get(db, 'SELECT id, name, kind FROM institutions WHERE name = ?', [name]);
}

function upsertAssetAccount(db, a, options) {
  const opts = options || {};
  if (!a || !a.id) throw Object.assign(new Error('缺少账户 id'), { code: 'invalid_id' });
  const name = STR(a.name || '').trim();
  if (!name) throw Object.assign(new Error('账户名称不能为空'), { code: 'invalid_name' });
  let institutionId = null;
  const instName = typeof a.institution === 'string' ? a.institution.trim() : '';
  if (instName) {
    const inst = upsertInstitution(db, { name: instName, kind: a.institutionKind }, opts);
    institutionId = inst ? inst.id : null;
  }
  run(
    db,
    `INSERT INTO asset_accounts (id, institution_id, name, kind, pool, status, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       institution_id = excluded.institution_id,
       name = excluded.name,
       kind = excluded.kind,
       pool = excluded.pool,
       status = excluded.status,
       extra_json = excluded.extra_json`,
    [
      String(a.id),
      institutionId,
      name,
      STR(a.kind) || 'other',
      STR(a.pool) || 'safety',
      STR(a.status) || 'active',
      extraJson(a, KNOWN.assetAccounts)
    ]
  );
  return get(db, 'SELECT * FROM asset_accounts WHERE id = ?', [String(a.id)]);
}

function upsertAssetUnit(db, u, options) {
  const opts = options || {};
  if (!u || !u.id) throw Object.assign(new Error('缺少余额单元 id'), { code: 'invalid_id' });
  const exists = get(db, 'SELECT id FROM asset_accounts WHERE id = ?', [String(u.accountId)]);
  if (!exists) throw Object.assign(new Error('余额单元所属账户不存在'), { code: 'unknown_account' });
  if (u.balanceMinor != null && (!Number.isSafeInteger(u.balanceMinor) || u.balanceMinor < 0)) {
    throw Object.assign(new Error('余额必须是非负整数（最小货币单位）'), { code: 'invalid_amount' });
  }
  run(
    db,
    `INSERT INTO account_units (id, account_id, currency, balance_minor, as_of, source_type, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id,
       currency = excluded.currency,
       balance_minor = excluded.balance_minor,
       as_of = excluded.as_of,
       source_type = excluded.source_type,
       extra_json = excluded.extra_json`,
    [
      String(u.id),
      String(u.accountId),
      STR(u.currency) || 'CNY',
      u.balanceMinor == null ? null : u.balanceMinor,
      STR(u.asOf),
      STR(u.sourceType) || 'manual',
      extraJson(u, KNOWN.assetUnits)
    ]
  );
  return get(db, 'SELECT * FROM account_units WHERE id = ?', [String(u.id)]);
}

function upsertAssetTransfer(db, t, options) {
  const opts = options || {};
  if (!t || !t.id) throw Object.assign(new Error('缺少换汇记录 id'), { code: 'invalid_id' });
  if (t.fromUnitId === t.toUnitId) {
    throw Object.assign(new Error('换汇转出与转入子账户不能相同'), { code: 'same_unit' });
  }
  const from = get(db, 'SELECT id, currency FROM account_units WHERE id = ?', [String(t.fromUnitId)]);
  const to = get(db, 'SELECT id, currency FROM account_units WHERE id = ?', [String(t.toUnitId)]);
  if (!from || !to) {
    throw Object.assign(new Error('换汇关联的币种子账户不存在'), { code: 'unknown_unit' });
  }
  if (from.currency === to.currency) {
    throw Object.assign(new Error('换汇两端必须使用不同币种'), { code: 'same_currency' });
  }
  if (!Number.isSafeInteger(t.fromAmountMinor) || t.fromAmountMinor <= 0 ||
      !Number.isSafeInteger(t.toAmountMinor) || t.toAmountMinor <= 0) {
    throw Object.assign(new Error('换汇两端金额必须是正整数（最小货币单位）'), { code: 'invalid_amount' });
  }
  const createdAt = opts.now || new Date().toISOString();
  run(
    db,
    `INSERT INTO asset_transfers
       (id, from_unit_id, to_unit_id, from_currency, to_currency,
        from_amount_minor, to_amount_minor, occurred_on, source_type, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       from_unit_id = excluded.from_unit_id,
       to_unit_id = excluded.to_unit_id,
       from_currency = excluded.from_currency,
       to_currency = excluded.to_currency,
       from_amount_minor = excluded.from_amount_minor,
       to_amount_minor = excluded.to_amount_minor,
       occurred_on = excluded.occurred_on,
       source_type = excluded.source_type,
       note = excluded.note`,
    [
      String(t.id), String(t.fromUnitId), String(t.toUnitId), from.currency, to.currency,
      t.fromAmountMinor, t.toAmountMinor, String(t.occurredOn), STR(t.sourceType) || 'manual', STR(t.note), createdAt
    ]
  );
  return readAssetTransfers(db).find((item) => item.id === String(t.id)) || null;
}

// 手动维护汇率（Phase 3 补充，D-034）：同一个币对只保留一条，重复提交即更新。
// 追加历史行会让「当前汇率」无法从数据里唯一确定，也让导出与备份越来越难读；
// 需要历史汇率时由备份版本提供，而不是在活跃表里堆积。
function upsertFxRate(db, r, options) {
  const opts = options || {};
  if (!r || Domain.CURRENCIES.indexOf(r.base) === -1 || Domain.CURRENCIES.indexOf(r.quote) === -1) {
    throw Object.assign(new Error('汇率币种必须是 CNY/HKD/USD'), { code: 'invalid_currency' });
  }
  if (r.base === r.quote) {
    throw Object.assign(new Error('汇率的两端币种不能相同'), { code: 'same_currency' });
  }
  // Domain.parseDecimal 返回的是定点对象 {v, s}，不是数字：这里必须保留原字符串，
  // 直接 String(rate) 会写进 "[object Object]" 并让所有折算永久失败（P3-5）。
  const rateText = typeof r.rateDecimal === 'string' ? r.rateDecimal.trim() : String(r.rateDecimal);
  const rate = Domain.parseDecimal(rateText);
  if (!rate || !(rate.v > 0)) {
    throw Object.assign(new Error('汇率必须是大于 0 的定点十进制数'), { code: 'invalid_rate' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.rateDate || ''))) {
    throw Object.assign(new Error('汇率日期必须是 YYYY-MM-DD'), { code: 'invalid_rate_date' });
  }
  run(db, 'DELETE FROM fx_rates WHERE base = ? AND "quote" = ?', [String(r.base), String(r.quote)]);
  run(
    db,
    `INSERT INTO fx_rates (base, "quote", rate_decimal, rate_date, fetched_at, provider, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      String(r.base),
      String(r.quote),
      rateText,
      String(r.rateDate),
      opts.now || new Date().toISOString(),
      STR(r.provider) || 'manual',
      STR(r.status) || 'ok'
    ]
  );
  return readFxRates(db).find((x) => x.base === String(r.base) && x.quote === String(r.quote)) || null;
}

// 自动更新的汇率写入（Phase 4D，D-044 ②）：手动登记是"这个币对那一天的确认事实"，
// 自动源不得写入**同一天或更早**的观测（Domain.planMarketMerge 判定，跳过时返回 manual_locked）；
// 更新的数据日仍可写入，用户手动值不会被永久挡住。
// 元素键 = (币对, 汇率日)：只替换同一天的行，其他日期的自动历史保留（与手动路径的"整对替换"不同，
// 因为手动登记是"我确认过这个币对此刻的值"，自动更新是"逐日积累的观测值"）。
function upsertProviderFxRate(db, r, options) {
  const opts = options || {};
  const row = validateFxRow(r);
  if (!row.provider || row.provider === Domain.MANUAL_PROVIDER) {
    throw Object.assign(new Error('自动更新的汇率必须带真实 provider'), { code: 'invalid_provider' });
  }
  const existing = readFxRates(db).filter((x) => x.base === row.base && x.quote === row.quote);
  const plan = Domain.planMarketMerge('fx', existing, [row]);
  if (!plan.write.length) {
    return { status: 'skipped', reason: plan.skip[0] ? plan.skip[0].reason : 'not_writable', item: null };
  }
  run(db, 'DELETE FROM fx_rates WHERE base = ? AND "quote" = ? AND rate_date = ?', [
    row.base,
    row.quote,
    row.rateDate
  ]);
  run(
    db,
    `INSERT INTO fx_rates (base, "quote", rate_decimal, rate_date, fetched_at, provider, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.base,
      row.quote,
      row.rateDecimal,
      row.rateDate,
      opts.now || new Date().toISOString(),
      row.provider,
      row.status || 'ok'
    ]
  );
  const item = readFxRates(db).find(
    (x) => x.base === row.base && x.quote === row.quote && x.rateDate === row.rateDate
  ) || null;
  return { status: 'updated', reason: null, item: item };
}

function upsertLiability(db, l, options) {
  const opts = options || {};
  if (!l || !l.id) throw Object.assign(new Error('缺少负债 id'), { code: 'invalid_id' });
  const name = STR(l.name || '').trim();
  if (!name) throw Object.assign(new Error('负债名称不能为空'), { code: 'invalid_name' });
  if (l.balanceMinor != null && (!Number.isSafeInteger(l.balanceMinor) || l.balanceMinor < 0)) {
    throw Object.assign(new Error('负债金额必须是非负整数（最小货币单位）'), { code: 'invalid_amount' });
  }
  if (l.accountId && !get(db, 'SELECT id FROM asset_accounts WHERE id = ?', [String(l.accountId)])) {
    throw Object.assign(new Error('负债关联账户不存在'), { code: 'unknown_account' });
  }
  run(
    db,
    `INSERT INTO liabilities (id, account_id, name, currency, balance_minor, due_date, term_type, as_of, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id,
       name = excluded.name,
       currency = excluded.currency,
       balance_minor = excluded.balance_minor,
       due_date = excluded.due_date,
       term_type = excluded.term_type,
       as_of = excluded.as_of,
       extra_json = excluded.extra_json`,
    [
      String(l.id),
      l.accountId ? String(l.accountId) : null,
      name,
      STR(l.currency) || 'CNY',
      l.balanceMinor == null ? null : l.balanceMinor,
      STR(l.dueDate),
      STR(l.termType),
      STR(l.asOf),
      extraJson(l, KNOWN.liabilities)
    ]
  );
  return get(db, 'SELECT * FROM liabilities WHERE id = ?', [String(l.id)]);
}

function upsertEntitlement(db, e, options) {
  const opts = options || {};
  if (!e || !e.id) throw Object.assign(new Error('缺少保障权益 id'), { code: 'invalid_id' });
  const name = STR(e.name || '').trim();
  if (!name) throw Object.assign(new Error('权益名称不能为空'), { code: 'invalid_name' });
  // 无明确金额的权益必须留空（null），不允许 0 冒充已核实余额（ARCHITECTURE §5.5）
  if (e.balanceMinor != null && (!Number.isSafeInteger(e.balanceMinor) || e.balanceMinor < 0)) {
    throw Object.assign(new Error('权益金额必须是非负整数或留空'), { code: 'invalid_amount' });
  }
  run(
    db,
    `INSERT INTO entitlements (id, name, kind, jurisdiction, status, balance_minor, valuation_type, as_of, source_ref, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       jurisdiction = excluded.jurisdiction,
       status = excluded.status,
       balance_minor = excluded.balance_minor,
       valuation_type = excluded.valuation_type,
       as_of = excluded.as_of,
       source_ref = excluded.source_ref,
       extra_json = excluded.extra_json`,
    [
      String(e.id),
      name,
      STR(e.kind) || 'other',
      STR(e.jurisdiction),
      STR(e.status),
      e.balanceMinor == null ? null : e.balanceMinor,
      STR(e.valuationType),
      STR(e.asOf),
      STR(e.sourceRef),
      extraJson(e, KNOWN.entitlements)
    ]
  );
  return get(db, 'SELECT * FROM entitlements WHERE id = ?', [String(e.id)]);
}

/* ------------------------------ Phase 3：月度结账与快照 ------------------------------ */

function readCloseSnapshots(db) {
  return all(db, 'SELECT id FROM close_snapshots ORDER BY captured_at, id').map(row => getCloseSnapshot(db, row.id));
}

function writeCloseHistory(db, closes, snapshots) {
  for (const rows of [closes, snapshots]) {
    if (rows !== undefined && !Array.isArray(rows)) throw Object.assign(new Error('月结与快照必须是数组'), { code: 'invalid_asset_collection' });
  }
  const ids = new Map(), months = new Set(), snapIds = new Set();
  for (const c of closes || []) {
    if (!c || typeof c !== 'object' || !INSTRUMENT_ID_RE.test(c.id || '') ||
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(c.month || '') || !isDateStr(c.dataCutoff) ||
        !TARGET_ISO_RE.test(c.completedAt || '') || !['formal', 'estimate'].includes(c.status) ||
        !Array.isArray(c.blockers) || ids.has(c.id) || months.has(c.month)) {
      throw Object.assign(new Error('月结历史不合法或重复'), { code: 'invalid_state' });
    }
    ids.set(c.id, c); months.add(c.month);
    upsertMonthlyClose(db, c);
  }
  for (const s of snapshots || []) {
    if (!s || typeof s !== 'object' || !INSTRUMENT_ID_RE.test(s.id || '') || snapIds.has(s.id) ||
        !ids.has(s.closeId) || ids.get(s.closeId).month !== s.month ||
        !TARGET_ISO_RE.test(s.capturedAt || '') || typeof s.payloadJson !== 'string' ||
        sha256Hex(s.payloadJson) !== s.payloadHash) {
      throw Object.assign(new Error('月结快照引用或哈希不合法'), { code: 'invalid_state' });
    }
    try { const payload = JSON.parse(s.payloadJson); if (!payload || payload.month !== s.month) throw new Error(); }
    catch (_) { throw Object.assign(new Error('月结快照内容不合法'), { code: 'invalid_state' }); }
    snapIds.add(s.id); insertCloseSnapshot(db, s);
  }
  for (const c of closes || []) {
    if (c.snapshot && !snapIds.has(c.snapshot.id)) throw Object.assign(new Error('月结缺少引用快照'), { code: 'invalid_state' });
  }
}

function listMonthlyCloses(db) {
  return all(db, 'SELECT * FROM monthly_closes ORDER BY month DESC').map((row) => {
    let blockers = [];
    let summary = null;
    try { blockers = row.blockers_json ? JSON.parse(row.blockers_json) : []; } catch (_) { blockers = []; }
    try { summary = row.summary_json ? JSON.parse(row.summary_json) : null; } catch (_) { summary = null; }
    const snap = get(
      db,
      'SELECT id, payload_hash, captured_at FROM close_snapshots WHERE close_id = ? ORDER BY captured_at DESC LIMIT 1',
      [row.id]
    );
    return {
      id: row.id,
      month: row.month,
      status: row.status,
      completedAt: row.completed_at,
      dataCutoff: row.data_cutoff,
      blockerCount: blockers.length,
      blockers: blockers,
      summary: summary,
      snapshot: snap ? { id: snap.id, payloadHash: snap.payload_hash, capturedAt: snap.captured_at } : null
    };
  });
}

function getMonthlyCloseByMonth(db, month) {
  const row = get(db, 'SELECT id FROM monthly_closes WHERE month = ?', [month]);
  return row ? row.id : null;
}

function upsertMonthlyClose(db, c) {
  if (!c || !c.month || !/^\d{4}-\d{2}$/.test(String(c.month))) {
    throw Object.assign(new Error('month 必须是 YYYY-MM'), { code: 'invalid_month' });
  }
  run(
    db,
    `INSERT INTO monthly_closes (id, month, status, blockers_json, summary_json, completed_at, data_cutoff)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET
       id = excluded.id,
       status = excluded.status,
       blockers_json = excluded.blockers_json,
       summary_json = excluded.summary_json,
       completed_at = excluded.completed_at,
       data_cutoff = excluded.data_cutoff`,
    [
      String(c.id),
      String(c.month),
      c.status === 'formal' ? 'formal' : 'estimate',
      JSON.stringify(c.blockers || []),
      c.summary == null ? null : JSON.stringify(c.summary),
      String(c.completedAt),
      String(c.dataCutoff)
    ]
  );
  return get(db, 'SELECT * FROM monthly_closes WHERE month = ?', [String(c.month)]);
}

function insertCloseSnapshot(db, snap) {
  run(
    db,
    `INSERT INTO close_snapshots (id, close_id, month, captured_at, snapshot_type, payload_json, payload_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      String(snap.id),
      snap.closeId ? String(snap.closeId) : null,
      String(snap.month),
      String(snap.capturedAt),
      STR(snap.snapshotType) || 'monthly_close',
      String(snap.payloadJson),
      String(snap.payloadHash)
    ]
  );
  return get(db, 'SELECT id, payload_hash FROM close_snapshots WHERE id = ?', [String(snap.id)]);
}

function getCloseSnapshotPayload(db, id) {
  const row = get(db, 'SELECT payload_json FROM close_snapshots WHERE id = ?', [String(id)]);
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json);
  } catch (_) {
    return null;
  }
}

// 快照明细读取（Phase 3 补充，D-034）：金额下钻需要原始 payload_json 做哈希复核，
// 因此除解析后的对象外也返回原始字符串，避免调用方各自 stringify 造成哈希口径分叉。
function getCloseSnapshot(db, id) {
  const row = get(
    db,
    'SELECT id, close_id, month, captured_at, snapshot_type, payload_json, payload_hash FROM close_snapshots WHERE id = ?',
    [String(id)]
  );
  if (!row) return null;
  return {
    id: row.id,
    closeId: row.close_id,
    month: row.month,
    capturedAt: row.captured_at,
    snapshotType: row.snapshot_type,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash
  };
}

module.exports = {
  ASSET_KEYS,
  LEGACY_KEYS,
  TXNS_BLOB_META_KEY,
  readState,
  writeState,
  clearAll,
  readAssetAccounts,
  readAssetUnits,
  readAssetTransfers,
  readLiabilities,
  readEntitlements,
  readInstruments,
  readInstrumentRecords,
  getInstrument,
  findInstrumentByKey,
  upsertInstrument,
  readOpenings,
  readSecurityEvents,
  readQuotes,
  upsertManualQuote,
  upsertProviderQuote,
  replaceQuoteRows,
  readFxRates,
  readTxns,
  readAccounts,
  readCategories,
  readSettings,
  readHoldings,
  readInstitutionList,
  findIdempotent,
  rememberIdempotent,
  getMeta,
  setMeta,
  institutionIdFor,
  upsertInstitution,
  upsertAssetAccount,
  upsertAssetUnit,
  upsertAssetTransfer,
  upsertLiability,
  upsertEntitlement,
  listMonthlyCloses,
  getMonthlyCloseByMonth,
  upsertMonthlyClose,
  insertCloseSnapshot,
  getCloseSnapshotPayload,
  getCloseSnapshot,
  upsertFxRate,
  upsertProviderFxRate,
  validateFxRow,
  upsertSecurityEvent,
  getSecurityEvent,
  upsertPortfolioOpening,
  readRiskAssessments,
  getRiskAssessment,
  insertRiskAssessment,
  writeRiskAssessments,
  validateRiskAssessmentRow,
  /* Phase 5C：目标版本（追加式）与用户认可标的映射 */
  readAllocationTargets,
  getAllocationTarget,
  insertAllocationTarget,
  writeAllocationTargets,
  validateAllocationTargetRow,
  readApprovedInstruments,
  readApprovedMappingView,
  writeApprovedInstruments,
  replaceApprovedInstrumentClass,
  // Phase 5D：建议产物（不可变计算结果）与哈希口径
  readRecommendations,
  readRecommendationView,
  getRecommendation,
  insertRecommendation,
  writeRecommendations,
  validateRecommendationRow,
  recommendationInputHash,
  recommendationRecordId,
  canonicalJson,
  sha256Hex,
  validateApprovedInstrumentRow,
  approvedInstrumentId,
  /* Phase 6B：决策状态机、事件与关联（D-057） */
  readDecisionRows,
  readDecisionEvents,
  readDecisionLinks,
  getDecisionRow,
  getDecisionEvents,
  insertDecisionRow,
  insertDecisionEventRow,
  updateDecisionForRow,
  writeDecisions,
  readValidatedDecisions,
  validateDecisionWithIntegrity,
  decisionSnapshotHash,
  decisionEventPayloadHash
};
