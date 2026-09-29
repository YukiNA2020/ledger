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
 *   - v5（Phase 4C）给 security_events 加 amount_minor 列（分红/费用总额落点）与事件重放索引。
 *   - v6（Phase 4C 复核补口）给 portfolio_openings 加 (account_id, instrument_id) 唯一索引，
 *     把「同一持仓只有一行期初事实」提升为数据库不变量（G4C-3）。
 *   - v7（Phase 4D）给 quotes 加 source_symbol 列，承载行情 provider 返回的原始代码（追溯要求）。
 *     只有加列、不加索引：报价的「(标的, 价格日) 元素键」由写入路径强制，原因见 v7 迁移内的注释。
 *   - v8（Phase 5B）新增 risk_assessments 追加版本表（D-047）：一行一次评估，
 *     原始答案与当时规则版本一起封存；历史行不被新规则重算改写，复评只追加不覆盖。
 *   - v9（Phase 5C）新增 allocation_targets（目标版本，追加式，D-048）与
 *     approved_instruments（资产类别 → 用户认可标的的白名单，仅用户判断可写）。
 *   - v11（Phase 6B，D-057）新增决策状态机三表：decisions / decision_events / decision_links。
 *     一行决策绑定一条建议（recommendation_id 唯一 + RESTRICT）；事件只追加（seq 每条决策内
 *     从 1 连续递增），每次状态变化封存一份快照（canonicalJson + sha256）；关联行是软删除
 *     （unlinked_on IS NULL 表示活动），部分唯一索引保证一条证券事件同时只属一条决策。
 *     旧库前向迁移后三表为空 —— 不伪造任何历史决策。
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
  },
  {
    version: 5,
    name: 'phase4c-security-event-amounts',
    up(db) {
      /* Phase 4C：分红/费用事件需要一个「事件总额」列。
       * v1 的 security_events 只有每股口径（quantity/price_minor/fee_minor），
       * 分红总额与费用总额没有落点；D-042 冻结的口径是
       *   - price_minor 只存"每股价格"，不再借存总额（不做字段混用）；
       *   - amount_minor 存分红/费用事件的总额（对应币种最小单位整数）；
       *   - 买卖事件的 amount_minor 保持 NULL（数量 × 单价可推导，不冗余落库）。
       * 同时补 (account_id, instrument_id, occurred_at) 索引：
       * 推导持仓时要按 (账户, 标的) 拉全量事件按时间重放。 */
      db.exec(`
        ALTER TABLE security_events ADD COLUMN amount_minor INTEGER;
        CREATE INDEX idx_events_account_instrument
          ON security_events(account_id, instrument_id, occurred_at);
      `);
    }
  },
  {
    version: 6,
    name: 'phase4c-opening-dedupe',
    up(db) {
      /* Phase 4C 复核补口（G4C-3）：同一 (账户, 标的) 只能有一行期初快照此前只在应用层
       * 检查（单条 upsert 的 duplicate_opening），全量写入路径（PUT /state、JSON 恢复）
       * 曾绕过它写入两行。这里把该键提升为数据库不变量，与 v4 的 instruments 去重同纪律。 */
      const dups = all(
        db,
        `SELECT account_id, instrument_id, COUNT(*) AS n
           FROM portfolio_openings GROUP BY account_id, instrument_id HAVING n > 1`
      );
      // 历史数据里已经有重复时**显式失败**，不替用户挑选要保留哪一行（不静默丢数据）。
      if (dups.length) {
        const keys = dups.map((d) => d.account_id + '/' + d.instrument_id).join('、');
        throw Object.assign(
          new Error('portfolio_openings 存在重复期初快照，无法建立唯一索引：' + keys + '（请先人工核对后合并）'),
          { code: 'duplicate_opening' }
        );
      }
      db.exec(`
        CREATE UNIQUE INDEX uq_portfolio_openings_dedupe
          ON portfolio_openings(account_id, instrument_id);
      `);
    }
  },
  {
    version: 7,
    name: 'phase4d-quote-source-symbol',
    up(db) {
      /* Phase 4D：日终行情需要把 provider 返回的**原始代码**留档。
       * quotes.source_symbol 存 provider 侧的原形（如 `VOO` / `voo.us`），与本地
       * instruments.symbol 可能不同形；ROADMAP 4D 范围 3 要求「保存价格日、抓取时间、
       * provider 与原始代码」，原始代码此前没有落点（provider / fetched_at 已有）。
       *
       * 只加列，不新增索引：D-044 冻结的元素键是「(标的, 价格日)」，但它只能在**写入路径**
       * 强制（先按该键跨 provider 替换再插入），不能提升为数据库唯一索引 —— v1 已发布的
       * 表达式唯一索引 uq_quotes_dedupe 是 (instrument_id, price_date, IFNULL(provider,''))，
       * 即「provider 参与去重、同一价格日可不同 provider 并存」，这一点被
       * tests/server-migration.test.js「provider 缺省也参与去重」冻结为既有口径；
       * 收紧成 (instrument_id, price_date) 会推翻该已发布断言（并可能拒绝合法历史快照）。
       * 该取舍已记入 DECISIONS.md D-044 与 PHASE4D 证据。 */
      db.exec('ALTER TABLE quotes ADD COLUMN source_symbol TEXT;');
    }
  },
  {
    version: 8,
    name: 'phase5b-risk-assessments',
    up(db) {
      /* Phase 5B（D-047）：风险评估追加版本表。
       * - 一行 = 一次评估：原始答案 + 当时 ruleVersion + 全部派生值一起封存；
       *   历史行永不被新规则静默重算改写（§5.3 门禁），复评即追加新行，不 UPDATE 旧行；
       * - answers/hard_caps/explain_codes 用 JSON 文本无损往返（沿用 extra_json 纪律），
       *   CHECK 只挡结构（合法 JSON 数组且非对象），逐字段校验在仓储写入路径；
       * - assessed_at/expiry 是日历日；rule_version/reason 词表校验在仓储写入路径，
       *   与 quotes 元素键同一取舍（D-044）：语义约束留在唯一实现，DB 只挡明显畸形；
       * - 旧库前向迁移后本表为空 —— 不伪造默认评估（D-047 停止条件）。 */
      db.exec(`
        CREATE TABLE risk_assessments (
          id                TEXT PRIMARY KEY,
          rule_version      TEXT NOT NULL,
          answers_json      TEXT NOT NULL CHECK (json_valid(answers_json) AND json_type(answers_json) = 'array'),
          capacity_score    INTEGER NOT NULL CHECK (capacity_score >= 0 AND capacity_score <= 15),
          willingness_score INTEGER NOT NULL CHECK (willingness_score >= 0 AND willingness_score <= 12),
          capacity_level    INTEGER NOT NULL CHECK (capacity_level BETWEEN 1 AND 5),
          willingness_level INTEGER NOT NULL CHECK (willingness_level BETWEEN 1 AND 5),
          risk_ceiling      INTEGER NOT NULL CHECK (risk_ceiling BETWEEN 1 AND 5),
          ceiling_source    TEXT NOT NULL CHECK (ceiling_source IN ('capacity','willingness','equal','hard_cap')),
          hard_caps_json    TEXT NOT NULL CHECK (json_valid(hard_caps_json) AND json_type(hard_caps_json) = 'array'),
          explain_codes_json TEXT NOT NULL CHECK (json_valid(explain_codes_json) AND json_type(explain_codes_json) = 'array'),
          assessed_at       TEXT NOT NULL,
          expiry            TEXT NOT NULL,
          reason            TEXT NOT NULL,
          created_at        TEXT NOT NULL
        );
        CREATE INDEX idx_risk_assessments_assessed ON risk_assessments(assessed_at, created_at, id);
      `);
    }
  },
  {
    version: 9,
    name: 'phase5c-allocation-targets',
    up(db) {
      /* Phase 5C（D-048）：目标配置版本 + 用户认可标的映射。
       *
       * allocation_targets —— 一行 = 一个目标版本（**追加式**，历史行永不 UPDATE）：
       *   - level / classes 全部由服务端按「所引用评估的上限 + 5A 冻结模板」派生后封存，
       *     同时保存 assessment_id、assessed_at、assessment_expiry 与 effective_from，
       *     使「这一版目标来自哪一份评估、何时生效」可追溯（§6.2 工作项 1/5）；
       *   - 自然键唯一索引 (assessment_id, template_version, effective_from)：
       *     同一评估 + 同一模板版本 + 同一生效日只有一个版本，重复请求不产生第二行；
       *   - assessment_id 用 ON DELETE RESTRICT：目标存在时不得级联删掉它所引用的评估（§10.6）。
       *
       * approved_instruments —— 「资产类别 → 用户认可标的」白名单，一行一条映射：
       *   - 只有用户判断写入本表；行情 / 目录 provider 的刷新路径不触碰本表任何列（§6.2 工作项 7）；
       *   - UNIQUE(instrument_id)：同一标的只能属于一个类别（标的的 asset_class 唯一，
       *     两处并存必然是分类冲突）；UNIQUE(asset_class, position)：类别内顺序不重复，
       *     顺序本身是用户判断（§6.2 工作项 6）；
       *   - instrument_id 用 ON DELETE RESTRICT：删标的必须先显式解除用户映射，
       *     不让引用静默悬空（失效引用由读取路径显式报告，不靠级联删除掩盖）；
       *   - 唯一约束按名称显式建索引（不写内联 UNIQUE），server/backup.js 才能按名校验该不变量。
       *
       * classes_json 用 JSON 文本无损往返（沿用 extra_json 纪律）；CHECK 只挡结构
       * （合法 JSON 对象），逐字段比例校验留在仓储 / 领域唯一实现（与 D-044 / D-047 同一取舍）。
       * 旧库前向迁移后两表为空 —— 不替用户伪造目标或认可标的（D-034 禁止编造个人财务事实）。 */
      db.exec(`
        CREATE TABLE allocation_targets (
          id                TEXT PRIMARY KEY,
          template_version  TEXT NOT NULL,
          rule_version      TEXT NOT NULL,
          level             INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
          classes_json      TEXT NOT NULL CHECK (json_valid(classes_json) AND json_type(classes_json) = 'object'),
          assessment_id     TEXT NOT NULL REFERENCES risk_assessments(id) ON DELETE RESTRICT,
          assessed_at       TEXT NOT NULL,
          assessment_expiry TEXT NOT NULL,
          effective_from    TEXT NOT NULL,
          created_at        TEXT NOT NULL
        );
        CREATE UNIQUE INDEX uq_allocation_targets_natural
          ON allocation_targets(assessment_id, template_version, effective_from);
        CREATE INDEX idx_allocation_targets_effective
          ON allocation_targets(effective_from, created_at, id);

        CREATE TABLE approved_instruments (
          id            TEXT PRIMARY KEY,
          asset_class   TEXT NOT NULL CHECK (asset_class IN
                        ('cash','fixed_income','broad_equity','theme_equity','stock','other')),
          instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
          position      INTEGER NOT NULL CHECK (position >= 0),
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE UNIQUE INDEX uq_approved_instruments_slot
          ON approved_instruments(asset_class, position);
        CREATE UNIQUE INDEX uq_approved_instruments_instrument
          ON approved_instruments(instrument_id);
      `);
    }
  },
  {
    version: 10,
    name: 'phase5d-recommendations',
    up(db) {
      /* Phase 5D（D-049）：新增资金再平衡的**不可变计算结果**。
       *
       * 一行 = 一次建议产物（追加式，永不 UPDATE）：请求绑定「快照 + 评估 + 目标 + 规则版本 + 金额」，
       * 结果本身连同 gate / todos / result 一起封存，使 Phase 6 可以直接接管这份草案，
       * 而不必重算 —— 重算会读到已经变动的估值，用户当时看到的数字就永远复现不出来了。
       *
       * - input_hash 唯一索引：id 由它导出，因此同一份输入重复请求返回同一行（幂等），
       *   事实变了才产生新的一行；
       * - assessment_id / target_id 用 ON DELETE RESTRICT（§10.6：正式建议引用的评估与目标
       *   不得被级联删除，删掉用户事实前必须先处理这些建议）；
       * - close_id / snapshot_id / snapshot_hash 是**封存审计引用**而不是活动外键：全量写入
       *   （PUT /state / 旧备份恢复）会整体重建 monthly_closes 与 close_snapshots，
       *   给它们加 RESTRICT 会让「保留建议、重建账务事实」这条路径直接失败。
       *   建议行自身带着 payload_hash，被引用的快照是否存在不影响这份产物当时说了什么；
       * - gate_json / result_json / todos_json 用 JSON 文本无损往返；CHECK 只挡结构，
       *   逐字段语义与「门禁不过却标 formal」这类伪造在仓储 / 领域唯一实现里复核（D-044 取舍）；
       * - 旧库前向迁移后本表为空：不替用户伪造任何一条历史建议。 */
      db.exec(`
        CREATE TABLE recommendations (
          id                          TEXT PRIMARY KEY,
          status                      TEXT NOT NULL CHECK (status IN ('formal','estimate')),
          rule_version                TEXT NOT NULL,
          target_version              TEXT NOT NULL,
          assessment_id               TEXT NOT NULL REFERENCES risk_assessments(id) ON DELETE RESTRICT,
          target_id                   TEXT NOT NULL REFERENCES allocation_targets(id) ON DELETE RESTRICT,
          close_id                    TEXT NOT NULL,
          snapshot_id                 TEXT NOT NULL,
          snapshot_hash               TEXT NOT NULL,
          data_cutoff                 TEXT NOT NULL,
          as_of                       TEXT NOT NULL,
          requested_new_funds_minor   INTEGER NOT NULL CHECK (requested_new_funds_minor >= 0),
          available_new_funds_minor   INTEGER NOT NULL CHECK (available_new_funds_minor >= 0),
          allocatable_new_funds_minor INTEGER NOT NULL CHECK (allocatable_new_funds_minor >= 0),
          allocated_total_minor       INTEGER NOT NULL CHECK (allocated_total_minor >= 0),
          input_hash                  TEXT NOT NULL,
          gate_json                   TEXT NOT NULL CHECK (json_valid(gate_json) AND json_type(gate_json) = 'object'),
          todos_json                  TEXT NOT NULL CHECK (json_valid(todos_json) AND json_type(todos_json) = 'array'),
          result_json                 TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
          payload_hash                TEXT NOT NULL,
          created_at                  TEXT NOT NULL
        );
        CREATE UNIQUE INDEX uq_recommendations_input ON recommendations(input_hash);
        CREATE INDEX idx_recommendations_created ON recommendations(created_at, id);
      `);
    }
  },
  {
    version: 11,
    name: 'phase6-decisions',
    up(db) {
      /* Phase 6B（D-057）：决策状态机、事件与交易关联（契约 §6.1）。
       *
       * decisions —— 一行 = 一条决策，绑定一条既有建议：
       *   - recommendation_id 用 ON DELETE RESTRICT（与 recommendations.assessment_id 同口径）：
       *     有决策引用时建议删不掉。这与 close_id 的「审计引用不设外键」不同 —— 建议与决策
       *     总在同一个事务集合里被清空与重建，顺序可控；
       *   - 唯一约束按名称显式建索引（不写内联 UNIQUE，与 v9 同纪律）：server/backup.js
       *     才能按名校验「一条建议最多一条决策」这条幂等不变量（契约 §6.5）；
       *   - 状态词表由 CHECK 兜底；last_seq 是每条决策内已追加的事件数（事件链的长度）。
       *
       * decision_events —— 一行 = 一次状态跳转，**只追加、永不 UPDATE**：
       *   - seq 每条决策内从 1 连续递增（UNIQUE(decision_id, seq) 具名索引兜底）；
       *   - occurred_at 是本地日历日（事件发生时的 ctx.today()），与 security_events.occurred_at
       *     同形状，承载月度归属（§5）；recorded_at 是 ISO 时刻，用于展示与排序兜底；
       *   - actor 恒为 'local-user'（服务端写入，客户端提交即 400）；
       *   - snapshot_json 是该时点的一次性封存（canonicalJson 文本），snapshot_hash = sha256
       *     原文，读取时按原文复算比对（§4.5）；payload_hash 覆盖事件行自身。
       *
       * decision_links —— 实际交易关联（6D 才有写入口，6B 只建表 + 全量写入校验）：
       *   - 软删除：unlinked_on IS NULL 表示活动；解绑保留行（unlinked_on/unlink_note），
       *     不删历史（"追加更正而非擦除"的落地形式）；
       *   - 部分唯一索引 uq_decision_links_active：一条证券事件同时最多属于一条决策
       *     （活动行唯一），数据库层兜底；
       *   - security_event_id 为 ON DELETE RESTRICT：解绑不删除行，外键引用随之保留，
       *     因此曾被关联（含已解绑）的证券事件一律不可物理删除（契约 §3.2 勘误口径）。
       *
       * 旧库前向迁移后三表为空：不伪造任何历史决策（与 v8/v10 同口径）。 */
      db.exec(`
        CREATE TABLE decisions (
          id                TEXT PRIMARY KEY,
          recommendation_id TEXT NOT NULL REFERENCES recommendations(id) ON DELETE RESTRICT,
          state             TEXT NOT NULL CHECK (state IN
                            ('proposed','accepted','deferred','dismissed','executed','reviewed','archived')),
          last_seq          INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE UNIQUE INDEX uq_decisions_recommendation ON decisions(recommendation_id);
        CREATE INDEX idx_decisions_state ON decisions(state, updated_at);
        CREATE INDEX idx_decisions_updated ON decisions(updated_at, id);

        CREATE TABLE decision_events (
          id            TEXT PRIMARY KEY,
          decision_id   TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
          seq           INTEGER NOT NULL CHECK (seq >= 1),
          from_state    TEXT NOT NULL CHECK (from_state IN ('proposed','accepted','executed')),
          to_state      TEXT NOT NULL CHECK (to_state IN
                        ('accepted','deferred','dismissed','executed','reviewed','archived')),
          reason_code   TEXT NOT NULL,
          note          TEXT,
          occurred_at   TEXT NOT NULL,
          recorded_at   TEXT NOT NULL,
          actor         TEXT NOT NULL CHECK (actor = 'local-user'),
          snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
          snapshot_hash TEXT NOT NULL,
          payload_hash  TEXT NOT NULL
        );
        CREATE UNIQUE INDEX uq_decision_events_seq ON decision_events(decision_id, seq);
        CREATE INDEX idx_decision_events_occurred ON decision_events(occurred_at, decision_id);

        CREATE TABLE decision_links (
          id                TEXT PRIMARY KEY,
          decision_id       TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
          security_event_id TEXT NOT NULL REFERENCES security_events(id) ON DELETE RESTRICT,
          linked_on         TEXT NOT NULL,
          linked_at         TEXT NOT NULL,
          note              TEXT,
          unlinked_on       TEXT,
          unlinked_at       TEXT,
          unlink_note       TEXT
        );
        CREATE INDEX idx_decision_links_decision ON decision_links(decision_id);
        CREATE UNIQUE INDEX uq_decision_links_active
          ON decision_links(security_event_id) WHERE unlinked_on IS NULL;
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
