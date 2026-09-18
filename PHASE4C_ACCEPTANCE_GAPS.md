# Phase 4C 独立复核 — 缺口与修复记录

## 第 3 轮修复状态（2026-09-18）

> 独立复核确认上轮问题已修复，但新发现 1 个 P0；另有 1 个 Phase 4D P2。本轮已补齐并加入 HTTP 反例，仍等待再次独立复核，不进入 4E。

| 编号 | 级别 | 原始结论 | 修复状态 | 处理方式与证据 |
|---|---|---|---|---|
| G4C-12 | P0 | raw/wrapped `state=[]` 会通过 `typeof object` 校验；`assets=null` 又被当成缺失字段，覆盖写入后账户/持仓/报价/汇率全部清零 | ✅ 已修复 | API 用 own-property 区分 wrapper，并明确拒绝数组根状态；repository 再做同一层纵深校验。`assets` 只有完全缺失时兼容旧备份；显式存在必须为非空对象，`null`、数组、字符串、`{}` 全部 `invalid_assets`。真实 HTTP 逐项拒绝后完整状态与基线深比较一致，仓储直调也验证清库前拒绝 |
| G4D-1 | P2 | 有刷新目标但全被 `manual_locked` 跳过时，顶层 `reason` 错误回退为 `no_targets` | ✅ 已修复 | `scopeSummary` 从实际 skipped 原因推导顶层原因：单一原因透传，多原因用 `skipped`；`no_targets` 只在 `requested=0` 使用。报价/汇率编排断言与真实 HTTP 手动价格锁定反例均通过 |

当前证据：全量 `node --test` **452/452**；4C/4D 真实 HTTP **30/30**；仓储/备份/编排 **65/65**；浏览器 wiring **21/21**；schema 仍为 v7。

---

## 第 2 轮修复状态（2026-09-18）

> 独立复核结论：4C/4D 暂不通过，不建议进入 4E。4C 新发现 1 个 P0、1 个 P1；本轮已按原始反例修复并补测试，等待再次独立复核。

| 编号 | 级别 | 原始结论 | 修复状态 | 处理方式与证据 |
|---|---|---|---|---|
| G4C-10 | P0 | `PUT /state` 把显式错误类型的 `holdings:{}` / `quotes:{}` / `fxRates:{}` 转成空数组，接受请求并清空既有财务事实 | ✅ 已修复 | `normalizeAssets` 区分“字段缺失”与“字段显式存在但类型错误”：缺失仍兼容旧备份为 `[]`；显式非数组在事务和清库前抛 `invalid_asset_collection`（HTTP 400）。真实 HTTP 反例先写入 1/1/1 条事实，再逐键提交 `{}`，三次拒绝后数据仍为 1/1/1；仓储测试另覆盖旧备份缺字段兼容 |
| G4C-11 | P1 | v6 备份只按索引名称与唯一性校验，同名 `UNIQUE(id)` 可冒充 `(account_id, instrument_id)` 去重索引 | ✅ 已修复 | `db.indexInfo` 读取 `PRAGMA index_list` + `PRAGMA index_xinfo`，返回 key 列、unique 与 partial；`backup.js` 严格要求列顺序 `account_id, instrument_id` 且非 partial。反例替换同名索引为 `UNIQUE(id)`、插入同账户/同标的重复期初后，备份校验明确因“索引列不匹配”拒绝 |

当前证据：全量 `node --test` **449/449**；仓储/备份/编排定向 **64/64**；4C/4D 真实 HTTP **28/28**；浏览器 wiring **21/21**；schema 仍为 v7。本轮只补 4C/4D，未进入 4E。

---

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

## 补充完整性审计（2026-09-17）

在继续复核 4C 写入边界时又补齐 3 组缺口；不改变持仓数量口径，也不新增数据库迁移：

| 编号 | 级别 | 缺口 | 修复与证据 |
|---|---|---|---|
| G4C-7 | P0 | 事件事实与 `Idempotency-Key` 记录分两次提交；进程在两者之间失败会留下“事件已写、幂等键未记”，重试可能形成第二笔事实；同一 key 换请求体还会错误回放首次响应 | 两者改为**同一 SQLite 事务**；幂等记录保存规范化 JSON 的 SHA-256 指纹，同 key 不同请求体 → 409 `idempotency_conflict`。真实 HTTP 反例 2 项：强制幂等表写失败时事件零残留；不同数量复用 key 时只保留首笔 |
| G4C-8 | P1 | 期初/事件只检查账户存在，没有落实 ARCHITECTURE “持仓必须指向证券账户”；全量事件路径的引用校验还依赖数据库外键，错误语义会分叉 | `validateOpeningRow` / `validateEventRow` 共用账户类型与引用校验：仅 `kind=broker` 可承载持仓，普通账户 → 422 `invalid_account_type`；单条与 `PUT /state` 同口径、失败整体回滚 |
| G4C-9 | P1 | 事件校验归一时丢弃未知扩展字段；dividend/fee 声明 quantity 可选但传入后被静默清空；冗余 currency 若进入 extra 会覆盖推导值 | 事件扩展字段写入 `extra_json` 并往返保留；分红/费用携带 quantity 时校验正定点并保存，但推导仍不改数量；`currency` 纳入已知字段并始终由标的推导，载荷伪造值不会进入 extra 覆盖。真实 HTTP 往返反例 1 项 |

补充后定向 `tests/server-phase4c.test.js` **20/20**；最终全量与 wiring 证据见 `TEST.md`。

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
