/* Phase 5C｜目标配置与认可标的映射｜服务端测试（临时数据库，虚构数据，真实 HTTP 入口）
 *
 * 对应 PHASE5_BREAKDOWN §6.4 的服务端部分：
 *   - POST /targets 只受理可选的生效日期，等级与比例一律由服务端按「当前有效评估 + 5A 冻结模板」派生；
 *     派生字段在入口 400 拒绝，无有效评估 / 已过期 / 记录不可复核分别给出可区分的稳定错误码；
 *   - 目标版本是追加式的：复评后生成新版本，旧版本逐字段保持原样；
 *   - GET /targets 与 /targets/current 两条读取路径都执行领域复核（被篡改的目标不冒充可用记录）；
 *   - /targets/current 的类别比例与 GET /overview 的同一遍估值逐分一致，缺行情/分类时沿用既有 blocker；
 *   - 认可标的只能引用已存在、分类已确认且类别一致的标的；整类替换保持用户顺序且幂等；
 *     行情 / 目录 provider 刷新不得加入、删除或改写用户映射；
 *   - 迁移 v9、PUT /state 全量闸、备份恢复往返与缺令牌写请求全部覆盖。
 * 全部离线：固定注入 today / nowIso，零真实网络（AGENTS.md）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');

const api = require('../server/api');
const config = require('../server/config');
const B = require('../server/backup');
const R = require('../server/repository');
const dbm = require('../server/db');
const M = require('../server/migrations');
const Domain = require('../js/domain.js');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';
const TODAY = '2026-09-21';
const ASSESSED = '2026-06-15';
const EXPIRY = '2027-06-15';
const NOW_ISO = '2026-09-21T08:00:00.000Z';
const CLASSES = Domain.RISK_CLASSES;

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
    startedAt: NOW_ISO,
    today: () => TODAY,
    nowIso: () => NOW_ISO,
    marketDataFetcher: { fx: require('../server/providers/fixture').getFxRates },
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = http.createServer(api.createHandlerEntry(ctx));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, config.HOST, resolve);
  });
  const port = server.address().port;
  ctx.port = port;
  return { port: port, close: () => new Promise((resolve) => server.close(resolve)) };
}

function request(port, method, pathname, opts) {
  const o = opts || {};
  const headers = Object.assign({ Origin: 'http://127.0.0.1:' + port },
    o.token === false ? {} : { 'X-Ledger-Token': TOKEN }, o.headers || {});
  let payload = null;
  if (o.body != null) {
    payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: config.HOST, port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json: json, text: text });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const post = (port, pathname, body, opts) => request(port, 'POST', pathname, Object.assign({ body }, opts || {}));
const get = (port, pathname, opts) => request(port, 'GET', pathname, opts);

/* ------------------------------ 事实构造 helper ------------------------------ */

const CAP = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'capacity');
const WIL = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'willingness');
const byScore = (q, s) => q.options.filter((o) => o.score === s)[0].id;

function clientAnswers(capScores, wilScores) {
  const rows = [];
  capScores.forEach((s, i) => rows.push({ questionId: CAP[i].id, optionId: byScore(CAP[i], s) }));
  wilScores.forEach((s, i) => rows.push({ questionId: WIL[i].id, optionId: byScore(WIL[i], s) }));
  return rows;
}

// L5（能力 15 / 意愿 12）与 L2（踩三条硬封顶）两份载荷
const HIGH = { answers: clientAnswers([3, 3, 3, 3, 3], [3, 3, 3, 3]), assessedAt: ASSESSED, reason: 'initial' };
// 复评用**更晚的评估日**：同一天 + 同一 createdAt 时，5B 的确定性排序以 id 升序收尾，
// 那样「哪一份是当前评估」将由随机 id 决定，测试意图（复评后指向新版）就不成立了。
const LOW = { answers: clientAnswers([0, 0, 3, 3, 0], [3, 3, 3, 3]), assessedAt: '2026-09-20', reason: 'income_change' };

async function submitAssessment(port, payload, idemKey) {
  const res = await post(port, '/api/v1/risk-assessments', payload, idemKey ? { headers: { 'Idempotency-Key': idemKey } } : {});
  assert.strictEqual(res.status, 201, JSON.stringify(res.json));
  return res.json.item;
}

// 投资池：现金 30 万 + USD 债基 10 万（汇率 7）+ 宽基权益 20 万 → 已知比例的估值事实
function investmentAssets() {
  const a = Domain.emptyAssets();
  a.assetAccounts = [
    { id: 'acc-cash', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: 'I' },
    { id: 'acc-broker', name: '券商户', kind: 'broker', pool: 'investable', institution: 'I' },
    { id: 'acc-safe', name: '应急金', kind: 'deposit', pool: 'safety', institution: 'I' }
  ];
  a.assetUnits = [
    { id: 'u-cny', accountId: 'acc-cash', currency: 'CNY', balanceMinor: 30000000, asOf: TODAY, sourceType: 'manual' },
    { id: 'u-safe', accountId: 'acc-safe', currency: 'CNY', balanceMinor: 50000000, asOf: TODAY, sourceType: 'manual' }
  ];
  a.instruments = [
    { id: 'ins-bond', symbol: 'BND', exchange: 'NASDAQ', currency: 'USD', name: '债基', instrumentType: 'etf', assetClass: 'fixed_income', exposureMarket: 'US', classificationStatus: 'confirmed' },
    { id: 'ins-voo', symbol: 'VOO', exchange: 'NYSE', currency: 'USD', name: '标普500', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'US', classificationStatus: 'confirmed' },
    { id: 'ins-vgt', symbol: 'VGT', exchange: 'NASDAQ', currency: 'USD', name: '宽基二号', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'US', classificationStatus: 'confirmed' },
    { id: 'ins-thm', symbol: 'THM', exchange: 'SSE', currency: 'CNY', name: '主题基金', instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'suggested' }
  ];
  a.holdings = [
    { id: 'h-bond', accountId: 'acc-broker', instrumentId: 'ins-bond', quantity: '1428.5714', costMinor: 10000000, asOf: TODAY },
    { id: 'h-voo', accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '2000', costMinor: 20000000, asOf: TODAY }
  ];
  a.quotes = [
    { instrumentId: 'ins-bond', priceMinor: 7000, currency: 'USD', priceDate: TODAY, provider: 'manual', status: 'ok' },
    { instrumentId: 'ins-voo', priceMinor: 10000, currency: 'USD', priceDate: TODAY, provider: 'manual', status: 'ok' }
  ];
  a.fxRates = [{ base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: TODAY, provider: 'manual', status: 'ok' }];
  return a;
}

async function seedState(port, assets) {
  const state = await get(port, '/api/v1/state');
  const next = state.json;
  next.assets = assets || investmentAssets();
  const res = await request(port, 'PUT', '/api/v1/state', { body: { state: next } });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  return next;
}

/* ================= 1. 目标生成：服务端派生是唯一口径 ================= */

test('POST /targets：只受理生效日期，等级与比例由服务端按冻结模板派生', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    const item = await submitAssessment(srv.port, HIGH);
    assert.strictEqual(item.ceiling, 5, '前置：该评估的上限为 L5');

    // 反例：载荷里出现任何派生字段都在入口拒绝，且不落库
    const forged = await post(srv.port, '/api/v1/targets', { level: 5, classes: {} });
    assert.strictEqual(forged.status, 400);
    assert.strictEqual(forged.json.error.code, 'invalid_target_payload');
    assert.ok(!/level/.test(forged.json.error.message), '错误说明不得回显输入字段名');
    assert.deepStrictEqual((await get(srv.port, '/api/v1/targets')).json.items, []);

    // 非对象 JSON 不能被折叠成空对象；否则 null/数组/字符串会意外生成一个正式目标版本。
    for (const raw of ['null', '[]', '"bad"', '42']) {
      const malformed = await request(srv.port, 'POST', '/api/v1/targets', { body: raw });
      assert.strictEqual(malformed.status, 400, raw + ' 必须在入口拒绝');
      assert.strictEqual(malformed.json.error.code, 'invalid_target_payload');
    }
    assert.deepStrictEqual((await get(srv.port, '/api/v1/targets')).json.items, [],
      '非对象载荷不得产生目标事实');

    const created = await post(srv.port, '/api/v1/targets', {});
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    assert.strictEqual(created.json.created, true);
    const t = created.json.item;
    assert.match(t.id, /^at-[0-9a-f]{16}$/);
    assert.strictEqual(t.createdAt, NOW_ISO);
    assert.strictEqual(t.level, 5);
    assert.strictEqual(t.templateVersion, Domain.RISK_TARGET_VERSION);
    assert.strictEqual(t.ruleVersion, Domain.RISK_RULE_VERSION);
    assert.strictEqual(t.assessmentId, item.id);
    assert.strictEqual(t.assessedAt, ASSESSED);
    assert.strictEqual(t.assessmentExpiry, EXPIRY);
    assert.strictEqual(t.effectiveFrom, TODAY, '缺省生效日期 = 服务端判定日（不采信客户端时钟）');
    assert.deepStrictEqual(t.classes, Domain.targetTemplateForLevel(5).classes, '比例必须等于 5A 冻结模板');
    assert.strictEqual(CLASSES.reduce((s, k) => s + t.classes[k].targetBps, 0), Domain.BPS_TOTAL);

    // 自然键重复（同一评估 + 同一模板版本 + 同一生效日）不追加第二行
    const again = await post(srv.port, '/api/v1/targets', {});
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.created, false);
    assert.strictEqual(again.json.item.id, t.id, '重复请求返回同一版本，绝不覆盖历史');
    const list = await get(srv.port, '/api/v1/targets');
    assert.strictEqual(list.json.items.length, 1);
    assert.strictEqual(list.json.total, 1);

    const state = await get(srv.port, '/api/v1/state');
    assert.ok(Array.isArray(state.json.allocationTargets), 'allocationTargets 必须是 /state 顶层键');
    assert.ok(Array.isArray(state.json.approvedInstruments), 'approvedInstruments 必须是 /state 顶层键');
    assert.deepStrictEqual(state.json.allocationTargets, [t]);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('生成前置：无有效评估 / 已过期 / 记录不可复核 给出三种可区分的错误', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    const none = await post(srv.port, '/api/v1/targets', {});
    assert.strictEqual(none.status, 409);
    assert.strictEqual(none.json.error.code, 'no_valid_assessment');

    await submitAssessment(srv.port, HIGH);
    // 直接把评估改成已过期（等价于时间推进到到期日之后），必须指向复评而不是生成
    dbm.run(ctx.db, 'UPDATE risk_assessments SET assessed_at = ?, expiry = ? WHERE id = (SELECT id FROM risk_assessments LIMIT 1)',
      ['2020-01-01', '2020-12-31']);
    const expired = await post(srv.port, '/api/v1/targets', {});
    assert.strictEqual(expired.status, 409);
    assert.strictEqual(expired.json.error.code, 'assessment_expired');
    assert.strictEqual((await get(srv.port, '/api/v1/targets')).json.items.length, 0, '过期评估不得生成新目标');

    const badDate = await post(srv.port, '/api/v1/targets', { effectiveFrom: '2026-02-30' });
    assert.strictEqual(badDate.status, 400);
    assert.strictEqual(badDate.json.error.code, 'invalid_effective_date');
    const badDate2 = await post(srv.port, '/api/v1/targets', { effectiveFrom: 'not-a-date' });
    assert.strictEqual(badDate2.status, 400);
    assert.strictEqual(badDate2.json.error.code, 'invalid_effective_date');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('追加式版本：复评生成新版本，旧目标逐字段不变；幂等键重放不追加', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    const first = await submitAssessment(srv.port, HIGH);
    const t1 = (await post(srv.port, '/api/v1/targets', { effectiveFrom: '2026-07-01' })).json.item;
    const snapshotT1 = JSON.stringify(t1);

    // 复评（能力被硬封顶压到 L2）后生成新版本：引用新评估、上限与模板同时下移
    const second = await submitAssessment(srv.port, LOW);
    assert.strictEqual(second.ceiling, 2, '前置：复评上限为 L2');
    const t2res = await post(srv.port, '/api/v1/targets', {});
    assert.strictEqual(t2res.status, 201);
    const t2 = t2res.json.item;
    assert.notStrictEqual(t2.id, t1.id);
    assert.strictEqual(t2.level, 2);
    assert.strictEqual(t2.assessmentId, second.id);
    assert.deepStrictEqual(t2.classes, Domain.targetTemplateForLevel(2).classes);

    const list = await get(srv.port, '/api/v1/targets');
    assert.strictEqual(list.json.items.length, 2);
    assert.strictEqual(JSON.stringify(list.json.items[1]), snapshotT1, '旧目标版本必须逐字段保持原样（不回写）');
    assert.deepStrictEqual(list.json.items.map((x) => x.id), [t2.id, t1.id], 'effectiveFrom 降序');

    // 当前生效目标指向新版本；旧版本仍在历史里可读
    const cur = await get(srv.port, '/api/v1/targets/current');
    assert.strictEqual(cur.json.status, 'current');
    assert.strictEqual(cur.json.target.id, t2.id);
    assert.strictEqual(cur.json.assessment.id, second.id);

    // 幂等键：同键同载荷回放不追加，同键不同载荷 409
    const idem = await post(srv.port, '/api/v1/targets', { effectiveFrom: '2026-09-20' }, { headers: { 'Idempotency-Key': 'k-1' } });
    assert.strictEqual(idem.status, 201);
    const replay = await post(srv.port, '/api/v1/targets', { effectiveFrom: '2026-09-20' }, { headers: { 'Idempotency-Key': 'k-1' } });
    assert.strictEqual(replay.headers['x-ledger-idempotent'], 'replay');
    assert.strictEqual(JSON.stringify(replay.json), JSON.stringify(idem.json));
    const conflict = await post(srv.port, '/api/v1/targets', { effectiveFrom: '2026-08-01' }, { headers: { 'Idempotency-Key': 'k-1' } });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.json.error.code, 'idempotency_conflict');
    assert.strictEqual((await get(srv.port, '/api/v1/targets')).json.items.length, 3, '幂等回放与冲突都不得追加目标');
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 2. 读取即复核 ================= */

test('篡改目标派生值：列表过滤并留痕，current 显式拒绝使用', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    await submitAssessment(srv.port, HIGH);
    const t = (await post(srv.port, '/api/v1/targets', {})).json.item;

    dbm.run(ctx.db, 'UPDATE allocation_targets SET level = 1 WHERE id = ?', [t.id]);
    const list = await get(srv.port, '/api/v1/targets');
    assert.deepStrictEqual(list.json.items, [], '等级被改写的目标不得冒充可用记录');
    assert.strictEqual(list.json.invalidCount, 1);
    assert.strictEqual(list.json.total, 1);
    const cur = await get(srv.port, '/api/v1/targets/current');
    assert.strictEqual(cur.status, 200);
    assert.strictEqual(cur.json.status, 'invalid_records', '当前生效判定必须区分「记录不可解析」');
    assert.strictEqual(cur.json.target, null);
    assert.strictEqual(cur.json.allocation, null);

    // 比例被改写（等级仍对）同样挡下：同版本偷换比例在复核处失败
    dbm.run(ctx.db, 'UPDATE allocation_targets SET level = 5, classes_json = ? WHERE id = ?',
      [JSON.stringify(Object.assign({}, t.classes, { cash: { minBps: 0, targetBps: 10000, maxBps: 10000 } })), t.id]);
    assert.strictEqual((await get(srv.port, '/api/v1/targets')).json.invalidCount, 1);

    // 评估侧被改写（上限变了但目标仍指向旧模板）→ 交叉核对不一致，显式 409
    dbm.run(ctx.db, 'UPDATE allocation_targets SET classes_json = ? WHERE id = ?', [JSON.stringify(t.classes), t.id]);
    const fresh = await get(srv.port, '/api/v1/targets');
    assert.strictEqual(fresh.json.items.length, 1, '前置：目标已复原');
    const cur2 = await get(srv.port, '/api/v1/targets/current');
    assert.strictEqual(cur2.json.status, 'current');
    dbm.run(ctx.db, "UPDATE instruments SET asset_class = 'other' WHERE symbol = 'VOO'");
    assert.strictEqual((await get(srv.port, '/api/v1/targets/current')).json.status, 'current',
      '标的类别变化不影响目标本身的有效性（目标只依赖评估与模板）');
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 3. 当前配置与偏离：与 Phase 4 估值同一遍 ================= */

test('GET /targets/current：类别比例与 /overview 逐分一致，缺分类时沿用既有 blocker', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    await submitAssessment(srv.port, HIGH);
    const t = (await post(srv.port, '/api/v1/targets', {})).json.item;
    await seedState(srv.port);

    const ov = await get(srv.port, '/api/v1/overview');
    assert.strictEqual(ov.status, 200);
    const cur = await get(srv.port, '/api/v1/targets/current');
    assert.strictEqual(cur.status, 200, JSON.stringify(cur.json));
    assert.strictEqual(cur.json.status, 'current');
    assert.strictEqual(cur.json.target.id, t.id);

    const a = cur.json.allocation;
    assert.strictEqual(a.status, 'ok');
    assert.strictEqual(a.investableTotalMinor, ov.json.pools.investableMinor, '投资池总额与总览逐分一致');
    assert.strictEqual(a.classes.reduce((sum, c) => sum + c.pctBps, 0), Domain.BPS_TOTAL, 'ΣpctBps 精确守恒');
    CLASSES.forEach((k) => {
      const fromOv = ov.json.riskClasses.filter((x) => x.assetClass === k)[0];
      const row = a.classes.filter((x) => x.assetClass === k)[0];
      assert.strictEqual(row.valueMinor, fromOv.valueMinor, k + ' 金额必须来自同一遍估值');
      assert.strictEqual(row.minBps, t.classes[k].minBps, k + ' 区间来自冻结模板');
      assert.strictEqual(row.deviationBps, row.pctBps - t.classes[k].targetBps);
      assert.ok(Domain.TOLERANCE_BANDS.indexOf(row.band) >= 0);
      // 端点含入：区间内 ⇔ min ≤ pct ≤ max（唯一归属）
      assert.strictEqual(row.band, row.pctBps < row.minBps ? 'below_min' : (row.pctBps > row.maxBps ? 'above_max' : 'within'));
    });
    // 该场景：现金 30% / 固收 70%×… 核对具体数字，防止「比例守恒但值错」
    assert.strictEqual(a.classes.filter((x) => x.assetClass === 'cash')[0].valueMinor, 30000000);
    assert.strictEqual(a.classes.filter((x) => x.assetClass === 'fixed_income')[0].valueMinor, 70000000);
    assert.strictEqual(a.classes.filter((x) => x.assetClass === 'broad_equity')[0].valueMinor, 140000000);
    assert.strictEqual(cur.json.versions.targetVersion, Domain.RISK_TARGET_VERSION);

    // 缺分类的持仓：总览与 5C 给出同一批 blocker，且 canAdvise 由总览独占
    const withSuggested = investmentAssets();
    withSuggested.holdings.push({ id: 'h-thm', accountId: 'acc-broker', instrumentId: 'ins-thm', quantity: '1000', costMinor: 5000000, asOf: TODAY });
    withSuggested.quotes.push({ instrumentId: 'ins-thm', priceMinor: 5000, currency: 'CNY', priceDate: TODAY, provider: 'manual', status: 'ok' });
    await seedState(srv.port, withSuggested);
    const ov2 = await get(srv.port, '/api/v1/overview');
    const cur2 = await get(srv.port, '/api/v1/targets/current');
    assert.strictEqual(cur2.json.allocation.canAdvise, ov2.json.canAdvise);
    assert.strictEqual(cur2.json.allocation.canAdvise, false, '前置：分类未确认应挡住正式口径');
    assert.ok(cur2.json.allocation.blockers.some((b) => b.code === 'classification_unconfirmed'));
    const codesOf = (list) => list.map((b) => b.code + '|' + b.detail).sort().join(',');
    assert.strictEqual(codesOf(cur2.json.allocation.blockers), codesOf(ov2.json.blockers), 'blocker 集合必须与总览逐字相同（不另写一套）');

    // 非法 asOf 显式 400，不静默回退到今天（沿用 G5B-5 口径）
    for (const bad of ['not-a-date', '2027-02-30']) {
      const r = await get(srv.port, '/api/v1/targets/current?asOf=' + bad);
      assert.strictEqual(r.status, 400, bad + ' 必须被拒绝');
      assert.strictEqual(r.json.error.code, 'invalid_assessment_date');
    }
    // 预览到评估到期日之后：目标失效但不删数据
    const future = await get(srv.port, '/api/v1/targets/current?asOf=2027-07-01');
    assert.strictEqual(future.status, 200);
    assert.strictEqual(future.json.status, 'no_assessment');
    assert.strictEqual(future.json.assessment, null);
    assert.strictEqual((await get(srv.port, '/api/v1/targets')).json.items.length, 1, '预览不得改动任何数据');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('投资池为 0 时 current 显式给出 no_investable，不显示成「全部在区间内」', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    await submitAssessment(srv.port, HIGH);
    await post(srv.port, '/api/v1/targets', {});
    const empty = Domain.emptyAssets();
    await seedState(srv.port, empty);
    const cur = await get(srv.port, '/api/v1/targets/current');
    assert.strictEqual(cur.status, 200);
    assert.strictEqual(cur.json.allocation.status, 'no_investable');
    assert.strictEqual(cur.json.allocation.investableTotalMinor, 0);
    cur.json.allocation.classes.forEach((c) => {
      assert.strictEqual(c.pctBps, null);
      assert.strictEqual(c.band, null);
    });
    // 缺映射仍如实报告（目标比例 > 0 而没有任何认可标的）
    assert.deepStrictEqual(cur.json.missingClasses, CLASSES.filter((k) => Domain.targetTemplateForLevel(5).classes[k].targetBps > 0));
    assert.strictEqual(cur.json.mapping.total, 0);
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 4. 认可标的映射：用户判断，引用必须成立 ================= */

test('认可标的：只接受已存在、分类已确认且类别一致的标的；整类替换保持顺序且幂等', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    await submitAssessment(srv.port, HIGH);
    await post(srv.port, '/api/v1/targets', {});
    await seedState(srv.port);

    const cases = [
      ['标的不存在', { assetClass: 'broad_equity', instrumentIds: ['ins-ghost'] }, 422, 'unknown_instrument'],
      ['分类未确认', { assetClass: 'theme_equity', instrumentIds: ['ins-thm'] }, 422, 'classification_unconfirmed'],
      ['类别与标的冲突', { assetClass: 'cash', instrumentIds: ['ins-voo'] }, 422, 'class_mismatch'],
      ['词表外类别', { assetClass: 'crypto', instrumentIds: ['ins-voo'] }, 400, 'invalid_mapping_payload'],
      ['派生字段混入', { assetClass: 'cash', instrumentIds: [], level: 5 }, 400, 'invalid_mapping_payload'],
      ['不存在的现金标的', { assetClass: 'cash', instrumentIds: ['ins-none'] }, 422, 'unknown_instrument']
    ];
    for (const [label, body, status, code] of cases) {
      const r = await post(srv.port, '/api/v1/approved-instruments', body);
      assert.strictEqual(r.status, status, label + ' → ' + JSON.stringify(r.json));
      assert.strictEqual(r.json.error.code, code, label + ' 错误码不符');
    }
    assert.strictEqual((await get(srv.port, '/api/v1/approved-instruments')).json.total, 0, '非法写入不得落库');

    // 多个候选 + 用户顺序：宽基权益先 VOO 再加一只（这里用同一只的重复被拒后改两只）
    const first = await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['ins-voo'] });
    assert.strictEqual(first.status, 200, JSON.stringify(first.json));
    assert.deepStrictEqual(first.json.items.map((r) => r.instrumentId), ['ins-voo']);
    const idOfVoo = first.json.items[0].id;

    const view = await get(srv.port, '/api/v1/approved-instruments');
    assert.strictEqual(view.json.rows[0].status, 'ok');
    assert.strictEqual(view.json.validCount, 1);
    assert.strictEqual(view.json.rows[0].symbol, 'VOO', '读取视图带上标的可识别信息，页面不再自己 join');

    // 幂等：同一份清单重复提交得到同一批行与同一批 id（provider 或用户重试都不产生漂移）
    const repeat = await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['ins-voo'] });
    assert.deepStrictEqual(repeat.json.items, first.json.items, '重复提交同一清单不得改变 id 或 created_at');

    ctx.nowIso = () => '2026-09-21T09:00:00.000Z';
    const repeatLater = await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['ins-voo'] });
    assert.deepStrictEqual(repeatLater.json.items, first.json.items,
      '即使服务端时钟推进，内容未变的重复提交也不得改写 updatedAt');

    // 一个标的只能属于一个类别：跨类别冲突显式拒绝，不静默搬移用户判断
    const cross = await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'theme_equity', instrumentIds: ['ins-thm'] });
    assert.strictEqual(cross.status, 422, '前置：先确认分类才能引用');
    dbm.run(ctx.db, "UPDATE instruments SET classification_status = 'confirmed' WHERE id = 'ins-thm'");
    const move = await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'cash', instrumentIds: ['ins-voo'] });
    assert.strictEqual(move.status, 422);
    assert.strictEqual(move.json.error.code, 'class_mismatch');
    assert.strictEqual((await get(srv.port, '/api/v1/approved-instruments')).json.rows[0].instrumentId, 'ins-voo',
      '被拒绝的跨类别写入不得动过既有映射');

    // 类别内两行换位：position 唯一约束不得让「互换」在语句之间撞车（wiring 复现过的回归）
    const two = await post(srv.port, '/api/v1/approved-instruments',
      { assetClass: 'broad_equity', instrumentIds: ['ins-voo', 'ins-vgt'] });
    assert.strictEqual(two.status, 200, JSON.stringify(two.json));
    assert.deepStrictEqual(two.json.items.map((r) => [r.instrumentId, r.position]),
      [['ins-voo', 0], ['ins-vgt', 1]], '提交顺序即用户顺序');
    ctx.nowIso = () => '2026-09-21T10:00:00.000Z';
    const swap = await post(srv.port, '/api/v1/approved-instruments',
      { assetClass: 'broad_equity', instrumentIds: ['ins-vgt', 'ins-voo'] });
    assert.strictEqual(swap.status, 200, JSON.stringify(swap.json));
    assert.deepStrictEqual(swap.json.items.map((r) => [r.instrumentId, r.position]),
      [['ins-vgt', 0], ['ins-voo', 1]], '换位必须整体生效，不被类别内唯一顺序约束挡下');
    assert.deepStrictEqual(swap.json.items.map((r) => r.createdAt),
      ['2026-09-21T09:00:00.000Z', NOW_ISO],
      '换位只改 position，不得重建行的创建时间');
    assert.deepStrictEqual(swap.json.items.map((r) => r.updatedAt),
      ['2026-09-21T10:00:00.000Z', '2026-09-21T10:00:00.000Z'],
      '位置变化时才更新时间');
    assert.deepStrictEqual((await get(srv.port, '/api/v1/approved-instruments')).json.rows.map((r) => r.instrumentId),
      ['ins-vgt', 'ins-voo']);

    // 清空整类是合法的用户判断
    const cleared = await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'broad_equity', instrumentIds: [] });
    assert.strictEqual(cleared.status, 200);
    assert.deepStrictEqual(cleared.json.items, []);
    assert.strictEqual(idOfVoo && (await get(srv.port, '/api/v1/approved-instruments')).json.total, 0);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('provider 刷新与目录写入不得加入、删除或改写用户认可映射', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    await submitAssessment(srv.port, HIGH);
    await post(srv.port, '/api/v1/targets', {});
    await seedState(srv.port);
    await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['ins-voo'] });
    await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'fixed_income', instrumentIds: ['ins-bond'] });
    const before = await get(srv.port, '/api/v1/approved-instruments');
    assert.strictEqual(before.json.total, 2);

    // 行情 / 汇率刷新（受 D-038 门禁默认关闭 → skipped，且无论如何不碰映射表）
    const refresh = await post(srv.port, '/api/v1/market-data/refresh', { scopes: ['quotes', 'fx'] });
    assert.strictEqual(refresh.status, 200);
    // 目录 provider 建立 / 确认同类标的（参考数据可能带类别建议）
    const created = await post(srv.port, '/api/v1/instruments', { symbol: 'VOO', exchange: 'NYSE', currency: 'USD', name: 'Vanguard S&P 500 ETF' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json).slice(0, 200));
    assert.ok(created.json.duplicated === true || created.json.item, 'provider 路径只补参考字段，分类仍是用户判断');

    const after = await get(srv.port, '/api/v1/approved-instruments');
    assert.deepStrictEqual(after.json.rows, before.json.rows, '刷新与目录写入都不得改变用户映射');

    // 分类被外部改回 suggested 时：映射行保持原样并显式报失效引用，不自动删除
    dbm.run(ctx.db, "UPDATE instruments SET classification_status = 'suggested' WHERE id = 'ins-voo'");
    const stale = await get(srv.port, '/api/v1/approved-instruments');
    assert.strictEqual(stale.json.total, 2, '失效引用不得被静默丢行');
    const voo = stale.json.rows.filter((r) => r.instrumentId === 'ins-voo')[0];
    assert.strictEqual(voo.status, 'invalid');
    assert.deepStrictEqual(voo.issues, ['classification_unconfirmed']);
    assert.strictEqual(stale.json.issueCount, 1);
    const cur = await get(srv.port, '/api/v1/targets/current');
    assert.ok(cur.json.missingClasses.indexOf('broad_equity') >= 0, '失效引用等同于该类别缺映射');
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 5. 全量写入 / 备份恢复 / 边界 ================= */

async function collectCompanion(port) {
  const s = await get(port, '/api/v1/state');
  return { riskAssessments: s.json.riskAssessments, allocationTargets: s.json.allocationTargets, approvedInstruments: s.json.approvedInstruments };
}

test('PUT /state：目标与映射逐条复核；伪造或引用缺失整体回滚；缺键清空', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    await submitAssessment(srv.port, HIGH);
    const t = (await post(srv.port, '/api/v1/targets', {})).json.item;
    await seedState(srv.port);
    await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['ins-voo'] });
    const base = await collectCompanion(srv.port);
    assert.strictEqual(base.allocationTargets.length, 1);
    assert.strictEqual(base.approvedInstruments.length, 1);

    // 合法往返：整份集合原样写回，逐字段不变
    const ok = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: Object.assign((await get(srv.port, '/api/v1/state')).json, base) } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
    assert.deepStrictEqual((await collectCompanion(srv.port)).allocationTargets, base.allocationTargets);

    // 伪造目标派生值 → 整体拒绝且原数据不动
    const forged = JSON.parse(JSON.stringify(base));
    forged.allocationTargets[0].classes.cash = { minBps: 0, targetBps: 10000, maxBps: 10000 };
    const bad = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: Object.assign((await get(srv.port, '/api/v1/state')).json, forged) } });
    assert.strictEqual(bad.status, 400);
    assert.ok(/invalid_target_template|invalid_proportion/.test(bad.json.error.code), bad.json.error.code);
    assert.deepStrictEqual(await collectCompanion(srv.port), base, '被拒绝的全量写入不得改动任何事实');

    // 目标引用不存在的评估 → 显式 422（不是 500，也不静默丢行）
    const orphan = JSON.parse(JSON.stringify(base));
    orphan.allocationTargets[0].assessmentId = 'ra-ghost';
    const badRef = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: Object.assign((await get(srv.port, '/api/v1/state')).json, orphan) } });
    assert.strictEqual(badRef.status, 422, JSON.stringify(badRef.json));
    assert.strictEqual(badRef.json.error.code, 'invalid_assessment_ref');

    // 映射引用不存在的标的 → 拒绝
    const badMap = JSON.parse(JSON.stringify(base));
    badMap.approvedInstruments[0].instrumentId = 'ins-ghost';
    const badMapRes = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: Object.assign((await get(srv.port, '/api/v1/state')).json, badMap) } });
    assert.strictEqual(badMapRes.status, 422);
    assert.strictEqual(badMapRes.json.error.code, 'unknown_instrument');

    // 同一自然键两个版本 / 同一标的两条映射 → 拒绝
    const dupTarget = JSON.parse(JSON.stringify(base));
    dupTarget.allocationTargets.push(Object.assign({}, dupTarget.allocationTargets[0], { id: 'at-other' }));
    const dupRes = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: Object.assign((await get(srv.port, '/api/v1/state')).json, dupTarget) } });
    assert.strictEqual(dupRes.json.error.code, 'duplicate_target');
    const dupMap = JSON.parse(JSON.stringify(base));
    dupMap.approvedInstruments.push(Object.assign({}, dupMap.approvedInstruments[0], { id: 'aim-other', position: 1 }));
    const dupMapRes = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: Object.assign((await get(srv.port, '/api/v1/state')).json, dupMap) } });
    assert.strictEqual(dupMapRes.json.error.code, 'instrument_already_mapped');

    // 缺键清空（旧备份恢复语义，与 5B 同一口径）
    const stripped = await get(srv.port, '/api/v1/state');
    const s = stripped.json;
    delete s.allocationTargets;
    delete s.approvedInstruments;
    const cleared = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: s } });
    assert.strictEqual(cleared.status, 200);
    const after = await collectCompanion(srv.port);
    assert.deepStrictEqual(after.allocationTargets, []);
    assert.deepStrictEqual(after.approvedInstruments, []);
    assert.strictEqual(after.riskAssessments.length, 1, '未提到的集合保持原样');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('PUT /state：页面保存由服务端事务内保留缺失集合，不覆盖并发追加或映射更新', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    await submitAssessment(srv.port, HIGH);
    await post(srv.port, '/api/v1/targets', {});
    await seedState(srv.port);
    await post(srv.port, '/api/v1/approved-instruments', {
      assetClass: 'broad_equity', instrumentIds: ['ins-voo']
    });

    // 模拟页面早先取得的五键状态。旧实现会先 GET 三集合，再用这份旧快照 PUT 回去。
    const stalePageState = (await get(srv.port, '/api/v1/state')).json;
    delete stalePageState.riskAssessments;
    delete stalePageState.allocationTargets;
    delete stalePageState.approvedInstruments;

    // 在页面保存前，另一条请求追加复评/目标并调整认可标的。
    await submitAssessment(srv.port, LOW);
    await post(srv.port, '/api/v1/targets', {});
    await post(srv.port, '/api/v1/approved-instruments', {
      assetClass: 'broad_equity', instrumentIds: ['ins-vgt', 'ins-voo']
    });
    const concurrent = await collectCompanion(srv.port);
    assert.strictEqual(concurrent.riskAssessments.length, 2);
    assert.strictEqual(concurrent.allocationTargets.length, 2);
    assert.deepStrictEqual(concurrent.approvedInstruments.map((r) => r.instrumentId), ['ins-vgt', 'ins-voo']);

    const saved = await request(srv.port, 'PUT', '/api/v1/state', {
      body: { state: stalePageState, preserveCompanionCollections: true }
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.json));
    assert.deepStrictEqual(await collectCompanion(srv.port), concurrent,
      '保留动作必须与全量替换处于同一事务，并发新增不得被旧页面快照覆盖');

    // 显式集合始终以调用方为准；仅缺失的集合才保留。
    const partial = (await get(srv.port, '/api/v1/state')).json;
    delete partial.riskAssessments;
    delete partial.approvedInstruments;
    partial.allocationTargets = [];
    const partialSaved = await request(srv.port, 'PUT', '/api/v1/state', {
      body: { state: partial, preserveCompanionCollections: true }
    });
    assert.strictEqual(partialSaved.status, 200, JSON.stringify(partialSaved.json));
    const afterPartial = await collectCompanion(srv.port);
    assert.deepStrictEqual(afterPartial.allocationTargets, [], '显式空集合仍是清空指令');
    assert.deepStrictEqual(afterPartial.riskAssessments, concurrent.riskAssessments);
    assert.deepStrictEqual(afterPartial.approvedInstruments, concurrent.approvedInstruments);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('备份与恢复：v9 表、列、索引按版本登记，往返保留评估 / 目标 / 认可标的', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    await submitAssessment(srv.port, HIGH);
    const t = (await post(srv.port, '/api/v1/targets', {})).json.item;
    await seedState(srv.port);
    await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['ins-voo'] });
    const before = await collectCompanion(srv.port);

    assert.ok(B.requiredTablesFor(9).includes('allocation_targets'), 'v9 必需表应含 allocation_targets');
    assert.ok(B.requiredTablesFor(9).includes('approved_instruments'), 'v9 必需表应含 approved_instruments');
    assert.ok(B.REQUIRED_TABLES.includes('allocation_targets') && B.REQUIRED_TABLES.includes('approved_instruments'),
      '最新版本的完整表集合应包含 5C 两表');
    const idxNames = B.requiredIndexesFor(9).map((x) => x.name);
    ['uq_allocation_targets_natural', 'uq_approved_instruments_slot', 'uq_approved_instruments_instrument',
      'idx_allocation_targets_effective'].forEach((n) => assert.ok(idxNames.includes(n), 'v9 应登记索引 ' + n));
    const colNames = B.requiredColumnsFor(9).map((c) => c.table + '.' + c.name);
    ['allocation_targets.classes_json', 'allocation_targets.template_version', 'allocation_targets.rule_version',
      'allocation_targets.level', 'allocation_targets.assessment_id', 'allocation_targets.assessed_at',
      'allocation_targets.assessment_expiry', 'allocation_targets.effective_from', 'allocation_targets.created_at',
      'approved_instruments.asset_class', 'approved_instruments.instrument_id', 'approved_instruments.position',
      'approved_instruments.created_at', 'approved_instruments.updated_at'].forEach((c) => {
      assert.ok(colNames.includes(c), 'v9 必需列应含 ' + c);
    });
    // 按版本校验：v8 库不得被要求存在 5C 的列（否则旧备份无法恢复）
    assert.ok(!B.requiredColumnsFor(8).some((c) => c.table === 'allocation_targets'), 'v8 不应含 5C 列要求');

    const backup = await B.createBackup(ctx.db, ctx.paths, { reason: 'manual' });
    assert.strictEqual(backup.schemaVersion, M.LATEST_VERSION);
    assert.strictEqual(B.validateBackupFile(backup.file).ok, true);

    // 破坏结构后必须在**切换之前**被挡下（缺列 / 缺索引都不行）
    const missingColumn = backup.file + '.col.db';
    fs.copyFileSync(backup.file, missingColumn);
    const w = dbm.openDatabase(missingColumn);
    try {
      w.exec('DROP INDEX uq_approved_instruments_instrument');
    } finally {
      dbm.closeQuietly(w);
    }
    const dropIdx = B.validateBackupFile(missingColumn);
    assert.strictEqual(dropIdx.ok, false);
    assert.ok(/uq_approved_instruments_instrument/.test(dropIdx.reason), dropIdx.reason);

    const restored = await B.restoreBackup(ctx.db, ctx.paths, backup.file);
    assert.ok(restored.ok, restored.reason);
    ctx.adopt(restored);
    const after = await collectCompanion(srv.port);
    assert.deepStrictEqual(after.allocationTargets, before.allocationTargets, '恢复必须逐字段保留目标版本');
    assert.deepStrictEqual(after.approvedInstruments, before.approvedInstruments, '恢复必须逐字段保留用户映射');
    assert.strictEqual(after.riskAssessments.length, before.riskAssessments.length);
    assert.strictEqual(after.allocationTargets[0].id, t.id);
    const cur = await get(srv.port, '/api/v1/targets/current');
    assert.strictEqual(cur.json.status, 'current');
    assert.strictEqual(cur.json.mapping.rows[0].status, 'ok');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('范围边界：5C 的接口自身不分配金额、写请求仍需令牌，旧库恢复后集合为空', async () => {
  const ctx = setup('ledger-p5c-');
  const srv = await startServer(ctx);
  try {
    const rec = await submitAssessment(srv.port, HIGH);
    await post(srv.port, '/api/v1/targets', {});
    // 无令牌写请求 403
    const noToken = await post(srv.port, '/api/v1/targets', {}, { token: false });
    assert.strictEqual(noToken.status, 401);
    assert.strictEqual(noToken.json.error.code, 'token_required');

    // 5D 已实现建议写入口（D-049），但 5C 的两条读取路径仍不得给出任何金额分配：
    // 缺引用绑定的请求按 400 拒绝，正好证明「目标接口自己没有偷偷算钱」
    const rec400 = await post(srv.port, '/api/v1/recommendations', { newFundsMinor: 200000 });
    assert.strictEqual(rec400.status, 400);
    assert.strictEqual(rec400.json.error.code, 'invalid_snapshot_ref');
    const cur = await get(srv.port, '/api/v1/targets/current');
    const json = JSON.stringify(cur.json);
    ['newFundsMinor', 'categoryAllocations', 'buyAmount', 'recommendation', 'accepted', 'executed'].forEach((frag) => {
      assert.ok(json.indexOf(frag) === -1, '5C 响应不得出现 ' + frag);
    });
    assert.ok(cur.json.allocation.classes.every((c) => 'deviationBps' in c && 'pctBps' in c), '偏离以类别比例表达，不是金额');

    // 旧库（v8）前向迁移后三张表为空 —— 不伪造默认目标或映射
    const v8 = dbm.openDatabase(':memory:');
    try {
      M.migrate(v8, { list: M.MIGRATIONS.filter((m) => m.version <= 8) });
      assert.strictEqual(M.currentVersion(v8), 8);
      const migrated = M.migrate(v8);
      assert.deepStrictEqual(migrated.applied, [9, 10]);
      assert.strictEqual(dbm.all(v8, 'SELECT id FROM allocation_targets').length, 0);
      assert.strictEqual(dbm.all(v8, 'SELECT id FROM approved_instruments').length, 0);
      assert.ok(rec && rec.id);
    } finally {
      dbm.closeQuietly(v8);
    }
  } finally {
    srv.close();
    ctx.close();
  }
});
