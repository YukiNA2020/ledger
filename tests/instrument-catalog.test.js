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

test('id 由 identity key 一步派生：外部只需存下 identityKey 就能复算（不需要知道派生细节）', () => {
  assert.strictEqual(Catalog.stableIdFromKey('VOO@NYSE'), Catalog.stableInstrumentId('VOO', 'NYSE'));
  assert.strictEqual(Catalog.stableIdFromKey('2800.HK@HKEX'), Catalog.stableInstrumentId('2800.HK', 'HKEX'));
  assert.ok(/^inst-[0-9a-f]{16}$/.test(Catalog.stableIdFromKey('CROSS@')));
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
    [{ symbol: 'VOO', id: 'bad id' }, 'client_id_forbidden']
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

/* ==================== 身份不可变、去重兜底与歧义（4B 复核补口） ==================== */

test('客户端指定的 id 无法落到库里：建立 VOO 得到的是服务端派生的 id', async () => {
  const ctx = setup('ledger-4b-id-forge-');
  try {
    const res = await Catalog.createInstrument(
      ctx.db,
      Fixture,
      { symbol: 'VOO', id: 'client-chosen-id' },
      CTX
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'client_id_forbidden');
    assert.strictEqual(instrumentsOf(ctx.db, 'VOO').length, 0, '被拒绝的请求不得写入任何标的');

    // 同一请求去掉 id 后走正常路径：id 必须是可复算的派生值
    const ok = await Catalog.createInstrument(ctx.db, Fixture, { symbol: 'VOO' }, CTX);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.item.id, Catalog.stableInstrumentId('VOO', 'NYSE'));
    assert.strictEqual(ok.item.identityKey, 'VOO@NYSE');
    assert.strictEqual(Catalog.stableIdFromKey(ok.item.identityKey), ok.item.id);
  } finally {
    ctx.close();
  }
});

test('先建无交易所标的、后补交易所：id 与 identityKey 都不重算（4C 引用永远有效）', async () => {
  const ctx = setup('ledger-4b-idkey-');
  try {
    const manual = await Catalog.createInstrument(
      ctx.db,
      Fixture,
      { symbol: 'CROSS', source: 'manual', currency: 'USD' },
      CTX
    );
    assert.strictEqual(manual.ok, true);
    assert.strictEqual(manual.item.id, Catalog.stableIdFromKey('CROSS@'));
    assert.strictEqual(manual.item.identityKey, 'CROSS@');

    const again = await Catalog.createInstrument(
      ctx.db,
      Fixture,
      { symbol: 'CROSS', source: 'manual', currency: 'USD', exchange: 'HKEX' },
      CTX
    );
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.item.id, manual.item.id, 'id 一旦分配就必须永久不变');
    assert.strictEqual(again.item.identityKey, 'CROSS@', 'identityKey 是首次创建时的值');
    assert.strictEqual(again.item.exchange, 'HKEX', '补全的交易所照常写入');
    assert.strictEqual(again.duplicated, true, '补全走的是同一行，不是第二行事实');
    assert.strictEqual(Catalog.stableIdFromKey(again.item.identityKey), again.item.id, 'id 必须能由 identityKey 复算');
    assert.strictEqual(instrumentsOf(ctx.db, 'CROSS').length, 1);
  } finally {
    ctx.close();
  }
});

test('同代码跨市场存在多行时，缺交易所的查找报 ambiguous_instrument 而不是任选一行', async () => {
  const ctx = setup('ledger-4b-ambig-');
  try {
    R.upsertInstrument(
      ctx.db,
      { id: Catalog.stableInstrumentId('CROSS', 'NYSE'), symbol: 'CROSS', exchange: 'NYSE', currency: 'USD' },
      { now: NOW }
    );
    R.upsertInstrument(
      ctx.db,
      { id: Catalog.stableInstrumentId('CROSS', 'HKEX'), symbol: 'CROSS', exchange: 'HKEX', currency: 'HKD' },
      { now: NOW }
    );

    assert.throws(
      () => R.findInstrumentByKey(ctx.db, 'CROSS', ''),
      (e) => e && e.code === 'ambiguous_instrument'
    );
    assert.throws(
      () => R.findInstrumentByKey(ctx.db, 'CROSS', null),
      (e) => e && e.code === 'ambiguous_instrument'
    );
    // 明确指定交易所时照常命中（歧义只发生在"没说是哪个市场"的时候）
    assert.strictEqual(R.findInstrumentByKey(ctx.db, 'CROSS', 'NYSE').exchange, 'NYSE');
    assert.strictEqual(R.findInstrumentByKey(ctx.db, 'CROSS', 'HKEX').exchange, 'HKEX');

    const res = await Catalog.createInstrument(
      ctx.db,
      Fixture,
      { symbol: 'CROSS', source: 'manual', currency: 'USD' },
      CTX
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'ambiguous_instrument');
    assert.ok(res.message.indexOf('ambiguous') === -1, '对外只给中文提示，不暴露内部错误码文本');
    assert.strictEqual(instrumentsOf(ctx.db, 'CROSS').length, 2, '报歧义时不得改动任何一行');
  } finally {
    ctx.close();
  }
});

test('退化匹配在一行时仍然补全交易所（歧义检测不破坏"手工建标后补全"的既有路径）', async () => {
  const ctx = setup('ledger-4b-loose1-');
  try {
    R.upsertInstrument(
      ctx.db,
      { id: Catalog.stableInstrumentId('CROSS', ''), symbol: 'CROSS', exchange: null, currency: 'USD' },
      { now: NOW }
    );
    const hit = R.findInstrumentByKey(ctx.db, 'CROSS', 'NYSE');
    assert.strictEqual(hit, null === null ? hit : hit);
    assert.strictEqual(hit.symbol, 'CROSS');
    assert.strictEqual(hit.exchange, null);
  } finally {
    ctx.close();
  }
});

test('全量写入（PUT /state）对重复去重键整体拒绝，且已存数据原样保留', () => {
  const ctx = setup('ledger-4b-state-dup-');
  try {
    const empty = { assetAccounts: [], assetUnits: [], assetTransfers: [], liabilities: [], entitlements: [], holdings: [], quotes: [], fxRates: [] };
    const withInstruments = (instruments) =>
      Object.assign({ settings: {} }, { assets: Object.assign({}, empty, { instruments: instruments }) });

    R.writeState(
      ctx.db,
      withInstruments([{ id: 'inst-a', symbol: 'VOO', exchange: 'NYSE', currency: 'USD' }])
    );
    assert.strictEqual(instrumentsOf(ctx.db, 'VOO').length, 1);

    // 4B 复核 P0：大小写/空白不同的同一标的不允许同时落库
    assert.throws(
      () =>
        R.writeState(
          ctx.db,
          withInstruments([
            { id: 'inst-a', symbol: 'VOO', exchange: 'NYSE', currency: 'USD' },
            { id: 'inst-b', symbol: 'voo', exchange: 'nyse', currency: 'USD' }
          ])
        ),
      (e) => e && e.code === 'duplicate_instrument'
    );
    // 整体回滚：写入被拒后库里还是上一次的状态，不是"清空后失败"
    assert.strictEqual(instrumentsOf(ctx.db, 'VOO').length, 1);
    assert.strictEqual(R.getInstrument(ctx.db, 'inst-b'), null, '被拒绝的行不得落库');

    // 同一 id 重复出现同样拒绝
    assert.throws(
      () =>
        R.writeState(
          ctx.db,
          withInstruments([
            { id: 'inst-a', symbol: 'VOO', exchange: 'NYSE', currency: 'USD' },
            { id: 'inst-a', symbol: 'QQQ', exchange: 'NASDAQ', currency: 'USD' }
          ])
        ),
      (e) => e && e.code === 'duplicate_instrument'
    );
  } finally {
    ctx.close();
  }
});

test('数据库唯一索引兜底：绕过应用层直接插入重复去重键也会被拒', () => {
  const ctx = setup('ledger-4b-idx-');
  try {
    ctx.db.exec("INSERT INTO instruments (id,symbol,exchange,currency) VALUES ('x1','VOO','NYSE','USD')");
    // 归一后相同的两行（大小写不同）
    assert.throws(
      () => ctx.db.exec("INSERT INTO instruments (id,symbol,exchange,currency) VALUES ('x2','voo','nyse','USD')"),
      /UNIQUE|constraint/i
    );
    // 空白差异同样参与去重
    assert.throws(
      () => ctx.db.exec("INSERT INTO instruments (id,symbol,exchange,currency) VALUES ('x3',' VOO ',' NYSE ','USD')"),
      /UNIQUE|constraint/i
    );
    // 缺交易所计入空串这一键，两行同样冲突
    ctx.db.exec("INSERT INTO instruments (id,symbol,exchange,currency) VALUES ('y1','CROSS',NULL,'USD')");
    assert.throws(
      () => ctx.db.exec("INSERT INTO instruments (id,symbol,exchange,currency) VALUES ('y2','CROSS',NULL,'USD')"),
      /UNIQUE|constraint/i
    );
    // 不同交易所是不同标的，允许共存
    ctx.db.exec("INSERT INTO instruments (id,symbol,exchange,currency) VALUES ('z1','CROSS','NYSE','USD')");
    assertCrossExchangesCoexist(ctx);
  } finally {
    ctx.close();
  }
});

function assertCrossExchangesCoexist(ctx) {
  const rows = R.readInstrumentRecords(ctx.db).filter((r) => r.symbol === 'CROSS');
  assert.strictEqual(rows.length, 2, '同一代码的不同交易所必须能共存');
}

/* ============ 第二轮复核反例：检索合并的退化匹配与歧义（G4B-7） ============ */

const PROV = {
  provider: 'stub',
  endpoint: '/symbol_search',
  sourceVersion: 'stub-v1',
  sourceRef: 'CROSS@NYSE@ARCX',
  fetchedAt: NOW,
  payloadHash: 'b'.repeat(64)
};

// 固定返回给定候选列表的 provider（用于构造 fixture 没有的跨市场/缺交易所场景）
function stubCatalogProvider(list) {
  return {
    PROVIDER_ID: 'stub',
    searchInstrument() {
      return Promise.resolve(list);
    },
    getInstrumentMetadata() {
      return Promise.resolve(
        Contract.errorResult({ subject: null, code: Contract.ERRORS.NOT_FOUND, detail: '未收录该代码' })
      );
    }
  };
}

test('检索合并：本地缺交易所 + 参考数据有交易所 → 合成一条候选，不再重复展示', async () => {
  const ctx = setup('ledger-4b-merge-loose-');
  try {
    // 复核复现：先手工建立无交易所的 VOO（用户手上只有代码、provider 也未覆盖）
    const manual = await Catalog.createInstrument(
      ctx.db,
      Fixture,
      { symbol: 'VOO', source: 'manual', currency: 'USD' },
      CTX
    );
    assert.strictEqual(manual.ok, true, JSON.stringify(manual));
    assert.strictEqual(manual.item.exchange, null);

    const res = await Catalog.searchCatalog(ctx.db, Fixture, 'VOO', CTX);
    assert.strictEqual(res.candidates.length, 1, '同一标的不得出现两条候选（本地 VOO@ 与 VOO@NYSE）');
    const c = res.candidates[0];
    assert.strictEqual(c.origin, 'local+provider');
    assert.strictEqual(c.symbol, 'VOO');
    assert.strictEqual(c.exchange, 'NYSE', '参考数据给出的交易所用于展示');
    assert.ok(c.local && c.local.id === manual.item.id, '候选要带出本地记录');
    assert.strictEqual(c.local.exchange, null, '本地记录本身没变（仍是未注明交易所）');
    assert.deepStrictEqual(res.warnings, [], '唯一松散候选不是歧义，不应报警告');
    // 预分类建议仍然只来自参考数据：合并展示不得把本地值冒充成 provider 依据
    assert.ok(
      c.suggestions.every((s) => String(s.basis).indexOf('provider.') === 0),
      '建议依据必须仍指向 provider：' + JSON.stringify(c.suggestions)
    );
  } finally {
    ctx.close();
  }
});

test('检索歧义：同代码本地有多个市场 + 参考数据未给交易所 → 报歧义且不合并', async () => {
  const ctx = setup('ledger-4b-merge-ambig-');
  try {
    await Catalog.createInstrument(
      ctx.db,
      Fixture,
      { symbol: 'CROSS', source: 'manual', currency: 'USD', exchange: 'NYSE' },
      CTX
    );
    await Catalog.createInstrument(
      ctx.db,
      Fixture,
      { symbol: 'CROSS', source: 'manual', currency: 'HKD', exchange: 'HKEX' },
      CTX
    );

    // 参考数据返回"这个代码存在、但没给交易所"的候选
    const provider = stubCatalogProvider([
      Contract.instrumentResult({
        symbol: 'CROSS',
        currency: 'USD',
        exchange: null,
        name: 'Cross Listed Co',
        instrumentType: 'Common Stock',
        country: 'US',
        provenance: PROV
      })
    ]);
    const res = await Catalog.searchCatalog(ctx.db, provider, 'CROSS', CTX);
    assert.strictEqual(res.ok, true);

    const providerCand = res.candidates.filter((c) => c.origin === 'provider');
    assert.strictEqual(providerCand.length, 1, '歧义时不得把候选并到任意一条本地记录上');
    assert.strictEqual(providerCand[0].local, null, '未合并：候选不带本地对照');

    const warn = res.warnings.filter((w) => w.code === 'ambiguous_instrument');
    assert.strictEqual(warn.length, 1, '必须显式报告歧义：' + JSON.stringify(res.warnings));
    assert.strictEqual(warn[0].symbol, 'CROSS');
    assert.ok(warn[0].detail.indexOf('NYSE') !== -1 && warn[0].detail.indexOf('HKEX') !== -1, warn[0].detail);
    // 两条本地事实都还在，没有被"任选一条"或删除
    assert.strictEqual(instrumentsOf(ctx.db, 'CROSS').length, 2);
    assert.strictEqual(res.candidates.filter((c) => c.origin === 'local').length, 2);
  } finally {
    ctx.close();
  }
});

test('检索歧义：本地只有一条缺交易所记录 + 参考数据给出多个市场 → 报歧义且不重复挂同一条本地记录', async () => {
  const ctx = setup('ledger-4b-merge-ambig2-');
  try {
    const manual = await Catalog.createInstrument(
      ctx.db,
      Fixture,
      { symbol: 'DUAL', source: 'manual', currency: 'USD' },
      CTX
    );
    assert.strictEqual(manual.ok, true, JSON.stringify(manual));

    const provider = stubCatalogProvider([
      Contract.instrumentResult({
        symbol: 'DUAL',
        currency: 'USD',
        exchange: 'NYSE',
        name: 'Dual Listed A',
        provenance: PROV
      }),
      Contract.instrumentResult({
        symbol: 'DUAL',
        currency: 'HKD',
        exchange: 'HKEX',
        name: 'Dual Listed B',
        provenance: PROV
      })
    ]);
    const res = await Catalog.searchCatalog(ctx.db, provider, 'DUAL', CTX);
    assert.strictEqual(res.ok, true);

    // 第一条候选可以安全合并（本地只有一条、且本地缺交易所）
    const merged = res.candidates.filter((c) => c.origin === 'local+provider');
    assert.strictEqual(merged.length, 1, '只有一条本地记录，最多只能被一个市场认领');
    assert.strictEqual(merged[0].local.id, manual.item.id);

    // 第二个市场无法判断是否同一条本地记录 → 报歧义且不合并
    const warn = res.warnings.filter((w) => w.code === 'ambiguous_instrument');
    assert.strictEqual(warn.length, 1, '第二个市场必须报歧义：' + JSON.stringify(res.warnings));
    const other = res.candidates.filter((c) => c.origin === 'provider');
    assert.strictEqual(other.length, 1);
    assert.strictEqual(other[0].local, null);
    assert.strictEqual(instrumentsOf(ctx.db, 'DUAL').length, 1, '检索是只读的：不得新增/删除本地事实');
  } finally {
    ctx.close();
  }
});

/* ============ 第二轮复核反例：全量写入逐条校验（G4B-5） ============ */

test('全量写入逐条校验：缺 id / 空白代码 / 非法币种一律抛错，不静默丢行也不变形落库', () => {
  const ctx = setup('ledger-4b-write-val-');
  try {
    const empty = { assetAccounts: [], assetUnits: [], assetTransfers: [], liabilities: [], entitlements: [], holdings: [], quotes: [], fxRates: [] };
    const withInstruments = (instruments) =>
      Object.assign({ settings: {} }, { assets: Object.assign({}, empty, { instruments: instruments }) });

    const cases = [
      ['缺 id 的标的', { symbol: 'NO-ID', exchange: 'NYSE', currency: 'USD' }, 'invalid_id'],
      ['空白代码', { id: 'inst-blank', symbol: '   ', currency: 'USD' }, 'invalid_symbol'],
      ['代码不是证券代码形状（含空格）', { id: 'inst-space', symbol: 'VOO NYSE', currency: 'USD' }, 'invalid_symbol'],
      ['币种不在白名单', { id: 'inst-badcur', symbol: 'BAD', exchange: 'NYSE', currency: 'XXX' }, 'invalid_currency'],
      ['币种缺失', { id: 'inst-nocur', symbol: 'NOCUR', exchange: 'NYSE' }, 'invalid_currency'],
      ['标的不是对象', 'VOO/NYSE', 'invalid_instrument']
    ];
    for (const [label, row, code] of cases) {
      assert.throws(
        () => R.writeState(ctx.db, withInstruments([row])),
        (e) => e && e.code === code,
        label + ' 必须以 ' + code + ' 拒绝'
      );
      // 拒绝即整体回滚：库里的标的数不因这次失败而变化
      assert.strictEqual(R.readInstrumentRecords(ctx.db).length, 0, label + ' 被拒后不得留下半行数据');
    }

    // 合法行照常写入（校验没有把正常路径堵死）
    R.writeState(ctx.db, withInstruments([{ id: 'inst-ok', symbol: 'VTI', exchange: 'NYSE', currency: 'USD' }]));
    assert.strictEqual(R.readInstrumentRecords(ctx.db).length, 1);

    // 与单个接口同一口径：非法行不会挤掉既有数据（整体回滚，而不是"先清后写"留下空库）
    assert.throws(
      () =>
        R.writeState(
          ctx.db,
          withInstruments([
            { id: 'inst-ok2', symbol: 'QQQ', exchange: 'NASDAQ', currency: 'USD' },
            { id: 'inst-bad', symbol: '  ', currency: 'USD' }
          ])
        ),
      (e) => e && e.code === 'invalid_symbol'
    );
    assert.strictEqual(R.readInstrumentRecords(ctx.db).length, 1, '被拒写入必须回滚到上一次状态');
    assert.strictEqual(R.getInstrument(ctx.db, 'inst-ok2'), null);
  } finally {
    ctx.close();
  }
});
