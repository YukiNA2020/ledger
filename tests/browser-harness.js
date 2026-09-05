(function () {
  'use strict';

  var VERSION = '2.0.0-rc.3';
  var results = [];

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function equal(actual, expected, label) {
    if (actual !== expected) throw new Error(label + '：预期 ' + expected + '，实际 ' + actual);
  }

  async function check(name, fn) {
    try {
      await fn();
      results.push({ name: name, pass: true });
    } catch (error) {
      results.push({ name: name, pass: false, error: error && error.message || String(error) });
    }
  }

  function render() {
    var passed = results.filter(function (r) { return r.pass; }).length;
    var failed = results.length - passed;
    document.getElementById('summary').textContent = '完成：' + passed + ' 项通过，' + failed + ' 项失败';
    document.getElementById('summary').className = 'summary ' + (failed ? 'fail' : 'pass');
    document.getElementById('results').innerHTML = results.map(function (r) {
      return '<li class="' + (r.pass ? 'pass' : 'fail') + '">' +
        (r.pass ? '✅ ' : '❌ ') + r.name + (r.error ? ' — ' + r.error : '') + '</li>';
    }).join('');
    document.body.dataset.result = failed ? 'fail' : 'pass';
  }

  function applyMatches(incoming, ledger, matches) {
    var byIncoming = {};
    matches.autoMerged.forEach(function (m) { byIncoming[m.inc.id] = m; });
    matches.transferPairs.forEach(function (m) {
      byIncoming[m.inc ? m.inc.id : m.bankRecord.id] = m;
    });
    incoming.forEach(function (txn) {
      var match = byIncoming[txn.id];
      if (match) {
        if (match.bankTxn || match.transfer) Core.applyTransferPair(match);
        else Core.applyAutoMerge(match);
      }
      ledger.push(txn);
    });
  }

  async function financialAcceptance() {
    var texts = await Promise.all([
      fetch('fixtures/wechat_sample.csv').then(function (r) { return r.text(); }),
      fetch('fixtures/cmb_sample.csv').then(function (r) { return r.text(); })
    ]);
    var accounts = Core.defaultAccounts();
    var categories = Core.defaultCategories();
    var wxParsed = Core.parseWechatCSV(texts[0]);
    equal(wxParsed.records.length, 6, '微信有效记录数');
    equal(wxParsed.errors.length, 1, '微信异常记录数');
    var wxBuilt = Core.buildTxns(wxParsed.records, {
      source: 'wechat', accounts: accounts, categories: categories,
      typeMapping: Core.suggestTypeMappings(wxParsed.records),
      accountMapping: {
        '零钱': 'acc-wechat',
        '招商银行(1234)': 'acc-bank',
        '中国银行(5678)': 'acc-bank'
      },
      transferTarget: null, existingTxns: []
    });
    var ledger = wxBuilt.txns.slice();

    var repeated = Core.buildTxns(wxParsed.records, {
      source: 'wechat', accounts: accounts, categories: categories,
      typeMapping: Core.suggestTypeMappings(wxParsed.records),
      accountMapping: {}, existingTxns: ledger
    });
    equal(repeated.txns.length, 0, '微信重复导入新增数');
    equal(repeated.dups.length, 6, '微信重复导入跳过数');

    var bankParsed = Core.parseBankCSV(texts[1], 'cmb');
    equal(bankParsed.records.length, 4, '招行有效记录数');
    var bankBuilt = Core.buildTxns(bankParsed.records, {
      source: 'bank', accounts: accounts, categories: categories,
      typeMapping: Core.suggestTypeMappings(bankParsed.records),
      accountMapping: { '招商银行': 'acc-bank' }, existingTxns: ledger
    });
    var matches = Core.matchDuplicates(bankBuilt.txns, ledger);
    equal(matches.autoMerged.length, 1, '绑卡消费自动合并数');
    equal(matches.transferPairs.length, 1, '提现转账配对数');
    applyMatches(bankBuilt.txns, ledger, matches);

    var agg = Core.aggregate(ledger, { year: 2026, month: 5, categories: categories });
    equal(agg.income, 1008888, '5 月收入（分）');
    equal(agg.expense, 131850, '5 月支出（分）');
    equal(agg.balance, 877038, '5 月结余（分）');
    equal(Core.visibleTxns(ledger).length, 8, '可见交易数');
    equal(Core.accountBalance(accounts[0], ledger), -5262, '微信零钱余额（分）');
    equal(Core.accountBalance(accounts[2], ledger), 882300, '银行卡余额（分）');
    return { accounts: accounts, categories: categories, txns: ledger, settings: Core.defaultSettings() };
  }

  async function run() {
    var acceptanceState;
    await check('固定微信 + 招行账单：解析、幂等、去重、转账与统计口径', async function () {
      acceptanceState = await financialAcceptance();
    });

    await check('同金额候选不唯一时拒绝自动合并', async function () {
      var existing = [
        { id: 'same-1', date: '2026-09-01', type: 'expense', amount: 2000, source: 'wechat', merchant: '虚构早餐店' },
        { id: 'same-2', date: '2026-09-01', type: 'expense', amount: 2000, source: 'wechat', merchant: '虚构便利店' }
      ];
      var incoming = [{ id: 'same-bank', date: '2026-09-01', type: 'expense', amount: 2000, source: 'bank', merchant: '财付通-微信支付' }];
      var match = Core.matchDuplicates(incoming, existing);
      equal(match.autoMerged.length, 0, '歧义候选自动合并数');
      equal(match.needConfirm.length, 1, '歧义候选人工确认数');
    });

    await check('退款、报销闭环与二级分类统计口径', async function () {
      var categories = [
        { id: 'food', type: 'expense', name: '餐饮', necessity: 'need' },
        { id: 'coffee', type: 'expense', name: '咖啡', parentId: 'food', necessity: 'want' }
      ];
      var expense = { id: 'refund-exp', date: '2026-09-01', type: 'expense', amount: 3000, account: 'a', category: 'coffee', merchant: '虚构咖啡店', source: 'manual' };
      var refund = { id: 'refund-inc', date: '2026-09-02', type: 'income', amount: 3000, account: 'a', merchant: '虚构咖啡店', source: 'alipay' };
      Core.linkRefund(refund, expense);
      var reimbursed = { id: 'reim-exp', date: '2026-09-03', type: 'expense', amount: 50000, account: 'a', category: 'food', merchant: '虚构差旅', source: 'manual', reimburseFlag: true };
      var reimbursement = { id: 'reim-inc', date: '2026-09-04', type: 'income', amount: 50000, account: 'a', merchant: '虚构报销到账', source: 'bank' };
      Core.linkReimbursement(reimbursement, reimbursed);
      var agg = Core.aggregate([expense, refund, reimbursed, reimbursement], { year: 2026, month: 9, categories: categories });
      equal(agg.expense, 0, '闭环后支出');
      equal(agg.income, 0, '闭环后收入');
      var rolled = Core.rollupByRoot({ coffee: { sum: 3000, count: 1 } }, categories);
      equal(rolled.food.sum, 3000, '二级分类并入一级金额');
    });

    await check('IndexedDB 明文状态写入后可完整读取', async function () {
      await DB.clearAll();
      await DB.saveAll(acceptanceState);
      var raw = await DB.loadRaw();
      equal(raw.txns.length, 10, '持久化交易数');
      equal(raw.accounts.length, 4, '持久化账户数');
    });

    await check('JSON 备份结构可序列化并无损恢复', async function () {
      var backup = Core.createBackup(acceptanceState, VERSION);
      var parsed = JSON.parse(JSON.stringify(backup));
      var restored = Core.restoreStateFromBackup(parsed);
      equal(parsed.appVersion, VERSION, '备份应用版本');
      equal(restored.txns.length, acceptanceState.txns.length, '备份交易数');
      equal(restored.accounts.length, acceptanceState.accounts.length, '备份账户数');
      equal(restored.settings.lock.enabled, false, '恢复后应用锁状态');
    });

    await check('CSV 明细带 BOM 且金额、中文与转义正确', async function () {
      var csv = Core.transactionsToCSV(acceptanceState.txns, acceptanceState.accounts, acceptanceState.categories);
      assert(csv.charCodeAt(0) === 0xFEFF, 'CSV 缺少 BOM');
      assert(csv.indexOf('日期,时间,类型,金额(元)') === 1, 'CSV 表头错误');
      assert(csv.indexOf('肯德基') > 0 && csv.indexOf('45.00') > 0, 'CSV 明细内容错误');
    });

    await check('应用锁以 AES-GCM 加密交易且正确密码可解锁', async function () {
      var params = await DB.makeLockParams('rc1-test-password');
      var lockedState = Object.assign({}, acceptanceState, {
        settings: Object.assign({}, acceptanceState.settings, {
          lock: { enabled: true, salt: params.salt, iter: params.iter }
        })
      });
      await DB.saveAll(lockedState);
      var raw = await DB.loadRaw();
      equal(raw.txns.enc, 1, '密文标记');
      equal(raw.txns.alg, 'AES-GCM', '加密算法');
      assert(JSON.stringify(raw.txns).indexOf('肯德基') < 0, '密文中不应出现商户明文');
      DB.dropMemoryKey();
      var unlocked = await DB.unlock('rc1-test-password', raw.settings.lock, raw.txns);
      equal(unlocked.length, acceptanceState.txns.length, '解锁交易数');
    });

    await check('错误密码无法解密应用锁数据', async function () {
      var raw = await DB.loadRaw();
      DB.dropMemoryKey();
      var rejected = false;
      try { await DB.unlock('wrong-password', raw.settings.lock, raw.txns); }
      catch (error) { rejected = true; }
      assert(rejected, '错误密码必须被拒绝');
    });

    await check('清空操作移除全部账本数据', async function () {
      await DB.clearAll();
      var raw = await DB.loadRaw();
      assert(raw.accounts === undefined && raw.categories === undefined && raw.txns === undefined && raw.settings === undefined,
        '清空后仍残留账本数据');
    });

    render();
  }

  run().catch(function (error) {
    document.getElementById('summary').textContent = '验收脚本异常终止';
    document.getElementById('summary').className = 'summary fail';
    var box = document.getElementById('error');
    box.hidden = false;
    box.textContent = error && error.stack || String(error);
    document.body.dataset.result = 'fail';
  });
})();
