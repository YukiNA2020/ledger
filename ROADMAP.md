# Ledger v3 增量路线图

> 产品范围：[PRODUCT.md](./PRODUCT.md)  
> 架构约束：[ARCHITECTURE.md](./ARCHITECTURE.md)

## 总原则

每一阶段都必须保持原有记账和账单导入功能可运行。先建立纯逻辑与数据契约，再迁移存储，最后接真实行情；不把大规模 UI 改版、数据库迁移和外部 API 同时放进一个不可回滚的改动。

## Phase 0｜产品重定义与基线

状态：已完成（2026-09-06）。

交付物：

- `README.md / PRODUCT.md / ARCHITECTURE.md / ROADMAP.md / AGENTS.md`；
- `DECISIONS.md / ACCEPTANCE.md / NEXT_AGENT.md`；
- 旧文档明确降级为历史档案；
- 当前 Git 工作区与测试基线确认；
- 决策台范围、数据模型、验收场景和执行门禁冻结。

退出条件：文档术语一致；旧测试全绿；没有覆盖用户既有修改。

退出证据：2026-09-06 运行旧基线测试 **99/99 通过**；v3 实现代码为零；用户原有 `styles.css` 与 `sw.js` 修改保持不变。

## Phase 1｜资产领域基础

状态：已完成（2026-09-14）。

目标：在现有代码上形成可运行的资产决策台骨架。

工作项：

1. 定义资产账户、币种子账户、负债、权益、标的、持仓和报价对象。✅ `js/domain.js`
2. 实现 CNY/HKD/USD 折算、总资产、净资产、资金池和风险类别聚合。✅ `Domain.computeOverview`
3. 实现价格/余额新鲜度状态。✅ quote/fx 超 5 个自然日 stale、余额按月确认、分类未确认
4. 将首页重构为资产决策台；原月度记账首页下沉为现金流页。✅ `home`→`tplDashboard`、`cashflow`→原首页
5. 增加空状态、数据口径和未完成事项提示。✅ 空状态/估算口径阻塞项/待办/口径说明
6. 扩展备份 Schema，保持旧 Schema 可读取。✅ schemaVersion 2 + `assets` 集合；v1 备份恢复为空 v3 集合

退出条件：纯逻辑单测覆盖关键口径；没有资产数据时旧记账仍可正常使用；首页不虚构数值。

退出证据（2026-09-14）：

- `node --test` **133/133 通过**（含 31 项 `tests/domain.test.js` 领域行为测试，S1.2 标准虚构数据全部精确命中）；
- 浏览器 wiring 验收 5/5 通过（`tests/app-wiring.html`，含 S1.1 v1 备份兼容、S1.2 v2 备份精确口径）；
- 浏览器 GUI 走查 S1.1–S1.4 通过，空状态/估算口径/缺汇率/正式口径截图见 `docs/evidence/`；
- 备份往返测试覆盖 v1→空集合、v2 资产字段无损、未来版本拒绝。

## Phase 2｜本地服务与 SQLite

状态：已完成（2026-09-14，含补充验收修复）；依赖 Phase 1 退出条件全部通过。

目标：建立目标事实源和可靠启动方式。

工作项：

1. 建立只监听 `127.0.0.1` 的本地服务和 `/api/v1`。✅ `server/api.js`（`/api/v1` 前缀、session token + Origin + Content-Type 三重写校验、无 CORS 无预检、HTML 注入令牌）
2. 建立 SQLite Schema、迁移器和 repository。✅ `server/migrations.js`（v1 `phase2-initial-schema`，版本化、事务原子、失败回滚）、`server/repository.js`（八集合 + 旧四键、全量替换幂等、`extra_json` 零丢失、机构文本归一、加密交易只落密文）
3. 将前端读写从 IndexedDB 迁到本地 API。✅ `js/store.js` 存储门面：API 模式完全不触碰 IndexedDB；服务不可达时只读降级并显示横幅，绝不双写
4. 配置 macOS 登录启动并自动打开页面。✅ `server/login-item.js` + `scripts/install-login-item.sh` / `uninstall-login-item.sh`（默认只写 plist，加 `--activate` 才 `launchctl bootstrap`）
5. 增加本地自动备份、恢复和 30 版本保留策略。✅ `server/backup.js`（快照→校验→原子替换→裁剪；恢复前先备份、临时库校验后切换、失败回滚原库）
6. 将 API Key 接入 macOS Keychain。✅ `server/keychain.js` 只做可用性探测与读取路径（只走 stdin 不进 argv）；真正读取留给 Phase 4

退出条件：重启 Mac 后可自动打开；数据库事务、备份恢复与 loopback 安全测试通过；IndexedDB 不再是事实源。

退出证据（2026-09-14）：

- `node --test` **202/202 通过**（Phase 1 的 133 项零回归 + 新增 69 项 Phase 2 测试：迁移 13、repository 14、备份 13、恢复 8、HTTP 层 16、前端请求头契约 6）；
- 浏览器 wiring 验收 **11/11 通过**（`http://127.0.0.1:<port>/tests/app-wiring.html`，含 S2.1 单一事实源、S2.2 写入门禁、清空链路，以及补充验收新增的「恢复前强制备份」「服务中断记账回滚与只读降级」）；
- §13 五项只读技术验证全部 OK（SQLite 驱动、loopback 绑定、单实例锁、Keychain 读取、LaunchAgent plist 渲染与 lint），结论见 `ARCHITECTURE.md` §13；运行时定为 Node（T-001）；
- 实测端到端：health/state/overview/holdings/backups/restores/keychain 全部符合契约；缺令牌 401、错 Origin 403、错 Content-Type 415、预检 405；第二实例被单实例锁拒绝；清空先留 pre-clear 备份；恢复 v1 库成功、恢复失败 409 且当前库不变；备份保留 30 份生效；
- 事实源切换为单一方向：API 模式下 `DB.loadRaw()` 读到 0 条（IndexedDB 未被写入），页面数据与 HTTP 直读 SQLite 完全一致。

本轮发现并修复的真实缺陷（详见 `TEST.md`）：

- **B1（备份原语）**：`node:sqlite` 在线备份 API 在长生命周期进程里会不可预测地停住（实测第 1–2 次约 1ms，之后每次约 8 秒甚至挂死）。改为 SQLite 自身的 `VACUUM INTO` 生成自包含快照，稳定 0–1ms；生产路径不再有 8 秒写后卡顿。
- **B2（形状契约）**：`repository.readState()` 返回的 `assets` 漏了 `schemaVersion`，与前端 `DB.loadRaw()` 形状不一致，前端 `normalizeAssets` 无法直接消费。
- **B3（清空链路）**：前端 `apiFetch` 只在有请求体时设置 `Content-Type`，导致无请求体的 `DELETE /api/v1/state` 被服务端判为非法写请求（415），「清空账本」静默失败并抛成未处理的 Promise 拒绝。
- **B4（静态守卫）**：静态资源路径穿越判断原先放在 `path.normalize` 之后，对编码/特殊输入守卫过晚；改为先按未归一化路径段拒绝，并顺带清理备份目录的孤儿 `-wal/-shm`。
- **B5（测试基建）**：wiring harness 的 `waitFor` 把 `async` 谓词返回的 Promise 当作真值，导致断言在写入落盘前就执行。
- **B6（S1，Service Worker）**：SW 缓存优先会缓存带会话令牌的 `index.html`；服务重启轮换令牌后，刷新仍命中旧令牌，写请求全部 401。改为 HTML 网络优先、离线才回退到「脱敏后」的缓存壳（令牌替换回占位符），静态资源维持缓存优先。
- **B7（S2，保存链路）**：记账乐观更新先报「已记一笔」再异步保存，且 `detect()` 缓存模式使服务中断后不降级只读，导致界面同时出现成功与失败提示、未落盘交易挂在明细里。改为保存确认落盘后才提示成功、失败回滚本地更新，并让网络层失败立即降级只读。
- **B8（S3，恢复前备份）**：页面 JSON 恢复走普通全量 `PUT /state`，受 60 秒写后备份节流，恢复前 60 秒内刚写过数据时被覆盖版本无备份可回滚。改为 `PUT /state` 支持 `forceBackup`，高风险覆盖前先强制留 `pre-import` 备份（失败即中止），前端恢复走该路径。
- **B9（备份命名）**：`stamp()` 只有秒级精度，同一秒内两次保护性备份（如连续两次恢复）同名互相覆盖。改为目标文件已存在时追加 `-1/-2` 后缀，保证覆盖前版本可找回。

## Phase 3｜账户、负债与月度结账

状态：已完成（2026-09-15，含验收补口 v2.3.2）；依赖 Phase 2 退出条件全部通过。

目标：形成可信个人资产负债表。

工作项：

1. 机构—账户—币种子账户管理。✅ 资产录入页（机构→账户→子账户逐层维护）+ `POST /api/v1/institutions|accounts|account-units` 单条 upsert（机构按名称归一合并，其余按 id 幂等更新，D-031）；`GET/POST /api/v1/asset-transfers` 记录换汇两端事实，独立于现金流收支（D-033）
2. 安全储备、可投资、受限资产和保障权益分类。✅ 账户 `pool` 字段（safety/investable/restricted）+ 决策台资金池卡片复用 `Domain.computeOverview`；权益只展示状态与来源，不进入任何金额合计（D-011）
3. 青岛公积金、医保、养老及社保卡预设与来源说明。✅ 资产页四个预设入口按「有无明确余额」分流（D-034）：公积金余额 / 医保个人账户余额 → 受限资产账户 + CNY 余额（计入资产且只计一次）；养老等无余额资格 → `entitlement(balanceMinor=null)`；社保卡金融账户 → 普通储蓄卡独立管理。权益表单与列表支持地区、来源说明、核对日期
4. 负债、近期应付款和净资产计算。✅ `POST /api/v1/liabilities`（含核对日期 `asOf`）+ 净资产扣减负债（`computeOverview` 既有口径）
5. 月度核对清单、结账状态和历史快照。✅ `Domain.computeCloseChecklist` + `GET/POST /api/v1/monthly-closes`（formal/estimate、sha256 快照、同月重复结账更新记录并追加快照）+ 月结页与历史列表；历史结账可经 `GET /api/v1/close-snapshots/:id` 下钻到封存时的余额/负债/持仓单元级事实（D-034）
6. 根据必要支出估算应急金覆盖月数。✅ 决策台应急金卡片 + 服务端按最近 3 个完整月必要支出重算（`necessaryBasisFromState`），口径来源与检索月份一并写入快照，不采信前端覆盖率
7. 外币余额在 Phase 3 内可折算。✅ 资产页手动汇率维护 + `GET/POST /api/v1/fx-rates`（币对 + 汇率 + 汇率日）；自动行情 provider 仍属 Phase 4（D-034）

退出条件：一个完整月结账可在 15 分钟内完成；所有金额可追溯到余额、估值或交易。

退出证据（2026-09-15）：

- `node --test` **230/230 通过**（202 基线零回归；含 2 项 macOS Keychain 写读）；`tests/domain-close.test.js` 7 项、`tests/server-phase3.test.js` 14 项、迁移 v2/v3 14 项、备份与 repository 的 Phase 3 补口全绿；
- 浏览器 wiring 验收 **15/15 通过**（连续两轮全绿），含 S3.1 资产录入不被全量写回抹掉、S3.3 月结门槛与估算快照、S3.2 福利预设四类分流、P0-A 正式结账闭环、P1-B 手动汇率、P0-B 历史金额下钻；
- 迁移 v2 `phase3-close-schema`（`monthly_closes` + `close_snapshots`）与 v3 `phase3-asset-transfers` 只加表不改旧表，v1/v2 库前向迁移与备份恢复测试通过；备份结构校验按候选库 schema 版本条件化（D-035）；
- 正式结账门槛由服务端强制：存在阻塞项时 `POST status=formal` 返回 409 `close_blocked`，只能保存估算（S3.3）；负债核对日落在结账月份内时正式结账可完成（P0-A）；
- 金额下钻：`GET /api/v1/close-snapshots/:id` 返回封存时的 `checklist.facts`（账户、原币金额、折 CNY、核对日、来源类型），payloadJson 重算 sha256 与列表哈希一致（P0-B）；
- S3.1 补充验收：香港汇丰同一账户的 HKD/USD 余额分别落库；HKD→USD 换汇写入 `asset_transfers`，`txns` 条数保持不变；全量写回后换汇记录仍保留，且币种由关联余额单元推导而非采信载荷（D-033/D-034）。
- 保留项：「15 分钟完成一次月结」的真实耗时按计划留待 Phase 7 用两个月真实使用验证。

## Phase 4｜持仓与日终行情

目标：形成可信可投资资产与风险敞口。

Phase 4 拆成 4A–4E。**每次执行任务只领取一个子阶段**；当前子阶段通过、提交且文档交接完成后，才进入下一个。唯一例外是 T-002 的行情端点：因 4A 取证确认当时没有候选满足 D-038，明确延期到 4D 开始前决定；4B/4C 不接真实行情，因此可在保留该验收缺口的前提下推进（4B 已于 2026-09-16 完成验收；4C 已于同日完成实现与自验），但不得把 4A 标成正式通过。

### Phase 4A｜数据源决策与适配器契约

状态：**契约实现完成，正式验收暂不通过**（2026-09-16）。T-002 仅汇率源已定，行情端点延期到 4D 开始前；4B/4C 可按上方例外推进。

范围：

1. 冻结 `DECISIONS.md` T-002 的汇率源与 T-003（ETF 元数据来源）；调查行情源并冻结启用门禁。若无候选通过门禁，必须把 T-002 行情部分明确记为待定，不得写成“已定”。
2. 定义 provider adapter 的输入、成功结果、错误分类、重试边界与隐私边界。
3. 建立固定时钟和本地 fixtures；请求构造测试必须证明只发送公开证券代码/币对，不发送账户名、数量、成本或余额。
4. 只完成适配器契约与测试骨架，不接 API、不迁移数据库、不做 UI。

退出条件：T-002（汇率与行情）/T-003 均已决定；fixture adapter 能覆盖成功、超时、限额、缺标的、节假日；**非法输入与不可入账数据均被契约拒绝（不是"看起来对就放行"）**；全部测试离线运行。当前除 T-002 行情端点外均满足，因此 4A 只能记为“契约完成、正式验收待定”。

退出证据（2026-09-15）：

- `DECISIONS.md` **D-036**（汇率 = Frankfurter 且固定 `/v2/providers/ecb/…`，实测默认端点与 ECB 端点值不同）、**D-037**（元数据候选来源 = Twelve Data 参考数据 `/symbol_search` + 字段映射 + provenance + 用户确认锁定）、**D-038**（行情启用门禁）已建立；T-003 已定，T-002 仅汇率部分已定，行情端点待 4D 前决定；
- 新增 `server/providers/contract.js`（严格契约：请求序列化**前**校验数组/symbol/pair，非法输入整体返回稳定 `invalid_payload` 且不回显输入原文；结果构造严格 —— `priceMinor` 正安全整数、`rateDecimal > 0`、真实 `YYYY-MM-DD`、带时区 ISO 时间戳、`retryable` 由错误码推导不可伪造；错误 `subject` 只允许公开代码/币对形状）、`server/providers/clock.js`（固定时钟 `ctx.now`，非法时间戳直接抛错）、`server/providers/fixture.js`（离线 fixture adapter，按 `asOf` 从时间序列取 `date <= asOf` 的最近有效日）；
- 新增 `server/providers/SOURCES.md` 数据源证据档：Stooq（`/q/l/` 404、`/q/d/l/` JS 验证挑战）、Yahoo chart（403）、Twelve Data（覆盖/限额/条款/认证/失败语义）、Alpha Vantage、腾讯/东方财富端点的**可复现探测命令与原始结果**，以及官方条款与限额链接；
- 新增 `tests/providers-contract.test.js` **44/44**：错误分类与可重试映射、形状边界（含伪日历时间戳、无时区时间戳、小写币种）、请求校验反例（非数组/空数组/超限/非法项）、私有文本不回显、结果精确键白名单与构造/校验反例（额外私有字段、未清洗错误 detail、负价/小数价/零汇率/坏日期/坏时间/`retryable` 不一致）、`asOf` 取数与"请求日早于数据日不得返回未来行情"反例、不可入账数据被拦成 `invalid_payload`、隐私边界、固定时钟确定性，以及跨全部 fixture 的不变量（任一 `asOf` 下每个结果都通过契约校验）；
- 全量 `node --test` **274/274**（230 旧零回归 + 44 项 4A）；浏览器 wiring **15/15**（连续两轮全绿）；
- 零数据库迁移、零 API 改动、零 UI 改动、零真实网络请求；
- 独立复核缺口记录与逐条修复状态见 `PHASE4A_ACCEPTANCE_GAPS.md`（保留原始结论作证据）。

### Phase 4B｜标的目录与分类确认

状态：**已完成；两轮独立复核补口 + 第三轮引用安全审计完成（2026-09-16），等待独立复核确认**。第三轮进一步修复 instrument 更新级联删除关联事实、provider 身份未绑定、搜索契约错误静默化、跨市场合并受返回顺序影响、全量写入绕过分类门禁等问题；逐条状态见 `PHASE4B_ACCEPTANCE_GAPS.md` G4B-8–12。

范围：

1. 标的检索、候选结果与元数据缓存。
2. 资产类别/市场/币种预分类。
3. 用户确认与本地锁定；外部元数据变化不得覆盖已确认分类。
4. 建立稳定的标的 id，供后续多个证券账户共同引用；本阶段不创建持仓。

退出条件：固定 fixture 可完成“搜索 → 预分类 → 用户确认 → 再刷新不覆盖确认值”；缺失或冲突元数据明确提示；同一标的不重复创建事实。

已交付：

- 检索/候选/合并与冲突：`server/instrument-catalog.js`（纯编排）、`GET /api/v1/instruments/search`；本地命中在 provider 不可用时仍可用，且"没搜到"与"调用失败"可区分；
- 参考数据契约与 provenance：`server/providers/contract.js` 的 `serializeSearchRequest` / `serializeMetadataRequest` / `instrumentResult` / `makeProvenance`（D-037 六字段，`payloadHash` 可重算复核）；检索请求产物键集合恒为 `{query}`；
- 离线参考数据：`server/providers/fixture.js` 的 `CATALOG` + `searchInstrument` / `getInstrumentMetadata`（缺项 `null`，坏元数据转显式 `invalid_payload`）；
- 预分类与用户判断字段：`js/domain.js` 的 `diffInstrumentFields` / `suggestFromProvider` / `EXPOSURE_MARKETS` / `USER_JUDGEMENT_FIELDS`；`asset_class` / `exposure_market` / 跟踪指数只能由用户填写与确认（D-037、D-039）；
- 确认与本地锁定：`POST /api/v1/instrument-confirmations`（两项用户判断必填）；`confirmed` 记录在后续刷新中保持状态与值不变，差异只以 `conflicts[]` + provenance 提示；
- 稳定 id 与去重：id 由**首次创建时的 identity key** 派生并永久锁定（`inst-<sha1(identityKey) 前16位>`，记录持久化 `identityKey`，外部可离线复算；客户端指定的 id 一律拒绝 `client_id_forbidden`）；去重键 `(symbol, exchange)` 在**所有**写入路径（目录接口 / 单条 upsert / 全量 `PUT /state`）显式拒绝同键第二行（`duplicate_instrument` → 409 + 事务回滚），并由迁移 **v4** 表达式唯一索引 `uq_instruments_dedupe` 在数据库层兜底；同代码跨市场存在多行时报 `ambiguous_instrument`（409）要求指明交易所；
- 前端：资产页「标的目录」区块（搜索/候选/目录/确认弹层/手工建立弹层），经 `js/store.js` 门面访问；`APP_VERSION` 与 SW 缓存键升至 `2.3.7-phase4b`。
- 引用安全与写入门禁（第三轮补口）：instrument 更新采用原位 upsert，不触发持仓/事件/报价外键级联；provider 元数据必须绑定请求代码，搜索非法响应显式报错；多市场松匹配先完整判歧义；`/state` 与单条 upsert 同样校验分类状态、分类词表与 confirmed 完整性，并统一规范化身份字段。

退出证据：全量 `node --test` **371/371**、4B 编排 **48/48**、真实 HTTP **17/17**；浏览器 wiring 沿用上一轮 **17/17**（本轮未改 UI）；`DEFERRED_WRITES` 未动；迁移停在 v4；零真实网络请求。详见 `ACCEPTANCE.md` S4B.1、`TEST.md` 与 `PHASE4B_ACCEPTANCE_GAPS.md`。

### Phase 4C｜持仓账本与证券事件

状态：**第三轮独立复核补口完成（2026-09-18），等待复核确认**。口径冻结见 `DECISIONS.md` D-042/D-043。

范围：

1. 初始持仓快照。
2. 买入、卖出、分红和费用事件。
3. 实现 `portfolio-openings`、`security-events` 写接口、事务与幂等校验。
4. 增加最小持仓录入/事件 UI；同一标的可存在于多个账户；本阶段只使用手动价格或固定 fixture，不接真实行情。

退出条件：首次 10 份，买入 2 份、卖出 1 份后稳定得到 11 份；买卖不重复计入收入支出，分红与费用可单独追溯；备份恢复往返无损。

已交付：

- 迁移 **v5** `phase4c-security-event-amounts`：`security_events` 加 `amount_minor` 列（分红/费用总额）+ `(account_id, instrument_id, occurred_at)` 重放索引；`price_minor` 只存每股价格，不做字段混用（D-042 ②）；
- 领域层：`SECURITY_EVENT_TYPES` 词表、定点数量比较/求和/相减助手（整数运算，不过浮点）、`deriveHoldings` 唯一推导实现（期初 + Σ买入 − Σ卖出；分红/费用不改数量；买入可无期初；按 `occurred_at` 升序重放，宽松模式跳过超额卖出并留痕，strict 模式抛 `insufficient_holdings`）；`computeOverview` / `computeCloseChecklist` 在有事件时改用推导数量（无事件零回归）；
- 服务端：`readSecurityEvents` / `upsertSecurityEvent`（同 id 409 `duplicate_event`、未知引用 422、写入前 strict 全量重放）/ `writeSecurityEvents`（全量路径同一套校验 + strict 重放，整体回滚）/ `upsertPortfolioOpening`（同键第二行 409 `duplicate_opening`）；`readHoldings` 升级为推导视图（含 `openingId` / `eventCounts` / `lastEventAt` 等追溯字段）；`readState` / `writeState` 带上 `securityEvents` 键（备份往返无损）；
- API：`POST /api/v1/portfolio-openings`、`POST /api/v1/security-events`（支持 `Idempotency-Key` 回放）、`GET /api/v1/security-events`；`DEFERRED_WRITES` 移除两键，`market-data/refresh` 仍 501（4D 且受 D-038 门禁）；错误码集中归位（409/422/400 各就各位）；
- 前端：资产页新增「持仓与证券事件」区块（期初快照弹层、事件弹层、推导持仓卡片、事件流水），每次写入后 `refreshAssets()` 重拉全量状态；`APP_VERSION` 与 SW 缓存键升至 `2.3.8-phase4c`（复核补口轮升至 `2.3.9-phase4c`）。

退出证据（第三轮复核补口后更新）：全量 `node --test` **452/452**；4C/4D 真实 HTTP 合并 **30/30**；浏览器 wiring **21/21**；schema 停在 **v7**；零真实网络请求。在 G4C-10/11 基础上新增 G4C-12：根 `state` 拒绝数组；`assets` 缺失兼容旧备份，显式存在时必须是非空对象，错误形状在清库前 400 且原事实不变。详见 `ACCEPTANCE.md` S4C.1、`TEST.md` 与 `PHASE4C_ACCEPTANCE_GAPS.md`。

### Phase 4D｜日终行情、汇率与失败兜底

状态：**第三轮独立复核补口完成（2026-09-18），等待复核确认**。口径冻结见 `DECISIONS.md` D-044，门禁复核证据见 `server/providers/SOURCES.md` §8。

**前置门禁（D-038，未通过不得开启自动抓取）：** 4D 在接入任何自动行情源之前，必须逐条补齐并写入 `server/providers/SOURCES.md`：官方条款链接（含自动化使用授权）、可复核的 API 版本与文档、调用限额（日/分钟）、认证方式、市场覆盖的明确声明、失败语义到五类错误码的映射；门禁未通过时保持自动抓取默认关闭，行情以手动补价 + 本地缓存为唯一事实来源。

范围：

1. 接入 4A 契约的行情 provider 与 `market-data/refresh`（**汇率可直接接 Frankfurter 固定 ECB 端点，D-036；行情源先过门禁，见上**）。
2. 从 Keychain 读取所需 Key；Key 不进入 argv、数据库、前端或日志。
3. 保存价格日、抓取时间、provider 和原始代码；增加有限重试、限额/超时错误与缓存；**落库前必须经 `contract.assertValidResult` 校验，不可入账数据一律拒绝写入**。
4. 保留 Phase 3 手动汇率，并增加手动价格兜底；失败保留最后有效值并标记 stale。

退出条件：成功、断网、超时、限额、缺标的、节假日和手动覆盖全部由 fixture 测试覆盖；错误响应不能覆盖最后有效值；自动测试不访问公网。

已交付：

- **门禁复核结论（D-038，2026-09-17 实测）**：逐条复测候选行情源并写入 `server/providers/SOURCES.md` §8（含原始输出与六条门禁对照表）——Frankfurter（pin ECB 端点）通过全部门禁；Stooq / Yahoo / Twelve Data demo / FMP / EODHD / Polygon / Finnhub 均因条款、授权或覆盖不达标被否；腾讯/东财接口可达但无自动化授权与稳定条款，同样不达标。结论：**行情自动抓取默认关闭**，汇率自动更新开启；
- **迁移 v7** `phase4d-quote-source-symbol`：`quotes` 加 `source_symbol` 列承载 provider 返回的原始代码（追溯要求）。**只加列、不加索引**：报价的「(标的, 价格日) 元素键」由写入路径强制，不提升为数据库唯一索引（v1 的 `uq_quotes_dedupe` 允许同一价格日不同 provider 并存，收紧会拒绝合法历史状态，见 v7 迁移内注释）；`backup.js` 的按版本必需列清单同步登记；
- **领域层（单一实现，D-025）**：`js/domain.js` 纯扩展——`MANUAL_PROVIDER`、`MARKET_SCOPES`、`marketElementKey` / `marketGroupKey` / `marketRowDate`、`planMarketMerge`（元素键替换 + 手动值冻结：同组内 ≤ 手动行数据日的观测一律 `manual_locked`）、`requiredQuoteSymbols` / `requiredFxPairs`（只按事实推导更新目标，不猜测）；
- **仓储层**：`validateQuoteRow` / `validateFxRow` 两条单条路径与全量路径共用同一套校验（币种一律由标的推导，拒绝载荷覆盖；错误码 `invalid_instrument_id` / `invalid_price` / `invalid_price_date` / `currency_mismatch` / `invalid_provider`）；`upsertManualQuote`（来源固定 `manual`）、`upsertProviderQuote` / `upsertProviderFxRate`（拒绝冒充 `manual`，同组手动值冻结）、`replaceQuoteRows`；`readQuotes` 透传 `source_symbol`；
- **编排层**：`server/market-data.js`（`refreshMarketData` 逐作用域报告 + `MAX_ATTEMPTS=2` 有限重试，**只在整批失败且至少一个错误可重试时**整批重发；每次结果先过 `contract.assertValidResult` 再落库；任何失败不改动任何已有行，只报告）、`server/providers/frankfurter.js`（**pin ECB 端点 `/v2/providers/ecb/rates`**，D-036；五类错误码映射 + 超时中止）、`server/providers/keychain-key.js`（惰性读 Key、只返回布尔状态、密钥不进响应与日志）；
- **API**：`POST /api/v1/quotes`（手动补价兜底）、`POST /api/v1/market-data/refresh`（`DEFERRED_WRITES` 移除，不再是 501）。响应语义是「一次刷新尝试的报告」：外部失败返回 200 + `ok:false` + 逐作用域 `errors`（含 `retryable`），不把外部不可达伪装成客户端错误。自动行情开关**只从服务端 settings 读取，不信任请求体**；
- **前端**：资产页新增「行情（收盘价）」区块（逐标的卡片：价格/价格日/来源/新鲜度、手动补价入口、启动时自动更新汇率开关、刷新入口），手动补价弹层走 `js/store.js` 门面；`APP_VERSION` 与 SW 缓存键升至 `2.3.10-phase4d`。

退出证据（第三轮复核补口后更新）：全量 `node --test` **452/452**；4D 编排层 fixture **27/27**、真实 HTTP **10/10**；浏览器 wiring **21/21**；迁移停在 **v7**；自动测试**零真实网络请求**。请求—结果继续逐键对齐；顶层跳过原因现在从实际结果推导，有目标且被手动锁定时返回 `manual_locked`，`no_targets` 只用于 `requested=0`。详见 `ACCEPTANCE.md` S4D.1/S4D.2 与 `TEST.md`。

### Phase 4E｜估值下钻与收益归因

范围：

1. 资产类别、机构、币种和市场下钻。
2. 每个持仓估值可追溯到数量、价格、价格日、汇率和 provider。
3. 将证券价格变化与汇率影响分开，明确无法归因的边界。
4. 接入资产决策台和月结快照，保持旧快照可读。

退出条件：实际持仓可正确估值并下钻；证券收益与汇率影响分别展示且可复算；行情失败时保留估算但阻止正式建议；Phase 1–3 全量回归通过。

已交付：

- **零新数据源、零迁移**：4E 只读 Phase 3 已封存的月结快照作为期初基准，schema 停在 **v7**；`quotes` / `fx_rates` / `portfolio_openings` / `security_events` 一张表也没动，`backup.js` 的按版本必需表/索引/列清单无需变更。基准来源**不是**新算的一遍今天口径，而是「已结账月快照」这份封存事实（D-045 ①）；
- **领域层（单一实现，D-025）**：`js/domain.js` 纯扩展——as-of 查询 `findQuoteAsOf` / `findFxRateAsOf`（**只返回查询日当天及之前**的行，绝不把未来行情拉进历史）、`holdingKey`、`holdingsAsOf`（按基准日截断期初与证券事件两条边后复用 `deriveHoldings` 重放，不另写一套加减）、`quoteStatusOf` / `fxStatusOf` / `convertToCny`（把原先内嵌在 `computeOverview` 里的新鲜度与换汇口径提成共享助手，避免长出第二套判定）、`valueAssetItems`（从 `computeOverview` 抽出的**同一遍**估值；`computeOverview` 新增 `opts.withItems` 纯追加开关，默认关闭，旧快照载荷形状不变）、`computeCloseChecklist.facts.holdings` 追加 `fxRateDecimal` / `fxRateDate` / `fxProvider` / `priceProvider` / `eventCounts`；
- **`computeAttributionBaselinePositions` + `attributionPositions`（G4E-1 复核补口，2026-09-19）**：结账时以**基准月末 as-of 口径**计算逐持仓明细（数量 = `holdingsAsOf` 重放、价格/汇率 = as-of 查询，绝不取业务日期在未来的行）并封存进快照 payload，作为下期归因的期初基准事实。刻意区别于 `checklist.facts.holdings`（Phase 3「结账时点最新价」口径，可能含当时已可见的未来价格，不能做期初）；
- **`computeAssetDrilldown`**：机构 / 币种 / 资产类别 / 敞口市场四个维度，各自用 scope 说明覆盖范围（机构与币种 = 全部资产；类别 = 投资池，现金记 `cash` 类；市场 = 投资池**持仓**，现金没有敞口市场，故市场合计 + 投资池现金才等于投资池）。四个维度与总览**共用同一遍估值**，因此「下钻合计 == 总览」是构造性成立的，不是两套算法互相对账；领域层用 `consistency` 自报四项合计数及是否吻合，页面不再各写一套容忍判断。另出 `positions` 逐持仓追溯（数量 / 价格 / 价格日 / provider / 汇率 / 汇率日 / provider / 折 CNY / 未计入原因）；缺汇率的持仓留在组内并计 `unvaluedCount`，不静默消失；未填敞口市场的持仓进 `unspecified` 桶，不冒充任何真实市场；负债不进资产项维度，单列在 `totals` 里；
- **`computeReturnAttribution`（D-045）**：把持仓的 CNY 估值写成 `V = Q × P × R`，**证券价格影响 =（期末本地币值 − 期初本地币值）× 期初汇率**，**汇率影响 = ΔV − 价格影响**取**残差** —— 于是「价格影响 + 汇率影响 = 估值变化」逐行恒等，舍入缺口只落在汇率一侧，不留「归因不出来的差额」；全程整数最小货币单位，不经浮点。**期初腿只认封存明细（D-045 ⑨，G4E-1 补口）**：期初数量/价格/汇率全部来自 `baseline.positions`（`baselinePositionsFromSnapshot` 是唯一提取实现，结账路径与前端基准切换共用），领域层不存在「从当前事实表按历史日期重算期初」的路径；期末腿走 as-of（查询日）。因此**重算旧月份必然得到同一结果**，结账后回填旧业务日期的行情/汇率/事件/期初也改写不了已结账月的归因。「分解不了」与「算不出变化」分开表达：有过不去的边界时照样给 ΔV，只是不做分解；
- **归因边界与不可用原因逐条列明、绝不插值**：`missing_start_quote` / `missing_end_quote` / `missing_start_fx` / `missing_end_fx` / `currency_changed` / `position_opened` / `position_closed` / `quantity_changed` / `opening_rebased` / `instrument_missing` / `holding_invalid`。封存明细里缺价格或汇率就缺，不按 1:1 兜底、不用期末值顶替；期间有买卖、清仓、或重录期初（数量跳档不是收益）时只给变化额不做分解。**没有基准快照时整段不出归因**（`unavailable:'no_baseline'`），**基准快照给不出封存明细时同样整段不出**（`baseline_details_missing`），**快照原文与封存哈希不符时拒绝使用**（`baseline_hash_mismatch`）—— 三种情况 `rows` 均为空、界面显式说明，绝不倒算。行情/汇率过期与分类未确认只作为 `notes` 提示，**不**新造第二套「能不能给正式建议」的判定，沿用既有 blocker 语义；
- **API**：`POST /api/v1/monthly-closes` 把 `attribution` 与 `attributionPositions` 封存进快照 payload（**纯追加**字段：旧快照没有这些键，读取方必须容忍缺失，哈希照旧可复核），基准取**上一个已结账月**的快照（asOf 即它的 `dataCutoff`），重算前先校验快照**原文** sha256 与封存 `payloadHash` 一致；`GET /api/v1/close-snapshots/:id` 同样按原文复算并返回 `hashValid` / `integrityStatus`，让读取方不可把篡改 payload 与旧哈希混用。响应同时回带 `attribution`，省掉一次往返；
- **前端**：决策台新增「估值下钻」与「收益归因」区块。归因卡异步读取选中基准快照，但只有服务端明确返回 `hashValid:true` 才提取封存明细；不一致或缺少校验结论时 fail closed 为 `baseline_hash_mismatch`，清空 positions 且不生成归因行/合计。切换基准即读取**新基准的**快照内容；`APP_VERSION` 与 SW 缓存键升至 `2.3.13-phase4e`。

退出证据（第二轮复核补口后更新）：全量 `node --test` **486/486**、4E 定向 **34/34**，非沙箱实跑；浏览器 wiring **24/24 × 2 轮干净环境**；数据库迁移停在 **v7**（无新迁移）；自动测试**零真实网络请求**。真实 HTTP 已覆盖“篡改 `attributionPositions` 但保留旧哈希 → GET 报 mismatch”，wiring 已覆盖“打开决策台后零归因行/零合计”。

## Phase 5｜风险问卷与配置建议

目标：把资产全貌转化成透明行动。

**Phase 5 拆成 5A–5E**，每次执行任务只领取一个子阶段；当前子阶段通过、提交且文档交接完成后，才进入下一个。拆解全文（全阶段不变量、跨阶段验收矩阵、迁移与备份原则、停止条件、交付格式）见 [`PHASE5_BREAKDOWN.md`](./PHASE5_BREAKDOWN.md)。

| 子阶段 | 核心问题 | 主要产物 | 明确不做 |
|---|---|---|---|
| 5A | 规则到底是什么 | T-004 冻结、题库/评分/区间契约、固定 fixtures | 不迁移、不做 API、不做 UI |
| 5B | 如何得到并保存有效风险评估 | 双评分领域逻辑、复评机制、持久化/API、问卷 UI | 不算目标配置、不生成建议 |
| 5C | 风险结果如何变成目标区间 | 目标区间、容忍带、用户认可标的映射 | 不分配新增资金、不创建决策状态 |
| 5D | 新增资金如何分配 | 确定性再平衡算法、正式门禁、建议接口与快照绑定 | 不做状态机、不做执行关联 |
| 5E | 用户能否看懂并复算 | 决策台展示、本地知识卡、逐项解释、端到端验收 | 不实现 Phase 6 的接受/执行/复盘 |

工作项（括号内为承载子阶段）：

1. 风险承受能力和风险意愿双评分。（5A 冻结规则，5B 落地）
2. 年度与重大事件复评机制。（5A 冻结词表与到期口径，5B 落地）
3. 目标配置区间和容忍带。（5A 冻结模板与容忍带语义，5C 落地）
4. 新增资金优先再平衡算法。（5A 冻结契约与排序/尾差规则，5D 落地）
5. “资产类别 → 用户认可标的”映射。（5C 落地）
6. 本地知识卡和可解释建议。（5E 落地）

退出条件：相同输入得到稳定可复算结果；低风险上限不会被高意愿分数覆盖；数据过期时不生成正式建议。

### Phase 5A｜规则冻结与领域契约

最终收口：G5A-8/9 已独立确认；最终复核新增并闭合 G5A-10/11/12——当前 `targetVersion` 绑定每个等级的唯一冻结模板，`newFundsMinor` 必须是非负安全整数，未来评估日 fail closed；规则图交叉引用也已固化。`2.4.6-phase5a` 下 5A 定向 33/33、全量 519/519、浏览器 wiring 24/24 × 2，Phase 5A 已通过，可进入 5B。
历史补口：第四轮复核发现的 G5A-7 已在 `2.4.4-phase5a` 修复，认可标的数组只接受普通稠密自有数据索引；当轮 5A 定向 27/27、全量 513/513，后续完整复核已确认闭合。
历史补口：第三轮复核发现的 G5A-6 已在 `2.4.3-phase5a` 修复，`approvedInstruments` 只消费自有类别并拒绝自定义原型；当轮 5A 定向 26/26、全量 512/512，后续复核已确认对象层闭合。

状态：**已通过（2026-09-20，`2.4.6-phase5a`）**。G5A-1～12 全部闭合，下一子阶段为 5B。

交付物：

- `js/domain.js` 新增「风险问卷规则与配置契约（Phase 5A，D-046）」段落：9 道题（能力 5 / 意愿 4）与选项分值、等级边界（**下界含入**）、4 条硬封顶、5 级目标模板（六类 `minBps/targetBps/maxBps`，Σtarget 精确 100%、**个股 target 恒为 0**）、容忍带（**端点含入**）、复评词表与 365 天 / 30 天有效期、稳定错误码、建议输入输出契约与排序尾差规则；纯契约函数 `validateRiskAnswers` / `scoreRiskAnswers` / `assessmentValidity` / `addCalendarDays` / `isCalendarDate` / `validateTargetTemplate` / `targetTemplateForLevel` / `compareToRange` / `validateRecommendationRequest` / `recommendationContract` / `riskCatalog`（既有函数签名与语义未改动）。**补口**：新增 `deepFreezeRisk` 递归冻结 16 个对外规则常量（只冻第一层挡不住 `RISK_QUESTIONS[0].options[0].score = 0`）；
- `tests/fixtures/phase5-risk-rules.json`：规则冻结副本（题库 / 分值 / 边界 / 硬封顶 / 模板 / 复评词表 / 错误码 / 建议契约）+ S5.1 / S5.2 / S5.3 样例 + 19 条边界与反例矩阵（逐条标注承载子阶段）；测试逐字段比对 domain 常量，改规则必须同时改 fixture；
- `tests/domain-phase5a.test.js`：**33 项**；5A-28 锁住答案行/模板行原型链与访问器注入，5A-29 锁住完整评分结果的顺序确定性，5A-30 锁住规则图引用，5A-31/32/33 锁住唯一冻结模板、安全整数金额与未来评估日。

退出证据（2026-09-20 实跑）：全量 `node --test` **519/519**、5A 定向 **33/33**，非沙箱实跑；浏览器 wiring 在两个全新临时数据目录均为 **24/24**；schema 停在 **v7**——**零新迁移、零新 API、零新页面**；自动测试零真实网络请求。`APP_VERSION` 与 SW 缓存键升至 `2.4.6-phase5a`。

复核记录：`2.4.0-phase5a` 的第 1 轮独立复核结论为**暂不通过**（G5A-1 P0：规则常量可被原地修改；G5A-2 P1：未知 `targetVersion` 被接受；G5A-3 P1：模板额外类别未被拒绝），原文与逐条补口状态见 [`PHASE5A_ACCEPTANCE_GAPS.md`](./PHASE5A_ACCEPTANCE_GAPS.md)。

下一子阶段入口与禁区见 `NEXT_AGENT.md`。

## Phase 6｜建议、执行与复盘

目标：完成个人决策闭环。

工作项：

1. 建议状态机与事件记录。
2. 接受、暂缓、忽略和待执行清单。
3. 实际证券交易与建议关联。
4. 执行后配置变化复盘。
5. 月度决策历史和数据快照。

退出条件：至少用测试数据完整跑通两次建议—决定—交易—复盘；状态非法跳转会被拒绝。

## Phase 7｜两个月真实验证

目标：验证产品而不是继续堆功能。

观察指标：

- 月度结账时长；
- 每周维护时长；
- 行情缺失次数；
- 人工补价次数；
- 建议被接受、暂缓和忽略的原因；
- 配置偏离是否逐步改善；
- 是否能在一分钟内回答四个核心问题。

退出条件：达到 PRODUCT 的 MVP 验收标准。未达到时优先简化流程，不直接增加自动化。

## 延后事项

- 付费行情；
- 券商只读导入；
- 手机与多设备同步；
- 云端 AI 问答；
- 其他币种；
- 个股研究、择时、自动交易和公开发布。

## 执行 Agent 工作协议

每次只领取一个 Phase；已拆分的阶段每次只领取一个子阶段，并按以下顺序交付：

1. 读取八份 v3 指导文档和当前 `git status`；
2. 报告该 Phase/子阶段的计划、会修改的文件和明确不修改的范围；
3. 先补领域行为测试或固定 fixture，再实现纯逻辑；
4. 接存储、API 或 UI，但不顺带实现下一 Phase/子阶段；
5. 运行旧回归和该 Phase/子阶段的新增验收；
6. 更新 ROADMAP 状态、TEST 证据和受影响文档；
7. 交付时列出完成项、未完成项、风险、回滚方式和下一阶段入口。

出现以下任一情况必须停止并请求用户决定：发现真实旧数据需要迁移；需要付费数据源；需要向外部发送私人财务事实；需要自动交易权限；需要改变已冻结产品边界；或同一阻塞连续三次仍无法排除。
