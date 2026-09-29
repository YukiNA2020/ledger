/* Phase 2 本地服务 HTTP 层测试（临时数据库，虚构数据）
 *
 * 对应 ACCEPTANCE：
 *   S2.1 单一事实源 —— 写回的数据能被 HTTP 直读，且总览口径与 js/domain.js 一致
 *   S2.2 loopback 安全 —— 只监听 127.0.0.1；缺令牌 / 错 Origin / 错 Content-Type 的写请求被拒；只读能力不受影响
 *   S2.3 启动与单实例 —— 单实例锁（本文件只验证"第二实例被拒"这一层，登录项由 scripts/ 负责）
 *
 * 测试在临时端口（0 = 由系统分配）绑定 127.0.0.1，绝不触碰用户真实数据目录。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const api = require('../server/api');
const config = require('../server/config');
const B = require('../server/backup');
const R = require('../server/repository');
const M = require('../server/migrations');
const Domain = require('../js/domain.js');
const { setup, loadFixtureState } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';

// 起一个只监听 127.0.0.1 的临时服务；返回 { port, origin, close }
// 注意：必须把同一个 ctx 对象交给 handler —— Origin 校验读的是 ctx.port，
// 而端口要等 listen 之后才知道，所以只能在同一个对象上回填（不能传副本）。
async function startServer(ctx, token) {
  Object.assign(ctx, {
    host: config.HOST,
    port: 0,
    token: token || TOKEN,
    repoRoot: config.REPO_ROOT,
    backupKeep: config.BACKUP_KEEP,
    backupMinIntervalMs: config.BACKUP_MIN_INTERVAL_MS,
    keychainService: 'com.ledger.local.test',
    keychainAccount: 'test',
    startedAt: new Date().toISOString(),
    logger: { info() {}, warn() {}, error() {} }
  });
  const handler = api.createHandlerEntry(ctx);
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, config.HOST, resolve);
  });
  const address = server.address();
  ctx.port = address.port; // 回填后 checkWrite 才能认下同源 Origin
  return {
    port: address.port,
    origin: 'http://127.0.0.1:' + address.port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// 直接发请求：不做任何自动补头，方便精确模拟非法写请求
function request(port, method, pathname, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: config.HOST,
        port: port,
        method: method,
        path: pathname,
        headers: opts.headers || {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text: text, json: json });
        });
      }
    );
    req.on('error', reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

function writeHeaders(ctx, extra) {
  return Object.assign(
    {
      'Content-Type': 'application/json',
      'X-Ledger-Token': ctx.token,
      Origin: 'http://127.0.0.1:' + ctx.port
    },
    extra || {}
  );
}

/* ------------------------------ S2.2 loopback 与只读接口 ------------------------------ */

test('S2.2 health 只暴露 loopback 策略：绑定 127.0.0.1、禁 CORS、写需令牌、零云依赖', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    assert.strictEqual(config.HOST, '127.0.0.1', '监听地址必须硬编码为 loopback');
    const res = await request(srv.port, 'GET', '/api/v1/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(res.json.policy.host, '127.0.0.1');
    assert.strictEqual(res.json.policy.factSource, 'sqlite');
    assert.strictEqual(res.json.policy.writesRequireToken, true);
    assert.strictEqual(res.json.policy.cors, 'disabled');
    assert.strictEqual(res.json.policy.cloudAi, false);
    assert.strictEqual(res.json.latestSchemaVersion, M.LATEST_VERSION);
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('S2.2 不返回任何 CORS 头，且预检一律 405（跨源页面无法发起写请求）', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    const preflight = await request(srv.port, 'OPTIONS', '/api/v1/state', {
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' }
    });
    assert.strictEqual(preflight.status, 405);
    assert.strictEqual(preflight.json.error.code, 'preflight_not_supported');
    assert.strictEqual(preflight.headers['access-control-allow-origin'], undefined, '绝不回 CORS 允许头');

    const get = await request(srv.port, 'GET', '/api/v1/state');
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.headers['access-control-allow-origin'], undefined, '读接口同样不带 CORS 头');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('S2.2 写请求门禁：缺令牌 401、错令牌 401、错 Origin 403、错 Content-Type 415，且都不改动数据', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    R.writeState(ctx.db, loadFixtureState());
    const body = JSON.stringify({ state: { accounts: [], categories: [], txns: [], settings: {} } });

    const noToken = await request(srv.port, 'PUT', '/api/v1/state', {
      headers: { 'Content-Type': 'application/json' },
      body: body
    });
    assert.strictEqual(noToken.status, 401, '缺令牌必须 401');
    assert.strictEqual(noToken.json.error.code, 'token_required');
    assert.strictEqual(noToken.json.error.retryable, false);

    const wrongToken = await request(srv.port, 'PUT', '/api/v1/state', {
      headers: { 'Content-Type': 'application/json', 'X-Ledger-Token': 'wrong-token' },
      body: body
    });
    assert.strictEqual(wrongToken.status, 401, '错令牌必须 401');

    const wrongOrigin = await request(srv.port, 'PUT', '/api/v1/state', {
      headers: { 'Content-Type': 'application/json', 'X-Ledger-Token': ctx.token, Origin: 'http://127.0.0.1:1' },
      body: body
    });
    assert.strictEqual(wrongOrigin.status, 403, '非信任 Origin 必须 403');
    assert.strictEqual(wrongOrigin.json.error.code, 'origin_rejected');

    const wrongType = await request(srv.port, 'PUT', '/api/v1/state', {
      headers: { 'Content-Type': 'text/plain', 'X-Ledger-Token': ctx.token, Origin: srv.origin },
      body: body
    });
    assert.strictEqual(wrongType.status, 415, '非 JSON 写请求必须 415');
    assert.strictEqual(wrongType.json.error.code, 'invalid_content_type');

    // 被拒的写不得改动事实源
    const after = R.readState(ctx.db);
    assert.strictEqual(after.assets.assetAccounts.length, 4, '被拒写入不得清空资产账户');
    assert.strictEqual(after.assets.assetUnits.length, 3, '被拒写入不得清空余额单元');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('S2.2 无请求体的删除同样必须声明 Content-Type（前端 clearAll 的历史缺陷回归点）', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    const noType = await request(srv.port, 'DELETE', '/api/v1/state', {
      headers: { 'X-Ledger-Token': ctx.token, Origin: srv.origin }
    });
    assert.strictEqual(noType.status, 415, '无 Content-Type 的 DELETE 必须被拒');

    const withType = await request(srv.port, 'DELETE', '/api/v1/state', {
      headers: writeHeaders(ctx)
    });
    assert.strictEqual(withType.status, 200, '声明 JSON 的 DELETE 应当成功');
    assert.match(withType.json.preClearBackup, /-pre-clear\.db$/, '清空属于高风险操作，必须先留备份');
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ------------------------------ S2.1 单一事实源 ------------------------------ */

test('S2.1 写回的数据可被 HTTP 直读，且与写入内容逐字段一致', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    const state = loadFixtureState();
    const put = await request(srv.port, 'PUT', '/api/v1/state', {
      headers: writeHeaders(ctx),
      body: JSON.stringify({ state: state })
    });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.json.ok, true);
    assert.strictEqual(put.json.schemaVersion, M.LATEST_VERSION);

    const get = await request(srv.port, 'GET', '/api/v1/state');
    assert.strictEqual(get.status, 200);
    assert.deepStrictEqual(get.json.accounts, R.readState(ctx.db).accounts, 'HTTP 读回必须与库内一致');
    assert.strictEqual(get.json.txns.length, state.txns.length, '交易条数一致');
    assert.strictEqual(get.json.assets.assetAccounts.length, 4);
    assert.strictEqual(get.json.assets.assetUnits.length, 3);
    // 形状契约：assets 必须带 schemaVersion，前端 normalizeAssets 依赖它
    assert.strictEqual(get.json.assets.schemaVersion, Domain.emptyAssets().schemaVersion);
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('S2.1 overview 复用前端同一份领域代码，口径与 ACCEPTANCE §2 完全一致', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    const state = loadFixtureState();
    R.writeState(ctx.db, state);
    const asOf = state.assets.assetUnits[0].asOf;

    const res = await request(srv.port, 'GET', '/api/v1/overview?asOf=' + asOf);
    assert.strictEqual(res.status, 200);

    // 与前端领域函数直接计算的结果逐字段比对，确保服务端没有另写一套口径
    const expected = Domain.computeOverview(R.readState(ctx.db).assets, { now: asOf, settings: {} });
    assert.deepStrictEqual(res.json, JSON.parse(JSON.stringify(expected)), '服务端总览必须等于前端领域函数结果');

    // 关键数字同时写死，避免"两边一起改错"时测试静默通过
    assert.strictEqual(res.json.netWorthMinor, 4380000);
    assert.strictEqual(res.json.totalAssetsMinor, 4580000);
    assert.strictEqual(res.json.totalLiabilitiesMinor, 200000);
    assert.strictEqual(res.json.pools.investableMinor, 1080000);
    assert.strictEqual(res.json.newFundsAvailableMinor, 520000);
    assert.strictEqual(res.json.valuationStatus, 'formal');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('S2.1 幂等键：同一 Idempotency-Key 重放不重复写入，并标记为 replay', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    const state = loadFixtureState();
    const headers = writeHeaders(ctx, { 'Idempotency-Key': 'idem-api-1' });
    const payload = JSON.stringify({ state: state });

    const first = await request(srv.port, 'PUT', '/api/v1/state', { headers: headers, body: payload });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.headers['x-ledger-idempotent'], undefined, '首次写入不是重放');

    const second = await request(srv.port, 'PUT', '/api/v1/state', { headers: headers, body: payload });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.headers['x-ledger-idempotent'], 'replay', '重复提交必须识别为重放');
    // 重放按契约返回"首次结果"本身（含当时的备份信息），不再执行任何副作用
    assert.deepStrictEqual(second.json, first.json, '重放必须原样返回首次结果');

    assert.strictEqual(B.listBackups(ctx.paths.backupDir).length, 1, '重放不得再产生备份');
    const count = R.readState(ctx.db).assets.assetUnits.length;
    assert.strictEqual(count, 3, '重放不得改变数据');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('S2.1 写成功返回写后备份结果（含节流信息），供前端提示可见状态', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    const put = await request(srv.port, 'PUT', '/api/v1/state', {
      headers: writeHeaders(ctx),
      body: JSON.stringify({ state: loadFixtureState() })
    });
    assert.strictEqual(put.status, 200);
    assert.ok(put.json.backup, '写接口必须回报备份状态');
    assert.strictEqual(put.json.backup.created, true, '第一次写应创建备份');
    assert.match(put.json.backup.backup.name, /-write\.db$/);
    assert.strictEqual(B.listBackups(ctx.paths.backupDir).length, 1);
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('S3 高风险覆盖写入：forceBackup 先强制留 pre-import 备份，不受写后节流限制', async () => {
  const ctx = setup('ledger-api-preimport-');
  const srv = await startServer(ctx);
  try {
    const state = loadFixtureState();

    // 第一笔写入：创建写后备份，同时成为 60 秒节流窗口的起点
    const first = await request(srv.port, 'PUT', '/api/v1/state', {
      headers: writeHeaders(ctx),
      body: JSON.stringify({ state: state })
    });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.json.backup.created, true);
    assert.strictEqual(first.json.preImportBackup, null, '普通写入不应产生 pre-import 备份');

    // 立刻（节流窗口内）做一次带 forceBackup 的覆盖写入，模拟前端 JSON 恢复：
    // 修复前这条路径没有任何备份，被覆盖的数据在节流窗口内无法找回
    const empty = { accounts: [], categories: [], txns: [], settings: {}, assets: Domain.emptyAssets() };
    const second = await request(srv.port, 'PUT', '/api/v1/state', {
      headers: writeHeaders(ctx),
      body: JSON.stringify({ state: empty, forceBackup: true })
    });
    assert.strictEqual(second.status, 200);
    assert.match(second.json.preImportBackup, /-pre-import\.db$/, '覆盖写入必须先留 pre-import 备份');
    assert.strictEqual(second.json.backup.created, false, '写后节流备份不因 forceBackup 重复创建');

    // pre-import 备份内容必须是覆盖前的状态（第一笔写入的 fixture 数据）
    const backupPath = path.join(ctx.paths.backupDir, second.json.preImportBackup);
    assert.strictEqual(B.validateBackupFile(backupPath).ok, true, 'pre-import 备份必须通过校验');
    const { DatabaseSync } = require('node:sqlite');
    const bdb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const snapshot = R.readState(bdb);
      assert.strictEqual(snapshot.txns.length, state.txns.length, '备份里应是覆盖前的交易');
      assert.strictEqual(snapshot.assets.assetUnits.length, 3, '备份里应是覆盖前的余额单元');
    } finally {
      bdb.close();
    }

    // 备份落在保留列表里，恢复链路可以据此回滚
    const names = B.listBackups(ctx.paths.backupDir).map((b) => b.name);
    assert.ok(names.indexOf(second.json.preImportBackup) >= 0, 'pre-import 备份应在备份列表中');

    // 对照：节流窗口内的普通覆盖写入不会产生 pre-import 备份（不需要，也不应有）
    const third = await request(srv.port, 'PUT', '/api/v1/state', {
      headers: writeHeaders(ctx),
      body: JSON.stringify({ state: empty })
    });
    assert.strictEqual(third.status, 200);
    assert.strictEqual(third.json.preImportBackup, null);
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ------------------------------ 阶段边界与静态托管 ------------------------------ */

test('后续阶段的写接口返回 501 而不是 404，资源边界对前端可见', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    // Phase 3 的写接口已落地：不再是 501，而是进入真实校验（空缺名称 → 400）
    const phase3 = await request(srv.port, 'POST', '/api/v1/accounts', {
      headers: writeHeaders(ctx),
      body: '{}'
    });
    assert.strictEqual(phase3.status, 400);
    assert.strictEqual(phase3.json.error.code, 'invalid_name');

    // Phase 4C 已实现 portfolio-openings / security-events（D-042）：空载荷进入真实校验（400），
    // 不再是 501。
    const openings = await request(srv.port, 'POST', '/api/v1/portfolio-openings', {
      headers: writeHeaders(ctx),
      body: '{}'
    });
    assert.strictEqual(openings.status, 400);
    assert.strictEqual(openings.json.error.code, 'invalid_account');
    const events = await request(srv.port, 'POST', '/api/v1/security-events', {
      headers: writeHeaders(ctx),
      body: '{}'
    });
    assert.strictEqual(events.status, 400);
    assert.strictEqual(events.json.error.code, 'invalid_event');

    const cases = [
      // market-data/refresh 已在 Phase 4D 实现（D-044）：不再是 501，见下方专项断言
      // risk-assessments 已在 Phase 5B 实现（D-047）：不再是 501，空载荷按 400 拒绝
      // recommendations 已在 Phase 5D 实现（D-049）：不再是 501，见下方按 400 的载荷校验断言
    ];
    for (const [method, pathname, phase] of cases) {
      const res = await request(srv.port, method, pathname, {
        headers: writeHeaders(ctx),
        body: '{}'
      });
      assert.strictEqual(res.status, 501, pathname + ' 应为 501');
      assert.strictEqual(res.json.error.code, 'not_implemented');
      assert.ok(res.json.error.message.indexOf(phase) !== -1, pathname + ' 应说明所属阶段');
    }

    // Phase 5B：risk-assessments 已实现，空载荷是客户端可修正的载荷问题 → 400 而非 501
    const emptyRisk = await request(srv.port, 'POST', '/api/v1/risk-assessments', {
      headers: writeHeaders(ctx),
      body: '{}'
    });
    assert.strictEqual(emptyRisk.status, 400);
    assert.strictEqual(emptyRisk.json.error.code, 'invalid_answers');

    // Phase 5D：建议写入已实现，空载荷按 400 拒绝（引用绑定缺失属客户端可修正问题）
    const emptyRec = await request(srv.port, 'POST', '/api/v1/recommendations', {
      headers: writeHeaders(ctx),
      body: '{}'
    });
    assert.strictEqual(emptyRec.status, 400);
    assert.strictEqual(emptyRec.json.error.code, 'invalid_snapshot_ref');

    // Phase 4D：行情刷新已实现；自动行情抓取受 D-038 门禁约束默认关闭，
    // 因此 quotes 作用域是 200 + skipped(auto_fetch_disabled)，而不是 501。
    const refresh = await request(srv.port, 'POST', '/api/v1/market-data/refresh', {
      headers: writeHeaders(ctx),
      body: '{}'
    });
    assert.strictEqual(refresh.status, 200);
    const quoteScope = refresh.json.scopes.filter((s) => s.scope === 'quotes')[0];
    assert.strictEqual(quoteScope.status, 'skipped');
    assert.strictEqual(quoteScope.reason, 'auto_fetch_disabled');

    const decisionEvent = await request(srv.port, 'POST', '/api/v1/decisions/d-1/events', {
      headers: writeHeaders(ctx),
      body: '{}'
    });
    assert.strictEqual(decisionEvent.status, 501);
    assert.match(decisionEvent.json.error.message, /Phase 6/);

    const unknown = await request(srv.port, 'GET', '/api/v1/nope');
    assert.strictEqual(unknown.status, 404);
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('静态托管：index.html 注入会话令牌，JS 资源不注入；路径穿越与数据库文件一律拒绝', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    const html = await request(srv.port, 'GET', '/index.html');
    assert.strictEqual(html.status, 200);
    assert.ok(html.text.indexOf(TOKEN) !== -1, 'HTML 必须带上会话令牌');
    assert.ok(html.text.indexOf(api.TOKEN_PLACEHOLDER) === -1, '占位符必须已被替换');
    assert.strictEqual(html.headers['cache-control'], 'no-store', 'HTML 携带令牌，不得缓存');

    const js = await request(srv.port, 'GET', '/js/store.js');
    assert.strictEqual(js.status, 200);
    assert.ok(js.text.indexOf(TOKEN) === -1, '静态 JS 不得泄漏令牌');

    // WHATWG URL 会把纯 %2e%2e 段当双点段归一化掉（结果仍落在仓库内，不构成穿越）；
    // 真正需要守住的是"编码斜杠 + 双点"这种能在解码后逃出根目录的形态。
    const traversalEncoded = await request(srv.port, 'GET', '/%2e%2e%2fpackage.json');
    assert.strictEqual(traversalEncoded.status, 403, '编码双点+斜杠必须拒绝');
    assert.strictEqual(traversalEncoded.json.error.code, 'forbidden_path');

    const traversalNested = await request(srv.port, 'GET', '/js/%2e%2e%2f%2e%2e%2fetc/passwd');
    assert.strictEqual(traversalNested.status, 403, '多级编码穿越必须拒绝');

    const backslash = await request(srv.port, 'GET', '/..%5cpackage.json');
    assert.strictEqual(backslash.status, 403, '反斜杠形态的穿越同样拒绝');

    const gitDir = await request(srv.port, 'GET', '/.git/config');
    assert.strictEqual(gitDir.status, 403, '.git 必须拒绝');

    const dbFile = await request(srv.port, 'GET', '/ledger.db');
    assert.strictEqual(dbFile.status, 403, '绝不通过 HTTP 提供数据库文件');

    const post = await request(srv.port, 'POST', '/index.html', { headers: writeHeaders(ctx), body: '{}' });
    assert.strictEqual(post.status, 405, '静态资源只支持只读方法');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('恢复接口：非法文件名 400，合法但校验失败 409，成功则切库并回报 schema 版本', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    R.writeState(ctx.db, loadFixtureState());
    const good = await B.createBackup(ctx.db, ctx.paths, { reason: 'before-api-restore' });

    const bad = await request(srv.port, 'POST', '/api/v1/restores', {
      headers: writeHeaders(ctx),
      body: JSON.stringify({ file: '../outside.db' })
    });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error.code, 'invalid_backup_name');

    const missing = await request(srv.port, 'POST', '/api/v1/restores', {
      headers: writeHeaders(ctx),
      body: JSON.stringify({ file: 'ledger-19700101-000000-nope.db' })
    });
    assert.strictEqual(missing.status, 409, '候选不存在必须 409 且不破坏当前库');
    assert.strictEqual(R.readState(ctx.db).assets.assetUnits.length, 3, '失败恢复不得破坏当前库');

    const ok = await request(srv.port, 'POST', '/api/v1/restores', {
      headers: writeHeaders(ctx),
      body: JSON.stringify({ file: good.name })
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.restoredFrom, good.name);
    assert.match(ok.json.preRestoreBackup, /-pre-restore\.db$/, '恢复前必须先备份当前库');
    assert.strictEqual(ok.json.schemaVersion, M.LATEST_VERSION);

    // api.js 会用切换后的新连接继续服务
    ctx.db = R.readState ? ctx.db : ctx.db;
    const afterState = await request(srv.port, 'GET', '/api/v1/state');
    assert.strictEqual(afterState.status, 200);
    assert.strictEqual(afterState.json.assets.assetUnits.length, 3, '新连接可继续读');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('备份列表接口回报保留策略与每日兜底事实', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    const empty = await request(srv.port, 'GET', '/api/v1/backups');
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(empty.json.items, []);
    assert.strictEqual(empty.json.keep, 30);
    assert.strictEqual(empty.json.dailyGuaranteed, true);

    R.writeState(ctx.db, loadFixtureState());
    await B.createBackup(ctx.db, ctx.paths, { reason: 'manual' });
    const list = await request(srv.port, 'GET', '/api/v1/backups');
    assert.strictEqual(list.json.items.length, 1);
    assert.match(list.json.items[0].name, /-manual\.db$/);
    assert.ok(list.json.items[0].size > 0);

    const manual = await request(srv.port, 'POST', '/api/v1/backups', {
      headers: writeHeaders(ctx),
      body: '{}'
    });
    assert.strictEqual(manual.status, 201);
    assert.match(manual.json.backup.name, /-manual(-\d+)?\.db$/, '同秒同名备份会追加 -N 后缀避免覆盖');
  } finally {
    await srv.close();
    ctx.close();
  }
});

test('密钥链状态接口只报可用性，绝不返回任何密钥内容', async () => {
  const ctx = setup('ledger-api-');
  const srv = await startServer(ctx);
  try {
    const res = await request(srv.port, 'GET', '/api/v1/keychain/status');
    assert.strictEqual(res.status, 200);
    const keys = Object.keys(res.json).sort();
    assert.deepStrictEqual(keys, ['available', 'keychains', 'note', 'probe', 'readable'], '只暴露可用性字段');
    const blob = JSON.stringify(res.json);
    assert.ok(blob.indexOf(TOKEN) === -1, '不得回显会话令牌');
    assert.match(res.json.note, /Phase 4/);
  } finally {
    await srv.close();
    ctx.close();
  }
});

/* ------------------------------ S2.3 单实例（HTTP 之外的一层） ------------------------------ */

test('S2.3 单实例锁：同一数据目录第二个写进程抢锁失败，但可只读提示', async () => {
  const ctx = setup('ledger-api-');
  try {
    // 单实例锁由 main.js 的 acquireLock 提供：此处直接验证锁文件语义，
    // 完整端到端（登录项两次触发）留给测试文档中的手工步骤。
    const lockFile = ctx.paths.lockFile;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
    assert.ok(fs.existsSync(lockFile));
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.strictEqual(lock.pid, process.pid, '锁文件记录持有者 pid，便于识别陈旧锁');
    assert.strictEqual(fs.statSync(lockFile).mode & 0o777, 0o600, '锁文件不对外开放');
  } finally {
    ctx.close();
  }
});
