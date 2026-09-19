# 下一位执行 Agent 入口

## 当前事实

- v3 Phase 1–3 已验收；Phase 4B / 4C / 4D 复核补口完成并已提交（用户确认可进入后续阶段）。Phase 4E 第 1 轮 P0（G4E-1）与第 2 轮 P1（G4E-2）的补口实现已提交（`0d71542`），证据为 486/486 + wiring 24/24 × 2；**Phase 4E 的独立复核结论以 `PHASE4E_ACCEPTANCE_GAPS.md` 为准**。Phase 4A 正式验收仍暂不通过，行情自动抓取因 D-038 门禁未通过继续默认关闭。
- **Phase 5A「风险问卷与配置规则冻结」的第 1 轮独立复核结论为「暂不通过，不进入 5B」**（G5A-1 P0 / G5A-2 P1 / G5A-3 P1，原文与最小复现见 `PHASE5A_ACCEPTANCE_GAPS.md`）。
- **三条缺口的补口已实现并提交（2026-09-19，`2.4.1-phase5a`）。当前措辞是「补口完成，等待独立复核确认」——不是「5A 已通过」，也不是「Phase 5 已通过」。** 口径见 `DECISIONS.md` **D-046**（含补口条款），T-004 已由「待定」改为「✅ 已定」。
- 5A 冻结了什么（D-046 ①–⑧）：① 9 道题 —— 承受能力 5 题（收入稳定性 / 应急金覆盖 / 负债与近期应付款 / 投资期限 / 近期流动性需求）、承受意愿 4 题（投资经验 / 基础知识 / 最大可接受回撤 / 跨境与汇率风险理解），每题有稳定题目 id、选项 id、0–3 整数分值、维度与解释键，**显示文案不参与持久化**；② 能力分域 0–15（边界 0/4/7/10/13）、意愿分域 0–12（边界 0/3/6/9/11），**下界含入**；③ `riskCeiling = min(capacityLevel, willingnessLevel)`，再由 4 条硬封顶压低（应急金不足 3 个月 / 收入不稳定 / 一年内有较大流动性需求 / 近期应付款或负债压力高 → 上限 ≤ 2），**只降不升、高意愿不能抵消关键短板**，`ceilingSource ∈ {capacity, willingness, equal, hard_cap}`；④ 有效期 365 天、到期前 30 天「即将到期」、**到期日当天仍有效**（次日失效），复评原因词表 8 项 —— **市场涨跌不在其中**；⑤ 目标模板 5 级 × 六类（cash / fixed_income / broad_equity / theme_equity / stock / other）的 basis points 区间，ΣtargetBps 精确 10000、**个股 target 恒为 0**（D-018）、容忍带端点含入、分母是**可投资资产**（不含安全储备）；⑥ 建议输入只含引用与用户判断（`snapshotRef{closeId,snapshotId,payloadHash}` / `assessmentRef{id,ruleVersion}` / `targetVersion` / `ruleVersion` / `newFundsMinor` / `approvedInstruments`），输出键集合与 `formal | estimate` 冻结，类别恒按资产类别序、尾差按「缺口降序 → 同缺口按排列顺序」；⑦ 版本 `risk-rules-v1` / `risk-targets-v1`，规则任一变动必须升版本；⑧ 5A **零迁移、零 API、零页面**。
- 第 1 轮复核缺口与补口口径（`2.4.1-phase5a`，细节见 D-046 补口条款）：**G5A-1** 对外规则常量此前可被原地改写（第二层的 `RISK_QUESTIONS[0].options[0].score = 0` 就让同一 `risk-rules-v1` 下 15 分变 12 分）→ 现在 16 个规则常量**递归冻结**，内部逻辑只读内部引用，`riskCatalog()` / `targetTemplateForLevel()` 仍返回**可写深拷贝**；**G5A-2** `targetVersion` 由「非空字符串」收紧为 `=== RISK_TARGET_VERSION`；**G5A-3** 目标模板类别由「六类齐备」收紧为与 `RISK_CLASSES` **精确相等**（用 `getOwnPropertyNames` 要求数量恰为 6 且全在词表内，另拒原型链上的可枚举类别）。
- 规则数据与纯契约函数在 `js/domain.js`（唯一实现，浏览器与服务端共用）；冻结副本 `tests/fixtures/phase5-risk-rules.json`（测试逐字段比对，改规则必须同时改 fixture）；测试 `tests/domain-phase5a.test.js`（**22 项**，含 5A-19～5A-22 四条复核缺口反例与范围守卫）。
- 测试基线：全量 `node --test` **508/508**（须在非沙箱、真实用户身份下运行，含 Keychain）；5A 定向 **22/22**；浏览器 wiring **24/24 × 2**（干净环境）；`APP_VERSION` 与 SW 缓存键均为 `2.4.1-phase5a`；零真实网络请求；schema 停在 **v7**。
- 4E 口径（D-045 ①–⑨）、4C/4D 口径（D-042 / D-043 / D-044）**保持不变**，详见各自条目。
- 详细证据见 `TEST.md` 的「Phase 5A 证据」「Phase 5A 第 1 轮复核补口证据」与「当前结论」、`ACCEPTANCE.md` §7 的 Phase 5A 进度表、`ROADMAP.md` 的 Phase 5A 节；子阶段拆解全文见 `PHASE5_BREAKDOWN.md`。

## 你的任务

**只做一件事：独立复核 Phase 5A 第 1 轮复核缺口（G5A-1 / G5A-2 / G5A-3）的补口，并复核补口没有顺手破坏 5A 的既有口径。不实施 Phase 5B，不实施 5C/5D/5E。**

1. 按 `AGENTS.md` 规定顺序完整阅读项目文档，先检查 git 状态与 5A 的实现 / 补口 / 文档提交，确认工作区没有别人未提交的补丁。
2. 先读 `PHASE5A_ACCEPTANCE_GAPS.md`（第 1 轮原文未删改，顶部是本轮补口状态表），再读 `DECISIONS.md` D-046 与其补口条款、`PHASE5_BREAKDOWN.md` §4。
3. **必须自己独立把三条缺口的最小复现跑一遍，不要复用他人脚本**：
   - G5A-1：对**每一层**对外规则对象做修改尝试（尤其第二层：题目 → 选项数组 → 选项；以及模板 → 类别表 → 类别行、边界条目、硬封顶条目、各词表），确认 `scoreRiskAnswers` / `targetTemplateForLevel` / `riskCatalog` / `recommendationContract` 结果逐字段不变；再确认「整体换掉对外键」（`Domain.RISK_QUESTIONS = []` 之类）同样不影响内部结果；最后清点 `js/domain.js` 中所有与 5A 规则相关的导出，逐个验证**递归**冻结（只冻第一层就是没冻）。浏览器是**非严格模式**为主：静默失败也算「拒绝修改」，但要在结论里说明两种模式下的表现。
   - G5A-2：未知 / 空 / 空白 / 大小写与空格变体 / 与 `ruleVersion` 交叉错配的 `targetVersion` 是否全部 fail closed；并确认没有第二个入口（5B 的 API、5D 的建议入口尚未实现，但要检查是否已经留下接受任意版本的分支）。
   - G5A-3：模板额外类别（含 `defineProperty` 不可枚举键、原型链上的类别、JSON 里的 `__proto__` 自有键、异常对象形状）是否全部拒绝，且内置五级模板与 fixture 模板仍全部通过。
   - **反向验证**：把 5A 测试文件指向 `2.4.0-phase5a`（`6efbb16`）的 `js/domain.js` 重跑，确认新增反例确实变红、原有 18 项保持全绿。若你自己写的反例在旧实现上也通过，说明它没有锁住缺口。
4. 复核补口的零回归：S5.1 冻结样例逐字段不变；S5_2 / S5_3 仍标注承载 5D、5A 不宣称其通过；`riskCatalog()` / `targetTemplateForLevel()` 返回的副本仍然**可写**（不得把冻结视图误当成契约）。
5. 跑门禁：5A 定向（当前 22/22）、全量 `node --test`（当前 508/508，**必须非沙箱**）、浏览器 wiring **干净环境两轮**（当前 24/24 × 2，服务用后台常驻方式启动）。
6. 复核范围保持：schema 仍为 **v7**、`POST /api/v1/risk-assessments` 仍为 501 延后登记、`server/api.js` 未新增风险路由、5A 段落无网络 / 随机 / 系统时钟。自动测试零公网。
7. 把本轮复核结论写入 `PHASE5A_ACCEPTANCE_GAPS.md`：**按轮次倒序**新增一节（原文不删改），逐条给出「已闭合 / 未闭合 + 理由 + 复现命令 + 实测输出」。三项全部闭合后才可把结论更新为「通过」；否则只写缺口并保持「不进入 5B」。

## 禁止事项

- 未确认补口复核通过前，**不进入 5B，也不进入 5C 及以后**。
- **不得改动 5A 冻结的规则值**（题目 / 分值 / 边界 / 硬封顶 / 模板数值 / 容忍带 / 复评词表 / 建议契约）。确需变更时，必须先升 `RISK_RULE_VERSION`（必要时 `RISK_TARGET_VERSION`）、同步 fixture，并在 `DECISIONS.md` 说明理由与影响。
- 不得为了让测试变绿而放宽断言、删除用例或把 fail closed 改成静默兜底；不得把「补口完成」写成「验收通过」。
- 不得引入年龄 / 性别等与承受能力无因果的变量；不得写收益率、胜率或未来回报承诺；不得把知识卡或默认值伪装成个人财务事实。
- 不新增数据源、不开启自动行情抓取（D-038 门禁未过）；不改 `quotes` / `fx_rates` / `portfolio_openings` / `security_events` 的表结构，不改 D-042 / D-043 / D-044 / D-045 的既有口径。
- 不删除既有测试换取绿色结果，不覆盖无关的用户修改；本地服务只绑定 `127.0.0.1`。
- 不接付费数据源；不让 API Key、账户名、余额、数量、成本或**问卷答案**进入 provider 请求、响应或日志（问卷答案属私人财务事实，D-020）。

## 补口复核通过后才执行：Phase 5B「风险评估与复评机制」

（以下内容在 5A 补口复核**通过**后生效；在此之前不要开工。）

工作项（严格按 `PHASE5_BREAKDOWN.md` §5）：

- 实现纯领域函数：答案验证、能力评分、意愿评分、硬封顶、最终风险上限、有效期与复评状态 —— **复用 5A 的 `validateRiskAnswers` / `scoreRiskAnswers` / `assessmentValidity`，不得另写第二套评分**；
- 新增 `risk_assessments` 持久化：保存原始答案、规则版本、双评分、硬封顶原因、最终上限、评估日期、到期日与复评原因；**追加版本、不静默覆盖历史**，「当前有效评估」由确定性规则选出；
- `POST /api/v1/risk-assessments` 与只读查询：服务端**从答案重算**，不采信客户端提交的分数或等级；写请求加幂等保护；非法答案 / 规则版本不匹配 / 重复请求都不得产生两条评估；
- 问卷 UI：分开展示「客观承受能力」与「主观风险意愿」，结果页解释最终上限为何取较低值，并展示评估日期、到期日、触发原因与硬封顶项（不得用「保守 / 激进」标签替代具体解释）；
- 备份、恢复与全量 `/state` 覆盖新表及其验证；迁移失败整体回滚；旧库前向迁移**不伪造默认评估**。
- 迁移：新增一个 version（预计 **v8**），**绝不改已发布的旧迁移**；只加表 → 登记 `REQUIRED_TABLES_BY_VERSION`；只加列 → `REQUIRED_COLUMNS_BY_VERSION`；加索引（尤其唯一索引）→ `REQUIRED_INDEXES_BY_VERSION`，并同步复核 `tests/server-migration.test.js` 的三处硬编码（`rows.length`、前向迁移 `applied` 数组、坏迁移 version 写 `LATEST_VERSION + 1`）。
- 测试三层齐备：领域（评分 / 封顶 / 阈值 / 复评边界 / 缺答与未知选项）、真实 HTTP（重算不采信客户端、幂等、规则版本错配、旧库迁移后评估为空）、浏览器 wiring（S5.1 从真实产品入口走完一次评估并展示封顶原因）。自动测试零公网。
- 完成后同步全部文档（ROADMAP / TEST / ACCEPTANCE / CHANGELOG / DECISIONS / README / ARCHITECTURE / NEXT_AGENT），版本升到 **`2.4.2-phase5b`**（`2.4.1-phase5a` 已被 5A 复核补口占用），并如实写明状态（「已完成并提交」或「第 N 轮补口完成、等待复核」）。

## 可直接复制给下一位 Agent 的任务描述

> 阅读 `AGENTS.md` 指定的全部项目文档。**本次只做 Phase 5A 第 1 轮复核缺口（G5A-1 / G5A-2 / G5A-3）的独立复核**：读 `PHASE5A_ACCEPTANCE_GAPS.md`（第 1 轮原文 + 顶部本轮补口状态表）、`DECISIONS.md` D-046 及补口条款、`PHASE5_BREAKDOWN.md` §4；自己独立重跑三条缺口的最小复现（G5A-1 要逐层尝试修改对外规则对象并清点所有 5A 规则导出是否递归冻结、整体换掉对外键是否仍不影响内部结果；G5A-2 要覆盖未知 / 空 / 变体 / 交叉错配的 `targetVersion`；G5A-3 要覆盖额外类别、不可枚举键、原型链类别、JSON `__proto__`、异常对象形状，且内置模板仍须通过）；把 5A 测试指向 `2.4.0-phase5a` 的 `js/domain.js` 做**反向验证**，确认新增反例确实变红；复核零回归（S5.1 冻结样例不变、`riskCatalog` 与模板副本仍可写、S5_2 / S5_3 仍标注承载 5D）；运行全量回归（当前 508/508，非沙箱）、5A 定向（当前 22/22）与浏览器 wiring 干净环境两轮（当前 24/24 × 2）；确认 schema 仍为 v7、`POST /api/v1/risk-assessments` 仍 501、自动测试零真实网络。结论按轮次倒序写入 `PHASE5A_ACCEPTANCE_GAPS.md`，逐条给出理由、复现命令与实测输出；三项全部闭合前**不进入 5B**，也不得改动 5A 冻结的规则值、不得为变绿而放宽断言。补口复核通过后，才按 `PHASE5_BREAKDOWN.md` §5 实施 Phase 5B（复用 5A 的 `validateRiskAnswers` / `scoreRiskAnswers` / `assessmentValidity`，不另写第二套评分），版本升 `2.4.2-phase5b`。
