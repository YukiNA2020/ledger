/* Phase 4E 估值下钻与收益归因领域行为测试（D-045 / D-025）
 * 覆盖 ACCEPTANCE S4E.1 的领域侧口径：
 *   - as-of 查询（findQuoteAsOf / findFxRateAsOf）**绝不返回基准日之后的行**；
 *   - holdingsAsOf 在基准日重放事件（复用 deriveHoldings，不另写加减）；
 *   - computeAssetDrilldown 四个维度的合计与 computeOverview 一致，且未计入合计的项不静默消失；
 *   - computeReturnAttribution：价格影响 + 汇率影响 = 估值变化（逐行恒等）；
 *   - 不可归因的五类边界逐条显式标注，绝不插值、绝不用 1:1 兜底；
 *   - computeOverview 的 withItems 是**纯追加**：不带该开关时输出与改动前逐字段相同。
 * 所有金额为虚构数据，仅用于核对公式。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Domain = require('../js/domain.js');

const BASE = '2026-08-31'; // 期初基准（模拟上月末已结账快照的 asOf）
const NOW = '2026-09-30';  // 期末（今天）

function fixtureAssets(modify) {
  const a = {
    schemaVersion: 1,
    assetAccounts: [
      { id: 'acc-broker', name: '券商账户', kind: 'broker', pool: 'investable', status: 'active' },
      { id: 'acc-safety', name: '应急储蓄', kind: 'bank', pool: 'safety', status: 'active' }
    ],
    assetUnits: [
      { id: 'u-broker', accountId: 'acc-broker', currency: 'CNY', balanceMinor: 3000000, asOf: NOW, sourceType: 'manual' },
      { id: 'u-safety', accountId: 'acc-safety', currency: 'CNY', balanceMinor: 2000000, asOf: NOW, sourceType: 'manual' }
    ],
    liabilities: [],
    entitlements: [],
    instruments: [
      {
        id: 'ins-voo', symbol: 'VOO', exchange: 'NYSE', currency: 'USD', name: '标普500 ETF',
        instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'US', classificationStatus: 'confirmed'
      }
    ],
    holdings: [
      { id: 'h-voo', accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '10', costMinor: 45000, asOf: BASE }
    ],
    quotes: [
      { instrumentId: 'ins-voo', priceMinor: 5000, currency: 'USD', priceDate: BASE, fetchedAt: BASE + 'T08:00:00Z', provider: 'manual' },
      { instrumentId: 'ins-voo', priceMinor: 5500, currency: 'USD', priceDate: NOW, fetchedAt: NOW + 'T08:00:00Z', provider: 'manual' }
    ],
    fxRates: [
      { base: 'USD', quote: 'CNY', rateDecimal: '7.00', rateDate: BASE, fetchedAt: BASE + 'T08:00:00Z', provider: 'manual' },
      { base: 'USD', quote: 'CNY', rateDecimal: '7.10', rateDate: NOW, fetchedAt: NOW + 'T08:00:00Z', provider: 'manual' }
    ],
    securityEvents: []
  };
  if (modify) modify(a);
  return a;
}

// 期初基准 = 已结账月快照的封存明细（G4E-1 复核补口）：期初腿只认这份事实，
// 不从当前事实表按历史日期重算。默认值对应 fixtureAssets 的期初事实：
// 8 月末 10 股 × 5000（USD，manual）× 7.00。
const BASELINE_POSITIONS = [
  {
    accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '10',
    priceMinor: 5000, priceCurrency: 'USD', priceDate: BASE, priceProvider: 'manual',
    fxRateDecimal: '7.00', fxRateDate: BASE, fxProvider: 'manual',
    eventCounts: { buy: 0, sell: 0, dividend: 0, fee: 0 }
  }
];

const BASELINE = {
  asOf: BASE,
  month: '2026-08',
  closeId: 'close-2026-08',
  snapshotId: 'snap-2026-08',
  payloadHash: 'deadbeef',
  positions: BASELINE_POSITIONS
};

function drilldownOf(assets, opts) {
  return Domain.computeAssetDrilldown(assets, Object.assign({ now: NOW }, opts || {}));
}

function attributionOf(assets, opts) {
  return Domain.computeReturnAttribution(assets, Object.assign({ now: NOW, baseline: BASELINE }, opts || {}));
}

/* ---------------------- as-of 查询 ---------------------- */

test('findQuoteAsOf 只认基准日当天及之前，绝不返回未来行', () => {
  const quotes = [
    { instrumentId: 'i1', priceMinor: 4800, currency: 'USD', priceDate: '2026-08-25', provider: 'manual' },
    { instrumentId: 'i1', priceMinor: 9900, currency: 'USD', priceDate: '2026-09-30', provider: 'manual' }
  ];
  const at = Domain.findQuoteAsOf(quotes, 'i1', '2026-08-31');
  assert.strictEqual(at.priceMinor, 4800, '必须取 ≤ 基准日的最近一条，而不是全局最新一条');
  assert.strictEqual(at.priceDate, '2026-08-25');
  assert.strictEqual(Domain.findQuoteAsOf(quotes, 'i1', '2026-08-24'), null, '基准日之前没有任何观测必须返回 null');
  assert.strictEqual(Domain.findQuoteAsOf(quotes, 'i1', '2026-09-30').priceMinor, 9900);
  assert.strictEqual(Domain.findQuoteAsOf(quotes, 'i2', '2026-08-31'), null);
  assert.strictEqual(Domain.findQuoteAsOf(quotes, 'i1', null), null, '没有基准日就没有历史观测');
  assert.strictEqual(Domain.findQuoteAsOf(quotes, 'i1', ''), null);
  // 同日多条取一条（确定性），且非法价格被跳过
  const dup = [
    { instrumentId: 'i1', priceMinor: 100, currency: 'USD', priceDate: '2026-08-31' },
    { instrumentId: 'i1', priceMinor: 'x', currency: 'USD', priceDate: '2026-08-31' }
  ];
  assert.strictEqual(Domain.findQuoteAsOf(dup, 'i1', '2026-08-31').priceMinor, 100);
  assert.strictEqual(Domain.findQuoteAsOf([{ instrumentId: 'i1', priceMinor: NaN, priceDate: '2026-08-31' }], 'i1', '2026-08-31'), null);
});

test('findFxRateAsOf 方向精确匹配，不取倒数，也不返回未来行', () => {
  const rates = [
    { base: 'USD', quote: 'CNY', rateDecimal: '7.10', rateDate: '2026-09-15', provider: 'manual' },
    { base: 'CNY', quote: 'USD', rateDecimal: '0.14', rateDate: '2026-08-20', provider: 'manual' }
  ];
  assert.strictEqual(Domain.findFxRateAsOf(rates, 'USD', 'CNY', '2026-08-31'), null, '未来汇率不得用来回算历史');
  assert.strictEqual(Domain.findFxRateAsOf(rates, 'USD', 'CNY', '2026-09-15').rateDecimal, '7.10');
  assert.strictEqual(Domain.findFxRateAsOf(rates, 'USD', 'CNY', '2026-09-14'), null);
  // 方向必须精确：登记的是 CNY/USD，查 USD/CNY 就该没有
  assert.strictEqual(Domain.findFxRateAsOf(rates, 'USD', 'CNY', '2026-08-25'), null);
  assert.strictEqual(Domain.findFxRateAsOf(rates, 'CNY', 'USD', '2026-08-25').rateDecimal, '0.14');
  assert.strictEqual(Domain.findFxRateAsOf(rates, 'USD', 'CNY', null), null);
  assert.strictEqual(Domain.findFxRateAsOf([{ base: 'USD', quote: 'CNY', rateDecimal: 'abc', rateDate: '2026-08-01' }], 'USD', 'CNY', '2026-08-31'), null);
});

/* ---------------------- 基准日数量重放 ---------------------- */

test('holdingsAsOf 按基准日截断后交给 deriveHoldings 重放（期初/事件两条边都截断）', () => {
  const openings = [{ id: 'h1', accountId: 'a1', instrumentId: 'i1', quantity: '10', asOf: '2026-09-06' }];
  const events = [{ id: 'e1', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '2', occurredAt: '2026-09-01' }];

  // 基准日早于期初快照：期初在那一刻还不存在，只能按当时可见的事件推导
  assert.strictEqual(Domain.holdingsAsOf(openings, events, '2026-08-31').byKey['a1|i1'], undefined);
  assert.strictEqual(Domain.holdingsAsOf(openings, events, '2026-08-31').holdings.length, 0);
  // 基准日落在期初之前、事件之后
  assert.strictEqual(Domain.holdingsAsOf(openings, events, '2026-09-03').byKey['a1|i1'].quantity, '2');
  // 基准日 = 期初当日：期初计入，早于期初的事件按 D-042 ⑦ 视为已含在快照内（不叠加）
  assert.strictEqual(Domain.holdingsAsOf(openings, events, '2026-09-06').byKey['a1|i1'].quantity, '10');
  assert.deepStrictEqual(Domain.holdingsAsOf(openings, events, '2026-09-06').byKey['a1|i1'].boundarySkippedEvents, ['e1']);
  // 没有基准日 → 空
  assert.strictEqual(Domain.holdingsAsOf(openings, events, null).holdings.length, 0);
  // 缺 occurredAt 的事件不是可用事实，不得参与历史重放
  const noDate = [{ id: 'e2', accountId: 'a1', instrumentId: 'i1', eventType: 'buy', quantity: '2' }];
  assert.strictEqual(Domain.holdingsAsOf([], noDate, '2026-09-30').holdings.length, 0);
});

/* ---------------------- 估值下钻 ---------------------- */

test('computeOverview 的 withItems 是纯追加：不带开关时输出逐字段不变', () => {
  const a = fixtureAssets();
  const plain = Domain.computeOverview(a, { now: NOW });
  assert.ok(!Object.prototype.hasOwnProperty.call(plain, 'items'), '默认不得带 items，保证结账快照 payload 形状不变');
  const detailed = Domain.computeOverview(a, { now: NOW, withItems: true });
  assert.ok(Array.isArray(detailed.items));
  assert.strictEqual(detailed.items.length, 3, '2 个余额单元 + 1 条持仓都要留痕');
  delete detailed.items;
  assert.deepStrictEqual(detailed, plain, '除追加的 items 外，任何字段都不允许变化');
});

test('computeAssetDrilldown 四维度合计与总览一致，且逐持仓可追溯到价格日/来源/汇率', () => {
  const a = fixtureAssets();
  const ov = Domain.computeOverview(a, { now: NOW });
  const dd = drilldownOf(a);

  // 总览：现金 3,000,000 + 2,000,000 = 5,000,000（分）
  //       持仓 10 × 5500 = 55000 USD 分 → ×7.10 = 390,500 分
  assert.strictEqual(ov.totalAssetsMinor, 5390500);
  assert.strictEqual(dd.totals.totalAssetsMinor, ov.totalAssetsMinor);
  assert.strictEqual(dd.totals.investableMinor, ov.pools.investableMinor);

  assert.ok(dd.consistency.byAccountMatches, '机构维度合计必须等于总资产');
  assert.ok(dd.consistency.byCurrencyMatches, '币种维度合计必须等于总资产');
  assert.ok(dd.consistency.byAssetClassMatches, '资产类别维度合计必须等于投资池');
  assert.ok(dd.consistency.byMarketMatches, '市场维度合计必须等于投资池持仓合计');
  assert.strictEqual(dd.consistency.sumByAccountMinor, ov.totalAssetsMinor);
  assert.strictEqual(dd.consistency.sumByCurrencyMinor, ov.totalAssetsMinor);
  assert.strictEqual(dd.consistency.sumByAssetClassMinor, ov.pools.investableMinor);
  assert.strictEqual(dd.consistency.sumByMarketMinor, dd.totals.investableHoldingsMinor);
  // 投资池现金 + 投资池持仓 = 投资池
  assert.strictEqual(dd.totals.investableCashMinor + dd.totals.investableHoldingsMinor, ov.pools.investableMinor);

  // 机构维度：券商 3,000,000 + 390,500；应急储蓄 2,000,000
  const broker = dd.byAccount.find((g) => g.key === 'acc-broker');
  const safety = dd.byAccount.find((g) => g.key === 'acc-safety');
  assert.strictEqual(broker.valueCnyMinor, 3390500);
  assert.strictEqual(broker.label, '券商账户');
  assert.strictEqual(safety.valueCnyMinor, 2000000);
  // 币种维度：CNY 现金 5,000,000；USD 持仓 390,500
  assert.strictEqual(dd.byCurrency.find((g) => g.key === 'CNY').valueCnyMinor, 5000000);
  assert.strictEqual(dd.byCurrency.find((g) => g.key === 'USD').valueCnyMinor, 390500);
  // 资产类别维度（投资池）：现金 3,000,000 + broad_equity 390,500
  assert.strictEqual(dd.byAssetClass.find((g) => g.key === 'cash').valueCnyMinor, 3000000);
  assert.strictEqual(dd.byAssetClass.find((g) => g.key === 'broad_equity').valueCnyMinor, 390500);
  // 市场维度（投资池持仓）：US
  assert.deepStrictEqual(dd.byMarket.map((g) => g.key), ['US']);
  assert.strictEqual(dd.byMarket[0].valueCnyMinor, 390500);

  // 逐持仓追溯：数量 / 价格 / 价格日 / 来源 / 汇率 / 汇率日 / 来源一个都不能少
  assert.strictEqual(dd.positions.length, 1);
  const p = dd.positions[0];
  assert.strictEqual(p.instrumentId, 'ins-voo');
  assert.strictEqual(p.quantity, '10');
  assert.strictEqual(p.priceMinor, 5500);
  assert.strictEqual(p.priceDate, NOW);
  assert.strictEqual(p.priceProvider, 'manual');
  assert.strictEqual(p.fxRateDecimal, '7.10');
  assert.strictEqual(p.fxRateDate, NOW);
  assert.strictEqual(p.fxProvider, 'manual');
  assert.strictEqual(p.valueLocalMinor, 55000);
  assert.strictEqual(p.valueCnyMinor, 390500);
  assert.strictEqual(p.exposureMarket, 'US');
  assert.strictEqual(p.assetClass, 'broad_equity');
});

test('估值下钻：缺汇率的持仓留在组里（unvaluedCount），不静默消失也不改合计口径', () => {
  const a = fixtureAssets((x) => {
    x.instruments.push({
      id: 'ins-hk', symbol: '2800', exchange: 'HKEX', currency: 'HKD', name: '盈富基金',
      instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'HK', classificationStatus: 'confirmed'
    });
    x.holdings.push({ id: 'h-hk', accountId: 'acc-broker', instrumentId: 'ins-hk', quantity: '100', costMinor: 200000, asOf: BASE });
    x.quotes.push({ instrumentId: 'ins-hk', priceMinor: 2000, currency: 'HKD', priceDate: NOW, fetchedAt: NOW + 'T08:00:00Z', provider: 'manual' });
    // 刻意不登记 HKD/CNY：折算必须失败，而不是按 1:1 兜底
  });
  const ov = Domain.computeOverview(a, { now: NOW });
  const dd = drilldownOf(a);

  assert.ok(ov.blockers.some((b) => b.code === 'fx_missing' && b.detail === 'HKD'), '缺汇率必须是显式阻塞');
  const hk = dd.positions.find((p) => p.instrumentId === 'ins-hk');
  assert.strictEqual(hk.valueCnyMinor, null);
  assert.strictEqual(hk.skipped, 'missing_fx');
  assert.strictEqual(hk.priceDate, NOW, '算不出 CNY 估值，但价格追溯字段仍要给出');
  // 组里必须看得见这条被漏掉的项
  const broker = dd.byAccount.find((g) => g.key === 'acc-broker');
  assert.strictEqual(broker.unvaluedCount, 1);
  assert.strictEqual(broker.itemCount, 3);
  // 两个口径同进同出：合计仍然一致
  assert.strictEqual(dd.consistency.sumByAccountMinor, ov.totalAssetsMinor);
  assert.ok(dd.consistency.byAccountMatches);
  assert.ok(dd.consistency.byAssetClassMatches);
  assert.ok(dd.consistency.byMarketMatches);
});

test('估值下钻：未填敞口市场的持仓归入 unspecified 桶，不冒充任何真实市场', () => {
  const a = fixtureAssets((x) => {
    delete x.instruments[0].exposureMarket;
  });
  const dd = drilldownOf(a);
  assert.deepStrictEqual(dd.byMarket.map((g) => g.key), [Domain.MARKET_UNSPECIFIED]);
  assert.ok(dd.consistency.byMarketMatches);
});

test('估值下钻：负债不进资产项维度，单列在 totals 里', () => {
  const a = fixtureAssets((x) => {
    x.liabilities.push({ id: 'l1', name: '信用卡', currency: 'CNY', balanceMinor: 500000, asOf: NOW, termType: 'current' });
  });
  const ov = Domain.computeOverview(a, { now: NOW });
  const dd = drilldownOf(a);
  assert.strictEqual(dd.totals.totalLiabilitiesMinor, 500000);
  assert.strictEqual(dd.consistency.sumByAccountMinor, ov.totalAssetsMinor, '负债不得混进资产项合计');
  assert.strictEqual(dd.totals.netWorthMinor, ov.totalAssetsMinor - 500000);
});

/* ---------------------- 收益归因 ---------------------- */

test('computeReturnAttribution：价格影响与汇率影响逐行相加恒等于估值变化', () => {
  const a = fixtureAssets();
  const at = attributionOf(a);
  assert.strictEqual(at.rows.length, 1);
  const r = at.rows[0];

  // L0 = 10×5000 = 50000 → V0 = 50000×7.00 = 350000
  // L1 = 10×5500 = 55000 → V1 = 55000×7.10 = 390500
  assert.strictEqual(r.startQuantity, '10');
  assert.strictEqual(r.endQuantity, '10');
  assert.strictEqual(r.startValueLocalMinor, 50000);
  assert.strictEqual(r.endValueLocalMinor, 55000);
  assert.strictEqual(r.startValueCnyMinor, 350000);
  assert.strictEqual(r.endValueCnyMinor, 390500);
  assert.strictEqual(r.valueChangeCnyMinor, 40500);
  // 价格影响 = (55000−50000)×7.00 = 35000；汇率影响 = 40500−35000 = 5500（= 55000×0.10）
  assert.strictEqual(r.priceEffectCnyMinor, 35000);
  assert.strictEqual(r.fxEffectCnyMinor, 5500);
  assert.strictEqual(r.priceEffectCnyMinor + r.fxEffectCnyMinor, r.valueChangeCnyMinor);
  assert.strictEqual(r.attributable, true);
  assert.deepStrictEqual(r.boundaries, []);

  // 两端口径都带追溯字段
  assert.strictEqual(r.startPriceDate, BASE);
  assert.strictEqual(r.startPriceProvider, 'manual');
  assert.strictEqual(r.startRateDecimal, '7.00');
  assert.strictEqual(r.startRateDate, BASE);
  assert.strictEqual(r.endRateDecimal, '7.10');
  assert.strictEqual(r.endRateDate, NOW);
  assert.strictEqual(r.endRateProvider, 'manual');
  assert.strictEqual(at.baseline.asOf, BASE);
  assert.strictEqual(at.baseline.month, '2026-08');
  assert.strictEqual(at.baseline.payloadHash, 'deadbeef');
  assert.strictEqual(at.unavailable, null, '有基准日就必须给出归因，不得整段缺席');

  // totals 恒等式：已分解 + 未分解 = 总变化
  assert.strictEqual(at.totals.priceEffectCnyMinor, 35000);
  assert.strictEqual(at.totals.fxEffectCnyMinor, 5500);
  assert.strictEqual(at.totals.unattributedChangeCnyMinor, 0);
  assert.strictEqual(
    at.totals.priceEffectCnyMinor + at.totals.fxEffectCnyMinor + at.totals.unattributedChangeCnyMinor,
    at.totals.valueChangeCnyMinor
  );
});

test('computeReturnAttribution：纯汇率变动全落在汇率一侧，纯价格变动全落在价格一侧', () => {
  // 只动汇率：价格两端都是 5000
  const fxOnly = fixtureAssets((x) => {
    x.quotes = [
      { instrumentId: 'ins-voo', priceMinor: 5000, currency: 'USD', priceDate: BASE, provider: 'manual' },
      { instrumentId: 'ins-voo', priceMinor: 5000, currency: 'USD', priceDate: NOW, provider: 'manual' }
    ];
  });
  const r1 = attributionOf(fxOnly).rows[0];
  assert.strictEqual(r1.priceEffectCnyMinor, 0);
  assert.strictEqual(r1.fxEffectCnyMinor, 5000); // 50000 × (7.10 − 7.00)
  assert.strictEqual(r1.fxEffectCnyMinor, r1.valueChangeCnyMinor);

  // 只动价格：汇率两端都是 7.00
  const pxOnly = fixtureAssets((x) => {
    x.fxRates = [
      { base: 'USD', quote: 'CNY', rateDecimal: '7.00', rateDate: BASE, provider: 'manual' },
      { base: 'USD', quote: 'CNY', rateDecimal: '7.00', rateDate: NOW, provider: 'manual' }
    ];
  });
  const r2 = attributionOf(pxOnly).rows[0];
  assert.strictEqual(r2.priceEffectCnyMinor, 35000);
  assert.strictEqual(r2.fxEffectCnyMinor, 0);
  assert.strictEqual(r2.priceEffectCnyMinor, r2.valueChangeCnyMinor);
});

test('computeReturnAttribution：没有基准就不给假基准（no_baseline）', () => {
  const a = fixtureAssets();
  const at = Domain.computeReturnAttribution(a, { now: NOW });
  assert.strictEqual(at.baseline, null);
  assert.strictEqual(at.unavailable, 'no_baseline');
  assert.strictEqual(at.rows.length, 0, '没有基准日就推导不出期初持仓');
  const withNullAsOf = Domain.computeReturnAttribution(a, { now: NOW, baseline: { month: '2026-08' } });
  assert.deepStrictEqual(withNullAsOf.rows, []);
  assert.strictEqual(withNullAsOf.unavailable, 'no_baseline');
  assert.strictEqual(withNullAsOf.totals.valueChangeCnyMinor, 0);
});

test('computeReturnAttribution：缺期初价格 → 不分解，但能算出的变化额照样给出', () => {
  const a = fixtureAssets((x) => {
    x.quotes = [{ instrumentId: 'ins-voo', priceMinor: 5500, currency: 'USD', priceDate: NOW, provider: 'manual' }];
  });
  // 封存明细里价格缺失（结账时就是估算快照）：期初定不了价
  const r = attributionOf(a, {
    baseline: Object.assign({}, BASELINE, {
      positions: [Object.assign({}, BASELINE_POSITIONS[0], { priceMinor: null, priceDate: null, priceProvider: null })]
    })
  }).rows[0];
  assert.ok(r.boundaries.includes('missing_start_quote'));
  assert.strictEqual(r.attributable, false);
  assert.strictEqual(r.priceEffectCnyMinor, null);
  assert.strictEqual(r.fxEffectCnyMinor, null);
  assert.strictEqual(r.valueChangeCnyMinor, null, '期初定不了价，变化额也算不出来');
  assert.strictEqual(r.startPriceMinor, null);
  assert.strictEqual(r.endPriceMinor, 5500, '期末仍可追溯');
});

test('computeReturnAttribution：缺期初汇率 → 不分解，绝不用 1:1 或期末汇率顶替', () => {
  const a = fixtureAssets((x) => {
    x.fxRates = [{ base: 'USD', quote: 'CNY', rateDecimal: '7.10', rateDate: NOW, provider: 'manual' }];
  });
  // 老快照没封存汇率字段：期初汇率就是没有，不能用期末 7.10 或 1:1 顶替
  const r = attributionOf(a, {
    baseline: Object.assign({}, BASELINE, {
      positions: [Object.assign({}, BASELINE_POSITIONS[0], { fxRateDecimal: null, fxRateDate: null, fxProvider: null })]
    })
  }).rows[0];
  assert.ok(r.boundaries.includes('missing_start_fx'));
  assert.strictEqual(r.attributable, false);
  assert.strictEqual(r.startRateDecimal, null);
  assert.strictEqual(r.fxEffectCnyMinor, null);
  assert.strictEqual(r.valueChangeCnyMinor, null);
});

test('computeReturnAttribution：期间买卖 → quantity_changed，给出变化额但不拆成价格/汇率', () => {
  const a = fixtureAssets((x) => {
    x.securityEvents.push({
      id: 'e-buy', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'buy',
      quantity: '5', priceMinor: 5200, occurredAt: '2026-09-10', currency: 'USD'
    });
  });
  const at = attributionOf(a);
  const r = at.rows[0];
  assert.strictEqual(r.startQuantity, '10');
  assert.strictEqual(r.endQuantity, '15');
  assert.ok(r.boundaries.includes('quantity_changed'));
  assert.strictEqual(r.periodEventCounts.buy, 1);
  assert.strictEqual(r.attributable, false);
  // ΔV 仍可算出（期初 10×5000×7.00，期末 15×5500×7.10）
  assert.strictEqual(r.startValueCnyMinor, 350000);
  assert.strictEqual(r.endValueCnyMinor, 585750);
  assert.strictEqual(r.valueChangeCnyMinor, 235750);
  assert.strictEqual(at.totals.unattributedChangeCnyMinor, 235750);
  assert.strictEqual(
    at.totals.priceEffectCnyMinor + at.totals.fxEffectCnyMinor + at.totals.unattributedChangeCnyMinor,
    at.totals.valueChangeCnyMinor
  );
});

test('computeReturnAttribution：期末清仓 → position_closed；无期初买入 → position_opened', () => {
  const closed = fixtureAssets((x) => {
    x.securityEvents.push({
      id: 'e-sell', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'sell',
      quantity: '10', priceMinor: 5500, occurredAt: '2026-09-10', currency: 'USD'
    });
  });
  const rc = attributionOf(closed).rows[0];
  assert.ok(rc.boundaries.includes('position_closed'));
  assert.strictEqual(rc.endQuantity, '0');
  assert.strictEqual(rc.endValueCnyMinor, 0);
  assert.strictEqual(rc.attributable, false);

  const opened = fixtureAssets((x) => {
    x.holdings = [];
    x.securityEvents.push({
      id: 'e-buy2', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'buy',
      quantity: '10', priceMinor: 5200, occurredAt: '2026-09-10', currency: 'USD'
    });
  });
  // 基准快照里没有这条持仓（封存事实里确实没有）→ position_opened
  const ro = attributionOf(opened, {
    baseline: Object.assign({}, BASELINE, { positions: [] })
  }).rows[0];
  assert.ok(ro.boundaries.includes('position_opened'));
  assert.strictEqual(ro.startQuantity, '0');
  assert.strictEqual(ro.startValueCnyMinor, 0, '0 股的期初估值恒为 0（数学事实），ΔV = 期末值');
  assert.strictEqual(ro.valueChangeCnyMinor, 390500, '变化额照样给出（期末 10×5500×7.10）');
  assert.strictEqual(ro.attributable, false);
});

test('computeReturnAttribution：期间重录期初 → opening_rebased（数量跳档不是收益）', () => {
  const a = fixtureAssets((x) => {
    x.holdings = [{ id: 'h-voo', accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '10', costMinor: 45000, asOf: '2026-09-10' }];
  });
  // 基准快照封存时这条持仓还不存在 → 期初 0；同时基准日之后重录了期初 → rebased
  const at = attributionOf(a, {
    baseline: Object.assign({}, BASELINE, { positions: [] })
  });
  const r = at.rows[0];
  assert.ok(r.boundaries.includes('opening_rebased'));
  assert.ok(r.boundaries.includes('position_opened'));
  assert.strictEqual(r.attributable, false);
  assert.strictEqual(r.startQuantity, '0', '期初快照在基准日还不存在，期初数量只能按当时可见事实推导');
  assert.strictEqual(r.endQuantity, '10');
  // 期初重录不是交易：整段跳档计入未分解部分，不进价格/汇率影响
  assert.strictEqual(at.totals.priceEffectCnyMinor, 0);
  assert.strictEqual(at.totals.fxEffectCnyMinor, 0);
});

test('computeReturnAttribution：估值状态沿用既有 blocker 语义，不新造第二套判定', () => {
  const a = fixtureAssets((x) => {
    // 报价过期（> 5 自然日）且分类未确认
    x.quotes = [
      { instrumentId: 'ins-voo', priceMinor: 5000, currency: 'USD', priceDate: BASE, provider: 'manual' },
      { instrumentId: 'ins-voo', priceMinor: 5500, currency: 'USD', priceDate: '2026-09-01', provider: 'manual' }
    ];
    x.instruments[0].classificationStatus = 'suggested';
  });
  const ov = Domain.computeOverview(a, { now: NOW });
  const at = attributionOf(a);
  assert.strictEqual(at.valuation.canAdvise, ov.canAdvise);
  assert.strictEqual(at.valuation.valuationStatus, ov.valuationStatus);
  assert.strictEqual(at.valuation.canAdvise, false, '行情过期时只能展示估算，不能给正式建议');
  assert.ok(at.blockers.some((b) => b.code === 'quote_stale'));
  assert.ok(at.blockers.some((b) => b.code === 'classification_unconfirmed'));
  assert.deepStrictEqual(at.blockers, ov.blockers, '归因不得增删既有阻塞项');
  // 归因自己的边界码只描述"能不能分解"，不混进 blockers
  assert.ok(at.rows[0].notes.includes('end_quote_stale'));
  assert.ok(at.rows[0].notes.includes('classification_unconfirmed'));
});

test('computeReturnAttribution：不改动事实，相同输入必然得到相同输出', () => {
  const a = fixtureAssets();
  const before = JSON.stringify(a);
  const one = attributionOf(a);
  const two = attributionOf(a);
  assert.deepStrictEqual(one, two);
  assert.strictEqual(JSON.stringify(a), before, '归因是只读计算，不得改动入参');
  const dd1 = drilldownOf(a);
  const dd2 = drilldownOf(a);
  assert.deepStrictEqual(dd1, dd2);
});

test('computeReturnAttribution：现在时点的期末腿与决策台当前估值逐分一致（同一口径）', () => {
  const a = fixtureAssets();
  const dd = drilldownOf(a);
  const at = attributionOf(a);
  const pos = dd.positions.find((p) => p.instrumentId === 'ins-voo');
  assert.strictEqual(at.rows[0].endValueCnyMinor, pos.valueCnyMinor);
  assert.strictEqual(at.rows[0].endPriceMinor, pos.priceMinor);
  assert.strictEqual(at.rows[0].endPriceDate, pos.priceDate);
  assert.strictEqual(at.rows[0].endRateDecimal, pos.fxRateDecimal);
  assert.strictEqual(at.rows[0].endRateDate, pos.fxRateDate);
});

test('computeReturnAttribution：重算旧月份不受结账之后的行情与事件影响（时间窗口封闭）', () => {
  const a = fixtureAssets((x) => {
    // 结账之后才发生的事实：不得进入本期
    x.securityEvents.push({
      id: 'e-future', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'buy',
      quantity: '5', priceMinor: 6000, occurredAt: '2026-10-15', currency: 'USD'
    });
  });
  // 7 月封存明细里这条持仓没封存到价格（当时就是估算快照）→ 期初定不了价：
  // 显式标注，绝不拿 8 月的数据顶替
  const at = Domain.computeReturnAttribution(a, {
    now: BASE,
    baseline: {
      asOf: '2026-07-31', month: '2026-07',
      positions: [{
        accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '10',
        priceMinor: null, priceCurrency: null, priceDate: null, priceProvider: null,
        fxRateDecimal: null, fxRateDate: null, fxProvider: null,
        eventCounts: { buy: 0, sell: 0, dividend: 0, fee: 0 }
      }]
    }
  });
  const r = at.rows[0];
  assert.strictEqual(r.endPriceDate, BASE, '期末价必须取 ≤ 8 月末的那一条，而不是 9 月的新价');
  assert.strictEqual(r.endPriceMinor, 5000);
  assert.strictEqual(r.endRateDate, BASE);
  assert.strictEqual(r.endQuantity, '10', '结账之后才发生的事件不得进入本期');
  assert.strictEqual(r.startQuantity, '10', '期初数量来自封存明细');
  assert.ok(r.boundaries.includes('missing_start_quote'));
  assert.strictEqual(r.attributable, false);
  assert.strictEqual(r.startPriceMinor, null);
});

test('computeReturnAttribution：baseline 原样回显（asOf/月/关账 id/快照 id/哈希/状态）', () => {
  const a = fixtureAssets();
  const at = Domain.computeReturnAttribution(a, {
    now: NOW,
    baseline: Object.assign({}, BASELINE, { status: 'formal' })
  });
  assert.deepStrictEqual(at.baseline, {
    asOf: BASE,
    month: '2026-08',
    closeId: 'close-2026-08',
    snapshotId: 'snap-2026-08',
    payloadHash: 'deadbeef',
    status: 'formal',
    positionsCount: 1,
    detailsUnavailable: null
  });
});

/* ---------------- G4E-1 复核补口：期初腿只认封存明细 ---------------- */

test('G4E-1 computeAttributionBaselinePositions：基准月末 as-of 口径，绝不取未来价格', () => {
  const a = fixtureAssets(); // 事实表里同时存在 9 月末的价格/汇率
  const positions = Domain.computeAttributionBaselinePositions(a, BASE);
  assert.strictEqual(positions.length, 1);
  assert.strictEqual(positions[0].quantity, '10');
  assert.strictEqual(positions[0].priceMinor, 5000, '只许用 ≤ 基准月末的价格，而不是全局最新');
  assert.strictEqual(positions[0].priceDate, BASE);
  assert.strictEqual(positions[0].priceProvider, 'manual');
  assert.strictEqual(positions[0].fxRateDecimal, '7.00');
  assert.strictEqual(positions[0].fxRateDate, BASE);
  assert.deepStrictEqual(positions[0].eventCounts, { buy: 0, sell: 0, dividend: 0, fee: 0 });
  // 这份明细喂回归因，必须得到与 BASELINE 相同的结果（封存 → 复算闭环）
  const at = Domain.computeReturnAttribution(a, {
    now: NOW,
    baseline: Object.assign({}, BASELINE, { positions: positions })
  });
  assert.strictEqual(at.unavailable, null);
  assert.strictEqual(at.rows[0].valueChangeCnyMinor, 40500);
  assert.strictEqual(at.rows[0].attributable, true);
});

test('G4E-1 调用方给不出封存明细 → 整段不出归因，绝不从当前事实表重算期初', () => {
  const a = fixtureAssets(); // 事实表里有完整的 8 月末价格/汇率/期初持仓 —— 也不许用
  const at = Domain.computeReturnAttribution(a, {
    now: NOW,
    baseline: { asOf: BASE, month: '2026-08', closeId: 'close-2026-08', payloadHash: 'deadbeef' }
  });
  assert.strictEqual(at.unavailable, 'baseline_details_missing');
  assert.deepStrictEqual(at.rows, [], '没有封存明细就不给任何归因行');
  assert.strictEqual(at.totals.valueChangeCnyMinor, 0);
  assert.strictEqual(at.baseline.detailsUnavailable, null, 'detailsUnavailable 未声明时由领域层判定');
});

test('G4E-1 基准快照哈希校验失败 / 调用方声明的不可用原因 → 原样透传', () => {
  const a = fixtureAssets();
  const mismatch = Domain.computeReturnAttribution(a, {
    now: NOW,
    baseline: Object.assign({}, BASELINE, { detailsUnavailable: 'baseline_hash_mismatch' })
  });
  assert.strictEqual(mismatch.unavailable, 'baseline_hash_mismatch');
  assert.deepStrictEqual(mismatch.rows, []);
  assert.strictEqual(mismatch.baseline.detailsUnavailable, 'baseline_hash_mismatch');
});

test('G4E-1 结账后回填旧业务日期事实 → 期初腿纹丝不动（领域层反例固化）', () => {
  // 复核复现链路：8 月末价格 50.00 已封存 → 结账后回填 8-31 价格 40.00、汇率 6.50、
  // 8 月中的买入事件。期初必须仍是封存的 50.00 / 7.00 / 10 股，归因结果不变。
  const a = fixtureAssets((x) => {
    x.quotes[0].priceMinor = 4000; // 回填旧价格（比封存值便宜）
    x.fxRates[0].rateDecimal = '6.50'; // 回填旧汇率
    x.securityEvents.push({ // 回填 8 月内的买入事件
      id: 'e-backfill', accountId: 'acc-broker', instrumentId: 'ins-voo', eventType: 'buy',
      quantity: '5', priceMinor: 4000, occurredAt: '2026-08-20', currency: 'USD'
    });
  });
  const at = attributionOf(a);
  const r = at.rows[0];
  assert.strictEqual(r.startQuantity, '10', '期初数量 = 封存值，不随回填漂移');
  assert.strictEqual(r.startPriceMinor, 5000, '期初价格 = 封存值');
  assert.strictEqual(r.startPriceDate, BASE);
  assert.strictEqual(r.startRateDecimal, '7.00', '期初汇率 = 封存值');
  assert.strictEqual(r.startValueCnyMinor, 350000);
  // 回填的 8-20 事件早于期初快照日（8-31）：按 D-042 ⑦ 视为已含在封存数量内，
  // 期末推导仍是 10 股 → 不制造任何新边界，归因完全不受回填影响
  assert.strictEqual(r.endQuantity, '10');
  assert.deepStrictEqual(r.boundaries, [], '回填旧日期事实不得制造任何新边界');
  assert.strictEqual(r.attributable, true);
  assert.strictEqual(r.periodEventCounts.buy, 0, '回填事件已含在期初封存数量内，不再计入期间事件');
  assert.strictEqual(r.valueChangeCnyMinor, 40500);
  assert.strictEqual(r.priceEffectCnyMinor + r.fxEffectCnyMinor, r.valueChangeCnyMinor);
});
