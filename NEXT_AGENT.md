# 下一位执行 Agent 入口

## 当前事实

- 2026-09-16 起：v3 **Phase 1–3 已完成并验收**；**Phase 4B「标的目录与分类确认」两轮复核补口完成、等待独立复核确认**（`v2.3.5-phase4b` 交付 → `v2.3.6-phase4b` → `v2.3.7-phase4b` 两轮补口；独立复核两轮共判「暂不通过、不建议进入 4C」，6 项问题已全部修复，原始结论与逐条状态见 `PHASE4B_ACCEPTANCE_GAPS.md`）。**开工前先确认这项复核已通过**：若复核又提出问题，先修 4B，不要带着未确认的标的身份/去重语义进入 4C。Phase 4A 的 provider 契约、固定时钟、fixture 与回归测试已完成，但**正式验收暂不通过** —— T-003 已定，T-002 仅汇率源已定，行情端点待 4D 前决定；D-038 是启用门禁而不是行情源决策。4C 不依赖真实行情，可按 ROADMAP 的明确例外推进。
- 已有 v3 能力：
  - 领域层：`js/domain.js`（资产模型、CNY/HKD/USD 定点折算、总览聚合与新鲜度状态、`computeCloseChecklist` 月结核对、`emergencyCoverageMonths` 应急金覆盖；Phase 4B 新增 `instrumentKey` / `EXPOSURE_MARKETS` / `diffInstrumentFields` / `suggestFromProvider` / `USER_JUDGEMENT_FIELDS`）；
  - 服务层：`server/main.js`（入口/单实例锁/每日备份/token）、`server/api.js`（`/api/v1` + 静态托管 + 写门禁 + `PUT /state` 的 `forceBackup` + Phase 3 资源 upsert、换汇、手动汇率、月结与快照明细 + **Phase 4B 的标的检索/建立/确认**）、`server/migrations.js`（v1 初始 Schema 已含 `instruments` 表及 `classification_status suggested/confirmed` 约束、v2 `phase3-close-schema`、v3 `phase3-asset-transfers`；4B **未新增迁移**）、`server/db.js`、`server/repository.js`（全量写入按 schema 校验并推导换汇币种；4B 新增 `readInstrumentRecords` / `getInstrument` / `findInstrumentByKey` / `upsertInstrument`）、`server/backup.js`（`VACUUM INTO` 快照 + 同秒同名备份 `-N` 后缀防覆盖 + 按候选库版本条件化校验必需表）、`server/keychain.js`、`server/login-item.js`；
  - Phase 4A 契约：`server/providers/contract.js`（严格契约：请求在序列化**前**校验，非法输入整体返回稳定 `invalid_payload` 且不回显输入原文；结果构造严格并逐键校验；4B 新增 `serializeSearchRequest` / `serializeMetadataRequest` / `instrumentResult` / `makeProvenance` 与 `kind==='instrument'` 校验分支）、`server/providers/clock.js`（固定时钟 `ctx.now`）、`server/providers/fixture.js`（离线 fixture adapter，按 `asOf` 取 `date <= asOf` 最近有效日；4B 新增 `CATALOG` 与 `searchInstrument` / `getInstrumentMetadata`）、`server/providers/SOURCES.md`（数据源证据档）；
  - Phase 4B 编排层：`server/instrument-catalog.js`（本地 + provider 候选按去重键合并、provider 失败仍返回本地命中、provenance 与冲突提示、建立/确认与 `confirmed` 本地锁定、`writeInstrument` 事务包装；稳定 id **只由服务端**按首次创建时的 identity key 派生并永久锁定 `inst-<sha1(identityKey) 前16位>`（`stableIdFromKey` / `identityKeyOf`，客户端指定的 id 一律 `client_id_forbidden`），记录持久化 `identityKey` 供离线复算；去重键 `(symbol, exchange)` 在目录接口、单条 upsert、全量 `PUT /state` 三条路径上都显式拒绝同键第二行（`duplicate_instrument` → 409 + 回滚），数据库侧由迁移 v4 的 `uq_instruments_dedupe` 兜底；缺交易所时同代码跨市场报 `ambiguous_instrument` → 409）；**4C 若需读取标的，请复用该模块与 `repository` 的标的读函数，不要在 API 层另写一套校验，也不要另写 id 派生或去重口径。**
  - 前端：`js/store.js` 存储门面（资源创建/更新、月结读写、快照明细、**标的检索/建立/确认**；网络失败立即降级只读）、`js/app.js`（资产决策台、资产录入/换汇/福利预设/汇率页 `assets`（含**标的目录区块与确认弹层**）、月度结账页 `close`（含金额下钻）、现金流页、备份 Schema v2）、`sw.js`（HTML 网络优先 + 令牌脱敏缓存，缓存键 `ledger-v2.3.7-phase4b`）；
  - 运维：`start.command`、`scripts/install-login-item.sh` / `uninstall-login-item.sh`。
- **事实源：** SQLite（默认 `~/Library/Application Support/Ledger/ledger.db`）。API 模式下前端**完全不触碰 IndexedDB**；服务不可达时只读降级，绝不双写。资源 upsert 见 D-031，估值/追溯口径见 D-034，备份校验见 D-035，汇率源见 D-036，ETF 元数据来源与 provenance 见 D-037，行情源启用门禁见 D-038，**标的目录口径（稳定 id / 去重键 / 用户判断字段 / 手工来源 / 冲突只提示不覆盖）见 D-039**。
- **尚无** Phase 4C+ 能力：`instruments` 表与标的目录已就绪，但**没有**持仓账本 —— `POST /api/v1/portfolio-openings|security-events|market-data/refresh` 仍返回 `501`；`GET /api/v1/holdings` 与 `readOpenings` 目前只会返回空/存量行，没有事件推导出的数量。Keychain 读取路径已就绪但**尚未真正接入行情 Key**。行情 provider 目前只有 fixture（不发真实网络），汇率仍只能手工登记。
- Phase 4 已在 `ROADMAP.md` 拆成 **4A 数据源与契约 → 4B 标的目录 → 4C 持仓账本 → 4D 日终行情 → 4E 下钻归因**。每个任务只领取一个子阶段。4A 的行情端点决策明确延期到 4D 前，4C 可推进；进入 4D 前必须先关闭 T-002 缺口。
- 测试基线：`node --test` **367/367 通过**（357 项 Phase 1–4B 第二轮基线 + 10 项第二轮复核补口反例/不变量：`instrument-catalog` 44、`server-phase4b` 17、`server-backup` 19、`server-restore` 9，2026-09-16）；浏览器 wiring **17/17**（含 S4B.1 真实产品入口闭环与"缺交易所标的与参考数据合成一条候选"闭环，连续两轮全绿）。数据库 schema 版本 **v4**（只多一条 `uq_instruments_dedupe` 唯一索引；备份校验按版本要求它存在且唯一，见 D-040）。
- 遗留：登录项端到端（重启 Mac 自动打开）与 Keychain 真实读取留待用户在本机手动执行；「15 分钟完成一次月结」的真实耗时按计划留到 Phase 7 验证；**行情主源端点未定**（不存在免费无 key 且有官方条款的 A/H/US ETF 日终源），由 D-038 门禁在 4D 前置解决。

## 你的任务

**只实施 Phase 4C「持仓账本与证券事件」**。不要开始 4D（真实行情接入）或 4E（下钻归因），也不要回改 4B 已验收的目录语义。

开始前按 `AGENTS.md` 的顺序完整阅读全部 v3 文档，然后：

1. 检查 git 状态与未提交修改，运行并记录 **367 项**基线测试（`node --test`）与浏览器 wiring 17 项；
2. 给出 Phase 4C 的文件级计划和回滚边界；
3. 实现初始持仓快照 `POST /api/v1/portfolio-openings` 与证券事件 `POST /api/v1/security-events`（买入 / 卖出 / 分红 / 费用），**单事务 + 幂等校验**，非法事件与重复事件必须被明确拒绝而不是写出矛盾事实；
4. 持仓数量必须由「初始快照 + 事件」推导，且**同一标的可存在于多个证券账户**；标的引用只用 4B 的稳定 id（D-039），不要新建第二套标的身份；每次引用都要确认标的已存在于目录且分类已确认（未确认分类属于 `classification_unconfirmed`，按 §10 处理）；
5. 买卖只影响持仓与现金，**不得重复计入收入支出**；分红与费用必须可单独追溯到事件来源；
6. 增加最小持仓录入/事件 UI（`js/store.js` 门面 + `js/app.js`，页面不得直接 `fetch`）；本阶段只用手动价格或固定 fixture，**不接真实行情、不处理 D-038 门禁**；
7. 备份恢复往返必须无损（含持仓与事件）；
8. 完成 `ACCEPTANCE.md` S4C.1 后，只把 ROADMAP 的 4C 标为完成，并把 `NEXT_AGENT.md` 改为仅领取 4D（并写明 4D 开工前必须先关闭 T-002 行情源门禁）。

## 禁止事项

- 不删除或重写已通过测试的 `core.js`/`domain.js` 纯逻辑与现有测试；不改动 Phase 4A 的 provider 契约语义（`contract.js`/`clock.js`/`fixture.js` 已有 44 项测试覆盖，如确需扩展应加新测试而非改语义）与 Phase 4B 的目录语义（去重键、稳定 id、`confirmed` 本地锁定、用户判断字段不得由 provider 生成，D-037/D-039）。
- 不把 IndexedDB 与 SQLite 做成长期双向写入；切换必须按 ARCHITECTURE §9 的顺序。
- 本地服务只绑定 `127.0.0.1`；不为调试改绑 `0.0.0.0`。
- 不在自动测试中访问真实行情网络（4C 用 fixture 或手动价格）；不引入付费数据源；不提前处理 4D 的行情源门禁（D-038）。
- API Key 不入库、不进前端、不进测试 fixture、不进日志；本阶段不需要任何 Key。
- 外部行情请求不得携带账户名、余额、数量、成本或任何私人财务事实（D-020）。
- 不在服务端另写一套聚合/推导口径去替代 `js/domain.js`（D-025/D-001）；持仓数量的推导口径必须只有一份实现。
- 不信任载荷中可由关联记录推导的冗余字段（D-035）——持仓币种、成本币种等必须从标的与余额单元推导。
- 不要用 `node:sqlite` 的在线 `backup()`；备份快照统一走 `server/backup.js` 的 `VACUUM INTO` 路径（ARCHITECTURE §13.2）。
- 不要给写接口放行缺 `Content-Type` 的请求（D-026）；若需新增列才加迁移版本，并同步 `server/backup.js` 的 `REQUIRED_TABLES_BY_VERSION`（D-035）。
- 不覆盖用户已有未提交修改，不删除旧测试换取绿色结果。

## 可直接复制给执行 Agent 的任务描述

> 阅读项目根目录的 README.md、PRODUCT.md、ARCHITECTURE.md、ROADMAP.md、DECISIONS.md、ACCEPTANCE.md、AGENTS.md 和 NEXT_AGENT.md。只实施 ROADMAP Phase 4C「持仓账本与证券事件」，不开始 4D/4E，也不回改已验收的 4B 目录语义（开工前先确认 `PHASE4B_ACCEPTANCE_GAPS.md` 的复核补口已通过）。先检查 git 状态、运行 367 项基线测试与 17 项浏览器 wiring，再给出文件级计划与回滚边界。实现初始持仓快照（`POST /api/v1/portfolio-openings`）与证券事件（`POST /api/v1/security-events`：买入/卖出/分红/费用），单事务 + 幂等校验，非法与重复事件明确拒绝；持仓数量必须由「初始快照 + 事件」唯一推导，同一标的可存在于多个证券账户，标的引用只用 4B 的稳定 id（D-039：由首次创建时的 identity key 派生且永久不变，复用 `server/instrument-catalog.js`，不要另写派生/去重口径，也不要假设能用当前交易所重算）且分类未确认按 `classification_unconfirmed` 处理；买卖只影响持仓与现金、不得重复计入收入支出，分红与费用可单独追溯来源；增量最小持仓/事件 UI（经 `js/store.js` 门面，页面不得直接 fetch）；本阶段只用手动价格或固定 fixture，不接真实行情、不处理 D-038 门禁、不需要任何 API Key；备份恢复往返无损。不得访问真实行情网络，不得改动 Phase 4A 契约与 4B 目录语义，不得在服务端另写一套聚合口径（D-025），不得把 IndexedDB 与 SQLite 双向写入，不得放行缺 Content-Type 的写请求（D-026）或信任可推导的冗余字段（D-035），备份一律走 `VACUUM INTO`。完成 S4C.1 后更新证据，并把 NEXT_AGENT 入口切到只实施 4D（并注明 4D 开工前须先关闭 T-002 行情源门禁）。
