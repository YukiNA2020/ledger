# 下一位执行 Agent 入口

## 当前事实

- 2026-09-14 起，代码为 `v2.2.1-phase2`：v3 **Phase 1「资产领域基础」与 Phase 2「本地服务与 SQLite」均已完成并验收**（S1.1–S1.4、S2.1–S2.4 全部通过，补充验收发现的 S1–S3 阻塞缺陷已修复，证据见 `TEST.md` 与 `ROADMAP.md`）。
- 已有 v3 能力：
  - 领域层：`js/domain.js`（资产模型、CNY/HKD/USD 定点折算、总览聚合与新鲜度状态）；
  - 服务层：`server/main.js`（入口/单实例锁/每日备份/token）、`server/api.js`（`/api/v1` + 静态托管 + 写门禁 + `PUT /state` 的 `forceBackup` 覆盖前强制备份）、`server/migrations.js`、`server/db.js`、`server/repository.js`、`server/backup.js`（`VACUUM INTO` 快照 + 同秒同名备份 `-N` 后缀防覆盖）、`server/keychain.js`、`server/login-item.js`；
  - 前端：`js/store.js` 存储门面（网络失败立即降级只读；`saveAll({forceBackup})` 透传）、`js/app.js`（保存确认落盘才提示成功、失败回滚乐观更新）、资产决策台、`cashflow` 现金流页、备份 Schema v2；`sw.js`（HTML 网络优先 + 令牌脱敏缓存）；
  - 运维：`start.command`、`scripts/install-login-item.sh` / `uninstall-login-item.sh`。
- **事实源：** SQLite（默认 `~/Library/Application Support/Ledger/ledger.db`）。API 模式下前端**完全不触碰 IndexedDB**；服务不可达时只读降级，绝不双写。
- **尚无** Phase 3+ 能力：没有账户/负债的写入接口（`POST /api/v1/accounts|liabilities|account-units|entitlements|institutions` 目前返回 `501`）、没有月度结账、没有行情 provider、没有风险问卷或决策状态机。
- 测试基线：`node --test` **202 项通过、0 项失败**（2026-09-14）；浏览器 wiring **11/11**。
- D-022 已由用户确认：用户日常浏览器中**没有**需要迁移的真实 IndexedDB 数据，真实数据将在整个程序完成后再放入；因此仍未开发 IndexedDB 历史迁移器。
- 遗留：登录项端到端（重启 Mac 自动打开）与 Keychain 真实读取留待用户在本机手动执行，见 `TEST.md` "未完成的 P1 发布检查"。

## 你的任务

只实施 Phase 3「账户、负债与月度结账」，不要顺带实现持仓行情、风险问卷或建议功能。

开始前按 `AGENTS.md` 的顺序完整阅读全部 v3 文档，然后：

1. 检查 git 状态与未提交修改，运行并记录 202 项基线测试；
2. 给出 Phase 3 的文件级计划和回滚边界；
3. 在 `migrations.js` 中**新增一个版本**（不要修改已发布的 v1）承载 Phase 3 需要的表结构变化，并补向前迁移测试与备份恢复测试；
4. 把 `server/api.js` 的 `DEFERRED_WRITES` 中属于 Phase 3 的条目逐个替换为真实实现（`accounts`、`institutions`、`account-units`、`liabilities`、`entitlements`），未实现的继续留在 `DEFERRED_WRITES`；
5. 前端沿用 `js/store.js` 门面扩展，不要在页面代码里直接 `fetch('/api/v1/...')`，也不要重新引入 IndexedDB 写入；
6. 实现月度核对清单、结账状态与历史快照；结账结果必须可从余额/估值/交易追溯；
7. 完成 `ACCEPTANCE.md` 的 S3.1–S3.x；逐条满足后才能更新 ROADMAP 状态。

## 禁止事项

- 不删除或重写已通过测试的 `core.js`/`domain.js` 纯逻辑与现有测试。
- 不把 IndexedDB 与 SQLite 做成长期双向写入；切换必须按 ARCHITECTURE §9 的顺序。
- 本地服务只绑定 `127.0.0.1`；不为调试改绑 `0.0.0.0`。
- 不在自动测试中访问真实行情网络；不引入付费数据源。
- API Key 不入库、不进前端、不进测试 fixture。
- 不覆盖用户已有未提交修改，不删除旧测试换取绿色结果。
- **不要用 `node:sqlite` 的在线 `backup()`**（会在长生命周期进程中不可预测地停住）；备份快照统一走 `server/backup.js` 的 `VACUUM INTO` 路径，见 `ARCHITECTURE.md` §13.2。
- **不要给写接口放行缺 `Content-Type` 的请求**，也不要让前端对非只读方法省略该头（见 `DECISIONS.md` D-026）。
- 不要为了让老测试变绿而降低断言强度；`assets` 形状类断言必须与 `js/domain.js` 的空集合逐键比对。

## 可直接复制给执行 Agent 的任务描述

> 阅读项目根目录的 README.md、PRODUCT.md、ARCHITECTURE.md、ROADMAP.md、DECISIONS.md、ACCEPTANCE.md、AGENTS.md 和 NEXT_AGENT.md。只实施 ROADMAP Phase 3「账户、负债与月度结账」，不跨阶段。先检查 git 状态、运行 202 项基线测试并确认零回归，再给出文件级计划与回滚边界。按 ACCEPTANCE S3.x 先写行为测试，再新增迁移版本与 repository/API 实现，逐条把 `DEFERRED_WRITES` 中属于 Phase 3 的接口替换为真实实现；前端扩展 `js/store.js` 门面，保持领域逻辑、旧记账能力与 SQLite 单一事实源不变。完成后报告改动、测试证据、未完成项、风险和回滚方式。
