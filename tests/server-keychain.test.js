/* 小账本 tests/server-keychain.test.js — Keychain 适配器回归（Phase 2 补充验收）
 *
 * 覆盖补充验收缺口「Keychain 测试密钥真实读取」：
 *   写入（stdin，不进 argv）→ 真实回读一致 → hasSecret/selfCheck 探测 → 删除 → 确认无残留。
 *
 * 仅在 macOS 且 /usr/bin/security 可用时执行；其他平台整文件跳过。
 * 使用独立服务名 com.ledger.local.selfcheck-test，不触碰真实 marketdata 条目；
 * 测试结束（含失败路径）都会尽力删除测试条目，不留残留。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const keychain = require('../server/keychain');

const SERVICE = 'com.ledger.local.selfcheck-test';
const ACCOUNT = 'default';

const canRun = process.platform === 'darwin' && keychain.securityPath() != null;

test('Keychain 写入→真实读取→探测→删除 全链路（macOS）', { skip: !canRun }, () => {
  // 前置清理：防止上次异常中断留下残留
  try { keychain.deleteSecret(SERVICE, ACCOUNT); } catch (_) { /* 不存在时忽略 */ }

  const secret = 'ledger-selftest-' + crypto.randomBytes(16).toString('hex');
  try {
    // 写入（值经 stdin 传递，不出现在 argv）
    keychain.writeSecret(SERVICE, ACCOUNT, secret);

    // 真实读取：回读值必须与写入值逐字节一致
    const readBack = keychain.readSecret(SERVICE, ACCOUNT);
    assert.strictEqual(readBack, secret, '回读密钥必须与写入一致');

    // 覆盖写入（-U upsert）后回读新值
    const secret2 = secret + '-v2';
    keychain.writeSecret(SERVICE, ACCOUNT, secret2);
    assert.strictEqual(keychain.readSecret(SERVICE, ACCOUNT), secret2, '覆盖写入后应读到新值');

    // 存在性探测
    assert.strictEqual(keychain.hasSecret(SERVICE, ACCOUNT), true);

    // selfCheck 应报告 found（这正是 /api/v1/keychain/status 的 probe 字段来源）
    const probe = keychain.selfCheck(SERVICE, ACCOUNT);
    assert.strictEqual(probe.available, true);
    assert.strictEqual(probe.readable, true);
    assert.strictEqual(probe.probe.status, 'found');
  } finally {
    keychain.deleteSecret(SERVICE, ACCOUNT);
  }

  // 删除后读取为 null，探测为 not-found，不留残留
  assert.strictEqual(keychain.readSecret(SERVICE, ACCOUNT), null);
  assert.strictEqual(keychain.hasSecret(SERVICE, ACCOUNT), false);
  assert.strictEqual(keychain.selfCheck(SERVICE, ACCOUNT).probe.status, 'not-found');
});

test('Keychain 读取不存在的条目返回 null 而不抛异常', { skip: !canRun }, () => {
  assert.strictEqual(keychain.readSecret('com.ledger.local.never-exists', 'nobody'), null);
  assert.strictEqual(keychain.hasSecret('com.ledger.local.never-exists', 'nobody'), false);
  assert.strictEqual(keychain.deleteSecret('com.ledger.local.never-exists', 'nobody'), false);
});
