/* 小账本 server/keychain.js — macOS Keychain 适配器（Phase 2 建立，Phase 4 使用）
 *
 * 依据 ARCHITECTURE §8：API Key 使用 macOS Keychain，日志中必须脱敏。
 *
 * 硬约束：
 *   - 密钥值绝不进入命令行参数（argv 可被 ps 看到），写入时通过 stdin 传递；
 *   - 读取结果只返回给调用方，本模块不打印、不记录密钥内容；
 *   - API Key 不入库、不进前端、不进测试 fixture（AGENTS.md）。
 *
 * §13 门禁：本模块提供 selfCheck() 用于验证"可从 Keychain 读取测试密钥"的读取路径。
 */
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SECURITY_BIN = '/usr/bin/security';
const NOT_FOUND_CODES = new Set([44, 45]); // errSecItemNotFound 及其变体

function securityPath() {
  return fs.existsSync(SECURITY_BIN) ? SECURITY_BIN : null;
}

function runSecurity(args, input) {
  const bin = securityPath();
  if (!bin) return { ok: false, code: null, stdout: '', stderr: 'security 不可用（非 macOS？）' };
  try {
    const stdout = execFileSync(bin, args, {
      input: input == null ? undefined : input,
      encoding: 'utf8',
      stdio: input == null ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      // 关键：脱离控制终端。否则当调用方持有 TTY（如终端里跑测试）时，
      // `security add-generic-password -w`（空值）会忽略 stdin、改为在 /dev/tty 上
      // 交互式提示 "password data for new item:" 并挂死；无 TTY 时才读 stdin。
      // detached 让子进程另起会话、拿不到 /dev/tty，stdin 通道成为确定性路径。
      detached: process.platform !== 'win32',
      timeout: 10000
    });
    return { ok: true, code: 0, stdout: stdout == null ? '' : stdout, stderr: '' };
  } catch (err) {
    const stderr = (err && err.stderr) || '';
    const code = typeof (err && err.status) === 'number' ? err.status : null;
    return { ok: false, code: code, stdout: (err && err.stdout) || '', stderr: stderr };
  }
}

function isNotFound(result) {
  if (result.ok) return false;
  if (NOT_FOUND_CODES.has(result.code)) return true;
  return /could not be found|item not found/i.test(String(result.stderr || ''));
}

// 读取密钥；不存在返回 null（不抛异常）。返回值只应交给调用方使用，不得打印。
function readSecret(service, account) {
  const args = ['find-generic-password', '-s', String(service)];
  if (account != null) args.push('-a', String(account));
  args.push('-w');
  const result = runSecurity(args);
  if (result.ok) return result.stdout.replace(/\n$/, '');
  if (isNotFound(result)) return null;
  throw new Error('读取 Keychain 失败：' + String(result.stderr || '').trim());
}

function hasSecret(service, account) {
  const args = ['find-generic-password', '-s', String(service)];
  if (account != null) args.push('-a', String(account));
  const result = runSecurity(args);
  if (result.ok) return true;
  if (isNotFound(result)) return false;
  throw new Error('查询 Keychain 失败：' + String(result.stderr || '').trim());
}

// 写入密钥：值通过 stdin 传递两次（password + retype），不出现在 argv 中
function writeSecret(service, account, secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('密钥不能为空');
  const args = ['add-generic-password', '-U', '-s', String(service)];
  if (account != null) args.push('-a', String(account));
  args.push('-w');
  const result = runSecurity(args, secret + '\n' + secret + '\n');
  if (!result.ok) throw new Error('写入 Keychain 失败：' + String(result.stderr || '').trim());
  return true;
}

function deleteSecret(service, account) {
  const args = ['delete-generic-password', '-s', String(service)];
  if (account != null) args.push('-a', String(account));
  const result = runSecurity(args);
  if (result.ok) return true;
  if (isNotFound(result)) return false;
  throw new Error('删除 Keychain 失败：' + String(result.stderr || '').trim());
}

// 启动自检：只验证"能不能读"，不创建任何条目，也不返回密钥内容
function selfCheck(service, account) {
  const bin = securityPath();
  if (!bin) return { available: false, readable: false, reason: 'security 不可用' };
  const list = runSecurity(['list-keychains']);
  const readable = list.ok && String(list.stdout).trim().length > 0;
  let probe = { status: 'skipped' };
  if (readable && service) {
    const args = ['find-generic-password', '-s', String(service)];
    if (account != null) args.push('-a', String(account));
    const result = runSecurity(args);
    probe = result.ok
      ? { status: 'found' }
      : isNotFound(result)
        ? { status: 'not-found' }
        : { status: 'error', reason: String(result.stderr || '').trim() };
  }
  return {
    available: true,
    readable: readable,
    keychains: readable ? String(list.stdout).trim().split('\n').length : 0,
    probe: probe
  };
}

module.exports = {
  SECURITY_BIN,
  securityPath,
  readSecret,
  hasSecret,
  writeSecret,
  deleteSecret,
  selfCheck
};
