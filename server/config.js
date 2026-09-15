/* 小账本 server/config.js — 本地服务配置常量（Phase 2）
 * 单一来源：监听地址、端口、数据目录、备份保留策略。
 *
 * 安全硬约束（ARCHITECTURE §8 / AGENTS.md 隐私与网络）：
 *   - HOST 固定 127.0.0.1，代码中不提供任何改为 0.0.0.0 的开关，也不读环境变量覆盖；
 *   - 数据目录外置于仓库，个人财务数据不进入 Git 工作区。
 *
 * 测试隔离：测试通过 LEDGER_HOME 指向临时目录，绝不触碰用户真实数据目录。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = '127.0.0.1'; // 硬编码：不绑定 0.0.0.0
const DEFAULT_PORT = 8421;
const REPO_ROOT = path.resolve(__dirname, '..');

// A-003：SQLite 自动备份至少每日一份，默认保留最近 30 份
const BACKUP_KEEP = 30;
// 写事务后创建版本备份的最小间隔，避免同一分钟反复备份
const BACKUP_MIN_INTERVAL_MS = 60 * 1000;

function defaultDataDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Ledger');
}

function resolveDataDir(explicit) {
  const dir = explicit || process.env.LEDGER_HOME || defaultDataDir();
  return path.resolve(dir);
}

function resolvePort(explicit) {
  const raw = explicit != null ? explicit : process.env.LEDGER_PORT;
  let port = DEFAULT_PORT;
  if (raw != null && raw !== '') {
    port = Number(raw);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('端口非法（需 1024–65535 的整数）：' + raw);
    }
  }
  return port;
}

function paths(dataDir) {
  return {
    dataDir,
    dbFile: path.join(dataDir, 'ledger.db'),
    backupDir: path.join(dataDir, 'backups'),
    logDir: path.join(dataDir, 'logs'),
    logFile: path.join(dataDir, 'logs', 'server.log'),
    lockFile: path.join(dataDir, 'server.lock'),
    tokenFile: path.join(dataDir, 'session-token'),
    openStateFile: path.join(dataDir, 'last-open.json')
  };
}

// 数据目录只对当前用户开放：私人财务数据不做跨用户共享
function ensureDirs(p) {
  [p.dataDir, p.backupDir, p.logDir].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  });
  try {
    fs.chmodSync(p.dataDir, 0o700);
    fs.chmodSync(p.backupDir, 0o700);
    fs.chmodSync(p.logDir, 0o700);
  } catch (_) {
    // 非 POSIX 或权限受限时忽略；下一层由 OS 用户账户隔离
  }
  return p;
}

module.exports = {
  HOST,
  DEFAULT_PORT,
  REPO_ROOT,
  BACKUP_KEEP,
  BACKUP_MIN_INTERVAL_MS,
  defaultDataDir,
  resolveDataDir,
  resolvePort,
  paths,
  ensureDirs
};
