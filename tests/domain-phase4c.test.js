/* Phase 4C 持仓推导领域行为测试（D-042 / D-025）
 * 覆盖 ACCEPTANCE S4C.1 的领域侧口径：
 *   - deriveHoldings 是持有数量的唯一推导实现（期初 + Σ买入 − Σ卖出）；
 *   - 分红/费用不改数量；买入可以无期初快照（从 0 起算）；
 *   - 卖出超额：strict 抛 insufficient_holdings，宽松跳过并留痕；
 *   - computeOverview / computeCloseChecklist 在有事件时改用推导数量（无事件零回归）。
 * 所有金额为虚构数据，仅用于核对公式。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Domain = require('../js/domain.js');

const REF = '2026-09-06';

function fixtureAssets(modify) {
  const a = {
    schemaVersion: 1,
    assetAccounts: [
      { id: 'acc-broker', name: '券商账户', kind: 'broker', pool: 'investable', status: 'active' },
      { id: 'acc-hk', name: '香港券商', kind: 'broker', pool: 'investable', status: 'active' }
    ],
    assetUnits: [
      { id: 'u-broker', accountId: 'acc-broker', currency: 'CNY', balanceMinor: 3000000, asOf: REF, sourceType: 'manual' }
    ],
    liabilities: [],
    entitlements: [],
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
    ],
    securityEvents: []
  };
  if (modify) modify(a);
  return a;
}

function overviewOf(assets, opts) {
  return Domain.computeOverview(assets, Object.assign({ now: REF }, opts || {}));
}

/* ---------------------- 定点数量助手 ---------------------- */

test('compareDecimals 精确比较，不经过浮点', () => {
  assert.strictEqual(Domain.compareDecimals('0.1', '0.10'), 0);
  assert.strictEqual(Domain.compareDecimals('10.3', '10.30'), 0);
  assert.strictEqual(Domain.compareDecimals('10', '9.99999999'), 1);
  assert.strictEqual(Domain.compareDecimals('0.2', '0.30000000'), -1);
  assert.strictEqual(Domain.compareDecimals('abc', '1'), null);
  assert.strictEqual(Domain.compareDecimals('1', ''), null);
});

test('sumQuantities / subtractQuantities 规范化输出', () => {
  assert.strictEqual(Domain.sumQuantities(['0.1', '0.2']), '0.3');
  assert.strictEqual(Domain.sumQuantities(['10', '2.5', '0.05']), '12.55');
  assert.strictEqual(Domain.sumQuantities([]), '0');
  assert.strictEqual(Domain.sumQuantities(['x']), null);
  assert.strictEqual(Domain.subtractQuantities('11', '1'), '10');
  assert.strictEqual(Domain.subtractQuantities('10.5', '0.5'), '10');
  assert.strictEqual(Domain.subtractQuantities('0.30', '0.300'), '0');
  assert.strictEqual(Domain.subtractQuantities('1', '2'), '-1'); // 调用方必须先用 compareDecimals 把关
  assert.strictEqual(Domain.subtractQuantities('a', '1'), null);
});

/* ---------------------- deriveHoldings ---------------------- */

test('S4C.1：期初 10 → 买入 2 → 卖出 1 = 11（分红/费用不改数量）', () => {
  const r = Domain.deriveHoldings(
    [{ id: 'o1', accountId: 'a1', instrumentId: 'i1', quantity: '10', costMinor: 300000, asOf: '2026-09-01' }],
    [
      { id: 'e-buy', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '2', occurredAt: '2026-09-03' },
      { id: 'e-div', accountId: 'a1', instrumentId: 'i1', eventType: 'dividend', amountMinor: 1500, occurredAt: '2026-09-04' },
      { id: 'e-sell', accountId: 'a1', instrumentId: 'i1', eventType: 'sell', quantity: '1', priceMinor: 5200, occurredAt: '2026-09-05' },
      { id: 'e-fee', accountId: 'a1', instrumentId: 'i1', eventType: 'fee', amountMinor: 100, occurredAt: '2026-09-05' }
    ]
  );
  assert.strictEqual(r.holdings.length, 1);
  const h = r.holdings[0];
  assert.strictEqual(h.quantity, '11');
  assert.strictEqual(h.openingId, 'o1');
  assert.strictEqual(h.openingQuantity, '10');
  assert.strictEqual(h.openingCostMinor, 300000);
  assert.deepStrictEqual(h.counts, { buy: 1, sell: 1, dividend: 1, fee: 1 });
  assert.strictEqual(h.firstActivityAt, '2026-09-03');
  assert.strictEqual(h.lastEventAt, '2026-09-05');
  assert.deepStrictEqual(r.invalidEvents, []);
});

test('买入可以没有期初快照：从 0 起算', () => {
  const r = Domain.deriveHoldings([], [
    { id: 'b1', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '7.5', occurredAt: '2026-09-02' }
  ]);
  assert.strictEqual(r.holdings.length, 1);
  assert.strictEqual(r.holdings[0].quantity, '7.5');
  assert.strictEqual(r.holdings[0].openingId, null);
});

test('小数数量不经过浮点：0.1 + 0.2 = 0.3', () => {
  const r = Domain.deriveHoldings([], [
    { id: 'b1', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '0.1', occurredAt: '2026-09-01' },
    { id: 'b2', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '0.2', occurredAt: '2026-09-02' }
  ]);
  assert.strictEqual(r.holdings[0].quantity, '0.3');
});

test('同一标的多账户各自独立推导', () => {
  const r = Domain.deriveHoldings(
    [{ id: 'o1', accountId: 'a1', instrumentId: 'i1', quantity: '10', asOf: '2026-09-01' }],
    [
      { id: 'e1', accountId: 'a1', instrumentId: 'i1', eventType: 'sell', quantity: '3', occurredAt: '2026-09-02' },
      { id: 'e2', accountId: 'a2', instrumentId: 'i1', eventType: 'buy', quantity: '5', occurredAt: '2026-09-02' }
    ]
  );
  assert.strictEqual(r.holdings.length, 2);
  const byAccount = {};
  r.holdings.forEach((h) => { byAccount[h.accountId] = h.quantity; });
  assert.strictEqual(byAccount.a1, '7');
  assert.strictEqual(byAccount.a2, '5');
});

test('事件按 occurred_at 升序重放：数组传入顺序不影响结果', () => {
  // 时间线固定：09-03 买 5 → 09-05 卖 2 = 3；数组顺序颠倒后结果必须一致（重放顺序由 occurred_at 决定）
  const events = [
    { id: 'buy', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '5', occurredAt: '2026-09-03' },
    { id: 'sell', accountId: 'a1', instrumentId: 'i1', eventType: 'sell', quantity: '2', occurredAt: '2026-09-05' }
  ];
  const r1 = Domain.deriveHoldings([], events);
  const r2 = Domain.deriveHoldings([], events.slice().reverse());
  assert.strictEqual(r1.holdings[0].quantity, '3');
  assert.strictEqual(r2.holdings[0].quantity, '3');
});

test('strict 模式：卖出超额抛 insufficient_holdings（写前校验口径）', () => {
  assert.throws(
    () =>
      Domain.deriveHoldings(
        [{ id: 'o1', accountId: 'a1', instrumentId: 'i1', quantity: '2', asOf: '2026-09-01' }],
        [{ id: 's1', accountId: 'a1', instrumentId: 'i1', eventType: 'sell', quantity: '3', occurredAt: '2026-09-02' }],
        { strict: true }
      ),
    (e) => e.code === 'insufficient_holdings' && e.detail.eventId === 's1'
  );
});

test('宽松模式：超额卖出被跳过并留痕，数量不穿零', () => {
  const r = Domain.deriveHoldings([], [
    { id: 's1', accountId: 'a1', instrumentId: 'i1', eventType: 'sell', quantity: '5', occurredAt: '2026-09-01' },
    { id: 'b1', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '4', occurredAt: '2026-09-02' }
  ]);
  const h = r.holdings[0];
  assert.strictEqual(h.quantity, '4');
  assert.deepStrictEqual(h.oversellEvents, ['s1']);
  assert.strictEqual(h.counts.sell, 0); // 被跳过的卖出不计入计数
});

test('非法事件不抛错、不参与推导，eventId 进 invalidEvents', () => {
  const r = Domain.deriveHoldings([], [
    { id: 'bad-type', accountId: 'a1', instrumentId: 'i1', eventType: 'split', quantity: '1', occurredAt: '2026-09-01' },
    { id: 'bad-qty', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: 'abc', occurredAt: '2026-09-01' },
    { id: 'no-ref', accountId: '', instrumentId: 'i1', eventType: 'buy', quantity: '1', occurredAt: '2026-09-01' }
  ]);
  assert.deepStrictEqual(r.invalidEvents, ['bad-type', 'bad-qty', 'no-ref']);
  assert.strictEqual(r.holdings.length, 0);
});

test('同键多行期初取 asOf 最新一行（对历史数据的确定性防御）', () => {
  const r = Domain.deriveHoldings([
    { id: 'o-old', accountId: 'a1', instrumentId: 'i1', quantity: '5', asOf: '2026-08-01' },
    { id: 'o-new', accountId: 'a1', instrumentId: 'i1', quantity: '9', asOf: '2026-09-01' }
  ], []);
  assert.strictEqual(r.holdings.length, 1);
  assert.strictEqual(r.holdings[0].quantity, '9');
  assert.strictEqual(r.holdings[0].openingId, 'o-new');
});

/* ---------------------- computeOverview / computeCloseChecklist 联动 ---------------------- */

test('有证券事件时总览估值使用推导数量（11 × $50 × 7.2）', () => {
  const withEvents = fixtureAssets((a) => {
    // 事件日期必须晚于期初 asOf（REF=09-06，D-042 日期边界）：早于期初的事件视为已含在快照内
    a.securityEvents = [
      { id: 'e1', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'buy', quantity: '2', occurredAt: '2026-09-07' },
      { id: 'e2', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'sell', quantity: '1', occurredAt: '2026-09-08' }
    ];
  });
  const o = overviewOf(withEvents);
  // 11 股 × 5000 分 × 7.2 = 396000 分（CNY），加现金 3000000 → 3396000
  assert.strictEqual(o.totalAssetsMinor, 3396000);

  // 等价口径：把期初直接写成 11（无事件），总览必须给出同一个数
  const equivalent = fixtureAssets((a) => {
    a.holdings = [{ id: 'h-voo', accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '11', costMinor: 45000, asOf: REF }];
  });
  assert.strictEqual(overviewOf(equivalent).totalAssetsMinor, 3396000);
});

test('无事件时总览零回归：与期初快照口径完全一致', () => {
  const base = fixtureAssets();
  const o1 = overviewOf(base);
  base.securityEvents = [];
  const o2 = overviewOf(base);
  assert.strictEqual(o1.totalAssetsMinor, o2.totalAssetsMinor);
  assert.strictEqual(o2.totalAssetsMinor, 3000000 + 10 * 5000 * 7.2);
});

test('事件把数量减到 0 时估值贡献为 0（买入可以无期初，卖出可清仓）', () => {
  const a = fixtureAssets((mod) => {
    mod.holdings = [];
    mod.securityEvents = [
      { id: 'b1', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'buy', quantity: '3', occurredAt: '2026-09-02' },
      { id: 's1', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'sell', quantity: '3', occurredAt: '2026-09-05' }
    ];
  });
  const o = overviewOf(a);
  assert.strictEqual(o.totalAssetsMinor, 3000000);
  // 无报价问题消失（数量为 0 的持仓没有估值需求），但事件引用的标的仍有报价，不产生 quote_missing
  assert.ok(!o.blockers.some((b) => b.code === 'quote_missing'));
});

test('computeCloseChecklist 的持仓事实展示推导数量', () => {
  const a = fixtureAssets((mod) => {
    mod.securityEvents = [
      // 晚于期初 asOf（REF=09-06）的事件才叠加进推导数量
      { id: 'e1', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'buy', quantity: '2', occurredAt: '2026-09-07' }
    ];
  });
  const cl = Domain.computeCloseChecklist(a, { now: REF });
  assert.strictEqual(cl.facts.holdings.length, 1);
  assert.strictEqual(cl.facts.holdings[0].quantity, '12');
  assert.strictEqual(cl.facts.holdings[0].id, 'h-voo'); // openingId 透传，保证事实可追溯到期初快照
});

test('未确认分类标的的事件照常推导（§10 只产生阻塞标记）', () => {
  const a = fixtureAssets((mod) => {
    mod.instruments[0].classificationStatus = 'suggested';
    mod.securityEvents = [
      // 晚于期初 asOf（REF=09-06）的事件才叠加进推导数量
      { id: 'e1', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'buy', quantity: '1', occurredAt: '2026-09-07' }
    ];
  });
  const o = overviewOf(a);
  assert.strictEqual(o.totalAssetsMinor, 3000000 + 11 * 5000 * 7.2); // 照常估值
  assert.ok(o.blockers.some((b) => b.code === 'classification_unconfirmed')); // 但标出未确认
  assert.strictEqual(o.valuationStatus, 'estimate');
});

/* ---------------------- 期初日期边界（G4C-4，D-042 ①） ---------------------- */

test('G4C-4 早于期初 asOf 的事件视为已含在快照内，不重复叠加', () => {
  // 复核复现：期初 10（asOf 09-06）+ 09-01 买入 2 → 不得算成 12
  const r = Domain.deriveHoldings(
    [{ id: 'o1', accountId: 'a1', instrumentId: 'i1', quantity: '10', asOf: '2026-09-06' }],
    [{ id: 'b1', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '2', occurredAt: '2026-09-01' }]
  );
  const h = r.holdings[0];
  assert.strictEqual(h.quantity, '10');
  assert.strictEqual(h.counts.buy, 0);
  assert.deepStrictEqual(h.boundarySkippedEvents, ['b1'], '跳过的事件留痕可追溯');
  assert.strictEqual(h.firstActivityAt, null, '被跳过的事件不参与活动时间戳');
  assert.strictEqual(h.lastEventAt, null);
});

test('G4C-4 期初日当天与之后的事件正常叠加（同日录入流程不受影响）', () => {
  const r = Domain.deriveHoldings(
    [{ id: 'o1', accountId: 'a1', instrumentId: 'i1', quantity: '10', asOf: '2026-09-06' }],
    [
      { id: 'b1', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '2', occurredAt: '2026-09-06' },
      { id: 'b2', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '3', occurredAt: '2026-09-07' }
    ]
  );
  const h = r.holdings[0];
  assert.strictEqual(h.quantity, '15');
  assert.strictEqual(h.counts.buy, 2);
  assert.deepStrictEqual(h.boundarySkippedEvents, []);
  assert.strictEqual(h.lastEventAt, '2026-09-07');
});

test('G4C-4 早于期初的卖出不参与 strict 重放（历史已含在快照内）', () => {
  const r = Domain.deriveHoldings(
    [{ id: 'o1', accountId: 'a1', instrumentId: 'i1', quantity: '10', asOf: '2026-09-06' }],
    [{ id: 's1', accountId: 'a1', instrumentId: 'i1', eventType: 'sell', quantity: '99', occurredAt: '2026-09-01' }],
    { strict: true }
  );
  assert.strictEqual(r.holdings[0].quantity, '10');
});
