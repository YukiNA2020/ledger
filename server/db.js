/* 小账本 server/db.js — SQLite 连接与事务助手（Phase 2）
 * 使用 Node 内建 node:sqlite（零外部依赖，见 DECISIONS T-001）。
 *
 * 财务正确性约束（ARCHITECTURE §5.5）：
 *   - 开启 foreign_keys，让"一条持仓必须指向一个标的和一个证券账户"等不变量由数据库兜住；
 *   - WAL + synchronous=FULL：事实源以持久性优先于吞吐；
 *   - 所有多表写入必须走 transaction()，保证"要么全成、要么全不成"。
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

// BEGIN IMMEDIATE：立刻取写锁，避免两个写入者读到同一旧版本后再互相覆盖
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let out;
  try {
    out = fn();
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // 回滚失败不掩盖原始异常
    }
    throw err;
  }
  db.exec('COMMIT');
  return out;
}

function all(db, sql, params) {
  return db.prepare(sql).all(...(params || []));
}

function get(db, sql, params) {
  return db.prepare(sql).get(...(params || []));
}

function run(db, sql, params) {
  return db.prepare(sql).run(...(params || []));
}

function tableExists(db, name) {
  const row = get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
  return !!row;
}

// 索引信息：是否存在、属于哪张表、是否为唯一索引。
// 备份校验不能只看"表齐不齐" —— 有些不变量是索引承载的（如 uq_instruments_dedupe）。
// PRAGMA 不支持参数绑定，表名一律做标识符白名单过滤后再拼（本项目表名均为内置常量）。
function indexInfo(db, table, name) {
  if (!table || !name) return null;
  const t = String(table).replace(/[^A-Za-z0-9_]/g, '');
  const row = get(db, "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?", [name]);
  if (!row) return null;
  if (t && String(row.tbl_name) !== t) return null;
  let unique = false;
  try {
    const list = all(db, 'PRAGMA index_list(' + t + ')');
    const hit = list.filter((i) => i.name === name)[0];
    unique = !!(hit && Number(hit.unique));
  } catch (_) {
    // 读不到索引属性时按"不唯一"处理：校验方宁可拒绝，也不放过不变量缺失的库
    unique = false;
  }
  return { name: String(row.name), table: String(row.tbl_name), unique: unique };
}

// 表的列名集合：备份校验按版本核对必需列（如 v5 的 security_events.amount_minor）——
// 有些事实承载在列上，光看表齐不齐看不出来（迁移器只在"版本未应用"时执行，
// 已应用版本的库被手工删列不会自愈）。PRAGMA 不支持参数绑定，表名做标识符过滤后拼接。
function columnNames(db, table) {
  const t = String(table || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!t) return [];
  try {
    return all(db, 'PRAGMA table_info(' + t + ')').map((c) => String(c.name));
  } catch (_) {
    return []; // 读不到列信息时返回空：校验方宁可拒绝，也不放过事实列缺失的库
  }
}

function integrityCheck(db) {
  const row = get(db, 'PRAGMA integrity_check', []);
  return row ? Object.values(row)[0] : 'unknown';
}

// node:sqlite 返回 null-prototype 对象，转成普通对象便于展开与 JSON 序列化
function plain(row) {
  return row == null ? null : Object.assign({}, row);
}

function closeQuietly(db) {
  if (!db) return;
  try {
    db.close();
  } catch (_) {
    // 已关闭或连接失效时忽略
  }
}

module.exports = {
  openDatabase,
  transaction,
  all,
  get,
  run,
  tableExists,
  indexInfo,
  columnNames,
  integrityCheck,
  plain,
  closeQuietly
};
