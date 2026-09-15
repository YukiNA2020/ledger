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
  integrityCheck,
  plain,
  closeQuietly
};
