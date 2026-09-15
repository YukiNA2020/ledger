/* Phase 2 备份行为测试（临时数据库，虚构数据）
 * 覆盖：创建与校验、权限、内容完整性、保留策略、每日至少一份、写后节流、异常清理。
 *
 * 恢复场景见 server-restore.test.js —— 拆分是为了让每个文件各自聚焦一类断言，
 * 失败时定位更快（快照改用 VACUUM INTO 后已不存在耗时累积问题）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const B = require('../server/backup');
const R = require('../server/repository');
const dbm = require('../server/db');
const config = require('../server/config');
const { setup, loadFixtureState, loadFixtureBackup, listSidecars } = require('./server-helpers');

test('createBackup 生成通过校验的文件，且不留下临时/同伴文件', async () => {
  const ctx = setup('ledger-bak-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'manual' });

    assert.ok(fs.existsSync(result.file));
    assert.match(result.name, /^ledger-\d{8}-\d{6}-manual\.db$/);
    const check = B.validateBackupFile(result.file);
    assert.strictEqual(check.ok, true, check.reason);
    assert.strictEqual(check.schemaVersion, 1);

    const leftovers = fs.readdirSync(ctx.paths.backupDir).filter((n) => !n.endsWith('.db'));
    assert.deepStrictEqual(leftovers, [], '不应留下 .tmp / -wal / -shm 等文件');
  } finally {
    ctx.close();
  }
});

test('同一秒内的同名备份不互相覆盖：追加 -N 后缀保证可找回（S3 完整性）', async () => {
  const ctx = setup('ledger-bak-collide-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    // 固定同一时刻 + 同一 reason，模拟同秒内连续两次高风险覆盖（如连续两次恢复）
    const now = new Date('2026-09-14T08:00:00.000Z');
    const first = await B.createBackup(ctx.db, ctx.paths, { reason: 'pre-import', now: now });
    const second = await B.createBackup(ctx.db, ctx.paths, { reason: 'pre-import', now: now });

    assert.notStrictEqual(first.name, second.name, '同秒同名备份必须得到不同文件名');
    assert.ok(fs.existsSync(first.file), '第一份备份必须保留');
    assert.ok(fs.existsSync(second.file), '第二份备份必须存在');
    assert.match(second.name, /-pre-import-1\.db$/, '冲突时以 -1 后缀命名，且仍以 .db 结尾');

    const listed = B.listBackups(ctx.paths.backupDir).map((i) => i.name);
    assert.ok(listed.indexOf(first.name) >= 0 && listed.indexOf(second.name) >= 0, '两份都应出现在备份列表');
  } finally {
    ctx.close();
  }
});

test('备份文件权限为 0600（私人财务数据不对外开放）', async () => {
  const ctx = setup('ledger-bak-');
  try {
    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'perm' });
    assert.strictEqual(fs.statSync(result.file).mode & 0o777, 0o600);
  } finally {
    ctx.close();
  }
});

test('备份内容可独立打开并包含全部事实（不是空壳文件）', async () => {
  const ctx = setup('ledger-bak-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'content' });

    const isolated = new DatabaseSync(result.file, { readOnly: true });
    try {
      assert.strictEqual(dbm.integrityCheck(isolated), 'ok');
      assert.strictEqual(dbm.get(isolated, 'SELECT COUNT(*) AS c FROM asset_accounts').c, 4);
      assert.strictEqual(dbm.get(isolated, 'SELECT COUNT(*) AS c FROM account_units').c, 3);
      assert.strictEqual(
        dbm.get(isolated, 'SELECT balance_minor AS b FROM account_units WHERE id = ?', ['u-hsbc']).b,
        100000
      );
    } finally {
      isolated.close();
      B.removeSidecars(result.file);
    }
  } finally {
    ctx.close();
  }
});

test('校验是只读的：反复校验不会在备份文件旁留下同伴文件', async () => {
  const ctx = setup('ledger-bak-');
  try {
    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'pure' });
    const before = fs.readdirSync(ctx.paths.backupDir).sort();
    B.validateBackupFile(result.file);
    B.validateBackupFile(result.file);
    assert.deepStrictEqual(fs.readdirSync(ctx.paths.backupDir).sort(), before);
    assert.deepStrictEqual(listSidecars(ctx.paths.backupDir, result.name), []);
  } finally {
    ctx.close();
  }
});

test('保留策略：默认保留最近 30 份，可自定义上限', () => {
  const ctx = setup('ledger-bak-');
  try {
    assert.strictEqual(config.BACKUP_KEEP, 30, 'A-003：默认保留最近 30 份');

    for (let i = 0; i < 32; i++) {
      fs.writeFileSync(
        path.join(ctx.paths.backupDir, 'ledger-20260914-' + String(100000 + i) + '-placeholder.db'),
        'x'
      );
    }
    const dropped = B.pruneBackups(ctx.paths.backupDir);
    assert.strictEqual(dropped.length, 2);
    const kept = B.listBackups(ctx.paths.backupDir).map((i) => i.name);
    assert.strictEqual(kept.length, 30);
    assert.strictEqual(kept[0], 'ledger-20260914-100031-placeholder.db');
    assert.strictEqual(kept[kept.length - 1], 'ledger-20260914-100002-placeholder.db');

    const dropped2 = B.pruneBackups(ctx.paths.backupDir, 3);
    assert.strictEqual(dropped2.length, 27);
    assert.deepStrictEqual(B.listBackups(ctx.paths.backupDir).map((i) => i.name), [
      'ledger-20260914-100031-placeholder.db',
      'ledger-20260914-100030-placeholder.db',
      'ledger-20260914-100029-placeholder.db'
    ]);
  } finally {
    ctx.close();
  }
});

test('真实备份同样受保留策略约束（createBackup 内部触发裁剪）', async () => {
  const ctx = setup('ledger-bak-');
  try {
    const first = await B.createBackup(ctx.db, ctx.paths, { reason: 'one', keep: 1 });
    const second = await B.createBackup(ctx.db, ctx.paths, { reason: 'two', keep: 1 });
    assert.deepStrictEqual(second.pruned, [first.name], '第二次创建必须裁掉第一份');
    const kept = B.listBackups(ctx.paths.backupDir);
    assert.strictEqual(kept.length, 1);
    assert.match(kept[0].name, /-two\.db$/);
  } finally {
    ctx.close();
  }
});

test('至少每日一份：当天没有备份时创建一份', async () => {
  const ctx = setup('ledger-bak-');
  try {
    const result = await B.ensureDailyBackup(ctx.db, ctx.paths, { now: new Date() });
    assert.strictEqual(result.created, true);
    assert.match(result.backup.name, /-daily\.db$/);
    assert.strictEqual(B.listBackups(ctx.paths.backupDir).length, 1);
  } finally {
    ctx.close();
  }
});

test('至少每日一份：当天已有备份时跳过，换一天再创建', async () => {
  const ctx = setup('ledger-bak-');
  try {
    // 放置"今天"的占位备份，覆盖同日跳过分支而不额外触发真实备份
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate());
    fs.writeFileSync(path.join(ctx.paths.backupDir, 'ledger-' + day + '-090000-existing.db'), 'placeholder');

    const sameDay = await B.ensureDailyBackup(ctx.db, ctx.paths, { now: now });
    assert.strictEqual(sameDay.created, false);
    assert.strictEqual(sameDay.reason, 'today-exists');
    assert.strictEqual(B.listBackups(ctx.paths.backupDir).length, 1);

    const nextDay = await B.ensureDailyBackup(ctx.db, ctx.paths, {
      now: new Date(now.getTime() + 24 * 3600 * 1000)
    });
    assert.strictEqual(nextDay.created, true);
    assert.strictEqual(B.listBackups(ctx.paths.backupDir).length, 2);
  } finally {
    ctx.close();
  }
});

test('写后备份：首次创建并记录时间，间隔内节流跳过', async () => {
  const ctx = setup('ledger-bak-');
  try {
    const t0 = new Date();
    const first = await B.createBackupAfterWrite(ctx.db, ctx.paths, { now: t0, minIntervalMs: 60000 });
    assert.strictEqual(first.created, true);
    assert.ok(B.readLastBackupAt(ctx.db), '必须记录最近备份时间');

    const throttled = await B.createBackupAfterWrite(ctx.db, ctx.paths, {
      now: new Date(t0.getTime() + 5000),
      minIntervalMs: 60000
    });
    assert.strictEqual(throttled.created, false);
    assert.strictEqual(throttled.reason, 'throttled');
    assert.strictEqual(B.listBackups(ctx.paths.backupDir).length, 1);

    const later = await B.createBackupAfterWrite(ctx.db, ctx.paths, {
      now: new Date(t0.getTime() + 61000),
      minIntervalMs: 60000
    });
    assert.strictEqual(later.created, true);
    assert.strictEqual(B.listBackups(ctx.paths.backupDir).length, 2);
  } finally {
    ctx.close();
  }
});

test('校验会拒绝：不存在文件、非数据库文件、缺表数据库、版本过新', () => {
  const ctx = setup('ledger-bak-');
  try {
    assert.strictEqual(B.validateBackupFile(path.join(ctx.paths.backupDir, 'nope.db')).ok, false);

    const junk = path.join(ctx.paths.backupDir, 'junk.db');
    fs.writeFileSync(junk, 'this is not a sqlite database at all');
    assert.strictEqual(B.validateBackupFile(junk).ok, false);

    const partial = path.join(ctx.paths.backupDir, 'partial.db');
    const pdb = new DatabaseSync(partial);
    pdb.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
    pdb.exec("INSERT INTO schema_migrations VALUES (1,'x','now')");
    pdb.close();
    const partialResult = B.validateBackupFile(partial);
    assert.strictEqual(partialResult.ok, false);
    assert.match(partialResult.reason, /缺少必需表/);
    B.removeSidecars(partial);

    const future = path.join(ctx.paths.backupDir, 'future.db');
    const fdb = new DatabaseSync(future);
    fdb.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
    B.REQUIRED_TABLES.forEach((t) => {
      if (t !== 'schema_migrations') fdb.exec('CREATE TABLE ' + t + ' (id TEXT)');
    });
    fdb.exec("INSERT INTO schema_migrations VALUES (999,'future','now')");
    fdb.close();
    const futureResult = B.validateBackupFile(future);
    assert.strictEqual(futureResult.ok, false);
    assert.match(futureResult.reason, /更新的版本/);
    B.removeSidecars(future);
  } finally {
    ctx.close();
  }
});

test('失败或中断留下的临时文件被清理，不会污染备份列表', async () => {
  const ctx = setup('ledger-bak-');
  try {
    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'cleanup' });
    fs.writeFileSync(path.join(ctx.paths.backupDir, 'ledger-20260914-000000-broken.db.tmp'), 'x');
    fs.writeFileSync(path.join(ctx.paths.backupDir, 'ledger-20260914-000000-broken.db.tmp-wal'), 'x');

    assert.deepStrictEqual(B.listBackups(ctx.paths.backupDir).map((i) => i.name), [result.name]);
    B.pruneBackups(ctx.paths.backupDir);
    const remaining = fs.readdirSync(ctx.paths.backupDir).filter((n) => n.indexOf('.tmp') !== -1);
    assert.deepStrictEqual(remaining, []);
  } finally {
    ctx.close();
  }
});

test('Phase 1 的 v2 备份 fixture 结构仍然可解析（不破坏既有备份格式）', () => {
  const backup = loadFixtureBackup();
  assert.strictEqual(backup.app, 'ledger');
  assert.strictEqual(backup.schemaVersion, 2);
  assert.strictEqual(backup.assets.schemaVersion, 1);
  assert.strictEqual(backup.assets.assetAccounts.length, 4);
  assert.strictEqual(backup.assets.assetUnits.length, 3);
  assert.strictEqual(backup.assets.liabilities[0].balanceMinor, 200000);
});
