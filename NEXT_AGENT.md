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
- Phase 4 已在 `ROADMAP.md` 拆成 **4A 数据源与契约 → 4B 标的目录 → 4C 持仓账本 → 4D 日终行情 → 4E 下钻归因**。每个任务只领取一个子阶段，禁止一次实现完整 Phase 4。
- 测试基线：`node --test` **230/230 通过**（2026-09-15，含 2 项 macOS Keychain 写读），其中 Phase 3 `server-phase3` **14/14**；浏览器 wiring **15/15**（连续两轮全绿）。
- 遗留：登录项端到端（重启 Mac 自动打开）与 Keychain 真实读取留待用户在本机手动执行，见 `TEST.md` "未完成的 P1 发布检查"；「15 分钟完成一次月结」的真实耗时按计划留到 Phase 7 验证。

## 你的任务

**只实施 Phase 4A「数据源决策与适配器契约」**。不要开始数据库迁移、持仓 API、真实行情接入或 UI；这些分别属于 4B–4E。

开始前按 `AGENTS.md` 的顺序完整阅读全部 v3 文档，然后：

1. 检查 git 状态与未提交修改，运行并记录 **230 项**基线测试（`node --test`）与浏览器 wiring 15 项；
2. 给出 Phase 4A 的文件级计划和回滚边界；
3. 研究并决定 `DECISIONS.md` T-002 / T-003（免费行情与汇率 provider、ETF 元数据来源），记录覆盖市场、限额、授权方式、使用条款、稳定性和失败语义；
4. 定义统一 adapter 契约：输入只能是公开证券代码/币对；输出包含原始代码、价格/汇率、数据日、抓取时间和 provider；错误至少区分 timeout、rate_limit、not_found、invalid_payload、auth；
5. 新增固定时钟和本地 fixtures，覆盖成功、超时、限额、缺标的、节假日；测试必须证明请求构造不含账户名、数量、成本、余额或完整持仓；
6. 可以建立 adapter 接口与 fixture adapter 的代码骨架，但**不得发真实网络请求**，不得修改迁移、repository、`DEFERRED_WRITES`、Keychain 接线或前端；
7. 完成 `ACCEPTANCE.md` S4A.1 后，只把 ROADMAP 的 4A 标为完成，并把 `NEXT_AGENT.md` 改为仅领取 4B。

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

> 阅读项目根目录的 README.md、PRODUCT.md、ARCHITECTURE.md、ROADMAP.md、DECISIONS.md、ACCEPTANCE.md、AGENTS.md 和 NEXT_AGENT.md。只实施 ROADMAP Phase 4A「数据源决策与适配器契约」，不开始 4B–4E。先检查 git 状态、运行 230 项基线测试与 15 项浏览器 wiring，再决定 T-002/T-003；定义只接收公开代码/币对的统一 adapter 契约，建立固定时钟、fixture adapter 和成功/超时/限额/缺标的/节假日测试，并证明请求不包含私人财务事实。不得访问真实行情网络，不得修改数据库迁移、repository、Phase 4 写 API、Keychain 接线或前端。完成 S4A.1 后更新证据，并把 NEXT_AGENT 入口切到只实施 4B。
