# 下一位执行 Agent 入口

## 当前状态：Phase 6 已全部通过并关闭（2026-09-30）

**Phase 6（6A～6F）整体通过**：6A 契约冻结（D-057）、6B 状态机与存储 API、6C 决定与待执行页面、6D 实际交易关联与执行确认、6E 复盘对照与月度历史（含 **G5-R4 真人计时通过**：变体 C 数据 4/4 全对、自报连续计时 35 秒 ≤60 秒，记录 [docs/evidence/phase6/6e-r4.md](./docs/evidence/phase6/6e-r4.md)）、6F 最终集成验收（全量 `node --test` **696/696**；场景 A/B 两套闭环 + 负向电池 6F-01～04；wiring **38 项 × 2 轮**全新临时库不同 origin（19311、19312）；`browser-review.py` **38 项**（19313，外部请求 0、pageErrors 0）；三档宽度 **71 项**（19314））。证据：`docs/evidence/phase6-6f-20260930/`；结论对照：[PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md) §8 退出清单与 [TEST.md](./TEST.md)。

**Phase 5 完整验收同日关闭**：G5-R4 补齐后按 `PHASE5_REVIEW.md` §10 自己的规则以 §11 追加记录关闭，§9/§10 历史未改写。

## 下一入口：Phase 7「两个月真实使用验证」（用户主导）

- 由用户在真实账本上连续使用两个月验证拆解 §9 / MVP 口径（月结 ≤15 分钟、周维护 ≤20 分钟、一分钟四问、金额可追溯无重复计入、至少两次完整决策闭环）。
- 这不是开发子阶段：**没有 agent 待实施的交付物**。在此期间 agent 只承接缺陷修复或用户明确要求的改动。
- 独立事项不随 Phase 6 关闭：4A 行情源门禁、S2.3 实机启动验证。

## 维护期守则（Phase 7 期间适用）

- 基线不回退：全量 `node --test` ≥ **696**、浏览器 wiring ≥ **38** 项（数量契约在 `docs/evidence/phase5-review-20260927/browser-review.py`）、三档宽度 71 项；改动后按实测更新，禁止删断言换绿色。
- 规则来源：Phase 6 契约 `PHASE6_CONTRACT.md`（D-057，含 6D / 6E 补充）仍然生效；发现分歧先改契约再改代码。
- 隔离纪律不变：自动测试只用临时库与固定 fixture，零真实网络，不读取私人账本；先看 `git status`，保留用户未提交修改。
- 涉及前端静态文件时同步 `sw.js` 缓存版本；迁移前必须有可恢复备份。
- 证据目录：`docs/evidence/phase6-6d-20260929/`、`phase6-6e-20260930/`、`phase6-6f-20260930/`、`docs/evidence/phase6/6e-r4.md`；历史阶段证据见 `PHASE5_REVIEW.md`。
