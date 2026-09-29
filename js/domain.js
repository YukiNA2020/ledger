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

  // 稳定错误码：5A 冻结词表，5B 落地 HTTP 状态映射（server/api.js 的 DOMAIN_ERROR_STATUS）；
  // 缺答 / 未知选项一律 fail closed，不猜默认值。
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

  // 规则常量**深度冻结**（G5A-1 补口）：5A 的规则是「唯一机器可读定义」，
  // 同一 RISK_RULE_VERSION 下相同答案必须永远算出相同结果；只要对外引用可写，
  // 调用方一行原地赋值就能让 15 分变成 12 分而版本号不变（不变量 10 失效）。
  // 冻结必须递归到嵌套层：只冻第一层等于没冻（`RISK_QUESTIONS[0].options[0].score = 0` 仍能生效）。
  // 需要可写副本的调用方走 riskCatalog() / targetTemplateForLevel()——它们返回深拷贝。
  function deepFreezeRisk(v) {
    if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v;
    Object.freeze(v);
    Object.keys(v).forEach(function (k) { deepFreezeRisk(v[k]); });
    return v;
  }

  [
    RISK_CLASSES, RISK_LEVELS, CAPACITY_DIMENSIONS, WILLINGNESS_DIMENSIONS,
    RISK_QUESTIONS, CAPACITY_LEVEL_BOUNDS, WILLINGNESS_LEVEL_BOUNDS, RISK_HARD_CAPS,
    TARGET_TEMPLATES, TOLERANCE_BANDS, ASSESSMENT_STATUSES, REASSESS_REASONS,
    RISK_ERROR_CODES, RECOMMENDATION_STATUSES, RECOMMENDATION_INPUT_KEYS, RECOMMENDATION_OUTPUT_KEYS
  ].forEach(deepFreezeRisk);

  function riskCopy(x) { return JSON.parse(JSON.stringify(x)); }

  function isRiskObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function isRiskNonEmptyString(v) { return typeof v === 'string' && v.trim() !== ''; }

  function isRiskNonNegInt(v) {
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  }

  function isRiskHex64(v) { return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v); }

  // 对象契约采用显式白名单：只允许 Object.prototype / null 原型、可枚举自有数据属性和精确键集合。
  function hasExactRiskKeys(v, allowed, required) {
    if (!isRiskObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    var own = Object.getOwnPropertyNames(v);
    if (typeof Object.getOwnPropertySymbols === 'function' && Object.getOwnPropertySymbols(v).length) return false;
    for (var i = 0; i < own.length; i++) {
      if (allowed.indexOf(own[i]) === -1) return false;
      var descriptor = Object.getOwnPropertyDescriptor(v, own[i]);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
    }
    for (var j = 0; j < required.length; j++) {
      if (!Object.prototype.hasOwnProperty.call(v, required[j])) return false;
    }
    for (var key in v) if (!Object.prototype.hasOwnProperty.call(v, key)) return false;
    return true;
  }

  function copyRiskDenseDataArray(v) {
    if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return null;
    if (typeof Object.getOwnPropertySymbols === 'function' && Object.getOwnPropertySymbols(v).length) return null;
    var names = Object.getOwnPropertyNames(v);
    if (names.length !== v.length + 1 || names.indexOf('length') === -1) return null;
    var copy = [];
    for (var i = 0; i < v.length; i++) {
      var descriptor = Object.getOwnPropertyDescriptor(v, String(i));
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      copy.push(descriptor.value);
    }
    return copy;
  }

  // 认可标的列表必须是普通、稠密、只含自有数据索引的数组；不读取实例方法或继承槽位。
  function copyRiskStringArray(v) {
    var copy = copyRiskDenseDataArray(v);
    if (copy === null) return null;
    for (var i = 0; i < copy.length; i++) if (!isRiskNonEmptyString(copy[i])) return null;
    return copy;
  }

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
    var answerRows = copyRiskDenseDataArray(answers);
    if (answerRows === null) {
      return { ok: false, error: { code: 'invalid_answers', detail: 'answers 必须是数组' } };
    }
    var seen = {}, pickedByQuestion = {};
    for (var i = 0; i < answerRows.length; i++) {
      var row = answerRows[i];
      if (!hasExactRiskKeys(row, ['questionId', 'optionId'], ['questionId', 'optionId'])) {
        return { ok: false, error: { code: 'invalid_answers', detail: '第 ' + (i + 1) + ' 项必须只含自有 questionId / optionId' } };
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
      pickedByQuestion[q.id] = { questionId: q.id, optionId: opt.id, score: opt.score, kind: q.kind, dimension: q.dimension };
    }
    if (answerRows.length !== RISK_QUESTIONS.length) {
      return { ok: false, error: { code: 'missing_answer', detail: '缺少 ' + (RISK_QUESTIONS.length - answerRows.length) + ' 道题的回答' } };
    }
    var picked = [];
    for (var p = 0; p < RISK_QUESTIONS.length; p++) picked.push(pickedByQuestion[RISK_QUESTIONS[p].id]);
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
    if (daysBetween(now, assessedAt) > 0) {
      return { ok: false, error: { code: 'invalid_assessment_date', detail: '评估日期不得晚于 now' } };
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
    if (!hasExactRiskKeys(tpl, ['level', 'templateVersion', 'classes'], ['level', 'templateVersion', 'classes'])
      || !hasExactRiskKeys(tpl.classes, RISK_CLASSES, RISK_CLASSES)) {
      return { ok: false, error: { code: 'invalid_target_template', detail: '模板必须带 classes 对象' } };
    }
    // 模板比例与元数据必须一起绑定：未知等级或版本不能借一组合法比例冒充受支持模板。
    if (!isRiskNonNegInt(tpl.level) || RISK_LEVELS.indexOf(tpl.level) === -1) {
      return { ok: false, error: { code: 'invalid_target_template', detail: 'level 不是当前支持的风险等级' } };
    }
    if (tpl.templateVersion !== RISK_TARGET_VERSION) {
      return { ok: false, error: { code: 'invalid_target_template', detail: 'templateVersion 不是当前支持的目标模板版本' } };
    }
    // 类别映射已在入口按冻结词表做精确自有数据键校验；这里只验证每一行的比例约束。
    var targetSum = 0, minSum = 0, maxSum = 0;
    for (var i = 0; i < RISK_CLASSES.length; i++) {
      var cls = RISK_CLASSES[i];
      var row = tpl.classes[cls];
      if (!hasExactRiskKeys(row, ['minBps', 'targetBps', 'maxBps'], ['minBps', 'targetBps', 'maxBps'])) {
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
    // 当前 targetVersion 对每个风险等级只允许一份冻结模板。只验证“比例自洽”会让调用方
    // 在 risk-targets-v1 下悄悄换一组同样合计 100% 的比例，破坏版本可复算性。
    var registered = null;
    for (var t = 0; t < TARGET_TEMPLATES.length; t++) {
      if (TARGET_TEMPLATES[t].level === tpl.level) { registered = TARGET_TEMPLATES[t]; break; }
    }
    if (!registered) {
      return { ok: false, error: { code: 'invalid_target_template', detail: '当前版本没有该风险等级的目标模板' } };
    }
    for (var c = 0; c < RISK_CLASSES.length; c++) {
      var className = RISK_CLASSES[c];
      var actual = tpl.classes[className], expected = registered.classes[className];
      if (actual.minBps !== expected.minBps || actual.targetBps !== expected.targetBps || actual.maxBps !== expected.maxBps) {
        return { ok: false, error: { code: 'invalid_target_template', detail: '模板内容与当前 targetVersion 的冻结定义不一致' } };
      }
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
    var requiredInputKeys = ['snapshotRef', 'assessmentRef', 'targetVersion', 'ruleVersion', 'newFundsMinor'];
    if (!hasExactRiskKeys(payload, RECOMMENDATION_INPUT_KEYS, requiredInputKeys)) {
      return { ok: false, error: { code: 'invalid_snapshot_ref', detail: '请求体键集合不符合建议输入契约' } };
    }
    var snap = payload.snapshotRef;
    if (!hasExactRiskKeys(snap, ['closeId', 'snapshotId', 'payloadHash'], ['closeId', 'snapshotId', 'payloadHash'])
      || !isRiskNonEmptyString(snap.closeId) || !isRiskNonEmptyString(snap.snapshotId) || !isRiskHex64(snap.payloadHash)) {
      return { ok: false, error: { code: 'invalid_snapshot_ref', detail: 'snapshotRef 必须带 closeId / snapshotId / 64 位十六进制 payloadHash' } };
    }
    var at = payload.assessmentRef;
    if (!hasExactRiskKeys(at, ['id', 'ruleVersion'], ['id', 'ruleVersion'])
      || !isRiskNonEmptyString(at.id) || !isRiskNonEmptyString(at.ruleVersion)) {
      return { ok: false, error: { code: 'invalid_assessment_ref', detail: 'assessmentRef 必须带 id 与 ruleVersion' } };
    }
    if (at.ruleVersion !== RISK_RULE_VERSION) {
      return { ok: false, error: { code: 'invalid_rule_version', detail: '评估所用规则版本不是当前可用版本' } };
    }
    if (payload.ruleVersion !== RISK_RULE_VERSION) {
      return { ok: false, error: { code: 'invalid_rule_version', detail: 'ruleVersion 与当前规则版本不一致' } };
    }
    // 目标模板版本必须**是当前可用版本**（G5A-2 补口）：5A 只冻结了 risk-targets-v1，
    // 「非空字符串」不足以挡住 risk-targets-unknown —— 那样 5D 会把不存在的模板版本
    // 当成正式建议的输入。将来支持历史模板时改为按显式版本目录解析，不得退回任意非空串。
    if (!isRiskNonEmptyString(payload.targetVersion) || payload.targetVersion !== RISK_TARGET_VERSION) {
      return { ok: false, error: { code: 'invalid_target_template', detail: 'targetVersion 不是当前可用的目标模板版本' } };
    }
    if (!isRiskNonNegInt(payload.newFundsMinor)) {
      return { ok: false, error: { code: 'invalid_new_funds', detail: 'newFundsMinor 必须是非负安全整数（最小货币单位）' } };
    }
    var map = payload.approvedInstruments;
    if (map == null) return { ok: true, approvedInstruments: {} };
    if (!hasExactRiskKeys(map, RISK_CLASSES, [])) {
      return { ok: false, error: { code: 'invalid_approved_instruments', detail: 'approvedInstruments 必须是「类别 → 标的 id 数组」对象' } };
    }
    var out = {};
    for (var i = 0; i < RISK_CLASSES.length; i++) {
      var cls = RISK_CLASSES[i];
      if (!Object.prototype.hasOwnProperty.call(map, cls)) continue;
      var copied = copyRiskStringArray(map[cls]);
      if (copied === null) {
        return { ok: false, error: { code: 'invalid_approved_instruments', detail: '类别 ' + cls + ' 的映射必须是普通、稠密的标的 id 数组' } };
      }
      out[cls] = copied;
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

  /* ------------------- 风险评估记录与复评机制（Phase 5B，D-047） -------------------
   * 5B 把 5A 冻结的规则做成可保存、可追溯、可到期的评估记录。本段仍是纯函数：
   * 不读存储、不发网络、不读系统时钟（`today` 一律由调用方传入，保证可复算，不变量 6）。
   * 客户端只提交原始答案、评估日期与复评原因；分数 / 等级 / 上限 / 到期日等派生值
   * 只能由本段（内部即 5A 的 scoreRiskAnswers）计算（5.3 门禁）。
   */

  // 提交载荷的精确键白名单：派生字段根本不在允许集合内，客户端伪装分数在入口即被拒绝。
  var RISK_ASSESSMENT_REQUEST_KEYS = ['answers', 'assessedAt', 'reason'];
  var RISK_ASSESSMENT_REQUEST_REQUIRED = ['answers', 'assessedAt', 'reason'];
  // 落库记录的精确键白名单（`id` 与审计字段由服务端/仓储在写入时绑定）。
  var RISK_ASSESSMENT_RECORD_KEYS = [
    'id', 'ruleVersion', 'answers', 'capacityScore', 'willingnessScore',
    'capacityLevel', 'willingnessLevel', 'ceiling', 'ceilingSource', 'hardCaps',
    'explainCodes', 'assessedAt', 'expiry', 'reason', 'createdAt'
  ];
  var RISK_ASSESSMENT_RECORD_REQUIRED = RISK_ASSESSMENT_RECORD_KEYS.slice();
  // 当前有效评估的判定态：没有一条未过期记录时的三种可区分结果。
  var RISKASSESS_SELECT_NONE_STATES = ['no_assessment', 'all_expired', 'invalid_records'];

  function riskassFail(code, detail) {
    return { ok: false, error: { code: code, detail: detail } };
  }

  // 问卷载荷校验：fail closed。除答案/日期/原因外的任何键（含显式 null 的派生字段）一律拒绝。
  function validateRiskAssessmentRequest(payload) {
    if (!hasExactRiskKeys(payload, RISK_ASSESSMENT_REQUEST_KEYS, RISK_ASSESSMENT_REQUEST_REQUIRED)) {
      return riskassFail('invalid_answers', '问卷载荷必须只包含自有数据字段 answers / assessedAt / reason');
    }
    if (copyRiskDenseDataArray(payload.answers) === null) {
      return riskassFail('invalid_answers', 'answers 必须是稠密的普通答案数组');
    }
    if (!isCalendarDate(payload.assessedAt)) {
      return riskassFail('invalid_assessment_date', '评估日期必须是真实存在的 YYYY-MM-DD');
    }
    if (!isRiskNonEmptyString(payload.reason)) {
      return riskassFail('invalid_reassess_reason', '复评原因必须是非空字符串');
    }
    return { ok: true };
  }

  // 本地日历日（YYYY-MM-DD，不读 UTC 时区偏移）—— 服务端与页面共用同一口径，
  // 但本函数**不是**可复算路径的一部分：调用方必须把结果显式传给 computeRiskAssessment。
  function localTodayISO(now) {
    var d = now instanceof Date ? now : new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 从原始答案重算一条评估记录的全部派生值。评分唯一来源是 5A 的 scoreRiskAnswers；
  // 这里不保留第二套规则（5.2 工作项 1）。
  function computeRiskAssessment(payload, options) {
    var opts = options || {};
    var today = opts.today;
    if (!isCalendarDate(today)) {
      return riskassFail('invalid_assessment_date', 'options.today 必须是真实存在的 YYYY-MM-DD');
    }
    var v = validateRiskAssessmentRequest(payload);
    if (!v.ok) return v;
    if (payload.ruleVersion != null && payload.ruleVersion !== RISK_RULE_VERSION) {
      // 5A 没有规则目录；钉住历史版本的重算请求一律拒绝，不猜旧规则（5.3 门禁）。
      return riskassFail('invalid_rule_version', '规则版本与当前可用版本不一致');
    }
    var s = scoreRiskAnswers(payload.answers);
    if (!s.ok) return { ok: false, error: s.error };
    if (!isReassessReason(payload.reason)) {
      return riskassFail('invalid_reassess_reason', '复评原因不在冻结词表内');
    }
    var val = assessmentValidity(payload.assessedAt, today);
    if (!val.ok) return { ok: false, error: val.error };
    return {
      ok: true,
      record: {
        ruleVersion: s.ruleVersion,
        answers: s.scored.map(function (a) {
          return { questionId: a.questionId, optionId: a.optionId, score: a.score, kind: a.kind, dimension: a.dimension };
        }),
        capacityScore: s.capacityScore,
        willingnessScore: s.willingnessScore,
        capacityLevel: s.capacityLevel,
        willingnessLevel: s.willingnessLevel,
        ceiling: s.ceiling,
        ceilingSource: s.ceilingSource,
        hardCaps: s.hardCaps.map(function (c) { return { code: c.code, maxLevel: c.maxLevel, explainKey: c.explainKey }; }),
        explainCodes: s.explainCodes.slice(),
        assessedAt: payload.assessedAt,
        expiry: val.expiry,
        reason: payload.reason
      }
    };
  }

  // 已落库记录的反序列化校验：字段形状 + 按冻结规则**重算核对**。
  // 任何派生值与答案 + ruleVersion 的重算结果不一致（旧库被改、规则漂移、伪造备份）
  // 一律 fail closed —— 这是「记录不可被新规则静默重算改写」的机器兜底。
  function validateRiskAssessmentRecord(record) {
    if (!hasExactRiskKeys(record, RISK_ASSESSMENT_RECORD_KEYS, RISK_ASSESSMENT_RECORD_REQUIRED)) {
      return riskassFail('invalid_answers', '评估记录字段不符合冻结契约');
    }
    if (!isRiskNonEmptyString(record.id) || !isRiskNonEmptyString(record.createdAt)) {
      return riskassFail('invalid_answers', '评估记录缺少 id 或 createdAt');
    }
    if (record.ruleVersion !== RISK_RULE_VERSION) {
      return riskassFail('invalid_rule_version', '评估记录引用了当前规则目录之外的版本');
    }
    if (!isCalendarDate(record.assessedAt) || !isCalendarDate(record.expiry)) {
      return riskassFail('invalid_assessment_date', '评估/到期日期必须是真实存在的 YYYY-MM-DD');
    }
    if (!isReassessReason(record.reason)) {
      return riskassFail('invalid_reassess_reason', '复评原因不在冻结词表内');
    }
    var answerRows = copyRiskDenseDataArray(record.answers);
    if (answerRows === null) return riskassFail('invalid_answers', 'answers 必须是稠密数组');
    for (var i = 0; i < answerRows.length; i++) {
      if (!hasExactRiskKeys(answerRows[i], ['questionId', 'optionId', 'score', 'kind', 'dimension'],
        ['questionId', 'optionId', 'score', 'kind', 'dimension'])) {
        return riskassFail('invalid_answers', '第 ' + (i + 1) + ' 条答案字段不符合冻结契约');
      }
    }
    var hardCapRows = copyRiskDenseDataArray(record.hardCaps);
    var explainRows = copyRiskStringArray(record.explainCodes);
    if (hardCapRows === null || explainRows === null) {
      return riskassFail('invalid_answers', 'hardCaps / explainCodes 必须是普通稠密数组');
    }
    for (var h = 0; h < hardCapRows.length; h++) {
      if (!hasExactRiskKeys(hardCapRows[h], ['code', 'maxLevel', 'explainKey'], ['code', 'maxLevel', 'explainKey'])) {
        return riskassFail('invalid_answers', '第 ' + (h + 1) + ' 条硬封顶字段不符合冻结契约');
      }
    }
    // 重算只喂「题目 → 选项」这一客户端事实；记录里冗余的 score/kind/dimension
    // 必须与按冻结规则重算出的规范化结果逐字段相等，而不是被采信。
    var bareRows = [];
    for (var b = 0; b < answerRows.length; b++) {
      bareRows.push({ questionId: answerRows[b].questionId, optionId: answerRows[b].optionId });
    }
    var recomputed = computeRiskAssessment(
      { answers: bareRows, assessedAt: record.assessedAt, reason: record.reason },
      { today: record.assessedAt }
    );
    if (!recomputed.ok) {
      return { ok: false, error: recomputed.error, mismatch: true, code: recomputed.error.code };
    }
    var expected = recomputed.record;
    var scalarKeys = ['ruleVersion', 'capacityScore', 'willingnessScore', 'capacityLevel',
      'willingnessLevel', 'ceiling', 'ceilingSource', 'assessedAt', 'expiry', 'reason'];
    for (var k = 0; k < scalarKeys.length; k++) {
      if (record[scalarKeys[k]] !== expected[scalarKeys[k]]) {
        return riskassFail('invalid_answers', '评估记录的派生值与答案重算结果不一致');
      }
    }
    if (JSON.stringify(record.answers) !== JSON.stringify(expected.answers)) {
      return riskassFail('invalid_answers', '评估记录的答案明细与规范化重算结果不一致');
    }
    if (JSON.stringify(record.hardCaps) !== JSON.stringify(expected.hardCaps)) {
      return riskassFail('invalid_answers', '评估记录的硬封顶明细与重算结果不一致');
    }
    if (JSON.stringify(record.explainCodes) !== JSON.stringify(expected.explainCodes)) {
      return riskassFail('invalid_answers', '评估记录的解释码与重算结果不一致');
    }
    return { ok: true, record: riskCopy(record) };
  }

  // 确定性排序：assessedAt 降序 → createdAt 降序 → id 升序。与数据库行序无关（不变量 6）。
  function compareRiskAssessments(a, b) {
    if (a.assessedAt !== b.assessedAt) return a.assessedAt < b.assessedAt ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  }

  function sortRiskAssessments(list) {
    var rows = copyRiskDenseDataArray(list);
    if (rows === null) return null;
    return rows.sort(compareRiskAssessments);
  }

  // 「当前有效评估」的确定性选出（5.2 工作项 3）：
  // 未过期（valid / expiring_soon）记录中最新的一条即当前评估；全部过期 / 无记录 /
  // 记录不可解析分别返回可区分的空态。过期只使评估失效，不删除历史（5.3 门禁）。
  function selectCurrentAssessment(records, now) {
    if (!isCalendarDate(now)) return riskassFail('invalid_assessment_date', 'now 必须是真实存在的 YYYY-MM-DD');
    var rows = copyRiskDenseDataArray(records);
    if (rows === null) return riskassFail('invalid_answers', 'records 必须是稠密数组');
    if (rows.length === 0) {
      return { ok: true, status: 'no_assessment', current: null, candidates: [], expiredRef: null, invalidCount: 0 };
    }
    var parsed = [], invalidCount = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = validateRiskAssessmentRecord(rows[i]);
      if (r.ok) parsed.push(r.record); else invalidCount += 1;
    }
    parsed.sort(compareRiskAssessments);
    var validOnes = [], latest = parsed.length ? parsed[0] : null, latestExpiry = null;
    for (var j = 0; j < parsed.length; j++) {
      var val = assessmentValidity(parsed[j].assessedAt, now);
      if (val.ok && val.status !== 'expired') validOnes.push({ record: parsed[j], validity: val });
    }
    if (latest) {
      var lv = assessmentValidity(latest.assessedAt, now);
      latestExpiry = lv.ok ? { assessedAt: latest.assessedAt, expiry: lv.expiry } : null;
    }
    if (validOnes.length) {
      return {
        ok: true,
        status: 'current',
        current: { record: validOnes[0].record, validity: validOnes[0].validity },
        candidates: validOnes.map(function (x) { return x.record.id; }),
        expiredRef: null,
        invalidCount: invalidCount
      };
    }
    if (parsed.length === 0) {
      return { ok: true, status: 'invalid_records', current: null, candidates: [], expiredRef: latestExpiry, invalidCount: invalidCount };
    }
    return { ok: true, status: 'all_expired', current: null, candidates: [], expiredRef: latestExpiry, invalidCount: invalidCount };
  }

  // 契约快照：5B 落库 / API / 页面从这里取键集合与词表，避免各处硬编码分叉。
  function riskAssessmentContract() {
    return riskCopy({
      ruleVersion: RISK_RULE_VERSION,
      requestKeys: RISK_ASSESSMENT_REQUEST_KEYS,
      requestRequired: RISK_ASSESSMENT_REQUEST_REQUIRED,
      recordKeys: RISK_ASSESSMENT_RECORD_KEYS,
      recordRequired: RISK_ASSESSMENT_RECORD_REQUIRED,
      statuses: ASSESSMENT_STATUSES,
      reassessReasons: REASSESS_REASONS,
      validDays: ASSESSMENT_VALID_DAYS,
      expiringDays: ASSESSMENT_EXPIRING_DAYS,
      selectNoneStates: RISKASSESS_SELECT_NONE_STATES,
      orderingRule: 'assessedAt 降序 → createdAt 降序 → id 升序（与数据库行序无关）'
    });
  }

  /* ------------------- 目标配置与认可标的映射（Phase 5C，D-048） -------------------
   * 5C 把 5B 的**有效风险评估**确定性映射为 5A 已冻结的目标区间，并把「资产类别 → 用户认可标的」
   * 落成用户维护的白名单。本段仍是纯函数：不读存储、不发网络、不读系统时钟
   * （判定日 / 生效日一律由调用方注入，保证可复算，不变量 6）。
   * 范围边界（PHASE5_BREAKDOWN §6.4）：不接收新增资金金额、不计算买入金额、不生成 recommendation、
   * 不创建 Phase 6 的接受 / 暂缓 / 执行 / 复盘状态。
   */

  // 目标记录 = 一次目标版本的封存事实（id / createdAt 由服务端绑定，历史行永不 UPDATE）。
  var ALLOCATION_TARGET_RECORD_KEYS = [
    'id', 'templateVersion', 'ruleVersion', 'level', 'classes',
    'assessmentId', 'assessedAt', 'assessmentExpiry', 'effectiveFrom', 'createdAt'
  ];
  var ALLOCATION_TARGET_RECORD_REQUIRED = ALLOCATION_TARGET_RECORD_KEYS.slice();
  // computeAllocationTarget 产出的内容体：记录键去掉服务端字段，用于自然键与幂等比较。
  var ALLOCATION_TARGET_CONTENT_KEYS = [
    'templateVersion', 'ruleVersion', 'level', 'classes',
    'assessmentId', 'assessedAt', 'assessmentExpiry', 'effectiveFrom'
  ];
  // 客户端唯一可提交的自有字段：生效日期（可缺省 → 服务端今天）。level / classes 等派生值不在允许集合内。
  var ALLOCATION_TARGET_REQUEST_KEYS = ['effectiveFrom'];
  var APPROVED_INSTRUMENT_RECORD_KEYS = ['id', 'assetClass', 'instrumentId', 'position', 'createdAt', 'updatedAt'];
  var APPROVED_INSTRUMENT_RECORD_REQUIRED = APPROVED_INSTRUMENT_RECORD_KEYS.slice();
  // 认可标的的写入口按「整类替换」建模：用户判断就是这一类的有序清单，provider 没有对应字段。
  var APPROVED_MAPPING_REQUEST_KEYS = ['assetClass', 'instrumentIds'];
  var APPROVED_MAPPING_REQUEST_REQUIRED = ['assetClass', 'instrumentIds'];

  var ALLOCATION_TARGET_STATUSES = ['current', 'no_target', 'no_assessment', 'stale_assessment', 'invalid_records'];
  // 偏离计算的空态：投资池为 0 时不出比例，不冒充「全部 0% 在区间内」。
  var ALLOCATION_DEVIATION_STATUSES = ['ok', 'no_investable'];
  var ALLOCATION_MAPPING_ROW_STATUSES = ['ok', 'invalid'];
  // 认可标的引用的失效原因（`classification_unconfirmed` / `unknown_instrument` 沿用既有词表，不新造第二套）
  var ALLOCATION_MAPPING_ISSUE_CODES = ['instrument_missing', 'classification_unconfirmed', 'class_mismatch'];
  // 5C 稳定错误码：5A 的 RISK_ERROR_CODES 是已冻结词表（fixture 逐字段比对），因此 5C 新增码
  // 单列一张表，HTTP 映射在 server/api.js 的 DOMAIN_ERROR_STATUS 唯一落地（不变量 3）。
  var ALLOCATION_ERROR_CODES = [
    'invalid_target_payload', 'invalid_target_record', 'invalid_effective_date', 'assessment_expired',
    'no_valid_assessment', 'invalid_assessment_records', 'duplicate_target', 'invalid_valuation_input',
    'invalid_mapping_payload', 'duplicate_mapping', 'instrument_already_mapped', 'unknown_instrument',
    'class_mismatch'
  ];
  var APPROVED_INSTRUMENT_MAX = 50;
  // 比例守恒的稳定键：与 5A 的金额尾差规则分开（那条属 5D 的资金分配），两者都不得按行序取巧。
  var ALLOCATION_BPS_ROUNDING_RULE =
    'pctBps 用最大余数法：floor 后按余数降序补 1，余数相同按 RISK_CLASSES 顺序；ΣpctBps 恒等于 10000';
  var ALLOCATION_TARGET_ORDER_RULE = 'effectiveFrom 降序 → createdAt 降序 → id 升序（与数据库行序无关）';

  [
    ALLOCATION_TARGET_RECORD_KEYS, ALLOCATION_TARGET_RECORD_REQUIRED, ALLOCATION_TARGET_CONTENT_KEYS,
    ALLOCATION_TARGET_REQUEST_KEYS, APPROVED_INSTRUMENT_RECORD_KEYS, APPROVED_INSTRUMENT_RECORD_REQUIRED,
    APPROVED_MAPPING_REQUEST_KEYS, APPROVED_MAPPING_REQUEST_REQUIRED, ALLOCATION_TARGET_STATUSES,
    ALLOCATION_DEVIATION_STATUSES, ALLOCATION_MAPPING_ROW_STATUSES, ALLOCATION_MAPPING_ISSUE_CODES,
    ALLOCATION_ERROR_CODES
  ].forEach(deepFreezeRisk);

  function allocFail(code, detail) {
    return { ok: false, error: { code: code, detail: detail } };
  }

  // 自然键：同一条评估 + 同一模板版本 + 同一生效日期只可能有一个目标版本（重复请求不追加新行）。
  function allocationTargetNaturalKey(t) {
    return String(t.assessmentId) + '|' + String(t.templateVersion) + '|' + String(t.effectiveFrom);
  }

  /* ① 有效评估 → 目标版本（确定性映射，5A 模板是唯一数值来源） */

  function computeAllocationTarget(assessment, options) {
    var opts = options || {};
    if (!isCalendarDate(opts.today)) return allocFail('invalid_assessment_date', 'options.today 必须是真实存在的 YYYY-MM-DD');
    var checked = validateRiskAssessmentRecord(assessment);
    if (!checked.ok) return { ok: false, error: checked.error };
    var rec = checked.record;
    var val = assessmentValidity(rec.assessedAt, opts.today);
    if (!val.ok) return { ok: false, error: val.error };
    if (val.status === 'expired') {
      return allocFail('assessment_expired', '所引用的风险评估已于 ' + rec.expiry + ' 过期，须先复评才能生成目标配置');
    }
    var effectiveFrom = opts.effectiveFrom == null ? opts.today : opts.effectiveFrom;
    if (!isCalendarDate(effectiveFrom)) return allocFail('invalid_effective_date', '生效日期必须是真实存在的 YYYY-MM-DD');
    if (effectiveFrom < rec.assessedAt) {
      return allocFail('invalid_effective_date', '目标生效日期不得早于所引用评估的日期');
    }
    if (effectiveFrom > opts.today) {
      return allocFail('invalid_effective_date', '目标生效日期不得晚于判定日（预排未来目标不属本阶段）');
    }
    // 不再单独检查「生效日 > 到期日」：走到这里必然未过期（today <= expiry）且 effectiveFrom <= today，
    // 该不变量由上面两条前置检查保证；读取路径仍会复核 effectiveFrom <= assessmentExpiry。
    var tpl = targetTemplateForLevel(rec.ceiling);
    if (!tpl) return allocFail('invalid_target_template', '当前模板版本没有该风险上限对应的目标模板');
    var tplCheck = validateTargetTemplate(tpl);
    if (!tplCheck.ok) return { ok: false, error: tplCheck.error };
    var target = {
      templateVersion: RISK_TARGET_VERSION,
      ruleVersion: rec.ruleVersion,
      level: rec.ceiling,
      classes: tpl.classes,
      assessmentId: rec.id,
      assessedAt: rec.assessedAt,
      assessmentExpiry: rec.expiry,
      effectiveFrom: effectiveFrom
    };
    return { ok: true, target: target, naturalKey: allocationTargetNaturalKey(target) };
  }

  /* ② 读取即复核：目标记录必须能被「模板版本 + 等级 + 所引用评估」重新解释 */

  function validateAllocationTargetRecord(record, assessment) {
    if (!hasExactRiskKeys(record, ALLOCATION_TARGET_RECORD_KEYS, ALLOCATION_TARGET_RECORD_REQUIRED)) {
      return allocFail('invalid_target_record', '目标记录字段不符合冻结契约');
    }
    if (!isRiskNonEmptyString(record.id) || !isRiskNonEmptyString(record.assessmentId)) {
      return allocFail('invalid_target_record', '目标记录缺少 id 或所引用的评估 id');
    }
    if (record.templateVersion !== RISK_TARGET_VERSION) {
      return allocFail('invalid_target_template', '目标记录引用了当前目录之外的模板版本');
    }
    if (record.ruleVersion !== RISK_RULE_VERSION) {
      return allocFail('invalid_rule_version', '目标记录引用了当前规则目录之外的版本');
    }
    if (!isRiskNonNegInt(record.level) || RISK_LEVELS.indexOf(record.level) === -1) {
      return allocFail('invalid_target_record', '目标记录的风险上限不是 1–5 的等级');
    }
    // 比例必须逐字段等于该等级在冻结模板下的唯一定义：同版本偷换一组自洽比例同样 fail closed。
    var tplCheck = validateTargetTemplate({
      level: record.level, templateVersion: record.templateVersion, classes: record.classes
    });
    if (!tplCheck.ok) return { ok: false, error: tplCheck.error };
    if (!isCalendarDate(record.assessedAt) || !isCalendarDate(record.assessmentExpiry) || !isCalendarDate(record.effectiveFrom)) {
      return allocFail('invalid_effective_date', '评估日 / 到期日 / 生效日必须是真实存在的 YYYY-MM-DD');
    }
    if (record.effectiveFrom < record.assessedAt) {
      return allocFail('invalid_effective_date', '目标生效日期早于所引用评估的日期');
    }
    if (record.effectiveFrom > record.assessmentExpiry) {
      return allocFail('invalid_effective_date', '目标生效日期晚于所引用评估的到期日');
    }
    if (record.assessmentExpiry !== addCalendarDays(record.assessedAt, ASSESSMENT_VALID_DAYS)) {
      return allocFail('invalid_target_record', '评估到期日与冻结有效期不一致');
    }
    if (assessment !== undefined && assessment !== null) {
      var av = validateRiskAssessmentRecord(assessment);
      if (!av.ok) return { ok: false, error: av.error };
      var a = av.record;
      if (a.id !== record.assessmentId || a.ruleVersion !== record.ruleVersion ||
        a.assessedAt !== record.assessedAt || a.expiry !== record.assessmentExpiry || a.ceiling !== record.level) {
        return allocFail('invalid_target_record', '目标记录与所引用评估不一致');
      }
    }
    return { ok: true, record: riskCopy(record) };
  }

  function compareAllocationTargets(a, b) {
    if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  }

  function sortAllocationTargets(list) {
    var rows = copyRiskDenseDataArray(list);
    if (rows === null) return null;
    return rows.sort(compareAllocationTargets);
  }

  // 「当前生效目标」的确定性选出（与 5B 的当前评估同一纪律）：
  // 空态必须按「用户下一步动作不同」拆开，不得合并成一个「没有数据」。
  function selectCurrentTarget(records, currentAssessment, now) {
    if (!isCalendarDate(now)) return allocFail('invalid_assessment_date', 'now 必须是真实存在的 YYYY-MM-DD');
    var rows = copyRiskDenseDataArray(records);
    if (rows === null) return allocFail('invalid_target_record', 'records 必须是稠密数组');
    if (rows.length === 0) {
      return { ok: true, status: currentAssessment ? 'no_target' : 'no_assessment', current: null, invalidCount: 0, total: 0 };
    }
    var parsed = [], invalidCount = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = validateAllocationTargetRecord(rows[i]);
      if (r.ok) parsed.push(r.record); else invalidCount += 1;
    }
    if (parsed.length === 0) {
      return { ok: true, status: 'invalid_records', current: null, invalidCount: invalidCount, total: rows.length };
    }
    parsed.sort(compareAllocationTargets);
    if (!currentAssessment) {
      return { ok: true, status: 'no_assessment', current: null, invalidCount: invalidCount, total: rows.length };
    }
    var assessmentId = currentAssessment.id;
    var matchesAssessment = false;
    for (var j = 0; j < parsed.length; j++) {
      if (parsed[j].assessmentId !== assessmentId) continue;
      matchesAssessment = true;
      if (parsed[j].effectiveFrom <= now) {
        return {
          ok: true, status: 'current', current: {
            target: parsed[j], assessment: riskCopy(currentAssessment)
          }, invalidCount: invalidCount, total: rows.length
        };
      }
    }
    // 引用对了但生效日还没到 → 与「引用的是另一份评估」是两种不同的下一步，不得合并
    return {
      ok: true,
      status: matchesAssessment ? 'no_target' : 'stale_assessment',
      current: null,
      invalidCount: invalidCount,
      total: rows.length
    };
  }

  /* ③ 当前配置与偏离：**只消费 computeOverview 的同一遍估值**（D-025 / 不变量 3） */

  // bps 最大余数法（D-048 ⑤ 冻结的唯一取整实现）：floor 后按余数降序补 1，同余数按 RISK_CLASSES 序。
  // 5C 用它出当前比例，5D 用它复核「传进来的比例确实是同一遍估值」——两处共用同一份，不各写一遍。
  function bpsByLargestRemainder(byClass, total) {
    var base = [], assigned = 0, overflow = false;
    RISK_CLASSES.forEach(function (k) {
      var scaled = byClass[k] * BPS_TOTAL;
      // 定点放缩超出安全整数就 fail closed（与 mulMinor 同一纪律）：
      // 浮点尾差会让 ΣpctBps 不再精确等于 10000，宁可拒绝也不给一个「差 1bp」的比例。
      if (!Number.isSafeInteger(scaled)) overflow = true;
      var whole = Math.floor(scaled / total);
      assigned += whole;
      base.push({ assetClass: k, bps: whole, remainder: scaled - whole * total });
    });
    if (overflow) return { overflow: true };
    var order = base.map(function (x, idx) { return idx; });
    order.sort(function (x, y) {
      if (base[x].remainder !== base[y].remainder) return base[y].remainder - base[x].remainder;
      return x - y; // 同余数按 RISK_CLASSES 序（base 已按该序构造）
    });
    var leftover = BPS_TOTAL - assigned;
    for (var s = 0; s < leftover; s++) base[order[s]].bps += 1;
    var map = {};
    base.forEach(function (x) { map[x.assetClass] = x.bps; });
    return { overflow: false, map: map };
  }

  function computeAllocationDeviation(target, overview) {
    var tv = validateAllocationTargetRecord(target);
    if (!tv.ok) return { ok: false, error: tv.error };
    var t = tv.record;
    if (!isRiskObject(overview) || !isRiskObject(overview.pools)) {
      return allocFail('invalid_valuation_input', '必须传入 computeOverview 的结果');
    }
    var rows = copyRiskDenseDataArray(overview.riskClasses);
    if (rows === null) return allocFail('invalid_valuation_input', 'overview.riskClasses 必须是稠密数组');
    if (rows.length !== RISK_CLASSES.length) {
      return allocFail('invalid_valuation_input', 'overview.riskClasses 必须恰好覆盖六个资产类别');
    }
    var byClass = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!isRiskObject(row) || RISK_CLASSES.indexOf(row.assetClass) === -1 || byClass[row.assetClass]) {
        return allocFail('invalid_valuation_input', '估值结果含未知或重复的资产类别');
      }
      if (!isRiskNonNegInt(row.valueMinor)) {
        return allocFail('invalid_valuation_input', '类别 ' + row.assetClass + ' 的估值必须是整数最小货币单位');
      }
      byClass[row.assetClass] = row.valueMinor;
    }
    for (var c = 0; c < RISK_CLASSES.length; c++) {
      if (!Object.prototype.hasOwnProperty.call(byClass, RISK_CLASSES[c])) {
        return allocFail('invalid_valuation_input', '估值结果缺少类别：' + RISK_CLASSES[c]);
      }
    }
    var total = overview.pools.investableMinor;
    if (!isRiskNonNegInt(total)) return allocFail('invalid_valuation_input', 'pools.investableMinor 必须是非负安全整数');
    var classSum = 0;
    RISK_CLASSES.forEach(function (k) { classSum += byClass[k]; });
    // 总览与类别合计同源（同一遍估值），不一致说明传入的不是 computeOverview 的原始结果。
    if (classSum !== total) {
      return allocFail('invalid_valuation_input', '类别估值合计与投资池不一致');
    }

    var classes = [];
    var status = total > 0 ? 'ok' : 'no_investable';
    if (total === 0) {
      // 空组合 / 投资池为零：不出比例、不出容忍带，避免把「算不出」显示成「全部在区间内」。
      RISK_CLASSES.forEach(function (k) {
        classes.push({
          assetClass: k, valueMinor: byClass[k], pctBps: null,
          minBps: t.classes[k].minBps, targetBps: t.classes[k].targetBps, maxBps: t.classes[k].maxBps,
          band: null, deviationBps: null
        });
      });
    } else {
      var bps = bpsByLargestRemainder(byClass, total);
      if (bps.overflow) return allocFail('invalid_valuation_input', '估值金额超出定点计算的安全整数范围');
      RISK_CLASSES.forEach(function (k) {
        var range = t.classes[k];
        classes.push({
          assetClass: k, valueMinor: byClass[k], pctBps: bps.map[k],
          minBps: range.minBps, targetBps: range.targetBps, maxBps: range.maxBps,
          band: compareToRange(bps.map[k], range.minBps, range.maxBps),
          deviationBps: bps.map[k] - range.targetBps
        });
      });
    }
    var summary = { belowMin: 0, within: 0, aboveMax: 0 };
    classes.forEach(function (x) {
      if (x.band === 'below_min') summary.belowMin += 1;
      else if (x.band === 'within') summary.within += 1;
      else if (x.band === 'above_max') summary.aboveMax += 1;
    });
    var blockerRows = copyRiskDenseDataArray(overview.blockers || []);
    return {
      ok: true,
      status: status,
      asOf: typeof overview.asOf === 'string' ? overview.asOf : null,
      valuationStatus: overview.valuationStatus || null,
      canAdvise: overview.canAdvise === true,
      investableTotalMinor: total,
      targetLevel: t.level,
      targetVersion: t.templateVersion,
      classes: classes,
      summary: summary,
      // 阻塞项与「能否给正式建议」一律透传总览（不另写一套判断）
      blockers: blockerRows === null ? [] : blockerRows.map(function (b) {
        return isRiskObject(b) ? { code: b.code == null ? null : b.code, detail: b.detail == null ? '' : b.detail } : null;
      }).filter(Boolean),
      roundingRule: ALLOCATION_BPS_ROUNDING_RULE
    };
  }

  /* ④ 认可标的映射：只有用户判断，引用必须已存在、已确认且类别一致 */

  function validateApprovedMappingRequest(payload) {
    if (!hasExactRiskKeys(payload, APPROVED_MAPPING_REQUEST_KEYS, APPROVED_MAPPING_REQUEST_REQUIRED)) {
      return allocFail('invalid_mapping_payload', '载荷必须只包含自有数据字段 assetClass / instrumentIds');
    }
    if (RISK_CLASSES.indexOf(payload.assetClass) === -1) {
      return allocFail('invalid_mapping_payload', 'assetClass 不在冻结的资产类别词表内');
    }
    var ids = copyRiskDenseDataArray(payload.instrumentIds);
    if (ids === null) return allocFail('invalid_mapping_payload', 'instrumentIds 必须是普通、稠密的数组');
    if (ids.length > APPROVED_INSTRUMENT_MAX) {
      return allocFail('invalid_mapping_payload', '单个类别的认可标的不得超过 ' + APPROVED_INSTRUMENT_MAX + ' 条');
    }
    var out = [], seen = {};
    for (var i = 0; i < ids.length; i++) {
      if (!isRiskNonEmptyString(ids[i])) {
        return allocFail('invalid_mapping_payload', '第 ' + (i + 1) + ' 项标的 id 必须是非空字符串');
      }
      if (seen[ids[i]]) return allocFail('duplicate_mapping', '同一类别重复引用同一标的：第 ' + (i + 1) + ' 项');
      seen[ids[i]] = true;
      out.push(ids[i]);
    }
    return { ok: true, assetClass: payload.assetClass, instrumentIds: out };
  }

  function validateApprovedInstrumentRecord(record) {
    if (!hasExactRiskKeys(record, APPROVED_INSTRUMENT_RECORD_KEYS, APPROVED_INSTRUMENT_RECORD_REQUIRED)) {
      return allocFail('invalid_mapping_payload', '认可标的记录字段不符合冻结契约');
    }
    if (!isRiskNonEmptyString(record.id)) return allocFail('invalid_mapping_payload', '认可标的记录缺少 id');
    if (RISK_CLASSES.indexOf(record.assetClass) === -1) {
      return allocFail('invalid_mapping_payload', '认可标的的资产类别不在冻结词表内');
    }
    if (!isRiskNonEmptyString(record.instrumentId)) {
      return allocFail('invalid_mapping_payload', '认可标的缺少标的 id');
    }
    if (!isRiskNonNegInt(record.position)) {
      return allocFail('invalid_mapping_payload', '认可标的的排序位置必须是非负安全整数');
    }
    return { ok: true, record: riskCopy(record) };
  }

  // 顺序即用户判断：按 RISK_CLASSES 序 → position 升序 → instrumentId 升序（position 冲突时仍可确定复现）。
  function compareApprovedInstruments(a, b) {
    var ca = RISK_CLASSES.indexOf(a.assetClass), cb = RISK_CLASSES.indexOf(b.assetClass);
    if (ca !== cb) return ca - cb;
    if (a.position !== b.position) return a.position - b.position;
    if (a.instrumentId === b.instrumentId) return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    return a.instrumentId < b.instrumentId ? -1 : 1;
  }

  function sortApprovedInstruments(list) {
    var rows = copyRiskDenseDataArray(list);
    if (rows === null) return null;
    return rows.sort(compareApprovedInstruments);
  }

  // 引用完整性是**读取时**判定的：标的被删、分类被改回 suggested、类别被改成别的，
  // 映射行都保持原样并显式报失效原因 —— provider 刷新与目录变更都不能改写用户判断。
  function checkApprovedMapping(records, instruments) {
    var rows = copyRiskDenseDataArray(records);
    if (rows === null) return allocFail('invalid_mapping_payload', 'records 必须是稠密数组');
    var insList = copyRiskDenseDataArray(instruments);
    if (insList === null) return allocFail('invalid_mapping_payload', 'instruments 必须是稠密数组');
    var instById = {};
    for (var i = 0; i < insList.length; i++) {
      var it = insList[i];
      if (isRiskObject(it) && isRiskNonEmptyString(it.id) && !Object.prototype.hasOwnProperty.call(instById, it.id)) {
        instById[it.id] = it;
      }
    }
    var checked = [], invalidCount = 0;
    for (var r = 0; r < rows.length; r++) {
      var v = validateApprovedInstrumentRecord(rows[r]);
      if (!v.ok) { invalidCount += 1; continue; }
      var rec = v.record;
      var inst = Object.prototype.hasOwnProperty.call(instById, rec.instrumentId) ? instById[rec.instrumentId] : null;
      var issues = [];
      if (!inst) issues.push('instrument_missing');
      else {
        if (inst.classificationStatus !== 'confirmed') issues.push('classification_unconfirmed');
        if (!inst.assetClass || inst.assetClass !== rec.assetClass) issues.push('class_mismatch');
      }
      checked.push({
        id: rec.id,
        assetClass: rec.assetClass,
        instrumentId: rec.instrumentId,
        position: rec.position,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        symbol: inst && isRiskNonEmptyString(inst.symbol) ? inst.symbol : null,
        instrumentName: inst && isRiskNonEmptyString(inst.name) ? inst.name : null,
        instrumentAssetClass: inst && isRiskNonEmptyString(inst.assetClass) ? inst.assetClass : null,
        classificationStatus: inst && isRiskNonEmptyString(inst.classificationStatus) ? inst.classificationStatus : null,
        status: issues.length ? 'invalid' : 'ok',
        issues: issues
      });
    }
    checked.sort(compareApprovedInstruments);
    var byClass = {};
    RISK_CLASSES.forEach(function (k) { byClass[k] = []; });
    checked.forEach(function (x) { byClass[x.assetClass].push(x); });
    var validCount = 0, issueCount = 0;
    checked.forEach(function (x) {
      if (x.status === 'ok') validCount += 1; else issueCount += 1;
    });
    return {
      ok: true,
      rows: checked,
      byClass: byClass,
      validCount: validCount,
      issueCount: issueCount,
      invalidCount: invalidCount,
      total: rows.length
    };
  }

  // 缺映射：目标比例 > 0 却没有任何「引用有效」的标的。
  // 注意：这只影响「能不能落到具体证券」，不阻止显示类别偏离（§6.3）。
  function classesMissingMapping(target, mapping) {
    var tv = validateAllocationTargetRecord(target);
    if (!tv.ok) return { ok: false, error: tv.error };
    var m = isRiskObject(mapping) && mapping.byClass ? mapping : null;
    if (!m) return allocFail('invalid_mapping_payload', '必须传入 checkApprovedMapping 的结果');
    var missing = [];
    RISK_CLASSES.forEach(function (k) {
      if (tv.record.classes[k].targetBps <= 0) return;
      var rows = Array.isArray(m.byClass[k]) ? m.byClass[k] : [];
      var usable = rows.filter(function (x) { return x && x.status === 'ok'; });
      if (!usable.length) missing.push(k);
    });
    return { ok: true, missingClasses: missing };
  }

  // 契约快照：迁移 / 仓储 / API / 页面从这里取键集合与词表，避免各处硬编码分叉。
  function allocationContract() {
    return riskCopy({
      targetVersion: RISK_TARGET_VERSION,
      ruleVersion: RISK_RULE_VERSION,
      targetRecordKeys: ALLOCATION_TARGET_RECORD_KEYS,
      targetContentKeys: ALLOCATION_TARGET_CONTENT_KEYS,
      targetRequestKeys: ALLOCATION_TARGET_REQUEST_KEYS,
      targetStatuses: ALLOCATION_TARGET_STATUSES,
      targetOrderingRule: ALLOCATION_TARGET_ORDER_RULE,
      instrumentRecordKeys: APPROVED_INSTRUMENT_RECORD_KEYS,
      mappingRequestKeys: APPROVED_MAPPING_REQUEST_KEYS,
      mappingRowStatuses: ALLOCATION_MAPPING_ROW_STATUSES,
      mappingIssueCodes: ALLOCATION_MAPPING_ISSUE_CODES,
      mappingMaxPerClass: APPROVED_INSTRUMENT_MAX,
      deviationStatuses: ALLOCATION_DEVIATION_STATUSES,
      deviationRoundingRule: ALLOCATION_BPS_ROUNDING_RULE,
      errorCodes: ALLOCATION_ERROR_CODES,
      classes: RISK_CLASSES,
      toleranceBands: TOLERANCE_BANDS,
      bpsTotal: BPS_TOTAL
    });
  }

  /* ------------------- 新增资金优先再平衡与正式建议（Phase 5D，D-049） -------------------
   * 5D 把 5C 的目标版本、同一遍 Phase 4 估值与用户认可标的转化为「这笔新增资金怎么分」。
   * 本段仍是纯函数：不读存储、不发网络、不读系统时钟（判定日与估值一律由调用方注入，不变量 6）。
   * 三条硬边界：
   *   ① 只补低配类别——高配类别得到 0 与风险提示，任何情况下都不返回负金额或卖出指令；
   *   ② 金额守恒——各类别分配之和恒等于「实际分配金额」，尾差按 5A 冻结的稳定键处理并说明；
   *   ③ 正式建议只有一套门禁——本段只把服务端重读的事实折叠成 formal / estimate，
   *      不重跑估值、不新写第二套「能不能建议」的判断（canAdvise 来自 computeOverview）。
   */

  // 分配轮次的稳定结论词表（输出必须落在这里，页面与 Phase 6 不得各自解释）
  var NEW_FUND_ADJUSTMENTS = [
    'fill_below_min',        // 存在低于下限的类别，本轮先补区间
    'converge_to_target',    // 无低配（或已补满）后向 targetBps 收敛
    'within_tolerance',      // 全部类别都在容忍带内：无需调整，不强造分配
    'no_investable',         // 投资池为 0：没有可依赖的比例基准，不做分配
    'zero_allocatable'       // 可分配金额为 0（输入 0 或可新增投资资金为 0）
  ];
  // 每个类别本轮承接资金的身份（解释用，不改变金额）
  var NEW_FUND_CLASS_BASES = ['below_min', 'below_target', 'above_max', 'at_or_above_target', 'unknown_base'];
  // 解释码：5E 的本地知识卡按这些稳定 id 出解释，本阶段不写文案卡
  var RECOMMENDATION_EXPLAIN_CODES = [
    'new_funds_below_min_first',
    'new_funds_converge_to_target',
    'new_funds_within_tolerance',
    'new_funds_no_investable',
    'new_funds_zero_amount',
    'new_funds_capped_by_available',
    'new_funds_rounding_remainder',
    'new_funds_above_max_no_sell',
    'new_funds_missing_approved_instrument',
    'formal_gate_blocked'
  ];
  // 正式建议门禁：条件集合冻结，服务端逐条给出 passed，折叠成 status 的唯一实现在本段
  var RECOMMENDATION_GATE_CHECKS = [
    'snapshot_ref',                 // 引用的月结与快照真实存在且属于同一份结账
    'close_formal',                 // 月结已完成（formal），估算结账不能支撑正式建议
    'snapshot_hash',                // 快照原文 sha256 与封存 payloadHash 一致
    'can_advise',                   // computeOverview.canAdvise === true（无行情/汇率/分类/余额阻塞）
    'assessment_valid',             // 风险评估仍是当前有效那一份且规则版本可用
    'target_matches_assessment',    // 目标版本与被引用评估匹配且仍在生效
    'new_funds_within_available'    // 新增资金不超过当时的可新增投资资金
  ];
  var RECOMMENDATION_INSTRUMENT_STATUSES = ['mapped', 'needs_approved_instrument'];
  var RECOMMENDATION_TODO_CODES = ['missing_approved_instrument', 'invalid_instrument_reference'];
  // 5D 稳定错误码（与 5A 的 RISK_ERROR_CODES / 5C 的 ALLOCATION_ERROR_CODES 分开，不改已冻结词表）
  var RECOMMENDATION_ERROR_CODES = [
    'invalid_new_funds_request', 'recommendation_amount_overflow', 'unknown_close', 'unknown_snapshot',
    'snapshot_hash_mismatch', 'close_not_formal', 'unknown_target', 'unknown_assessment',
    'target_assessment_mismatch', 'invalid_recommendation_record', 'invalid_recommendation_output',
    'duplicate_recommendation'
  ];

  var NEW_FUND_ALLOCATION_KEYS = [
    'status', 'requestedNewFundsMinor', 'newFundsAvailableMinor', 'allocatableNewFundsMinor',
    'cappedToAvailable', 'investableTotalMinor', 'plannedTotalMinor', 'adjustment',
    'allocatedTotalMinor', 'unallocatedMinor', 'classes', 'belowMinClasses', 'aboveMaxClasses',
    'rounding', 'explainCodes', 'targetLevel', 'targetVersion', 'asOf'
  ];
  var NEW_FUND_CLASS_ROW_KEYS = [
    'assetClass', 'valueMinor', 'pctBps', 'minBps', 'targetBps', 'maxBps', 'band',
    'goalBps', 'minNeedMinor', 'targetNeedMinor', 'allocatedMinor', 'basis'
  ];
  var NEW_FUND_ROUNDING_KEYS = ['rule', 'leftoverMinor', 'receivers', 'allocatedTotalMinor', 'unallocatedMinor'];
  var RECOMMENDATION_CLASS_TARGET_KEYS = [
    'assetClass', 'basis', 'goalBps', 'minNeedMinor', 'targetNeedMinor', 'allocatedMinor', 'instruments'
  ];
  var RECOMMENDATION_TODO_ROW_KEYS = ['code', 'assetClass', 'retainedMinor'];
  var RECOMMENDATION_INSTRUMENT_ROW_KEYS = ['instrumentId', 'symbol', 'name', 'position', 'allocatedMinor'];
  var RECOMMENDATION_VERSION_KEYS = [
    'ruleVersion', 'targetVersion', 'targetLevel', 'assessmentId', 'targetId', 'closeId', 'snapshotId',
    'snapshotPayloadHash', 'dataCutoff', 'asOf'
  ];
  var RECOMMENDATION_ROUNDING_NOTE_KEYS = [
    'rule', 'leftoverMinor', 'receivers', 'adjustment', 'requestedNewFundsMinor',
    'allocatableNewFundsMinor', 'allocatedTotalMinor', 'unallocatedMinor', 'cappedToAvailable'
  ];
  var RECOMMENDATION_CURRENT_ROW_KEYS = ['assetClass', 'valueMinor', 'pctBps'];
  var RECOMMENDATION_RANGE_ROW_KEYS = ['assetClass', 'minBps', 'targetBps', 'maxBps'];
  var RECOMMENDATION_DEVIATION_ROW_KEYS = ['assetClass', 'pctBps', 'minBps', 'maxBps', 'targetBps', 'band', 'deviationBps'];
  var RECOMMENDATION_GATE_ROW_KEYS = ['code', 'passed', 'detail'];
  // D-052：gate 区是生成时封存的上下文 —— checks（门禁）、capture（计算日完整输入），
  // 以及 5E-5 起可选的 explanationVersion（生成时的知识卡解释版本）。
  // 旧记录只有 checks / capture 也必须照常通过：解释版本是可选键，不进 inputHash、
  // 不进 result，历史记录永不回填。必需键只有 checks（capture 缺失时由读取视图计入
  // invalidCount，不冒充可验证建议）。
  var RECOMMENDATION_GATE_KEYS = ['checks', 'capture', 'explanationVersion'];
  var RECOMMENDATION_GATE_REQUIRED_KEYS = ['checks'];
  // 落库的建议产物 = 不可变计算结果（供 Phase 6 接管）：本表不携带任何决策状态字段（接受 / 暂缓 / 执行 / 复盘属 Phase 6）
  // 顶层键集保持 5D 冻结不变；解释版本封存在 gate 内，不是顶层键。
  var RECOMMENDATION_RECORD_KEYS = [
    'id', 'createdAt', 'status', 'ruleVersion', 'targetVersion', 'assessmentId', 'targetId',
    'closeId', 'snapshotId', 'snapshotPayloadHash', 'dataCutoff', 'asOf',
    'requestedNewFundsMinor', 'newFundsAvailableMinor', 'allocatableNewFundsMinor',
    'allocatedTotalMinor', 'inputHash', 'gate', 'todos', 'result'
  ];
  // 金额分配的稳定键：与 5A 冻结的类别序 / 尾差规则同一份文字，避免各处另写口径
  var NEW_FUND_MONEY_ROUNDING_RULE = ALLOCATION_ROUNDING_RULE;

  [
    NEW_FUND_ADJUSTMENTS, NEW_FUND_CLASS_BASES, RECOMMENDATION_EXPLAIN_CODES,
    RECOMMENDATION_GATE_CHECKS, RECOMMENDATION_INSTRUMENT_STATUSES, RECOMMENDATION_TODO_CODES,
    RECOMMENDATION_ERROR_CODES, NEW_FUND_ALLOCATION_KEYS, NEW_FUND_CLASS_ROW_KEYS,
    NEW_FUND_ROUNDING_KEYS, RECOMMENDATION_CLASS_TARGET_KEYS, RECOMMENDATION_INSTRUMENT_ROW_KEYS,
    RECOMMENDATION_VERSION_KEYS, RECOMMENDATION_GATE_ROW_KEYS, RECOMMENDATION_RECORD_KEYS,
    RECOMMENDATION_GATE_KEYS, RECOMMENDATION_GATE_REQUIRED_KEYS,
    RECOMMENDATION_TODO_ROW_KEYS, RECOMMENDATION_ROUNDING_NOTE_KEYS,
    RECOMMENDATION_CURRENT_ROW_KEYS, RECOMMENDATION_RANGE_ROW_KEYS, RECOMMENDATION_DEVIATION_ROW_KEYS
  ].forEach(deepFreezeRisk);

  function recFail(code, detail) {
    return { ok: false, error: { code: code, detail: detail } };
  }

  // 非负整数的向上取整除法（金额一律整数最小货币单位，不变量 8）。
  function ceilDivMinor(num, den) {
    if (den <= 0) return null;
    return Math.floor((num + den - 1) / den);
  }

  /* floor(a * b / den) 的精确整数版：a、b 各自都是安全整数时乘积仍可能超出 2^53
   * （池子 1000 万 + 新增 100 万就会命中），双精度乘积会让「谁拿到尾差」随平台漂移。
   * BigInt 只在这里做中间放大，输出仍是安全整数；三个入参先按安全整数收口。 */
  function mulDivFloor(a, b, den) {
    if (!isRiskNonNegInt(a) || !isRiskNonNegInt(b) || !isRiskNonNegInt(den) || den === 0) return null;
    if (typeof BigInt !== 'function') return null;
    return Number(BigInt(a) * BigInt(b) / BigInt(den));
  }

  /* 把类别拉到「在投出这笔钱之后的池子里恰好占 goalBps」所需的**最小**新增金额。
   * D-049：资金来自已计入投资池的现金，投前投后总额相同，不重复扩大分母。 */
  function gapToGoalMinor(goalBps, valueMinor, plannedTotalMinor) {
    if (!isRiskNonNegInt(goalBps) || !isRiskNonNegInt(valueMinor) || !isRiskNonNegInt(plannedTotalMinor)) return null;
    if (typeof BigInt !== 'function') return null;
    var need = BigInt(goalBps) * BigInt(plannedTotalMinor) - BigInt(BPS_TOTAL) * BigInt(valueMinor);
    if (need <= BigInt(0)) return 0;
    var out = (need + BigInt(BPS_TOTAL - 1)) / BigInt(BPS_TOTAL);
    if (out > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(out);
  }

  /* 按 5A 冻结的稳定键把一笔钱分到若干类别：缺口降序 → 同缺口按类别序 → 逐类别取整后余额给排序最前者。
   * 乘积用 BigInt 放大（见 mulDivFloor），因此结果与调用顺序、对象键序、数据库行序都无关。 */
  function distributeNewFunds(list, amount) {
    var order = list.slice().sort(function (a, b) {
      if (a.needMinor !== b.needMinor) return b.needMinor - a.needMinor;
      return RISK_CLASSES.indexOf(a.assetClass) - RISK_CLASSES.indexOf(b.assetClass);
    });
    var needSum = 0;
    order.forEach(function (x) { needSum += x.needMinor; });
    var assigned = 0;
    order.forEach(function (x) {
      x.share = x.needMinor === 0 ? 0 : mulDivFloor(amount, x.needMinor, needSum);
      if (x.share === null) return;
      assigned += x.share;
    });
    if (order.some(function (x) { return x.share === null; })) return null;
    var leftover = amount - assigned;
    var receivers = [];
    for (var s = 0; s < leftover; s++) {
      order[s].share += 1;
      receivers.push(order[s].assetClass);
    }
    return { shares: order, leftoverMinor: leftover, receivers: receivers };
  }

  /* ① 新增资金优先再平衡：先补 below_min，再向 targetBps 收敛；绝不卖出 */

  function computeNewFundsAllocation(input) {
    if (!hasExactRiskKeys(input,
      ['target', 'deviation', 'requestedNewFundsMinor', 'newFundsAvailableMinor'],
      ['target', 'deviation', 'requestedNewFundsMinor', 'newFundsAvailableMinor'])) {
      return recFail('invalid_new_funds_request', '输入必须只包含自有数据字段 target / deviation / requestedNewFundsMinor / newFundsAvailableMinor');
    }
    var tv = validateAllocationTargetRecord(input.target);
    if (!tv.ok) return { ok: false, error: tv.error };
    var target = tv.record;

    var req = input.requestedNewFundsMinor, avail = input.newFundsAvailableMinor;
    if (!isRiskNonNegInt(req)) return recFail('invalid_new_funds', 'requestedNewFundsMinor 必须是非负安全整数（最小货币单位）');
    if (!isRiskNonNegInt(avail)) return recFail('invalid_new_funds', 'newFundsAvailableMinor 必须是非负安全整数（最小货币单位）');

    // 偏离结果必须是「同一份目标 + 同一遍估值」的产物：类别比例、金额与锚点全部交叉核对，
    // 这样任何绕过 computeAllocationDeviation 自行拼出来的偏离都会在这里 fail closed。
    var dev = input.deviation;
    if (!isRiskObject(dev) || ALLOCATION_DEVIATION_STATUSES.indexOf(dev.status) === -1) {
      return recFail('invalid_valuation_input', '必须传入 computeAllocationDeviation 的结果');
    }
    if (dev.targetLevel !== target.level || dev.targetVersion !== target.templateVersion) {
      return recFail('invalid_valuation_input', '偏离结果与目标版本不是同一份（等级或模板版本不一致）');
    }
    var devRows = copyRiskDenseDataArray(dev.classes);
    if (devRows === null || devRows.length !== RISK_CLASSES.length) {
      return recFail('invalid_valuation_input', '偏离结果必须恰好覆盖六个资产类别');
    }
    var byClass = {}, valuesByClass = {};
    var total = dev.investableTotalMinor;
    if (!isRiskNonNegInt(total)) return recFail('invalid_valuation_input', 'investableTotalMinor 必须是非负安全整数');
    for (var i = 0; i < devRows.length; i++) {
      var d = devRows[i];
      if (!isRiskObject(d) || RISK_CLASSES.indexOf(d.assetClass) === -1 || byClass[d.assetClass]) {
        return recFail('invalid_valuation_input', '偏离结果含未知或重复的资产类别');
      }
      if (d.assetClass !== RISK_CLASSES[i]) {
        return recFail('invalid_valuation_input', '偏离结果必须按冻结的资产类别顺序给出');
      }
      var rng = target.classes[d.assetClass];
      if (!isRiskNonNegInt(d.valueMinor) || d.minBps !== rng.minBps || d.targetBps !== rng.targetBps || d.maxBps !== rng.maxBps) {
        return recFail('invalid_valuation_input', '类别 ' + d.assetClass + ' 的估值或区间与目标版本不一致');
      }
      if (d.pctBps === null) {
        if (dev.status !== 'no_investable') {
          return recFail('invalid_valuation_input', '类别 ' + d.assetClass + ' 缺少比例，但估值状态并非 no_investable');
        }
      } else {
        if (!isRiskNonNegInt(d.pctBps)) return recFail('invalid_valuation_input', '类别 ' + d.assetClass + ' 的比例非法');
        if (compareToRange(d.pctBps, rng.minBps, rng.maxBps) !== d.band) {
          return recFail('invalid_valuation_input', '类别 ' + d.assetClass + ' 的容忍带与比例不符');
        }
      }
      byClass[d.assetClass] = d;
      valuesByClass[d.assetClass] = d.valueMinor;
    }
    for (var c = 0; c < RISK_CLASSES.length; c++) {
      if (!Object.prototype.hasOwnProperty.call(byClass, RISK_CLASSES[c])) {
        return recFail('invalid_valuation_input', '偏离结果缺少类别：' + RISK_CLASSES[c]);
      }
    }
    var classSum = 0;
    RISK_CLASSES.forEach(function (k) { classSum += byClass[k].valueMinor; });
    if (classSum !== total) return recFail('invalid_valuation_input', '类别估值合计与投资池不一致');
    if (dev.status === 'ok' && total > 0) {
      // 比例必须由 5C 冻结的唯一取整实现从同一份金额重新导出：被中途改写的「当前比例」在这里挡掉，
      // 5D 不会因为调用方递来一个自洽但虚假的 pctBps 就换掉分配依据。
      var rederived = bpsByLargestRemainder(valuesByClass, total);
      if (rederived.overflow) return recFail('invalid_valuation_input', '估值金额超出定点计算的安全整数范围');
      for (var rk = 0; rk < RISK_CLASSES.length; rk++) {
        var cls = RISK_CLASSES[rk];
        if (byClass[cls].pctBps !== rederived.map[cls]) {
          return recFail('invalid_valuation_input', '类别 ' + cls + ' 的比例与同一遍估值的取整结果不符');
        }
      }
    }

    // 可分配金额取输入与「可新增投资资金」的较小值；超上限必须显式说明而不是静默当作可用（§7.2 工作项 1）
    var allocatable = req < avail ? req : avail;
    var capped = req > avail;

    var base = {
      status: dev.status,
      requestedNewFundsMinor: req,
      newFundsAvailableMinor: avail,
      allocatableNewFundsMinor: allocatable,
      cappedToAvailable: capped,
      investableTotalMinor: total,
      plannedTotalMinor: total,
      targetLevel: target.level,
      targetVersion: target.templateVersion,
      asOf: typeof dev.asOf === 'string' ? dev.asOf : null
    };
    // 逐类别算出两档缺口金额（锚点 = 投出这笔钱之后的池子）
    var rows = [], overflow = false;
    RISK_CLASSES.forEach(function (k) {
      var d = byClass[k], range = target.classes[k];
      var minNeed = null, targetNeed = null;
      if (d.pctBps != null) {
        minNeed = gapToGoalMinor(range.minBps, d.valueMinor, base.plannedTotalMinor);
        targetNeed = gapToGoalMinor(range.targetBps, d.valueMinor, base.plannedTotalMinor);
        if (minNeed === null || targetNeed === null) overflow = true;
      }
      // basis 来自同一投资池的当前区间；池内现金转配不产生额外资产。
      var basis = 'at_or_above_target';
      if (d.pctBps == null) basis = 'unknown_base';
      else if (d.band === 'below_min') basis = 'below_min';
      else if (d.band === 'above_max') basis = 'above_max';
      else if (targetNeed > 0) basis = 'below_target';
      rows.push({
        assetClass: k, valueMinor: d.valueMinor, pctBps: d.pctBps,
        minBps: range.minBps, targetBps: range.targetBps, maxBps: range.maxBps, band: d.band,
        goalBps: null, minNeedMinor: minNeed, targetNeedMinor: targetNeed,
        allocatedMinor: 0, basis: basis
      });
    });
    if (overflow) {
      return recFail('recommendation_amount_overflow', '新增资金或投资池超出定点计算的安全整数范围');
    }

    var belowMinClasses = [], aboveMaxClasses = [], allWithin = true;
    rows.forEach(function (r) {
      if (r.basis === 'below_min') belowMinClasses.push(r.assetClass);
      if (r.basis === 'above_max') aboveMaxClasses.push(r.assetClass);
      if (r.band !== 'within') allWithin = false;
    });

    var rounding = { rule: NEW_FUND_MONEY_ROUNDING_RULE, leftoverMinor: 0, receivers: [] };
    var stage2Used = false;

    // 汇总成冻结形状：allocated / unallocated 一律**从逐类别结果求和**得到，
    // 不另记第二份数字，否则「总和 == 实际分配金额」这条守恒会靠调用点自觉维持（不变量 8）。
    function finish(adjustment) {
      var allocatedTotal = 0;
      rows.forEach(function (r) {
        allocatedTotal += r.allocatedMinor;
        if (!r.allocatedMinor) { r.goalBps = null; return; }
        var shortOfMin = r.basis === 'below_min' && r.minNeedMinor != null && r.allocatedMinor < r.minNeedMinor;
        r.goalBps = shortOfMin ? r.minBps : r.targetBps;
      });
      var unallocated = base.allocatableNewFundsMinor - allocatedTotal;
      var flags = {
        new_funds_below_min_first: belowMinClasses.length > 0,
        new_funds_converge_to_target: stage2Used,
        new_funds_within_tolerance: adjustment === 'within_tolerance',
        new_funds_no_investable: adjustment === 'no_investable',
        new_funds_zero_amount: adjustment === 'zero_allocatable',
        new_funds_capped_by_available: capped,
        new_funds_rounding_remainder: rounding.leftoverMinor > 0,
        new_funds_above_max_no_sell: aboveMaxClasses.length > 0
      };
      // 解释码按冻结词表的顺序给出，不受分支进入顺序影响
      var codes = RECOMMENDATION_EXPLAIN_CODES.filter(function (code) {
        return Object.prototype.hasOwnProperty.call(flags, code) && flags[code] === true;
      });
      return {
        ok: true,
        allocation: riskCopy({
          status: base.status,
          requestedNewFundsMinor: base.requestedNewFundsMinor,
          newFundsAvailableMinor: base.newFundsAvailableMinor,
          allocatableNewFundsMinor: base.allocatableNewFundsMinor,
          cappedToAvailable: base.cappedToAvailable,
          investableTotalMinor: base.investableTotalMinor,
          plannedTotalMinor: base.plannedTotalMinor,
          adjustment: adjustment,
          allocatedTotalMinor: allocatedTotal,
          unallocatedMinor: unallocated,
          classes: rows,
          belowMinClasses: belowMinClasses,
          aboveMaxClasses: aboveMaxClasses,
          rounding: {
            rule: rounding.rule,
            leftoverMinor: rounding.leftoverMinor,
            receivers: rounding.receivers,
            allocatedTotalMinor: allocatedTotal,
            unallocatedMinor: unallocated
          },
          explainCodes: codes,
          targetLevel: base.targetLevel,
          targetVersion: base.targetVersion,
          asOf: base.asOf
        })
      };
    }

    // ② 三类「本轮不分钱」的确定结论：没有比例基准、没有可分配金额、全部在容忍带内
    if (dev.status !== 'ok' || total === 0) return finish('no_investable');
    if (allocatable === 0) return finish('zero_allocatable');
    if (allWithin) {
      // 容忍带就是「无需调整」的定义（5A 冻结端点含入）；为了凑建议强行分配会制造无谓交易
      return finish('within_tolerance');
    }

    // D-049：这是池内现金转配，分母不变；保留现金目标下限，现金不再作为买入候选。
    var cashFloor = gapToGoalMinor(target.classes.cash.minBps, 0, total);
    var remaining = Math.min(allocatable, Math.max(0, byClass.cash.valueMinor - cashFloor));

    // ③ 第一优先级：把低于 minBps 的类别补进区间
    var stage1 = [], stage1Need = 0;
    rows.forEach(function (r) {
      if (r.assetClass === 'cash' || r.basis !== 'below_min' || !r.minNeedMinor) return;
      stage1.push({ assetClass: r.assetClass, row: r, needMinor: r.minNeedMinor, share: 0 });
      stage1Need += r.minNeedMinor;
    });
    if (stage1.length) {
      if (stage1Need >= remaining) {
        var d1 = distributeNewFunds(stage1, remaining);
        if (!d1) return recFail('recommendation_amount_overflow', '缺口分配计算超出定点安全整数范围');
        d1.shares.forEach(function (x) { x.row.allocatedMinor = x.share; });
        rounding.leftoverMinor += d1.leftoverMinor;
        d1.receivers.forEach(function (k) { rounding.receivers.push(k); });
        return finish('fill_below_min');
      }
      stage1.forEach(function (x) { x.row.allocatedMinor = x.needMinor; });
      remaining -= stage1Need;
    }

    // ④ 第二优先级：余下的钱向 targetBps 收敛（高配类别永远不在候选里：既不卖出也不追加）
    var stage2 = [], stage2Need = 0;
    rows.forEach(function (r) {
      if (r.assetClass === 'cash' || r.basis === 'above_max' || r.pctBps === null) return;
      var left = r.targetNeedMinor - r.allocatedMinor;
      if (left <= 0) return;
      stage2.push({ assetClass: r.assetClass, row: r, needMinor: left, share: 0 });
      stage2Need += left;
    });
    if (stage2.length) stage2Used = true;
    if (stage2Need >= remaining) {
      var d2 = distributeNewFunds(stage2, remaining);
      if (!d2) return recFail('recommendation_amount_overflow', '缺口分配计算超出定点安全整数范围');
      d2.shares.forEach(function (x) { x.row.allocatedMinor += x.share; });
      rounding.leftoverMinor += d2.leftoverMinor;
      d2.receivers.forEach(function (k) { rounding.receivers.push(k); });
      return finish('converge_to_target');
    }
    stage2.forEach(function (x) { x.row.allocatedMinor += x.needMinor; });
    return finish('converge_to_target');
  }

  /* ② 落到具体证券：只用 5C 的用户认可标的（按 position 顺序），没有可用候选就留类别级待办。
   * 用户没有提交「同类内份额」，等额分配是唯一不引入新判断的分法；顺序用于尾差与展示。
   * 缺映射的类别**不转投陌生标的**（不变量 5），金额原样保留并显式报告。 */

  function mapAllocationToApprovedInstruments(allocation, mapping) {
    var al = isRiskObject(allocation) && hasExactRiskKeys(allocation, NEW_FUND_ALLOCATION_KEYS, NEW_FUND_ALLOCATION_KEYS)
      ? allocation : null;
    if (!al) return recFail('invalid_new_funds_request', '必须传入 computeNewFundsAllocation 的结果');
    if (!isRiskObject(mapping) || !isRiskObject(mapping.byClass)) {
      return recFail('invalid_mapping_payload', '必须传入 checkApprovedMapping 的结果');
    }
    var classes = [], todos = [], mappedTotal = 0, unmappedTotal = 0;
    for (var i = 0; i < RISK_CLASSES.length; i++) {
      var k = RISK_CLASSES[i];
      var row = null;
      for (var r = 0; r < al.classes.length; r++) if (al.classes[r].assetClass === k) row = al.classes[r];
      if (!row) return recFail('invalid_new_funds_request', '分配结果缺少类别：' + k);
      var amount = row.allocatedMinor;
      var out = {
        assetClass: k, basis: row.basis, goalBps: row.goalBps,
        minNeedMinor: row.minNeedMinor, targetNeedMinor: row.targetNeedMinor,
        allocatedMinor: amount, instruments: []
      };
      classes.push(out);
      if (!amount) continue;
      var rows = Array.isArray(mapping.byClass[k]) ? mapping.byClass[k] : [];
      var usable = rows.filter(function (x) { return x && x.status === 'ok' && isRiskNonEmptyString(x.instrumentId); });
      if (!usable.length) {
        todos.push({
          code: rows.length ? 'invalid_instrument_reference' : 'missing_approved_instrument',
          assetClass: k,
          retainedMinor: amount
        });
        unmappedTotal += amount;
        continue;
      }
      var n = usable.length;
      var each = Math.floor(amount / n);
      var extra = amount - each * n;
      usable.forEach(function (x, idx) {
        out.instruments.push({
          instrumentId: x.instrumentId,
          symbol: x.symbol == null ? null : x.symbol,
          name: x.instrumentName == null ? null : x.instrumentName,
          position: x.position,
          allocatedMinor: each + (idx < extra ? 1 : 0)
        });
      });
      mappedTotal += amount;
    }
    if (mappedTotal + unmappedTotal !== al.allocatedTotalMinor) {
      return recFail('invalid_new_funds_request', '标的级分配之和与类别级不一致');
    }
    return {
      ok: true,
      classes: classes,
      todos: todos,
      mappedTotalMinor: mappedTotal,
      unmappedTotalMinor: unmappedTotal
    };
  }

  /* ③ 正式建议门禁：条件由服务端逐条判定，本段只负责**唯一一次**折叠成 formal / estimate。
   * 页面与仓储都不得再判一遍（不变量 3）。 */

  function recommendationStatusFromGate(checks) {
    var rows = copyRiskDenseDataArray(checks);
    if (rows === null) return recFail('invalid_recommendation_record', 'gate.checks 必须是稠密数组');
    var seen = {}, out = [];
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      if (!hasExactRiskKeys(c, RECOMMENDATION_GATE_ROW_KEYS, ['code', 'passed'])
        || RECOMMENDATION_GATE_CHECKS.indexOf(c.code) === -1 || typeof c.passed !== 'boolean') {
        return recFail('invalid_recommendation_record', '第 ' + (i + 1) + ' 项门禁条件不符合冻结词表');
      }
      if (seen[c.code]) return recFail('invalid_recommendation_record', '同一门禁条件重复给出：' + c.code);
      seen[c.code] = true;
      out.push({ code: c.code, passed: c.passed, detail: c.detail == null ? '' : String(c.detail) });
    }
    for (var g = 0; g < RECOMMENDATION_GATE_CHECKS.length; g++) {
      if (!seen[RECOMMENDATION_GATE_CHECKS[g]]) {
        return recFail('invalid_recommendation_record', '缺少门禁条件：' + RECOMMENDATION_GATE_CHECKS[g]);
      }
    }
    // 顺序固定为冻结词表顺序，与调用方拼装顺序无关
    out.sort(function (a, b) {
      return RECOMMENDATION_GATE_CHECKS.indexOf(a.code) - RECOMMENDATION_GATE_CHECKS.indexOf(b.code);
    });
    var failed = out.filter(function (x) { return !x.passed; }).map(function (x) { return x.code; });
    return { ok: true, checks: out, status: failed.length ? 'estimate' : 'formal', failedChecks: failed };
  }

  // 建议结果的冻结形状：十个顶层键 = 5A 的 RECOMMENDATION_OUTPUT_KEYS，逐子结构都有不变量断言。
  function validateRecommendationOutput(o) {
    if (!hasExactRiskKeys(o, RECOMMENDATION_OUTPUT_KEYS, RECOMMENDATION_OUTPUT_KEYS)) {
      return recFail('invalid_recommendation_output', '建议结果字段不符合冻结契约');
    }
    if (RECOMMENDATION_STATUSES.indexOf(o.status) === -1) {
      return recFail('invalid_recommendation_output', 'status 不在冻结的建议状态词表内');
    }
    var blockers = copyRiskDenseDataArray(o.blockers);
    if (blockers === null) return recFail('invalid_recommendation_output', 'blockers 必须是稠密数组');
    for (var b = 0; b < blockers.length; b++) {
      if (!hasExactRiskKeys(blockers[b], ['code', 'detail'], ['code'])
        || !isRiskNonEmptyString(blockers[b].code)) {
        return recFail('invalid_recommendation_output', '第 ' + (b + 1) + ' 项阻塞项形状非法');
      }
    }
    if (!isCalendarDate(o.dataCutoff)) return recFail('invalid_recommendation_output', 'dataCutoff 必须是真实存在的 YYYY-MM-DD');
    if (!hasExactRiskKeys(o.versions, RECOMMENDATION_VERSION_KEYS, RECOMMENDATION_VERSION_KEYS)) {
      return recFail('invalid_recommendation_output', 'versions 必须绑定全部版本与不可变引用');
    }
    var v = o.versions;
    var refOk = true;
    ['ruleVersion', 'targetVersion', 'assessmentId', 'targetId', 'closeId', 'snapshotId', 'dataCutoff', 'asOf'].forEach(function (key) {
      if (!isRiskNonEmptyString(v[key])) refOk = false;
    });
    if (!refOk || !isRiskHex64(v.snapshotPayloadHash)) {
      return recFail('invalid_recommendation_output', '版本引用含空值或快照哈希不是 64 位十六进制');
    }
    if (!isRiskNonNegInt(v.targetLevel) || RISK_LEVELS.indexOf(v.targetLevel) === -1) {
      return recFail('invalid_recommendation_output', 'versions.targetLevel 不是 1–5 的风险上限');
    }
    if (v.ruleVersion !== RISK_RULE_VERSION || v.targetVersion !== RISK_TARGET_VERSION) {
      return recFail('invalid_rule_version', '建议结果绑定的规则或目标版本不是当前可用版本');
    }

    function rows6(list, label, keys) {
      var rows = copyRiskDenseDataArray(list);
      if (rows === null || rows.length !== RISK_CLASSES.length) {
        return { bad: label + ' 必须恰好按冻结顺序给出六个类别' };
      }
      for (var i = 0; i < rows.length; i++) {
        if (!hasExactRiskKeys(rows[i], keys, keys)) return { bad: label + ' 第 ' + (i + 1) + ' 项字段不符合冻结契约' };
        if (rows[i].assetClass !== RISK_CLASSES[i]) return { bad: label + ' 第 ' + (i + 1) + ' 项不是冻结的资产类别顺序' };
      }
      return { rows: rows };
    }

    var cur = rows6(o.currentAllocation, 'currentAllocation', RECOMMENDATION_CURRENT_ROW_KEYS);
    if (cur.bad) return recFail('invalid_recommendation_output', cur.bad);
    for (var ci = 0; ci < cur.rows.length; ci++) {
      if (!isRiskNonNegInt(cur.rows[ci].valueMinor)) {
        return recFail('invalid_recommendation_output', 'currentAllocation 必须是整数最小货币单位');
      }
      if (cur.rows[ci].pctBps !== null && !isRiskNonNegInt(cur.rows[ci].pctBps)) {
        return recFail('invalid_recommendation_output', 'currentAllocation 的比例非法');
      }
    }
    var classSum = 0;
    cur.rows.forEach(function (x) { classSum += x.valueMinor; });

    var ranges = rows6(o.targetRanges, 'targetRanges', RECOMMENDATION_RANGE_ROW_KEYS);
    if (ranges.bad) return recFail('invalid_recommendation_output', ranges.bad);
    var tplClasses = {}, rangeBad = false;
    ranges.rows.forEach(function (x) {
      ['minBps', 'targetBps', 'maxBps'].forEach(function (key) {
        if (!isRiskNonNegInt(x[key]) || x[key] > BPS_TOTAL) rangeBad = true;
      });
      tplClasses[x.assetClass] = { minBps: x.minBps, targetBps: x.targetBps, maxBps: x.maxBps };
    });
    if (rangeBad) return recFail('invalid_proportion', '目标区间的比例非法');
    // 区间直接复用 5A 的模板校验（Σtarget 精确 10000、min<=target<=max、内容与版本一致）：
    // 建议里显示的目标区间必须能被冻结模板解释，不接受「自洽但被换过的一组比例」。
    var tplCheck = validateTargetTemplate({
      level: v.targetLevel, templateVersion: v.targetVersion, classes: tplClasses
    });
    if (!tplCheck.ok) return { ok: false, error: tplCheck.error };

    var devs = rows6(o.deviations, 'deviations', RECOMMENDATION_DEVIATION_ROW_KEYS);
    if (devs.bad) return recFail('invalid_recommendation_output', devs.bad);
    for (var di = 0; di < devs.rows.length; di++) {
      var d = devs.rows[di], range = tplClasses[d.assetClass];
      if (d.minBps !== range.minBps || d.targetBps !== range.targetBps || d.maxBps !== range.maxBps) {
        return recFail('invalid_recommendation_output', 'deviations 与 targetRanges 不是同一份区间');
      }
      if (d.pctBps === null) {
        if (d.band !== null || d.deviationBps !== null) {
          return recFail('invalid_recommendation_output', '没有比例时不得给出偏离');
        }
        continue;
      }
      if (d.pctBps !== cur.rows[di].pctBps) {
        return recFail('invalid_recommendation_output', 'deviations 的比例与 currentAllocation 不一致');
      }
      if (d.deviationBps !== d.pctBps - d.targetBps) {
        return recFail('invalid_recommendation_output', '偏离值必须是同一份比例与目标的差');
      }
      if (compareToRange(d.pctBps, d.minBps, d.maxBps) !== d.band) {
        return recFail('invalid_recommendation_output', '容忍带与比例不符');
      }
    }

    var allocs = rows6(o.categoryAllocations, 'categoryAllocations', RECOMMENDATION_CLASS_TARGET_KEYS);
    if (allocs.bad) return recFail('invalid_recommendation_output', allocs.bad);
    var allocSum = 0, todoClasses = [];
    for (var ai = 0; ai < allocs.rows.length; ai++) {
      var a = allocs.rows[ai];
      if (NEW_FUND_CLASS_BASES.indexOf(a.basis) === -1) {
        return recFail('invalid_recommendation_output', 'categoryAllocations 的 basis 不在冻结词表内');
      }
      if (!isRiskNonNegInt(a.allocatedMinor)) {
        return recFail('invalid_recommendation_output', '类别分配必须是非负整数最小货币单位（绝不返回负数或卖出指令）');
      }
      if ((a.minNeedMinor !== null && !isRiskNonNegInt(a.minNeedMinor))
        || (a.targetNeedMinor !== null && !isRiskNonNegInt(a.targetNeedMinor))) {
        return recFail('invalid_recommendation_output', '缺口金额必须是非负整数或 null');
      }
      if (a.goalBps !== null && !isRiskNonNegInt(a.goalBps)) {
        return recFail('invalid_recommendation_output', 'goalBps 非法');
      }
      if (a.basis === 'above_max' && a.allocatedMinor !== 0) {
        return recFail('invalid_recommendation_output', '高配类别不得得到新增资金');
      }
      if (a.basis === 'at_or_above_target' && a.allocatedMinor !== 0) {
        return recFail('invalid_recommendation_output', '已在目标之上的类别不得再追加新增资金');
      }
      var items = copyRiskDenseDataArray(a.instruments);
      if (items === null) return recFail('invalid_recommendation_output', 'instruments 必须是稠密数组');
      var itemSum = 0;
      for (var ii = 0; ii < items.length; ii++) {
        var it = items[ii];
        if (!hasExactRiskKeys(it, RECOMMENDATION_INSTRUMENT_ROW_KEYS, RECOMMENDATION_INSTRUMENT_ROW_KEYS)
          || !isRiskNonEmptyString(it.instrumentId) || !isRiskNonNegInt(it.position)
          || !isRiskNonNegInt(it.allocatedMinor)) {
          return recFail('invalid_recommendation_output', '认可标的分配行形状非法');
        }
        itemSum += it.allocatedMinor;
      }
      // 有标的时逐标的之和必须等于类别金额；没有可用标的时金额原样保留为类别级待办（不静默改投）
      if (items.length && itemSum !== a.allocatedMinor) {
        return recFail('invalid_recommendation_output', '标的级分配之和与类别级不一致：' + a.assetClass);
      }
      if (a.allocatedMinor && !items.length) todoClasses.push(a.assetClass);
      allocSum += a.allocatedMinor;
    }

    var rn = o.roundingNote;
    if (!hasExactRiskKeys(rn, RECOMMENDATION_ROUNDING_NOTE_KEYS, RECOMMENDATION_ROUNDING_NOTE_KEYS)) {
      return recFail('invalid_recommendation_output', 'roundingNote 字段不符合冻结契约');
    }
    if (rn.rule !== NEW_FUND_MONEY_ROUNDING_RULE) {
      return recFail('invalid_recommendation_output', '尾差规则文字必须来自 5A 冻结的稳定键');
    }
    if (NEW_FUND_ADJUSTMENTS.indexOf(rn.adjustment) === -1) {
      return recFail('invalid_recommendation_output', 'adjustment 不在冻结词表内');
    }
    var rnNumbersOk = ['leftoverMinor', 'requestedNewFundsMinor', 'allocatableNewFundsMinor', 'allocatedTotalMinor', 'unallocatedMinor']
      .every(function (key) { return isRiskNonNegInt(rn[key]); });
    if (!rnNumbersOk) return recFail('invalid_recommendation_output', 'roundingNote 的金额必须是非负安全整数');
    if (typeof rn.cappedToAvailable !== 'boolean') {
      return recFail('invalid_recommendation_output', 'cappedToAvailable 必须是布尔值');
    }
    var receivers = copyRiskDenseDataArray(rn.receivers);
    if (receivers === null) return recFail('invalid_recommendation_output', 'receivers 必须是稠密数组');
    var receiversOk = receivers.every(function (k) { return RISK_CLASSES.indexOf(k) !== -1; });
    if (!receiversOk) return recFail('invalid_recommendation_output', '尾差接收类别非法');
    if (rn.leftoverMinor > receivers.length) {
      return recFail('invalid_recommendation_output', '尾差必须逐单位说明接收类别');
    }
    // 守恒：类别之和 == 实际分配金额 == 可分配 − 未分配（不变量 8）
    if (allocSum !== rn.allocatedTotalMinor) {
      return recFail('invalid_recommendation_output', '各类别分配之和必须等于实际分配金额');
    }
    if (rn.allocatableNewFundsMinor !== rn.allocatedTotalMinor + rn.unallocatedMinor) {
      return recFail('invalid_recommendation_output', '可分配金额必须等于已分配与未分配之和');
    }
    if (rn.allocatableNewFundsMinor < rn.requestedNewFundsMinor && !rn.cappedToAvailable) {
      return recFail('invalid_recommendation_output', '实际可分配小于请求金额时必须显式标记上限截断');
    }
    if (rn.allocatableNewFundsMinor > rn.requestedNewFundsMinor) {
      return recFail('invalid_recommendation_output', '可分配金额不得超过用户请求的新增资金');
    }
    if (classSum === 0 && rn.allocatedTotalMinor !== 0) {
      return recFail('invalid_recommendation_output', '没有可依赖的投资池时不得给出分配金额');
    }

    var codes = copyRiskDenseDataArray(o.explainCodes);
    if (codes === null) return recFail('invalid_recommendation_output', 'explainCodes 必须是稠密数组');
    var codeSeen = {};
    for (var e = 0; e < codes.length; e++) {
      if (RECOMMENDATION_EXPLAIN_CODES.indexOf(codes[e]) === -1) {
        return recFail('invalid_recommendation_output', '未知解释码：' + codes[e]);
      }
      if (codeSeen[codes[e]]) return recFail('invalid_recommendation_output', '解释码重复给出：' + codes[e]);
      codeSeen[codes[e]] = true;
    }
    if (todoClasses.length && !codeSeen.new_funds_missing_approved_instrument) {
      return recFail('invalid_recommendation_output', '有金额却没有可用标的时必须给出待办解释码');
    }
    return { ok: true, output: riskCopy(o), todoClasses: todoClasses };
  }

  // 把已通过校验的分片装成冻结输出：拼装位置只有一处，API / 仓储 / 页面不再各写一份形状。
  function buildRecommendationResult(input) {
    if (!hasExactRiskKeys(input,
      ['status', 'blockers', 'dataCutoff', 'versions', 'deviation', 'allocation', 'mapping'],
      ['status', 'blockers', 'dataCutoff', 'versions', 'deviation', 'allocation', 'mapping'])) {
      return recFail('invalid_recommendation_output', '组装输入必须只包含 status / blockers / dataCutoff / versions / deviation / allocation / mapping');
    }
    var dev = input.deviation, al = input.allocation, mp = input.mapping;
    if (!isRiskObject(dev) || !isRiskObject(al) || !isRiskObject(mp)) {
      return recFail('invalid_recommendation_output', '必须传入偏离、分配与标的映射三份同遍结果');
    }
    var blockers = copyRiskDenseDataArray(input.blockers);
    if (blockers === null) return recFail('invalid_recommendation_output', 'blockers 必须是稠密数组');
    var out = {
      status: input.status,
      blockers: blockers.map(function (b) {
        return { code: b.code == null ? '' : String(b.code), detail: b.detail == null ? '' : String(b.detail) };
      }),
      dataCutoff: input.dataCutoff,
      currentAllocation: dev.classes.map(function (x) {
        return { assetClass: x.assetClass, valueMinor: x.valueMinor, pctBps: x.pctBps };
      }),
      targetRanges: dev.classes.map(function (x) {
        return { assetClass: x.assetClass, minBps: x.minBps, targetBps: x.targetBps, maxBps: x.maxBps };
      }),
      deviations: dev.classes.map(function (x) {
        return {
          assetClass: x.assetClass, pctBps: x.pctBps, minBps: x.minBps, maxBps: x.maxBps,
          targetBps: x.targetBps, band: x.band, deviationBps: x.deviationBps
        };
      }),
      categoryAllocations: mp.classes.map(function (x) {
        return {
          assetClass: x.assetClass, basis: x.basis, goalBps: x.goalBps,
          minNeedMinor: x.minNeedMinor, targetNeedMinor: x.targetNeedMinor,
          allocatedMinor: x.allocatedMinor, instruments: x.instruments
        };
      }),
      roundingNote: {
        rule: al.rounding.rule,
        leftoverMinor: al.rounding.leftoverMinor,
        receivers: al.rounding.receivers,
        adjustment: al.adjustment,
        requestedNewFundsMinor: al.requestedNewFundsMinor,
        allocatableNewFundsMinor: al.allocatableNewFundsMinor,
        allocatedTotalMinor: al.allocatedTotalMinor,
        unallocatedMinor: al.unallocatedMinor,
        cappedToAvailable: al.cappedToAvailable
      },
      explainCodes: al.explainCodes.indexOf('new_funds_missing_approved_instrument') !== -1 || !mp.todos.length
        ? al.explainCodes
        : al.explainCodes.concat(['new_funds_missing_approved_instrument']),
      versions: input.versions
    };
    var checked = validateRecommendationOutput(out);
    if (!checked.ok) return { ok: false, error: checked.error };
    return { ok: true, result: checked.output, todos: riskCopy(mp.todos) };
  }

  // 落库记录的读取即复核：伪造「正式」状态、偷换引用或破坏守恒都在这里挡下（与 5B/5C 同纪律）。
  function validateRecommendationRecord(record) {
    if (!hasExactRiskKeys(record, RECOMMENDATION_RECORD_KEYS, RECOMMENDATION_RECORD_KEYS)) {
      return recFail('invalid_recommendation_record', '建议记录字段不符合冻结契约');
    }
    if (!isRiskNonEmptyString(record.id) || !isRiskHex64(record.inputHash)) {
      return recFail('invalid_recommendation_record', '建议记录缺少 id 或 inputHash 不是 64 位十六进制');
    }
    if (typeof record.createdAt !== 'string' || !isRiskNonEmptyString(record.createdAt)) {
      return recFail('invalid_recommendation_record', '建议记录缺少 createdAt');
    }
    if (RECOMMENDATION_STATUSES.indexOf(record.status) === -1) {
      return recFail('invalid_recommendation_record', 'status 不在冻结的建议状态词表内');
    }
    var refBad = false;
    ['ruleVersion', 'targetVersion', 'assessmentId', 'targetId', 'closeId', 'snapshotId', 'dataCutoff', 'asOf']
      .forEach(function (k) {
        if (!isRiskNonEmptyString(record[k])) refBad = true;
      });
    if (refBad || !isRiskHex64(record.snapshotPayloadHash)) {
      return recFail('invalid_recommendation_record', '建议记录必须绑定全部不可变引用');
    }
    var amountBad = false;
    ['requestedNewFundsMinor', 'newFundsAvailableMinor', 'allocatableNewFundsMinor', 'allocatedTotalMinor']
      .forEach(function (k) {
        if (!isRiskNonNegInt(record[k])) amountBad = true;
      });
    if (amountBad) return recFail('invalid_recommendation_record', '金额必须是非负安全整数');
    if (record.allocatableNewFundsMinor > record.requestedNewFundsMinor
      || record.allocatableNewFundsMinor > record.newFundsAvailableMinor) {
      return recFail('invalid_recommendation_record', '可分配金额不得大于请求金额或可新增投资资金');
    }
    // D-052：gate 区键集显式化（checks 必需；capture / explanationVersion 可选）。
    // 多余键或非对象一律拒绝；旧记录的 { checks } / { checks, capture } 形状照常通过。
    if (!hasExactRiskKeys(record.gate, RECOMMENDATION_GATE_KEYS, RECOMMENDATION_GATE_REQUIRED_KEYS)) {
      return recFail('invalid_recommendation_record', 'gate 必须是含 checks 的对象，且只允许 capture / explanationVersion 可选键');
    }
    if (record.gate.explanationVersion !== undefined
      && (typeof record.gate.explanationVersion !== 'string' || record.gate.explanationVersion.trim() === '')) {
      return recFail('invalid_recommendation_record', '解释版本必须是非空字符串');
    }
    var gate = recommendationStatusFromGate(record.gate && record.gate.checks);
    if (!gate.ok) return { ok: false, error: gate.error };
    if (gate.status !== record.status) {
      return recFail('invalid_recommendation_record', '门禁结论与状态不符：任一条件不满足都不得标记为正式建议');
    }
    var todoRows = copyRiskDenseDataArray(record.todos);
    if (todoRows === null) return recFail('invalid_recommendation_record', 'todos 必须是稠密数组');
    for (var t = 0; t < todoRows.length; t++) {
      var todo = todoRows[t];
      if (!hasExactRiskKeys(todo, RECOMMENDATION_TODO_ROW_KEYS, RECOMMENDATION_TODO_ROW_KEYS)
        || RECOMMENDATION_TODO_CODES.indexOf(todo.code) === -1
        || RISK_CLASSES.indexOf(todo.assetClass) === -1
        || !isRiskNonNegInt(todo.retainedMinor) || todo.retainedMinor <= 0) {
        return recFail('invalid_recommendation_record', '第 ' + (t + 1) + ' 项待办不符合冻结契约');
      }
    }
    var res = validateRecommendationOutput(record.result);
    if (!res.ok) return { ok: false, error: res.error };
    // 待办必须与「有金额却没有可用标的」的类别逐一对应：两边不一致说明有一侧被改写
    var todoByClass = {};
    todoRows.forEach(function (x) { todoByClass[x.assetClass] = x; });
    if (Object.keys(todoByClass).length !== res.todoClasses.length) {
      return recFail('invalid_recommendation_record', '类别级待办与未映射类别数量不一致');
    }
    var todoSum = 0, unmappedSum = 0;
    todoRows.forEach(function (x) { todoSum += x.retainedMinor; });
    res.output.categoryAllocations.forEach(function (row) {
      if (row.allocatedMinor && !row.instruments.length) unmappedSum += row.allocatedMinor;
    });
    if (todoSum !== unmappedSum) {
      return recFail('invalid_recommendation_record', '待办保留金额与未落到标的的分配不一致');
    }
    var v = res.output.versions;
    if (res.output.status !== record.status) {
      return recFail('invalid_recommendation_record', '结果状态与记录状态不一致');
    }
    if (v.assessmentId !== record.assessmentId || v.targetId !== record.targetId
      || v.closeId !== record.closeId || v.snapshotId !== record.snapshotId
      || v.snapshotPayloadHash !== record.snapshotPayloadHash || v.dataCutoff !== record.dataCutoff
      || v.asOf !== record.asOf || v.ruleVersion !== record.ruleVersion || v.targetVersion !== record.targetVersion) {
      return recFail('invalid_recommendation_record', '结果内引用的版本与记录绑定不一致');
    }
    if (res.output.roundingNote.allocatedTotalMinor !== record.allocatedTotalMinor) {
      return recFail('invalid_recommendation_record', '实际分配金额与记录不一致');
    }
    return { ok: true, record: riskCopy(record), gate: gate };
  }

  // 建议历史排序：createdAt 降序 → id 升序（与数据库行序无关，不变量 6）。
  function compareRecommendations(a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  }

  function sortRecommendations(list) {
    var rows = copyRiskDenseDataArray(list);
    if (rows === null) return null;
    return rows.sort(compareRecommendations);
  }

  // 契约快照：迁移 / 仓储 / API / 页面从这里取键集合与词表，不得各自硬编码（D-025）。
  function recommendation5DContract() {
    return riskCopy({
      allocationKeys: NEW_FUND_ALLOCATION_KEYS,
      allocationClassRowKeys: NEW_FUND_CLASS_ROW_KEYS,
      roundingKeys: NEW_FUND_ROUNDING_KEYS,
      moneyRoundingRule: NEW_FUND_MONEY_ROUNDING_RULE,
      adjustments: NEW_FUND_ADJUSTMENTS,
      classBases: NEW_FUND_CLASS_BASES,
      explainCodes: RECOMMENDATION_EXPLAIN_CODES,
      gateChecks: RECOMMENDATION_GATE_CHECKS,
      instrumentStatuses: RECOMMENDATION_INSTRUMENT_STATUSES,
      todoCodes: RECOMMENDATION_TODO_CODES,
      classTargetKeys: RECOMMENDATION_CLASS_TARGET_KEYS,
      instrumentRowKeys: RECOMMENDATION_INSTRUMENT_ROW_KEYS,
      versionKeys: RECOMMENDATION_VERSION_KEYS,
      gateRowKeys: RECOMMENDATION_GATE_ROW_KEYS,
      gateKeys: RECOMMENDATION_GATE_KEYS,
      gateRequiredKeys: RECOMMENDATION_GATE_REQUIRED_KEYS,
      recordKeys: RECOMMENDATION_RECORD_KEYS,
      outputKeys: RECOMMENDATION_OUTPUT_KEYS,
      statuses: RECOMMENDATION_STATUSES,
      errorCodes: RECOMMENDATION_ERROR_CODES,
      allocationOrder: RISK_CLASSES,
      ruleVersion: RISK_RULE_VERSION,
      targetVersion: RISK_TARGET_VERSION,
      bpsTotal: BPS_TOTAL
    });
  }

  /* ================= Phase 5 验收补口 G5-R2：建议封存输入与当前事实的身份比对 =================
   * 历史建议生成后仍然可读，但事实只要变过，页面就不能再把它说成当前「全部门禁通过」——
   * 「当时通过」不等于「当前可执行」。这里只回答一件事：**封存的输入与当前事实还是同一份吗**。
   *   - 不重算偏离、不重跑门禁、不产出任何金额（不变量 3：判断仍来自服务端与计算时的门禁）；
   *   - 页面拿到 reason 码自行翻译文案（js/app.js 的 ADVICE_STALE_LABELS），本层不含任何 UI 文本。 */
  function canonicalJson(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(function (k) {
        return JSON.stringify(k) + ':' + canonicalJson(value[k]);
      }).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  // 与 server/recommendations.js 的 normalizeInput 同一口径：先按内容给数组排序，再按键序序列化。
  // 封存的 gate.capture 已按该口径存盘，页面读到的资产原文是数据库行序，两边都排过才可比。
  function factSignature(value) {
    var clone = JSON.parse(JSON.stringify(value === undefined ? null : value));
    if (clone && typeof clone === 'object' && !Array.isArray(clone)) {
      Object.keys(clone).forEach(function (k) {
        if (Array.isArray(clone[k])) {
          clone[k] = clone[k].slice().sort(function (a, b) {
            var x = canonicalJson(a), y = canonicalJson(b);
            return x < y ? -1 : x > y ? 1 : 0;
          });
        }
      });
    }
    return canonicalJson(clone);
  }

  // 认可映射只比「类别 + 标的」这一层身份：读取视图的行带 symbol / status 等派生字段，
  // 封存行是原始记录，比整行会永远不相等，等于把每份建议都误判成过期。
  function mappingSignature(rows) {
    return (rows || []).map(function (r) {
      return String(r.assetClass) + '|' + String(r.instrumentId);
    }).sort().join(',');
  }

  var ADVICE_STALE_REASON_CODES = [
    'target_not_current',   // 当前没有生效的目标版本（评估或目标已被换掉）
    'valuation_not_formal', // 服务端 canAdvise=false：行情过期 / 分类未确认等
    'assessment_changed',   // 页面当前评估已不是建议引用的那一份
    'target_changed',       // 页面当前目标已不是建议引用的那一份
    'mapping_changed',      // 认可标的映射被撤销或改过
    'assets_changed'        // 资产 / 持仓 / 行情 / 汇率与生成时不同
  ];

  // 估算建议从未声称「门禁通过」，改判过期只会把「未达门槛」和「已过期」两件事混在一起，
  // 因此只对 formal 产物做身份比对；assetsSig 为 null 表示页面尚未读到资产，不据此判过期。
  function adviceStaleness(item, view, assetsSig) {
    if (!item || item.status !== 'formal' || !view) return [];
    var rec = item.recommendation || {};
    var capture = (rec.gate && rec.gate.capture) || {};
    if (view.status !== 'current' || !view.target || !view.assessment) return ['target_not_current'];
    var reasons = [];
    if (view.allocation && view.allocation.canAdvise === false) reasons.push('valuation_not_formal');
    if (rec.assessmentId && view.assessment.id !== rec.assessmentId) reasons.push('assessment_changed');
    if (rec.targetId && view.target.id !== rec.targetId) reasons.push('target_changed');
    if (mappingSignature((view.mapping && view.mapping.rows) || []) !==
        mappingSignature(capture.approvedInstruments || [])) reasons.push('mapping_changed');
    if (assetsSig != null && factSignature(capture.assets) !== assetsSig) reasons.push('assets_changed');
    return reasons;
  }

  /* ------------------- 决策状态机与执行关联（Phase 6，D-057） -------------------
   * 6B 按 6A 冻结契约（PHASE6_CONTRACT.md）实现的唯一状态机口径：
   *   - 7 状态的完整矩阵是 7×7 = 49 个有序对：合法恰好 6 条，其余 43 条（含 7 条自转移）非法；
   *   - 转移判定、请求 / 记录 / 事件 / 关联 / 快照的精确键白名单与事件链式一致性校验都是纯函数；
   *   - 时间（occurredAt / recordedAt）、actor、id 与理由码由服务端生成（契约 §1.5 / §6.2 / §6.3），
   *     本段不读时钟、不触网络与存储；快照 sha256 在服务端仓储层复算（浏览器侧没有 node:crypto）。
   */

  var DECISION_STATES = deepFreezeRisk(['proposed', 'accepted', 'deferred', 'dismissed', 'executed', 'reviewed', 'archived']);
  // 权威转移表（契约 §1.2）：只列合法方向；自转移与表外方向一律非法。
  var DECISION_LEGAL_TRANSITIONS = deepFreezeRisk({
    proposed: ['accepted', 'deferred', 'dismissed'],
    accepted: ['executed', 'archived'],
    executed: ['reviewed']
  });
  var DECISION_INTENTS = deepFreezeRisk(['accepted', 'deferred', 'dismissed']);
  var DECISION_EVENT_FROM_STATES = deepFreezeRisk(['proposed', 'accepted', 'executed']);
  var DECISION_EVENT_TO_STATES = deepFreezeRisk(['accepted', 'deferred', 'dismissed', 'executed', 'reviewed', 'archived']);
  var DECISION_REASON_CODES = deepFreezeRisk([
    'agree', 'postpone', 'dismiss_not_actionable', 'executed_as_planned', 'executed_deviation',
    'no_trade', 'abandoned', 'reviewed_with_drift', 'reviewed_no_drift'
  ]);
  var DECISION_ARCHIVE_REASON_CODES = deepFreezeRisk(['no_trade', 'abandoned']);
  var DECISION_SNAPSHOT_REASON_CODES = deepFreezeRisk(['cash_not_reconciled', 'valuation_not_formal']);
  var DECISION_ACTOR = 'local-user';
  var DECISION_SNAPSHOT_SCHEMA_VERSION = 1;
  var DECISION_NOTE_MAX_CHARS = 2000;

  var DECISION_REQUEST_KEYS = deepFreezeRisk(['recommendationId', 'intent', 'note']);
  var DECISION_EVENT_REQUEST_KEYS = deepFreezeRisk(['toState', 'note']);
  // 契约 §6.2：服务端派生字段（camelCase 载荷名）。出现在任何决策载荷里即 400 invalid_decision_payload。
  var DECISION_SERVER_GENERATED_KEYS = deepFreezeRisk([
    'id', 'seq', 'state', 'reasonCode', 'occurredAt', 'recordedAt', 'actor',
    'snapshot', 'snapshotHash', 'payloadHash', 'createdAt', 'updatedAt',
    'linkedOn', 'linkedAt', 'unlinkedOn', 'unlinkedAt'
  ]);

  var DECISION_RECORD_KEYS = deepFreezeRisk(['id', 'recommendationId', 'state', 'lastSeq', 'createdAt', 'updatedAt']);
  var DECISION_EVENT_RECORD_KEYS = deepFreezeRisk([
    'id', 'decisionId', 'seq', 'fromState', 'toState', 'reasonCode', 'note',
    'occurredAt', 'recordedAt', 'actor', 'snapshot', 'snapshotHash', 'payloadHash'
  ]);
  var DECISION_LINK_RECORD_KEYS = deepFreezeRisk([
    'id', 'decisionId', 'securityEventId', 'linkedOn', 'linkedAt', 'note',
    'unlinkedOn', 'unlinkedAt', 'unlinkNote'
  ]);
  var DECISION_SNAPSHOT_KEYS = deepFreezeRisk([
    'schemaVersion', 'asOf', 'capturedAt', 'available', 'reason', 'blockers', 'cashReconciled',
    'valuationStatus', 'netWorthMinor', 'investableTotalMinor', 'targetRef', 'recommendationRef',
    'classes', 'execution'
  ]);
  var DECISION_SNAPSHOT_TARGETREF_KEYS = deepFreezeRisk(['targetId', 'templateVersion', 'ruleVersion', 'level']);
  var DECISION_SNAPSHOT_RECREF_KEYS = deepFreezeRisk(['recommendationId', 'inputHash', 'asOf', 'status', 'allocatedTotalMinor']);
  var DECISION_SNAPSHOT_CLASS_KEYS = deepFreezeRisk(['assetClass', 'valueMinor', 'pctBps', 'minBps', 'targetBps', 'maxBps', 'band', 'deviationBps']);
  var DECISION_SNAPSHOT_BLOCKER_KEYS = deepFreezeRisk(['code', 'detail']);
  var DECISION_EXECUTION_KEYS = deepFreezeRisk(['linkedCount', 'linkedPrincipalCnyMinor', 'linkedFeeCnyMinor', 'remainingMinor', 'fxUnavailable']);
  var DECISION_SNAPSHOT_BANDS = deepFreezeRisk(['below_min', 'within', 'above_max']);
  var DECISION_ID_RE = /^dec-[0-9a-f]{16}$/;
  var DECISION_EVENT_ID_RE = /^dev-[0-9a-f]{16}$/;
  var DECISION_LINK_ID_RE = /^lnk-[0-9a-f]{16}$/;
  var DECISION_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  var DECISION_HASH_RE = /^[0-9a-f]{64}$/;

  function decisionFail(code, detail) {
    return { ok: false, error: { code: code, detail: detail || code } };
  }

  function isDecisionIsoTimestamp(s) {
    return typeof s === 'string' && DECISION_ISO_RE.test(s) && isCalendarDate(s.slice(0, 10));
  }

  // 契约 §1.2：两侧都必须在词表内、禁止自转移、方向必须在权威表里。
  function isLegalDecisionTransition(fromState, toState) {
    if (DECISION_STATES.indexOf(fromState) === -1 || DECISION_STATES.indexOf(toState) === -1) return false;
    if (fromState === toState) return false;
    var allowed = DECISION_LEGAL_TRANSITIONS[fromState];
    return !!allowed && allowed.indexOf(toState) !== -1;
  }

  // 契约 §6.3（二次勘误后）：归档先要求活动关联为 0，再唯一判定 ——
  // `no_trade` 当且仅当「建议金额为 0 且该决策从未存在任何 decision_links 行」；
  // 其余（正金额未买即放弃、曾关联后全部解绑）均为 `abandoned`。
  // 判定只读封存建议金额与关联历史，不从自由文本猜意图。
  function deriveArchiveReason(allocatedTotalMinor, hasAnyLinkRow) {
    return (allocatedTotalMinor === 0 && !hasAnyLinkRow) ? 'no_trade' : 'abandoned';
  }

  // 契约 §4.4：available = canAdvise && cashReconciled；可比时 reason 恒为 null，
  // 不可比时按「现金未核对优先」取两个冻结值之一。
  function decisionSnapshotGate(overview) {
    var cashReconciled = !(overview && overview.freshness && overview.freshness.balanceStale === true);
    var available = (overview && overview.canAdvise === true) && cashReconciled;
    var reason = available ? null : (cashReconciled ? 'valuation_not_formal' : 'cash_not_reconciled');
    return { cashReconciled: cashReconciled, available: available, reason: reason };
  }

  function normalizeDecisionNote(raw) {
    if (raw == null) return { ok: true, note: null };
    if (typeof raw !== 'string') return { ok: false };
    var note = raw.trim();
    if (note.length > DECISION_NOTE_MAX_CHARS) return { ok: false };
    return { ok: true, note: note ? note : null };
  }

  // 契约 §8.1：创建请求键白名单 recommendationId（必填）/ intent（可选）/ note（条件必填）。
  // intent 取 executed/reviewed/archived/proposed 是**状态问题**（proposed 出发的非法跳转）→
  // illegal_transition（HTTP 409）；其余形状问题 → invalid_decision_payload（400）。
  function validateDecisionRequest(payload) {
    if (!hasExactRiskKeys(payload, DECISION_REQUEST_KEYS, ['recommendationId'])) {
      return decisionFail('invalid_decision_payload', '决策请求键白名单：recommendationId（必填）、intent（可选）、note（条件必填）');
    }
    var recommendationId = typeof payload.recommendationId === 'string' ? payload.recommendationId.trim() : '';
    if (!recommendationId || recommendationId.length > 64) {
      return decisionFail('invalid_decision_payload', 'recommendationId 必须是非空字符串');
    }
    var note = normalizeDecisionNote(payload.note);
    if (!note.ok) return decisionFail('invalid_decision_payload', 'note 必须是不超过 ' + DECISION_NOTE_MAX_CHARS + ' 字符的字符串');
    var intent = null;
    if (payload.intent != null) {
      if (typeof payload.intent !== 'string') {
        return decisionFail('invalid_decision_payload', 'intent 必须是字符串');
      }
      if (DECISION_INTENTS.indexOf(payload.intent) !== -1) {
        intent = payload.intent;
      } else if (DECISION_STATES.indexOf(payload.intent) !== -1) {
        return decisionFail('illegal_transition', 'intent 只允许 accepted/deferred/dismissed；' + payload.intent + ' 等价于 proposed 出发的非法跳转');
      } else {
        return decisionFail('invalid_decision_payload', 'intent 取值不合法');
      }
    }
    return { ok: true, value: { recommendationId: recommendationId, intent: intent, note: note.note } };
  }

  // 契约 §8.2：事件请求键白名单 toState（必填）/ note（条件必填）。toState 只做词表形状校验；
  // 具体方向是否合法由当前状态决定（服务端据当前状态执行命令）。
  function validateDecisionEventRequest(payload) {
    if (!hasExactRiskKeys(payload, DECISION_EVENT_REQUEST_KEYS, ['toState'])) {
      return decisionFail('invalid_decision_payload', '决策事件请求键白名单：toState（必填）、note（条件必填）');
    }
    if (typeof payload.toState !== 'string' || DECISION_STATES.indexOf(payload.toState) === -1) {
      return decisionFail('invalid_decision_payload', 'toState 必须是状态词表内的字符串');
    }
    var note = normalizeDecisionNote(payload.note);
    if (!note.ok) return decisionFail('invalid_decision_payload', 'note 必须是不超过 ' + DECISION_NOTE_MAX_CHARS + ' 字符的字符串');
    return { ok: true, value: { toState: payload.toState, note: note.note } };
  }

  function validateDecisionRecord(decision) {
    if (!hasExactRiskKeys(decision, DECISION_RECORD_KEYS, DECISION_RECORD_KEYS)) {
      return decisionFail('invalid_decision_record', '决策记录键集必须恰好为 ' + DECISION_RECORD_KEYS.join('/'));
    }
    if (typeof decision.id !== 'string' || !DECISION_ID_RE.test(decision.id)) {
      return decisionFail('invalid_decision_record', '决策 id 形状不合法');
    }
    if (typeof decision.recommendationId !== 'string' || !decision.recommendationId) {
      return decisionFail('invalid_decision_record', '决策必须绑定一条建议');
    }
    if (DECISION_STATES.indexOf(decision.state) === -1) {
      return decisionFail('invalid_decision_record', '决策状态不在词表内');
    }
    if (!Number.isSafeInteger(decision.lastSeq) || decision.lastSeq < 0) {
      return decisionFail('invalid_decision_record', 'lastSeq 必须是非负安全整数');
    }
    if (!isDecisionIsoTimestamp(decision.createdAt) || !isDecisionIsoTimestamp(decision.updatedAt)) {
      return decisionFail('invalid_decision_record', 'createdAt/updatedAt 必须是带时区的 ISO 时间戳');
    }
    return { ok: true, record: decision };
  }

  function validateDecisionSnapshotShape(snapshot) {
    if (!hasExactRiskKeys(snapshot, DECISION_SNAPSHOT_KEYS, DECISION_SNAPSHOT_KEYS)) {
      return decisionFail('invalid_decision_record', '快照键集必须恰好为 ' + DECISION_SNAPSHOT_KEYS.join('/'));
    }
    if (snapshot.schemaVersion !== DECISION_SNAPSHOT_SCHEMA_VERSION) {
      return decisionFail('invalid_decision_record', '快照 schemaVersion 必须是 ' + DECISION_SNAPSHOT_SCHEMA_VERSION);
    }
    if (!isCalendarDate(snapshot.asOf) || !isDecisionIsoTimestamp(snapshot.capturedAt)) {
      return decisionFail('invalid_decision_record', '快照 asOf/capturedAt 形状不合法');
    }
    if (typeof snapshot.available !== 'boolean' || typeof snapshot.cashReconciled !== 'boolean') {
      return decisionFail('invalid_decision_record', '快照 available/cashReconciled 必须是布尔值');
    }
    if (snapshot.available) {
      if (snapshot.reason !== null) return decisionFail('invalid_decision_record', '可比快照的 reason 必须为 null');
    } else if (DECISION_SNAPSHOT_REASON_CODES.indexOf(snapshot.reason) === -1) {
      return decisionFail('invalid_decision_record', '不可比快照的 reason 必须在冻结词表内');
    }
    if (!copyRiskDenseDataArray(snapshot.blockers)) {
      return decisionFail('invalid_decision_record', '快照 blockers 必须是数组');
    }
    for (var bi = 0; bi < snapshot.blockers.length; bi++) {
      var bRow = snapshot.blockers[bi];
      if (!hasExactRiskKeys(bRow, DECISION_SNAPSHOT_BLOCKER_KEYS, DECISION_SNAPSHOT_BLOCKER_KEYS)) {
        return decisionFail('invalid_decision_record', '快照 blocker 行键集必须为 code/detail');
      }
    }
    if (snapshot.valuationStatus !== null && typeof snapshot.valuationStatus !== 'string') {
      return decisionFail('invalid_decision_record', 'valuationStatus 必须是字符串或 null');
    }
    var numericOk = function (v) { return v === null || Number.isSafeInteger(v); };
    if (!numericOk(snapshot.netWorthMinor) || !numericOk(snapshot.investableTotalMinor)) {
      return decisionFail('invalid_decision_record', '快照金额字段必须是安全整数或 null');
    }
    if (!snapshot.available && (snapshot.netWorthMinor !== null || snapshot.investableTotalMinor !== null || snapshot.classes !== null)) {
      return decisionFail('invalid_decision_record', '不可比快照不得携带任何数字（不出伪 0）');
    }
    if (!hasExactRiskKeys(snapshot.targetRef, DECISION_SNAPSHOT_TARGETREF_KEYS, DECISION_SNAPSHOT_TARGETREF_KEYS)) {
      return decisionFail('invalid_decision_record', '快照 targetRef 键集不合法');
    }
    if (!Number.isSafeInteger(snapshot.targetRef.level) || snapshot.targetRef.level < 1 || snapshot.targetRef.level > 5) {
      return decisionFail('invalid_decision_record', '快照 targetRef.level 必须是 1～5 的整数');
    }
    if (typeof snapshot.targetRef.targetId !== 'string' || !snapshot.targetRef.targetId ||
        typeof snapshot.targetRef.templateVersion !== 'string' || !snapshot.targetRef.templateVersion ||
        typeof snapshot.targetRef.ruleVersion !== 'string' || !snapshot.targetRef.ruleVersion) {
      return decisionFail('invalid_decision_record', '快照 targetRef 引用字段不合法');
    }
    if (!hasExactRiskKeys(snapshot.recommendationRef, DECISION_SNAPSHOT_RECREF_KEYS, DECISION_SNAPSHOT_RECREF_KEYS)) {
      return decisionFail('invalid_decision_record', '快照 recommendationRef 键集不合法');
    }
    if (typeof snapshot.recommendationRef.recommendationId !== 'string' || !snapshot.recommendationRef.recommendationId ||
        typeof snapshot.recommendationRef.inputHash !== 'string' || !DECISION_HASH_RE.test(snapshot.recommendationRef.inputHash) ||
        !isCalendarDate(snapshot.recommendationRef.asOf) ||
        (snapshot.recommendationRef.status !== 'formal' && snapshot.recommendationRef.status !== 'estimate') ||
        !Number.isSafeInteger(snapshot.recommendationRef.allocatedTotalMinor) || snapshot.recommendationRef.allocatedTotalMinor < 0) {
      return decisionFail('invalid_decision_record', '快照 recommendationRef 字段不合法');
    }
    if (snapshot.classes !== null) {
      var classRows = copyRiskDenseDataArray(snapshot.classes);
      if (!classRows || classRows.length !== RISK_CLASSES.length) {
        return decisionFail('invalid_decision_record', '可比快照的 classes 必须恰好覆盖六个资产类别');
      }
      for (var ci = 0; ci < classRows.length; ci++) {
        var row = classRows[ci];
        if (!hasExactRiskKeys(row, DECISION_SNAPSHOT_CLASS_KEYS, DECISION_SNAPSHOT_CLASS_KEYS) ||
            row.assetClass !== RISK_CLASSES[ci]) {
          return decisionFail('invalid_decision_record', '快照 classes 行键集或类别序不合法');
        }
        if (!Number.isSafeInteger(row.valueMinor) || row.valueMinor < 0) {
          return decisionFail('invalid_decision_record', '快照 classes 行金额必须是非负安全整数');
        }
        var ratioOk = function (v) { return v === null || Number.isSafeInteger(v); };
        if (!ratioOk(row.pctBps) || !ratioOk(row.minBps) || !ratioOk(row.targetBps) || !ratioOk(row.maxBps) || !ratioOk(row.deviationBps)) {
          return decisionFail('invalid_decision_record', '快照 classes 行比例字段必须是安全整数或 null');
        }
        if (row.band !== null && DECISION_SNAPSHOT_BANDS.indexOf(row.band) === -1) {
          return decisionFail('invalid_decision_record', '快照 classes 行 band 不在词表内');
        }
      }
    }
    if (!hasExactRiskKeys(snapshot.execution, DECISION_EXECUTION_KEYS, DECISION_EXECUTION_KEYS)) {
      return decisionFail('invalid_decision_record', '快照 execution 键集不合法');
    }
    var ex = snapshot.execution;
    if (!Number.isSafeInteger(ex.linkedCount) || ex.linkedCount < 0) {
      return decisionFail('invalid_decision_record', '快照 execution 数字字段不合法');
    }
    // 缺汇率（fxUnavailable 非空）时三个 CNY 汇总必须全为 null（绝不部分小计或伪 0）；
    // 无缺汇率时三个汇总必须是安全整数（无活动关联 → 0 / 0 / 建议金额）。
    var moneyOk = function (v) { return v === null || Number.isSafeInteger(v); };
    if (!moneyOk(ex.linkedPrincipalCnyMinor) || !moneyOk(ex.linkedFeeCnyMinor) || !moneyOk(ex.remainingMinor)) {
      return decisionFail('invalid_decision_record', '快照 execution 汇总字段必须是安全整数或 null');
    }
    if (!copyRiskDenseDataArray(ex.fxUnavailable) || ex.fxUnavailable.some(function (id) { return typeof id !== 'string' || !id; })) {
      return decisionFail('invalid_decision_record', '快照 execution.fxUnavailable 必须是事件 id 数组');
    }
    var missing = ex.fxUnavailable.length > 0;
    if (missing !== (ex.linkedPrincipalCnyMinor === null || ex.linkedFeeCnyMinor === null || ex.remainingMinor === null)) {
      return decisionFail('invalid_decision_record', 'execution 汇总为 null 必须且只能因缺汇率（fxUnavailable 非空）');
    }
    return { ok: true, record: snapshot };
  }

  function validateDecisionEventRecord(event) {
    if (!hasExactRiskKeys(event, DECISION_EVENT_RECORD_KEYS, DECISION_EVENT_RECORD_KEYS)) {
      return decisionFail('invalid_decision_record', '决策事件键集必须恰好为 ' + DECISION_EVENT_RECORD_KEYS.join('/'));
    }
    if (typeof event.id !== 'string' || !DECISION_EVENT_ID_RE.test(event.id)) {
      return decisionFail('invalid_decision_record', '决策事件 id 形状不合法');
    }
    if (typeof event.decisionId !== 'string' || !DECISION_ID_RE.test(event.decisionId)) {
      return decisionFail('invalid_decision_record', '决策事件 decisionId 形状不合法');
    }
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) {
      return decisionFail('invalid_decision_record', '决策事件 seq 必须是正整数');
    }
    if (DECISION_EVENT_FROM_STATES.indexOf(event.fromState) === -1 || DECISION_EVENT_TO_STATES.indexOf(event.toState) === -1) {
      return decisionFail('invalid_decision_record', '决策事件 from/to 状态不在词表内');
    }
    if (DECISION_REASON_CODES.indexOf(event.reasonCode) === -1) {
      return decisionFail('invalid_decision_record', '决策事件 reasonCode 不在冻结词表内');
    }
    if (event.note !== null && typeof event.note !== 'string') {
      return decisionFail('invalid_decision_record', '决策事件 note 必须是字符串或 null');
    }
    if (!isCalendarDate(event.occurredAt) || !isDecisionIsoTimestamp(event.recordedAt)) {
      return decisionFail('invalid_decision_record', '决策事件 occurredAt/recordedAt 形状不合法');
    }
    if (event.actor !== DECISION_ACTOR) {
      return decisionFail('invalid_decision_record', '决策事件 actor 必须是 ' + DECISION_ACTOR);
    }
    if (!validateDecisionSnapshotShape(event.snapshot).ok) {
      return decisionFail('invalid_decision_record', '决策事件必须携带一张形状合法的快照');
    }
    if (typeof event.snapshotHash !== 'string' || !DECISION_HASH_RE.test(event.snapshotHash) ||
        typeof event.payloadHash !== 'string' || !DECISION_HASH_RE.test(event.payloadHash)) {
      return decisionFail('invalid_decision_record', '决策事件哈希形状不合法');
    }
    return { ok: true, record: event };
  }

  function validateDecisionLinkRecord(link) {
    if (!hasExactRiskKeys(link, DECISION_LINK_RECORD_KEYS, DECISION_LINK_RECORD_KEYS)) {
      return decisionFail('invalid_decision_record', '关联行键集必须恰好为 ' + DECISION_LINK_RECORD_KEYS.join('/'));
    }
    if (typeof link.id !== 'string' || !DECISION_LINK_ID_RE.test(link.id) ||
        typeof link.decisionId !== 'string' || !DECISION_ID_RE.test(link.decisionId) ||
        typeof link.securityEventId !== 'string' || !link.securityEventId || link.securityEventId.length > 64) {
      return decisionFail('invalid_decision_record', '关联行 id/引用字段不合法');
    }
    if (!isCalendarDate(link.linkedOn) || !isDecisionIsoTimestamp(link.linkedAt)) {
      return decisionFail('invalid_decision_record', '关联行 linkedOn/linkedAt 形状不合法');
    }
    if (link.note !== null && typeof link.note !== 'string') {
      return decisionFail('invalid_decision_record', '关联行 note 必须是字符串或 null');
    }
    // 软删除一致性：解绑必须同时带 unlinkedOn / unlinkedAt / unlinkNote（unlink_note 必填），
    // 未解绑行三者必须全空。
    if (link.unlinkedOn == null) {
      if (link.unlinkedAt !== null || link.unlinkNote !== null) {
        return decisionFail('invalid_decision_record', '活动关联不得携带解绑字段');
      }
    } else {
      if (!isCalendarDate(link.unlinkedOn) || !isDecisionIsoTimestamp(link.unlinkedAt) ||
          typeof link.unlinkNote !== 'string' || !link.unlinkNote.trim()) {
        return decisionFail('invalid_decision_record', '解绑行必须带真实解绑日期与 unlinkNote');
      }
    }
    return { ok: true, record: link };
  }

  // 契约 §4.5 第 2 条：事件序列完整性的唯一校验实现。零事件 proposed（lastSeq = 0，
  // 两步式创建）是合法空序列；其余状态必须有事件且满足链式一致。
  function validateDecisionEventChain(decision, events) {
    var d = validateDecisionRecord(decision);
    if (!d.ok) return d;
    var list = copyRiskDenseDataArray(events);
    if (!list) return decisionFail('invalid_decision_record', '决策事件集合必须是数组');
    for (var i = 0; i < list.length; i++) {
      var checked = validateDecisionEventRecord(list[i]);
      if (!checked.ok) return checked;
      if (list[i].decisionId !== decision.id) {
        return decisionFail('invalid_decision_record', '事件属于另一条决策');
      }
    }
    list.sort(function (a, b) { return a.seq - b.seq; });
    if (decision.state === 'proposed' && decision.lastSeq === 0) {
      if (list.length !== 0) {
        return decisionFail('invalid_decision_record', '零事件 proposed 决策不得携带事件');
      }
      return { ok: true, events: list };
    }
    if (!list.length) {
      return decisionFail('invalid_decision_record', '状态 ' + decision.state + ' 必须有事件序列');
    }
    for (var j = 0; j < list.length; j++) {
      if (list[j].seq !== j + 1) {
        return decisionFail('invalid_decision_record', '决策事件 seq 必须从 1 连续递增');
      }
      if (j === 0 && list[j].fromState !== 'proposed') {
        return decisionFail('invalid_decision_record', '首条事件的 fromState 必须是 proposed');
      }
      if (j > 0 && list[j].fromState !== list[j - 1].toState) {
        return decisionFail('invalid_decision_record', '事件链断裂：fromState 必须等于上一条 toState');
      }
      if (!isLegalDecisionTransition(list[j].fromState, list[j].toState)) {
        return decisionFail('invalid_decision_record', '事件 ' + list[j].fromState + ' → ' + list[j].toState + ' 不在合法转移表内');
      }
    }
    var last = list[list.length - 1];
    if (last.toState !== decision.state || decision.lastSeq !== last.seq) {
      return decisionFail('invalid_decision_record', '末条事件必须与决策当前状态和 lastSeq 一致');
    }
    return { ok: true, events: list };
  }

  // 契约 §4.3：复盘漂移 = 六类金额或比例与执行时点不同（只比 classes；目标参照固定为
  // decision 引用的历史版本，同一决策内不变，band/deviation 由金额与比例派生）。
  function decisionReviewDrift(executedSnapshot, reviewedSnapshot) {
    var a = validateDecisionSnapshotShape(executedSnapshot);
    var b = validateDecisionSnapshotShape(reviewedSnapshot);
    if (!a.ok) return a;
    if (!b.ok) return b;
    return { ok: true, drift: canonicalJson(a.record.classes) !== canonicalJson(b.record.classes) };
  }

  // 只读契约快照：词表与白名单的可写深拷贝 + 有序对计数（7×7 = 49，合法 6 / 非法 43）。
  function decisionPhase6Contract() {
    return {
      states: DECISION_STATES.slice(),
      legalTransitions: JSON.parse(JSON.stringify(DECISION_LEGAL_TRANSITIONS)),
      intents: DECISION_INTENTS.slice(),
      reasonCodes: DECISION_REASON_CODES.slice(),
      archiveReasonCodes: DECISION_ARCHIVE_REASON_CODES.slice(),
      snapshotReasonCodes: DECISION_SNAPSHOT_REASON_CODES.slice(),
      requestKeys: DECISION_REQUEST_KEYS.slice(),
      eventRequestKeys: DECISION_EVENT_REQUEST_KEYS.slice(),
      serverGeneratedKeys: DECISION_SERVER_GENERATED_KEYS.slice(),
      recordKeys: DECISION_RECORD_KEYS.slice(),
      eventRecordKeys: DECISION_EVENT_RECORD_KEYS.slice(),
      linkRecordKeys: DECISION_LINK_RECORD_KEYS.slice(),
      snapshotKeys: DECISION_SNAPSHOT_KEYS.slice(),
      executionKeys: DECISION_EXECUTION_KEYS.slice(),
      actor: DECISION_ACTOR,
      snapshotSchemaVersion: DECISION_SNAPSHOT_SCHEMA_VERSION,
      noteMaxChars: DECISION_NOTE_MAX_CHARS,
      orderedPairs: { total: 49, legal: 6, illegal: 43, selfTransitions: 7 }
    };
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
    recommendationContract: recommendationContract,
    /* Phase 5B：风险评估记录与复评机制（D-047）—— 纯函数；派生值一律由 5A 规则重算 */
    RISK_ASSESSMENT_REQUEST_KEYS: RISK_ASSESSMENT_REQUEST_KEYS,
    RISK_ASSESSMENT_RECORD_KEYS: RISK_ASSESSMENT_RECORD_KEYS,
    RISKASSESS_SELECT_NONE_STATES: RISKASSESS_SELECT_NONE_STATES,
    validateRiskAssessmentRequest: validateRiskAssessmentRequest,
    computeRiskAssessment: computeRiskAssessment,
    validateRiskAssessmentRecord: validateRiskAssessmentRecord,
    compareRiskAssessments: compareRiskAssessments,
    sortRiskAssessments: sortRiskAssessments,
    selectCurrentAssessment: selectCurrentAssessment,
    riskAssessmentContract: riskAssessmentContract,
    /* Phase 5C：目标配置与认可标的映射（D-048）—— 纯函数；比例只复用 computeOverview 的同一遍估值 */
    ALLOCATION_TARGET_RECORD_KEYS: ALLOCATION_TARGET_RECORD_KEYS,
    ALLOCATION_TARGET_CONTENT_KEYS: ALLOCATION_TARGET_CONTENT_KEYS,
    ALLOCATION_TARGET_STATUSES: ALLOCATION_TARGET_STATUSES,
    ALLOCATION_DEVIATION_STATUSES: ALLOCATION_DEVIATION_STATUSES,
    ALLOCATION_MAPPING_ISSUE_CODES: ALLOCATION_MAPPING_ISSUE_CODES,
    ALLOCATION_ERROR_CODES: ALLOCATION_ERROR_CODES,
    allocationTargetNaturalKey: allocationTargetNaturalKey,
    computeAllocationTarget: computeAllocationTarget,
    validateAllocationTargetRecord: validateAllocationTargetRecord,
    compareAllocationTargets: compareAllocationTargets,
    sortAllocationTargets: sortAllocationTargets,
    selectCurrentTarget: selectCurrentTarget,
    computeAllocationDeviation: computeAllocationDeviation,
    validateApprovedMappingRequest: validateApprovedMappingRequest,
    validateApprovedInstrumentRecord: validateApprovedInstrumentRecord,
    sortApprovedInstruments: sortApprovedInstruments,
    checkApprovedMapping: checkApprovedMapping,
    classesMissingMapping: classesMissingMapping,
    allocationContract: allocationContract,
    /* Phase 5D：新增资金优先再平衡与正式建议门禁（D-049）—— 纯函数；估值与偏离只消费 5C 的同一遍结果 */
    NEW_FUND_ADJUSTMENTS: NEW_FUND_ADJUSTMENTS,
    NEW_FUND_CLASS_BASES: NEW_FUND_CLASS_BASES,
    NEW_FUND_ALLOCATION_KEYS: NEW_FUND_ALLOCATION_KEYS,
    NEW_FUND_CLASS_ROW_KEYS: NEW_FUND_CLASS_ROW_KEYS,
    NEW_FUND_MONEY_ROUNDING_RULE: NEW_FUND_MONEY_ROUNDING_RULE,
    RECOMMENDATION_EXPLAIN_CODES: RECOMMENDATION_EXPLAIN_CODES,
    RECOMMENDATION_GATE_CHECKS: RECOMMENDATION_GATE_CHECKS,
    RECOMMENDATION_INSTRUMENT_STATUSES: RECOMMENDATION_INSTRUMENT_STATUSES,
    RECOMMENDATION_TODO_CODES: RECOMMENDATION_TODO_CODES,
    RECOMMENDATION_ERROR_CODES: RECOMMENDATION_ERROR_CODES,
    RECOMMENDATION_RECORD_KEYS: RECOMMENDATION_RECORD_KEYS,
    RECOMMENDATION_GATE_KEYS: RECOMMENDATION_GATE_KEYS,
    RECOMMENDATION_GATE_REQUIRED_KEYS: RECOMMENDATION_GATE_REQUIRED_KEYS,
    RECOMMENDATION_VERSION_KEYS: RECOMMENDATION_VERSION_KEYS,
    computeNewFundsAllocation: computeNewFundsAllocation,
    mapAllocationToApprovedInstruments: mapAllocationToApprovedInstruments,
    recommendationStatusFromGate: recommendationStatusFromGate,
    buildRecommendationResult: buildRecommendationResult,
    validateRecommendationOutput: validateRecommendationOutput,
    validateRecommendationRecord: validateRecommendationRecord,
    compareRecommendations: compareRecommendations,
    sortRecommendations: sortRecommendations,
    recommendation5DContract: recommendation5DContract,
    /* Phase 5 验收补口 G5-R2：建议封存输入与当前事实的身份比对（纯函数，页面只翻译文案） */
    canonicalJson: canonicalJson,
    factSignature: factSignature,
    mappingSignature: mappingSignature,
    ADVICE_STALE_REASON_CODES: ADVICE_STALE_REASON_CODES,
    adviceStaleness: adviceStaleness,
    /* Phase 6（6B，D-057）：决策状态机与执行关联——纯函数；时间 / actor / 理由码由服务端生成 */
    DECISION_STATES: DECISION_STATES,
    DECISION_LEGAL_TRANSITIONS: DECISION_LEGAL_TRANSITIONS,
    DECISION_INTENTS: DECISION_INTENTS,
    DECISION_EVENT_FROM_STATES: DECISION_EVENT_FROM_STATES,
    DECISION_EVENT_TO_STATES: DECISION_EVENT_TO_STATES,
    DECISION_REASON_CODES: DECISION_REASON_CODES,
    DECISION_ARCHIVE_REASON_CODES: DECISION_ARCHIVE_REASON_CODES,
    DECISION_SNAPSHOT_REASON_CODES: DECISION_SNAPSHOT_REASON_CODES,
    DECISION_ACTOR: DECISION_ACTOR,
    DECISION_SNAPSHOT_SCHEMA_VERSION: DECISION_SNAPSHOT_SCHEMA_VERSION,
    DECISION_HASH_RE: DECISION_HASH_RE,
    DECISION_REQUEST_KEYS: DECISION_REQUEST_KEYS,
    DECISION_EVENT_REQUEST_KEYS: DECISION_EVENT_REQUEST_KEYS,
    DECISION_SERVER_GENERATED_KEYS: DECISION_SERVER_GENERATED_KEYS,
    DECISION_RECORD_KEYS: DECISION_RECORD_KEYS,
    DECISION_EVENT_RECORD_KEYS: DECISION_EVENT_RECORD_KEYS,
    DECISION_LINK_RECORD_KEYS: DECISION_LINK_RECORD_KEYS,
    DECISION_SNAPSHOT_KEYS: DECISION_SNAPSHOT_KEYS,
    DECISION_EXECUTION_KEYS: DECISION_EXECUTION_KEYS,
    isLegalDecisionTransition: isLegalDecisionTransition,
    validateDecisionRequest: validateDecisionRequest,
    validateDecisionEventRequest: validateDecisionEventRequest,
    validateDecisionRecord: validateDecisionRecord,
    validateDecisionEventRecord: validateDecisionEventRecord,
    validateDecisionLinkRecord: validateDecisionLinkRecord,
    validateDecisionEventChain: validateDecisionEventChain,
    validateDecisionSnapshotShape: validateDecisionSnapshotShape,
    deriveArchiveReason: deriveArchiveReason,
    decisionSnapshotGate: decisionSnapshotGate,
    decisionReviewDrift: decisionReviewDrift,
    decisionPhase6Contract: decisionPhase6Contract,
    localTodayISO: localTodayISO
  };
});
