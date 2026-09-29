/* Phase 3 资源写入与月度结账 API 测试（临时数据库，虚构数据）
 *
 * 对应 ACCEPTANCE：
 *   S3.1 机构—账户—币种子账户 —— 五类资源与换汇单条 upsert、独立余额、换汇不计收支、校验与幂等
 *   S3.3 月结门槛 —— 有未核对项时正式结账 409、可保存估算并附 sha256 快照、同月重复结账更新记录并追加快照
 *
 * 覆盖 ROADMAP Phase 3 工作项 1/2/4/5/6 的服务端行为（服务端是唯一写入者，§5.6）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const api = require('../server/api');
const config = require('../server/config');
const R = require('../server/repository');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';

async function startServer(ctx) {
  Object.assign(ctx, {
    host: config.HOST,
    port: 0,
    token: TOKEN,
    repoRoot: config.REPO_ROOT,
    backupKeep: config.BACKUP_KEEP,
    backupMinIntervalMs: config.BACKUP_MIN_INTERVAL_MS,
    keychainService: 'com.ledger.local.test',
    keychainAccount: 'test',
    startedAt: new Date().toISOString(),
    logger: { info() {}, warn() {}, error() {} }
  });
  const handler = api.createHandlerEntry(ctx);
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, config.HOST, resolve);
  });
  const address = server.address();
  ctx.port = address.port;
  return {
    port: address.port,
    origin: 'http://127.0.0.1:' + address.port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: config.HOST,
        port: port,
        method: method,
        path: pathname,
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'X-Ledger-Token': TOKEN, Origin: 'http://127.0.0.1:' + port },
          payload == null ? {} : { 'Content-Length': Buffer.byteLength(payload) }
        )
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { json = null; }
          resolve({ status: res.statusCode, json: json });
        });
      }
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function post(port, path, body) {
  return request(port, 'POST', path, body);
}

test('S3.1 香港汇丰多币种账户：HKD/USD 余额独立，换汇为资产转移且不计收支', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const inst = await post(srv.port, '/api/v1/institutions', { name: '香港汇丰', kind: 'bank' });
    assert.strictEqual(inst.status, 201);
    assert.ok(inst.json.item.id, '机构应有 id');

    const acc = await post(srv.port, '/api/v1/accounts', {
      name: '汇丰多币种账户', institution: '香港汇丰', institutionKind: 'bank', kind: 'deposit', pool: 'safety', status: 'active'
    });
    assert.strictEqual(acc.status, 201);
    const accId = acc.json.item.id;

    const hkd = await post(srv.port, '/api/v1/account-units', {
      accountId: accId, currency: 'HKD', balanceMinor: 123456, asOf: '2026-09-15', sourceType: 'manual'
    });
    const usd = await post(srv.port, '/api/v1/account-units', {
      accountId: accId, currency: 'USD', balanceMinor: 100000, asOf: '2026-09-15', sourceType: 'manual'
    });
    assert.strictEqual(hkd.status, 201);
    assert.strictEqual(usd.status, 201);

    const transfer = await post(srv.port, '/api/v1/asset-transfers', {
      id: 'xfer-hkd-usd',
      fromUnitId: hkd.json.item.id,
      toUnitId: usd.json.item.id,
      fromAmountMinor: 78000,
      toAmountMinor: 10000,
      occurredOn: '2026-09-15',
      sourceType: 'manual',
      note: '虚构换汇'
    });
    assert.strictEqual(transfer.status, 201);
    assert.strictEqual(transfer.json.item.fromCurrency, 'HKD');
    assert.strictEqual(transfer.json.item.toCurrency, 'USD');

    const invalidTransfer = await post(srv.port, '/api/v1/asset-transfers', {
      fromUnitId: hkd.json.item.id,
      toUnitId: hkd.json.item.id,
      fromAmountMinor: 100,
      toAmountMinor: 100,
      occurredOn: '2026-09-15'
    });
    assert.strictEqual(invalidTransfer.status, 400);
    assert.strictEqual(invalidTransfer.json.error.code, 'same_unit');

    // HTTP 直读 + /state 聚合视图一致
    const accounts = await request(srv.port, 'GET', '/api/v1/accounts');
    assert.strictEqual(accounts.json.items.length, 1);
    assert.strictEqual(accounts.json.items[0].institution, '香港汇丰');
    const units = await request(srv.port, 'GET', '/api/v1/account-units');
    assert.strictEqual(units.json.items.length, 2);
    assert.deepStrictEqual(units.json.items.map((u) => [u.currency, u.balanceMinor]), [
      ['HKD', 123456], ['USD', 100000]
    ]);
    const transfers = await request(srv.port, 'GET', '/api/v1/asset-transfers');
    assert.strictEqual(transfers.json.items.length, 1);

    // 两个原币余额保持独立；只有总览汇总时才按固定测试汇率折算为 CNY。
    const seeded = R.readState(ctx.db);
    seeded.assets.fxRates = [
      { base: 'HKD', quote: 'CNY', rateDecimal: '0.92', rateDate: '2026-09-15', provider: 'fixture' },
      { base: 'USD', quote: 'CNY', rateDecimal: '7.20', rateDate: '2026-09-15', provider: 'fixture' }
    ];
    R.writeState(ctx.db, seeded, { now: '2026-09-15T12:00:00Z' });
    const overview = await request(srv.port, 'GET', '/api/v1/overview?asOf=2026-09-15');
    assert.strictEqual(overview.json.totalAssetsMinor, 833580, '汇总时才把 HKD 与 USD 分别折算为 CNY');

    const state = await request(srv.port, 'GET', '/api/v1/state');
    assert.strictEqual(state.json.assets.assetAccounts.length, 1);
    assert.strictEqual(state.json.assets.assetUnits.length, 2);
    assert.strictEqual(state.json.assets.assetUnits[0].balanceMinor, 123456);
    assert.strictEqual(state.json.assets.assetTransfers.length, 1);
    assert.strictEqual(state.json.txns.length, 0, '换汇不得伪装成收入、支出或旧现金流转账');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('S3.1 负债与保障权益：金额最小单位落库，无余额权益 balanceMinor 为 null', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const liab = await post(srv.port, '/api/v1/liabilities', {
      name: '信用卡', currency: 'CNY', balanceMinor: 50050, dueDate: '2026-10-01', termType: 'revolving'
    });
    assert.strictEqual(liab.status, 201);
    assert.strictEqual(liab.json.item.balanceMinor, 50050);

    const ent = await post(srv.port, '/api/v1/entitlements', {
      name: '青岛公积金', kind: 'housing_fund', jurisdiction: '青岛', status: '在缴', valuationType: 'statement'
    });
    assert.strictEqual(ent.status, 201);
    assert.strictEqual(ent.json.item.balanceMinor, null, '未提供余额的权益应为 null 而不是 0');

    const state = await request(srv.port, 'GET', '/api/v1/state');
    assert.strictEqual(state.json.assets.liabilities.length, 1);
    assert.strictEqual(state.json.assets.entitlements.length, 1);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('S3.1 校验拒绝：非法 pool / 非法币种 / 缺名称一律 400 且零副作用', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    assert.strictEqual((await post(srv.port, '/api/v1/accounts', { name: 'X', pool: 'nonsense' })).status, 400);
    assert.strictEqual((await post(srv.port, '/api/v1/accounts', { name: '' })).status, 400);
    assert.strictEqual((await post(srv.port, '/api/v1/account-units', { accountId: 'a', currency: 'JPY', balanceMinor: 1 })).status, 400);
    assert.strictEqual((await post(srv.port, '/api/v1/liabilities', { name: 'L', balanceMinor: -1 })).status, 400);
    assert.strictEqual((await post(srv.port, '/api/v1/institutions', { name: 'B', kind: 'hedge_fund' })).status, 400);

    const state = await request(srv.port, 'GET', '/api/v1/state');
    assert.strictEqual(state.json.assets.assetAccounts.length, 0, '被拒写请求不得留副作用');
    assert.strictEqual(state.json.assets.liabilities.length, 0);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('S3.1 未知账户的余额单元返回 422 unknown_account', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const unit = await post(srv.port, '/api/v1/account-units', {
      accountId: 'acct-does-not-exist', currency: 'CNY', balanceMinor: 100
    });
    assert.strictEqual(unit.status, 422);
    assert.strictEqual(unit.json.error.code, 'unknown_account');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('S3.1 同 id 重复提交为幂等更新：不产生第二行', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const first = await post(srv.port, '/api/v1/accounts', { id: 'acct-fixed', name: '工资卡', pool: 'safety', status: 'active' });
    assert.strictEqual(first.status, 201);
    const second = await post(srv.port, '/api/v1/accounts', { id: 'acct-fixed', name: '工资卡（改）', pool: 'investable', status: 'active' });
    assert.strictEqual(second.status, 201);

    const accounts = await request(srv.port, 'GET', '/api/v1/accounts');
    assert.strictEqual(accounts.json.items.length, 1);
    assert.strictEqual(accounts.json.items[0].name, '工资卡（改）');
    assert.strictEqual(accounts.json.items[0].pool, 'investable');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('S3.3 月结门槛：有未核对项时正式结账 409，估算可保存且附 sha256 快照', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    // 余额核对日为 7 月（对 8 月结账已过期）→ checklist 必有阻塞 → formal 必须被拒
    const acc = await post(srv.port, '/api/v1/accounts', { name: '储蓄卡', pool: 'safety', status: 'active' });
    await post(srv.port, '/api/v1/account-units', {
      accountId: acc.json.item.id, currency: 'CNY', balanceMinor: 300000, asOf: '2026-07-15', sourceType: 'manual'
    });

    const formal = await post(srv.port, '/api/v1/monthly-closes', { month: '2026-08', status: 'formal' });
    assert.strictEqual(formal.status, 409);
    assert.strictEqual(formal.json.error.code, 'close_blocked');

    const estimate = await post(srv.port, '/api/v1/monthly-closes', { month: '2026-08', status: 'estimate' });
    assert.strictEqual(estimate.status, 201);
    assert.strictEqual(estimate.json.close.status, 'estimate');
    assert.strictEqual(estimate.json.close.month, '2026-08');
    assert.ok((estimate.json.close.blockers || []).length >= 1, '应记录阻塞码清单');

    const closes = await request(srv.port, 'GET', '/api/v1/monthly-closes');
    assert.strictEqual(closes.json.items.length, 1);
    const row = closes.json.items[0];
    assert.strictEqual(row.status, 'estimate');
    assert.strictEqual(row.dataCutoff, '2026-08-31', '数据截止应为该月最后一天');
    assert.ok(row.snapshot && /^[0-9a-f]{64}$/.test(row.snapshot.payloadHash), '应附 sha256 快照哈希');
    assert.ok(row.summary && typeof row.summary.netWorthMinor === 'number', 'summary 应含净资产');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('S3.3 同月重复结账：更新同一条记录并追加新快照', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const acc = await post(srv.port, '/api/v1/accounts', { name: '储蓄卡', pool: 'safety', status: 'active' });
    await post(srv.port, '/api/v1/account-units', {
      accountId: acc.json.item.id, currency: 'CNY', balanceMinor: 100000, asOf: '2026-08-02', sourceType: 'manual'
    });
    const first = await post(srv.port, '/api/v1/monthly-closes', { month: '2026-08' });
    const second = await post(srv.port, '/api/v1/monthly-closes', { month: '2026-08' });
    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 201);
    assert.strictEqual(first.json.close.id, second.json.close.id, '同月结账应复用同一 close id');

    const closes = await request(srv.port, 'GET', '/api/v1/monthly-closes');
    assert.strictEqual(closes.json.items.length, 1, 'monthly_closes 仍只有一条');

    const snapCount = ctx.db.prepare('SELECT COUNT(*) AS n FROM close_snapshots WHERE close_id = ?').get(first.json.close.id).n;
    assert.strictEqual(snapCount, 2, '快照应追加为两份');
    const both = closes.json.items[0].snapshot;
    assert.ok(both && /^[0-9a-f]{64}$/.test(both.payloadHash), '最新快照哈希可见');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('S3.3 应急金覆盖月数由服务端按必要支出重算', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    // 安全储备 3000 CNY，必要支出 1000/月 → 覆盖 3 个月
    const acc = await post(srv.port, '/api/v1/accounts', { name: '应急金', pool: 'safety', status: 'active' });
    await post(srv.port, '/api/v1/account-units', {
      accountId: acc.json.item.id, currency: 'CNY', balanceMinor: 300000, asOf: '2026-08-02', sourceType: 'manual'
    });
    const close = await post(srv.port, '/api/v1/monthly-closes', { month: '2026-08', avgNecessaryMinor: 100000 });
    assert.strictEqual(close.status, 201);
    const closes = await request(srv.port, 'GET', '/api/v1/monthly-closes');
    assert.strictEqual(closes.json.items[0].summary.emergencyCoverageMonths, 3);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('Phase 5 建议写入口已实现并进入真实校验；Phase 6B 决策路由也是真实行为（D-057）', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    // portfolio-openings（4C）/ market-data/refresh（4D）/ risk-assessments（5B）/ targets 与
    // approved-instruments（5C）/ recommendations（5D）都已从延后登记变成真实路由：
    // 空载荷一律进入校验并按 4xx 拒绝，不再伪装成 501。
    const rec = await post(srv.port, '/api/v1/recommendations', {});
    assert.strictEqual(rec.status, 400);
    assert.strictEqual(rec.json.error.code, 'invalid_snapshot_ref', '缺引用绑定按 5A 冻结的引用错误码拒绝');
    // 6B（D-057）：决策事件路由已实现。对不存在的决策 id，真实行为是 404 unknown_decision，
    // 不再是 501 not_implemented；完整状态机行为由 tests/server-phase6.test.js 覆盖。
    const events = await post(srv.port, '/api/v1/decisions/dc-1/events', { toState: 'accepted' });
    assert.strictEqual(events.status, 404, '决策事件已是真实路由：未知决策 404');
    assert.strictEqual(events.json.error.code, 'unknown_decision');
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ------------------ Phase 3 验收补口（P0/P1）------------------ */

const crypto = require('node:crypto');

test('S3.1 换汇边界：未知子账户 422、同币种 400、同 id 重放不增行', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const acc = await post(srv.port, '/api/v1/accounts', { name: '多币种', pool: 'safety', status: 'active' });
    const accId = acc.json.item.id;
    const hkd = await post(srv.port, '/api/v1/account-units', { accountId: accId, currency: 'HKD', balanceMinor: 100000, asOf: '2026-08-31' });
    const usd = await post(srv.port, '/api/v1/account-units', { accountId: accId, currency: 'USD', balanceMinor: 100000, asOf: '2026-08-31' });
    const acc2 = await post(srv.port, '/api/v1/accounts', { name: '工资卡', pool: 'safety', status: 'active' });
    const cny = await post(srv.port, '/api/v1/account-units', { accountId: acc2.json.item.id, currency: 'CNY', balanceMinor: 100000, asOf: '2026-08-31' });
    const cny2 = await post(srv.port, '/api/v1/account-units', { accountId: accId, currency: 'CNY', balanceMinor: 100000, asOf: '2026-08-31' });

    const unknown = await post(srv.port, '/api/v1/asset-transfers', {
      fromUnitId: hkd.json.item.id, toUnitId: 'unit-not-exist',
      fromAmountMinor: 100, toAmountMinor: 100, occurredOn: '2026-08-20'
    });
    assert.strictEqual(unknown.status, 422);
    assert.strictEqual(unknown.json.error.code, 'unknown_unit');

    // 两个 CNY 子账户之间“换汇”没有意义 → 同币种必须被拒
    const sameCur = await post(srv.port, '/api/v1/asset-transfers', {
      fromUnitId: cny.json.item.id, toUnitId: cny2.json.item.id,
      fromAmountMinor: 100, toAmountMinor: 100, occurredOn: '2026-08-20'
    });
    assert.strictEqual(sameCur.status, 400);
    assert.strictEqual(sameCur.json.error.code, 'same_currency');

    const first = await post(srv.port, '/api/v1/asset-transfers', {
      id: 'xfer-replay', fromUnitId: hkd.json.item.id, toUnitId: usd.json.item.id,
      fromAmountMinor: 100000, toAmountMinor: 12700, occurredOn: '2026-08-20'
    });
    assert.strictEqual(first.status, 201);
    const second = await post(srv.port, '/api/v1/asset-transfers', {
      id: 'xfer-replay', fromUnitId: hkd.json.item.id, toUnitId: usd.json.item.id,
      fromAmountMinor: 100000, toAmountMinor: 12800, occurredOn: '2026-08-21'
    });
    assert.strictEqual(second.status, 201);

    const list = await request(srv.port, 'GET', '/api/v1/asset-transfers');
    assert.strictEqual(list.json.items.length, 1, '同 id 重放必须只留一行');
    assert.strictEqual(list.json.items[0].toAmountMinor, 12800, '重放应更新金额');
    assert.strictEqual(list.json.items[0].fromCurrency, 'HKD', '币种由关联单元推导');
    assert.strictEqual(list.json.items[0].toCurrency, 'USD');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('P1-B 手动汇率：登记后外币余额可折算，不再被 fx_missing 阻塞', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const acc = await post(srv.port, '/api/v1/accounts', { name: '汇丰多币种', pool: 'safety', status: 'active' });
    await post(srv.port, '/api/v1/account-units', {
      accountId: acc.json.item.id, currency: 'HKD', balanceMinor: 100000, asOf: '2026-08-31'
    });

    // 未登记汇率：折算缺失 → 估值非正式
    const before = await request(srv.port, 'GET', '/api/v1/overview?asOf=2026-08-31');
    assert.strictEqual(before.json.valuationStatus !== 'formal', true, '缺汇率时不得是正式口径');

    const fx = await post(srv.port, '/api/v1/fx-rates', {
      base: 'HKD', quote: 'CNY', rateDecimal: '0.9200', rateDate: '2026-08-31', provider: 'manual'
    });
    assert.strictEqual(fx.status, 201);
    assert.strictEqual(fx.json.item.rateDecimal, '0.9200');

    // 同币对重复登记 → 更新而非新增
    await post(srv.port, '/api/v1/fx-rates', {
      base: 'HKD', quote: 'CNY', rateDecimal: '0.9300', rateDate: '2026-08-31', provider: 'manual'
    });
    const rates = await request(srv.port, 'GET', '/api/v1/fx-rates');
    assert.strictEqual(rates.json.items.length, 1, '同币对只保留一条事实');
    assert.strictEqual(rates.json.items[0].rateDecimal, '0.9300');

    const after = await request(srv.port, 'GET', '/api/v1/overview?asOf=2026-08-31');
    assert.strictEqual(after.json.totalAssetsMinor, 93000, '1000 HKD × 0.93 = 930 CNY');
    assert.strictEqual(after.json.valuationStatus, 'formal', '汇率齐备且余额已核对 → 正式口径');

    // 非法汇率
    assert.strictEqual((await post(srv.port, '/api/v1/fx-rates', { base: 'HKD', quote: 'CNY', rateDecimal: '0', rateDate: '2026-08-31' })).status, 400);
    assert.strictEqual((await post(srv.port, '/api/v1/fx-rates', { base: 'HKD', quote: 'HKD', rateDecimal: '1', rateDate: '2026-08-31' })).status, 400);
    assert.strictEqual((await post(srv.port, '/api/v1/fx-rates', { base: 'HKD', quote: 'CNY', rateDecimal: '1', rateDate: '2026/08/31' })).status, 400);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('P0-A 有负债时也可从接口完成正式结账（核对日落在结账月内）', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const acc = await post(srv.port, '/api/v1/accounts', { name: '储蓄卡', pool: 'safety', status: 'active' });
    await post(srv.port, '/api/v1/account-units', {
      accountId: acc.json.item.id, currency: 'CNY', balanceMinor: 300000, asOf: '2026-08-31'
    });
    const liab = await post(srv.port, '/api/v1/liabilities', {
      name: '信用卡待还', currency: 'CNY', balanceMinor: 50000,
      termType: 'current', asOf: '2026-08-31'
    });
    assert.strictEqual(liab.status, 201);
    assert.strictEqual(liab.json.item.asOf, '2026-08-31', '负债必须能带核对日期落库');

    const close = await post(srv.port, '/api/v1/monthly-closes', { month: '2026-08', status: 'formal' });
    assert.strictEqual(close.status, 201, '余额与负债都在结账月内核对 → 可正式结账');
    assert.strictEqual(close.json.close.status, 'formal');
    assert.strictEqual(close.json.close.canComplete, true);

    const closes = await request(srv.port, 'GET', '/api/v1/monthly-closes');
    assert.strictEqual(closes.json.items[0].status, 'formal');
    assert.strictEqual(closes.json.items[0].summary.netWorthMinor, 250000, '净资产 = 3000 − 500 元');

    // 反例：负债核对日不在结账月内 → 精确阻塞，不能正式结账
    await post(srv.port, '/api/v1/liabilities', {
      name: '信用卡待还', currency: 'CNY', balanceMinor: 50000, termType: 'current', asOf: '2026-07-15'
    });
    const blocked = await post(srv.port, '/api/v1/monthly-closes', { month: '2026-08', status: 'formal' });
    assert.strictEqual(blocked.status, 409);
    assert.ok((blocked.json.error.message || '').indexOf('核对') >= 0 || blocked.json.error.code === 'close_blocked');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('P0-B 快照明细：哈希可复核，payload 含账户/负债的单元级事实；未知 id 404', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const acc = await post(srv.port, '/api/v1/accounts', { name: '汇丰 USD 子账户', pool: 'safety', status: 'active' });
    await post(srv.port, '/api/v1/account-units', {
      accountId: acc.json.item.id, currency: 'USD', balanceMinor: 100000, asOf: '2026-08-31'
    });
    await post(srv.port, '/api/v1/fx-rates', { base: 'USD', quote: 'CNY', rateDecimal: '7.2000', rateDate: '2026-08-31' });
    await post(srv.port, '/api/v1/liabilities', {
      name: '信用卡待还', currency: 'CNY', balanceMinor: 50000, termType: 'current', asOf: '2026-08-31'
    });

    const close = await post(srv.port, '/api/v1/monthly-closes', { month: '2026-08' });
    assert.strictEqual(close.status, 201);
    const snapId = close.json.snapshot.id;
    assert.ok(snapId, '创建结账应返回快照 id');

    const detail = await request(srv.port, 'GET', '/api/v1/close-snapshots/' + snapId);
    assert.strictEqual(detail.status, 200);
    const snap = detail.json.snapshot;
    assert.strictEqual(
      crypto.createHash('sha256').update(snap.payloadJson).digest('hex'),
      snap.payloadHash,
      'payloadJson 重新哈希必须与列表哈希一致'
    );

    const payload = JSON.parse(snap.payloadJson);
    assert.strictEqual(payload.month, '2026-08');
    assert.strictEqual(payload.asOf, '2026-08-31');
    const units = payload.checklist.facts.units;
    assert.strictEqual(units.length, 1);
    assert.strictEqual(units[0].account, '汇丰 USD 子账户');
    assert.strictEqual(units[0].asOf, '2026-08-31');
    assert.strictEqual(units[0].valueCnyMinor, 720000, '快照内按当时汇率折算');
    const liabs = payload.checklist.facts.liabilities;
    assert.strictEqual(liabs.length, 1);
    assert.strictEqual(liabs[0].name, '信用卡待还');
    assert.strictEqual(liabs[0].balanceMinor, 50000);

    // 列表里的哈希与明细一致，页面「查看明细」才追得动
    const closes = await request(srv.port, 'GET', '/api/v1/monthly-closes');
    assert.strictEqual(closes.json.items[0].snapshot.payloadHash, snap.payloadHash);

    const missing = await request(srv.port, 'GET', '/api/v1/close-snapshots/snap-does-not-exist');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.json.error.code, 'snapshot_not_found');

    const bad = await request(srv.port, 'GET', '/api/v1/close-snapshots/%20bad%20id');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error.code, 'invalid_id');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('S3.2 青岛福利四类分流：明确余额各计一次，无余额资格不计入，社保卡金融账户独立', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    async function presetAccount(name, institution, kind, pool, balanceMinor) {
      const acc = await post(srv.port, '/api/v1/accounts', {
        name: name, institution: institution, institutionKind: 'government', kind: kind, pool: pool, status: 'active'
      });
      assert.strictEqual(acc.status, 201);
      const unit = await post(srv.port, '/api/v1/account-units', {
        accountId: acc.json.item.id, currency: 'CNY', balanceMinor: balanceMinor, asOf: '2026-08-31', sourceType: 'manual'
      });
      assert.strictEqual(unit.status, 201);
      return acc.json.item.id;
    }

    // 1) 公积金余额 → 受限资产，计入资产
    await presetAccount('青岛住房公积金', '青岛市住房公积金管理中心', 'government', 'restricted', 800000);
    // 2) 医保个人账户余额 → 受限资产，计入资产
    await presetAccount('医保个人账户', '青岛市医疗保障局', 'government', 'restricted', 120000);
    // 3) 社保卡金融账户 → 普通储蓄卡，独立计入资产
    await presetAccount('社保卡金融账户', '社保卡发卡银行', 'bank_card', 'safety', 50000);
    // 4) 养老等无余额资格 → 权益，balanceMinor 为 null，不计入资产
    const ent = await post(srv.port, '/api/v1/entitlements', {
      name: '职工基本养老保险', kind: 'social_security', jurisdiction: '青岛',
      status: '在缴', balanceMinor: null, valuationType: 'none', sourceRef: '青岛人社 App', asOf: '2026-08-31'
    });
    assert.strictEqual(ent.status, 201);
    assert.strictEqual(ent.json.item.balanceMinor, null, '无余额资格不得被写成 0');

    const overview = await request(srv.port, 'GET', '/api/v1/overview?asOf=2026-08-31');
    assert.strictEqual(overview.json.totalAssetsMinor, 970000, '8000 + 1200 + 500 元，权益不计入');
    assert.strictEqual(overview.json.pools.restrictedMinor, 920000, '公积金与医保余额进入受限资产池');
    assert.strictEqual(overview.json.pools.safetyMinor, 50000, '社保卡金融账户作为安全储备独立存在');

    const units = await request(srv.port, 'GET', '/api/v1/account-units');
    assert.strictEqual(units.json.items.length, 3, '三个余额单元各一条，不存在重复计数');

    const state = await request(srv.port, 'GET', '/api/v1/state');
    assert.strictEqual(state.json.assets.entitlements.length, 1);
    assert.strictEqual(state.json.assets.entitlements[0].jurisdiction, '青岛');
    assert.strictEqual(state.json.assets.entitlements[0].sourceRef, '青岛人社 App', '来源说明必须可维护');

    // 权益的参考金额（若填写）也不得进入任何资产池
    const ref = await post(srv.port, '/api/v1/entitlements', {
      name: '商业医疗险（参考）', kind: 'insurance', balanceMinor: 999999, valuationType: 'reference', asOf: '2026-08-31'
    });
    assert.strictEqual(ref.status, 201);
    const after = await request(srv.port, 'GET', '/api/v1/overview?asOf=2026-08-31');
    assert.strictEqual(after.json.totalAssetsMinor, 970000, '权益参考金额不得进入总资产');
  } finally {
    srv.close();
    ctx.close();
  }
});
