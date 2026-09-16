# Ledger v3 验收规格

> 版本：v3 MVP 冻结稿  
> 用途：定义“做完”的可观察证据。执行 Agent 必须使用虚构数据完成自动化与人工验收，不得把真实财务数据写入仓库、日志或外部服务。

## 1. 实施前基线门禁

开始任何 v3 编码前：

1. 记录 `git status --short`，不得覆盖已有未提交修改。
2. 运行 `node --test`；2026-09-06 的文档冻结基线为 **99 项通过、0 项失败**。
3. 打开原应用，确认手动记账、账单导入、明细和统计仍可进入。
4. 确认本机尚无需要迁移的真实 IndexedDB 数据；若已出现真实数据，暂停 Phase 2 并补迁移/备份方案。
5. 每个 Phase 建立独立、可回滚的改动边界，不把多个 Phase 合并为一次重写。

## 2. 标准虚构验收数据

所有金额均为虚构，仅用于核对公式：

| 对象 | 数据 |
|---|---|
| 人民币安全储备 | CNY 30,000，余额日为验收日 |
| 汇丰 USD 子账户 | USD 1,000，标记为可投资现金 |
| USD/CNY 汇率 | 7.20，汇率日为验收日 |
| 宽基 ETF 持仓 | 10 份，USD 50/份，分类为 `broad_equity` |
| 公积金 | CNY 5,000，明确余额，标记为受限资产 |
| 信用卡待还 | CNY 2,000，标记为近期应付款 |
| 无余额权益 | 失业保险待遇资格，金额为空 |
| 本月新增资金 | CNY 2,000 |

预期口径：

- 可投资现金：`1,000 × 7.20 = CNY 7,200`；
- ETF 市值：`10 × 50 × 7.20 = CNY 3,600`；
- 总资产：`30,000 + 7,200 + 3,600 + 5,000 = CNY 45,800`；
- 总负债：`CNY 2,000`；
- 净资产：`CNY 43,800`；
- 可投资资产：`7,200 + 3,600 = CNY 10,800`；
- 无余额权益不进入任何金额合计；
- 可新增投资资金还必须考虑安全储备缺口和近期应付款，不能直接等于账户余额。

## 3. Phase 1｜资产领域基础

### S1.1 旧状态兼容

**Given** 只有 v2 的 `accounts/categories/txns/settings`，没有任何 v3 字段。  
**When** 新版本首次加载并导出备份。  
**Then** 页面正常启动；v3 集合初始化为空；旧交易数量、金额和字段不变；备份可再次恢复。

### S1.2 财务定点计算

**Given** 标准虚构数据。  
**When** 计算资产负债与风险资产配比。  
**Then** 得到第 2 节的精确结果；金额不存在浮点尾差；负债不被记为负资产；受限资产不进入可投资资产。

### S1.3 缺失数据不可静默

**Given** USD 资产存在但 USD/CNY 汇率缺失。  
**When** 查看总览。  
**Then** 该资产不被悄悄按 1:1 计算；页面标明部分估值缺失；正式建议不可用。

### S1.4 首页与旧功能并存

**Given** 没有录入任何资产。  
**When** 打开新版首页。  
**Then** 展示空状态而非虚构总额；用户仍能进入原记账、导入、明细、预算和统计。

Phase 1 退出证据：新增领域单测、旧 99 项全绿、浏览器 wiring 回归、备份往返测试和空状态截图。

## 4. Phase 2｜本地服务与 SQLite

### S2.1 单一事实源

**Given** 本地服务和 SQLite 已启动。  
**When** 新增资产、重启服务并重新打开页面。  
**Then** 数据来自 SQLite 且保持一致；IndexedDB 不再承担 v3 事实源；不存在双写分叉。

### S2.2 loopback 安全

**Given** 本地服务运行。  
**When** 检查监听地址并模拟错误 Origin、缺失 token 和错误 Content-Type 的写请求。  
**Then** 只监听 `127.0.0.1`/`::1`；非法写请求被拒绝；只读页面仍可正常使用。

### S2.3 启动与单实例

**Given** 用户登录 macOS。  
**When** 自动启动任务触发两次。  
**Then** 最多一个写入服务实例；浏览器打开产品；失败有本地可读日志；用户可以禁用和卸载启动项。

### S2.4 备份恢复

**Given** 标准虚构数据和至少两个版本备份。  
**When** 恢复旧版本。  
**Then** 恢复前先备份当前库；临时库校验成功后再切换；恢复失败不破坏当前数据库。

Phase 2 退出证据：临时数据库测试、迁移测试、事务回滚、重复启动、非法 Origin、备份恢复和重启持久化全部通过。

**验收结论（2026-09-14，`v2.2.1-phase2`）：**

| 场景 | 结论 | 证据 |
|---|---|---|
| S2.1 单一事实源 | ✅ 通过 | `tests/server-repository.test.js` 14/14、`tests/server-api.test.js`、wiring C6（HTTP 直读一致 + IndexedDB 读到 0 条） |
| S2.2 loopback 安全 | ✅ 通过 | `tests/server-api.test.js`：只绑 127.0.0.1、无 CORS、预检 405、缺令牌 401、错 Origin 403、错 Content-Type 415、被拒写入零副作用、只读可用 |
| S2.3 启动与单实例 | ⚠️ 部分验证 | 单实例锁、日志、`install/uninstall/status` 脚本已实现并脚本级验证；**"登录 macOS 后自动启动 + 浏览器打开产品"需用户在本人终端执行 `scripts/install-login-item.sh` 并重启 Mac 确认**（写 `~/Library/LaunchAgents` 与 `launchctl bootstrap` 属系统级操作，未代为执行） |
| S2.4 备份恢复 | ✅ 通过 | `tests/server-backup.test.js` 12/12、`tests/server-restore.test.js` 8/8、清空先留 `pre-clear` 备份、恢复失败 409 且当前库不变 |

S2.3 的手工确认步骤：`./scripts/install-login-item.sh` → 重启 Mac → 确认只有一个服务实例（`pgrep -fl server/main.js`）、浏览器已打开产品、日志在数据目录 `logs/server.log`；`./scripts/uninstall-login-item.sh` 可随时卸载。

## 5. Phase 3｜账户、负债与月结

### S3.1 机构—账户—币种子账户

**Given** 一个“香港汇丰”机构。  
**When** 创建 HKD 与 USD 子账户。  
**Then** 两个余额分别维护，汇总时才折算；换汇记录为资产转移，不计收入或支出。

### S3.2 保障账户不重算

**Given** 公积金明确余额、医保个人账户明确余额、无余额保障权益和社保卡银行账户。  
**When** 查看总资产与分组。  
**Then** 明确余额只计一次；无余额权益仅展示状态；社保账户与金融账户分离。

### S3.3 月结门槛

**Given** 本月部分余额未确认。  
**When** 尝试完成月结。  
**Then** 系统列出缺项；可以保存估算快照，但不得标为正式可决策状态。

Phase 3 退出证据：标准虚构数据在 15 分钟内完成一次完整结账，每个金额均能下钻到余额、估值或交易来源。

| 场景 | 结论 | 证据 |
|---|---|---|
| S3.1 机构—账户—子账户 | ✅ 完全通过 | `tests/server-phase3.test.js`：同一“香港汇丰”账户的 HKD/USD 余额独立落库，固定汇率下仅在总览汇总为 CNY；HKD→USD 换汇固化两端币种与金额到 `asset_transfers`，`txns` 保持为空；换汇边界（未知子账户 422、同币种 400、同 id 重放不增行）与「币种由关联余额单元推导」均有断言；浏览器 wiring S3.1 覆盖录入、换汇与全量写回不丢记录 |
| S3.1 外币折算 | ✅ 通过 | 资产页可登记手动汇率（币对 + 汇率 + 汇率日，D-034）；登记 HKD→CNY / USD→CNY 后总览含折算金额且不再有 `fx_missing`，原币余额不被覆盖（wiring P1-B）。自动行情 provider 仍属 Phase 4 |
| S3.2 保障账户不重算 | ✅ 完全通过 | 四类分流各有独立断言：公积金 / 医保明确余额 → 受限资产账户 + CNY 余额（`pools.restrictedMinor` 各计一次）；无余额资格 → `balanceMinor=null`（不得写成 0）；社保卡金融账户 → 独立普通账户；权益的参考金额不进入任何资产池。浏览器 wiring 从预设入口创建（不绕过产品路径） |
| S3.3 月结门槛 | ✅ 完成 | 有阻塞项时正式结账 409 `close_blocked`、估算可保存且附 sha256 快照、同月重复结账更新记录并追加快照；余额与负债的核对日都落在结账月份内且汇率齐备时，正式结账可完成（P0-A，接口与浏览器双路径） |
| S3.3 金额可下钻 | ✅ 完全通过 | `GET /api/v1/close-snapshots/:id` 返回封存时的单元级事实（账户 / 名称、原币金额、折 CNY、核对日、来源、价格日）；`payloadJson` 重算 sha256 与列表哈希一致；月结页历史行「查看明细」摊开三张表并说明应急覆盖的口径来源与检索月份（P0-B） |
| 15 分钟月结 | ⚠️ 待真实使用验证 | 流程已压到「录余额 → 打开月结页 → 保存」三步；真实耗时按计划留待 Phase 7 两个月验证 |

## 6. Phase 4｜持仓与日终行情

Phase 4 按 4A–4E 独立验收。任一子阶段未通过时，只回滚该子阶段；不得用后续阶段功能补齐前一阶段的验收证据。

### S4A.1 Provider 契约与隐私边界

**Given** 固定的证券代码、币对以及成功/超时/限额/缺标的/节假日 fixtures。
**When** 调用 provider adapter。
**Then** 输出统一结果或明确错误分类；请求只含公开代码/币对，不含账户名、数量、成本、余额或其他私人财务事实；自动测试不访问公网。
**并且** 非公开代码/币对等非法输入必须被拒绝为 `invalid_payload`（不得流进 adapter 被误判为 `not_found`），且错误结果不回显输入原文；不满足契约的结果（负价、零汇率、假日期、坏时间戳、`retryable` 与错误码不一致）不得以成功结果的形态存在。

Phase 4A 退出证据：T-002 的汇率与行情部分、T-003 均已决定；契约、固定时钟与全部 fixture 用例通过；无数据库迁移、API 或 UI 改动。当前 T-002 行情端点仍待 4D 前决定，因此退出条件尚未全部满足。

**验收结论（2026-09-16，当前工作区）：⚠️ 契约代码通过，Phase 4A 正式验收暂不通过。**

| 场景 | 结论 | 证据 |
|---|---|---|
| T-002/T-003 数据源决策 | ⚠️ 部分完成 | T-003 已定；T-002 的汇率部分已定为 Frankfurter ECB 固定端点，行情端点仍待 4D 前决定。D-038 只是启用门禁，不等于选定行情源；门禁通过前自动行情关闭。可复现探测证据见 `server/providers/SOURCES.md` |
| 统一 adapter 契约 | ✅ 通过 | `server/providers/contract.js`：成功结果带原始代码/价格/汇率/数据日/抓取时间/provider；错误分类恰为 `timeout/rate_limit/not_found/invalid_payload/auth` 五类 + 可重试映射；`isValidResult` / `assertValidResult` 严格校验 |
| 输入边界（复核 P0-1） | ✅ 通过 | 序列化**前**逐项校验数组/symbol/pair；非数组、空数组、超限、`"V OO"`、`null`、小写币种等一律整体返回稳定 `invalid_payload`；拒绝原因只含"第 N 项 + 形状说明"，断言错误产物不含私有文本片段 |
| 结果校验（复核 P0-2、G4A-7–10） | ✅ 通过 | `priceMinor: -1 / 0 / 1.5 / "5000"`、`rateDecimal: "0" / "0.0000"`、`priceDate/fetchedAt: "bad"`、伪日历时间戳、无时区时间戳、空白 provider、`{code:"timeout", retryable:false}` 全部被拒绝；quote/fx/error 结果键集合必须严格等于白名单，夹带私有字段与未经清洗的错误 detail 不得通过 `assertValidResult`；`errorResult` 未知错误码抛 `ContractError`，`subject` 中私有文本被置空 |
| 固定时钟 | ✅ 通过 | `server/providers/clock.js` 经 `ctx.now` 注入；`fixedClock` 恒定且拒绝非法时间戳；缺 `ctx.now` 时返回 `invalid_payload`，不读真实 `Date.now` |
| fixture 覆盖成功/超时/限额/缺标的/节假日 | ✅ 通过 | `tests/providers-contract.test.js` 44/44：成功（VOO/0700.HK/510300.SS 三市场）、timeout、rate_limit、not_found、invalid_payload、auth、节假日回退（数据日早于请求日且不报错） |
| `asOf` 取数（复核 P1-4） | ✅ 通过 | fixture 改为时间序列，只取 `date <= asOf` 的最近一条；`asOf=2026-09-01` 不再返回 2026-09-11 行情而是 `not_found`；不变量测试遍历多个 `asOf` 断言从不返回未来数据；非法 `asOf` 整体拒绝 |
| 隐私边界 | ✅ 通过 | 序列化白名单（`serializeFxRequest` 剥离 amount/accountName 等字段、产物键集合固定）；adapter 在塞满账户名/数量/成本/余额/持仓的 `ctx` 下，结果对象仍只含契约白名单键；错误 `subject` 只接受公开代码/币对形状 |
| 离线运行 / 零越界改动 | ✅ 通过 | 全部测试无真实网络请求（数据源取证为人工一次性探测，见 `SOURCES.md`，不属自动测试）；`git` 确认未改动 `migrations.js`/`repository.js`/`api.js`/`keychain.js`/前端文件 |
| 行情主源端点 | ❌ 尚未决定 | 实测不存在"免费 + 无 key + 官方条款/限额/授权 + 覆盖 A/H/US ETF 日终"的源（Stooq 接口失效、Yahoo 403、Twelve Data 免费层仅 3 市场）；端点延期至 4D 开始前决定。D-038 只约束启用门禁，不能替代 T-002 的行情源决策；门禁通过前自动抓取默认关闭、行情走手动补价 |

二次补口后全量 `node --test` **274/274**（230 旧零回归 + 44 项 4A 契约/隐私/反例测试）；浏览器 wiring **15/15**。代码与回归门禁全绿，但 T-002 行情端点未定，所以不能据此宣称 Phase 4A 正式验收通过。独立复核的原始结论与逐条修复状态见 `PHASE4A_ACCEPTANCE_GAPS.md`。

### S4B.1 标的分类确认与锁定

**Given** provider 为一个 ETF 返回可追溯的类别、市场和币种候选。
**When** 用户确认分类，随后 provider 返回不同分类。
**Then** 本地确认值保持不变；新来源信息只作为冲突提示，不静默覆盖用户判断。

Phase 4B 退出证据：搜索、预分类、确认、刷新不覆盖、标的去重和元数据冲突均有固定 fixture 用例。

**验收结论（2026-09-16，三轮反向检查后）：✅ 代码验收通过（两轮独立复核与第三轮引用安全审计发现的问题均已修复，等待独立复核确认）。**

复核补口说明：独立复核于 2026-09-16 两轮判定 4B **暂不通过**，共 6 项可复现问题（第一轮 2×P0 + 1×P1 + 1 项一致性，第二轮 3×P1）。原始结论与逐条修复状态见 `PHASE4B_ACCEPTANCE_GAPS.md`。修复把「id 只能由服务端派生」「去重键在**所有**写入路径上成立」从应用层约定升级为可拒绝的硬约束并加数据库唯一索引兜底；第二轮进一步把「全量写入逐条校验」「索引级不变量也属于结构校验」「检索合并复用安全退化匹配」补齐，对应新增 23 项反例/不变量测试（含真实 HTTP 反例、迁移守卫与真实 UI 闭环）。

口径澄清：本场景原文的「可追溯的类别、市场和币种候选」按 **D-037 / D-039** 落地 —— provider 实际提供的候选是 `currency` / `exchange` / `instrument_type` / `country` / `exchange_timezone`，而 `asset_class`（资产类别）与 `exposure_market`（风险敞口市场）**没有 provider 字段来源**，属用户判断，只能由用户填写并确认；provider 未提供时保持为空而不是编造。因此"分类候选"的可追溯性由 provenance 承担，"类别/市场"的权威性由用户确认承担。

| 场景要点 | 结论 | 证据 |
|---|---|---|
| 搜索 → 预分类（suggested） | ✅ 通过 | `GET /api/v1/instruments/search?q=` 返回合并候选，每条带 `provenance`（六字段、`payloadHash` 可由上游字段重算）与带依据的 `suggestions`（如 `{field:'currency', value:'USD', basis:'provider.currency'}`）；`userJudgementRequired` 明示哪些字段必须用户填。`tests/providers-catalog.test.js` 26/26、`tests/instrument-catalog.test.js` |
| 建立标的落成 `suggested`，不自动确认 | ✅ 通过 | `POST /api/v1/instruments` 返回 `classificationStatus:'suggested'`、`assetClass:null`、`exposureMarket:null`、`confirmedAt` 为空；provider 的部分字段缺失时保持 `null`（`MYSTERY.ETF` 用例证明"没给就不编造"） |
| 用户确认 → `confirmed` 本地锁定 | ✅ 通过 | `POST /api/v1/instrument-confirmations` 要求 `assetClass` + `exposureMarket` 两项（缺任一项 → 400）；确认后 `classificationStatus:'confirmed'` 且写入 `confirmedAt`；非词表取值（`现金` / `日本` / `美国`）一律 400 |
| **确认后 provider 返回不同分类：本地值保持不变，只作冲突提示** | ✅ 通过 | 核心不变量用例：确认 → 再 `POST /api/v1/instruments` 刷新，`preserved:true`、状态仍 `confirmed`、`assetClass`/`exposureMarket`/`trackingIndex`/`confirmedAt` 全部不变；本地自定义名称（`盈富基金`）不被上游 `Tracker Fund of Hong Kong` 改写，差异以 `conflicts[]` 返回且**每条都带 provider 候选值与 provenance**（`payloadHash`、`fetchedAt`） |
| 同一标的不重复创建事实 | ✅ 通过 | 去重键 `(symbol, exchange)` 在**所有**写入路径上成立：目录接口 `POST /instruments`、单条 `upsertInstrument`、全量 `PUT /state`（重复键整体拒绝，事务回滚）、以及数据库表达式唯一索引 `uq_instruments_dedupe`（迁移 v4）。重复建立 `duplicated:true` 且目录里只有一行；`upsertInstrument` 对同一去重键的第二次写入**显式抛 `duplicate_instrument`**（不静默删行，已确认分类不会被连带删除）；"先手工建、后补交易所"经退化匹配命中同一行 |
| 标的身份只能由服务端派生（复核 P0-1，`client_id_forbidden`） | ✅ 通过 | `POST /api/v1/instruments` 拒绝客户端指定的 id（400 `client_id_forbidden`，响应不回显该值，目录无任何写入）；正常建立得到派生 id `inst-<sha1(identityKey) 前16位>`。反例取自复核原文 `{"symbol":"VOO","id":"client-chosen-id"}` |
| 全量 `/state` 不能绕过去重（复核 P0-2） | ✅ 通过 | `repository.writeInstruments` 写入前按归一后的去重键预校验，重复（含同一 id 重复）**整体拒绝**并抛 `duplicate_instrument`；handler 映射为 409（不是 500）且事务回滚，`GET /state` 证明上一次状态原样保留。反例取自复核原文 `inst-a → VOO/NYSE` + `inst-b → voo/nyse`；迁移 v4 用表达式唯一索引做数据库层兜底，历史数据已有重复时迁移**显式失败**而不是静默挑选保留行 |
| 缺交易所时不误合并跨市场同代码（复核 P1） | ✅ 通过 | 同代码存在多行（`CROSS@NYSE` + `CROSS@HKEX`）时，缺交易所的查询/建立返回 409 `ambiguous_instrument` 并提示指定交易所（不再按行顺序静默命中第一条）；明确指定交易所照常命中同一行且不新增事实；只有一条同代码记录时仍允许补全交易所（既有路径未被破坏） |
| 稳定 id 永久不变（复核附带项） | ✅ 通过 | id 由**首次创建时的 identity key** 派生并永久锁定：先建无交易所标的（`CROSS@`）再补交易所（HKEX），id 与 `identityKey` 都不重算，记录持久化 `identityKey` 供外部离线复算。历史快照仍按原样还原 id（`PHASE4B_ACCEPTANCE_GAPS.md` 记录该边界与理由） |
| 全量写入逐条校验，不静默丢弃或接收非法标的（第二轮复核 G4B-5） | ✅ 通过 | `writeInstruments` 两遍写入：先逐条验证 id（必填 + 形状）/ `symbol`（去空白后符合公开证券代码形状）/ `currency`（必填且在白名单）/ 记录类型，再校验去重键；任一条不合格即抛错，`writeState` 事务整体回滚。真实 HTTP 反例（复核原文的 `NO-ID` 与 `blank-symbol`）：缺 id / 空白代码 / 币种非法 / 币种缺失各 400 + `GET /state` 证明上一次状态逐条保留；合法写入照常 200 |
| 备份与恢复的结构校验覆盖索引级不变量（第二轮复核 G4B-6） | ✅ 通过 | `backup.js` 按 schema 版本维护必需索引清单（v4 要求 `uq_instruments_dedupe` 存在**且唯一**），`validateBackupFile` 在表校验后逐条校验；`dbm.indexInfo()` 提供存在性/所属表/唯一属性。反例：删索引 → 校验拒绝并点名索引；同名非唯一索引 → 同样拒绝；活库丢索引 → `createBackup` 拒绝产出备份且不留残留；恢复通道复用同一校验，候选备份缺索引即拒绝恢复且当前库逐字段不变、无副作用文件 |
| 检索合并复用安全退化匹配（第二轮复核 G4B-7） | ✅ 通过 | `searchCatalog` 的 `matchLocalRecord()` 与建立路径同一套规则：本地缺交易所 + 参考数据有交易所时合成**一条** `local+provider` 候选（不再各占一行）；同代码多市场时返回 `ambiguous_instrument` 警告且不合并，也绝不让同一条本地记录被两个市场重复认领；合并只补空展示字段、不进入 `suggestions`（建议依据仍只来自 provider）；检索只读，不改写本地事实 |
| 标的更新保持 4C/4D 引用事实（第三轮 G4B-8） | ✅ 通过 | `upsertInstrument` 原位 `ON CONFLICT(id) DO UPDATE`，不再以 DELETE 触发外键级联；反例同时写入持仓快照、证券事件与报价，刷新标的后 3 类事实均保留 |
| provider 元数据绑定请求身份（第三轮 G4B-9/G4B-10） | ✅ 通过 | provider 返回另一个契约合法代码仍以 `invalid_provider_payload` 拒绝且零写入；提交交易所冲突返回 `exchange_mismatch` 400；搜索非数组或非法候选显式标记 `invalid_payload`，本地结果仍可降级返回 |
| 多市场松匹配与分类写入门禁（第三轮 G4B-11/G4B-12） | ✅ 通过 | 合并前计算全部候选认领集合，同一无交易所本地记录对应多个市场时所有候选均不合并；`/state` 与单条 upsert 严格限制分类状态/词表，confirmed 必须类别与市场齐全，非法写入 400 + 整体回滚；代码、交易所、币种统一大写归一 |
| 缺失/冲突元数据明确提示 | ✅ 通过 | provider 整体失败时 `provider.status='error'` + `warnings[]`，本地命中照常返回（前端显示"参考数据暂不可用…确认分类不依赖外部数据"）；候选里的不可入账记录（小写币种）转为显式 `invalid_payload` 而不是"看起来是候选"；`BADMETA.ETF` 建立请求 422 |
| 边界：本阶段不创建持仓 | ✅ 通过 | `POST /api/v1/portfolio-openings` / `security-events` / `market-data/refresh` 仍返回 `501`；`GET /api/v1/holdings` 保持只读 |
| 隐私边界 | ✅ 通过 | 检索请求产物键集合恒为 `{query}`、元数据请求恒为 `{symbol}`；传入对象/数组/夹带私有字段的载荷被整体拒绝；错误响应不回显输入原文；目录接口响应不含 `accountName`/`quantity`/`costMinor`/`balanceMinor` |
| 离线运行 | ✅ 通过 | 4B 全部测试使用 fixture provider 与固定时钟，无真实网络请求；未引入付费源、未处理 4D 的行情源门禁（D-038） |

退出证据汇总：全量 `node --test` **371/371**（367 第二轮基线零回归 + 4 项第三轮独立测试；`instrument-catalog` **48/48**、真实 HTTP `server-phase4b` **17/17**）；浏览器 wiring 沿用上一轮 **17/17**（本轮未改 UI）；数据库迁移停在 **v4**；零真实网络、`DEFERRED_WRITES` 一行未动。第三轮缺口与反例见 `PHASE4B_ACCEPTANCE_GAPS.md` G4B-8–12。

### S4C.1 初始快照与后续事件

**Given** 用户首次录入 10 份 ETF。
**When** 后续记录买入 2 份、卖出 1 份和一笔分红。
**Then** 当前数量为 11 份；买卖影响持仓和现金但不重复计入收入支出；分红单独记录。

| 验收点 | 结论 | 证据 |
|---|---|---|
| S4C.1 主链路：期初 10 → 买 2 → 卖 1 = 11 | ✅ 通过 | `tests/server-phase4c.test.js`：真实 HTTP 全链路（建账户 → manual 标的 → confirm → 期初 → 买 → 卖 → 分红），`GET /holdings` 推导 `quantity='11'`，`eventCounts` 精确；领域侧同链路见 `tests/domain-phase4c.test.js` |
| 分红/费用可单独追溯、不改数量 | ✅ 通过 | 分红事件落 `amount_minor`（v5 列），`quantity` 为 null；`deriveHoldings` 后数量不变；事件流水（`GET /security-events`）带币种（由标的推导）、日期与 id 可溯源 |
| 买卖不重复计入收入支出 | ✅ 通过 | 事件写入后 `GET /state` 的 `txns` 保持为空；浏览器 wiring 场景断言事件前后现金流交易数不变 |
| 同 id 重放明确拒绝 | ✅ 通过 | 同 id 二次 POST → 409 `duplicate_event`，不产生第二行；`Idempotency-Key` 重放返回首次响应（200 + `X-Ledger-Idempotent: replay`）且不重复写入 |
| 卖出超额（含时间线重放）拒绝且回滚 | ✅ 通过 | 卖出 > 当时推导数量 → 409 `insufficient_holdings`，事件表回滚为空；"先买 2 再卖 3"按 `occurred_at` 重放同样被拒 |
| 同标的多账户独立推导 | ✅ 通过 | 领域测试：a1 卖 3 → 7，a2 买 5 → 5，互不串账 |
| 小数数量定点精确 | ✅ 通过 | 0.1 + 0.2 = 0.3（规范化字符串，无浮点漂移）；`compareDecimals` / `sumQuantities` / `subtractQuantities` 整数运算 |
| 非法事件字段 400 / 未知引用 422 | ✅ 通过 | `invalid_event_type` / `invalid_quantity` / `invalid_event_date` / `invalid_event_amount`（买卖携带总额、分红缺总额均拒绝）→ 400；未知账户/标的 → 422 |
| 重复期初拒绝 | ✅ 通过 | 同 (账户, 标的) 第二行期初（不同 id）→ 409 `duplicate_opening`；同 id 为幂等更新 |
| 未确认分类允许录入 + 阻塞标记（D-042 ⑥） | ✅ 通过 | suggested 标的录入期初/事件返回 201 + `warning: classification_unconfirmed`；总览照常估值但 `classification_unconfirmed` blocker 使状态为 estimate |
| `PUT /state` 全量路径同口径 | ✅ 通过 | 全量写入带非法事件类型 → 400 整体回滚、事件零残留；合法往返后事件与推导数量无损 |
| 备份恢复往返无损 | ✅ 通过 | 手动备份 → 再写 2 条事件 → 恢复后事件回到 1 条、推导数量回到 12 |
| 浏览器最小闭环（wiring） | ✅ 通过 | `tests/app-wiring.js` 新场景：页面录入期初/买/卖 → 事实源推导 11 → 持仓卡片与事件流水渲染 → 全量写回（记账路径）后事件与期初仍在 |

Phase 4C 退出证据：全量 `node --test` **397/397**（371 基线零回归 + 领域 **16** 项 + 真实 HTTP **10** 项）；浏览器 wiring **18/18**（连续两轮全绿）；数据库迁移停在 **v5**；`market-data/refresh` 仍 501；零真实网络请求。口径冻结见 `DECISIONS.md` D-042。

### S4D.1 自动更新成功

**Given** 应用打开且公开数据网络可用。  
**When** 自动更新最近有效收盘价与汇率。  
**Then** 保存价格日、抓取时间和 provider；外部请求不包含账户名、数量、成本或余额。

### S4D.2 更新失败与人工兜底

**Given** provider 超时、限额或不覆盖某标的。  
**When** 更新失败。  
**Then** 保留最后有效值并标记 stale，允许手动补价，阻止正式建议但不阻止查看估算。

Phase 4D 退出证据：provider 使用固定 fixture 自动测试；成功、断网、超时、限额、缺标的、节假日、错误响应不覆盖旧值、Keychain 与手动覆盖均有用例。

### S4E.1 估值下钻与收益归因

**Given** 同一持仓有期初数量/价格、期末数量/价格和对应汇率。
**When** 查看资产类别、机构、币种、市场和收益明细。
**Then** 当前估值可下钻到数量、价格日、汇率与 provider；证券价格影响与汇率影响分别展示并可复算。

Phase 4E 退出证据：完整持仓可正确估值；下钻合计与总览一致；行情 stale 时只展示估算并阻止正式建议；Phase 1–3 回归全部通过。

## 7. Phase 5｜风险与新增资金建议

### S5.1 能力约束意愿

**Given** 风险意愿高但应急金不足、收入不稳定。  
**When** 生成风险等级。  
**Then** 最终风险上限采用较低的客观承受能力，不因主观意愿高而放宽。

### S5.2 新增资金优先

**Given** 当前宽基权益低于目标区间，其他类别在区间内。  
**When** 输入本月新增资金 CNY 2,000。  
**Then** 建议优先补宽基权益；不生成卖出现有资产的默认指令；只从用户认可标的中给出可执行映射。

### S5.3 数据门槛

**Given** 行情过期、分类未确认或月结未完成任一情况。  
**When** 请求建议。  
**Then** 仅展示估算与待处理项，不生成正式建议。

Phase 5 退出证据：相同输入重复计算结果一致；每条建议能展示输入版本、规则版本、目标区间、偏离和解释卡。

## 8. Phase 6｜执行与复盘

### S6.1 合法状态流转

允许：`proposed → accepted/deferred/dismissed`、`accepted → executed`、`executed → reviewed`。  
拒绝：`proposed → reviewed`、`dismissed → executed` 等跳步或终态反转。

每次状态变化必须保存时间、理由、操作者（固定为本地用户）和当时快照；产品不调用券商交易接口。

Phase 6 退出证据：使用虚构数据完整跑通两次“建议—决定—交易记录—复盘”，非法跳转测试通过。

## 9. MVP 两个月验收

连续两个自然月达到以下全部条件才可称为 v3 MVP 完成：

- 每次月结不超过 15 分钟；
- 每周人工维护不超过 20 分钟；
- 一分钟内回答净资产、可投资资金、主要风险暴露和新增资金方向；
- 所有金额可追溯且无重复计入；
- 至少两次完整决策闭环；
- 行情失败从未静默产生正式建议；
- 空数据库恢复演练成功；
- 原记账与账单导入回归测试持续通过。

任一条件失败时，先记录失败原因并简化流程，不直接增加新集成或扩大范围。
