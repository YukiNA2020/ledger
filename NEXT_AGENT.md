# 下一位执行 Agent 入口

## 当前任务：只做 Phase 6B「状态机、事件、存储与 API」

2026-09-28：**6A「规则与契约」已完成**（零业务代码、零迁移、零页面），Phase 6 的唯一规则来源是已冻结的 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md)（D-057）。当前代码 `2.4.23-ui-polish` / SQLite v10；6B 实施迁移 v11 后升至 v11。不要把契约当成已实现的代码。

先按 AGENTS.md 必读顺序阅读，再读 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md) 与 [PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md)（6B 范围见拆解 §4，必须显式更新的守卫测试见契约 §11）。ROADMAP「唯一当前阶段」为任务指针。下一位 agent 完成 6B 后才能交给 6C，不要一次实现整个 Phase 6。

6B 要点（细节以契约为准）：迁移 v11 建 `decisions` / `decision_events` / `decision_links` 三表；转移校验用数据驱动测试**全遍历 49 个有序对（含自转移）**（契约 §1.2 即期望值）；`POST /api/v1/decisions/{id}/events` 从 501 占位改为真实行为；伴随集合 6 → 9、`CLEAR_ORDER` 头部插三表；备份 `REQUIRED_*[11]` 登记并补上「部分唯一索引被换成普通索引」的对称拒止；幂等记录与业务写入同一事务。只做状态机与存储，不做决定页面（6C）与交易关联 UI（6D）。

## G5-R4 不再阻塞前半程

用户称 05-R4 的项目是 **G5-R4 四问理解真人计时**，排在 **6E-3**，**6F 完整验收前必须通过**。Phase 5 已在排除该项的限定范围通过，完整验收仍待该证据。不能以自动读取 DOM 或 agent 自答代替真人；具体题目、计时和证据要求见拆解 §7。

## 可复制的 6B 指令

> 按 AGENTS.md 必读顺序阅读文档、PHASE6_BREAKDOWN.md（§4）与已冻结的 PHASE6_CONTRACT.md，核对 ROADMAP 当前指针与前一步证据。只完成 6B 的交付和验收，不顺带做下一步。保留已有工作，复用现有算法和交易事实，遵守桌面天空蓝与无装饰表情的界面要求。自动测试只使用隔离 fixture；G5-R4 必须有真人计时。实施迁移前按项目要求保留可恢复备份。完成后按实测更新阶段文档，并按拆解 §9 交付，未通过不得写成完成。

后续阶段逐项指令见拆解 §10（将 X 替换为 `6C`、`6D`、`6E-1`、`6E-2`、`6E-3` 或 `6F`）；6E 应拆为 6E-1、6E-2、6E-3 三次任务。

## 必须复用的既有实现

- **Phase 6 契约 `PHASE6_CONTRACT.md` 是 6B～6F 的唯一规则来源**：状态机、字段白名单、错误码、快照结构、迁移 v11 与备份方案都已冻结；发现分歧先改契约，不得在代码里就地裁定。
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
