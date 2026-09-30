# 变更日志

## Phase 6 6F 最终集成验收（2026-09-30，代码基线仍为 `2.4.26-phase6e` / schema v11）

- **Phase 6 关闭**：6A～6F 全部通过（含 G5-R4）。新增 `tests/server-phase6.test.js` 6F-01～6F-04 集成验收测试（全量 **696/696**）：场景 A / 场景 B 两套完整闭环（多月共存、事件零重叠、备份恢复逐字段追溯）+ 负向电池（暂缓/忽略/跳步/幂等冲突/失效建议/缺汇率/快照损坏/引用缺失/部分失败）。
- 浏览器证据：全新临时库 × 不同 loopback origin × 干净 profile wiring 38 项 × 2 轮（19311、19312）、`browser-review.py` 38 项（19313，外部请求 0、pageErrors 0）、三档宽度 71 项（19314）；证据 `docs/evidence/phase6-6f-20260930/`。
- Phase 5 的 G5-R4 缺口同日关闭（`PHASE5_REVIEW.md` §11 追加记录，历史未改写），**Phase 5 完整验收随之关闭**。未随本阶段关闭的独立事项：4A 行情源门禁、S2.3 实机启动、Phase 7 两个月真实使用验证。

## 2.4.26-phase6e（2026-09-30）

- **Phase 6E「复盘与历史」实施（6E-1 复盘计算与封存 + 6E-2 复盘页面与月度历史）**：契约 §4.3 的六类配置对照以服务端派生 `comparison` 对象进 `GET /api/v1/decisions/{id}` 详情（`comparable` + `timepoints` + 恒 6 行；任一时点快照缺失或不可比 → 全表不出数字、不出伪 0；0 投资池比例列 null 不算不可比；`deltaValueMinor` / `deltaPctBps` = 复盘 − 决策；参照目标固定为决策引用的 `targetRef` 历史版本）。领域层新增纯函数 `decisionReviewComparison` 与形状自检 `validateDecisionComparisonShape`（只消费既有 `computeOverview` / `computeAllocationDeviation` 封存结果，不写第二套估值 / 偏离）；`server/decisions.js` 详情响应接入，输入快照形状不合法时整体 fail closed（400 `invalid_decision_record`）。契约先行：§4.3 末与 §8.4 已补 6E 对照口径（D-057 附属，含 `reviewed_with_drift / reviewed_no_drift` 在不可比时的判定口径）。
- 页面（6E-2）：决策详情新增「配置变化对照（非收益）」区——可比时按六类输出三时点金额 / 比例 / 区间判定与变化量，不可比时按时点给出原因与 blockers，复盘未开始时显示提示而不是空表；`executed` 状态新增「记录复盘」入口（理由必填，服务端判定，复盘后一切只读）；决策历史新增月份筛选（服务端 `eventMonths` 状态事件操作时间月，与状态筛选互为与关系，翻月与复位不丢数据）；时间口径标注分列（证券交易日 vs 关联 / 状态事件操作时间）。
- `executed → reviewed` 转移、复盘快照封存与 `reviewed_with_drift / reviewed_no_drift` 理由码沿用 6B 的同事务实现（零迁移、零状态机改动、零契约业务口径变化）。schema 仍 v11；`APP_VERSION` 与 SW 缓存键递增至 `2.4.26-phase6e`。
- 测试：全量 `node --test` **692/692**（686 + 6E 新增 6 项：`tests/server-phase6.test.js` 6E-01～6E-04、`tests/domain-phase6.test.js` 6E-11/6E-12）。浏览器 wiring **38 项 × 3 轮全绿**（19212、19213、19214；第 38 项覆盖复盘理由必填、复盘后只读、对照表 6 行、禁止收益表述、月份筛选），`browser-review.py` 数量契约同步 **37 → 38**（19221，`externalRequests=[]`、`pageErrors=[]`、三项审计探针通过），三档宽度 **66 页面 + 5 状态 = 71 项**（19215，新增复盘对照弹层三档截图）。证据与复跑脚本见 `docs/evidence/phase6-6e-20260930/`，浏览器审计证据见 `docs/evidence/phase5-review-20260927/browser-19221.json`。
- 6E-3（G5-R4 真人计时）**已通过**：`run_6e3_demo.py` 提供三套互斥变体演示数据（A/B/C，防背答案）与服务端同源标准答案表；受测者 S1 于变体 C 上四题 4/4 全对、自报连续计时 **35 秒 ≤60 秒**，判定通过；第 1 轮（答案全对未计时）、第 2 轮（方向答错）失败记录原样保留于 `docs/evidence/phase6/6e-r4.md`。6F 的 G5-R4 硬门禁已满足。

## 2.4.25-phase6d（2026-09-29）

- **Phase 6D「关联实际交易并记录执行」**：决策详情弹层新增实际交易关联区 —— 候选来自服务端 `GET /api/v1/security-events` 的 `buy` 且未被本决策占用；「新增买入并关联」复用原证券事件录入弹层（`holding:saveEvent` 保存成功后按 `state.decLinkPending` 自动关联，失败只提示「交易已保存，可重新关联」，不重建交易）；活动关联行提供解绑（软删除三列留痕 + 必填理由），已解绑行只读；`accepted` 才渲染「确认执行完成 / 归档」，成功后原地重读详情与事件。关联 / 解绑不复制证券事件、不写 `txns`、不改现金余额。
- 新增 API：`POST /api/v1/decisions/{id}/links`（201 `created`、同事件重复 200 `created:false`）与 `POST /api/v1/decisions/{id}/links/unlink`（200），均过 `checkWrite` + `Idempotency-Key` 指纹幂等（回放 200 + `X-Ledger-Idempotent: replay`，冲突 409）。服务端 `requireLinkableDecision`（决策存在 → 链复核 → 状态 `accepted`/`executed` → 建议存在）+ `createDecisionLink` / `unlinkDecisionLink`；`decisionLinkRecordId` 增加 `occurrence` 参数，重关联按含已解绑行数递增以避免撞既有主键；`server/repository.js` 新增 `insertDecisionLinkRow` / `markDecisionLinkUnlinked` / `getDecisionLinkRow`。
- **契约先行**：实现前把 6D 实现口径补进 `PHASE6_CONTRACT.md`（顶部「2026-09-29 6D 补充」+ §3.4 + §7 + §8.5）——`unknown_decision_link` **422**（linkId 不存在或不属于路径决策，同码）、`invalid_link_target` **409**、`event_already_linked` 409、同决策重复关联 → 200 `created:false`；关联载荷键白名单 `securityEventId`/`note`，解绑 `linkId`/`note`（trim 必填），多键或派生键 → 400 `invalid_decision_payload`。`js/domain.js` 新增 `validateDecisionLinkRequest` / `validateDecisionUnlinkRequest` 并导出白名单常量。
- 测试：`tests/server-phase6.test.js` 新增 6D-01～6D-05、`tests/domain-phase6.test.js` 新增 6D-11/6D-12、`tests/app-wiring.js` 新增第 **37** 项全流程检查（37 个 `await check(`）。全量 `node --test` **686/686**；浏览器 wiring **37 项 × 3 轮**（19102、19103、19104）；`browser-review.py` 数量契约 36 → **37**（原 34 项语义与断言全部保留），19121 轮外部请求 0、`pageErrors=[]`、三项审计探针通过；三档宽度与状态 **68 项**（19111，含关联后详情弹层三档截图）。
- 递增 `APP_VERSION` 与 SW 缓存键至 `2.4.25-phase6d`；schema 仍 v11、**零迁移**；不改 6A 契约的业务口径与 6B 状态机判定。`node --check` 与 `git diff --check` 通过。

## 2.4.25-phase6c-fix2（2026-09-29）

- 6C 复测补口：关闭正在读取的决策详情后若立即打开其他弹层，旧详情响应仍会覆盖新弹层。`closeSheet()` 现在递增 `decDetailSeq`，让已关闭的详情请求失效；第 36 项浏览器 wiring 补入「详情 → 新增账户弹层」的晚到响应反例。
- 最终构建重跑：全量 `node --test` **679/679**、浏览器 wiring **36/36 × 2**（19041、19047）、三档宽度与状态 **64/64**（19043）；19047 的撤销映射、过期行情与离线知识卡审计全绿，外部请求 0。`browser-review.py` 的映射按钮点击与截图改为基于当前页面，避开异步重绘替换节点导致的探针超时。应用版本和 Service Worker 缓存键同步升至 `2.4.25-phase6c-fix2`，schema 仍 v11。

## 2.4.25-phase6c-fix1（2026-09-29）

- **缺陷修复（用户报出）**：详情弹层 `openDecisionDetail` 缺顺序守卫 —— 先开 A 再开 B 时，A 的慢响应最后返回会把弹层内容覆盖回 A；弹层已关闭时晚到的详情还会把弹层重新弹出。属于拆解 §5「慢响应不能覆盖新状态」，此前只覆盖了清单读取（`decRequest`）与提交（`decSubmitSeq`），详情读取漏了。补 `state.decDetailSeq` 单调序号，序号不一致的响应直接丢弃；loading / error body 与详情根节点补 `data-dec-detail-id`，便于断言当前展示的是哪一条。
- 测试：`tests/app-wiring.js` 新增第 36 项检查「6C 决策：详情弹层慢响应不覆盖后打开的另一条，关闭后晚到不重弹」（扣住 A 的真实响应 → 先开 A 再开 B → 释放 A 仍须是 B；读取中途关闭 → 释放后不得重弹）；`browser-review.py` 数量契约按拆解 §9 同步 34 → 36（原 34 项语义与断言全部保留）。全量 `node --test` **679/679**、wiring **36 项 × 3 轮全绿**（18991、18992、18993）、宽度与状态 **64 项**（18994），18993 轮三项审计探针全绿、`externalRequests=[]`。
- 递增 `APP_VERSION` 与 SW 缓存键至 `2.4.25-phase6c-fix1`：静态资源为缓存优先，`sw.js` 自身未变则浏览器不会触发 SW 更新，必须靠 `CACHE` 变更才能让已装上旧 `js/app.js` 的机器取到修复。schema 仍 v11、零迁移，不改服务端状态机与 6A 契约口径。

## 2.4.25-phase6c（2026-09-29）

- **Phase 6C「接受、暂缓、忽略与待执行页面」**：页面只呈现服务端状态、金额与门禁，不重算建议与状态。新增 `decisions` 路由、侧栏与首页入口、决定弹层（来源 / 判定日 / 解释 / 失效提示 / 必填理由 ≤2000 字 / 三个意图按钮）、待执行清单（只列 `accepted`）、历史筛选（含暂缓、忽略）与详情弹层（原建议、决定理由、事件时间线、时点快照折叠入口、解释版本标注）。提交带 `Idempotency-Key`，`decBusy` 与提交序号同时防重复点击与晚到响应；接受仍由服务端重核门禁，页面不预判。
- 状态呈现分别实现：初始空态、读取中（首帧 `data-dec-loading`）、重新读取中（列表旁 `data-dec-reloading`）、读取失败（失败卡 + 重试，**优先于读取中判定，绝不落回空态冒充「还没有决策」**）、提交失败（弹层内错误且决定未保存）、失效建议（接受被拒，暂缓/忽略仍可记录）、服务不可达（本地服务未运行提示，不进入读取分支）。读取用 `decRequest`、提交用 `decSubmitSeq` 顺序守卫，晚到的旧读取返回也只被丢弃，不覆盖已读到的新状态。
- `js/store.js` 新增 `listDecisions` / `decisionDetail` / `createDecision` / `appendDecisionEvent`：过滤参数进查询串、读取不带令牌、写入带会话令牌与 `Idempotency-Key`，服务不可达显式抛错。
- 样式：新增 `.dec-chip` / `.dec-card` / `.dec-snap` 等，长理由、长月份与长 id 换行不挤压按钮；决定弹层按钮行与决定入口行在窄屏换行，`390px` 下无横向溢出。
- 测试：`tests/app-wiring.js` 新增第 35 项检查（三类决定真实可用、刷新一致、重复点击与幂等、失效接受被拒、读取中/读取失败/重试、慢响应不覆盖、估算建议不可决策）；`tests/store-headers.test.js` 新增 2 项 6C 封装契约。全量 `node --test` **679/679**。
- 浏览器验收：隔离临时库 wiring **35 项 × 3 轮全绿**（18944、18945、18960）；`browser-review.py` 数量契约 34 → 35（同日 fix1 再同步为 36），18960 轮三项审计探针全绿、外部请求 0；新增 `docs/evidence/phase6-6c-20260929/` 宽度与状态脚本：18 路由 × 1440/1100/390 + 决定/详情两弹层共 60 项布局，加读取中 / 读取失败 / 重试后空态 / 接受成功 4 项状态，截图与 `width-result.json` 一并留存。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.25-phase6c`；schema 仍 v11、零迁移；不改服务端状态机与 6A 契约口径；`git diff --check` 与 `node --check` 通过。

## 2.4.24-phase6b（2026-09-29）

- **6B 二次复测补口**：修复 `GET /state` 返回被篡改决策快照、SQLite 备份恢复接受该快照的两条漏检路径。全量状态读取与 v11 候选备份现在复用决策链、建议引用、活动关联及快照原文字节哈希校验；列表仍排除坏行并计 `invalidCount`，详情保持 400。损坏候选在切换前拒绝且活库不变；从损坏活库恢复有效备份时仍保留恢复前取证快照，该快照不能作为有效恢复候选。新增 6B-27/28 反例；定向 **18/18**、全量 **677/677**。
- **Phase 6B「状态机、事件、存储与 API」**：按 6A 冻结契约（D-057，含二次复测修正）落地决策状态机。迁移 **v11 `phase6-decisions`** 新增 `decisions` / `decision_events` / `decision_links` 三表（一条建议最多一条决策、事件只追加且 `seq` 连续、活动关联唯一由部分唯一索引承载）；旧库前向迁移后三表为空。
- 新增 API：`POST /api/v1/decisions`（唯一对象是 formal 建议；intent 缺省为两步式 proposed；接受门禁在同事务内重核 `adviceStaleness` + 5D 门禁复放 + G5-R1 引用一致；同建议重复创建自然幂等 `created:false`）、`POST /api/v1/decisions/{id}/events`（501 占位改为真实行为；状态由服务端据当前状态推进，理由码按 §6.3 派生——归档理由按建议金额与关联历史唯一判定）、`GET /api/v1/decisions`（state/month/recommendationId/from/to 过滤 + `invalidCount` 留痕 + 排序与行序无关）、`GET /api/v1/decisions/{id}`（完整事件时间线、关联、决策/执行/复盘/归档快照与合并 timeline）。每次状态事件封存快照（`canonicalJson` + sha256），读取时哈希与 `seq` 链式一致性复核，失败 fail closed。缺交易日汇率时 CNY 汇总与剩余金额为 `null`（绝不部分小计或伪 0），`fxUnavailable` 按交易日与 id 升序。
- 存储与备份：`CLEAR_ORDER` 头插三表；伴随集合 6 → 9（普通五键保存在同一事务保留决策历史，不恢复 GET→PUT 覆盖窗口；显式三集合空数组才是清空）；JSON 备份与恢复贯穿三集合（旧备份缺键恢复空历史）；SQLite 备份 `REQUIRED_*[11]` 登记并新增「部分唯一索引被换成普通索引」的对称拒止；曾被关联（含已解绑）的证券事件不可物理删除（409 `linked_event_missing`）。
- 测试：新增 `tests/domain-phase6.test.js` 10 项与 `tests/server-phase6.test.js` 16 项——含 **49 个有序对数据驱动全遍历**（合法 6 恰好追加 1 条事件、非法 43 整体回滚）、F-A / F-B 两套闭环（F-B 含缺汇率与跨月事件月）、篡改检测（快照字节 / seq 断链 / 状态不一致 → `invalidCount` 留痕、详情 400）、迁移 v10→v11 空表与备份结构校验；既有守卫按契约 §11 逐条更新且只增不减（5A-18 → v11、server-api / server-phase3 的 501 断言改真实路由行为、server-phase5d 表结构、5D-24 边界下移 + 新增 Phase 6 段落守卫、store-headers 九伴随、server-migration v11 结构）。**三项隔离反例驱动修复**：损坏建议（封存哈希不一致）不得创建任何决策（创建改用完整读取复核）；活动关联指向非 buy 事件时列表排除该行并计入 `invalidCount`（§4.5 第 5 条并入共享读取复核），不再整页失败；日期区间按逐事件 `occurred_at` 判断。全量 `node --test` **675/675**。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.24-phase6b`；本轮不改任何页面行为，浏览器 wiring（34 项）留待 6C 页面交付时运行（已于 6C 执行，现为 36 项）。

## 2026-09-29 6A 契约二次复测修正（产品版本不变）

- 修正 F-B 跨月用例：11 月仅关联买入时 `eventMonths` 不变，11 月确认执行后才新增月份；明确月度归属只取状态事件。
- 缺交易日汇率时，关联本金、费用、剩余金额与内部偏差均为 `null`，保留实际关联数及缺汇率事件 id；归档理由改由建议金额和关联历史唯一判定，正金额未买即放弃为 `abandoned`。
- 三时点表去掉非法的 `proposed → archived`，补归档事件独立快照；非法跳转正文计数同步为 43。补充反向验收例，更新 D-057、PRODUCT、ARCHITECTURE、ACCEPTANCE、ROADMAP、README、NEXT_AGENT 与拆解口径。全量 `node --test` **648/648**；零业务代码、零迁移、零页面，6A 修正后交 6B。

## 2026-09-29 6A 契约复核勘误（产品版本不变）

- 独立复核发现并修正冻结契约的六处实现口径冲突（不改四条已确认产品口径；明细见 `PHASE6_CONTRACT.md` 头部与 DECISIONS D-057 勘误）：①状态矩阵计数为完整 7×7 = 49 个有序对（合法 6 / 非法 43，含自转移），原稿 44/38 有误；②`RESTRICT` 外键 + 软删除解绑下，曾被关联（含已解绑）的证券事件一律不可物理删除；③F-A 正向 fixture 本金修正为 20 × 100.00 = 2,000.00；④归档理由首次尝试按关联历史判定，后来被二次复测规则取代（见上节）；⑤零事件 `proposed` 决策为合法空序列、无快照，读取校验豁免链式检查；⑥快照 `reason` 公式补 `available` 判定。计数与语义同步 ACCEPTANCE / ROADMAP / README / NEXT_AGENT / ARCHITECTURE / PHASE6_BREAKDOWN / DECISIONS。
- 零代码改动，全量 `node --test` **648/648**；该次结论后来被二次复测推翻，剩余冲突见上方修正记录。

## 2026-09-28 Phase 6A 规则与契约冻结（产品版本不变）

- 新建 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md)（13 节，6B～6F 的唯一规则来源）：7 状态完整矩阵 49 个有序对状态机（新增终态 `archived`，合法 6 / 非法 43，含自转移）、buy-only 交易关联与分批/偏差/纠错口径、决策/执行/复盘三时点快照结构与完整性复核、迁移 v11 与备份/回滚方案、F-A/F-B 两套正向闭环与 28 条反向 fixture 清单、6B 必须显式更新的守卫测试清单；拆解提出的 8 条歧义全部裁定，未决项 0（D-057）。
- 同步 PRODUCT §9、DECISIONS（新增 D-057）、ARCHITECTURE（6A 契约增量、§5.3 三表冻结、§5.5 不变量、§5.6 API 面）、ACCEPTANCE §8（S6.1～S6.5）、ROADMAP（当前阶段 → 6B）、README / NEXT_AGENT / AGENTS / PHASE6_BREAKDOWN / 本文件。
- 零业务代码、零迁移、零页面、零数据文件；版本保持 `2.4.23-ui-polish`、schema v10，全量 `node --test` **648/648** 无回归。G5-R4 仍安排在 6E-3，是 6F 最终验收门禁。

## 2.4.23-ui-polish（2026-09-28）

- 删除界面、分类/账户展示、提示与导出报告中的装饰表情；选择状态与异常等级改成文字，已有分类资料保持兼容。
- 修复月份标题误用箭头固定宽度导致逐字换行的问题；统一按钮防挤压、搜索框/下拉框缩放、弹层标题、窄屏状态标签与桌面批量归类工具条位置。
- 全量 648/648、浏览器接线 34/34；1440/1100/390px 下 17 个页面共 51 项布局检查通过，月份切换与三类弹层通过。证据见 `docs/evidence/ui-polish-20260928/`。

## 2.4.22-desktop-blue（2026-09-28）

- 按用户要求在 Phase 6 前完成桌面优先的天空蓝前端改版：宽屏侧栏导航、决策台双列布局与资产概览卡、统一卡片/按钮/表单/弹层视觉；窄屏仍保留原五入口导航。未修改领域计算、API、SQLite schema、真实数据或 Phase 6 状态机。
- `APP_VERSION`、Service Worker 缓存键同步更新；PWA 改为允许桌面方向。全量 `node --test` **648/648**，浏览器 wiring **34/34** 且 G5-R1～R3 审计探针通过；桌面与窄屏逐页导航检查无页面异常和横向溢出。证据见 `docs/evidence/desktop-redesign-20260928/` 与 `docs/evidence/phase5-review-20260927/browser-18812.json`。
- G5-R4 实际理解计时仍未完成；本次只接受用户排除 R4 的限定范围验收结论，Phase 6 未开始。

## 2.4.21-phase5g5（2026-09-28）

- Phase 5 验收补口 G5-R1～R3 完成，**G5-R4（四问理解实际计时）未做、按用户决定延后 → Phase 5 仍不判定为完整验收通过**，Phase 6 未开始。
  - **G5-R1（P1）**：`server/repository.js` 的 `validateRecommendationReferences` 新增 `assessmentId` / `targetId` 与 `gate.capture.riskAssessments`、`allocationTargets` 中同 id 记录的 `canonicalJson` 逐字段比对；不一致即 `invalid_recommendation_record`（HTTP 400 + 事务整体回滚）。仍不要求历史资产 / 认可映射等于当前可变事实。`tests/server-phase5d.test.js` **+5**。
  - **G5-R2（P1）**：新增 `Domain.adviceStaleness` / `factSignature` / `mappingSignature`（`js/domain.js` 纯函数，reason 码为冻结词表），把 `gate.capture` 封存的资产 / 映射 / 评估 / 目标与当前事实做**身份比对**；`js/app.js` 据此把历史正式建议标为 `data-advice-status="stale"`（标题「历史建议（生成时门禁通过）」、右侧「当前已失效 · 需要重新计算」、失效原因与「重新计算」按钮），不再显示「全部门禁通过」。新增 `state.assetsSig` / `state.factsEpoch`：生成期间事实换代的慢响应直接丢弃、生成成功后立即同步事实视图；估算建议不做身份比对（从未声称门禁通过）。不重算偏离、不重跑门禁、不改分配算法与 5A 冻结规则。`tests/domain-advice-staleness.test.js` **+12**（含与 `server/recommendations.js` 的 `normalizeInput` 同口径交叉验证）。
  - **G5-R3（P2）**：风险摘要卡、配置对照卡与启动失败视图的服务不可达分支渲染**真实** `know:open` 入口（`card-capacity-vs-willingness`、`card-tolerance-band`），断网重载后 `knowledgeEntryCount=2` 且真实点击打开正文，未注入临时按钮。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.21-phase5g5`；schema 仍 v10、零迁移。全量 `node --test` **648/648**（631 基线 + 5 + 12）、受影响定向 **87/87**、记账/导入回归 **79/79**；反例脚本 `reference-review.cjs` **5/5、exit 0**，`browser-review.py` 18785×2 + 18786 **pass**（原 wiring 34/34 + `mappingRevocationProbe` / `staleQuoteProbe` / `offlineProbe` 三项审计探针全绿，外部请求 0）；`node --check` 与 `git diff --check` 通过。未改 5A 冻结规则、资金分配算法、真实数据与自动行情门禁。
- 注意：`browser-review.py` 断言原 wiring 恰为 34 项，新增行为测试写入 Node 套件而非 `tests/app-wiring.js`。

## 2026-09-27 全阶段独立验证（产品版本不变）

- 新增 `PHASE5_REVIEW.md` 与 `docs/evidence/phase5-review-20260927/`：全量 631/631、定向 142/142、原记账/导入 79/79、原 wiring 34/34 × 2、独立评分 13,312 组及分配 5,000 组。
- 复现 G5-R1 恢复引用矛盾、G5-R2 旧正式建议未标为历史/待重算、G5-R3 服务不可达时知识卡入口缺失；G5-R4 一分钟理解无实际计时。当前验收结论改为暂不通过，下一入口为 Phase 5 补口。
- 产品代码、算法、schema 和真实数据均未改；保留原未提交工作与历史证据。

## 2.4.20-phase5e6（2026-09-27）

- 5E-6 整体验收：`tests/app-wiring.js` 新增 3 项检查（全量 34 项）——①状态矩阵：无正式月结（客户端拒绝、零建议行）、0 元正式（API + DOM 守恒）、分类未确认（翻转未映射有持仓的 theme_equity，估算 + `classification_unconfirmed`）、行情过期（单条报价、staleDay=today-7，估算 + `quote_stale`/`fx_stale`，决策台估算阻塞与新增资金估算角标）；②三层复核：领域 `scoreRiskAnswers` == `/risk-assessments/current`（capacity 5→L2 < willingness 12→L5、上限 2、来源 capacity、无硬封顶），领域重算 `categoryAllocations`/`explainCodes`/`roundingNote`/`deviations` 与库中建议逐字节一致，页面建议 DOM == 重算结果，7 项 gate 与 `Domain.RECOMMENDATION_GATE_CHECKS` 集合相等且全过，追溯四组字段 == 记录，首页风险摘要与配置对照卡逐字段 == API；③一分钟理解演练：`GET /overview` 与 `Domain.computeOverview` 整对象逐字节相等，净资产 / 可投资 / 主要风险暴露 / 新增资金方向四个数值页面与 API 同源，演练观察值以 `DRILL:` 写入运行日志。
- 十态覆盖由新 3 项 + 既有检查共同闭合（空资产 147/188、首次评估 1271、待复评 2083、无目标 2287、无认可标的/正常建议 1619 + 本项 fixture，无正式月结/0 元/分类未确认/行情过期为本项新增）。
- 修复 `GET /api/v1/overview` 判定日口径：与其余端点统一走可注入 `ctx.today`（原为直用服务端本地日，注入固定时钟时与 `/targets/current` 的 blocker 集合错位）。生产进程不注入 `ctx.today`，行为不变；回归网为 `tests/server-phase5c.test.js:334` 的 blocker 集合逐字相等断言（fixture 日期与自然日漂移超过 `MAX_STALE_DAYS` 后即确定性失败，即本轮发现方式）。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.20-phase5e6`，wiring 脚本参数 `?v=5e6`；零分配算法 / 建议写入算法 / 5A 冻结规则 / 目标 API / 映射改动，schema 仍 v10、零迁移。全量 Node **631/631**，定向 5C/5D/5E **28/28**，记账/导入回归 **79/79**；两套干净临时库浏览器 wiring **34/34 × 2**（18673、18674），证据 `docs/evidence/phase5e6-wiring.txt`。5E-6 判定 **5E 与 Phase 5 整体验收通过**；Phase 6 状态机未开始。

## 2.4.19-phase5e5（2026-09-26）

- 5E-5 审计追溯：建议详情新增追溯区，分四组展示——月结基准（月结 id / 快照 id / 快照哈希 / 数据截止，并写明「月结快照是基准，不等同于计算输入」）、计算日输入（判定日 / 完整 `inputHash` / 算法版本 `cash-reallocation-v1`）、版本与记录（建议 id、`payloadHash`、规则 / 目标 / 评估 / 目标 id 版本引用）、解释版本（封存状态与知识卡版本）。
- 新建议在 `gate` 区封存 `explanationVersion`（D-052）：`RECOMMENDATION_GATE_KEYS = ['checks','capture','explanationVersion']`，顶层 `RECOMMENDATION_RECORD_KEYS` 保持 5D 冻结 20 键不变，schema 仍 v10 零迁移；`inputHash` 仍只绑定 capture，打章前后 id / 哈希 / capture 逐位不变，可按原 capture 重放。
- 重复生成绝不倒填：重复判定前剥掉来件 gate 的 `explanationVersion` 再比对，同一输入幂等回到原行（`created:false`），历史记录永不补章；旧建议未封存时页面显式标「当前卡片解释，非生成时封存版本」，已封存则标「本条建议生成时封存」，未封存不计入 `invalidCount`。
- 新增 `tests/server-phase5e5.test.js` 4 例（gate 键契约矩阵、封存打章与身份不变、全量恢复旧记录、同一输入幂等不补章）；wiring C7.11 扩展追溯四组字段逐项核对，并新增第 31 项检查（未封存标注 + 重复生成不倒填）。`APP_VERSION` 与 SW 缓存键升至 `2.4.19-phase5e5`，wiring 脚本参数 `?v=5e5`。全量 Node **631/631**；两套干净临时库浏览器 wiring **31/31 × 2**（18661、18662）。5E-6 整体验收未开始。

## 2.4.18-phase5e4（2026-09-25）

- 新增静态本地知识卡目录 `js/knowledge.js`：15 张卡、稳定 id 与 `EXPLANATION_VERSION`（与 `APP_VERSION` 独立），目录与解释码映射运行时冻结；点名六张（能力与意愿、应急金上限、容忍带、新增资金优先、汇率风险、为何不默认卖出）齐备，风险题卡 `explainKey` 与建议 `RECOMMENDATION_EXPLAIN_CODES` 全量可解。
- 页面按已知 id 渲染 `know:open` 入口，未知 id 或模块未加载不渲染入口；打开时二次校验，未知 id 显式降级为缺卡提示、不展示解释、不给判断。五处挂载：首页风险摘要（取较低一侧 + 硬封顶行）、首页配置对照（容忍带）、首页归因口径（汇率风险）、目标页建议（排序依据 + 默认不卖出）。
- 卡片为离线静态文本，页脚展示解释版本并声明不含账户事实、不构成投资建议；无云端 AI、无外部链接、无收益承诺、无具体证券代码或买卖建议（`tests/knowledge.test.js` 词面守护）。
- 新增 `tests/knowledge.test.js` 8 例；wiring 新增 1 项知识卡检查（全量 30 项），并在 C9.4 / C9.5 / C7.11 / 归因检查中断言真实挂载点与「入口只指向已知卡」。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.18-phase5e4`，`sw.js` ASSETS 增列 `./js/knowledge.js`，wiring 脚本参数升至 `?v=5e4`；零 Domain / API / Store / 分配算法 / 建议写入改动，schema 仍 v10。全量 Node **627/627**；两套干净临时库浏览器 wiring **30/30 × 2**（18643、18644）。5E-5 审计追溯未开始。

## 2.4.17-phase5e3（2026-09-24）

- 独立复核 5E-3：建议类别的服务端计算结果为 0 元时，页面明确显示 0.00，不再以「—」表示，避免把已算出的零误读为缺失。
- 浏览器断言逐类核对可见金额与服务端产物，并要求 fixture 确实包含高配类别；估算态明确拒绝“正式建议”标题。全量 Node 619/619，两套干净临时库浏览器 wiring 均为 29/29。

## 2.4.16-phase5e3（2026-09-24）

- 目标页建议结果块补齐完整解释层：类别排序依据、现金保底/未分配、认可标的与未映射待办、尾差、默认不卖出的具体原因；正式/估算标签与 blocker 直接取 5D 产物。
- 全部字段只格式化服务端 `explainCodes` / `roundingNote` / `categoryAllocations` / `todos` / `blockers`，页面不重算优先级或缺口（不变量 3 / D-025 / D-050）；新增 `ADVICE_EXPLAIN_LABELS` 解释码词表与既有标签表同源。
- wiring 新增 C7.11 断言层：正式态解释层、估算态（篡改产物）、未映射反例（清空 broad_equity 映射后不转投、金额保留、instrument-count=0，再映射恢复）。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.16-phase5e3`；零 Domain / API / Store / 建议算法 / 建议写入改动，schema 仍 v10。全量 Node 619/619；两套干净临时库浏览器 wiring 均为 29/29（18631、18632）。5E-4～5E-6 未开始。

## 2.4.15-phase5e2（2026-09-24）

- 复核 5E-2：无估值时明确写「类别比例不可用」，保留目标区间中的合法 0%；不把缺失的当前比例显示成 0%。
- 浏览器验收补测新评估使旧目标待更新、无评估空态与不可复核记录的界面降级，并收紧六类比例为空的断言。全量 Node 619/619；两套干净临时库浏览器 wiring 均为 29/29。

## 2.4.14-phase5e2（2026-09-24）

- 资产决策台新增只读「配置对照」卡：六类资产的当前金额与比例、目标 min/target/max、偏离与数据日，以及 `canAdvise` 角标与 blocker 原因。
- 无目标、尚未评估、待更新目标、无估值（`no_investable`）、记录不可复核各有独立文案与通往目标页的入口；缺数据时不出现 0% 或「正式口径」。
- 首页数值只搬运服务端 `GET /targets/current`（`Store.allocationCurrent()`），与目标页共用同一份 `state.allocCurrent`，页面不重算比例、偏离或 `canAdvise`（不变量 3 / D-025 / D-050 ③）。
- 复核中标「核对中」并保留上次对照，响应后只 `outerHTML` 替换对照卡，内容未变不动 DOM；读取失败标「未复核」并提供 `alloc:retry` 重试入口，不打断归因基准等既有交互。
- 浏览器 wiring 新增 1 项（全量 29 项）C9.5：覆盖无目标 → 生成目标 → 估算态 → 正式口径 → 无估值 → 慢响应核对中 → 读取失败与重试恢复，逐字段与 `/targets/current` 同源核对。
- 全量 `node --test` 619/619 保持不变（本轮零核心逻辑、零 API、零迁移改动），schema 仍 v10；`APP_VERSION` 与 SW 缓存键升至 `2.4.14-phase5e2`。5E 其余小任务（5E-3～5E-6）未开始。

## 2.4.13-phase5e1（2026-09-24）

- 进入首页复核风险评估时，缓存结论标为「核对中」；读取失败标为「未复核」，避免旧的「有效」角标短暂冒充当前判定。
- 复核响应只更新风险摘要卡，并隔离过时响应，不打断收益归因区。新增浏览器待决态与局部更新断言；全量 619/619，干净临时库 wiring 28/28。

## 2.4.12-phase5e1（2026-09-23）

- 资产决策台新增只读「风险上限」摘要卡：承受能力与风险意愿的双评分及等级、最终上限与「取较低一侧」的来源、硬封顶命中项、评估日与到期日（含剩余天数）、有效状态角标和复评入口。
- 摘要区分无评估、有效、即将到期、已过期四种状态，另加「记录不可复核」与「判定读取失败」两类显式降级；过期或读不到时都不会显示为「当前有效」，缺判定时不显示 L0 或 0 分。
- 首页数值只搬运服务端 `GET /risk-assessments/current` 的判定，页面不重算评分、上限或到期；进入决策台时向服务端复核一次，判定没有变化就不重渲染，避免打断正在进行的下钻选择。
- 浏览器 wiring 新增 1 项（全量 28 项）：四态逐字段与 API、风险页同源核对，并验证摘要卡的复评入口能进入预置原因的空白问卷。
- 全量 `node --test` 619/619 保持不变（本轮零核心逻辑、零 API、零迁移改动），schema 仍 v10；`APP_VERSION` 与 SW 缓存键升至 `2.4.12-phase5e1`。5E 其余小任务（5E-2～5E-6）未开始。

## 2.4.11-phase5d（2026-09-23）

- 修复普通保存删除月结/快照与 JSON 备份遗漏引用历史，恢复校验失败整体回滚。
- 修复池内现金重复计入；转配保留现金下限，不能向现金自身分配。
- 完整封存建议计算输入、算法版本与映射，读取离线重放；跨秒重复请求返回原记录，事实变化产生新记录。旧无 capture 的产物保留但标记未验证。
- 修正 5D 浏览器答案 fixture、页面缓存同步、月结列表等待及决策动作断言；同步 SW 缓存版本。
- 全量 619/619（含 5D 43/43），浏览器 27/27 × 2；schema 仍 v10。5D 完成，5E 尚未开始，详见 PHASE5D_ACCEPTANCE_GAPS.md。


本文件记录小账本各版本面向用户的重要变化。版本号遵循语义化版本；正式发布前使用 `rc` 标识候选版本。

## [Unreleased]

### 修复

- **Phase 4C 证券事件幂等写入原子化**（G4C-7）：事件事实与幂等记录改为同一 SQLite 事务；`Idempotency-Key` 绑定请求指纹，同 key 不同请求体返回 409 `idempotency_conflict`，不再错误回放另一笔事件。
- **Phase 4C 账户边界与全量校验补齐**（G4C-8）：期初和事件只允许关联 `kind=broker` 的证券账户，单条与 `/state` 全量路径共用引用校验，普通账户返回 422 `invalid_account_type`。
- **Phase 4C 事件往返保真**（G4C-9）：未知扩展字段经 `extra_json` 保留；分红/费用的可选 quantity 被校验并保存但不改变持仓；载荷冗余 currency 不再可能覆盖从标的推导的币种。

- **Phase 4B 更新标的不再级联删除后续事实**：单条 instrument 写入从“先删后插”改为原位 upsert，保持持仓快照、证券事件与报价的外键引用。
- **Phase 4B provider 身份绑定与失败语义补齐**：元数据返回代码必须与请求一致，提交交易所与 provider 不一致时返回 `exchange_mismatch`；搜索返回非数组/非法候选时显式报告 `invalid_payload`，不再伪装成“无命中”。
- **Phase 4B 跨市场歧义不再受返回顺序影响**：一个无交易所本地记录对应多个 provider 市场时，任何市场都不与本地合并，本地记录单独保留并报告歧义。
- **Phase 4B 全量写入分类门禁补齐**：`/state` 与单条 upsert 同样限制 `classificationStatus`、`assetClass`、`exposureMarket`；`confirmed` 必须同时具备合法类别和市场，并统一规范化 symbol/exchange/currency。

- **Phase 4A 结果白名单真正落到校验器**：`isValidResult` / `assertValidResult` 现在要求 quote、fx、error 结果恰好只含契约键，拒绝 adapter 夹带 `accountName`、数量、成本、余额或持仓等额外字段；错误 `detail` 必须已经完成单行清洗与长度限制。
- **Phase 4A 时间戳不再接受被 JavaScript 自动归一的伪日期**：显式校验日期、时分秒与时区偏移，拒绝 `2026-02-30T…`、`24:00:00` 和超范围时区；固定时钟沿用同一严格口径。
- **空白 provider 不再冒充来源**：provider 必须在 `trim()` 后仍非空，quote/fx 构造与直接结果校验使用同一口径。
- **纠正 T-002 与 4A 验收状态**：T-002 改为“汇率已定、行情待 4D 前决定”；D-038 只代表启用门禁，不再被写成已经选定行情源。4A 标记为“契约完成、正式验收暂不通过”。

## [2.4.9-phase5c] - 2026-09-21

Phase 5C 独立复核补口，状态保持「等待独立复验确认」，不进入 5D。

- **修复 G5C-7（P1）**：删除 `Store.saveAll` 的客户端 GET→PUT 补回窗口；页面保存改为单次 PUT 声明保留意图，仓储在同一 SQLite 事务内保存未显式给出的风险评估、目标版本与认可标的。显式集合仍覆盖，未带标志的旧备份路径仍按缺键清空。
- **修复 G5C-8（P2）**：认可标的清单重复提交时，同一标的且位置未变会保留原 `updatedAt`；只有新增或真实换位才更新时间。
- **修复 G5C-9（P2）**：`POST /api/v1/targets` 拒绝 `null`、数组、字符串与数字，不再把非对象载荷当作空对象生成目标。
- 新增真实并发回归：旧页面快照之后并发追加复评/目标并调整映射，再保存时三份最新事实逐字段保留。5C 定向 **27/27**、受影响回归 **85/85**、全量 **576/576**、浏览器 wiring **26/26 × 2**（两个全新临时数据库、两个不同 origin）。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.9-phase5c`；schema 仍为 v9，未新增数据源，`recommendations` 仍保持 501。

## [2.4.8-phase5c] - 2026-09-21

Phase 5C「目标配置与认可标的映射」实现完成，自复核缺口 G5C-1～6 全部闭合，等待独立复核。下一阶段入口为 5D。

- 新增迁移 **v9**：`allocation_targets`（一行一个目标版本，**只追加不回写**，自然键 `(assessment_id, template_version, effective_from)` 唯一；`assessment_id` 为 `ON DELETE RESTRICT`）与 `approved_instruments`（资产类别 → 用户认可标的，`UNIQUE(instrument_id)` + `UNIQUE(asset_class, position)`，`instrument_id` 为 `ON DELETE RESTRICT`）。旧库前向迁移后两表为空，不伪造默认目标或认可标的。
- 有效风险评估的风险上限由服务端确定性映射为 5A 冻结的目标区间：`POST /api/v1/targets` 只受理可选的生效日期，等级与 `minBps/targetBps/maxBps` 一律重算；无有效评估 / 已过期 / 记录复核不过分别返回 409 `no_valid_assessment` / `assessment_expired` / `invalid_assessment_records`。
- 当前可投资资产按类别的比例与偏离**复用 Phase 4 的同一遍估值**（只消费 `computeOverview` 的结果，不一致即拒绝）：比例用 basis points 定点整数 + 最大余数法，`ΣpctBps` 恒等于 10000；容忍带沿用 5A 端点含入；投资池为 0 时显式 `no_investable`，不显示成「都在区间内」；缺行情/汇率/分类沿用既有 blocker 与 `canAdvise`。
- 新增「资产类别 → 用户认可标的」映射与整类替换写入：只引用已存在、分类已确认且类别一致的标的，同一类别可有多个候选且顺序即用户优先级；**行情与目录 provider 的刷新/确认路径不写该表任何列**；标的被删或分类回退时映射行保留并显式报失效引用，缺映射只阻止落到具体证券、不阻止显示偏离。
- 新增「目标配置」页面与决策台入口：目标摘要、六类当前值/区间/容忍带/偏离、缺映射与分类冲突提示、候选加入/移除/上移/下移、追加式目标版本历史与只读刷新；页面不重算映射、比例或 blocker 判断。
- **修复 G5C-1（P0，5B 遗留路径）**：页面记账用的五键全量保存配合 `PUT /state` 的「缺键清空」会删除用户的风险评估历史（并会同样删除 5C 的目标与映射）。现在存储门面在提交前按服务端现值补回调用方未显式给出的三份集合，只有「从备份恢复」显式提交整份集合才是覆盖/清空指令；服务端语义与 5B 断言保持不变。
- 修复 G5C-2～6：类别内顺序唯一约束导致「上移/下移」必然回滚（改为整类先删后插并保留 `created_at`）；目标引用缺失评估被外键失败伪装成 500（改为 422 `invalid_assessment_ref`）；生效日期只按形状校验放过 `2026-02-30`（改用真实日历日校验）；目标页候选使用过期的页面资产快照（进入本页先与事实源同步）；比例放缩超出安全整数会静默丢精度（改为 fail closed）。
- JSON 备份与恢复现在携带风险评估、目标版本与认可标的映射（旧备份缺键 → 空集合，结构不是数组 → 显式拒绝）。
- 最终证据：5C 定向 **26/26**、全量 **575/575**、浏览器 wiring **26/26 × 2**（两个全新临时数据目录、两个不同 origin）；schema v9，零真实网络请求。`APP_VERSION` 与 SW 缓存键均为 `2.4.8-phase5c`。
- 范围边界：不接收新增资金金额、不计算买入金额、不生成 recommendation、不做 5D 的正式建议门禁、不做 5E 知识卡、不实现 Phase 6 状态机；未新增数据源、未开启自动行情。

## [2.4.7-phase5b] - 2026-09-21

Phase 5B「风险评估记录与复评机制」完整验收通过，下一阶段入口切换为 5C。

- 新增迁移 v8 `risk_assessments`，保存原始答案、当时规则版本、双评分、等级、硬封顶、风险上限、评估/到期日期与复评原因；复评只追加新行，历史永不覆盖。
- 新增风险评估领域契约与 HTTP API。客户端只提交 `answers/assessedAt/reason`；全部派生值由服务端复用 5A 规则重算，伪造字段、缺答、未知选项、未来日期与规则错配均 fail closed。
- 当前有效评估按 `assessedAt` 降序、`createdAt` 降序、`id` 升序确定性选出；到期日当天仍有效，次日过期；空态区分 `no_assessment/all_expired/invalid_records`。
- 历史列表读取前逐条重算核对；被篡改的派生值不再作为可用历史返回，同时通过 `invalidCount/total` 显式留痕。非法 `asOf` 不再静默回退到服务端今天。
- 新增问卷、结果解释、复评入口与追加历史页面；客观承受能力和主观风险意愿分开展示，明确解释最终上限取较低一侧及硬封顶原因。
- 复核闭合 G5B-1～5：移除 wiring 的 `TEMP-DEBUG` 过滤、修正 `Response.json()` 解析、补齐 D-047 与阶段文档、加固历史读取和 `asOf` 边界。
- 最终证据：5B 定向 **27/27**、全量 **546/546**、浏览器 wiring **25/25 × 2**；schema v8，零真实网络请求。`APP_VERSION` 与 SW 缓存键均为 `2.4.7-phase5b`。

## [2.4.6-phase5a] - 2026-09-20

Phase 5A 最终完整复核通过，下一阶段入口切换为 5B。

- 独立确认 G5A-8/9：异常对象/数组稳定 fail closed，完整评分结果与答案排列无关且不修改输入。
- 修复 G5A-10：当前 `targetVersion` 只接受各等级唯一冻结模板，拒绝同版本下另一套“表面合法”的比例。
- 修复 G5A-11：`newFundsMinor` 及 5A 非负整数入口要求安全整数，拒绝超出 `Number.MAX_SAFE_INTEGER` 的金额。
- 修复 G5A-12：未来评估日期不再被标成有效，统一返回 `invalid_assessment_date`。
- 新增 5A-30～33；旧实现可复现接受换比例、不安全金额与未来评估日。最终 5A 定向 **33/33**、全量 **519/519**、浏览器 wiring **24/24 × 2**。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.6-phase5a`；schema 保持 v7，风险评估 API 保持 501，零迁移、零 API、零页面。

## [2.4.5-phase5a] - 2026-09-20

- 修复 G5A-8：答案行、目标模板顶层、类别映射与比例行统一执行精确自有数据字段校验，拒绝原型链注入、访问器和额外字段。
- 修复 G5A-9：评分答案按冻结题库顺序规范化，相同语义答案无论提交顺序如何，完整评分结果均逐字段一致；不修改调用方数组。
- 新增 5A-28/29；两项指向补口前实现时稳定变红。5A 定向 29/29、全量 515/515、浏览器 wiring 24/24 × 2。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.5-phase5a`；仍为 schema v7、零迁移、零 API、零页面。

## [2.4.4-phase5a] - 2026-09-19

- 修复 G5A-7：认可标的数组只接受普通稠密自有数据索引，拒绝原型索引注入、稀疏数组、访问器和额外属性。
- 复制不再调用实例 `slice()`，异常原型稳定返回错误码而非抛 `TypeError`。
- 新增 5A-27，修复前实现稳定变红；5A 定向 27/27、全量 513/513。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.4-phase5a`；仍为 schema v7、零迁移、零 API、零页面。

## [2.4.3-phase5a] - 2026-09-19

- 修复 G5A-6：`approvedInstruments` 只消费自有类别，拒绝所有自定义原型、不可枚举原型属性与 Symbol 原型属性。
- 新增 5A-26，指向补口前实现时稳定变红；5A 定向 26/26、全量 512/512。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.3-phase5a`；仍为 schema v7、零迁移、零 API、零页面。

## [2.4.2-phase5a] - 2026-09-19

- 修复 G5A-4：目标模板校验补上 `level` 与 `templateVersion` 绑定。
- 修复 G5A-5：建议输入及 `snapshotRef` / `assessmentRef` 执行精确键白名单；`approvedInstruments` 保持可选。
- 新增 5A-23～25；当前 5A 定向 25/25、全量 511/511，反向验证修复前实现时 5A-23/24 必红。
- `APP_VERSION` 与 SW 缓存键升至 `2.4.2-phase5a`；schema 仍为 v7，零迁移、零 API、零页面。

## [2.4.1-phase5a] - 2026-09-19

Phase 5A 第一轮独立复核缺口补口（[`PHASE5A_ACCEPTANCE_GAPS.md`](./PHASE5A_ACCEPTANCE_GAPS.md) G5A-1 / G5A-2 / G5A-3）。三条缺口的共同点是「主路径测试全绿，但反向检查能复现」——因此本轮不只改实现，还补上**改回旧实现即变红**的反例。**仍是零迁移、零 API、零页面**：schema 保持 v7，延后写入登记 `POST /api/v1/risk-assessments` 仍为 501。措辞是「补口完成，等待独立复核确认」，不是「Phase 5 已通过」，也不进入 5B。

### 修复

- **G5A-1（P0）规则常量可被运行时改写 → 同一规则版本下相同答案算出不同结果**：`Domain.RISK_QUESTIONS` / `TARGET_TEMPLATES` / 等级边界 / 硬封顶等对外规则对象此前以可变数组直接导出，调用方一行 `Domain.RISK_QUESTIONS[0].options[0].score = 0` 就能把 15 分变成 12 分，而版本号仍是 `risk-rules-v1`。现在 5A 段落新增 `deepFreezeRisk` 并对 16 个对外规则常量**递归**冻结（覆盖题目 → 选项数组 → 选项、模板 → 类别表 → 类别行、边界条目、各词表）；内部评分与查表逻辑不再消费可写引用。`riskCatalog()` / `targetTemplateForLevel()` 继续返回**可写的深拷贝**（不是冻结视图），调用方改自己的副本不受限制。
- **G5A-2（P1）未知 `targetVersion` 被建议契约接受**：`validateRecommendationRequest` 此前只要求 `targetVersion` 是非空字符串，`risk-targets-unknown` 会返回 `ok:true`。现在要求 `targetVersion === RISK_TARGET_VERSION`，未知 / 空 / 大小写或空格变体 / 与规则版本交叉错配一律 `invalid_target_template`（`ruleVersion` 错配仍是 `invalid_rule_version`）。
- **G5A-3（P1）目标模板的额外资产类别未被拒绝**：`validateTargetTemplate` 此前只逐类检查六个已知类别是否齐备，加入 `crypto` 后仍返回 `ok:true`。现在用 `Object.getOwnPropertyNames(tpl.classes)` 要求类别数量恰为六且全部在 `RISK_CLASSES` 内（挡住 `Object.keys` 看不到的不可枚举键），并拒绝来自原型链的可枚举类别（`Object.create({crypto:…})`）；缺失与额外均返回稳定错误码 `invalid_target_template`。内置五级模板与 fixture 模板仍全部通过。

### 新增

- `tests/domain-phase5a.test.js` 新增 4 项反例（5A-19 / 5A-20 / 5A-21 / 5A-22，5A 定向 18 → **22 项**）：19 条原地修改尝试后评分与查表结果必须不变、规则内容仍须逐字段等于冻结副本、逐层 `Object.isFrozen`、连对外键整体换掉也不得影响内部结果；未知 / 空 / 错配目标版本 17 个反例；模板额外类别（不可枚举键 / 原型链 / 六类全继承 / JSON `__proto__` / 四种异常对象形状）；以及补口零回归（S5.1 冻结样例逐字段不变，S5_2 / S5_3 仍标注承载 5D、5A 不宣称其通过）。

### 变更

- `APP_VERSION` 与 SW 缓存键升至 `2.4.1-phase5a`（复核补口单独占一个版本；`js/domain.js` 是前端缓存资源，必须升版）。

### 证据

- 全量 `node --test` **508/508**（486 项 Phase 1–4E 基线**零回归** + 22 项 5A）、5A 定向 **22/22**，非沙箱实跑；浏览器 wiring **24/24 × 2 轮干净环境**；schema 停在 **v7**；零真实网络请求。
- **反例有效性实测**：把 `tests/domain-phase5a.test.js` 的 domain 指回 `2.4.0-phase5a` 的实现后，5A-19 / 5A-20 / 5A-21（以及被连带污染的 5A-22）**全部变红**，原有 18 项保持全绿——证明新增用例确实锁住了这三条缺口，而不是「怎么改都绿」。

## [2.4.0-phase5a] - 2026-09-19

Phase 5A｜风险问卷与配置规则冻结：在写数据库、API 和页面之前，把「题目、评分、目标区间与版本机制」定成唯一可执行定义（T-004 由「待定」转为「已定」，落地 DECISIONS D-046）。**本版本不建表、不开接口、不改页面**：schema 保持 v7，延后写入登记 `POST /api/v1/risk-assessments` 仍为 501。

### 新增

- **规则数据与纯契约函数**（`js/domain.js`）：9 道题（承受能力 5 题 / 承受意愿 4 题）与 0–3 整数分值；等级 5 级、**下界含入**（能力 0/4/7/10/13，意愿 0/3/6/9/11）；4 条**硬封顶**（应急金不足 3 个月 / 收入不稳定 / 一年内有较大流动性需求 / 近期应付款或负债压力高 → 上限 ≤ 2），**只降不升、优先于总分**；5 级目标模板（六类资产类别 `minBps/targetBps/maxBps`，Σtarget 精确 100%，**个股 target 恒为 0**，D-018）；容忍带 `below_min / within / above_max`（**端点含入区间**）；复评词表与 365 天 / 30 天有效期（**市场涨跌不在词表内**，到期日当天仍有效）；建议输入 / 输出契约与「缺口降序 → 同缺口按固定类别序」的尾差规则。
- **可执行校验**：`validateRiskAnswers` 对缺答、未知题目、未知选项、重复回答返回稳定错误码，错误 detail 只报「第 N 项」不回显输入原文；`scoreRiskAnswers` 走同一道闸，并用 `ceilingSource` 说明上限由哪一侧决定；`assessmentValidity` 不读系统时钟；`validateTargetTemplate` 对缺类别、比例倒挂、Σtarget ≠ 100% 一律拒绝。
- `tests/fixtures/phase5-risk-rules.json`：规则冻结副本 + S5.1 / S5.2 / S5.3 样例 + 19 条边界与反例矩阵（标注承载子阶段）。
- `tests/domain-phase5a.test.js`：18 项，含范围守卫（迁移停在 v7、`server/api.js` 未新增风险路由、5A 段落无网络与随机、不读系统时钟）。

### 变更

- `APP_VERSION` 与 SW 缓存键升至 `2.4.0-phase5a`（`js/domain.js` 是前端缓存资源，必须升版）。

### 证据

- 全量 `node --test` **504/504**（486 基线零回归 + 18 项 5A）、5A 定向 **18/18**，非沙箱实跑；浏览器 wiring **24/24 × 2 轮干净环境**；schema 停在 **v7**；零真实网络请求。当前措辞是「规则冻结完成，等待独立复核确认」，不是「Phase 5 已通过」。

## [2.3.13-phase4e] - 2026-09-19

闭合 Phase 4E 第二轮复核发现的 P1 完整性缺口：决策台读取快照时未校验原文哈希，篡改后的封存明细可能参与收益归因，而页面仍展示旧哈希。

### 修复

- `GET /api/v1/close-snapshots/:id` 现在按 `payloadJson` 原文复算 SHA-256，返回 `hashValid` 与 `integrityStatus`；正常快照为 `true / valid`，内容与封存哈希不一致为 `false / mismatch`。
- 决策台只有收到明确的 `hashValid:true` 才使用 `attributionPositions`；不一致或完整性结论缺失时 fail closed 为 `baseline_hash_mismatch`，positions、归因 rows 与合计均为空。
- 新增真实 HTTP 篡改断言与浏览器 wiring 反例。全量 **486/486**、4E 定向 **34/34**、浏览器 wiring **24/24 × 2**；schema 保持 v7，零新数据源、零迁移。

## [2.3.12-phase4e] - 2026-09-19

闭合 Phase 4E 独立复核（第 1 轮）发现的 P0 财务口径问题 **G4E-1**：封存快照没有真正作为归因基准——上一版只从上一份快照读日期、ID 与哈希，期初腿仍从当前数据库按历史日期重算，结账后回填旧业务日期的价格/汇率会改写已结账月的归因结果（复核复现：期初价 50.00 → 40.00、价格影响 350.00 → 1050.00）。D-045 已增补为「期初腿只认封存明细」，本版本是唯一合规实现（证据与逐条修复状态见 `PHASE4E_ACCEPTANCE_GAPS.md`）。

### 修复

- **快照封存「基准月末时点的逐持仓明细」**：新增 `Domain.computeAttributionBaselinePositions(assets, asOf)`（数量 = `holdingsAsOf` 基准月末重放；价格/汇率 = as-of 查询，**绝不取业务日期在未来的行**），结账时封存进快照 payload 新键 `attributionPositions`（纯追加，旧快照照旧可读）。它刻意区别于 `checklist.facts.holdings`——后者是 Phase 3「结账时点最新价」口径，可能含当时已可见的未来价格，不能做期初。
- **期初腿只认封存明细**：`computeReturnAttribution` 的期初数量/价格/汇率全部来自 `baseline.positions`（`Domain.baselinePositionsFromSnapshot` 是唯一提取实现，结账路径与前端基准切换共用）；领域层不再存在「从当前事实表重算期初」的路径。
- **基准快照先校验再使用**：结账重算路径读取基准快照**原文**，sha256 与封存 `payloadHash` 一致才提取明细。
- **前端基准切换读取对应快照内容**：决策台归因卡异步读取选中基准的封存明细（加载态 → 就绪后才出数字），并修掉「拿 closeId 误当快照 id 请求」导致的 404。

### 边界显式化

- `unavailable` 扩展为三种，`rows` 均为空、界面各有文案、绝不倒算：`no_baseline`（无更早结账月）/ `baseline_details_missing`（快照没有 `attributionPositions`，如旧版本快照）/ `baseline_hash_mismatch`（快照内容与封存哈希不符）。
- 「缺期初汇率」语义**被本节取代**：手动汇率被顶掉后，期初汇率取封存值（上一轮会给出 `missing_start_fx`）；真实缺封存明细的情形由 `baseline_details_missing` 表达。
- 回填旧业务日期证券事件：早于期初快照日的事件按 D-042 ⑦ 视为已含在封存数量内（不进期间事件计数）；窗口内重录期初仍显式 `opening_rebased`，数量跳档不进价格/汇率影响。

### 证据

- 全量 `node --test` **486/486**（上一轮 478 零回归 + 4E 新增 8：领域 25、真实 HTTP 9），非沙箱实跑。
- 浏览器 wiring **23/23 × 2 轮**（干净环境连续两轮；归因场景新增「回填旧价格后期初价格日期仍等于封存值」断言）。
- 复核复现链路（回填 8-31 价格 40.00 → 期初仍 50.00、归因 405.00 不变）固化为真实 HTTP 反例；直接篡改快照 payload → `baseline_hash_mismatch`。
- 零新数据源、零迁移，schema 停在 v7。

## [2.3.11-phase4e] - 2026-09-18

Phase 4E「估值下钻与收益归因」：资产决策台现在能回答两个此前答不出来的问题——① **这个总额是怎么加出来的**（按机构 / 币种 / 资产类别 / 敞口市场四个维度，且每笔持仓用的是哪天的价格、哪个来源、哪天的汇率都写在页面上）；② **这个月赚的钱里多少来自证券涨价、多少来自汇率**（期初取自已结账月快照，且「价格影响 + 汇率影响」恒等于估值变化）。**零新数据源、零迁移**：期初基准直接复用 Phase 3 已封存的月结快照，schema 停在 v7（D-045）。

### 新增

- **估值下钻（四维度 + 逐持仓追溯）**：`Domain.computeAssetDrilldown` 从 `valueAssetItems`（`computeOverview` 抽出的**同一遍**估值）派生机构 / 币种 / 资产类别 / 敞口市场四个分组，并**自报**四项合计数与「是否与总览吻合」——「下钻合计 == 总览」因此是构造性成立的，页面不再各写一套容忍判断。缺汇率的持仓留在组内并标注未计入数量（不静默消失）；未填敞口市场进「未填写敞口市场」桶（不冒充任何真实市场）；负债不进资产项维度。另出逐持仓追溯表：数量 / 价格 / 价格日 / 来源 / 汇率 / 汇率日 / 来源 / 折 CNY。
- **收益归因**：`Domain.computeReturnAttribution` 把持仓的 CNY 估值写成 `V = Q × P × R`，**证券价格影响 =（期末本地币值 − 期初本地币值）× 期初汇率**，**汇率影响取残差**，于是「价格影响 + 汇率影响 = 估值变化」逐行恒等，不留「归因不出来的差额」（整数最小货币单位，全程不经浮点）。
- **期初基准 = 已结账月快照**：月结快照新增 `attribution` 字段（**纯追加**，旧快照照旧可读、哈希照旧可复核），基准取**上一个已结账月**、`asOf` 即其数据截止日，并回显 `closeId` / `snapshotId` / `payloadHash` 供事后追溯（与 D-034 ③「结账口径以封存事实为准」同纪律）。决策台提供期初基准选择器，可换到更早的结账月重算。**已被上方 2.3.12 补口取代：本版本的期初腿仍按历史日期从当前事实表重算，属 P0 缺陷（G4E-1）；现期初明细封存于快照 `attributionPositions` 键并经哈希校验后读取。**
- **决策台新增「估值下钻」与「收益归因」两个区块**；结账快照列表统一惰性加载一次、决策台与结账页共用同一份。前端 `APP_VERSION` 与 SW 缓存键升至 `2.3.11-phase4e`。

### 修复与边界

- **没有可比的已结账月时整段不出归因**：宁可显示「还没有可比的已结账月」，也不用「期初数量 = 0」编一个假基准 —— 那会被读成「你当时没有持仓」。
- **缺价格或汇率时绝不插值、不按 1:1 兜底、也不用期末值顶替**：只给估值变化、不做分解，并把卡在哪条边界上写清楚（缺期初价格 / 缺期初汇率 / 期间买卖 / 期间清仓 / 期间重录期初 …）。
- **「分解不了」与「算不出变化」是两件事**：有过不去的边界时照样给出估值变化额，只是不做分解。
- **as-of 查询绝不返回未来行**：期初腿与期末腿同一套查询语义，重算旧月份必然得到同一结果，结账之后才发生的行情或事件不会进往期；在「今天」这一点上，期末腿与决策台当前估值逐分一致。
- **归因不新增第二套「能不能给正式建议」的判定**：`canAdvise` / `valuationStatus` 仍由总览独占，行情或汇率过期只作为提示写进归因行。
- **手动汇率只有「当前一行」的后果如实标注**：手动登记通道按币对唯一（先删后插），跨月归因因此常见「缺期初汇率」——这是如实说明而不是缺陷；要留历史汇率请走 provider 通道（启动时自动更新汇率）。**已被上方 2.3.12 补口取代：期初汇率现取封存快照明细里的值，不再按当前事实表重查。**

## [2.3.10-phase4d] - 2026-09-17

Phase 4D「日终行情、汇率与失败兜底」：`market-data/refresh` 不再是 501。此前行情与汇率没有写入路径，只能靠手动补价与手动汇率各写一行。本版本落地「汇率自动更新（Frankfurter pin ECB 端点）+ 行情手动补价兜底 + 失败保留最后有效值」的完整链路（D-044）。**行情自动抓取默认关闭**：2026-09-17 逐条复测后没有任何候选能同时满足 D-038 的六条启用门禁，因此本版本交付的是"门禁就绪但未开启"——编排/仓储/前端全部到位，门禁通过后只需接入 provider 并翻转服务端开关。

### 新增

- **汇率自动更新**：`server/providers/frankfurter.js` **pin ECB 端点** `/v2/providers/ecb/rates`（D-036；默认端点是多来源混合值，实测同日数值不同）。五类错误码映射、HTTP 状态映射、定点精度校验、超时中止（AbortController）一应俱全。
- **手动补价兜底**：`POST /api/v1/quotes`——行情源不可用或未覆盖时唯一的事实入口，来源固定记为 `manual`（不接受调用方用别的方式绕过来源标记，否则手动值会被后续自动更新当成可覆盖行）。同一（标的, 价格日）再次补价为**替换**而不是并存。
- **行情与汇率刷新编排**：`server/market-data.js` 的 `refreshMarketData` 把「取数 → 契约校验 → 合并 → 落库」串成一条链路，返回**逐作用域报告**（`status` ∈ `updated | partial | failed | skipped`、`requested` / `updated` / `skipped[]` / `errors[]`（含 `retryable`）/ `attempts`）。有限重试 `MAX_ATTEMPTS=2` **只在整批失败且至少一个错误可重试时**整批重发（部分成功时重发会重复消耗限额并二次写入已成功项）。
- **Keychain 惰性读取**：`server/providers/keychain-key.js` 只返回"有没有配好"的布尔状态供接口展示，**绝不返回密钥内容**，也不进入 argv、数据库、前端或日志；门禁关闭时一次都不读。
- **迁移 v7** `phase4d-quote-source-symbol`：`quotes` 新增 `source_symbol`，承载 provider 返回的原始代码（追溯要求）。**只加列、不加索引**：元素键由写入路径强制，不提升为数据库唯一索引（v1 的 `uq_quotes_dedupe` 允许同一价格日不同 provider 并存，收紧会拒绝合法历史状态）；`backup.js` 的按版本必需列清单同步登记。
- **资产页「行情（收盘价）」区块**：逐标的卡片显示价格、价格日、来源与新鲜度，含手动补价入口、启动时自动更新汇率开关与刷新入口；手动补价弹层经 `js/store.js` 门面访问服务。

### 修复

- **自动更新不再抹掉用户手工确认过的价格/汇率**（D-044 ②）：`manual` 行是用户显式事实，自动源不得写入**同一天或更早**的观测（跳过原因 `manual_locked`），修订了"手动锁只看同一元素键"的初版实现——报价与汇率现在同一口径，历史库里同一价格日并存两 provider 时也不会漏掉 manual 行。更新的数据日仍可写入，手动值不会被永久挡住。
- **外部不可达不再伪装成本地故障**（D-044 ④）：超时/限额/鉴权/传输失败一律返回 200 + `ok:false` + 逐作用域 `errors`（含 `retryable`），前端因此能显示"这次没成、用的是上次的值"，而不是把 DNS 失败显示成程序错误。
- **失败路径绝不改动任何已有行**：超时、限额、缺标的、不可入账数据与未请求的标的全部只报告、零写入。不可入账数据（负价格、汇率 `'0'`）与"provider 返回非数组"一律在落库前被契约校验拦下；provider 返回未请求的代码显式拒绝写入，不得张冠李戴。
- **请求产物只含公开代码**（D-020）：provider 只收到公开证券代码/币对与 `{now, asOf}`，刷新报告里也不含账户名、余额、数量与成本。

### 验证

- `node --test` **441/441**（411 基线零回归 + 4D 新增 30 项：编排层 fixture 22 项覆盖成功/断网/超时/限额/缺标的/节假日回退/不可入账/未请求标的/手动锁/元素键替换/Keychain 路径/请求产物隐私，真实 HTTP 7 项覆盖汇率写库、门禁与开关、手动补价、失败不覆盖、备份往返，Keychain 行情 Key 路径 1 项）；浏览器 wiring **21/21**（干净环境连续两轮全绿）。
- 数据库 schema 版本 v6 → **v7**；`market-data/refresh` 已实现；自动测试**零真实网络请求**（真实网络只用于人工门禁取证，原始输出记入 `server/providers/SOURCES.md` §8）。

## [2.3.9-phase4c] - 2026-09-17

闭合 Phase 4C 独立复核**第一轮**发现的 3 项 P0 与 3 项 P1（全量写入期初不变量、期初修改重放、期初日期边界、日历日校验、备份必需列）。**不新增业务能力**，只把"应用层约定或静默容错"升级为"可拒绝的硬约束"。原始结论清单与逐条修复状态见 `PHASE4C_ACCEPTANCE_GAPS.md`（原文保留作证据）。

### 修复

- **修改期初不再可能制造矛盾账本**（G4C-2）：期初快照写入（新建与更新同路径）后，必须在**同一事务内**用 strict 模式对全部既有事件做全时间线重放——把期初从 10 改成 5 而账上已有卖出 8 时，接口返回 409 `insufficient_holdings` 并整体回滚，不再留下"数据库有卖出 8、持仓视图却只剩 5"的矛盾事实。
- **`PUT /state` 不再绕过期初唯一性与逐条校验**（G4C-3）：抽出与单条 upsert 共用的 `validateOpeningRow`，全量写入改为两遍写入——缺 id 的期初从"静默丢弃"改为 400 `invalid_id` 整体拒绝，同 id 与同（账户, 标的）在第一遍即拒、绝不静默丢行或变形落库；迁移 **v6** 同时给 `portfolio_openings` 建 `(account_id, instrument_id)` 唯一索引 `uq_portfolio_openings_dedupe` 作为数据库兜底（迁移前查重复数据，发现即显式失败，不替用户挑行）。连带把 `unknown_account` / `unknown_instrument` / `invalid_amount` 补进领域错误码 → HTTP 状态映射，全量写入路径的冲突不再误报 500。
- **期初日期边界冻结**（G4C-4，D-042 ⑦）：`deriveHoldings` 不再把所有事件无条件叠加在期初之上——`occurredAt` **严格早于**期初 `asOf` 的事件视为已包含在快照数量内，不重复叠加、不进计数与活动时间戳，记入持仓的 `boundarySkippedEvents` 留痕可追溯；期初日**当天**及以后的事件正常叠加，"今天录期初、今天再记账"不受影响。期初快照数量的口径自本版本起明确为**期初日日初数量**。
- **不存在的日历日期一律拒绝**（G4C-5）：日期校验从"形状正则"升级为真实日历日校验（与 provider 契约同一口径），`2026-02-30`、`2026-13-01` 在期初快照与证券事件两条路径都被 400 拒绝。
- **备份校验覆盖承载事实的必需列**（G4C-6，D-040 延伸）：`validateBackupFile` 新增按版本必需列清单（v5+ 要求 `security_events.amount_minor`）——此前删掉该列的 v5 库仍被判合格，恢复后迁移器不会补列、读取分红/费用事件时才炸；现在这类库被挡在切换之前。v6 的期初去重索引同步登记进必需索引清单。
- **现金口径边界固化**（G4C-1）：S4C.1 的"买卖影响现金"措辞与 D-042④「现金由余额单元人工核对（D-034）」存在矛盾，经复核者与用户确认按后者收口——证券事件**不自动改写**现金余额单元，新增测试固化"事件写入后现金余额单元保持人工核对值不变"（见 ACCEPTANCE S4C.1 修订）。

### 验证

- `node --test` **407/407**（397 基线零回归 + 复核反例 10 项：真实 HTTP 6 + 领域 3 + 备份 1）；浏览器 wiring **18/18**（连续两轮全绿）。
- 数据库 schema 版本 v5 → **v6**；`market-data/refresh` 仍 501；零真实网络请求。

## [2.3.8-phase4c] - 2026-09-16

Phase 4C「持仓账本与证券事件」：持仓与证券事件的完整写入链路（D-042）。此前 `security_events` 表只有读取视图、没有任何写入路径；本版本落地期初快照与买卖/分红/费用事件的录入、推导与追溯。**不接真实行情**：`market-data/refresh` 仍 501，行情源要等 4D 通过 D-038 门禁。

### 新增

- **持仓数量只有一份推导实现**（D-042 ①）：`js/domain.js` 新增 `deriveHoldings`（服务端与浏览器共用）——数量 = 期初快照 + Σ买入 − Σ卖出；分红/费用只记金额、绝不改数量；买入可以没有期初快照（从 0 起算）；事件按 `occurred_at` 升序重放。决策台总览、月结核对清单与 `GET /holdings` 三处共用同一推导，无事件时与期初快照口径完全一致（零回归）。
- **期初快照接口**：`POST /api/v1/portfolio-openings`——同一（账户, 标的）只能有一行期初事实（重复 → 409 `duplicate_opening`），同 id 重复提交为幂等更新。（注：本条当时只在单条接口生效，全量 `PUT /state` 路径的绕过已由上方 2.3.9 补口取代）
- **证券事件接口**：`POST /api/v1/security-events`（支持 `Idempotency-Key` 回放首次响应）与 `GET /api/v1/security-events`。事件类型固定 `buy/sell/dividend/fee`；同 id 重放 → 409 `duplicate_event`（明确拒绝，不静默吞）；卖出超过当时持有数量 → 409 `insufficient_holdings`（写入前在事务内按时间线全量重放校验，失败整体回滚）；未知账户/标的 → 422。
- **分红/费用有了自己的金额列**（迁移 v5）：`security_events` 新增 `amount_minor`（分红/费用总额）与按（账户, 标的, 日期）的事件重放索引；`price_minor` 只存每股价格，不再借用字段。
- **持仓页新增「持仓与证券事件」区块**（资产录入页内）：期初快照弹层、事件弹层、推导持仓卡片（显示持有数量、期初、买卖/分红/费用计数、最近事件）与可溯源的事件流水；标的分类未确认时允许录入并提示"正式估值会被阻塞"（§10 阻塞语义，不是拒绝录入）。

### 修复

- **证券事件绝不进入现金流**：事件只落 `security_events`，`txns` 保持不变——同一笔钱不会在持仓和收支里各计一次。
- **币种由标的推导**：事件行的币种取标的 `currency`，不采信载荷冗余字段（与 D-034 同口径）。
- **错误码集中归位**：`upsertFail` 接入领域错误码映射——重复/冲突 409、未知引用 422、领域校验 400、未预期异常 500，前端能区分"写入被拒"与"服务出错"。

### 验证

- `node --test` **397/397**（371 基线零回归 + 领域 16 项 + 真实 HTTP 10 项）；浏览器 wiring **18/18**（连续两轮全绿，新增持仓录入闭环与"全量写回不抹掉事件"反证）。
- 备份恢复往返无损：恢复后事件与推导数量精确还原；全量 `PUT /state` 与单条写入同一套校验，非法事件整体拒绝回滚。（注：事件侧属实，但期初侧当时未达到"同一套校验"，已由上方 2.3.9 补口取代）

## [2.3.7-phase4b] - 2026-09-16

闭合 Phase 4B 独立复核**第二轮**发现的 3 项 P1 边界缺口（全量写入校验、备份结构校验的不变量覆盖、检索合并的退化匹配）。同样**不新增业务能力**，只把"静默容错"改成"显式拒绝或显式报告"。原始结论清单与逐条修复状态见 `PHASE4B_ACCEPTANCE_GAPS.md`（第二轮小节，原文保留作证据）。

### 修复

- **全量写入不再静默丢弃或接收非法标的**（`repository.writeInstruments`）：此前先用 `.filter(i => i && i.id)` 把没有 id 的标的悄悄扔掉、把空白 `symbol` 写成空字符串 —— 用户看不到任何错误，数据却少了。现在改为两遍写入：第一遍逐条验证并归一（id 必填且形状合法、`symbol` 去空白后必须符合公开证券代码形状、`currency` 必填且在白名单内、记录必须是对象），第二遍校验去重键后才插入；任一条不合格立即抛错，由 `writeState` 的事务整体回滚（不是"先清后写留下空库"）。`invalid_instrument` 补进领域错误码 → HTTP 状态映射（400）。
- **备份与恢复的结构校验覆盖索引级不变量**（`server/backup.js` + `server/db.js`）：此前只按版本检查"表齐不齐"，手工 `DROP INDEX uq_instruments_dedupe` 后 `schemaVersion=4` 的库仍被判定合格 —— 而迁移器看到 v4 已应用不会重建索引，恢复后这个库会静默失去去重不变量。现在新增按 version 维护的必需索引清单（v4：`uq_instruments_dedupe` 必须存在**且唯一**）与 `dbm.indexInfo()`（存在性 / 所属表 / 唯一属性；属性读不到按"不唯一"处理 —— 宁可拒绝也不放过），`validateBackupFile` 逐条校验；恢复通道复用同一校验，缺索引的候选备份直接拒绝恢复且当前库不受影响。
- **检索合并复用建立路径的安全退化匹配**（`server/instrument-catalog.js`）：此前只按精确 `(symbol, exchange)` 合并，本地 `VOO@`（缺交易所）与参考数据 `VOO@NYSE` 会同时出现在候选列表里。现在抽出 `matchLocalRecord()`，与 `repository.findInstrumentByKey` 同一套规则：精确命中 → 同代码且一方缺交易所时唯一命中可安全合并 → 多命中或"同一条本地记录被两个市场认领"时报 `ambiguous_instrument` 且不合并。合并只补空的展示字段，且**不进入 `suggestions`**（预分类依据必须仍指向 provider）；检索保持只读，不改写本地事实。

### 备注

- 测试基线 `node --test` 357 → **367**（`instrument-catalog` 40→44、`server-phase4b` 15→17、`server-backup` 16→19、`server-restore` 8→9），浏览器 wiring 16 → **17**（新增"缺交易所标的与参考数据合成一条候选"的真实 UI 闭环，连续两轮全绿）。零数据库迁移（停在 v4）、零真实网络请求。
- 4B 状态：**第二轮补口完成，等待独立复核确认**。

## [2.3.6-phase4b] - 2026-09-16

闭合 Phase 4B 独立复核发现的 3 项阻塞问题（2 项 P0：标的身份与去重可被绕过；1 项 P1：跨市场同代码被静默合并）与 1 项文档-实现一致性冲突。**本次不新增任何业务能力，只把既有语义从"应用层约定"升级为"可拒绝的硬约束"**。原始结论清单与逐条修复状态见 `PHASE4B_ACCEPTANCE_GAPS.md`（保留原始记录作证据）。

### 修复

- **标的身份只能由服务端派生**：`parseCreatePayload` 遇到客户端指定的 `id` 一律返回 `client_id_forbidden`（400），**显式拒绝而不是静默忽略** —— 悄悄改写客户端提交的身份字段会让它以为存的是另一个值，4C 的账户就会引用一个不存在的身份。`createInstrument` 去掉 `v.id` 分支，id 只按 identity key 派生；错误响应不回显客户端提交的 id。
- **去重键在所有写入路径上成立**：`repository.writeInstruments`（`PUT /state`、JSON 恢复、备份还原）写入前按领域同口径（去空白 + 大写、缺交易所计空串）预校验去重键与 id，发现重复**整体拒绝**并抛 `duplicate_instrument`，由事务回滚保证"写入被拒 = 数据没动"；此前只有目录接口遵守这条不变量。
- **数据库层兜底（迁移 v4）**：新增表达式唯一索引 `uq_instruments_dedupe`，把"同一标的只有一行事实"变成数据库不变量。迁移前检测历史重复数据，**存在重复即显式失败**（列出 `symbol@exchange` 与修复建议）而不是替用户挑选保留哪一行；只新增索引、不新增表，`backup.js` 必需表清单不变。
- **冲突类错误不再被报成 500**：新增领域错误码 → HTTP 状态的集中映射，`PUT /state` 遇到重复/歧义标的返回 **409**（客户端可修正的冲突），前端因此能区分"这次写入被拒、数据没动"与"服务端出错"。
- **缺交易所时不再静默合并跨市场同代码**：`findInstrumentByKey` 收集全部退化候选，多于一条时抛 `ambiguous_instrument`（HTTP 409 + 提示"请指明交易所"），不再按数据库行顺序选中第一条；只有一条同代码记录时仍允许补全交易所，"先手工建标、后由 provider 补全"的既有路径未被破坏。
- **稳定 id 语义确定为"首次创建即永久锁定"**：id 由首次创建时的 identity key 派生，记录持久化 `identityKey`（新增 `stableIdFromKey` / `identityKeyOf`）；即便之后补全了交易所，id 与 `identityKey` 都不重算，外部用 `identityKey` 离线复算即可。文档不再声称"用当前交易所可重算 id"。**边界**：全量 `/state` 与备份恢复通道仍原样还原既有 id（历史快照带 4B 之前的旧形状 id，强制派生会破坏备份往返保真），该通道的强约束是去重键。

### 备注

- **D-039 ① ② 已按要求改写**（id 派生规则、跨市场歧义处理、去重键的强制层级），并新增边界说明；ARCHITECTURE §5.2、ACCEPTANCE S4B.1、ROADMAP 4B、README 同步。
- 测试基线 `node --test` 344 → **357**（`instrument-catalog` 33→40、`server-phase4b` 11→15、`server-migration` 14→16），浏览器 wiring 保持 **16/16**（连续两轮全绿）。新增迁移 **v4**。
- 4B 状态：**补口完成，等待独立复核确认**（复核前为"暂不通过，不建议进入 4C"）。
- **已被上方 `2.3.7-phase4b` 取代的部分**：本版 `writeInstruments` 只校验 id 形状与去重键（缺 id 的行被静默过滤、空白 `symbol` 会被写成空串）；备份结构校验只按版本查表、不查索引级不变量（删掉 `uq_instruments_dedupe` 仍判合格）；检索合并只按精确去重键合并（本地缺交易所的标的会与参考数据重复展示）。

## [2.3.5-phase4b] - 2026-09-16

交付 Phase 4B「标的目录与分类确认」（ROADMAP 4B、ACCEPTANCE S4B.1）。本阶段**不创建持仓**：`POST /api/v1/portfolio-openings|security-events|market-data/refresh` 仍返回 `501`（属 4C/4D）。零数据库迁移、零真实网络请求。

### 新增

- **标的检索与服务端编排**（`server/instrument-catalog.js`）：本地已建标的与 provider 候选按去重键 `symbol@exchange` 合并成唯一候选列表；provider 整体失败时**仍返回本地命中**并显式报告 `provider.status`（"没搜到"与"这次调用失败"可区分）；冲突清单逐条附带 provider 候选值与 provenance。纯编排模块：不碰 HTTP、不读系统时钟（时间由 `ctx.now` 注入）、不发真实网络。
- **标的参考数据契约**（`server/providers/contract.js` 纯新增）：`serializeSearchRequest` / `serializeMetadataRequest` 的产物键集合恒为 `{query}` / `{symbol}` —— 调用方即便传入对象或夹带私有字段也无法把账户名、数量、成本带进对外请求；新增 `instrumentResult`（字段严格按 D-037 映射，`asset_class` / `exposure_market` / 跟踪指数**不在契约内**）与 `makeProvenance`（`{provider, endpoint, sourceVersion, sourceRef, fetchedAt, payloadHash}` 六字段齐备、形状受限）；`isValidResult` 增加 `kind === 'instrument'` 分支，要求键集合精确匹配。
- **离线参考数据 fixture**（`server/providers/fixture.js` 扩展）：新增 `CATALOG` 数据集（VOO / 0700.HK / 2800.HK / 510300.SS 覆盖美/港/A 三市场，另有上游字段全缺的 `MYSTERY.ETF`、币种非法的 `BADMETA.ETF`、鉴权与超时场景）与 `searchInstrument` / `getInstrumentMetadata`；`payloadHash` 对上游字段规范化序列化后取 sha256，**任何一条 provenance 都可被外部重算复核**；上游缺项一律 `null`，不用空串或猜测值冒充。
- **稳定标的 id**：`inst-<sha1(symbol@exchange) 前 16 位>` 确定性派生 —— 同一标的重复检索/重复加入永远得到同一个 id，后续多个证券账户（4C）可直接引用，并在写入路径上保证"同一标的不重复创建事实"。**（注意：本版本的 id 派生口径与"去重只在部分写入路径成立"已被上方的 `2.3.6-phase4b` 复核补口修订 —— 客户端不再能指定 id，id 改为按首次创建时的 identity key 派生并永久锁定，去重键覆盖全量写入路径并由迁移 v4 唯一索引兜底，跨市场同代码报 `ambiguous_instrument`。）**
- **用户判断字段词表**（`js/domain.js`）：`EXPOSURE_MARKETS = ['CN','HK','US','global','other']`；`USER_JUDGEMENT_FIELDS` 明示 `assetClass` / `exposureMarket` / `trackingIndex` 只能由用户填写；`diffInstrumentFields` 只比较同名字段（provider 未给的字段不构成冲突），`suggestFromProvider` 返回带依据的 `[{field, value, basis}]`。
- **标的 API**（`server/api.js`）：`GET /api/v1/instruments/search?q=`（只读，只发送公开检索词）、`POST /api/v1/instruments`（默认从参考数据补全；`source=manual` 用于 provider 未覆盖的标的，币种必填）、`POST /api/v1/instrument-confirmations`（`asset_class` / `exposure_market` 必填）。错误码到 HTTP 状态集中映射（400 / 404 / 409 / 422 / 503）。
- **资产页「标的目录」区块**（`js/app.js` + `js/store.js` 门面）：搜索框、候选列表（标出"已在目录中"）、目录列表（状态、来源、差异数）、确认弹层与手工建立弹层。前端不直接 `fetch`，一律走 `store.js`。
- **测试**：`tests/providers-catalog.test.js`（26 项）、`tests/instrument-catalog.test.js`（33 项）、`tests/server-phase4b.test.js`（11 项），浏览器 wiring 新增 1 项从真实产品入口走完 S4B.1 全链路。

### 修复

- **`repository.upsertInstrument` 不再静默删除同去重键的其他行**：初版实现会 `DELETE` 同 `symbol@exchange` 的另一行 —— 那会连带丢掉已确认的 `confirmed` 分类。改为显式抛 `duplicate_instrument`，由调用方先用 `findInstrumentByKey` 解析既有标的后再写入（`server/instrument-catalog.js` 正是这么做的，并支持"先手工建标的、后由 provider 补全交易所"的退化匹配）。
- **确认后的分类不再被一次"刷新"悄悄降级**：`createInstrument` 初版对所有记录统一写 `classificationStatus: 'suggested'`，用户在界面确认完再点一次"按参考数据刷新"就会退回未确认状态（违反 D-037 的本地锁定）。现在对 `confirmed` 记录显式保留 `classificationStatus` / `confirmedAt` 与全部本地值，只刷新来源留档与冲突提示，并在响应里以 `preserved: true` 明示。
- **标的写入纳入事务**：单条标的写入是"先删同 id 再插入"，原先裸调 repository 存在中途失败丢行的窗口，现统一经 `writeInstrument()` 用事务包装。

### 备注

- `[Unreleased]` 中记录的 4A 契约二次补口（结果白名单落校验器、伪日期时间戳、空白 provider、T-002/4A 状态纠偏）与本版本共同构成当前代码状态；4A 仍为「契约完成、正式验收暂不通过」（行情端点待 4D 前过 D-038 门禁）。
- 新增决策 **D-039**（标的目录口径：稳定 id 派生规则、`(symbol, exchange)` 去重键、用户判断字段与手工来源、冲突只提示不覆盖）。
- 测试基线 `node --test` 274 → **344**（+26 +33 +11），浏览器 wiring 15 → **16**（连续两轮全绿）。

## [2.3.4-phase4a] - 2026-09-15

闭合 Phase 4A 独立复核发现的 P0/P1 缺口。原始结论清单与逐条修复状态见 `PHASE4A_ACCEPTANCE_GAPS.md`（保留原始记录作证据）。

### 修复

- **请求边界不再放行非法输入**（P0）：`serializeQuotesRequest` / `serializeFxRequest` 在序列化**之前**校验数组、symbol、pair，非法输入整体返回稳定的 `invalid_payload`（不再流进 adapter 被当成 `not_found`）；拒绝原因只含"第 N 项 + 形状说明"，**不回显输入原文**（输入可能是误传的账户名等私有文本）。
- **结果校验不再放过不可入账数据**（P0）：`quoteResult` / `fxResult` / `errorResult` 改为严格构造，不合格即抛 `ContractError`；`priceMinor` 必须为正的安全整数、`rateDecimal` 必须大于零、`priceDate`/`rateDate` 必须是**真实存在**的 `YYYY-MM-DD`（拒绝 `2026-02-30`）、`fetchedAt` 必须是**带时区**的 ISO 时间戳；`retryable` 改由错误码推导，调用方无法伪造不一致值；`errorResult.subject` 只允许公开代码/币对形状，其他字符串一律置空。新增 `assertValidResult` 供 4D 落库前调用。
- **节假日 fixture 不再是静态假通过**（P1）：行情与汇率 fixture 改为按日期升序的时间序列，adapter 只取 `date <= asOf` 的最近一条；`asOf` 早于数据起始日返回 `not_found`，**绝不返回未来数据**；`asOf` 非法时整体返回 `invalid_payload`，不用"今天"兜底。
- **数据源决策重做**（P0/P1）：D-036 改为「汇率 = Frankfurter 且固定 `/v2/providers/ecb/…`」（实测同日默认端点 USD/CNY 6.708 vs ECB 6.7115，默认端点是多源混合值），并删除不可复核的固定货币数量；新增 **D-038**「行情源不冻结端点，冻结启用门禁」—— Stooq（`/q/l/` 404、`/q/d/l/` JS 验证挑战）与 Yahoo chart（403）实测失效，不存在同时满足「免费 + 无 key + 官方条款/限额/授权 + 覆盖 A/H/US ETF 日终」的行情源，门禁未通过前自动抓取默认关闭、行情以手动补价为准；D-037 补全为明确 provider（Twelve Data 参考数据 `/symbol_search`）、字段映射与 provenance 记录。

### 新增

- **数据源证据档**（`server/providers/SOURCES.md`）：六个候选源的**可复现探测命令与原始结果**、官方条款与限额链接、认证方式、市场覆盖与失败语义。
- **契约测试扩到 42 项**（`tests/providers-contract.test.js`）：新增形状边界（假日期、无时区时间戳、小写币种）、请求校验反例（非数组/空数组/超限/非法项）、私有文本不回显、结果构造与校验反例（负价/小数价/零汇率/坏日期/坏时间/`retryable` 不一致）、`asOf` 取数反例与不变量、不可入账数据端到端拦截。

### 备注

- fixture 的 `provider` 标识不再冒充真实数据源（原为 `stooq`），统一为 `fixture`。
- 零数据库迁移、零 API 改动、零 UI 改动、零真实网络请求；测试基线 `node --test` 245 → **272**，浏览器 wiring 15/15。

## [2.3.3-phase4a] - 2026-09-15

Phase 4A 数据源决策与适配器契约（`ACCEPTANCE.md` S4A.1）。

### 新增

- **provider adapter 契约**（`server/providers/contract.js`）：统一结果形状（原始代码 / 价格 / 汇率 / 数据日 / 抓取时间 / provider）+ 五类错误 `timeout/rate_limit/not_found/invalid_payload/auth` + 可重试映射 + 白名单请求序列化（结构上只接受公开代码/币对）。
- **固定时钟**（`server/providers/clock.js`）：时间经 `ctx.now` 注入，adapter 零时钟副作用、可复现。
- **fixture adapter**（`server/providers/fixture.js`）：离线假 provider，覆盖成功 / 超时 / 限额 / 缺标的 / 无效载荷 / 鉴权 / 节假日回退。
- **数据源决策冻结**：D-036（汇率 Frankfurter + 行情 Stooq，含覆盖/限额/授权/条款/失败语义与付费评估门槛）、D-037（provider 候选 + 用户确认锁定），见 `DECISIONS.md`。**（注意：本版本对行情源 Stooq 的冻结已被上方的 `2.3.4-phase4a` 复核补口取代 —— Stooq 接口实测失效，D-036 重做并新增 D-038 行情启用门禁。）**
- **隐私边界测试**（`tests/providers-contract.test.js`，15 项）：证明请求与结果只含公开证券代码 / 币对，不含账户名、数量、成本、余额或完整持仓；全部离线运行。

### 修复

- 无（本轮为纯新增契约与测试骨架，未修改既有代码路径）。

## [2.3.2-phase3] - 2026-09-15

闭合 Phase 3 剩余验收问题（P0/P1）。验收发现的原始问题清单见 `PHASE3_ACCEPTANCE_GAPS.md`。

### 新增

- **历史结账金额下钻**：`GET /api/v1/close-snapshots/:id`（只读，404/400 校验）+ `js/store.js` 门面方法；月结页历史行新增「查看明细」，摊开快照内的账户余额、负债、持仓三张事实表，并说明应急覆盖的取数口径与检索月份。
- **青岛福利预设**：资产页四个预设入口按「有无明确余额」分流——公积金余额 / 医保个人账户余额 → 受限资产账户 + CNY 余额；养老等无余额资格 → `entitlement(balanceMinor=null)`；社保卡金融账户 → 普通储蓄卡独立管理。权益支持地区、查询来源与核对日期。
- **手动汇率**：`POST /api/v1/fx-rates` + 资产页汇率维护表单，使外币余额在 Phase 3 内即可折算，不再因 `fx_missing` 阻塞正式结账；自动行情仍属 Phase 4。
- **负债核对日期**：负债表单新增核对日期（默认结账月末），并在列表中提供「更新余额 / 核对日期」；权益同样支持编辑。

### 修复

- 有负债时正式结账按钮永久禁用：负债 `asOf` 恒为「今天」，永远落在结账月份之外，只能存估算快照。
- 应急金覆盖永远无法估算：月均必要支出漏传 `categories`（`need` 恒为 0）且把「分」当「元」再转一次（放大 100 倍）。现由服务端从现金流事实权威重算。
- 汇率落库为 `"[object Object]"`：`Domain.parseDecimal` 返回定点对象被直接字符串化，导致所有外币折算永久失败。
- 备份结构校验漏 Phase 3 新表：声称 v3 却缺 `monthly_closes` / `close_snapshots` / `asset_transfers` 的损坏库此前会通过校验；现按候选库 schema 版本条件化校验。
- 全量写入信任载荷里的换汇币种：改为由关联余额单元推导，缺失单元或同币种直接拒绝。

## [2.3.1-phase3] - 2026-09-15

补全 S3.1 的换汇验收闭环。

### 新增

- 同一资产账户可分别维护 HKD、USD 等币种子账户；同账户同币种再次登记会更新原余额，不再生成重复行。
- 新增 SQLite 迁移 v3 `phase3-asset-transfers`、`GET/POST /api/v1/asset-transfers` 与资产录入页换汇表单；记录两端子账户、币种、金额和日期。

### 修复

- S3.1 原证据只覆盖机构、账户和余额落库，未覆盖“换汇是资产转移、不计收入或支出”。现在换汇使用独立事实表，不写入 `txns`，并由 API 与浏览器验收共同证明。

## [2.3.0-phase3] - 2026-09-15

v3 Phase 3「账户、负债与月度结账」（ROADMAP.md）。形成可信个人资产负债表：机构—账户—币种子账户管理、负债与保障权益、月度核对与结账快照、应急金覆盖估算。

### 新增

- 资产录入页：机构、账户（安全储备/可投资/受限/保障四池分类）、币种余额单元、负债、保障权益逐条录入；单条 upsert（同 id 幂等更新，机构按名称归一合并）；所有写入经 `js/store.js` 门面走 `/api/v1`，不触碰 IndexedDB。
- 月度结账页：按上一个完整自然月生成核对清单（余额按月确认、负债确认、持仓估值、权益状态）；存在缺项时只能保存估算快照，正式结账由服务端强制把关（409 `close_blocked`）；结账保存 sha256 快照，同月重复结账更新记录并追加快照，历史可回看。
- 应急金覆盖月数：决策台按最近 3 个完整月的必要支出估算安全储备可覆盖的月数，覆盖月数由服务端重算，不采信前端结果。
- 数据库迁移 v2 `phase3-close-schema`：新增 `monthly_closes` 与 `close_snapshots` 两张表，只加表不改旧表，旧版本仍可打开 v2 库。

### 修复

- 资源编辑变新增：五类资产资源写接口的载荷校验器不含 `id` 键，客户端传入的 id 被静默丢弃并生成新 id，编辑已有账户/负债/权益会变成新增副本。现在客户端 id 透传并幂等更新，非法 id 返回 400。

## [2.2.1-phase2] - 2026-09-14

v3 Phase 2 补充验收修复（ROADMAP.md）。修复补充验收发现的三个阻塞缺陷与一个备份命名缺陷，服务重启、保存失败、恢复前备份三条链路得到加固。

### 修复

- 服务重启后无法保存：Service Worker 不再缓存带会话令牌的 `index.html`，HTML 一律网络优先、离线才回退到脱敏缓存壳，杜绝「旧令牌 401」。
- 保存失败仍显示已入账：记账改为确认落盘后才提示成功，失败回滚本地乐观更新；本地服务中途不可达时立即进入只读降级并显示横幅，未落盘交易不再挂在界面上。
- JSON 恢复前无强制备份：恢复改为「覆盖前强制备份」（`PUT /state` 的 `forceBackup`），不受 60 秒写后备份节流限制，被覆盖版本可回滚；清空账本同步改走服务端 `DELETE /state`（自带 pre-clear 备份）。
- 同秒同名备份互相覆盖：备份文件在目标已存在时追加 `-N` 后缀，保护性快照不再因秒级命名撞车而丢失。

## [2.2.0-phase2] - 2026-09-14

v3 Phase 2「本地服务与 SQLite」（ROADMAP.md）。SQLite 成为唯一事实源，浏览器不再直接持有财务数据。原有记账、导入、备份导出能力全部保留。

### 新增

- 本地服务 `server/`：只监听 `127.0.0.1`，托管静态前端与 `/api/v1`。写接口校验 session token、Origin 与 Content-Type；不返回 CORS 头、不处理预检，跨源页面既发不出写请求也读不到响应。未实现的写接口返回 `501` 并说明所属阶段。
- SQLite 事实源：版本化迁移器（事务原子、失败整包回滚）、repository（资产八集合 + 原四键、全量替换幂等、未知字段经 `extra_json` 保留、机构文本归一、应用锁下交易只落密文）。
- 本地备份与恢复：写事务后按节流创建版本备份、至少每日一份、默认保留最近 30 份；备份先写临时文件并校验再原子替换；恢复前自动备份当前库，在临时库校验完成后切换，切换失败把原库放回原位。
- 启动与常驻：单实例锁（同一数据目录只允许一个写进程）、随机 session token（0600）、每日启动备份、`--self-check` / `--migrate-only` / `--print-config` 等命令；`start.command` 改为启动本地服务。
- macOS 登录启动：`server/login-item.js` 与 `scripts/install-login-item.sh` / `uninstall-login-item.sh`。默认只写 plist 文件，加 `--activate` 才真正加载；可查询状态、可卸载。
- macOS Keychain 适配器 `server/keychain.js`：读取只走 stdin、不进 argv；本阶段只做可用性探测，不创建条目、不返回值。行情 API Key 的真实读取属于 Phase 4。
- 前端存储门面 `js/store.js`：所有持久化读写经此一处。本地服务可达时全部走 `/api/v1` 且**完全不触碰 IndexedDB**；服务不可达时进入只读降级（可查看/导出，拒绝写入并显示显著横幅），绝不双写。
- 首页新增服务状态横幅，明确显示当前事实源与 schema 版本，或在降级时说明如何恢复记账。

### 修复

- 清空账本：无请求体的 `DELETE` 现在同样声明 `Content-Type: application/json`，否则会被本地服务按非法写请求拒绝（415）而静默失败。
- 资产集合形状：服务端读回的 `assets` 现在带 `schemaVersion`，与前端既有形状一致；键集改为从领域模型的空集合派生，避免两边结构漂移。
- 静态资源守卫：路径穿越判断改为先按未归一化路径段拒绝 `..` 与 `.git`，再做拼接校验；不再通过 HTTP 提供任何数据库文件。
- 备份目录不再残留孤儿 `-wal/-shm` 同伴文件与中断留下的临时文件。

### 变更

- 备份快照改用 SQLite 自身的 `VACUUM INTO`。不使用 `node:sqlite` 的在线备份 API——实测它在长生命周期进程中会不可预测地停住（此后每次调用约 8 秒甚至挂死），会导致每次保存后出现秒级卡顿。
- `start.command` 从"启动通用静态服务器"改为"启动本地服务"（仅 loopback、带写接口保护、自动打开页面）。

### 验证

- Node 自动测试 **198/198**（Phase 1 的 133 项零回归 + 新增 65 项：迁移 13、repository 14、备份 12、恢复 8、HTTP 层 14、前端请求头契约 4）。
- 浏览器接线验收 **9/9**（含单一事实源、写入门禁与清空链路）。
- 实施前只读技术验证 5/5（SQLite 驱动、loopback 绑定、单实例锁、Keychain 读取、登录项 plist）。
- 端到端实测：门禁（401/403/415/405）、幂等重放、第二实例被拒、清空先备份、恢复成功与失败回滚、保留 30 份全部符合契约。

### 待用户在本机确认

- 登录项端到端：执行 `scripts/install-login-item.sh` 后重启 Mac，确认自动启动且只有一个实例。
- 本机浏览器中若存在 v2 时代的历史数据，可继续用"设置 → 导出 JSON 备份"导出留档；这些数据在只读降级下仍可见可导出。

## [2.1.0-phase1] - 2026-09-14

v3 Phase 1「资产领域基础」（ROADMAP.md）。产品中心从记账流水扩展为资产决策台，原有记账与账单导入能力全部保留。

### 新增

- 资产领域模型 `js/domain.js`：资产账户、币种子账户、负债、保障权益、标的、持仓、报价与汇率对象；CNY/HKD/USD 定点折算；总资产、净资产、资金池（安全储备/可投资/受限）、风险资产类别配比与可新增投资资金聚合。
- 新鲜度与完整性状态：行情/汇率超过 5 个自然日、余额未在本月核对、标的分类未确认、余额或汇率缺失时，结果标注为估算口径并阻断正式建议；缺失值绝不按 0 或 1:1 兜底。
- 首页重构为「资产决策台」：净资产/总资产/总负债、资金池、风险配比、可新增投资资金、待办与权益状态、数据口径说明；无资产时展示空状态，不虚构数值。原月度记账首页下沉为「现金流」页，从决策台入口可达。
- 备份 Schema 升级到 v2（新增 `assets` 八个集合）；v1 备份仍可正常恢复并自动补空资产集合。

### 验证

- Node 自动测试 133/133（新增 31 项领域行为测试、4 项备份/存储测试）；旧 99 项基线零回归。
- 浏览器接线验收 5/5；GUI 走查 S1.1–S1.4 全部通过，截图见 `docs/evidence/`。

## [2.0.0-rc.3] - 2026-09-05

### 改进

- 备份生成与恢复校验统一使用核心逻辑，恢复时验证 Schema 和数据结构。
- 拒绝无法识别的未来 Schema，恢复后的应用锁默认关闭，避免携带失效的内存密钥状态。

### 验证

- 增加固定 JSON 备份往返、缺省数据补齐、损坏备份拒绝和 CSV 格式测试。
- Node 自动测试达到 98/98；浏览器原生验收达到 9/9。
- 应用界面完成记账持久化、应用锁错误/正确密码和清空强确认回归。

## [2.0.0-rc.2] - 2026-09-05

### 修复

- 跨源自动去重现在要求银行支付渠道痕迹一致且候选唯一，避免同日同金额交易被误合并。
- localStorage 降级模式使用标准 `length/key()` 遍历清空账本命名空间，提高跨浏览器兼容性。

### 验证

- 增加 IndexedDB、AES-GCM 应用锁、错误密码和清空隔离测试。
- 增加固定虚构账单和浏览器原生验收页面。

## [2.0.0-rc.1] - 2026-09-05

### 新增

- 建立 Git 版本管理基线和个人财务导出文件忽略规则。
- 增加本变更日志，明确发布候选版本与正式版本的边界。
- PWA 离线安装、预算与消费体检、退款冲销、报销管理、周期记账和二级分类。
- 微信、支付宝、招商银行、中国银行及通用银行 CSV 导入与跨源去重。
- 应用锁、JSON 备份恢复和 CSV 明细导出。

### 验证

- Node 纯逻辑测试 86 项通过。
- JavaScript 语法检查通过。
- 首页、统计页和设置页浏览器冒烟检查通过，无控制台错误。

### 待验收

- 真实账单导入与跨源去重完整链路。
- IndexedDB 持久化、应用锁、JSON 备份恢复和清空数据。
- PWA 离线写入、Service Worker 升级和移动端适配。
