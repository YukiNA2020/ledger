/* server/decisions.js — Phase 6B 决策编排（D-057）
 *
 * 职责（契约 PHASE6_CONTRACT.md §1/§2/§4/§8）：
 *   - 唯一的转移校验实现：服务端据当前状态执行命令，客户端不能提交任意状态覆盖；
 *   - 每次状态事件封存一份三时点快照（决策 / 执行 / 复盘），估值只消费
 *     Domain.computeOverview 与 Domain.computeAllocationDeviation 的同一遍结果（D-025），
 *     参照目标固定为决策所引用建议的历史目标版本（targetRef）；
 *   - 接受门禁（§2.2）在创建 accepted 的同事务内重核：adviceStaleness 身份比对 +
 *     5D 门禁复放 + G5-R1 引用交叉一致；deferred / dismissed 不重核（归档失效建议是合法诉求）；
 *   - 理由码由服务端按 §6.3 派生，note 是用户的自由文本理由；
 *   - 时间一律取 ctx 注入（today / nowIso，D-053），本模块不读时钟、不发网络、不写 txns、
 *     不改写建议记录（金额永远只读 rec.allocatedTotalMinor）。
 *
 * SQL 全部经 server/repository.js；关联 / 解绑 HTTP 入口属 6D，本模块只提供 6B 的
 * 创建与事件端点所需的编排与只读视图装配。
 */
'use strict';

const crypto = require('node:crypto');
const Domain = require('../js/domain.js');
const R = require('./repository');

function decisionFail(code, message) {
  throw Object.assign(new Error(message || code), { code: code });
}

// 确定性 id：决策 id 由 recommendation_id 派生（一条建议最多一条决策，幂等回放天然同 id）；
// 事件 id 由 (decisionId, seq) 派生（事件只追加，同一位置重放同 id）。
function decisionRecordId(recommendationId) {
  return 'dec-' + crypto.createHash('sha256').update('decision:' + recommendationId).digest('hex').slice(0, 16);
}

function decisionEventId(decisionId, seq) {
  return 'dev-' + crypto.createHash('sha256').update('decision-event:' + decisionId + ':' + seq).digest('hex').slice(0, 16);
}

function decisionLinkRecordId(decisionId, securityEventId) {
  return 'lnk-' + crypto.createHash('sha256').update('decision-link:' + decisionId + ':' + securityEventId).digest('hex').slice(0, 16);
}

/* ------------------------------ 快照与执行汇总 ------------------------------ */

// 契约 §3.3 / §4.2 execution（二次勘误后）：活动关联 buy 的本金按各自交易日 as-of 汇率折 CNY
// 后求和；**任一活动事件缺汇率 → 三个 CNY 汇总（本金 / 费用 / 剩余）全部为 null**，绝不部分小计
// 或按 1:1 / 期末汇率 / 伪 0 兜底；linkedCount 仍是实际活动关联条数，fxUnavailable 按
// 事件 (occurred_at, id) 升序。无活动关联时汇总为 0、剩余为建议金额、fxUnavailable=[]。
function executionSummary(rec, decisionId, links, securityEvents, fxRates) {
  const eventsById = new Map(securityEvents.map((e) => [e.id, e]));
  const active = links.filter((l) => l.decisionId === decisionId && l.unlinkedOn == null);
  const rateCache = new Map();
  const rateFor = (ev) => {
    const key = ev.currency + ':' + ev.occurredAt;
    if (!rateCache.has(key)) rateCache.set(key, Domain.findFxRateAsOf(fxRates, ev.currency, 'CNY', ev.occurredAt));
    return rateCache.get(key);
  };
  let principal = 0;
  let fee = 0;
  const fxUnavailable = [];
  active.forEach((l) => {
    const ev = eventsById.get(l.securityEventId);
    if (!ev || ev.eventType !== 'buy') {
      decisionFail('invalid_decision_record', '活动关联指向的证券事件缺失或不是 buy：' + l.securityEventId);
    }
    const principalMinor = Domain.mulMinor(ev.quantity, ev.priceMinor);
    if (principalMinor == null) {
      decisionFail('invalid_decision_record', '关联事件本金无法计算（数量×单价溢出或缺失）：' + ev.id);
    }
    let principalCny = principalMinor;
    let feeCny = ev.feeMinor == null ? 0 : ev.feeMinor;
    if (ev.currency !== 'CNY') {
      const rate = rateFor(ev);
      if (!rate) {
        // 契约 §3.3（二次勘误）：缺汇率 → 该事件不产生 CNY 数字，三个汇总额最终全为 null
        fxUnavailable.push(ev);
        principalCny = null;
        feeCny = null;
      } else {
        principalCny = Domain.mulByRate(principalMinor, rate.rateDecimal);
        feeCny = ev.feeMinor == null ? 0 : Domain.mulByRate(ev.feeMinor, rate.rateDecimal);
        if (principalCny == null || feeCny == null) {
          decisionFail('invalid_decision_record', '关联事件折算溢出：' + ev.id);
        }
      }
    }
    if (principalCny == null || feeCny == null) {
      principal = null;
      fee = null;
    } else if (principal != null) {
      principal += principalCny;
      fee += feeCny;
    }
  });
  return {
    linkedCount: active.length,
    linkedPrincipalCnyMinor: principal,
    linkedFeeCnyMinor: fee,
    remainingMinor: principal == null ? null : rec.allocatedTotalMinor - principal,
    fxUnavailable: fxUnavailable
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
      .map((ev) => ev.id)
  };
}

// 契约 §4.2 快照：三时点各封存一份；available=false 时数字字段全 null（不出伪 0），
// classes（六类金额 / 比例 / 偏离）只在可比时给出，且目标区间来自决策引用的历史目标版本。
function buildSnapshot(db, rec, state, overview, today, nowIso, decisionId, links, securityEvents) {
  const gate = Domain.decisionSnapshotGate(overview);
  const target = R.getAllocationTarget(db, rec.targetId);
  if (!target) {
    decisionFail('invalid_recommendation_record', '建议引用的目标版本不存在：' + rec.targetId);
  }
  const deviation = Domain.computeAllocationDeviation(target, overview);
  if (!deviation.ok) {
    decisionFail('invalid_recommendation_record', '无法在当前估值上计算类别偏离：' + (deviation.error && deviation.error.detail));
  }
  const snapshot = {
    schemaVersion: Domain.DECISION_SNAPSHOT_SCHEMA_VERSION,
    asOf: today,
    capturedAt: nowIso,
    available: gate.available,
    reason: gate.reason,
    blockers: (overview.blockers || []).map((b) => ({
      code: b && b.code == null ? null : b.code,
      detail: b && b.detail == null ? '' : b.detail
    })),
    cashReconciled: gate.cashReconciled,
    valuationStatus: overview.valuationStatus || null,
    netWorthMinor: gate.available ? overview.netWorthMinor : null,
    investableTotalMinor: gate.available ? overview.pools.investableMinor : null,
    targetRef: {
      targetId: rec.targetId,
      templateVersion: rec.targetVersion,
      ruleVersion: rec.ruleVersion,
      level: target.level
    },
    recommendationRef: {
      recommendationId: rec.id,
      inputHash: rec.inputHash,
      asOf: rec.asOf,
      status: rec.status,
      allocatedTotalMinor: rec.allocatedTotalMinor
    },
    classes: gate.available ? deviation.classes : null,
    execution: executionSummary(rec, decisionId, links, securityEvents, state.assets && state.assets.fxRates || [])
  };
  const shape = Domain.validateDecisionSnapshotShape(snapshot);
  if (!shape.ok) {
    decisionFail('invalid_decision_record', '生成的快照形状不合法：' + shape.error.detail);
  }
  return snapshot;
}

/* ------------------------------ 接受门禁（§2.2） ------------------------------ */

// 与 GET /api/v1/targets/current 同一口径的服务端当前视图（adviceStaleness 的输入形状）。
function buildTargetsView(db, state, today, overview) {
  const assessmentSel = Domain.selectCurrentAssessment(state.riskAssessments, today);
  if (!assessmentSel.ok) return { status: 'invalid_records' };
  if (assessmentSel.status !== 'current') return { status: assessmentSel.status };
  const tsel = Domain.selectCurrentTarget(state.allocationTargets, assessmentSel.current.record, today);
  if (!tsel.ok || tsel.status !== 'current') return { status: tsel.ok ? tsel.status : 'invalid_records' };
  const deviation = Domain.computeAllocationDeviation(tsel.current.target, overview);
  if (!deviation.ok) return { status: 'invalid_records' };
  const mapping = R.readApprovedMappingView(db);
  return {
    status: 'current',
    target: tsel.current.target,
    assessment: assessmentSel.current.record,
    allocation: deviation,
    mapping: { rows: mapping.rows }
  };
}

// 接受门禁：staleness（409 recommendation_stale）→ 门禁复放 + G5-R1 引用一致（400 invalid_recommendation_record）。
// 客户端角标不是授权依据：这里独立重算，页面没标 stale 也不放宽。
function acceptanceRecheck(db, rec, state, today, overview) {
  const view = buildTargetsView(db, state, today, overview);
  const assetsSig = Domain.factSignature(state.assets);
  const staleReasons = Domain.adviceStaleness({ status: rec.status, recommendation: rec }, view, assetsSig);
  if (staleReasons.length) {
    decisionFail('recommendation_stale', '建议已失效，不能接受（' + staleReasons.join('/') + '）；事实变化后请重新生成建议');
  }
  try {
    R.validateRecommendationRow(rec);
  } catch (err) {
    decisionFail('invalid_recommendation_record', '建议与封存输入或引用复核失败：' + (err && err.message));
  }
}

/* ------------------------------ 创建（POST /api/v1/decisions） ------------------------------ */

// 契约 §2.1 / §8.1：唯一对象是一条已存在的 formal 建议；一条建议最多一条决策（自然幂等）。
// intent 缺省 → 只创建 proposed（零事件、无快照）；intent=accepted/deferred/dismissed →
// 一步创建并追加首条事件（seq=1，封存决策时点快照）。
function createDecision(db, payload, ctx) {
  const today = ctx.today;
  const nowIso = ctx.nowIso;
  const checked = Domain.validateDecisionRequest(payload && typeof payload === 'object' ? payload : {});
  if (!checked.ok) {
    decisionFail(checked.error.code, '决策请求不合法：' + checked.error.detail);
  }
  const req = checked.value;

  const recEntry = R.getRecommendation(db, req.recommendationId);
  if (!recEntry) {
    decisionFail('unknown_recommendation', '决策引用的建议不存在：' + req.recommendationId);
  }
  const rec = recEntry.record;
  // 契约 §2.1 ②：记录必须先通过读取复核。这里采用与 GET /recommendations 完全同一份
  // 读取视图结果（形状 + 封存 payloadHash + capture 重放 + G5-R1 引用一致）——
  // 封存哈希被改坏的建议在列表里已计入 invalidCount，同样**不能**创建任何决策，
  // 包括 deferred / dismissed / proposed（不只是 accepted 的时效重核）。
  if (!R.readRecommendationView(db).items.some((item) => item.id === req.recommendationId)) {
    decisionFail('invalid_recommendation_record', '决策引用的建议未通过完整读取复核（封存哈希或引用链不一致）：' + req.recommendationId);
  }
  const recShape = Domain.validateRecommendationRecord(rec);
  if (!recShape.ok) {
    decisionFail('invalid_recommendation_record', '决策引用的建议复核失败：' + (recShape.error && recShape.error.detail));
  }
  if (rec.status !== 'formal') {
    decisionFail('recommendation_not_formal', '只有正式（formal）建议能创建决策；估算建议不进待执行清单、不可接受');
  }

  const existing = R.readDecisionRows(db).find((d) => d.recommendationId === req.recommendationId) || null;
  if (existing) {
    // 自然幂等：同一 recommendationId 再次创建 → created:false + 既有决策原样返回，
    // 不套用本次的 intent / note、不改状态、不追加事件（契约 §8.1）。
    return { created: false, decisionId: existing.id };
  }

  const state = R.readState(db);
  const overview = Domain.computeOverview(state.assets, { now: today, settings: state.settings || {} });
  const allLinks = R.readDecisionLinks(db);
  const securityEvents = R.readSecurityEvents(db);

  if (req.intent === 'accepted') {
    acceptanceRecheck(db, rec, state, today, overview);
  }
  if (req.intent !== null && !req.note) {
    decisionFail('invalid_decision_payload', '接受 / 暂缓 / 忽略必须填写理由 note');
  }

  const decisionId = decisionRecordId(req.recommendationId);

  if (req.intent === null) {
    // 两步式：只建 proposed，零事件、无快照（§1.3）；后续用事件端点逐条走 L1～L3。
    const decision = {
      id: decisionId,
      recommendationId: req.recommendationId,
      state: 'proposed',
      lastSeq: 0,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    R.insertDecisionRow(db, decision);
    return {
      created: true,
      decision: decision,
      events: [],
      links: allLinks.filter((l) => l.decisionId === decisionId),
      execution: executionSummary(rec, decisionId, allLinks, securityEvents, state.assets && state.assets.fxRates || [])
    };
  }

  const reasonCode = req.intent === 'accepted' ? 'agree'
    : req.intent === 'deferred' ? 'postpone' : 'dismiss_not_actionable';
  const snapshot = buildSnapshot(db, rec, state, overview, today, nowIso, decisionId, allLinks, securityEvents);
  const decision = {
    id: decisionId,
    recommendationId: req.recommendationId,
    state: req.intent,
    lastSeq: 1,
    createdAt: nowIso,
    updatedAt: nowIso
  };
  const event = {
    id: decisionEventId(decisionId, 1),
    decisionId: decisionId,
    seq: 1,
    fromState: 'proposed',
    toState: req.intent,
    reasonCode: reasonCode,
    note: req.note,
    occurredAt: today,
    recordedAt: nowIso,
    actor: Domain.DECISION_ACTOR,
    snapshot: snapshot,
    snapshotHash: R.decisionSnapshotHash(snapshot),
    payloadHash: null
  };
  event.payloadHash = R.decisionEventPayloadHash(event);
  R.insertDecisionRow(db, decision);
  R.insertDecisionEventRow(db, event);
  return {
    created: true,
    decision: decision,
    events: [event],
    links: allLinks.filter((l) => l.decisionId === decisionId),
    execution: snapshot.execution
  };
}

/* ------------------------------ 事件（POST /api/v1/decisions/{id}/events） ------------------------------ */

// 契约 §1.2 / §8.2：服务端据当前状态执行命令；非法跳转 / 守卫失败一律 409/400 且整体回滚
//（调用方把本函数放进与事件插入同一事务）。理由码按 §6.3 由服务端派生。
function appendDecisionEvent(db, decisionId, payload, ctx) {
  const today = ctx.today;
  const nowIso = ctx.nowIso;
  const checked = Domain.validateDecisionEventRequest(payload && typeof payload === 'object' ? payload : {});
  if (!checked.ok) {
    decisionFail(checked.error.code, '决策事件请求不合法：' + checked.error.detail);
  }
  const req = checked.value;
  const decision = R.getDecisionRow(db, decisionId);
  if (!decision) {
    decisionFail('unknown_decision', '决策不存在：' + decisionId);
  }
  const events = R.getDecisionEvents(db, decisionId);
  const chain = Domain.validateDecisionEventChain(decision, events);
  if (!chain.ok) {
    decisionFail('invalid_decision_record', '决策事件链复核失败：' + chain.error.detail);
  }
  if (!Domain.isLegalDecisionTransition(decision.state, req.toState)) {
    decisionFail('illegal_transition', '状态跳转 ' + decision.state + ' → ' + req.toState + ' 不在合法转移表内');
  }

  const recEntry = R.getRecommendation(db, decision.recommendationId);
  if (!recEntry) {
    decisionFail('invalid_decision_record', '决策引用的建议不存在：' + decision.recommendationId);
  }
  const rec = recEntry.record;
  const state = R.readState(db);
  const overview = Domain.computeOverview(state.assets, { now: today, settings: state.settings || {} });
  const allLinks = R.readDecisionLinks(db);
  const links = allLinks.filter((l) => l.decisionId === decisionId);
  const securityEvents = R.readSecurityEvents(db);
  const execution = executionSummary(rec, decisionId, allLinks, securityEvents, state.assets && state.assets.fxRates || []);

  let reasonCode = null;
  if (req.toState === 'accepted' || req.toState === 'deferred' || req.toState === 'dismissed') {
    // 两步式路径（proposed → accepted）与一步创建同口径：接受必须过门禁（§2.2）。
    if (req.toState === 'accepted') {
      acceptanceRecheck(db, rec, state, today, overview);
    }
    if (!req.note) {
      decisionFail('invalid_decision_payload', '接受 / 暂缓 / 忽略必须填写理由 note');
    }
    reasonCode = req.toState === 'accepted' ? 'agree'
      : req.toState === 'deferred' ? 'postpone' : 'dismiss_not_actionable';
  } else if (req.toState === 'executed') {
    // 契约 §3.3：活动关联 ≥1；偏差（金额差额 ≠ 0 或汇率缺失导致汇总为 null）必须 note；
    // 状态永远由显式命令推进，绝不按「金额相等」自动判 executed。
    if (execution.linkedCount < 1) {
      decisionFail('no_linked_events', 'accepted → executed 要求至少一条活动关联（先关联实际买入）');
    }
    const hasDeviation = execution.linkedPrincipalCnyMinor === null ||
      execution.linkedPrincipalCnyMinor !== rec.allocatedTotalMinor;
    if (hasDeviation && !req.note) {
      decisionFail('deviation_note_required', '执行存在偏差（金额差额或汇率缺失），必须填写偏差说明 note');
    }
    reasonCode = hasDeviation ? 'executed_deviation' : 'executed_as_planned';
  } else if (req.toState === 'archived') {
    // 契约 §3.5：无交易的关闭路径唯一；归档要求活动关联 = 0。
    if (execution.linkedCount > 0) {
      decisionFail('has_linked_events', '归档前必须先解绑全部活动关联');
    }
    if (!req.note) {
      decisionFail('invalid_decision_payload', '归档必须填写理由 note');
    }
    reasonCode = Domain.deriveArchiveReason(rec.allocatedTotalMinor, links.length > 0);
  } else if (req.toState === 'reviewed') {
    if (!req.note) {
      decisionFail('invalid_decision_payload', '复盘必须填写理由 note');
    }
  }

  const seq = decision.lastSeq + 1;
  const snapshot = buildSnapshot(db, rec, state, overview, today, nowIso, decisionId, allLinks, securityEvents);
  if (req.toState === 'reviewed') {
    // 契约 §6.3：reviewed_with_drift / reviewed_no_drift 由服务端对比执行时点快照得出。
    const executedEvent = chain.events.find((e) => e.toState === 'executed');
    if (!executedEvent) {
      decisionFail('invalid_decision_record', '找不到执行时点快照，无法判定复盘漂移');
    }
    const drift = Domain.decisionReviewDrift(executedEvent.snapshot, snapshot);
    if (!drift.ok) {
      decisionFail('invalid_decision_record', '复盘漂移判定失败：' + drift.error.detail);
    }
    reasonCode = drift.drift ? 'reviewed_with_drift' : 'reviewed_no_drift';
  }

  const newEvent = {
    id: decisionEventId(decisionId, seq),
    decisionId: decisionId,
    seq: seq,
    fromState: decision.state,
    toState: req.toState,
    reasonCode: reasonCode,
    note: req.note,
    occurredAt: today,
    recordedAt: nowIso,
    actor: Domain.DECISION_ACTOR,
    snapshot: snapshot,
    snapshotHash: R.decisionSnapshotHash(snapshot),
    payloadHash: null
  };
  newEvent.payloadHash = R.decisionEventPayloadHash(newEvent);
  const updated = Object.assign({}, decision, { state: req.toState, lastSeq: seq, updatedAt: nowIso });
  R.updateDecisionForRow(db, updated);
  R.insertDecisionEventRow(db, newEvent);
  return {
    decision: updated,
    events: chain.events.concat([newEvent]),
    links: links,
    execution: execution
  };
}

/* ------------------------------ 只读视图（GET /api/v1/decisions[/id]） ------------------------------ */

function recommendationSummary(rec, view, assetsSig) {
  return {
    id: rec.id,
    status: rec.status,
    asOf: rec.asOf,
    allocatedTotalMinor: rec.allocatedTotalMinor,
    inputHash: rec.inputHash,
    explanationVersion: rec.gate && rec.gate.explanationVersion != null ? rec.gate.explanationVersion : null,
    // 只做展示（D-054）：失效原因不改变决策状态，也不作为授权依据。
    adviceStaleReasons: Domain.adviceStaleness({ status: rec.status, recommendation: rec }, view, assetsSig)
  };
}

function decisionMonths(events) {
  const months = [];
  events.forEach((e) => {
    const ym = String(e.occurredAt).slice(0, 7);
    if (months.indexOf(ym) === -1) months.push(ym);
  });
  return months.sort();
}

function decisionListItem(db, entry, recMap, view, assetsSig, securityEvents, fxRates) {
  const d = entry.decision;
  const lastEvent = entry.events.length ? entry.events[entry.events.length - 1] : null;
  const rec = recMap.get(d.recommendationId);
  return {
    id: d.id,
    recommendationId: d.recommendationId,
    recommendationStatus: rec ? rec.status : null,
    state: d.state,
    reasonCode: lastEvent ? lastEvent.reasonCode : null,
    note: lastEvent ? lastEvent.note : null,
    lastEventAt: lastEvent ? lastEvent.occurredAt : null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    eventMonths: decisionMonths(entry.events),
    allocatedTotalMinor: rec ? rec.allocatedTotalMinor : null,
    execution: executionSummary(rec, d.id, entry.links, securityEvents, fxRates),
    recommendation: rec ? recommendationSummary(rec, view, assetsSig) : null
  };
}

// 契约 §8.3：列表 = 有效决策（复核失败行计入 invalidCount，不冒充可用），过滤参数互为与关系，
// 排序 updatedAt 降序 → id 升序（与数据库行序无关）。
function decisionListResponse(db, query, ctx) {
  const state = R.readState(db, { decisionView: true });
  const today = ctx.today;
  const overview = Domain.computeOverview(state.assets, { now: today, settings: state.settings || {} });
  const view = buildTargetsView(db, state, today, overview);
  const assetsSig = Domain.factSignature(state.assets);
  const recMap = new Map(R.readRecommendationView(db).items.map((r) => [r.id, r]));
  const securityEvents = R.readSecurityEvents(db);
  const fxRates = state.assets && state.assets.fxRates || [];

  const all = R.readValidatedDecisions(db);

  // 聚合（states / months）覆盖全部有效决策，供筛选界面使用；过滤在条目装配前完成。
  const states = [];
  const months = [];
  all.items.forEach((entry) => {
    const state = entry.decision.state;
    if (states.indexOf(state) === -1) states.push(state);
    entry.events.forEach((e) => {
      const ym = String(e.occurredAt).slice(0, 7);
      if (months.indexOf(ym) === -1) months.push(ym);
    });
  });
  states.sort();
  months.sort();

  let entries = all.items;
  if (query.state != null) {
    if (Domain.DECISION_STATES.indexOf(query.state) === -1) {
      decisionFail('invalid_decision_payload', 'state 查询参数不在状态词表内');
    }
    entries = entries.filter((entry) => entry.decision.state === query.state);
  }
  if (query.month != null) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)) {
      decisionFail('invalid_decision_payload', 'month 查询参数必须是 YYYY-MM');
    }
    entries = entries.filter((entry) =>
      entry.events.some((e) => String(e.occurredAt).slice(0, 7) === query.month));
  }
  if (query.recommendationId != null) {
    entries = entries.filter((entry) => entry.decision.recommendationId === query.recommendationId);
  }
  // 契约 §8.3：from / to 按**每条事件的 occurred_at** 判区间——只要任一状态事件落在
  // 区间内即命中（不能只看月初或最后一次事件，否则中间事件会被漏掉）。
  if (query.from != null || query.to != null) {
    if (query.from != null && !Domain.isCalendarDate(query.from)) {
      decisionFail('invalid_decision_payload', 'from 查询参数必须是真实日历日');
    }
    if (query.to != null && !Domain.isCalendarDate(query.to)) {
      decisionFail('invalid_decision_payload', 'to 查询参数必须是真实日历日');
    }
    entries = entries.filter((entry) => entry.events.some((e) =>
      (query.from == null || e.occurredAt >= query.from) &&
      (query.to == null || e.occurredAt <= query.to)));
  }
  const items = entries.map((entry) =>
    decisionListItem(db, entry, recMap, view, assetsSig, securityEvents, fxRates));
  items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id));

  return {
    ok: true,
    items: items,
    total: all.total,
    invalidCount: all.invalidCount,
    states: states,
    months: months
  };
}

// 契约 §8.4：详情 = 决策 + 完整事件时间线 + 关联行（内嵌交易事实）+ 建议摘要 + 三时点快照
// + 执行汇总 + 合并时间线。任一复核失败 → invalid_decision_record（fail closed，不返回修好的数据）。
function decisionDetailResponse(db, decisionId, ctx) {
  const decision = R.getDecisionRow(db, decisionId);
  if (!decision) {
    decisionFail('unknown_decision', '决策不存在：' + decisionId);
  }
  const events = R.getDecisionEvents(db, decisionId);
  const links = R.readDecisionLinks(db).filter((l) => l.decisionId === decisionId);
  const validRecommendationIds = new Set(R.readRecommendationView(db).items.map((r) => r.id));
  const securityEventsForCheck = R.readSecurityEvents(db);
  const securityEventsByIdForCheck = new Map(securityEventsForCheck.map((e) => [e.id, e]));
  const checked = R.validateDecisionWithIntegrity(db, decision, events, links, validRecommendationIds, securityEventsByIdForCheck);
  if (!checked.ok) {
    decisionFail('invalid_decision_record', '决策复核失败：' + checked.error.detail);
  }

  const state = R.readState(db, { decisionView: true });
  const today = ctx.today;
  const overview = Domain.computeOverview(state.assets, { now: today, settings: state.settings || {} });
  const view = buildTargetsView(db, state, today, overview);
  const assetsSig = Domain.factSignature(state.assets);
  const recEntry = R.getRecommendation(db, decision.recommendationId);
  if (!recEntry) {
    decisionFail('invalid_decision_record', '决策引用的建议不存在：' + decision.recommendationId);
  }
  const rec = recEntry.record;
  const securityEvents = R.readSecurityEvents(db);
  const eventsById = new Map(securityEvents.map((e) => [e.id, e]));
  const fxRates = state.assets && state.assets.fxRates || [];
  const execution = executionSummary(rec, decision.id, links, securityEvents, fxRates);

  const snapshotAt = (toState) => {
    const ev = checked.events.find((e) => e.toState === toState);
    return ev ? ev.snapshot : null;
  };
  const decisionPoint = checked.events.find((e) => e.fromState === 'proposed');

  const linkRows = links.map((l) => {
    const ev = eventsById.get(l.securityEventId) || null;
    return {
      id: l.id,
      securityEventId: l.securityEventId,
      event: ev ? {
        eventType: ev.eventType,
        occurredAt: ev.occurredAt,
        quantity: ev.quantity,
        priceMinor: ev.priceMinor,
        feeMinor: ev.feeMinor,
        currency: ev.currency,
        instrumentId: ev.instrumentId,
        accountId: ev.accountId
      } : null,
      linkedOn: l.linkedOn,
      unlinkedOn: l.unlinkedOn,
      note: l.note,
      unlinkNote: l.unlinkNote
    };
  });

  const timeline = checked.events.map((e) => ({
    at: e.occurredAt,
    kind: 'state',
    seq: e.seq,
    fromState: e.fromState,
    toState: e.toState,
    reasonCode: e.reasonCode,
    note: e.note
  }));
  links.forEach((l) => {
    timeline.push({
      at: l.linkedOn,
      kind: 'link',
      action: 'link',
      linkId: l.id,
      securityEventId: l.securityEventId,
      note: l.note
    });
    if (l.unlinkedOn != null) {
      timeline.push({
        at: l.unlinkedOn,
        kind: 'link',
        action: 'unlink',
        linkId: l.id,
        securityEventId: l.securityEventId,
        note: l.unlinkNote
      });
    }
  });
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  return {
    ok: true,
    decision: Object.assign({}, decision, { eventMonths: decisionMonths(checked.events) }),
    events: checked.events,
    links: linkRows,
    recommendation: recommendationSummary(rec, view, assetsSig),
    snapshots: {
      decision: decisionPoint ? decisionPoint.snapshot : null,
      executed: snapshotAt('executed'),
      reviewed: snapshotAt('reviewed'),
      archived: snapshotAt('archived')
    },
    execution: execution,
    timeline: timeline
  };
}

module.exports = {
  decisionRecordId,
  decisionEventId,
  decisionLinkRecordId,
  executionSummary,
  buildSnapshot,
  buildTargetsView,
  acceptanceRecheck,
  createDecision,
  appendDecisionEvent,
  decisionListResponse,
  decisionDetailResponse
};
