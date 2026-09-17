/* 小账本 server/providers/keychain-key.js — 行情 provider 的 API Key 读取路径（Phase 4D）
 *
 * 依据 ARCHITECTURE §8 与 AGENTS.md 的硬约束：
 *   - Key 只从 macOS Keychain 读取，**绝不**进入 argv、数据库、前端或日志；
 *   - 读取是**惰性**的：只有真的要发起自动抓取时才调用，门禁关闭时一次都不读；
 *   - 本模块只返回"有没有配好"这种布尔状态供接口展示，绝不返回密钥内容，也不打印。
 *
 * 服务名固定（可用环境变量覆盖，便于本机与测试）；账号名可选（留空表示不限定账号）。
 * 密钥不存在时返回 null，由调用方降级为「未配置」，而不是抛错打断刷新流程。
 */
'use strict';

const keychain = require('../keychain');

const DEFAULT_SERVICE = 'ledger.market-data.twelvedata'; // D-037 选定的参考数据来源
const SERVICE_ENV = 'LEDGER_MARKET_DATA_KEY_SERVICE';
const ACCOUNT_ENV = 'LEDGER_MARKET_DATA_KEY_ACCOUNT';

function serviceName(env) {
  const e = env || process.env;
  const v = e && e[SERVICE_ENV] ? String(e[SERVICE_ENV]).trim() : '';
  return v || DEFAULT_SERVICE;
}

function accountName(env) {
  const e = env || process.env;
  const v = e && e[ACCOUNT_ENV] ? String(e[ACCOUNT_ENV]).trim() : '';
  return v || null;
}

// 读取密钥；不存在返回 null。返回值只应交给 provider 使用，不得打印、不得落盘。
function readProviderKey(options) {
  const opts = options || {};
  const reader = opts.readSecret || keychain.readSecret;
  return reader(serviceName(opts.env), accountName(opts.env)) || null;
}

// 只报告状态（不含密钥内容）。供 /api/v1/health 之类接口显示"是否已配置"。
function providerKeyStatus(options) {
  const opts = options || {};
  const has = opts.hasSecret || keychain.hasSecret;
  let configured = false;
  let error = null;
  try {
    configured = has(serviceName(opts.env), accountName(opts.env)) === true;
  } catch (e) {
    // Keychain 不可用（非 macOS / 被锁）时按"未配置"处理，并给出可见但不含敏感信息的原因
    error = 'keychain_unavailable';
  }
  return {
    configured: configured,
    service: serviceName(opts.env),
    error: error
  };
}

module.exports = {
  DEFAULT_SERVICE: DEFAULT_SERVICE,
  SERVICE_ENV: SERVICE_ENV,
  ACCOUNT_ENV: ACCOUNT_ENV,
  serviceName: serviceName,
  accountName: accountName,
  readProviderKey: readProviderKey,
  providerKeyStatus: providerKeyStatus
};
