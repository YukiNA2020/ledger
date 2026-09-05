/* 多源账单解析器单测：微信 / 支付宝(UTF-8+GBK) / 银行(招行/中行/自定义模板) */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../js/core.js');

function fixtureText(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');
}
function fixtureBytes(name) {
  return new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
}
const byRawId = (records, id) => records.find(r => r.rawId === id);

/* ---------------- 微信 ---------------- */

test('微信：表头定位 + 字段解析全部正确', () => {
  const p = Core.parseWechatCSV(fixtureText('wechat_sample.csv'));
  assert.strictEqual(p.meta.source, 'wechat');
  assert.strictEqual(p.records.length, 6);
  assert.strictEqual(p.errors.length, 1); // 'abc' 异常金额行

  const kfc = byRawId(p.records, 'wxn0001');
  assert.strictEqual(kfc.date, '2026-05-01');
  assert.strictEqual(kfc.time, '12:30:00');
  assert.strictEqual(kfc.payee, '肯德基');
  assert.strictEqual(kfc.product, '肯德基宅急送');
  assert.strictEqual(kfc.amountCents, 4500);
  assert.strictEqual(kfc.direction, 'expense');
  assert.strictEqual(kfc.method, '招商银行(1234)');
  assert.strictEqual(kfc.status, '支付成功');
});

test('微信：引号内逗号不破坏列对齐', () => {
  const p = Core.parseWechatCSV(fixtureText('wechat_sample.csv'));
  const mt = byRawId(p.records, 'wxn0005');
  assert.strictEqual(mt.payee, '美团,外卖平台');
  assert.strictEqual(mt.product, '美团外卖订单');
  assert.strictEqual(mt.amountCents, 3550);
  assert.strictEqual(mt.note, '晚餐加鸡腿');
});

test('微信：提现识别为转账候选 + neutral 方向', () => {
  const p = Core.parseWechatCSV(fixtureText('wechat_sample.csv'));
  const tx = byRawId(p.records, 'wxn0003');
  assert.strictEqual(tx.transferLike, true);
  assert.strictEqual(tx.direction, 'neutral');
  assert.strictEqual(tx.amountCents, 10000);
});

test('微信：红包收入方向', () => {
  const p = Core.parseWechatCSV(fixtureText('wechat_sample.csv'));
  assert.strictEqual(byRawId(p.records, 'wxn0004').direction, 'income');
});

test('微信：异常金额行报错不崩溃', () => {
  const p = Core.parseWechatCSV(fixtureText('wechat_sample.csv'));
  assert.ok(p.errors[0].message.includes('无法解析'));
  assert.ok(p.errors[0].line > 0);
});

test('微信：缺少表头时给出明确错误', () => {
  const p = Core.parseWechatCSV('随便的内容\n没有表头\n');
  assert.strictEqual(p.records.length, 0);
  assert.ok(p.errors.length > 0);
});

/* ---------------- 支付宝 ---------------- */

test('支付宝：UTF-8 样例解析', () => {
  const p = Core.parseAlipayCSV(fixtureText('alipay_sample.csv'));
  assert.strictEqual(p.meta.source, 'alipay');
  assert.strictEqual(p.records.length, 4);
  assert.strictEqual(p.errors.length, 1); // 末尾坏行

  const kfc = byRawId(p.records, '2026050121001234001');
  assert.strictEqual(kfc.date, '2026-05-01');
  assert.strictEqual(kfc.payee, '肯德基');
  assert.strictEqual(kfc.amountCents, 4500);
  assert.strictEqual(kfc.direction, 'expense');
  assert.strictEqual(kfc.method, '招商银行(1234)'); // 资金状态列
});

test('支付宝：退款识别（打退款标记 + 收入方向）', () => {
  const p = Core.parseAlipayCSV(fixtureText('alipay_sample.csv'));
  const ref = byRawId(p.records, '2026050321009012003');
  assert.strictEqual(ref.refund, true);
  assert.strictEqual(ref.direction, 'income');
});

test('支付宝：提现 → 转账候选 + 不计收支', () => {
  const p = Core.parseAlipayCSV(fixtureText('alipay_sample.csv'));
  const tx = byRawId(p.records, '2026050421003456004');
  assert.strictEqual(tx.transferLike, true);
  assert.strictEqual(tx.direction, 'neutral');
});

test('支付宝：GBK 编码自动检测解析', () => {
  const dec = Core.decodeBytes(fixtureBytes('alipay_gbk.csv'));
  assert.strictEqual(dec.encoding, 'gbk');
  const p = Core.parseAlipayCSV(dec.text);
  assert.strictEqual(p.records.length, 2);
  assert.strictEqual(p.records[0].payee, '肯德基');
  assert.strictEqual(p.records[1].transferLike, true);
});

/* ---------------- 银行流水 ---------------- */

test('招行预设：正负号金额方向识别', () => {
  const text = fixtureText('cmb_sample.csv');
  const tpl = Core.matchBankTemplate(text);
  assert.ok(tpl, '应自动识别招行模板');
  const p = Core.parseBankCSV(text, tpl);
  assert.strictEqual(p.meta.template, '招商银行');
  assert.strictEqual(p.records.length, 4);
  assert.strictEqual(p.errors.length, 0);

  const salary = byRawId(p.records, 'cmb001');
  assert.strictEqual(salary.direction, 'income');
  assert.strictEqual(salary.amountCents, 1000000);
  assert.strictEqual(salary.note, '代发工资');

  const wx = byRawId(p.records, 'cmb002');
  assert.strictEqual(wx.direction, 'expense');
  assert.strictEqual(wx.amountCents, 4500);
  assert.strictEqual(wx.payee, '财付通支付科技有限公司');

  const deposit = byRawId(p.records, 'cmb003');
  assert.strictEqual(deposit.direction, 'income');   // 零钱提现入账
  assert.strictEqual(deposit.amountCents, 10000);

  const rent = byRawId(p.records, 'cmb004');
  assert.strictEqual(rent.direction, 'expense');
  assert.strictEqual(rent.amountCents, 120000);
});

test('中行预设：借贷双列金额识别', () => {
  const text = fixtureText('boc_sample.csv');
  const tpl = Core.matchBankTemplate(text);
  assert.ok(tpl, '应自动识别中行模板');
  const p = Core.parseBankCSV(text, tpl);
  assert.strictEqual(p.records.length, 3);

  const salary = byRawId(p.records, 'boc001');
  assert.strictEqual(salary.direction, 'income');
  assert.strictEqual(salary.amountCents, 1500000);

  const ali = byRawId(p.records, 'boc002');
  assert.strictEqual(ali.direction, 'expense');
  assert.strictEqual(ali.amountCents, 4500);
});

test('通用列映射模板（任意银行 CSV）', () => {
  const text = fixtureText('generic_bank.csv');
  const tpl = {
    _custom: true, name: 'XX银行',
    cols: { date: '日期', debit: '支出', credit: '收入', note: '说明' }
  };
  const p = Core.parseBankCSV(text, tpl);
  assert.strictEqual(p.records.length, 3);
  assert.strictEqual(p.errors.length, 0);

  const [salary, shop, phone] = p.records;
  assert.strictEqual(salary.date, '2026-05-01');     // 2026/05/01 归一化
  assert.strictEqual(salary.direction, 'income');
  assert.strictEqual(salary.amountCents, 800000);
  assert.strictEqual(salary.note, '工资');

  assert.strictEqual(shop.direction, 'expense');
  assert.strictEqual(shop.amountCents, 2550);

  assert.strictEqual(phone.direction, 'expense');
  assert.strictEqual(phone.amountCents, 5000);
  assert.strictEqual(phone.note, '话费充值');
});

test('方向文本列（收/支）识别', () => {
  const csv = '交易日期,收/支,金额,摘要\n2026-05-01,收入,500.00,利息\n2026-05-02,支出,30.00,超市';
  const p = Core.parseBankCSV(csv, 'cmb');
  assert.strictEqual(p.records.length, 2);
  assert.strictEqual(p.records[0].direction, 'income');
  assert.strictEqual(p.records[1].direction, 'expense');
});

test('银行：自定义模板无方向信息且无符号时报错而非臆测', () => {
  const csv = '交易日期,金额,摘要\n2026-05-01,50.00,消费';
  const tpl = { _custom: true, name: '测试', cols: { date: '交易日期', amount: '金额' } };
  const p = Core.parseBankCSV(csv, tpl);
  assert.strictEqual(p.records.length, 0);
  assert.ok(p.errors.length > 0);
});

test('银行：默认方向兜底（defaultDirection）', () => {
  const csv = '交易日期,金额,摘要\n2026-05-01,50.00,消费';
  const tpl = { _custom: true, name: '测试', cols: { date: '交易日期', amount: '金额' }, defaultDirection: 'expense' };
  const p = Core.parseBankCSV(csv, tpl);
  assert.strictEqual(p.records.length, 1);
  assert.strictEqual(p.records[0].direction, 'expense');
});

/* ---------------- 来源自动识别 ---------------- */

test('parseFile 自动识别微信来源', () => {
  const p = Core.parseFile(fixtureText('wechat_sample.csv'));
  assert.strictEqual(p.meta.source, 'wechat');
  assert.strictEqual(p.records.length, 6);
});

test('parseFile 自动识别支付宝来源', () => {
  const p = Core.parseFile(fixtureText('alipay_sample.csv'));
  assert.strictEqual(p.meta.source, 'alipay');
});

test('parseFile 无法识别时明确报错（导入失败不污染数据）', () => {
  const p = Core.parseFile('hello,world\n1,2');
  assert.strictEqual(p.records.length, 0);
  assert.ok(p.errors[0].message.includes('无法识别'));
});
