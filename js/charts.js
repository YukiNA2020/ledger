/* 小账本 charts.js — 自绘 SVG 图表（零依赖、零外联）
 * 提供：donut 环形图、bars 分组柱状图。全部返回 SVG 字符串。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Charts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PALETTE = ['#f97316', '#ef4444', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e', '#84cc16', '#a855f7'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 环形图：items=[{label,value,color?}]，占比渲染 + 中心文字 */
  function donut(items, opts) {
    opts = opts || {};
    var size = opts.size || 190, cx = size / 2, cy = size / 2;
    var r = size / 2 - 8, thickness = opts.thickness || 26;
    var total = 0;
    items.forEach(function (it) { total += it.value; });
    var centerTop = opts.centerLabel || '';
    var centerVal = opts.centerValue || '';

    if (!total || !items.length) {
      return '<svg viewBox="0 0 ' + size + ' ' + size + '" class="chart-donut">' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--bg-3)" stroke-width="' + thickness + '"/>' +
        '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" class="chart-empty">暂无数据</text></svg>';
    }

    var angle = -Math.PI / 2, paths = [];
    items.forEach(function (it, i) {
      var frac = it.value / total;
      if (frac <= 0) return;
      var a1 = angle, a2 = angle + frac * Math.PI * 2 - 0.008; // 留缝隙
      if (a2 < a1) a2 = a1;
      var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      var x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      var large = (a2 - a1) > Math.PI ? 1 : 0;
      var color = it.color || PALETTE[i % PALETTE.length];
      var pct = (frac * 100).toFixed(1) + '%';
      paths.push('<path d="M ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2) +
        '" fill="none" stroke="' + color + '" stroke-width="' + thickness + '" stroke-linecap="butt"><title>' + esc(it.label) + ' ' + pct + '</title></path>');
      angle += frac * Math.PI * 2;
    });
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" class="chart-donut">' + paths.join('') +
      (centerVal ? '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" class="chart-center-val">' + esc(centerVal) + '</text>' : '') +
      (centerTop ? '<text x="' + cx + '" y="' + (cy + 18) + '" text-anchor="middle" class="chart-center-label">' + esc(centerTop) + '</text>' : '') +
      '</svg>';
  }

  /* 分组柱状图：{labels:[], series:[{name,color,values:[]}]}
   * 自适应 y 轴刻度、网格线、悬浮 title。
   */
  function bars(conf) {
    var labels = conf.labels || [];
    var series = conf.series || [];
    var W = 640, H = 220, padL = 46, padR = 8, padT = 14, padB = 26;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = 0;
    series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    if (!max) max = 100;
    var step = niceStep(max);
    var top = Math.ceil(max / step) * step;

    var gridLines = '', yTicks = '';
    for (var v = 0; v <= top; v += step) {
      var y = padT + ih - (v / top) * ih;
      gridLines += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" class="chart-grid"/>';
      var label = v >= 10000 ? (v / 10000).toFixed(v % 10000 ? 1 : 0) + '万' : String(Math.round(v / 100) || 0);
      yTicks += '<text x="' + (padL - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" class="chart-tick">' + label + '</text>';
    }

    var n = labels.length;
    var groupW = iw / Math.max(n, 1);
    var barCount = series.length;
    var barW = Math.max(3, Math.min(14, (groupW - 6) / barCount - 2));
    var barsSvg = '';
    labels.forEach(function (lab, gi) {
      var gx = padL + gi * groupW;
      series.forEach(function (s, si) {
        var val = s.values[gi] || 0;
        var h = (val / top) * ih;
        var x = gx + groupW / 2 - (barCount * barW + (barCount - 1) * 2) / 2 + si * (barW + 2);
        var y = padT + ih - h;
        barsSvg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(h, val ? 1 : 0).toFixed(1) +
          '" rx="2" fill="' + s.color + '"><title>' + esc(lab) + ' ' + esc(s.name) + ' ¥' + (val / 100).toFixed(2) + '</title></rect>';
      });
      barsSvg += '<text x="' + (gx + groupW / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="chart-tick">' + esc(lab) + '</text>';
    });

    var legend = series.map(function (s) {
      return '<span class="chart-legend-item"><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>';
    }).join('');

    return '<div class="chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-bars" preserveAspectRatio="xMidYMid meet">' +
      gridLines + yTicks + barsSvg + '</svg><div class="chart-legend">' + legend + '</div></div>';
  }

  function niceStep(max) {
    var raw = max / 4;
    var pow = Math.pow(10, Math.floor(Math.log(raw || 1) / Math.LN10));
    var candidates = [pow, pow * 2, pow * 5, pow * 10];
    for (var i = 0; i < candidates.length; i++) if (candidates[i] >= raw) return candidates[i];
    return pow * 10;
  }

  return { donut: donut, bars: bars, PALETTE: PALETTE };
});
