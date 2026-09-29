# 下一位执行 Agent 入口

## 当前任务：只做 Phase 6A「规则与契约」

2026-09-28：用户认可桌面天空蓝与细节优化，要求先拆解 Phase 6，再交给其他 agent 开发。**拆解已完成，6A～6F 均未实施。** 当前代码 `2.4.23-ui-polish` / SQLite v10；不要把规划当成已实现。

先按 AGENTS.md 必读顺序阅读，再读 [PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md)。ROADMAP「唯一当前阶段」为任务指针。下一位 agent 完成 6A 后才能交给 6B，不要一次实现整个 Phase 6。

## G5-R4 不再阻塞前半程

用户称 05-R4 的项目是 **G5-R4 四问理解真人计时**，排在 **6E-3**，**6F 完整验收前必须通过**。Phase 5 已在排除该项的限定范围通过，完整验收仍待该证据。不能以自动读取 DOM 或 agent 自答代替真人；具体题目、计时和证据要求见拆解 §7。

## 可复制的首次指令

> 按 AGENTS.md 必读顺序阅读，再读 PHASE6_BREAKDOWN.md。只完成 6A：检查现有代码，明确状态机、暂缓再处理、实际交易关联、部分执行、无交易和复盘口径；创建 PHASE6_CONTRACT.md，同步 PRODUCT / DECISIONS / ARCHITECTURE / ACCEPTANCE，给出 schema/API/备份契约和迁移、回滚、验收方案。不要实现业务、迁移数据库或推进 6B。保留所有未提交改动。对无法从已有规则裁定的产品分歧，先提出具体方案再确认。G5-R4 是 6E-3 的任务，不是本步前置。完成后按拆解 §9 交付，并据真实结果更新 ROADMAP 与本入口。

后续阶段逐项指令见拆解 §10；6E 应拆为 6E-1、6E-2、6E-3 三次任务。

## 必须复用的既有实现

- 5A 评分、等级、目标模板与分配规则已冻结；新增资金是已有投资现金，不再加一次投资池分母。
- `server/recommendations.js`：同一领域引擎、正式/估算门禁、完整 `gate.capture`、`inputHash`/`payloadHash` 幂等与重放；月结基准和计算日事实分别封存。
- G5-R1：建议引用的不可变评估/目标必须与 capture 一致；G5-R2：`Domain.adviceStaleness` 和历史建议失效显示；G5-R3：服务不可达时本地知识入口。保持全部反例通过。
- `security_events` 是实际证券交易事实；不复制入 `txns`，不自动改现金余额。新增关联层不能重复记账。
- 估值、配置偏离和归因使用现有领域函数；页面只搬运服务端值，不重算建议金额。
- 静态知识卡 15 张及解释版本封存；历史建议不能倒填解释版本。按日判定沿用 D-053 的 `ctx.today` 与显式 `asOf`。
- 普通五键保存依赖服务端事务保留六个伴随集合：riskAssessments、allocationTargets、approvedInstruments、recommendations、monthlyCloses、closeSnapshots。新增集合贯穿 Core / Store / 仓储 / 备份，不恢复客户端 GET→PUT 覆盖窗口。

## 测试与保护边界

- 当前全量基线 648 项、浏览器 wiring 34 项；最新界面还有 17 页面 × 3 宽度检查，见 `docs/evidence/ui-polish-20260928/`。这是历史实测基线，后续新增测试需如实更新数量。
- `docs/evidence/phase5-review-20260927/browser-review.py` 硬编码 34：新增 Phase 6 wiring 可独立成套，或同步更新 runner 的明确覆盖契约；禁止删旧断言换绿色。
- 隔离 fixture 服务：`node docs/evidence/phase5d-wiring-server.cjs <端口>`；每轮全新临时数据库、不同 origin、干净 profile，结束停止自己的进程。自动测试零真实网络，不读取私人账本。
- 先看 git status 和已有 diff；工作树包含大量 Phase 5 与 UI 未提交改动，不能 reset、覆盖或打包无关修改。
- 保留天空蓝桌面风格、无装饰表情、日期与控件的自适应宽度。涉及前端静态文件时同步 SW 缓存版本。
- 实施迁移前按项目要求保留可恢复备份；文档规划阶段不操作真实数据库。
- 不修改自动行情门禁、不接券商；Phase 4A 行情源、S2.3 实机重启和 Phase 7 两个月真实验证仍是独立事项。

历史阶段证据见 [PHASE5_REVIEW.md](./PHASE5_REVIEW.md) §8～§10；当前执行顺序以 ROADMAP 为准。
