/* 小账本 provider 固定时钟 — Phase 4A 交付（ROADMAP.md）
 *
 * provider adapter 一律从 ctx.now 读取时间，绝不直接调用 Date.now()。
 * 本模块提供"把时间作为显式依赖"的最小工具：测试与离线场景用 fixedClock 得到确定时间，
 * 生产环境由调用方注入真实当前时间（同样经 ctx.now），保证 adapter 零时钟副作用、可复现。
 */
'use strict';

// 固定时钟：返回 { now }，now 恒为给定 ISO 字符串。
function fixedClock(nowIso) {
  return { now: String(nowIso) };
}

// 从 ctx 读取 now：兼容 ctx.now 为函数（惰性求值）或字符串两种情况。
function nowOf(ctx) {
  if (!ctx) return null;
  return typeof ctx.now === 'function' ? ctx.now() : ctx.now;
}

module.exports = {
  fixedClock: fixedClock,
  nowOf: nowOf
};
