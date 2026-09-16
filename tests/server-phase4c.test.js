/* Phase 4C 持仓账本与证券事件 API 端到端测试（临时数据库，虚构数据）
 *
 * 对应 ACCEPTANCE.md S4C.1 的完整验收链路（走真实 HTTP 入口，不绕过路由）：
 *   建账户 → 建标的（manual → confirm）→ 期初 10 → 买入 2 → 卖出 1 → 分红
 *   → GET /holdings 推导数量 11 → txns 不被双写 → 总览估值与推导一致
 *   → PUT /state 往返保事件 → 备份恢复往返无损。
 * 另覆盖拒绝路径：重复事件、超额卖出（整体回滚）、未知引用、非法字段、重复期初。
 * 全部离线，不访问任何真实行情网络。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const api = require('../server/api');
const config = require('../server/config');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';
const NOW = '2026-09-15T08:00:00Z';

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
    startedAt: NOW,
    providerNow: () => NOW,
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = http.createServer(api.createHandlerEntry(ctx));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, config.HOST, resolve);
  });
  const port = server.address().port;
  ctx.port = port;
  return {
    port: port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function request(port, method, pathname, body, opts) {
  const o = opts || {};
  const headers = Object.assign(
    { 'X-Ledger-Token': TOKEN, Origin: 'http://127.0.0.1:' + port },
    o.headers || {}
  );
  let payload = null;
  if (body != null) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: config.HOST, port: port, method: method, path: pathname, headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const post = (port, path, body, opts) => request(port, 'POST', path, body, opts);
const get = (port, path) => request(port, 'GET', path);
const put = (port, path, body, opts) => request(port, 'PUT', path, body, opts);

// 主链路前置：账户 + 手工标的 + 确认分类，返回 { accountId, instrumentId }
async function seedAccountAndInstrument(port) {
  const acc = await post(port, '/api/v1/accounts', {
    name: '测试券商',
    kind: 'broker',
    pool: 'investable'
  });
  assert.strictEqual(acc.status, 201, '建账户应成功');
  const ins = await post(port, '/api/v1/instruments', {
    symbol: 'VOO',
    currency: 'USD',
    source: 'manual',
    name: '标普500 ETF'
  });
  assert.strictEqual(ins.status, 201, '手工建标的应成功');
  const confirm = await post(port, '/api/v1/instrument-confirmations', {
    instrumentId: ins.json.item.id,
    assetClass: 'broad_equity',
    exposureMarket: 'US'
  });
  assert.strictEqual(confirm.status, 201, '确认分类应成功');
  assert.strictEqual(confirm.json.item.classificationStatus, 'confirmed');
  return { accountId: acc.json.item.id, instrumentId: ins.json.item.id };
}

/* ============================== S4C.1 主链路 ============================== */

test('S4C.1 主链路：期初 10 → 买 2 → 卖 1 → 分红；持仓推导 11；txns 不被双写', async (t) => {
  const ctx = setup('ledger-p4c-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  // 1) 期初快照：suggested 期间不允许——标的已确认，无 warning
  const opening = await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId,
    instrumentId: instrumentId,
    quantity: '10',
    costMinor: 4500000,
    asOf: '2026-09-01'
  });
  assert.strictEqual(opening.status, 201);
  assert.strictEqual(opening.json.ok, true);
  assert.strictEqual(opening.json.warning, null);

  // 2) 事件：买 2 → 卖 1 → 分红
  const buy = await post(port, '/api/v1/security-events', {
    eventType: 'buy',
    accountId: accountId,
    instrumentId: instrumentId,
    quantity: '2',
    priceMinor: 500000,
    feeMinor: 100,
    occurredAt: '2026-09-05'
  });
  assert.strictEqual(buy.status, 201);
  assert.ok(buy.json.item.id, '服务端应生成事件 id');

  const sell = await post(port, '/api/v1/security-events', {
    eventType: 'sell',
    accountId: accountId,
    instrumentId: instrumentId,
    quantity: '1',
    priceMinor: 510000,
    occurredAt: '2026-09-10'
  });
  assert.strictEqual(sell.status, 201);

  const dividend = await post(port, '/api/v1/security-events', {
    eventType: 'dividend',
    accountId: accountId,
    instrumentId: instrumentId,
    amountMinor: 1500,
    occurredAt: '2026-09-12'
  });
  assert.strictEqual(dividend.status, 201);
  assert.strictEqual(dividend.json.item.quantity, null, '分红事件不携带数量');

  // 3) GET /holdings：推导数量 10 + 2 − 1 = 11
  const holdings = await get(port, '/api/v1/holdings');
  assert.strictEqual(holdings.status, 200);
  assert.strictEqual(holdings.json.items.length, 1);
  const h = holdings.json.items[0];
  assert.strictEqual(h.quantity, '11');
  assert.strictEqual(h.symbol, 'VOO');
  assert.strictEqual(h.openingId, opening.json.item.id);
  assert.strictEqual(h.lastEventAt, '2026-09-12');
  assert.deepStrictEqual(h.eventCounts, { buy: 1, sell: 1, dividend: 1, fee: 0 });

  // 4) 事件列表可溯源
  const events = await get(port, '/api/v1/security-events');
  assert.strictEqual(events.status, 200);
  assert.strictEqual(events.json.items.length, 3);
  const div = events.json.items.find((e) => e.eventType === 'dividend');
  assert.strictEqual(div.amountMinor, 1500);
  assert.strictEqual(div.currency, 'USD', '币种由标的推导');

  // 5) 事件绝不写 txns（不双重计入现金流）
  const state = await get(port, '/api/v1/state');
  assert.strictEqual(state.status, 200);
  assert.deepStrictEqual(state.json.txns, [], '证券事件不得进入现金流');

  return { port, accountId, instrumentId, stateJson: state.json };
});

test('S4C.1 未确认分类标的：允许录入持仓与事件，响应带阻塞 warning', async (t) => {
  const ctx = setup('ledger-p4c-warn-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  // 建第二个标的但不确认分类
  const ins2 = await post(port, '/api/v1/instruments', {
    symbol: 'QQQ',
    currency: 'USD',
    source: 'manual'
  });
  assert.strictEqual(ins2.status, 201);
  assert.strictEqual(ins2.json.item.classificationStatus, 'suggested');

  const opening = await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId,
    instrumentId: ins2.json.item.id,
    quantity: '5',
    asOf: '2026-09-01'
  });
  assert.strictEqual(opening.status, 201);
  assert.strictEqual(opening.json.warning, 'classification_unconfirmed');

  const ev = await post(port, '/api/v1/security-events', {
    eventType: 'buy',
    accountId: accountId,
    instrumentId: ins2.json.item.id,
    quantity: '1',
    occurredAt: '2026-09-05'
  });
  assert.strictEqual(ev.status, 201);
  assert.strictEqual(ev.json.warning, 'classification_unconfirmed');
});

/* ============================== 拒绝路径 ============================== */

test('重复事件：同 id 重放 → 409 duplicate_event，不静默吞', async (t) => {
  const ctx = setup('ledger-p4c-dup-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  const first = await post(port, '/api/v1/security-events', {
    id: 'ev-x1',
    eventType: 'buy',
    accountId: accountId,
    instrumentId: instrumentId,
    quantity: '2',
    occurredAt: '2026-09-05'
  });
  assert.strictEqual(first.status, 201);

  const replay = await post(port, '/api/v1/security-events', {
    id: 'ev-x1',
    eventType: 'buy',
    accountId: accountId,
    instrumentId: instrumentId,
    quantity: '2',
    occurredAt: '2026-09-05'
  });
  assert.strictEqual(replay.status, 409);
  assert.strictEqual(replay.json.error.code, 'duplicate_event');

  const events = await get(port, '/api/v1/security-events');
  assert.strictEqual(events.json.items.length, 1, '重放不得产生第二行');
});

test('Idempotency-Key：同一 key 重放返回首次响应，不重复写入', async (t) => {
  const ctx = setup('ledger-p4c-idem-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  const headers = { 'Idempotency-Key': 'idem-4c-1' };
  const first = await post(
    port,
    '/api/v1/security-events',
    { eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '3', occurredAt: '2026-09-05' },
    { headers: headers }
  );
  assert.strictEqual(first.status, 201);

  const replay = await post(
    port,
    '/api/v1/security-events',
    { eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '3', occurredAt: '2026-09-05' },
    { headers: headers }
  );
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.json.error, undefined);
  assert.strictEqual(first.json.item.id, replay.json.item.id, '回放首次响应');

  const events = await get(port, '/api/v1/security-events');
  assert.strictEqual(events.json.items.length, 1, '幂等重放不得产生第二行');
});

test('超额卖出 → 409 insufficient_holdings，事务整体回滚不留下半个事件', async (t) => {
  const ctx = setup('ledger-p4c-over-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId, instrumentId: instrumentId, quantity: '5', asOf: '2026-09-01'
  });

  const bad = await post(port, '/api/v1/security-events', {
    eventType: 'sell',
    accountId: accountId,
    instrumentId: instrumentId,
    quantity: '6',
    occurredAt: '2026-09-10'
  });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.json.error.code, 'insufficient_holdings');

  const events = await get(port, '/api/v1/security-events');
  assert.strictEqual(events.json.items.length, 0, '失败写入不得留下事件行');
});

test('时间线重放：先买 2 再卖 3 仍然超额（推导按 occurred_at 重放）', async (t) => {
  const ctx = setup('ledger-p4c-timeline-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId, instrumentId: instrumentId, quantity: '0.5', asOf: '2026-09-01'
  });
  await post(port, '/api/v1/security-events', {
    eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '2', occurredAt: '2026-09-03'
  });

  const bad = await post(port, '/api/v1/security-events', {
    eventType: 'sell', accountId: accountId, instrumentId: instrumentId, quantity: '3', occurredAt: '2026-09-10'
  });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.json.error.code, 'insufficient_holdings');
});

test('未知引用 → 422；非法字段 → 400（事件类型/数量/日期/金额口径）', async (t) => {
  const ctx = setup('ledger-p4c-invalid-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  const cases = [
    [{ eventType: 'buy', accountId: 'nope', instrumentId: instrumentId, quantity: '1', occurredAt: '2026-09-05' }, 422, 'unknown_account'],
    [{ eventType: 'buy', accountId: accountId, instrumentId: 'ins-nope', quantity: '1', occurredAt: '2026-09-05' }, 422, 'unknown_instrument'],
    [{ eventType: 'split', accountId: accountId, instrumentId: instrumentId, quantity: '1', occurredAt: '2026-09-05' }, 400, 'invalid_event_type'],
    [{ eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '-1', occurredAt: '2026-09-05' }, 400, 'invalid_quantity'],
    [{ eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: 'abc', occurredAt: '2026-09-05' }, 400, 'invalid_quantity'],
    [{ eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '1', occurredAt: '2026/09/05' }, 400, 'invalid_event_date'],
    [{ eventType: 'dividend', accountId: accountId, instrumentId: instrumentId, occurredAt: '2026-09-05' }, 400, 'invalid_event_amount'],
    [{ eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '1', amountMinor: 100, occurredAt: '2026-09-05' }, 400, 'invalid_event_amount']
  ];
  for (const [body, expectStatus, expectCode] of cases) {
    const res = await post(port, '/api/v1/security-events', body);
    assert.strictEqual(res.status, expectStatus, JSON.stringify(body));
    assert.strictEqual(res.json.error.code, expectCode, JSON.stringify(body));
  }

  // 期初快照：重复期初 409；非法数量 400；未知引用 422
  const ok = await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId, instrumentId: instrumentId, quantity: '5', asOf: '2026-09-01'
  });
  assert.strictEqual(ok.status, 201);
  const dupOpening = await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId, instrumentId: instrumentId, quantity: '6', asOf: '2026-09-02'
  });
  assert.strictEqual(dupOpening.status, 409);
  assert.strictEqual(dupOpening.json.error.code, 'duplicate_opening');

  const badQty = await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId, instrumentId: instrumentId, quantity: '0', asOf: '2026-09-01'
  });
  assert.strictEqual(badQty.status, 400);
  assert.strictEqual(badQty.json.error.code, 'invalid_quantity');

  const unknownIns = await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId, instrumentId: 'ins-nope', quantity: '1', asOf: '2026-09-01'
  });
  assert.strictEqual(unknownIns.status, 422);
  assert.strictEqual(unknownIns.json.error.code, 'unknown_instrument');
});

/* ============================== 全量往返与备份恢复 ============================== */

test('PUT /state 往返：事件无损；恢复后推导一致；总览估值与推导数量吻合', async (t) => {
  const ctx = setup('ledger-p4c-state-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId, instrumentId: instrumentId, quantity: '10', costMinor: 4500000, asOf: '2026-09-01'
  });
  await post(port, '/api/v1/security-events', {
    eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '2', occurredAt: '2026-09-05'
  });
  await post(port, '/api/v1/security-events', {
    eventType: 'sell', accountId: accountId, instrumentId: instrumentId, quantity: '1', occurredAt: '2026-09-08'
  });
  await post(port, '/api/v1/security-events', {
    eventType: 'fee', accountId: accountId, instrumentId: instrumentId, amountMinor: 200, occurredAt: '2026-09-08'
  });

  // GET /state → 注入一条报价 → PUT /state 全量往返（含 securityEvents 键）
  const before = await get(port, '/api/v1/state');
  assert.strictEqual(before.status, 200);
  const st = before.json;
  assert.strictEqual(st.assets.securityEvents.length, 3);
  st.assets.quotes.push({
    instrumentId: instrumentId,
    priceMinor: 500000,
    currency: 'USD',
    priceDate: '2026-09-15',
    provider: 'manual',
    status: 'ok'
  });
  st.assets.fxRates.push({
    base: 'USD', quote: 'CNY', rateDecimal: '7.20', rateDate: '2026-09-15', provider: 'manual', status: 'ok'
  });
  const putRes = await put(port, '/api/v1/state', { state: st });
  assert.strictEqual(putRes.status, 200);
  assert.strictEqual(putRes.json.ok, true);

  // 往返后事件与推导一致
  const after = await get(port, '/api/v1/state');
  assert.deepStrictEqual(after.json.assets.securityEvents, st.assets.securityEvents, '事件往返无损');
  const holdings = await get(port, '/api/v1/holdings');
  assert.strictEqual(holdings.json.items[0].quantity, '11');

  // 总览估值 = 11 股 × $5000.00 × 7.20 + 现金 0 = 396000 分
  const ov = await get(port, '/api/v1/overview');
  assert.strictEqual(ov.status, 200);
  assert.strictEqual(ov.json.totalAssetsMinor, 11 * 500000 * 7.2);
});

test('备份恢复往返：恢复后事件与推导数量还原', async (t) => {
  const ctx = setup('ledger-p4c-backup-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  await post(port, '/api/v1/portfolio-openings', {
    accountId: accountId, instrumentId: instrumentId, quantity: '10', asOf: '2026-09-01'
  });
  await post(port, '/api/v1/security-events', {
    eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '2', occurredAt: '2026-09-05'
  });

  // 手动备份（此时事件 1 条、推导 12）
  const backup = await post(port, '/api/v1/backups', {});
  assert.strictEqual(backup.status, 201);
  const backupName = backup.json.backup.name;

  // 备份后再写两条：卖出 2（清仓）+ 买入 5
  await post(port, '/api/v1/security-events', {
    eventType: 'sell', accountId: accountId, instrumentId: instrumentId, quantity: '2', occurredAt: '2026-09-08'
  });
  await post(port, '/api/v1/security-events', {
    eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '5', occurredAt: '2026-09-10'
  });
  let holdings = await get(port, '/api/v1/holdings');
  assert.strictEqual(holdings.json.items[0].quantity, '15');

  // 恢复到备份点
  const restore = await post(port, '/api/v1/restores', { file: backupName });
  assert.strictEqual(restore.status, 200);
  assert.strictEqual(restore.json.ok, true);

  const events = await get(port, '/api/v1/security-events');
  assert.strictEqual(events.json.items.length, 1, '恢复后事件回到备份点');
  holdings = await get(port, '/api/v1/holdings');
  assert.strictEqual(holdings.json.items[0].quantity, '12', '推导数量回到备份点');
});

test('全量 PUT /state 带非法事件时整体拒绝（与单条写入同一口径）', async (t) => {
  const ctx = setup('ledger-p4c-state-invalid-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;
  const { accountId, instrumentId } = await seedAccountAndInstrument(port);

  const state = await get(port, '/api/v1/state');
  const st = state.json;
  st.assets.securityEvents = [
    { id: 'ev-ok', eventType: 'buy', accountId: accountId, instrumentId: instrumentId, quantity: '1', occurredAt: '2026-09-05' },
    { id: 'ev-bad', eventType: 'lottery', accountId: accountId, instrumentId: instrumentId, quantity: '1', occurredAt: '2026-09-06' }
  ];
  const res = await put(port, '/api/v1/state', { state: st });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error.code, 'invalid_event_type');

  // 回滚后事件不得残留
  const after = await get(port, '/api/v1/state');
  assert.strictEqual(after.json.assets.securityEvents.length, 0);
});
