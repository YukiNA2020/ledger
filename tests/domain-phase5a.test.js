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

/* ------------------- 6. 范围守卫（5A 不做迁移 / API / 页面） ------------------- */

test('5A-18 范围守卫：零迁移、零新路由、零网络、零随机、不读系统时钟', () => {
  const M = require('../server/migrations.js');
  assert.strictEqual(M.LATEST_VERSION, 7, '5A 不得新增迁移（5B 起才允许按冻结语义建表）');

  const apiSrc = fs.readFileSync(path.join(ROOT, 'server/api.js'), 'utf8');
  assert.match(apiSrc, /'POST \/api\/v1\/risk-assessments': 'Phase 5'/, '延后写入登记必须保留');
  assert.strictEqual((apiSrc.match(/risk/gi) || []).length, 1, '5A 不得新增风险相关路由');

  const domSrc = fs.readFileSync(path.join(ROOT, 'js/domain.js'), 'utf8');
  const start = domSrc.indexOf('风险问卷规则与配置契约（Phase 5A');
  const end = domSrc.indexOf('RISK_RULE_VERSION: RISK_RULE_VERSION');
  assert.ok(start > 0 && end > start, '找不到 Phase 5A 段落');
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
