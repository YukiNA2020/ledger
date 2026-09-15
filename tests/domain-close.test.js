/* Phase 3 月度结账与应急金领域行为测试
 * 对应 ACCEPTANCE.md S3.3（月结门槛）、ROADMAP Phase 3 工作项 5/6、ARCHITECTURE §6。
 * 复用 ACCEPTANCE §2 标准虚构验收数据；所有金额均为虚构。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Domain = require('../js/domain.js');

const REF = '2026-09-06'; // ACCEPTANCE §2 标准虚构数据验收日（2026-09 月内）

// 标准虚构验收数据（与 tests/domain.test.js 一致）。modify 为可选的修改钩子。
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

/* ---------------------- 应急金覆盖月数 ---------------------- */

test('emergencyCoverageMonths：安全储备 ÷ 月均必要支出，1 位小数', () => {
  // 30,000.00 元安全储备，月均必要支出 10,000.00 元 → 3.0 个月
  assert.strictEqual(Domain.emergencyCoverageMonths(3000000, 1000000), 3);
  assert.strictEqual(Domain.emergencyCoverageMonths(3333300, 1000000), 3.3);
  assert.strictEqual(Domain.emergencyCoverageMonths(0, 1000000), 0);
});

test('emergencyCoverageMonths：无法估算时返回 null，不用 0 冒充', () => {
  assert.strictEqual(Domain.emergencyCoverageMonths(3000000, 0), null);
  assert.strictEqual(Domain.emergencyCoverageMonths(3000000, null), null);
  assert.strictEqual(Domain.emergencyCoverageMonths(null, 1000000), null);
  assert.strictEqual(Domain.emergencyCoverageMonths('30000', 1000000), null);
});

/* ---------------------- 月结核对清单：正式口径 ---------------------- */

test('computeCloseChecklist：数据完整时 canComplete=true，清单为空，事实可逐条追溯', () => {
  const c = Domain.computeCloseChecklist(fixtureAssets(), { now: REF });
  assert.strictEqual(c.month, '2026-09');
  assert.strictEqual(c.valuationStatus, 'formal');
  assert.strictEqual(c.canComplete, true);
  assert.deepStrictEqual(c.items, []);

  // 每个金额都能下钻到余额/估值来源
  assert.strictEqual(c.counts.units, 3);
  assert.strictEqual(c.counts.unitsConfirmed, 3);
  assert.strictEqual(c.counts.liabilities, 1);
  assert.strictEqual(c.counts.liabilitiesConfirmed, 1);
  assert.strictEqual(c.counts.holdings, 1);
  assert.strictEqual(c.counts.holdingsPriced, 1);

  const hsbc = c.facts.units.find((u) => u.id === 'u-hsbc');
  assert.strictEqual(hsbc.currency, 'USD');
  assert.strictEqual(hsbc.balanceMinor, 100000);
  assert.strictEqual(hsbc.confirmed, true);
  assert.strictEqual(hsbc.valueCnyMinor, 720000); // 1,000 USD × 7.20

  const holding = c.facts.holdings[0];
  assert.strictEqual(holding.symbol, 'VOO');
  assert.strictEqual(holding.priceMinor, 5000);
  assert.strictEqual(holding.valueMinor, 50000); // 10 × $50.00
  assert.strictEqual(holding.valueCnyMinor, 360000);
});

/* ---------------------- 月结核对清单：缺项与估算 ---------------------- */

test('computeCloseChecklist：余额未核实/未在本月确认时列出缺项且不得正式结账（S3.3）', () => {
  const c = Domain.computeCloseChecklist(
    fixtureAssets((a) => {
      a.assetUnits[1].balanceMinor = null; // 汇丰余额未核实
      a.assetUnits[2].asOf = '2026-08-30'; // 公积金余额未在本月确认（仍为 8 月日期）
    }),
    { now: REF }
  );
  assert.strictEqual(c.canComplete, false);
  assert.strictEqual(c.valuationStatus, 'estimate');
  const codes = {};
  c.items.forEach((it) => { codes[it.code] = it; });
  assert.strictEqual(codes.balance_missing.detail, '汇丰 USD 子账户');
  assert.strictEqual(codes.balance_stale.detail, '青岛公积金');
  // 未核实的余额不参与合计，也不按 0 处理
  const hsbc = c.facts.units.find((u) => u.id === 'u-hsbc');
  assert.strictEqual(hsbc.balanceMinor, null);
  assert.strictEqual(hsbc.confirmed, false);
  assert.strictEqual(c.counts.unitsConfirmed, 1);
});

test('computeCloseChecklist：跨月结账时上月余额视为未确认', () => {
  // 用 10 月作为结账月：9 月确认的余额相对 10 月全部过期
  const c = Domain.computeCloseChecklist(fixtureAssets(), { now: '2026-10-05' });
  assert.strictEqual(c.canComplete, false);
  assert.ok(c.items.some((it) => it.code === 'balance_stale'));
  assert.strictEqual(c.counts.unitsConfirmed, 0);
});

test('computeCloseChecklist：无余额保障权益只展示状态，不产生金额缺项', () => {
  const c = Domain.computeCloseChecklist(fixtureAssets(), { now: REF });
  assert.strictEqual(c.facts.entitlements.length, 1);
  assert.strictEqual(c.facts.entitlements[0].balanceMinor, null);
  assert.ok(!c.items.some((it) => it.code === 'balance_missing'));
});

test('computeCloseChecklist：相同输入产生相同输出（结账可复算）', () => {
  const a = fixtureAssets();
  const x = JSON.stringify(Domain.computeCloseChecklist(a, { now: REF }));
  const y = JSON.stringify(Domain.computeCloseChecklist(a, { now: REF }));
  assert.strictEqual(x, y);
});
