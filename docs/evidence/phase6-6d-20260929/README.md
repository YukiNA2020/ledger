# Phase 6D 证据｜关联实际交易并记录执行（2026-09-29）

版本 `2.4.25-phase6d` / schema **v11**（**零迁移**）。全部在隔离临时库 + 干净 Chromium profile 上跑，脚本自起自停 `docs/evidence/phase5d-wiring-server.cjs`，不接触私人账本、零外部请求。

## 结论

| 项 | 结果 |
|---|---|
| `node --test` | **686/686**（6C 基线 679 + 6D 新增 7：服务端 6D-01～6D-05 共 5、领域 6D-11/6D-12 共 2） |
| 浏览器 wiring | **37 项 × 3 轮全绿**：`wiring-run-19102.json`、`wiring-run-19103.json`、`wiring-run-19104.json` |
| `browser-review.py` | **37 项 pass**：`../phase5-review-20260927/browser-19121.json`（`externalRequests=[]`、`pageErrors=[]`，撤销映射 / 行情过期 / 断网知识卡三项审计探针通过） |
| 三档宽度与状态 | **63 项页面 + 5 项状态 = 68 项**：`width-result.json`、`width-*.png` |
| `node --check` / `git diff --check` | 通过 |
| `browser-review.py` 数量契约 | 36 → **37**（原 34 项语义与断言全部保留，仅新增 6D 一项） |

## 保留的失败轮（不伪装）

`wiring-run-19101.json`：**第 37 项失败**，其余 36 项通过。原因不是产品缺陷，而是前一项（6C 第 35 项）把历史筛选器停在「已暂缓」后，测试用**已被 `render()` 替换掉的旧节点**去复位，事件没冒泡到 `document`，`state.decStateFilter` 一直是 `deferred`；执行完成后的卡片被筛掉，等待超时。修法是在第 37 项进入决策页时用当前 DOM 里的 `[data-change="dec:filter"]` 显式复位到「全部」，再等卡片——**没有删除或削弱任何断言**，随后 19102/19103/19104 三轮全绿。

## 复跑

```bash
python3 docs/evidence/phase6-6d-20260929/run_wiring_6d.py <端口>   # wiring 37 项（写 wiring-run-<port>.json）
python3 docs/evidence/phase6-6d-20260929/run_width_6d.py  <端口>   # 三档宽度 + 状态（写 width-result.json 与截图）
python3 docs/evidence/phase5-review-20260927/browser-review.py <端口>  # 37 项 + 三项审计探针
node --test
```

## 第 37 项覆盖的行为

从服务端 `/security-events` 关联既有买入 → 归档被 `has_linked_events` 拒绝（状态仍 `accepted`）→ 空理由解绑被挡 → 填理由解绑（软删除 1 行、事件数 / 状态 / `c6-u-cny` 余额不变）→ 重新关联（换新 link id、历史行保留）→ 填 note 确认执行（chip `executed` + 执行时点快照 + ≥2 条 `data-tl=link` 时间线）→ executed 后仍可解绑但不再显示执行 / 归档按钮；「新增买入并关联」复用原证券事件录入弹层；关联 / 解绑 / 执行全走服务端，失败不假成功。

## 截图

- `detail-links-1440/1100/390.png`：关联实际交易后的详情弹层（活动关联行 + 解绑理由输入）。
- `detail-sheet-*.png`：尚未关联时的详情弹层（空态 + 候选选择器）。
- `decide-sheet-*.png`、`decisions-*.png`：6C 沿用的决定弹层与决策页三档。
- `decisions-loading-1440.png` / `decisions-error-1440.png`：读取中、读取失败两态。
