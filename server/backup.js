/* 小账本 server/backup.js — 本地版本化备份与恢复（Phase 2）
 *
 * 依据 ARCHITECTURE §9：
 *   - 写事务完成后按节流策略创建版本备份，至少每日一份，保留最近 30 份（A-003）；
 *   - 备份先写临时文件并校验，再原子替换目标文件；
 *   - 恢复前自动备份当前数据库；恢复在临时数据库校验完成后切换；
 *   - 恢复失败不得破坏当前数据库。
 *
 * 实现说明：
 *   - 快照用 SQLite 自身的 `VACUUM INTO`：同步、确定性、产物自包含（不带 -wal/-shm），
 *     读的是含 WAL 未落盘内容的一致性视图；
 *     （不用 node:sqlite 的在线 backup()：它在长进程里会不可预测地停住，实测同类调用
 *      前两次 1ms、之后每次 8 秒甚至挂死；本地小库用 VACUUM INTO 稳定 0-1ms）
 *   - 校验包含 integrity_check、必需表齐备、schema 版本不高于本程序已知版本；
 *   - 切换采用"先改名保留、验证通过后再删"的顺序，任何一步失败都能把原库放回去。
 *
 * 快照一致性前提：本程序用单实例锁保证同一时刻只有一个写进程，
 * 且 createBackup 只在写事务之外调用（见 ARCHITECTURE §9），因此快照期间不会有并发写入。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dbm = require('./db');
const repository = require('./repository');
const { LATEST_VERSION, migrate, currentVersion } = require('./migrations');
const { BACKUP_KEEP } = require('./config');

// 必需表随 schema 版本增长：v1 建立基础表，v2 加月结两表，v3 加换汇事实表。
// 只按「候选库自己声明的版本」校验对应集合 —— 否则一个声称 v3 但被删过表的库
// 会通过校验（迁移器看到 v3 已应用也不会重建缺表），恢复后在使用中才炸（D-034）。
const REQUIRED_TABLES_V1 = [
  'schema_migrations',
  'asset_accounts',
  'account_units',
  'liabilities',
  'entitlements',
  'instruments',
  'portfolio_openings',
  'security_events',
  'quotes',
  'fx_rates',
  'txns',
  'categories',
  'ledger_accounts',
  'app_settings',
  'service_meta'
];

const REQUIRED_TABLES_BY_VERSION = {
  2: ['monthly_closes', 'close_snapshots'],
  3: ['asset_transfers'],
  8: ['risk_assessments'],
  9: ['allocation_targets', 'approved_instruments'],
  10: ['recommendations'],
  11: ['decisions', 'decision_events', 'decision_links']
};

// 必需**索引**随 schema 版本增长：有些不变量由索引承载，光看表齐不齐看不出来。
// v4 把「同一 (symbol, exchange) 只有一行事实」变成数据库不变量（表达式唯一索引）——
// 索引被手工删掉后，迁移器看到 v4 已应用不会重建，于是这个库会静默失去该不变量
// （第二轮复核 G4B-6：DROP INDEX 后校验仍返回 ok）。
const REQUIRED_INDEXES_BY_VERSION = {
  4: [{ table: 'instruments', name: 'uq_instruments_dedupe', unique: true }],
  6: [{
    table: 'portfolio_openings',
    name: 'uq_portfolio_openings_dedupe',
    unique: true,
    columns: ['account_id', 'instrument_id'],
    partial: false
  }],
  8: [{ table: 'risk_assessments', name: 'idx_risk_assessments_assessed', unique: false }],
  // Phase 5C（D-048）：目标的自然键唯一索引与「一个标的一处映射、类别内顺序不重复」两条唯一索引
  // 都承载不变量 —— 被手工删掉后迁移器不会重建，于是重复目标 / 跨类别冲突映射能静默写回，
  // 因此按版本登记在恢复切换之前校验（与 v4 / v6 同一纪律）。
  9: [
    {
      table: 'allocation_targets',
      name: 'uq_allocation_targets_natural',
      unique: true,
      columns: ['assessment_id', 'template_version', 'effective_from']
    },
    { table: 'allocation_targets', name: 'idx_allocation_targets_effective', unique: false },
    { table: 'approved_instruments', name: 'uq_approved_instruments_instrument', unique: true },
    {
      table: 'approved_instruments',
      name: 'uq_approved_instruments_slot',
      unique: true,
      columns: ['asset_class', 'position']
    }
  ],
  // Phase 5D（D-049）：input_hash 唯一索引承载「同一份输入只有一份建议产物」这条幂等不变量，
  // 被删掉后同一请求能写出多行互相矛盾的建议，因此与 v4 / v6 / v9 同纪律按名校验。
  10: [
    { table: 'recommendations', name: 'uq_recommendations_input', unique: true, columns: ['input_hash'] },
    { table: 'recommendations', name: 'idx_recommendations_created', unique: false }
  ],
  // Phase 6B（D-057）：决策状态机三条不变量都由索引承载 —— 「一条建议最多一条决策」
  // （uq_decisions_recommendation）、「事件 seq 每条决策内从 1 连续递增」（uq_decision_events_seq）、
  // 「一条证券事件同时只属一条活动决策」（uq_decision_links_active，部分唯一索引）。
  // 部分索引被手工换成普通索引会让活动关联唯一性静默失效，校验必须对称检查 partial 标记。
  11: [
    {
      table: 'decisions',
      name: 'uq_decisions_recommendation',
      unique: true,
      columns: ['recommendation_id']
    },
    {
      table: 'decision_events',
      name: 'uq_decision_events_seq',
      unique: true,
      columns: ['decision_id', 'seq']
    },
    {
      table: 'decision_links',
      name: 'uq_decision_links_active',
      unique: true,
      columns: ['security_event_id'],
      partial: true
    },
    { table: 'decision_links', name: 'idx_decision_links_decision', unique: false }
  ]
};

// 必需**列**随 schema 版本增长（复核 G4C-6）：有些事实承载在列上，光看表齐不齐看不出来。
// v5 的 amount_minor 承载分红/费用事件总额——缺列的 v5 库恢复后迁移器不会补列
// （版本已应用），读取事件时才炸。校验必须把这类库挡在切换之前。
// v7 的 quotes.source_symbol 承载行情 provider 返回的原始代码（Phase 4D 追溯要求）。
// v8 的 risk_assessments 整表新增：这里登记承载冻结语义的列（原始答案、当时规则版本、
// 双评分、上限判定、日期与复评原因），缺任何一列都无法证明历史评估可追溯。
const REQUIRED_COLUMNS_BY_VERSION = {
  5: [{ table: 'security_events', name: 'amount_minor' }],
  7: [{ table: 'quotes', name: 'source_symbol' }],
  8: [
    { table: 'risk_assessments', name: 'answers_json' },
    { table: 'risk_assessments', name: 'rule_version' },
    { table: 'risk_assessments', name: 'capacity_score' },
    { table: 'risk_assessments', name: 'willingness_score' },
    { table: 'risk_assessments', name: 'risk_ceiling' },
    { table: 'risk_assessments', name: 'ceiling_source' },
    { table: 'risk_assessments', name: 'assessed_at' },
    { table: 'risk_assessments', name: 'expiry' },
    { table: 'risk_assessments', name: 'reason' },
    { table: 'risk_assessments', name: 'created_at' }
  ],
  // v9（Phase 5C）：目标版本承载「来自哪一份评估、哪个模板/规则版本、何时生效」，
  // 认可标的承载「类别 → 标的 → 用户顺序」。缺任何一列都无法证明目标可追溯或映射未被改写。
  9: [
    { table: 'allocation_targets', name: 'classes_json' },
    { table: 'allocation_targets', name: 'template_version' },
    { table: 'allocation_targets', name: 'rule_version' },
    { table: 'allocation_targets', name: 'level' },
    { table: 'allocation_targets', name: 'assessment_id' },
    { table: 'allocation_targets', name: 'assessed_at' },
    { table: 'allocation_targets', name: 'assessment_expiry' },
    { table: 'allocation_targets', name: 'effective_from' },
    { table: 'allocation_targets', name: 'created_at' },
    { table: 'approved_instruments', name: 'asset_class' },
    { table: 'approved_instruments', name: 'instrument_id' },
    { table: 'approved_instruments', name: 'position' },
    { table: 'approved_instruments', name: 'created_at' },
    { table: 'approved_instruments', name: 'updated_at' }
  ],
  // v10（Phase 5D）：建议产物承载「引用了哪份快照 / 评估 / 目标、请求与可分配金额、门禁明细、
  // 结果本体与哈希」。缺任何一列，Phase 6 接手的就不再是可追溯的封存计算结果。
  10: [
    { table: 'recommendations', name: 'status' },
    { table: 'recommendations', name: 'rule_version' },
    { table: 'recommendations', name: 'target_version' },
    { table: 'recommendations', name: 'assessment_id' },
    { table: 'recommendations', name: 'target_id' },
    { table: 'recommendations', name: 'close_id' },
    { table: 'recommendations', name: 'snapshot_id' },
    { table: 'recommendations', name: 'snapshot_hash' },
    { table: 'recommendations', name: 'data_cutoff' },
    { table: 'recommendations', name: 'as_of' },
    { table: 'recommendations', name: 'requested_new_funds_minor' },
    { table: 'recommendations', name: 'allocatable_new_funds_minor' },
    { table: 'recommendations', name: 'allocated_total_minor' },
    { table: 'recommendations', name: 'input_hash' },
    { table: 'recommendations', name: 'gate_json' },
    { table: 'recommendations', name: 'todos_json' },
    { table: 'recommendations', name: 'result_json' },
    { table: 'recommendations', name: 'payload_hash' },
    { table: 'recommendations', name: 'created_at' }
  ],
  // v11（Phase 6B）：决策状态机承载「绑定哪条建议、当前状态与事件链长度、封存快照与哈希、
  // 软删除关联」。缺任何一列都无法证明决策历史可追溯、快照可复核。
  11: [
    { table: 'decisions', name: 'recommendation_id' },
    { table: 'decisions', name: 'state' },
    { table: 'decisions', name: 'last_seq' },
    { table: 'decisions', name: 'created_at' },
    { table: 'decisions', name: 'updated_at' },
    { table: 'decision_events', name: 'decision_id' },
    { table: 'decision_events', name: 'seq' },
    { table: 'decision_events', name: 'from_state' },
    { table: 'decision_events', name: 'to_state' },
    { table: 'decision_events', name: 'reason_code' },
    { table: 'decision_events', name: 'occurred_at' },
    { table: 'decision_events', name: 'recorded_at' },
    { table: 'decision_events', name: 'actor' },
    { table: 'decision_events', name: 'snapshot_hash' },
    { table: 'decision_events', name: 'payload_hash' },
    { table: 'decision_links', name: 'decision_id' },
    { table: 'decision_links', name: 'security_event_id' },
    { table: 'decision_links', name: 'linked_on' },
    { table: 'decision_links', name: 'unlinked_on' }
  ]
};

function requiredTablesFor(version) {
  let tables = REQUIRED_TABLES_V1.slice();
  Object.keys(REQUIRED_TABLES_BY_VERSION).forEach((v) => {
    if (version >= Number(v)) tables = tables.concat(REQUIRED_TABLES_BY_VERSION[v]);
  });
  return tables;
}

function requiredIndexesFor(version) {
  let list = [];
  Object.keys(REQUIRED_INDEXES_BY_VERSION).forEach((v) => {
    if (version >= Number(v)) list = list.concat(REQUIRED_INDEXES_BY_VERSION[v]);
  });
  return list;
}

function requiredColumnsFor(version) {
  let list = [];
  Object.keys(REQUIRED_COLUMNS_BY_VERSION).forEach((v) => {
    if (version >= Number(v)) list = list.concat(REQUIRED_COLUMNS_BY_VERSION[v]);
  });
  return list;
}

// 当前程序（最新 schema 版本）要求的完整表集合：供迁移与备份测试断言「新库表齐备」
const REQUIRED_TABLES = requiredTablesFor(LATEST_VERSION);

const BACKUP_PREFIX = 'ledger-';
const LAST_BACKUP_META = 'last_backup_at';

const pad = (n) => String(n).padStart(2, '0');

function stamp(now) {
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function dayStamp(now) {
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate());
}

function backupFileName(now, reason) {
  return BACKUP_PREFIX + stamp(now) + '-' + reason + '.db';
}

// 目标文件已存在时追加 -1/-2 后缀，避免同秒内两次同名备份（例如同一秒里连续两次
// 恢复或清空）互相覆盖，导致更早那份保护性快照丢失（S3 完整性：覆盖前版本必须可找回）。
function uniqueBackupPath(backupDir, now, reason) {
  const base = path.join(backupDir, backupFileName(now, reason));
  let candidate = base;
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(backupDir, backupFileName(now, reason).replace(/\.db$/, '-' + n + '.db'));
    n += 1;
  }
  return candidate;
}

// 按文件名降序（= 时间降序，同一秒内按 reason 稳定）
function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((n) => n.indexOf(BACKUP_PREFIX) === 0 && n.endsWith('.db'))
    .sort()
    .reverse()
    .map((n) => {
      const full = path.join(backupDir, n);
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch (_) {
        /* 文件在列举与 stat 之间消失时按 0 处理，不中断列表 */
      }
      return { name: n, path: full, size: size, day: n.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 8) };
    });
}

// 打开候选文件做校验时，SQLite 可能为 WAL 库生成 -wal/-shm 同伴文件。
// 校验必须无副作用：临时副本用完即清，避免在 backups 目录留下孤立文件。
function removeSidecars(file) {
  [file + '-wal', file + '-shm', file + '-journal'].forEach((f) => {
    try {
      fs.unlinkSync(f);
    } catch (_) {
      /* 不存在则忽略 */
    }
  });
}

// 校验一个候选备份文件：能打开、结构完整、必需表齐备、schema 版本已知
// 校验必须无副作用：只清理"因本次打开而新出现"的同伴文件，绝不删除调用前就存在的文件
// （例如活跃数据库真实的 -wal）。
function validateBackupFile(file, options) {
  const opts = options || {};
  if (!fs.existsSync(file)) return { ok: false, reason: '文件不存在' };
  const sidecars = [file + '-wal', file + '-shm', file + '-journal'];
  const preexisting = sidecars.filter((f) => fs.existsSync(f));
  const created = () => sidecars.filter((f) => preexisting.indexOf(f) === -1 && fs.existsSync(f));
  let db = null;
  try {
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch (_) {
      db = new DatabaseSync(file, { readOnly: false });
    }
    const integrity = dbm.integrityCheck(db);
    if (String(integrity).toLowerCase() !== 'ok') {
      return { ok: false, reason: '完整性检查未通过：' + integrity };
    }
    // 先确认可以读出 schema 版本，再按该版本校验必需表（版本表本身也必须在）
    if (!dbm.tableExists(db, 'schema_migrations')) {
      return { ok: false, reason: '缺少必需表：schema_migrations' };
    }
    const version = currentVersion(db);
    if (version < 1) return { ok: false, reason: 'schema 版本为空' };
    if (version > LATEST_VERSION) {
      return { ok: false, reason: '备份来自更新的版本（v' + version + ' > v' + LATEST_VERSION + '）' };
    }
    const missing = requiredTablesFor(version).filter((t) => !dbm.tableExists(db, t));
    if (missing.length) return { ok: false, reason: '缺少必需表：' + missing.join(', ') };
    // 表齐了还不够：按同一版本校验承载不变量的必需索引（存在 + 唯一属性）
    for (const spec of requiredIndexesFor(version)) {
      const info = dbm.indexInfo(db, spec.table, spec.name);
      if (!info) {
        return { ok: false, reason: '缺少必需索引：' + spec.name + '（表 ' + spec.table + '）' };
      }
      if (spec.unique && !info.unique) {
        return { ok: false, reason: '必需索引不是唯一索引：' + spec.name };
      }
      if (Array.isArray(spec.columns)) {
        const sameColumns = info.columns.length === spec.columns.length &&
          info.columns.every((name, i) => name === spec.columns[i]);
        if (!sameColumns) {
          return {
            ok: false,
            reason: '必需索引列不匹配：' + spec.name +
              '（应为 ' + spec.columns.join(', ') + '，实际为 ' + info.columns.join(', ') + '）'
          };
        }
      }
      if (spec.partial === false && info.partial) {
        return { ok: false, reason: '必需索引不能是部分索引：' + spec.name };
      }
      // 对称校验（Phase 6B，契约 §6.5）：把部分唯一索引手工换成普通唯一索引后，表还在、
      // 唯一性还在，但「活动关联唯一」的不变量已经静默失效 —— 只有 partial 标记能发现。
      if (spec.partial === true && !info.partial) {
        return { ok: false, reason: '必需索引必须是部分索引：' + spec.name };
      }
    }
    // 索引之外还有承载事实的必需列（复核 G4C-6）：缺列的库恢复后迁移器不会补列，
    // 读取时会才炸——同样挡在切换之前。
    for (const col of requiredColumnsFor(version)) {
      if (dbm.columnNames(db, col.table).indexOf(col.name) === -1) {
        return { ok: false, reason: '缺少必需列：' + col.table + '.' + col.name };
      }
    }
    // 结构完整不代表决策历史可信：候选库必须在切换前经过与列表/详情同一份
    // 事件链、原文哈希、建议引用与活动 buy 关联复核（契约 §4.5 / §9）。
    // 唯一例外是恢复前保存旧活库的取证快照；它不被当作可恢复候选。
    if (version >= 11 && !opts.preserveInvalidDecisionHistory) {
      try {
        repository.assertDecisionHistoryValid(db);
      } catch (err) {
        return { ok: false, reason: '决策历史复核失败：' + (err && err.message ? err.message : String(err)) };
      }
    }
    return { ok: true, schemaVersion: version };
  } catch (err) {
    return { ok: false, reason: '无法作为数据库打开：' + (err && err.message ? err.message : String(err)) };
  } finally {
    dbm.closeQuietly(db);
    created().forEach((f) => {
      try {
        fs.unlinkSync(f);
      } catch (_) {
        /* 同伴文件已被移除时忽略 */
      }
    });
  }
}

function pruneBackups(backupDir, keep) {
  const limit = Number.isFinite(keep) && keep > 0 ? keep : BACKUP_KEEP;
  const dropped = listBackups(backupDir).slice(limit);
  dropped.forEach((b) => {
    try {
      fs.unlinkSync(b.path);
    } catch (_) {
      /* 单个备份删除失败不影响其余保留策略 */
    }
  });
  // 顺带清理中断操作留下的临时文件与同伴文件
  if (fs.existsSync(backupDir)) {
    fs.readdirSync(backupDir)
      .filter((n) => /\.tmp(-wal|-shm|-journal)?$/.test(n))
      .forEach((n) => {
        try {
          fs.unlinkSync(path.join(backupDir, n));
        } catch (_) {
          /* 忽略 */
        }
      });
  }
  return dropped.map((b) => b.name);
}

// 用 SQLite 自身的 VACUUM INTO 生成一份自包含快照。
// 同步执行、结果确定、不带 -wal/-shm；目标已存在时必须先删（SQLite 拒绝覆盖）。
function snapshotTo(db, destPath) {
  const tmpLeftover = [destPath, destPath + '-wal', destPath + '-shm', destPath + '-journal'];
  tmpLeftover.forEach((f) => {
    try {
      fs.unlinkSync(f);
    } catch (_) {
      /* 不存在则忽略 */
    }
  });
  if (!db) throw new Error('数据库连接不可用，无法创建快照');
  try {
    db.exec("VACUUM INTO '" + String(destPath).replace(/'/g, "''") + "'");
  } catch (err) {
    throw new Error('创建快照失败：' + (err && err.message ? err.message : String(err)));
  }
  try {
    fs.chmodSync(destPath, 0o600);
  } catch (_) {
    /* 权限设置失败不阻断快照 */
  }
  return destPath;
}

// 创建一份版本备份：临时文件 → 校验 → 原子替换 → 裁剪
async function createBackup(db, paths, options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const reason = opts.reason || 'auto';
  fs.mkdirSync(paths.backupDir, { recursive: true, mode: 0o700 });

  const finalPath = uniqueBackupPath(paths.backupDir, now, reason);
  const tmpPath = finalPath + '.tmp';

  snapshotTo(db, tmpPath);

  const check = validateBackupFile(tmpPath, {
    preserveInvalidDecisionHistory: opts.preserveInvalidDecisionHistory === true
  });
  if (!check.ok) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* 保留现场以便人工排查；失败原因已随异常抛出 */
    }
    removeSidecars(tmpPath);
    throw new Error('备份校验失败：' + check.reason);
  }

  removeSidecars(tmpPath);
  fs.renameSync(tmpPath, finalPath);
  try {
    fs.chmodSync(finalPath, 0o600);
  } catch (_) {
    /* 权限设置失败不阻断备份 */
  }

  const pruned = pruneBackups(paths.backupDir, opts.keep);
  return { file: finalPath, name: path.basename(finalPath), schemaVersion: check.schemaVersion, pruned: pruned };
}

// 至少每日一份：当天还没有备份就补一份
async function ensureDailyBackup(db, paths, options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const today = dayStamp(now);
  const hasToday = listBackups(paths.backupDir).some((b) => b.day === today);
  if (hasToday) return { created: false, reason: 'today-exists' };
  const result = await createBackup(db, paths, { now: now, reason: 'daily', keep: opts.keep });
  return { created: true, backup: result };
}

function readLastBackupAt(db) {
  const row = dbm.get(db, 'SELECT meta_value FROM service_meta WHERE meta_key = ?', [LAST_BACKUP_META]);
  return row && row.meta_value ? row.meta_value : null;
}

function writeLastBackupAt(db, iso) {
  dbm.run(
    db,
    `INSERT INTO service_meta (meta_key, meta_value) VALUES (?, ?)
     ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value`,
    [LAST_BACKUP_META, iso]
  );
}

// 写事务之后的节流备份：默认 60 秒内不重复创建，保证至少每日一份由 ensureDailyBackup 兜底
async function createBackupAfterWrite(db, paths, options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const minIntervalMs = Number.isFinite(opts.minIntervalMs) ? opts.minIntervalMs : 60000;
  const last = readLastBackupAt(db);
  if (last) {
    const delta = now.getTime() - new Date(last).getTime();
    if (Number.isFinite(delta) && delta >= 0 && delta < minIntervalMs) {
      return { created: false, reason: 'throttled' };
    }
  }
  const result = await createBackup(db, paths, { now: now, reason: 'write', keep: opts.keep });
  writeLastBackupAt(db, now.toISOString());
  return { created: true, backup: result };
}

function siblingFiles(dbFile) {
  return [dbFile, dbFile + '-wal', dbFile + '-shm'];
}

// 恢复：先备份当前库 → 校验候选 → 改名保留原库 → 切换 → 校验新库 → 失败则放回原库
async function restoreBackup(db, paths, backupPath, options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date();

  const candidate = validateBackupFile(backupPath);
  if (!candidate.ok) {
    return { ok: false, reason: candidate.reason, db: db };
  }

  // 1) 恢复前先备份当前数据库
  let preRestore = null;
  try {
    // 活库可能恰因决策快照被篡改而需要恢复。恢复前仍须保留旧库取证快照，
    // 但该快照不能因此获得「可恢复候选」资格；正常校验始终拒绝它。
    preRestore = await createBackup(db, paths, {
      now: now, reason: 'pre-restore', keep: opts.keep, preserveInvalidDecisionHistory: true
    });
  } catch (err) {
    return {
      ok: false,
      reason: '恢复前备份失败，已中止恢复：' + (err && err.message ? err.message : String(err)),
      db: db
    };
  }

  // 2) 把候选库落到临时文件并再次校验
  const tmpFile = paths.dbFile + '.restore-tmp';
  try {
    fs.copyFileSync(backupPath, tmpFile);
  } catch (err) {
    return { ok: false, reason: '无法写入临时文件：' + (err && err.message ? err.message : String(err)), db: db, preRestoreBackup: preRestore };
  }
  const tmpCheck = validateBackupFile(tmpFile);
  if (!tmpCheck.ok) {
    try {
      fs.unlinkSync(tmpFile);
    } catch (_) {
      /* 临时文件清理失败不影响当前库 */
    }
    removeSidecars(tmpFile);
    return { ok: false, reason: '临时库校验失败：' + tmpCheck.reason, db: db, preRestoreBackup: preRestore };
  }
  removeSidecars(tmpFile);

  // 3) 切换：原库整套（含 wal/shm）改名为 .replaced 保留，验证通过后再删
  dbm.closeQuietly(db);
  const replaced = [];
  let next = null;
  try {
    siblingFiles(paths.dbFile).forEach((f) => {
      if (fs.existsSync(f)) {
        const target = f + '.replaced';
        fs.renameSync(f, target);
        replaced.push({ from: f, to: target });
      }
    });
    fs.renameSync(tmpFile, paths.dbFile);
    next = dbm.openDatabase(paths.dbFile);
    const migrated = migrate(next, { log: opts.log });
    const integrity = dbm.integrityCheck(next);
    if (String(integrity).toLowerCase() !== 'ok') {
      throw new Error('切换后完整性检查未通过：' + integrity);
    }
    replaced.forEach((r) => {
      try {
        fs.unlinkSync(r.to);
      } catch (_) {
        /* 残留的 .replaced 文件不影响运行，可人工清理 */
      }
    });
    return {
      ok: true,
      db: next,
      restoredFrom: path.basename(backupPath),
      schemaVersion: candidate.schemaVersion,
      migratedTo: migrated.version,
      preRestoreBackup: preRestore ? preRestore.name : null
    };
  } catch (err) {
    dbm.closeQuietly(next);
    // 回滚：移除半成品，把原库放回原位
    siblingFiles(paths.dbFile).forEach((f) => {
      try {
        fs.unlinkSync(f);
      } catch (_) {
        /* 不存在则忽略 */
      }
    });
    replaced
      .slice()
      .reverse()
      .forEach((r) => {
        try {
          fs.renameSync(r.to, r.from);
        } catch (_) {
          /* 放回失败时保留 .replaced 现场，交由人工恢复 */
        }
      });
    return {
      ok: false,
      reason: '切换失败，已恢复原数据库：' + (err && err.message ? err.message : String(err)),
      db: dbm.openDatabase(paths.dbFile),
      preRestoreBackup: preRestore ? preRestore.name : null
    };
  }
}

module.exports = {
  REQUIRED_TABLES,
  REQUIRED_TABLES_V1,
  REQUIRED_INDEXES_BY_VERSION,
  requiredIndexesFor,
  requiredTablesFor,
  requiredColumnsFor,
  LAST_BACKUP_META,
  backupFileName,
  listBackups,
  validateBackupFile,
  removeSidecars,
  pruneBackups,
  createBackup,
  createBackupAfterWrite,
  readLastBackupAt,
  snapshotTo,
  ensureDailyBackup,
  restoreBackup,
  stamp,
  dayStamp
};
