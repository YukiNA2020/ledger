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
  3: ['asset_transfers']
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
  }]
};

// 必需**列**随 schema 版本增长（复核 G4C-6）：有些事实承载在列上，光看表齐不齐看不出来。
// v5 的 amount_minor 承载分红/费用事件总额——缺列的 v5 库恢复后迁移器不会补列
// （版本已应用），读取事件时才炸。校验必须把这类库挡在切换之前。
// v7 的 quotes.source_symbol 承载行情 provider 返回的原始代码（Phase 4D 追溯要求）。
const REQUIRED_COLUMNS_BY_VERSION = {
  5: [{ table: 'security_events', name: 'amount_minor' }],
  7: [{ table: 'quotes', name: 'source_symbol' }]
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
function validateBackupFile(file) {
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
    }
    // 索引之外还有承载事实的必需列（复核 G4C-6）：缺列的库恢复后迁移器不会补列，
    // 读取时会才炸——同样挡在切换之前。
    for (const col of requiredColumnsFor(version)) {
      if (dbm.columnNames(db, col.table).indexOf(col.name) === -1) {
        return { ok: false, reason: '缺少必需列：' + col.table + '.' + col.name };
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

  const check = validateBackupFile(tmpPath);
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
    preRestore = await createBackup(db, paths, { now: now, reason: 'pre-restore', keep: opts.keep });
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
