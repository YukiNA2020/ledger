/* V2 核心单测：预算 / 异常检测 / 订阅检测 / 退款冲销 / 报销闭环 / 周期记账 / 二级分类 */
const { test } = require('node:test');
const assert = require('node:assert');
const Core = require('../js/core.js');

let seq = 0;
function mkTxn(o) {
  return Object.assign({
    id: 'v' + (++seq), date: '2026-05-02', time: '12:00',
    type: 'expense', amount: 1000, account: 'a1', accountTo: null,
    category: 'cat-food', merchant: 't', note: '', source: 'manual', rawId: ''
  }, o);
}
const CATS = [
  { id: 'cat-food', type: 'expense', name: '餐饮', necessity: 'need' },
  { id: 'cat-fun', type: 'expense', name: '娱乐', necessity: 'want' },
  { id: 'cat-tea', type: 'expense', name: '饮品', necessity: 'want', parentId: 'cat-food' },
  { id: 'cat-salary', type: 'income', name: '工资' }
];

/* ================= V2.2.1 预算 ================= */

test('budgetStatus：总预算与分类预算进度', () => {
  const txns = [
    mkTxn({ date: '2026-05-01', amount: 30000, category: 'cat-food' }),
    mkTxn({ date: '2026-05-02', amount: 20000, category: 'cat-fun' })
  ];
  const st = Core.budgetStatus(txns, { total: 40000, cats: { cat_food: 0, 'cat-food': 25000 } }, { year: 2026, month: 5 });
  assert.strictEqual(st.total.spent, 50000);
  assert.strictEqual(st.total.over, true);
  assert.ok(Math.abs(st.total.pct - 1.25) < 1e-9);
  const food = st.cats.find(c => c.catId === 'cat-food');
  assert.strictEqual(food.over, true);   // 30000 > 25000
  const fun = st.cats.find(c => c.catId === 'cat-fun');
  assert.strictEqual(fun.budget, 0);
  assert.strictEqual(fun.over, false);   // 未设预算不报超支
});

test('aggregate：必要性统计口径（need/want/未标记，按根分类）', () => {
  const txns = [
    mkTxn({ date: '2026-05-01', amount: 100, category: 'cat-food' }),
    mkTxn({ date: '2026-05-01', amount: 50, category: 'cat-fun' }),
    mkTxn({ date: '2026-05-01', amount: 30, category: null }),
    mkTxn({ date: '2026-05-01', amount: 20, category: 'cat-tea' })  // 二级，根=餐饮(need)
  ];
  const agg = Core.aggregate(txns, { year: 2026, month: 5, categories: CATS });
  assert.strictEqual(agg.need, 120);        // 100 + 20（二级并入根的必要性口径）
  assert.strictEqual(agg.want, 50);
  assert.strictEqual(agg.necessityNone, 30);
});

/* ================= V2.2.2 异常检测 ================= */

// 构造基线：2026-02 ~ 2026-04 三个月正常消费；2026-05 引入各类异常
function baselineData() {
  const txns = [];
  for (const ym of ['2026-02', '2026-03', '2026-04']) {
    txns.push(mkTxn({ date: ym + '-05', amount: 10000, category: 'cat-food', merchant: '超市' }));
    txns.push(mkTxn({ date: ym + '-10', amount: 3000, category: 'cat-fun', merchant: '电影' }));
    txns.push(mkTxn({ date: ym + '-15', amount: 1500, category: 'cat-fun', merchant: '奶茶店' }));
    txns.push(mkTxn({ date: ym + '-20', amount: 1500, category: 'cat-fun', merchant: '奶茶店' }));
    txns.push(mkTxn({ date: ym + '-25', amount: 20000, category: 'cat-food', merchant: '老商户' }));
  }
  return txns;
}

test('异常检测：分类环比异常命中（超基线均值50%且差≥阈值）', () => {
  const txns = baselineData().concat([
    mkTxn({ date: '2026-05-05', amount: 10000, category: 'cat-food', merchant: '超市' }),
    mkTxn({ date: '2026-05-06', amount: 25000, category: 'cat-fun', merchant: '电影' }) // 娱乐 3000→25000
  ]);
  const r = Core.detectAnomalies(txns, { year: 2026, month: 5, categories: CATS });
  assert.strictEqual(r.insufficient, false);
  const surge = r.anomalies.find(a => a.kind === 'category-surge');
  assert.ok(surge, '应检出娱乐分类环比异常');
  assert.strictEqual(surge.catId, 'cat-fun');
});

test('异常检测：单笔大额命中（超分类历史P95）', () => {
  const txns = baselineData().concat([
    mkTxn({ date: '2026-05-05', amount: 10000, category: 'cat-food', merchant: '超市' }),
    mkTxn({ date: '2026-05-07', amount: 60000, category: 'cat-fun', merchant: '电影' })   // 娱乐历史P95=3000
  ]);
  const r = Core.detectAnomalies(txns, { year: 2026, month: 5, categories: CATS });
  const large = r.anomalies.find(a => a.kind === 'large-single');
  assert.ok(large, '应检出单笔大额');
  assert.strictEqual(large.severity, 'red'); // 60000 > 2×3000
});

test('异常检测：新商户首笔大额命中', () => {
  const txns = baselineData().concat([
    mkTxn({ date: '2026-05-05', amount: 10000, category: 'cat-food', merchant: '超市' }),
    mkTxn({ date: '2026-05-08', amount: 30000, category: 'cat-food', merchant: '从未见过的数码店' })
  ]);
  const r = Core.detectAnomalies(txns, { year: 2026, month: 5, categories: CATS });
  const first = r.anomalies.find(a => a.kind === 'first-large');
  assert.ok(first, '应检出新商户首笔大额');
  assert.strictEqual(first.merchant, '从未见过的数码店');
});

test('异常检测：高频小额累积命中（奶茶效应）', () => {
  const extra = [];
  for (let i = 1; i <= 10; i++) extra.push(mkTxn({ date: '2026-05-' + String(i + 5).padStart(2, '0'), amount: 1800, category: 'cat-fun', merchant: '奶茶店' }));
  const txns = baselineData().concat(extra);
  const r = Core.detectAnomalies(txns, { year: 2026, month: 5, categories: CATS });
  const freq = r.anomalies.find(a => a.kind === 'frequent-small');
  assert.ok(freq, '应检出高频小额');
  assert.strictEqual(freq.count, 10);
  assert.strictEqual(freq.amount, 18000);
});

test('异常检测：正常月份无误报', () => {
  const txns = baselineData().concat([
    mkTxn({ date: '2026-05-05', amount: 10000, category: 'cat-food', merchant: '超市' }),
    mkTxn({ date: '2026-05-10', amount: 3000, category: 'cat-fun', merchant: '电影' }),
    mkTxn({ date: '2026-05-15', amount: 1500, category: 'cat-fun', merchant: '奶茶店' }),
    mkTxn({ date: '2026-05-20', amount: 1500, category: 'cat-fun', merchant: '奶茶店' })
  ]);
  const r = Core.detectAnomalies(txns, { year: 2026, month: 5, categories: CATS });
  assert.strictEqual(r.anomalies.length, 0);
});

test('异常检测：历史不足2个月时提示数据积累中', () => {
  const txns = [mkTxn({ date: '2026-04-05', amount: 1000 }), mkTxn({ date: '2026-05-05', amount: 90000 })];
  const r = Core.detectAnomalies(txns, { year: 2026, month: 5, categories: CATS });
  assert.strictEqual(r.insufficient, true);
  assert.ok(r.message.includes('数据积累'));
  assert.strictEqual(r.anomalies.length, 0);
});

/* ================= V2.2.3 订阅检测 ================= */

test('订阅检测：月度固定扣款识别与月成本', () => {
  const txns = [];
  for (const [ym, d] of [['2026-01', '03'], ['2026-02', '03'], ['2026-03', '03'], ['2026-04', '03']]) {
    txns.push(mkTxn({ date: ym + '-' + d, amount: 2500, merchant: '某视频会员', category: 'cat-fun' }));
  }
  // 噪音：金额递减不等、无周期
  txns.push(mkTxn({ date: '2026-01-15', amount: 5000, merchant: '超市' }));
  txns.push(mkTxn({ date: '2026-02-20', amount: 3000, merchant: '超市' }));
  txns.push(mkTxn({ date: '2026-03-25', amount: 8000, merchant: '超市' }));
  const subs = Core.detectSubscriptions(txns);
  assert.strictEqual(subs.length, 1);
  const s = subs[0];
  assert.strictEqual(s.merchant, '某视频会员');
  assert.strictEqual(s.count, 4);
  assert.ok(Math.abs(s.monthlyCost - 2500) < 100); // 月度周期月成本≈单次金额
  assert.ok(!subs.find(x => x.merchant === '超市'), '非周期消费不应误报');
});

test('订阅检测：年度扣款月成本折算', () => {
  const txns = [
    mkTxn({ date: '2024-06-15', amount: 12800, merchant: '网盘年费' }),
    mkTxn({ date: '2025-06-15', amount: 12800, merchant: '网盘年费' }),
    mkTxn({ date: '2026-06-15', amount: 12800, merchant: '网盘年费' })
  ];
  const subs = Core.detectSubscriptions(txns);
  assert.strictEqual(subs.length, 1);
  assert.ok(Math.abs(subs[0].monthlyCost - Math.round(12800 * 30.44 / 365)) <= 1);
});

/* ================= V2.3.1 退款冲销 ================= */

test('退款推荐与冲销：月支出净额化、不计收入', () => {
  const expense = mkTxn({ date: '2026-05-01', amount: 10000, merchant: '肯德基', category: 'cat-food' });
  const refund = mkTxn({ date: '2026-05-10', type: 'income', amount: 10000, merchant: '肯德基', refundFlag: true });
  const unrelated = mkTxn({ date: '2026-05-02', amount: 5000, merchant: '星巴克', category: 'cat-fun' });
  const txns = [expense, refund, unrelated];

  const matches = Core.matchRefunds(txns);
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].candidates[0].id, expense.id);

  Core.linkRefund(refund, expense);
  const agg = Core.aggregate(txns, { year: 2026, month: 5, categories: CATS });
  assert.strictEqual(agg.expense, 5000);            // 10000 被退款冲减
  assert.strictEqual(agg.byCategory['cat-food'], undefined); // 完全冲销不再计入分类
  assert.strictEqual(agg.byCategory['cat-fun'].sum, 5000);
  assert.strictEqual(agg.income, 0);                 // 退款不算收入
  assert.strictEqual(agg.refunded, 10000);

  Core.unlinkRefund(refund);
  const agg2 = Core.aggregate(txns, { year: 2026, month: 5, categories: CATS });
  assert.strictEqual(agg2.expense, 15000);
  assert.strictEqual(agg2.income, 10000);
});

test('退款推荐：金额/商户/时间窗过滤', () => {
  const expense = mkTxn({ date: '2026-05-01', amount: 10000, merchant: '肯德基' });
  const refund = mkTxn({ date: '2026-05-10', type: 'income', amount: 4000, merchant: '肯德基', refundFlag: true });
  const far = mkTxn({ date: '2026-01-01', amount: 10000, merchant: '肯德基' });     // 超出90天窗口
  const other = mkTxn({ date: '2026-05-02', amount: 3000, merchant: '星巴克' });    // 金额不足
  const m = Core.matchRefunds([expense, refund, far, other]);
  assert.deepStrictEqual(m[0].candidates.map(c => c.id), [expense.id]);
});

/* ================= V2.3.2 报销管理 ================= */

test('报销闭环：收支统计还原、不虚增收入', () => {
  const advance = mkTxn({ date: '2026-05-01', amount: 20000, merchant: '差旅报销垫付', reimburseFlag: true });
  const repaid = mkTxn({ date: '2026-05-20', type: 'income', amount: 20000, merchant: '公司报销款' });
  const txns = [advance, repaid];

  const m = Core.matchReimbursements(txns);
  assert.strictEqual(m.pending.length, 1);
  assert.strictEqual(m.suggestions.length, 1);
  assert.strictEqual(m.suggestions[0].candidates[0].id, advance.id);

  Core.linkReimbursement(repaid, advance);
  const agg = Core.aggregate(txns, { year: 2026, month: 5, categories: CATS });
  assert.strictEqual(agg.expense, 0);  // 闭环后不属个人支出
  assert.strictEqual(agg.income, 0);   // 报销款不虚增收入

  Core.unlinkReimbursement(repaid);
  const agg2 = Core.aggregate(txns, { year: 2026, month: 5, categories: CATS });
  assert.strictEqual(agg2.expense, 20000);
  assert.strictEqual(agg2.income, 20000);
});

test('待报销清单：pending 只含未闭环垫付', () => {
  const a1 = mkTxn({ date: '2026-05-01', amount: 10000, reimburseFlag: true });
  const a2 = mkTxn({ date: '2026-05-02', amount: 5000, reimburseFlag: true });
  const repaid = mkTxn({ date: '2026-05-10', type: 'income', amount: 5000, reimburseOf: a2.id });
  const m = Core.matchReimbursements([a1, a2, repaid]);
  assert.deepStrictEqual(m.pending.map(p => p.id), [a1.id]);
});

/* ================= V2.3.3 周期记账 ================= */

test('dueRecurring：月度模板逐月生成且末日钳制（31→28）', () => {
  const tpl = { id: 'r1', frequency: 'monthly', day: 31, type: 'expense', amount: 300000, name: '房租' };
  const occ = Core.dueRecurring([tpl], '2026-01', '2026-03');
  assert.deepStrictEqual(occ.map(o => o.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
});

test('dueRecurring：周/年频率', () => {
  const weekly = { id: 'w1', frequency: 'weekly', day: 1 }; // 每周一
  const occ = Core.dueRecurring([weekly], '2026-05', '2026-05');
  // 2026-05 的周一：4、11、18、25
  assert.deepStrictEqual(occ.map(o => o.date), ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25']);
  const yearly = { id: 'y1', frequency: 'yearly', month: 3, day: 8 };
  const occ2 = Core.dueRecurring([yearly], '2025-01', '2026-12');
  assert.deepStrictEqual(occ2.map(o => o.date), ['2025-03-08', '2026-03-08']);
});

test('generateRecurring：连续两月生成正确 + 幂等（二次生成零重复）+ 撤销', () => {
  const tpl = { id: 'r1', frequency: 'monthly', day: 1, type: 'expense', amount: 5000, name: '话费', accountId: 'a1', categoryId: 'cat-fun' };
  const occ = Core.dueRecurring([tpl], '2026-05', '2026-06');
  assert.strictEqual(occ.length, 2);
  const g1 = Core.generateRecurring([tpl], occ, []);
  assert.strictEqual(g1.txns.length, 2);
  assert.strictEqual(g1.txns[0].merchant, '话费');
  const g2 = Core.generateRecurring([tpl], occ, g1.txns);
  assert.strictEqual(g2.txns.length, 0);   // 幂等：同 recurringKey 跳过
  assert.strictEqual(g2.skipped, 2);
  // 漏月补生成
  const more = Core.dueRecurring([tpl], '2026-04', '2026-06');
  const g3 = Core.generateRecurring([tpl], more, g1.txns);
  assert.strictEqual(g3.txns.length, 1);   // 只补 4 月
  assert.strictEqual(g3.txns[0].date, '2026-04-01');
});

test('周期账计入统计且金额正确', () => {
  const tpl = { id: 'r1', frequency: 'monthly', day: 1, type: 'expense', amount: 300000, name: '房租', accountId: 'a1', categoryId: 'cat-food' };
  const occ = Core.dueRecurring([tpl], '2026-05', '2026-06');
  const g = Core.generateRecurring([tpl], occ, []);
  const agg = Core.aggregate(g.txns, { year: 2026, month: 5, categories: CATS });
  assert.strictEqual(agg.expense, 300000);
});

/* ================= V2.3.4 二级分类 ================= */

test('rootCategoryOf 与 rollupByRoot：子分类并入根、口径一致', () => {
  assert.strictEqual(Core.rootCategoryOf('cat-tea', CATS).id, 'cat-food');
  assert.strictEqual(Core.rootCategoryOf('cat-food', CATS).id, 'cat-food');
  const byCategory = {
    'cat-food': { sum: 10000, count: 2 },
    'cat-tea': { sum: 3000, count: 3 }   // 饮品挂在餐饮下
  };
  const rolled = Core.rollupByRoot(byCategory, CATS);
  assert.strictEqual(Object.keys(rolled).length, 1);
  assert.strictEqual(rolled['cat-food'].sum, 13000);   // 二级明细汇总=一级统计
  assert.strictEqual(rolled['cat-food'].children['cat-tea'].sum, 3000);
});

test('aggregate 全量数据下二级汇总与一级统计一致', () => {
  const txns = [
    mkTxn({ date: '2026-05-01', amount: 10000, category: 'cat-food' }),
    mkTxn({ date: '2026-05-02', amount: 2000, category: 'cat-tea' }),
    mkTxn({ date: '2026-05-03', amount: 1000, category: 'cat-tea' })
  ];
  const agg = Core.aggregate(txns, { year: 2026, month: 5, categories: CATS });
  const rolled = Core.rollupByRoot(agg.byCategory, CATS);
  assert.strictEqual(rolled['cat-food'].sum, agg.expense);
});