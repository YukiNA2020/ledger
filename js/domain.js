/* 小账本 domain.js — v3 资产领域纯逻辑层（无 DOM / 无存储 / 无网络依赖，node 可单测）
 * Phase 1「资产领域基础」交付（ROADMAP.md）：
 *   - 资产账户、币种子账户、负债、保障权益、标的、持仓、报价与汇率的领域对象；
 *   - CNY/HKD/USD 定点折算与总资产/净资产/资金池/风险类别聚合；
 *   - 余额/价格/汇率/分类的新鲜度与完整性状态。
 * 约定（ARCHITECTURE.md §5.5 / DECISIONS A-006）：
 *   - 金额以对应币种最小单位整数（分）存储；数量与汇率用定点十进制字符串，禁止浮点承担账务；
 *   - balanceMinor = null 表示没有明确余额；0 表示已确认余额确实为零；
 *   - 无内部时钟：now 由调用方传入（'YYYY-MM-DD'），相同输入必须产生相同输出；
 *   - 缺失/过期数据返回状态码（blockers），绝不按 0、1:1 或"最新"静默兜底。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Domain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CURRENCIES = ['CNY', 'HKD', 'USD'];       // D-008：MVP 仅三币种，CNY 为汇总币种
  var POOLS = ['safety', 'investable', 'restricted'];
  var RISK_CLASSES = ['cash', 'fixed_income', 'broad_equity', 'theme_equity', 'stock', 'other'];
  var MAX_STALE_DAYS = 5;                        // A-004：行情与汇率默认最多 5 个自然日陈旧
  var MAX_SCALE = 8;                             // 定点十进制最大小数位
  var ASSET_KEYS = ['assetAccounts', 'assetUnits', 'assetTransfers', 'liabilities', 'entitlements', 'instruments', 'holdings', 'quotes', 'fxRates'];

  /* ------------------------------ 定点十进制 ------------------------------ */

  // "10" → {v:10,s:0}；"10.55" → {v:1055,s:2}；非法/负数/超精度 → null
  function parseDecimal(str) {
    if (str == null) return null;
    var s = String(str).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    var dot = s.indexOf('.');
    var scale = dot === -1 ? 0 : s.length - dot - 1;
    if (scale > MAX_SCALE) return null;
    var v = Number(dot === -1 ? s : s.replace('.', ''));
    if (!isFinite(v)) return null;
    return { v: v, s: scale };
  }

  // num/den 四舍五入取整（num 可为负，.5 远离零进位）
  function divRound(num, den) {
    var neg = num < 0;
    if (neg) num = -num;
    var q = Math.floor(num / den);
    var rem = num - q * den;
    if (rem * 2 >= den) q += 1;
    return neg ? -q : q;
  }

  // quantity(定点字符串) × priceMinor(最小单位整数) → 最小单位整数，超出部分四舍五入
  function mulMinor(quantity, priceMinor) {
    var q = parseDecimal(quantity);
    if (!q || typeof priceMinor !== 'number' || !isFinite(priceMinor)) return null;
    var num = q.v * Math.round(priceMinor);
    if (num > Number.MAX_SAFE_INTEGER) return null;
    return q.s === 0 ? num : divRound(num, Math.pow(10, q.s));
  }

  // minor(最小单位整数) × rateDecimal(定点字符串) → 最小单位整数
  function mulByRate(minor, rateDecimal) {
    var r = parseDecimal(rateDecimal);
    if (!r || typeof minor !== 'number' || !isFinite(minor)) return null;
    var num = Math.round(minor) * r.v;
    if (num > Number.MAX_SAFE_INTEGER) return null;
    return r.s === 0 ? num : divRound(num, Math.pow(10, r.s));
  }

  /* ------------------------------ 日期与新鲜度 ------------------------------ */

  // 'YYYY-MM-DD' 之间的自然日差（b − a）
  function daysBetween(a, b) {
    if (!a || !b) return null;
    var pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a), pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
    if (!pa || !pb) return null;
    var ua = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]), ub = Date.UTC(+pb[1], +pb[2] - 1, +pb[3]);
    return Math.round((ub - ua) / 86400000);
  }

  // dateStr 距 now 超过 maxDays 个自然日（或缺失/非法）视为陈旧
  function isStaleDays(dateStr, now, maxDays) {
    var d = daysBetween(dateStr, now);
    return d == null || d > maxDays;
  }

  function ymOf(dateStr) {
    return typeof dateStr === 'string' && dateStr.length >= 7 ? dateStr.slice(0, 7) : null;
  }

  /* ------------------------------ 汇率与报价 ------------------------------ */

  // 取币对最近一条汇率；无 → null；有但超 5 个自然日 → status 'fx_stale'（估值仍可用）
  function findFxRate(fxRates, base, quote, now) {
    var best = null;
    (fxRates || []).forEach(function (r) {
      if (!r || r.base !== base || r.quote !== quote) return;
      if (!parseDecimal(r.rateDecimal)) return;
      if (!best || String(r.rateDate || '') > String(best.rateDate || '')) best = r;
    });
    if (!best) return null;
    return {
      rateDecimal: best.rateDecimal,
      rateDate: best.rateDate || null,
      provider: best.provider || null,
      status: isStaleDays(best.rateDate, now, MAX_STALE_DAYS) ? 'fx_stale' : 'ok'
    };
  }

  // minor 由 from 币种折算为 to 币种。缺失汇率返回 {valueMinor:null,status:'missing_fx'}，不按 1:1 兜底。
  function convertMinor(minor, from, to, fxRates, now) {
    if (from === to) return { valueMinor: minor, status: 'ok' };
    var r = findFxRate(fxRates, from, to, now);
    if (!r) return { valueMinor: null, status: 'missing_fx' };
    var v = mulByRate(minor, r.rateDecimal);
    if (v == null) return { valueMinor: null, status: 'missing_fx' };
    return { valueMinor: v, status: r.status };
  }

  // 取标的价格日最近的一条报价；无 → null；过期 → status 'quote_stale'
  function findQuote(quotes, instrumentId, now) {
    var best = null;
    (quotes || []).forEach(function (q) {
      if (!q || q.instrumentId !== instrumentId) return;
      if (!best || String(q.priceDate || '') > String(best.priceDate || '')) best = q;
    });
    if (!best) return null;
    return {
      priceMinor: best.priceMinor,
      currency: best.currency,
      priceDate: best.priceDate || null,
      provider: best.provider || null,
      status: isStaleDays(best.priceDate, now, MAX_STALE_DAYS) ? 'quote_stale' : 'ok'
    };
  }

  /* ------------------------------ 领域对象默认值 ------------------------------ */

  function emptyAssets() {
    var a = { schemaVersion: 1 };
    ASSET_KEYS.forEach(function (k) { a[k] = []; });
    return a;
  }

  // 对任意输入（旧备份、缺键、脏数据）补全为合法 v3 资产集合
  function normalizeAssets(raw) {
    var a = emptyAssets();
    if (!raw || typeof raw !== 'object') return a;
    ASSET_KEYS.forEach(function (k) { a[k] = Array.isArray(raw[k]) ? raw[k] : []; });
    return a;
  }

  /* ------------------------------ 总览计算 ------------------------------ */

  // computeOverview(assets, { now, settings })
  //   now：'YYYY-MM-DD'（必传，固定时钟）；
  //   settings.safetyTargetMinor：安全储备目标（分，可缺省 → 缺口按 0 并列入待办）。
  // 返回口径见 ARCHITECTURE.md §6。估值状态：empty / estimate / formal；
  // 仅当无任何数据缺失/过期/未确认时为 formal（canAdvise = true）。
  function computeOverview(assets, opts) {
    if (!opts || !opts.now) throw new Error('computeOverview 需要 now 参数（YYYY-MM-DD）');
    var now = opts.now;
    var a = normalizeAssets(assets);
    var settings = opts.settings || {};

    var accountMap = {}, instrumentMap = {};
    a.assetAccounts.forEach(function (x) { if (x && x.id) accountMap[x.id] = x; });
    a.instruments.forEach(function (x) { if (x && x.id) instrumentMap[x.id] = x; });

    var blockers = [], todos = [];
    function addBlocker(code, detail) {
      var key = code + '|' + (detail || '');
      for (var i = 0; i < blockers.length; i++) {
        if (blockers[i].code + '|' + blockers[i].detail === key) return;
      }
      blockers.push({ code: code, detail: detail || '' });
    }
    function hasBlocker(code) {
      return blockers.some(function (b) { return b.code === code; });
    }

    var pools = { safety: 0, investable: 0, restricted: 0 };
    var riskValue = {};
    RISK_CLASSES.forEach(function (c) { riskValue[c] = 0; });
    var totalAssets = 0, totalLiabilities = 0, investableCash = 0, duePayables = 0;
    var entitlementView = [];
    var hasAnyData = a.assetUnits.length > 0 || a.holdings.length > 0 || a.liabilities.length > 0;

    function convertFor(minor, currency, label) {
      var conv = convertMinor(minor, currency, 'CNY', a.fxRates, now);
      if (conv.status === 'missing_fx') { addBlocker('fx_missing', currency); return null; }
      if (conv.status === 'fx_stale') addBlocker('fx_stale', currency);
      return conv.valueMinor;
    }

    /* 现金与明确余额单元 */
    a.assetUnits.forEach(function (u) {
      if (!u) return;
      var acct = accountMap[u.accountId];
      var pool = acct && POOLS.indexOf(acct.pool) !== -1 ? acct.pool : null;
      if (!pool) addBlocker('pool_missing', (acct && acct.name) || u.accountId || '');
      if (u.balanceMinor == null) {
        addBlocker('balance_missing', (acct && acct.name) || u.accountId || ''); // 无明确余额：不参与合计，不按 0 处理
        return;
      }
      if (ymOf(u.asOf) !== ymOf(now)) addBlocker('balance_stale', (acct && acct.name) || u.accountId || ''); // A-005
      var value = convertFor(u.balanceMinor, u.currency);
      if (value == null) return;
      totalAssets += value;
      if (pool) pools[pool] += value;
      if (pool === 'investable') {
        investableCash += value;
        riskValue.cash += value;
      }
    });

    /* 持仓估值 */
    a.holdings.forEach(function (h) {
      if (!h) return;
      var ins = instrumentMap[h.instrumentId];
      if (!ins) { addBlocker('instrument_missing', h.instrumentId || ''); return; }
      var acct = accountMap[h.accountId];
      var pool = acct && POOLS.indexOf(acct.pool) !== -1 ? acct.pool : null;
      if (!pool) addBlocker('pool_missing', (acct && acct.name) || h.accountId || '');
      var q = findQuote(a.quotes, h.instrumentId, now);
      if (!q) { addBlocker('quote_missing', ins.symbol || h.instrumentId || ''); return; }
      if (q.status === 'quote_stale') addBlocker('quote_stale', ins.symbol || '');
      var minor = mulMinor(h.quantity, q.priceMinor);
      if (minor == null) { addBlocker('holding_invalid', ins.symbol || ''); return; }
      var value = convertFor(minor, q.currency);
      if (value == null) return;
      totalAssets += value;
      if (pool) pools[pool] += value;
      if (pool === 'investable') {
        var cls = RISK_CLASSES.indexOf(ins.assetClass) !== -1 ? ins.assetClass : 'other';
        if (cls === 'other' && ins.assetClass) addBlocker('asset_class_invalid', ins.symbol || '');
        riskValue[cls] += value;
      }
      if (ins.classificationStatus !== 'confirmed') addBlocker('classification_unconfirmed', ins.symbol || '');
    });

    /* 负债与近期应付款 */
    a.liabilities.forEach(function (l) {
      if (!l) return;
      if (l.balanceMinor == null) { addBlocker('liability_missing', l.name || ''); return; }
      if (ymOf(l.asOf) !== ymOf(now)) addBlocker('balance_stale', l.name || '');
      var value = convertFor(l.balanceMinor, l.currency);
      if (value == null) return;
      totalLiabilities += value; // 负债单独累计，不冲减总资产
      if (l.termType === 'current') duePayables += value;
    });

    /* 保障权益：只展示状态，不进入任何金额合计（D-011） */
    a.entitlements.forEach(function (e) {
      if (!e) return;
      entitlementView.push({
        id: e.id || null,
        name: e.name || '',
        kind: e.kind || '',
        status: e.status || '',
        balanceMinor: e.balanceMinor == null ? null : e.balanceMinor,
        asOf: e.asOf || null
      });
    });

    /* 安全储备缺口与可新增投资资金（D-012） */
    var safetyTarget = typeof settings.safetyTargetMinor === 'number' && isFinite(settings.safetyTargetMinor)
      ? settings.safetyTargetMinor : null;
    var safetyGap = safetyTarget == null ? 0 : Math.max(0, safetyTarget - pools.safety);
    if (safetyTarget == null && hasAnyData) todos.push({ code: 'safety_target_unset' });
    var newFunds = Math.max(0, investableCash - duePayables - safetyGap);

    var isEmpty = ASSET_KEYS.every(function (k) { return a[k].length === 0; });
    var valuationStatus = isEmpty ? 'empty' : (blockers.length ? 'estimate' : 'formal');

    return {
      asOf: now,
      isEmpty: isEmpty,
      valuationStatus: valuationStatus,
      totalAssetsMinor: totalAssets,
      totalLiabilitiesMinor: totalLiabilities,
      netWorthMinor: totalAssets - totalLiabilities,
      pools: {
        safetyMinor: pools.safety,
        investableMinor: pools.investable,
        restrictedMinor: pools.restricted
      },
      investableCashMinor: investableCash,
      riskClasses: RISK_CLASSES.map(function (c) {
        return {
          assetClass: c,
          valueMinor: riskValue[c],
          pct: pools.investable > 0 ? Math.round(riskValue[c] / pools.investable * 1000) / 10 : null
        };
      }),
      newFundsAvailableMinor: newFunds,
      duePayablesMinor: duePayables,
      safetyTargetMinor: safetyTarget,
      safetyGapMinor: safetyGap,
      freshness: {
        balanceStale: hasBlocker('balance_stale'),
        quoteStale: hasBlocker('quote_stale'),
        fxStale: hasBlocker('fx_stale'),
        classificationUnconfirmed: hasBlocker('classification_unconfirmed')
      },
      blockers: blockers,
      todos: todos,
      canAdvise: valuationStatus === 'formal',
      entitlements: entitlementView
    };
  }

  /* ------------------------------ 月度结账（Phase 3） ------------------------------ */

  // computeCloseChecklist(assets, { now }) → 本月结账核对清单与可追溯事实。
  //   now：'YYYY-MM-DD'（结账数据截止日，必传）；复用 computeOverview 的全部口径，
  //   不另写一套判断，保证"估算/正式"在决策台与月结页永远一致。
  // 返回：
  //   month / asOf / valuationStatus / canComplete（无任何缺项才可正式结账）
  //   items：按阻塞码聚合的核对条目 [{code, detail, count}]（空数组 = 全部核对通过）
  //   facts：单元级事实（余额/负债/持仓逐条带币种、日期与折算值），用于追溯每个金额
  function computeCloseChecklist(assets, opts) {
    if (!opts || !opts.now) throw new Error('computeCloseChecklist 需要 now 参数（YYYY-MM-DD）');
    var now = opts.now;
    var month = ymOf(now);
    var a = normalizeAssets(assets);
    var ov = computeOverview(a, opts);

    var accountMap = {};
    a.assetAccounts.forEach(function (x) { if (x && x.id) accountMap[x.id] = x; });
    var instrumentMap = {};
    a.instruments.forEach(function (x) { if (x && x.id) instrumentMap[x.id] = x; });

    function acctName(id) { return (accountMap[id] && accountMap[id].name) || id || ''; }
    function confirmed(asOf) { return ymOf(asOf) === month; }

    /* 单元级事实：余额 */
    var unitFacts = a.assetUnits.map(function (u) {
      if (!u) return null;
      var conv = convertMinor(u.balanceMinor, u.currency, 'CNY', a.fxRates, now);
      return {
        kind: 'unit',
        id: u.id || null,
        account: acctName(u.accountId),
        currency: u.currency || null,
        balanceMinor: u.balanceMinor == null ? null : u.balanceMinor,
        asOf: u.asOf || null,
        confirmed: u.balanceMinor != null && confirmed(u.asOf),
        valueCnyMinor: conv.status === 'missing_fx' ? null : conv.valueMinor,
        valueStatus: conv.status
      };
    }).filter(Boolean);

    /* 单元级事实：负债 */
    var liabilityFacts = a.liabilities.map(function (l) {
      if (!l) return null;
      var conv = convertMinor(l.balanceMinor, l.currency, 'CNY', a.fxRates, now);
      return {
        kind: 'liability',
        id: l.id || null,
        name: l.name || '',
        currency: l.currency || null,
        balanceMinor: l.balanceMinor == null ? null : l.balanceMinor,
        asOf: l.asOf || null,
        termType: l.termType || null,
        confirmed: l.balanceMinor != null && confirmed(l.asOf),
        valueCnyMinor: conv.status === 'missing_fx' ? null : conv.valueMinor,
        valueStatus: conv.status
      };
    }).filter(Boolean);

    /* 单元级事实：持仓估值 */
    var holdingFacts = a.holdings.map(function (h) {
      if (!h) return null;
      var ins = instrumentMap[h.instrumentId];
      var q = findQuote(a.quotes, h.instrumentId, now);
      var minor = q ? mulMinor(h.quantity, q.priceMinor) : null;
      var conv = minor == null ? { valueMinor: null, status: 'missing_quote' }
        : convertMinor(minor, q.currency, 'CNY', a.fxRates, now);
      return {
        kind: 'holding',
        id: h.id || null,
        symbol: ins ? ins.symbol : null,
        instrumentId: h.instrumentId || null,
        accountId: h.accountId || null,
        account: acctName(h.accountId),
        quantity: h.quantity || null,
        priceMinor: q ? q.priceMinor : null,
        priceCurrency: q ? q.currency : null,
        priceDate: q ? q.priceDate : null,
        priceStatus: q ? q.status : 'missing_quote',
        asOf: h.asOf || null,
        valueMinor: minor,
        valueCnyMinor: conv.status === 'missing_fx' ? null : conv.valueMinor,
        valueStatus: conv.status
      };
    }).filter(Boolean);

    /* 阻塞码聚合：每条 = 一类待核对项 */
    var seen = {};
    var items = [];
    ov.blockers.forEach(function (b) {
      var key = b.code + '|' + b.detail;
      if (seen[key]) { seen[key].count += 1; return; }
      seen[key] = { code: b.code, detail: b.detail || '', count: 1 };
      items.push(seen[key]);
    });

    var counts = {
      units: unitFacts.length,
      unitsConfirmed: unitFacts.filter(function (u) { return u.confirmed; }).length,
      liabilities: liabilityFacts.length,
      liabilitiesConfirmed: liabilityFacts.filter(function (l) { return l.confirmed; }).length,
      holdings: holdingFacts.length,
      holdingsPriced: holdingFacts.filter(function (h) { return h.valueMinor != null; }).length
    };

    return {
      month: month,
      asOf: now,
      valuationStatus: ov.valuationStatus,
      canComplete: ov.valuationStatus === 'formal',
      items: items,
      counts: counts,
      facts: {
        units: unitFacts,
        liabilities: liabilityFacts,
        holdings: holdingFacts,
        entitlements: ov.entitlements
      }
    };
  }

  // emergencyCoverageMonths(safetyMinor, avgNecessaryMinor) → 应急金覆盖月数。
  //   安全储备 ÷ 月均必要支出，保留 1 位小数；无法估算（必要支出为 0/非法或储备未知）→ null。
  function emergencyCoverageMonths(safetyMinor, avgNecessaryMinor) {
    if (typeof safetyMinor !== 'number' || !isFinite(safetyMinor)) return null;
    if (typeof avgNecessaryMinor !== 'number' || !isFinite(avgNecessaryMinor) || avgNecessaryMinor <= 0) return null;
    return Math.round((safetyMinor / avgNecessaryMinor) * 10) / 10;
  }

  return {
    CURRENCIES: CURRENCIES,
    POOLS: POOLS,
    RISK_CLASSES: RISK_CLASSES,
    MAX_STALE_DAYS: MAX_STALE_DAYS,
    parseDecimal: parseDecimal,
    mulMinor: mulMinor,
    mulByRate: mulByRate,
    daysBetween: daysBetween,
    isStaleDays: isStaleDays,
    ymOf: ymOf,
    findFxRate: findFxRate,
    convertMinor: convertMinor,
    findQuote: findQuote,
    emptyAssets: emptyAssets,
    normalizeAssets: normalizeAssets,
    computeOverview: computeOverview,
    computeCloseChecklist: computeCloseChecklist,
    emergencyCoverageMonths: emergencyCoverageMonths
  };
});
