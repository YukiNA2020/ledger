# Phase 5C 实现与自复核记录（目标配置与认可标的映射）

> 2026-09-23 复验补记：5C 既有缺口及页面流程在本轮全量 619/619、浏览器 27/27 × 2 中回归通过；5D 的保存修复扩展覆盖月结/快照。当前下一阶段为 5E，未开始。以下保留 5C 当时台账；当前口径与回滚边界以 PHASE5D_ACCEPTANCE_GAPS.md 和 NEXT_AGENT.md 为准。

> 版本：`2.4.9-phase5c`（2026-09-21）  
> 状态：**独立复核缺口 G5C-7～9 已修复，等待复验**（按 `AGENTS.md` 测试门禁，独立复核确认前不写「已通过验收」）。  
> 范围：只做 `PHASE5_BREAKDOWN.md` §6（5C）。不接收新增资金金额、不计算买入金额、不生成 recommendation、不实现 5D/5E 或 Phase 6 状态机。

## 1. 本轮交付的口径

1. **目标版本由服务端派生，客户端只提交可选生效日**：`POST /api/v1/targets` 的载荷白名单只有 `effectiveFrom`（缺省 = 服务端判定日）。等级与 `minBps/targetBps/maxBps` 全部来自「当前有效评估的 `ceiling` + 5A 冻结模板」（`Domain.computeAllocationTarget`），出现 `level` / `classes` / `templateVersion` 等派生字段即在入口 400 `invalid_target_payload`。
2. **追加式目标版本**：`allocation_targets` 一行 = 一个版本，自然键 `(assessment_id, template_version, effective_from)` 唯一。复评或模板变化 → 新版本；历史行永不 UPDATE。旧目标继续可读并保留当时引用的评估与规则版本。
3. **当前比例与偏离复用 Phase 4 的同一遍估值**：`Domain.computeAllocationDeviation(target, overview)` 只消费 `Domain.computeOverview` 的 `riskClasses` / `pools.investableMinor` / `blockers` / `canAdvise`，不重跑估值、不新写第二套「能不能建议」的判断。类别合计与投资池不一致时直接 `invalid_valuation_input` 拒绝，说明传入的不是同一遍结果。
4. **比例守恒且边界归属唯一**：bps 用最大余数法（floor 后按余数降序补 1，同余数按 `RISK_CLASSES` 序），`ΣpctBps` 恒等于 10000；容忍带沿用 5A 的端点含入（`min ≤ pct ≤ max → within`）。投资池为 0 → `no_investable`，全部比例为 null，不显示成「都在区间内」。
5. **认可标的映射是纯用户判断**：`approved_instruments` 一行一条「类别 → 标的 + 类别内顺序」。写入口只有 `POST /api/v1/approved-instruments`（整类替换）；行情 / 目录 provider 路径不触碰该表任何列。引用必须「标的已存在 + `classification_status = confirmed` + `asset_class` 与目标类别一致」，否则 422（`unknown_instrument` / `classification_unconfirmed` / `class_mismatch`）。
6. **失效引用不静默消失**：标的后来被删或分类回到 suggested 时，映射行原样保留并在读取视图里给出 `issues`；`classesMissingMapping` 把「该类别目标比例 > 0 但没有可用候选」报为缺映射。`instrument_id` 与 `assessment_id` 均为 `ON DELETE RESTRICT`（§10.6）。
7. **页面**：新增「目标配置」页（决策台入口 `nav:targets`）——目标摘要、六类当前值/区间/容忍带/偏离、缺映射与失效引用提示、每个类别的候选下拉与上移/下移/移除，以及追加式目标版本历史。结果卡文案改为指向该页，5D 边界保持显式声明。

## 2. 已闭合缺口

### G5C-1｜P0｜前端整体保存会抹掉 5B 的评估历史（并会同样抹掉 5C 的两份新事实）

- 复现：`PUT /api/v1/state` 的语义是「载荷缺某顶层集合 = 清空该集合」（5B 已冻结为 `tests/server-phase5b.test.js` 的「缺键清空」断言）。而 `js/app.js` 的 `save()` 经 `Store.saveAll` 只提交 `accounts/categories/txns/settings/assets` 五键 —— 用户在现金流页记一笔账，SQLite 里的 `risk_assessments` 就会被全部删除。实测：写入一条评估后按五键形状 `writeState`，读回 `riskAssessments.length` 由 1 变 0。
- 影响：这是 5B 遗留的真实数据丢失路径；5C 再加两张用户事实表会把同样的坑复制到目标版本与认可标的上。
- 初次修复：`js/store.js` 登记 `COMPANION_KEYS = ['riskAssessments','allocationTargets','approvedInstruments']` 并让加密改写载荷保留显式键。最初采用客户端读后补回；独立复核指出并发覆盖窗口后，最终方案已由 G5C-7 改为单次 PUT + 服务端事务内保留。服务端默认语义仍是缺键清空，因此旧备份恢复能力没有回退。
- 幂等/覆盖边界：只有「从备份恢复」显式提交整份集合（`Core.restoreStateFromBackup` 现在会带出三键，缺键 → 空集合，绝不伪造默认值），才是清空/覆盖指令。
- 防回归证据：`tests/store-headers.test.js`（五键保存后三份集合仍为服务端原值；显式给出时以调用方为准）；`tests/app-wiring.js` 第 26 项（真实页面路径保存后目标/映射/评估逐条保持，显式空集合才清空）；`tests/backup.test.js`（JSON 备份往返保留三集合，旧备份缺键恢复为空、结构损坏显式拒绝）。

### G5C-2｜P1｜类别内顺序唯一索引让「上移/下移」必然失败

- 复现：`uq_approved_instruments_slot(asset_class, position)` 下，两行互换位置若走「逐行 UPDATE」会在语句之间撞到唯一约束（SQLite 外键/唯一检查是语句级即时的），整笔事务回滚，wiring 表现为「第二条调整永不生效」。
- 修复：`replaceApprovedInstrumentClass` 改为「整类先删后插」，并从旧行把 `created_at` 带过来 —— 重复提交同一份清单既不换 id、也不改创建时间（幂等），顺序调整则只改 `position` 与 `updated_at`。标的 id 由 `sha256(类别|标的)` 派生，因此同一映射行在任何一次重写中都保持同一主键。
- 防回归证据：`tests/server-phase5c.test.js`「整类替换保持顺序且幂等」新增 a,b → b,a 换位断言（含 `createdAt` 不变）；wiring 第 26 项在真实页面上点「下移」后回读事实源顺序。

### G5C-3｜P1｜目标引用不存在的评估时报 500

- 复现：`writeState` / 单条写入把引用完整性交给 SQLite 的 `RESTRICT`，外键失败被 `upsertFail` 归为 `internal_error` → 500，客户端无法区分「我提交的备份引用了不存在的评估」与「服务出错」。
- 修复：仓储 `validateAllocationTargetRow` 在第 2 参数为 `null`（查得到形状但没有该评估）时显式抛 `invalid_assessment_ref`，HTTP 映射为 422；`Domain.validateAllocationTargetRecord(record, assessment)` 继续负责「引用对了但内容不一致」的交叉核对。
- 防回归证据：`tests/server-phase5c.test.js` 的 `PUT /state` 用例断言 422 `invalid_assessment_ref`；`tests/server-migration.test.js` 断言 FK 仍拒绝「目标引用不存在的评估」且「有目标引用的评估删不掉」。

### G5C-4｜P2｜`effectiveFrom` 只按形状校验会放过不存在的日期

- 复现：api 层的 `isDateStr` 只是 `YYYY-MM-DD` 正则，`2026-02-30` 能通过；早期实现下它会一路走到领域层，边界语义依赖偶然顺序。
- 修复：`POST /api/v1/targets` 改用 `Domain.isCalendarDate`（真实日历日，与 5A/5B 同口径），显式非法即 400 `invalid_effective_date`，不回退到服务端今天（沿用 G5B-5 的「参数显式非法 ≠ 参数缺省」纪律）。
- 同时删除 `computeAllocationTarget` 中一条不可达的 `effectiveFrom > expiry` 检查：未过期 ⟹ `today ≤ expiry`，而 `effectiveFrom ≤ today` 已被前置检查约束；该不变量在读取路径 `validateAllocationTargetRecord` 仍然复核（伪造备份能触发，测试已覆盖）。

### G5C-5｜P1｜目标页的候选下拉读的是页面缓存，外部刚确认的分类显示为不可选

- 复现：wiring 第 26 项第一版实跑时，「宽基权益应有两个已确认候选」只见到一个 —— 页面的 `state.assets` 还是进入本页之前的快照。
- 修复：`ensureTargetsLoaded` 在读取目标/映射的同时 `Store.loadRaw()` 同步 `state.assets` 与 `settings`，本页渲染前一定与事实源一致；`target:reload` 走同一条路径。
- 防回归证据：wiring 第 26 项在两个全新临时数据目录、两个不同 origin 下均通过（本轮修复前后各一轮）。

### G5C-6｜P2｜定点放缩可能超出安全整数而静默丢精度

- 复现：`valueMinor × 10000` 超过约 9.0e15 时浮点尾差会让 `ΣpctBps` 不再精确等于 10000。
- 修复：与 `mulMinor` 同一纪律 —— 超出 `Number.isSafeInteger` 时返回 `invalid_valuation_input` fail closed，不给「差 1bp」的比例。
- 防回归证据：`tests/domain-phase5c.test.js` 5C-9。

### G5C-7｜P1｜前端补回集合存在 GET→PUT 并发覆盖窗口

- 复现：旧实现的 `Store.saveAll` 先 `GET /state` 读取三份追加式集合，再把旧快照塞进 `PUT /state`。两次请求之间若另一请求追加了风险评估/目标或调整认可标的，后一次 PUT 会用旧快照覆盖并发事实。
- 修复：客户端不再读取或回传缺失集合，只在同一次 PUT 上声明 `preserveCompanionCollections:true`；`repository.writeState` 在**同一个 SQLite 事务内**先读取缺失集合、再执行全量替换并写回。显式给出的集合仍以调用方为准；没有该标志的 PUT 继续保持「缺键清空」，旧备份恢复语义不变。
- 防回归证据：`tests/store-headers.test.js` 锁住 `/state` 只有单次 PUT、没有 GET→PUT；`tests/server-phase5c.test.js` 真实模拟旧页面快照之后发生复评/目标追加与映射换位，再保存仍逐字段保留并发事实。

### G5C-8｜P2｜重复提交认可标的会改写 `updatedAt`

- 复现：整类替换每次都用当前时钟构造候选行，即使清单与位置完全没变，先删后插仍会把所有 `updated_at` 改成提交时间，制造虚假的用户修改记录。
- 修复：按稳定行 id 读取旧行；同一标的且 `position` 未变时同时保留 `created_at` / `updated_at`，只有新增或位置变化才写当前时间。
- 防回归证据：服务端测试在第二次提交前推进固定时钟一小时，断言响应逐字段不变；随后换位并再次推进时钟，断言只保留创建时间、更新时间随真实位置变化更新。

### G5C-9｜P2｜非对象目标载荷被当作空对象

- 复现：`POST /targets` 把 `null`、数组、字符串与数字统一折叠成 `{}`，在已有有效评估时会意外生成目标版本。
- 修复：入口先要求请求体为非数组 JSON 对象；非对象统一返回 400 `invalid_target_payload`，且零落库。
- 防回归证据：真实 HTTP 测试逐个提交 `null` / `[]` / 字符串 / 数字，均返回稳定错误码，目标列表保持为空。

## 3. 门禁实跑（2026-09-21）

| 门禁 | 命令 / 环境 | 结果 |
|---|---|---|
| 5C 领域 | `node --test tests/domain-phase5c.test.js` | **15/15** |
| 5C 真实 HTTP / 仓储 / 迁移 / 备份 | `node --test tests/server-phase5c.test.js` | **12/12** |
| 5C 定向合计 | 上面两个文件 | **27/27** |
| 5A / 5B 回归 | `node --test tests/domain-phase5a.test.js tests/domain-phase5b.test.js tests/server-phase5b.test.js tests/server-migration.test.js` | 全绿（5A-18 范围守卫已按 5C 更新：迁移允许到 v9、`recommendations` 仍延后、Phase 6 表仍不得预建） |
| JSON 备份与门面 | `node --test tests/backup.test.js tests/store-headers.test.js` | **9/9** + **7/7** |
| 全量 | `node --test`（非沙箱，含 loopback 服务与 Keychain） | **576/576** |
| 浏览器 wiring | 两个全新临时数据目录与两个不同 loopback origin | **26/26 × 2** |
| 静态 | `node --check` 全部改动文件；`git diff --check` | 通过 |
| 版本 | `APP_VERSION` 与 SW 缓存键 `2.4.9-phase5c`；schema **v9**（本阶段唯一迁移） | 一致 |
| 网络 | 自动测试全部使用注入时钟与离线 fixture；行情自动抓取仍受 D-038 门禁默认关闭 | **零真实网络请求** |

## 4. 已完成 / 未完成 / 已知限制

**已完成**：§6.2 工作项 1–8 全部落地；范围守卫（5C 段落零时钟、零网络、零存储；无新增资金与决策状态字段）；迁移、全量写入闸、备份恢复、真实 HTTP、浏览器 wiring 与反例。

**明确未做**（属 5D/5E/Phase 6）：新增资金金额与类别分配、尾差到金额的落地、正式建议门禁、决策台解释整合与知识卡、接受/暂缓/执行/复盘状态机。`POST /api/v1/recommendations` 仍是 501 延后登记。

**已知限制**：
1. 「目标模板变化时自动产生新版本」目前是**用户显式生成**（页面按钮 / `POST /targets`）；5C 不后台批量重算历史目标。
2. 生效日期不允许晚于判定日（预排未来目标不属本阶段），因此 `selectCurrentTarget` 的「引用对了但尚未生效」态只可能来自外部导入的数据。
3. 单个类别的认可标的上限固定 50 条（`APPROVED_INSTRUMENT_MAX`），超出显式拒绝而不是静默截断。
4. JSON 备份是明文导出，评估答案等个人事实随之落在用户自选文件里 —— 与既有备份同级敏感度，未新增加密路径。
5. Phase 4A 的行情源 D-038/T-002 门禁仍未闭合，本轮未接入任何新数据源、未开启自动行情。

## 5. 回滚方式

本轮改动是**纯追加**：新库为 v9；已发布的 v1–v8 迁移未修改。回滚 = 切回上一提交（`2.4.7-phase5b` 工作树）并把 `allocation_targets` / `approved_instruments` 两表删除即可，其余表与数据不受影响；`Store.saveAll` 的补回逻辑在旧版本下退化为「不发送这两个键」，与 5B 行为一致。生产回滚前先 `POST /api/v1/backups` 留一份可恢复备份（`AGENTS.md` 高风险操作要求）。

## 6. 下一子阶段唯一入口

见 `NEXT_AGENT.md`：**只做 5D（新增资金优先再平衡 + 正式建议门禁）**，消费 5C 的目标版本与认可标的映射，不得回改 5A 冻结数值或 5C 的映射语义。
