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
    await check('资产录入页可维护双币种并记录不计收支的换汇，且不被全量写回抹掉', async function () {
      // C9 的恢复把资产清掉了：决策台应显示空状态与「录入资产」入口
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view .dash-empty'); }, 8000, '决策台空状态');
      assert(document.querySelector('#view [data-action="nav:assets"]'), '空状态应提供资产录入入口');
      clickAction('[data-action="nav:assets"]');
      await waitFor(function () { return document.querySelector('#view [data-action="asset:acc"]'); }, 5000, '新增账户入口');

      // 新增账户（安全储备池）
      clickAction('[data-action="asset:acc"]');
      await waitFor(function () { return document.querySelector('#aa-name'); }, 5000, '账户表单');
      document.querySelector('#aa-name').value = '布线汇丰多币种账户';
      document.querySelector('#aa-inst').value = '香港汇丰';
      document.querySelector('#aa-pool').value = 'safety';
      clickAction('[data-action="asset:saveAcc"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('布线汇丰多币种账户') >= 0;
      }, 5000, '账户出现在列表');

      // 同一个汇丰账户分别登记 HKD 与 USD 余额
      clickAction('[data-action="asset:unit"]');
      await waitFor(function () { return document.querySelector('#au-bal'); }, 5000, '余额表单');
      document.querySelector('#au-cur').value = 'HKD';
      document.querySelector('#au-bal').value = '3000';
      clickAction('[data-action="asset:saveUnit"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('3,000.00 HKD') >= 0;
      }, 5000, 'HKD 余额出现在列表');

      clickAction('[data-action="asset:unit"]');
      await waitFor(function () { return document.querySelector('#au-bal'); }, 5000, 'USD 余额表单');
      document.querySelector('#au-cur').value = 'USD';
      document.querySelector('#au-bal').value = '1000';
      clickAction('[data-action="asset:saveUnit"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('1,000.00 USD') >= 0;
      }, 5000, 'USD 余额出现在列表');

      // 记录 HKD→USD 换汇：资产转移单独落库，不新增任何收入/支出流水
      var beforeTransfer = await apiState();
      clickAction('[data-action="asset:transfer"]');
      await waitFor(function () { return document.querySelector('#at-from'); }, 5000, '换汇表单');
      var findUnitOption = function (select, currency) {
        return Array.prototype.slice.call(select.options).find(function (o) { return o.textContent.indexOf(currency) >= 0; });
      };
      document.querySelector('#at-from').value = findUnitOption(document.querySelector('#at-from'), 'HKD').value;
      document.querySelector('#at-to').value = findUnitOption(document.querySelector('#at-to'), 'USD').value;
      document.querySelector('#at-from-amount').value = '780';
      document.querySelector('#at-to-amount').value = '100';
      document.querySelector('#at-note').value = '虚构换汇';
      clickAction('[data-action="asset:saveTransfer"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('HKD → USD') >= 0;
      }, 5000, '换汇记录出现在列表');

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
      assert((st.assets.assetAccounts || []).some(function (a) { return a.name === '布线汇丰多币种账户' && a.pool === 'safety'; }),
        '账户应落库');
      var hkdUnit = (st.assets.assetUnits || []).filter(function (u) { return u.currency === 'HKD' && u.balanceMinor === 300000; });
      var usdUnit = (st.assets.assetUnits || []).filter(function (u) { return u.currency === 'USD' && u.balanceMinor === 100000; });
      assert(hkdUnit.length === 1 && usdUnit.length === 1, 'HKD 与 USD 余额应分别以最小货币单位落库');
      var xfer = (st.assets.assetTransfers || [])[0];
      assert(xfer && xfer.fromCurrency === 'HKD' && xfer.toCurrency === 'USD' &&
        xfer.fromAmountMinor === 78000 && xfer.toAmountMinor === 10000, '换汇两端金额与币种应独立落库');
      equal(st.txns.length, beforeTransfer.txns.length, '换汇不应新增现金流交易');
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
      assert((st2.assets.assetAccounts || []).some(function (a) { return a.name === '布线汇丰多币种账户'; }),
        '全量写回后账户必须仍在（writeState 先清后写不可丢资源数据）');
      assert((st2.assets.assetUnits || []).some(function (u) { return u.balanceMinor === 300000; }),
        '全量写回后余额必须仍在');
      assert((st2.assets.assetTransfers || []).some(function (t) { return t.id === xfer.id; }),
        '全量写回后换汇记录必须仍在');
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

    // S3.2 福利预设布线：四类分流都必须能从产品路径建出来（不靠备份 fixture）
    await check('福利预设四类分流：明确余额计一次、无余额资格不计入、社保卡独立', async function () {
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:assets"]'); }, 5000, '决策台资产入口');
      clickAction('[data-action="nav:assets"]');
      await waitFor(function () { return document.querySelector('#view [data-action="asset:preset"][data-id="pf"]'); }, 5000, '福利预设入口');

      // 1) 公积金明确余额 → 受限资产账户 + CNY 余额
      clickAction('[data-action="asset:preset"][data-id="pf"]');
      await waitFor(function () { return document.querySelector('#ap-bal'); }, 5000, '公积金预设表单');
      document.querySelector('#ap-bal').value = '8000';
      document.querySelector('#ap-src').value = '青岛公积金 App';
      clickAction('[data-action="asset:savePreset"]');
      await waitFor(function () { return document.querySelector('#view').textContent.indexOf('青岛住房公积金') >= 0; }, 6000, '公积金账户出现在列表');

      // 2) 医保个人账户余额 → 受限资产
      clickAction('[data-action="asset:preset"][data-id="mi"]');
      await waitFor(function () { return document.querySelector('#ap-bal'); }, 5000, '医保预设表单');
      document.querySelector('#ap-bal').value = '1200';
      document.querySelector('#ap-src').value = '青岛医保 App';
      clickAction('[data-action="asset:savePreset"]');
      await waitFor(function () { return document.querySelector('#view').textContent.indexOf('医保个人账户') >= 0; }, 6000, '医保账户出现在列表');

      // 3) 社保卡金融账户 → 普通储蓄卡，独立计入资产
      clickAction('[data-action="asset:preset"][data-id="card"]');
      await waitFor(function () { return document.querySelector('#ap-bal'); }, 5000, '社保卡预设表单');
      document.querySelector('#ap-bal').value = '500';
      clickAction('[data-action="asset:savePreset"]');
      await waitFor(function () { return document.querySelector('#view').textContent.indexOf('社保卡金融账户') >= 0; }, 6000, '社保卡账户出现在列表');

      // 4) 养老等无余额资格 → 权益，不写金额
      clickAction('[data-action="asset:preset"][data-id="ent"]');
      await waitFor(function () { return document.querySelector('#ap-status'); }, 5000, '参保状态表单');
      document.querySelector('#ap-name').value = '职工基本养老保险';
      document.querySelector('#ap-status').value = '在缴';
      document.querySelector('#ap-src').value = '青岛人社 App';
      clickAction('[data-action="asset:savePreset"]');
      await waitFor(function () { return document.querySelector('#view').textContent.indexOf('职工基本养老保险') >= 0; }, 6000, '权益出现在列表');

      // 落库校验：两个明确余额进入受限资产，社保卡独立，资格不计入
      var st = await apiState();
      var byName = {};
      (st.assets.assetAccounts || []).forEach(function (a) { byName[a.name] = a; });
      assert(byName['青岛住房公积金'] && byName['青岛住房公积金'].pool === 'restricted', '公积金应为受限资产账户');
      assert(byName['医保个人账户'] && byName['医保个人账户'].pool === 'restricted', '医保应为受限资产账户');
      assert(byName['社保卡金融账户'] && byName['社保卡金融账户'].pool === 'safety', '社保卡金融账户应独立为普通账户');

      var unitOf = function (accountId, cur) {
        return (st.assets.assetUnits || []).filter(function (u) {
          return u.accountId === accountId && u.currency === (cur || 'CNY');
        });
      };
      assert(unitOf(byName['青岛住房公积金'].id).length === 1, '公积金余额只计一次');
      assert(unitOf(byName['医保个人账户'].id).length === 1, '医保余额只计一次');
      var pension = (st.assets.entitlements || []).filter(function (e) { return e.name === '职工基本养老保险'; });
      equal(pension.length, 1, '养老资格应作为权益落库');
      equal(pension[0].balanceMinor, null, '无余额资格不得写成 0');
      equal(pension[0].jurisdiction, '青岛', '权益地区应落库');
      equal(pension[0].sourceRef, '青岛人社 App', '权益来源应落库');

      // 权益不计入资产：总资产必须等于三个账户余额之和（此时美元/港币仍有汇率缺口，故只比 CNY 部分）
      var ov = await fetch('/api/v1/overview').then(function (r) { return r.json(); });
      assert(ov.pools.restrictedMinor >= 920000, '公积金 + 医保应进入受限资产池');
    });

    // P0-A + P1-B + P0-B：上月核对 → 手动汇率 → 正式结账 → 历史金额下钻
    await check('上月核对日期 + 手动汇率可完成正式结账，历史金额可下钻到来源', async function () {
      // 结账对象 = 上一个完整自然月；其最后一天是「已核对」的判定基准
      var prevYmLastDay = (function () {
        var d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - 1);
        var y = d.getFullYear(), m = d.getMonth() + 1;
        var last = new Date(y, m, 0).getDate();
        return y + '-' + String(m).padStart(2, '0') + '-' + String(last).padStart(2, '0');
      })();

      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:assets"]'); }, 5000, '决策台资产入口');
      clickAction('[data-action="nav:assets"]');
      await waitFor(function () { return document.querySelector('#view [data-action="asset:fx"]'); }, 5000, '汇率入口');

      // P1-B 手动汇率：HKD→CNY、USD→CNY，汇率日取结账月末（超 5 天会被判过期而阻塞正式结账）
      var ratePairs = [['HKD', '0.9200'], ['USD', '7.2000']];
      for (var i = 0; i < ratePairs.length; i++) {
        clickAction('[data-action="asset:fx"]');
        await waitFor(function () { return document.querySelector('#fx-rate'); }, 5000, '汇率表单');
        document.querySelector('#fx-base').value = ratePairs[i][0];
        document.querySelector('#fx-quote').value = 'CNY';
        document.querySelector('#fx-rate').value = ratePairs[i][1];
        document.querySelector('#fx-date').value = prevYmLastDay;
        clickAction('[data-action="asset:saveFx"]');
        await waitFor(function () {
          return document.querySelector('#view').textContent.indexOf(ratePairs[i][0] + '→CNY') >= 0;
        }, 6000, ratePairs[i][0] + ' 汇率出现在列表');
      }

      // 把两个外币余额的核对日期改到结账月份内（否则 balance_stale 会永久阻塞正式结账）
      var st0 = await apiState();
      var hkdUnit = (st0.assets.assetUnits || []).filter(function (u) { return u.balanceMinor === 300000; })[0];
      var usdUnit = (st0.assets.assetUnits || []).filter(function (u) { return u.balanceMinor === 100000; })[0];
      assert(hkdUnit && usdUnit, '前提：S3.1 建立的 HKD/USD 余额仍在');
      var targets = [{ id: hkdUnit.accountId, cur: 'HKD', amount: '3000' }, { id: usdUnit.accountId, cur: 'USD', amount: '1000' }];
      for (var j = 0; j < targets.length; j++) {
        clickAction('[data-action="asset:unit"][data-id="' + targets[j].id + '"]');
        await waitFor(function () { return document.querySelector('#au-bal'); }, 5000, targets[j].cur + ' 余额表单');
        document.querySelector('#au-acc').value = targets[j].id;
        document.querySelector('#au-cur').value = targets[j].cur;
        document.querySelector('#au-bal').value = targets[j].amount;
        document.querySelector('#au-date').value = prevYmLastDay;
        clickAction('[data-action="asset:saveUnit"]');
        await waitFor(function () {
          return document.querySelector('#view').textContent.indexOf(prevYmLastDay) >= 0;
        }, 6000, targets[j].cur + ' 核对日期已更新');
      }

      // 汇率与核对日期齐备后，正式结账按钮必须可用
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:close"]'); }, 6000, '决策台结账入口');
      clickAction('[data-action="nav:close"]');
      await waitFor(function () { return document.querySelector('#view [data-action="close:save"]'); }, 6000, '结账页');
      var formalBtn = document.querySelector('#view [data-action="close:save"][data-status="formal"]');
      assert(formalBtn, '正式结账按钮应存在');
      assert(!formalBtn.disabled, '余额与负债都在结账月内核对且汇率齐备时，正式结账必须可用 · 清单=' +
        document.querySelector('#view').textContent.slice(0, 160));

      clickAction('[data-action="close:save"][data-status="formal"]');
      await waitFor(function () { return document.querySelector('#confirm-ok'); }, 5000, '正式结账确认弹层');
      clickAction('#confirm-ok');
      // 页面文案里始终有「保存为估算快照」按钮，不能用「估算」二字判断状态；
      // 直接以事实源状态为准，等它变成 formal（谓词是异步的，waitFor 会 await）
      await waitFor(async function () {
        var c = await fetch('/api/v1/monthly-closes').then(function (r) { return r.json(); });
        return (c.items || []).length === 1 && c.items[0].status === 'formal';
      }, 10000, '结账状态变为正式');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('正式') >= 0;
      }, 6000, '历史结账行显示正式');

      // HTTP 直读：同月记录被更新为正式，且只有一个结账对象
      var closes = await fetch('/api/v1/monthly-closes').then(function (r) { return r.json(); });
      equal((closes.items || []).length, 1, '同月重复结账不应产生第二条记录');
      equal(closes.items[0].status, 'formal', '记录状态应为正式');
      equal(closes.items[0].month, prevYmLastDay.slice(0, 7), '结账月份应为上一个完整自然月');

      // P1-B：总览不再有 fx_missing，外币按手动汇率折算成 CNY
      var ov = await fetch('/api/v1/overview?asOf=' + prevYmLastDay).then(function (r) { return r.json(); });
      assert(!(ov.blockers || []).some(function (b) { return b.code === 'fx_missing'; }), '登记汇率后不应再有 fx_missing');
      // 3000 HKD × 0.92 = 2760 CNY；1000 USD × 7.2 = 7200 CNY
      var units = (await apiState()).assets.assetUnits || [];
      var allCny = units.every(function (u) { return u.currency !== 'HKD' || u.balanceMinor === 300000; });
      assert(allCny, '外币余额不得被折算结果覆盖，原币金额必须保持独立');
      // 分：3000 HKD × 0.92 = 276000；1000 USD × 7.2 = 720000
      assert(ov.totalAssetsMinor >= 276000 + 720000, '总览应含外币折算金额（≥ 9960 元）· 实际 ' + ov.totalAssetsMinor);

      // P0-B 金额下钻：历史结账的「查看明细」必须能看到单元级事实
      clickAction('[data-action="close:detail"]');
      await waitFor(function () { return document.querySelector('#sheet').textContent.indexOf('结账明细') >= 0; }, 8000, '结账明细弹层');
      var sheetText = document.querySelector('#sheet').textContent;
      assert(sheetText.indexOf('布线汇丰多币种账户') >= 0, '明细应列出账户余额来源 · ' + sheetText.slice(0, 200));
      assert(sheetText.indexOf('布线信用卡') >= 0, '明细应列出负债来源');
      assert(sheetText.indexOf(prevYmLastDay) >= 0, '明细应显示各项核对日');
      assert(sheetText.indexOf('2,760.00') >= 0, 'HKD 余额应显示折算金额 2,760.00');
      assert(sheetText.indexOf('7,200.00') >= 0, 'USD 余额应显示折算金额 7,200.00');
      assert(sheetText.indexOf('应急覆盖') >= 0, '明细应说明应急覆盖的口径与依据');
      clickAction('[data-action="sheet:close"]');
    });

    // C11 Phase 4B（S4B.1）：标的检索 → 预分类 → 用户确认 → 再刷新不覆盖确认值。
    // 全程从真实产品入口走：资产录入页的「标的目录」区块，不直接调 API 造数据。
    // 状态判定一律走事实源（apiState），不用页面文案。
    await check('标的目录：检索加入 → 确认分类并锁定 → 刷新不覆盖已确认值', async function () {
      // 资产录入页不在底部 tabbar 里，须从决策台的入口卡片进入
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:assets"]'); }, 8000, '决策台资产入口');
      clickAction('#view [data-action="nav:assets"]');
      await waitFor(function () { return document.querySelector('#inst-q'); }, 8000, '标的目录区块');

      // 1) 检索：候选必须来自参考数据
      document.querySelector('#inst-q').value = 'voo';
      clickAction('[data-action="inst:search"]');
      await waitFor(function () { return document.querySelector('[data-action="inst:add"]'); }, 8000, '检索候选');
      equal(document.querySelector('[data-action="inst:add"]').dataset.symbol, 'VOO', '候选应是 VOO');

      // 2) 加入目录：落成「待确认」，分类留空等用户填（不得自动确认）
      clickAction('[data-action="inst:add"]');
      await waitFor(async function () {
        var st = await apiState();
        return (st.assets.instruments || []).some(function (r) { return r.symbol === 'VOO'; });
      }, 8000, '标的写入事实源');

      var added = (await apiState()).assets.instruments.filter(function (r) { return r.symbol === 'VOO'; });
      equal(added.length, 1, '目录里应恰好有一条 VOO');
      equal(added[0].classificationStatus, 'suggested', '加入目录后必须是待确认，不得自动确认');
      equal(added[0].assetClass, undefined, 'assetClass 不由参考数据生成，必须等用户填');
      equal(added[0].exposureMarket, undefined, 'exposureMarket 不由参考数据生成，必须等用户填');
      assert(added[0].providerProvenance && added[0].providerProvenance.payloadHash,
        '必须留下参考数据来源留档（provenance）');
      var instId = added[0].id;

      // 3) 确认分类：资产类别与敞口市场都是用户判断，两项都要提交
      clickAction('[data-action="inst:confirm"]');
      await waitFor(function () { return document.querySelector('#ic-class'); }, 5000, '确认弹层');
      document.querySelector('#ic-class').value = 'broad_equity';
      document.querySelector('#ic-exp').value = 'US';
      document.querySelector('#ic-index').value = 'S&P 500';
      clickAction('[data-action="inst:saveConfirm"]');
      await waitFor(async function () {
        var st = await apiState();
        var r = (st.assets.instruments || []).filter(function (x) { return x.id === instId; })[0];
        return !!r && r.classificationStatus === 'confirmed';
      }, 8000, '确认写入事实源');

      var confirmed = (await apiState()).assets.instruments.filter(function (r) { return r.id === instId; })[0];
      equal(confirmed.assetClass, 'broad_equity', '用户填写的资产类别必须落库');
      equal(confirmed.exposureMarket, 'US', '用户填写的敞口市场必须落库');
      equal(confirmed.trackingIndex, 'S&P 500', '跟踪指数必须落库');

      // 4) 按参考数据刷新：确认分类与用户填写的值一律不被覆盖（S4B.1 核心不变量）
      var refreshPosted = 0;
      var origFetch = window.fetch;
      window.fetch = function (url, init) {
        var p = origFetch.apply(window, arguments);
        if (init && init.method === 'POST' && String(url).indexOf('/api/v1/instruments') === 0) {
          return p.then(function (r) { refreshPosted += 1; return r; });
        }
        return p;
      };
      try {
        clickAction('[data-action="inst:refresh"]');
        await waitFor(function () { return refreshPosted > 0; }, 8000, '刷新请求完成');
      } finally {
        window.fetch = origFetch;
      }

      var kept = (await apiState()).assets.instruments.filter(function (r) { return r.symbol === 'VOO'; });
      equal(kept.length, 1, '刷新不得多出第二行事实');
      equal(kept[0].id, instId, '刷新必须命中既有标的');
      equal(kept[0].classificationStatus, 'confirmed', '刷新不得把状态退回 suggested');
      equal(kept[0].assetClass, 'broad_equity', '刷新不得覆盖用户确认的资产类别');
      equal(kept[0].exposureMarket, 'US', '刷新不得覆盖用户确认的敞口市场');
      equal(kept[0].trackingIndex, 'S&P 500', '刷新不得覆盖用户填写的跟踪指数');
    });

    // 第二轮复核 G4B-7：本地缺交易所的标的 + 参考数据有交易所 → 界面上只能有一条候选
    await check('标的目录：缺交易所的本地标的与参考数据合成一条候选（不重复展示）', async function () {
      // 上一项结束时可能仍停在资产录入页（也可能已回到决策台），两种入口都要能进目录区块
      if (!document.querySelector('#inst-q')) {
        clickAction('#view [data-action="nav:assets"]');
      }
      await waitFor(function () { return document.querySelector('#inst-q'); }, 8000, '标的目录区块');

      // 手工建立一个没有交易所的标的（用户手上只有代码）
      clickAction('[data-action="inst:manual"]');
      await waitFor(function () { return document.querySelector('#im-symbol'); }, 5000, '手工建立弹层');
      document.querySelector('#im-symbol').value = '2800.HK';
      document.querySelector('#im-currency').value = 'HKD';
      document.querySelector('#im-exchange').value = '';
      clickAction('[data-action="inst:saveManual"]');
      await waitFor(async function () {
        var st = await apiState();
        return (st.assets.instruments || []).some(function (r) { return r.symbol === '2800.HK'; });
      }, 8000, '手工标的写入事实源');

      var manual = (await apiState()).assets.instruments.filter(function (r) { return r.symbol === '2800.HK'; });
      equal(manual.length, 1, '手工建立后目录里应恰好一条 2800.HK');
      equal(manual[0].exchange, undefined, '未填交易所时不得凭空补一个');
      var manualId = manual[0].id;

      // 检索：参考数据有 2800.HK@HKEX，本地是 2800.HK@（缺交易所）→ 必须合成一条候选
      document.querySelector('#inst-q').value = '2800';
      clickAction('[data-action="inst:search"]');
      await waitFor(function () { return document.querySelector('#inst-q'); }, 5000, '检索完成');
      await waitFor(function () {
        var card = document.querySelector('#inst-q').closest('.card');
        return card && card.querySelectorAll('.acc-card').length > 0;
      }, 8000, '候选渲染');

      var searchCard = document.querySelector('#inst-q').closest('.card');
      var cards = searchCard.querySelectorAll('.acc-card');
      equal(cards.length, 1, '同一标的只能有一条候选（本地 2800.HK@ 与参考数据 2800.HK@HKEX 不得各占一条）');
      // 已被本地认领的候选不再提供"加入目录"按钮（重复加入的入口必须消失）
      equal(cards[0].querySelectorAll('[data-action="inst:add"]').length, 0,
        '本地已有的候选不得再显示"加入目录"');

      // 事实源不变：本地记录仍是缺交易所那一条，检索只读、不得补写交易所
      var after = (await apiState()).assets.instruments.filter(function (r) { return r.symbol === '2800.HK'; });
      equal(after.length, 1, '检索不得新增第二行事实');
      equal(after[0].id, manualId, '检索不得改动本地标的身份');
      equal(after[0].exchange, undefined, '检索是只读的：不得把参考数据的交易所写进本地事实');
    });

    // Phase 4C 持仓账本：期初快照 → 买入 → 卖出 → 持有数量由服务端推导；
    // 事件不进入现金流；全量写回（记账路径）不得抹掉事件（writeState 先清后写的反证）。
    await check('持仓与证券事件：期初+买入−卖出推导持有数量，事件不被全量写回抹掉', async function () {
      // 进入资产录入页（不在 tabbar 里，从决策台入口进）
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:assets"]'); }, 8000, '决策台资产入口');
      clickAction('#view [data-action="nav:assets"]');
      await waitFor(function () { return document.querySelector('#inst-q'); }, 8000, '标的目录区块');

      var st0 = await apiState();
      var voo = (st0.assets.instruments || []).filter(function (r) { return r.symbol === 'VOO'; })[0];
      assert(voo && voo.classificationStatus === 'confirmed', '前置：VOO 应已确认（4B 场景产物）');
      var txnsBefore = (st0.txns || []).length;

      // 持仓只能关联证券账户（D-043）：创建独立券商账户，不能复用前一场景的银行账户。
      clickAction('[data-action="asset:acc"]');
      await waitFor(function () { return document.querySelector('#aa-name'); }, 5000, '券商账户表单');
      document.querySelector('#aa-name').value = '布线测试券商';
      document.querySelector('#aa-kind').value = 'broker';
      document.querySelector('#aa-pool').value = 'investable';
      clickAction('[data-action="asset:saveAcc"]');
      await waitFor(async function () {
        var st = await apiState();
        return (st.assets.assetAccounts || []).some(function (a) { return a.kind === 'broker'; });
      }, 8000, '券商账户写入事实源');
      st0 = await apiState();
      var acc = (st0.assets.assetAccounts || []).filter(function (a) { return a.kind === 'broker'; })[0];
      assert(acc, '前置：应已有证券账户');

      // 1) 期初快照：VOO × 10
      clickAction('[data-action="holding:opening"]');
      await waitFor(function () { return document.querySelector('#ho-qty'); }, 5000, '期初弹层');
      var openingAccountOptions = Array.prototype.slice.call(document.querySelectorAll('#ho-acc option'));
      equal(openingAccountOptions.length, (st0.assets.assetAccounts || []).filter(function (a) { return a.kind === 'broker'; }).length,
        '期初弹层只能列出证券账户');
      var nonBrokerIds = (st0.assets.assetAccounts || []).filter(function (a) { return a.kind !== 'broker'; }).map(function (a) { return a.id; });
      assert(openingAccountOptions.every(function (o) { return nonBrokerIds.indexOf(o.value) < 0; }),
        '普通银行账户不得出现在期初选择器');
      document.querySelector('#ho-acc').value = acc.id;
      document.querySelector('#ho-inst').value = voo.id;
      document.querySelector('#ho-qty').value = '10';
      document.querySelector('#ho-cost').value = '4500.00';
      clickAction('[data-action="holding:saveOpening"]');
      await waitFor(async function () {
        var st = await apiState();
        return (st.assets.holdings || []).some(function (h) { return h.quantity === '10'; });
      }, 8000, '期初写入事实源');

      // 2) 事件：买入 2
      clickAction('[data-action="holding:event"]');
      await waitFor(function () { return document.querySelector('#he-type'); }, 5000, '事件弹层');
      equal(document.querySelectorAll('#he-acc option').length,
        (st0.assets.assetAccounts || []).filter(function (a) { return a.kind === 'broker'; }).length,
        '事件弹层只能列出证券账户');
      document.querySelector('#he-type').value = 'buy';
      document.querySelector('#he-acc').value = acc.id;
      document.querySelector('#he-inst').value = voo.id;
      document.querySelector('#he-qty').value = '2';
      document.querySelector('#he-price').value = '500.00';
      clickAction('[data-action="holding:saveEvent"]');
      await waitFor(async function () {
        var st = await apiState();
        return (st.assets.securityEvents || []).length === 1;
      }, 8000, '买入事件写入事实源');

      // 3) 事件：卖出 1（重复提交同 id 会被拒；这里走页面每次都是新事件）
      clickAction('[data-action="holding:event"]');
      await waitFor(function () { return document.querySelector('#he-type'); }, 5000, '事件弹层再次打开');
      document.querySelector('#he-type').value = 'sell';
      document.querySelector('#he-acc').value = acc.id;
      document.querySelector('#he-inst').value = voo.id;
      document.querySelector('#he-qty').value = '1';
      clickAction('[data-action="holding:saveEvent"]');
      await waitFor(async function () {
        var st = await apiState();
        return (st.assets.securityEvents || []).length === 2;
      }, 8000, '卖出事件写入事实源');

      // 4) 事实源核对：GET /holdings 推导 10 + 2 − 1 = 11；事件不进现金流
      var holdings = await fetch('/api/v1/holdings').then(function (r) { return r.json(); });
      var vooHolding = holdings.items.filter(function (h) { return h.instrumentId === voo.id; })[0];
      assert(vooHolding, '持仓视图应有 VOO 一行');
      equal(vooHolding.quantity, '11', '持有数量必须是推导值 11');
      equal(vooHolding.eventCounts.buy, 1, '买入事件计数');
      equal(vooHolding.eventCounts.sell, 1, '卖出事件计数');
      var st = await apiState();
      equal((st.txns || []).length, txnsBefore, '证券事件不得新增现金流交易');

      // 5) 界面核对：持仓区块展示推导数量，事件流水两条（用事实源 id 定位，不数文案）
      assert(document.querySelector('[data-holding="' + acc.id + ':' + voo.id + '"]'),
        '持仓区块应渲染 VOO 持仓卡片');
      var eventCards = [];
      document.querySelectorAll('[data-event-id]').forEach(function (el) { eventCards.push(el.dataset.eventId); });
      equal(eventCards.length, 2, '事件流水应渲染两条');

      // 6) 关键反证：全量写回（记账路径）不得抹掉事件与期初
      var raw = await Store.loadRaw();
      await Store.saveAll({
        accounts: raw.accounts, categories: raw.categories,
        txns: raw.txns, settings: raw.settings, assets: raw.assets
      });
      var st2 = await apiState();
      equal((st2.assets.securityEvents || []).length, 2, '全量写回后事件必须仍在');
      equal((st2.assets.holdings || []).length, 1, '全量写回后期初快照必须仍在');
      var holdings2 = await fetch('/api/v1/holdings').then(function (r) { return r.json(); });
      equal(holdings2.items.filter(function (h) { return h.instrumentId === voo.id; })[0].quantity, '11',
        '全量写回后推导数量必须仍是 11');
    });

    // C12 Phase 4D：行情区块（手动补价兜底）+ 启动时自动更新汇率开关 + 刷新报告渲染。
    // 真实取数路径（provider / 契约校验 / 写库）由 node 测试用注入的固定 fixture 覆盖；
    // 这里的三项只验证「界面布线 + 事实源口径」，且除最后一项之外不替换任何网络行为。
    await check('行情区块：默认不自动抓取；手动补价写入事实源并渲染价格与来源', async function () {
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:assets"]'); }, 8000, '决策台资产入口');
      clickAction('#view [data-action="nav:assets"]');
      await waitFor(function () { return document.querySelector('[data-action="market:toggleAuto"]'); }, 8000, '行情区块');

      // 默认关闭：D-038 门禁未通过，界面必须直说而不是假装已开启
      equal(document.querySelector('[data-action="market:toggleAuto"]').textContent.trim(), '开启',
        '自动行情/汇率更新的默认状态必须是关闭');
      assert(document.querySelector('#view').textContent.indexOf('默认关闭') >= 0,
        '行情区块应说明自动抓取默认关闭');

      var st0 = await apiState();
      var voo = (st0.assets.instruments || []).filter(function (r) { return r.symbol === 'VOO'; })[0];
      assert(voo, '前置：VOO 标的应存在（4B/4C 场景产物）');
      var card = document.querySelector('[data-quote="' + voo.id + '"]');
      assert(card, '有持仓事实的标的应出现在行情区块');
      assert(card.textContent.indexOf('尚未登记任何报价') >= 0,
        '没有任何报价时不得用 0 冒充价格');

      // 手动补价：唯一可用的兜底入口
      clickAction('[data-quote="' + voo.id + '"] [data-action="asset:quote"]');
      await waitFor(function () { return document.querySelector('#q-price'); }, 5000, '手动补价弹层');
      document.querySelector('#q-inst').value = voo.id;
      document.querySelector('#q-price').value = '498.00';
      document.querySelector('#q-date').value = '2026-09-14';
      clickAction('[data-action="asset:saveQuote"]');
      await waitFor(async function () {
        var st = await apiState();
        return (st.assets.quotes || []).length === 1;
      }, 8000, '报价写入事实源');

      var st = await apiState();
      var quote = st.assets.quotes[0];
      equal(quote.instrumentId, voo.id, '报价必须绑定该标的');
      equal(quote.priceMinor, 49800, '金额按最小货币单位整数存储');
      equal(quote.priceDate, '2026-09-14', '价格日必须保留');
      equal(quote.provider, 'manual', '手动补价的来源标记必须是 manual');
      equal(quote.currency, 'USD', '报价币种由标的推导，不由调用方声明');

      // 界面核对：价格、价格日、来源都要显示出来
      var after = document.querySelector('[data-quote="' + voo.id + '"]');
      assert(after.textContent.indexOf('2026-09-14') >= 0, '行情卡片应显示价格日');
      assert(after.textContent.indexOf('manual') >= 0, '行情卡片应标注来源');

      // 事实源直读：页面写的就是服务端存的（S2.1 单一事实源）
      var rows = await fetch('/api/v1/quotes').then(function (r) { return r.json(); });
      equal(rows.items.length, 1, 'GET /quotes 应有一行');
      equal(rows.items[0].priceMinor, 49800, '服务端存的就是页面提交的金额');
      equal(rows.items[0].provider, 'manual', '服务端记录的来源必须是 manual');
    });

    await check('启动时自动更新汇率开关：默认关闭，切换可写入 settings 并回读', async function () {
      var st0 = await apiState();
      assert(!(st0.settings && st0.settings.marketDataAutoRefresh === true),
        '默认不得开启启动时自动更新（D-007 的失败兜底以手动为主）');

      clickAction('[data-action="market:toggleAuto"]');
      await waitFor(async function () {
        var st = await apiState();
        return !!(st.settings && st.settings.marketDataAutoRefresh === true);
      }, 8000, '开关开启写入事实源');
      assert(document.querySelector('#view').textContent.indexOf('已开启') >= 0,
        '开启后界面应显示已开启');

      clickAction('[data-action="market:toggleAuto"]');
      await waitFor(async function () {
        var st = await apiState();
        return !(st.settings && st.settings.marketDataAutoRefresh === true);
      }, 8000, '开关关闭写入事实源');
      assert(document.querySelector('#view').textContent.indexOf('已关闭（默认）') >= 0,
        '关闭后界面应恢复显示已关闭');
    });

    await check('刷新报告的界面渲染：逐作用域状态如实提示，且不改动已登记的手动价格', async function () {
      // 只替换刷新接口：返回一份固定报告（汇率成功 + 行情因门禁未更新），
      // 其余 /api 请求照常走真实服务 —— 因此本项不断言"取数成功"，只断言界面与库不被篡改。
      var origFetch = window.fetch;
      var canned = {
        ok: true, asOf: '2026-09-17', now: '2026-09-17T09:00:00Z',
        scopeOrder: ['fx', 'quotes'],
        scopes: [
          { scope: 'fx', status: 'updated', updated: 1, skipped: [], errors: [], attempts: 1, reason: null, items: [] },
          { scope: 'quotes', status: 'skipped', updated: 0, skipped: [], errors: [], attempts: 0,
            reason: 'auto_fetch_disabled', items: [] }
        ]
      };
      window.fetch = function (url, init) {
        if (String(url).indexOf('/api/v1/market-data/refresh') >= 0) {
          return Promise.resolve({
            ok: true, status: 200,
            json: function () { return Promise.resolve(canned); }
          });
        }
        return origFetch(url, init);
      };
      try {
        var before = await fetch('/api/v1/quotes').then(function (r) { return r.json(); });
        equal(before.items.length, 1, '前置：应已有 1 条手动价格');

        clickAction('[data-action="market:refresh"]');
        await waitFor(function () {
          return document.querySelector('#toast').textContent.indexOf('行情未更新') >= 0;
        }, 5000, '刷新提示');
        var toast = document.querySelector('#toast').textContent;
        assert(toast.indexOf('汇率更新 1 项') >= 0, '成功的汇率作用域应如实报数量，实际：' + toast);
        assert(toast.indexOf('auto_fetch_disabled') >= 0,
          '门禁未通过应把原因显示出来，而不是笼统报错，实际：' + toast);

        // 行情刷新不得动到用户手动确认过的价格
        var after = await fetch('/api/v1/quotes').then(function (r) { return r.json(); });
        equal(after.items.length, 1, '刷新后手动报价行数不变');
        equal(after.items[0].priceMinor, 49800, '刷新后手动报价金额不变');
        equal(after.items[0].provider, 'manual', '刷新后来源仍是 manual');
      } finally {
        window.fetch = origFetch;
      }
    });

    // C13 Phase 4E：估值下钻与收益归因。
    // 断言只读**结构化定位属性**（data-drilldown / data-consistency / data-positions-detail /
    // data-attr-totals / data-attr-row），并与 GET /api/v1/overview 交叉核对，
    // 不解析「按机构 / 按币种」这些区块里的格式化文案。
    await check('估值下钻：四维度合计与总览自洽，逐持仓可追溯到价格与汇率来源', async function () {
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-drilldown="1"]'); }, 8000, '估值下钻卡片');

      // 「下钻合计 == 总览」由领域层在同一遍估值里给结论（构造性一致），页面只负责如实呈现
      var cons = document.querySelector('#view [data-consistency]');
      assert(cons, '下钻卡片必须自报一致性结论');
      equal(cons.getAttribute('data-consistency'), 'ok', '四个维度合计必须与总览一致：' + cons.textContent);

      // 与事实源交叉核对：页面上的总额必须等于服务端按同一数据日算出的总览（S2.1）
      var card = document.querySelector('#view [data-drilldown="1"]');
      var ov = await fetch('/api/v1/overview').then(function (r) { return r.json(); });
      equal(Number(card.getAttribute('data-total-assets')), ov.totalAssetsMinor,
        '页面总资产必须等于 GET /overview 的总资产');
      equal(Number(card.getAttribute('data-net-worth')), ov.netWorthMinor,
        '页面净资产必须等于 GET /overview 的净资产');
      equal(Number(card.getAttribute('data-investable')), ov.pools.investableMinor,
        '页面投资池合计必须等于 GET /overview 的投资池');
      // 四个维度的覆盖范围不同，各自对上自己的分母（全部资产 / 投资池 / 投资池持仓）
      equal(Number(card.getAttribute('data-sum-by-account')), ov.totalAssetsMinor, '按机构合计必须等于总资产');
      equal(Number(card.getAttribute('data-sum-by-currency')), ov.totalAssetsMinor, '按币种合计必须等于总资产');
      equal(Number(card.getAttribute('data-sum-by-asset-class')), ov.pools.investableMinor,
        '按资产类别合计必须等于投资池');
      assert(Number(card.getAttribute('data-sum-by-market')) <= ov.pools.investableMinor,
        '按敞口市场合计（只含持仓）不得超过投资池');

      // 逐持仓追溯：每一行都要能回答「这条估值用的是哪天的价格 / 哪个来源 / 哪天的汇率」
      var st = await apiState();
      var voo = (st.assets.instruments || []).filter(function (r) { return r.symbol === 'VOO'; })[0];
      assert(voo, '前置：VOO 标的应存在（4B/4C 场景产物）');
      var posCount = Number(card.getAttribute('data-positions'));
      assert(posCount >= 1, '本场景已有持仓事实，逐持仓追溯不应为空');
      var detail = document.querySelector('#view [data-positions-detail]');
      assert(detail, '下钻必须提供逐持仓追溯入口');
      equal(Number(detail.getAttribute('data-positions-detail')), posCount, '追溯入口的行数必须与持仓数一致');
      assert(detail.textContent.indexOf('2026-09-14') >= 0, '追溯表必须写明这条估值用的价格日');
      assert(detail.textContent.indexOf('manual') >= 0, '追溯表必须写明价格来源');

      // 追溯表显示的价格日/来源必须就是事实源里那一行（不新建任何估值输入）
      var quotes = await fetch('/api/v1/quotes').then(function (r) { return r.json(); });
      var vooQuote = quotes.items.filter(function (x) { return x.instrumentId === voo.id; })[0];
      assert(vooQuote, '前置：VOO 应有一条手动报价（4D 场景产物）');
      equal(vooQuote.priceDate, '2026-09-14', '追溯表显示的价格日必须与事实源一致');
      equal(vooQuote.provider, 'manual', '追溯表显示的价格来源必须与事实源一致');
    });

    await check('收益归因：基准取自已结账月快照，价格+汇率+未分解恒等于估值变化', async function () {
      // 前置：至少要两个已结账月，基准选择器才有可比对象。
      // 注意：本仓库的「全量写入」是**先清后写**（clearState 会把 monthly_closes / close_snapshots
      // 一并清掉），前面的持仓场景做过全量写回 —— 所以这里不能假设结账记录还在，缺什么就补什么。
      // 补造走的是与界面同一个结账接口；核对项不足的月份只会存成**估算**，不会伪造正式口径。
      var cur = new Date();
      var curYm = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
      var ymBack = function (n) {
        var t = new Date(cur.getFullYear(), cur.getMonth() - n, 1);
        return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
      };
      var prevYm = ymBack(1), prev2Ym = ymBack(2);

      var ensureClose = async function (month) {
        var list = await fetch('/api/v1/monthly-closes').then(function (r) { return r.json(); });
        if (list.items.some(function (c) { return String(c.month) === month; })) return null;
        var r = await fetch('/api/v1/monthly-closes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-ledger-token': Store.readSessionToken() },
          body: JSON.stringify({ month: month })
        });
        assert(r.ok, '补造结账月 ' + month + ' 应成功，实际 ' + r.status);
        var b = await r.json();
        assert(b.ok && b.close && b.close.month === month, '补造的结账月必须落库');
        assert(b.close.dataCutoff === month + '-31' || /^\d{4}-\d{2}-\d{2}$/.test(b.close.dataCutoff),
          '结账数据截止日必须是该月最后一天');
        return b;
      };
      // 更早的那个月余额未核对过 → 必须是估算，不能是 formal
      var older2 = await ensureClose(prev2Ym);
      if (older2) {
        equal(older2.close.status, 'estimate', '该月没有余额核对记录，只能存成估算');
      }
      await ensureClose(prevYm);

      var closes = await fetch('/api/v1/monthly-closes').then(function (r) { return r.json(); });
      assert(closes.items.length >= 2, '前置：应有两个已结账月可供选择');
      // 仓库按 month DESC 返回 → filter 后第 0 个就是「早于本月的最近一个」
      var expected = closes.items.filter(function (c) { return String(c.month) < curYm; })[0];
      assert(expected && expected.month === prevYm, '前置：最近一个已结账月应在上个月');
      var other = closes.items.filter(function (c) {
        return c.id !== expected.id && String(c.month) < curYm;
      })[0];
      assert(other && other.snapshot, '前置：应还有另一个更早的、带快照的结账月');

      // 决策台缓存了上一版的结账列表：先经 nav:close 强制刷新，再回决策台看归因。
      // G4E-1 后归因卡要异步读取基准快照的封存明细，因此直接等「合计 + 正确基准」出现。
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:close"]'); }, 8000, '决策台结账入口');
      clickAction('#view [data-action="nav:close"]');
      clickAction('[data-action="nav:home"]');
      await waitFor(function () {
        var t2 = document.querySelector('#view [data-attr-totals]');
        return t2 && t2.getAttribute('data-baseline-id') === expected.id;
      }, 8000, '归因合计（基准 = 上月快照，封存明细已就绪）');

      var totals = document.querySelector('#view [data-attr-totals]');
      assert(totals, '归因卡片必须给出合计');
      equal(totals.getAttribute('data-baseline-hash'), expected.snapshot.payloadHash,
        '归因必须挂到该基准的快照哈希上（事后可追溯）');

      // 恒等式：价格影响 + 汇率影响 + 未分解 = 估值变化（整数最小货币单位，全程无浮点）
      var rows = document.querySelectorAll('#view [data-attr-row]');
      equal(rows.length, Number(totals.getAttribute('data-count')), '合计里的行数必须等于行明细条数');
      var sumPrice = 0, sumAttributable = 0, sumBoundary = 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.getAttribute('data-attributable') === '1') {
          sumAttributable += 1;
          var pe = Number(r.getAttribute('data-price'));
          var fe = Number(r.getAttribute('data-fx'));
          equal(pe + fe, Number(r.getAttribute('data-change')),
            '可分解行的「价格影响 + 汇率影响」必须等于估值变化');
          equal(r.getAttribute('data-boundaries'), '', '可分解行不应带任何边界');
          sumPrice += pe;
        } else {
          sumBoundary += 1;
          assert(r.getAttribute('data-boundaries').length > 0, '不可分解行必须写明卡在哪条边界上');
          equal(r.getAttribute('data-price'), '', '不可分解行不得给出价格影响（不许插值凑数）');
          equal(r.getAttribute('data-fx'), '', '不可分解行不得给出汇率影响（不许插值凑数）');
        }
      }
      equal(sumAttributable, Number(totals.getAttribute('data-attributable-count')), '可分解行数必须与合计一致');
      equal(sumBoundary, Number(totals.getAttribute('data-boundary-count')), '有边界的行数必须与合计一致');
      equal(sumPrice, Number(totals.getAttribute('data-price')), '合计的证券价格影响必须等于逐行相加');

      var tChange = Number(totals.getAttribute('data-change'));
      equal(Number(totals.getAttribute('data-price')) + Number(totals.getAttribute('data-fx')) +
        Number(totals.getAttribute('data-unattributed')), tChange,
        '合计必须满足：价格影响 + 汇率影响 + 未分解 = 估值变化');
      equal(Number(totals.getAttribute('data-end')) - Number(totals.getAttribute('data-start')), tChange,
        '估值变化必须等于期末估值 − 期初估值');

      // 切换期初基准：换成更早那个已结账月后，卡片必须按新基准重算，而不是继续显示旧基准
      var sel = document.querySelector('#view #attr-baseline');
      assert(sel, '归因卡片必须提供期初基准选择器');
      sel.value = other.id;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(function () {
        var t2 = document.querySelector('#view [data-attr-totals]');
        return t2 && t2.getAttribute('data-baseline-id') === other.id;
      }, 5000, '切换期初基准生效');
      var t3 = document.querySelector('#view [data-attr-totals]');
      equal(t3.getAttribute('data-baseline-hash'), other.snapshot.payloadHash,
        '切换后必须挂到新基准的快照哈希上');
      equal(Number(t3.getAttribute('data-price')) + Number(t3.getAttribute('data-fx')) +
        Number(t3.getAttribute('data-unattributed')), Number(t3.getAttribute('data-change')),
        '换基准后恒等式必须仍然成立');

      // G4E-1 反例：结账后回填旧业务日期的价格，归因期初必须仍取封存快照里的价格日期。
      // 真实回填链路的金额级断言由 tests/server-phase4e.test.js 覆盖；这里锁定前端读取的是快照 payload。
      var selBack = document.querySelector('#view #attr-baseline');
      selBack.value = expected.id; // 上面切换过基准，先切回默认基准再验证
      selBack.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(function () {
        var t4 = document.querySelector('#view [data-attr-totals]');
        return t4 && t4.getAttribute('data-baseline-id') === expected.id;
      }, 8000, '切回默认基准');
      var stNow = await apiState();
      var ins0 = ((stNow.assets && stNow.assets.instruments) || [])[0];
      if (ins0) {
        var backfillDate = other.month + '-15';
        var bf = await fetch('/api/v1/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-ledger-token': Store.readSessionToken() },
          body: JSON.stringify({ instrumentId: ins0.id, priceMinor: 77700, priceDate: backfillDate })
        });
        assert(bf.status === 201 || bf.status === 409, '回填旧日期价格应被接受或被合并策略拒绝，实际 ' + bf.status);
        clickAction('[data-action="nav:close"]'); // 强刷结账列表并作废归因明细缓存
        clickAction('[data-action="nav:home"]');
        await waitFor(function () {
          var t4 = document.querySelector('#view [data-attr-totals]');
          return t4 && t4.getAttribute('data-baseline-id') === expected.id;
        }, 8000, '回填后归因卡恢复显示');
        var sealed = await fetch('/api/v1/close-snapshots/' + expected.snapshot.id)
          .then(function (r) { return r.json(); });
        var sealedPositions = (sealed.snapshot.payload.attributionPositions) || [];
        assert(sealedPositions.length > 0 || document.querySelectorAll('#view [data-attr-row]').length === 0,
          '基准快照必须封存了逐持仓明细（attributionPositions）');
        var rowsAfter = document.querySelectorAll('#view [data-attr-row]');
        for (var k = 0; k < rowsAfter.length; k++) {
          var rowId = rowsAfter[k].getAttribute('data-attr-row');
          var sealedRow = sealedPositions.filter(function (p) { return p.instrumentId === rowId; })[0];
          if (sealedRow) {
            equal(rowsAfter[k].getAttribute('data-start-price-date'), String(sealedRow.priceDate || ''),
              '期初价格日期必须等于封存明细，不能是回填的 ' + backfillDate);
          }
        }
      }
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
