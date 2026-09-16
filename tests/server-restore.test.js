/* Phase 2 备份恢复行为测试（ACCEPTANCE S2.4）
 *
 * 覆盖：恢复前先备份当前库、临时库校验通过后才切换、恢复失败不破坏当前数据库、
 *       切换后不残留临时文件、被替换版本可追溯（审计链）。
 *
 * 独立成文件的原因见 server-backup.test.js 顶部注释。
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
const { setup, loadFixtureState, makeStandaloneBackup } = require('./server-helpers');

// 版本二：删掉公积金与信用卡，形成可观察差异
function versionTwo() {
  const state = loadFixtureState();
  state.assets.assetAccounts = state.assets.assetAccounts.filter((a) => a.id !== 'acc-gjj');
  state.assets.assetUnits = state.assets.assetUnits.filter((u) => u.id !== 'u-gjj');
  state.assets.liabilities = [];
  return state;
}

test('S2.4 恢复旧版本：先备份当前库，切换后数据回到旧版本', async () => {
  const ctx = setup('ledger-rst-');
  try {
    // 旧版本 = 标准虚构数据（ACCEPTANCE §2）
    const oldFile = makeStandaloneBackup(
      path.join(ctx.paths.backupDir, 'ledger-20260901-000000-snapshot.db'),
      loadFixtureState()
    );
    assert.strictEqual(B.validateBackupFile(oldFile).ok, true, '构造的旧版本备份必须通过校验');

    // 当前库 = 版本二
    R.writeState(ctx.db, versionTwo());
    assert.strictEqual(R.readAssetUnits(ctx.db).length, 2);

    const result = ctx.adopt(await B.restoreBackup(ctx.db, ctx.paths, oldFile));
    assert.strictEqual(result.ok, true, result.reason);
    assert.strictEqual(result.restoredFrom, path.basename(oldFile));
    assert.ok(result.preRestoreBackup, '恢复前必须自动备份当前库');

    const prePath = path.join(ctx.paths.backupDir, result.preRestoreBackup);
    assert.ok(fs.existsSync(prePath), '恢复前备份文件必须真实存在');

    // 恢复后的库回到旧版本内容
    const restored = R.readState(result.db);
    assert.strictEqual(restored.assets.assetUnits.length, 3);
    assert.strictEqual(restored.assets.liabilities.length, 1);
    assert.strictEqual(dbm.get(result.db, 'SELECT COUNT(*) AS c FROM asset_accounts').c, 4);
    // 口径仍精确（复用同一份 domain.js）
    const Domain = require('../js/domain.js');
    const overview = Domain.computeOverview(restored.assets, {
      now: '2026-09-06',
      settings: { safetyTargetMinor: 3000000 }
    });
    assert.strictEqual(overview.netWorthMinor, 4380000);

    // 恢复前备份记录的是"被替换掉的版本二"
    const pre = new DatabaseSync(prePath, { readOnly: true });
    try {
      assert.strictEqual(dbm.get(pre, 'SELECT COUNT(*) AS c FROM account_units').c, 2);
    } finally {
      pre.close();
      B.removeSidecars(prePath);
    }
  } finally {
    ctx.close();
  }
});

test('S2.4 恢复失败不破坏当前数据库（候选文件不是数据库）', async () => {
  const ctx = setup('ledger-rst-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const before = R.readState(ctx.db);

    const bogus = path.join(ctx.paths.backupDir, 'bogus.db');
    fs.writeFileSync(bogus, 'not a database');

    const result = await B.restoreBackup(ctx.db, ctx.paths, bogus);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.db, ctx.db, '失败时必须返回原句柄');
    assert.deepStrictEqual(R.readState(ctx.db), before, '当前数据库必须原封不动');
    // 校验前置失败：不应创建恢复前备份
    assert.strictEqual(B.listBackups(ctx.paths.backupDir).length, 0);
  } finally {
    ctx.close();
  }
});

test('恢复失败不破坏当前数据库（候选是合法库但缺必需表）', async () => {
  const ctx = setup('ledger-rst-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const before = R.readState(ctx.db);

    const partial = path.join(ctx.paths.backupDir, 'partial.db');
    const pdb = new DatabaseSync(partial);
    pdb.exec('CREATE TABLE unrelated (id TEXT)');
    pdb.close();

    const result = await B.restoreBackup(ctx.db, ctx.paths, partial);
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /缺少必需表/);
    assert.strictEqual(result.db, ctx.db);
    assert.deepStrictEqual(R.readState(ctx.db), before);
    B.removeSidecars(partial);
  } finally {
    ctx.close();
  }
});

test('恢复不存在的备份：直接失败，当前库与备份目录都不受影响', async () => {
  const ctx = setup('ledger-rst-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const before = R.readState(ctx.db);

    const result = await B.restoreBackup(ctx.db, ctx.paths, path.join(ctx.paths.backupDir, 'missing.db'));
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /不存在/);
    assert.deepStrictEqual(R.readState(ctx.db), before);
    assert.strictEqual(B.listBackups(ctx.paths.backupDir).length, 0);
  } finally {
    ctx.close();
  }
});

test('切换成功后不残留 .restore-tmp / .replaced 文件，新连接可继续写入', async () => {
  const ctx = setup('ledger-rst-');
  try {
    const oldFile = makeStandaloneBackup(
      path.join(ctx.paths.backupDir, 'ledger-20260901-010000-snapshot.db'),
      loadFixtureState()
    );
    R.writeState(ctx.db, versionTwo());

    const result = ctx.adopt(await B.restoreBackup(ctx.db, ctx.paths, oldFile));
    assert.strictEqual(result.ok, true, result.reason);

    const suspicious = fs.readdirSync(ctx.paths.dataDir).filter((n) => /restore-tmp|\.replaced/.test(n));
    assert.deepStrictEqual(suspicious, [], '不应残留切换过程的临时文件');
    assert.strictEqual(fs.existsSync(ctx.paths.dbFile), true);

    // 切换后的连接有效：可以继续写入并读回
    R.writeState(result.db, loadFixtureState());
    assert.strictEqual(R.readAssetUnits(result.db).length, 3);
  } finally {
    ctx.close();
  }
});

test('恢复后旧连接已失效，避免两处连接同时写同一个库', async () => {
  const ctx = setup('ledger-rst-');
  try {
    const oldFile = makeStandaloneBackup(
      path.join(ctx.paths.backupDir, 'ledger-20260901-020000-snapshot.db'),
      loadFixtureState()
    );
    const stale = ctx.db;
    const result = ctx.adopt(await B.restoreBackup(ctx.db, ctx.paths, oldFile));
    assert.strictEqual(result.ok, true, result.reason);
    assert.notStrictEqual(result.db, stale);
    assert.throws(() => dbm.get(stale, 'SELECT COUNT(*) AS c FROM txns'), /not open|closed|database is not open/i);
  } finally {
    ctx.close();
  }
});

test('审计链：被替换掉的版本可从恢复前备份完整读回', async () => {
  const ctx = setup('ledger-rst-');
  try {
    const oldFile = makeStandaloneBackup(
      path.join(ctx.paths.backupDir, 'ledger-20260901-030000-snapshot.db'),
      loadFixtureState()
    );

    const changed = versionTwo();
    changed.assets.assetAccounts[0].name = '被改名的账户';
    R.writeState(ctx.db, changed);
    const changedName = R.readAssetAccounts(ctx.db)[0].name;
    assert.strictEqual(changedName, '被改名的账户');

    const result = ctx.adopt(await B.restoreBackup(ctx.db, ctx.paths, oldFile));
    assert.strictEqual(result.ok, true, result.reason);

    const prePath = path.join(ctx.paths.backupDir, result.preRestoreBackup);
    const pre = new DatabaseSync(prePath, { readOnly: true });
    try {
      assert.strictEqual(
        dbm.get(pre, 'SELECT name FROM asset_accounts WHERE id = ?', ['acc-cmb']).name,
        '被改名的账户',
        '恢复前备份必须记录被替换掉的版本'
      );
      assert.strictEqual(dbm.get(pre, 'SELECT COUNT(*) AS c FROM liabilities').c, 0);
    } finally {
      pre.close();
      B.removeSidecars(prePath);
    }

    // 恢复后的库回到备份时刻
    assert.strictEqual(R.readLiabilities(result.db).length, 1);
    assert.strictEqual(R.readAssetAccounts(result.db)[0].name, '招行储蓄');
  } finally {
    ctx.close();
  }
});

test('恢复前备份本身也是合法备份（可作为下一次恢复的源）', async () => {
  const ctx = setup('ledger-rst-');
  try {
    const oldFile = makeStandaloneBackup(
      path.join(ctx.paths.backupDir, 'ledger-20260901-040000-snapshot.db'),
      loadFixtureState()
    );
    R.writeState(ctx.db, versionTwo());

    const result = ctx.adopt(await B.restoreBackup(ctx.db, ctx.paths, oldFile));
    assert.strictEqual(result.ok, true, result.reason);

    const prePath = path.join(ctx.paths.backupDir, result.preRestoreBackup);
    const check = B.validateBackupFile(prePath);
    assert.strictEqual(check.ok, true, check.reason);
  } finally {
    ctx.close();
  }
});

test('P1-D 候选备份缺 v4 去重索引：拒绝恢复，当前库与备份目录都不受影响', async () => {
  const ctx = setup('ledger-rst-idx-');
  try {
    // 当前库 = 版本二（可观察的既有状态）
    R.writeState(ctx.db, versionTwo());
    const before = R.readState(ctx.db);

    // 造一个"迁移记录写着 v4、但去重唯一索引被删掉"的候选备份
    const candidate = makeStandaloneBackup(
      path.join(ctx.paths.backupDir, 'ledger-20260901-200000-noidx.db'),
      loadFixtureState()
    );
    const raw = new DatabaseSync(candidate);
    raw.exec('DROP INDEX uq_instruments_dedupe');
    raw.close();
    assert.strictEqual(B.validateBackupFile(candidate).ok, false, '前提：该候选备份已不合格');

    const result = ctx.adopt(await B.restoreBackup(ctx.db, ctx.paths, candidate));
    assert.strictEqual(result.ok, false, '缺索引的候选备份必须拒绝恢复');
    assert.ok(
      String(result.reason).indexOf('uq_instruments_dedupe') >= 0,
      '拒绝原因要点名缺失的索引：' + result.reason
    );

    // 当前库原样保留（校验在切换之前失败，连"恢复前备份"都不该产生）
    assert.deepStrictEqual(R.readState(ctx.db), before);
    const names = fs.readdirSync(ctx.paths.backupDir).sort();
    assert.deepStrictEqual(names, ['ledger-20260901-200000-noidx.db'], '被拒的恢复不得产生任何副作用文件');
    const leftovers = fs.readdirSync(ctx.paths.backupDir).filter((n) => /\.restore-tmp$|\.replaced$/.test(n));
    assert.deepStrictEqual(leftovers, [], '不得残留临时/替换文件');
  } finally {
    ctx.close();
  }
});
