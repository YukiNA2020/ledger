# Phase 5B 独立复核与验收缺口

> 最终结论（2026-09-21）：**Phase 5B 通过，可进入 Phase 5C。**
>
> G5B-1～5 全部闭合。最终证据：5B 定向 **27/27**、全量 **546/546**、浏览器 wiring **25/25 × 2**、schema **v8**、零真实网络请求。

## 最终复核（2026-09-21）

第二轮复核确认第 1 轮的三项缺口已闭合，并补出两项读取边界：历史列表此前会原样返回被篡改的派生值；显式非日期 `asOf` 此前会静默回退到服务端今天。两项均已修复并加入真实 HTTP 反例。

### G5B-1｜P1｜浏览器 wiring 被调试过滤器缩成单项

- 复现：`tests/app-wiring.js` 固定设置 `window.__SOLO='风险评估'`，`check()` 跳过其余用例；5B 用例依赖的应用初始化也被跳过，全新库实跑 0/1，首个失败为找不到 `nav:home`。
- 修复：删除 `TEMP-DEBUG` 与过滤/调试拼接，恢复全量顺序执行。
- 防回归证据：两个全新临时数据库、8501/8502 两个不同 origin 均显示 **25 项通过、0 项失败**；首项服务连接至末项只读降级全部出现。
- 状态：✅ 已闭合。

### G5B-2｜P1｜非法载荷 wiring 未调用 `Response.json()`

- 复现：原断言访问 `forged.json.error`，但原生 Fetch `Response.json` 是函数，执行到此必然抛错。
- 修复：先 `var forgedBody = await forged.json()`，再断言稳定错误码与无输入回显。
- 防回归证据：两轮浏览器验收中 5B 用例完整走过缺答拒绝、合法保存、非法派生字段拒绝、第二次复评追加与历史渲染。
- 状态：✅ 已闭合。

### G5B-3｜P1｜阶段决策与交接文档停在 5A

- 复现：实现已推进到 schema v8，但 README、ARCHITECTURE、ACCEPTANCE、TEST、CHANGELOG、NEXT_AGENT 仍声称风险 API 为 501、下一步为 5B；代码引用的 D-047 不存在，ROADMAP 未给 5B 退出证据。
- 修复：补写 D-047；同步 README、ARCHITECTURE、ROADMAP、ACCEPTANCE、TEST、CHANGELOG、NEXT_AGENT，并建立本文件记录复核轨迹。
- 状态：✅ 已闭合。

### G5B-4｜P1｜历史列表读取未复核派生值

- 复现：直接修改 `risk_assessments.risk_ceiling` 后，`GET /risk-assessments/current` 会通过领域重算返回 `invalid_records`，但 `GET /risk-assessments` 仍原样返回伪造上限，页面历史卡会把它展示为真实结果；与 D-047“读取即复核”冲突。
- 修复：历史列表逐条调用 `Domain.validateRiskAssessmentRecord`；只把重算一致的记录放入 `items`，异常历史通过 `invalidCount/total` 显式留痕，不能冒充可用记录或静默消失。
- 防回归证据：`tests/server-phase5b.test.js` 直接改库后断言 `items=[] / invalidCount=1 / total=1`，同时 `/current` 为 `invalid_records`。
- 状态：✅ 已闭合。

### G5B-5｜P2｜非日期 `asOf` 被静默回退到今天

- 复现：`GET /risk-assessments/current?asOf=not-a-date` 因 API 只在正则匹配时采用参数，否则回退 `serverToday`，返回 200；调用方无法知道自己的预览日期无效。
- 修复：区分“参数缺省”和“参数显式存在但非法”。只有缺省时使用服务端今天；显式非法文本或不存在的日历日均返回 400 `invalid_assessment_date`。
- 防回归证据：真实 HTTP 同时覆盖 `2027-02-30` 与 `not-a-date`。
- 状态：✅ 已闭合。

## 最终门禁

- `node --test tests/domain-phase5b.test.js tests/server-phase5b.test.js`：**27/27**。
- `node --test`（非沙箱，含回环服务与 Keychain）：**546/546**。
- 浏览器 wiring：**25/25 × 2**，两个全新临时数据目录与不同 origin。
- `node --check`、`git diff --check`：通过。
- 版本：`APP_VERSION` 与 SW 缓存键均为 `2.4.7-phase5b`；schema 为 v8。
- 范围：未实施 5C–5E 或 Phase 6；零真实网络请求。
