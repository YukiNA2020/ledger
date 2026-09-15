# Ledger｜个人财务决策台

Ledger 是一个只为单一用户服务的 Mac 本地财务决策工具。它保留原有的小账本、账单导入和消费分析能力，并把产品中心从“记录花了什么”调整为“看清个人资产负债、识别可投资资金、决定下一笔新增资金如何配置”。

## 当前状态

- 已完成：原小账本 `v2.0.0-rc.3`，包含手动记账、多源账单导入、跨源核对、预算和消费体检等能力。
- **v3 Phase 1「资产领域基础」已完成并验收（2026-09-14，`v2.1.0-phase1`）**：资产领域模型与 CNY/HKD/USD 折算聚合（`js/domain.js`）、首页资产决策台（空状态/估算口径/正式口径）、原首页下沉为现金流页、备份 Schema v2（旧 v1 备份仍可恢复）。
- **v3 Phase 2「本地服务与 SQLite」已完成并验收（2026-09-14，`v2.2.1-phase2`）**：只监听 `127.0.0.1` 的本地服务与 `/api/v1`、SQLite 事实源（迁移器 + repository）、本地版本备份与恢复（每日 ≥1 份、保留 30 份、覆盖前强制备份）、macOS 登录启动脚本、Keychain 适配器、前端存储门面 `js/store.js`。补充验收发现的三个阻塞缺陷（SW 旧令牌、保存失败误报成功、恢复前无备份）已修复。
- **v3 Phase 3「账户、负债与月度结账」已完成并验收（2026-09-15，`v2.3.2-phase3`）**：机构—账户—币种子账户、换汇资产转移、负债与保障权益、青岛福利预设、手动汇率、月结快照与历史金额下钻、应急金覆盖均已落地。测试基线 `node --test` 230/230、浏览器 wiring 15/15。
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
- 第一版使用日终行情和免费数据源，缺失价格允许手动覆盖并明确标记。
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
node --test          # 202 项（2026-09-14 基线）

# 浏览器接线验收必须先由本地服务托管，并使用临时数据目录：
node server/main.js --data-dir "$(mktemp -d)" --port 8499 --no-open
# 打开 http://127.0.0.1:8499/tests/app-wiring.html
```

开发要求与门禁见 [AGENTS.md](./AGENTS.md)，测试证据与已修复缺陷见 [TEST.md](./TEST.md)。

## 下一步

Phase 3 已完成。下一位执行 Agent 按 [ROADMAP.md](./ROADMAP.md) 实施 Phase 4「持仓与日终行情」，入口与边界见 [NEXT_AGENT.md](./NEXT_AGENT.md)。开始编码前必须先阅读 [DECISIONS.md](./DECISIONS.md) 与 [ACCEPTANCE.md](./ACCEPTANCE.md)，确认基线测试、改动边界与回滚点；不得把多个 Phase 合并成一次重写。
