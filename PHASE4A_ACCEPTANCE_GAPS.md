# Phase 4A 验收缺口记录（独立复核）

> 记录来源：独立复核 Agent 于 2026-09-15 对 Phase 4A（提交 `38100c3`，基线 `node --test` 245/245、wiring 15/15）的复核结论。
> 本文件规则：**原始复核结论原样保留作证据**，修复状态追加在文件顶部，不删改原始条目。

## 二次复核补口（2026-09-16）

| 编号 | 级别 | 复核结论 | 修复状态 |
|---|---|---|---|
| G4A-7 | P0 | `isValidResult` 只检查必需字段的值，不检查结果键集合；带 `accountName` / `quantity` / `costMinor` 等私有字段的 provider 结果仍能通过 `assertValidResult` | ✅ 已修：quote / fx / error 均要求普通对象且键集合与契约白名单完全一致；新增夹带私有字段的反例，落库前校验不再放行 |
| G4A-8 | P1 | `isTimestamp` 依赖 `Date.parse`，会接受并自动归一 `2026-02-30T08:00:00Z` 与 `2026-09-15T24:00:00Z` | ✅ 已修：显式校验真实日历日、`00–23` 时、`00–59` 分秒及最大 `±14:00` 时区；`fixedClock` 同步覆盖反例 |
| G4A-9 | P1 | 外部 adapter 可绕过 `errorResult`，直接提交含换行、控制字符或超长 `detail` 的错误结果并通过 `assertValidResult` | ✅ 已修：错误结果校验要求 `detail === safeDetail(detail)`，未经单行清洗或超过 160 字符一律拒绝 |
| G4A-10 | P1 | `provider: "   "` 仍被当成非空来源标识，`quoteResult` / `fxResult` / `isValidResult` 均会放行 | ✅ 已修：非空字符串统一改为 `trim().length > 0`；行情、汇率构造器与直接结果校验均加入空白 provider 反例 |
| G4A-11 | P0 | T-002 同时写“✅ 已定”和“行情源不冻结端点”，与 4A 冻结免费行情/汇率源的退出条件矛盾 | ✅ 状态已纠正：T-002 改为“汇率已定、行情待 4D 前决定”；4A 改为“契约完成、正式验收暂不通过”。D-038 仅是启用门禁，不能替代行情源决策；4B/4C 可按明确例外推进，4D 前必须关闭该缺口 |

**二次补口测试证据：** Phase 4A 定向测试 **44/44**；全量 `node --test` **274/274**（230 旧 + 44 项 4A）；浏览器 wiring **15/15**；零真实网络请求、零数据库迁移、零 API/UI 改动。代码门禁全绿，但 G4A-11 是明确延期而非已完成的行情源决策，因此 4A 正式验收仍待定。

## 修复状态（2026-09-15，执行 Agent）

| 编号 | 级别 | 原始结论 | 修复状态 |
|---|---|---|---|
| G4A-1 | P0 | 请求边界没有真正校验公开代码：`String()` 强转，`"V OO"` / `null` / 小写币种都进入 adapter 并被当成 `not_found` | ✅ 已修：`serializeQuotesRequest` / `serializeFxRequest` 在序列化**之前**逐项校验数组、symbol、pair，非法输入整体返回稳定 `invalid_payload`；拒绝原因只含"第 N 项 + 形状说明"，不回显输入原文 |
| G4A-2 | P0 | 结果校验会放过不可入账数据：`priceMinor: -1`、`priceMinor: 1.5`、`rateDecimal: "0"`、`priceDate/fetchedAt: "bad"`、`{code:"timeout", retryable:false}` | ✅ 已修：`quoteResult`/`fxResult`/`errorResult` 改为严格构造（不合格即抛 `ContractError`）；`isValidResult` 同步收紧：正的安全整数、汇率 > 0、真实存在的 `YYYY-MM-DD`、带时区的 ISO 时间戳、`retryable` 严格等于错误码映射（且不再作为入参，调用方无法伪造） |
| G4A-3 | P0 | Stooq 不能作为已冻结的自动化数据源（`/q/l/` 404、`/q/d/l/` 返回 JS 验证挑战；无 API 版本/限额/授权/稳定性说明；未证实 `0700.HK`、`510300.SS` 可取） | ✅ 已修：**实测复现并否决**（`server/providers/SOURCES.md` §2）；Yahoo chart 亦实测 403 否决（§3）；D-036 重做为「汇率冻结 + 行情启用门禁」，行情端点不再冻结，见新增 D-038 |
| G4A-4 | P1 | 节假日 fixture 是静态假通过：忽略 `asOf`，`asOf=2026-09-01` 仍返回 2026-09-11 的行情 | ✅ 已修：行情与汇率 fixture 改为按日期升序的时间序列，adapter 只取 `date <= asOf` 的最近一条；`asOf` 早于数据起始日返回 `not_found`；新增"请求日早于数据日"反例与逐 `asOf` 不漏未来数据的不变量测试 |
| G4A-5 | P1 | T-003 只决定了缓存策略，没决定元数据来源（未写哪个 provider、哪些字段、来源标识、冲突处理原始证据） | ✅ 已修：D-037 重写，明确 provider（Twelve Data 参考数据 `/symbol_search`，实测覆盖 HKEX/SSE/SZSE/US）、字段映射、provenance 记录结构与冲突处理规则 |
| G4A-6 | P1 | Frankfurter 决策需明确 API 版本（v2 默认是多来源混合，须固定 `/v2/providers/ecb/...`）；"ECB 覆盖 33 种货币"与官方页面不一致 | ✅ 已修：D-036 固定 `/v2/providers/ecb/rates`，并以实测值差说明默认端点不可用（`SOURCES.md` §1.1）；删除全部易过期的固定货币数量（`/v2/providers/ecb/currencies` 实测 404，无法复核） |

**补口后测试证据：** `node --test` **272/272**（230 旧 + 42 项 4A 定向，其中 27 项为本次新增反例/不变量）；浏览器 wiring **15/15**（连续两轮全绿，4A 未改前端，属回归确认）；零真实网络请求、零数据库迁移、零 API/UI 改动。

**残留项（明确延期，不计作已修复）：**
1. **行情主源端点仍未定，导致 4A 正式验收待定**。4A 取证时不存在同时满足「免费 + 无 key + 有官方条款/限额/授权 + 覆盖 A/H/US ETF 日终」的源（`SOURCES.md` §7）。T-002 已如实标为“汇率已定、行情待定”；端点必须在 4D 开始前决定，门禁通过前自动抓取关闭、走手动补价。
2. 「腾讯 / 东方财富公开端点」实测可达但无官方条款，**未**写入任何已确认决策；如需采用需用户显式接受非官方风险（`SOURCES.md` §6）。

---

## 原始复核结论（原文保留，2026-09-15）

### 1. P0：请求边界没有真正校验公开代码。

`contract.js (line 83)` 直接对输入执行 `String()`，没有调用已经定义的 `isSymbol`/`isPair`。`"V OO"`、`null`、小写币种等非法输入都会进入 adapter，并被当成 `not_found`，不符合"输入只能是公开证券代码/币对"的要求。

修复要求：序列化前验证数组、symbol 和 pair；非法输入返回稳定的 `invalid_payload`，且错误 subject/detail 不得回显潜在私人文本。

### 2. P0：结果校验会放过不可入账数据。

`contract.js (line 139)` 当前实际接受：

- `priceMinor: -1`
- `priceMinor: 1.5`
- `rateDecimal: "0"`
- `priceDate`/`fetchedAt`: `"bad"`
- `{code:"timeout", retryable:false}`

修复要求：价格必须为正的安全整数，汇率必须大于零，日期必须是真实 `YYYY-MM-DD`，抓取时间必须是有效 ISO 时间，`retryable` 必须严格等于错误码映射。

### 3. P0：Stooq 目前不能作为已经冻结的自动化数据源。

2026-09-15 实际探测：

- `/q/l/` CSV 路径返回 404
- `/q/d/l/` 返回 JavaScript 验证挑战，不返回 CSV
- 文档没有给出可复核的 API 版本、调用限额、自动化使用授权和稳定性承诺
- 没有证据证明 `0700.HK`、`510300.SS` 可通过自动接口获取

Stooq 官方页面可以证明其展示部分美股行情，并注明部分数据来自 Infront，但不能证明当前 Node 服务可合法、稳定地自动拉取。

修复要求：重新验证或更换行情源；必须留下可复现的公开代码探测结果、官方条款链接、限额、认证方式、市场覆盖和失败语义。

### 4. P1：节假日 fixture 是静态假通过。

`fixture.js (line 56)` 完全忽略 `asOf`。传入 `asOf=2026-09-01`，它仍返回未来的 2026-09-11 行情。

修复要求：验证 `asOf`，并从时间序列中选择 `priceDate <= asOf` 的最近有效日；增加"请求日在数据日前"的反例测试。

### 5. P1：T-003 只决定了缓存策略，没有决定元数据来源。

`DECISIONS.md (line 47)` 写的是"provider 返回的字段"，没有明确哪个 provider、哪些字段、来源标识和冲突处理所需的原始证据。Stooq 当前接口又未证实可提供元数据，因此不能算 T-003 已冻结。

### 6. P1：Frankfurter 决策需要明确 API 版本。

Frankfurter 本身可用：官方文档确认无 Key、日频、可自托管。但当前 v2 默认是多来源混合汇率；如果产品决策要求 ECB 参考汇率，必须固定使用 `/v2/providers/ecb/...`。D-036 中"ECB 覆盖 33 种货币"也与当前官方页面不一致，建议删除易过期的固定数量。

### 给修改 Agent 的完成标准（原文）

- 补齐输入、金额、汇率、日期、时间和错误一致性验证。
- 增加上述全部反例测试。
- 让 holiday fixture 真正按 `asOf` 选择最近有效数据。
- 重做 D-036 的 Stooq 可用性论证，无法满足时更换 provider。
- D-037 明确实际元数据来源、字段映射和 provenance。
- 完成后重新跑 15+ 定向测试、全量回归和浏览器 15 项回归。
