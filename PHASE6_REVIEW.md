# Phase 6 完整复验（2026-09-30）

结论：**本轮发现的 5 个缺陷已修复，Phase 6 复验通过**。当前版本 `2.4.27-phase6-review` / schema v11，零迁移；下一入口保持 Phase 7 两个月真实使用验证。

## 实测结果

| 检查 | 结果 | 本轮证据 |
|---|---|---|
| 修改前全量回归 | 696/696，无跳过 | `full-test-baseline.txt` |
| 新增反例首次运行 | 6 项中 5 项失败，1 项通过 | `counterexamples-before.txt` |
| 修复后 Phase 6 定向 | 53/53，无跳过 | `targeted-after.txt` |
| 最终全量回归 | **704/704**，失败/取消/跳过均为 0 | `full-test-after.txt` |
| 完整浏览器接线 | **38 项 × 2 轮**，全新库、不同 origin、干净 profile | `wiring-run-19421.json`、`wiring-run-19422.json` |
| 浏览器审计 | 38 项 + 映射撤销/行情过期/离线知识入口探针均通过；外部请求 0、页面异常 0 | `browser-19424.json` |
| 布局与状态 | **71 项**：1440/1100/390px，18 路由、4 类弹层、5 个状态 | `width-result.json`（19425） |
| 复盘对照视觉核对 | 三档滚动至实际六类对照表，额外检查表内溢出；人工审看桌面与窄屏截图 | `comparison-1440.png`、`comparison-1100.png`、`comparison-390.png` |
| 静态检查 | `node --check`、`git diff --check` | `static-checks.txt` |

证据和独立复跑脚本均在 [docs/evidence/phase6-review-20260930/](./docs/evidence/phase6-review-20260930/)。基线 commit 见该目录 `baseline-commit.txt`。原有两项未跟踪文件（6C 的 `__pycache__/`、`debug-accept.cjs`）保留。

## 发现与修复

| 编号 | 级别 | 修复前可复现的问题 | 修复与回归 |
|---|---|---|---|
| R1 | P1 | 改动快照金额而不更新哈希：详情返回 400，但关联端点仍返回 201，解绑同样缺完整性校验 | 关联/解绑复用仓储完整性复核，校验原文字节、两种哈希、建议及活动关联引用。`6R-03` 证明两个端点拒绝后关联行和幂等记录不变 |
| R2 | P2 | 用建议之外的标的买入相同本金，空说明仍能确认执行 | 新增纯函数 `decisionExecutionNeedsNote`，以封存建议中的标的判定差异；缺说明返回既有码 `deviation_note_required`。`6R-04` 验证空说明失败、写明说明后成功，金额理由码仍按契约定义 |
| R3 | P2 | 多笔本金/费用单笔合法，累加超出安全整数仍返回失真数字 | 用 BigInt 聚合、输出前检查安全整数，溢出拒绝；存在缺汇率仍三个金额全 null。`6R-05/06` 覆盖本金、费用、边界值和缺汇率优先语义 |
| R4 | P1 | `available:true` 快照允许 `classes:null`，进入对照函数可能 TypeError；金额字段也允许 null | 可比快照必须具备金额和完整六类配置；`6R-01` 验证三种缺失均返回稳定错误 |
| R5 | P1 | 缺汇率快照只要任一汇总为 null 就通过，另外两个可以保留部分小计 | 改为三个汇总必须全部 null；`6R-02` 遍历 8 种 null 组合，仅全 null 合法 |

5 个缺陷均有修复前失败证据及修复后成功证据，旧用例和断言未删除。`6R-07/08` 额外补齐原证据不足的两类测试：12 请求并发创建/执行同键只写一次，跨决策争抢同一买入只有一个赢家；SQLite trigger 在事件 INSERT 中途故障，证明已更新的状态和幂等键一同回滚，解除故障后同键可成功重试。

契约先补充换标的说明和安全整数溢出的实现口径，再修业务代码；状态机、金额差额理由码、资产估值和配置分配算法不变。`executed_as_planned` 只表示金额一致，换标的说明单独保留在 note 中。

## 验收覆盖

| 范围 | 实测覆盖 |
|---|---|
| 6A / S6.1 | 冻结词表、白名单；7×7 共 49 有序对（合法 6 / 非法 43）；非法动作整体回滚 |
| 6B | formal/estimate、未知引用、失效门禁、一步/两步创建、自然键及请求键幂等、读取复核、普通五键保存、v10→v11 迁移、索引完整性、新旧 JSON/SQLite 备份与失败恢复 |
| 6C | 接受/暂缓/忽略、理由必填、待执行只含 accepted；初始空态、加载/读取失败/重试、重复点击、慢响应与详情关闭守卫 |
| 6D / S6.2 | buy-only、分批、少买/超买、交易日汇率、单事件单决策、解绑留痕、纠错窗口、无交易归档；不重复写证券事件、txns 或现金余额 |
| 6E / S6.3 | 三时点封存、恒六类对照、缺数据不可比、0 投资池、历史目标、reviewed 只读；跨月状态事件归属、回填交易日与操作时间、恢复后对照一致 |
| 6F | 两套完整闭环 A/B、负向电池、原记账/导入/去重/月结/建议回归、G5-R1～R3 探针；新增并发与事务中途失败注入 |
| G5-R4 | 核对既有真人证据：变体 C 4/4、本人补报计时 35 秒。**本轮未重新执行真人测试**，不以浏览器自动化代替 |

## 复跑与边界

```bash
node --test
node --test tests/domain-phase6.test.js tests/server-phase6.test.js tests/decision-summary.test.js
python3 docs/evidence/phase6-review-20260930/run_wiring_6f.py 19421
python3 docs/evidence/phase6-review-20260930/run_wiring_6f.py 19422
python3 docs/evidence/phase6-review-20260930/browser-review.py 19424
python3 docs/evidence/phase6-review-20260930/run_width_6f.py 19425
```

浏览器脚本使用现有 Python Playwright，自动启动并清理自己的临时服务/数据库。首次受限沙箱运行因禁止本机监听而失败；放行本机测试后基线 696/696，环境错误未作为业务缺陷计算。全部自动化使用隔离虚构数据和离线 provider；未读取、清空、迁移或恢复私人账本，未开启真实行情或外部数据上传。

修改文件：`js/domain.js`、`server/decisions.js`、`js/app.js`（版本）、`sw.js`（缓存）、三个测试文件，以及契约、报告、状态和变更记录。无数据库迁移，无新依赖；回滚仅需撤回本轮代码/文档/缓存版本修改，保留当前 v11 数据库。尚未关闭的独立事项：4A 行情源门禁、S2.3 实机启动、Phase 7 两个月真实使用与维护耗时。
