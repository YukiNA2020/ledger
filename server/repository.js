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
    'occurredAt'
  ],
  quotes: ['instrumentId', 'priceMinor', 'currency', 'priceDate', 'fetchedAt', 'provider', 'status'],
  fxRates: ['base', 'quote', 'rateDecimal', 'rateDate', 'fetchedAt', 'provider', 'status'],
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
  if (!get(db, 'SELECT id FROM asset_accounts WHERE id = ?', [String(o.accountId)])) {
    throw Object.assign(new Error('期初快照关联的账户不存在（' + where + '）'), { code: 'unknown_account' });
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
    occurredAt: String(e.occurredAt)
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
      extraJson(ev, KNOWN.securityEvents)
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
  if (!get(db, 'SELECT id FROM asset_accounts WHERE id = ?', [ev.accountId])) {
    throw Object.assign(new Error('事件关联的账户不存在'), { code: 'unknown_account' });
  }
  if (!get(db, 'SELECT id FROM instruments WHERE id = ?', [ev.instrumentId])) {
    throw Object.assign(new Error('事件关联的标的不存在'), { code: 'unknown_instrument' });
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

function writeQuotes(db, list) {
  const st = db.prepare(
    `INSERT INTO quotes (instrument_id, price_minor, currency, price_date, fetched_at, provider, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  (list || []).forEach((q) => {
    if (!q || !q.instrumentId) return;
    st.run(
      String(q.instrumentId),
      NUM(q.priceMinor),
      STR(q.currency) || 'CNY',
      STR(q.priceDate),
      STR(q.fetchedAt),
      STR(q.provider),
      STR(q.status)
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
    return out;
  });
}

function writeFxRates(db, list) {
  const st = db.prepare(
    `INSERT INTO fx_rates (base, "quote", rate_decimal, rate_date, fetched_at, provider, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  (list || []).forEach((r) => {
    if (!r || !r.base || !r.quote) return;
    st.run(
      String(r.base),
      String(r.quote),
      STR(r.rateDecimal) || '0',
      STR(r.rateDate),
      STR(r.fetchedAt),
      STR(r.provider),
      STR(r.status)
    );
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

/* ------------------------------ 全量读写 ------------------------------ */

const CLEAR_ORDER = [
  'close_snapshots',
  'monthly_closes',
  'asset_transfers',
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

function normalizeAssets(raw) {
  const out = {};
  ASSET_KEYS.forEach((k) => {
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
    }
  };
}

// 全量写入：单事务、先清后写。相同输入重复写入结果一致（幂等）。
function writeState(db, state, options) {
  const opts = options || {};
  const src = state || {};
  const assets = normalizeAssets(src.assets);
  const now = opts.now || new Date().toISOString();
  return transaction(db, () => {
    clearState(db);
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
  upsertSecurityEvent,
  getSecurityEvent,
  upsertPortfolioOpening
};
