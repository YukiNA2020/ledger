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
    function keyOf(accountId, instrumentId) {
      return String(accountId) + '|' + String(instrumentId);
    }
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
        priceStatus: q ? q.status : 'missing_quote',
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
