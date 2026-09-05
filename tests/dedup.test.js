/* 跨源去重引擎单测（V1.3.5 核心）：
 * 场景覆盖：同源幂等 / 跨源高置信自动合并 / 同额远期候选 / 手动↔导入合并 /
 *           提现两端转转账（两个方向）/ 撤销恢复 / 统计不被污染
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Core = require('../js/core.js');

const ACCOUNTS = [
  { id: 'acc-wechat', name: '微信零钱', type: 'wechat', aliases: ['零钱'] },
  { id: 'acc-alipay', name: '支付宝', type: 'alipay', aliases: ['余额'] },
  { id: 'acc-bank', name: '招商银行', type: 'bank', aliases: ['招商银行(1234)'] }
];
const CATS = Core.defaultCategories();

let seq = 0;
function mkTxn(o) {
  return Object.assign({
    id: 't' + (++seq), date: '2026-05-02', time: '12:00:00',
    type: 'expense', amount: 4500, account: 'acc-bank', accountTo: null,
    category: null, merchant: '测试', note: '', source: 'manual', rawId: ''
  }, o);
}

/* ---------- buildTxns：同源单号幂等 ---------- */

test('同源幂等：同一账单二次导入零重复', () => {
  const records = Core.parseWechatCSV(
    '微信支付账单明细\n' +
    '交易时间,交易类型,交易对方,商品,收支,金额(元),支付方式,当前状态,交易单号\n' +
    '2026-05-01 12:00:00,商户消费,肯德基,肯德基,支出,¥45.00,零钱,支付成功,wx001\n'
  ).records;
  const ctx = { source: 'wechat', accounts: ACCOUNTS, categories: CATS, existingTxns: [] };
  const first = Core.buildTxns(records, ctx);
  assert.strictEqual(first.txns.length, 1);

  const second = Core.buildTxns(records, Object.assign({}, ctx, { existingTxns: first.txns }));
  assert.strictEqual(second.txns.length, 0);
  assert.strictEqual(second.dups.length, 1);
});

test('buildTxns：自动分类关键词命中', () => {
  const records = [{
    date: '2026-05-01', time: '12:00:00', type: '商户消费', payee: '肯德基',
    product: '肯德基宅急送', amountCents: 4500, direction: 'expense',
    method: '零钱', status: '支付成功', rawId: 'w1', note: '', transferLike: false
  }];
  const out = Core.buildTxns(records, { source: 'wechat', accounts: ACCOUNTS, categories: CATS, existingTxns: [] });
  assert.strictEqual(out.txns.length, 1);
  assert.strictEqual(out.txns[0].category, 'cat-food');
  assert.strictEqual(out.txns[0].account, 'acc-wechat'); // 零钱 → 微信零钱（别名）
});

test('buildTxns：提现映射为转账，对端未知保留半端并给出提示', () => {
  const records = [{
    date: '2026-05-03', time: '09:00:00', type: '零钱提现', payee: '零钱提现-到银行卡',
    product: '/', amountCents: 10000, direction: 'neutral',
    method: '零钱', status: '提现已完成', rawId: 'w2', note: '', transferLike: true
  }];
  const out = Core.buildTxns(records, {
    source: 'wechat', accounts: ACCOUNTS, categories: CATS,
    typeMapping: { '零钱提现': 'transfer' }, transferTarget: null, existingTxns: []
  });
  assert.strictEqual(out.txns[0].type, 'transfer');
  assert.strictEqual(out.txns[0].account, 'acc-wechat');
  assert.strictEqual(out.txns[0].accountTo, null);
  assert.strictEqual(out.txns[0].transferHalf, true);
  assert.ok(out.warnings.length > 0);
});

test('buildTxns：指定转账目标后直接双端齐全', () => {
  const records = [{
    date: '2026-05-03', time: '', type: '零钱提现', payee: '提现',
    product: '', amountCents: 10000, direction: 'neutral',
    method: '零钱', status: '', rawId: 'w3', note: '', transferLike: true
  }];
  const out = Core.buildTxns(records, {
    source: 'wechat', accounts: ACCOUNTS, categories: CATS,
    typeMapping: { '零钱提现': 'transfer' }, transferTarget: 'acc-bank', existingTxns: []
  });
  assert.strictEqual(out.txns[0].account, 'acc-wechat');
  assert.strictEqual(out.txns[0].accountTo, 'acc-bank');
  assert.strictEqual(out.txns[0].transferHalf, undefined);
});

/* ---------- matchDuplicates：三层去重 ---------- */

test('跨源高置信：同额同期自动合并（渠道保留，银行遮蔽）', () => {
  const existing = [mkTxn({ type: 'expense', source: 'wechat', amount: 4500, date: '2026-05-02', merchant: '肯德基' })];
  const incoming = [mkTxn({ type: 'expense', source: 'bank', amount: 4500, date: '2026-05-02', merchant: '快捷支付-微信支付' })];
  const m = Core.matchDuplicates(incoming, existing);
  assert.strictEqual(m.autoMerged.length, 1);
  assert.strictEqual(m.needConfirm.length, 0);
  const x = m.autoMerged[0];
  assert.strictEqual(x.kept.source, 'wechat');   // 保留渠道记录（含商户/分类）
  assert.strictEqual(x.shadow, incoming[0]);      // 银行记录被遮蔽
});

test('自动合并后统计只计一次；撤销后恢复两条', () => {
  const channel = mkTxn({ type: 'expense', source: 'wechat', amount: 4500, date: '2026-05-02' });
  const bank = mkTxn({ type: 'expense', source: 'bank', amount: 4500, date: '2026-05-02' });
  const m = Core.matchDuplicates([bank], [channel]);
  Core.applyAutoMerge(m.autoMerged[0]);

  const agg = Core.aggregate([channel, bank], { year: 2026, month: 5 });
  assert.strictEqual(agg.expense, 4500); // 不重复计

  Core.undoMerge(bank);
  const agg2 = Core.aggregate([channel, bank], { year: 2026, month: 5 });
  assert.strictEqual(agg2.expense, 9000); // 撤销后恢复独立两条
});

test('同额日期差>2天 → 低置信候选交用户确认', () => {
  const existing = [mkTxn({ type: 'expense', source: 'wechat', amount: 4500, date: '2026-05-01' })];
  const incoming = [mkTxn({ type: 'expense', source: 'bank', amount: 4500, date: '2026-05-10' })];
  const m = Core.matchDuplicates(incoming, existing);
  assert.strictEqual(m.autoMerged.length, 0);
  assert.strictEqual(m.needConfirm.length, 1);
  assert.strictEqual(m.needConfirm[0].kind, 'low-confidence');
});

test('手动↔导入：金额相同且日期差≤1天 → 提示合并', () => {
  const manual = mkTxn({ type: 'expense', source: 'manual', amount: 3550, date: '2026-05-05' });
  const incoming = [mkTxn({ type: 'expense', source: 'wechat', amount: 3550, date: '2026-05-05' })];
  const m = Core.matchDuplicates(incoming, [manual]);
  assert.strictEqual(m.needConfirm.length, 1);
  assert.strictEqual(m.needConfirm[0].kind, 'manual');
  assert.strictEqual(m.needConfirm[0].cand, manual);
});

test('手动↔导入：日期差>1天不提示', () => {
  const manual = mkTxn({ type: 'expense', source: 'manual', amount: 3550, date: '2026-05-01' });
  const incoming = [mkTxn({ type: 'expense', source: 'wechat', amount: 3550, date: '2026-05-05' })];
  const m = Core.matchDuplicates(incoming, [manual]);
  assert.strictEqual(m.needConfirm.length, 0);
  assert.strictEqual(m.unique.length, 1);
});

test('不同金额不匹配', () => {
  const existing = [mkTxn({ type: 'expense', source: 'wechat', amount: 4400, date: '2026-05-02' })];
  const incoming = [mkTxn({ type: 'expense', source: 'bank', amount: 4500, date: '2026-05-02' })];
  const m = Core.matchDuplicates(incoming, existing);
  assert.strictEqual(m.autoMerged.length, 0);
  assert.strictEqual(m.needConfirm.length, 0);
});

/* ---------- 提现两端 → 转账 ---------- */

test('提现配对①：渠道半端转账 + 已有银行入账 → 自动补齐转转账', () => {
  const bankIncome = mkTxn({ type: 'income', source: 'bank', amount: 10000, date: '2026-05-03', account: 'acc-bank', merchant: '零钱提现入账' });
  const halfTransfer = mkTxn({
    type: 'transfer', source: 'wechat', amount: 10000, date: '2026-05-03',
    account: 'acc-wechat', accountTo: null, transferHalf: true
  });
  const m = Core.matchDuplicates([halfTransfer], [bankIncome]);
  assert.strictEqual(m.transferPairs.length, 1);
  Core.applyTransferPair(m.transferPairs[0]);

  assert.strictEqual(halfTransfer.accountTo, 'acc-bank');  // 转入端补齐
  assert.strictEqual(bankIncome.mappedTo, halfTransfer.id); // 银行入账被遮蔽

  // 统计：不计收入；微信余额 -100、银行余额 +100
  const agg = Core.aggregate([halfTransfer, bankIncome], { year: 2026, month: 5 });
  assert.strictEqual(agg.income, 0);
  assert.strictEqual(agg.transferCount, 1);
  const wx = Core.accountBalance(ACCOUNTS[0], [halfTransfer]);
  const bk = Core.accountBalance(ACCOUNTS[2], [halfTransfer, bankIncome]);
  assert.strictEqual(wx, -10000);
  assert.strictEqual(bk, 10000);
});

test('提现配对②：先有渠道转账，后导银行流水 → 银行入账反向补齐', () => {
  const halfTransfer = mkTxn({
    type: 'transfer', source: 'wechat', amount: 10000, date: '2026-05-03',
    account: 'acc-wechat', accountTo: null, transferHalf: true
  });
  const bankIncome = mkTxn({ type: 'income', source: 'bank', amount: 10000, date: '2026-05-03', account: 'acc-bank' });
  const m = Core.matchDuplicates([bankIncome], [halfTransfer]);
  assert.strictEqual(m.transferPairs.length, 1);
  assert.strictEqual(m.needConfirm.length, 0);
  assert.strictEqual(m.autoMerged.length, 0); // 不应被当作普通跨源合并
  Core.applyTransferPair(m.transferPairs[0]);
  assert.strictEqual(halfTransfer.accountTo, 'acc-bank');
  assert.strictEqual(bankIncome.mappedTo, halfTransfer.id);
});

test('提现配对撤销：恢复银行入账原状', () => {
  const halfTransfer = mkTxn({ type: 'transfer', source: 'wechat', amount: 10000, date: '2026-05-03', account: 'acc-wechat', accountTo: null });
  const bankIncome = mkTxn({ type: 'income', source: 'bank', amount: 10000, date: '2026-05-03', account: 'acc-bank' });
  const m = Core.matchDuplicates([bankIncome], [halfTransfer]);
  Core.applyTransferPair(m.transferPairs[0]);
  Core.undoMerge(bankIncome);
  assert.strictEqual(bankIncome.mappedTo, undefined);
  assert.strictEqual(bankIncome.type, 'income');
});

/* ---------- 端到端：微信 + 招行混合导入 ---------- */

test('端到端：绑卡消费跨源只计一次，收支总额与手工核算一致', () => {
  // 第一步：导入微信账单（含 45 元绑招行卡的肯德基 + 100 元提现）
  const wxText =
    '微信支付账单明细\n' +
    '交易时间,交易类型,交易对方,商品,收支,金额(元),支付方式,当前状态,交易单号\n' +
    '2026-05-01 12:30:00,商户消费,肯德基,肯德基宅急送,支出,¥45.00,招商银行(1234),支付成功,wx001\n' +
    '2026-05-03 09:00:00,零钱提现,零钱提现-到银行卡,/,/,¥100.00,零钱,提现已完成,wx002\n';
  const wxParsed = Core.parseWechatCSV(wxText);
  const wxTypeMap = { '商户消费': 'expense', '零钱提现': 'transfer' };
  const wxBuilt = Core.buildTxns(wxParsed.records, {
    source: 'wechat', accounts: ACCOUNTS, categories: CATS,
    typeMapping: wxTypeMap, accountMapping: { '招商银行(1234)': 'acc-bank', '零钱': 'acc-wechat' },
    transferTarget: null, existingTxns: []
  });
  const ledger = wxBuilt.txns.slice();

  // 第二步：导入招行流水（含同一笔 45 元快捷支付 + 提现 100 元入账 + 工资 10000）
  const cmbText =
    '交易日期,货币,交易金额,联机余额,交易摘要,对手信息,渠道,流水号\n' +
    '2026-05-01,CNY,-45.00,49955.00,快捷支付-微信支付,财付通,移动支付,cmb001\n' +
    '2026-05-03,CNY,100.00,50055.00,零钱提现入账,财付通,移动支付,cmb002\n' +
    '2026-05-05,CNY,10000.00,60055.00,代发工资,某某公司,网上银行,cmb003\n';
  const cmbParsed = Core.parseBankCSV(cmbText, 'cmb');
  const cmbTypeMap = {}; // 银行默认按方向
  const cmbBuilt = Core.buildTxns(cmbParsed.records, {
    source: 'bank', accounts: ACCOUNTS, categories: CATS,
    typeMapping: cmbTypeMap, accountMapping: { '招商银行': 'acc-bank' }, existingTxns: ledger
  });

  const m = Core.matchDuplicates(cmbBuilt.txns, ledger);
  // 应用（向导的 apply 逻辑等价于）
  const inMatch = {};
  m.autoMerged.forEach(x => inMatch[x.inc.id] = x);
  m.transferPairs.forEach(x => { if (x.inc) inMatch[x.inc.id] = x; else inMatch[x.bankRecord.id] = x; });
  cmbBuilt.txns.forEach(inc => {
    const hit = inMatch[inc.id];
    if (!hit) { ledger.push(inc); return; }
    if (hit.bankTxn || hit.transfer) Core.applyTransferPair(hit);
    else Core.applyAutoMerge(hit);
    ledger.push(inc);
  });

  // 手工核算：支出 45（只计一次），收入 10000（工资），提现不计收支
  const agg = Core.aggregate(ledger, { year: 2026, month: 5 });
  assert.strictEqual(agg.expense, 4500);
  assert.strictEqual(agg.income, 1000000);
  assert.strictEqual(agg.transferCount, 1);

  // 账户余额：招行 = +10000(工资) −45(肯德基) +100(提现入账)；微信 = −100(提现)
  assert.strictEqual(Core.accountBalance(ACCOUNTS[2], ledger), 1000000 - 4500 + 10000);
  assert.strictEqual(Core.accountBalance(ACCOUNTS[0], ledger), -10000);
});
