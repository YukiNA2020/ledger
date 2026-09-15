# 下一位执行 Agent 入口

## 当前事实

- 2026-09-15 起，代码为 `v2.3.2-phase3`：v3 **Phase 1「资产领域基础」、Phase 2「本地服务与 SQLite」、Phase 3「账户、负债与月度结账」均已完成并验收**（S1.1–S1.4、S2.1–S2.4、S3.1–S3.3 全部通过；Phase 3 的验收补口 P0-A/P0-B/P1-A/P1-B/P1-C 已全部闭合，证据见 `TEST.md` 与 `ROADMAP.md`）。
- 已有 v3 能力：
  - 领域层：`js/domain.js`（资产模型、CNY/HKD/USD 定点折算、总览聚合与新鲜度状态、`computeCloseChecklist` 月结核对、`emergencyCoverageMonths` 应急金覆盖）；
  - 服务层：`server/main.js`（入口/单实例锁/每日备份/token）、`server/api.js`（`/api/v1` + 静态托管 + 写门禁 + `PUT /state` 的 `forceBackup` + Phase 3 资源 upsert、换汇、手动汇率、月结与快照明细）、`server/migrations.js`（v1 初始 Schema、v2 `phase3-close-schema`、v3 `phase3-asset-transfers`）、`server/db.js`、`server/repository.js`（全量写入按 schema 校验并推导换汇币种）、`server/backup.js`（`VACUUM INTO` 快照 + 同秒同名备份 `-N` 后缀防覆盖 + 按候选库版本条件化校验必需表）、`server/keychain.js`、`server/login-item.js`；
  - 前端：`js/store.js` 存储门面（资源创建/更新、月结读写、快照明细；网络失败立即降级只读）、`js/app.js`（资产决策台、资产录入/换汇/福利预设/汇率页 `assets`、月度结账页 `close`（含金额下钻）、现金流页、备份 Schema v2）、`sw.js`（HTML 网络优先 + 令牌脱敏缓存，缓存键 `ledger-v2.3.2-phase3`）；
  - 运维：`start.command`、`scripts/install-login-item.sh` / `uninstall-login-item.sh`。
- **事实源：** SQLite（默认 `~/Library/Application Support/Ledger/ledger.db`）。API 模式下前端**完全不触碰 IndexedDB**；服务不可达时只读降级，绝不双写。资源 upsert 语义见 D-031，估值/追溯口径见 D-034，备份校验见 D-035。
- **尚无** Phase 4+ 能力：没有持仓/标的/报价写入接口（`POST /api/v1/portfolio-openings|security-events|market-data/refresh` 仍返回 `501`）、没有行情 provider（汇率目前只能手工登记）、没有风险问卷或决策状态机（`risk-assessments`、`recommendations` 仍 `501`）。Keychain 读取路径已就绪但**尚未真正接入行情 Key**。
- 测试基线：`node --test` **230/230 通过**（2026-09-15，含 2 项 macOS Keychain 写读），其中 Phase 3 `server-phase3` **14/14**；浏览器 wiring **15/15**（连续两轮全绿）。
- 遗留：登录项端到端（重启 Mac 自动打开）与 Keychain 真实读取留待用户在本机手动执行，见 `TEST.md` "未完成的 P1 发布检查"；「15 分钟完成一次月结」的真实耗时按计划留到 Phase 7 验证。

## 你的任务

只实施 Phase 4「持仓与日终行情」，不要顺带实现风险问卷或建议功能。

开始前按 `AGENTS.md` 的顺序完整阅读全部 v3 文档，然后：

1. 检查 git 状态与未提交修改，运行并记录 **230 项**基线测试（`node --test`）与浏览器 wiring 15 项；
2. 给出 Phase 4 的文件级计划和回滚边界；
3. 先决定 `DECISIONS.md` T-002 / T-003（免费行情与汇率 provider、ETF 元数据来源），**在自动测试中只用固定 fixture，绝不访问真实行情网络**；
4. 在 `migrations.js` 中**新增一个版本**（不要修改已发布的 v1/v2/v3）承载 instruments/holdings/quotes 的表结构变化（v1 已建八集合基础表，其中 `fx_rates` 已可用，确认缺口后再加），并补向前迁移测试与备份恢复测试；**注意 `server/backup.js` 的 `REQUIRED_TABLES_BY_VERSION` 需要同步登记新版本新增的表**（D-035）；
5. 把 `server/api.js` 的 `DEFERRED_WRITES` 中属于 Phase 4 的条目逐个替换为真实实现（`portfolio-openings`、`security-events`、`market-data/refresh`），未实现的继续留在 `DEFERRED_WRITES`；
6. Keychain 读取（`server/keychain.js`）在本阶段接入行情 API Key：只走 stdin 不进 argv、Key 不入库不进前端不进日志；
7. 前端沿用 `js/store.js` 门面扩展，不要在页面代码里直接 `fetch('/api/v1/...')`，也不要重新引入 IndexedDB 写入；
8. 实现资产类别/机构/币种/市场下钻与证券收益、汇率影响分离；行情失败保留最后有效值并标记 stale，手动补价可用；
9. 汇率改为 provider 供给后，仍要保留手动登记路径（Phase 3 页面已依赖它，见 D-034），不得因为接入自动行情而删掉人工兜底；
10. 完成 `ACCEPTANCE.md` 的 S4.1–S4.x；逐条满足后才能更新 ROADMAP 状态。

## 禁止事项

- 不删除或重写已通过测试的 `core.js`/`domain.js` 纯逻辑与现有测试。
- 不把 IndexedDB 与 SQLite 做成长期双向写入；切换必须按 ARCHITECTURE §9 的顺序。
- 本地服务只绑定 `127.0.0.1`；不为调试改绑 `0.0.0.0`。
- 不在自动测试中访问真实行情网络；不引入付费数据源。
- API Key 不入库、不进前端、不进测试 fixture、不进日志。
- 外部行情请求不得携带账户名、余额、数量、成本或任何私人财务事实（D-020）。
- 不覆盖用户已有未提交修改，不删除旧测试换取绿色结果。
- **不要用 `node:sqlite` 的在线 `backup()`**（会在长生命周期进程中不可预测地停住）；备份快照统一走 `server/backup.js` 的 `VACUUM INTO` 路径，见 `ARCHITECTURE.md` §13.2。
- **不要给写接口放行缺 `Content-Type` 的请求**，也不要让前端对非只读方法省略该头（见 `DECISIONS.md` D-026）。
- 不要为了让老测试变绿而降低断言强度；`assets` 形状类断言必须与 `js/domain.js` 的空集合逐键比对。
- 月结与总览口径只允许复用 `js/domain.js`，不得在服务端另写一套聚合（D-025/D-001）；前端算出的汇率、覆盖率、均值一律不得作为写入依据（D-034）。
- 不要信任载荷中可由关联记录推导的冗余字段（如换汇两端币种、机构文本），一律推导或校验（D-035）。

## 可直接复制给执行 Agent 的任务描述

> 阅读项目根目录的 README.md、PRODUCT.md、ARCHITECTURE.md、ROADMAP.md、DECISIONS.md、ACCEPTANCE.md、AGENTS.md 和 NEXT_AGENT.md。只实施 ROADMAP Phase 4「持仓与日终行情」，不跨阶段。先检查 git 状态、运行 230 项基线测试与 15 项浏览器 wiring 并确认零回归，再给出文件级计划与回滚边界。先定 T-002/T-003 数据源决策，provider 用固定 fixture 测试；新增迁移版本承载持仓与行情表（并同步 `backup.js` 的按版本必需表清单）；逐条把 `DEFERRED_WRITES` 中属于 Phase 4 的接口替换为真实实现，接入 Keychain 行情 Key；前端扩展 `js/store.js` 门面，保留 Phase 3 的手动汇率与月结下钻能力，保持领域逻辑、旧记账能力与 SQLite 单一事实源不变。完成后报告改动、测试证据、未完成项、风险和回滚方式。
