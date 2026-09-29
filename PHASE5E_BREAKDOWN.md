# Phase 5E 小任务拆解｜解释界面、知识卡与整体验收

**当前状态（2026-09-28）：Phase 5 验收补口中 G5-R1～R3 已修复并按 [PHASE5_REVIEW.md](./PHASE5_REVIEW.md) 的反例复验通过（版本 `2.4.21-phase5g5`），G5-R4 四问理解实际计时未完成 → Phase 5 仍不判定为完整验收通过，下一入口见 [NEXT_AGENT.md](./NEXT_AGENT.md)。**

**原独立复核（2026-09-27）：Phase 5 暂不通过完整验收；G5-R1～R4 待补口。** 以下为原交付与集成测试证据，完成状态已被该次复核覆盖。

原集成验收状态：**5E-1 风险摘要、5E-2 配置对照、5E-3 建议解释、5E-4 本地知识卡、5E-5 审计追溯完成局部验收，5E-6 整体验收通过（2026-09-27 为 `2.4.20-phase5e6`），5E 全部闭合并判定 Phase 5 完成**。基线为 schema v10；5D 验收见 `PHASE5D_ACCEPTANCE_GAPS.md`，5E-1～5E-6 的证据见 `ACCEPTANCE.md` 与 `TEST.md` 的对应小节，显示与知识卡边界见 `DECISIONS.md` D-050 / D-051，解释版本封存与旧建议兼容见 D-052，判定日注入时钟口径见 D-053。本文件细化 `PHASE5_BREAKDOWN.md` §8，不改变 5A–5D 已冻结的规则、金额或门禁。5E-1～5E-6 是同一 Phase 内的顺序交付，不是 6 个并行开发任务。原记录的下一入口曾为 Phase 6；当前应先完成 `NEXT_AGENT.md` 的 Phase 5 补口。

## 执行方法

一次只领取表中的**当前一项**。先记录 `git status --short` 和既有测试基线，保留未提交的 5B–5D 工作；修改限于该项涉及的页面、静态解释或测试。每项结束给出「改了什么、定向测试/浏览器结果、尚未满足什么、下一项入口」，再推进下一项。前端静态文件变更同步 `sw.js` 缓存版本。全量 `node --test` 与完整浏览器 wiring 是 5E-6 的最终门禁；每项先跑受影响的定向测试，并保持原有 wiring 绿色。测试只用虚构数据、临时库、固定时钟和离线 provider。

| 顺序 | 单轮只解决的问题 | 交付与边界 | 退出证据 |
|---|---|---|---|
| **5E-1 风险摘要** | 首页能否说清「我的能力、意愿与最终上限」 | 决策台只读卡：双评分/等级、最终上限、硬封顶原因、评估日/到期日、复评入口。复用 `Store.riskAssessmentCurrent()` 与现有风险页文案；不重算评分、不改问卷/API。 | 无评估、有效、即将到期、过期四态；首页数值与风险页/API 一致，过期不能显示“当前有效”。 |
| **5E-2 配置对照** | 首页能否看出「当前与目标差多少」 | 只读六类对照：当前金额/比例、目标 min/target/max、偏离与数据日；复用 `Store.allocationCurrent()`，无目标/无估值显示原因与入口。不写第二套比例或偏离计算。 | 固定 fixture 六类逐项与 `/targets/current` 相同；缺数据时不冒出 0% 或正式口径。 |
| **5E-3 建议解释** | 用户能否理解「这 2,000 元为何这样分」 | 在现有目标页建议结果上补齐类别排序依据、现金保底/未分配、认可标的与未映射待办、尾差、默认不卖出的具体原因；正式/估算标签与 blocker 直接取 5D 产物。不触碰分配算法或建议写入。 | S5.2 逐类别金额及 `Σ分配 + 未分配 = 可分配` 与 API 相同；高配为 0；无映射不转投；门禁失败只展示估算。 |
| **5E-4 本地知识卡** | 每条解释能否追到固定文字与版本 | 建立静态卡目录，稳定 id 与 `EXPLANATION_VERSION`；至少六张：能力与意愿、应急金上限、容忍带、新增资金优先、汇率风险、为何不默认卖出。页面只按已知解释码/id 链接，不把知识卡当财务事实。 | 每个引用 id 可解；未知 id 显式降级；离线可读，无云端 AI、收益承诺或具体股票购买建议。 |
| **5E-5 审计追溯** | 一条建议能否区分月结基准、计算日输入与解释版本 | 建议详情显示月结 id/哈希/截止日、计算判定日与 `inputHash`、建议 `payloadHash`、评估/目标/规则/算法版本、blockers、当前适用的知识卡版本。旧建议若未封存解释版本，明确标“当前卡片解释，非生成时封存版本”；不得改写旧记录或用月结哈希冒充完整计算输入。若新建议需要封存解释版本，先明确兼容契约和回归范围。 | 5D 完整输入建议可按原 capture 重放；字段与 API/库一致；无 capture 或校验失败的旧记录不冒充可验证建议；版本差异可见。 |
| **5E-6 整体验收** | 端到端是否真的看懂、算对且不越界 | 打通空资产、首次评估、待复评、无目标、无正式月结、行情过期、分类未确认、无认可标的、0 元、正常建议；从页面输出反推 S5.1–S5.3 fixture，与领域/API 逐项核对，整理证据和交接。只在这一步判断整个 5E/Phase 5 是否完成。 | 定向 + 全量 `node --test` + 两套干净临时库的完整 wiring 通过；原记账/导入回归；一次一分钟理解演练记录观察值，但不宣告 Phase 7 真实使用指标通过。 |

## 固定依赖与停止边界

- 顺序为 5E-1 → 5E-2 → 5E-3 → 5E-4 → 5E-5 → 5E-6。每项消费上一项已验证的页面结果；某项未过不把后续标为完成。
- 数值与门禁权威来源是 `Domain` / API：`risk-assessments/current`、`targets/current`、`recommendations`。页面只能格式化和解释，不能再算评分、比例、缺口、分配或 `canAdvise`。
- 月结快照是基准；`gate.capture` / `inputHash` 是计算日完整输入。知识卡版本若不在历史建议中，不能补称“当时已封存”。
- 保持 schema v10、D-046/D-048/D-049 和 5D 的全部测试不变；若 5E-5 确需扩展新建议记录，先说明迁移/备份/旧记录兼容并加行为测试，不能静默修改历史。
- 不接真实行情源、云端 AI、券商交易，不做 Phase 6 接受/暂缓/执行/复盘。4A 数据源门禁与 S2.3 实机启动的历史未决事项不由 5E 伪造通过。

## 5E-1 完成记录（2026-09-23）

2026-09-24 复核修正：旧实现返回首页时会在服务端复核完成前短暂显示缓存的「有效」角标。现已改为首屏「核对中」、失败后「未复核」，结果只更新风险摘要卡，并以请求序号阻止旧响应覆盖新判定。全量 `node --test` 619/619；干净临时库浏览器 wiring 28/28。下一入口仍是 5E-2。

交付：决策台新增只读风险摘要卡（`js/app.js` 的 `riskSummaryCardHtml` / `ensureRiskCurrentLoaded`），显示服务端当前评估的能力分/级、意愿分/级、最终上限与「取较低一侧」的来源、硬封顶命中、评估日与到期日（含剩余天数）、有效状态角标，以及评估详情与复评入口。无评估、有效、即将到期、已过期四态与 `invalid_records`、读取失败两类降级各自成立；判定未变化时不重渲染决策台。零 Domain / API / Store / 问卷 / 目标 / 建议算法改动，schema 仍 v10，`sw.js` 缓存键与 `APP_VERSION` 升至 `2.4.12-phase5e1`。

退出证据：全量 `node --test` 619/619（与基线一致，未增删用例）；浏览器 wiring 全量 28/28 连续两轮（18591、18592 两个全新临时库与 origin）；新增用例逐字段核对首页 = `/risk-assessments/current` = 风险页，并证明过期态不出现「当前有效」与上限数值。未闭合项见 `ACCEPTANCE.md` 与 `TEST.md` 的稳定性观察：三个既有 wiring 用例存在单次偶发失败（对照副本可复现），留给 5E-6。

## 5E-2 完成记录（2026-09-24，`2.4.14-phase5e2`）

独立补测（同日，`2.4.15-phase5e2`）：原无估值断言未逐行核对当前比例，且把目标区间里合法的 0% 与缺失的当前比例混淆。现要求六类 `pctBps` 均为空、每行明确写「比例不可用」；目标区间原样保留。浏览器新增真实 API 的 `stale_assessment`、`no_assessment` 路径，以及模拟 `invalid_records` 响应的界面 fail closed 断言；损坏记录的真实服务端判定由 `tests/server-phase5c.test.js` 覆盖。全量 619/619，两套新库 wiring 29/29 × 2。下一入口推进到 5E-3。

交付：决策台新增只读配置对照卡（`js/app.js` 的 `allocationCompareCardHtml` / `refreshAllocationCompareCard` / `ensureAllocCurrentLoaded`），显示六类当前金额与比例、目标 min/target/max、偏离与数据日、`canAdvise` 角标与 blocker 原因；无目标 / 尚未评估 / 待更新目标 / 无估值 / 记录不可复核各有独立文案与通往目标页的入口，缺数据时不出现 0% 或正式口径。全部数值只来自 `GET /api/v1/targets/current`（`Store.allocationCurrent()`），与目标页共用同一份 `state.allocCurrent`，页面不重算比例、偏离或 `canAdvise`（不变量 3 / D-025 / D-050 ③）。渲染纪律：复核中标「核对中」并保留上次对照，响应后只 `outerHTML` 替换对照卡，内容未变不动 DOM（用 `state.allocCompareHtml` 缓存比对）；读取失败标「未复核」并给 `alloc:retry` 重试入口。零 Domain / API / Store / 目标 / 建议算法改动，schema 仍 v10，`sw.js` 缓存键与 `APP_VERSION` 升至 `2.4.14-phase5e2`，wiring 脚本参数升至 `?v=5e2`。

退出证据：全量 `node --test` **619/619**（与 5D/5E-1 基线一致，未增删自动用例）；浏览器 wiring 全量 **29/29 × 2**（18605、18606 两个全新临时库与 origin，连续两轮全绿）。新增用例 C9.5 逐字段核对首页 = `/targets/current`，覆盖无目标 → 生成目标 → 估算态（分类未确认 blocker）→ 正式口径 → 无估值（pct-bps 全空、不出现 0%）→ 慢响应「核对中」且归因 DOM 不重建 → 读取失败「未复核」与 `alloc:retry` 恢复。实现过程中修正了三处 wiring fixture/断言缺陷（fxRates 字段形状、生成目标 201 vs 200、归因节点身份比较误用 `goHome` 前的旧节点），均属测试基建，未改产品逻辑。未闭合项仍见 `TEST.md` 的稳定性观察（交 5E-6）。

## 5E-3 完成记录（2026-09-24，`2.4.16-phase5e3`）

独立复核（同日，`2.4.17-phase5e3`）：发现已计算为 0 元的类别在可见金额处显示「—」，与缺失值混淆；现统一按服务端 `allocatedMinor` 显示金额，包括 0.00。C7.11 逐类核对可见金额与产物、明确要求测试 fixture 含高配类别，并收紧估算态不得出现正式建议标题的断言。全量 619/619，两套新库 wiring 29/29 × 2。下一入口仍为 5E-4。

交付：目标页建议结果块（`js/app.js` 的 `adviceResultBlock`）补齐完整解释层：`data-advice-result` 外层包裹整个结果区（状态行、金额汇总、守恒公式、blocker、解释区、类别行、待办、尾差、追溯），内部含排序依据、现金保底/未分配、认可标的与未映射待办、尾差、默认不卖出的具体原因；正式/估算标签与 blocker 直接取 5D 产物，全部字段来自服务端 `explainCodes` / `roundingNote` / `categoryAllocations` / `todos` / `blockers`，页面不重算优先级或缺口（不变量 3 / D-025 / D-050）。新增 `ADVICE_EXPLAIN_LABELS` 解释码词表与既有标签表同源。wiring 新增 C7.11 断言层：正式态解释层、估算态（模拟 `Store.createRecommendation` 返回篡改产物）、未映射反例（清空 `broad_equity` 映射 → 断言 `data-todo="missing_approved_instrument"`、不转投陌生标的、instrument-count=0 → 再映射恢复）。版本 `APP_VERSION` / SW 缓存键升至 `2.4.16-phase5e3`，wiring 脚本参数升至 `?v=5e3`。零 Domain / API / Store / 建议算法 / 建议写入改动，schema 仍 v10。

实现过程中修正一处 DOM 结构：原先 `data-advice-result` 只包裹状态行，解释区/类别行/待办/尾差/追溯作为兄弟节点落在结果块外，导致 `advEl.querySelector('[data-explain-code=...]')` 等断言查不到；改为外层统一包裹整个结果区后关闭。该修正只调整容器层级，未改任何金额、解释文案或服务端字段的格式化逻辑。

退出证据：全量 `node --test` **619/619**（与 5D/5E-1/5E-2 基线一致，未增删自动用例）；浏览器 wiring 全量 **29/29 × 2**（18631、18632 两个全新隔离临时库与 loopback origin，连续两轮全绿，干净 Chromium profile）；`node --check` 与 `git diff --check` 通过。S5.2 逐类别金额及 `Σ分配 + 未分配 = 可分配` 与 API 相同；高配为 0；无映射不转投；门禁失败只展示估算，均由 C7.11 新断言覆盖。未闭合项仍见 `TEST.md` 的稳定性观察（交 5E-6）。

## 5E-4 完成记录（2026-09-25，`2.4.18-phase5e4`）

独立复测：Node 627/627、全新临时库浏览器 wiring 30/30（18651）。生产首页安装 Service Worker 后确认已缓存知识卡脚本与首页缓存壳，断网重载仍能打开“汇率风险”卡；详情见 `docs/evidence/phase5e4-offline.txt`。原验收只检查缓存清单和在线页面，本次补上真实离线运行证据。下一入口仍是 5E-5。

交付：新增静态本地知识卡目录 `js/knowledge.js`（UMD，node 走 `module.exports`、浏览器挂 `Knowledge`）：15 张卡、稳定 id 与 `EXPLANATION_VERSION = 1`，目录 / 单卡 / 正文 / 解释码映射全部 `Object.freeze`。点名六张齐备——能力与意愿（`card-capacity-vs-willingness`）、应急金上限（`card-emergency-fund`）、容忍带（`card-tolerance-band`）、新增资金优先（`card-new-funds-first`）、汇率风险（`card-fx-risk`）、为何不默认卖出（`card-no-sell`）；另有 `card-lower-bound-rule`、四张硬封顶题卡与 horizon / experience / knowledge / drawdown 四张意愿题卡、`card-formal-gate`，使 `Domain.RISK_QUESTIONS[].explainKey`、硬封顶 `explainKey`/code 与 `RECOMMENDATION_EXPLAIN_CODES` 全量可解（`resolve` id 优先、解释码其次，未知返回 null）。`getCard` 用 `hasOwnProperty` 判断，原型链名字一律降级为 null。

页面侧（`js/app.js`）：`knowledgeLinkHtml(id, label)` 只对已知 id 渲染 `know:open` 入口（未知 id 或模块未加载时不渲染），`know:open` 打开时二次校验，未知 id 显示「没有编号为…的知识卡」并停止——显式降级、不展示解释、不给判断。五处挂载全部落在 5E-1～5E-3 已消费的首页与目标页：风险摘要「取较低一侧」、硬封顶行（按服务端 `explainKey` 各自链接）、配置对照「容忍带端点含入」、归因口径说明、建议「排序依据 / 默认不卖出」。卡片页脚展示解释版本并声明「不含你的账户事实，也不构成投资建议」。零 Domain / API / Store / 分配算法 / 建议写入改动，schema 仍 v10；`APP_VERSION` 与 SW 缓存键升至 `2.4.18-phase5e4`，`sw.js` ASSETS 增列 `./js/knowledge.js`，wiring 脚本参数升至 `?v=5e4`。

退出证据：全量 `node --test` **627/627**（619 基线 + 新增 `tests/knowledge.test.js` 8 例：必过六卡、结构与 id 稳定清单、文案边界词面断言、explainKey / 解释码全量可解、未知 id / 原型链名字降级、目录冻结）；浏览器 wiring 全量 **30/30 × 2**（18643、18644 两个全新隔离临时库与 loopback origin，2026-09-25 连续两轮全绿，干净 Chromium profile）。新增 wiring 检查覆盖已知 id 打开（标题 / 解释版本 / 不构成建议 / 无外部链接 / 无收益承诺）与未知 id 显式降级；C9.4、C9.5、C7.11 与归因检查分别断言四处真实挂载点存在且 `assertKnowLinksResolve` 保证页面入口只指向已知卡。`node --check` 与 `git diff --check` 通过。边界：无云端 AI、无网络请求、无收益承诺、无具体证券代码或买卖建议（`tests/knowledge.test.js` 词面守护）；知识卡版本不倒填历史建议，解释版本的封存 / 标注契约留给 5E-5（D-051）。下一入口为 5E-5。

## 5E-5 完成记录（2026-09-26，`2.4.19-phase5e5`）

交付：建议详情新增审计追溯区（`js/app.js` 的 `adviceResultBlock`，`data-advice-trace`），四组字段只搬运库中记录——月结基准（`data-advice-trace-baseline`：月结 id、快照 id、`snapshotPayloadHash`、数据截止，写明「月结快照是基准，不等同于计算输入」）、计算日输入（`data-advice-trace-input`：判定日、完整 `inputHash`、算法 `cash-reallocation-v1`）、版本与记录（`data-advice-trace-versions`：建议 id、`payloadHash`、规则 / 目标 / 评估 / 目标 id 版本引用）、解释版本（`data-advice-explain-seal`：封存状态、封存版本、当前知识卡版本）。新建议由服务端在 `POST /recommendations` 打章（`server/api.js` 取 `Knowledge.EXPLANATION_VERSION` 写入 `gate.explanationVersion`）；`js/domain.js` gate 键集显式化为 `['checks','capture','explanationVersion']`（checks 必需，其余可选；版本必须非空非空白字符串），顶层 `RECOMMENDATION_RECORD_KEYS` 保持 5D 冻结 20 键，schema 仍 v10 零迁移；`server/repository.js` 在重复判定前剥掉来件 gate 的 `explanationVersion`，同一输入幂等回到原行且历史记录永不补章。页面对未封存旧建议显式标「当前卡片解释，非生成时封存版本」（封存版本留空、当前卡片版本照常显示），对已封存建议标「本条建议生成时封存」。兼容契约与回归范围见 **D-052**；`APP_VERSION` 与 SW 缓存键升至 `2.4.19-phase5e5`，wiring 脚本参数升至 `?v=5e5`。

测试过程中修正了 `tests/server-phase5e5.test.js` 四处断言缺陷（幂等断言误用 `stampedId.slice(4)` 当完整 inputHash、recordKeys 断言自引用、gate 判定未区分「gate 通过后死在 result 校验」与「gate 拒绝」、读取视图 `payloadHash` 被误当记录键），均为测试自身问题，未改产品逻辑。

退出证据：全量 `node --test` **631/631**（619 基线 + 知识卡 8 例 + 新增 `tests/server-phase5e5.test.js` 4 例：gate 键契约合法性矩阵、打章与计算身份不变、全量恢复旧记录、同一输入幂等不补章）；浏览器 wiring 全量 **31/31 × 2**（18661、18662 两个全新隔离临时库与 loopback origin，2026-09-26 连续两轮全绿，干净 Chromium profile，Playwright headless，证据 `docs/evidence/phase5e5-wiring.txt`）。C7.11 扩展逐属性核对追溯四组字段 = 库中记录；新增第 31 项检查覆盖剥章旧记录 `invalidCount=0`、重复生成 `created=false` 回原行、未封存标注、第三次生成仍不倒填。`node --check` 与 `git diff --check` 通过。边界：`inputHash` 仍只绑定 capture，打章前后 id / 哈希 / capture 逐位不变可按原 capture 重放；无 capture 旧记录仍按 5D 口径计入 `invalidRecords`；不改分配算法、建议写入算法、5A 冻结规则、目标 API、映射。未闭合项仍见 `TEST.md` 的稳定性观察（交 5E-6）。下一入口为 5E-6。

## 5E-6 完成记录（2026-09-27，`2.4.20-phase5e6`）

交付：`tests/app-wiring.js` 新增 3 项检查（全量 31 → 34，`tests/app-wiring.html` 参数升至 `?v=5e6`），补齐十态中未覆盖的四态并完成 S5.1–S5.3 三层复核与一分钟理解演练。

- **状态矩阵检查**：无正式月结（客户端 `runAdvice` 拒绝，文案引导先结账，零建议行）→ 建立当月正式月结 → 0 元正式建议（`data-advice-status=formal`、六类 `data-allocated` 全 0、API 侧 `allocatedTotal + roundingNote.unallocatedMinor = allocatable` 守恒）→ 分类未确认（只翻转未映射但有持仓的 `theme_equity` 为 `suggested`，映射引用的 voo/vgt 保持 confirmed 以免 PUT 被 422 拒绝；估算 + `[data-blocker="classification_unconfirmed"]` + `formalRecommendation 为空`）→ 行情过期（每标的只留一条报价避免重复键、staleDay = today-7 > `MAX_STALE_DAYS=5`、汇率同日过期；估算 + `quote_stale`/`fx_stale`，决策台 `.dash-blockers` 点名「行情已过期 / 汇率已过期」、新增资金卡标估算不标正式口径）→ 行总账 3 行（1 正式 + 2 估算）、`invalidCount=0`、估算行各带稳定 blocker 码。
- **三层复核检查**（同 fixture E6，先离线用 `sim5e6.cjs` 在真实隔离服务上预演通过再进浏览器）：S5.1 领域 `Domain.scoreRiskAnswers(answers)` == `GET /risk-assessments/current` 记录逐字段（capacity 5→L2 < willingness 12→L5、上限 2、来源 `capacity`、硬封顶 0、ruleVersion 相等），页面 `[data-risk-summary]` 与领域一致（「取较低的一侧」「高意愿不能覆盖低能力」、能力/意愿分数、`know:open` 指向 `card-capacity-vs-willingness`）；S5.2 从原始状态独立重算（`selectCurrentAssessment → selectCurrentTarget → computeOverview → computeAllocationDeviation → computeNewFundsAllocation → checkApprovedMapping/mapAllocationToApprovedInstruments → buildRecommendationResult`）与库中建议的 `categoryAllocations` / `explainCodes` / `roundingNote` / `deviations` 逐字节相等，页面类别行 `data-allocated` == 重算值，7 项 gate 与 `Domain.RECOMMENDATION_GATE_CHECKS` 集合相等且全部 passed，宽基偏离 -985bps 页面 == API == 领域且 < 0，正式建议把请求的 2,000 元全部补进宽基；S5.3 追溯四组字段与记录逐项一致。决策台风险摘要卡与配置对照卡逐字段 == `GET /targets/current`。
- **一分钟理解演练**：`JSON.stringify(GET /overview) == JSON.stringify(Domain.computeOverview(state.assets))` 整对象相等；净资产 / 可投资 / 主要风险暴露（现金 51.5%）/ 新增资金方向（宽基 -985bps → 补宽基）四问在决策台各一步可读并与 API 同源；观察值以 `DRILL:` 写入两轮运行日志（数值见下）。演练记录观察值，不宣告 Phase 7 真实使用指标通过。
- **十态闭合方式**：空资产 147/188、首次评估 1271、待复评四态 2083、无目标 2287、无认可标的/正常建议 1619 为既有检查（本项引用其结论不重证），无正式月结/0 元/分类未确认/行情过期由新增检查覆盖。
- **产品侧唯一改动**：`server/api.js` 的 `GET /api/v1/overview` 判定日与其余端点统一走可注入 `ctx.today`（原先直用服务端本地日，注入固定时钟时与 `/targets/current` 的 blocker 集合错位；由 5C 测试在 fixture 日期与自然日漂移超过 5 天后确定性失败暴露）。生产进程不注入 `ctx.today`，行为不变；回归网为 `tests/server-phase5c.test.js:334` 的 blocker 集合逐字相等断言。口径见 **D-053**。

退出证据：全量 `node --test` **631/631**（无增删用例；`server-phase5c.test.js:334` 在修复后确定性通过）；定向 5C/5D/5E **28/28**；记账/导入回归（parsers/csv/dedup/money/backup/server-api）**79/79**；`node --check`（app/sw/api/app-wiring）与 `git diff --check` 通过；浏览器 wiring 全量 **34/34 × 2**（18673、18674 两个全新隔离临时库与 loopback origin，2026-09-27 连续两轮全绿，干净 Chromium profile，Playwright headless，证据 `docs/evidence/phase5e6-wiring.txt`，含两轮一致的 `DRILL:` 观察值）。演练观察值：①净资产 1,470,000.00；②可投资 970,000.00；③主要风险暴露 现金 500,000.00（占可投资 51.5%）；④宽基权益偏离 -985bps → 本月可新增 500,000.00 中请求的 2,000 元已全部补宽基。

判定：**5E-6 通过，5E 六项全部闭合，整个 Phase 5 整体验收通过**。5E-1 起的 4D/4E/5C 旧用例偶发观察项在 5E-6 期间 7 轮 wiring（18663、18664、18665、18671、18672、18673、18674）未复现，断言未改，按观察关闭。边界：不改分配算法、建议写入算法、5A 冻结规则、目标 API、映射，schema 仍 v10 零迁移；Phase 5 通过不等于 4A 数据源门禁、S2.3 实机验证、Phase 7 计时或整个 MVP 通过；Phase 6 状态机未开始。
