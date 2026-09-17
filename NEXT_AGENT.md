# 下一位执行 Agent 入口

## 当前事实

- 2026-09-17 起：v3 **Phase 1–3 已完成并验收**；**Phase 4B「标的目录与分类确认」两轮独立复核补口及第三轮引用安全审计完成、等待独立复核确认**（G4B-1–12 全部修复）；**Phase 4C「持仓账本与证券事件」复核与完整性补口完成、等待独立复核确认**（G4C-1–9 已闭合）；**Phase 4D「日终行情、汇率与失败兜底」实现与自验完成、等待独立复核确认**（全量 441/441、4D 编排层 22/22、4D 真实 HTTP 7/7、wiring 21/21，口径冻结见 D-044）。Phase 4A 正式验收仍暂不通过。
- 已有 v3 能力：
  - 领域层：`js/domain.js`（资产模型、CNY/HKD/USD 定点折算、总览聚合与新鲜度状态、`computeCloseChecklist` 月结核对、`emergencyCoverageMonths` 应急金覆盖；4B 新增 `instrumentKey` / `EXPOSURE_MARKETS` / `diffInstrumentFields` / `suggestFromProvider` / `USER_JUDGEMENT_FIELDS`；4C 新增 `SECURITY_EVENT_TYPES`、`compareDecimals` / `sumQuantities` / `subtractQuantities` 定点数量助手与 `deriveHoldings` 唯一推导实现——期初 + Σ买入 − Σ卖出，分红/费用不改数量，strict 模式对卖出超额抛 `insufficient_holdings`；**4D 新增 `MANUAL_PROVIDER` / `MARKET_SCOPES` / `marketElementKey` / `marketGroupKey` / `marketRowDate` / `planMarketMerge`（元素键替换 + 手动值冻结）与 `requiredQuoteSymbols` / `requiredFxPairs`（更新目标只按事实推导）**；`ASSET_KEYS` 现为 10 键含 `securityEvents`）；
  - 服务层：`server/main.js`（入口/单实例锁/每日备份/token）、`server/api.js`（`/api/v1` + 静态托管 + 写门禁 + Phase 3 资源 upsert、换汇、手动汇率、月结与快照明细 + 4B 标的检索/建立/确认 + 4C 的 `POST /portfolio-openings`、`POST /security-events`（Idempotency-Key 回放）、`GET /security-events` + **4D 的 `POST /quotes`（手动补价，来源固定 `manual`）与 `POST /market-data/refresh`（不再是 501；开关只从服务端 settings 的 `marketDataAutoQuotes` 读取，不信任请求体）**）、`server/migrations.js`（v1–v3、v4 `uq_instruments_dedupe`、v5 `security_events.amount_minor` + 重放索引、v6 `uq_portfolio_openings_dedupe`、**v7 `phase4d-quote-source-symbol`：`quotes.source_symbol`，只加列不加索引**）、`server/db.js`、`server/repository.js`（全量写入按 schema 校验；4B 标的读写；4C 事件/期初读写与推导持仓视图；**4D 新增 `validateQuoteRow` / `validateFxRow`（单条与全量同一套校验，币种一律由标的推导）、`upsertManualQuote` / `upsertProviderQuote` / `upsertProviderFxRate`（拒绝冒充 `manual`；同组手动值冻结）、`replaceQuoteRows`**）、`server/backup.js`（`VACUUM INTO` 快照 + 按版本校验必需表/必需索引/必需列）、`server/keychain.js`、`server/login-item.js`；
  - Phase 4A 契约：`server/providers/contract.js`（请求序列化前校验、结果逐键严格、`assertValidResult` 落库门禁）、`server/providers/clock.js`、`server/providers/fixture.js`、`server/providers/SOURCES.md`（数据源证据档，**§8 = 2026-09-17 门禁复核原始输出与逐条对照表**）；
  - Phase 4B 编排层：`server/instrument-catalog.js`（稳定 id 按 identity key 派生永久锁定、去重键三路径显式拒绝、`confirmed` 本地锁定、冲突只提示不覆盖；D-039/D-041）；
  - **Phase 4D 编排层**：`server/market-data.js`（`refreshMarketData` 逐作用域报告 `updated | partial | failed | skipped`，`MAX_ATTEMPTS=2` 有限重试只在整批失败且至少一个错误可重试时整批重发；每次结果先过 `contract.assertValidResult` 再落库；任何失败只报告、零写入）、`server/providers/frankfurter.js`（**pin ECB 端点 `/v2/providers/ecb/rates`**，D-036）、`server/providers/keychain-key.js`（**惰性**读 Key，只返回布尔状态，密钥不进响应/日志）；
  - 前端：`js/store.js`（资源创建含 idempotencyKey、月结、快照、标的检索/建立/确认、4C 的 `listHoldings` / `listSecurityEvents`、**4D 的 `saveQuote` / `refreshMarketData`**）、`js/app.js`（资产决策台、资产录入页 `assets` 含标的目录区块 + 持仓与证券事件区块 + **行情（收盘价）区块**（逐标的卡片含价格/价格日/来源/新鲜度、`data-quote="<instrumentId>"` 可定位、手动补价弹层、启动时自动更新汇率开关、刷新入口）、月度结账页、现金流页；`APP_VERSION` = `2.3.10-phase4d`）、`sw.js`（缓存键 `ledger-v2.3.10-phase4d`）；
  - 运维：`start.command`、`scripts/install-login-item.sh` / `uninstall-login-item.sh`。
- **事实源：** SQLite（默认 `~/Library/Application Support/Ledger/ledger.db`）。API 模式下前端**完全不触碰 IndexedDB**；服务不可达时只读降级，绝不双写。资源 upsert 见 D-031，估值/追溯口径见 D-034，备份校验见 D-035，汇率源见 D-036，ETF 元数据来源见 D-037，行情源启用门禁见 D-038，标的目录口径见 D-039，结构校验覆盖不变量载体见 D-040，标的引用完整性见 D-041，持仓业务口径见 D-042，事件幂等原子性/证券账户门禁/事件往返保真见 D-043，**行情与汇率口径（默认关闭、手动值冻结、元素键、失败只报告、目标只按事实推导）见 D-044**。
- **行情现状：** 汇率已可自动更新（Frankfurter pin ECB 端点）；**行情自动抓取默认关闭**——D-038 六条门禁经 2026-09-17 逐条复测后没有任何候选通过（Stooq / Yahoo / Twelve Data demo / FMP / EODHD / Polygon / Finnhub 因条款、自动化授权或覆盖不达标被否；腾讯/东财可达但无自动化授权与稳定条款），价格以「手动补价 + 本地缓存」为唯一事实来源。门禁通过后只需接入 provider 并翻转服务端开关，编排/仓储/前端无需改动。**尚无** Phase 4E 能力：估值下钻（按资产类别/机构/币种/市场拆解）、持仓估值到数量/价格/价格日/汇率/provider 的完整追溯、证券价格影响与汇率影响的分离归因均未开始。
- Phase 4 已在 `ROADMAP.md` 拆成 **4A 数据源与契约 → 4B 标的目录 → 4C 持仓账本 → 4D 日终行情 → 4E 下钻归因**。每个任务只领取一个子阶段。4D 已交付；**进入 4E 前应先确认 4D 独立复核结论**。
- 测试基线：`node --test` **441/441 通过**（**必须在非沙箱、真实用户身份下运行**——Keychain 用例在沙箱内会被拦截）；4D 编排层 `providers-marketdata` 22、4D 真实 HTTP `server-phase4d` 7、4C 真实 HTTP `server-phase4c` 20、领域 `domain-phase4c` 19、迁移 16、`instrument-catalog` 48、`server-phase4b` 17；浏览器 wiring **21/21**（干净环境连续两轮全绿）。数据库 schema 版本 **v7**。
- 遗留：登录项端到端（重启 Mac 自动打开）留待用户在本机手动执行；「15 分钟完成一次月结」的真实耗时按计划留到 Phase 7 验证；**行情主源端点仍未选定**（D-038 门禁未通过），4E 的估值与归因**必须在"行情可能长期缺失"的前提下设计**。

## 你的任务

**只实施 Phase 4E「估值下钻与收益归因」**。不要回改 4B 目录语义、4C 持仓口径与 4D 行情/汇率口径。

**开工前置（先做完再写代码）：**

1. 确认 4B / 4C / 4D 的独立复核结论已收到（先查 `PHASE4B_ACCEPTANCE_GAPS.md`、`PHASE4C_ACCEPTANCE_GAPS.md` 与 ROADMAP 各阶段的状态行；若提出新问题，先修复再进 4E）；
2. 明确 4E 的**数据前提**：本阶段**不接任何新数据源**、**不开启行情自动抓取**（D-038 门禁状态未变），估值输入只有四类既有事实——`quotes`（手动补价为主，`provider` 可能是 `manual`）、`fx_rates`（自动或手动）、`portfolio_openings` + `security_events`（推导持仓）、`account_units` / `liabilities` / `entitlements`（余额）。**设计必须能回答"这条估值用的是哪天的价格、来自哪个 provider、汇率是哪一天的"**，并在任一输入缺失或过期时明确降级。

开始前按 `AGENTS.md` 的顺序完整阅读全部 v3 文档，然后：

1. 检查 git 状态与未提交修改，运行并记录 **441 项**基线测试（`node --test`，非沙箱）与浏览器 wiring 21 项；
2. 给出 Phase 4E 的文件级计划和回滚边界（**估值与归因口径只有一份实现，必须落在 `js/domain.js`（D-025）**，服务端不得另写一套）；
3. 估值下钻：按资产类别、机构、币种与市场拆解；每个持仓的估值可追溯到数量（`deriveHoldings`，不得另写第二套推导）、价格、价格日、汇率与 provider；
4. 收益归因：把**证券价格变化**与**汇率影响**分开计算并各自可复算，同时显式说明**无法归因的边界**（例如期间有买卖/分红、价格日不连续、缺少期初价格或汇率）。不得用"看起来合理"的插值补齐缺失的价格/汇率；
5. 接入资产决策台与月结快照：**旧快照必须仍可读**（不改变既有快照 payload 的语义，新增字段只能追加）；
6. 行情过期/缺失时的降级语义：**保留估算展示，但阻止正式建议**（沿用既有 `quote_stale` / `fx_stale` / classifier 阻塞项的语义，不得新增与既有 blocker 冲突的第二套判定）；
7. 完成 `ACCEPTANCE.md` S4E.1 后，只把 ROADMAP 的 4E 标为完成，并把 `NEXT_AGENT.md` 改为仅领取下一阶段（Phase 5）。

## 禁止事项

- 不删除或重写已通过测试的 `core.js`/`domain.js` 纯逻辑与现有测试；不改动 Phase 4A 的 provider 契约语义（如确需扩展应加新测试而非改语义）、Phase 4B 的目录语义（D-037/D-039/D-040/D-041）、Phase 4C 的持仓口径（**`deriveHoldings` 是持有数量的唯一实现，不得另写第二套推导**；同 id 事件重放必须 409；期初日期边界（D-042 ⑦）与期初全路径唯一性（D-042 ⑧）不得回退）与 **Phase 4D 的行情/汇率口径（D-044：默认关闭、手动值冻结"同一天或更早"、元素键由写入路径强制、失败只报告不改动旧值）**。
- **D-038 门禁未通过前不得开启自动行情抓取**；不得引入付费数据源；自动测试一律离线（fixture），不访问真实行情网络。
- 不把 IndexedDB 与 SQLite 做成长期双向写入；切换必须按 ARCHITECTURE §9 的顺序。
- 本地服务只绑定 `127.0.0.1`；不为调试改绑 `0.0.0.0`。
- API Key 不入库、不进前端、不进测试 fixture、不进日志。
- 外部行情请求不得携带账户名、余额、数量、成本或任何私人财务事实（D-020）；请求产物只允许公开代码/币对。
- 不在服务端另写一套聚合/推导口径去替代 `js/domain.js`（D-025/D-001）。
- 不信任载荷中可由关联记录推导的冗余字段（D-035）。
- 不要用 `node:sqlite` 的在线 `backup()`；备份快照统一走 `server/backup.js` 的 `VACUUM INTO` 路径（ARCHITECTURE §13.2）。
- 不要给写接口放行缺 `Content-Type` 的请求（D-026）；若需新增列才加迁移版本，并同步 `server/backup.js` 的 `REQUIRED_TABLES_BY_VERSION`、`REQUIRED_INDEXES_BY_VERSION` 与 `REQUIRED_COLUMNS_BY_VERSION`（D-035/D-040）。
- 不覆盖用户已有未提交修改，不删除旧测试换取绿色结果。

## 可直接复制给执行 Agent 的任务描述

> 阅读项目根目录的 README.md、PRODUCT.md、ARCHITECTURE.md、ROADMAP.md、DECISIONS.md、ACCEPTANCE.md、AGENTS.md 和 NEXT_AGENT.md。只实施 ROADMAP Phase 4E「估值下钻与收益归因」，不开始 Phase 5，也不回改已完成的 4B 目录语义、4C 持仓口径与 4D 行情/汇率口径（D-044）。**开工前先确认 4B/4C/4D 的独立复核结论已收到（查 `PHASE4B_ACCEPTANCE_GAPS.md`、`PHASE4C_ACCEPTANCE_GAPS.md` 与 ROADMAP 各阶段状态行），并记住 4E 的数据前提：不接任何新数据源、不开启行情自动抓取（D-038 门禁状态未变），估值输入只有既有的 quotes（可能来自手动补价）/ fx_rates / 期初+事件推导持仓 / 余额事实。** 先检查 git 状态、在非沙箱下运行 441 项基线测试与 21 项浏览器 wiring，再给出文件级计划与回滚边界。实现：① 按资产类别、机构、币种与市场下钻；② 每个持仓估值可追溯到数量（复用 `deriveHoldings`）、价格、价格日、汇率与 provider；③ 把证券价格变化与汇率影响分开且各自可复算，显式说明无法归因的边界（有买卖/分红、价格日不连续、缺期初价格或汇率），不得插值补齐缺失数据；④ 接入决策台与月结快照，旧快照保持可读（只追加字段）；⑤ 行情缺失或过期时保留估算展示但阻止正式建议，沿用既有 blocker 语义。估值与归因口径只能有一份实现且必须落在 `js/domain.js`（D-025）。不得开启自动行情抓取、不得引入付费源、自动测试不得访问真实网络；不得改动 4A 契约语义、4B 目录语义（D-037/D-039/D-040/D-041）、4C 持仓口径（D-042，`deriveHoldings` 唯一推导）与 4D 行情口径（D-044）；不得在服务端另写聚合口径（D-025），不得信任可推导冗余字段（D-035），不得双写 IndexedDB，不得放行缺 Content-Type 的写请求（D-026），备份一律走 `VACUUM INTO`。完成 S4E.1 后更新证据，并把 NEXT_AGENT 入口切到只实施 Phase 5。
