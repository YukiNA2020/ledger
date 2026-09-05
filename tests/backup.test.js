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
  assert.throws(() => Core.restoreStateFromBackup({ app: 'ledger', schemaVersion: 2, txns: [] }), /不支持的备份版本/);
  assert.throws(() => Core.restoreStateFromBackup({ app: 'ledger', schemaVersion: 1, txns: {} }), /交易数据/);
  assert.throws(() => Core.restoreStateFromBackup({ app: 'other', schemaVersion: 1, txns: [] }), /不是小账本/);
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
