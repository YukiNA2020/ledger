/* 小账本 server/migrations.js — 版本化 SQLite 迁移器（Phase 2）
 *
 * 数据模型依据 ARCHITECTURE.md：
 *   §5.1 机构与账户 / §5.2 证券与持仓 / §5.4 现金流 / §5.5 数据不变量 / §5.6 幂等写入。
 *
 * 约定：
 *   - 迁移只向前、不修改已发布的历史版本；已应用版本记录在 schema_migrations；
 *   - 金额一律为对应币种的最小单位整数（分）；数量、价格、汇率用定点十进制 TEXT（A-006）；
 *   - balance_minor 为 NULL 表示"没有明确余额"，0 表示"已确认余额确实为零"（不得互相冒充）；
 *   - 每个迁移在单个事务内完成，失败整体回滚；
 *   - 表名沿用 ARCHITECTURE 的领域命名（portfolio_openings 对应前端领域集合 holdings）。
 *
 * 阶段边界：
 *   - v1（Phase 2）建立「当前领域模型（§5.1/§5.2）+ 现金流（§5.4）」需要的表；
 *   - v2（Phase 3）新增 §5.3 中月度结账需要的两张表（monthly_closes / close_snapshots）。
 *   - v3（Phase 3 S3.1 补全）新增多币种子账户换汇记录；不修改已发布的 v1/v2。
 *     风险评估、目标配置与决策表仍留给 Phase 5/6，不预建空表（避免猜测未冻结的语义）。
 *   - v4（Phase 4B 复核补口）只给 instruments 加一条表达式唯一索引，把「同一标的只有一行事实」
 *     从应用层检查提升为数据库不变量；不新增表，旧版本代码忽略该索引仍可工作。
 *   - 已发布版本不做破坏性修改；v2 只新增表与索引，旧版本代码忽略新表仍可工作。
 */
'use strict';

const { transaction, get, all } = require('./db');

const MIGRATIONS = [
  {
    version: 1,
    name: 'phase2-initial-schema',
    up(db) {
      db.exec(`
        /* ---------------- §5.1 机构与账户 ---------------- */

        CREATE TABLE institutions (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL UNIQUE,
          kind       TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE asset_accounts (
          id             TEXT PRIMARY KEY,
          institution_id TEXT REFERENCES institutions(id) ON DELETE SET NULL,
          name           TEXT NOT NULL,
          kind           TEXT NOT NULL,
          pool           TEXT NOT NULL CHECK (pool IN ('safety','investable','restricted','entitlement')),
          status         TEXT NOT NULL DEFAULT 'active',
          extra_json     TEXT
        );

        CREATE TABLE account_units (
          id            TEXT PRIMARY KEY,
          account_id    TEXT NOT NULL REFERENCES asset_accounts(id) ON DELETE CASCADE,
          currency      TEXT NOT NULL CHECK (currency IN ('CNY','HKD','USD')),
          balance_minor INTEGER,
          as_of         TEXT,
          source_type   TEXT,
          extra_json    TEXT
        );

        CREATE TABLE liabilities (
          id            TEXT PRIMARY KEY,
          account_id    TEXT REFERENCES asset_accounts(id) ON DELETE SET NULL,
          name          TEXT NOT NULL,
          currency      TEXT NOT NULL CHECK (currency IN ('CNY','HKD','USD')),
          balance_minor INTEGER,
          due_date      TEXT,
          term_type     TEXT,
          as_of         TEXT,
          extra_json    TEXT
        );

        CREATE TABLE entitlements (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          kind           TEXT NOT NULL,
          jurisdiction   TEXT,
          status         TEXT,
          balance_minor  INTEGER,
          valuation_type TEXT,
          as_of          TEXT,
          source_ref     TEXT,
          extra_json     TEXT
        );

        /* ---------------- §5.2 标的、持仓与行情 ---------------- */

        CREATE TABLE instruments (
          id                    TEXT PRIMARY KEY,
          symbol                TEXT NOT NULL,
          exchange              TEXT,
          currency              TEXT NOT NULL CHECK (currency IN ('CNY','HKD','USD')),
          name                  TEXT,
          instrument_type       TEXT,
          asset_class           TEXT,
          exposure_market       TEXT,
          classification_status TEXT NOT NULL DEFAULT 'suggested'
                                CHECK (classification_status IN ('suggested','confirmed')),
          extra_json            TEXT
        );

        /* 领域集合 holdings：初次持仓快照 */
        CREATE TABLE portfolio_openings (
          id            TEXT PRIMARY KEY,
          account_id    TEXT NOT NULL REFERENCES asset_accounts(id) ON DELETE CASCADE,
          instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
          quantity      TEXT NOT NULL,
          cost_minor    INTEGER,
          as_of         TEXT,
          extra_json    TEXT
        );

        /* 后续买卖、分红、费用（Phase 4 写入；本阶段建表并约束不变量） */
        CREATE TABLE security_events (
          id            TEXT PRIMARY KEY,
          account_id    TEXT NOT NULL REFERENCES asset_accounts(id) ON DELETE CASCADE,
          instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
          event_type    TEXT NOT NULL,
          quantity      TEXT,
          price_minor   INTEGER,
          fee_minor     INTEGER,
          currency      TEXT CHECK (currency IN ('CNY','HKD','USD')),
          occurred_at   TEXT NOT NULL,
          extra_json    TEXT
        );

        CREATE TABLE quotes (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
          price_minor   INTEGER NOT NULL,
          currency      TEXT NOT NULL CHECK (currency IN ('CNY','HKD','USD')),
          price_date    TEXT NOT NULL,
          fetched_at    TEXT,
          provider      TEXT,
          status        TEXT
        );

        CREATE TABLE fx_rates (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          base         TEXT NOT NULL CHECK (base IN ('CNY','HKD','USD')),
          "quote"      TEXT NOT NULL CHECK ("quote" IN ('CNY','HKD','USD')),
          rate_decimal TEXT NOT NULL,
          rate_date    TEXT NOT NULL,
          fetched_at   TEXT,
          provider     TEXT,
          status       TEXT
        );

        /* ---------------- §5.4 现金流（原账本能力） ---------------- */

        CREATE TABLE ledger_accounts (
          id                    TEXT PRIMARY KEY,
          name                  TEXT,
          type                  TEXT,
          color                 TEXT,
          initial_balance_minor INTEGER,
          order_index           INTEGER,
          aliases_json          TEXT,
          deleted               INTEGER NOT NULL DEFAULT 0,
          extra_json            TEXT
        );

        CREATE TABLE categories (
          id            TEXT PRIMARY KEY,
          type          TEXT,
          name          TEXT,
          icon          TEXT,
          parent_id     TEXT,
          keywords_json TEXT,
          extra_json    TEXT
        );

        CREATE TABLE txns (
          id            TEXT PRIMARY KEY,
          occurred_on   TEXT,
          occurred_time TEXT,
          txn_type      TEXT,
          amount_minor  INTEGER,
          account_id    TEXT,
          account_to    TEXT,
          category_id   TEXT,
          merchant      TEXT,
          note          TEXT,
          source        TEXT,
          raw_id        TEXT,
          status        TEXT,
          mapped_to     TEXT,
          refund_flag   INTEGER NOT NULL DEFAULT 0,
          transfer_half INTEGER NOT NULL DEFAULT 0,
          extra_json    TEXT
        );

        /* 确定性重复指纹：同来源同原始单号，可自动拦截（§5.4） */
        CREATE TABLE dedup_fingerprints (
          fingerprint TEXT PRIMARY KEY,
          txn_id      TEXT NOT NULL REFERENCES txns(id) ON DELETE CASCADE
        );

        /* 跨来源疑似重复：必须人工确认，与自动拦截的指纹分开存储（§5.4） */
        CREATE TABLE dedup_candidates (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          txn_a      TEXT NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
          txn_b      TEXT NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
          reason     TEXT,
          status     TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','merged','rejected')),
          created_at TEXT NOT NULL,
          UNIQUE (txn_a, txn_b)
        );

        /* ---------------- 设置与服务元数据 ---------------- */

        CREATE TABLE app_settings (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          json       TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE service_meta (
          meta_key   TEXT PRIMARY KEY,
          meta_value TEXT
        );

        /* §5.6：写请求必须支持幂等键或等价重复保护 */
        CREATE TABLE idempotency_keys (
          idempotency_key TEXT PRIMARY KEY,
          method          TEXT NOT NULL,
          path            TEXT NOT NULL,
          response_json   TEXT,
          created_at      TEXT NOT NULL
        );

        /* ---------------- 索引 ---------------- */

        CREATE INDEX idx_account_units_account  ON account_units(account_id);
        CREATE INDEX idx_liabilities_account    ON liabilities(account_id);
        CREATE INDEX idx_openings_account       ON portfolio_openings(account_id);
        CREATE INDEX idx_openings_instrument    ON portfolio_openings(instrument_id);
        CREATE INDEX idx_events_instrument      ON security_events(instrument_id);
        CREATE INDEX idx_quotes_instrument      ON quotes(instrument_id, price_date);
        CREATE INDEX idx_fx_pair                ON fx_rates(base, "quote", rate_date);
        /* provider 允许缺省（NULL 表示"来源未记录"）；用表达式唯一索引让 NULL 也参与去重 */
        CREATE UNIQUE INDEX uq_quotes_dedupe    ON quotes(instrument_id, price_date, IFNULL(provider, ''));
        CREATE UNIQUE INDEX uq_fx_dedupe        ON fx_rates(base, "quote", rate_date, IFNULL(provider, ''));
        CREATE INDEX idx_txns_date              ON txns(occurred_on);
        CREATE INDEX idx_txns_source_rawid      ON txns(source, raw_id);
        CREATE INDEX idx_txns_mapped            ON txns(mapped_to);
        CREATE INDEX idx_categories_parent      ON categories(parent_id);
        CREATE INDEX idx_dedup_candidates_state ON dedup_candidates(status);
      `);
    }
  },
  {
    version: 2,
    name: 'phase3-close-schema',
    up(db) {
      /* ---------------- §5.3 月度结账与快照（Phase 3） ---------------- */

      /* 一次月度结账：month 唯一（重复结账为更新同月状态并追加新快照）；
       * status 只有 formal/estimate 两种 —— 缺项未补齐时允许保存 estimate 快照，
       * 但绝不允许标成 formal（ACCEPTANCE S3.3）。 */
      db.exec(`
        CREATE TABLE monthly_closes (
          id           TEXT PRIMARY KEY,
          month        TEXT NOT NULL UNIQUE
                       CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
          status       TEXT NOT NULL CHECK (status IN ('formal','estimate')),
          blockers_json TEXT,
          summary_json TEXT,
          completed_at TEXT NOT NULL,
          data_cutoff  TEXT NOT NULL
        );

        /* 结账历史快照：完整保存当时的资产事实与总览口径，payload_hash 用于完整性核对。
         * §5.3 只要求存 hash；这里同时落 payload_json，使"每个金额可追溯到余额/估值"
         * 不依赖后续阶段就能成立（快照自包含、离线可审计）。 */
        CREATE TABLE close_snapshots (
          id            TEXT PRIMARY KEY,
          close_id      TEXT REFERENCES monthly_closes(id) ON DELETE CASCADE,
          month         TEXT NOT NULL,
          captured_at   TEXT NOT NULL,
          snapshot_type TEXT NOT NULL DEFAULT 'monthly_close',
          payload_json  TEXT NOT NULL,
          payload_hash  TEXT NOT NULL
        );

        CREATE INDEX idx_close_snapshots_close ON close_snapshots(close_id);
        CREATE INDEX idx_close_snapshots_month ON close_snapshots(month);
      `);
    }
  },
  {
    version: 3,
    name: 'phase3-asset-transfers',
    up(db) {
      /* S3.1：换汇是两个币种子账户之间的资产转移，不属于现金流收入/支出。
       * 两端金额和币种都固化在记录中，避免后来修改子账户币种时破坏历史审计。 */
      db.exec(`
        CREATE TABLE asset_transfers (
          id                  TEXT PRIMARY KEY,
          from_unit_id        TEXT NOT NULL REFERENCES account_units(id) ON DELETE RESTRICT,
          to_unit_id          TEXT NOT NULL REFERENCES account_units(id) ON DELETE RESTRICT,
          from_currency       TEXT NOT NULL CHECK (from_currency IN ('CNY','HKD','USD')),
          to_currency         TEXT NOT NULL CHECK (to_currency IN ('CNY','HKD','USD')),
          from_amount_minor   INTEGER NOT NULL CHECK (from_amount_minor > 0),
          to_amount_minor     INTEGER NOT NULL CHECK (to_amount_minor > 0),
          occurred_on         TEXT NOT NULL,
          source_type         TEXT NOT NULL DEFAULT 'manual',
          note                TEXT,
          created_at          TEXT NOT NULL,
          CHECK (from_unit_id <> to_unit_id),
          CHECK (from_currency <> to_currency)
        );

        CREATE INDEX idx_asset_transfers_date ON asset_transfers(occurred_on);
        CREATE INDEX idx_asset_transfers_units ON asset_transfers(from_unit_id, to_unit_id);
      `);
    }
  },
  {
    version: 4,
    name: 'phase4b-instrument-dedupe',
    up(db) {
      /* Phase 4B 复核补口：`(symbol, exchange)` 去重键此前只在应用层检查，
       * 全量写入路径（PUT /state、JSON 恢复）可以插进 VOO/NYSE 与 voo/nyse 两行。
       * 这里把它变成数据库不变量：表达式索引的归一规则与 js/domain.js 的 instrumentKey 一致
       * ——去空白 + 大写，exchange 缺失按空串参与（IFNULL 让 NULL 也进入比较，
       * 否则两个 NULL 之间的"相等"不成立，去重会漏）。 */
      const dups = all(
        db,
        `SELECT upper(trim(symbol)) AS s, upper(trim(IFNULL(exchange, ''))) AS e, COUNT(*) AS n
           FROM instruments GROUP BY s, e HAVING n > 1`
      );
      // 历史数据里已经有重复时**显式失败**，不替用户挑选要保留哪一行（不静默丢数据）。
      if (dups.length) {
        const keys = dups.map((d) => d.s + '@' + d.e).join('、');
        throw Object.assign(
          new Error('instruments 存在重复标的，无法建立唯一去重索引：' + keys + '（请先人工核对后合并）'),
          { code: 'duplicate_instrument' }
        );
      }
      db.exec(`
        CREATE UNIQUE INDEX uq_instruments_dedupe
          ON instruments(upper(trim(symbol)), upper(trim(IFNULL(exchange, ''))));
      `);
    }
  }
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

function ensureMigrationsTable(db) {
  db.exec(MIGRATIONS_TABLE);
}

function appliedVersions(db) {
  ensureMigrationsTable(db);
  return all(db, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version);
}

function currentVersion(db) {
  ensureMigrationsTable(db);
  const row = get(db, 'SELECT MAX(version) AS v FROM schema_migrations');
  return row && row.v != null ? row.v : 0;
}

function pending(db) {
  const done = new Set(appliedVersions(db));
  return MIGRATIONS.filter((m) => !done.has(m.version));
}

// 顺序应用未执行的迁移；每个迁移自成一个事务，失败即整体回滚并抛出。
// options.list 可注入替代迁移集（仅用于测试失败回滚，不改变生产路径）。
function migrate(db, options) {
  const opts = options || {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  ensureMigrationsTable(db);
  const beforeVersion = currentVersion(db);
  const applied = [];
  const candidates = Array.isArray(opts.list) && opts.list.length
    ? opts.list.slice().sort((a, b) => a.version - b.version)
    : MIGRATIONS;
  const done = new Set(appliedVersions(db));
  const list = candidates.filter((m) => !done.has(m.version));
  list.forEach((m) => {
    log('应用迁移 v' + m.version + ' ' + m.name);
    transaction(db, () => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString()
      );
    });
    applied.push(m.version);
  });
  const version = currentVersion(db);
  return { from: beforeVersion, applied: applied, version: version };
}

module.exports = {
  MIGRATIONS,
  LATEST_VERSION,
  ensureMigrationsTable,
  appliedVersions,
  currentVersion,
  pending,
  migrate
};
