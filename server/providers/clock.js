/* 小账本 provider 固定时钟 — Phase 4A 交付（ROADMAP.md）
 *
 * provider adapter 一律从 ctx.now 读取时间，绝不直接调用 Date.now()。
 * 本模块提供"把时间作为显式依赖"的最小工具：测试与离线场景用 fixedClock 得到确定时间，
 * 生产环境由调用方注入真实当前时间（同样经 ctx.now），保证 adapter 零时钟副作用、可复现。
 *
 * fixedClock 会校验传入的时间戳：必须是带时区的 ISO 时间（与 contract.isTimestamp 同一口径），
 * 否则直接抛 ContractError —— 一个 "bad" 抓取时间写进行情就是不可追溯的账务事实。
 */
'use strict';

var Contract = require('./contract');

// 固定时钟：返回 { now }，now 恒为给定 ISO 字符串。
function fixedClock(nowIso) {
  if (!Contract.isTimestamp(nowIso)) {
    throw new Contract.ContractError('invalid_payload', 'fixedClock 需要带时区的 ISO 时间戳');
  }
  return { now: nowIso };
}

// 从 ctx 读取 now：兼容 ctx.now 为函数（惰性求值）或字符串两种情况。
// 不做校验：缺失或非法的抓取时间由 adapter 显式转成 invalid_payload，而不是静默用当前时间兜底。
function nowOf(ctx) {
  if (!ctx) return null;
  return typeof ctx.now === 'function' ? ctx.now() : ctx.now;
}

module.exports = {
  fixedClock: fixedClock,
  nowOf: nowOf
};
