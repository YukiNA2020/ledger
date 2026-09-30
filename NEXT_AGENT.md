# 下一位执行 Agent 入口

## 当前任务：只做 Phase 6F「最终集成验收」

2026-09-30：**6E「复盘与历史」的 6E-1 复盘计算与封存、6E-2 复盘页面与月度历史已完成**（`2.4.26-phase6e` / schema v11，**零迁移**）——契约 §4.3 的六类配置对照以服务端派生 `comparison` 进决策详情（`comparable` + `timepoints` + 恒 6 行；任一时点快照缺失或不可比 → 全表不出数字、不出伪 0；0 投资池比例列 null 不算不可比；delta = 复盘 − 决策；参照目标固定 targetRef 历史版本）；领域新增纯函数 `decisionReviewComparison` / `validateDecisionComparisonShape`，只消费既有封存快照，不写第二套估值。页面：详情弹层新增「配置变化对照（非收益）」区；`executed` 状态新增「记录复盘」入口（理由必填，复盘后一切只读）；历史列表新增月份筛选（状态事件操作时间月，与状态筛选互为与）；交易日与操作时间分列标注。`executed → reviewed`、复盘快照与 `reviewed_with_drift / reviewed_no_drift` 沿用 6B 同事务实现。全量 `node --test` **692/692**（6E 新增服务端 4 条 + 领域 2 条），浏览器 wiring **38 项 × 3 轮全绿**（19212、19213、19214），`browser-review.py` **38 项**（19221，外部请求 0、pageErrors 0、三项审计探针通过），三档宽度 **66 页面 + 5 状态 = 71 项**（19215，含复盘对照弹层三档截图）；证据见 `docs/evidence/phase6-6e-20260930/`。

**6D 与 6C、6B 也已完成**：6D（`2.4.25-phase6d`）实际交易关联区、解绑软删除、执行 / 归档门禁全由服务端判定；6C（`2.4.25-phase6c-fix2`）决定弹层、待执行清单、历史筛选、详情与三处顺序守卫；6B（`2.4.24-phase6b`）迁移 `phase6-decisions` 三表、49 有序对全遍历、接受门禁、幂等、伴随集合 6→9、备份对称拒止。

**6E-3（G5-R4 真人四问计时）已于 2026-09-30 通过**：受测者 S1（账本所有者本人）在变体 C 演示数据上四题 4/4 全对、自报连续计时 35 秒 ≤60 秒；此前两轮（第 1 轮未计时、第 2 轮第 4 题答错）的失败记录原样保留在 `docs/evidence/phase6/6e-r4.md`。6F 的 G5-R4 硬门禁已满足；6F 验收时只需引用该记录，不需重测。

Phase 6 的唯一规则来源仍是 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md)（D-057，含二次复测修正与 6D / 6E 补充）；**6F 只做集成验收，不得改契约口径、不得另写一套估值 / 偏离函数、不得输出伪收益**。

先按 AGENTS.md 必读顺序阅读，再读 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md) 与 [PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md)（6F 范围见拆解 §8）。ROADMAP「唯一当前阶段」为任务指针。

## 6F 要点（细节以契约为准）

至少两次**独立建议与决策**完整走通（拆解 §8）：

- 场景 A：正式建议 → 接受并填写理由 → 一笔实际交易 → 核对现金 → 执行完成 → 复盘（对照可比）。
- 场景 B：另一月的正式建议 → 接受 → 多笔实际交易并说明偏差 → 核对现金 → 执行完成 → 复盘 → 备份 / 空库恢复后追溯。

另测暂缓、忽略、非法跳步、并发重复、失效建议、缺报价 / 汇率、快照损坏、引用缺失及部分失败；两次闭环不能复用同一事件重复计数。退出清单见拆解 §8，**G5-R4 真人计时是硬门禁**（材料已备，待用户安排受测者执行）。

## 可复制的 6F 指令

> 按 AGENTS.md 必读顺序阅读文档、PHASE6_BREAKDOWN.md（§8）与已冻结的 PHASE6_CONTRACT.md，核对 ROADMAP 当前指针与前一步证据。只完成 6F 的集成验收：两次完整闭环 + 负向用例 + 原功能回归，逐条留证。G5-R4 已通过（`docs/evidence/phase6/6e-r4.md` 第 3 轮记录：4/4 全对、35 秒），6F 引用该证据即可。完成后按实测更新阶段文档，并按拆解 §9 交付。

## 必须复用的既有实现

- **Phase 6 契约 `PHASE6_CONTRACT.md` 是 6B～6F 的唯一规则来源**：状态机、字段白名单、错误码、快照与对照结构、迁移 v11 与备份方案都已冻结；发现分歧先改契约，不得在代码里就地裁定。
- **6C / 6D / 6E 已交付的页面资产**：`js/app.js` 的 `tplDecisions`（状态 + 月份双筛选）/ `decisionCard` / `renderDecisionSheet` / `decisionDetailHtml` / `decisionComparisonHtml`（对照区）/ `decisionLinksHtml` / `decisionActionHtml`（执行确认 + 记录复盘）/ `ensureDecisionsLoaded`（`decRequest` + `decSubmitSeq` + `decDetailSeq` 三处顺序守卫）与 `dec:*` 动作；`js/store.js` 的决策读写方法（写入带 `Idempotency-Key`，服务不可达显式抛错）；`styles.css` 的 `.dec-*` 与窄屏换行规则。
- **6B / 6E 服务端能力**：`server/decisions.js` 的 `createDecision` / `appendDecisionEvent` / `createDecisionLink` / `unlinkDecisionLink` / `decisionDetailResponse`（含 `comparison`）与 `decisionSnapshot`（`canonicalJson` + sha256 逐事件封存、`seq` 链式复核）；复盘事件与快照走同一套追加 + 复核。
- 5A 评分、等级、目标模板与分配规则已冻结；新增资金是已有投资现金，不再加一次投资池分母。
- `server/recommendations.js`：同一领域引擎、正式 / 估算门禁、完整 `gate.capture`、`inputHash` / `payloadHash` 幂等与重放；月结基准和计算日事实分别封存。
- G5-R1～R3 反例、`Domain.adviceStaleness`、断网知识卡降级保持全部通过；`security_events` 是实际交易事实，关联层不复制入 `txns`、不改现金余额。
- 静态知识卡 15 张及解释版本封存；按日判定沿用 D-053 的 `ctx.today` 与显式 `asOf`。
- 普通五键保存依赖服务端事务保留九个伴随集合：riskAssessments、allocationTargets、approvedInstruments、recommendations、monthlyCloses、closeSnapshots、decisions、decision_events、decision_links。

## 测试与保护边界

- 当前全量基线 **692** 项、浏览器 wiring **38** 项（原 34 项语义 + 2 项 6C + 1 项 6D + 1 项 6E）；界面另有 **18 路由 × 3 宽度 + 四弹层 + 5 状态 = 71 项**，见 `docs/evidence/phase6-6e-20260930/width-result.json`。新增测试需如实更新数量。
- `docs/evidence/phase5-review-20260927/browser-review.py` 已按拆解 §9 同步为 **38** 项（保留原 34 项语义，仅新增 6C 两项、6D 一项、6E 一项检查的计数）；6F 若要加 wiring 检查，必须同步更新该计数，禁止删旧断言换绿色。
- 隔离 fixture 服务：`node docs/evidence/phase5d-wiring-server.cjs <端口>`，或直接跑 `python3 docs/evidence/phase6-6e-20260930/run_wiring_6e.py <端口>` / `run_width_6e.py <端口>`（自起自停临时库）；每轮全新临时数据库、不同 origin、干净 profile，结束停止自己的进程。自动测试零真实网络，不读取私人账本。
- 先看 git status 和已有 diff；不能 reset、覆盖或打包无关修改。
- 保留天空蓝桌面风格、无装饰表情、日期与控件的自适应宽度。涉及前端静态文件时同步 SW 缓存版本。
- 实施迁移前按项目要求保留可恢复备份；6F 预期零迁移（v11 已就位）。
- 不修改自动行情门禁、不接券商；Phase 4A 行情源、S2.3 实机重启和 Phase 7 两个月真实验证仍是独立事项。

历史阶段证据见 [PHASE5_REVIEW.md](./PHASE5_REVIEW.md) §8～§10；当前执行顺序以 ROADMAP 为准。
