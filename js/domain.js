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
  var ASSET_KEYS = ['assetAccounts', 'assetUnits', 'assetTransfers', 'liabilities', 'entitlements', 'instruments', 'holdings', 'quotes', 'fxRates', 'securityEvents'];

  // Phase 4B：风险敞口市场词表。属于**用户判断**，provider 不提供（D-037）；
  // 与「交易币种（CNY/HKD/USD）」是两个不同字段，不得相互推断替代（AGENTS.md）。
  var EXPOSURE_MARKETS = ['CN', 'HK', 'US', 'global', 'other'];

  // Phase 4C：证券事件类型（D-042）。
  //   buy/sell 改变持有数量；dividend/fee 只产生金额事实、不改数量。
  var SECURITY_EVENT_TYPES = ['buy', 'sell', 'dividend', 'fee'];

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

  /* ---------------------- 定点数量比较与累加（Phase 4C，D-042） ---------------------- */

  // 规范化定点字符串：去掉小数尾随 0（"10.5000" → "10.5"，"11.0" → "11"）。
  // 只处理非负整数部分的 {v, s}（持仓数量不可能为负：卖出超额在写入路径就被拒绝）。
  function formatDecimal(v, s) {
    var str = String(v);
    if (s > 0) {
      while (str.length <= s) str = '0' + str;
      str = str.slice(0, str.length - s) + '.' + str.slice(str.length - s);
      str = str.replace(/0+$/, '').replace(/\.$/, '');
    }
    return str;
  }

  // 两个定点数（字符串或 {v,s}）精确比较：a<b → -1，a>b → 1，相等 → 0，任一非法 → null。
  // 对齐到较大小数位后按整数比较，绝不经过浮点。
  function compareDecimals(a, b) {
    var da = a && typeof a === 'object' ? a : parseDecimal(a);
    var db = b && typeof b === 'object' ? b : parseDecimal(b);
    if (!da || !db) return null;
    var s = Math.max(da.s, db.s);
    var av = da.v * Math.pow(10, s - da.s);
    var bv = db.v * Math.pow(10, s - db.s);
    if (av > Number.MAX_SAFE_INTEGER || bv > Number.MAX_SAFE_INTEGER) return null;
    return av === bv ? 0 : av < bv ? -1 : 1;
  }

  // 定点数量求和：返回规范化十进制字符串；任一项非法 → null；空列表 → "0"。
  function sumQuantities(list) {
    var scale = 0;
    var parsed = [];
    (Array.isArray(list) ? list : []).forEach(function (q) {
      var d = q && typeof q === 'object' ? q : parseDecimal(q);
      if (!d) { parsed = null; return; }
      if (d.s > scale) scale = d.s;
      parsed.push(d);
    });
    if (!parsed) return null;
    var total = 0;
    for (var i = 0; i < parsed.length; i++) {
      total += parsed[i].v * Math.pow(10, scale - parsed[i].s);
    }
    if (total > Number.MAX_SAFE_INTEGER) return null;
    return formatDecimal(total, scale);
  }

  // 定点数量相减（a − b，两者都必须是非负定点字符串）：返回规范化字符串，任一非法 → null。
  function subtractQuantities(aStr, bStr) {
    var da = parseDecimal(aStr);
    var db = parseDecimal(bStr);
    if (!da || !db) return null;
    var s = Math.max(da.s, db.s);
    var av = da.v * Math.pow(10, s - da.s);
    var bv = db.v * Math.pow(10, s - db.s);
    if (av > Number.MAX_SAFE_INTEGER || bv > Number.MAX_SAFE_INTEGER) return null;
    return formatDecimal(av - bv, s);
  }

  // 持仓的身份键：一个 (账户, 标的) 一行持有事实（D-042）。键的拼法只有这一处实现，
  // deriveHoldings 与 holdingsAsOf 共用，避免两处各写一份字符串拼接后悄悄分叉。
  function holdingKey(accountId, instrumentId) {
    return String(accountId) + '|' + String(instrumentId);
  }

  /* ------------------------------ 持仓推导（Phase 4C，D-042/D-025） ------------------------------ */

  // deriveHoldings(openings, events, options) — 持有数量的**唯一推导实现**：
  //   数量 = 期初快照数量 + Σ买入 − Σ卖出（分红/费用不改数量；买入可以没有期初快照，从 0 起算）。
  //   事件按 occurred_at 升序重放（同日按传入顺序，保证确定性）；
  //   日期边界（G4C-4）：occurredAt 严格早于期初快照 asOf 的事件视为已含在快照内，
  //   不再叠加也不进 counts（跳过的事件记入 holding.boundarySkippedEvents 供追溯）。
  //   任一 (accountId, instrumentId) 至多一行期初：同键多行时取 asOf 最新一行（接口路径不允许出现，
  //   这里只对历史/手工数据的形状做确定性防御）。
  // options.strict = true：卖出超过当时推导数量 → 抛 {code:'insufficient_holdings'}（服务端写前校验用）；
  // 默认宽松模式：跳过该笔卖出并把它记入 holding.oversellEvents，供总览防御性展示。
  // 返回 { holdings: [...], invalidEvents: [eventId...] }：
  //   holding = { accountId, instrumentId, quantity(规范化十进制字符串),
  //               openingId, openingQuantity, openingCostMinor, openingAsOf,
  //               firstActivityAt, lastEventAt, counts:{buy,sell,dividend,fee},
  //               oversellEvents }
  function deriveHoldings(openings, events, options) {
    var opts = options || {};
    var strict = opts.strict === true;
    var openList = Array.isArray(openings) ? openings : [];
    var evList = Array.isArray(events) ? events : [];

    var map = {};
    var order = [];
    var keyOf = holdingKey;
    function holdingFor(accountId, instrumentId) {
      var key = keyOf(accountId, instrumentId);
      if (!map[key]) {
        map[key] = {
          accountId: accountId,
          instrumentId: instrumentId,
          quantity: '0',
          openingId: null,
          openingQuantity: null,
          openingCostMinor: null,
          openingAsOf: null,
          firstActivityAt: null,
          lastEventAt: null,
          counts: { buy: 0, sell: 0, dividend: 0, fee: 0 },
          oversellEvents: [],
          boundarySkippedEvents: []
        };
        order.push(key);
      }
      return map[key];
    }

    openList.forEach(function (o) {
      if (!o || !o.accountId || !o.instrumentId) return;
      var d = parseDecimal(o.quantity);
      if (!d) return; // 非法期初数量：写入路径已拒绝，这里防御性忽略
      var h = holdingFor(o.accountId, o.instrumentId);
      var newer = h.openingAsOf == null || String(o.asOf || '') >= String(h.openingAsOf);
      if (newer) {
        h.quantity = formatDecimal(d.v, d.s);
        h.openingId = o.id || null;
        h.openingQuantity = formatDecimal(d.v, d.s);
        h.openingCostMinor = typeof o.costMinor === 'number' ? o.costMinor : null;
        h.openingAsOf = o.asOf || null;
      }
    });

    var invalidEvents = [];
    var indexed = [];
    evList.forEach(function (e, idx) {
      indexed.push({ e: e, idx: idx });
    });
    // 按 occurred_at 升序、同日保持传入顺序（稳定排序）
    indexed.sort(function (a, b) {
      var da = String((a.e && a.e.occurredAt) || '');
      var db = String((b.e && b.e.occurredAt) || '');
      if (da !== db) return da < db ? -1 : 1;
      return a.idx - b.idx;
    });

    indexed.forEach(function (slot) {
      var e = slot.e;
      if (!e || !e.accountId || !e.instrumentId) { invalidEvents.push(e && e.id ? e.id : null); return; }
      var type = e.eventType;
      if (SECURITY_EVENT_TYPES.indexOf(type) === -1) { invalidEvents.push(e.id || null); return; }
      // 先验证后建条目：非法事件绝不留下空的持仓对象
      var qty = null;
      if (type === 'buy' || type === 'sell') {
        qty = parseDecimal(e.quantity);
        if (!qty || !(qty.v > 0)) { invalidEvents.push(e.id || null); return; }
      }
      var h = holdingFor(e.accountId, e.instrumentId);
      // 日期边界（D-042 ①，复核 G4C-4）：occurredAt **严格早于**期初快照 asOf 的事件视为
      // 已包含在快照数量内，不再叠加，也不进 counts / 活动时间戳——否则"期初 10（09-06）
      // + 09-01 买入 2"会重复计成 12。期初快照数量口径 = 期初日日初数量，期初日**当天**及
      // 之后的事件正常计入（"今天录期初、今天再记账"不受影响）。跳过的事件记入
      // boundarySkippedEvents 供追溯，绝不静默。
      if (
        h.openingAsOf != null &&
        e.occurredAt &&
        String(e.occurredAt) < String(h.openingAsOf)
      ) {
        h.boundarySkippedEvents.push(e.id || null);
        return;
      }
      if (type === 'buy') {
        h.quantity = sumQuantities([h.quantity, e.quantity]);
        h.counts.buy += 1;
      } else if (type === 'sell') {
        var cmp = compareDecimals(h.quantity, e.quantity);
        if (cmp == null) { invalidEvents.push(e.id || null); return; }
        if (cmp < 0) {
          if (strict) {
            throw Object.assign(
              new Error('卖出数量超过当时持有数量（事件 ' + (e.id || '') + '，账户 ' + e.accountId + '，标的 ' + e.instrumentId + '）'),
              { code: 'insufficient_holdings', detail: { eventId: e.id || null, accountId: e.accountId, instrumentId: e.instrumentId } }
            );
          }
          h.oversellEvents.push(e.id || null);
          return; // 宽松模式：跳过该笔卖出，数量不穿零
        }
        h.quantity = subtractQuantities(h.quantity, e.quantity); // parseDecimal 不收负数，减法走整数运算
        h.counts.sell += 1;
        if (h.quantity == null) { invalidEvents.push(e.id || null); return; }
      } else {
        h.counts[type] += 1; // dividend / fee：只记账，不改数量
      }
      if (e.occurredAt) {
        if (h.firstActivityAt == null || String(e.occurredAt) < String(h.firstActivityAt)) h.firstActivityAt = e.occurredAt;
        if (h.lastEventAt == null || String(e.occurredAt) > String(h.lastEventAt)) h.lastEventAt = e.occurredAt;
      }
    });

    var holdings = order.map(function (key) { return map[key]; });
    return { holdings: holdings, invalidEvents: invalidEvents };
  }

  /* --------------------- Phase 4E：基准日的持有数量（as-of 重放，D-045） --------------------- */

  // holdingsAsOf(openings, events, asOf) — 基准日的持有数量。
  // 口径：把「期初快照 + 事件」按基准日**截断**后交给 deriveHoldings 重放，不另写一套加减
  //（D-042 ① 的唯一推导实现）。截断规则：
  //   - 期初快照的 asOf 晚于基准日 → 该快照在基准日尚不存在，整行排除（数量只能由当时可见的事实推导）；
  //   - 事件 occurredAt 晚于基准日 → 排除；occurredAt 缺失的事件不是可用事实，同样排除。
  // 基准日**当天**的期初与事件均计入 —— 与 D-042 ⑦「期初快照 = 期初日日初数量」的边界口径一致。
  function holdingsAsOf(openings, events, asOf) {
    var limit = asOf == null ? null : String(asOf);
    if (!limit) return { holdings: [], byKey: {}, invalidEvents: [] };
    var openList = (Array.isArray(openings) ? openings : []).filter(function (o) {
      if (!o) return false;
      var d = o.asOf == null ? '' : String(o.asOf);
      return !d || d <= limit;
    });
    var evList = (Array.isArray(events) ? events : []).filter(function (e) {
      if (!e) return false;
      var d = e.occurredAt == null ? '' : String(e.occurredAt);
      return !!d && d <= limit;
    });
    var result = deriveHoldings(openList, evList);
    var byKey = {};
    result.holdings.forEach(function (h) {
      if (!h || !h.accountId || !h.instrumentId) return;
      byKey[holdingKey(h.accountId, h.instrumentId)] = h;
    });
    return { holdings: result.holdings, byKey: byKey, invalidEvents: result.invalidEvents };
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

  /* ------------------------------ 标的目录（Phase 4B） ------------------------------ */

  function isAssetClass(v) {
    return RISK_CLASSES.indexOf(v) !== -1;
  }

  function isExposureMarket(v) {
    return EXPOSURE_MARKETS.indexOf(v) !== -1;
  }

  // 标的去重键：公开代码 + 交易所，全部大写归一。
  // 同一个标的只能有一行事实；交易所缺失时退化为「代码本身」这一键。
  function instrumentKey(symbol, exchange) {
    var s = symbol == null ? '' : String(symbol).trim().toUpperCase();
    var e = exchange == null ? '' : String(exchange).trim().toUpperCase();
    if (!s) return null;
    return s + '@' + e;
  }

  // provider 元数据与本地记录的差异（D-037 的冲突提示口径，全产品只有这一份实现）。
  // 规则：
  //   - 只比较**同名字段**，绝不跨语义比较（上市市场 ≠ 风险敞口，交易币种 ≠ 汇总币种）；
  //   - provider 没给的字段（null）不构成冲突 —— 没有来源就没有"不同"可说；
  //   - 只报差异，不改任何值：是否采纳由用户决定（confirmed 记录一律不覆盖）。
  var INSTRUMENT_PROVIDER_FIELDS = ['name', 'currency', 'exchange', 'instrumentType', 'country', 'exchangeTimezone'];

  function diffInstrumentFields(local, providerFields) {
    var out = [];
    if (!local || !providerFields) return out;
    INSTRUMENT_PROVIDER_FIELDS.forEach(function (field) {
      var pv = providerFields[field];
      if (pv == null || pv === '') return;
      var lv = local[field];
      if (lv == null || lv === '') return; // 本地还没值：这是补全机会，不是冲突
      if (String(lv) !== String(pv)) out.push({ field: field, localValue: lv, providerValue: pv });
    });
    return out;
  }

  // provider 提供的字段里，哪些可以直接作为 suggested 预填、依据是哪个上游字段。
  // 返回 [{ field, value, basis }]；asset_class / exposure_market / 跟踪指数**不在此列**
  // —— 它们没有 provider 字段来源，只能由用户填写（D-037）。
  var PROVIDER_SUGGESTABLE_FIELDS = [
    { field: 'currency', basis: 'provider.currency' },
    { field: 'exchange', basis: 'provider.exchange' },
    { field: 'instrumentType', basis: 'provider.instrument_type' },
    { field: 'country', basis: 'provider.country' },
    { field: 'exchangeTimezone', basis: 'provider.exchange_timezone' }
  ];

  function suggestFromProvider(candidate) {
    if (!candidate) return [];
    var out = [];
    PROVIDER_SUGGESTABLE_FIELDS.forEach(function (f) {
      var v = candidate[f.field];
      if (v == null || v === '') return;
      out.push({ field: f.field, value: v, basis: f.basis });
    });
    return out;
  }

  // 用户判断字段：provider 无权生成，只能由用户填写并确认（D-037）。
  var USER_JUDGEMENT_FIELDS = ['assetClass', 'exposureMarket', 'trackingIndex'];

  /* ------------------------------ 汇率与报价 ------------------------------ */

  // 陈旧判定的**唯一实现**：报价过期与汇率过期是同一条规则（A-004）。
  // findQuote / findFxRate 与 4E 的 as-of 腿都调它，避免出现第二套阈值或第二个比较方向。
  function quoteStatusOf(priceDate, now) {
    return isStaleDays(priceDate, now, MAX_STALE_DAYS) ? 'quote_stale' : 'ok';
  }

  function fxStatusOf(rateDate, now) {
    return isStaleDays(rateDate, now, MAX_STALE_DAYS) ? 'fx_stale' : 'ok';
  }


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
      status: fxStatusOf(best.rateDate, now)
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
      status: quoteStatusOf(best.priceDate, now)
    };
  }

  /* --------------------- Phase 4E：历史基准的 as-of 查询（D-045） --------------------- */

  // 取基准日**当天及之前**最近一条报价。与 findQuote 的区别：
  //   findQuote    用于「当前估值」——取全局最新一条，陈旧性由 now 判定（A-004）；
  //   as-of 查询   用于「历史基准」——**绝不返回晚于基准日的行**，否则会拿未来价格回算历史。
  // 历史基准不做陈旧判定（那一刻的观测就是那一刻的事实），因此不返回 status。
  function findQuoteAsOf(quotes, instrumentId, asOf) {
    if (!asOf) return null;
    var limit = String(asOf);
    var best = null;
    (quotes || []).forEach(function (q) {
      if (!q || q.instrumentId !== instrumentId) return;
      if (typeof q.priceMinor !== 'number' || !isFinite(q.priceMinor)) return;
      var d = q.priceDate == null ? '' : String(q.priceDate);
      if (!d || d > limit) return;
      if (!best || d > String(best.priceDate || '')) best = q;
    });
    if (!best) return null;
    return {
      priceMinor: best.priceMinor,
      currency: best.currency == null ? null : best.currency,
      priceDate: best.priceDate || null,
      provider: best.provider || null
    };
  }

  // 取基准日**当天及之前**最近一条汇率（同上：as-of 语义，绝不返回未来行）。
  // 币对方向仍按精确匹配，不取倒数（与 findFxRate 同纪律）。
  function findFxRateAsOf(fxRates, base, quote, asOf) {
    if (!asOf) return null;
    var limit = String(asOf);
    var best = null;
    (fxRates || []).forEach(function (r) {
      if (!r || r.base !== base || r.quote !== quote) return;
      if (!parseDecimal(r.rateDecimal)) return;
      var d = r.rateDate == null ? '' : String(r.rateDate);
      if (!d || d > limit) return;
      if (!best || d > String(best.rateDate || '')) best = r;
    });
    if (!best) return null;
    return {
      rateDecimal: best.rateDecimal,
      rateDate: best.rateDate || null,
      provider: best.provider || null
    };
  }

  /* ------------------------------ Phase 4D：行情写入规则（D-044） ------------------------------ */

  // 手动兜底来源：用户显式录入的报价/汇率（Phase 3 的手动汇率、4D 的手动补价）。
  // 它不是"又一个 provider"，而是用户判断：自动更新不得覆盖它（与 D-037 的 confirmed 锁定同纪律）。
  var MANUAL_PROVIDER = 'manual';

  // 自动更新的两个作用域（4D）：汇率与报价各有独立的启用开关与成败语义。
  var MARKET_SCOPES = ['fx', 'quotes'];

  // 元素键：同一元素键上只应存在一行事实（写入路径先按该键替换再插入）。
  //   quotes   → (标的, 价格日)
  //   fxRates  → (币对, 汇率日)
  // 注意：数据库 v1 的唯一索引 uq_quotes_dedupe 带 provider，即「同一价格日可不同 provider 并存」
  // （被 tests/server-migration.test.js 冻结为既有口径），所以"元素键唯一"是**写入路径**的不变量，
  // 不是数据库不变量；理由与取舍见 migrations v7 注释与 DECISIONS D-044。
  function marketElementKey(kind, row) {
    if (!row) return null;
    function part(v) {
      return v == null ? '' : String(v).trim();
    }
    if (kind === 'quotes') {
      var iid = part(row.instrumentId);
      var pd = part(row.priceDate);
      if (!iid || !pd) return null;
      return iid + '|' + pd;
    }
    if (kind === 'fx') {
      var b = part(row.base);
      var q = part(row.quote);
      var rd = part(row.rateDate);
      if (!b || !q || !rd) return null;
      return b + '|' + q + '|' + rd;
    }
    return null;
  }

  // 一次行情写入的合并计划（纯函数、无 IO）：把"能不能覆盖"从仓储层抽出来，
  // 让单条写入、全量写入与今后的其他入口共用同一套规则（D-025 单一实现）。
  // 返回 { write, skip, replaced }：
  //   write    —— 允许落库的 incoming 行（保持传入顺序）
  //   skip     —— 被拒绝的 incoming 行，带原因（manual_locked / invalid_row）与对应既有行
  //   replaced —— 将被 write 覆盖掉的既有行（供响应报告"已更新"）
  // 规则（D-044）：① manual 行是用户显式事实，总是写入；
  //               ② 自动源不得覆盖同一元素键上已存在的 manual 行（跳过并留痕，只提示差异）；
  //               ③ 其余情况按元素键替换（同键后到的覆盖先到的，结果与传入顺序一致）。
  // 手动锁的分组键与数据日：锁定按「一个标的」/「一个币对」整组判定，而不是只看单个元素键 ——
  // 用户手动补一天的价，语义是"这个标的那一天的价由我确认"，所以自动源不得再写**同一天或更早**的观测；
  // 但更新的数据日仍可写入（新交易日的新事实不该被历史手动值永久挡住）。
  function marketGroupKey(kind, row) {
    if (!row) return null;
    if (kind === 'quotes') {
      var iid = row.instrumentId == null ? '' : String(row.instrumentId).trim();
      return iid || null;
    }
    if (kind === 'fx') {
      var b = row.base == null ? '' : String(row.base).trim();
      var q = row.quote == null ? '' : String(row.quote).trim();
      return b && q ? b + '/' + q : null;
    }
    return null;
  }

  function marketRowDate(kind, row) {
    if (!row) return null;
    if (kind === 'quotes') return row.priceDate == null ? null : String(row.priceDate).trim() || null;
    if (kind === 'fx') return row.rateDate == null ? null : String(row.rateDate).trim() || null;
    return null;
  }

  function planMarketMerge(kind, existingRows, incomingRows) {
    var byKey = {};
    var manualMaxDate = {};
    var allExisting = [];
    (existingRows || []).forEach(function (r) {
      var k = marketElementKey(kind, r);
      if (!k) return;
      allExisting.push({ key: k, row: r });
      if (!byKey[k]) byKey[k] = r;
      if (String((r && r.provider) || '') === MANUAL_PROVIDER) {
        var g = marketGroupKey(kind, r);
        var d = marketRowDate(kind, r);
        if (g && d && (!manualMaxDate[g] || d > manualMaxDate[g])) manualMaxDate[g] = d;
      }
    });
    var write = [];
    var skip = [];
    var writeKeys = {};
    (incomingRows || []).forEach(function (r) {
      var k = marketElementKey(kind, r);
      if (!k) {
        skip.push({ row: r, reason: 'invalid_row', existing: null });
        return;
      }
      var isManual = String((r && r.provider) || '') === MANUAL_PROVIDER;
      var g = marketGroupKey(kind, r);
      var d = marketRowDate(kind, r);
      // 手动事实的冻结范围：同组内 ≤ 手动行数据日的观测一律不写。判定用**全部**既有行，
      // 而不是只看第一个同键行 —— 历史库允许同一价格日并存不同 provider 的两行，
      // 只看一条可能漏掉 manual 行，于是自动更新会连带删掉用户的手动事实。
      if (!isManual && g && d && manualMaxDate[g] && !(d > manualMaxDate[g])) {
        skip.push({ row: r, reason: 'manual_locked', existing: byKey[k] || null });
        return;
      }
      write.push(r);
      writeKeys[k] = true;
    });
    var replaced = allExisting
      .filter(function (e) {
        return writeKeys[e.key];
      })
      .map(function (e) {
        return e.row;
      });
    return { write: write, skip: skip, replaced: replaced };
  }

  // 需要更新行情的标的（4D）：有持仓事实的标的（期初或证券事件）或已有报价的标的。
  // 只按事实判断，不按"用户可能想看什么"猜测；输出按 symbol 排序，保证相同输入得到相同顺序。
  function requiredQuoteSymbols(assets) {
    var a = assets || {};
    var held = {};
    (a.holdings || []).forEach(function (h) {
      if (h && h.instrumentId) held[h.instrumentId] = true;
    });
    (a.securityEvents || []).forEach(function (e) {
      if (e && e.instrumentId) held[e.instrumentId] = true;
    });
    (a.quotes || []).forEach(function (q) {
      if (q && q.instrumentId) held[q.instrumentId] = true;
    });
    var byId = {};
    (a.instruments || []).forEach(function (i) {
      if (i && i.id) byId[i.id] = i;
    });
    return Object.keys(held)
      .map(function (id) {
        var ins = byId[id];
        if (!ins) return null;
        return {
          instrumentId: id,
          symbol: ins.symbol == null ? '' : String(ins.symbol),
          exchange: ins.exchange == null ? null : String(ins.exchange)
        };
      })
      .filter(function (x) {
        return !!x;
      })
      .sort(function (x, y) {
        return x.instrumentId < y.instrumentId ? -1 : x.instrumentId > y.instrumentId ? 1 : 0;
      });
  }

  // 需要更新汇率的币对（4D）：账上出现过的非 CNY 币种（余额单元、负债、权益、标的、报价）
  // 各自对 CNY 折算，外加用户已登记过的币对本来的方向。
  // 汇总币种是 CNY（D-008），因此"对 CNY"是唯一的自动更新目标；反向币对不自动登记。
  function requiredFxPairs(assets) {
    var a = assets || {};
    var pairs = {};
    function addCurrency(c) {
      var v = c == null ? '' : String(c).trim().toUpperCase();
      if (!v || v === 'CNY') return;
      if (CURRENCIES.indexOf(v) === -1) return;
      pairs[v + '/CNY'] = { base: v, quote: 'CNY' };
    }
    (a.assetUnits || []).forEach(function (u) {
      if (u) addCurrency(u.currency);
    });
    (a.liabilities || []).forEach(function (l) {
      if (l) addCurrency(l.currency);
    });
    (a.entitlements || []).forEach(function (e) {
      if (e) addCurrency(e.currency);
    });
    (a.instruments || []).forEach(function (i) {
      if (i) addCurrency(i.currency);
    });
    (a.quotes || []).forEach(function (q) {
      if (q) addCurrency(q.currency);
    });
    (a.fxRates || []).forEach(function (r) {
      if (!r || !r.base || !r.quote || r.base === r.quote) return;
      if (CURRENCIES.indexOf(r.base) === -1 || CURRENCIES.indexOf(r.quote) === -1) return;
      pairs[r.base + '/' + r.quote] = { base: r.base, quote: r.quote };
    });
    return Object.keys(pairs)
      .sort()
      .map(function (k) {
        return pairs[k];
      });
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

  // 折算到 CNY 并同步登记阻塞码（fx_missing / fx_stale）—— 金额估值路径的唯一折算入口。
  // 返回 { valueMinor, status, rate }；缺汇率 → null（绝不按 1:1 兜底）。
  // rate 是本次折算**实际用到**的汇率事实（同币种为恒等 '1'），供「这条估值用的哪天的汇率」追溯（4E）。
  function convertToCny(minor, currency, fxRates, now, addBlocker) {
    var conv = convertMinor(minor, currency, 'CNY', fxRates, now);
    if (conv.status === 'missing_fx') { addBlocker('fx_missing', currency); return null; }
    if (conv.status === 'fx_stale') addBlocker('fx_stale', currency);
    var rate = currency === 'CNY'
      ? { rateDecimal: '1', rateDate: null, provider: null }
      : findFxRate(fxRates, currency, 'CNY', now);
    return { valueMinor: conv.valueMinor, status: conv.status, rate: rate };
  }

  // 资产项估值（Phase 4E 抽取，D-025 单一实现）：逐条估值「余额单元 + 持仓」，并记录**全部追溯字段**
  //（数量 / 价格 / 价格日 / 价格来源 / 汇率 / 汇率日 / 汇率来源）。
  // computeOverview 与 computeAssetDrilldown 共用本函数，因此「下钻合计 == 总览」是**同一遍计算**的
  // 必然结果，而不是两套算法互相校对。阻塞码的判定顺序与 Phase 1–3 逐字一致（零回归的前提）。
  // 返回 items[]：未计入合计的项也保留在列表里（valueCnyMinor = null + skipped 原因），绝不静默丢行。
  function valueAssetItems(a, ctx) {
    var now = ctx.now;
    var addBlocker = ctx.addBlocker;
    var accountMap = ctx.accountMap;
    var instrumentMap = ctx.instrumentMap;
    var items = [];

    /* 现金与明确余额单元 */
    a.assetUnits.forEach(function (u) {
      if (!u) return;
      var acct = accountMap[u.accountId];
      var pool = acct && POOLS.indexOf(acct.pool) !== -1 ? acct.pool : null;
      if (!pool) addBlocker('pool_missing', (acct && acct.name) || u.accountId || '');
      var item = {
        kind: 'unit',
        id: u.id || null,
        accountId: u.accountId || null,
        accountName: (acct && acct.name) || null,
        pool: pool,
        currency: u.currency || null,
        assetClass: 'cash',
        riskClass: 'cash',
        exposureMarket: null,
        classificationStatus: null,
        instrumentId: null,
        symbol: null,
        quantity: null,
        balanceMinor: u.balanceMinor == null ? null : u.balanceMinor,
        valueDate: u.asOf || null,
        priceMinor: null,
        priceDate: null,
        priceProvider: null,
        priceStatus: null,
        fxRateDecimal: null,
        fxRateDate: null,
        fxProvider: null,
        fxStatus: null,
        valueLocalMinor: u.balanceMinor == null ? null : u.balanceMinor,
        valueCnyMinor: null,
        valueStatus: null,
        skipped: null
      };
      items.push(item);
      if (u.balanceMinor == null) {
        addBlocker('balance_missing', (acct && acct.name) || u.accountId || ''); // 无明确余额：不参与合计，不按 0 处理
        item.skipped = 'balance_missing';
        return;
      }
      if (ymOf(u.asOf) !== ymOf(now)) addBlocker('balance_stale', (acct && acct.name) || u.accountId || ''); // A-005
      var conv = convertToCny(u.balanceMinor, u.currency, a.fxRates, now, addBlocker);
      if (conv == null) { item.skipped = 'missing_fx'; return; }
      item.valueCnyMinor = conv.valueMinor;
      item.valueStatus = conv.status;
      item.fxRateDecimal = conv.rate ? conv.rate.rateDecimal : null;
      item.fxRateDate = conv.rate ? conv.rate.rateDate : null;
      item.fxProvider = conv.rate ? conv.rate.provider : null;
      item.fxStatus = conv.status;
    });

    /* 持仓估值：数量口径只有一份（D-025/D-042）。
     * 有证券事件时，估值数量来自 deriveHoldings 的推导结果（期初 + Σ买入 − Σ卖出）；
     * 无事件时直接用期初快照，两者数值一致、零回归。 */
    var holdingRows = a.holdings;
    if (a.securityEvents && a.securityEvents.length > 0) {
      holdingRows = deriveHoldings(a.holdings, a.securityEvents).holdings;
    }
    holdingRows.forEach(function (h) {
      if (!h) return;
      var ins = instrumentMap[h.instrumentId];
      var acct = accountMap[h.accountId];
      var pool = acct && POOLS.indexOf(acct.pool) !== -1 ? acct.pool : null;
      var item = {
        kind: 'holding',
        id: h.openingId != null ? h.openingId : (h.id || null),
        accountId: h.accountId || null,
        accountName: (acct && acct.name) || null,
        pool: pool,
        currency: ins && ins.currency != null ? ins.currency : null,
        assetClass: ins && ins.assetClass != null ? ins.assetClass : null,
        riskClass: ins && RISK_CLASSES.indexOf(ins.assetClass) !== -1 ? ins.assetClass : 'other',
        exposureMarket: ins && isExposureMarket(ins.exposureMarket) ? ins.exposureMarket : null,
        classificationStatus: ins ? (ins.classificationStatus || null) : null,
        instrumentId: h.instrumentId || null,
        symbol: ins ? (ins.symbol || null) : null,
        quantity: h.quantity || null,
        balanceMinor: null,
        valueDate: null,
        priceMinor: null,
        priceDate: null,
        priceProvider: null,
        priceStatus: null,
        fxRateDecimal: null,
        fxRateDate: null,
        fxProvider: null,
        fxStatus: null,
        valueLocalMinor: null,
        valueCnyMinor: null,
        valueStatus: null,
        skipped: null
      };
      items.push(item);
      if (!ins) { addBlocker('instrument_missing', h.instrumentId || ''); item.skipped = 'instrument_missing'; return; }
      if (!pool) addBlocker('pool_missing', (acct && acct.name) || h.accountId || '');
      var q = findQuote(a.quotes, h.instrumentId, now);
      if (!q) { addBlocker('quote_missing', ins.symbol || h.instrumentId || ''); item.skipped = 'missing_quote'; return; }
      if (q.status === 'quote_stale') addBlocker('quote_stale', ins.symbol || '');
      item.priceMinor = q.priceMinor;
      item.priceDate = q.priceDate || null;
      item.priceProvider = q.provider || null;
      item.priceStatus = q.status;
      item.currency = q.currency == null ? item.currency : q.currency; // 估值币种 = 报价币种
      var minor = mulMinor(h.quantity, q.priceMinor);
      if (minor == null) { addBlocker('holding_invalid', ins.symbol || ''); item.skipped = 'holding_invalid'; return; }
      item.valueLocalMinor = minor;
      var hconv = convertToCny(minor, q.currency, a.fxRates, now, addBlocker);
      if (hconv == null) { item.skipped = 'missing_fx'; return; }
      item.valueCnyMinor = hconv.valueMinor;
      item.valueStatus = hconv.status;
      item.fxRateDecimal = hconv.rate ? hconv.rate.rateDecimal : null;
      item.fxRateDate = hconv.rate ? hconv.rate.rateDate : null;
      item.fxProvider = hconv.rate ? hconv.rate.provider : null;
      item.fxStatus = hconv.status;
      if (pool === 'investable' && item.riskClass === 'other' && ins.assetClass) {
        addBlocker('asset_class_invalid', ins.symbol || '');
      }
      if (ins.classificationStatus !== 'confirmed') addBlocker('classification_unconfirmed', ins.symbol || '');
    });

    return items;
  }

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
    var hasAnyData = a.assetUnits.length > 0 || a.holdings.length > 0 || a.liabilities.length > 0 ||
      a.securityEvents.length > 0;

    // 资产项估值只走 valueAssetItems 这一遍（D-025）：总览与下钻因此不可能对不上。
    var items = valueAssetItems(a, {
      now: now,
      addBlocker: addBlocker,
      accountMap: accountMap,
      instrumentMap: instrumentMap
    });
    items.forEach(function (it) {
      if (it.valueCnyMinor == null) return; // 未计入合计的项（缺汇率等）已在 items 中留痕
      totalAssets += it.valueCnyMinor;
      if (it.pool) pools[it.pool] += it.valueCnyMinor;
      if (it.pool !== 'investable') return;
      if (it.kind === 'unit') {
        investableCash += it.valueCnyMinor;
        riskValue.cash += it.valueCnyMinor;
      } else {
        riskValue[it.riskClass] += it.valueCnyMinor;
      }
    });

    /* 负债与近期应付款 */
    a.liabilities.forEach(function (l) {
      if (!l) return;
      if (l.balanceMinor == null) { addBlocker('liability_missing', l.name || ''); return; }
      if (ymOf(l.asOf) !== ymOf(now)) addBlocker('balance_stale', l.name || '');
      var lconv = convertToCny(l.balanceMinor, l.currency, a.fxRates, now, addBlocker);
      if (lconv == null || lconv.valueMinor == null) return;
      totalLiabilities += lconv.valueMinor; // 负债单独累计，不冲减总资产
      if (l.termType === 'current') duePayables += lconv.valueMinor;
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

    var out = {
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
    // 可选：把逐项估值明细一并返回（4E 估值下钻用）。默认不返回 —— 结账快照 payload 调用的是
    // 不带 withItems 的版本，payload 形状与哈希口径因此完全不变（旧快照仍可读）。
    if (opts.withItems === true) out.items = items;
    return out;
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

    /* 单元级事实：持仓估值（有证券事件时数量来自推导，与总览同口径） */
    var holdingRows = a.holdings;
    if (a.securityEvents && a.securityEvents.length > 0) {
      holdingRows = deriveHoldings(a.holdings, a.securityEvents).holdings;
    }
    var holdingFacts = holdingRows.map(function (h) {
      if (!h) return null;
      var ins = instrumentMap[h.instrumentId];
      var q = findQuote(a.quotes, h.instrumentId, now);
      var minor = q ? mulMinor(h.quantity, q.priceMinor) : null;
      var conv = minor == null ? { valueMinor: null, status: 'missing_quote' }
        : convertMinor(minor, q.currency, 'CNY', a.fxRates, now);
      // Phase 4E：追加「折算实际用到的汇率事实」（纯追加字段）。让快照自身能回答
      //「这次持仓估值用的是哪一天的汇率、来自哪个来源」，不必回头按今天的口径重推。
      // 同币种折算记恒等汇率 '1'；没有报价就没有汇率可言，留 null。
      var rate = !q ? null
        : q.currency === 'CNY' ? { rateDecimal: '1', rateDate: null, provider: null }
          : findFxRate(a.fxRates, q.currency, 'CNY', now);
      return {
        kind: 'holding',
        id: h.openingId != null ? h.openingId : (h.id || null),
        symbol: ins ? ins.symbol : null,
        instrumentId: h.instrumentId || null,
        accountId: h.accountId || null,
        account: acctName(h.accountId),
        quantity: h.quantity || null,
        priceMinor: q ? q.priceMinor : null,
        priceCurrency: q ? q.currency : null,
        priceDate: q ? q.priceDate : null,
        priceProvider: q ? q.provider : null,
        priceStatus: q ? q.status : 'missing_quote',
        fxRateDecimal: rate ? rate.rateDecimal : null,
        fxRateDate: rate ? rate.rateDate : null,
        fxProvider: rate ? rate.provider : null,
        // Phase 4E 复核补口（G4E-1）：把事件计数也封存进快照，归因的 periodEventCounts
        // 才能完全来自封存事实；老快照没有这个键，读取方必须容忍它缺失（输出 null）。
        eventCounts: h.counts || null,
        asOf: h.openingAsOf != null ? h.openingAsOf : (h.asOf || null),
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

  /* --------------------- Phase 4E：估值下钻与收益归因（D-045） --------------------- */

  // 敞口市场的「未分类」桶：市场维度需要一个"用户还没填"的位置。不能把未分类的持仓静默并进某个
  // 真实市场（那会让"市场分布"看起来比事实更确定）。它只是分组桶，不是 EXPOSURE_MARKETS 词表值，
  // 也不会写回任何事实。
  var MARKET_UNSPECIFIED = 'unspecified';

  // 把估值明细按某个键分组：每组带 CNY 合计、项数与**未计入合计的项数**。
  // 未计入合计（valueCnyMinor == null）的项保留在组里并计入 unvaluedCount —— 否则
  //「下钻合计 == 总览」会通过，而用户看不到被漏掉的那几条，这正是最危险的假绿。
  function groupAssetItems(items, keyOf, labelOf) {
    var map = {}, order = [];
    items.forEach(function (it) {
      var k = keyOf(it);
      if (k == null) return;
      var g = map[k];
      if (!g) {
        g = {
          key: k,
          label: labelOf ? labelOf(it) : k,
          valueCnyMinor: 0,
          itemCount: 0,
          unvaluedCount: 0,
          holdings: 0,
          units: 0
        };
        map[k] = g;
        order.push(k);
      }
      g.itemCount += 1;
      if (it.kind === 'holding') g.holdings += 1; else g.units += 1;
      if (typeof it.valueCnyMinor === 'number') g.valueCnyMinor += it.valueCnyMinor;
      else g.unvaluedCount += 1;
    });
    // 金额降序、同额按键升序：相同输入必然得到相同顺序（可复算的前提）。
    return order.map(function (k) { return map[k]; }).sort(function (x, y) {
      if (x.valueCnyMinor !== y.valueCnyMinor) return y.valueCnyMinor - x.valueCnyMinor;
      return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
    });
  }

  function sumGroupValue(groups) {
    return groups.reduce(function (acc, g) { return acc + g.valueCnyMinor; }, 0);
  }

  // computeAssetDrilldown(assets, { now, settings }) — 4E 估值下钻。
  // 与 computeOverview 共用**同一遍**估值（valueAssetItems），因此「下钻合计 == 总览」是构造性成立的，
  // 不是两套算法互相对账。四个维度的覆盖范围不同，各自用 scope 说明自己覆盖什么：
  //   byAccount / byCurrency —— 全部资产项（余额单元 + 持仓），合计 = totalAssetsMinor；
  //   byAssetClass           —— 只覆盖投资池（余额单元 + 持仓），合计 = pools.investableMinor，
  //                             与 overview.riskClasses 完全同口径；现金记入 'cash' 类；
  //   byMarket               —— 只覆盖投资池**持仓**（现金没有敞口市场），合计 = 投资池持仓合计；
  //                             加上 totals.investableCashMinor 才等于 pools.investableMinor。
  // 负债不进入资产项下钻（它是负项，混进来「合计 == 总资产」就没有意义了），单列在 totals 里。
  function computeAssetDrilldown(assets, opts) {
    if (!opts || !opts.now) throw new Error('computeAssetDrilldown 需要 now 参数（YYYY-MM-DD）');
    var now = opts.now;
    var a = normalizeAssets(assets);
    var overview = computeOverview(a, { now: now, settings: opts.settings || {}, withItems: true });
    var items = overview.items;

    var byAccount = groupAssetItems(items, function (it) {
      return it.accountId || MARKET_UNSPECIFIED;
    }, function (it) {
      return it.accountName || it.accountId || MARKET_UNSPECIFIED;
    });
    var byCurrency = groupAssetItems(items, function (it) {
      return it.currency || MARKET_UNSPECIFIED;
    });
    var investable = items.filter(function (it) { return it.pool === 'investable'; });
    var byAssetClass = groupAssetItems(investable, function (it) {
      return it.kind === 'unit' ? 'cash' : it.riskClass;
    });
    var investableHoldings = investable.filter(function (it) { return it.kind === 'holding'; });
    var byMarket = groupAssetItems(investableHoldings, function (it) {
      return it.exposureMarket || MARKET_UNSPECIFIED;
    });

    var investableCashMinor = 0;
    var investableHoldingsMinor = 0;
    investable.forEach(function (it) {
      if (typeof it.valueCnyMinor !== 'number') return;
      if (it.kind === 'unit') investableCashMinor += it.valueCnyMinor;
      else investableHoldingsMinor += it.valueCnyMinor;
    });

    // 逐持仓追溯：这一行就是「这条估值用的是哪天的价格、哪个来源、哪天的汇率」。
    var positions = items.filter(function (it) { return it.kind === 'holding'; }).map(function (it) {
      return {
        instrumentId: it.instrumentId,
        symbol: it.symbol,
        accountId: it.accountId,
        accountName: it.accountName,
        pool: it.pool,
        currency: it.currency,
        assetClass: it.assetClass,
        riskClass: it.riskClass,
        exposureMarket: it.exposureMarket,
        classificationStatus: it.classificationStatus,
        quantity: it.quantity,
        priceMinor: it.priceMinor,
        priceDate: it.priceDate,
        priceProvider: it.priceProvider,
        priceStatus: it.priceStatus,
        fxRateDecimal: it.fxRateDecimal,
        fxRateDate: it.fxRateDate,
        fxProvider: it.fxProvider,
        fxStatus: it.fxStatus,
        valueLocalMinor: it.valueLocalMinor,
        valueCnyMinor: it.valueCnyMinor,
        valueStatus: it.valueStatus,
        skipped: it.skipped
      };
    });

    var sumAccount = sumGroupValue(byAccount);
    var sumCurrency = sumGroupValue(byCurrency);
    var sumAssetClass = sumGroupValue(byAssetClass);
    var sumMarket = sumGroupValue(byMarket);

    return {
      asOf: now,
      valuationStatus: overview.valuationStatus,
      canAdvise: overview.canAdvise,
      totals: {
        totalAssetsMinor: overview.totalAssetsMinor,
        totalLiabilitiesMinor: overview.totalLiabilitiesMinor,
        netWorthMinor: overview.netWorthMinor,
        safetyMinor: overview.pools.safetyMinor,
        investableMinor: overview.pools.investableMinor,
        investableCashMinor: investableCashMinor,
        investableHoldingsMinor: investableHoldingsMinor,
        restrictedMinor: overview.pools.restrictedMinor
      },
      byAccount: byAccount,
      byCurrency: byCurrency,
      byAssetClass: byAssetClass,
      byMarket: byMarket,
      positions: positions,
      // 「下钻合计 == 总览」由领域层自己给结论，各页面不必再各写一套容忍判断。
      consistency: {
        sumByAccountMinor: sumAccount,
        sumByCurrencyMinor: sumCurrency,
        sumByAssetClassMinor: sumAssetClass,
        sumByMarketMinor: sumMarket,
        byAccountMatches: sumAccount === overview.totalAssetsMinor,
        byCurrencyMatches: sumCurrency === overview.totalAssetsMinor,
        byAssetClassMatches: sumAssetClass === overview.pools.investableMinor,
        byMarketMatches: sumMarket === investableHoldingsMinor
      },
      freshness: overview.freshness,
      blockers: overview.blockers
    };
  }

  // computeAttributionBaselinePositions(assets, asOf) — 结账时计算「基准月末时点的逐持仓明细」，
  // 由调用方封存进快照 payload（键 attributionPositions），作为下期归因的期初基准事实（G4E-1）。
  // 口径：数量 = holdingsAsOf 在基准月末重放；价格/汇率 = as-of 查询（绝不取业务日期在未来的行）——
  // 与 checklist.facts.holdings（结账时点最新价的 Phase 3 语义）**刻意不同**：期初明细必须是
  // 基准月末的真实状态，不能用当时已经可见的未来价格。
  function computeAttributionBaselinePositions(assets, asOf) {
    var limit = String(asOf);
    var a = normalizeAssets(assets);
    return holdingsAsOf(a.holdings, a.securityEvents, limit).holdings.map(function (h) {
      if (!h || !h.accountId || !h.instrumentId) return null;
      var q = findQuoteAsOf(a.quotes, h.instrumentId, limit);
      var cur = q && q.currency ? q.currency : null;
      var rate = !cur ? null
        : cur === 'CNY' ? { rateDecimal: '1', rateDate: null, provider: null }
          : findFxRateAsOf(a.fxRates, cur, 'CNY', limit);
      return {
        accountId: h.accountId,
        instrumentId: h.instrumentId,
        quantity: h.quantity,
        priceMinor: q ? q.priceMinor : null,
        priceCurrency: cur,
        priceDate: q ? q.priceDate : null,
        priceProvider: q ? q.provider : null,
        fxRateDecimal: rate ? rate.rateDecimal : null,
        fxRateDate: rate ? rate.rateDate : null,
        fxProvider: rate ? rate.provider : null,
        eventCounts: h.counts || null
      };
    }).filter(Boolean);
  }

  // baselinePositionsFromSnapshot(payload) — 从封存快照 payload 提取归因期初明细（G4E-1）。
  // 快照在结账时封存了逐持仓的数量/价格/汇率/事件计数事实（checklist.facts.holdings）；
  // 这是**唯一**的读取实现：结账路径（server/api.js）与前端基准切换（js/app.js）都必须经过它，
  // 保证「期初腿用封存事实」只有一份判定。
  // 返回 { positions: [...], unavailable: null }；payload 缺封存明细 →
  // { positions: null, unavailable: 'baseline_details_missing' }（调用方不得改从事实表重算）。
  function baselinePositionsFromSnapshot(payload) {
    // 归因期初明细封存在快照 payload 的 attributionPositions 键（as-of 口径的基准月末逐持仓事实）；
    // checklist.facts.holdings 是 Phase 3 的「结账时点最新价」口径，不能拿来做期初。
    var positions = payload && Array.isArray(payload.attributionPositions)
      ? payload.attributionPositions : null;
    if (!positions) return { positions: null, unavailable: 'baseline_details_missing' };
    var normalized = positions.filter(function (p) {
      return p && (p.instrumentId || p.accountId);
    }).map(function (p) {
      return {
        accountId: p.accountId == null ? null : String(p.accountId),
        instrumentId: p.instrumentId == null ? null : String(p.instrumentId),
        quantity: p.quantity == null ? null : String(p.quantity),
        priceMinor: typeof p.priceMinor === 'number' && isFinite(p.priceMinor) ? p.priceMinor : null,
        priceCurrency: p.priceCurrency || null,
        priceDate: p.priceDate || null,
        priceProvider: p.priceProvider || null,
        fxRateDecimal: p.fxRateDecimal == null ? null : String(p.fxRateDecimal),
        fxRateDate: p.fxRateDate || null,
        fxProvider: p.fxProvider || null,
        eventCounts: p.eventCounts && typeof p.eventCounts === 'object'
          ? {
            buy: p.eventCounts.buy | 0,
            sell: p.eventCounts.sell | 0,
            dividend: p.eventCounts.dividend | 0,
            fee: p.eventCounts.fee | 0
          }
          : null
      };
    });
    return { positions: normalized, unavailable: null };
  }

  // computeReturnAttribution(assets, { now, settings, baseline }) — 4E 收益归因。
  // baseline 来自**已结账月快照**（D-034 ③ 的封存事实口径）：{ asOf, month, closeId, snapshotId, payloadHash }。
  // 没有 baseline 就逐行标注 no_baseline —— 宁可说不出来，也不给一个按今天口径倒推的假基准。
  //
  // 分解口径（D-045）：把一条持仓的 CNY 估值写成 V = Q × P × R（Q 数量、P 价格、R 汇率→CNY），
  //   价格影响 = (L1 − L0) × R0     其中 L = Q × P（本地币值）
  //   汇率影响 = ΔV − 价格影响        ΔV = V1 − V0
  // 汇率影响取**残差**，于是「价格影响 + 汇率影响 = 估值变化」逐行恒等，舍入缺口只落在汇率一侧，
  // 不会留下"归因不出来的差额"。两侧都是整数最小货币单位，全程不经浮点。
  //
  // 期初腿**只**认封存明细（D-045 复核补口 G4E-1）：期初数量、价格、汇率全部来自
  // baseline.positions（封存快照 payload 的逐持仓事实，由 baselinePositionsFromSnapshot 提取），
  // 绝不从当前事实表按历史日期重算 —— 结账之后补录旧业务日期的行情/汇率/事件/期初，
  // 不得改写已结账月的期初值。调用方给不出封存明细时整段不出归因并显式说明原因，
  // 绝不静默倒算。**绝不插值、绝不用 1:1 兜底。**
  // 不能分解的情形逐条写进 row.boundaries 并计入 totals.unattributedChangeCnyMinor；
  // 但只要能算出两端估值就照样给 ΔV ——「分解不了」与「算不出变化」是两件事。
  function computeReturnAttribution(assets, opts) {
    if (!opts || !opts.now) throw new Error('computeReturnAttribution 需要 now 参数（YYYY-MM-DD）');
    var now = opts.now;
    var a = normalizeAssets(assets);
    var baseline = opts.baseline || null;
    var baselineAsOf = baseline && baseline.asOf ? String(baseline.asOf) : null;
    // 估值状态沿用既有 blocker（quote_stale / fx_stale / classification_unconfirmed...），
    // 不新造第二套"能不能给正式建议"的判定（4E 的边界码只描述"能不能分解"）。
    var overview = computeOverview(a, { now: now, settings: opts.settings || {} });

    var accountMap = {}, instrumentMap = {};
    a.assetAccounts.forEach(function (x) { if (x && x.id) accountMap[x.id] = x; });
    a.instruments.forEach(function (x) { if (x && x.id) instrumentMap[x.id] = x; });

    // 期末腿按今天（或查询日）as-of 截断；期初腿来自封存明细（见 startUnavailable）。
    var endSide = holdingsAsOf(a.holdings, a.securityEvents, now).holdings;
    var endByKey = {}, startByKey = {}, keys = [], keySeen = {};
    function indexInto(map, list) {
      list.forEach(function (h) {
        if (!h || !h.accountId || !h.instrumentId) return;
        var k = holdingKey(h.accountId, h.instrumentId);
        map[k] = h;
        if (!keySeen[k]) { keySeen[k] = true; keys.push(k); }
      });
    }
    indexInto(endByKey, endSide);

    // G4E-1：期初腿的数据来源判定。只有拿到封存明细（baseline.positions 是数组）
    // 才允许算归因；给不出明细就是「基准明细不可用」，绝不退回事实表重算。
    var startUnavailable = null;
    if (baselineAsOf) {
      if (baseline.detailsUnavailable) startUnavailable = String(baseline.detailsUnavailable);
      else if (!Array.isArray(baseline.positions)) startUnavailable = 'baseline_details_missing';
      else indexInto(startByKey, baseline.positions);
    }

    var ZERO_COUNTS = { buy: 0, sell: 0, dividend: 0, fee: 0 };

    // 没有基准日就**整段不出归因**（rows 为空 + unavailable 说明），而不是把期初数量当成 0 ——
    // "期初 0"会读成"你当时没有持仓"，那正是要避免的假基准。基准明细拿不到同理：
    // startUnavailable 非空时 rows 为空并显式说明原因（baseline_details_missing / baseline_hash_mismatch），
    // 绝不按今天的口径倒推期初。有封存明细时，"期初没有这一条"才是真实推断
    //（基准快照封存的事实里确实没有），可以放心用 '0' + position_opened 表达。
    var rows = baselineAsOf && !startUnavailable ? keys.map(function (key) {
      var end = endByKey[key] || null;
      var start = startByKey[key] || null; // 封存期初明细；null = 基准快照里没有这条持仓
      var accountId = (end && end.accountId) || (start && start.accountId);
      var instrumentId = (end && end.instrumentId) || (start && start.instrumentId);
      var acct = accountMap[accountId];
      var ins = instrumentMap[instrumentId];
      var endQuantity = end ? end.quantity : '0';
      var startQuantity = start ? (start.quantity != null ? start.quantity : '0') : '0';
      var endCounts = (end && end.counts) || ZERO_COUNTS;
      // 期初事件计数来自封存明细；老快照没封存时为 null —— periodEventCounts 输出 null，
      // 不用当前事实表补算（补算就会随回填漂移）。
      var startCounts = start ? (start.eventCounts || null) : ZERO_COUNTS;

      // 期末腿走 as-of（只认查询日当天及之前的事实）：now = 今天且没有未来日期的事实行时，
      // 期末腿与决策台的当前估值逐分一致（自测里有专门断言）。期初腿不用查 —— 封存明细自带
      // 当时的价格与汇率事实。
      var q1 = findQuoteAsOf(a.quotes, instrumentId, now);
      var endCur = q1 && q1.currency != null ? q1.currency : null;
      var startCur = start ? (start.priceCurrency || null) : null;
      var endFx = null;
      if (endCur) {
        var endRaw = endCur === 'CNY'
          ? { rateDecimal: '1', rateDate: null, provider: null }
          : findFxRateAsOf(a.fxRates, endCur, 'CNY', now);
        if (endRaw) {
          endFx = {
            rateDecimal: endRaw.rateDecimal,
            rateDate: endRaw.rateDate,
            provider: endRaw.provider,
            status: fxStatusOf(endRaw.rateDate, now)
          };
        }
      }
      var startFx = null;
      if (start) {
        if (start.fxRateDecimal != null) {
          startFx = {
            rateDecimal: String(start.fxRateDecimal),
            rateDate: start.fxRateDate || null,
            provider: start.fxProvider || null,
            status: null
          };
        } else if (startCur === 'CNY') {
          // 老快照没封存汇率字段时，CNY→CNY 的恒等汇率是数学事实，不是插值兜底。
          startFx = { rateDecimal: '1', rateDate: null, provider: null, status: null };
        }
      }

      var row = {
        accountId: accountId || null,
        accountName: (acct && acct.name) || null,
        instrumentId: instrumentId || null,
        symbol: ins ? (ins.symbol || null) : null,
        currency: (ins && ins.currency) || endCur || startCur || null,
        assetClass: ins && ins.assetClass != null ? ins.assetClass : null,
        exposureMarket: ins && isExposureMarket(ins.exposureMarket) ? ins.exposureMarket : null,
        startQuantity: startQuantity,
        endQuantity: endQuantity,
        // 期初价格/汇率直接来自封存明细（不再查事实表）；老快照没封存的字段如实输出 null。
        startPriceMinor: start ? (start.priceMinor == null ? null : start.priceMinor) : null,
        startPriceDate: start ? (start.priceDate || null) : null,
        startPriceProvider: start ? (start.priceProvider || null) : null,
        endPriceMinor: q1 ? q1.priceMinor : null,
        endPriceDate: q1 ? q1.priceDate : null,
        endPriceProvider: q1 ? q1.provider : null,
        startRateDecimal: startFx ? startFx.rateDecimal : null,
        startRateDate: startFx ? startFx.rateDate : null,
        startRateProvider: startFx ? startFx.provider : null,
        endRateDecimal: endFx ? endFx.rateDecimal : null,
        endRateDate: endFx ? endFx.rateDate : null,
        endRateProvider: endFx ? endFx.provider : null,
        startValueLocalMinor: null,
        endValueLocalMinor: null,
        startValueCnyMinor: null,
        endValueCnyMinor: null,
        valueChangeCnyMinor: null,
        priceEffectCnyMinor: null,
        fxEffectCnyMinor: null,
        attributable: false,
        boundaries: [],
        notes: [],
        periodEventCounts: startCounts == null ? null : {
          buy: endCounts.buy - startCounts.buy,
          sell: endCounts.sell - startCounts.sell,
          dividend: endCounts.dividend - startCounts.dividend,
          fee: endCounts.fee - startCounts.fee
        }
      };

      if (!ins) row.boundaries.push('instrument_missing');
      if (start && start.quantity == null) row.boundaries.push('holding_invalid');
      if (start && start.priceMinor == null) row.boundaries.push('missing_start_quote');
      if (!q1) row.boundaries.push('missing_end_quote');
      if (startCur && startCur !== 'CNY' && !startFx) row.boundaries.push('missing_start_fx');
      if (endCur && !endFx) row.boundaries.push('missing_end_fx');
      if (startCur && endCur && startCur !== endCur) row.boundaries.push('currency_changed');
      if (endQuantity === '0') row.boundaries.push('position_closed');
      else if (startQuantity === '0') row.boundaries.push('position_opened');
      else if (compareDecimals(startQuantity, endQuantity) !== 0) row.boundaries.push('quantity_changed');
      // 期间重录期初（期初快照的 asOf 落在基准日与今天之间）：数量会凭空跳一档，那不是交易造成的，
      // 既不能归因也不能当成收益。用**事实表**判断，不看推导出来的数量差值。
      var rebased = a.holdings.some(function (o) {
        return o && o.accountId === accountId && o.instrumentId === instrumentId &&
          o.asOf && baselineAsOf && String(o.asOf) > baselineAsOf && String(o.asOf) <= String(now);
      });
      if (rebased) row.boundaries.push('opening_rebased');
      if (q1 && quoteStatusOf(q1.priceDate, now) === 'quote_stale') row.notes.push('end_quote_stale');
      if (endFx && endFx.status === 'fx_stale') row.notes.push('end_fx_stale');
      if (ins && ins.classificationStatus !== 'confirmed') row.notes.push('classification_unconfirmed');

      // 两端都能定价时才给 ΔV：「分解不了」与「算不出变化」是两件事。
      // 期初侧：基准快照里没有这条持仓 → 0 股的估值恒为 0（数学事实），ΔV = 期末值；
      // 有这条但价格/汇率封存不全 → 定不了价，变化额也不给。
      var l0 = null, l1 = null, v0 = null, v1 = null;
      if (start == null) {
        l0 = 0;
        v0 = 0;
      } else if (start.priceMinor != null && startFx && start.quantity != null) {
        l0 = mulMinor(startQuantity, start.priceMinor);
        if (l0 != null) v0 = mulByRate(l0, startFx.rateDecimal);
      }
      if (q1 && endFx) {
        l1 = mulMinor(endQuantity, q1.priceMinor);
        if (l1 != null) v1 = mulByRate(l1, endFx.rateDecimal);
      }
      if (l0 == null || l1 == null || v0 == null || v1 == null) {
        if (row.boundaries.indexOf('missing_start_quote') < 0 &&
          row.boundaries.indexOf('missing_end_quote') < 0 &&
          row.boundaries.indexOf('holding_invalid') < 0) {
          row.boundaries.push('holding_invalid');
        }
        return row;
      }
      row.startValueLocalMinor = l0;
      row.endValueLocalMinor = l1;
      row.startValueCnyMinor = v0;
      row.endValueCnyMinor = v1;
      row.valueChangeCnyMinor = v1 - v0;
      if (row.boundaries.length > 0) return row; // 有过不去的边界：给出变化额，但不做分解
      var priceEffect = mulByRate(l1 - l0, startFx.rateDecimal);
      if (priceEffect == null) { row.boundaries.push('holding_invalid'); return row; }
      row.priceEffectCnyMinor = priceEffect;
      row.fxEffectCnyMinor = row.valueChangeCnyMinor - priceEffect; // 残差：保证两侧相加恒等于 ΔV
      row.attributable = true;
      return row;
    }) : [];

    var totals = {
      rowCount: rows.length,
      attributableCount: 0,
      boundaryCount: 0,
      startValueCnyMinor: 0,
      endValueCnyMinor: 0,
      valueChangeCnyMinor: 0,
      priceEffectCnyMinor: 0,
      fxEffectCnyMinor: 0,
      unattributedChangeCnyMinor: 0
    };
    rows.forEach(function (r) {
      if (typeof r.startValueCnyMinor === 'number') totals.startValueCnyMinor += r.startValueCnyMinor;
      if (typeof r.endValueCnyMinor === 'number') totals.endValueCnyMinor += r.endValueCnyMinor;
      if (typeof r.valueChangeCnyMinor === 'number') totals.valueChangeCnyMinor += r.valueChangeCnyMinor;
      if (r.attributable) {
        totals.attributableCount += 1;
        totals.priceEffectCnyMinor += r.priceEffectCnyMinor;
        totals.fxEffectCnyMinor += r.fxEffectCnyMinor;
      } else {
        totals.boundaryCount += 1;
        if (typeof r.valueChangeCnyMinor === 'number') totals.unattributedChangeCnyMinor += r.valueChangeCnyMinor;
      }
    });

    return {
      asOf: now,
      baseline: baseline ? {
        asOf: baseline.asOf || null,
        month: baseline.month || null,
        closeId: baseline.closeId || null,
        snapshotId: baseline.snapshotId || null,
        payloadHash: baseline.payloadHash || null,
        status: baseline.status || null,
        positionsCount: Array.isArray(baseline.positions) ? baseline.positions.length : null,
        detailsUnavailable: baseline.detailsUnavailable || null
      } : null,
      rows: rows,
      // 整段不可用的原因：no_baseline（没有更早的已结账月）/ baseline_details_missing
      // （基准快照给不出封存的逐持仓明细）/ baseline_hash_mismatch（快照内容与封存哈希不符）。
      // 界面据此说"为什么算不了"，不给任何按今天口径倒推的数字。
      unavailable: !baselineAsOf ? 'no_baseline' : startUnavailable,
      totals: totals,
      valuation: {
        valuationStatus: overview.valuationStatus,
        canAdvise: overview.canAdvise,
        freshness: overview.freshness
      },
      blockers: overview.blockers
    };
  }

  // emergencyCoverageMonths(safetyMinor, avgNecessaryMinor) → 应急金覆盖月数。
  //   安全储备 ÷ 月均必要支出，保留 1 位小数；无法估算（必要支出为 0/非法或储备未知）→ null。
  function emergencyCoverageMonths(safetyMinor, avgNecessaryMinor) {
    if (typeof safetyMinor !== 'number' || !isFinite(safetyMinor)) return null;
    if (typeof avgNecessaryMinor !== 'number' || !isFinite(avgNecessaryMinor) || avgNecessaryMinor <= 0) return null;
    return Math.round((safetyMinor / avgNecessaryMinor) * 10) / 10;
  }

  /* ------------------- 风险问卷规则与配置契约（Phase 5A，D-046） -------------------
   * 5A 只冻结规则：不建表、不开接口、不改页面。
   * 本段是题目 / 分值 / 等级边界 / 硬封顶 / 目标模板 / 契约形状的**唯一机器可读定义**，
   * 浏览器与服务端共用同一份（D-025）。任何规则变更都必须升 RISK_RULE_VERSION：
   * 历史评估永远带着它当时的版本可读，绝不用新规则静默重算旧答案（不变量 10）。
   */

  var RISK_RULE_VERSION = 'risk-rules-v1';      // 题目与评分规则版本
  var RISK_TARGET_VERSION = 'risk-targets-v1';  // 目标区间模板版本
  var BPS_TOTAL = 10000;                        // 比例一律 basis points 定点整数：100% = 10000（不变量 8）

  var CAPACITY_DIMENSIONS = ['income_stability', 'emergency_fund', 'debt_pressure', 'horizon', 'liquidity_need'];
  var WILLINGNESS_DIMENSIONS = ['experience', 'knowledge', 'drawdown_tolerance', 'fx_understanding'];
  var RISK_LEVELS = [1, 2, 3, 4, 5];

  // 题库：稳定题目 id + 选项 id + 分值；持久化只认 id，显示文案属本地知识卡（5E，explainKey）。
  // 不采集年龄 / 性别等与承受能力无因果的变量。
  var RISK_QUESTIONS = [
    {
      id: 'q_income_stability', kind: 'capacity', dimension: 'income_stability', explainKey: 'card-income-stability',
      options: [
        { id: 'o_fixed_stable', score: 3 },
        { id: 'o_variable_predictable', score: 2 },
        { id: 'o_irregular', score: 1 },
        { id: 'o_no_stable_income', score: 0 }
      ]
    },
    {
      id: 'q_emergency_fund', kind: 'capacity', dimension: 'emergency_fund', explainKey: 'card-emergency-fund',
      options: [
        { id: 'o_cover_12m_plus', score: 3 },
        { id: 'o_cover_6_12m', score: 2 },
        { id: 'o_cover_3_6m', score: 1 },
        { id: 'o_cover_under_3m', score: 0 }
      ]
    },
    {
      id: 'q_debt_pressure', kind: 'capacity', dimension: 'debt_pressure', explainKey: 'card-debt-pressure',
      options: [
        { id: 'o_no_debt', score: 3 },
        { id: 'o_manageable', score: 2 },
        { id: 'o_heavy', score: 1 },
        { id: 'o_current_due_or_overdue', score: 0 }
      ]
    },
    {
      id: 'q_horizon', kind: 'capacity', dimension: 'horizon', explainKey: 'card-horizon',
      options: [
        { id: 'o_horizon_10y_plus', score: 3 },
        { id: 'o_horizon_5_10y', score: 2 },
        { id: 'o_horizon_3_5y', score: 1 },
        { id: 'o_horizon_under_3y', score: 0 }
      ]
    },
    {
      id: 'q_liquidity_need', kind: 'capacity', dimension: 'liquidity_need', explainKey: 'card-liquidity-need',
      options: [
        { id: 'o_no_need', score: 3 },
        { id: 'o_minor_need', score: 2 },
        { id: 'o_planned_1_3y', score: 1 },
        { id: 'o_large_within_1y', score: 0 }
      ]
    },
    {
      id: 'q_experience', kind: 'willingness', dimension: 'experience', explainKey: 'card-experience',
      options: [
        { id: 'o_exp_5y_plus', score: 3 },
        { id: 'o_exp_2_5y', score: 2 },
        { id: 'o_exp_under_2y', score: 1 },
        { id: 'o_exp_none', score: 0 }
      ]
    },
    {
      id: 'q_knowledge', kind: 'willingness', dimension: 'knowledge', explainKey: 'card-knowledge',
      options: [
        { id: 'o_know_solid', score: 3 },
        { id: 'o_know_basic', score: 2 },
        { id: 'o_know_limited', score: 1 },
        { id: 'o_know_none', score: 0 }
      ]
    },
    {
      id: 'q_drawdown_tolerance', kind: 'willingness', dimension: 'drawdown_tolerance', explainKey: 'card-drawdown',
      options: [
        { id: 'o_dd_over_30', score: 3 },
        { id: 'o_dd_20_30', score: 2 },
        { id: 'o_dd_10_20', score: 1 },
        { id: 'o_dd_under_10', score: 0 }
      ]
    },
    {
      id: 'q_fx_understanding', kind: 'willingness', dimension: 'fx_understanding', explainKey: 'card-fx-risk',
      options: [
        { id: 'o_fx_clear', score: 3 },
        { id: 'o_fx_partial', score: 2 },
        { id: 'o_fx_limited', score: 1 },
        { id: 'o_fx_none', score: 0 }
      ]
    }
  ];

  // 分段边界：**下界含入**（score >= minScore 即归入该级），临界值只有一种归属（不变量 6）。
  // 能力分域 0–15（5 题 × 3 分），意愿分域 0–12（4 题 × 3 分）。
  var CAPACITY_LEVEL_BOUNDS = [
    { level: 1, minScore: 0 }, { level: 2, minScore: 4 }, { level: 3, minScore: 7 },
    { level: 4, minScore: 10 }, { level: 5, minScore: 13 }
  ];
  var WILLINGNESS_LEVEL_BOUNDS = [
    { level: 1, minScore: 0 }, { level: 2, minScore: 3 }, { level: 3, minScore: 6 },
    { level: 4, minScore: 9 }, { level: 5, minScore: 11 }
  ];

  // 硬封顶：关键短板优先于总分，只**降低**上限、绝不提高；高意愿不能抵消（不变量 1）。
  // maxOptionScore 是该题的最差档分值：命中即把风险上限压到 maxLevel。
  var RISK_HARD_CAPS = [
    { code: 'hard_cap_emergency_fund', questionId: 'q_emergency_fund', maxOptionScore: 0, maxLevel: 2, explainKey: 'card-emergency-fund' },
    { code: 'hard_cap_income_stability', questionId: 'q_income_stability', maxOptionScore: 0, maxLevel: 2, explainKey: 'card-income-stability' },
    { code: 'hard_cap_liquidity_need', questionId: 'q_liquidity_need', maxOptionScore: 0, maxLevel: 2, explainKey: 'card-liquidity-need' },
    { code: 'hard_cap_debt_pressure', questionId: 'q_debt_pressure', maxOptionScore: 0, maxLevel: 2, explainKey: 'card-debt-pressure' }
  ];

  // 目标模板：分母是**可投资资产**（D-011，不变量 2），cash 指投资池内的现金，不含安全储备。
  // 每级 ΣtargetBps 恒为 10000；ΣminBps <= 10000 <= ΣmaxBps（否则区间无法同时满足）。
  // 个股（stock）target 恒为 0：D-018 不做具体股票购买建议，只给用户既有持仓留容忍上限。
  var TARGET_TEMPLATES = [
    {
      level: 1, templateVersion: RISK_TARGET_VERSION, classes: {
        cash: { minBps: 4000, targetBps: 5000, maxBps: 6500 },
        fixed_income: { minBps: 3000, targetBps: 4000, maxBps: 5500 },
        broad_equity: { minBps: 0, targetBps: 1000, maxBps: 1500 },
        theme_equity: { minBps: 0, targetBps: 0, maxBps: 500 },
        stock: { minBps: 0, targetBps: 0, maxBps: 0 },
        other: { minBps: 0, targetBps: 0, maxBps: 1000 }
      }
    },
    {
      level: 2, templateVersion: RISK_TARGET_VERSION, classes: {
        cash: { minBps: 2500, targetBps: 3500, maxBps: 5000 },
        fixed_income: { minBps: 3500, targetBps: 4500, maxBps: 6000 },
        broad_equity: { minBps: 1000, targetBps: 1500, maxBps: 2500 },
        theme_equity: { minBps: 0, targetBps: 500, maxBps: 1000 },
        stock: { minBps: 0, targetBps: 0, maxBps: 0 },
        other: { minBps: 0, targetBps: 0, maxBps: 1000 }
      }
    },
    {
      level: 3, templateVersion: RISK_TARGET_VERSION, classes: {
        cash: { minBps: 1500, targetBps: 2000, maxBps: 3500 },
        fixed_income: { minBps: 2000, targetBps: 3000, maxBps: 4500 },
        broad_equity: { minBps: 3000, targetBps: 4000, maxBps: 5000 },
        theme_equity: { minBps: 500, targetBps: 1000, maxBps: 2000 },
        stock: { minBps: 0, targetBps: 0, maxBps: 1000 },
        other: { minBps: 0, targetBps: 0, maxBps: 1000 }
      }
    },
    {
      level: 4, templateVersion: RISK_TARGET_VERSION, classes: {
        cash: { minBps: 1000, targetBps: 1500, maxBps: 2500 },
        fixed_income: { minBps: 1000, targetBps: 1500, maxBps: 3000 },
        broad_equity: { minBps: 4500, targetBps: 5500, maxBps: 6500 },
        theme_equity: { minBps: 1000, targetBps: 1500, maxBps: 2500 },
        stock: { minBps: 0, targetBps: 0, maxBps: 1000 },
        other: { minBps: 0, targetBps: 0, maxBps: 1000 }
      }
    },
    {
      level: 5, templateVersion: RISK_TARGET_VERSION, classes: {
        cash: { minBps: 500, targetBps: 1000, maxBps: 2000 },
        fixed_income: { minBps: 500, targetBps: 1000, maxBps: 2500 },
        broad_equity: { minBps: 5500, targetBps: 6500, maxBps: 7500 },
        theme_equity: { minBps: 1500, targetBps: 1500, maxBps: 3000 },
        stock: { minBps: 0, targetBps: 0, maxBps: 1500 },
        other: { minBps: 0, targetBps: 0, maxBps: 1000 }
      }
    }
  ];

  // 容忍带：端点**含入**区间（minBps <= pct <= maxBps → within），边界归属唯一。
  var TOLERANCE_BANDS = ['below_min', 'within', 'above_max'];

  var ASSESSMENT_VALID_DAYS = 365;      // 正常有效期一年（D-015）
  var ASSESSMENT_EXPIRING_DAYS = 30;    // 到期前 30 天进入「即将到期」
  var ASSESSMENT_STATUSES = ['valid', 'expiring_soon', 'expired'];

  // 复评原因词表：市场涨跌**不在**其中（PRODUCT §8 / D-015），
  // 不得凭行情波动触发降级或复评 —— 未知原因一律拒绝。
  var REASSESS_REASONS = [
    'initial', 'annual_expired', 'income_change', 'debt_change',
    'overseas_status_change', 'major_goal_change', 'liquidity_change', 'manual'
  ];

  // 稳定错误码：5A 只冻结词表（HTTP 映射属 5B）；缺答 / 未知选项一律 fail closed，不猜默认值。
  var RISK_ERROR_CODES = [
    'invalid_answers', 'unknown_question', 'unknown_option', 'duplicate_answer', 'missing_answer',
    'invalid_assessment_date', 'invalid_reassess_reason', 'invalid_rule_version',
    'invalid_target_template', 'invalid_proportion', 'invalid_new_funds',
    'invalid_snapshot_ref', 'invalid_assessment_ref', 'invalid_approved_instruments'
  ];

  // 建议契约（5D 实现算法、5B/5E 消费）：输入只带引用与用户判断，派生值一律由服务端重算。
  var RECOMMENDATION_STATUSES = ['formal', 'estimate'];
  var RECOMMENDATION_INPUT_KEYS = [
    'snapshotRef', 'assessmentRef', 'targetVersion', 'ruleVersion', 'newFundsMinor', 'approvedInstruments'
  ];
  var RECOMMENDATION_OUTPUT_KEYS = [
    'status', 'blockers', 'dataCutoff', 'currentAllocation', 'targetRanges',
    'deviations', 'categoryAllocations', 'roundingNote', 'explainCodes', 'versions'
  ];
  // 排序与尾差的稳定键：类别恒按 RISK_CLASSES 序，缺口降序在前，同缺口按该序 → 与对象/数据库行序无关。
  var ALLOCATION_ROUNDING_RULE = '缺口降序 → 同缺口按排列顺序 → 逐类别取整后余额给排序最前者';

  function riskCopy(x) { return JSON.parse(JSON.stringify(x)); }

  function isRiskObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function isRiskNonEmptyString(v) { return typeof v === 'string' && v.trim() !== ''; }

  function isRiskNonNegInt(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0;
  }

  function isRiskHex64(v) { return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v); }

  // 真实日历日校验（与 server/providers/contract.js 的 isDateString 同口径：月份范围 + 回读一致）。
  // 只校验形状正则会放过 2026-02-30 这类不存在的日期（G4C-5 的教训）。
  function isCalendarDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8, 10));
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function findRiskQuestion(id) {
    for (var i = 0; i < RISK_QUESTIONS.length; i++) if (RISK_QUESTIONS[i].id === id) return RISK_QUESTIONS[i];
    return null;
  }

  // 边界查表：下界含入，返回 <= score 的最大 level（越界向上封顶在最高级）。
  function levelFromBounds(bounds, score) {
    if (!isRiskNonNegInt(score)) return null;
    var out = null;
    for (var i = 0; i < bounds.length; i++) if (score >= bounds[i].minScore) out = bounds[i].level;
    return out;
  }

  // 规则目录（只读副本）：5B 落库、5E 解释卡都从这里取唯一一份定义。
  function riskCatalog() {
    return riskCopy({
      ruleVersion: RISK_RULE_VERSION,
      targetVersion: RISK_TARGET_VERSION,
      capacityDimensions: CAPACITY_DIMENSIONS,
      willingnessDimensions: WILLINGNESS_DIMENSIONS,
      questions: RISK_QUESTIONS,
      capacityLevelBounds: CAPACITY_LEVEL_BOUNDS,
      willingnessLevelBounds: WILLINGNESS_LEVEL_BOUNDS,
      hardCaps: RISK_HARD_CAPS,
      levels: RISK_LEVELS,
      toleranceBands: TOLERANCE_BANDS,
      validDays: ASSESSMENT_VALID_DAYS,
      expiringDays: ASSESSMENT_EXPIRING_DAYS,
      assessmentStatuses: ASSESSMENT_STATUSES,
      reassessReasons: REASSESS_REASONS,
      errorCodes: RISK_ERROR_CODES,
      bpsTotal: BPS_TOTAL
    });
  }

  // 答案校验：fail closed。detail 只报「第 N 项」或缺失数量，不回显用户输入原文。
  function validateRiskAnswers(answers) {
    if (!Array.isArray(answers)) {
      return { ok: false, error: { code: 'invalid_answers', detail: 'answers 必须是数组' } };
    }
    var seen = {}, picked = [];
    for (var i = 0; i < answers.length; i++) {
      var row = answers[i];
      if (!isRiskObject(row)) {
        return { ok: false, error: { code: 'invalid_answers', detail: '第 ' + (i + 1) + ' 项不是对象' } };
      }
      if (!isRiskNonEmptyString(row.questionId)) {
        return { ok: false, error: { code: 'invalid_answers', detail: '第 ' + (i + 1) + ' 项缺少 questionId' } };
      }
      var q = findRiskQuestion(row.questionId);
      if (!q) {
        return { ok: false, error: { code: 'unknown_question', detail: '第 ' + (i + 1) + ' 项不是本规则版本定义的题目' } };
      }
      if (seen[q.id]) {
        return { ok: false, error: { code: 'duplicate_answer', detail: '第 ' + (i + 1) + ' 项重复回答同一题' } };
      }
      if (!isRiskNonEmptyString(row.optionId)) {
        return { ok: false, error: { code: 'invalid_answers', detail: '第 ' + (i + 1) + ' 项缺少 optionId' } };
      }
      var opt = null;
      for (var j = 0; j < q.options.length; j++) if (q.options[j].id === row.optionId) opt = q.options[j];
      if (!opt) {
        return { ok: false, error: { code: 'unknown_option', detail: '第 ' + (i + 1) + ' 项的选项不属于该题' } };
      }
      seen[q.id] = true;
      picked.push({ questionId: q.id, optionId: opt.id, score: opt.score, kind: q.kind, dimension: q.dimension });
    }
    if (picked.length !== RISK_QUESTIONS.length) {
      return { ok: false, error: { code: 'missing_answer', detail: '缺少 ' + (RISK_QUESTIONS.length - picked.length) + ' 道题的回答' } };
    }
    return { ok: true, answers: picked };
  }

  // 双评分 + 硬封顶 + 风险上限。上限恒为「较低的那一侧」，硬封顶只能再压低。
  function scoreRiskAnswers(answers) {
    var v = validateRiskAnswers(answers);
    if (!v.ok) return v;
    var capacityScore = 0, willingnessScore = 0, byQuestion = {};
    v.answers.forEach(function (a) {
      byQuestion[a.questionId] = a;
      if (a.kind === 'capacity') capacityScore += a.score; else willingnessScore += a.score;
    });
    var capacityLevel = levelFromBounds(CAPACITY_LEVEL_BOUNDS, capacityScore);
    var willingnessLevel = levelFromBounds(WILLINGNESS_LEVEL_BOUNDS, willingnessScore);
    var ceiling = Math.min(capacityLevel, willingnessLevel);
    var ceilingSource = capacityLevel === willingnessLevel ? 'equal'
      : (capacityLevel < willingnessLevel ? 'capacity' : 'willingness');
    var hardCaps = [];
    RISK_HARD_CAPS.forEach(function (cap) {
      var hit = byQuestion[cap.questionId];
      if (hit && hit.score <= cap.maxOptionScore) {
        hardCaps.push({ code: cap.code, maxLevel: cap.maxLevel, explainKey: cap.explainKey });
        if (cap.maxLevel < ceiling) { ceiling = cap.maxLevel; ceilingSource = 'hard_cap'; }
      }
    });
    return {
      ok: true,
      ruleVersion: RISK_RULE_VERSION,
      capacityScore: capacityScore,
      willingnessScore: willingnessScore,
      capacityLevel: capacityLevel,
      willingnessLevel: willingnessLevel,
      hardCaps: hardCaps,
      ceiling: ceiling,
      ceilingSource: ceilingSource,
      explainCodes: ['card-capacity-vs-willingness', 'card-lower-bound-rule'].concat(hardCaps.map(function (c) { return c.code; })),
      scored: v.answers
    };
  }

  // 有效期与复评状态：到期日**当天仍有效**（now <= expiry），次日失效；剩余 <= 30 天为即将到期。
  function assessmentValidity(assessedAt, now) {
    if (!isCalendarDate(assessedAt)) {
      return { ok: false, error: { code: 'invalid_assessment_date', detail: '评估日期必须是真实存在的 YYYY-MM-DD' } };
    }
    if (!isCalendarDate(now)) {
      return { ok: false, error: { code: 'invalid_assessment_date', detail: 'now 必须是真实存在的 YYYY-MM-DD' } };
    }
    var expiry = addCalendarDays(assessedAt, ASSESSMENT_VALID_DAYS);
    var remainingDays = daysBetween(now, expiry);
    var status = remainingDays < 0 ? 'expired' : (remainingDays <= ASSESSMENT_EXPIRING_DAYS ? 'expiring_soon' : 'valid');
    return { ok: true, assessedAt: assessedAt, now: now, expiry: expiry, remainingDays: remainingDays, status: status };
  }

  // 日历日加减（纯 UTC 毫秒运算，不读系统时钟）。
  function addCalendarDays(dateStr, days) {
    if (!isCalendarDate(dateStr) || typeof days !== 'number' || Math.floor(days) !== days) return null;
    var y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7)), d = Number(dateStr.slice(8, 10));
    var dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
    var mm = dt.getUTCMonth() + 1, dd = dt.getUTCDate();
    return dt.getUTCFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
  }

  function isReassessReason(v) { return REASSESS_REASONS.indexOf(v) !== -1; }

  // 目标模板合法性：类别不重不漏、0 <= min <= target <= max <= 100%、Σtarget 精确 100%、
  // Σmin <= 100% <= Σmax。比例非法只报「第 N 类」或类别名，不回显输入原文。
  function validateTargetTemplate(tpl) {
    if (!isRiskObject(tpl) || !isRiskObject(tpl.classes)) {
      return { ok: false, error: { code: 'invalid_target_template', detail: '模板必须带 classes 对象' } };
    }
    var targetSum = 0, minSum = 0, maxSum = 0;
    for (var i = 0; i < RISK_CLASSES.length; i++) {
      var cls = RISK_CLASSES[i];
      var row = tpl.classes[cls];
      if (!isRiskObject(row)) {
        return { ok: false, error: { code: 'invalid_target_template', detail: '缺少资产类别：' + cls } };
      }
      var keys = ['minBps', 'targetBps', 'maxBps'];
      for (var k = 0; k < keys.length; k++) {
        if (!isRiskNonNegInt(row[keys[k]]) || row[keys[k]] > BPS_TOTAL) {
          return { ok: false, error: { code: 'invalid_proportion', detail: '类别 ' + cls + ' 的 ' + keys[k] + ' 非法' } };
        }
      }
      if (row.minBps > row.targetBps || row.targetBps > row.maxBps) {
        return { ok: false, error: { code: 'invalid_proportion', detail: '类别 ' + cls + ' 不满足 min <= target <= max' } };
      }
      minSum += row.minBps; targetSum += row.targetBps; maxSum += row.maxBps;
    }
    if (targetSum !== BPS_TOTAL) {
      return { ok: false, error: { code: 'invalid_proportion', detail: '各类 targetBps 合计必须精确为 ' + BPS_TOTAL } };
    }
    if (minSum > BPS_TOTAL || maxSum < BPS_TOTAL) {
      return { ok: false, error: { code: 'invalid_proportion', detail: '必须满足 Σmin <= ' + BPS_TOTAL + ' <= Σmax' } };
    }
    return { ok: true };
  }

  function targetTemplateForLevel(level) {
    for (var i = 0; i < TARGET_TEMPLATES.length; i++) if (TARGET_TEMPLATES[i].level === level) return riskCopy(TARGET_TEMPLATES[i]);
    return null;
  }

  // 容忍带：端点含入区间。
  function compareToRange(pctBps, minBps, maxBps) {
    if (!isRiskNonNegInt(pctBps) || !isRiskNonNegInt(minBps) || !isRiskNonNegInt(maxBps)) return null;
    if (minBps > maxBps) return null;
    if (pctBps < minBps) return 'below_min';
    if (pctBps > maxBps) return 'above_max';
    return 'within';
  }

  // 建议输入契约：只校验形状与引用完整性，不采信任何派生值（当前比例 / 分数 / 等级 / blocker 一律由服务端重算）。
  function validateRecommendationRequest(payload) {
    if (!isRiskObject(payload)) return { ok: false, error: { code: 'invalid_snapshot_ref', detail: '请求体必须是对象' } };
    var snap = payload.snapshotRef;
    if (!isRiskObject(snap) || !isRiskNonEmptyString(snap.closeId) || !isRiskNonEmptyString(snap.snapshotId) || !isRiskHex64(snap.payloadHash)) {
      return { ok: false, error: { code: 'invalid_snapshot_ref', detail: 'snapshotRef 必须带 closeId / snapshotId / 64 位十六进制 payloadHash' } };
    }
    var at = payload.assessmentRef;
    if (!isRiskObject(at) || !isRiskNonEmptyString(at.id) || !isRiskNonEmptyString(at.ruleVersion)) {
      return { ok: false, error: { code: 'invalid_assessment_ref', detail: 'assessmentRef 必须带 id 与 ruleVersion' } };
    }
    if (at.ruleVersion !== RISK_RULE_VERSION) {
      return { ok: false, error: { code: 'invalid_rule_version', detail: '评估所用规则版本不是当前可用版本' } };
    }
    if (payload.ruleVersion !== RISK_RULE_VERSION) {
      return { ok: false, error: { code: 'invalid_rule_version', detail: 'ruleVersion 与当前规则版本不一致' } };
    }
    if (!isRiskNonEmptyString(payload.targetVersion)) {
      return { ok: false, error: { code: 'invalid_target_template', detail: 'targetVersion 必填' } };
    }
    if (!isRiskNonNegInt(payload.newFundsMinor)) {
      return { ok: false, error: { code: 'invalid_new_funds', detail: 'newFundsMinor 必须是非负整数（最小货币单位）' } };
    }
    var map = payload.approvedInstruments;
    if (map == null) return { ok: true, approvedInstruments: {} };
    if (!isRiskObject(map)) {
      return { ok: false, error: { code: 'invalid_approved_instruments', detail: 'approvedInstruments 必须是「类别 → 标的 id 数组」对象' } };
    }
    var out = {};
    for (var i = 0; i < RISK_CLASSES.length; i++) {
      var cls = RISK_CLASSES[i];
      if (map[cls] == null) continue;
      if (!Array.isArray(map[cls])) {
        return { ok: false, error: { code: 'invalid_approved_instruments', detail: '类别 ' + cls + ' 的映射必须是数组' } };
      }
      for (var j = 0; j < map[cls].length; j++) {
        if (!isRiskNonEmptyString(map[cls][j])) {
          return { ok: false, error: { code: 'invalid_approved_instruments', detail: '类别 ' + cls + ' 第 ' + (j + 1) + ' 个标的不合法' } };
        }
      }
      out[cls] = map[cls].slice();
    }
    for (var key in map) {
      if (Object.prototype.hasOwnProperty.call(map, key) && RISK_CLASSES.indexOf(key) === -1) {
        return { ok: false, error: { code: 'invalid_approved_instruments', detail: '出现未知资产类别：' + key } };
      }
    }
    return { ok: true, approvedInstruments: out };
  }

  // 契约快照：5B / 5D / 5E 从这里取键集合与排序规则，避免各处硬编码分叉。
  function recommendationContract() {
    return riskCopy({
      inputKeys: RECOMMENDATION_INPUT_KEYS,
      outputKeys: RECOMMENDATION_OUTPUT_KEYS,
      statuses: RECOMMENDATION_STATUSES,
      allocationOrder: RISK_CLASSES,
      roundingRule: ALLOCATION_ROUNDING_RULE,
      toleranceBands: TOLERANCE_BANDS,
      ruleVersion: RISK_RULE_VERSION,
      targetVersion: RISK_TARGET_VERSION,
      bpsTotal: BPS_TOTAL
    });
  }

  return {
    CURRENCIES: CURRENCIES,
    POOLS: POOLS,
    RISK_CLASSES: RISK_CLASSES,
    EXPOSURE_MARKETS: EXPOSURE_MARKETS,
    SECURITY_EVENT_TYPES: SECURITY_EVENT_TYPES,
    MANUAL_PROVIDER: MANUAL_PROVIDER,
    MARKET_SCOPES: MARKET_SCOPES,
    marketElementKey: marketElementKey,
    planMarketMerge: planMarketMerge,
    requiredQuoteSymbols: requiredQuoteSymbols,
    requiredFxPairs: requiredFxPairs,
    ASSET_KEYS: ASSET_KEYS,
    MAX_STALE_DAYS: MAX_STALE_DAYS,
    isAssetClass: isAssetClass,
    isExposureMarket: isExposureMarket,
    instrumentKey: instrumentKey,
    diffInstrumentFields: diffInstrumentFields,
    suggestFromProvider: suggestFromProvider,
    USER_JUDGEMENT_FIELDS: USER_JUDGEMENT_FIELDS,
    parseDecimal: parseDecimal,
    mulMinor: mulMinor,
    mulByRate: mulByRate,
    formatDecimal: formatDecimal,
    compareDecimals: compareDecimals,
    sumQuantities: sumQuantities,
    subtractQuantities: subtractQuantities,
    deriveHoldings: deriveHoldings,
    holdingKey: holdingKey,
    holdingsAsOf: holdingsAsOf,
    findQuoteAsOf: findQuoteAsOf,
    findFxRateAsOf: findFxRateAsOf,
    convertToCny: convertToCny,
    MARKET_UNSPECIFIED: MARKET_UNSPECIFIED,
    computeAssetDrilldown: computeAssetDrilldown,
    computeAttributionBaselinePositions: computeAttributionBaselinePositions,
    baselinePositionsFromSnapshot: baselinePositionsFromSnapshot,
    computeReturnAttribution: computeReturnAttribution,
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
    emergencyCoverageMonths: emergencyCoverageMonths,
    /* Phase 5A：风险问卷规则与配置契约（D-046）—— 规则数据与纯契约函数，无存储 / API / 页面依赖 */
    RISK_RULE_VERSION: RISK_RULE_VERSION,
    RISK_TARGET_VERSION: RISK_TARGET_VERSION,
    BPS_TOTAL: BPS_TOTAL,
    RISK_LEVELS: RISK_LEVELS,
    CAPACITY_DIMENSIONS: CAPACITY_DIMENSIONS,
    WILLINGNESS_DIMENSIONS: WILLINGNESS_DIMENSIONS,
    RISK_QUESTIONS: RISK_QUESTIONS,
    CAPACITY_LEVEL_BOUNDS: CAPACITY_LEVEL_BOUNDS,
    WILLINGNESS_LEVEL_BOUNDS: WILLINGNESS_LEVEL_BOUNDS,
    RISK_HARD_CAPS: RISK_HARD_CAPS,
    TARGET_TEMPLATES: TARGET_TEMPLATES,
    TOLERANCE_BANDS: TOLERANCE_BANDS,
    ASSESSMENT_VALID_DAYS: ASSESSMENT_VALID_DAYS,
    ASSESSMENT_EXPIRING_DAYS: ASSESSMENT_EXPIRING_DAYS,
    ASSESSMENT_STATUSES: ASSESSMENT_STATUSES,
    REASSESS_REASONS: REASSESS_REASONS,
    RISK_ERROR_CODES: RISK_ERROR_CODES,
    RECOMMENDATION_STATUSES: RECOMMENDATION_STATUSES,
    RECOMMENDATION_INPUT_KEYS: RECOMMENDATION_INPUT_KEYS,
    RECOMMENDATION_OUTPUT_KEYS: RECOMMENDATION_OUTPUT_KEYS,
    ALLOCATION_ROUNDING_RULE: ALLOCATION_ROUNDING_RULE,
    riskCatalog: riskCatalog,
    isCalendarDate: isCalendarDate,
    addCalendarDays: addCalendarDays,
    validateRiskAnswers: validateRiskAnswers,
    scoreRiskAnswers: scoreRiskAnswers,
    assessmentValidity: assessmentValidity,
    isReassessReason: isReassessReason,
    validateTargetTemplate: validateTargetTemplate,
    targetTemplateForLevel: targetTemplateForLevel,
    compareToRange: compareToRange,
    validateRecommendationRequest: validateRecommendationRequest,
    recommendationContract: recommendationContract
  };
});
