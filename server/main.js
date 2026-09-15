/* 小账本 server/main.js — 本地服务入口（Phase 2）
 *
 * 启动顺序（ARCHITECTURE §7.1）：
 *   1. 取得单实例写锁（第二实例不再写入，只把浏览器聚焦到产品页）；
 *   2. 打开数据库并应用迁移；
 *   3. 保证"至少每日一份"备份；
 *   4. 生成随机 session token 并落盘（0600）；
 *   5. 只绑定 127.0.0.1 提供静态前端与 /api/v1；
 *   6. 打开浏览器。
 *
 * 运行方式：
 *   node server/main.js [--port 8421] [--data-dir DIR] [--no-open] [--self-check]
 *
 * 失败可见：日志同时写到 stdout 与 <数据目录>/logs/server.log，不静默吞错。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const config = require('./config');
const dbm = require('./db');
const migrations = require('./migrations');
const backupLib = require('./backup');
const api = require('./api');
const keychain = require('./keychain');
const loginItem = require('./login-item');

const APP_VERSION = '2.2.1-phase2';
const KEYCHAIN_SERVICE = 'com.ledger.local.marketdata';
const KEYCHAIN_ACCOUNT = 'default';

/* ------------------------------ 参数与日志 ------------------------------ */

function parseArgs(argv) {
  const out = { port: null, dataDir: null, open: true, selfCheck: false, migrateOnly: false, printConfig: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = argv[++i];
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--no-open') out.open = false;
    else if (a === '--open') out.open = true;
    else if (a === '--self-check') out.selfCheck = true;
    else if (a === '--migrate-only') out.migrateOnly = true;
    else if (a === '--print-config') out.printConfig = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = [
  '小账本本地服务（Phase 2）',
  '',
  '用法：node server/main.js [选项]',
  '',
  '  --port N        监听端口（默认 8421，仅绑定 127.0.0.1）',
  '  --data-dir DIR  数据目录（默认 ~/Library/Application Support/Ledger）',
  '  --no-open       启动后不打开浏览器',
  '  --migrate-only  只应用数据库迁移后退出',
  '  --self-check    运行实施前技术门禁自检（不写入财务数据）后退出',
  '  --print-config  打印生效配置后退出',
  '  -h, --help      显示本帮助'
].join('\n');

function createLogger(logFile) {
  const write = (level, msg) => {
    const line = '[' + new Date().toISOString() + '] ' + level + ' ' + msg + '\n';
    if (level === 'ERROR') process.stderr.write(line);
    else process.stdout.write(line);
    try {
      fs.appendFileSync(logFile, line);
    } catch (_) {
      // 日志文件不可写时仍然保留 stdout/stderr 输出
    }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m)
  };
}

/* ------------------------------ 单实例锁 ------------------------------ */

function acquireLock(lockFile, info) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      } catch (_) {
        holder = null;
      }
      if (holder && holder.pid && isProcessAlive(holder.pid)) {
        return { ok: false, reason: 'already-running', holder: holder };
      }
      // 上一次进程异常退出留下的陈锁：清理后重试一次
      try {
        fs.unlinkSync(lockFile);
      } catch (_) {
        /* 与另一实例竞争清理时忽略 */
      }
    }
  }
  return { ok: false, reason: 'lock-unavailable' };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function releaseLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch (_) {
    // 锁已被清理时忽略
  }
}

/* ------------------------------ 辅助 ------------------------------ */

function writeTokenFile(tokenFile, token) {
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  try {
    fs.chmodSync(tokenFile, 0o600);
  } catch (_) {
    /* 权限设置失败不阻断启动；文件仍在用户私有目录 */
  }
}

function openBrowser(url, logger) {
  execFile('open', [url], (err) => {
    if (err) logger.warn('无法自动打开浏览器，请手动访问 ' + url + '（' + err.message + '）');
  });
}

function nextActions(url) {
  return [
    '',
    '小账本本地服务已启动',
    '  地址：' + url,
    '  停止：Ctrl+C（登录项方式安装时用 npm-free 脚本 scripts/uninstall-login-item.sh 卸载）',
    ''
  ].join('\n');
}

/* ------------------------------ 启动 ------------------------------ */

async function start(options) {
  const opts = options || {};
  const dataDir = config.resolveDataDir(opts.dataDir);
  const port = config.resolvePort(opts.port);
  const p = config.ensureDirs(config.paths(dataDir));
  const logger = opts.logger || createLogger(p.logFile);

  const lock = acquireLock(p.lockFile, { pid: process.pid, port: port, startedAt: new Date().toISOString() });
  const url = 'http://127.0.0.1:' + port + '/';

  if (!lock.ok) {
    // S2.3：自动启动触发两次时，最多一个写入服务实例；第二个实例只把浏览器聚焦到产品页
    logger.info('已有服务实例在运行（pid ' + (lock.holder ? lock.holder.pid : 'unknown') + '），本进程不写入数据，仅打开页面');
    if (opts.open !== false) openBrowser(url, logger);
    return { mode: 'secondary', url: url, exited: true };
  }

  let db = null;
  let server = null;
  const release = () => {
    releaseLock(p.lockFile);
    dbm.closeQuietly(db);
  };

  try {
    db = dbm.openDatabase(p.dbFile);
    const migrated = migrations.migrate(db, { log: (m) => logger.info(m) });
    logger.info('数据库就绪 v' + migrated.version + '（' + p.dbFile + '）');

    // --migrate-only 严格只做迁移：不备份、不写会话令牌、不开监听，便于在脚本/部署步骤中安全调用
    if (opts.migrateOnly) {
      release();
      return { mode: 'migrate-only', schemaVersion: migrated.version };
    }

    const daily = await backupLib.ensureDailyBackup(db, p);
    logger.info(daily.created ? '已创建当日备份 ' + daily.backup.name : '当日备份已存在，跳过');

    const token = crypto.randomBytes(32).toString('hex');
    writeTokenFile(p.tokenFile, token);

    const ctx = {
      db: db,
      paths: p,
      host: config.HOST,
      port: port,
      token: token,
      repoRoot: config.REPO_ROOT,
      logger: logger,
      startedAt: new Date().toISOString(),
      backupKeep: config.BACKUP_KEEP,
      backupMinIntervalMs: config.BACKUP_MIN_INTERVAL_MS,
      keychainService: KEYCHAIN_SERVICE,
      keychainAccount: KEYCHAIN_ACCOUNT
    };
    const handler = api.createHandlerEntry(ctx);
    server = http.createServer(handler);

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // 只绑定 127.0.0.1，代码中不存在改绑 0.0.0.0 的分支
      server.listen(port, config.HOST, resolve);
    });
    const address = server.address();
    logger.info('监听 ' + address.address + ':' + address.port + '（仅 loopback）');

    if (opts.open !== false) openBrowser(url, logger);
    process.stdout.write(nextActions(url));

    const shutdown = (signal) => {
      logger.info('收到 ' + signal + '，正在停止服务');
      if (server) {
        server.close(() => {
          release();
          process.exit(0);
        });
        setTimeout(() => {
          release();
          process.exit(0);
        }, 2000).unref();
      } else {
        release();
        process.exit(0);
      }
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('exit', () => releaseLock(p.lockFile));

    return { mode: 'primary', url: url, server: server, db: db, paths: p, port: port, stop: release };
  } catch (err) {
    logger.error('启动失败：' + (err && err.message ? err.message : String(err)));
    release();
    throw err;
  }
}

/* ------------------------------ §13 技术门禁自检 ------------------------------ */

async function selfCheck() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name: name, ok: !!ok, detail: detail });

  // 1) SQLite 驱动：临时库上验证事务回滚、外键、WAL
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ledger-selfcheck-'));
  const tmpDb = path.join(tmpDir, 'probe.db');
  try {
    const db = dbm.openDatabase(tmpDb);
    migrations.migrate(db);
    db.exec("INSERT INTO institutions (id, name, kind, created_at) VALUES ('x','probe','other','now')");
    let fkEnforced = false;
    try {
      db.exec("INSERT INTO account_units (id, account_id, currency) VALUES ('u','missing','CNY')");
    } catch (_) {
      fkEnforced = true;
    }
    let rolledBack = false;
    try {
      dbm.transaction(db, () => {
        db.exec("INSERT INTO institutions (id, name, kind, created_at) VALUES ('y','probe2','other','now')");
        throw new Error('probe');
      });
    } catch (_) {
      rolledBack = true;
    }
    const remaining = dbm.get(db, 'SELECT COUNT(*) AS c FROM institutions').c;
    push('SQLite 驱动（node:sqlite）', fkEnforced && rolledBack && remaining === 1, 'FK=' + fkEnforced + ' rollback=' + rolledBack + ' rows=' + remaining);
    dbm.closeQuietly(db);
  } catch (err) {
    push('SQLite 驱动（node:sqlite）', false, err.message);
  }

  // 2) 只绑定 loopback
  try {
    const probe = http.createServer(() => {});
    await new Promise((res, rej) => {
      probe.once('error', rej);
      probe.listen(0, config.HOST, res);
    });
    const addr = probe.address();
    push('loopback 绑定', addr.address === '127.0.0.1', addr.address + ':' + addr.port);
    await new Promise((res) => probe.close(res));
  } catch (err) {
    push('loopback 绑定', false, err.message);
  }

  // 3) 单实例锁
  try {
    const lockFile = path.join(tmpDir, 'probe.lock');
    const first = acquireLock(lockFile, { pid: process.pid });
    const second = acquireLock(lockFile, { pid: process.pid });
    push('单实例写锁', first.ok && !second.ok, 'first=' + first.ok + ' second=' + (second.ok ? 'acquired' : second.reason));
    releaseLock(lockFile);
  } catch (err) {
    push('单实例写锁', false, err.message);
  }

  // 4) Keychain 读取路径（只探测，不创建任何条目）
  const kc = keychain.selfCheck(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  push(
    'Keychain 读取路径',
    kc.available && kc.readable,
    'security=' + kc.available + ' 可读=' + kc.readable + ' 探测=' + (kc.probe ? kc.probe.status : 'n/a')
  );

  // 5) 登录启动项渲染与 plist 合法性
  try {
    const plist = loginItem.renderPlist({
      nodePath: loginItem.resolveNode(),
      scriptPath: path.join(config.REPO_ROOT, 'server', 'main.js'),
      dataDir: config.defaultDataDir(),
      port: config.DEFAULT_PORT,
      logDir: path.join(config.defaultDataDir(), 'logs')
    });
    const lint = loginItem.lintPlist(plist);
    push('登录启动项 plist', lint.ok, 'label=' + loginItem.LABEL + ' plutil=' + (lint.ok ? 'OK' : lint.reason));
  } catch (err) {
    push('登录启动项 plist', false, err.message);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    /* 临时目录清理失败不影响自检结论 */
  }

  const allOk = results.every((r) => r.ok);
  console.log('\n实施前技术门禁自检' + (allOk ? '：全部通过' : '：存在未通过项'));
  results.forEach((r) => console.log('  ' + (r.ok ? 'OK  ' : 'FAIL') + ' ' + r.name + ' — ' + r.detail));
  console.log('');
  return { ok: allOk, results: results };
}

/* ------------------------------ CLI ------------------------------ */

async function cli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (args.printConfig) {
    const dataDir = config.resolveDataDir(args.dataDir);
    process.stdout.write(
      JSON.stringify(
        { host: config.HOST, port: config.resolvePort(args.port), ...config.paths(dataDir), repoRoot: config.REPO_ROOT, backupKeep: config.BACKUP_KEEP },
        null,
        2
      ) + '\n'
    );
    return 0;
  }
  if (args.selfCheck) {
    const result = await selfCheck();
    return result.ok ? 0 : 1;
  }
  const result = await start({ port: args.port, dataDir: args.dataDir, open: args.open, migrateOnly: args.migrateOnly });
  if (result.mode === 'primary') return null; // 常驻：由信号处理退出
  return 0;
}

if (require.main === module) {
  cli(process.argv.slice(2))
    .then((code) => {
      if (code !== null && code !== undefined) process.exit(code);
    })
    .catch((err) => {
      process.stderr.write('启动失败：' + (err && err.stack ? err.stack : String(err)) + '\n');
      process.exit(1);
    });
}

module.exports = { APP_VERSION, start, selfCheck, acquireLock, releaseLock, createLogger, parseArgs, KEYCHAIN_SERVICE };
