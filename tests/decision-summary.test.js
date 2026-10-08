'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { executionSummary } = require('../server/decisions');

const summarize = (amounts, fees, fx) => {
  const events = amounts.map((priceMinor, i) => ({
    id: 'sev-' + i, eventType: 'buy', quantity: '1', priceMinor,
    feeMinor: fees ? fees[i] : 0, currency: fx && i === amounts.length - 1 ? 'HKD' : 'CNY',
    occurredAt: '2026-09-30'
  }));
  const links = events.map(e => ({ decisionId: 'd', securityEventId: e.id, unlinkedOn: null }));
  return executionSummary({ allocatedTotalMinor: 200000 }, 'd', links, events, []);
};

test('6R-05 执行本金和费用累加超出安全整数时拒绝，边界值不失真', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(summarize([max - 1, 1]).linkedPrincipalCnyMinor, max);
  assert.throws(() => summarize([max - 1, 2]), { code: 'invalid_decision_record' });
  assert.equal(summarize([1, 1], [max - 1, 1]).linkedFeeCnyMinor, max);
  assert.throws(() => summarize([1, 1], [max - 1, 2]), { code: 'invalid_decision_record' });
});

test('6R-06 缺任一汇率优先返回全 null，汇总不因遍历顺序溢出或输出部分小计', () => {
  const result = summarize([Number.MAX_SAFE_INTEGER, 1, 1], null, true);
  assert.deepEqual(result, { linkedCount: 3, linkedPrincipalCnyMinor: null,
    linkedFeeCnyMinor: null, remainingMinor: null, fxUnavailable: ['sev-2'] });
});
