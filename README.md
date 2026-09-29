# Ledger｜个人财务决策台

Ledger 是一个只为单一用户服务的 Mac 本地财务决策工具。它保留原有的小账本、账单导入和消费分析能力，并把产品中心从“记录花了什么”调整为“看清个人资产负债、识别可投资资金、决定下一笔新增资金如何配置”。

## 当前状态

- 当前版本 **`2.4.23-ui-polish`**，SQLite **schema v10**。按用户要求，Phase 6 前先完成了**桌面优先、天空蓝背景的前端改版**：宽屏侧栏、资产决策台分区、卡片/表单/弹层统一视觉；业务算法、API、数据结构不变。预览见 [桌面截图](./docs/evidence/desktop-redesign-20260928/dashboard-fixture-desktop.png)（虚构 fixture）。Phase 5 在用户明确排除 G5-R4 的范围内已复验通过；原定完整验收仍缺四问理解的实际计时。**2026-09-28 Phase 6A 完成**：规则与契约冻结在 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md)（D-057）——7 状态 44 有序对状态机（新增终态 `archived`）、buy-only 交易关联、三时点快照、迁移 v11 与备份/回滚方案；零业务代码，版本与 schema 不变，当前阶段为 6B。详见 [Phase 5 全阶段独立验证](./PHASE5_REVIEW.md) §9。
- 已实现风险问卷、目标配置与认可标的维护、确定性新增资金分配、正式建议门禁及本机建议封存。资金来自已有投资现金，转配不增加投资池总额；建议绑定完整计算输入，可离线重算。决策台首页新增只读风险上限摘要：双评分与等级、最终上限及来源、硬封顶、评估/到期日与有效状态；以及只读六类配置对照：当前金额/比例、目标区间、偏离与数据日，缺目标或缺估值时给出原因与目标页入口。目标页建议结果补齐类别排序依据、现金保底/未分配、认可标的与未映射待办、尾差、默认不卖出的具体原因，正式/估算标签与 blocker 直接取 5D 产物。解释性概念收敛为本地知识卡（稳定 id + 解释版本，离线静态文本，不构成建议），页面按已知 id 链接、未知 id 显式降级。建议详情可区分月结基准、计算日输入与解释版本：新建议在 gate 区封存生成时解释版本，旧建议未封存时显式标注「当前卡片解释，非生成时封存版本」，重复生成绝不倒填（D-052）。
- 普通页面保存与 JSON 备份恢复覆盖月结、全部快照、评估、目标、映射和建议。原有记账、账单导入与收益归因回归通过。
- 2026-09-28 补口复验：全量 **648/648**、受影响定向 **87/87**、记账/导入回归 **79/79**、干净浏览器 wiring **34/34 × 3**（18785×2、18786，外部请求 0）且三项审计探针全绿；两条反例脚本当前 `reference-review.cjs` **5/5、exit 0**、`browser-review.py` **pass**（此前应退出 1）。2026-09-27 的 631/631、定向 142/142、独立评分 13,312 组与分配 5,000 组为上一截面。
- 桌面细节优化已获认可；[Phase 6 开发拆解](./PHASE6_BREAKDOWN.md) 已完成，6A 契约已冻结，下一步由其他 agent 执行 **6B「状态机、事件、存储与 API」**。业务代码仍未开始；G5-R4 安排到 6E-3，是 6F 最终验收门禁。见 [工作 Agent 入口](./NEXT_AGENT.md)。
- 保留既有未决项：Phase 4A 的 D-038/T-002 行情源门禁未闭合，自动行情仍关闭；S2.3 的真实 macOS 重启/登录验证、真实月结耗时验收未完成。本轮复核不代表上述历史门禁或整个 MVP 已验收。

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
- [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md)：Phase 6 冻结契约（6A 交付，6B～6F 的唯一规则来源）。
- [PHASE6_BREAKDOWN.md](./PHASE6_BREAKDOWN.md)：Phase 6 顺序任务、验收、R4 延后安排与 agent 指令。
- [PHASE5E_BREAKDOWN.md](./PHASE5E_BREAKDOWN.md)：5E 的六个顺序小任务及逐项退出证据。
- [STATUS.md](./STATUS.md)：旧版开发状态与历史证据；新状态以本 README 和 ROADMAP 为准。
- [TEST.md](./TEST.md)：旧版测试证据与验收入口。
- [PHASE1_5A_REVIEW.md](./PHASE1_5A_REVIEW.md)：2026-09-20 对 Phase 1–5A 的完整状态复核、门禁与剩余阻塞。

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
node --test          # 当前 648 项；需要本机回环端口及 macOS Keychain 测试权限

# 浏览器接线验收必须先由本地服务托管，并使用临时数据目录：
node docs/evidence/phase5d-wiring-server.cjs 8499
# 打开 http://127.0.0.1:8499/tests/app-wiring.html
```

开发要求与门禁见 [AGENTS.md](./AGENTS.md)，测试证据与已修复缺陷见 [TEST.md](./TEST.md)。

## 下一步

下一开发入口是 Phase 6B「状态机、事件、存储与 API」：规则以 [PHASE6_CONTRACT.md](./PHASE6_CONTRACT.md) 为准，任务与可复制指令见 [拆解](./PHASE6_BREAKDOWN.md) §4/§10。G5-R4 在 6E-3 补齐，未通过不得宣告 6F 完整验收通过。
