# 下一位执行 Agent 入口

## 当前事实

- 2026-09-15 起，代码为 `v2.3.3-phase4a`：v3 **Phase 1「资产领域基础」、Phase 2「本地服务与 SQLite」、Phase 3「账户、负债与月度结账」已完成并验收**（S1.1–S1.4、S2.1–S2.4、S3.1–S3.3 全部通过）；**Phase 4A「数据源决策与适配器契约」已完成并验收**（S4A.1 通过，T-002/T-003 冻结为 `DECISIONS.md` D-036/D-037）。
- 已有 v3 能力：
  - 领域层：`js/domain.js`（资产模型、CNY/HKD/USD 定点折算、总览聚合与新鲜度状态、`computeCloseChecklist` 月结核对、`emergencyCoverageMonths` 应急金覆盖）；
  - 服务层：`server/main.js`（入口/单实例锁/每日备份/token）、`server/api.js`（`/api/v1` + 静态托管 + 写门禁 + `PUT /state` 的 `forceBackup` + Phase 3 资源 upsert、换汇、手动汇率、月结与快照明细）、`server/migrations.js`（v1 初始 Schema 已含 `instruments` 表及 `classification_status suggested/confirmed` 约束、v2 `phase3-close-schema`、v3 `phase3-asset-transfers`）、`server/db.js`、`server/repository.js`（全量写入按 schema 校验并推导换汇币种）、`server/backup.js`（`VACUUM INTO` 快照 + 同秒同名备份 `-N` 后缀防覆盖 + 按候选库版本条件化校验必需表）、`server/keychain.js`、`server/login-item.js`；
  - Phase 4A 契约：`server/providers/contract.js`（统一结果形状：原始代码/价格/汇率/数据日/抓取时间/provider + 五类错误 `timeout/rate_limit/not_found/invalid_payload/auth` + 可重试映射 + 白名单请求序列化）、`server/providers/clock.js`（固定时钟 `ctx.now`）、`server/providers/fixture.js`（离线 fixture adapter，覆盖成功/超时/限额/缺标的/无效载荷/鉴权/节假日）；
  - 前端：`js/store.js` 存储门面（资源创建/更新、月结读写、快照明细；网络失败立即降级只读）、`js/app.js`（资产决策台、资产录入/换汇/福利预设/汇率页 `assets`、月度结账页 `close`（含金额下钻）、现金流页、备份 Schema v2）、`sw.js`（HTML 网络优先 + 令牌脱敏缓存，缓存键 `ledger-v2.3.2-phase3`）；
  - 运维：`start.command`、`scripts/install-login-item.sh` / `uninstall-login-item.sh`。
- **事实源：** SQLite（默认 `~/Library/Application Support/Ledger/ledger.db`）。API 模式下前端**完全不触碰 IndexedDB**；服务不可达时只读降级，绝不双写。资源 upsert 见 D-031，估值/追溯口径见 D-034，备份校验见 D-035，行情/汇率主源见 D-036，ETF 元数据锁定见 D-037。
- **尚无** Phase 4B+ 能力：`instruments` 表已建但**没有**标的检索/候选/预分类/确认的 API 与前端；`POST /api/v1/portfolio-openings|security-events|market-data/refresh` 仍返回 `501`；Keychain 读取路径已就绪但**尚未真正接入行情 Key**。行情 provider 目前只有 fixture（不发真实网络），汇率仍只能手工登记。
- Phase 4 已在 `ROADMAP.md` 拆成 **4A 数据源与契约 → 4B 标的目录 → 4C 持仓账本 → 4D 日终行情 → 4E 下钻归因**。每个任务只领取一个子阶段，禁止一次实现完整 Phase 4。
- 测试基线：`node --test` **245/245 通过**（230 旧 + 15 项 Phase 4A 契约/隐私测试，2026-09-15）；浏览器 wiring **15/15**（连续两轮全绿）。
- 遗留：登录项端到端（重启 Mac 自动打开）与 Keychain 真实读取留待用户在本机手动执行；「15 分钟完成一次月结」的真实耗时按计划留到 Phase 7 验证。

## 你的任务

**只实施 Phase 4B「标的目录与分类确认」**。不要开始持仓账本（4C）、真实行情接入（4D）或下钻归因（4E）。

开始前按 `AGENTS.md` 的顺序完整阅读全部 v3 文档，然后：

1. 检查 git 状态与未提交修改，运行并记录 **245 项**基线测试（`node --test`）与浏览器 wiring 15 项；
2. 给出 Phase 4B 的文件级计划和回滚边界；
3. 实现标的检索、候选结果与元数据缓存（沿用 Phase 4A 的 `server/providers/fixture.js`，**不发真实网络请求**），资产类别/市场/币种预分类；
4. 实现用户确认与本地锁定：`classification_status` 从 `suggested` → `confirmed`，外部元数据变化**不得覆盖已确认分类**（只作冲突提示，对齐 D-037 与 S4B.1）；
5. 建立稳定标的 id，供后续多个证券账户共同引用；本阶段**不创建持仓**，不触碰 `portfolio-openings` / `security-events` 写接口（仍属 4C）；
6. 完成 `ACCEPTANCE.md` S4B.1 后，只把 ROADMAP 的 4B 标为完成，并把 `NEXT_AGENT.md` 改为仅领取 4C。

## 禁止事项

- 不删除或重写已通过测试的 `core.js`/`domain.js` 纯逻辑与现有测试，也不改动 Phase 4A 的 `server/providers/` 契约（`contract.js`/`clock.js`/`fixture.js` 已有测试覆盖，如确需扩展应加新测试而非改语义）。
- 不把 IndexedDB 与 SQLite 做成长期双向写入；切换必须按 ARCHITECTURE §9 的顺序。
- 本地服务只绑定 `127.0.0.1`；不为调试改绑 `0.0.0.0`。
- 不在自动测试中访问真实行情网络（4B 用 fixture）；不引入付费数据源。
- API Key 不入库、不进前端、不进测试 fixture、不进日志。
- 外部行情请求不得携带账户名、余额、数量、成本或任何私人财务事实（D-020）。
- 本阶段不创建持仓：`POST /api/v1/portfolio-openings|security-events` 继续留在 `DEFERRED_WRITES` 返回 `501`（属 4C），不提前实现。
- 外部元数据刷新不得覆盖 `confirmed` 分类（D-037），只能提示冲突。
- 不覆盖用户已有未提交修改，不删除旧测试换取绿色结果。
- **不要用 `node:sqlite` 的在线 `backup()`**；备份快照统一走 `server/backup.js` 的 `VACUUM INTO` 路径（ARCHITECTURE §13.2）。
- **不要给写接口放行缺 `Content-Type` 的请求**（D-026）；`instruments` 表若需新增列才加迁移版本，并同步 `server/backup.js` 的 `REQUIRED_TABLES_BY_VERSION`（D-035）。
- 月结与总览口径只允许复用 `js/domain.js`，不得在服务端另写一套聚合（D-025/D-001）。
- 不要信任载荷中可由关联记录推导的冗余字段（D-035）。

## 可直接复制给执行 Agent 的任务描述

> 阅读项目根目录的 README.md、PRODUCT.md、ARCHITECTURE.md、ROADMAP.md、DECISIONS.md、ACCEPTANCE.md、AGENTS.md 和 NEXT_AGENT.md。只实施 ROADMAP Phase 4B「标的目录与分类确认」，不开始 4C–4E。先检查 git 状态、运行 245 项基线测试与 15 项浏览器 wiring，再给出文件级计划与回滚边界。沿用 Phase 4A 的 fixture adapter 实现标的检索、候选与元数据缓存，资产类别/市场/币种预分类，用户确认后 `classification_status` 转 `confirmed` 本地锁定，外部元数据变化不得覆盖已确认分类；建立稳定标的 id 供多证券账户引用，本阶段不创建持仓（不碰 portfolio-openings / security-events 写接口，仍返回 501）。不得访问真实行情网络，不得改动 Phase 4A 契约语义，不得接持仓写接口。完成 S4B.1 后更新证据，并把 NEXT_AGENT 入口切到只实施 4C。
