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
  var APP_VERSION = '2.4.28-help';
  // 追加式事实集合的键名只有一份定义（Store 导出），页面不另列一套（D-025）。
  var COMPANION_KEYS = Store.COMPANION_KEYS;

  /* ================= 状态 ================= */
  var state = {
    ready: false,
    helpQuery: '',
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
    closes: [], closesLoaded: false, closesLoading: false, // Phase 3：月度结账历史
    baselineCloseId: null, // Phase 4E：收益归因选中的期初基准（结账快照 id，null = 用默认基准）
    // G4E-1（复核补口）：归因期初腿只认基准快照 payload 里封存的逐持仓明细。
    // { closeId, status: 'idle'|'loading'|'ready'|'error', payload, hashValid }。
    // payload 是快照原文对象；只有服务端明确返回 hashValid=true 时才允许用于归因。
    attrSnap: { closeId: null, status: 'idle', payload: null, hashValid: null },
    // Phase 4B：标的目录（检索结果只存在内存里，不写事实源；事实源只有 instruments 表）
    instQuery: '', instResult: null, instBusy: false, instError: '',
    // Phase 5B：风险评估（问卷草稿只活在内存；已保存的评估只有 SQLite risk_assessments 一份）
    riskItems: [], riskCurrent: null, riskLoaded: false, riskLoading: false, riskError: '',
    // Phase 5E-1：决策台摘要复用同一份服务端判定（riskCurrent），另记读取状态，
    // 使「读不到 / 读取中」不会冒充「没有评估」。
    riskCurrentLoading: false, riskCurrentError: '', riskCurrentRequest: 0,
    riskView: 'list', // 'list' | 'form'
    riskDraft: { answers: {}, reason: 'initial' },
    // Phase 5C：目标配置与认可标的（视图数据全部来自服务端，页面不重算）
    targetsView: null, targetsItems: [], targetsLoaded: false, targetsLoading: false, targetsError: '',
    targetsLoadPromise: null,
    // Phase 5E-2：决策台配置对照独立持有服务端 /targets/current 的只读快照，
    // 与目标页的 targetsView 分开，避免首页复核打断目标页交互。
    // allocCompareHtml 缓存最近一次生成的卡片 HTML，内容未变时不替换 DOM。
    allocCurrent: null, allocCurrentLoading: false, allocCurrentError: '', allocCurrentRequest: 0,
    allocCompareHtml: '',
    // Phase 5D：新增资金建议（金额是用户输入，其余全部来自服务端建议产物）
    advice: null, adviceAmount: '', adviceBusy: false, adviceError: '',
    // G5-R2：建议是否仍然对应「当前事实」由页面按封存输入做事实比对（不做任何分配重算）。
    //   assetsSig   —— 目标页最近一次读到的 raw.assets 指纹，用于发现余额 / 持仓 / 行情变化；
    //   factsEpoch  —— 事实视图的代数；生成建议期间代数变了，说明晚到的响应已过期，必须丢弃。
    assetsSig: null, factsEpoch: 0,
    // Phase 6C：决策与待执行。状态、金额与门禁一律呈现服务端 /decisions 结果（拆解 §5），
    // 页面不重算转移合法性。decRequest / decSubmitSeq 是慢响应守卫：晚到的读取或提交
    // 不得覆盖用户已看到的新状态。
    decItems: [], decTotal: 0, decInvalidCount: 0,
    decLoaded: false, decLoading: false, decError: '', decRequest: 0,
    decStateFilter: '',
    // Phase 6E：月度历史。decMonths = 服务端列表聚合的状态事件月（YYYY-MM）；月份与状态
    // 筛选互为与关系，翻月与返回不清空（数据在本地已读集合上过滤，不重新请求）。
    decMonths: [], decMonthFilter: '',
    decDetail: null, decDetailError: '', decDetailSeq: 0,
    decSheetRec: null,          // 决定弹层当前对应的服务端建议记录（含 result）
    decNoteDraft: '',           // 决定理由草稿：弹层重绘（如失败回显）不丢用户已打的字
    decBusy: false, decSubmitError: '', decSubmitSeq: 0,
    // Phase 6D：实际交易关联与执行确认。decLinkEvents = 详情弹层里可选的买入事件（服务端
    // /security-events），decLinkPending = 「新增交易后按 id 关联」的待关联决策，
    // decActionBusy = 关联 / 解绑 / 状态推进的防重复点击门闩，decActionError 就地显示。
    decLinkEvents: null, decLinkEventsError: '', decLinkPending: null,
    decActionBusy: false,
    // 追加式事实集合：null = 内存无副本（保存时由门面按服务端现值补回）；
    // 只有「从备份恢复」会临时给出整份集合作为覆盖写入。
    riskAssessments: null, allocationTargets: null, approvedInstruments: null,
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
    var payload = {
      accounts: state.accounts, categories: state.categories,
      txns: state.txns, settings: state.settings, assets: state.assets
    };
    // 追加式事实集合（评估 / 目标 / 认可标的）平时**不**随页面保存提交 —— Store 门面会按服务端
    // 现值补回，记一笔账不可能抹掉这些事实。只有「从备份恢复」会显式给出整份集合（覆盖语义）。
    COMPANION_KEYS.forEach(function (k) {
      if (Array.isArray(state[k])) payload[k] = state[k];
    });
    var explicit = COMPANION_KEYS.some(function (k) { return Array.isArray(state[k]); });
    return Store.saveAll(payload, options).then(function () {
      if (explicit) COMPANION_KEYS.forEach(function (k) { state[k] = null; }); // 缓存只服务这一次覆盖写入
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

  /* ================= Phase 5B：风险评估与复评（D-047） =================
   * 页面只是展示与提交入口：评分、等级、上限、到期与「当前有效评估」全部由
   * js/domain.js 的冻结规则与服务端计算，这里不写第二套判断（不变量 3）。
   * 显示文案只是渲染层（持久化只认题目/选项 id，D-046 ①）；逐项知识卡属 5E。
   */
  var RISKQ_LABELS = {
    q_income_stability: '收入稳定性：你的收入来源是否稳定可预期？',
    q_emergency_fund: '应急金覆盖：安全储备能覆盖几个月必要支出？',
    q_debt_pressure: '负债压力：当前负债与近期应付款的压力如何？',
    q_horizon: '投资期限：这笔可投资资金你预计多久不动用？',
    q_liquidity_need: '近期流动性需求：未来一年是否有较大用款计划？',
    q_experience: '投资经验：你有多年的投资经历？',
    q_knowledge: '基础知识：你对资产类别的风险收益特征了解多少？',
    q_drawdown_tolerance: '回撤承受：账面短期最大下跌多少你会坚持持有？',
    q_fx_understanding: '汇率与跨境风险：你理解持有外币资产的汇率影响吗？'
  };
  var RISKO_LABELS = {
    o_fixed_stable: '固定工资，稳定可预期', o_variable_predictable: '浮动但大体可预测',
    o_irregular: '不规则收入', o_no_stable_income: '没有稳定收入',
    o_cover_12m_plus: '12 个月以上', o_cover_6_12m: '6–12 个月', o_cover_3_6m: '3–6 个月',
    o_cover_under_3m: '不足 3 个月',
    o_no_debt: '无负债', o_manageable: '可控', o_heavy: '压力较大',
    o_current_due_or_overdue: '近期应付款紧迫或已逾期',
    o_horizon_10y_plus: '10 年以上', o_horizon_5_10y: '5–10 年', o_horizon_3_5y: '3–5 年',
    o_horizon_under_3y: '不足 3 年',
    o_no_need: '没有计划中的用款', o_minor_need: '仅有小额需求', o_planned_1_3y: '1–3 年内有明确计划',
    o_large_within_1y: '一年内有大额用款',
    o_exp_5y_plus: '5 年以上', o_exp_2_5y: '2–5 年', o_exp_under_2y: '不足 2 年', o_exp_none: '几乎没有',
    o_know_solid: '理解较扎实', o_know_basic: '基础了解', o_know_limited: '了解有限', o_know_none: '基本不了解',
    o_dd_over_30: '30% 以上', o_dd_20_30: '20–30%', o_dd_10_20: '10–20%', o_dd_under_10: '不足 10%',
    o_fx_clear: '清楚会折算与波动', o_fx_partial: '部分理解', o_fx_limited: '了解有限', o_fx_none: '不了解'
  };
  var RISKDIM_LABELS = {
    income_stability: '收入稳定性', emergency_fund: '应急金覆盖', debt_pressure: '负债与近期应付款',
    horizon: '投资期限', liquidity_need: '近期流动性需求',
    experience: '投资经验', knowledge: '基础知识', drawdown_tolerance: '最大可接受回撤',
    fx_understanding: '跨境与汇率风险理解'
  };
  var RISKREASON_LABELS = {
    initial: '首次评估', annual_expired: '年度到期复评', income_change: '收入变化',
    debt_change: '负债变化', overseas_status_change: '外派/跨境状态变化',
    major_goal_change: '重大目标变化', liquidity_change: '流动性需求变化', manual: '手动复评'
  };
  var RISKSTATUS_LABELS = { valid: '有效', expiring_soon: '即将到期', expired: '已过期' };
  var RISKCEILSOURCE_LABELS = {
    capacity: '客观承受能力较低的一侧',
    willingness: '主观风险意愿较低的一侧',
    equal: '能力与意愿同为最低',
    hard_cap: '硬封顶条件压低（关键短板优先于总分）'
  };
  var RISKHARDCAP_LABELS = {
    hard_cap_emergency_fund: '应急金不足 3 个月',
    hard_cap_income_stability: '没有稳定收入',
    hard_cap_liquidity_need: '一年内有大额用款计划',
    hard_cap_debt_pressure: '近期应付款紧迫或已逾期'
  };

  function riskOptionLabel(optionId) { return RISKO_LABELS[optionId] || optionId; }
  function riskDimLabel(d) { return RISKDIM_LABELS[d] || d; }

  function riskResultBlock(rec, validity) {
    var html = '<div class="card"><div class="row"><b>评估结果 · 风险上限 L' + rec.ceiling + '</b>' +
      '<span class="small muted" style="margin-left:auto">规则 ' + esc(rec.ruleVersion) + '</span></div>' +
      '<div class="small muted">承受能力：' + rec.capacityScore + ' 分（0–15）→ 第 ' + rec.capacityLevel + ' 级' +
      ' ｜ 风险意愿：' + rec.willingnessScore + ' 分（0–12）→ 第 ' + rec.willingnessLevel + ' 级</div>' +
      '<div class="small" style="margin-top:6px">最终上限取<b>较低</b>的一侧：由「' +
      esc(RISKCEILSOURCE_LABELS[rec.ceilingSource] || rec.ceilingSource) + '」决定；高意愿不能覆盖低能力。</div>';
    if (rec.hardCaps.length) {
      html += '<div class="small" style="margin-top:6px"><b>硬封顶命中（只降不升）：</b>' +
        rec.hardCaps.map(function (c) { return esc(RISKHARDCAP_LABELS[c.code] || c.code) + '（压到 L' + c.maxLevel + '）'; }).join('；') + '</div>';
    }
    if (validity) {
      html += '<div class="small muted" style="margin-top:6px">' +
        (validity.status === 'expired'
          ? '本评估已于 ' + esc(validity.expiry) + ' 过期，只作历史回看；请复评。'
          : '有效期至 ' + esc(validity.expiry) + '（剩 ' + validity.remainingDays + ' 天）' +
            (validity.status === 'expiring_soon' ? '，即将到期' : '') + '。') +
        '</div>';
    }
    return html + '<div class="small muted" style="margin-top:4px">边界说明：本页面只给出风险上限；目标区间由 5C 的' +
      '<button class="link" data-action="nav:targets">目标配置</button> 页按上限映射冻结模板得到并维护认可标的，' +
      '新增资金分配由 5D 在同一页给出（只补低配、不卖出）。本页面不预测收益、不推荐证券、不接收投资金额。</div></div>';
  }

  function riskHistoryBlock(items, currentId) {
    return '<div class="sec-head"><b>评估历史（追加版本，永不覆盖）</b></div>' +
      '<div class="card">' + items.map(function (r) {
        return '<div class="acc-card"><div class="row"><b>' + esc(r.assessedAt) + ' 评估</b>' +
          '<span class="small muted" style="margin-left:auto">' +
          esc(RISKREASON_LABELS[r.reason] || r.reason) + (r.id === currentId ? ' · 当前' : '') + '</span></div>' +
          '<div class="small muted">上限 L' + r.ceiling + '（' + esc(RISKCEILSOURCE_LABELS[r.ceilingSource] || r.ceilingSource) + '）' +
          ' · 能力 ' + r.capacityScore + '/意愿 ' + r.willingnessScore + ' · 至 ' + esc(r.expiry) + '</div>' +
          '<div class="small muted">规则 ' + esc(r.ruleVersion) + ' · 保存于 ' + esc(String(r.createdAt).slice(0, 19).replace('T', ' ')) + '</div>' +
          '</div>';
      }).join('') + '</div>';
  }

  /* 5E-4：本地知识卡入口。页面只按已知 id 生成链接（未知 id 不渲染入口，
     打开时 know:open 再统一走 Knowledge.getCard）；卡片只解释概念与规则来源，
     不带账户事实、不构成建议（D-051）。Knowledge 未加载时静默不出入口。 */
  function knowledgeLinkHtml(cardId, label) {
    if (typeof window === 'undefined' || !window.Knowledge || !window.Knowledge.getCard(cardId)) return '';
    return ' <button type="button" class="link" data-action="know:open"' +
      ' data-card-id="' + esc(cardId) + '">' + esc(label) + '</button>';
  }

  /* 5E-1：决策台风险摘要卡。数值与判定全部来自服务端的当前评估视图
     （Store.riskAssessmentCurrent → 领域 selectCurrentAssessment），本页只格式化：
     不重算评分/等级/上限/到期，也不据此生成建议（D-047 ⑧、不变量 3）。
     无评估 / 有效 / 即将到期 / 已过期 / 记录不可用 / 读不到 各为独立状态，
     过期与读取失败都不得显示为「当前有效」，缺数据也不显示 0 分或 L0。 */
  function riskSummaryCardHtml() {
    var view = 'none', status = '', chip = '', attrs = '', body = '', reason = 'initial';

    function chipHtml(text, kind) {
      return '<span class="dash-chip' + (kind ? ' ' + kind : '') + '" data-risk-chip="' + esc(text) + '">' +
        esc(text) + '</span>';
    }
    // 复核不过的记录数必须显式留证据，不能静默消失（D-047 ⑥）。
    function invalidNote(cur) {
      return cur.invalidCount > 0
        ? '<div class="small muted" data-risk-invalid="' + cur.invalidCount + '/' + cur.total + '">' +
          '另有 ' + cur.invalidCount + '/' + cur.total + ' 条评估记录未通过服务端复核，未计入上面的判定。</div>'
        : '';
    }

    if (Store.info().mode !== Store.MODE_API) {
      view = 'unavailable';
      chip = chipHtml('未连接服务', 'warn');
      // G5-R3：知识卡是本地静态内容，不依赖账户事实与 API。服务不可达时这里不能变成死路 ——
      // 用户仍要能从真实页面入口点开知识卡（断网重载后也要能点）。
      var offlineKnow = knowledgeLinkHtml('card-capacity-vs-willingness', '能力与意愿说明');
      body = '<div class="small">风险上限的判定由本地服务按冻结规则给出。运行 start.command' +
        '（或 node server/main.js）后可在这里查看当前评估。' +
        (offlineKnow ? '<br>不依赖服务，现在就能读：' + offlineKnow : '') + '</div>';
    } else {
      var cur = state.riskCurrent;
      status = (cur && cur.status) || '';
      if (!cur) {
        view = state.riskCurrentError ? 'error' : 'loading';
        chip = chipHtml(state.riskCurrentError ? '读取失败' : '读取中', state.riskCurrentError ? 'warn' : '');
        body = '<div class="small' + (state.riskCurrentError ? '' : ' muted') + '">' +
          (state.riskCurrentError ? '风险评估判定读取失败：' + esc(state.riskCurrentError) : '正在读取当前评估判定…') +
          '</div>';
      } else if (status === 'current') {
        var rec = cur.current.assessment;
        var val = cur.current.validity;
        view = val.status === 'expiring_soon' ? 'expiring' : 'valid';
        chip = chipHtml(RISKSTATUS_LABELS[val.status], val.status === 'expiring_soon' ? 'warn' : 'ok');
        reason = 'manual';
        attrs = ' data-risk-validity="' + esc(val.status) + '"' +
          ' data-risk-ceiling="' + rec.ceiling + '"' +
          ' data-risk-capacity="' + rec.capacityScore + '/' + rec.capacityLevel + '"' +
          ' data-risk-willingness="' + rec.willingnessScore + '/' + rec.willingnessLevel + '"' +
          ' data-risk-ceiling-source="' + esc(rec.ceilingSource) + '"' +
          ' data-risk-hard-caps="' + esc(rec.hardCaps.map(function (c) { return c.code; }).join(',')) + '"' +
          ' data-risk-assessed-at="' + esc(rec.assessedAt) + '"' +
          ' data-risk-expiry="' + esc(rec.expiry) + '"' +
          ' data-risk-remaining-days="' + val.remainingDays + '"' +
          ' data-risk-reason="' + esc(rec.reason) + '"';
        body = '<div class="small" data-risk-ceiling-line>最终风险上限 <b>L' + rec.ceiling + '</b>' +
          ' · 取<b>较低</b>的一侧：' + esc(RISKCEILSOURCE_LABELS[rec.ceilingSource] || rec.ceilingSource) +
          '（高意愿不能覆盖低能力）' + knowledgeLinkHtml('card-capacity-vs-willingness', '能力与意愿') + '</div>' +
          '<div class="small muted">承受能力 ' + rec.capacityScore + ' 分（0–15）→ 第 ' + rec.capacityLevel + ' 级' +
          ' ｜ 风险意愿 ' + rec.willingnessScore + ' 分（0–12）→ 第 ' + rec.willingnessLevel + ' 级</div>' +
          (rec.hardCaps.length
            ? '<div class="small"><b>硬封顶命中（只降不升）：</b>' +
              rec.hardCaps.map(function (c) {
                return esc(RISKHARDCAP_LABELS[c.code] || c.code) + '（压到 L' + c.maxLevel + '）' +
                  knowledgeLinkHtml(c.explainKey, '说明');
              }).join('；') + '</div>'
            : '') +
          '<div class="small muted">评估日期 ' + esc(rec.assessedAt) + ' · 到期日 ' + esc(rec.expiry) +
          '（剩 ' + val.remainingDays + ' 天）· 触发原因：' + esc(RISKREASON_LABELS[rec.reason] || rec.reason) +
          ' · 规则 ' + esc(rec.ruleVersion) + '</div>' +
          (val.status === 'expiring_soon'
            ? '<div class="small">即将到期：到期日次日判定即失效，正式建议需要一份未过期的评估。</div>'
            : '');
      } else if (status === 'all_expired') {
        view = 'expired';
        chip = chipHtml(RISKSTATUS_LABELS.expired, 'warn');
        reason = 'annual_expired';
        attrs = ' data-risk-validity="expired"' +
          ' data-risk-assessed-at="' + esc((cur.expiredRef && cur.expiredRef.assessedAt) || '') + '"' +
          ' data-risk-expiry="' + esc((cur.expiredRef && cur.expiredRef.expiry) || '') + '"';
        body = '<div class="small">评估已过期：最近一份评估（' +
          esc((cur.expiredRef && cur.expiredRef.assessedAt) || '—') + '）已于 ' +
          esc((cur.expiredRef && cur.expiredRef.expiry) || '—') +
          ' 过期，只作历史回看，不能用于正式建议。</div>' +
          '<div class="small muted">市场涨跌本身不触发复评，到期或收入 / 负债 / 外派 / 目标 / 流动性变化时才需要复评。</div>';
      } else if (status === 'no_assessment') {
        view = 'none';
        chip = chipHtml('尚未评估', '');
        body = '<div class="small">还没有有效的风险评估。正式的新增资金建议要求一份未过期的评估；' +
          '问卷约需 2 分钟。没有评估时这里不显示任何上限或得分。</div>';
      } else {
        // invalid_records 以及未来新增的状态：fail closed，只报状态不猜数值。
        view = 'invalid';
        status = status || 'unknown';
        chip = chipHtml('无法判定', 'warn');
        reason = 'manual';
        attrs = ' data-risk-invalid="' + ((cur && cur.invalidCount) || 0) + '/' + ((cur && cur.total) || 0) + '"';
        body = '<div class="small">已保存的评估记录与当前冻结规则校验不一致（' +
          ((cur && cur.invalidCount) || 0) + '/' + ((cur && cur.total) || 0) + ' 条），' +
          '按 fail closed 处理：不使用失效记录，也不在这里给出上限。</div>';
      }
      if (cur) body += invalidNote(cur);
      if (cur && state.riskCurrentLoading) {
        view = 'refreshing';
        chip = chipHtml('核对中', 'warn');
        body += '<div class="small" data-risk-pending>正在向本机服务复核。上面是上次读取的结果，' +
          '在复核完成前不能视为当前有效判定。</div>';
      }
      if (cur && state.riskCurrentError) {
        view = 'stale';
        chip = chipHtml('未复核', 'warn');
        body += '<div class="small" data-risk-stale>最近一次复核失败：' + esc(state.riskCurrentError) +
          '。上面的判定是上一次读取的结果，可能已不是当前状态。</div>';
      }
    }

    // 摘要读不到也不收回入口：风险页自己会说明服务与判定状态（5E-1 只加只读卡，不改导航）。
    var entry = '<div class="row" style="gap:10px;margin-top:10px">' +
      '<button class="btn small" data-action="nav:risk">评估详情与历史</button>' +
      '<button class="btn small ghost" data-action="risk:reassess" data-reason="' + esc(reason) + '">' +
      (reason === 'initial' ? '开始评估问卷' : '复评') + '</button></div>';
    var retry = state.riskCurrentError
      ? '<div style="margin-top:8px"><button class="btn small ghost" data-action="risk:retry">重新读取评估判定</button></div>'
      : '';
    return '<div class="card" data-risk-summary="' + esc(view) + '"' +
      ' data-risk-status="' + esc(status) + '"' + attrs + '>' +
      '<div class="row"><b>风险评估</b><span style="margin-left:auto">' + chip + '</span></div>' +
      body + entry + retry + '</div>';
  }

  // 只替换摘要卡，避免服务端响应打断归因基准等决策台上的其它交互。
  function refreshRiskSummaryCard() {
    if (state.page !== 'home') return;
    var card = $('#view [data-risk-summary]');
    if (card) card.outerHTML = riskSummaryCardHtml();
  }

  function ensureRiskCurrentLoaded() {
    if (state.riskCurrentLoading) return;
    if (Store.info().mode !== Store.MODE_API) return;
    var request = ++state.riskCurrentRequest;
    state.riskCurrentLoading = true;
    state.riskCurrentError = '';
    refreshRiskSummaryCard();
    Store.riskAssessmentCurrent().then(function (r) {
      if (request !== state.riskCurrentRequest) return;
      state.riskCurrentLoading = false;
      state.riskCurrent = r || null;
      state.riskCurrentError = '';
      refreshRiskSummaryCard();
    }).catch(function (e) {
      if (request !== state.riskCurrentRequest) return;
      state.riskCurrentLoading = false;
      state.riskCurrentError = (e && e.message) || '风险评估判定读取失败';
      refreshRiskSummaryCard();
    });
  }

  /* 5E-2：决策台六类配置对照。金额、比例、容忍带与偏离全部来自
     GET /api/v1/targets/current（Store.allocationCurrent），本页只格式化：
     不重算比例、偏离或 canAdvise（不变量 3 / D-025 / D-050）。
     无目标 / 无估值 / 分类未确认 / 读不到 各为独立状态，缺数据不得出现 0% 或正式口径。 */
  function allocationCompareCardHtml() {
    var view = 'none', status = '', chip = '', attrs = '', body = '';

    function chipHtml(text, kind) {
      return '<span class="dash-chip' + (kind ? ' ' + kind : '') + '" data-alloc-chip="' + esc(text) + '">' +
        esc(text) + '</span>';
    }

    function entryBlock(showGenerate) {
      return '<div class="row" style="gap:10px;margin-top:10px">' +
        '<button class="btn small" data-action="nav:targets">' +
        (showGenerate ? '去目标页生成区间' : '目标配置与维护') + '</button></div>';
    }

    // 六类行：data 属性逐项等于服务端 classes[]，供 wiring 与 API 同源核对。
    function classRowsHtml(alloc, missing) {
      return (alloc.classes || []).map(function (c) {
        var isMissing = missing.indexOf(c.assetClass) >= 0;
        var pct = c.pctBps == null ? null : bpsText(c.pctBps);
        var band = c.band ? (BAND_LABELS[c.band] || c.band) : '';
        var dev = c.deviationBps == null ? null : signedBpsText(c.deviationBps);
        var detail;
        if (pct == null) {
          detail = '目标 ' + bpsText(c.minBps) + ' / ' + bpsText(c.targetBps) + ' / ' + bpsText(c.maxBps) +
            ' · 比例不可用';
        } else {
          detail = pct + ' / 目标 ' + bpsText(c.minBps) + ' / ' + bpsText(c.targetBps) + ' / ' + bpsText(c.maxBps) +
            (band ? ' · ' + band : '') + (dev != null ? ' · ' + dev : '');
        }
        return '<div class="risk-row" data-alloc-cls="' + esc(c.assetClass) + '"' +
          ' data-value-minor="' + c.valueMinor + '"' +
          ' data-pct-bps="' + (c.pctBps == null ? '' : c.pctBps) + '"' +
          ' data-min-bps="' + c.minBps + '"' +
          ' data-target-bps="' + c.targetBps + '"' +
          ' data-max-bps="' + c.maxBps + '"' +
          ' data-band="' + esc(c.band == null ? '' : c.band) + '"' +
          ' data-deviation-bps="' + (c.deviationBps == null ? '' : c.deviationBps) + '"' +
          ' data-missing-map="' + (isMissing ? '1' : '0') + '">' +
          '<span class="r-name">' + esc((RISK_CLASS_LABELS[c.assetClass] || c.assetClass) +
            (isMissing ? ' · 缺映射' : '')) + '</span>' +
          '<span class="r-bar">' + (pct == null ? '' :
            '<i style="width:' + Math.min((c.pctBps || 0) / 100, 100) + '%"></i>') + '</span>' +
          '<span class="r-val">' + Core.fmtMoney(c.valueMinor) + '</span>' +
          '<span class="r-pct">' + esc(detail) + '</span></div>';
      }).join('');
    }

    function blockersHtml(alloc) {
      if (alloc.canAdvise || !(alloc.blockers || []).length) return '';
      return '<div class="db-list" style="margin-top:6px">' + alloc.blockers.map(function (b) {
        return '<div class="db-item" data-alloc-blocker="' + esc(b.code) + '">· ' + esc(blockerText(b)) + '</div>';
      }).join('') + '</div>';
    }

    if (Store.info().mode !== Store.MODE_API) {
      view = 'unavailable';
      chip = chipHtml('未连接服务', 'warn');
      // G5-R3：与风险摘要同理，配置对照的服务不可达分支也要留本地知识卡入口。
      var offlineKnow = knowledgeLinkHtml('card-tolerance-band', '容忍带说明');
      body = '<div class="small">配置对照由本地服务在同一遍估值上给出当前与目标偏离。' +
        '运行 start.command（或 node server/main.js）后可在这里查看。' +
        (offlineKnow ? '<br>不依赖服务，现在就能读：' + offlineKnow : '') + '</div>';
    } else {
      var cur = state.allocCurrent;
      status = (cur && cur.status) || '';
      if (!cur) {
        view = state.allocCurrentError ? 'error' : 'loading';
        chip = chipHtml(state.allocCurrentError ? '读取失败' : '读取中', state.allocCurrentError ? 'warn' : '');
        body = '<div class="small' + (state.allocCurrentError ? '' : ' muted') + '">' +
          (state.allocCurrentError
            ? '配置对照读取失败：' + esc(state.allocCurrentError)
            : '正在读取当前配置对照…') +
          '</div>';
      } else if (status === 'current' && cur.allocation && cur.target) {
        var alloc = cur.allocation;
        var target = cur.target;
        var missing = cur.missingClasses || [];
        attrs = ' data-alloc-asof="' + esc(alloc.asOf) + '"' +
          ' data-alloc-level="' + target.level + '"' +
          ' data-alloc-investable="' + alloc.investableTotalMinor + '"' +
          ' data-alloc-canadvise="' + (alloc.canAdvise ? '1' : '0') + '"' +
          ' data-alloc-valuation="' + esc(alloc.valuationStatus || '') + '"';
        if (alloc.status === 'no_investable') {
          view = 'no_investable';
          chip = chipHtml('无可估值投资池', 'warn');
          body = '<div class="small">投资池当前没有可估值的资产（可投资资产为 0 或全部缺行情 / 汇率），' +
            '因此不显示类别比例。数据日 ' + esc(alloc.asOf) + ' · 投资池 ' +
            Core.fmtMoney(alloc.investableTotalMinor) + ' · 目标 L' + target.level + '</div>' +
            classRowsHtml(alloc, missing) +
            '<div class="small muted" style="margin-top:8px">缺数据时类别比例不可用，也不得显示为「都在区间内」。' +
            '去目标页可核对目标区间与认可标的。</div>';
        } else {
          view = alloc.canAdvise ? 'ok' : 'estimate';
          chip = chipHtml(alloc.canAdvise ? '正式口径对照' : '估算口径', alloc.canAdvise ? 'ok' : 'warn');
          body = '<div class="small" data-alloc-meta>数据日 ' + esc(alloc.asOf) +
            ' · 投资池 ' + Core.fmtMoney(alloc.investableTotalMinor) +
            ' · 目标 L' + target.level +
            ' · ' + esc(alloc.valuationStatus === 'formal' ? '正式口径' : '估算口径') + '</div>' +
            classRowsHtml(alloc, missing) + blockersHtml(alloc) +
            (missing.length
              ? '<div class="small muted" style="margin-top:6px">缺认可标的映射：' +
                missing.map(function (k) { return esc(RISK_CLASS_LABELS[k] || k); }).join('、') +
                '（比例仍来自服务端估值，只是执行时没有可买标的）。</div>'
              : '') +
            '<div class="small muted" style="margin-top:8px">比例为服务端定点整数结果；偏离按 target 计，' +
            '容忍带端点含入。区间来自 5A 冻结模板，本页不重算。' +
            knowledgeLinkHtml('card-tolerance-band', '容忍带说明') + '</div>';
        }
      } else if (status === 'no_assessment') {
        view = 'none';
        chip = chipHtml('尚未评估', '');
        body = '<div class="small">还没有有效的风险评估，因此没有可映射的目标区间。' +
          '这里不显示比例、偏离或正式口径；完成风险评估后才能生成目标。</div>';
      } else if (status === 'no_target') {
        view = 'no_target';
        chip = chipHtml('尚无目标', 'warn');
        body = '<div class="small">已有有效的风险评估，但还没有生成目标版本。' +
          '目标区间由服务端按风险上限映射冻结模板得到，页面不猜数值，也不显示比例对照。</div>';
      } else if (status === 'stale_assessment') {
        view = 'stale';
        chip = chipHtml('目标待更新', 'warn');
        body = '<div class="small">当前有效评估已经变化（或已过期），现有目标版本引用的不是这份评估。' +
          '在重新生成目标前，这里不展示基于旧目标的比例对照。</div>';
      } else {
        // invalid_records 及未来新增状态：fail closed，只报状态不猜数值
        view = 'invalid';
        status = status || 'unknown';
        chip = chipHtml('无法判定', 'warn');
        attrs = ' data-alloc-invalid="' + ((cur && cur.invalidCount) || 0) + '/' + ((cur && cur.total) || 0) + '"';
        body = '<div class="small">已保存的目标版本与冻结契约复核不一致（' +
          ((cur && cur.invalidCount) || 0) + '/' + ((cur && cur.total) || 0) + ' 条），' +
          '按 fail closed 处理：不使用失效记录，也不在这里给出比例对照。</div>';
      }
      if (cur && state.allocCurrentLoading) {
        view = 'refreshing';
        chip = chipHtml('核对中', 'warn');
        body += '<div class="small" data-alloc-pending>正在向本机服务复核。上面是上次读取的结果，' +
          '在复核完成前不能视为当前配置对照。</div>';
      }
      if (cur && state.allocCurrentError) {
        view = 'stale';
        chip = chipHtml('未复核', 'warn');
        body += '<div class="small" data-alloc-stale>最近一次复核失败：' + esc(state.allocCurrentError) +
          '。上面的结果是上一次读取的，可能已不是当前状态。</div>';
      }
    }

    // 入口在任何状态下都不收回：无目标时引导去生成，其余状态引导维护与核对。
    var entry = entryBlock(status === 'no_target' || status === 'no_assessment');
    var retry = state.allocCurrentError
      ? '<div style="margin-top:8px"><button class="btn small ghost" data-action="alloc:retry">重新读取配置对照</button></div>'
      : '';
    return '<div class="card" data-alloc-compare="' + esc(view) + '"' +
      ' data-alloc-status="' + esc(status) + '"' + attrs + '>' +
      '<div class="row"><b>配置对照</b><span style="margin-left:auto">' + chip + '</span></div>' +
      body + entry + retry + '</div>';
  }

  // 只替换配置对照卡；生成结果未变化时不动 DOM，避免打断归因基准等既有交互（D-050 ③）。
  function refreshAllocationCompareCard() {
    if (state.page !== 'home') return;
    var card = $('#view [data-alloc-compare]');
    if (!card) return;
    var next = allocationCompareCardHtml();
    if (state.allocCompareHtml === next) return;
    card.outerHTML = next;
    state.allocCompareHtml = next;
  }

  function ensureAllocCurrentLoaded() {
    if (state.allocCurrentLoading) return;
    if (Store.info().mode !== Store.MODE_API) return;
    var request = ++state.allocCurrentRequest;
    state.allocCurrentLoading = true;
    state.allocCurrentError = '';
    refreshAllocationCompareCard();
    Store.allocationCurrent().then(function (r) {
      if (request !== state.allocCurrentRequest) return;
      state.allocCurrentLoading = false;
      state.allocCurrent = r || null;
      state.allocCurrentError = '';
      refreshAllocationCompareCard();
    }).catch(function (e) {
      if (request !== state.allocCurrentRequest) return;
      state.allocCurrentLoading = false;
      state.allocCurrentError = (e && e.message) || '配置对照读取失败';
      refreshAllocationCompareCard();
    });
  }

  function riskFormHtml() {
    var answered = state.riskDraft.answers;
    var count = Object.keys(answered).length;
    var sections = ['capacity', 'willingness'].map(function (kind) {
      var qs = Domain.RISK_QUESTIONS.filter(function (q) { return q.kind === kind; });
      return '<div class="card"><div class="sec-head"><b>' +
        (kind === 'capacity' ? '客观承受能力' : '主观风险意愿') + '</b>' +
        '<span class="small muted">' + qs.length + ' 题</span></div>' +
        qs.map(function (q) {
          return '<fieldset style="margin:12px 0"><legend class="small"><b>' + esc(RISKQ_LABELS[q.id] || q.id) + '</b></legend>' +
            q.options.map(function (o) {
              return '<label class="row" style="gap:8px;margin:6px 0">' +
                '<input type="radio" name="' + esc(q.id) + '" data-action="risk:answer" data-q="' + esc(q.id) + '" data-o="' + esc(o.id) + '"' +
                (answered[q.id] === o.id ? ' checked' : '') + '>' +
                '<span class="small">' + esc(riskOptionLabel(o.id)) + '</span></label>';
            }).join('') + '</fieldset>';
        }).join('') + '</div>';
    }).join('');
    return '<div class="small muted" style="margin:6px 0 10px">缺答会被拒绝，不会猜默认值；草稿只存在于本页面内存，' +
      '离开页面即丢弃，不算已保存的评估。</div>' +
      sections +
      '<div class="card"><div class="row"><span class="small">复评原因</span>' +
      '<select id="risk-reason" style="margin-left:auto">' +
      Domain.REASSESS_REASONS.map(function (r) {
        return '<option value="' + esc(r) + '"' + (r === state.riskDraft.reason ? ' selected' : '') + '>' +
          esc(RISKREASON_LABELS[r] || r) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="row" style="gap:10px;margin-top:10px">' +
      '<button class="btn primary grow" data-action="risk:submit">提交评估</button>' +
      '<button class="btn ghost" data-action="risk:cancel">取消</button></div>' +
      '<div class="small muted" style="margin-top:6px">已答 ' + count + '/' + Domain.RISK_QUESTIONS.length +
      ' 题 · 评估日期按今天（' + esc(todayDateStr()) + '）记录；所有派生值由服务端按规则 ' + esc(Domain.RISK_RULE_VERSION) + ' 重算。</div>' +
      '</div>';
  }

  function tplRisk() {
    var html = '<div class="dash-head"><div><div class="dash-title">风险评估</div>' +
      '<div class="small muted">双评分 · 硬封顶 · 年度与重大事件复评 · 本机保存</div></div>' +
      '<button class="btn ghost" data-action="nav:home">返回决策台</button></div>';
    if (Store.info().mode === Store.MODE_LOCAL) {
      return html + '<div class="card"><div class="small">风险评估需要经过本地服务写入 SQLite 事实源。' +
        '请运行 start.command（或 node server/main.js）后重试。</div></div>';
    }
    if (state.riskLoading) return html + '<div class="card"><div class="small muted">评估数据加载中…</div></div>';
    if (state.riskError && !state.riskItems.length) {
      return html + '<div class="card"><div class="small">风险评估读取失败：' + esc(state.riskError) + '</div>' +
        '<button class="btn small" style="margin-top:8px" data-action="nav:risk">重试</button></div>';
    }
    if (state.riskView === 'form') return html + riskFormHtml();
    if (!state.riskItems.length) {
      return html + '<div class="card"><div class="small">还没有有效的风险评估。' +
        '正式的新增资金建议要求一份未过期的评估；问卷约需 2 分钟。</div>' +
        '<button class="btn primary" style="margin-top:10px" data-action="risk:start">开始评估问卷</button></div>';
    }
    var cur = state.riskCurrent;
    if (!cur || cur.status !== 'current') {
      var why = cur && cur.status === 'all_expired'
        ? '最近一份评估已于 ' + esc((cur.expiredRef && cur.expiredRef.expiry) || '—') + ' 过期。'
        : cur && cur.status === 'invalid_records'
          ? '已保存的评估记录与当前规则校验不一致（fail closed，不使用失效记录）。'
          : '还没有风险评估。';
      var reason = (cur && cur.status === 'all_expired') ? 'annual_expired' : 'initial';
      return html + '<div class="card"><div class="small">' + why + '市场涨跌本身不触发复评，' +
        '到期或收入 / 负债 / 外派 / 目标 / 流动性变化时才需要复评。</div>' +
        '<button class="btn primary" style="margin-top:10px" data-action="risk:start" data-reason="' + esc(reason) + '">' +
        (reason === 'annual_expired' ? '开始复评' : '开始评估问卷') + '</button></div>' +
        riskHistoryBlock(state.riskItems, null);
    }
    var rec = cur.current.assessment;
    html += riskResultBlock(rec, cur.current.validity);
    html += '<div class="card"><div class="row"><span class="small">评估日期 ' + esc(rec.assessedAt) +
      ' · 到期日 ' + esc(rec.expiry) + ' · 触发原因：' + esc(RISKREASON_LABELS[rec.reason] || rec.reason) + '</span>' +
      '<button class="btn small" style="margin-left:auto" data-action="risk:start" data-reason="manual">复评</button></div>' +
      '<div class="small muted" style="margin-top:4px">收入、负债、外派状态、重大目标或流动性需求发生' +
      '变化时可提前复评；复评会追加新版本，历史答案保持原样且按当时规则版本可读。</div></div>';
    return html + riskHistoryBlock(state.riskItems, rec.id);
  }

  function ensureRiskLoaded(force) {
    if (!force && state.riskLoaded && state.riskCurrent) { render(); return; }
    var request = ++state.riskCurrentRequest;
    state.riskCurrentLoading = false;
    state.riskLoading = true;
    render();
    Promise.all([Store.listRiskAssessments(), Store.riskAssessmentCurrent()])
      .then(function (rs) {
        state.riskItems = (rs[0] && rs[0].items) || [];
        if (request === state.riskCurrentRequest) {
          state.riskCurrent = rs[1] || null;
          state.riskCurrentError = '';
        }
        state.riskLoading = false;
        state.riskLoaded = true;
        if (state.page === 'risk') render();
      })
      .catch(function (e) {
        state.riskLoading = false;
        state.riskError = (e && e.message) || '风险评估读取失败';
        if (state.page === 'risk') render();
      });
  }

  function submitRiskAssessment() {
    var qs = Domain.RISK_QUESTIONS;
    var missing = qs.filter(function (q) { return !state.riskDraft.answers[q.id]; }).map(function (q) { return RISKQ_LABELS[q.id] || q.id; });
    if (missing.length) { toast('还有 ' + missing.length + ' 题未回答：' + missing[0], 'err'); return; }
    var sel = document.querySelector('#risk-reason');
    if (sel) state.riskDraft.reason = sel.value;
    var answers = qs.map(function (q) { return { questionId: q.id, optionId: state.riskDraft.answers[q.id] }; });
    // 载荷只含答案 / 评估日期 / 复评原因 —— 派生值由服务端重算（§5.3）
    var payload = { answers: answers, assessedAt: todayDateStr(), reason: state.riskDraft.reason };
    var idemKey = Core.newId('ra');
    Store.createRiskAssessment(payload, { idempotencyKey: idemKey }).then(function (r) {
      state.riskView = 'list';
      state.riskDraft = { answers: {}, reason: 'initial' };
      toast('评估已保存：风险上限 L' + r.item.ceiling + '（规则 ' + r.item.ruleVersion + '）');
      ensureRiskLoaded(true);
    }).catch(function (e) {
      toast('评估未保存：' + ((e && e.message) || '写入失败'), 'err');
    });
  }


  /* ================= Phase 5C：目标配置与认可标的映射 =================
   * 页面只消费服务端给出的目标与偏离（Store.allocationCurrent），不在浏览器重算映射、
   * 比例或 blocker 判断（不变量 3 / D-025）。5D 的新增资金建议同样只渲染服务端产物：
   * 页面提交的只有金额与引用绑定，「能不能给正式建议」的判断不在这里发生。 */
  var BAND_LABELS = { below_min: '低配', within: '区间内', above_max: '高配' };
  var MAPPING_ISSUE_LABELS = {
    instrument_missing: '标的不存在（失效引用）',
    classification_unconfirmed: '分类未确认',
    class_mismatch: '与标的类别冲突'
  };

  function bpsText(b) {
    if (b == null) return '—';
    var pct = b / 100;
    return (Math.round(pct * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + '%';
  }

  function signedBpsText(b) {
    if (b == null) return '—';
    return (b > 0 ? '+' : '') + bpsText(b);
  }

  function targetStatusBlock(view) {
    var s = view.status;
    if (s === 'no_assessment' || (s === 'current' && !view.target && view.assessmentStatus === 'no_assessment')) {
      return '<div class="card"><div class="small">还没有有效的风险评估，因此没有可映射的目标区间。' +
        '市场涨跌不触发复评；到期或收入 / 负债 / 外派 / 目标 / 流动性变化时才需要复评。</div>' +
        '<button class="btn primary" style="margin-top:10px" data-action="nav:risk">去做风险评估</button></div>';
    }
    if (s === 'invalid_records') {
      return '<div class="card"><div class="small">已保存的目标版本与冻结契约复核不一致' +
        '（' + view.invalidCount + ' / ' + view.total + ' 条），fail closed，不使用失效记录。</div>' +
        '<button class="btn small" style="margin-top:8px" data-action="target:reload">重新读取</button></div>';
    }
    if (s === 'stale_assessment') {
      return '<div class="card"><div class="small">当前有效评估已经变化（或已过期），现有目标版本引用的不是这份评估。' +
        '历史目标版本保持原样，不会被改写。</div>' +
        '<button class="btn primary" style="margin-top:10px" data-action="target:generate">按当前评估生成新版本</button></div>';
    }
    return '<div class="card"><div class="small">已有有效的风险评估，但还没有生成目标版本。' +
      '目标区间由服务端按风险上限映射 5A 冻结模板得到，页面不猜数值。</div>' +
      '<button class="btn primary" style="margin-top:10px" data-action="target:generate">从当前评估生成目标</button></div>';
  }

  function targetSummaryBlock(t, view) {
    var a = view.assessment;
    return '<div class="card"><div class="row"><b>目标资产类别区间</b>' +
      '<span class="small muted" style="margin-left:auto">上限 L' + t.level + ' · 模板 ' + esc(t.templateVersion) + '</span></div>' +
      '<div class="small muted" style="margin-top:4px">生效日 ' + esc(t.effectiveFrom) +
      ' · 来自 ' + esc(a.assessedAt) + ' 的评估（上限 L' + a.ceiling + '，' + esc(a.reason) + '）' +
      ' · 该评估有效期至 ' + esc(a.expiry) + '</div>' +
      '<div class="small muted" style="margin-top:4px">规则 ' + esc(t.ruleVersion) +
      ' · 版本 ' + esc(t.id) + '（追加式，历史版本永不覆盖）</div></div>';
  }

  function allocationBlock(alloc, missingClasses) {
    if (alloc.status === 'no_investable') {
      return '<div class="card"><div class="row"><b>当前配置与偏离</b>' +
        '<span class="small muted" style="margin-left:auto">数据日 ' + esc(alloc.asOf) + '</span></div>' +
        '<div class="small muted" style="margin-top:8px">投资池当前没有可估值的资产（可投资资产为 0 或全部缺行情 / 汇率），' +
        '因此不显示类别比例。缺映射的类别已在下方列出。</div></div>';
    }
    var rows = alloc.classes.map(function (c) {
      return '<div class="risk-row"><span class="r-name">' + esc(RISK_CLASS_LABELS[c.assetClass] || c.assetClass) +
        (missingClasses.indexOf(c.assetClass) >= 0 ? ' <span class="small">· 缺映射</span>' : '') + '</span>' +
        '<span class="r-bar"><i style="width:' + Math.min((c.pctBps || 0) / 100, 100) + '%"></i></span>' +
        '<span class="r-val">' + Core.fmtMoney(c.valueMinor) + '</span>' +
        '<span class="r-pct">' + bpsText(c.pctBps) + ' / ' + bpsText(c.minBps) + '–' + bpsText(c.maxBps) +
        ' · ' + esc(BAND_LABELS[c.band] || c.band) + ' · ' + esc(signedBpsText(c.deviationBps)) + '</span></div>';
    }).join('');
    return '<div class="card"><div class="row"><b>当前配置与偏离</b>' +
      '<span class="small muted" style="margin-left:auto">数据日 ' + esc(alloc.asOf) + ' · 投资池 ' +
      Core.fmtMoney(alloc.investableTotalMinor) + '</span></div>' + rows +
      '<div class="small muted" style="margin-top:8px">区间为 5A 冻结目标（min–max，端点含入），偏离按 target 计；' +
      '比例由服务端在<b>与决策台同一遍估值</b>上按定点整数算出，Σ 恒等于 100%。' +
      '这一屏只回答「目标是什么、能用什么执行」；新增资金怎么分见下方「新增资金优先再平衡」。</div></div>';
  }

  function mappingBlock(cls, rows, missingClasses) {
    var list = rows.filter(function (r) { return r.assetClass === cls; });
    var pool = state.assets.instruments.filter(function (i) {
      return i && i.id && i.assetClass === cls && i.classificationStatus === 'confirmed' &&
        !rows.some(function (r) { return r.instrumentId === i.id && r.assetClass !== cls; });
    });
    var used = {};
    rows.forEach(function (r) { used[r.instrumentId] = true; });
    var candidates = pool.filter(function (i) { return !used[i.id]; });
    return '<div class="acc-card"><div class="row"><b>' + esc(RISK_CLASS_LABELS[cls] || cls) + '</b>' +
      '<span class="small muted" style="margin-left:auto">' +
      (missingClasses.indexOf(cls) >= 0 ? '缺有效认可标的' : (list.length ? list.length + ' 个候选' : '未维护')) +
      '</span></div>' +
      (list.length ? list.map(function (r, idx) {
        return '<div class="row small" style="margin-top:6px"><span>' + (idx + 1) + '. ' +
          esc(r.symbol || r.instrumentId) + (r.instrumentName ? ' · ' + esc(r.instrumentName) : '') +
          (r.status === 'invalid' ? ' <span class="warn-text">' + esc((r.issues || []).map(function (k) {
            return MAPPING_ISSUE_LABELS[k] || k;
          }).join('、')) + '</span>' : '') + '</span>' +
          '<span style="margin-left:auto">' +
          (idx > 0 ? '<button class="link" data-action="map:up" data-cls="' + esc(cls) + '" data-id="' + esc(r.id) + '">上移</button> ' : '') +
          (idx < list.length - 1 ? '<button class="link" data-action="map:down" data-cls="' + esc(cls) + '" data-id="' + esc(r.id) + '">下移</button> ' : '') +
          '<button class="link" data-action="map:remove" data-cls="' + esc(cls) + '" data-id="' + esc(r.id) + '">移除</button>' +
          '</span></div>';
      }).join('') : '<div class="small muted" style="margin-top:6px">还没有认可标的。类别建议可以成立，但没有映射时不会给出任何具体证券。</div>') +
      '<div class="row" style="gap:8px;margin-top:8px">' +
      (candidates.length
        ? '<select id="map-pick-' + esc(cls) + '" class="grow">' +
          candidates.map(function (i) {
            return '<option value="' + esc(i.id) + '">' + esc(i.symbol) + (i.exchange ? '·' + esc(i.exchange) : '') +
              (i.name ? ' ' + esc(i.name) : '') + '</option>';
          }).join('') + '</select>' +
          '<button class="btn small" data-action="map:add" data-cls="' + esc(cls) + '">加入认可</button>'
        : '<span class="small muted">没有「分类已确认且类别一致」的标的可选。请先到资产页确认分类；' +
          '行情或目录刷新不会替你加入、删除或改写认可标的。</span>') +
      '</div></div>';
  }

  function tplTargets() {
    var html = '<div class="dash-head"><div><div class="dash-title">目标配置与认可标的</div>' +
      '<div class="small muted">风险上限 → 类别区间 · 用户认可标的白名单 · 本机保存</div></div>' +
      '<button class="btn ghost" data-action="nav:home">返回决策台</button></div>';
    if (Store.info().mode !== Store.MODE_API) {
      return html + '<div class="card"><div class="small">目标配置与认可标的需要经过本地服务写入 SQLite 事实源。' +
        '请运行 start.command（或 node server/main.js）后重试。</div></div>';
    }
    if (state.targetsLoading && !state.targetsView) {
      return html + '<div class="card"><div class="small muted">目标配置读取中…</div></div>';
    }
    if (state.targetsError && !state.targetsView) {
      return html + '<div class="card"><div class="small">目标配置读取失败：' + esc(state.targetsError) + '</div>' +
        '<button class="btn small" style="margin-top:8px" data-action="target:reload">重试</button></div>';
    }
    var view = state.targetsView || {};
    var alloc = view.allocation;
    var mapping = view.mapping || { rows: [], validCount: 0, issueCount: 0 };
    var missingClasses = view.missingClasses || [];
    if (view.status !== 'current') {
      html += targetStatusBlock(view);
    } else {
      html += targetSummaryBlock(view.target, view);
      if (alloc) {
        if (!alloc.canAdvise) {
          html += '<div class="card"><div class="row"><b class="small">当前为估算口径，下列比例仅供核对</b>' +
            '<span class="small muted" style="margin-left:auto">' + esc(alloc.valuationStatus) + '</span></div>' +
            '<div class="db-list">' + (alloc.blockers || []).map(function (b) {
              return '<div class="db-item">· ' + esc(blockerText(b)) + '</div>';
            }).join('') + '</div>' +
            '<div class="small muted" style="margin-top:6px">阻塞项沿用决策台同一套口径（不另写第二遍判断）；' +
            '缺行情 / 汇率或分类未确认时不据此给正式建议。</div></div>';
        }
        html += allocationBlock(alloc, missingClasses);
      }
    }
    // 只读刷新入口在任何状态下都要可用（读取失败时的「重试」也指向这里）
    html += '<div class="row" style="margin-top:10px"><button class="btn small ghost" data-action="target:reload">重新读取</button>' +
      '<span class="small muted" style="margin-left:auto">判定日 ' + esc(view.now || '') + '</span></div>';
    html += '<div class="sec-head" style="margin-top:14px"><b>认可标的映射（只有你确认过的标的才是执行候选）</b></div>' +
      '<div class="card">' + Domain.RISK_CLASSES.map(function (cls) {
        return mappingBlock(cls, mapping.rows || [], missingClasses);
      }).join('') +
      '<div class="small muted" style="margin-top:8px">映射完全由你维护：同一类别可有多个候选，顺序即优先级；' +
      '一个标的只能属于一个类别。失效引用与分类冲突会保留在此显式提示，不会被自动删除。</div>' +
      (mapping.issueCount || mapping.invalidCount
        ? '<div class="small warn-text" style="margin-top:4px">存在 ' + (mapping.issueCount + mapping.invalidCount) +
          ' 条需要处理的映射记录（失效引用 / 分类冲突 / 记录不合规）。</div>'
        : '') +
      '</div>';
    html += adviceSection(view);
    if (state.targetsItems.length) {
      html += '<div class="sec-head" style="margin-top:14px"><b>目标版本历史（追加式）</b></div><div class="card">' +
        state.targetsItems.map(function (t) {
          return '<div class="acc-card"><div class="row"><b>' + esc(t.effectiveFrom) + ' 起 · L' + t.level + '</b>' +
            '<span class="small muted" style="margin-left:auto">' + esc(t.templateVersion) + '</span></div>' +
            '<div class="small muted">评估 ' + esc(t.assessmentId) + '（' + esc(t.assessedAt) + ' 至 ' + esc(t.assessmentExpiry) + '）' +
            ' · 规则 ' + esc(t.ruleVersion) + ' · 保存于 ' + esc(String(t.createdAt).slice(0, 19).replace('T', ' ')) + '</div></div>';
        }).join('') + '</div>';
    }
    if (mapping.rows && mapping.rows.length) {
      html += '<div class="small muted" style="margin-top:10px">合计 ' + mapping.total + ' 条映射 · 有效 ' + mapping.validCount +
        ' · 异常 ' + (mapping.issueCount + mapping.invalidCount) + '</div>';
    }
    return html;
  }

  function ensureTargetsLoaded(force) {
    if (!force && state.targetsLoaded && state.targetsView) {
      render();
      return state.targetsLoadPromise || Promise.resolve();
    }
    state.targetsLoading = true;
    render();
    // 候选标的直接读 state.assets，因此这一页必须与事实源同步后再渲染，
    // 否则外部（另一处录入 / 恢复）刚确认的分类在这页会显示成不可选。
    var pending = Promise.all([Store.allocationCurrent(), Store.listAllocationTargets(), Store.loadRaw()])
      .then(function (rs) {
        var raw = rs[2];
        if (raw) {
          state.assets = Domain.normalizeAssets(raw.assets);
          if (raw.settings != null) state.settings = raw.settings;
        }
        // G5-R2：事实视图换代。assetsSig 是「本次读到的资产原文」指纹，供建议过期判定比对；
        // factsEpoch 让生成建议期间发生的换代能被识别出来，晚到的响应据此丢弃。
        if (raw && raw.assets) state.assetsSig = Domain.factSignature(raw.assets);
        state.factsEpoch += 1;
        state.targetsView = rs[0] || null;
        state.targetsItems = (rs[1] && rs[1].items) || [];
        state.targetsLoading = false;
        state.targetsLoaded = true;
        state.targetsError = '';
        if (state.page === 'targets') render();
      })
      .catch(function (e) {
        state.targetsLoading = false;
        state.targetsError = (e && e.message) || '目标配置读取失败';
        if (state.page === 'targets') render();
      });
    // 在途读取留档：生成建议前要先等它落地，否则「发起时的代数」可能在请求途中才更新，
    // 正常响应会被误判成晚到而丢弃。
    state.targetsLoadPromise = pending;
    return pending;
  }

  function generateTarget() {
    Store.createAllocationTarget({}, { idempotencyKey: Core.newId('at') }).then(function (r) {
      toast(r.created ? '已生成目标版本 L' + r.item.level : '该评估在此生效日已有目标版本');
      ensureTargetsLoaded(true);
    }).catch(function (e) {
      toast('目标未生成：' + ((e && e.message) || '写入失败'), 'err');
    });
  }

  function saveMappingClass(cls, instrumentIds) {
    return Store.setApprovedInstruments({ assetClass: cls, instrumentIds: instrumentIds },
      { idempotencyKey: Core.newId('aim') }).then(function () {
      toast('认可标的已更新');
      return ensureTargetsLoaded(true);
    }).catch(function (e) {
      toast('认可标的未保存：' + ((e && e.message) || '写入失败'), 'err');
      return false;
    });
  }

  function mappingIdsFor(cls) {
    var rows = ((state.targetsView || {}).mapping || {}).rows || [];
    return rows.filter(function (r) { return r.assetClass === cls; });
  }

  function mappingAction(cls, fn) {
    var ids = fn(mappingIdsFor(cls));
    return saveMappingClass(cls, ids);
  }

  /* ================= Phase 5D：新增资金优先再平衡与正式建议门禁 =================
   * 页面只提交「金额 + 引用绑定」；类别分配、门禁结论、标的映射与尾差说明全部来自
   * 服务端建议产物（不变量 3：不在浏览器重算偏离或「能不能建议」的判断）。
   * 这里也不提供接受 / 暂缓 / 已执行等按钮：那些属于 Phase 6 的决策状态机。 */
  var ADVICE_ADJUSTMENT_LABELS = {
    fill_below_min: '先补低于区间下限的类别',
    converge_to_target: '向目标权重收敛（不卖出）',
    within_tolerance: '当前都在容忍带内，无需调整',
    no_investable: '投资池没有可依赖的比例基准',
    zero_allocatable: '本轮没有可分配金额'
  };
  var ADVICE_BASIS_LABELS = {
    below_min: '低于下限', below_target: '低于目标权重', above_max: '高配：不加仓也不卖出',
    at_or_above_target: '已在目标之上', unknown_base: '比例未知'
  };
  var ADVICE_TODO_LABELS = {
    missing_approved_instrument: '该类别还没有可执行的认可标的',
    invalid_instrument_reference: '该类别的认可标的引用已失效'
  };
  // 5E-3：解释码 → 固定文案。只格式化服务端 explainCodes，不在页面重算优先级或缺口。
  var ADVICE_EXPLAIN_LABELS = {
    new_funds_below_min_first: '第一步：先补低于区间下限的类别',
    new_funds_converge_to_target: '第二步：余下资金向目标权重收敛（不卖出）',
    new_funds_within_tolerance: '当前都在容忍带内，无需调整',
    new_funds_no_investable: '投资池没有可依赖的比例基准',
    new_funds_zero_amount: '本轮没有可分配金额',
    new_funds_capped_by_available: '请求已按可新增投资资金截断',
    new_funds_rounding_remainder: '存在尾差，按冻结规则分配给排序最前者',
    new_funds_above_max_no_sell: '高配类别不加仓也不卖出（只提示风险）',
    new_funds_missing_approved_instrument: '存在未映射认可标的的类别，金额原样保留',
    formal_gate_blocked: '正式建议门禁未全部通过，只展示估算'
  };

  /* ================= G5-R2：建议与当前事实的比对 =================
   * 比对逻辑在 js/domain.js（Domain.adviceStaleness，纯函数、可单测）：把建议 gate.capture 里
   * 封存的事实与页面刚从服务端读到的事实逐项对齐。本层只负责两件事：取当前视图、把 reason 码
   * 翻译成人话；不重算偏离、不重跑门禁、不产出任何金额（不变量 3）。 */
  var ADVICE_STALE_LABELS = {
    assets_changed: '资产、持仓、行情或汇率已变化',
    mapping_changed: '认可标的映射已变更',
    assessment_changed: '风险评估已更换',
    target_changed: '目标配置已更换',
    valuation_not_formal: '当前数据已不满足正式口径（见上方估算口径说明）',
    target_not_current: '当前没有生效的目标版本'
  };

  // 返回「为什么这份建议已经不能当作当前行动依据」；正式建议才会被判定过期 ——
  // 估算建议从未声称门禁通过，改判过期只会把「未达门槛」和「已过期」两件事混在一起。
  function adviceStaleReasons(item) {
    return Domain.adviceStaleness(item, state.targetsView, state.assetsSig);
  }

  function adviceSection(view) {
    var html = '<div class="sec-head" style="margin-top:14px"><b>新增资金优先再平衡（5D）</b></div>' +
      '<div class="card">';
    if (view.status !== 'current') {
      return html + '<div class="small muted">还没有生效的目标版本，因此没有可依据的区间与缺口。' +
        '请先生成目标配置。</div></div>';
    }
    html += '<div class="row" style="gap:8px">' +
      '<input class="grow" type="text" inputmode="decimal" placeholder="本月可新增投资金额（元）" ' +
      'value="' + esc(state.adviceAmount) + '" data-input="advice:amount">' +
      '<button class="btn small primary" data-action="advice:run"' + (state.adviceBusy ? ' disabled' : '') + '>' +
      (state.adviceBusy ? '计算中…' : '生成分配建议') + '</button></div>' +
      '<div class="small muted" style="margin-top:6px">金额只提交给本机服务端；实际可分配取「你填的金额」与' +
      '「可新增投资资金」的较小值。资金来自已有投资现金，转配不增加总资产；保留现金配置下限，未分配余量继续留作现金。</div>';
    if (state.adviceError) {
      html += '<div class="small warn-text" style="margin-top:8px">未能生成建议：' + esc(state.adviceError) + '</div>';
    }
    html += adviceResultBlock(state.advice);
    return html + '</div>';
  }

  function adviceResultBlock(item) {
    if (!item) {
      return '<div class="small muted" style="margin-top:8px">还没有本次建议。生成后这里会显示类别金额、' +
        '认可标的映射、未分配余量与追溯信息。</div>';
    }
    var res = item.formalRecommendation || item.estimate;
    if (!res) return '';
    var formal = item.status === 'formal';
    // G5-R2：封存事实与当前事实对不上时，历史计算只能标成历史 —— 「当时通过」不等于「当前可执行」
    var stale = adviceStaleReasons(item);
    var isStale = stale.length > 0;
    var note = res.roundingNote;
    var rec = item.recommendation || {};
    var todos = rec.todos || [];
    var codes = res.explainCodes || [];
    var classes = res.categoryAllocations || [];
    var html = '<div style="margin-top:10px" data-advice-result' +
      ' data-advice-status="' + (isStale ? 'stale' : (formal ? 'formal' : 'estimate')) + '"' +
      ' data-advice-stale="' + esc(stale.join(',')) + '"' +
      ' data-advice-adjustment="' + esc(note.adjustment) + '"' +
      ' data-advice-requested="' + note.requestedNewFundsMinor + '"' +
      ' data-advice-allocatable="' + note.allocatableNewFundsMinor + '"' +
      ' data-advice-allocated="' + note.allocatedTotalMinor + '"' +
      ' data-advice-unallocated="' + note.unallocatedMinor + '"' +
      ' data-advice-explain="' + esc(codes.join(',')) + '">' +
      '<div class="row"><b>' +
      (isStale ? '历史建议（生成时门禁通过）'
        : formal ? '正式建议' : '估算建议（未达正式门槛）') + '</b>' +
      '<span class="small ' + (isStale || !formal ? 'warn-text' : 'muted') + '" style="margin-left:auto">' +
      (isStale ? '当前已失效 · 需要重新计算'
        : formal ? '全部门禁通过' : 'formalRecommendation 为空：见下方待处理项') + '</span></div>' +
      (isStale
        ? '<div class="small warn-text" style="margin-top:6px" data-advice-stale-note>当前事实已变化：' +
          stale.map(function (k) { return esc(ADVICE_STALE_LABELS[k] || k); }).join('；') +
          '。下面是生成时封存的历史结果，不能作为当前行动依据；' +
          '服务端重新计算通过前，这里不再显示「全部门禁通过」。</div>' +
          '<div class="row" style="margin-top:6px">' +
          '<button class="btn small primary" data-action="advice:run">重新计算</button></div>'
        : '') +
      '<div class="small muted" style="margin-top:4px">请求 ' + Core.fmtMoney(note.requestedNewFundsMinor) +
      ' · 可分配 ' + Core.fmtMoney(note.allocatableNewFundsMinor) +
      (note.cappedToAvailable ? '（已按可新增投资资金截断）' : '') +
      ' · 实际分配 ' + Core.fmtMoney(note.allocatedTotalMinor) +
      ' · 未分配 ' + Core.fmtMoney(note.unallocatedMinor) +
      ' · ' + esc(ADVICE_ADJUSTMENT_LABELS[note.adjustment] || note.adjustment) + '</div>' +
      '<div class="small muted" style="margin-top:4px">守恒：实际分配 ' +
      Core.fmtMoney(note.allocatedTotalMinor) + ' + 未分配 ' + Core.fmtMoney(note.unallocatedMinor) +
      ' = 可分配 ' + Core.fmtMoney(note.allocatableNewFundsMinor) + '</div>';
    if ((res.blockers || []).length) {
      html += '<div class="db-list" style="margin-top:6px" data-advice-blockers>' +
        res.blockers.map(function (b) {
          return '<div class="db-item" data-blocker="' + esc(b.code) + '">· ' + esc(blockerText(b)) + '</div>';
        }).join('') + '</div>';
    }
    // 解释区：排序依据 / 现金保底 / 不卖出原因 —— 全部来自服务端字段，页面不重算。
    var orderBits = [];
    if (codes.indexOf('new_funds_below_min_first') >= 0) orderBits.push(ADVICE_EXPLAIN_LABELS.new_funds_below_min_first);
    if (codes.indexOf('new_funds_converge_to_target') >= 0) orderBits.push(ADVICE_EXPLAIN_LABELS.new_funds_converge_to_target);
    if (!orderBits.length) orderBits.push(ADVICE_ADJUSTMENT_LABELS[note.adjustment] || note.adjustment);
    orderBits.push('高配与已在目标之上的类别不参与追加；现金不自买并保留下限');
    var aboveMax = classes.filter(function (c) { return c.basis === 'above_max'; });
    var nosellReason = aboveMax.length
      ? aboveMax.map(function (c) { return RISK_CLASS_LABELS[c.assetClass] || c.assetClass; }).join('、') +
        ' 为高配：本轮分配为 0，只提示风险，不生成卖出指令'
      : '本轮无高配类别需要减持；任何情况下都不卖出现有资产，只补充低配';
    html += '<div class="small" style="margin-top:8px" data-advice-why>' +
      '<div data-advice-order><b>排序依据：</b>' + orderBits.map(esc).join('；') + '。' +
      knowledgeLinkHtml('card-new-funds-first', '新增资金优先说明') + '</div>' +
      '<div data-advice-cash-floor style="margin-top:4px"><b>现金保底：</b>转配只动投资池内现金，' +
      '保留现金配置下限，不向现金自身分配；' +
      (note.unallocatedMinor
        ? '未分配 ' + Core.fmtMoney(note.unallocatedMinor) + ' 继续留作现金。'
        : '本轮无未分配余量。') + '</div>' +
      '<div data-advice-nosell style="margin-top:4px"><b>默认不卖出：</b>' + esc(nosellReason) + '。' +
      knowledgeLinkHtml('card-no-sell', '为何不默认卖出') + '</div>';
    if (codes.length) {
      html += '<div class="db-list" style="margin-top:6px" data-advice-codes>' + codes.map(function (code) {
        return '<div class="db-item" data-explain-code="' + esc(code) + '">· ' +
          esc(ADVICE_EXPLAIN_LABELS[code] || code) + '</div>';
      }).join('') + '</div>';
    }
    html += '</div>';
    html += '<div class="db-list" style="margin-top:8px">' + classes.map(function (c) {
      var instruments = (c.instruments || []).map(function (i) {
        return esc(i.symbol || i.instrumentId) + ' ' + Core.fmtMoney(i.allocatedMinor);
      }).join(' · ');
      return '<div class="db-item" data-advice-cls="' + esc(c.assetClass) + '"' +
        ' data-basis="' + esc(c.basis) + '"' +
        ' data-allocated="' + c.allocatedMinor + '"' +
        ' data-min-need="' + (c.minNeedMinor == null ? '' : c.minNeedMinor) + '"' +
        ' data-target-need="' + (c.targetNeedMinor == null ? '' : c.targetNeedMinor) + '"' +
        ' data-goal-bps="' + (c.goalBps == null ? '' : c.goalBps) + '"' +
        ' data-instrument-count="' + (c.instruments || []).length + '">' +
        '<div class="row"><b class="small">' +
        esc(RISK_CLASS_LABELS[c.assetClass] || c.assetClass) + '</b>' +
        '<span class="small" style="margin-left:auto" data-advice-visible-amount>' +
        Core.fmtMoney(c.allocatedMinor) + '</span></div>' +
        '<div class="small muted">' + esc(ADVICE_BASIS_LABELS[c.basis] || c.basis) +
        (c.goalBps == null ? '' : ' · 锚点 ' + bpsText(c.goalBps)) +
        (instruments ? ' → ' + instruments : (c.allocatedMinor ? ' · 待维护认可标的' : '')) + '</div></div>';
    }).join('') + '</div>';
    if (todos.length) {
      html += '<div class="small warn-text" style="margin-top:8px" data-advice-todos>' + todos.map(function (t) {
        return '<span data-todo="' + esc(t.code) + '" data-todo-class="' + esc(t.assetClass) + '"' +
          ' data-retained="' + t.retainedMinor + '">' +
          esc(ADVICE_TODO_LABELS[t.code] || t.code) + '：' +
          esc(RISK_CLASS_LABELS[t.assetClass] || t.assetClass) + ' ' + Core.fmtMoney(t.retainedMinor) +
          '（保留为类别级待办，不转投陌生标的）</span>';
      }).join('<br>') + '</div>';
    }
    html += '<div class="small muted" style="margin-top:8px" data-advice-rounding' +
      ' data-leftover="' + note.leftoverMinor + '"' +
      ' data-receivers="' + esc((note.receivers || []).join(',')) + '">' +
      '尾差：' + esc(note.rule) +
      (note.receivers.length ? '；本轮由 ' + note.receivers.map(function (k) {
        return esc(RISK_CLASS_LABELS[k] || k);
      }).join('、') + ' 承接 ' + note.leftoverMinor + ' 个最小货币单位' : '') + '。</div>' +
      '<div class="small muted" style="margin-top:4px">边界：默认不卖出现有资产；高配类别只提示风险。' +
      '未映射的类别需先确认认可标的。</div>';
    // 5E-5 审计追溯：月结基准 / 计算日输入 / 版本与记录 / 解释版本 分组展示，只搬运服务端字段。
    // 月结快照是基准，gate.capture / inputHash 才是计算日完整输入，两者分区呈现不混称；
    // 旧建议未封存解释版本时显式标注（D-052：不倒填历史记录）。
    var gate = rec.gate || {};
    var capture = gate.capture || {};
    var sealedVersion = (typeof gate.explanationVersion === 'string' && gate.explanationVersion)
      ? gate.explanationVersion : '';
    var currentVersion = (typeof window !== 'undefined' && window.Knowledge)
      ? String(window.Knowledge.EXPLANATION_VERSION) : '';
    var algorithm = capture.algorithmVersion || '—';
    var payloadHash = rec.payloadHash ? String(rec.payloadHash) : '';
    var hash12 = function (v) { return v ? esc(String(v).slice(0, 12)) + '…' : '—'; };
    html += '<div class="small muted" style="margin-top:4px" data-advice-trace>' +
      '<div data-advice-trace-baseline' +
      ' data-close-id="' + esc(rec.closeId || '') + '"' +
      ' data-snapshot-id="' + esc(rec.snapshotId || '') + '"' +
      ' data-snapshot-hash="' + esc(String(res.versions.snapshotPayloadHash || '')) + '"' +
      ' data-cutoff="' + esc(res.versions.dataCutoff || '') + '">' +
      '追溯：快照 ' + esc(res.versions.snapshotId) +
      ' · 月结 ' + esc(rec.closeId) +
      ' · 快照哈希 ' + hash12(res.versions.snapshotPayloadHash) +
      ' · 月结数据截止 ' + esc(res.versions.dataCutoff) +
      '（月结快照是基准，不等同于计算输入）</div>' +
      '<div data-advice-trace-input' +
      ' data-as-of="' + esc(res.versions.asOf || '') + '"' +
      ' data-algorithm="' + esc(algorithm) + '"' +
      ' data-input-hash="' + esc(String(item.inputHash || '')) + '">' +
      '计算日输入：判定日 ' + esc(res.versions.asOf) +
      ' · 算法版本 ' + esc(algorithm) +
      ' · 本次计算输入 ' + hash12(item.inputHash) +
      '（余额、持仓、价格、汇率及映射已本机封存）</div>' +
      '<div data-advice-trace-versions' +
      ' data-rec-id="' + esc(item.id || '') + '"' +
      ' data-payload-hash="' + esc(payloadHash) + '"' +
      ' data-rule-version="' + esc(res.versions.ruleVersion || '') + '"' +
      ' data-target-version="' + esc(res.versions.targetVersion || '') + '"' +
      ' data-target-level="' + esc(String(res.versions.targetLevel == null ? '' : res.versions.targetLevel)) + '"' +
      ' data-assessment-id="' + esc(res.versions.assessmentId || '') + '"' +
      ' data-target-id="' + esc(res.versions.targetId || '') + '">' +
      '版本与记录：建议 ' + esc(item.id) +
      ' · payloadHash ' + hash12(payloadHash) +
      ' · 规则 ' + esc(res.versions.ruleVersion) +
      ' · 目标 ' + esc(res.versions.targetVersion) + '（L' + res.versions.targetLevel + '）' +
      ' · 评估 ' + esc(res.versions.assessmentId) +
      ' · 目标配置 ' + esc(res.versions.targetId) + '</div>' +
      '<div data-advice-explain-seal' +
      ' data-sealed="' + (sealedVersion ? '1' : '0') + '"' +
      ' data-sealed-version="' + esc(sealedVersion) + '"' +
      ' data-current-version="' + esc(currentVersion) + '">' +
      '解释版本：' + (sealedVersion
        ? '本条建议生成时封存 v' + esc(sealedVersion) + '；当前知识卡 v' + esc(currentVersion) +
          (sealedVersion !== currentVersion ? '（知识卡已更新，链接展示当前文字）' : '')
        : '当前卡片解释，非生成时封存版本（当前知识卡 v' + esc(currentVersion) + '）') +
      '</div></div>';
    // Phase 6C：正式建议 → 接受 / 暂缓 / 忽略入口；估算建议显式说明不可决策
    html += decisionEntryBlock(item);
    return html + '</div>';
  }

  function runAdvice() {
    var view = state.targetsView || {};
    if (view.status !== 'current' || !view.target) { toast('请先生成生效的目标版本', 'warn'); return; }
    if (state.adviceBusy) return;
    var cents = Core.yuanToCents(state.adviceAmount);
    if (cents === null || cents < 0 || !Number.isSafeInteger(cents)) {
      toast('请输入非负的金额（元，最多到分）', 'warn');
      return;
    }
    state.adviceBusy = true;
    state.adviceError = '';
    render();
    // 先等在途的事实读取落地，再记代数：否则一次刚发起的读取会在请求途中换代，
    // 把正常响应误判成「晚到」而丢弃。
    Promise.resolve(state.targetsLoadPromise).then(function () {
      // G5-R2：记下发起时的事实视图代数；响应返回时若已换代，说明计算期间事实被改写过。
      var epoch = state.factsEpoch;
      return Store.listMonthlyCloses().then(function (r) {
        var formal = (r.items || []).filter(function (c) { return c.status === 'formal' && c.snapshot; });
        if (!formal.length) throw new Error('本机还没有可引用的正式月结，请先完成月度结账');
        var close = formal[0];
        return Store.createRecommendation({
          snapshotRef: { closeId: close.id, snapshotId: close.snapshot.id, payloadHash: close.snapshot.payloadHash },
          assessmentRef: { id: view.assessment.id, ruleVersion: view.assessment.ruleVersion },
          targetVersion: view.target.templateVersion,
          ruleVersion: view.target.ruleVersion,
          newFundsMinor: cents
        }, { idempotencyKey: Core.newId('rec') });
      }).then(function (res) {
        if (epoch !== state.factsEpoch) {
          // 慢请求晚到：不覆盖已换代的状态，页面显示的仍是当前视图判定出的结论。
          toast('生成期间事实已变化，本次结果未采用，请重新计算', 'warn');
          return;
        }
        state.advice = res;
        toast(res.status === 'formal' ? '已生成本机正式建议' : '已生成估算建议（未达正式门槛）',
          res.status === 'formal' ? 'ok' : 'warn');
        // 生成后立即同步事实视图：过期判定必须比对同一时刻的视图，
        // 不能拿生成前的旧视图把刚生成的建议误判为历史。
        ensureTargetsLoaded(true);
      }).catch(function (e) {
        if (epoch !== state.factsEpoch) {
          toast('生成期间事实已变化，本次结果未采用，请重新计算', 'warn');
          return;
        }
        state.advice = null;
        state.adviceError = (e && e.message) || '写入失败';
        toast('建议未生成：' + state.adviceError, 'err');
      });
    }).then(function () {
      state.adviceBusy = false;
      render();
    });
  }

  /* ================= Phase 6C：接受、暂缓、忽略与待执行清单 =================
   * 页面只呈现服务端状态、金额与门禁（拆解 §5 / PHASE6_CONTRACT §8）：转移合法性、
   * 接受门禁与快照封存全部由服务端唯一实现，这里不重算、不预判、不提供跳步按钮。
   * 交易关联与「确认执行完成」属于 6D，本页不做假「已执行」入口。
   * 慢响应守卫：decRequest / decSubmitSeq 让晚到的读取与提交不得覆盖用户已看到的新状态。 */

  var DECISION_STATE_LABELS = {
    proposed: '待决定', accepted: '已接受 · 待执行', deferred: '已暂缓',
    dismissed: '已忽略', executed: '已执行', reviewed: '已复盘', archived: '已归档'
  };
  // 理由码由服务端派生（契约 §6.3），页面只翻译，不判定。
  var DECISION_REASON_LABELS = {
    agree: '同意按建议执行',
    postpone: '暂缓：等待更合适的时机或更多事实',
    dismiss_not_actionable: '忽略：暂不构成可执行行动',
    executed_as_planned: '按建议金额执行',
    executed_deviation: '执行与建议金额存在偏差',
    no_trade: '无需交易（0 元建议归档）',
    abandoned: '放弃执行（归档）',
    reviewed_with_drift: '复盘：配置与执行时点有变化',
    reviewed_no_drift: '复盘：配置与执行时点一致'
  };
  var DECISION_SNAPSHOT_REASON_LABELS = {
    cash_not_reconciled: '现金余额未核对',
    valuation_not_formal: '估值未达正式口径'
  };

  function decisionForRecommendation(recId) {
    for (var i = 0; i < state.decItems.length; i++) {
      if (state.decItems[i].recommendationId === recId) return state.decItems[i];
    }
    return null;
  }

  // 决策清单读取。失败与「没有决策」必须可区分：读取失败时 decLoaded 不置位，
  // 页面显示失败卡与重试，不显示空态。
  function ensureDecisionsLoaded(force) {
    if (!force && state.decLoaded) return Promise.resolve();
    state.decLoading = true;
    state.decError = ''; // 重试开始：清掉上一次失败，页面从失败卡切回读取中
    if (state.page === 'decisions') render();
    var req = ++state.decRequest;
    return Store.listDecisions().then(function (r) {
      if (req !== state.decRequest) return null; // 已有更新的读取在途，丢弃晚到响应
      state.decItems = (r && r.items) || [];
      state.decTotal = (r && r.total) || 0;
      state.decInvalidCount = (r && r.invalidCount) || 0;
      state.decMonths = (r && r.months) || [];
      state.decLoaded = true;
      state.decLoading = false;
      state.decError = '';
      if (state.page === 'decisions' || state.page === 'targets') render();
      return r;
    }).catch(function (e) {
      if (req !== state.decRequest) return null;
      state.decLoading = false;
      state.decError = (e && e.message) || '决策读取失败';
      if (state.page === 'decisions' || state.page === 'targets') render();
      return null;
    });
  }

  // execution 汇总（列表 / 详情 / 快照同一形状，契约 §3.3）：缺折算汇率时三个 CNY 汇总为
  // null，绝不部分小计、按 1:1 或伪 0 兜底；无活动关联时汇总为 0、剩余为建议金额。
  function executionText(exec) {
    if (!exec) return '执行进度：暂无数据';
    var parts = ['已关联 ' + exec.linkedCount + ' 笔买入'];
    parts.push(exec.linkedPrincipalCnyMinor == null
      ? '折算本金不可判定（缺交易日汇率）'
      : '折算本金 ' + Core.fmtMoney(exec.linkedPrincipalCnyMinor));
    parts.push(exec.remainingMinor == null ? '剩余不可判定' : '剩余 ' + Core.fmtMoney(exec.remainingMinor));
    if ((exec.fxUnavailable || []).length) parts.push('缺汇率 ' + exec.fxUnavailable.length + ' 笔');
    return '执行进度：' + parts.join(' · ');
  }

  function decisionStateChip(st) {
    return '<span class="small dec-chip" data-dec-chip="' + esc(st) + '">' +
      esc(DECISION_STATE_LABELS[st] || st) + '</span>';
  }

  function decisionStaleNote(staleReasons) {
    if (!staleReasons || !staleReasons.length) return '';
    return '<div class="small warn-text" style="margin-top:4px" data-dec-stale>原建议已失效（' +
      staleReasons.map(function (k) { return esc(ADVICE_STALE_LABELS[k] || k); }).join('；') +
      '）。已保存的决定保留；补记实际交易不受影响。</div>';
  }

  function decisionCard(item) {
    var staleReasons = (item.recommendation && item.recommendation.adviceStaleReasons) || [];
    return '<div class="card dec-card" data-dec-id="' + esc(item.id) + '" data-dec-state="' + esc(item.state) + '">' +
      '<div class="row"><b>' + Core.fmtMoney(item.allocatedTotalMinor) + ' CNY</b>' + decisionStateChip(item.state) + '</div>' +
      '<div class="small muted" style="margin-top:4px" data-dec-note>理由：' + esc(item.note || '（无记录）') +
      (item.reasonCode ? '（' + esc(DECISION_REASON_LABELS[item.reasonCode] || item.reasonCode) + '）' : '') + '</div>' +
      '<div class="small muted" style="margin-top:4px">决定日 ' + esc(item.lastEventAt || '—') +
      ' · 决策月 ' + esc((item.eventMonths || []).join('、') || '—') +
      ' · 建议判定日 ' + esc((item.recommendation && item.recommendation.asOf) || '—') + '</div>' +
      decisionStaleNote(staleReasons) +
      '<div class="small muted" style="margin-top:4px">' + esc(executionText(item.execution)) + '</div>' +
      '<div class="row" style="margin-top:8px"><button class="btn small" data-action="dec:detail" data-id="' +
      esc(item.id) + '">查看详情</button></div></div>';
  }

  function tplDecisions() {
    var html = '<div class="dash-head"><div><div class="dash-title">决策与待执行</div>' +
      '<div class="small muted">接受 / 暂缓 / 忽略 · 待执行清单 · 状态一律以本机服务端为准</div></div>' +
      '<button class="btn ghost" data-action="nav:home">返回决策台</button></div>';
    if (Store.info().mode !== Store.MODE_API) {
      return html + '<div class="card"><div class="small">决策记录保存在本机 SQLite 事实源。' +
        '请运行 start.command（或 node server/main.js）后重试。</div></div>';
    }
    // 读取失败先于读取中判定：失败必须给出失败卡与重试入口，
    // 且「读不到」绝不能落回读取中或空态冒充「还没有决策」。
    if (state.decError) {
      return html + '<div class="card" data-dec-error><div class="small">决策读取失败：' + esc(state.decError) +
        '。清单没有读出来，不能当作「还没有决策」。</div>' +
        '<button class="btn small" style="margin-top:8px" data-action="dec:reload">重试</button></div>';
    }
    if (!state.decLoaded) {
      // 首帧 / 读取中 / 失败重试前：一律显示读取中，不把「还没读到」渲染成空清单
      return html + '<div class="card" data-dec-loading><div class="small muted">决策读取中…</div></div>';
    }
    var accepted = state.decItems.filter(function (d) { return d.state === 'accepted'; });
    html += '<div class="row" style="margin-top:2px">' +
      '<div class="sec-head" style="margin-top:10px"><b>待执行清单（已接受）</b></div>' +
      (state.decLoading ? '<span class="small muted" data-dec-reloading style="margin-left:8px">正在重新读取…</span>' : '') +
      '<button class="btn small ghost" style="margin-left:auto" data-action="dec:reload">重新读取</button></div>';
    html += accepted.length
      ? accepted.map(decisionCard).join('')
      : '<div class="card" data-dec-empty><div class="small muted">还没有待执行的决策。</div>' +
        '<div class="small muted" style="margin-top:4px">到 <button class="link" data-action="nav:targets">目标配置</button>' +
        ' 页生成正式建议后，在建议详情里进入决定；接受后会出现在这里。' +
        '暂缓与忽略只进下方历史，不进本清单。</div></div>';
    html += '<div class="sec-head" style="margin-top:14px"><b>全部决策历史（含暂缓 / 忽略）</b></div>';
    if (state.decInvalidCount > 0) {
      html += '<div class="small warn-text" style="margin-top:4px" data-dec-invalid>' + state.decInvalidCount +
        ' 条决策记录未通过完整性复核，已从列表排除。</div>';
    }
    if (!state.decItems.length) {
      html += '<div class="card"><div class="small muted" data-dec-history-empty>还没有任何决策记录。</div></div>';
    } else {
      var ORDER = ['proposed', 'accepted', 'deferred', 'dismissed', 'executed', 'reviewed', 'archived'];
      html += '<div class="row" style="margin-top:6px">' +
        '<select class="grow" data-change="dec:filter" aria-label="按状态筛选历史决策">' +
        '<option value="">全部状态（' + state.decItems.length + ' 条）</option>' +
        ORDER.filter(function (st) {
          return state.decItems.some(function (d) { return d.state === st; });
        }).map(function (st) {
          var n = state.decItems.filter(function (d) { return d.state === st; }).length;
          return '<option value="' + st + '"' + (state.decStateFilter === st ? ' selected' : '') + '>' +
            esc(DECISION_STATE_LABELS[st] || st) + '（' + n + '）</option>';
        }).join('') + '</select></div>';
      // 6E-2 月度历史：月份 = 服务端按状态事件操作时间聚合的 eventMonths（契约 §5），
      // 与状态筛选互为与关系；空月份不会出现在选项里，选不出条目时显示空态不报错。
      html += '<div class="row" style="margin-top:6px">' +
        '<select class="grow" data-change="dec:month" aria-label="按月份筛选历史决策（状态事件操作时间）">' +
        '<option value="">全部月份（' + (state.decMonths || []).length + ' 个月）</option>' +
        (state.decMonths || []).map(function (m) {
          var n = state.decItems.filter(function (d) {
            return (d.eventMonths || []).indexOf(m) !== -1;
          }).length;
          return '<option value="' + esc(m) + '"' + (state.decMonthFilter === m ? ' selected' : '') + '>' +
            esc(m) + '（' + n + '）</option>';
        }).join('') + '</select></div>' +
        '<div class="small muted" style="margin-top:4px">月份按状态事件的<b>操作时间</b>归属，' +
        '不是证券交易日；关联交易的交易日与操作时间在决策详情里分列标注。</div>';
      var rows = state.decItems;
      if (state.decStateFilter) {
        rows = rows.filter(function (d) { return d.state === state.decStateFilter; });
      }
      if (state.decMonthFilter) {
        rows = rows.filter(function (d) { return (d.eventMonths || []).indexOf(state.decMonthFilter) !== -1; });
      }
      html += rows.length
        ? rows.map(decisionCard).join('')
        : '<div class="card" data-dec-month-empty><div class="small muted">该筛选下暂无决策。</div></div>';
    }
    html += '<div class="small muted" style="margin-top:10px">实际交易关联与「确认执行完成」在决策详情里完成：' +
      '关联只引用既有证券事件，不重复记账；状态推进一律由服务端判定，本页不提供跳步按钮。</div>';
    return html;
  }

  // 时点快照（封存事实）折叠区。available=false 时不输出任何金额（契约 §4.4）；
  // 比例与区间沿用服务端封存值，页面不换算。禁止「收益 / 跑赢目标」表述。
  function decisionSnapshotHtml(name, snap) {
    if (!snap) return '';
    var html = '<details class="card dec-snap" data-dec-snap="' + esc(name) + '">' +
      '<summary class="small"><b>' + esc(name) + '</b> · 封存于 ' + esc(snap.asOf) +
      (snap.available ? ' · 可比' : ' · 不可比') + '</summary><div style="margin-top:8px">';
    if (!snap.available) {
      html += '<div class="small warn-text">' +
        esc(DECISION_SNAPSHOT_REASON_LABELS[snap.reason] || snap.reason || '不可比') +
        '；金额与比例按口径不输出，不伪造 0。</div>';
      if ((snap.blockers || []).length) {
        html += '<div class="db-list" style="margin-top:6px">' + snap.blockers.map(function (b) {
          return '<div class="db-item">· ' + esc(blockerText(b)) + '</div>';
        }).join('') + '</div>';
      }
      return html + '<div class="small muted" style="margin-top:6px">' + esc(executionText(snap.execution)) + '</div></div></details>';
    }
    html += '<div class="small muted">净资产 ' + (snap.netWorthMinor == null ? '—' : Core.fmtMoney(snap.netWorthMinor)) +
      ' · 可投资 ' + (snap.investableTotalMinor == null ? '—' : Core.fmtMoney(snap.investableTotalMinor)) +
      ' · 口径 ' + esc(snap.valuationStatus || '—') +
      ' · 现金' + (snap.cashReconciled ? '已核对' : '未核对') + '</div>' +
      '<div class="db-list" style="margin-top:6px">' + (snap.classes || []).map(function (c) {
        return '<div class="db-item" data-snap-cls="' + esc(c.assetClass) + '">' +
          esc(RISK_CLASS_LABELS[c.assetClass] || c.assetClass) + ' ' + Core.fmtMoney(c.valueMinor) +
          (c.pctBps == null ? '' : ' · ' + bpsText(c.pctBps)) +
          (c.band ? ' · ' + esc(BAND_LABELS[c.band] || c.band) : '') + '</div>';
      }).join('') + '</div>' +
      '<div class="small muted" style="margin-top:6px">' + esc(executionText(snap.execution)) + '</div>' +
      '<div class="small muted" style="margin-top:4px">本快照是时点封存的事实，只用于配置变化对照，不是收益归因。</div>' +
      '</div></details>';
    return html;
  }

  // 6E-2 复盘对照区（契约 §4.3）：三时点封存快照的六类横向对照，全部搬运服务端 comparison
  // 值，页面不换算。可比 → 每类一张小卡（决策 / 执行 / 复盘三行 + 变化量）；不可比 →
  // 按时点给出原因，不输出任何部分数字；复盘时点未封存 → 提示复盘入口，不渲染空表。
  // 文案铁律（契约 §4.3）：只写「配置变化对照」，禁止「建议收益 / 跑赢目标 / 赚了」。
  function decisionComparisonHtml(cmp, decisionState) {
    if (!cmp) {
      return '<div class="small muted" style="margin-top:6px">三时点配置变化对照属于复盘功能；' +
        '快照是当时事实的一次性封存。</div>';
    }
    var tp = cmp.timepoints || {};
    var tpLabel = { decision: '决策时点', executed: '执行时点', reviewed: '复盘时点' };
    var html = '<div class="sec-head" style="margin-top:10px"><b>配置变化对照（非收益）</b></div>';
    if (!tp.reviewed || !tp.reviewed.present) {
      html += '<div class="small muted" style="margin-top:4px" data-dec-comparison-pending>' +
        (tp.executed && tp.executed.present
          ? '已封存执行时点，复盘时点尚未封存：在上方「执行确认」里记录复盘后，' +
            '这里显示决策 / 执行 / 复盘三时点的配置变化对照。'
          : '复盘对照未开始：接受并关联实际交易、确认执行完成后再记录复盘；' +
            '复盘时点封存后这里显示三时点对照。') + '</div>';
      return html;
    }
    if (!cmp.comparable) {
      html += '<div class="small warn-text" style="margin-top:4px" data-dec-comparison-incomparable>' +
        '复盘对照不可比：存在不可比的时点快照，按口径不输出任何数字，也不伪造 0；' +
        '各时点封存的事实见下方时点快照。不可比原因：</div>';
      ['decision', 'executed', 'reviewed'].forEach(function (k) {
        var t = tp[k] || {};
        if (t.present && !t.available) {
          html += '<div class="small warn-text" data-dec-comparison-reason="' + esc(k) + '">' +
            '· ' + esc(tpLabel[k]) + '：' +
            esc(DECISION_SNAPSHOT_REASON_LABELS[t.reason] || t.reason || '不可比');
          if ((t.blockers || []).length) {
            html += '（' + t.blockers.map(function (b) { return esc(blockerText(b)); }).join('；') + '）';
          }
          html += '</div>';
        } else if (!t.present) {
          html += '<div class="small muted" data-dec-comparison-reason="' + esc(k) + '">· ' +
            esc(tpLabel[k]) + '：快照未封存</div>';
        }
      });
      return html;
    }
    html += '<div class="small muted" style="margin-top:2px">参照目标为决策引用的<b>历史目标版本</b>' +
      '（targetRef），不是当前生效目标；比例相对该版本的区间中值。</div>' +
      '<div data-dec-comparison>';
    (cmp.rows || []).forEach(function (row) {
      var cellLine = function (label, cell) {
        if (!cell) return '<div class="small muted" data-cmp-cell="' + label + '">· ' + label + '：不可比</div>';
        return '<div class="small" data-cmp-cell="' + label + '">· ' + label + '：' +
          Core.fmtMoney(cell.valueMinor) +
          (cell.pctBps == null ? ' · 比例不可用' : ' · ' + bpsText(cell.pctBps)) +
          (cell.band ? ' · ' + esc(BAND_LABELS[cell.band] || cell.band) : '') + '</div>';
      };
      var delta = '';
      if (row.deltaValueMinor != null) {
        delta = (row.deltaValueMinor > 0 ? '+' : '') + Core.fmtMoney(row.deltaValueMinor) + ' CNY';
        if (row.deltaPctBps != null) {
          delta += '（' + (row.deltaPctBps > 0 ? '+' : '') + bpsText(row.deltaPctBps) + '）';
        }
      } else {
        delta = '不可判定';
      }
      html += '<div class="db-item" data-cmp-class="' + esc(row.assetClass) + '">' +
        '<div class="row"><b>' + esc(RISK_CLASS_LABELS[row.assetClass] || row.assetClass) + '</b>' +
        '<span class="small muted" style="margin-left:auto">参照目标 ' +
        (row.targetBps == null ? '—' : bpsText(row.targetBps)) + '</span></div>' +
        cellLine('决策时点', row.decision) +
        cellLine('执行时点', row.executed) +
        cellLine('复盘时点', row.review) +
        '<div class="small" data-cmp-delta>变化（复盘 − 决策）：' + esc(delta) + '</div>' +
        '</div>';
    });
    html += '</div>' +
      '<div class="small muted" style="margin-top:4px">本对照是配置事实的变化，不是收益归因，' +
      '也不构成任何回报判断。</div>';
    return html;
  }

  function decisionDetailHtml(r) {
    var d = r.decision;
    var rec = r.recommendation || {};
    var last = (r.events && r.events.length) ? r.events[r.events.length - 1] : null;
    var exec = r.execution || {};
    var html = '<div data-dec-detail data-dec-detail-id="' + esc(d.id) + '">' +
      '<div class="row"><b>' + (rec.allocatedTotalMinor == null ? '—' : Core.fmtMoney(rec.allocatedTotalMinor) + ' CNY') +
      '</b>' + decisionStateChip(d.state) + '</div>' +
      (last ? '<div class="small muted" style="margin-top:4px">最近决定：' +
        esc(DECISION_REASON_LABELS[last.reasonCode] || last.reasonCode || '—') +
        (last.note ? ' · ' + esc(last.note) : '') + '</div>' : '') +
      '<div class="small muted" style="margin-top:4px">建议 ' + esc(rec.id || '—') + ' · 状态 ' + esc(rec.status || '—') +
      ' · 判定日 ' + esc(rec.asOf || '—') +
      ' · 解释版本 ' + esc(rec.explanationVersion ? 'v' + rec.explanationVersion : '未封存（非生成时版本）') +
      ' · 计算输入 ' + esc(String(rec.inputHash || '').slice(0, 12)) + '…</div>' +
      decisionStaleNote(rec.adviceStaleReasons) +
      '<div class="small muted" style="margin-top:6px">' + esc(executionText(exec)) + '</div>' +
      '<div class="small muted" style="margin-top:2px">折算费用 ' +
      (exec.linkedFeeCnyMinor == null ? '不可判定' : Core.fmtMoney(exec.linkedFeeCnyMinor)) +
      ((exec.fxUnavailable || []).length
        ? ' · 缺汇率事件 ' + exec.fxUnavailable.map(function (id) { return esc(String(id).slice(0, 12)) + '…'; }).join('、')
        : '') + '</div>';
    html += decisionLinksHtml(r);
    html += decisionActionHtml(r);
    html += '<div class="sec-head" style="margin-top:10px"><b>时间线</b></div>' +
      '<div class="small muted">状态事件与关联 / 解绑按<b>操作时间</b>升序；关联交易的<b>交易日</b>见上方关联明细，两者分列不混用。</div>' +
      '<div class="db-list" data-dec-timeline>';
    if (!(r.timeline || []).length) {
      html += '<div class="db-item">· 尚无状态事件（待决定）</div>';
    }
    (r.timeline || []).forEach(function (t) {
      if (t.kind === 'state') {
        html += '<div class="db-item" data-tl="state">· ' + esc(t.at) + ' ' +
          esc(DECISION_STATE_LABELS[t.fromState] || t.fromState) + ' → <b>' +
          esc(DECISION_STATE_LABELS[t.toState] || t.toState) + '</b>' +
          (t.reasonCode ? '（' + esc(DECISION_REASON_LABELS[t.reasonCode] || t.reasonCode) + '）' : '') +
          (t.note ? '：' + esc(t.note) : '') + '</div>';
      } else {
        html += '<div class="db-item" data-tl="link">· ' + esc(t.at) + ' ' +
          (t.action === 'unlink' ? '解除交易关联 ' : '关联实际交易 ') +
          esc(String(t.securityEventId || '').slice(0, 12)) + '…' +
          (t.note ? '：' + esc(t.note) : '') + '</div>';
      }
    });
    html += '</div>';
    var snaps = r.snapshots || {};
    html += '<div class="sec-head" style="margin-top:10px"><b>时点快照（封存事实）</b></div>' +
      (decisionSnapshotHtml('决策时点快照', snaps.decision) ||
        '<div class="small muted">还没有已封存的快照（尚无状态事件）。</div>') +
      (decisionSnapshotHtml('执行时点快照', snaps.executed)) +
      (decisionSnapshotHtml('复盘时点快照', snaps.reviewed)) +
      (decisionSnapshotHtml('归档快照', snaps.archived)) +
      '</div>';
    html += decisionComparisonHtml(r.comparison, d.state);
    return html;
  }

  /* ================= Phase 6D：实际交易关联与执行确认（契约 §3 / §8.5） =================
     页面只搬运服务端的 links / execution：关联、解绑、状态推进都是服务端命令，
     页面不折算进度、不预判门禁（是否需要偏差理由、是否允许归档一律由服务端判定）。 */

  function decisionLinkable(st) { return st === 'accepted' || st === 'executed'; }

  function decisionMaps() {
    var a = Domain.normalizeAssets(state.assets || {});
    var inst = {}, acc = {};
    (a.instruments || []).forEach(function (x) { inst[x.id] = x; });
    (a.assetAccounts || []).forEach(function (x) { acc[x.id] = x; });
    return { inst: inst, acc: acc };
  }

  // 关联行文案：事件事实与标的 / 账户标签都来自服务端载荷，页面只做显示拼接。
  function decisionLinkLabel(l) {
    var ev = l.event || {};
    var text;
    if (ev.eventType === 'buy' || ev.eventType === 'sell') {
      text = (ev.eventType === 'buy' ? '买入 ' : '卖出 ') + esc(ev.quantity || '') +
        (ev.priceMinor != null ? ' × ' + Core.fmtMoney(ev.priceMinor) + ' ' + esc(ev.currency || 'CNY') : '');
    } else {
      text = esc(EVENT_TYPE_LABELS[ev.eventType] || ev.eventType || '未知事件');
    }
    var m = decisionMaps();
    var ins = m.inst[ev.instrumentId] || {};
    var acc = m.acc[ev.accountId] || {};
    return {
      text: text,
      // 时间口径（契约 §5）：证券事件的发生日是「交易日」，关联 / 解绑日期是「操作时间」，
      // 两者分开标注，不混用。
      meta: (ev.occurredAt ? '交易日 ' + esc(ev.occurredAt) : '') +
        (ins.symbol ? ' · ' + esc(ins.symbol) : '') +
        (acc.name ? ' · ' + esc(acc.name) : ''),
      id: esc(l.id),
      securityEventId: esc(l.securityEventId)
    };
  }

  // 关联清单：活动行给出解绑入口（理由必填），解绑行只读展示，历史不被抹掉。
  function decisionLinksHtml(r) {
    var d = r.decision;
    var links = r.links || [];
    var canAct = decisionLinkable(d.state);
    var busy = state.decActionBusy;
    var activeSev = links.filter(function (l) { return l.unlinkedOn == null; })
      .map(function (l) { return l.securityEventId; });
    var html = '<div class="sec-head" style="margin-top:10px"><b>实际交易关联</b>' +
      '<span class="small muted">只引用既有证券事件，不复制交易、不写记账流水、不改现金余额</span></div>' +
      '<div class="db-list" data-dec-links>';
    if (!links.length) html += '<div class="db-item" data-dec-links-empty>· 还没有关联任何实际交易</div>';
    var unIdx = 0;
    links.forEach(function (l) {
      var info = decisionLinkLabel(l);
      var active = l.unlinkedOn == null;
      html += '<div class="db-item" data-dec-link="' + info.id + '" data-dec-link-state="' +
        (active ? 'active' : 'unlinked') + '">' +
        '<div class="row"><span class="small' + (active ? '' : ' muted') + '">' + info.text + '</span>' +
        '<span class="small muted" style="margin-left:auto">' + info.meta + '</span></div>' +
        '<div class="small muted">交易 ' + esc(String(l.securityEventId || '').slice(0, 14)) + '… · ' +
        (active ? '关联操作时间 ' + esc(l.linkedOn || '') : '解除操作时间 ' + esc(l.unlinkedOn || '')) +
        (l.note ? ' · 说明：' + esc(l.note) : '') +
        (!active && l.unlinkNote ? ' · 理由：' + esc(l.unlinkNote) : '') + '</div>' +
        (active && canAct
          ? '<div class="row" style="gap:6px;margin-top:6px">' +
            '<input id="dec-unlink-' + unIdx + '" data-unlink-note data-link-id="' + info.id +
            '" maxlength="2000" class="grow" placeholder="解绑理由（必填）" aria-label="解绑理由">' +
            '<button class="btn small" data-action="dec:unlink" data-id="' + info.id + '"' +
            (busy ? ' disabled' : '') + '>解除关联</button></div>'
          : '') +
        '</div>';
      if (active) unIdx++;
    });
    html += '</div>';
    if (!canAct) {
      return html + '<div class="small muted" style="margin-top:6px">当前状态（' +
        esc(DECISION_STATE_LABELS[d.state] || d.state) + '）只读，不能关联或解绑。</div>';
    }
    // 可关联候选 = 服务端返回的买入事件里尚未被本决策占用的那些；
    // 是否已被别的决策占用由服务端判定，重复占用时如实显示 409 说明，页面不预判。
    var pool = ((state.decLinkEvents && state.decLinkEvents.items) || [])
      .filter(function (e) { return e.eventType === 'buy' && activeSev.indexOf(e.id) === -1; });
    html += '<div class="row" style="gap:8px;margin-top:8px">' +
      '<input id="dec-link-note" class="grow" maxlength="2000" placeholder="关联说明（可选，如「第一批买入」）"' +
      ' aria-label="关联说明"' + (busy ? ' disabled' : '') + '></div>' +
      '<div class="row" style="gap:8px;margin-top:6px">' +
      '<select id="dec-link-pick" class="grow" aria-label="选择要关联的买入事件">' +
      (pool.length
        ? pool.map(function (e) {
            var info = decisionLinkLabel({ securityEventId: e.id, event: e, linkedOn: e.occurredAt });
            return '<option value="' + esc(e.id) + '">' + info.text + ' · ' + info.meta + '</option>';
          }).join('')
        : '<option value="">没有可关联的买入事件</option>') +
      '</select>' +
      '<button class="btn small primary" data-action="dec:link"' +
      ((pool.length && !busy) ? '' : ' disabled') + '>关联这笔</button></div>' +
      '<div class="row" style="gap:8px;margin-top:6px">' +
      '<button class="btn small ghost" data-action="dec:newtrade"' + (busy ? ' disabled' : '') +
      '>新增买入并关联</button>' +
      '<span class="small muted">新增交易复用「持仓与证券事件」原录入入口，保存后按 id 关联</span></div>';
    if (state.decLinkEventsError) {
      html += '<div class="small warn-text" style="margin-top:6px" data-dec-link-events-error>买入事件读取失败：' +
        esc(state.decLinkEventsError) + '，上方候选可能不完整；关联结果仍以服务端校验为准。</div>';
    }
    return html;
  }

  // 执行确认 / 复盘入口（契约 §1.3 L4/L5/L6）：accepted → executed 要求活动关联 ≥1
  // （有偏差必须填说明），accepted → archived 要求活动关联 = 0，executed → reviewed 复盘
  // 理由必填。页面不预判门禁结果，失败就地显示服务端原因；复盘后一切只读。
  function decisionActionHtml(r) {
    var d = r.decision;
    if (!decisionLinkable(d.state)) return '';
    var busy = state.decActionBusy;
    var html = '<div class="sec-head" style="margin-top:10px"><b>执行确认</b></div>' +
      '<div class="small muted" data-dec-action-hint>' +
      (d.state === 'accepted'
        ? '关联实际买入后确认执行完成；放弃执行前须先把活动关联全部解绑。原建议金额不会被改写。'
        : '已执行：仍可补记或解绑实际交易；核对无误后记录复盘（理由必填）。复盘是终态，' +
          '封存复盘快照后这条决策一切只读，之后改行情 / 目标 / 资产都不会改变已封存的事实。') + '</div>' +
      '<div class="small warn-text" data-dec-action-error hidden></div>';
    if (d.state === 'executed') {
      html += '<div class="row" style="gap:8px;margin-top:8px">' +
        '<input id="dec-review-note" class="grow" maxlength="2000" placeholder="复盘理由（必填：对照结果与下一步）"' +
        ' aria-label="复盘理由"' + (busy ? ' disabled' : '') + '>' +
        '<button class="btn small primary" data-action="dec:event" data-to="reviewed"' +
        (busy ? ' disabled' : '') + '>记录复盘</button></div>';
      return html;
    }
    html += '<div class="row" style="gap:8px;margin-top:8px">' +
      '<input id="dec-exec-note" class="grow" maxlength="2000" placeholder="执行说明（有偏差时必填）"' +
      ' aria-label="执行说明"' + (busy ? ' disabled' : '') + '>' +
      '<button class="btn small primary" data-action="dec:event" data-to="executed"' +
      (busy ? ' disabled' : '') + '>确认执行完成</button>' +
      '<button class="btn small" data-action="dec:event" data-to="archived"' +
      (busy ? ' disabled' : '') + '>放弃执行并归档</button></div>';
    return html;
  }

  function decisionSheetId() {
    var d = document.querySelector('#sheet [data-dec-detail]');
    return d ? d.getAttribute('data-dec-detail-id') : '';
  }

  function decActionFail(msg) {
    var box = document.querySelector('#sheet [data-dec-action-error]');
    if (box) { box.textContent = msg; box.hidden = false; }
    toast(msg, 'err');
  }
  function decActionClearError() {
    var box = document.querySelector('#sheet [data-dec-action-error]');
    if (box) { box.textContent = ''; box.hidden = true; }
  }
  function setDecActionBusy(on) {
    state.decActionBusy = !!on;
    $all('#sheet button[data-action^="dec:"]').forEach(function (b) { b.disabled = !!on; });
  }

  // 关联 / 解绑 / 状态推进成功后就地重读详情（弹层保持打开，序号照旧防晚到覆盖）；
  // 失败保持弹层与用户已输入的内容，只就地显示错误 —— 失败绝不显示成功。
  function reloadDecisionDetail(id) {
    var seq = ++state.decDetailSeq;
    if ($('#sheet-mask').classList.contains('hidden')) { state.decActionBusy = false; return Promise.resolve(); }
    return Promise.all([Store.decisionDetail(id), Store.listSecurityEvents()]).then(function (rs) {
      if (seq !== state.decDetailSeq) return;
      if ($('#sheet-mask').classList.contains('hidden')) return;
      state.decDetail = rs[0];
      state.decLinkEvents = rs[1];
      state.decLinkEventsError = '';
      state.decActionBusy = false;
      openSheet('决策详情', decisionDetailHtml(rs[0]));
      ensureDecisionsLoaded(true); // 卡片上的执行进度同步刷新
    }).catch(function (e) {
      if (seq !== state.decDetailSeq) return;
      state.decActionBusy = false;
      decActionFail('详情刷新失败：' + ((e && e.message) || '未知错误') +
        '；请关闭弹层后重新打开核对，关联结果以服务端为准。');
    });
  }

  function decisionLinkAction() {
    var id = decisionSheetId();
    if (!id || state.decActionBusy) return;
    var pick = document.getElementById('dec-link-pick');
    var sevId = pick ? pick.value : '';
    if (!sevId) { toast('没有可关联的买入事件', 'warn'); return; }
    var noteEl = document.getElementById('dec-link-note');
    var note = noteEl ? String(noteEl.value || '').trim() : '';
    var payload = { securityEventId: sevId };
    if (note) payload.note = note;
    setDecActionBusy(true);
    decActionClearError();
    Store.createDecisionLink(id, payload, { idempotencyKey: Core.newId('lnk') })
      .then(function (r) {
        toast(r && r.created === false ? '这笔交易已关联过，未重复占用' : '已关联实际交易', 'ok');
        return reloadDecisionDetail(id);
      })
      .catch(function (e) {
        setDecActionBusy(false);
        decActionFail('关联失败：' + ((e && e.message) || '未知错误') +
          '。交易事实没有被复制，可重新选择后重试。');
      });
  }

  function decisionUnlinkAction(el) {
    var id = decisionSheetId();
    if (!id || state.decActionBusy) return;
    var linkId = el.getAttribute('data-id');
    var input = document.querySelector('#sheet input[data-link-id="' + linkId + '"]');
    var note = input ? String(input.value || '').trim() : '';
    if (!note) { toast('解绑必须填写理由', 'warn'); return; }
    setDecActionBusy(true);
    decActionClearError();
    Store.unlinkDecisionLink(id, { linkId: linkId, note: note }, { idempotencyKey: Core.newId('lnk') })
      .then(function () { toast('已解除关联', 'ok'); return reloadDecisionDetail(id); })
      .catch(function (e) {
        setDecActionBusy(false);
        decActionFail('解绑失败：' + ((e && e.message) || '未知错误') + '。该关联保持原样。');
      });
  }

  function decisionEventAction(el) {
    var id = decisionSheetId();
    if (!id || state.decActionBusy) return;
    var to = el.getAttribute('data-to');
    // executed 与 archived 的说明各用独立输入框；reviewed 的理由在复盘输入框里
    var noteEl = document.getElementById(to === 'reviewed' ? 'dec-review-note' : 'dec-exec-note');
    var note = noteEl ? String(noteEl.value || '').trim() : '';
    if ((to === 'archived' || to === 'reviewed') && !note) {
      toast(to === 'reviewed' ? '复盘必须填写理由' : '归档必须填写理由', 'warn');
      return;
    }
    var payload = { toState: to };
    if (note) payload.note = note;
    setDecActionBusy(true);
    decActionClearError();
    Store.appendDecisionEvent(id, payload, { idempotencyKey: Core.newId('deve') })
      .then(function (r) {
        var st = (r && r.decision && r.decision.state) || to;
        toast('已记录状态：' + (DECISION_STATE_LABELS[st] || st), 'ok');
        return reloadDecisionDetail(id);
      })
      .catch(function (e) {
        setDecActionBusy(false);
        decActionFail('状态没有推进：' + ((e && e.message) || '未知错误') + '。决策仍保持原状态。');
      });
  }

  // 新增交易后按 id 关联：关掉详情 → 回到资产页 → 复用原证券事件录入弹层；
  // 关联在 holding:saveEvent 保存成功后按返回的事件 id 继续（失败不重建交易）。
  function decisionNewTradeAction() {
    var id = decisionSheetId();
    if (!id) return;
    closeSheet();
    state.decLinkPending = id;
    nav('assets');
    holdingEventSheet();
  }

  function openDecisionDetail(id) {
    state.decDetail = null;
    state.decDetailError = '';
    // 慢响应守卫（拆解 §5）：先递增序号，晚到的旧详情既不能覆盖在读的新详情，
    // 也不能在用户已经关闭弹层后重新弹出。
    var seq = ++state.decDetailSeq;
    openSheet('决策详情', '<div class="small muted" data-dec-detail-loading data-dec-detail-id="' +
      esc(id) + '">决策详情读取中…</div>');
    // 6D：详情与「可关联的买入事件」一起读，二者都到手才渲染，避免弹层半路重排；
    // 买入事件读失败不阻断详情（关联区如实标注候选可能不完整）。
    var eventsReq = Store.listSecurityEvents().then(function (r) {
      state.decLinkEventsError = '';
      return r;
    }).catch(function (e) {
      state.decLinkEventsError = (e && e.message) || '读取失败';
      return { items: [] };
    });
    Promise.all([Store.decisionDetail(id), eventsReq]).then(function (rs) {
      if (seq !== state.decDetailSeq) return; // 已有更新的详情请求（或用户已打开另一条）
      if ($('#sheet-mask').classList.contains('hidden')) return; // 已关闭：不强行弹回脸上
      state.decDetail = rs[0];
      state.decLinkEvents = rs[1];
      openSheet('决策详情', decisionDetailHtml(rs[0]));
    }).catch(function (e) {
      if (seq !== state.decDetailSeq) return;
      if ($('#sheet-mask').classList.contains('hidden')) return;
      state.decDetail = null;
      state.decDetailError = (e && e.message) || '读取失败';
      openSheet('决策详情', '<div class="small warn-text" data-dec-detail-error data-dec-detail-id="' +
        esc(id) + '">详情读取失败：' +
        esc(state.decDetailError) + '</div>' +
        '<div class="row" style="margin-top:10px"><button class="btn small" data-action="dec:detail" data-id="' +
        esc(id) + '">重试</button></div>');
    });
  }

  function openDecisionSheet(item) {
    state.decSheetRec = item;
    state.decNoteDraft = '';
    state.decSubmitError = '';
    renderDecisionSheet();
  }

  // 决定弹层。失效建议的「接受」会被服务端拒绝（契约 §2.2），弹层内如实预告；
  // 暂缓 / 忽略不做时效重核（归档一条失效建议是合法诉求）。
  function renderDecisionSheet() {
    var item = state.decSheetRec;
    if (!item) return;
    var res = item.formalRecommendation || {};
    var note = res.roundingNote || {};
    var stale = adviceStaleReasons(item);
    var codes = res.explainCodes || [];
    var body = '<div data-decide-sheet>' +
      '<div class="small muted">来源：目标配置页生成的' + (stale.length ? '历史' : '') + '正式建议 · 建议金额 ' +
      Core.fmtMoney(note.allocatedTotalMinor) + ' CNY · 判定日 ' + esc((res.versions && res.versions.asOf) || '') + '</div>' +
      '<div class="small muted" style="margin-top:2px">解释：' +
      (codes.length ? codes.map(function (c) { return esc(ADVICE_EXPLAIN_LABELS[c] || c); }).join('；') : '见建议详情解释区') +
      '</div>' +
      (stale.length
        ? '<div class="small warn-text" style="margin-top:8px">这条建议当前已失效（' +
          stale.map(function (k) { return esc(ADVICE_STALE_LABELS[k] || k); }).join('；') +
          '）。接受会被本机服务端拒绝；暂缓或忽略仍可记录。</div>'
        : '<div class="small muted" style="margin-top:8px">接受时服务端会重新核对建议有效性；页面角标不是授权依据。</div>') +
      '<label class="small" style="display:block;margin-top:10px" for="dec-note">决定理由（必填，最多 2000 字）</label>' +
      '<textarea id="dec-note" rows="3" maxlength="2000" data-input="dec:note" style="width:100%"' +
      ' placeholder="例如：本月发薪后按建议分两笔买入；或：等待更多事实再决定">' + esc(state.decNoteDraft) + '</textarea>' +
      (state.decSubmitError
        ? '<div class="small warn-text" style="margin-top:8px" data-dec-error>提交失败：' + esc(state.decSubmitError) +
          '。决定没有保存，可修改后重试。</div>'
        : '') +
      '<div class="row" style="gap:8px;margin-top:12px">' +
      '<button class="btn small primary" data-action="dec:submit" data-intent="accepted"' +
      (state.decBusy ? ' disabled' : '') + '>接受并进入待执行</button>' +
      '<button class="btn small" data-action="dec:submit" data-intent="deferred"' +
      (state.decBusy ? ' disabled' : '') + '>暂缓</button>' +
      '<button class="btn small ghost" data-action="dec:submit" data-intent="dismissed"' +
      (state.decBusy ? ' disabled' : '') + '>忽略</button></div></div>';
    openSheet('对这条建议做出决定', body);
  }

  function submitDecision(el) {
    if (state.decBusy) return; // 防重复点击：提交进行中忽略后续点击
    var intent = el.dataset.intent;
    var item = state.decSheetRec;
    if (!item) return;
    var note = String(state.decNoteDraft || '').trim();
    if (!note) {
      toast('请先填写决定理由', 'warn');
      return;
    }
    state.decBusy = true;
    state.decSubmitError = '';
    var req = ++state.decSubmitSeq;
    renderDecisionSheet(); // 立即禁用三个按钮
    Store.createDecision({ recommendationId: item.id, intent: intent, note: note },
      { idempotencyKey: Core.newId('dec') })
      .then(function (r) {
        if (req !== state.decSubmitSeq) return; // 慢响应晚到：不覆盖后续操作
        state.decBusy = false;
        state.decSheetRec = null;
        closeSheet();
        toast(r.created ? '已记录决定：' + (DECISION_STATE_LABELS[r.decision.state] || r.decision.state)
          : '这条建议已有决策，未重复创建', 'ok');
        ensureDecisionsLoaded(true);
      })
      .catch(function (e) {
        if (req !== state.decSubmitSeq) return;
        state.decBusy = false;
        state.decSubmitError = (e && e.message) || '写入失败';
        renderDecisionSheet(); // 失败不假成功：弹层保持打开并显示错误，理由草稿不丢
        toast('决定未保存：' + state.decSubmitError, 'err');
      });
  }

  // 建议详情 → 决定入口。估算建议不可创建决策（契约 §2.1）；一条建议只有一个决定，
  // 已有决策时只显示状态与详情入口，不提供第二次提交。
  function decisionEntryBlock(item) {
    if (item.status !== 'formal') {
      return '<div class="small muted" style="margin-top:10px" data-dec-estimate-note>' +
        '估算建议不能创建决策、不进入待执行清单；请先补齐数据与门禁，重新生成正式建议。</div>';
    }
    var dec = decisionForRecommendation(item.id);
    if (dec) {
      return '<div class="small" style="margin-top:10px" data-dec-exists>这条建议已有决策：' +
        esc(DECISION_STATE_LABELS[dec.state] || dec.state) +
        '（决定日 ' + esc(dec.lastEventAt || '—') + '）' +
        ' <button class="link" data-action="dec:detail" data-id="' + esc(dec.id) + '">查看详情</button></div>';
    }
    return '<div class="row" style="margin-top:10px" data-dec-entry>' +
      '<button class="btn small primary" data-action="dec:open" data-rec-id="' + esc(item.id) + '">' +
      '进入决定（接受 / 暂缓 / 忽略）</button>' +
      '<span class="small muted" style="margin-left:auto">决定必须填写理由；接受后进入待执行清单</span></div>';
  }

  /* ================= 弹层 ================= */
  function openSheet(title, bodyHtml, onOpen) {
    $('#sheet').innerHTML =
      '<div class="sheet-title"><b>' + esc(title) + '</b><button class="close" data-action="sheet:close">关闭</button></div>' + bodyHtml;
    $('#sheet-mask').classList.remove('hidden');
    if (onOpen) onOpen($('#sheet'));
  }
  function closeSheet() {
    // 关闭详情即使马上打开别的弹层，旧请求也不能借新弹层的可见状态回填。
    state.decDetailSeq++;
    // 6D：「新增交易并关联」的待关联意图随弹层关闭一起作废，避免之后的普通录入被误关联
    state.decLinkPending = null;
    state.decActionBusy = false;
    $('#sheet-mask').classList.add('hidden');
    $('#sheet').innerHTML = '';
  }
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
      // G5-R3：连本机状态都读不出来时，静态知识卡仍不依赖服务与账户数据，入口不能一并消失。
      var kb = [knowledgeLinkHtml('card-capacity-vs-willingness', '能力与意愿'),
        knowledgeLinkHtml('card-tolerance-band', '容忍带说明')].filter(Boolean).join('、');
      document.getElementById('view').innerHTML = '<div class="empty">数据加载失败：' +
        esc(e && e.message || e) +
        '<div class="small muted" style="margin-top:8px">请刷新重试' +
        (kb ? '<br>不依赖服务与账户数据，现在就能读：' + kb : '') + '</div>' +
        '<button class="btn" data-action="nav:help" style="margin-top:14px">使用说明与启动帮助</button></div>';
      if (location.hash === '#help') { state.page = 'help'; render(); }
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
      '<div class="lock-box"><h2>小账本已锁定</h2>' +
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
    autoRefreshMarketDataOnBoot();
    renderServiceBanner();
    renderTabbar();
    route(location.hash.replace('#', '') || 'home');
    window.addEventListener('hashchange', function () {
      route(location.hash.replace('#', '') || 'home');
    });
  }

  // Phase 4D 启动时尝试一次汇率自动更新（触发方式：手动按钮 + 启动时尝试一次）。
  // 只在「确实有需要更新的目标」时才发请求（有币对缺失汇率或已过期），因此不会每次打开页面都打网络；
  // 一旦更新成功，汇率日变成今天，后续启动自然不再触发。失败**静默** —— 行情区块会把过期状态显示出来，
  // 用户还可以手动补价；启动期的网络问题不该打断记账入口。
  var marketAutoRefreshTried = false;
  function autoRefreshMarketDataOnBoot() {
    if (marketAutoRefreshTried) return;
    marketAutoRefreshTried = true;
    if (Store.info().mode !== Store.MODE_API) return;
    // 默认关闭：只有用户在资产页显式打开「启动时自动更新汇率」才尝试。
    // 这与 D-038「自动抓取默认关闭」同纪律，也符合"先手动验证、再考虑自动化"的推进方式。
    if (state.settings.marketDataAutoRefresh !== true) return;
    var a = Domain.normalizeAssets(state.assets);
    var today = todayDateStr();
    var needFx = Domain.requiredFxPairs(a).some(function (p) {
      var r = Domain.findFxRate(a.fxRates, p.base, p.quote, today);
      return !r || r.status === 'fx_stale';
    });
    if (!needFx) return;
    Store.refreshMarketData({ scopes: ['fx'] }).then(function (r) {
      var fx = ((r && r.scopes) || []).filter(function (s) { return s.scope === 'fx'; })[0];
      if (fx && fx.updated > 0) {
        toast('汇率已自动更新 ' + fx.updated + ' 项（ECB 参考汇率）');
        return refreshAssets();
      }
      return null;
    }).catch(function () { /* 静默：启动期失败不打扰用户 */ });
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
    // 启动读数失败时，说明不依赖账本，仍可阅读；不把应用伪装成正常启动。
    if (!state.ready && page === 'help') { location.hash = 'help'; state.page = 'help'; render(); window.scrollTo(0, 0); return; }
    if (location.hash.replace('#', '') === page) route(page);
    else location.hash = page;
  }
  // Phase 4E：结账快照列表既是「历史结账」的数据源，也是收益归因的**基准来源**。
  // 决策台与结账页都要用，因此统一在这里惰性加载一次（同一进程不重复请求），
  // 加载完成后再按需要重渲染当前页。force=true 用于刚结完账时强制刷新。
  function ensureClosesLoaded(force) {
    if (state.closesLoading) return;
    if (state.closesLoaded && !force) return;
    state.closesLoading = true;
    Store.listMonthlyCloses().then(function (r) {
      state.closes = (r && r.items) || [];
      state.closesLoaded = true;
      state.closesLoading = false;
      if (state.page === 'close' || state.page === 'home') render();
      // 强刷（例如刚结完账）之后基准快照可能更新，归因明细缓存作废，重新读取。
      if (state.page === 'home') ensureAttributionSnapshot(force === true);
    }).catch(function () {
      state.closesLoaded = true;
      state.closesLoading = false;
    });
  }

  // G4E-1：按当前选中的期初基准读取其封存快照 payload。
  // 归因的期初腿只认这份封存明细（数量/价格/汇率/事件计数），绝不按当前事实表重算期初。
  // 注意：缓存键用 closeId（基准选择器的值），但快照接口的参数是 snapshot.id —— 两者不同。
  function ensureAttributionSnapshot(invalidate) {
    if (!state.closesLoaded || state.page !== 'home') return;
    var baseline = pickBaseline(state.closes || []);
    var wantId = baseline ? baseline.id : null;
    var wantSnapId = baseline && baseline.snapshot ? baseline.snapshot.id : null;
    if (!wantId || !wantSnapId) return;
    if (!invalidate && state.attrSnap.closeId === wantId &&
      (state.attrSnap.status === 'loading' || state.attrSnap.status === 'ready' || state.attrSnap.status === 'error')) {
      return;
    }
    state.attrSnap = { closeId: wantId, status: 'loading', payload: null, hashValid: null };
    render();
    Store.getCloseSnapshot(wantSnapId).then(function (r) {
      if (state.attrSnap.closeId !== wantId) return; // 期间已切换基准，丢弃过期结果
      var snapshot = r && r.snapshot;
      state.attrSnap = {
        closeId: wantId,
        status: 'ready',
        payload: (snapshot && snapshot.payload) || null,
        // fail closed：旧/异常响应没有完整性结论时，也不能把内容当作已校验快照使用。
        hashValid: !!(snapshot && snapshot.hashValid === true)
      };
      if (state.page === 'home') render();
    }).catch(function () {
      if (state.attrSnap.closeId !== wantId) return;
      state.attrSnap = { closeId: wantId, status: 'error', payload: null, hashValid: null };
      if (state.page === 'home') render();
    });
  }

  function route(page) {
    if (!state.ready) return;
    if (['home', 'cashflow', 'list', 'stats', 'settings', 'add', 'import', 'accounts', 'categories',
      'budget', 'health', 'reimburse', 'recurring', 'assets', 'close', 'risk', 'targets', 'decisions', 'help'].indexOf(page) < 0) page = 'home';
    state.page = page;
    if (page !== 'add') { state.editId = null; }
    if (page !== 'list') { state.selectMode = false; state.selectedIds = {}; }
    // 先标记复核中，再画首页；不能先把缓存的「有效」状态当作当前结论展示。
    if (page === 'home') {
      ensureRiskCurrentLoaded();
      ensureAllocCurrentLoaded();
    }
    renderTabbar();
    try {
      render();
    } catch (e) {
      console.error(e);
      $('#view').innerHTML = '<div class="empty">页面渲染出错：' +
        esc(e && e.message || e) + '<div class="small muted" style="margin-top:8px">数据未受影响，可返回首页重试</div>' +
        '<button class="btn primary" style="margin-top:12px" onclick="location.hash=\'home\'">回首页</button></div>';
    }
    // Phase 4E：决策台要展示收益归因、结账页要展示历史结账，都需要快照列表；
    // 归因还需要基准快照的封存明细（G4E-1）。
    if (page === 'home' || page === 'close') ensureClosesLoaded(false);
    if (page === 'home') ensureAttributionSnapshot(false);
    // Phase 5B：风险评估页进入时惰性读取（决策台只需要当前评估判定，见 5E-1 摘要卡）。
    if (page === 'risk') ensureRiskLoaded(false);
    // Phase 5E-1 的复核已在首页初次渲染前启动；响应只更新摘要卡。
    // Phase 5C：目标配置与认可标的同样惰性读取；页面不重算映射与偏离。
    if (page === 'targets') ensureTargetsLoaded(false);
    // Phase 6C：决策与待执行页惰性读取；目标页也读一份轻量列表，
    // 让「建议详情」能直接显示这条建议是否已有决策（而不是点下去才发现 created:false）。
    if (page === 'decisions') ensureDecisionsLoaded(false);
    if (page === 'targets') ensureDecisionsLoaded(false);
    window.scrollTo(0, 0);
  }

  function renderTabbar() {
    // 桌面侧栏复用现有 nav:* 动作；窄屏仍只显示原五个主入口。
    var icons = {
      home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
      assets: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M7 15h4"/>',
      risk: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
      targets: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
      close: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-12 5h3m3 0h2"/>',
      decisions: '<path d="M9 6h11M9 12h11M9 18h11M4 5.5 5.5 7 8 4.5M4 11.5 5.5 13 8 10.5M4 6v12"/>',
      cashflow: '<path d="M3 7h13m-4-4 4 4-4 4M21 17H8m4-4-4 4 4 4"/>',
      list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/>',
      stats: '<path d="M4 20V11m5 9V4m5 16v-7m5 7V8"/>',
      add: '<path d="M12 4v16M4 12h16"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      help: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4zM13 7a3 3 0 0 1 3-3h5v14h-4a4 4 0 0 0-4 3"/>'
    };
    function glyph(id) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[id] + '</svg>';
    }
    var groups = [
      { label: '决策空间', tabs: [
        { id: 'home', label: '资产决策台', mobile: '资产' },
        { id: 'assets', label: '资产录入', desktop: true },
        { id: 'risk', label: '风险评估', desktop: true },
        { id: 'targets', label: '目标配置', desktop: true },
        { id: 'decisions', label: '决策与待执行', desktop: true },
        { id: 'close', label: '月度结账', desktop: true }
      ] },
      { label: '日常账务', tabs: [
        { id: 'cashflow', label: '现金流与预算', desktop: true },
        { id: 'list', label: '交易明细', mobile: '明细' },
        { id: 'stats', label: '统计分析', mobile: '统计' }
      ] }
    ];
    function tab(t) {
      return '<button class="tab' + (t.desktop ? ' desktop-only' : '') + (state.page === t.id ? ' active' : '') +
        '" data-action="nav:' + t.id + '"' + (state.page === t.id ? ' aria-current="page"' : '') + '>' +
        '<span class="ti">' + glyph(t.id) + '</span><span class="tab-label">' + t.label + '</span>' +
        (t.mobile ? '<span class="mobile-label">' + t.mobile + '</span>' : '') + '</button>';
    }
    $('#tabbar').classList.remove('hidden');
    $('#tabbar').innerHTML = '<div class="nav-brand"><span class="nav-mark">↗</span><span><b>LEDGER</b><small>PERSONAL FINANCE</small></span></div>' +
      '<div class="nav-groups">' + groups.map(function (g) {
        return '<div class="nav-group"><div class="nav-section-label">' + g.label + '</div>' + g.tabs.map(tab).join('') + '</div>';
      }).join('') + '</div>' +
      '<div class="nav-footer"><div class="tab-add"><button data-action="nav:add" title="记一笔">' +
      '<span class="ti">' + glyph('add') + '</span><span class="tab-label">记一笔</span></button></div>' +
      tab({ id: 'help', label: '使用说明', desktop: true }) +
      tab({ id: 'settings', label: '设置与数据', mobile: '我的' }) +
      '<div class="nav-local">本机运行 · 私密数据留在 Mac</div></div>';
  }

  function render() {
    var view = $('#view');
    view.className = 'view-page view-' + state.page;
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
      case 'risk': html = tplRisk(); break;
      case 'targets': html = tplTargets(); break;
      case 'decisions': html = tplDecisions(); break;
      case 'help': html = tplHelp(); break;
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
  // Phase 4E：敞口市场展示名。'unspecified' 是"用户还没填"的分组桶，不是 EXPOSURE_MARKETS 词表值。
  var EXPOSURE_MARKET_LABELS = {
    CN: '中国内地', HK: '中国香港', US: '美国', global: '全球', other: '其他',
    unspecified: '未填写敞口市场'
  };
  // Phase 4E 归因边界码 → 为什么这一段不能拆成"价格影响 + 汇率影响"。
  // 这些码只描述"能不能分解"，与 BLOCKER_LABELS 的"能不能给正式建议"是两套语义，不得混用。
  var ATTRIBUTION_BOUNDARY_LABELS = {
    no_baseline: '没有可用的期初基准（需要一份已结账月快照）',
    missing_start_quote: '缺少期初价格（基准日当天及之前没有报价）',
    missing_end_quote: '缺少期末价格',
    missing_start_fx: '缺少期初汇率（基准日当天及之前没有该币对汇率）',
    missing_end_fx: '缺少期末汇率',
    currency_changed: '期间报价币种发生变化',
    position_opened: '期间新建仓位',
    position_closed: '期末已清仓',
    quantity_changed: '期间有买卖，持有数量已变化',
    opening_rebased: '期间重录了期初快照（数量跳档不是收益）',
    instrument_missing: '标的记录缺失',
    holding_invalid: '数量或价格无法参与计算'
  };
  var ATTRIBUTION_NOTE_LABELS = {
    end_quote_stale: '期末行情已过期（本期仍是估算口径）',
    end_fx_stale: '期末汇率已过期（本期仍是估算口径）',
    classification_unconfirmed: '标的分类未确认（本期仍是估算口径）'
  };

  function blockerText(b) {
    return (BLOCKER_LABELS[b.code] || b.code) + (b.detail ? '（' + b.detail + '）' : '');
  }

  /* ============== Phase 4E：估值下钻与收益归因（决策台） ============== */

  // 估值下钻：四个维度共用 Domain.computeAssetDrilldown 的**同一遍**估值，
  // 因此"合计与总览一致"由领域层直接给结论，页面不再各写一套容忍判断。
  function groupBlock(title, scope, groups, totalMinor) {
    var rows = groups.map(function (g) {
      var pct = totalMinor > 0 ? Math.round(g.valueCnyMinor / totalMinor * 1000) / 10 : null;
      return '<div class="risk-row"><span class="r-name">' + esc(g.label || g.key) + '</span>' +
        '<span class="r-bar"><i style="width:' + Math.min(pct || 0, 100) + '%"></i></span>' +
        '<span class="r-val">' + Core.fmtMoney(g.valueCnyMinor) + '</span>' +
        '<span class="r-pct">' + (pct == null ? '—' : pct + '%') + '</span></div>' +
        (g.unvaluedCount
          ? '<div class="small muted" style="padding:0 0 4px">· 有 ' + g.unvaluedCount + ' 项因缺汇率未计入合计</div>'
          : '');
    }).join('');
    return '<div class="sec-head" style="margin-top:10px"><b>' + esc(title) + '</b>' +
      '<span class="small muted" style="margin-left:auto">' + esc(scope) + '</span></div>' +
      (rows || '<div class="small muted" style="padding:6px 0">无</div>');
  }

  function positionsDetail(positions) {
    if (!positions.length) return '';
    var rows = positions.map(function (p) {
      return '<tr><td style="text-align:left">' + esc(p.symbol || p.instrumentId || '') +
        '<div class="small muted">' + esc(p.accountName || '') + ' · ' +
        esc(RISK_CLASS_LABELS[p.riskClass] || p.riskClass || '') + ' · ' +
        esc(EXPOSURE_MARKET_LABELS[p.exposureMarket || 'unspecified'] || '') + '</div></td>' +
        '<td>' + (p.quantity == null ? '—' : esc(String(p.quantity))) + '</td>' +
        '<td>' + (p.priceMinor == null ? '—' : Core.fmtMoney(p.priceMinor) + ' ' + esc(p.currency || '')) +
        '<div class="small muted">价格日 ' + esc(p.priceDate || '—') + ' · 来源 ' + esc(p.priceProvider || '—') + '</div></td>' +
        '<td>' + (p.fxRateDecimal == null ? '<span class="muted">—</span>' : esc(String(p.fxRateDecimal))) +
        '<div class="small muted">汇率日 ' + esc(p.fxRateDate || '—') + ' · 来源 ' + esc(p.fxProvider || '—') + '</div></td>' +
        '<td>' + (p.valueCnyMinor == null
          ? '<span class="muted">' + (p.skipped === 'missing_fx' ? '缺汇率·未计入' : '未计入') + '</span>'
          : Core.fmtMoney(p.valueCnyMinor) + ' CNY') + '</td></tr>';
    }).join('');
    return '<details style="margin-top:10px" data-positions-detail="' + positions.length + '">' +
      '<summary class="small muted">逐持仓追溯（数量 / 价格 / 价格日 / 来源 / 汇率 / 汇率日 / 来源）</summary>' +
      '<div style="overflow-x:auto"><table class="mini"><thead><tr>' +
      '<th style="text-align:left">标的 / 账户</th><th>数量</th><th>价格</th><th>汇率</th><th>折 CNY</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></details>';
  }

  function drilldownCard() {
    var dd = Domain.computeAssetDrilldown(state.assets, { now: todayDateStr(), settings: state.settings });
    var c = dd.consistency;
    var ok = c.byAccountMatches && c.byCurrencyMatches && c.byAssetClassMatches && c.byMarketMatches;
    var consistency = '<div class="small muted" style="margin-top:8px" data-consistency="' + (ok ? 'ok' : 'mismatch') + '">' +
      (ok
        ? ' 四个维度合计与总览一致（机构 / 币种 = 总资产，资产类别 = 投资池，市场 = 投资池持仓）'
        : ' 下钻合计与总览不一致：机构 ' + Core.fmtMoney(c.sumByAccountMinor) +
          ' · 币种 ' + Core.fmtMoney(c.sumByCurrencyMinor) +
          ' · 类别 ' + Core.fmtMoney(c.sumByAssetClassMinor) +
          ' · 市场 ' + Core.fmtMoney(c.sumByMarketMinor) + '，请勿据此决策') +
      '</div>';
    // 结构化定位属性：wiring 用这些数字与 GET /api/v1/overview 交叉核对，
    // 而不是解析「按机构 / 按币种」这些区块里的格式化文案。
    return '<div class="card" data-drilldown="1"' +
      ' data-as-of="' + esc(dd.asOf) + '"' +
      ' data-positions="' + dd.positions.length + '"' +
      ' data-total-assets="' + dd.totals.totalAssetsMinor + '"' +
      ' data-net-worth="' + dd.totals.netWorthMinor + '"' +
      ' data-investable="' + dd.totals.investableMinor + '"' +
      ' data-sum-by-account="' + c.sumByAccountMinor + '"' +
      ' data-sum-by-currency="' + c.sumByCurrencyMinor + '"' +
      ' data-sum-by-asset-class="' + c.sumByAssetClassMinor + '"' +
      ' data-sum-by-market="' + c.sumByMarketMinor + '">' +
      '<div class="row small muted"><b>估值下钻</b>' +
      '<span style="margin-left:auto">数据日 ' + esc(dd.asOf) + '</span></div>' +
      groupBlock('按机构', '全部资产 · 合计 ' + Core.fmtMoney(dd.totals.totalAssetsMinor), dd.byAccount, dd.totals.totalAssetsMinor) +
      groupBlock('按币种', '全部资产 · 合计 ' + Core.fmtMoney(dd.totals.totalAssetsMinor), dd.byCurrency, dd.totals.totalAssetsMinor) +
      groupBlock('按资产类别', '仅投资池 · 合计 ' + Core.fmtMoney(dd.totals.investableMinor), dd.byAssetClass, dd.totals.investableMinor) +
      groupBlock('按敞口市场', '仅投资池持仓 · 合计 ' + Core.fmtMoney(dd.totals.investableHoldingsMinor), dd.byMarket, dd.totals.investableHoldingsMinor) +
      consistency + positionsDetail(dd.positions) + '</div>';
  }

  // 默认基准：最近一个「早于本月」的已结账月；若没有（例如本月也已结账），退化为最新一份快照。
  function pickBaseline(closes) {
    if (!closes.length) return null;
    if (state.baselineCloseId) {
      var picked = closes.filter(function (x) { return x.id === state.baselineCloseId; })[0];
      if (picked) return picked;
    }
    var month = todayDateStr().slice(0, 7);
    var older = closes.filter(function (x) { return String(x.month) < month; });
    return older.length ? older[0] : closes[0];
  }

  function attributionLine(label, minor) {
    return '<div class="row small"><span>' + esc(label) + '</span>' +
      '<span style="margin-left:auto">' + (minor == null ? '—' : Core.fmtMoney(minor) + ' CNY') + '</span></div>';
  }

  function attributionCard() {
    var head = '<div class="row small muted"><b>收益归因</b>' +
      '<span style="margin-left:auto">证券价格影响与汇率影响分开计算</span></div>';

    if (!state.closesLoaded) {
      return '<div class="card" data-attribution="loading">' + head +
        '<div class="small muted" style="padding:6px 0">加载结账快照…</div></div>';
    }
    var closes = state.closes || [];
    if (!closes.length) {
      return '<div class="card" data-attribution="no-closes">' + head +
        '<div class="small muted" style="padding:6px 0;line-height:1.8">' +
        '收益归因需要一个已结账月作为期初基准，目前还没有结账记录。<br>' +
        '先做一次月度结账，这里就能看到「证券价格影响」和「汇率影响」各是多少。</div>' +
        '<button class="btn ghost small" data-action="nav:close">去月度结账</button></div>';
    }

    var baseline = pickBaseline(closes);

    var options = closes.map(function (x) {
      return '<option value="' + esc(x.id) + '"' + (baseline && x.id === baseline.id ? ' selected' : '') + '>' +
        esc(ymLabel(x.month)) + ' 月末快照（' + (x.status === 'formal' ? '正式' : '估算') + '）</option>';
    }).join('');
    var picker = '<div class="small muted" style="margin-top:6px">期初基准</div>' +
      '<select id="attr-baseline" data-change="attr:baseline" data-baseline="' + esc(baseline ? baseline.id : '') + '">' +
      options + '</select>';

    // G4E-1：等基准快照的封存明细就绪后才计算归因 —— 期初腿只认封存事实，
    // 不按当前事实表重算，所以明细没到之前不能出任何数字。
    var snapState = (state.attrSnap && state.attrSnap.closeId === baseline.id) ? state.attrSnap : null;
    if (!snapState || snapState.status === 'loading') {
      return '<div class="card" data-attribution="snapshot-loading">' + head + picker +
        '<div class="small muted" style="padding:6px 0">正在读取基准快照的封存明细…</div></div>';
    }
    if (snapState.status === 'error' || (!snapState.payload && snapState.hashValid !== false)) {
      return '<div class="card" data-attribution="snapshot-error">' + head + picker +
        '<div class="small muted" style="padding:6px 0;line-height:1.8">基准快照读取失败，暂时无法计算收益归因。' +
        '可稍后重试，或换一个基准月。</div></div>';
    }
    // 快照完整性失败时不把 payload 交给提取器：显式传空 positions + mismatch，
    // 让领域层统一返回 rows=[]，页面上的 baseline_hash_mismatch 分支真正可达。
    var derived = snapState.hashValid === true
      ? Domain.baselinePositionsFromSnapshot(snapState.payload)
      : { positions: [], unavailable: 'baseline_hash_mismatch' };
    var baselineArg = {
      asOf: baseline.dataCutoff,
      month: baseline.month,
      closeId: baseline.id,
      snapshotId: baseline.snapshot.id,
      payloadHash: baseline.snapshot.payloadHash,
      status: baseline.status,
      positions: derived.positions,
      detailsUnavailable: derived.unavailable
    };
    var at = Domain.computeReturnAttribution(state.assets, {
      now: todayDateStr(),
      settings: state.settings,
      baseline: baselineArg
    });

    if (at.unavailable === 'baseline_details_missing') {
      return '<div class="card" data-attribution="baseline-missing">' + head + picker +
        '<div class="small muted" style="padding:6px 0;line-height:1.8">这份基准快照没有封存逐持仓的明细' +
        '（旧版本生成的快照），期初基准不可用，因此不给归因数字。<br>对基准月重新结账即可补全。</div></div>';
    }
    if (at.unavailable === 'baseline_hash_mismatch') {
      return '<div class="card" data-attribution="baseline-mismatch">' + head + picker +
        '<div class="small muted" style="padding:6px 0;line-height:1.8">基准快照的内容与封存哈希不一致，' +
        '这份快照不能作为期初基准，因此不给归因数字。<br>请检查数据是否被修改过，或对基准月重新结账。</div></div>';
    }

    if (at.unavailable === 'no_baseline') {
      return '<div class="card" data-attribution="no-baseline">' + head + picker +
        '<div class="small muted" style="padding:6px 0">这份快照缺少可用的数据截止日，无法作为期初基准。' +
        '换一个基准月，或重新结账以生成完整快照。</div></div>';
    }

    var t = at.totals;
    // 结构化定位属性：wiring 断言读这些数字，而不是解析格式化后的文案。
    // null 一律输出空串（不是 0），让断言能区分「零」与「定不出来」。
    var numAttr = function (m) { return m == null ? '' : String(m); };
    var summary = '<div class="acc-card" style="margin-top:8px" data-attr-totals="1"' +
      ' data-count="' + t.rowCount + '" data-attributable-count="' + t.attributableCount + '"' +
      ' data-boundary-count="' + t.boundaryCount + '"' +
      ' data-can-advise="' + (at.valuation.canAdvise ? '1' : '0') + '"' +
      ' data-start="' + numAttr(t.startValueCnyMinor) + '"' +
      ' data-end="' + numAttr(t.endValueCnyMinor) + '"' +
      ' data-change="' + numAttr(t.valueChangeCnyMinor) + '"' +
      ' data-price="' + numAttr(t.priceEffectCnyMinor) + '"' +
      ' data-fx="' + numAttr(t.fxEffectCnyMinor) + '"' +
      ' data-unattributed="' + numAttr(t.unattributedChangeCnyMinor) + '"' +
      ' data-baseline-id="' + esc(String(at.baseline && at.baseline.closeId || '')) + '"' +
      ' data-baseline-hash="' + esc(String(at.baseline && at.baseline.payloadHash || '')) + '">' +
      attributionLine('期初估值（' + (at.baseline && at.baseline.asOf ? at.baseline.asOf : '—') + '）', t.startValueCnyMinor) +
      attributionLine('期末估值（' + at.asOf + '）', t.endValueCnyMinor) +
      attributionLine('估值变化', t.valueChangeCnyMinor) +
      attributionLine('其中 · 证券价格影响', t.priceEffectCnyMinor) +
      attributionLine('其中 · 汇率影响', t.fxEffectCnyMinor) +
      (t.unattributedChangeCnyMinor
        ? attributionLine('未能归因的变化', t.unattributedChangeCnyMinor)
        : '') +
      '<div class="small muted" style="margin-top:6px">已分解 ' + t.attributableCount + ' 条 · 有边界 ' + t.boundaryCount +
      ' 条（价格影响 + 汇率影响 + 未能归因 = 估值变化）</div>' +
      '<div class="small muted">口径：' + (at.valuation.canAdvise ? '正式' : '估算（存在数据缺口，暂不能生成正式建议）') +
      ' · 基准快照 ' + esc(String(at.baseline && at.baseline.payloadHash || '').slice(0, 8)) + '</div></div>';

    var rowHtml = at.rows.map(function (r) {
      var boundaryHtml = r.boundaries.map(function (b) {
        return '<div class="small muted">· ' + esc(ATTRIBUTION_BOUNDARY_LABELS[b] || b) + '</div>';
      }).join('');
      var noteHtml = r.notes.map(function (n) {
        return '<div class="small muted">· ' + esc(ATTRIBUTION_NOTE_LABELS[n] || n) + '</div>';
      }).join('');
      var money = function (m) { return m == null ? '—' : Core.fmtMoney(m); };
      return '<div class="acc-card" data-attr-row="' + esc(r.instrumentId || '') + '"' +
        ' data-attributable="' + (r.attributable ? '1' : '0') + '"' +
        ' data-boundaries="' + esc(r.boundaries.join(',')) + '"' +
        ' data-notes="' + esc(r.notes.join(',')) + '"' +
        ' data-change="' + numAttr(r.valueChangeCnyMinor) + '"' +
        ' data-price="' + numAttr(r.priceEffectCnyMinor) + '"' +
        ' data-fx="' + numAttr(r.fxEffectCnyMinor) + '"' +
        ' data-start-quantity="' + esc(String(r.startQuantity)) + '"' +
        ' data-end-quantity="' + esc(String(r.endQuantity)) + '"' +
        ' data-start-price-date="' + esc(String(r.startPriceDate || '')) + '"' +
        ' data-end-price-date="' + esc(String(r.endPriceDate || '')) + '">' +
        '<div class="row"><b>' + esc(r.symbol || r.instrumentId || '') + '</b>' +
        '<span class="small muted" style="margin-left:auto">' + esc(r.accountName || '') + '</span></div>' +
        '<div class="small muted">数量 ' + esc(r.startQuantity) + ' → ' + esc(r.endQuantity) +
        ' · 价格 ' + money(r.startPriceMinor) + '（' + esc(r.startPriceDate || '—') + '）→ ' +
        money(r.endPriceMinor) + '（' + esc(r.endPriceDate || '—') + '）' +
        ' · 来源 ' + esc(r.startPriceProvider || '—') + '/' + esc(r.endPriceProvider || '—') + '</div>' +
        '<div class="small muted">汇率 ' + esc(String(r.startRateDecimal || '—')) + '（' + esc(r.startRateDate || '—') + '）→ ' +
        esc(String(r.endRateDecimal || '—')) + '（' + esc(r.endRateDate || '—') + '）' +
        ' · 来源 ' + esc(r.startRateProvider || '—') + '/' + esc(r.endRateProvider || '—') + '</div>' +
        (r.attributable
          ? '<div class="dash-sub"><span>价格影响 ' + money(r.priceEffectCnyMinor) + '</span>' +
            '<span>汇率影响 ' + money(r.fxEffectCnyMinor) + '</span>' +
            '<span>合计 ' + money(r.valueChangeCnyMinor) + '</span></div>'
          : '<div class="small muted">本次不做分解' +
            (r.valueChangeCnyMinor == null ? '（两端估值也定不出来）' : '：估值变化 ' + money(r.valueChangeCnyMinor) + ' 未分解') +
            '</div>') +
        boundaryHtml + noteHtml + '</div>';
    }).join('');

    return '<div class="card" data-attribution="ready">' + head + picker + summary + rowHtml +
      '<div class="small muted" style="margin-top:8px;line-height:1.8">' +
      '· 价格影响 =（期末本地币值 − 期初本地币值）× 期初汇率；汇率影响取残差，两侧相加恒等于估值变化。' +
      knowledgeLinkHtml('card-fx-risk', '汇率风险说明') + '<br>' +
      '· 期初数量按期初日重放事件求得；期初价格与汇率只认基准日当天及之前的事实，绝不插值、不按 1:1 兜底。<br>' +
      '· 期间有买卖、清仓、重录期初，或缺任一端的价格/汇率时，只给估值变化、不做分解。</div></div>';
  }

  function tplDashboard() {
    var ov = Domain.computeOverview(state.assets, { now: todayDateStr(), settings: state.settings });
    var statusChip;
    if (ov.valuationStatus === 'formal') {
      statusChip = '<span class="dash-chip ok"> 数据完整 · 正式口径</span>';
    } else if (ov.valuationStatus === 'estimate') {
      statusChip = '<span class="dash-chip warn"> 估算口径 · 暂不能生成正式建议</span>';
    } else {
      statusChip = '<span class="dash-chip">空状态</span>';
    }
    var html = '<div class="dash-head"><div><div class="dash-eyebrow">OVERVIEW / 财务全景</div>' +
      '<div class="dash-title">资产决策台</div>' +
      '<div class="small muted">把资产、风险和下一步行动放在同一张桌面上 · 数据日 ' + esc(ov.asOf) + '</div></div>' +
      '<div class="dash-head-actions"><button class="btn small ghost" data-action="nav:help">使用说明</button>' + statusChip + '</div></div>';

    /* Phase 5E-1：决策台的风险摘要卡。判定与数值只反映服务端 /risk-assessments/current
       的结果（双评分与等级、最终上限、硬封顶、评估/到期日、有效状态），
       这里不复制评分或到期判断，也不据此生成建议；空资产时同样展示：
       风险评估不依赖资产数据，是正式建议的前置条件之一。 */
    var riskSummary = riskSummaryCardHtml();

    /* Phase 5E-2：六类配置对照（只读）。数值全部来自 /targets/current，
       与目标页共用词表；无目标/无估值/分类未确认时给原因与目标页入口。 */
    var allocCompare = allocationCompareCardHtml();
    state.allocCompareHtml = allocCompare;

    /* Phase 5C 入口：目标配置与认可标的。摘要只反映服务端给出的状态，
       页面不在这里重算区间、比例或偏离。 */
    var targetSub = '风险上限 → 类别区间 · 认可标的白名单';
    var tv = state.targetsView;
    if (Store.info().mode !== Store.MODE_API) {
      targetSub = '本地服务运行后可维护';
    } else if (tv && tv.status === 'current') {
      targetSub = '当前目标 L' + tv.target.level + ' · ' + ((tv.missingClasses || []).length
        ? '缺映射 ' + tv.missingClasses.length + ' 类'
        : '六类映射齐备');
    } else if (tv && tv.status === 'stale_assessment') {
      targetSub = '评估已更新，目标待重新生成';
    } else if (tv && tv.status === 'no_target') {
      targetSub = '已有有效评估，尚未生成目标版本';
    } else if (tv && tv.status === 'no_assessment') {
      targetSub = '需要先完成风险评估';
    }
    var targetEntry =
      '<div class="card dash-entry" data-action="nav:targets">' +
      '<div><b>目标配置</b><div class="small muted">' + targetSub + '</div></div>' +
      '<span class="arrow">›</span></div>';

    /* 空状态：不虚构任何总额（S1.4） */
    if (ov.isEmpty) {
      return html + '<div class="dashboard-empty-layout"><div class="empty dash-empty">' +
        '<div class="dash-empty-kicker">YOUR FINANCIAL PICTURE</div><b>从完整的资产视角开始</b>' +
        '<div class="dash-empty-note">还没有资产数据</div>' +
        '<div class="small muted" style="line-height:1.8;margin-top:6px">这里将展示净资产、可投资资产、安全储备与风险配比。<br>' +
        '从资产录入开始：机构 → 账户 → 余额；也可通过「我的 → 恢复备份」导入包含资产数据的备份文件。</div>' +
        '<div class="dash-empty-actions">' +
        '<button class="btn primary" data-action="nav:assets">录入资产</button>' +
        '<button class="btn" data-action="nav:cashflow">去记一笔现金流</button></div></div>' +
        '<div class="dashboard-empty-rail">' + riskSummary + allocCompare + targetEntry + '</div></div>';
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
    var riskCard = '<div class="card dash-risk-card"><div class="row small muted"><b>风险资产类别配比</b>' +
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
      '<div class="card dash-emergency-card"><div class="row small muted"><b>应急金覆盖</b>' +
      '<button class="link small" style="margin-left:auto" data-action="nav:close">月度结账 ›</button></div>' +
      '<div class="dash-net" style="font-size:26px">' + covMain + '</div>' +
      '<div class="small muted" style="margin-top:4px">' + covHint + '</div></div>';

    /* 可新增投资资金 */
    var newFundsCard =
      '<div class="card dash-new-funds"><div class="row small muted"><b>本月可新增投资资金</b>' +
      '<span style="margin-left:auto">' + (ov.canAdvise ? '正式口径' : '估算') + '</span></div>' +
      '<div class="dash-net" style="font-size:26px">' + Core.fmtMoney(ov.newFundsAvailableMinor) + '<span class="unit"> CNY</span></div>' +
      '<div class="dash-sub"><span>可投资现金 ' + Core.fmtMoney(ov.investableCashMinor) + '</span>' +
      '<span>近期应付款 ' + Core.fmtMoney(ov.duePayablesMinor) + '</span>' +
      '<span>储备缺口 ' + Core.fmtMoney(ov.safetyGapMinor) + '</span></div></div>';

    /* 待办与权益状态 */
    var todoHtml = '';
    if (ov.todos.length || ov.entitlements.length) {
      todoHtml = '<div class="card dash-todos"><div class="row small muted"><b>待办与状态</b></div>';
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

    /* Phase 6C 入口：决策与待执行清单（移动端经此进入；计数只在清单已读取时显示） */
    var decAccepted = state.decItems.filter(function (d) { return d.state === 'accepted'; }).length;
    var decSub = Store.info().mode !== Store.MODE_API
      ? '本地服务运行后可维护'
      : (state.decLoaded ? (decAccepted ? '待执行 ' + decAccepted + ' 条' : '暂无待执行决策') : '接受 / 暂缓 / 忽略与待执行清单');
    var decisionsEntry =
      '<div class="card dash-entry" data-action="nav:decisions">' +
      '<div><b>决策与待执行</b><div class="small muted">' + esc(decSub) + '</div></div>' +
      '<span class="arrow">›</span></div>';

    return html + blockerHtml +
      '<div class="dash-hero-grid">' + hero + newFundsCard + '</div>' + poolCards +
      '<div class="dash-content-grid"><div class="dash-content-main">' +
      riskCard + allocCompare + drilldownCard() + attributionCard() +
      '</div><div class="dash-content-side">' + emergencyCard + riskSummary + todoHtml +
      '<div class="dash-side-heading">快捷入口</div>' +
      assetEntry + closeEntry + targetEntry + decisionsEntry + cashflowEntry +
      '</div></div>' + caliber;
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
      (accCards || '<div class="empty"><b>还没有资产账户</b>' +
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

    /* 汇率维护：Phase 3 手动登记 + Phase 4D 自动更新（ECB 参考汇率）。
       自动更新不得覆盖用户在**同一天或更早**手动确认过的值（D-044）。 */
    var fxToday = todayDateStr();
    var fxRows = a.fxRates.map(function (r) {
      var fresh = Domain.findFxRate([r], r.base, r.quote, fxToday);
      var stale = fresh && fresh.status === 'fx_stale';
      return '<div class="todo-item small" data-fx="' + esc(r.base + '/' + r.quote) + '">· ' + esc(r.base) + '→' + esc(r.quote) + ' ' + esc(r.rateDecimal) +
        '<span class="muted"> 汇率日 ' + esc(r.rateDate || '—') + ' · 来源 ' + esc(r.provider || '未标注') +
        (stale ? ' · 已过期（>' + Domain.MAX_STALE_DAYS + ' 天）' : '') + '</span></div>';
    }).join('');
    var fxSection = '<div class="sec-head"><b>汇率</b>' +
      '<span class="small"><button class="link" data-action="market:refresh" data-scope="fx">↻ 更新汇率</button> ' +
      '<button class="link" data-action="asset:fx">＋登记汇率</button></span></div>' +
      '<div class="card">' + (fxRows || '<div class="small muted">暂无汇率；外币余额缺汇率时不计入汇总，且会阻塞正式结账</div>') +
      '<div class="small muted" style="margin-top:6px">自动更新走 ECB 参考汇率（固定 provider 端点），' +
      '只补非 CNY 币种对 CNY 的币对；你在同一天或更早手动登记过的币对不会被自动值覆盖。</div></div>';

    return html + accountSection + transferSection + liabSection + entSection + presetSection + catalogSection() + holdingsSection() + quoteSection() + fxSection +
      '<div class="small muted" style="margin-top:12px">说明：权益只展示状态与备注，不计入任何资产合计；' +
      '外币余额按估值日汇率折算，缺汇率时该项不计入；换汇只记为资产转移，不计收入或支出；' +
      '标的分类由你确认后锁定，参考数据变化只提示差异。</div>';
  }

  /* ---------- 持仓与证券事件（Phase 4C，D-042）----------
     数量只有一份推导口径（D-025）：期初 + Σ买入 − Σ卖出，由服务端与前端共用同一份
     Domain.deriveHoldings 计算；分红/费用只记金额、不改数量；事件绝不进入现金流。 */
  var EVENT_TYPE_LABELS = { buy: '买入', sell: '卖出', dividend: '分红', fee: '费用' };

  function holdingsSection() {
    var a = Domain.normalizeAssets(state.assets);
    var accountMap = {}, instMap = {};
    a.assetAccounts.forEach(function (x) { accountMap[x.id] = x; });
    a.instruments.forEach(function (x) { instMap[x.id] = x; });

    var derived = Domain.deriveHoldings(a.holdings, a.securityEvents).holdings;
    var holdingRows = derived.map(function (h) {
      var ins = instMap[h.instrumentId] || {};
      var acc = accountMap[h.accountId] || {};
      var counts = [];
      if (h.counts.buy) counts.push('买 ' + h.counts.buy);
      if (h.counts.sell) counts.push('卖 ' + h.counts.sell);
      if (h.counts.dividend) counts.push('分红 ' + h.counts.dividend);
      if (h.counts.fee) counts.push('费用 ' + h.counts.fee);
      return '<div class="acc-card" data-holding="' + esc(h.accountId + ':' + h.instrumentId) + '">' +
        '<div class="row"><b>' + esc(ins.symbol || h.instrumentId) + '</b>' +
        '<span class="small muted" style="margin-left:auto">持有 ' + esc(h.quantity) + '</span></div>' +
        '<div class="small muted">' + esc(acc.name || h.accountId || '未知账户') +
        ' · 期初 ' + esc(h.openingQuantity == null ? '0（无期初）' : h.openingQuantity) +
        (counts.length ? ' · ' + esc(counts.join(' / ')) : '') +
        (h.lastEventAt ? ' · 最近事件 ' + esc(h.lastEventAt) : '') +
        (ins.classificationStatus === 'confirmed' ? '' : ' · 分类未确认') +
        (h.oversellEvents && h.oversellEvents.length ? ' · 存在未通过的超额卖出' : '') + '</div>' +
        '</div>';
    }).join('');

    var eventRows = a.securityEvents.slice().sort(function (x, y) {
      return String(y.occurredAt || '').localeCompare(String(x.occurredAt || ''));
    }).map(function (e) {
      var ins = instMap[e.instrumentId] || {};
      var acc = accountMap[e.accountId] || {};
      var cur = e.currency || ins.currency || '';
      var detail;
      if (e.eventType === 'buy' || e.eventType === 'sell') {
        detail = (e.eventType === 'buy' ? '买入 ' : '卖出 ') + esc(e.quantity || '') +
          (e.priceMinor != null ? ' @ ' + Core.fmtMoney(e.priceMinor) + ' ' + esc(cur) : '');
      } else {
        detail = esc(EVENT_TYPE_LABELS[e.eventType] || e.eventType) + ' ' + Core.fmtMoney(e.amountMinor) + ' ' + esc(cur);
      }
      return '<div class="acc-card" data-event-id="' + esc(e.id || '') + '">' +
        '<div class="row"><b>' + esc(ins.symbol || e.instrumentId) + '</b>' +
        '<span class="small muted" style="margin-left:auto">' + esc(e.occurredAt || '') + '</span></div>' +
        '<div class="small muted">' + detail + ' · ' + esc(acc.name || e.accountId || '未知账户') + '</div>' +
        '</div>';
    }).join('');

    var section = '<div class="sec-head"><b>持仓与证券事件</b>' +
      '<span class="small"><button class="link" data-action="holding:opening">＋期初快照</button> ' +
      '<button class="link" data-action="holding:event">＋记录事件</button></span></div>';
    if (!holdingRows && !eventRows) {
      return section + '<div class="empty"><b>还没有持仓记录</b>' +
        '<div class="small muted">先在标的目录建立标的，再登记期初快照或买卖事件；持有数量 = 期初 + 买入 − 卖出，由服务端统一推导</div></div>';
    }
    return section +
      (holdingRows ? '<div class="card">' + holdingRows + '</div>' : '') +
      (eventRows ? '<div class="sec-head"><b>事件流水</b></div><div class="card">' + eventRows + '</div>' : '');
  }

  /* ---------- 行情与汇率（Phase 4D，D-044）----------
     自动抓取的可用状态与新鲜度**只在服务端事实源上判定**（Domain.findQuote / findFxRate），
     页面只做展示与手动兜底入口。D-038 门禁未通过 → 自动行情默认关闭：
     页面如实说明这一点，且不提供开启开关（门禁通过后才加），避免"看起来能自动更新"的误导。 */
  function quoteFreshnessLabel(status) {
    if (status === 'ok') return '<span class="small" style="color:var(--ok,#1a7f37)">新鲜</span>';
    if (status === 'quote_stale') return '<span class="small" style="color:var(--warn,#b45309)">已过期（>' + Domain.MAX_STALE_DAYS + ' 天）</span>';
    return '<span class="small muted">缺失</span>';
  }

  function quoteSection() {
    var a = Domain.normalizeAssets(state.assets);
    var today = todayDateStr();
    var instMap = {};
    a.instruments.forEach(function (x) { instMap[x.id] = x; });
    var targets = Domain.requiredQuoteSymbols(a);

    var rows = targets.map(function (t) {
      var q = Domain.findQuote(a.quotes, t.instrumentId, today);
      var ins = instMap[t.instrumentId] || {};
      var price = q ? Core.fmtMoney(q.priceMinor) + ' ' + esc(q.currency || ins.currency || '') : '—';
      var meta = q
        ? '价格日 ' + esc(q.priceDate || '—') + ' · 来源 ' + esc(q.provider || '未标注')
        : '尚未登记任何报价';
      return '<div class="acc-card" data-quote="' + esc(t.instrumentId) + '">' +
        '<div class="row"><b>' + esc(t.symbol || t.instrumentId) + '</b>' +
        '<span class="small muted" style="margin-left:auto">' + price + '</span></div>' +
        '<div class="small muted">' + meta + ' · ' + (q ? quoteFreshnessLabel(q.status) : quoteFreshnessLabel('missing')) + '</div>' +
        '<button class="btn ghost small" data-action="asset:quote" data-id="' + esc(t.instrumentId) + '">手动补价</button>' +
        '</div>';
    }).join('');

    var note = '自动行情抓取（D-038 门禁）当前<b>默认关闭</b>：一轮复核仍未找到同时满足' +
      '「免费 / 有官方条款与自动化授权 / 覆盖 A+H+US ETF 日终」的来源，因此行情以「手动补价 + 本地缓存」' +
      '为唯一事实来源；汇率侧可自动更新（ECB 参考汇率）。刷新只会在成功时写入新值，' +
      '失败会保留上一次的有效值并在这里显示为过期，不会把上次的值抹掉。';

    var autoOn = state.settings && state.settings.marketDataAutoRefresh === true;
    var autoRow = '<div class="row" style="margin-top:8px">' +
      '<span class="small">启动时自动更新汇率' + (autoOn ? '：已开启' : '：已关闭（默认）') + '</span>' +
      '<button class="btn ghost small" style="margin-left:auto" data-action="market:toggleAuto">' +
      (autoOn ? '关闭' : '开启') + '</button></div>';

    var section = '<div class="sec-head"><b>行情（收盘价）</b>' +
      '<span class="small"><button class="link" data-action="market:refresh">↻ 更新行情与汇率</button></span></div>' +
      '<div class="card">' +
      (rows || '<div class="small muted">暂无需要估值的标的（有持仓或已登记报价的标的会出现在这里）</div>') +
      autoRow +
      '<div class="small muted" style="margin-top:6px">' + note + '</div></div>';
    return section;
  }

  function assetQuoteSheet(instrumentId) {
    var a = Domain.normalizeAssets(state.assets);
    if (!a.instruments.length) { toast('请先在标的目录建立标的', 'warn'); return; }
    var instOpts = a.instruments.map(function (ins) {
      var sel = ins.id === instrumentId ? ' selected' : '';
      return '<option value="' + esc(ins.id) + '"' + sel + '>' + esc(ins.symbol) +
        (ins.exchange ? ' · ' + esc(ins.exchange) : '') + '</option>';
    }).join('');
    openSheet('手动补价（收盘价）',
      '<div class="form-row">' +
      formItem('标的', '<select id="q-inst">' + instOpts + '</select>') +
      formItem('收盘价（按标的币种）', '<input id="q-price" type="number" min="0" step="0.01" placeholder="如 4.53">') +
      formItem('价格日', '<input id="q-date" type="date" value="' + todayDateStr() + '">') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">手动补价记为来源「manual」；同一标的同一价格日只保留一条报价，' +
      '自动更新不会覆盖你在同一天或更早手动确认过的价格（D-044）。</div>' +
      '<button class="btn primary block" data-action="asset:saveQuote">保存价格</button>');
  }

  function holdingOpeningSheet() {
    var a = Domain.normalizeAssets(state.assets);
    var brokerAccounts = a.assetAccounts.filter(function (acc) { return acc.kind === 'broker'; });
    if (!brokerAccounts.length) { toast('请先创建证券账户（账户类型选择券商）', 'warn'); return; }
    if (!a.instruments.length) { toast('请先在标的目录建立标的', 'warn'); return; }
    var accOpts = brokerAccounts.map(function (acc) {
      return '<option value="' + esc(acc.id) + '">' + esc(acc.name) + '</option>';
    }).join('');
    var instOpts = a.instruments.map(function (ins) {
      return '<option value="' + esc(ins.id) + '">' + esc(ins.symbol) + (ins.exchange ? ' · ' + esc(ins.exchange) : '') + '</option>';
    }).join('');
    openSheet('登记期初持仓快照',
      '<div class="form-row">' +
      formItem('账户', '<select id="ho-acc">' + accOpts + '</select>') +
      formItem('标的', '<select id="ho-inst">' + instOpts + '</select>') +
      formItem('期初数量', '<input id="ho-qty" type="number" min="0" step="0.00000001" placeholder="如 10 或 10.5">') +
      formItem('期初总成本（可选）', '<input id="ho-cost" type="number" min="0" step="0.01" placeholder="0.00">') +
      formItem('核对日期', '<input id="ho-date" type="date" value="' + todayDateStr() + '">') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">同一账户下同一标的只能有一行期初事实；' +
      '之后的买入 / 卖出事件在此基础上推导持有数量。</div>' +
      '<button class="btn primary block" data-action="holding:saveOpening">保存期初</button>');
  }

  function holdingEventSheet() {
    var a = Domain.normalizeAssets(state.assets);
    var brokerAccounts = a.assetAccounts.filter(function (acc) { return acc.kind === 'broker'; });
    if (!brokerAccounts.length) { toast('请先创建证券账户（账户类型选择券商）', 'warn'); return; }
    if (!a.instruments.length) { toast('请先在标的目录建立标的', 'warn'); return; }
    var accOpts = brokerAccounts.map(function (acc) {
      return '<option value="' + esc(acc.id) + '">' + esc(acc.name) + '</option>';
    }).join('');
    var instOpts = a.instruments.map(function (ins) {
      return '<option value="' + esc(ins.id) + '">' + esc(ins.symbol) + (ins.exchange ? ' · ' + esc(ins.exchange) : '') + '</option>';
    }).join('');
    var typeOpts = Domain.SECURITY_EVENT_TYPES.map(function (t) {
      return '<option value="' + esc(t) + '">' + esc(EVENT_TYPE_LABELS[t] || t) + '</option>';
    }).join('');
    openSheet('记录证券事件',
      '<div class="form-row">' +
      formItem('事件类型', '<select id="he-type">' + typeOpts + '</select>') +
      formItem('账户', '<select id="he-acc">' + accOpts + '</select>') +
      formItem('标的', '<select id="he-inst">' + instOpts + '</select>') +
      formItem('数量（买卖必填）', '<input id="he-qty" type="number" min="0" step="0.00000001" placeholder="如 2 或 0.1">') +
      formItem('每股价格（可选）', '<input id="he-price" type="number" min="0" step="0.01" placeholder="0.00">') +
      formItem('手续费（可选）', '<input id="he-fee" type="number" min="0" step="0.01" placeholder="0.00">') +
      formItem('分红/费用总额（分红、费用必填）', '<input id="he-amount" type="number" min="0" step="0.01" placeholder="0.00">') +
      formItem('事件日期', '<input id="he-date" type="date" value="' + todayDateStr() + '">') +
      '</div>' +
      '<div class="small muted" style="padding:0 4px 8px">事件是追加式事实，重复提交会被拒绝；' +
      '买入 / 卖出改变持有数量（卖出不得超过当时持有数量），分红 / 费用只记金额；' +
      '证券事件不是现金流，不会进入收入或支出。</div>' +
      '<button class="btn primary block" data-action="holding:saveEvent">保存事件</button>');
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
        : '<div class="empty"><b>目录里还没有标的</b>' +
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
        ? '<span class="dash-chip ok"> 无缺项 · 可正式结账</span>'
        : '<span class="dash-chip warn"> ' + cl.items.length + ' 类待核对 · 估算口径</span>') +
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
        budgetHtml += '<div class="over-banner"> 本月已超支：支出 ' + Core.fmtMoney(bst.total.spent) +
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
      ? '<div class="over-banner info"> 有 ' + state.pendingRecurring + ' 笔周期账待生成 <button class="link" data-action="recur:previewDue">预览生成</button> <button class="link" data-action="nav:recurring">设置</button></div>'
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
      catAgg.push({ id: cid, name: c ? c.name : '未分类', icon: c ? c.icon : '', sum: agg.byCategory[cid].sum, count: agg.byCategory[cid].count });
    });
    catAgg.sort(function (a, b) { return b.sum - a.sum; });
    var top5 = catAgg.slice(0, 5);
    var donutItems = top5.map(function (c, i) { return { label: c.name, value: c.sum }; });
    var legend = top5.map(function (c, i) {
      var pct = agg.expense ? (c.sum / agg.expense * 100).toFixed(1) : '0';
      return '<div class="legend-item"><i style="background:' + Charts.PALETTE[i % Charts.PALETTE.length] + '"></i>' +
        '<span>' + esc(c.name) + '</span><span class="li-pct">' + pct + '% · ' + Core.fmtMoney(c.sum) + '</span></div>';
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
      : '<div class="empty" style="padding:26px">还没有记录，点击「记一笔」添加第一笔</div>';

    var emptyGuide = state.txns.length ? '' :
      '<div class="card" style="text-align:center"><b>欢迎使用小账本</b>' +
      '<div class="muted small" style="margin:8px 0 4px">账本数据保存在本机，可随时导出备份</div></div>';

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
        '<button class="btn primary" data-action="nav:add"> 记一笔</button>' +
        '<button class="btn" data-action="nav:import"> 导入账单</button>' +
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
    if (mergedTargets && mergedTargets[t.id]) chips += '<span class="chip">含合并</span>';
    return '<div class="txn-item" data-action="txn:detail" data-id="' + esc(t.id) + '">' +
      '' +
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
          '<button class="cat-cell ' + (d.categoryId === selRoot.id ? 'active' : '') + '" data-action="add:pickCat" data-id="' + esc(selRoot.id) + '"><span>不细分</span></button>' +
          kids.map(function (k) {
            return '<button class="cat-cell ' + (d.categoryId === k.id ? 'active' : '') + '" data-action="add:pickCat" data-id="' + esc(k.id) + '">' +
              '<span>' + esc(k.name) + '</span></button>';
          }).join('') + '</div>';
      }
      catCells = '<div class="sec-head"><b>选择分类</b><button class="link small" data-action="nav:categories">管理</button></div>' +
        '<div class="cat-grid">' + cats.map(function (c) {
          return '<button class="cat-cell ' + (selRoot && selRoot.id === c.id ? 'active' : '') + '" data-action="add:pickCat" data-id="' + esc(c.id) + '">' +
            '<span>' + esc(c.name) + '</span></button>';
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
        '<span class="si-main">' + esc(a.name) + '</span>' +
        '<span class="small muted">' + Core.fmtMoney(Core.accountBalance(a, state.txns)) + '</span></button>';
    }).join('');
    openSheet(field === 'accountId' ? '选择账户' : '转入账户', rows || '<div class="empty">还没有账户</div>');
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
            '<span style="font-size:17px">' + (on ? '已选' : '未选') + '</span>' +
            '<div class="t-main"><div class="t-title">' + esc(txnTitle(t)) + '</div><div class="t-sub">' + esc(txnSub(t)) + '</div></div>' +
            '<div class="t-amt ' + (t.type === 'income' ? 'income' : t.type === 'transfer' ? 'transfer' : 'expense') + '">' + amtStr(t) + '</div></div>';
        }
        return txnRowHtml(t, mt);
      }).join('');
      return '<div class="day-head"><span>' + Core.fmtDateCN(g.date) + '</span><span>支出 ' + Core.fmtMoney(g.dayExpense) +
        (g.dayIncome ? ' · 收入 ' + Core.fmtMoney(g.dayIncome) : '') + '</span></div>' + rows;
    }).join('') : '<div class="empty">本月没有符合条件的记录</div>';

    var selBar = state.selectMode
      ? '<div class="card selection-toolbar">' +
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
        return '<option value="' + esc(c.id) + '"' + (f.category === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
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
          '<div class="map-row"><span class="muted">分类</span><span style="margin-left:auto">' + (txnCategory(t) ? esc(txnCategory(t).name) : '未分类') + '</span></div>') +
      '<div class="map-row"><span class="muted">商户/对方</span><span style="margin-left:auto">' + esc(t.merchant || '—') + '</span></div>' +
      '<div class="map-row"><span class="muted">备注</span><span style="margin-left:auto">' + esc(t.note || '—') + '</span></div>' +
      '<div class="map-row"><span class="muted">来源</span><span style="margin-left:auto">' + (t.source === 'manual' ? '手动记账' : '导入 · ' + (SOURCE_NAME[t.source] || t.source)) + '</span></div>';

    // 去重关系
    if (t.mappedTo) {
      var kept = state.txns.find(function (x) { return x.id === t.mappedTo; });
      rows += '<div class="dup-card"><b> 已合并记录</b><div class="dc-rows">本条与「' + esc(kept ? txnTitle(kept) + ' ' + Core.fmtMoney(kept.amount) : '?') +
        '」是同一笔钱，统计中只计一次。</div>' +
        '<button class="btn danger block" data-action="txn:undoMerge" data-id="' + esc(t.id) + '">撤销合并（恢复为两条独立记录）</button></div>';
    }
    var shadows = state.txns.filter(function (x) { return x.mappedTo === t.id; });
    shadows.forEach(function (s) {
      rows += '<div class="dup-card"><b> 已合并入本条</b><div class="dc-rows">' + esc(SOURCE_NAME[s.source] || s.source) + '：' +
        esc(txnTitle(s)) + ' ¥' + Core.fmtMoney(s.amount) + '（' + esc(s.date) + '，统计中不再重复计入）</div>' +
        '<button class="btn ghost block" data-action="txn:undoMerge" data-id="' + esc(s.id) + '">撤销这条合并</button></div>';
    });

    // V2.3.1 退款冲销关联
    if (t.type === 'income' && t.refundFlag) {
      if (t.refundOf) {
        var src = state.txns.find(function (x) { return x.id === t.refundOf; });
        rows += '<div class="dup-card" style="border-color:#dcfce7"><b>↩ 已冲销原支出</b>' +
          '<div class="dc-rows">关联「' + esc(src ? txnTitle(src) : '?') + ' ¥' + (src ? Core.fmtMoney(src.amount) : '?') + '」，本分类月支出已相应减少，本条不计入收入。</div>' +
          '<button class="btn ghost block" data-action="refund:unlink" data-id="' + esc(t.id) + '">撤销关联</button></div>';
      } else {
        var rfMatches = Core.matchRefunds(state.txns).filter(function (x) { return x.refund.id === t.id; });
        var cands = rfMatches.length ? rfMatches[0].candidates : [];
        rows += '<div class="dup-card"><b>↩ 退款冲销</b><div class="dc-rows">关联原支出后冲减其分类支出（而非计为收入）。</div>' +
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
        rows += '<div class="dup-card" style="border-color:#dcfce7"><b> 报销已闭环</b>' +
          '<div class="dc-rows">报销款 ¥' + Core.fmtMoney(closedIncome.amount) + '（' + esc(closedIncome.date) + '）已关联。本笔不计个人支出，报销款不计收入。</div>' +
          '<button class="btn ghost block" data-action="reim:unlink" data-id="' + esc(closedIncome.id) + '">撤销闭环</button></div>';
      } else if (t.reimburseFlag) {
        var sugg = Core.matchReimbursements(state.txns).suggestions.filter(function (s) {
          return s.candidates.some(function (c) { return c.id === t.id; });
        });
        rows += '<div class="dup-card"><b> 待报销</b><div class="dc-rows">本笔为垫付，待报销到账后关联冲销。</div>' +
          (sugg.length ? sugg.map(function (s) {
            return '<button class="btn block" style="margin-top:6px" data-action="reim:doLink" data-inc="' + esc(s.income.id) + '" data-exp="' + esc(t.id) + '">' +
              '关联报销款：' + esc(s.income.merchant || '收入') + ' ¥' + Core.fmtMoney(s.income.amount) + '（' + esc(s.income.date) + '）</button>';
          }).join('') : '') +
          '<button class="btn ghost block" style="margin-top:6px" data-action="reim:unmark" data-id="' + esc(t.id) + '">取消待报销标记</button></div>';
      } else {
        rows += '<button class="btn block" style="margin-bottom:10px" data-action="reim:mark" data-id="' + esc(t.id) + '"> 标记为待报销</button>';
      }
    }
    if (t.type === 'income' && t.reimburseOf) {
      var adv = state.txns.find(function (x) { return x.id === t.reimburseOf; });
      rows += '<div class="dup-card" style="border-color:#dcfce7"><b> 报销款</b>' +
        '<div class="dc-rows">已关联垫付「' + esc(adv ? txnTitle(adv) : '?') + '」，双方不计入收支统计。</div>' +
        '<button class="btn ghost block" data-action="reim:unlink" data-id="' + esc(t.id) + '">撤销关联</button></div>';
    }

    // V2.3.3 周期账标识
    if (t.recurringKey) {
      rows += '<div class="dup-card"><b> 周期账</b><div class="dc-rows">本笔由周期记账模板自动生成（' + esc(t.recurringKey) + '），可在「我的-周期记账」中撤销。</div></div>';
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
        id: cid, name: c ? c.name : '未分类', icon: c ? c.icon : '',
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
        '<div class="rank-row">' +
        '<span style="min-width:56px">' + esc(c.name) + '</span>' +
        '<span class="rr-bar"><i style="width:' + pct + '%;background:' + Charts.PALETTE[i % Charts.PALETTE.length] + '"></i></span>' +
        '<span class="rr-val">' + (state.statRank === 'count' ? c.count + ' 笔' : Core.fmtMoney(c.sum)) + '</span>' +
        '<span class="rr-cnt">' + (agg.expense ? (c.sum / agg.expense * 100).toFixed(1) + '%' : '') + '</span></div>' +
        budgetBar + '</div>';
    }).join('');

    var donutItems = catAgg.slice(0, 6).map(function (c) { return { label: c.name, value: c.sum }; });
    var legend = catAgg.slice(0, 6).map(function (c, i) {
      return '<div class="legend-item"><i style="background:' + Charts.PALETTE[i % Charts.PALETTE.length] + '"></i>' +
        '<span>' + esc(c.name) + '</span><span class="li-pct">' + (agg.expense ? (c.sum / agg.expense * 100).toFixed(1) : 0) + '%</span></div>';
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
  /* ---------- 使用说明：只渲染本机静态内容；搜索只替换结果，保留输入焦点 ---------- */
  function helpResultsHtml() {
    var guide = window.LedgerHelp;
    if (!guide) return '<div class="card">说明内容未加载，请刷新页面重试。</div>';
    var sections = guide.search(state.helpQuery);
    var count = '<div class="help-result-count" role="status" aria-live="polite" data-help-count>' +
      (state.helpQuery.trim() ? '找到 ' + sections.length + ' 个相关章节' : '共 ' + sections.length + ' 个章节 · 按需要查阅') + '</div>';
    if (!sections.length) return count + '<div class="card help-no-results"><b>没有找到相关说明</b>' +
      '<p>试试「导入」「现金余额」「汇率」或「复盘」，也可以清除搜索查看全部章节。</p>' +
      '<button class="btn" data-action="help:clear">清除搜索</button></div>';
    return count + sections.map(function (section) {
      var index = guide.sections.indexOf(section) + 1;
      return '<section class="card help-section" id="help-' + esc(section.id) + '" data-help-section="' + esc(section.id) + '">' +
        '<div class="help-section-head"><span class="help-section-num">' + String(index).padStart(2, '0') + '</span>' +
        '<div><h2 tabindex="-1">' + esc(section.title) + '</h2><p>' + esc(section.subtitle) + '</p></div></div>' +
        '<div class="help-items' + (section.ordered ? ' help-ordered' : '') + '">' + section.items.map(function (item, i) {
          var shortcut = item.route
            ? '<button class="link help-shortcut" data-action="nav:' + esc(item.route) + '"' +
              (!state.ready ? ' disabled title="先启动本地服务并刷新页面"' : '') + '>' + esc(item.label) + ' →</button>'
            : item.cardId ? knowledgeLinkHtml(item.cardId, item.label) : '';
          var content = '<p>' + esc(item.text) + '</p>' + shortcut;
          if (section.kind === 'faq') return '<details class="help-faq"' + (state.helpQuery.trim() ? ' open' : '') +
            '><summary>' + esc(item.title) + '</summary>' + content + '</details>';
          return '<div class="help-item">' + (section.ordered ? '<span class="help-step-num">' + (i + 1) + '</span>' : '') +
            '<div><h3>' + esc(item.title) + '</h3>' + content + '</div></div>';
        }).join('') + '</div>' +
        (section.note ? '<div class="help-note">' + esc(section.note) + '</div>' : '') + '</section>';
    }).join('');
  }

  function tplHelp() {
    var guide = window.LedgerHelp;
    var toc = guide ? guide.sections.map(function (section) {
      return '<button data-action="help:section" data-section="' + esc(section.id) + '">' + esc(section.title) + '</button>';
    }).join('') : '';
    return '<div class="help-page" data-help-page><div class="dash-head"><div>' +
      '<div class="dash-eyebrow">LEDGER / 使用说明</div><div class="dash-title">从第一笔记录到一次完整复盘</div>' +
      '<div class="small muted">第一次用按顺序走，遇到问题回来查。</div></div>' +
      '<span class="dash-chip">离线可读</span></div>' +
      (!state.ready ? '<div class="card help-note">账本数据尚未加载，说明仍可阅读。双击 <code>start.command</code> 启动本地服务，再刷新页面恢复操作。</div>' : '') +
      '<div class="help-start-grid">' +
      '<button class="card help-start" data-action="help:section" data-section="start"><span>01 / 首次使用</span><b>先把账本搭好</b><p>账户、持仓、风险评估与第一条建议</p></button>' +
      '<button class="card help-start" data-action="help:section" data-section="monthly"><span>02 / 每月维护</span><b>完成一次资产结账</b><p>核对余额、行情和当月快照</p></button>' +
      '<button class="card help-start" data-action="help:section" data-section="execution"><span>03 / 行动闭环</span><b>把决定和实际交易连起来</b><p>关联买入、确认执行、记录复盘</p></button></div>' +
      '<div class="help-search"><label for="help-search">查找操作说明</label>' +
      '<div><input id="help-search" type="search" maxlength="120" placeholder="搜索：导入、现金余额、汇率、复盘…"' +
      ' value="' + esc(state.helpQuery) + '" data-input="help:q"><button class="btn small" data-action="help:clear">清除</button></div></div>' +
      '<div class="help-layout"><aside class="card help-toc"><b>说明目录</b><nav aria-label="使用说明目录">' + toc + '</nav>' +
      '<div class="small muted">操作位置与页面名称一致<br>更新于 ' + esc(guide ? guide.updatedAt : '') + '</div></aside>' +
      '<div class="help-content" data-help-results>' + helpResultsHtml() + '</div></div>' +
      '<div class="help-footer">说明介绍产品操作与金额口径。每条建议的金额、数据日和缺口，请以对应页面的实际结果为准。</div></div>';
  }

  function updateHelpResults() {
    var results = $('[data-help-results]');
    if (results) results.innerHTML = helpResultsHtml();
  }

  function tplSettings() {
    var lock = state.settings.lock || { enabled: false };
    var txnCount = state.txns.length;
    return '<div class="page-title">我的</div>' +
      '<div class="set-group"><div class="sg-title">账本</div>' +
        setItem('账户管理', liveAccounts().length + ' 个账户', 'nav:accounts') +
        setItem('分类管理', state.categories.length + ' 个分类 · 支持二级', 'nav:categories') +
        setItem('导入账单', '微信 / 支付宝 / 银行流水', 'nav:import') +
        setItem('周期记账', (state.settings.recurring || []).length + ' 个模板', 'nav:recurring') +
        setItem('报销管理', '垫付标记 / 待报销清单', 'nav:reimburse') +
      '</div>' +
      '<div class="set-group"><div class="sg-title">预算与体检</div>' +
        setItem('预算管理', (state.settings.budgets && state.settings.budgets.total) ? '总预算 ¥' + Core.fmtMoney(state.settings.budgets.total) + '/月' : '月度总/分类预算', 'nav:budget') +
        setItem('消费体检', '月度报告 / 异常检测 / 订阅清单', 'nav:health') +
      '</div>' +
      '<div class="set-group"><div class="sg-title">数据安全</div>' +
        setItem('应用锁', lock.enabled ? '已开启（数据加密存储）' : '未开启', 'set:lock') +
        setItem('导出 JSON 备份', '全量数据，含 ' + txnCount + ' 笔交易', 'set:exportJson') +
        setItem('导出 CSV 明细', 'Excel 可直接打开', 'set:exportCsv') +
        setItem('从备份恢复', '选择 JSON 备份文件', 'set:restore') +
        setItem('清空所有数据', '需输入"清空"确认', 'set:clear') +
      '</div>' +
      '<div class="set-group"><div class="sg-title">关于</div>' +
        setItem('使用说明', '首次设置 / 月度结账 / 决策复盘 / 常见问题', 'nav:help') +
        setItem('隐私承诺', '零网络请求 · 数据仅存本机', 'set:privacy') +
        setItem('账单导出教程', '微信 / 支付宝 / 招行 / 中行', 'set:howto') +
        setItem('安装到主屏（PWA）', '浏览器菜单选择"安装应用/添加到主屏幕"', 'set:pwa') +
      '</div>' +
      '<div class="small muted" style="text-align:center;padding:10px 0">小账本 v' + APP_VERSION + ' · 本地优先记账</div>' +
      '<input type="file" id="file-restore" accept=".json,application/json" class="hidden">';
  }
  function setItem(title, sub, action) {
    return '<button class="set-item" data-action="' + action + '" style="width:100%;text-align:left">' +
      '<span class="si-main"><div>' + esc(title) + '</div><div class="si-sub">' + esc(sub) + '</div></span>' +
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
      return '<div class="set-item" style="' + (indent ? 'margin-left:22px;' : '') + '">' +
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
          '<span class="mr-key">' + esc(c.name) + (c.parentId ? '（二级）' : '') + '</span></div>';
      }).join('') + '</div>' +
      '<button class="btn primary block" data-action="cat:batchNecGo">应用到勾选分类</button>');
  }


  function categorySheet(cat, type) {
    var isNew = !cat;
    window._catIcon = cat ? cat.icon : '';
    // V2.3.4 父级分类 + V2.2.1 必要性
    var t = type || (cat ? cat.type : 'expense');
    var parentOpts = ['<option value="">（一级分类）</option>'].concat(
      state.categories.filter(function (c) {
        return c.type === t && !c.parentId && (!cat || c.id !== cat.id);
      }).map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (cat && cat.parentId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
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
      anomalyHtml = '<div class="card" style="text-align:center">' +
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
          '<div class="row"><b>' + (a.severity === 'red' ? '重点关注：' : '留意：') + ' ' + esc(ANOMALY_NAME[a.kind] || a.kind) + '</b>' +
          (marked ? '<span class="chip" style="margin-left:auto">' + (marked === 'ok' ? '已标记合理' : '已标记改进') + '</span>' : '') + '</div>' +
          '<div class="dc-rows">' + esc(a.message) + '</div>' + markBtns + '</div>';
      }).join('');
      if (!detect.anomalies.length) anomalyHtml = '<div class="card" style="text-align:center"><div class="muted" style="padding:6px 0">本月无异常消费，继续保持</div></div>';
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
      '<div class="card"><b> ' + ymLabel(state.ym) + ' 消费体检</b>' +
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
        return '<div class="anomaly ' + a.severity + '"><b>' + (a.severity === 'red' ? '重点关注：' : '留意：') + ' ' + esc(ANOMALY_NAME[a.kind] || a.kind) + '</b>' + mk + '<p>' + esc(a.message) + '</p></div>';
      }).join('') : '<p class="muted">本月无异常消费 </p>');
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
      '<h1> 小账本消费体检报告</h1><p class="muted">' + ymLabel(state.ym) + ' · 生成于 ' + new Date().toLocaleString('zh-CN') + ' · 本报告自包含、离线可看</p>' +
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
        '<span class="si-main"><div>' + esc(t.merchant || txnTitle(t)) + '</div>' +
        '<div class="si-sub">' + esc(t.date) + ' · 账龄 ' + age + ' 天' + (age > 30 ? ' · 超过30天' : '') + '</div></span>' +
        '<span style="font-weight:700">¥' + Core.fmtMoney(t.amount) + '</span>' +
        '<button class="btn small" style="margin-left:8px" data-action="reim:link" data-id="' + esc(t.id) + '">关联报销款</button></div>';
    }).join('');
    var suggestionHtml = m.suggestions.map(function (s) {
      return '<div class="dup-card"><b> 收入 ¥' + Core.fmtMoney(s.income.amount) + '（' + esc(s.income.date) + ' ' + esc(s.income.merchant || '未命名') + '）疑似报销款</b>' +
        '<div class="dc-rows">可关联的待报销垫付：' + s.candidates.map(function (c) {
          return '<button class="link" data-action="reim:doLink" data-inc="' + esc(s.income.id) + '" data-exp="' + esc(c.id) + '">' + esc(c.merchant || txnTitle(c)) + ' ¥' + Core.fmtMoney(c.amount) + '</button>';
        }).join(' / ') + '</div></div>';
    }).join('');
    var closedRows = state.txns.filter(function (t) { return t.type === 'income' && t.reimburseOf; }).map(function (inc) {
      var exp = state.txns.find(function (x) { return x.id === inc.reimburseOf; });
      return '<div class="map-row"><span class="mr-key"> ' + esc(exp ? (exp.merchant || txnTitle(exp)) : '?') + ' ↔ ' + esc(inc.merchant || '报销款') + '</span>' +
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
      return '<option value="' + esc(c.id) + '"' + (t.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
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
      '' +
      '<div style="margin-top:8px">' + (w.fileName ? '已选择：<b>' + esc(w.fileName) + '</b><div class="small muted">点击重新选择</div>' : '点击选择账单 CSV 文件') + '</div>' +
      '<div class="small muted" style="margin-top:8px">支持：微信账单 / 支付宝流水（UTF-8/GBK）/ 银行流水 CSV</div>' +
      '</div>' +
      '<input type="file" id="wiz-file" accept=".csv,text/csv" class="hidden">' +
      '<div id="wiz-parse-msg"></div>' +
      bankTpls +
      '<div class="small muted" style="padding:6px 4px"> 收到 XLSX/PDF 流水？请先在 Excel/Numbers 中另存为 CSV 再导入。</div>';
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
      ? '<div class="dup-card" style="border-color:#fecaca"><b> ' + p.errors.length + ' 行无法解析（已跳过）</b>' +
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
        return '<option value="' + esc(a.id) + '"' + (cur === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>';
      })).join('');
      return '<div class="map-row"><span class="mr-key" title="' + esc(m) + '">' + esc(m) + '</span>' +
        '<select data-change="wiz:accMap" data-key="' + esc(m) + '">' + opts + '</select></div>';
    }).join('');
    // 转账目标
    var transferNeeded = Object.keys(w.typeMapping).some(function (k) { return w.typeMapping[k] === 'transfer'; });
    var targetOpts = ['<option value="">（稍后由去重引擎/手动处理）</option>'].concat(liveAccounts().map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (w.transferTarget === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>';
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
      return '<div class="dup-card"><b> 自动合并</b><div class="dc-rows">' +
        esc(txnTitle(x.shadow)) + ' ¥' + Core.fmtMoney(x.shadow.amount) + '（' + (SOURCE_NAME[x.shadow.source] || x.shadow.source) + ' ' + x.shadow.date + '）<br>' +
        '→ 保留' + (SOURCE_NAME[x.kept.source] || x.kept.source) + '记录「' + esc(txnTitle(x.kept)) + '」（' + x.reason + '），银行记录不再计入统计</div></div>';
    }).join('');
    var transferHtml = m.transferPairs.map(function (x) {
      var desc = x.inc
        ? esc(txnTitle(x.inc)) + ' ¥' + Core.fmtMoney(x.inc.amount) + ' 与已有银行端记录配对，自动补齐转入账户，不计收支'
        : '银行端 ' + esc(txnTitle(x.bankRecord)) + ' ¥' + Core.fmtMoney(x.bankRecord.amount) + ' 补齐已有渠道提现/充值转账，不计收支';
      return '<div class="dup-card"><b> 识别为账户间转账</b><div class="dc-rows">' + desc + '</div></div>';
    }).join('');
    var confirmHtml = m.needConfirm.map(function (x, i) {
      var d = w.decisions[i];
      return '<div class="dup-card"><b> 疑似重复，请确认</b><div class="dc-rows">' +
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
      (b.warnings.length ? '<div class="dup-card" style="border-color:#fde68a"><b> 提示</b><div class="dc-rows">' + b.warnings.slice(0, 5).map(esc).join('<br>') + '</div></div>' : '') +
      '<div class="row" style="gap:10px"><button class="btn grow" data-action="wiz:back">上一步</button>' +
      '<button class="btn primary grow" data-action="wiz:apply">确认导入</button></div>';
  }

  function wizStep5() {
    var d = state.wiz.done;
    if (!d) return '';
    return '<div class="card" style="text-align:center"><b style="font-size:17px">导入完成</b>' +
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
        '<div class="dup-card" style="border-color:#fecaca"><b> 开启前请务必了解</b><div class="dc-rows">交易数据将使用 AES-GCM 加密存储。<b>密码只存在于你的记忆中，忘记密码 = 数据永远无法恢复。</b>建议先在「导出 JSON 备份」留存一份明文备份。</div></div>' +
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
    var d = todayDateStr();
    // 评估 / 目标 / 认可标的只存在服务端事实源，导出时一并取出（§10.5）
    Store.companionCollections().then(function (companion) {
      var backup = Core.createBackup(Object.assign({}, state, companion), APP_VERSION);
      download('ledger-backup-' + d + '.json', JSON.stringify(backup, null, 2), 'application/json');
      toast('已导出 JSON 备份（评估 ' + backup.riskAssessments.length + ' 条 · 目标 ' +
        backup.allocationTargets.length + ' 版 · 认可标的 ' + backup.approvedInstruments.length + ' 条）');
    }).catch(function (e) {
      toast('导出失败：' + ((e && e.message) || '无法读取事实源'), 'err');
    });
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
          COMPANION_KEYS.forEach(function (k) { before[k] = state[k]; });
          state.accounts = restored.accounts;
          state.categories = restored.categories;
          state.txns = restored.txns;
          state.settings = restored.settings;
          state.assets = Domain.normalizeAssets(restored.assets); // v1 备份 → 空集合（S1.1）
          // 备份里的评估 / 目标 / 认可标的是整份覆盖（旧备份缺键 → 空集合，不伪造默认值）
          COMPANION_KEYS.forEach(function (k) { state[k] = restored[k]; });
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
              COMPANION_KEYS.forEach(function (k) { state[k] = before[k]; });
              toast('恢复未完成，当前数据保持不变', 'err');
              render();
            }
          });
        }, true);
    });
  }

  function clearAllSheet() {
    openSheet('清空所有数据',
      '<div class="dup-card" style="border-color:#fecaca"><b> 此操作不可撤销</b><div class="dc-rows">将删除全部账户、分类、交易与设置。建议先「导出 JSON 备份」。</div></div>' +
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
      ' <b>零网络请求</b>：本应用不加载任何外部资源、无埋点、无统计上报，断网可完整使用（可在浏览器 DevTools Network 面板验证）。<br><br>' +
      ' <b>数据仅存本机</b>：全部数据保存在本机浏览器的 IndexedDB 中，不上传任何服务器。<br><br>' +
      ' <b>应用锁加密</b>：开启后交易数据经 PBKDF2 派生密钥 + AES-GCM 加密落盘，密码不落盘、不可找回。<br><br>' +
      ' <b>数据永不锁定</b>：随时可导出 JSON 全量备份与 CSV 明细，换浏览器/换电脑不丢数据。<br><br>' +
      ' <b>注意</b>：浏览器「清除站点数据」会清空 IndexedDB，请定期导出备份。</div>');
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
    'nav:help': function () { nav('help'); },
    'help:clear': function () {
      state.helpQuery = '';
      var input = $('#help-search');
      if (input) input.value = '';
      updateHelpResults();
      if (input) input.focus();
    },
    'help:section': function (el) {
      state.helpQuery = '';
      var input = $('#help-search');
      if (input) input.value = '';
      updateHelpResults();
      var section = document.getElementById('help-' + el.dataset.section);
      if (section) {
        section.scrollIntoView({ block: 'start' });
        var heading = section.querySelector('h2');
        if (heading) heading.focus({ preventScroll: true });
      }
    },
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

    // 5E-4 本地知识卡：只按已知 id 打开；未知 id 显式降级，不展示任何解释
    'know:open': function (el) {
      var id = el && el.dataset ? el.dataset.cardId : '';
      var card = (typeof window !== 'undefined' && window.Knowledge)
        ? window.Knowledge.getCard(id) : null;
      if (!card) {
        openSheet('知识卡',
          '<div class="small" data-know-missing>没有编号为「' + esc(id || '（空）') +
          '」的知识卡：此处不展示解释，也不据此给出任何判断。目录可能已更新，请刷新页面。</div>');
        return;
      }
      openSheet(card.title,
        '<div class="small muted" data-know-meta>解释版本 ' + esc(window.Knowledge.EXPLANATION_VERSION) +
        ' · 概念与规则说明，不含你的账户事实，也不构成投资建议。</div>' +
        '<div class="small" data-know-card="' + esc(card.id) + '" style="line-height:1.8;margin-top:8px;padding-bottom:14px">' +
        card.body.map(function (p) { return '<div style="margin-bottom:8px">' + esc(p) + '</div>'; }).join('') +
        '</div>');
    },

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
        return '<button class="cat-cell" data-action="list:applyCat" data-id="' + esc(c.id) + '"><span>' + esc(c.name) + '</span></button>';
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
      // 刚结完账回来要看到新快照，因此强制重拉一次
      ensureClosesLoaded(true);
    },

    // Phase 5B：风险评估与复评
    'nav:risk': function () { nav('risk'); },
    // Phase 5E-1：决策台摘要的复评入口 —— 只预置原因并跳到风险页，判定与写入仍在服务端。
    'risk:reassess': function (el) {
      state.riskDraft = { answers: {}, reason: (el && el.dataset.reason) || 'initial' };
      state.riskView = 'form';
      nav('risk');
    },
    'risk:retry': function () { ensureRiskCurrentLoaded(); },
    // Phase 5E-2：配置对照的重新读取（与风险摘要平行，不整页 render）
    'alloc:retry': function () { ensureAllocCurrentLoaded(); },
    'risk:start': function (el) {
      state.riskDraft = { answers: {}, reason: (el && el.dataset.reason) || 'initial' };
      state.riskView = 'form';
      render();
    },
    'risk:answer': function (el) {
      state.riskDraft.answers[el.dataset.q] = el.dataset.o;
    },
    'risk:submit': submitRiskAssessment,
    'risk:cancel': function () {
      // 草稿只存在于内存（§5.3）：离开即丢弃，不冒充已保存的评估
      state.riskView = 'list';
      state.riskDraft = { answers: {}, reason: 'initial' };
      render();
    },

    // Phase 5C：目标配置与认可标的映射
    'nav:targets': function () { nav('targets'); },
    'nav:decisions': function () { nav('decisions'); },
    'target:reload': function () { ensureTargetsLoaded(true); },
    'target:generate': generateTarget,
    // Phase 5D：只提交金额与引用绑定，判定与分配全部由服务端重算
    'advice:run': runAdvice,
    // Phase 6C：决策与待执行。状态判定与接受门禁都在服务端；页面只提交 intent + 理由。
    'dec:open': function (el) {
      var recId = el.dataset.recId;
      var item = state.advice && state.advice.id === recId ? state.advice : null;
      if (!item) { toast('找不到对应的建议，请重新生成后再决定', 'warn'); return; }
      openDecisionSheet(item);
    },
    'dec:submit': submitDecision,
    'dec:detail': function (el) { openDecisionDetail(el.dataset.id); },
    'dec:reload': function () { ensureDecisionsLoaded(true); },
    // Phase 6D：关联 / 解绑 / 确认执行 / 归档都是服务端命令，失败在弹层里就地显示
    'dec:link': function () { decisionLinkAction(); },
    'dec:unlink': function (el) { decisionUnlinkAction(el); },
    'dec:newtrade': function () { decisionNewTradeAction(); },
    'dec:event': function (el) { decisionEventAction(el); },
    'map:add': function (el) {
      var cls = el.dataset.cls;
      var pick = document.querySelector('#map-pick-' + cls);
      if (!pick || !pick.value) { toast('请选择要认可的标的', 'warn'); return; }
      var ids = mappingIdsFor(cls).map(function (r) { return r.instrumentId; });
      if (ids.indexOf(pick.value) >= 0) { toast('该标的已在此类别下', 'warn'); return; }
      ids.push(pick.value);
      mappingAction(cls, function () { return ids; });
    },
    'map:remove': function (el) {
      var cls = el.dataset.cls;
      mappingAction(cls, function (rows) {
        return rows.filter(function (r) { return r.id !== el.dataset.id; }).map(function (r) { return r.instrumentId; });
      });
    },
    'map:up': function (el) {
      var cls = el.dataset.cls;
      mappingAction(cls, function (rows) {
        var i = rows.map(function (r) { return r.id; }).indexOf(el.dataset.id);
        if (i <= 0) return rows.map(function (r) { return r.instrumentId; });
        var swap = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = swap;
        return rows.map(function (r) { return r.instrumentId; });
      });
    },
    'map:down': function (el) {
      var cls = el.dataset.cls;
      mappingAction(cls, function (rows) {
        var i = rows.map(function (r) { return r.id; }).indexOf(el.dataset.id);
        if (i < 0 || i >= rows.length - 1) return rows.map(function (r) { return r.instrumentId; });
        var swap = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = swap;
        return rows.map(function (r) { return r.instrumentId; });
      });
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
    /* ---------- Phase 4C：持仓与证券事件 ---------- */

    'holding:opening': holdingOpeningSheet,
    'holding:event': holdingEventSheet,
    'holding:saveOpening': function () {
      var accountId = $('#ho-acc').value;
      var instrumentId = $('#ho-inst').value;
      var quantity = $('#ho-qty').value.trim();
      if (!/^\d+(\.\d{1,8})?$/.test(quantity) || !(parseFloat(quantity) > 0)) {
        toast('期初数量必须是正数（最多 8 位小数）', 'warn'); return;
      }
      var payload = { accountId: accountId, instrumentId: instrumentId, quantity: quantity, asOf: $('#ho-date').value };
      var costText = $('#ho-cost').value.trim();
      if (costText) {
        var cost = Math.round(parseFloat(costText) * 100);
        if (!isFinite(cost) || cost < 0) { toast('成本格式不正确', 'warn'); return; }
        payload.costMinor = cost;
      }
      Store.createResource('portfolio-openings', payload).then(function (r) {
        closeSheet();
        toast(r && r.warning ? '已登记期初（标的分类未确认，正式估值会被阻塞）' : '已登记期初快照');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'holding:saveEvent': function () {
      var eventType = $('#he-type').value;
      var payload = {
        eventType: eventType,
        accountId: $('#he-acc').value,
        instrumentId: $('#he-inst').value,
        occurredAt: $('#he-date').value
      };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.occurredAt)) { toast('请选择事件日期', 'warn'); return; }
      function minorOf(id) {
        var text = $(id).value.trim();
        if (!text) return null;
        var v = Math.round(parseFloat(text) * 100);
        return isFinite(v) && v >= 0 ? v : NaN;
      }
      if (eventType === 'buy' || eventType === 'sell') {
        var qty = $('#he-qty').value.trim();
        if (!/^\d+(\.\d{1,8})?$/.test(qty) || !(parseFloat(qty) > 0)) {
          toast('买卖事件的数量必须是正数（最多 8 位小数）', 'warn'); return;
        }
        payload.quantity = qty;
        var price = minorOf('#he-price');
        var fee = minorOf('#he-fee');
        if (isNaN(price) || isNaN(fee)) { toast('价格 / 手续费格式不正确', 'warn'); return; }
        if (price != null) payload.priceMinor = price;
        if (fee != null) payload.feeMinor = fee;
      } else {
        var amount = minorOf('#he-amount');
        if (amount == null || isNaN(amount) || amount <= 0) {
          toast('分红 / 费用事件必须填写大于 0 的总额', 'warn'); return;
        }
        payload.amountMinor = amount;
      }
      // 追加式事实：带一次性幂等键防双击重复提交；真重放由服务端 duplicate_event 拒绝
      var idemKey = 'evt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      Store.createResource('security-events', payload, { idempotencyKey: idemKey }).then(function (r) {
        // 6D：从「新增买入并关联」进来时，交易保存成功后按返回的事件 id 继续关联。
        // 先取再清 —— closeSheet 会清掉 pending，避免之后的普通录入被误关联。
        var pending = state.decLinkPending;
        state.decLinkPending = null;
        closeSheet();
        toast(r && r.warning ? '事件已记录（标的分类未确认，正式估值会被阻塞）' : '事件已记录');
        var done = refreshAssets();
        if (!pending) return done;
        var newId = (r && r.item && r.item.id) || '';
        if (!newId) {
          toast('交易已保存，但没有拿到事件 id，可在决策详情里手动关联（不会重建交易）', 'warn');
          return done;
        }
        return done.then(function () {
          return Store.createDecisionLink(pending, { securityEventId: newId, note: '新增交易后按 id 关联' },
            { idempotencyKey: Core.newId('lnk') })
            .then(function () {
              toast('交易已记录并关联到该决策', 'ok');
              ensureDecisionsLoaded(true);
              if ($('#sheet-mask').classList.contains('hidden')) openDecisionDetail(pending);
            })
            .catch(function (e) {
              // 交易已经落库，只有关联失败：明确说明可重试，且重试不重建交易
              toast('交易已保存，但关联失败：' + ((e && e.message) || '未知错误') +
                '。可在决策详情里重新关联，不会重建这笔交易。', 'err');
            });
        });
      }).catch(function (e) {
        state.decLinkPending = null; // 交易没保存：不要把待关联留给下一次录入
        resourceFail(e);
      });
    },
    /* ---------- Phase 4D：行情（手动补价）与汇率自动更新 ---------- */

    'asset:quote': function (el) {
      assetQuoteSheet(el && el.dataset ? el.dataset.id : '');
    },
    'asset:saveQuote': function () {
      var instrumentId = $('#q-inst').value;
      var priceText = $('#q-price').value.trim();
      var priceMinor = Math.round(parseFloat(priceText) * 100);
      if (!priceText || !isFinite(priceMinor) || priceMinor <= 0) { toast('请输入大于 0 的收盘价', 'warn'); return; }
      var priceDate = $('#q-date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(priceDate)) { toast('请选择价格日', 'warn'); return; }
      Store.saveQuote({ instrumentId: instrumentId, priceMinor: priceMinor, priceDate: priceDate }).then(function () {
        closeSheet();
        toast('价格已登记（来源：手动）');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'market:toggleAuto': function () {
      var on = !(state.settings && state.settings.marketDataAutoRefresh === true);
      var settings = Object.assign({}, state.settings || {}, { marketDataAutoRefresh: on });
      Store.set('settings', settings).then(function () {
        toast(on ? '已开启启动时自动更新汇率' : '已关闭启动时自动更新汇率');
        return refreshAssets();
      }).catch(resourceFail);
    },
    'market:refresh': function (el) {
      var scope = el && el.dataset ? el.dataset.scope : '';
      var payload = scope ? { scopes: [scope] } : {};
      Store.refreshMarketData(payload).then(function (r) {
        var parts = [];
        ((r && r.scopes) || []).forEach(function (s) {
          var label = s.scope === 'fx' ? '汇率' : '行情';
          if (s.status === 'updated') parts.push(label + '更新 ' + s.updated + ' 项');
          else if (s.status === 'partial') parts.push(label + '部分更新（失败 ' + s.errors.length + ' 项）');
          else if (s.status === 'failed') parts.push(label + '更新失败（' + (s.errors[0] ? s.errors[0].code : 'unknown') + '）');
          else parts.push(label + '未更新（' + (s.reason || 'skipped') + '）');
        });
        toast(parts.join('；') || '刷新完成', r && r.ok ? 'ok' : 'warn');
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
          '<span class="si-main"><div>' + esc(inc.merchant || '收入') + '</div>' +
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
    'cat:save': function (el) {
      var id = el.dataset.id, type = el.dataset.type;
      var name = $('#cat-name').value.trim();
      if (!name) { toast('请填写分类名', 'warn'); return; }
      var kws = $('#cat-kw').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
      var icon = window._catIcon || '';
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
    // 收益归因：切换期初基准快照。只改本地选中项，重渲染后由 pickBaseline 优先采用；
    // 估值与归因都在前端按 Domain 单一实现重算，不向后端写任何东西。
    // G4E-1：切换后必须改读**新基准的封存快照明细**（异步读取，期间归因卡显示加载态），
    // 期初腿永远不按当前事实表重算。
    'attr:baseline': function (el) {
      state.baselineCloseId = el.value || null;
      state.attrSnap = { closeId: null, status: 'idle', payload: null, hashValid: null };
      render();
      ensureAttributionSnapshot(false);
    },
    'filter:type': function (el) { state.listFilters.type = el.value; render(); filterSheet(); },
    'filter:account': function (el) { state.listFilters.account = el.value; render(); filterSheet(); },
    'filter:category': function (el) { state.listFilters.category = el.value; render(); filterSheet(); },
    'wiz:typeMap': function (el) { state.wiz.typeMapping[el.dataset.key] = el.value; },
    'wiz:accMap': function (el) { state.wiz.accountMapping[el.dataset.key] = el.value; },
    'wiz:transferTarget': function (el) { state.wiz.transferTarget = el.value || null; },
    // Phase 6C：历史决策的状态筛选（只改本地视图，列表数据全部已在服务端响应里）
    'dec:filter': function (el) { state.decStateFilter = el.value; render(); },
    'dec:month': function (el) { state.decMonthFilter = el.value; render(); },
    'bm:col': function (el) {
      var w = state.wiz;
      w.customCols = w.customCols || {};
      w.customCols[el.dataset.k] = el.value;
    },
    'bm:dd': function (el) { state.wiz.dd = el.value || null; }
  };

  var inputs = {
    'help:q': function (el) { state.helpQuery = el.value; updateHelpResults(); },
    // 5D 金额输入只记在内存里：整页重绘（例如生成建议后）不丢用户刚打的数字
    'advice:amount': function (el) { state.adviceAmount = el.value; },
    // 6C 决定理由草稿：提交失败重绘弹层时不能丢用户已打的字
    'dec:note': function (el) { state.decNoteDraft = el.value; },
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
