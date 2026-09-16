/* 小账本 app.js — 界面层：路由/渲染/交互 + 导入向导状态机
 * 依赖：core.js（纯逻辑）、store.js（存储门面：本地 API 优先 + 只读降级）、db.js（加密与旧存储）、
 *       charts.js（SVG 图表）、domain.js（v3 资产领域）
 * 架构：内存数组是全量权威数据，每次变更全量写回事实源（Phase 2 起为本地服务 SQLite）。
 * v3 Phase 1：home 为资产决策台（tplDashboard），原月度记账首页下沉为 cashflow 现金流页。
 * v3 Phase 2：存储改由 store.js 统一分发；本地服务不可用时进入只读降级，不再写 IndexedDB。
 */
(function () {
  'use strict';
  var Core = window.Core, DB = window.DB, Store = window.Store, Charts = window.Charts, Domain = window.Domain;
  var APP_VERSION = '2.3.7-phase4b';

  /* ================= 状态 ================= */
  var state = {
    ready: false,
    page: 'home',
    ym: null,            // 当前查看月份 'YYYY-MM'
    txns: [], accounts: [], categories: [], settings: Core.defaultSettings(),
    assets: Domain.emptyAssets(), // v3 资产集合（Phase 1）
    addDraft: null, editId: null,
    listFilters: { type: '', account: '', category: '', q: '' },
    selectMode: false, selectedIds: {},
    statRank: 'amount',
    statsView: 'root',   // V2.3.4 一级/二级聚合视图
    statNec: '',         // V2.2.1 必要性筛选（'' 全部 / need / want）
    pendingRecurring: 0, // 待生成的周期账笔数（首页横幅）
    closes: [], closesLoaded: false, // Phase 3：月度结账历史
    // Phase 4B：标的目录（检索结果只存在内存里，不写事实源；事实源只有 instruments 表）
    instQuery: '', instResult: null, instBusy: false, instError: '',
    wiz: null
  };

  /* ================= 工具 ================= */
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $all(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var toastTimer = {};
  function toast(msg, kind) {
    var box = $('#toast');
    var div = document.createElement('div');
    div.className = 'toast-item' + (kind ? ' ' + kind : '');
    div.textContent = msg;
    box.appendChild(div);
    setTimeout(function () { div.remove(); }, kind === 'err' ? 3600 : 2200);
  }
  function accountById(id) { return state.accounts.find(function (a) { return a.id === id; }) || null; }
  function categoryById(id) { return state.categories.find(function (c) { return c.id === id; }) || null; }
  function accountName(id) {
    var a = accountById(id);
    if (!id) return '未指定账户';
    if (!a) return '已删除账户';
    return a.name;
  }
  function txnCategory(t) {
    if (t.type === 'transfer') return null;
    return categoryById(t.category);
  }
  function txnIcon(t) {
    if (t.type === 'transfer') return '🔁';
    var c = txnCategory(t);
    return c ? c.icon : '❓';
  }
  function txnTitle(t) { return t.merchant || (t.type === 'transfer' ? '转账' : (txnCategory(t) ? txnCategory(t).name : '未分类')); }
  function txnSub(t) {
    var parts = [];
    if (t.type === 'transfer') parts.push(accountName(t.account) + ' → ' + accountName(t.accountTo));
    else {
      var c = txnCategory(t);
      parts.push(c ? c.name : '未分类');
      parts.push(accountName(t.account));
    }
    if (t.source && t.source !== 'manual') parts.push(SOURCE_NAME[t.source] || '导入');
    if (t.time) parts.push(t.time);
    return parts.filter(Boolean).join(' · ');
  }
  var SOURCE_NAME = { wechat: '微信', alipay: '支付宝', bank: '银行' };
  function amtStr(t) {
    if (t.type === 'transfer') return '−' + Core.fmtMoney(t.amount);
    if (t.type === 'income') return '+' + Core.fmtMoney(t.amount);
    return '−' + Core.fmtMoney(t.amount);
  }
  function liveAccounts() { return state.accounts.filter(function (a) { return !a.deleted; }).sort(function (a, b) { return (a.order || 0) - (b.order || 0); }); }
  function curYM() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function ymShift(ym, delta) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + delta;
    var d = new Date(y, m, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function ymLabel(ym) { return ym.slice(0, 4) + '年' + Number(ym.slice(5, 7)) + '月'; }
  function save(options) {
    // 锁开启但内存无密钥（不应发生）时拒绝明文降级落盘
    if (state.settings.lock && state.settings.lock.enabled && !DB.hasMemoryKey()) {
      toast('加密密钥不在内存，为防明文泄露已暂停保存，请刷新解锁', 'err');
      return Promise.reject(new Error('locked'));
    }
    return Store.saveAll({
      accounts: state.accounts, categories: state.categories,
      txns: state.txns, settings: state.settings, assets: state.assets
    }, options).then(function () {
      return true; // 已确认落盘（S2：调用方据此决定是否提示成功/回滚乐观更新）
    }).catch(function (e) {
      if (e && (e.code === 'readonly' || e.code === 'unreachable')) {
        // 只读降级只提示一次，避免每次点击都刷屏
        if (!readonlyAlerted) {
          readonlyAlerted = true;
          toast('本地服务未运行，当前为只读模式，本次改动未保存', 'err');
        }
        renderServiceBanner();
        return false;
      }
      if (e && e.status === 401) {
        // 服务重启后会话令牌轮换：页面里的旧令牌已失效，刷新拿新页面即可恢复
        toast('会话令牌已失效（本地服务可能已重启），请刷新页面后重试', 'err');
        return false;
      }
      console.error(e);
      toast('数据保存失败：' + (e && e.message || e), 'err');
      return false;
    });
  }
  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 400);
  }
  function todayDateStr() { return Core.todayStr(); }

  /* ================= 弹层 ================= */
  function openSheet(title, bodyHtml, onOpen) {
    $('#sheet').innerHTML =
      '<div class="sheet-title"><b>' + esc(title) + '</b><button class="close" data-action="sheet:close">关闭</button></div>' + bodyHtml;
    $('#sheet-mask').classList.remove('hidden');
    if (onOpen) onOpen($('#sheet'));
  }
  function closeSheet() { $('#sheet-mask').classList.add('hidden'); $('#sheet').innerHTML = ''; }
  function confirmSheet(title, message, okLabel, cb, danger) {
    openSheet(title,
      '<div class="muted" style="line-height:1.7;padding:4px 0 14px">' + message + '</div>' +
      '<div class="row" style="gap:10px"><button class="btn grow" data-action="sheet:close">取消</button>' +
      '<button class="btn grow ' + (danger ? 'danger' : 'primary') + '" id="confirm-ok">' + esc(okLabel || '确定') + '</button></div>');
    $('#confirm-ok').addEventListener('click', function () { closeSheet(); cb(); });
  }

  /* ================= 启动 ================= */
  function init() {
    Store.loadRaw().then(function (raw) {
      var firstRun = raw.accounts == null;
      state.accounts = raw.accounts || Core.defaultAccounts();
      state.categories = raw.categories || Core.defaultCategories();
      state.settings = raw.settings || Core.defaultSettings();
      state.txns = raw.txns || [];
      // v3 资产集合：旧存储缺 assets 键时归一化为空集合（S1.1 旧状态兼容）
      state.assets = Domain.normalizeAssets(raw.assets);
      // 应用锁：txns 为密文时先锁屏
      if (raw.txns && raw.txns.enc) {
        renderLockScreen();
        return;
      }
      if (firstRun) save();
      boot();
    }).catch(function (e) {
      console.error(e);
      document.getElementById('view').innerHTML = '<div class="empty"><div class="e-icon">⚠️</div>数据加载失败：' +
        esc(e && e.message || e) + '<div class="small muted" style="margin-top:8px">请刷新重试</div></div>';
    });
  }

  /* Phase 2：事实源状态横幅。本地服务不可用时明确告知「只读」，不静默降级。 */
  var readonlyAlerted = false;
  function renderServiceBanner() {
    var el = $('#service-banner');
    if (!el) return;
    var info = Store.info();
    if (info.mode === Store.MODE_LOCAL) {
      el.className = 'service-banner warn';
      el.innerHTML = '<b>本地服务未运行 · 只读模式</b>' +
        '<div class="small">浏览器里的既有数据仍可查看和导出，但不会再被保存。' +
        '启动本地服务后刷新即可恢复记账：在终端执行 <code>node server/main.js</code>，或双击 <code>start.command</code>。</div>';
    } else if (info.mode === Store.MODE_API) {
      el.className = 'service-banner ok';
      el.innerHTML = '<b>本地服务已连接</b>' +
        '<div class="small">事实源：SQLite · Schema v' + esc(String(info.schemaVersion == null ? '?' : info.schemaVersion)) + '</div>';
      setTimeout(function () { el.classList.add('hidden'); }, 12000);
    } else {
      el.className = 'service-banner hidden';
      return;
    }
    el.classList.remove('hidden');
  }

  function renderLockScreen() {
    var lock = $('#lock-screen');
    lock.classList.remove('hidden');
    lock.innerHTML =
      '<div class="lock-box"><div class="lb-icon">🔒</div><h2>小账本已锁定</h2>' +
      '<div class="small muted">输入密码解锁本地数据</div>' +
      '<input type="password" id="lock-pw" placeholder="应用锁密码" autocomplete="off">' +
      '<div id="lock-err" class="small" style="color:var(--red);min-height:18px"></div>' +
      '<button class="btn primary block" id="lock-go">解锁</button>' +
      '<div class="small muted" style="margin-top:12px">密码仅存在于你的记忆中，忘记则数据无法恢复</div></div>';
    var tryUnlock = function () {
      var pw = $('#lock-pw').value;
      if (!pw) return;
      DB.unlock(pw, state.settings.lock, state.txns).then(function (txns) {
        state.txns = txns;
        lock.classList.add('hidden');
        boot();
      }).catch(function () {
        $('#lock-err').textContent = '密码错误，请重试';
        $('#lock-pw').value = '';
      });
    };
    $('#lock-go').addEventListener('click', tryUnlock);
    $('#lock-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') tryUnlock(); });
    $('#lock-pw').focus();
  }

  function boot() {
    state.ready = true;
    state.ym = curYM();
    // V2.1 PWA：注册 Service Worker（file:// 下静默跳过）
    if ('serviceWorker' in navigator) {
      try { navigator.serviceWorker.register('sw.js').catch(function () {}); } catch (e) { /* 忽略 */ }
    }
    runRecurringOnBoot();
    renderServiceBanner();
    renderTabbar();
    route(location.hash.replace('#', '') || 'home');
    window.addEventListener('hashchange', function () {
      route(location.hash.replace('#', '') || 'home');
    });
  }

  // V2.3.3 启动时处理周期账：自动模式静默生成；预览模式首页横幅提醒
  function runRecurringOnBoot() {
    var tpls = (state.settings.recurring || []).filter(function (t) { return t.active !== false; });
    state.pendingRecurring = 0;
    if (!tpls.length) return;
    var today = todayDateStr();
    var fromYm = state.settings.lastRun ? state.settings.lastRun.slice(0, 7) : curYM();
    var occ = Core.dueRecurring(tpls, fromYm, curYM()).filter(function (o) {
      return o.date <= today && (!state.settings.lastRun || o.date > state.settings.lastRun);
    });
    if (!occ.length) return;
    if (state.settings.recurringAuto) {
      var g = Core.generateRecurring(tpls, occ, state.txns);
      if (g.txns.length) {
        state.txns = state.txns.concat(g.txns);
        state.settings.lastRun = today;
        save();
        toast('已自动生成 ' + g.txns.length + ' 笔周期账');
      }
    } else {
      state.pendingRecurring = occ.length;
    }
  }

  function nav(page) {
    if (location.hash.replace('#', '') === page) route(page);
    else location.hash = page;
  }
  function route(page) {
    if (!state.ready) return;
    if (['home', 'cashflow', 'list', 'stats', 'settings', 'add', 'import', 'accounts', 'categories',
      'budget', 'health', 'reimburse', 'recurring', 'assets', 'close'].indexOf(page) < 0) page = 'home';
    state.page = page;
    if (page !== 'add') { state.editId = null; }
    if (page !== 'list') { state.selectMode = false; state.selectedIds = {}; }
    renderTabbar();
    try {
      render();
    } catch (e) {
      console.error(e);
      $('#view').innerHTML = '<div class="empty"><div class="e-icon">⚠️</div>页面渲染出错：' +
        esc(e && e.message || e) + '<div class="small muted" style="margin-top:8px">数据未受影响，可返回首页重试</div>' +
        '<button class="btn primary" style="margin-top:12px" onclick="location.hash=\'home\'">回首页</button></div>';
    }
    window.scrollTo(0, 0);
  }

  function renderTabbar() {
    var tabs = [
      { id: 'home', icon: '🧭', label: '资产' },
      { id: 'list', icon: '📋', label: '明细' },
      { id: '__add', icon: '', label: '' },
      { id: 'stats', icon: '📊', label: '统计' },
      { id: 'settings', icon: '⚙️', label: '我的' }
    ];
    $('#tabbar').classList.remove('hidden');
    $('#tabbar').innerHTML = tabs.map(function (t) {
      if (t.id === '__add') return '<div class="tab-add"><button data-action="nav:add" title="记一笔">＋</button></div>';
      return '<button class="tab ' + (state.page === t.id ? 'active' : '') + '" data-action="nav:' + t.id + '">' +
        '<span class="ti">' + t.icon + '</span><span>' + t.label + '</span></button>';
    }).join('');
  }

  function render() {
    var view = $('#view');
    var html = '';
    switch (state.page) {
      case 'home': html = tplDashboard(); break;
      case 'cashflow': html = tplCashflow(); break;
      case 'add': html = tplAdd(); break;
      case 'list': html = tplList(); break;
      case 'stats': html = tplStats(); break;
      case 'settings': html = tplSettings(); break;
      case 'import': html = tplWizard(); break;
      case 'accounts': html = tplAccounts(); break;
      case 'categories': html = tplCategories(); break;
      case 'budget': html = tplBudget(); break;
      case 'health': html = tplHealth(); break;
      case 'reimburse': html = tplReimburse(); break;
      case 'recurring': html = tplRecurring(); break;
      case 'assets': html = tplAssets(); break;
      case 'close': html = tplClose(); break;
    }
    view.innerHTML = html;
  }

  /* ================= 首页 ================= */
  function tplMonthBar() {
    return '<div class="month-bar">' +
      '<button data-action="ym:prev">‹</button>' +
      '<button class="mb-title" data-action="ym:today" title="回到本月">' + ymLabel(state.ym) + '</button>' +
      '<button data-action="ym:next">›</button></div>';
  }

  /* ================= 资产决策台（v3 Phase 1） ================= */

  // 阻塞码 → 用户可读提示（detail 为标的符号/币种/账户名等）
  var BLOCKER_LABELS = {
    fx_missing: '缺少汇率', fx_stale: '汇率已过期',
    quote_missing: '缺少行情', quote_stale: '行情已过期',
    balance_missing: '余额未核实', balance_stale: '余额未在本月确认',
    liability_missing: '负债余额未核实',
    instrument_missing: '持仓缺少标的信息', holding_invalid: '持仓数量无效',
    pool_missing: '资金池未分类', classification_unconfirmed: '标的分类未确认',
    asset_class_invalid: '资产类别无效'
  };
  var RISK_CLASS_LABELS = {
    cash: '现金', fixed_income: '固收', broad_equity: '宽基权益',
    theme_equity: '主题权益', stock: '个股', other: '其他'
  };

  function blockerText(b) {
    return (BLOCKER_LABELS[b.code] || b.code) + (b.detail ? '（' + b.detail + '）' : '');
  }

  function tplDashboard() {
    var ov = Domain.computeOverview(state.assets, { now: todayDateStr(), settings: state.settings });
    var statusChip;
    if (ov.valuationStatus === 'formal') {
      statusChip = '<span class="dash-chip ok">✅ 数据完整 · 正式口径</span>';
    } else if (ov.valuationStatus === 'estimate') {
      statusChip = '<span class="dash-chip warn">⚠️ 估算口径 · 暂不能生成正式建议</span>';
    } else {
      statusChip = '<span class="dash-chip">空状态</span>';
    }
    var html = '<div class="dash-head"><div><div class="dash-title">资产决策台</div>' +
      '<div class="small muted">数据日 ' + esc(ov.asOf) + '</div></div>' + statusChip + '</div>';

    /* 空状态：不虚构任何总额（S1.4） */
    if (ov.isEmpty) {
      return html + '<div class="empty dash-empty"><div class="e-icon">🧭</div><b>还没有资产数据</b>' +
        '<div class="small muted" style="line-height:1.8;margin-top:6px">这里将展示净资产、可投资资产、安全储备与风险配比。<br>' +
        '从资产录入开始：机构 → 账户 → 余额；也可通过「我的 → 恢复备份」导入包含资产数据的备份文件。</div>' +
        '<button class="btn primary" data-action="nav:assets">录入资产</button>' +
        '<button class="btn" data-action="nav:cashflow">去记一笔现金流</button></div>';
    }

    /* 估算口径的阻塞项列表 */
    var blockerHtml = ov.blockers.length
      ? '<div class="card dash-blockers"><b class="small">以下数据问题使结果为估算口径：</b><div class="db-list">' +
        ov.blockers.map(function (b) { return '<div class="db-item">· ' + esc(blockerText(b)) + '</div>'; }).join('') +
        '</div></div>'
      : '';

    /* 净资产 hero */
    var hero =
      '<div class="card dash-hero"><div class="small muted">净资产</div>' +
      '<div class="dash-net">' + Core.fmtMoney(ov.netWorthMinor) + '<span class="unit"> CNY</span></div>' +
      '<div class="dash-sub"><span>总资产 ' + Core.fmtMoney(ov.totalAssetsMinor) + '</span>' +
      '<span>总负债 ' + Core.fmtMoney(ov.totalLiabilitiesMinor) + '</span></div></div>';

    /* 资金池 */
    var poolDefs = [
      { key: 'safetyMinor', name: '安全储备', hint: '应急与短期确定用途' },
      { key: 'investableMinor', name: '可投资', hint: '现金 + 证券市值' },
      { key: 'restrictedMinor', name: '受限资产', hint: '公积金等长期锁定' }
    ];
    var poolCards = '<div class="dash-pools">' + poolDefs.map(function (p) {
      return '<div class="pool-card"><div class="p-name">' + p.name + '</div>' +
        '<div class="p-val">' + Core.fmtMoney(ov.pools[p.key]) + '</div>' +
        '<div class="p-hint">' + p.hint + '</div></div>';
    }).join('') + '</div>';

    /* 风险资产类别配比（占可投资资产） */
    var riskRows = ov.riskClasses.filter(function (r) { return r.valueMinor > 0; }).map(function (r) {
      return '<div class="risk-row"><span class="r-name">' + (RISK_CLASS_LABELS[r.assetClass] || r.assetClass) + '</span>' +
        '<span class="r-bar"><i style="width:' + Math.min(r.pct || 0, 100) + '%"></i></span>' +
        '<span class="r-val">' + Core.fmtMoney(r.valueMinor) + '</span>' +
        '<span class="r-pct">' + (r.pct == null ? '—' : r.pct + '%') + '</span></div>';
    }).join('');
    var riskCard = '<div class="card"><div class="row small muted"><b>风险资产类别配比</b>' +
      '<span style="margin-left:auto">占可投资资产 ' + Core.fmtMoney(ov.pools.investableMinor) + '</span></div>' +
      (riskRows || '<div class="small muted" style="padding:8px 0">暂无可投资资产</div>') +
      '<div class="small muted" style="margin-top:8px">投资现金计入「现金」类别；受限资产与安全储备不参与配比。</div></div>';

    /* 应急金覆盖（Phase 3）：安全储备 ÷ 最近 3 个完整月的月均必要支出 */
    var avgNec = avgNecessaryMinor();
    var coverage = Domain.emergencyCoverageMonths(ov.pools.safetyMinor, avgNec);
    var covMain = coverage == null ? '无法估算' : coverage + ' 个月';
    var covHint = coverage == null
      ? '需要安全储备与最近 3 个月的必要支出记录（分类标记为「必要」）'
      : '安全储备 ' + Core.fmtMoney(ov.pools.safetyMinor) + ' ÷ 月均必要支出 ' + Core.fmtMoney(avgNec);
    var emergencyCard =
      '<div class="card"><div class="row small muted"><b>应急金覆盖</b>' +
      '<button class="link small" style="margin-left:auto" data-action="nav:close">月度结账 ›</button></div>' +
      '<div class="dash-net" style="font-size:26px">' + covMain + '</div>' +
      '<div class="small muted" style="margin-top:4px">' + covHint + '</div></div>';

    /* 可新增投资资金 */
    var newFundsCard =
      '<div class="card"><div class="row small muted"><b>本月可新增投资资金</b>' +
      '<span style="margin-left:auto">' + (ov.canAdvise ? '正式口径' : '估算') + '</span></div>' +
      '<div class="dash-net" style="font-size:26px">' + Core.fmtMoney(ov.newFundsAvailableMinor) + '<span class="unit"> CNY</span></div>' +
      '<div class="dash-sub"><span>可投资现金 ' + Core.fmtMoney(ov.investableCashMinor) + '</span>' +
      '<span>近期应付款 ' + Core.fmtMoney(ov.duePayablesMinor) + '</span>' +
      '<span>储备缺口 ' + Core.fmtMoney(ov.safetyGapMinor) + '</span></div></div>';

    /* 待办与权益状态 */
    var todoHtml = '';
    if (ov.todos.length || ov.entitlements.length) {
      todoHtml = '<div class="card"><div class="row small muted"><b>待办与状态</b></div>';
      ov.todos.forEach(function (t) {
        if (t.code === 'safety_target_unset') {
          todoHtml += '<div class="todo-item">· 安全储备目标未设置，储备缺口暂按 0 计算</div>';
        }
      });
      ov.entitlements.forEach(function (e) {
        todoHtml += '<div class="todo-item">· 保障权益「' + esc(e.name) + '」：' + esc(e.status || '状态未知') +
          '（无确认余额，不计入资产）</div>';
      });
      todoHtml += '</div>';
    }

    /* 口径说明（折叠） */
    var caliber =
      '<details class="card dash-caliber"><summary class="small muted">数据口径说明</summary>' +
      '<div class="small muted" style="line-height:1.9;margin-top:8px">' +
      '· 净资产 = 总资产 − 总负债；负债不冲减总资产。<br>' +
      '· 可投资资产 = 标记为可投资的现金与证券市值；安全储备与受限资产不进入。<br>' +
      '· 外币按同一估值日汇率折算为 CNY；汇率或行情缺失时该项不计入，绝不按 1:1 估算。<br>' +
      '· 行情/汇率超过 5 个自然日、余额未在本月核对、分类未确认时，结果为估算口径。<br>' +
      '· 可新增投资资金 = 可投资现金 − 近期应付款 − 安全储备缺口，下限为 0。</div></details>';

    /* 现金流入口（旧记账首页下沉后保留入口，S1.4） */
    var cashflowEntry =
      '<div class="card dash-entry" data-action="nav:cashflow">' +
      '<div><b>现金流与预算</b><div class="small muted">记账、账单导入、预算与消费体检</div></div>' +
      '<span class="arrow">›</span></div>';

    /* Phase 3 入口：资产录入与月度结账 */
    var assetEntry =
      '<div class="card dash-entry" data-action="nav:assets">' +
      '<div><b>资产录入</b><div class="small muted">机构 · 账户 · 余额 · 负债 · 保障权益</div></div>' +
      '<span class="arrow">›</span></div>';
    var closeEntry =
      '<div class="card dash-entry" data-action="nav:close">' +
      '<div><b>月度结账</b><div class="small muted">' + ymLabel(ymShift(todayDateStr(), -1)) + ' 核对清单与结账快照</div></div>' +
      '<span class="arrow">›</span></div>';

    return html + blockerHtml + hero + poolCards + emergencyCard + riskCard + newFundsCard + todoHtml + caliber +
      assetEntry + closeEntry + cashflowEntry;
  }

  /* ================= Phase 3：资产录入与月度结账 ================= */

  var POOL_LABELS = { safety: '安全储备', investable: '可投资', restricted: '受限资产' };
  var INST_KIND_LABELS = { bank: '银行', broker: '券商', government: '政府机构', other: '其他' };
  var ACC_KIND_LABELS = { bank_card: '储蓄卡', credit_card: '信用卡', broker: '证券账户', government: '公积金/社保', other: '其他' };
  var ENT_KIND_LABELS = { social_security: '社保', housing_fund: '公积金', insurance: '商业保险', other: '其他' };
  var TERM_LABELS = { current: '当期（12个月内到期）', non_current: '长期负债' };
  // Phase 4B：资产类别为**用户判断**（provider 不提供），敞口市场词表与 domain 保持一份实现。
  var ASSET_CLASS_LABELS = {
    cash: '现金/货币',
    fixed_income: '固定收益',
    broad_equity: '宽基权益',
    theme_equity: '行业/主题权益',
    stock: '个股',
    other: '其他'
  };
  var EXPOSURE_LABELS = { CN: '中国内地', HK: '中国香港', US: '美国', global: '全球', other: '其他' };
  var INSTR_STATUS_LABELS = { suggested: '待确认', confirmed: '已确认' };

  function optList(map, def) {
    return Object.keys(map).map(function (k) {
      return '<option value="' + k + '"' + (k === def ? ' selected' : '') + '>' + map[k] + '</option>';
    }).join('');
  }

  // 最近 3 个完整自然月的必要支出均值（分，来自分类「必要」标记的现金流）。
  // 只对有支出记录的月份取平均：没记账的月份不代表没有支出，按 0 摊平会高估覆盖月数。
  // 无法估算 → null，绝不虚构。
  // 注意：必须传 categories，否则按「必要」标记的分类归类失效、need 恒为 0；
  // 且 Core.aggregate 的 need 已经是「分」，不能再过一遍 yuanToCents（会把结果放大 100 倍）。
  function avgNecessaryMinor() {
    var total = 0, months = 0;
    for (var i = 1; i <= 3; i++) {
      var ym = ymShift(todayDateStr(), -i);
      var agg = Core.aggregate(state.txns, {
        year: +ym.slice(0, 4), month: +ym.slice(5, 7), categories: state.categories
      });
      if (agg.need > 0) { total += agg.need; months += 1; }
    }
    if (!months) return null;
    return Math.round(total / months);
  }

  function ymLastDay(ym) {
    var d = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // 月度结账的对象月：上一个完整自然月（与 tplClose / doMonthlyClose 同一口径）。
  // 录入表单的「核对日期」默认取该月最后一天，否则新录入当天会被判为「未在结账月份内核对」（P0-A）。
  function closeTargetMonth() { return ymShift(todayDateStr(), -1); }
  function closeTargetAsOf() { return ymLastDay(closeTargetMonth()); }

  // 资源接口写入后必须重新拉取全量状态：写回事实源是全量覆盖（先清后写），
  // 前端内存里的 assets 若不刷新，下一次记账会把资源接口写入的数据抹掉。
  function refreshAssets() {
    return Store.loadRaw().then(function (raw) {
      if (raw.accounts != null) state.accounts = raw.accounts;
      if (raw.categories != null) state.categories = raw.categories;
      if (raw.settings != null) state.settings = raw.settings;
      if (raw.txns != null && !raw.txns.enc) state.txns = raw.txns;
      state.assets = Domain.normalizeAssets(raw.assets);
      render();
      return true;
    }).catch(function (e) {
      toast('状态刷新失败：' + (e && e.message || e), 'err');
      return false;
    });
  }

  function resourceFail(e) {
    if (e && e.status === 401) {
      toast('会话令牌已失效（本地服务可能已重启），请刷新页面后重试', 'err');
      return;
    }
    if (e && (e.code === 'readonly' || e.code === 'unreachable')) {
      toast('本地服务未运行，当前为只读模式，本次改动未保存', 'err');
      renderServiceBanner();
      return;
    }
    toast('保存失败：' + (e && e.message || e), 'err');
  }

  /* ---------- 资产录入页 ---------- */

  function tplAssets() {
    var a = Domain.normalizeAssets(state.assets);
    var html = '<div class="dash-head"><div><div class="dash-title">资产录入</div>' +
      '<div class="small muted">机构随账户自动创建 · 逐条保存到本地 SQLite</div></div></div>';

    /* 账户与余额单元 */
    var accCards = a.assetAccounts.map(function (acc) {
      var units = a.assetUnits.filter(function (u) { return u.accountId === acc.id; });
      var unitRows = units.map(function (u) {
        var bal = u.balanceMinor == null
          ? '<span class="muted">未核实</span>'
          : Core.fmtMoney(u.balanceMinor) + ' ' + (u.currency || 'CNY');
        return '<div class="todo-item small">· ' + bal +
          '<span class="muted"> 核对日 ' + esc(u.asOf || '—') + '</span></div>';
      }).join('');
      return '<div class="acc-card">' +
        '<div class="row"><b>' + esc(acc.name) + '</b>' +
        '<span class="small muted" style="margin-left:auto">' + esc(acc.institution || '未填机构') + '</span></div>' +
        '<div class="small muted">' + esc(ACC_KIND_LABELS[acc.kind] || acc.kind || '其他') +
        ' · ' + esc(POOL_LABELS[acc.pool] || acc.pool || '未分类') +
        (acc.status && acc.status !== 'active' ? ' · ' + esc(acc.status) : '') + '</div>' +
        (unitRows || '<div class="todo-item small muted">· 还没有余额记录</div>') +
        '<button class="btn ghost small" data-action="asset:unit" data-id="' + esc(acc.id) + '">＋登记/更新余额</button>' +
        '</div>';
    }).join('');
    var accountSection = '<div class="sec-head"><b>账户</b>' +
      '<button class="link small" data-action="asset:acc">＋新增账户</button></div>' +
      (accCards || '<div class="empty"><div class="e-icon">🏦</div><b>还没有资产账户</b>' +
        '<div class="small muted">先建账户，再登记各币种余额</div></div>');

    /* 多币种换汇：独立资产事实，不进入现金流收入/支出。 */
    var unitMap = {};
    a.assetUnits.forEach(function (u) { unitMap[u.id] = u; });
    var transferRows = a.assetTransfers.map(function (t) {
      var from = unitMap[t.fromUnitId] || {};
      var to = unitMap[t.toUnitId] || {};
      var fromAcc = a.assetAccounts.find(function (x) { return x.id === from.accountId; }) || {};
      var toAcc = a.assetAccounts.find(function (x) { return x.id === to.accountId; }) || {};
      return '<div class="acc-card"><div class="row"><b>' + esc(t.fromCurrency) + ' → ' + esc(t.toCurrency) + '</b>' +
        '<span class="small muted" style="margin-left:auto">' + esc(t.occurredOn) + '</span></div>' +
        '<div class="small muted">' + esc(fromAcc.name || '未知账户') + ' −' + Core.fmtMoney(t.fromAmountMinor) + ' ' + esc(t.fromCurrency) +
        ' · ' + esc(toAcc.name || '未知账户') + ' +' + Core.fmtMoney(t.toAmountMinor) + ' ' + esc(t.toCurrency) + '</div>' +
        (t.note ? '<div class="small muted">' + esc(t.note) + '</div>' : '') + '</div>';
    }).join('');
    var transferSection = '<div class="sec-head"><b>换汇记录</b>' +
      '<button class="link small" data-action="asset:transfer">＋记录换汇</button></div>' +
      (transferRows || '<div class="small muted" style="padding:4px 0 10px">暂无换汇记录</div>');

    /* 负债 */
    var liabRows = a.liabilities.map(function (l) {
      var bal = l.balanceMinor == null ? '<span class="muted">未核实</span>' : Core.fmtMoney(l.balanceMinor);
      return '<div class="acc-card"><div class="row"><b>' + esc(l.name) + '</b>' +
        '<span class="small muted" style="margin-left:auto">' + bal + ' ' + esc(l.currency || 'CNY') + '</span></div>' +
        '<div class="small muted">' +
        (l.termType === 'current' ? TERM_LABELS.current : (l.termType === 'non_current' ? TERM_LABELS.non_current : '期限未标')) +
        (l.dueDate ? ' · 到期 ' + esc(l.dueDate) : '') + ' · 核对日 ' + esc(l.asOf || '—') + '</div>' +
        '<button class="btn ghost small" data-action="asset:liab" data-id="' + esc(l.id) + '">更新余额 / 核对日期</button>' +
        '</div>';
    }).join('');
    var liabSection = '<div class="sec-head"><b>负债</b>' +
      '<button class="link small" data-action="asset:liab">＋新增负债</button></div>' +
      (liabRows || '<div class="small muted" style="padding:4px 0 10px">暂无负债记录</div>');

    /* 保障权益：只记录状态，不进入资产合计（D-011） */
    var entRows = a.entitlements.map(function (e) {
      var bal = e.balanceMinor == null ? '' : ' · 供参考 ' + Core.fmtMoney(e.balanceMinor);
      var src = e.sourceRef ? ' · 来源 ' + esc(e.sourceRef) : '';
      var jur = e.jurisdiction ? esc(e.jurisdiction) + ' · ' : '';
      return '<div class="acc-card"><div class="row"><b>' + esc(e.name) + '</b>' +
        '<span class="small muted" style="margin-left:auto">' + esc(ENT_KIND_LABELS[e.kind] || e.kind || '') + '</span></div>' +
        '<div class="small muted">' + jur + esc(e.status || '状态未知') + bal + ' · 核对日 ' + esc(e.asOf || '—') + src + '</div>' +
        '<button class="btn ghost small" data-action="asset:ent" data-id="' + esc(e.id) + '">更新状态 / 来源</button>' +
        '</div>';
    }).join('');
    var entSection = '<div class="sec-head"><b>保障权益</b>' +
      '<button class="link small" data-action="asset:ent">＋新增权益</button></div>' +
      (entRows || '<div class="small muted" style="padding:4px 0 10px">暂无保障权益（社保 / 公积金 / 保险等）</div>');

    /* 青岛福利预设（S3.2）：把「明确余额」与「无余额资格」分流到正确的数据模型，
       避免用户把公积金/医保个人账户余额填进只做展示的权益里（那样不计入总资产）。 */
    var presetRows = PRESETS.map(function (p) {
      return '<div class="acc-card"><div class="row"><b>' + esc(p.title) + '</b>' +
        '<span class="small muted" style="margin-left:auto">' + (p.counts ? '计入资产' : '仅状态') + '</span></div>' +
        '<div class="small muted">' + esc(p.desc) + '</div>' +
        '<button class="btn ghost small" data-action="asset:preset" data-id="' + esc(p.id) + '">' + esc(p.cta) + '</button>' +
        '</div>';
    }).join('');
    var presetSection = '<div class="sec-head"><b>福利预设（青岛）</b></div>' + presetRows;

    /* 汇率维护：Phase 3 用手动汇率让外币余额可正式折算；自动行情属于 Phase 4 */
    var fxRows = a.fxRates.map(function (r) {
      return '<div class="todo-item small">· ' + esc(r.base) + '→' + esc(r.quote) + ' ' + esc(r.rateDecimal) +
        '<span class="muted"> 汇率日 ' + esc(r.rateDate || '—') + ' · ' + esc(r.status || 'manual') + '</span></div>';
    }).join('');
    var fxSection = '<div class="sec-head"><b>汇率</b>' +
      '<button class="link small" data-action="asset:fx">＋登记汇率</button></div>' +
      '<div class="card">' + (fxRows || '<div class="small muted">暂无手动汇率；外币余额缺汇率时不计入汇总，且会阻塞正式结账</div>') +
      '<div class="small muted" style="margin-top:6px">自动行情将在后续版本接入；在此登记的是「币对 + 汇率 + 汇率日」这一条事实。</div></div>';

    return html + accountSection + transferSection + liabSection + entSection + presetSection + catalogSection() + fxSection +
      '<div class="small muted" style="margin-top:12px">说明：权益只展示状态与备注，不计入任何资产合计；' +
      '外币余额按估值日汇率折算，缺汇率时该项不计入；换汇只记为资产转移，不计收入或支出；' +
      '标的分类由你确认后锁定，参考数据变化只提示差异。</div>';
  }

  /* ---------- 标的目录（Phase 4B）----------
     流程：搜索（本地缓存 + 参考数据候选）→ 加入目录（suggested）→ 用户确认分类（confirmed）。
     参考数据只提供代码/名称/币种/交易所/类型/上市地区；资产类别与风险敞口是**用户判断**，
     参考数据没有就留空（不编造）。确认后参考数据的变化只提示冲突，不覆盖本地值（D-037）。 */
  function instSourceLabel(c) {
    if (c.origin === 'local+provider') return '本地已有 · 参考数据可刷新';
    if (c.origin === 'local') return '本地已有';
    return '来自参考数据';
  }

  function conflictBlock(conflicts) {
    if (!conflicts || !conflicts.length) return '';
    var rows = conflicts.map(function (c) {
      var prov = c.provenance || {};
      return '<div class="todo-item small">· <b>' + esc(c.field) + '</b>：本地「' + esc(c.localValue) +
        '」← 参考数据「' + esc(c.providerValue) + '」<span class="muted">（' +
        esc(prov.provider || '未知来源') + ' ' + esc(prov.endpoint || '') + ' · ' + esc(prov.fetchedAt || '') + '）</span></div>';
    }).join('');
    return '<div class="over-banner info" style="margin:6px 0 0">本地值保持不变，以下差异仅作提示：' + rows + '</div>';
  }

  function candidateRow(c) {
    var meta = [c.currency, c.exchange, c.instrumentType, c.country].filter(Boolean).join(' · ');
    return '<div class="acc-card"><div class="row"><b>' + esc(c.symbol) + '</b>' +
      '<span class="small muted" style="margin-left:auto">' + esc(instSourceLabel(c)) + '</span></div>' +
      (c.name ? '<div class="small">' + esc(c.name) + '</div>' : '') +
      '<div class="small muted">' + esc(meta || '参考数据未提供更多元数据') + '</div>' +
      '<div style="margin-top:6px">' + (c.local
        ? '<span class="small muted">已在目录中（' + esc(INSTR_STATUS_LABELS[c.local.classificationStatus] || c.local.classificationStatus) + '）</span>'
        : '<button class="btn ghost small" data-action="inst:add" data-symbol="' + esc(c.symbol) + '">加入目录</button>') +
      '</div></div>';
  }

  function instrumentRow(i) {
    var meta = [i.currency, i.exchange, i.instrumentType].filter(Boolean).join(' · ');
    var cls = i.assetClass ? (ASSET_CLASS_LABELS[i.assetClass] || i.assetClass) : '类别未填';
    var exp = i.exposureMarket ? (EXPOSURE_LABELS[i.exposureMarket] || i.exposureMarket) : '敞口未填';
    var status = INSTR_STATUS_LABELS[i.classificationStatus] || i.classificationStatus;
    var conflictCount = (i.conflicts || []).length;
    return '<div class="acc-card"><div class="row"><b>' + esc(i.symbol) + '</b>' +
      '<span class="small muted" style="margin-left:auto">' + esc(status) + ' · ' +
      (i.source === 'manual' ? '手工建立' : '参考数据') + (conflictCount ? ' · ' + conflictCount + ' 项差异' : '') + '</span></div>' +
      (i.name ? '<div class="small">' + esc(i.name) + '</div>' : '') +
      '<div class="small muted">' + esc(meta || '元数据不足') + ' · 分类 ' + esc(cls) + ' · 敞口 ' + esc(exp) +
      (i.trackingIndex ? ' · 跟踪 ' + esc(i.trackingIndex) : '') + '</div>' +
      '<div class="small muted">' + (i.classificationStatus === 'confirmed'
        ? '分类已锁定：参考数据变化只会提示冲突，不会覆盖你的判断'
        : '待确认：未确认分类不进入正式配置分析') + '</div>' +
      conflictBlock(i.conflicts) +
      '<div class="row" style="margin-top:6px">' +
      '<button class="btn ghost small" data-action="inst:confirm" data-id="' + esc(i.id) + '">' +
      (i.classificationStatus === 'confirmed' ? '修改分类' : '确认分类') + '</button>' +
      '<button class="btn ghost small" data-action="inst:refresh" data-id="' + esc(i.id) + '" data-symbol="' + esc(i.symbol) + '">按参考数据刷新</button>' +
      '</div></div>';
  }

  function catalogSection() {
    var a = Domain.normalizeAssets(state.assets);
    var items = a.instruments || [];
    var pending = items.filter(function (i) { return i.classificationStatus !== 'confirmed'; }).length;
    var conflicts = items.filter(function (i) { return (i.conflicts || []).length; }).length;
    var res = state.instResult;
    var providerBanner = res && res.provider && res.provider.status === 'error'
      ? '<div class="over-banner warn" style="margin-top:6px">参考数据暂不可用（' + esc(res.provider.code || 'error') +
        '）：本地已建标的仍可检索与确认，确认分类不依赖外部数据。</div>'
      : '';
    var warnRows = res && res.warnings && res.warnings.length
      ? '<div class="small muted" style="margin-top:4px">' + res.warnings.map(function (w) {
        return '· ' + esc(w.code) + (w.symbol ? '（' + esc(w.symbol) + '）' : '') + '：' + esc(w.detail || '');
      }).join('<br>') + '</div>'
      : '';
    var candRows = '';
    if (res && res.candidates && res.candidates.length) candRows = res.candidates.map(candidateRow).join('');
    else if (res) candRows = '<div class="small muted" style="padding:4px 0">没有匹配的候选；参考数据未覆盖时可手工建立。</div>';
    return '<div class="sec-head"><b>标的目录</b>' +
      '<span class="small muted">' + items.length + ' 个标的 · ' + pending + ' 个待确认' +
      (conflicts ? ' · ' + conflicts + ' 个有差异' : '') + '</span></div>' +
      '<div class="card">' +
      '<div class="row" style="gap:8px">' +
      '<input id="inst-q" placeholder="代码或名称，如 VOO / 2800.HK / 沪深300" value="' + esc(state.instQuery || '') + '" style="flex:1">' +
      '<button class="btn primary small" data-action="inst:search">' + (state.instBusy ? '搜索中…' : '搜索') + '</button></div>' +
      '<div class="small muted" style="margin-top:6px">只把检索词发给参考数据来源；账户名、数量、成本、余额一律不出本机。</div>' +
      '<div class="row" style="margin-top:6px"><button class="link small" data-action="inst:manual">＋ 手工建立标的（参考数据未覆盖时）</button></div>' +
      providerBanner + warnRows +
      (candRows ? '<div style="margin-top:8px">' + candRows + '</div>' : '') +
      '</div>' +
      (items.length
        ? items.map(instrumentRow).join('')
        : '<div class="empty"><div class="e-icon">📈</div><b>目录里还没有标的</b>' +
          '<div class="small muted">先搜索并加入，再确认资产类别与风险敞口</div></div>');
  }

  /* ---------- 福利预设（青岛）----------
     把「有明确余额」的福利分流成受限资产账户（计入资产，仅计一次），
     「只有资格没有余额」的福利留在权益表（不计入资产）。 */
  var PRESETS = [
    {
      id: 'pf',
      title: '青岛公积金余额',
      desc: '建立「青岛住房公积金」受限资产账户并登记 CNY 明确余额；计入总资产且只计一次。',
      cta: '登记公积金余额',
      counts: true,
      account: { name: '青岛住房公积金', institution: '青岛市住房公积金管理中心', kind: 'government', pool: 'restricted' },
      entKind: 'housing_fund'
    },
    {
      id: 'mi',
      title: '医保个人账户余额',
      desc: '建立「医保个人账户」受限资产账户并登记 CNY 明确余额；计入总资产且只计一次。',
      cta: '登记医保余额',
      counts: true,
      account: { name: '医保个人账户', institution: '青岛市医疗保障局', kind: 'government', pool: 'restricted' },
      entKind: 'social_security'
    },
    {
      id: 'ent',
      title: '养老 / 失业等无余额资格',
      desc: '只记录参保状态与查询来源，不登记金额；权益不计入任何资产合计。',
      cta: '登记参保状态',
      counts: false,
      account: null,
      entKind: 'social_security',
      defaultName: '职工基本养老保险'
    },
    {
      id: 'card',
      title: '社保卡金融账户',
      desc: '社保卡的银行金融账户，作为普通储蓄卡账户独立管理，不与社保权益合并。',
      cta: '登记社保卡账户',
      counts: true,
      account: { name: '社保卡金融账户', institution: '', kind: 'bank_card', pool: 'safety' },
      entKind: 'other'
    }
  ];

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  function presetSheet(id) {
    var p = presetById(id);
    if (!p) { toast('未知预设', 'warn'); return; }
    var acct = p.account;
    var fields = '<div class="form-row">' +
      formItem(p.counts ? '记录名称' : '资格名称',
        '<input id="ap-name" value="' + esc(acct ? acct.name : (p.defaultName || '')) + '">') +
      formItem('所属机构（可选）',
        '<input id="ap-inst" value="' + esc(acct ? acct.institution : '') + '" placeholder="如 青岛市住房公积金管理中心">') +
      formItem('地区', '<input id="ap-jur" value="青岛">');
    if (p.counts) {
      fields += formItem('明确余额（元）', '<input id="ap-bal" type="number" step="0.01" placeholder="0.00">');
    } else {
      fields += formItem('参保状态', '<input id="ap-status" value="在缴">');
    }
    fields += formItem('核对日期', '<input id="ap-asof" type="date" value="' + closeTargetAsOf() + '">') +
      formItem('查询来源（链接/渠道）', '<input id="ap-src" placeholder="如 青岛公积金 App / 人社局柜台">') +
      '</div>' +
      (p.counts
        ? '<div class="small muted" style="padding:0 4px 8px">将创建「受限资产 / 储蓄卡」账户并登记 CNY 余额 —— 该金额会进入总资产，且只计一次。</div>'
        : '<div class="small muted" style="padding:0 4px 8px">只记录资格与状态，不填金额 —— 该权益不计入总资产。</div>') +
      '<input type="hidden" id="ap-kind" value="' + esc(String(!!p.counts)) + '">' +
      '<input type="hidden" id="ap-preset" value="' + esc(p.id) + '">' +
      '<button class="btn primary block" data-action="asset:savePreset">' + esc(p.cta) + '</button>';
    openSheet(p.title, fields);
  }

  function assetFxSheet() {
    var curOpts = Domain.CURRENCIES.map(function (c) { return '<option value="' + esc(c) + '"' + (c === 'CNY' ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    var baseOpts = Domain.CURRENCIES.map(function (c) { return '<option value="' + esc(c) + '"' + (c === 'USD' ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    openSheet('登记汇率',
      '<div class="form-row">' +
      formItem('基准币种（外币）', '<select id="fx-base">' + baseOpts + '</select>') +
      formItem('报价币种（目标币种 · 通常 CNY）', '<select id="fx-quote">' + curOpts + '</select>') +
      formItem('汇率（1 基准币 = ? 报价币）', '<input id="fx-rate" placeholder="如 7.1200" inputmode="decimal">') +
      formItem('汇率日', '<input id="fx-date" type="date" value="' + todayDateStr() + '">') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">折算<b>按登记的币对方向精确匹配</b>，不会自动取倒数：' +
      '要把 USD 余额折成 CNY，就登记「USD → CNY」。同一币对重复登记会更新该条事实。' +
      '汇率日超过 5 个自然日会标记为过期（仍可用于折算，但不会让月结变成正式口径）。</div>' +
      '<button class="btn primary block" data-action="asset:saveFx">保存汇率</button>');
  }

  /* ---------- 标的目录：检索与确认弹层（Phase 4B） ---------- */

  function runInstrumentSearch() {
    var q = String(state.instQuery || '').trim();
    if (!q) { toast('请输入检索词', 'warn'); return; }
    state.instBusy = true;
    render();
    Store.searchInstruments(q)
      .then(function (res) {
        state.instBusy = false;
        state.instResult = res || null;
        if (res && res.offline) toast('本地服务未运行，检索不可用', 'err');
        render();
      })
      .catch(function (e) {
        state.instBusy = false;
        state.instResult = null;
        render();
        resourceFail(e);
      });
  }

  function instrumentManualSheet() {
    var curOpts = Domain.CURRENCIES.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === 'CNY' ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    openSheet('手工建立标的',
      '<div class="form-row">' +
      formItem('公开证券代码', '<input id="im-symbol" placeholder="如 512880.SS">') +
      formItem('名称（可选）', '<input id="im-name" placeholder="如 证券ETF">') +
      formItem('交易币种', '<select id="im-currency">' + curOpts + '</select>') +
      formItem('交易所（可选）', '<input id="im-exchange" placeholder="如 SSE">') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">用于参考数据未覆盖的标的（例如 A 股本土 ETF）；' +
      '手工建立的标的同样是「待确认」，分类需要你确认。</div>' +
      '<button class="btn primary block" data-action="inst:saveManual">建立</button>');
  }

  function instrumentConfirmSheet(id) {
    var a = Domain.normalizeAssets(state.assets);
    var inst = (a.instruments || []).find(function (x) { return x.id === id; });
    if (!inst) { toast('标的不存在', 'warn'); return; }
    var prov = inst.providerProvenance || null;
    var classOpts = Object.keys(ASSET_CLASS_LABELS).map(function (k) {
      return '<option value="' + esc(k) + '"' + (inst.assetClass === k ? ' selected' : '') + '>' + esc(ASSET_CLASS_LABELS[k]) + '</option>';
    }).join('');
    var expOpts = Domain.EXPOSURE_MARKETS.map(function (m) {
      return '<option value="' + esc(m) + '"' + (inst.exposureMarket === m ? ' selected' : '') + '>' + esc(EXPOSURE_LABELS[m] || m) + '</option>';
    }).join('');
    openSheet('确认标的分类',
      '<div class="form-row">' +
      formItem('标的', '<div>' + esc(inst.symbol) + (inst.name ? ' · ' + esc(inst.name) : '') + '</div>') +
      formItem('资产类别', '<select id="ic-class">' + classOpts + '</select>') +
      formItem('风险敞口市场', '<select id="ic-exp">' + expOpts + '</select>') +
      formItem('跟踪指数（可选）', '<input id="ic-index" value="' + esc(inst.trackingIndex || '') + '">') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">资产类别与风险敞口是<b>你的判断</b>，参考数据不提供；' +
      '确认后本地锁定，参考数据再变化也只提示差异、不覆盖。' +
      (prov ? '（当前来源 ' + esc(prov.provider) + ' ' + esc(prov.endpoint) + ' · ' + esc(prov.sourceVersion || '') + '）' : '') + '</div>' +
      conflictBlock(inst.conflicts) +
      '<button class="btn primary block" data-action="inst:saveConfirm" data-id="' + esc(inst.id) + '">确认分类并锁定</button>');
  }

  function assetAccountSheet() {    openSheet('新增账户',
      '<div class="form-row">' +
      formItem('账户名称', '<input id="aa-name" placeholder="如 招行储蓄卡(1234)">') +
      formItem('所属机构', '<input id="aa-inst" placeholder="如 招商银行（可留空）">') +
      formItem('账户类型', '<select id="aa-kind">' + optList(ACC_KIND_LABELS, 'bank_card') + '</select>') +
      formItem('资金池', '<select id="aa-pool">' + optList(POOL_LABELS, 'safety') + '</select>') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">资金池决定用途归类：安全储备参与应急金覆盖；可投资参与风险配比。</div>' +
      '<button class="btn primary block" data-action="asset:saveAcc">创建</button>');
  }

  function assetUnitSheet(accountId) {
    var a = Domain.normalizeAssets(state.assets);
    if (!a.assetAccounts.length) { toast('请先创建账户', 'warn'); return; }
    var accOpts = a.assetAccounts.map(function (acc) {
      return '<option value="' + esc(acc.id) + '"' + (acc.id === accountId ? ' selected' : '') + '>' + esc(acc.name) + '</option>';
    }).join('');
    var curOpts = Domain.CURRENCIES.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === 'CNY' ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    openSheet('登记余额',
      '<div class="form-row">' +
      formItem('账户', '<select id="au-acc">' + accOpts + '</select>') +
      formItem('币种', '<select id="au-cur">' + curOpts + '</select>') +
      formItem('余额（留空表示未核实）', '<input id="au-bal" type="number" step="0.01" placeholder="0.00">') +
      formItem('核对日期', '<input id="au-date" type="date" value="' + todayDateStr() + '">') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">同一账户同币种再次登记会更新该余额；核对日期须在结账月份内才算「已核对」。</div>' +
      '<button class="btn primary block" data-action="asset:saveUnit">保存</button>');
  }

  function assetTransferSheet() {
    var a = Domain.normalizeAssets(state.assets);
    if (a.assetUnits.length < 2) { toast('请先登记至少两个币种子账户', 'warn'); return; }
    var accountMap = {};
    a.assetAccounts.forEach(function (acc) { accountMap[acc.id] = acc.name; });
    var opts = a.assetUnits.map(function (u) {
      return '<option value="' + esc(u.id) + '">' + esc(accountMap[u.accountId] || '未知账户') + ' · ' + esc(u.currency) + '</option>';
    }).join('');
    openSheet('记录换汇',
      '<div class="form-row">' +
      formItem('转出子账户', '<select id="at-from">' + opts + '</select>') +
      formItem('转出金额', '<input id="at-from-amount" type="number" min="0" step="0.01" placeholder="0.00">') +
      formItem('转入子账户', '<select id="at-to">' + opts + '</select>') +
      formItem('转入金额', '<input id="at-to-amount" type="number" min="0" step="0.01" placeholder="0.00">') +
      formItem('换汇日期', '<input id="at-date" type="date" value="' + todayDateStr() + '">') +
      formItem('备注（可选）', '<input id="at-note" placeholder="如 银行牌价及手续费">') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">换汇记录不会进入收入或支出，也不会自动改写当前余额；请按银行实际余额分别核对两个子账户。</div>' +
      '<button class="btn primary block" data-action="asset:saveTransfer">保存换汇</button>');
  }

  function assetLiabilitySheet(liab) {
    var a = Domain.normalizeAssets(state.assets);
    var accOpts = '<option value="">不关联账户</option>' + a.assetAccounts.map(function (acc) {
      return '<option value="' + esc(acc.id) + '"' + (liab && liab.accountId === acc.id ? ' selected' : '') + '>' +
        esc(acc.name) + '</option>';
    }).join('');
    var l = liab || {};
    openSheet(liab ? '更新负债' : '新增负债',
      '<div class="form-row">' +
      formItem('负债名称', '<input id="al-name" placeholder="如 花呗 / 房贷" value="' + esc(l.name || '') + '">') +
      formItem('关联账户（可选）', '<select id="al-acc">' + accOpts + '</select>') +
      formItem('当前余额', '<input id="al-bal" type="number" step="0.01" placeholder="0.00" value="' +
        (l.balanceMinor == null ? '' : esc(Domain.parseDecimal(String(l.balanceMinor / 100)) == null ? '' : String(l.balanceMinor / 100))) + '">') +
      formItem('核对日期', '<input id="al-asof" type="date" value="' + esc(l.asOf || closeTargetAsOf()) + '">') +
      formItem('到期日（可选）', '<input id="al-due" type="date" value="' + esc(l.dueDate || '') + '">') +
      formItem('期限类型', '<select id="al-term">' +
        '<option value="current"' + (l.termType !== 'non_current' ? ' selected' : '') + '>' + TERM_LABELS.current + '</option>' +
        '<option value="non_current"' + (l.termType === 'non_current' ? ' selected' : '') + '>' + TERM_LABELS.non_current + '</option>' +
        '</select>') +
      '</div>' +
      '<input type="hidden" id="al-id" value="' + esc(l.id || '') + '">' +
      '<div class="small muted" style="padding:0 4px 8px">核对日期默认为当前结账月份（' + ymLabel(closeTargetMonth()) +
      '）最后一天；只有落在结账月份内才会被判定为「已核对」，否则正式结账会被阻塞。</div>' +
      '<button class="btn primary block" data-action="asset:saveLiab">' + (liab ? '保存修改' : '创建') + '</button>');
  }

  function assetEntitlementSheet(ent) {
    var e = ent || {};
    var val = e.balanceMinor == null ? '' : String(e.balanceMinor / 100);
    openSheet(ent ? '更新保障权益' : '新增保障权益',
      '<div class="form-row">' +
      formItem('名称', '<input id="ae-name" placeholder="如 城镇职工医保" value="' + esc(e.name || '') + '">') +
      formItem('类型', '<select id="ae-kind">' + optList(ENT_KIND_LABELS, e.kind || 'social_security') + '</select>') +
      formItem('地区', '<input id="ae-jur" placeholder="如 青岛" value="' + esc(e.jurisdiction || '青岛') + '">') +
      formItem('当前状态', '<input id="ae-status" placeholder="如 在缴 / 生效中" value="' + esc(e.status || '') + '">') +
      formItem('参考金额（可留空）', '<input id="ae-bal" type="number" step="0.01" placeholder="留空表示无确认余额" value="' + esc(val) + '">') +
      formItem('核对日期', '<input id="ae-asof" type="date" value="' + esc(e.asOf || closeTargetAsOf()) + '">') +
      formItem('查询来源（链接/渠道，可选）', '<input id="ae-src" placeholder="如 青岛公积金 App / 人社局柜台" value="' + esc(e.sourceRef || '') + '">' +
        '<input type="hidden" id="ae-valtype" value="' + esc(e.valuationType || 'reference') + '">' +
        '<input type="hidden" id="ae-id" value="' + esc(e.id || '') + '">') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">权益不计入资产合计，金额仅作个人参考展示。' +
      '若公积金或医保个人账户已有<b>明确余额</b>，请用上方「福利预设」建立受限资产账户，才会进入总资产。</div>' +
      '<button class="btn primary block" data-action="asset:saveEnt">' + (ent ? '保存修改' : '创建') + '</button>');
  }

  /* ---------- 月度结账页 ---------- */

  function tplClose() {
    var month = ymShift(todayDateStr(), -1); // 结账对象是上一个完整自然月
    var asOf = ymLastDay(month);
    var cl = Domain.computeCloseChecklist(state.assets, { now: asOf, settings: state.settings });

    var html = '<div class="dash-head"><div><div class="dash-title">月度结账</div>' +
      '<div class="small muted">结账月份 ' + ymLabel(month) + ' · 数据截止 ' + asOf + '</div></div>' +
      (cl.canComplete
        ? '<span class="dash-chip ok">✅ 无缺项 · 可正式结账</span>'
        : '<span class="dash-chip warn">⚠️ ' + cl.items.length + ' 类待核对 · 估算口径</span>') +
      '</div>';

    /* 核对清单 */
    var itemsHtml = cl.items.length
      ? cl.items.map(function (it) {
        return '<div class="todo-item">· ' + esc(blockerText({ code: it.code, detail: it.detail })) +
          (it.count > 1 ? '<span class="muted">（' + it.count + ' 项）</span>' : '') + '</div>';
      }).join('')
      : '<div class="todo-item">· 全部核对通过，可以正式结账</div>';
    var checklistCard = '<div class="card"><div class="row small muted"><b>核对清单</b></div>' + itemsHtml +
      '<div class="small muted" style="margin-top:8px">余额 ' + cl.counts.unitsConfirmed + '/' + cl.counts.units +
      ' 已核对 · 负债 ' + cl.counts.liabilitiesConfirmed + '/' + cl.counts.liabilities +
      ' · 持仓 ' + cl.counts.holdingsPriced + '/' + cl.counts.holdings + ' 已估值</div></div>';

    /* 结账动作 */
    var formalBtn = '<button class="btn primary block" data-action="close:save" data-status="formal"' +
      (cl.canComplete ? '' : ' disabled') + '>正式结账</button>';
    var estimateBtn = '<button class="btn block" style="margin-top:10px" data-action="close:save" data-status="estimate">保存为估算快照</button>';
    var actionCard = '<div class="card">' + formalBtn + estimateBtn +
      '<div class="small muted" style="margin-top:8px">快照会封存当月净资产、核对清单与应急金覆盖，结账后可在下方回看；同月重复结账会更新记录并追加新快照。</div></div>';

    /* 历史结账：每条都必须能下钻到封存时的单元级事实（ACCEPTANCE：金额可追溯） */
    var histRows = state.closes.map(function (c) {
      var s = c.summary || {};
      var snapId = c.snapshot && c.snapshot.id;
      return '<div class="acc-card"><div class="row"><b>' + ymLabel(c.month) + '</b>' +
        '<span class="small muted" style="margin-left:auto">' +
        (c.status === 'formal' ? '正式' : '估算') + '</span></div>' +
        '<div class="small muted">净资产 ' + (s.netWorthMinor == null ? '—' : Core.fmtMoney(s.netWorthMinor)) + ' CNY' +
        (s.emergencyCoverageMonths != null ? ' · 应急覆盖 ' + s.emergencyCoverageMonths + ' 个月' : '') + '</div>' +
        (c.snapshot ? '<div class="small muted">快照 ' + esc(String(c.snapshot.payloadHash || '').slice(0, 8)) +
          ' · ' + esc(String(c.snapshot.capturedAt || '').slice(0, 10)) + '</div>' : '') +
        (snapId ? '<button class="btn ghost small" data-action="close:detail" data-id="' + esc(snapId) + '">查看明细</button>' : '') +
        '</div>';
    }).join('');
    var histCard = '<div class="sec-head"><b>历史结账</b></div>' +
      (histRows || '<div class="small muted" style="padding:4px 0 10px">' +
        (state.closesLoaded ? '还没有结账记录' : '加载中…') + '</div>');

    return html + checklistCard + actionCard + histCard;
  }

  /* 结账快照明细：把封存时的单元级事实摊开，让每个汇总金额都能追到来源。
     金额一律取快照内的 CNY 折算值（当时口径），不重新按今天的汇率折算。 */
  function closeDetailSheet(snap) {
    var p = snap.payload || {};
    var facts = (p.checklist && p.checklist.facts) || {};
    var ov = p.overview || {};
    var pools = ov.pools || {};

    function money(minor, currency) {
      if (minor == null) return '<span class="muted">—</span>';
      return Core.fmtMoney(minor) + (currency ? ' ' + esc(currency) : '');
    }
    function cny(minor, status) {
      if (minor == null) return '<span class="muted">' + (status === 'missing_fx' ? '缺汇率·未计入' : '—') + '</span>';
      return Core.fmtMoney(minor) + ' CNY';
    }
    function row(cells, head) {
      var tag = head ? 'th' : 'td';
      return '<tr>' + cells.map(function (c, i) {
        return '<' + tag + (i === 0 ? ' style="text-align:left"' : ' style="text-align:right"') + '>' + c + '</' + tag + '>';
      }).join('') + '</tr>';
    }

    var unitRows = (facts.units || []).map(function (u) {
      return row([
        esc(u.account || '') + '<div class="small muted">' + esc(u.currency || '') +
        ' · 核对日 ' + esc(u.asOf || '—') + (u.confirmed ? ' · 已核对' : ' · 未核对') + '</div>',
        money(u.balanceMinor, u.currency),
        cny(u.valueCnyMinor, u.valueStatus)
      ]);
    }).join('');
    var unitTable = '<div class="sec-head"><b>账户余额（来源：人工核对 / 系统导入）</b></div>' +
      (unitRows
        ? '<table class="mini"><thead>' + row(['账户 / 核对日', '原币金额', '折 CNY'], true) + '</thead><tbody>' + unitRows + '</tbody></table>'
        : '<div class="small muted">该月没有余额记录</div>');

    var liabRows = (facts.liabilities || []).map(function (l) {
      return row([
        esc(l.name || '') + '<div class="small muted">' + esc(l.currency || '') +
        ' · 核对日 ' + esc(l.asOf || '—') + (l.confirmed ? ' · 已核对' : ' · 未核对') + '</div>',
        money(l.balanceMinor, l.currency),
        cny(l.valueCnyMinor, l.valueStatus)
      ]);
    }).join('');
    var liabTable = '<div class="sec-head"><b>负债</b></div>' +
      (liabRows
        ? '<table class="mini"><thead>' + row(['名称 / 核对日', '原币金额', '折 CNY'], true) + '</thead><tbody>' + liabRows + '</tbody></table>'
        : '<div class="small muted">该月没有负债记录</div>');

    var holdRows = (facts.holdings || []).map(function (h) {
      return row([
        esc(h.symbol || h.instrumentId || '') + '<div class="small muted">' + esc(h.account || '') +
        ' · 价格日 ' + esc(h.priceDate || '—') + ' · ' + esc(h.priceStatus || '') + '</div>',
        (h.quantity == null ? '—' : esc(String(h.quantity))) +
        '<div class="small muted">@ ' + (h.priceMinor == null ? '—' : Core.fmtMoney(h.priceMinor) + ' ' + esc(h.priceCurrency || '')) + '</div>',
        cny(h.valueCnyMinor, h.valueStatus)
      ]);
    }).join('');
    var holdTable = '<div class="sec-head"><b>持仓估值</b></div>' +
      (holdRows
        ? '<table class="mini"><thead>' + row(['标的 / 价格日', '数量 @ 价格', '折 CNY'], true) + '</thead><tbody>' + holdRows + '</tbody></table>'
        : '<div class="small muted">该月没有持仓</div>');

    var er = p.emergency || {};
    var erBasis = er.basis || {};
    var erSource = er.source === 'txns' ? '封存时从现金流事实重算'
      : er.source === 'client' ? '前端传入（现金流不可用）'
        : er.source === 'settings' ? '设置中的兜底值' : '不可用';
    var erMonths = (erBasis.months || []).join('、');
    var erReason = erBasis.reason === 'txns_encrypted' ? '现金流为密文，无法重算'
      : erBasis.reason === 'no_necessary_expense' ? '检索区间内没有标记为「必要」的支出' : '';
    var emergencyLine = er.avgNecessaryMinor == null
      ? '应急覆盖：无法估算' + (erReason ? '（' + esc(erReason) + '）' : '') +
        (erMonths ? ' · 检索区间 ' + esc(erMonths) : '')
      : '应急覆盖：' + (p.emergencyCoverageMonths == null ? '—' : p.emergencyCoverageMonths + ' 个月') +
        ' · 依据 安全储备 ' + Core.fmtMoney(pools.safetyMinor == null ? 0 : pools.safetyMinor) +
        ' ÷ 月均必要支出 ' + Core.fmtMoney(er.avgNecessaryMinor) +
        '（口径：' + esc(erSource) + ' · 取 ' + (erBasis.counted || 0) + ' 个月' +
        (erMonths ? '：' + esc(erMonths) : '') + '）';

    var body = '<div class="small muted">结账月份 ' + esc(p.month || snap.month || '') +
      ' · 数据截止 ' + esc(p.asOf || '') + ' · 口径 ' + (p.status === 'formal' ? '正式' : '估算') + '</div>' +
      '<div class="small muted" style="margin-top:4px">快照 ' + esc(String(snap.payloadHash || '').slice(0, 12)) +
      ' · 封存于 ' + esc(String(snap.capturedAt || '').slice(0, 19).replace('T', ' ')) + '</div>' +
      '<div class="card" style="margin-top:8px"><div class="acc-card">' +
      '<div class="row"><b>净资产</b><span style="margin-left:auto">' + Core.fmtMoney(ov.netWorthMinor == null ? 0 : ov.netWorthMinor) + ' CNY</span></div>' +
      '<div class="small muted">总资产 ' + Core.fmtMoney(ov.totalAssetsMinor == null ? 0 : ov.totalAssetsMinor) +
      ' − 负债 ' + Core.fmtMoney(ov.totalLiabilitiesMinor == null ? 0 : ov.totalLiabilitiesMinor) +
      '（下方三张表逐条加总即为此数）</div>' +
      '<div class="small muted" style="margin-top:4px">' + emergencyLine + '</div>' +
      '<div class="small muted">资金池：安全储备 ' + Core.fmtMoney(pools.safetyMinor == null ? 0 : pools.safetyMinor) +
      ' · 可投资 ' + Core.fmtMoney(pools.investableMinor == null ? 0 : pools.investableMinor) +
      ' · 受限 ' + Core.fmtMoney(pools.restrictedMinor == null ? 0 : pools.restrictedMinor) + '</div>' +
      '</div></div>' +
      unitTable + liabTable + holdTable;
    openSheet('结账明细 · ' + ymLabel(p.month || snap.month || ''), body);
  }

  function doMonthlyClose(status) {
    var month = ymShift(todayDateStr(), -1);
    Store.saveMonthlyClose(month, { status: status, avgNecessaryMinor: avgNecessaryMinor() })
      .then(function (r) {
        var c = r && r.close;
        toast(c && c.status === 'formal' ? ymLabel(month) + ' 已正式结账' : ymLabel(month) + ' 已保存为估算快照');
        return Store.listMonthlyCloses();
      })
      .then(function (r) {
        state.closes = (r && r.items) || [];
        state.closesLoaded = true;
        render();
      })
      .catch(resourceFail);
  }

  /* ================= 现金流页（原月度记账首页） ================= */
  function tplCashflow() {
    var y = +state.ym.slice(0, 4), m = +state.ym.slice(5, 7);
    var agg = Core.aggregate(state.txns, { year: y, month: m, categories: state.categories });
    var totalAsset = liveAccounts().reduce(function (s, a) { return s + Core.accountBalance(a, state.txns); }, 0);

    // V2.2.1 预算：超支横幅 + 进度条
    var budgets = state.settings.budgets || { total: 0, cats: {} };
    var budgetHtml = '';
    if (budgets.total > 0) {
      var bst = Core.budgetStatus(state.txns, budgets, { year: y, month: m });
      var pct = Math.min(bst.total.pct, 1.999);
      var overCats = bst.cats.filter(function (c) { return c.over; })
        .map(function (c) { return ((categoryById(c.catId) || {}).name || '未分类'); });
      if (bst.total.over && state.ym === curYM()) {
        budgetHtml += '<div class="over-banner">⚠️ 本月已超支：支出 ' + Core.fmtMoney(bst.total.spent) +
          ' / 预算 ' + Core.fmtMoney(bst.total.budget) +
          (overCats.length ? '（' + esc(overCats.join('、')) + ' 超分类预算）' : '') +
          ' <button class="link" data-action="nav:budget">调整预算</button></div>';
      }
      budgetHtml += '<div class="card" style="padding:10px 14px"><div class="row small muted"><span>月度预算</span>' +
        '<span style="margin-left:auto">' + Core.fmtMoney(bst.total.spent) + ' / ' + Core.fmtMoney(bst.total.budget) +
        (bst.total.pct != null ? '（' + Math.round(bst.total.pct * 100) + '%）' : '') + '</span></div>' +
        '<div class="progress"><i class="' + (bst.total.over ? 'over' : pct > 0.8 ? 'warn' : '') + '" style="width:' + Math.min(pct * 100, 100) + '%"></i></div></div>';
    }

    // V2.3.3 周期账待生成横幅
    var recurBanner = (state.pendingRecurring > 0 && state.ym === curYM())
      ? '<div class="over-banner info">🔁 有 ' + state.pendingRecurring + ' 笔周期账待生成 <button class="link" data-action="recur:previewDue">预览生成</button> <button class="link" data-action="nav:recurring">设置</button></div>'
      : '';

    var accCards = liveAccounts().map(function (a) {
      return '<div class="acc-card" data-action="nav:accounts">' +
        '<div class="a-name"><i class="a-dot" style="background:' + esc(a.color || '#999') + '"></i>' + esc(a.name) + '</div>' +
        '<div class="a-bal">' + Core.fmtMoney(Core.accountBalance(a, state.txns)) + '</div></div>';
    }).join('');

    // 分类 TOP5
    var catAgg = [];
    Object.keys(agg.byCategory).forEach(function (cid) {
      var c = categoryById(cid);
      catAgg.push({ id: cid, name: c ? c.name : '未分类', icon: c ? c.icon : '❓', sum: agg.byCategory[cid].sum, count: agg.byCategory[cid].count });
    });
    catAgg.sort(function (a, b) { return b.sum - a.sum; });
    var top5 = catAgg.slice(0, 5);
    var donutItems = top5.map(function (c, i) { return { label: c.name, value: c.sum }; });
    var legend = top5.map(function (c, i) {
      var pct = agg.expense ? (c.sum / agg.expense * 100).toFixed(1) : '0';
      return '<div class="legend-item"><i style="background:' + Charts.PALETTE[i % Charts.PALETTE.length] + '"></i>' +
        '<span>' + c.icon + ' ' + esc(c.name) + '</span><span class="li-pct">' + pct + '% · ' + Core.fmtMoney(c.sum) + '</span></div>';
    }).join('');

    // 最近 5 笔
    var groups = Core.groupByDay(state.txns);
    var recent = [];
    for (var i = 0; i < groups.length && recent.length < 5; i++) {
      groups[i].txns.forEach(function (t) { if (recent.length < 5) recent.push(t); });
    }
    var mt = mergedTargetsMap();
    var recentHtml = recent.length
      ? recent.map(function (t) { return txnRowHtml(t, mt); }).join('')
      : '<div class="empty" style="padding:26px"><div class="e-icon">🧾</div>还没有记录，点下方＋记第一笔吧</div>';

    var emptyGuide = state.txns.length ? '' :
      '<div class="card" style="text-align:center"><b>欢迎使用小账本 👋</b>' +
      '<div class="muted small" style="margin:8px 0 4px">数据 100% 存在本机浏览器，零网络请求</div></div>';

    return tplMonthBar() + budgetBannerJoin(budgetHtml) + recurBanner + emptyGuide +
      '<div class="hero">' +
        '<div class="h-label">本月支出（总资产 ' + Core.fmtMoney(totalAsset) + '）</div>' +
        '<div class="h-amount">' + Core.fmtMoney(agg.expense) + '</div>' +
        '<div class="h-cols">' +
          '<div class="h-col"><span>收入</span><b>' + Core.fmtMoney(agg.income) + '</b></div>' +
          '<div class="h-col"><span>结余</span><b>' + Core.fmtMoney(agg.balance) + '</b></div>' +
          '<div class="h-col"><span>笔数</span><b>' + agg.count + '</b></div>' +
        '</div>' +
      '</div>' +
      '<div class="quick-actions">' +
        '<button class="btn primary" data-action="nav:add">✏️ 记一笔</button>' +
        '<button class="btn" data-action="nav:import">📥 导入账单</button>' +
      '</div>' +
      '<div class="sec-head"><b>账户余额</b><button class="link small" data-action="nav:accounts">管理</button></div>' +
      '<div class="acc-cards">' + (accCards || '<div class="muted small">暂无账户</div>') + '</div>' +
      '<div class="sec-head"><b>本月支出分类 TOP5</b><button class="link small" data-action="nav:stats">统计</button></div>' +
      '<div class="card"><div class="donut-row">' + Charts.donut(donutItems, { centerLabel: '本月支出', centerValue: agg.expense ? '¥' + Core.fmtMoney(agg.expense) : '' }) +
        '<div class="d-legend">' + (legend || '<div class="muted small">本月暂无支出</div>') + '</div></div></div>' +
      '<div class="sec-head"><b>最近交易</b><button class="link small" data-action="nav:list">全部</button></div>' +
      '<div class="txn-list">' + recentHtml + '</div>';
  }
  function afterHome() { /* 预留 */ }

  function mergedTargetsMap() {
    var map = {};
    state.txns.forEach(function (x) { if (x.mappedTo) map[x.mappedTo] = true; });
    return map;
  }

  function budgetBannerJoin(html) { return html || ''; }

  function txnRowHtml(t, mergedTargets) {
    var chips = '';
    if (t.mappedTo) chips += '<span class="chip merged">已合并</span>';
    else if (t.refundFlag) chips += t.refundOf ? '<span class="chip refund">已冲销</span>' : '<span class="chip refund">退款</span>';
    if (t.type === 'income' && t.reimburseOf) chips += '<span class="chip">报销款</span>';
    if (t.type === 'expense' && t.reimburseFlag) {
      var closed = state.txns.some(function (x) { return x.type === 'income' && x.reimburseOf === t.id; });
      chips += closed ? '<span class="chip refund">已报销</span>' : '<span class="chip">待报销</span>';
    }
    if (mergedTargets && mergedTargets[t.id]) chips += '<span class="chip">🔗含合并</span>';
    return '<div class="txn-item" data-action="txn:detail" data-id="' + esc(t.id) + '">' +
      '<div class="t-icon">' + txnIcon(t) + '</div>' +
      '<div class="t-main"><div class="t-title">' + esc(txnTitle(t)) + chips + '</div>' +
      '<div class="t-sub">' + esc(txnSub(t)) + '</div></div>' +
      '<div class="t-amt ' + (t.type === 'income' ? 'income' : t.type === 'transfer' ? 'transfer' : 'expense') + '">' + amtStr(t) + '</div></div>';
  }

  /* ================= 记一笔 / 编辑 ================= */
  function newDraft(type) {
    return {
      type: type || 'expense',
      amount: '', accountId: defaultAccountId(), accountToId: secondAccountId(),
      categoryId: null, date: todayDateStr(), time: nowTimeStr(),
      merchant: '', note: ''
    };
  }
  function defaultAccountId() { var a = liveAccounts(); return a.length ? a[0].id : null; }
  function secondAccountId() { var a = liveAccounts(); return a.length > 1 ? a[1].id : null; }
  function nowTimeStr() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function openAdd(editId) {
    if (editId) {
      var t = state.txns.find(function (x) { return x.id === editId; });
      if (!t) return;
      state.editId = editId;
      state.addDraft = {
        type: t.type, amount: Core.centsToYuan(t.amount),
        accountId: t.account, accountToId: t.accountTo || secondAccountId(),
        categoryId: t.category, date: t.date, time: t.time || '',
        merchant: t.merchant || '', note: t.note || ''
      };
    } else {
      state.editId = null;
      state.addDraft = newDraft();
    }
    nav('add');
  }

  function tplAdd() {
    var d = state.addDraft || newDraft();
    state.addDraft = d;
    var editing = !!state.editId;
    var tabs = [
      { id: 'expense', label: '支出' }, { id: 'income', label: '收入' }, { id: 'transfer', label: '转账' }
    ];
    var catCells = '';
    if (d.type !== 'transfer') {
      var cats = state.categories.filter(function (c) { return c.type === d.type && !c.deleted && !c.parentId; });
      var selected = categoryById(d.categoryId);
      var selRoot = selected ? (Core.rootCategoryOf(selected.id, state.categories) || selected) : null;
      var kids = selRoot ? childrenOf(selRoot.id, d.type) : [];
      var subGrid = '';
      if (kids.length) {
        subGrid = '<div class="small muted" style="padding:2px 2px 0">「' + esc(selRoot.name) + '」的二级分类：</div>' +
          '<div class="cat-grid">' +
          '<button class="cat-cell ' + (d.categoryId === selRoot.id ? 'active' : '') + '" data-action="add:pickCat" data-id="' + esc(selRoot.id) + '"><span class="cc-icon">🎯</span><span>不细分</span></button>' +
          kids.map(function (k) {
            return '<button class="cat-cell ' + (d.categoryId === k.id ? 'active' : '') + '" data-action="add:pickCat" data-id="' + esc(k.id) + '">' +
              '<span class="cc-icon">' + k.icon + '</span><span>' + esc(k.name) + '</span></button>';
          }).join('') + '</div>';
      }
      catCells = '<div class="sec-head"><b>选择分类</b><button class="link small" data-action="nav:categories">管理</button></div>' +
        '<div class="cat-grid">' + cats.map(function (c) {
          return '<button class="cat-cell ' + (selRoot && selRoot.id === c.id ? 'active' : '') + '" data-action="add:pickCat" data-id="' + esc(c.id) + '">' +
            '<span class="cc-icon">' + c.icon + '</span><span>' + esc(c.name) + '</span></button>';
        }).join('') + '</div>' + subGrid;
    }
    var transferRow = d.type === 'transfer'
      ? formItem('转入账户', '<button class="btn ghost small" data-action="add:pickAcc" data-field="accountToId">' + esc(accountName(d.accountToId)) + ' ›</button>')
      : '';
    var amountDisplay = d.amount || '0.00';
    return '<div class="page-title">' + (editing ? '编辑记录' : '记一笔') + '</div>' +
      '<div class="type-tabs">' + tabs.map(function (t) {
        return '<button class="' + (d.type === t.id ? 'active' : '') + '" data-action="add:type" data-id="' + t.id + '">' + t.label + '</button>';
      }).join('') + '</div>' +
      '<div class="amount-box"><div class="ab-row"><span class="ab-cur">¥</span><span class="ab-num" id="ab-num">' + esc(amountDisplay) + '</span></div>' +
        '<div class="small muted" style="padding-top:8px">' + (d.type === 'expense' ? '支出' : d.type === 'income' ? '收入' : '转账') + '金额</div></div>' +
      '<div class="form-row">' +
        formItem(d.type === 'transfer' ? '转出账户' : '账户', '<button class="btn ghost small" data-action="add:pickAcc" data-field="accountId">' + esc(accountName(d.accountId)) + ' ›</button>') +
        transferRow +
        formItem('日期', '<input type="date" id="f-date" value="' + esc(d.date) + '" max="' + todayDateStr() + '">') +
        formItem('时间', '<input type="time" id="f-time" value="' + esc(d.time) + '">') +
        (d.type === 'transfer' ? '' : formItem('商户', '<input id="f-merchant" placeholder="选填，如 肯德基" value="' + esc(d.merchant) + '">')) +
        formItem('备注', '<input id="f-note" placeholder="选填" value="' + esc(d.note) + '">') +
      '</div>' +
      catCells +
      keypadHtml() +
      '<button class="btn primary block" style="padding:14px 0;margin-top:4px" data-action="add:save">' + (editing ? '保存修改' : '保存') + '</button>';
  }
  function formItem(label, valHtml) {
    return '<div class="form-item"><label>' + esc(label) + '</label><div class="fi-val">' + valHtml + '</div></div>';
  }
  function keypadHtml() {
    var keys = ['1', '2', '3', '⌫', '4', '5', '6', 'C', '7', '8', '9', '.', '0'];
    var html = keys.map(function (k) {
      return '<button data-action="add:key" data-key="' + (k === '⌫' ? 'back' : k === 'C' ? 'clear' : k) + '">' + k + '</button>';
    }).join('');
    html += '<button data-action="add:key" data-key="00">00</button><button class="op" style="visibility:hidden">·</button>';
    return '<div class="keypad">' + html + '</div>';
  }

  function draftSyncFromDom() {
    var d = state.addDraft;
    if (!d) return;
    var date = $('#f-date'), time = $('#f-time'), mer = $('#f-merchant'), note = $('#f-note');
    if (date) d.date = date.value || d.date;
    if (time) d.time = time.value;
    if (mer) d.merchant = mer.value.trim();
    if (note) d.note = note.value.trim();
  }

  function keyInput(k) {
    var d = state.addDraft; if (!d) return;
    var a = d.amount;
    if (k === 'clear') a = '';
    else if (k === 'back') a = a.slice(0, -1);
    else if (k === '.') { if (a.indexOf('.') < 0) a = (a || '0') + '.'; }
    else if (k === '00') { if (a.indexOf('.') < 0) a = (a || '0') + '00'; else if (a.split('.')[1].length === 1) a += '0'; }
    else { // 数字
      if (a.indexOf('.') >= 0) {
        if (a.split('.')[1].length >= 2) return;
      } else if (a.replace('.', '').length >= 8) return;
      if (a === '0') a = k; else a += k;
    }
    d.amount = a;
    var el = $('#ab-num');
    if (el) el.textContent = d.amount || '0.00';
  }

  function saveAdd() {
    draftSyncFromDom();
    var d = state.addDraft;
    var cents = Core.yuanToCents(d.amount);
    if (cents == null || cents <= 0) { toast('请输入大于 0 的金额（最多两位小数）', 'warn'); return; }
    if (!d.accountId) { toast('请选择账户', 'warn'); return; }
    if (d.type === 'transfer' && (!d.accountToId || d.accountToId === d.accountId)) { toast('转账需要两个不同的账户', 'warn'); return; }
    if (d.type !== 'transfer' && !d.categoryId) {
      toast('已记为「未分类」，可稍后在明细页批量归类', 'warn');
    }
    var editing = !!state.editId;
    var before = null;   // 编辑前的快照，保存失败时回滚
    var txn = null;      // 本次新增/编辑的交易对象
    if (editing) {
      var t = state.txns.find(function (x) { return x.id === state.editId; });
      if (t) {
        before = JSON.stringify(t);
        txn = t;
        t.type = d.type; t.amount = cents;
        t.account = d.accountId; t.accountTo = d.type === 'transfer' ? d.accountToId : null;
        t.category = d.type === 'transfer' ? null : d.categoryId;
        t.date = d.date; t.time = d.time; t.merchant = d.merchant; t.note = d.note;
      }
    } else {
      txn = {
        id: Core.newId('t'), date: d.date, time: d.time,
        type: d.type, amount: cents,
        account: d.accountId, accountTo: d.type === 'transfer' ? d.accountToId : null,
        category: d.type === 'transfer' ? null : d.categoryId,
        merchant: d.merchant, note: d.note,
        source: 'manual', rawId: '', status: ''
      };
      state.txns.push(txn);
    }
    state.addDraft = null; state.editId = null;
    // S2：保存确认落盘后才提示入账；失败则回滚本地乐观更新并重渲染，
    // 保证界面与事实源一致（此前会同时出现"已记一笔"和"保存失败"，
    // 且未落盘的交易一直挂在界面上，刷新后凭空消失）。
    var rollback = function () {
      if (before != null && txn) {
        var restored = JSON.parse(before);
        for (var k in restored) txn[k] = restored[k];
      } else if (txn) {
        var i = state.txns.indexOf(txn);
        if (i >= 0) state.txns.splice(i, 1);
      }
      render();
    };
    save().then(function (ok) {
      if (ok) toast(editing ? '已修改' : '已记一笔 ' + Core.fmtMoney(cents) + ' 元');
      else rollback();
    }, rollback);
    nav('home');
  }

  function pickAccountSheet(field) {
    var d = state.addDraft;
    var rows = liveAccounts().map(function (a) {
      return '<button class="set-item" data-action="add:acc-set" data-field="' + field + '" data-id="' + esc(a.id) + '" style="width:100%">' +
        '<span class="si-icon">' + accTypeIcon(a.type) + '</span>' +
        '<span class="si-main">' + esc(a.name) + '</span>' +
        '<span class="small muted">' + Core.fmtMoney(Core.accountBalance(a, state.txns)) + '</span></button>';
    }).join('');
    openSheet(field === 'accountId' ? '选择账户' : '转入账户', rows || '<div class="empty">还没有账户</div>');
  }
  function accTypeIcon(type) {
    return { wechat: '💬', alipay: '🅰️', bank: '🏦', cash: '💵' }[type] || '💰';
  }

  /* ================= 明细 ================= */
  function filteredTxns() {
    var f = state.listFilters;
    return Core.visibleTxns(state.txns).filter(function (t) {
      if (t.date.slice(0, 7) !== state.ym) return false;
      if (f.type && t.type !== f.type) return false;
      if (f.account && t.account !== f.account && t.accountTo !== f.account) return false;
      if (f.category) {
        if (f.category === '__none__') { if (t.category && t.type !== 'transfer') return false; if (t.type === 'transfer') return false; }
        else if (t.category !== f.category) return false;
      }
      if (f.q) {
        var hay = (t.merchant + ' ' + t.note + ' ' + (categoryById(t.category) || {}).name).toLowerCase();
        if (hay.indexOf(f.q.toLowerCase()) < 0) return false;
      }
      return true;
    });
  }

  function tplList() {
    var f = state.listFilters;
    var txns = filteredTxns();
    var groups = Core.groupByDay(txns);
    var mt = mergedTargetsMap();
    var hasUncategorized = state.txns.some(function (t) {
      return !t.mappedTo && t.type !== 'transfer' && !t.category && t.date.slice(0, 7) === state.ym;
    });

    var tagHtml = '';
    if (f.type) tagHtml += '<span class="ftag">' + ({ expense: '支出', income: '收入', transfer: '转账' })[f.type] + '</span>';
    if (f.account) tagHtml += '<span class="ftag">' + esc(accountName(f.account)) + '</span>';
    if (f.category) tagHtml += '<span class="ftag">' + (f.category === '__none__' ? '未分类' : esc((categoryById(f.category) || {}).name || '?')) + '</span>';

    var body = groups.length ? groups.map(function (g) {
      var rows = g.txns.map(function (t) {
        if (state.selectMode) {
          var on = !!state.selectedIds[t.id];
          return '<div class="txn-item" data-action="list:toggleSel" data-id="' + esc(t.id) + '" style="' + (on ? 'background:#fdf1dc' : '') + '">' +
            '<span style="font-size:17px">' + (on ? '✅' : '⬜️') + '</span>' +
            '<div class="t-main"><div class="t-title">' + esc(txnTitle(t)) + '</div><div class="t-sub">' + esc(txnSub(t)) + '</div></div>' +
            '<div class="t-amt ' + (t.type === 'income' ? 'income' : t.type === 'transfer' ? 'transfer' : 'expense') + '">' + amtStr(t) + '</div></div>';
        }
        return txnRowHtml(t, mt);
      }).join('');
      return '<div class="day-head"><span>' + Core.fmtDateCN(g.date) + '</span><span>支出 ' + Core.fmtMoney(g.dayExpense) +
        (g.dayIncome ? ' · 收入 ' + Core.fmtMoney(g.dayIncome) : '') + '</span></div>' + rows;
    }).join('') : '<div class="empty"><div class="e-icon">🔍</div>本月没有符合条件的记录</div>';

    var selBar = state.selectMode
      ? '<div class="card" style="position:fixed;bottom:calc(70px + var(--safe-b));left:14px;right:14px;max-width:492px;margin:0 auto;display:flex;gap:10px;z-index:40">' +
        '<button class="btn grow" data-action="list:cancelSel">取消</button>' +
        '<button class="btn primary grow" data-action="list:applySel">归为分类（已选 ' + Object.keys(state.selectedIds).length + '）</button></div>'
      : '';

    return tplMonthBar() +
      '<div class="filter-bar">' +
        '<input type="search" placeholder="搜索商户 / 备注" value="' + esc(f.q) + '" data-input="list:q">' +
        '<button class="fb-btn ' + (f.type || f.account || f.category ? 'on' : '') + '" data-action="list:filterSheet">筛选</button>' +
        (hasUncategorized && !state.selectMode ? '<button class="fb-btn" data-action="list:startSel">批量归类</button>' : '') +
      '</div>' +
      (tagHtml ? '<div class="filter-tags">' + tagHtml + '</div>' : '') +
      '<div class="txn-list">' + body + '</div>' + selBar;
  }

  function filterSheet() {
    var f = state.listFilters;
    var catOpts = ['<option value="">全部分类</option>', '<option value="__none__"' + (f.category === '__none__' ? ' selected' : '') + '>未分类</option>']
      .concat(state.categories.filter(function (c) { return c.type === 'expense' || c.type === 'income'; }).map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (f.category === c.id ? ' selected' : '') + '>' + c.icon + ' ' + esc(c.name) + '</option>';
      })).join('');
    var accOpts = ['<option value="">全部账户</option>'].concat(liveAccounts().map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (f.account === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>';
    })).join('');
    openSheet('筛选明细',
      '<div class="form-row">' +
      formItem('类型', '<select data-change="filter:type"><option value="">全部</option><option value="expense"' + (f.type === 'expense' ? ' selected' : '') + '>支出</option><option value="income"' + (f.type === 'income' ? ' selected' : '') + '>收入</option><option value="transfer"' + (f.type === 'transfer' ? ' selected' : '') + '>转账</option></select>') +
      formItem('账户', '<select data-change="filter:account">' + accOpts + '</select>') +
      formItem('分类', '<select data-change="filter:category">' + catOpts + '</select>') +
      '</div>' +
      '<div class="row" style="gap:10px;margin-top:12px">' +
      '<button class="btn grow" data-action="list:clearFilter">重置</button>' +
      '<button class="btn primary grow" data-action="sheet:close">完成</button></div>');
  }

  function txnDetailSheet(id) {
    var t = state.txns.find(function (x) { return x.id === id; });
    if (!t) return;
    var typeLabel = { expense: '支出', income: '收入', transfer: '转账' }[t.type];
    var rows =
      '<div class="map-row"><span class="muted">金额</span><span style="margin-left:auto;font-weight:700">' + (t.type === 'income' ? '+' : '−') + Core.fmtMoney(t.amount) + '</span></div>' +
      '<div class="map-row"><span class="muted">类型</span><span style="margin-left:auto">' + typeLabel + (t.refundFlag ? '（退款）' : '') + '</span></div>' +
      '<div class="map-row"><span class="muted">日期</span><span style="margin-left:auto">' + esc(t.date) + ' ' + esc(t.time || '') + '</span></div>' +
      (t.type === 'transfer'
        ? '<div class="map-row"><span class="muted">账户</span><span style="margin-left:auto">' + esc(accountName(t.account)) + ' → ' + esc(accountName(t.accountTo)) + '</span></div>'
        : '<div class="map-row"><span class="muted">账户</span><span style="margin-left:auto">' + esc(accountName(t.account)) + '</span></div>' +
          '<div class="map-row"><span class="muted">分类</span><span style="margin-left:auto">' + (txnCategory(t) ? txnCategory(t).icon + ' ' + esc(txnCategory(t).name) : '未分类') + '</span></div>') +
      '<div class="map-row"><span class="muted">商户/对方</span><span style="margin-left:auto">' + esc(t.merchant || '—') + '</span></div>' +
      '<div class="map-row"><span class="muted">备注</span><span style="margin-left:auto">' + esc(t.note || '—') + '</span></div>' +
      '<div class="map-row"><span class="muted">来源</span><span style="margin-left:auto">' + (t.source === 'manual' ? '手动记账' : '导入 · ' + (SOURCE_NAME[t.source] || t.source)) + '</span></div>';

    // 去重关系
    if (t.mappedTo) {
      var kept = state.txns.find(function (x) { return x.id === t.mappedTo; });
      rows += '<div class="dup-card"><b>🔗 已合并记录</b><div class="dc-rows">本条与「' + esc(kept ? txnTitle(kept) + ' ' + Core.fmtMoney(kept.amount) : '?') +
        '」是同一笔钱，统计中只计一次。</div>' +
        '<button class="btn danger block" data-action="txn:undoMerge" data-id="' + esc(t.id) + '">撤销合并（恢复为两条独立记录）</button></div>';
    }
    var shadows = state.txns.filter(function (x) { return x.mappedTo === t.id; });
    shadows.forEach(function (s) {
      rows += '<div class="dup-card"><b>🔗 已合并入本条</b><div class="dc-rows">' + esc(SOURCE_NAME[s.source] || s.source) + '：' +
        esc(txnTitle(s)) + ' ¥' + Core.fmtMoney(s.amount) + '（' + esc(s.date) + '，统计中不再重复计入）</div>' +
        '<button class="btn ghost block" data-action="txn:undoMerge" data-id="' + esc(s.id) + '">撤销这条合并</button></div>';
    });

    // V2.3.1 退款冲销关联
    if (t.type === 'income' && t.refundFlag) {
      if (t.refundOf) {
        var src = state.txns.find(function (x) { return x.id === t.refundOf; });
        rows += '<div class="dup-card" style="border-color:#dcfce7"><b>↩️ 已冲销原支出</b>' +
          '<div class="dc-rows">关联「' + esc(src ? txnTitle(src) : '?') + ' ¥' + (src ? Core.fmtMoney(src.amount) : '?') + '」，本分类月支出已相应减少，本条不计入收入。</div>' +
          '<button class="btn ghost block" data-action="refund:unlink" data-id="' + esc(t.id) + '">撤销关联</button></div>';
      } else {
        var rfMatches = Core.matchRefunds(state.txns).filter(function (x) { return x.refund.id === t.id; });
        var cands = rfMatches.length ? rfMatches[0].candidates : [];
        rows += '<div class="dup-card"><b>↩️ 退款冲销</b><div class="dc-rows">关联原支出后冲减其分类支出（而非计为收入）。</div>' +
          (cands.length ? cands.slice(0, 5).map(function (c) {
            return '<button class="btn block" style="margin-top:6px" data-action="refund:link" data-id="' + esc(t.id) + '" data-target="' + esc(c.id) + '">' +
              '关联：' + esc(txnTitle(c)) + ' ¥' + Core.fmtMoney(c.amount) + '（' + esc(c.date) + '）</button>';
          }).join('') : '<div class="small muted">未找到匹配的原支出（需商户匹配、金额足够、90 天内）</div>') + '</div>';
      }
    }

    // V2.3.2 报销标记与闭环
    if (t.type === 'expense') {
      var closedIncome = state.txns.find(function (x) { return x.type === 'income' && x.reimburseOf === t.id && !x.mappedTo; });
      if (closedIncome) {
        rows += '<div class="dup-card" style="border-color:#dcfce7"><b>✅ 报销已闭环</b>' +
          '<div class="dc-rows">报销款 ¥' + Core.fmtMoney(closedIncome.amount) + '（' + esc(closedIncome.date) + '）已关联。本笔不计个人支出，报销款不计收入。</div>' +
          '<button class="btn ghost block" data-action="reim:unlink" data-id="' + esc(closedIncome.id) + '">撤销闭环</button></div>';
      } else if (t.reimburseFlag) {
        var sugg = Core.matchReimbursements(state.txns).suggestions.filter(function (s) {
          return s.candidates.some(function (c) { return c.id === t.id; });
        });
        rows += '<div class="dup-card"><b>🧾 待报销</b><div class="dc-rows">本笔为垫付，待报销到账后关联冲销。</div>' +
          (sugg.length ? sugg.map(function (s) {
            return '<button class="btn block" style="margin-top:6px" data-action="reim:doLink" data-inc="' + esc(s.income.id) + '" data-exp="' + esc(t.id) + '">' +
              '关联报销款：' + esc(s.income.merchant || '收入') + ' ¥' + Core.fmtMoney(s.income.amount) + '（' + esc(s.income.date) + '）</button>';
          }).join('') : '') +
          '<button class="btn ghost block" style="margin-top:6px" data-action="reim:unmark" data-id="' + esc(t.id) + '">取消待报销标记</button></div>';
      } else {
        rows += '<button class="btn block" style="margin-bottom:10px" data-action="reim:mark" data-id="' + esc(t.id) + '">🧾 标记为待报销</button>';
      }
    }
    if (t.type === 'income' && t.reimburseOf) {
      var adv = state.txns.find(function (x) { return x.id === t.reimburseOf; });
      rows += '<div class="dup-card" style="border-color:#dcfce7"><b>🧾 报销款</b>' +
        '<div class="dc-rows">已关联垫付「' + esc(adv ? txnTitle(adv) : '?') + '」，双方不计入收支统计。</div>' +
        '<button class="btn ghost block" data-action="reim:unlink" data-id="' + esc(t.id) + '">撤销关联</button></div>';
    }

    // V2.3.3 周期账标识
    if (t.recurringKey) {
      rows += '<div class="dup-card"><b>🔁 周期账</b><div class="dc-rows">本笔由周期记账模板自动生成（' + esc(t.recurringKey) + '），可在「我的-周期记账」中撤销。</div></div>';
    }

    openSheet('交易详情', rows +
      '<div class="row" style="gap:10px;margin-top:14px">' +
      '<button class="btn danger grow" data-action="txn:delete" data-id="' + esc(t.id) + '">删除</button>' +
      '<button class="btn primary grow" data-action="txn:edit" data-id="' + esc(t.id) + '">编辑</button></div>');
  }

  /* ================= 统计 ================= */
  function tplStats() {
    var y = +state.ym.slice(0, 4), m = +state.ym.slice(5, 7);
    var agg = Core.aggregate(state.txns, { year: y, month: m, categories: state.categories });
    var budgets = state.settings.budgets || { total: 0, cats: {} };

    // V2.3.4 一级/二级聚合：默认按一级（根分类）聚合，可切二级明细
    var catAggSource = state.statsView === 'root' ? Core.rollupByRoot(agg.byCategory, state.categories) : agg.byCategory;
    var catAgg = [];
    Object.keys(catAggSource).forEach(function (cid) {
      var c = categoryById(cid);
      // V2.2.1 必要性筛选（一级视图按根分类必要性，二级视图按自身）
      if (state.statNec) {
        var necCat = state.statsView === 'root' ? (Core.rootCategoryOf(cid, state.categories) || c) : c;
        if (!necCat || (necCat.necessity || '') !== state.statNec) return;
      }
      catAgg.push({
        id: cid, name: c ? c.name : '未分类', icon: c ? c.icon : '❓',
        sum: catAggSource[cid].sum, count: catAggSource[cid].count
      });
    });
    catAgg.sort(function (a, b) { return (state.statRank === 'count' ? b.count - a.count : b.sum - a.sum); });
    var maxVal = state.statRank === 'count'
      ? Math.max.apply(null, catAgg.map(function (c) { return c.count; }).concat([1]))
      : Math.max.apply(null, catAgg.map(function (c) { return c.sum; }).concat([1]));
    var ranking = catAgg.slice(0, 12).map(function (c, i) {
      var v = state.statRank === 'count' ? c.count : c.sum;
      var pct = Math.round(v / maxVal * 100);
      var b = (budgets.cats || {})[c.id];
      var budgetBar = '';
      if (b > 0 && state.statRank === 'amount') {
        var over = c.sum > b;
        budgetBar = '<div style="padding:2px 0 8px 34px">' +
          '<div class="progress mini"><i class="' + (over ? 'over' : c.sum / b > 0.8 ? 'warn' : '') + '" style="width:' + Math.min(c.sum / b * 100, 100) + '%"></i></div>' +
          '<div class="small" style="color:' + (over ? 'var(--red)' : 'var(--ink-3)') + '">预算 ' + Core.fmtMoney(b) + (over ? ' · 已超支' : '') + '</div></div>';
      }
      return '<div>' +
        '<div class="rank-row"><span class="rr-icon">' + c.icon + '</span>' +
        '<span style="min-width:56px">' + esc(c.name) + '</span>' +
        '<span class="rr-bar"><i style="width:' + pct + '%;background:' + Charts.PALETTE[i % Charts.PALETTE.length] + '"></i></span>' +
        '<span class="rr-val">' + (state.statRank === 'count' ? c.count + ' 笔' : Core.fmtMoney(c.sum)) + '</span>' +
        '<span class="rr-cnt">' + (agg.expense ? (c.sum / agg.expense * 100).toFixed(1) + '%' : '') + '</span></div>' +
        budgetBar + '</div>';
    }).join('');

    var donutItems = catAgg.slice(0, 6).map(function (c) { return { label: c.name, value: c.sum }; });
    var legend = catAgg.slice(0, 6).map(function (c, i) {
      return '<div class="legend-item"><i style="background:' + Charts.PALETTE[i % Charts.PALETTE.length] + '"></i>' +
        '<span>' + c.icon + ' ' + esc(c.name) + '</span><span class="li-pct">' + (agg.expense ? (c.sum / agg.expense * 100).toFixed(1) : 0) + '%</span></div>';
    }).join('');

    // V2.2.1 必要性构成（需要/想要/未标记），点击可筛选排行
    var necRow = '';
    if (agg.expense > 0) {
      var np = function (v) { return Math.round(v / agg.expense * 100); };
      var necBtn = function (val, label, bg, fg) {
        var on = state.statNec === val;
        var v = val === 'need' ? agg.need : val === 'want' ? agg.want : agg.necessityNone;
        return '<button class="nec-pill" data-action="stats:nec" data-id="' + val + '" style="flex:' + Math.max(np(v), 1) +
          ';background:' + bg + ';color:' + fg + (on ? ';outline:2px solid currentColor;outline-offset:-2px;font-weight:700' : '') + '">' +
          label + ' ' + np(v) + '%</button>';
      };
      necRow = '<div class="card"><div class="row small muted" style="margin-bottom:6px"><span>消费构成（点击筛选排行）</span>' +
        (state.statNec !== '' ? '<button class="link small" style="margin-left:auto" data-action="stats:nec" data-id="">清除筛选</button>' : '') + '</div>' +
        '<div class="row" style="gap:8px">' +
        necBtn('need', '必要', '#dcfce7', '#15803d') +
        necBtn('want', '想要', '#ffedd5', '#c2410c') +
        necBtn('', '未标记', '#f1f5f9', '#64748b') +
        '</div></div>';
    }

    var series = Core.monthlySeries(state.txns, 12);
    var bars = Charts.bars({
      labels: series.map(function (s) { return Number(s.ym.slice(5, 7)) + '月'; }),
      series: [
        { name: '收入', color: '#22c55e', values: series.map(function (s) { return s.income; }) },
        { name: '支出', color: '#ef4444', values: series.map(function (s) { return s.expense; }) }
      ]
    });

    return tplMonthBar() +
      '<div class="stat-cards">' +
        '<div class="sc"><span>收入</span><b style="color:var(--green)">' + Core.fmtMoney(agg.income) + '</b></div>' +
        '<div class="sc"><span>支出</span><b>' + Core.fmtMoney(agg.expense) + '</b></div>' +
        '<div class="sc"><span>结余</span><b style="color:' + (agg.balance >= 0 ? 'var(--green)' : 'var(--red)') + '">' + Core.fmtMoney(agg.balance) + '</b></div>' +
      '</div>' +
      '<div class="card"><div class="donut-row">' + Charts.donut(donutItems, { centerLabel: '支出构成', centerValue: agg.expense ? '¥' + Core.fmtMoney(agg.expense) : '' }) +
        '<div class="d-legend">' + (legend || '<div class="muted small">本月暂无支出</div>') + '</div></div></div>' +
      necRow +
      '<div class="card"><div class="sec-head" style="margin:0 0 6px"><b>分类排行</b><span>' +
        '<button class="link small" data-action="stats:rank" data-id="amount" style="' + (state.statRank === 'amount' ? 'font-weight:700' : '') + '">按金额</button>' +
        '<button class="link small" data-action="stats:rank" data-id="count" style="margin-left:8px;' + (state.statRank === 'count' ? 'font-weight:700' : '') + '">按笔数</button>' +
        '<span style="margin-left:10px;color:var(--bg-3)">|</span>' +
        '<button class="link small" data-action="stats:view" data-id="root" style="margin-left:8px;' + (state.statsView === 'root' ? 'font-weight:700' : '') + '">一级</button>' +
        '<button class="link small" data-action="stats:view" data-id="leaf" style="margin-left:8px;' + (state.statsView === 'leaf' ? 'font-weight:700' : '') + '">二级</button></span></div>' +
        (ranking || '<div class="muted small" style="padding:8px 0">暂无数据</div>') + '</div>' +
      '<div class="sec-head"><b>近 12 个月收支趋势</b></div>' +
      '<div class="card">' + bars + '</div>';
  }

  /* ================= 设置 ================= */
  function tplSettings() {
    var lock = state.settings.lock || { enabled: false };
    var txnCount = state.txns.length;
    return '<div class="page-title">我的</div>' +
      '<div class="set-group"><div class="sg-title">账本</div>' +
        setItem('🏦', '账户管理', liveAccounts().length + ' 个账户', 'nav:accounts') +
        setItem('🏷️', '分类管理', state.categories.length + ' 个分类 · 支持二级', 'nav:categories') +
        setItem('📥', '导入账单', '微信 / 支付宝 / 银行流水', 'nav:import') +
        setItem('🔁', '周期记账', (state.settings.recurring || []).length + ' 个模板', 'nav:recurring') +
        setItem('🧾', '报销管理', '垫付标记 / 待报销清单', 'nav:reimburse') +
      '</div>' +
      '<div class="set-group"><div class="sg-title">预算与体检</div>' +
        setItem('💰', '预算管理', (state.settings.budgets && state.settings.budgets.total) ? '总预算 ¥' + Core.fmtMoney(state.settings.budgets.total) + '/月' : '月度总/分类预算', 'nav:budget') +
        setItem('🩺', '消费体检', '月度报告 / 异常检测 / 订阅清单', 'nav:health') +
      '</div>' +
      '<div class="set-group"><div class="sg-title">数据安全</div>' +
        setItem('🔐', '应用锁', lock.enabled ? '已开启（数据加密存储）' : '未开启', 'set:lock') +
        setItem('💾', '导出 JSON 备份', '全量数据，含 ' + txnCount + ' 笔交易', 'set:exportJson') +
        setItem('📄', '导出 CSV 明细', 'Excel 可直接打开', 'set:exportCsv') +
        setItem('♻️', '从备份恢复', '选择 JSON 备份文件', 'set:restore') +
        setItem('🗑️', '清空所有数据', '需输入"清空"确认', 'set:clear') +
      '</div>' +
      '<div class="set-group"><div class="sg-title">关于</div>' +
        setItem('🛡️', '隐私承诺', '零网络请求 · 数据仅存本机', 'set:privacy') +
        setItem('📖', '账单导出教程', '微信 / 支付宝 / 招行 / 中行', 'set:howto') +
        setItem('📲', '安装到主屏（PWA）', '浏览器菜单选择"安装应用/添加到主屏幕"', 'set:pwa') +
      '</div>' +
      '<div class="small muted" style="text-align:center;padding:10px 0">小账本 v' + APP_VERSION + ' · 本地优先记账</div>' +
      '<input type="file" id="file-restore" accept=".json,application/json" class="hidden">';
  }
  function setItem(icon, title, sub, action) {
    return '<button class="set-item" data-action="' + action + '" style="width:100%;text-align:left">' +
      '<span class="si-icon">' + icon + '</span><span class="si-main"><div>' + esc(title) + '</div><div class="si-sub">' + esc(sub) + '</div></span>' +
      '<span class="si-arrow">›</span></button>';
  }

  /* ---------- 账户管理 ---------- */
  function tplAccounts() {
    var rows = state.accounts.slice().sort(function (a, b) {
      if (!!a.deleted !== !!b.deleted) return a.deleted ? 1 : -1;
      return (a.order || 0) - (b.order || 0);
    }).map(function (a) {
      var bal = a.deleted ? null : Core.accountBalance(a, state.txns);
      return '<div class="set-item">' +
        '<span class="si-icon">' + accTypeIcon(a.type) + '</span>' +
        '<span class="si-main"><div>' + esc(a.name) + (a.deleted ? ' <span class="chip">已删除</span>' : '') + '</div>' +
        '<div class="si-sub">' + ACC_TYPE_NAME[a.type] + (bal != null ? ' · 余额 ' + Core.fmtMoney(bal) : '') + '</div></span>' +
        (a.deleted
          ? '<button class="btn small" data-action="acc:restore" data-id="' + esc(a.id) + '">恢复</button>'
          : '<button class="btn small" data-action="acc:edit" data-id="' + esc(a.id) + '">编辑</button>') +
        '</div>';
    }).join('');
    return '<div class="page-title">账户管理</div>' + rows +
      '<button class="btn primary block" data-action="acc:add">＋ 新增账户</button>' +
      '<div class="small muted" style="padding:10px 4px">删除账户不会删除历史交易；交易将显示为「已删除账户」，可随时恢复账户。</div>';
  }
  var ACC_TYPE_NAME = { wechat: '微信零钱', alipay: '支付宝', bank: '银行卡', cash: '现金' };

  function accountSheet(acc) {
    var isNew = !acc;
    var typeOpts = Object.keys(ACC_TYPE_NAME).map(function (k) {
      return '<option value="' + k + '"' + (acc && acc.type === k ? ' selected' : '') + '>' + ACC_TYPE_NAME[k] + '</option>';
    }).join('');
    openSheet(isNew ? '新增账户' : '编辑账户',
      '<div class="form-row">' +
      formItem('名称', '<input id="acc-name" placeholder="如 招行卡(1234)" value="' + esc(acc ? acc.name : '') + '">') +
      formItem('类型', '<select id="acc-type">' + typeOpts + '</select>') +
      formItem('初始余额', '<input id="acc-init" type="number" step="0.01" placeholder="0.00" value="' + (acc && acc.initialBalance ? Core.centsToYuan(acc.initialBalance) : '') + '">') +
      formItem('别名', '<input id="acc-alias" placeholder="导入匹配用，逗号分隔" value="' + esc(acc && acc.aliases ? acc.aliases.join(',') : '') + '">') +
      '</div>' +
      '<button class="btn primary block" data-action="acc:save" data-id="' + esc(acc ? acc.id : '') + '">' + (isNew ? '创建' : '保存') + '</button>' +
      (!isNew ? '<button class="btn danger block" style="margin-top:10px" data-action="acc:del" data-id="' + esc(acc.id) + '">删除此账户</button>' : ''));
    var sel = $('#acc-type');
    if (sel && isNew) { /* default wechat */ }
  }

  /* ---------- 分类管理 ---------- */
  function wouldCreateCycle(catId, parentId) {
    // 父级链上出现自身 → 成环
    var byId = {};
    state.categories.forEach(function (c) { byId[c.id] = c; });
    var cur = byId[parentId], guard = 0;
    while (cur && guard++ < 10) {
      if (catId && cur.id === catId) return true;
      cur = byId[cur.parentId];
    }
    return false;
  }

  function childrenOf(catId, type) {
    return state.categories.filter(function (c) {
      return c.parentId === catId && (!type || c.type === type);
    });
  }

  function tplCategories() {
    var NEC_NAME = { need: '必要', want: '想要', save: '储蓄' };
    function catRow(c, indent) {
      var kw = (c.keywords || []).join('、');
      return '<div class="set-item" style="' + (indent ? 'margin-left:22px;' : '') + '"><span class="si-icon">' + c.icon + '</span>' +
        '<span class="si-main"><div>' + (indent ? '└ ' : '') + esc(c.name) +
        (c.parentId ? ' <span class="chip">二级</span>' : '') +
        (c.necessity ? ' <span class="chip" style="background:' + (c.necessity === 'need' ? '#dcfce7;color:#15803d' : c.necessity === 'want' ? '#ffedd5;color:#c2410c' : '#e0e7ff;color:#4338ca') + '">' + (NEC_NAME[c.necessity] || c.necessity) + '</span>' : '') + '</div>' +
        (kw ? '<div class="si-sub">关键词：' + esc(kw.slice(0, 40)) + (kw.length > 40 ? '…' : '') + '</div>' : '') + '</span>' +
        '<button class="btn small" data-action="cat:edit" data-id="' + esc(c.id) + '">编辑</button></div>';
    }
    function sec(type, title) {
      var rows = state.categories.filter(function (c) { return c.type === type && !c.parentId; }).map(function (c) {
        var kids = childrenOf(c.id, type);
        return catRow(c, false) + kids.map(function (k) { return catRow(k, true); }).join('');
      }).join('');
      return '<div class="set-group"><div class="sg-title">' + title + '</div>' + rows +
        '<button class="btn block" data-action="cat:add" data-type="' + type + '">＋ 新增' + (type === 'expense' ? '支出' : '收入') + '分类</button></div>';
    }
    return '<div class="page-title">分类管理</div>' +
      '<div class="row" style="justify-content:space-between;align-items:center;margin:-6px 2px 12px">' +
      '<span class="small muted">关键词用于导入自动归类（最长匹配优先）；二级分类统计时并入一级</span>' +
      '<button class="btn small" data-action="cat:batchNec">批量设必要性</button></div>' +
      sec('expense', '支出分类') + sec('income', '收入分类');
  }

  function batchNecSheet() {
    var cats = state.categories.filter(function (c) { return c.type === 'expense'; });
    openSheet('批量设置必要性',
      '<div class="small muted" style="margin-bottom:6px">勾选支出分类，统一标记 必要（need）/ 想要（want）/ 储蓄（save），供消费体检与统计筛选使用。</div>' +
      '<div class="form-row">' + formItem('设为', '<select id="bn-nec"><option value="need">必要 need</option><option value="want">想要 want</option><option value="save">储蓄 save</option><option value="">清除标记</option></select>') + '</div>' +
      '<div style="max-height:280px;overflow:auto;padding:4px 0">' + cats.map(function (c) {
        return '<div class="map-row"><input type="checkbox" data-bn="' + esc(c.id) + '" style="width:18px;height:18px">' +
          '<span class="mr-key">' + c.icon + ' ' + esc(c.name) + (c.parentId ? '（二级）' : '') + '</span></div>';
      }).join('') + '</div>' +
      '<button class="btn primary block" data-action="cat:batchNecGo">应用到勾选分类</button>');
  }

  var ICON_CHOICES = ['🍜', '🚌', '🛒', '🏠', '🎮', '💊', '📚', '📱', '🎁', '🐶', '✈️', '👕', '☕', '🍺', '🚗', '💼', '🎬', '🏋️', '💇', '📦', '💰', '🏆', '📈', '🧧', '↩️', '🧾', '🎂', '❤️'];

  function categorySheet(cat, type) {
    var isNew = !cat;
    var icons = ICON_CHOICES.map(function (ic) {
      return '<button class="cat-cell ' + (cat && cat.icon === ic ? 'active' : '') + '" data-action="cat:pickIcon" data-icon="' + ic + '" style="padding:6px 2px"><span class="cc-icon">' + ic + '</span></button>';
    }).join('');
    window._catIcon = cat ? cat.icon : '📦';
    // V2.3.4 父级分类 + V2.2.1 必要性
    var t = type || (cat ? cat.type : 'expense');
    var parentOpts = ['<option value="">（一级分类）</option>'].concat(
      state.categories.filter(function (c) {
        return c.type === t && !c.parentId && (!cat || c.id !== cat.id);
      }).map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (cat && cat.parentId === c.id ? ' selected' : '') + '>' + c.icon + ' ' + esc(c.name) + '</option>';
      })).join('');
    var necOpts = [['', '未标记'], ['need', '必要 need'], ['want', '想要 want'], ['save', '储蓄 save']].map(function (o) {
      return '<option value="' + o[0] + '"' + (cat && (cat.necessity || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
    openSheet(isNew ? '新增分类' : '编辑分类',
      '<div class="form-row">' +
      formItem('名称', '<input id="cat-name" placeholder="分类名称" value="' + esc(cat ? cat.name : '') + '">') +
      formItem('父级分类', '<select id="cat-parent">' + parentOpts + '</select>') +
      (t === 'expense' ? formItem('必要性', '<select id="cat-nec">' + necOpts + '</select>') : '') +
      '</div>' +
      '<div class="form-row">' + formItem('关键词', '<input id="cat-kw" placeholder="逗号分隔，如 肯德基,麦当劳" value="' + esc(cat && cat.keywords ? cat.keywords.join(',') : '') + '">') + '</div>' +
      '<div style="padding:10px 4px 4px" class="small muted">图标</div>' +
      '<div class="cat-grid" id="cat-icons">' + icons + '</div>' +
      '<button class="btn primary block" data-action="cat:save" data-id="' + esc(cat ? cat.id : '') + '" data-type="' + esc(t) + '">' + (isNew ? '创建' : '保存') + '</button>' +
      (!isNew ? '<button class="btn danger block" style="margin-top:10px" data-action="cat:del" data-id="' + esc(cat.id) + '">删除此分类</button>' : ''));
  }

  /* ================= V2.2.1 预算管理 ================= */
  function tplBudget() {
    var y = +state.ym.slice(0, 4), m = +state.ym.slice(5, 7);
    var budgets = state.settings.budgets || { total: 0, cats: {} };
    var bst = Core.budgetStatus(state.txns, budgets, { year: y, month: m });
    var rows = bst.cats.filter(function (c) {
      return c.budget > 0 || c.spent > 0;
    }).map(function (c) {
      var cat = categoryById(c.catId);
      var pct = c.pct != null ? Math.round(c.pct * 100) : null;
      return '<div class="set-item" style="flex-wrap:wrap">' +
        '<span class="si-icon">' + (cat ? cat.icon : '❓') + '</span>' +
        '<span class="si-main"><div>' + esc(cat ? cat.name : '未分类') + (c.over ? ' <span class="chip" style="background:#fee2e2;color:var(--red)">超支</span>' : '') + '</div>' +
        '<div class="si-sub">' + Core.fmtMoney(c.spent) + (c.budget ? ' / ' + Core.fmtMoney(c.budget) + (pct != null ? '（' + pct + '%）' : '') : ' · 未设预算') + '</div></span>' +
        '<button class="btn small" data-action="budget:editCat" data-id="' + esc(c.catId) + '">' + (c.budget ? '调整' : '设预算') + '</button>' +
        (c.budget ? '<div style="flex-basis:100%;padding:4px 0 2px"><div class="progress mini"><i class="' + (c.over ? 'over' : c.pct > 0.8 ? 'warn' : '') + '" style="width:' + Math.min(pct || 0, 100) + '%"></i></div></div>' : '') +
        '</div>';
    }).join('');
    return tplMonthBar() +
      '<div class="card"><b>月度总预算</b>' +
      '<div class="dc-rows" style="margin:8px 0 4px">已支出 ' + Core.fmtMoney(bst.total.spent) +
      (budgets.total ? ' / ' + Core.fmtMoney(budgets.total) + '（' + Math.round((bst.total.pct || 0) * 100) + '%）' : ' · 未设置') + '</div>' +
      (budgets.total ? '<div class="progress"><i class="' + (bst.total.over ? 'over' : bst.total.pct > 0.8 ? 'warn' : '') + '" style="width:' + Math.min((bst.total.pct || 0) * 100, 100) + '%"></i></div>' : '') +
      '<button class="btn primary block" style="margin-top:12px" data-action="budget:editTotal">' + (budgets.total ? '调整总预算' : '设置总预算') + '</button></div>' +
      '<div class="sec-head"><b>分类预算</b><span class="small muted">按当月实际支出展示</span></div>' +
      (rows || '<div class="card muted small">本月暂无支出记录</div>');
  }

  function budgetTotalSheet() {
    var budgets = state.settings.budgets || { total: 0, cats: {} };
    openSheet('月度总预算',
      '<div class="small muted" style="margin-bottom:8px">每月支出的上限，超出后首页会显示超支提醒。</div>' +
      '<div class="form-row">' + formItem('金额（元/月）', '<input id="bd-total" type="number" step="0.01" min="0" placeholder="如 3000" value="' + (budgets.total ? Core.centsToYuan(budgets.total) : '') + '">') + '</div>' +
      '<button class="btn primary block" data-action="budget:saveTotal">保存</button>');
  }

  function budgetCatSheet(catId) {
    var budgets = state.settings.budgets || { total: 0, cats: {} };
    var cat = categoryById(catId);
    var cur = (budgets.cats || {})[catId] || 0;
    openSheet('分类预算 — ' + (cat ? cat.name : '未分类'),
      '<div class="form-row">' + formItem('金额（元/月）', '<input id="bd-cat" type="number" step="0.01" min="0" placeholder="0 为清除" value="' + (cur ? Core.centsToYuan(cur) : '') + '">') + '</div>' +
      '<button class="btn primary block" data-action="budget:saveCat" data-id="' + esc(catId) + '">保存</button>');
  }

  /* ================= V2.2.2-V2.2.4 消费体检（月度报告） ================= */
  function anomalyKey(a) { return a.kind + '|' + (a.catId || '') + '|' + (a.merchant || ''); }
  function healthFlags() {
    state.settings.healthFlags = state.settings.healthFlags || {};
    return state.settings.healthFlags;
  }

  function tplHealth() {
    var y = +state.ym.slice(0, 4), m = +state.ym.slice(5, 7);
    var agg = Core.aggregate(state.txns, { year: y, month: m, categories: state.categories });
    var prevYm = ymShift(state.ym, -1);
    var prevAgg = Core.aggregate(state.txns, { year: +prevYm.slice(0, 4), month: +prevYm.slice(5, 7), categories: state.categories });
    var detect = Core.detectAnomalies(state.txns, { year: y, month: m, categories: state.categories });
    var subs = Core.detectSubscriptions(state.txns);

    var mom = prevAgg.expense > 0 ? Math.round((agg.expense - prevAgg.expense) / prevAgg.expense * 100) : null;
    var saveRate = agg.savingsRate != null ? Math.round(agg.savingsRate * 100) + '%' : '—';

    // 必要/想要占比
    var necHtml = '';
    if (agg.expense > 0) {
      var np = function (v) { return Math.round(v / agg.expense * 100); };
      necHtml = '<div class="row" style="gap:8px;margin-top:8px">' +
        '<div class="nec-pill" style="flex:' + Math.max(np(agg.need), 1) + ';background:#dcfce7;color:#15803d">必要 ' + np(agg.need) + '%</div>' +
        '<div class="nec-pill" style="flex:' + Math.max(np(agg.want), 1) + ';background:#ffedd5;color:#c2410c">想要 ' + np(agg.want) + '%</div>' +
        '<div class="nec-pill" style="flex:' + Math.max(np(agg.necessityNone), 1) + ';background:#f1f5f9;color:#64748b">未标记 ' + np(agg.necessityNone) + '%</div></div>';
    }

    var flags = healthFlags();
    var anomalyHtml;
    if (detect.insufficient) {
      anomalyHtml = '<div class="card" style="text-align:center"><div style="font-size:30px">🌱</div>' +
        '<div class="muted" style="padding:6px 0">' + esc(detect.message) + '</div></div>';
    } else {
      anomalyHtml = detect.anomalies.map(function (a) {
        var fk = state.ym + '|' + anomalyKey(a);
        var marked = flags[fk];
        var markBtns = '<div class="row" style="gap:8px;margin-top:6px">' +
          '<button class="btn small grow ' + (marked === 'ok' ? 'primary' : '') + '" data-action="health:flag" data-key="' + esc(fk) + '" data-v="ok">合理</button>' +
          '<button class="btn small grow ' + (marked === 'improve' ? 'primary' : '') + '" data-action="health:flag" data-key="' + esc(fk) + '" data-v="improve">下月改进</button></div>';
        if (a.txnIds && a.txnIds.length) {
          markBtns += '<div class="small muted" style="margin-top:4px">标记会写入相关交易的标志位</div>';
        }
        return '<div class="dup-card" style="border-left:4px solid ' + (a.severity === 'red' ? 'var(--red)' : '#f59e0b') + '">' +
          '<div class="row"><b>' + (a.severity === 'red' ? '🔴' : '🟡') + ' ' + esc(ANOMALY_NAME[a.kind] || a.kind) + '</b>' +
          (marked ? '<span class="chip" style="margin-left:auto">' + (marked === 'ok' ? '已标记合理' : '已标记改进') + '</span>' : '') + '</div>' +
          '<div class="dc-rows">' + esc(a.message) + '</div>' + markBtns + '</div>';
      }).join('');
      if (!detect.anomalies.length) anomalyHtml = '<div class="card" style="text-align:center"><div style="font-size:30px">✅</div><div class="muted" style="padding:6px 0">本月无异常消费，继续保持</div></div>';
    }

    var subTotal = subs.reduce(function (s, x) { return s + x.monthlyCost; }, 0);
    var subHtml = subs.length
      ? subs.map(function (s) {
        return '<div class="map-row"><span class="mr-key">' + esc(s.merchant) + '<span class="small muted">（每 ' + s.intervalDays + ' 天）</span></span>' +
          '<span style="margin-left:auto;text-align:right">¥' + Core.fmtMoney(s.amount) + '×' + s.count +
          '<br><span class="small muted">月成本 ¥' + Core.fmtMoney(s.monthlyCost) + '</span></span>' +
          '<button class="btn small" data-action="health:sub2tpl" data-mer="' + esc(s.merchant) + '">转周期</button></div>';
      }).join('') + '<div class="row small" style="padding:10px 4px 0"><b>订阅月成本合计</b><span style="margin-left:auto;color:var(--accent-deep)"><b>¥' + Core.fmtMoney(subTotal) + '</b>/月</span></div>'
      : '<div class="muted small" style="padding:8px 2px">未发现周期性扣款（需同商户相近金额且周期稳定出现 ≥3 次）</div>';

    return tplMonthBar() +
      '<div class="card"><b>📊 ' + ymLabel(state.ym) + ' 消费体检</b>' +
      '<div class="result-grid" style="margin-top:10px">' +
      '<div class="rg"><b>' + Core.fmtMoney(agg.expense) + '</b><span class="small muted">本月支出' + (mom != null ? (mom > 0 ? ' ↑' + mom + '%' : mom < 0 ? ' ↓' + (-mom) + '%' : ' 持平') : '') + '</span></div>' +
      '<div class="rg"><b>' + Core.fmtMoney(agg.income) + '</b><span class="small muted">本月收入</span></div>' +
      '<div class="rg"><b>' + saveRate + '</b><span class="small muted">储蓄率</span></div>' +
      '<div class="rg"><b style="color:' + (subTotal > 0 ? 'var(--accent-deep)' : 'inherit') + '">' + Core.fmtMoney(subTotal) + '</b><span class="small muted">订阅月成本</span></div>' +
      '</div>' + necHtml + '</div>' +
      '<div class="sec-head"><b>异常与提示</b><span class="small muted">基线：近 ' + (detect.baselineMonths || 0) + ' 个月</span></div>' +
      anomalyHtml +
      '<div class="sec-head"><b>订阅与周期扣款</b></div>' +
      '<div class="card">' + subHtml + '</div>' +
      '<div class="row" style="gap:10px;margin-top:4px">' +
      '<button class="btn grow" data-action="nav:stats">看统计</button>' +
      '<button class="btn primary grow" data-action="health:export">导出体检报告 HTML</button></div>';
  }
  var ANOMALY_NAME = {
    'category-surge': '分类支出突增', 'large-single': '单笔大额',
    'first-large': '新商户首笔大额', 'frequent-small': '高频小额累积'
  };

  function exportHealthReport() {
    var y = +state.ym.slice(0, 4), m = +state.ym.slice(5, 7);
    var agg = Core.aggregate(state.txns, { year: y, month: m, categories: state.categories });
    var prevYm = ymShift(state.ym, -1);
    var prevAgg = Core.aggregate(state.txns, { year: +prevYm.slice(0, 4), month: +prevYm.slice(5, 7), categories: state.categories });
    var detect = Core.detectAnomalies(state.txns, { year: y, month: m, categories: state.categories });
    var subs = Core.detectSubscriptions(state.txns);
    var flags = healthFlags();
    var mom = prevAgg.expense > 0 ? Math.round((agg.expense - prevAgg.expense) / prevAgg.expense * 100) : null;
    var np = function (v) { return agg.expense ? Math.round(v / agg.expense * 100) : 0; };
    var subTotal = subs.reduce(function (s, x) { return s + x.monthlyCost; }, 0);

    var anomalyRows = detect.insufficient
      ? '<p class="muted">' + esc(detect.message) + '</p>'
      : (detect.anomalies.length ? detect.anomalies.map(function (a) {
        var fk = state.ym + '|' + anomalyKey(a);
        var mk = flags[fk] === 'ok' ? ' <span class="tag ok">已标记合理</span>' : flags[fk] === 'improve' ? ' <span class="tag imp">已标记改进</span>' : '';
        return '<div class="anomaly ' + a.severity + '"><b>' + (a.severity === 'red' ? '🔴' : '🟡') + ' ' + esc(ANOMALY_NAME[a.kind] || a.kind) + '</b>' + mk + '<p>' + esc(a.message) + '</p></div>';
      }).join('') : '<p class="muted">本月无异常消费 ✅</p>');
    var subRows = subs.length ? subs.map(function (s) {
      return '<li>' + esc(s.merchant) + '：每 ' + s.intervalDays + ' 天 ¥' + Core.fmtMoney(s.amount) + '（月成本 ¥' + Core.fmtMoney(s.monthlyCost) + '）</li>';
    }).join('') : '<li class="muted">未发现周期性扣款</li>';

    var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>小账本消费体检报告 ' + state.ym + '</title><style>' +
      'body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#1f2430;background:#f8f9fb}' +
      'h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-left:4px solid #f5a623;padding-left:8px}' +
      '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.cell{background:#fff;border-radius:12px;padding:12px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.06)}' +
      '.cell b{display:block;font-size:18px}.cell span{font-size:11px;color:#6b7280}' +
      '.bar{display:flex;height:18px;border-radius:9px;overflow:hidden;margin-top:8px}.bar i{display:block;height:100%}' +
      '.anomaly{background:#fff;border-radius:12px;padding:12px;margin:8px 0;box-shadow:0 1px 4px rgba(0,0,0,.06);border-left:4px solid #f59e0b}.anomaly.red{border-left-color:#ef4444}' +
      '.anomaly p{margin:6px 0 0;font-size:14px}.tag{font-size:11px;border-radius:6px;padding:1px 8px;margin-left:6px}.tag.ok{background:#dcfce7;color:#15803d}.tag.imp{background:#ffedd5;color:#c2410c}' +
      'li{margin:6px 0;font-size:14px}.muted{color:#6b7280}footer{margin:32px 0;font-size:11px;color:#9ca3af;text-align:center}' +
      '</style></head><body>' +
      '<h1>📒 小账本消费体检报告</h1><p class="muted">' + ymLabel(state.ym) + ' · 生成于 ' + new Date().toLocaleString('zh-CN') + ' · 本报告自包含、离线可看</p>' +
      '<div class="grid">' +
      '<div class="cell"><b>' + Core.fmtMoney(agg.expense) + '</b><span>支出' + (mom != null ? (mom > 0 ? ' ↑' + mom + '%' : ' ↓' + (-mom) + '%') : '') + '</span></div>' +
      '<div class="cell"><b>' + Core.fmtMoney(agg.income) + '</b><span>收入</span></div>' +
      '<div class="cell"><b>' + (agg.savingsRate != null ? Math.round(agg.savingsRate * 100) + '%' : '—') + '</b><span>储蓄率</span></div>' +
      '<div class="cell"><b>' + Core.fmtMoney(subTotal) + '</b><span>订阅月成本</span></div></div>' +
      '<div class="bar"><i style="width:' + np(agg.need) + '%;background:#22c55e"></i><i style="width:' + np(agg.want) + '%;background:#f97316"></i><i style="width:' + np(agg.necessityNone) + '%;background:#cbd5e1"></i></div>' +
      '<p class="muted" style="font-size:12px">必要 ' + np(agg.need) + '% · 想要 ' + np(agg.want) + '% · 未标记 ' + np(agg.necessityNone) + '%</p>' +
      '<h2>异常清单</h2>' + anomalyRows +
      '<h2>订阅与周期扣款</h2><ul>' + subRows + '</ul>' +
      '<footer>小账本 v' + APP_VERSION + ' · 数据 100% 本地生成，本报告不含任何外部资源</footer></body></html>';
    download('ledger-report-' + state.ym + '.html', html, 'text/html;charset=utf-8');
    toast('体检报告已导出（自包含 HTML，断网可看）');
  }

  /* ================= V2.3.2 报销管理 ================= */
  function tplReimburse() {
    var m = Core.matchReimbursements(state.txns);
    var closed = Core.reimburseClosedMap(state.txns);
    var total = m.pending.reduce(function (s, t) { return s + t.amount; }, 0);
    var pendingRows = m.pending.map(function (t) {
      var age = Math.max(0, Core.daysBetween(t.date, todayDateStr()));
      return '<div class="set-item" style="flex-wrap:wrap">' +
        '<span class="si-icon">🧾</span>' +
        '<span class="si-main"><div>' + esc(t.merchant || txnTitle(t)) + '</div>' +
        '<div class="si-sub">' + esc(t.date) + ' · 账龄 ' + age + ' 天' + (age > 30 ? ' ⚠️' : '') + '</div></span>' +
        '<span style="font-weight:700">¥' + Core.fmtMoney(t.amount) + '</span>' +
        '<button class="btn small" style="margin-left:8px" data-action="reim:link" data-id="' + esc(t.id) + '">关联报销款</button></div>';
    }).join('');
    var suggestionHtml = m.suggestions.map(function (s) {
      return '<div class="dup-card"><b>💡 收入 ¥' + Core.fmtMoney(s.income.amount) + '（' + esc(s.income.date) + ' ' + esc(s.income.merchant || '未命名') + '）疑似报销款</b>' +
        '<div class="dc-rows">可关联的待报销垫付：' + s.candidates.map(function (c) {
          return '<button class="link" data-action="reim:doLink" data-inc="' + esc(s.income.id) + '" data-exp="' + esc(c.id) + '">' + esc(c.merchant || txnTitle(c)) + ' ¥' + Core.fmtMoney(c.amount) + '</button>';
        }).join(' / ') + '</div></div>';
    }).join('');
    var closedRows = state.txns.filter(function (t) { return t.type === 'income' && t.reimburseOf; }).map(function (inc) {
      var exp = state.txns.find(function (x) { return x.id === inc.reimburseOf; });
      return '<div class="map-row"><span class="mr-key">✅ ' + esc(exp ? (exp.merchant || txnTitle(exp)) : '?') + ' ↔ ' + esc(inc.merchant || '报销款') + '</span>' +
        '<span style="margin-left:auto">¥' + Core.fmtMoney(inc.amount) + '</span>' +
        '<button class="btn small ghost" data-action="reim:unlink" data-id="' + esc(inc.id) + '">撤销</button></div>';
    }).join('');
    return '<div class="page-title">报销管理</div>' +
      '<div class="card"><div class="result-grid">' +
      '<div class="rg"><b>' + Core.fmtMoney(total) + '</b><span class="small muted">待报销垫付总额</span></div>' +
      '<div class="rg"><b>' + m.pending.length + '</b><span class="small muted">待报销笔数</span></div></div>' +
      '<div class="small muted" style="margin-top:8px">闭环后：垫付不计个人支出、报销款不计收入，收支统计还原。</div></div>' +
      (m.pending.length ? '<div class="sec-head"><b>待报销清单</b></div>' + pendingRows : '<div class="card muted small">暂无待报销垫付。在交易详情中可将支出标记为「待报销」。</div>') +
      (suggestionHtml ? '<div class="sec-head"><b>关联建议</b></div>' + suggestionHtml : '') +
      (closedRows ? '<div class="sec-head"><b>已闭环</b></div><div class="card">' + closedRows + '</div>' : '');
  }

  /* ================= V2.3.3 周期记账 ================= */
  function freqLabel(tpl) {
    if (tpl.frequency === 'weekly') return '每周' + '日一二三四五六'[tpl.day || 0];
    if (tpl.frequency === 'yearly') return '每年' + tpl.month + '月' + tpl.day + '日';
    if (tpl.frequency === 'daily') return '每天';
    return '每月' + tpl.day + '日';
  }

  function tplRecurring() {
    var tpls = state.settings.recurring || [];
    var rows = tpls.map(function (t) {
      return '<div class="set-item" style="flex-wrap:wrap">' +
        '<span class="si-icon">' + (t.type === 'income' ? '💰' : '🔁') + '</span>' +
        '<span class="si-main"><div>' + esc(t.name) + (t.active === false ? ' <span class="chip">已停用</span>' : '') + '</div>' +
        '<div class="si-sub">' + freqLabel(t) + ' · ¥' + Core.centsToYuan(t.amount) + ' · ' + esc(accountName(t.accountId)) + '</div></span>' +
        '<span class="row" style="gap:6px">' +
        '<button class="btn small" data-action="recur:toggle" data-id="' + esc(t.id) + '">' + (t.active === false ? '启用' : '停用') + '</button>' +
        '<button class="btn small" data-action="recur:edit" data-id="' + esc(t.id) + '">编辑</button>' +
        '<button class="btn small ghost" data-action="recur:del" data-id="' + esc(t.id) + '">删除</button></span></div>';
    }).join('');

    var generated = state.txns.filter(function (t) { return t.recurringKey; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 20)
      .map(function (t) {
        return '<div class="map-row"><span class="mr-key">' + esc(t.merchant) + '</span>' +
          '<span style="margin-left:auto">' + esc(t.date) + ' · ¥' + Core.fmtMoney(t.amount) + '</span>' +
          '<button class="btn small ghost" data-action="recur:undoOne" data-id="' + esc(t.id) + '">撤销</button></div>';
      }).join('');

    return '<div class="page-title">周期记账</div>' +
      '<div class="card"><b>自动生成</b>' +
      '<div class="small muted" style="margin:6px 0 10px">' + (state.settings.recurringAuto ? '开启后每次打开应用自动生成到期的周期账。' : '当前为预览模式：到期时首页横幅提醒，手动确认生成。') + '</div>' +
      '<button class="btn block ' + (state.settings.recurringAuto ? '' : 'primary') + '" data-action="recur:toggleAuto">' + (state.settings.recurringAuto ? '改为预览确认模式' : '改为静默自动生成') + '</button></div>' +
      '<div class="sec-head"><b>模板</b><button class="link small" data-action="recur:add">＋ 新增模板</button></div>' +
      (rows || '<div class="card muted small">暂无模板。房租、话费等固定收支建模板后自动记账。</div>') +
      '<div class="sec-head"><b>生成</b></div>' +
      '<div class="card"><div class="row" style="gap:8px">' +
      '<button class="btn grow" data-action="recur:genThisMonth">生成本月</button>' +
      '<button class="btn grow" data-action="recur:backfill">补生成（漏月）</button></div></div>' +
      (generated ? '<div class="sec-head"><b>最近生成的周期账</b></div><div class="card">' + generated + '</div>' : '');
  }

  function recurringSheet(tpl) {
    var isNew = !tpl;
    var t = tpl || { type: 'expense', frequency: 'monthly', day: 1, month: 1 };
    var accOpts = liveAccounts().map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (t.accountId === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>';
    }).join('');
    var catOpts = state.categories.filter(function (c) { return c.type === (t.type || 'expense') && !c.parentId; }).map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (t.categoryId === c.id ? ' selected' : '') + '>' + c.icon + ' ' + esc(c.name) + '</option>';
    }).join('');
    var freqOpts = [['monthly', '每月'], ['weekly', '每周'], ['yearly', '每年'], ['daily', '每天']].map(function (f) {
      return '<option value="' + f[0] + '"' + (t.frequency === f[0] ? ' selected' : '') + '>' + f[1] + '</option>';
    }).join('');
    openSheet(isNew ? '新增周期模板' : '编辑周期模板',
      '<div class="form-row">' +
      formItem('名称', '<input id="rc-name" placeholder="如 房租" value="' + esc(t.name || '') + '">') +
      formItem('类型', '<select id="rc-type"><option value="expense"' + (t.type === 'expense' ? ' selected' : '') + '>支出</option><option value="income"' + (t.type === 'income' ? ' selected' : '') + '>收入</option></select>') +
      formItem('金额（元）', '<input id="rc-amount" type="number" step="0.01" min="0.01" placeholder="0.00" value="' + (t.amount ? Core.centsToYuan(t.amount) : '') + '">') +
      formItem('账户', '<select id="rc-acc">' + accOpts + '</select>') +
      formItem('分类', '<select id="rc-cat"><option value="">未分类</option>' + catOpts + '</select>') +
      formItem('频率', '<select id="rc-freq">' + freqOpts + '</select>') +
      formItem('每月几号', '<input id="rc-day" type="number" min="1" max="31" value="' + (t.day || 1) + '">') +
      formItem('每年几月', '<input id="rc-month" type="number" min="1" max="12" value="' + (t.month || 1) + '">') +
      formItem('备注', '<input id="rc-note" placeholder="选填" value="' + esc(t.note || '') + '">') +
      '</div>' +
      '<div class="small muted" style="margin:6px 2px">频率为"每周"时填星期（0=周日）；"每年"时填月+日；大月31日在小月自动钳制。</div>' +
      '<button class="btn primary block" data-action="recur:save" data-id="' + esc(tpl ? tpl.id : '') + '">保存模板</button>');
  }

  function monthOptions(cur) {
    var out = '', now = curYM();
    for (var i = 0; i < 18; i++) {
      var ym = ymShift(now, -i);
      out += '<option value="' + ym + '"' + (ym === cur ? ' selected' : '') + '>' + ymLabel(ym) + '</option>';
    }
    return out;
  }

  function recurringPreviewSheet(occ) {
    if (!occ.length) { toast('没有待生成的周期账'); return; }
    var tplById = {};
    (state.settings.recurring || []).forEach(function (t) { tplById[t.id] = t; });
    var items = occ.map(function (o, i) {
      var t = tplById[o.tplId] || {};
      return '<div class="map-row"><input type="checkbox" checked data-occ="' + i + '" style="width:18px;height:18px">' +
        '<span class="mr-key">' + esc(t.name || '?') + '</span>' +
        '<span style="margin-left:auto">' + esc(o.date) + ' · ¥' + Core.centsToYuan(t.amount || 0) + '</span></div>';
    }).join('');
    window._occ = occ;
    openSheet('预览生成（' + occ.length + ' 笔）',
      items +
      '<button class="btn primary block" style="margin-top:12px" data-action="recur:applyPreview">确认生成</button>');
  }

  function applyRecurringPreview() {
    var occ = window._occ || [];
    var chosen = [];
    $all('#sheet input[data-occ]').forEach(function (cb) {
      if (cb.checked) chosen.push(occ[+cb.dataset.occ]);
    });
    if (!chosen.length) { toast('未勾选任何记录', 'warn'); return; }
    var g = Core.generateRecurring(state.settings.recurring, chosen, state.txns);
    state.txns = state.txns.concat(g.txns);
    state.settings.lastRun = todayDateStr();
    state.pendingRecurring = 0;
    save();
    closeSheet();
    toast('已生成 ' + g.txns.length + ' 笔周期账（跳过已存在 ' + g.skipped + ' 笔）');
    if (state.page === 'recurring' || state.page === 'home') render();
  }


  /* ================= 导入向导 ================= */
  function newWizard() {
    state.wiz = {
      step: 1, fileName: '', text: '',
      parsed: null, source: null, templateId: '', customCols: null, customName: '',
      typeMapping: null, accountMapping: null, transferTarget: null,
      built: null, match: null, decisions: {}, done: null
    };
  }

  function tplWizard() {
    if (!state.wiz) newWizard();
    var w = state.wiz;
    var stepsBar = '<div class="wiz-steps">' + [1, 2, 3, 4, 5].map(function (i) {
      var cls = i < w.step ? 'done' : i === w.step ? 'cur' : '';
      return '<i class="' + cls + '"></i>';
    }).join('') + '</div>';
    var body;
    switch (w.step) {
      case 1: body = wizStep1(); break;
      case 2: body = wizStep2(); break;
      case 3: body = wizStep3(); break;
      case 4: body = wizStep4(); break;
      case 5: body = wizStep5(); break;
      default: body = '';
    }
    return '<div class="page-title">导入账单</div>' + stepsBar + body;
  }

  var WIZ_STEP_NAME = { 1: '选择文件', 2: '解析预览', 3: '映射确认', 4: '去重确认', 5: '导入结果' };

  function wizStep1() {
    var w = state.wiz;
    var bankTpls = '<div class="card"><b>银行流水模板</b>' +
      '<div class="small muted" style="margin:6px 0 10px">微信/支付宝账单会自动识别；银行流水请选择模板（招行/中行已预设）。</div>' +
      '<div class="map-row"><span class="mr-key">招商银行</span><button class="btn small" data-action="wiz:tpl" data-id="cmb">使用</button></div>' +
      '<div class="map-row"><span class="mr-key">中国银行</span><button class="btn small" data-action="wiz:tpl" data-id="boc">使用</button></div>' +
      (state.settings.bankTemplates || []).map(function (tpl) {
        return '<div class="map-row"><span class="mr-key">' + esc(tpl.name) + '（自定义）</span><button class="btn small" data-action="wiz:tpl" data-id="' + esc(tpl.id) + '">使用</button></div>';
      }).join('') +
      '<div class="map-row"><span class="mr-key">其他银行 / 列映射向导</span><button class="btn small" data-action="wiz:tpl" data-id="custom">自定义映射</button></div>' +
      '</div>';
    return '<div class="drop-zone" data-action="wiz:pickFile">' +
      '<div style="font-size:36px">📂</div>' +
      '<div style="margin-top:8px">' + (w.fileName ? '已选择：<b>' + esc(w.fileName) + '</b><div class="small muted">点击重新选择</div>' : '点击选择账单 CSV 文件') + '</div>' +
      '<div class="small muted" style="margin-top:8px">支持：微信账单 / 支付宝流水（UTF-8/GBK）/ 银行流水 CSV</div>' +
      '</div>' +
      '<input type="file" id="wiz-file" accept=".csv,text/csv" class="hidden">' +
      '<div id="wiz-parse-msg"></div>' +
      bankTpls +
      '<div class="small muted" style="padding:6px 4px">💡 收到 XLSX/PDF 流水？请先在 Excel/Numbers 中另存为 CSV 再导入。</div>';
  }

  function wizStep2() {
    var w = state.wiz, p = w.parsed;
    var income = 0, expense = 0, transferLike = 0;
    var dates = p.records.map(function (r) { return r.date; }).sort();
    p.records.forEach(function (r) {
      if (r.direction === 'income') income += r.amountCents;
      else if (r.direction === 'expense') expense += r.amountCents;
      if (r.transferLike) transferLike++;
    });
    var errHtml = p.errors.length
      ? '<div class="dup-card" style="border-color:#fecaca"><b>⚠️ ' + p.errors.length + ' 行无法解析（已跳过）</b>' +
        '<div class="dc-rows">' + p.errors.slice(0, 5).map(function (e) { return '第' + e.line + '行：' + esc(e.message); }).join('<br>') + (p.errors.length > 5 ? '<br>…' : '') + '</div></div>'
      : '';
    return '<div class="card"><b>解析结果</b>' +
      '<div class="dc-rows" style="margin-top:8px">' +
      '来源：' + (SOURCE_NAME[w.source] || esc(w.source)) + (p.meta.template ? ' · ' + esc(p.meta.template) : '') + '<br>' +
      '有效记录：<b>' + p.records.length + '</b> 条<br>' +
      '时间范围：' + (dates.length ? dates[0] + ' ~ ' + dates[dates.length - 1] : '—') + '<br>' +
      '支出合计：¥' + Core.fmtMoney(expense) + ' · 收入合计：¥' + Core.fmtMoney(income) + '<br>' +
      '转账/提现类（候选）：' + transferLike + ' 条</div></div>' +
      errHtml +
      '<div class="row" style="gap:10px"><button class="btn grow" data-action="wiz:restart">重来</button>' +
      '<button class="btn primary grow" data-action="wiz:next">下一步：映射</button></div>';
  }

  function wizStep3() {
    var w = state.wiz;
    // 类型映射
    var typeRows = Object.keys(w.typeMapping).map(function (k) {
      var opts = [
        ['expense', '支出'], ['income', '收入'], ['transfer', '转账'], ['refund', '退款'], ['ignore', '忽略']
      ].map(function (o) {
        return '<option value="' + o[0] + '"' + (w.typeMapping[k] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('');
      return '<div class="map-row"><span class="mr-key" title="' + esc(k) + '">' + esc(k) + '</span>' +
        '<select data-change="wiz:typeMap" data-key="' + esc(k) + '">' + opts + '</select></div>';
    }).join('');
    // 账户映射
    var methods = {};
    w.parsed.records.forEach(function (r) { methods[r.method || '(未知渠道)'] = true; });
    var accRows = Object.keys(methods).map(function (m) {
      var cur = w.accountMapping[m] || autoAccountGuess(m);
      var opts = ['<option value="">未指定</option>'].concat(liveAccounts().map(function (a) {
        return '<option value="' + esc(a.id) + '"' + (cur === a.id ? ' selected' : '') + '>' + accTypeIcon(a.type) + ' ' + esc(a.name) + '</option>';
      })).join('');
      return '<div class="map-row"><span class="mr-key" title="' + esc(m) + '">' + esc(m) + '</span>' +
        '<select data-change="wiz:accMap" data-key="' + esc(m) + '">' + opts + '</select></div>';
    }).join('');
    // 转账目标
    var transferNeeded = Object.keys(w.typeMapping).some(function (k) { return w.typeMapping[k] === 'transfer'; });
    var targetOpts = ['<option value="">（稍后由去重引擎/手动处理）</option>'].concat(liveAccounts().map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (w.transferTarget === a.id ? ' selected' : '') + '>' + accTypeIcon(a.type) + ' ' + esc(a.name) + '</option>';
    })).join('');

    return '<div class="card"><b>① 交易类型 → 记账类型</b><div class="small muted" style="margin:4px 0 6px">退款先记为收入并打退款标记；导入后可关联原交易完成冲销。</div>' + (typeRows || '<div class="small muted">无</div>') + '</div>' +
      '<div class="card"><b>② 支付方式 → 账户</b><div class="small muted" style="margin:4px 0 6px">已按账户名自动匹配，可调整；不匹配可在「我的-账户管理」新建。</div>' + (accRows || '<div class="small muted">无</div>') + '</div>' +
      (transferNeeded ? '<div class="card"><b>③ 提现/充值目标账户</b><div class="small muted" style="margin:4px 0 6px">渠道提现到哪张银行卡（用于自动记为账户间转账）。</div>' +
        '<div class="map-row"><span class="mr-key">目标账户</span><select data-change="wiz:transferTarget">' + targetOpts + '</select></div></div>' : '') +
      '<div class="row" style="gap:10px"><button class="btn grow" data-action="wiz:back">上一步</button>' +
      '<button class="btn primary grow" data-action="wiz:dedup">下一步：去重</button></div>';
  }

  function autoAccountGuess(method) {
    var acc = Core.matchAccountByText(method, liveAccounts());
    return acc ? acc.id : '';
  }

  function wizStep4() {
    var w = state.wiz, m = w.match, b = w.built;
    if (!m) return '<div class="empty">正在分析…</div>';
    var autoHtml = m.autoMerged.map(function (x) {
      return '<div class="dup-card"><b>✅ 自动合并</b><div class="dc-rows">' +
        esc(txnTitle(x.shadow)) + ' ¥' + Core.fmtMoney(x.shadow.amount) + '（' + (SOURCE_NAME[x.shadow.source] || x.shadow.source) + ' ' + x.shadow.date + '）<br>' +
        '→ 保留' + (SOURCE_NAME[x.kept.source] || x.kept.source) + '记录「' + esc(txnTitle(x.kept)) + '」（' + x.reason + '），银行记录不再计入统计</div></div>';
    }).join('');
    var transferHtml = m.transferPairs.map(function (x) {
      var desc = x.inc
        ? esc(txnTitle(x.inc)) + ' ¥' + Core.fmtMoney(x.inc.amount) + ' 与已有银行端记录配对，自动补齐转入账户，不计收支'
        : '银行端 ' + esc(txnTitle(x.bankRecord)) + ' ¥' + Core.fmtMoney(x.bankRecord.amount) + ' 补齐已有渠道提现/充值转账，不计收支';
      return '<div class="dup-card"><b>🔁 识别为账户间转账</b><div class="dc-rows">' + desc + '</div></div>';
    }).join('');
    var confirmHtml = m.needConfirm.map(function (x, i) {
      var d = w.decisions[i];
      return '<div class="dup-card"><b>❓ 疑似重复，请确认</b><div class="dc-rows">' +
        '待导入：' + esc(txnTitle(x.inc)) + ' ¥' + Core.fmtMoney(x.inc.amount) + ' ' + x.inc.date + '<br>' +
        '已有：' + esc(txnTitle(x.cand)) + ' ¥' + Core.fmtMoney(x.cand.amount) + ' ' + x.cand.date + '（' + (x.cand.source === 'manual' ? '手动' : SOURCE_NAME[x.cand.source] || x.cand.source) + '）<br>' +
        '<span class="muted">' + esc(x.reason) + '</span></div>' +
        '<div class="row" style="gap:8px">' +
        '<button class="btn small grow ' + (d === 'keep' || !d ? 'primary' : '') + '" data-action="wiz:decide" data-i="' + i + '" data-v="keep">都保留</button>' +
        '<button class="btn small grow ' + (d === 'merge' ? 'primary' : '') + '" data-action="wiz:decide" data-i="' + i + '" data-v="merge">是同一笔，合并</button></div></div>';
    }).join('');
    var pending = m.needConfirm.filter(function (x, i) { return !w.decisions[i]; }).length;
    return '<div class="card"><b>去重分析</b><div class="dc-rows" style="margin-top:6px">' +
      '同源重复（单号幂等，直接跳过）：<b>' + b.dups.length + '</b> 条<br>' +
      '忽略（按类型映射）：<b>' + b.ignored.length + '</b> 条<br>' +
      '高置信自动合并：<b>' + m.autoMerged.length + '</b> 条<br>' +
      '转账两端配对：<b>' + m.transferPairs.length + '</b> 条<br>' +
      '需你确认：<b>' + m.needConfirm.length + '</b> 条' + (pending ? '（还有 ' + pending + ' 条未选择，默认都保留）' : '') + '</div></div>' +
      autoHtml + transferHtml + confirmHtml +
      (b.warnings.length ? '<div class="dup-card" style="border-color:#fde68a"><b>⚠️ 提示</b><div class="dc-rows">' + b.warnings.slice(0, 5).map(esc).join('<br>') + '</div></div>' : '') +
      '<div class="row" style="gap:10px"><button class="btn grow" data-action="wiz:back">上一步</button>' +
      '<button class="btn primary grow" data-action="wiz:apply">确认导入</button></div>';
  }

  function wizStep5() {
    var d = state.wiz.done;
    if (!d) return '';
    return '<div class="card" style="text-align:center"><div style="font-size:40px">🎉</div><b style="font-size:17px">导入完成</b>' +
      '<div class="result-grid" style="margin-top:14px">' +
      '<div class="rg"><b>' + d.added + '</b><span class="small muted">新导入</span></div>' +
      '<div class="rg"><b>' + d.merged + '</b><span class="small muted">合并/配对</span></div>' +
      '<div class="rg"><b>' + d.skipped + '</b><span class="small muted">跳过(同源重复)</span></div>' +
      '<div class="rg"><b>' + d.ignored + '</b><span class="small muted">忽略</span></div>' +
      '</div></div>' +
      '<div class="small muted" style="text-align:center;margin-bottom:12px">导入的记录可在明细页筛选查看；未分类的可批量归类。</div>' +
      '<div class="row" style="gap:10px"><button class="btn grow" data-action="wiz:again">再导一份</button>' +
      '<button class="btn primary grow" data-action="nav:list">查看明细</button></div>';
  }

  function wizPickFile() { var f = $('#wiz-file'); if (f) f.click(); }

  function wizFileChosen(file) {
    var w = state.wiz;
    w.fileName = file.name;
    file.arrayBuffer().then(function (buf) {
      var dec = Core.decodeBytes(new Uint8Array(buf));
      w.text = dec.text;
      tryParse();
    }).catch(function () { toast('文件读取失败', 'err'); });
  }

  function tryParse() {
    var w = state.wiz;
    var msg = $('#wiz-parse-msg');
    if (Core.parseCSV(w.text).length < 2) {
      if (msg) msg.innerHTML = '<div class="dup-card" style="border-color:#fecaca">文件看起来不是有效 CSV</div>';
      return;
    }
    var parsed = Core.parseFile(w.text);
    if (parsed.records.length || parsed.errors.length) {
      w.parsed = parsed; w.source = parsed.meta.source;
      if (w.source === 'unknown') {
        if (msg) msg.innerHTML = '<div class="dup-card" style="border-color:#fecaca">无法自动识别来源，请在下方选择银行模板或自定义映射</div>';
        return;
      }
      w.typeMapping = Core.suggestTypeMappings(parsed.records);
      w.accountMapping = {};
      w.step = 2;
      render();
    } else {
      if (msg) msg.innerHTML = '<div class="dup-card" style="border-color:#fecaca">解析失败：' + esc((parsed.errors[0] || {}).message || '未知错误') + '</div>';
    }
  }

  function wizUseTemplate(id) {
    var w = state.wiz;
    if (!w.text) { toast('请先选择 CSV 文件', 'warn'); return; }
    if (id === 'custom') { wizCustomMapSheet(); return; }
    var tpl = null;
    if (id === 'cmb' || id === 'boc') tpl = id;
    else tpl = (state.settings.bankTemplates || []).find(function (t) { return t.id === id; }) || null;
    var parsed;
    if (typeof tpl === 'string' || tpl && tpl.id && !tpl._custom) {
      parsed = Core.parseBankCSV(w.text, typeof tpl === 'string' ? tpl : tpl.id);
    } else if (tpl) {
      var custom = { _custom: true, name: tpl.name, cols: tpl.cols, defaultDirection: tpl.defaultDirection };
      parsed = Core.parseBankCSV(w.text, custom);
    } else {
      parsed = Core.parseBankCSV(w.text, id);
    }
    if (!parsed.records.length) {
      toast('按该模板未解析出记录：' + ((parsed.errors[0] || {}).message || ''), 'err');
      return;
    }
    w.parsed = parsed; w.source = 'bank';
    w.typeMapping = Core.suggestTypeMappings(parsed.records);
    w.accountMapping = {};
    w.step = 2;
    render();
  }

  function wizCustomMapSheet() {
    var w = state.wiz;
    var rows = Core.parseCSV(w.text);
    var header = rows[0] || [];
    // 找最像表头的行（前5行中列数最多的）
    for (var i = 0; i < Math.min(5, rows.length); i++) {
      if (rows[i].filter(function (c) { return String(c || '').trim(); }).length > (header.filter(function (c) { return String(c || '').trim(); }).length)) header = rows[i];
    }
    window._wizHeader = header;
    var colOptions = function (sel) {
      return ['<option value="">（无）</option>'].concat(header.map(function (h, i) {
        return '<option value="' + esc(String(h).trim()) + '"' + (sel === String(h).trim() ? ' selected' : '') + '>' + esc(String(h || '').trim() || '第' + (i + 1) + '列') + '</option>';
      })).join('');
    };
    var c = w.customCols || {};
    openSheet('列映射向导',
      '<div class="small muted" style="margin-bottom:8px">把 CSV 列对应到流水字段：日期必填；金额 或（借方金额+贷方金额）至少一项。</div>' +
      '<div class="form-row">' +
      formItem('模板名', '<input id="bm-name" placeholder="如 XX银行储蓄卡" value="' + esc(w.customName) + '">') +
      formItem('日期列*', '<select data-change="bm:col" data-k="date">' + colOptions(c.date) + '</select>') +
      formItem('金额列', '<select data-change="bm:col" data-k="amount">' + colOptions(c.amount) + '</select>') +
      formItem('借方/支出列', '<select data-change="bm:col" data-k="debit">' + colOptions(c.debit) + '</select>') +
      formItem('贷方/收入列', '<select data-change="bm:col" data-k="credit">' + colOptions(c.credit) + '</select>') +
      formItem('方向列', '<select data-change="bm:col" data-k="direction">' + colOptions(c.direction) + '</select>') +
      formItem('对手/户名列', '<select data-change="bm:col" data-k="payee">' + colOptions(c.payee) + '</select>') +
      formItem('摘要列', '<select data-change="bm:col" data-k="note">' + colOptions(c.note) + '</select>') +
      formItem('流水号列', '<select data-change="bm:col" data-k="id">' + colOptions(c.id) + '</select>') +
      formItem('无符号默认', '<select data-change="bm:dd"><option value="">自动</option><option value="expense"' + (w.dd === 'expense' ? ' selected' : '') + '>支出</option><option value="income"' + (w.dd === 'income' ? ' selected' : '') + '>收入</option></select>') +
      '</div>' +
      '<button class="btn primary block" data-action="bm:apply">解析</button>');
  }

  function wizApplyCustomMap() {
    var w = state.wiz;
    var c = w.customCols || {};
    if (!c.date) { toast('请选择日期列', 'warn'); return; }
    if (!c.amount && !c.debit && !c.credit) { toast('请选择金额列或借贷双列', 'warn'); return; }
    w.customName = ($('#bm-name') ? $('#bm-name').value.trim() : '') || '自定义银行';
    var tpl = { _custom: true, name: w.customName, cols: c, defaultDirection: w.dd || null };
    var parsed = Core.parseBankCSV(w.text, tpl);
    if (!parsed.records.length) {
      toast('未解析出记录：' + ((parsed.errors[0] || {}).message || ''), 'err');
      return;
    }
    closeSheet();
    w.parsed = parsed; w.source = 'bank';
    w.typeMapping = Core.suggestTypeMappings(parsed.records);
    w.accountMapping = {};
    w.step = 2;
    render();
    confirmSheet('保存列映射模板？', '把这套映射保存为「' + esc(w.customName) + '」模板，下次同格式流水可直接复用。', '保存模板', function () {
      state.settings.bankTemplates = state.settings.bankTemplates || [];
      state.settings.bankTemplates.push({ id: Core.newId('bt'), name: w.customName, cols: c, defaultDirection: w.dd || null });
      save();
      toast('模板已保存');
    });
  }

  function wizRunDedup() {
    var w = state.wiz;
    var ctx = {
      source: w.source,
      accounts: liveAccounts(),
      categories: state.categories,
      typeMapping: w.typeMapping,
      accountMapping: w.accountMapping,
      transferTarget: w.transferTarget || null,
      existingTxns: state.txns
    };
    w.built = Core.buildTxns(w.parsed.records, ctx);
    w.match = Core.matchDuplicates(w.built.txns, state.txns);
    w.decisions = {};
    w.step = 4;
    render();
  }

  function wizApplyImport() {
    var w = state.wiz, m = w.match, b = w.built;
    var added = 0, merged = 0;
    var inMatch = {};
    m.autoMerged.forEach(function (x) { inMatch[x.inc.id] = x; });
    m.transferPairs.forEach(function (x) {
      if (x.inc) inMatch[x.inc.id] = x;            // 渠道转账 + 已有银行端
      else inMatch[x.bankRecord.id] = x;           // 银行端记录 + 已有渠道半端转账
    });
    m.needConfirm.forEach(function (x, i) { inMatch[x.inc.id] = { needConfirm: x, i: i }; });

    b.txns.forEach(function (inc) {
      var hit = inMatch[inc.id];
      if (!hit) { state.txns.push(inc); added++; return; }
      if (hit.needConfirm) {
        if (w.decisions[hit.i] === 'merge') {
          var cand = hit.needConfirm.cand;
          // 保留优先级：手动记录 > 渠道记录（含商户/分类）> 银行记录
          var keep, shadow;
          if (cand.source === 'manual') { keep = cand; shadow = inc; }
          else if (isChannel(inc) && isBank(cand)) { keep = inc; shadow = cand; }
          else { keep = cand; shadow = inc; }
          Core.applyAutoMerge({ shadow: shadow, kept: keep });
          state.txns.push(inc);
          merged++;
        } else {
          state.txns.push(inc); added++;
        }
        return;
      }
      if (hit.transfer || hit.bankTxn) { // 转账两端配对（任一方向）
        Core.applyTransferPair(hit);
        state.txns.push(hit.inc || hit.bankRecord);
        merged++;
        return;
      }
      // 高置信自动合并
      Core.applyAutoMerge(hit);
      state.txns.push(inc);
      merged++;
    });
    save();
    w.done = { added: added, merged: merged, skipped: b.dups.length, ignored: b.ignored.length };
    w.step = 5;
    render();
  }
  function isChannel(t) { return t.source === 'wechat' || t.source === 'alipay'; }
  function isBank(t) { return /^bank/.test(t.source); }

  /* ================= 安全：应用锁 ================= */

  function lockSheet() {
    var enabled = state.settings.lock && state.settings.lock.enabled;
    if (!enabled) {
      openSheet('开启应用锁',
        '<div class="dup-card" style="border-color:#fecaca"><b>⚠️ 开启前请务必了解</b><div class="dc-rows">交易数据将使用 AES-GCM 加密存储。<b>密码只存在于你的记忆中，忘记密码 = 数据永远无法恢复。</b>建议先在「导出 JSON 备份」留存一份明文备份。</div></div>' +
        '<div class="form-row">' +
        formItem('设置密码', '<input id="lk-pw1" type="password" placeholder="至少 4 位" autocomplete="off">') +
        formItem('确认密码', '<input id="lk-pw2" type="password" placeholder="再输入一次" autocomplete="off">') +
        '</div>' +
        '<button class="btn primary block" data-action="lock:enable">我已了解风险，开启加密</button>');
    } else {
      openSheet('应用锁已开启',
        '<div class="small muted" style="margin-bottom:10px">交易数据以密文存储于本机，解锁密钥仅存在于内存。</div>' +
        '<button class="btn block" data-action="lock:change" style="margin-bottom:10px">修改密码</button>' +
        '<button class="btn danger block" data-action="lock:disable">关闭加密（需验证密码）</button>');
    }
  }

  function lockEnable() {
    var p1 = $('#lk-pw1').value, p2 = $('#lk-pw2').value;
    if (p1.length < 4) { toast('密码至少 4 位', 'warn'); return; }
    if (p1 !== p2) { toast('两次输入不一致', 'warn'); return; }
    DB.makeLockParams(p1).then(function (r) {
      state.settings.lock = { enabled: true, salt: r.salt, iter: r.iter };
      return save();
    }).then(function () {
      closeSheet();
      toast('应用锁已开启，数据已加密存储');
      render();
    }).catch(function (e) { toast('加密初始化失败：' + e, 'err'); });
  }

  function lockDisable() {
    closeSheet();
    openSheet('关闭加密', '<div class="small muted" style="margin-bottom:8px">需验证当前密码；关闭后数据以明文存于本机 IndexedDB。</div>' +
      '<div class="form-row">' + formItem('当前密码', '<input id="lk-old" type="password" autocomplete="off">') + '</div>' +
      '<button class="btn danger block" data-action="lock:disableGo">验证并关闭</button>');
  }

  function lockDisableGo() {
    var pw = $('#lk-old').value;
    // 从存储读回密文验证密码，通过后切换为明文存储
    DB.get('txns').then(function (blob) {
      return DB.unlock(pw, state.settings.lock, blob);
    }).then(function () {
      state.settings.lock = { enabled: false };
      return save();
    }).then(function () {
      closeSheet();
      toast('已关闭加密，恢复明文存储');
      render();
    }).catch(function () {
      toast('密码错误，无法关闭', 'err');
    });
  }

  function lockChange() {
    closeSheet();
    openSheet('修改密码',
      '<div class="form-row">' +
      formItem('当前密码', '<input id="lk-old" type="password" autocomplete="off">') +
      formItem('新密码', '<input id="lk-new" type="password" placeholder="至少 4 位" autocomplete="off">') +
      formItem('确认新密码', '<input id="lk-new2" type="password" autocomplete="off">') +
      '</div>' +
      '<button class="btn primary block" data-action="lock:changeGo">修改并重新加密</button>');
  }

  function lockChangeGo() {
    var oldPw = $('#lk-old').value, n1 = $('#lk-new').value, n2 = $('#lk-new2').value;
    if (n1.length < 4) { toast('新密码至少 4 位', 'warn'); return; }
    if (n1 !== n2) { toast('两次新密码不一致', 'warn'); return; }
    DB.get('txns').then(function (blob) {
      return DB.unlock(oldPw, state.settings.lock, blob);
    }).then(function () {
      return DB.makeLockParams(n1);
    }).then(function (r) {
      state.settings.lock = { enabled: true, salt: r.salt, iter: r.iter };
      return save();
    }).then(function () {
      closeSheet(); toast('密码已修改，数据已用新密码重新加密'); render();
    }).catch(function () {
      toast('当前密码错误', 'err');
    });
  }

  /* ================= 数据备份 ================= */

  function exportJson() {
    var backup = Core.createBackup(state, APP_VERSION);
    var d = todayDateStr();
    download('ledger-backup-' + d + '.json', JSON.stringify(backup, null, 2), 'application/json');
    toast('已导出 JSON 备份（请妥善保管）');
  }

  function exportCsv() {
    var csv = Core.transactionsToCSV(state.txns, state.accounts, state.categories);
    download('ledger-detail-' + todayDateStr() + '.csv', csv, 'text/csv;charset=utf-8');
    toast('已导出 CSV 明细（带 BOM，Excel 中文不乱码）');
  }

  function restoreBackup(file) {
    file.text().then(function (txt) {
      var data;
      try { data = JSON.parse(txt); } catch (e) { toast('不是有效的 JSON 文件', 'err'); return; }
      var restored;
      try { restored = Core.restoreStateFromBackup(data); }
      catch (e2) { toast(e2.message || '备份文件校验失败', 'err'); return; }
      var v3 = restored.assets;
      var v3Count = v3.assetAccounts.length + v3.assetUnits.length + v3.assetTransfers.length + v3.liabilities.length +
        v3.entitlements.length + v3.instruments.length + v3.holdings.length;
      confirmSheet('恢复备份',
        '备份时间：' + esc((data.exportedAt || '').replace('T', ' ').slice(0, 19)) + '<br>包含 ' + restored.txns.length + ' 笔交易、' +
        restored.accounts.length + ' 个账户' +
        (v3Count > 0 ? '、v3 资产数据 ' + v3Count + ' 条' : '') +
        '。<br><b>恢复将覆盖当前全部数据</b>，建议先导出当前数据备份。',
        '覆盖恢复', function () {
          // S3：恢复是高风险覆盖写入，必须先在服务端强制留一份恢复前备份
          // （不受 60 秒写后备份节流影响），确认成功后才覆盖；
          // 保存失败则回滚到恢复前状态，界面与事实源保持一致。
          var before = {
            accounts: state.accounts, categories: state.categories, txns: state.txns,
            settings: state.settings, assets: state.assets
          };
          state.accounts = restored.accounts;
          state.categories = restored.categories;
          state.txns = restored.txns;
          state.settings = restored.settings;
          state.assets = Domain.normalizeAssets(restored.assets); // v1 备份 → 空集合（S1.1）
          save({ forceBackup: true }).then(function (ok) {
            if (ok) {
              toast('恢复完成');
              route('home');
            } else {
              state.accounts = before.accounts;
              state.categories = before.categories;
              state.txns = before.txns;
              state.settings = before.settings;
              state.assets = before.assets;
              toast('恢复未完成，当前数据保持不变', 'err');
              render();
            }
          });
        }, true);
    });
  }

  function clearAllSheet() {
    openSheet('清空所有数据',
      '<div class="dup-card" style="border-color:#fecaca"><b>⚠️ 此操作不可撤销</b><div class="dc-rows">将删除全部账户、分类、交易与设置。建议先「导出 JSON 备份」。</div></div>' +
      '<div class="form-row">' + formItem('输入"清空"', '<input id="clr-input" placeholder="清空" autocomplete="off">') + '</div>' +
      '<button class="btn danger block" data-action="clear:go">永久清空</button>');
  }

  function clearGo() {
    if (($('#clr-input') || {}).value !== '清空') { toast('请输入"清空"二字以确认', 'warn'); return; }
    // 清空走服务端 DELETE /state：服务端会先强制留一份 pre-clear 备份再清空。
    // 不再本地清 IndexedDB + 全量写空状态——那条路径绕过了 pre-clear 备份，
    // 且在 API 模式下写空状态只受节流备份保护（S3 同类问题）。
    Store.clearAll().then(function () {
      state.accounts = Core.defaultAccounts();
      state.categories = Core.defaultCategories();
      state.txns = [];
      state.settings = Core.defaultSettings();
      state.assets = Domain.emptyAssets();
      closeSheet();
      toast('数据已清空，已恢复初始状态');
      route('home');
    }).catch(function (e) {
      if (e && e.code === 'readonly') {
        renderServiceBanner();
        toast('本地服务未运行，当前为只读模式，已拒绝清空', 'err');
      } else {
        toast('清空未完成：' + (e && e.message || e), 'err');
      }
    });
  }

  function privacySheet() {
    openSheet('隐私承诺',
      '<div style="line-height:1.9;font-size:14px">' +
      '🔐 <b>零网络请求</b>：本应用不加载任何外部资源、无埋点、无统计上报，断网可完整使用（可在浏览器 DevTools Network 面板验证）。<br><br>' +
      '💾 <b>数据仅存本机</b>：全部数据保存在本机浏览器的 IndexedDB 中，不上传任何服务器。<br><br>' +
      '🔐 <b>应用锁加密</b>：开启后交易数据经 PBKDF2 派生密钥 + AES-GCM 加密落盘，密码不落盘、不可找回。<br><br>' +
      '📦 <b>数据永不锁定</b>：随时可导出 JSON 全量备份与 CSV 明细，换浏览器/换电脑不丢数据。<br><br>' +
      '⚠️ <b>注意</b>：浏览器「清除站点数据」会清空 IndexedDB，请定期导出备份。</div>');
  }

  function howtoSheet() {
    openSheet('账单导出路径速查',
      '<div style="line-height:2;font-size:14px">' +
      '<b>微信</b>：我 → 服务 → 钱包 → 账单 → 右上角常见问题 → 下载账单 → 用于个人对账（邮箱收压缩包，解压后得 CSV）<br>' +
      '<b>支付宝</b>：我的 → 账单 → 右上角 … → 开具交易流水证明 → 用于个人对账<br>' +
      '<b>招商银行</b>：App → 我的 → 账户总览 → 交易流水 → 导出（邮箱接收 CSV）<br>' +
      '<b>中国银行</b>：App → 账户 → 交易明细 → 更多 → 导出流水<br>' +
      '<span class="muted small">若收到 PDF/XLSX，请先在 Excel/Numbers 中另存为 CSV 再导入。</span></div>');
  }

  /* ================= 事件分发 ================= */
  var actions = {
    'nav:home': function () { nav('home'); },
    'nav:cashflow': function () { nav('cashflow'); },
    'nav:list': function () { nav('list'); },
    'nav:stats': function () { nav('stats'); },
    'nav:settings': function () { nav('settings'); },
    'nav:accounts': function () { nav('accounts'); },
    'nav:categories': function () { nav('categories'); },
    'nav:import': function () { state.wiz = null; nav('import'); },
    'nav:add': function () { openAdd(null); },
    'ym:prev': function () { state.ym = ymShift(state.ym, -1); render(); },
    'ym:next': function () { state.ym = ymShift(state.ym, 1); render(); },
    'ym:today': function () { state.ym = curYM(); render(); },

    'sheet:close': closeSheet,

    // 记一笔
    'add:type': function (el) {
      draftSyncFromDom();
      var d = state.addDraft;
      d.type = el.dataset.id;
      if (d.type !== 'transfer' && d.categoryId) {
        var c = categoryById(d.categoryId);
        if (!c || c.type !== d.type) d.categoryId = null;
      }
      render();
    },
    'add:key': function (el) { keyInput(el.dataset.key); },
    'add:pickCat': function (el) { state.addDraft.categoryId = el.dataset.id; render(); },
    'add:pickAcc': function (el) { pickAccountSheet(el.dataset.field); },
    'add:acc-set': function (el) {
      state.addDraft[el.dataset.field] = el.dataset.id;
      closeSheet(); render();
    },
    'add:save': saveAdd,

    // 明细
    'txn:detail': function (el) { txnDetailSheet(el.dataset.id); },
    'txn:edit': function (el) { closeSheet(); openAdd(el.dataset.id); },
    'txn:delete': function (el) {
      var id = el.dataset.id;
      var t = state.txns.find(function (x) { return x.id === id; });
      closeSheet();
      confirmSheet('删除交易', '确定删除「' + esc(txnTitle(t)) + ' ¥' + Core.fmtMoney(t.amount) + '」？关联的合并记录会恢复独立。', '删除', function () {
        state.txns = state.txns.filter(function (x) { return x.id !== id; });
        state.txns.forEach(function (x) { if (x.mappedTo === id) Core.undoMerge(x); });
        save(); render();
        toast('已删除');
      }, true);
    },
    'txn:undoMerge': function (el) {
      var t = state.txns.find(function (x) { return x.id === el.dataset.id; });
      if (!t) return;
      Core.undoMerge(t);
      save(); closeSheet(); render();
      toast('已撤销合并，恢复为两条独立记录');
    },
    'list:filterSheet': filterSheet,
    'list:clearFilter': function () {
      state.listFilters = { type: '', account: '', category: '', q: '' };
      render(); filterSheet();
    },
    'list:startSel': function () { state.selectMode = true; state.selectedIds = {}; render(); },
    'list:cancelSel': function () { state.selectMode = false; state.selectedIds = {}; render(); },
    'list:toggleSel': function (el) {
      var id = el.dataset.id;
      if (state.selectedIds[id]) delete state.selectedIds[id];
      else state.selectedIds[id] = true;
      render();
    },
    'list:applySel': function () {
      var ids = Object.keys(state.selectedIds);
      if (!ids.length) { toast('请先勾选交易', 'warn'); return; }
      var cats = state.categories.filter(function (c) { return c.type === 'expense' || c.type === 'income'; });
      var grid = '<div class="cat-grid">' + cats.map(function (c) {
        return '<button class="cat-cell" data-action="list:applyCat" data-id="' + esc(c.id) + '"><span class="cc-icon">' + c.icon + '</span><span>' + esc(c.name) + '</span></button>';
      }).join('') + '</div>';
      openSheet('归为分类（' + ids.length + ' 笔）', grid);
    },
    'list:applyCat': function (el) {
      var cid = el.dataset.id;
      var n = 0;
      Object.keys(state.selectedIds).forEach(function (id) {
        var t = state.txns.find(function (x) { return x.id === id; });
        if (t && t.type !== 'transfer') { t.category = cid; n++; }
      });
      state.selectMode = false; state.selectedIds = {};
      closeSheet(); save(); render();
      toast('已将 ' + n + ' 笔归入「' + ((categoryById(cid) || {}).name || '') + '」');
    },

    // 统计
    'stats:rank': function (el) { state.statRank = el.dataset.id; render(); },
    'stats:view': function (el) { state.statsView = el.dataset.id; render(); },
    'stats:nec': function (el) {
      state.statNec = el.dataset.id || '';
      render();
    },

    // V2.2.1 批量必要性
    'cat:batchNec': batchNecSheet,
    'cat:batchNecGo': function () {
      var nec = $('#bn-nec').value || null;
      var ids = $all('#sheet input[data-bn]').filter(function (cb) { return cb.checked; }).map(function (cb) { return cb.dataset.bn; });
      if (!ids.length) { toast('请先勾选分类', 'warn'); return; }
      ids.forEach(function (id) {
        var c = categoryById(id);
        if (c) c.necessity = nec;
      });
      save(); closeSheet(); render();
      toast('已批量设置 ' + ids.length + ' 个分类的必要性');
    },

    // V2 导航
    'nav:budget': function () { nav('budget'); },
    'nav:health': function () { nav('health'); },
    'nav:reimburse': function () { nav('reimburse'); },
    'nav:recurring': function () { nav('recurring'); },

    // Phase 3：资产录入与月度结账
    'nav:assets': function () { nav('assets'); },
    'nav:close': function () {
      nav('close');
      Store.listMonthlyCloses().then(function (r) {
        state.closes = (r && r.items) || [];
        state.closesLoaded = true;
        if (state.page === 'close') render();
      }).catch(function () { state.closesLoaded = true; });
    },
    'asset:acc': assetAccountSheet,
    'asset:saveAcc': function () {
      var name = $('#aa-name').value.trim();
      if (!name) { toast('请填写账户名称', 'warn'); return; }
      Store.createResource('accounts', {
        id: Core.newId('aacc'),
        name: name,
        institution: $('#aa-inst').value.trim(),
        kind: $('#aa-kind').value,
        pool: $('#aa-pool').value,
        status: 'active'
      }).then(function () {
        closeSheet(); toast('账户已保存');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'asset:unit': function (el) { assetUnitSheet(el.dataset.id); },
    'asset:saveUnit': function () {
      var raw = $('#au-bal').value.trim();
      var balanceMinor = null;
      if (raw !== '') {
        balanceMinor = Core.yuanToCents(raw);
        if (balanceMinor == null || balanceMinor < 0) { toast('余额格式不正确', 'warn'); return; }
      }
      var accountId = $('#au-acc').value;
      var currency = $('#au-cur').value;
      var existing = state.assets.assetUnits.find(function (u) {
        return u.accountId === accountId && u.currency === currency;
      });
      Store.createResource('account-units', {
        id: existing ? existing.id : Core.newId('au'),
        accountId: accountId,
        currency: currency,
        balanceMinor: balanceMinor,
        asOf: $('#au-date').value || todayDateStr(),
        sourceType: 'manual'
      }).then(function () {
        closeSheet(); toast('余额已登记');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'asset:transfer': assetTransferSheet,
    'asset:saveTransfer': function () {
      var fromUnitId = $('#at-from').value;
      var toUnitId = $('#at-to').value;
      var from = state.assets.assetUnits.find(function (u) { return u.id === fromUnitId; });
      var to = state.assets.assetUnits.find(function (u) { return u.id === toUnitId; });
      if (!from || !to || fromUnitId === toUnitId) { toast('请选择两个不同的币种子账户', 'warn'); return; }
      if (from.currency === to.currency) { toast('换汇两端币种必须不同', 'warn'); return; }
      var fromAmountMinor = Core.yuanToCents($('#at-from-amount').value.trim());
      var toAmountMinor = Core.yuanToCents($('#at-to-amount').value.trim());
      if (fromAmountMinor == null || fromAmountMinor <= 0 || toAmountMinor == null || toAmountMinor <= 0) {
        toast('请填写有效的换汇两端金额', 'warn'); return;
      }
      Store.createResource('asset-transfers', {
        id: Core.newId('xfer'),
        fromUnitId: fromUnitId,
        toUnitId: toUnitId,
        fromAmountMinor: fromAmountMinor,
        toAmountMinor: toAmountMinor,
        occurredOn: $('#at-date').value || todayDateStr(),
        sourceType: 'manual',
        note: $('#at-note').value.trim() || null
      }).then(function () {
        closeSheet(); toast('换汇已记为资产转移，不计收支');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'asset:liab': function (el) {
      var id = el && el.dataset ? el.dataset.id : '';
      var found = null;
      if (id) {
        found = (state.assets.liabilities || []).find(function (x) { return x.id === id; }) || null;
        if (!found) { toast('找不到该负债记录', 'warn'); return; }
      }
      assetLiabilitySheet(found);
    },
    'asset:saveLiab': function () {
      var name = $('#al-name').value.trim();
      if (!name) { toast('请填写负债名称', 'warn'); return; }
      var raw = $('#al-bal').value.trim();
      var balanceMinor = null;
      if (raw !== '') {
        balanceMinor = Core.yuanToCents(raw);
        if (balanceMinor == null || balanceMinor < 0) { toast('余额格式不正确', 'warn'); return; }
      }
      // 核对日期必须显式选择：它决定该负债是否算「在结账月份内已核对」，
      // 直接取今天会让上月结账永久阻塞（P0-A）
      var asOf = $('#al-asof').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { toast('请选择核对日期', 'warn'); return; }
      var existingId = $('#al-id').value;
      Store.createResource('liabilities', {
        id: existingId || Core.newId('liab'),
        name: name,
        accountId: $('#al-acc').value || null,
        currency: 'CNY',
        balanceMinor: balanceMinor,
        dueDate: $('#al-due').value || null,
        termType: $('#al-term').value,
        asOf: asOf
      }).then(function () {
        closeSheet(); toast(existingId ? '负债已更新' : '负债已保存');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'asset:ent': function (el) {
      var id = el && el.dataset ? el.dataset.id : '';
      var found = null;
      if (id) {
        found = (state.assets.entitlements || []).find(function (x) { return x.id === id; }) || null;
        if (!found) { toast('找不到该权益记录', 'warn'); return; }
      }
      assetEntitlementSheet(found);
    },
    'asset:saveEnt': function () {
      var name = $('#ae-name').value.trim();
      if (!name) { toast('请填写权益名称', 'warn'); return; }
      var raw = $('#ae-bal').value.trim();
      var balanceMinor = null;
      if (raw !== '') {
        balanceMinor = Core.yuanToCents(raw);
        if (balanceMinor == null || balanceMinor < 0) { toast('金额格式不正确', 'warn'); return; }
      }
      var asOf = $('#ae-asof').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { toast('请选择核对日期', 'warn'); return; }
      var existingId = $('#ae-id').value;
      Store.createResource('entitlements', {
        id: existingId || Core.newId('ent'),
        name: name,
        kind: $('#ae-kind').value,
        jurisdiction: $('#ae-jur').value.trim() || null,
        status: $('#ae-status').value.trim() || null,
        balanceMinor: balanceMinor,
        valuationType: $('#ae-valtype').value || 'reference',
        sourceRef: $('#ae-src').value.trim() || null,
        asOf: asOf
      }).then(function () {
        closeSheet(); toast(existingId ? '权益已更新' : '权益已保存');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'asset:preset': function (el) { presetSheet(el && el.dataset ? el.dataset.id : ''); },
    'asset:savePreset': function () {
      var p = presetById($('#ap-preset').value);
      if (!p) { toast('未知预设', 'warn'); return; }
      var name = $('#ap-name').value.trim();
      if (!name) { toast('请填写名称', 'warn'); return; }
      var institution = $('#ap-inst').value.trim();
      var jurisdiction = $('#ap-jur').value.trim() || null;
      var sourceRef = $('#ap-src').value.trim() || null;
      var asOf = $('#ap-asof').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { toast('请选择核对日期', 'warn'); return; }

      if (!p.counts) {
        // 无余额资格：只登记状态与来源，明确不写金额
        Store.createResource('entitlements', {
          id: Core.newId('ent'),
          name: name,
          kind: p.entKind,
          jurisdiction: jurisdiction,
          status: $('#ap-status').value.trim() || null,
          balanceMinor: null,
          valuationType: 'none',
          sourceRef: sourceRef,
          asOf: asOf
        }).then(function () {
          closeSheet(); toast('已登记参保状态（不计入资产）');
          return refreshAssets();
        }).catch(resourceFail);
        return;
      }

      // 有明确余额：先建（或复用）受限资产账户，再登记 CNY 余额，金额因此只计一次
      var raw = $('#ap-bal').value.trim();
      var balanceMinor = Core.yuanToCents(raw);
      if (raw === '' || balanceMinor == null || balanceMinor < 0) { toast('请填写明确的余额金额', 'warn'); return; }
      var existingAcc = (state.assets.assetAccounts || []).find(function (x) { return x.name === p.account.name; });
      var accId = existingAcc ? existingAcc.id : Core.newId('aacc');
      Store.createResource('accounts', {
        id: accId,
        name: name,
        institution: institution,
        kind: p.account.kind,
        pool: p.account.pool,
        status: 'active'
      }).then(function () {
        var existingUnit = (state.assets.assetUnits || []).find(function (u) {
          return u.accountId === accId && u.currency === 'CNY';
        });
        return Store.createResource('account-units', {
          id: existingUnit ? existingUnit.id : Core.newId('au'),
          accountId: accId,
          currency: 'CNY',
          balanceMinor: balanceMinor,
          asOf: asOf,
          sourceType: 'manual'
        });
      }).then(function () {
        closeSheet();
        toast('已登记余额（计入资产，只计一次）');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'asset:fx': assetFxSheet,
    'asset:saveFx': function () {
      var base = $('#fx-base').value;
      var quote = $('#fx-quote').value;
      if (base === quote) { toast('两个币种不能相同', 'warn'); return; }
      var rateDecimal = $('#fx-rate').value.trim();
      if (!/^\d+(\.\d+)?$/.test(rateDecimal) || !(parseFloat(rateDecimal) > 0)) {
        toast('请输入大于 0 的十进制汇率', 'warn'); return;
      }
      var rateDate = $('#fx-date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) { toast('请选择汇率日', 'warn'); return; }
      Store.createResource('fx-rates', {
        base: base, quote: quote, rateDecimal: rateDecimal, rateDate: rateDate,
        provider: 'manual', status: 'ok'
      }).then(function () {
        closeSheet(); toast(base + '→' + quote + ' 汇率已登记');
        return refreshAssets();
      }).catch(resourceFail);
    },

    /* ---------- Phase 4B：标的目录 ---------- */

    'inst:search': function () {
      var el = $('#inst-q');
      if (el) state.instQuery = el.value.trim();
      runInstrumentSearch();
    },
    'inst:add': function (el) {
      var symbol = el && el.dataset ? el.dataset.symbol : '';
      if (!symbol) return;
      Store.createInstrument({ symbol: symbol }).then(function (r) {
        toast(r && r.duplicated ? '该标的已在目录中' : '已加入目录，待确认分类');
        return refreshAssets();
      }).then(function () {
        if (state.instQuery) runInstrumentSearch();
      }).catch(resourceFail);
    },
    'inst:manual': instrumentManualSheet,
    'inst:saveManual': function () {
      var symbol = $('#im-symbol').value.trim();
      if (!symbol) { toast('请填写公开证券代码', 'warn'); return; }
      var payload = { symbol: symbol, source: 'manual', currency: $('#im-currency').value };
      var name = $('#im-name').value.trim();
      var exchange = $('#im-exchange').value.trim();
      if (name) payload.name = name;
      if (exchange) payload.exchange = exchange;
      Store.createInstrument(payload).then(function () {
        closeSheet();
        toast('已手工建立标的，待确认分类');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'inst:confirm': function (el) {
      var id = el && el.dataset ? el.dataset.id : '';
      if (id) instrumentConfirmSheet(id);
    },
    'inst:saveConfirm': function (el) {
      var id = el && el.dataset ? el.dataset.id : '';
      if (!id) return;
      var payload = {
        instrumentId: id,
        assetClass: $('#ic-class').value,
        exposureMarket: $('#ic-exp').value
      };
      var idx = $('#ic-index').value.trim();
      if (idx) payload.trackingIndex = idx;
      Store.confirmInstrument(payload).then(function (r) {
        closeSheet();
        var n = r && r.conflicts ? r.conflicts.length : 0;
        toast(n ? '分类已锁定；参考数据有 ' + n + ' 项差异（已列出，未覆盖你的值）' : '分类已确认并锁定');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'inst:refresh': function (el) {
      var symbol = el && el.dataset ? el.dataset.symbol : '';
      if (!symbol) return;
      // 按参考数据刷新：已确认的标的不会被覆盖，只会把差异记成冲突提示
      Store.createInstrument({ symbol: symbol }).then(function (r) {
        var n = r && r.conflicts ? r.conflicts.length : 0;
        toast(n ? '参考数据与本地有 ' + n + ' 项差异（已列出，未覆盖）' : '参考数据已刷新；本地已确认值不变');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'close:detail': function (el) {
      var id = el && el.dataset ? el.dataset.id : '';
      if (!id) return;
      Store.getCloseSnapshot(id).then(function (r) {
        var snap = r && r.snapshot;
        if (!snap) { toast('快照不存在或已被清理', 'warn'); return; }
        var payload = null;
        try { payload = JSON.parse(snap.payloadJson || 'null'); } catch (e) { payload = null; }
        if (!payload) { toast('快照内容无法解析', 'err'); return; }
        snap.payload = payload;
        closeDetailSheet(snap);
      }).catch(function (e) {
        if (e && e.status === 404) { toast('快照不存在', 'warn'); return; }
        resourceFail(e);
      });
    },
    'close:save': function (el) {
      var status = el.dataset.status === 'formal' ? 'formal' : 'estimate';
      if (status === 'formal') {
        // 正式结账是高价值动作：确认一次，避免误触
        confirmSheet('正式结账', '将按上月最后一天的数据口径封存快照。确定继续？', '正式结账', function () {
          doMonthlyClose('formal');
        });
        return;
      }
      doMonthlyClose(status);
    },

    // V2.2.1 预算
    'budget:editTotal': budgetTotalSheet,
    'budget:saveTotal': function () {
      var cents = Core.yuanToCents($('#bd-total').value || '0') || 0;
      state.settings.budgets = state.settings.budgets || { total: 0, cats: {} };
      state.settings.budgets.total = cents;
      save(); closeSheet(); render();
      toast(cents > 0 ? '总预算已设置：¥' + Core.fmtMoney(cents) + '/月' : '已清除总预算');
    },
    'budget:editCat': function (el) { budgetCatSheet(el.dataset.id); },
    'budget:saveCat': function (el) {
      var cents = Core.yuanToCents($('#bd-cat').value || '0') || 0;
      state.settings.budgets = state.settings.budgets || { total: 0, cats: {} };
      state.settings.budgets.cats = state.settings.budgets.cats || {};
      if (cents > 0) state.settings.budgets.cats[el.dataset.id] = cents;
      else delete state.settings.budgets.cats[el.dataset.id];
      save(); closeSheet(); render();
      toast(cents > 0 ? '分类预算已保存' : '已清除该分类预算');
    },

    // V2.2.2-V2.2.4 消费体检
    'health:flag': function (el) {
      var flags = healthFlags();
      var v = el.dataset.v;
      if (flags[el.dataset.key] === v) delete flags[el.dataset.key]; // 再点取消
      else flags[el.dataset.key] = v;
      // 同步写入相关交易标志位
      var key = el.dataset.key.split('|').slice(1).join('|');
      var kind = el.dataset.key.split('|')[1];
      state.txns.forEach(function (t) {
        var hit = (kind === 'category-surge' && t.category === key.split('|')[0] && t.date.slice(0, 7) === state.ym && t.type === 'expense')
          || (kind !== 'category-surge' && t.merchant && t.merchant === key.split('|')[1]);
        if (hit) t.anomalyFlag = flags[el.dataset.key] || undefined;
      });
      save(); render();
    },
    'health:export': exportHealthReport,
    'health:sub2tpl': function (el) {
      var mer = el.dataset.mer;
      var subs = Core.detectSubscriptions(state.txns).filter(function (s) { return s.merchant === mer; });
      if (!subs.length) return;
      var s = subs[0];
      var tpl = {
        id: Core.newId('rc'), name: s.merchant, type: 'expense', amount: s.amount,
        accountId: defaultAccountId(), categoryId: null,
        frequency: (s.intervalDays >= 26 && s.intervalDays <= 35) ? 'monthly' : (s.intervalDays >= 6 && s.intervalDays <= 8) ? 'weekly' : 'yearly',
        day: Number(s.lastDate.slice(8, 10)), month: Number(s.lastDate.slice(5, 7)),
        note: '由订阅检测转入', active: true
      };
      state.settings.recurring = state.settings.recurring || [];
      state.settings.recurring.push(tpl);
      save();
      toast('已转为周期模板（' + freqLabel(tpl) + '），可到周期记账中调整');
      nav('recurring');
    },

    // V2.3.1 退款冲销
    'refund:link': function (el) {
      var rf = state.txns.find(function (x) { return x.id === el.dataset.id; });
      var ex = state.txns.find(function (x) { return x.id === el.dataset.target; });
      if (rf && ex) { Core.linkRefund(rf, ex); save(); closeSheet(); render(); toast('已关联，退款冲减原支出'); }
    },
    'refund:unlink': function (el) {
      var rf = state.txns.find(function (x) { return x.id === el.dataset.id; });
      if (rf) { Core.unlinkRefund(rf); save(); closeSheet(); render(); toast('已撤销关联'); }
    },

    // V2.3.2 报销
    'reim:mark': function (el) {
      var t = state.txns.find(function (x) { return x.id === el.dataset.id; });
      if (t) { t.reimburseFlag = true; save(); closeSheet(); render(); toast('已标记待报销'); }
    },
    'reim:unmark': function (el) {
      var t = state.txns.find(function (x) { return x.id === el.dataset.id; });
      if (t) { delete t.reimburseFlag; save(); closeSheet(); render(); toast('已取消待报销标记'); }
    },
    'reim:link': function (el) {
      // 为某笔垫付选择报销款收入
      var exp = state.txns.find(function (x) { return x.id === el.dataset.id; });
      if (!exp) return;
      var incomes = Core.visibleTxns(state.txns).filter(function (inc) {
        return inc.type === 'income' && !inc.refundOf && !inc.reimburseOf && !inc.refundFlag &&
          inc.amount === exp.amount && Core.daysBetween(exp.date, inc.date) >= 0;
      });
      if (!incomes.length) { toast('未找到金额相同且晚于垫付日期的收入', 'warn'); return; }
      openSheet('选择报销款收入', incomes.map(function (inc) {
        return '<button class="set-item" style="width:100%" data-action="reim:doLink" data-inc="' + esc(inc.id) + '" data-exp="' + esc(exp.id) + '">' +
          '<span class="si-icon">💰</span><span class="si-main"><div>' + esc(inc.merchant || '收入') + '</div>' +
          '<div class="si-sub">' + esc(inc.date) + '</div></span><span>¥' + Core.fmtMoney(inc.amount) + '</span></button>';
      }).join(''));
    },
    'reim:doLink': function (el) {
      var inc = state.txns.find(function (x) { return x.id === el.dataset.inc; });
      var exp = state.txns.find(function (x) { return x.id === el.dataset.exp; });
      if (inc && exp) {
        Core.linkReimbursement(inc, exp);
        save(); closeSheet(); render();
        toast('报销已闭环：垫付与报销款均不再计入收支');
      }
    },
    'reim:unlink': function (el) {
      var inc = state.txns.find(function (x) { return x.id === el.dataset.id; });
      if (inc) { Core.unlinkReimbursement(inc); save(); closeSheet(); render(); toast('已撤销报销关联'); }
    },

    // V2.3.3 周期记账
    'recur:add': function () { recurringSheet(null); },
    'recur:edit': function (el) {
      var tpl = (state.settings.recurring || []).find(function (t) { return t.id === el.dataset.id; });
      if (tpl) recurringSheet(tpl);
    },
    'recur:save': function (el) {
      var name = $('#rc-name').value.trim();
      var cents = Core.yuanToCents($('#rc-amount').value || '0') || 0;
      if (!name) { toast('请填写名称', 'warn'); return; }
      if (cents <= 0) { toast('金额需大于 0', 'warn'); return; }
      var data = {
        name: name, type: $('#rc-type').value, amount: cents,
        accountId: $('#rc-acc').value || null, categoryId: $('#rc-cat').value || null,
        frequency: $('#rc-freq').value,
        day: Math.min(31, Math.max(1, +$('#rc-day').value || 1)),
        month: Math.min(12, Math.max(1, +$('#rc-month').value || 1)),
        note: $('#rc-note').value.trim()
      };
      if (el.dataset.id) {
        var tpl = (state.settings.recurring || []).find(function (t) { return t.id === el.dataset.id; });
        if (tpl) Object.assign(tpl, data);
      } else {
        data.id = Core.newId('rc');
        data.active = true;
        state.settings.recurring = state.settings.recurring || [];
        state.settings.recurring.push(data);
      }
      save(); closeSheet(); render();
      toast('模板已保存');
    },
    'recur:del': function (el) {
      var id = el.dataset.id;
      var tpl = (state.settings.recurring || []).find(function (t) { return t.id === id; });
      closeSheet();
      confirmSheet('删除模板', '确定删除「' + esc(tpl ? tpl.name : '') + '」？已生成的历史交易保留。', '删除', function () {
        state.settings.recurring = (state.settings.recurring || []).filter(function (t) { return t.id !== id; });
        save(); render();
        toast('模板已删除');
      }, true);
    },
    'recur:toggle': function (el) {
      var tpl = (state.settings.recurring || []).find(function (t) { return t.id === el.dataset.id; });
      if (tpl) { tpl.active = tpl.active === false ? true : false; save(); render(); }
    },
    'recur:toggleAuto': function () {
      state.settings.recurringAuto = !state.settings.recurringAuto;
      save(); render();
      toast(state.settings.recurringAuto ? '已改为静默自动生成（下次打开生效）' : '已改为预览确认模式');
    },
    'recur:genThisMonth': function () {
      var occ = Core.dueRecurring((state.settings.recurring || []).filter(function (t) { return t.active !== false; }), curYM(), curYM());
      recurringPreviewSheet(occ);
    },
    'recur:previewDue': function () {
      var tpls = (state.settings.recurring || []).filter(function (t) { return t.active !== false; });
      var today = todayDateStr();
      var fromYm = state.settings.lastRun ? state.settings.lastRun.slice(0, 7) : curYM();
      var occ = Core.dueRecurring(tpls, fromYm, curYM()).filter(function (o) {
        return o.date <= today && (!state.settings.lastRun || o.date > state.settings.lastRun);
      });
      recurringPreviewSheet(occ);
    },
    'recur:backfill': function () {
      openSheet('补生成（漏月）',
        '<div class="small muted" style="margin-bottom:8px">选择起止月份，预览后确认生成。已生成过的日期会自动跳过。</div>' +
        '<div class="form-row">' +
        formItem('开始月份', '<select id="rb-from">' + monthOptions(ymShift(curYM(), -1)) + '</select>') +
        formItem('结束月份', '<select id="rb-to">' + monthOptions(curYM()) + '</select>') +
        '</div>' +
        '<button class="btn primary block" data-action="recur:backfillGo">预览</button>');
    },
    'recur:backfillGo': function () {
      var from = $('#rb-from').value, to = $('#rb-to').value;
      if (from > to) { toast('开始月份不能晚于结束月份', 'warn'); return; }
      var occ = Core.dueRecurring((state.settings.recurring || []).filter(function (t) { return t.active !== false; }), from, to);
      recurringPreviewSheet(occ);
    },
    'recur:applyPreview': applyRecurringPreview,
    'recur:undoOne': function (el) {
      var id = el.dataset.id;
      var t = state.txns.find(function (x) { return x.id === id; });
      if (!t) return;
      confirmSheet('撤销周期账', '删除「' + esc(t.merchant) + ' ' + esc(t.date) + ' ¥' + Core.fmtMoney(t.amount) + '」？', '删除', function () {
        state.txns = state.txns.filter(function (x) { return x.id !== id; });
        save(); render();
        toast('已撤销');
      }, true);
    },

    // PWA 安装指引
    'set:pwa': function () {
      openSheet('安装到主屏',
        '<div style="line-height:2;font-size:14px">' +
        '<b>Chrome / Edge（电脑）</b>：地址栏右侧 ⊕ 图标 → 安装<br>' +
        '<b>Chrome / Safari（安卓）</b>：菜单 ⋮ / 分享 → 添加到主屏幕 / 安装应用<br>' +
        '<b>Safari（iOS）</b>：分享 → 添加到主屏幕<br><br>' +
        '<span class="muted small">安装后可离线使用（Service Worker 已缓存全部静态资源）。本应用零外联网络，断网完整可用。</span></div>');
    },

    // 设置
    'set:lock': lockSheet,
    'lock:enable': lockEnable,
    'lock:disable': lockDisable,
    'lock:disableGo': lockDisableGo,
    'lock:change': lockChange,
    'lock:changeGo': lockChangeGo,
    'set:exportJson': exportJson,
    'set:exportCsv': exportCsv,
    'set:restore': function () { $('#file-restore').click(); },
    'set:clear': clearAllSheet,
    'clear:go': clearGo,
    'set:privacy': privacySheet,
    'set:howto': howtoSheet,

    // 账户
    'acc:add': function () { accountSheet(null); },
    'acc:edit': function (el) { accountSheet(accountById(el.dataset.id)); },
    'acc:restore': function (el) {
      var a = accountById(el.dataset.id);
      if (a) { delete a.deleted; save(); render(); toast('账户已恢复'); }
    },
    'acc:save': function (el) {
      var id = el.dataset.id;
      var name = $('#acc-name').value.trim();
      if (!name) { toast('请填写账户名', 'warn'); return; }
      var type = $('#acc-type').value;
      var init = Core.yuanToCents($('#acc-init').value || '0') || 0;
      var aliases = $('#acc-alias').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (id) {
        var a = accountById(id);
        a.name = name; a.type = type; a.initialBalance = init; a.aliases = aliases;
      } else {
        state.accounts.push({
          id: Core.newId('acc'), name: name, type: type,
          color: { wechat: '#07c160', alipay: '#1677ff', bank: '#f59e0b', cash: '#64748b' }[type],
          initialBalance: init, order: state.accounts.length + 1, aliases: aliases
        });
      }
      closeSheet(); save(); render();
      toast('账户已保存');
    },
    'acc:del': function (el) {
      var id = el.dataset.id;
      var a = accountById(id);
      var used = state.txns.filter(function (t) { return t.account === id || t.accountTo === id; }).length;
      closeSheet();
      confirmSheet('删除账户', used
        ? '「' + esc(a.name) + '」关联 ' + used + ' 笔交易。删除后<b>交易保留</b>，显示为「已删除账户」，可随时恢复。'
        : '确定删除账户「' + esc(a.name) + '」？', '删除', function () {
        var acc = accountById(id);
        if (acc) acc.deleted = true;
        save(); render();
        toast('已删除（历史交易保留，可恢复）');
      }, true);
    },

    // 分类
    'cat:add': function (el) { categorySheet(null, el.dataset.type); },
    'cat:edit': function (el) { categorySheet(categoryById(el.dataset.id)); },
    'cat:pickIcon': function (el) {
      window._catIcon = el.dataset.icon;
      $all('#cat-icons .cat-cell').forEach(function (b) { b.classList.remove('active'); });
      el.classList.add('active');
    },
    'cat:save': function (el) {
      var id = el.dataset.id, type = el.dataset.type;
      var name = $('#cat-name').value.trim();
      if (!name) { toast('请填写分类名', 'warn'); return; }
      var kws = $('#cat-kw').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
      var icon = window._catIcon || '📦';
      var parentId = ($('#cat-parent') || {}).value || null;
      var necessity = type === 'expense' ? (($('#cat-nec') || {}).value || null) : null;
      if (id) {
        var c = categoryById(id);
        c.name = name; c.keywords = kws; c.icon = icon;
        c.parentId = (parentId === id) ? null : parentId; // 防自引用
        if (parentId && wouldCreateCycle(id, parentId)) { toast('不能选择自己的子分类作父级', 'warn'); return; }
        c.necessity = necessity;
      } else {
        if (parentId && wouldCreateCycle(null, parentId)) { toast('父级分类无效', 'warn'); return; }
        state.categories.push({
          id: Core.newId('cat'), type: type, name: name, icon: icon,
          keywords: kws, parentId: parentId, necessity: necessity
        });
      }
      closeSheet(); save(); render();
      toast('分类已保存，关键词立即生效');
    },
    'cat:del': function (el) {
      var id = el.dataset.id;
      var c = categoryById(id);
      var used = state.txns.filter(function (t) { return t.category === id; }).length;
      closeSheet();
      confirmSheet('删除分类', used
        ? '「' + esc(c.name) + '」关联 ' + used + ' 笔交易。删除后交易转为<b>未分类</b>（不会丢失）。'
        : '确定删除分类「' + esc(c.name) + '」？', '删除', function () {
        state.categories = state.categories.filter(function (x) { return x.id !== id; });
        state.txns.forEach(function (t) { if (t.category === id) t.category = null; });
        save(); render();
        toast('已删除，关联交易转为未分类');
      }, true);
    },

    // 导入向导
    'wiz:pickFile': wizPickFile,
    'wiz:tpl': function (el) { wizUseTemplate(el.dataset.id); },
    'wiz:restart': function () { newWizard(); render(); },
    'wiz:again': function () { newWizard(); render(); },
    'wiz:next': function () { var w = state.wiz; w.step = 3; render(); },
    'wiz:back': function () { var w = state.wiz; w.step = Math.max(1, w.step - 1); render(); },
    'wiz:dedup': wizRunDedup,
    'wiz:decide': function (el) {
      state.wiz.decisions[el.dataset.i] = el.dataset.v;
      render();
    },
    'wiz:apply': wizApplyImport,
    'bm:apply': wizApplyCustomMap
  };

  var changes = {
    'filter:type': function (el) { state.listFilters.type = el.value; render(); filterSheet(); },
    'filter:account': function (el) { state.listFilters.account = el.value; render(); filterSheet(); },
    'filter:category': function (el) { state.listFilters.category = el.value; render(); filterSheet(); },
    'wiz:typeMap': function (el) { state.wiz.typeMapping[el.dataset.key] = el.value; },
    'wiz:accMap': function (el) { state.wiz.accountMapping[el.dataset.key] = el.value; },
    'wiz:transferTarget': function (el) { state.wiz.transferTarget = el.value || null; },
    'bm:col': function (el) {
      var w = state.wiz;
      w.customCols = w.customCols || {};
      w.customCols[el.dataset.k] = el.value;
    },
    'bm:dd': function (el) { state.wiz.dd = el.value || null; }
  };

  var inputs = {
    'list:q': function (el) {
      state.listFilters.q = el.value;
      var list = $('#view .txn-list');
      // 轻量重渲染明细主体，保留搜索框焦点
      var tmp = document.createElement('div');
      tmp.innerHTML = tplList();
      if (list) list.outerHTML = tmp.querySelector('.txn-list').outerHTML;
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    // 文件输入不带 data-change，必须先按 id 分流，否则选择文件后无响应
    if (t && t.tagName === 'INPUT' && t.type === 'file') {
      if (!t.files || !t.files[0]) return; // 用户取消选择：保持当前状态不变
      if (t.id === 'wiz-file') wizFileChosen(t.files[0]);
      else if (t.id === 'file-restore') restoreBackup(t.files[0]);
      return;
    }
    var el = t.closest('[data-change]');
    if (!el) return;
    var fn = changes[el.dataset.change];
    if (fn) fn(el);
  });
  document.addEventListener('input', function (e) {
    var el = e.target.closest('[data-input]');
    if (!el) return;
    var fn = inputs[el.dataset.input];
    if (fn) fn(el);
  });
  $('#sheet-mask').addEventListener('click', function (e) {
    if (e.target === $('#sheet-mask')) closeSheet();
  });

  init();
})();
