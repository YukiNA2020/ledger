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
