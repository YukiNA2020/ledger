/* Phase 3 资源写入与月度结账 API 测试（临时数据库，虚构数据）
 *
 * 对应 ACCEPTANCE：
 *   S3.1 机构—账户—币种子账户 —— 五类资源单条 upsert 落库、校验拒绝、未知账户 422、幂等更新
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

test('S3.1 机构→账户→子账户：三类资源可逐条落库并被 HTTP 直读', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const inst = await post(srv.port, '/api/v1/institutions', { name: '香港汇丰', kind: 'bank' });
    assert.strictEqual(inst.status, 201);
    assert.ok(inst.json.item.id, '机构应有 id');

    const acc = await post(srv.port, '/api/v1/accounts', {
      name: '汇丰港币户', institution: '香港汇丰', institutionKind: 'bank', kind: 'deposit', pool: 'safety', status: 'active'
    });
    assert.strictEqual(acc.status, 201);
    const accId = acc.json.item.id;

    const unit = await post(srv.port, '/api/v1/account-units', {
      accountId: accId, currency: 'HKD', balanceMinor: 123456, asOf: '2026-09-15', sourceType: 'manual'
    });
    assert.strictEqual(unit.status, 201);
    assert.strictEqual(unit.json.item.currency, 'HKD');
    assert.strictEqual(unit.json.item.balanceMinor, 123456);

    // HTTP 直读 + /state 聚合视图一致
    const accounts = await request(srv.port, 'GET', '/api/v1/accounts');
    assert.strictEqual(accounts.json.items.length, 1);
    assert.strictEqual(accounts.json.items[0].institution, '香港汇丰');
    const units = await request(srv.port, 'GET', '/api/v1/account-units');
    assert.strictEqual(units.json.items.length, 1);
    const state = await request(srv.port, 'GET', '/api/v1/state');
    assert.strictEqual(state.json.assets.assetAccounts.length, 1);
    assert.strictEqual(state.json.assets.assetUnits.length, 1);
    assert.strictEqual(state.json.assets.assetUnits[0].balanceMinor, 123456);
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

test('未实现的 Phase 4/5 写接口仍返回 501 并说明所属阶段', async () => {
  const ctx = setup('ledger-p3-');
  const srv = await startServer(ctx);
  try {
    const cases = [
      ['/api/v1/portfolio-openings', 'Phase 4'],
      ['/api/v1/market-data/refresh', 'Phase 4'],
      ['/api/v1/risk-assessments', 'Phase 5'],
      ['/api/v1/recommendations', 'Phase 5']
    ];
    for (const [path, phase] of cases) {
      const res = await post(srv.port, path, {});
      assert.strictEqual(res.status, 501, path + ' 应为 501');
      assert.ok(String(res.json.error.message).indexOf(phase) >= 0, path + ' 应说明所属阶段 ' + phase);
    }
  } finally {
    srv.close();
    ctx.close();
  }
});
