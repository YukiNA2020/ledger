/* 聚合统计 / 账户余额 / 自动分类 / 账户名匹配 / 预置数据 单测 */
const { test } = require('node:test');
const assert = require('node:assert');
const Core = require('../js/core.js');

let seq = 0;
function mkTxn(o) {
  return Object.assign({
    id: 's' + (++seq), date: '2026-05-02', time: '12:00',
    type: 'expense', amount: 1000, account: 'a1', accountTo: null,
    category: 'c1', merchant: 't', note: '', source: 'manual', rawId: ''
  }, o);
}

/* ---------- 聚合 ---------- */

test('aggregate：月度收支/结余/分类/笔数', () => {
  const txns = [
    mkTxn({ type: 'expense', amount: 4500, category: 'cat-food', date: '2026-05-01' }),
    mkTxn({ type: 'expense', amount: 600, category: 'cat-transport', date: '2026-05-02' }),
    mkTxn({ type: 'income', amount: 1000000, category: 'cat-salary', date: '2026-05-05' }),
    mkTxn({ type: 'expense', amount: 9900, category: 'cat-food', date: '2026-04-30' }), // 上月不计
    mkTxn({ type: 'income', amount: 500, category: 'cat-invest', date: '2026-04-15' })
  ];
  const agg = Core.aggregate(txns, { year: 2026, month: 5 });
  assert.strictEqual(agg.expense, 5100);
  assert.strictEqual(agg.income, 1000000);
  assert.strictEqual(agg.balance, 994900);
  assert.strictEqual(agg.count, 3);
  assert.strictEqual(agg.byCategory['cat-food'].sum, 4500);
  assert.strictEqual(agg.byCategory['cat-food'].count, 1);
  assert.strictEqual(agg.byCategoryIncome['cat-salary'].sum, 1000000);
});

test('aggregate：转账不计入收支', () => {
  const txns = [
    mkTxn({ type: 'transfer', amount: 10000, account: 'a1', accountTo: 'a2', category: null, date: '2026-05-02' })
  ];
  const agg = Core.aggregate(txns, { year: 2026, month: 5 });
  assert.strictEqual(agg.expense, 0);
  assert.strictEqual(agg.income, 0);
  assert.strictEqual(agg.transferCount, 1);
});

test('aggregate：被遮蔽（已合并）记录不重复计入', () => {
  const txns = [
    mkTxn({ type: 'expense', amount: 4500 }),
    mkTxn({ type: 'expense', amount: 4500, mappedTo: 's1' })
  ];
  const agg = Core.aggregate(txns, { year: 2026, month: 5 });
  assert.strictEqual(agg.expense, 4500);
});

test('分精度金额累加无浮点误差', () => {
  const txns = [];
  for (let i = 0; i < 100; i++) txns.push(mkTxn({ type: 'expense', amount: 101 }));
  const agg = Core.aggregate(txns, { year: 2026, month: 5 });
  assert.strictEqual(agg.expense, 10100);
});

/* ---------- 账户余额 ---------- */

test('accountBalance：初始余额 + 收入 + 转入 − 支出 − 转出', () => {
  const acc = { id: 'a1', initialBalance: 50000 };
  const txns = [
    mkTxn({ type: 'income', amount: 1000000, account: 'a1' }),
    mkTxn({ type: 'expense', amount: 4500, account: 'a1' }),
    mkTxn({ type: 'transfer', amount: 10000, account: 'a1', accountTo: 'a2' }), // 转出
    mkTxn({ type: 'transfer', amount: 20000, account: 'a2', accountTo: 'a1' })  // 转入
  ];
  assert.strictEqual(Core.accountBalance(acc, txns), 50000 + 1000000 - 4500 - 10000 + 20000);
});

test('accountBalance：遮蔽记录不参与余额', () => {
  const acc = { id: 'a1', initialBalance: 0 };
  const txns = [
    mkTxn({ type: 'expense', amount: 1000, account: 'a1' }),
    mkTxn({ type: 'expense', amount: 1000, account: 'a1', mappedTo: 'x' })
  ];
  assert.strictEqual(Core.accountBalance(acc, txns), -1000);
});

/* ---------- 月度序列 / 天分组 ---------- */

test('monthlySeries：近 12 个月且当月数值正确', () => {
  const txns = [mkTxn({ type: 'expense', amount: 1234, date: Core.todayStr() })];
  const s = Core.monthlySeries(txns, 12);
  assert.strictEqual(s.length, 12);
  const last = s[s.length - 1];
  assert.strictEqual(last.ym, Core.ymOf(Core.todayStr()));
  assert.strictEqual(last.expense, 1234);
  // 连续性：相邻月份相邻
  for (let i = 1; i < 12; i++) {
    const prev = new Date(s[i - 1].ym + '-01'), cur = new Date(s[i].ym + '-01');
    assert.strictEqual(Math.round((cur - prev) / 2592000000), 1);
  }
});

test('groupByDay：按天倒序、天合计正确、组内时间倒序', () => {
  const txns = [
    mkTxn({ date: '2026-05-01', time: '08:00', type: 'expense', amount: 100 }),
    mkTxn({ date: '2026-05-02', time: '09:00', type: 'expense', amount: 200 }),
    mkTxn({ date: '2026-05-02', time: '07:00', type: 'income', amount: 300 }),
    mkTxn({ date: '2026-05-02', time: '12:00', type: 'expense', amount: 50, mappedTo: 'zz' }) // 遮蔽不显示
  ];
  const g = Core.groupByDay(txns);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].date, '2026-05-02');
  assert.strictEqual(g[0].txns.length, 2);          // 遮蔽的不出现
  assert.strictEqual(g[0].dayExpense, 200);
  assert.strictEqual(g[0].dayIncome, 300);
  assert.strictEqual(g[0].txns[0].time, '09:00');   // 组内倒序
  assert.strictEqual(g[1].date, '2026-05-01');
});

/* ---------- 自动分类 / 账户匹配 ---------- */

test('guessCategory：关键词最长匹配优先', () => {
  const cats = [
    { id: 'c1', name: '外卖', keywords: ['美团'] },
    { id: 'c2', name: '其他', keywords: ['美团外卖专送'] }
  ];
  assert.strictEqual(Core.guessCategory('美团外卖专送-订单', cats).id, 'c2');
  assert.strictEqual(Core.guessCategory('美团订单', cats).id, 'c1');
  assert.strictEqual(Core.guessCategory('完全不相关', cats), null);
  assert.strictEqual(Core.guessCategory('', cats), null);
});

test('guessCategory：内置分类命中常见商户', () => {
  const cats = Core.defaultCategories();
  assert.strictEqual(Core.guessCategory('肯德基宅急送', cats).id, 'cat-food');
  assert.strictEqual(Core.guessCategory('滴滴出行', cats).id, 'cat-transport');
  assert.strictEqual(Core.guessCategory('京东商城-手机', cats).id, 'cat-shopping');
  assert.strictEqual(Core.guessCategory('XX公司代发工资', cats).id, 'cat-salary');
});

test('matchAccountByText：支付方式 → 账户', () => {
  const accounts = [
    { id: 'acc-wechat', name: '微信零钱', aliases: ['零钱'] },
    { id: 'acc-cmb', name: '招行卡(1234)', type: 'bank', aliases: ['招商银行(1234)'] },
    { id: 'acc-cash', name: '现金' }
  ];
  assert.strictEqual(Core.matchAccountByText('零钱', accounts).id, 'acc-wechat');
  assert.strictEqual(Core.matchAccountByText('招商银行(1234)', accounts).id, 'acc-cmb');
  assert.strictEqual(Core.matchAccountByText('零钱通', accounts).id, 'acc-wechat'); // 包含匹配
  assert.strictEqual(Core.matchAccountByText('未知渠道XYZ', accounts), null);
});

test('matchAccountByText：排除已删除账户', () => {
  const accounts = [{ id: 'a', name: '现金', deleted: true }];
  assert.strictEqual(Core.matchAccountByText('现金', accounts), null);
});

/* ---------- 预置数据 ---------- */

test('预置账户与分类满足 V1.1.4 要求', () => {
  const accs = Core.defaultAccounts();
  assert.ok(accs.length >= 4);
  ['微信零钱', '支付宝', '银行卡', '现金'].forEach(n => {
    assert.ok(accs.find(a => a.name.includes(n)), '缺少默认账户 ' + n);
  });

  const cats = Core.defaultCategories();
  ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '通讯'].forEach(n => {
    const c = cats.find(x => x.name === n);
    assert.ok(c, '缺少内置支出分类 ' + n);
    assert.ok(c.icon, n + ' 缺 emoji 图标');
    assert.ok((c.keywords || []).length > 0, n + ' 缺导入关键词');
  });
  ['工资', '奖金', '理财', '红包', '退款'].forEach(n => {
    assert.ok(cats.find(x => x.name === n), '缺少内置收入分类 ' + n);
  });
});

test('suggestTypeMappings：类型映射智能推荐', () => {
  const records = [
    { type: '商户消费', direction: 'expense', transferLike: false },
    { type: '零钱提现', direction: 'neutral', transferLike: true },
    { type: '微信红包', direction: 'income', transferLike: false },
    { type: '退款', direction: 'income', transferLike: false, refund: true }
  ];
  const map = Core.suggestTypeMappings(records);
  assert.strictEqual(map['商户消费'], 'expense');
  assert.strictEqual(map['零钱提现'], 'transfer');
  assert.strictEqual(map['微信红包'], 'income');
  assert.strictEqual(map['退款'], 'refund');
});

test('suggestTypeMappings：同一银行类型混合收支时保留逐行方向', () => {
  const records = [
    { type: '银行-招商银行', direction: 'income', transferLike: false },
    { type: '银行-招商银行', direction: 'expense', transferLike: false }
  ];
  const map = Core.suggestTypeMappings(records);
  assert.strictEqual(map['银行-招商银行'], undefined);

  const built = Core.buildTxns(records.map((r, i) => Object.assign({
    date: `2026-05-0${i + 1}`, time: '', amountCents: 1000,
    payee: '虚构交易', product: '', method: '招商银行', rawId: `bank-mixed-${i}`
  }, r)), {
    source: 'bank', accounts: Core.defaultAccounts(), categories: Core.defaultCategories(),
    typeMapping: map, accountMapping: { '招商银行': 'acc-bank' }, existingTxns: []
  });
  assert.deepStrictEqual(built.txns.map(t => t.type), ['income', 'expense']);
});
