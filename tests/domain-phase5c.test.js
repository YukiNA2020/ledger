/* Phase 5C｜目标配置与认可标的映射｜领域层测试（DECISIONS D-046/D-047/D-048）
 *
 * 覆盖 PHASE5_BREAKDOWN §6.4 的领域层退出条件：
 *   - 每个风险上限稳定映射到**唯一**合法目标版本，目标比例精确守恒（Σtarget = 10000bps）；
 *   - 当前配置与偏离只消费 computeOverview 的**同一遍**估值（D-025），缺行情/汇率/分类时
 *     沿用既有 blocker 与 canAdvise，不新写第二套「能不能建议」的判断；
 *   - 容忍带端点归属唯一（含入区间），空组合 / 只有现金 / 某类别 0% / 边界值均有断言；
 *   - 目标与映射的记录级复核：同版本偷换比例、引用与派生值不符、原型链注入一律 fail closed；
 *   - provider 与外部数据不得改写用户认可映射（引用失效只显式报告，不静默丢行）；
 *   - 范围边界：不接收新增资金金额、不算买入金额、不出建议、不建 Phase 6 决策状态。
 * 本文件只测纯领域层；HTTP / 仓储 / wiring 见 tests/server-phase5c.test.js 与 tests/app-wiring.js。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Domain = require('../js/domain.js');
const FIXTURE = require('./fixtures/phase5-risk-rules.json');

const TODAY = '2026-09-21';
const ASSESSED = '2026-06-15';
const EXPIRY = '2027-06-15';
const CREATED = '2026-06-15T08:00:00.000Z';
const CLASSES = Domain.RISK_CLASSES;
const CONTRACT = Domain.allocationContract();

/* ------------------------------ 构造评估记录的 helper ------------------------------ */

const CAP_QS = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'capacity');
const WIL_QS = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'willingness');

function optionByScore(q, score) {
  const hit = q.options.filter((o) => o.score === score)[0];
  if (!hit) throw new Error('题库缺少分值为 ' + score + ' 的选项：' + q.id);
  return hit.id;
}

// 逐题指定分值（可精确踩硬封顶档），派生值全部走 5B 的服务端口径函数
function assessment(id, overrides, capScores, wilScores) {
  const answers = [];
  capScores.forEach((s, i) => answers.push({ questionId: CAP_QS[i].id, optionId: optionByScore(CAP_QS[i], s) }));
  wilScores.forEach((s, i) => answers.push({ questionId: WIL_QS[i].id, optionId: optionByScore(WIL_QS[i], s) }));
  const payload = Object.assign({ answers, assessedAt: ASSESSED, reason: 'initial' }, overrides || {});
  const computed = Domain.computeRiskAssessment(payload, { today: TODAY });
  assert.ok(computed.ok, '前置：评估载荷必须合法：' + JSON.stringify(computed.error));
  return Object.assign({ id: id || 'ra-1', createdAt: CREATED }, computed.record);
}

// 每个风险上限一份可复现的评估：能力分落在该级下界，意愿分给到不 constraining 的一侧。
// 需要 L3+ 时各题都不得出现 0 分档（否则 5A 硬封顶会把上限压到 L2）。
const LEVEL_CASES = {
  1: { cap: [1, 1, 1, 0, 0], wil: [3, 3, 3, 3] },  // 能力 3 → L1（硬封顶 ≤2 不再抬高）
  2: { cap: [2, 1, 1, 0, 0], wil: [3, 3, 3, 3] },  // 能力 4 → L2
  3: { cap: [2, 2, 1, 1, 1], wil: [2, 2, 1, 1] },  // 能力 7 / 意愿 6 → 双双 L3
  4: { cap: [3, 3, 2, 1, 1], wil: [3, 3, 2, 1] },  // 能力 10 / 意愿 9 → L4
  5: { cap: [3, 3, 3, 3, 3], wil: [3, 3, 3, 3] }   // 能力 15 / 意愿 12 → L5
};

const ALL_GOOD = assessment('ra-1', null, LEVEL_CASES[5].cap, LEVEL_CASES[5].wil); // 上限 L5
const HARD_CAPPED = assessment('ra-2', null, [0, 0, 3, 3, 0], [3, 3, 3, 3]); // 应急金/收入/流动性踩封顶 → L2

function targetOf(rec, options) {
  const out = Domain.computeAllocationTarget(rec, Object.assign({ today: TODAY }, options || {}));
  assert.ok(out.ok, '前置：目标映射必须成功：' + JSON.stringify(out.error));
  return Object.assign({ id: 'at-1', createdAt: '2026-09-21T09:00:00.000Z' }, out.target);
}

/* 一份「只有余额」的最小资产事实，用于走真实的 computeOverview 估值一遍 */
function assetsWith(units, extra) {
  const a = Domain.emptyAssets();
  a.assetAccounts = [{ id: 'acc-1', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: 'I' }];
  a.assetUnits = units.map((u, i) => ({
    id: 'u' + i, accountId: 'acc-1', currency: u.currency, balanceMinor: u.balanceMinor, asOf: TODAY, sourceType: 'manual'
  }));
  Object.assign(a, extra || {});
  return a;
}

function overviewOf(assets, now) {
  return Domain.computeOverview(assets, { now: now || TODAY, settings: {} });
}

/* ------------------------- 1. 上限 → 目标模板：唯一且守恒 ------------------------- */

test('5C-1 每个风险上限映射到唯一冻结模板：比例精确守恒且与 5A fixture 逐字段一致', () => {
  const seen = {};
  Domain.RISK_LEVELS.forEach((level) => {
    const c = LEVEL_CASES[level];
    const rec = assessment('ra-l' + level, null, c.cap, c.wil);
    assert.strictEqual(rec.ceiling, level, '前置：构造出的上限应为 L' + level + '，实际 ' + rec.ceiling);
    const t = targetOf(rec);
    assert.strictEqual(t.level, level);
    assert.strictEqual(t.templateVersion, Domain.RISK_TARGET_VERSION);
    assert.strictEqual(t.ruleVersion, Domain.RISK_RULE_VERSION);
    assert.strictEqual(t.assessmentId, rec.id);
    assert.strictEqual(t.assessedAt, rec.assessedAt);
    assert.strictEqual(t.assessmentExpiry, rec.expiry);
    const expected = FIXTURE.targetTemplates.filter((x) => x.level === level)[0];
    assert.deepStrictEqual(t.classes, expected.classes, 'L' + level + ' 模板必须等于 5A 冻结副本');
    assert.deepStrictEqual(Domain.validateAllocationTargetRecord(t).ok, true);
    const sum = CLASSES.reduce((s, k) => s + t.classes[k].targetBps, 0);
    assert.strictEqual(sum, Domain.BPS_TOTAL, 'ΣtargetBps 必须精确等于 10000');
    CLASSES.forEach((k) => {
      assert.ok(t.classes[k].minBps <= t.classes[k].targetBps && t.classes[k].targetBps <= t.classes[k].maxBps);
    });
    seen[level] = JSON.stringify(t.classes);
  });
  // 五个等级的模板互不相同（不是把一份模板复制五遍）
  assert.strictEqual(new Set(Object.values(seen)).size, 5);
  // 个股 target 恒为 0（D-018：不给具体股票购买建议）
  Domain.RISK_LEVELS.forEach((l) => assert.strictEqual(JSON.parse(seen[l]).stock.targetBps, 0));
});

test('5C-2 确定性：同一评估重复映射逐字段一致，且与调用方对象顺序无关', () => {
  const a = targetOf(ALL_GOOD);
  const b = targetOf(JSON.parse(JSON.stringify(ALL_GOOD)));
  assert.deepStrictEqual(a, b);
  const shuffled = { classes: b.classes, createdAt: b.createdAt, id: b.id, effectiveFrom: b.effectiveFrom };
  Object.keys(b).forEach((k) => { if (!(k in shuffled)) shuffled[k] = b[k]; });
  assert.deepStrictEqual(Domain.validateAllocationTargetRecord(shuffled).ok, true, '键顺序不得影响复核');
  // 高意愿 + 低能力：上限取较低一侧，目标区间随之下移（不变量 1）
  assert.strictEqual(HARD_CAPPED.ceiling, 2);
  assert.strictEqual(targetOf(HARD_CAPPED).level, 2);
  assert.notDeepStrictEqual(targetOf(HARD_CAPPED).classes, targetOf(ALL_GOOD).classes);
});

/* ------------------------- 2. 生成前置条件：必须是**有效**评估 ------------------------- */

test('5C-3 过期评估、非法日期与非法载荷一律 fail closed，不生成目标', () => {
  const expired = Domain.computeAllocationTarget(ALL_GOOD, { today: '2027-07-01' });
  assert.strictEqual(expired.ok, false);
  assert.strictEqual(expired.error.code, 'assessment_expired');

  const cases = [
    ['生效日晚于判定日', { effectiveFrom: '2026-09-22' }, 'invalid_effective_date'],
    ['生效日早于评估日', { effectiveFrom: '2026-06-14' }, 'invalid_effective_date'],
    ['生效日晚于判定日（到期日之后）', { effectiveFrom: '2027-06-16', today: '2027-06-16' }, 'assessment_expired'],
    ['生效日不是真实日历日', { effectiveFrom: '2026-02-30' }, 'invalid_effective_date'],
    ['生效日是数字', { effectiveFrom: 20260921 }, 'invalid_effective_date'],
    ['判定日非法', { today: 'not-a-date' }, 'invalid_assessment_date']
  ];
  cases.forEach(([label, opts, code]) => {
    const r = Domain.computeAllocationTarget(ALL_GOOD, Object.assign({ today: TODAY }, opts));
    assert.strictEqual(r.ok, false, label + ' 必须被拒绝');
    assert.strictEqual(r.error.code, code, label + ' 错误码不符');
  });
  // 到期日当天仍可生成（与 5A/5B 同一口径：到期日当天有效）
  assert.strictEqual(Domain.computeAllocationTarget(ALL_GOOD, { today: EXPIRY, effectiveFrom: EXPIRY }).ok, true);
  // 派生值不符的评估记录（被伪造上限）不得作为映射输入
  const forged = Object.assign({}, ALL_GOOD, { ceiling: 5, capacityScore: 15 });
  const lowReal = assessment('ra-low', null, [1, 1, 2, 2, 2], [3, 3, 3, 3]);
  const tampered = Object.assign({}, lowReal, { ceiling: 5 });
  const r = Domain.computeAllocationTarget(tampered, { today: TODAY });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'invalid_answers');
  assert.ok(!JSON.stringify(r.error).includes('"ceiling":5'), '错误 detail 不回显输入原文');
  assert.ok(forged && lowReal);
});

/* ------------------------- 3. 目标记录复核（读取即复核） ------------------------- */

test('5C-4 validateAllocationTargetRecord 拒绝同版本偷换比例、错等级与字段注入', () => {
  const good = targetOf(ALL_GOOD);
  assert.strictEqual(Domain.validateAllocationTargetRecord(good).ok, true);

  const variants = [
    ['同版本偷换一组自洽比例', (t) => { t.classes.cash = { minBps: 0, targetBps: 10000, maxBps: 10000 }; }],
    ['等级与模板不匹配', (t) => { t.level = 1; }],
    ['未知模板版本', (t) => { t.templateVersion = 'risk-targets-unknown'; }],
    ['未知规则版本', (t) => { t.ruleVersion = 'risk-rules-v9'; }],
    ['到期日与冻结有效期不符', (t) => { t.assessmentExpiry = '2028-01-01'; }],
    ['生效日晚于到期日', (t) => { t.effectiveFrom = '2027-06-16'; }],
    ['生效日早于评估日', (t) => { t.effectiveFrom = '2026-06-01'; }],
    ['缺 classes 中的一类', (t) => { delete t.classes.other; }],
    ['多出词表外类别', (t) => { t.classes.crypto = { minBps: 0, targetBps: 0, maxBps: 0 }; }],
    ['多余自有键', (t) => { t.newFundsMinor = 200000; }],
    ['比例非整数', (t) => { t.classes.cash.targetBps = 1000.5; }],
    ['id 为空串', (t) => { t.id = ''; }]
  ];
  variants.forEach(([label, mutate]) => {
    const bad = JSON.parse(JSON.stringify(good));
    mutate(bad);
    const r = Domain.validateAllocationTargetRecord(bad);
    assert.strictEqual(r.ok, false, label + ' 必须被拒绝');
    assert.ok(typeof r.error.code === 'string' && r.error.code.length > 0, label + ' 必须给出稳定错误码');
  });

  // 原型链注入：继承来的类别不得被当成用户数据
  const protoInjected = Object.create({ cash: { minBps: 0, targetBps: 0, maxBps: 0 } });
  const viaProto = Object.assign({}, good);
  viaProto.classes = protoInjected;
  CLASSES.slice(1).forEach((k) => { viaProto.classes[k] = good.classes[k]; });
  viaProto.classes.fixed_income = good.classes.fixed_income;
  assert.strictEqual(Domain.validateAllocationTargetRecord(viaProto).ok, false, '原型链类别必须被拒');
  // Object.create(null) 的 JSON 等价纯数据对象仍应可复核
  const nullProto = Object.create(null);
  Object.keys(good).forEach((k) => { nullProto[k] = good[k]; });
  assert.strictEqual(Domain.validateAllocationTargetRecord(nullProto).ok, true);
});

test('5C-5 目标必须与所引用评估交叉核对（评估侧被改写同样 fail closed）', () => {
  const t = targetOf(ALL_GOOD);
  assert.strictEqual(Domain.validateAllocationTargetRecord(t, ALL_GOOD).ok, true);
  const mismatches = [
    ['引用了别的评估', () => Object.assign({}, ALL_GOOD, { id: 'ra-other' })],
    ['上限被抬高', () => Object.assign({}, ALL_GOOD, { ceiling: 1 })],
    ['评估日被改', () => Object.assign({}, ALL_GOOD, { assessedAt: '2026-01-01' })],
    ['规则版本被改', () => Object.assign({}, ALL_GOOD, { ruleVersion: 'risk-rules-v0' })]
  ];
  mismatches.forEach(([label, make]) => {
    const r = Domain.validateAllocationTargetRecord(t, make());
    assert.strictEqual(r.ok, false, label + ' 时目标不得通过复核');
  });
  // 评估本身不合法（伪造派生值）同样挡住
  assert.strictEqual(Domain.validateAllocationTargetRecord(t, Object.assign({}, ALL_GOOD, { capacityScore: 0 })).ok, false);
});

/* ------------------------- 4. 排序与「当前生效目标」 ------------------------- */

test('5C-6 目标排序与行序无关；当前生效目标按确定性规则选出', () => {
  const base = targetOf(ALL_GOOD);
  const older = Object.assign({}, base, { id: 'at-old', effectiveFrom: '2026-06-20', createdAt: '2026-06-20T00:00:00.000Z' });
  const newer = Object.assign({}, base, { id: 'at-new', effectiveFrom: '2026-09-01', createdAt: '2026-09-01T00:00:00.000Z' });
  const otherAssessment = Object.assign({}, newer, {
    id: 'at-other', assessmentId: 'ra-2', assessmentExpiry: EXPIRY, assessedAt: ASSESSED
  });
  // 故意把第二个评估的记录也造出来，让 selectCurrentTarget 能交叉核对
  const sortedA = Domain.sortAllocationTargets([older, newer, otherAssessment]).map((t) => t.id);
  const sortedB = Domain.sortAllocationTargets([otherAssessment, newer, older]).map((t) => t.id);
  assert.deepStrictEqual(sortedA, sortedB, '同一批记录任意输入顺序必须得到同一序列');
  assert.deepStrictEqual(sortedA, ['at-new', 'at-other', 'at-old'], '生效日降序 → 同生效日按 createdAt 降序 → id 升序');
  assert.strictEqual(Domain.sortAllocationTargets({}), null);

  const current = Domain.selectCurrentTarget([older, newer], ALL_GOOD, TODAY);
  assert.strictEqual(current.ok, true);
  assert.strictEqual(current.status, 'current');
  assert.strictEqual(current.current.target.id, 'at-new');

  assert.strictEqual(Domain.selectCurrentTarget([], ALL_GOOD, TODAY).status, 'no_target', '有评估但未生成目标');
  assert.strictEqual(Domain.selectCurrentTarget([], null, TODAY).status, 'no_assessment', '还没有有效评估');
  assert.strictEqual(Domain.selectCurrentTarget([newer], null, TODAY).status, 'no_assessment');
  assert.strictEqual(Domain.selectCurrentTarget([older], HARD_CAPPED, TODAY).status, 'stale_assessment',
    '目标引用的评估不是当前有效评估时必须显式区分');
  const forged = JSON.parse(JSON.stringify(newer));
  forged.classes.cash.targetBps = 9999;
  // 一条被篡改 + 一条合法：篡改条目不得冒充可用目标，但合法条目仍然可用（invalidCount 显式留痕）
  const partial = Domain.selectCurrentTarget([forged, older], ALL_GOOD, TODAY);
  assert.strictEqual(partial.status, 'current', '仍有合法目标时不应整体判为不可用');
  assert.strictEqual(partial.current.target.id, 'at-old');
  assert.strictEqual(partial.invalidCount, 1);
  assert.strictEqual(partial.total, 2);
  const mixed = Domain.selectCurrentTarget([forged, newer], ALL_GOOD, TODAY);
  assert.strictEqual(mixed.status, 'current');
  assert.strictEqual(mixed.current.target.id, 'at-new');
  assert.strictEqual(mixed.invalidCount, 1);
  // 全部记录都不可解析 → 显式 invalid_records，绝不返回其中一条当现状
  const allBad = Domain.selectCurrentTarget([forged, Object.assign(JSON.parse(JSON.stringify(newer)), { level: 9 })],
    ALL_GOOD, TODAY);
  assert.strictEqual(allBad.status, 'invalid_records', '全部记录不可解析时不得冒充可用目标');
  assert.strictEqual(allBad.invalidCount, 2);
  assert.strictEqual(allBad.total, 2);
  assert.strictEqual(allBad.current, null);
  // 生效日在判定日之后：引用对了但尚未生效 → no_target，不能与「引用了别的评估」混为一谈
  const future = Object.assign({}, newer, { effectiveFrom: '2026-12-01' });
  assert.strictEqual(Domain.selectCurrentTarget([future], ALL_GOOD, '2026-07-01').status, 'no_target');
  assert.strictEqual(Domain.selectCurrentTarget([future], ALL_GOOD, '2026-12-01').status, 'current');
});

/* ------------------------- 5. 当前配置与偏离：复用同一遍估值 ------------------------- */

function overviewWith(values) {
  // 直接构造 computeOverview 的输出形状（类别合计与投资池同源），只用于偏离计算的断言；
  // 与真实总览的一致性由 5C-8 单独核对。
  const total = CLASSES.reduce((s, k) => s + values[k], 0);
  return {
    asOf: TODAY, valuationStatus: 'formal', canAdvise: true,
    pools: { safetyMinor: 0, investableMinor: total, restrictedMinor: 0 },
    blockers: [],
    riskClasses: CLASSES.map((k) => ({ assetClass: k, valueMinor: values[k], pct: total ? Math.round(values[k] / total * 1000) / 10 : null }))
  };
}

test('5C-7 偏离计算：ΣpctBps 恒等于 10000，边界值归属唯一（端点含入区间）', () => {
  const t = targetOf(ALL_GOOD); // L5：cash 500–1000–2000，fixed_income 500–1000–2500，broad_equity 5500–6500–7500
  const cases = [
    ['除不尽的三分', { cash: 1, fixed_income: 1, broad_equity: 1, theme_equity: 0, stock: 0, other: 0 }, null],
    ['现金恰好在下界', { cash: 2000, fixed_income: 5000, broad_equity: 0, theme_equity: 0, stock: 3000, other: 0 }, 'cash'],
    ['现金恰好在上界', { cash: 20000, fixed_income: 5000, broad_equity: 0, theme_equity: 0, stock: 25000, other: 0 }, null],
    ['宽基权益 0%（min 为 5500）', { cash: 2500, fixed_income: 2500, broad_equity: 0, theme_equity: 2500, stock: 0, other: 2500 }, 'broad_equity'],
    ['个股在上界内', { cash: 1000, fixed_income: 1000, broad_equity: 6000, theme_equity: 1000, stock: 900, other: 100 }, 'stock']
  ];
  cases.forEach(([label, values, watch]) => {
    const r = Domain.computeAllocationDeviation(t, overviewWith(values));
    assert.strictEqual(r.ok, true, label + '：' + JSON.stringify(r.error));
    assert.strictEqual(r.status, 'ok');
    const sum = r.classes.reduce((s, c) => s + c.pctBps, 0);
    assert.strictEqual(sum, Domain.BPS_TOTAL, label + ' 的 ΣpctBps 必须精确守恒');
    assert.strictEqual(r.investableTotalMinor, CLASSES.reduce((s, k) => s + values[k], 0));
    r.classes.forEach((c) => {
      assert.ok(['below_min', 'within', 'above_max'].indexOf(c.band) >= 0, label + ' 容忍带词表外');
      assert.strictEqual(c.deviationBps, c.pctBps - c.targetBps);
      assert.strictEqual(c.minBps, t.classes[c.assetClass].minBps);
    });
    if (watch) {
      const row = r.classes.filter((c) => c.assetClass === watch)[0];
      const tpl = t.classes[watch];
      if (row.pctBps === tpl.minBps || row.pctBps === tpl.maxBps) {
        assert.strictEqual(row.band, 'within', label + '：端点必须含入区间');
      }
    }
  });

  // 端点归属逐一分明：min-1 / min / max / max+1（总量固定 10000，1 分 = 1bp，边界可精确构造）
  const at = (cash, fixed) => ({
    cash: cash, fixed_income: fixed, broad_equity: 10000 - cash - fixed, theme_equity: 0, stock: 0, other: 0
  });
  const belowRow = Domain.computeAllocationDeviation(t, overviewWith(at(499, 500)))
    .classes.filter((c) => c.assetClass === 'cash')[0];
  assert.strictEqual(belowRow.pctBps, 499);
  assert.strictEqual(belowRow.band, 'below_min', '低于下限 1bp 即 below_min');
  const onMin = Domain.computeAllocationDeviation(t, overviewWith(at(500, 500)))
    .classes.filter((c) => c.assetClass === 'cash')[0];
  assert.strictEqual(onMin.pctBps, t.classes.cash.minBps);
  assert.strictEqual(onMin.band, 'within', '恰好等于下限属区间内');
  const onMax = Domain.computeAllocationDeviation(t, overviewWith(at(2000, 500)))
    .classes.filter((c) => c.assetClass === 'cash')[0];
  assert.strictEqual(onMax.pctBps, t.classes.cash.maxBps);
  assert.strictEqual(onMax.band, 'within', '恰好等于上限属区间内');
  const overMax = Domain.computeAllocationDeviation(t, overviewWith(at(2001, 500)))
    .classes.filter((c) => c.assetClass === 'cash')[0];
  assert.strictEqual(overMax.pctBps, 2001);
  assert.strictEqual(overMax.band, 'above_max', '高出上限 1bp 即 above_max');
  assert.strictEqual(overMax.deviationBps, 2001 - t.classes.cash.targetBps);
  // 确定性：同一输入重复计算逐字段一致，且不改动入参
  const input = overviewWith({ cash: 1, fixed_income: 2, broad_equity: 3, theme_equity: 4, stock: 5, other: 6 });
  const before = JSON.stringify(input);
  const d1 = Domain.computeAllocationDeviation(t, input);
  const d2 = Domain.computeAllocationDeviation(t, JSON.parse(JSON.stringify(input)));
  assert.deepStrictEqual(d1, d2);
  assert.strictEqual(JSON.stringify(input), before, '偏离计算不得改写估值结果');
});

test('5C-8 比例与总览同源：与 computeOverview 的同一遍估值逐类一致，且缺数据时沿用既有 blocker', () => {
  const t = targetOf(ALL_GOOD);
  const assets = assetsWith([
    { currency: 'CNY', balanceMinor: 3000000 },
    { currency: 'USD', balanceMinor: 1000000 }
  ]);
  assets.fxRates = [{ base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: TODAY, provider: 'manual', status: 'ok' }];
  const ov = overviewOf(assets);
  const r = Domain.computeAllocationDeviation(t, ov);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.investableTotalMinor, ov.pools.investableMinor);
  CLASSES.forEach((k) => {
    const fromOverview = ov.riskClasses.filter((x) => x.assetClass === k)[0];
    const row = r.classes.filter((x) => x.assetClass === k)[0];
    assert.strictEqual(row.valueMinor, fromOverview.valueMinor, k + ' 金额必须与总览逐分一致');
    // 总览用 0.1% 口径、5C 用 bps 口径，两者必须指向同一个数（bps/100 不放大误差）
    assert.ok(Math.abs(row.pctBps / 100 - fromOverview.pct) < 0.05, k + ' 比例与总览口径不一致');
  });
  // 缺汇率 → 总览标 estimate，5C 原样透传，不新写第二套判断
  const noFx = assetsWith([{ currency: 'USD', balanceMinor: 1000000 }]);
  const ovNoFx = overviewOf(noFx);
  assert.strictEqual(ovNoFx.canAdvise, false);
  const rNoFx = Domain.computeAllocationDeviation(t, ovNoFx);
  assert.strictEqual(rNoFx.canAdvise, false);
  assert.ok(rNoFx.blockers.some((b) => b.code === 'fx_missing'), '缺汇率的 blocker 必须原样透传');
  // 分类未确认的持仓同样沿用既有 blocker
  const unconfirmed = assetsWith([{ currency: 'CNY', balanceMinor: 100000 }], {
    instruments: [{ id: 'ins-1', symbol: 'AAA', currency: 'CNY', assetClass: 'broad_equity', classificationStatus: 'suggested', exchange: 'SSE' }],
    holdings: [{ id: 'h1', accountId: 'acc-1', instrumentId: 'ins-1', quantity: '1.0000', costMinor: 100000, asOf: TODAY }],
    quotes: [{ instrumentId: 'ins-1', priceMinor: 100000, currency: 'CNY', priceDate: TODAY, provider: 'manual', status: 'ok' }]
  });
  const ovUnc = overviewOf(unconfirmed);
  const rUnc = Domain.computeAllocationDeviation(t, ovUnc);
  assert.strictEqual(rUnc.canAdvise, false);
  assert.ok(rUnc.blockers.some((b) => b.code === 'classification_unconfirmed'));
});

test('5C-9 空组合 / 只有现金 / 估值不一致 / 超出安全整数一律显式表达，不猜比例', () => {
  const t = targetOf(ALL_GOOD);
  const empty = Domain.computeAllocationDeviation(t, overviewWith({ cash: 0, fixed_income: 0, broad_equity: 0, theme_equity: 0, stock: 0, other: 0 }));
  assert.strictEqual(empty.ok, true);
  assert.strictEqual(empty.status, 'no_investable', '投资池为 0 时不出比例');
  empty.classes.forEach((c) => {
    assert.strictEqual(c.pctBps, null);
    assert.strictEqual(c.band, null, '不得把「算不出」显示成在区间内');
    assert.strictEqual(c.deviationBps, null);
    assert.strictEqual(c.minBps, t.classes[c.assetClass].minBps, '目标区间本身仍然可读');
  });
  assert.deepStrictEqual(empty.summary, { belowMin: 0, within: 0, aboveMax: 0 });

  const cashOnly = Domain.computeAllocationDeviation(t, overviewWith({ cash: 500000000, fixed_income: 0, broad_equity: 0, theme_equity: 0, stock: 0, other: 0 }));
  const cashRow = cashOnly.classes.filter((c) => c.assetClass === 'cash')[0];
  assert.strictEqual(cashRow.pctBps, Domain.BPS_TOTAL, '只有现金时现金占满 100%');
  assert.strictEqual(cashRow.band, 'above_max');
  // L5 模板：cash 100% 越上限；fixed_income / broad_equity / theme_equity 的下界 > 0 故为低配；
  // stock 与 other 的下界本就是 0，0% 仍算区间内（不得把「没有个股」当成偏离）。
  assert.deepStrictEqual(cashOnly.summary, { belowMin: 3, within: 2, aboveMax: 1 });

  const skewed = overviewWith({ cash: 100, fixed_income: 0, broad_equity: 0, theme_equity: 0, stock: 0, other: 0 });
  skewed.pools.investableMinor = 999;
  assert.strictEqual(Domain.computeAllocationDeviation(t, skewed).error.code, 'invalid_valuation_input',
    '类别合计与投资池不一致说明传入的不是同一遍估值结果');
  const missingClass = JSON.parse(JSON.stringify(skewed));
  missingClass.riskClasses = missingClass.riskClasses.slice(0, 5);
  assert.strictEqual(Domain.computeAllocationDeviation(t, missingClass).error.code, 'invalid_valuation_input');
  const dupClass = JSON.parse(JSON.stringify(skewed));
  dupClass.riskClasses[1] = Object.assign({}, dupClass.riskClasses[0]);
  assert.strictEqual(Domain.computeAllocationDeviation(t, dupClass).error.code, 'invalid_valuation_input');
  const huge = overviewWith({ cash: 900000000000001, fixed_income: 1, broad_equity: 0, theme_equity: 0, stock: 0, other: 0 });
  assert.strictEqual(Domain.computeAllocationDeviation(t, huge).error.code, 'invalid_valuation_input',
    '定点放缩超出安全整数时 fail closed，不给差 1bp 的比例');
  assert.strictEqual(Domain.computeAllocationDeviation(t, null).error.code, 'invalid_valuation_input');
  assert.strictEqual(Domain.computeAllocationDeviation(t, {}).error.code, 'invalid_valuation_input');
  // 目标本身不合法时先挡下（不得用坏目标算偏离）
  const badTarget = Object.assign({}, t, { level: 9 });
  assert.strictEqual(Domain.computeAllocationDeviation(badTarget, overviewWith({ cash: 1, fixed_income: 0, broad_equity: 0, theme_equity: 0, stock: 0, other: 0 })).ok, false);
});

/* ------------------------- 6. 认可标的映射：用户判断，引用必须成立 ------------------------- */

const INST = [
  { id: 'ins-cash', symbol: 'MMF', name: '货币基金', assetClass: 'cash', classificationStatus: 'confirmed' },
  { id: 'ins-bond', symbol: 'BND', name: '债基', assetClass: 'fixed_income', classificationStatus: 'confirmed' },
  { id: 'ins-voo', symbol: 'VOO', name: '标普500', assetClass: 'broad_equity', classificationStatus: 'confirmed' },
  { id: 'ins-theme', symbol: 'THM', name: '主题基金', assetClass: 'theme_equity', classificationStatus: 'suggested' },
  { id: 'ins-stk', symbol: 'STK', name: '个股', assetClass: 'stock', classificationStatus: 'confirmed' }
];

function row(cls, instrumentId, position) {
  return {
    id: 'aim-' + cls + '-' + position, assetClass: cls, instrumentId: instrumentId,
    position: position, createdAt: CREATED, updatedAt: CREATED
  };
}

test('5C-10 映射载荷精确键白名单：派生字段、词表外类别与畸形数组一律拒绝', () => {
  assert.deepStrictEqual(CONTRACT.mappingRequestKeys, ['assetClass', 'instrumentIds']);
  const ok = Domain.validateApprovedMappingRequest({ assetClass: 'broad_equity', instrumentIds: ['ins-voo'] });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.instrumentIds, ['ins-voo']);
  const emptyList = Domain.validateApprovedMappingRequest({ assetClass: 'broad_equity', instrumentIds: [] });
  assert.strictEqual(emptyList.ok, true, '清空整类是合法的用户判断');
  const cases = [
    ['多余派生键', { assetClass: 'cash', instrumentIds: [], level: 5 }, 'invalid_mapping_payload'],
    ['缺 instrumentIds', { assetClass: 'cash' }, 'invalid_mapping_payload'],
    ['类别词表外', { assetClass: 'crypto', instrumentIds: ['a'] }, 'invalid_mapping_payload'],
    ['类别来自原型链', Object.assign(Object.create({ assetClass: 'cash', instrumentIds: ['a'] }), {}), 'invalid_mapping_payload'],
    ['instrumentIds 非数组', { assetClass: 'cash', instrumentIds: 'ins-cash' }, 'invalid_mapping_payload'],
    ['稀疏槽位', (() => { const a = ['x']; a[5] = 'y'; return { assetClass: 'cash', instrumentIds: a }; })(), 'invalid_mapping_payload'],
    ['空字符串 id', { assetClass: 'cash', instrumentIds: [''] }, 'invalid_mapping_payload'],
    ['重复引用', { assetClass: 'cash', instrumentIds: ['a', 'a'] }, 'duplicate_mapping'],
    ['超出上限', { assetClass: 'cash', instrumentIds: new Array(51).fill(0).map((_, i) => 'i' + i) }, 'invalid_mapping_payload']
  ];
  cases.forEach(([label, payload, code]) => {
    const r = Domain.validateApprovedMappingRequest(payload);
    assert.strictEqual(r.ok, false, label + ' 必须被拒绝');
    assert.strictEqual(r.error.code, code, label + ' 错误码不符');
  });
});

test('5C-11 引用完整性在读取时判定：失效行保留并给出原因，绝不自动删改', () => {
  const rows = [
    row('broad_equity', 'ins-voo', 0),
    row('theme_equity', 'ins-theme', 0),          // 分类未确认
    row('cash', 'ins-gone', 0),                    // 标的已不存在
    row('fixed_income', 'ins-voo', 1),             // 类别冲突（VOO 属宽基权益）
    row('cash', 'ins-cash', 1)
  ];
  const view = Domain.checkApprovedMapping(rows, INST);
  assert.strictEqual(view.ok, true);
  assert.strictEqual(view.total, 5);
  assert.strictEqual(view.invalidCount, 0, '记录本身形状合法');
  assert.strictEqual(view.validCount, 2);
  assert.strictEqual(view.issueCount, 3);
  const byId = {};
  view.rows.forEach((r) => { byId[r.id] = r; });
  assert.deepStrictEqual(byId['aim-broad_equity-0'].issues, []);
  assert.deepStrictEqual(byId['aim-theme_equity-0'].issues, ['classification_unconfirmed']);
  assert.deepStrictEqual(byId['aim-cash-0'].issues, ['instrument_missing']);
  assert.deepStrictEqual(byId['aim-fixed_income-1'].issues, ['class_mismatch']);
  assert.strictEqual(byId['aim-fixed_income-1'].instrumentAssetClass, 'broad_equity', '冲突时给出标的真实类别供页面解释');
  // 顺序：类别序 → position 升序，且失效行不消失
  assert.deepStrictEqual(view.rows.map((r) => r.assetClass + ':' + r.position),
    ['cash:0', 'cash:1', 'fixed_income:1', 'broad_equity:0', 'theme_equity:0']);
  assert.strictEqual(view.byClass.cash.length, 2);
  // 形状不合规的行显式计数，不静默丢弃
  const broken = Domain.checkApprovedMapping([row('cash', 'ins-cash', 0), { id: 'x', assetClass: 'cash' }], INST);
  assert.strictEqual(broken.invalidCount, 1);
  assert.strictEqual(broken.total, 2);
  assert.strictEqual(broken.rows.length, 1);
  // provider 视角：标的类别是用户判断，外部字段变更只体现为「冲突提示」，映射行本身不动
  const refreshed = INST.map((i) => Object.assign({}, i));
  const view2 = Domain.checkApprovedMapping(rows, refreshed);
  assert.deepStrictEqual(view2.rows.map((r) => r.id), view.rows.map((r) => r.id), '同一份映射不得因外部数据换行');
  assert.deepStrictEqual(view2.rows.map((r) => r.status), view.rows.map((r) => r.status));
});

test('5C-12 缺映射按目标比例判定：target 为 0 的类别不算缺，失效引用不能顶替', () => {
  const t = targetOf(ALL_GOOD); // L5：stock target 0，theme_equity target 1500
  const view = Domain.checkApprovedMapping([
    row('broad_equity', 'ins-voo', 0),
    row('theme_equity', 'ins-theme', 0), // 未确认 → 不可用
    row('cash', 'ins-cash', 0)
  ], INST);
  const missing = Domain.classesMissingMapping(t, view);
  assert.strictEqual(missing.ok, true);
  assert.deepStrictEqual(missing.missingClasses, ['fixed_income', 'theme_equity'],
    '现金/宽基已覆盖，固收与主题权益缺可用标的；个股 target 为 0 不算缺');
  assert.strictEqual(Domain.classesMissingMapping(t, null).ok, false);
  // 无映射时：目标比例 > 0 的类别全部缺，但不阻止显示偏离
  const none = Domain.checkApprovedMapping([], INST);
  assert.deepStrictEqual(Domain.classesMissingMapping(t, none).missingClasses,
    CLASSES.filter((k) => t.classes[k].targetBps > 0));
});

/* ------------------------- 13. 范围边界与契约快照 ------------------------- */

test('5C-13 输出不含 5D/Phase 6 语义：没有金额分配、没有建议状态、没有决策字段', () => {
  const t = targetOf(ALL_GOOD);
  const r = Domain.computeAllocationDeviation(t, overviewWith({ cash: 1000, fixed_income: 1000, broad_equity: 7000, theme_equity: 500, stock: 250, other: 250 }));
  const json = JSON.stringify(r);
  ['newFunds', 'newFundsMinor', 'allocationMinor', 'amountMinor"', 'recommendation', 'categoryAllocations',
    'buyAmount', 'sell', 'status":"formal', 'accepted', 'executed', 'reviewed'].forEach((frag) => {
    assert.ok(json.indexOf(frag) === -1, '5C 输出不得出现 ' + frag);
  });
  assert.deepStrictEqual(Object.keys(r).sort(), [
    'asOf', 'blockers', 'canAdvise', 'classes', 'investableTotalMinor', 'ok', 'roundingRule',
    'status', 'summary', 'targetLevel', 'targetVersion', 'valuationStatus'
  ].sort());
  r.classes.forEach((c) => {
    assert.deepStrictEqual(Object.keys(c).sort(),
      ['assetClass', 'band', 'deviationBps', 'maxBps', 'minBps', 'pctBps', 'targetBps', 'valueMinor'].sort());
  });
  // 目标记录键集合固定（5D 只能按这套引用读取，不得各写一份）
  assert.deepStrictEqual(Object.keys(targetOf(ALL_GOOD)).sort(), CONTRACT.targetRecordKeys.slice().sort());
});

test('5C-14 契约快照是稳定只读副本；对外数组原地改写不影响后续判定', () => {
  const a = Domain.allocationContract();
  const b = Domain.allocationContract();
  assert.deepStrictEqual(a, b);
  a.targetRecordKeys.push('extra');
  a.classes[0] = 'crypto';
  assert.strictEqual(Domain.allocationContract().targetRecordKeys.indexOf('extra'), -1, '契约快照必须可安全修改副本');
  assert.strictEqual(Domain.allocationContract().classes[0], 'cash');
  assert.strictEqual(Domain.ALLOCATION_TARGET_RECORD_KEYS.frozen || Object.isFrozen(Domain.ALLOCATION_TARGET_RECORD_KEYS), true,
    '对外规则数组必须冻结（G5A-1 同一纪律）');
  const before = JSON.stringify(Domain.ALLOCATION_ERROR_CODES);
  try { Domain.ALLOCATION_ERROR_CODES.push('x'); } catch (_) { /* 严格模式抛错也算拒绝 */ }
  assert.strictEqual(JSON.stringify(Domain.ALLOCATION_ERROR_CODES), before, '错误码词表不得被扩充');
  assert.deepStrictEqual(Domain.ALLOCATION_TARGET_STATUSES,
    ['current', 'no_target', 'no_assessment', 'stale_assessment', 'invalid_records']);
  assert.deepStrictEqual(Domain.ALLOCATION_MAPPING_ISSUE_CODES,
    ['instrument_missing', 'classification_unconfirmed', 'class_mismatch']);
  assert.strictEqual(CONTRACT.bpsTotal, 10000);
  assert.strictEqual(CONTRACT.ruleVersion, FIXTURE.ruleVersion);
  assert.strictEqual(CONTRACT.targetVersion, FIXTURE.targetVersion);
});

test('5C-15 范围守卫：5C 段落是纯函数（零时钟 / 零网络 / 零存储），且不触碰 5D/Phase 6 语义', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'domain.js'), 'utf8');
  const start = src.indexOf('目标配置与认可标的映射（Phase 5C');
  // 段落止于 5D 的开头（5D 的同类守卫在 tests/domain-phase5d.test.js，两段各管各的边界）
  const end = src.indexOf('新增资金优先再平衡与正式建议（Phase 5D');
  assert.ok(start > 0 && end > start, '找不到 Phase 5C 段落边界');
  const seg = src.slice(start, end);
  ['Date.now', 'new Date(', 'fetch(', 'require(', 'XMLHttpRequest', 'Math.random', 'process.env', 'localStorage']
    .forEach((frag) => {
      assert.strictEqual(seg.indexOf(frag), -1, 'Phase 5C 段落不得出现 ' + frag);
    });
  // 5C 只做目标与映射：不解析新增资金金额、不产生建议或决策状态
  // （5D 的同类守卫在 tests/domain-phase5d.test.js 的 5D-24，段落边界已按 5D 分开）
  ['newFundsMinor', 'categoryAllocations', 'decision_event', 'accepted'].forEach((frag) => {
    assert.strictEqual(seg.indexOf(frag), -1, 'Phase 5C 段落不得出现 ' + frag);
  });
});
