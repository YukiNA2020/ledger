/* Phase 5 验收补口 G5-R2｜建议封存输入与当前事实的身份比对（领域层纯函数）
 *
 * 覆盖 PHASE5_REVIEW §3 的 P1 缺陷：认可映射撤销或行情过期后，页面仍显示历史正式建议
 * 「全部门禁通过」。本文件只测 Domain.adviceStaleness / factSignature / mappingSignature：
 *   - 只做「封存的输入与当前事实还是不是同一份」的身份比对，不重算偏离、不重跑门禁、不产出金额；
 *   - 只判 formal 产物（估算建议从未声称门禁通过，改判过期会混淆「未达门槛」与「已过期」）；
 *   - reason 码是冻结词表，页面自行翻译文案（js/app.js 的 ADVICE_STALE_LABELS）；
 *   - factSignature 必须与 server/recommendations.js 的 normalizeInput 同口径，否则页面会把
 *     每一份建议都误判成过期（数组行序、键序差异都不算事实变化）。
 * 页面渲染与浏览器行为见 tests/app-wiring.js；服务端引用一致性见 tests/server-phase5d.test.js。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const Domain = require('../js/domain.js');
const Recommendations = require('../server/recommendations.js');

const ASSETS = {
  assetAccounts: [
    { id: 'acc-hsbc', institution: '汇丰', name: '储蓄', currency: 'HKD', pool: 'investable', confirmed: true },
    { id: 'acc-cash', institution: '现金', name: '备用金', currency: 'CNY', pool: 'safety', confirmed: true }
  ],
  assetUnits: [
    { id: 'u-1', accountId: 'acc-cash', instrumentId: 'cash-cny', balanceMinor: 300000, balanceDate: '2026-09-30', confirmed: true },
    { id: 'u-2', accountId: 'acc-hsbc', instrumentId: 'voo', balanceMinor: 100000, balanceDate: '2026-09-30', confirmed: true }
  ],
  quotes: [{ instrumentId: 'voo', priceDecimal: '500.00', priceDate: '2026-09-30', provider: 'manual' }],
  fxRates: [{ base: 'HKD', quote: 'CNY', rateDecimal: '0.92', rateDate: '2026-09-30', provider: 'manual' }],
  instruments: [{ id: 'voo', symbol: 'VOO', name: 'Vanguard S&P 500' }],
  holdings: [], assetTransfers: [], liabilities: [], entitlements: [], securityEvents: []
};

const SEALED_MAPPING = [
  { assetClass: 'broad_equity', instrumentId: 'voo', position: 1 },
  { assetClass: 'cash', instrumentId: 'cash-cny', position: 2 }
];

function sig(assets) { return Domain.factSignature(assets); }

function makeItem(over) {
  over = over || {};
  const status = over.status || 'formal';
  const recommendation = {
    assessmentId: over.assessmentId || 'asmt-1',
    targetId: over.targetId || 'tgt-1',
    gate: {
      capture: Object.assign({
        assets: ASSETS,
        approvedInstruments: SEALED_MAPPING,
        riskAssessments: [],
        allocationTargets: []
      }, over.capture || {})
    }
  };
  return { status, recommendation };
}

function makeView(over) {
  over = over || {};
  return Object.assign({
    status: 'current',
    assessment: { id: 'asmt-1' },
    target: { id: 'tgt-1' },
    allocation: { canAdvise: true, valuationStatus: 'formal' },
    mapping: { rows: [
      { assetClass: 'broad_equity', instrumentId: 'voo', symbol: 'VOO', status: 'confirmed' },
      { assetClass: 'cash', instrumentId: 'cash-cny', symbol: 'CNY-CASH', status: 'confirmed' }
    ] }
  }, over);
}

test('G5-R2：封存输入与当前事实完全一致时没有任何过期理由', () => {
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem(), makeView(), sig(ASSETS)), []);
});

test('G5-R2：估算建议不做身份比对（从未声称门禁通过）', () => {
  const changed = Object.assign({}, ASSETS, { quotes: [
    { instrumentId: 'voo', priceDecimal: '499.00', priceDate: '2026-08-01', provider: 'manual' }
  ] });
  const view = makeView({ allocation: { canAdvise: false, valuationStatus: 'stale_quote' } });
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem({ status: 'estimate' }), view, sig(changed)), []);
});

test('G5-R2：撤销认可映射后只判 mapping_changed，且不再返回空', () => {
  const view = makeView({ mapping: { rows: [] } });
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem(), view, sig(ASSETS)), ['mapping_changed']);
});

test('G5-R2：只比类别与标的身份，视图派生字段（symbol/status/position）不算事实变化', () => {
  const view = makeView({ mapping: { rows: [
    { assetClass: 'broad_equity', instrumentId: 'voo', symbol: 'VOO.US', status: 'stale_price', position: 9 },
    { assetClass: 'cash', instrumentId: 'cash-cny', symbol: 'CNY-CASH', status: 'pending', position: 3 }
  ] } });
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem(), view, sig(ASSETS)), []);
  const other = makeView({ mapping: { rows: [
    { assetClass: 'broad_equity', instrumentId: 'vgt', symbol: 'VGT', status: 'confirmed' }
  ] } });
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem(), other, sig(ASSETS)), ['mapping_changed']);
});

test('G5-R2：资产 / 行情 / 汇率变化判 assets_changed', () => {
  const changed = JSON.parse(JSON.stringify(ASSETS));
  changed.quotes[0].priceDecimal = '501.00';
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem(), makeView(), sig(changed)), ['assets_changed']);
});

test('G5-R2：页面尚未读到资产（assetsSig 为 null）时不据此判过期', () => {
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem(), makeView(), null), []);
});

test('G5-R2：服务端 canAdvise=false（行情过期 / 分类未确认）判 valuation_not_formal', () => {
  const view = makeView({ allocation: { canAdvise: false, valuationStatus: 'stale_quote' } });
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem(), view, sig(ASSETS)), ['valuation_not_formal']);
});

test('G5-R2：评估或目标被换掉时按引用 id 判，且与映射/资产变化可叠加', () => {
  assert.deepStrictEqual(
    Domain.adviceStaleness(makeItem(), makeView({ assessment: { id: 'asmt-2' } }), sig(ASSETS)),
    ['assessment_changed']);
  assert.deepStrictEqual(
    Domain.adviceStaleness(makeItem(), makeView({ target: { id: 'tgt-2' } }), sig(ASSETS)),
    ['target_changed']);
  const both = makeView({ assessment: { id: 'asmt-2' }, allocation: { canAdvise: false } });
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem(), both, sig(ASSETS)),
    ['valuation_not_formal', 'assessment_changed']);
});

test('G5-R2：当前没有生效目标版本时只给 target_not_current（不叠加其它理由）', () => {
  const view = makeView({ status: 'stale_assessment', target: null, mapping: { rows: [] } });
  assert.deepStrictEqual(Domain.adviceStaleness(makeItem(), view, sig(ASSETS)), ['target_not_current']);
});

test('G5-R2：缺 gate.capture 的历史记录不抛异常', () => {
  const item = { status: 'formal', recommendation: { assessmentId: 'asmt-1', targetId: 'tgt-1', gate: {} } };
  const reasons = Domain.adviceStaleness(item, makeView(), sig(ASSETS));
  assert.deepStrictEqual(reasons, ['mapping_changed', 'assets_changed']);
  assert.deepStrictEqual(Domain.adviceStaleness(null, makeView(), sig(ASSETS)), []);
  assert.deepStrictEqual(Domain.adviceStaleness(item, null, sig(ASSETS)), []);
});

test('G5-R2：reason 码是冻结词表，页面文案必须一一对应', () => {
  assert.deepStrictEqual(Domain.ADVICE_STALE_REASON_CODES.slice().sort(), [
    'assets_changed', 'assessment_changed', 'mapping_changed',
    'target_changed', 'target_not_current', 'valuation_not_formal'
  ].sort());
});

test('G5-R2：factSignature 与服务端 normalizeInput 同口径（行序 / 键序不算变化）', () => {
  const shuffled = JSON.parse(JSON.stringify(ASSETS));
  shuffled.assetUnits.reverse();
  shuffled.quotes.reverse();
  shuffled.assetAccounts = shuffled.assetAccounts.map((row) => {
    const swapped = {};
    Object.keys(row).reverse().forEach((k) => { swapped[k] = row[k]; });
    return swapped;
  });
  assert.strictEqual(sig(shuffled), sig(ASSETS), '同一份事实的不同行序 / 键序必须同签名');
  assert.strictEqual(
    sig(Recommendations.normalizeInput({ assets: ASSETS }).assets),
    sig(ASSETS),
    '服务端封存的 capture.assets 必须与页面签名一致，否则每份建议都会被误判过期'
  );
  const changed = JSON.parse(JSON.stringify(ASSETS));
  changed.fxRates[0].rateDecimal = '0.93';
  assert.notStrictEqual(sig(changed), sig(ASSETS), '汇率变化必须改变签名');
});
