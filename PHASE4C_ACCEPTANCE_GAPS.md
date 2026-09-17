# Phase 4C 独立复核 — 缺口与修复记录

> 复核时间：2026-09-17 晚（独立测试 agent，第 1 轮）
> 复核对象：`v2.3.8-phase4c`（分支 `phase/04c-holdings-events`，实现 `e0adb08` + 文档 `6d218f1`）
> 复核结论：**Phase 4C 暂不通过，不建议进入 4D。** 正常主链路全绿，但反向测试发现 3 个 P0 和 3 个 P1。

---

## 第 1 轮修复状态

> 修复轮：2026-09-17 晚，目标版本 `2.3.9-phase4c`（实现提交 `ce76caf`）
> 修复前基线：397/397 + wiring 18/18；修复后：**407/407**（新增反例 10 项）+ wiring **18/18 × 2 轮**，schema 版本 v5 → **v6**。
> 措辞：本轮为**补口完成，等待独立复核确认**；复核前结论为「暂不通过」。

| 编号 | 级别 | 原始结论 | 修复状态 | 处理方式与证据 |
|---|---|---|---|---|
| G4C-1 | P0 | 买卖事件没有影响券商现金，与 S4C.1「买卖影响现金」不符 | ✅ **边界化收口**（复核者认可的选项二，用户确认采纳） | D-042④ 本已冻结「现金由余额单元人工核对（D-034）」，是 S4C.1 措辞与之矛盾。**修订 S4C.1 措辞**为「现金侧按人工核对（D-034/D-042④），证券事件不自动改写现金余额单元」，不实现现金腿。新增测试 `G4C-1 边界固化`（真实 HTTP）：事件写入后现金余额单元保持 2,000,000 不变、txns 保持为空，防止未来无意引入自动改写 |
| G4C-2 | P0 | 修改期初可制造矛盾账本（期初 10→5 后卖出 8 变矛盾事实） | ✅ 已修复 | `upsertPortfolioOpening` 写入后（新建与更新同路径）**在同一事务内 strict 全时间线重放**，失败抛 `insufficient_holdings` 随事务回滚。反例测试（真实 HTTP）：期初 10 → 卖 8 → 更新期初为 5 → 409，回滚后期初仍 10、推导仍 2、`oversellEvents` 为空 |
| G4C-3 | P0 | `PUT /state` 绕过期初唯一性和逐条校验（同键二期初 stored:2；缺 id 静默丢弃） | ✅ 已修复（应用层 + 数据库双保险） | ① 抽出 `validateOpeningRow` 共享校验，`writeOpenings` 改**两遍写入**：逐条验证归一（缺 id → 400 `invalid_id` 拒绝、绝不静默丢行）、同 id 与同 (账户, 标的) 第一遍即拒；② 迁移 **v6** 建唯一索引 `uq_portfolio_openings_dedupe(account_id, instrument_id)`，迁移前查重复数据、发现即抛错。反例测试（真实 HTTP）×2：同键二期初 → 409 `duplicate_opening` 整体回滚零残留；缺 id → 400 `invalid_id` 零残留。连带：`DOMAIN_ERROR_STATUS` 补 `unknown_account`/`unknown_instrument`/`invalid_amount`，全量写入路径不再误报 500 |
| G4C-4 | P1 | 期初日期之前的事件重复计入（期初 09-06 数量 10 + 09-01 买入 2 = 12） | ✅ 已修复（口径见下方说明） | `deriveHoldings` 冻结日期边界：`occurredAt` **严格早于**期初 `asOf` 的事件视为已含在快照内，不叠加、不进 counts / 活动时间戳，记入 `holding.boundarySkippedEvents` 留痕（`readHoldings` 透传）。**口径说明**：期初快照数量 = 期初日**日初**数量，期初日**当天**及以后的事件正常叠加——「今天录期初、今天再记账」不受影响（复核者给的两个选项中的日期边界方案，同日歧义按此口径确定性消解，提请复核确认）。反例测试：真实 HTTP 1 项（09-01 买入不叠加 → 10；同日与次日买入叠加 → 14）+ 领域 3 项（含「早于期初的卖出不参与 strict 重放」） |
| G4C-5 | P1 | 不存在的日历日期（2026-02-30）可以入库 | ✅ 已修复 | `isDateStr` 升级为真实日历日校验（与 `providers/contract.isDateString` 同口径：月 1–12、日回读一致），期初与事件同一道闸。反例测试（真实 HTTP）：`2026-02-30` 事件 → 400 `invalid_event_date`、期初 → 400 `invalid_date` |
| G4C-6 | P1 | 损坏的 v5 备份（缺 `security_events.amount_minor`）通过校验 | ✅ 已修复 | `backup.js` 新增**按版本必需列**校验 `REQUIRED_COLUMNS_BY_VERSION`（v5+ 要求 `security_events.amount_minor`），复用 `db.js` 新增的 `columnNames`（PRAGMA table_info，读不到按缺失处理）；v6 索引登记进 `REQUIRED_INDEXES_BY_VERSION`。反例测试：v5 库 `DROP COLUMN amount_minor` 后校验拒绝且原因点名缺失列 |

**明确不采纳 / 边界说明**：无（G4C-1 按复核者提供的第二选项「正式修改验收标准」收口，已由用户确认；其余 5 项全部按建议修复）。

---

## 原始复核结论·第一轮（原文转录）

本轮结论：**Phase 4C 暂不通过，不建议进入 4D。** 正常主链路全绿，但反向测试发现 3 个 P0 和 3 个 P1。

测试结果：

- 4C/迁移/备份定向：**70/70 通过**
- 全量回归：**397/397 通过**
- 浏览器端到端：**18/18 通过**
- 工作区干净、临时服务已停止
- `market-data/refresh` 仍保持 501，未访问真实网络

阻塞问题：

1. **P0：买卖事件没有影响券商现金**
   S4C.1 要求“买卖影响持仓和现金，但不重复计入收入支出”。实测 USD 现金余额：

   ```text
   买入前：2,000,000
   买入 2 × 500,000，手续费 100
   买入后：2,000,000
   预期：999,900
   ```

   当前只写 `security_events`，没有现金腿，也没有目标 `accountUnitId`。需要在同一事务中记录可审计的现金变化；或者正式修改验收标准，明确现金只靠人工核对。

2. **P0：修改期初可制造矛盾账本**
   期初 10、卖出 8 后，把同一份期初更新为 5，接口仍接受。结果数据库保留卖出 8，但持仓视图跳过该事件，显示：

   ```text
   quantity=5
   oversellEvents=["sell-8"]
   eventCounts.sell=0
   ```

   更新期初后必须在同一事务内执行 strict 全时间线重放，失败则回滚期初修改。

3. **P0：`PUT /state` 绕过期初唯一性和逐条校验**
   同一账户、同一标的的两条期初可以同时写入并返回成功；缺 ID 的期初会被静默丢弃。实测：

   ```text
   duplicate_openings_state={"stored":2,"view":["10","20"]}
   missing_id_opening_count=0
   ```

   应让全量写入复用单条期初校验，并增加数据库唯一约束 `(account_id, instrument_id)`。

4. **P1：期初日期之前的事件会重复计入**
   期初快照为 9 月 6 日的 10 份，写入 9 月 1 日买入 2 份，系统得到 12 份。若期初快照已包含截至 9 月 6 日的数量，这笔事件被重复计算。
   需要冻结日期边界：事件必须晚于期初日期，或者引入明确的日内顺序。

5. **P1：不存在的日历日期可以入库**
   `2026-02-30` 同时被期初和证券事件接受。日期校验目前只有正则，没有校验真实日历日。

6. **P1：损坏的 v5 备份会通过校验**
   删除 `security_events.amount_minor` 后：

   ```json
   {"ok":true,"schemaVersion":5}
   ```

   恢复后迁移器不会补列，读取事件时会失败。备份校验需要按版本验证必需列；v5 至少检查 `security_events.amount_minor`。

### 代码定位锚点（复核提供）

| 级别 | 位置 | 问题 |
|---|---|---|
| P0 | `server/repository.js:801-823`（`insertEventRow`） | 证券事件缺少现金腿：仅插入 `security_events`，买入/卖出/分红/费用都不产生可审计的券商现金事实，与 S4C.1 “买卖影响现金”不符 |
| P0 | `server/repository.js:894-915`（`upsertPortfolioOpening` 写入段） | 期初被原位更新后直接返回，没有用 strict 模式重放已有事件 |
| P0 | `server/repository.js:679-695`（`writeOpenings`） | 全量写入静默跳过缺 id 的记录，没有验证数量、日期或同键唯一性 |
| P1 | `js/domain.js:195-220`（`deriveHoldings` 事件重放段） | 先装载期初数量，随后无条件应用全部事件，没有比较 `occurredAt` 与 `openingAsOf` |
| P1 | `server/repository.js:39`（`isDateStr`） | 正则会接受 `2026-02-30` 等不存在日期 |
| P1 | `server/backup.js:180-192`（`validateBackupFile`） | 校验只覆盖必需表和索引，v5 缺 `security_events.amount_minor` 仍通过 |
