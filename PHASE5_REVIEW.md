# Phase 5 全阶段独立验证（2026-09-27）

> 最新顺序（2026-09-28）：见 §10。G5-R4 排到 Phase 6E-3，6F 前必须通过；历史“先补 R4 再进入 Phase 6”的任务顺序已由新计划替代，证据与失败结论不被抹除。


**结论：暂不通过完整验收。** 当前实现 `2.4.20-phase5e6` / SQLite v10。既有自动化全绿，但独立补测复现两项 P1 缺陷、一项 P2 离线入口缺口；“一分钟理解”还缺实际计时证据。本结论覆盖此前 5E-6 的“Phase 5 已完成”状态，原始通过日志保留为历史证据。

> **补口状态（2026-09-28）：** G5-R1 / G5-R2 / G5-R3 已修复并按本报告的反例复验通过（见 §8）；**G5-R4 实际计时演练仍未完成**，因此本报告的「暂不通过完整验收」结论**继续有效**，不得改写为通过。产品版本升至 `2.4.21-phase5g5` / schema v10（零迁移）。

本轮覆盖 5A–5E 的规则、持久化、HTTP、资金分配、页面、解释版本、数据恢复和原记账/导入。只使用虚构 fixture、独立临时数据库和本机回环服务。未修改产品代码、冻结规则、数据库结构或用户真实数据；修改为审计脚本、证据和交接文档。

## 1. 实测结果

| 检查 | 本轮结果 | 原始证据 |
|---|---|---|
| 全量 `node --test` | 631/631；0 失败、0 跳过 | [baseline.txt](docs/evidence/phase5-review-20260927/baseline.txt) |
| 5A–5E 全部定向 + 知识卡 | 142/142 | [directed.txt](docs/evidence/phase5-review-20260927/directed.txt) |
| 原记账、导入、去重、金额、备份、旧 API | 79/79 | [legacy-regression.txt](docs/evidence/phase5-review-20260927/legacy-regression.txt) |
| 原完整浏览器 wiring | 34/34 × 2（18783、18784，干净 context / 独立临时库） | [browser-18783.json](docs/evidence/phase5-review-20260927/browser-18783.json)、[browser-18784.json](docs/evidence/phase5-review-20260927/browser-18784.json) |
| 独立评分校验 | 13,312 组通过：全部 1,024 种能力答案 × 13 个意愿总分；独立按阈值与硬封顶计算期望 | [numeric.json](docs/evidence/phase5-review-20260927/numeric.json) |
| 独立资金校验 | 5,000 组通过：五等级、大小金额、零值、上限、现金下限、金额守恒、输入行序反转；另有四个手算例 | 同上 |
| JSON 恢复到空库 / SQLite 备份恢复 | 正常全链通过；快照原文被改且哈希未变时 400，事务整体回滚 | [reference.json](docs/evidence/phase5-review-20260927/reference.json) |
| 恢复时的跨记录一致性反例 | **2 个反例均失败**：不同等级替换、同等级但答案/分数不同 | 同上；脚本以退出码 1 如实报告 |
| 生产页面后续变更 | **失败**：撤销认可映射、行情变旧后仍展示缓存正式建议 | 两份 browser JSON 的 `mappingRevocationProbe` / `staleQuoteProbe` |
| 生产首页断网重载 | 缓存脚本加载，但**知识卡真实页面入口为 0** | 两份 browser JSON 的 `offlineProbe` |
| 语法 / 空白检查 | 通过 | [static-checks.txt](docs/evidence/phase5-review-20260927/static-checks.txt) |

142/142 与 79/79 是全量套件的子集，不能与 631 相加；随机/枚举校验也不是新增的 `node:test` 数量。浏览器 `result=pass` 仅指原 34 项，额外审计的 `auditPassed=false`，二者不能混写成全绿。

## 2. G5-R1｜P1：恢复允许不可变引用与建议封存输入互相矛盾

定位：`server/repository.js:1521`，`validateRecommendationReferences` 只核对月结/快照，未核对所引用的风险评估和目标记录是否与 `gate.capture` 中同 ID 的不可变版本一致。

复现（真实 HTTP，临时库）：

1. 正常生成 L3 风险评估、目标和正式建议，导出完整 `/state`。
2. 保留评估 id、目标 id、建议及其 capture 不变，把该评估改为合法 L1 答案，并按 L1 重算目标；所有单条记录分别合法。
3. 通过 `PUT /state {state, forceBackup:true}` 恢复。
4. 实际返回 **200**；建议读取视图仍为 `formal`、`invalidCount=0`，同一个目标 id 在当前表里是 **L1**，在建议 capture/result 中却是 **L3**。
5. 即使等级保持 L3，只把能力分从 7 改为 8，仍返回 200，异常数仍为 0。

影响：历史建议本身可以按 capture 重放，但按其展示的评估/目标 id 下钻会得到另一份事实。单条自洽和 SQL 外键“存在”未保证审计链相互一致；恢复路径会接受内部矛盾的备份。

修复验收要求：写入/恢复与可用读取视图应交叉核对**所引用的不可变评估和目标**，不同内容使用不同身份；有冲突的完整恢复应拒绝且回滚。不要把此规则扩大为“历史资产或认可映射必须等于今天”，这些可变事实本应按 capture 保留历史。

## 3. G5-R2｜P1：页面刷新当前事实后继续展示旧建议“全部门禁通过”

定位：`js/app.js:964`（维护映射只刷新目标）、`js/app.js:1035`（继续渲染 `state.advice`）、`js/app.js:1061`（旧状态直接显示“正式建议 / 全部门禁通过”）。

两个正常操作路径均在生产 `/` 页面复现，18783 / 18784 结果一致：

- **撤销认可**：生成 CNY 2,000 正式建议后，用页面“移除”按钮移除全部宽基候选。API 和映射区均为 0 条，但建议正文完全不变，仍列出 E6VOO / E6VGT 各 1,000 元，仍标“全部门禁通过”。
- **数据过期**：将临时库行情日期改为 10 天前，点击目标页“重新读取”。API `canAdvise=false`，页面上方已写“当前为估算口径 / 行情已过期”，下方却仍显示原正式建议及“全部门禁通过”，没有“历史结果 / 当前已失效 / 待重算”区分。

证据：[整页截图](docs/evidence/phase5-review-20260927/stale-view-18784.png)、[旧建议截图](docs/evidence/phase5-review-20260927/revoked-mapping-18784.png)。

影响：服务器重新计算时的门禁仍有效，缺陷在页面继续把历史计算显示为当前行动依据；会让用户依据已撤销标的或已过期行情执行。

修复验收要求：保留原封存记录；当前资产、评估、目标或映射变更后，页面清除本次建议或明确标为历史、需要重新计算。若保留展示，“当时通过”应与“当前可执行”区分。异步旧请求晚到也不能覆盖更新后的状态；判定仍消费服务端，不在前端复写分配算法。

## 4. G5-R3｜P2：缓存知识卡缺少本地服务不可达时的真实入口

操作：在线打开生产首页，确认 Service Worker 控制页面，再将浏览器置为 offline 并重载。两轮均得到 `catalogLoaded=true`、`serviceWorkerControlled=true`，但页面回到资产空态 / 未连接服务，`knowledgeEntryCount=0`，没有可点击的知识卡。

证据：[断网页面](docs/evidence/phase5-review-20260927/offline-view-18784.png)。相关边界位于 `js/app.js` 的空态/未连接服务渲染与 `js/store.js:185` 的读取降级路径。

这里模拟的 offline **也阻断本机 HTTP**，不等同于“公网断开、localhost 服务仍可达”。卡片内容确实是静态本地数据；缺口是曾承诺的“断网重载后用户可打开”未通过真实入口验证。旧证据的手动触发 `know:open` 和目录对象可读取不足以证明这一点。

修复验收要求：若保持“服务不可达仍可读知识卡”的既有承诺，提供不依赖账户数据和 API 的真实知识入口，并用可见点击验收；不能通过注入按钮或直接调用处理函数冒充用户操作。财务数据仍只读、不得回写第二份事实源。

## 5. G5-R4｜证据缺口：没有实际的一分钟理解计时

`tests/app-wiring.js:3172` 的“一分钟理解演练”读取 API/DOM 并打印四个答案，没有受测者、开始结束时间、任务耗时和理解正确率。本轮 9.442 / 9.455 秒是**整套自动 wiring 的执行时间**，不能当作用户理解耗时。

四个数字与 API 同源已通过；“人在一分钟内理解”仍未验证。此项需要单独记录一次实际操作的四问答案和用时，再判断 Phase 5E 的演练门槛；仍不得据此宣布 Phase 7 两个月真实使用指标通过。

## 6. 分阶段判断与边界

| 阶段 | 本轮判断 |
|---|---|
| 5A 规则冻结 | 通过：冻结 fixture、双评分、边界、硬封顶、精度与契约；新增独立评分/金额样本未见违反不变量 |
| 5B 风险评估 | 正常评估、追加复评、非法输入、到期边界、幂等、迁移/恢复现有场景通过；与建议的跨记录恢复一致性见 R1 |
| 5C 目标和认可映射 | 派生目标、比例守恒、映射维护和 provider 不改用户判断通过；变更后旧建议的页面状态见 R2 |
| 5D 分配和正式门禁 | 计算、请求入口、估算阻断、幂等、完整输入重放通过；历史引用链 R1 未闭合 |
| 5E 解释和整体体验 | 原十态/三层对照/解释封存通过；生成后变更 R2、离线入口 R3、理解计时 R4 未闭合 |

既有 4D/4E/5C 偶发 wiring 项本轮没有重现，但有限次数通过不能证明永不偶发。4A 行情源、S2.3 重启/登录、Phase 6 状态机、Phase 7 真实使用均不在本轮通过范围；没有连接券商、查询真实行情或使用私人账本。

## 7. 复现与交接

在 `ledger/` 目录运行：

```bash
node --test
node --test tests/domain-phase5*.test.js tests/server-phase5*.test.js tests/knowledge.test.js
node docs/evidence/phase5-review-20260927/numeric-review.cjs
node docs/evidence/phase5-review-20260927/reference-review.cjs
python3 docs/evidence/phase5-review-20260927/browser-review.py 18785
```

后两条当前应退出 1，表示审计反例仍未通过，不能删断言换绿色。浏览器脚本依赖本机已有 Python Playwright，不属于产品运行依赖；每次创建独立临时库、用完 SIGTERM 清理。所有浏览器页面请求限定 localhost，记录中外部请求数为 0；服务端使用离线 fixture provider。

较早调试轮 18781 原 wiring 34/34，但追加可见点击误用了隐藏 harness，发生测试脚本超时；18782 的生产页面两项反例已复现，离线步骤因入口不存在超时。最终 18783 / 18784 已将 offline 的实际页面作为证据保存，未用注入入口规避问题。上述初轮报告也保留，不伪装成全部成功。

下一入口：**Phase 5 验收补口**。先修 R1 / R2，补 R3 与实际计时，再针对相关路径和全量门禁复验。当前不进入 Phase 6。产品代码未改，回滚本轮只涉及此报告、审计证据和文档状态增量；不得整体撤回原有未提交的 5B–5E 工作。

## 8. 补口修复状态（2026-09-28，`2.4.21-phase5g5` / schema v10 零迁移）

| 缺口 | 修复方式 | 复验结果 |
|---|---|---|
| G5-R1（P1） | `server/repository.js` 的 `validateRecommendationReferences` 新增 `rec.assessmentId` / `rec.targetId` 与 `gate.capture.riskAssessments`、`gate.capture.allocationTargets` 中同 id 记录的 `canonicalJson` 逐字段比对；不一致即 `invalid_recommendation_record` → HTTP 400 + 事务整体回滚。仍不要求历史资产 / 认可映射等于当前可变事实。 | `reference-review.cjs` **5/5、exit 0**；新增 5 个 `tests/server-phase5d.test.js` 用例（换评估内容、同级换答案、换目标内容、仅改可变事实放行、就地改库读取视图 `invalidCount`）。 |
| G5-R2（P1） | 新增 `Domain.adviceStaleness`（`js/domain.js` 纯函数）：把 `gate.capture` 封存的资产 / 认可映射 / 评估 / 目标与页面刚读到的事实做**身份比对**，返回冻结 reason 码；`js/app.js` 据此把 `data-advice-status` 标为 `stale`、标题改为「历史建议（生成时门禁通过）」、右侧改为「当前已失效 · 需要重新计算」，并列出失效原因与「重新计算」按钮，**不再显示「全部门禁通过」**。慢请求用 `state.factsEpoch` / `state.assetsSig` 守卫：生成期间事实换代的响应直接丢弃；生成成功后立即 `ensureTargetsLoaded` 同步视图，避免拿旧视图误判新建议。估算建议不做身份比对（它从未声称门禁通过）。不重算偏离、不重跑门禁、不改分配算法与 5A 冻结规则。 | `browser-review.py` 两探针转绿：`mappingRevocationProbe` → `adviceStatus=stale`、`unchangedAfterRevocation=false`；`staleQuoteProbe` → `apiCanAdvise=false` 且 `adviceStatus=stale`。新增 12 个 `tests/domain-advice-staleness.test.js` 用例（含与 `server/recommendations.js` 的 `normalizeInput` 同口径交叉验证）。 |
| G5-R3（P2） | `js/app.js` 三处不可达分支渲染**真实用户入口**：风险摘要卡（`card-capacity-vs-willingness`）、配置对照卡（`card-tolerance-band`）、启动失败视图；`knowledgeLinkHtml` 仅在目录中存在该卡时渲染，打开仍走 `Knowledge.getCard`，未注入任何临时按钮。 | `browser-review.py` `offlineProbe`：`knowledgeEntryCount=2`、`serviceWorkerControlled=true`、`catalogLoaded=true`，真实点击后 `#sheet` 打开知识卡正文。 |
| G5-R4（证据） | **未完成，按用户决定延后（2026-09-28）。** 四问理解演练仍无受测者、起止时间、耗时与正确率记录；本轮尝试时发现受测者正式账本为空（`overview.isEmpty=true`），无数据可读。 | 无。**不得据本轮任何结果宣告 5E 演练门槛或 Phase 7 通过**；本报告 §1～§7 的结论继续有效。 |

复验记录（全部离线 fixture、临时库、回环 origin，外部请求 0）：

- `node docs/evidence/phase5-review-20260927/reference-review.cjs` → 5 passed / 0 failed，**exit 0**
- `python3 docs/evidence/phase5-review-20260927/browser-review.py 18785` → **pass**（原 wiring 34/34 + 三项审计探针全绿）；同脚本 18786 另一轮同样 pass
- 全量 `node --test` → **648/648**（631 基线 + 5 个 R1 用例 + 12 个 R2 用例）；受影响定向 **87/87**；记账/导入回归 **79/79**
- `node --check`（js/app.js、js/domain.js、sw.js、tests/*）与 `git diff --check` 通过

§7 的复现命令不变：两条反例脚本当前均 exit 0。**R4 计时证据补齐前，Phase 5 仍不得判定为完整验收通过。**

## 9. 限定范围复验（2026-09-28，用户明确排除 G5-R4）

**结论：按本次明确排除 G5-R4 的范围，Phase 5（5A～5E）的功能、数据一致性和自动化门禁可以通过。** 原定完整验收状态仍保留为「待 G5-R4 实际计时」；这次没有以自动化运行时间冒充人的理解用时，也没有进入 Phase 6。

- 全量 `node --test`：**648/648**，0 失败、0 跳过；[日志](docs/evidence/phase5-review-20260927/full-20260928.txt)。
- 5A～5E 定向与知识卡、过期建议：**159/159**；[日志](docs/evidence/phase5-review-20260927/directed-20260928.txt)。旧记账、导入、去重、金额、备份与 API：**79/79**；[日志](docs/evidence/phase5-review-20260927/legacy-20260928.txt)。这些均为全量 648 的子集，不相加。
- 独立数值校验：**13,312** 组评分、**5,000** 组资金分配通过；R1 引用与恢复反例 **5/5**，退出码 0。
- 两套新临时库与本机浏览器 origin（18801、18802）：原 wiring 各 **34/34**，附加 R2/R3 审计均 `auditPassed=true`、`findings=[]`、外部请求与页面异常均为 0；[第一轮](docs/evidence/phase5-review-20260927/browser-18801.json)、[第二轮](docs/evidence/phase5-review-20260927/browser-18802.json)。撤销映射与行情过期后建议标为 `stale`，明确提示需要重算；断网重载后两个真实入口可点击，打开知识卡正文。
- 涉及的 JavaScript `node --check` 与 `git diff --check` 通过。测试使用虚构 fixture、临时数据库与回环服务，没有触碰私人账本。


## 10. G5-R4 转入 Phase 6 后半程（2026-09-28）

前端优化获用户认可，Phase 6 现已完成拆解、尚未实施。G5-R4 排入 6E-3，在主要页面稳定后真人计时；不阻塞 6A～6D，未通过不得判定 6F 整体验收通过。任务与证据要求见 [PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md) §7，顺序记录见 D-056。

本次未进行计时，§9 的限定范围通过保持有效，Phase 5 原完整验收仍待 R4。后续通过时应追加日期、版本与证据，不能修改历史记录来冒充本轮已经通过。
