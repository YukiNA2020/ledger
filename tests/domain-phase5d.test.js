/* Phase 5D｜新增资金优先再平衡与正式建议门禁｜领域层测试（DECISIONS D-046 / D-048 / D-049）
 *
 * 覆盖 PHASE5_BREAKDOWN §7.5 的领域层退出条件：
 *   - S5.2（宽基权益低配 + CNY 2,000）在领域层成立：优先补低配类别、金额守恒、无卖出、只引用认可标的；
 *   - 可分配金额 = min(用户输入, 可新增投资资金)，超上限显式标记而不是静默当作可用；
 *   - 只补低配：高配类别 0 新增 + 风险提示，任何路径都不出现负金额或卖出指令；
 *   - 无需调整时明确「在容忍带内」，不为凑建议强行分配；
 *   - 0 元 / 1 分 / 资金不足覆盖全部缺口 / 巨额新增资金 / 无认可标的都有确定结果；
 *   - 结果只消费 5C 的同一遍估值与映射（伪造偏离或换目标一律 fail closed）；
 *   - 正式建议门禁只有一套：任一条件不过 → estimate，且 formalRecommendation 为空；
 *   - 范围边界：不做 Phase 6 的接受 / 暂缓 / 执行 / 复盘，不新增数据源、不读时钟。
 * 本文件只测纯领域层；HTTP / 仓储 / 备份 / wiring 见 tests/server-phase5d.test.js 与 tests/app-wiring.js。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Domain = require('../js/domain.js');
const FIXTURE = require('./fixtures/phase5-risk-rules.json');

const TODAY = '2026-09-30';
const ASSESSED = '2026-01-10';
const CREATED = '2026-01-10T08:00:00.000Z';
const CLASSES = Domain.RISK_CLASSES;
const CONTRACT_5D = Domain.recommendation5DContract();
const BPS = Domain.BPS_TOTAL;

const CAP_QS = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'capacity');
const WIL_QS = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'willingness');

function optionByScore(q, score) {
  const hit = q.options.filter((o) => o.score === score)[0];
  if (!hit) throw new Error('题库缺少分值为 ' + score + ' 的选项：' + q.id);
  return hit.id;
}

// 逐题指定分值，派生值全部走 5A/5B 的同一份实现（与 5C 测试同一套构造口径）
function assessment(id, capScores, wilScores) {
  const answers = [];
  capScores.forEach((s, i) => answers.push({ questionId: CAP_QS[i].id, optionId: optionByScore(CAP_QS[i], s) }));
  wilScores.forEach((s, i) => answers.push({ questionId: WIL_QS[i].id, optionId: optionByScore(WIL_QS[i], s) }));
  const computed = Domain.computeRiskAssessment({ answers, assessedAt: ASSESSED, reason: 'initial' }, { today: TODAY });
  assert.ok(computed.ok, '前置：评估载荷必须合法：' + JSON.stringify(computed.error));
  return Object.assign({ id: id || 'ra-1', createdAt: CREATED }, computed.record);
}

// 与 tests/domain-phase5c.test.js 的 LEVEL_CASES 同一份构造（L3 用于 S5.2）
const L3 = assessment('ra-l3', [2, 2, 1, 1, 1], [2, 2, 1, 1]);   // 能力 7 / 意愿 6 → 上限 L3
const L5 = assessment('ra-l5', [3, 3, 3, 3, 3], [3, 3, 3, 3]);   // 满分 → 上限 L5

function targetOf(rec, options) {
  const out = Domain.computeAllocationTarget(rec, Object.assign({ today: TODAY }, options || {}));
  assert.ok(out.ok, '前置：目标映射必须成功：' + JSON.stringify(out.error));
  return Object.assign({ id: 'at-' + rec.ceiling, createdAt: '2026-09-30T09:00:00.000Z' }, out.target);
}

const T3 = targetOf(L3);
const T5 = targetOf(L5);

/* 与 computeOverview 同形状的估值（类别合计与投资池同源）；5D-15 单独核对真实总览的一致性 */
function overviewWith(values, extra) {
  const total = CLASSES.reduce((s, k) => s + values[k], 0);
  return Object.assign({
    asOf: TODAY, valuationStatus: 'formal', canAdvise: true,
    pools: { safetyMinor: 0, investableMinor: total, restrictedMinor: 0 },
    blockers: [],
    riskClasses: CLASSES.map((k) => ({ assetClass: k, valueMinor: values[k] }))
  }, extra || {});
}

function deviationOf(target, values, extra) {
  const out = Domain.computeAllocationDeviation(target, overviewWith(values, extra));
  assert.ok(out.ok, '前置：偏离计算必须成功：' + JSON.stringify(out.error));
  return out;
}

function allocOf(target, dev, requested, available) {
  const out = Domain.computeNewFundsAllocation({
    target, deviation: dev,
    requestedNewFundsMinor: requested,
    newFundsAvailableMinor: available === undefined ? requested : available
  });
  return out;
}

function mustAlloc(target, dev, requested, available) {
  const out = allocOf(target, dev, requested, available);
  assert.ok(out.ok, '前置：分配必须成功：' + JSON.stringify(out.error));
  return out.allocation;
}

function rowOf(allocation, cls) {
  const hit = allocation.classes.filter((c) => c.assetClass === cls)[0];
  assert.ok(hit, '分配结果必须包含类别 ' + cls);
  return hit;
}

/* 认可标的：走 5C 的真实读取路径（checkApprovedMapping 决定 ok / invalid 与顺序） */
function mappingOf(spec) {
  const records = [], instruments = [];
  Object.keys(spec).forEach((cls) => {
    spec[cls].forEach((item, idx) => {
      const id = typeof item === 'string' ? item : item.id;
      records.push({
        id: 'aim-' + cls + '-' + id, assetClass: cls, instrumentId: id, position: idx,
        createdAt: CREATED, updatedAt: CREATED
      });
      const base = { id, symbol: id.toUpperCase(), name: '标的 ' + id, assetClass: cls, classificationStatus: 'confirmed' };
      instruments.push(Object.assign(base, typeof item === 'object' ? item.meta || {} : {}));
    });
  });
  return Domain.checkApprovedMapping(records, instruments);
}

function gateChecks(failures) {
  const bad = failures || [];
  return CONTRACT_5D.gateChecks.map((code) => ({ code, passed: bad.indexOf(code) === -1, detail: '' }));
}

function versionsOf(target, extra) {
  return Object.assign({
    ruleVersion: Domain.RISK_RULE_VERSION,
    targetVersion: Domain.RISK_TARGET_VERSION,
    targetLevel: target.level,
    assessmentId: 'ra-l3',
    targetId: target.id,
    closeId: 'close-1',
    snapshotId: 'snap-1',
    snapshotPayloadHash: 'a'.repeat(64),
    dataCutoff: TODAY,
    asOf: TODAY
  }, extra || {});
}

/* ------------------------- 1. S5.2：新增资金优先补低配类别 ------------------------- */

test('5D-1 S5.2：宽基权益低配 + CNY 2,000 → 全额优先补宽基、金额守恒、无卖出、只引用认可标的', () => {
  const sample = FIXTURE.samples.S5_2;
  assert.strictEqual(sample.verifiesIn, '5D');
  assert.strictEqual(sample.riskCeiling, T3.level, '前置：本用例走 L3 冻结模板');
  // fixture 给的是 bps；池子取 1 亿元（1e8 分）使每类金额与 bps 精确对应
  const values = {};
  CLASSES.forEach((k) => { values[k] = sample.currentAllocationBps[k] * 10000; });
  const dev = deviationOf(T3, values);
  assert.strictEqual(dev.canAdvise, true);
  const al = mustAlloc(T3, dev, sample.newFundsMinor, 20000000);

  assert.strictEqual(al.adjustment, 'fill_below_min');
  assert.strictEqual(al.requestedNewFundsMinor, 200000);
  assert.strictEqual(al.allocatableNewFundsMinor, 200000);
  assert.strictEqual(al.cappedToAvailable, false);
  assert.strictEqual(al.allocatedTotalMinor, sample.expect.allocatedTotalMinor, '实际分配金额必须守恒于 fixture 期望');
  assert.strictEqual(al.unallocatedMinor, 0);
  assert.strictEqual(al.classes.reduce((s, c) => s + c.allocatedMinor, 0), al.allocatedTotalMinor, 'Σ类别 == 实际分配金额');
  // 只有低配的宽基权益承接；高配的现金与已在目标之上的类别全部 0
  CLASSES.forEach((k) => {
    const row = rowOf(al, k);
    assert.ok(row.allocatedMinor >= 0, k + ' 绝不得为负金额');
    if (k === sample.expect.primaryCategory) assert.ok(row.allocatedMinor > 0, '主类别必须拿到资金');
    else assert.strictEqual(row.allocatedMinor, 0, k + ' 本轮不得分到资金（basis=' + row.basis + '）');
  });
  assert.strictEqual(rowOf(al, 'cash').basis, 'above_max');
  assert.ok(al.explainCodes.indexOf('new_funds_above_max_no_sell') >= 0, '高配类别必须给出「不卖出」提示码');
  assert.deepStrictEqual(al.sellOrders || [], sample.expect.sellOrders, '输出结构里没有卖出指令');
  assert.strictEqual(rowOf(al, 'broad_equity').goalBps, T3.classes.broad_equity.minBps, '资金不足补到下限时应说明锚点是 min');

  // 落到具体证券：只使用用户认可的两只宽基，顺序在前
  const mapping = mappingOf({ broad_equity: ['ins-b1', 'ins-b2'] });
  const mp = Domain.mapAllocationToApprovedInstruments(al, mapping);
  assert.ok(mp.ok, JSON.stringify(mp.error));
  const beRow = mp.classes.filter((c) => c.assetClass === 'broad_equity')[0];
  assert.deepStrictEqual(beRow.instruments.map((x) => x.instrumentId), ['ins-b1', 'ins-b2']);
  assert.strictEqual(beRow.instruments.reduce((s, x) => s + x.allocatedMinor, 0), 200000);
  assert.strictEqual(mp.mappedTotalMinor, 200000);
  assert.strictEqual(mp.unmappedTotalMinor, 0);
  assert.deepStrictEqual(mp.todos, []);
});

/* ------------------------- 2. 可分配金额：取较小值且显式提示 ------------------------- */

test('5D-2 输入超过可新增投资资金 → 取上限并显式标记，不静默当作可用', () => {
  const values = { cash: 10000000, fixed_income: 30000000, broad_equity: 20000000, theme_equity: 20000000, stock: 10000000, other: 10000000 };
  const dev = deviationOf(T3, values);
  const al = mustAlloc(T3, dev, 5000000, 1200000);
  assert.strictEqual(al.allocatableNewFundsMinor, 1200000, '可分配金额取两者较小值');
  assert.strictEqual(al.cappedToAvailable, true);
  assert.ok(al.explainCodes.indexOf('new_funds_capped_by_available') >= 0, '必须有「按上限截断」的解释码');
  assert.ok(al.allocatedTotalMinor <= 1200000);
  assert.strictEqual(al.allocatableNewFundsMinor, al.allocatedTotalMinor + al.unallocatedMinor, '截断后仍然守恒');
});

test('5D-3 新增资金输入必须是非负安全整数：负数、小数、超限与形状问题一律 fail closed', () => {
  const values = { cash: 20000000, fixed_income: 20000000, broad_equity: 20000000, theme_equity: 20000000, stock: 10000000, other: 10000000 };
  const dev = deviationOf(T3, values);
  [[-1, '负数'], [1.5, '小数'], [Number.MAX_SAFE_INTEGER + 10, '超出安全整数'], ['2000', '字符串'], [null, 'null'], [NaN, 'NaN']]
    .forEach(([value, label]) => {
      const out = allocOf(T3, dev, value, 1000000);
      assert.strictEqual(out.ok, false, label + ' 不得被接受');
      assert.strictEqual(out.error.code, 'invalid_new_funds');
    });
  // 可新增投资资金同样收口
  assert.strictEqual(allocOf(T3, dev, 1000, -5).error.code, 'invalid_new_funds');
  // 载荷键集合精确：多余字段与缺字段都不消费
  assert.strictEqual(Domain.computeNewFundsAllocation({
    target: T3, deviation: dev, requestedNewFundsMinor: 100, newFundsAvailableMinor: 100, canAdvise: true
  }).error.code, 'invalid_new_funds_request');
  assert.strictEqual(Domain.computeNewFundsAllocation({
    target: T3, deviation: dev, requestedNewFundsMinor: 100
  }).error.code, 'invalid_new_funds_request');
  const proto = Object.create({ newFundsAvailableMinor: 999999 });
  proto.target = T3; proto.deviation = dev; proto.requestedNewFundsMinor = 100;
  assert.strictEqual(Domain.computeNewFundsAllocation(proto).error.code, 'invalid_new_funds_request', '原型链注入不得被消费');
});

/* ------------------------- 3. 边界金额：0 元 / 1 分 / 巨额 ------------------------- */

test('5D-4 0 元新增资金：结果明确、全类别 0、不出现负数', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const al = mustAlloc(T3, deviationOf(T3, values), 0, 0);
  assert.strictEqual(al.adjustment, 'zero_allocatable');
  assert.strictEqual(al.allocatedTotalMinor, 0);
  assert.strictEqual(al.unallocatedMinor, 0);
  al.classes.forEach((c) => assert.strictEqual(c.allocatedMinor, 0));
  assert.ok(al.explainCodes.indexOf('new_funds_zero_amount') >= 0);
});

test('5D-5 1 分（最小货币单位）：结果仍是整数金额且尾差有说明', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const al = mustAlloc(T3, deviationOf(T3, values), 1, 1);
  assert.strictEqual(al.allocatedTotalMinor, 1);
  assert.strictEqual(al.unallocatedMinor, 0);
  const got = al.classes.filter((c) => c.allocatedMinor > 0);
  assert.strictEqual(got.length, 1, '1 分只能落在一个类别');
  assert.strictEqual(got[0].assetClass, 'broad_equity');
  al.classes.forEach((c) => assert.ok(Number.isSafeInteger(c.allocatedMinor)));
});

test('5D-6 多个类别同时低配：缺口降序、同缺口按类别序、整数尾差确定', () => {
  // D-049 池内现金转配：100 万元池中，固收/宽基各缺 15 万元，主题缺 5 万元。
  const values = {cash:80000000, fixed_income:5000000, broad_equity:15000000, theme_equity:0, stock:0, other:0};
  const al = mustAlloc(T3, deviationOf(T3, values), 8, 8);
  assert.strictEqual(al.plannedTotalMinor, 100000000);
  assert.strictEqual(al.adjustment, 'fill_below_min');
  assert.deepStrictEqual(al.belowMinClasses, ['fixed_income','broad_equity','theme_equity']);
  // 8 分 × 15/35、15/35、5/35 → 3、3、1，剩余 1 分给同缺口顺序靠前的固收。
  assert.strictEqual(rowOf(al, 'cash').allocatedMinor, 0);
  assert.strictEqual(rowOf(al, 'fixed_income').allocatedMinor, 4);
  assert.strictEqual(rowOf(al, 'broad_equity').allocatedMinor, 3);
  assert.strictEqual(rowOf(al, 'theme_equity').allocatedMinor, 1);
  assert.strictEqual(al.allocatedTotalMinor, 8);
  assert.strictEqual(al.rounding.leftoverMinor, 1);
  assert.deepStrictEqual(al.rounding.receivers, ['fixed_income']);
});

test('5D-7 高配类别得到 0 与风险提示，任何情况下不返回负金额或卖出指令', () => {
  const values = { cash: 40000000, fixed_income: 25000000, broad_equity: 25000000, theme_equity: 5000000, stock: 5000000, other: 0 };
  const al = mustAlloc(T3, deviationOf(T3, values), 5000000, 5000000);
  assert.strictEqual(rowOf(al, 'cash').basis, 'above_max');
  assert.strictEqual(rowOf(al, 'cash').allocatedMinor, 0);
  al.classes.forEach((c) => {
    assert.ok(c.allocatedMinor >= 0, c.assetClass + ' 不得为负');
    assert.ok(Number.isSafeInteger(c.allocatedMinor));
  });
  const json = JSON.stringify(al);
  assert.ok(json.indexOf('"-') === -1, '序列化结果里不得出现任何负数字段：' + json);
  assert.ok(al.explainCodes.indexOf('new_funds_above_max_no_sell') >= 0);
});

test('5D-8 所有类别都在容忍带内 → 明确「在容忍带内」，不强造分配（端点含入）', () => {
  // 恰好用 L3 各区间端点：cash 3500=max、fixed_income 2000=min、broad_equity 3000、theme_equity 500=min、stock 0、other 0
  const values = { cash: 35000000, fixed_income: 20000000, broad_equity: 30000000, theme_equity: 5000000, stock: 10000000, other: 0 };
  const dev = deviationOf(T3, values);
  dev.classes.forEach((c) => assert.strictEqual(c.band, 'within', c.assetClass + ' 端点值必须含入区间'));
  const al = mustAlloc(T3, dev, 3000000, 3000000);
  assert.strictEqual(al.adjustment, 'within_tolerance');
  assert.strictEqual(al.allocatedTotalMinor, 0, '不需要调整时一分钱都不分配');
  assert.strictEqual(al.unallocatedMinor, 3000000);
  assert.ok(al.explainCodes.indexOf('new_funds_within_tolerance') >= 0);
  assert.ok(al.explainCodes.indexOf('new_funds_below_min_first') === -1);
});

test('5D-9 存在高配但无低配：向 targetPbs 收敛，高配仍为 0 且不卖出', () => {
  // cash 高于 max，其余都在区间内但有类别低于自己的 target（Σtarget 恒为 100% 的必然结果）
  const values = { cash: 38000000, fixed_income: 22000000, broad_equity: 31000000, theme_equity: 6000000, stock: 1000000, other: 2000000 };
  const dev = deviationOf(T3, values);
  assert.strictEqual(rowOf(dev, 'cash').band, 'above_max');
  const al = mustAlloc(T3, dev, 2000000, 2000000);
  assert.strictEqual(al.adjustment, 'converge_to_target');
  assert.strictEqual(rowOf(al, 'cash').allocatedMinor, 0);
  assert.ok(al.explainCodes.indexOf('new_funds_converge_to_target') >= 0);
  assert.strictEqual(al.allocatedTotalMinor, al.classes.reduce((s, c) => s + c.allocatedMinor, 0));
  al.classes.forEach((c) => assert.ok(c.allocatedMinor >= 0));
});

test('5D-10 缺口远大于新增资金：按比例分完且不出现部分类别得到超过缺口', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const al = mustAlloc(T3, deviationOf(T3, values), 100, 100);
  const be = rowOf(al, 'broad_equity');
  assert.strictEqual(al.allocatedTotalMinor, 100);
  assert.ok(be.allocatedMinor <= be.minNeedMinor, '单类别分配不得超过其缺口金额');
  assert.strictEqual(be.basis, 'below_min');
});

test('5D-11 缺口金额充足时按锚点补满，剩余金额显式留在未分配（不强造交易）', () => {
  // L5 模板里 theme_equity 的 min == target == 1500：补满后既不再收敛也不硬找去处
  const values = { cash: 10000000, fixed_income: 10000000, broad_equity: 65000000, theme_equity: 10000000, stock: 2500000, other: 2500000 };
  const dev = deviationOf(T5, values);
  assert.strictEqual(rowOf(dev, 'theme_equity').band, 'below_min');
  const al = mustAlloc(T5, dev, 12000000, 12000000);
  assert.ok(['fill_below_min', 'converge_to_target'].indexOf(al.adjustment) >= 0);
  assert.strictEqual(al.allocatableNewFundsMinor, al.allocatedTotalMinor + al.unallocatedMinor);
  al.classes.forEach((c) => {
    if (!c.allocatedMinor) return;
    assert.ok(c.allocatedMinor <= (c.targetNeedMinor || 0) || c.basis === 'below_min',
      c.assetClass + ' 单类别不得超过其锚点缺口');
  });
});

test('5D-12 巨额新增资金受可新增投资资金截断，结果仍是安全整数且守恒', () => {
  const values = { cash: 100000000, fixed_income: 100000000, broad_equity: 100000000, theme_equity: 100000000, stock: 0, other: 0 };
  const al = mustAlloc(T3, deviationOf(T3, values), 900000000000, 200000000);
  assert.strictEqual(al.allocatableNewFundsMinor, 200000000);
  assert.strictEqual(al.cappedToAvailable, true);
  assert.strictEqual(al.allocatedTotalMinor + al.unallocatedMinor, 200000000);
  al.classes.forEach((c) => assert.ok(Number.isSafeInteger(c.allocatedMinor) && c.allocatedMinor >= 0));
});

test('5D-13 安全整数上界不再叠加到池子；超安全整数金额仍 fail closed', () => {
  const values = { cash: 900000000000, fixed_income: 0, broad_equity: 0, theme_equity: 0, stock: 0, other: 0 };
  const dev = deviationOf(T3, values);
  const out = mustAlloc(T3, dev, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  assert.strictEqual(out.plannedTotalMinor, 900000000000);
  assert.ok(out.allocatedTotalMinor <= 765000000000, '不支出超过现金减现金下限的金额');
  assert.strictEqual(out.allocatedTotalMinor + out.unallocatedMinor, Number.MAX_SAFE_INTEGER);
  assert.strictEqual(allocOf(T3, dev, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER).error.code, 'invalid_new_funds');
});

/* ------------------------- 4. 标的映射与待办 ------------------------- */

test('5D-14 无可用认可标的：类别金额保留为待办，不转投陌生标的', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const al = mustAlloc(T3, deviationOf(T3, values), 200000, 200000);
  const empty = Domain.checkApprovedMapping([], []);
  const mp = Domain.mapAllocationToApprovedInstruments(al, empty);
  assert.ok(mp.ok);
  assert.strictEqual(mp.mappedTotalMinor, 0);
  assert.strictEqual(mp.unmappedTotalMinor, 200000, '没有可执行标的时金额原样保留');
  assert.deepStrictEqual(mp.todos, [{ code: 'missing_approved_instrument', assetClass: 'broad_equity', retainedMinor: 200000 }]);
  const built = Domain.buildRecommendationResult({
    status: 'estimate', blockers: [], dataCutoff: TODAY, versions: versionsOf(T3),
    deviation: deviationOf(T3, values), allocation: al, mapping: mp
  });
  assert.ok(built.ok, JSON.stringify(built.error));
  assert.ok(built.result.explainCodes.indexOf('new_funds_missing_approved_instrument') >= 0);
  assert.strictEqual(built.result.categoryAllocations.filter((c) => c.assetClass === 'broad_equity')[0].instruments.length, 0);
});

test('5D-15 映射行全部失效（标的被删 / 分类回到 suggested）时报修复引用的待办而不是静默改投', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const al = mustAlloc(T3, deviationOf(T3, values), 200000, 200000);
  const mapping = Domain.checkApprovedMapping([
    { id: 'aim-1', assetClass: 'broad_equity', instrumentId: 'ins-x', position: 0, createdAt: CREATED, updatedAt: CREATED }
  ], [
    { id: 'ins-x', symbol: 'X', name: '已回到待确认', assetClass: 'broad_equity', classificationStatus: 'suggested' }
  ]);
  assert.strictEqual(mapping.rows[0].status, 'invalid');
  const mp = Domain.mapAllocationToApprovedInstruments(al, mapping);
  assert.deepStrictEqual(mp.todos, [{ code: 'invalid_instrument_reference', assetClass: 'broad_equity', retainedMinor: 200000 }]);
  assert.strictEqual(mp.unmappedTotalMinor, 200000);
});

test('5D-16 同类多标的：等额分配、尾差按 position 升序补给最前者、标的之和等于类别金额', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const al = mustAlloc(T3, deviationOf(T3, values), 200000, 200000);
  const mapping = mappingOf({ broad_equity: ['ins-b1', 'ins-b2', 'ins-b3'] });
  const mp = Domain.mapAllocationToApprovedInstruments(al, mapping);
  const row = mp.classes.filter((c) => c.assetClass === 'broad_equity')[0];
  assert.strictEqual(row.allocatedMinor, 200000);
  // 200000 = 3 × 66666 + 2 → 两只各 +1 分，落在 position 最靠前的两只上
  assert.deepStrictEqual(row.instruments.map((x) => x.allocatedMinor), [66667, 66667, 66666]);
  assert.strictEqual(row.instruments.reduce((s, x) => s + x.allocatedMinor, 0), 200000);
  // 用户顺序即优先级：把清单顺序换过来，尾差落点随 position 升序一起移动
  const swapped = mappingOf({ broad_equity: ['ins-b3', 'ins-b2', 'ins-b1'] });
  const mp2 = Domain.mapAllocationToApprovedInstruments(al, swapped);
  assert.deepStrictEqual(
    mp2.classes.filter((c) => c.assetClass === 'broad_equity')[0].instruments.map((x) => [x.instrumentId, x.allocatedMinor]),
    [['ins-b3', 66667], ['ins-b2', 66667], ['ins-b1', 66666]]
  );
});

/* ------------------------- 5. 只消费同一遍估值，不接受第二套口径 ------------------------- */

test('5D-17 偏离必须是同一目标 + 同一遍估值：伪造比例、换目标、缺类别一律 fail closed', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const dev = deviationOf(T3, values);
  // 客户端自己算一遍「当前比例」并塞进偏离结果
  const forged = JSON.parse(JSON.stringify(dev));
  forged.classes[2].pctBps = 1;
  assert.strictEqual(allocOf(T3, forged, 200000, 200000).error.code, 'invalid_valuation_input');
  // 容忍带与比例不符
  const band = JSON.parse(JSON.stringify(dev));
  band.classes[2].band = 'within';
  assert.strictEqual(allocOf(T3, band, 200000, 200000).error.code, 'invalid_valuation_input');
  // 区间与目标版本不符
  const range = JSON.parse(JSON.stringify(dev));
  range.classes[0].minBps = 1;
  assert.strictEqual(allocOf(T3, range, 200000, 200000).error.code, 'invalid_valuation_input');
  // 传入的是另一个等级（L5）的目标所派生的偏离
  const dev5 = deviationOf(T5, values);
  assert.strictEqual(allocOf(T3, dev5, 200000, 200000).error.code, 'invalid_valuation_input');
  // 少给一个类别 / 顺序不对
  const short = JSON.parse(JSON.stringify(dev));
  short.classes = short.classes.slice(0, 5);
  assert.strictEqual(allocOf(T3, short, 200000, 200000).error.code, 'invalid_valuation_input');
  const shuffled = JSON.parse(JSON.stringify(dev));
  shuffled.classes = shuffled.classes.slice().reverse();
  assert.strictEqual(allocOf(T3, shuffled, 200000, 200000).error.code, 'invalid_valuation_input');
  // 真实总览与手工构造的偏离同源（同一份 computeOverview 实现）
  const assets = Domain.emptyAssets();
  assets.assetAccounts = [{ id: 'acc-1', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: 'I' }];
  assets.assetUnits = [{ id: 'u1', accountId: 'acc-1', currency: 'CNY', balanceMinor: 100000000, asOf: TODAY, sourceType: 'manual' }];
  const ov = Domain.computeOverview(assets, { now: TODAY, settings: {} });
  const realDev = Domain.computeAllocationDeviation(T3, ov);
  assert.strictEqual(realDev.ok, true);
  assert.strictEqual(realDev.classes.filter((c) => c.assetClass === 'cash')[0].pctBps, BPS, '全现金时现金占满 100%');
  const realAlloc = mustAlloc(T3, realDev, 100000, 100000);
  assert.strictEqual(realAlloc.adjustment, 'fill_below_min');
  assert.strictEqual(rowOf(realAlloc, 'cash').basis, 'above_max');
  assert.strictEqual(rowOf(realAlloc, 'cash').allocatedMinor, 0);
  // 全现金组合里固收 / 宽基 / 主题都低于各自下限：资金不足时按缺口降序比例分，宽基缺口最大拿得最多
  assert.strictEqual(realAlloc.allocatedTotalMinor, 100000, '同一遍估值的路径同样必须守恒');
  assert.ok(rowOf(realAlloc, 'broad_equity').allocatedMinor > rowOf(realAlloc, 'fixed_income').allocatedMinor);
  assert.ok(rowOf(realAlloc, 'fixed_income').allocatedMinor > rowOf(realAlloc, 'theme_equity').allocatedMinor);
});

test('5D-18 投资池为 0（no_investable）：不出分配，也不冒充「都在区间内」', () => {
  const zero = { cash: 0, fixed_income: 0, broad_equity: 0, theme_equity: 0, stock: 0, other: 0 };
  const dev = deviationOf(T3, zero);
  assert.strictEqual(dev.status, 'no_investable');
  const al = mustAlloc(T3, dev, 500000, 500000);
  assert.strictEqual(al.adjustment, 'no_investable');
  assert.strictEqual(al.allocatedTotalMinor, 0);
  assert.strictEqual(al.unallocatedMinor, 500000);
  al.classes.forEach((c) => {
    assert.strictEqual(c.pctBps, null);
    assert.strictEqual(c.basis, 'unknown_base');
    assert.strictEqual(c.minNeedMinor, null);
  });
  assert.ok(al.explainCodes.indexOf('new_funds_no_investable') >= 0);
});

/* ------------------------- 6. 正式建议门禁 ------------------------- */

test('5D-19 门禁折叠只有一套：七条齐备才 formal，任一不过都是 estimate', () => {
  assert.deepStrictEqual(CONTRACT_5D.gateChecks, [
    'snapshot_ref', 'close_formal', 'snapshot_hash', 'can_advise',
    'assessment_valid', 'target_matches_assessment', 'new_funds_within_available'
  ]);
  const all = Domain.recommendationStatusFromGate(gateChecks([]));
  assert.ok(all.ok);
  assert.strictEqual(all.status, 'formal');
  CONTRACT_5D.gateChecks.forEach((bad) => {
    const out = Domain.recommendationStatusFromGate(gateChecks([bad]));
    assert.strictEqual(out.status, 'estimate', bad + ' 不过时不得标记正式建议');
    assert.deepStrictEqual(out.failedChecks, [bad]);
  });
  // 条件缺失、重复与词表外一律拒绝（不允许「少检一条」蒙过去）
  assert.strictEqual(Domain.recommendationStatusFromGate(gateChecks([]).slice(1)).error.code, 'invalid_recommendation_record');
  assert.strictEqual(Domain.recommendationStatusFromGate(
    gateChecks([]).concat([{ code: 'can_advise', passed: true }])).error.code, 'invalid_recommendation_record');
  assert.strictEqual(Domain.recommendationStatusFromGate(
    gateChecks([]).map((c) => (c.code === 'can_advise' ? { code: 'looks_fine', passed: true } : c))).error.code, 'invalid_recommendation_record');
  // 给出顺序不影响结论（与调用方拼装顺序无关）
  const reversed = Domain.recommendationStatusFromGate(gateChecks(['snapshot_hash']).slice().reverse());
  assert.strictEqual(reversed.status, 'estimate');
  assert.strictEqual(reversed.checks.map((c) => c.code).join(','), CONTRACT_5D.gateChecks.join(','));
});

test('5D-20 S5.3：五类数据门槛都只给估算，正式建议为空', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const dev = deviationOf(T3, values);
  const al = mustAlloc(T3, dev, 200000, 200000);
  const mp = Domain.mapAllocationToApprovedInstruments(al, mappingOf({ broad_equity: ['ins-b1'] }));
  const caseGate = {
    quote_stale: 'can_advise',
    classification_unconfirmed: 'can_advise',
    close_incomplete: 'close_formal',
    baseline_hash_mismatch: 'snapshot_hash',
    assessment_expired: 'assessment_valid'
  };
  assert.deepStrictEqual(Object.keys(caseGate), FIXTURE.samples.S5_3.cases, 'fixture 的五个触发条件都要覆盖');
  Object.keys(caseGate).forEach((name) => {
    const gate = Domain.recommendationStatusFromGate(gateChecks([caseGate[name]]));
    const built = Domain.buildRecommendationResult({
      status: gate.status,
      blockers: [{ code: name, detail: '' }],
      dataCutoff: TODAY, versions: versionsOf(T3), deviation: dev, allocation: al, mapping: mp
    });
    assert.ok(built.ok, name + '：' + JSON.stringify(built.error));
    assert.strictEqual(built.result.status, FIXTURE.samples.S5_3.expect.status, name + ' 只能是估算');
    const formal = built.result.status === 'formal' ? built.result : null;
    assert.strictEqual(formal, null, name + ' 的正式建议必须为空');
    assert.strictEqual(built.result.blockers.filter((b) => b.code === name).length, 1);
  });
});

test('5D-21 输出契约与 5A 冻结一致，破坏守恒或让高配拿钱都 fail closed', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const dev = deviationOf(T3, values);
  const al = mustAlloc(T3, dev, 200000, 200000);
  const mp = Domain.mapAllocationToApprovedInstruments(al, mappingOf({ broad_equity: ['ins-b1'] }));
  const built = Domain.buildRecommendationResult({
    status: 'formal', blockers: [], dataCutoff: TODAY, versions: versionsOf(T3),
    deviation: dev, allocation: al, mapping: mp
  });
  assert.ok(built.ok, JSON.stringify(built.error));
  assert.deepStrictEqual(Object.keys(built.result), FIXTURE.recommendationContract.outputKeys,
    '输出键集合必须逐键等于 5A 的冻结契约');
  const ok = built.result;
  assert.strictEqual(Domain.validateRecommendationOutput(ok).ok, true, '自身必须可通过复核（纯函数不改调用方输入）');
  assert.deepStrictEqual(ok.categoryAllocations.map((c) => c.assetClass), CLASSES, '类别恒按冻结顺序输出');

  const tamperedSum = JSON.parse(JSON.stringify(ok));
  tamperedSum.categoryAllocations[2].allocatedMinor += 1;
  assert.strictEqual(Domain.validateRecommendationOutput(tamperedSum).error.code, 'invalid_recommendation_output');

  const sellLike = JSON.parse(JSON.stringify(ok));
  sellLike.categoryAllocations[0].basis = 'above_max';
  sellLike.categoryAllocations[0].allocatedMinor = 5;
  assert.strictEqual(Domain.validateRecommendationOutput(sellLike).error.code, 'invalid_recommendation_output');

  const negative = JSON.parse(JSON.stringify(ok));
  negative.categoryAllocations[3].allocatedMinor = -100;
  assert.strictEqual(Domain.validateRecommendationOutput(negative).error.code, 'invalid_recommendation_output');

  const drift = JSON.parse(JSON.stringify(ok));
  drift.deviations[1].deviationBps += 1;
  assert.strictEqual(Domain.validateRecommendationOutput(drift).error.code, 'invalid_recommendation_output');

  const swapped = JSON.parse(JSON.stringify(ok));
  swapped.currentAllocation = swapped.currentAllocation.slice().reverse();
  assert.strictEqual(Domain.validateRecommendationOutput(swapped).error.code, 'invalid_recommendation_output');

  const unknownCode = JSON.parse(JSON.stringify(ok));
  unknownCode.explainCodes = ['guaranteed_return'];
  assert.strictEqual(Domain.validateRecommendationOutput(unknownCode).error.code, 'invalid_recommendation_output');

  const foreignRule = JSON.parse(JSON.stringify(ok));
  foreignRule.roundingNote.rule = '随机顺序取整';
  assert.strictEqual(Domain.validateRecommendationOutput(foreignRule).error.code, 'invalid_recommendation_output');

  const forgedTemplate = JSON.parse(JSON.stringify(ok));
  forgedTemplate.targetRanges[2].targetBps = 4001;
  forgedTemplate.deviations[2].targetBps = 4001;
  assert.notStrictEqual(Domain.validateRecommendationOutput(forgedTemplate).ok, true,
    '同版本偷换目标比例必须被 5A 模板复核挡下');
});

test('5D-22 落库记录读取即复核：伪造正式状态或偷换引用都拒', () => {
  const values = { cash: 50000000, fixed_income: 35000000, broad_equity: 8000000, theme_equity: 7000000, stock: 0, other: 0 };
  const dev = deviationOf(T3, values);
  const al = mustAlloc(T3, dev, 200000, 200000);
  const mp = Domain.mapAllocationToApprovedInstruments(al, mappingOf({ broad_equity: ['ins-b1'] }));
  const versions = versionsOf(T3);
  const gate = Domain.recommendationStatusFromGate(gateChecks([]));
  const built = Domain.buildRecommendationResult({
    status: gate.status, blockers: [], dataCutoff: TODAY, versions, deviation: dev, allocation: al, mapping: mp
  });
  const record = {
    id: 'rec-' + 'c'.repeat(16), createdAt: '2026-09-30T10:00:00.000Z', status: gate.status,
    ruleVersion: versions.ruleVersion, targetVersion: versions.targetVersion,
    assessmentId: versions.assessmentId, targetId: versions.targetId,
    closeId: versions.closeId, snapshotId: versions.snapshotId, snapshotPayloadHash: versions.snapshotPayloadHash,
    dataCutoff: TODAY, asOf: TODAY,
    requestedNewFundsMinor: al.requestedNewFundsMinor, newFundsAvailableMinor: al.newFundsAvailableMinor,
    allocatableNewFundsMinor: al.allocatableNewFundsMinor, allocatedTotalMinor: al.allocatedTotalMinor,
    inputHash: 'd'.repeat(64), gate: { checks: gate.checks }, todos: mp.todos, result: built.result
  };
  assert.strictEqual(Domain.validateRecommendationRecord(record).ok, true, JSON.stringify(Domain.validateRecommendationRecord(record).error));

  const fakeFormal = JSON.parse(JSON.stringify(record));
  fakeFormal.gate.checks[3] = { code: 'can_advise', passed: false, detail: 'quote_stale' };
  assert.strictEqual(Domain.validateRecommendationRecord(fakeFormal).error.code, 'invalid_recommendation_record',
    '门禁不过却标 formal → 拒');

  const swappedRef = JSON.parse(JSON.stringify(record));
  swappedRef.result.versions.assessmentId = 'ra-forged';
  assert.strictEqual(Domain.validateRecommendationRecord(swappedRef).error.code, 'invalid_recommendation_record');

  const wrongAmount = JSON.parse(JSON.stringify(record));
  wrongAmount.allocatedTotalMinor += 1;
  assert.strictEqual(Domain.validateRecommendationRecord(wrongAmount).error.code, 'invalid_recommendation_record');

  const extraTodo = JSON.parse(JSON.stringify(record));
  extraTodo.todos = [{ code: 'missing_approved_instrument', assetClass: 'cash', retainedMinor: 1 }];
  assert.strictEqual(Domain.validateRecommendationRecord(extraTodo).error.code, 'invalid_recommendation_record');

  const missingBound = JSON.parse(JSON.stringify(record));
  missingBound.snapshotPayloadHash = 'not-a-hash';
  assert.strictEqual(Domain.validateRecommendationRecord(missingBound).error.code, 'invalid_recommendation_record');

  const leaked = JSON.parse(JSON.stringify(record));
  delete leaked.result;
  assert.strictEqual(Domain.validateRecommendationRecord(leaked).error.code, 'invalid_recommendation_record');
  const stateField = JSON.parse(JSON.stringify(record));
  stateField.decisionState = 'accepted';
  assert.strictEqual(Domain.validateRecommendationRecord(stateField).error.code, 'invalid_recommendation_record',
    '不得携带 Phase 6 的决策状态字段');

  // 排序与行序无关
  const older = Object.assign({}, record, { id: 'rec-a', createdAt: '2026-09-29T10:00:00.000Z' });
  const sortedA = Domain.sortRecommendations([record, older]).map((x) => x.id);
  const sortedB = Domain.sortRecommendations([older, record]).map((x) => x.id);
  assert.deepStrictEqual(sortedA, sortedB);
  assert.strictEqual(sortedA[0], record.id, 'createdAt 降序');
});

/* ------------------------- 7. 确定性与范围边界 ------------------------- */

test('5D-23 相同事实重复计算逐字段一致，且不依赖对象键序 / 数组行序', () => {
  const values = { cash: 10000000, fixed_income: 15000000, broad_equity: 45000000, theme_equity: 15000000, stock: 1000000, other: 14000000 };
  const spec = { broad_equity: ['ins-e1'], cash: ['ins-c1'], fixed_income: ['ins-f1', 'ins-f2'] };
  function run(order, specIn) {
    const v = {};
    order.forEach((k) => { v[k] = values[k]; });
    const dev = deviationOf(T3, v);
    const al = mustAlloc(T3, dev, 10000000, 10000000);
    const mp = Domain.mapAllocationToApprovedInstruments(al, mappingOf(specIn));
    assert.ok(mp.ok, JSON.stringify(mp.error));
    const built = Domain.buildRecommendationResult({
      status: 'formal', blockers: [], dataCutoff: TODAY, versions: versionsOf(T3),
      deviation: dev, allocation: al, mapping: mp
    });
    assert.ok(built.ok, JSON.stringify(built.error));
    return JSON.stringify(built.result);
  }
  const forward = run(CLASSES, spec);
  assert.strictEqual(run(CLASSES.slice().reverse(), spec), forward, '估值数组的构造顺序不得改变结果');
  const reversedSpec = {};
  Object.keys(spec).reverse().forEach((k) => { reversedSpec[k] = spec[k]; });
  assert.strictEqual(run(CLASSES, reversedSpec), forward, '认可标的对象的键序不得改变结果');
  assert.strictEqual(run(CLASSES, spec), forward, '重复运行必须逐字段一致');
});

test('5D-24 5D 段落范围守卫：零时钟 / 零网络 / 零存储，且不含 Phase 6 决策语义', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'domain.js'), 'utf8');
  const start = src.indexOf('新增资金优先再平衡与正式建议（Phase 5D');
  // 6B（D-057，契约 §11）：Phase 6 的领域段落追加在 5D 段落之后，本守卫的 end 标记
  // 相应下移到 Phase 6 段落开头 —— 只移动边界标记，断言逐条保留；Phase 6 段落自己
  // 有同形状的新守卫（见下一条），守卫数量只增不减。
  const end = src.indexOf('决策状态机与执行关联（Phase 6');
  assert.ok(start > 0 && end > start, '找不到 Phase 5D 段落边界');
  const seg = src.slice(start, end);
  ['Date.now', 'new Date(', 'fetch(', 'require(', 'XMLHttpRequest', 'Math.random', 'process.env',
    'localStorage', 'document.', 'window.'].forEach((frag) => {
    assert.strictEqual(seg.indexOf(frag), -1, 'Phase 5D 段落不得出现 ' + frag);
  });
  // Phase 6 的决策状态机与执行关联不得提前出现
  ['decision_events', 'decisions(', 'accepted', 'deferred', 'dismissed', 'executed', 'reviewed',
    'placeOrder', 'trade(', 'recommendationStatus ='].forEach((frag) => {
    assert.strictEqual(seg.indexOf(frag), -1, 'Phase 5D 段落不得出现 ' + frag);
  });
  // 不新增数据源、不开启自动行情
  ['Frankfurter', 'Provider', 'provider('].forEach((frag) => {
    assert.strictEqual(seg.indexOf(frag), -1, 'Phase 5D 不得接入外部数据源：' + frag);
  });
});

test('Phase 6 段落范围守卫：决策状态机零时钟 / 零网络 / 零存储，不接券商（6B，D-057）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'domain.js'), 'utf8');
  const start = src.indexOf('决策状态机与执行关联（Phase 6');
  const end = src.indexOf('return {\n    CURRENCIES: CURRENCIES,');
  assert.ok(start > 0 && end > start, '找不到 Phase 6 段落边界');
  const seg = src.slice(start, end);
  // 与 5D-24 同形状：零时钟、零网络、零存储、零随机、零 DOM。
  ['Date.now', 'new Date(', 'fetch(', 'require(', 'XMLHttpRequest', 'Math.random', 'process.env',
    'localStorage', 'document.', 'window.'].forEach((frag) => {
    assert.strictEqual(seg.indexOf(frag), -1, 'Phase 6 段落不得出现 ' + frag);
  });
  // 不做券商接入、不自动下单、不接外部数据源。
  ['placeOrder', 'trade(', 'Frankfurter', 'Provider', 'provider('].forEach((frag) => {
    assert.strictEqual(seg.indexOf(frag), -1, 'Phase 6 段落不得接入券商或外部数据源：' + frag);
  });
});

test('5D-25 契约快照与冻结常量：键集合来自 5A fixture，常量深度冻结不可被原地改写', () => {
  assert.deepStrictEqual(CONTRACT_5D.outputKeys, FIXTURE.recommendationContract.outputKeys);
  assert.deepStrictEqual(CONTRACT_5D.statuses, FIXTURE.recommendationContract.statuses);
  assert.deepStrictEqual(CONTRACT_5D.allocationOrder, FIXTURE.recommendationContract.allocationOrder);
  assert.strictEqual(CONTRACT_5D.moneyRoundingRule, FIXTURE.recommendationContract.roundingRule,
    '金额尾差规则必须复用 5A 冻结的稳定键文字');
  assert.strictEqual(CONTRACT_5D.ruleVersion, Domain.RISK_RULE_VERSION);
  assert.strictEqual(CONTRACT_5D.targetVersion, Domain.RISK_TARGET_VERSION);
  assert.strictEqual(CONTRACT_5D.bpsTotal, BPS);
  assert.deepStrictEqual(CONTRACT_5D.adjustments,
    ['fill_below_min', 'converge_to_target', 'within_tolerance', 'no_investable', 'zero_allocatable']);
  assert.deepStrictEqual(CONTRACT_5D.recordKeys.slice(0, 3), ['id', 'createdAt', 'status']);
  assert.ok(CONTRACT_5D.recordKeys.indexOf('decisionState') === -1);
  assert.ok(CONTRACT_5D.explainCodes.indexOf('new_funds_no_investable') >= 0);

  // 冻结对象上的写入在严格模式抛 TypeError、非严格模式静默失败，两种都必须「改不动」
  function tryMutate(fn) {
    try { fn(); return 'silent'; } catch (e) { return e instanceof TypeError ? 'threw' : 'other:' + e; }
  }
  const before = JSON.stringify({
    adjustments: Domain.NEW_FUND_ADJUSTMENTS,
    gates: Domain.RECOMMENDATION_GATE_CHECKS,
    explains: Domain.RECOMMENDATION_EXPLAIN_CODES,
    allocKeys: Domain.NEW_FUND_ALLOCATION_KEYS,
    recordKeys: Domain.RECOMMENDATION_RECORD_KEYS
  });
  [
    () => { Domain.NEW_FUND_ADJUSTMENTS.push('sell'); },
    () => { Domain.NEW_FUND_ADJUSTMENTS.length = 0; },
    () => { Domain.RECOMMENDATION_GATE_CHECKS[0] = 'whatever'; },
    () => { Domain.RECOMMENDATION_EXPLAIN_CODES[0] = 'guaranteed_return'; },
    () => { Domain.NEW_FUND_ALLOCATION_KEYS.pop(); },
    () => { Domain.RECOMMENDATION_RECORD_KEYS.push('decisionState'); }
  ].forEach((fn) => {
    const outcome = tryMutate(fn);
    assert.ok(outcome === 'threw' || outcome === 'silent', '写入必须被拒绝或无效，实际 ' + outcome);
  });
  assert.strictEqual(JSON.stringify({
    adjustments: Domain.NEW_FUND_ADJUSTMENTS,
    gates: Domain.RECOMMENDATION_GATE_CHECKS,
    explains: Domain.RECOMMENDATION_EXPLAIN_CODES,
    allocKeys: Domain.NEW_FUND_ALLOCATION_KEYS,
    recordKeys: Domain.RECOMMENDATION_RECORD_KEYS
  }), before, '冻结常量必须逐字段保持原值');
  assert.strictEqual(Domain.NEW_FUND_ADJUSTMENTS.length, 5);
  assert.strictEqual(Domain.RECOMMENDATION_GATE_CHECKS.length, 7);
  const snapshot = Domain.recommendation5DContract();
  snapshot.gateChecks.push('可写的副本');
  assert.strictEqual(Domain.recommendation5DContract().gateChecks.length, 7, '契约快照返回副本，写入不得回流');
});

// R-02：不能用算法自己的锚点作为期望，直接验证真实转配后现金与证券之和。
test('R-02 池内现金转配：万元案例总额不变、现金保底、宽基不超过上限', () => {
  const values = {cash:800000,fixed_income:100000,broad_equity:50000,theme_equity:50000,stock:0,other:0};
  const al = mustAlloc(T3,deviationOf(T3,values),800000,800000);
  assert.strictEqual(al.plannedTotalMinor,1000000);
  const after = Object.fromEntries(al.classes.map(r=>[r.assetClass,r.valueMinor+r.allocatedMinor]));
  after.cash -= al.allocatedTotalMinor;
  assert.strictEqual(Object.values(after).reduce((a,b)=>a+b,0),1000000);
  assert.ok(after.cash >= 150000);
  assert.ok(after.broad_equity <= 500000);
  assert.strictEqual(rowOf(al,'cash').allocatedMinor,0);
  assert.strictEqual(al.allocatedTotalMinor,600000);
  assert.strictEqual(al.unallocatedMinor,200000);
});
test('R-02 现金已低于下限时保留资金，不自买现金或卖出现有证券', () => {
  const values={cash:100000,fixed_income:150000,broad_equity:450000,theme_equity:150000,stock:10000,other:140000};
  const al=mustAlloc(T3,deviationOf(T3,values),100000,100000);
  assert.strictEqual(al.allocatedTotalMinor,0);
  assert.strictEqual(al.unallocatedMinor,100000);
  assert.ok(al.classes.every(c=>c.allocatedMinor===0));
});
