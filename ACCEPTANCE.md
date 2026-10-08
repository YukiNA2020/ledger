# Ledger v3 验收规格

> 版本：v3 MVP 冻结稿  
> 用途：定义“做完”的可观察证据。执行 Agent 必须使用虚构数据完成自动化与人工验收，不得把真实财务数据写入仓库、日志或外部服务。

## 最新计划（2026-09-29）

**6A「规则与契约」已于二次复测修正后完成**：权威文本 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md)，决策 D-057，零业务代码、零迁移、零页面；§8 已按冻结口径更新（2026-09-29 首轮六处及二次复测四组实现口径冲突，见契约头部与 D-057 勘误）。**6B、6C、6D 已于 2026-09-29 相继完成**：6B 状态机/存储/API（`2.4.24-phase6b`，49 有序对全遍历）、6C 决定与待执行页面（`2.4.25-phase6c-fix2`）、6D 实际交易关联与确认执行（`2.4.25-phase6d`，全量 686/686、wiring 37 项 × 3 轮、`browser-review.py` 37 项、三档宽度 68 项，证据 `docs/evidence/phase6-6d-20260929/`）。**6E-1 复盘计算与封存、6E-2 复盘页面与月度历史已于 2026-09-30 完成**（`2.4.26-phase6e`，全量 692/692、wiring 38 项 × 3 轮、`browser-review.py` 38 项、三档宽度 66+5 项，证据 `docs/evidence/phase6-6e-20260930/`）；**6E-3 G5-R4 真人计时已于同日通过**（变体 C 数据 4/4 全对、自报计时 35 秒 ≤60 秒，记录 `docs/evidence/phase6/6e-r4.md`）。下一入口 **6F 最终集成验收**；[拆解文档](./PHASE6_BREAKDOWN.md) 定义逐项任务。G5-R4 仍是 6F 最终验收必过项。以下较早截面保留历史证据，不定义当前任务顺序。

## 当前验收截面（2026-09-28 补口进展）

2026-09-28 Phase 6 前桌面改版：`2.4.22-desktop-blue` / schema v10（零迁移）。桌面 1440px 与窄屏 390px 实际浏览器检查通过；桌面 10 个、窄屏 5 个导航页面均能渲染且无横向溢出或页面异常；全量 `node --test` **648/648**，完整浏览器 wiring **34/34**，G5-R1～R3 的反例复验保持通过，断网知识卡可点击。样式、导航位置与决策台布局变化不改变任何计算、门禁或写入。截图与日志见 `docs/evidence/desktop-redesign-20260928/`；浏览器附加审计见 `docs/evidence/phase5-review-20260927/browser-18812.json`。G5-R4 状态不变。

2026-09-28 Phase 5 验收补口：**G5-R1～R3 已修复并通过原反例复验；G5-R4 实际计时仍未完成 → Phase 5 仍不判定为完整验收通过，Phase 6 未开始。** 版本 `2.4.21-phase5g5` / schema v10（零迁移）。

| 缺口 | 判定 | 证据 |
|---|---|---|
| G5-R1 不可变引用一致性 | ✅ 通过 | `validateRecommendationReferences` 交叉比对 `assessmentId` / `targetId` 与 `gate.capture` 同 id 记录，冲突 400 + 事务回滚；+5 用例；`reference-review.cjs` **5/5、exit 0** |
| G5-R2 变更后旧建议显示 | ✅ 通过 | `Domain.adviceStaleness` 身份比对 → 页面 `data-advice-status="stale"`，不再显示「全部门禁通过」；`factsEpoch` 守卫慢请求；+12 用例；`mappingRevocationProbe` / `staleQuoteProbe` 转绿 |
| G5-R3 服务不可达知识入口 | ✅ 通过 | 风险摘要 / 配置对照 / 启动失败三处真实 `know:open` 入口；断网重载 `knowledgeEntryCount=2` 且真实点击打开正文 |
| G5-R4 四问理解实际计时 | ⏸ **未通过** | 无受测者、起止时间、耗时与正确率记录；2026-09-28 尝试时受测者正式账本为空，按用户决定延后 |

回归实测（2026-09-28）：全量 `node --test` **648/648**、受影响定向 **87/87**、记账/导入回归 **79/79**、两套干净浏览器 18785×2 + 18786 **34/34 且三项审计探针全绿**（外部请求 0）、`node --check` + `git diff --check` 通过。修复方式与复验明细见 [PHASE5_REVIEW.md](./PHASE5_REVIEW.md) §8。

### 此前截面：2026-09-27 独立复核（保留历史证据，R4 结论仍未被推翻）

2026-09-27 全阶段独立复核：**Phase 5 暂不通过完整验收，当前任务为 Phase 5 验收补口（G5-R1～R4），Phase 6 未开始。** 版本仍 `2.4.20-phase5e6` / schema v10，产品代码未改。全量 631/631、定向 142/142、记账/导入 79/79、原 wiring 34/34 × 2 均通过，但独立补测复现两项 P1（恢复引用不一致、当前事实变化后仍显示旧正式建议）及离线入口缺口；一分钟理解缺少实际计时。以 [Phase 5 全阶段独立验证](./PHASE5_REVIEW.md) 为当前结论。

### 此前集成验收截面（保留历史证据，不作为当前完成状态）

**5E-6 整体验收通过，5E-1～5E-6 全部闭合，Phase 5（风险问卷与配置建议）整体验收通过。** 版本 2.4.20-phase5e6 / schema v10。全量 631/631（无增删用例），定向 5C/5D/5E 28/28，记账/导入回归 79/79，浏览器 wiring 34/34 × 2（全新隔离临时数据库 / origin：18673、18674，2026-09-27；此前 5E-5 为 631/631 + 31/31 × 2（18661、18662），5E-4 为 627/627 + 30/30 × 2（18643、18644、18651），原 18641、18642、18631、18632 等为历史证据）。5E-1～5E-6 的逐项结论见下文「Phase 5E-1」～「Phase 5E-6」各表与 [PHASE5E_BREAKDOWN.md](./PHASE5E_BREAKDOWN.md)；R-01～R-06、失败反例与兼容边界见 [PHASE5D_ACCEPTANCE_GAPS.md](./PHASE5D_ACCEPTANCE_GAPS.md)。下方旧日期的验收数字/范围是相应阶段历史截面；当前 recommendations API 已实现，不能把 5C 当时的 501 当成当前行为。

本轮锁定：十态端到端全部闭合——空资产、首次评估、待复评、无目标、无正式月结、行情过期、分类未确认、无认可标的、0 元、正常建议（既有检查 + 新增状态矩阵检查，见下节）。S5.1～S5.3 整体验收通过：领域评分 == API 记录 == 页面风险摘要（capacity 5→L2 < willingness 12→L5，上限 2，取较低一侧）；从原始状态独立重算的 `categoryAllocations` / `explainCodes` / `roundingNote` / `deviations` 与库中建议逐字节相等且页面 == 重算，7 项 gate 与领域检查集合相等且全过；追溯四组字段 == 记录；`GET /overview` == `Domain.computeOverview` 整对象，首页四问（净资产 / 可投资 / 主要风险暴露 / 新增资金方向）与 API 同源，一分钟理解演练观察值记录于 `docs/evidence/phase5e6-wiring.txt`（不宣告 Phase 7 真实使用指标通过）。5E-1 起的 4D/4E/5C 旧用例偶发观察项在本项 7 轮 wiring 未复现，断言未改，按观察关闭。4A 数据源、S2.3 实机启动及 Phase 7 计时不因此视为通过；Phase 6 状态机未开始。

### Phase 5E-6 整体验收（2026-09-27，`2.4.20-phase5e6`）

| 场景 / 门禁 | 方法 | 结果 | 说明 |
|---|---|---|---|
| 无正式月结 | wiring 新增检查 1 步骤 1 | ✅ | 客户端 `runAdvice` 拒绝，文案「本机还没有可引用的正式月结，请先完成月度结账」，不出现建议结果卡，建议行总数 0 |
| 0 元 | 同上步骤 2 | ✅ | 当月正式月结后 0 元生成 `formal` 建议；`data-advice-requested/allocatable/allocated` 全为 0，六类 `data-allocated` 合计 0；API 侧 `allocatedTotal + roundingNote.unallocatedMinor = allocatable` 守恒、`result.status=formal` |
| 分类未确认 | 同上步骤 3 | ✅ | 只翻转未映射但有持仓的 `theme_equity` → `suggested`（映射引用的 voo/vgt 保持 confirmed，整份状态 PUT 不被 422 拒绝）；建议为 `estimate`，展示 `classification_unconfirmed` blocker、「估算建议（未达正式门槛）」、「formalRecommendation 为空」，不出现「正式建议」标题 |
| 行情过期 | 同上步骤 4–5 | ✅ | 每标的单条报价 + 单条汇率，价格日 = today-7（> `MAX_STALE_DAYS=5`）；估算建议带 `quote_stale` + `fx_stale`、无 `classification_unconfirmed`；决策台 `.dash-blockers` 点名「行情已过期 / 汇率已过期」，净资产卡仍在，新增资金卡标估算、不出现「正式口径」 |
| 行总账与读取复核 | 同上步骤 6 | ✅ | 3 行产物（1 正式 + 2 估算）、`total=3`、`invalidCount=0`，两条估算行各带稳定 blocker 码 |
| S5.1 上限取较低一侧 | wiring 新增检查 2 | ✅ | 领域 `scoreRiskAnswers` == `GET /risk-assessments/current` 逐字段（能力 5→L2 < 意愿 12→L5、上限 2、来源 capacity、硬封顶 0、ruleVersion）；页面 `[data-risk-summary]` 数值与领域一致，「取较低的一侧」「高意愿不能覆盖低能力」与知识卡入口 `card-capacity-vs-willingness` 齐备 |
| S5.2 分配与解释码三层相等 | 同上（独立重算 + 页面 DOM） | ✅ | 重算产物与库中建议逐字节相等；页面类别行 `data-allocated` == 重算；7 项 gate == `Domain.RECOMMENDATION_GATE_CHECKS` 且全部 passed；宽基偏离 -985bps 页面 == API == 领域且 < 0；正式建议把请求的 2,000 元全部补进低配宽基 |
| S5.3 可追溯 | 同上 | ✅ | 追溯四组字段（基准 / 输入 / 版本记录 / 解释版本）与记录逐项一致；决策台配置对照卡六类逐字段 == `GET /targets/current`，`canAdvise=1` |
| 十态其余六态 | 既有检查（147/188、1271、2083、2287、1619）+ 本轮全量执行 | ✅ | 空资产、首次评估、待复评四态、无目标、无认可标的、正常建议在本轮 34 项内全部实际通过 |
| 一分钟理解演练 | wiring 新增检查 3（`DRILL:` 日志，两轮一致） | ✅ | ①净资产 1,470,000.00；②可投资 970,000.00；③主要风险暴露 现金 500,000.00（占可投资 51.5%）；④宽基 -985bps 低于目标区间 → 本月可新增 500,000.00 中请求的 2,000 元已全部补宽基；`GET /overview` 与领域重算整对象逐字节相等；只记录观察值，不宣告 Phase 7 通过 |
| 浏览器 wiring 全量 | `tests/app-wiring.html`（`?v=5e6`，隔离临时服务） | ✅ **34/34 × 2** | 18673、18674 两个全新临时库与 origin，干净 Chromium profile 连续两轮全绿；见 `docs/evidence/phase5e6-wiring.txt` |
| 稳定性观察项关闭 | 4D 自动更新汇率开关 / 4E 收益归因 / 5C 认可标的候选下拉 | ✅ | 本项期间 7 轮 wiring（18663～18674）全部通过、未复现；只观察记录，未改断言换取绿色 |
| 产品修复（判定日时钟） | `server/api.js` `GET /overview` | ✅ | 与其余端点统一走可注入 `ctx.today`，生产行为不变；回归网 `tests/server-phase5c.test.js:334`；见 D-053 |
| 全量与回归 | `node --test` | ✅ **631/631** | 定向 5C/5D/5E 28/28；记账/导入回归 79/79；`node --check` 与 `git diff --check` 通过 |
| 范围边界 | 本轮 diff | ✅ | 不改分配算法、建议写入算法、5A 冻结规则、目标 API、映射，schema 仍 v10 零迁移；`APP_VERSION` 与 SW 缓存键 `2.4.20-phase5e6` |

**Phase 5 判定：整体验收通过。** 5E-6 是 Phase 5 唯一有权做此判断的一步，本节即该判断的证据。MVP 是否整体通过仍取决于未完成的 4A 数据源门禁、S2.3 实机验证与 Phase 7 两个月真实验证；Phase 6 的接受/暂缓/执行/复盘状态机未开始。

### Phase 5E-5 审计追溯（局部验收，2026-09-26，`2.4.19-phase5e5`）

| 场景 | 方法 | 结果 | 说明 |
|---|---|---|---|
| 月结基准与计算输入分开陈述 | wiring C7.11 `data-advice-trace-baseline` / `data-advice-trace-input` | ✅ | 基准组显示月结 id、快照 id、`snapshotPayloadHash`、数据截止并写明「月结快照是基准，不等同于计算输入」；输入组显示判定日、完整 `inputHash`、算法 `cash-reallocation-v1`；两组字段逐项等于库中记录，不用月结哈希冒充计算输入 |
| 版本与记录可核对 | 同上 `data-advice-trace-versions` | ✅ | 建议 id、`payloadHash`、`ruleVersion`、目标版本、评估 / 目标 id 与 `GET /recommendations` 读取视图逐项一致 |
| 新建议封存解释版本 | wiring C7.11 + `tests/server-phase5e5.test.js` | ✅ | POST 打章于 gate 区；页面标「本条建议生成时封存」，封存 / 当前版本均等于 `Knowledge.EXPLANATION_VERSION`，不出现未封存标注 |
| 封存不进计算身份 | server-phase5e5 打章用例 | ✅ | 打章前后 `inputHash` / `id` / `capture` 逐位不变，仍可按原 capture 重放；顶层 recordKeys 保持 5D 冻结 20 键 |
| 旧建议未封存显式标注 | wiring 新增第 31 项检查 | ✅ | 全量状态剥章写回后记录仍 `invalidCount=0`；页面标「当前卡片解释，非生成时封存版本」，封存版本留空、当前卡片版本照常显示 |
| 重复生成绝不倒填 | 同上（`created=false` + 第三次生成） | ✅ | 同一输入幂等回到原行，响应与库中记录均无 `explanationVersion`，总条数恒为 1 |
| gate 键契约与兼容 | server-phase5e5 合法性矩阵 | ✅ | `{checks}` / `{checks,capture}` / `{checks,capture,explanationVersion}` 全通过；多余键、非字符串 / 空白版本、缺 checks 拒绝；无 capture 旧记录仍计入 `invalidRecords` |
| 浏览器 wiring 全量 | `tests/app-wiring.html`（`?v=5e5`，隔离临时服务） | ✅ **31/31 × 2** | 18661、18662 两个全新临时库与 origin，干净 Chromium profile 连续两轮全绿；见 `docs/evidence/phase5e5-wiring.txt` |
| 范围边界 | 本轮 diff | ✅ | 零分配算法 / 建议写入算法 / 5A 规则 / 目标 API / 映射改动，schema 仍 v10、零迁移；`APP_VERSION` 与 SW 缓存键 `2.4.19-phase5e5` |
| 全量回归 | `node --test` | ✅ **631/631** | 619 基线 + 8 知识卡 + 4 个 5E-5 用例 |

5E-5 只完成 `PHASE5E_BREAKDOWN.md` 的第 5 项；整个 Phase 5 的端到端三层复核与退出门禁仍待 5E-6，不得据本节宣布 5E 或 MVP 已验收。

### Phase 5E-4 本地知识卡（局部验收，2026-09-25，`2.4.18-phase5e4`）

独立复测：全量 Node 627/627；全新隔离临时库浏览器 wiring 30/30（18651）。在生产首页（非 `/tests/` harness）确认 Service Worker 缓存包含 `js/knowledge.js` 与首页缓存壳，浏览器断网后重载仍可打开 `card-fx-risk`，显示解释版本 1 与“不构成投资建议”声明。离线实测步骤和结果见 `docs/evidence/phase5e4-offline.txt`。

| 场景 | 方法 | 结果 | 说明 |
|---|---|---|---|
| 必过六张卡存在 | `tests/knowledge.test.js` | ✅ | 能力与意愿、应急金上限、容忍带、新增资金优先、汇率风险、为何不默认卖出；id 与键一致，标题与正文段落完整 |
| 稳定 id 与版本 | 同上（`cardIds` 深比对 + `EXPLANATION_VERSION`） | ✅ | 15 张卡 id 只增不改名；版本为非空字符串，与 `APP_VERSION` 独立 |
| 每个引用 id 可解 | 同上 | ✅ | 题卡 / 硬封顶 `explainKey` 与 code、`RECOMMENDATION_EXPLAIN_CODES` 全量 `resolve` 非 null |
| 未知 id 显式降级 | 同上 + wiring 新增检查 | ✅ | `getCard` 返回 null（含 `constructor`/`__proto__`）；打开未知 id 显示缺卡提示，不渲染任何卡片正文 |
| 离线可读、无云端 AI | 同上（词面）+ wiring | ✅ | 卡片正文无 http 链接、无网络请求、无云端 AI 字样 |
| 无收益承诺、无具体股票建议 | 同上（词面） | ✅ | 无保本/稳赚/保证收益、无「建议/推荐买入」类动作、无证券代码 |
| 页面只链接已知卡 | wiring `assertKnowLinksResolve`（C9.4/C9.5/C7.11/归因） | ✅ | 四处真实挂载点入口全部指向已知卡；未知 id 不渲染入口 |
| 卡片页脚边界声明 | wiring 打开卡片断言 | ✅ | 显示「解释版本 N」与「不构成投资建议」，并断言无收益承诺词 |
| 浏览器 wiring 全量 | `tests/app-wiring.html`（`?v=5e4`） | ✅ **30/30 × 2** | 18643、18644 两个全新临时库与 origin，干净 Chromium profile 连续两轮全绿 |
| 范围边界 | 本轮 diff | ✅ | 零 Domain / API / Store / 算法 / 规则 / 映射 / 5E-5 字段改动，schema 仍 v10 |
| 全量回归 | `node --test` | ✅ **627/627** | 619 基线 + 8 个新增用例 |

### Phase 5E-3 建议解释（局部验收，2026-09-24）

独立复核（`2.4.17-phase5e3`）：高配类别的服务端分配 0 元现可见为 0.00，避免旧版「—」与缺失值混淆；浏览器逐类别核对可见金额、保证 fixture 确有高配类别，并严格检查估算态不含正式建议标题。全量 619/619，干净临时库 wiring 29/29 × 2（18641、18642）。

| 场景 | 方法 | 结果 | 说明 |
|---|---|---|---|
| 类别排序依据 | wiring C7.11（`data-advice-order`） | ✅ | 低配时写「先补低于区间下限」；解释码与 `ADVICE_EXPLAIN_LABELS` 同源 |
| 现金保底 / 未分配 | `data-advice-cash-floor` | ✅ | 「保留现金配置下限」；有未分配时显示金额并说明继续留作现金 |
| 认可标的与未映射待办 | `data-advice-todos` / `data-todo` / `data-retained` | ✅ | 无映射时金额原样保留为类别级待办，明确「不转投陌生标的」，instrument-count=0 |
| 尾差 | `data-advice-rounding` / `data-leftover` / `data-receivers` | ✅ | 展示冻结排序规则原文与承接类别，data 与 API 相同 |
| 默认不卖出具体原因 | `data-advice-nosell` | ✅ | 有高配时点名类别并说明「只提示风险，不生成卖出指令」 |
| 正式 / 估算标签与 blocker | `data-advice-status` / `data-blocker` | ✅ | formal 全过门禁；估算态展示 5D 产物 blocker（如 `snapshot_hash_mismatch`），不冒充正式 |
| 守恒公式 | `Σ分配 + 未分配 = 可分配` 文案与 data 层 | ✅ | 与 API `roundingNote` 逐字段相同，页面不重算 |
| 高配为 0 | `data-basis="above_max"` 行 `data-allocated` | ✅ | 与 API `categoryAllocations` 相同 |
| 无映射不转投 | 反例：清空 `broad_equity` 映射后重算 | ✅ | `data-todo="missing_approved_instrument"`，保留金额，不指向未知标的 |
| 门禁失败只展示估算 | 模拟 `Store.createRecommendation` 返回篡改产物 | ✅ | `data-advice-status="estimate"`，blocker 码出现，不出现 `formalRecommendation` 内容 |
| 范围边界 | 本轮 diff 仅 `js/app.js`、`sw.js`、`tests/app-wiring.*` 与文档 | ✅ | 零 Domain / API / Store / 建议算法 / 建议写入改动，schema 仍 v10 |
| 全量回归 | `node --test` | ✅ **619/619** | 与 5D/5E-1/5E-2 基线一致 |
| 浏览器 wiring 全量 | `tests/app-wiring.html`（`?v=5e3`，隔离临时服务） | ✅ **29/29 × 2** | 18631、18632 两个全新临时库与 origin，干净 Chromium profile 连续两轮全绿 |

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
**Then** 当前数量为 11 份；买卖影响持仓且不重复计入收入支出，**现金侧按人工核对口径（D-034/D-042④：证券事件不自动改写现金余额单元）**；分红单独记录。  
（措辞修订说明：原文"买卖影响持仓和现金"与 D-042④ 矛盾，经第 1 轮独立复核提出、用户确认，按"现金人工核对"收口、不实现自动现金腿——G4C-1 边界化收口，见 `PHASE4C_ACCEPTANCE_GAPS.md`。）

| 验收点 | 结论 | 证据 |
|---|---|---|
| S4C.1 主链路：期初 10 → 买 2 → 卖 1 = 11 | ✅ 通过 | `tests/server-phase4c.test.js`：真实 HTTP 全链路（建账户 → manual 标的 → confirm → 期初 → 买 → 卖 → 分红），`GET /holdings` 推导 `quantity='11'`，`eventCounts` 精确；领域侧同链路见 `tests/domain-phase4c.test.js` |
| 现金侧人工核对、事件不自动改写现金（G4C-1 修订口径） | ✅ 通过 | 真实 HTTP `G4C-1 边界固化`：注入 USD 余额单元 2,000,000 → 期初 + 买 2×$5000 + 手续费 100 + 分红后，余额单元**保持 2,000,000**、`txns` 保持为空——现金余额仍由用户人工核对（D-034） |
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
| 修改期初触发越界 → 拒绝回滚（G4C-2） | ✅ 通过 | 真实 HTTP：期初 10 → 卖 8 → 更新期初为 5 → 409 `insufficient_holdings`；回滚后期初仍 10、推导仍 2、`oversellEvents` 为空（写入后在同一事务 strict 全时间线重放） |
| `PUT /state` 同键二期初 / 缺 id 期初（G4C-3） | ✅ 通过 | 真实 HTTP ×2：同（账户, 标的）两条期初 → 409 `duplicate_opening` 整体回滚零残留（曾实测 stored:2）；缺 id → 400 `invalid_id`，不静默丢弃。数据库侧 v6 唯一索引 `uq_portfolio_openings_dedupe` 兜底 |
| 期初日期边界（G4C-4，D-042 ⑦） | ✅ 通过 | 真实 HTTP：期初 10（asOf 09-06）+ 09-01 买 2 → 推导仍 10、`boundarySkippedEvents` 留痕 1 条；同日与次日买入正常叠加 → 14。领域侧 3 项（含"早于期初的卖出不参与 strict 重放"） |
| 真实日历日校验（G4C-5） | ✅ 通过 | 真实 HTTP：`2026-02-30` 事件 → 400 `invalid_event_date`；同期初 → 400 `invalid_date` |
| 备份必需列校验（G4C-6） | ✅ 通过 | v5 库删除 `security_events.amount_minor` 后 `validateBackupFile` 拒绝且原因点名缺失列（曾返回 `{"ok":true,"schemaVersion":5}`） |
| 幂等原子性与请求绑定（G4C-7） | ✅ 通过 | 同 key 同请求体正常回放；同 key 不同请求体 → 409 `idempotency_conflict` 且只保留首笔；强制幂等记录插入失败时事件事实随同一事务回滚、零残留 |
| 仅证券账户可承载持仓（G4C-8） | ✅ 通过 | `bank` 账户的期初与事件均 → 422 `invalid_account_type`；`PUT /state` 同样拒绝并整体回滚 |
| 事件往返保真（G4C-9） | ✅ 通过 | 分红的可选 quantity 与未知 `sourceRef` 经单条写入和全量往返保留；载荷伪造 HKD 被忽略、按 USD 标的推导为 USD；分红 quantity 不改变持仓 |
| 显式错误集合类型不得清库（G4C-10） | ✅ 通过 | `PUT /state` 前先写入持仓/报价/汇率各 1 条，再分别提交 `holdings:{}`、`quotes:{}`、`fxRates:{}`：均在清库前 400 `invalid_asset_collection`，随后读取仍为 1/1/1；字段缺失仍兼容旧备份并读取为空数组 |
| v6 必需索引列严格校验（G4C-11） | ✅ 通过 | 将 `uq_portfolio_openings_dedupe` 替换成同名 `UNIQUE(id)` 并制造同账户/同标的重复期初，备份校验明确因索引列不匹配而拒绝；`PRAGMA index_xinfo` 结果必须严格为 `account_id, instrument_id` 且索引不可为 partial |
| 根状态与 `assets` 形状不得绕过清库（G4C-12） | ✅ 通过 | API 与仓储双层校验：raw/wrapped `state=[]` → 400 `invalid_state`；显式 `assets=null/[]/字符串/{}` → 400 `invalid_assets`；每次拒绝后整份 `GET /state` 与基线深比较一致。只有 `assets` 字段完全缺失时按旧备份兼容为空集合 |

Phase 4C 退出证据（第三轮复核补口后更新）：当前全量 `node --test` **452/452**；4C/4D 真实 HTTP 合并 **30/30**；浏览器 wiring **21/21**；schema 停在 **v7**（本轮未新增迁移）；零真实网络请求。口径冻结见 `DECISIONS.md` D-042/D-043；复核缺口与修复状态见 `PHASE4C_ACCEPTANCE_GAPS.md`。

### S4D.1 自动更新成功

**Given** 应用打开且公开数据网络可用。  
**When** 自动更新最近有效收盘价与汇率。  
**Then** 保存价格日、抓取时间和 provider；外部请求不包含账户名、数量、成本或余额。

### S4D.2 更新失败与人工兜底

**Given** provider 超时、限额或不覆盖某标的。  
**When** 更新失败。  
**Then** 保留最后有效值并标记 stale，允许手动补价，阻止正式建议但不阻止查看估算。

**验收结论（2026-09-17）：✅ 代码验收通过（实现与自验完成，等待独立复核确认）。**

| 场景要点 | 结论 | 证据 |
|---|---|---|
| S4D.1 汇率自动更新成功 | ✅ 通过 | `tests/providers-marketdata.test.js` S4D.1 + `tests/server-phase4d.test.js` 真实 HTTP：写入 `rate_date` / `fetched_at`（来自服务端注入的 `now`，不用内部时钟）/ `provider`；`GET /fx-rates` 可直读同一行。汇率源 = Frankfurter 且 **pin ECB 端点 `/v2/providers/ecb/rates`**（D-036）；注入离线 provider 时 `provider` 以实际写入行为准、`endpoint` 为 `null`（不冒充 Frankfurter 端点） |
| S4D.1 行情自动更新成功 | ✅ 通过 | 同一批用例：保存价格日、抓取时间、provider 与 **provider 原始代码 `sourceSymbol`**（迁移 v7 列）；自动更新的 provider 不得冒充 `manual` 来源（写入被拒 `invalid_provider`） |
| S4D.1 外部请求不含账户名/数量/成本/余额（D-020） | ✅ 通过 | 编排层用例断言 provider 只收到 `['VOO']` 与 `{now, asOf}` 两个键，请求产物 JSON 内不含 `accountId` / `accountName` / `quantity` / `costMinor` / `balanceMinor`；真实 HTTP 用例断言刷新报告 JSON 内不含账户名、余额、数量与成本 |
| S4D.2 自动抓取默认关闭（D-038 门禁） | ✅ 通过 | 真实 HTTP：请求体携带 `autoQuotesEnabled` / `autoQuotes` / `marketDataAutoQuotes` / `quotesFetch` 仍返回 `skipped(auto_fetch_disabled)`，provider 调用计数为 **0**、库中零报价；开关**只从服务端 settings 读取**，不信任请求体。门禁复核结论与原始输出见 `server/providers/SOURCES.md` §8 |
| S4D.2 断网 | ✅ 通过 | provider 抛异常（DNS/连接失败）按暂时性失败处理为 `timeout`：不写库、不抛到上层，HTTP 200 + `ok:false` |
| S4D.2 超时 | ✅ 通过 | `timeout` 可重试 → 用满有限重试 `MAX_ATTEMPTS=2` 后如实报告，最后有效值（5000）不被覆盖 |
| S4D.2 限额 | ✅ 通过 | `rate_limit` 可重试，重试用尽后如实报告且不覆盖旧值（4800） |
| S4D.2 缺标的 | ✅ 通过 | `not_found` 不写入，`retryable:false` → `attempts:1`（不可重试的错误不重复请求） |
| S4D.2 节假日 | ✅ 通过 | fixture 中休市标的在 09-14/09-15 无数据，`asOf=2026-09-15` 回退到最近交易日 09-11；断言返回值绝**不晚于** `asOf`；`asOf` 早于数据起始日 → `not_found` 且零写入 |
| S4D.2 不可入账数据一律拒绝落库 | ✅ 通过 | 负价格 / 汇率 `'0'` → `invalid_payload`；provider 返回**非数组**同样判 `invalid_payload`（不当成空结果）；provider 返回**未请求的标的**显式拒绝写入（不得张冠李戴） |
| 请求结果必须绑定目标 | ✅ 通过 | 行情与汇率都先建立规范化请求键集合；未请求结果、无法绑定结果与重复键均返回逐目标 `invalid_payload`，整批不写入；汇率路径与报价路径采用同一规则 |
| provider 漏返回必须显式失败 | ✅ 通过 | 请求两个币对只返回一个时，缺失目标生成明确错误；请求一个报价返回空数组时为 `failed`，不再误报 `skipped(no_targets)`；每个 scope 恒满足 `requested = updated + skipped + errors` |
| provider 日期不得晚于 `asOf` | ✅ 通过 | `asOf=2026-09-18` 时返回 2026-09-19 的报价或汇率均判 `invalid_payload`、零写入；`fetchedAt` 仍由服务端 `now` 强制生成 |
| 顶层跳过原因与实际目标一致 | ✅ 通过 | 存在报价目标且自动结果被手动价格冻结时：`requested=1`、元素与顶层 `reason` 均为 `manual_locked`；不再误报 `no_targets`。`no_targets` 仅允许在 `requested=0` 时出现，编排层与真实 HTTP 均有断言 |
| S4D.2 手动补价兜底 | ✅ 通过 | 真实 HTTP `POST /api/v1/quotes` → 201 + `source:'manual'`（来源固定，拒绝调用方绕过）；同一元素键再次补价**替换**而不是并存，不同价格日各留一行；缺标的 400 `invalid_instrument_id`、非法价格 400 `invalid_price`、非法日期 400 `invalid_price_date`、币种冲突 422 `currency_mismatch`、未知引用 422 `unknown_instrument`，且被拒的写入零残留 |
| S4D.2 手动值不被自动值覆盖（D-044 ②） | ✅ 通过 | 报价与汇率**同一口径**：手动值所在数据日**及更早**的自动观测一律 `manual_locked`（不是只看同一天）；更新的数据日仍可写入，手动值不会被永久挡住 |
| S4D.2 元素键替换（D-044 ③） | ✅ 通过 | 同一（标的, 价格日）连续两次写入只保留 **1** 行，且取值是后写入的那一行（不依赖数据库行序）；跨 provider 一起替换。该不变量由写入路径强制，**不**提升为数据库唯一索引（理由见迁移 v7 注释） |
| S4D.2 失败不覆盖旧值 + 备份往返 | ✅ 通过 | 真实 HTTP：手动补价 + 自动汇率 → 手动备份 → 改动两条事实 → 恢复后报价回到 4992、汇率回到 7.1900，`provider` 来源标记随备份往返不丢 |
| S4D.2 Keychain 读取路径 | ✅ 通过 | `tests/server-keychain.test.js`：`readProviderKey` 真实写入→回读逐字节一致；`providerKeyStatus` 只返回 `{configured, service, error}` 且响应内**不含密钥内容**；未配置时降级为 `null` / `configured:false`（不抛错）。读取是**惰性**的：门禁关闭时一次都不读 |
| S4D.2 开关打开但 provider 未配置 | ✅ 通过 | 真实 HTTP：`settings.marketDataAutoQuotes=true` 且无可用 provider → `skipped(provider_not_configured)`，`attempts:0`，只报告 Key 是否配置，库中零写入 |
| 参数与错误语义 | ✅ 通过 | `scopes` 非数组 / 未知作用域 → 400 `invalid_scope`；`asOf` 非真实日历日（`2026-13-01` / `2026-09-31`）→ 400 `invalid_date`；请求体非对象 → 400 `invalid_json`。外部不可达一律 200 + `ok:false` + 逐作用域 `errors`（含 `retryable`），不伪装成客户端错误 |
| 浏览器最小闭环（wiring） | ✅ 通过 | `tests/app-wiring.js` 新增 3 项：① 行情区块默认不自动抓取、手动补价写入事实源并渲染价格/价格日/来源；② 启动时自动更新汇率开关默认关闭、切换可写入 `settings` 并回读；③ 刷新报告逐作用域如实提示（成功报数量、门禁未通过报原因），且不改动已登记的手动价格 |
| 离线运行 | ✅ 通过 | 4D 全部自动测试使用固定 fixture 与注入时钟，**零真实网络请求**；真实网络仅用于人工门禁取证（结论记入 `SOURCES.md` §8） |

Phase 4D 退出证据（第三轮复核补口后更新）：全量 `node --test` **452/452**；4D 编排层 fixture **27/27**、真实 HTTP **10/10**；浏览器 wiring **21/21**；数据库迁移停在 **v7**；`market-data/refresh` 不再是 501；零真实网络请求。口径冻结见 `DECISIONS.md` D-044，门禁证据见 `server/providers/SOURCES.md` §8。独立复核再次确认前不进入 4E。

### S4E.1 估值下钻与收益归因

**Given** 同一持仓有期初数量/价格、期末数量/价格和对应汇率。
**When** 查看资产类别、机构、币种、市场和收益明细。
**Then** 当前估值可下钻到数量、价格日、汇率与 provider；证券价格影响与汇率影响分别展示并可复算。

Phase 4E 退出证据（第二轮复核补口后更新）：完整持仓可正确估值；下钻合计与总览一致；**期初腿只认封存明细，读取与重算两条路径都先校验快照哈希**；结账后回填旧业务日期事实或直接篡改快照都不能产生错误归因；行情 stale 时只展示估算并阻止正式建议。

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| S4E.1 下钻合计与总览一致 | ✅ 通过 | `tests/domain-phase4e.test.js`：机构/币种合计 = 总资产、类别合计 = 投资池、市场合计 ≤ 投资池持仓，四项由 `consistency` 自报；wiring 与真实 HTTP `GET /api/v1/overview` 逐项交叉核对（总资产 / 净资产 / 投资池 / 四维合计）。构造性一致：两者共用 `valueAssetItems` 的**同一遍**估值，不是两套算法互相对账 |
| S4E.1 逐持仓可追溯 | ✅ 通过 | 追溯表逐条给出数量 / 价格 / 价格日 / provider / 汇率 / 汇率日 / provider / 折 CNY；wiring 断言页面上显示的价格日与来源**就是事实源里那一行**（`priceDate='2026-09-14'`、`provider='manual'`） |
| S4E.1 价格影响与汇率影响分别展示且可复算 | ✅ 通过 | 逐行恒等式「价格影响 + 汇率影响 = 估值变化」（汇率影响取残差，整数最小货币单位、全程无浮点）；纯价格变动与纯汇率变动各自单侧归集；wiring 在**合计**与**每一行**上分别复算该恒等式，并验证「合计 = 逐行相加」 |
| S4E.1 期初基准只认封存事实（D-045 ①⑨） | ✅ 通过（补口后加固） | 真实 HTTP：首个结账月 `attribution.unavailable='no_baseline'`、`rows` 为空（**不造「期初 0」的假基准**）；次月结账的基准 = 上一份快照，`closeId` / `month` / `asOf` / `payloadHash` 逐项对齐。**G4E-1 补口**：期初数量/价格/汇率改从快照封存的 `attributionPositions`（基准月末 as-of 口径）读取，重算前先校验快照原文 sha256 与封存哈希一致——**结账后回填 8-31 价格 40.00 与汇率 6.50，归因期初仍 5000/7.00/10 股、ΔV 40500 逐字段不变**（真实 HTTP 复现链路） |
| S4E.1 基准不可用时显式说明（D-045 ⑨） | ✅ 通过（补口新增） | 真实 HTTP 各一条：直接篡改快照 payload → `baseline_hash_mismatch`；老形状快照（无 `attributionPositions`）→ `baseline_details_missing`；两者 `rows` 均为空，绝不从当前事实表倒算期初 |
| S4E.1 决策台读取前校验快照完整性 | ✅ 通过（第二轮补口） | `GET /close-snapshots/:id` 对 `payloadJson` 原文复算 SHA-256，正常快照返回 `hashValid:true / integrityStatus:'valid'`；直接改库篡改 `attributionPositions` 且保留旧哈希后返回 `false / 'mismatch'`。前端仅接受明确的 `hashValid:true`，否则传入 `detailsUnavailable:'baseline_hash_mismatch'`、positions 为空；wiring 断言页面无归因行、无合计 |
| S4E.1 时间窗口封闭（可复算） | ✅ 通过 | 真实 HTTP：同一事实重算旧月份逐字节一致；结账之后再写入行情与证券事件，重算往期结果不变（期初腿来自封存明细、期末腿 as-of 截断） |
| S4E.1 缺数据不插值、不兜底 | ✅ 通过 | 缺期初价格 → `missing_start_quote`，只给 ΔV 不做分解；缺期初汇率 → `missing_start_fx`（封存明细里汇率缺失时），**不用 1:1、也不用期末汇率顶替**。注意「手动汇率被顶掉」场景在补口后期初汇率取**封存值**（7.00），不再是 `missing_start_fx`——封存明细齐备就是齐备（真实 HTTP） |
| S4E.1 期间有买卖 / 清仓 / 重录期初 | ✅ 通过 | `quantity_changed` / `position_closed` / `position_opened` / `opening_rebased` 逐条：给出变化额但不拆成价格与汇率（数量跳档不是收益）；回填旧日期证券事件按 D-042 ⑦ 视为已含在封存数量内 |
| S4E.1 缺汇率与未填敞口的展示口径 | ✅ 通过 | 缺汇率的持仓留在组内并计 `unvaluedCount`，不静默消失也不改合计口径；未填敞口市场进 `unspecified` 桶，不冒充任何真实市场；负债不进资产项维度，单列在 `totals` |
| S4E.1 旧快照兼容 | ✅ 通过 | 真实 HTTP：无 `attribution` / `attributionPositions` 键的旧形状快照仍可读、哈希仍可复核，归因侧显式 `baseline_details_missing`；`computeOverview` 的 `withItems` 为纯追加开关，不带开关时输出逐字段不变 |
| S4E.1 行情失败保留估算但不给正式建议 | ✅ 通过 | 归因**不新增第二套**判定：缺行情时沿用既有 `quote_missing` 阻塞（真实 HTTP），过期时只写 `notes`，`canAdvise` 仍由 `computeOverview` 独占 |
| S4E.1 确定性 | ✅ 通过 | 归因是纯函数、不改动任何事实（`stateBefore` 深比较一致）；相同输入必然得到相同输出 |
| S4E.1 与决策台当前估值同口径 | ✅ 通过 | 现在时点（无未来日期事实）下，归因的期末腿与决策台当前估值**逐分一致** |
| 浏览器最小闭环（wiring） | ✅ 通过 | `tests/app-wiring.js` 归因场景：基准取自已结账月快照、切换基准后按新基准**的封存明细**重算，恒等式在合计与逐行上都成立；回填旧日期价格后期初价格日期仍等于封存值；新增完整性反例：服务端报告 mismatch 后页面显示告警且归因行/合计均为 0 |
| 离线运行 | ✅ 通过 | 4E 全部自动测试使用注入时钟与固定 fixture，**零真实网络请求**；不接新数据源、不新增迁移 |

Phase 4E 退出证据（第二轮复核补口后更新）：全量 `node --test` **486/486**、4E 定向 **34/34**，非沙箱实跑；浏览器 wiring **24/24 × 2 轮干净环境**；数据库迁移停在 **v7**（零新迁移、零新数据源）。口径冻结见 `DECISIONS.md` D-045 ①–⑨；复核结论与逐条修复状态见 `PHASE4E_ACCEPTANCE_GAPS.md`。独立复核再次确认前不进入 Phase 5。

## 7. Phase 5｜风险与新增资金建议

### Phase 5A｜规则冻结验收（2026-09-20，`2.4.6-phase5a`）

**最终结论：Phase 5A 通过，可进入 5B。** G5A-8/9 已独立确认；最终复核又发现并闭合 G5A-10/11/12：当前 `targetVersion` 只接受该等级唯一冻结模板，`newFundsMinor` 只接受非负安全整数，未来评估日返回 `invalid_assessment_date`。当前 5A 定向 33/33、全量 519/519、浏览器 wiring 24/24 × 2。

第四轮复核发现的 G5A-7 已补口：认可标的数组只接受普通稠密自有数据索引，异常原型稳定 fail closed。当轮 5A 定向 27/27、全量 513/513；后续完整复核已确认闭合。

第三轮复核发现的 G5A-6 已在 `2.4.3-phase5a` 补口：认可标的映射只读取自有类别，任何自定义原型均 fail closed。当轮 5A 定向 26/26、全量 512/512；后续复核已确认对象层闭合。

Phase 5 拆为 5A–5E（见 [`PHASE5_BREAKDOWN.md`](./PHASE5_BREAKDOWN.md)）。5A 只冻结规则与领域契约，**零迁移、零 API、零页面**。口径见 `DECISIONS.md` **D-046**；规则数据与纯契约函数在 `js/domain.js`，冻结副本在 `tests/fixtures/phase5-risk-rules.json`。

**第 1 轮独立复核结论为「暂不通过」**（G5A-1 P0 / G5A-2 P1 / G5A-3 P1，原文见 [`PHASE5A_ACCEPTANCE_GAPS.md`](./PHASE5A_ACCEPTANCE_GAPS.md)）。补口已实现并提交（`2.4.1-phase5a`）：规则常量**递归冻结**、`targetVersion` 必须是当前可用版本、目标模板类别与 `RISK_CLASSES` **精确相等**；三条都补了「改回旧实现即红」的反例，状态为**「补口完成，等待独立复核确认」**。

第二轮复核确认 G5A-1/2/3 闭合后新发现 G5A-4/5；现已补齐模板元数据校验和建议输入/引用对象精确白名单，等待再次独立复核。实测：全量 `node --test` **511/511**、5A 定向 **25/25**（非沙箱）、schema 停在 **v7**、零真实网络请求。

| 场景 | 5A 层状态 | 5A 证据 | 正式验收 |
|---|---|---|---|
| S5.1 能力约束意愿 | 规则侧已锁定 | `tests/domain-phase5a.test.js` 5A-8（fixture 样例）：高意愿（意愿 12 → L5）+ 应急金不足 + 收入不稳定 → 上限取能力侧 L2，三个硬封顶逐条列出；5A-19 补口反例：规则常量被原地改写后评分与查表必须不变 | 5B（领域 + 真实 HTTP + 浏览器三层） |
| S5.2 新增资金优先 | 契约与排序 / 尾差规则已冻结 | 5A-16 输出契约与稳定排序规则；5A-20 补口反例：未知 `targetVersion` 不得作为建议输入；fixture `samples.S5_2` 记录 CNY 2,000 样例与期望（优先补宽基权益、金额守恒、无卖出），`verifiesIn: 5D` | 5D |
| S5.3 数据门槛 | 门槛条件已枚举，门禁实现在既有 blocker 之上 | fixture `samples.S5_3` 列出 `quote_stale` / `classification_unconfirmed` / `close_incomplete` / `baseline_hash_mismatch` / `assessment_expired` 五个触发条件与「正式建议为空」期望，`verifiesIn: 5D` | 5D |
| 目标模板合法性（5A 内部） | 唯一冻结模板已锁定 | 5A-21/23/28 拒绝额外类别、错等级/版本、原型链与访问器；5A-31 进一步拒绝同版本下另一套虽自洽但未登记的比例；内置五级模板副本全部通过 | 5C ✅ 已复核（5C-1 逐字段比对冻结 fixture；5C-4 拒绝同版本偷换比例） |

**5A 的规则与契约层验收已通过**；S5.1 的持久化/API/UI 闭环仍由 5B 承载，S5.2–S5.3 的建议算法与正式门禁仍由 5D 承载，不能把 5A 通过误写成整个 Phase 5 已完成。

### Phase 5B｜风险评估与复评机制验收（2026-09-21，`2.4.7-phase5b`）

**最终结论：Phase 5B 通过，可进入 5C。** 5B 把 5A 冻结规则落成追加式风险评估事实：schema v8 新增 `risk_assessments`；服务端只接受原始答案、评估日和复评原因，并重算双评分、等级、硬封顶、风险上限与到期日；历史不覆盖，当前评估按确定性顺序选出。

| 验收点 | 结果 | 证据 |
|---|---|---|
| 领域确定性与 S5.1 | ✅ 通过 | `tests/domain-phase5b.test.js` **18/18**：相同答案与规则版本逐字段相同；高意愿不能突破低能力；硬封顶只降不升；边界、缺答、未知题目/选项、重复回答、未来日期、规则错配均 fail closed |
| 服务端重算与隐私边界 | ✅ 通过 | `tests/server-phase5b.test.js`：客户端伪造分数/上限/到期等派生字段均 400，未知输入原文不进入错误消息；落库值逐字段等于服务端领域函数重算结果 |
| 追加历史、幂等与当前评估 | ✅ 通过 | 同 key 同载荷回放不追加，同 key 不同载荷 409；复评产生新 id 且旧行保持原样；有效期到期日当天有效、次日过期，空态区分 `no_assessment/all_expired/invalid_records` |
| 读取即复核 | ✅ 通过（第二轮补口） | 直接篡改数据库派生值后，历史列表不返回该记录为可用项，并报告 `invalidCount=1/total=1`；`/current` 返回 `invalid_records`。显式非法 `asOf`（不存在日历日或非日期文本）均 400，不静默回退到今天 |
| 迁移、全量写入与备份恢复 | ✅ 通过 | 迁移 v8 只新增一张表，旧库前向迁移后为空；`PUT /state` 对伪造/重复记录整体回滚；v8 必需表、索引、列在备份恢复切换前校验；合法记录往返无损 |
| 浏览器闭环 | ✅ 通过 | 两个全新临时数据目录、两个不同 loopback origin 连续两轮 **25/25**；问卷缺答拒绝、服务端重算落库、双评分/较低侧/硬封顶解释、复评追加与历史渲染全部通过 |
| 范围边界 | ✅ 通过 | schema 停在 v8；没有目标配置表、建议金额算法、5E 知识卡或 Phase 6 状态机；自动测试零真实网络请求 |

最终门禁：5B 定向 **27/27**（领域 18 + 服务端 9）；全量 `node --test` **546/546**；浏览器 wiring **25/25 × 2**；静态语法与 `git diff --check` 通过。复核缺口及闭合证据见 [`PHASE5B_ACCEPTANCE_GAPS.md`](./PHASE5B_ACCEPTANCE_GAPS.md)。


### Phase 5C｜目标配置与认可标的映射（2026-09-21，`2.4.9-phase5c`）

**结论：独立复核缺口 G5C-7～9 已修复，等待独立复验确认。** 5C 把 5B 的有效风险评估落成资产类别目标区间：`allocation_targets`（迁移 v9，追加式版本 + 自然键唯一）与 `approved_instruments`（类别 → 用户认可标的，只有用户判断可写）。等级与比例由服务端按 5A 冻结模板派生；当前比例与偏离复用 `computeOverview` 的**同一遍**估值；缺行情/汇率/分类沿用既有 blocker 与 `canAdvise`，不新写第二套判断。

| 验收点 | 结果 | 证据 |
|---|---|---|
| 每个风险上限稳定映射到一个合法目标版本，目标比例精确守恒（§6.4） | ✅ 通过 | `tests/domain-phase5c.test.js` 5C-1：五级模板逐字段等于 `tests/fixtures/phase5-risk-rules.json` 的冻结副本，`ΣtargetBps = 10000`，`min ≤ target ≤ max`，个股 target 恒为 0，五级模板互不相同；5C-2 同一评估重复映射逐字段一致 |
| 目标版本不回写历史（§6.2 工作项 5） | ✅ 通过 | 真实 HTTP：复评后 `POST /targets` 生成新 id 与新等级（L5 → L2），旧版本逐字段保持原样；自然键 `(assessment_id, template_version, effective_from)` 重复请求返回 200 `created:false` 同一版本；同自然键写入两条在 `PUT /state` 路径 409 `duplicate_target` |
| 派生值只有一份来源，客户端不可信 | ✅ 通过 | `POST /targets` 请求体必须是 JSON 对象且载荷白名单只有 `effectiveFrom`；带 `level`/`classes` 或提交 `null`/数组/字符串/数字均 400 `invalid_target_payload` 且不落库；错误 message 不回显输入原文 |
| 当前配置与 Phase 4 估值逐分一致；缺价格/汇率或分类未确认时沿用既有 blocker | ✅ 通过 | 5C-8 与真实 HTTP：六类 `valueMinor` 与 `GET /api/v1/overview` 的 `riskClasses` 逐项相等、投资池合计一致；`blockers` 集合与总览**逐字相同**、`canAdvise` 由 `computeOverview` 独占；类别合计与投资池不一致时 `invalid_valuation_input` 拒绝（证明没跑第二遍估值） |
| 边界值、空组合、只有现金、某类别为 0%（§6.4） | ✅ 通过 | 5C-7 端点含入：`min-1 → below_min`、`min → within`、`max → within`、`max+1 → above_max`，任意金额组合 `ΣpctBps = 10000`（最大余数法 + 同余数按类别序）；5C-9 投资池为 0 → `no_investable`，比例与容忍带全为 null；只有现金 → cash 100% `above_max`、下界为 0 的类别仍算 `within`；定点放缩超出安全整数 fail closed |
| 目标版本读取即复核 | ✅ 通过 | 5C-4/5C-5 反例：同版本偷换比例、错等级、未知模板/规则版本、`expiry ≠ assessedAt + 365`、生效日越界、类别缺失或多余、原型链注入、多余自有键全部 fail closed；与被引用评估交叉核对（上限/评估日/规则版本被改）同样拒绝。真实 HTTP 直接改库后 `GET /targets` 返回 `items=[] / invalidCount=1`，`/targets/current` 报 `invalid_records` |
| 当前生效目标的可区分空态 | ✅ 通过 | `selectCurrentTarget` 五态与真实 HTTP：`no_assessment`（还没有效评估）/ `no_target`（有评估未生成、或引用对了但生效日未到）/ `stale_assessment`（引用已不是当前有效评估）/ `invalid_records` / `current`；排序与数据库行序无关（5C-6 乱序输入得到同一序列） |
| 认可标的只引用已存在、分类已确认且类别一致的标的 | ✅ 通过 | 真实 HTTP 三条反例分别 422 `unknown_instrument` / `classification_unconfirmed` / `class_mismatch`；`PUT /state` 通道的伪造引用同样整体回滚且原数据不动；引用不存在的评估 422 `invalid_assessment_ref`（不再以 500 出现） |
| 多候选、明确稳定排序、顺序是用户判断 | ✅ 通过 | 5C-11 与真实 HTTP：类别内按 `position` 升序、跨类别按 `RISK_CLASSES` 序；整类替换按提交顺序落 position，推进服务端时钟后重复提交同一清单仍保持 id、`created_at` 与 `updated_at` 逐字段不变；a,b → b,a 换位成功，保留创建时间并只对真实位置变化更新时间（G5C-2/G5C-8）；`UNIQUE(instrument_id)` 与 409 `instrument_already_mapped` 保证一个标的不属两个类别 |
| provider 刷新不得修改用户映射 | ✅ 通过 | 真实 HTTP：`POST /market-data/refresh` 与 `POST /instruments`（provider 路径）前后 `GET /approved-instruments` 的 `rows` 逐字段相同；结构上 provider 与确认路径都不写 `approved_instruments`；分类被外部改回 suggested 时映射行保留并显示 `classification_unconfirmed`（不静默丢行），该类别同时被报为缺映射 |
| 缺映射不阻止显示偏离，只阻止落到证券（§6.3） | ✅ 通过 | 5C-12：目标比例 > 0 且无可用候选的类别才报缺映射（个股 target 为 0 不算缺）；偏离表在零映射时照常输出；页面在缺映射类别上标注「缺映射」 |
| 迁移、全量写入、备份恢复 | ✅ 通过 | v9 只新增两张表（列 / CHECK / 三条唯一索引 + 读取序索引由测试逐条断言；`ON DELETE RESTRICT` 双向验证：目标不能引用不存在的评估、有目标引用的评估删不掉）；旧库 v8 → v9 前向迁移后两表为空；`PUT /state` 三集合逐条复核、非法整体回滚、缺键清空；备份按版本校验 v9 必需表/列/索引（DROP 唯一索引的库在切换前被挡下），恢复往返目标与映射逐字段无损 |
| 页面不持有第二套口径 | ✅ 通过 | wiring 第 26 项：页面显示等级/模板/区间/六类金额与比例，且与 `GET /api/v1/overview`、`GET /api/v1/targets/current` 逐项一致；候选下拉只列已确认且类别一致的标的；进入本页同步事实源（G5C-5）；错误提示不回显输入原文 |
| 全量保存不得抹掉或并发覆盖追加式事实 | ✅ 通过（独立复核补口） | G5C-1/G5C-7：`Store.saveAll` 对 `/state` 只发单次 PUT，不再 GET 后回传旧快照；仓储在同一 SQLite 事务内保留未显式集合。真实 HTTP 模拟旧页面快照之后并发追加复评/目标与换位映射，页面保存后仍逐字段保持；显式空集合仍是清空指令，未带保留标志的旧备份路径继续缺键清空 |
| 范围边界 | ✅ 通过 | 5C-13/5C-15 与真实 HTTP：输出不含 `newFundsMinor` / `categoryAllocations` / 买卖金额 / 建议或决策状态键；`POST /recommendations` 仍是 501；未新增数据源、未开启自动行情；schema 停在 v9；自动测试零真实网络请求 |

当前修复门禁：5C 定向 **27/27**（领域 15 + 服务端 12）；受影响回归 **85/85**；全量 `node --test` **576/576**；浏览器 wiring **26/26 × 2**（两个全新临时数据库、两个不同 loopback origin）；`node --check` 与 `git diff --check` 通过。缺口与闭合证据见 [`PHASE5C_ACCEPTANCE_GAPS.md`](./PHASE5C_ACCEPTANCE_GAPS.md)，口径见 `DECISIONS.md` D-048。**独立复验确认前不写「已通过验收」，不进入 5D 的实现提交。**

### Phase 5E-1｜决策台风险摘要（2026-09-23，`2.4.12-phase5e1`）

2026-09-24 复核：发现返回首页时缓存的「有效」状态会在请求完成前短暂冒充当前判定。`2.4.13-phase5e1` 已在请求开始时显示「核对中」，读取失败显示「未复核」，并只替换风险摘要卡；新增浏览器断言覆盖首屏待决状态和归因区 DOM 保持。修正后全量 619/619，干净临时库 wiring 28/28。下表原 `2.4.12` 结果保留为历史验收截面。

| 检查项 | 方法 | 结论 | 备注 |
|---|---|---|---|
| 首页能说清「能力、意愿与最终上限」 | `tests/app-wiring.js` 新增用例「决策台风险摘要」（浏览器 wiring，两套全新临时库 / origin 18591、18592） | ✅ **28/28 × 2** | 摘要逐字段（`data-risk-*`）与服务端 `GET /risk-assessments/current` 完全一致，并与风险页文本同源 |
| 四态可区分 | 同上：清空账本 → 无评估；追加过期评估 → 已过期；追加剩余 15 天评估 → 即将到期；追加当日评估 → 有效 | ✅ 通过 | `no_assessment / current+valid / current+expiring_soon / all_expired` 各为独立文案与角标；`invalid_records` 与读取失败另列降级态 |
| 过期不得显示为「当前有效」 | 同上：过期态断言摘要不含「当前有效」、不含上限/得分属性，并给出 `annual_expired` 复评入口 | ✅ 通过 | 判定与到期日均来自服务端，页面不重算 |
| 缺数据不冒充 | 无评估与 `unavailable` / 读取失败三态断言不出现 `L0`、`0 分`，且读取失败保留上次判定并显式标注可能过期 | ✅ 通过 | 失败态另有「重新读取评估判定」入口；入口卡在任何状态下都不收回 |
| 范围边界 | 本轮 diff 仅 `js/app.js`、`sw.js`、`tests/app-wiring.*` 与文档 | ✅ 通过 | 零 Domain / API / Store / 问卷 / 目标 / 建议算法改动，schema 仍 v10；全量 `node --test` 619/619 与 5D 基线一致 |
| 首页渲染不打断既有交互 | 摘要复核解析后仅在判定内容变化时重渲染决策台 | ✅ 通过 | 修复前观察：无条件重渲染会干扰归因基准选择，导致 4E 用例偶发失败 |

稳定性观察（不属于 5E-1 失败，列为 5E-6 门禁项）：wiring 全量另有两个轮次各出现 1 项与本项无关的旧用例单次偶发失败（4D「启动时自动更新汇率开关」、4E「收益归因」）；在**停用 5E-1 首页复核的对照副本**上同样复现过 5C「目标配置 · 认可标的候选下拉」，属既有时序敏感用例，本项不修改其断言换取绿色。

5E-1 只完成 `PHASE5E_BREAKDOWN.md` 的第 1 项；S5.1 的完整解释链（配置对照、建议解释、知识卡、审计追溯）与整个 Phase 5 的端到端验收仍待 5E-2～5E-6，不得据本节宣布 5E 或 MVP 已验收。

### Phase 5E-2｜决策台配置对照（2026-09-24，`2.4.14-phase5e2`）

独立补测（`2.4.15-phase5e2`）：补全新评估后的 `stale_assessment` 与合法清空后的 `no_assessment` 真实 API 路径；`invalid_records` 的浏览器显示用模拟服务端响应验证，损坏记录的服务端判定由 `tests/server-phase5c.test.js` 验证。无估值时六类当前比例均为空并写「比例不可用」，目标区间中的合法 0% 保留。全量 619/619、两套干净库 wiring 29/29 × 2；下表 `2.4.14` 是原验收截面，尤其“篡改目标”的浏览器说法以本段为准。

| 检查项 | 方法 | 结论 | 备注 |
|---|---|---|---|
| 首页能说清六类「现在多少、目标在哪、偏了多少、数据哪天」 | `tests/app-wiring.js` C9.5（浏览器 wiring，18605、18606 两套全新临时库与 origin） | ✅ **29/29 × 2** | 对照卡逐字段与 `GET /api/v1/targets/current` 同源；复用 `Store.allocationCurrent()`，页面不重算比例、偏离或 `canAdvise` |
| 缺目标、缺评估、无估值、记录不可复核各自成立 | 同上：清空账本 → 无目标态；生成目标前 → 尚未评估/待更新态；移除全部可投资持仓 → `no_investable`（pct-bps 全空）；篡改目标 → `invalid_records` | ✅ 通过 | 各态独立文案 + 通往 `nav:targets` 的入口；`invalid_records` 按 `invalidCount/total` 显式保留（承 D-047 ⑥ / D-050 ②） |
| 缺数据不得出现 0% 或「正式口径」 | 无估值态断言六类比例均为 `—` 而非 `0%`，且不含「正式口径」；估算态显示既有 blocker 文案并保留估算标签 | ✅ 通过 | 判定只来自服务端；`canAdvise`/blocker 不在页面二次合成（不变量 3 / D-025） |
| 首页渲染不打断既有交互 | 慢响应（人为延迟）期间断言状态为「核对中」且归因区 DOM 节点身份不变；内容未变时二次复核不重写 DOM | ✅ 通过 | 只 `outerHTML` 替换对照卡；用 `state.allocCompareHtml` 缓存比对，对齐 D-050 ③ 的局部替换纪律 |
| 读取失败可恢复 | 断言失败态标「未复核」、保留上次对照并显示 `alloc:retry`；点击重试后恢复当前数据 | ✅ 通过 | 不把「读不到」说成「没有目标」 |
| 范围边界 | 本轮 diff 仅 `js/app.js`、`sw.js`、`tests/app-wiring.*` 与文档 | ✅ 通过 | 零 Domain / API / Store / 目标 / 映射 / 建议算法改动，schema 仍 v10；`POST /targets` 201 与 fxRates 字段形状仅在测试 fixture 中修正，未改产品逻辑 |

实现过程中修正了三处 wiring fixture/断言缺陷（fxRates 需 `base/quote` 字段、生成目标返回 201 而非 200、归因节点身份比较误用了 `goHome` 之前的旧节点引用），均属测试基建，不计入产品缺陷。稳定性观察沿用 5E-1 小节的 4D/4E/5C 偶发项，仍列为 5E-6 门禁项，不由本项修复。

5E-2 只完成 `PHASE5E_BREAKDOWN.md` 的第 2 项；S5.1 的完整解释链（建议解释、知识卡、审计追溯）与整个 Phase 5 的端到端验收仍待 5E-3～5E-6，不得据本节宣布 5E 或 MVP 已验收。

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

2026-09-30 完整复验：当前 `2.4.27-phase6-review` / schema v11（零迁移）。基线 696/696；补充反例发现并修复 5 个缺陷，新增 8 项回归（含真实并发与事务中途失败），最终 **704/704**、Phase 6 定向 **53/53**、wiring **38 × 2**、browser-review **38 + 三探针**（外部请求/页面异常均为 0）、宽度与状态 **71 项**通过。报告 [PHASE6_REVIEW.md](./PHASE6_REVIEW.md)，证据 `docs/evidence/phase6-review-20260930/`。G5-R4 沿用已有真人记录（4/4、35 秒），本轮未重做真人测试；独立门禁与 Phase 7 不变。

> 2026-09-28 由 **6A** 冻结口径，2026-09-29 二次复测修正四组契约冲突（D-057，权威文本 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md)）。本节只写可验收的行为；实现完成前一律标记待验收。
>
> **进度（2026-09-29 实测）**：6A 契约已冻结；6B 状态机、事件、存储与 API 已按 §S6.1 / §S6.5 落地并通过 49 有序对全遍历、幂等、迁移与备份复测（当时全量 677/677）；**6C 决定与待执行页面已完成**——三类决定真实可用且刷新一致、失败不假成功，读取中 / 读取失败 / 提交失败 / 失效 / 初始空态分别呈现，慢响应不覆盖新状态（含详情弹层），全量 679/679、浏览器 wiring 36 项 × 3 轮、1440/1100/390px 三档宽度 64 项检查通过（证据 `docs/evidence/phase6-6c-20260929/`）。**§S6.2 交易关联与执行（6D）已于 2026-09-29 完成**——详情关联区、解绑软删除、执行/归档门禁、`POST /decisions/{id}/links` 与 `.../links/unlink`、6D 服务端 5 条 + 领域 2 条 + wiring 第 37 项，全量 686/686、三轮 wiring 与三档宽度通过（证据 `docs/evidence/phase6-6d-20260929/`）；**§S6.3 的 6E-1 复盘计算与封存、6E-2 复盘页面与月度历史已于 2026-09-30 完成**（`2.4.26-phase6e`，全量 692/692、wiring 38 项 × 3 轮、`browser-review.py` 38 项、三档宽度 66+5 项，证据 `docs/evidence/phase6-6e-20260930/`；6E-3 G5-R4 真人计时**已通过**（变体 C 数据 4/4 全对、自报计时 35 秒，记录见 `docs/evidence/phase6/6e-r4.md`））；**§S6.4 Phase 6 整体退出证据（6F）已于 2026-09-30 完成**：两场景闭环 + 负向电池（6F-01～04，全量 **696/696**）——场景 A（9 月单笔无偏差，对照可比、复盘只读）与场景 B（10 月建议、10/11 月分批两笔含 HKD 汇率与 −300 偏差、备份/清空/恢复逐字段一致）共用一本临时账本且证券事件零重叠；负向电池覆盖暂缓 / 忽略不进待执行、非法跳步、幂等回放与冲突、失效建议接受被拒、缺汇率三汇总 null、快照篡改 invalidCount + 详情 400、引用缺失整体回滚、部分失败不落半条；月度筛选按月归属正确、空月份不出条目。浏览器侧两套全新临时库 × 不同 loopback origin × 干净 profile wiring **38 项 × 2 轮全绿**（19311、19312），`browser-review.py` **38 项**（19313，外部请求 0、pageErrors 0、三项审计探针通过），三档宽度 **66 页面 + 5 状态**（19314）；证据 `docs/evidence/phase6-6f-20260930/`。**Phase 6（6A～6F + G5-R4）整体通过**；4A 行情源门禁、S2.3 实机启动与 Phase 7 两个月真实使用不因此自动关闭。

### S6.1 合法状态流转

七个状态：`proposed / accepted / deferred / dismissed / executed / reviewed / archived`。

- 允许（**恰好 6 条**）：`proposed → accepted/deferred/dismissed`、`accepted → executed`、`accepted → archived`、`executed → reviewed`。
- 拒绝（**其余 43 个有序对**，含全部 7 条自转移）：`proposed → executed/reviewed/archived`、`executed → accepted/reviewed` 之外的逆向、`deferred/dismissed/archived/reviewed → *` 一切出口、`accepted → deferred/dismissed/reviewed`、任意 `X → X`。
- **验收必须数据驱动遍历全部 7×7 = 49 个有序对（含自转移）**，不得只抽样代表样例：合法 → 状态改变且恰好追加 1 条事件；非法 → HTTP 409 `illegal_transition` 且状态、事件数、关联数逐项不变（事务整体回滚）。
- **`deferred → accepted` 永久非法**：暂缓 / 忽略是归档出口，只进历史不进待执行清单；事实变化后由规则引擎生成新建议（新 `inputHash` → 新 id）再走新决策。同一 `recommendationId` 重复创建返回既有决策（`created:false`），不改状态、不追加事件。
- **只有 `status === 'formal'` 的建议能创建决策**：估算建议 → 409 `recommendation_not_formal`，不进待执行清单、不可接受。接受时服务端独立重核 `Domain.adviceStaleness`，失效 → 409 `recommendation_stale`；客户端角标不作为授权依据。`deferred`/`dismissed` 创建不做重核。
- `intent` 白名单只有 `accepted|deferred|dismissed`；出现 `executed|reviewed|archived|proposed` → 409 `illegal_transition` 且**不创建任何决策行**。

每次状态变化必须保存时间（本地日 `occurred_at` + ISO `recorded_at`）、理由码与自由文本 `note`、操作者（固定 `local-user`，客户端提交即 400）和当时封存快照（`snapshot_json` + `snapshot_hash`）；**没有快照哈希与 `seq` 链式一致性复核通过，读取直接失败**（`invalid_decision_record`，不返回"修好"的数据）。产品不调用券商交易接口。

### S6.2 交易关联与不重复入账

- **只关联 `buy`**：`sell`/`dividend`/`fee` → 409 `invalid_link_target`；分批可关联多笔 buy；手续费（buy 自带 `fee_minor`）单列为交易费用，不计入本金、不参与偏差。
- **一条证券事件同时只属一条决策**（部分唯一索引，活动行唯一）：已挂本决策 → `created:false`；已挂另一决策 → 409 `event_already_linked`；不做跨决策拆单。
- 关联只允许在 `accepted`/`executed`；解绑是软删除（`unlinked_on` + 必填 `unlink_note`），保留行不删历史；`reviewed` 后一切冻结。
- 进度只反映事实、不改状态：`remainingMinor = 建议金额 − Σ(按各自交易日 as-of 汇率折 CNY 的 buy 本金)`；任一活动买入缺汇率时，关联本金、费用、剩余金额与内部偏差均为 `null`，`linkedCount` 保持事实、`fxUnavailable` 按交易日/id 排序；确认执行按"有偏差"处理且必须填写 note，**不按 1:1 / 期末汇率 / 部分小计 / 伪 0 兜底**。无活动关联时金额汇总为 0、剩余为建议金额。
- `accepted → executed` 要求活动关联 ≥1（否则 409 `no_linked_events`）且显式命令推进，**不按金额相等自动判定**；有偏差必须 `note`（否则 400 `deviation_note_required`）。
- **无交易必须能关闭**：0 元建议 / 全部保留现金 / 接受后放弃 → `accepted → archived`（活动关联必须为 0，否则 409 `has_linked_events`），note 必填；建议金额为 0 且从未关联时为 `no_trade`，正金额未买即放弃或曾关联后全部解绑为 `abandoned`。**不得伪造 0 元证券交易、不得用零关联的 `executed` 顶替**；归档不进复盘。
- 实际交易复用既有证券事件，关联和重试不得重复创建交易、不得改写 `security_events`、不得写入 `txns` 或自动扣减现金；删除曾被任何关联行（活动或已解绑）引用的事件 → 409 `linked_event_missing` 且整笔回滚。现金仍按原规则人工核对（`cashReconciled := !freshness.balanceStale`），不自动扣减或重复计入。
- 记事实 ≠ 重新批准建议：给失效建议补记已发生的交易**允许**，但不会改变决策状态，也不会重算建议金额。

### S6.3 复盘、历史与恢复

- **三时点逐事件封存**：`proposed → accepted/deferred/dismissed` 为决策时点，`accepted → executed` 为执行时点，`executed → reviewed` 为复盘时点；`accepted → archived` 另存归档快照、不进入三时点对照。快照一次性封存，此后改行情 / 目标 / 资产不改写历史；参照目标固定为**决策所引用的历史目标版本**（`targetRef`），当前目标如需展示必须单独标注。
- **复盘是配置对照，不是业绩归因**：按六类（恒 6 行）比较三时点的金额、比例（basis points）与相对目标偏离；禁止出现"建议收益""跑赢目标"一类把配置变化说成收益的表述。
- **缺数据不可比、不出伪 0**：`available = canAdvise && cashReconciled`，为 false 时金额与类别字段全 `null`，`reason ∈ {cash_not_reconciled, valuation_not_formal}` + 既有 blockers 解释；投资池为 0 是合法可比状态（比例列 `null`），不算缺数据。复盘本身不因缺数据被拒绝，但页面必须显著标注不可比。
- **月度历史按 `decision_events.occurred_at` 本地状态事件月归属**：跨月状态事件才使决策多次出现；10 月接受、11 月仅关联买入时 `eventMonths` 仍只有 10 月，11 月确认执行后才新增 11 月；详情为完整时间线、回填交易日与操作时间分列、空月份不出条目。
- 配置前后对照必须能由当时快照复核（哈希 + `seq` 链 + 引用完整性）；当前行情或目标变化不改写历史复盘。
- **全量读取与恢复同样 fail closed**：若决策快照原文字节或事件链被篡改，列表排除该行并计 `invalidCount`、详情与 `GET /state` 返回 400 `invalid_decision_record`（`/state` 不返回坏快照）；v11 SQLite 候选备份在切换前拒绝，恢复接口返回失败且活库不变。有效备份仍可恢复损坏活库，恢复前取证快照不得冒充有效候选。
- 覆盖面：跨月历史、缺数据降级、**普通五键保存必须保留三个新集合**、显式 `decisions: []` 才清空、**缺三键的旧备份恢复为空历史**、v10→v11 迁移空表不伪造历史、新旧备份恢复、备份结构校验（**含把部分唯一索引换成普通索引必须拒止**）；任何失败不破坏活库。

### S6.4 延后补齐 G5-R4

6E-3 在有数据的页面上由真人计时，四问全部正确且总耗时 ≤60 秒；记录受测者代号、版本、数据来源、起止时间、答案与核对结果。自动化 DOM 读取不算真人理解证据。**已于 2026-09-30 通过**：受测者 S1 在变体 C 演示数据上 4/4 全对、自报连续计时 35 秒 ≤60 秒；三轮三套互斥变体数据、前两轮失败记录原样保留，见 `docs/evidence/phase6/6e-r4.md`（原“缺失时 Phase 6 只能写待真人验收”的要求不再适用）。

### S6.5 阶段范围守卫不得静默放宽

6B 必须**逐条更新** `tests/domain-phase5a.test.js 5A-18`（`LATEST_VERSION` 10 → 11）、`server-api.test.js` / `server-phase3.test.js` 的 501 断言、`tests/server-phase5d.test.js`（改为断言 `recommendations` 仍无状态列）、`tests/domain-phase5d.test.js 5D-24`（Phase 6 代码放新段落并**新增**同形状守卫，5D 边界只移动不删断言）与备份/迁移/伴随集合断言（6 → 9）。**禁止删用例换绿色**；逐条改断言并在注释写明原因。清单见契约 §11。

Phase 6 退出证据：**已于 2026-09-30 齐备并通过**——两次完整闭环（6F-01 场景 A / 6F-02 场景 B，含分批跨月与备份恢复追溯，契约 F-A / F-B 的验收形态）、§10.2 反向清单所列行为（49 有序对全遍历、幂等/并发、迁移/恢复、篡改拒止等由 6B～6E 测试与 6F 负向电池共同覆盖）、旧功能与浏览器回归（wiring 38 × 2、browser-review 38、宽度 71 项）全部通过，G5-R4 已完成。逐项对照见 [PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md) §8 退出清单。

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
