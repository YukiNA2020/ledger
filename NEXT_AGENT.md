# 下一位执行 Agent 入口

## 当前事实

- 2026-09-16 起：v3 **Phase 1–3 已完成并验收**；**Phase 4B「标的目录与分类确认」两轮独立复核补口及第三轮引用安全审计完成、等待独立复核确认**（G4B-1–12 全部修复，原始结论见 `PHASE4B_ACCEPTANCE_GAPS.md`，开工前先确认复核已通过）；**Phase 4C「持仓账本与证券事件」第 1 轮独立复核补口完成、等待独立复核确认**（复核判定"暂不通过"的 G4C-1–6 已逐条闭合，见 `PHASE4C_ACCEPTANCE_GAPS.md`；口径冻结见 D-042 ⑦⑧；全量 407/407 + wiring 18/18 两轮）。Phase 4A 正式验收仍暂不通过：T-002 行情端点待 4D 前决定。
- 已有 v3 能力：
  - 领域层：`js/domain.js`（资产模型、CNY/HKD/USD 定点折算、总览聚合与新鲜度状态、`computeCloseChecklist` 月结核对、`emergencyCoverageMonths` 应急金覆盖；4B 新增 `instrumentKey` / `EXPOSURE_MARKETS` / `diffInstrumentFields` / `suggestFromProvider` / `USER_JUDGEMENT_FIELDS`；**4C 新增 `SECURITY_EVENT_TYPES`、`compareDecimals` / `sumQuantities` / `subtractQuantities` 定点数量助手与 `deriveHoldings` 唯一推导实现**——期初 + Σ买入 − Σ卖出，分红/费用不改数量，strict 模式对卖出超额抛 `insufficient_holdings`，`computeOverview` / `computeCloseChecklist` 有事件时内部走推导、无事件零回归；`ASSET_KEYS` 现为 10 键含 `securityEvents`）；
  - 服务层：`server/main.js`（入口/单实例锁/每日备份/token）、`server/api.js`（`/api/v1` + 静态托管 + 写门禁 + Phase 3 资源 upsert、换汇、手动汇率、月结与快照明细 + 4B 标的检索/建立/确认 + **4C 的 `POST /portfolio-openings`、`POST /security-events`（Idempotency-Key 回放）、`GET /security-events`**；`market-data/refresh` 仍 501）、`server/migrations.js`（v1–v3、v4 `uq_instruments_dedupe`、**v5 `phase4c-security-event-amounts`：`security_events.amount_minor` 列 + `(account_id, instrument_id, occurred_at)` 重放索引**）、`server/db.js`、`server/repository.js`（全量写入按 schema 校验；4B 标的读写；**4C 新增 `readSecurityEvents` / `upsertSecurityEvent`（同 id 409 `duplicate_event`、strict 重放守卖出不越界）/ `writeSecurityEvents`（全量路径同口径逐条校验 + strict 重放）/ `upsertPortfolioOpening`（同键第二行 409 `duplicate_opening`）；`readHoldings` 已是推导视图，含 `openingId` / `eventCounts` / `lastEventAt` 追溯字段；`readState` / `writeState` 带 `securityEvents` 键**）、`server/backup.js`（`VACUUM INTO` 快照 + 按版本校验必需表与必需索引）、`server/keychain.js`、`server/login-item.js`；
  - Phase 4A 契约：`server/providers/contract.js`（请求序列化前校验、结果逐键严格、`assertValidResult` 落库门禁）、`server/providers/clock.js`、`server/providers/fixture.js`、`server/providers/SOURCES.md`（数据源证据档）；
  - Phase 4B 编排层：`server/instrument-catalog.js`（稳定 id 按 identity key 派生永久锁定、去重键三路径显式拒绝、`confirmed` 本地锁定、冲突只提示不覆盖；D-039/D-041）；
  - 前端：`js/store.js`（资源创建含 idempotencyKey、月结、快照、标的检索/建立/确认、**4C 的 `listHoldings` / `listSecurityEvents`**）、`js/app.js`（资产决策台、资产录入页 `assets` 含**标的目录区块 + 持仓与证券事件区块**（期初快照弹层 / 事件弹层 / 推导持仓卡片 / 事件流水，`data-holding` / `data-event-id` 可定位）、月度结账页、现金流页；`APP_VERSION` = `2.3.9-phase4c`）、`sw.js`（缓存键 `ledger-v2.3.9-phase4c`）；
  - 运维：`start.command`、`scripts/install-login-item.sh` / `uninstall-login-item.sh`。
- **事实源：** SQLite（默认 `~/Library/Application Support/Ledger/ledger.db`）。API 模式下前端**完全不触碰 IndexedDB**；服务不可达时只读降级，绝不双写。资源 upsert 见 D-031，估值/追溯口径见 D-034，备份校验见 D-035，汇率源见 D-036，ETF 元数据来源见 D-037，行情源启用门禁见 D-038，标的目录口径见 D-039，结构校验覆盖不变量载体见 D-040，标的引用完整性见 D-041，**持仓账本与证券事件口径（唯一推导 / 重复拒绝 / 事件不写 txns / 币种推导 / suggested 可录入+阻塞）见 D-042**。
- **尚无** Phase 4D+ 能力：行情 provider 仍只有 fixture（不发真实网络）；`POST /api/v1/market-data/refresh` 仍 501；自动抓取默认关闭，价格仍只能手动补（quotes 走 `PUT /state` 全量路径）；汇率仍只能手工登记。Keychain 读取路径就绪但**尚未真正接入行情 Key**。4E 的下钻归因未开始。
- Phase 4 已在 `ROADMAP.md` 拆成 **4A 数据源与契约 → 4B 标的目录 → 4C 持仓账本 → 4D 日终行情 → 4E 下钻归因**。每个任务只领取一个子阶段。**进入 4D 前必须先关闭 T-002 行情源缺口（D-038 门禁）**。
- 测试基线：`node --test` **407/407 通过**（397 第 1 轮基线零回归 + 复核反例 10 项；领域 `domain-phase4c` 19、真实 HTTP `server-phase4c` 16、迁移 16、`instrument-catalog` 48、`server-phase4b` 17）；浏览器 wiring **18/18**（连续两轮全绿）。数据库 schema 版本 **v6**（v6 = `uq_portfolio_openings_dedupe` 期初唯一索引）。
- 遗留：登录项端到端（重启 Mac 自动打开）与 Keychain 真实读取留待用户在本机手动执行；「15 分钟完成一次月结」的真实耗时按计划留到 Phase 7 验证；**行情主源端点未定**（不存在免费无 key 且有官方条款的 A/H/US ETF 日终源），由 D-038 门禁在 4D 前置解决。

## 你的任务

**只实施 Phase 4D「日终行情、汇率与失败兜底」**。不要开始 4E（下钻归因），也不要回改 4B 目录语义与 4C 持仓口径。

**开工前置（硬门禁，未关闭不得开始写行情代码）：**
1. 确认 4B / 4C 的独立复核已通过（先查 `PHASE4B_ACCEPTANCE_GAPS.md` 与 `PHASE4C_ACCEPTANCE_GAPS.md` 及复核记录；若提出新问题，先修复再进 4D）；
2. **关闭 T-002 行情端点缺口**：按 D-038 门禁逐条取证并更新 `server/providers/SOURCES.md`——官方条款（含自动化授权）、API 版本与文档、限额、认证方式、市场覆盖声明、失败语义到五类错误码的映射。**没有候选通过门禁时，自动抓取保持默认关闭，行情继续走手动补价 + 本地缓存，4D 只交付汇率自动更新（Frankfurter 固定 ECB 端点，D-036）与手动价格兜底**。

开始前按 `AGENTS.md` 的顺序完整阅读全部 v3 文档，然后：

1. 检查 git 状态与未提交修改，运行并记录 **407 项**基线测试（`node --test`）与浏览器 wiring 18 项；
2. 给出 Phase 4D 的文件级计划和回滚边界；
3. 接入 4A 契约的行情 provider：成功、断网、超时、限额、缺标的、节假日全部由 fixture 测试覆盖；**落库前必须经 `contract.assertValidResult` 校验，不可入账数据一律拒绝写入**；
4. 从 Keychain 读取所需 Key；Key 不进入 argv、数据库、前端或日志；
5. 保存价格日、抓取时间、provider 与原始代码；增加有限重试、限额/超时错误与缓存；失败保留最后有效值并标记 stale；
6. 保留 Phase 3 手动汇率并增加手动价格兜底；错误响应不得覆盖最后有效值；
7. 备份恢复往返必须无损（含行情事实）；
8. 完成 `ACCEPTANCE.md` S4D.1/S4D.2 后，只把 ROADMAP 的 4D 标为完成，并把 `NEXT_AGENT.md` 改为仅领取 4E。

## 禁止事项

- 不删除或重写已通过测试的 `core.js`/`domain.js` 纯逻辑与现有测试；不改动 Phase 4A 的 provider 契约语义（如确需扩展应加新测试而非改语义）、Phase 4B 的目录语义（D-037/D-039/D-040/D-041）与 Phase 4C 的持仓口径（**`deriveHoldings` 是持有数量的唯一实现，不得另写第二套推导**；同 id 事件重放必须 409；期初日期边界（D-042 ⑦）与期初全路径唯一性（D-042 ⑧）不得回退，D-042）。
- **D-038 门禁未通过前不得开启自动行情抓取**；不得引入付费数据源；自动测试一律离线（fixture），不访问真实行情网络。
- 不把 IndexedDB 与 SQLite 做成长期双向写入；切换必须按 ARCHITECTURE §9 的顺序。
- 本地服务只绑定 `127.0.0.1`；不为调试改绑 `0.0.0.0`。
- API Key 不入库、不进前端、不进测试 fixture、不进日志。
- 外部行情请求不得携带账户名、余额、数量、成本或任何私人财务事实（D-020）；请求产物只允许公开代码/币对。
- 不在服务端另写一套聚合/推导口径去替代 `js/domain.js`（D-025/D-001）。
- 不信任载荷中可由关联记录推导的冗余字段（D-035）。
- 不要用 `node:sqlite` 的在线 `backup()`；备份快照统一走 `server/backup.js` 的 `VACUUM INTO` 路径（ARCHITECTURE §13.2）。
- 不要给写接口放行缺 `Content-Type` 的请求（D-026）；若需新增列才加迁移版本，并同步 `server/backup.js` 的 `REQUIRED_TABLES_BY_VERSION` 与 `REQUIRED_INDEXES_BY_VERSION`（D-035/D-040）。
- 不覆盖用户已有未提交修改，不删除旧测试换取绿色结果。

## 可直接复制给执行 Agent 的任务描述

> 阅读项目根目录的 README.md、PRODUCT.md、ARCHITECTURE.md、ROADMAP.md、DECISIONS.md、ACCEPTANCE.md、AGENTS.md 和 NEXT_AGENT.md。只实施 ROADMAP Phase 4D「日终行情、汇率与失败兜底」，不开始 4E，也不回改已验收的 4B 目录语义与 4C 持仓口径。**开工前先做两件事：① 确认 4B/4C 独立复核已通过（查 `PHASE4B_ACCEPTANCE_GAPS.md`，有新问题先修）；② 关闭 T-002 行情端点缺口——按 D-038 门禁逐条取证（官方条款/自动化授权、API 版本、限额、认证、覆盖声明、失败语义映射）并更新 `server/providers/SOURCES.md`；门禁没有候选通过时，自动抓取保持默认关闭，4D 只交付汇率自动更新（Frankfurter 固定 ECB 端点，D-036）与手动价格兜底。** 先检查 git 状态、运行 407 项基线测试与 18 项浏览器 wiring，再给出文件级计划与回滚边界。接入 4A 契约的行情 provider：成功、断网、超时、限额、缺标的、节假日全部由 fixture 测试覆盖，落库前必须经 `contract.assertValidResult` 校验，不可入账数据一律拒绝；保存价格日、抓取时间、provider 与原始代码；有限重试、限额/超时错误与缓存；失败保留最后有效值并标记 stale，错误响应不覆盖旧值；从 Keychain 读取 Key（不入 argv/数据库/前端/日志）；保留手动汇率并增加手动价格兜底；备份恢复往返无损。不得在 D-038 门禁外开启自动抓取，不得引入付费源，自动测试不得访问真实网络；不得改动 4A 契约语义、4B 目录语义（D-037/D-039/D-040/D-041）与 4C 持仓口径（`deriveHoldings` 唯一推导、同 id 重放 409，D-042）；不得在服务端另写聚合口径（D-025），不得信任可推导冗余字段（D-035），不得双写 IndexedDB，不得放行缺 Content-Type 的写请求（D-026），备份一律走 `VACUUM INTO`。完成 S4D.1/S4D.2 后更新证据，并把 NEXT_AGENT 入口切到只实施 4E。
