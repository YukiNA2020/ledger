/* Phase 5E-5｜审计追溯：解释版本封存 / 未封存标注 / 记录键契约（D-052）
 *
 * 范围（PHASE5E_BREAKDOWN 5E-5）：
 *   - 新建议在 gate 区封存生成时的知识卡解释版本，且不改动 5D 的计算身份：
 *     inputHash / id / capture 重放等式与打章前逐位一致；
 *   - 旧建议（无 explanationVersion）照常合法、全量恢复往返保留原样；
 *     同一输入的重复请求永远回到库里原来那条，绝不回填解释版本；
 *   - 无 capture 的旧记录保留原文但读取视图计入 invalidCount，不冒充可验证建议；
 *   - gate 键契约显式化（checks 必需；capture / explanationVersion 可选；多余键拒绝）。
 * 全部离线：固定时钟、临时数据库、fixture 行情；不改分配算法与 5A 冻结规则。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

const api = require('../server/api');
const config = require('../server/config');
const R = require('../server/repository');
const Domain = require('../js/domain.js');
const Knowledge = require('../js/knowledge.js');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';
const TODAY = '2026-09-30';
const MONTH = '2026-09';
const ASSESSED = '2026-06-15';
const NOW_ISO = '2026-09-30T08:00:00.000Z';
const NEW_FUNDS_MINOR = 200000;   // CNY 2,000（与 5D S5.2 同一场景）

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
  ctx.port = server.address().port;
  return { port: ctx.port, close: () => new Promise((resolve) => server.close(resolve)) };
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
    // agent:false —— 连续起多个隔离服务时不让 keep-alive 挂住 server.close()
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

const CAP = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'capacity');
const WIL = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'willingness');
const byScore = (q, s) => q.options.filter((o) => o.score === s)[0].id;

function clientAnswers(capScores, wilScores) {
  const rows = [];
  capScores.forEach((s, i) => rows.push({ questionId: CAP[i].id, optionId: byScore(CAP[i], s) }));
  wilScores.forEach((s, i) => rows.push({ questionId: WIL[i].id, optionId: byScore(WIL[i], s) }));
  return rows;
}

// L3（能力 7 / 意愿 6）：与 5D 测试同一套构造
const L3 = { answers: clientAnswers([1, 1, 1, 2, 2], [2, 2, 1, 1]).slice().reverse(), assessedAt: ASSESSED, reason: 'initial' };

async function submitAssessment(port, payload) {
  const res = await post(port, '/api/v1/risk-assessments', payload);
  assert.strictEqual(res.status, 201, JSON.stringify(res.json));
  return res.json.item;
}

// 投资池按 S5.2 的冻结比例构造（总额 1 亿元 = 1e8 分），与 5D 测试同一份 fixture
function investmentAssets() {
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
  return a;
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
async function seedAdviceChain(port) {
  await seedState(port);
  const close = await post(port, '/api/v1/monthly-closes', { month: MONTH });
  assert.strictEqual(close.status, 201, JSON.stringify(close.json));
  assert.strictEqual(close.json.close.status, 'formal', '前置：本轮必须能正式结账');
  const assessment = await submitAssessment(port, L3);
  const target = await post(port, '/api/v1/targets', {});
  assert.strictEqual(target.status, 201, JSON.stringify(target.json));
  const mapped = await post(port, '/api/v1/approved-instruments', {
    assetClass: 'broad_equity', instrumentIds: ['ins-voo', 'ins-vgt']
  });
  assert.strictEqual(mapped.status, 200, JSON.stringify(mapped.json));
  return {
    close: close.json.close,
    snapshot: close.json.snapshot,
    assessment,
    target: target.json.item
  };
}

function recommendBody(facts) {
  return {
    snapshotRef: {
      closeId: facts.close.id,
      snapshotId: facts.snapshot.id,
      payloadHash: facts.snapshot.payloadHash
    },
    assessmentRef: { id: facts.assessment.id, ruleVersion: facts.assessment.ruleVersion },
    targetVersion: facts.target.templateVersion,
    ruleVersion: Domain.RISK_RULE_VERSION,
    newFundsMinor: NEW_FUNDS_MINOR
  };
}

// D-052 无 capture 旧记录的 inputHash 口径（与 server/repository.js 的 legacy 分支同一份字段）
function legacyInputHash(rec) {
  return crypto.createHash('sha256').update(R.canonicalJson({
    ruleVersion: rec.ruleVersion,
    targetVersion: rec.targetVersion,
    assessmentId: rec.assessmentId,
    targetId: rec.targetId,
    closeId: rec.closeId,
    snapshotId: rec.snapshotId,
    snapshotPayloadHash: rec.snapshotPayloadHash,
    dataCutoff: rec.dataCutoff,
    asOf: rec.asOf,
    requestedNewFundsMinor: rec.requestedNewFundsMinor,
    newFundsAvailableMinor: rec.newFundsAvailableMinor,
    allocatableNewFundsMinor: rec.allocatableNewFundsMinor,
    allocatedTotalMinor: rec.allocatedTotalMinor,
    status: rec.status
  })).digest('hex');
}

/* ================ 1. 新建议封存解释版本，且不改变 5D 计算身份 ================ */

test('5E-5 解释版本封存：POST 打章于 gate 区；inputHash / id / capture 重放逐位不变', async () => {
  const ctx = setup('ledger-p5e5-seal-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const first = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    assert.strictEqual(first.status, 201, JSON.stringify(first.json));
    const rec = first.json.recommendation;

    // 打章：值来自与前端同一份静态目录
    assert.strictEqual(rec.gate.explanationVersion, Knowledge.EXPLANATION_VERSION);
    assert.strictEqual(rec.status, 'formal', '前置：S5.2 场景应给出正式建议');

    // 不进计算身份：inputHash 仍只绑定 capture；剥离打章后哈希不变，id 由它导出
    assert.strictEqual(R.recommendationInputHash(rec), rec.inputHash);
    const stripped = JSON.parse(JSON.stringify(rec));
    delete stripped.payloadHash;   // payloadHash 是读取视图附加字段，不是记录键
    delete stripped.gate.explanationVersion;
    assert.strictEqual(R.recommendationInputHash(stripped), rec.inputHash, '打章不得进入 inputHash');
    assert.strictEqual(rec.id, 'rec-' + rec.inputHash.slice(0, 16));

    // 原 capture 可重放：打章后结果仍与 calculate(capture) 逐位一致
    const C = require('../server/recommendations');
    assert.deepStrictEqual(C.calculate(rec.gate.capture).result, rec.result);
    assert.deepStrictEqual(C.calculate(rec.gate.capture).checks, rec.gate.checks);

    // 未打章的旧形状记录照样合法（历史记录兼容契约）
    assert.strictEqual(Domain.validateRecommendationRecord(stripped).ok, true,
      JSON.stringify(Domain.validateRecommendationRecord(stripped).error));

    // 字段与 API / 库一致：全量状态里的记录与响应同章同哈希
    const st = (await get(srv.port, '/api/v1/state')).json;
    assert.strictEqual(st.recommendations.length, 1);
    assert.strictEqual(st.recommendations[0].gate.explanationVersion, Knowledge.EXPLANATION_VERSION);
    assert.strictEqual(st.recommendations[0].inputHash, rec.inputHash);

    const list = (await get(srv.port, '/api/v1/recommendations')).json;
    assert.strictEqual(list.invalidCount, 0);
    assert.strictEqual(list.total, 1);
    assert.strictEqual(list.items[0].gate.explanationVersion, Knowledge.EXPLANATION_VERSION);
    assert.match(list.items[0].payloadHash, /^[0-9a-f]{64}$/, '读取视图必须带记录 payloadHash');

    // 5D 完整输入建议可按原 capture 重放（重放一遍打章记录的整条链）
    assert.deepStrictEqual(C.calculate(list.items[0].gate.capture).result, list.items[0].result);
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================ 2. 旧建议未封存：往返原样、重复请求不倒填 ================ */

test('5E-5 旧建议未封存：全量恢复保留原样；同一输入重复请求回原行且不补章', async () => {
  const ctx = setup('ledger-p5e5-legacy-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const body = recommendBody(facts);
    const first = await post(srv.port, '/api/v1/recommendations', body);
    assert.strictEqual(first.status, 201, JSON.stringify(first.json));
    const stampedId = first.json.id;
    assert.ok(first.json.recommendation.gate.explanationVersion, '前置：新建议已封存解释版本');

    // 全量状态恢复往返：打章记录原样保留
    const st1 = (await get(srv.port, '/api/v1/state')).json;
    assert.strictEqual((await request(srv.port, 'PUT', '/api/v1/state', { body: { state: st1 } })).status, 200);
    const list1 = (await get(srv.port, '/api/v1/recommendations')).json;
    assert.strictEqual(list1.items[0].gate.explanationVersion, Knowledge.EXPLANATION_VERSION,
      '全量恢复往返不得丢失封存的解释版本');
    assert.strictEqual(list1.invalidCount, 0);

    // 把记录退回「升级前」形状（无 explanationVersion），模拟旧建议
    const st2 = (await get(srv.port, '/api/v1/state')).json;
    assert.strictEqual(st2.recommendations.length, 1);
    delete st2.recommendations[0].gate.explanationVersion;
    assert.strictEqual((await request(srv.port, 'PUT', '/api/v1/state', { body: { state: st2 } })).status, 200);

    const list2 = (await get(srv.port, '/api/v1/recommendations')).json;
    assert.strictEqual(list2.total, 1, '旧记录照常在列');
    assert.strictEqual(list2.invalidCount, 0, '未封存不是缺陷：旧记录必须仍可验证');
    assert.strictEqual(list2.items[0].id, stampedId);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(list2.items[0].gate, 'explanationVersion'), false,
      '旧记录不得凭空长出解释版本');

    // 同一输入重复请求（升级后的打章代码路径）：回到原行、状态 200、不回填
    const again = await post(srv.port, '/api/v1/recommendations', body);
    assert.strictEqual(again.status, 200, '同一份输入应幂等回到原行，不得报 duplicate');
    assert.strictEqual(again.json.id, stampedId);
    assert.strictEqual(again.json.created, false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(again.json.recommendation.gate, 'explanationVersion'), false,
      '重复请求返回的是库里原来那条，绝不倒填解释版本');

    // 再查一遍：仍是一条、仍未封存、计算身份不变
    const list3 = (await get(srv.port, '/api/v1/recommendations')).json;
    assert.strictEqual(list3.total, 1);
    assert.strictEqual(list3.invalidCount, 0);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(list3.items[0].gate, 'explanationVersion'), false);
    assert.strictEqual(list3.items[0].inputHash, list2.items[0].inputHash, 'inputHash 不因打章策略改变');
    assert.strictEqual(list3.items[0].id, stampedId);
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================ 3. 无 capture 的旧记录不冒充可验证建议 ================ */

test('5E-5 无 capture 旧记录：保留原文但读取视图计入 invalidCount，不进可用列表', async () => {
  const ctx = setup('ledger-p5e5-nocapture-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const first = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    assert.strictEqual(first.status, 201);

    // 构造升级前的「无 capture」记录形状：gate 只剩 checks，inputHash 走 legacy 口径
    const legacy = JSON.parse(JSON.stringify(first.json.recommendation));
    delete legacy.payloadHash;
    legacy.gate = { checks: legacy.gate.checks };
    legacy.inputHash = legacyInputHash(legacy);
    legacy.id = 'rec-' + legacy.inputHash.slice(0, 16);
    assert.strictEqual(Domain.validateRecommendationRecord(legacy).ok, true,
      '记录形状本身合法（缺 capture 是「不可验证」，不是「非法」）：' +
      JSON.stringify(Domain.validateRecommendationRecord(legacy).error));

    const st = (await get(srv.port, '/api/v1/state')).json;
    st.recommendations = [legacy];
    const put = await request(srv.port, 'PUT', '/api/v1/state', { body: { state: st } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.json));

    const list = (await get(srv.port, '/api/v1/recommendations')).json;
    assert.strictEqual(list.total, 1, '失效行不得静默消失');
    assert.strictEqual(list.invalidCount, 1, '无 capture 的旧记录必须显式计入 invalidCount');
    assert.deepStrictEqual(list.items, [], '不可验证的旧记录不得冒充可用建议');
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================ 4. gate 键契约与冻结 ================ */

test('5E-5 gate 键契约：checks 必需、可选键仅 capture / explanationVersion、多余键拒绝', () => {
  const contract = Domain.recommendation5DContract();
  assert.deepStrictEqual(contract.gateKeys, ['checks', 'capture', 'explanationVersion']);
  assert.deepStrictEqual(contract.gateRequiredKeys, ['checks']);
  assert.deepStrictEqual(Domain.RECOMMENDATION_GATE_KEYS, ['checks', 'capture', 'explanationVersion']);
  assert.strictEqual(Domain.RECOMMENDATION_RECORD_KEYS.length, 20, '顶层 recordKeys 保持 5D 冻结长度');
  assert.strictEqual(Domain.RECOMMENDATION_RECORD_KEYS[Domain.RECOMMENDATION_RECORD_KEYS.length - 1], 'result');
  assert.strictEqual(Domain.RECOMMENDATION_RECORD_KEYS.indexOf('explanationVersion'), -1,
    '解释版本在 gate 内，不是顶层记录键（顶层键集不扩展 → 旧记录照常通过）');

  // 契约快照是副本：写入不得回流
  contract.gateKeys.push('note');
  assert.strictEqual(Domain.recommendation5DContract().gateKeys.length, 3);

  // 冻结：运行时改不动
  assert.strictEqual(Object.isFrozen(Domain.RECOMMENDATION_GATE_KEYS), true);
  assert.strictEqual(Object.isFrozen(Domain.RECOMMENDATION_GATE_REQUIRED_KEYS), true);

  // 合法性矩阵用最小可行记录构造：gate 分支的判定与后续 result 校验（result 为 null 必然失败）区分开
  const checks = Domain.RECOMMENDATION_GATE_CHECKS.map((code) => ({ code: code, passed: true, detail: '' }));
  const base = {
    id: 'rec-' + 'a'.repeat(16), createdAt: '2026-09-30T10:00:00.000Z', status: 'formal',
    ruleVersion: Domain.RISK_RULE_VERSION, targetVersion: Domain.RISK_TARGET_VERSION,
    assessmentId: 'ra-1', targetId: 'at-1', closeId: 'mc-1', snapshotId: 'cs-1',
    snapshotPayloadHash: 'b'.repeat(64), dataCutoff: '2026-09-30', asOf: '2026-09-30',
    requestedNewFundsMinor: 0, newFundsAvailableMinor: 0,
    allocatableNewFundsMinor: 0, allocatedTotalMinor: 0,
    inputHash: 'c'.repeat(64), gate: { checks: checks }, todos: [], result: null
  };
  const gateOnly = (g) => {
    const probe = JSON.parse(JSON.stringify(base));
    probe.gate = g;
    const v = Domain.validateRecommendationRecord(probe);
    if (v.ok) return 'ok';
    if (v.error.detail.indexOf('gate 必须') === 0 || v.error.detail.indexOf('解释版本') === 0) return 'gate-rejected';
    if (v.error.code === 'invalid_recommendation_output') return 'gate-passed'; // gate 已通过，走到 result 校验
    return 'other-rejected';
  };
  assert.strictEqual(gateOnly({ checks: checks }), 'gate-passed', '旧形状 { checks } 不被 gate 分支拒绝');
  assert.strictEqual(gateOnly({ checks: checks, capture: { algorithmVersion: 'cash-reallocation-v1' } }), 'gate-passed',
    '5D 形状 { checks, capture } 不被 gate 分支拒绝');
  assert.strictEqual(gateOnly({ checks: checks, explanationVersion: '1' }), 'gate-passed',
    '打章形状不被 gate 分支拒绝');
  assert.strictEqual(gateOnly({ checks: checks, capture: {}, extra: 1 }), 'gate-rejected', '多余键必须拒绝');
  assert.strictEqual(gateOnly({ checks: checks, explanationVersion: 42 }), 'gate-rejected', '解释版本必须是非空字符串');
  assert.strictEqual(gateOnly({ checks: checks, explanationVersion: ' ' }), 'gate-rejected', '空白解释版本必须拒绝');
  assert.strictEqual(gateOnly({ capture: {} }), 'gate-rejected', '缺 checks 必须拒绝');
});
