/* Phase 2 repository 行为测试（临时数据库，虚构数据）
 * 覆盖：标准虚构数据往返无损、幂等全量替换、未知字段不丢、
 *       机构归一、加密交易只落密文、事务回滚、重复写入幂等、指纹分表。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const R = require('../server/repository');
const dbm = require('../server/db');
const Domain = require('../js/domain.js');
const { setup, loadFixtureState } = require('./server-helpers');

const ASSET_STRIP = (assets) => ({
  assetAccounts: assets.assetAccounts,
  assetUnits: assets.assetUnits,
  liabilities: assets.liabilities,
  entitlements: assets.entitlements,
  instruments: assets.instruments,
  holdings: assets.holdings,
  quotes: assets.quotes,
  fxRates: assets.fxRates
});

test('标准虚构数据整库往返无损（S2.1 事实源一致性基础）', () => {
  const ctx = setup('ledger-repo-');
  try {
    const state = loadFixtureState();
    R.writeState(ctx.db, state);
    const out = R.readState(ctx.db);

    assert.deepStrictEqual(ASSET_STRIP(out.assets), ASSET_STRIP(state.assets));
    assert.deepStrictEqual(out.accounts, state.accounts);
    assert.deepStrictEqual(out.categories, state.categories);
    assert.deepStrictEqual(out.txns, state.txns);
    assert.deepStrictEqual(out.settings, state.settings);
  } finally {
    ctx.close();
  }
});

test('重复写入同一状态结果一致（幂等，无重复行）', () => {
  const ctx = setup('ledger-repo-');
  try {
    const state = loadFixtureState();
    R.writeState(ctx.db, state);
    const first = R.readState(ctx.db);
    R.writeState(ctx.db, state);
    R.writeState(ctx.db, state);
    const third = R.readState(ctx.db);

    assert.deepStrictEqual(third, first);
    assert.strictEqual(dbm.get(ctx.db, 'SELECT COUNT(*) AS c FROM asset_accounts').c, 4);
    assert.strictEqual(dbm.get(ctx.db, 'SELECT COUNT(*) AS c FROM account_units').c, 3);
    assert.strictEqual(dbm.get(ctx.db, 'SELECT COUNT(*) AS c FROM institutions').c, 1);
  } finally {
    ctx.close();
  }
});

test('总览口径与 ACCEPTANCE §2 精确一致（复用同一份 domain.js）', () => {
  const ctx = setup('ledger-repo-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const out = R.readState(ctx.db);
    const overview = Domain.computeOverview(out.assets, {
      now: '2026-09-06',
      settings: { safetyTargetMinor: 3000000 }
    });
    assert.strictEqual(overview.totalAssetsMinor, 4580000);
    assert.strictEqual(overview.totalLiabilitiesMinor, 200000);
    assert.strictEqual(overview.netWorthMinor, 4380000);
    assert.strictEqual(overview.pools.investableMinor, 1080000);
    assert.strictEqual(overview.valuationStatus, 'formal');
    assert.strictEqual(overview.canAdvise, true);
  } finally {
    ctx.close();
  }
});

test('未建模的字段通过 extra_json 保留，不丢数据', () => {
  const ctx = setup('ledger-repo-');
  try {
    const state = loadFixtureState();
    state.assets.assetAccounts[0].note = '备注：虚构';
    state.assets.assetAccounts[0].tags = ['a', 'b'];
    state.assets.instruments[0].customField = { nested: [1, 2, 3] };
    state.assets.holdings[0].importedFrom = 'broker-statement';
    R.writeState(ctx.db, state);
    const out = R.readState(ctx.db);
    const acc = out.assets.assetAccounts.find((a) => a.id === state.assets.assetAccounts[0].id);
    assert.strictEqual(acc.note, '备注：虚构');
    assert.deepStrictEqual(acc.tags, ['a', 'b']);
    assert.deepStrictEqual(out.assets.instruments[0].customField, { nested: [1, 2, 3] });
    assert.strictEqual(out.assets.holdings[0].importedFrom, 'broker-statement');
  } finally {
    ctx.close();
  }
});

test('机构：自由文本归一为 institutions 行并按名称还原', () => {
  const ctx = setup('ledger-repo-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const inst = dbm.all(ctx.db, 'SELECT id, name, kind FROM institutions');
    assert.strictEqual(inst.length, 1);
    assert.strictEqual(inst[0].name, '香港汇丰');
    assert.strictEqual(inst[0].kind, 'bank');

    const accounts = R.readAssetAccounts(ctx.db);
    const hsbc = accounts.find((a) => a.id === 'acc-hsbc');
    assert.strictEqual(hsbc.institution, '香港汇丰');
    // 未填写机构的账户不应凭空产生 institution 字段
    const cmb = accounts.find((a) => a.id === 'acc-cmb');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(cmb, 'institution'), false);
  } finally {
    ctx.close();
  }
});

test('无明确余额的权益存 NULL，不被写成 0', () => {
  const ctx = setup('ledger-repo-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const row = dbm.get(ctx.db, 'SELECT balance_minor FROM entitlements WHERE id = ?', ['e-ub']);
    assert.strictEqual(row.balance_minor, null);
    const out = R.readState(ctx.db);
    const ent = out.assets.entitlements.find((e) => e.id === 'e-ub');
    assert.strictEqual(ent.balanceMinor, null);
  } finally {
    ctx.close();
  }
});

test('应用锁开启时：交易只落密文，txns 表保持为空', () => {
  const ctx = setup('ledger-repo-');
  try {
    const state = loadFixtureState();
    R.writeState(ctx.db, state);
    assert.strictEqual(dbm.get(ctx.db, 'SELECT COUNT(*) AS c FROM txns').c, 0);

    const blob = { enc: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: 210000, iv: 'aaa', data: 'bbb' };
    R.writeState(ctx.db, {
      accounts: state.accounts,
      categories: state.categories,
      txns: blob,
      settings: { lock: { enabled: true }, schemaVersion: 1 },
      assets: state.assets
    });

    const out = R.readState(ctx.db);
    assert.deepStrictEqual(out.txns, blob);
    // 磁盘上不得留有明文交易行
    assert.strictEqual(dbm.get(ctx.db, 'SELECT COUNT(*) AS c FROM txns').c, 0);
    const raw = dbm.get(ctx.db, 'SELECT meta_value FROM service_meta WHERE meta_key = ?', [
      R.TXNS_BLOB_META_KEY
    ]);
    assert.ok(raw && raw.meta_value.indexOf('AES-GCM') !== -1);
  } finally {
    ctx.close();
  }
});

test('全量替换：已删除的记录不会残留', () => {
  const ctx = setup('ledger-repo-');
  try {
    const state = loadFixtureState();
    R.writeState(ctx.db, state);
    assert.strictEqual(R.readAssetUnits(ctx.db).length, 3);

    state.assets.assetUnits = state.assets.assetUnits.filter((u) => u.id !== 'u-gjj');
    const affectedAccounts = state.assets.assetAccounts.filter((a) => a.id !== 'acc-gjj');
    state.assets.assetAccounts = affectedAccounts;
    R.writeState(ctx.db, state);

    const units = R.readAssetUnits(ctx.db);
    assert.strictEqual(units.length, 2);
    assert.deepStrictEqual(units.map((u) => u.id), ['u-cmb', 'u-hsbc']);
    const accs = R.readAssetAccounts(ctx.db);
    assert.strictEqual(accs.length, 3);
  } finally {
    ctx.close();
  }
});

test('写入失败时整库回滚：不会出现半新半旧（事务原子性）', () => {
  const ctx = setup('ledger-repo-');
  try {
    const good = loadFixtureState();
    R.writeState(ctx.db, good);
    const before = R.readState(ctx.db);

    const bad = loadFixtureState();
    bad.assets.assetUnits[0].currency = 'JPY'; // 违反币种 CHECK
    assert.throws(() => R.writeState(ctx.db, bad), /CHECK|constraint/i);

    const after = R.readState(ctx.db);
    assert.deepStrictEqual(after, before, '失败写入后必须与写入前完全一致');
    assert.strictEqual(dbm.get(ctx.db, 'SELECT COUNT(*) AS c FROM account_units').c, 3);
  } finally {
    ctx.close();
  }
});

test('清空后回到空状态，再写入可恢复', () => {
  const ctx = setup('ledger-repo-');
  try {
    const state = loadFixtureState();
    R.writeState(ctx.db, state);
    R.clearAll(ctx.db);
    const empty = R.readState(ctx.db);
    assert.deepStrictEqual(empty.accounts, []);
    assert.deepStrictEqual(empty.txns, []);
    assert.strictEqual(empty.settings, undefined);
    assert.strictEqual(R.readAssetAccounts(ctx.db).length, 0);
    assert.strictEqual(dbm.get(ctx.db, 'SELECT COUNT(*) AS c FROM institutions').c, 0);

    R.writeState(ctx.db, state);
    assert.deepStrictEqual(R.readState(ctx.db).accounts, state.accounts);
  } finally {
    ctx.close();
  }
});

test('确定性重复指纹按来源+原始单号落表，可支撑自动拦截', () => {
  const ctx = setup('ledger-repo-');
  try {
    const state = loadFixtureState();
    state.txns = [
      { id: 't1', date: '2026-09-06', type: 'expense', amount: 1200, source: 'wechat', rawId: 'W-1', merchant: '咖啡' },
      { id: 't2', date: '2026-09-06', type: 'expense', amount: 900, source: 'bank', rawId: 'B-1', merchant: '超市' }
    ];
    R.writeState(ctx.db, state);
    const fps = dbm.all(ctx.db, 'SELECT fingerprint, txn_id FROM dedup_fingerprints ORDER BY fingerprint');
    assert.deepStrictEqual(fps.map((r) => r.fingerprint), ['bank|B-1', 'wechat|W-1']);
    assert.deepStrictEqual(fps.map((r) => r.txn_id), ['t2', 't1']);
    // 无 rawId 的交易不产生指纹（避免误拦人工记账）
    assert.strictEqual(
      dbm.get(ctx.db, 'SELECT COUNT(*) AS c FROM dedup_fingerprints').c,
      2
    );
  } finally {
    ctx.close();
  }
});

test('持仓视图带出账户名、标的与最近报价，不重复计算', () => {
  const ctx = setup('ledger-repo-');
  try {
    R.writeState(ctx.db, loadFixtureState());
    const holdings = R.readHoldings(ctx.db);
    assert.strictEqual(holdings.length, 1);
    const h = holdings[0];
    assert.strictEqual(h.symbol, 'VOO');
    assert.strictEqual(h.accountName, '券商账户');
    assert.strictEqual(h.assetClass, 'broad_equity');
    assert.strictEqual(h.quantity, '10');
    assert.strictEqual(h.latestQuote.priceMinor, 5000);
  } finally {
    ctx.close();
  }
});

test('幂等键可按 method+path 复用，不同路径不复用', () => {
  const ctx = setup('ledger-repo-');
  try {
    R.rememberIdempotent(ctx.db, 'k1', 'PUT', '/api/v1/state', { ok: true, n: 1 });
    assert.deepStrictEqual(R.findIdempotent(ctx.db, 'k1', 'PUT', '/api/v1/state'), { ok: true, n: 1 });
    assert.strictEqual(R.findIdempotent(ctx.db, 'k1', 'POST', '/api/v1/state'), null);
    assert.strictEqual(R.findIdempotent(ctx.db, 'nope', 'PUT', '/api/v1/state'), null);
  } finally {
    ctx.close();
  }
});

test('资产集合键名与领域模型保持一致（holdings ↔ portfolio_openings 映射）', () => {
  const ctx = setup('ledger-repo-');
  try {
    assert.deepStrictEqual(R.ASSET_KEYS, [
      'assetAccounts',
      'assetUnits',
      'assetTransfers',
      'liabilities',
      'entitlements',
      'instruments',
      'holdings',
      'quotes',
      'fxRates'
    ]);
    assert.strictEqual(R.readAssetUnits, R.readAssetUnits);
    // 领域层的空集合形状与我们写出的形状一致
    const empty = Domain.emptyAssets();
    R.writeState(ctx.db, { accounts: [], categories: [], txns: [], settings: {}, assets: empty });
    const out = R.readState(ctx.db);
    R.ASSET_KEYS.forEach((k) => assert.deepStrictEqual(out.assets[k], []));

    // 形状契约：readState().assets 必须能被前端 normalizeAssets 直接消费。
    // 历史缺陷：这里漏了 schemaVersion，前端拿到的资产集合与 DB.loadRaw() 形状不一致。
    assert.deepStrictEqual(
      Object.keys(out.assets).sort(),
      Object.keys(empty).sort(),
      'readState().assets 的键集必须与 Domain.emptyAssets() 完全一致'
    );
    assert.strictEqual(out.assets.schemaVersion, empty.schemaVersion, '必须带上 schemaVersion');
    assert.deepStrictEqual(Domain.normalizeAssets(out.assets), out.assets, '读回结果应已是规范化形状');
  } finally {
    ctx.close();
  }
});

/* ---------------- Phase 3 补口（P1-C）：全量写入不信任载荷中的重复币种字段 ---------------- */

test('P1-C writeState 拒绝换汇两端币种与关联余额单元不一致的数据', () => {
  const ctx = setup('ledger-repo-');
  try {
    const state = loadFixtureState();
    R.writeState(ctx.db, state);

    const units = R.readAssetUnits(ctx.db);
    const from = units[0];
    const to = units.find((u) => u.currency !== from.currency);
    assert.ok(from && to, '前提：标准虚构数据含两个不同币种子账户');

    // 载荷把历史币种写反（转出单元实际是 from.currency，却声称 USD→HKD 之类）
    const tampered = loadFixtureState();
    tampered.assets.assetTransfers = [{
      id: 'xfer-tampered',
      fromUnitId: from.id,
      toUnitId: to.id,
      fromCurrency: to.currency,
      toCurrency: from.currency,
      fromAmountMinor: 10000,
      toAmountMinor: 9000,
      occurredOn: '2026-08-20',
      sourceType: 'manual'
    }];

    R.writeState(ctx.db, tampered);
    const stored = R.readAssetTransfers(ctx.db);
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].fromCurrency, from.currency, '币种必须由关联单元推导，而不是采信载荷');
    assert.strictEqual(stored[0].toCurrency, to.currency);

    // 关联到不存在的单元 → 整次写入必须失败，不能落一条矛盾的历史
    const orphan = loadFixtureState();
    orphan.assets.assetTransfers = [{
      id: 'xfer-orphan',
      fromUnitId: 'unit-not-exist',
      toUnitId: to.id,
      fromCurrency: 'USD',
      toCurrency: to.currency,
      fromAmountMinor: 100,
      toAmountMinor: 100,
      occurredOn: '2026-08-20'
    }];
    assert.throws(() => R.writeState(ctx.db, orphan), /不存在|unknown_unit/);

    // 失败不得留下半条数据
    const after = R.readAssetTransfers(ctx.db);
    assert.strictEqual(after.length, 1, '失败的整库写入必须整体回滚');
    assert.strictEqual(after[0].id, 'xfer-tampered');

    // 同币种两端 → 拒绝
    const same = loadFixtureState();
    same.assets.assetTransfers = [{
      id: 'xfer-same',
      fromUnitId: from.id,
      toUnitId: from.id,
      fromCurrency: from.currency,
      toCurrency: from.currency,
      fromAmountMinor: 100,
      toAmountMinor: 100,
      occurredOn: '2026-08-20'
    }];
    assert.throws(() => R.writeState(ctx.db, same), /相同/);
  } finally {
    ctx.close();
  }
});
