/* Phase 6B｜状态机、事件、存储与 API｜服务端测试（临时数据库，虚构数据，真实 HTTP 入口）
 *
 * 对应 PHASE6_CONTRACT.md 的服务端部分（6B 范围）：
 *   - §1.2 数据驱动全遍历 7×7 = 49 个有序对（6 合法 / 43 非法，含自转移）：
 *     合法 → 状态改变且恰好追加 1 条事件；非法 → 409 illegal_transition 且
 *     状态、事件数、关联数全部不变（事务整体回滚）。上表即期望值；
 *   - §2 进入门禁：estimate 不进清单、unknown 引用 422、接受门禁（staleness）、
 *     一条建议一条决策（自然幂等 created:false）、intent 白名单、note 必填；
 *   - §8.6 幂等：同 key 同载荷回放、同 key 异载荷冲突、幂等记录与业务写入同事务；
 *   - §6.4 全量写入：伴随集合 6 → 9（缺键清空 / preserve 保留 / 显式空集合清空 / 非数组拒绝）、
 *     引用完整性、删除被关联引用的事件 → linked_event_missing、活动关联唯一；
 *   - §4.5 读取复核：篡改快照原文 / seq 断链 / 状态与事件链不一致 → invalidCount 留痕、
 *     详情与 /state 400 invalid_decision_record；损坏候选备份在切换前拒止、活库不变；
 *   - §9 / §10 F-A / F-B：两套闭环 fixture（单笔同月无偏差、分批跨月有偏差 + 备份恢复往返）、
 *     月度归属（本地事件月）、迁移 v10→v11 空表、备份结构校验（部分唯一索引对称拒止）。
 * 全部离线：注入 today / nowIso，零真实网络，不读取私人账本。
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
const migrations = require('../server/migrations');
const Domain = require('../js/domain.js');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';
const TODAY = '2026-09-30';
const MONTH = '2026-09';
const ASSESSED = '2026-06-15';
const NOW_ISO = '2026-09-30T08:00:00.000Z';
const NEW_FUNDS_MINOR = 200000;   // CNY 2,000（S5.2 同源）

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
const put = (port, pathname, body, opts) => request(port, 'PUT', pathname, Object.assign({ body }, opts || {}));

/* ------------------------------ 事实构造 helper（与 5D 测试同源） ------------------------------ */

const CAP = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'capacity');
const WIL = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'willingness');
const byScore = (q, s) => q.options.filter((o) => o.score === s)[0].id;

function clientAnswers(capScores, wilScores) {
  const rows = [];
  capScores.forEach((s, i) => rows.push({ questionId: CAP[i].id, optionId: byScore(CAP[i], s) }));
  wilScores.forEach((s, i) => rows.push({ questionId: WIL[i].id, optionId: byScore(WIL[i], s) }));
  return rows;
}

const L3 = { answers: clientAnswers([1, 1, 1, 2, 2], [2, 2, 1, 1]), assessedAt: ASSESSED, reason: 'initial' };

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
    { id: 'ins-voo', symbol: 'VOO', exchange: 'SSE', currency: 'CNY', name: '宽基A', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
    { id: 'ins-vgt', symbol: 'VGT', exchange: 'SSE', currency: 'CNY', name: '宽基B', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
    { id: 'ins-hkd', symbol: '2800', exchange: 'HKEX', currency: 'HKD', name: '港股宽基', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'HK', classificationStatus: 'confirmed' }
  ];
  a.holdings = [
    { id: 'h-voo', accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '50000', costMinor: 5000000, asOf: TODAY }
  ];
  a.quotes = [
    { instrumentId: 'ins-voo', priceMinor: 100, currency: 'CNY', priceDate: TODAY, provider: 'manual', status: 'ok' },
    { instrumentId: 'ins-vgt', priceMinor: 100, currency: 'CNY', priceDate: TODAY, provider: 'manual', status: 'ok' }
  ];
  a.fxRates = [{ base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: TODAY, provider: 'manual', status: 'ok' }];
  return Object.assign(a, over || {});
}

async function seedState(port, assets) {
  const state = (await get(port, '/api/v1/state')).json;
  state.assets = assets || investmentAssets();
  const res = await put(port, '/api/v1/state', { state: Object.assign({}, state, {
    riskAssessments: [], allocationTargets: [], approvedInstruments: [], recommendations: [],
    decisions: [], decisionEvents: [], decisionLinks: []
  }) });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  return state.assets;
}

// 一条完整可建议的事实链：资产 → 正式结账 → 评估 → 目标 → 认可标的
async function seedAdviceChain(port, opts) {
  const o = opts || {};
  await seedState(port, o.assets);
  const close = await post(port, '/api/v1/monthly-closes', { month: MONTH });
  assert.strictEqual(close.status, 201, JSON.stringify(close.json));
  assert.strictEqual(close.json.close.status, 'formal', '前置：本轮必须能正式结账');
  const assessment = await post(port, '/api/v1/risk-assessments', L3);
  assert.strictEqual(assessment.status, 201, JSON.stringify(assessment.json));
  const target = await post(port, '/api/v1/targets', {});
  assert.strictEqual(target.status, 201, JSON.stringify(target.json));
  if (o.approved !== false) {
    const mapped = await post(port, '/api/v1/approved-instruments', {
      assetClass: 'broad_equity', instrumentIds: ['ins-voo', 'ins-vgt']
    });
    assert.strictEqual(mapped.status, 200, JSON.stringify(mapped.json));
  }
  return { close: close.json.close, snapshot: close.json.snapshot, assessment: assessment.json.item, target: target.json.item };
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

// 通过全量写入登记一笔 buy 并活动关联到决策（6B 没有关联 HTTP 入口，属 6D）。
// 默认 20 × 100.00 CNY = 2,000.00 本金（priceMinor 10000 = 每股 100 元），fee 5.00 单列。
function buyEvent(id, over) {
  return Object.assign({
    id: id, accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'buy',
    quantity: '20', priceMinor: 10000, feeMinor: 500, occurredAt: TODAY
  }, over || {});
}

function activeLink(id, decisionId, securityEventId, over) {
  // link id 必须是 lnk-<16hex>：由 (decisionId, securityEventId) 确定性派生，形状稳定可复现
  const crypto = require('node:crypto');
  const linkId = 'lnk-' + crypto.createHash('sha256')
    .update('decision-link:' + decisionId + ':' + securityEventId).digest('hex').slice(0, 16);
  return Object.assign({
    id: linkId, decisionId: decisionId, securityEventId: securityEventId,
    linkedOn: TODAY, linkedAt: NOW_ISO, note: '关联买入',
    unlinkedOn: null, unlinkedAt: null, unlinkNote: null
  }, over || {});
}

async function putFullState(port, mutate) {
  const st = (await get(port, '/api/v1/state')).json;
  if (mutate) mutate(st);
  return put(port, '/api/v1/state', { state: st });
}

/* ================= 1. 契约 §1.2：49 个有序对全遍历 ================= */

test('6B-11 数据驱动全遍历 49 个有序对：合法 6 恰好追加 1 条事件，非法 43 全部整体回滚', async () => {
  const ctx = setup('ledger-p6a-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    let recSeed = 0;
    async function newRecommendation() {
      recSeed += 1;
      const res = await post(srv.port, '/api/v1/recommendations',
        recommendBody(facts, { newFundsMinor: NEW_FUNDS_MINOR + recSeed }));
      assert.strictEqual(res.status, 201, JSON.stringify(res.json));
      assert.strictEqual(res.json.recommendation.status, 'formal', '前置：本用例需要 formal 建议');
      return res.json.recommendation;
    }
    async function createDecision(rec, intent, note) {
      const body = intent ? { recommendationId: rec.id, intent: intent, note: note }
        : { recommendationId: rec.id };
      const res = await post(srv.port, '/api/v1/decisions', body);
      assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.json));
      return res.json.decision;
    }
    async function seedLink(decisionId) {
      const res = await putFullState(srv.port, (st) => {
        st.assets.securityEvents = st.assets.securityEvents.concat([
          buyEvent('sev-' + decisionId.slice(4))
        ]);
        st.decisionLinks = (st.decisionLinks || []).concat([
          activeLink('sev-' + decisionId.slice(4), decisionId, 'sev-' + decisionId.slice(4))
        ]);
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    }
    // 构造一条处于指定 from 状态的全新决策（每个有序对一个全新决策，互不污染）
    async function decisionInState(from, withLink) {
      const rec = await newRecommendation();
      if (from === 'proposed') return createDecision(rec, null);
      if (from === 'deferred') return createDecision(rec, 'deferred', '暂缓理由');
      if (from === 'dismissed') return createDecision(rec, 'dismissed', '忽略理由');
      const d = await createDecision(rec, 'accepted', '接受理由');
      if (from === 'accepted') {
        // (accepted, executed) 被测对也需要预置活动关联，才能走合法跳转
        if (withLink) await seedLink(d.id);
        return d;
      }
      if (from === 'archived') {
        const ev = await post(srv.port, '/api/v1/decisions/' + d.id + '/events', { toState: 'archived', note: '放弃' });
        assert.strictEqual(ev.status, 200, JSON.stringify(ev.json));
        return ev.json.decision;
      }
      if (withLink) await seedLink(d.id);
      const ev = await post(srv.port, '/api/v1/decisions/' + d.id + '/events',
        { toState: 'executed', note: '执行说明' });
      assert.strictEqual(ev.status, 200, JSON.stringify({ at: 'decisionInState', from: from, withLink: withLink, decision: d.id, res: ev.json }));
      if (from === 'executed') return ev.json.decision;
      const rv = await post(srv.port, '/api/v1/decisions/' + d.id + '/events', { toState: 'reviewed', note: '复盘理由' });
      assert.strictEqual(rv.status, 200, JSON.stringify(rv.json));
      return rv.json.decision;
    }

    let legalCount = 0;
    let illegalCount = 0;
    const legalSeen = [];
    for (const from of Domain.DECISION_STATES) {
      for (const to of Domain.DECISION_STATES) {
        const legal = Domain.isLegalDecisionTransition(from, to);
        // executed/reviewed 的到达必须有关联；accepted→executed 的被测对同样要预置关联
        const withLink = from === 'executed' || from === 'reviewed' || (from === 'accepted' && to === 'executed');
        const d = await decisionInState(from, withLink);
        const before = (await get(srv.port, '/api/v1/decisions/' + d.id)).json;
        const res = await post(srv.port, '/api/v1/decisions/' + d.id + '/events',
          { toState: to, note: '转移理由' });
        if (legal) {
          legalCount += 1;
          legalSeen.push(from + '->' + to);
          assert.strictEqual(res.status, 200, from + '→' + to + ' 应合法：' + JSON.stringify(res.json));
          assert.strictEqual(res.json.decision.state, to, from + '→' + to);
          assert.strictEqual(res.json.decision.lastSeq, before.decision.lastSeq + 1,
            from + '→' + to + ' 必须恰好追加 1 条事件');
          assert.strictEqual(res.json.events.length, before.events.length + 1);
          assert.strictEqual(res.json.links.length, before.links.length, '状态事件不得改动关联行');
        } else {
          illegalCount += 1;
          assert.strictEqual(res.status, 409, from + '→' + to + ' 应非法：' + JSON.stringify(res.json));
          assert.strictEqual(res.json.error.code, 'illegal_transition');
          // 事务整体回滚：状态、事件条数、关联条数全部不变
          const after = (await get(srv.port, '/api/v1/decisions/' + d.id)).json;
          assert.strictEqual(after.decision.state, before.decision.state, from + '→' + to + ' 状态不得改变');
          assert.strictEqual(after.events.length, before.events.length, from + '→' + to + ' 不得追加事件');
          assert.strictEqual(after.links.length, before.links.length, from + '→' + to + ' 不得改动关联');
        }
      }
    }
    assert.strictEqual(legalCount, 6, '合法有序对恰好 6');
    assert.strictEqual(illegalCount, 43, '非法有序对恰好 43（含自转移）');
    assert.deepStrictEqual(legalSeen.sort(), [
      'accepted->archived', 'accepted->executed', 'executed->reviewed',
      'proposed->accepted', 'proposed->deferred', 'proposed->dismissed'
    ].sort(), '合法集合必须与契约 §1.2 完全一致');
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================= 2. §2 进入门禁与 §8.1 创建契约 ================= */

test('6B-12 创建门禁：estimate 不可决策、未知引用 422、intent 白名单、note 必填、派生键拒绝', async () => {
  const ctx = setup('ledger-p6b-');
  const srv = await startServer(ctx);
  try {
    // 估算建议：月结只存估算（缺持仓核对外的关键 blocker 不引入，直接用非正式结账）
    const factsEstimate = await seedAdviceChain(srv.port, { approved: false });
    const estClose = await post(srv.port, '/api/v1/monthly-closes', { month: '2026-09', status: 'estimate' });
    assert.strictEqual(estClose.status, 201);
    // 用估算结账的快照生成建议 → estimate
    const estRec = await post(srv.port, '/api/v1/recommendations', recommendBody({
      close: { id: 'close-2026-09' },
      snapshot: { id: estClose.json.snapshot.id, payloadHash: estClose.json.snapshot.payloadHash },
      assessment: factsEstimate.assessment,
      target: factsEstimate.target
    }, { snapshotRef: { closeId: 'close-2026-09', snapshotId: estClose.json.snapshot.id, payloadHash: estClose.json.snapshot.payloadHash } }));
    if (estRec.status === 201 && estRec.json.recommendation.status === 'estimate') {
      const res = await post(srv.port, '/api/v1/decisions', { recommendationId: estRec.json.recommendation.id, intent: 'accepted', note: 'x' });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.json.error.code, 'recommendation_not_formal');
    }

    const facts = await seedAdviceChain(srv.port, {});
    const rec = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    assert.strictEqual(rec.json.recommendation.status, 'formal');

    // 未知建议 → 422 unknown_recommendation（载荷引用口径）
    const unknown = await post(srv.port, '/api/v1/decisions', { recommendationId: 'rec-nonexistent0000' });
    assert.strictEqual(unknown.status, 422);
    assert.strictEqual(unknown.json.error.code, 'unknown_recommendation');

    // intent 取 executed/reviewed/archived/proposed → 409 illegal_transition，且不创建任何决策行
    const listBefore = (await get(srv.port, '/api/v1/decisions')).json;
    for (const intent of ['executed', 'reviewed', 'archived', 'proposed']) {
      const res = await post(srv.port, '/api/v1/decisions', { recommendationId: rec.json.recommendation.id, intent: intent, note: 'x' });
      assert.strictEqual(res.status, 409, 'intent=' + intent);
      assert.strictEqual(res.json.error.code, 'illegal_transition');
    }
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.total, listBefore.total,
      '非法 intent 不得创建任何决策行');

    // 服务端派生键出现在载荷 → 400 invalid_decision_payload
    const payload = { recommendationId: rec.json.recommendation.id, intent: 'accepted', note: 'x' };
    payload.occurredAt = '2026-01-01';
    const derived = await post(srv.port, '/api/v1/decisions', payload);
    assert.strictEqual(derived.status, 400);
    assert.strictEqual(derived.json.error.code, 'invalid_decision_payload');

    // accepted / deferred / dismissed 必填 note
    for (const intent of ['accepted', 'deferred', 'dismissed']) {
      const res = await post(srv.port, '/api/v1/decisions', { recommendationId: rec.json.recommendation.id, intent: intent });
      assert.strictEqual(res.status, 400, 'intent=' + intent + ' 缺 note');
      assert.strictEqual(res.json.error.code, 'invalid_decision_payload');
    }

    // 一步创建并接受：201 + 快照封存 + 事件 seq=1
    const ok = await post(srv.port, '/api/v1/decisions', { recommendationId: rec.json.recommendation.id, intent: 'accepted', note: '按建议执行' });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.json.created, true);
    assert.strictEqual(ok.json.decision.state, 'accepted');
    assert.strictEqual(ok.json.decision.lastSeq, 1);
    assert.strictEqual(ok.json.events.length, 1);
    assert.strictEqual(ok.json.events[0].reasonCode, 'agree');
    assert.strictEqual(ok.json.events[0].actor, 'local-user');
    assert.ok(ok.json.events[0].snapshot, '决策时点快照必须封存');
    assert.deepStrictEqual(ok.json.decision.eventMonths, [MONTH]);
    const decisionId = ok.json.decision.id;

    // 自然幂等：同一建议再次创建 → 200 created:false + 既有决策，不套用本次 intent/note
    const again = await post(srv.port, '/api/v1/decisions', { recommendationId: rec.json.recommendation.id, intent: 'dismissed', note: '试图覆盖' });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.created, false);
    assert.strictEqual(again.json.decision.id, decisionId);
    assert.strictEqual(again.json.decision.state, 'accepted', '既有决策不得被第二次请求改写');
    assert.strictEqual(again.json.events.length, 1, '不得追加事件');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.total, listBefore.total + 1);
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-13 接受门禁：事实变化后 acceptance 409 recommendation_stale；deferred 不重核照常归档', async () => {
  const ctx = setup('ledger-p6c-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    assert.strictEqual(rec.json.recommendation.status, 'formal');
    const recId = rec.json.recommendation.id;

    // 改变可变事实（撤销认可映射 → mapping_changed）后接受必须被服务端重核拒绝
    const remap = await post(srv.port, '/api/v1/approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['ins-vgt'] });
    assert.strictEqual(remap.status, 200);
    const stale = await post(srv.port, '/api/v1/decisions', { recommendationId: recId, intent: 'accepted', note: 'x' });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.error.code, 'recommendation_stale');

    // 同一条失效建议暂缓是合法诉求（deferred / dismissed 不做时效重核，§2.2）
    const deferred = await post(srv.port, '/api/v1/decisions', { recommendationId: recId, intent: 'deferred', note: '先放一放' });
    assert.strictEqual(deferred.status, 201, JSON.stringify(deferred.json));
    assert.strictEqual(deferred.json.decision.state, 'deferred');
    assert.strictEqual(deferred.json.events[0].reasonCode, 'postpone');
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================= 3. §8.6 幂等 ================= */

test('6B-14 幂等：同 key 同载荷回放、同 key 异载荷 409；事件端点无自然幂等（重复提交 409）', async () => {
  const ctx = setup('ledger-p6d-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = await post(srv.port, '/api/v1/recommendations', recommendBody(facts));
    const recId = rec.json.recommendation.id;

    const first = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recId, intent: 'accepted', note: '第一次' }, { headers: { 'Idempotency-Key': 'dec-key-1' } });
    assert.strictEqual(first.status, 201);
    const replay = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recId, intent: 'accepted', note: '第一次' }, { headers: { 'Idempotency-Key': 'dec-key-1' } });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.headers['x-ledger-idempotent'], 'replay');
    assert.strictEqual(replay.json.decision.id, first.json.decision.id);
    const conflict = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recId, intent: 'deferred', note: '另一次语义' }, { headers: { 'Idempotency-Key': 'dec-key-1' } });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.json.error.code, 'idempotency_conflict');

    // 事件端点没有自然幂等：同状态重复提交即自转移 409；带幂等键时同载荷回放。
    // （注意 accepted 的合法出口只有 executed / archived：这里用 archived 做回放样本。）
    const decisionId = first.json.decision.id;
    const ev1 = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'archived', note: '放弃执行' }, { headers: { 'Idempotency-Key': 'ev-key-1' } });
    assert.strictEqual(ev1.status, 200, JSON.stringify(ev1.json));
    const evReplay = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'archived', note: '放弃执行' }, { headers: { 'Idempotency-Key': 'ev-key-1' } });
    assert.strictEqual(evReplay.status, 200);
    assert.strictEqual(evReplay.headers['x-ledger-idempotent'], 'replay');
    assert.strictEqual(evReplay.json.decision.lastSeq, ev1.json.decision.lastSeq, '重放不得追加事件');
    const evConflict = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'executed', note: '别的语义' }, { headers: { 'Idempotency-Key': 'ev-key-1' } });
    assert.strictEqual(evConflict.status, 409);
    assert.strictEqual(evConflict.json.error.code, 'idempotency_conflict');
    const dup = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'reviewed', note: '双击' });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.json.error.code, 'illegal_transition', 'archived 已是终态：自转移非法');
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================= 4. F-A：单笔、同月、无偏差 ================= */

test('6B-15 F-A 闭环：accepted → 关联 2,000 元买入 → executed（无偏差）→ reviewed，三时点快照齐全', async () => {
  const ctx = setup('ledger-p6e-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    assert.strictEqual(rec.allocatedTotalMinor, NEW_FUNDS_MINOR);
    const accepted = await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '分两笔执行' });
    const decisionId = accepted.json.decision.id;

    // 关联前 executed 必须拒绝
    const early = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events', { toState: 'executed' });
    assert.strictEqual(early.status, 409);
    assert.strictEqual(early.json.error.code, 'no_linked_events');

    // 20 × 100.00 CNY = 2,000.00 本金 = 建议金额（F-A 勘误后的数值），fee 5.00 单列
    const linked = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-fa')]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-fa', decisionId, 'sev-fa')]);
    });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));

    const executed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events', { toState: 'executed' });
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.json));
    assert.strictEqual(executed.json.decision.state, 'executed');
    assert.strictEqual(executed.json.events[1].reasonCode, 'executed_as_planned', 'diff = 0 → 无偏差理由码');
    assert.strictEqual(executed.json.execution.linkedPrincipalCnyMinor, 200000);
    assert.strictEqual(executed.json.execution.linkedFeeCnyMinor, 500, '手续费单列，不进本金');
    assert.strictEqual(executed.json.execution.remainingMinor, 0);
    assert.strictEqual(executed.json.events[1].snapshot.execution.linkedCount, 1);

    const reviewed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events', { toState: 'reviewed', note: '已回到区间内' });
    assert.strictEqual(reviewed.status, 200);
    assert.strictEqual(reviewed.json.events[2].reasonCode, 'reviewed_no_drift', '配置未变 → 无漂移');
    assert.strictEqual(reviewed.json.decision.state, 'reviewed');

    // 三时点快照齐全；reviewed 后一切只读
    const detail = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    assert.ok(detail.snapshots.decision && detail.snapshots.executed && detail.snapshots.reviewed);
    assert.strictEqual(detail.snapshots.decision.execution.linkedCount, 0, '决策时点尚未关联');
    assert.strictEqual(detail.snapshots.executed.execution.linkedPrincipalCnyMinor, 200000);
    assert.strictEqual(detail.decision.state, 'reviewed');
    assert.strictEqual(detail.events.length, 3);
    assert.strictEqual(detail.timeline.filter((t) => t.kind === 'state').length, 3);
    assert.strictEqual(detail.timeline.filter((t) => t.kind === 'link').length, 1);
    const frozen = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events', { toState: 'executed', note: '再动一下' });
    assert.strictEqual(frozen.status, 409, 'reviewed 是终态');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions/' + decisionId)).json.events.length, 3);
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================= 5. F-B：分批、跨月、有偏差 + 备份恢复往返 ================= */

test('6B-16 F-B 闭环（契约 §10.1 原样）：5,000 元建议、HKD 0.9、300 元偏差、跨月事件月、备份恢复', async () => {
  const ctx = setup('ledger-p6f-');
  const srv = await startServer(ctx);
  try {
    // 步骤 1：9 月正式建议 rec-B（5,000.00 CNY）——与 F-A 无共用事件（本测试独立建库）
    const facts = await seedAdviceChain(srv.port);
    // 10 月核对现金（余额 asOf 推进到 10 月）并补 10 月行情，使 10-04 的接受快照可比
    const oct = await putFullState(srv.port, (st) => {
      st.assets.assetUnits = st.assets.assetUnits.map((u) =>
        Object.assign({}, u, { asOf: '2026-10-04' }));
      st.assets.quotes = st.assets.quotes.concat([
        { instrumentId: 'ins-voo', priceMinor: 100, currency: 'CNY', priceDate: '2026-10-02', provider: 'manual', status: 'ok' }
      ]);
    });
    assert.strictEqual(oct.status, 200, JSON.stringify(oct.json));
    ctx.today = () => '2026-10-04';
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: 500000 }))).json.recommendation;
    assert.strictEqual(rec.status, 'formal');
    assert.strictEqual(rec.allocatedTotalMinor, 500000);
    const accepted = await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '分批执行' });
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.json));
    const decisionId = accepted.json.decision.id;
    assert.deepStrictEqual(accepted.json.decision.eventMonths, ['2026-10']);

    // 步骤 2/3：10 月 CNY buy 20 × 100.00 = 2,000.00；11 月 HKD buy 30 × 100.00 = 3,000 HKD，
    // 交易日 as-of HKD→CNY 0.9 → 2,700.00 CNY；本金合计 4,700.00。仅关联不产生状态事件。
    const seeded = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([
        buyEvent('sev-fb1', { quantity: '20', priceMinor: 10000, feeMinor: 0, occurredAt: '2026-10-02' }),
        buyEvent('sev-fb2', { instrumentId: 'ins-hkd', quantity: '30', priceMinor: 10000, feeMinor: 0, occurredAt: '2026-11-05' })
      ]);
      st.decisionLinks = (st.decisionLinks || []).concat([
        activeLink('sev-fb1', decisionId, 'sev-fb1'),
        activeLink('sev-fb2', decisionId, 'sev-fb2')
      ]);
      st.assets.quotes = st.assets.quotes.concat([
        { instrumentId: 'ins-voo', priceMinor: 100, currency: 'CNY', priceDate: '2026-11-18', provider: 'manual', status: 'ok' },
        { instrumentId: 'ins-hkd', priceMinor: 10000, currency: 'HKD', priceDate: '2026-11-18', provider: 'manual', status: 'ok' }
      ]);
      st.assets.fxRates = st.assets.fxRates.concat([
        { base: 'HKD', quote: 'CNY', rateDecimal: '0.9', rateDate: '2026-11-01', provider: 'manual', status: 'ok' },
        { base: 'HKD', quote: 'CNY', rateDecimal: '0.9', rateDate: '2026-11-18', provider: 'manual', status: 'ok' }
      ]);
      st.assets.assetUnits = st.assets.assetUnits.map((u) =>
        Object.assign({}, u, { asOf: '2026-11-18' }));
    });
    assert.strictEqual(seeded.status, 200, JSON.stringify(seeded.json));
    ctx.today = () => '2026-09-30';
    const mid = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    assert.deepStrictEqual(mid.decision.eventMonths, ['2026-10'], '步骤 3：仅关联，不产生状态事件');
    assert.strictEqual(mid.execution.linkedCount, 2);
    assert.strictEqual(mid.execution.linkedPrincipalCnyMinor, 470000, '2,000.00 + 3,000 HKD × 0.9 = 4,700.00');
    assert.strictEqual(mid.execution.remainingMinor, 30000, '未完成部分 300.00 CNY');
    assert.deepStrictEqual(mid.execution.fxUnavailable, []);

    // 步骤 4：11 月核对现金后 executed（diff = -300.00，note 必填）→ eventMonths 加入 11 月
    ctx.today = () => '2026-11-20';
    const noNote = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events', { toState: 'executed' });
    assert.strictEqual(noNote.status, 400);
    assert.strictEqual(noNote.json.error.code, 'deviation_note_required');
    const executed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'executed', note: '少投 300 元保留现金' });
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.json));
    assert.strictEqual(executed.json.events[1].reasonCode, 'executed_deviation');
    assert.strictEqual(executed.json.execution.linkedPrincipalCnyMinor, 470000);
    assert.strictEqual(executed.json.execution.remainingMinor, 30000);
    assert.deepStrictEqual(executed.json.decision.eventMonths, ['2026-10', '2026-11'], '步骤 4：追加 11 月状态事件');

    // 步骤 5：reviewed → 三时点快照齐全且六类对照逐 basis point 可复算（执行与复盘同日同值）
    const reviewed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'reviewed', note: '对照可复算' });
    assert.strictEqual(reviewed.status, 200);
    assert.strictEqual(reviewed.json.events[2].reasonCode, 'reviewed_no_drift');
    const before = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    for (const key of ['decision', 'executed', 'reviewed']) {
      assert.strictEqual(before.snapshots[key].available, true, key + ' 快照可比');
      assert.strictEqual(before.snapshots[key].classes.length, 6);
    }
    assert.deepStrictEqual(before.snapshots.reviewed.classes, before.snapshots.executed.classes,
      '复盘与执行时点的六类对照逐 basis point 一致');
    assert.strictEqual(before.snapshots.executed.execution.remainingMinor, 30000);

    // 步骤 6：生成 SQLite 备份 → 清空到空库 → 恢复 → 逐字段一致
    const backup = await post(srv.port, '/api/v1/backups', {});
    assert.strictEqual(backup.status, 201, JSON.stringify(backup.json));
    const clear = await request(srv.port, 'DELETE', '/api/v1/state', { headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(clear.status, 200, JSON.stringify(clear.json));
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.total, 0, '清空到空库');
    const restore = await post(srv.port, '/api/v1/restores', { file: backup.json.backup.name });
    assert.strictEqual(restore.status, 200, JSON.stringify(restore.json));
    ctx.adopt(restore);
    assert.strictEqual(restore.json.schemaVersion, migrations.LATEST_VERSION);
    const after = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    assert.deepStrictEqual(after, before, '恢复后状态、事件顺序、关联、快照、引用与建议逐字段一致');
    const list = (await get(srv.port, '/api/v1/decisions')).json;
    assert.strictEqual(list.invalidCount, 0);
    assert.deepStrictEqual(list.items[0].eventMonths, ['2026-10', '2026-11']);
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-23 缺汇率语义（契约 §10.2-20）：三个 CNY 汇总全为 null、linkedCount 保留、executed_deviation', async () => {
  const ctx = setup('ledger-p6m-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: 250000 }))).json.recommendation;
    const decisionId = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '缺汇率' })).json.decision.id;
    const linked = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([
        buyEvent('sev-fx1', { quantity: '15', priceMinor: 10000, feeMinor: 0, occurredAt: '2026-09-05' }),
        buyEvent('sev-fx2', { instrumentId: 'ins-hkd', quantity: '5', priceMinor: 10000, feeMinor: 0, occurredAt: '2026-11-05' })
      ]);
      st.decisionLinks = (st.decisionLinks || []).concat([
        activeLink('sev-fx1', decisionId, 'sev-fx1'),
        activeLink('sev-fx2', decisionId, 'sev-fx2')
      ]);
    });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));
    const detail = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    assert.strictEqual(detail.execution.linkedCount, 2, 'linkedCount 仍是实际活动关联条数');
    assert.strictEqual(detail.execution.linkedPrincipalCnyMinor, null, '缺汇率 → 本金 null，绝不部分小计');
    assert.strictEqual(detail.execution.linkedFeeCnyMinor, null);
    assert.strictEqual(detail.execution.remainingMinor, null);
    assert.deepStrictEqual(detail.execution.fxUnavailable, ['sev-fx2']);
    const noNote = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events', { toState: 'executed' });
    assert.strictEqual(noNote.status, 400);
    assert.strictEqual(noNote.json.error.code, 'deviation_note_required');
    const executed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'executed', note: '汇率无来源，按不可判定记录' });
    assert.strictEqual(executed.status, 200);
    assert.strictEqual(executed.json.events[1].reasonCode, 'executed_deviation');
    assert.strictEqual(executed.json.events[1].snapshot.execution.linkedPrincipalCnyMinor, null,
      '封存快照的 execution 使用同一形状');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-17 全量写入：普通五键保存保留三集合、缺键清空、显式空集合清空、非数组拒绝', async () => {
  const ctx = setup('ledger-p6g-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const decisionId = (await post(srv.port, '/api/v1/decisions',
      { recommendationId: rec.id, intent: 'accepted', note: '保留测试' })).json.decision.id;

    // 页面记账语义（preserve 标志）：未显式给出的三集合必须在事务内保留。
    // 资产集合与真实 UI 一致原样携带（五键保存不表达删除资产事实）。
    const stBefore = (await get(srv.port, '/api/v1/state')).json;
    const fiveKeys = await put(srv.port, '/api/v1/state', {
      state: { accounts: [], categories: [], txns: [], settings: {}, assets: stBefore.assets },
      preserveCompanionCollections: true
    });
    assert.strictEqual(fiveKeys.status, 200, JSON.stringify(fiveKeys.json));
    assert.strictEqual((await get(srv.port, '/api/v1/decisions/' + decisionId)).json.decision.id, decisionId,
      '普通五键保存不得删除决策历史');

    // 显式清空：决策三集合是同生共死的引用整体，一起给空数组才是「清空决策」；
    // 只清 decisions 而留下孤儿事件会被引用完整性校验拒绝（400）。
    const d2 = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '第二次' })).json.decision;
    const orphan = await putFullState(srv.port, (st) => { st.decisions = []; });
    assert.strictEqual(orphan.status, 400, JSON.stringify(orphan.json));
    assert.strictEqual(orphan.json.error.code, 'invalid_decision_record', '孤儿事件不得通过引用完整性校验');
    const explicitClear = await putFullState(srv.port, (st) => {
      st.decisions = []; st.decisionEvents = []; st.decisionLinks = [];
    });
    assert.strictEqual(explicitClear.status, 200);
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.total, 0, '显式空集合就是清空');

    // 非数组 → 400 invalid_asset_collection（整体拒绝，活库不变）
    const bad = await putFullState(srv.port, (st) => { st.decisionEvents = 'nope'; });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error.code, 'invalid_asset_collection');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.total, 0, '拒绝的写入不得改变活库');

    // 缺键且无 preserve 标志 = 旧备份整份恢复语义 → 缺键即清空（放在最后，会清掉全部事实）
    const bare = await put(srv.port, '/api/v1/state', {
      state: { accounts: [], categories: [], txns: [], settings: {}, assets: Domain.emptyAssets() }
    });
    assert.strictEqual(bare.status, 200);
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.total, 0, '缺键清空恢复为空历史');
    assert.strictEqual((await get(srv.port, '/api/v1/recommendations')).json.total, 0, '缺键清空同样作用于既有伴随集合');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-18 全量写入引用完整性：删除被关联引用的事件 → linked_event_missing；双活动关联 → event_already_linked', async () => {
  const ctx = setup('ledger-p6h-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const decisionId = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '引用测试' })).json.decision.id;

    // 关联行（活动）保留、事件被省略 → 409 linked_event_missing，整体回滚（软解绑后同样拒绝）
    const res = await putFullState(srv.port, (st) => {
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-gone', decisionId, 'sev-gone')]);
      // 不添加 sev-gone 事件（等价于「曾被关联的事件被删除」）
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.json));
    assert.strictEqual(res.json.error.code, 'linked_event_missing');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions/' + decisionId)).json.links.length, 0, '失败写入不得留下半条关联');

    // 同一事件被两条活动关联占用 → 409 event_already_linked
    const seeded = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-dup')]);
    });
    assert.strictEqual(seeded.status, 200);
    const rec2 = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: 200001 }))).json.recommendation;
    const d2 = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec2.id, intent: 'accepted', note: '第二条' })).json.decision;
    const dup = await putFullState(srv.port, (st) => {
      st.decisionLinks = (st.decisionLinks || []).concat([
        activeLink('sev-dup', decisionId, 'sev-dup'),
        activeLink('sev-dup', d2.id, 'sev-dup')
      ]);
    });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.json.error.code, 'event_already_linked', '一条证券事件同时只属一条活动决策');
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================= 7. §4.5 读取复核（fail closed）与 §9 迁移 / 备份结构 ================= */

test('6B-19 篡改检测：改快照一个字节 / seq 断链 / 状态与事件链不一致 → invalidCount 留痕、详情 400、复原后恢复可用', async () => {
  const ctx = setup('ledger-p6i-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const accepted = await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '篡改测试' });
    const decisionId = accepted.json.decision.id;
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const raw = new DatabaseSync(ctx.paths.dbFile);
    const originalJson = raw.prepare('SELECT snapshot_json FROM decision_events WHERE decision_id = ? AND seq = 1')
      .get(decisionId).snapshot_json;
    const expectValid = async () => {
      const list = (await get(srv.port, '/api/v1/decisions')).json;
      assert.strictEqual(list.invalidCount, 0);
      assert.strictEqual(list.items.length, 1);
      const detail = await get(srv.port, '/api/v1/decisions/' + decisionId);
      assert.strictEqual(detail.status, 200);
    };
    const expectInvalid = async () => {
      const list = (await get(srv.port, '/api/v1/decisions')).json;
      assert.strictEqual(list.invalidCount, 1, '被篡改行不得冒充可用决策');
      assert.strictEqual(list.items.length, 0);
      const detail = await get(srv.port, '/api/v1/decisions/' + decisionId);
      assert.strictEqual(detail.status, 400);
      assert.strictEqual(detail.json.error.code, 'invalid_decision_record');
    };

    // ① 改快照一个字节 → 原文与封存哈希不一致
    raw.prepare("UPDATE decision_events SET snapshot_json = json_set(snapshot_json, '$.netWorthMinor', 1)")
      .run();
    await expectInvalid();
    raw.prepare('UPDATE decision_events SET snapshot_json = ? WHERE decision_id = ? AND seq = 1')
      .run(originalJson, decisionId);
    await expectValid();

    // ② seq 断链（唯一事件从 1 挪到 2：唯一索引不挡，链式校验必须挡）
    raw.prepare('UPDATE decision_events SET seq = 2 WHERE decision_id = ? AND seq = 1').run(decisionId);
    await expectInvalid();
    raw.prepare('UPDATE decision_events SET seq = 1 WHERE decision_id = ? AND seq = 2').run(decisionId);
    await expectValid();

    // ③ decisions.state 与末条事件 to_state 不一致
    raw.prepare("UPDATE decisions SET state = 'executed' WHERE id = ?").run(decisionId);
    await expectInvalid();
    raw.prepare("UPDATE decisions SET state = 'accepted' WHERE id = ?").run(decisionId);
    await expectValid();

    // ④ actor 被数据库 CHECK 直接挡下（词表不变量在表层兜底）
    assert.throws(() => {
      raw.prepare("UPDATE decision_events SET actor = 'admin' WHERE decision_id = ?").run(decisionId);
    }, /CHECK/);
    raw.close();
    await expectValid();
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-20 迁移与备份结构：v10→v11 空表、二次迁移幂等、部分唯一索引被换成普通索引必须拒止', async () => {
  const ctx = setup('ledger-p6j-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '备份测试' });

    // v10 库前向迁移到 v11：三表为空，不伪造历史决策（用临时库验证）
    const v10 = dbm.openDatabase(':memory:');
    try {
      migrations.migrate(v10, { list: migrations.MIGRATIONS.filter((m) => m.version <= 10) });
      assert.strictEqual(migrations.currentVersion(v10), 10);
      const migrated = migrations.migrate(v10);
      assert.deepStrictEqual(migrated.applied, [11]);
      assert.strictEqual(dbm.all(v10, 'SELECT id FROM decisions').length, 0);
      assert.strictEqual(dbm.all(v10, 'SELECT id FROM decision_events').length, 0);
      assert.strictEqual(dbm.all(v10, 'SELECT id FROM decision_links').length, 0);
      // 二次迁移幂等
      const again = migrations.migrate(v10);
      assert.deepStrictEqual(again.applied, []);
    } finally {
      dbm.closeQuietly(v10);
    }

    // 备份内容包含决策事实，且可独立通过结构校验
    const backup = await post(srv.port, '/api/v1/backups', {});
    assert.strictEqual(backup.status, 201);
    const backupPath = path.join(ctx.paths.backupDir, backup.json.backup.name);
    const validated = B.validateBackupFile(backupPath);
    assert.strictEqual(validated.ok, true, validated.reason || '备份必须通过 v11 结构校验');
    assert.strictEqual(validated.schemaVersion, migrations.LATEST_VERSION);

    // 对称拒止（契约 §6.5）：把部分唯一索引换成普通唯一索引 → 恢复校验失败
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const tamperedPath = backupPath.replace(/\.db$/, '-tampered.db');
    fs.copyFileSync(backupPath, tamperedPath);
    const raw = new DatabaseSync(tamperedPath);
    raw.exec('DROP INDEX uq_decision_links_active');
    raw.exec('CREATE UNIQUE INDEX uq_decision_links_active ON decision_links(security_event_id)');
    raw.close();
    const verdict = B.validateBackupFile(tamperedPath);
    assert.strictEqual(verdict.ok, false, '部分唯一索引被换成普通索引必须被拒止');
    assert.ok(verdict.reason.indexOf('uq_decision_links_active') !== -1, '拒止原因必须点名被换掉的索引');
    fs.rmSync(tamperedPath, { force: true });
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================= 8. 无交易出口与月度历史 ================= */

test('6B-21 无交易出口：0 元建议归档 no_trade；正金额未买 / 曾关联后解绑归档 abandoned', async () => {
  const ctx = setup('ledger-p6k-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    // Case A：0 元建议（requested 0 → formal，allocatedTotal = 0）从未关联 → no_trade
    const rec0 = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: 0 }))).json.recommendation;
    assert.strictEqual(rec0.status, 'formal');
    assert.strictEqual(rec0.allocatedTotalMinor, 0);
    const d0 = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec0.id, intent: 'accepted', note: '全部保留现金' })).json.decision;
    const archived0 = await post(srv.port, '/api/v1/decisions/' + d0.id + '/events', { toState: 'archived', note: '本月不投了' });
    assert.strictEqual(archived0.status, 200, JSON.stringify(archived0.json));
    assert.strictEqual(archived0.json.events[1].reasonCode, 'no_trade', '金额为 0 且从未关联 → no_trade');
    assert.strictEqual(archived0.json.execution.linkedCount, 0);
    // 归档是终态，不进复盘
    const review = await post(srv.port, '/api/v1/decisions/' + d0.id + '/events', { toState: 'reviewed', note: 'x' });
    assert.strictEqual(review.status, 409);

    // Case B：正金额建议接受后始终没买 → abandoned（二次勘误：正金额未买即放弃）
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const d = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '先接受' })).json.decision;
    const archived = await post(srv.port, '/api/v1/decisions/' + d.id + '/events', { toState: 'archived', note: '不执行了' });
    assert.strictEqual(archived.status, 200, JSON.stringify(archived.json));
    assert.strictEqual(archived.json.events[1].reasonCode, 'abandoned', '正金额未买即放弃 → abandoned');

    // Case C：曾有关联、后全部解绑再归档 → abandoned（§6.3 判定规则）
    const rec2 = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: 200001 }))).json.recommendation;
    const d2 = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec2.id, intent: 'accepted', note: '先接后弃' })).json.decision;
    const withLink = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-ab')]);
      st.decisionLinks = (st.decisionLinks || []).concat([
        activeLink('sev-ab', d2.id, 'sev-ab', { unlinkedOn: '2026-09-30', unlinkedAt: NOW_ISO, unlinkNote: '选错了，先解绑' })
      ]);
    });
    assert.strictEqual(withLink.status, 200, JSON.stringify(withLink.json));
    const archived2 = await post(srv.port, '/api/v1/decisions/' + d2.id + '/events', { toState: 'archived', note: '不执行了' });
    assert.strictEqual(archived2.status, 200, JSON.stringify(archived2.json));
    assert.strictEqual(archived2.json.events[1].reasonCode, 'abandoned', '曾有关联（已解绑）→ abandoned');

    // Case D：活动关联 > 0 时归档必须被拒
    const rec3 = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: 200002 }))).json.recommendation;
    const d3 = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec3.id, intent: 'accepted', note: '带关联归档' })).json.decision;
    await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-ab2')]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-ab2', d3.id, 'sev-ab2')]);
    });
    const blocked = await post(srv.port, '/api/v1/decisions/' + d3.id + '/events', { toState: 'archived', note: 'x' });
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.json.error.code, 'has_linked_events');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-22 月度历史与列表：本地事件月归属、空月份不出条目、过滤参数与排序', async () => {
  const ctx = setup('ledger-p6l-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const d = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '跨月' })).json.decision;
    await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([
        buyEvent('sev-m1', { occurredAt: '2026-09-20' })
      ]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-m1', d.id, 'sev-m1')]);
    });
    // 事件端点的 occurredAt = 当日（服务端时钟），决策事件全部落在 2026-09
    const all = (await get(srv.port, '/api/v1/decisions')).json;
    assert.strictEqual(all.total, 1);
    assert.deepStrictEqual(all.months, [MONTH], '空月份不生成条目');
    assert.deepStrictEqual(all.states, ['accepted']);
    assert.strictEqual(all.invalidCount, 0);

    const byMonth = (await get(srv.port, '/api/v1/decisions?month=' + MONTH)).json;
    assert.strictEqual(byMonth.items.length, 1);
    const emptyMonth = (await get(srv.port, '/api/v1/decisions?month=2025-01')).json;
    assert.deepStrictEqual(emptyMonth.items, [], '筛选结果为空显示空态，不报错');
    const byState = (await get(srv.port, '/api/v1/decisions?state=accepted')).json;
    assert.strictEqual(byState.items.length, 1);
    const byStateMiss = (await get(srv.port, '/api/v1/decisions?state=reviewed')).json;
    assert.deepStrictEqual(byStateMiss.items, []);
    const byRec = (await get(srv.port, '/api/v1/decisions?recommendationId=' + rec.id)).json;
    assert.strictEqual(byRec.items.length, 1);
    const byRange = (await get(srv.port, '/api/v1/decisions?from=2026-09-01&to=2026-09-30')).json;
    assert.strictEqual(byRange.items.length, 1);
    const badState = await get(srv.port, '/api/v1/decisions?state=hacked');
    assert.strictEqual(badState.status, 400);
    assert.strictEqual(badState.json.error.code, 'invalid_decision_payload');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-24 损坏的建议不能创建决策（复核反例）：封存哈希改坏 → 建议列表 invalidCount=1，创建 400', async () => {
  const ctx = setup('ledger-p6n-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const raw = new DatabaseSync(ctx.paths.dbFile);
    const original = raw.prepare('SELECT payload_hash FROM recommendations WHERE id = ?').get(rec.id).payload_hash;
    // 篡改建议封存哈希：读取视图立即显式留痕
    raw.prepare("UPDATE recommendations SET payload_hash = ? WHERE id = ?").run('b'.repeat(64), rec.id);
    const view = (await get(srv.port, '/api/v1/recommendations')).json;
    assert.strictEqual(view.invalidCount, 1, '被篡改建议在列表中 invalidCount 留痕');
    // 关键反例：损坏建议不得创建**任何**决策（含 deferred——不只是 accepted 的时效重核）
    const created = await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'deferred', note: 'x' });
    assert.strictEqual(created.status, 400, JSON.stringify(created.json));
    assert.strictEqual(created.json.error.code, 'invalid_recommendation_record');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.total, 0, '零落库');
    // 复原后照常可创建
    raw.prepare('UPDATE recommendations SET payload_hash = ? WHERE id = ?').run(original, rec.id);
    raw.close();
    const ok = await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'deferred', note: '复原后创建' });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-25 无效关联只淘汰该决策（复核反例）：buy 被篡改为 sell → 列表排除并 invalidCount，详情 400', async () => {
  const ctx = setup('ledger-p6o-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const decisionId = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '关联反例' })).json.decision.id;
    const seeded = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-tamper')]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-tamper', decisionId, 'sev-tamper')]);
    });
    assert.strictEqual(seeded.status, 200);
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.invalidCount, 0);

    // 把已关联的 buy 篡改为 sell：§4.5 第 5 条（活动关联必须指向 buy）在读取复核中生效
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const raw = new DatabaseSync(ctx.paths.dbFile);
    raw.prepare("UPDATE security_events SET event_type = 'sell' WHERE id = 'sev-tamper'").run();
    const detail = await get(srv.port, '/api/v1/decisions/' + decisionId);
    assert.strictEqual(detail.status, 400);
    assert.strictEqual(detail.json.error.code, 'invalid_decision_record');
    // 关键反例：列表不得整页失败——排除该行并计入 invalidCount
    const list = (await get(srv.port, '/api/v1/decisions')).json;
    assert.strictEqual(list.status ?? 200, 200);
    assert.strictEqual(list.invalidCount, 1);
    assert.deepStrictEqual(list.items, [], '失效决策不进可用列表');
    // 复原后恢复可用
    raw.prepare("UPDATE security_events SET event_type = 'buy' WHERE id = 'sev-tamper'").run();
    raw.close();
    const recovered = (await get(srv.port, '/api/v1/decisions')).json;
    assert.strictEqual(recovered.invalidCount, 0);
    assert.strictEqual(recovered.items.length, 1);
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-26 日期区间按逐事件判断（复核反例）：中间事件日命中的决策不得被漏掉', async () => {
  const ctx = setup('ledger-p6p-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const decisionId = (await post(srv.port, '/api/v1/decisions', { recommendationId: rec.id, intent: 'accepted', note: '区间反例' })).json.decision.id;
    const seeded = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-range')]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-range', decisionId, 'sev-range')]);
    });
    assert.strictEqual(seeded.status, 200);
    // 决策事件：9-30（accepted）→ 10-15（executed）→ 11-20（reviewed）
    ctx.today = () => '2026-10-15';
    const executed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events', { toState: 'executed', note: '中间事件' });
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.json));
    ctx.today = () => '2026-11-20';
    const reviewed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events', { toState: 'reviewed', note: '尾部事件' });
    assert.strictEqual(reviewed.status, 200, JSON.stringify(reviewed.json));

    // 单日区间恰好落在中间事件日：只看月初 / 末次事件的实现会漏掉这条决策
    const mid = (await get(srv.port, '/api/v1/decisions?from=2026-10-15&to=2026-10-15')).json;
    assert.strictEqual(mid.items.length, 1, '中间事件日必须命中');
    assert.strictEqual(mid.items[0].id, decisionId);
    const nov = (await get(srv.port, '/api/v1/decisions?from=2026-11-01')).json;
    assert.strictEqual(nov.items.length, 1, '末次事件命中');
    const none = (await get(srv.port, '/api/v1/decisions?from=2026-12-01')).json;
    assert.deepStrictEqual(none.items, [], '区间外为空');
    const oct = (await get(srv.port, '/api/v1/decisions?month=2026-10')).json;
    assert.strictEqual(oct.items.length, 1, '月度过滤同样按事件月命中');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-27 篡改快照在 /state 与备份恢复前拒止；有效备份仍可恢复损坏活库', async () => {
  const ctx = setup('ledger-p6q-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const decisionId = (await post(srv.port, '/api/v1/decisions', {
      recommendationId: rec.id, intent: 'accepted', note: '恢复校验反例'
    })).json.decision.id;
    const valid = await post(srv.port, '/api/v1/backups', {});
    assert.strictEqual(valid.status, 201, JSON.stringify(valid.json));
    const validName = valid.json.backup.name;
    const validPath = path.join(ctx.paths.backupDir, validName);

    // 候选备份结构仍完整，唯独封存快照内容被改：必须在校验阶段拒绝，活库不切换。
    const tamperedName = 'ledger-phase6b-corrupt-candidate.db';
    const tamperedPath = path.join(ctx.paths.backupDir, tamperedName);
    fs.copyFileSync(validPath, tamperedPath);
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const candidate = new DatabaseSync(tamperedPath);
    candidate.prepare("UPDATE decision_events SET snapshot_json = json_set(snapshot_json, '$.netWorthMinor', 1)").run();
    candidate.close();
    const check = B.validateBackupFile(tamperedPath);
    assert.strictEqual(check.ok, false, '快照篡改的 v11 备份不得通过候选校验');
    assert.match(check.reason, /决策历史复核失败/);
    const rejected = await post(srv.port, '/api/v1/restores', { file: tamperedName });
    assert.strictEqual(rejected.status, 409, JSON.stringify(rejected.json));
    assert.strictEqual(rejected.json.error.code, 'restore_failed');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions/' + decisionId)).status, 200,
      '候选失败不能破坏原来的有效活库');

    // 活库被同样篡改：列表可显式留痕，但 /state 必须整份拒绝，不能泄露坏快照。
    const live = new DatabaseSync(ctx.paths.dbFile);
    live.prepare("UPDATE decision_events SET snapshot_json = json_set(snapshot_json, '$.netWorthMinor', 1)").run();
    live.close();
    const list = (await get(srv.port, '/api/v1/decisions')).json;
    assert.strictEqual(list.invalidCount, 1);
    const detail = await get(srv.port, '/api/v1/decisions/' + decisionId);
    assert.strictEqual(detail.status, 400);
    assert.strictEqual(detail.json.error.code, 'invalid_decision_record');
    const state = await get(srv.port, '/api/v1/state');
    assert.strictEqual(state.status, 400, JSON.stringify(state.json));
    assert.strictEqual(state.json.error.code, 'invalid_decision_record');
    assert.strictEqual(state.json.decisionEvents, undefined, '无效快照不能进入 /state 响应');

    // 恢复有效备份时仍保存旧库的取证快照；该快照自身不能冒充有效候选。
    const restored = await post(srv.port, '/api/v1/restores', { file: validName });
    assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
    assert.strictEqual((await get(srv.port, '/api/v1/state')).status, 200);
    assert.strictEqual((await get(srv.port, '/api/v1/decisions/' + decisionId)).status, 200);
    const forensic = path.join(ctx.paths.backupDir, restored.json.preRestoreBackup);
    assert.strictEqual(B.validateBackupFile(forensic).ok, false, '恢复前损坏快照只供取证，不得当作有效备份');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6B-28 快照 JSON 原文字节被改但解析值不变时，同样不得通过读取和备份校验', async () => {
  const ctx = setup('ledger-p6r-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const decisionId = (await post(srv.port, '/api/v1/decisions', {
      recommendationId: rec.id, intent: 'accepted', note: '原文字节反例'
    })).json.decision.id;
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const raw = new DatabaseSync(ctx.paths.dbFile);
    const original = raw.prepare('SELECT snapshot_json FROM decision_events WHERE decision_id = ?').get(decisionId).snapshot_json;
    raw.prepare('UPDATE decision_events SET snapshot_json = ? WHERE decision_id = ?').run(' ' + original, decisionId);
    raw.close();
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.invalidCount, 1);
    assert.strictEqual((await get(srv.port, '/api/v1/state')).status, 400);
    assert.throws(() => R.readState(ctx.db), (err) => err.code === 'invalid_decision_record');
    const backup = await post(srv.port, '/api/v1/backups', {});
    assert.strictEqual(backup.status, 503, '创建备份也不能认证被改动的快照原文');
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================= Phase 6D：关联实际交易与记录执行（契约 §3 / §7 / §8.5 / §10.2-8~14） ================= */

// 6B 的关联是全量写入预置（当时没有 HTTP 入口）；6D 起关联 / 解绑走专用端点，这里统一用它造事实。
async function newAcceptedDecision(port, facts, seed) {
  const recRes = await post(port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: NEW_FUNDS_MINOR + seed }));
  assert.strictEqual(recRes.status, 201, JSON.stringify(recRes.json));
  const res = await post(port, '/api/v1/decisions', {
    recommendationId: recRes.json.recommendation.id, intent: 'accepted', note: '接受理由'
  });
  assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.json));
  return res.json.decision;
}

async function seedBuy(port, id, over) {
  const res = await putFullState(port, (st) => {
    st.assets.securityEvents = (st.assets.securityEvents || []).concat([buyEvent(id, over)]);
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
}

const SEV1 = 'sev-6d00000000000001';
const SEV2 = 'sev-6d00000000000002';
const SEV_SELL = 'sev-6d00000000000003';

test('6D-01 关联正向：201 created → 自然幂等 200 created:false，执行汇总与详情一致，且不产生状态事件', async () => {
  const ctx = setup('ledger-p6d1-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const decision = await newAcceptedDecision(srv.port, facts, 1);
    await seedBuy(srv.port, SEV1);

    const res = await post(srv.port, '/api/v1/decisions/' + decision.id + '/links',
      { securityEventId: SEV1, note: '第一笔买入' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    assert.strictEqual(res.json.created, true);
    assert.match(res.json.link.id, /^lnk-[0-9a-f]{16}$/, '契约 §6.1：关联行 id = lnk-<16hex>');
    assert.strictEqual(res.json.link.decisionId, decision.id);
    assert.strictEqual(res.json.link.linkedOn, TODAY, 'linkedOn 由服务端生成');
    assert.strictEqual(res.json.link.linkedAt, NOW_ISO, 'linkedAt 由服务端生成');
    assert.strictEqual(res.json.link.unlinkedOn, null);
    assert.strictEqual(res.json.link.note, '第一笔买入');
    assert.strictEqual(res.json.links.length, 1, '响应直接带关联行（页面不再二次查事件）');
    assert.strictEqual(res.json.links[0].event.eventType, 'buy');
    assert.strictEqual(res.json.links[0].event.quantity, '20');
    assert.strictEqual(res.json.execution.linkedCount, 1);
    assert.strictEqual(res.json.execution.linkedPrincipalCnyMinor, 200000, '20 × 100.00 CNY = 2,000.00 本金');
    assert.strictEqual(res.json.execution.linkedFeeCnyMinor, 500, '费用单列，不并入本金');

    // 自然幂等：同一事件关联到同一条决策 → 200 created:false，同一条 link，不出现第二行
    const again = await post(srv.port, '/api/v1/decisions/' + decision.id + '/links',
      { securityEventId: SEV1, note: '第一笔买入' });
    assert.strictEqual(again.status, 200, JSON.stringify(again.json));
    assert.strictEqual(again.json.created, false);
    assert.strictEqual(again.json.link.id, res.json.link.id);
    assert.strictEqual(again.json.links.length, 1);

    // 关联是关联层动作：不写状态事件、不改 decisions 行、不复制证券事件、不写 txns
    const st = (await get(srv.port, '/api/v1/state')).json;
    assert.strictEqual(st.decisionEvents.filter((e) => e.decisionId === decision.id).length, 1, '关联不得追加状态事件');
    assert.strictEqual(st.decisions.filter((d) => d.id === decision.id)[0].state, 'accepted', '状态不变');
    assert.strictEqual(st.decisionLinks.length, 1, '只有一条关联行');
    assert.strictEqual(st.txns.length, 0, '关联不写 txns');
    assert.strictEqual(st.assets.securityEvents.length, 1, '关联不复制证券事件');

    // 详情与关联响应同一份计算
    const detail = await get(srv.port, '/api/v1/decisions/' + decision.id);
    assert.strictEqual(detail.status, 200, JSON.stringify(detail.json));
    assert.strictEqual(detail.json.links.length, 1);
    assert.strictEqual(detail.json.links[0].id, res.json.link.id);
    assert.strictEqual(detail.json.execution.linkedPrincipalCnyMinor, 200000);
    assert.strictEqual(res.json.execution.remainingMinor,
      detail.json.recommendation.allocatedTotalMinor - 200000, '剩余 = 建议金额 − 关联本金（§3.3）');
    assert.ok(detail.json.timeline.some((t) => t.kind === 'link' && t.action === 'link' && t.linkId === res.json.link.id),
      '详情时间线要有关联记录');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6D-02 关联反例（契约 §10.2-8~10）：404 unknown_decision / 409 illegal_state_for_link、invalid_link_target / 422 unknown_security_event / 409 event_already_linked / 400 派生键', async () => {
  const ctx = setup('ledger-p6d2-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const d1 = await newAcceptedDecision(srv.port, facts, 1);
    const d2 = await newAcceptedDecision(srv.port, facts, 2);
    const d3 = await newAcceptedDecision(srv.port, facts, 3);   // 保持 accepted，专供抢关联反例
    const linkPath = (d) => '/api/v1/decisions/' + d.id + '/links';
    await seedBuy(srv.port, SEV1);
    await seedBuy(srv.port, SEV_SELL, { eventType: 'sell', quantity: '10' });

    // 未知决策 → 404 unknown_decision（路径参数）
    const unknown = await post(srv.port, '/api/v1/decisions/dec-0000000000000000/links', { securityEventId: SEV1 });
    assert.strictEqual(unknown.status, 404, JSON.stringify(unknown.json));
    assert.strictEqual(unknown.json.error.code, 'unknown_decision');

    // 只有 accepted / executed 能关联：proposed 与 archived 都 409
    const proposed = await post(srv.port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: NEW_FUNDS_MINOR + 3 }));
    const pDecision = (await post(srv.port, '/api/v1/decisions',
      { recommendationId: proposed.json.recommendation.id })).json.decision;
    const pRes = await post(srv.port, linkPath(pDecision), { securityEventId: SEV1 });
    assert.strictEqual(pRes.status, 409, JSON.stringify(pRes.json));
    assert.strictEqual(pRes.json.error.code, 'illegal_state_for_link');

    const archived = await post(srv.port, '/api/v1/decisions/' + d2.id + '/events', { toState: 'archived', note: '放弃，无交易' });
    assert.strictEqual(archived.status, 200, JSON.stringify(archived.json));
    const aRes = await post(srv.port, linkPath(d2), { securityEventId: SEV1 });
    assert.strictEqual(aRes.status, 409, JSON.stringify(aRes.json));
    assert.strictEqual(aRes.json.error.code, 'illegal_state_for_link');

    // 非 buy 事件 → 409 invalid_link_target（契约 §3.1：sell / dividend / fee 不参与本金）
    const sellRes = await post(srv.port, linkPath(d1), { securityEventId: SEV_SELL });
    assert.strictEqual(sellRes.status, 409, JSON.stringify(sellRes.json));
    assert.strictEqual(sellRes.json.error.code, 'invalid_link_target');

    // 载荷引用不存在的事件 → 422 unknown_security_event
    const ghostRes = await post(srv.port, linkPath(d1), { securityEventId: 'sev-6ddeadbeefdeadbeef' });
    assert.strictEqual(ghostRes.status, 422, JSON.stringify(ghostRes.json));
    assert.strictEqual(ghostRes.json.error.code, 'unknown_security_event');

    // 派生键 / 未知键 → 400 invalid_decision_payload（服务端生成的时间不得由客户端提交）
    const derived = await post(srv.port, linkPath(d1),
      { securityEventId: SEV1, linkedOn: TODAY, linkedAt: NOW_ISO, id: 'lnk-0000000000000000' });
    assert.strictEqual(derived.status, 400, JSON.stringify(derived.json));
    assert.strictEqual(derived.json.error.code, 'invalid_decision_payload');
    const badNote = await post(srv.port, linkPath(d1), { securityEventId: SEV1, note: 42 });
    assert.strictEqual(badNote.status, 400, JSON.stringify(badNote.json));
    assert.strictEqual(badNote.json.error.code, 'invalid_decision_payload');

    // 事件已活动关联到另一决策 → 409 event_already_linked
    const first = await post(srv.port, linkPath(d1), { securityEventId: SEV1, note: '挂到 d1' });
    assert.strictEqual(first.status, 201, JSON.stringify(first.json));
    const steal = await post(srv.port, linkPath(d3), { securityEventId: SEV1 });
    assert.strictEqual(steal.status, 409, JSON.stringify(steal.json));
    assert.strictEqual(steal.json.error.code, 'event_already_linked');
    const st = (await get(srv.port, '/api/v1/state')).json;
    assert.strictEqual(st.decisionLinks.length, 1, '抢关联失败不得留下半条关联行');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6D-03 幂等键（契约 §8.6）：同 key 同载荷回放 200 replay，同 key 异载荷 409 idempotency_conflict', async () => {
  const ctx = setup('ledger-p6d3-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const decision = await newAcceptedDecision(srv.port, facts, 1);
    await seedBuy(srv.port, SEV1);
    await seedBuy(srv.port, SEV2);
    const body = { securityEventId: SEV1, note: '幂等关联' };
    const first = await post(srv.port, '/api/v1/decisions/' + decision.id + '/links', body,
      { headers: { 'Idempotency-Key': 'p6d-key-01' } });
    assert.strictEqual(first.status, 201, JSON.stringify(first.json));

    const replay = await post(srv.port, '/api/v1/decisions/' + decision.id + '/links', body,
      { headers: { 'Idempotency-Key': 'p6d-key-01' } });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.json));
    assert.strictEqual(replay.headers['x-ledger-idempotent'], 'replay');
    assert.strictEqual(replay.json.link.id, first.json.link.id);

    const conflict = await post(srv.port, '/api/v1/decisions/' + decision.id + '/links',
      { securityEventId: SEV2, note: '另一笔' }, { headers: { 'Idempotency-Key': 'p6d-key-01' } });
    assert.strictEqual(conflict.status, 409, JSON.stringify(conflict.json));
    assert.strictEqual(conflict.json.error.code, 'idempotency_conflict');
    const st = (await get(srv.port, '/api/v1/state')).json;
    assert.strictEqual(st.decisionLinks.length, 1, '幂等冲突不得写入第二条关联');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6D-04 解绑与重新关联（契约 §3.4 / §10.2-11、14）：软删除三列齐、422 unknown_decision_link、409 link_not_active、重关联换新 id', async () => {
  const ctx = setup('ledger-p6d4-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const d1 = await newAcceptedDecision(srv.port, facts, 1);
    const d2 = await newAcceptedDecision(srv.port, facts, 2);
    await seedBuy(srv.port, SEV1);
    const linkRes = await post(srv.port, '/api/v1/decisions/' + d1.id + '/links',
      { securityEventId: SEV1, note: '先关联' });
    assert.strictEqual(linkRes.status, 201, JSON.stringify(linkRes.json));
    const linkId = linkRes.json.link.id;
    const unlinkPath = (d) => '/api/v1/decisions/' + d.id + '/links/unlink';

    // 解绑缺 note → 400（解绑必须写明理由）
    const noNote = await post(srv.port, unlinkPath(d1), { linkId: linkId });
    assert.strictEqual(noNote.status, 400, JSON.stringify(noNote.json));
    assert.strictEqual(noNote.json.error.code, 'invalid_decision_payload');
    const emptyNote = await post(srv.port, unlinkPath(d1), { linkId: linkId, note: '   ' });
    assert.strictEqual(emptyNote.status, 400, JSON.stringify(emptyNote.json));

    // 载荷引用：形状合法但查无此行 → 422 unknown_decision_link
    const ghost = await post(srv.port, unlinkPath(d1), { linkId: 'lnk-ffffffffffffffff', note: '查无此行' });
    assert.strictEqual(ghost.status, 422, JSON.stringify(ghost.json));
    assert.strictEqual(ghost.json.error.code, 'unknown_decision_link');
    // 形状不合法 → 400（形状可由客户端修正，语义引用才走 422）
    const badShape = await post(srv.port, unlinkPath(d1), { linkId: 'nope', note: '形状错' });
    assert.strictEqual(badShape.status, 400, JSON.stringify(badShape.json));
    // 属于另一条决策的 linkId → 同样 422 unknown_decision_link（从本决策视角引用不到）
    const cross = await post(srv.port, unlinkPath(d2), { linkId: linkId, note: '张冠李戴' });
    assert.strictEqual(cross.status, 422, JSON.stringify(cross.json));
    assert.strictEqual(cross.json.error.code, 'unknown_decision_link');

    // 正常解绑：软删除三列同时给，状态与决策行不变
    const un = await post(srv.port, unlinkPath(d1), { linkId: linkId, note: '选错了，重新关联' });
    assert.strictEqual(un.status, 200, JSON.stringify(un.json));
    assert.strictEqual(un.json.link.unlinkedOn, TODAY);
    assert.strictEqual(un.json.link.unlinkedAt, NOW_ISO);
    assert.strictEqual(un.json.link.unlinkNote, '选错了，重新关联');
    assert.strictEqual(un.json.execution.linkedCount, 0, '解绑后活动关联归零，汇总同步');
    assert.strictEqual(un.json.execution.linkedPrincipalCnyMinor, 0);
    const st1 = (await get(srv.port, '/api/v1/state')).json;
    assert.strictEqual(st1.decisionLinks.length, 1, '解绑是软删除，不删行');
    assert.strictEqual(st1.decisions.filter((d) => d.id === d1.id)[0].state, 'accepted', '解绑不改状态');
    assert.strictEqual(st1.decisionEvents.filter((e) => e.decisionId === d1.id).length, 1, '解绑不追加状态事件');

    // 重复解绑 → 409 link_not_active
    const again = await post(srv.port, unlinkPath(d1), { linkId: linkId, note: '再解一次' });
    assert.strictEqual(again.status, 409, JSON.stringify(again.json));
    assert.strictEqual(again.json.error.code, 'link_not_active');

    // 解绑后同一事件可重新关联到同一决策，id 必须换新（历史行仍在）
    const relink = await post(srv.port, '/api/v1/decisions/' + d1.id + '/links',
      { securityEventId: SEV1, note: '重新挂上' });
    assert.strictEqual(relink.status, 201, JSON.stringify(relink.json));
    assert.notStrictEqual(relink.json.link.id, linkId, '解绑行仍占主键，重关联必须换新 id');
    assert.strictEqual(relink.json.execution.linkedCount, 1);
    const st2 = (await get(srv.port, '/api/v1/state')).json;
    assert.strictEqual(st2.decisionLinks.length, 2, '历史解绑行 + 新活动行，追加更正而非擦除');
    assert.strictEqual(st2.decisionLinks.filter((l) => l.unlinkedOn == null).length, 1, '活动关联仍然唯一');

    // 解绑后可改挂到另一条决策
    const move = await post(srv.port, unlinkPath(d1), { linkId: relink.json.link.id, note: '改挂 d2' });
    assert.strictEqual(move.status, 200, JSON.stringify(move.json));
    const toD2 = await post(srv.port, '/api/v1/decisions/' + d2.id + '/links',
      { securityEventId: SEV1, note: '改挂到 d2' });
    assert.strictEqual(toD2.status, 201, JSON.stringify(toD2.json));
    assert.strictEqual(toD2.json.links.filter((l) => l.unlinkedOn == null).length, 1);

    // archived 的决策不能解绑（状态门禁覆盖关联与解绑两侧）
    const archived = await post(srv.port, '/api/v1/decisions/' + d1.id + '/events', { toState: 'archived', note: '放弃' });
    assert.strictEqual(archived.status, 200, JSON.stringify(archived.json));
    const late = await post(srv.port, unlinkPath(d1), { linkId: 'lnk-ffffffffffffffff', note: '晚到解绑' });
    assert.strictEqual(late.status, 409, JSON.stringify(late.json));
    assert.strictEqual(late.json.error.code, 'illegal_state_for_link');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6D-05 执行确认全走 HTTP：分批两笔关联 → 偏差必填理由 → executed 快照封存的关联 id 就是端点返回的 id', async () => {
  const ctx = setup('ledger-p6d5-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const decision = await newAcceptedDecision(srv.port, facts, 1);
    await seedBuy(srv.port, SEV1);
    await seedBuy(srv.port, SEV2, { quantity: '10' });
    const p1 = '/api/v1/decisions/' + decision.id;

    const l1 = await post(srv.port, p1 + '/links', { securityEventId: SEV1, note: '第一批' });
    assert.strictEqual(l1.status, 201, JSON.stringify(l1.json));
    const l2 = await post(srv.port, p1 + '/links', { securityEventId: SEV2, note: '第二批' });
    assert.strictEqual(l2.status, 201, JSON.stringify(l2.json));
    assert.strictEqual(l1.json.execution.linkedCount, 1);
    assert.strictEqual(l2.json.execution.linkedCount, 2, '进度按活动关联事实累加');
    assert.strictEqual(l2.json.execution.linkedPrincipalCnyMinor, 300000, '20×100 + 10×100');
    assert.notStrictEqual(l1.json.link.id, l2.json.link.id);

    // 超买（本金 > 建议金额）→ executed 必须写明理由（契约 §10.2-13）
    const noNote = await post(srv.port, p1 + '/events', { toState: 'executed' });
    assert.strictEqual(noNote.status, 400, JSON.stringify(noNote.json));
    assert.strictEqual(noNote.json.error.code, 'deviation_note_required');

    const executed = await post(srv.port, p1 + '/events', { toState: 'executed', note: '分两笔买完，实际超买 999.99 元' });
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.json));
    assert.strictEqual(executed.json.decision.state, 'executed');
    assert.strictEqual(executed.json.events[1].reasonCode, 'executed_deviation');
    const sealed = executed.json.events[1].snapshot.execution;
    assert.strictEqual(sealed.linkedCount, 2);
    assert.strictEqual(sealed.linkedPrincipalCnyMinor, 300000);
    assert.deepStrictEqual(
      (await get(srv.port, p1)).json.links.filter((l) => l.unlinkedOn == null).map((l) => l.id).sort(),
      [l1.json.link.id, l2.json.link.id].sort(),
      '快照与详情里的关联 id 就是端点返回的 id（不复制、不改写）'
    );

    // executed 状态仍可解绑（§3.2 允许 accepted / executed 两侧）
    const un = await post(srv.port, p1 + '/links/unlink', { linkId: l2.json.link.id, note: '第二笔挂错账户，撤销' });
    assert.strictEqual(un.status, 200, JSON.stringify(un.json));
    assert.strictEqual(un.json.execution.linkedCount, 1);
    assert.strictEqual(un.json.execution.linkedPrincipalCnyMinor, 200000);
    assert.strictEqual((await get(srv.port, p1)).json.decision.state, 'executed', '解绑不回退状态');
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================= Phase 6E｜复盘对照（契约 §4.3 6E 补充） ================= */

// 把快照 classes 行转成对照 cell 形状（测试内独立重算期望值，不复用被测代码的中间结果）。
function cellOf(clsRow) {
  return {
    valueMinor: clsRow.valueMinor, pctBps: clsRow.pctBps,
    deviationBps: clsRow.deviationBps, band: clsRow.band
  };
}

test('6E-01 F-A 复盘对照逐分核对：comparison 三时点 cell 与封存快照逐字段一致、delta 可复算、快照齐全', async () => {
  const ctx = setup('ledger-p6g-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const accepted = await post(srv.port, '/api/v1/decisions',
      { recommendationId: rec.id, intent: 'accepted', note: '对照核对：按建议执行' });
    const decisionId = accepted.json.decision.id;
    // 非法跳步复述：accepted → reviewed 必须拒绝（矩阵 49 对的流程级复述）
    const skip = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'reviewed', note: '跳步尝试' });
    assert.strictEqual(skip.status, 409);
    assert.strictEqual(skip.json.error.code, 'illegal_transition');

    const linked = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-6e01')]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-6e01', decisionId, 'sev-6e01')]);
    });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));
    const executed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'executed' });
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.json));
    const reviewed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'reviewed', note: '配置与执行时点一致，下月继续' });
    assert.strictEqual(reviewed.status, 200);
    assert.strictEqual(reviewed.json.events[2].reasonCode, 'reviewed_no_drift');

    const detail = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    const cmp = detail.comparison;
    assert.ok(cmp, '详情必须携带 comparison');
    assert.strictEqual(cmp.comparable, true);
    assert.strictEqual(cmp.rows.length, 6);
    assert.deepStrictEqual(cmp.rows.map((r) => r.assetClass), Domain.RISK_CLASSES.slice());

    // 逐分 / 逐 bps：每个时点 cell 与该时点封存 classes 行逐字段一致；delta 恰为 review − decision
    const snapCls = {
      decision: detail.snapshots.decision.classes,
      executed: detail.snapshots.executed.classes,
      review: detail.snapshots.reviewed.classes
    };
    Domain.RISK_CLASSES.forEach((cls, i) => {
      const row = cmp.rows[i];
      ['decision', 'executed', 'review'].forEach((pt) => {
        assert.deepStrictEqual(row[pt], cellOf(snapCls[pt][i]),
          cls + ' @ ' + pt + ' cell 必须与封存 classes 原值逐字段一致');
      });
      assert.strictEqual(row.deltaValueMinor,
        detail.snapshots.reviewed.classes[i].valueMinor - detail.snapshots.decision.classes[i].valueMinor,
        cls + ' deltaValueMinor 必须可复算');
      assert.strictEqual(row.deltaPctBps,
        detail.snapshots.reviewed.classes[i].pctBps - detail.snapshots.decision.classes[i].pctBps,
        cls + ' deltaPctBps 必须逐 bps 可复算');
      assert.strictEqual(row.targetBps, detail.snapshots.decision.classes[i].targetBps,
        '参照目标恒为决策引用的历史版本');
    });
    // 变化量语义：买入发生在决策与复盘之间，证券类别的 delta 反映这笔事实变化；
    // 现金不被证券事件改写（D-042 ④）→ 现金 delta 恒为 0。
    const cashRow = cmp.rows[Domain.RISK_CLASSES.indexOf('cash')];
    assert.strictEqual(cashRow.deltaValueMinor, 0, '现金金额在两个时点一致');
    const equityRow = cmp.rows[Domain.RISK_CLASSES.indexOf('broad_equity')];
    assert.notStrictEqual(equityRow.deltaValueMinor, 0, '买入后宽基金额必然变化（对照要展示的事实）');
    ['decision', 'executed', 'reviewed'].forEach((k) => {
      assert.deepStrictEqual(cmp.timepoints[k],
        { present: true, available: true, reason: null, blockers: [] });
    });
    // reviewed 后关联 / 解绑一律拒绝（复盘不可静默改变）
    const relink = await post(srv.port, '/api/v1/decisions/' + decisionId + '/links',
      { securityEventId: 'sev-6e01' });
    assert.strictEqual(relink.status, 409);
    assert.strictEqual(relink.json.error.code, 'illegal_state_for_link');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6E-02 复盘漂移：执行后行情变化再复盘 → reviewed_with_drift，对照 delta 非零且与封存值一致', async () => {
  const ctx = setup('ledger-p6h-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const accepted = await post(srv.port, '/api/v1/decisions',
      { recommendationId: rec.id, intent: 'accepted', note: '先执行，行情随后变化' });
    const decisionId = accepted.json.decision.id;
    const linked = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-6e02', { quantity: '20', priceMinor: 10000 })]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-6e02', decisionId, 'sev-6e02')]);
    });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));
    const executed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'executed', note: '按建议金额执行' });
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.json));

    // 执行后行情变化（100 → 110）：旧快照封存不变，复盘时点的估值按当时事实重算
    const moved = await putFullState(srv.port, (st) => {
      st.assets.quotes = st.assets.quotes.map((q) =>
        q.instrumentId === 'ins-voo' && q.priceMinor === 100
          ? Object.assign({}, q, { priceMinor: 110 }) : q);
    });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.json));
    const reviewed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'reviewed', note: '行情上涨后宽基占比上升，仍在区间内' });
    assert.strictEqual(reviewed.status, 200);
    assert.strictEqual(reviewed.json.events[2].reasonCode, 'reviewed_with_drift', '配置已变 → 有漂移');

    const cmp = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json.comparison;
    assert.strictEqual(cmp.comparable, true);
    const changed = cmp.rows.filter((r) => r.deltaValueMinor !== 0 || r.deltaPctBps !== 0);
    assert.ok(changed.length >= 1, '至少一个类别的 delta 非零');
    const detail = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    cmp.rows.forEach((row, i) => {
      assert.deepStrictEqual(row.decision, cellOf(detail.snapshots.decision.classes[i]));
      assert.deepStrictEqual(row.review, cellOf(detail.snapshots.reviewed.classes[i]));
      assert.strictEqual(row.deltaValueMinor,
        detail.snapshots.reviewed.classes[i].valueMinor - detail.snapshots.decision.classes[i].valueMinor);
    });
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6E-03 缺数据不出伪 0：现金未核对 / 估值不正式 → 复盘照常封存但对照不可比、全表无数字', async () => {
  const ctx = setup('ledger-p6i-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const accepted = await post(srv.port, '/api/v1/decisions',
      { recommendationId: rec.id, intent: 'accepted', note: '执行后再看现金流' });
    const decisionId = accepted.json.decision.id;
    const linked = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-6e03')]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-6e03', decisionId, 'sev-6e03')]);
    });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));
    const executed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'executed', note: '先执行' });
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.json));
    assert.strictEqual(executed.json.events[1].snapshot.available, true, '执行时点可比');

    // 复盘前买入未核对现金：把余额 asOf 推到上一个日历月（A-005 按月判定）→ balance_stale
    const stale = await putFullState(srv.port, (st) => {
      st.assets.assetUnits = st.assets.assetUnits.map((u) =>
        Object.assign({}, u, { asOf: '2026-08-31' }));
    });
    assert.strictEqual(stale.status, 200, JSON.stringify(stale.json));
    const reviewed = await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'reviewed', note: '现金还没核对，先封存复盘结论：晚点补核对' });
    assert.strictEqual(reviewed.status, 200, '复盘本身不因缺数据被拒绝（§4.4）');
    assert.strictEqual(reviewed.json.events[2].snapshot.available, false);
    assert.strictEqual(reviewed.json.events[2].snapshot.reason, 'cash_not_reconciled');
    assert.strictEqual(reviewed.json.events[2].snapshot.netWorthMinor, null, '不可比不得携带数字');

    const detail = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    const cmp = detail.comparison;
    assert.strictEqual(cmp.comparable, false);
    assert.strictEqual(cmp.timepoints.reviewed.reason, 'cash_not_reconciled');
    assert.ok(cmp.timepoints.reviewed.blockers.some((b) => b.code === 'balance_stale'),
      'blockers 沿用 computeOverview 既有码');
    assert.strictEqual(cmp.timepoints.executed.available, true, '执行时点当时可比，照实记录');
    cmp.rows.forEach((row) => {
      [row.decision, row.executed, row.review, row.deltaValueMinor, row.deltaPctBps].forEach((v) => {
        assert.strictEqual(v, null, '不可比对照不得输出任何数字（不出伪 0）');
      });
    });
    // 各可比时点的封存数字仍可在 snapshots 里看到（不丢事实）
    assert.strictEqual(detail.snapshots.executed.classes.length, 6);
    assert.strictEqual(detail.snapshots.executed.execution.linkedPrincipalCnyMinor, 200000);

    // 估值不正式：先恢复余额核对，再建第二条决策；复盘前删掉 VOO 报价 → quote_missing
    // → valuation_not_formal
    const reconcile = await putFullState(srv.port, (st) => {
      st.assets.assetUnits = st.assets.assetUnits.map((u) => Object.assign({}, u, { asOf: TODAY }));
    });
    assert.strictEqual(reconcile.status, 200, JSON.stringify(reconcile.json));
    const rec2 = (await post(srv.port, '/api/v1/recommendations',
      recommendBody(facts, { newFundsMinor: NEW_FUNDS_MINOR + 1000 }))).json.recommendation;
    const acc2 = await post(srv.port, '/api/v1/decisions',
      { recommendationId: rec2.id, intent: 'accepted', note: '第二条用于估值门禁' });
    const d2 = acc2.json.decision.id;
    const linked2 = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-6e03b')]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-6e03b', d2, 'sev-6e03b')]);
    });
    assert.strictEqual(linked2.status, 200, JSON.stringify(linked2.json));
    const exec2 = await post(srv.port, '/api/v1/decisions/' + d2 + '/events', { toState: 'executed', note: '执行' });
    assert.strictEqual(exec2.status, 200, JSON.stringify(exec2.json));
    const noQuote = await putFullState(srv.port, (st) => {
      st.assets.quotes = st.assets.quotes.filter((q) => !(q.instrumentId === 'ins-voo' && q.priceDate === TODAY));
    });
    assert.strictEqual(noQuote.status, 200, JSON.stringify(noQuote.json));
    const rev2 = await post(srv.port, '/api/v1/decisions/' + d2 + '/events',
      { toState: 'reviewed', note: '报价缺失也要能封存复盘结论' });
    assert.strictEqual(rev2.status, 200);
    assert.strictEqual(rev2.json.events[2].snapshot.reason, 'valuation_not_formal');
    const cmp2 = (await get(srv.port, '/api/v1/decisions/' + d2)).json.comparison;
    assert.strictEqual(cmp2.comparable, false);
    assert.strictEqual(cmp2.timepoints.reviewed.reason, 'valuation_not_formal');
    assert.ok(cmp2.timepoints.reviewed.blockers.some((b) => b.code === 'quote_missing'));
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6E-04 对照形状稳定与恢复重放：未执行决策 comparison 全 null；备份恢复后对照逐字段一致；复盘快照篡改被识别', async () => {
  const ctx = setup('ledger-p6j-');
  const srv = await startServer(ctx);
  try {
    // ① 未执行（accepted）：只有决策时点快照 → comparable=false、6 行、cell 全 null
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const accepted = await post(srv.port, '/api/v1/decisions',
      { recommendationId: rec.id, intent: 'accepted', note: '尚未执行' });
    const decisionId = accepted.json.decision.id;
    const early = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    assert.strictEqual(early.comparison.comparable, false);
    assert.strictEqual(early.comparison.rows.length, 6);
    assert.strictEqual(early.comparison.timepoints.decision.present, true);
    assert.strictEqual(early.comparison.timepoints.decision.available, true);
    assert.strictEqual(early.comparison.timepoints.executed.present, false);
    early.comparison.rows.forEach((row) => {
      assert.strictEqual(row.decision, null, '不可比对照不输出部分数字');
      assert.strictEqual(row.deltaValueMinor, null);
    });

    // ② 走到 reviewed 并生成备份
    const linked = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([buyEvent('sev-6e04')]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-6e04', decisionId, 'sev-6e04')]);
    });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));
    await post(srv.port, '/api/v1/decisions/' + decisionId + '/events', { toState: 'executed' });
    await post(srv.port, '/api/v1/decisions/' + decisionId + '/events',
      { toState: 'reviewed', note: '恢复重放用' });
    const before = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    assert.strictEqual(before.comparison.comparable, true);
    const backup = await post(srv.port, '/api/v1/backups', {});
    assert.strictEqual(backup.status, 201, JSON.stringify(backup.json));

    // ③ 篡改复盘时点快照原文一个字节 → 列表 invalidCount 留痕、详情 400、活库不变
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const raw = new DatabaseSync(ctx.paths.dbFile);
    raw.prepare("UPDATE decision_events SET snapshot_json = json_set(snapshot_json, '$.capturedAt', '2026-09-30T23:59:59.999Z') "
      + "WHERE decision_id = ? AND to_state = 'reviewed'").run(decisionId);
    raw.close();
    const badDetail = await get(srv.port, '/api/v1/decisions/' + decisionId);
    assert.strictEqual(badDetail.status, 400);
    assert.strictEqual(badDetail.json.error.code, 'invalid_decision_record');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.invalidCount, 1);

    // ④ 恢复有效备份 → 对照、快照、事件、关联逐字段一致（重放一致）
    const restore = await post(srv.port, '/api/v1/restores', { file: backup.json.backup.name });
    assert.strictEqual(restore.status, 200, JSON.stringify(restore.json));
    ctx.adopt(restore);
    const after = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    assert.deepStrictEqual(after, before, '恢复后 comparison 与全部详情逐字段一致');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.invalidCount, 0);
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ================= Phase 6F｜最终集成验收（拆解 §8） =================
 * 两套完整闭环共用一本临时账本（真实使用形态：多月共存），事件完全不重叠；
 * 负向电池覆盖：暂缓 / 忽略 / 非法跳步 / 并发重复 / 失效建议 / 缺汇率 /
 * 快照损坏 / 引用缺失 / 部分失败不落半条。全部走真实 HTTP 入口 + 注入时钟。 */

test('6F-01 场景 A：正式建议 → 接受 → 单笔买入 → 现金核对 → 执行 → 复盘（对照可比、复盘只读）', async () => {
  const ctx = setup('ledger-p6fa-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    assert.strictEqual(rec.status, 'formal');
    const accepted = await post(srv.port, '/api/v1/decisions',
      { recommendationId: rec.id, intent: 'accepted', note: '场景 A：按建议一次买入' });
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.json));
    const decisionA = accepted.json.decision.id;

    const buyRes = await post(srv.port, '/api/v1/security-events', {
      id: 'sev-6fa', eventType: 'buy', accountId: 'acc-broker', instrumentId: 'ins-voo',
      quantity: '20', priceMinor: 10000, feeMinor: 500, occurredAt: TODAY
    });
    assert.strictEqual(buyRes.status, 201, JSON.stringify(buyRes.json));
    const link = await post(srv.port, '/api/v1/decisions/' + decisionA + '/links',
      { securityEventId: 'sev-6fa', note: '一次性买入' });
    assert.strictEqual(link.status, 201, JSON.stringify(link.json));

    // 核对现金（余额已是当月，现金口径未失效）→ 执行（无偏差，note 可省）→ 复盘
    const executed = await post(srv.port, '/api/v1/decisions/' + decisionA + '/events', { toState: 'executed' });
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.json));
    assert.strictEqual(executed.json.events[1].reasonCode, 'executed_as_planned');
    const reviewed = await post(srv.port, '/api/v1/decisions/' + decisionA + '/events',
      { toState: 'reviewed', note: '场景 A 复盘：配置与执行时点一致' });
    assert.strictEqual(reviewed.status, 200);
    assert.strictEqual(reviewed.json.events[2].reasonCode, 'reviewed_no_drift');

    const detail = (await get(srv.port, '/api/v1/decisions/' + decisionA)).json;
    assert.strictEqual(detail.decision.state, 'reviewed');
    assert.strictEqual(detail.comparison.comparable, true);
    assert.strictEqual(detail.comparison.rows.length, 6);
    const cls = {
      decision: detail.snapshots.decision.classes,
      executed: detail.snapshots.executed.classes,
      review: detail.snapshots.reviewed.classes
    };
    Domain.RISK_CLASSES.forEach((name, i) => {
      const row = detail.comparison.rows[i];
      ['decision', 'executed', 'review'].forEach((pt) => {
        assert.deepStrictEqual(row[pt], cellOf(cls[pt][i]), name + '@' + pt + ' cell 与封存值一致');
      });
      assert.strictEqual(row.deltaValueMinor,
        detail.snapshots.reviewed.classes[i].valueMinor - detail.snapshots.decision.classes[i].valueMinor);
    });
    assert.strictEqual(detail.timeline.filter((t) => t.kind === 'state').length, 3);
    assert.strictEqual(detail.timeline.filter((t) => t.kind === 'link').length, 1);
    // 复盘只读
    const relink = await post(srv.port, '/api/v1/decisions/' + decisionA + '/links', { securityEventId: 'sev-6fa' });
    assert.strictEqual(relink.status, 409);
    const reEvent = await post(srv.port, '/api/v1/decisions/' + decisionA + '/events',
      { toState: 'executed', note: '再动' });
    assert.strictEqual(reEvent.status, 409);
    return { decisionA, recA: rec.id };
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6F-02 场景 B：另一月建议 → 分批跨月两笔买入（含偏差）→ 执行 → 复盘 → 备份恢复追溯；与场景 A 事件零重叠', async () => {
  const ctx = setup('ledger-p6fb-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);

    // ---- 场景 A（9 月，单笔）----
    const recA = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts))).json.recommendation;
    const accA = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recA.id, intent: 'accepted', note: '场景 A' });
    const decisionA = accA.json.decision.id;
    await post(srv.port, '/api/v1/security-events', {
      id: 'sev-6fb-a', eventType: 'buy', accountId: 'acc-broker', instrumentId: 'ins-voo',
      quantity: '20', priceMinor: 10000, feeMinor: 0, occurredAt: TODAY
    });
    await post(srv.port, '/api/v1/decisions/' + decisionA + '/links', { securityEventId: 'sev-6fb-a' });
    await post(srv.port, '/api/v1/decisions/' + decisionA + '/events', { toState: 'executed' });
    await post(srv.port, '/api/v1/decisions/' + decisionA + '/events',
      { toState: 'reviewed', note: 'A 复盘' });

    // ---- 场景 B（10 月建议，10/11 月分批两笔，HKD 汇率 0.9，偏差 −300）----
    const oct = await putFullState(srv.port, (st) => {
      st.assets.assetUnits = st.assets.assetUnits.map((u) => Object.assign({}, u, { asOf: '2026-10-04' }));
      st.assets.quotes = st.assets.quotes.concat([
        { instrumentId: 'ins-voo', priceMinor: 100, currency: 'CNY', priceDate: '2026-10-02', provider: 'manual', status: 'ok' }
      ]);
    });
    assert.strictEqual(oct.status, 200, JSON.stringify(oct.json));
    ctx.today = () => '2026-10-04';
    const recB = (await post(srv.port, '/api/v1/recommendations',
      recommendBody(facts, { newFundsMinor: 500000 }))).json.recommendation;
    assert.strictEqual(recB.allocatedTotalMinor, 500000);
    const accB = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recB.id, intent: 'accepted', note: '场景 B：分批执行' });
    assert.strictEqual(accB.status, 201, JSON.stringify(accB.json));
    const decisionB = accB.json.decision.id;
    assert.deepStrictEqual(accB.json.decision.eventMonths, ['2026-10']);

    const seeded = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([
        { id: 'sev-6fb-b1', eventType: 'buy', accountId: 'acc-broker', instrumentId: 'ins-voo',
          quantity: '20', priceMinor: 10000, feeMinor: 0, occurredAt: '2026-10-02' },
        { id: 'sev-6fb-b2', eventType: 'buy', accountId: 'acc-broker', instrumentId: 'ins-hkd',
          quantity: '30', priceMinor: 10000, feeMinor: 0, occurredAt: '2026-11-05' }
      ]);
      st.decisionLinks = (st.decisionLinks || []).concat([
        activeLink('sev-6fb-b1', decisionB, 'sev-6fb-b1'),
        activeLink('sev-6fb-b2', decisionB, 'sev-6fb-b2')
      ]);
      st.assets.quotes = st.assets.quotes.concat([
        { instrumentId: 'ins-voo', priceMinor: 100, currency: 'CNY', priceDate: '2026-11-18', provider: 'manual', status: 'ok' },
        { instrumentId: 'ins-hkd', priceMinor: 10000, currency: 'HKD', priceDate: '2026-11-18', provider: 'manual', status: 'ok' }
      ]);
      st.assets.fxRates = st.assets.fxRates.concat([
        { base: 'HKD', quote: 'CNY', rateDecimal: '0.9', rateDate: '2026-11-01', provider: 'manual', status: 'ok' },
        { base: 'HKD', quote: 'CNY', rateDecimal: '0.9', rateDate: '2026-11-18', provider: 'manual', status: 'ok' }
      ]);
      st.assets.assetUnits = st.assets.assetUnits.map((u) => Object.assign({}, u, { asOf: '2026-11-18' }));
    });
    assert.strictEqual(seeded.status, 200, JSON.stringify(seeded.json));
    ctx.today = () => '2026-11-20';
    const executedB = await post(srv.port, '/api/v1/decisions/' + decisionB + '/events',
      { toState: 'executed', note: '少投 300 元保留现金' });
    assert.strictEqual(executedB.status, 200, JSON.stringify(executedB.json));
    assert.strictEqual(executedB.json.events[1].reasonCode, 'executed_deviation');
    const reviewedB = await post(srv.port, '/api/v1/decisions/' + decisionB + '/events',
      { toState: 'reviewed', note: 'B 复盘：跨月分批完成' });
    assert.strictEqual(reviewedB.status, 200);

    // 两条闭环并存：状态、月份归属、事件零重叠
    const list = (await get(srv.port, '/api/v1/decisions')).json;
    assert.strictEqual(list.total, 2);
    assert.ok(list.items.every((d) => d.state === 'reviewed'));
    const itemA = list.items.find((d) => d.id === decisionA);
    const itemB = list.items.find((d) => d.id === decisionB);
    assert.deepStrictEqual(itemA.eventMonths, ['2026-09']);
    assert.deepStrictEqual(itemB.eventMonths, ['2026-10', '2026-11']);
    const linkIdsA = new Set((await get(srv.port, '/api/v1/decisions/' + decisionA)).json.links.map((l) => l.securityEventId));
    const linkIdsB = new Set((await get(srv.port, '/api/v1/decisions/' + decisionB)).json.links.map((l) => l.securityEventId));
    for (const id of linkIdsB) assert.strictEqual(linkIdsA.has(id), false, '两条闭环不得复用同一证券事件');
    // 月度筛选：各月只出现归属的决策
    assert.deepStrictEqual((await get(srv.port, '/api/v1/decisions?month=2026-09')).json.items.map((d) => d.id), [decisionA]);
    assert.deepStrictEqual((await get(srv.port, '/api/v1/decisions?month=2026-11')).json.items.map((d) => d.id), [decisionB]);
    assert.strictEqual((await get(srv.port, '/api/v1/decisions?month=2026-12')).json.items.length, 0, '空月份不出条目');

    // 备份 → 清空 → 恢复：两条闭环逐字段一致
    const before = {
      a: (await get(srv.port, '/api/v1/decisions/' + decisionA)).json,
      b: (await get(srv.port, '/api/v1/decisions/' + decisionB)).json
    };
    const backup = await post(srv.port, '/api/v1/backups', {});
    assert.strictEqual(backup.status, 201, JSON.stringify(backup.json));
    const clear = await request(srv.port, 'DELETE', '/api/v1/state', { headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(clear.status, 200, JSON.stringify(clear.json));
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.total, 0);
    const restore = await post(srv.port, '/api/v1/restores', { file: backup.json.backup.name });
    assert.strictEqual(restore.status, 200, JSON.stringify(restore.json));
    ctx.adopt(restore);
    assert.deepStrictEqual((await get(srv.port, '/api/v1/decisions/' + decisionA)).json, before.a, '场景 A 恢复逐字段一致');
    assert.deepStrictEqual((await get(srv.port, '/api/v1/decisions/' + decisionB)).json, before.b, '场景 B 恢复逐字段一致');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.invalidCount, 0);
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6F-03 负向电池（一）：暂缓 / 忽略不进待执行清单、非法跳步、幂等回放与冲突、失效建议接受被拒', async () => {
  const ctx = setup('ledger-p6fc-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    let seed = 0;
    const newRec = async () => {
      seed += 1;
      return (await post(srv.port, '/api/v1/recommendations',
        recommendBody(facts, { newFundsMinor: NEW_FUNDS_MINOR + seed }))).json.recommendation;
    };

    // 暂缓与忽略：可创建、不进 accepted 清单、历史可见
    const recD = await newRec();
    const deferred = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recD.id, intent: 'deferred', note: '等下个月再说' });
    assert.strictEqual(deferred.status, 201);
    const recX = await newRec();
    const dismissed = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recX.id, intent: 'dismissed', note: '暂不构成行动' });
    assert.strictEqual(dismissed.status, 201);
    const acceptedOnly = (await get(srv.port, '/api/v1/decisions?state=accepted')).json;
    assert.strictEqual(acceptedOnly.items.length, 0, '暂缓 / 忽略不进待执行清单');
    const all = (await get(srv.port, '/api/v1/decisions')).json;
    assert.deepStrictEqual(all.states.sort(), ['deferred', 'dismissed']);

    // 非法跳步：两步式 proposed 直接 executed / reviewed 均 409，且不产生事件
    const recP = await newRec();
    const proposed = await post(srv.port, '/api/v1/decisions', { recommendationId: recP.id });
    assert.strictEqual(proposed.status, 201);
    const pid = proposed.json.decision.id;
    for (const to of ['executed', 'reviewed']) {
      const skip = await post(srv.port, '/api/v1/decisions/' + pid + '/events', { toState: to, note: '跳步' });
      assert.strictEqual(skip.status, 409);
      assert.strictEqual(skip.json.error.code, 'illegal_transition');
    }
    assert.strictEqual((await get(srv.port, '/api/v1/decisions/' + pid)).json.events.length, 0, '跳步不落任何事件');

    // 幂等：创建同 key 同载荷回放、异载荷冲突
    const recI = await newRec();
    const key = '6f-idem-1';
    const first = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recI.id, intent: 'deferred', note: '幂等首建' }, { headers: { 'Idempotency-Key': key } });
    assert.strictEqual(first.status, 201);
    const replay = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recI.id, intent: 'deferred', note: '幂等首建' }, { headers: { 'Idempotency-Key': key } });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.headers['x-ledger-idempotent'], 'replay');
    const conflict = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recI.id, intent: 'deferred', note: '改成别的理由' }, { headers: { 'Idempotency-Key': key } });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.json.error.code, 'idempotency_conflict');

    // 失效建议：撤销映射后接受 409 recommendation_stale，暂缓照常（另一条新建议）
    const recS = await newRec();
    const remap = await post(srv.port, '/api/v1/approved-instruments',
      { assetClass: 'broad_equity', instrumentIds: ['ins-vgt'] });
    assert.strictEqual(remap.status, 200);
    const stale = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recS.id, intent: 'accepted', note: '试图接受失效建议' });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.json.error.code, 'recommendation_stale');
    const deferredStale = await post(srv.port, '/api/v1/decisions',
      { recommendationId: recS.id, intent: 'deferred', note: '失效建议暂缓是合法诉求' });
    assert.strictEqual(deferredStale.status, 201);
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('6F-04 负向电池（二）：缺汇率、快照损坏、引用缺失整体回滚、部分失败不落半条', async () => {
  const ctx = setup('ledger-p6fd-');
  const srv = await startServer(ctx);
  try {
    const facts = await seedAdviceChain(srv.port);
    const rec = (await post(srv.port, '/api/v1/recommendations', recommendBody(facts, { newFundsMinor: 500000 }))).json.recommendation;
    const acc = await post(srv.port, '/api/v1/decisions',
      { recommendationId: rec.id, intent: 'accepted', note: '负向电池宿主' });
    const decisionId = acc.json.decision.id;

    // ① 缺汇率：HKD 买入无 11 月前汇率 → 三个 CNY 汇总 null、fxUnavailable 列出
    const seeded = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.concat([
        { id: 'sev-6fd-hkd', eventType: 'buy', accountId: 'acc-broker', instrumentId: 'ins-hkd',
          quantity: '30', priceMinor: 10000, feeMinor: 0, occurredAt: '2026-11-05' }
      ]);
      st.decisionLinks = (st.decisionLinks || []).concat([activeLink('sev-6fd-hkd', decisionId, 'sev-6fd-hkd')]);
      st.assets.quotes = st.assets.quotes.concat([
        { instrumentId: 'ins-hkd', priceMinor: 10000, currency: 'HKD', priceDate: '2026-11-18', provider: 'manual', status: 'ok' }
      ]);
    });
    assert.strictEqual(seeded.status, 200, JSON.stringify(seeded.json));
    const fxMissing = (await get(srv.port, '/api/v1/decisions/' + decisionId)).json;
    assert.strictEqual(fxMissing.execution.linkedCount, 1);
    assert.strictEqual(fxMissing.execution.linkedPrincipalCnyMinor, null);
    assert.strictEqual(fxMissing.execution.remainingMinor, null);
    assert.deepStrictEqual(fxMissing.execution.fxUnavailable, ['sev-6fd-hkd']);

    // ② 引用缺失：全量写入省略被关联引用的事件 → linked_event_missing 整体回滚
    const dropped = await putFullState(srv.port, (st) => {
      st.assets.securityEvents = st.assets.securityEvents.filter((e) => e.id !== 'sev-6fd-hkd');
    });
    assert.strictEqual(dropped.status, 409);
    assert.strictEqual(dropped.json.error.code, 'linked_event_missing');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions/' + decisionId)).json.links.length, 1, '回滚后关联仍在');

    // ③ 部分失败不落半条：关联未知事件 → 422 且关联集合不变
    const badLink = await post(srv.port, '/api/v1/decisions/' + decisionId + '/links',
      { securityEventId: 'sev-not-exists' });
    assert.strictEqual(badLink.status, 422);
    assert.strictEqual(badLink.json.error.code, 'unknown_security_event');
    assert.strictEqual((await get(srv.port, '/api/v1/decisions/' + decisionId)).json.links.length, 1);

    // ④ 快照损坏：改库篡改一个字节 → 列表 invalidCount、详情 400；有效备份可恢复
    const backup = await post(srv.port, '/api/v1/backups', {});
    assert.strictEqual(backup.status, 201);
    const DatabaseSync = require('node:sqlite').DatabaseSync;
    const raw = new DatabaseSync(ctx.paths.dbFile);
    raw.prepare("UPDATE decision_events SET snapshot_json = json_set(snapshot_json, '$.netWorthMinor', 1)").run();
    raw.close();
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.invalidCount, 1);
    const badDetail = await get(srv.port, '/api/v1/decisions/' + decisionId);
    assert.strictEqual(badDetail.status, 400);
    assert.strictEqual(badDetail.json.error.code, 'invalid_decision_record');
    const restore = await post(srv.port, '/api/v1/restores', { file: backup.json.backup.name });
    assert.strictEqual(restore.status, 200, JSON.stringify(restore.json));
    ctx.adopt(restore);
    assert.strictEqual((await get(srv.port, '/api/v1/decisions')).json.invalidCount, 0, '有效备份可恢复损坏活库');
  } finally {
    await srv.close();
    ctx.close();
  }
});
