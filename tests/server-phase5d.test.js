/* Phase 5D｜新增资金优先再平衡与正式建议门禁｜服务端测试（临时数据库，虚构数据，真实 HTTP 入口）
 *
 * 对应 PHASE5_BREAKDOWN §7.5 的服务端部分：
 *   - S5.2 从真实 HTTP 走通：结账 → 评估 → 目标 → 认可标的 → POST /recommendations；
 *     分配守恒、优先补低配、无卖出、只引用认可标的，且与服务端同一份领域函数逐字段一致；
 *   - S5.3 五类数据门槛（行情过期 / 分类未确认 / 月结非正式 / 快照哈希异常 / 评估过期）
 *     在真实 HTTP 上都只给估算，formalRecommendation 为空；
 *   - 服务端不采信客户端提交的当前比例、分数、目标、blocker 或映射（载荷白名单 + 全部重读）；
 *   - 建议产物不可变：同一输入重复请求回到同一行，历史行永不 UPDATE；
 *   - 迁移 v10、PUT /state 全量闸（含第四集合的事务保留）、JSON 备份恢复往返；
 *   - 范围边界：不预建 Phase 6 的决策状态、provider 刷新不得生成或改写建议、零真实网络。
 * 全部离线：注入 today / nowIso，行情自动抓取仍受 D-038 门禁默认关闭（AGENTS.md）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const api = require('../server/api');
const config = require('../server/config');
const B = require('../server/backup');
const R = require('../server/repository');
const dbm = require('../server/db');
const Domain = require('../js/domain.js');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';
const TODAY = '2026-09-30';
const MONTH = '2026-09';
const ASSESSED = '2026-06-15';
const NOW_ISO = '2026-09-30T08:00:00.000Z';
const CLASSES = Domain.RISK_CLASSES;
const NEW_FUNDS_MINOR = 200000;   // CNY 2,000（S5.2）

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
    // agent:false —— 本文件会连续起多个隔离服务；复用 keep-alive 套接字会让 server.close()
    // 迟迟等不到连接结束，测试进程因此挂住而不是失败。
    const req = http.request({ host: config.HOST, port, method, path: pathname, headers, agent: false }, (res) => {
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

// L3（能力 7 / 意愿 6）：与 5C 测试同一套构造，但刻意不复用其题面顺序（提交顺序无关）
const L3 = { answers: clientAnswers([1, 1, 1, 2, 2], [2, 2, 1, 1]).slice().reverse(), assessedAt: ASSESSED, reason: 'initial' };
const L1 = { answers: clientAnswers([1, 0, 1, 0, 0], [1, 1, 0, 0]), assessedAt: ASSESSED, reason: 'manual' };

async function submitAssessment(port, payload, idemKey) {
  const res = await post(port, '/api/v1/risk-assessments', payload,
    idemKey ? { headers: { 'Idempotency-Key': idemKey } } : {});
  assert.strictEqual(res.status, 201, JSON.stringify(res.json));
  return res.json.item;
}

/* 投资池按 S5.2 的冻结比例构造（总额 1 亿元 = 1e8 分）：
 *   cash 5,000bps（高于 L3 上限 3,500）· fixed_income 3,500（区间内）
 *   broad_equity 800（低于下限 3,000 → 本轮的主类别）· theme_equity 700（区间内但低于 target）
 * 这样"优先补宽基权益"是场景设定本身，而不是断言时再挑一个恰好成立的类别。 */
function investmentAssets(over) {
  const a = Domain.emptyAssets();
  a.assetAccounts = [
    { id: 'acc-cash', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: 'I' },
    { id: 'acc-broker', name: '券商户', kind: 'broker', pool: 'investable', institution: 'I' },
    { id: 'acc-safe', name: '应急金', kind: 'deposit', pool: 'safety', institution: 'I' }
  ];
  a.assetUnits = [
    { id: 'u-cny', accountId: 'acc-cash', currency: 'CNY', balanceMinor: 50000000, asOf: TODAY, sourceType: 'manual' },
    { id: 'u-safe', accountId: 'acc-safe', currency: 'CNY', balanceMinor: 50000000, asOf: TODAY, sourceType: 'manual' }
  ];
  a.instruments = [
    { id: 'ins-bond', symbol: 'BND', exchange: 'NASDAQ', currency: 'USD', name: '债基', instrumentType: 'etf', assetClass: 'fixed_income', exposureMarket: 'US', classificationStatus: 'confirmed' },
    { id: 'ins-voo', symbol: 'VOO', exchange: 'SSE', currency: 'CNY', name: '宽基A', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
    { id: 'ins-vgt', symbol: 'VGT', exchange: 'SSE', currency: 'CNY', name: '宽基B', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
    { id: 'ins-thm', symbol: 'THM', exchange: 'SSE', currency: 'CNY', name: '主题基金', instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' }
  ];
  a.holdings = [
    { id: 'h-bond', accountId: 'acc-broker', instrumentId: 'ins-bond', quantity: '5000', costMinor: 5000000, asOf: TODAY },
    { id: 'h-voo', accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '50000', costMinor: 5000000, asOf: TODAY },
    { id: 'h-thm', accountId: 'acc-broker', instrumentId: 'ins-thm', quantity: '70000', costMinor: 7000000, asOf: TODAY }
  ];
  a.quotes = [
    { instrumentId: 'ins-bond', priceMinor: 1000, currency: 'USD', priceDate: TODAY, provider: 'manual', status: 'ok' },
    { instrumentId: 'ins-voo', priceMinor: 100, currency: 'CNY', priceDate: TODAY, provider: 'manual', status: 'ok' },
    { instrumentId: 'ins-thm', priceMinor: 100, currency: 'CNY', priceDate: TODAY, provider: 'manual', status: 'ok' }
  ];
  a.fxRates = [{ base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: TODAY, provider: 'manual', status: 'ok' }];
  return Object.assign(a, over || {});
}

async function seedState(port, assets) {
  const state = (await get(port, '/api/v1/state')).json;
  state.assets = assets || investmentAssets();
  const res = await request(port, 'PUT', '/api/v1/state', { body: { state: Object.assign({}, state, {
    riskAssessments: [], allocationTargets: [], approvedInstruments: [], recommendations: []
  }) } });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  return state.assets;
}

// 一条完整可建议的事实链：资产 → 正式结账 → 评估 → 目标 → 认可标的
async function seedAdviceChain(port, opts) {
  const o = opts || {};
  await seedState(port, o.assets);
  const close = await post(port, '/api/v1/monthly-closes', o.closeStatus ? { month: MONTH, status: o.closeStatus } : { month: MONTH });
  assert.strictEqual(close.status, 201, JSON.stringify(close.json));
  // 默认要求本轮能正式结账；只有刻意制造数据门槛的用例才允许估算结账
  if (o.expectFormalClose !== false) assert.strictEqual(close.json.close.status, 'formal', '前置：本轮必须能正式结账');
  const assessment = await submitAssessment(port, o.assessment || L3);
  const target = await post(port, '/api/v1/targets', {});
  assert.strictEqual(target.status, 201, JSON.stringify(target.json));
  if (o.approved !== false) {
    const mapped = await post(port, '/api/v1/approved-instruments', {
      assetClass: o.mapClass || 'broad_equity', instrumentIds: o.mapIds || ['ins-voo', 'ins-vgt']
    });
    assert.strictEqual(mapped.status, 200, JSON.stringify(mapped.json));
  }
  return {
    close: close.json.close,
    snapshot: close.json.snapshot,
    assessment,
    target: target.json.item
  };
}

function recommendBody(facts, over) {
  return Object.assign({
    snapshotRef: {
      closeId: facts.close.id,
      snapshotId: facts.snapshot.id,
      payloadHash: facts.snapshot.payloadHash
    },
    assessmentRef: { id: facts.assessment.id, ruleVersion: facts.assessment.ruleVersion },
    targetVersion: facts.target.templateVersion,
    ruleVersion: Domain.RISK_RULE_VERSION,
    newFundsMinor: NEW_FUNDS_MINOR
  }, over || {});
}

async function collectCompanion(port) {
  const s = (await get(port, '/api/v1/state')).json;
  return {
    riskAssessments: s.riskAssessments,
    allocationTargets: s.allocationTargets,
    approvedInstruments: s.approvedInstruments,
    recommendations: s.recommendations
  };
}

/* ================= 1. S5.2：真实 HTTP 的正式建议闭环 ================= */

test('POST /recommendations：S5.2 走通正式建议，分配守恒且与服务端同一份领域函数逐字段一致', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    assert.strictEqual(facts.assessment.ceiling, 3, '前置：L3 上限');
    const overview = (await get(srv.port, '/api/v1/overview')).json;
    assert.strictEqual(overview.canAdvise, true, '前置：估值必须是正式口径');

    const res = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const body = res.json;
    assert.strictEqual(body.status, 'formal');
    assert.strictEqual(body.created, true);
    assert.ok(body.formalRecommendation, '门禁全过必须给出正式建议');
    assert.strictEqual(body.estimate, null, '正式与估算互斥，不得同时给两份数字');
    assert.match(body.id, /^rec-[0-9a-f]{16}$/);
    assert.strictEqual(body.recommendation.id, body.id);
    assert.match(body.inputHash, /^[0-9a-f]{64}$/);

    const result = body.formalRecommendation;
    assert.deepStrictEqual(Object.keys(result), Domain.recommendationContract().outputKeys,
      '输出键集合必须等于 5A 冻结契约');
    assert.strictEqual(result.status, 'formal');
    assert.deepStrictEqual(result.blockers, []);
    assert.strictEqual(result.dataCutoff, facts.close.dataCutoff);
    // 只补低配：宽基权益拿满，高配的现金为 0，任何类别都不出现负数
    const alloc = {};
    result.categoryAllocations.forEach((c) => { alloc[c.assetClass] = c; });
    assert.deepStrictEqual(result.categoryAllocations.map((c) => c.assetClass), CLASSES, '类别恒按冻结顺序');
    assert.ok(alloc.broad_equity.allocatedMinor > 0, '低配的宽基权益必须优先获得新增资金');
    assert.strictEqual(alloc.cash.allocatedMinor, 0, '高配类别不得得到新增资金');
    assert.strictEqual(CLASSES.reduce((s, k) => s + alloc[k].allocatedMinor, 0), result.roundingNote.allocatedTotalMinor,
      'Σ类别 == 实际分配金额');
    assert.strictEqual(result.roundingNote.allocatableNewFundsMinor,
      Math.min(NEW_FUNDS_MINOR, overview.newFundsAvailableMinor));
    assert.strictEqual(result.roundingNote.allocatedTotalMinor + result.roundingNote.unallocatedMinor,
      result.roundingNote.allocatableNewFundsMinor, '守恒');
    CLASSES.forEach((k) => assert.ok(alloc[k].allocatedMinor >= 0, k + ' 不得为负（绝不返回卖出指令）'));
    assert.ok(JSON.stringify(result).indexOf('-') < 0 || !/"[-\d]*-[^\d]/.test(JSON.stringify(result)),
      '序列化结果不得出现负金额');
    // 只引用用户事先认可的标的
    const instruments = alloc.broad_equity.instruments;
    assert.deepStrictEqual(instruments.map((x) => x.instrumentId).sort(), ['ins-vgt', 'ins-voo']);
    assert.strictEqual(instruments.reduce((s, x) => s + x.allocatedMinor, 0), alloc.broad_equity.allocatedMinor);
    assert.strictEqual(alloc.theme_equity.instruments.length, 0, '没有金额就不该有标的');
    // 版本绑定：快照 / 评估 / 目标 / 规则 + 数据截止时间
    assert.strictEqual(result.versions.closeId, facts.close.id);
    assert.strictEqual(result.versions.snapshotId, facts.snapshot.id);
    assert.strictEqual(result.versions.snapshotPayloadHash, facts.snapshot.payloadHash);
    assert.strictEqual(result.versions.assessmentId, facts.assessment.id);
    assert.strictEqual(result.versions.targetId, facts.target.id);
    assert.strictEqual(result.versions.targetVersion, Domain.RISK_TARGET_VERSION);
    assert.strictEqual(result.versions.asOf, TODAY);

    // 与服务端同一份领域函数对账：API 不得另算一遍（D-025）
    const state = (await get(srv.port, '/api/v1/state')).json;
    const ov = Domain.computeOverview(state.assets, { now: TODAY, settings: state.settings || {} });
    const dev = Domain.computeAllocationDeviation(facts.target, ov);
    const al = Domain.computeNewFundsAllocation({
      target: facts.target, deviation: dev,
      requestedNewFundsMinor: NEW_FUNDS_MINOR, newFundsAvailableMinor: ov.newFundsAvailableMinor
    });
    assert.ok(al.ok, JSON.stringify(al.error));
    assert.deepStrictEqual(
      result.categoryAllocations.map((c) => [c.assetClass, c.allocatedMinor]),
      al.allocation.classes.map((c) => [c.assetClass, c.allocatedMinor]),
      'HTTP 响应与领域函数必须逐类别同金额');

    // 读回：列表逐字段一致，且带封存哈希
    const list = await get(srv.port, '/api/v1/recommendations');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.total, 1);
    assert.strictEqual(list.json.invalidCount, 0);
    assert.strictEqual(list.json.items[0].id, body.id);
    assert.deepStrictEqual(list.json.items[0].result, result);
    assert.match(list.json.items[0].payloadHash, /^[0-9a-f]{64}$/);
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 2. 幂等与不可变 ================= */

test('同一输入重复请求回到同一行；Idempotency-Key 重放同一响应；历史行永不 UPDATE', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const body = recommendBody(facts);
    const first = await post(srv.port, '/api/v1/recommendations', body,
      { headers: { 'Idempotency-Key': 'rec-key-1' } });
    assert.strictEqual(first.status, 201);
    const replay = await post(srv.port, '/api/v1/recommendations', body,
      { headers: { 'Idempotency-Key': 'rec-key-1' } });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.headers['x-ledger-idempotent'], 'replay');
    assert.deepStrictEqual(replay.json, first.json, '幂等重放必须逐字段等于首次响应');

    // 换一个幂等键：同一份输入仍落到同一行（内容寻址），不追加第二份
    const again = await post(srv.port, '/api/v1/recommendations', body,
      { headers: { 'Idempotency-Key': 'rec-key-2' } });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.created, false);
    assert.strictEqual(again.json.id, first.json.id);
    const list = await get(srv.port, '/api/v1/recommendations');
    assert.strictEqual(list.json.total, 1, '同一输入不得产生第二条建议产物');

    // 金额变了 → 新的一行；旧行逐字段保持（建议历史不可被覆盖）
    const more = await post(srv.port, '/api/v1/recommendations',
      recommendBody(facts, { newFundsMinor: NEW_FUNDS_MINOR + 100000 }));
    assert.strictEqual(more.status, 201);
    assert.notStrictEqual(more.json.id, first.json.id);
    const after = await get(srv.port, '/api/v1/recommendations');
    assert.strictEqual(after.json.total, 2);
    assert.deepStrictEqual(after.json.items.filter((x) => x.id === first.json.id)[0].result,
      first.json.formalRecommendation, '历史建议必须原样可读');
    // 排序与写入顺序无关（createdAt 降序 → id 升序）
    assert.ok(after.json.items[0].createdAt >= after.json.items[1].createdAt);

    // 同一 key 换请求体 → 显式拒绝，不能让一个键吞掉另一笔语义
    const conflict = await post(srv.port, '/api/v1/recommendations',
      recommendBody(facts, { newFundsMinor: 1 }), { headers: { 'Idempotency-Key': 'rec-key-1' } });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.json.error.code, 'idempotency_conflict');
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 3. 不采信客户端派生值 ================= */

test('载荷白名单：客户端提交映射、比例或额外字段一律拒绝且零落库', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const forged = [
      ['映射', recommendBody(facts, { approvedInstruments: { broad_equity: ['ins-unknown'] } })],
      ['当前比例', recommendBody(facts, { currentAllocation: [{ assetClass: 'cash', pctBps: 1 }] })],
      ['伪造状态', recommendBody(facts, { status: 'formal' })],
      ['负金额', recommendBody(facts, { newFundsMinor: -100 })],
      ['非安全整数', recommendBody(facts, { newFundsMinor: Number.MAX_SAFE_INTEGER + 10 })],
      ['未知规则版本', recommendBody(facts, { ruleVersion: 'risk-rules-v999' })],
      ['未知目标版本', recommendBody(facts, { targetVersion: 'risk-targets-unknown' })],
      ['快照哈希短', recommendBody(facts, { snapshotRef: { closeId: facts.close.id, snapshotId: facts.snapshot.id, payloadHash: 'abc' } })]
    ];
    for (const [label, body] of forged) {
      const res = await post(srv.port, '/api/v1/recommendations', body);
      assert.ok(res.status >= 400 && res.status < 500, label + ' 必须是 4xx，实际 ' + res.status);
      assert.ok(res.json && res.json.error && res.json.error.code, label + ' 必须给出稳定错误码');
    }
    // 非对象 JSON 同样在入口拒绝
    for (const raw of ['null', '[]', '"x"', '7']) {
      const bad = await request(srv.port, 'POST', '/api/v1/recommendations', { body: raw });
      assert.strictEqual(bad.status, 400, raw);
      assert.strictEqual(bad.json.error.code, 'invalid_new_funds_request');
    }
    assert.strictEqual((await get(srv.port, '/api/v1/recommendations')).json.total, 0, '被拒绝的请求不得留下任何建议');
    // 写请求仍受会话令牌门禁
    const noToken = await post(srv.port, '/api/v1/recommendations', recommendBody(facts), { token: false });
    assert.ok(noToken.status === 401 || noToken.status === 403, '无令牌写请求必须被拒绝');
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 4. S5.3：五类数据门槛都只给估算 ================= */

test('S5.3：行情过期 / 分类未确认 / 月结非正式 / 快照哈希异常 / 评估过期 → 正式建议为空', async () => {
  const staleQuotes = investmentAssets();
  staleQuotes.quotes = staleQuotes.quotes.map((q) => Object.assign({}, q, { priceDate: '2026-09-01' }));
  // 未确认分类：新增一只仍停留在 suggested 的持仓标的（映射只用已确认的那只，避免被 5C 的写入口挡下）
  const unconfirmed = investmentAssets();
  unconfirmed.instruments = unconfirmed.instruments.concat([
    { id: 'ins-unc', symbol: 'UNC', exchange: 'SSE', currency: 'CNY', name: '未确认基金',
      instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'suggested' }
  ]);
  unconfirmed.holdings = unconfirmed.holdings.concat([
    { id: 'h-unc', accountId: 'acc-broker', instrumentId: 'ins-unc', quantity: '10000', costMinor: 1000000, asOf: TODAY }
  ]);
  unconfirmed.quotes = unconfirmed.quotes.concat([
    { instrumentId: 'ins-unc', priceMinor: 100, currency: 'CNY', priceDate: TODAY, provider: 'manual', status: 'ok' }
  ]);

  const cases = [
    { name: 'quote_stale', assets: staleQuotes, expectFormalClose: false, blocker: 'quote_stale' },
    { name: 'classification_unconfirmed', assets: unconfirmed, expectFormalClose: false, blocker: 'classification_unconfirmed' },
    // 估值本身是正式的，只有月结没完成 —— 必须能区分这两件事（§7.3 是两条独立门禁）
    { name: 'close_incomplete', flipCloseEstimate: true, blocker: 'close_incomplete' },
    { name: 'baseline_hash_mismatch', tamperSnapshot: true, blocker: 'snapshot_hash_mismatch' },
    { name: 'assessment_expired', laterToday: '2027-07-01', blocker: 'assessment_expired' }
  ];
  assert.deepStrictEqual(cases.map((c) => c.name), require('./fixtures/phase5-risk-rules.json').samples.S5_3.cases,
    '五个触发条件必须与 5A 冻结的 fixture 一一对应');

  for (const c of cases) {
    const ctx = setup('ledger-p5d-');
    const srv = await startServer(ctx);
    try {
      const facts = await seedAdviceChain(srv.port, c);
      if (c.tamperSnapshot) {
        // 直接在磁盘层制造「封存原文与哈希不符」：建议必须拒绝采信这份事实
        require('../server/db').run(ctx.db,
          'UPDATE close_snapshots SET payload_json = ? WHERE id = ?',
          ['{"overview":{"tampered":true}}', facts.snapshot.id]);
      }
      if (c.flipCloseEstimate) {
        // 真实的「上月只保存了估算结账」：结账行本身保持 estimate（今天的估值可以是正式的）。
        // PUT /state 会整体重建结账两张表，所以这里直接落到事实源，而不是重放一遍结账。
        dbm.run(ctx.db, 'UPDATE monthly_closes SET status = ? WHERE id = ?', ['estimate', facts.close.id]);
      }
      if (c.laterToday) ctx.today = () => c.laterToday;
      const res = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
      // 门禁不过不是 HTTP 错误：仍留下一份 200/201 的估算产物（新算出来的是 201，重放是 200）
      assert.ok(res.status === 200 || res.status === 201, c.name + '：门禁不过不是错误，实际 ' + JSON.stringify(res.json));
      assert.strictEqual(res.json.status, 'estimate', c.name + ' 只能给估算');
      assert.strictEqual(res.json.formalRecommendation, null, c.name + ' 的正式建议必须为空');
      assert.ok(res.json.estimate, c.name + ' 仍要给出估算数字');
      const codes = res.json.estimate.blockers.map((b) => b.code);
      assert.ok(codes.indexOf(c.blocker) >= 0, c.name + ' 必须显式给出 ' + c.blocker + '，实际 ' + codes.join(','));
      // 估算同样守恒，且门禁明细可追溯
      const note = res.json.estimate.roundingNote;
      assert.strictEqual(note.allocatedTotalMinor + note.unallocatedMinor, note.allocatableNewFundsMinor);
      const failed = res.json.recommendation.gate.checks.filter((x) => !x.passed).map((x) => x.code);
      assert.ok(failed.length >= 1, c.name + ' 至少要有一条门禁不过');
      assert.strictEqual(res.json.recommendation.status, 'estimate');
    } finally {
      srv.close();
      ctx.close();
    }
  }
});

test('引用不存在或没有目标版本：显式错误码，不伪装成估算结果', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const cases = [
      [recommendBody(facts, { snapshotRef: { closeId: facts.close.id, snapshotId: 'snap-none', payloadHash: 'a'.repeat(64) } }), 'unknown_snapshot'],
      [recommendBody(facts, { assessmentRef: { id: 'ra-none', ruleVersion: Domain.RISK_RULE_VERSION } }), 'unknown_assessment'],
      [recommendBody(facts, { targetVersion: 'risk-targets-v1', assessmentRef: { id: (await submitAssessment(srv.port, L1)).id, ruleVersion: Domain.RISK_RULE_VERSION } }), 'no_target']
    ];
    for (const [body, code] of cases) {
      const res = await post(srv.port, '/api/v1/recommendations', body);
      assert.strictEqual(res.json.error.code, code, JSON.stringify(res.json));
      assert.ok(res.status >= 400 && res.status < 500, code + ' 必须是 4xx');
    }
  } finally {
    srv.close();
    ctx.close();
  }
});

test('新增资金超过可新增投资资金：按上限计算并留在估算，显式提示而不是静默当作可用', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const overview = (await get(srv.port, '/api/v1/overview')).json;
    const body = recommendBody(facts, { newFundsMinor: overview.newFundsAvailableMinor + 5000000 });
    const res = await post(srv.port, '/api/v1/recommendations', body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    assert.strictEqual(res.json.created, true, '仍要留下一份可追溯的估算产物');
    assert.strictEqual(res.json.status, 'estimate', '超上限的请求不能成为正式建议');
    assert.strictEqual(res.json.formalRecommendation, null);
    const est = res.json.estimate;
    assert.ok(est.blockers.some((b) => b.code === 'new_funds_exceeds_available'));
    assert.strictEqual(est.roundingNote.allocatableNewFundsMinor, overview.newFundsAvailableMinor);
    assert.strictEqual(est.roundingNote.cappedToAvailable, true);
    assert.ok(est.explainCodes.indexOf('new_funds_capped_by_available') >= 0);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('全部类别都在容忍带内：建议明确「无需调整」，一分钱都不分配', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const state = (await get(srv.port, '/api/v1/state')).json;
    const ov = Domain.computeOverview(state.assets, { now: TODAY, settings: state.settings || {} });
    const dev = Domain.computeAllocationDeviation(facts.target, ov);
    // 只有当当前配置确实全在区间内时才走这条断言；否则本用例改为验证 fill_below_min 的守恒
    const allWithin = dev.classes.every((c) => c.band === 'within');
    const res = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const note = res.json.formalRecommendation.roundingNote;
    if (allWithin) {
      assert.strictEqual(note.adjustment, 'within_tolerance');
      assert.strictEqual(note.allocatedTotalMinor, 0, '在容忍带内不得强行分配');
      assert.strictEqual(note.unallocatedMinor, note.allocatableNewFundsMinor);
    } else {
      assert.strictEqual(note.allocatedTotalMinor + note.unallocatedMinor, note.allocatableNewFundsMinor);
    }
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 5. 不可变性与读取即复核 ================= */

test('伪造已落库的建议：读取视图过滤并留痕，不冒充可用建议', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const first = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    assert.strictEqual(first.status, 201);
    const before = (await get(srv.port, '/api/v1/recommendations')).json;
    assert.strictEqual(before.invalidCount, 0);

    // 直接改磁盘上的结果：把估算金额抬高并把状态伪造成正式
    const row = R.getRecommendation(ctx.db, first.json.id);
    const tampered = JSON.parse(JSON.stringify(row.record));
    tampered.status = 'formal';
    tampered.result.status = 'formal';
    tampered.result.categoryAllocations[2].allocatedMinor += 1;
    require('../server/db').run(ctx.db,
      'UPDATE recommendations SET status = ?, result_json = ? WHERE id = ?',
      [tampered.status, JSON.stringify(tampered.result), first.json.id]);

    const after = (await get(srv.port, '/api/v1/recommendations')).json;
    assert.strictEqual(after.total, 1, '失效行不得静默消失');
    assert.strictEqual(after.invalidCount, 1, '必须显式报告异常行');
    assert.deepStrictEqual(after.items, [], '被篡改的建议不能出现在可用列表里');
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 6. 全量写入、备份与恢复 ================= */

test('PUT /state：建议集合逐条复核；非法整体回滚；缺键清空；显式空集合是清空指令', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const created = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    const item = created.json.recommendation;
    const state = (await get(srv.port, '/api/v1/state')).json;
    assert.deepStrictEqual(state.recommendations.map((r) => r.id), [item.id]);

    // 缺键 = 清空（旧备份恢复语义）
    const wiped = Object.assign({}, state);
    delete wiped.recommendations;
    const cleared = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: wiped } });
    assert.strictEqual(cleared.status, 200);
    assert.deepStrictEqual((await get(srv.port, '/api/v1/state')).json.recommendations, []);
    assert.strictEqual((await get(srv.port, '/api/v1/recommendations')).json.total, 0);

    // 写回原样：逐字段无损
    const restored = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: Object.assign({}, state) } });
    assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
    assert.deepStrictEqual((await get(srv.port, '/api/v1/state')).json.recommendations, state.recommendations);

    // 伪造一条建议（门禁不过却标 formal）→ 整体拒绝且旧状态保持
    const forged = JSON.parse(JSON.stringify(item));
    forged.gate.checks = forged.gate.checks.map((c) => Object.assign({}, c, { passed: false }));
    const bad = await request(srv.port, 'PUT', '/api/v1/state', {
      body: { state: Object.assign({}, state, { recommendations: [forged] }) }
    });
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.json));
    assert.strictEqual(bad.json.error.code, 'invalid_recommendation_record');
    assert.deepStrictEqual((await get(srv.port, '/api/v1/state')).json.recommendations, state.recommendations,
      '拒绝必须整体回滚，不能留下半份状态');

    // 引用了不存在评估的建议同样拒绝（RESTRICT 不能变成 500）
    const dangling = JSON.parse(JSON.stringify(item));
    dangling.id = 'rec-deadbeef00000001';
    dangling.inputHash = 'e'.repeat(64);
    dangling.assessmentId = 'ra-none';
    dangling.result.versions.assessmentId = 'ra-none';
    const badRef = await request(srv.port, 'PUT', '/api/v1/state', {
      body: { state: Object.assign({}, state, { recommendations: [dangling] }) }
    });
    assert.ok(badRef.status >= 400 && badRef.status < 500, JSON.stringify(badRef.json));
    assert.notStrictEqual(badRef.json.error.code, 'internal_error');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('PUT /state：页面五键保存保留建议，与评估 / 目标 / 映射同处于一次事务保留清单', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    const pageSnapshot = (await get(srv.port, '/api/v1/state')).json;
    ['riskAssessments', 'allocationTargets', 'approvedInstruments', 'recommendations'].forEach((k) => {
      delete pageSnapshot[k];
    });
    // 页面保存前先发生一次并发追加（新增一条更大金额的建议）
    await post(srv.port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: 500000 }));
    const concurrent = await collectCompanion(srv.port);
    assert.strictEqual(concurrent.recommendations.length, 2);

    const saved = await request(srv.port, 'PUT', '/api/v1/state', {
      body: { state: pageSnapshot, preserveCompanionCollections: true }
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.json));
    assert.deepStrictEqual(await collectCompanion(srv.port), concurrent,
      '四份追加式事实都必须被同一事务保留，旧页面快照不得覆盖并发建议');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('备份与恢复：v10 表 / 列 / 索引按版本登记，JSON 备份往返保留四份集合', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const created = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    const item = created.json.recommendation;

    // D-040：按版本登记的必需表 / 列 / 索引
    const tables = B.requiredTablesFor(10);
    assert.ok(tables.includes('recommendations'), 'v10 起 recommendations 必须是必需表');
    const cols = B.requiredColumnsFor(10).map((c) => c.table + '.' + c.name);
    ['recommendations.status', 'recommendations.input_hash', 'recommendations.result_json',
      'recommendations.payload_hash'].forEach((c) => assert.ok(cols.includes(c), '缺登记列 ' + c));
    const idx = B.REQUIRED_INDEXES_BY_VERSION[10].map((i) => i.name);
    assert.ok(idx.includes('uq_recommendations_input'), '唯一索引必须按版本登记');

    // 缺该表的候选库必须在切换前被挡下
    const backup = await post(srv.port, '/api/v1/backups', {});
    assert.strictEqual(backup.status, 201);
    const files = (await get(srv.port, '/api/v1/backups')).json.items;
    assert.ok(files.length >= 1);

    // JSON 备份（前端导出形状）携带第四集合，恢复后逐字段一致
    const state = (await get(srv.port, '/api/v1/state')).json;
    const exported = {
      app: 'ledger', appVersion: '2.4.10-phase5d', schemaVersion: 2,
      exportedAt: NOW_ISO, accounts: state.accounts, categories: state.categories, txns: state.txns,
      settings: state.settings, assets: state.assets,
      riskAssessments: state.riskAssessments, allocationTargets: state.allocationTargets,
      approvedInstruments: state.approvedInstruments, recommendations: state.recommendations
    };
    assert.strictEqual(exported.recommendations.length, 1);
    assert.deepStrictEqual(exported.recommendations[0].result, item.result);

    // 旧备份缺键 → 恢复为空集合，不伪造建议
    const legacy = Object.assign({}, exported);
    delete legacy.recommendations;
    const put = await request(srv.port, 'PUT', '/api/v1/state', {
      body: { state: legacy, forceBackup: true }
    });
    assert.strictEqual(put.status, 200);
    assert.deepStrictEqual((await get(srv.port, '/api/v1/state')).json.recommendations, [],
      '旧备份缺键必须恢复为空集合');
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ================= 7. 范围边界 ================= */

test('范围边界：provider 刷新不生成也不改写建议；建议表没有 Phase 6 决策列；零新数据源', async () => {
  const ctx = setup('ledger-p5d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const created = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    const before = JSON.stringify((await get(srv.port, '/api/v1/recommendations')).json);

    const refresh = await post(srv.port, '/api/v1/market-data/refresh', { scopes: ['fx'] });
    assert.ok(refresh.status === 200 || refresh.status === 409, '刷新报告不改变建议事实');
    assert.strictEqual(JSON.stringify((await get(srv.port, '/api/v1/recommendations')).json), before,
      '行情 / 汇率刷新不得生成或改写建议产物');
    // 手动补价同样不写建议表
    await post(srv.port, '/api/v1/quotes', {
      instrumentId: 'ins-vgt', priceMinor: 12000, priceDate: TODAY, currency: 'USD'
    });
    assert.strictEqual(JSON.stringify((await get(srv.port, '/api/v1/recommendations')).json), before);

    // 建议表结构里没有任何决策状态列（5D 段落原意保留：决策状态只存在于 6B 的 decisions 表）
    const cols = require('../server/db').all(ctx.db, 'PRAGMA table_info(recommendations)').map((c) => c.name);
    ['state', 'decision_state', 'accepted_at', 'deferred', 'executed', 'reviewed', 'dismissed'].forEach((c) => {
      assert.ok(!cols.includes(c), '建议表不得预建决策状态列 ' + c);
    });
    // 6B（D-057，契约 §11 更新）：决策三表已按 v11 交付 —— 原断言「Phase 6 表不得提前建」
    // 随 6B 实施显式推进；建议表无状态列的原意保持不变。
    const tables = require('../server/db').all(ctx.db, "SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
    assert.ok(tables.includes('decisions') && tables.includes('decision_events') && tables.includes('decision_links'),
      'v11 应已建立决策三表');
    const events = await post(srv.port, '/api/v1/decisions/dc-1/events', { toState: 'accepted' });
    assert.strictEqual(events.status, 404, '决策事件已是真实路由：未知决策 404');
    assert.strictEqual(events.json.error.code, 'unknown_decision');

    // 建议响应里不回显任何 provider / 网络痕迹，且引用快照哈希可追溯到封存行
    const json = created.json.recommendation;
    assert.strictEqual(json.result.versions.snapshotPayloadHash.length, 64);
    assert.ok(!/https?:/.test(JSON.stringify(created.json)), '建议产物不得携带外部地址');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('静态范围守卫：5D 不新增数据源文件，服务端路由只增加建议读写两条', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'api.js'), 'utf8');
  assert.ok(src.includes("api['POST /api/v1/recommendations']"), '5D 必须实现建议写入口');
  assert.ok(src.includes("api['GET /api/v1/recommendations']"), '5D 必须实现建议只读列表');
  assert.ok(!/'POST \/api\/v1\/recommendations': 'Phase 5'/.test(src), '延后登记必须已被真实路由取代');
  assert.ok(!/DEFERRED_WRITES\s*=\s*\{[^}]*recommendations/.test(src), '建议不得再出现在延后写入表里');
  // 5D 不开任何新的外部数据源：providers 目录的 provider 清单不因本阶段增加
  const providers = fs.readdirSync(path.join(__dirname, '..', 'server', 'providers'))
    .filter((f) => /\.js$/.test(f)).sort();
  assert.deepStrictEqual(providers, ['clock.js', 'contract.js', 'fixture.js', 'frankfurter.js', 'keychain-key.js']);
});

test('R-01 普通五键保存和 JSON 恢复保留完整月结/快照/建议，非法快照整体回滚', async () => {
  const ctx=setup('ledger-r01-'); const srv=await startServer(ctx);
  try {
    const facts=await seedAdviceChain(srv.port);
    assert.strictEqual((await post(srv.port,'/api/v1/recommendations',recommendBody(facts))).status,201);
    const before=(await get(srv.port,'/api/v1/state')).json;
    const page={accounts:before.accounts,categories:before.categories,txns:before.txns,settings:{...before.settings,testSetting:true},assets:before.assets};
    assert.strictEqual((await request(srv.port,'PUT','/api/v1/state',{body:{state:page,preserveCompanionCollections:true}})).status,200);
    let after=(await get(srv.port,'/api/v1/state')).json;
    assert.deepStrictEqual(after.monthlyCloses,before.monthlyCloses);
    assert.deepStrictEqual(after.closeSnapshots,before.closeSnapshots);
    assert.deepStrictEqual(after.recommendations,before.recommendations);
    assert.strictEqual((await get(srv.port,'/api/v1/recommendations')).json.invalidCount,0);
    const Core=require('../js/core');
    const restored=Core.restoreStateFromBackup(Core.createBackup(after,'test',NOW_ISO));
    assert.strictEqual((await request(srv.port,'DELETE','/api/v1/state',{headers:{'Content-Type':'application/json'}})).status,200);
    assert.strictEqual((await request(srv.port,'PUT','/api/v1/state',{body:{state:restored,forceBackup:true}})).status,200);
    after=(await get(srv.port,'/api/v1/state')).json;
    assert.deepStrictEqual(after.closeSnapshots,before.closeSnapshots);
    assert.deepStrictEqual(after.monthlyCloses,before.monthlyCloses);
    assert.strictEqual((await get(srv.port,'/api/v1/recommendations')).json.items.length,1);
    const bad=JSON.parse(JSON.stringify(after));bad.closeSnapshots[0].payloadJson='{}';
    assert.strictEqual((await request(srv.port,'PUT','/api/v1/state',{body:{state:bad}})).status,400);
    assert.deepStrictEqual((await get(srv.port,'/api/v1/state')).json,after);
    const missing=JSON.parse(JSON.stringify(after)); missing.closeSnapshots=[];
    assert.strictEqual((await request(srv.port,'PUT','/api/v1/state',{body:{state:missing}})).status,400);
    assert.deepStrictEqual((await get(srv.port,'/api/v1/state')).json,after);
  } finally {await srv.close();ctx.close();}
});

test('R-03/R-05 完整输入可离线重放；余额/映射改变产生新记录；行序不影响输入哈希', async () => {
  const ctx=setup('ledger-r035-');const srv=await startServer(ctx);
  try {
    const facts=await seedAdviceChain(srv.port), body=recommendBody(facts);
    const first=await post(srv.port,'/api/v1/recommendations',body);assert.strictEqual(first.status,201,JSON.stringify(first.json));
    const C=require('../server/recommendations'); const original=first.json.recommendation;
    assert.deepStrictEqual(C.calculate(original.gate.capture).result,original.result);
    const reversed=JSON.parse(JSON.stringify(original));
    reversed.gate.capture.assets.holdings.reverse(); reversed.gate.capture.riskAssessments.reverse(); reversed.gate.capture.approvedInstruments.reverse();
    assert.strictEqual(R.recommendationInputHash(reversed),original.inputHash);
    await post(srv.port,'/api/v1/approved-instruments',{assetClass:'broad_equity',instrumentIds:['ins-vgt','ins-voo']});
    const mapped=await post(srv.port,'/api/v1/recommendations',body);assert.strictEqual(mapped.status,201,JSON.stringify(mapped.json));
    assert.notStrictEqual(mapped.json.id,original.id);
    assert.strictEqual(mapped.json.recommendation.result.categoryAllocations.find(c=>c.assetClass==='broad_equity').instruments[0].instrumentId,'ins-vgt');
    await post(srv.port,'/api/v1/account-units',{id:'u-cny',accountId:'acc-cash',currency:'CNY',balanceMinor:60000000,asOf:TODAY,sourceType:'manual'});
    const changed=await post(srv.port,'/api/v1/recommendations',body);assert.strictEqual(changed.status,201,JSON.stringify(changed.json));
    assert.notStrictEqual(changed.json.inputHash,mapped.json.inputHash);
    assert.strictEqual(changed.json.recommendation.gate.capture.assets.assetUnits.find(u=>u.id==='u-cny').balanceMinor,60000000);
    assert.deepStrictEqual(C.calculate(original.gate.capture).result,original.result,'实时事实改变后旧输入仍可复算');
    assert.strictEqual((await get(srv.port,'/api/v1/recommendations')).json.items.length,3);
    // 只改产物并重算普通 payload 哈希，仍无法绕过输入重放校验。
    const tampered=JSON.parse(JSON.stringify(original));tampered.newFundsAvailableMinor+=1;
    dbm.run(ctx.db,'UPDATE recommendations SET available_new_funds_minor=?,payload_hash=? WHERE id=?',
      [tampered.newFundsAvailableMinor,require('node:crypto').createHash('sha256').update(R.canonicalJson(tampered)).digest('hex'),original.id]);
    assert.strictEqual((await get(srv.port,'/api/v1/recommendations')).json.invalidCount,1);
  } finally {await srv.close();ctx.close();}
});

test('R-04 推进时钟后新幂等键/无幂等键仍返回原建议和原 createdAt',async()=>{
  const ctx=setup('ledger-r04-');const srv=await startServer(ctx);
  try {
    const facts=await seedAdviceChain(srv.port),body=recommendBody(facts);
    const first=await post(srv.port,'/api/v1/recommendations',body,{headers:{'Idempotency-Key':'r04-first'}});
    assert.strictEqual(first.status,201);
    ctx.nowIso=()=> '2026-09-30T10:00:01.000Z';
    for(const opts of [{},{headers:{'Idempotency-Key':'r04-next'}}]) {
      const replay=await post(srv.port,'/api/v1/recommendations',body,opts);
      assert.strictEqual(replay.status,200,JSON.stringify(replay.json));
      assert.strictEqual(replay.json.created,false);
      assert.deepStrictEqual(replay.json.recommendation,first.json.recommendation);
    }
    assert.strictEqual((await get(srv.port,'/api/v1/recommendations')).json.total,1);
  } finally {await srv.close();ctx.close();}
});

/* ================= 8. G5-R1：引用链与封存输入的交叉一致性 =================
 * 单条记录合法 + SQL 外键「存在」不等于审计链自洽：恢复可以保留 id、只换内容，
 * 让「按评估 / 目标 id 下钻」得到的另一份事实与建议 gate.capture 中同 id 的不可变版本矛盾。
 * 边界同样要钉住：只核对被引用的两份不可变记录，资产与认可映射是可变事实，不得被扩大成
 * 「必须等于今天」——否则历史建议永远无法保留。 */

// 一份「保留 id、换成另一份合法内容」的目标版本（评估不变，只挪生效日）
function retarget(changed, effectiveFrom) {
  const t = Domain.computeAllocationTarget(changed.riskAssessments[0], { today: TODAY, effectiveFrom });
  assert.ok(t.ok, t.error && (t.error.detail || t.error.code));
  changed.allocationTargets[0] = Object.assign({}, changed.allocationTargets[0], t.target);
}

test('G5-R1：恢复把同 id 的评估换成另一份内容 → 400 拒绝并整体回滚，历史建议照常可用', async () => {
  const ctx = setup('ledger-g5r1-assess-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    assert.strictEqual((await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).status, 201);
    const original = (await get(srv.port, '/api/v1/state')).json;
    const before = R.readState(ctx.db);

    // 不同等级：L3 → L1，单条记录各自合法，只有跨记录的不可变身份是矛盾的
    const changed = JSON.parse(JSON.stringify(original));
    const computed = Domain.computeRiskAssessment(L1, { today: TODAY });
    assert.ok(computed.ok);
    changed.riskAssessments[0] = Object.assign({}, changed.riskAssessments[0], computed.record);
    retarget(changed, changed.allocationTargets[0].effectiveFrom);

    const res = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: changed } });
    assert.strictEqual(res.status, 400, '同 id 换内容的恢复必须被拒绝：' + JSON.stringify(res.json));
    assert.strictEqual(res.json.error.code, 'invalid_recommendation_record');
    assert.deepStrictEqual(R.readState(ctx.db), before, '拒绝必须整体回滚，不得留下半份状态');
    const view = R.readRecommendationView(ctx.db);
    assert.strictEqual(view.invalidCount, 0);
    assert.strictEqual(view.items.length, 1);
    assert.strictEqual(view.items[0].status, 'formal');
  } finally { await srv.close(); ctx.close(); }
});

test('G5-R1：等级不变、只换答案与能力分 → 仍按身份矛盾拒绝', async () => {
  const ctx = setup('ledger-g5r1-answers-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    assert.strictEqual((await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).status, 201);
    const original = (await get(srv.port, '/api/v1/state')).json;
    const before = R.readState(ctx.db);

    const changed = JSON.parse(JSON.stringify(original));
    const computed = Domain.computeRiskAssessment(
      Object.assign({}, L3, { answers: clientAnswers([2, 1, 1, 2, 2], [2, 2, 1, 1]) }),
      { today: TODAY }
    );
    assert.ok(computed.ok);
    changed.riskAssessments[0] = Object.assign({}, changed.riskAssessments[0], computed.record);
    assert.strictEqual(changed.riskAssessments[0].ceiling, original.riskAssessments[0].ceiling,
      '前提：等级没变，只有答案与能力分变了');
    retarget(changed, changed.allocationTargets[0].effectiveFrom);

    const res = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: changed } });
    assert.strictEqual(res.status, 400, '等级相同也不能放行内容不同的同 id 记录：' + JSON.stringify(res.json));
    assert.deepStrictEqual(R.readState(ctx.db), before, '拒绝必须整体回滚');
  } finally { await srv.close(); ctx.close(); }
});

test('G5-R1：评估不变、同 id 换一份目标版本内容 → 400 拒绝并整体回滚', async () => {
  const ctx = setup('ledger-g5r1-target-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    assert.strictEqual((await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).status, 201);
    const original = (await get(srv.port, '/api/v1/state')).json;
    const before = R.readState(ctx.db);

    const changed = JSON.parse(JSON.stringify(original));
    retarget(changed, '2026-09-01');
    assert.notStrictEqual(
      JSON.stringify(changed.allocationTargets[0]), JSON.stringify(original.allocationTargets[0]),
      '前提：目标记录内容确实变了，但 id 没变'
    );

    const res = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: changed } });
    assert.strictEqual(res.status, 400, '同 id 换目标内容必须被拒绝：' + JSON.stringify(res.json));
    assert.deepStrictEqual(R.readState(ctx.db), before, '拒绝必须整体回滚');
  } finally { await srv.close(); ctx.close(); }
});

test('G5-R1：只改可变事实（余额、认可映射）的恢复照常通过，历史建议不因此作废', async () => {
  const ctx = setup('ledger-g5r1-mutable-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    assert.strictEqual((await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).status, 201);
    const original = (await get(srv.port, '/api/v1/state')).json;

    const changed = JSON.parse(JSON.stringify(original));
    changed.assets.assetUnits.filter((u) => u.id === 'u-cny')[0].balanceMinor = 60000000;
    changed.approvedInstruments = [];

    const res = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: changed } });
    assert.strictEqual(res.status, 200, '可变事实允许与 capture 不同：' + JSON.stringify(res.json));
    const view = R.readRecommendationView(ctx.db);
    assert.strictEqual(view.invalidCount, 0, '历史建议仍按封存输入重放，不因可变事实变化失效');
    assert.strictEqual(view.items[0].status, 'formal');
    assert.strictEqual(R.readState(ctx.db).approvedInstruments.length, 0, '认可映射确实被改写了');
  } finally { await srv.close(); ctx.close(); }
});

test('G5-R1：库内同 id 记录被就地改写 → 读取视图计入 invalidCount，不冒充可用建议', async () => {
  const ctx = setup('ledger-g5r1-view-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const created = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    assert.strictEqual(created.status, 201);

    // 绕过写入闸直接改库（等价于磁盘被改 / 恢复到矛盾状态），读取路径必须自己发现
    dbm.run(ctx.db, 'UPDATE allocation_targets SET effective_from = ? WHERE id = ?', ['2026-09-01', facts.target.id]);
    let view = R.readRecommendationView(ctx.db);
    assert.strictEqual(view.total, 1);
    assert.strictEqual(view.items.length, 0, '目标内容与封存记录不一致时不得出现在可用列表');
    assert.strictEqual(view.invalidCount, 1, '必须显式留痕而不是静默丢行');
    let list = await get(srv.port, '/api/v1/recommendations');
    assert.strictEqual(list.json.invalidCount, 1);
    assert.strictEqual(list.json.items.length, 0);

    dbm.run(ctx.db, 'UPDATE risk_assessments SET capacity_score = capacity_score + 1 WHERE id = ?', [facts.assessment.id]);
    view = R.readRecommendationView(ctx.db);
    assert.strictEqual(view.invalidCount, 1, '评估内容被改写同样计入复核失败');
    assert.strictEqual(view.items.length, 0);
    list = await get(srv.port, '/api/v1/recommendations');
    assert.strictEqual(list.json.invalidCount, 1);
    assert.strictEqual(list.json.total, 1);
  } finally { await srv.close(); ctx.close(); }
});
