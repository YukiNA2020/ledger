# Phase 4B 验收缺口记录（独立复核）

> 记录来源：独立复核 Agent 于 2026-09-16 对 Phase 4B 的两轮复核结论 —— 第一轮针对提交 `689743e`（基线 `node --test` 344/344、wiring 16/16），第二轮针对补口提交 `147588e`（基线 357/357、wiring 16/16）；其后执行 Agent 又做了一轮面向 4C 引用安全的反向审计。
> 本文件规则：**原始复核结论原样保留作证据**（按轮次倒序，最新一轮状态在前），修复状态追加在对应轮次的状态节里，不删改原始条目。

## 第三轮反向审计与修复状态（2026-09-16，执行 Agent）

| 编号 | 级别 | 反向审计结论 | 修复状态 |
|---|---|---|---|
| G4B-8 | P0 | `upsertInstrument` 用“先删后插”更新父记录，会触发外键 `ON DELETE CASCADE`，删除该标的已有的持仓快照、证券事件与报价 | ✅ 已修：改为 `INSERT ... ON CONFLICT(id) DO UPDATE` 原位更新；新增真实外键事实反例，更新名称后 `portfolio_openings` / `security_events` / `quotes` 各自仍为 1 行 |
| G4B-9 | P0 | 元数据只校验契约形状，不校验返回的 `symbol` 是否等于请求代码；合法的“另一只标的”可被替包入库。调用方提交交易所与 provider 不一致时也会静默采用 provider 值 | ✅ 已修：元数据必须绑定请求代码，不一致返回 `invalid_provider_payload` 且零写入；交易所冲突返回稳定 `exchange_mismatch`（HTTP 400），与既有币种冲突规则一致 |
| G4B-10 | P1 | 搜索 provider 返回非数组或非法候选时被静默当成空结果/丢弃，用户无法区分“无命中”与“契约坏了” | ✅ 已修：非数组或非法候选转为显式 `invalid_payload` provider 状态与 warning；本地命中仍可降级返回，坏候选不进入目录 |
| G4B-11 | P1 | 本地只有一条无交易所记录、provider 同时返回两个市场时，旧实现先把第一条候选合并到本地，再只对第二条报警；归属由 provider 返回顺序决定 | ✅ 已修：合并前先计算完整的松匹配认领集合；若同一本地记录对应多个市场，则两个 provider 候选都保持独立、本地记录也单独保留，只报告一次歧义 |
| G4B-12 | P0 | 全量 `/state` 虽校验 id/symbol/currency，但可写入任意 `classificationStatus`、非法 `assetClass`/`exposureMarket`，也可写入缺少完整分类的 `confirmed`；同时未统一大写规范化 | ✅ 已修：全量写入与单条 upsert 使用同一组严格规则；状态只允许 `suggested/confirmed`，分类使用领域词表，`confirmed` 必须两项齐全；symbol/exchange/currency 去空白并大写。错误稳定映射为 HTTP 400，事务整体回滚 |

**本轮测试证据：** `instrument-catalog` **48/48**、真实 HTTP `server-phase4b` **17/17**、全量 `node --test` **371/371**；`git diff --check` 通过。没有新增迁移、UI 或真实网络请求；浏览器接线未改，沿用上一轮 **17/17** 证据。

**审计结论状态：** G4B-8–12 已修复。4B 的标的身份、引用完整性、provider 绑定、歧义处理与分类写入边界均已由反例锁定，可交独立复核确认。

---

## 第二轮修复状态（2026-09-16，执行 Agent）

| 编号 | 级别 | 原始结论 | 修复状态 |
|---|---|---|---|
| G4B-5 | P1 | `PUT /state` 静默丢弃没有 id 的标的、把空白 `symbol` 写成空字符串（`writeInstruments` 先用 `.filter(i => i && i.id)` 过滤） | ✅ 已修：`repository.writeInstruments` 改为**两遍写入** —— 第一遍逐条验证并归一（id 必填且形状合法、`symbol` 去空白后必须符合公开证券代码形状、`currency` 必填且在白名单内、记录必须是对象），任一条不合格立即抛错；第二遍校验去重键后才插入。`writeState` 全程在一个事务内，抛错即整体回滚（不是"先清后写留下空库"）。`api.js` 领域错误码映射补 `invalid_instrument`，四条反例 HTTP 一律 **400**。真实 HTTP 反例：缺 id / 空白代码 / 币种非法 / 币种缺失各自 400 + `GET /state` 证明上一次状态（两条）逐条原样保留；合法写入照常 200 |
| G4B-6 | P1 | `DROP INDEX uq_instruments_dedupe` 后 `validateBackupFile` 仍返回 `{"ok":true,"schemaVersion":4}`（只按版本查表，不查索引级不变量） | ✅ 已修：`backup.js` 新增**按 schema 版本维护的必需索引清单** `REQUIRED_INDEXES_BY_VERSION`（v4：`instruments.uq_instruments_dedupe` 必须存在**且为唯一索引**），`validateBackupFile` 在表校验后逐条校验；`server/db.js` 新增 `indexInfo()`（存在性 + 所属表 + 唯一属性；PRAGMA 读不到属性时按"不唯一"处理 —— 宁可拒绝，也不放过不变量缺失的库）。恢复通道本来就先走同一个校验函数，因此一并堵住 |
| G4B-7 | P1 | 检索只按精确 `(symbol, exchange)` 合并，本地 `VOO@` 与 provider `VOO@NYSE` 会同时展示 | ✅ 已修：`searchCatalog` 抽出 `matchLocalRecord()`，与建立路径（`repository.findInstrumentByKey`）**同一套规则**：精确命中 → 同代码且一方缺交易所时唯一命中可安全合并 → 多命中或"同一条本地记录被两个市场认领"时报 `ambiguous_instrument` 且**不合并**。命中的本地记录被候选认领后不再单独成行；候选缺的展示字段只补空、不覆盖，且**不进入预分类建议**（建议依据必须仍指向 provider，本地值不得冒充） |

**本轮补口测试证据：** 全量 `node --test` **367/367**（357 基线零回归 + 10 项新反例/不变量：`instrument-catalog` 40→44、`server-phase4b` 15→17、`server-backup` 16→19、`server-restore` 8→9）；浏览器 wiring **17/17**（新增 1 项真实 UI 闭环，干净环境连续两轮全绿）；零真实网络请求、零数据库迁移。

**新增反例/不变量清单：**

1. 全量写入：缺 id / 空白代码 / 含空格的代码 / 币种不在白名单 / 币种缺失 / 记录不是对象 → 一律抛错且**整体回滚**（拒绝后库里的行数与内容仍是上一次状态，不留半行）。
2. 真实 HTTP：上述四条各自 400（稳定 `invalid_id` / `invalid_symbol` / `invalid_currency`），`GET /state` 证明原状态不变；合法写入照常 200。
3. 必需索引：v4 库删掉 `uq_instruments_dedupe` → 校验拒绝并点名索引；把同名索引换成**非唯一**索引 → 同样拒绝（唯一性也是不变量）；活库丢索引时 `createBackup` 拒绝产出备份且不留残留文件。
4. 恢复通道：候选备份缺索引 → 拒绝恢复、当前库逐字段不变、连"恢复前备份"都不产生（校验发生在切换之前）。
5. 检索合并：本地缺交易所 + 参考数据有交易所 → 合成**一条** `local+provider` 候选；本地记录不被改写（检索只读）；建议依据仍全部来自 provider。
6. 检索歧义：同代码本地多市场 + 参考数据未给交易所 → 报 `ambiguous_instrument` 且不合并；本地只有一条缺交易所记录时，第二个市场的候选同样报歧义（同一条本地记录不得被两个市场重复认领）。
7. 浏览器闭环：手工建标（不填交易所）→ 检索 → 搜索卡片内只有 1 条候选、该候选不再提供"加入目录"入口、事实源中标的 id 与交易所都没变。

**本轮未改动的边界（沿用第一轮结论）：** 全量 `/state` 与恢复通道仍原样还原既有 id（历史快照带 `ins-voo` 这类旧形状 id，强制"id 必须可复算"会把可用恢复路径变成拒绝恢复）；恢复通道的强约束是**去重键**（已强制）。本轮新增的逐条校验只约束 id / symbol / currency 的**合法性与存在性**，不要求 id 等于按当前交易所推导的值。

**复核结论状态：** 本轮修复后 4B 状态为「第二轮补口完成，等待独立复核确认」。

---

## 第一轮修复状态（2026-09-16，执行 Agent）

| 编号 | 级别 | 原始结论 | 修复状态 |
|---|---|---|---|
| G4B-1 | P0 | 客户端可以在建立载荷里指定任意合法格式的 `id`（`{"symbol":"VOO","id":"client-chosen-id"}`），绕过 D-039 的确定性派生 | ✅ 已修：`parseCreatePayload` 遇到非空 `id` 一律返回 `client_id_forbidden`，**显式拒绝而不是静默忽略**（静默改写客户端提交的身份字段等于无声分叉）；`createInstrument` 只按 identity key 派生 id，去掉 `v.id` 分支。真实 HTTP 反例：伪造 id → 400 + 响应不回显该值 + 目录零写入；去掉 id 后拿到 `inst-<sha1(VOO@NYSE) 前16位>` |
| G4B-2 | P0 | 全量 `/state` 写入绕过标的去重：`writeInstruments` 逐行直插，无归一化校验、也无唯一索引，`VOO/NYSE` 与 `voo/nyse` 能同时落库 | ✅ 已修（两层）：① `writeInstruments` 写入前用与领域一致的归一规则（去空白 + 大写，缺交易所计空串）预校验去重键与 id，重复**整体拒绝**并抛 `duplicate_instrument`，事务回滚；`api.js` 增加领域错误码 → HTTP 状态集中映射，重复是 **409**（可修正的冲突）而不是 500；② 新增**迁移 v4** 表达式唯一索引 `uq_instruments_dedupe` 做数据库层兜底。真实 HTTP 反例：`PUT /state` 带两行归一后相同的标的 → 409 + `GET /state` 证明上一次状态原样保留 |
| G4B-3 | P1 | 缺交易所时退化匹配用 `.find()` 按行顺序取第一条，同代码跨市场（NYSE + HKEX）会被静默合并并返回 `duplicated:true` | ✅ 已修：`findInstrumentByKey` 收集**全部**退化候选并在多于一条时抛 `ambiguous_instrument`（精确匹配仍照常命中）；`createInstrument` 捕获后返回稳定失败码 → HTTP **409** + 中文提示"请指明交易所"；只有一条同代码记录时仍允许补全交易所，既有路径未被破坏 |
| G4B-4 | 一致性 | "先建无交易所标的、后补交易所"保留旧 id，与"ID 可用当前 `symbol@exchange` 复算"的文档表述冲突 | ✅ 已采纳**第二条规则**：id 由**首次创建时的 identity key** 派生并永久锁定，记录持久化 `identityKey`（新增 `stableIdFromKey` / `identityKeyOf`，`upsertInstrument` 落库 `identityKey`）；补全交易所后 id 与 `identityKey` 都不重算，外部用 `identityKey` 离线复算 id。D-039 ①②、ARCHITECTURE §5.2、README 的表述同步改写，不再声称能用"当前交易所"重算 |

**补口测试证据：** Phase 4B 定向测试 **87/87**（`providers-catalog` 26 + `instrument-catalog` 40 + `server-phase4b` 15，其中本轮新增 13 项反例/不变量）；全量 `node --test` **357/357**（344 基线零回归）；浏览器 wiring **16/16**（干净环境连续两轮全绿）；零真实网络请求。数据库侧新增迁移 **v4**（仅一条表达式唯一索引，不新增表，`backup.js` 必需表清单不变）。

**新增反例/不变量清单：**

1. 载荷校验：客户端 id（含看起来像派生值的 `inst-…`、含空格的、含中文的）一律 `client_id_forbidden`，且错误信息不回显该值；空串/缺省不算指定。
2. 真实 HTTP：伪造 id → 400 且目录零写入；`stableIdFromKey('VOO@NYSE') === 派生 id`。
3. `identityKey` 不可变：无交易所建标 → 补 HKEX，id 与 identityKey 都不变、`duplicated:true`、目录仍一行。
4. 全量写入：`VOO/NYSE` + `voo/nyse` → `duplicate_instrument`；同一 id 重复 → 同样拒绝；拒绝后库里仍是上一次状态（整体回滚）。
5. 数据库兜底：绕过应用层直插归一后相同的两行（大小写、空白、缺交易所三个形态）均被唯一索引拒绝；不同交易所可共存。
6. 迁移守卫：v3 库中存在重复标的时，v4 迁移**显式失败**且整体回滚（版本停在 v3，两行数据原样保留）。
7. 歧义：`findInstrumentByKey` 多候选抛 `ambiguous_instrument`；HTTP 409 + 提示含"交易所"；报错时两行都不被改动；明确交易所后命中同一行。

**明确边界（复核未要求，记录在此以免被当成遗漏）：**

- **全量 `/state` 与备份恢复通道原样还原既有 id**，不在该路径上强制"id 必须可由 identityKey 复算"。理由是历史快照本来就带旧形状 id（仓库夹具 `tests/fixtures/phase1-backup-v2.json`、`acceptance_backup.json` 与 wiring 场景都使用 `ins-voo` 这类 4B 之前的 id），强制派生会把可用的恢复路径变成拒绝恢复、破坏备份往返保真；恢复通道的强约束是**去重键**（已强制）。身份派生规则在创建入口（`POST /api/v1/instruments`）强制，D-039 已写明该边界。
- 复核未要求，但一并加固：`/state` 全量写入遇到重复去重键时返回的是 **409**（而非 500），使前端能区分"这次写入被拒、数据没动"与"服务端出错"。

**复核结论状态：** 本轮修复后 4B 状态为「补口完成，等待独立复核确认」。修复前的原始结论原文保留在下方，未做删改。

---

## 原始复核结论·第一轮（原文保留，2026-09-16）

4B **暂不通过验收，不建议进入 4C**。正常流程全部通过，但标的身份和去重边界存在 3 个可复现问题，而 4C 会直接依赖这些 ID。

**测试结果**

- Phase 4B 定向测试：**70/70 通过**
- 全量回归：**344/344 通过**
- 浏览器接线：**16/16 通过**
- 工作区干净
- 没有新增数据库迁移
- 持仓、证券事件、行情刷新接口仍返回 501
- 自动测试没有访问公网

**阻塞问题**

1. **P0：客户端可以绕过稳定 ID 派生。**
   `instrument-catalog.js`（line 92）接受客户端提供的任意合法格式 `id`。

   实测创建 VOO 时传入：

   ```json
   {"symbol":"VOO","id":"client-chosen-id"}
   ```

   最终 ID 就是 `client-chosen-id`，而不是约定的：

   ```text
   inst-f2b4619c9eb3b36f
   ```

   这违反 D-039 的“ID 由 `symbol@exchange` 确定性派生”。进入 4C 后，不同账户可能引用无法复算的标的 ID。

   修复：创建接口禁止或忽略客户端 `id`，始终由服务端生成；补真实 HTTP 反例。

2. **P0：全量 `/state` 写入可以绕过标的去重。**
   `repository.js`（line 352）的 `writeInstruments` 直接逐行插入，没有验证规范化后的 `(symbol, exchange)`。

   我写入：

   ```text
   inst-a → VOO / NYSE
   inst-b → voo / nyse
   ```

   两行都成功落库。数据库也没有对应唯一索引。因此“同一标的不重复创建事实”只在新目录接口成立，JSON 恢复、全量保存等旧写入路径仍可绕过。

   修复：`writeInstruments` 在写入前检查规范化去重键并整体拒绝重复；最好再增加数据库唯一约束或迁移。补 `/api/v1/state` 重复标的回滚测试。

3. **P1：缺交易所时会错误合并跨市场同代码标的。**
   `repository.js`（line 428）使用 `.find()` 做退化匹配。存在：

   ```text
   CROSS / NYSE
   CROSS / HKEX
   ```

   再建立一个缺交易所的 `CROSS` 时，系统会静默命中第一条 NYSE 记录，并返回 `duplicated:true`。这取决于数据库行顺序，可能把跨市场标的合并错。

   修复：退化匹配为零条时新建或要求交易所；一条时允许补全；多条时返回 `ambiguous_instrument`，要求用户选择交易所。

**附带一致性问题**

“先手工建立无交易所标的，再由 provider 补全交易所”会保留旧 ID。补全后，现有 ID 不再等于当前 `symbol@exchange` 的计算结果，与“稳定 ID 可外部复算”的文档表述冲突。需要明确采用以下一种规则：

- 创建前必须确定交易所；或
- ID 基于首次创建时的不可变 identity key，文档不再声称能用当前交易所重新计算。

其他 4B 能力，包括检索、suggested、用户确认、confirmed 锁定、刷新不覆盖、provenance、冲突提示、手工建立和浏览器闭环，均已通过。

### 代码定位（复核给出的锚点）

| 级别 | 位置 | 结论 |
|---|---|---|
| P0 | `server/instrument-catalog.js` line 92–98 | 创建载荷允许客户端传入任意格式合法的 `id`，`createInstrument` 随后优先使用该值，绕过 D-039 的 `symbol@exchange` 确定性派生。创建 API 应拒绝或忽略 `id`，并始终由服务端生成。 |
| P0 | `server/repository.js` line 352–371 | `writeInstruments` 直接插入数组，没有检查规范化后的 `symbol+exchange`；`PUT /state` 因而能同时写入 `VOO/NYSE` 和 `voo/nyse` 两行。应在事务内预校验重复键，并考虑增加数据库唯一约束。 |
| P1 | `server/repository.js` line 428–438 | 当请求缺少 `exchange` 时，条件中的 `!exchange` 对所有同代码记录成立，`find` 会按行顺序返回第一条。若同代码同时存在 `NYSE`/`HKEX` 等多条记录，应返回 `ambiguous_instrument`，而不是静默选中其中一条。 |

---

## 原始复核结论·第二轮（原文保留，2026-09-16）

本轮 **Phase 4B 暂不通过验收，不建议立即进入 4C**。之前的 3 个阻塞问题已经修复，但反向测试又发现 3 个边界缺口。

**测试结果**

- Phase 4B 定向测试：**97/97 通过**
- 全量回归：**357/357 通过**
- 浏览器端到端：**16/16 通过**
- 工作区保持干净，临时服务已停止

**剩余问题**

1. **P1：`PUT /state` 会静默丢弃或接受非法标的。**
   `repository.js`（line 357）先用 `.filter(i => i && i.id)` 删除没有 ID 的记录；空白 `symbol` 又会在写入时变成空字符串。

   实测提交两条标的：

   - `NO-ID` 因缺少 ID 被静默丢弃
   - `blank-symbol` 的空白代码成功落库

   修复要求：写入前逐条验证 `id`、`symbol`、`currency`，任意一条非法就整体拒绝并回滚。补真实 HTTP 用例，确认返回稳定 4xx 且原状态不变。

2. **P1：v4 备份缺少唯一索引仍能通过校验。**
   手工执行 `DROP INDEX uq_instruments_dedupe` 后：

   ```text
   validateBackupFile → {"ok":true,"schemaVersion":4}
   ```

   `backup.js`（line 164）只按版本检查表，没有检查 v4 引入的数据库不变量。恢复后迁移器看到版本已经是 v4，也不会重建索引。

   修复要求：增加按 schema 版本维护的必需索引清单；v4 必须检查 `uq_instruments_dedupe` 存在且为唯一索引。补“删除索引后校验和恢复均拒绝”的测试。

3. **P1：搜索合并仍会展示重复候选。**
   先手工建立无交易所的 `VOO@`，再搜索 provider 的 `VOO@NYSE`，返回：

   ```text
   VOO@NYSE  origin=provider
   VOO@      origin=local
   ```

   `instrument-catalog.js`（line 320）只按精确 `(symbol, exchange)` 合并，没有复用建立流程的安全退化匹配规则。

   修复要求：同代码只有一条本地记录且一方缺交易所时合并为 `local+provider`；同代码存在多个市场时继续显式报告歧义。补无交易所合并和跨市场歧义两组检索测试。

### 代码定位（复核给出的锚点）

| 级别 | 位置 | 结论 |
|---|---|---|
| P1 | `server/repository.js` line 357–368 | 这里先过滤掉所有缺少 id 的标的，导致 `PUT /state` 或恢复载荷中的记录无错误地消失；后续还会把空白 symbol 写成空字符串。应先验证完整数组，遇到非法 id、symbol 或 currency 时整体拒绝并回滚。 |
| P1 | `server/backup.js` line 164–166 | 校验目前只检查按版本要求的表。删除 `uq_instruments_dedupe` 后，`schemaVersion=4` 的数据库仍返回 ok；恢复时迁移器也不会重建已经标记为应用的 v4。应按版本验证必需索引及其唯一属性。 |
| P1 | `server/instrument-catalog.js` line 320–329 | 搜索候选只按精确 `symbol@exchange` 合并，因此本地 `VOO@` 与 provider `VOO@NYSE` 会同时显示。应在唯一松散候选时安全合并；存在多个市场候选时返回或展示明确歧义，避免任选记录。 |
