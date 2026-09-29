/* Phase 5B｜风险评估记录与复评机制领域测试（DECISIONS D-046/D-047）
 * 覆盖 PHASE5_BREAKDOWN §5.4 退出条件的领域层部分：
 *   - 客户端只提交原始答案/评估日期/复评原因；任何派生字段（分数/等级/上限/到期/规则版本…）
 *     在入口就被拒绝，服务端只采信按 5A 冻结规则重算的结果；
 *   - 相同答案 + 规则版本 → 相同双评分与风险上限；与答案排列顺序无关、不读系统时钟；
 *   - 反例齐全：高意愿+低能力、硬封顶、边界分数、缺答、未知题目/选项、重复回答、
 *     非法日期、非法复评原因、钉住未知规则版本；detail 不回显输入原文；
 *   - 已存记录逐字段与「答案 + ruleVersion」重算核对（伪造/漂移 fail closed），
 *     历史记录不会被新规则静默重算改写；
 *   - 到期三态与当前评估选出：到期日当天仍有效、次日失效、剩余 30 天内即将到期；
 *     空/全过期/不可解析返回可区分空态，绝不虚构默认评估；
 *   - 确定性排序与行序无关（不变量 6）。
 * 本文件只测纯领域层；HTTP 与 wiring 层见 server-phase5b.test.js / app-wiring。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Domain = require('../js/domain.js');

/* 固定时钟：所有可复算结果都必须显式携带日期，测试绝不读系统时钟。 */
const TODAY = '2026-06-15';
// 365 天有效期：2026-06-15 → 2027-06-15（其间 2027 年 2 月为 28 天）
const EXPIRY = '2027-06-15';
const CATALOG = Domain.riskCatalog();

/* ------------------- 构造答案的 helper（只依赖题库本身，不依赖实现内部状态） ------------------- */

function pickOption(q, score) {
  const hit = q.options.filter((o) => o.score === score)[0];
  if (!hit) throw new Error('题库缺少分值为 ' + score + ' 的选项：' + q.id);
  return hit.id;
}

const CAP_QS = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'capacity');
const WIL_QS = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'willingness');

// 按题目顺序逐题给分值（能力 5 题、意愿 4 题），可精确控制哪一题踩硬封顶档
function payloadScores(capScores, wilScores, overrides) {
  const rows = [];
  capScores.forEach((s, i) => rows.push({ questionId: CAP_QS[i].id, optionId: pickOption(CAP_QS[i], s) }));
  wilScores.forEach((s, i) => rows.push({ questionId: WIL_QS[i].id, optionId: pickOption(WIL_QS[i], s) }));
  return Object.assign({ answers: rows, assessedAt: TODAY, reason: 'initial' }, overrides || {});
}

// 快速构造：两组总分从高分档贪心铺开（不保证避开硬封顶题，需要精确铺排时用 payloadScores）
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

function payloadFor(capacityTotal, willingnessTotal, overrides) {
  return payloadScores(splitScore(capacityTotal, CAP_QS.length),
    splitScore(willingnessTotal, WIL_QS.length), overrides);
}

function computeOk(payload, today) {
  const r = Domain.computeRiskAssessment(payload, { today: today || TODAY });
  assert.ok(r.ok, '计算应当成功：' + JSON.stringify(r.error));
  return r.record;
}

// 一条完整可解析的已存记录：compute 的全部派生值 + id/createdAt
function recordOf(payload, overrides) {
  return Object.assign({ id: 'ra-0001', createdAt: '2026-06-15T08:00:00.000Z' },
    computeOk(payload), overrides || {});
}

// 干净的基准载荷：无任何 0 分档、不触发硬封顶（cap 10 → L4，wil 8 → L3，ceiling 3 ← willingness）
function basePayload(overrides) {
  return payloadScores([2, 2, 2, 2, 2], [2, 2, 2, 2], overrides);
}

/* ------------------- 1. 请求契约：白名单入口，派生字段一律不采信 ------------------- */

test('5B-1 请求键集合是冻结契约：只允许 answers / assessedAt / reason', () => {
  const contract = Domain.riskAssessmentContract();
  assert.deepStrictEqual(contract.requestKeys, ['answers', 'assessedAt', 'reason']);
  assert.deepStrictEqual(contract.requestRequired, ['answers', 'assessedAt', 'reason']);
  assert.deepStrictEqual(contract.ruleVersion, Domain.RISK_RULE_VERSION);
  assert.deepStrictEqual(contract.reassessReasons, Domain.REASSESS_REASONS);
  // 有效期常量与 5A 规则目录同源（D-025 单一实现）；字面量钉住冻结值（5A-1 fixture 另有比对）
  assert.strictEqual(contract.validDays, 365);
  assert.strictEqual(contract.validDays, CATALOG.validDays);
  assert.strictEqual(contract.expiringDays, 30);
  assert.strictEqual(contract.expiringDays, CATALOG.expiringDays);
});

test('5B-2 客户端提交的任何派生字段在入口即被拒绝（不进入重算）', () => {
  const derivedKeys = ['capacityScore', 'willingnessScore', 'capacityLevel', 'willingnessLevel',
    'ceiling', 'ceilingSource', 'hardCaps', 'explainCodes', 'expiry', 'ruleVersion', 'id',
    'createdAt', 'status', 'now'];
  for (const key of derivedKeys) {
    for (const value of [5, 'risk-rules-v0', null, {}, []]) {
      const p = payloadFor(12, 10);
      p[key] = value;
      const r = Domain.computeRiskAssessment(p, { today: TODAY });
      assert.ok(!r.ok, '派生字段 ' + key + ' 不得被受理');
      assert.strictEqual(r.error.code, 'invalid_answers');
    }
  }
});

test('5B-3 请求 fail closed：缺键 / 非稠密数组 / 答案行带额外字段全部拒绝', () => {
  for (const missing of ['answers', 'assessedAt', 'reason']) {
    const p = payloadFor(12, 10);
    delete p[missing];
    const r = Domain.computeRiskAssessment(p, { today: TODAY });
    assert.ok(!r.ok, '缺少 ' + missing + ' 必须拒绝');
    assert.strictEqual(r.error.code, 'invalid_answers');
  }
  // 原型链上的键不算自有数据键（自定义 prototype 伪装的载荷）
  const proto = payloadFor(12, 10);
  const inherited = Object.create(proto);
  assert.ok(!Domain.computeRiskAssessment(inherited, { today: TODAY }).ok);
  // 空洞数组与带额外字段的答案行
  const holed = payloadFor(12, 10);
  delete holed.answers[3];
  assert.ok(!Domain.computeRiskAssessment(holed, { today: TODAY }).ok);
  const extra = payloadFor(12, 10);
  extra.answers[0] = Object.assign({ score: 0 }, extra.answers[0]);
  assert.ok(!Domain.computeRiskAssessment(extra, { today: TODAY }).ok);
});

/* ------------------- 2. 唯一重算来源与确定性 ------------------- */

test('5B-4 派生值唯一来源是 5A 的 scoreRiskAnswers / assessmentValidity（D-025 单一实现）', () => {
  const payload = payloadFor(11, 9);
  const record = computeOk(payload);
  const s = Domain.scoreRiskAnswers(payload.answers);
  const v = Domain.assessmentValidity(payload.assessedAt, TODAY);
  assert.ok(s.ok && v.ok);
  assert.strictEqual(record.ruleVersion, s.ruleVersion);
  assert.strictEqual(record.capacityScore, s.capacityScore);
  assert.strictEqual(record.willingnessScore, s.willingnessScore);
  assert.strictEqual(record.capacityLevel, s.capacityLevel);
  assert.strictEqual(record.willingnessLevel, s.willingnessLevel);
  assert.strictEqual(record.ceiling, s.ceiling);
  assert.strictEqual(record.ceilingSource, s.ceilingSource);
  assert.deepStrictEqual(record.hardCaps, s.hardCaps);
  assert.deepStrictEqual(record.explainCodes, s.explainCodes);
  assert.strictEqual(record.expiry, v.expiry);
  assert.strictEqual(record.expiry, EXPIRY);
  assert.strictEqual(record.reason, 'initial');
});

test('5B-5 相同答案 + 规则版本 → 逐字段相同的记录；与答案排列顺序无关；不读系统时钟', () => {
  const a = computeOk(payloadFor(10, 8));
  const b = computeOk(payloadFor(10, 8));
  assert.deepStrictEqual(a, b);
  const shuffled = payloadFor(10, 8);
  shuffled.answers = shuffled.answers.slice().reverse();
  const c = computeOk(shuffled);
  assert.deepStrictEqual(c, a, '乱序答案必须得到与冻结题序一致的规范化记录');
  // 时钟只参与到期判定，不影响评分：不同 today 得到相同派生评分
  const later = computeOk(payloadFor(10, 8), '2026-12-31');
  assert.strictEqual(later.capacityScore, a.capacityScore);
  assert.strictEqual(later.ceiling, a.ceiling);
});

/* ------------------- 3. §5.4 反例：高意愿低能力 / 硬封顶 / 边界分数 ------------------- */

test('5B-6 高意愿不能突破低能力：上限由较低一侧决定', () => {
  // 能力原始分 5（L2）、意愿满分 12（L5）；避开 0 分档以免硬封顶干扰归因
  const record = computeOk(payloadScores([1, 1, 1, 1, 1], [3, 3, 3, 3]));
  assert.deepStrictEqual(record.hardCaps, []);
  assert.strictEqual(record.capacityLevel, 2);
  assert.strictEqual(record.willingnessLevel, 5);
  assert.strictEqual(record.ceiling, 2);
  assert.strictEqual(record.ceilingSource, 'capacity');
  // 反向：低意愿 + 高能力 → willingness 决定
  const mirror = computeOk(payloadScores([3, 3, 3, 3, 3], [3, 0, 0, 0]));
  assert.strictEqual(mirror.ceiling, 2);
  assert.strictEqual(mirror.ceilingSource, 'willingness');
});

test('5B-7 硬封顶只压低上限、绝不提高；命中记录在 hardCaps 与 explainCodes 中可追溯', () => {
  // 能力 12（L4）+ 意愿 12（L5），但应急金（第 2 题）为最差档 → 压到 L2
  const record = computeOk(payloadScores([3, 0, 3, 3, 3], [3, 3, 3, 3]));
  assert.strictEqual(record.capacityScore, 12);
  assert.strictEqual(record.ceiling, 2);
  assert.strictEqual(record.ceilingSource, 'hard_cap');
  assert.deepStrictEqual(record.hardCaps, [
    { code: 'hard_cap_emergency_fund', maxLevel: 2, explainKey: 'card-emergency-fund' }
  ]);
  assert.ok(record.explainCodes.indexOf('hard_cap_emergency_fund') !== -1);
  // 上限本来就不高于封顶时：命中记录仍在，但不改变 ceilingSource、更不抬高
  const noLift = computeOk(payloadScores([2, 0, 3, 3, 3], [3, 0, 0, 0]));
  assert.strictEqual(noLift.capacityLevel, 4);
  assert.strictEqual(noLift.willingnessLevel, 2);
  assert.strictEqual(noLift.ceiling, 2);
  assert.strictEqual(noLift.ceilingSource, 'willingness');
  assert.strictEqual(noLift.hardCaps.length, 1);
});

test('5B-8 边界分数只有一种归属（下界含入）：能力 3/4、12/13；意愿 2/3、10/11', () => {
  // 等级只取决于该组原始总分（硬封顶不影响 level 本身），用快速铺排逐边验证
  for (const [score, level] of [[3, 1], [4, 2], [12, 4], [13, 5]]) {
    const r = computeOk(payloadFor(score, 12));
    assert.strictEqual(r.capacityScore, score);
    assert.strictEqual(r.capacityLevel, level, '能力分 ' + score + ' 应为 L' + level);
  }
  for (const [score, level] of [[2, 1], [3, 2], [10, 4], [11, 5]]) {
    const r = computeOk(payloadFor(15, score));
    assert.strictEqual(r.willingnessScore, score);
    assert.strictEqual(r.willingnessLevel, level, '意愿分 ' + score + ' 应为 L' + level);
  }
  // 边界两侧的 ceiling/source（避开 0 分档，硬封顶不参与）
  const capDecides = computeOk(payloadScores([2, 2, 2, 3, 3], [3, 3, 2, 3]));
  assert.strictEqual(capDecides.capacityScore, 12);
  assert.strictEqual(capDecides.capacityLevel, 4);
  assert.strictEqual(capDecides.willingnessLevel, 5);
  assert.strictEqual(capDecides.ceiling, 4);
  assert.strictEqual(capDecides.ceilingSource, 'capacity');
  const equalTop = computeOk(payloadScores([3, 3, 3, 2, 2], [3, 3, 2, 3]));
  assert.strictEqual(equalTop.capacityLevel, 5);
  assert.strictEqual(equalTop.willingnessLevel, 5);
  assert.strictEqual(equalTop.ceiling, 5);
  assert.strictEqual(equalTop.ceilingSource, 'equal');
});

/* ------------------- 4. 反例：答案合法性 / 日期 / 词表 / 规则版本 ------------------- */

test('5B-9 缺答 / 未知题目 / 未知选项 / 重复回答全部拒绝且 detail 不回显输入原文', () => {
  const missing = payloadFor(10, 8);
  missing.answers = missing.answers.slice(0, 8);
  let r = Domain.computeRiskAssessment(missing, { today: TODAY });
  assert.ok(!r.ok);
  assert.strictEqual(r.error.code, 'missing_answer');

  const unknownQ = payloadFor(10, 8);
  unknownQ.answers[0] = { questionId: 'q_not_exist', optionId: 'o_fixed_stable' };
  r = Domain.computeRiskAssessment(unknownQ, { today: TODAY });
  assert.strictEqual(r.error.code, 'unknown_question');
  assert.ok(r.error.detail.indexOf('q_not_exist') === -1, 'detail 不得回显未知题目原文');

  const unknownO = payloadFor(10, 8);
  unknownO.answers[1] = { questionId: 'q_emergency_fund', optionId: 'o_secret_harbor_999' };
  r = Domain.computeRiskAssessment(unknownO, { today: TODAY });
  assert.strictEqual(r.error.code, 'unknown_option');
  assert.ok(r.error.detail.indexOf('o_secret_harbor_999') === -1, 'detail 不得回显未知选项原文');

  const dup = payloadFor(10, 8);
  dup.answers[5] = { questionId: 'q_income_stability', optionId: 'o_fixed_stable' };
  r = Domain.computeRiskAssessment(dup, { today: TODAY });
  assert.strictEqual(r.error.code, 'duplicate_answer');
});

test('5B-10 日期与词表反例：非法/未来评估日期、空 today、词表外复评原因、钉住未知规则版本', () => {
  // today 缺失或非法 → fail closed（可复算路径必须显式携带时钟）
  assert.strictEqual(Domain.computeRiskAssessment(payloadFor(10, 8), {}).error.code, 'invalid_assessment_date');
  assert.strictEqual(
    Domain.computeRiskAssessment(payloadFor(10, 8), { today: TODAY + 'T00:00:00Z' }).error.code,
    'invalid_assessment_date');
  for (const bad of ['2026-06-31', '2026-2-30', '2026-13-01', '2026-6-15', 'not-a-date', 20260615]) {
    const r = Domain.computeRiskAssessment(payloadFor(10, 8, { assessedAt: bad }), { today: TODAY });
    assert.strictEqual(r.error.code, 'invalid_assessment_date', '非法日期 ' + String(bad));
  }
  // 评估日期晚于 today → 拒绝
  assert.strictEqual(
    Domain.computeRiskAssessment(payloadFor(10, 8, { assessedAt: '2026-06-16' }), { today: TODAY }).error.code,
    'invalid_assessment_date');
  // 复评原因：市场涨跌不是触发原因（D-046 冻结词表）
  for (const bad of ['', 'market_move', '手动', null]) {
    const r = Domain.computeRiskAssessment(payloadFor(10, 8, { reason: bad }), { today: TODAY });
    assert.strictEqual(r.error.code, 'invalid_reassess_reason', '原因 ' + String(bad));
  }
  // 钉住历史规则版本的请求：入口白名单先拒绝 ruleVersion 键（未知规则不存在，不猜）
  const pinned = payloadFor(10, 8);
  pinned.ruleVersion = 'risk-rules-v0';
  assert.strictEqual(Domain.computeRiskAssessment(pinned, { today: TODAY }).error.code, 'invalid_answers');
});

/* ------------------- 5. 已存记录的反序列化校验：伪造 / 漂移 fail closed ------------------- */

test('5B-11 合法记录 round-trip：字段契约完整、返回深拷贝', () => {
  const rec = recordOf(basePayload());
  assert.strictEqual(rec.capacityScore, 10);
  assert.strictEqual(rec.willingnessScore, 8);
  assert.strictEqual(rec.ceiling, 3);
  assert.strictEqual(rec.ceilingSource, 'willingness');
  assert.deepStrictEqual(rec.hardCaps, []);
  const v = Domain.validateRiskAssessmentRecord(rec);
  assert.ok(v.ok, JSON.stringify(v.error));
  assert.deepStrictEqual(v.record, rec);
  v.record.ceiling = 9;
  assert.strictEqual(rec.ceiling, 3, '返回值必须是拷贝，不得反写输入');
});

test('5B-12 记录篡改全部拒绝：派生值/答案冗余字段/规则版本/键集合/日期/原因', () => {
  const tampered = [
    ['ceiling 抬高', (r) => { r.ceiling = 5; }],
    ['capacityScore 伪造', (r) => { r.capacityScore = 15; }],
    ['ceilingSource 伪造', (r) => { r.ceilingSource = 'hard_cap'; }],
    ['expiry 伪造', (r) => { r.expiry = '2099-01-01'; }],
    ['答案冗余 score 伪造', (r) => { r.answers[0].score = 0; }],
    ['答案冗余 dimension 伪造', (r) => { r.answers[0].dimension = 'made_up'; }],
    ['答案换选项', (r) => { r.answers[0].optionId = pickOption(Domain.RISK_QUESTIONS[0], 1); }],
    ['hardCaps 伪造', (r) => { r.hardCaps = [{ code: 'hard_cap_debt_pressure', maxLevel: 2, explainKey: 'x' }]; }],
    ['explainCodes 裁剪', (r) => { r.explainCodes = []; }],
    ['多余键', (r) => { r.note = 'ok'; }],
    ['缺 id', (r) => { delete r.id; }],
    ['缺 createdAt', (r) => { r.createdAt = ''; }],
    ['答案行带额外字段', (r) => { r.answers[1] = Object.assign({ extra: 1 }, r.answers[1]); }],
    ['assessedAt 非法', (r) => { r.assessedAt = '2026-02-30'; }],
    ['reason 词表外', (r) => { r.reason = 'market_move'; }]
  ];
  for (const [label, mutate] of tampered) {
    const rec = recordOf(basePayload());
    mutate(rec);
    const v = Domain.validateRiskAssessmentRecord(rec);
    assert.ok(!v.ok, '篡改「' + label + '」必须被拒绝');
  }
  // 规则版本漂移单独可区分（未来多规则目录时按版本重算，而不是混用）
  const drifted = recordOf(basePayload());
  drifted.ruleVersion = 'risk-rules-v2';
  const v = Domain.validateRiskAssessmentRecord(drifted);
  assert.ok(!v.ok);
  assert.strictEqual(v.error.code, 'invalid_rule_version');
});

test('5B-13 历史记录不被新规则静默重算：重算核对以记录自带的 ruleVersion 为准入口', () => {
  // 当前目录只有 risk-rules-v1：任何其它版本的历史记录读取时即 fail closed，
  // 不会被按 v1 重算后「修正」落库（D-046：保留原始答案才是可重算的根事实）。
  const rec = recordOf(basePayload(), { ruleVersion: 'risk-rules-v0' });
  const v = Domain.validateRiskAssessmentRecord(rec);
  assert.ok(!v.ok);
  assert.strictEqual(v.error.code, 'invalid_rule_version');
  // 原始答案仍在记录里：未来注册了 v0 目录才能按 v0 重算 —— 5B 不猜旧规则。
});

/* ------------------- 6. 当前评估选出：到期三态 + 空态 + 确定性 ------------------- */

test('5B-14 到期边界：到期日当天仍有效（expiring_soon），次日过期', () => {
  const rec = recordOf(basePayload());
  const onExpiry = Domain.selectCurrentAssessment([rec], EXPIRY);
  assert.ok(onExpiry.ok);
  assert.strictEqual(onExpiry.status, 'current');
  assert.strictEqual(onExpiry.current.validity.status, 'expiring_soon');
  assert.strictEqual(onExpiry.current.validity.remainingDays, 0);
  const dayAfter = Domain.selectCurrentAssessment([rec], '2027-06-16');
  assert.strictEqual(dayAfter.status, 'all_expired');
  assert.strictEqual(dayAfter.current, null);
  assert.deepStrictEqual(dayAfter.expiredRef, { assessedAt: TODAY, expiry: EXPIRY });
  // 剩余恰好 30 天 → expiring_soon；31 天 → valid
  assert.strictEqual(Domain.selectCurrentAssessment([rec], '2027-05-16').current.validity.status, 'expiring_soon');
  assert.strictEqual(Domain.selectCurrentAssessment([rec], '2027-05-15').current.validity.status, 'valid');
});

test('5B-15 空态可区分且互不混淆：no_assessment / invalid_records / 混载计数', () => {
  const empty = Domain.selectCurrentAssessment([], TODAY);
  assert.ok(empty.ok);
  assert.strictEqual(empty.status, 'no_assessment');
  assert.strictEqual(empty.invalidCount, 0);
  assert.strictEqual(empty.current, null);

  const forged = recordOf(basePayload(), { id: 'ra-f' });
  forged.ceiling = 1;
  const forged2 = recordOf(basePayload(), { id: 'ra-g' });
  forged2.explainCodes = [];
  const allBad = Domain.selectCurrentAssessment([forged, forged2], TODAY);
  assert.strictEqual(allBad.status, 'invalid_records');
  assert.strictEqual(allBad.invalidCount, 2);
  assert.strictEqual(allBad.current, null);

  // 混有合法记录时：invalidCount 报告坏行数，但正常选出当前评估
  const mixed = Domain.selectCurrentAssessment([
    recordOf(basePayload(), { id: 'ra-ok' }),
    recordOf(payloadScores([3, 3, 3, 2, 2], [3, 3, 3, 3]), { id: 'ra-fine' }),
    (function () { const b = recordOf(basePayload(), { id: 'ra-bad' }); b.capacityLevel = 5; return b; })()
  ], TODAY);
  assert.strictEqual(mixed.status, 'current');
  assert.strictEqual(mixed.invalidCount, 1);
  assert.strictEqual(mixed.current.record.id, 'ra-fine');
});

test('5B-16 确定性排序：assessedAt 降序 → createdAt 降序 → id 升序，与输入行序无关', () => {
  const mk = (id, assessedAt, createdAt) =>
    recordOf(basePayload({ assessedAt }), { id: id, assessedAt: assessedAt, createdAt: createdAt });
  const rows = [
    mk('ra-b', '2026-01-05', '2026-01-05T09:00:00.000Z'),
    mk('ra-a', '2026-01-05', '2026-01-05T09:00:00.000Z'),
    mk('ra-c', '2026-01-05', '2026-01-06T09:00:00.000Z'),
    mk('ra-d', '2026-06-15', '2026-06-15T01:00:00.000Z')
  ];
  const expected = ['ra-d', 'ra-c', 'ra-a', 'ra-b'];
  assert.deepStrictEqual(Domain.sortRiskAssessments(rows).map((r) => r.id), expected);
  // 任意排列输入 → 同一输出
  const perms = [rows.slice().reverse(), [rows[2], rows[0], rows[3], rows[1]], [rows[1], rows[3], rows[0], rows[2]]];
  for (const perm of perms) {
    assert.deepStrictEqual(Domain.sortRiskAssessments(perm).map((r) => r.id), expected);
  }
  assert.strictEqual(Domain.sortRiskAssessments('x'), null);
  // 当前评估取「最新有效」，同日期同时间戳时按 id 升序（ra-a 早于 ra-b）
  const sel = Domain.selectCurrentAssessment([rows[0], rows[1], rows[3]], '2026-07-01');
  assert.strictEqual(sel.current.record.id, 'ra-d');
  const tie = Domain.selectCurrentAssessment([rows[0], rows[1]], '2026-06-15');
  assert.strictEqual(tie.current.record.id, 'ra-a');
  assert.deepStrictEqual(tie.candidates, ['ra-a', 'ra-b']);
});

test('5B-17 selectCurrentAssessment 输入校验 fail closed；now 非法拒绝', () => {
  assert.strictEqual(Domain.selectCurrentAssessment([], '2026-13-01').error.code, 'invalid_assessment_date');
  assert.strictEqual(Domain.selectCurrentAssessment([], TODAY + 'T00:00:00Z').error.code, 'invalid_assessment_date');
  assert.strictEqual(Domain.selectCurrentAssessment('nope', TODAY).error.code, 'invalid_answers');
  // 带空洞的数组不是稠密数据 → 入口拒绝；显式 undefined 行按不可解析记录计数，不虚构默认
  const holed = [recordOf(basePayload())];
  delete holed[0];
  assert.strictEqual(Domain.selectCurrentAssessment(holed, TODAY).error.code, 'invalid_answers');
  const withBad = [recordOf(basePayload())];
  withBad.push(undefined);
  const selBad = Domain.selectCurrentAssessment(withBad, TODAY);
  assert.strictEqual(selBad.status, 'current');
  assert.strictEqual(selBad.invalidCount, 1);
});

test('5B-18 契约快照记录键集合与仓储/页面共用；本地日历日 helper 显式注入时钟', () => {
  const contract = Domain.riskAssessmentContract();
  assert.deepStrictEqual(contract.recordRequired, [
    'id', 'ruleVersion', 'answers', 'capacityScore', 'willingnessScore', 'capacityLevel',
    'willingnessLevel', 'ceiling', 'ceilingSource', 'hardCaps', 'explainCodes',
    'assessedAt', 'expiry', 'reason', 'createdAt'
  ]);
  assert.deepStrictEqual(contract.recordKeys, contract.recordRequired);
  assert.deepStrictEqual(contract.statuses, CATALOG.assessmentStatuses);
  assert.deepStrictEqual(contract.selectNoneStates, ['no_assessment', 'all_expired', 'invalid_records']);
  // 契约快照是拷贝：改动返回数组不影响后续调用（唯一来源，不被调用方污染）
  contract.recordKeys.push('note');
  assert.deepStrictEqual(Domain.riskAssessmentContract().recordKeys, contract.recordRequired);
  // localTodayISO：显式注入 Date 时结果确定（本地时区日历日，不读 UTC 偏移）
  assert.strictEqual(Domain.localTodayISO(new Date(2026, 8, 20)), '2026-09-20');
  assert.strictEqual(Domain.localTodayISO(new Date(2026, 0, 1)), '2026-01-01');
});
