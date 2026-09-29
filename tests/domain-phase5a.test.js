/* Phase 5A｜风险问卷规则与配置契约领域测试（DECISIONS D-046）
 * 覆盖 5A 退出条件：
 *   - 题目 / 选项 / 分值 / 边界 / 硬封顶 / 目标模板 / 版本字段有唯一机器可读定义（fixture ↔ domain 逐字段一致）；
 *   - 高意愿不能突破低能力上限，硬封顶只降低上限、绝不提高；
 *   - 缺答、未知题目、未知选项、重复回答、非法比例一律 fail closed，且 detail 不回显输入原文；
 *   - 相同输入重复计算逐字段一致，且与答案排列顺序无关（不读系统时钟）；
 *   - 评估有效期三态边界（到期当天仍有效、次日过期）；
 *   - 范围守卫：零迁移、零新路由、零网络、零随机。
 * 本文件只测纯领域层：5A 不建表、不开接口、不改页面。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Domain = require('../js/domain.js');

const ROOT = path.join(__dirname, '..');
const FIXTURE = require('./fixtures/phase5-risk-rules.json');

/* ------------------- 构造答案的 helper（只依赖题库本身，不依赖实现内部状态） ------------------- */

function pickOption(q, score) {
  const hit = q.options.filter((o) => o.score === score)[0];
  if (!hit) throw new Error('题库缺少分值为 ' + score + ' 的选项：' + q.id);
  return hit.id;
}

// 把 total 拆成 n 个 0..3 的分数（每题分值域相同，因此任意 0..3n 都可构造）
function splitScore(total, n) {
  const out = [];
  let rest = total;
  for (let i = 0; i < n; i++) {
    const take = Math.min(3, Math.max(0, rest));
    out.push(take);
    rest -= take;
  }
  if (rest !== 0) throw new Error('分数超出该组题目的取值范围：' + total);
  return out;
}

function answersFor(capacityTotal, willingnessTotal, mutate) {
  const cap = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'capacity');
  const wil = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'willingness');
  const rows = [];
  splitScore(capacityTotal, cap.length).forEach((s, i) => rows.push({ questionId: cap[i].id, optionId: pickOption(cap[i], s) }));
  splitScore(willingnessTotal, wil.length).forEach((s, i) => rows.push({ questionId: wil[i].id, optionId: pickOption(wil[i], s) }));
  if (mutate) mutate(rows);
  return rows;
}

function setAnswer(rows, questionId, optionId) {
  rows.filter((r) => r.questionId === questionId)[0].optionId = optionId;
}

function stripScored(r) {
  return Object.assign({}, r, { scored: r.scored.slice().sort((a, b) => (a.questionId < b.questionId ? -1 : 1)) });
}

/* ------------------- 1. 规则定义的唯一性：fixture ↔ domain ------------------- */

test('5A-1 fixture 与 domain 的规则定义逐字段一致（改规则必须同时改 fixture）', () => {
  assert.strictEqual(FIXTURE.ruleVersion, Domain.RISK_RULE_VERSION);
  assert.strictEqual(FIXTURE.targetVersion, Domain.RISK_TARGET_VERSION);
  assert.strictEqual(FIXTURE.bpsTotal, Domain.BPS_TOTAL);
  assert.deepStrictEqual(FIXTURE.capacityDimensions, Domain.CAPACITY_DIMENSIONS);
  assert.deepStrictEqual(FIXTURE.willingnessDimensions, Domain.WILLINGNESS_DIMENSIONS);
  assert.deepStrictEqual(FIXTURE.questions, Domain.RISK_QUESTIONS);
  assert.deepStrictEqual(FIXTURE.capacityLevelBounds, Domain.CAPACITY_LEVEL_BOUNDS);
  assert.deepStrictEqual(FIXTURE.willingnessLevelBounds, Domain.WILLINGNESS_LEVEL_BOUNDS);
  assert.deepStrictEqual(FIXTURE.hardCaps, Domain.RISK_HARD_CAPS);
  assert.deepStrictEqual(FIXTURE.targetTemplates, Domain.TARGET_TEMPLATES);
  assert.deepStrictEqual(FIXTURE.toleranceBands, Domain.TOLERANCE_BANDS);
  assert.deepStrictEqual(FIXTURE.errorCodes, Domain.RISK_ERROR_CODES);
  assert.deepStrictEqual(FIXTURE.recommendationContract, Domain.recommendationContract());
  assert.strictEqual(FIXTURE.assessment.validDays, Domain.ASSESSMENT_VALID_DAYS);
  assert.strictEqual(FIXTURE.assessment.expiringDays, Domain.ASSESSMENT_EXPIRING_DAYS);
  assert.deepStrictEqual(FIXTURE.assessment.statuses, Domain.ASSESSMENT_STATUSES);
  assert.deepStrictEqual(FIXTURE.assessment.reassessReasons, Domain.REASSESS_REASONS);
});

test('5A-2 题库结构完整：题目与选项 id 稳定唯一、分值非负整数、维度不重不漏、解释键齐备', () => {
  const ids = new Set();
  const dims = { capacity: new Set(), willingness: new Set() };
  for (const q of Domain.RISK_QUESTIONS) {
    assert.strictEqual(ids.has(q.id), false, '题目 id 重复：' + q.id);
    ids.add(q.id);
    assert.ok(q.kind === 'capacity' || q.kind === 'willingness', '题目类别非法：' + q.id);
    assert.ok(typeof q.explainKey === 'string' && q.explainKey.length > 0, '缺解释键：' + q.id);
    assert.strictEqual(dims[q.kind].has(q.dimension), false, '维度重复：' + q.dimension);
    dims[q.kind].add(q.dimension);
    const optIds = new Set();
    for (const o of q.options) {
      assert.strictEqual(optIds.has(o.id), false, '选项 id 重复：' + q.id + '/' + o.id);
      optIds.add(o.id);
      assert.ok(typeof o.id === 'string' && o.id.length > 0, '选项 id 必须是非空字符串');
      assert.ok(Number.isInteger(o.score) && o.score >= 0, '分值必须是非负整数：' + q.id + '/' + o.id);
    }
    assert.ok(q.options.length >= 2, '每题至少两个选项：' + q.id);
    assert.ok(q.options.filter((o) => o.score === 0).length >= 1, '每题必须有最差档（硬封顶判定依据）');
  }
  assert.deepStrictEqual(Array.from(dims.capacity).sort(), Domain.CAPACITY_DIMENSIONS.slice().sort());
  assert.deepStrictEqual(Array.from(dims.willingness).sort(), Domain.WILLINGNESS_DIMENSIONS.slice().sort());
});

test('5A-3 等级边界单调递增、层级恰好覆盖 1–5、下界含入且最高级从 0 起', () => {
  [Domain.CAPACITY_LEVEL_BOUNDS, Domain.WILLINGNESS_LEVEL_BOUNDS].forEach((bounds) => {
    assert.deepStrictEqual(bounds.map((b) => b.level), Domain.RISK_LEVELS);
    assert.strictEqual(bounds[0].minScore, 0);
    for (let i = 1; i < bounds.length; i++) {
      assert.ok(bounds[i].minScore > bounds[i - 1].minScore, '边界必须严格递增');
      assert.ok(Number.isInteger(bounds[i].minScore));
    }
  });
});

/* ------------------- 2. 目标模板 ------------------- */

test('5A-4 目标模板：六类不重不漏、Σtarget 精确 100%、区间合法、个股 target 恒为 0', () => {
  assert.deepStrictEqual(Domain.TARGET_TEMPLATES.map((t) => t.level), Domain.RISK_LEVELS);
  for (const t of Domain.TARGET_TEMPLATES) {
    assert.strictEqual(t.templateVersion, Domain.RISK_TARGET_VERSION);
    assert.strictEqual(Domain.validateTargetTemplate(t).ok, true, '模板必须自校验通过：L' + t.level);
    assert.deepStrictEqual(Object.keys(t.classes).sort(), Domain.RISK_CLASSES.slice().sort());
    let targetSum = 0;
    let minSum = 0;
    let maxSum = 0;
    for (const c of Domain.RISK_CLASSES) {
      const r = t.classes[c];
      assert.ok(r.minBps <= r.targetBps && r.targetBps <= r.maxBps, 'min <= target <= max：L' + t.level + '/' + c);
      assert.ok(r.minBps >= 0 && r.maxBps <= Domain.BPS_TOTAL, '比例必须落在 0–100%：L' + t.level + '/' + c);
      targetSum += r.targetBps;
      minSum += r.minBps;
      maxSum += r.maxBps;
    }
    assert.strictEqual(targetSum, Domain.BPS_TOTAL, '各类 targetBps 合计必须精确为 100%');
    // Σmin <= 100% <= Σmax 由 min <= target <= max + Σtarget = 100% 推导成立，这里固化为不变量
    assert.ok(minSum <= Domain.BPS_TOTAL && maxSum >= Domain.BPS_TOTAL);
    // D-018：不做具体股票购买建议 —— 个股只有容忍上限，没有目标配置
    assert.strictEqual(t.classes.stock.targetBps, 0, '个股 target 必须为 0');
  }
  // 风险越高，宽基权益目标越高、现金目标越低（模板单调性，防止模板被改乱）
  const broad = Domain.TARGET_TEMPLATES.map((t) => t.classes.broad_equity.targetBps);
  const cash = Domain.TARGET_TEMPLATES.map((t) => t.classes.cash.targetBps);
  for (let i = 1; i < broad.length; i++) assert.ok(broad[i] > broad[i - 1], '宽基权益目标必须随风险等级单调上升');
  for (let i = 1; i < cash.length; i++) assert.ok(cash[i] < cash[i - 1], '现金目标必须随风险等级单调下降');
});

test('5A-5 非法模板 fail closed：缺类别 / min>target / 合计非 100% / 负数 / 超 100% / 非整数', () => {
  const base = () => JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
  const cases = [];
  const t1 = base(); delete t1.classes.fixed_income; cases.push([t1, 'invalid_target_template']);
  const t2 = base(); t2.classes.cash = { minBps: 3000, targetBps: 2000, maxBps: 3500 }; cases.push([t2, 'invalid_proportion']);
  const t3 = base(); t3.classes.other.targetBps = 900; cases.push([t3, 'invalid_proportion']);
  const t4 = base(); t4.classes.cash.targetBps = 1000; cases.push([t4, 'invalid_proportion']);
  const t5 = base(); t5.classes.cash.minBps = -1; cases.push([t5, 'invalid_proportion']);
  const t6 = base(); t6.classes.cash.maxBps = 10001; cases.push([t6, 'invalid_proportion']);
  const t7 = base(); t7.classes.cash.targetBps = 1500.5; cases.push([t7, 'invalid_proportion']);
  const t8 = base(); t8.classes.cash.targetBps = '1500'; cases.push([t8, 'invalid_proportion']);
  cases.forEach(([tpl, code]) => {
    const r = Domain.validateTargetTemplate(tpl);
    assert.strictEqual(r.ok, false, '必须拒绝非法模板：' + code);
    assert.strictEqual(r.error.code, code);
  });
  assert.strictEqual(Domain.validateTargetTemplate(null).error.code, 'invalid_target_template');
  assert.strictEqual(Domain.validateTargetTemplate({ level: 1 }).error.code, 'invalid_target_template');
  // 非法模板不得被"就近修正"，等级查表只认合法模板
  assert.strictEqual(Domain.targetTemplateForLevel(9), null);
  assert.strictEqual(Domain.targetTemplateForLevel('3'), null);
});

test('5A-6 目标模板查表返回副本，调用方改动不污染规则常量', () => {
  const t = Domain.targetTemplateForLevel(3);
  t.classes.cash.targetBps = 9999;
  assert.notStrictEqual(Domain.TARGET_TEMPLATES[2].classes.cash.targetBps, 9999);
  assert.strictEqual(Domain.TARGET_TEMPLATES[2].classes.cash.targetBps, 2000);
});

/* ------------------- 3. 双评分、边界与硬封顶 ------------------- */

test('5A-7 双评分与等级：0 分、满分与阶梯边界逐点（下界含入）', () => {
  const CAP_CASES = [[0, 1], [3, 1], [4, 2], [6, 2], [7, 3], [9, 3], [10, 4], [12, 4], [13, 5], [15, 5]];
  const WIL_CASES = [[0, 1], [2, 1], [3, 2], [5, 2], [6, 3], [8, 3], [9, 4], [10, 4], [11, 5], [12, 5]];
  for (const [score, level] of CAP_CASES) {
    const r = Domain.scoreRiskAnswers(answersFor(score, 12));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.capacityScore, score);
    assert.strictEqual(r.capacityLevel, level, '能力 ' + score + ' 分应归入 L' + level);
  }
  for (const [score, level] of WIL_CASES) {
    const r = Domain.scoreRiskAnswers(answersFor(15, score));
    assert.strictEqual(r.willingnessScore, score);
    assert.strictEqual(r.willingnessLevel, level, '意愿 ' + score + ' 分应归入 L' + level);
  }
  const zero = Domain.scoreRiskAnswers(answersFor(0, 0));
  assert.strictEqual(zero.capacityScore, 0);
  assert.strictEqual(zero.willingnessScore, 0);
  assert.strictEqual(zero.capacityLevel, 1);
  assert.strictEqual(zero.willingnessLevel, 1);
  assert.strictEqual(zero.ceiling, 1);
  const full = Domain.scoreRiskAnswers(answersFor(15, 12));
  assert.strictEqual(full.capacityLevel, 5);
  assert.strictEqual(full.willingnessLevel, 5);
  assert.strictEqual(full.ceiling, 5);
  assert.strictEqual(full.ceilingSource, 'equal');
  assert.deepStrictEqual(full.hardCaps, []);
});

test('5A-8 S5.1 高意愿不能突破低能力上限，硬封顶逐条列出（fixture 样例）', () => {
  const r = Domain.scoreRiskAnswers(FIXTURE.samples.S5_1.answers);
  const e = FIXTURE.samples.S5_1.expect;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.capacityScore, e.capacityScore);
  assert.strictEqual(r.willingnessScore, e.willingnessScore);
  assert.strictEqual(r.capacityLevel, e.capacityLevel);
  assert.strictEqual(r.willingnessLevel, e.willingnessLevel);
  assert.strictEqual(r.ceiling, e.ceiling);
  assert.strictEqual(r.ceilingSource, e.ceilingSource);
  assert.deepStrictEqual(r.hardCaps.map((c) => c.code), e.hardCaps);
  assert.ok(r.ceiling < r.willingnessLevel, '高意愿不得抬高上限');
  assert.ok(r.explainCodes.indexOf('card-lower-bound-rule') !== -1);
});

test('5A-9 硬封顶只降低上限、绝不被高分抵消，多个短板同时命中全部列出', () => {
  const r1 = Domain.scoreRiskAnswers(answersFor(15, 12, (rows) => setAnswer(rows, 'q_emergency_fund', 'o_cover_under_3m')));
  assert.strictEqual(r1.capacityLevel, 4, '扣掉应急金后能力仍高于硬封顶');
  assert.strictEqual(r1.willingnessLevel, 5);
  assert.strictEqual(r1.ceiling, 2, '硬封顶把上限压到 2');
  assert.strictEqual(r1.ceilingSource, 'hard_cap');
  assert.deepStrictEqual(r1.hardCaps.map((c) => c.code), ['hard_cap_emergency_fund']);

  const r2 = Domain.scoreRiskAnswers(answersFor(0, 0));
  assert.deepStrictEqual(r2.hardCaps.map((c) => c.code), [
    'hard_cap_emergency_fund', 'hard_cap_income_stability', 'hard_cap_liquidity_need', 'hard_cap_debt_pressure'
  ]);
  assert.strictEqual(r2.ceiling, 1, '硬封顶 maxLevel=2 不得把 L1 抬高到 2');
  assert.strictEqual(r2.ceilingSource, 'equal');
});

test('5A-10 缺答 / 未知题目 / 未知选项 / 重复回答一律 fail closed，detail 不回显输入原文', () => {
  const good = answersFor(9, 9);
  assert.strictEqual(Domain.validateRiskAnswers(good.slice(1)).error.code, 'missing_answer');
  assert.strictEqual(Domain.validateRiskAnswers([]).error.code, 'missing_answer');

  const unkQ = good.slice();
  unkQ[0] = { questionId: 'q_unknown_question', optionId: 'o_x' };
  assert.strictEqual(Domain.validateRiskAnswers(unkQ).error.code, 'unknown_question');

  const payload = '<script>alert(1)</script>';
  const unkO = good.slice();
  unkO[0] = { questionId: good[0].questionId, optionId: payload };
  const badOpt = Domain.validateRiskAnswers(unkO);
  assert.strictEqual(badOpt.error.code, 'unknown_option');
  assert.strictEqual(badOpt.error.detail.indexOf(payload), -1, 'detail 不得回显输入原文');

  const dup = good.concat([{ questionId: good[0].questionId, optionId: good[0].optionId }]);
  assert.strictEqual(Domain.validateRiskAnswers(dup).error.code, 'duplicate_answer');

  assert.strictEqual(Domain.validateRiskAnswers(null).error.code, 'invalid_answers');
  assert.strictEqual(Domain.validateRiskAnswers('answers').error.code, 'invalid_answers');
  assert.strictEqual(Domain.validateRiskAnswers([null]).error.code, 'invalid_answers');
  assert.strictEqual(Domain.validateRiskAnswers([{ optionId: 'o_no_debt' }]).error.code, 'invalid_answers');
  assert.strictEqual(Domain.validateRiskAnswers([{ questionId: 'q_debt_pressure' }]).error.code, 'invalid_answers');
  assert.strictEqual(Domain.validateRiskAnswers([{ questionId: '', optionId: '' }]).error.code, 'invalid_answers');
  // 评分入口与校验入口同一道闸
  assert.strictEqual(Domain.scoreRiskAnswers(good.slice(1)).ok, false);
  assert.ok(Domain.RISK_ERROR_CODES.indexOf('unknown_option') !== -1);
});

test('5A-11 相同输入重复计算逐字段一致，且与答案排列顺序无关、不修改调用方数组', () => {
  const a = answersFor(7, 9, (rows) => setAnswer(rows, 'q_emergency_fund', 'o_cover_under_3m'));
  const snapshot = JSON.parse(JSON.stringify(a));
  const first = Domain.scoreRiskAnswers(a);
  assert.deepStrictEqual(a, snapshot, '不得修改调用方传入的答案');
  const second = Domain.scoreRiskAnswers(a.slice().reverse());
  assert.deepStrictEqual(stripScored(second), stripScored(first), '结果不得依赖答案排列顺序');
});

/* ------------------- 4. 复评有效性 ------------------- */

test('5A-12 有效期三态：到期当天仍有效、次日过期、剩余 <= 30 天为即将到期', () => {
  assert.deepStrictEqual(Domain.assessmentValidity('2026-01-01', '2026-01-01'), {
    ok: true, assessedAt: '2026-01-01', now: '2026-01-01', expiry: '2027-01-01', remainingDays: 365, status: 'valid'
  });
  assert.strictEqual(Domain.assessmentValidity('2026-01-01', '2026-12-01').status, 'valid');
  assert.strictEqual(Domain.assessmentValidity('2026-01-01', '2026-12-01').remainingDays, 31);
  assert.strictEqual(Domain.assessmentValidity('2026-01-01', '2026-12-02').status, 'expiring_soon');
  assert.strictEqual(Domain.assessmentValidity('2026-01-01', '2026-12-02').remainingDays, 30);
  assert.strictEqual(Domain.assessmentValidity('2026-01-01', '2027-01-01').status, 'expiring_soon', '到期日当天仍有效');
  assert.strictEqual(Domain.assessmentValidity('2026-01-01', '2027-01-01').remainingDays, 0);
  assert.strictEqual(Domain.assessmentValidity('2026-01-01', '2027-01-02').status, 'expired');
  assert.strictEqual(Domain.assessmentValidity('2026-01-01', '2027-01-02').remainingDays, -1);
  // 闰年起算：2024-02-29 + 365 天 = 2025-02-28
  assert.strictEqual(Domain.assessmentValidity('2024-02-29', '2025-02-28').expiry, '2025-02-28');
  assert.deepStrictEqual(Domain.ASSESSMENT_STATUSES, ['valid', 'expiring_soon', 'expired']);
});

test('5A-13 非法日期 fail closed（含伪日历日），日期工具不依赖系统时钟', () => {
  ['2026-02-30', '2026-13-01', '2026-00-10', '2026-9-19', '20260919', '2026-09-19T00:00:00Z', '', null, 20260919].forEach((bad) => {
    const r = Domain.assessmentValidity(bad, '2026-09-19');
    assert.strictEqual(r.ok, false, '非法评估日期必须拒绝：' + String(bad));
    assert.strictEqual(r.error.code, 'invalid_assessment_date');
  });
  assert.strictEqual(Domain.assessmentValidity('2026-09-19', '2026-02-30').error.code, 'invalid_assessment_date');
  assert.strictEqual(Domain.isCalendarDate('2024-02-29'), true);
  assert.strictEqual(Domain.isCalendarDate('2023-02-29'), false);
  assert.strictEqual(Domain.isCalendarDate('2100-02-29'), false, '世纪年非闰');
  assert.strictEqual(Domain.isCalendarDate('2000-02-29'), true, '400 年闰');
  assert.strictEqual(Domain.addCalendarDays('2026-09-19', 365), '2027-09-19');
  assert.strictEqual(Domain.addCalendarDays('2026-09-19', 1), '2026-09-20');
  assert.strictEqual(Domain.addCalendarDays('2026-09-19', -1), '2026-09-18');
  assert.strictEqual(Domain.addCalendarDays('2026-02-30', 1), null);
  assert.strictEqual(Domain.addCalendarDays('2026-09-19', 1.5), null);
});

test('5A-14 复评原因词表冻结：市场涨跌不在其中，未知原因拒绝', () => {
  for (const r of FIXTURE.assessment.reassessReasons) assert.strictEqual(Domain.isReassessReason(r), true, r);
  ['market_move', 'market_drop', 'price_change', 'annual', '', null].forEach((bad) => {
    assert.strictEqual(Domain.isReassessReason(bad), false, '市场涨跌不得触发复评：' + String(bad));
  });
  assert.ok(Domain.REASSESS_REASONS.indexOf('income_change') !== -1);
  assert.ok(Domain.REASSESS_REASONS.indexOf('overseas_status_change') !== -1);
  assert.ok(Domain.REASSESS_REASONS.indexOf('liquidity_change') !== -1);
  assert.ok(Domain.REASSESS_REASONS.indexOf('major_goal_change') !== -1);
  assert.ok(Domain.REASSESS_REASONS.indexOf('annual_expired') !== -1);
});

/* ------------------- 5. 建议输入 / 输出契约 ------------------- */

function sampleRequest() {
  return {
    snapshotRef: { closeId: 'close-1', snapshotId: 'snap-1', payloadHash: 'a'.repeat(64) },
    assessmentRef: { id: 'ra-1', ruleVersion: Domain.RISK_RULE_VERSION },
    targetVersion: Domain.RISK_TARGET_VERSION,
    ruleVersion: Domain.RISK_RULE_VERSION,
    newFundsMinor: 200000,
    approvedInstruments: { broad_equity: ['ins-voo'] }
  };
}

test('5A-15 建议输入契约只认引用与用户判断，缺引用 / 版本错配 / 非法金额一律拒绝', () => {
  const req = sampleRequest();
  const ok = Domain.validateRecommendationRequest(req);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.approvedInstruments, { broad_equity: ['ins-voo'] });

  const cases = [
    [Object.assign({}, req, { snapshotRef: Object.assign({}, req.snapshotRef, { payloadHash: 'zz' }) }), 'invalid_snapshot_ref'],
    [Object.assign({}, req, { snapshotRef: Object.assign({}, req.snapshotRef, { closeId: '' }) }), 'invalid_snapshot_ref'],
    [Object.assign({}, req, { snapshotRef: null }), 'invalid_snapshot_ref'],
    [Object.assign({}, req, { assessmentRef: { id: 'ra-1', ruleVersion: 'risk-rules-v0' } }), 'invalid_rule_version'],
    [Object.assign({}, req, { assessmentRef: { id: '', ruleVersion: Domain.RISK_RULE_VERSION } }), 'invalid_assessment_ref'],
    [Object.assign({}, req, { ruleVersion: 'risk-rules-v2' }), 'invalid_rule_version'],
    [Object.assign({}, req, { targetVersion: '' }), 'invalid_target_template'],
    [Object.assign({}, req, { newFundsMinor: -1 }), 'invalid_new_funds'],
    [Object.assign({}, req, { newFundsMinor: 100.5 }), 'invalid_new_funds'],
    [Object.assign({}, req, { newFundsMinor: '200000' }), 'invalid_new_funds'],
    [Object.assign({}, req, { approvedInstruments: { unknown_class: ['ins-voo'] } }), 'invalid_approved_instruments'],
    [Object.assign({}, req, { approvedInstruments: { broad_equity: 'ins-voo' } }), 'invalid_approved_instruments'],
    [Object.assign({}, req, { approvedInstruments: { broad_equity: [''] } }), 'invalid_approved_instruments'],
    [Object.assign({}, req, { approvedInstruments: { broad_equity: [null] } }), 'invalid_approved_instruments']
  ];
  for (const [payload, code] of cases) {
    const r = Domain.validateRecommendationRequest(payload);
    assert.strictEqual(r.ok, false, '必须拒绝：' + code);
    assert.strictEqual(r.error.code, code);
  }
  assert.strictEqual(Domain.validateRecommendationRequest(null).ok, false);
  assert.strictEqual(Domain.validateRecommendationRequest([]).ok, false);
  // 无认可映射是合法状态：类别偏离照常，只是不给具体证券映射
  const noMap = Domain.validateRecommendationRequest(Object.assign({}, req, { approvedInstruments: undefined }));
  assert.strictEqual(noMap.ok, true);
  assert.deepStrictEqual(noMap.approvedInstruments, {});
  // 0 元新增资金是合法输入（5D 负责给出明确结果）
  assert.strictEqual(Domain.validateRecommendationRequest(Object.assign({}, req, { newFundsMinor: 0 })).ok, true);
});

test('5A-16 输出契约与排序 / 尾差规则冻结：类别恒按资产类别序，不依赖对象或数据库行序', () => {
  const c = Domain.recommendationContract();
  assert.deepStrictEqual(c.inputKeys, Domain.RECOMMENDATION_INPUT_KEYS);
  assert.deepStrictEqual(c.outputKeys, Domain.RECOMMENDATION_OUTPUT_KEYS);
  assert.deepStrictEqual(c.statuses, ['formal', 'estimate']);
  assert.deepStrictEqual(c.allocationOrder, Domain.RISK_CLASSES);
  assert.strictEqual(c.roundingRule, Domain.ALLOCATION_ROUNDING_RULE);
  assert.ok(Domain.ALLOCATION_ROUNDING_RULE.indexOf('排列顺序') !== -1);
  assert.strictEqual(c.bpsTotal, Domain.BPS_TOTAL);
  assert.strictEqual(c.ruleVersion, Domain.RISK_RULE_VERSION);
  assert.strictEqual(c.targetVersion, Domain.RISK_TARGET_VERSION);
  ['status', 'blockers', 'dataCutoff', 'currentAllocation', 'targetRanges', 'roundingNote', 'explainCodes', 'versions'].forEach((k) => {
    assert.ok(c.outputKeys.indexOf(k) !== -1, '输出契约缺字段：' + k);
  });
  ['snapshotRef', 'assessmentRef', 'targetVersion', 'ruleVersion', 'newFundsMinor', 'approvedInstruments'].forEach((k) => {
    assert.ok(c.inputKeys.indexOf(k) !== -1, '输入契约缺字段：' + k);
  });
  // 规则目录只读副本：调用方改动不污染常量
  const cat = Domain.riskCatalog();
  cat.questions[0].options[0].score = 99;
  assert.notStrictEqual(Domain.RISK_QUESTIONS[0].options[0].score, 99);
});

test('5A-17 容忍带端点含入区间，边界归属唯一', () => {
  assert.strictEqual(Domain.compareToRange(1500, 1500, 3500), 'within');
  assert.strictEqual(Domain.compareToRange(3500, 1500, 3500), 'within');
  assert.strictEqual(Domain.compareToRange(2500, 1500, 3500), 'within');
  assert.strictEqual(Domain.compareToRange(1499, 1500, 3500), 'below_min');
  assert.strictEqual(Domain.compareToRange(3501, 1500, 3500), 'above_max');
  assert.strictEqual(Domain.compareToRange(0, 0, 0), 'within');
  assert.strictEqual(Domain.compareToRange(0, 0, 10000), 'within');
  assert.strictEqual(Domain.compareToRange('1500', 1500, 3500), null);
  assert.strictEqual(Domain.compareToRange(1500, 3500, 1500), null);
  assert.deepStrictEqual(Domain.TOLERANCE_BANDS, ['below_min', 'within', 'above_max']);
});

/* ------------------- 6. 范围守卫（5A 零迁移；5B 只允许按冻结语义交付评估持久化） ------------------- */

test('5A-18 范围守卫：5A 段落纯函数零时钟 / 零网络，5B/5C 边界只放开冻结交付物', () => {
  const M = require('../server/migrations.js');
  // 5A 自身零迁移；5B 交付 v8（risk_assessments）、5C 交付 v9（目标版本与认可标的）、
  // 5D 交付 v10（recommendations 建议产物）。6B 按 6A 冻结契约（D-057）交付 v11
  // （decisions / decision_events / decision_links 三表，迁移名 phase6-decisions）——
  // 更新说明：原断言「Phase 6 的表不得预建」随 6B 实施显式推进，改为断言 v11 恰为该三表迁移；
  // 除 phase6-decisions 外仍不得出现其他决策表迁移（契约 §11：只移动边界，不删断言）。
  assert.strictEqual(M.LATEST_VERSION, 11, '迁移推进到 6B 的 v11');
  assert.strictEqual(M.MIGRATIONS[M.MIGRATIONS.length - 1].name, 'phase6-decisions');
  const decisionMigrations = M.MIGRATIONS.filter((m) => /decisions|decision_events|decision_links/.test(m.name));
  assert.strictEqual(decisionMigrations.length, 1, '决策表只允许由 v11 一并交付');
  assert.strictEqual(decisionMigrations[0].version, 11);

  const apiSrc = fs.readFileSync(path.join(ROOT, 'server/api.js'), 'utf8');
  // 5A 期间这里是 DEFERRED_WRITES 延后登记；5B 已实现为真实路由（测试见 tests/server-phase5b.test.js）
  assert.ok(!/'POST \/api\/v1\/risk-assessments': 'Phase 5'/.test(apiSrc), '延后登记应已被真实路由取代');
  assert.ok(apiSrc.includes("api['POST /api/v1/risk-assessments']"), '5B 必须实现写入路由');
  assert.ok(apiSrc.includes("api['POST /api/v1/targets']"), '5C 必须实现目标版本写入路由');
  assert.ok(apiSrc.includes("api['POST /api/v1/approved-instruments']"), '5C 必须实现认可标的写入路由');
  assert.ok(apiSrc.includes("api['POST /api/v1/recommendations']"), '5D 必须实现建议写入口');
  assert.ok(!/'POST \/api\/v1\/recommendations': 'Phase 5'/.test(apiSrc), '延后登记应已被真实路由取代');

  const domSrc = fs.readFileSync(path.join(ROOT, 'js/domain.js'), 'utf8');
  const start = domSrc.indexOf('风险问卷规则与配置契约（Phase 5A');
  // 段落止于 5A 的最后一段（recommendationContract 之后）；5B / 5C 的函数在守卫范围之外单独验收
  const end = domSrc.indexOf('风险评估记录与复评机制（Phase 5B');
  assert.ok(start > 0 && end > start, '找不到 Phase 5A 段落边界');
  const seg = domSrc.slice(start, end);
  ['Date.now', 'new Date()', 'fetch(', 'require(', 'XMLHttpRequest', 'Math.random', 'process.env'].forEach((frag) => {
    assert.strictEqual(seg.indexOf(frag), -1, 'Phase 5A 段落不得出现 ' + frag);
  });
});

/* ------------------- 7. 第二轮复核补口反例（G5A-1 / G5A-2 / G5A-3，2026-09-19） -------------------
 * 上一轮 504/504 全绿却没通过验收，缺的不是主路径断言，而是**反向**断言：
 * 「不许发生的事能不能真的不发生」。下面每一条对应 PHASE5A_ACCEPTANCE_GAPS.md 的一个修复门槛，
 * 把实现退回旧版即会变红。
 */

// 冻结对象上的写入在严格模式抛 TypeError、非严格模式静默失败，两种都算「拒绝修改」。
function tryMutate(fn) {
  try { fn(); return 'silent'; } catch (e) { return 'threw'; }
}

test('5A-19 G5A-1 反例：原地修改对外规则对象不得改变评分，规则内容与版本必须同时不变', () => {
  const answers = Domain.RISK_QUESTIONS.map((q) => ({ questionId: q.id, optionId: q.options[0].id }));
  const before = Domain.scoreRiskAnswers(answers);
  const tplBefore = Domain.targetTemplateForLevel(3);
  const catBefore = Domain.riskCatalog();
  const contractBefore = Domain.recommendationContract();
  assert.strictEqual(before.capacityScore, 15, '前置：每题都选最优档 = 满分 15');

  // 复现原文：改第二层的选项分值（只冻第一层就挡不住这一条）
  const attempts = [
    ['选项分值（复现原文）', () => { Domain.RISK_QUESTIONS[0].options[0].score = 0; }],
    ['题目 id', () => { Domain.RISK_QUESTIONS[0].id = 'q_hacked'; }],
    ['题目维度', () => { Domain.RISK_QUESTIONS[0].dimension = 'hacked'; }],
    ['题库增删（push）', () => { Domain.RISK_QUESTIONS.push({ id: 'q_extra', kind: 'capacity', dimension: 'x', explainKey: 'x', options: [] }); }],
    ['题库增删（delete）', () => { delete Domain.RISK_QUESTIONS[0]; }],
    ['选项数组 push', () => { Domain.RISK_QUESTIONS[1].options.push({ id: 'o_extra', score: 3 }); }],
    ['能力等级边界', () => { Domain.CAPACITY_LEVEL_BOUNDS[1].minScore = 0; }],
    ['意愿等级边界', () => { Domain.WILLINGNESS_LEVEL_BOUNDS[0].minScore = 12; }],
    ['硬封顶等级', () => { Domain.RISK_HARD_CAPS[0].maxLevel = 5; }],
    ['硬封顶题目 id', () => { Domain.RISK_HARD_CAPS[0].questionId = 'q_horizon'; }],
    ['目标模板比例', () => { Domain.TARGET_TEMPLATES[2].classes.cash.targetBps = 9999; }],
    ['目标模板增类别', () => { Domain.TARGET_TEMPLATES[0].classes.crypto = { minBps: 0, targetBps: 0, maxBps: 0 }; }],
    ['目标模板删类别', () => { delete Domain.TARGET_TEMPLATES[2].classes.stock; }],
    ['资产类别词表', () => { Domain.RISK_CLASSES.push('crypto'); }],
    ['错误码词表', () => { Domain.RISK_ERROR_CODES.push('fake_code'); }],
    ['复评原因词表', () => { Domain.REASSESS_REASONS.push('market_move'); }]
  ];
  // 说明：`ASSESSMENT_VALID_DAYS` / `RISK_RULE_VERSION` 是常量**值**，Object.freeze 对它不适用；
  // 而且给对外属性整体赋值本来就只影响调用方自己的视图，不影响内部逻辑（不变量 10 的守护点是
  // 「内部逻辑不消费调用方可改的引用」）。这一类单独放在下面的 try/finally 里验证并保证复原。
  attempts.forEach(([name, fn]) => {
    const mode = tryMutate(fn);
    assert.ok(mode === 'threw' || mode === 'silent', '修改尝试只允许被拒绝：' + name);
  });

  // 结果不变（这才是缺口真正要挡的：同版本、同答案 → 同结果）
  const after = Domain.scoreRiskAnswers(answers);
  assert.deepStrictEqual(after, before, '对外规则对象被改后评分必须完全不变');
  assert.strictEqual(after.capacityScore, 15, '15 分不得变成 12 分');
  assert.strictEqual(after.ruleVersion, 'risk-rules-v1');
  assert.deepStrictEqual(Domain.targetTemplateForLevel(3), tplBefore, '模板查表必须完全不变');
  assert.deepStrictEqual(Domain.riskCatalog(), catBefore, '规则目录必须完全不变');
  assert.deepStrictEqual(Domain.recommendationContract(), contractBefore, '契约快照必须完全不变');
  assert.strictEqual(Domain.validateTargetTemplate(tplBefore).ok, true, '内置模板仍须自校验通过');

  // 「内容已变而版本保持原值」在这里结构性地不可能：内容必须仍与 fixture 冻结副本逐字段一致
  assert.deepStrictEqual(Domain.RISK_QUESTIONS, FIXTURE.questions);
  assert.deepStrictEqual(Domain.TARGET_TEMPLATES, FIXTURE.targetTemplates);
  assert.deepStrictEqual(Domain.CAPACITY_LEVEL_BOUNDS, FIXTURE.capacityLevelBounds);
  assert.deepStrictEqual(Domain.WILLINGNESS_LEVEL_BOUNDS, FIXTURE.willingnessLevelBounds);
  assert.deepStrictEqual(Domain.RISK_HARD_CAPS, FIXTURE.hardCaps);
  assert.deepStrictEqual(Domain.RISK_ERROR_CODES, FIXTURE.errorCodes);
  assert.deepStrictEqual(Domain.REASSESS_REASONS, FIXTURE.assessment.reassessReasons);
  // 版本字段：只看内部逻辑读到的值（对外属性属于调用方自己的视图，下面单独验证）
  assert.strictEqual(Domain.riskCatalog().ruleVersion, FIXTURE.ruleVersion);
  assert.strictEqual(Domain.riskCatalog().targetVersion, FIXTURE.targetVersion);
  assert.strictEqual(after.ruleVersion, FIXTURE.ruleVersion);

  // 深层冻结：逐层检查，不只第一层（复现原文改的正是第二层）
  [
    Domain.RISK_QUESTIONS, Domain.RISK_QUESTIONS[0], Domain.RISK_QUESTIONS[0].options, Domain.RISK_QUESTIONS[0].options[0],
    Domain.CAPACITY_LEVEL_BOUNDS, Domain.CAPACITY_LEVEL_BOUNDS[1], Domain.WILLINGNESS_LEVEL_BOUNDS[4],
    Domain.RISK_HARD_CAPS, Domain.RISK_HARD_CAPS[0],
    Domain.TARGET_TEMPLATES, Domain.TARGET_TEMPLATES[2], Domain.TARGET_TEMPLATES[2].classes, Domain.TARGET_TEMPLATES[2].classes.cash,
    Domain.RISK_CLASSES, Domain.RISK_LEVELS, Domain.RISK_ERROR_CODES, Domain.REASSESS_REASONS,
    Domain.TOLERANCE_BANDS, Domain.ASSESSMENT_STATUSES, Domain.CAPACITY_DIMENSIONS, Domain.WILLINGNESS_DIMENSIONS,
    Domain.RECOMMENDATION_INPUT_KEYS
  ].forEach((o) => assert.strictEqual(Object.isFrozen(o), true, '规则对象必须冻结：' + JSON.stringify(o).slice(0, 40)));

  // 内部逻辑不得消费调用方可改的引用：连对外键整体换掉也不得影响结果。
  // 用 try/finally 保证**无论断言成败都复原**对外键（否则会污染同进程后续用例）。
  const saved = {
    RISK_QUESTIONS: Domain.RISK_QUESTIONS, TARGET_TEMPLATES: Domain.TARGET_TEMPLATES,
    CAPACITY_LEVEL_BOUNDS: Domain.CAPACITY_LEVEL_BOUNDS, RISK_HARD_CAPS: Domain.RISK_HARD_CAPS,
    RISK_ERROR_CODES: Domain.RISK_ERROR_CODES, RISK_RULE_VERSION: Domain.RISK_RULE_VERSION,
    RISK_TARGET_VERSION: Domain.RISK_TARGET_VERSION, ASSESSMENT_VALID_DAYS: Domain.ASSESSMENT_VALID_DAYS
  };
  try {
    tryMutate(() => {
      Object.keys(saved).forEach((k) => { Domain[k] = Array.isArray(saved[k]) ? [] : (typeof saved[k] === 'string' ? 'hacked-version' : 1); });
    });
    assert.deepStrictEqual(Domain.scoreRiskAnswers(answers), before, '换掉对外键不得影响评分');
    assert.deepStrictEqual(Domain.targetTemplateForLevel(3), tplBefore, '换掉对外键不得影响模板查表');
    assert.strictEqual(Domain.validateTargetTemplate(tplBefore).ok, true, '换掉对外键不得影响模板校验');
    assert.strictEqual(Domain.assessmentValidity('2026-01-01', '2026-06-01').expiry, '2027-01-01', '换掉对外键不得影响有效期');
    // 契约校验用 fixture 里的版本值构造请求：内部版本不会因为对外属性被换掉而改变
    assert.strictEqual(Domain.validateRecommendationRequest({
      snapshotRef: { closeId: 'close-1', snapshotId: 'snap-1', payloadHash: 'a'.repeat(64) },
      assessmentRef: { id: 'ra-1', ruleVersion: FIXTURE.ruleVersion },
      targetVersion: FIXTURE.targetVersion,
      ruleVersion: FIXTURE.ruleVersion,
      newFundsMinor: 200000,
      approvedInstruments: {}
    }).ok, true, '换掉对外键不得影响契约校验');
  } finally {
    tryMutate(() => { Object.keys(saved).forEach((k) => { Domain[k] = saved[k]; }); });
  }
  Object.keys(saved).forEach((k) => {
    assert.deepStrictEqual(Domain[k], saved[k], '本用例必须收尾复原对外键：' + k);
  });
  assert.deepStrictEqual(Domain.RISK_QUESTIONS, FIXTURE.questions, '复原后仍须等于冻结副本');
});

test('5A-20 G5A-2 反例：未知 / 空 / 错配 targetVersion 一律 fail closed', () => {
  const req = sampleRequest();
  assert.strictEqual(Domain.validateRecommendationRequest(req).ok, true, '前置：合法请求仍须通过');

  const bad = [
    'risk-targets-unknown', 'risk-targets-v2', 'risk-targets-v0', 'risk-targets-v1 ',
    ' risk-targets-v1', 'Risk-Targets-V1', 'risk-targets-v1.0', 'risk-targets',
    Domain.RISK_RULE_VERSION,                    // 交叉错配：拿规则版本当目标版本
    '', '   ', null, true, 1, [], {}, undefined
  ];
  bad.forEach((v) => {
    const r = Domain.validateRecommendationRequest(Object.assign({}, req, { targetVersion: v }));
    assert.strictEqual(r.ok, false, '未知目标版本必须拒绝：' + JSON.stringify(v));
    assert.strictEqual(r.error.code, 'invalid_target_template');
  });

  // 规则版本与目标版本不得互换（两个字段各自只认自己的版本）
  const swapped = Object.assign({}, req, { targetVersion: Domain.RISK_RULE_VERSION, ruleVersion: Domain.RISK_TARGET_VERSION });
  const sr = Domain.validateRecommendationRequest(swapped);
  assert.strictEqual(sr.ok, false);
  assert.strictEqual(sr.error.code, 'invalid_rule_version');

  // 合法组合：唯一可用目标版本 + 当前规则版本
  const good = Domain.validateRecommendationRequest(Object.assign({}, req, { targetVersion: Domain.RISK_TARGET_VERSION }));
  assert.strictEqual(good.ok, true);
  assert.strictEqual(Domain.RISK_TARGET_VERSION, FIXTURE.targetVersion, '目标版本必须与冻结副本一致');

  // detail 不回显输入原文
  const payload = '<script>alert(1)</script>';
  const echoed = Domain.validateRecommendationRequest(Object.assign({}, req, { targetVersion: payload }));
  assert.strictEqual(echoed.ok, false);
  assert.strictEqual(echoed.error.detail.indexOf(payload), -1, 'detail 不得回显输入原文');
});

test('5A-21 G5A-3 反例：模板额外类别（含不可枚举键 / 原型链 / 异常形状）一律 fail closed', () => {
  const base = () => JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));

  // 1) 额外类别：比例本身"合法"也不得被静默忽略（复现原文）
  const c1 = base();
  c1.classes.crypto = { minBps: 0, targetBps: 0, maxBps: 10000 };
  assert.strictEqual(Domain.validateTargetTemplate(c1).error.code, 'invalid_target_template');

  // 2) 不可枚举的额外类别：defineProperty 藏起来的键同样要拦（Object.keys 看不到，必须用 getOwnPropertyNames）
  const c2 = base();
  Object.defineProperty(c2.classes, 'gold', { value: { minBps: 0, targetBps: 0, maxBps: 0 }, enumerable: false });
  assert.strictEqual(Domain.validateTargetTemplate(c2).error.code, 'invalid_target_template');

  // 3) 原型链上的额外类别：六类自有 + 原型挂 crypto
  const c3 = base();
  c3.classes = Object.assign(Object.create({ crypto: { minBps: 0, targetBps: 0, maxBps: 0 } }), c3.classes);
  assert.strictEqual(Domain.validateTargetTemplate(c3).error.code, 'invalid_target_template');

  // 4) 六类全部来自原型链：不是自有属性 → 与冻结词表不精确相等
  const c4 = base();
  c4.classes = Object.create(c4.classes);
  assert.strictEqual(Domain.validateTargetTemplate(c4).error.code, 'invalid_target_template');

  // 5) JSON 文本里写 "__proto__" 键（JSON.parse 会把它建成自有键）
  const c5 = base();
  c5.classes = JSON.parse('{"__proto__":{"minBps":0,"targetBps":0,"maxBps":0},' + JSON.stringify(base().classes).slice(1));
  assert.strictEqual(Domain.validateTargetTemplate(c5).error.code, 'invalid_target_template');

  // 6) 异常对象形状
  assert.strictEqual(Domain.validateTargetTemplate({ level: 1, classes: [] }).error.code, 'invalid_target_template');
  assert.strictEqual(Domain.validateTargetTemplate({ level: 1, classes: new Date() }).error.code, 'invalid_target_template');
  assert.strictEqual(Domain.validateTargetTemplate({ level: 1, classes: 'cash' }).error.code, 'invalid_target_template');
  assert.strictEqual(Domain.validateTargetTemplate({ level: 1, classes: null }).error.code, 'invalid_target_template');

  // 7) 缺类别仍按原错误码拒绝（原有门槛不得因为新检查而松动）
  const c6 = base();
  delete c6.classes.cash;
  assert.strictEqual(Domain.validateTargetTemplate(c6).error.code, 'invalid_target_template');

  // 8) 零回归：内置五级模板与合法副本仍全部通过
  Domain.TARGET_TEMPLATES.forEach((t) => {
    assert.strictEqual(Domain.validateTargetTemplate(t).ok, true, '内置模板必须仍合法：L' + t.level);
    assert.strictEqual(Domain.validateTargetTemplate(JSON.parse(JSON.stringify(t))).ok, true, '深拷贝副本必须仍合法：L' + t.level);
  });
  FIXTURE.targetTemplates.forEach((t) => assert.strictEqual(Domain.validateTargetTemplate(t).ok, true, 'fixture 模板必须仍合法：L' + t.level));
});

test('5A-22 补口零回归：三条缺口的修复不得改变任何既有正向结果', () => {
  // 冻结 / 收紧校验之后，5A 承载的冻结样例必须逐字段不变（只有 S5_1 在 5A 可评分）
  const r = Domain.scoreRiskAnswers(FIXTURE.samples.S5_1.answers);
  const e = FIXTURE.samples.S5_1.expect;
  assert.strictEqual(r.ok, true, 'S5_1 必须仍可评分');
  assert.strictEqual(r.capacityScore, e.capacityScore);
  assert.strictEqual(r.willingnessScore, e.willingnessScore);
  assert.strictEqual(r.capacityLevel, e.capacityLevel);
  assert.strictEqual(r.willingnessLevel, e.willingnessLevel);
  assert.strictEqual(r.ceiling, e.ceiling);
  assert.strictEqual(r.ceilingSource, e.ceilingSource);
  assert.deepStrictEqual(r.hardCaps.map((c) => c.code), e.hardCaps);
  assert.strictEqual(r.ruleVersion, FIXTURE.ruleVersion);
  // S5_2 / S5_3 属 5D（算法与状态机），5A 不得把它们算成"已通过"
  ['S5_2', 'S5_3'].forEach((k) => {
    assert.strictEqual(FIXTURE.samples[k].verifiesIn, '5D', k + ' 的承载子阶段必须仍是 5D');
    assert.strictEqual(FIXTURE.samples[k].answers, undefined, k + ' 在 5A 不该有可评分答案');
    assert.strictEqual(FIXTURE.samples[k].expect.formalRecommendation === null
      || typeof FIXTURE.samples[k].expect.primaryCategory === 'string', true, k + ' 的冻结期望仍在');
  });
  assert.strictEqual(FIXTURE.samples.S5_1.verifiesIn, '5A');
  // 合法建议请求（含无映射 / 0 元新增资金）仍通过
  const req = sampleRequest();
  assert.strictEqual(Domain.validateRecommendationRequest(req).ok, true);
  assert.strictEqual(Domain.validateRecommendationRequest(Object.assign({}, req, { approvedInstruments: undefined })).ok, true);
  assert.strictEqual(Domain.validateRecommendationRequest(Object.assign({}, req, { newFundsMinor: 0 })).ok, true);
  // 规则目录与模板查表仍是可写的深拷贝（调用方改自己的副本不受限制）
  const cat = Domain.riskCatalog();
  assert.strictEqual(Object.isFrozen(cat), false, '对外目录是深拷贝，不是冻结视图');
  const tpl = Domain.targetTemplateForLevel(3);
  assert.strictEqual(Object.isFrozen(tpl), false, '模板副本必须是可写的深拷贝');
  cat.questions[0].options[0].score = 99;
  tpl.classes.cash.targetBps = 9999;
  assert.strictEqual(Domain.riskCatalog().questions[0].options[0].score, FIXTURE.questions[0].options[0].score);
  assert.strictEqual(Domain.RISK_QUESTIONS[0].options[0].score, FIXTURE.questions[0].options[0].score);
  assert.strictEqual(Domain.TARGET_TEMPLATES[2].classes.cash.targetBps, FIXTURE.targetTemplates[2].classes.cash.targetBps);
});

/* ------------------- 8. 第三轮复核补口反例（G5A-4 / G5A-5，2026-09-19） ------------------- */

test('5A-23 G5A-4 反例：目标模板必须绑定合法 level 与当前 templateVersion', () => {
  const base = () => JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
  const badLevels = [undefined, null, '3', 0, 6, 999, 3.5, NaN];
  badLevels.forEach((level) => {
    const tpl = base();
    if (level === undefined) delete tpl.level; else tpl.level = level;
    const r = Domain.validateTargetTemplate(tpl);
    assert.strictEqual(r.ok, false, '非法 level 必须拒绝：' + String(level));
    assert.strictEqual(r.error.code, 'invalid_target_template');
  });
  const badVersions = [undefined, null, '', ' ', 'risk-targets-unknown', 'risk-targets-v1 ', 'Risk-Targets-V1', 1, {}];
  badVersions.forEach((templateVersion) => {
    const tpl = base();
    if (templateVersion === undefined) delete tpl.templateVersion; else tpl.templateVersion = templateVersion;
    const r = Domain.validateTargetTemplate(tpl);
    assert.strictEqual(r.ok, false, '非法 templateVersion 必须拒绝：' + String(templateVersion));
    assert.strictEqual(r.error.code, 'invalid_target_template');
  });
  Domain.TARGET_TEMPLATES.forEach((tpl) => assert.strictEqual(Domain.validateTargetTemplate(tpl).ok, true));
  FIXTURE.targetTemplates.forEach((tpl) => assert.strictEqual(Domain.validateTargetTemplate(tpl).ok, true));
});

test('5A-24 G5A-5 反例：建议输入及两类引用对象执行精确键白名单', () => {
  const badTopKeys = ['capacityScore', 'riskCeiling', 'currentAllocation', 'blockers'];
  badTopKeys.forEach((key) => {
    const req = sampleRequest(); req[key] = key === 'capacityScore' ? 999 : {};
    assert.strictEqual(Domain.validateRecommendationRequest(req).ok, false, '顶层派生字段必须拒绝：' + key);
  });
  const hidden = sampleRequest();
  Object.defineProperty(hidden, 'capacityScore', { value: 999, enumerable: false });
  assert.strictEqual(Domain.validateRecommendationRequest(hidden).ok, false, '不可枚举顶层字段必须拒绝');
  const symbolKey = sampleRequest(); symbolKey[Symbol('capacityScore')] = 999;
  assert.strictEqual(Domain.validateRecommendationRequest(symbolKey).ok, false, 'Symbol 顶层字段必须拒绝');
  const inherited = Object.assign(Object.create({ capacityScore: 999 }), sampleRequest());
  assert.strictEqual(Domain.validateRecommendationRequest(inherited).ok, false, '原型链顶层字段必须拒绝');

  const extraSnap = sampleRequest(); extraSnap.snapshotRef.capacityScore = 999;
  assert.strictEqual(Domain.validateRecommendationRequest(extraSnap).error.code, 'invalid_snapshot_ref');
  const hiddenSnap = sampleRequest();
  Object.defineProperty(hiddenSnap.snapshotRef, 'payload', { value: {}, enumerable: false });
  assert.strictEqual(Domain.validateRecommendationRequest(hiddenSnap).error.code, 'invalid_snapshot_ref');
  const inheritedSnap = sampleRequest();
  inheritedSnap.snapshotRef = Object.assign(Object.create({ currentAllocation: {} }), inheritedSnap.snapshotRef);
  assert.strictEqual(Domain.validateRecommendationRequest(inheritedSnap).error.code, 'invalid_snapshot_ref');

  const extraAssessment = sampleRequest(); extraAssessment.assessmentRef.riskCeiling = 5;
  assert.strictEqual(Domain.validateRecommendationRequest(extraAssessment).error.code, 'invalid_assessment_ref');
  const hiddenAssessment = sampleRequest();
  Object.defineProperty(hiddenAssessment.assessmentRef, 'answers', { value: [], enumerable: false });
  assert.strictEqual(Domain.validateRecommendationRequest(hiddenAssessment).error.code, 'invalid_assessment_ref');
  const inheritedAssessment = sampleRequest();
  inheritedAssessment.assessmentRef = Object.assign(Object.create({ blockers: [] }), inheritedAssessment.assessmentRef);
  assert.strictEqual(Domain.validateRecommendationRequest(inheritedAssessment).error.code, 'invalid_assessment_ref');

  const missing = sampleRequest(); delete missing.newFundsMinor;
  assert.strictEqual(Domain.validateRecommendationRequest(missing).ok, false, '必填键缺失必须拒绝');
  const optional = sampleRequest(); delete optional.approvedInstruments;
  const result = Domain.validateRecommendationRequest(optional);
  assert.strictEqual(result.ok, true, 'approvedInstruments 是唯一可省略顶层键');
  assert.deepStrictEqual(result.approvedInstruments, {});
});

test('5A-25 G5A-4/5 补口零回归：冻结契约值与既有合法输入输出保持不变', () => {
  assert.deepStrictEqual(Domain.RECOMMENDATION_INPUT_KEYS, FIXTURE.recommendationContract.inputKeys);
  assert.deepStrictEqual(Domain.recommendationContract(), FIXTURE.recommendationContract);
  assert.strictEqual(Domain.validateRecommendationRequest(sampleRequest()).ok, true);
  Domain.TARGET_TEMPLATES.forEach((tpl) => assert.strictEqual(Domain.validateTargetTemplate(tpl).ok, true));
  const scored = Domain.scoreRiskAnswers(FIXTURE.samples.S5_1.answers);
  assert.strictEqual(scored.ok, true);
  assert.strictEqual(scored.ceiling, FIXTURE.samples.S5_1.expect.ceiling);
});

test('5A-26 G5A-6 反例：认可标的只消费自有类别，任何自定义原型均 fail closed', () => {
  const inheritedKnown = sampleRequest();
  inheritedKnown.approvedInstruments = Object.create({ broad_equity: ['inst-not-approved'] });
  let r = Domain.validateRecommendationRequest(inheritedKnown);
  assert.strictEqual(r.ok, false, '继承的已知类别不得伪装成用户认可');
  assert.strictEqual(r.error.code, 'invalid_approved_instruments');

  const inheritedUnknown = sampleRequest();
  inheritedUnknown.approvedInstruments = Object.create({ crypto: ['inst-crypto'] });
  assert.strictEqual(Domain.validateRecommendationRequest(inheritedUnknown).error.code, 'invalid_approved_instruments');

  const hiddenProto = {};
  Object.defineProperty(hiddenProto, 'broad_equity', { value: ['inst-hidden'], enumerable: false });
  const inheritedHidden = sampleRequest();
  inheritedHidden.approvedInstruments = Object.create(hiddenProto);
  assert.strictEqual(Domain.validateRecommendationRequest(inheritedHidden).error.code, 'invalid_approved_instruments');

  const symbolProto = {};
  symbolProto[Symbol('broad_equity')] = ['inst-symbol'];
  const inheritedSymbol = sampleRequest();
  inheritedSymbol.approvedInstruments = Object.create(symbolProto);
  assert.strictEqual(Domain.validateRecommendationRequest(inheritedSymbol).error.code, 'invalid_approved_instruments');

  const hiddenPayloadProto = {};
  Object.defineProperty(hiddenPayloadProto, 'capacityScore', { value: 999, enumerable: false });
  const inheritedPayload = Object.assign(Object.create(hiddenPayloadProto), sampleRequest());
  assert.strictEqual(Domain.validateRecommendationRequest(inheritedPayload).ok, false, '白名单助手不得漏过不可枚举原型属性');

  const own = sampleRequest();
  own.approvedInstruments = { broad_equity: ['inst-approved'] };
  r = Domain.validateRecommendationRequest(own);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.approvedInstruments, { broad_equity: ['inst-approved'] });
  const empty = sampleRequest(); empty.approvedInstruments = {};
  assert.deepStrictEqual(Domain.validateRecommendationRequest(empty).approvedInstruments, {});
  const nullProto = sampleRequest(); nullProto.approvedInstruments = Object.create(null);
  assert.deepStrictEqual(Domain.validateRecommendationRequest(nullProto).approvedInstruments, {}, '无原型纯数据对象仍可表达空映射');
});

test('5A-27 G5A-7 反例：认可标的数组只接受普通稠密自有数据索引', () => {
  const inheritedProto = Object.create(Array.prototype);
  Object.defineProperty(inheritedProto, '0', { value: 'inst-inherited-array-slot', enumerable: false });
  const inheritedIndex = [];
  inheritedIndex.length = 1;
  Object.setPrototypeOf(inheritedIndex, inheritedProto);
  let req = sampleRequest(); req.approvedInstruments = { broad_equity: inheritedIndex };
  let r = Domain.validateRecommendationRequest(req);
  assert.strictEqual(r.ok, false, '继承数组索引不得变成用户认可标的');
  assert.strictEqual(r.error.code, 'invalid_approved_instruments');

  const noSlice = ['inst-own'];
  Object.setPrototypeOf(noSlice, {});
  req = sampleRequest(); req.approvedInstruments = { broad_equity: noSlice };
  assert.doesNotThrow(() => { r = Domain.validateRecommendationRequest(req); }, '非法数组原型必须返回错误而非抛 TypeError');
  assert.strictEqual(r.error.code, 'invalid_approved_instruments');

  const sparse = [];
  sparse.length = 2;
  sparse[1] = 'inst-own';
  req = sampleRequest(); req.approvedInstruments = { broad_equity: sparse };
  assert.strictEqual(Domain.validateRecommendationRequest(req).error.code, 'invalid_approved_instruments');

  const extra = ['inst-own']; extra.note = 'hidden-shape';
  req = sampleRequest(); req.approvedInstruments = { broad_equity: extra };
  assert.strictEqual(Domain.validateRecommendationRequest(req).error.code, 'invalid_approved_instruments');
  const hidden = ['inst-own']; Object.defineProperty(hidden, 'note', { value: 'hidden' });
  req = sampleRequest(); req.approvedInstruments = { broad_equity: hidden };
  assert.strictEqual(Domain.validateRecommendationRequest(req).error.code, 'invalid_approved_instruments');
  const symbol = ['inst-own']; symbol[Symbol('note')] = 'hidden';
  req = sampleRequest(); req.approvedInstruments = { broad_equity: symbol };
  assert.strictEqual(Domain.validateRecommendationRequest(req).error.code, 'invalid_approved_instruments');

  const getter = [];
  Object.defineProperty(getter, '0', { get() { throw new Error('getter must not run'); }, enumerable: true });
  getter.length = 1;
  req = sampleRequest(); req.approvedInstruments = { broad_equity: getter };
  assert.doesNotThrow(() => { r = Domain.validateRecommendationRequest(req); }, '访问器不得执行或向外抛异常');
  assert.strictEqual(r.error.code, 'invalid_approved_instruments');

  req = sampleRequest(); req.approvedInstruments = { broad_equity: [], fixed_income: ['inst-a', 'inst-b'] };
  r = Domain.validateRecommendationRequest(req);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.approvedInstruments, { fixed_income: ['inst-a', 'inst-b'], broad_equity: [] });
});

test('5A-28 G5A-8 反例：答案行与目标模板比例行只接受精确自有数据字段', () => {
  const normalAnswers = Domain.RISK_QUESTIONS.map((q) => ({ questionId: q.id, optionId: q.options[0].id }));
  const customAnswerArray = normalAnswers.slice();
  Object.setPrototypeOf(customAnswerArray, Object.create(Array.prototype));
  let r;
  assert.doesNotThrow(() => { r = Domain.validateRiskAnswers(customAnswerArray); });
  assert.strictEqual(r.error.code, 'invalid_answers', '答案容器不得使用自定义数组原型');
  const sparseAnswers = normalAnswers.slice(); delete sparseAnswers[0];
  assert.strictEqual(Domain.validateRiskAnswers(sparseAnswers).error.code, 'invalid_answers', '答案容器不得有稀疏槽位');
  const getterAnswers = normalAnswers.slice();
  Object.defineProperty(getterAnswers, '0', { get() { throw new Error('array getter must not run'); }, enumerable: true });
  assert.doesNotThrow(() => { r = Domain.validateRiskAnswers(getterAnswers); });
  assert.strictEqual(r.error.code, 'invalid_answers', '答案容器不得执行索引访问器');

  const inheritedAnswers = Domain.RISK_QUESTIONS.map((q) => Object.create({ questionId: q.id, optionId: q.options[0].id }));
  r = Domain.validateRiskAnswers(inheritedAnswers);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'invalid_answers');

  const extraAnswer = Domain.RISK_QUESTIONS.map((q) => ({ questionId: q.id, optionId: q.options[0].id }));
  extraAnswer[0].score = 999;
  assert.strictEqual(Domain.validateRiskAnswers(extraAnswer).error.code, 'invalid_answers');
  const getterAnswer = Domain.RISK_QUESTIONS.map((q) => ({ questionId: q.id, optionId: q.options[0].id }));
  Object.defineProperty(getterAnswer[0], 'questionId', { get() { throw new Error('getter must not run'); }, enumerable: true });
  assert.doesNotThrow(() => { r = Domain.validateRiskAnswers(getterAnswer); });
  assert.strictEqual(r.error.code, 'invalid_answers');

  const baseTemplate = JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
  const inheritedTop = Object.assign(Object.create({ level: baseTemplate.level }), {
    templateVersion: baseTemplate.templateVersion,
    classes: baseTemplate.classes
  });
  assert.strictEqual(Domain.validateTargetTemplate(inheritedTop).error.code, 'invalid_target_template', '模板顶层字段不得继承');
  const customClasses = JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
  Object.setPrototypeOf(customClasses.classes, { inheritedCategory: {} });
  assert.strictEqual(Domain.validateTargetTemplate(customClasses).error.code, 'invalid_target_template', 'classes 不得使用自定义原型');
  const getterTop = JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
  Object.defineProperty(getterTop, 'level', { get() { throw new Error('template getter must not run'); }, enumerable: true });
  assert.doesNotThrow(() => { r = Domain.validateTargetTemplate(getterTop); });
  assert.strictEqual(r.error.code, 'invalid_target_template', '模板顶层不得执行访问器');

  const inheritedRow = JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
  inheritedRow.classes.cash = Object.create({ minBps: 1500, targetBps: 2000, maxBps: 3500 });
  assert.strictEqual(Domain.validateTargetTemplate(inheritedRow).error.code, 'invalid_target_template');
  const extraRow = JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
  extraRow.classes.cash.note = 'derived';
  assert.strictEqual(Domain.validateTargetTemplate(extraRow).error.code, 'invalid_target_template');
  const getterRow = JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
  Object.defineProperty(getterRow.classes.cash, 'minBps', { get() { throw new Error('getter must not run'); }, enumerable: true });
  assert.doesNotThrow(() => { r = Domain.validateTargetTemplate(getterRow); });
  assert.strictEqual(r.error.code, 'invalid_target_template');

  const nullProtoTpl = Object.create(null);
  nullProtoTpl.level = 3; nullProtoTpl.templateVersion = Domain.RISK_TARGET_VERSION;
  nullProtoTpl.classes = Object.create(null);
  Object.entries(Domain.TARGET_TEMPLATES[2].classes).forEach(([key, value]) => {
    const row = Object.create(null);
    row.minBps = value.minBps; row.targetBps = value.targetBps; row.maxBps = value.maxBps;
    nullProtoTpl.classes[key] = row;
  });
  assert.strictEqual(Domain.validateTargetTemplate(nullProtoTpl).ok, true, '无原型纯数据对象仍是合法 JSON 等价形状');
});

test('5A-29 G5A-9 反例：答案排列顺序不改变完整评分结果且不修改调用方数组', () => {
  const forward = Domain.RISK_QUESTIONS.map((q) => ({ questionId: q.id, optionId: q.options[0].id }));
  const reverse = forward.slice().reverse().map((row) => ({ questionId: row.questionId, optionId: row.optionId }));
  const reverseBefore = JSON.parse(JSON.stringify(reverse));
  const a = Domain.scoreRiskAnswers(forward);
  const b = Domain.scoreRiskAnswers(reverse);
  assert.deepStrictEqual(b, a, '相同语义答案必须逐字段一致，包括 scored 顺序');
  assert.deepStrictEqual(reverse, reverseBefore, '规范化不得修改调用方数组');
  assert.deepStrictEqual(a.scored.map((row) => row.questionId), Domain.RISK_QUESTIONS.map((q) => q.id));
});

test('5A-30 规则图完整性：每题分值域固定为 0–3，等级边界与硬封顶引用均可解析', () => {
  const questions = new Map(Domain.RISK_QUESTIONS.map((q) => [q.id, q]));
  let capacityMax = 0;
  let willingnessMax = 0;
  for (const q of Domain.RISK_QUESTIONS) {
    const scores = q.options.map((o) => o.score).slice().sort((a, b) => a - b);
    assert.deepStrictEqual(scores, [0, 1, 2, 3], q.id + ' 必须恰有 0/1/2/3 四档且不得重复');
    if (q.kind === 'capacity') capacityMax += 3;
    else willingnessMax += 3;
  }
  assert.strictEqual(capacityMax, 15);
  assert.strictEqual(willingnessMax, 12);
  assert.ok(Domain.CAPACITY_LEVEL_BOUNDS.every((b) => b.minScore <= capacityMax));
  assert.ok(Domain.WILLINGNESS_LEVEL_BOUNDS.every((b) => b.minScore <= willingnessMax));

  const capCodes = new Set();
  for (const cap of Domain.RISK_HARD_CAPS) {
    assert.strictEqual(capCodes.has(cap.code), false, '硬封顶 code 不得重复：' + cap.code);
    capCodes.add(cap.code);
    const q = questions.get(cap.questionId);
    assert.ok(q, '硬封顶必须引用存在的题目：' + cap.questionId);
    assert.strictEqual(q.kind, 'capacity', '硬封顶只能引用承受能力题：' + cap.questionId);
    assert.ok(q.options.some((o) => o.score === cap.maxOptionScore), '硬封顶阈值必须落在题目分值域');
    assert.ok(Domain.RISK_LEVELS.includes(cap.maxLevel), '硬封顶等级必须属于 RISK_LEVELS');
    assert.strictEqual(cap.explainKey, q.explainKey, '硬封顶解释卡必须与题目一致');
  }
});

test('5A-31 G5A-10 反例：当前 targetVersion 只接受该等级唯一冻结模板', () => {
  const changed = JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
  changed.classes.cash.targetBps -= 100;
  changed.classes.fixed_income.targetBps += 100;
  assert.strictEqual(changed.classes.cash.minBps <= changed.classes.cash.targetBps, true, '前置：修改后仍满足单类区间');
  assert.strictEqual(changed.classes.fixed_income.targetBps <= changed.classes.fixed_income.maxBps, true, '前置：修改后仍满足单类区间');
  assert.strictEqual(Object.values(changed.classes).reduce((sum, row) => sum + row.targetBps, 0), Domain.BPS_TOTAL, '前置：修改后仍合计 100%');
  const r = Domain.validateTargetTemplate(changed);
  assert.strictEqual(r.ok, false, '同版本不得接受另一套表面合法比例');
  assert.strictEqual(r.error.code, 'invalid_target_template');

  for (const template of Domain.TARGET_TEMPLATES) {
    const clone = JSON.parse(JSON.stringify(template));
    assert.strictEqual(Domain.validateTargetTemplate(clone).ok, true, '冻结模板的普通副本仍须通过：L' + template.level);
  }
});

test('5A-32 G5A-11 反例：newFundsMinor 必须是非负安全整数', () => {
  const max = sampleRequest(); max.newFundsMinor = Number.MAX_SAFE_INTEGER;
  assert.strictEqual(Domain.validateRecommendationRequest(max).ok, true, '最大安全整数仍可精确表示');
  [Number.MAX_SAFE_INTEGER + 1, 1e20].forEach((amount) => {
    const req = sampleRequest(); req.newFundsMinor = amount;
    const r = Domain.validateRecommendationRequest(req);
    assert.strictEqual(r.ok, false, '超出安全整数范围必须拒绝：' + String(amount));
    assert.strictEqual(r.error.code, 'invalid_new_funds');
  });
});

test('5A-33 G5A-12 反例：未来评估日期不得被标记为有效', () => {
  const future = Domain.assessmentValidity('2026-09-21', '2026-09-20');
  assert.strictEqual(future.ok, false);
  assert.strictEqual(future.error.code, 'invalid_assessment_date');
  assert.strictEqual(Domain.assessmentValidity('2026-09-20', '2026-09-20').ok, true, '当天完成的评估合法');
  assert.strictEqual(Domain.assessmentValidity('2024-02-29', '2024-02-28').error.code, 'invalid_assessment_date', '闰日的未来边界也必须拒绝');
});
