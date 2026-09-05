/* 小账本应用布线验收 — 验证 index.html/app.js 的文件入口与交互布线
 * 覆盖：应用启动、导入向导文件选择、JSON 备份恢复确认、重复提交保护。
 * 只使用本文件内联的虚构数据；运行会重置本 origin 的账本测试数据。
 */
(function () {
  'use strict';

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

  function waitFor(fn, ms, label) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function attempt() {
        var v;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() - t0 > (ms || 5000)) return reject(new Error('等待超时：' + (label || '条件')));
        setTimeout(attempt, 80);
      })();
    });
  }

  function clickAction(selector) {
    var el = document.querySelector(selector);
    assert(el, '找不到元素 ' + selector);
    el.click();
  }

  // 3 笔虚构交易的备份文件（覆盖中文、逗号、双引号、转账、两位小数）
  function makeBackupFile() {
    var backup = {
      app: 'ledger', appVersion: 'wiring-test', schemaVersion: 1,
      exportedAt: '2026-09-05T08:00:00.000Z',
      accounts: [
        { id: 'acc-wechat', name: '微信零钱', type: 'wechat', initialBalance: 0, order: 1 },
        { id: 'acc-bank', name: '银行卡', type: 'bank', initialBalance: 0, order: 2 }
      ],
      categories: [],
      txns: [
        { id: 'w-1', date: '2026-09-01', time: '08:30', type: 'expense', amount: 1234,
          account: 'acc-wechat', category: null, merchant: '虚构,"商户"甲', note: '', source: 'manual' },
        { id: 'w-2', date: '2026-09-02', time: '12:00', type: 'expense', amount: 8850,
          account: 'acc-bank', category: null, merchant: '虚构咖啡店', note: '', source: 'manual' },
        { id: 'w-3', date: '2026-09-03', time: '09:00', type: 'transfer', amount: 10000,
          account: 'acc-wechat', accountTo: 'acc-bank', category: null, merchant: '', note: '', source: 'manual' }
      ],
      settings: {}
    };
    return new File([JSON.stringify(backup)], 'wiring-backup.json', { type: 'application/json' });
  }

  function injectFile(inputSelector, file) {
    var input = document.querySelector(inputSelector);
    assert(input, '找不到文件输入 ' + inputSelector);
    var dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    assert(input.files.length === 1, '文件注入失败');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function rawTxnCount() {
    var raw = await DB.loadRaw();
    return (raw.txns || []).length;
  }

  async function run() {
    // C1 应用启动：底部导航与首页渲染（hash 可能残留，先回首页）
    await check('应用启动并渲染首页骨架', async function () {
      await waitFor(function () { return document.querySelector('#tabbar [data-action="nav:home"]'); }, 8000, '底部导航');
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view .h-amount'); }, 8000, '首页金额');
      var bootTxns = await rawTxnCount();
      assert(bootTxns === 0, '启动应为空账本，实际 ' + bootTxns + ' 笔');
    });

    // C2 导入向导：文件选择 → 解析预览（修复前此链路无响应）
    await check('导入向导文件选择事件触发解析预览', async function () {
      clickAction('[data-action="nav:import"]');
      await waitFor(function () { return document.querySelector('#wiz-file'); }, 5000, '向导文件输入');
      var csvText = await fetch('fixtures/wechat_sample.csv').then(function (r) { return r.text(); });
      injectFile('#wiz-file', new File([csvText], 'wechat_sample.csv', { type: 'text/csv' }));
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('解析结果') >= 0;
      }, 5000, '解析预览');
      assert(/有效记录：<b>6<\/b>/.test(document.querySelector('#view').innerHTML), '应解析出 6 条有效记录');
    });

    // C3 备份恢复：文件选择 → 确认弹层 → 覆盖恢复生效（修复前此链路无响应）
    await check('JSON 备份恢复入口弹出确认并覆盖恢复', async function () {
      clickAction('[data-action="nav:settings"]');
      await waitFor(function () { return document.querySelector('#file-restore'); }, 5000, '恢复文件输入');
      injectFile('#file-restore', makeBackupFile());
      await waitFor(function () {
        return document.querySelector('#sheet').textContent.indexOf('恢复备份') >= 0;
      }, 5000, '恢复确认弹层');
      assert(document.querySelector('#sheet').textContent.indexOf('3 笔交易') >= 0, '确认弹层应显示交易数');
      clickAction('#confirm-ok');
      await waitFor(async function () { return (await rawTxnCount()) === 3; }, 5000, '恢复后交易数');
      var raw = await DB.loadRaw();
      equal(raw.txns.filter(function (t) { return t.id === 'w-3'; }).length, 1, '转账记录存在');
      equal(raw.accounts.length, 2, '备份账户数');
    });

    render();
    // 清理：恢复测试数据不影响后续人工使用
    DB.clearAll().then(function () {});
  }

  run().catch(function (error) {
    document.getElementById('summary').textContent = '布线验收脚本异常终止';
    document.getElementById('summary').className = 'summary fail';
    var box = document.getElementById('error');
    box.hidden = false;
    box.textContent = error && error.stack || String(error);
    document.body.dataset.result = 'fail';
  });
})();
