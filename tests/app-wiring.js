/* 小账本应用布线验收 — 验证 index.html/app.js 的文件入口与交互布线
 * 覆盖：应用启动、导入向导文件选择、JSON 备份恢复确认、重复提交保护。
 *
 * Phase 2 起本页必须由本地服务托管（http://127.0.0.1:<port>/tests/app-wiring.html）：
 * SQLite 是唯一事实源，页面离开服务就没有可写的数据源，脚本会先做服务前置检查。
 * 只使用本文件内联的虚构数据；运行前请用临时数据目录启动服务，避免触碰真实账本：
 *   node server/main.js --data-dir "$(mktemp -d)" --port 8499 --no-open
 * 运行会重置该临时数据目录里的账本测试数据。
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

  // 轮询直到谓词为真。谓词可以是异步的：必须 await 结果再判断，
  // 否则 Promise 对象本身恒为真值，会让调用方在写入落盘前就继续执行。
  function waitFor(fn, ms, label) {
    var limit = ms || 5000;
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      function retryOrFail() {
        if (Date.now() - t0 > limit) return reject(new Error('等待超时：' + (label || '条件')));
        setTimeout(attempt, 80);
      }
      function attempt() {
        Promise.resolve()
          .then(fn)
          .then(function (v) { if (v) resolve(v); else retryOrFail(); },
                function () { retryOrFail(); });
      }
      attempt();
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
    var raw = await Store.loadRaw();
    return (raw.txns || []).length;
  }

  // 直接问服务要一份事实源内容，用来证明"页面读到的就是 SQLite 里存的"（S2.1）
  async function apiState() {
    var res = await fetch('/api/v1/state', { headers: { Accept: 'application/json' } });
    assert(res.ok, 'GET /api/v1/state 应返回 200，实际 ' + res.status);
    return res.json();
  }

  async function run() {
    // C0 前置：页面必须由本地服务托管，且 SQLite 已成为唯一事实源（S2.1/S2.2 前提）
    await check('本地服务可达且事实源为 SQLite', async function () {
      var mode = await Store.detect(true);
      equal(mode, 'api', 'Store 模式必须是 api（本页需由本地服务托管，而非 file:// 直开）');
      var health = await fetch('/api/v1/health').then(function (r) { return r.json(); });
      equal(health.policy.factSource, 'sqlite', '事实源必须是 sqlite');
      equal(health.policy.host, '127.0.0.1', '只允许绑定 loopback');
      equal(health.policy.writesRequireToken, true, '写请求必须要求会话令牌');
      equal(health.policy.cors, 'disabled', '不得开放 CORS');
      equal(health.policy.cloudAi, false, '不得接云端 AI');
      assert(Store.readSessionToken(), '页面应拿到服务注入的会话令牌');
      assert(!document.querySelector('#service-banner').classList.contains('warn'), '服务可达时不应显示只读降级横幅');
    });

    // C1 应用启动：资产决策台空状态 + 现金流页可达（v3 Phase 1 首页重构）
    await check('应用启动渲染资产决策台空状态并可进入现金流页', async function () {
      await waitFor(function () { return document.querySelector('#tabbar [data-action="nav:home"]'); }, 8000, '底部导航');
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view .dash-empty'); }, 8000, '决策台空状态');
      assert(document.querySelector('#view').textContent.indexOf('还没有资产数据') >= 0, '空状态不虚构总额');
      assert(document.querySelector('#view').textContent.indexOf('净资产') >= 0, '空状态说明将展示的口径');
      clickAction('[data-action="nav:cashflow"]');
      await waitFor(function () { return document.querySelector('#view .h-amount'); }, 8000, '现金流页金额');
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
      var raw = await Store.loadRaw();
      equal(raw.txns.filter(function (t) { return t.id === 'w-3'; }).length, 1, '转账记录存在');
      equal(raw.accounts.length, 2, '备份账户数');
    });

    // C4 S1.1 旧状态兼容：v1 备份恢复后 v3 资产集合为空，决策台空状态正常
    await check('v1 备份恢复后资产集合初始化为空且决策台空状态', async function () {
      var raw = await Store.loadRaw();
      assert(raw.assets && raw.assets.schemaVersion === 1, '恢复后应写入空 v3 资产集合');
      equal(raw.assets.assetUnits.length, 0, '余额单元为空');
      equal(raw.assets.holdings.length, 0, '持仓为空');
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view .dash-empty'); }, 8000, '决策台空状态');
    });

    // C5 S1.2/S1.3 v2 备份（含虚构资产）恢复后决策台按口径渲染
    // 用当日日期动态构造，保证 asOf/价格日/汇率日永远新鲜（正式口径不随运行日期漂移）
    await check('v2 资产备份恢复后决策台展示精确口径', async function () {
      clickAction('[data-action="nav:settings"]');
      await waitFor(function () { return document.querySelector('#file-restore'); }, 5000, '恢复文件输入');
      var d = Core.todayStr();
      var backup = {
        app: 'ledger', appVersion: 'wiring-test', schemaVersion: 2,
        exportedAt: d + 'T08:00:00.000Z',
        accounts: [], categories: [], txns: [],
        assets: {
          schemaVersion: 1,
          assetAccounts: [
            { id: 'acc-cmb', name: '招行储蓄', kind: 'bank', pool: 'safety', status: 'active' },
            { id: 'acc-hsbc', name: '汇丰 USD 子账户', kind: 'bank', pool: 'investable', institution: '香港汇丰', status: 'active' },
            { id: 'acc-broker', name: '券商账户', kind: 'broker', pool: 'investable', status: 'active' },
            { id: 'acc-gjj', name: '青岛公积金', kind: 'government', pool: 'restricted', status: 'active' }
          ],
          assetUnits: [
            { id: 'u-cmb', accountId: 'acc-cmb', currency: 'CNY', balanceMinor: 3000000, asOf: d, sourceType: 'manual' },
            { id: 'u-hsbc', accountId: 'acc-hsbc', currency: 'USD', balanceMinor: 100000, asOf: d, sourceType: 'manual' },
            { id: 'u-gjj', accountId: 'acc-gjj', currency: 'CNY', balanceMinor: 500000, asOf: d, sourceType: 'manual' }
          ],
          liabilities: [
            { id: 'l-card', name: '信用卡待还', currency: 'CNY', balanceMinor: 200000, termType: 'current', asOf: d }
          ],
          entitlements: [
            { id: 'e-ub', name: '失业保险待遇资格', kind: 'unemployment', jurisdiction: '青岛', status: 'active', balanceMinor: null, asOf: d }
          ],
          instruments: [
            { id: 'ins-voo', symbol: 'VOO', exchange: 'NYSE', currency: 'USD', name: '标普500 ETF', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'US', classificationStatus: 'confirmed' }
          ],
          holdings: [
            { id: 'h-voo', accountId: 'acc-broker', instrumentId: 'ins-voo', quantity: '10', costMinor: 45000, asOf: d }
          ],
          quotes: [
            { instrumentId: 'ins-voo', priceMinor: 5000, currency: 'USD', priceDate: d, fetchedAt: d + 'T08:00:00Z', provider: 'wiring-fixture', status: 'ok' }
          ],
          fxRates: [
            { base: 'USD', quote: 'CNY', rateDecimal: '7.20', rateDate: d, fetchedAt: d + 'T08:00:00Z', provider: 'wiring-fixture', status: 'ok' }
          ]
        },
        settings: {}
      };
      injectFile('#file-restore', new File([JSON.stringify(backup)], 'phase1-backup-v2.json', { type: 'application/json' }));
      await waitFor(function () {
        return document.querySelector('#sheet').textContent.indexOf('恢复备份') >= 0;
      }, 5000, '恢复确认弹层');
      assert(document.querySelector('#sheet').textContent.indexOf('v3 资产数据') >= 0, '确认弹层应提示 v3 资产数据');
      clickAction('#confirm-ok');
      await waitFor(function () { return document.querySelector('#view .dash-net'); }, 8000, '决策台净资产');
      var text = document.querySelector('#view').textContent;
      // ACCEPTANCE §2：净资产 43,800；可投资 10,800；可新增 5,200
      assert(text.indexOf('43,800.00') >= 0, '净资产应为 43,800，实际：' + text.slice(0, 200));
      assert(text.indexOf('10,800.00') >= 0, '可投资资产应为 10,800');
      assert(text.indexOf('5,200.00') >= 0, '可新增投资资金应为 5,200');
      assert(text.indexOf('33.3%') >= 0, '宽基权益配比应为 33.3%');
      assert(text.indexOf('正式口径') >= 0, '完整数据应为正式口径');
      // 现金流与旧功能入口仍在
      assert(document.querySelector('#view [data-action="nav:cashflow"]'), '决策台应保留现金流入口');
    });

    // C6 S2.1 单一事实源：经应用写入的数据只能落在 SQLite，且 IndexedDB 不再被写入
    await check('SQLite 是唯一事实源且 IndexedDB 未被双写', async function () {
      var before = await Store.loadRaw();
      var probeTxn = {
        id: 'w-s2-1-probe', date: '2026-09-10', time: '10:00', type: 'expense', amount: 4321,
        account: 'acc-s2-1', category: null, merchant: 'S2.1 探针', note: '', source: 'manual'
      };
      await Store.saveAll({
        accounts: (before.accounts || []).concat([
          { id: 'acc-s2-1', name: 'S2.1 探针账户', type: 'wechat', initialBalance: 0, order: 99 }
        ]),
        categories: before.categories || [],
        txns: (before.txns || []).concat([probeTxn]),
        settings: before.settings || {},
        assets: before.assets
      });

      // 绕开页面路由，直接 HTTP 读 SQLite：写入内容必须已经落库
      var state = await apiState();
      equal((state.txns || []).filter(function (t) { return t.id === 'w-s2-1-probe'; }).length, 1,
        'HTTP 直读 SQLite 应看到经应用写入的交易');
      assert((state.accounts || []).some(function (a) { return a.id === 'acc-s2-1'; }),
        'HTTP 直读 SQLite 应看到经应用新增的账户');
      equal(state.assets.schemaVersion, 1, 'assets 必须带 schemaVersion（与前端 DB.loadRaw 形状一致）');

      // 服务端复用同一份 js/domain.js 计算总览，口径必须与领域定义一致（ACCEPTANCE §2）
      var overviewJson = await fetch('/api/v1/overview').then(function (r) { return r.json(); });
      equal(overviewJson.netWorthMinor, 4380000, '服务端净资产口径');
      equal(overviewJson.pools.investableMinor, 1080000, '服务端可投资口径');
      equal(overviewJson.newFundsAvailableMinor, 520000, '服务端可新增资金口径');
      equal(overviewJson.valuationStatus, 'formal', '完整性足够时应为正式口径');

      // 关键反证：API 模式下 IndexedDB 不应再承担 v3 事实源（ARCHITECTURE §9 禁止双写）
      var legacy = await DB.loadRaw();
      equal((legacy.txns || []).length, 0, 'IndexedDB 不应被写入交易（无双写）');
      equal((legacy.accounts || []).length, 0, 'IndexedDB 不应被写入账户（无双写）');
    });

    // C7 S2.2 写入门禁：缺令牌 / 错 Content-Type 的写请求被拒，只读能力不受影响
    await check('非法写请求被拒绝且当前只读可用', async function () {
      var before = await apiState();
      var probeCount = (before.txns || []).filter(function (t) { return t.id === 'w-s2-1-probe'; }).length;
      equal(probeCount, 1, '前置：S2.1 探针交易应已存在');

      var noToken = await fetch('/api/v1/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: { accounts: [], categories: [], txns: [], settings: {} } })
      });
      equal(noToken.status, 401, '缺少会话令牌的写请求应 401');

      var noTokenBackup = await fetch('/api/v1/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      equal(noTokenBackup.status, 401, '缺少会话令牌的手动备份应 401');

      var wrongType = await fetch('/api/v1/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain', 'x-ledger-token': Store.readSessionToken() },
        body: JSON.stringify({ state: { accounts: [], categories: [], txns: [], settings: {} } })
      });
      equal(wrongType.status, 415, '非 JSON 写请求应 415');

      var after = await apiState();
      equal((after.txns || []).length, (before.txns || []).length, '被拒写入不得改动交易');
      equal((after.accounts || []).length, (before.accounts || []).length, '被拒写入不得改动账户');

      // 只读路径不受门禁影响：GET 与页面渲染都还能用
      var health = await fetch('/api/v1/health');
      equal(health.status, 200, '只读健康检查仍应 200');
      await waitFor(function () { return document.querySelector('#view .dash-net'); }, 5000, '只读页面仍可用');
    });

    // C9 S3 恢复前强制备份：UI 恢复必须先留 pre-import 备份，不受 60 秒写后备份节流限制。
    // 修复前：恢复走普通全量 PUT，若 60 秒内刚写过数据，被覆盖的版本无备份可回滚。
    await check('JSON 恢复前强制留 pre-import 备份（节流窗口内也可回滚）', async function () {
      // 先做一次普通写入，把写后备份的节流窗口起点拉到"刚刚"
      var before = await Store.loadRaw();
      await Store.saveAll({
        accounts: before.accounts, categories: before.categories,
        txns: before.txns, settings: before.settings, assets: before.assets
      });
      var namesBefore = (await Store.listBackups()).items.map(function (b) { return b.name; });

      clickAction('[data-action="nav:settings"]');
      await waitFor(function () { return document.querySelector('#file-restore'); }, 5000, '恢复文件输入');
      injectFile('#file-restore', makeBackupFile());
      await waitFor(function () {
        return document.querySelector('#sheet').textContent.indexOf('恢复备份') >= 0;
      }, 5000, '恢复确认弹层');
      clickAction('#confirm-ok');
      await waitFor(async function () { return (await rawTxnCount()) === 3; }, 5000, '恢复后交易数');

      // 覆盖前必须新增一份 pre-import 备份（同秒重复备份会被加 -N 后缀，避免互相覆盖）
      var namesAfter = (await Store.listBackups()).items.map(function (b) { return b.name; });
      var preImports = namesAfter.filter(function (n) { return /-pre-import(-\d+)?\.db$/.test(n); });
      assert(preImports.length >= 1, '恢复覆盖前应强制留 pre-import 备份，实际列表：' + namesAfter.join(', '));
      var fresh = preImports.filter(function (n) { return namesBefore.indexOf(n) < 0; });
      assert(fresh.length >= 1, '本次恢复应产生新的 pre-import 备份');
    });

    // S3.1 资产录入页布线：决策台入口 → 新增账户 → 登记余额 → 落库可直读，
    // 且全量写回（记账路径 writeState 先清后写）不会抹掉资源接口写入的数据。
    await check('资产录入页可建账户并登记余额，且不被全量写回抹掉', async function () {
      // C9 的恢复把资产清掉了：决策台应显示空状态与「录入资产」入口
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view .dash-empty'); }, 8000, '决策台空状态');
      assert(document.querySelector('#view [data-action="nav:assets"]'), '空状态应提供资产录入入口');
      clickAction('[data-action="nav:assets"]');
      await waitFor(function () { return document.querySelector('#view [data-action="asset:acc"]'); }, 5000, '新增账户入口');

      // 新增账户（安全储备池）
      clickAction('[data-action="asset:acc"]');
      await waitFor(function () { return document.querySelector('#aa-name'); }, 5000, '账户表单');
      document.querySelector('#aa-name').value = '布线储蓄卡';
      document.querySelector('#aa-inst').value = '布线银行';
      document.querySelector('#aa-pool').value = 'safety';
      clickAction('[data-action="asset:saveAcc"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('布线储蓄卡') >= 0;
      }, 5000, '账户出现在列表');

      // 登记余额 3000 CNY，核对日为今天
      clickAction('[data-action="asset:unit"]');
      await waitFor(function () { return document.querySelector('#au-bal'); }, 5000, '余额表单');
      document.querySelector('#au-bal').value = '3000';
      clickAction('[data-action="asset:saveUnit"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('3,000.00') >= 0;
      }, 5000, '余额出现在列表');

      // 新增负债与保障权益
      clickAction('[data-action="asset:liab"]');
      await waitFor(function () { return document.querySelector('#al-name'); }, 5000, '负债表单');
      document.querySelector('#al-name').value = '布线信用卡';
      document.querySelector('#al-bal').value = '500';
      clickAction('[data-action="asset:saveLiab"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('布线信用卡') >= 0;
      }, 5000, '负债出现在列表');

      clickAction('[data-action="asset:ent"]');
      await waitFor(function () { return document.querySelector('#ae-name'); }, 5000, '权益表单');
      document.querySelector('#ae-name').value = '布线医保';
      document.querySelector('#ae-status').value = '在缴';
      clickAction('[data-action="asset:saveEnt"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('布线医保') >= 0;
      }, 5000, '权益出现在列表');

      // SQLite 直读：四类资源都已落库
      var st = await apiState();
      assert((st.assets.assetAccounts || []).some(function (a) { return a.name === '布线储蓄卡' && a.pool === 'safety'; }),
        '账户应落库');
      var unit = (st.assets.assetUnits || []).filter(function (u) { return u.balanceMinor === 300000; });
      assert(unit.length === 1 && unit[0].sourceType === 'manual', '余额应以最小货币单位落库');
      assert((st.assets.liabilities || []).some(function (l) { return l.name === '布线信用卡' && l.balanceMinor === 50000; }),
        '负债应落库');
      assert((st.assets.entitlements || []).some(function (e) { return e.name === '布线医保' && e.balanceMinor === null; }),
        '权益应落库且无金额');

      // 关键反证：走一次全量写回（记账路径），资源接口写入的数据不得被抹掉
      var raw = await Store.loadRaw();
      await Store.saveAll({
        accounts: raw.accounts, categories: raw.categories,
        txns: raw.txns, settings: raw.settings, assets: raw.assets
      });
      var st2 = await apiState();
      assert((st2.assets.assetAccounts || []).some(function (a) { return a.name === '布线储蓄卡'; }),
        '全量写回后账户必须仍在（writeState 先清后写不可丢资源数据）');
      assert((st2.assets.assetUnits || []).some(function (u) { return u.balanceMinor === 300000; }),
        '全量写回后余额必须仍在');
    });

    // S3.3 月度结账页布线：上月核对清单 → 余额未在上月核对 → 只能估算结账；
    // 保存后历史出现记录，HTTP 直读 monthly_closes 与快照哈希。
    await check('月度结账按上月口径生成清单并可保存估算快照', async function () {
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:close"]'); }, 5000, '决策台结账入口');
      clickAction('[data-action="nav:close"]');
      await waitFor(function () {
        return document.querySelector('#view [data-action="close:save"]');
      }, 5000, '结账页清单');

      // 余额核对日是本月，结账月份是上月 → 必有 balance_stale 类阻塞 → 正式结账按钮必须禁用
      var formalBtn = document.querySelector('#view [data-action="close:save"][data-status="formal"]');
      assert(formalBtn, '正式结账按钮应存在 · view=' + document.querySelector('#view').textContent.slice(0, 120));
      assert(formalBtn.disabled, '上月未核对余额时正式结账必须禁用');

      // 保存为估算快照
      clickAction('[data-action="close:save"][data-status="estimate"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('历史结账') >= 0 &&
          document.querySelector('#view').textContent.indexOf('估算') >= 0 &&
          document.querySelector('#view').textContent.indexOf('还没有结账记录') < 0;
      }, 8000, '历史结账记录');

      // HTTP 直读：monthly_closes 一条，月份为上一个完整自然月，快照哈希存在
      var prev = Core.todayStr().slice(0, 7);
      var prevYm = (function (ym) {
        var d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1);
        d.setMonth(d.getMonth() - 1); // 退回上一个完整自然月（1 号日期下 setMonth 不会跳月）
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      })(prev);
      var closes = await fetch('/api/v1/monthly-closes').then(function (r) { return r.json(); });
      equal((closes.items || []).length, 1, '应有一条结账记录');
      equal(closes.items[0].month, prevYm, '结账月份应为上一个完整自然月');
      equal(closes.items[0].status, 'estimate', '上月余额未核对时应为估算');
      assert(closes.items[0].snapshot && closes.items[0].snapshot.payloadHash, '应附快照哈希');
      assert((closes.items[0].blockers || []).length >= 1, '应记录阻塞码清单');
    });

    // C8 收尾：清空必须走通（历史上 DELETE 因缺少 Content-Type 被服务端判为非法写请求）
    await check('清空账本经本地服务生效', async function () {
      await Store.clearAll();
      var state = await apiState();
      equal((state.txns || []).length, 0, '清空后交易应为 0');
      equal((state.accounts || []).length, 0, '清空后账户应为 0');
      equal((state.assets.assetUnits || []).length, 0, '清空后余额单元应为 0');
      // 清空属于高风险操作：服务端应先留一份 pre-clear 备份
      var backups = await Store.listBackups();
      assert((backups.items || []).some(function (b) { return /-pre-clear\.db$/.test(b.name); }),
        '清空前应留一份 pre-clear 备份');
    });

    // C10 S2 保存失败回滚与只读降级：模拟本地服务中途停止后记账。
    // 修复前：同时出现"已记一笔"和"保存失败"，未落盘交易挂在明细里，刷新后凭空消失，也不进入只读模式。
    await check('服务中断时记账：不报已入账、回滚界面、进入只读降级', async function () {
      var origFetch = window.fetch;
      // 所有 /api/ 请求在网络层失败 = 本地服务进程已停止
      window.fetch = function (url, init) {
        if (String(url).indexOf('/api/') === 0) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return origFetch(url, init);
      };
      try {
        clickAction('[data-action="nav:add"]');
        await waitFor(function () { return document.querySelector('#view .keypad'); }, 5000, '记一笔页面');
        // 输入金额 12 并保存（账户默认选中第一个有效账户）
        clickAction('[data-action="add:key"][data-key="1"]');
        clickAction('[data-action="add:key"][data-key="2"]');
        clickAction('[data-action="add:save"]');

        await waitFor(function () {
          return document.querySelector('#toast').textContent.indexOf('只读模式') >= 0;
        }, 5000, '只读降级提示');
        assert(document.querySelector('#toast').textContent.indexOf('已记一笔') < 0,
          '保存失败时不得提示已入账');
        var banner = document.querySelector('#service-banner');
        assert(banner && banner.className.indexOf('warn') >= 0 && banner.className.indexOf('hidden') < 0,
          '应显示只读降级横幅，实际 class=' + (banner && banner.className));

        // 乐观更新必须被回滚：明细页不应出现这笔未落盘的交易
        clickAction('[data-action="nav:list"]');
        await waitFor(function () {
          return document.querySelector('#view .txn-list') || document.querySelector('#view .empty');
        }, 5000, '明细页');
        assert(document.querySelector('#view').textContent.indexOf('12.00') < 0,
          '未落盘的交易不得留在界面上');
      } finally {
        window.fetch = origFetch;
        Store.resetDetection();
      }
      // 恢复网络后重新探测：应回到 api 模式（刷新页面即可恢复记账）
      var mode = await Store.detect(true);
      equal(mode, 'api', '服务恢复后应重新探测为 api 模式');
    });

    render();
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
