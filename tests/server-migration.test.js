/* Phase 2 迁移器行为测试（临时数据库，虚构数据）
 * 覆盖：初始建表、幂等重跑、必需表齐备、迁移失败整体回滚。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { openDatabase, all, get, tableExists } = require('../server/db');
const M = require('../server/migrations');
const { REQUIRED_TABLES } = require('../server/backup');
const { setup } = require('./server-helpers');

test('迁移 v1：schema_migrations 记录版本并建齐必需表', () => {
  const ctx = setup('ledger-mig-');
  try {
    const version = M.currentVersion(ctx.db);
    assert.strictEqual(version, M.LATEST_VERSION);
    const rows = all(ctx.db, 'SELECT version, name FROM schema_migrations ORDER BY version');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].version, 1);
    assert.strictEqual(rows[0].name, 'phase2-initial-schema');

    const missing = REQUIRED_TABLES.filter((t) => !tableExists(ctx.db, t));
    assert.deepStrictEqual(missing, [], '缺少表：' + missing.join(', '));
  } finally {
    ctx.close();
  }
});

test('迁移是幂等的：重复执行不再应用任何版本', () => {
  const ctx = setup('ledger-mig-');
  try {
    const again = M.migrate(ctx.db);
    assert.deepStrictEqual(again.applied, []);
    assert.strictEqual(again.from, M.LATEST_VERSION);
    assert.strictEqual(again.version, M.LATEST_VERSION);
    assert.strictEqual(M.pending(ctx.db).length, 0);
  } finally {
    ctx.close();
  }
});

test('全新库与已迁移库的 schema 结构一致（向前迁移确定性）', () => {
  const a = setup('ledger-mig-');
  const b = setup('ledger-mig-');
  try {
    const schema = (db) =>
      all(db, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").map(
        (r) => r.type + ':' + r.name + ':' + String(r.sql || '').replace(/\s+/g, ' ').trim()
      );
    assert.deepStrictEqual(schema(a.db), schema(b.db));
  } finally {
    a.close();
    b.close();
  }
});

test('迁移失败时整体回滚：不留下半个 schema，也不写入版本记录', () => {
  const ctx = setup('ledger-mig-');
  try {
    const brokenList = [
      { version: 1, name: 'phase2-initial-schema', up: M.MIGRATIONS[0].up },
      {
        version: 2,
        name: 'broken-migration',
        up(db) {
          db.exec('CREATE TABLE probe_ok (id TEXT PRIMARY KEY)');
          db.exec('CREATE TABLE this_is_not_valid_sql (');
        }
      }
    ];
    assert.throws(
      () => M.migrate(ctx.db, { list: brokenList }),
      /incomplete input|syntax error|near/i,
      '坏迁移必须抛出'
    );
    // 回滚后：版本仍是 1，且坏迁移创建的表不存在
    assert.strictEqual(M.currentVersion(ctx.db), 1);
    assert.strictEqual(tableExists(ctx.db, 'probe_ok'), false);
  } finally {
    ctx.close();
  }
});

test('迁移后可写入并读回一条记录（最小可用性）', () => {
  const ctx = setup('ledger-mig-');
  try {
    ctx.db.exec(
      "INSERT INTO institutions (id, name, kind, created_at) VALUES ('i1','测试机构','bank','2026-09-14')"
    );
    const row = get(ctx.db, 'SELECT name FROM institutions WHERE id = ?', ['i1']);
    assert.strictEqual(row.name, '测试机构');
  } finally {
    ctx.close();
  }
});

test('外键约束生效：account_units 不能指向不存在的账户', () => {
  const ctx = setup('ledger-mig-');
  try {
    assert.throws(
      () =>
        ctx.db.exec(
          "INSERT INTO account_units (id, account_id, currency, balance_minor) VALUES ('u1','missing','CNY',1)"
        ),
      /FOREIGN KEY/i
    );
  } finally {
    ctx.close();
  }
});

test('数量为定点十进制 TEXT 存储，不经过浮点（A-006）', () => {
  const ctx = setup('ledger-mig-');
  try {
    ctx.db.exec(
      "INSERT INTO asset_accounts (id, name, kind, pool) VALUES ('a1','券商','broker','investable')"
    );
    ctx.db.exec(
      "INSERT INTO instruments (id, symbol, currency, classification_status) VALUES ('i1','VOO','USD','confirmed')"
    );
    // 浮点无法精确表示的 0.1 + 0.2 场景：以字符串原样保存
    ctx.db.exec(
      "INSERT INTO portfolio_openings (id, account_id, instrument_id, quantity) VALUES ('h1','a1','i1','10.30000000')"
    );
    const row = get(ctx.db, 'SELECT quantity FROM portfolio_openings WHERE id = ?', ['h1']);
    assert.strictEqual(row.quantity, '10.30000000');
    assert.strictEqual(typeof row.quantity, 'string');
  } finally {
    ctx.close();
  }
});

test('balance_minor 允许 NULL 表示"无明确余额"，与 0 区分', () => {
  const ctx = setup('ledger-mig-');
  try {
    ctx.db.exec(
      "INSERT INTO asset_accounts (id, name, kind, pool) VALUES ('a1','公积金','government','restricted')"
    );
    ctx.db.exec("INSERT INTO account_units (id, account_id, currency, balance_minor) VALUES ('u-null','a1','CNY',NULL)");
    ctx.db.exec("INSERT INTO account_units (id, account_id, currency, balance_minor) VALUES ('u-zero','a1','CNY',0)");
    assert.strictEqual(get(ctx.db, 'SELECT balance_minor FROM account_units WHERE id = ?', ['u-null']).balance_minor, null);
    assert.strictEqual(get(ctx.db, 'SELECT balance_minor FROM account_units WHERE id = ?', ['u-zero']).balance_minor, 0);
  } finally {
    ctx.close();
  }
});

test('币种与资金池约束拒绝越界取值', () => {
  const ctx = setup('ledger-mig-');
  try {
    assert.throws(
      () => ctx.db.exec("INSERT INTO asset_accounts (id, name, kind, pool) VALUES ('bad','x','bank','unknown_pool')"),
      /CHECK/i
    );
    ctx.db.exec("INSERT INTO asset_accounts (id, name, kind, pool) VALUES ('a1','x','bank','safety')");
    assert.throws(
      () => ctx.db.exec("INSERT INTO account_units (id, account_id, currency) VALUES ('u1','a1','JPY')"),
      /CHECK/i
    );
  } finally {
    ctx.close();
  }
});

test('标的分类状态只允许 suggested/confirmed，外部变化不覆盖 confirmed 的取值域', () => {
  const ctx = setup('ledger-mig-');
  try {
    assert.throws(
      () =>
        ctx.db.exec(
          "INSERT INTO instruments (id, symbol, currency, classification_status) VALUES ('i1','VOO','USD','maybe')"
        ),
      /CHECK/i
    );
    ctx.db.exec("INSERT INTO instruments (id, symbol, currency, classification_status) VALUES ('i1','VOO','USD','confirmed')");
    assert.strictEqual(
      get(ctx.db, 'SELECT classification_status FROM instruments WHERE id = ?', ['i1']).classification_status,
      'confirmed'
    );
  } finally {
    ctx.close();
  }
});

test('删除账户级联清理其币种子账户与持仓快照', () => {
  const ctx = setup('ledger-mig-');
  try {
    ctx.db.exec("INSERT INTO asset_accounts (id, name, kind, pool) VALUES ('a1','券商','broker','investable')");
    ctx.db.exec("INSERT INTO instruments (id, symbol, currency) VALUES ('i1','VOO','USD')");
    ctx.db.exec("INSERT INTO account_units (id, account_id, currency) VALUES ('u1','a1','USD')");
    ctx.db.exec("INSERT INTO portfolio_openings (id, account_id, instrument_id, quantity) VALUES ('h1','a1','i1','1')");
    ctx.db.exec("DELETE FROM asset_accounts WHERE id = 'a1'");
    assert.strictEqual(get(ctx.db, 'SELECT COUNT(*) AS c FROM account_units').c, 0);
    assert.strictEqual(get(ctx.db, 'SELECT COUNT(*) AS c FROM portfolio_openings').c, 0);
    // 标的本身不因账户删除而消失
    assert.strictEqual(get(ctx.db, 'SELECT COUNT(*) AS c FROM instruments').c, 1);
  } finally {
    ctx.close();
  }
});

test('报价与汇率用表达式唯一索引去重，provider 缺省也参与去重', () => {
  const ctx = setup('ledger-mig-');
  try {
    ctx.db.exec("INSERT INTO instruments (id, symbol, currency) VALUES ('i1','VOO','USD')");
    const ins = "INSERT INTO quotes (instrument_id, price_minor, currency, price_date, provider) VALUES ('i1',5000,'USD','2026-09-06',";
    ctx.db.exec(ins + "NULL)");
    assert.throws(() => ctx.db.exec(ins + 'NULL)'), /UNIQUE/i, 'provider 为 NULL 的重复报价必须被拒绝');
    ctx.db.exec(ins + "'fixture')");
    assert.strictEqual(get(ctx.db, 'SELECT COUNT(*) AS c FROM quotes').c, 2);
  } finally {
    ctx.close();
  }
});

test('内存库与文件库行为一致（迁移测试不依赖磁盘副作用）', () => {
  const db = openDatabase(':memory:');
  try {
    M.migrate(db);
    assert.strictEqual(M.currentVersion(db), M.LATEST_VERSION);
  } finally {
    db.close();
  }
});
