# 下一位执行 Agent 入口

## 当前任务：只做 Phase 6D「关联实际交易并记录执行」

2026-09-29：**6C「接受、暂缓、忽略与待执行页面」已完成**（`2.4.25-phase6c-fix2` / schema v11，零迁移）——决策台侧栏与首页新增「决策与待执行」入口，建议详情可进入决定（接受 / 暂缓 / 忽略 + 必填理由），待执行清单只列 `accepted`、暂缓与忽略只进历史；详情呈现原建议、决定理由、事件时间线与时点快照入口；读取失败、提交失败、失效建议、初始空态、读取中（含重新读取）分别呈现，慢响应的旧读取不覆盖已读到的新状态（清单 `decRequest`、提交 `decSubmitSeq`、详情 `decDetailSeq` 三处顺序守卫）；服务不可达时走本地服务未运行提示，不冒充空清单。全量 `node --test` **679/679**（6B 基线 677 + 6C 新增 2 条 Store 封装契约），浏览器 wiring **36 项 × 2 轮全绿**（19041、19047，后者为 `browser-review.py`，含三项审计探针与外部请求 0），1440/1100/390px 三档宽度 **60 项页面检查 + 4 项状态检查**全过；证据见 `docs/evidence/phase6-6c-20260929/`。

**6B「状态机、事件、存储与 API」同样已完成**（`2.4.24-phase6b` / schema v11）：迁移 `phase6-decisions` 三表、决策创建/事件/列表/详情 API、接受门禁、幂等、伴随集合 6→9、备份 `REQUIRED_*[11]` 对称拒止，含 **49 个有序对数据驱动全遍历**与 F-A/F-B 闭环；`GET /state` 与备份恢复对坏快照 fail closed，列表保留 `invalidCount` 降级。定向 18/18、当时全量 677/677。

Phase 6 的唯一规则来源仍是 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md)（D-057，含二次复测修正）；**6D 只做交易关联与执行推进，不得改契约口径、不得另写一套状态判断或估算规则**。

先按 AGENTS.md 必读顺序阅读，再读 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md) 与 [PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md)（6D 范围见拆解 §6）。ROADMAP「唯一当前阶段」为任务指针。下一位 agent 完成 6D 后才能交给 6E-1，不要一次实现整个 Phase 6。

6D 要点（细节以契约为准）：复用 Phase 4C `security_events` 作为实际交易事实，选择已有事件或经原证券事件入口新增后按 id 关联；关联独立保存，不复制为第二笔证券事件、不写 `txns`、不自动改现金余额；新增交易成功而关联失败时说明交易已保存并可重试；按 6A 规则处理多笔、重复、错标的/账户/币种/日期、少买/超买与失效建议的事后关联，原建议金额永久不变；执行汇总显示建议、实际、差额、未完成部分与偏差原因；`accepted → executed` 只能由服务端命令触发且要求活动关联 ≥1，有偏差必须填 note，`accepted → archived` 要求活动关联为 0；页面只搬运服务端值，不重算进度。关联端点同样要防重复点击，失败不得显示成功。

## G5-R4 不再阻塞前半程

用户称 05-R4 的项目是 **G5-R4 四问理解真人计时**，排在 **6E-3**，**6F 完整验收前必须通过**。Phase 5 已在排除该项的限定范围通过，完整验收仍待该证据。不能以自动读取 DOM 或 agent 自答代替真人；具体题目、计时和证据要求见拆解 §7。

## 可复制的 6D 指令

> 按 AGENTS.md 必读顺序阅读文档、PHASE6_BREAKDOWN.md（§6）与已冻结的 PHASE6_CONTRACT.md，核对 ROADMAP 当前指针与前一步证据。只完成 6D 的交付和验收，不顺带做下一步。保留已有工作，复用现有证券事件、估值与服务端决策 API，遵守桌面天空蓝与无装饰表情的界面要求。自动测试只使用隔离 fixture；G5-R4 必须有真人计时。完成后按实测更新阶段文档，并按拆解 §9 交付，未通过不得写成完成。

后续阶段逐项指令见拆解 §10（将 X 替换为 `6E-1`、`6E-2`、`6E-3` 或 `6F`）；6E 应拆为 6E-1、6E-2、6E-3 三次任务。

## 必须复用的既有实现

- **Phase 6 契约 `PHASE6_CONTRACT.md` 是 6B～6F 的唯一规则来源**：状态机、字段白名单、错误码、快照结构、迁移 v11 与备份方案都已冻结；发现分歧先改契约，不得在代码里就地裁定。
- **6C 已交付的页面资产**：`js/app.js` 的 `tplDecisions` / `decisionCard` / `renderDecisionSheet` / `decisionDetailHtml` / `ensureDecisionsLoaded`（`decRequest` + `decSubmitSeq` 顺序守卫）与 `dec:open` / `dec:submit` / `dec:detail` / `dec:reload` / `dec:filter` 动作；`js/store.js` 的 `listDecisions` / `decisionDetail` / `createDecision` / `appendDecisionEvent`（写入带 `Idempotency-Key`，服务不可达显式抛错）；`styles.css` 的 `.dec-*` 与窄屏换行规则。6D 的执行进度与确认入口应挂在详情页与卡片既有槽位，不另起一套状态判断。
- 5A 评分、等级、目标模板与分配规则已冻结；新增资金是已有投资现金，不再加一次投资池分母。
- `server/recommendations.js`：同一领域引擎、正式/估算门禁、完整 `gate.capture`、`inputHash`/`payloadHash` 幂等与重放；月结基准和计算日事实分别封存。
- G5-R1：建议引用的不可变评估/目标必须与 capture 一致；G5-R2：`Domain.adviceStaleness` 和历史建议失效显示；G5-R3：服务不可达时本地知识入口。保持全部反例通过。
- `security_events` 是实际证券交易事实；不复制入 `txns`，不自动改现金余额。新增关联层不能重复记账。
- 估值、配置偏离和归因使用现有领域函数；页面只搬运服务端值，不重算建议金额与执行进度。
- 静态知识卡 15 张及解释版本封存；历史建议不能倒填解释版本。按日判定沿用 D-053 的 `ctx.today` 与显式 `asOf`。
- 普通五键保存依赖服务端事务保留九个伴随集合：riskAssessments、allocationTargets、approvedInstruments、recommendations、monthlyCloses、closeSnapshots、decisions、decision_events、decision_links。新增集合贯穿 Core / Store / 仓储 / 备份，不恢复客户端 GET→PUT 覆盖窗口。

## 测试与保护边界

- 当前全量基线 **679** 项、浏览器 wiring **36** 项（原 34 项语义 + 2 项 6C 决策检查）；界面另有 **18 路由 × 3 宽度**检查，见 `docs/evidence/phase6-6c-20260929/width-result.json` 与 `docs/evidence/ui-polish-20260928/`。新增测试需如实更新数量。
- `docs/evidence/phase5-review-20260927/browser-review.py` 已按拆解 §9 同步为 36 项（保留原 34 项语义，仅新增 6C 检查计数）；6D 若要加 wiring 检查，必须同步更新该计数，禁止删旧断言换绿色。
- 隔离 fixture 服务：`node docs/evidence/phase5d-wiring-server.cjs <端口>`，或直接跑 `python3 docs/evidence/phase6-6c-20260929/run_wiring_6c.py <端口>`（自起自停临时库）；每轮全新临时数据库、不同 origin、干净 profile，结束停止自己的进程。自动测试零真实网络，不读取私人账本。
- 先看 git status 和已有 diff；不能 reset、覆盖或打包无关修改。
- 保留天空蓝桌面风格、无装饰表情、日期与控件的自适应宽度。涉及前端静态文件时同步 SW 缓存版本。
- 实施迁移前按项目要求保留可恢复备份；文档规划阶段不操作真实数据库。
- 不修改自动行情门禁、不接券商；Phase 4A 行情源、S2.3 实机重启和 Phase 7 两个月真实验证仍是独立事项。

历史阶段证据见 [PHASE5_REVIEW.md](./PHASE5_REVIEW.md) §8～§10；当前执行顺序以 ROADMAP 为准。
