/* 金额转换与展示格式单测 */
const { test } = require('node:test');
const assert = require('node:assert');
const Core = require('../js/core.js');

test('yuanToCents 基础转换', () => {
  assert.strictEqual(Core.yuanToCents('45.00'), 4500);
  assert.strictEqual(Core.yuanToCents('45'), 4500);
  assert.strictEqual(Core.yuanToCents('0.05'), 5);
  assert.strictEqual(Core.yuanToCents('¥45.00'), 4500);
  assert.strictEqual(Core.yuanToCents('￥45.00'), 4500);
  assert.strictEqual(Core.yuanToCents('1,234.56'), 123456);
  assert.strictEqual(Core.yuanToCents('¥1,234.56'), 123456);
});

test('yuanToCents 正负号', () => {
  assert.strictEqual(Core.yuanToCents('-45.00'), -4500);
  assert.strictEqual(Core.yuanToCents('+45.00'), 4500);
  assert.strictEqual(Core.yuanToCents('¥-12.34'), -1234);
});

test('yuanToCents 浮点精度（四舍五入到分）', () => {
  assert.strictEqual(Core.yuanToCents('0.29'), 29);   // 0.29*100=28.999...
  assert.strictEqual(Core.yuanToCents('0.005'), 1);   // 边界进位
  assert.strictEqual(Core.yuanToCents('19.99'), 1999);
});

test('yuanToCents 非法输入返回 null', () => {
  assert.strictEqual(Core.yuanToCents('abc'), null);
  assert.strictEqual(Core.yuanToCents(''), null);
  assert.strictEqual(Core.yuanToCents(null), null);
  assert.strictEqual(Core.yuanToCents('12.3.4'), null);
});

test('yuanToCents 元后缀', () => {
  assert.strictEqual(Core.yuanToCents('8元'), 800);
  assert.strictEqual(Core.yuanToCents(' 45.00 '), 4500);
});

test('centsToYuan 两位小数字符串', () => {
  assert.strictEqual(Core.centsToYuan(123456), '1234.56');
  assert.strictEqual(Core.centsToYuan(5), '0.05');
  assert.strictEqual(Core.centsToYuan(100), '1.00');
  assert.strictEqual(Core.centsToYuan(-500), '-5.00');
  assert.strictEqual(Core.centsToYuan(0), '0.00');
});

test('fmtMoney 千分位展示', () => {
  assert.strictEqual(Core.fmtMoney(123456789), '1,234,567.89');
  assert.strictEqual(Core.fmtMoney(150), '1.50');
  assert.strictEqual(Core.fmtMoney(0), '0.00');
  assert.strictEqual(Core.fmtMoney(-123456), '-1,234.56');
  assert.strictEqual(Core.fmtMoney(999), '9.99');
});

test('normalizeDate 多格式归一', () => {
  assert.strictEqual(Core.normalizeDate('2026-05-01'), '2026-05-01');
  assert.strictEqual(Core.normalizeDate('2026/5/1'), '2026-05-01');
  assert.strictEqual(Core.normalizeDate('20260501'), '2026-05-01');
  assert.strictEqual(Core.normalizeDate('2026年5月1日'), '2026-05-01');
  assert.strictEqual(Core.normalizeDate('not a date'), null);
});

test('daysBetween 与日期工具', () => {
  assert.strictEqual(Core.daysBetween('2026-05-01', '2026-05-03'), 2);
  assert.strictEqual(Core.daysBetween('2026-05-03', '2026-05-01'), -2);
  assert.strictEqual(Core.ymOf('2026-05-01'), '2026-05');
});
