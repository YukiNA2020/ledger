/* 通用 CSV 解析与编码检测单测 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../js/core.js');

function fixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
}

test('parseCSV 基础解析', () => {
  const rows = Core.parseCSV('a,b,c\n1,2,3\n');
  assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCSV 引号内逗号', () => {
  const rows = Core.parseCSV('name,note\n"美团,外卖平台",晚餐');
  assert.strictEqual(rows[1][0], '美团,外卖平台');
  assert.strictEqual(rows[1][1], '晚餐');
});

test('parseCSV 引号转义（双引号）', () => {
  const rows = Core.parseCSV('"say ""hi""",x');
  assert.strictEqual(rows[0][0], 'say "hi"');
});

test('parseCSV 引号内换行', () => {
  const rows = Core.parseCSV('a,b\n"line1\nline2",2');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1][0], 'line1\nline2');
});

test('parseCSV CRLF 换行与 BOM', () => {
  const rows = Core.parseCSV('\ufeffa,b\r\n1,2\r\n');
  assert.strictEqual(rows[0][0], 'a');
  assert.strictEqual(rows.length, 2);
});

test('parseCSV 空行过滤（全空字段行跳过由解析器上层处理）', () => {
  const rows = Core.parseCSV('a,b\n,\n1,2');
  // 中间行为空字段行，parseCSV 保留原始结构，业务层跳过
  assert.strictEqual(rows.length, 3);
});

test('decodeBytes UTF-8 BOM', () => {
  const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0x31, 0x32, 0x33]);
  const r = Core.decodeBytes(bytes);
  assert.strictEqual(r.text, '123');
  assert.strictEqual(r.encoding, 'utf-8');
});

test('decodeBytes 纯 UTF-8 中文', () => {
  const r = Core.decodeBytes(new Uint8Array(Buffer.from('交易号,金额', 'utf-8')));
  assert.strictEqual(r.text, '交易号,金额');
  assert.strictEqual(r.encoding, 'utf-8');
});

test('decodeBytes GBK 自动检测（支付宝 GBK 样例）', () => {
  const r = Core.decodeBytes(fixture('alipay_gbk.csv'));
  assert.strictEqual(r.encoding, 'gbk');
  assert.ok(r.text.includes('支付宝交易流水明细查询'));
  assert.ok(r.text.includes('肯德基宅急送'));
});

test('decodeBytes 微信 UTF-8 BOM 样例', () => {
  const r = Core.decodeBytes(fixture('wechat_sample.csv'));
  assert.strictEqual(r.encoding, 'utf-8');
  assert.ok(r.text.includes('微信支付账单明细'));
});
