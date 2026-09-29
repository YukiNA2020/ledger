/* Phase 5E-4 本地知识卡目录行为测试
 * 覆盖：必过卡片存在、id 集合稳定、解释码/explainKey 全量可解、
 *       未知输入显式降级、目录冻结、文案边界（离线、无收益承诺、无具体标的建议）。
 * 卡片是产品文案不是财务事实：本文件不校验任何金额，只校验目录契约。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Knowledge = require('../js/knowledge.js');
const Domain = require('../js/domain.js');

// 5E-4 范围里点名必须存在的六张卡
const REQUIRED_SIX = [
  'card-capacity-vs-willingness', // 能力与意愿
  'card-emergency-fund',          // 应急金上限
  'card-tolerance-band',          // 容忍带
  'card-new-funds-first',         // 新增资金优先
  'card-fx-risk',                 // 汇率风险
  'card-no-sell'                  // 为何不默认卖出
];

// 目录 id 是对外契约（页面链接、explainKey 都指向这里）：只能增，不得改名或删除
const STABLE_IDS = [
  'card-capacity-vs-willingness',
  'card-debt-pressure',
  'card-drawdown',
  'card-emergency-fund',
  'card-experience',
  'card-formal-gate',
  'card-fx-risk',
  'card-horizon',
  'card-income-stability',
  'card-knowledge',
  'card-liquidity-need',
  'card-lower-bound-rule',
  'card-new-funds-first',
  'card-no-sell',
  'card-tolerance-band'
];

// 文案边界：离线可读、无收益承诺、无具体标的建议、无云端 AI
const FORBIDDEN = [
  [/https?:\/\/|www\./i, '不得出现外部链接'],
  [/保本|稳赚|包赚|无风险|保证收益|稳赚不赔/, '不得出现收益承诺'],
  [/(?:建议|推荐|应当|应该)(?:立即)?(?:买入|增持|卖出|减持)/, '不得给出具体交易动作建议'],
  [/\b(?:VOO|VTI|QQQ|AAPL|TSLA|00700|600519)\b/, '不得出现具体证券代码'],
  [/云端\s*AI|大模型|调用接口/, '不得暗示云端 AI']
];

test('EXPLANATION_VERSION 为非空字符串，与 APP_VERSION 相互独立', () => {
  assert.strictEqual(typeof Knowledge.EXPLANATION_VERSION, 'string');
  assert.ok(Knowledge.EXPLANATION_VERSION.length > 0);
});

test('5E-4 必过六张卡存在且结构完整', () => {
  for (const id of REQUIRED_SIX) {
    const card = Knowledge.getCard(id);
    assert.ok(card, '缺必过知识卡 ' + id);
    assert.strictEqual(card.id, id, id + ' 的 id 字段应与键一致');
    assert.ok(card.title && typeof card.title === 'string', id + ' 应有标题');
    assert.ok(Array.isArray(card.body) && card.body.length >= 2, id + ' 应至少两段正文');
    for (const p of card.body) {
      assert.ok(typeof p === 'string' && p.trim().length > 0, id + ' 正文段落不得为空');
    }
  }
});

test('目录 id 集合稳定：只允许已登记的卡片', () => {
  assert.deepStrictEqual(Knowledge.cardIds.slice().sort(), STABLE_IDS);
});

test('每张卡的文案不越界：离线、无承诺、无具体标的建议', () => {
  for (const id of Knowledge.cardIds) {
    const card = Knowledge.getCard(id);
    const text = card.title + '\n' + card.body.join('\n');
    for (const [re, why] of FORBIDDEN) {
      assert.ok(!re.test(text), id + ' 文案越界（' + why + '）：' + re);
    }
  }
});

test('风险评估侧 explainKey 与 explainCode 全部可解', () => {
  for (const q of Domain.RISK_QUESTIONS) {
    assert.ok(q.explainKey, q.id + ' 应登记 explainKey');
    assert.ok(Knowledge.resolve(q.explainKey), q.explainKey + ' 应能解析到知识卡');
  }
  for (const cap of Domain.RISK_HARD_CAPS) {
    assert.ok(Knowledge.resolve(cap.explainKey), cap.explainKey + ' 应能解析到知识卡');
    assert.ok(Knowledge.resolve(cap.code), cap.code + ' 应能解析到知识卡');
  }
  for (const code of ['card-capacity-vs-willingness', 'card-lower-bound-rule']) {
    assert.ok(Knowledge.resolve(code), code + ' 应能解析到知识卡');
  }
});

test('建议侧 RECOMMENDATION_EXPLAIN_CODES 全部可解到已知卡', () => {
  for (const code of Domain.RECOMMENDATION_EXPLAIN_CODES) {
    const id = Knowledge.cardIdForCode(code);
    assert.ok(id, '解释码 ' + code + ' 缺映射');
    assert.ok(Knowledge.getCard(id), '解释码 ' + code + ' 指向了未知卡 ' + id);
    assert.ok(Knowledge.resolve(code), 'resolve(' + code + ') 应可解');
  }
});

test('未知 id / 未知码 / 原型链名字一律显式降级为 null', () => {
  assert.strictEqual(Knowledge.getCard('card-does-not-exist'), null);
  assert.strictEqual(Knowledge.getCard(''), null);
  assert.strictEqual(Knowledge.getCard(undefined), null);
  assert.strictEqual(Knowledge.getCard(42), null);
  assert.strictEqual(Knowledge.cardIdForCode('unknown_code'), null);
  assert.strictEqual(Knowledge.resolve('card-does-not-exist'), null);
  // 原型链上的名字不得被当成卡片（hasOwnProperty 防御）
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual(Knowledge.getCard(name), null, name + ' 不得解析为卡片');
    assert.strictEqual(Knowledge.resolve(name), null, name + ' 不得被 resolve 兜住');
  }
});

test('目录与映射在运行时被冻结，页面不能改写解释', () => {
  assert.ok(Object.isFrozen(Knowledge), '导出对象应冻结');
  assert.ok(Object.isFrozen(Knowledge.CARDS), '目录应冻结');
  assert.ok(Object.isFrozen(Knowledge.cardIds), 'id 清单应冻结');
  for (const id of Knowledge.cardIds) {
    assert.ok(Object.isFrozen(Knowledge.CARDS[id]), id + ' 卡片应冻结');
    assert.ok(Object.isFrozen(Knowledge.CARDS[id].body), id + ' 正文应冻结');
  }
  assert.throws(() => { 'use strict'; Knowledge.CARDS['card-fx-risk'].title = '改写'; });
});
