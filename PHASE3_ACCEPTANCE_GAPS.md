# Phase 3 剩余验收问题与修复交接

> **修复状态（2026-09-15，v2.3.2-phase3）：本文列出的 P0/P1 已全部修复并复验。**
> - P0-A 负债核对日期 + 正式月结闭环 → 负债表单新增 `#al-asof`（默认结账月末）；接口与浏览器（wiring P0-A）双路径证明有负债时也能正式结账。
> - P0-B 快照明细与金额下钻 → 新增 `GET /api/v1/close-snapshots/:id` + 月结页「查看明细」（三张事实表 + 应急覆盖口径）。
> - P1-A 青岛福利预设与来源说明 → 资产页四个预设入口按「有无明确余额」分流；权益补 `jurisdiction`/`sourceRef`/`valuationType`；S3.2 四类分流端到端与 wiring 均通过。
> - P1-B 手动汇率 → 新增 `POST /api/v1/fx-rates` + 资产页汇率表单；登记后 `fx_missing` 消失，正式结账不再被汇率缺项阻断（保留自动 provider 给 Phase 4）。
> - P1-C 备份条件校验 → `REQUIRED_TABLES` 按候选库 schema 版本条件化；`writeState` 的换汇币种改由关联余额单元推导。
> - P2 文档数字 → 已统一为 `node --test` **230/230**、wiring **15/15**、`server-phase3` **14/14**，版本 `v2.3.2-phase3`。
>
> 复验命令：`node --test`（230/230）；`node server/main.js --data-dir "$(mktemp -d)" --port 8499 --no-open` 后跑 `tests/app-wiring.html`（15/15）。
> 遗留：15 分钟月结的真实耗时按计划留待 Phase 7 验证。
>
> 以下为原始验收记录，保留作证据。

> 验收日期：2026-09-15  
> 验收对象：`phase/03-accounts-liabilities-close` 当前工作区（含尚未提交的 v2.3.1 S3.1 补丁）  
> 数据约束：仅使用临时 SQLite 与虚构数据，未修改用户账本。

## 当前结论

- **S3.1 数据模型、API 与浏览器接线：通过。**
- **Phase 3 整体：暂不通过。** 以下 P0 问题会阻止标准数据通过界面完成正式月结，或不满足“所有金额可下钻到来源”的退出条件。
- 不要在修完并复验以下 P0/P1 项之前把 `ROADMAP.md`、`TEST.md` 或 `NEXT_AGENT.md` 标成 Phase 3 完成，也不要直接把工作入口切到 Phase 4。

## 已验证的 S3.1

### 自动化结果

- `node --test tests/server-phase3.test.js tests/domain.test.js tests/dedup.test.js`：**57/57 通过**。
- `node --test`：**221/221 通过**，包括 2 项真实 macOS Keychain 测试。
- 隔离服务 `127.0.0.1:19404` + 无头 Chromium `tests/app-wiring.html`：**13/13 通过**。
- 额外 repository 边界探测：未知子账户得到 `unknown_unit`、同币种换汇得到 `same_currency`、同 id 重放后仍为 1 条且金额更新，全部符合预期。

### 已满足的行为

1. “香港汇丰”机构下同一资产账户可以分别保存 HKD 与 USD 余额。
2. 两个原币余额保持独立，只有 `/api/v1/overview` 汇总时按各自汇率折算为 CNY。
3. HKD→USD 换汇保存到 `asset_transfers`，固化两端子账户、币种、金额和日期。
4. 换汇不会写入旧现金流 `txns`，因此不会增加收入或支出。
5. 全量 `PUT /state` 往返后，账户、两个余额和换汇记录仍然存在。
6. 同一账户同币种从前端再次登记时复用已有余额单元 id，不新增重复记录。

### S3.1 后续建议测试

- 在 `tests/server-phase3.test.js` 增加：未知换汇子账户返回 422、同币种两端返回 400、同 id 重放更新且不增加记录。
- 在 repository 测试增加：`writeState` 拒绝 `fromCurrency/toCurrency` 与关联余额单元币种不一致的数据。目前 API upsert 会校验，但全量写入路径 `server/repository.js:210-233` 直接信任载荷中的历史币种。
- 在备份测试增加包含 `asset_transfers` 的创建、恢复和完整性断言。

已用临时库复现全量写入缺口：转出子账户实际为 HKD、转入子账户实际为 USD，但载荷把历史币种写成 USD→HKD，`R.writeState` 仍成功落库并原样读回。修复时应由关联余额单元决定/校验币种，不能信任全量状态里的重复字段。

## P0：有负债时无法从界面完成正式月结

### 复现

1. 在 2026-09 打开“资产录入”。
2. 登记一个核对日期为 2026-08-31 的账户余额。
3. 新增任意负债，例如“信用卡待还 500 元”。
4. 打开月度结账；页面结账对象固定为 2026-08。

### 实际结果

- 负债表单没有“核对日期”字段（`js/app.js:680` 附近）。
- 保存负债时 `asOf` 固定为 `todayDateStr()`（`js/app.js:2623`）。
- `computeCloseChecklist` 要求负债 `asOf` 与结账月份相同（`js/domain.js:352-368`）。
- 因此出现 `balance_stale（信用卡待还）`，正式结账按钮永久禁用，只能保存估算。

### 预期与建议修复

- 负债表单增加核对日期，默认值应与当前结账对象协调；保存时提交用户选择的日期。
- 最小修复：增加 `#al-asof`，写入 `asOf: $('#al-asof').value`。
- 更稳妥的交互：月结清单中的负债缺项可直接进入“更新负债余额/核对日期”。

### 必须新增的测试

- 浏览器测试完整走通：录入上月余额 + 上月负债 → 打开月结 → `formal` 按钮可用 → 确认 → 历史记录状态为 `formal`。
- 测试必须包含标准虚构数据中的信用卡负债，不能只测无负债资产集。

## P0：历史月结金额没有用户可用的下钻链路

### 当前实现

- 服务端快照正文包含 `overview` 与 `checklist.facts`（`server/api.js:523-531`），数据库也保存完整 `payload_json`。
- repository 已有 `getCloseSnapshotPayload`（`server/repository.js:1126` 附近）。
- 但公开 API 只有结账列表和创建接口；列表只返回摘要、哈希和日期（`server/api.js:480-484`、`server/repository.js:1050-1072`）。
- 历史结账界面只展示净资产、应急覆盖和哈希前 8 位（`js/app.js:743-753`），没有点击或展开动作。

### 与验收条件的差距

`ACCEPTANCE.md` 要求“每个金额均能下钻到余额、估值或交易来源”。当前只能证明快照内部存有事实，产品用户无法查看这些事实，不能算完成下钻。

### 建议修复

1. 新增只读接口，例如 `GET /api/v1/close-snapshots/:id`，返回指定快照正文；校验 id 并在不存在时返回 404。
2. 通过 `js/store.js` 增加读取方法，页面代码不要直接 fetch。
3. 历史结账行增加“查看明细”，展示：
   - 账户余额：账户、原币金额、折算金额、核对日、来源类型；
   - 负债：名称、原币金额、折算金额、核对日、期限；
   - 持仓：标的、数量、价格、价格日、原币市值、CNY 市值；
   - 汇总金额与上述事实的对应关系。
4. 如果“交易来源”是退出条件的一部分，应把必要支出/应急覆盖所使用的月份和交易汇总依据也封入并展示；当前快照只保存最终覆盖月数。

### 必须新增的测试

- 快照详情 API 返回的 payload 哈希重新计算后与列表哈希一致。
- 浏览器从历史结账点击明细，能看到标准数据中的“汇丰 USD 子账户”“信用卡待还”和对应核对日/金额。

## P1：青岛福利预设与来源说明未落地

### 当前差距

- `ROADMAP.md` 声称已有青岛公积金、医保、养老及社保卡预设，但页面只有通用“新增保障权益”表单（`js/app.js:697-706`）。
- 表单没有 `jurisdiction`、`sourceRef`、`valuationType` 字段；保存动作也没有提交这些字段（`js/app.js:2630-2646`）。
- API 虽支持这些字段，但普通用户无法从产品界面维护或查看来源。
- “参考金额”一律作为 entitlement 展示且不计入资产。用户若把公积金或医保个人账户的明确余额填在这里，该金额不会进入总资产；界面没有指导明确余额应建立为受限资产账户，也没有社保卡银行账户与社保权益的分流预设。

### 建议修复

提供四个明确入口或预设：

| 预设 | 应写入的数据 | 是否计入资产 |
|---|---|---|
| 青岛公积金余额 | `assetAccount(pool=restricted, kind=government)` + CNY `accountUnit` | 是，且只计一次 |
| 医保个人账户余额 | 受限资产账户 + CNY `accountUnit` | 是，且只计一次 |
| 养老/医保/失业等无余额资格 | `entitlement(balanceMinor=null)` | 否，只显示状态 |
| 社保卡金融账户 | 普通银行资产账户，不与社保权益合并 | 是 |

所有预设应允许维护地区、查询来源/链接、核对日期和状态，并在列表中显示来源说明。

### 必须新增的测试

- 采用 ACCEPTANCE S3.2 的四类标准数据，断言公积金和医保明确余额各计一次、无余额权益不计入、社保卡金融账户独立。
- 浏览器测试应从预设入口创建这些记录，不能通过备份 fixture 绕过产品路径。

## P1：外币账户缺少可用的汇率维护路径

### 当前差距

S3.1 的汇总逻辑在有 `fxRates` 时正确，但 Phase 3 页面不能录入或更新汇率；现有测试通过 repository 直接注入固定汇率。用户仅通过 Phase 3 页面创建 HKD/USD 余额后，总览会显示 `fx_missing` 并保持估算口径。

### 处理选择

- 如果 Phase 3 必须独立达到正式月结：增加手动汇率录入与核对日，自动行情继续留给 Phase 4。
- 如果明确由 Phase 4 提供汇率：修改 Phase 3 退出条件和状态，不能在 Phase 4 尚未完成时声称带外币标准数据的 Phase 3 已可正式月结。

### 必须新增的测试

- 仅通过产品页面创建 HKD/USD 余额并提供手动汇率后，总览能得到预期 CNY 汇总，且月结不再因 `fx_missing` 被阻断。

## P1：备份结构校验没有覆盖 Phase 3 新表

`server/backup.js:29` 的 `REQUIRED_TABLES` 没有 `monthly_closes`、`close_snapshots`、`asset_transfers`。因此一个声称 schema v3、但缺少这些表的损坏数据库可能通过候选备份校验；迁移器看到 v3 已应用后也不会重建缺表。

已用临时 v3 数据库执行 `DROP TABLE asset_transfers` 后调用 `validateBackupFile`，实际返回 `{"ok":true,"schemaVersion":3}`，缺口可稳定复现。

建议按候选库 schema 版本做条件校验：v1 要求基础表，v2 额外要求月结表，v3 额外要求 `asset_transfers`。增加“schema_migrations 已记录 v3 但删除 asset_transfers”的恢复拒绝测试。

## P2：验收文档数字和结论需要重新同步

- 当前实际全量结果是 **221/221**，`TEST.md` 仍写 219/219 或旧基线数字。
- `ROADMAP.md` 与 `NEXT_AGENT.md` 已把 Phase 3 标为完成，但上述 P0 条件仍未满足。
- 修复后应在一次干净工作区上重新跑全量与浏览器正式月结场景，再统一更新 `TEST.md`、`ROADMAP.md`、`ACCEPTANCE.md`、`NEXT_AGENT.md` 和版本号。

## 建议修复顺序

1. 负债核对日期 + 正式月结浏览器闭环。
2. 快照详情 API、Store 门面和历史金额下钻。
3. 青岛福利预设、来源字段及 S3.2 完整端到端测试。
4. 决定 Phase 3 手动汇率边界并消除正式月结的 `fx_missing` 阻塞。
5. 条件化备份结构校验。
6. 全量复验并统一文档状态与测试数字。
