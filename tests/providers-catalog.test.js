/* Phase 4B fixture 参考数据 adapter 测试（标的检索与元数据）
 *
 * 对应 ACCEPTANCE.md S4B.1、ROADMAP Phase 4B 工作项、ARCHITECTURE §7（provider 契约）、
 * DECISIONS D-037（候选字段映射与 provenance）。
 *
 * 全部离线：只依赖固定 fixture 与固定时钟，绝不访问真实行情网络（AGENTS.md 测试门禁）。
 * fixture 中的代码/名称/交易所均为虚构或公开可查的标的代号，不含任何私人财务事实。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const Contract = require('../server/providers/contract');
const Fixture = require('../server/providers/fixture');

const NOW = '2026-09-15T08:00:00Z';
const CTX = { now: NOW };

// 契约 instrument 结果的精确键集合（用于证明"不夹带、不编造"）
const INSTRUMENT_KEYS = [
  'kind', 'symbol', 'name', 'currency', 'exchange',
  'country', 'instrumentType', 'exchangeTimezone', 'provenance', 'status'
];

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function okResults(list) {
  return list.filter((r) => r && r.kind === 'instrument');
}

function errResults(list) {
  return list.filter((r) => r && r.kind === 'error');
}

/* ------------------------------ 检索：候选形状 ------------------------------ */

test('检索命中返回契约 instrument 结果，键集合精确、状态为 ok', async () => {
  const res = await Fixture.searchInstrument('voo', CTX);
  assert.strictEqual(res.length, 1);
  const r = res[0];
  assert.strictEqual(r.kind, 'instrument');
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(Object.keys(r).sort(), INSTRUMENT_KEYS.slice().sort());
  assert.ok(Contract.isValidResult(r), '检索候选必须能通过契约结果校验');
  assert.strictEqual(r.symbol, 'VOO');
  assert.strictEqual(r.name, 'Vanguard S&P 500 ETF');
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.exchange, 'NYSE');
  assert.strictEqual(r.instrumentType, 'ETF');
  assert.strictEqual(r.country, 'United States');
  assert.strictEqual(r.exchangeTimezone, 'America/New_York');
});

test('检索候选不含 asset_class / exposure_market / 跟踪指数（用户判断字段，provider 无权生成）', async () => {
  const res = await Fixture.searchInstrument('voo', CTX);
  const r = res[0];
  ['assetClass', 'exposureMarket', 'trackingIndex'].forEach((f) => {
    assert.strictEqual(f in r, false, f + ' 不应出现在 provider 候选里');
  });
});

test('检索大小写不敏感，代码与名称片段都能命中', async () => {
  for (const q of ['voo', 'VOO', 'Vanguard', 'vAnGuArD']) {
    const res = await Fixture.searchInstrument(q, CTX);
    assert.strictEqual(okResults(res).length, 1, '检索词 ' + q);
    assert.strictEqual(okResults(res)[0].symbol, 'VOO');
  }
  const partial = await Fixture.searchInstrument('5103', CTX);
  assert.strictEqual(okResults(partial).length, 1);
  assert.strictEqual(okResults(partial)[0].symbol, '510300.SS');
});

test('一个检索词命中多条时逐条返回（HK 命中两只港股标的）', async () => {
  const res = await Fixture.searchInstrument('HK', CTX);
  const symbols = okResults(res).map((r) => r.symbol).sort();
  assert.deepStrictEqual(symbols, ['0700.HK', '2800.HK']);
  res.forEach((r) => assert.ok(Contract.isValidResult(r), '每条候选都必须合规'));
});

test('"没搜到"与"这次调用失败"必须可区分：无命中返回空数组而不是错误', async () => {
  const res = await Fixture.searchInstrument('ZZZZNOPE', CTX);
  assert.deepStrictEqual(res, [], '无命中应为空数组');
  assert.strictEqual(errResults(res).length, 0, '无命中不得伪装成错误');
});

test('provider 级失败返回单个错误结果（subject 为空，可被明确识别为整体失败）', async () => {
  const cases = [
    { q: 'SLOW', code: 'timeout', retryable: true },
    { q: 'LIMITED', code: 'rate_limit', retryable: true },
    { q: 'UNAUTHORIZED', code: 'auth', retryable: false }
  ];
  for (const c of cases) {
    const res = await Fixture.searchInstrument(c.q, CTX);
    assert.strictEqual(res.length, 1, c.q);
    assert.strictEqual(res[0].kind, 'error');
    assert.strictEqual(res[0].code, c.code);
    assert.strictEqual(res[0].subject, null, '整体失败的 subject 必须为空');
    assert.strictEqual(res[0].retryable, c.retryable);
    assert.ok(Contract.isValidResult(res[0]));
  }
});

test('检索结果上限有界（单次检索不会把整本清单塞回来）', async () => {
  const res = await Fixture.searchInstrument('etf', CTX);
  assert.ok(res.length <= 20, '检索结果不得超过单次上限');
  assert.ok(res.length >= 1);
});

/* ------------------------------ 检索：缺项与坏数据 ------------------------------ */

test('上游字段缺失一律为 null，绝不用空串或猜测值冒充', async () => {
  const res = await Fixture.searchInstrument('MYSTERY', CTX);
  assert.strictEqual(res.length, 1);
  const r = res[0];
  assert.strictEqual(r.kind, 'instrument');
  assert.strictEqual(r.symbol, 'MYSTERY.ETF');
  assert.strictEqual(r.name, null);
  assert.strictEqual(r.exchange, null);
  assert.strictEqual(r.instrumentType, null);
  assert.strictEqual(r.country, null);
  assert.strictEqual(r.exchangeTimezone, null);
  assert.strictEqual(r.currency, 'USD', '上游给了的字段仍要如实带出');
  assert.ok(Contract.isValidResult(r));
});

test('元数据不可入账的记录绝不作为候选流出，转为显式 invalid_payload', async () => {
  const res = await Fixture.searchInstrument('badmeta', CTX);
  assert.strictEqual(res.length, 1);
  const r = res[0];
  assert.strictEqual(r.kind, 'error', '小写币种的上游记录不得成为候选');
  assert.strictEqual(r.code, 'invalid_payload');
  assert.strictEqual(r.subject, 'BADMETA.ETF');
  assert.ok(res.every((x) => x.kind !== 'instrument'), '坏数据不得以任何形式出现在候选里');
});

test('混合结果中好候选照常返回、坏记录单独报错（互不影响）', async () => {
  const res = await Fixture.searchInstrument('etf', CTX);
  const oks = okResults(res).map((r) => r.symbol).sort();
  const errs = errResults(res).map((r) => r.subject);
  assert.deepStrictEqual(oks, ['510300.SS', 'MYSTERY.ETF', 'VOO']);
  assert.deepStrictEqual(errs, ['BADMETA.ETF']);
});

/* ------------------------------ 检索：请求校验 ------------------------------ */

test('非法检索词整体拒绝为 invalid_payload，且不回显输入原文', async () => {
  const dirty = '我的证券账户 001;DROP';
  const res = await Fixture.searchInstrument(dirty, CTX);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].code, 'invalid_payload');
  assert.ok(res[0].detail.indexOf('我的证券账户') === -1, '错误 detail 不得回显输入原文');
  assert.ok(res[0].detail.indexOf('DROP') === -1, '错误 detail 不得回显输入原文');
});

test('检索请求非字符串 / 空白串 / 超长串一律拒绝', async () => {
  const bads = [null, undefined, 123, {}, [], '   ', 'x'.repeat(33), ''];
  for (const b of bads) {
    const res = await Fixture.searchInstrument(b, CTX);
    assert.strictEqual(res.length, 1, JSON.stringify(b));
    assert.strictEqual(res[0].code, 'invalid_payload', JSON.stringify(b));
  }
});

test('缺少有效抓取时间时整体拒绝，不用"今天"兜底', async () => {
  for (const ctx of [undefined, {}, { now: '2026-09-15 08:00:00' }, { now: 'not-a-time' }]) {
    const res = await Fixture.searchInstrument('voo', ctx);
    assert.strictEqual(res.length, 1, JSON.stringify(ctx));
    assert.strictEqual(res[0].code, 'invalid_payload');
  }
});

/* ------------------------------ 元数据（单标的） ------------------------------ */

test('元数据命中返回单条契约结果（不是数组）', async () => {
  const r = await Fixture.getInstrumentMetadata('VOO', CTX);
  assert.strictEqual(r.kind, 'instrument');
  assert.strictEqual(r.symbol, 'VOO');
  assert.strictEqual(r.currency, 'USD');
  assert.deepStrictEqual(Object.keys(r).sort(), INSTRUMENT_KEYS.slice().sort());
  assert.ok(Contract.isValidResult(r));
});

test('元数据未收录返回 not_found（与"调用失败"可区分）', async () => {
  const r = await Fixture.getInstrumentMetadata('NOPE.ZZ', CTX);
  assert.strictEqual(r.kind, 'error');
  assert.strictEqual(r.code, 'not_found');
  assert.strictEqual(r.subject, 'NOPE.ZZ');
  assert.strictEqual(r.retryable, false);
});

test('元数据错误场景按上游错误码如实返回（auth / timeout）', async () => {
  const auth = await Fixture.getInstrumentMetadata('AUTH.ETF', CTX);
  assert.strictEqual(auth.code, 'auth');
  assert.strictEqual(auth.retryable, false);
  const slow = await Fixture.getInstrumentMetadata('SLOWMETA.ETF', CTX);
  assert.strictEqual(slow.code, 'timeout');
  assert.strictEqual(slow.retryable, true);
});

test('元数据不可入账返回 invalid_payload，不落库', async () => {
  const r = await Fixture.getInstrumentMetadata('BADMETA.ETF', CTX);
  assert.strictEqual(r.kind, 'error');
  assert.strictEqual(r.code, 'invalid_payload');
  assert.strictEqual(r.subject, 'BADMETA.ETF');
});

test('元数据非法代码形状整体拒绝', async () => {
  for (const s of ['', 'not a symbol', 'x'.repeat(17), null, 42]) {
    const r = await Fixture.getInstrumentMetadata(s, CTX);
    assert.strictEqual(r.kind, 'error', JSON.stringify(s));
    assert.strictEqual(r.code, 'invalid_payload', JSON.stringify(s));
  }
});

test('元数据缺抓取时间整体拒绝', async () => {
  const r = await Fixture.getInstrumentMetadata('VOO', {});
  assert.strictEqual(r.code, 'invalid_payload');
});

/* ------------------------------ provenance（D-037） ------------------------------ */

test('每条候选都带完整 provenance 六字段，形状满足契约要求', async () => {
  const res = await Fixture.searchInstrument('HK', CTX);
  res.forEach((r) => {
    const p = r.provenance;
    assert.ok(p, '候选必须带 provenance');
    assert.deepStrictEqual(
      Object.keys(p).sort(),
      ['endpoint', 'fetchedAt', 'payloadHash', 'provider', 'sourceRef', 'sourceVersion']
    );
    assert.strictEqual(p.provider, 'fixture');
    assert.strictEqual(p.endpoint, Fixture.METADATA_ENDPOINT);
    assert.strictEqual(p.sourceVersion, Fixture.METADATA_SOURCE_VERSION);
    assert.strictEqual(p.fetchedAt, NOW, 'fetchedAt 必须取自注入的 fixed clock');
    assert.ok(/^[0-9a-f]{64}$/.test(p.payloadHash), 'payloadHash 必须是 sha256 十六进制摘要');
    assert.ok(Contract.isProvenance(p));
  });
});

test('payloadHash 可由上游字段重算复核（来源可追溯、可验证）', async () => {
  const r = await Fixture.getInstrumentMetadata('VOO', CTX);
  assert.strictEqual(r.provenance.payloadHash, Fixture.payloadHashOf(Fixture.CATALOG.VOO));
  const canonical = JSON.stringify({
    symbol: 'VOO',
    instrument_name: 'Vanguard S&P 500 ETF',
    currency: 'USD',
    exchange: 'NYSE',
    mic_code: 'ARCX',
    instrument_type: 'ETF',
    country: 'United States',
    exchange_timezone: 'America/New_York'
  });
  assert.strictEqual(r.provenance.payloadHash, sha256(canonical), '摘要口径必须可被外部复算');
});

test('不同标的的 payloadHash 不同（摘要与记录一一对应，不是固定值）', async () => {
  const a = await Fixture.getInstrumentMetadata('VOO', CTX);
  const b = await Fixture.getInstrumentMetadata('2800.HK', CTX);
  assert.notStrictEqual(a.provenance.payloadHash, b.provenance.payloadHash);
});

test('sourceRef 记录上游原始代码形状，交易所/代码缺失时用 NA 占位', async () => {
  assert.strictEqual(Fixture.sourceRefOf(Fixture.CATALOG.VOO), 'VOO@NYSE@ARCX');
  assert.strictEqual(Fixture.sourceRefOf(Fixture.CATALOG['MYSTERY.ETF']), 'MYSTERY.ETF@NA@NA');
  const r = await Fixture.getInstrumentMetadata('MYSTERY.ETF', CTX);
  assert.strictEqual(r.provenance.sourceRef, 'MYSTERY.ETF@NA@NA');
});

test('抓取时间来自注入的时钟，不同 ctx.now 产生不同 fetchedAt', async () => {
  const early = await Fixture.getInstrumentMetadata('VOO', { now: '2026-09-01T00:00:00Z' });
  const late = await Fixture.getInstrumentMetadata('VOO', { now: '2026-09-15T08:00:00Z' });
  assert.strictEqual(early.provenance.fetchedAt, '2026-09-01T00:00:00Z');
  assert.strictEqual(late.provenance.fetchedAt, '2026-09-15T08:00:00Z');
  assert.strictEqual(early.provenance.payloadHash, late.provenance.payloadHash, '摘要只覆盖上游字段，不含抓取时间');
});

/* ------------------------------ 隐私边界 ------------------------------ */

test('检索请求只保留检索词，夹带的私有字段在结构上进不了 provider 调用', () => {
  const req = Contract.serializeSearchRequest('VOO');
  assert.deepStrictEqual(Object.keys(req).sort(), ['ok', 'query']);
  assert.strictEqual(req.query, 'VOO');

  // 传入对象/数组不可能变成请求（被整体拒绝，而不是"取其中某个字段"）
  const asObj = Contract.serializeSearchRequest({ query: 'VOO', accountName: '我的账户' });
  assert.strictEqual(asObj.ok, false);
  assert.strictEqual(asObj.error.code, 'invalid_payload');
});

test('元数据请求只保留公开代码，不含任何账户或持仓字段', () => {
  const req = Contract.serializeMetadataRequest('VOO');
  assert.deepStrictEqual(Object.keys(req).sort(), ['ok', 'symbol']);
  const bad = Contract.serializeMetadataRequest({ symbol: 'VOO', quantity: 100 });
  assert.strictEqual(bad.ok, false);
});
