/* Phase 6B｜决策状态机与执行关联｜领域层测试（D-057）
 *
 * 对应 PHASE6_CONTRACT.md 的纯函数部分：
 *   - §1.2 权威转移表：7 状态完整矩阵 7×7 = 49 个有序对（合法 6 / 非法 43，含自转移），
 *     逐对数据驱动断言，不得只抽样代表样例；
 *   - §6.2 / §8 键白名单：决策请求、事件请求、记录、关联行、快照的精确键集，
 *     服务端派生键出现在载荷即拒绝；
 *   - §4.5 事件链式一致性：零事件 proposed 是合法空序列，其余必须满足
 *     seq 连续、首条 fromState=proposed、链式相接、末条与状态和 lastSeq 一致；
 *   - §6.3 理由派生：no_trade / abandoned 的可判定规则（按关联历史）、复盘漂移；
 *   - §4.4 快照 available / reason 公式与「不可比不出伪 0」；
 *   - 常量深冻结：词表可被运行时改写就必须在入口复核之外再挡一层（G5A-1 同纪律）。
 * 零时钟、零网络、零存储：全部输入显式给定。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Domain = require('../js/domain.js');

const ISO = '2026-10-15T08:00:00.000Z';
const DAY = '2026-10-15';
const HASH64 = 'a'.repeat(64);

function snapshotFixture(over) {
  const base = {
    schemaVersion: 1,
    asOf: DAY,
    capturedAt: ISO,
    available: true,
    reason: null,
    blockers: [],
    cashReconciled: true,
    valuationStatus: 'formal',
    netWorthMinor: 147000000,
    investableTotalMinor: 97000000,
    targetRef: { targetId: 'tgt-1', templateVersion: 'risk-targets-v1', ruleVersion: 'risk-rules-v1', level: 2 },
    recommendationRef: {
      recommendationId: 'rec-3f2a9c1b7d4e5f60', inputHash: HASH64,
      asOf: '2026-10-01', status: 'formal', allocatedTotalMinor: 200000
    },
    classes: Domain.RISK_CLASSES.map((k) => ({
      assetClass: k, valueMinor: 1000000, pctBps: 1000, minBps: 500,
      targetBps: 1000, maxBps: 2000, band: 'within', deviationBps: 0
    })),
    execution: { linkedCount: 1, linkedPrincipalCnyMinor: 199900, linkedFeeCnyMinor: 500, remainingMinor: 100, fxUnavailable: [] }
  };
  return Object.assign(base, over || {});
}

function decisionFixture(over) {
  return Object.assign({
    id: 'dec-0123456789abcdef',
    recommendationId: 'rec-3f2a9c1b7d4e5f60',
    state: 'accepted',
    lastSeq: 1,
    createdAt: ISO,
    updatedAt: ISO
  }, over || {});
}

function eventFixture(over) {
  return Object.assign({
    id: 'dev-0123456789abcdef',
    decisionId: 'dec-0123456789abcdef',
    seq: 1,
    fromState: 'proposed',
    toState: 'accepted',
    reasonCode: 'agree',
    note: '理由',
    occurredAt: DAY,
    recordedAt: ISO,
    actor: 'local-user',
    snapshot: snapshotFixture(),
    snapshotHash: HASH64,
    payloadHash: HASH64
  }, over || {});
}

function linkFixture(over) {
  return Object.assign({
    id: 'lnk-0123456789abcdef',
    decisionId: 'dec-0123456789abcdef',
    securityEventId: 'sev-1',
    linkedOn: DAY,
    linkedAt: ISO,
    note: null,
    unlinkedOn: null,
    unlinkedAt: null,
    unlinkNote: null
  }, over || {});
}

const errCode = (result) => (result.ok ? null : result.error.code);

test('6R-01 可比快照必须有完整金额与六类，损坏输入返回错误而非对照计算崩溃', () => {
  for (const field of ['classes', 'netWorthMinor', 'investableTotalMinor']) {
    const broken = snapshotFixture({ [field]: null });
    assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(broken)), 'invalid_decision_record', field);
    assert.strictEqual(errCode(Domain.decisionReviewComparison(broken, snapshotFixture(), snapshotFixture())),
      'invalid_decision_record', field);
  }
});

test('6R-02 缺汇率快照必须三个汇总全 null，拒绝部分小计与伪 0', () => {
  const fields = ['linkedPrincipalCnyMinor', 'linkedFeeCnyMinor', 'remainingMinor'];
  for (let mask = 0; mask < 8; mask++) {
    const execution = { ...snapshotFixture().execution, fxUnavailable: ['sev-hkd'] };
    fields.forEach((field, i) => { if (mask & (1 << i)) execution[field] = null; });
    const checked = Domain.validateDecisionSnapshotShape(snapshotFixture({ execution }));
    assert.strictEqual(checked.ok, mask === 7, 'null mask=' + mask);
  }
});

/* ================= §1.2 权威转移表：49 个有序对全遍历 ================= */

test('6B-01 完整矩阵 7×7 = 49 个有序对：合法 6 / 非法 43（含自转移），逐对数据驱动', () => {
  const legal = [
    ['proposed', 'accepted'],
    ['proposed', 'deferred'],
    ['proposed', 'dismissed'],
    ['accepted', 'executed'],
    ['accepted', 'archived'],
    ['executed', 'reviewed']
  ];
  let legalCount = 0;
  let illegalCount = 0;
  const legalSeen = [];
  for (const from of Domain.DECISION_STATES) {
    for (const to of Domain.DECISION_STATES) {
      if (Domain.isLegalDecisionTransition(from, to)) {
        legalCount += 1;
        legalSeen.push([from, to]);
      } else {
        illegalCount += 1;
      }
    }
  }
  assert.strictEqual(legalCount, 6, '合法跳转恰好 6 条');
  assert.strictEqual(illegalCount, 43, '非法跳转 43 条（含 7 条自转移）');
  assert.deepStrictEqual(legalSeen.slice().sort(), legal.slice().sort(), '合法集合必须与契约 §1.2 一致');
  // 自转移一律非法（含 accepted → accepted 重复提交）
  for (const s of Domain.DECISION_STATES) {
    assert.strictEqual(Domain.isLegalDecisionTransition(s, s), false, '自转移 ' + s + ' → ' + s + ' 必须非法');
  }
  // 词表外状态一律非法
  assert.strictEqual(Domain.isLegalDecisionTransition('unknown', 'accepted'), false);
  assert.strictEqual(Domain.isLegalDecisionTransition('accepted', 'unknown'), false);
});

test('6B-02 契约快照：词表、白名单与有序对计数有唯一权威来源', () => {
  const c = Domain.decisionPhase6Contract();
  assert.deepStrictEqual(c.states, ['proposed', 'accepted', 'deferred', 'dismissed', 'executed', 'reviewed', 'archived']);
  assert.deepStrictEqual(c.intents, ['accepted', 'deferred', 'dismissed']);
  assert.deepStrictEqual(c.reasonCodes, [
    'agree', 'postpone', 'dismiss_not_actionable', 'executed_as_planned', 'executed_deviation',
    'no_trade', 'abandoned', 'reviewed_with_drift', 'reviewed_no_drift'
  ]);
  assert.deepStrictEqual(c.archiveReasonCodes, ['no_trade', 'abandoned']);
  assert.deepStrictEqual(c.snapshotReasonCodes, ['cash_not_reconciled', 'valuation_not_formal']);
  assert.strictEqual(c.actor, 'local-user');
  assert.strictEqual(c.snapshotSchemaVersion, 1);
  assert.strictEqual(c.noteMaxChars, 2000);
  assert.deepStrictEqual(c.orderedPairs, { total: 49, legal: 6, illegal: 43, selfTransitions: 7 });
  assert.deepStrictEqual(c.legalTransitions.proposed, ['accepted', 'deferred', 'dismissed']);
  assert.deepStrictEqual(c.legalTransitions.accepted, ['executed', 'archived']);
  assert.deepStrictEqual(c.legalTransitions.executed, ['reviewed']);
  // 词表是冻结的：运行时改写必须无效（G5A-1 同纪律）
  assert.throws(() => { Domain.DECISION_STATES.push('hijacked'); }, TypeError);
  assert.strictEqual(Domain.DECISION_STATES.length, 7);
  assert.throws(() => { Domain.DECISION_LEGAL_TRANSITIONS.reviewed = ['accepted']; }, TypeError);
  assert.strictEqual(Domain.DECISION_LEGAL_TRANSITIONS.reviewed, undefined);
});

/* ================= §8 请求键白名单（含服务端派生键拒绝） ================= */

test('6B-03 创建请求白名单：多一个键即拒绝，派生键 / 时间 / actor 不得由客户端提交', () => {
  assert.strictEqual(Domain.validateDecisionRequest({ recommendationId: 'rec-1' }).ok, true);
  const withIntent = Domain.validateDecisionRequest({ recommendationId: 'rec-1', intent: 'accepted', note: ' 理由 ' });
  assert.strictEqual(withIntent.ok, true);
  assert.strictEqual(withIntent.value.note, '理由', 'note 必须去空白');
  assert.strictEqual(withIntent.value.intent, 'accepted');

  // 服务端派生键（契约 §6.2）出现在载荷即 400
  ['id', 'state', 'occurredAt', 'recordedAt', 'actor', 'snapshot', 'createdAt', 'lastSeq'].forEach((k) => {
    const payload = { recommendationId: 'rec-1' };
    payload[k] = k === 'state' ? 'executed' : 'x';
    assert.strictEqual(errCode(Domain.validateDecisionRequest(payload)), 'invalid_decision_payload',
      '载荷出现派生键 ' + k + ' 必须拒绝');
  });
  // 原型链注入同样拒绝（hasExactRiskKeys 同纪律）
  const proto = Object.create({ recommendationId: 'rec-1' });
  assert.strictEqual(errCode(Domain.validateDecisionRequest(proto)), 'invalid_decision_payload');

  // intent：executed/reviewed/archived/proposed 是状态问题 → illegal_transition（HTTP 409）
  ['executed', 'reviewed', 'archived', 'proposed'].forEach((intent) => {
    assert.strictEqual(
      errCode(Domain.validateDecisionRequest({ recommendationId: 'rec-1', intent })),
      'illegal_transition', 'intent=' + intent + ' 必须报 illegal_transition'
    );
  });
  // 其余形状问题 → invalid_decision_payload（HTTP 400）
  assert.strictEqual(errCode(Domain.validateDecisionRequest({ recommendationId: 'rec-1', intent: 'Accepted' })),
    'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionRequest({ recommendationId: 'rec-1', intent: 1 })),
    'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionRequest({ recommendationId: '' })), 'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionRequest({ recommendationId: 'rec-1', note: 'x'.repeat(2001) })),
    'invalid_decision_payload', 'note 超过 2000 字符必须拒绝');
  assert.strictEqual(errCode(Domain.validateDecisionRequest({ recommendationId: 'rec-1', extra: 1 })),
    'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionRequest(null)), 'invalid_decision_payload');
});

test('6B-04 事件请求白名单：toState 只做词表形状校验，方向合法性交给当前状态', () => {
  assert.strictEqual(Domain.validateDecisionEventRequest({ toState: 'executed', note: '无偏差' }).ok, true);
  assert.strictEqual(Domain.validateDecisionEventRequest({ toState: 'proposed' }).ok, true,
    'toState=proposed 是词表内的形状，合法性由转移表判为 409');
  assert.strictEqual(errCode(Domain.validateDecisionEventRequest({ toState: 'EXECUTED' })), 'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionEventRequest({})), 'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionEventRequest({ toState: 'executed', fromState: 'accepted' })),
    'invalid_decision_payload', 'fromState 是派生键，不得由客户端提交');
  assert.strictEqual(errCode(Domain.validateDecisionEventRequest({ toState: 'executed', note: 'x'.repeat(2001) })),
    'invalid_decision_payload');
});

/* ================= 记录 / 关联行 / 快照形状 ================= */

test('6B-05 记录与关联行形状：精确键集、id 形状、软删除一致性', () => {
  assert.strictEqual(Domain.validateDecisionRecord(decisionFixture()).ok, true);
  assert.strictEqual(errCode(Domain.validateDecisionRecord(decisionFixture({ id: 'dec-ZZ' }))), 'invalid_decision_record');
  assert.strictEqual(errCode(Domain.validateDecisionRecord(decisionFixture({ state: 'removed' }))), 'invalid_decision_record');
  assert.strictEqual(errCode(Domain.validateDecisionRecord(decisionFixture({ lastSeq: -1 }))), 'invalid_decision_record');
  assert.strictEqual(errCode(Domain.validateDecisionRecord(decisionFixture({ createdAt: '2026-10-15 08:00:00' }))),
    'invalid_decision_record', '无时区的时间戳必须拒绝');
  assert.strictEqual(errCode(Domain.validateDecisionRecord(decisionFixture({ extra: 1 }))), 'invalid_decision_record');

  assert.strictEqual(Domain.validateDecisionLinkRecord(linkFixture()).ok, true);
  assert.strictEqual(Domain.validateDecisionLinkRecord(linkFixture({
    unlinkedOn: '2026-10-16', unlinkedAt: '2026-10-16T08:00:00.000Z', unlinkNote: '选错账户'
  })).ok, true, '完整解绑行合法');
  assert.strictEqual(errCode(Domain.validateDecisionLinkRecord(linkFixture({ unlinkedOn: '2026-10-16' }))),
    'invalid_decision_record', '解绑必须带 unlinkNote');
  assert.strictEqual(errCode(Domain.validateDecisionLinkRecord(linkFixture({ unlinkNote: '未解绑却带理由' }))),
    'invalid_decision_record', '活动关联不得携带解绑字段');
});

test('6B-06 快照形状：不可比不出伪 0、可比必带六类、键集精确', () => {
  assert.strictEqual(Domain.validateDecisionSnapshotShape(snapshotFixture()).ok, true);
  const unavailable = {
    netWorthMinor: null, investableTotalMinor: null, classes: null,
    available: false, reason: 'cash_not_reconciled'
  };
  assert.strictEqual(Domain.validateDecisionSnapshotShape(snapshotFixture(unavailable)).ok, true,
    '不可比快照（数字全 null + 冻结 reason）合法');
  // 可比时 reason 必须为 null（§4.2 示例与 §4.4 公式一致）
  assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(snapshotFixture({ reason: 'valuation_not_formal' }))),
    'invalid_decision_record');
  // 不可比但携带数字 = 出伪 0 → 拒绝
  assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(snapshotFixture({
    available: false, reason: 'cash_not_reconciled', netWorthMinor: 1
  }))), 'invalid_decision_record', '不可比快照不得携带任何数字');
  assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(snapshotFixture({
    available: false, reason: 'cash_not_reconciled', classes: snapshotFixture().classes
  }))), 'invalid_decision_record');
  // reason 必须来自冻结词表
  assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(snapshotFixture({
    available: false, reason: 'quote_missing', netWorthMinor: null, investableTotalMinor: null, classes: null
  }))), 'invalid_decision_record');
  // classes 必须恰好六行且按 RISK_CLASSES 序
  assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(snapshotFixture({
    classes: snapshotFixture().classes.slice(0, 5)
  }))), 'invalid_decision_record');
  const swapped = snapshotFixture();
  const c0 = swapped.classes[0];
  swapped.classes[0] = swapped.classes[1];
  swapped.classes[1] = c0;
  assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(swapped)), 'invalid_decision_record',
    '类别序必须与 RISK_CLASSES 一致');
  // execution 键集精确
  assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(snapshotFixture({
    execution: { linkedCount: 0, linkedPrincipalCnyMinor: 0, linkedFeeCnyMinor: 0, remainingMinor: 0 }
  }))), 'invalid_decision_record');
  // 缺汇率（fxUnavailable 非空）时三个 CNY 汇总必须全为 null（二次勘误：绝不部分小计或伪 0）
  assert.strictEqual(Domain.validateDecisionSnapshotShape(snapshotFixture({
    execution: { linkedCount: 2, linkedPrincipalCnyMinor: null, linkedFeeCnyMinor: null, remainingMinor: null, fxUnavailable: ['sev-hkd'] }
  })).ok, true);
  assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(snapshotFixture({
    execution: { linkedCount: 2, linkedPrincipalCnyMinor: null, linkedFeeCnyMinor: null, remainingMinor: null, fxUnavailable: [] }
  }))), 'invalid_decision_record', '汇总为 null 必须因缺汇率');
  assert.strictEqual(errCode(Domain.validateDecisionSnapshotShape(snapshotFixture({
    execution: { linkedCount: 1, linkedPrincipalCnyMinor: 199900, linkedFeeCnyMinor: 500, remainingMinor: 100, fxUnavailable: ['sev-hkd'] }
  }))), 'invalid_decision_record', '缺汇率时不得保留部分小计');
  // 投资池为 0 是合法可比状态（比例列 null，不算不可比）
  const zeroPool = snapshotFixture();
  zeroPool.classes = zeroPool.classes.map((r) => Object.assign({}, r, { valueMinor: 0, pctBps: null, band: null, deviationBps: null }));
  zeroPool.investableTotalMinor = 0;
  assert.strictEqual(Domain.validateDecisionSnapshotShape(zeroPool).ok, true);
});

/* ================= §4.5 事件链式一致性 ================= */

test('6B-07 链式校验：零事件 proposed 合法空序列，其余必须满足 seq 连续与链式相接', () => {
  // 零事件 proposed（两步式创建）：合法空序列，且不得携带任何事件
  assert.strictEqual(Domain.validateDecisionEventChain(decisionFixture({ state: 'proposed', lastSeq: 0 }), []).ok, true);
  assert.strictEqual(errCode(Domain.validateDecisionEventChain(
    decisionFixture({ state: 'proposed', lastSeq: 0 }), [eventFixture()])),
    'invalid_decision_record', '零事件决策不得携带事件');
  assert.strictEqual(errCode(Domain.validateDecisionEventChain(
    decisionFixture({ state: 'accepted', lastSeq: 1 }), [])),
    'invalid_decision_record', '非 proposed 状态必须有事件序列');

  const single = eventFixture();
  const okChain = Domain.validateDecisionEventChain(decisionFixture(), [single]);
  assert.strictEqual(okChain.ok, true);
  assert.deepStrictEqual(okChain.events, [single], '事件必须按 seq 升序返回');
  // 乱序输入同样通过（内部排序，与行序无关）
  const second = eventFixture({
    id: 'dev-ffffffffffffffff', seq: 2, fromState: 'accepted', toState: 'executed',
    reasonCode: 'executed_as_planned', snapshot: snapshotFixture({ execution: { linkedCount: 1, linkedPrincipalCnyMinor: 200000, linkedFeeCnyMinor: 0, remainingMinor: 0, fxUnavailable: [] } })
  });
  assert.strictEqual(Domain.validateDecisionEventChain(
    decisionFixture({ state: 'executed', lastSeq: 2 }), [second, single]).ok, true,
    '乱序事件集合必须按 seq 排序后复核');

  // seq 必须从 1 连续递增
  assert.strictEqual(errCode(Domain.validateDecisionEventChain(
    decisionFixture(), [eventFixture({ seq: 2 })])), 'invalid_decision_record');
  // 首条 fromState 必须 proposed
  assert.strictEqual(errCode(Domain.validateDecisionEventChain(
    decisionFixture({ state: 'executed', lastSeq: 2 }),
    [eventFixture({ fromState: 'accepted' }), second])), 'invalid_decision_record');
  // 链式相接：fromState 必须等于上一条 toState
  assert.strictEqual(errCode(Domain.validateDecisionEventChain(
    decisionFixture({ state: 'executed', lastSeq: 2 }),
    [single, eventFixture({ id: 'dev-ffffffffffffffff', seq: 2, fromState: 'proposed', toState: 'executed' })])),
    'invalid_decision_record');
  // 链内方向必须在合法转移表内（proposed → executed 不存在）
  assert.strictEqual(errCode(Domain.validateDecisionEventChain(
    decisionFixture({ state: 'executed', lastSeq: 1 }),
    [eventFixture({ toState: 'executed', reasonCode: 'executed_as_planned' })])),
    'invalid_decision_record', '跳步事件即使形式上接链也必须拒绝');
  // 末条 toState 必须等于决策状态；lastSeq 必须等于 max(seq)
  assert.strictEqual(errCode(Domain.validateDecisionEventChain(
    decisionFixture({ state: 'deferred' }), [single])), 'invalid_decision_record');
  assert.strictEqual(errCode(Domain.validateDecisionEventChain(
    decisionFixture({ lastSeq: 2 }), [single])), 'invalid_decision_record');
  // actor 只能是 local-user
  assert.strictEqual(errCode(Domain.validateDecisionEventChain(
    decisionFixture(), [eventFixture({ actor: 'admin' })])), 'invalid_decision_record');
});

/* ================= §6.3 理由派生与 §4.4 可比性公式 ================= */

test('6B-08 归档理由可判定规则（二次勘误后）：金额为 0 且从未关联 → no_trade，其余归档均为 abandoned', () => {
  assert.strictEqual(Domain.deriveArchiveReason(0, false), 'no_trade', '零金额建议且从未关联过买入');
  assert.strictEqual(Domain.deriveArchiveReason(0, true), 'abandoned', '零金额建议曾关联后全部解绑');
  assert.strictEqual(Domain.deriveArchiveReason(200000, false), 'abandoned', '正金额建议未买即放弃');
  assert.strictEqual(Domain.deriveArchiveReason(200000, true), 'abandoned', '正金额建议曾关联后解绑');
});

test('6B-09 快照可比性公式：available = canAdvise && cashReconciled，可比时 reason 恒 null', () => {
  const fresh = { canAdvise: true, freshness: { balanceStale: false } };
  const stale = { canAdvise: true, freshness: { balanceStale: true } };
  const notFormal = { canAdvise: false, freshness: { balanceStale: false } };
  const both = { canAdvise: false, freshness: { balanceStale: true } };
  assert.deepStrictEqual(Domain.decisionSnapshotGate(fresh), { cashReconciled: true, available: true, reason: null });
  assert.deepStrictEqual(Domain.decisionSnapshotGate(stale), { cashReconciled: false, available: false, reason: 'cash_not_reconciled' });
  assert.deepStrictEqual(Domain.decisionSnapshotGate(notFormal), { cashReconciled: true, available: false, reason: 'valuation_not_formal' });
  assert.deepStrictEqual(Domain.decisionSnapshotGate(both), { cashReconciled: false, available: false, reason: 'cash_not_reconciled' },
    '现金未核对优先于估值不正式');
});

test('6B-10 复盘漂移：六类金额或比例与执行时点不同 → drift，否则 no_drift', () => {
  const executed = snapshotFixture();
  assert.strictEqual(Domain.decisionReviewDrift(executed, snapshotFixture()).drift, false,
    '逐项相同 → reviewed_no_drift');
  const driftedValue = snapshotFixture();
  driftedValue.classes[2].valueMinor += 1;
  assert.strictEqual(Domain.decisionReviewDrift(executed, driftedValue).drift, true,
    '金额变化 → reviewed_with_drift');
  const driftedPct = snapshotFixture();
  driftedPct.classes[2].pctBps += 1;
  assert.strictEqual(Domain.decisionReviewDrift(executed, driftedPct).drift, true,
    '比例变化 → reviewed_with_drift');
  assert.strictEqual(errCode(Domain.decisionReviewDrift(executed, snapshotFixture({ schemaVersion: 2 }))),
    'invalid_decision_record', '形状不合法的快照不能参与漂移判定');
});

/* ================= Phase 6D：关联 / 解绑请求白名单（契约 §8.5，6D 补充） ================= */

test('6D-11 关联请求白名单：securityEventId 必填、note 可选且去空白、派生键与多余键一律 400', () => {
  const ok = Domain.validateDecisionLinkRequest({ securityEventId: 'sev-6d00000000000001', note: ' 第一笔买入 ' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.securityEventId, 'sev-6d00000000000001');
  assert.strictEqual(ok.value.note, '第一笔买入', 'note 去空白');
  const noNote = Domain.validateDecisionLinkRequest({ securityEventId: 'sev-6d00000000000001' });
  assert.strictEqual(noNote.ok, true, '关联 note 可省略');
  assert.strictEqual(noNote.value.note, null);

  assert.strictEqual(errCode(Domain.validateDecisionLinkRequest({})), 'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionLinkRequest({ securityEventId: '' })), 'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionLinkRequest({ securityEventId: '   ' })), 'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionLinkRequest({ securityEventId: 60001 })), 'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionLinkRequest({ securityEventId: 'sev-1', note: 42 })),
    'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionLinkRequest({ securityEventId: 'sev-1', note: 'x'.repeat(2001) })),
    'invalid_decision_payload', 'note 上限 2000 字符');

  // 派生键（契约 §6.2）与无关键不得由客户端提交
  ['id', 'decisionId', 'linkedOn', 'linkedAt', 'unlinkedOn', 'unlinkedAt', 'unlinkNote', 'actor', 'event'].forEach((k) => {
    const payload = { securityEventId: 'sev-1' };
    payload[k] = 'x';
    assert.strictEqual(errCode(Domain.validateDecisionLinkRequest(payload)), 'invalid_decision_payload',
      '载荷出现键 ' + k + ' 必须拒绝');
  });
  const proto = Object.create({ securityEventId: 'sev-1' });
  assert.strictEqual(errCode(Domain.validateDecisionLinkRequest(proto)), 'invalid_decision_payload', '原型链注入拒绝');
  assert.strictEqual(errCode(Domain.validateDecisionLinkRequest(null)), 'invalid_decision_payload');
  assert.strictEqual(Domain.DECISION_LINK_REQUEST_KEYS.length, 2, '白名单键数固定：securityEventId / note');
  assert.strictEqual(Object.isFrozen(Domain.DECISION_LINK_REQUEST_KEYS), true);
});

test('6D-12 解绑请求白名单：linkId 必须是 lnk-<16hex> 且 note 必填（解绑必须写理由）', () => {
  const ok = Domain.validateDecisionUnlinkRequest({ linkId: 'lnk-0123456789abcdef', note: ' 选错了账户 ' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.linkId, 'lnk-0123456789abcdef');
  assert.strictEqual(ok.value.note, '选错了账户');

  assert.strictEqual(errCode(Domain.validateDecisionUnlinkRequest({})), 'invalid_decision_payload');
  assert.strictEqual(errCode(Domain.validateDecisionUnlinkRequest({ linkId: 'lnk-0123456789abcdef' })),
    'invalid_decision_payload', '解绑必须填写理由');
  assert.strictEqual(errCode(Domain.validateDecisionUnlinkRequest({ linkId: 'lnk-0123456789abcdef', note: '   ' })),
    'invalid_decision_payload', '空白理由不算理由');
  assert.strictEqual(errCode(Domain.validateDecisionUnlinkRequest({ linkId: 'lnk-0123456789abcdef', note: null })),
    'invalid_decision_payload');
  ['nope', 'lnk-ZZ23456789abcdef', 'dec-0123456789abcdef', 'lnk-0123456789abcde'].forEach((bad) => {
    assert.strictEqual(errCode(Domain.validateDecisionUnlinkRequest({ linkId: bad, note: '理由' })),
      'invalid_decision_payload', 'linkId 形状不合法必须 400：' + bad);
  });
  ['id', 'unlinkedOn', 'unlinkedAt', 'unlinkNote', 'securityEventId', 'decisionId'].forEach((k) => {
    const payload = { linkId: 'lnk-0123456789abcdef', note: '理由' };
    payload[k] = 'x';
    assert.strictEqual(errCode(Domain.validateDecisionUnlinkRequest(payload)), 'invalid_decision_payload',
      '载荷出现键 ' + k + ' 必须拒绝');
  });
  assert.strictEqual(errCode(Domain.validateDecisionUnlinkRequest(null)), 'invalid_decision_payload');
  assert.strictEqual(Domain.DECISION_UNLINK_REQUEST_KEYS.length, 2, '白名单键数固定：linkId / note');
  assert.strictEqual(Object.isFrozen(Domain.DECISION_UNLINK_REQUEST_KEYS), true);
});

/* ================= Phase 6E：六类配置对照（契约 §4.3 6E 补充） ================= */

// 逐分 / 逐 basis point 的手工 fixture：三类有值、三类为 0（0 投资池行），三时点各不相同。
function comparisonSnapshot(classesValues, over) {
  const snap = snapshotFixture();
  snap.classes = Domain.RISK_CLASSES.map((k, i) => {
    const v = classesValues[i];
    return {
      assetClass: k, valueMinor: v[0], pctBps: v[1], minBps: 500,
      targetBps: 1000, maxBps: 2000, band: v[1] == null ? null : 'within', deviationBps: v[1] == null ? null : v[1] - 1000
    };
  });
  return Object.assign(snap, over || {});
}

test('6E-11 对照逐分核对：三时点 cell 取封存原值、delta 可复算、0 投资池不算不可比', () => {
  // 手工指定六个类别的三时点值：[金额分, bps]；比例 null 表示 0 投资池行
  const decision = comparisonSnapshot([
    [50000000, 5154], [10000000, 1031], [37000000, 3815], [0, 0], [0, 0], [0, 0]
  ]);
  const executed = comparisonSnapshot([
    [48000000, 5000], [10000000, 1042], [38000000, 3958], [0, 0], [0, 0], [0, 0]
  ]);
  const reviewed = comparisonSnapshot([
    [49500000, 5100], [10000000, 1031], [38500000, 3869], [0, 0], [0, 0], [0, 0]
  ]);
  const cmp = Domain.decisionReviewComparison(decision, executed, reviewed);
  assert.strictEqual(cmp.ok, true);
  const c = cmp.value;
  assert.strictEqual(c.comparable, true, '三时点齐全且可比');
  assert.strictEqual(c.rows.length, 6, '恒 6 行');
  assert.deepStrictEqual(c.rows.map((r) => r.assetClass), Domain.RISK_CLASSES.slice(), '恒按 RISK_CLASSES 序');

  // 逐分核对：每个 cell 与封存 classes 原值一致；delta 恰为 review − decision
  const byPoint = { decision: decision.classes, executed: executed.classes, review: reviewed.classes };
  Domain.RISK_CLASSES.forEach((cls, i) => {
    const row = c.rows[i];
    ['decision', 'executed', 'review'].forEach((pt) => {
      const src = byPoint[pt][i];
      assert.deepStrictEqual(row[pt], {
        valueMinor: src.valueMinor, pctBps: src.pctBps,
        deviationBps: src.deviationBps, band: src.band
      }, cls + ' @ ' + pt + ' 必须取封存原值');
    });
    assert.strictEqual(row.deltaValueMinor, reviewed.classes[i].valueMinor - decision.classes[i].valueMinor,
      cls + ' deltaValueMinor = review − decision（逐分）');
    assert.strictEqual(row.deltaPctBps, reviewed.classes[i].pctBps - decision.classes[i].pctBps,
      cls + ' deltaPctBps = review − decision（逐 bps）');
    assert.strictEqual(row.targetBps, 1000, 'targetBps 取参照目标历史版本');
  });
  assert.strictEqual(c.rows[0].deltaValueMinor, -500000, '现金 495.00 − 500.00 = −5.00 元 = −500 分');
  assert.strictEqual(c.rows[0].deltaPctBps, -54, '5100 − 5154 = −54 bps');
  assert.strictEqual(Domain.validateDecisionComparisonShape(c).ok, true);

  // 时点元数据：可比时 reason 恒 null、blockers 原样搬运
  ['decision', 'executed', 'reviewed'].forEach((k) => {
    assert.deepStrictEqual(c.timepoints[k], { present: true, available: true, reason: null, blockers: [] });
  });

  // 0 投资池行：比例与区间为 null 但金额照常输出，不算不可比
  const zeroRow = c.rows[3];
  assert.deepStrictEqual(zeroRow.decision, { valueMinor: 0, pctBps: 0, deviationBps: -1000, band: 'within' },
    'pctBps=0（非 null）是真实比例，照常输出');
});

test('6E-12 对照不可比与缺失：任一时点不可比 → 全表不出数字；快照缺失 → present:false；形状坏 → fail closed', () => {
  const decision = comparisonSnapshot([[50000000, 5154], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
  const executed = comparisonSnapshot([[48000000, 5000], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
  const reviewedAvailable = comparisonSnapshot([[49500000, 5100], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
  const reviewedUnavailable = comparisonSnapshot([[0, null], [0, null], [0, null], [0, null], [0, null], [0, null]], {
    available: false, reason: 'cash_not_reconciled',
    blockers: [{ code: 'balance_stale', detail: '现金余额未核对' }],
    netWorthMinor: null, investableTotalMinor: null, classes: null
  });

  // ① 复盘时点不可比：comparable=false，全部 cell 与 delta 为 null，不出伪 0
  const cmp1 = Domain.decisionReviewComparison(decision, executed, reviewedUnavailable);
  assert.strictEqual(cmp1.ok, true);
  assert.strictEqual(cmp1.value.comparable, false);
  cmp1.value.rows.forEach((row) => {
    assert.strictEqual(row.decision, null);
    assert.strictEqual(row.executed, null);
    assert.strictEqual(row.review, null);
    assert.strictEqual(row.deltaValueMinor, null);
    assert.strictEqual(row.deltaPctBps, null);
    assert.strictEqual(row.targetBps, null, '无可比时点时 targetBps 也不输出');
  });
  assert.strictEqual(cmp1.value.timepoints.reviewed.present, true);
  assert.strictEqual(cmp1.value.timepoints.reviewed.available, false);
  assert.strictEqual(cmp1.value.timepoints.reviewed.reason, 'cash_not_reconciled');
  assert.deepStrictEqual(cmp1.value.timepoints.reviewed.blockers,
    [{ code: 'balance_stale', detail: '现金余额未核对' }], 'blockers 原样搬运');
  assert.strictEqual(cmp1.value.timepoints.decision.available, true, '其余时点可用性照实记录');
  assert.strictEqual(Domain.validateDecisionComparisonShape(cmp1.value).ok, true);

  // ② 快照缺失（尚未执行 / 复盘）：present:false、comparable=false、无数字
  const cmp2 = Domain.decisionReviewComparison(decision, null, null);
  assert.strictEqual(cmp2.value.comparable, false);
  assert.strictEqual(cmp2.value.timepoints.executed.present, false);
  assert.strictEqual(cmp2.value.timepoints.reviewed.present, false);
  assert.strictEqual(cmp2.value.rows[0].decision, null);
  assert.strictEqual(cmp2.value.rows[0].deltaValueMinor, null);

  // ③ 0 投资池三时点：可比、金额为 0、比例列 null 且 deltaPctBps 为 null（不算不可比）
  const zero = comparisonSnapshot([[0, null], [0, null], [0, null], [0, null], [0, null], [0, null]]);
  zero.investableTotalMinor = 0;
  const cmp3 = Domain.decisionReviewComparison(zero, comparisonSnapshot(
    [[0, null], [0, null], [0, null], [0, null], [0, null], [0, null]], { investableTotalMinor: 0 }), zero);
  assert.strictEqual(cmp3.value.comparable, true, '0 投资池是合法可比状态');
  assert.strictEqual(cmp3.value.rows[0].decision.valueMinor, 0);
  assert.strictEqual(cmp3.value.rows[0].decision.pctBps, null);
  assert.strictEqual(cmp3.value.rows[0].deltaValueMinor, 0);
  assert.strictEqual(cmp3.value.rows[0].deltaPctBps, null, '两端比例不可用 → deltaPctBps null');
  assert.strictEqual(cmp3.value.rows[0].targetBps, 1000, 'targetBps 照常给出');
  assert.strictEqual(Domain.validateDecisionComparisonShape(cmp3.value).ok, true);

  // ④ 输入快照形状不合法 → fail closed（服务端详情整体 400）
  assert.strictEqual(Domain.decisionReviewComparison(decision, executed, snapshotFixture({ schemaVersion: 2 })).ok, false);
  assert.strictEqual(Domain.decisionReviewComparison(null, executed, reviewedAvailable).value.comparable, false,
    '决策时点缺失也是可比性缺失，不是异常');

  // ⑤ 同一 targetRef 下 targetBps 不一致 → 记录损坏
  const inconsistent = comparisonSnapshot([[49500000, 5100], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
  inconsistent.classes[0].targetBps = 2000;
  assert.strictEqual(Domain.decisionReviewComparison(decision, executed, inconsistent).ok, false);
});
