/* 测试公共设施：临时数据目录、数据库、固定 fixture（Phase 2）
 * 注意：全部使用仓库内的虚构数据，绝不读写用户真实数据目录（不设置 LEDGER_HOME）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../server/config');
const dbm = require('../server/db');
const migrations = require('../server/migrations');

const FIXTURE = path.join(__dirname, 'fixtures', 'phase1-backup-v2.json');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ledger-test-'));
}

// 建立一套独立的数据目录 + 已迁移的数据库
function setup(prefix) {
  const dir = mkTmpDir(prefix);
  const p = config.ensureDirs(config.paths(dir));
  const db = dbm.openDatabase(p.dbFile);
  migrations.migrate(db);
  const ctx = {
    dir: dir,
    paths: p,
    db: db,
    // 恢复操作会关闭旧连接并返回新连接：测试必须接管后再关闭，否则会泄漏句柄导致测试进程不退出
    adopt(result) {
      if (result && result.db) ctx.db = result.db;
      return result;
    },
    close() {
      dbm.closeQuietly(ctx.db);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        // 临时目录清理失败不影响测试结论
      }
    }
  };
  return ctx;
}

// 标准虚构验收数据（ACCEPTANCE §2），对应 phase1-backup-v2.json
function loadFixtureState() {
  const backup = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  return {
    accounts: backup.accounts,
    categories: backup.categories,
    txns: backup.txns,
    settings: backup.settings,
    assets: backup.assets
  };
}

function loadFixtureBackup() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function listSidecars(dir, base) {
  return ['-wal', '-shm', '-journal']
    .map((s) => base + s)
    .filter((f) => fs.existsSync(path.join(dir, f)));
}

// 直接构造一个"某历史版本的备份文件"，用于恢复测试。
// 走 open + migrate + writeState 再 checkpoint，得到一个自包含的、可直接当备份用的库文件。
function makeStandaloneBackup(filePath, state) {
  const R = require('../server/repository');
  const db = dbm.openDatabase(filePath);
  try {
    migrations.migrate(db);
    if (state) R.writeState(db, state);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    dbm.closeQuietly(db);
  }
  [filePath + '-wal', filePath + '-shm'].forEach((f) => {
    try {
      if (fs.existsSync(f) && fs.statSync(f).size === 0) fs.unlinkSync(f);
    } catch (_) {
      // 非空的同伴文件保留原样，交由校验环节判断
    }
  });
  return filePath;
}

module.exports = {
  FIXTURE,
  mkTmpDir,
  setup,
  loadFixtureState,
  loadFixtureBackup,
  listSidecars,
  makeStandaloneBackup
};
