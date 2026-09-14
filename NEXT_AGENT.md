# 下一位执行 Agent 入口

## 当前事实

- 2026-09-14 起，代码为 `v2.1.0-phase1`：v3 **Phase 1「资产领域基础」已完成并验收**（S1.1–S1.4 全部通过，证据见 `TEST.md` 与 `ROADMAP.md`）。
- 已有 v3 能力：`js/domain.js` 领域模型与聚合、`home` 资产决策台（空状态/估算口径/正式口径）、`cashflow` 现金流页（原首页）、备份 Schema v2（v1 仍可读）、IndexedDB `assets` 键。
- 尚无任何 Phase 2+ 能力：没有本地服务、SQLite、行情 provider、风险问卷或决策状态机。
- 测试基线：`node --test` **133 项通过、0 项失败**（2026-09-14）；浏览器 wiring 5/5。
- 浏览器测试档案中的账本数据均为虚构测试数据；**Phase 2 开始前必须再次向用户确认本机（用户日常浏览器）没有需要迁移的真实 IndexedDB 数据**（D-022）。

## 你的任务

只实施 Phase 2「本地服务与 SQLite」，不要顺带实现持仓行情、风险问卷或建议功能。

开始前按 `AGENTS.md` 的顺序完整阅读全部 v3 文档，然后：

1. 先做 ARCHITECTURE §13 要求的只读技术验证（SQLite 驱动、loopback 绑定、单实例锁、Keychain 读取、登录启动项安装/卸载），再定运行时（T-001）；
2. 检查 git 状态与未提交修改，运行并记录 133 项基线测试；
3. 给出 Phase 2 的文件级计划和回滚边界；
4. 建立 `/api/v1`、SQLite repository 与迁移器，前端读写逐步切换，保持 `js/domain.js` 领域逻辑不变；
5. 实现本地备份（每日 ≥1 份、保留 30 份）与恢复演练；
6. 配置 macOS 登录启动并验证重启后自动打开；
7. 完成 `ACCEPTANCE.md` 的 S2.1–S2.4；逐条满足后才能更新 ROADMAP 状态。

## 禁止事项

- 不删除或重写已通过测试的 `core.js`/`domain.js` 纯逻辑与现有测试。
- 不把 IndexedDB 与 SQLite 做成长期双向写入；切换必须按 ARCHITECTURE §9 的迁移顺序。
- 本地服务只绑定 `127.0.0.1`；不为调试改绑 `0.0.0.0`。
- 不在自动测试中访问真实行情网络；不引入付费数据源。
- API Key 不入库、不进前端、不进测试 fixture。
- 不覆盖用户已有未提交修改，不删除旧测试换取绿色结果。

## 可直接复制给执行 Agent 的任务描述

> 阅读项目根目录的 README.md、PRODUCT.md、ARCHITECTURE.md、ROADMAP.md、DECISIONS.md、ACCEPTANCE.md、AGENTS.md 和 NEXT_AGENT.md。只实施 ROADMAP Phase 2，不跨阶段。先完成 ARCHITECTURE §13 的只读技术验证并确定运行时，再检查 git 状态、运行 133 项基线测试。按 ACCEPTANCE S2.1–S2.4 先写行为测试，再实现本地服务、SQLite 与前端切换；保持领域逻辑与旧记账能力不变。完成后报告改动、测试证据、未完成项、风险和回滚方式。
