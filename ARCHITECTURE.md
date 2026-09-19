# Ledger 架构设计

> 对应产品范围：[PRODUCT.md](./PRODUCT.md)  
> 实施顺序：[ROADMAP.md](./ROADMAP.md)

## 0. 文档性质与实现状态

本文描述目标架构，不描述已经存在的能力。后续 Agent 必须按 ROADMAP 分阶段落地，不能把目标图当成当前系统图。

截至 2026-09-19，Phase 1（资产领域基础）、Phase 2（本地服务与 SQLite）、Phase 3（账户、负债与月度结账）、Phase 4B（标的目录与分类确认）、Phase 4C（持仓账本与证券事件）、Phase 4D（日终行情、汇率与失败兜底）与 Phase 4E（估值下钻与收益归因，含第一轮与第二轮复核补口）与 Phase 5A（风险问卷与配置规则冻结）已落地：已有 `js/domain.js` 领域模型、资产决策台、`server/` 下的本地服务与 SQLite（迁移器、repository、备份恢复、Keychain 适配器、登录项脚本）、前端存储门面 `js/store.js`；Phase 4A 的 provider 契约（`server/providers/contract.js`）、固定时钟与离线 fixture 已完成，Phase 4B 的标的检索/候选/元数据缓存/预分类/确认锁定与稳定标的 id 已可用（`server/instrument-catalog.js`、`/api/v1/instruments*`、资产页「标的目录」区块），Phase 4C 的期初快照与证券事件写入、推导持仓视图与资产页「持仓与证券事件」区块已可用（`POST /portfolio-openings` / `POST|GET /security-events`、`deriveHoldings` 唯一推导、迁移 v6，口径见 D-042 ⑦⑧）；Phase 4D 的行情/汇率编排层（`server/market-data.js`）、Frankfurter 汇率源（**pin ECB 端点** `/v2/providers/ecb/rates`，D-036）、Keychain 惰性读 Key 与手动补价兜底已可用（`POST /api/v1/quotes`、`POST /api/v1/market-data/refresh`、迁移 v7 的 `quotes.source_symbol`、资产页「行情（收盘价）」区块，口径见 D-044），其中**行情自动抓取默认关闭**——D-038 的六条启用门禁经 2026-09-17 逐条复测后无候选通过（证据见 `server/providers/SOURCES.md` §8），开关只认服务端 settings，门禁通过后仅需接入 provider；Phase 4E 的估值下钻与收益归因已可用（`js/domain.js` 的 `computeAssetDrilldown` / `computeReturnAttribution` / `computeAttributionBaselinePositions` / `baselinePositionsFromSnapshot` / `findQuoteAsOf` / `findFxRateAsOf` / `holdingsAsOf`、决策台「估值下钻」与「收益归因」两个区块、月结快照封存的 `attribution` 与 `attributionPositions` 字段），四个下钻维度与总览共用 `valueAssetItems` 的**同一遍**估值、「价格影响 + 汇率影响」逐行恒等于估值变化、as-of 查询绝不返回未来行；**归因期初腿只认封存明细（D-045 ⑨，G4E-1 复核补口）**——期初数量/价格/汇率只来自快照 payload 的 `attributionPositions`（基准月末 as-of 口径封存，重算前校验快照原文哈希），绝不按当前事实表倒算，结账后回填旧业务日期事实改写不了已结账月的归因，本轮**零新数据源、零迁移**；4B 同日完成独立复核**两轮**补口 —— 标的 id 只能由服务端按首次创建时的 identity key 派生并永久锁定、去重键在所有写入路径（含全量 `/state`）强制并由迁移 v4 唯一索引兜底、同代码跨市场报 `ambiguous_instrument`、全量写入逐条校验（非法记录整体拒绝而非静默丢行）、备份结构校验按版本覆盖必需索引（D-040）、检索合并与建立路径共用同一套退化匹配。**尚无**行情自动抓取（4D 交付的是"门禁就绪但未开启"）。Phase 5A 已冻结风险问卷与配置规则（D-046）：题库与分值（能力 5 题 / 意愿 4 题）、等级边界（下界含入）、4 条硬封顶（只降不升）、5 级目标区间模板（六类 basis points、Σtarget 精确 100%、个股 target 恒为 0）、容忍带、复评词表与有效期、稳定错误码、建议输入输出契约与排序 / 尾差规则，都在 `js/domain.js`（唯一实现，浏览器与服务端共用），冻结副本为 `tests/fixtures/phase5-risk-rules.json`；全部对外规则常量**递归冻结**（`deepFreezeRisk`，第 1 轮复核 G5A-1 补口），内部评分与查表逻辑不消费调用方可改的引用，需要副本的调用方走 `riskCatalog()` / `targetTemplateForLevel()` 的深拷贝；但**尚未**有 `risk_assessments` 持久化、风险评估 API 与问卷页面（5B 起），也**尚未**有决策状态机（Phase 6 起）。

## 1. 架构原则

- 在原项目上增量演进，不从零重写已验证的账单解析和账务逻辑。
- 财务事实、市场数据、规则计算、解释文本和用户判断分层保存。
- SQLite 是目标唯一事实源；浏览器内存和页面状态不是事实源。
- 所有自动化失败都成为可见状态，不静默吞错或使用过期数据冒充最新结果。
- 金额使用整数最小货币单位；数量和价格使用定点十进制字符串，禁止二进制浮点直接承担财务账务。

## 2. 当前系统

当前是"本地服务 + 原生 HTML/CSS/JS 前端"的单机架构：

- `server/main.js`：启动入口（配置解析、单实例锁、迁移、每日备份、随机 session token、仅 127.0.0.1 监听、优雅退出），并提供 `--self-check` / `--migrate-only` / `--print-config`；
- `server/api.js`：`/api/v1` 与静态托管；HTML 注入 session token，写接口校验 token + Origin + Content-Type，无 CORS、无预检；
- `server/migrations.js` / `server/db.js` / `server/repository.js`：SQLite Schema、连接与事务助手、十类资产事实集合读写（v3 九类 + 4C 的 `securityEvents`）；
- `server/backup.js`：`VACUUM INTO` 快照、校验、原子替换、30 份保留、恢复与回滚（见 §13.2）；
- `server/keychain.js` / `server/login-item.js`：Keychain 适配器（读写探测；行情 Key 经 `providers/keychain-key.js` 惰性读取）与 LaunchAgent 渲染/安装/卸载；
- `server/providers/`：provider 契约与五类错误码（`contract.js`）、固定时钟（`clock.js`）、离线 fixture（`fixture.js`）、汇率源（`frankfurter.js`，pin ECB 端点）、行情 Key 惰性读取（`keychain-key.js`）；`server/market-data.js` 负责行情/汇率刷新编排（逐作用域报告、有限重试、落库前契约校验、手动值冻结）；
- `js/store.js`：前端存储门面。API 模式完全不触碰 IndexedDB；服务不可达时只读降级，绝不双写（见 §13.3）；
- `js/core.js` / `js/domain.js` / `js/charts.js` / `js/app.js` / `js/db.js`：解析、去重、统计、领域模型、图表、界面；`js/db.js` 在 API 模式下只剩历史数据导出与只读降级用途；
- `sw.js`：静态资源缓存（当前应用未注册 Service Worker，见 TEST.md 观察项）。

可复用资产是已经由 Node 测试覆盖的纯逻辑和账单导入交互。已解决的限制：浏览器数据难以自动备份（现由服务端每日备份 + 30 份保留覆盖）、API Key 无法安全保存（现由 Keychain 适配器覆盖）、KV Schema 不适合持仓与快照关系查询（现由 SQLite 关系表覆盖）。

仍未满足的目标架构能力：开机自动打开端到端、行情自动抓取（编排与契约已就绪，源受 D-038 门禁默认关闭）、规则引擎（Phase 5A 已冻结规则与契约，5B 起落地实现）、决策状态机（Phase 6）。

## 3. 目标系统

```text
macOS 登录项
    │
    ▼
本地应用服务（仅 127.0.0.1）
    ├── 静态前端与本地 JSON API
    ├── SQLite repository
    ├── 行情/汇率 provider adapters
    ├── 月度结账与规则引擎
    ├── 本地知识卡
    ├── macOS Keychain adapter
    └── 本地备份与恢复
             │
             ▼
        浏览器决策台
```

过渡期先在 `core.js` 建立可测试的领域函数，并扩展现有页面；本地服务和 SQLite 接入后替换 `db.js`，不重写领域逻辑。

### 3.1 进程与数据所有权

- 浏览器前端只负责展示、输入校验和交互，不直接访问行情 provider 或 SQLite 文件。
- 本地服务是唯一写入者，负责事务、迁移、行情调度、备份和规则计算调用。
- SQLite 是目标事实源；备份是恢复介质，不参与正常查询。
- 外部行情与官方规则只提供公开事实，不成为用户账户、持仓或决策的事实源。
- Domain Core 不持有全局状态；相同输入和规则版本必须产生相同输出。

## 4. 组件边界

### 4.1 Domain Core

纯函数，不访问 DOM、网络或数据库：

- 多币种金额折算；
- 账户、负债、持仓和净资产聚合；
- 资产类别与风险敞口汇总；
- 数据新鲜度判断；
- 应急金区间；
- 风险问卷评分；
- 目标配置偏离和新增资金分配；
- 决策状态机；
- 备份 Schema 校验。

### 4.2 Local Service

- 绑定 `127.0.0.1`，不绑定 `0.0.0.0`；
- 提供版本化 `/api/v1` 接口；
- 管理 SQLite 事务、迁移、备份和恢复；
- 从 Keychain 读取行情 API Key；
- 统一执行超时、限流、缓存、重试和来源记录；
- 不提供券商交易接口。

Phase 2 已落地其中的接口版本前缀、事务/迁移/备份恢复与 Keychain 读取路径；限流、缓存、重试与行情调度属 Phase 4。未实现的写接口按资源边界返回 `501` 并说明所属阶段，而不是 `404`（见 `server/api.js` 的 `DEFERRED_WRITES`）。

### 4.3 Frontend

- 首页资产决策台；
- 现金流、持仓、负债、受限资产和设置的下钻页面；
- 所有异步请求显示 `loading/success/stale/error`；
- 所有建议展示输入数据版本和计算版本；
- 原记账和导入页面继续工作，逐步改为调用本地 API。

Phase 2 起，前端所有持久化读写必须经 `js/store.js` 门面，禁止页面代码直接调用 `DB.loadRaw/saveAll`；这样"事实源在哪"只有一个判断点（见 §13.3）。

## 5. 核心数据模型

### 5.1 主体与账户

- `institutions(id, name, kind)`：银行、券商、政府账户机构。
- `accounts(id, institution_id, name, kind, pool, status)`。
- `account_units(id, account_id, currency, balance_minor, as_of, source_type)`：币种子账户或明确余额单元。
- `asset_transfers(id, from_unit_id, to_unit_id, from_currency, to_currency, from_amount_minor, to_amount_minor, occurred_on, source_type)`：换汇资产转移；两端事实独立保存，不进入现金流收支。
- `liabilities(id, account_id, currency, balance_minor, due_date, term_type, as_of)`。
- `entitlements(id, kind, jurisdiction, status, balance_minor?, valuation_type, as_of, source_ref)`。

`pool` 只允许 `safety/investable/restricted/entitlement`。权益无明确余额时 `balance_minor` 必须为空，不能写 0 冒充已核实余额。

### 5.2 证券与持仓

- `instruments(id, symbol, exchange, currency, name, instrument_type, asset_class, exposure_market, classification_status)`。
- `portfolio_openings(id, account_id, instrument_id, quantity, cost_minor, as_of)`。
- `security_events(id, account_id, instrument_id, event_type, quantity, price_minor, fee_minor, currency, occurred_at, amount_minor)`（迁移 v5 加 `amount_minor`）。
- `quotes(instrument_id, price_minor, currency, price_date, fetched_at, provider, status)`。
- `fx_rates(base, quote, rate_decimal, rate_date, fetched_at, provider, status)`。

`classification_status` 只允许 `suggested/confirmed`。外部分类变化不得覆盖 `confirmed`。

**持仓账本与证券事件（D-042，4C）：**

- 持有数量的**唯一推导实现** = `js/domain.js` 的 `deriveHoldings`：数量 = 期初快照 + Σ买入 − Σ卖出；分红/费用只记金额、不改数量；买入可无期初（从 0 起算）；事件按 `occurred_at` 升序重放。**期初日期边界（D-042 ⑦）**：期初快照数量为期初日**日初**数量——`occurred_at` 严格早于期初 `as_of` 的事件视为已含在快照内，不再叠加、不进计数与活动时间戳（记入 `boundarySkippedEvents` 留痕）；期初日当天及以后的事件正常叠加。`computeOverview` / `computeCloseChecklist` / `GET /holdings` 有事件时共用该推导，无事件时与期初口径一致（零回归），三处不会分叉。
- 事件类型词表 `buy/sell/dividend/fee`；`occurred_at` 为**真实存在的** `YYYY-MM-DD`（日历日校验，`2026-02-30` 拒绝，G4C-5）；buy/sell 必填 `quantity`（正定点数 ≤8 位小数）且禁止携带 `amount_minor`；dividend/fee 必填 `amount_minor`（正整数），可选 `quantity` 若提供也必须为正定点数并原样保留，但绝不参与数量变化。`price_minor` 只存每股价格，不做字段混用；未知扩展字段经 `extra_json` 无损往返。
- 显式拒绝（不静默吞）：同 id 重放 → 409 `duplicate_event`；HTTP 重试的 `Idempotency-Key` 与请求指纹绑定，复用到不同请求体 → 409 `idempotency_conflict`，且事件事实与幂等记录在**同一事务**提交（G4C-7）；卖出超过当时推导数量 → 409 `insufficient_holdings`（写前 strict 时间线重放，失败整体回滚；**期初写入（新建与更新）后同样在同一事务内 strict 全时间线重放**，G4C-2）；同一（账户, 标的）第二行期初 → 409 `duplicate_opening`；未知账户/标的或非证券账户分别 → 422 `unknown_*` / `invalid_account_type`。全量 `PUT /state` 与单条写入同一套校验（期初与事件均逐条查引用；持仓只允许 `kind=broker`；缺 id / 同键二期初整体拒绝，绝不静默丢行，G4C-3/G4C-8），并由迁移 v6 唯一索引 `uq_portfolio_openings_dedupe(account_id, instrument_id)` 数据库兜底。
- 证券事件**绝不写 `txns`**（不重复计入现金流），现金余额由余额单元人工核对（D-034/D-042 ④，事件不自动改写）；币种只由标的 `currency` 推导，载荷中的冗余 currency 不采信也不能经 extra 覆盖（G4C-9）；事件重放索引 `(account_id, instrument_id, occurred_at)`（迁移 v5）；备份结构校验按版本覆盖必需表、必需索引与**必需列**（v5+ 要求 `security_events.amount_minor`，G4C-6）。

**标的身份与去重（D-039，4B 复核补口后）：**

- `id` **只能由服务端派生**：新建时按「首次创建时的 identity key」（`symbol@exchange`，大写与空白归一；交易所缺失则为 `symbol@`）派生 `inst-<sha1(identityKey) 前16位>` 一次，**此后永久不变** —— 补全交易所也不重算。`identity_key`（含 `source` / `country` / `exchange_timezone` / provider 候选与 provenance / 冲突提示）随记录存 `extra_json`，读回零丢失；外部用它离线复算 id。建立载荷里客户端指定的 `id` 一律拒绝（`client_id_forbidden`）；`PUT /state` 与备份恢复通道原样还原既有 id（历史快照带旧形状 id，强制派生会破坏备份往返保真），该通道的强约束是去重键。
- 去重键 `(symbol, exchange)` 是**全路径**不变量：目录接口、单条 upsert、全量 `PUT /state` 都显式拒绝同键第二行（`duplicate_instrument` → 409 + 事务回滚，从不静默删行或丢行）；迁移 **v4** 的表达式唯一索引 `uq_instruments_dedupe` 在数据库层兜底（迁移遇到历史重复数据显式失败）。交易所缺失时的退化匹配**只在唯一命中时生效**，同代码跨市场存在多行时报 `ambiguous_instrument`（409）要求用户指明交易所，不按行顺序静默合并。
- 全量写入**逐条校验**（第二轮复核 G4B-5）：`repository.writeInstruments` 先逐条验证并归一（id 必填且形状合法、`symbol` 去空白后必须符合公开证券代码形状、`currency` 必填且在白名单内、记录必须是对象），再校验去重键，任一条不合格即抛错并由 `writeState` 的事务整体回滚 —— 不允许"过滤掉非法行"式的静默丢数据（缺 id 的行会无声消失、空白代码会变形落库）。领域错误码统一映射为 **400**。
- 检索合并与建立路径**共用同一套本地匹配规则**（第二轮复核 G4B-7，`instrument-catalog.matchLocalRecord` ↔ `repository.findInstrumentByKey`）：精确命中 → 同代码且一方缺交易所时唯一命中可安全合并 → 多命中报 `ambiguous_instrument` 且不合并。合并只补空的展示字段，**不进入 `suggestions`**（预分类依据必须仍指向 provider），检索保持只读、不改写本地事实。

### 5.3 结账与决策

- `monthly_closes(id, month, status, completed_at, data_cutoff)`。
- `snapshots(id, close_id?, captured_at, snapshot_type, payload_hash)`。
- `risk_assessments(id, capacity_score, willingness_score, risk_ceiling, answers_json, assessed_at, reason)`。
- `allocation_targets(id, asset_class, min_pct, target_pct, max_pct, effective_from)`。
- `decisions(id, snapshot_id, state, recommendation_json, explanation_version, reason, created_at, updated_at)`。
- `decision_events(id, decision_id, from_state, to_state, note, occurred_at)`。

### 5.4 现金流

现有交易模型继续保留。迁入 SQLite 时拆为正规表，但 `core.js` 的行为接口保持稳定。跨源候选关系与确定性重复指纹分开存储，确保“自动拦截”和“人工确认”不会混淆。

### 5.5 数据不变量

- 金额字段以对应币种的最小单位保存，并与 `currency` 同时存在。
- 数量、价格和汇率必须用可精确序列化的定点十进制；不允许浮点累计后再“修正”。
- `balance_minor = null` 表示没有明确余额；`0` 只表示已确认余额确实为零。
- 一条持仓必须指向一个标的和一个证券账户；同一标的可存在于多个账户。
- 初始持仓快照与后续证券事件不能重复贡献数量或成本。
- 每个报价和汇率必须携带数据日期、抓取时间、来源和状态。
- 每次正式建议必须绑定不可变快照、规则版本与风险评估版本。
- 删除财务事实优先使用可审计的软删除；月结快照和决策事件不得级联丢失。

### 5.6 建议的最小 API 面

具体技术栈由 Phase 2 决定，但资源边界保持稳定：

```text
GET    /api/v1/overview
GET    /api/v1/institutions
POST   /api/v1/accounts
POST   /api/v1/account-units
GET    /api/v1/asset-transfers
POST   /api/v1/asset-transfers
POST   /api/v1/liabilities
POST   /api/v1/entitlements
GET    /api/v1/holdings
GET    /api/v1/instruments
GET    /api/v1/instruments/search?q=
POST   /api/v1/instruments
POST   /api/v1/instrument-confirmations
  # 400 client_id_forbidden（客户端指定 id）/ invalid_*；409 duplicate_instrument、ambiguous_instrument；422 invalid_provider_payload；503 provider_unavailable
POST   /api/v1/portfolio-openings
  # 4C 已实现：同 id 幂等更新；同 (账户, 标的) 第二行 → 409 duplicate_opening；未知引用 422
POST   /api/v1/security-events
  # 4C 已实现：支持 Idempotency-Key 回放；同 id → 409 duplicate_event；卖出超额 → 409 insufficient_holdings；未知引用 422；GET /api/v1/security-events 同步可用
POST   /api/v1/market-data/refresh
  # 仍 501（4D）；受 D-038 门禁约束，门禁未通过前自动抓取保持关闭
POST   /api/v1/monthly-closes
POST   /api/v1/risk-assessments
POST   /api/v1/recommendations
POST   /api/v1/decisions/{id}/events
POST   /api/v1/backups
POST   /api/v1/restores
```

写请求必须支持幂等键或等价重复保护。错误响应至少包含稳定错误码、用户可读信息和是否可重试；不得只返回自由文本堆栈。

## 6. 计算口径

- `总资产 = 流动资产 + 投资资产 + 有明确余额/估值的受限资产`。
- `净资产 = 总资产 - 总负债`。
- `可投资资产 = 标记为 investable 的现金与证券`。
- `可新增投资资金 = 可投资现金 - 近期应付款 - 未满足的安全储备缺口`，下限为 0。
- 所有汇总先按原币种计算，再使用同一估值日的汇率折算为 CNY。
- 证券收益与汇率影响分别计算；首页不使用当日盈亏驱动配置建议。
- 未完成月度结账或关键数据过期时，结果状态为 `estimate`，不得生成 `formal` 建议。

## 7. 行情与汇率

定义统一 provider 接口：

```text
searchInstrument(query)
getEndOfDayQuotes(instruments, asOf)
getFxRates(pairs, asOf)
getInstrumentMetadata(instrument)
```

MVP 可配置一个主数据源和手动 provider。Phase 4B 已落地 `searchInstrument(query)` 与 `getInstrumentMetadata(symbol)` 的契约与**离线 fixture** 实现（`server/providers/fixture.js` 的 `CATALOG`，不发真实网络），供标的目录使用；`getEndOfDayQuotes` / `getFxRates` 目前仍只有契约与 fixture，真实接入属 4D。**行情主源在接入前必须先通过 `DECISIONS.md` D-038 的启用门禁**（官方条款与自动化授权、可复核 API 版本、调用限额、认证方式、市场覆盖声明、失败语义映射）；门禁通过前自动抓取默认关闭，行情以手动补价 + 本地缓存为事实来源。每次响应必须保存 provider、价格日期、抓取时间和原始代码，并在落库前经 `server/providers/contract.js` 的 `assertValidResult` 校验 —— 不可入账的数据（负价、零汇率、假日期、无时区时间戳）一律拒绝写入。失败采用有限重试；超过阈值后保留最后有效值并标记 stale，不级联删除历史行情。

提供方不得收到账户名、持仓数量、成本、余额或决策信息。请求代码列表本身可能暴露关注标的，这一残余风险已接受。

### 7.1 自动刷新时序

1. macOS 登录项启动本地服务；单实例锁阻止重复写入进程。
2. 服务读取本地标的代码与所需币种对，只构造最小公开查询集合。
3. 若当日尚未成功刷新，则并发受限地请求 provider；节假日接受最近有效交易日。
4. 先校验响应，再在单个事务中写入新行情；旧有效行情不得被错误响应覆盖。
5. 页面打开后读取刷新状态：`loading/success/stale/error/provider_limited`。
6. 自动刷新失败不阻止查看历史估值，但必须阻止正式建议；用户可输入手动值并看到其来源。

## 8. 安全与隐私

- 不做应用登录、独立密码或二次解锁；依赖 macOS 用户账户和设备安全。
- 本地 HTTP 服务只监听 loopback，并使用随机 session token 防止其他本机网页跨站调用写接口。
- 写接口验证 Origin、Content-Type 和 session token。
- API Key 使用 macOS Keychain；日志中必须脱敏。
- 不调用云端 AI，不上传财务数据。
- 不采集埋点，不开启远程管理端口。

## 9. 备份、迁移与恢复

- SQLite 写事务完成后按节流策略创建版本备份，至少每日一份，保留最近 30 份。
- 备份先写临时文件并校验，再原子替换目标文件。
- 快照使用 SQLite 自身的 `VACUUM INTO`，产物自包含；不使用 `node:sqlite` 的在线 `backup()`（原因见 §13.2）。
- JSON 导出包含 `schemaVersion/exportedAt/sourceVersion`。
- 恢复前自动备份当前数据库；恢复在临时数据库校验完成后切换；切换失败必须把原库放回原位。
- 当前浏览器无真实数据，因此不开发 IndexedDB 历史迁移器；旧应用保留为代码回滚参考。

迁移顺序必须是：建立新 Schema → 用虚构数据验证 → 创建空库备份 → 切换前端读取 → 切换单一写入 → 验证后才停止旧数据层。任何时刻不得长期保持 IndexedDB 与 SQLite 双向写入。Phase 2 开始前若发现真实旧数据，必须先补充一次性导出、校验、导入和回滚方案。

## 10. 失败状态

- `quote_stale`：行情过期，展示估算，阻止正式建议。
- `balance_stale`：关键现金或负债余额未在本月确认。
- `close_incomplete`：月度结账未完成。
- `classification_unconfirmed`：新标的分类未确认，不进入正式配置分析。
- `dedup_review_required`：存在跨来源候选，等待人工核对。
- `backup_failed`：不阻止只读查看，但阻止高风险批量写入并提示修复。
- `provider_limited`：免费额度或市场权限不足，允许手动补价。
- `fx_stale`：汇率过期，外币估值可展示为估算但不能进入正式建议。
- `migration_required`：发现旧数据但没有安全迁移路径，禁止切换事实源。
- `write_conflict`：幂等键或版本冲突，保留现有事实并要求用户核对。

## 11. 测试策略

- Domain Core 使用 `node:test` 做行为测试，不测内部实现。
- 本地服务使用临时 SQLite 数据库做 repository、迁移、事务和 API 测试。
- 行情使用固定 fixtures，不在自动测试中依赖真实网络。
- 浏览器验收覆盖首页、录入、月度结账、过期阻断、决策状态和旧记账回归。
- 每个 Schema 迁移必须有向前迁移测试和备份恢复测试。

## 12. 演进门槛

- 只有免费行情成为连续阻塞才引入付费服务。
- 只有人工交易维护超过阈值才引入券商只读导入。
- 只有 Mac 单机造成已验证阻塞才设计同步。
- 不以“技术更先进”为理由引入 Electron、云数据库、消息队列或微服务。

## 13. 实施前技术门禁

Phase 1 可以直接开始，前提是旧 99 项测试持续通过。Phase 2 在选定本地运行时前必须做一个只读技术验证，证明：SQLite 驱动可用、服务能只绑定 loopback、可创建单实例锁、可从 macOS Keychain 读取测试密钥、可安装和卸载登录启动项。验证不应写入真实财务数据或提交测试密钥。

### 13.1 Phase 2 验证结论（2026-09-14，只读，未写入真实财务数据）

运行时选定 **Node.js**（DECISIONS T-001），理由：`node:sqlite` 为内建模块、零外部依赖；`js/domain.js` 是 UMD 模块，服务端与浏览器可直接共用同一份领域代码（`server/api.js` 的 overview 即调用它），避免口径分叉。

| 门禁项 | 验证方式 | 结论 |
|---|---|---|
| SQLite 驱动可用 | `node:sqlite` 的 `DatabaseSync` 建库、建表、读写、`integrity_check`、WAL/外键/`synchronous=FULL` | ✅ 可用 |
| 只绑定 loopback | `server.listen(port, config.HOST)`，`config.HOST` 硬编码 `'127.0.0.1'`，不读环境变量、无改绑分支；实测非 loopback 不可达 | ✅ 通过 |
| 单实例锁 | `wx` 独占创建锁文件并写入持有者 pid；启动时检测 pid 是否存活并清理陈锁；第二实例实测被拒 | ✅ 通过 |
| Keychain 读取 | `server/keychain.js` 经 stdin（不进 argv）读取；`selfCheck()` 只探测可用性、不创建条目、不返回值 | ✅ 通过 |
| 登录启动项 | `server/login-item.js` 渲染 plist → `plutil -lint` 校验 → 写文件；`install` 默认只写文件，`--activate` 才 `launchctl bootstrap`；`uninstall`/`status` 齐备 | ✅ 通过（未在验证中真正加载） |

### 13.2 备份原语的实现约束（实测结论）

- **不要用 `node:sqlite` 的在线 `backup()`**：实测在同一进程内第 1–2 次调用约 1ms，之后每次约 8 秒，且在本机测试运行器下会直接挂死。生产进程虽然每次写事务最多调用一次，但长期运行后每次保存都会出现秒级卡顿，不可接受。
- **改用 SQLite 自身的 `VACUUM INTO`**：同步、结果确定、产物自包含（不带 `-wal/-shm`），实测稳定 0–1ms，且读的是含 WAL 未落盘内容的一致性视图。
- **一致性前提**：单实例锁保证同一时刻只有一个写进程，且 `createBackup` 只在写事务之外调用（§9），因此快照期间不存在并发写入。若将来放开多写进程，必须重新评估该前提。
- 校验（`integrity_check` + 必需表齐备 + **该 schema 版本的必需索引存在且唯一** + schema 版本不高于已知版本）必须无副作用：只清理"本次打开新产生"的同伴文件，绝不删除调用前就存在的活跃库 `-wal`。索引级不变量是必需的 —— 迁移器只在"版本未应用"时执行，索引被手工删掉后 `schema_migrations` 仍写着该版本，恢复时不会重建（D-040）。

### 13.3 事实源切换的落地方式（§9 的具体化）

- 前端经 `js/store.js` 门面访问数据，**不做双向写入**；API 模式下完全不触碰 IndexedDB。
- 服务不可达时进入**只读降级**：既有数据仍可查看与导出，但拒绝任何写入并显示显著横幅。宁可只读，也不允许两份数据分叉。
- 判定依据：`GET /api/v1/health` 探活成功 **且** 页面能读到服务注入的 session token；缺任一条件即按只读处理。
