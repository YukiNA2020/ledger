/* Phase 5B｜风险评估与复评机制端到端测试（临时数据库，虚构数据，真实 HTTP 入口）
 *
 * 对应 PHASE5_BREAKDOWN §5.4 的服务端部分：
 *   - POST /risk-assessments 只受理原始答案/评估日期/复评原因；服务端用 5A 唯一领域函数
 *     重算全部派生值后落库（D-025/D-047），客户端提交的派生字段在入口即 400 拒绝；
 *   - 追加式历史：同一答案重复提交生成新行、绝不覆盖；Idempotency-Key 重放不产生第二行，
 *     同键不同载荷 409；
 *   - GET /risk-assessments 与 /risk-assessments/current：确定性排序与「当前有效评估」由
 *     注入时钟（ctx.today）驱动，绝不采信客户端时钟；
 *   - PUT /state 全量写入：合法记录逐条重算核对、伪造记录整体拒绝且原数据不动、
 *     缺键清空（旧备份恢复语义）、同 id 重复 409；
 *   - 备份/恢复往返保留 v8 risk_assessments 表；缺令牌写请求 403。
 * 全部离线：固定注入 today/nowIso，零真实网络（AGENTS.md）。
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
const Domain = require('../js/domain.js');
const { setup } = require('./server-helpers');

const TOKEN = 'test-session-token-0123456789abcdef';
const TODAY = '2026-06-15';
const EXPIRY = '2027-06-15';
const NOW_ISO = '2026-06-15T08:00:00.000Z';

async function startServer(ctx) {
  Object.assign(ctx, {
    host: config.HOST,
    port: 0,
    token: TOKEN,
    repoRoot: config.REPO_ROOT,
    backupKeep: config.BACKUP_KEEP,
    backupMinIntervalMs: config.BACKUP_MIN_INTERVAL_MS,
    keychainService: 'com.ledger.local.test',
    keychainAccount: 'test',
    startedAt: NOW_ISO,
    today: () => TODAY,
    nowIso: () => NOW_ISO,
    logger: { info() {}, warn() {}, error() {} }
  });
  const server = http.createServer(api.createHandlerEntry(ctx));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, config.HOST, resolve);
  });
  const port = server.address().port;
  ctx.port = port;
  return {
    port: port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function request(port, method, pathname, opts) {
  const o = opts || {};
  const headers = Object.assign(
    { Origin: 'http://127.0.0.1:' + port },
    o.token === false ? {} : { 'X-Ledger-Token': TOKEN },
    o.headers || {}
  );
  let payload = null;
  if (o.body != null) {
    payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: config.HOST, port, method, path: pathname, headers }, (res) => {
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
        resolve({ status: res.statusCode, headers: res.headers, json: json });
      });
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const post = (port, pathname, body, opts) => request(port, 'POST', pathname, Object.assign({ body }, opts || {}));

/* 客户端载荷：只有题目 → 选项 的原始事实（与页面 store 提交的形状一致） */
function clientAnswers(capScores, wilScores) {
  const cap = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'capacity');
  const wil = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'willingness');
  const pick = (q, s) => q.options.filter((o) => o.score === s)[0].id;
  const rows = [];
  capScores.forEach((s, i) => rows.push({ questionId: cap[i].id, optionId: pick(cap[i], s) }));
  wilScores.forEach((s, i) => rows.push({ questionId: wil[i].id, optionId: pick(wil[i], s) }));
  return rows;
}

function payload(overrides) {
  return Object.assign(
    { answers: clientAnswers([3, 3, 3, 2, 2], [3, 3, 2, 3]), assessedAt: TODAY, reason: 'initial' },
    overrides || {}
  );
}

/* ------------------------------ 写入：服务端重算是唯一口径 ------------------------------ */

test('POST /risk-assessments：受理原始答案，落库的派生值必须等于服务端重算结果', async () => {
  const ctx = setup('ledger-p5b-');
  const srv = await startServer(ctx);
  try {
    const p = payload();
    const res = await post(srv.port, '/api/v1/risk-assessments', p);
    assert.strictEqual(res.status, 201, JSON.stringify(res.json));
    const expected = Domain.computeRiskAssessment(p, { today: TODAY });
    assert.ok(expected.ok);
    const item = res.json.item;
    assert.match(item.id, /^ra-[0-9a-f]{16}$/);
    assert.strictEqual(item.createdAt, NOW_ISO);
    assert.strictEqual(item.ruleVersion, Domain.RISK_RULE_VERSION);
    // 双评分与上限：能力 13→L5、意愿 11→L5 → equal，天花板 5；无 0 分档不触硬封顶
    assert.strictEqual(item.capacityScore, 13);
    assert.strictEqual(item.willingnessScore, 11);
    assert.strictEqual(item.ceiling, 5);
    assert.strictEqual(item.ceilingSource, 'equal');
    assert.deepStrictEqual(item.hardCaps, []);
    assert.strictEqual(item.expiry, EXPIRY);
    assert.deepStrictEqual(item, Object.assign({ id: item.id, createdAt: NOW_ISO }, expected.record));
    // 答案按冻结题序规范化，并携带重算出的冗余分值（读取时还要再核对）
    assert.strictEqual(item.answers.length, 9);
    assert.deepStrictEqual(item.answers.map((a) => a.questionId), Domain.RISK_QUESTIONS.map((q) => q.id));
    assert.ok(item.answers.every((a) => Object.keys(a).join(',') === 'questionId,optionId,score,kind,dimension'));

    const list = await request(srv.port, 'GET', '/api/v1/risk-assessments');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.items.length, 1);
    assert.deepStrictEqual(list.json.items[0], item);
    assert.strictEqual(list.json.invalidCount, 0);
    assert.strictEqual(list.json.total, 1);

    const state = await request(srv.port, 'GET', '/api/v1/state');
    assert.ok(Array.isArray(state.json.riskAssessments), 'riskAssessments 必须是 /state 顶层键');
    assert.deepStrictEqual(state.json.riskAssessments, [item]);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('客户端提交的派生值与非法载荷全部 400，且不落库（不采信、不猜默认）', async () => {
  const ctx = setup('ledger-p5b-');
  const srv = await startServer(ctx);
  try {
    const withScores = payload();
    withScores.ceiling = 5;
    withScores.capacityScore = 15;
    let res = await post(srv.port, '/api/v1/risk-assessments', withScores);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error.code, 'invalid_answers');

    const cases = [
      ['缺答', Object.assign(payload(), { answers: payload().answers.slice(0, 8) }), 'missing_answer'],
      ['未知选项', Object.assign(payload(), {
        answers: payload().answers.map((a, i) => (i === 0 ? { questionId: a.questionId, optionId: 'o_ocean_999' } : a))
      }), 'unknown_option'],
      ['未知题目', Object.assign(payload(), {
        answers: payload().answers.map((a, i) => (i === 0 ? { questionId: 'q_ghost', optionId: a.optionId } : a))
      }), 'unknown_question'],
      ['重复回答', Object.assign(payload(), {
        answers: payload().answers.map((a, i) => (i === 8 ? { questionId: a.questionId.replace(/^q_/, 'q_'), optionId: a.optionId, dup: true } : a))
      }), 'invalid_answers'],
      ['词表外复评原因', payload({ reason: 'market_move' }), 'invalid_reassess_reason'],
      ['不存在的日期', payload({ assessedAt: '2026-02-30' }), 'invalid_assessment_date'],
      ['未来评估日期（晚于服务端 today）', payload({ assessedAt: '2026-06-16' }), 'invalid_assessment_date'],
      ['answers 非数组', payload({ answers: {} }), 'invalid_answers']
    ];
    for (const [label, body, code] of cases) {
      const r = await post(srv.port, '/api/v1/risk-assessments', body);
      assert.strictEqual(r.status, 400, label + ' 应 400：' + JSON.stringify(r.json));
      assert.strictEqual(r.json.error.code, code, label);
      assert.strictEqual(r.json.error.retryable, false, label);
    }
    // 错误消息不得回显用户输入原文
    const echo = await post(srv.port, '/api/v1/risk-assessments', Object.assign(payload(), {
      answers: payload().answers.map((a, i) => (i === 0 ? { questionId: a.questionId, optionId: 'o_top_secret_xyz' } : a))
    }));
    assert.ok(echo.json.error.message.indexOf('o_top_secret_xyz') === -1, '错误消息不得回显未知选项原文');

    const list = await request(srv.port, 'GET', '/api/v1/risk-assessments');
    assert.strictEqual(list.json.items.length, 0, '任何被拒请求都不得留下记录');
  } finally {
    srv.close();
    ctx.close();
  }
});

test('幂等：同键同载荷重放不产生第二行；同键不同载荷 409；写请求缺令牌 403', async () => {
  const ctx = setup('ledger-p5b-');
  const srv = await startServer(ctx);
  try {
    const first = await post(srv.port, '/api/v1/risk-assessments', payload(), {
      headers: { 'Idempotency-Key': 'idem-p5b-1' }
    });
    assert.strictEqual(first.status, 201);
    const replay = await post(srv.port, '/api/v1/risk-assessments', payload(), {
      headers: { 'Idempotency-Key': 'idem-p5b-1' }
    });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.headers['x-ledger-idempotent'], 'replay');
    assert.deepStrictEqual(replay.json, first.json);

    const conflict = await post(srv.port, '/api/v1/risk-assessments', payload({ reason: 'manual' }), {
      headers: { 'Idempotency-Key': 'idem-p5b-1' }
    });
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.json.error.code, 'idempotency_conflict');

    const list = await request(srv.port, 'GET', '/api/v1/risk-assessments');
    assert.strictEqual(list.json.items.length, 1, '重放与冲突都不得追加');

    const noToken = await post(srv.port, '/api/v1/risk-assessments', payload(), { token: false });
    assert.strictEqual(noToken.status, 401);
    assert.strictEqual(noToken.json.error.code, 'token_required');
    const after = await request(srv.port, 'GET', '/api/v1/risk-assessments');
    assert.strictEqual(after.json.items.length, 1);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('追加式历史：再次评估生成新行，旧行原样保留（评估历史不可被覆盖）', async () => {
  const ctx = setup('ledger-p5b-');
  const srv = await startServer(ctx);
  try {
    const a = await post(srv.port, '/api/v1/risk-assessments', payload());
    const b = await post(srv.port, '/api/v1/risk-assessments',
      payload({ answers: clientAnswers([2, 2, 2, 2, 2], [2, 2, 2, 2]), reason: 'manual' }));
    assert.strictEqual(a.status, 201);
    assert.strictEqual(b.status, 201);
    assert.notStrictEqual(a.json.item.id, b.json.item.id);
    assert.notStrictEqual(b.json.item.ceiling, a.json.item.ceiling);

    const list = await request(srv.port, 'GET', '/api/v1/risk-assessments');
    assert.strictEqual(list.json.items.length, 2);
    // 同 assessedAt + 同 createdAt → id 升序（确定性排序与行序无关）
    const ids = list.json.items.map((r) => r.id);
    assert.deepStrictEqual(ids, ids.slice().sort());
    // 两条历史记录都保留原始答案（可重算的根事实）
    assert.ok(list.json.items.every((r) => r.answers.length === 9));
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ------------------------------ 只读视图：当前有效评估 ------------------------------ */

test('GET current：ctx.today 注入下选出最新有效评估；asOf 预览到期/过期，绝不采信客户端时钟', async () => {
  const ctx = setup('ledger-p5b-');
  const srv = await startServer(ctx);
  try {
    const first = await post(srv.port, '/api/v1/risk-assessments', payload());
    let cur = await request(srv.port, 'GET', '/api/v1/risk-assessments/current');
    assert.strictEqual(cur.status, 200);
    assert.strictEqual(cur.json.status, 'current');
    assert.strictEqual(cur.json.now, TODAY, '默认判定日必须是服务端本地日');
    assert.strictEqual(cur.json.current.assessment.id, first.json.item.id);
    assert.strictEqual(cur.json.current.validity.status, 'valid');
    assert.strictEqual(cur.json.invalidCount, 0);
    assert.strictEqual(cur.json.total, 1);

    // 到期日当天仍有效（预览）
    const onExpiry = await request(srv.port, 'GET', '/api/v1/risk-assessments/current?asOf=' + EXPIRY);
    assert.strictEqual(onExpiry.json.status, 'current');
    assert.strictEqual(onExpiry.json.current.validity.status, 'expiring_soon');
    // 次日过期：不再返回 current，但历史仍在（expiredRef 指明最新记录的有效期）
    const expired = await request(srv.port, 'GET', '/api/v1/risk-assessments/current?asOf=2027-06-16');
    assert.strictEqual(expired.json.status, 'all_expired');
    assert.strictEqual(expired.json.current, null);
    assert.deepStrictEqual(expired.json.expiredRef, { assessedAt: TODAY, expiry: EXPIRY });
    const list = await request(srv.port, 'GET', '/api/v1/risk-assessments');
    assert.strictEqual(list.json.items.length, 1, '过期不得删除历史');

    // 形状像日期但不存在的 asOf → fail closed 400，不猜也不回退到可疑判定
    const badAsOf = await request(srv.port, 'GET', '/api/v1/risk-assessments/current?asOf=2027-02-30');
    assert.strictEqual(badAsOf.status, 400);
    assert.strictEqual(badAsOf.json.error.code, 'invalid_assessment_date');
    const malformedAsOf = await request(srv.port, 'GET', '/api/v1/risk-assessments/current?asOf=not-a-date');
    assert.strictEqual(malformedAsOf.status, 400, '显式非法 asOf 不得静默回退到服务端今天');
    assert.strictEqual(malformedAsOf.json.error.code, 'invalid_assessment_date');

    // 空态：新数据目录下 current 报 no_assessment（不虚构默认评估）
    const fresh = await request(srv.port, 'GET', '/api/v1/state');
    assert.ok(Array.isArray(fresh.json.riskAssessments));
  } finally {
    srv.close();
    ctx.close();
  }
});

test('current 空态可区分：全部记录不可解析时返回 invalid_records + 计数', async () => {
  const ctx = setup('ledger-p5b-');
  const srv = await startServer(ctx);
  try {
    const created = await post(srv.port, '/api/v1/risk-assessments', payload());
    assert.strictEqual(created.status, 201);
    // 直接篡改库里的派生列（模拟旧库被改 / 规则漂移），读取路径必须 fail closed
    ctx.db.exec("UPDATE risk_assessments SET risk_ceiling = 1 WHERE id = '" + created.json.item.id + "'");
    const cur = await request(srv.port, 'GET', '/api/v1/risk-assessments/current');
    assert.strictEqual(cur.json.status, 'invalid_records');
    assert.strictEqual(cur.json.invalidCount, 1);
    assert.strictEqual(cur.json.current, null);
    assert.strictEqual(cur.json.total, 1);
    const history = await request(srv.port, 'GET', '/api/v1/risk-assessments');
    assert.strictEqual(history.status, 200);
    assert.deepStrictEqual(history.json.items, [], '被篡改的派生值不得作为历史评估返回给页面');
    assert.strictEqual(history.json.invalidCount, 1, '非法历史不能静默消失');
    assert.strictEqual(history.json.total, 1);
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ------------------------------ 全量写入（PUT /state / JSON 恢复） ------------------------------ */

test('PUT /state：riskAssessments 逐条重算核对；伪造与重复 id 整体拒绝且原数据不动；缺键清空', async () => {
  const ctx = setup('ledger-p5b-');
  const srv = await startServer(ctx);
  try {
    const created = await post(srv.port, '/api/v1/risk-assessments', payload());
    const rec = created.json.item;
    const base = (await request(srv.port, 'GET', '/api/v1/state')).json;

    // 合法 round-trip：原样 PUT 必须无损
    const okPut = await request(srv.port, 'PUT', '/api/v1/state', { headers: {
      'Content-Type': 'application/json', 'X-Ledger-Token': TOKEN, Origin: 'http://127.0.0.1:' + srv.port
    }, body: base });
    assert.strictEqual(okPut.status, 200, JSON.stringify(okPut.json));
    const afterOk = await request(srv.port, 'GET', '/api/v1/state');
    assert.deepStrictEqual(afterOk.json.riskAssessments, base.riskAssessments);

    // 伪造派生值：整次 PUT 拒绝，库保持原样（绝不静默丢行、绝不落一半）
    const forged = JSON.parse(JSON.stringify(base));
    forged.riskAssessments[0].ceiling = 1;
    const badPut = await request(srv.port, 'PUT', '/api/v1/state', { headers: {
      'Content-Type': 'application/json', 'X-Ledger-Token': TOKEN, Origin: 'http://127.0.0.1:' + srv.port
    }, body: forged });
    assert.ok(badPut.status >= 400 && badPut.status < 500, '伪造必须 4xx：' + badPut.status);
    assert.strictEqual(badPut.json.error.code, 'invalid_answers');
    const afterBad = await request(srv.port, 'GET', '/api/v1/state');
    assert.deepStrictEqual(afterBad.json.riskAssessments, [rec], '拒绝后库内记录不得变化');

    // 同 id 两行：duplicate_assessment
    const dup = JSON.parse(JSON.stringify(base));
    dup.riskAssessments = [rec, rec];
    const dupPut = await request(srv.port, 'PUT', '/api/v1/state', { headers: {
      'Content-Type': 'application/json', 'X-Ledger-Token': TOKEN, Origin: 'http://127.0.0.1:' + srv.port
    }, body: dup });
    assert.strictEqual(dupPut.status, 409);
    assert.strictEqual(dupPut.json.error.code, 'duplicate_assessment');

    // 缺键 = 清空（与旧版本备份恢复同一口径：不虚构默认值）
    const stripped = JSON.parse(JSON.stringify(base));
    delete stripped.riskAssessments;
    const clearPut = await request(srv.port, 'PUT', '/api/v1/state', { headers: {
      'Content-Type': 'application/json', 'X-Ledger-Token': TOKEN, Origin: 'http://127.0.0.1:' + srv.port
    }, body: stripped });
    assert.strictEqual(clearPut.status, 200);
    const afterClear = await request(srv.port, 'GET', '/api/v1/state');
    assert.deepStrictEqual(afterClear.json.riskAssessments, []);
    const cur = await request(srv.port, 'GET', '/api/v1/risk-assessments/current');
    assert.strictEqual(cur.json.status, 'no_assessment');
  } finally {
    srv.close();
    ctx.close();
  }
});

/* ------------------------------ 备份 / 恢复 ------------------------------ */

test('备份→恢复：risk_assessments 往返无损；v8 结构校验在恢复路径生效', async () => {
  const ctx = setup('ledger-p5b-');
  const srv = await startServer(ctx);
  try {
    const created = await post(srv.port, '/api/v1/risk-assessments', payload());
    assert.strictEqual(created.status, 201);
    const backup = await B.createBackup(ctx.db, ctx.paths, { reason: 'test' });
    assert.ok(fs.existsSync(path.join(ctx.paths.backupDir, backup.name)));

    // 恢复前清空：验证恢复真的是「带回」而不是「没动」
    R.clearAll(ctx.db);
    assert.strictEqual(R.readRiskAssessments(ctx.db).length, 0);

    const result = ctx.adopt(await B.restoreBackup(ctx.db, ctx.paths, path.join(ctx.paths.backupDir, backup.name)));
    assert.ok(result.ok, JSON.stringify(result));
    const restored = R.readRiskAssessments(ctx.db);
    assert.strictEqual(restored.length, 1);
    assert.deepStrictEqual(restored[0], created.json.item);

    const cur = await request(srv.port, 'GET', '/api/v1/risk-assessments/current');
    assert.strictEqual(cur.json.status, 'current');
    assert.strictEqual(cur.json.current.assessment.id, created.json.item.id);
  } finally {
    srv.close();
    ctx.close();
  }
});

test('仓储反例：同 id 直插被 duplicate_assessment 拒绝；形状不合格的行走校验', () => {
  const ctx = setup('ledger-p5b-');
  try {
    const computed = Domain.computeRiskAssessment(payload(), { today: TODAY });
    assert.ok(computed.ok);
    const rec = Object.assign({ id: 'ra-fixed-0001', createdAt: NOW_ISO }, computed.record);
    assert.deepStrictEqual(R.insertRiskAssessment(ctx.db, rec).answers, rec.answers);
    assert.throws(() => R.insertRiskAssessment(ctx.db, rec), (err) => err.code === 'duplicate_assessment');
    // 同一载荷第二次全量写入也必须拒绝（id 冲突）
    assert.throws(() => R.writeRiskAssessments(ctx.db, [rec, rec]), (err) => err.code === 'duplicate_assessment');
    // 派生值与答案重算不一致 → 拒绝
    const forged = Object.assign({}, rec, { ceiling: 1 });
    assert.throws(() => R.insertRiskAssessment(ctx.db, forged), (err) => !!err.code);
  } finally {
    ctx.close();
  }
});
