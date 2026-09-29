/* 小账本 core.js — 纯逻辑层（无 DOM / 无存储依赖，node 可单测）
 * 模块职责：金额转换、CSV 解析（微信/支付宝/银行）、自动分类、
 *           账户名匹配、跨源去重匹配、聚合统计、备份 Schema v2（v1/v2 均可恢复）。
 * 约定：所有金额一律以「分」为整数存储，避免浮点误差。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------ 金额 ------------------------------ */

  // 金额字符串 → 分（整数）。兼容 "¥1,234.56"、"-45.00"、"＋8元"、空格。
  // 解析失败返回 null。
  function yuanToCents(s) {
    if (s == null) return null;
    var str = String(s).trim();
    if (!str) return null;
    var neg = false;
    str = str.replace(/[¥￥$,\s]/g, '');
    if (/^[(-]/.test(str)) { neg = true; str = str.slice(1); }
    else if (/^[+]/.test(str)) { str = str.slice(1); }
    str = str.replace(/元$/, '');
    if (/^-/.test(str)) { neg = true; str = str.slice(1); }
    if (!/^\d+(\.\d+)?$/.test(str)) return null;
    var n = Number(str);
    if (!isFinite(n)) return null;
    var cents = Math.round(n * 100);
    return neg ? -cents : cents;
  }

  // 分 → 元字符串 "45.00"（两位小数，不带千分位）
  function centsToYuan(cents) {
    var n = Math.round(Number(cents) || 0);
    var neg = n < 0; n = Math.abs(n);
    var s = (Math.floor(n / 100)) + '.' + String(n % 100).padStart(2, '0');
    return (neg ? '-' : '') + s;
  }

  // 分 → 展示字符串 "1,234.56"
  function fmtMoney(cents) {
    var n = Math.round(Number(cents) || 0);
    var neg = n < 0; n = Math.abs(n);
    var intPart = String(Math.floor(n / 100));
    var dec = String(n % 100).padStart(2, '0');
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + intPart + '.' + dec;
  }

  /* ------------------------------ 通用 CSV ------------------------------ */

  // 通用 CSV 解析：支持引号包裹、引号内逗号/换行、"" 转义、\r\n。
  function parseCSV(text) {
    var rows = [], row = [], field = '', inQ = false;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 UTF-8 BOM
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else {
        if (c === '"' && field === '') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* 等待 \n */ }
        else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /* ------------------------------ 编码检测 ------------------------------ */

  // Uint8Array → 文本。BOM 优先；UTF-8 严格失败则尝试 GBK；再失败退化有损 UTF-8。
  function decodeBytes(bytes) {
    if (bytes == null) return { text: '', encoding: 'utf-8' };
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
    }
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
    catch (e) { /* 继续 */ }
    try { return { text: new TextDecoder('gbk').decode(bytes), encoding: 'gbk' }; }
    catch (e) { /* 继续 */ }
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8(lossy)' };
  }

  /* ------------------------------ 日期工具 ------------------------------ */

  var WD = ['日', '一', '二', '三', '四', '五', '六'];

  // 多种日期格式 → 'YYYY-MM-DD'；无法解析返回 null。
  function normalizeDate(s) {
    if (s == null) return null;
    var str = String(s).trim();
    var m;
    if ((m = str.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/))) {
      return pad(m[1]) + '-' + pad(m[2]) + '-' + pad(m[3]);
    }
    if ((m = str.match(/^(\d{4})(\d{2})(\d{2})$/))) {
      return m[1] + '-' + m[2] + '-' + m[3];
    }
    return null;
  }
  function pad(n) { return String(Number(n)).padStart(2, '0'); }

  function splitDateTime(s, fallbackTime) {
    var str = (s || '').trim();
    var m = str.match(/^(\S+?)[ T]+(\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (m) return { date: normalizeDate(m[1]), time: m[2] };
    return { date: normalizeDate(str), time: fallbackTime || '' };
  }

  function daysBetween(d1, d2) {
    var a = new Date(d1 + 'T00:00:00'), b = new Date(d2 + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }
  function ymOf(date) { return date.slice(0, 7); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function weekdayCN(date) { return '周' + WD[new Date(date + 'T00:00:00').getDay()]; }
  function fmtDateCN(date) {
    var now = todayStr();
    if (date === now) return '今天';
    var y = now.slice(0, 4), d = now.slice(0, 10);
    var yest = new Date(new Date(now + 'T00:00:00').getTime() - 86400000);
    var ys = yest.getFullYear() + '-' + pad(yest.getMonth() + 1) + '-' + pad(yest.getDate());
    if (date === ys) return '昨天';
    if (date.slice(0, 4) === y) return Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日 ' + weekdayCN(date);
    return date.slice(2) + ' ' + weekdayCN(date);
  }

  /* ------------------------------ ID ------------------------------ */

  var idSeq = 0;
  function newId(prefix) {
    idSeq = (idSeq + 1) % 1296;
    return (prefix || 'x') + '-' + Date.now().toString(36) + +new Date().getSeconds().toString(36) + Math.random().toString(36).slice(2, 6) + idSeq.toString(36);
  }

  /* ------------------------------ 自动分类 / 账户匹配 ------------------------------ */

  // 关键词最长匹配：返回命中的分类对象，否则 null。
  function guessCategory(text, categories) {
    if (!text) return null;
    var hay = String(text).toLowerCase();
    var best = null, bestLen = -1;
    (categories || []).forEach(function (c) {
      (c.keywords || []).forEach(function (kw) {
        kw = String(kw || '').trim().toLowerCase();
        if (kw && hay.indexOf(kw) >= 0 && kw.length > bestLen) { best = c; bestLen = kw.length; }
      });
    });
    return best;
  }

  function normName(s) { return String(s || '').replace(/[\s（）()]/g, ''); }

  // 支付方式文本（如 "招商银行(1234)"、"零钱"、"余额宝"）→ 账户。
  // 规则：去空白括号后双向包含，取名字最长的命中。
  function matchAccountByText(text, accounts) {
    if (!text) return null;
    var t = normName(text);
    if (!t) return null;
    var best = null, bestLen = -1;
    (accounts || []).forEach(function (a) {
      if (a.deleted) return;
      var n = normName(a.name);
      if (!n) return;
      var hit = t.indexOf(n) >= 0 || n.indexOf(t) >= 0;
      (a.aliases || []).forEach(function (al) {
        al = normName(al);
        if (al && (t.indexOf(al) >= 0 || al.indexOf(t) >= 0)) hit = true;
      });
      if (hit && n.length > bestLen) { best = a; bestLen = n.length; }
    });
    return best;
  }

  /* ------------------------------ 微信账单解析 ------------------------------ */

  var WECHAT_ALIASES = {
    time: ['交易时间'],
    type: ['交易类型', '交易分类'],
    payee: ['交易对方'],
    product: ['商品'],
    direction: ['收支', '收/支'],
    amount: ['金额(元)', '金额（元）', '金额'],
    method: ['支付方式', '付款方式'],
    status: ['当前状态', '交易状态'],
    rawId: ['交易单号'],
    note: ['备注']
  };

  function isWechatText(text) { return /微信支付账单|微信支付账单明细/.test(text.slice(0, 2000)); }
  function isAlipayText(text) {
    if (/支付宝/.test(text.slice(0, 1200))) return true;
    return /交易创建时间/.test(text.slice(0, 3000)) && !isWechatText(text);
  }

  // 按别名在表头行中定位列下标。
  function resolveCols(headerRow, aliases) {
    var cols = {};
    Object.keys(aliases).forEach(function (key) {
      for (var i = 0; i < headerRow.length; i++) {
        var name = String(headerRow[i] || '').trim();
        for (var j = 0; j < aliases[key].length; j++) {
          if (name === aliases[key][j] || name.replace(/\s/g, '') === aliases[key][j].replace(/\s/g, '')) {
            cols[key] = i; return;
          }
        }
      }
    });
    return cols;
  }

  function cell(row, idx) { return idx == null ? '' : String(row[idx] == null ? '' : row[idx]).trim(); }

  function findHeaderRow(rows, pred) {
    for (var i = 0; i < rows.length && i < 40; i++) if (pred(rows[i])) return i;
    return -1;
  }

  // 微信账单 CSV → { records, errors, meta }
  // record: { date, time, type, payee, product, amountCents, direction, method, status, rawId, note, transferLike }
  function parseWechatCSV(text) {
    var rows = parseCSV(text);
    var hi = findHeaderRow(rows, function (r) {
      return r.join(',').indexOf('交易时间') >= 0 && r.join(',').indexOf('交易单号') >= 0;
    });
    if (hi < 0) return { records: [], errors: [{ line: 0, message: '未找到微信账单表头（需含"交易时间/交易单号"）' }], meta: { source: 'wechat' } };
    var cols = resolveCols(rows[hi], WECHAT_ALIASES);
    if (cols.time == null || cols.amount == null) {
      return { records: [], errors: [{ line: hi + 1, message: '微信账单缺少关键列（交易时间/金额）' }], meta: { source: 'wechat' } };
    }
    var records = [], errors = [];
    for (var i = hi + 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.every(function (c) { return !String(c || '').trim(); })) continue;
      var lineNo = i + 1;
      var dt = splitDateTime(cell(row, cols.time));
      var amountRaw = cell(row, cols.amount);
      var cents = yuanToCents(amountRaw);
      var dirText = cell(row, cols.direction);
      if (!dt.date || cents == null || cents === 0) {
        errors.push({ line: lineNo, message: '日期或金额无法解析：' + amountRaw, raw: row.join(',').slice(0, 120) });
        continue;
      }
      var direction = dirText.indexOf('收入') >= 0 ? 'income' : dirText.indexOf('支出') >= 0 ? 'expense' : 'neutral';
      var typeText = cell(row, cols.type);
      records.push({
        date: dt.date, time: dt.time, type: typeText,
        payee: cell(row, cols.payee), product: cell(row, cols.product),
        amountCents: Math.abs(cents), direction: direction,
        method: cell(row, cols.method), status: cell(row, cols.status),
        rawId: cell(row, cols.rawId) || ('wx:' + dt.date + ':' + cents + ':' + normName(cell(row, cols.payee))),
        note: cell(row, cols.note), transferLike: TRANSFER_RE.test(typeText)
      });
    }
    return { records: records, errors: errors, meta: { source: 'wechat', headerLine: hi + 1 } };
  }

  /* ------------------------------ 支付宝账单解析 ------------------------------ */

  var ALIPAY_ALIASES = {
    rawId: ['交易号', '支付宝交易号'],
    time: ['交易创建时间', '付款时间', '交易时间'],
    type: ['类型', '交易类型', '交易分类'],
    payee: ['交易对方', '对方'],
    product: ['商品名称', '商品说明', '商品'],
    amount: ['金额（元）', '金额(元)', '金额'],
    direction: ['收/支', '收支'],
    status: ['交易状态'],
    method: ['资金状态', '支付方式', '付款方式'],
    note: ['备注']
  };

  function parseAlipayCSV(text) {
    var rows = parseCSV(text);
    var hi = findHeaderRow(rows, function (r) {
      var j = r.join(',');
      return j.indexOf('交易号') >= 0 && (j.indexOf('收/支') >= 0 || j.indexOf('交易创建时间') >= 0);
    });
    if (hi < 0) return { records: [], errors: [{ line: 0, message: '未找到支付宝账单表头（需含"交易号/收/支"）' }], meta: { source: 'alipay' } };
    var cols = resolveCols(rows[hi], ALIPAY_ALIASES);
    if (cols.time == null || cols.amount == null) {
      return { records: [], errors: [{ line: hi + 1, message: '支付宝账单缺少关键列（交易时间/金额）' }], meta: { source: 'alipay' } };
    }
    var records = [], errors = [];
    for (var i = hi + 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.every(function (c) { return !String(c || '').trim(); })) continue;
      var lineNo = i + 1;
      var dt = splitDateTime(cell(row, cols.time));
      var cents = yuanToCents(cell(row, cols.amount));
      if (!dt.date || cents == null || cents === 0) {
        errors.push({ line: lineNo, message: '日期或金额无法解析：' + cell(row, cols.amount), raw: row.join(',').slice(0, 120) });
        continue;
      }
      var dirText = cell(row, cols.direction);
      var status = cell(row, cols.status);
      var typeText = cell(row, cols.type);
      var refund = /退款/.test(status) || /退款/.test(typeText);
      var direction = refund ? 'income'
        : dirText.indexOf('收入') >= 0 ? 'income'
        : dirText.indexOf('支出') >= 0 ? 'expense' : 'neutral';
      records.push({
        date: dt.date, time: dt.time, type: typeText,
        payee: cell(row, cols.payee), product: cell(row, cols.product),
        amountCents: Math.abs(cents), direction: direction,
        method: cell(row, cols.method), status: status,
        rawId: cell(row, cols.rawId) || ('ali:' + dt.date + ':' + cents + ':' + normName(cell(row, cols.payee))),
        note: cell(row, cols.note),
        transferLike: TRANSFER_RE.test(typeText) || /转账/.test(typeText),
        refund: refund
      });
    }
    return { records: records, errors: errors, meta: { source: 'alipay', headerLine: hi + 1 } };
  }

  /* ------------------------------ 银行流水解析 ------------------------------ */

  // 预设模板：按表头别名定位列。unsigned 表示"无符号正金额"的默认方向（银行导出习惯：负号=支出）。
  var BANK_PRESETS = [
    {
      id: 'cmb', name: '招商银行', unsigned: 'income',
      aliases: {
        date: ['交易日期', '记账日期', '入账日期', '交易日'],
        time: ['交易时间'],
        amount: ['交易金额', '人民币金额', '交易金额(元)', '交易金额（元）', '金额'],
        direction: ['收支', '收/支', '借贷标志', '借贷'],
        debit: ['借方金额', '支出金额'],
        credit: ['贷方金额', '收入金额'],
        payee: ['对手信息', '对方户名', '交易对手', '对方名称', '对方账户'],
        note: ['交易摘要', '摘要', '附言'],
        id: ['流水号', '交易序号', '凭证号']
      }
    },
    {
      id: 'boc', name: '中国银行', unsigned: 'income',
      aliases: {
        date: ['记账日期', '交易日期', '入账日期', '交易日'],
        time: ['交易时间'],
        amount: ['交易金额', '人民币金额', '金额'],
        direction: ['收支', '收/支', '借贷标志', '借贷'],
        debit: ['借方金额', '支出金额', '借方发生额'],
        credit: ['贷方金额', '收入金额', '贷方发生额'],
        payee: ['交易对手', '对方户名', '对手信息', '对方名称'],
        note: ['摘要', '交易摘要', '业务类型'],
        id: ['流水号', '交易序号']
      }
    }
  ];

  // 表头是否匹配模板：日期列 + （金额列 或 借贷双列）+ 至少 2 个其他列。
  function scoreTemplate(headerRow, tpl) {
    var cols = resolveCols(headerRow, tpl.aliases);
    if (cols.date == null) return 0;
    if (cols.amount == null && !(cols.debit != null || cols.credit != null)) return 0;
    var n = 0; Object.keys(cols).forEach(function (k) { n++; });
    return n;
  }

  function matchBankTemplate(text) {
    var rows = parseCSV(text);
    var hi = findHeaderRow(rows, function (r) { return r.filter(function (c) { return String(c || '').trim(); }).length >= 3; });
    if (hi < 0) return null;
    var header = rows[hi];
    var best = null, bestScore = 0;
    BANK_PRESETS.forEach(function (tpl) {
      var s = scoreTemplate(header, tpl);
      if (s > bestScore) { best = tpl; bestScore = s; }
    });
    return bestScore >= 3 ? best : null;
  }

  // 自定义模板：cols 值为用户选择的精确表头名。
  // { name, cols: { date, amount?, debit?, credit?, direction?, payee?, note?, id? }, defaultDirection? }

  function dirTextToDirection(t) {
    if (!t) return null;
    if (/(收|贷|入|存)/.test(t)) return 'income';
    if (/(支|借|付|取)/.test(t)) return 'expense';
    return null;
  }

  // 银行流水 → { records, errors, meta }。template 为预设 id/名称或模板对象。
  function parseBankCSV(text, template) {
    var tpl = template;
    if (typeof tpl === 'string') {
      BANK_PRESETS.forEach(function (p) { if (p.id === tpl || p.name === tpl) tpl = p; });
      if (typeof tpl === 'string') tpl = null;
    }
    if (!tpl) {
      var auto = matchBankTemplate(text);
      if (!auto) return { records: [], errors: [{ line: 0, message: '无法识别银行模板，请在导入向导中手动映射列' }], meta: { source: 'bank' } };
      tpl = auto;
    }
    var rows = parseCSV(text);
    var hi;
    if (tpl._custom) {
      hi = findHeaderRow(rows, function (r) {
        var names = r.map(function (c) { return String(c || '').trim(); });
        return names.indexOf(tpl.cols.date) >= 0;
      });
    } else {
      hi = findHeaderRow(rows, function (r) { return scoreTemplate(r, tpl) >= 3; });
    }
    if (hi < 0) return { records: [], errors: [{ line: 0, message: '未找到流水表头行' }], meta: { source: 'bank', template: tpl.name } };
    var header = rows[hi];
    var cols;
    if (tpl._custom) {
      cols = {};
      Object.keys(tpl.cols).forEach(function (k) {
        var name = tpl.cols[k];
        if (name) { var idx = header.findIndex(function (c) { return String(c || '').trim() === name; }); if (idx >= 0) cols[k] = idx; }
      });
    } else {
      cols = resolveCols(header, tpl.aliases);
    }
    if (cols.date == null) return { records: [], errors: [{ line: 0, message: '缺少日期列' }], meta: { source: 'bank', template: tpl.name } };
    if (cols.amount == null && cols.debit == null && cols.credit == null) {
      return { records: [], errors: [{ line: 0, message: '缺少金额列（金额 或 借方/贷方双列）' }], meta: { source: 'bank', template: tpl.name } };
    }

    var records = [], errors = [];
    for (var i = hi + 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.every(function (c) { return !String(c || '').trim(); })) continue;
      var lineNo = i + 1;
      var dateStr = /:/.test(cell(row, cols.date))
        ? splitDateTime(cell(row, cols.date)).date
        : normalizeDate(cell(row, cols.date));
      if (!dateStr) { errors.push({ line: lineNo, message: '日期无法解析：' + cell(row, cols.date) }); continue; }
      var time = /:/.test(cell(row, cols.date)) ? splitDateTime(cell(row, cols.date)).time : cell(row, cols.time);

      var direction = null, cents = null;
      // ① 借贷双列
      if (cols.debit != null || cols.credit != null) {
        var dr = yuanToCents(cell(row, cols.debit)) || 0;
        var cr = yuanToCents(cell(row, cols.credit)) || 0;
        if (cr > 0) { direction = 'income'; cents = cr; }
        else if (dr > 0) { direction = 'expense'; cents = dr; }
      }
      // ② 方向文本列
      if (cents == null && cols.direction != null) {
        var d = dirTextToDirection(cell(row, cols.direction));
        if (d) {
          var amt = yuanToCents(cell(row, cols.amount));
          if (amt != null && amt !== 0) { direction = d; cents = Math.abs(amt); }
        }
      }
      // ③ 正负号金额：负号=支出、显式加号=收入；预设模板的无符号正金额按其银行习惯
      if (cents == null && cols.amount != null) {
        var rawAmt = cell(row, cols.amount);
        var a2 = yuanToCents(rawAmt);
        if (a2 != null && a2 !== 0) {
          cents = Math.abs(a2);
          if (a2 < 0) direction = 'expense';
          else if (/[+＋]/.test(String(rawAmt).trim()[0]) || tpl.unsigned) direction = tpl.unsigned || 'income';
        }
      }
      if (cents == null || !direction) {
        if (tpl.defaultDirection && cents != null) direction = tpl.defaultDirection;
        else { errors.push({ line: lineNo, message: '收支方向无法判断：' + row.join(',').slice(0, 100) }); continue; }
      }
      var payee = cell(row, cols.payee), note = cell(row, cols.note);
      var rawId = cell(row, cols.id) || ('bank:' + dateStr + ':' + cents + ':' + normName(note) + ':' + normName(payee));
      var summary = note || payee;
      records.push({
        date: dateStr, time: time, type: '银行-' + (tpl.name || '自定义'),
        payee: payee, product: '',
        amountCents: cents, direction: direction,
        method: tpl.name || '银行卡', status: '成功',
        rawId: rawId, note: note,
        transferLike: BANK_TRANSFER_RE.test(summary)
      });
    }
    return { records: records, errors: errors, meta: { source: 'bank', template: tpl.name || '自定义', headerLine: hi + 1 } };
  }

  var TRANSFER_RE = /(提现|充值|转出|转入|转账|还款|信用卡还款|零钱通|余额自动转入|自动转入)/;
  // 银行摘要中的真·转账关键词（快捷支付/代发工资等只是渠道痕迹，不算转账）
  var BANK_TRANSFER_RE = /(提现|充值|转出|转入|转账|还款)/;

  /* ------------------------------ 来源自动识别 ------------------------------ */

  // 传入文本，自动识别微信/支付宝；银行返回 bank 并附带识别出的预设模板。
  function parseFile(text) {
    if (isWechatText(text)) return parseWechatCSV(text);
    if (isAlipayText(text)) return parseAlipayCSV(text);
    var tpl = matchBankTemplate(text);
    if (tpl) return parseBankCSV(text, tpl);
    return { records: [], errors: [{ line: 0, message: '无法识别账单来源（微信/支付宝/银行）' }], meta: { source: 'unknown' } };
  }

  /* ------------------------------ 记录 → 交易 ------------------------------ */

  function defaultTypeOf(record) {
    if (record.refund) return 'refund';
    // 中性收支（微信"/"行）→ 转账候选；其余按方向。银行端提现入账等按方向记，由去重引擎与渠道转账配对。
    if (record.direction === 'neutral') return 'transfer';
    return record.direction === 'income' ? 'income' : 'expense';
  }

  // 智能推荐类型映射：交易类型文本 → expense/income/transfer/refund/ignore
  function suggestTypeMappings(records) {
    var seen = {}, mixed = {}, map = {};
    records.forEach(function (r) {
      var key = r.type || '(空)';
      var t = defaultTypeOf(r);
      if (t === 'transfer' && !r.transferLike && r.direction === 'neutral') t = 'ignore';
      if (!seen[key]) {
        seen[key] = 1;
        map[key] = t;
      } else if (map[key] !== t) {
        // 银行文件常用同一个类型名承载收入和支出；方向混合时不做整类覆盖，
        // buildTxns 会按每行原始 direction 决定收支。
        mixed[key] = 1;
        delete map[key];
      }
    });
    Object.keys(mixed).forEach(function (key) { delete map[key]; });
    return map;
  }

  // buildTxns：解析记录 → 账本交易（含同源单号幂等去重）。
  // ctx: { source, accounts, categories, typeMapping, accountMapping(methodText→accountId),
  //        transferTarget(转账默认对端账户id), existingTxns }
  // 返回 { txns, dups, ignored, warnings, missingAccounts }
  function buildTxns(records, ctx) {
    ctx = ctx || {};
    var source = ctx.source || 'import';
    var accounts = ctx.accounts || [], categories = ctx.categories || [];
    var typeMapping = ctx.typeMapping || {}, accountMapping = ctx.accountMapping || {};
    var existIds = {};
    (ctx.existingTxns || []).forEach(function (t) {
      if (t.source === source && t.rawId) existIds[t.rawId] = 1;
    });
    var txns = [], dups = [], ignored = [], warnings = [];
    var missingAccounts = {};
    var batchIds = {};

    records.forEach(function (r) {
      var t = typeMapping[r.type != null ? r.type : '(空)'];
      if (t == null) t = defaultTypeOf(r) === 'transfer' && !r.transferLike && r.direction === 'neutral' ? 'ignore' : defaultTypeOf(r);
      if (t === 'ignore') { ignored.push(r); return; }
      if (r.rawId && (existIds[r.rawId] || batchIds[r.rawId])) { dups.push(r); return; }
      if (r.rawId) batchIds[r.rawId] = 1;

      var acc = (accountMapping[r.method] && accounts.find(function (a) { return a.id === accountMapping[r.method]; }))
        || matchAccountByText(r.method, accounts);
      if (!acc) { missingAccounts[r.method || '(未知渠道)'] = (missingAccounts[r.method || '(未知渠道)'] || 0) + 1; }
      var accId = acc ? acc.id : null;

      var txn = {
        id: newId('t'), date: r.date, time: r.time || '',
        type: t === 'refund' ? 'income' : t,
        amount: r.amountCents,
        account: accId, accountTo: null,
        category: null, merchant: r.payee || r.product || '', note: r.note || '',
        source: source, rawId: r.rawId || '', status: r.status || ''
      };
      if (t === 'refund') { txn.refundFlag = true; }

      if (t === 'transfer') {
        // 渠道端提现/充值 → 账户间转账；对端未知时保留半端，由去重引擎与银行流水配对或用户补齐
        var targetId = ctx.transferTarget != null ? ctx.transferTarget : null;
        if (r.direction === 'income') { txn.account = targetId; txn.accountTo = accId; }
        else { txn.account = accId; txn.accountTo = targetId; }
        if (!txn.account || !txn.accountTo) {
          txn.transferHalf = true;
          warnings.push('转账「' + (r.payee || r.type) + '（' + centsToYuan(r.amountCents) + '元）」对端账户未知，将尝试与银行流水自动配对，也可稍后在明细中补齐');
        }
      } else {
        var cat = guessCategory([r.payee, r.product, r.note, r.type].filter(Boolean).join(' '), categories);
        if (!cat && txn.type === 'income' && r.refund) {
          cat = categories.find(function (c) { return c.type === 'income' && /退款/.test(c.name); });
        }
        txn.category = cat ? cat.id : null;
        if (r.refund) txn.refundFlag = true;
      }
      if (!accId && t !== 'transfer') {
        warnings.push('"' + (r.payee || r.type) + '（' + centsToYuan(r.amountCents) + '元）" 的支付方式 "' + (r.method || '未知') + '" 未映射账户，已归入未指定账户');
      }
      txns.push(txn);
    });
    return { txns: txns, dups: dups, ignored: ignored, warnings: warnings, missingAccounts: Object.keys(missingAccounts) };
  }

  /* ------------------------------ 跨源去重引擎 ------------------------------ */

  function isChannelSource(s) { return s === 'wechat' || s === 'alipay'; }
  function isBankSource(s) { return /^bank/.test(s); }

  // 银行摘要通常只保留支付渠道（微信/财付通、支付宝/蚂蚁），未必保留真实商户。
  // 只有渠道痕迹明确且近日期候选唯一时，才允许跨源自动合并。
  function bankChannelHint(t) {
    var text = [t && t.merchant, t && t.note].filter(Boolean).join(' ');
    var wechat = /(微信|财付通|wechat)/i.test(text);
    var alipay = /(支付宝|蚂蚁|alipay)/i.test(text);
    if (wechat && !alipay) return 'wechat';
    if (alipay && !wechat) return 'alipay';
    return null;
  }

  // matchDuplicates(incoming, existing) → 三层去重决策。
  // incoming: 待入库交易；existing: 已有交易（未被合并遮蔽的）。
  // 返回 { autoMerged: [{inc, kept, kind}], needConfirm: [{inc, cand, kind, reason}], transferPairs, unique }
  function matchDuplicates(incoming, existing) {
    var live = existing.filter(function (t) { return !t.mappedTo; });
    var claimed = {}; // existing.id -> true，防止一条银行记录被配两次
    var autoMerged = [], needConfirm = [], unique = [];
    var transferPairs = [];

    function dayDiff(a, b) { return Math.abs(daysBetween(a.date, b.date)); }

    incoming.forEach(function (inc) {
      // 转账候选单独处理：渠道端转账 + 已有银行端同额互补记录 → 自动配对为一笔转账
      if (inc.type === 'transfer') {
        var pair = null;
        if (!inc.accountTo || !inc.account) {
          // 单端已知：提现（缺转入端）配银行入账；充值（缺转出端）配银行出账
          var wantDir = !inc.accountTo ? 'income' : 'expense';
          for (var i = 0; i < live.length; i++) {
            var ex = live[i];
            if (claimed[ex.id]) continue;
            if (ex.type !== wantDir || !isBankSource(ex.source)) continue;
            if (ex.amount !== inc.amount) continue;
            if (dayDiff(inc, ex) > 2) continue;
            pair = ex; break;
          }
        } else {
          // 双端已知：银行流水中同一笔资金的另一端也应遮蔽（转入端入账/转出端出账）
          for (var j = 0; j < live.length; j++) {
            var ex2 = live[j];
            if (claimed[ex2.id]) continue;
            if (ex2.amount !== inc.amount || dayDiff(inc, ex2) > 2) continue;
            if (ex2.account === inc.accountTo && ex2.type === 'income') { pair = ex2; break; }
            if (ex2.account === inc.account && ex2.type === 'expense') { pair = ex2; break; }
          }
        }
        if (pair) {
          claimed[pair.id] = 1;
          transferPairs.push({ inc: inc, bankTxn: pair });
          return;
        }
        unique.push(inc); return;
      }

      if (inc.type !== 'expense' && inc.type !== 'income') { unique.push(inc); return; }

      // 反向转账配对：银行端入/出账 与已有渠道半端转账（提现/充值只导了渠道一端）补齐
      var half = null;
      for (var k = 0; k < live.length; k++) {
        var tf = live[k];
        if (claimed[tf.id] || tf.type !== 'transfer') continue;
        if (tf.amount !== inc.amount || dayDiff(inc, tf) > 2) continue;
        if (!tf.accountTo && inc.type === 'income') { half = tf; break; }
        if (!tf.account && inc.type === 'expense') { half = tf; break; }
      }
      if (half) {
        claimed[half.id] = 1;
        transferPairs.push({ transfer: half, bankRecord: inc });
        return;
      }

      var cands = [];
      live.forEach(function (ex) {
        if (claimed[ex.id]) return;
        if (ex.type !== inc.type) return;
        if (ex.amount !== inc.amount) return;
        if (ex.source === inc.source) {
          // 同源但单号不同（如手动来源）不算；同源导入已被 buildTxns 幂等处理
          if (ex.source !== 'manual') return;
        }
        // 银行摘要已明确渠道时，排除与之冲突的渠道账单。
        var bank = isBankSource(inc.source) ? inc : (isBankSource(ex.source) ? ex : null);
        var channel = isChannelSource(inc.source) ? inc : (isChannelSource(ex.source) ? ex : null);
        var hint = bank && channel ? bankChannelHint(bank) : null;
        if (hint && hint !== channel.source) return;
        cands.push(ex);
      });
      if (!cands.length) { unique.push(inc); return; }

      // 找日期最近的候选
      cands.sort(function (a, b) { return dayDiff(inc, a) - dayDiff(inc, b); });
      var best = cands[0], diff = dayDiff(inc, best);

      var incChannel = isChannelSource(inc.source), bestBank = isBankSource(best.source);
      var incBank = isBankSource(inc.source), bestChannel = isChannelSource(best.source);
      var manualInvolved = inc.source === 'manual' || best.source === 'manual';

      if (manualInvolved) {
        if (diff <= 1) needConfirm.push({ inc: inc, cand: best, kind: 'manual', reason: '与手动记录金额相同且日期相差≤1天' });
        else unique.push(inc);
        return;
      }
      if ((incChannel && bestBank) || (incBank && bestChannel)) {
        var bankTxn = incBank ? inc : best;
        var channelTxn = incChannel ? inc : best;
        var channelHint = bankChannelHint(bankTxn);
        var nearCrossSource = cands.filter(function (x) {
          var cross = (incChannel && isBankSource(x.source)) || (incBank && isChannelSource(x.source));
          return cross && dayDiff(inc, x) <= 2;
        });
        if (diff <= 2 && channelHint === channelTxn.source && nearCrossSource.length === 1) {
          // 高置信自动合并：渠道明确、候选唯一；保留渠道记录（含商户与分类）
          var keep = incChannel ? inc : best, shadow = incChannel ? best : inc;
          claimed[shadow.id] = 1;
          autoMerged.push({ inc: inc, kept: keep, shadow: shadow, kind: 'cross-source', reason: '支付渠道一致、金额相同、日期相差' + diff + '天且候选唯一' });
        } else if (diff <= 2) {
          var why = nearCrossSource.length > 1
            ? '同金额近日期候选不唯一，需人工确认'
            : '金额和日期接近，但银行摘要未确认支付渠道';
          needConfirm.push({ inc: inc, cand: best, kind: 'low-confidence', reason: why });
        } else if (diff <= 31) {
          needConfirm.push({ inc: inc, cand: best, kind: 'low-confidence', reason: '金额相同但日期相差' + diff + '天' });
        } else unique.push(inc);
        return;
      }
      // 渠道↔渠道（微信 vs 支付宝）同额：仅提示
      if (diff <= 1) needConfirm.push({ inc: inc, cand: best, kind: 'low-confidence', reason: '不同渠道同额同日' });
      else unique.push(inc);
    });

    return { autoMerged: autoMerged, needConfirm: needConfirm, transferPairs: transferPairs, unique: unique };
  }

  // 应用自动合并：shadow.mappedTo = kept.id（带 preMerge 快照可撤销）。
  function applyAutoMerge(merge) {
    var shadow = merge.shadow;
    if (shadow && !shadow.mappedTo) {
      shadow.preMerge = { type: shadow.type, account: shadow.account, accountTo: shadow.accountTo };
      shadow.mappedTo = merge.kept.id;
    }
  }

  // 撤销合并：清除 mappedTo，恢复 preMerge 快照。
  function undoMerge(txn) {
    if (txn.preMerge) {
      txn.type = txn.preMerge.type;
      txn.account = txn.preMerge.account;
      txn.accountTo = txn.preMerge.accountTo;
      delete txn.preMerge;
    }
    delete txn.mappedTo;
  }

  // 转账配对应用：渠道转账补齐对端账户，银行端记录遮蔽；或银行入账补齐已有半端转账。
  function applyTransferPair(pair) {
    if (pair.transfer) {
      // 已有渠道半端转账 + 新导入银行端记录
      var tf = pair.transfer, rec = pair.bankRecord;
      if (!tf.accountTo && rec.type === 'income') tf.accountTo = rec.account;
      else if (!tf.account && rec.type === 'expense') tf.account = rec.account;
      if (!rec.mappedTo) {
        rec.preMerge = { type: rec.type, account: rec.account, accountTo: rec.accountTo };
        rec.mappedTo = tf.id;
      }
      return;
    }
    var inc = pair.inc, bank = pair.bankTxn;
    if (!inc.accountTo) inc.accountTo = bank.account;
    else if (!inc.account) inc.account = bank.account;
    if (!bank.mappedTo) {
      bank.preMerge = { type: bank.type, account: bank.account, accountTo: bank.accountTo };
      bank.mappedTo = inc.id;
    }
  }

  /* ------------------------------ 聚合统计 ------------------------------ */

  function visibleTxns(txns) { return txns.filter(function (t) { return !t.mappedTo; }); }

  // 退款关联表：expenseId → [退款收入交易]（V2.3.1）
  function refundMap(txns) {
    var m = {};
    visibleTxns(txns).forEach(function (t) {
      if (t.type === 'income' && t.refundOf) (m[t.refundOf] = m[t.refundOf] || []).push(t);
    });
    return m;
  }
  // 已闭环的报销垫付：expenseId → true（存在关联的报销到账收入）（V2.3.2）
  function reimburseClosedMap(txns) {
    var m = {};
    visibleTxns(txns).forEach(function (t) {
      if (t.type === 'income' && t.reimburseOf) m[t.reimburseOf] = true;
    });
    return m;
  }

  // 月度聚合：{year, month} 均为数字；缺省为当月。
  // 统计口径（V2）：退款冲减原支出、报销闭环后收支还原（不计收入也不计支出）；
  // 转账永不计入收支；被合并遮蔽记录不参与。
  function aggregate(txns, opts) {
    opts = opts || {};
    var now = new Date();
    var y = opts.year || now.getFullYear();
    var m = opts.month != null ? opts.month : now.getMonth() + 1;
    var ym = y + '-' + pad(m);
    var vis = visibleTxns(txns);
    var rMap = refundMap(txns);
    var rbClosed = reimburseClosedMap(txns);
    var catById = {};
    (opts.categories || []).forEach(function (c) { catById[c.id] = c; });
    var res = {
      ym: ym, income: 0, expense: 0, balance: 0, count: 0,
      byCategory: {}, byCategoryIncome: {}, byAccount: {}, transferCount: 0,
      byDay: {}, need: 0, want: 0, necessityNone: 0, refunded: 0
    };
    vis.forEach(function (t) {
      if (t.date.slice(0, 7) !== ym) return;
      res.count++;
      if (t.type === 'expense') {
        if (rbClosed[t.id]) return; // 报销已闭环：不属个人支出
        var linked = rMap[t.id] || [];
        var net = t.amount - linked.reduce(function (s, r) { return s + r.amount; }, 0);
        res.refunded += t.amount - net;
        if (net <= 0) return; // 完全退款冲销
        res.expense += net;
        var c = t.category || 'none';
        if (!res.byCategory[c]) res.byCategory[c] = { sum: 0, count: 0 };
        res.byCategory[c].sum += net; res.byCategory[c].count++;
        res.byDay[t.date] = (res.byDay[t.date] || 0) + t.amount;
        // 必要性按根分类口径（与统计页一级聚合一致）
        var necCat = t.category ? (rootCategoryOf(t.category, opts.categories || []) || catById[t.category]) : null;
        var nec = necCat && necCat.necessity;
        if (nec === 'need') res.need += net;
        else if (nec === 'want') res.want += net;
        else res.necessityNone += net;
      } else if (t.type === 'income') {
        if (t.refundOf || t.reimburseOf) return; // 退款/报销款不计入收入
        res.income += t.amount;
        var ci = t.category || 'none';
        if (!res.byCategoryIncome[ci]) res.byCategoryIncome[ci] = { sum: 0, count: 0 };
        res.byCategoryIncome[ci].sum += t.amount; res.byCategoryIncome[ci].count++;
      } else if (t.type === 'transfer') {
        res.transferCount++;
      }
      var accKey = t.account;
      if (accKey) {
        if (!res.byAccount[accKey]) res.byAccount[accKey] = { expense: 0, income: 0 };
        if (t.type === 'expense') res.byAccount[accKey].expense += t.amount;
        if (t.type === 'income') res.byAccount[accKey].income += t.amount;
      }
    });
    res.balance = res.income - res.expense;
    res.savingsRate = res.income > 0 ? (res.balance / res.income) : null;
    return res;
  }

  // 账户余额 = 初始余额 + 收入 + 转入 − 支出 − 转出（排除被遮蔽记录与已删除账户外的全部交易）。
  function accountBalance(account, txns) {
    var bal = account.initialBalance || 0;
    visibleTxns(txns).forEach(function (t) {
      if (t.type === 'expense' && t.account === account.id) bal -= t.amount;
      else if (t.type === 'income' && t.account === account.id) bal += t.amount;
      else if (t.type === 'transfer') {
        if (t.account === account.id) bal -= t.amount;
        if (t.accountTo === account.id) bal += t.amount;
      }
    });
    return bal;
  }

  // 近 n 个月（含当月）月度序列。
  function monthlySeries(txns, n) {
    n = n || 12;
    var out = [], now = new Date();
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var agg = aggregate(txns, { year: d.getFullYear(), month: d.getMonth() + 1 });
      out.push({ ym: d.getFullYear() + '-' + pad(d.getMonth() + 1), income: agg.income, expense: agg.expense, balance: agg.balance });
    }
    return out;
  }

  // 明细按天分组（倒序）：[{date, txns, dayExpense, dayIncome}]
  function groupByDay(txns) {
    var map = {}, dates = [];
    visibleTxns(txns).forEach(function (t) {
      if (!map[t.date]) { map[t.date] = []; dates.push(t.date); }
      map[t.date].push(t);
    });
    dates.sort(function (a, b) { return a < b ? 1 : a > b ? -1 : 0; });
    return dates.map(function (d) {
      var list = map[d].slice().sort(function (a, b) { return (b.time || '').localeCompare(a.time || ''); });
      var e = 0, inc = 0;
      list.forEach(function (t) {
        if (t.type === 'expense') e += t.amount;
        else if (t.type === 'income') inc += t.amount;
      });
      return { date: d, txns: list, dayExpense: e, dayIncome: inc };
    });
  }

  /* ================= V2.2 预算体系 ================= */

  // budgets: { total: 分, cats: { catId: 分 } }
  // → { total: {budget, spent, pct, over}, cats: [{catId, budget, spent, pct, over}] }
  function budgetStatus(txns, budgets, opts) {
    opts = opts || {};
    budgets = budgets || {};
    var agg = aggregate(txns, opts);
    var total = { budget: budgets.total || 0, spent: agg.expense, pct: 0, over: false };
    total.pct = total.budget > 0 ? agg.expense / total.budget : null;
    total.over = total.budget > 0 && agg.expense > total.budget;
    var cats = [];
    var catIds = {};
    Object.keys(budgets.cats || {}).forEach(function (id) { catIds[id] = 1; });
    Object.keys(agg.byCategory).forEach(function (id) { catIds[id] = 1; });
    Object.keys(catIds).forEach(function (id) {
      var b = (budgets.cats || {})[id] || 0;
      var spent = agg.byCategory[id] ? agg.byCategory[id].sum : 0;
      cats.push({
        catId: id, budget: b, spent: spent,
        pct: b > 0 ? spent / b : null,
        over: b > 0 && spent > b
      });
    });
    cats.sort(function (a, b2) { return (b2.budget || b2.spent) - (a.budget || a.spent); });
    return { ym: agg.ym, total: total, cats: cats, expense: agg.expense };
  }

  /* ================= V2.2.2 统计基线与异常检测 ================= */

  function monthAdd(ym, delta) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + delta;
    var d = new Date(y, m, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  function daysInMonth(ym) { return new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate(); }

  // 基线：目标月之前 1–6 个有数据的月份（不含目标月）。
  function baselineMonths(txns, ym, maxMonths) {
    maxMonths = maxMonths || 6;
    var sums = {}, counts = {}, amounts = {};
    visibleTxns(txns).forEach(function (t) {
      if (t.type !== 'expense' || t.refundOf) return;
      var tym = t.date.slice(0, 7);
      if (tym >= ym) return;
      var c = t.category || 'none';
      if (!sums[tym]) sums[tym] = {};
      if (!sums[tym][c]) sums[tym][c] = 0;
      sums[tym][c] += t.amount;
      if (!amounts[c]) amounts[c] = [];
      amounts[c].push(t.amount);
      counts[c] = (counts[c] || 0) + 1;
    });
    var months = Object.keys(sums).sort().slice(-maxMonths);
    var perCat = {}, merchants = {};
    visibleTxns(txns).forEach(function (t) {
      if (t.type !== 'expense' || t.date.slice(0, 7) >= ym) return;
      if (t.merchant) merchants[t.merchant] = true;
    });
    Object.keys(amounts).forEach(function (c) {
      var arr = amounts[c].slice().sort(function (a, b) { return a - b; });
      var monthly = months.map(function (mth) { return sums[mth][c] || 0; });
      var mean = monthly.reduce(function (s, v) { return s + v; }, 0) / Math.max(months.length, 1);
      var sorted = monthly.slice().sort(function (a, b) { return a - b; });
      var median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      perCat[c] = {
        mean: mean, median: median, months: months.length,
        txnCount: arr.length,
        p95: arr.length >= 5 ? arr[Math.min(arr.length - 1, Math.ceil(arr.length * 0.95) - 1)] : null,
        max: arr.length ? arr[arr.length - 1] : 0
      };
    });
    // 商户历史月均笔数
    var merchantCounts = {};
    visibleTxns(txns).forEach(function (t) {
      if (t.type !== 'expense' || t.date.slice(0, 7) >= ym || !t.merchant) return;
      merchantCounts[t.merchant] = (merchantCounts[t.merchant] || 0) + 1;
    });
    return { months: months, perCat: perCat, merchants: merchants, merchantCounts: merchantCounts };
  }

  function medianOf(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  }

  // detectAnomalies(txns, {year, month, categories}) →
  // { insufficient, message, anomalies: [{kind, severity, catId, merchant, date, txnIds, amount, message}] }
  // 异常类型：category-surge 分类环比 / large-single 单笔大额 / first-large 新商户首笔大额 / frequent-small 高频小额
  function detectAnomalies(txns, opts) {
    opts = opts || {};
    var now = new Date();
    var y = opts.year || now.getFullYear();
    var m = opts.month != null ? opts.month : now.getMonth() + 1;
    var ym = y + '-' + pad(m);
    var threshold = opts.surgeDiffCents != null ? opts.surgeDiffCents : 10000;   // 环比金额差阈值 ¥100
    var firstLarge = opts.firstLargeCents != null ? opts.firstLargeCents : 20000; // 新商户大额 ¥200
    var freqTotal = opts.frequentTotalCents != null ? opts.frequentTotalCents : 10000;
    var freqAvgMax = opts.frequentAvgCents != null ? opts.frequentAvgCents : 15000;

    var base = baselineMonths(txns, ym);
    if (base.months.length < 2) {
      return { insufficient: true, message: '历史数据不足 2 个月，数据积累中，暂不做异常判断', anomalies: [], baselineMonths: base.months.length };
    }

    var agg = aggregate(txns, { year: y, month: m, categories: opts.categories || [] });
    var catById = {};
    (opts.categories || []).forEach(function (c) { catById[c.id] = c; });
    var catName = function (cid) { return (catById[cid] || {}).name || '未分类'; };
    var anomalies = [];

    // ① 分类环比异常：超基线均值 50% 且金额差达阈值
    Object.keys(agg.byCategory).forEach(function (cid) {
      var b = base.perCat[cid];
      if (!b || b.mean <= 0) return;
      var cur = agg.byCategory[cid].sum;
      if (cur > b.mean * 1.5 && (cur - b.mean) >= threshold) {
        anomalies.push({
          kind: 'category-surge', severity: (cur - b.mean) >= b.mean ? 'red' : 'yellow',
          catId: cid, date: ym + '-01', amount: cur - Math.round(b.mean),
          message: catName(cid) + ' 本月 ' + centsToYuan(cur) + ' 元，超出近 ' + base.months.length + ' 个月均值（' + centsToYuan(Math.round(b.mean)) + ' 元）50% 以上'
        });
      }
    });

    // ② 单笔大额（超该分类历史 P95）与 ③ 新商户首笔大额
    var curTxns = visibleTxns(txns).filter(function (t) {
      return t.type === 'expense' && !t.refundOf && t.date.slice(0, 7) === ym;
    });
    curTxns.forEach(function (t) {
      var b = base.perCat[t.category || 'none'];
      var isNewMerchant = t.merchant && !base.merchants[t.merchant];
      if (isNewMerchant && t.amount >= firstLarge) {
        // 新商户首笔大额（更具体的信号，优先报告）
        anomalies.push({
          kind: 'first-large', severity: 'yellow',
          catId: t.category, merchant: t.merchant, date: t.date, txnIds: [t.id], amount: t.amount,
          message: '新商户「' + t.merchant + '」首笔即 ' + centsToYuan(t.amount) + ' 元'
        });
      } else if (b && b.p95 != null && t.amount > b.p95) {
        anomalies.push({
          kind: 'large-single', severity: t.amount > b.p95 * 2 ? 'red' : 'yellow',
          catId: t.category, merchant: t.merchant, date: t.date, txnIds: [t.id], amount: t.amount,
          message: (t.merchant || catName(t.category)) + ' 单笔 ' + centsToYuan(t.amount) + ' 元，超过' + catName(t.category) + '历史 P95（' + centsToYuan(b.p95) + ' 元）'
        });
      }
    });

    // ④ 高频小额累积（奶茶/咖啡效应）：商户笔数超历史月均 50% 且总额显著
    var byMerchant = {};
    curTxns.forEach(function (t) {
      if (!t.merchant) return;
      if (!byMerchant[t.merchant]) byMerchant[t.merchant] = { count: 0, sum: 0, txns: [] };
      byMerchant[t.merchant].count++;
      byMerchant[t.merchant].sum += t.amount;
      byMerchant[t.merchant].txns.push(t);
    });
    Object.keys(byMerchant).forEach(function (mer) {
      var g = byMerchant[mer];
      if (g.count < 3) return;
      var histMonthlyMean = (base.merchantCounts[mer] || 0) / base.months.length;
      var avg = g.sum / g.count;
      if (histMonthlyMean > 0 && g.count > histMonthlyMean * 1.5 && g.sum >= freqTotal && avg <= freqAvgMax) {
        anomalies.push({
          kind: 'frequent-small', severity: 'yellow',
          merchant: mer, date: ym + '-01', txnIds: g.txns.map(function (t) { return t.id; }),
          amount: g.sum, count: g.count,
          message: '「' + mer + '」本月 ' + g.count + ' 笔共 ' + centsToYuan(g.sum) + ' 元（历史月均 ' + (Math.round(histMonthlyMean * 10) / 10) + ' 笔），积少成多'
        });
      }
    });

    anomalies.sort(function (a, b) { return (a.severity === 'red' ? 0 : 1) - (b.severity === 'red' ? 0 : 1); });
    return { insufficient: false, anomalies: anomalies, baselineMonths: base.months.length };
  }

  /* ================= V2.2.3 订阅与周期扣款检测 ================= */

  // 相同商户 + 相近金额（±2%）+ 周期稳定（间隔中位数 ±5 天内）出现 ≥3 次 → 订阅。
  // → [{merchant, amount, intervalDays, count, firstDate, lastDate, monthlyCost}]
  function detectSubscriptions(txns) {
    var byMerchant = {};
    visibleTxns(txns).filter(function (t) { return t.type === 'expense' && t.merchant; }).forEach(function (t) {
      (byMerchant[t.merchant] = byMerchant[t.merchant] || []).push(t);
    });
    var subs = [];
    Object.keys(byMerchant).forEach(function (mer) {
      var list = byMerchant[mer].slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (list.length < 3) return;
      // 找最长稳定序列：金额相近 + 间隔稳定
      var best = null;
      for (var i = 0; i < list.length; i++) {
        var seq = [list[i]];
        var intervals = [];
        for (var j = i + 1; j < list.length; j++) {
          var prev = seq[seq.length - 1];
          var gap = daysBetween(prev.date, list[j].date);
          if (gap <= 0) continue;
          var med = medianOf(intervals);
          if (intervals.length && Math.abs(gap - med) > 5) continue;
          if (Math.abs(list[j].amount - seq[0].amount) > seq[0].amount * 0.02) continue;
          seq.push(list[j]); intervals.push(gap);
        }
        if (seq.length >= 3 && (!best || seq.length > best.seq.length)) best = { seq: seq, intervals: intervals };
      }
      if (!best) return;
      var med = medianOf(best.intervals);
      // 常见周期：周(6-8)、月(26-35)、季(85-98)、年(360-371)
      var valid = (med >= 6 && med <= 8) || (med >= 26 && med <= 35) || (med >= 85 && med <= 98) || (med >= 360 && med <= 371);
      if (!valid) return;
      var amount = Math.round(best.seq.reduce(function (s, t) { return s + t.amount; }, 0) / best.seq.length);
      subs.push({
        merchant: mer, amount: amount, intervalDays: Math.round(med), count: best.seq.length,
        firstDate: best.seq[0].date, lastDate: best.seq[best.seq.length - 1].date,
        monthlyCost: Math.round(amount * 30.44 / med),
        txnIds: best.seq.map(function (t) { return t.id; })
      });
    });
    subs.sort(function (a, b) { return b.monthlyCost - a.monthlyCost; });
    return subs;
  }

  /* ================= V2.3.1 退款冲销 ================= */

  // 为未关联的退款（income + refundFlag + !refundOf）推荐原交易：
  // 商户匹配（相等或包含）+ 金额 ≥ 退款额 + 时间窗（退款前 90 天内）+ 优先同账户。
  // → [{refund, candidates: [expense...]}]（candidates 已按匹配度排序）
  function matchRefunds(txns) {
    var vis = visibleTxns(txns);
    var rMap = refundMap(txns);
    var results = [];
    vis.forEach(function (rf) {
      if (rf.type !== 'income' || !rf.refundFlag || rf.refundOf) return;
      var cands = [];
      vis.forEach(function (ex) {
        if (ex.type !== 'expense') return;
        if ((rMap[ex.id] || []).length) {
          var netLeft = ex.amount - rMap[ex.id].reduce(function (s, r) { return s + r.amount; }, 0);
          if (netLeft < rf.amount) return;
        } else if (ex.amount < rf.amount) return;
        var dd = daysBetween(ex.date, rf.date);
        if (dd < 0 || dd > 90) return;
        var m1 = normName(rf.merchant), m2 = normName(ex.merchant);
        if (!m1 || !m2) return;
        if (m1 !== m2 && m1.indexOf(m2) < 0 && m2.indexOf(m1) < 0) return;
        cands.push({ ex: ex, exact: ex.amount === rf.amount, dd: dd, sameAcc: ex.account === rf.account });
      });
      cands.sort(function (a, b) {
        return (b.exact - a.exact) || (a.dd - b.dd) || (b.sameAcc - a.sameAcc);
      });
      results.push({ refund: rf, candidates: cands.map(function (c) { return c.ex; }) });
    });
    return results;
  }

  // 关联退款：refund.refundOf = expense.id
  function linkRefund(refund, expense) { refund.refundOf = expense.id; }
  function unlinkRefund(refund) { delete refund.refundOf; }

  /* ================= V2.3.2 报销管理 ================= */

  // 待报销垫付：expense + reimburseFlag 且尚无关联报销款。
  // 推荐配对：未关联收入（非退款），金额相等，日期 ≥ 垫付日，优先含"报销"关键词的收入。
  // → { pending: [expense...], suggestions: [{income, candidates: [expense...]}] }
  function matchReimbursements(txns) {
    var vis = visibleTxns(txns);
    var closed = reimburseClosedMap(txns);
    var pending = vis.filter(function (t) {
      return t.type === 'expense' && t.reimburseFlag && !closed[t.id];
    });
    var openIncomes = vis.filter(function (t) {
      return t.type === 'income' && !t.refundOf && !t.reimburseOf && !t.refundFlag;
    });
    var suggestions = [];
    openIncomes.forEach(function (inc) {
      var cands = pending.filter(function (ex) {
        if (ex.amount !== inc.amount) return false;
        return daysBetween(ex.date, inc.date) >= 0;
      });
      if (cands.length) suggestions.push({ income: inc, candidates: cands });
    });
    return { pending: pending, suggestions: suggestions };
  }
  function linkReimbursement(income, expense) { income.reimburseOf = expense.id; }
  function unlinkReimbursement(income) { delete income.reimburseOf; }

  /* ================= V2.3.3 周期记账 ================= */

  // 模板：{id, name, type, amount, accountId, categoryId, note,
  //        frequency: 'monthly'|'weekly'|'yearly'|'daily', day: 号/星期(0-6), month: 1-12(年), active}
  // 生成 [fromYm, toYm]（含端点）区间内的应生成日期。纯函数。
  function dueRecurring(templates, fromYm, toYm) {
    var out = [];
    var from = fromYm + '-01', to = toYm + '-' + pad(daysInMonth(toYm));
    (templates || []).forEach(function (tpl) {
      if (tpl.active === false) return;
      if (tpl.frequency === 'weekly') {
        var d = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00');
        while (d <= end) {
          if (d.getDay() === (tpl.day || 1)) {
            out.push({ tplId: tpl.id, date: fmtYmd(d) });
          }
          d.setDate(d.getDate() + 1);
        }
      } else if (tpl.frequency === 'yearly') {
        var y0 = +fromYm.slice(0, 4), y1 = +toYm.slice(0, 4);
        for (var y = y0; y <= y1; y++) {
          var dt = y + '-' + pad(tpl.month || 1) + '-' + pad(Math.min(tpl.day || 1, daysInMonth(y + '-' + pad(tpl.month || 1))));
          if (dt >= from && dt <= to) out.push({ tplId: tpl.id, date: dt });
        }
      } else { // monthly / daily
        var ymCursor = fromYm;
        while (ymCursor <= toYm) {
          if (tpl.frequency === 'daily') {
            var dim = daysInMonth(ymCursor);
            for (var dd = 1; dd <= dim; dd++) out.push({ tplId: tpl.id, date: ymCursor + '-' + pad(dd) });
          } else {
            var day = Math.min(tpl.day || 1, daysInMonth(ymCursor));
            out.push({ tplId: tpl.id, date: ymCursor + '-' + pad(day) });
          }
          ymCursor = monthAdd(ymCursor, 1);
        }
      }
    });
    out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return out;
  }
  function fmtYmd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  // 幂等生成：跳过已存在的 recurringKey（tplId@date）。
  function generateRecurring(templates, occurrences, existingTxns) {
    var tplById = {};
    (templates || []).forEach(function (t) { tplById[t.id] = t; });
    var keys = {};
    (existingTxns || []).forEach(function (t) { if (t.recurringKey) keys[t.recurringKey] = t; });
    var made = [], skipped = 0;
    occurrences.forEach(function (oc) {
      var tpl = tplById[oc.tplId];
      if (!tpl) return;
      var key = tpl.id + '@' + oc.date;
      if (keys[key]) { skipped++; return; }
      var txn = {
        id: newId('t'), date: oc.date, time: '09:00',
        type: tpl.type || 'expense', amount: tpl.amount,
        account: tpl.accountId, accountTo: null,
        category: tpl.categoryId || null,
        merchant: tpl.name || '', note: tpl.note || '',
        source: 'manual', rawId: '', status: '',
        recurringKey: key, recurringTplId: tpl.id
      };
      made.push(txn);
      keys[key] = txn;
    });
    return { txns: made, skipped: skipped };
  }

  /* ================= V2.3.4 二级分类 ================= */

  function rootCategoryOf(catId, categories) {
    var byId = {};
    (categories || []).forEach(function (c) { byId[c.id] = c; });
    var c = byId[catId], guard = 0;
    while (c && c.parentId && byId[c.parentId] && guard++ < 10) c = byId[c.parentId];
    return c || null;
  }

  // 按一级分类聚合 byCategory（子分类金额并入根分类）。
  function rollupByRoot(byCategory, categories) {
    var out = {};
    Object.keys(byCategory).forEach(function (cid) {
      var root = cid === 'none' ? null : rootCategoryOf(cid, categories);
      var key = root ? root.id : cid;
      if (!out[key]) out[key] = { sum: 0, count: 0, children: {} };
      out[key].sum += byCategory[cid].sum;
      out[key].count += byCategory[cid].count;
      if (key !== cid) out[key].children[cid] = byCategory[cid];
    });
    return out;
  }

  /* ------------------------------ 预置数据 ------------------------------ */

  var ACC_TYPES = {
    wechat: { name: '微信零钱', icon: '💬', color: '#07c160' },
    alipay: { name: '支付宝', icon: '🅰️', color: '#1677ff' },
    bank: { name: '银行卡', icon: '🏦', color: '#f59e0b' },
    cash: { name: '现金', icon: '💵', color: '#64748b' }
  };

  function defaultAccounts() {
    return [
      { id: 'acc-wechat', name: '微信零钱', type: 'wechat', color: '#07c160', initialBalance: 0, order: 1, aliases: ['零钱', '微信支付', '微信'] },
      { id: 'acc-alipay', name: '支付宝', type: 'alipay', color: '#1677ff', initialBalance: 0, order: 2, aliases: ['支付宝余额', '余额', '支付宝'] },
      { id: 'acc-bank', name: '银行卡', type: 'bank', color: '#f59e0b', initialBalance: 0, order: 3, aliases: ['银行卡', '储蓄卡'] },
      { id: 'acc-cash', name: '现金', type: 'cash', color: '#64748b', initialBalance: 0, order: 4, aliases: ['现金'] }
    ];
  }

  function defaultCategories() {
    return [
      // 支出
      { id: 'cat-food', type: 'expense', name: '餐饮', icon: '🍜', keywords: ['肯德基', '麦当劳', '美团', '饿了么', '星巴克', '瑞幸', '必胜客', '餐厅', '饭店', '小吃', '外卖', '奶茶', '喜茶', '咖啡', '食品', '超市', '便利店', '盒马', '叮咚买菜'] },
      { id: 'cat-transport', type: 'expense', name: '交通', icon: '🚌', keywords: ['滴滴', '高德', '地铁', '公交', '12306', '铁路', '航空', '机票', '火车票', '加油', '出租车', '哈啰', '共享单车', '摩拜', '一卡通'] },
      { id: 'cat-shopping', type: 'expense', name: '购物', icon: '🛒', keywords: ['淘宝', '天猫', '京东', '拼多多', '苏宁', '唯品会', '得物', '闲鱼', '优衣库', '百货', '服饰'] },
      { id: 'cat-home', type: 'expense', name: '居住', icon: '🏠', keywords: ['房租', '物业', '水电', '水费', '电费', '燃气', '宽带', '自如', '链家', '家政', '维修'] },
      { id: 'cat-fun', type: 'expense', name: '娱乐', icon: '🎮', keywords: ['电影', '猫眼', '淘票票', '游戏', '腾讯视频', '爱奇艺', '优酷', '哔哩哔哩', 'steam', '网易', '王者', '原神', 'KTV', '健身', '运动'] },
      { id: 'cat-medical', type: 'expense', name: '医疗', icon: '💊', keywords: ['医院', '药店', '药房', '门诊', '挂号', '体检', '牙科', '眼科'] },
      { id: 'cat-edu', type: 'expense', name: '教育', icon: '📚', keywords: ['书店', '当当', '京东图书', '课程', '培训', '网课', '得到', '知识付费', '考试', '打印'] },
      { id: 'cat-telecom', type: 'expense', name: '通讯', icon: '📱', keywords: ['话费', '中国移动', '中国联通', '中国电信', '流量', '月租'] },
      { id: 'cat-other-exp', type: 'expense', name: '其他支出', icon: '📦', keywords: [] },
      // 收入
      { id: 'cat-salary', type: 'income', name: '工资', icon: '💰', keywords: ['工资', '代发', '薪水', '月薪'] },
      { id: 'cat-bonus', type: 'income', name: '奖金', icon: '🏆', keywords: ['奖金', '年终奖', '绩效', '补贴'] },
      { id: 'cat-invest', type: 'income', name: '理财', icon: '📈', keywords: ['利息', '理财', '基金', '余额宝', '收益', '黄金'] },
      { id: 'cat-redpacket', type: 'income', name: '红包', icon: '🧧', keywords: ['红包', '压岁钱', '转账收款'] },
      { id: 'cat-refund', type: 'income', name: '退款', icon: '↩️', keywords: ['退款', '退货', '退款的'] },
      { id: 'cat-other-inc', type: 'income', name: '其他收入', icon: '🧾', keywords: [] }
    ];
  }

  function defaultSettings() {
    return {
      schemaVersion: 1,
      lock: { enabled: false },
      bankTemplates: [],   // 用户保存的银行列映射模板
      budgets: { total: 0, cats: {} },  // V2.2.1 月度预算（分为单位）
      recurring: [],       // V2.3.3 周期记账模板
      recurringAuto: false, // 是否静默自动生成
      lastRun: null        // 上次周期生成日期 YYYY-MM-DD
    };
  }

  /* ------------------------------ 备份与恢复 ------------------------------ */

  // v3 资产集合键（Schema v2 新增；键名与 js/domain.js 的 ASSET_KEYS 保持一致，见 ARCHITECTURE §5.1/5.2）
  var V3_ASSET_KEYS = ['assetAccounts', 'assetUnits', 'assetTransfers', 'liabilities', 'entitlements', 'instruments', 'holdings', 'quotes', 'fxRates', 'securityEvents'];

  function emptyV3Assets() {
    var a = { schemaVersion: 1 };
    V3_ASSET_KEYS.forEach(function (k) { a[k] = []; });
    return a;
  }

  /* 追加式事实集合（5B 风险评估 / 5C 目标版本与认可标的 / 5D 建议产物与月结快照历史 /
   * 6B 决策状态机三集合）。
   * JSON 备份必须带上它们，否则「导出备份」会丢掉规则版本、原始答案、评估、目标、认可映射
   * 与决策历史；旧备份缺这些键时恢复为**空集合**，不生成伪默认值（D-034 / PHASE6_CONTRACT §6.4）。 */
  var COMPANION_STATE_KEYS = ['riskAssessments', 'allocationTargets', 'approvedInstruments', 'recommendations', 'decisions', 'decisionEvents', 'decisionLinks', 'monthlyCloses', 'closeSnapshots'];

  function companionCollectionsOf(state) {
    var out = {};
    state = state || {};
    COMPANION_STATE_KEYS.forEach(function (k) {
      out[k] = Array.isArray(state[k]) ? state[k] : [];
    });
    return out;
  }

  function createBackup(state, appVersion, exportedAt) {
    state = state || {};
    var assets = state.assets && typeof state.assets === 'object' && !Array.isArray(state.assets)
      ? state.assets : emptyV3Assets();
    return Object.assign({
      app: 'ledger',
      appVersion: appVersion || '',
      schemaVersion: 2,
      exportedAt: exportedAt || new Date().toISOString(),
      accounts: Array.isArray(state.accounts) ? state.accounts : [],
      categories: Array.isArray(state.categories) ? state.categories : [],
      txns: Array.isArray(state.txns) ? state.txns : [],
      assets: assets,
      // 备份为可迁移明文；恢复后默认关闭应用锁，避免携带无法使用的内存密钥状态。
      settings: Object.assign({}, state.settings || {}, { lock: { enabled: false } })
    }, companionCollectionsOf(state));
  }

  function restoreStateFromBackup(data) {
    if (!data || data.app !== 'ledger') throw new Error('不是小账本的备份文件');
    if (!Array.isArray(data.txns)) throw new Error('备份缺少有效的交易数据');
    var version = data.schemaVersion == null ? 1 : data.schemaVersion;
    if (version !== 1 && version !== 2) {
      throw new Error('不支持的备份版本：' + data.schemaVersion);
    }
    if (data.accounts != null && !Array.isArray(data.accounts)) throw new Error('备份账户数据格式错误');
    if (data.categories != null && !Array.isArray(data.categories)) throw new Error('备份分类数据格式错误');
    if (data.settings != null && (typeof data.settings !== 'object' || Array.isArray(data.settings))) {
      throw new Error('备份设置数据格式错误');
    }
    // v1 备份没有 v3 资产集合，恢复为空集合（S1.1 旧状态兼容）；v2 逐键校验透传。
    var assets = emptyV3Assets();
    if (version === 2) {
      if (data.assets != null && (typeof data.assets !== 'object' || Array.isArray(data.assets))) {
        throw new Error('备份资产数据格式错误');
      }
      if (data.assets) {
        V3_ASSET_KEYS.forEach(function (k) {
          if (data.assets[k] != null) assets[k] = Array.isArray(data.assets[k]) ? data.assets[k] : [];
        });
      }
    }
    // 追加式事实集合：显式存在就必须是数组（不静默丢行），缺省则为空集合（旧备份不伪造默认值）。
    var companion = {};
    COMPANION_STATE_KEYS.forEach(function (k) {
      if (data[k] != null && !Array.isArray(data[k])) throw new Error('备份 ' + k + ' 数据格式错误');
      companion[k] = Array.isArray(data[k]) ? data[k] : [];
    });
    return Object.assign({
      accounts: data.accounts || defaultAccounts(),
      categories: data.categories || defaultCategories(),
      txns: data.txns,
      assets: assets,
      settings: Object.assign(defaultSettings(), data.settings || {}, { lock: { enabled: false } })
    }, companion);
  }

  function transactionsToCSV(txns, accounts, categories) {
    var accountMap = {}, categoryMap = {};
    (accounts || []).forEach(function (a) { accountMap[a.id] = a.name; });
    (categories || []).forEach(function (c) { categoryMap[c.id] = c.name; });
    var sourceNames = { manual: '手动', wechat: '微信', alipay: '支付宝', bank: '银行' };
    function csvCell(value) {
      var text = String(value == null ? '' : value);
      return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    var header = '日期,时间,类型,金额(元),账户,转入账户,分类,商户/对方,备注,来源';
    var rows = visibleTxns(txns || []).slice().sort(function (a, b) {
      return (b.date + (b.time || '')).localeCompare(a.date + (a.time || ''));
    }).map(function (t) {
      return [
        t.date, t.time || '',
        { expense: '支出', income: '收入', transfer: '转账' }[t.type] || t.type,
        centsToYuan(t.amount),
        accountMap[t.account] || (t.account ? '已删除账户' : '未指定账户'),
        t.type === 'transfer' ? (accountMap[t.accountTo] || (t.accountTo ? '已删除账户' : '未指定账户')) : '',
        t.type === 'transfer' ? '' : (categoryMap[t.category] || '未分类'),
        t.merchant || '', t.note || '', sourceNames[t.source] || t.source || ''
      ].map(csvCell).join(',');
    });
    return '\uFEFF' + header + '\n' + rows.join('\n');
  }

  /* ------------------------------ 导出 API ------------------------------ */

  return {
    yuanToCents: yuanToCents,
    centsToYuan: centsToYuan,
    fmtMoney: fmtMoney,
    parseCSV: parseCSV,
    decodeBytes: decodeBytes,
    normalizeDate: normalizeDate,
    todayStr: todayStr,
    ymOf: ymOf,
    daysBetween: daysBetween,
    weekdayCN: weekdayCN,
    fmtDateCN: fmtDateCN,
    newId: newId,
    guessCategory: guessCategory,
    matchAccountByText: matchAccountByText,
    parseWechatCSV: parseWechatCSV,
    parseAlipayCSV: parseAlipayCSV,
    parseBankCSV: parseBankCSV,
    matchBankTemplate: matchBankTemplate,
    bankPresets: BANK_PRESETS,
    parseFile: parseFile,
    suggestTypeMappings: suggestTypeMappings,
    buildTxns: buildTxns,
    matchDuplicates: matchDuplicates,
    applyAutoMerge: applyAutoMerge,
    applyTransferPair: applyTransferPair,
    undoMerge: undoMerge,
    aggregate: aggregate,
    accountBalance: accountBalance,
    monthlySeries: monthlySeries,
    groupByDay: groupByDay,
    visibleTxns: visibleTxns,
    budgetStatus: budgetStatus,
    detectAnomalies: detectAnomalies,
    detectSubscriptions: detectSubscriptions,
    matchRefunds: matchRefunds,
    refundMap: refundMap,
    reimburseClosedMap: reimburseClosedMap,
    linkRefund: linkRefund,
    unlinkRefund: unlinkRefund,
    matchReimbursements: matchReimbursements,
    linkReimbursement: linkReimbursement,
    unlinkReimbursement: unlinkReimbursement,
    dueRecurring: dueRecurring,
    generateRecurring: generateRecurring,
    rootCategoryOf: rootCategoryOf,
    rollupByRoot: rollupByRoot,
    defaultAccounts: defaultAccounts,
    defaultCategories: defaultCategories,
    defaultSettings: defaultSettings,
    createBackup: createBackup,
    restoreStateFromBackup: restoreStateFromBackup,
    transactionsToCSV: transactionsToCSV
  };
});
