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
const backupLib = require('./backup');
const keychain = require('./keychain');
const migrations = require('./migrations');
const Domain = require('../js/domain.js');

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
// Phase 3 已实现：institutions / accounts / account-units / liabilities / entitlements
// 与 monthly-closes（ROADMAP Phase 3 工作项 1–6）。
const DEFERRED_WRITES = {
  'POST /api/v1/portfolio-openings': 'Phase 4',
  'POST /api/v1/security-events': 'Phase 4',
  'POST /api/v1/market-data/refresh': 'Phase 4',
  'POST /api/v1/risk-assessments': 'Phase 5',
  'POST /api/v1/recommendations': 'Phase 5'
};

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
    const state = R.readState(ctx.db);
    sendJson(res, 200, state, { 'X-Ledger-Schema': String(migrations.currentVersion(ctx.db)) });
  };

  api['PUT /api/v1/state'] = async (req, res) => {
    const body = await readBody(req);
    const state = body && body.state ? body.state : body;
    if (!state || typeof state !== 'object') {
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
    R.writeState(ctx.db, state);
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
    const asOf = isDateStr(req.query.asOf) ? req.query.asOf : localDateStr();
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
    const status = code === 'unknown_account' ? 422 : 400;
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
    // 月均必要支出：优先取前端按现金流算出的值（最近 3 个完整月），回落到 settings；
    // 覆盖月数由服务端用该值重算，不直接采信任何覆盖率结果（§5.6 服务端是唯一写入者）
    const clientAvg = body && Number.isSafeInteger(body.avgNecessaryMinor) && body.avgNecessaryMinor > 0
      ? body.avgNecessaryMinor
      : null;
    const settingsAvg = typeof settings.avgNecessaryMinor === 'number' && settings.avgNecessaryMinor > 0
      ? settings.avgNecessaryMinor
      : null;
    const avgNecessary = clientAvg || settingsAvg;
    const emergencyMonths = avgNecessary
      ? Domain.emergencyCoverageMonths(overview.pools.safetyMinor, avgNecessary)
      : null;

    const nowIso = new Date().toISOString();
    const closeId = R.getMonthlyCloseByMonth(ctx.db, month) || newResourceId('close');
    const snapshotId = newResourceId('snap');
    const payloadJson = JSON.stringify({
      month: month,
      asOf: asOf,
      status: status,
      overview: overview,
      checklist: checklist,
      emergencyCoverageMonths: emergencyMonths
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
            emergencyCoverageMonths: emergencyMonths
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
      snapshot: { id: snapshotId, payloadHash: payloadHash, capturedAt: nowIso }
    });
  };

  api['GET /api/v1/instruments'] = (req, res) => {
    sendJson(res, 200, { items: R.readInstruments(ctx.db) });
  };
  api['GET /api/v1/holdings'] = (req, res) => {
    sendJson(res, 200, { items: R.readHoldings(ctx.db) });
  };
  api['GET /api/v1/quotes'] = (req, res) => {
    sendJson(res, 200, { items: R.readQuotes(ctx.db) });
  };
  api['GET /api/v1/fx-rates'] = (req, res) => {
    sendJson(res, 200, { items: R.readFxRates(ctx.db) });
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
          const status = code === 'invalid_json' ? 400 : code === 'payload_too_large' ? 413 : 500;
          ctx.logger.error('处理 ' + key + ' 失败：' + (err && err.message ? err.message : String(err)));
          fail(res, status, code, err && err.message ? err.message : '服务内部错误', status >= 500);
        });
      }
      return undefined;
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
    if (/^POST \/api\/v1\/decisions\/[^/]+\/events$/.test(key)) {
      return fail(res, 501, 'not_implemented', '决策事件属于 Phase 6 的交付范围', false);
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
