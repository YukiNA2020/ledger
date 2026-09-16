/* Phase 1 资产领域模型行为测试
 * 对应 ACCEPTANCE.md S1.2（财务定点计算）、S1.3（缺失数据不可静默）
 * 与 ARCHITECTURE.md §5（数据模型）、§6（计算口径）。
 * 所有金额为虚构数据，仅用于核对公式。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Domain = require('../js/domain.js');

const REF = '2026-09-06'; // ACCEPTANCE §2 标准虚构数据验收日

// 标准虚构验收数据（ACCEPTANCE §2）。modify 为可选的修改钩子。
function fixtureAssets(modify) {
  const a = {
    schemaVersion: 1,
    assetAccounts: [
      { id: 'acc-cmb', name: '招行储蓄', kind: 'bank', pool: 'safety', status: 'active' },
      { id: 'acc-hsbc', name: '汇丰 USD 子账户', kind: 'bank', pool: 'investable', institution: '香港汇丰', status: 'active' },
      { id: 'acc-broker', name: '券商账户', kind: 'broker', pool: 'investable', status: 'active' },
      { id: 'acc-gjj', name: '青岛公积金', kind: 'government', pool: 'restricted', status: 'active' }
    ],
    assetUnits: [
      { id: 'u-cmb', accountId: 'acc-cmb', currency: 'CNY', balanceMinor: 3000000, asOf: REF, sourceType: 'manual' },
      { id: 'u-hsbc', accountId: 'acc-hsbc', currency: 'USD', balanceMinor: 100000, asOf: REF, sourceType: 'manual' },
      { id: 'u-gjj', accountId: 'acc-gjj', currency: 'CNY', balanceMinor: 500000, asOf: REF, sourceType: 'manual' }
    ],
    liabilities: [
      { id: 'l-card', name: '信用卡待还', currency: 'CNY', balanceMinor: 200000, termType: 'current', asOf: REF }
    ],
    entitlements: [
      { id: 'e-ub', name: '失业保险待遇资格', kind: 'unemployment', jurisdiction: '青岛', status: 'active', balanceMinor: null, asOf: REF }
    ],
    instruments: [
      { id: 'ins-voo', symbol: 'VOO', exchange: 'NYSE', currency: 'USD', name: '标普500 ETF', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'US', classificationStatus: 'confirmed' }
    ],
    holdings: [
      { id: 'h-voo', accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '10', costMinor: 45000, asOf: REF }
    ],
    quotes: [
      { instrumentId: 'ins-voo', priceMinor: 5000, currency: 'USD', priceDate: REF, fetchedAt: REF + 'T08:00:00Z', provider: 'fixture', status: 'ok' }
    ],
    fxRates: [
      { base: 'USD', quote: 'CNY', rateDecimal: '7.20', rateDate: REF, fetchedAt: REF + 'T08:00:00Z', provider: 'fixture', status: 'ok' }
    ]
  };
  if (modify) modify(a);
  return a;
}

function overviewOf(assets, opts) {
  return Domain.computeOverview(assets, Object.assign({ now: REF }, opts || {}));
}

/* ---------------------- 定点十进制工具 ---------------------- */

test('parseDecimal 定点字符串解析', () => {
  assert.deepStrictEqual(Domain.parseDecimal('10'), { v: 10, s: 0 });
  assert.deepStrictEqual(Domain.parseDecimal('10.55'), { v: 1055, s: 2 });
  assert.deepStrictEqual(Domain.parseDecimal('0.001'), { v: 1, s: 3 });
});

test('parseDecimal 非法输入返回 null', () => {
  assert.strictEqual(Domain.parseDecimal(''), null);
  assert.strictEqual(Domain.parseDecimal('abc'), null);
  assert.strictEqual(Domain.parseDecimal('-5'), null);
  assert.strictEqual(Domain.parseDecimal('.5'), null);
  assert.strictEqual(Domain.parseDecimal('10.'), null);
  assert.strictEqual(Domain.parseDecimal('10.123456789'), null); // 超过 8 位小数
  assert.strictEqual(Domain.parseDecimal(null), null);
});

test('mulMinor 整数与简分数量的精确定点乘法', () => {
  assert.strictEqual(Domain.mulMinor('10', 5000), 50000);       // 10 × $50.00
  assert.strictEqual(Domain.mulMinor('10.5', 5000), 52500);     // 10.5 × $50.00
  assert.strictEqual(Domain.mulMinor('0', 5000), 0);            // 零数量
});

test('mulMinor 四舍五入边界与浮点陷阱', () => {
  assert.strictEqual(Domain.mulMinor('10.10', 2999), 30290);    // 30289.9 → 30290（浮点会得 30289.899…）
  assert.strictEqual(Domain.mulMinor('0.1', 12345), 1235);      // 1234.5 → 1235（half-up）
  assert.strictEqual(Domain.mulMinor('0.11', 12345), 1358);     // 1357.95 → 1358
  assert.strictEqual(Domain.mulMinor('0.005', 1), 0);           // 0.005 分 → 0
});

test('mulMinor 非法数量与溢出保护', () => {
  assert.strictEqual(Domain.mulMinor('1e3', 100), null);
  assert.strictEqual(Domain.mulMinor('-5', 100), null);
  assert.strictEqual(Domain.mulMinor('abc', 100), null);
  assert.strictEqual(Domain.mulMinor('1000000000', 999999999), null); // 超出安全整数
});

/* ---------------------- 汇率折算 ---------------------- */

test('convertMinor 同币种直通', () => {
  assert.deepStrictEqual(Domain.convertMinor(12345, 'CNY', 'CNY', [], REF), { valueMinor: 12345, status: 'ok' });
});

test('convertMinor USD/HKD 折算精确无尾差', () => {
  const fx = [
    { base: 'USD', quote: 'CNY', rateDecimal: '7.20', rateDate: REF },
    { base: 'HKD', quote: 'CNY', rateDecimal: '0.92', rateDate: REF }
  ];
  assert.deepStrictEqual(Domain.convertMinor(100000, 'USD', 'CNY', fx, REF), { valueMinor: 720000, status: 'ok' });
  assert.deepStrictEqual(Domain.convertMinor(100000, 'HKD', 'CNY', fx, REF), { valueMinor: 92000, status: 'ok' });
  assert.deepStrictEqual(Domain.convertMinor(1, 'USD', 'CNY', fx, REF), { valueMinor: 7, status: 'ok' }); // 7.2 分 → 7
});

test('convertMinor 缺失汇率不按 1:1 兜底', () => {
  const r = Domain.convertMinor(100000, 'USD', 'CNY', [], REF);
  assert.strictEqual(r.valueMinor, null);
  assert.strictEqual(r.status, 'missing_fx');
});

test('convertMinor 过期汇率仍可估算但标记 fx_stale', () => {
  const fx = [{ base: 'USD', quote: 'CNY', rateDecimal: '7.20', rateDate: '2026-08-20' }];
  const r = Domain.convertMinor(100000, 'USD', 'CNY', fx, REF);
  assert.strictEqual(r.valueMinor, 720000); // 估算值仍可用
  assert.strictEqual(r.status, 'fx_stale');
});

test('convertMinor 取同一币对最近一条汇率', () => {
  const fx = [
    { base: 'USD', quote: 'CNY', rateDecimal: '7.00', rateDate: '2026-09-01' },
    { base: 'USD', quote: 'CNY', rateDecimal: '7.20', rateDate: REF }
  ];
  assert.strictEqual(Domain.convertMinor(100000, 'USD', 'CNY', fx, REF).valueMinor, 720000);
});

/* ---------------------- 新鲜度 ---------------------- */

test('isStaleDays 5 个自然日边界（A-004）', () => {
  assert.strictEqual(Domain.isStaleDays('2026-09-06', REF, 5), false); // 当天
  assert.strictEqual(Domain.isStaleDays('2026-09-01', REF, 5), false); // 恰好 5 天
  assert.strictEqual(Domain.isStaleDays('2026-08-31', REF, 5), true);  // 第 6 天
  assert.strictEqual(Domain.isStaleDays(null, REF, 5), true);
});

test('findQuote 取最近价格日并标记过期', () => {
  const quotes = [
    { instrumentId: 'ins-voo', priceMinor: 4900, priceDate: '2026-09-01' },
    { instrumentId: 'ins-voo', priceMinor: 5000, priceDate: REF }
  ];
  const q = Domain.findQuote(quotes, 'ins-voo', REF);
  assert.strictEqual(q.priceMinor, 5000);
  assert.strictEqual(q.status, 'ok');
  const stale = Domain.findQuote([{ instrumentId: 'ins-voo', priceMinor: 4900, priceDate: '2026-08-20' }], 'ins-voo', REF);
  assert.strictEqual(stale.status, 'quote_stale');
  assert.strictEqual(Domain.findQuote([], 'ins-voo', REF), null);
});

/* ---------------------- 空集合与归一化 ---------------------- */

test('emptyAssets 提供 10 个 v3 空集合', () => {
  const a = Domain.emptyAssets();
  assert.strictEqual(a.schemaVersion, 1);
  ['assetAccounts', 'assetUnits', 'assetTransfers', 'liabilities', 'entitlements', 'instruments', 'holdings', 'quotes', 'fxRates', 'securityEvents']
    .forEach(k => assert.deepStrictEqual(a[k], [], k));
});

test('normalizeAssets 对旧数据/脏数据容错', () => {
  const a = Domain.normalizeAssets(undefined);
  assert.strictEqual(a.assetUnits.length, 0);
  const b = Domain.normalizeAssets({ assetUnits: [{ id: 'u1' }], liabilities: 'bad', quotes: null });
  assert.strictEqual(b.assetUnits.length, 1);
  assert.deepStrictEqual(b.liabilities, []);
  assert.deepStrictEqual(b.quotes, []);
});

/* ---------------------- S1.2 标准虚构数据总览 ---------------------- */

test('S1.2 标准虚构数据得到精确资产负债口径', () => {
  const o = overviewOf(fixtureAssets());
  assert.strictEqual(o.totalAssetsMinor, 4580000);   // 30,000 + 7,200 + 3,600 + 5,000
  assert.strictEqual(o.totalLiabilitiesMinor, 200000);
  assert.strictEqual(o.netWorthMinor, 4380000);      // 45,800 − 2,000
  assert.strictEqual(o.pools.safetyMinor, 3000000);
  assert.strictEqual(o.pools.investableMinor, 1080000); // 7,200 + 3,600
  assert.strictEqual(o.pools.restrictedMinor, 500000);
  assert.strictEqual(o.investableCashMinor, 720000);
  assert.strictEqual(o.valuationStatus, 'formal');
  assert.strictEqual(o.canAdvise, true);
});

test('S1.2 风险资产类别配比精确', () => {
  const o = overviewOf(fixtureAssets());
  const byClass = {};
  o.riskClasses.forEach(r => { byClass[r.assetClass] = r; });
  assert.strictEqual(byClass.cash.valueMinor, 720000);
  assert.strictEqual(byClass.cash.pct, 66.7);
  assert.strictEqual(byClass.broad_equity.valueMinor, 360000);
  assert.strictEqual(byClass.broad_equity.pct, 33.3);
  assert.strictEqual(byClass.fixed_income.valueMinor, 0);
});

test('可新增投资资金扣除近期应付款', () => {
  const o = overviewOf(fixtureAssets());
  // 未设置安全储备目标时缺口按 0，但仍列出待办
  assert.strictEqual(o.newFundsAvailableMinor, 520000); // 7,200 − 2,000
  assert.ok(o.todos.some(t => t.code === 'safety_target_unset'));
});

test('安全储备缺口减少可新增投资资金', () => {
  const settings = { safetyTargetMinor: 3200000 }; // 目标 32,000，缺口 2,000
  const o = overviewOf(fixtureAssets(), { settings });
  assert.strictEqual(o.safetyGapMinor, 200000);
  assert.strictEqual(o.newFundsAvailableMinor, 320000); // 7,200 − 2,000 − 2,000
});

test('安全储备已达标或可新增资金为负时下限为 0', () => {
  const ok = overviewOf(fixtureAssets(), { settings: { safetyTargetMinor: 3000000 } });
  assert.strictEqual(ok.safetyGapMinor, 0);
  assert.strictEqual(ok.newFundsAvailableMinor, 520000);
  const over = overviewOf(fixtureAssets(a => {
    a.liabilities[0].balanceMinor = 900000; // 应付款 9,000 > 可投资现金 7,200
  }));
  assert.strictEqual(over.newFundsAvailableMinor, 0);
});

test('受限资产与无余额权益不进入可投资资产', () => {
  const o = overviewOf(fixtureAssets());
  assert.strictEqual(o.pools.investableMinor, 1080000);  // 不含公积金 5,000
  assert.strictEqual(o.entitlements.length, 1);          // 仅展示状态
  assert.strictEqual(o.entitlements[0].status, 'active');
  assert.strictEqual(o.entitlements[0].balanceMinor, null);
  // 无余额权益不进入任何金额合计
  assert.strictEqual(o.totalAssetsMinor, 4580000);
});

test('负债不记为负资产，净资产可为负', () => {
  const o = overviewOf(fixtureAssets(a => {
    a.assetUnits = [];
    a.holdings = [];
    // 只剩负债 2,000
  }));
  assert.strictEqual(o.totalAssetsMinor, 0);      // 负债不冲减总资产
  assert.strictEqual(o.totalLiabilitiesMinor, 200000);
  assert.strictEqual(o.netWorthMinor, -200000);
});

test('已确认的零余额按 0 计入，不视为缺失', () => {
  const o = overviewOf(fixtureAssets(a => {
    a.assetUnits.push({ id: 'u-zero', accountId: 'acc-cmb', currency: 'CNY', balanceMinor: 0, asOf: REF, sourceType: 'manual' });
  }));
  assert.strictEqual(o.totalAssetsMinor, 4580000);
  assert.ok(!o.blockers.some(b => b.detail === '招行储蓄' && b.code === 'balance_missing'));
});

test('三币种（含 HKD）都能折算进总览', () => {
  const o = overviewOf(fixtureAssets(a => {
    a.assetUnits.push({ id: 'u-hkd', accountId: 'acc-hsbc', currency: 'HKD', balanceMinor: 100000, asOf: REF, sourceType: 'manual' });
    a.fxRates.push({ base: 'HKD', quote: 'CNY', rateDecimal: '0.92', rateDate: REF });
  }));
  // 追加 HKD 1,000 × 0.92 = CNY 920 → 4,580,000 + 92,000
  assert.strictEqual(o.totalAssetsMinor, 4672000);
});

/* ---------------------- S1.3 缺失数据不可静默 ---------------------- */

test('S1.3 USD 汇率缺失时不按 1:1 计算并阻断正式建议', () => {
  const o = overviewOf(fixtureAssets(a => { a.fxRates = []; }));
  // USD 部分被排除而非按 1:1：总资产 = 30,000 + 5,000 = 35,000（不是 36,500）
  assert.strictEqual(o.totalAssetsMinor, 3500000);
  assert.strictEqual(o.valuationStatus, 'estimate');
  assert.strictEqual(o.canAdvise, false);
  assert.ok(o.blockers.some(b => b.code === 'fx_missing' && b.detail === 'USD'));
  assert.ok(o.freshness.fxStale === false && o.blockers.length > 0);
});

test('S1.3 缺失行情时不虚构 ETF 市值', () => {
  const o = overviewOf(fixtureAssets(a => { a.quotes = []; }));
  // 只剩现金与受限资产：30,000 + 7,200 + 5,000
  assert.strictEqual(o.totalAssetsMinor, 4220000);
  assert.strictEqual(o.canAdvise, false);
  assert.ok(o.blockers.some(b => b.code === 'quote_missing'));
});

test('过期行情保留估算但阻止正式建议', () => {
  const o = overviewOf(fixtureAssets(a => {
    a.quotes[0].priceDate = '2026-08-20'; // 17 天前
  }));
  assert.strictEqual(o.totalAssetsMinor, 4580000); // 估算仍按最后有效价
  assert.strictEqual(o.valuationStatus, 'estimate');
  assert.strictEqual(o.canAdvise, false);
  assert.strictEqual(o.freshness.quoteStale, true);
});

test('余额未在本月确认标记 balance_stale 但仍展示', () => {
  const o = overviewOf(fixtureAssets(a => {
    a.assetUnits[0].asOf = '2026-08-31';
  }));
  assert.strictEqual(o.totalAssetsMinor, 4580000);
  assert.strictEqual(o.valuationStatus, 'estimate');
  assert.strictEqual(o.freshness.balanceStale, true);
  assert.strictEqual(o.canAdvise, false);
});

test('没有明确余额的账户不计入也不按 0 处理', () => {
  const o = overviewOf(fixtureAssets(a => {
    a.assetUnits[0].balanceMinor = null;
  }));
  // 30,000 缺失：7,200 + 3,600 + 5,000
  assert.strictEqual(o.totalAssetsMinor, 1580000);
  assert.ok(o.blockers.some(b => b.code === 'balance_missing'));
  assert.strictEqual(o.canAdvise, false);
});

test('分类未确认的标的不阻断估值但阻断正式建议', () => {
  const o = overviewOf(fixtureAssets(a => {
    a.instruments[0].classificationStatus = 'suggested';
  }));
  assert.strictEqual(o.totalAssetsMinor, 4580000); // 仍计入估算
  assert.strictEqual(o.valuationStatus, 'estimate');
  assert.strictEqual(o.canAdvise, false);
  assert.strictEqual(o.freshness.classificationUnconfirmed, true);
});

test('资金池缺失的余额计入总资产但单独标记', () => {
  const o = overviewOf(fixtureAssets(a => {
    a.assetUnits.push({ id: 'u-bad', accountId: 'acc-none', currency: 'CNY', balanceMinor: 1000, asOf: REF, sourceType: 'manual' });
  }));
  assert.strictEqual(o.totalAssetsMinor, 4581000);
  assert.strictEqual(o.valuationStatus, 'estimate');
  assert.ok(o.blockers.some(b => b.code === 'pool_missing'));
});

test('空资产集合输出 empty 状态且不虚构数值', () => {
  const o = overviewOf(Domain.emptyAssets());
  assert.strictEqual(o.isEmpty, true);
  assert.strictEqual(o.valuationStatus, 'empty');
  assert.strictEqual(o.totalAssetsMinor, 0);
  assert.strictEqual(o.netWorthMinor, 0);
  assert.strictEqual(o.canAdvise, false);
  assert.ok(!o.todos.some(t => t.code === 'safety_target_unset')); // 空状态不打扰
});
