# Phase 1–5A 当前状态完整复核

> 复核日期：2026-09-20  
> 复核范围：Phase 1、2、3、4A–4E、5A；实现、迁移、API 延后登记、测试与交接文档  
> 当前版本：`2.4.6-phase5a`（Phase 5A 最终验收通过）

## 结论

当前**可以进入 5B**。Phase 1–3 已验收；Phase 4A 的 provider 契约已完成，但行情源证据未通过 D-038/T-002 启用门禁，所以正式验收仍待定、自动行情保持关闭；Phase 4B–4E 已完成各轮实现补口，仍以各自独立复核文档为最终状态。Phase 5A 的 G5A-1～12 已全部闭合并通过最终验收。

## 分阶段状态

| 阶段 | 当前状态 | 已闭合范围 | 剩余门禁 |
|---|---|---|---|
| Phase 1 | ✅ 已完成并验收 | 资产领域基础、三币种折算、决策台、备份 schema v2 | 无阶段阻塞 |
| Phase 2 | ✅ 已完成并验收 | 仅监听回环地址的本地服务、SQLite 唯一事实源、备份恢复、Keychain、只读降级 | 无阶段阻塞 |
| Phase 3 | ✅ 已完成并验收 | 多币种账户、换汇、负债/保障权益、福利预设、月结快照、应急金覆盖 | 无阶段阻塞 |
| Phase 4A | ⚠️ 契约完成，正式验收暂不通过 | provider 白名单、严格时间、固定时钟、离线 fixture、汇率源固定 | 行情源尚未以官方条款/限额/授权/覆盖/失败语义通过 D-038；自动行情必须关闭 |
| Phase 4B | 🟡 三轮补口完成，待独立复核确认 | 标的目录、分类确认、原位 upsert、provider 身份绑定、多市场歧义、全量写入门禁 | 以 `PHASE4B_ACCEPTANCE_GAPS.md` 为准 |
| Phase 4C | 🟡 三轮补口完成，待独立复核确认 | 持仓账本、证券事件、日期边界、严格重放、原子幂等、全量状态校验 | 以 `PHASE4C_ACCEPTANCE_GAPS.md` 为准 |
| Phase 4D | 🟡 三轮补口完成，待独立复核确认 | 日终行情/汇率编排、请求结果绑定、手动值锁定、失败语义 | 以 `PHASE4D_ACCEPTANCE_GAPS.md` 为准；自动行情仍关闭 |
| Phase 4E | 🟡 两轮补口完成，待独立复核确认 | 估值下钻、封存期初明细、归因恒等式、快照原文哈希校验 | 以 `PHASE4E_ACCEPTANCE_GAPS.md` 为准 |
| Phase 5A | 🟢 已通过 | 题库/评分/硬封顶/模板/有效期/建议契约；G5A-1～12 均有实现与回归用例 | 可进入 5B；5B 从 `2.4.7-phase5b` 开始 |

## 本轮修复

### G5A-8｜原型链字段可伪装为自有答案或比例

- 答案数组只接受普通、稠密、自有数据索引；不读取继承索引，不执行访问器。
- 每个答案行只允许精确自有数据字段 `questionId` / `optionId`。
- 目标模板顶层只允许 `level` / `templateVersion` / `classes`；`classes` 精确匹配冻结类别；比例行只允许 `minBps` / `targetBps` / `maxBps`。
- 普通对象与 `Object.create(null)` 的 JSON 等价纯数据对象均可用；自定义原型、额外键、Symbol、getter 均拒绝。

### G5A-9｜完整评分结果受答案排列影响

- 校验后按冻结 `RISK_QUESTIONS` 顺序重建答案。
- 正序与倒序答案的完整评分结果直接深比较一致，包括 `scored`。
- 规范化不修改调用方数组。

### G5A-10｜同一目标版本可偷换另一套比例

- 模板先通过严格形状与比例约束，再逐类别、逐字段对照当前版本的冻结模板。
- 即使替代比例仍满足 `min <= target <= max` 且合计 100%，只要不等于登记内容就返回 `invalid_target_template`。

### G5A-11｜新增资金金额可超过安全整数范围

- 5A 非负整数入口统一要求 `Number.isSafeInteger`；`Number.MAX_SAFE_INTEGER` 可用，超界值 fail closed。
- 防止金额在进入 5D 分配算法前已经因二进制数值表示丢失精度。

### G5A-12｜未来评估日期被标记为有效

- `assessmentValidity()` 先校验 `assessedAt <= now`；未来评估日统一返回 `invalid_assessment_date`。
- 当天评估与历史评估仍按冻结的 365 天有效期、30 天即将到期口径计算。

## 验证证据

| 门禁 | 结果 |
|---|---|
| 5A 定向 | `node --test tests/domain-phase5a.test.js` → **33/33** |
| 反向验证 | 5A-28/29 与 5A-31/32/33 对应旧实现行为均可复现（符合预期） |
| 全量回归 | 沙箱外 `node --test` → **519/519** |
| 浏览器接线 | 两个全新临时数据目录 → **24/24 × 2** |
| 静态门禁 | `node --check js/app.js js/domain.js sw.js`、`git diff --check` 通过 |
| 数据与接口边界 | schema **v7**；风险评估 API 仍为延后登记 **501**；零迁移、零 API、零页面 |

## 复核中发现的文档漂移

`TEST.md` 的旧 W3 仍写“应用从未注册 Service Worker”，但当前 `js/app.js` 已调用 `navigator.serviceWorker.register('sw.js')`。生产根页面会解析为 `/sw.js`；测试 harness 位于 `/tests/`，会请求 `/tests/sw.js` 并得到 404。该文档已纠正；生产离线接管与升级仍保留为人工发布检查，不影响 5A 领域契约结论。

## 下一步

进入 Phase 5B：按 `PHASE5_BREAKDOWN.md` §5 新增风险评估持久化/API/UI，服务端从原始答案重算派生结果；5B 版本使用 `2.4.7-phase5b`。不要提前实施 5C–5E。
