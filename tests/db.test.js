const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key(i) { return Array.from(data.keys())[i] || null; },
    getItem(k) { return data.has(String(k)) ? data.get(String(k)) : null; },
    setItem(k, v) { data.set(String(k), String(v)); },
    removeItem(k) { data.delete(String(k)); },
    clear() { data.clear(); }
  };
}

global.localStorage = makeStorage();
const DB = require('../js/db.js');

beforeEach(async () => {
  global.localStorage.clear();
  DB.dropMemoryKey();
});

test('明文状态可在本地存储往返读取', async () => {
  const state = {
    accounts: [{ id: 'acc-bank', name: '测试银行卡' }],
    categories: [{ id: 'cat-food', name: '餐饮' }],
    txns: [{ id: 't1', merchant: '虚构早餐店', amount: 1234 }],
    settings: { lock: { enabled: false } },
    assets: { schemaVersion: 1, assetAccounts: [{ id: 'acc-hsbc', name: '汇丰' }], assetUnits: [], liabilities: [], entitlements: [], instruments: [], holdings: [], quotes: [], fxRates: [] }
  };
  await DB.saveAll(state);
  const raw = await DB.loadRaw();
  assert.deepStrictEqual(raw, state);
});

test('assets 键缺省（旧版本存储）时 loadRaw 返回 undefined，不报错', async () => {
  await DB.saveAll({
    accounts: [], categories: [], txns: [], settings: { lock: { enabled: false } }
  });
  const raw = await DB.loadRaw();
  assert.strictEqual(raw.assets, undefined); // 旧存储没有 assets 键：不报错，由调用方归一化为空集合
  assert.deepStrictEqual(raw.txns, []);
});

test('应用锁开启后交易以 AES-GCM 密文落盘并可正确解锁', async () => {
  const txns = [{ id: 't-secret', merchant: '虚构敏感商户', amount: 4567 }];
  const params = await DB.makeLockParams('test-pass-2026');
  await DB.saveAll({
    accounts: [], categories: [], txns,
    settings: { lock: { enabled: true, salt: params.salt, iter: params.iter } }
  });

  const storedText = global.localStorage.getItem('ledger:txns');
  const stored = JSON.parse(storedText);
  assert.strictEqual(stored.enc, 1);
  assert.strictEqual(stored.alg, 'AES-GCM');
  assert.ok(!storedText.includes('虚构敏感商户'));

  DB.dropMemoryKey();
  const unlocked = await DB.unlock('test-pass-2026', params, stored);
  assert.deepStrictEqual(unlocked, txns);
});

test('错误密码无法解密交易数据', async () => {
  const params = await DB.makeLockParams('correct-pass');
  await DB.saveAll({
    accounts: [], categories: [], txns: [{ id: 't1', amount: 100 }],
    settings: { lock: { enabled: true, salt: params.salt, iter: params.iter } }
  });
  const stored = JSON.parse(global.localStorage.getItem('ledger:txns'));
  DB.dropMemoryKey();
  await assert.rejects(DB.unlock('wrong-pass', params, stored));
});

test('clearAll 只清除 ledger 命名空间数据', async () => {
  global.localStorage.setItem('other-app:data', 'keep');
  await DB.saveAll({ accounts: [], categories: [], txns: [], settings: { lock: { enabled: false } } });
  await DB.clearAll();
  assert.strictEqual(global.localStorage.getItem('ledger:txns'), null);
  assert.strictEqual(global.localStorage.getItem('other-app:data'), 'keep');
});
