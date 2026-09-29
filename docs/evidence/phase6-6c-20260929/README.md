# Phase 6C 决策与待执行 · 2026-09-29

当前版本 `2.4.25-phase6c-fix2` / schema v11（零迁移）。fix1 修复详情 A 的晚到响应覆盖详情 B；fix2 补上关闭详情后旧响应覆盖其他弹层的路径。全部使用隔离临时库、虚构资产与默认分类；未读取或改写个人账本，自动测试零真实网络。

## 结果

- 全量 `node --test` **679/679**（6B 基线 677 + 6C 新增 2 项 `store-headers` 决策封装契约）。
- 浏览器接线（`tests/app-wiring.html`，第 35 项为 6C 决策页检查、第 36 项为详情弹层慢响应检查）**36 项 × 2 轮全绿**（fix2 最终构建）：
  - `wiring-run-19041.json`：`run_wiring_6c.py` 独立临时库，36/36；第 36 项同时覆盖详情 A/B 与关闭详情后切换账户弹层。
  - `browser-19047.json`（位于 `docs/evidence/phase5-review-20260927/`）：`browser-review.py` 独立临时库，36/36；撤销映射 / 行情过期 / 断网知识卡三项审计探针全绿，`externalRequests=[]`、`pageErrors=[]`、`auditPassed=true`。
- 三档宽度与状态检查 **64 项**（见 `width-result.json`，fix2 构建复跑于 19043）：
  - 18 条路由 × 1440 / 1100 / 390px = 54 项（无装饰表情、无横向溢出；`decisions` 为本阶段新增路由）；
  - 决定弹层、详情弹层各 3 档 = 6 项（弹层内不横向溢出、不裁切，存图 `decide-sheet-*.png`、`detail-sheet-*.png`）；
  - 状态 4 项：读取中（`decisions-loading-1440.png`）、读取失败（`decisions-error-1440.png`）、重试后恢复空态、接受成功。
- `node --check` 与 `git diff --check` 通过。

## 缺陷与修复（用户报出，本轮补上）

- **缺陷**：详情弹层 `openDecisionDetail` 没有顺序守卫 —— 先开 A、再开 B 时，A 的慢响应最后返回会把弹层内容覆盖回 A；弹层已关闭时晚到的详情还会把弹层重新弹出。属于 `PHASE6_BREAKDOWN.md` §5 明确要求的「慢响应不能覆盖新状态」，此前只覆盖了清单读取（`decRequest`）与提交（`decSubmitSeq`），详情读取漏了。
- **修法**：`js/app.js` 新增 `state.decDetailSeq` 单调序号，`openDecisionDetail` 发请求时取号，响应返回时序号不一致即丢弃；loading / error body 与详情根节点补 `data-dec-detail-id`，便于断言当前展示的是哪一条。原有「弹层已隐藏则丢弃」的判断保留，覆盖关闭后晚到的场景。
- **验证**：新增 wiring 第 36 项 `6C 决策：详情弹层慢响应不覆盖后打开的另一条，关闭后晚到不重弹`（扣住 A 的真实响应 → 打开 A → 打开 B → 释放 A → 断言仍是 B；再开 A 后中途关闭 → 释放 → 断言不重弹），36 项 × 3 轮复跑全绿，全量 `node --test` 与宽度检查重跑通过。

## fix2 补充复测

- 关闭 A 详情后立刻打开「新增账户」弹层，A 的晚到响应仍会覆盖当前弹层。`closeSheet()` 现递增 `decDetailSeq`，第 36 项 wiring 同时验证跨弹层切换；最终构建的 Node 679/679、浏览器 36/36 × 2、布局与状态 64/64 均通过。
- `browser-review.py` 的旧映射审计在目标页异步重绘时，Playwright 等被替换的按钮稳定会超时；改为在当前 DOM 上触发同一委托点击，并以页面截图留证。19047 轮三项审计探针全绿。

## 复跑

```bash
# 浏览器接线（自起隔离服务与临时库，SIGTERM 自清理）
python3 docs/evidence/phase6-6c-20260929/run_wiring_6c.py 18996

# 三档宽度与状态检查（同样自起隔离服务）
python3 docs/evidence/phase6-6c-20260929/run_width_6c.py 18997

# 全量 Node 测试
node --test

# 审计探针（会另起一个临时库，输出 browser-<port>.json）
python3 docs/evidence/phase5-review-20260927/browser-review.py 18998
```

每轮都必须使用全新数据库与浏览器 profile；`browser-review.py` / `check.py` 这类旧脚本复用数据库时会受 fixture 残留影响。

## 调试轮（保留，不伪装成全部成功）

- `wiring-run-18931.json` ～ `18939.json`、`18943.json`：**失败轮**，用于复现与定位，最终结果为 fail，保留原样。主要问题与修法：
  1. `tplDecisions` 中 `decError` 分支排在 `!decLoaded` 之后不可达 → 调整为「服务不可达 → 读取失败 → 读取中 → 清单」，失败不再落回空态；
  2. wiring 步骤 ② 假设首帧必定读取中，但前面的检查已访问过目标页、`decLoaded` 为 true，导致读取请求根本不会发出 → 改为按需点击「重新读取」强制读取，并为重新读取补 `data-dec-reloading` 提示；
  3. `Store.listDecisions()` 经 `detect()` promise 链调用 `fetch`，断言必须放在微任务之后（`waitFor`），同步断言会失败；
  4. 模拟读取失败必须返回 HTTP 500，网络层 reject 会触发 `markUnreachable()` 降级本地模式，测到的是另一个分支。
- `wiring-run-18941.json`、`18942.json`：35/35，但早于「重新读取提示」与上述分支修正，不能作为最终证据。
- `wiring-run-18944.json`、`18945.json`、`wiring-run-19021.json`、`browser-18960.json`：**详情缺陷修复前的 35 项轮**，当时不含第 36 项，已被 18975/18976/18978 取代。
- `wiring-run-18971.json`、`18972.json`：35/35 通过，但详情慢响应断言内嵌在第 35 项里、报告上看不见覆盖情况，随后拆成独立的第 36 项；`18975`、`18976`、`browser-18978.json` 与宽度 `18977` 为拆分后、**版本号递增前**的 36 项通过轮。18991 / 18992 / 18993 / 18994 属于 fix1 构建，当前 fix2 证据见上方结果。
- `browser-19042.json`、`browser-19044.json`、`browser-19046.json`：三次补充审计的未完成轮；前两轮等待重绘中的旧映射按钮稳定而超时，第三轮已完成映射探针、截图时遇到节点被替换。探针改为当前 DOM 点击与整页截图后，19047 完整通过。未完成轮不计入通过次数。
- `wiring-run-18973.json`、`18974.json`：**失败轮**，第 36 项断言写错 —— 取「第一条 deferred」却硬编码了另一条暂缓记录的文案（`本月资金另有用途`），实际取到的是失效建议那条暂缓 → 改为断言 `itemB.note` 本身并加「A 与 B 必须是两条不同决策」前置。失败保留，不伪装。
- `width_check.py` 前三次（18951、18952、18954）为脚本自身问题（提交按钮意图值写成 `accept`、`wait_for_selector` 等待已隐藏元素、route 处理器写法），修复后 18953、18955 两轮通过；fix1 截图为 18994，当前 fix2 截图与 `width-result.json` 复跑于 19043。

## 说明

- `browser-review.py` 的数量断言已按 `PHASE6_BREAKDOWN.md` §9 由 34 同步为 36（拆分前先到 35，再因新增第 36 项到 36）：原 34 项语义与断言全部保留，只新增 6C 两项检查的计数，未删除任何旧断言。
- 本阶段只改前端与 `js/store.js` 封装；服务端状态机、API 与 6A 契约口径零改动，schema 仍 v11。
