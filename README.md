# Ledger｜个人财务决策台

Ledger 是一个只为单一用户服务的 Mac 本地财务决策工具。它保留原有的小账本、账单导入和消费分析能力，并把产品中心从“记录花了什么”调整为“看清个人资产负债、识别可投资资金、决定下一笔新增资金如何配置”。

## 当前状态

- 已完成：原小账本 `v2.0.0-rc.3`，包含手动记账、多源账单导入、跨源核对、预算和消费体检等能力。
- **v3 Phase 1「资产领域基础」已完成并验收（2026-09-14，`v2.1.0-phase1`）**：资产领域模型与 CNY/HKD/USD 折算聚合（`js/domain.js`）、首页资产决策台（空状态/估算口径/正式口径）、原首页下沉为现金流页、备份 Schema v2（旧 v1 备份仍可恢复）。
- **v3 Phase 2「本地服务与 SQLite」已完成并验收（2026-09-14，`v2.2.1-phase2`）**：只监听 `127.0.0.1` 的本地服务与 `/api/v1`、SQLite 事实源（迁移器 + repository）、本地版本备份与恢复（每日 ≥1 份、保留 30 份、覆盖前强制备份）、macOS 登录启动脚本、Keychain 适配器、前端存储门面 `js/store.js`。补充验收发现的三个阻塞缺陷（SW 旧令牌、保存失败误报成功、恢复前无备份）已修复。
- **v3 Phase 3「账户、负债与月度结账」已完成并验收（2026-09-15，`v2.3.2-phase3`）**：机构—账户—币种子账户、换汇资产转移、负债与保障权益、青岛福利预设、手动汇率、月结快照与历史金额下钻、应急金覆盖均已落地。测试基线 `node --test` 230/230、浏览器 wiring 15/15。
- **v3 Phase 4A「数据源决策与适配器契约」契约实现完成、正式验收暂不通过（2026-09-16）**：provider adapter 契约、固定时钟、离线 fixture 与数据源证据档均已落地；T-002 仅汇率源已定为 Frankfurter ECB 固定端点，行情端点仍待 4D 开始前通过 D-038 门禁后决定。门禁通过前自动行情关闭、使用手动补价。
- **v3 Phase 4B「标的目录与分类确认」三轮反向检查补口完成，等待独立复核确认（2026-09-16）**：检索、预分类、确认锁定、稳定 id、全路径去重与备份不变量均已落地；第三轮又补齐 4C 前置安全边界：刷新标的采用原位 upsert（不级联删除持仓/事件/报价）、provider 元数据必须绑定请求代码、坏搜索响应显式报错、多市场歧义不受返回顺序影响、`/state` 不能绕过分类词表与 confirmed 完整性。逐条状态见 [PHASE4B_ACCEPTANCE_GAPS.md](./PHASE4B_ACCEPTANCE_GAPS.md)。
- **v3 Phase 4C「持仓账本与证券事件」第三轮独立复核补口完成，等待复核确认（2026-09-18，`v2.3.9-phase4c`）**：在 G4C-1–11 基础上，根 `state` 必须是非数组对象；`assets` 完全缺失仍兼容旧备份，但显式存在时必须是非空对象。API 与仓储双层均在清库前拒绝 `state=[]`、`assets=null/[]/字符串/{}`，原事实保持不变。详见 [PHASE4C_ACCEPTANCE_GAPS.md](./PHASE4C_ACCEPTANCE_GAPS.md)。
- **v3 Phase 4D「日终行情、汇率与失败兜底」第三轮独立复核补口完成，等待复核确认（2026-09-18，`v2.3.10-phase4d`）**：此前请求—结果一一绑定与 `asOf` 边界保持不变；本轮修复全量被手动值锁定时顶层 `reason` 误报 `no_targets`，现在有目标时返回实际原因 `manual_locked`，只有 `requested=0` 才使用 `no_targets`。当前全量 **452/452**、4D 编排层 **27/27**、4D 真实 HTTP **10/10**、浏览器 wiring **21/21**；schema 仍为 **v7**。
- **v3 Phase 4E「估值下钻与收益归因」第二轮复核补口完成，等待独立复核确认（2026-09-19，`2.3.13-phase4e`）**：第一轮 G4E-1 的封存明细口径保持不变；本轮补齐**决策台读取快照时的完整性校验**。`GET /close-snapshots/:id` 现在复算 payload 原文 SHA-256 并返回 `hashValid` / `integrityStatus`；前端只有收到 `hashValid:true` 才使用封存明细，不一致或缺失校验结论时统一进入 `baseline_hash_mismatch`、清空 positions、不给任何归因行或合计。**零新数据源、零迁移**，schema 仍为 **v7**；当前全量 **486/486**、4E 定向 **34/34**、浏览器 wiring **24/24 × 2**。口径见 [DECISIONS.md](./DECISIONS.md) D-045 ①–⑨，复核记录见 `PHASE4E_ACCEPTANCE_GAPS.md`。
- **v3 Phase 5A「风险问卷与配置规则冻结」第 1 轮复核缺口补口完成，等待独立复核确认（2026-09-19，`2.4.1-phase5a`）**：在写数据库、API 和页面之前冻结 T-004 —— 9 道题（承受能力 5 / 承受意愿 4）与分值、等级边界（**下界含入**）、4 条**硬封顶**（只降不升、高意愿不能抵消关键短板）、5 级目标区间模板（Σtarget 精确 100%、**个股 target 恒为 0**）、容忍带（端点含入）、复评词表与 365/30 天有效期（**市场涨跌不触发复评**）、稳定错误码、建议输入输出契约与排序尾差规则。第 1 轮独立复核的 3 条缺口（G5A-1 规则常量可被原地修改 / G5A-2 未知 `targetVersion` 被接受 / G5A-3 模板额外类别未被拒绝）已补口：规则常量**递归冻结**、`targetVersion` 必须是当前可用版本、模板类别与 `RISK_CLASSES` **精确相等**，三条都补了「改回旧实现即红」的反例。规则数据与纯契约函数在 `js/domain.js`，冻结副本在 `tests/fixtures/phase5-risk-rules.json`，测试见 `tests/domain-phase5a.test.js`（22 项）。**零新迁移、零新 API、零新页面**，schema 仍为 **v7**；当前全量 **508/508**、5A 定向 **22/22**、浏览器 wiring **24/24 × 2**。口径见 [DECISIONS.md](./DECISIONS.md) D-046，复核记录见 [PHASE5A_ACCEPTANCE_GAPS.md](./PHASE5A_ACCEPTANCE_GAPS.md)，子阶段拆解见 [PHASE5_BREAKDOWN.md](./PHASE5_BREAKDOWN.md)。
- SQLite 已是唯一事实源；IndexedDB 不再承担 v3 事实源，服务不可达时前端进入只读降级，不做双写。
- 本轮不从零重写：复用 `js/core.js` 中已经验证的解析、统计和账务口径。
- 本仓库中的 v3 文档是交给后续执行 Agent 的唯一实施依据；下一阶段入口见 [NEXT_AGENT.md](./NEXT_AGENT.md)。

## 产品一句话

> 汇总现金流、银行卡、券商持仓、受限资产和负债，形成可信的个人资产负债表；再根据应急金、风险承受能力和目标配置，解释下一笔新增资金应优先补充哪类资产。

## 第一版核心流程

1. Mac 登录后打开产品并更新最近有效收盘价与汇率。
2. 账单导入为主、手动补记为辅，形成可信现金流。
3. 首次录入持仓快照，此后记录买入、卖出、分红和费用。
4. 每月核对账户、负债和受限资产余额，完成资产结账。
5. 根据必要支出估算应急金，区分安全储备、可投资资产和受限资产。
6. 风险问卷生成目标配置区间；规则引擎给出新增资金的补充方向。
7. 用户接受、暂缓或忽略建议，实际交易后完成复盘闭环。

## 关键边界

- 永久单用户、Mac 单机使用，不做注册、多用户或手机同步。
- 私人财务数据只存本机；只联网获取公开行情、汇率和官方制度信息。
- 第一版使用日终行情：汇率用免费无 key 的 Frankfurter（固定 ECB provider 端点）；行情源必须先用证据通过 `DECISIONS.md` D-038 的启用门禁（官方条款/限额/自动化授权/市场覆盖/失败语义）。门禁通过前自动抓取默认关闭，价格以手动补价为准并明确标记。
- 不做个股推荐、行情预测、自动下单或持仓自动抓取。
- 决策由确定性规则产生；本地知识卡负责解释，不把财务数据交给云端 AI。
- 保留原始记账能力，但现金流成为资产决策的数据底座，不再是首页唯一中心。

## 文档导航

- [PRODUCT.md](./PRODUCT.md)：产品问题、用户、流程、需求、规则、边界与验收标准。
- [ARCHITECTURE.md](./ARCHITECTURE.md)：现状、目标架构、数据模型、安全、失败处理和演进门槛。
- [ROADMAP.md](./ROADMAP.md)：增量实施顺序、阶段交付物和退出条件。
- [AGENTS.md](./AGENTS.md)：后续开发必须遵守的项目规则。
- [DECISIONS.md](./DECISIONS.md)：已确认决策、假设、延期项与变更规则。
- [ACCEPTANCE.md](./ACCEPTANCE.md)：跨阶段验收场景、测试数据和发布门禁。
- [NEXT_AGENT.md](./NEXT_AGENT.md)：下一位执行 Agent 的当前任务、边界和可复制指令。
- [STATUS.md](./STATUS.md)：旧版开发状态与历史证据；新状态以本 README 和 ROADMAP 为准。
- [TEST.md](./TEST.md)：旧版测试证据与验收入口。

旧的 `Ledger_Plan.md`、`Ledger_PRD.md`、`Ledger_Implementation_Roadmap.md` 和 `docs/stages/` 保留为 v1/v2 历史档案，不再定义 v3 产品范围。

## 当前运行方式

Phase 2 起由本地服务托管前端与数据，只监听 `127.0.0.1`，SQLite 为唯一事实源：

```bash
cd ledger
node server/main.js        # 或双击 start.command
```

服务启动后会打开 `http://127.0.0.1:8421/`。常用选项：

```bash
node server/main.js --help              # 全部选项
node server/main.js --port 8421         # 改端口（仍只绑定 127.0.0.1）
node server/main.js --data-dir DIR      # 改数据目录（默认 ~/Library/Application Support/Ledger）
node server/main.js --self-check        # 实施前技术门禁自检，不写入财务数据
node server/main.js --no-open           # 不自动打开浏览器
./scripts/install-login-item.sh         # 需要开机自启时（请在终端手动执行）
./scripts/uninstall-login-item.sh       # 卸载登录项
```

数据目录外置于仓库（默认 `~/Library/Application Support/Ledger`），包含 `ledger.db`、`backups/`（保留最近 30 份）、`logs/`、`server.lock` 与 `session-token`（权限 0600）。个人财务数据不会进入 Git 工作区。

若本地服务未运行，页面仍可打开但进入**只读降级**——既有数据可查看和导出，但不会保存新内容，页面顶部会显示横幅说明如何恢复。

> `python3 -m http.server` 的旧静态预览方式已不再适用：离开本地服务就没有可写的事实源，且缺少写接口保护。

## 测试

```bash
cd ledger
node --test          # 504 项（2026-09-19 基线；须在非沙箱下运行，含 macOS Keychain 用例）

# 浏览器接线验收必须先由本地服务托管，并使用临时数据目录：
node server/main.js --data-dir "$(mktemp -d)" --port 8499 --no-open
# 打开 http://127.0.0.1:8499/tests/app-wiring.html
```

开发要求与门禁见 [AGENTS.md](./AGENTS.md)，测试证据与已修复缺陷见 [TEST.md](./TEST.md)。

## 下一步

Phase 5A 已把风险问卷的规则与领域契约冻结（D-046），当前全量 **508/508**、5A 定向 **22/22**、浏览器 wiring **24/24 × 2**，schema 停在 **v7**。**下一步不是 5B，而是对第 1 轮独立复核三条缺口（G5A-1/2/3）的补口做独立复核**（自己重跑最小复现 + 反向验证「把实现改回旧版即变红」），结论写入 [PHASE5A_ACCEPTANCE_GAPS.md](./PHASE5A_ACCEPTANCE_GAPS.md)；复核通过后再进入 **5B：把冻结的规则做成可填写、可保存、可追溯、可到期的风险评估**（双评分领域函数、`risk_assessments` 持久化与迁移、`POST /api/v1/risk-assessments`、问卷 UI），入口与禁区见 [NEXT_AGENT.md](./NEXT_AGENT.md)。Phase 4E 的独立复核结论以 [PHASE4E_ACCEPTANCE_GAPS.md](./PHASE4E_ACCEPTANCE_GAPS.md) 为准；Phase 4A 的正式验收仍为待定，行情自动抓取继续保持关闭。
