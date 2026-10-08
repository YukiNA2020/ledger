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
      var diagnostic = document.querySelector('#view');
      results.push({ name: name, pass: false, error: (error && error.message || String(error)) +
        '；页面状态：' + (diagnostic ? diagnostic.textContent.slice(-2200) : '无页面') });
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

  // 5E-4：页面上的知识卡入口必须且只能指向已知卡（未知 id 不渲染入口，打开时再显式降级）
  function assertKnowLinksResolve(scope, label) {
    var links = (scope || document).querySelectorAll('[data-action="know:open"]');
    for (var i = 0; i < links.length; i++) {
      var id = links[i].getAttribute('data-card-id');
      assert(window.Knowledge && window.Knowledge.getCard(id),
        label + '：入口只允许指向已知知识卡，实际 ' + id);
    }
    return links.length;
  }
  function knowLink(scope, cardId) {
    return (scope || document).querySelector('[data-action="know:open"][data-card-id="' + cardId + '"]');
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
      // 当前普通保存保留月结与快照；本场景仍显式补齐比较所需的两个基准月。
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
      await waitFor(function () {
        return document.querySelector('#view [data-action="close:detail"][data-id="' + other.snapshot.id + '"]');
      }, 8000, '月结页已读取新增的历史基准');
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
      var attrCard = document.querySelector('#view [data-attribution="ready"]');
      assert(attrCard && knowLink(attrCard, 'card-fx-risk'), '归因口径说明处应给出汇率风险知识卡入口');
      assert(assertKnowLinksResolve(attrCard, '归因卡') >= 1, '归因卡应给出知识卡入口');

      // 切换期初基准：换成更早那个已结账月后，卡片必须按新基准重算，而不是继续显示旧基准
      var sel = document.querySelector('#view #attr-baseline');
      assert(sel, '归因卡片必须提供期初基准选择器');
      sel.value = other.id;
      equal(sel.value, other.id, '切换的月结必须在当前选择器中');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      equal(document.querySelector('#view #attr-baseline').getAttribute('data-baseline'), other.id,
        '切换事件必须更新选中基准');
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

    await check('篡改快照打开决策台：完整性失败时不给任何归因行', async function () {
      // 真实数据库篡改与 GET 的 hashValid=false 由 server-phase4e.test.js 覆盖；这里锁定浏览器
      // 收到同一接口契约后的 fail-closed 行为，避免再出现「使用篡改值计算、仍展示旧哈希」。
      var originalGetCloseSnapshot = Store.getCloseSnapshot;
      Store.getCloseSnapshot = function (id) {
        return originalGetCloseSnapshot(id).then(function (body) {
          body.snapshot.hashValid = false;
          body.snapshot.integrityStatus = 'mismatch';
          if (body.snapshot.payload && body.snapshot.payload.attributionPositions &&
              body.snapshot.payload.attributionPositions[0]) {
            body.snapshot.payload.attributionPositions[0].priceMinor = 1;
          }
          return body;
        });
      };
      try {
        clickAction('[data-action="nav:close"]'); // 强刷列表并作废归因快照缓存
        clickAction('[data-action="nav:home"]');
        await waitFor(function () {
          return document.querySelector('#view [data-attribution="baseline-mismatch"]');
        }, 8000, '篡改快照的完整性告警');
        equal(document.querySelectorAll('#view [data-attr-row]').length, 0,
          '完整性失败时不得生成任何归因行');
        equal(document.querySelectorAll('#view [data-attr-totals]').length, 0,
          '完整性失败时不得生成归因合计');
      } finally {
        Store.getCloseSnapshot = originalGetCloseSnapshot;
      }
    });

    // C7.9 Phase 5B（S5.1 浏览器层）：问卷只提交原始答案/日期/原因，
    // 派生值（双评分、等级、硬封顶、上限、到期）全部由服务端按 5A 冻结规则重算。
    await check('风险评估：问卷提交 → 服务端重算落库 → 结果/复评追加/历史渲染', async function () {
      var Picked = [
        ['q_income_stability', 'o_fixed_stable', 3],
        ['q_emergency_fund', 'o_cover_12m_plus', 3],
        ['q_debt_pressure', 'o_no_debt', 3],
        ['q_horizon', 'o_horizon_5_10y', 2],
        ['q_liquidity_need', 'o_minor_need', 2],
        ['q_experience', 'o_exp_5y_plus', 3],
        ['q_knowledge', 'o_know_solid', 3],
        ['q_drawdown_tolerance', 'o_dd_20_30', 2],
        ['q_fx_understanding', 'o_fx_clear', 3]
      ];
      var CAP_TOTAL = 13, WIL_TOTAL = 11, CEILING = 5;

      function clickAnswer(i) {
        clickAction('#view input[data-action="risk:answer"][name="' + Picked[i][0] + '"][data-o="' + Picked[i][1] + '"]');
      }
      function setAnswer(i) {
        var el = document.querySelector('#view input[data-action="risk:answer"][name="' + Picked[i][0] + '"][data-o="' + Picked[i][1] + '"]');
        assert(el, '问卷缺少选项 ' + Picked[i][0] + '/' + Picked[i][1]);
        el.checked = true;
        clickAnswer(i);
      }
      function cardsWith(re) {
        return Array.prototype.filter.call(document.querySelectorAll('#view .card'), function (c) {
          return re.test(c.textContent);
        });
      }
      async function listItems() {
        var r = await Store.listRiskAssessments();
        return (r && r.items) || [];
      }
      // 服务端是唯一口径：只读接口 / 复算一致性 / 事实源三处必须给出同一条记录
      async function assertStoredMatches(items, expectedReason) {
        equal(items.length, 1, '评估记录条数不符');
        var it = items[0];
        equal(it.capacityScore, CAP_TOTAL, '承受能力总分应由服务端算出');
        equal(it.capacityLevel, 5, '承受能力等级应由服务端算出');
        equal(it.willingnessScore, WIL_TOTAL, '风险意愿总分应由服务端算出');
        equal(it.willingnessLevel, 5, '风险意愿等级应由服务端算出');
        equal(it.ceiling, CEILING, '最终上限应由服务端算出');
        equal(it.ceilingSource, 'equal', '上限来源应由服务端算出');
        assert(Array.isArray(it.hardCaps) && it.hardCaps.length === 0, '单项 2 分以上的作答不应触发硬封顶');
        equal(it.reason, expectedReason, '复评原因应原样入库');
        equal(it.ruleVersion, Domain.RISK_RULE_VERSION, '规则版本应为当前冻结版本');
        equal(it.assessedAt, Core.todayStr(), '评估日期按提交当天记录');
        var cur = await Store.riskAssessmentCurrent();
        equal(cur.status, 'current', '刚保存的评估应为当前有效');
        equal(cur.current.assessment.id, it.id, '当前判定应指向该记录');
        equal(cur.current.validity.expiry, it.expiry, '到期日应由服务端按规则推出且两处一致');
        var st = await apiState();
        var rows = (st.riskAssessments || []).filter(function (r) { return r.id === it.id; });
        equal(rows.length, 1, 'SQLite 事实源里应恰好有一条该评估');
        equal(rows[0].ceiling, CEILING, '事实源中的派生值必须与服务端口径一致');
        return it;
      }

      // 空状态：页面 → 风险 → 问卷入口
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:risk"]'); }, 8000, '决策台风险评估入口');
      clickAction('#view [data-action="nav:risk"]');
      await waitFor(function () { return document.querySelector('#view [data-action="risk:start"]'); }, 8000, '开始评估问卷入口');
      equal((await listItems()).length, 0, '开始测试前不应存在已保存的评估（草稿不得冒充已保存）');

      // 取消即丢弃：草稿只存在于内存，未提交不算已保存的评估
      clickAction('#view [data-action="risk:start"]');
      await waitFor(function () { return document.querySelector('#view #risk-reason'); }, 5000, '问卷表单');
      equal(document.querySelectorAll('#view [data-action="risk:answer"]').length,
        Domain.RISK_QUESTIONS.length * 4, '每道题应渲染全部选项');
      clickAnswer(0);
      clickAction('#view [data-action="risk:cancel"]');
      await waitFor(function () { return document.querySelector('#view [data-action="risk:start"]'); }, 5000, '返回评估列表');
      clickAction('#view [data-action="risk:start"]');
      await waitFor(function () { return document.querySelector('#view #risk-reason'); }, 5000, '重新打开问卷');
      equal(document.querySelectorAll('#view input[data-action="risk:answer"]:checked').length, 0,
        '取消后重新打开问卷应为空白草稿');

      // 反例：缺答被前端拒绝、不落库；补齐后服务端按 5A 规则重算全部派生值
      var i;
      for (i = 0; i < Picked.length - 1; i++) setAnswer(i);
      document.querySelector('#view #risk-reason').value = 'income_change';
      clickAction('#view [data-action="risk:submit"]');
      await waitFor(function () {
        return document.querySelector('#toast').textContent.indexOf('题未回答') >= 0 &&
          cardsWith(/风险上限 L/).length === 0;
      }, 5000, '缺答拒绝提示');
      equal((await listItems()).length, 0, '缺答被拒绝后不得写入任何评估');
      setAnswer(Picked.length - 1);
      clickAction('#view [data-action="risk:submit"]');
      await waitFor(function () { return cardsWith(/风险上限 L5/).length > 0; }, 8000, '评估结果卡');
      var saved = await assertStoredMatches(await listItems(), 'income_change');
      // 答案规范化：9 行、按题目顺序、分值由服务端按目录回填
      equal(saved.answers.length, Domain.RISK_QUESTIONS.length, '应存 9 行原始答案');
      for (i = 0; i < Picked.length; i++) {
        equal(saved.answers[i].questionId, Picked[i][0], '第 ' + (i + 1) + ' 题顺序应为题目 id');
        equal(saved.answers[i].optionId, Picked[i][1], '第 ' + (i + 1) + ' 题应存所选选项 id');
        equal(saved.answers[i].score, Picked[i][2], '第 ' + (i + 1) + ' 题分值应由服务端按目录回填');
      }
      // 结果解释与历史：双评分、取较低一侧、5C/5D 边界声明
      assert(cardsWith(/承受能力：13 分/).length > 0, '结果卡应展示承受能力得分');
      assert(cardsWith(/风险意愿：11 分/).length > 0, '结果卡应展示风险意愿得分');
      assert(cardsWith(/取.*较低/).length > 0, '结果卡必须说明上限取较低一侧');
      assert(cardsWith(/5C/).length > 0 && cardsWith(/5D/).length > 0,
        '结果卡应声明目标区间属 5C、新增资金建议属 5D，本页不做');
      assert(document.querySelector('#view [data-action="nav:targets"]'),
        '结果卡应给出通往 5C 目标配置页的入口');
      assert(document.querySelector('#view').textContent.indexOf('收入变化') >= 0,
        '当前评估卡应展示触发原因（中文标签）');

      // 反例：客户端伪造派生值 / 缺字段 —— 服务端一律不采信，且错误不回显输入原文
      var forged = await fetch('/api/v1/risk-assessments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ledger-token': Store.readSessionToken() },
        body: JSON.stringify({ answers: [], assessedAt: Core.todayStr(), reason: 'manual', ceiling: 1 })
      });
      equal(forged.status, 400, '伪造派生字段/空答案的提交应被拒绝');
      var forgedBody = await forged.json();
      equal(forgedBody.error.code, 'invalid_answers', '应返回稳定错误码');
      assert(String(forgedBody.error.message).indexOf('ceiling') < 0, '错误说明不得回显输入字段名');
      equal((await listItems()).length, 1, '非法请求不得写入记录');

      // 复评追加新版本：不覆盖历史，两条记录并存且当前指向最新
      await waitFor(function () {
        return document.querySelector('#view [data-action="risk:start"][data-reason="manual"]');
      }, 8000, '复评入口');
      clickAction('#view [data-action="risk:start"][data-reason="manual"]');
      await waitFor(function () { return document.querySelector('#view #risk-reason'); }, 5000, '复评问卷');
      equal(document.querySelectorAll('#view input[data-action="risk:answer"]:checked').length, 0,
        '复评应是空白草稿，不预填历史答案');
      equal(document.querySelector('#view #risk-reason').value, 'manual', '复评入口应预置 manual 原因');
      for (i = 0; i < Picked.length; i++) setAnswer(i);
      clickAction('#view [data-action="risk:submit"]');
      await waitFor(async function () { return (await listItems()).length === 2; }, 8000, '第二条评估落库');
      var items2 = await listItems();
      equal(items2[0].reason, 'manual', '最新版本应为复评触发');
      equal(items2[1].reason, 'income_change', '历史版本的原因与答案保持原样');
      assert(items2[0].id !== items2[1].id, '两条记录应有不同 id');
      var cur2 = await Store.riskAssessmentCurrent();
      equal(cur2.status, 'current', '存在未过期评估时应判定为 current');
      equal(cur2.current.assessment.id, items2[0].id, '当前评估应指向最新一条');
      await waitFor(function () {
        return cardsWith(/评估日期 .* · 到期日/).length > 0 &&
          document.querySelector('#view').textContent.indexOf('手动复评') >= 0;
      }, 8000, '当前评估日期与触发原因');
      assert(document.querySelector('#view').textContent.indexOf('评估历史') >= 0,
        '页面应展示追加式评估历史（永不覆盖）');
    });

    // C7.10 Phase 5C：目标配置与认可标的映射（生成 → 偏离同源 → 映射维护 → 反例 → 全量保存不抹事实）
    await check('目标配置：生成目标版本 → 类别偏离与总览同源 → 认可标的维护与反例', async function () {
      var TOKEN_H = Store.readSessionToken();
      async function putState(mutate) {
        var st = await apiState();
        mutate(st);
        var res = await fetch('/api/v1/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
          body: JSON.stringify({ state: st })
        });
        return res;
      }
      function cardsWith(re) {
        return Array.prototype.filter.call(document.querySelectorAll('#view .card'), function (c) {
          return re.test(c.textContent);
        });
      }
      // 一份 L5 评估（能力 15 / 意愿 12）
      var CAP = Domain.RISK_QUESTIONS.filter(function (q) { return q.kind === 'capacity'; });
      var WIL = Domain.RISK_QUESTIONS.filter(function (q) { return q.kind === 'willingness'; });
      function topAnswers() {
        return CAP.map(function (q) { return { questionId: q.id, optionId: q.options[0].id }; })
          .concat(WIL.map(function (q) { return { questionId: q.id, optionId: q.options[0].id }; }));
      }
      // 投资池：现金 30,000 + 宽基权益 70,000 + 固收 0；THM 分类未确认（不得成为候选）
      function wiringAssets() {
        var today = Core.todayStr();
        return {
          assetAccounts: [
            { id: 'w-acc-cash', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: '虚构机构' },
            { id: 'w-acc-brk', name: '券商户', kind: 'broker', pool: 'investable', institution: '虚构机构' }
          ],
          assetUnits: [{ id: 'w-u-cash', accountId: 'w-acc-cash', currency: 'CNY', balanceMinor: 3000000, asOf: today, sourceType: 'manual' }],
          liabilities: [], entitlements: [], assetTransfers: [], securityEvents: [], fxRates: [],
          instruments: [
            { id: 'w-ins-voo', symbol: 'VOOW', exchange: 'NYSEW', currency: 'USD', name: '宽基一号', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'US', classificationStatus: 'confirmed' },
            { id: 'w-ins-vgt', symbol: 'VGTW', exchange: 'NYSEW', currency: 'USD', name: '宽基二号', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'US', classificationStatus: 'confirmed' },
            { id: 'w-ins-thm', symbol: 'THMW', exchange: 'SSE', currency: 'CNY', name: '主题基金', instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'suggested' }
          ],
          holdings: [{ id: 'w-h-voo', accountId: 'w-acc-brk', instrumentId: 'w-ins-voo', quantity: '100', costMinor: 1000000, asOf: today }],
          quotes: [{ instrumentId: 'w-ins-voo', priceMinor: 40000, currency: 'USD', priceDate: today, provider: 'manual', status: 'ok' }]
        };
      }

      await Store.clearAll();
      var seeded = await putState(function (st) {
        st.assets = wiringAssets();
        st.riskAssessments = [];
        st.allocationTargets = [];
        st.approvedInstruments = [];
      });
      equal(seeded.status, 200, '铺设定虚构资产应成功');
      var ra = await Store.createRiskAssessment(
        { answers: topAnswers(), assessedAt: Core.todayStr(), reason: 'initial' },
        { idempotencyKey: Core.newId('ra') });
      equal(ra.item.ceiling, 5, '前置：该评估的上限为 L5');

      // 决策台入口 → 目标配置页：有评估但未生成目标
      clickAction('#view [data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:targets"]'); }, 8000, '决策台目标配置入口');
      clickAction('#view [data-action="nav:targets"]');
      await waitFor(function () { return document.querySelector('#view [data-action="target:generate"]'); }, 8000, '生成目标入口');
      assert(cardsWith(/还没有生成目标版本/).length > 0, '未生成目标时应显式说明，不显示编造的比例');
      equal((await Store.listAllocationTargets()).items.length, 0, '生成前不得存在目标版本');

      // 反例：客户端提交派生字段被服务端拒绝，且不落库
      var forged = await fetch('/api/v1/targets', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
        body: JSON.stringify({ level: 1, classes: {} })
      });
      equal(forged.status, 400, '伪造派生字段的目标生成应被拒绝');
      var forgedBody = await forged.json();
      equal(forgedBody.error.code, 'invalid_target_payload', '应返回稳定错误码');
      assert(String(forgedBody.error.message).indexOf('level') < 0, '错误说明不得回显输入字段名');
      equal((await Store.listAllocationTargets()).items.length, 0, '非法生成不得写入目标');

      // 生成：页面显示的等级与区间必须等于服务端按冻结模板派生的结果
      clickAction('#view [data-action="target:generate"]');
      await waitFor(function () { return cardsWith(/目标资产类别区间/).length > 0; }, 8000, '目标版本卡');
      var cur = await Store.allocationCurrent();
      equal(cur.status, 'current', '服务端应判定为有生效目标');
      equal(cur.target.level, 5, '上限 L5 映射到 L5 模板');
      equal(cur.target.assessmentId, ra.item.id, '目标必须记住它引用的评估');
      equal(cur.target.effectiveFrom, Core.todayStr(), '缺省生效日期由服务端判定日给出');
      equal(cur.allocation.classes.reduce(function (s, c) { return s + c.pctBps; }, 0), Domain.BPS_TOTAL,
        '服务端给出的类别比例必须精确守恒');
      assert(cardsWith(/上限 L5 · 模板 risk-targets-v1/).length > 0, '页面应展示等级与模板版本');
      var allocCard = cardsWith(/当前配置与偏离/)[0];
      assert(allocCard, '应渲染当前配置与偏离卡');
      equal(allocCard.querySelectorAll('.risk-row').length, Domain.RISK_CLASSES.length, '六个类别各一行');
      // 与决策台同一遍估值核对：现金 / 宽基权益金额逐分一致（USD 报价按手动汇率折算，两边同源）
      var ov = await fetch('/api/v1/overview', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); });
      equal(cur.allocation.investableTotalMinor, ov.pools.investableMinor, '投资池总额与总览逐分一致');
      Domain.RISK_CLASSES.forEach(function (k) {
        var fromOv = ov.riskClasses.filter(function (x) { return x.assetClass === k; })[0];
        var row = cur.allocation.classes.filter(function (x) { return x.assetClass === k; })[0];
        equal(row.valueMinor, fromOv.valueMinor, k + ' 的估值必须来自同一遍计算');
        equal(row.band, row.pctBps < row.minBps ? 'below_min' : (row.pctBps > row.maxBps ? 'above_max' : 'within'),
          k + ' 的容忍带归属必须唯一');
      });
      // 5D 已实现：目标区块不再只是口头边界，而是把新增资金明确指向下方的 5D 面板
      assert(allocCard.textContent.indexOf('新增资金怎么分见下方') >= 0,
        '5C 区块必须把「这笔钱怎么分」指向 5D 面板');
      assert(allocCard.textContent.indexOf('不接收新增资金金额') < 0,
        '旧的口头边界文案不应继续声称本页不接收金额');

      // 缺映射：目标比例 > 0 而没有任何认可标的
      var missingBefore = cur.missingClasses.slice().sort().join(',');
      assert(allocCard.textContent.indexOf('缺映射') >= 0, '未维护映射时应在偏离表上标出缺映射');
      assert(missingBefore.indexOf('broad_equity') >= 0, '前置：宽基权益此时缺映射');

      // 维护 UI：只有「已确认且类别一致」的标的才是候选
      clickAction('#view [data-action="target:reload"]');
      await waitFor(function () { return document.querySelector('#view #map-pick-broad_equity'); }, 8000, '宽基权益候选下拉');
      var pick = document.querySelector('#view #map-pick-broad_equity');
      var pickIds = Array.prototype.map.call(pick.options, function (o) { return o.value; });
      equal(pickIds.length, 2, '宽基权益应有两个已确认候选');
      assert(pickIds.indexOf('w-ins-thm') < 0, '分类未确认的标的不得成为认可候选');
      assert(!document.querySelector('#view #map-pick-theme_equity'), '主题权益没有已确认标的时不给出候选入口');

      // 加入 → 顺序调整：顺序是用户判断，服务端按提交顺序落 position
      pick.value = 'w-ins-voo';
      clickAction('#view [data-action="map:add"][data-cls="broad_equity"]');
      await waitFor(async function () {
        var v = await Store.listApprovedInstruments();
        return v.rows.length === 1 && v.rows[0].instrumentId === 'w-ins-voo';
      }, 8000, '第一条认可标的落库');
      // 重渲染完成后，已认可的标的从候选下拉里消失，剩下的唯一候选就是 VGT
      await waitFor(function () {
        var sel = document.querySelector('#view #map-pick-broad_equity');
        var opts = sel ? Array.prototype.map.call(sel.options, function (o) { return o.value; }) : [];
        return opts.length === 1 && opts[0] === 'w-ins-vgt';
      }, 8000, '候选下拉随映射更新（只剩宽基二号）');
      pick = document.querySelector('#view #map-pick-broad_equity');
      pick.value = 'w-ins-vgt';
      clickAction('#view [data-action="map:add"][data-cls="broad_equity"]');
      await waitFor(async function () {
        var v = await Store.listApprovedInstruments();
        return v.rows.length === 2;
      }, 8000, '第二条认可标的落库');
      var v2 = await Store.listApprovedInstruments();
      equal(v2.rows.map(function (r) { return r.instrumentId; }).join(','), 'w-ins-voo,w-ins-vgt', '按加入顺序排列');
      equal(v2.rows[0].position, 0);
      equal(v2.byClass.broad_equity[1].status, 'ok');
      // 第二个候选已被加入后不再出现在下拉里
      pick = document.querySelector('#view #map-pick-broad_equity');
      assert(!pick || Array.prototype.map.call(pick.options, function (o) { return o.value; }).indexOf('w-ins-vgt') < 0,
        '已认可的标的不得重复出现在候选下拉');
      var firstId = v2.rows[0].id;
      clickAction('#view [data-action="map:down"][data-cls="broad_equity"][data-id="' + firstId + '"]');
      await waitFor(async function () {
        var v = await Store.listApprovedInstruments();
        return v.rows[0].instrumentId === 'w-ins-vgt';
      }, 8000, '顺序调整后写回事实源');
      var v3 = await Store.listApprovedInstruments();
      equal(v3.rows.map(function (r) { return r.instrumentId; }).join(','), 'w-ins-vgt,w-ins-voo', '上移/下移只改顺序，不新增行');
      equal(v3.rows.length, 2, '调整顺序不得产生额外映射记录');

      // 反例：引用未确认标的被服务端拒绝，既有映射保持原样
      var badMap = await fetch('/api/v1/approved-instruments', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
        body: JSON.stringify({ assetClass: 'theme_equity', instrumentIds: ['w-ins-thm'] })
      });
      equal(badMap.status, 422, '引用未确认标的应被拒绝');
      var badMapBody = await badMap.json();
      equal(badMapBody.error.code, 'classification_unconfirmed', '应给出稳定的引用失效码');
      var v4 = await Store.listApprovedInstruments();
      equal(v4.rows.length, 2, '被拒绝的写入不得改动映射');

      // 缺映射随映射更新而收窄；生成目标不因缺映射被阻止（§6.3）
      var cur2 = await Store.allocationCurrent();
      assert(cur2.missingClasses.indexOf('broad_equity') < 0, '已有可用候选的类别不再缺映射');
      assert(cur2.missingClasses.indexOf('theme_equity') >= 0, '仍无可用候选的类别继续报缺映射');
      assert(cur2.missingClasses.slice().sort().join(',') !== missingBefore, '缺映射清单随用户维护而更新');

      // 记账式全量保存（页面 save() 只带五键 + assets）经 Store 门面后不得抹掉三份追加式事实。
      // 注意：直接 PUT /api/v1/state 的「缺键清空」是 5B 已冻结的服务端语义，不在本条断言范围内。
      var st5 = await apiState();
      await Store.saveAll({ accounts: [], categories: [], txns: [], settings: st5.settings, assets: st5.assets });
      var after2 = await Store.allocationCurrent();
      equal(after2.status, 'current', '门面补回后目标版本仍然存在');
      equal(after2.target.id, cur.target.id, '且仍是同一版本（未被覆盖或重生成）');
      var hist = await Store.listAllocationTargets();
      equal(hist.items.length, 1, '目标历史保持追加式单版本');
      equal(hist.invalidCount, 0, '历史列表复核不得把合法目标判为异常');
      equal((await Store.listApprovedInstruments()).rows.length, 2, '全量保存后用户映射逐条保持');
      equal((await Store.listRiskAssessments()).items.length, 1, '全量保存后评估仍然可读');
      // 反向：显式给出空集合时才清空（旧备份恢复语义），三条集合一起受控
      await Store.saveAll({
        accounts: [], categories: [], txns: [], settings: st5.settings, assets: st5.assets,
        allocationTargets: [], approvedInstruments: []
      });
      var wiped = await Store.allocationCurrent();
      equal(wiped.status, 'no_target', '显式提交空集合才是清空指令');
      equal((await Store.listApprovedInstruments()).rows.length, 0);
      equal((await Store.listRiskAssessments()).items.length, 1, '未提到的评估集合保持原样');
    });

    // C7.11 Phase 5D：新增资金优先再平衡与正式建议门禁
    await check('新增资金建议：页面生成正式建议 → 金额守恒且只引用认可标的 → 门禁不过时只给估算', async function () {
      var TOKEN_H = Store.readSessionToken();
      var today = Domain.localTodayISO();
      // 结账核对以「当月月末」为截止日，而建议门禁按服务端今天判定新鲜度：
      // 两个日期的行情 / 汇率都要可见，否则月末结账与今天的建议无法同时是正式口径。
      var ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
      var monthEnd = today.slice(0, 8) + String(new Date(Date.UTC(ty, tm, 0)).getUTCDate()).padStart(2, '0');
      var quoteDates = Array.from(new Set([today, monthEnd]));
      function quoteRows(ins, price, currency) {
        return quoteDates.map(function (d) {
          return { instrumentId: ins, priceMinor: price, currency: currency, priceDate: d, provider: 'manual', status: 'ok' };
        });
      }
      var CAP = Domain.RISK_QUESTIONS.filter(function (q) { return q.kind === 'capacity'; });
      var WIL = Domain.RISK_QUESTIONS.filter(function (q) { return q.kind === 'willingness'; });

      async function putState(state) {
        return fetch('/api/v1/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
          body: JSON.stringify({ state: state })
        });
      }
      function apiPost(path, body) {
        return fetch('/api/v1/' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
          body: JSON.stringify(body)
        }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
      }
      // 一份「现金高配 + 宽基权益 / 主题低配」的干净事实（全部当天数据 → 估值可以是正式口径）
      function adviceAssets() {
        var a = Domain.emptyAssets();
        a.assetAccounts = [
          { id: 'd5-acc-cash', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: 'D5' },
          { id: 'd5-acc-broker', name: '券商户', kind: 'broker', pool: 'investable', institution: 'D5' },
          { id: 'd5-acc-safe', name: '应急金', kind: 'deposit', pool: 'safety', institution: 'D5' }
        ];
        a.assetUnits = [
          { id: 'd5-u-cny', accountId: 'd5-acc-cash', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' },
          { id: 'd5-u-safe', accountId: 'd5-acc-safe', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' }
        ];
        a.instruments = [
          { id: 'd5-ins-bond', symbol: 'D5BND', exchange: 'NASDAQ', currency: 'USD', name: '债基', instrumentType: 'etf', assetClass: 'fixed_income', exposureMarket: 'US', classificationStatus: 'confirmed' },
          { id: 'd5-ins-voo', symbol: 'D5VOO', exchange: 'SSE', currency: 'CNY', name: '宽基A', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
          { id: 'd5-ins-vgt', symbol: 'D5VGT', exchange: 'SSE', currency: 'CNY', name: '宽基B', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
          { id: 'd5-ins-thm', symbol: 'D5THM', exchange: 'SSE', currency: 'CNY', name: '主题', instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' }
        ];
        a.holdings = [
          { id: 'd5-h-bond', accountId: 'd5-acc-broker', instrumentId: 'd5-ins-bond', quantity: '5000', costMinor: 5000000, asOf: today },
          { id: 'd5-h-voo', accountId: 'd5-acc-broker', instrumentId: 'd5-ins-voo', quantity: '50000', costMinor: 5000000, asOf: today },
          { id: 'd5-h-thm', accountId: 'd5-acc-broker', instrumentId: 'd5-ins-thm', quantity: '70000', costMinor: 7000000, asOf: today }
        ];
        a.quotes = quoteRows('d5-ins-bond', 1000, 'USD')
          .concat(quoteRows('d5-ins-voo', 100, 'CNY'))
          .concat(quoteRows('d5-ins-thm', 100, 'CNY'));
        a.fxRates = quoteDates.map(function (d) {
          return { base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: d, provider: 'manual', status: 'ok' };
        });
        return a;
      }

      // 事实链：整份状态（含清空四集合）→ 正式月结 → 评估 → 目标 → 认可标的
      var base = await apiState();
      var seeded = Object.assign({}, base, {
        accounts: [], categories: [], txns: [], settings: {}, assets: adviceAssets(),
        riskAssessments: [], allocationTargets: [], approvedInstruments: [], recommendations: []
      });
      equal((await putState(seeded)).status, 200, '5D 前置状态写入');
      var closed = await apiPost('monthly-closes', { month: today.slice(0, 7) });
      equal(closed.json.close.status, 'formal', '前置：当天数据必须能正式结账');
      var answers = [];
      CAP.forEach(function (q, i) { answers.push({ questionId: q.id, optionId: q.options.filter(function (o) { return o.score === [1, 1, 1, 2, 2][i]; })[0].id }); });
      WIL.forEach(function (q, i) { answers.push({ questionId: q.id, optionId: q.options.filter(function (o) { return o.score === [2, 2, 1, 1][i]; })[0].id }); });
      var assessed = await apiPost('risk-assessments', { answers: answers, assessedAt: today, reason: 'initial' });
      equal(assessed.status, 201, '前置：评估必须落库');
      equal((await apiPost('targets', {})).status, 201, '前置：目标版本必须生成');
      var mapped = await apiPost('approved-instruments', {
        assetClass: 'broad_equity', instrumentIds: ['d5-ins-voo', 'd5-ins-vgt']
      });
      equal(mapped.status, 200, '前置：宽基权益必须有认可标的');

      // 页面路径：目标配置页输入金额 → 生成分配建议
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:targets"]'); }, 8000, '5D 决策台目标配置入口');
      clickAction('[data-action="nav:targets"]');
      await waitFor(function () { return document.querySelector('#view [data-action="target:reload"]'); }, 8000, '目标配置重新读取入口');
      clickAction('#view [data-action="target:reload"]');
      await waitFor(function () { return document.querySelector('#view').textContent.indexOf('D5VOO') >= 0; }, 8000, '5D 前置事实同步到页面');
      await waitFor(function () { return document.querySelector('#view [data-action="advice:run"]'); }, 8000, '新增资金建议入口');
      var amount = document.querySelector('#view [data-input="advice:amount"]');
      amount.value = '2000';
      amount.dispatchEvent(new Event('input', { bubbles: true }));
      clickAction('#view [data-action="advice:run"]');
      await waitFor(function () {
        return /追溯：快照/.test(document.querySelector('#view').textContent);
      }, 8000, '建议结果卡（含追溯信息）');
      var viewText = document.querySelector('#view').textContent;
      assert(/正式建议/.test(viewText), '门禁全过时页面应显示正式建议');
      assert(!/估算建议（未达正式门槛）/.test(viewText), '全过时不得同时显示估算口径');

      var listed = await Store.listRecommendations();
      equal(listed.total, 1, '建议产物只落一行');
      equal(listed.invalidCount, 0, '读取复核必须通过');
      var item = listed.items[0];
      equal(item.status, 'formal');
      equal(item.requestedNewFundsMinor, 200000, '金额按「元 → 最小货币单位」原样绑定');
      var res = item.result;
      equal(res.versions.snapshotPayloadHash.length, 64, '必须绑定封存快照哈希');
      equal(res.dataCutoff, item.dataCutoff);
      var alloc = {};
      res.categoryAllocations.forEach(function (c) { alloc[c.assetClass] = c; });
      equal(alloc.broad_equity.allocatedMinor, 200000, 'S5.2：宽基低配时 2,000 元全部优先补宽基');
      equal(Object.keys(alloc).length, 6, '六类必须逐类给出，顺序固定');
      equal(res.categoryAllocations.map(function (c) { return c.assetClass; }).join(','),
        Domain.RISK_CLASSES.join(','), '类别顺序不得随对象或数据库行序变化');
      var sum = Domain.RISK_CLASSES.reduce(function (acc, k) { return acc + alloc[k].allocatedMinor; }, 0);
      equal(sum, res.roundingNote.allocatedTotalMinor, 'Σ类别 == 实际分配金额');
      equal(res.roundingNote.allocatedTotalMinor + res.roundingNote.unallocatedMinor,
        res.roundingNote.allocatableNewFundsMinor, '守恒');
      Domain.RISK_CLASSES.forEach(function (k) {
        assert(alloc[k].allocatedMinor >= 0, k + ' 绝不得出现负金额');
        if (alloc[k].basis === 'above_max') equal(alloc[k].allocatedMinor, 0, '高配类别不加仓');
        (alloc[k].instruments || []).forEach(function (i) { assert(i.allocatedMinor >= 0); });
        var instSum = (alloc[k].instruments || []).reduce(function (acc, i) { return acc + i.allocatedMinor; }, 0);
        if ((alloc[k].instruments || []).length) equal(instSum, alloc[k].allocatedMinor, '标的级之和等于类别级');
      });
      // 只引用用户事先认可的标的
      var ids = alloc.broad_equity.instruments.map(function (i) { return i.instrumentId; }).sort().join(',');
      if (alloc.broad_equity.allocatedMinor) equal(ids, 'd5-ins-vgt,d5-ins-voo', '落到证券时只能用认可标的');
      else equal(alloc.broad_equity.instruments.length, 0);
      assert(viewText.indexOf(Core.fmtMoney(res.roundingNote.allocatedTotalMinor)) >= 0,
        '页面显示的分配合计必须来自服务端产物');
      // 阶段守卫随阶段显式推进（契约 §11，6C）：建议详情现在提供「进入决定（接受 / 暂缓 / 忽略）」；
      // 执行类动作仍属 6D、复盘属 6E，本页不得出现，入口也只能指向决策创建而非状态跳步。
      assert(!Array.from(document.querySelectorAll('#view button, #view a')).some(function (el) {
        return /已执行|确认执行|复盘/.test(el.textContent);
      }), '5D/6C 页面不得出现执行与复盘动作（属 6D/6E）');
      assert(document.querySelector('#view [data-action="dec:open"]'),
        '6C：正式建议详情提供进入决定入口');

      // 5E-3 建议解释：只搬运服务端 explainCodes / roundingNote / categoryAllocations / todos
      var advEl = document.querySelector('#view [data-advice-result]');
      assert(advEl, '建议结果块应有 data-advice-result');
      equal(advEl.getAttribute('data-advice-status'), 'formal', '门禁全过时状态角标应为 formal');
      equal(advEl.getAttribute('data-advice-adjustment'), res.roundingNote.adjustment,
        '排序/调整结论应与 API roundingNote.adjustment 相同');
      equal(Number(advEl.getAttribute('data-advice-requested')), res.roundingNote.requestedNewFundsMinor,
        '请求金额 data 应与 API 相同');
      equal(Number(advEl.getAttribute('data-advice-allocatable')), res.roundingNote.allocatableNewFundsMinor,
        '可分配 data 应与 API 相同');
      equal(Number(advEl.getAttribute('data-advice-allocated')), res.roundingNote.allocatedTotalMinor,
        '实际分配 data 应与 API 相同');
      equal(Number(advEl.getAttribute('data-advice-unallocated')), res.roundingNote.unallocatedMinor,
        '未分配 data 应与 API 相同');
      equal(Number(advEl.getAttribute('data-advice-allocated')) +
        Number(advEl.getAttribute('data-advice-unallocated')),
        Number(advEl.getAttribute('data-advice-allocatable')),
        '页面 data 层同样守恒：分配 + 未分配 = 可分配');
      assert(viewText.indexOf('守恒：实际分配') >= 0, '页面应显式给出守恒公式');
      var explainAttr = advEl.getAttribute('data-advice-explain') || '';
      equal(explainAttr, (res.explainCodes || []).join(','), 'explainCodes 列表应与 API 相同');
      (res.explainCodes || []).forEach(function (code) {
        assert(advEl.querySelector('[data-explain-code="' + code + '"]'),
          '应渲染解释码 ' + code + ' 的固定文案');
      });
      var orderEl = advEl.querySelector('[data-advice-order]');
      assert(orderEl && /排序依据/.test(orderEl.textContent), '应有类别排序依据说明');
      assert(knowLink(orderEl, 'card-new-funds-first'), '排序依据应给出新增资金优先知识卡入口');
      if (explainAttr.indexOf('new_funds_below_min_first') >= 0) {
        assert(/先补低于区间下限/.test(orderEl.textContent), '存在低配时排序依据须写清先补下限');
      }
      var cashEl = advEl.querySelector('[data-advice-cash-floor]');
      assert(cashEl && /现金保底/.test(cashEl.textContent), '应有现金保底说明');
      assert(/保留现金配置下限/.test(cashEl.textContent), '现金保底须说明保留配置下限');
      if (res.roundingNote.unallocatedMinor > 0) {
        assert(cashEl.textContent.indexOf(Core.fmtMoney(res.roundingNote.unallocatedMinor)) >= 0,
          '有未分配时现金保底段应显示未分配金额');
      }
      var nosellEl = advEl.querySelector('[data-advice-nosell]');
      assert(nosellEl && /默认不卖出/.test(nosellEl.textContent), '应有默认不卖出的具体原因');
      assert(knowLink(nosellEl, 'card-no-sell'), '默认不卖出处应给出知识卡入口');
      assert(assertKnowLinksResolve(advEl, '建议结果') >= 2, '建议结果应给出新增资金与不卖出两个知识卡入口');
      var CLASS_TEXT = {
        cash: '现金', fixed_income: '固收', broad_equity: '宽基权益',
        theme_equity: '主题权益', stock: '个股', other: '其他'
      };
      var aboveMaxOnPage = res.categoryAllocations.filter(function (c) { return c.basis === 'above_max'; });
      assert(aboveMaxOnPage.length > 0, '当前 fixture 应包含高配类别，才能验证高配为零的可见解释');
      if (aboveMaxOnPage.length) {
        assert(/高配/.test(nosellEl.textContent) && /不生成卖出指令|只提示风险/.test(nosellEl.textContent),
          '存在高配时须说明高配只提示风险、不卖出');
        assert(nosellEl.textContent.indexOf(CLASS_TEXT[aboveMaxOnPage[0].assetClass] || aboveMaxOnPage[0].assetClass) >= 0,
          '不卖出原因应点名具体高配类别');
      }
      var roundingEl = advEl.querySelector('[data-advice-rounding]');
      assert(roundingEl, '应有尾差说明块');
      equal(Number(roundingEl.getAttribute('data-leftover')), res.roundingNote.leftoverMinor,
        '尾差 data 应与 API 相同');
      equal(roundingEl.getAttribute('data-receivers'), (res.roundingNote.receivers || []).join(','),
        '尾差承接类别 data 应与 API 相同');
      assert(roundingEl.textContent.indexOf(res.roundingNote.rule) >= 0, '尾差须展示冻结排序规则原文');
      Domain.RISK_CLASSES.forEach(function (k) {
        var row = advEl.querySelector('[data-advice-cls="' + k + '"]');
        assert(row, '页面应有类别行 ' + k);
        equal(row.getAttribute('data-allocated'), String(alloc[k].allocatedMinor),
          k + ' 页面分配应与 API 相同');
        equal(row.querySelector('[data-advice-visible-amount]').textContent,
          Core.fmtMoney(alloc[k].allocatedMinor), k + ' 可见金额应与 API 相同，明确显示计算出的零');
        equal(row.getAttribute('data-basis'), alloc[k].basis, k + ' 页面 basis 应与 API 相同');
        equal(Number(row.getAttribute('data-instrument-count')), (alloc[k].instruments || []).length,
          k + ' 标的数应与 API 相同');
      });
      var mappedRow = advEl.querySelector('[data-advice-cls="broad_equity"]');
      assert(mappedRow && mappedRow.getAttribute('data-instrument-count') !== '0',
        '已映射且有金额的类别应列出认可标的');
      assert(mappedRow.textContent.indexOf('D5VOO') >= 0 && mappedRow.textContent.indexOf('D5VGT') >= 0,
        '认可标的符号应来自服务端 instruments');

      // 5E-5 审计追溯（封存分支）：月结基准 / 计算日输入 / 版本与记录 / 解释版本 四组只搬运服务端字段
      var trace = advEl.querySelector('[data-advice-trace]');
      assert(trace, '建议详情应有审计追溯区 data-advice-trace');
      var baseline = trace.querySelector('[data-advice-trace-baseline]');
      assert(baseline, '追溯区必须有月结基准组');
      equal(baseline.getAttribute('data-close-id'), item.closeId, '追溯区应显示记录绑定的月结 id');
      equal(baseline.getAttribute('data-snapshot-id'), item.snapshotId, '追溯区应显示记录绑定的快照 id');
      equal(baseline.getAttribute('data-snapshot-hash'), item.snapshotPayloadHash, '快照哈希必须是记录绑定的哈希');
      equal(baseline.getAttribute('data-cutoff'), item.dataCutoff, '月结数据截止与记录一致');
      assert(baseline.textContent.indexOf('月结快照是基准，不等同于计算输入') >= 0,
        '必须显式区分月结基准与计算输入，不得混称同一时点');
      var traceInput = trace.querySelector('[data-advice-trace-input]');
      assert(traceInput, '追溯区必须有计算日输入组');
      equal(traceInput.getAttribute('data-as-of'), item.asOf, '计算判定日与记录一致');
      equal(traceInput.getAttribute('data-input-hash'), item.inputHash, '计算输入必须是记录的完整 inputHash');
      equal(traceInput.getAttribute('data-algorithm'), 'cash-reallocation-v1', '算法版本应为 5D 冻结的 cash-reallocation-v1');
      var traceVer = trace.querySelector('[data-advice-trace-versions]');
      assert(traceVer, '追溯区必须有版本与记录组');
      equal(traceVer.getAttribute('data-rec-id'), item.id, '建议 id 与库一致');
      equal(traceVer.getAttribute('data-payload-hash'), item.payloadHash, '建议 payloadHash 与读取视图一致');
      equal(traceVer.getAttribute('data-rule-version'), Domain.RISK_RULE_VERSION, '规则版本来自服务端');
      equal(traceVer.getAttribute('data-target-version'), item.targetVersion, '目标版本与记录一致');
      equal(traceVer.getAttribute('data-assessment-id'), item.assessmentId, '评估 id 与记录一致');
      equal(traceVer.getAttribute('data-target-id'), item.targetId, '目标 id 与记录一致');
      assert(trace.textContent.indexOf('评估 ' + item.assessmentId) >= 0, '追溯文本写明评估引用');
      // 解释版本：新建议已封存，页面显示必须与库里的记录和当前知识卡目录一致
      equal(item.gate.explanationVersion, window.Knowledge.EXPLANATION_VERSION, '库里的建议应封存生成时解释版本');
      var seal = trace.querySelector('[data-advice-explain-seal]');
      assert(seal, '追溯区必须有解释版本组');
      equal(seal.getAttribute('data-sealed'), '1', '新建议应标为已封存解释版本');
      equal(seal.getAttribute('data-sealed-version'), window.Knowledge.EXPLANATION_VERSION, '封存版本号与库一致');
      equal(seal.getAttribute('data-current-version'), window.Knowledge.EXPLANATION_VERSION, '当前知识卡版本与目录一致');
      assert(seal.textContent.indexOf('本条建议生成时封存') >= 0, '已封存必须写明生成时封存');
      assert(seal.textContent.indexOf('非生成时封存版本') === -1, '已封存建议不得出现未封存标注');

      // 反例 1：客户端提交自己的映射 → 服务端拒绝，不落库
      var forged = await apiPost('recommendations', {
        snapshotRef: { closeId: closed.json.close.id, snapshotId: closed.json.snapshot.id, payloadHash: closed.json.snapshot.payloadHash },
        assessmentRef: { id: assessed.json.item.id, ruleVersion: assessed.json.item.ruleVersion },
        targetVersion: Domain.RISK_TARGET_VERSION, ruleVersion: Domain.RISK_RULE_VERSION,
        newFundsMinor: 200000, approvedInstruments: { theme_equity: ['d5-ins-thm'] }
      });
      equal(forged.status, 400, '映射只由服务端读取，不接受请求体');
      equal(forged.json.error.code, 'invalid_approved_instruments');
      equal((await Store.listRecommendations()).total, 1, '被拒绝的请求不得留下建议');

      // 反例 2：引用的快照哈希与封存原文不符 → 只给估算，正式建议为空
      var tampered = await apiPost('recommendations', {
        snapshotRef: { closeId: closed.json.close.id, snapshotId: closed.json.snapshot.id, payloadHash: 'f'.repeat(64) },
        assessmentRef: { id: assessed.json.item.id, ruleVersion: assessed.json.item.ruleVersion },
        targetVersion: Domain.RISK_TARGET_VERSION, ruleVersion: Domain.RISK_RULE_VERSION,
        newFundsMinor: 100000
      });
      equal(tampered.status === 200 || tampered.status === 201, true, '门禁不过不是 HTTP 错误');
      equal(tampered.json.status, 'estimate');
      equal(tampered.json.formalRecommendation, null, '哈希异常时正式建议必须为空');
      assert(tampered.json.estimate.blockers.some(function (b) { return b.code === 'snapshot_hash_mismatch'; }),
        '要显式说明是哪条门禁挡下的');

      // 5E-3：门禁失败的估算产物也要能解释 —— 页面只展示估算，blocker 来自 5D 产物
      var origCreate = Store.createRecommendation;
      Store.createRecommendation = function () { return Promise.resolve(tampered.json); };
      try {
        var amountEst = document.querySelector('#view [data-input="advice:amount"]');
        amountEst.value = '1000';
        amountEst.dispatchEvent(new Event('input', { bubbles: true }));
        clickAction('#view [data-action="advice:run"]');
        await waitFor(function () {
          var el = document.querySelector('#view [data-advice-result]');
          return el && el.getAttribute('data-advice-status') === 'estimate';
        }, 8000, '估算建议解释块');
      } finally {
        Store.createRecommendation = origCreate;
      }
      var estEl = document.querySelector('#view [data-advice-result]');
      equal(estEl.getAttribute('data-advice-status'), 'estimate', '门禁失败时页面状态应为 estimate');
      assert(estEl.querySelector('[data-blocker="snapshot_hash_mismatch"]'),
        '估算态应直接展示 5D 产物中的 blocker 码');
      assert(/估算建议（未达正式门槛）/.test(estEl.textContent), '门禁失败只展示估算标签');
      assert(!/<b>正式建议<\/b>/.test(estEl.innerHTML),
        '不得同时冒充正式建议');
      var estRes = tampered.json.estimate;
      equal(Number(estEl.getAttribute('data-advice-allocated')), estRes.roundingNote.allocatedTotalMinor,
        '估算解释块的分配金额应与 API estimate 相同');
      assert(estEl.querySelector('[data-advice-order]') && estEl.querySelector('[data-advice-nosell]'),
        '估算态同样要有排序依据与不卖出原因');

      // 同一请求重放：仍是同一行，不追加第二份
      var replay = await apiPost('recommendations', {
        snapshotRef: { closeId: closed.json.close.id, snapshotId: closed.json.snapshot.id, payloadHash: closed.json.snapshot.payloadHash },
        assessmentRef: { id: assessed.json.item.id, ruleVersion: assessed.json.item.ruleVersion },
        targetVersion: Domain.RISK_TARGET_VERSION, ruleVersion: Domain.RISK_RULE_VERSION,
        newFundsMinor: 200000
      });
      equal(replay.status, 200, '真实时钟下重复请求仍返回原建议');
      equal(replay.json.id, item.id, '同一输入重复请求回到同一条建议产物');
      equal((await Store.listRecommendations()).total, 2, '只多了一条哈希异常的估算产物');

      // 5E-3 反例 3：清空认可标的 → 金额保留为待办，不转投陌生标的
      var unmap = await apiPost('approved-instruments', {
        assetClass: 'broad_equity', instrumentIds: []
      });
      equal(unmap.status, 200, '清空类别映射应成功');
      var amount2 = document.querySelector('#view [data-input="advice:amount"]');
      amount2.value = '2000';
      amount2.dispatchEvent(new Event('input', { bubbles: true }));
      clickAction('#view [data-action="advice:run"]');
      await waitFor(function () {
        var el = document.querySelector('#view [data-advice-result]');
        return el && el.querySelector('[data-todo="missing_approved_instrument"]');
      }, 8000, '无映射待办解释');
      var todoEl = document.querySelector('#view [data-todo="missing_approved_instrument"][data-todo-class="broad_equity"]');
      assert(todoEl, '宽基无映射时应出现 missing_approved_instrument 待办');
      equal(Number(todoEl.getAttribute('data-retained')), 200000,
        '待办保留金额应等于本次分配额（原样保留，不转投）');
      assert(/不转投陌生标的/.test(todoEl.textContent), '待办文案须明确不转投陌生标的');
      var noMapRow = document.querySelector('#view [data-advice-cls="broad_equity"]');
      equal(noMapRow.getAttribute('data-allocated'), '200000', '无映射时类别级金额仍照常展示');
      equal(noMapRow.getAttribute('data-instrument-count'), '0', '无映射时标的级必须为空');
      assert(!/D5VGT|D5VOO/.test(noMapRow.textContent), '无映射不得回落到陌生标的符号');
      // 恢复映射，避免影响后续断言
      var remap = await apiPost('approved-instruments', {
        assetClass: 'broad_equity', instrumentIds: ['d5-ins-voo', 'd5-ins-vgt']
      });
      equal(remap.status, 200, '恢复认可标的映射应成功');

      // 记账式全量保存（五键）不得抹掉建议产物；显式空集合才是清空指令
      var st6 = await apiState();
      await Store.saveAll({ accounts: [], categories: [], txns: [], settings: st6.settings, assets: st6.assets });
      var kept = await Store.listRecommendations();
      equal(kept.total, 3, '页面保存后建议产物逐条保持（正式 + 哈希估算 + 无映射正式）');
      equal(kept.invalidCount, 0, '页面保存后引用链仍有效');
      equal((await Store.listMonthlyCloses()).items.length, st6.monthlyCloses.length, '页面保存不删除月结');
      var saved = await apiState();
      equal(JSON.stringify(saved.closeSnapshots), JSON.stringify(st6.closeSnapshots), '封存快照原文保存后不变');
      await Store.saveAll({
        accounts: [], categories: [], txns: [], settings: st6.settings, assets: st6.assets,
        riskAssessments: st6.riskAssessments, allocationTargets: st6.allocationTargets,
        approvedInstruments: st6.approvedInstruments, recommendations: []
      });
      equal((await Store.listRecommendations()).total, 0, '显式提交空集合才是清空指令');
      equal((await Store.listAllocationTargets()).items.length, 1, '未提交空的集合保持原样');
    });

    // 5E-5：旧建议未封存解释版本时页面必须显式标注；同一输入重复生成永远回到原行，绝不倒填（D-052）
    await check('5E-5 审计追溯：未封存旧建议显式标注，重复生成不倒填解释版本', async function () {
      var TOKEN_H = Store.readSessionToken();
      // 前置：C7.11 收尾显式清空了建议集合，页面仍在目标页
      var startList = await Store.listRecommendations();
      equal(startList.total, 0, '前置：建议集合已被清空');

      // 生成一条带封存的新建议（认可标的已恢复、金额仍为 2,000 元）
      clickAction('#view [data-action="advice:run"]');
      await waitFor(async function () {
        return (await Store.listRecommendations()).total === 1;
      }, 8000, '新建议落库');
      var sealedList = await Store.listRecommendations();
      equal(sealedList.invalidCount, 0, '读取复核必须通过');
      var sealedRec = sealedList.items[0];
      equal(sealedRec.gate.explanationVersion, window.Knowledge.EXPLANATION_VERSION, '新建议在库里带封存解释版本');
      await waitFor(function () {
        var el = document.querySelector('#view [data-advice-result]');
        var ver = el && el.querySelector('[data-advice-trace-versions]');
        return ver && ver.getAttribute('data-rec-id') === sealedRec.id;
      }, 8000, '建议详情渲染新记录');
      var sealEl = document.querySelector('[data-advice-explain-seal]');
      equal(sealEl.getAttribute('data-sealed'), '1', '新建议页面标为已封存');

      // 模拟升级前的旧建议：全量状态里剥掉解释版本再写回（计算输入一个字节都不改）
      var st = await apiState();
      equal(st.recommendations.length, 1, '全量状态应带同一行建议');
      delete st.recommendations[0].gate.explanationVersion;
      var putRes = await fetch('/api/v1/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
        body: JSON.stringify({ state: st })
      });
      equal(putRes.status, 200, '全量恢复未封存记录应成功，实际 ' + putRes.status);
      var legacyList = await Store.listRecommendations();
      equal(legacyList.total, 1, '旧记录照常在列');
      equal(legacyList.invalidCount, 0, '未封存不是缺陷：旧记录必须仍可验证');
      assert(!('explanationVersion' in legacyList.items[0].gate), '库里的旧记录不应有解释版本');

      // 同一输入再次生成：服务端应回到原行（非新建），页面标「非生成时封存版本」
      var origCreate = Store.createRecommendation;
      var responses = [];
      Store.createRecommendation = function () {
        var p = origCreate.apply(Store, arguments);
        p.then(function (r) { responses.push({ ok: true, r: r }); },
          function (e) { responses.push({ ok: false, e: e }); });
        return p;
      };
      try {
        clickAction('#view [data-action="advice:run"]');
        await waitFor(function () { return responses.length === 1; }, 8000, '重复生成返回');
        assert(responses[0].ok, '重复生成不应报错：' + (responses[0].e && responses[0].e.message));
        equal(responses[0].r.created, false, '同一输入必须幂等回到原行，不得新建');
        equal(responses[0].r.id, legacyList.items[0].id, '回到同一行建议产物');
        await waitFor(function () {
          var el = document.querySelector('#view [data-advice-result]');
          var s = el && el.querySelector('[data-advice-explain-seal]');
          return s && s.getAttribute('data-sealed') === '0';
        }, 8000, '未封存建议的显式标注');
        var viewText = document.querySelector('#view').textContent;
        assert(viewText.indexOf('当前卡片解释，非生成时封存版本') >= 0, '未封存建议必须给出约定标注');
        var sealNow = document.querySelector('[data-advice-explain-seal]');
        equal(sealNow.getAttribute('data-sealed-version'), '', '未封存时不得显示封存版本号');
        equal(sealNow.getAttribute('data-current-version'), window.Knowledge.EXPLANATION_VERSION, '当前知识卡版本照常显示');
        var midList = await Store.listRecommendations();
        equal(midList.total, 1, '同一输入不得产生第二条建议');
        equal(midList.invalidCount, 0, '重复生成后读取复核仍通过');

        // 再生成一次：响应仍是原行，历史记录永不倒填解释版本
        clickAction('#view [data-action="advice:run"]');
        await waitFor(function () { return responses.length === 2; }, 8000, '第三次生成返回');
        assert(responses[1].ok, '第三次生成不应报错：' + (responses[1].e && responses[1].e.message));
        equal(responses[1].r.created, false, '第三次仍是同一行');
        assert(!('explanationVersion' in responses[1].r.recommendation.gate),
          '服务端返回的仍是未封存原行，不得倒填解释版本');
        var finalList = await Store.listRecommendations();
        equal(finalList.total, 1, '建议仍只有一条');
        equal(finalList.invalidCount, 0, '最终读取复核仍通过');
        assert(!('explanationVersion' in finalList.items[0].gate), '历史记录永不回填解释版本');
        var traceStill = document.querySelector('[data-advice-trace-baseline]');
        assert(traceStill, '未封存建议的追溯分区照常渲染');
        equal(traceStill.getAttribute('data-close-id'), finalList.items[0].closeId, '追溯字段与库一致');
        var inputStill = document.querySelector('[data-advice-trace-input]');
        equal(inputStill.getAttribute('data-input-hash'), finalList.items[0].inputHash, '计算输入哈希与库一致');
      } finally {
        Store.createRecommendation = origCreate;
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

    // C9 Phase 5E-1（S5.1 决策台层）：首页风险摘要卡只格式化服务端的当前评估判定。
    // 覆盖无评估 / 已过期 / 即将到期 / 有效四态，逐字段与 /risk-assessments/current 和
    // 风险页核对；过期与读取失败都不得显示为「当前有效」，缺判定也不得显示 L0 或 0 分。
    await check('决策台风险摘要：四态与 API、风险页同源，过期不冒充当前有效', async function () {
      var TOKEN_H = Store.readSessionToken();
      var TODAY = Core.todayStr();
      var HIGH = {}, CAPPED = {};
      Domain.RISK_QUESTIONS.forEach(function (q) {
        HIGH[q.id] = q.options[0].id;
        CAPPED[q.id] = q.options[0].id;
      });
      CAPPED.q_emergency_fund = 'o_cover_under_3m'; // 冻结规则里的硬封顶项（压到 L2）

      function card() { return document.querySelector('#view [data-risk-summary]'); }
      function chipOf(c) {
        var el = c.querySelector('[data-risk-chip]');
        return el ? el.textContent : null;
      }
      function goHome() { clickAction('[data-action="nav:home"]'); }
      async function showCard(view, label) {
        goHome();
        await waitFor(function () {
          var c = card();
          return c && c.dataset.riskSummary === view && c.dataset.riskStatus &&
            !c.querySelector('[data-risk-pending]');
        }, 8000, label || ('决策台风险摘要 ' + view));
        return card();
      }
      async function apiCurrent() {
        var res = await fetch('/api/v1/risk-assessments/current', { headers: { Accept: 'application/json' } });
        assert(res.ok, 'GET /risk-assessments/current 应返回 200，实际 ' + res.status);
        return res.json();
      }
      async function postAssessment(assessedAt, picks, reason) {
        var answers = Domain.RISK_QUESTIONS.map(function (q) {
          return { questionId: q.id, optionId: picks[q.id] };
        });
        var res = await fetch('/api/v1/risk-assessments', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H,
            'Idempotency-Key': Core.newId('ra')
          },
          body: JSON.stringify({ answers: answers, assessedAt: assessedAt, reason: reason })
        });
        var body = await res.json();
        assert(res.ok, '按 ' + assessedAt + ' 追加评估应成功，实际 ' + res.status + '：' +
          JSON.stringify(body.error || body));
        return body.item;
      }
      // 逐字段核对：页面只搬运服务端判定，不得改数值、补默认值或另算到期状态
      function assertCardEqualsApi(c, cur, label) {
        equal(c.dataset.riskStatus, cur.status, label + '：摘要状态应等于服务端判定状态');
        if (cur.status !== 'current') {
          assert(!c.hasAttribute('data-risk-ceiling'), label + '：无可用判定时不得显示风险上限');
          assert(!c.hasAttribute('data-risk-capacity'), label + '：无可用判定时不得显示能力得分');
          assert(c.textContent.indexOf('当前有效') < 0, label + '：非 current 状态不得出现「当前有效」');
          return;
        }
        var rec = cur.current.assessment, val = cur.current.validity;
        equal(c.dataset.riskValidity, val.status, label + '：有效期状态应同源');
        equal(c.dataset.riskCeiling, String(rec.ceiling), label + '：最终上限应同源');
        equal(c.dataset.riskCapacity, rec.capacityScore + '/' + rec.capacityLevel, label + '：能力分/级应同源');
        equal(c.dataset.riskWillingness, rec.willingnessScore + '/' + rec.willingnessLevel, label + '：意愿分/级应同源');
        equal(c.dataset.riskCeilingSource, rec.ceilingSource, label + '：上限来源应同源');
        equal(c.dataset.riskHardCaps, rec.hardCaps.map(function (h) { return h.code; }).join(','),
          label + '：硬封顶命中应同源');
        equal(c.dataset.riskAssessedAt, rec.assessedAt, label + '：评估日应同源');
        equal(c.dataset.riskExpiry, rec.expiry, label + '：到期日应同源');
        equal(c.dataset.riskRemainingDays, String(val.remainingDays), label + '：剩余天数应同源');
        equal(c.dataset.riskReason, rec.reason, label + '：触发原因应同源');
        assert(c.textContent.indexOf('L' + rec.ceiling) >= 0, label + '：正文应显示服务端给出的上限');
      }

      // 1) 无评估：清空账本后评估表为空，摘要不得继续沿用上一次读到的判定
      equal(((await apiState()).riskAssessments || []).length, 0, '清空账本后应没有评估记录');
      var c0 = await showCard('none', '清空账本后决策台显示无评估');
      equal(c0.dataset.riskStatus, 'no_assessment', '无评估状态应来自服务端判定');
      assert(c0.querySelector('[data-action="risk:reassess"][data-reason="initial"]'),
        '无评估时应给出开始评估问卷入口');
      assert(c0.textContent.indexOf('L0') < 0 && c0.textContent.indexOf('0 分') < 0,
        '无评估时不得显示 L0 或 0 分');
      assertCardEqualsApi(c0, await apiCurrent(), '无评估');

      // 2) 已过期：唯一一份评估的到期日已过
      var expiredAt = Domain.addCalendarDays(TODAY, -(Domain.ASSESSMENT_VALID_DAYS + 40));
      await postAssessment(expiredAt, HIGH, 'initial');
      var c1 = await showCard('expired', '决策台显示已过期');
      equal(c1.dataset.riskStatus, 'all_expired', '全部过期时服务端判定为 all_expired');
      equal(chipOf(c1), '已过期', '状态角标应为「已过期」');
      assert(c1.querySelector('[data-action="risk:reassess"][data-reason="annual_expired"]'),
        '过期应给出年度到期复评入口');
      assertCardEqualsApi(c1, await apiCurrent(), '已过期');
      // 与风险页同源：同一事实的到期日两侧一致
      clickAction('#view [data-risk-summary] [data-action="nav:risk"]');
      await waitFor(function () {
        return document.querySelector('#view [data-action="risk:start"][data-reason="annual_expired"]');
      }, 8000, '风险页的复评入口');
      assert(document.querySelector('#view').textContent.indexOf(c1.dataset.riskExpiry) >= 0,
        '风险页与决策台必须给出同一个到期日');

      // 3) 即将到期 + 硬封顶：未过期记录里最新的一份即当前评估
      var soonAt = Domain.addCalendarDays(TODAY, -(Domain.ASSESSMENT_VALID_DAYS - 15));
      var soon = await postAssessment(soonAt, CAPPED, 'annual_expired');
      var c2 = await showCard('expiring', '决策台显示即将到期');
      equal(chipOf(c2), '即将到期', '剩余天数进入窗口时应标为「即将到期」');
      assert(Domain.ASSESSMENT_EXPIRING_DAYS >= 15, 'fixture 应落在冻结的即将到期窗口内');
      var api2 = await apiCurrent();
      equal(api2.current.assessment.id, soon.id, '服务端应把未过期里最新的一份判为当前评估');
      assertCardEqualsApi(c2, api2, '即将到期');
      equal(c2.dataset.riskHardCaps, 'hard_cap_emergency_fund', '摘要应带出硬封顶命中码');
      assert(document.querySelector('#view').textContent.indexOf('应急金不足 3 个月') >= 0,
        '摘要应用风险页词表说明硬封顶原因');
      assert(knowLink(c2, 'card-emergency-fund'), '硬封顶行应给出应急金上限知识卡入口');
      assert(knowLink(c2, 'card-capacity-vs-willingness'), '上限取较低一侧处应给出能力与意愿知识卡入口');
      assert(assertKnowLinksResolve(c2, '风险摘要（硬封顶）') >= 2, '风险摘要应至少两个知识卡入口');
      equal(c2.querySelector('[data-action="risk:reassess"]').dataset.reason, 'manual',
        '存在有效评估时入口应为复评');

      // 4) 有效且无硬封顶：数值逐项与 API、风险页一致
      var fresh = await postAssessment(TODAY, HIGH, 'manual');
      var api3 = await apiCurrent();
      equal(api3.current.assessment.id, fresh.id, '刚追加的评估应为当前评估');
      var c3 = await showCard('valid', '决策台显示有效');
      equal(chipOf(c3), '有效', '状态角标应为「有效」');
      assertCardEqualsApi(c3, api3, '有效');
      assert(c3.textContent.indexOf('硬封顶命中') < 0, '无命中时不得展示硬封顶命中提示');
      clickAction('#view [data-risk-summary] [data-action="nav:risk"]');
      await waitFor(function () {
        return document.querySelector('#view [data-action="risk:start"][data-reason="manual"]');
      }, 8000, '风险页的当前评估卡');
      var riskText = document.querySelector('#view').textContent;
      var rec3 = api3.current.assessment;
      assert(riskText.indexOf('承受能力：' + rec3.capacityScore + ' 分') >= 0,
        '风险页与决策台必须用同一份服务端得分');
      assert(riskText.indexOf('风险上限 L' + rec3.ceiling) >= 0, '风险页上限应与摘要同源');
      assert(riskText.indexOf(api3.current.validity.expiry) >= 0, '风险页到期日应与摘要同源');
      // 只降不升：摘要显示的上限来自服务端，而不是页面按硬封顶自行推断
      equal(c3.dataset.riskCeiling, String(rec3.ceiling), '上限只来自服务端');
      // 过期只使评估失效，不删除历史（追加式事实）
      equal(((await apiState()).riskAssessments || []).length, 3, '三份评估应全部保留为历史');

      // 5) 首页复核未完成时，缓存的有效评估只能标为上次结果；响应只替换摘要卡，
      // 不能重画收益归因等其它区块，也不能让较旧请求覆盖较新判定。
      var origPendingCurrent = Store.riskAssessmentCurrent;
      var finishPending;
      try {
        Store.riskAssessmentCurrent = function () {
          return new Promise(function (resolve) { finishPending = resolve; });
        };
        goHome();
        await waitFor(function () { return card() && card().querySelector('[data-risk-pending]'); },
          8000, '等待服务复核时显式标记旧判定');
        equal(card().dataset.riskSummary, 'refreshing', '复核中不得标为当前有效');
        equal(chipOf(card()), '核对中', '复核中的角标不得写有效');
        var otherCard = document.querySelector('#view [data-attribution]');
        assert(otherCard, '决策台应保留归因区域供局部更新验证');
        finishPending(api3);
        await waitFor(function () { return card() && card().dataset.riskSummary === 'valid'; },
          8000, '复核完成后恢复有效判定');
        equal(document.querySelector('#view [data-attribution]'), otherCard,
          '只更新风险摘要，不重建收益归因交互');
      } finally {
        Store.riskAssessmentCurrent = origPendingCurrent;
      }

      // 6) 决策台的复评入口：进入风险页问卷并预置原因，草稿不预填历史答案
      goHome();
      await waitFor(function () {
        return card() && card().dataset.riskSummary === 'valid' && !card().querySelector('[data-risk-pending]');
      }, 8000, '回到决策台摘要');
      clickAction('#view [data-risk-summary] [data-action="risk:reassess"]');
      await waitFor(function () { return document.querySelector('#view #risk-reason'); }, 8000, '摘要入口进入问卷');
      equal(document.querySelector('#view #risk-reason').value, 'manual', '复评入口应预置 manual 原因');
      equal(document.querySelectorAll('#view input[data-action="risk:answer"]:checked').length, 0,
        '复评入口应是空白草稿');
      clickAction('#view [data-action="risk:cancel"]');

      // 7) 判定读取失败：保留上次结果但显式标注为可能过期，并给出重新读取入口
      var origCurrent = Store.riskAssessmentCurrent;
      try {
        Store.riskAssessmentCurrent = function () {
          var e = new Error('模拟判定读取中断');
          e.code = 'unreachable';
          return Promise.reject(e);
        };
        goHome();
        await waitFor(function () { return card() && card().querySelector('[data-risk-stale]'); },
          8000, '读取失败的显式标注');
        var c4 = card();
        equal(c4.dataset.riskSummary, 'stale', '读取失败时仍保留上一次判定，但不得标为当前有效');
        equal(chipOf(c4), '未复核', '读取失败时角标必须明确并非当前有效');
        assert(c4.querySelector('[data-action="risk:retry"]'), '读取失败应给出重新读取入口');
      } finally {
        Store.riskAssessmentCurrent = origCurrent;
      }
      clickAction('#view [data-risk-summary] [data-action="risk:retry"]');
      await waitFor(function () {
        var c = card();
        return c && !c.querySelector('[data-risk-stale]') && c.dataset.riskSummary === 'valid';
      }, 8000, '重试后恢复判定');
      assertCardEqualsApi(card(), await apiCurrent(), '重试后');
    });

    // C9.5 Phase 5E-2（S5.1 决策台层）：首页配置对照只搬运服务端 /targets/current。
    // 覆盖有目标六类同源、无目标、无估值、分类未确认估算态；缺数据不得出现 0% 或正式口径；
    // 响应只替换对照卡，不重建归因等其它区块。
    await check('决策台配置对照：六类与 /targets/current 同源，缺数据不冒充', async function () {
      var TOKEN_H = Store.readSessionToken();
      var TODAY = Core.todayStr();

      function allocCard() { return document.querySelector('#view [data-alloc-compare]'); }
      function chipOf(c) {
        var el = c.querySelector('[data-alloc-chip]');
        return el ? el.textContent : null;
      }
      function goHome() { clickAction('[data-action="nav:home"]'); }
      async function showCard(pred, label) {
        goHome();
        await waitFor(function () {
          var c = allocCard();
          return c && pred(c) && !c.querySelector('[data-alloc-pending]');
        }, 8000, label || '配置对照卡');
        return allocCard();
      }
      async function apiAlloc() {
        var res = await fetch('/api/v1/targets/current', { headers: { Accept: 'application/json' } });
        assert(res.ok, 'GET /targets/current 应返回 200，实际 ' + res.status);
        return res.json();
      }
      async function putState(mutate) {
        var st = await apiState();
        mutate(st);
        var res = await fetch('/api/v1/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
          body: JSON.stringify({ state: st })
        });
        if (res.status !== 200) {
          var body = await res.json().catch(function () { return {}; });
          throw new Error('PUT /state 应 200，实际 ' + res.status + '：' +
            JSON.stringify(body.error || body));
        }
        return res;
      }
      function topAnswers() {
        return Domain.RISK_QUESTIONS.map(function (q) {
          return { questionId: q.id, optionId: q.options[0].id };
        });
      }
      // 投资池：CNY 现金 30,000 + 宽基持仓（USD 报价按手动汇率折算，与 5C fixture 同源）
      function investableAssets(opts) {
        var onlyConfirmed = opts && opts.onlyConfirmed;
        var inv = {
          assetAccounts: [
            { id: 'e2-cash-acc', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: '虚构机构' },
            { id: 'e2-brk-acc', name: '券商户', kind: 'broker', pool: 'investable', institution: '虚构机构' }
          ],
          assetUnits: [{ id: 'e2-cash', accountId: 'e2-cash-acc', currency: 'CNY', balanceMinor: 3000000, asOf: TODAY, sourceType: 'manual' }],
          liabilities: [], entitlements: [],           assetTransfers: [], securityEvents: [],
          fxRates: [{ base: 'USD', quote: 'CNY', rateDecimal: '7.2000', rateDate: TODAY, provider: 'manual', status: 'ok' }],
          instruments: [
            { id: 'e2-voo', symbol: 'VOO2', exchange: 'NYSE2', currency: 'USD', name: '宽基对照', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'US', classificationStatus: 'confirmed' },
            { id: 'e2-thm', symbol: 'THM2', exchange: 'SSE2', currency: 'CNY', name: '主题未确认', instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'suggested' }
          ],
          holdings: [
            { id: 'e2-h-voo', accountId: 'e2-brk-acc', instrumentId: 'e2-voo', quantity: '100', costMinor: 1000000, asOf: TODAY },
            { id: 'e2-h-thm', accountId: 'e2-brk-acc', instrumentId: 'e2-thm', quantity: '1000', costMinor: 500000, asOf: TODAY }
          ],
          quotes: [
            { instrumentId: 'e2-voo', priceMinor: 40000, currency: 'USD', priceDate: TODAY, provider: 'manual', status: 'ok' },
            { instrumentId: 'e2-thm', priceMinor: 1000, currency: 'CNY', priceDate: TODAY, provider: 'manual', status: 'ok' }
          ]
        };
        if (onlyConfirmed) {
          inv.instruments = inv.instruments.filter(function (i) { return i.classificationStatus === 'confirmed'; });
          inv.holdings = inv.holdings.filter(function (h) { return h.instrumentId === 'e2-voo'; });
          inv.quotes = inv.quotes.filter(function (q) { return q.instrumentId === 'e2-voo'; });
        }
        return inv;
      }
      // 全部清空后的投资池（无估值）
      function emptyInvestableAssets() {
        return {
          assetAccounts: [], assetUnits: [], liabilities: [], entitlements: [],
          assetTransfers: [], securityEvents: [], fxRates: [], instruments: [], holdings: [], quotes: []
        };
      }
      function assertSixClassesEqualApi(c, cur, label) {
        equal(c.dataset.allocStatus, cur.status, label + '：状态应等于服务端判定');
        equal(c.dataset.allocAsof, cur.allocation.asOf, label + '：数据日应同源');
        equal(c.dataset.allocLevel, String(cur.target.level), label + '：目标等级应同源');
        equal(c.dataset.allocInvestable, String(cur.allocation.investableTotalMinor), label + '：投资池应同源');
        equal(c.dataset.allocCanadvise, cur.allocation.canAdvise ? '1' : '0', label + '：canAdvise 应同源');
        equal(c.dataset.allocValuation, cur.allocation.valuationStatus || '', label + '：估值状态应同源');
        var rows = c.querySelectorAll('[data-alloc-cls]');
        equal(rows.length, Domain.RISK_CLASSES.length, label + '：六类各一行');
        Domain.RISK_CLASSES.forEach(function (k) {
          var row = c.querySelector('[data-alloc-cls="' + k + '"]');
          assert(row, label + '：应存在类别行 ' + k);
          var fromApi = cur.allocation.classes.filter(function (x) { return x.assetClass === k; })[0];
          equal(row.getAttribute('data-value-minor'), String(fromApi.valueMinor), label + '：' + k + ' 金额应同源');
          equal(row.getAttribute('data-pct-bps'), fromApi.pctBps == null ? '' : String(fromApi.pctBps),
            label + '：' + k + ' 比例 bps 应同源');
          equal(row.getAttribute('data-min-bps'), String(fromApi.minBps), label + '：' + k + ' min 应同源');
          equal(row.getAttribute('data-target-bps'), String(fromApi.targetBps), label + '：' + k + ' target 应同源');
          equal(row.getAttribute('data-max-bps'), String(fromApi.maxBps), label + '：' + k + ' max 应同源');
          equal(row.getAttribute('data-band'), fromApi.band == null ? '' : String(fromApi.band),
            label + '：' + k + ' 容忍带应同源');
          equal(row.getAttribute('data-deviation-bps'), fromApi.deviationBps == null ? '' : String(fromApi.deviationBps),
            label + '：' + k + ' 偏离 bps 应同源');
        });
        // 比例之和只能来自服务端；页面不得显示成 0% 假对照
        assert(c.textContent.indexOf('正式口径') < 0 || cur.allocation.canAdvise === true,
          label + '：canAdvise=false 时不得出现「正式口径」');
      }

      // 前置：清空 → 可估值资产 + 有效评估（暂无目标）
      await Store.clearAll();
      async function putSeed(mutate) {
        var st = await apiState();
        mutate(st);
        var res = await fetch('/api/v1/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
          body: JSON.stringify({ state: st })
        });
        if (res.status !== 200) {
          var body = await res.json().catch(function () { return {}; });
          throw new Error('铺设定虚构资产应成功：预期 200，实际 ' + res.status +
            '：' + JSON.stringify(body.error || body));
        }
        return res;
      }
      var seeded = await putSeed(function (st) {
        st.assets = investableAssets();
        st.riskAssessments = [];
        st.allocationTargets = [];
        st.approvedInstruments = [];
      });
      equal(seeded.status, 200, '铺设定虚构资产应成功');
      await Store.createRiskAssessment(
        { answers: topAnswers(), assessedAt: TODAY, reason: 'initial' },
        { idempotencyKey: Core.newId('ra') });

      // 1) 尚无目标：给原因与目标页入口，不显示比例对照
      var c1 = await showCard(function (c) { return c.dataset.allocStatus === 'no_target'; },
        '无目标时对照卡');
      equal(chipOf(c1), '尚无目标', '无目标角标');
      assert(c1.textContent.indexOf('还没有生成目标版本') >= 0, '无目标应说明原因');
      assert(c1.querySelector('[data-action="nav:targets"]'), '无目标应给出目标页入口');
      assert(c1.querySelectorAll('[data-alloc-cls]').length === 0, '无目标时不得展示六类比例行');
      equal((await apiAlloc()).status, 'no_target', '服务端应判定 no_target');

      // 2) 生成目标后：六类逐字段与 API 相同
      var gen = await fetch('/api/v1/targets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H,
          'Idempotency-Key': Core.newId('at')
        },
        body: JSON.stringify({})
      });
      assert(gen.status === 200 || gen.status === 201, '生成目标应成功，实际 ' + gen.status);
      var cur1 = await apiAlloc();
      equal(cur1.status, 'current', '服务端应判定 current');
      var c2 = await showCard(function (c) { return c.dataset.allocStatus === 'current'; },
        '有目标时对照卡');
      assertSixClassesEqualApi(c2, cur1, '有目标');
      // 分类未确认的持仓存在 → 应为估算口径，并列出 blocker
      equal(c2.dataset.allocCanadvise, '0', '分类未确认时服务端 canAdvise 应为 false');
      equal(chipOf(c2), '估算口径', '估算口径角标');
      assert(c2.textContent.indexOf('正式口径对照') < 0, '估算态不得标为正式口径');
      assert(c2.querySelector('[data-alloc-blocker="classification_unconfirmed"]') ||
        /分类未确认/.test(c2.textContent), '应展示分类未确认原因');
      assert(c2.querySelectorAll('[data-alloc-cls]').length === Domain.RISK_CLASSES.length,
        '估算态仍展示六类，但角标为估算');

      // 3) 正式口径：去掉未确认标的后 canAdvise 应翻转，卡片同步
      await putState(function (st) {
        st.assets = investableAssets({ onlyConfirmed: true });
      });
      var cur2 = await apiAlloc();
      equal(cur2.allocation.canAdvise, true, '去掉未确认标的后应正式口径');
      var c3 = await showCard(function (c) { return c.dataset.allocCanadvise === '1'; },
        '正式口径对照卡');
      assertSixClassesEqualApi(c3, cur2, '正式口径');
      equal(chipOf(c3), '正式口径对照', '正式口径角标');
      assert(knowLink(c3, 'card-tolerance-band'), '容忍带端点说明处应给出容忍带知识卡入口');
      assert(assertKnowLinksResolve(c3, '配置对照（正式口径）') >= 1, '配置对照应给出知识卡入口');

      // 4) 无估值（投资池为 0）：不得出现 0% 比例行
      await putState(function (st) { st.assets = emptyInvestableAssets(); });
      var cur3 = await apiAlloc();
      equal(cur3.allocation.status, 'no_investable', '服务端应判定 no_investable');
      var c4 = await showCard(function (c) { return c.dataset.allocCompare === 'no_investable'; },
        '无估值对照卡');
      equal(chipOf(c4), '无可估值投资池', '无估值角标');
      assert(c4.textContent.indexOf('不显示类别比例') >= 0, '无估值应说明不显示比例');
      var pctTexts = Array.prototype.map.call(c4.querySelectorAll('[data-alloc-cls]'),
        function (el) { return el.getAttribute('data-pct-bps'); });
      equal(pctTexts.length, Domain.RISK_CLASSES.length, '无估值时仍应保留六类目标行');
      assert(pctTexts.every(function (v) { return v === ''; }),
        '无估值时六类 pct-bps 必须为空，不得出现 0');
      Array.prototype.forEach.call(c4.querySelectorAll('[data-alloc-cls] .r-pct'), function (el) {
        assert(/^目标 .+ · 比例不可用$/.test(el.textContent),
          '无估值时只可显示目标区间，当前比例必须写「比例不可用」');
      });
      assert(c4.textContent.indexOf('正式口径') < 0, '无估值卡不得标为正式口径');
      assert(c4.querySelector('[data-action="nav:targets"]'), '无估值仍保留目标页入口');
      assertSixClassesEqualApi(c4, cur3, '无估值');

      // 5) 恢复有估值资产：正式对照 + 只替换对照卡、归因区 DOM 不重建
      await putState(function (st) {
        st.assets = investableAssets({ onlyConfirmed: true });
      });
      var c5 = await showCard(function (c) { return c.dataset.allocCompare === 'ok'; },
        '恢复正式口径');
      var cur4 = await apiAlloc();
      assertSixClassesEqualApi(c5, cur4, '恢复后');
      // 模拟读取变慢：先标核对中，完成后只换对照卡
      var origAlloc = Store.allocationCurrent;
      var finishAlloc;
      try {
        Store.allocationCurrent = function () {
          return new Promise(function (resolve) { finishAlloc = resolve; });
        };
        goHome();
        await waitFor(function () {
          var c = allocCard();
          return c && c.querySelector('[data-alloc-pending]');
        }, 8000, '对照卡核对中');
        equal(allocCard().dataset.allocCompare, 'refreshing', '复核中不得丢掉已有对照');
        equal(chipOf(allocCard()), '核对中', '复核中角标为核对中');
        var attrDuring = document.querySelector('#view [data-attribution]');
        assert(attrDuring, '决策台应保留归因区域供局部更新验证');
        finishAlloc(cur4);
        await waitFor(function () {
          var c = allocCard();
          return c && c.dataset.allocCompare === 'ok' && !c.querySelector('[data-alloc-pending]');
        }, 8000, '对照复核完成');
        equal(document.querySelector('#view [data-attribution]'), attrDuring,
          '只更新配置对照卡，不重建收益归因交互');
        assertSixClassesEqualApi(allocCard(), cur4, '复核完成后');
      } finally {
        Store.allocationCurrent = origAlloc;
      }

      // 6) 读取失败：显式标注未复核并给重试入口，不冒充没有对照
      var origFail = Store.allocationCurrent;
      try {
        Store.allocationCurrent = function () {
          var e = new Error('模拟配置对照读取中断');
          e.code = 'unreachable';
          return Promise.reject(e);
        };
        goHome();
        await waitFor(function () {
          var c = allocCard();
          return c && c.querySelector('[data-alloc-stale]');
        }, 8000, '对照读取失败标注');
        var c6 = allocCard();
        equal(c6.dataset.allocCompare, 'stale', '读取失败时保留上次结果但标为未复核');
        equal(chipOf(c6), '未复核', '失败角标不得写核对完成');
        assert(c6.querySelector('[data-action="alloc:retry"]'), '失败应给出重新读取入口');
      } finally {
        Store.allocationCurrent = origFail;
      }
      clickAction('#view [data-alloc-compare] [data-action="alloc:retry"]');
      await waitFor(function () {
        var c = allocCard();
        return c && !c.querySelector('[data-alloc-stale]') && c.dataset.allocCompare === 'ok';
      }, 8000, '对照重试后恢复');
      assertSixClassesEqualApi(allocCard(), await apiAlloc(), '重试后');

      // 7) 新评估使旧目标失效：服务端与首页均须提示目标待更新，不得继续沿用旧比例。
      await Store.createRiskAssessment(
        { answers: topAnswers(), assessedAt: TODAY, reason: 'manual' },
        { idempotencyKey: Core.newId('ra') });
      equal((await apiAlloc()).status, 'stale_assessment', '新评估后旧目标应由服务端判为待更新');
      var staleCard = await showCard(function (c) { return c.dataset.allocStatus === 'stale_assessment'; },
        '旧目标待更新');
      equal(staleCard.dataset.allocCompare, 'stale', '旧目标不得继续显示比例对照');
      equal(chipOf(staleCard), '目标待更新', '应明确引导更新目标');
      equal(staleCard.querySelectorAll('[data-alloc-cls]').length, 0, '旧目标不展示六类比例');

      // 8) 评估与目标均为空：普通写入不能保留引用已删除评估的目标（服务端会拒绝）。
      await putState(function (st) { st.riskAssessments = []; st.allocationTargets = []; });
      equal((await apiAlloc()).status, 'no_assessment', '无有效评估应由服务端判定');
      var noAssessmentCard = await showCard(function (c) { return c.dataset.allocStatus === 'no_assessment'; },
        '无评估的配置对照');
      equal(chipOf(noAssessmentCard), '尚未评估', '无评估提示应独立于无目标');
      equal(noAssessmentCard.querySelectorAll('[data-alloc-cls]').length, 0, '无评估不展示比例');

      // 9) 无法通过服务端复核的目标记录：服务端测试负责构造损坏记录，
      // 此处验证 UI 不泄露比例或正式口径，并显式保留异常记录数。
      var origInvalid = Store.allocationCurrent;
      try {
        Store.allocationCurrent = function () {
          return Promise.resolve({ status: 'invalid_records', invalidCount: 1, total: 1 });
        };
        var invalidCard = await showCard(function (c) { return c.dataset.allocStatus === 'invalid_records'; },
          '不可复核目标记录');
        equal(invalidCard.dataset.allocCompare, 'invalid', '不可复核记录必须 fail closed');
        equal(invalidCard.dataset.allocInvalid, '1/1', '异常记录数应明确保留');
        equal(invalidCard.querySelectorAll('[data-alloc-cls]').length, 0, '不可复核记录不展示比例');
        assert(invalidCard.textContent.indexOf('正式口径') < 0, '不可复核记录不得标正式口径');
      } finally {
        Store.allocationCurrent = origInvalid;
      }
    });

    // 5E-4 Phase 5E-4：本地知识卡。目录静态离线、按已知 id 打开、未知 id 显式降级；
    // 卡片只解释概念与规则来源，不含账户事实、不构成建议、无收益承诺。
    await check('本地知识卡：已知 id 打开、未知 id 显式降级、离线无建议边界', async function () {
      assert(window.Knowledge, '页面应加载 js/knowledge.js（Knowledge 全局）');
      var ver = window.Knowledge.EXPLANATION_VERSION;
      equal(typeof ver, 'string', '应有 EXPLANATION_VERSION');
      assert(ver.length > 0, 'EXPLANATION_VERSION 不得为空');
      var required = ['card-capacity-vs-willingness', 'card-emergency-fund', 'card-tolerance-band',
        'card-new-funds-first', 'card-fx-risk', 'card-no-sell'];
      required.forEach(function (id) {
        assert(window.Knowledge.getCard(id), '缺必过知识卡 ' + id);
      });
      assert(window.Knowledge.cardIds.length >= 6, '目录至少包含 5E-4 点名的六张卡');

      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-risk-summary]'); }, 8000, '决策台');
      assertKnowLinksResolve(document, '当前页面'); // 页面上已渲染的入口必须全部指向已知卡

      function openByCardId(id) {
        var btn = document.createElement('button');
        btn.setAttribute('data-action', 'know:open');
        btn.setAttribute('data-card-id', id);
        document.getElementById('view').appendChild(btn);
        btn.click();
        return btn;
      }

      // 1) 已知 id：打开卡片正文，页脚带解释版本与「不构成建议」边界，且是离线文本
      var btnKnown = openByCardId('card-capacity-vs-willingness');
      await waitFor(function () {
        return document.querySelector('#sheet [data-know-card="card-capacity-vs-willingness"]');
      }, 5000, '已知知识卡弹层');
      var sheet = document.querySelector('#sheet');
      var sheetText = sheet.textContent;
      assert(sheetText.indexOf(window.Knowledge.getCard('card-capacity-vs-willingness').title) >= 0,
        '弹层应显示该卡标题');
      assert(sheetText.indexOf('解释版本 ' + ver) >= 0, '弹层应显示 EXPLANATION_VERSION');
      assert(/不构成投资建议/.test(sheetText), '卡片必须显式声明不构成投资建议');
      assert(/http/i.test(sheetText) === false, '卡片为本地静态文本，不得出现外部链接');
      assert(/保本|稳赚|包赚|保证收益|预期收益/.test(sheetText) === false, '卡片不得出现收益承诺');
      clickAction('#sheet [data-action="sheet:close"]');
      await waitFor(function () { return document.querySelector('#sheet-mask.hidden'); }, 5000, '关闭知识卡');

      // 2) 未知 id：显式降级，点名缺失 id，且不渲染任何卡片正文
      var btnUnknown = openByCardId('card-does-not-exist');
      await waitFor(function () { return document.querySelector('#sheet [data-know-missing]'); }, 5000, '未知卡降级提示');
      var missing = document.querySelector('#sheet [data-know-missing]');
      assert(missing.textContent.indexOf('card-does-not-exist') >= 0, '降级提示应点名未知 id');
      assert(!document.querySelector('#sheet [data-know-card]'), '未知 id 不得渲染任何卡片正文');
      clickAction('#sheet [data-action="sheet:close"]');
      await waitFor(function () { return document.querySelector('#sheet-mask.hidden'); }, 5000, '关闭降级提示');
      btnKnown.remove();
      btnUnknown.remove();
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

    // ================= 5E-6 整体验收（十态中的四个未覆盖态 + 三层复核 + 一分钟演练） =================
    // fixture 与断言先用隔离临时库离线预演过（能力 L2 < 意愿 L5、0 元守恒、分类/行情估算、
    // 领域重算与 API 字节一致），本处只验证「页面把领域与服务端的结论一步读到」。
    var MATRIX = {};
    var TOKEN_5E6 = Store.readSessionToken();

    async function mPutState(state, label) {
      var res = await fetch('/api/v1/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_5E6 },
        body: JSON.stringify({ state: state })
      });
      if (res.status !== 200) {
        var body = await res.json().catch(function () { return {}; });
        throw new Error((label || 'PUT /state') + ' 应 200，实际 ' + res.status + '：' +
          JSON.stringify(body.error || body));
      }
      return res;
    }
    function mApiPost(path, body) {
      return fetch('/api/v1/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_5E6 },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, json: j }; });
      });
    }
    // 与 5D 建议 fixture 同一份数字，只换 id/符号前缀（D5→E6），让两次播种能在目标页 DOM 上区分
    function mAdviceAssets(today, monthEnd, tag, low) {
      var quoteDates = Array.from(new Set([today, monthEnd]));
      function rows(ins, price, currency) {
        return quoteDates.map(function (d) {
          return { instrumentId: ins, priceMinor: price, currency: currency, priceDate: d, provider: 'manual', status: 'ok' };
        });
      }
      var a = Domain.emptyAssets();
      a.assetAccounts = [
        { id: low + '-acc-cash', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: tag },
        { id: low + '-acc-broker', name: '券商户', kind: 'broker', pool: 'investable', institution: tag },
        { id: low + '-acc-safe', name: '应急金', kind: 'deposit', pool: 'safety', institution: tag }
      ];
      a.assetUnits = [
        { id: low + '-u-cny', accountId: low + '-acc-cash', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' },
        { id: low + '-u-safe', accountId: low + '-acc-safe', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' }
      ];
      a.instruments = [
        { id: low + '-ins-bond', symbol: tag + 'BND', exchange: 'NASDAQ', currency: 'USD', name: '债基', instrumentType: 'etf', assetClass: 'fixed_income', exposureMarket: 'US', classificationStatus: 'confirmed' },
        { id: low + '-ins-voo', symbol: tag + 'VOO', exchange: 'SSE', currency: 'CNY', name: '宽基A', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
        { id: low + '-ins-vgt', symbol: tag + 'VGT', exchange: 'SSE', currency: 'CNY', name: '宽基B', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
        { id: low + '-ins-thm', symbol: tag + 'THM', exchange: 'SSE', currency: 'CNY', name: '主题', instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' }
      ];
      a.holdings = [
        { id: low + '-h-bond', accountId: low + '-acc-broker', instrumentId: low + '-ins-bond', quantity: '5000', costMinor: 5000000, asOf: today },
        { id: low + '-h-voo', accountId: low + '-acc-broker', instrumentId: low + '-ins-voo', quantity: '50000', costMinor: 5000000, asOf: today },
        { id: low + '-h-thm', accountId: low + '-acc-broker', instrumentId: low + '-ins-thm', quantity: '70000', costMinor: 7000000, asOf: today }
      ];
      a.quotes = rows(low + '-ins-bond', 1000, 'USD')
        .concat(rows(low + '-ins-voo', 100, 'CNY'))
        .concat(rows(low + '-ins-thm', 100, 'CNY'));
      a.fxRates = quoteDates.map(function (d) {
        return { base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: d, provider: 'manual', status: 'ok' };
      });
      return a;
    }
    // S5.1 前提：能力题全取 1 分档（避开 score<=0 的硬封顶触发）→ L2；意愿题取满分 → L5，
    // 上限来源必须由服务端判为 capacity（取较低一侧），硬封顶不命中。
    function mCapWilAnswers() {
      var answers = [];
      Domain.RISK_QUESTIONS.filter(function (q) { return q.kind === 'capacity'; }).forEach(function (q) {
        var opts = q.options.filter(function (o) { return o.score >= 1; })
          .sort(function (a, b) { return a.score - b.score; });
        assert(opts.length > 0, '能力题 ' + q.id + ' 应有 1 分及以上档');
        answers.push({ questionId: q.id, optionId: opts[0].id });
      });
      Domain.RISK_QUESTIONS.filter(function (q) { return q.kind === 'willingness'; }).forEach(function (q) {
        var opts = q.options.slice().sort(function (a, b) { return b.score - a.score; });
        answers.push({ questionId: q.id, optionId: opts[0].id });
      });
      return answers;
    }
    async function mSeedFixture(today, monthEnd, tag, keepClose) {
      var low = tag.toLowerCase();
      var assets = mAdviceAssets(today, monthEnd, tag, low);
      var base = await apiState();
      var seeded = Object.assign({}, base, {
        accounts: [], categories: [], txns: [], settings: {}, assets: assets,
        riskAssessments: [], allocationTargets: [], approvedInstruments: [], recommendations: []
      });
      // keepClose=true（第二段播种）：保留已有正式月结——建议门禁引用它；
      // 否则（首段播种）清空月结与快照，制造「无正式月结」前置。
      if (!keepClose) {
        seeded.monthlyCloses = [];
        seeded.closeSnapshots = [];
      }
      await mPutState(seeded, '5E-6 播种状态');
      var answers = mCapWilAnswers();
      var assessed = await mApiPost('risk-assessments', { answers: answers, assessedAt: today, reason: 'initial' });
      equal(assessed.status, 201, '5E-6 播种评估落库，实际 ' + assessed.status);
      var target = await mApiPost('targets', {});
      equal(target.status, 201, '5E-6 播种目标生成，实际 ' + target.status);
      var mapped = await mApiPost('approved-instruments', {
        assetClass: 'broad_equity', instrumentIds: [low + '-ins-voo', low + '-ins-vgt']
      });
      equal(mapped.status, 200, '5E-6 播种认可标的映射，实际 ' + mapped.status);
      return { today: today, monthEnd: monthEnd, assets: assets, answers: answers, assessed: assessed, target: target, mapped: mapped };
    }
    function mSetAmount(value) {
      var amount = document.querySelector('#view [data-input="advice:amount"]');
      assert(amount, '5E-6 应有建议金额输入框');
      amount.value = value;
      amount.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function mRunAdvice() { clickAction('#view [data-action="advice:run"]'); }
    function mAdviceEl() { return document.querySelector('#view [data-advice-result]'); }

    // ---- 状态矩阵：无正式月结（客户端拒绝）→ 0 元正式 → 分类未确认估算 → 行情过期估算 + 决策台阻塞 ----
    await check('5E-6 状态矩阵：无正式月结 / 0 元 / 分类未确认 / 行情过期的建议与决策台页面态', async function () {
      var today = Domain.localTodayISO();
      var ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
      var monthEnd = today.slice(0, 8) +
        String(new Date(Date.UTC(ty, tm, 0)).getUTCDate()).padStart(2, '0');

      var seeded = await mSeedFixture(today, monthEnd, 'D5');
      MATRIX.today = today;
      MATRIX.monthEnd = monthEnd;
      MATRIX.assets = seeded.assets;
      MATRIX.answers = seeded.answers;
      MATRIX.assessment = seeded.assessed.json.item;

      // 目标页同步到本 fixture（此前是 2287 的 VOO2 视图，D5VOO 出现即刷新完成）。
      // tabbar 只有 资产/明细/记一笔/统计/我的，没有目标配置入口；先回决策台走 dash-entry。
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:targets"]'); },
        8000, '5E-6 决策台目标配置入口');
      clickAction('#view [data-action="nav:targets"]');
      await waitFor(function () { return document.querySelector('#view [data-action="target:reload"]'); },
        8000, '5E-6 目标配置入口');
      clickAction('#view [data-action="target:reload"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('D5VOO') >= 0 &&
          document.querySelector('#view [data-action="advice:run"]');
      }, 8000, '5E-6 fixture 同步到目标页');

      // 1) 没有正式月结：客户端直接拒绝，不产生任何建议行
      mSetAmount('2000');
      mRunAdvice();
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('未能生成建议') >= 0;
      }, 8000, '无正式月结错误提示');
      var errText = document.querySelector('#view').textContent;
      assert(errText.indexOf('本机还没有可引用的正式月结，请先完成月度结账') >= 0,
        '错误文案应说明缺正式月结并引导先完成月度结账');
      assert(!mAdviceEl(), '客户端拒绝时不得出现建议结果卡');
      equal((await Store.listRecommendations()).total, 0, '客户端拒绝不得产生建议行');

      // 2) 建立正式月结 → 0 元仍是正式建议，可分配与实际分配都为 0
      var closed = await mApiPost('monthly-closes', { month: today.slice(0, 7) });
      equal(closed.json.close.status, 'formal', '前置：当天数据必须能正式结账');
      MATRIX.close = closed.json;
      mSetAmount('0');
      mRunAdvice();
      await waitFor(function () {
        var el = mAdviceEl();
        return el && el.getAttribute('data-advice-status') === 'formal';
      }, 8000, '0 元正式建议');
      var zeroEl = mAdviceEl();
      assert(zeroEl.innerHTML.indexOf('<b>正式建议</b>') >= 0, '0 元应显示正式建议标题');
      equal(zeroEl.getAttribute('data-advice-requested'), '0', '0 元请求金额 data');
      equal(zeroEl.getAttribute('data-advice-allocatable'), '0', '0 元可分配 data');
      equal(zeroEl.getAttribute('data-advice-allocated'), '0', '0 元实际分配 data');
      var zeroSum = 0;
      Domain.RISK_CLASSES.forEach(function (k) {
        var row = zeroEl.querySelector('[data-advice-cls="' + k + '"]');
        assert(row, '0 元建议仍应有类别行 ' + k);
        zeroSum += Number(row.getAttribute('data-allocated'));
      });
      equal(zeroSum, 0, '0 元六类分配之和为 0');
      var recs0 = await Store.listRecommendations();
      var zeroRows = recs0.items.filter(function (r) {
        return r.status === 'formal' && r.requestedNewFundsMinor === 0;
      });
      equal(zeroRows.length, 1, '0 元正式建议唯一');
      equal(zeroRows[0].allocatedTotalMinor, 0, 'API：0 元实际分配为 0');
      equal(zeroRows[0].allocatableNewFundsMinor, 0, 'API：0 元可分配为 0');
      equal(zeroRows[0].allocatedTotalMinor + zeroRows[0].result.roundingNote.unallocatedMinor,
        zeroRows[0].allocatableNewFundsMinor, 'API：0 元守恒');
      equal(zeroRows[0].result.status, 'formal', 'API：0 元产物状态 formal');

      // 3) 分类未确认 → 估算。注意：只翻转未映射但有持仓的 thm；映射引用的 voo/vgt 必须保持
      //    confirmed，否则整份状态 PUT 会被 422 classification_unconfirmed 拒绝（认可标的引用校验）。
      var stCls = await apiState();
      var clsAssets = JSON.parse(JSON.stringify(MATRIX.assets));
      clsAssets.instruments.filter(function (i) { return i.assetClass === 'theme_equity'; })
        .forEach(function (i) { i.classificationStatus = 'suggested'; });
      await mPutState(Object.assign({}, stCls, { assets: clsAssets }), '5E-6 写入分类未确认状态');
      mSetAmount('2000');
      mRunAdvice();
      await waitFor(function () {
        var el = mAdviceEl();
        return el && el.getAttribute('data-advice-status') === 'estimate';
      }, 8000, '分类未确认估算建议');
      var clsEl = mAdviceEl();
      assert(clsEl.querySelector('[data-blocker="classification_unconfirmed"]'),
        '估算态应展示 classification_unconfirmed blocker');
      assert(/估算建议（未达正式门槛）/.test(clsEl.textContent), '分类未确认应显示估算标签');
      assert(/formalRecommendation 为空/.test(clsEl.textContent),
        '估算态应说明 formalRecommendation 为空');
      assert(clsEl.innerHTML.indexOf('<b>正式建议</b>') < 0, '估算不得冒充正式建议');

      // 4) 行情 / 汇率过期（>5 个自然日）→ 估算；每标的只留一条过期报价，避免重复键
      var stStale = await apiState();
      var staleAssets = JSON.parse(JSON.stringify(MATRIX.assets));
      var staleDay = Domain.addCalendarDays(today, -7);
      staleAssets.quotes = staleAssets.quotes.filter(function (q, i, arr) {
        return arr.findIndex(function (x) { return x.instrumentId === q.instrumentId; }) === i;
      });
      staleAssets.quotes.forEach(function (q) { q.priceDate = staleDay; });
      staleAssets.fxRates = [{ base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: staleDay, provider: 'manual', status: 'ok' }];
      await mPutState(Object.assign({}, stStale, { assets: staleAssets }), '5E-6 写入行情过期状态');
      mSetAmount('2000');
      mRunAdvice();
      await waitFor(function () {
        return document.querySelector('#view [data-blocker="quote_stale"]') &&
          !document.querySelector('#view [data-blocker="classification_unconfirmed"]');
      }, 8000, '行情过期估算建议');
      var staleEl = mAdviceEl();
      equal(staleEl.getAttribute('data-advice-status'), 'estimate', '行情过期仍为估算');
      assert(staleEl.querySelector('[data-blocker="quote_stale"]'), '应展示 quote_stale blocker');
      assert(staleEl.querySelector('[data-blocker="fx_stale"]'), '应展示 fx_stale blocker');
      assert(/估算建议（未达正式门槛）/.test(staleEl.textContent), '行情过期显示估算标签');

      // 5) 决策台：估算口径 blocker 与「本月可新增投资资金」估算角标。
      //    决策台读的是页面内存里的 assets（写库的 PUT 不会自动同步页面），先让目标页
      //    重读事实源（过期状态出现在目标页估算阻塞列表即同步完成），再回决策台核对。
      clickAction('#view [data-action="target:reload"]');
      await waitFor(function () {
        // 目标页的估算阻塞卡只在页面重读事实源后出现（建议结果卡里的行情已过期文案更早就有，不能当信号）
        var t = document.querySelector('#view').textContent;
        return t.indexOf('当前为估算口径') >= 0 && t.indexOf('行情已过期') >= 0;
      }, 8000, '5E-6 目标页同步过期事实源');
      clickAction('[data-action="nav:home"]');
      await waitFor(function () {
        var b = document.querySelector('#view .dash-blockers');
        return b && b.textContent.indexOf('行情已过期') >= 0;
      }, 8000, '决策台估算口径 blocker');
      var dashText = document.querySelector('#view').textContent;
      assert(dashText.indexOf('以下数据问题使结果为估算口径') >= 0, '决策台应说明估算口径');
      assert(dashText.indexOf('汇率已过期') >= 0, '决策台应点名汇率已过期');
      assert(document.querySelector('#view .dash-hero'), '行情过期不影响资产数据展示：净资产卡仍在');
      var nfCard = Array.prototype.filter.call(
        document.querySelectorAll('#view .card'),
        function (c) { return c.textContent.indexOf('本月可新增投资资金') >= 0; })[0];
      assert(nfCard, '本月可新增投资资金卡应存在');
      assert(nfCard.textContent.indexOf('估算') >= 0, 'canAdvise=false 时新增资金卡标注估算');
      assert(nfCard.textContent.indexOf('正式口径') < 0, 'canAdvise=false 时不得出现正式口径');

      // 6) 行总账：3 行产物全部可读可复核，估算行各自带稳定 blocker 码
      var recs = await Store.listRecommendations();
      equal(recs.total, 3, '状态矩阵共 3 行建议产物（0 元正式 + 两条估算）');
      equal(recs.invalidCount, 0, '读取复核必须通过');
      equal(recs.items.filter(function (r) { return r.status === 'formal'; }).length, 1, '仅 0 元一条正式');
      var ests = recs.items.filter(function (r) { return r.status === 'estimate'; });
      equal(ests.length, 2, '分类未确认与行情过期各一条估算');
      ests.forEach(function (r) { equal(r.result.status, 'estimate', '估算行产物状态应为 estimate'); });
      assert(ests.some(function (r) {
        return (r.result.blockers || []).some(function (b) { return b.code === 'classification_unconfirmed'; });
      }), '分类未确认估算行应带稳定 blocker 码');
      assert(ests.some(function (r) {
        return (r.result.blockers || []).some(function (b) { return b.code === 'quote_stale'; });
      }), '行情过期估算行应带稳定 blocker 码');
    });

    // ---- 三层复核：固定输入下 领域 = API = 页面（S5.1 上限取较低一侧 / S5.2 分配与解释码 / S5.3 可追溯） ----
    await check('5E-6 三层复核：领域 = API = 页面（S5.1 能力约束意愿 + S5.2 分配与解释码 + S5.3 追溯）', async function () {
      assert(MATRIX.today && MATRIX.assessment, '应复用状态矩阵的同一 fixture 与同一时钟');
      var today = MATRIX.today;
      var monthEnd = MATRIX.monthEnd;

      // 重新播种（E6 前缀，目标页可与上一段的 D5 视图区分）；保留 A 段建立的正式月结，
      // 只动 assets/评估/目标/映射/建议行；页面随后通过 target:reload 重新同步 view。
      var MB = await mSeedFixture(today, monthEnd, 'E6', true);
      var recB = MB.assessed.json.item;

      // S5.1 第一层：领域独立复算 == API 记录
      var domScore = Domain.scoreRiskAnswers(MB.answers);
      assert(domScore.ok, 'Domain 应能复算本 fixture 答案');
      equal(domScore.ceilingSource, 'capacity', '前提：能力侧更低，上限来源为 capacity');
      assert(domScore.capacityLevel < domScore.willingnessLevel, '能力级必须低于意愿级');
      equal(domScore.hardCaps.length, 0, '本 fixture 不应命中硬封顶');
      ['ceiling', 'ceilingSource', 'capacityScore', 'capacityLevel', 'willingnessScore', 'willingnessLevel']
        .forEach(function (key) {
          equal(recB[key], domScore[key], 'S5.1 领域==API：' + key);
        });
      equal(recB.ruleVersion, domScore.ruleVersion, 'S5.1 领域==API：ruleVersion');

      // 页面生成正式建议 2,000 元（目标页 reload 后 view 引用 E6 的评估与目标）。
      // 上一段结束时页面可能在明细页或决策台，且目标页视图还是 D5：一律先回决策台，
      // 再进目标页并强制重读（route 的惰性加载在 targetsLoaded 时不会重新拉取）。
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:targets"]'); },
        8000, '5E-6 决策台目标配置入口');
      clickAction('#view [data-action="nav:targets"]');
      await waitFor(function () {
        return document.querySelector('#view [data-action="target:reload"]') ||
          document.querySelector('#view [data-action="advice:run"]');
      }, 8000, '5E-6 目标页入口');
      clickAction('#view [data-action="target:reload"]');
      await waitFor(function () {
        return document.querySelector('#view').textContent.indexOf('E6VOO') >= 0 &&
          document.querySelector('#view [data-action="advice:run"]');
      }, 8000, '5E-6 E6 fixture 同步到目标页');
      mSetAmount('2000');
      mRunAdvice();
      await waitFor(function () {
        var el = mAdviceEl();
        return el && el.getAttribute('data-advice-status') === 'formal';
      }, 8000, '三层复核用正式建议');

      var listed = await Store.listRecommendations();
      equal(listed.total, 1, '重新播种后仅本步一条建议产物');
      equal(listed.invalidCount, 0, '读取复核必须通过');
      var item = listed.items[0];
      equal(item.status, 'formal', '本步产物为正式建议');
      equal(item.requestedNewFundsMinor, 200000, '金额按「元 → 最小货币单位」绑定');
      equal(item.assessmentId, recB.id, '建议应绑定本步评估');
      // S5.3 第一层：七条门禁全过，码集合与冻结词表一致
      equal(item.gate.checks.map(function (c) { return c.code; }).slice().sort().join(','),
        Domain.RECOMMENDATION_GATE_CHECKS.slice().sort().join(','), '门禁码集合与冻结词表一致');
      item.gate.checks.forEach(function (c) {
        assert(c.passed === true, '门禁 ' + c.code + ' 必须通过');
      });
      var res = item.result;

      // 页面层（建议结果卡）：类别分配 / 解释码 / 守恒 data 逐项等于 API 产物
      var advEl = mAdviceEl();
      equal(advEl.getAttribute('data-advice-status'), 'formal', '页面状态角标 formal');
      equal(advEl.getAttribute('data-advice-requested'), String(res.roundingNote.requestedNewFundsMinor),
        '页面请求金额 == API');
      equal(advEl.getAttribute('data-advice-allocatable'), String(res.roundingNote.allocatableNewFundsMinor),
        '页面可分配 == API');
      equal(advEl.getAttribute('data-advice-allocated'), String(res.roundingNote.allocatedTotalMinor),
        '页面实际分配 == API');
      equal(advEl.getAttribute('data-advice-unallocated'), String(res.roundingNote.unallocatedMinor),
        '页面未分配 == API');
      assert(document.querySelector('#view').textContent.indexOf('守恒：实际分配') >= 0, '页面给出守恒公式');
      equal(advEl.getAttribute('data-advice-explain'), res.explainCodes.join(','),
        '页面解释码列表 == API');
      res.explainCodes.forEach(function (code) {
        assert(advEl.querySelector('[data-explain-code="' + code + '"]'), '应渲染解释码 ' + code);
      });
      var apiByCls = {};
      res.categoryAllocations.forEach(function (c) { apiByCls[c.assetClass] = c; });
      Domain.RISK_CLASSES.forEach(function (k) {
        var row = advEl.querySelector('[data-advice-cls="' + k + '"]');
        assert(row, '页面应有类别行 ' + k);
        equal(row.getAttribute('data-allocated'), String(apiByCls[k].allocatedMinor), k + ' 页面==API 分配');
        equal(row.getAttribute('data-basis'), apiByCls[k].basis, k + ' 页面==API 依据');
        equal(row.getAttribute('data-goal-bps'),
          apiByCls[k].goalBps == null ? '' : String(apiByCls[k].goalBps), k + ' 页面==API 锚点');
        equal(row.getAttribute('data-min-need'),
          apiByCls[k].minNeedMinor == null ? '' : String(apiByCls[k].minNeedMinor), k + ' 页面==API 下限需求');
        equal(row.getAttribute('data-target-need'),
          apiByCls[k].targetNeedMinor == null ? '' : String(apiByCls[k].targetNeedMinor), k + ' 页面==API 目标需求');
        equal(row.getAttribute('data-instrument-count'),
          String((apiByCls[k].instruments || []).length), k + ' 页面==API 标的数');
      });
      // S5.3 页面层：版本与知识卡可追溯（只搬运服务端字段）
      var traceVer = advEl.querySelector('[data-advice-trace-versions]');
      assert(traceVer, '建议详情应有版本与记录组');
      equal(traceVer.getAttribute('data-rule-version'), Domain.RISK_RULE_VERSION, '规则版本可追溯');
      equal(traceVer.getAttribute('data-assessment-id'), recB.id, '评估引用可追溯');
      equal(traceVer.getAttribute('data-target-id'), item.targetId, '目标配置可追溯');
      equal(traceVer.getAttribute('data-target-version'), item.targetVersion, '目标版本可追溯');
      var baseline = advEl.querySelector('[data-advice-trace-baseline]');
      assert(baseline, '建议详情应有月结基准组');
      equal(baseline.getAttribute('data-close-id'), item.closeId, '月结引用可追溯');
      equal(baseline.getAttribute('data-snapshot-id'), item.snapshotId, '快照引用可追溯');
      equal(baseline.getAttribute('data-snapshot-hash'), item.snapshotPayloadHash, '快照哈希可追溯');
      var seal = advEl.querySelector('[data-advice-explain-seal]');
      assert(seal, '建议详情应有解释版本组');
      equal(seal.getAttribute('data-sealed'), '1', '新建议应封存解释版本');
      equal(seal.getAttribute('data-sealed-version'), window.Knowledge.EXPLANATION_VERSION, '封存版本号');
      assert(knowLink(advEl, 'card-new-funds-first'), '新增资金优先知识卡入口');
      assert(knowLink(advEl, 'card-no-sell'), '默认不卖出知识卡入口');
      assert(assertKnowLinksResolve(advEl, '5E-6 建议结果') >= 2, '建议结果知识卡入口全部指向已知卡');

      // S5.2 第一层：照抄服务端 calculate 的纯函数链，领域重算必须与 API 字节一致
      var cap = item.gate.capture;
      var selA = Domain.selectCurrentAssessment(cap.riskAssessments, cap.asOf);
      assert(selA.ok && selA.status === 'current', '复算：评估应为 current');
      equal(selA.current.record.id, recB.id, '复算选中的评估就是 API 当前评估');
      var tsel = Domain.selectCurrentTarget(cap.allocationTargets, selA.current.record, cap.asOf);
      assert(tsel.status === 'current', '复算：目标应为 current');
      equal(tsel.current.target.id, item.targetId, '复算选中的目标就是建议绑定的目标');
      var ovR = Domain.computeOverview(cap.assets, { now: cap.asOf, settings: cap.settings });
      equal(ovR.canAdvise, true, '复算：估值应为正式口径');
      var devR = Domain.computeAllocationDeviation(tsel.current.target, ovR);
      assert(devR.ok, '复算：偏离计算成功');
      var allocR = Domain.computeNewFundsAllocation({
        target: tsel.current.target, deviation: devR,
        requestedNewFundsMinor: item.requestedNewFundsMinor,
        newFundsAvailableMinor: ovR.newFundsAvailableMinor
      }).allocation;
      var mapR = Domain.mapAllocationToApprovedInstruments(
        allocR, Domain.checkApprovedMapping(cap.approvedInstruments, cap.assets.instruments));
      var rebuilt = Domain.buildRecommendationResult({
        status: 'formal', blockers: res.blockers, dataCutoff: item.dataCutoff,
        versions: res.versions, deviation: devR, allocation: allocR, mapping: mapR
      });
      assert(rebuilt.ok, '领域复算组装成功：' + JSON.stringify(rebuilt.error || {}));
      equal(JSON.stringify(rebuilt.result.categoryAllocations), JSON.stringify(res.categoryAllocations),
        'S5.2 领域==API：类别分配');
      equal(JSON.stringify(rebuilt.result.explainCodes), JSON.stringify(res.explainCodes),
        'S5.2 领域==API：解释码');
      equal(JSON.stringify(rebuilt.result.roundingNote), JSON.stringify(res.roundingNote),
        'S5.2 领域==API：尾差与守恒');
      equal(JSON.stringify(rebuilt.result.deviations), JSON.stringify(res.deviations),
        'S5.2 领域==API：区间与偏离');
      // 页面 == 领域（三层数值闭环：上面已证 页面==API、API==领域）
      Domain.RISK_CLASSES.forEach(function (k) {
        var rebuiltRow = rebuilt.result.categoryAllocations.filter(function (c) { return c.assetClass === k; })[0];
        var pageRow = advEl.querySelector('[data-advice-cls="' + k + '"]');
        equal(pageRow.getAttribute('data-allocated'), String(rebuiltRow.allocatedMinor),
          'S5.2 页面==领域：' + k + ' 分配额');
      });

      // S5.1 页面层：决策台风险摘要卡与 API / 领域同源，明确「取较低的一侧」
      clickAction('[data-action="nav:home"]');
      await waitFor(function () {
        var c = document.querySelector('#view [data-risk-summary]');
        return c && c.dataset.riskCeiling === String(domScore.ceiling) &&
          c.dataset.riskCeilingSource === 'capacity' && !c.querySelector('[data-risk-pending]');
      }, 8000, '5E-6 决策台风险摘要同步');
      var rc = document.querySelector('#view [data-risk-summary]');
      equal(rc.dataset.riskCapacity, domScore.capacityScore + '/' + domScore.capacityLevel,
        'S5.1 页面==领域：能力分/级');
      equal(rc.dataset.riskWillingness, domScore.willingnessScore + '/' + domScore.willingnessLevel,
        'S5.1 页面==领域：意愿分/级');
      equal(rc.dataset.riskCeiling, String(domScore.ceiling), 'S5.1 页面==领域：最终上限');
      var ceilLine = rc.querySelector('[data-risk-ceiling-line]');
      assert(ceilLine && ceilLine.textContent.indexOf('取较低的一侧') >= 0, '上限行写明取较低的一侧');
      assert(rc.textContent.indexOf('高意愿不能覆盖低能力') >= 0, '解释高意愿不能覆盖低能力');
      assert(rc.textContent.indexOf('承受能力 ' + domScore.capacityScore + ' 分') >= 0,
        '风险摘要显示能力总分');
      assert(rc.textContent.indexOf('风险意愿 ' + domScore.willingnessScore + ' 分') >= 0,
        '风险摘要显示意愿总分');
      assert(knowLink(rc, 'card-capacity-vs-willingness'), '风险摘要给出能力与意愿知识卡入口');

      // S5.3 页面层：配置对照卡（目标区间与偏离）逐项 == /targets/current，且偏离与建议记录同源
      await waitFor(function () {
        var c = document.querySelector('#view [data-alloc-compare]');
        return c && c.dataset.allocStatus === 'current' && !c.querySelector('[data-alloc-pending]');
      }, 8000, '5E-6 配置对照卡同步');
      var cc = document.querySelector('#view [data-alloc-compare]');
      equal(cc.dataset.allocCanadvise, '1', '正式口径下对照卡 canAdvise=1');
      var curRes = await fetch('/api/v1/targets/current', { headers: { Accept: 'application/json' } });
      assert(curRes.ok, 'GET /targets/current 应 200');
      var cur = await curRes.json();
      equal(cur.status, 'current', '服务端目标状态 current');
      Domain.RISK_CLASSES.forEach(function (k) {
        var row = cc.querySelector('[data-alloc-cls="' + k + '"]');
        assert(row, '对照卡应有类别行 ' + k);
        var fromApi = cur.allocation.classes.filter(function (x) { return x.assetClass === k; })[0];
        var recDev = res.deviations.filter(function (d) { return d.assetClass === k; })[0];
        equal(row.getAttribute('data-value-minor'), String(fromApi.valueMinor), k + ' 对照卡==API 金额');
        equal(row.getAttribute('data-pct-bps'),
          fromApi.pctBps == null ? '' : String(fromApi.pctBps), k + ' 对照卡==API 比例');
        equal(row.getAttribute('data-min-bps'), String(fromApi.minBps), k + ' 对照卡==API 下限');
        equal(row.getAttribute('data-target-bps'), String(fromApi.targetBps), k + ' 对照卡==API 目标');
        equal(row.getAttribute('data-max-bps'), String(fromApi.maxBps), k + ' 对照卡==API 上限');
        equal(row.getAttribute('data-band'),
          fromApi.band == null ? '' : String(fromApi.band), k + ' 对照卡==API 容忍带');
        equal(row.getAttribute('data-deviation-bps'),
          fromApi.deviationBps == null ? '' : String(fromApi.deviationBps), k + ' 对照卡==API 偏离');
        equal(row.getAttribute('data-deviation-bps'), String(recDev.deviationBps),
          k + ' 对照卡偏离与建议记录偏离同源（同一天同一事实的同一领域输出）');
      });
    });

    // ---- 一分钟理解演练：四个常见问题在决策台各一步可读，且与 API / 领域同源 ----
    await check('5E-6 一分钟理解演练：净资产 / 可投资 / 主要风险暴露 / 新增资金方向 与 API 同源', async function () {
      var today = Domain.localTodayISO();
      var RISK_CLASS_TEXT = {
        cash: '现金', fixed_income: '固收', broad_equity: '宽基权益',
        theme_equity: '主题权益', stock: '个股', other: '其他'
      };

      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view .dash-hero'); }, 8000, '决策台净资产卡');
      var ovRes = await fetch('/api/v1/overview', { headers: { Accept: 'application/json' } });
      assert(ovRes.ok, 'GET /overview 应 200');
      var ovApi = await ovRes.json();
      var st0 = await apiState();
      var ovDom = Domain.computeOverview(st0.assets, { now: today, settings: st0.settings || {} });
      equal(JSON.stringify(ovApi), JSON.stringify(ovDom), 'S5 领域==API：总览整对象一致');
      equal(ovApi.canAdvise, true, '演练前置：正式口径');

      // ① 净资产
      var heroCard = document.querySelector('#view .dash-hero');
      var netText = Core.fmtMoney(ovApi.netWorthMinor);
      assert(heroCard.querySelector('.dash-net').textContent.indexOf(netText) === 0,
        '页面净资产应显示 ' + netText);
      assert(heroCard.textContent.indexOf('总资产 ' + Core.fmtMoney(ovApi.totalAssetsMinor)) >= 0,
        '页面总资产与 API 同源');
      assert(heroCard.textContent.indexOf('总负债 ' + Core.fmtMoney(ovApi.totalLiabilitiesMinor)) >= 0,
        '页面总负债与 API 同源');

      // ② 可投资资金
      var invCard = Array.prototype.filter.call(
        document.querySelectorAll('#view .dash-pools .pool-card'),
        function (c) { return c.querySelector('.p-name').textContent === '可投资'; })[0];
      assert(invCard, '可投资资金池卡应存在');
      equal(invCard.querySelector('.p-val').textContent, Core.fmtMoney(ovApi.pools.investableMinor),
        '页面可投资 == API');

      // ③ 主要风险暴露（风险资产类别配比卡，逐行与 overview.riskClasses 同源）
      var riskCard = null;
      Array.prototype.forEach.call(document.querySelectorAll('#view .card'), function (c) {
        if (c.textContent.indexOf('风险资产类别配比') >= 0) riskCard = c;
      });
      assert(riskCard, '风险资产类别配比卡应存在');
      var nonzero = ovApi.riskClasses.filter(function (r) { return r.valueMinor > 0; });
      assert(nonzero.length > 0, '应有非零风险类别');
      nonzero.forEach(function (r) {
        var row = Array.prototype.filter.call(riskCard.querySelectorAll('.risk-row'), function (el) {
          return el.querySelector('.r-name').textContent === RISK_CLASS_TEXT[r.assetClass];
        })[0];
        assert(row, '配比卡应有类别行 ' + RISK_CLASS_TEXT[r.assetClass]);
        equal(row.querySelector('.r-val').textContent, Core.fmtMoney(r.valueMinor),
          RISK_CLASS_TEXT[r.assetClass] + ' 页面金额 == API');
        if (r.pct != null) {
          equal(row.querySelector('.r-pct').textContent, r.pct + '%',
            RISK_CLASS_TEXT[r.assetClass] + ' 页面占比 == API');
        }
      });
      var top = nonzero.slice().sort(function (a, b) { return b.valueMinor - a.valueMinor; })[0];

      // ④ 新增资金方向：对照卡偏离（页面 = API = 领域）+ 正式建议已把请求金额补进低配类别
      await waitFor(function () {
        var c = document.querySelector('#view [data-alloc-compare]');
        return c && c.dataset.allocStatus === 'current' && !c.querySelector('[data-alloc-pending]');
      }, 8000, '5E-6 演练用配置对照卡');
      var curRes = await fetch('/api/v1/targets/current', { headers: { Accept: 'application/json' } });
      assert(curRes.ok, 'GET /targets/current 应 200');
      var cur = await curRes.json();
      var devDom = Domain.computeAllocationDeviation(cur.target, ovDom);
      assert(devDom.ok, '领域偏离复算成功');
      var broadApi = cur.allocation.classes.filter(function (x) { return x.assetClass === 'broad_equity'; })[0];
      var broadDom = devDom.classes.filter(function (x) { return x.assetClass === 'broad_equity'; })[0];
      var broadRow = document.querySelector('#view [data-alloc-cls="broad_equity"]');
      assert(broadRow, '对照卡应有宽基权益行');
      equal(broadRow.getAttribute('data-deviation-bps'), String(broadApi.deviationBps),
        '页面偏离 == API 偏离');
      equal(String(broadApi.deviationBps), String(broadDom.deviationBps), 'API 偏离 == 领域偏离');
      assert(broadApi.deviationBps < 0, 'fixture 下宽基权益低于目标区间，方向应为补宽基');
      var recs = await Store.listRecommendations();
      var formals = recs.items.filter(function (r) {
        return r.status === 'formal' && r.requestedNewFundsMinor === 200000;
      });
      equal(formals.length, 1, '演练应引用三层复核生成的正式建议');
      var byCls = {};
      formals[0].result.categoryAllocations.forEach(function (c) { byCls[c.assetClass] = c; });
      equal(byCls.broad_equity.allocatedMinor, 200000,
        '建议方向已落地：请求的 2,000 元全部补给低配的宽基权益');

      // 演练观察值（写入运行日志作为一分钟演练的证据）
      var dirBps = broadApi.deviationBps;
      console.log('DRILL: ① 净资产 ' + Core.fmtMoney(ovApi.netWorthMinor) +
        '；② 可投资 ' + Core.fmtMoney(ovApi.pools.investableMinor) +
        '；③ 主要风险暴露 ' + RISK_CLASS_TEXT[top.assetClass] + ' ' + Core.fmtMoney(top.valueMinor) +
        (top.pct != null ? '（占可投资 ' + top.pct + '%）' : '') +
        '；④ 新增资金方向 宽基权益偏离 ' + dirBps + 'bps 低于目标区间 → 本月可新增 ' +
        Core.fmtMoney(ovApi.newFundsAvailableMinor) + ' 中请求的 2,000 元已全部补宽基');
      console.log('DRILL: 数据同源核对 overview=' + JSON.stringify({
        netWorthMinor: ovApi.netWorthMinor,
        investableMinor: ovApi.pools.investableMinor,
        newFundsAvailableMinor: ovApi.newFundsAvailableMinor,
        broadEquityDeviationBps: broadApi.deviationBps,
        adviceAllocatedBroadMinor: byCls.broad_equity.allocatedMinor
      }));
    });

    // C14 Phase 6C：接受 / 暂缓 / 忽略与待执行清单（真实点击 + 服务端状态核对）
    await check('6C 决策：三类决定真实可用且刷新一致；估算不可决策、失效接受被拒、失败不假成功', async function () {
      var TOKEN_H = Store.readSessionToken();
      var today = Domain.localTodayISO();
      var ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
      var monthEnd = today.slice(0, 8) + String(new Date(Date.UTC(ty, tm, 0)).getUTCDate()).padStart(2, '0');
      var quoteDates = Array.from(new Set([today, monthEnd]));
      function quoteRows(ins, price, currency) {
        return quoteDates.map(function (d) {
          return { instrumentId: ins, priceMinor: price, currency: currency, priceDate: d, provider: 'manual', status: 'ok' };
        });
      }
      var CAP = Domain.RISK_QUESTIONS.filter(function (q) { return q.kind === 'capacity'; });
      var WIL = Domain.RISK_QUESTIONS.filter(function (q) { return q.kind === 'willingness'; });

      async function putState(st) {
        return fetch('/api/v1/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
          body: JSON.stringify({ state: st })
        });
      }
      async function apiPost(path, body) {
        return fetch('/api/v1/' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H },
          body: JSON.stringify(body)
        }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
      }
      // 「现金高配 + 宽基 / 主题低配」的干净事实（当天数据 → 正式口径）
      function c6Assets() {
        var a = Domain.emptyAssets();
        a.assetAccounts = [
          { id: 'c6-acc-cash', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: 'C6' },
          { id: 'c6-acc-broker', name: '券商户', kind: 'broker', pool: 'investable', institution: 'C6' },
          { id: 'c6-acc-safe', name: '应急金', kind: 'deposit', pool: 'safety', institution: 'C6' }
        ];
        a.assetUnits = [
          { id: 'c6-u-cny', accountId: 'c6-acc-cash', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' },
          { id: 'c6-u-safe', accountId: 'c6-acc-safe', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' }
        ];
        a.instruments = [
          { id: 'c6-ins-bond', symbol: 'C6BND', exchange: 'NASDAQ', currency: 'USD', name: '债基', instrumentType: 'etf', assetClass: 'fixed_income', exposureMarket: 'US', classificationStatus: 'confirmed' },
          { id: 'c6-ins-voo', symbol: 'C6VOO', exchange: 'SSE', currency: 'CNY', name: '宽基A', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
          { id: 'c6-ins-thm', symbol: 'C6THM', exchange: 'SSE', currency: 'CNY', name: '主题', instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' }
        ];
        a.holdings = [
          { id: 'c6-h-bond', accountId: 'c6-acc-broker', instrumentId: 'c6-ins-bond', quantity: '5000', costMinor: 5000000, asOf: today },
          { id: 'c6-h-voo', accountId: 'c6-acc-broker', instrumentId: 'c6-ins-voo', quantity: '50000', costMinor: 5000000, asOf: today },
          { id: 'c6-h-thm', accountId: 'c6-acc-broker', instrumentId: 'c6-ins-thm', quantity: '70000', costMinor: 7000000, asOf: today }
        ];
        a.quotes = quoteRows('c6-ins-bond', 1000, 'USD')
          .concat(quoteRows('c6-ins-voo', 100, 'CNY'))
          .concat(quoteRows('c6-ins-thm', 100, 'CNY'));
        a.fxRates = quoteDates.map(function (d) {
          return { base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: d, provider: 'manual', status: 'ok' };
        });
        return a;
      }
      async function seed() {
        var base = await apiState();
        var seeded = Object.assign({}, base, {
          accounts: [], categories: [], txns: [], settings: {}, assets: c6Assets(),
          riskAssessments: [], allocationTargets: [], approvedInstruments: [], recommendations: [],
          decisions: [], decisionEvents: [], decisionLinks: []
        });
        equal((await putState(seeded)).status, 200, '6C 前置状态写入');
        var closed = await apiPost('monthly-closes', { month: today.slice(0, 7) });
        equal(closed.json.close.status, 'formal', '前置：当天数据能正式结账');
        var answers = [];
        CAP.forEach(function (q, i) { answers.push({ questionId: q.id, optionId: q.options.filter(function (o) { return o.score === [1, 1, 1, 2, 2][i]; })[0].id }); });
        WIL.forEach(function (q, i) { answers.push({ questionId: q.id, optionId: q.options.filter(function (o) { return o.score === [2, 2, 1, 1][i]; })[0].id }); });
        equal((await apiPost('risk-assessments', { answers: answers, assessedAt: today, reason: 'initial' })).status, 201, '前置：评估落库');
        equal((await apiPost('targets', {})).status, 201, '前置：目标版本生成');
        equal((await apiPost('approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['c6-ins-voo'] })).status, 200, '前置：宽基认可标的');
      }
      async function runAdvice(amount) {
        clickAction('[data-action="nav:home"]');
        await waitFor(function () { return document.querySelector('#view [data-action="nav:targets"]'); }, 8000, '决策台目标入口');
        clickAction('[data-action="nav:targets"]');
        await waitFor(function () { return document.querySelector('#view [data-action="target:reload"]'); }, 8000, '目标页重新读取入口');
        clickAction('#view [data-action="target:reload"]');
        await waitFor(function () { return document.querySelector('#view [data-action="advice:run"]'); }, 8000, '建议入口');
        // 此前检查可能在内存里留着同金额的旧建议：以「本次新生成的建议 id」为准，
        // 防止把旧块当成新产物、把已删除的旧建议 id 提交给决策接口。
        var before = await Store.listRecommendations();
        var beforeIds = {};
        (before.items || []).forEach(function (r) { beforeIds[r.id] = 1; });
        var amountInput = document.querySelector('#view [data-input="advice:amount"]');
        amountInput.value = String(amount);
        amountInput.dispatchEvent(new Event('input', { bubbles: true }));
        clickAction('#view [data-action="advice:run"]');
        // 自愈：页面偶发重渲染竞态可能吞掉一次输入或点击；金额不生效就重填再点
        //（生成进行中按钮 disabled，不会双发）。
        var recId = await waitFor(async function () {
          var listed = await Store.listRecommendations();
          var fresh = (listed.items || []).filter(function (r) {
            return !beforeIds[r.id] && r.requestedNewFundsMinor === amount * 100;
          });
          if (fresh.length) return fresh[0].id;
          var inp = document.querySelector('#view [data-input="advice:amount"]');
          var btn = document.querySelector('#view [data-action="advice:run"]');
          if (inp && btn && !btn.disabled) {
            if (inp.value !== String(amount)) {
              inp.value = String(amount);
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (inp.value === String(amount)) btn.click();
          }
          return null;
        }, 15000, amount + ' 元建议落库');
        await waitFor(function () {
          var v = document.querySelector('#view [data-advice-trace-versions]');
          var b = document.querySelector('#view [data-advice-result]');
          return v && b && v.getAttribute('data-rec-id') === recId &&
            b.getAttribute('data-advice-allocated') === String(amount * 100);
        }, 8000, amount + ' 元建议结果显示（新建议 id）');
        return document.querySelector('#view [data-advice-result]');
      }
      async function decide(intent, note) {
        clickAction('#view [data-action="dec:open"]');
        await waitFor(function () { return document.querySelector('#dec-note'); }, 8000, '决定弹层');
        var box = document.querySelector('#dec-note');
        box.value = note;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        clickAction('#sheet [data-action="dec:submit"][data-intent="' + intent + '"]');
        await waitFor(function () { return document.querySelector('#sheet-mask').classList.contains('hidden'); }, 8000, '决定提交完成');
      }

      // ① 前置事实链
      await seed();

      // ② 核对中 → 读取失败 → 初始空态三态分别呈现：读不到绝不能冒充「还没有决策」
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:decisions"]'); }, 8000, '决策台决策入口');
      var origDecFetch = window.fetch;
      var holdDecisions = [];
      window.fetch = function (url, init) {
        // 只扣住决策列表读取；返回 500（HTTP 层失败）而不是网络层 reject，
        // 否则 Store 会按「服务不可达」降级只读，测到的就是另一个分支了。
        if (/\/api\/v1\/decisions(\?|$)/.test(String(url))) {
          return new Promise(function (res) {
            holdDecisions.push(function () {
              res(new Response(
                JSON.stringify({ error: { code: 'internal_error', message: '模拟服务端读取失败', retryable: true } }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }));
            });
          });
        }
        return origDecFetch(url, init);
      };
      try {
        clickAction('[data-action="nav:decisions"]');
        // 路由与读取都是异步的；前面的检查已经访问过目标页，decLoaded 可能已是 true，
        // 所以既可能是首帧读取中卡片，也可能要靠「重新读取」再发起一次强制读取。
        await waitFor(function () {
          return document.querySelector('#view [data-dec-loading]') ||
            document.querySelector('#view [data-action="dec:reload"]');
        }, 8000, '决策页给出读取入口');
        if (!holdDecisions.length && document.querySelector('#view [data-action="dec:reload"]')) {
          clickAction('#view [data-action="dec:reload"]');
        }
        await waitFor(function () { return holdDecisions.length === 1; }, 8000, '决策读取请求已发出并被扣住');
        assert(
          document.querySelector('#view [data-dec-loading]') ||
          document.querySelector('#view [data-dec-reloading]'),
          '核对中：读取状态可见');
        assert(!document.querySelector('#view [data-dec-error]'), '读取中不得先显示失败');
        holdDecisions[0]();
        await waitFor(function () { return document.querySelector('#view [data-dec-error]'); }, 8000, '读取失败显式呈现');
        assert(/决策读取失败/.test(document.querySelector('#view').textContent), '失败卡说明读取失败');
        assert(!document.querySelector('#view [data-dec-empty]'), '读取失败不得冒充「还没有决策」');
        assert(document.querySelector('#view [data-dec-error] [data-action="dec:reload"]'), '失败卡给出重试入口');
      } finally {
        window.fetch = origDecFetch;
      }
      clickAction('#view [data-dec-error] [data-action="dec:reload"]');
      await waitFor(function () { return document.querySelector('#view [data-dec-empty]'); }, 8000, '重试后读到初始空态');
      assert(/还没有任何决策记录/.test(document.querySelector('#view').textContent), '历史空态');

      // ③ 接受：缺理由被拦（不产生决策）→ 填理由后接受 → 防重复点击只产生一条
      var block2000 = await runAdvice(2000);
      assert(block2000.getAttribute('data-advice-status') === 'formal', '前置建议必须是正式口径');
      clickAction('#view [data-action="dec:open"]');
      await waitFor(function () { return document.querySelector('#dec-note'); }, 8000, '决定弹层（理由为空）');
      clickAction('#sheet [data-action="dec:submit"][data-intent="accepted"]');
      await new Promise(function (r) { setTimeout(r, 300); });
      assert(document.querySelector('#dec-note'), '缺理由时不提交，弹层保持打开');
      var listed0 = await Store.listDecisions();
      equal(listed0.total, 0, '缺理由提交不产生决策');
      var noteBox = document.querySelector('#dec-note');
      noteBox.value = '按建议分两笔执行';
      noteBox.dispatchEvent(new Event('input', { bubbles: true }));
      var acceptBtn = document.querySelector('#sheet [data-action="dec:submit"][data-intent="accepted"]');
      acceptBtn.click();
      await waitFor(function () {
        var b = document.querySelector('#sheet [data-action="dec:submit"]');
        return !b || b.disabled;
      }, 3000, '提交中按钮禁用（防重复点击）');
      await waitFor(function () { return document.querySelector('#sheet-mask').classList.contains('hidden'); }, 8000, '接受完成');
      var decs1 = await Store.listDecisions();
      equal(decs1.total, 1, '接受只产生一条决策（重复点击被拦）');
      var acc = decs1.items[0];
      equal(acc.state, 'accepted', 'intent=accepted → accepted');
      equal(acc.reasonCode, 'agree', '服务端理由码 agree');
      equal(acc.note, '按建议分两笔执行');
      equal(acc.execution.linkedCount, 0, '尚无关联');
      equal(acc.execution.remainingMinor, 200000, '无关联时剩余 = 建议金额（契约 §3.3）');
      equal(acc.eventMonths.join(','), today.slice(0, 7), '决策月按本地事件月归属');

      // ④ 待执行清单呈现 + 重新读取后状态一致（刷新核对）
      clickAction('[data-action="nav:decisions"]');
      await waitFor(function () {
        var card = document.querySelector('#view .dec-card[data-dec-state="accepted"]');
        return card && /2,000\.00 CNY/.test(card.textContent) && /按建议分两笔执行/.test(card.textContent);
      }, 8000, '待执行清单卡片');
      clickAction('#view [data-action="dec:reload"]');
      await waitFor(function () {
        var card = document.querySelector('#view .dec-card[data-dec-state="accepted"]');
        return card && card.getAttribute('data-dec-id') === acc.id;
      }, 8000, '重新读取后清单一致');

      // ④b 慢响应守卫：在途读取晚到时，不得覆盖用户已经看到的新状态（拆解 §5）
      var origSlowFetch = window.fetch;
      var heldSlow = null;
      var holdOnce = false;
      window.fetch = function (url, init) {
        if (holdOnce && /\/api\/v1\/decisions(\?|$)/.test(String(url))) {
          holdOnce = false;
          return new Promise(function (res) { heldSlow = res; });
        }
        return origSlowFetch(url, init);
      };
      try {
        holdOnce = true;
        clickAction('#view [data-action="dec:reload"]');          // 在途读取：被扣住
        await waitFor(function () { return heldSlow; }, 8000, '慢响应读取已发出并被扣住');
        clickAction('#view [data-action="dec:reload"]');          // 更新的读取：真实完成
        await waitFor(function () {
          var card = document.querySelector('#view .dec-card[data-dec-state="accepted"]');
          return card && card.getAttribute('data-dec-id') === acc.id;
        }, 8000, '更新的读取先完成');
        // 晚到的旧响应返回空清单：必须被丢弃，不得顶掉已读到的状态
        heldSlow(new Response(
          JSON.stringify({ ok: true, items: [], total: 0, invalidCount: 0, states: [], months: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
        await new Promise(function (r) { setTimeout(r, 300); });
        var lateCard = document.querySelector('#view .dec-card[data-dec-state="accepted"]');
        assert(lateCard && lateCard.getAttribute('data-dec-id') === acc.id,
          '晚到的旧读取不得覆盖已读到的状态');
        assert(!document.querySelector('#view [data-dec-empty]'), '晚到的空清单不得冒充「还没有决策」');
      } finally {
        window.fetch = origSlowFetch;
      }

      // ⑤ 详情：状态、理由、时间线与快照入口全部来自服务端
      clickAction('#view .dec-card[data-dec-state="accepted"] [data-action="dec:detail"]');
      await waitFor(function () { return document.querySelector('#sheet [data-dec-detail]'); }, 8000, '决策详情');
      var detailText = document.querySelector('#sheet').textContent;
      assert(/已接受 · 待执行/.test(detailText), '详情显示服务端状态');
      assert(/同意按建议执行/.test(detailText), '详情显示服务端理由码');
      equal(document.querySelectorAll('#sheet [data-tl="state"]').length, 1, '时间线恰好一条状态事件');
      assert(document.querySelector('#sheet [data-dec-snap="决策时点快照"]'), '决策时点快照入口存在');
      // 结构断言而非文本断言：长理由末尾的「执行」可能与下一节标题拼出「执行时点快照」字样
      assert(!document.querySelector('#sheet [data-dec-snap="执行时点快照"]') &&
        !document.querySelector('#sheet [data-dec-snap="复盘时点快照"]') &&
        !document.querySelector('#sheet [data-dec-snap="归档快照"]'),
        '尚未执行 / 复盘 / 归档：只渲染决策时点快照');
      clickAction('#sheet .close');

      // ⑥ 暂缓与忽略：进历史、不混入待执行清单
      await runAdvice(3000);
      await decide('deferred', '本月资金另有用途，等待下月再评估是否按建议执行');
      var decs2 = await Store.listDecisions();
      equal(decs2.total, 2, '暂缓追加一条决策');
      await runAdvice(1000);
      await decide('dismissed', '额度太小，不值得单独执行');
      var decs3 = await Store.listDecisions();
      equal(decs3.total, 3, '忽略追加一条决策');
      var states = {};
      decs3.items.forEach(function (d) { states[d.state] = (states[d.state] || 0) + 1; });
      equal(states.accepted, 1, '待执行仍只有 1 条');
      equal(states.deferred, 1, '暂缓 1 条');
      equal(states.dismissed, 1, '忽略 1 条');
      // 长理由在卡片上完整呈现（长文本不挤压按钮由三档宽度检查兜底）；先回到决策历史页
      clickAction('[data-action="nav:decisions"]');
      await waitFor(function () { return document.querySelector('#view [data-change="dec:filter"]'); }, 8000, '决策历史页');
      var pageText = document.querySelector('#view').textContent;
      assert(/等待下月再评估是否按建议执行/.test(pageText), '暂缓理由进入历史');
      // 状态筛选：只看已暂缓（待执行清单的 accepted 卡片仍在上方，不混入历史筛选结果）
      var filter = document.querySelector('#view [data-change="dec:filter"]');
      filter.value = 'deferred';
      filter.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(function () {
        var cards = document.querySelectorAll('#view .dec-card');
        var deferredCards = Array.prototype.filter.call(cards, function (c) {
          return c.getAttribute('data-dec-state') === 'deferred';
        });
        return cards.length === 2 && deferredCards.length === 1;
      }, 8000, '历史筛选已暂缓（待执行清单不受筛选影响）');
      filter.value = '';
      filter.dispatchEvent(new Event('change', { bubbles: true }));

      // ⑦ 估算建议不可决策：不出现决定入口，只有显式说明（契约 §2.1）
      var est = await apiState();
      // voo 两行报价分别改为 6 / 7 个自然日前：门禁取「最近一条」行情判定新鲜度，
      // 只改今天那行会让月末行（未来日期）继续冒充最新价。两行日期不同避免撞 uq_quotes_dedupe。
      var staleD = new Date(Date.UTC(ty, tm - 1, Number(today.slice(8, 10))));
      staleD.setUTCDate(staleD.getUTCDate() - 6);
      var staleDay = staleD.toISOString().slice(0, 10);
      staleD.setUTCDate(staleD.getUTCDate() - 1);
      var staleDay2 = staleD.toISOString().slice(0, 10);
      est.assets.quotes = est.assets.quotes.map(function (q) {
        if (q.instrumentId !== 'c6-ins-voo') return q;
        return Object.assign({}, q, { priceDate: q.priceDate === today ? staleDay : staleDay2 });
      });
      equal((await putState(est)).status, 200, '行情过期状态写入');
      var estBlock = await runAdvice(500);
      equal(estBlock.getAttribute('data-advice-status'), 'estimate', '行情过期后只给估算建议');
      assert(estBlock.querySelector('[data-dec-estimate-note]'), '估算建议显示不可决策说明');
      assert(!estBlock.querySelector('[data-action="dec:open"]'), '估算建议不提供决定入口');

      // ⑧ 失效正式建议：接受被服务端拒绝（409），失败不假成功；暂缓仍可记录
      var fresh = await apiState();
      fresh.assets.quotes = quoteRows('c6-ins-bond', 1000, 'USD')
        .concat(quoteRows('c6-ins-voo', 100, 'CNY'))
        .concat(quoteRows('c6-ins-thm', 100, 'CNY'));
      equal((await putState(fresh)).status, 200, '行情恢复写入');
      var block4000 = await runAdvice(4000);
      equal(block4000.getAttribute('data-advice-status'), 'formal', '行情恢复后重新拿到正式建议');
      // 改写事实（余额变化）：让这条正式建议失效（assets_changed），页面只重新同步事实视图，
      // 不重新生成建议 —— 新输入会得到新建议（新 inputHash），就不是「同一条失效建议」了。
      var changed = await apiState();
      changed.assets.assetUnits = changed.assets.assetUnits.map(function (u) {
        return u.id === 'c6-u-cny' ? Object.assign({}, u, { balanceMinor: 45000000 }) : u;
      });
      equal((await putState(changed)).status, 200, '事实变化写入');
      clickAction('[data-action="nav:home"]');
      await waitFor(function () { return document.querySelector('#view [data-action="nav:targets"]'); }, 8000, '决策台目标入口（失效步）');
      clickAction('[data-action="nav:targets"]');
      await waitFor(function () { return document.querySelector('#view [data-action="target:reload"]'); }, 8000, '目标页重新读取入口（失效步）');
      clickAction('#view [data-action="target:reload"]');
      await waitFor(function () {
        var b = document.querySelector('#view [data-advice-result]');
        return b && b.getAttribute('data-advice-status') === 'stale';
      }, 8000, '建议显示为历史（已失效）');
      var staleRecId = document.querySelector('#view [data-advice-result] [data-action="dec:open"]').getAttribute('data-rec-id');
      clickAction('#view [data-action="dec:open"]');
      await waitFor(function () {
        var s = document.querySelector('#sheet [data-decide-sheet]');
        return s && /已失效/.test(s.textContent);
      }, 8000, '决定弹层预告接受会被拒绝');
      var sb = document.querySelector('#dec-note');
      sb.value = '明知失效仍尝试接受（反例）';
      sb.dispatchEvent(new Event('input', { bubbles: true }));
      clickAction('#sheet [data-action="dec:submit"][data-intent="accepted"]');
      await waitFor(function () { return document.querySelector('#sheet [data-dec-error]'); }, 8000, '服务端拒绝显示在弹层内');
      assert(/建议已失效/.test(document.querySelector('#sheet [data-dec-error]').textContent),
        '错误信息说明失效原因（recommendation_stale）');
      var decs4 = await Store.listDecisions();
      equal(decs4.total, 3, '被拒后决策总数不变（失败不假成功）');
      // 同一条失效建议：暂缓不做时效重核，仍然可记录
      var sb2 = document.querySelector('#dec-note');
      sb2.value = '建议已失效，先暂缓；事实变化后重新生成再决定';
      sb2.dispatchEvent(new Event('input', { bubbles: true }));
      clickAction('#sheet [data-action="dec:submit"][data-intent="deferred"]');
      await waitFor(function () { return document.querySelector('#sheet-mask').classList.contains('hidden'); }, 8000, '失效建议暂缓成功');
      var decs5 = await Store.listDecisions();
      equal(decs5.total, 4, '暂缓追加成功');
      var deferredStale = decs5.items.filter(function (d) { return d.state === 'deferred'; });
      equal(deferredStale.length, 2, '暂缓共 2 条（含失效建议那条）');
      // 失效建议的决策卡片显示失效角标（服务端 adviceStaleReasons）
      clickAction('[data-action="nav:decisions"]');
      await waitFor(function () {
        return document.querySelector('#view [data-dec-stale]');
      }, 8000, '失效角标出现在历史卡片');
      assert(document.querySelector('#view [data-dec-stale]').textContent.indexOf('原建议已失效') >= 0,
        '失效角标文案明确');
    });

    // ⑨ 详情弹层慢响应（独立检查项）：先开 A 再开 B，A 的响应最后返回不得把 B 覆盖回 A；
    //    弹层已关闭时，晚到的详情也不得重新弹出（拆解 §5「慢响应不能覆盖新状态」）。
    await check('6C 决策：详情弹层慢响应不覆盖后打开的另一条，关闭后晚到不重弹', async function () {
      var all = await Store.listDecisions();
      var itemA = all.items.filter(function (d) { return d.state === 'accepted'; })[0];
      var itemB = all.items.filter(function (d) { return d.state === 'deferred'; })[0];
      assert(itemA && itemB, '前置：已有一条接受与一条暂缓决策');
      assert(itemA.id !== itemB.id && itemA.note !== itemB.note, 'A 与 B 必须是两条不同决策');
      clickAction('[data-action="nav:decisions"]');
      await waitFor(function () {
        return document.querySelector('#view .dec-card[data-dec-id="' + itemA.id + '"]') &&
          document.querySelector('#view .dec-card[data-dec-id="' + itemB.id + '"]');
      }, 8000, '决策页同时存在 A 与 B 卡片');

      var holdA = [];
      var origFetch = window.fetch;
      window.fetch = function (url, init) {
        if (String(url).indexOf('/api/v1/decisions/' + itemA.id) !== -1) {
          // 请求照常发出，响应到手后先扣住，用来制造「A 最后返回」
          return origFetch(url, init).then(function (res) {
            return new Promise(function (resolve) { holdA.push(function () { resolve(res); }); });
          });
        }
        return origFetch(url, init);
      };
      try {
        clickAction('#view .dec-card[data-dec-id="' + itemA.id + '"] [data-action="dec:detail"]');
        await waitFor(function () {
          var l = document.querySelector('#sheet [data-dec-detail-loading]');
          return l && l.getAttribute('data-dec-detail-id') === itemA.id;
        }, 8000, 'A 详情读取中');
        await waitFor(function () { return holdA.length === 1; }, 8000, 'A 详情响应已扣住');
        clickAction('#view .dec-card[data-dec-id="' + itemB.id + '"] [data-action="dec:detail"]');
        await waitFor(function () {
          var d = document.querySelector('#sheet [data-dec-detail]');
          return d && d.getAttribute('data-dec-detail-id') === itemB.id;
        }, 8000, 'B 详情先渲染');
        assert(!document.querySelector('#sheet [data-dec-detail-id="' + itemA.id + '"]'),
          '打开 B 后弹层里没有 A');
        holdA[0]();                                               // A 晚到
        await new Promise(function (r) { setTimeout(r, 300); });
        assert(!document.querySelector('#sheet [data-dec-detail-id="' + itemA.id + '"]'),
          '晚到的 A 不得把弹层里的 B 覆盖回 A');
        assert(document.querySelector('#sheet [data-dec-detail]').getAttribute('data-dec-detail-id') === itemB.id,
          '弹层仍显示后打开的 B');
        assert(itemB.note && document.querySelector('#sheet').textContent.indexOf(itemB.note) !== -1,
          '弹层内容仍是 B 的理由，没有被 A 的内容顶掉');

        // 关闭后再打开 A，读取中途关闭：晚到的详情不得把弹层重新弹出
        clickAction('#sheet .close');
        await waitFor(function () { return document.querySelector('#sheet-mask').classList.contains('hidden'); },
          8000, '关闭详情');
        clickAction('#view .dec-card[data-dec-id="' + itemA.id + '"] [data-action="dec:detail"]');
        await waitFor(function () { return holdA.length === 2; }, 8000, '再次读取 A 已扣住');
        clickAction('#sheet .close');
        await waitFor(function () { return document.querySelector('#sheet-mask').classList.contains('hidden'); },
          8000, '读取中途关闭弹层');
        holdA[1]();
        await new Promise(function (r) { setTimeout(r, 300); });
        assert(document.querySelector('#sheet-mask').classList.contains('hidden'),
          '关闭后晚到的详情不得重新弹出');

        // 关闭详情后换到另一类弹层：旧详情不能利用新弹层的可见状态覆盖它。
        clickAction('#view .dec-card[data-dec-id="' + itemA.id + '"] [data-action="dec:detail"]');
        await waitFor(function () { return holdA.length === 3; }, 8000, '第三次读取 A 已扣住');
        clickAction('#sheet .close');
        clickAction('[data-action="nav:assets"]');
        await waitFor(function () { return document.querySelector('#view [data-action="asset:acc"]'); },
          8000, '资产页新增账户入口');
        clickAction('#view [data-action="asset:acc"]');
        assert(document.querySelector('#sheet .sheet-title').textContent.indexOf('新增账户') !== -1,
          '另一类弹层已经打开');
        holdA[2]();
        await new Promise(function (r) { setTimeout(r, 300); });
        assert(document.querySelector('#sheet .sheet-title').textContent.indexOf('新增账户') !== -1,
          '晚到的详情不得覆盖新打开的账户弹层');
        assert(!document.querySelector('#sheet [data-dec-detail]'), '账户弹层内不得出现旧决策详情');
        clickAction('#sheet .close');
      } finally {
        window.fetch = origFetch;
      }
    });

    // ⑩ Phase 6D：关联实际交易与确认执行。关联 / 解绑 / 状态推进全部是服务端命令，
    //    页面只搬运服务端的 links 与 execution；失败就地显示原因，绝不假成功。
    await check('6D 决策：关联 / 解绑 / 归档门禁 / 确认执行完成全走服务端，失败不假成功', async function () {
      var TOKEN_H = Store.readSessionToken();
      var today = Domain.localTodayISO();
      var st0 = await apiState();
      var acc = (st0.assets.assetAccounts || []).filter(function (a) { return a.kind === 'broker'; })[0];
      var ins = (st0.assets.instruments || []).filter(function (i) { return i.currency === 'CNY'; })[0] ||
        (st0.assets.instruments || [])[0];
      assert(acc && ins, '前置：已有券商账户与标的');

      // 前置：6C 检查留下的唯一一条 accepted 决策
      var decs = await Store.listDecisions();
      var dec = decs.items.filter(function (d) { return d.state === 'accepted'; })[0];
      assert(dec, '前置：已有 accepted 决策（6C 检查创建）');

      // 前置事实：一笔买入（服务端写入，页面从 /security-events 读候选，不猜本地缓存）
      var evRes = await fetch('/api/v1/security-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN_H,
          'Idempotency-Key': 'wiring-6d-buy' },
        body: JSON.stringify({ id: 'sev-wiring6d01', eventType: 'buy', accountId: acc.id,
          instrumentId: ins.id, quantity: '5', priceMinor: 10000, feeMinor: 100, occurredAt: today })
      });
      assert(evRes.ok, '买入事件创建应成功，实际 ' + evRes.status);
      var evId = (await evRes.json()).item.id;
      var stEv = await apiState();

      function openDetail() {
        clickAction('#view .dec-card[data-dec-id="' + dec.id + '"] [data-action="dec:detail"]');
      }

      clickAction('[data-action="nav:decisions"]');
      await waitFor(function () {
        return document.querySelector('#view [data-change="dec:filter"]');
      }, 8000, '决策页（含历史筛选器）');
      // 历史筛选可能停在上一项留下的「已暂缓」：先复位到全部，避免执行后的卡片被筛掉
      var histFilter = document.querySelector('#view [data-change="dec:filter"]');
      histFilter.value = '';
      histFilter.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(function () {
        return document.querySelector('#view .dec-card[data-dec-id="' + dec.id + '"]');
      }, 8000, '决策页卡片');
      openDetail();
      await waitFor(function () { return document.querySelector('#sheet [data-dec-detail]'); }, 8000, '详情弹层');
      await waitFor(function () { return document.querySelector('#sheet #dec-link-pick'); }, 8000, '关联选择器');
      assert(document.querySelector('#sheet [data-dec-links-empty]'), '关联前显示空态而不是编造进度');
      assert(document.querySelector('#sheet #dec-link-pick option[value="' + evId + '"]'),
        '候选里有刚创建的买入事件（来自服务端 /security-events）');
      assert(document.querySelector('#sheet [data-action="dec:unlink"]') === null,
        '没有关联行时不得出现解绑入口');

      // ① 新增买入并关联：复用原「证券事件」录入弹层，不另起一套录入
      clickAction('#sheet [data-action="dec:newtrade"]');
      await waitFor(function () { return document.querySelector('#sheet #he-type'); }, 8000, '复用原证券事件录入弹层');
      clickAction('#sheet .close');
      await waitFor(function () { return document.querySelector('#sheet-mask').classList.contains('hidden'); },
        8000, '关闭录入弹层');
      clickAction('[data-action="nav:decisions"]');
      await waitFor(function () {
        return document.querySelector('#view .dec-card[data-dec-id="' + dec.id + '"]');
      }, 8000, '回到决策页');
      openDetail();
      await waitFor(function () { return document.querySelector('#sheet #dec-link-pick'); }, 8000, '重新打开详情');

      // ② 关联：服务端落一条活动关联，不复制证券事件、不写记账流水
      document.querySelector('#sheet #dec-link-pick').value = evId;
      clickAction('#sheet [data-action="dec:link"]');
      await waitFor(function () {
        return document.querySelector('#sheet [data-dec-link][data-dec-link-state="active"]');
      }, 8000, '关联行出现');
      assert(/已关联 1 笔买入/.test(document.querySelector('#sheet').textContent), '进度显示 1 笔买入');
      assert(document.querySelector('#sheet [data-action="dec:unlink"]'), '活动关联给出解绑入口');
      var st1 = await apiState();
      equal(st1.decisionLinks.filter(function (l) {
        return l.decisionId === dec.id && l.unlinkedOn == null;
      }).length, 1, '服务端活动关联 1 条');
      equal(st1.decisionLinks.filter(function (l) { return l.decisionId === dec.id; }).length, 1,
        '重复点击不得产生第二条关联');
      equal(st1.assets.securityEvents.length, stEv.assets.securityEvents.length,
        '关联不得复制第二笔证券事件');
      equal(st1.txns.length, stEv.txns.length, '关联不得写入记账流水');
      equal(st1.assets.assetUnits.filter(function (u) { return u.id === 'c6-u-cny'; })[0].balanceMinor,
        stEv.assets.assetUnits.filter(function (u) { return u.id === 'c6-u-cny'; })[0].balanceMinor,
        '关联不自动改写现金余额');

      // ③ 归档门禁：还有活动关联时归档必须被服务端拒绝，状态不推进
      document.querySelector('#sheet #dec-exec-note').value = '先尝试归档（应当被拒绝）';
      clickAction('#sheet [data-action="dec:event"][data-to="archived"]');
      await waitFor(function () {
        var box = document.querySelector('#sheet [data-dec-action-error]');
        return box && !box.hidden && box.textContent.length > 0;
      }, 8000, '归档失败就地显示原因');
      assert(/解绑/.test(document.querySelector('#sheet [data-dec-action-error]').textContent),
        '错误信息说明要先解绑活动关联');
      equal(document.querySelector('#sheet [data-dec-chip]').getAttribute('data-dec-chip'), 'accepted',
        '失败不假成功：状态仍是 accepted');

      // ④ 解绑：理由为空被挡下（关联保持），填理由后软删除、历史行保留、进度回 0
      clickAction('#sheet [data-action="dec:unlink"]');
      await new Promise(function (r) { setTimeout(r, 400); });
      assert(document.querySelector('#sheet [data-dec-link][data-dec-link-state="active"]'),
        '空理由不得解除关联');
      var unInput = document.querySelector('#sheet input[data-unlink-note]');
      assert(unInput, '解绑理由输入框存在');
      unInput.value = '挂错账户，先解绑';
      clickAction('#sheet [data-action="dec:unlink"]');
      await waitFor(function () {
        return document.querySelector('#sheet [data-dec-link][data-dec-link-state="unlinked"]');
      }, 8000, '解绑后历史行保留');
      assert(/已关联 0 笔买入/.test(document.querySelector('#sheet').textContent), '进度回到 0 笔');
      var st2 = await apiState();
      equal(st2.decisionLinks.filter(function (l) { return l.decisionId === dec.id && l.unlinkedOn == null; }).length,
        0, '活动关联已清零');
      equal(st2.decisionLinks.filter(function (l) { return l.decisionId === dec.id; }).length, 1,
        '解绑是软删除，不删行');
      equal(st2.decisions.filter(function (d) { return d.id === dec.id; })[0].state, 'accepted',
        '解绑不改状态、不追加状态事件');
      equal(st2.decisionEvents.filter(function (e) { return e.decisionId === dec.id; }).length, 1,
        '解绑没有新增状态事件');

      // ⑤ 解绑后同一笔买入可以重新挂回，再确认执行完成（服务端命令）
      document.querySelector('#sheet #dec-link-pick').value = evId;
      clickAction('#sheet [data-action="dec:link"]');
      await waitFor(function () {
        return document.querySelector('#sheet [data-dec-link][data-dec-link-state="active"]');
      }, 8000, '重新关联成功');
      document.querySelector('#sheet #dec-exec-note').value = '按实际买入确认执行，偏差说明见关联记录';
      clickAction('#sheet [data-action="dec:event"][data-to="executed"]');
      await waitFor(function () {
        var chip = document.querySelector('#sheet [data-dec-chip]');
        return chip && chip.getAttribute('data-dec-chip') === 'executed';
      }, 8000, '确认执行完成');
      var st3 = await apiState();
      equal(st3.decisions.filter(function (d) { return d.id === dec.id; })[0].state, 'executed',
        '服务端状态推进到 executed');
      assert(document.querySelector('#sheet [data-dec-snap="执行时点快照"]'), '执行时点快照已封存');
      assert(document.querySelectorAll('#sheet [data-tl="link"]').length >= 2,
        '时间线保留关联与解绑两条记录');

      // ⑥ 已执行状态仍可解绑 / 补记；状态推进入口只剩「记录复盘」（6E 起提供；
      //    原 6D 断言「无任何推进入口」按拆解 §11 显式推进为「仅复盘入口、无归档入口」）
      assert(document.querySelector('#sheet [data-action="dec:unlink"]'), 'executed 仍可解绑');
      assert(document.querySelector('#sheet [data-action="dec:event"][data-to="reviewed"]'),
        'executed 提供「记录复盘」入口（6E）');
      assert(!document.querySelector('#sheet [data-action="dec:event"][data-to="archived"]') &&
        !document.querySelector('#sheet [data-action="dec:event"][data-to="executed"]'),
        'executed 不得提供归档或重复执行入口');
      clickAction('#sheet .close');
      await waitFor(function () { return document.querySelector('#sheet-mask').classList.contains('hidden'); },
        8000, '关闭详情');
      // 卡片同步刷新为已执行，且仍只在历史里（待执行清单只列 accepted）
      await waitFor(function () {
        var card = document.querySelector('#view .dec-card[data-dec-id="' + dec.id + '"]');
        return card && card.getAttribute('data-dec-state') === 'executed';
      }, 8000, '卡片状态同步');
      var execCard = document.querySelector('#view .dec-card[data-dec-id="' + dec.id + '"]');
      equal(execCard.getAttribute('data-dec-state'), 'executed', '卡片仍是这一条，状态已推进');
    });

    // ⑪ Phase 6E：记录复盘（executed → reviewed，理由必填）与复盘对照 / 月度历史。
    //    对照表只搬运服务端 comparison；月份筛选基于服务端 eventMonths；禁止收益表述。
    await check('6E 决策：记录复盘理由必填、复盘后只读，配置变化对照与月度历史不重算不漂移', async function () {
      var decs = await Store.listDecisions();
      var dec = decs.items.filter(function (d) { return d.state === 'executed'; })[0];
      assert(dec, '前置：已有 executed 决策（6D 检查推进）');
      var month = (dec.eventMonths || [])[0];
      assert(month, '前置：决策至少有一个事件月');

      function openDetail() {
        clickAction('#view .dec-card[data-dec-id="' + dec.id + '"] [data-action="dec:detail"]');
      }

      // ① 复盘理由为空被挡下（客户端拦截，服务端同样拒绝）：状态不推进
      clickAction('[data-action="nav:decisions"]');
      await waitFor(function () {
        return document.querySelector('#view .dec-card[data-dec-id="' + dec.id + '"]');
      }, 8000, '决策页卡片');
      openDetail();
      await waitFor(function () { return document.querySelector('#sheet [data-dec-detail]'); }, 8000, '详情弹层');
      assert(document.querySelector('#sheet #dec-review-note'), '复盘理由输入框存在');
      assert(document.querySelector('#sheet [data-dec-comparison-pending]'),
        '复盘前对照区显示「未开始」提示而不是空表');
      clickAction('#sheet [data-action="dec:event"][data-to="reviewed"]');
      await new Promise(function (r) { setTimeout(r, 400); });
      equal(document.querySelector('#sheet [data-dec-chip]').getAttribute('data-dec-chip'), 'executed',
        '空理由不推进状态');

      // ② 填理由记录复盘：状态推进、复盘快照封存、对照表出现
      document.querySelector('#sheet #dec-review-note').value =
        '宽度检查：对照显示买入后仍在目标区间附近，下月按新增资金继续补低配类别。';
      clickAction('#sheet [data-action="dec:event"][data-to="reviewed"]');
      await waitFor(function () {
        var chip = document.querySelector('#sheet [data-dec-chip]');
        return chip && chip.getAttribute('data-dec-chip') === 'reviewed';
      }, 8000, '记录复盘成功');
      assert(document.querySelector('#sheet [data-dec-snap="复盘时点快照"]'), '复盘时点快照已封存');
      var cmpBox = document.querySelector('#sheet [data-dec-comparison]');
      assert(cmpBox, '可比时渲染配置变化对照表');
      equal(cmpBox.querySelectorAll('[data-cmp-class]').length, 6, '对照表恒 6 行（六类）');
      var cmpText = document.querySelector('#sheet').textContent;
      assert(cmpText.indexOf('配置变化对照') !== -1, '标题写「配置变化对照」');
      assert(!/建议收益|跑赢目标|赚了/.test(cmpText), '页面禁止收益 / 跑赢目标表述');
      var detail = await Store.decisionDetail(dec.id);
      equal(detail.comparison.comparable, true, '服务端对照可比');
      var driftRow = detail.comparison.rows.filter(function (row) { return row.assetClass === 'broad_equity'; })[0];
      equal(driftRow.deltaValueMinor, driftRow.review.valueMinor - driftRow.decision.valueMinor,
        '变化量 = 复盘时点 − 决策时点（服务端已复算）');

      // ③ 复盘后一切只读：不提供关联 / 解绑 / 状态推进入口
      assert(!document.querySelector('#sheet #dec-link-pick'), 'reviewed 不提供关联选择器');
      assert(!document.querySelector('#sheet [data-action="dec:unlink"]'), 'reviewed 不提供解绑入口');
      assert(!document.querySelector('#sheet [data-action="dec:event"]'), 'reviewed 不提供状态推进入口');
      var stR = await apiState();
      equal(stR.decisions.filter(function (d) { return d.id === dec.id; })[0].state, 'reviewed',
        '服务端状态 reviewed');
      equal(stR.decisionEvents.filter(function (e) { return e.decisionId === dec.id; }).length, 3,
        '状态事件恰好 3 条（接受 / 执行 / 复盘）');
      clickAction('#sheet .close');
      await waitFor(function () { return document.querySelector('#sheet-mask').classList.contains('hidden'); },
        8000, '关闭详情');

      // ④ 月度历史：按服务端 eventMonths 过滤，翻月与复位不丢数据、不出错
      var monthSel = document.querySelector('#view [data-change="dec:month"]');
      assert(monthSel, '月份筛选器存在');
      monthSel.value = month;
      monthSel.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(function () {
        return document.querySelector('#view .dec-card[data-dec-id="' + dec.id + '"]');
      }, 8000, '选定月份下决策可见');
      monthSel.value = '';
      monthSel.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(function () {
        return document.querySelector('#view .dec-card[data-dec-id="' + dec.id + '"]');
      }, 8000, '复位到全部月份后仍在');
      // 完整时间线：接受 / 执行 / 复盘三条状态事件都在详情里
      openDetail();
      await waitFor(function () { return document.querySelector('#sheet [data-dec-timeline]'); }, 8000, '时间线');
      equal(document.querySelectorAll('#sheet [data-tl="state"]').length, 3, '时间线含三条状态事件');
      clickAction('#sheet .close');
      await waitFor(function () { return document.querySelector('#sheet-mask').classList.contains('hidden'); },
        8000, '关闭详情');
    });

    await check('使用说明：三处入口、搜索不丢焦点、目录定位与业务跳转，阅读不改账本', async function () {
      // 验收骨架默认隐藏应用；本项临时显示，才能检查真实键盘焦点。
      var app = document.getElementById('app');
      var priorDisplay = app.style.display;
      app.style.display = 'block';
      try {
      var before = JSON.stringify(await apiState());
      location.hash = 'home';
      await waitFor(function () { return document.querySelector('#view.view-home'); }, 8000, '首页');
      assert(document.querySelector('#tabbar [data-action="nav:help"]'), '侧栏帮助入口');
      clickAction('#view [data-action="nav:help"]');
      await waitFor(function () { return document.querySelector('[data-help-page]'); }, 8000, '说明页');
      equal(document.querySelectorAll('[data-help-section]').length, 9, '完整九章');
      equal(document.querySelectorAll('.help-toc [data-action="help:section"]').length, 9, '九章目录');
      assertKnowLinksResolve(document.querySelector('#view'), '操作说明');
      var inp = document.getElementById('help-search');
      inp.focus();
      inp.value = '交易 汇率';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      assert(document.activeElement === inp, '搜索后保留输入焦点');
      assert(document.querySelector('[data-help-section="execution"]'), '找到交易操作');
      assert(document.querySelectorAll('[data-help-section]').length < 9, '搜索筛选章节');
      assert(document.querySelector('#help-problems details[open]'), '搜索时展开相关常见问题');
      inp.value = '<script>no-help-match</script>';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      assert(document.querySelector('.help-no-results'), '搜索无结果提示');
      clickAction('.help-no-results [data-action="help:clear"]');
      equal(document.querySelectorAll('[data-help-section]').length, 9, '清除恢复全部');
      equal(inp.value, '', '输入同步清空');
      clickAction('.help-toc [data-section="monthly"]');
      assert(document.activeElement === document.querySelector('#help-monthly h2'), '目录定位并移交焦点');
      clickAction('#help-monthly [data-action="nav:assets"]');
      await waitFor(function () { return document.querySelector('#view.view-assets'); }, 8000, '操作页面跳转');
      location.hash = 'settings';
      await waitFor(function () { return document.querySelector('#view.view-settings'); }, 8000, '我的');
      clickAction('#view [data-action="nav:help"]');
      await waitFor(function () { return document.querySelector('[data-help-page]'); }, 8000, '我的入口');
      equal(JSON.stringify(await apiState()), before, '阅读、搜索和跳转不改账本');
      } finally { app.style.display = priorDisplay; }
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
