/* Phase 4E 估值下钻与收益归因 API 端到端测试（临时数据库，虚构数据）
 *
 * 对应 ACCEPTANCE.md S4E.1 的服务端侧链路（走真实 HTTP 入口，不绕过路由）：
 *   建账户 → 建标的并确认分类 → 期初 10 → 手动补价 → 结账
 *   → 8 月结账（无更早基准：整段不出归因）
 *   → 追加 9 月行情/汇率 → 9 月结账（基准 = 8 月快照，价格与汇率影响可复算）
 *   → 快照 payload 可重哈希复算、旧形状快照仍可读、归因不改动任何财务事实。
 *
 * 汇率历史的写入路径说明（这两条路径语义不同，是 4E 的显式边界）：
 *   - 自动/仓储 provider 路径（4D）按「币对 + 汇率日」写入并**保留历史行**，as-of 查询才有东西可查；
 *   - Phase 3 的手动汇率是「当前汇率」语义（D-034），一个币对只留一行。
 * 因此本文件用仓储 provider 路径造**历史**汇率事实，行情、结账与归因全部走真实 HTTP 入口；
 * 纯手动汇率下的历史缺失由最后一个用例专门锁定（显式 missing_start_fx，绝不插值）。
 *
 * 全部离线：只用手动补价与注入的历史汇率行，绝不访问真实行情网络（AGENTS.md）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

const api = require('../server/api');
const config = require('../server/config');
const R = require('../server/repository');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';
const NOW = '2026-09-30T09:00:00Z';

const A_OPEN = '2026-08-31'; // 期初快照日（同时是 8 月末）
const A_END = '2026-08-31';  // 8 月结账的数据截止日
const B_END = '2026-09-30';  // 9 月结账的数据截止日

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
    const req = http.request(
      { host: config.HOST, port: port, method: method, path: pathname, headers: headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, json: json });
        });
      }
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const post = (port, path, body, opts) => request(port, 'POST', path, body, opts);
const get = (port, path) => request(port, 'GET', path);

// 前置：券商账户 + 已确认分类的 USD 手工标的 + 期初 10 股
async function seedPortfolio(port) {
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
  const instrumentId = ins.json.item.id;
  const conf = await post(port, '/api/v1/instrument-confirmations', {
    instrumentId: instrumentId,
    assetClass: 'broad_equity',
    exposureMarket: 'US'
  });
  assert.strictEqual(conf.status, 201, '确认分类应成功');
  const opening = await post(port, '/api/v1/portfolio-openings', {
    accountId: acc.json.item.id,
    instrumentId: instrumentId,
    quantity: '10',
    asOf: A_OPEN
  });
  assert.strictEqual(opening.status, 201, '期初持仓应成功');
  return { accountId: acc.json.item.id, instrumentId: instrumentId };
}

async function addQuote(port, instrumentId, priceMinor, priceDate) {
  const res = await post(port, '/api/v1/quotes', {
    instrumentId: instrumentId,
    priceMinor: priceMinor,
    priceDate: priceDate
  });
  assert.strictEqual(res.status, 201, '手动补价应成功：' + JSON.stringify(res.json));
}

async function addManualFx(port, rateDecimal, rateDate) {
  const res = await post(port, '/api/v1/fx-rates', {
    base: 'USD',
    quote: 'CNY',
    rateDecimal: rateDecimal,
    rateDate: rateDate
  });
  assert.strictEqual(res.status, 201, '手动汇率应成功');
}

// 历史汇率事实：走仓储 provider 写入路径（按「币对 + 汇率日」累积，历史行保留）
function seedFxHistory(ctx, points) {
  points.forEach((p) => {
    const res = R.upsertProviderFxRate(
      ctx.db,
      {
        base: 'USD',
        quote: 'CNY',
        rateDecimal: p.rateDecimal,
        rateDate: p.rateDate,
        provider: 'fixture',
        status: 'ok'
      },
      { now: NOW }
    );
    assert.strictEqual(res.status, 'updated', '历史汇率事实应写入成功：' + JSON.stringify(res));
  });
}

async function closeMonth(port, month) {
  const res = await post(port, '/api/v1/monthly-closes', { month: month });
  assert.strictEqual(res.status, 201, '结账应成功：' + JSON.stringify(res.json));
  return res.json;
}

/* ============================== S4E.1 归因封存 ============================== */

test('S4E.1 结账快照封存归因（真实入口）：基准取上一份已结账快照，价格与汇率影响可复算', async (t) => {
  const ctx = setup('ledger-p4e-attr-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const { instrumentId } = await seedPortfolio(port);

  // 事实先备齐：8 月末价 50.00 / 汇率 7.00，9 月末价 55.00 / 汇率 7.10。
  // 汇率历史行按数据日累积（provider 路径），因此两条历史事实都在。
  await addQuote(port, instrumentId, 5000, A_END);
  await addQuote(port, instrumentId, 5500, B_END);
  seedFxHistory(ctx, [
    { rateDate: A_END, rateDecimal: '7.00' },
    { rateDate: B_END, rateDecimal: '7.10' }
  ]);
  const stateBefore = (await get(port, '/api/v1/state')).json.assets;

  const first = await closeMonth(port, '2026-08');

  // 没有比 2026-08 更早的结账记录 → 整段不出归因，而不是编一个基准
  assert.strictEqual(first.close.status, 'formal', '行情与汇率齐备时应能正式结账');
  assert.strictEqual(first.attribution.baseline, null);
  assert.strictEqual(first.attribution.unavailable, 'no_baseline');
  assert.deepStrictEqual(first.attribution.rows, []);
  assert.strictEqual(first.attribution.totals.rowCount, 0);

  const second = await closeMonth(port, '2026-09');

  const at = second.attribution;
  assert.strictEqual(at.unavailable, null, '有基准就必须给出归因');
  assert.strictEqual(at.asOf, B_END, '归因窗口是本月的截止日，不是今天');
  assert.strictEqual(at.baseline.asOf, A_END, '基准日 = 上一份快照的数据截止日');
  assert.strictEqual(at.baseline.month, '2026-08');
  assert.strictEqual(at.baseline.closeId, first.close.id);
  assert.strictEqual(at.baseline.snapshotId, first.snapshot.id);
  assert.strictEqual(at.baseline.payloadHash, first.snapshot.payloadHash, '基准必须能被哈希复核');
  assert.strictEqual(at.baseline.status, 'formal');

  assert.strictEqual(at.rows.length, 1);
  const row = at.rows[0];
  assert.strictEqual(row.startQuantity, '10');
  assert.strictEqual(row.endQuantity, '10');
  assert.strictEqual(row.startPriceMinor, 5000);
  assert.strictEqual(row.startPriceDate, A_END);
  assert.strictEqual(row.endPriceMinor, 5500);
  assert.strictEqual(row.endPriceDate, B_END);
  assert.strictEqual(row.startRateDecimal, '7.00');
  assert.strictEqual(row.startRateDate, A_END);
  assert.strictEqual(row.endRateDecimal, '7.10');
  assert.strictEqual(row.endRateDate, B_END);
  assert.strictEqual(row.startValueCnyMinor, 350000);
  assert.strictEqual(row.endValueCnyMinor, 390500);
  assert.strictEqual(row.valueChangeCnyMinor, 40500);
  assert.strictEqual(row.priceEffectCnyMinor, 35000);
  assert.strictEqual(row.fxEffectCnyMinor, 5500);
  assert.strictEqual(row.attributable, true);
  assert.deepStrictEqual(row.boundaries, []);
  assert.strictEqual(row.priceEffectCnyMinor + row.fxEffectCnyMinor, row.valueChangeCnyMinor);

  // 汇总恒等式：价格影响 + 汇率影响 + 未分解 = 总变化
  assert.strictEqual(at.totals.priceEffectCnyMinor, 35000);
  assert.strictEqual(at.totals.fxEffectCnyMinor, 5500);
  assert.strictEqual(at.totals.unattributedChangeCnyMinor, 0);
  assert.strictEqual(
    at.totals.priceEffectCnyMinor + at.totals.fxEffectCnyMinor + at.totals.unattributedChangeCnyMinor,
    at.totals.valueChangeCnyMinor
  );

  // 快照 payload 里必须封存同一份归因，且可重哈希复算
  const snap = await get(port, '/api/v1/close-snapshots/' + second.snapshot.id);
  assert.strictEqual(snap.status, 200);
  const payloadJson = snap.json.snapshot.payloadJson;
  assert.strictEqual(
    crypto.createHash('sha256').update(payloadJson).digest('hex'),
    snap.json.snapshot.payloadHash,
    'payloadJson 重新哈希必须等于封存哈希'
  );
  const payload = JSON.parse(payloadJson);
  assert.deepStrictEqual(payload.attribution.rows, at.rows, '快照里的归因与结账响应必须一致');
  assert.strictEqual(payload.attribution.baseline.snapshotId, first.snapshot.id);

  // 归因只是计算与封存：不得改动任何财务事实
  const stateAfter = (await get(port, '/api/v1/state')).json.assets;
  assert.deepStrictEqual(stateAfter, stateBefore, '结账与归因不得改动资产事实');
});

test('S4E.1 归因的时间窗口封闭：同事实重算逐字节一致；结账之后的行情与事件不进往期', async (t) => {
  const ctx = setup('ledger-p4e-window-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const { accountId, instrumentId } = await seedPortfolio(port);
  await addQuote(port, instrumentId, 5000, A_END);
  seedFxHistory(ctx, [{ rateDate: A_END, rateDecimal: '7.00' }]);
  await closeMonth(port, '2026-08');
  await addQuote(port, instrumentId, 5500, B_END);
  seedFxHistory(ctx, [{ rateDate: B_END, rateDecimal: '7.10' }]);
  const second = await closeMonth(port, '2026-09');

  // (1) 事实不变 → 重算必须逐字节一致（归因是纯函数，不看"今天是哪天"）
  const again = await closeMonth(port, '2026-09');
  assert.strictEqual(again.snapshot.payloadHash, second.snapshot.payloadHash);
  assert.deepStrictEqual(again.attribution, second.attribution);

  // (2) 结账之后才录入的 10 月行情/汇率/事件
  await addQuote(port, instrumentId, 6000, '2026-10-31');
  seedFxHistory(ctx, [{ rateDate: '2026-10-31', rateDecimal: '7.20' }]);
  const futureEvent = await post(port, '/api/v1/security-events', {
    accountId: accountId,
    instrumentId: instrumentId,
    eventType: 'buy',
    quantity: '5',
    priceMinor: 6000,
    occurredAt: '2026-10-15'
  });
  assert.strictEqual(futureEvent.status, 201, '10 月的事件应能录入');

  // 重算 9 月：4E 的归因必须完全不受影响（窗口封闭）
  const recomputed = await closeMonth(port, '2026-09');
  assert.deepStrictEqual(
    recomputed.attribution.rows,
    second.attribution.rows,
    '结账之后出现的行情/汇率/事件不得进入往期归因'
  );
  assert.strictEqual(recomputed.attribution.rows[0].endPriceMinor, 5500);
  assert.strictEqual(recomputed.attribution.rows[0].endPriceDate, B_END);
  assert.strictEqual(recomputed.attribution.rows[0].endRateDecimal, '7.10');
  assert.strictEqual(recomputed.attribution.rows[0].endQuantity, '10');
  assert.strictEqual(recomputed.attribution.totals.valueChangeCnyMinor, 40500);
  // 注意：快照里的 overview/checklist 走 Phase 3 既有口径（取"当前最新"行情），因此重算旧月份时
  // 这一部分会随最新行情变化 —— 这是被封存的 Phase 3 语义（D-034：读旧快照，而不是重算旧快照），
  // 4E 不改动它；4E 的归因部分按上面的断言是窗口封闭的。

  // 8 月同样不受影响
  const reAug = await closeMonth(port, '2026-08');
  assert.strictEqual(reAug.attribution.unavailable, 'no_baseline');
  assert.deepStrictEqual(reAug.attribution.rows, []);
});

test('S4E.1 旧形状快照（无 attribution 字段）仍可读、哈希可复核', async (t) => {
  const ctx = setup('ledger-p4e-legacy-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  // 4D 时代的快照形状：只有 month/asOf/status/overview/checklist/emergency，没有 attribution
  const legacyPayload = JSON.stringify({
    month: '2026-07',
    asOf: '2026-07-31',
    status: 'estimate',
    overview: { totalAssetsMinor: 123456, totalLiabilitiesMinor: 0, netWorthMinor: 123456 },
    checklist: {
      valuationStatus: 'estimate',
      canComplete: false,
      items: [{ code: 'quote_missing', detail: 'VOO', count: 1 }],
      facts: { units: [], liabilities: [], holdings: [], entitlements: [] }
    },
    emergencyCoverageMonths: null,
    emergency: { avgNecessaryMinor: null, coverageMonths: null, source: null, basis: null }
  });
  const legacyHash = crypto.createHash('sha256').update(legacyPayload).digest('hex');
  R.insertCloseSnapshot(ctx.db, {
    id: 'snaplegacy7',
    closeId: null,
    month: '2026-07',
    capturedAt: '2026-07-31T10:00:00Z',
    snapshotType: 'monthly_close',
    payloadJson: legacyPayload,
    payloadHash: legacyHash
  });

  const res = await get(port, '/api/v1/close-snapshots/snaplegacy7');
  assert.strictEqual(res.status, 200, '旧快照必须仍然读得出来');
  assert.strictEqual(res.json.snapshot.payloadJson, legacyPayload, '读取通道必须逐字节保真');
  assert.strictEqual(res.json.snapshot.payloadHash, legacyHash);
  assert.strictEqual(
    crypto.createHash('sha256').update(res.json.snapshot.payloadJson).digest('hex'),
    legacyHash,
    '旧快照的哈希仍可复核'
  );
  assert.strictEqual(
    res.json.snapshot.payload.attribution,
    undefined,
    '缺 4E 字段是合法形状，读取方必须容忍'
  );
  assert.strictEqual(res.json.snapshot.payload.overview.totalAssetsMinor, 123456);
});

test('S4E.1 归因不新增第二套"能不能给正式建议"的判定：缺行情时沿用既有 quote_missing 阻塞', async (t) => {
  const ctx = setup('ledger-p4e-blocked-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  await seedPortfolio(port);
  // 刻意不补价：持仓定不了价
  seedFxHistory(ctx, [
    { rateDate: A_END, rateDecimal: '7.00' },
    { rateDate: B_END, rateDecimal: '7.10' }
  ]);

  const first = await closeMonth(port, '2026-08');
  assert.strictEqual(first.close.status, 'estimate', '缺行情只能存估算');
  assert.strictEqual(first.close.canComplete, false);
  assert.ok(first.close.blockers.some((b) => b.code === 'quote_missing'));
  assert.strictEqual(first.attribution.valuation.canAdvise, false);
  assert.strictEqual(first.attribution.unavailable, 'no_baseline');

  const second = await closeMonth(port, '2026-09');
  assert.strictEqual(second.close.status, 'estimate');
  assert.strictEqual(second.attribution.valuation.canAdvise, false);
  const row = second.attribution.rows[0];
  assert.ok(row.boundaries.includes('missing_start_quote'));
  assert.ok(row.boundaries.includes('missing_end_quote'));
  assert.strictEqual(row.attributable, false);

  // 归因自己的边界码不得污染既有 blockers（没有第二套"正式/估算"判定）
  const codes = second.attribution.blockers.map((b) => b.code);
  assert.ok(codes.includes('quote_missing'));
  assert.ok(!codes.includes('missing_end_quote'));
  assert.ok(!codes.includes('missing_start_quote'));
  assert.ok(!codes.includes('no_baseline'));
});

test('S4E.1 纯手动汇率只有"当前一行"：历史期初汇率缺失，显式标注而不是插值', async (t) => {
  const ctx = setup('ledger-p4e-manualfx-');
  const srv = await startServer(ctx);
  t.after(() => srv.close().then(() => ctx.close()));
  const port = srv.port;

  const { instrumentId } = await seedPortfolio(port);
  await addQuote(port, instrumentId, 5000, A_END);
  // Phase 3 手动汇率：一个币对只保留一行（写第二天的就把 8 月的顶掉了）
  await addManualFx(port, '7.00', A_END);
  const first = await closeMonth(port, '2026-08');
  assert.strictEqual(first.close.status, 'formal');

  await addQuote(port, instrumentId, 5500, B_END);
  await addManualFx(port, '7.10', B_END);
  const fxRows = (await get(port, '/api/v1/fx-rates')).json.items;
  assert.strictEqual(fxRows.length, 1, '手动汇率是"当前汇率"语义：一个币对只有一行');
  assert.strictEqual(fxRows[0].rateDate, B_END);

  const second = await closeMonth(port, '2026-09');
  const row = second.attribution.rows[0];
  assert.strictEqual(row.endRateDecimal, '7.10');
  assert.strictEqual(row.endRateDate, B_END);
  assert.strictEqual(row.startRateDecimal, null, '历史期初汇率查不到就是查不到');
  assert.ok(row.boundaries.includes('missing_start_fx'));
  assert.strictEqual(row.attributable, false);
  assert.strictEqual(row.priceEffectCnyMinor, null);
  assert.strictEqual(row.fxEffectCnyMinor, null);
  assert.strictEqual(row.valueChangeCnyMinor, null);
  // 归因缺基准 ≠ 正式建议被阻止：这两件事由不同的机制负责
  assert.strictEqual(second.close.status, 'formal', '归因缺期初汇率不应把本期估值降级为估算');
  assert.strictEqual(second.attribution.valuation.canAdvise, true);
  assert.ok(!second.attribution.blockers.some((b) => b.code === 'missing_start_fx'));
});
