# Phase 6 契约（6A 冻结稿）

> 2026-09-28；执行子阶段：**6A 规则与契约**。基线代码 `2.4.23-ui-polish` / SQLite **v10**。
> **2026-09-29 复核勘误**（不改四条已确认产品口径，只修实现口径）：①有序对计数为完整矩阵 **7×7 = 49**（合法 6 / 非法 43，含自转移）；②`RESTRICT` + 软删除 ⇒ 曾被关联（含已解绑）的证券事件一律不可物理删除；③F-A 正向 fixture 修正为 20 × 100.00 = 2,000.00 本金；④归档理由首次尝试按关联历史判定（**已被下条二次复测规则取代**）；⑤零事件 `proposed` 决策为合法空序列、无快照，读取校验豁免链式检查；⑥§4.4 `reason` 公式补 `available` 判定。明细见 DECISIONS D-057 勘误。
> **2026-09-29 二次复测修正**：跨月关联不新增 `eventMonths`；缺汇率时 CNY 汇总与剩余金额返回 `null`；归档理由按建议金额与关联历史唯一判定；三时点表与非法计数对齐矩阵。对应反例见 §10.2，详见 D-057 二次勘误。
> **2026-09-29 6D 补充**（实现前先补规则，D-057 附属）：关联 / 解绑的请求键白名单、`note` 必填口径与载荷引用错误码 `unknown_decision_link`（422）写入 §3.4 / §7 / §8.5；四条已确认产品口径、状态机与金额口径不变。
> **2026-09-30 6E 补充**（实现前先补规则，D-057 附属）：§4.3 的六类配置对照以服务端派生的 `comparison` 对象进详情响应（§8.4），字段形状、不可比口径与 delta 定义见 §4.3 末新增小节；`reviewed_with_drift / reviewed_no_drift` 在任一时点不可比时的判定口径一并冻结。状态机、快照结构与错误码不变。
> 顺序入口：[ROADMAP.md](./ROADMAP.md)；任务来源：[PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md) §3；执行入口：[NEXT_AGENT.md](./NEXT_AGENT.md)。
> **本文件是 6A～6F 的唯一规则来源。** 与本文件冲突的旧文档、旧测试注释或代码注释，一律以本文件为准，并按 §11 更新；发现本文件未覆盖的分歧，先在本文件补一条规则再实现，不得在代码里就地裁定。

## 0. 本文地位与 6A 范围

6A 只做规则与契约：**零业务代码、零迁移、零页面、零数据文件**。本文件冻结：

1. 状态机（含 6A 新增的归档终态）与每一条合法 / 非法跳转；
2. 建议 → 决策的进入条件、接受门禁与事后关联的分界；
3. 实际交易关联、分批、偏差、纠错与无交易出口；
4. 三时点快照与复盘比较口径；
5. 月度历史归属、日期与时钟；
6. 表结构、API 载荷白名单、错误码、幂等与快照完整性；
7. 迁移 / 备份 / 回滚方案与正反向 fixture 清单。

四条产品歧义已于 2026-09-28 由用户当面确认（见 §1.1 注、§2.4、§3.1、§3.5），其余六条歧义由 6A 按现有文档裁定，逐条写在 §12 并标注依据。**未决项：0。规则冲突：0。**

6A 不实现任何下表内容；下表是给 6B 的边界：

| 6A 做 | 6A 不做 |
|---|---|
| 规则、字段、错误码、例子、迁移与回滚方案 | 建表、写代码、改页面 |
| 更新 PRODUCT / DECISIONS / ARCHITECTURE / ACCEPTANCE / ROADMAP / README / NEXT_AGENT | 生成真实建议或决策数据 |
| 列出 6B 必须显式更新的守卫测试 | 修改这些测试、降低任何断言 |

---

## 1. 状态机

### 1.1 状态集合

七个状态，词表冻结，拼写与大小写固定：

```text
proposed   已绑定一条正式建议、尚未做出决定（决策的初始状态）
accepted   已接受，进入待执行清单
deferred   已暂缓（归档态）
dismissed  已忽略（归档态）
executed   已确认执行完成
reviewed   已复盘（终态）
archived   已归档放弃（终态，6A 新增）
```

`archived` 是 6A 唯一新增的状态，**已由用户确认**（2026-09-28）：用于 0 元建议、全部保留现金、接受后放弃等「没有实际交易也要关闭」的决策。它不进复盘，不伪造 0 元证券交易，也不稀释 `executed` 的语义。

操作者恒为固定常量 `local-user`，由服务端写入 `decision_events.actor`，**客户端载荷出现 `actor` 即 400 `invalid_decision_payload`**。

### 1.2 转移矩阵（权威表）

行 = 当前状态，列 = 目标状态。`√` = 合法，`×` = 非法。自转移一律非法。

| from \ to | proposed | accepted | deferred | dismissed | executed | reviewed | archived |
|---|---|---|---|---|---|---|---|
| **proposed** | × | **√** | **√** | **√** | × | × | × |
| **accepted** | × | × | × | × | **√** | × | **√** |
| **deferred** | × | × | × | × | × | × | × |
| **dismissed** | × | × | × | × | × | × | × |
| **executed** | × | × | × | × | × | **√** | × |
| **reviewed** | × | × | × | × | × | × | × |
| **archived** | × | × | × | × | × | × | × |

- 合法跳转 **6** 条，非法跳转 **43** 条（含 7 条自转移），合计 **7×7 = 49 个有序对**（上表为含自转移的完整矩阵；若不计自转移则为 7×6 = 42 个，合法 6 / 非法 36）。2026-09-29 勘误：原稿「7×6 = 44、非法 38」为计数错误。
- 与 ACCEPTANCE S6.1 的原始矩阵完全一致，只在 `accepted` 行新增 `→ archived` 一条（DECISIONS D-057）。
- **6B 必须写一个数据驱动测试，遍历全部 49 个有序对（含自转移）**：合法 → 状态改变且恰好追加 1 条事件；非法 → HTTP 409 `illegal_transition` 且状态、事件条数、关联条数全部不变。上表即该测试的期望值，不得只测几个代表样例。

### 1.3 合法跳转例子

以下例子使用同一套虚构建议 `rec-3f2a9c1b7d4e5f60`（formal，`allocatedTotalMinor = 200000`，即 2,000.00 CNY）。

| # | 转移 | 触发 | 前置 | 结果 |
|---|---|---|---|---|
| L1 | proposed → accepted | `POST /decisions` `intent=accepted` | 建议为 formal、记录复核通过、**当前未失效**、`note` 必填 | 状态 accepted，追加事件 `seq=1`，封存「决策时点」快照 |
| L2 | proposed → deferred | `POST /decisions` `intent=deferred` | 建议为 formal、记录复核通过、`note` 必填；**不要求**建议未失效 | 状态 deferred，封存快照，进历史不进清单 |
| L3 | proposed → dismissed | `POST /decisions` `intent=dismissed` | 同 L2 | 状态 dismissed |
| L4 | accepted → executed | `POST /decisions/{id}/events` `toState=executed` | 活动关联 ≥1 条 buy；偏差存在时 `note` 必填 | 状态 executed，封存「执行时点」快照 |
| L5 | accepted → archived | 同上 `toState=archived` | 活动关联 **= 0**；`note` 必填 | 状态 archived，封存快照，不进复盘 |
| L6 | executed → reviewed | 同上 `toState=reviewed` | `note` 必填（复盘理由） | 状态 reviewed，封存「复盘时点」快照，此后一切只读 |

`proposed` 也可由 `POST /decisions` 省略 `intent` 单独创建（状态 proposed、**零事件**），随后用事件端点逐条走 L1～L3。两种创建方式的最终状态与事件必须完全一致；6B 两条路径都要测。

### 1.4 非法跳转例子（按类别）

全部 43 条同码 `illegal_transition` → **HTTP 409**，且**事务整体回滚**（状态、事件、关联、快照都不写入）。代表例子：

| 类别 | 例子（from → to） | 期望 |
|---|---|---|
| 跳步 | `proposed → executed`（经 `POST /decisions` `intent=executed`） | 409 `illegal_transition`，**不创建任何决策行** |
| 跳步 | `proposed → reviewed`（同上 `intent=reviewed`） | 409 `illegal_transition`，同上 |
| 跳步 | `accepted → reviewed` | 409 `illegal_transition`，状态仍 accepted、事件数不变 |
| 跳步 | `proposed → archived` | 409 `illegal_transition` |
| 终态反转 | `dismissed → accepted` | 409 `illegal_transition`（忽略是终态） |
| 终态反转 | `deferred → accepted` | 409 `illegal_transition`，**见 §2.4，6A 已确认不开放** |
| 终态反转 | `archived → accepted` | 409 `illegal_transition` |
| 终态反转 | `reviewed → executed` / `reviewed → accepted` | 409 `illegal_transition` |
| 终态内移动 | `deferred → dismissed`、`dismissed → deferred`、`archived → executed` | 409 `illegal_transition` |
| 逆向 | `executed → accepted`、`executed → dismissed`、`executed → archived` | 409 `illegal_transition` |
| 自转移 | 任意 `X → X`（含 `accepted → accepted` 重复提交） | 409 `illegal_transition`；带 `Idempotency-Key` 的**同载荷**重放除外（见 §8.4） |

**`intent` 白名单只有 `accepted / deferred / dismissed`**：`executed`、`reviewed`、`archived`、`proposed` 出现在 `intent` 即 409 `illegal_transition`（等价于 proposed 出发的非法跳转），不是 400——因为它是状态问题而不是形状问题。

### 1.5 时钟与记录时间

- 服务端注入时钟是唯一时间来源（D-053）：`ctx.today()` → `YYYY-MM-DD` 本地日，`ctx.nowIso()` → ISO 时刻。**客户端提交的任何时间字段（`occurredAt` / `occurredOn` / `recordedAt` / `createdAt` / `updatedAt`）出现在载荷即 400 `invalid_decision_payload`。**
- `decision_events.occurred_at` = **本地日历日 `YYYY-MM-DD`**（= 事件发生时的 `ctx.today()`），与 `security_events.occurred_at` 同形状，用于月度归属，**不带时区歧义**。
- `decision_events.recorded_at` = ISO 时刻（= `ctx.nowIso()`），用于展示与排序兜底。
- 事件顺序由 `decision_events.seq`（每条决策内从 1 递增）决定，不依赖时间戳精度；同一事务内的多个时间戳可以相同。
- 比例计算、staleness 判定、快照 `asOf` 一律用 `ctx.today()`，禁止读客户端时钟与 `Date.now()`。

---

## 2. 进入 proposed 的对象与门禁

### 2.1 谁能创建决策

`POST /api/v1/decisions` 的**唯一对象**是一条已存在的 `recommendations` 记录，且：

1. `record.status === 'formal'`，否则 **409 `recommendation_not_formal`**。**估算建议（estimate）不能创建决策、不进待执行清单、不可接受**（用户 2026-09-28 确认）；它只在建议页展示与保留待办。
2. 记录必须先通过 `Domain.validateRecommendationRecord` 读取复核，失败 → **400 `invalid_recommendation_record`**。
3. `recommendationId` 不存在 → **422 `unknown_recommendation`**（载荷内引用，沿用 `unknown_account` / `unknown_instrument` 的 422 口径）。
4. **一条建议最多一条决策**：`UNIQUE(recommendation_id)`（数据库兜底）。同一 `recommendationId` 再次创建 → **200 + `created:false` + 既有决策**，不新增行、**不套用本次的 `intent` / `note`**（自然幂等，同 D-048 ③ 的目标版本口径）。

`gate.capture`、`inputHash`、`id`、建议金额算法一律不动；**决策行不复制建议金额**，执行进度始终读建议记录。

### 2.2 接受时的重核（门禁）

只有结果状态为 `accepted` 的创建请求执行重核；`deferred` / `dismissed` 不做重核（归档一条已失效的建议是合法诉求）。重核在**同一事务内**完成，全部通过才写入：

| 检查 | 失败码 |
|---|---|
| `Domain.adviceStaleness(建议, 服务端当前视图, 资产签名) === []` | 409 `recommendation_stale`（detail 携带冻结 reason 码列表） |
| 建议仍能通过 5D 门禁复放（`recommendationStatusFromGate` 与 `record.status` 一致） | 400 `invalid_recommendation_record` |
| 被引用的 `assessmentId` / `targetId` 与 `gate.capture` 同 id 记录逐字段一致（G5-R1） | 400 `invalid_recommendation_record` |

**客户端角标不是授权依据**：页面显示的 `data-advice-status="stale"` 只是提示，服务端必须独立重算；反过来，页面没标 stale 也不能放宽服务端重核。

估算建议、失效建议**永远无法**通过这道门禁绕过正式口径。

### 2.3 接受门禁 vs 事后关联（必须分清）

| | 接受门禁（§2.2） | 事后关联（§3） |
|---|---|---|
| 触发点 | 创建 `accepted` 决策时 | `POST .../links` |
| 建议失效 | **拒绝**（409 `recommendation_stale`） | **允许**——实际发生的交易必须能记录 |
| 建议状态 | 必须 formal 且复核通过 | 不重新判断建议；只判断决策状态与事件类型 |
| 语义 | 「现在还能按这条建议行动吗」 | 「事实上发生了什么」 |

**记事实不等于重新批准建议**：给一条失效建议补记交易，不会把决策变回 accepted，也不会重新算金额；原建议金额永久保持（D-049）。

### 2.4 暂缓与忽略的出口（用户已确认）

- `deferred` / `dismissed` 是**归档态，不可回跳**。`deferred → accepted` 保持非法（PRODUCT §9「未列出的跳转默认拒绝」原样成立，**不记规则变更**）。
- 同一输入幂等返回同一条建议（`inputHash` 相同 → 同 id）时，既有决策原样返回（`created:false`），**不会因为再次生成建议而重开决策**。要重新决策，必须先让事实变化（余额、行情、评估、目标、映射任一改变）→ 生成新建议（新 `inputHash` → 新 `rec-*`）→ 新决策。
- 暂缓 / 忽略的决策只出现在历史与筛选结果里，**不混入待执行清单**（清单只列 `accepted`）。
- 由此产生的真实代价（事实完全没变时，那条建议会一直是「已暂缓」）已向用户说明并接受。

---

## 3. 实际交易关联（6D 口径）

### 3.1 可关联的事件类型（用户已确认）

- **只有 `event_type === 'buy'` 可以关联**。`sell` / `dividend` / `fee` 一律拒绝 → **409 `invalid_link_target`**（detail：`only_buy`）。
- 分批：**多笔 buy 可以关联同一条决策**，无数量上限。
- 手续费不单独关联：买入自带的 `fee_minor` 与另记的 `fee` 事件都只在执行汇总里作为**交易费用**单列，**不计入本金、不参与偏差计算**。
- 换标的：卖出不关联，买入关联；标的与建议认可标的不一致时**不拒绝**，由确认完成时的 `note` 说明（差额与标的差异同一条理由）。
- 关联不改写 `security_events`、不写 `txns`、不自动改现金余额（D-042 ④）。

### 3.2 单事件单决策与引用完整性

- `decision_links` 采用**软删除**：`unlinked_on IS NULL` 表示活动关联；解除关联保留行（`unlinked_on` / `unlink_note`），**不删历史**。
- **一条证券事件同时最多属于一条决策**：部分唯一索引 `uq_decision_links_active(security_event_id) WHERE unlinked_on IS NULL`，数据库层兜底。
  - 已活动关联到**本决策** → 200 `created:false`（自然幂等）；
  - 已活动关联到**另一决策** → **409 `event_already_linked`**；
  - 不做跨决策拆单，不做一条事件分摊给多条决策。
- 关联允许的状态：**仅 `accepted` 与 `executed`**。在 `proposed` / `deferred` / `dismissed` / `reviewed` / `archived` 关联或解绑 → **409 `illegal_state_for_link`**。
- `decision_links.security_event_id` 为 `ON DELETE RESTRICT` 外键，且解绑是软删除（关联行保留、外键引用随之保留）：**曾被任何关联行（活动或已解绑）引用过的证券事件一律不可物理删除**；全量写入省略该行 → 整体拒绝 **409 `linked_event_missing`**（由仓储在写入前显式检查全部关联行并给出稳定码，不得让 SQLite 外键错误冒充 500）。2026-09-29 勘误：原稿「删除仍被活动关联引用的事件必须先解绑」与 `RESTRICT` 语义矛盾——解绑后行仍在，删除依旧被拒。从未被关联过的事件不受本条约束（沿用 Phase 4C 既有行为）。
- 未知事件 → **422 `unknown_security_event`**；解绑一条非活动关联 → **409 `link_not_active`**；解绑必须带 `note`。

### 3.3 金额、进度与偏差

固定口径（金额一律整数最小货币单位 CNY，除另有说明）：

| 量 | 定义 |
|---|---|
| 建议金额 | `rec.allocatedTotalMinor`（只读，永不改写） |
| 单笔本金 | `Domain.mulMinor(quantity, price_minor)`，币种 = 标的 `currency`（D-042 ⑤） |
| 关联本金 | Σ 活动关联 buy 的本金，按各自 `occurred_at` 用 `Domain.findFxRateAsOf`（只认当天及之前）折算 CNY 后求和；任一活动事件缺折算汇率时为 `null` |
| 关联费用 | Σ 活动关联 buy 的 `fee_minor` 同法折算，**单列展示**；任一活动事件缺折算汇率时为 `null` |
| 进度 / 剩余 | `remainingMinor = rec.allocatedTotalMinor − 关联本金`，可为负（超买）；关联本金为 `null` 时也为 `null`，**进度只反映事实，不改状态** |
| 偏差 `diff` | `关联本金 − rec.allocatedTotalMinor`；关联本金为 `null` 时也为 `null`（不可判定） |

- **缺汇率**：任一活动关联事件折算所需汇率不存在 → `linkedPrincipalCnyMinor`、`linkedFeeCnyMinor`、`remainingMinor` 与内部 `diff` **全部为 `null`**，`linkedCount` 仍是实际活动关联条数；`fxUnavailable` 按事件 `occurred_at`、`id` 升序列出缺汇率的事件 id。偏差**不可判定**，确认执行时按「有偏差」处理（`reason_code = executed_deviation`，`note` 必填）。列表、详情、关联响应和每份快照的 `execution` 使用同一形状；**绝不按 1:1、期末汇率、已能折算的部分小计或伪 0 兜底**。无活动关联时汇总本金与费用均为 0、剩余为建议金额、`fxUnavailable=[]`。

  例如建议 2,000.00 CNY，已关联一笔 CNY buy 与一笔缺交易日 HKD→CNY 汇率的 HKD buy，响应固定为：

  ```json
  {"linkedCount":2,"linkedPrincipalCnyMinor":null,"linkedFeeCnyMinor":null,"remainingMinor":null,"fxUnavailable":["sev-hkd"]}
  ```
- **状态永远由显式命令推进**：`accepted → executed` 必须是 `POST .../events`，**不按「金额相等」自动判 executed**。
- `accepted → executed` 要求活动关联 **≥ 1**，否则 **409 `no_linked_events`**。
- 偏差存在（`diff ≠ 0` 或不可判定）时，`note` 必填，否则 **400 `deviation_note_required`**；`diff === 0` 时 `note` 可空，服务端理由码取 `executed_as_planned`，否则 `executed_deviation`。
- 确认完成后**执行事实封存**（执行时点快照），但 `executed` 状态下**仍允许**关联 / 解绑（纠错窗口），每次变更都带时间与理由，复盘快照记录的是复盘当时的最终关联集合；已 `reviewed` 后禁止任何变更。

### 3.4 解绑与纠错

- 解绑 = 把 `decision_links` 行标记 `unlinked_on` + `unlink_note`（必填），**不删除行、不追加第二条状态事件**；历史由关联行自身保留（"追加更正而非擦除"的落地形式）。
- 解绑后该事件可重新关联到任意决策（部分唯一索引只约束活动行）。
- 解绑请求里的 `linkId` 是**载荷引用**（§7 口径）：`linkId` 不存在，或存在但不属于路径上的这条决策，一律 **422 `unknown_decision_link`**（不区分「查无此行」与「张冠李戴」——从该决策视角两者都是引用不到该决策的关联行），且不写入任何变更。
- 解绑不删除关联行，外键引用随之保留——**解绑不会使证券事件变得可删除**（§3.2）。
- 解绑后决策的 `state` **不变**；若解绑导致活动关联归零且决策仍在 `accepted`，决策照常可归档（L5）或继续接受新关联。
- `reviewed` 之后任何关联 / 解绑请求 → 409 `illegal_state_for_link`（复盘不可静默改变）。

### 3.5 0 元、全部保留现金与无交易（用户已确认）

- **不得伪造任何 0 元证券交易、不得用零关联的 `executed` 满足状态**。
- 无交易的关闭路径唯一：**`accepted → archived`**，`note` 必填。活动关联为 0 且建议金额为 0、从未关联过买入时，服务端理由码为 `no_trade`；其余归档（包括有正金额但接受后始终没买，以及曾关联后全部解绑）为 `abandoned`。判定规则见 §6.3。
- 归档要求活动关联 = 0，否则 **409 `has_linked_events`**（先解绑再归档）。
- `archived` 是终态：不可再接受、执行或复盘；在历史中可按状态筛选。
- 0 元 formal 建议（5E-6 已证明会生成）的完整路径：`accepted`（note 必填）→ `archived`（note 必填，`no_trade`）。它**不会**出现在复盘历史里，这是预期行为而不是缺口。

### 3.6 现金核对

- 沿用人工现金余额核对口径（D-034 / D-042 ④）：证券事件不写 `txns`，现金由余额单元人工核对。
- `cashReconciled := !computeOverview().freshness.balanceStale`。
- **买入后现金未核对**时，复盘快照的 `available` 必须为 `false`、`reason = cash_not_reconciled`，**不得把现金与证券重复计入后仍展示为可信成果**（详见 §4.4）。

---

## 4. 复盘口径（6E-1 消费）

### 4.1 三个时点

| 时点 | 触发事件 | `asOf` |
|---|---|---|
| 决策时点 | `proposed → accepted/deferred/dismissed` | 事件 `occurred_at`（= 当日 `ctx.today()`） |
| 执行时点 | `accepted → executed` | 同上 |
| 复盘时点 | `executed → reviewed` | 同上 |

`accepted → archived` 也是合法状态事件，必须按「每次状态事件」规则另封存**归档快照**；它不属于执行或复盘时点，也不进入三时点配置对照。详情的 `snapshots.archived` 返回该快照，未归档时为 `null`。

**每一次状态事件都封存一份完整快照**（`decision_events.snapshot_json` + `snapshot_hash`）。快照是当时事实的一次性封存，此后改行情、改目标、改资产都**不能**改变已封存的快照；历史追溯用当时的规则版本（`targetRef.ruleVersion` / `templateVersion`），当前值若在页面展示必须**分开标注**，不得与历史值混排。

### 4.2 快照结构（字段白名单，键序用 `canonicalJson`）

```jsonc
{
  "schemaVersion": 1,
  "asOf": "2026-10-15",
  "capturedAt": "2026-10-15T01:30:00.000Z",
  "available": true,                  // 见 §4.4
  "reason": null,                     // available=false 时必填，词表见 §4.4
  "blockers": [],                     // overview.blockers 原样（code + detail）
  "cashReconciled": true,
  "valuationStatus": "formal",        // overview.valuationStatus 原样
  "netWorthMinor": 147000000,         // available=false → null
  "investableTotalMinor": 97000000,   // available=false → null
  "targetRef": {                      // 决策所引用建议的目标版本（历史参照）
    "targetId": "tgt-…",
    "templateVersion": "risk-targets-v1",
    "ruleVersion": "risk-rules-v1",
    "level": 2
  },
  "recommendationRef": {
    "recommendationId": "rec-…",
    "inputHash": "<64 hex>",
    "asOf": "2026-10-01",
    "status": "formal",
    "allocatedTotalMinor": 200000
  },
  "classes": [                        // 恒按 Domain.RISK_CLASSES 六类，恒 6 行；available=false → null
    { "assetClass": "cash", "valueMinor": 50000000, "pctBps": 5154,
      "minBps": 1000, "targetBps": 2000, "maxBps": 3000,
      "band": "above_max", "deviationBps": 3154 }
  ],
  "execution": {                      // 每份快照都有；无关联时本金/费用为 0、剩余为建议金额
    "linkedCount": 2,
    "linkedPrincipalCnyMinor": 199900, // 缺任一活动买入的折算汇率 → null
    "linkedFeeCnyMinor": 500,          // 同上 → null
    "remainingMinor": 100,             // 同上 → null
    "fxUnavailable": []                // 缺汇率事件 id，按交易日、id 升序
  }
}
```

- 生成方式：`Domain.computeOverview(assets, {now, settings})` + `Domain.computeAllocationDeviation(引用的 target 记录, overview)` + §3.3 的关联汇总，**三者都是既有函数，6A 不新写第二套估值 / 分配 / 门禁**（D-025）。
- `classes[].minBps/targetBps/maxBps/band` 来自 `computeAllocationDeviation`，因此**目标区间取的是「决策所引用的那个历史目标版本」**，不是页面当前目标。
- `snapshot_json` 必须是 `canonicalJson`（键排序）序列化；`snapshot_hash = SHA-256(snapshot_json 的 UTF-8 字节)`。读取时按原文重算比对。

### 4.3 六类配置对照与差额（6E-1）

复盘页对每个资产类输出一行，横向三时点：

| 字段 | 含义 |
|---|---|
| `decision/executed/review.valueMinor` | 该时点封存的类别金额 |
| `decision/executed/review.pctBps` | 该时点封存的比例（basis points，100% = 10000） |
| `decision/executed/review.deviationBps` | 该时点相对目标 `targetBps` 的偏离 |
| `decision/executed/review.band` | `below_min / within / above_max`，端点含入（5A 口径） |
| `deltaValueMinor` | `review.valueMinor − decision.valueMinor` |
| `deltaPctBps` | `review.pctBps − decision.pctBps` |

- 三份快照中任一份 `available === false` → 该行标记**不可比**并给出该快照的 `reason` + `blockers`，**不出数字、不出伪 0**。
- `pctBps` 为 `null`（投资池为 0）→ 该时点比例列显示「不可用」，**不算不可比**，金额列照常显示。
- 参照目标恒为 `targetRef`；页面如需展示当前目标，必须单独区块、单独标注「当前生效目标（非决策时目标）」。

**6E 补充：详情响应的 `comparison` 对象（服务端派生，页面只搬运）。** 形状与口径冻结如下：

```jsonc
"comparison": {
  "comparable": true,              // 三时点快照齐全（均存在）且全部 available === true
  "timepoints": {                  // 每个时点的在场性与可用性，含不可比原因（原样搬运封存值）
    "decision": { "present": true, "available": true, "reason": null, "blockers": [] },
    "executed": { "present": true, "available": true, "reason": null, "blockers": [] },
    "reviewed": { "present": true, "available": true, "reason": null, "blockers": [] }
  },
  "rows": [                        // 恒按 Domain.RISK_CLASSES 序 6 行；comparable=false 时
    {                              // 全部 cell 与 delta 一律 null（不出任何数字）
      "assetClass": "cash",
      "targetBps": 2000,           // 参照目标区间中值；三时点恒同（同一 targetRef 历史版本）；
                                   // 无任何可比时点时为 null
      "decision": { "valueMinor": 50000000, "pctBps": 5154, "deviationBps": 3154, "band": "above_max" },
      "executed": { "valueMinor": 48000000, "pctBps": 5010, "deviationBps": 3010, "band": "above_max" },
      "review":   { "valueMinor": 49500000, "pctBps": 5100, "deviationBps": 3100, "band": "above_max" },
      "deltaValueMinor": -500000,  // review.valueMinor − decision.valueMinor；任一端 cell 为 null → null
      "deltaPctBps": -54           // review.pctBps − decision.pctBps；任一端 cell 为 null 或 pctBps
                                   // 为 null（0 投资池）→ null
    }
  ]
}
```

- 时点 cell 规则：对应快照**不存在**（尚未走到该时点）**或 `available === false`** → cell 为 `null`；快照可比时 cell 取该时点封存 `classes` 行的 `valueMinor / pctBps / deviationBps / band` 原值，页面不换算。`pctBps` 为 `null`（0 投资池）的快照仍是可比快照：cell 保留 `valueMinor`、比例与区间字段为 `null`。
- `comparable === false` 时 `rows` 仍恒 6 行（保持形状稳定），但所有 cell 与 delta 为 `null`；不可比原因看 `timepoints`（快照缺失 → `present:false`；快照在但 `available:false` → 该时点 `reason` + `blockers` 原样给出）。各可比时点的数字仍可在详情的时点快照区看到，对照表本身不输出任何部分数字。
- `delta` 只在 `comparable === true` 时输出：`deltaValueMinor = review.valueMinor − decision.valueMinor`（恒为安全整数）；`deltaPctBps = review.pctBps − decision.pctBps`（任一端 `pctBps` 为 `null` → `null`）。不定义 executed 与 decision / review 之间的 delta（执行时点是过程事实，对照只回答「决定前 vs 复盘时」）。
- `targetBps` 取该行在任一可比时点 `classes` 行的 `targetBps`；同一 `targetRef` 下三时点恒同，若不一致即记录损坏（`invalid_decision_record`），不挑一个用。
- `comparison` 由共享领域层唯一实现（`Domain.decisionReviewComparison` 纯函数），`GET /api/v1/decisions/{id}` 在快照完整性复核通过后计算并随详情返回；任何输入快照形状不合法 → 详情整体 400 `invalid_decision_record`（fail closed，不输出残缺对照）。
- 漂移判定（§6.3 `reviewed_with_drift / reviewed_no_drift`）在不可比时的口径：逐字节比较两份封存 `classes`——执行时点不可比（`classes=null`）而复盘可比 → 视为「不可证相同」→ `reviewed_with_drift`；两时点皆不可比（同为 `null`）→ `reviewed_no_drift`。理由码只描述封存值是否一致，不新生成任何数字。

**禁止表述**（写入页面文案与验收断言）：不得出现「建议收益」「这次操作赚了」「跑赢目标」等把配置变化说成收益的措辞；必须写「配置变化对照」。三时点对照是**配置事实**，不是业绩归因——归因（`computeReturnAttribution`）是月结的独立功能，两者不合并。

### 4.4 缺数据与不可比

```text
cashReconciled = !overview.freshness.balanceStale
available       = (overview.canAdvise === true) && cashReconciled
reason          = available ? null
                  : (cashReconciled ? 'valuation_not_formal' : 'cash_not_reconciled')
```

- `available === true` 时 `reason` 恒为 `null`（§4.2 示例即此情形）。2026-09-29 勘误：原公式缺 `available` 判定，会把可比快照也写成 `valuation_not_formal`。

- `available === false` → `netWorthMinor` / `investableTotalMinor` / `classes` **全部为 `null`**，`reason` 与 `blockers` 解释原因；**任何情况下都不输出伪 0、伪收益**。
- `available` 只说明该时点配置估值能否比较；历史买入缺折算汇率时，`execution` 的 CNY 汇总按 §3.3 为 `null`，即使 `available === true` 也不伪造执行金额。两种可用性不能互相代替。
- `reason` 词表冻结为两个值：`cash_not_reconciled`、`valuation_not_formal`；`blockers` 沿用 `computeOverview` 的既有码（`quote_missing` / `quote_stale` / `fx_stale` / `fx_missing` / `classification_unconfirmed` / `balance_stale` / `close_incomplete` …），**不另造第二套 blocker 码**。
- `available === true` 且投资池为 0：`investableTotalMinor = 0`、`classes[].pctBps/band/deviationBps = null`、`valueMinor = 0`，`valuationStatus` 照实填写。这是**合法的可比状态**（0 元案例），不是缺数据。
- 复盘（`executed → reviewed`）**本身不因缺数据而被拒绝**：缺数据时照样封存，但快照为 `available:false`，页面必须显著标注「不可比」。用户想得到可比复盘，应先补行情 / 汇率 / 现金核对再复盘——因为 `reviewed` 是终态，封存后不可改。

### 4.5 快照完整性与读取复核

每次读取（列表、详情、`/state`、备份恢复）必须复核，任一条不过即 fail closed：

1. `sha256(snapshot_json) === snapshot_hash`；
2. 事件序列完整：**`state = 'proposed'` 且 `last_seq = 0` 的零事件决策是合法空序列**（§1.3 两步式创建；尚无任何事件，也**没有任何快照**——快照随事件封存，此时详情 `snapshots` 各时点为 `null`）。其余情况必须有事件，且 `seq` 从 1 连续递增、首条 `from_state = 'proposed'`、每条 `from_state` = 上一条 `to_state`、末条 `to_state = decisions.state`、`decisions.last_seq = max(seq)`；
3. `decision_events.actor = 'local-user'`、`from_state/to_state` 都在 §1.1 词表内；
4. `decisions.recommendation_id` 指向的建议存在且记录复核通过（G5-R1 同口径）；
5. 每条活动 `decision_links` 的 `security_event_id` 指向存在的 `buy` 事件。

列表把失败行排除出可用视图并计入 `invalidCount`（与 5B/5C/5D 同纪律）；**详情接口对失败行直接 400 `invalid_decision_record`**，detail 点名失败的检查项。任何情况下都不得"修好"或"跳过"再返回。

---

## 5. 月度历史归属

- **筛选月 = `substr(decision_events.occurred_at, 1, 7)`**，即**本地事件发生月**；月底边界 = 本地日历月末（不按 30 天、不按 UTC）。
- 一条决策可以在多个月出现（**状态事件**跨月），列表项返回 `eventMonths: ["2026-10","2026-11"]`；详情永远是**完整时间线**，不按月截断。`eventMonths` 是状态事件月份去重升序集合，关联 / 解绑当天不会新增月份。
- **回填交易日 ≠ 事件记录时间**：`security_events.occurred_at`（交易日，可早于操作时间、可回填）只用于交易明细展示与本金折算；月度筛选只认 `decision_events.occurred_at`。两者在页面上必须分别标注为「交易日」与「操作时间」。
- 关联 / 解绑不产生状态事件，因此**不单独影响月度归属**；它们通过所属决策的事件被包含进该月。
- 空月份不生成条目；筛选结果为空时显示空态，不报错。

---

## 6. 数据契约

### 6.1 表结构（迁移 **v11** `phase6-decisions`，6B 实施）

```sql
CREATE TABLE decisions (
  id                TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL UNIQUE REFERENCES recommendations(id) ON DELETE RESTRICT,
  state             TEXT NOT NULL CHECK (state IN
                    ('proposed','accepted','deferred','dismissed','executed','reviewed','archived')),
  last_seq          INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_decisions_state ON decisions(state, updated_at);
CREATE INDEX idx_decisions_updated ON decisions(updated_at, id);

CREATE TABLE decision_events (
  id            TEXT PRIMARY KEY,
  decision_id   TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL CHECK (seq >= 1),
  from_state    TEXT NOT NULL CHECK (from_state IN ('proposed','accepted','executed')),
  to_state      TEXT NOT NULL CHECK (to_state IN
                ('accepted','deferred','dismissed','executed','reviewed','archived')),
  reason_code   TEXT NOT NULL,
  note          TEXT,
  occurred_at   TEXT NOT NULL,          -- 本地日 YYYY-MM-DD
  recorded_at   TEXT NOT NULL,          -- ISO 时刻
  actor         TEXT NOT NULL CHECK (actor = 'local-user'),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
  snapshot_hash TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  UNIQUE (decision_id, seq)
);
CREATE INDEX idx_decision_events_occurred ON decision_events(occurred_at, decision_id);

CREATE TABLE decision_links (
  id               TEXT PRIMARY KEY,
  decision_id      TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  security_event_id TEXT NOT NULL REFERENCES security_events(id) ON DELETE RESTRICT,
  linked_on        TEXT NOT NULL,
  linked_at        TEXT NOT NULL,
  note             TEXT,
  unlinked_on      TEXT,
  unlinked_at      TEXT,
  unlink_note      TEXT
);
CREATE INDEX idx_decision_links_decision ON decision_links(decision_id);
CREATE UNIQUE INDEX uq_decision_links_active
  ON decision_links(security_event_id) WHERE unlinked_on IS NULL;
```

设计依据（写进迁移注释）：

- `recommendation_id` 是 `ON DELETE RESTRICT` **活动外键**（与 `recommendations.assessment_id` 同口径）：有决策引用时建议删不掉。这与 `close_id` 的「审计引用不设外键」不同——因为建议与决策总是在同一个事务集合里被清空与重建，顺序可控（见 §6.4）。
- `security_event_id` 同样 `RESTRICT`：解绑是软删除，关联行与其外键引用都保留，**不允许存在指向已消失交易的关联行（活动或已解绑）**——因此曾被关联过的证券事件一律不可物理删除（§3.2，2026-09-29 勘误）。
- `CHECK` 只挡结构（状态词表、actor、JSON 类型、seq 域）；逐字段语义、链式一致性与「快照被改」在仓储 / 领域唯一实现里复核（D-044 ③ 的同一取舍）。
- `decisions` 不存 `reason_code` / `note` / `actor`：这些只在事件上，读取按 `last_seq` 取，避免两份可分叉的真相。列表需要时用 `seq = last_seq` 的 join。
- **旧库前向迁移后三张表为空，不伪造任何历史决策**（与 v8 / v10 同口径）。

### 6.2 服务端派生、客户端不可提交的字段

`id` / `seq` / `state` / `reason_code` / `occurred_at` / `recorded_at` / `actor` / `snapshot_json` / `snapshot_hash` / `payload_hash` / `created_at` / `updated_at` / `linked_on` / `linked_at` / `unlinked_on` / `unlinked_at`。

**载荷中出现上述任一键（含不可枚举键与原型链键）→ 400 `invalid_decision_payload`**，与 5B/5C/5D 的键白名单纪律一致（派生值不在允许集合内，伪造在入口就被拒绝）。

### 6.3 服务端派生的理由码 `reason_code`（词表冻结）

```text
agree                     proposed → accepted
postpone                  proposed → deferred
dismiss_not_actionable    proposed → dismissed
executed_as_planned       accepted → executed 且 diff === 0
executed_deviation        accepted → executed 且 diff ≠ 0 或不可判定
no_trade                  accepted → archived（建议金额为 0，且从未关联过买入）
abandoned                 accepted → archived（其他活动关联为 0 的放弃情形）
reviewed_with_drift       executed → reviewed 且六类金额或比例与执行时点不同
reviewed_no_drift         executed → reviewed 且与执行时点逐项相同
```

`reason_code` 由**服务端**根据动作与计算结果得出，客户端不可指定；用户的自由文本理由走 `note`。归档先要求活动关联为 0（§3.5），再唯一判定：`no_trade` 当且仅当 `rec.allocatedTotalMinor === 0` **且**该决策从未存在任何 `decision_links` 行；其余均为 `abandoned`。因此正金额建议接受后尚未关联就放弃，明确是 `abandoned`；零金额建议曾关联后全部解绑，也为 `abandoned`。判定只读封存建议金额与关联历史，不从自由文本猜意图。

### 6.4 写入顺序与全量写入

- `CLEAR_ORDER` 头部必须插入 `decision_links` → `decision_events` → `decisions`（均在 `recommendations` 与 `security_events` **之前**），否则 `RESTRICT` 会让整表重置失败。
- `writeState` 写入顺序必须保证 `recommendations` 与 `writeSecurityEvents` 之后才写 `decisions` / `decision_events` / `decision_links`。
- **普通五键保存**：`decisions` / `decisionEvents` / `decisionLinks` 加入伴随集合（`COMPANION_KEYS` / `COMPANION_STATE_KEYS` 由 6 → **9**），由 `preserveCompanionCollections` 在同一事务读回写回；**不恢复客户端 GET→PUT 覆盖窗口**。
- **显式 `decisions: []`** = 清空；**非数组** → 400 `invalid_asset_collection`（沿用既有伴随集合纪律）。
- **旧备份（无这三个键）**：`PUT /state` 不带 preserve 标志 → **缺键即清空，恢复为空历史，不从活库保留**（与 D-049 ⑥ 一致）。
- 全量写入逐条校验：`recommendation_id` 必须存在于本次写入集合（否则 422 `unknown_recommendation`），活动关联的 `security_event_id` 必须存在且为 `buy`（否则 409 `linked_event_missing`），任一条不合格**整体回滚，绝不静默丢行**。
- `Store.saveAll` 不得新增任何 GET→PUT 往返；前端只声明保留意图。

### 6.5 备份结构校验（按版本）

| 校验 | v11 新增 |
|---|---|
| `REQUIRED_TABLES_BY_VERSION[11]` | `decisions`, `decision_events`, `decision_links` |
| `REQUIRED_INDEXES_BY_VERSION[11]` | `decisions.uq_decisions_recommendation`（unique, `[recommendation_id]`）、`decision_events.uq_decision_events_seq`（unique, `[decision_id, seq]`）、`decision_links.uq_decision_links_active`（**unique + partial:true**, `[security_event_id]`）、`decision_links.idx_decision_links_decision` |
| `REQUIRED_COLUMNS_BY_VERSION[11]` | decisions: `recommendation_id`,`state`,`last_seq`,`created_at`,`updated_at`；decision_events: `decision_id`,`seq`,`from_state`,`to_state`,`reason_code`,`occurred_at`,`recorded_at`,`actor`,`snapshot_hash`,`payload_hash`；decision_links: `decision_id`,`security_event_id`,`linked_on`,`unlinked_on` |

**6B 必须同时强化 `server/backup.js` 的索引校验**：现有实现只挡 `spec.partial === false && info.partial`，不挡反向。增加对称分支 `spec.partial === true && !info.partial → 拒绝`，否则「把部分唯一索引手工换成普通索引」能让活动关联唯一性静默失效（正是 D-040 要堵的那类缺口）。这是**加强**校验，不是放宽。

---

## 7. 错误码与 HTTP 状态（Phase 6 词表，独立于 5A/5C/5D）

| 错误码 | HTTP | 触发 |
|---|---|---|
| `invalid_decision_payload` | 400 | 载荷非对象 / 键不在白名单 / 出现服务端派生键 / 出现时间或 actor |
| `deviation_note_required` | 400 | `toState=executed` 有偏差但缺 `note` |
| `invalid_decision_record` | 400 | 读取或恢复时链式一致性、快照哈希、引用复核失败 |
| `invalid_recommendation_record` | 400 | 被引用建议复核失败（沿用既有码） |
| `unknown_decision` | 404 | 路径参数 `id` 不存在（路径资源用 404；载荷引用用 422） |
| `illegal_transition` | 409 | §1.2 矩阵外的任何状态跳转、非法 `intent`、自转移 |
| `recommendation_not_formal` | 409 | 用 estimate 创建决策 |
| `recommendation_stale` | 409 | 接受时 `adviceStaleness` 非空 |
| `no_linked_events` | 409 | `accepted → executed` 时活动关联为 0 |
| `has_linked_events` | 409 | `accepted → archived` 时活动关联 > 0 |
| `event_already_linked` | 409 | 事件已活动关联到另一决策 |
| `link_not_active` | 409 | 解绑一条非活动关联 |
| `illegal_state_for_link` | 409 | 在非 `accepted`/`executed` 状态关联或解绑 |
| `invalid_link_target` | 409 | 关联非 `buy` 事件 |
| `linked_event_missing` | 409 | 全量写入删除（省略）了曾被任何关联行（活动或已解绑）引用的事件，或写入的关联指向不存在的事件 |
| `idempotency_conflict` | 409 | 同 `Idempotency-Key` 不同请求体（沿用） |
| `unknown_recommendation` | 422 | 载荷中的 `recommendationId` 不存在 |
| `unknown_security_event` | 422 | 载荷中的 `securityEventId` 不存在 |
| `unknown_decision_link` | 422 | 载荷中的 `linkId` 不存在，或不属于路径上的这条决策 |
| `invalid_asset_collection` | 400 | 伴随集合非数组（沿用） |

响应体沿用现有 `fail(res, status, code, message, retryable)` 形状；**消息为中文、可重试性显式**；不得只返回自由文本堆栈。

---

## 8. 接口契约与例子

### 8.1 `POST /api/v1/decisions`

请求键白名单（严格，多一个键即 400）：`recommendationId`（必填）、`intent`（可选）、`note`（条件必填）。

```jsonc
// 请求 A：一步创建并接受（6C 页面使用）
{
  "recommendationId": "rec-3f2a9c1b7d4e5f60",
  "intent": "accepted",
  "note": "本月发薪后按建议补宽基，分两笔执行"
}
// 请求 B：只创建 proposed，稍后用事件端点决定（测试与两步式页面使用）
{ "recommendationId": "rec-3f2a9c1b7d4e5f60" }
```

`note` 必填规则（`trim` 后非空，≤ 2000 字符，超出 → 400 `invalid_decision_payload`）：

| 结果状态 | `note` |
|---|---|
| `accepted` / `deferred` / `dismissed` / `archived` / `reviewed` | **必填** |
| `executed` | 有偏差时**必填**，无偏差可空 |
| `proposed`（省略 intent） | 可空 |

成功响应（`201` 新建 / `200` 既有）：

```jsonc
{
  "ok": true,
  "created": true,
  "decision": {
    "id": "dec-9a8b7c6d5e4f3021",
    "recommendationId": "rec-3f2a9c1b7d4e5f60",
    "state": "accepted",
    "lastSeq": 1,
    "createdAt": "2026-10-15T01:30:00.000Z",
    "updatedAt": "2026-10-15T01:30:00.000Z",
    "eventMonths": ["2026-10"]
  },
  "events": [{
    "id": "dev-1122334455667788",
    "decisionId": "dec-9a8b7c6d5e4f3021",
    "seq": 1,
    "fromState": "proposed",
    "toState": "accepted",
    "reasonCode": "agree",
    "note": "本月发薪后按建议补宽基，分两笔执行",
    "occurredAt": "2026-10-15",
    "recordedAt": "2026-10-15T01:30:00.000Z",
    "actor": "local-user",
    "snapshot": { "schemaVersion": 1, "asOf": "2026-10-15", "available": true, "reason": null }
    // 省略：snapshot 内完整结构见 §4.2；payloadHash 一并返回
  }],
  "links": [],
  "execution": { "linkedCount": 0, "linkedPrincipalCnyMinor": 0, "linkedFeeCnyMinor": 0,
                 "remainingMinor": 200000, "fxUnavailable": [] }
}
```

同一 `recommendationId` 第二次请求（同 `Idempotency-Key`）→ 200 + 原响应 + `X-Ledger-Idempotent: replay`；不同 `Idempotency-Key` → 200 + `created:false` + 既有决策（**不改状态、不追加事件**）；`Idempotency-Key` 相同但载荷不同 → 409 `idempotency_conflict`。

### 8.2 `POST /api/v1/decisions/{id}/events`

请求键白名单：`toState`（必填）、`note`（条件必填）。

```jsonc
{ "toState": "executed", "note": "两笔买入合计 1,999.00，少 1.00 元保留为现金" }
// → 200，accepted → executed，reasonCode = executed_deviation（diff = -100）
```

```jsonc
{ "toState": "reviewed", "note": "宽基已回到区间内，下月继续按新增资金补" }
// → 200，executed → reviewed，reasonCode = reviewed_with_drift / reviewed_no_drift（服务端算）
```

失败一律**事务整体回滚**：`illegal_transition`(409)、`no_linked_events`(409)、`has_linked_events`(409)、`deviation_note_required`(400)、`unknown_decision`(404)。

> 该路由目前是 501 `not_implemented`（`server/api.js` 末尾的 Phase 6 占位）。**6B 必须实现真实行为，而不是只删掉 501 分支。**

### 8.3 `GET /api/v1/decisions`

查询参数（全部可选，互为与关系）：`state`（单词表值）、`month`（`YYYY-MM`）、`recommendationId`、`from` / `to`（`YYYY-MM-DD`，按事件 `occurred_at` 区间）。

```jsonc
{
  "ok": true,
  "items": [{
    "id": "dec-9a8b7c6d5e4f3021",
    "recommendationId": "rec-3f2a9c1b7d4e5f60",
    "recommendationStatus": "formal",
    "state": "accepted",
    "reasonCode": "agree",
    "note": "本月发薪后按建议补宽基，分两笔执行",
    "lastEventAt": "2026-10-15",
    "createdAt": "2026-10-15T01:30:00.000Z",
    "updatedAt": "2026-10-15T01:30:00.000Z",
    "eventMonths": ["2026-10"],
    "allocatedTotalMinor": 200000,
    "execution": { "linkedCount": 1, "linkedPrincipalCnyMinor": 100000,
                   "linkedFeeCnyMinor": 500, "remainingMinor": 100000, "fxUnavailable": [] }
  }],
  "total": 1,
  "invalidCount": 0,
  "states": ["accepted"],
  "months": ["2026-10"]
}
```

排序：`updatedAt` 降序 → `id` 升序，与数据库行序无关（不变量 6）。复核失败的行不进 `items`，计入 `invalidCount`。

### 8.4 `GET /api/v1/decisions/{id}`

```jsonc
{
  "ok": true,
  "decision": { "…": "同上" },
  "events":  [ { "…": "完整状态时间线，按 seq 升序" } ],
  "links":   [ { "id": "lnk-…", "securityEventId": "sev-…", "event": {
                   "eventType": "buy", "occurredAt": "2026-10-20", "quantity": "10",
                   "priceMinor": 100000, "feeMinor": 500, "currency": "CNY",
                   "instrumentId": "inst-…", "accountId": "acc-…" },
                 "linkedOn": "2026-10-21", "unlinkedOn": null, "note": null } ],
  "recommendation": { "id": "rec-…", "status": "formal", "asOf": "2026-10-01",
                      "allocatedTotalMinor": 200000, "inputHash": "…",
                      "explanationVersion": "1", "adviceStaleReasons": [] },
  "snapshots": { "decision": { "…": "§4.2" }, "executed": null, "reviewed": null,
                 "archived": null },
  "comparison": { "comparable": false,
                  "timepoints": { "decision": { "present": true, "available": true, "reason": null, "blockers": [] },
                                  "executed": { "present": false, "available": false, "reason": null, "blockers": [] },
                                  "reviewed": { "present": false, "available": false, "reason": null, "blockers": [] } },
                  "rows": [ { "assetClass": "cash", "targetBps": null, "decision": null, "executed": null,
                              "review": null, "deltaValueMinor": null, "deltaPctBps": null } ] },
  "execution": { "…": "§8.3" },
  "timeline": [ { "at": "2026-10-15", "kind": "state", "…": "…" },
                { "at": "2026-10-21", "kind": "link", "…": "…" } ]
}
```

- `timeline` = 状态事件 + 关联 / 解绑按 `occurred_at` 合并升序（关联行用 `linked_on` / `unlinked_on`），是 6E-2 时间线的数据源。
- `comparison`（6E 补充）= §4.3 末定义的六类配置对照；本例为尚未执行的决策（只有决策时点快照），`comparable:false` 且各行 cell / delta 为 `null`。
- `recommendation.adviceStaleReasons` 只做展示（D-054），**不改变决策状态**。
- 任一复核失败 → 400 `invalid_decision_record`，detail 点名检查项。

### 8.5 关联与解绑

请求键白名单（严格，多一个键即 400 `invalid_decision_payload`；派生键按 §6.2 拒绝）：

| 端点 | 必填 | 可选 |
|---|---|---|
| `POST .../links` | `securityEventId` | `note`（≤ 2000 字符，关联说明，可空） |
| `POST .../links/unlink` | `linkId`、`note`（解绑理由，trim 后非空） | 无 |

```jsonc
// POST /api/v1/decisions/{id}/links
{ "securityEventId": "sev-7788aabbccdd0011", "note": "第一笔买入" }
// → 201 { created:true, link:{…}, execution:{…} }
// 已活动关联到本决策 → 200 { created:false, link:{同一条}, execution:{…} }
```

```jsonc
// POST /api/v1/decisions/{id}/links/unlink
{ "linkId": "lnk-…", "note": "选错了账户，重新关联到券商账户那笔" }
// → 200 { ok:true, link:{ unlinkedOn:"2026-10-22", unlinkNote:"…" }, execution:{…} }
```

### 8.6 幂等通则

- 所有 `POST` 支持可选 `Idempotency-Key`：指纹 = `sha256(canonicalJson(body))`；命中同指纹 → 回放首次响应 + `X-Ledger-Idempotent: replay`；不同指纹 → 409 `idempotency_conflict`；**幂等记录与业务写入在同一 SQLite 事务提交**（D-043 ①）。
- 无 `Idempotency-Key` 时靠自然键幂等：创建（`recommendationId`）、关联（`securityEventId` 活动唯一）。
- 事件端点**没有自然幂等**（第二次同请求即非法跳转），因此 6C 页面必须带 `Idempotency-Key`，避免双击产生 409 或重复事件。

---

## 9. 迁移、备份与回滚

| 项 | 方案 |
|---|---|
| 迁移 | **v11 `phase6-decisions`**，只前向；从当前 v10 起步，具体版本以实施时为准。每个迁移自成事务，失败整体回滚（既有 `migrate()` 行为） |
| 旧库升级 | v10 库 → v11 后三张表**为空**，不伪造决策；已有建议、月结、快照、评估、目标、映射**逐字节不变** |
| 迁移前置 | 按 AGENTS：**迁移前必须有可恢复备份**（`backups/` 内已有最近 30 份 + 迁移当日 `pre-migrate` 快照）；文档阶段不操作真实数据库 |
| 回滚 | 项目无 down 迁移。回滚 = **恢复迁移前的备份文件**（`POST /api/v1/restores` 或 `ledger.db` 换回）。回滚后 schema 回到 v10，Phase 6 三表消失，其余数据不变 |
| SQLite 备份 | `VACUUM INTO` 不变（D-027）；v11 结构进 `REQUIRED_*` 三张清单（§6.5） |
| JSON 备份 | `Core.createBackup` / 恢复同步包含三个新集合；**旧 JSON 备份缺键 → 恢复为空历史**，非数组显式拒绝 |
| 空库恢复 | 全新空库恢复 v11 备份 → 三表 + 索引 + 数据齐全；恢复 v10 备份 → 三表存在但为空 |
| 损坏拒止 | 快照哈希不符 / `seq` 断链 / 引用缺失 / 索引被换成普通索引 → 恢复在**校验阶段**失败、活库不变（D-040 同纪律） |
| 普通保存 | 五键保存不删三集合；显式 `decisions: []` 才清空；无 preserve 标志的旧备份恢复语义不变 |

---

## 10. Fixture 与测试清单（6B～6F 消费）

### 10.1 正向：两套完整闭环（6A 验收要求"可从建议走到复盘"）

**F-A｜单笔、同月、无偏差**

| 步骤 | 输入 | 期望 |
|---|---|---|
| 1 | 正式建议 `rec-A`（2,000.00 CNY → `broad_equity`，映射 `VOO`） | 存在、`status=formal` |
| 2 | `POST /decisions` `intent=accepted` + note | `dec-A` accepted，1 事件，决策时点快照 `available:true` |
| 3 | 新建 1 笔 `buy`（20 × 100.00 CNY，fee 5.00）→ `POST .../links` | 活动关联 1，进度 100%（本金 2,000.00 = 建议金额；2026-09-29 勘误：原稿 10 × 100.00 与建议 2,000.00 不符） |
| 4 | 核对现金余额（消除 `balance_stale`） | `cashReconciled:true` |
| 5 | `POST .../events` `toState=executed`，`diff=0` | `reason=executed_as_planned`，执行时点快照封存 |
| 6 | `POST .../events` `toState=reviewed` + note | `reason=reviewed_*`，复盘时点快照封存，三快照齐全 |

**F-B｜分批、跨月、有偏差、备份恢复**

| 步骤 | 输入 | 期望 |
|---|---|---|
| 1 | 另一个月的正式建议 `rec-B`（5,000.00 CNY） | 与 F-A 无共用事件 |
| 2 | 10 月 accept → 第 1 笔 CNY buy（20 × 100.00 = 2,000.00）→ link | 进度部分；`eventMonths = ["2026-10"]` |
| 3 | 11 月第 2 笔 HKD buy（30 × 100.00 = 3,000.00 HKD），交易日 as-of HKD→CNY 汇率 0.9（2,700.00 CNY）→ link | 仅关联，不产生状态事件；此刻 `eventMonths = ["2026-10"]`，时间线另列 11 月关联操作；本金合计 4,700.00 CNY |
| 4 | 11 月核对现金 → executed（`diff = -300.00`，note 必填） | 追加 11 月状态事件后 `eventMonths = ["2026-10","2026-11"]`；`reason=executed_deviation`，`remainingMinor = 300.00 CNY` |
| 5 | reviewed + note | 三时点六类对照逐 basis point 可复算 |
| 6 | 生成 SQLite 备份 → 清空到空库 → 恢复 | 状态、事件顺序、关联、快照、引用与建议**逐字段一致**，`invalidCount=0` |

### 10.2 反向清单（每条都必须有独立用例）

1. §1.2 的 **49 个有序对全遍历**（6 合法 / 43 非法，含自转移）；
2. `intent` 取 `executed` / `reviewed` / `archived` / `proposed` → 409，且**不创建决策行**；
3. estimate 建议创建 → `recommendation_not_formal`；
4. 未知 `recommendationId` → `unknown_recommendation`；未知 `securityEventId` → `unknown_security_event`；
5. 失效 formal 建议 `intent=accepted` → `recommendation_stale`；同一条 `intent=deferred` **允许**；
6. 同 `recommendationId` 二次创建 → `created:false`、行数不变、状态不变；
7. `Idempotency-Key` 同载荷回放 / 异载荷冲突；幂等记录与写入同事务（中途失败不留半条记录）；
8. 关联 `sell` / `dividend` / `fee` → `invalid_link_target`；
9. 同一事件关联到第二条决策 → `event_already_linked`；关联到同一条 → `created:false`；
10. 在 `deferred` / `dismissed` / `reviewed` 关联或解绑 → `illegal_state_for_link`；
11. `accepted → executed` 无关联 → `no_linked_events`；
12. `accepted → archived` 有活动关联 → `has_linked_events`；
13. executed 有偏差但缺 `note` → `deviation_note_required`；
14. 解绑非活动关联 → `link_not_active`；解绑缺 `note` → `invalid_decision_payload`；
15. 改动 `snapshot_json` 一个字节 → 读取 400 / 列表 `invalidCount+1`，**活库不变**；
16. 制造 `seq` 断链、`decisions.state` ≠ 末事件 `to_state`、`actor ≠ local-user` → `invalid_decision_record`；
17. 恢复**缺三键的旧 JSON 备份** → 决策为空历史，不从活库保留、不伪造；
18. **普通五键保存** → 三集合保留（G5C-1 同类回归）；显式 `decisions: []` → 清空；非数组 → 400；
19. 全量写入删除**曾被任何关联行（活动或已解绑）引用**的 `security_event` → `linked_event_missing` 整体回滚；软解绑后再删同样拒绝；
20. 缺汇率的关联 → 列表、详情、关联响应、快照的三个 CNY 汇总字段均为 `null`，`linkedCount` 保持实际条数，`fxUnavailable` 顺序稳定；executed 走 `executed_deviation` 且 note 必填，**不按 1:1 或部分小计兜底**；无活动关联时汇总为 0、剩余为建议金额；
21. 现金未核对 → 复盘快照 `available:false` + `reason=cash_not_reconciled`，`netWorthMinor` / `investableTotalMinor` / `classes` 为 `null`，`execution` 仍按 §3.3 保留关联事实；
22. 缺报价 / 过期价格 / 分类未确认 → `available:false` + `valuation_not_formal` + 既有 blockers；
23. 0 投资池 → `available:true`、`pctBps/band/deviationBps = null`、金额为 0，**不算不可比**；
24. 0 元建议 → `accepted` → `archived`（从未关联过事件 → `no_trade`），**不存在任何证券交易**，不进复盘历史；正金额建议从未关联就归档、或任意金额建议曾关联后全部解绑再归档 → `abandoned`（§6.3 判定规则）；
25. 月度归属：月底边界（本地 10-31 vs UTC 11-01）、回填交易日早于操作时间、10 月接受后 11 月仅关联仍只属 10 月、11 月执行后才同时属两月、空月份；
26. 迁移：v10 → v11 空表；v11 库二次迁移幂等；迁移中途失败整体回滚；
27. 备份结构：缺表 / 缺必需索引 / 缺必需列 / **部分唯一索引被换成普通索引** → 拒绝恢复且活库不变；
28. 原功能回归：记账、账单导入、去重、月结、建议生成、G5-R1～R3 反例全部保持通过。

### 10.3 时钟与网络

所有用例注入固定 `ctx.today` / `ctx.nowIso`；**零真实网络**；只用隔离 fixture 与临时数据库，不读取私人账本。

---

## 11. 6B 必须显式更新的既有守卫（不是删断言）

这些测试是**阶段范围守卫**，它们的存在就是为了被下一个阶段显式推进。6A 不改它们；6B 必须**逐条更新并在测试注释里写明原因**，禁止靠删用例换绿色：

| 位置 | 现有断言 | 6B 应改为 |
|---|---|---|
| `tests/domain-phase5a.test.js` `5A-18` | `M.LATEST_VERSION === 10`；迁移名不含 `decisions\|decision_events` | `=== 11`；最后一项为 `phase6-decisions`；不再断言"无 Phase 6 表"，改为断言**只有**该三表 |
| `tests/server-api.test.js` | `POST /api/v1/decisions/d-1/events` → 501 且消息含 `Phase 6` | 真实路由；改为断言合法/非法转移的真实行为 |
| `tests/server-phase3.test.js` | 同上 501 | 同上 |
| `tests/server-phase5d.test.js` | 无 `decisions` / `decision_events` 表；建议表无状态列 | 改为断言 **`recommendations` 仍然没有状态列**（决策状态只在 `decisions` 表），并保留"5D 段落不含决策语义"的原意 |
| `tests/domain-phase5d.test.js` `5D-24` | 段落扫描 `start(5D 标题) → end(\n    CURRENCIES)`，禁止出现 `accepted` / `executed` / `decision_events` 等词 | **6A 冻结的实现选择**：Phase 6 领域逻辑放进 `js/domain.js` 的**新段落**「决策状态机与执行关联（Phase 6）」，把 5D 段落的 `end` 标记下移到新段落开头；**并新增一个同形状的 Phase 6 段落守卫**（禁时钟 / 网络 / 存储 / 券商下单词面）。只移动边界标记、不删任何断言，且守卫数量只增不减 |
| `tests/domain-phase5c.test.js` | 5C 段落禁止 `decision_event` / `accepted` | 段落边界本就止于 5D 开头，Phase 6 代码放 5D 段落之后 → **无需改动**；6B 复核确认 |
| `tests/backup.test.js` / `server-migration.test.js` / `store-headers.test.js` | v10 结构、六伴随集合、五键保留 | 扩展到 v11 与九伴随集合；**旧断言语义保留**（六集合仍必须被保留） |
| `docs/evidence/phase5-review-20260927/browser-review.py` | 硬编码 wiring 恰为 34 项 | **不删旧断言**。可另建 Phase 6 wiring 套件，或同步更新 runner 的明确数量与覆盖契约（拆解 §9 原文） |

另：`server/api.js` 末尾的 `POST /api/v1/decisions/{id}/events` 501 占位分支必须删除并替换为真实实现；`DEFERRED_WRITES` 不得因此放宽其它延后接口。

---

## 12. 歧义裁定记录（6A 结论，0 未决）

拆解 §3 表格的 8 条，逐条落地：

| 歧义 | 6A 结论 | 依据 / 确认 |
|---|---|---|
| 什么对象进 proposed | 只绑 `formal` 建议；estimate 不进清单、不可决策；一条建议一条决策（自然幂等）；接受时服务端重核 staleness | §2.1/§2.2；用户确认 |
| 暂缓如何恢复 | 不开放 `deferred → accepted`；事实变化 → 新建议 → 新决策 | §2.4；用户确认，**不记规则变更** |
| 接受后建议失效 | 历史接受记录保留；失效只挡**再次接受**，不挡**事后关联**；记事实 ≠ 重新批准 | §2.3（D-054 / 拆解原文） |
| 分批 / 少买 / 超买 / 换标的 / 手续费 | 只关联 `buy`；多笔分批；剩余量是进度不是状态；不按金额相等自动 executed；偏差靠 `note`；手续费单列不进本金 | §3.1/§3.3；用户确认事件类型 |
| 重复关联与纠错 | 一事件一活动决策（部分唯一索引）；解绑软删除留痕；`reviewed` 后冻结 | §3.2/§3.4 |
| 0 元 / 全现金 / 无交易 | 新增终态 `accepted → archived`，理由必填，不伪造交易，不进复盘 | §1.1/§3.5；用户确认，**记 D-057 规则扩展** |
| 执行后配置变化比较什么 | 三时点各自封存；六类金额 / 比例 / 偏离；`targetRef` 用历史目标；缺数据不可比不出伪 0；禁止"收益"表述 | §4.1～§4.4 |
| 月度历史归属 | 按 `decision_events.occurred_at` 本地事件月；跨月多次出现；交易日与操作时间分列 | §5 |

**未决项：0。规则冲突：0。**

---

## 13. 交付与下一步

6A 交付 = 本文件 + §11 的更新清单 + §9 的迁移回滚方案 + §10 的 fixture 清单 + 五个文档同步（PRODUCT / DECISIONS / ARCHITECTURE / ACCEPTANCE / ROADMAP）。**不含任何代码、迁移或页面改动。**

6B 入口见 [NEXT_AGENT.md](./NEXT_AGENT.md)；实施时按 [PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md) §9 交付。
