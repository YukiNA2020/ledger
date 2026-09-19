# 下一位执行 Agent 入口

## 当前事实

- v3 Phase 1–3 已验收；Phase 4B / 4C / 4D 复核补口完成并已提交（用户确认可进入后续阶段）。Phase 4E 第 1 轮 P0（G4E-1）与第 2 轮 P1（G4E-2）的补口实现已提交（`0d71542`），证据为 486/486 + wiring 24/24 × 2；**Phase 4E 的独立复核结论以 `PHASE4E_ACCEPTANCE_GAPS.md` 为准**。Phase 4A 正式验收仍暂不通过，行情自动抓取因 D-038 门禁未通过继续默认关闭。
- **Phase 5A「风险问卷与配置规则冻结」已完成并提交（2026-09-19，`2.4.0-phase5a`）。当前措辞是「规则冻结完成，等待独立复核确认」，不是「Phase 5 已通过」。** 口径见 `DECISIONS.md` D-046，T-004 已由「待定」改为「✅ 已定」。
- 5A 冻结了什么（D-046 ①–⑧）：① 9 道题 —— 承受能力 5 题（收入稳定性 / 应急金覆盖 / 负债与近期应付款 / 投资期限 / 近期流动性需求）、承受意愿 4 题（投资经验 / 基础知识 / 最大可接受回撤 / 跨境与汇率风险理解），每题有稳定题目 id、选项 id、0–3 整数分值、维度与解释键，**显示文案不参与持久化**；② 能力分域 0–15（边界 0/4/7/10/13）、意愿分域 0–12（边界 0/3/6/9/11），**下界含入**（score ≥ 下界即归入该级）；③ `riskCeiling = min(capacityLevel, willingnessLevel)`，再由 4 条硬封顶压低（应急金不足 3 个月 / 收入不稳定 / 一年内有较大流动性需求 / 近期应付款或负债压力高 → 上限 ≤ 2），**只降不升、高意愿不能抵消关键短板**，`ceilingSource ∈ {capacity, willingness, equal, hard_cap}`；④ 有效期 365 天、到期前 30 天「即将到期」、**到期日当天仍有效**（次日失效），复评原因词表 8 项 —— **市场涨跌不在其中**；⑤ 目标模板 5 级 × 六类（cash / fixed_income / broad_equity / theme_equity / stock / other）的 basis points 区间，ΣtargetBps 精确 10000、**个股 target 恒为 0**（D-018）、容忍带端点含入、分母是**可投资资产**（不含安全储备）；⑥ 建议输入只含引用与用户判断（`snapshotRef{closeId,snapshotId,payloadHash}` / `assessmentRef{id,ruleVersion}` / `targetVersion` / `ruleVersion` / `newFundsMinor` / `approvedInstruments`），输出键集合与 `formal | estimate` 冻结，类别恒按资产类别序、尾差按「缺口降序 → 同缺口按排列顺序」；⑦ 版本 `risk-rules-v1` / `risk-targets-v1`，规则任一变动必须升版本；⑧ 5A **零迁移、零 API、零页面**。
- 规则数据与纯契约函数在 `js/domain.js`（唯一实现，浏览器与服务端共用）；冻结副本 `tests/fixtures/phase5-risk-rules.json`（测试逐字段比对，改规则必须同时改 fixture）；测试 `tests/domain-phase5a.test.js`（**18 项**，含范围守卫：迁移停在 v7、`server/api.js` 未新增风险路由、5A 段落无网络与随机、不读系统时钟）。
- 测试基线：全量 `node --test` **504/504**（须在非沙箱、真实用户身份下运行，含 Keychain）；5A 定向 **18/18**；浏览器 wiring **24/24 × 2**（干净环境）；`APP_VERSION` 与 SW 缓存键均为 `2.4.0-phase5a`；零真实网络请求；schema 停在 **v7**。
- 4E 口径（D-045 ①–⑨）、4C/4D 口径（D-042 / D-043 / D-044）**保持不变**，详见各自条目。
- 详细证据见 `TEST.md` 的「Phase 5A 证据」与「当前结论」、`ACCEPTANCE.md` §7 的 Phase 5A 进度表、`ROADMAP.md` 的 Phase 5A 节；子阶段拆解全文见 `PHASE5_BREAKDOWN.md`。

## 你的任务

**只实施 Phase 5B「风险评估与复评机制」；动手前先确认 5A 的独立复核已通过。不实施 5C/5D/5E。**

1. 按 `AGENTS.md` 规定顺序完整阅读项目文档，先检查 git 状态与 5A 的实现 / 文档提交。
2. **先确认 5A 的独立复核结论**。若复核未通过或尚未进行，先按 `PHASE5_BREAKDOWN.md` §4 与 D-046 逐条复核 5A（题库 / 分值 / 边界 / 硬封顶 / 模板 / 复评 / 契约 / 范围守卫），结论与逐条修复状态写入新建的 `PHASE5A_ACCEPTANCE_GAPS.md`（多轮时按轮次倒序，原始结论不删改）。
3. 5B 工作项（严格按 `PHASE5_BREAKDOWN.md` §5）：
   - 实现纯领域函数：答案验证、能力评分、意愿评分、硬封顶、最终风险上限、有效期与复评状态 —— **复用 5A 的 `validateRiskAnswers` / `scoreRiskAnswers` / `assessmentValidity`，不得另写第二套评分**；
   - 新增 `risk_assessments` 持久化：保存原始答案、规则版本、双评分、硬封顶原因、最终上限、评估日期、到期日与复评原因；**追加版本、不静默覆盖历史**，「当前有效评估」由确定性规则选出；
   - `POST /api/v1/risk-assessments` 与只读查询：服务端**从答案重算**，不采信客户端提交的分数或等级；写请求加幂等保护；非法答案 / 规则版本不匹配 / 重复请求都不得产生两条评估；
   - 问卷 UI：分开展示「客观承受能力」与「主观风险意愿」，结果页解释最终上限为何取较低值，并展示评估日期、到期日、触发原因与硬封顶项（不得用「保守 / 激进」标签替代具体解释）；
   - 备份、恢复与全量 `/state` 覆盖新表及其验证；迁移失败整体回滚；旧库前向迁移**不伪造默认评估**。
4. 迁移（`PHASE5_BREAKDOWN.md` §10）：新增一个 version（预计 **v8**），**绝不改已发布的旧迁移**；只加表 → 登记 `REQUIRED_TABLES_BY_VERSION`；只加列 → `REQUIRED_COLUMNS_BY_VERSION`；加索引（尤其唯一索引）→ `REQUIRED_INDEXES_BY_VERSION`，并同步复核 `tests/server-migration.test.js` 的三处硬编码（`rows.length`、前向迁移 `applied` 数组、坏迁移 version 写 `LATEST_VERSION + 1`）。
5. 测试三层齐备：领域（评分 / 封顶 / 阈值 / 复评边界 / 缺答与未知选项）、真实 HTTP（重算不采信客户端、幂等、规则版本错配、旧库迁移后评估为空）、浏览器 wiring（S5.1 从真实产品入口走完一次评估并展示封顶原因）。自动测试零公网。
6. 完成后同步全部文档（ROADMAP / TEST / ACCEPTANCE / CHANGELOG / DECISIONS / README / ARCHITECTURE / NEXT_AGENT），版本升到 `2.4.1-phase5b`，并如实写明状态（「已完成并提交」或「第 N 轮补口完成、等待复核」）。

## 禁止事项

- 未确认 5A 复核通过前，不进入 5C 及以后；5B 内**不得计算目标配置、不得生成新增资金建议、不得创建 Phase 6 决策状态机**。
- **不得改动 5A 冻结的规则值**（题目 / 分值 / 边界 / 硬封顶 / 模板 / 容忍带 / 复评词表 / 建议契约）。确需变更时，必须先升 `RISK_RULE_VERSION`（必要时 `RISK_TARGET_VERSION`）、同步 fixture，并在 `DECISIONS.md` 说明理由与影响。
- 不得引入年龄 / 性别等与承受能力无因果的变量；不得写收益率、胜率或未来回报承诺；不得把知识卡或默认值伪装成个人财务事实。
- 不新增数据源、不开启自动行情抓取（D-038 门禁未过）；不改 `quotes` / `fx_rates` / `portfolio_openings` / `security_events` 的表结构，不改 D-042 / D-043 / D-044 / D-045 的既有口径。
- 客户端只能提交题目 / 选项答案、评估日期与复评原因；分数、等级与上限一律由服务端重算。
- 不删除既有测试换取绿色结果，不覆盖无关的用户修改；本地服务只绑定 `127.0.0.1`。
- 不接付费数据源；不让 API Key、账户名、余额、数量、成本或**问卷答案**进入 provider 请求、响应或日志（问卷答案属私人财务事实，D-020）。

## 可直接复制给下一位 Agent 的任务描述

> 阅读 `AGENTS.md` 指定的全部项目文档，先确认 Phase 5A（`2.4.0-phase5a`，D-046）的独立复核结论；未通过则先复核并写入 `PHASE5A_ACCEPTANCE_GAPS.md`，通过后再实施 Phase 5B「风险评估与复评机制」。5B 严格复用 5A 冻结的规则与纯函数（`validateRiskAnswers` / `scoreRiskAnswers` / `assessmentValidity`），**不得另写第二套评分，也不得改动冻结的题目 / 分值 / 边界 / 硬封顶 / 模板 / 复评词表**。实现：`risk_assessments` 持久化（追加版本、不覆盖历史、保存原始答案与规则版本）、`POST /api/v1/risk-assessments` 与只读查询（服务端从答案重算，不采信客户端分数或等级；幂等保护；非法答案与规则版本错配不得产生两条评估）、问卷 UI 分开展示承受能力与意愿并解释最终上限为何取较低值、备份 / 恢复 / 全量 `/state` 覆盖新表及验证、迁移 v8（旧库迁移后评估为空而非虚构默认值）。测试覆盖 S5.1 的领域 / 真实 HTTP / 浏览器三层；运行全量回归（当前基线 504/504，非沙箱）、5B 定向测试与 wiring 干净环境两轮；自动测试零真实网络。不实现 5C 的目标配置与 5D 的新增资金建议，不创建 Phase 6 决策状态机。完成后同步 ROADMAP / TEST / ACCEPTANCE / CHANGELOG / DECISIONS / README / ARCHITECTURE / NEXT_AGENT，版本升 `2.4.1-phase5b`。
