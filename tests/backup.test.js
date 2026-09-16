const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../js/core.js');

test('JSON 备份生成与恢复往返保留核心数据', () => {
  const state = {
    accounts: Core.defaultAccounts(),
    categories: Core.defaultCategories(),
    txns: [{
      id: 'backup-1', date: '2026-09-05', type: 'expense', amount: 32100,
      account: 'acc-cash', category: 'cat-food', merchant: '虚构恢复测试', source: 'manual'
    }],
    settings: Object.assign(Core.defaultSettings(), { lock: { enabled: true, salt: 'test', iter: 210000 } })
  };
  const backup = Core.createBackup(state, '2.0.0-rc.3', '2026-09-05T08:00:00.000Z');
  const restored = Core.restoreStateFromBackup(JSON.parse(JSON.stringify(backup)));
  assert.strictEqual(backup.appVersion, '2.0.0-rc.3');
  assert.strictEqual(restored.txns.length, 1);
  assert.strictEqual(restored.txns[0].merchant, '虚构恢复测试');
  assert.strictEqual(restored.accounts.length, state.accounts.length);
  assert.strictEqual(restored.settings.lock.enabled, false);
});

test('固定验收备份可恢复并补齐缺省账户与分类', () => {
  const file = path.join(__dirname, 'fixtures', 'acceptance_backup.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const restored = Core.restoreStateFromBackup(data);
  assert.strictEqual(restored.txns.length, 1);
  assert.strictEqual(restored.txns[0].amount, 32100);
  assert.ok(restored.accounts.length >= 4);
  assert.ok(restored.categories.length >= 10);
});

test('恢复拒绝未来 Schema 和结构损坏的备份', () => {
  // Schema v2 起 assets 进入备份（Phase 1）；更高版本仍必须被拒绝
  assert.throws(() => Core.restoreStateFromBackup({ app: 'ledger', schemaVersion: 3, txns: [] }), /不支持的备份版本/);
  assert.throws(() => Core.restoreStateFromBackup({ app: 'ledger', schemaVersion: 1, txns: {} }), /交易数据/);
  assert.throws(() => Core.restoreStateFromBackup({ app: 'other', schemaVersion: 1, txns: [] }), /不是小账本/);
  assert.throws(() => Core.restoreStateFromBackup({ app: 'ledger', schemaVersion: 2, txns: [], assets: 'bad' }), /资产数据/);
});

test('S1.1 v1 备份恢复后 v3 资产集合初始化为空', () => {
  const v1 = {
    app: 'ledger', appVersion: '2.0.0-rc.3', schemaVersion: 1,
    exportedAt: '2026-09-06T08:00:00.000Z',
    accounts: [{ id: 'acc-cash', name: '现金' }],
    categories: [{ id: 'cat-food', name: '餐饮' }],
    txns: [{ id: 't1', date: '2026-09-05', type: 'expense', amount: 1000, account: 'acc-cash', category: 'cat-food', merchant: '旧版数据', source: 'manual' }],
    settings: { lock: { enabled: false } }
  };
  const restored = Core.restoreStateFromBackup(JSON.parse(JSON.stringify(v1)));
  // 旧数据保持不变
  assert.strictEqual(restored.txns.length, 1);
  assert.strictEqual(restored.txns[0].merchant, '旧版数据');
  assert.strictEqual(restored.txns[0].amount, 1000);
  // v3 集合初始化为空，且可再次导出（schemaVersion 升级为 2）
  assert.deepStrictEqual(restored.assets, {
    schemaVersion: 1, assetAccounts: [], assetUnits: [], assetTransfers: [], liabilities: [], entitlements: [],
    instruments: [], holdings: [], quotes: [], fxRates: [], securityEvents: []
  });
  const again = Core.createBackup(restored, '2.0.0-rc.3', '2026-09-06T09:00:00.000Z');
  assert.strictEqual(again.schemaVersion, 2);
  assert.strictEqual(Core.restoreStateFromBackup(again).txns.length, 1);
});

test('S1.1 v2 备份的 v3 资产字段可往返', () => {
  const Domain = require('../js/domain.js');
  const assets = Domain.normalizeAssets({
    assetAccounts: [{ id: 'acc-hsbc', name: '汇丰 USD 子账户', kind: 'bank', pool: 'investable', status: 'active' }],
    assetUnits: [{ id: 'u-hsbc', accountId: 'acc-hsbc', currency: 'USD', balanceMinor: 100000, asOf: '2026-09-06', sourceType: 'manual' }],
    entitlements: [{ id: 'e-ub', name: '失业保险待遇资格', kind: 'unemployment', status: 'active', balanceMinor: null, asOf: '2026-09-06' }],
    fxRates: [{ base: 'USD', quote: 'CNY', rateDecimal: '7.20', rateDate: '2026-09-06', provider: 'fixture', status: 'ok' }]
  });
  const state = {
    accounts: Core.defaultAccounts(), categories: Core.defaultCategories(),
    txns: [], settings: Core.defaultSettings(), assets
  };
  const backup = Core.createBackup(state, '2.1.0-phase1', '2026-09-06T08:00:00.000Z');
  assert.strictEqual(backup.schemaVersion, 2);
  const restored = Core.restoreStateFromBackup(JSON.parse(JSON.stringify(backup)));
  assert.deepStrictEqual(restored.assets, assets); // 旧集合四键 + 新资产集合全部原样保留
});

test('CSV 导出包含 BOM、中文字段并正确转义逗号和引号', () => {
  const csv = Core.transactionsToCSV([{
    id: 'csv-1', date: '2026-09-05', time: '08:30', type: 'expense', amount: 1234,
    account: 'acc-cash', category: 'cat-food', merchant: '虚构,商户', note: '备注"测试"', source: 'manual'
  }], Core.defaultAccounts(), Core.defaultCategories());
  assert.ok(csv.startsWith('\uFEFF日期,时间,类型,金额(元)'));
  assert.match(csv, /2026-09-05,08:30,支出,12\.34,现金/);
  assert.match(csv, /"虚构,商户"/);
  assert.match(csv, /"备注""测试"""/);
});

test('备份往返去除 exportedAt 后按 id 深比较一致（P3.1 闭环）', () => {
  const txns = [
    { id: 'rt-1', date: '2026-08-01', time: '09:00', type: 'expense', amount: 12345,
      account: 'acc-wechat', category: 'cat-food', merchant: '虚构,"商户"甲', note: '备注"引"', source: 'manual' },
    { id: 'rt-2', date: '2026-08-02', time: '10:00', type: 'transfer', amount: 100000,
      account: 'acc-wechat', accountTo: 'acc-bank', category: null, merchant: '', note: '', source: 'manual' },
    { id: 'rt-3', date: '2026-08-03', time: '11:00', type: 'income', amount: 5000,
      account: 'acc-wechat', category: 'cat-redpacket', merchant: '虚构退款来款', source: 'wechat', rawId: 'wx:rt3', refundFlag: true,
      refundOf: 'rt-1' },
    { id: 'rt-4', date: '2026-08-04', type: 'expense', amount: 250000, account: 'acc-bank',
      category: 'cat-transport', merchant: '虚构差旅', source: 'manual', reimburseFlag: true,
      recurringKey: 'rc-1@2026-08-04' }
  ];
  const state = {
    accounts: Core.defaultAccounts(),
    categories: Core.defaultCategories(),
    txns, settings: Object.assign(Core.defaultSettings(), {
      budgets: { total: 300000, cats: { 'cat-food': 50000 } },
      recurring: [{ id: 'rc-1', name: '房租', type: 'expense', amount: 250000, frequency: 'monthly', day: 4, active: true }]
    })
  };
  const backup1 = Core.createBackup(state, '2.0.0', '2026-09-05T08:00:00.000Z');
  const restored = Core.restoreStateFromBackup(JSON.parse(JSON.stringify(backup1)));
  const backup2 = Core.createBackup(restored, '2.0.0', '2026-09-05T09:00:00.000Z');

  const strip = b => {
    const { exportedAt, ...rest } = b;
    const sortById = arr => arr.slice().sort((a, b2) => (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0));
    return {
      ...rest,
      accounts: sortById(rest.accounts),
      categories: sortById(rest.categories),
      txns: sortById(rest.txns)
    };
  };
  assert.deepStrictEqual(strip(backup2), strip(backup1), '两次导出（去 exportedAt、按 id 排序）应完全一致');
  // 关联字段不得在往返中丢失
  const byId = Object.fromEntries(backup2.txns.map(t => [t.id, t]));
  assert.strictEqual(byId['rt-3'].refundOf, 'rt-1');
  assert.strictEqual(byId['rt-4'].reimburseFlag, true);
  assert.strictEqual(byId['rt-4'].recurringKey, 'rc-1@2026-08-04');
  assert.strictEqual(byId['rt-2'].accountTo, 'acc-bank');
});
