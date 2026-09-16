/* Phase 4B 标的目录编排模块测试（server/instrument-catalog.js）
 *
 * 对应 ACCEPTANCE.md S4B.1 的完整链路：
 *   检索 → 预分类（suggested）→ 用户确认（confirmed）→ 再刷新不覆盖确认值；
 *   缺失/冲突元数据明确提示；同一标的不重复创建事实。
 * 以及 ROADMAP Phase 4B 工作项 3–5、DECISIONS D-037（本地锁定）、
 * ARCHITECTURE §5.2（服务端是唯一事实源）、§10（classification_unconfirmed）。
 *
 * 全部离线：provider 固定为 Phase 4A 的 fixture，绝不访问真实行情网络。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const Catalog = require('../server/instrument-catalog');
const Contract = require('../server/providers/contract');
const Fixture = require('../server/providers/fixture');
const R = require('../server/repository');
const Domain = require('../js/domain.js');
const { setup } = require('./server-helpers');

const NOW = '2026-09-15T08:00:00Z';
const CTX = { now: NOW };

// 检索整体抛异常的 provider：用于验证"provider 挂了"不等于"没搜到"。
const BROKEN_PROVIDER = {
  PROVIDER_ID: 'broken',
  searchInstrument() { throw new Error('boom'); },
  getInstrumentMetadata() { throw new Error('boom'); }
};

// 检索正常但元数据未收录的 provider：用于手工建立标的的分支。
const EMPTY_PROVIDER = {
  PROVIDER_ID: 'empty',
  searchInstrument() { return Promise.resolve([]); },
  getInstrumentMetadata() {
    return Promise.resolve(
      Contract.errorResult({ subject: null, code: Contract.ERRORS.NOT_FOUND, detail: '未收录该代码' })
    );
  }
};

function instrumentsOf(db, symbol) {
  return R.readInstrumentRecords(db).filter((r) => r.symbol === symbol);
}

/* ============================== 稳定标的 id ============================== */

test('稳定 id 由去重键确定性派生，大小写与空白归一后得到同一个 id', () => {
  const id = Catalog.stableInstrumentId('VOO', 'NYSE');
  assert.strictEqual(id, Catalog.stableInstrumentId('voo', 'nyse'));
  assert.strictEqual(id, Catalog.stableInstrumentId(' VOO ', ' NYSE '));
  assert.ok(/^inst-[0-9a-f]{16}$/.test(id), 'id 必须是 inst- + sha1 前 16 位十六进制');
});

test('稳定 id 可被外部按同一口径复算（后续多个证券账户可放心引用）', () => {
  const expected = 'inst-' + crypto.createHash('sha1').update('VOO@NYSE', 'utf8').digest('hex').slice(0, 16);
  assert.strictEqual(Catalog.stableInstrumentId('VOO', 'NYSE'), expected);
  assert.strictEqual(Domain.instrumentKey('VOO', 'NYSE'), 'VOO@NYSE');
});

test('不同标的（代码或交易所不同）得到不同 id；交易所缺失时退化为代码本身这一键', () => {
  const ids = [
    Catalog.stableInstrumentId('VOO', 'NYSE'),
    Catalog.stableInstrumentId('VOO', 'NASDAQ'),
    Catalog.stableInstrumentId('2800.HK', 'HKEX')
  ];
  assert.strictEqual(new Set(ids).size, 3);
  assert.notStrictEqual(
    Catalog.stableInstrumentId('2800.HK', 'HKEX'),
    Catalog.stableInstrumentId('2800.HK', null)
  );
});

/* ============================== 载荷校验（纯函数） ============================== */

test('建立标的载荷：符号归一为大写，来源缺省为 provider', () => {
  const p = Catalog.parseCreatePayload({ symbol: ' voo ' });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.value.symbol, 'VOO');
  assert.strictEqual(p.value.source, 'provider');
});

test('建立标的载荷是白名单：夹带的私有字段一个都进不了产物', () => {
  const p = Catalog.parseCreatePayload({
    symbol: 'VOO',
    accountName: '我的证券账户',
    quantity: 500,
    costMinor: 123456,
    balanceMinor: 999999
  });
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(Object.keys(p.value).sort(), ['source', 'symbol']);
  assert.strictEqual(JSON.stringify(p.value).indexOf('我的证券账户'), -1);
});

test('建立标的载荷：非法符号/来源/币种/分类一律稳定报错且不回显输入原文', () => {
  const dirty = '我的证券账户 001';
  const cases = [
    [{ symbol: dirty }, 'invalid_symbol'],
    [{ symbol: 'VOO', source: 'other' }, 'invalid_source'],
    [{ symbol: 'VOO', currency: 'JPY' }, 'invalid_currency'],
    [{ symbol: 'VOO', exchange: 'NY SE;' }, 'invalid_exchange'],
    [{ symbol: 'VOO', assetClass: '现金' }, 'invalid_asset_class'],
    [{ symbol: 'VOO', exposureMarket: '日本' }, 'invalid_exposure_market'],
    [{ symbol: 'VOO', name: 'x'.repeat(121) }, 'invalid_name'],
    [{ symbol: 'VOO', id: 'bad id' }, 'invalid_id']
  ];
  for (const [body, code] of cases) {
    const p = Catalog.parseCreatePayload(body);
    assert.strictEqual(p.ok, false, JSON.stringify(body));
    assert.strictEqual(p.code, code, JSON.stringify(body));
    assert.strictEqual(p.retryable, false);
    assert.ok(p.message.indexOf(dirty) === -1, '错误信息不得回显输入原文');
  }
});

test('确认载荷：资产类别与敞口市场是用户判断，两项都必须显式给出', () => {
  const missingClass = Catalog.parseConfirmPayload({ instrumentId: 'inst-abc', exposureMarket: 'US' });
  assert.strictEqual(missingClass.ok, false);
  assert.strictEqual(missingClass.code, 'invalid_asset_class');

  const missingMarket = Catalog.parseConfirmPayload({ instrumentId: 'inst-abc', assetClass: 'broad_equity' });
  assert.strictEqual(missingMarket.ok, false);
  assert.strictEqual(missingMarket.code, 'invalid_exposure_market');

  const noId = Catalog.parseConfirmPayload({ assetClass: 'broad_equity', exposureMarket: 'US' });
  assert.strictEqual(noId.code, 'invalid_id');

  const okCases = [
    ['broad_equity', 'US'],
    ['cash', 'CN'],
    ['other', 'other'],
    ['stock', 'global'],
    ['fixed_income', 'HK'],
    ['theme_equity', 'CN']
  ];
  okCases.forEach(([cls, market]) => {
    const ok = Catalog.parseConfirmPayload({ instrumentId: 'inst-abc', assetClass: cls, exposureMarket: market });
    assert.strictEqual(ok.ok, true, cls + '/' + market);
    assert.strictEqual(ok.value.assetClass, cls);
    assert.strictEqual(ok.value.exposureMarket, market);
  });
});

test('敞口市场词表恰好为 CN/HK/US/global/other，不接受其他取值', () => {
  assert.deepStrictEqual(Domain.EXPOSURE_MARKETS, ['CN', 'HK', 'US', 'global', 'other']);
  ['cn', 'hk', 'us', 'GLOBAL', '美国', '', null].forEach((m) => {
    const p = Catalog.parseConfirmPayload({ instrumentId: 'inst-abc', assetClass: 'cash', exposureMarket: m });
    assert.strictEqual(p.ok, false, JSON.stringify(m));
  });
});

/* ============================== 候选与冲突 ============================== */

test('providerFieldsOf 只取 provider 字段快照，缺项为 null（不用空串冒充）', async () => {
  const r = await Fixture.getInstrumentMetadata('MYSTERY.ETF', CTX);
  const fields = Catalog.providerFieldsOf(r);
  assert.deepStrictEqual(Object.keys(fields).sort(), [
    'country', 'currency', 'exchange', 'exchangeTimezone', 'instrumentType', 'name'
  ]);
  assert.strictEqual(fields.currency, 'USD');
  assert.strictEqual(fields.name, null);
  assert.strictEqual(fields.exchange, null);
});

test('冲突只报同名字段差异，且逐条附 provenance；provider 没给的字段不构成冲突', async () => {
  const ctx = setup('ledger-4b-conflict-');
  try {
    const meta = await Fixture.getInstrumentMetadata('VOO', CTX);
    const local = {
      name: '我的标普 500',
      currency: 'USD',
      exchange: 'NYSE',
      instrumentType: 'ETF',
      country: null,
      exchangeTimezone: null,
      providerProvenance: meta.provenance
    };
    const record = Object.assign({}, local, { providerCandidate: Catalog.providerFieldsOf(meta) });
    const conflicts = Catalog.conflictsFor(record);
    assert.strictEqual(conflicts.length, 1, '只有 name 不同，其余同名字段一致或 provider 未给');
    assert.strictEqual(conflicts[0].field, 'name');
    assert.strictEqual(conflicts[0].localValue, '我的标普 500');
    assert.strictEqual(conflicts[0].providerValue, 'Vanguard S&P 500 ETF');
    assert.ok(conflicts[0].provenance, '冲突提示必须带 provenance');
    assert.strictEqual(conflicts[0].provenance.payloadHash, meta.provenance.payloadHash);
  } finally {
    ctx.close();
  }
});

test('没有 provider 候选时既没有冲突，也不凭空生成候选', () => {
  assert.deepStrictEqual(Catalog.conflictsFor({ id: 'inst-a', symbol: 'VOO' }), []);
  assert.deepStrictEqual(Catalog.conflictsFor({}), []);
});

/* ============================== 检索：合并与降级 ============================== */

test('检索合并 provider 候选：本地为空时按 provider 建候选并标注来源', async () => {
  const ctx = setup('ledger-4b-search-');
  try {
    const res = await Catalog.searchCatalog(ctx.db, Fixture, 'voo', CTX);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.query, 'voo');
    assert.strictEqual(res.provider.status, 'ok');
    assert.strictEqual(res.candidates.length, 1);
    const c = res.candidates[0];
    assert.strictEqual(c.symbol, 'VOO');
    assert.strictEqual(c.origin, 'provider');
    assert.strictEqual(c.local, null, '本地还没有这个标的');
    assert.strictEqual(c.provenance.payloadHash, Fixture.payloadHashOf(Fixture.CATALOG.VOO));
    assert.ok(c.userJudgementRequired.indexOf('assetClass') !== -1, '必须明示哪些字段要用户判断');
    assert.ok(c.userJudgementRequired.indexOf('exposureMarket') !== -1);
    assert.ok(
      c.suggestions.some((s) => s.field === 'currency' && s.value === 'USD' && s.basis === 'provider.currency'),
      '预分类建议必须带依据'
    );
    assert.strictEqual(
      c.suggestions.some((s) => s.field === 'assetClass'),
      false,
      'assetClass 无 provider 来源，不得出现在建议里'
    );
  } finally {
    ctx.close();
  }
});

test('检索词非法时返回稳定错误码，不调用 provider', async () => {
  const ctx = setup('ledger-4b-search-bad-');
  try {
    let called = false;
    const spy = {
      PROVIDER_ID: 'spy',
      searchInstrument() { called = true; return Promise.resolve([]); }
    };
    const res = await Catalog.searchCatalog(ctx.db, spy, '  ', CTX);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'invalid_query');
    assert.strictEqual(called, false, '非法检索词不应触发对外调用');
  } finally {
    ctx.close();
  }
});

test('provider 整体失败时仍返回本地命中，并显式报告 provider 状态（不把失败当空结果）', async () => {
  const ctx = setup('ledger-4b-degrade-');
  try {
    await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    const res = await Catalog.searchCatalog(ctx.db, BROKEN_PROVIDER, 'voo', CTX);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.provider.status, 'error');
    assert.strictEqual(res.provider.id, 'broken');
    assert.ok(res.warnings.length >= 1, 'provider 失败必须作为 warning 暴露出来');
    assert.strictEqual(res.candidates.length, 1);
    assert.strictEqual(res.candidates[0].origin, 'local');
    assert.strictEqual(res.candidates[0].local.id, Catalog.stableInstrumentId('VOO', 'NYSE'));
  } finally {
    ctx.close();
  }
});

test('检索时本地与 provider 命中同一标的只出现一条候选（不重复）', async () => {
  const ctx = setup('ledger-4b-merge-');
  try {
    await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    const res = await Catalog.searchCatalog(ctx.db, Fixture, 'vanguard', CTX);
    assert.strictEqual(res.candidates.length, 1, '同一去重键只能有一条候选');
    const c = res.candidates[0];
    assert.strictEqual(c.origin, 'local+provider');
    assert.ok(c.local && c.local.id, '本地已有的标的要带出本地记录');
    assert.strictEqual(c.local.classificationStatus, 'suggested');
  } finally {
    ctx.close();
  }
});

test('检索结果不夹带任何账户/持仓字段（隐私边界）', async () => {
  const ctx = setup('ledger-4b-privacy-');
  try {
    const res = await Catalog.searchCatalog(ctx.db, Fixture, 'voo', CTX);
    const text = JSON.stringify(res);
    ['accountName', 'accountId', 'quantity', 'costMinor', 'balanceMinor', 'holding'].forEach((k) => {
      assert.strictEqual(text.indexOf(k), -1, k + ' 不得出现在检索结果里');
    });
  } finally {
    ctx.close();
  }
});

/* ============================== 建立/刷新标的 ============================== */

test('provider 来源建立标的：字段来自参考数据，状态一律是 suggested（不得自动确认）', async () => {
  const ctx = setup('ledger-4b-create-');
  try {
    const res = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.duplicated, false);
    assert.strictEqual(res.preserved, false);

    const item = res.item;
    assert.strictEqual(item.id, Catalog.stableInstrumentId('VOO', 'NYSE'));
    assert.strictEqual(item.symbol, 'VOO');
    assert.strictEqual(item.exchange, 'NYSE');
    assert.strictEqual(item.currency, 'USD');
    assert.strictEqual(item.name, 'Vanguard S&P 500 ETF');
    assert.strictEqual(item.source, 'provider');
    assert.strictEqual(item.classificationStatus, 'suggested');
    assert.strictEqual(item.assetClass, null, 'assetClass 不得由 provider 生成');
    assert.strictEqual(item.exposureMarket, null);
    assert.ok(item.confirmedAt == null, '未确认的标的不得带确认时间');
    assert.strictEqual(item.providerProvenance.payloadHash, Fixture.payloadHashOf(Fixture.CATALOG.VOO));
    assert.ok(Contract.isProvenance(item.providerProvenance));
    assert.ok(res.suggestions.some((s) => s.field === 'currency'));
  } finally {
    ctx.close();
  }
});

test('同一标的重复建立不会多出第二行事实（id 相同、幂等）', async () => {
  const ctx = setup('ledger-4b-idem-');
  try {
    const first = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    const second = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    assert.strictEqual(first.item.id, second.item.id);
    assert.strictEqual(second.duplicated, true);
    assert.strictEqual(instrumentsOf(ctx.db, 'VOO').length, 1, '同一标的不允许两行');
  } finally {
    ctx.close();
  }
});

test('provider 没有的代码返回 instrument_not_found（不是 500，也不是静默成功）', async () => {
  const ctx = setup('ledger-4b-nf-');
  try {
    const res = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'NOPE.ZZ' }, CTX);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'instrument_not_found');
    assert.strictEqual(R.readInstrumentRecords(ctx.db).length, 0, '失败时不得写入任何标的');
  } finally {
    ctx.close();
  }
});

test('provider 返回不可入账元数据时拒绝建立标的（坏数据不入库）', async () => {
  const ctx = setup('ledger-4b-badmeta-');
  try {
    const res = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'BADMETA.ETF' }, CTX);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'invalid_provider_payload');
    assert.strictEqual(R.readInstrumentRecords(ctx.db).length, 0);
  } finally {
    ctx.close();
  }
});

test('provider 不可用时报 provider_unavailable 且不写入', async () => {
  const ctx = setup('ledger-4b-unavail-');
  try {
    const res = await Catalog.createInstrument(ctx.db, BROKEN_PROVIDER, { symbol: 'VOO' }, CTX);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'provider_unavailable');
    assert.strictEqual(R.readInstrumentRecords(ctx.db).length, 0);
  } finally {
    ctx.close();
  }
});

test('提交币种与参考数据不一致时明确报错，不静默二选一', async () => {
  const ctx = setup('ledger-4b-fxmismatch-');
  try {
    const res = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO', currency: 'HKD' }, CTX);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'currency_mismatch');
    assert.strictEqual(R.readInstrumentRecords(ctx.db).length, 0);
  } finally {
    ctx.close();
  }
});

test('手工建立标的（provider 未覆盖，如 A 股本土 ETF）：币种必填且来源标记为 manual', async () => {
  const ctx = setup('ledger-4b-manual-');
  try {
    const missing = await Catalog.createInstrument(
      ctx.db, EMPTY_PROVIDER, { symbol: '159915.SZ', source: 'manual' }, CTX
    );
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.code, 'invalid_currency');

    const res = await Catalog.createInstrument(
      ctx.db,
      EMPTY_PROVIDER,
      { symbol: '159915.SZ', source: 'manual', currency: 'CNY', name: '创业板 ETF', exchange: 'SZSE' },
      CTX
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.source, 'manual');
    assert.strictEqual(res.item.currency, 'CNY');
    assert.strictEqual(res.item.exchange, 'SZSE');
    assert.strictEqual(res.item.classificationStatus, 'suggested');
    assert.strictEqual(res.item.providerProvenance, undefined, '手工来源没有 provider 留档');
    assert.strictEqual(instrumentsOf(ctx.db, '159915.SZ').length, 1);
  } finally {
    ctx.close();
  }
});

test('先手工建标的、后由 provider 补全交易所，仍然只有一行事实', async () => {
  const ctx = setup('ledger-4b-loose-');
  try {
    const manual = await Catalog.createInstrument(
      ctx.db, EMPTY_PROVIDER, { symbol: '2800.HK', source: 'manual', currency: 'HKD' }, CTX
    );
    assert.strictEqual(manual.ok, true);
    assert.strictEqual(manual.item.exchange, null);

    const refreshed = await Catalog.createInstrument(ctx.db, Fixture, { symbol: '2800.HK' }, CTX);
    assert.strictEqual(refreshed.ok, true);
    assert.strictEqual(refreshed.item.id, manual.item.id, '必须命中既有标的，不新建第二行');
    assert.strictEqual(refreshed.item.exchange, 'HKEX', 'provider 补全了空字段');
    assert.strictEqual(instrumentsOf(ctx.db, '2800.HK').length, 1);
  } finally {
    ctx.close();
  }
});

test('provider 的部分字段缺失时保持 null，等用户填写而不是编造', async () => {
  const ctx = setup('ledger-4b-mystery-');
  try {
    const res = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'MYSTERY.ETF' }, CTX);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.name, null);
    assert.strictEqual(res.item.exchange, null);
    assert.strictEqual(res.item.instrumentType, null);
    assert.strictEqual(res.item.country, undefined, '未提供的可选字段不应留下伪造值');
    assert.strictEqual(res.item.currency, 'USD');
    assert.ok(
      res.suggestions.every((s) => s.value != null && s.value !== ''),
      '建议里不得出现空值'
    );
  } finally {
    ctx.close();
  }
});

/* ============================== 确认与本地锁定（S4B.1 核心） ============================== */

test('用户确认：分类落库、状态转为 confirmed、写入确认时间', async () => {
  const ctx = setup('ledger-4b-confirm-');
  try {
    const created = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    const res = Catalog.confirmInstrument(
      ctx.db,
      { instrumentId: created.item.id, assetClass: 'broad_equity', exposureMarket: 'US' },
      CTX
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.classificationStatus, 'confirmed');
    assert.strictEqual(res.item.assetClass, 'broad_equity');
    assert.strictEqual(res.item.exposureMarket, 'US');
    assert.strictEqual(res.item.confirmedAt, NOW);
    assert.strictEqual(res.item.id, created.item.id, '确认不改变标的身份');
  } finally {
    ctx.close();
  }
});

test('确认时也会带出与 provider 候选的冲突提示（不覆盖，只提示）', async () => {
  const ctx = setup('ledger-4b-confirm-conflict-');
  try {
    const manual = await Catalog.createInstrument(
      ctx.db,
      EMPTY_PROVIDER,
      { symbol: '2800.HK', source: 'manual', currency: 'HKD', name: '盈富基金' },
      CTX
    );
    await Catalog.createInstrument(ctx.db, Fixture, { symbol: '2800.HK' }, CTX);
    const res = Catalog.confirmInstrument(
      ctx.db,
      { instrumentId: manual.item.id, assetClass: 'broad_equity', exposureMarket: 'HK' },
      CTX
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.item.name, '盈富基金', '本地名称不得被 provider 改写');
    assert.ok(res.conflicts.some((c) => c.field === 'name'), '名称差异必须作为冲突提示');
    assert.ok(res.conflicts.every((c) => c.provenance && c.provenance.payloadHash));
  } finally {
    ctx.close();
  }
});

test('确认不存在的标的返回 instrument_not_found', () => {
  const ctx = setup('ledger-4b-confirm-404-');
  try {
    const res = Catalog.confirmInstrument(
      ctx.db,
      { instrumentId: 'inst-doesnotexist', assetClass: 'cash', exposureMarket: 'CN' },
      CTX
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'instrument_not_found');
  } finally {
    ctx.close();
  }
});

test('确认载荷非法时拒绝且不改动已存记录', async () => {
  const ctx = setup('ledger-4b-confirm-invalid-');
  try {
    const created = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    const bad = Catalog.confirmInstrument(
      ctx.db,
      { instrumentId: created.item.id, assetClass: '现金', exposureMarket: 'US' },
      CTX
    );
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.code, 'invalid_asset_class');
    const after = R.getInstrument(ctx.db, created.item.id);
    assert.strictEqual(after.classificationStatus, 'suggested');
    assert.strictEqual(after.assetClass, null);
  } finally {
    ctx.close();
  }
});

test('核心不变量：确认后再刷新元数据，已确认分类不被覆盖、状态不退回 suggested', async () => {
  const ctx = setup('ledger-4b-lock-');
  try {
    const created = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    const confirmed = Catalog.confirmInstrument(
      ctx.db,
      { instrumentId: created.item.id, assetClass: 'broad_equity', exposureMarket: 'US', trackingIndex: 'S&P 500' },
      CTX
    );
    assert.strictEqual(confirmed.item.classificationStatus, 'confirmed');

    // 外部元数据再次刷新（可能是上游改名，也可能只是重新拉一次）
    const refreshed = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    assert.strictEqual(refreshed.ok, true);
    assert.strictEqual(refreshed.preserved, true, '必须显式报告"保留了已确认分类"');
    assert.strictEqual(refreshed.item.classificationStatus, 'confirmed', '不得退回 suggested');
    assert.strictEqual(refreshed.item.assetClass, 'broad_equity');
    assert.strictEqual(refreshed.item.exposureMarket, 'US');
    assert.strictEqual(refreshed.item.trackingIndex, 'S&P 500');
    assert.strictEqual(refreshed.item.confirmedAt, NOW, '确认时间不得被刷新清空');
    assert.strictEqual(refreshed.item.id, created.item.id);
    assert.strictEqual(instrumentsOf(ctx.db, 'VOO').length, 1);
  } finally {
    ctx.close();
  }
});

test('确认后本地自定义名称也不会被 provider 元数据改写（只产生冲突提示）', async () => {
  const ctx = setup('ledger-4b-lock-name-');
  try {
    const manual = await Catalog.createInstrument(
      ctx.db,
      EMPTY_PROVIDER,
      { symbol: '2800.HK', source: 'manual', currency: 'HKD', name: '我的盈富' },
      CTX
    );
    Catalog.confirmInstrument(
      ctx.db,
      { instrumentId: manual.item.id, assetClass: 'broad_equity', exposureMarket: 'HK' },
      CTX
    );
    const refreshed = await Catalog.createInstrument(ctx.db, Fixture, { symbol: '2800.HK' }, CTX);
    assert.strictEqual(refreshed.item.name, '我的盈富');
    assert.strictEqual(refreshed.item.classificationStatus, 'confirmed');
    assert.ok(refreshed.conflicts.some((c) => c.field === 'name'));
    assert.strictEqual(instrumentsOf(ctx.db, '2800.HK').length, 1);
  } finally {
    ctx.close();
  }
});

/* ============================== 去重键（repository 层保证） ============================== */

test('repository 对同一去重键的第二次写入显式报 duplicate_instrument，不静默删行', () => {
  const ctx = setup('ledger-4b-dup-');
  try {
    R.upsertInstrument(
      ctx.db,
      { id: 'inst-aaaa', symbol: 'VOO', exchange: 'NYSE', currency: 'USD', classificationStatus: 'confirmed' },
      { now: NOW }
    );
    assert.throws(
      () =>
        R.upsertInstrument(
          ctx.db,
          { id: 'inst-bbbb', symbol: 'VOO', exchange: 'NYSE', currency: 'USD' },
          { now: NOW }
        ),
      (e) => e && e.code === 'duplicate_instrument'
    );
    assert.strictEqual(R.readInstrumentRecords(ctx.db).length, 1, '冲突行必须原样保留，不被删除');
    assert.strictEqual(R.getInstrument(ctx.db, 'inst-aaaa').classificationStatus, 'confirmed');
  } finally {
    ctx.close();
  }
});

test('写入未知字段进 extra_json 且读回零丢失（provider 留档与冲突提示可长期保留）', () => {
  const ctx = setup('ledger-4b-extra-');
  try {
    const item = R.upsertInstrument(
      ctx.db,
      {
        id: 'inst-cccc',
        symbol: 'VOO',
        exchange: 'NYSE',
        currency: 'USD',
        source: 'provider',
        country: 'United States',
        exchangeTimezone: 'America/New_York',
        providerCandidate: { name: 'Vanguard S&P 500 ETF', currency: 'USD' },
        providerProvenance: { provider: 'fixture', endpoint: '/symbol_search', sourceVersion: 'v1', sourceRef: 'VOO@NYSE@ARCX', fetchedAt: NOW, payloadHash: 'a'.repeat(64) },
        conflicts: [{ field: 'name', localValue: 'x', providerValue: 'y' }]
      },
      { now: NOW }
    );
    const back = R.getInstrument(ctx.db, item.id);
    assert.strictEqual(back.exchangeTimezone, 'America/New_York');
    assert.strictEqual(back.providerCandidate.name, 'Vanguard S&P 500 ETF');
    assert.strictEqual(back.providerProvenance.payloadHash, 'a'.repeat(64));
    assert.strictEqual(back.conflicts[0].field, 'name');
  } finally {
    ctx.close();
  }
});
