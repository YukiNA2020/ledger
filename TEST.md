# 小账本（Ledger）测试状态

> 文档用途：记录可复现的测试证据、覆盖范围、缺陷和发布判断。
> 创建时间：2026-08-16
> 最近更新：2026-09-16

## 当前结论

- **测试对象：** v2.3.7-phase4b（v3 Phase 4B 标的目录与分类确认，含独立复核两轮补口）
- **总体状态：** ✅ 第二轮复核补口完成，等待独立复核确认。`node --test` **367/367**（357 第二轮基线零回归 + 10 项新反例/不变量：`instrument-catalog` 40→44、`server-phase4b` 15→17、`server-backup` 16→19、`server-restore` 8→9），浏览器 wiring **17/17**（干净环境连续两轮全绿）。
- **发布判断：** 独立复核两轮判定 4B **暂不通过、不建议进入 4C**（第一轮 2×P0 + 1×P1 + 1 项一致性：客户端可指定 id、全量 `/state` 可绕过去重、跨市场同代码被静默合并、id 可复算表述冲突；第二轮 3×P1：全量写入静默丢行/接收非法标的、备份校验漏索引级不变量、检索合并漏缺交易所场景）。**六项全部已修复并补齐真实 HTTP / 真实 UI 反例**，原始结论与逐条修复状态见 `PHASE4B_ACCEPTANCE_GAPS.md`。**Phase 4A 仍为「契约完成、正式验收暂不通过」**——T-002 仅汇率源已定，行情端点待 4D 开始前通过 D-038 门禁后决定。本轮零新增迁移（schema 停在 v4）、零真实网络请求、未创建持仓（`portfolio-openings` / `security-events` / `market-data/refresh` 仍 501）。

本轮只使用仓库内的虚构、脱敏数据。标准虚构数据与预期口径见 `ACCEPTANCE.md` §2。

## 可复现测试证据

| 范围 | 方法 | 日期 | 结果 | 说明 |
|------|------|------|------|------|
| Phase 3 领域行为（月结核对清单、结账状态、应急金覆盖） | `node --test tests/domain-close.test.js` | 2026-09-15 | ✅ 7/7 | 纯逻辑新增，不触碰既有 domain 断言 |
| S3.1 资源写入与月结 API | `node --test tests/server-phase3.test.js` | 2026-09-15 | ✅ 14/14 | 香港汇丰 HKD/USD 独立余额、仅汇总时折算 CNY、换汇两端事实与边界（未知单元 422 / 同币种 400 / 同 id 重放不增行）、`txns` 零新增、五类资源 upsert、手动汇率、快照明细与哈希复核、有负债时正式结账闭环、S3.2 四类福利分流 |
| S3.1/S3.2/S3.3 浏览器接线验收 | `tests/app-wiring.html`（经本地服务托管） | 2026-09-15 | ✅ 15/15 | 新增 4 项：S3.2 福利预设四类分流、P0-A 正式结账闭环（上月核对 + 手动汇率 → formal）、P1-B 手动汇率登记、P0-B 历史金额下钻；连续两轮全绿 |
| 迁移 v2/v3 | `node --test tests/server-migration.test.js` | 2026-09-15 | ✅ 14/14 | v2 库前向迁移到 v3 保留原账户余额并新增 `asset_transfers`；不修改历史迁移，坏迁移整包回滚仍覆盖 |
| 全量回归 | `node --test` | 2026-09-15 | ✅ 230/230 | 含 2 项 macOS Keychain 写读（本机以登录用户身份运行通过） |
| 前端请求头契约 | `node --test tests/store-headers.test.js` | 2026-09-15 | ✅ 6/6 | 新增月结/资源/快照方法沿用同一 `apiFetch` 门面 |

**合计（Phase 3）：`node --test` 230/230 通过，浏览器 wiring 15/15。**

### Phase 4A 证据（2026-09-16，含二次复核补口）

| 范围 | 方法 | 日期 | 结果 | 说明 |
|------|------|------|------|------|
| S4A.1 初版契约与隐私边界 | `node --test tests/providers-contract.test.js` | 2026-09-15 | ✅ 15/15 | 五类错误分类 + 可重试映射、结果形状逐键、公开代码/币对校验、白名单序列化剥离私有字段、fixture 成功（三市场）/超时/限额/缺标的/无效载荷/鉴权/节假日回退、固定时钟确定性、ctx 污染下结果仍只含契约白名单键 |
| S4A.1 二次复核补口后的定向测试 | `node --test tests/providers-contract.test.js` | 2026-09-16 | ✅ 44/44 | 覆盖原 42 项，并新增：结果精确键白名单（quote/fx/error 夹带私有字段均拒绝）、错误 detail 必须为单行且限长；时间戳补充伪日历日、24 时及超范围时区反例，固定时钟使用同一严格校验 |
| 全量回归 | `node --test` | 2026-09-16 | ✅ 274/274 | 230 项 Phase 1–3 零回归 + 44 项 Phase 4A；本机回环端口与 Keychain 测试均通过 |
| 浏览器接线回归 | `tests/app-wiring.html`（本地服务托管） | 2026-09-15 | ✅ 15/15 | 连续两轮全绿；4A 未改前端/API，属回归确认 |

**Phase 4A 合计：`node --test` 274/274（230 + 44），浏览器 wiring 15/15。**

### Phase 4B 证据（2026-09-16）

| 范围 | 方法 | 日期 | 结果 | 说明 |
|------|------|------|------|------|
| 参考数据 adapter（检索与元数据） | `node --test tests/providers-catalog.test.js` | 2026-09-16 | ✅ 26/26 | 候选键集合精确（不夹带 `assetClass`/`exposureMarket`/`trackingIndex`）、大小写与名称片段检索、一个词命中多条且坏记录单独报错、无命中返回空数组而不是错误、provider 级失败 `subject` 为空、缺项一律 `null`（`MYSTERY.ETF` 证明"没给就不编造"）、小写币种记录转显式 `invalid_payload` 不作为候选流出、provenance 六字段与 `payloadHash` 可外部重算、`sourceRef` 缺失用 `NA` 占位、`fetchedAt` 取自注入时钟、非法检索词/缺 `ctx.now` 整体拒绝且不回显原文 |
| 目录编排与本地锁定 | `node --test tests/instrument-catalog.test.js` | 2026-09-16 | ✅ 33/33 | 稳定 id 确定性派生与可复算、建立载荷白名单（夹带 `accountName`/`quantity`/`costMinor` 一个都进不了产物）、非法载荷稳定报错不回显、确认两项用户判断必填 + `EXPOSURE_MARKETS` 词表边界、冲突只报同名字段差异且带 provenance、检索合并与 `local+provider` 去重、provider 挂了仍返回本地命中、建立/重复建立/币种冲突/手工建标（缺币种拒绝、provider 未覆盖可用）/退化匹配补全交易所、确认与 `confirmed` 锁定、**确认后刷新不覆盖（`preserved:true`、状态不退回 `suggested`）**、`duplicate_instrument` 不静默删行、`extra_json` 零丢失 |
| S4B.1 API 端到端 | `node --test tests/server-phase4b.test.js` | 2026-09-16 | ✅ 11/11 | 主链路（检索 → 建立 `suggested` → 确认 `confirmed` → 再刷新不覆盖且目录仅一行）走真实 HTTP 入口；provider 失败时本地命中仍返回；检索词非法 400 且不回显；写请求缺/错 `Content-Type` 415 且不改数据；建立校验失败矩阵（400/404/422 与错误码）；手工建立（provider 未覆盖）；确认失败矩阵（400/404）；冲突提示带 provider 值与 provenance；`portfolio-openings`/`security-events`/`market-data/refresh` 仍 501；目录响应不含账户/持仓字段 |
| 全量回归 | `node --test` | 2026-09-16 | ✅ 357/357 | 344 项 Phase 1–4B 零回归 + 13 项复核补口反例/不变量 |
| 浏览器接线验收（真实产品入口闭环） | `tests/app-wiring.html`（本地服务托管） | 2026-09-16 | ✅ 16/16 | 新增 1 项：从决策台进入资产录入页 → 检索 VOO → 加入目录（事实源为 `suggested`、`assetClass`/`exposureMarket` 未生成）→ 弹层确认 `broad_equity`/`US`/`S&P 500` → 事实源为 `confirmed` → 按参考数据刷新后 id 不变、目录仍一行、状态与三个用户值全部保持；本轮又复跑两轮确认 `/state` 写入路径改动无回归 |

**Phase 4B 合计：`node --test` 357/357（344 + 13），浏览器 wiring 16/16。**

### Phase 4B 复核补口证据（2026-09-16，独立复核后）

| 范围 | 方法 | 日期 | 结果 | 说明 |
|------|------|------|------|------|
| 身份、去重、歧义（纯逻辑） | `node --test tests/instrument-catalog.test.js` | 2026-09-16 | ✅ 40/40 | 新增 7 项：客户端 id（含像派生值的 `inst-…`、含空格、含中文）一律 `client_id_forbidden` 且不回显、空串/缺省不算指定；`stableIdFromKey` 与派生 id 同源；伪造 id 建立被拒且目录零写入；无交易所建标 → 补 HKEX 后 id 与 `identityKey` 都不变（`duplicated:true`、目录一行）；多候选抛 `ambiguous_instrument` 且指定交易所后仍命中同一行；退化匹配唯一命中仍可补全；全量写入重复键（大小写/同一 id）整体拒绝且已存数据保留；数据库唯一索引兜底（大小写、空白、缺交易所三种形态） |
| 身份、去重、歧义（真实 HTTP） | `node --test tests/server-phase4b.test.js` | 2026-09-16 | ✅ 15/15 | 新增 4 项反例：复核原文载荷 `{"symbol":"VOO","id":"client-chosen-id"}` → 400 `client_id_forbidden` + 响应不回显 + `GET /state` 证明零写入；`PUT /state` 写 `VOO/NYSE` + `voo/nyse` → **409**（非 500）+ 整体回滚（上一次状态原样保留）；同代码 NYSE/HKEX 存在时缺交易所建立 → 409 `ambiguous_instrument` + 提示含"交易所" + 两行未被改动 + 指明交易所后命中同一行；补交易所后 id 与 `identityKey` 不变且目录仍一行 |
| 迁移 v4 与历史数据守卫 | `node --test tests/server-migration.test.js` | 2026-09-16 | ✅ 16/16 | 版本序列到 v4 且 `uq_instruments_dedupe` 存在；唯一索引拒绝归一后重复行、允许不同交易所共存；**v3 库已有重复标的时 v4 迁移显式失败并整体回滚**（版本停在 v3、两行数据原样保留，不替用户挑选保留行） |

### Phase 4B 第二轮复核补口证据（2026-09-16，独立复核第二轮后）

| 范围 | 方法 | 日期 | 结果 | 说明 |
|------|------|------|------|------|
| 全量写入逐条校验（纯逻辑） | `node --test tests/instrument-catalog.test.js` | 2026-09-16 | ✅ 44/44 | 新增 4 项：检索合并（本地缺交易所 + 参考数据有交易所 → 一条 `local+provider`、建议依据仍全部来自 provider）；检索歧义两组（本地多市场 × 参考数据缺交易所；本地一条缺交易所记录被两个市场认领）；全量写入校验矩阵（缺 id / 空白代码 / 含空格代码 / 币种非法 / 币种缺失 / 非对象 → 各自错误码 + 拒绝后零残留行） |
| 全量写入与检索合并（真实 HTTP） | `node --test tests/server-phase4b.test.js` | 2026-09-16 | ✅ 17/17 | 新增 2 项：复核原文的两条非法标的（`NO-ID`、`blank-symbol`）与币种非法/缺失共四条各自 **400** 且 `GET /state` 证明上一次状态（两条）逐条原样保留、合法写入照常 200；本地手工建无交易所 VOO 后检索 → 候选恰好 **1** 条、`origin=local+provider`、带出本地 id、无警告 |
| 备份结构校验的不变量覆盖 | `node --test tests/server-backup.test.js` | 2026-09-16 | ✅ 19/19 | 新增 3 项：`DROP INDEX uq_instruments_dedupe` → 校验拒绝且原因点名索引（复核原文的复现路径）；同名索引换成**非唯一**索引 → 同样拒绝，且 `dbm.indexInfo` 能正确读出唯一属性（对照正常库为 `true`）；活库丢索引时 `createBackup` 抛"备份校验失败"且不留残留 `.db` 文件 |
| 恢复通道拒绝缺索引的候选备份 | `node --test tests/server-restore.test.js` | 2026-09-16 | ✅ 9/9 | 新增 1 项：候选备份删掉唯一索引 → 拒绝恢复并点名索引，当前库逐字段不变、备份目录只留下那个候选文件（校验发生在切换之前，连"恢复前备份"都不产生）、无 `.restore-tmp` / `.replaced` 残留 |
| 全量回归 | `node --test` | 2026-09-16 | ✅ 367/367 | 357 项第二轮基线零回归 + 10 项新反例/不变量 |
| 浏览器接线验收（第二轮新增闭环） | `tests/app-wiring.html`（本地服务托管） | 2026-09-16 | ✅ 17/17 | 新增 1 项：手工建立不填交易所的标的 → 检索 → 搜索卡片内**只有 1 条候选**、该候选不再有"加入目录"入口、事实源中标的 id 与交易所都没变（检索只读）；干净环境连续两轮全绿 |

**Phase 4B 第二轮补口合计：`node --test` 367/367（357 + 10），浏览器 wiring 17/17。**

### Phase 4B 第二轮复核发现的缺陷（2026-09-16，补口已修）

- **B19（P1，全量写入校验）**：`repository.writeInstruments` 先用 `.filter((i) => i && i.id)` 把没有 id 的标的**静默丢弃**，又把空白 `symbol` 写成空字符串 —— `PUT /state` / JSON 恢复里非法记录要么无声消失、要么变形落库，用户看不到任何错误。修复：改为两遍写入（先逐条验证并归一，再校验去重键），任一条不合格即抛错、由事务整体回滚；`invalid_instrument` 补进 HTTP 状态映射（400）。
- **B20（P1，结构校验）**：备份校验只按版本检查表，删掉 `uq_instruments_dedupe` 后 `schemaVersion=4` 的库仍返回合格；而迁移器看到 v4 已应用不会重建索引，恢复后这个库会静默失去去重不变量。修复：按 schema 版本维护必需索引清单（含唯一属性）并逐条校验，恢复通道复用同一校验；见 **D-040**。
- **B21（P1，检索合并）**：检索只按精确 `(symbol, exchange)` 合并，本地缺交易所的标的与参考数据同代码候选会**同时展示**，用户看到两条重复候选、且无法判断哪条是自己的。修复：抽出 `matchLocalRecord()` 与建立路径共用同一套匹配规则（精确 → 唯一退化合并 → 多命中报歧义），合并只补空展示字段且不进入 `suggestions`。

### Phase 4B 本轮发现并修复的缺陷（2026-09-16）

- **B10（P0，本地锁定）**：`createInstrument` 初版对所有记录统一写 `classificationStatus: 'suggested'`，用户在界面确认分类后只要再点一次「按参考数据刷新」就会**退回未确认状态**——D-037 的本地锁定形同虚设。修复：对 `confirmed` 记录显式保留 `classificationStatus`/`confirmedAt` 与全部本地值（含自定义名称），只刷新来源留档与冲突提示，并在响应里以 `preserved: true` 明示；用例覆盖"确认 → 刷新 → 状态与值全部不变 + 名称不被上游改写"。
- **B11（P0，去重路径）**：`repository.upsertInstrument` 初版按 `(symbol, exchange)` 去重时**静默 `DELETE` 冲突行**——那会把已确认的分类连同整行一起删掉。修复：改为显式抛 `duplicate_instrument`，由调用方先用 `findInstrumentByKey` 解析既有标的后再写入；并保留"同一代码且任一方交易所为空"的退化匹配，避免"先手工建、后由 provider 补全交易所"时凭空多出第二行事实。
- **B12（P1，事务边界）**：单条标的写入是"先删同 id 再插入"，裸调 repository 存在中途失败丢行的窗口。修复：统一经 `writeInstrument()` 用 `dbm.transaction` 包装（provider 调用已在事务之外完成，不嵌套）。
- **B13（P2，契约一致性）**：`suggestFromProvider` 初版返回对象，与 `diffInstrumentFields` 的返回形状不一致，调用方容易写错。修复：统一为 `[{field, value, basis}]`。
- **B14（测试基建）**：4B 的 wiring 场景最初写了两处"用页面文案判断状态"（`待确认` / `已确认`）与一处错误导航假设（`assets` 页其实不在底部 tabbar，必须先回决策台点入口卡片）。前者违反本项目的 wiring 铁律（文案可能被他处内容污染造成假通过），后者直接导致 `找不到元素 [data-action="nav:assets"]`。修复：状态一律用 `apiState()`（事实源）轮询判定；导航改为 `nav:home` → `#view [data-action="nav:assets"]`；"刷新是否真的执行"用 `fetch` 计数证明，而不是靠 toast 文案。同类问题参考 B5。

### Phase 4B 独立复核发现的缺陷（2026-09-16，补口已修）

> 原始结论原文见 `PHASE4B_ACCEPTANCE_GAPS.md`（复核当时判定 4B 暂不通过、不建议进入 4C）。

- **B15（P0，身份可伪造）**：`parseCreatePayload` 接受客户端提供的任意格式合法 `id`，`createInstrument` 优先使用该值 —— `{"symbol":"VOO","id":"client-chosen-id"}` 落库 id 就是 `client-chosen-id`，绕过 D-039 的派生规则，4C 的账户会引用无法复算的身份。修复：非空 `id` 一律返回 `client_id_forbidden`（**显式拒绝而非静默忽略**），id 只由服务端按 identity key 派生；补真实 HTTP 反例（含"看起来像派生值"的伪造 id）。
- **B16（P0，去重路径不完整）**：去重键只在目录接口与单条 upsert 上强制，`repository.writeInstruments`（`PUT /state`、JSON 恢复、备份还原）逐行直插，也没有数据库唯一约束 —— `VOO/NYSE` 与 `voo/nyse` 能同时落库，"同一标的不重复创建事实"在旧写入路径上失效。修复（两层）：① `writeInstruments` 写入前按领域同口径预校验去重键与 id，重复**整体拒绝**并抛 `duplicate_instrument`（事务回滚）；② 新增迁移 **v4** 表达式唯一索引 `uq_instruments_dedupe` 兜底，迁移前检测历史重复数据，存在重复即显式失败并列出重复键。顺带修复：领域错误码 → HTTP 状态集中映射，`/state` 的重复/歧义返回 **409** 而不是 500（前端可区分"写入被拒、数据没动"与"服务端出错"）。
- **B17（P1，静默错误合并）**：`findInstrumentByKey` 用 `.find()` 做退化匹配，请求缺交易所时条件 `!exchange` 对所有同代码记录成立，于是按数据库行顺序返回第一条 —— 同代码同时在 NYSE / HKEX 时会静默合并并返回 `duplicated:true`，结果取决于行序。修复：收集全部退化候选，多于一条时抛 `ambiguous_instrument`（HTTP 409 + 提示指明交易所）；唯一命中时仍允许补全交易所，既有路径未被破坏。
- **B18（一致性：id 语义未定义）**："先手工建无交易所标的、再由 provider 补全交易所"会保留旧 id，而文档声称"id 可用当前 `symbol@exchange` 复算"，两者冲突。修复：采纳"id 基于首次创建时的不可变 identity key"规则 —— 新增 `stableIdFromKey` / `identityKeyOf`，记录持久化 `identityKey`，补全交易所后 id 与 `identityKey` 都不重算，文档改为"用 `identityKey` 离线复算"。**边界（复核未要求，明确记录）**：全量 `/state` 与备份恢复通道原样还原既有 id（历史快照带 `ins-voo` 这类旧形状 id，强制派生会破坏备份往返保真），该通道的强约束是去重键。

**数据源取证（非自动测试，人工一次性探测）：** 见 `server/providers/SOURCES.md`。Stooq `/q/l/` 404、`/q/d/l/` 返回 JS 验证挑战；Yahoo chart 403；Frankfurter `/v2/providers/ecb/rates` 200 且与默认多源端点值不同（USD/CNY 6.7115 vs 6.708）；Twelve Data `symbol_search` 覆盖 HKEX/SSE；腾讯/东方财富端点实测可达但无官方条款。自动测试不访问公网的门禁未被破坏。

本轮发现并修复的真实缺陷：

- **P3-1（资源 upsert 丢 id）**：`POST /api/v1/accounts|account-units|liabilities|entitlements` 的载荷校验器不含 `id` 键，客户端传入的 id 被静默丢弃并生成新 id —— 「编辑已有资源」会变成「新增副本」。已修复：格式受限的客户端 id 透传，upsert 幂等；非法 id 返回 400 `invalid_id`（`DECISIONS.md` D-031）。机构维持按名称归一合并的语义不变。
- **P3-2（wiring 假通过）**：S3.3 用文本「核对清单」判断是否进入月结页，但决策台入口卡片的描述文字就含该词，waitFor 在页面尚未跳转时就假通过，后续按钮断言随机失败。已改为等待真实的 `[data-action="close:save"]` 元素；并修复测试里「上月」计算公式少退一个月的错误。
- **P3-3（S3.1 只完成半条）**：原实现能建机构、账户和币种余额，却没有换汇事实模型，验收证据也未覆盖“换汇不计收支”。新增 `asset_transfers`、API 与页面入口；同一虚构汇丰账户的 HKD→USD 换汇验证 `txns` 条数不变，并通过全量写回持久性检查（D-033）。
- **P3-4（应急覆盖永远算不出来）**：`avgNecessaryMinor()` 有两处错——`Core.aggregate` 未传 `categories`，按「必要」标记分类失效、`need` 恒为 0；同时把已经是「分」的 `agg.need` 又过了一遍 `yuanToCents`，结果被放大 100 倍。改为服务端从现金流事实权威重算（`necessaryBasisFromState`），并把「口径来源 + 检索月份 + 取值月份数」一并封进快照，前端传值只作降级兜底。
- **P3-5（汇率落库为 `"[object Object]"`）**：`Domain.parseDecimal` 返回的是定点对象 `{v, s}` 而不是数字，API 校验用 `v <= 0` 判正（对象恒为假）、repository 直接 `String(rate)` 写库，导致所有外币折算永久失败。已改为用定点对象判正并保留原始定点字符串；新增汇率往返与折算断言（D-034）。
- **P3-6（负债无法在结账月内核对）**：负债表单没有核对日期字段，`asOf` 恒为「今天」，`computeCloseChecklist` 要求负债核对日与结账月份相同 —— 有负债时正式结账按钮永久禁用，只能存估算。新增 `#al-asof`（默认结账月末）并把用户选择值提交（D-034）。
- **P3-7（备份结构校验漏 Phase 3 新表）**：`validateBackupFile` 用固定表清单校验，`monthly_closes`/`close_snapshots`/`asset_transfers` 都不在内 —— 声称 v3 却缺表的损坏库会通过校验、恢复后迁移器也不会重建。已按候选库 schema 版本条件化校验（D-035）。

### Phase 2 历史证据（2026-09-14）

| 范围 | 方法 | 日期 | 结果 | 说明 |
|------|------|------|------|------|
| Phase 1 基线回归（金额/解析/去重/统计/V2 特性/备份/领域） | `node --test` | 2026-09-14 | ✅ 133/133 | Phase 2 改动前后均全绿，零回归 |
| S2.1 SQLite Schema 与迁移器 | `node --test tests/server-migration.test.js` | 2026-09-14 | ✅ 13/13 | 建表齐备、重复迁移幂等、失败整包回滚、外键级联、定点十进制、`balance_minor` 允许 NULL、`pool`/`classification_status` 约束、报价去重、内存库一致 |
| S2.1 repository 读写 | `node --test tests/server-repository.test.js` | 2026-09-14 | ✅ 14/14 | 全量替换幂等、未知字段经 `extra_json` 零丢失、机构文本归一、加密交易只落密文、事务回滚、指纹分表、`readState().assets` 形状与 `Domain.emptyAssets()` 逐键一致 |
| S2.4 备份 | `node --test tests/server-backup.test.js` | 2026-09-14 | ✅ 13/13 | 创建即通过校验且不留 `-wal/-shm/-tmp`、权限 0600、内容可独立打开、校验只读、保留 30 份可自定义、每日至少一份、写后节流、拒绝非法候选、临时文件清理、v2 fixture 仍可解析、同秒同名备份不覆盖（B9） |
| S2.4 恢复 | `node --test tests/server-restore.test.js` | 2026-09-14 | ✅ 8/8 | 恢复前先备份、候选非法不破坏当前库、不存在候选、切换后无 `.restore-tmp/.replaced` 残留、旧连接失效、审计链可回读、恢复前备份可再次作为恢复源 |
| S2.1/S2.2 HTTP 层（loopback、门禁、静态托管、forceBackup） | `node --test tests/server-api.test.js` | 2026-09-14 | ✅ 16/16 | 见下方"S2.2 门禁逐项" + S3 `forceBackup` 覆盖前强制备份 |
| 前端请求头契约 | `node --test tests/store-headers.test.js` | 2026-09-14 | ✅ 6/6 | 所有写方法（含无 body 的 `DELETE`）声明 JSON、令牌只随写请求发送、只读降级不发请求、幂等键透传、网络失败立即降级只读（B7）、`forceBackup` 透传 |
| S2.1/S2.2 浏览器接线验收 | `tests/app-wiring.html`（经本地服务托管） | 2026-09-14 | ✅ 11/11 | 见下方"浏览器接线验收" |
| §13 实施前只读技术验证 | 见 `ARCHITECTURE.md` §13.1 | 2026-09-14 | ✅ 5/5 | SQLite 驱动、loopback 绑定、单实例锁、Keychain 读取、LaunchAgent plist |
| 端到端实测（真实 HTTP 请求） | `curl` + 临时数据目录服务 | 2026-09-14 | ✅ 通过 | health/state/overview/holdings/backups/restores/keychain 全部符合契约；单实例、清空、恢复全流程 |

**合计：`node --test` 202/202 通过（133 旧 + 69 新），浏览器 wiring 11/11，耗时约 5.3 秒。**

### S2.2 门禁逐项（`tests/server-api.test.js`）

| 场景 | 期望 | 实测 |
|---|---|---|
| 监听地址 | 只绑 `127.0.0.1`，代码中无改绑分支 | ✅ `config.HOST` 硬编码；实测非 loopback 不可达 |
| `GET /api/v1/health` | 暴露 loopback 策略、`factSource=sqlite`、`cors=disabled`、`cloudAi=false` | ✅ 一致 |
| CORS | 任何响应都不带 `Access-Control-Allow-Origin` | ✅ 读接口与预检均无该头 |
| 预检 `OPTIONS` | 405，不提供跨源能力 | ✅ `preflight_not_supported` |
| 写请求缺 token | 401 `token_required` | ✅ |
| 写请求错 token | 401（`timingSafeEqual`，长度不同也拒绝） | ✅ |
| 写请求错 Origin | 403 `origin_rejected` | ✅ |
| 写请求错 Content-Type | 415 `invalid_content_type` | ✅ |
| 无请求体的 `DELETE` | 同样要求 `Content-Type: application/json` | ✅（D-026 回归点） |
| 被拒写请求的副作用 | 数据零改动 | ✅ 资产账户/余额单元计数不变 |
| 只读能力 | GET 与页面渲染不受门禁影响 | ✅ |
| 静态资源穿越 | 编码 `..` + 斜杠、`.git`、`.db` 一律拒绝 | ✅ 403 `forbidden_path` |
| session token | 只注入 HTML，静态 JS 不含令牌 | ✅ |
| 后续阶段写接口 | 501 并说明所属阶段，而非 404 | ✅ Phase 3/4/5/6 各一例 |

### 浏览器接线验收（15/15，`http://127.0.0.1:<port>/tests/app-wiring.html`）

运行方式（必须由本地服务托管，`file://` 直开会被判定为只读降级）：

```bash
node server/main.js --data-dir "$(mktemp -d)" --port 8499 --no-open
# 另开一个终端
node /tmp/wire-run.js     # 或人工打开 http://127.0.0.1:8499/tests/app-wiring.html
```

| # | 用例 | 对应验收 |
|---|---|---|
| C0 | 本地服务可达、事实源为 SQLite、令牌已注入、未显示只读横幅 | S2.1/S2.2 前提 |
| C1 | 应用启动渲染资产决策台空状态、现金流页可达、账本为空 | S1.4 回归 |
| C2 | 导入向导文件选择触发解析预览（6 条有效记录） | S1.4 回归 |
| C3 | JSON 备份恢复入口弹出确认并覆盖恢复（含转账记录） | S1.1 回归 |
| C4 | v1 备份恢复后资产集合初始化为空、决策台空状态 | S1.1 回归 |
| C5 | v2 资产备份恢复后决策台展示精确口径（43,800 / 10,800 / 5,200 / 33.3% / 正式口径） | S1.2 回归 |
| C6 | 经应用写入的数据只能落在 SQLite；HTTP 直读一致；**IndexedDB 读到 0 条** | **S2.1** |
| C7 | 缺令牌 401、错 Content-Type 415、被拒写入零副作用、只读仍可用 | **S2.2** |
| C8 | 清空账本经本地服务生效，且服务端先留 `pre-clear` 备份 | **S2.4/S2.1** |
| C9 | JSON 恢复前强制留 `pre-import` 备份（节流窗口内也可回滚） | **S3**（补充验收） |
| C10 | 服务中断时记账：不报已入账、回滚界面、进入只读降级 | **S2**（补充验收） |
| S3.1 | 资产录入页建账户/登记余额/录负债/录权益/记换汇，SQLite 直读四类资源落库；全量写回不抹资源数据 | **S3.1** |
| S3.3 | 月结页生成上月核对清单；余额未核对时正式结账禁用；保存估算快照后历史出现记录，HTTP 直读 `monthly_closes` 与快照哈希 | **S3.3** |
| S3.2 | 福利预设四类分流：公积金/医保明确余额进入受限资产各计一次；无余额资格 `balanceMinor=null` 不计入；社保卡金融账户独立 | **S3.2** |
| P0-A | 余额与负债的核对日改到结账月份内 + 手动汇率齐备 → 正式结账按钮可用 → 确认后事实源状态变 `formal` | **S3.3 闭环** |
| P1-B | 资产页登记 HKD→CNY / USD→CNY 手动汇率后总览含折算金额、不再有 `fx_missing`，原币余额不被覆盖 | **S3.1/S3.3** |
| P0-B | 历史结账「查看明细」列出账户、负债、核对日与折算金额（2,760.00 / 7,200.00）与应急覆盖口径 | **S3.1 退出条件** |

> 说明：本环境（模型与评审子代理）均无法读取图像输入，浏览器验收以 DOM 文本断言与程序化读值为准，不依赖截图评审。

## Phase 2 端到端实测记录（2026-09-14，虚构数据 + 临时数据目录）

1. 以 `--data-dir "$(mktemp -d)" --port 8499` 启动服务：迁移 v1、创建当日备份、仅监听 127.0.0.1、生成 0600 的 session token 文件。
2. `PUT /api/v1/state` 写入标准虚构数据 → 返回 `backup.created=true`（`-write.db`）；`GET /api/v1/overview` 净资产 4,380,000 分、可投资 1,080,000 分、可新增 520,000 分、`valuationStatus=formal`。
3. 同一 `Idempotency-Key` 重放：第二次返回 `X-Ledger-Idempotent: replay` 且返回首次结果、不再产生备份、数据不变。
4. 门禁探测：缺 token 401、错 Origin 403、错 Content-Type 415、预检 405；被拒写入后数据不变。
5. 第二实例启动同一数据目录：被单实例锁拒绝，只给出提示，不产生第二个写进程。
6. `DELETE /api/v1/state`：先生成 `-pre-clear.db` 备份再清空。
7. `POST /api/v1/restores`：恢复历史备份成功并回报 `schemaVersion`；恢复失败返回 409 且当前库内容不变。
8. `GET /api/v1/backups`：保留策略 30 份生效（实测超出部分被裁剪）。
9. `GET /api/v1/keychain/status`：只返回可用性字段，不返回任何密钥内容。
10. 静态路径穿越（编码 `..`、`.git`）与 `.db` 文件请求：一律 403。

## 本轮发现并修复的缺陷

### B1（P0，备份原语）：`node:sqlite` 在线备份 API 会不可预测地停住

- **现象：** 测试套件在备份相关用例上从 1.7 秒劣化到 71 秒并最终被 SIGTERM 杀死；生产路径同样会在每次保存后出现秒级卡顿。
- **定位过程：** 隔离基准显示单独调用 `backup()` 稳定 0–1ms；在测试运行器内实测同一进程第 1–2 次约 1ms、之后每次约 8,100ms，偶发完全挂死。对照实验证明与连接开关、WAL、`synchronous` 设置、页数、文件描述符数量均无关，纯粹是该 API 在长生命周期进程中的行为。
- **修复：** 改用 SQLite 自身的 `VACUUM INTO` 生成自包含快照（同步、确定、不带同伴文件）。备份测试耗时从 71 秒降到 1.7 秒，套件整体 6.3 秒。
- **约束记录：** 见 `ARCHITECTURE.md` §13.2 与 `DECISIONS.md` D-027（含"单实例锁保证无并发写入"这一前提）。

### B2（P1，形状契约）：`readState().assets` 漏掉 `schemaVersion`

- **现象：** 前端 `DB.loadRaw()` 返回的 `assets` 带 `schemaVersion: 1`，服务端读回的不带；浏览器验收 C4 直接命中失败。
- **原因：** repository 手写键列表时漏字段，且既有测试用 `ASSET_STRIP` 把该字段剥掉后比对，掩盖了差异。
- **修复：** `readState().assets` 补上 `schemaVersion`，并把键集与 `ASSET_KEYS` **改为从 `Domain.emptyAssets()` 派生**，杜绝前端改结构后服务端静默分叉；测试改为逐键比对键集 + 断言 `normalizeAssets(readState().assets)` 幂等。

### B3（P0，清空链路）：无请求体的 `DELETE` 未声明 Content-Type

- **现象：** 浏览器验收出现未处理的 Promise 拒绝：`写请求必须使用 Content-Type: application/json`。即"清空账本"在 Phase 2 下会失败。
- **原因：** 前端 `apiFetch` 只在 `body != null` 时设置 `Content-Type`，而服务端对所有写方法统一要求 JSON。
- **修复：** 所有非只读方法（POST/PUT/PATCH/DELETE）一律声明 `Content-Type: application/json`；wiring 补 C8 覆盖清空链路，并把清理步骤改成显式断言，避免再被未处理拒绝掩盖。回归点见 D-026 与 `tests/store-headers.test.js`。

### B4（P1，静态守卫 + 清理）：路径穿越判断晚于归一化；备份目录残留孤儿文件

- **现象：** 校验候选备份时会在备份目录留下 `ledger-*.db-shm/-wal` 孤儿文件；路径穿越守卫对编码输入不够早。
- **修复：** 静态路径先按**未归一化**的路径段拒绝 `..` 与 `.git`，再做拼接校验；`validateBackupFile` 只清理"本次打开新产生"的同伴文件，绝不删除调用前就存在的活跃库 `-wal`；`pruneBackups` 顺带清理 `.tmp*` 残留。

### B5（测试基建）：wiring harness 的 `waitFor` 不等待异步谓词

- **现象：** 断言在异步写入落盘前就执行，导致 C3/C4 假失败（同时掩盖了 B2、B3）。
- **修复：** `waitFor` 改为 `Promise.resolve().then(fn)` 后再判断真值，谓词可安全返回 Promise。

### B6（S1，Service Worker）：缓存优先让会话令牌过期，重启后刷新即 401

- **现象：** 本地服务重启会轮换随机 session token，但 SW 缓存优先命中了带旧令牌的 `index.html`；刷新后写请求全部 401，记账/清空/恢复全部失败。
- **原因：** `sw.js` 对导航请求与静态资源一视同仁地缓存优先，而 HTML 里注入了按会话令牌；缓存副本的令牌必然过期。
- **修复：** HTML 一律网络优先（在线时永远拿服务端新页面），离线才回退到「脱敏后」的缓存壳；缓存 HTML 时把令牌替换回占位符，真实令牌不再落盘到 Cache Storage。静态资源维持缓存优先。`CACHE` 版本号递增触发旧缓存失效。回归点见 `DECISIONS.md` D-029。

### B7（S2，保存链路）：保存失败仍显示「已记一笔」，未落盘交易挂在界面且不进入只读模式

- **现象：** 停止服务后记账，页面同时出现「已记一笔」与「保存失败」，明细里显示未落盘交易；刷新后交易消失，且未进入只读模式。
- **原因：** `saveAdd()` 乐观更新先报成功、`save()` 失败只报错不回滚；`Store.detect()` 缓存模式结论，服务中途不可达后仍以为自己是可写模式。
- **修复：** `save()` 改为返回成败、确认落盘后才提示成功，失败回滚本地乐观更新并重渲染；`store.js` 在网络层失败时立即把模式降级为只读（`unreachable`），后续写入在本地拒绝；对 401 给出「刷新页面」提示。回归点见 `DECISIONS.md` D-030、`tests/store-headers.test.js`、wiring C10。

### B8（S3，恢复前备份）：JSON 恢复走普通全量写入，节流窗口内被覆盖版本无法找回

- **现象：** 页面 JSON 恢复通过普通 `PUT /api/v1/state` 覆盖数据；若 60 秒写后备份节流窗口内刚写过数据，覆盖前的最新版本没有备份，无法回滚。
- **原因：** 服务端 `PUT /state` 只有写后节流备份（`createBackupAfterWrite`），没有「覆盖前强制备份」通道；前端恢复与普通保存共用同一入口。
- **修复：** `PUT /state` 支持 `body.forceBackup=true`，写前先强制留 `pre-import` 备份（备份失败即 503 中止写入）；前端 `Store.saveAll({ forceBackup })` 透传，`restoreBackup` 恢复走该路径且失败回滚到恢复前状态。`clearGo` 同步改为走服务端 `DELETE /state`（自带 pre-clear 备份）。回归点见 `tests/server-api.test.js`、wiring C9。

### B9（备份命名）：同秒同名保护性备份互相覆盖

- **现象：** `stamp()` 只有秒级精度；同一秒内两次保护性备份（如连续两次恢复、或恢复+清空同秒）生成同名文件，后一次 `renameSync` 覆盖前一次，导致更早的 `pre-import`/`pre-clear` 快照丢失。
- **修复：** `createBackup` 在目标文件已存在时追加 `-1/-2` 后缀，保证覆盖前版本可找回；正常场景文件名不变，既有断言不受影响。回归点见 `tests/server-backup.test.js`。

## Phase 1 历史记录（2026-09-14）

Phase 1 验收（S1.1–S1.4）证据与走查记录保留在本文件下方与 `ROADMAP.md` Phase 1 段落中；当时结论为 `node --test` 133/133、浏览器 wiring 5/5。

### 本轮发现并修复的问题（Phase 1）

- **W1（界面）：** `actions` 分发表缺少 `nav:cashflow`，决策台「去记一笔现金流」点击被静默忽略。已补上；wiring C1 覆盖该链路。
- **W2（测试基建）：** `tests/app-wiring.html` 未加载新增的 `js/domain.js`，导致 app.js 初始化崩溃。已在 harness 页补引。
- **W3（观察，仍未修复）：** `sw.js` 存在但应用从未注册 Service Worker（`index.html`/`js/*.js` 中无 `serviceWorker.register`）。Phase 1 曾观察到 SW 缓存会把 `/tests/` 页面缓存住导致改版后拿不到新版；现在既然从未注册，该问题不复现，但"离线能力"实际上并不存在。是否补齐注册留待产品决定，不阻塞任何阶段验收。

## P0 验收清单（v2 历史基线，持续有效）

### 财务正确性

- [x] 微信支付与银行卡重复流水只统计一次。
- [x] 同一份 CSV 重复导入时新增记录为零。
- [x] 手动记录与导入记录能够提示合并。
- [x] 渠道不明或同金额候选不唯一时不会自动合并。
- [x] 提现、充值和账户间转账不污染收支，余额变化正确。
- [x] 撤销合并后原始记录、余额和统计恢复正确。
- [x] 退款关联后冲减原分类支出，不虚增收入。
- [x] 报销闭环后垫付与到账不虚增收支，余额仍正确。
- [x] 二级分类汇总与一级分类总额一致。

### 数据安全

- [x] 应用界面新增交易后刷新，数据仍存在。
- [x] JSON 备份生成、校验和恢复共享逻辑无损往返。
- [x] 开启应用锁后交易加密落盘，错误密码不能解锁。
- [x] CSV 包含 BOM，中文、金额和特殊字符转义正确。
- [x] 错误清空确认不会删除数据，强确认后才清空。

### 历史缺陷记录（v2）

- **P0-001：银行混合收支被首行方向覆盖。** 类型映射按"类型名称"聚合，但银行收支方向按行提供。修复：同一类型出现混合方向时不生成整类覆盖，`buildTxns` 按每行原始方向处理。回归：Node 与浏览器微信 + 招行组合均通过。
- **P0-002：同日同金额交易可能误自动合并。** 跨源去重仅凭金额、方向和日期判定高置信。修复：自动合并必须同时满足银行支付渠道痕迹一致、近日期候选唯一；否则交用户确认或作为独立记录。回归：渠道缺失、渠道冲突和多候选三类用例均通过。

## 未完成的 P1 发布检查（不阻塞阶段验收）

- [ ] 在全新浏览器配置中完成一次真实下载文件 → 文件选择恢复的人工检查。
- [ ] 用 Excel 或 Numbers 打开导出 CSV，目视检查编码和列格式。
- [ ] **登录项端到端：** 由用户在自己终端执行 `scripts/install-login-item.sh`（会写 `~/Library/LaunchAgents` 并 `launchctl bootstrap`），重启 Mac 后确认自动启动、只打开一个实例、能正常打开页面。
- [ ] **Keychain 真实读取：** Phase 4 才需要写入真实行情 API Key；当前只需确认 `GET /api/v1/keychain/status` 可用性探测正常（已通过）。
- [ ] 从旧 Service Worker 升级并确认接管（取决于 W3 是否补齐注册）。
- [ ] 手机尺寸检查底部导航、弹层、键盘和安全区。
- [ ] 数千至数万条流水的导入性能和重复提交保护（Phase 2 起经 SQLite + 幂等键，需重新测量）。

## 运行方式

```bash
cd ledger

# 1) 自动测试（202 项）
node --test

# 2) 启动本地服务（数据默认在 ~/Library/Application Support/Ledger）
node server/main.js            # 或双击 start.command
node server/main.js --help     # 查看 --port / --data-dir / --self-check 等选项
./scripts/install-login-item.sh   # 需要开机自启时（用户自己在终端执行）

# 3) 浏览器接线验收（必须经本地服务托管，用临时数据目录，避免触碰真实账本）
node server/main.js --data-dir "$(mktemp -d)" --port 8499 --no-open
# 打开 http://127.0.0.1:8499/tests/app-wiring.html
```

正式验收应继续使用虚构数据。若用户自行使用真实账单抽查，数据只在本机 SQLite 与本地浏览器处理，不写入仓库或发送给外部服务。
