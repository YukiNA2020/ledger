# 下一位执行 Agent 入口

## 当前事实

- v3 Phase 1–3 已完成并验收；Phase 4B 三轮补口完成。Phase 4A 正式验收仍暂不通过，行情自动抓取因 D-038 门禁未通过继续默认关闭。
- Phase 4C/4D 第三轮独立复核提出的缺口已于 **2026-09-18** 修复，当前措辞是“补口完成，等待独立复核确认”，不是“已通过”。在确认前**不得进入 4E**。
- 4C 新增边界：根 `state` 必须是非数组对象；`assets` 完全缺失可兼容旧备份，显式存在时必须为非空对象；任一资产集合显式存在时仍必须是数组。所有错误均在事务和清库前拒绝。
- 4D 新增边界：provider 输出继续与请求键一一对应；顶层跳过原因必须反映实际结果。有目标且被手动值锁定时返回 `manual_locked`，只有 `requested=0` 才使用 `no_targets`。
- 测试基线：`node --test` **452/452**（须在非沙箱、真实用户身份下运行，包含 Keychain）；`tests/providers-marketdata.test.js` **27/27**；`tests/server-phase4c.test.js` + `tests/server-phase4d.test.js` **30/30**；仓储/备份/编排定向 **65/65**；浏览器 wiring **21/21**。数据库 schema 仍为 **v7**，本轮未新增迁移、未改 UI、零真实网络请求。
- 详细证据见 `TEST.md` 的“Phase 4C/4D 第三轮独立复核补口证据”、`ACCEPTANCE.md` S4C.1/S4D.2，以及 `PHASE4C_ACCEPTANCE_GAPS.md` G4C-12/G4D-1。

## 你的任务

**只做 Phase 4C/4D 本轮补口的独立复核，不实施 Phase 4E。**

1. 按 `AGENTS.md` 规定顺序完整阅读项目文档，先检查 git 状态和本轮 diff。
2. 复现并核对 4C 根状态反例：raw/wrapped `state=[]` 必须 400 `invalid_state`；`assets=null/[]/字符串/{}` 必须 400 `invalid_assets`；每次拒绝后完整状态不变；只有 `assets` 字段完全缺失可按旧备份兼容。
3. 复现并核对 4D 手动锁原因：存在目标且报价/汇率被 `manual_locked` 时，元素与顶层原因都必须为 `manual_locked`；`no_targets` 必须同时满足 `requested=0`。
4. 运行 452 项全量回归、4C/4D 定向和 21 项浏览器 wiring；自动测试不得访问真实行情网络。
5. 若仍发现问题，只修复 4C/4D 并补真实反例；若全部通过，只更新复核结论和证据，再把 `NEXT_AGENT.md` 切换为 Phase 4E 入口。

## 禁止事项

- 未给出独立复核通过结论前，不进入 4E，不实现估值下钻或收益归因。
- 不改变 D-042/D-043 的持仓与事件口径，不改变 D-044 的行情/汇率口径，不开启自动行情抓取。
- 不删除既有测试换取绿色结果，不覆盖无关的用户修改；本地服务只绑定 `127.0.0.1`。
- 不接付费数据源，不让 API Key、账户名、余额、数量或成本进入 provider 请求、响应或日志。

## 可直接复制给复核 Agent 的任务描述

> 阅读 `AGENTS.md` 指定的全部项目文档。只独立复核 Phase 4C/4D 在 2026-09-18 的第三轮补口，不实施 Phase 4E。重点复现：① raw/wrapped `state=[]` 必须 400 `invalid_state`；显式 `assets=null/[]/字符串/{}` 必须 400 `invalid_assets`，每次拒绝后完整状态保持不变；只有 `assets` 字段完全缺失可兼容旧备份；② 有刷新目标但自动结果被手动值锁定时，元素与顶层 `reason` 均为 `manual_locked`，`no_targets` 只允许在 `requested=0` 时出现。运行全量 452 项、4C/4D 定向与浏览器 wiring 21 项；自动测试零真实网络。若有新缺口只修复 4C/4D；全部通过后再更新结论并切换 4E 入口。
