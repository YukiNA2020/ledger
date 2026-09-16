# Phase 4B 验收缺口记录（独立复核）

> 记录来源：独立复核 Agent 于 2026-09-16 对 Phase 4B（提交 `689743e`，基线 `node --test` 344/344、wiring 16/16）的复核结论。
> 本文件规则：**原始复核结论原样保留作证据**，修复状态追加在文件顶部，不删改原始条目。

## 修复状态（2026-09-16，执行 Agent）

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

## 原始复核结论（原文保留，2026-09-16）

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
