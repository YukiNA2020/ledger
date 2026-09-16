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
const M = require('../server/migrations');
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
    assert.strictEqual(check.schemaVersion, M.LATEST_VERSION);

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

/* ------------------ Phase 3 补口（P1-C）：按 schema 版本条件校验必需表 ------------------ */

test('P1-C 结构校验按候选库版本条件化：v3 缺 asset_transfers 必须拒绝', async () => {
  const ctx = setup('ledger-bak-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'manual' });
    assert.strictEqual(B.validateBackupFile(result.file).ok, true);

    // 人为制造「迁移记录写着 v3，但表被删掉」的损坏库。
    // createBackup 自身会先校验，无法用它产出损坏文件 —— 复制一份合格备份再破坏结构。
    assert.ok(M.LATEST_VERSION >= 3, '本用例前提：最新 schema 版本 ≥ 3');
    const brokenFile = path.join(ctx.paths.backupDir, 'ledger-20260901-120000-broken.db');
    fs.copyFileSync(result.file, brokenFile);
    const raw = new DatabaseSync(brokenFile);
    raw.exec('DROP TABLE asset_transfers');
    raw.close();

    const check = B.validateBackupFile(brokenFile);
    assert.strictEqual(check.ok, false, '声称 v3 却缺 asset_transfers 的库不得通过校验');
    assert.ok(String(check.reason).indexOf('asset_transfers') >= 0, '拒绝原因应点名缺失的表：' + check.reason);
  } finally {
    ctx.close();
  }
});

test('P1-C 合法的 v2 备份（无 asset_transfers）仍可通过校验与恢复', async () => {
  const ctx = setup('ledger-bak-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'manual' });

    // 降级为 v2 形态：删掉 v3 才引入的表，并抹掉 v3 迁移记录（同样要绕开 createBackup 的自校验）
    const v2File = path.join(ctx.paths.backupDir, 'ledger-20260901-130000-v2.db');
    fs.copyFileSync(result.file, v2File);
    const raw = new DatabaseSync(v2File);
    raw.exec('DROP TABLE asset_transfers');
    raw.exec('DELETE FROM schema_migrations WHERE version >= 3');
    raw.close();

    const check = B.validateBackupFile(v2File);
    assert.strictEqual(check.ok, true, 'v2 备份不应被要求携带 v3 的表：' + check.reason);
    assert.strictEqual(check.schemaVersion, 2);
  } finally {
    ctx.close();
  }
});

test('P1-C 含换汇记录的备份可完整往返（创建 → 校验 → 恢复）', async () => {
  const ctx = setup('ledger-bak-');
  try {
    const state = loadFixtureState();
    state.assets.assetTransfers = [];
    R.writeState(ctx.db, state);

    const acc = R.readAssetAccounts(ctx.db)[0];
    const units = R.readAssetUnits(ctx.db);
    assert.ok(acc && units.length >= 2, '前提：标准虚构数据含账户与余额单元');

    // 在已落库的两个单元之间建立换汇事实（币种由单元推导）
    const a = units[0];
    const b = units.find((u) => u.currency !== a.currency) || units[1];
    R.upsertAssetTransfer(ctx.db, {
      id: 'xfer-bak-1',
      fromUnitId: a.id,
      toUnitId: b.id,
      fromAmountMinor: 10000,
      toAmountMinor: 9000,
      occurredOn: '2026-08-20',
      sourceType: 'manual'
    }, { now: '2026-08-20T00:00:00Z' });

    const before = R.readAssetTransfers(ctx.db);
    assert.strictEqual(before.length, 1);

    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'manual' });
    const check = B.validateBackupFile(result.file);
    assert.strictEqual(check.ok, true, check.reason);
    assert.strictEqual(check.schemaVersion, M.LATEST_VERSION);

    const restored = ctx.adopt(await B.restoreBackup(ctx.db, ctx.paths, result.file));
    assert.strictEqual(restored.ok, true, restored.reason);
    const after = R.readAssetTransfers(ctx.db);
    assert.strictEqual(after.length, 1, '换汇记录必须随备份往返');
    assert.strictEqual(after[0].fromCurrency, a.currency);
    assert.strictEqual(after[0].toCurrency, b.currency);
  } finally {
    ctx.close();
  }
});

/* ---------- 第二轮复核反例（G4B-6）：必需索引也属于结构校验 ---------- */

test('P1-D v4 库被删掉 uq_instruments_dedupe 后校验必须拒绝', async () => {
  const ctx = setup('ledger-bak-idx-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'manual' });
    assert.strictEqual(B.validateBackupFile(result.file).ok, true);

    // 复核复现：DROP INDEX 后 schema_migrations 仍写着 v4，迁移器不会重建索引，
    // 因此校验必须自己把关（不能只数表）。
    assert.ok(M.LATEST_VERSION >= 4, '本用例前提：最新 schema 版本 ≥ 4');
    const brokenFile = path.join(ctx.paths.backupDir, 'ledger-20260901-140000-noidx.db');
    fs.copyFileSync(result.file, brokenFile);
    const raw = new DatabaseSync(brokenFile);
    raw.exec('DROP INDEX uq_instruments_dedupe');
    raw.close();

    const check = B.validateBackupFile(brokenFile);
    assert.strictEqual(check.ok, false, '声称 v4 却丢掉去重唯一索引的库不得通过校验');
    assert.ok(
      String(check.reason).indexOf('uq_instruments_dedupe') >= 0,
      '拒绝原因要点名缺失的索引：' + check.reason
    );
  } finally {
    ctx.close();
  }
});

test('P1-D 同名索引被换成非唯一索引同样拒绝（唯一性也是不变量）', async () => {
  const ctx = setup('ledger-bak-idx2-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const result = await B.createBackup(ctx.db, ctx.paths, { reason: 'manual' });

    const swapped = path.join(ctx.paths.backupDir, 'ledger-20260901-150000-notuniq.db');
    fs.copyFileSync(result.file, swapped);
    const raw = new DatabaseSync(swapped);
    raw.exec('DROP INDEX uq_instruments_dedupe');
    // 名字一样、但不唯一：此时去重不变量已经名存实亡，不能再放行
    raw.exec('CREATE INDEX uq_instruments_dedupe ON instruments(symbol)');
    const info = dbm.indexInfo(raw, 'instruments', 'uq_instruments_dedupe');
    assert.strictEqual(info.unique, false, '前提：这个索引确实是非唯一索引');
    raw.close();

    const check = B.validateBackupFile(swapped);
    assert.strictEqual(check.ok, false, '非唯一索引不得冒充去重不变量');
    assert.ok(String(check.reason).indexOf('不是唯一索引') >= 0, check.reason);

    // 对照：正常备份仍然通过，且 dbm.indexInfo 能读出唯一属性
    const okInfo = dbm.indexInfo(ctx.db, 'instruments', 'uq_instruments_dedupe');
    assert.strictEqual(okInfo.unique, true);
    assert.strictEqual(okInfo.table, 'instruments');
  } finally {
    ctx.close();
  }
});

test('P1-D 活库丢失去重索引时拒绝产出"看似合格"的备份，且不留残留文件', async () => {
  const ctx = setup('ledger-bak-idx3-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    ctx.db.exec('DROP INDEX uq_instruments_dedupe');

    await assert.rejects(
      () => B.createBackup(ctx.db, ctx.paths, { reason: 'manual' }),
      /备份校验失败/,
      '不变量缺失的库不得产出备份'
    );
    const leftovers = fs.readdirSync(ctx.paths.backupDir).filter((n) => n.endsWith('.db'));
    assert.deepStrictEqual(leftovers, [], '校验失败时不得留下可疑备份：' + leftovers.join(', '));
  } finally {
    ctx.close();
  }
});
