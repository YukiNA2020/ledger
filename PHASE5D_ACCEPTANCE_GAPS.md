# Phase 5D 修复与验收记录

日期：2026-09-23。版本：`2.4.11-phase5d`，SQLite schema v10。对应 [原始独立审计](./PHASE0_5D_REVIEW.md) 的 R-01～R-06。

**结论：5D 缺陷修正与复验通过，停在进入 5E 之前；5E 尚未实施。** 本轮没有使用真实账本，没有接入新行情源，没有实现 Phase 6 状态机。工作树原有 5B～5D 修改保留，没有代用户提交或发布。

## 缺陷闭合

| 原缺陷 | 修正 | 验证 |
|---|---|---|
| R-01 普通保存删除月结与快照，JSON 备份缺引用历史 | Core / Store 伴随集合增加 monthlyCloses / closeSnapshots；仓储在同一事务保留缺键历史；导入验证原文哈希与引用、失败回滚 | server-phase5d 的 R-01 用例验证五键保存、JSON 清空恢复、坏哈希与缺引用；wiring 验证普通保存后快照原文相同、建议 invalidCount=0 |
| R-02 已在投资池内的现金重复计入分母 | 池总额保持不变，只从现金扣除实际转配；留现金类别下限，cash 不自买，余量继续留存 | 新增两项领域反例；原万元反例现在池总额仍 10,000 元，分配 6,000 元，现金/固收/宽基/主题为 20%/30%/40%/10%，宽基低于 50% 上限 |
| R-03 仅绑定旧月结，不能重放当日建议 | gate.capture 封存完整计算输入；独立纯编排模块离线重放，读取结果逐字段核对 | 实际余额变化后产生新输入；原建议仍按原 capture 重放；修改结果并重算 payloadHash 仍被拒绝 |
| R-04 跨秒或换 key 的相同请求 409 | 内容身份不含新创建时间；相同输入返回原 id、createdAt、payloadHash | 跨两小时时钟、无 key/新 key 重放；原审计跨一秒反例从 409 变 200 |
| R-05 映射/事实变化未进入 inputHash | inputHash 覆盖完整 capture，记录集合规范化；position 决定认可顺序 | 映射换位、余额变化生成新 id；数据库返回行序逆转仍同结果；旧建议保持 |
| R-06 浏览器第五道能力题越界 | 以明确分值构造完整 L3 九题答案；修复前置缓存同步与路由等待 | 完整 27 项全部运行；CNY 2,000 全部优先补宽基、只落认可标的，伪造映射拒绝、哈希异常只给估算 |

归因用例还补上等待新月结列表加载的条件。保存历史修复后，不再依赖旧的清库副作用。Phase 6 范围断言检查可操作按钮而非普通说明文字。测试失败会附虚构测试页面状态，便于定位失败点；没有跳过、过滤或删除旧测试。

## 本轮实测证据

- `node --test`：**619/619，0 failed / skipped**，包含 5D **43/43**（领域 27 + 服务端 16）。完整日志：[phase5d-fix-regression.txt](./docs/evidence/phase5d-fix-regression.txt)。
- 浏览器完整 `tests/app-wiring.html`：**27/27 × 2**，两个独立临时数据库和 loopback origin（18551 / 18552）。第二个数据库从全新状态一次通过；第一处用于定位失败后复跑。记录：[phase5d-fixed-wiring.txt](./docs/evidence/phase5d-fixed-wiring.txt)。
- 领域与真实 HTTP 覆盖 S5.3 五类失败（行情过期、分类未确认、月结非正式、快照哈希异常、评估过期），全部 formalRecommendation=null。浏览器覆盖正式页面生成、金额逐项核对、伪造映射/错误哈希的真实 HTTP 反例、历史保存与归因切换。
- 原审计脚本不改断言场景复跑：[资金反例修复结果](./docs/evidence/phase5d-fixed-money.txt)、[HTTP 反例修复结果](./docs/evidence/phase5d-fixed-probes.txt)。原失败日志保持原样。
- 静态语法与 `git diff --check` 通过。自动验证使用虚构数据、固定服务端测试时钟和 provider fixture；浏览器服务也注入离线 FX fixture，没有调用真实行情源。

复跑：仓库根运行 `node --test`；运行 `node docs/evidence/phase5d-review-money.cjs` 与 `node docs/evidence/phase5d-review-probes.cjs`。浏览器用 `node docs/evidence/phase5d-wiring-server.cjs 18553` 启动临时服务，打开 `http://127.0.0.1:18553/tests/app-wiring.html`；SIGTERM 关闭后删除的仅是该服务创建的临时目录。不要用真实账本运行 wiring。

## 口径与兼容边界

D-049 定义本轮完整口径。月结基准与当日计算输入分开保存：原审计的“结账后余额改变”现在仍可生成正式建议，但新余额已在 capture 中封存，不能只用旧月结哈希解释它。SHA-256 用于一致性和复算检查，不是抵御可同时重写整个数据库的攻击者的签名。

旧 2.4.10 建议没有完整 capture，读取视图计入 invalidCount、保留原文，不冒充已验证历史。旧 JSON 缺少月结/快照仍按空历史恢复；此前已被旧代码删掉的数据无法凭空补回，应从已有完整 SQLite 备份恢复。普通保存遇到损坏历史会拒绝并回滚，不静默“修好”原文。

schema 沿用 v10，无新增第三方依赖或本轮迁移。规则版本与目标模板版本保持 5A 冻结值，算法版本另记 `cash-reallocation-v1`。

## 保留事项与回滚

- 4A 的 D-038/T-002 行情源门禁仍未闭合，自动行情保持关闭；S2.3 真实重启/登录和 Phase 7 的真实月结耗时尚未验证。不得据本轮宣称“此前全部阶段完整验收”。
- 5E 本地知识卡、解释整合与 Phase 5 整体验收未开始；Phase 6 接受/暂缓/执行/复盘未实现。
- 本轮没有运行回滚操作。需要部署回滚时先创建当前完整 SQLite 备份，再使用修复前的对应代码与对应数据库副本在隔离目录验证；不要删表、覆盖真实数据或将新建议交给旧算法解释。因工作树包含先前未提交修改，不能把 `git reset` 当作本轮回滚方案。

下一入口：[NEXT_AGENT.md](./NEXT_AGENT.md)。
