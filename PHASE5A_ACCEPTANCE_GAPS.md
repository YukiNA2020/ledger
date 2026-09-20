# Phase 5A 独立复核与验收缺口

> 复核日期：2026-09-19  
> 复核对象：`2.4.0-phase5a`（提交 `6efbb16` + `39dcbcf`）  
> 复核范围：`PHASE5_BREAKDOWN.md` §4、`DECISIONS.md` D-046、`ACCEPTANCE.md` S5.1–S5.3 中属于 5A 的规则与契约部分  
> 最终结论（2026-09-20）：**Phase 5A 通过，可进入 Phase 5B。**

## 补口轮次与逐条状态（倒序，最新在上）

### 最终完整复核与收口（2026-09-20，`2.4.6-phase5a`）

> 结论：**G5A-1～12 全部闭合，Phase 5A 退出条件满足；下一阶段入口切换为 Phase 5B。**

- **G5A-8 / G5A-9 独立复核通过：** 重造答案与模板的继承字段、访问器、额外字段、异常数组反例均 fail closed；同一答案的不同排列直接深比较完整评分结果一致，调用方数组不被修改。
- **G5A-10（本轮发现并闭合）：** `validateTargetTemplate()` 此前只验证比例自洽，允许在 `risk-targets-v1` 下提交另一套仍合计 100% 的比例。现在结构与比例校验通过后，还必须逐类别、逐字段等于该等级在当前 `targetVersion` 中的唯一冻结模板；同版本不能偷换配置。
- **G5A-11（本轮发现并闭合）：** `newFundsMinor` 此前接受超过 `Number.MAX_SAFE_INTEGER` 的整数值，后续金额分配存在精度风险。现在所有 5A 非负整数入口统一要求安全整数；最大安全整数通过，超界值返回 `invalid_new_funds`。
- **G5A-12（本轮发现并闭合）：** `assessmentValidity()` 此前把晚于 `now` 的评估日期标成有效。现在未来评估日统一返回 `invalid_assessment_date`，当天与历史评估仍按冻结的 365/30 天口径计算。
- **规则图完整性：** 新增 5A-30，锁住每题恰有 0/1/2/3 四档、能力/意愿最大分 15/12、等级边界不越域，以及硬封顶的 code 唯一、题目/分值/等级/解释卡引用全部可解析。
- **反向验证：** 补口前实现会接受“同版本替换比例”“不安全整数金额”和“未来评估日期”；新 5A-31/32/33 对应锁死。此前 5A-28/29 的反向验证继续有效。

最终实测：5A 定向 **33/33**；沙箱外全量 **519/519**；浏览器 wiring **24/24 × 2 个全新临时数据目录**；`node --check js/app.js js/domain.js sw.js` 与 `git diff --check` 通过。schema 仍为 **v7**，`POST /api/v1/risk-assessments` 仍为延后登记 501；零迁移、零 API、零页面、零真实网络请求。`APP_VERSION` 与 SW 缓存键升至 `2.4.6-phase5a`。

### 第五轮完整复核缺口补口（2026-09-20，`2.4.5-phase5a`）

> 状态：**G5A-8 / G5A-9 补口完成，等待独立复核确认；5A 仍不进入 5B。**

- **G5A-8：** 答案容器现在只接受普通稠密自有数据数组；答案行必须精确包含自有数据属性 `questionId` / `optionId`。目标模板顶层、`classes` 与每个比例行应用同一精确自有字段契约；自定义原型、继承字段、访问器、额外字符串/Symbol 属性全部 fail closed，不执行 getter。`Object.create(null)` 的 JSON 等价纯数据对象继续允许。
- **G5A-9：** `validateRiskAnswers()` 校验后按冻结 `RISK_QUESTIONS` 顺序重建答案；`scoreRiskAnswers()` 的完整返回值（包括 `scored`）不再依赖调用方排列顺序，也不修改调用方数组。
- **反向验证：** 把 5A-28/29 指向本轮补口前的 `HEAD:js/domain.js`，两项均稳定失败：旧实现接受继承答案字段，且正序/倒序评分的 `scored` 顺序不同。

实测：5A 定向 **29/29**；沙箱外全量 **515/515**；浏览器 wiring **24/24 × 2 个全新临时数据目录**；schema 仍为 **v7**，`POST /api/v1/risk-assessments` 仍为延后登记 501。零迁移、零 API、零页面、零真实网络。`APP_VERSION` 与 SW 缓存键升至 `2.4.5-phase5a`。

### 第五轮完整独立复核（2026-09-19，复核工作区 `2.4.4-phase5a`）

> 结论：**G5A-7 补口通过；完整复核新发现 G5A-8 / G5A-9。5A 仍暂不通过，不能进入 5B。**

| ID | 优先级 | 复核结论 | 独立实测 |
|---|---:|---|---|
| G5A-7 | P0 | ✅ 补口通过 | 自定义数组原型、继承索引、无 `slice` 原型、稀疏数组、额外字符串/Symbol 属性和访问器均稳定拒绝；普通/空数组通过 |
| G5A-8 | P1 | ❌ 新缺口 | 风险答案行和目标模板比例行仍会读取原型链字段；没有自有 `questionId/optionId` 或 `minBps/targetBps/maxBps` 的对象可被判为合法 |
| G5A-9 | P1 | ❌ 新缺口 | 同一组答案仅改变数组顺序时，评分主体相同但返回的 `scored` 数组顺序变化，完整结果不能逐字段复算；现有测试先排序再比较，掩盖了该差异 |

#### G5A-8｜答案与模板行未执行自有字段契约（P1）

建议契约经过多轮补口后已采用普通对象、精确键和自有值规则，但 5A 的另外两个入口仍使用宽松属性读取：

- `validateRiskAnswers()` 仅用 `row.questionId` / `row.optionId` 读取答案，因此两个字段全部来自原型链、答案行自身没有任何数据时仍通过。
- `validateTargetTemplate()` 对每个类别行用 `row.minBps` / `targetBps` / `maxBps` 读取比例，因此三个字段来自不可枚举原型属性时仍通过。

独立复现结果：

```text
inherited-answer-row = {"ok":true,...}
inherited-template-row = {"ok":true}
```

修复门槛：

- 答案容器必须是普通稠密数组；每个答案行必须是普通自有数据对象，精确包含 `questionId` / `optionId`，不得读取原型链、访问器或额外派生分数字段。
- 模板自身、`classes` 和每个类别比例行使用一致的普通对象/精确键规则；比例必须来自自有数据属性，不执行 getter。
- 非法结构返回当前稳定错误码，不得抛异常；同时保留正常 JSON 对象和 null-prototype 数据对象是否允许的明确决定。

#### G5A-9｜答案顺序改变会改变完整评分结果（P1）

`scoreRiskAnswers()` 的分数、等级和封顶不依赖答案顺序，但 `scored` 直接沿用输入顺序。相同九道题的答案正序与倒序会得到不同 JSON：

```text
answer-order-full-equal = false
first = q_income_stability / q_fx_understanding
```

现有 5A-11 在比较前调用 `stripScored()` 对该数组排序，因此测试标题声称“与答案排列顺序无关”，实际只证明除 `scored` 外的字段无关。这与 5A 的“相同语义输入得到逐字段稳定结果”和后续持久化可复算目标不一致。

修复门槛：

- `validateRiskAnswers()` 或 `scoreRiskAnswers()` 按冻结题库顺序规范化 `scored`，不能依赖调用方数组顺序。
- 新反例直接 `deepStrictEqual(scoreRiskAnswers(a), scoreRiskAnswers(reverse(a)))`，不得在断言前对返回值二次排序。
- 确认规范化不修改调用方数组，并保持 S5.1 样例逐字段不变或按明确版本化契约更新。

#### 第五轮测试证据

```text
node --test tests/domain-phase5a.test.js
27/27 通过

node --test
513/513 通过（非沙箱、真实用户身份）
```

全量回归证明普通路径无回归，但当前 27 项没有覆盖 G5A-8，并主动规避了 G5A-9 的完整结果差异。schema 仍为 v7；零迁移、零 API、零页面。本轮只追加复核记录，没有修改实现代码或进入 5B。

### 第四轮独立复核缺口补口（2026-09-19，`2.4.4-phase5a`）

> 状态：**G5A-7 补口完成，等待独立复核确认；5A 仍不进入 5B。**

- 认可标的列表只接受原型严格为 `Array.prototype` 的普通数组。
- 数组必须稠密且只有 `length` 与自有数字索引；额外字符串键、不可枚举键、Symbol、稀疏槽位和访问器一律拒绝。
- 校验通过后从属性描述符中的自有数据值构造新数组，不调用可能被替换的实例 `slice()`，非法形状稳定返回 `invalid_approved_instruments`。
- 5A-27 覆盖继承索引、无 `slice` 原型、稀疏数组、额外属性、Symbol、抛错 getter，以及普通/空数组正例；指向补口前实现时稳定失败。

定向测试 **27/27**，沙箱外全量 **513/513**；版本升至 `2.4.4-phase5a`。schema 仍为 v7，零迁移、零 API、零页面、零真实网络。

### 第四轮独立复核（2026-09-19，复核工作区 `2.4.3-phase5a` 补口）

> 结论：**G5A-6 的映射对象层补口有效，但数组元素层仍可被原型链注入；新记 G5A-7。5A 暂不通过，不能进入 5B。**

| ID | 优先级 | 复核结论 | 独立实测 |
|---|---:|---|---|
| G5A-6 | P0 | ✅ 对象层闭合 | 继承的已知/未知类别、自定义原型、不可枚举/Symbol 原型属性均拒绝；普通对象、空对象和 null-prototype 空映射正常通过 |
| G5A-7 | P0 | ❌ 新缺口 | 类别值数组允许自定义原型；继承的数组索引会被读取并经 `slice()` 复制为认可标的，另一种原型形状会直接抛 `TypeError` 而非 fail closed |

#### G5A-7｜认可标的数组仍可通过原型索引注入（P0）

`approvedInstruments` 映射本身现已要求普通对象或 null-prototype 对象，但每个类别对应的数组只检查 `Array.isArray()`。数组可以保持 `Array.isArray === true` 的同时改写原型，并从原型继承索引值。当前循环通过 `map[cls][j]` 读取该继承值，随后 `slice()` 又会把它复制成自有元素，最终仍把未由用户提交的标的变成“用户认可标的”。

最小复现：

```js
const proto = Object.create(Array.prototype);
Object.defineProperty(proto, '0', {
  value: 'inst-inherited-array-slot',
  enumerable: false
});
const injected = [];
injected.length = 1;
Object.setPrototypeOf(injected, proto);

// 把 injected 放入 approvedInstruments.broad_equity 后，当前错误结果为：
// { ok: true, approvedInstruments: { broad_equity: ['inst-inherited-array-slot'] } }
```

若把数组原型直接改为不继承 `Array.prototype` 的对象，前置逐项校验仍可能通过，但执行 `map[cls].slice()` 时会抛 `TypeError: ...slice is not a function`，同样违反非法输入必须返回稳定错误码而不是抛栈的 fail-closed 契约。

修复门槛：

- 类别数组只接受原型严格为 `Array.prototype` 的普通数组，或逐项要求索引为数组自有属性并使用不依赖实例原型的复制方式。
- 稀疏数组、自定义数组原型、继承索引、额外字符串/Symbol 属性必须有明确且一致的拒绝规则。
- 非法数组形状一律返回 `invalid_approved_instruments`，不得抛异常。
- 增加普通数组、空数组正例，以及上述继承索引和无 `slice` 原型的攻击性反例。

测试证据：5A 定向 **26/26**；沙箱外全量 **512/512**。当前用例没有深入校验认可标的数组本身的原型与自有索引，因此全量绿色不能覆盖 G5A-7。本轮只追加复核证据，没有修改实现代码或进入 5B。

### 第三轮独立复核缺口补口（2026-09-19，`2.4.3-phase5a`）

> 状态：**G5A-6 补口完成，等待独立复核确认；5A 仍不进入 5B。**

- `hasExactRiskKeys` 现在只接受原型为 `Object.prototype` 或 `null` 的纯数据对象，完整拒绝自定义原型（包括不可枚举属性与 Symbol）。
- `approvedInstruments` 先按 `RISK_CLASSES` 做精确键校验，再只读取自有类别；继承的已知/未知类别都不能进入结果。
- 5A-26 覆盖继承的已知类别、未知类别、不可枚举原型属性、Symbol 原型属性、普通空映射、自有合法映射与无原型空映射。
- 反向验证指向补口前实现时 5A-26 稳定失败：继承的 `broad_equity` 被错误接受并产出未认可标的。

定向测试 **26/26**，沙箱外全量 **512/512**；版本升至 `2.4.3-phase5a`。schema 仍为 v7，零迁移、零 API、零页面、零真实网络。

### 第三轮独立复核（2026-09-19，复核工作区 `2.4.2-phase5a` 补口）

> 结论：**G5A-4 / G5A-5 主补口复核通过；新发现 G5A-6，5A 仍暂不通过，不进入 5B。**

| ID | 优先级 | 复核结论 | 独立实测 |
|---|---:|---|---|
| G5A-4 | P1 | ✅ 补口通过 | 缺失、字符串、越界、小数 `level` 以及未知、空格/大小写变体 `templateVersion` 均拒绝；五个内置模板继续通过 |
| G5A-5 | P1 | ✅ 主补口通过 | 顶层请求、`snapshotRef`、`assessmentRef` 的额外自有键、不可枚举自有键、Symbol 键和可枚举原型链注入均拒绝；合法输入保持通过 |
| G5A-6 | P0 | ❌ 新缺口 | `approvedInstruments` 会读取原型链继承的已知类别并把其中标的复制为“用户认可”；同一白名单助手还漏过不可枚举的原型属性 |

#### G5A-6｜原型链可注入“用户认可标的”（P0）

`validateRecommendationRequest()` 对顶层和两个引用对象使用 `hasExactRiskKeys()`，但 `approvedInstruments` 仍沿用“按类别直接读取 + `for...in` 只检查自有未知键”的旧逻辑。若映射对象从原型继承 `broad_equity`，函数会通过 `map[cls]` 读到继承数组并复制到输出；随后的循环遇到继承键反而因为 `hasOwnProperty === false` 跳过拒绝。结果是调用方没有提交任何自有映射，却得到一个“已认可标的”。这直接违反“只映射用户认可标的”的 Phase 5 不变量。

最小复现：

```js
const Domain = require('./js/domain.js');
const approvedInstruments = Object.create({
  broad_equity: ['inst-not-approved']
});
const result = Domain.validateRecommendationRequest({
  snapshotRef: { closeId: 'c', snapshotId: 's', payloadHash: 'a'.repeat(64) },
  assessmentRef: { id: 'r', ruleVersion: Domain.RISK_RULE_VERSION },
  targetVersion: Domain.RISK_TARGET_VERSION,
  ruleVersion: Domain.RISK_RULE_VERSION,
  newFundsMinor: 1,
  approvedInstruments
});

console.log(result);
// { ok: true, approvedInstruments: { broad_equity: ['inst-not-approved'] } }
```

同一轮还确认 `hasExactRiskKeys()` 只用 `for...in` 检查原型链，因此不可枚举的原型属性能够绕过其“拒绝原型链注入”的声明：

```js
const proto = {};
Object.defineProperty(proto, 'capacityScore', { value: 999, enumerable: false });
const payload = Object.assign(Object.create(proto), validRequest);
Domain.validateRecommendationRequest(payload); // 仍为 ok:true
```

第二条当前不会进入返回值，但说明精确白名单助手并不真正精确；未来调用方读取继承属性时会重新出现同类问题。

修复门槛：

- `approvedInstruments` 必须只消费自有属性；已知类别来自原型链时也必须拒绝，不能复制成认可映射。
- 对象契约明确只接受普通自有数据对象，或完整检查整个原型链的字符串键、不可枚举键与 Symbol；不能只检查 `for...in` 可见部分。
- 增加继承的已知/未知类别、不可枚举原型属性、Symbol 原型属性，以及普通空映射/自有合法映射的正反例。
- 修复后再次确认无认可映射仍返回 `{}`，不会静默生成任何标的。

#### 第三轮测试证据

```text
node --test tests/domain-phase5a.test.js
25/25 通过

node --test
511/511 通过（非沙箱、真实用户身份）
```

当前 25 项没有覆盖 G5A-6，因此全量绿色不构成该缺口的闭合证据。schema 仍为 v7；本轮只更新复核记录，没有修改实现代码或进入 5B。

### 第二轮独立复核缺口补口（2026-09-19，`2.4.2-phase5a`）

> 状态：**G5A-4 / G5A-5 补口完成，等待独立复核确认；5A 仍不进入 5B。** 本轮不改任何题目、分值、边界、硬封顶或目标比例。

| ID | 状态 | 修复与反例 |
|---|---|---|
| G5A-4 | ✅ 已补口 | `validateTargetTemplate` 要求 `level` 是 `RISK_LEVELS` 中的整数且 `templateVersion === RISK_TARGET_VERSION`；5A-23 覆盖缺失、字符串、越界、小数、未知版本及空格/大小写变体，五个内置模板与 fixture 仍通过 |
| G5A-5 | ✅ 已补口 | 建议请求执行冻结的顶层键白名单：五个核心键必填，`approvedInstruments` 可选；两个引用对象也执行精确键集合；额外自有键、不可枚举键及原型链注入均 fail closed。5A-24 覆盖反例，5A-25 锁定合法输入零回归 |

实测：5A 定向 **25/25**；沙箱外全量 **511/511**；schema 仍为 v7，零迁移、零 API、零页面、零真实网络。反向验证把新测试指向本轮修改前的 `HEAD:js/domain.js`：5A-23 / 5A-24 均失败，5A-25 通过。`APP_VERSION` 与 SW 缓存键同步升至 `2.4.2-phase5a`。

### 第二轮独立复核（2026-09-19，复核 `2.4.1-phase5a`）

> 结论：**G5A-1 / G5A-2 / G5A-3 补口复核通过；新发现 G5A-4 / G5A-5，5A 仍暂不通过，不进入 5B。**

| ID | 优先级 | 复核结论 | 独立实测 |
|---|---:|---|---|
| G5A-1 | P0 | ✅ 补口通过 | 依次尝试修改选项分值、目标比例、硬封顶等级和资产类别词表，评分仍为 15、嵌套对象 `Object.isFrozen === true`；整体替换导出键不改变内部闭包引用，新增 5A-19 通过 |
| G5A-2 | P1 | ✅ 补口通过 | `risk-targets-unknown` 返回 `invalid_target_template`；空值、空白、大小写/空格变体和交叉错配由 5A-20 覆盖 |
| G5A-3 | P1 | ✅ 补口通过 | 普通额外类别 `crypto` 返回 `invalid_target_template`；不可枚举键、原型链、JSON `__proto__` 和异常对象形状由 5A-21 覆盖 |
| G5A-4 | P1 | ❌ 新缺口 | `validateTargetTemplate` 不验证模板自身的 `level` 与 `templateVersion`；`level=999` 且 `templateVersion='risk-targets-unknown'` 仍返回 `{ok:true}` |
| G5A-5 | P1 | ❌ 新缺口 | `validateRecommendationRequest` 没有执行冻结的 `RECOMMENDATION_INPUT_KEYS` 白名单；夹带 `capacityScore`、`currentAllocation` 等派生字段仍返回 `{ok:true}` |

#### G5A-4｜目标模板元数据未纳入合法性校验（P1）

`validateTargetTemplate()` 已严格验证六类比例，却完全忽略 `tpl.level` 和 `tpl.templateVersion`。这使未知风险等级与未知目标版本可以被判为“合法模板”，与 D-046 ⑤/⑦的“5 级模板 + 版本绑定”冲突。

最小复现：

```js
const Domain = require('./js/domain.js');
const template = JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
template.level = 999;
template.templateVersion = 'risk-targets-unknown';
console.log(Domain.validateTargetTemplate(template)); // { ok: true }
```

修复门槛：

- `level` 必须是 `RISK_LEVELS` 中唯一合法的整数等级；不得接受字符串、越界值或缺失值。
- `templateVersion` 必须解析到当前明确支持的目标版本；5A 只有 `RISK_TARGET_VERSION`，因此应精确相等。
- 增加缺失、未知、类型错误、空格/大小写变体的反例，并确认五个内置模板仍通过。

#### G5A-5｜建议输入键集合只声明、未执行（P1）

D-046 ⑥与 `RECOMMENDATION_INPUT_KEYS` 都冻结了“输入只含引用与用户判断”，但 `validateRecommendationRequest()` 只逐项读取已知字段，不拒绝额外顶层键。客户端可以夹带 `capacityScore`、`riskCeiling`、`currentAllocation` 或 `blockers` 等服务端应重算的派生值，校验仍成功。即使后续实现选择忽略这些字段，契约也不再是声明的白名单，5B/5D 容易误用客户端派生事实。

最小复现：

```js
const Domain = require('./js/domain.js');
const result = Domain.validateRecommendationRequest({
  snapshotRef: { closeId: 'c', snapshotId: 's', payloadHash: 'a'.repeat(64) },
  assessmentRef: { id: 'r', ruleVersion: Domain.RISK_RULE_VERSION },
  targetVersion: Domain.RISK_TARGET_VERSION,
  ruleVersion: Domain.RISK_RULE_VERSION,
  newFundsMinor: 1,
  approvedInstruments: {},
  capacityScore: 999,
  currentAllocation: { crypto: 10000 }
});
console.log(result); // { ok: true, approvedInstruments: {} }
```

修复门槛：

- 请求体自有键集合必须与 `RECOMMENDATION_INPUT_KEYS` 契约一致；若 `approvedInstruments` 允许省略，应把“必填键”和“可选键”在机器契约中分别冻结。
- 未知键、不可枚举键和原型链注入均 fail closed，错误 detail 不回显载荷原文。
- `snapshotRef` / `assessmentRef` 是否也要求精确键集合，应在本轮一并冻结并用反例锁定，避免派生分数或完整快照被夹带进引用对象。

#### 第二轮测试证据

```text
node --test tests/domain-phase5a.test.js
22/22 通过

node --test
508/508 通过（非沙箱、真实用户身份）
```

schema 仍为 v7；风险评估 API 仍未实现；本轮未修改实现代码。全量绿色不覆盖 G5A-4/5，因为当前 22 项没有对应反例。

### 第 1 轮复核缺口补口（2026-09-19，`2.4.1-phase5a`）

> 补口针对下方「第一轮独立复核」的 G5A-1 / G5A-2 / G5A-3。**下面的原文未删改**，本表是补口后的逐条状态。
> 措辞：**补口完成，等待独立复核确认**——不是「5A 已通过」，也不进入 5B。

| ID | 优先级 | 状态 | 修复实现（`js/domain.js`） | 反向用例（改回旧实现即红） |
|---|---:|---|---|---|
| G5A-1 | P0 | **已补口** | 5A 段落新增 `deepFreezeRisk`，对 16 个对外规则常量**递归冻结**：题目 → 选项数组 → 选项、模板 → 类别表 → 类别行、两个等级边界数组及其条目、硬封顶条目、类别 / 维度 / 容忍带 / 状态 / 复评原因 / 错误码 / 契约键各词表。内部评分与查表只读这些内部引用；`riskCatalog()` / `targetTemplateForLevel()` 仍返回**可写深拷贝**（不是冻结视图），调用方改自己的副本不受限制 | `tests/domain-phase5a.test.js` **5A-19**：19 条原地修改尝试（复现原文的选项分值，外加题目 id / 维度、题库 push 与 delete、选项数组 push、两级边界、硬封顶等级与题目、模板比例、模板增删类别、类别 / 错误码 / 复评词表）后，`scoreRiskAnswers` 与 `targetTemplateForLevel` / `riskCatalog` / `recommendationContract` 结果**逐字段不变**，15 分不变成 12 分；规则内容仍逐字段等于冻结副本（因此「内容已变而版本不变」结构性地不可能）；逐层 `Object.isFrozen`；最后用 `try/finally` 整体换掉对外键（`RISK_QUESTIONS` / `TARGET_TEMPLATES` / 边界 / 硬封顶 / 错误码 / 两个版本常量 / 有效期天数）并断言评分、查表、模板校验、有效期、契约校验全部不受影响，且收尾已复原 |
| G5A-2 | P1 | **已补口** | `validateRecommendationRequest` 由「非空字符串」收紧为 `payload.targetVersion === RISK_TARGET_VERSION`，不匹配即 `invalid_target_template`；将来支持历史模板时须改为按显式版本目录解析 | **5A-20**：`risk-targets-unknown` / `risk-targets-v2` / `risk-targets-v0` / 首尾空格 / 大小写变体 / `risk-targets-v1.0` / 规则版本冒充目标版本 / 空串与空白串 / `null` / 布尔 / 数字 / 数组 / 对象 / `undefined` 共 17 个反例全部拒绝；`targetVersion` 与 `ruleVersion` 交叉互换时各自报各自版本的错误码；合法请求（含无映射、0 元）仍通过；detail 不回显输入原文 |
| G5A-3 | P1 | **已补口** | `validateTargetTemplate` 增加两道检查：① `Object.getOwnPropertyNames(tpl.classes).length === RISK_CLASSES.length` 且每个自有键都在词表内（用 `getOwnPropertyNames` 而非 `Object.keys`，否则可用 `defineProperty` 藏一个不可枚举类别绕过）；② 原型链上不得出现可枚举类别（`Object.create({crypto:…})`）。缺失与额外均返回 `invalid_target_template` | **5A-21**：额外 `crypto`（比例本身"合法"）、`defineProperty` 藏的不可枚举 `gold`、原型链额外类别、六类全部来自原型链、JSON 文本里的 `__proto__` 自有键、`classes` 为数组 / Date / 字符串 / null 四种异常形状，全部拒绝；原有缺类别反例仍按原错误码拒绝；内置五级模板与 fixture 模板仍全部通过 |
| — | — | **零回归** | 冻结与收紧均未改动任何既有函数签名与正向语义 | **5A-22**：S5.1 冻结样例逐字段不变；S5_2 / S5_3 仍标注 `verifiesIn: 5D`、5A 不宣称其通过；合法建议请求仍通过；规则目录与模板副本仍是**可写**深拷贝 |

**补口门禁（实跑）**

| 项 | 结果 |
|---|---|
| 5A 定向 | **22/22**（`node --test tests/domain-phase5a.test.js`，18 → 22，新增 5A-19～5A-22） |
| 全量回归 | **508/508**（非沙箱、真实用户身份；486 项 Phase 1–4E **零回归** + 22 项 5A） |
| 浏览器 wiring | **24/24 × 2**（两个全新临时数据目录；5A 未改前端逻辑，属回归确认） |
| schema / 网络 | 仍为 **v7**；零新迁移、零新 API、零新页面；自动测试零真实网络请求 |
| 版本 | `APP_VERSION` 与 SW 缓存键升至 `2.4.1-phase5a`（复核补口单独占一个版本） |

**反例有效性验证（关键）**：仅「测试全绿」不足以证明缺口已闭合，因此把 5A 测试文件指向 `2.4.0-phase5a` 的 `js/domain.js`（`git show HEAD:js/domain.js > /tmp/old-domain.js` 后改 require 目标，临时文件用完即删、未入库）重跑：**5A-19 / 5A-20 / 5A-21 以及被旧实现连带污染的 5A-22 全部失败，原有 18 项全绿**。即新增用例确实锁住了这三条缺口，而不是「怎么改都绿」。

**仍未闭合的部分**：本次补口只回应 G5A-1/2/3。5A 的其余规则口径（题目与分值、边界、硬封顶、模板数值、复评词表、建议契约）**未做任何改动**，也不宣称 5A 已通过验收；需要独立复核按下方「下一轮复核清单」重新确认后才能把本文件结论更新为「通过」并切换 5B。

## 第一轮独立复核（2026-09-19）

### 1. 总结

5A 的主路径和既有测试全部通过，但反向检查发现 3 个可稳定复现的契约缺口：

| ID | 优先级 | 缺口 | 影响 | 状态 |
|---|---:|---|---|---|
| G5A-1 | P0 | 导出的规则常量可被调用方原地修改 | 同一进程中相同答案可得到不同评分，规则版本不变，违反“唯一机器可读定义”和可复算不变量 | 待修复 |
| G5A-2 | P1 | `validateRecommendationRequest` 接受任意非空 `targetVersion` | 未知目标模板版本可通过 5A 契约门禁，5D 可能把不存在或错误版本绑定为正式建议输入 | 待修复 |
| G5A-3 | P1 | `validateTargetTemplate` 接受额外资产类别 | 与“六类不重不漏、未知类别 fail closed”的冻结口径矛盾，非法模板可被判定为合法 | 待修复 |

因此，`504/504` 只能证明已有断言通过，不能证明 5A 的退出条件已经满足。修复以上缺口并补入真实反例前，保持“规则冻结完成，等待复核”，不得改成“5A 已通过”，也不得进入 5B。

### 2. 已确认通过的部分

- 题库为 9 题：承受能力 5 题、承受意愿 4 题；题目 id、选项 id、维度和解释键在当前定义中唯一。
- 双评分边界下界含入；零分、满分和所有阶梯边界的既有测试通过。
- `riskCeiling` 先取能力/意愿较低值，再应用硬封顶；S5.1 高意愿不能抬高低能力上限。
- 缺答、未知题目、未知选项和重复回答 fail closed，错误 detail 不回显输入原文。
- 评估日期使用显式 `now`，不读系统时钟；伪日历日被拒绝；到期日当天/次日边界已覆盖。
- 当前内置 5 级目标模板的六类区间满足 `min ≤ target ≤ max`，`ΣtargetBps = 10000`，个股 target 为 0。
- 容忍带端点含入，0 元新增资金为合法输入。
- 5A 范围保持：schema 仍为 v7；没有风险评估 API、数据库表或问卷页面；没有新增网络请求。

### 3. G5A-1｜规则常量可变，破坏确定性（P0）

#### 现象

`riskCatalog()` 和 `targetTemplateForLevel()` 返回深拷贝，但 `Domain.RISK_QUESTIONS`、`Domain.TARGET_TEMPLATES`、等级边界、硬封顶等常量本身仍以可变数组/对象直接导出。任一浏览器或服务端调用方都能原地修改规则，之后 `scoreRiskAnswers()` 会读取被修改后的对象；规则版本仍然是 `risk-rules-v1`。

#### 最小复现

```js
const Domain = require('./js/domain.js');
const answers = Domain.RISK_QUESTIONS.map((q) => ({
  questionId: q.id,
  optionId: q.options[0].id
}));

const before = Domain.scoreRiskAnswers(answers);
Domain.RISK_QUESTIONS[0].options[0].score = 0;
const after = Domain.scoreRiskAnswers(answers);

console.log(before.capacityScore); // 15
console.log(after.capacityScore);  // 12
console.log(before.ruleVersion, after.ruleVersion); // 均为 risk-rules-v1
```

#### 违反的不变量

- `PHASE5_BREAKDOWN.md` §2.6：相同事实和规则版本必须逐字段得到相同结果。
- D-046 ⑦：题目、分值等规则变动必须升版本。
- 5A 退出条件：规则有唯一机器可读定义。

#### 修复门槛

- 内部评分逻辑不得消费调用方可修改的引用。
- 对外规则目录必须是不可变视图或每次深拷贝；嵌套对象也必须覆盖，不能只冻结第一层。
- 增加反例：尝试修改对外题目、选项分值、边界、硬封顶和目标模板后，评分与模板查表结果必须保持不变；规则版本不能在内容已变时保持原值。

### 4. G5A-2｜未知目标版本被契约接受（P1）

#### 现象

`validateRecommendationRequest()` 对 `assessmentRef.ruleVersion` 与 `ruleVersion` 都要求等于当前冻结版本，却只验证 `targetVersion` 是非空字符串。不存在的 `risk-targets-unknown` 会返回 `ok:true`。

#### 最小复现

```js
const Domain = require('./js/domain.js');
const result = Domain.validateRecommendationRequest({
  snapshotRef: {
    closeId: 'close-1',
    snapshotId: 'snapshot-1',
    payloadHash: 'a'.repeat(64)
  },
  assessmentRef: { id: 'risk-1', ruleVersion: Domain.RISK_RULE_VERSION },
  targetVersion: 'risk-targets-unknown',
  ruleVersion: Domain.RISK_RULE_VERSION,
  newFundsMinor: 1,
  approvedInstruments: {}
});

console.log(result); // { ok: true, approvedInstruments: {} }
```

#### 违反的不变量

- D-046 ⑥/⑦：建议必须绑定有效目标版本，当前冻结版本为 `risk-targets-v1`。
- 5A 建议输入契约：非法或版本错配输入必须 fail closed。

#### 修复门槛

- 5A 仅有一个可用目标版本时，要求 `targetVersion === RISK_TARGET_VERSION`；如未来支持历史模板，应通过显式版本目录解析，不能接受任意非空字符串。
- 增加未知版本、空版本、规则版本与目标版本交叉错配反例，返回稳定错误码。

### 5. G5A-3｜目标模板额外类别未被拒绝（P1）

#### 现象

`validateTargetTemplate()` 会逐一检查六个已知类别，但不会检查 `tpl.classes` 是否还存在额外键。加入 `crypto` 后仍返回 `ok:true`。

#### 最小复现

```js
const Domain = require('./js/domain.js');
const template = JSON.parse(JSON.stringify(Domain.TARGET_TEMPLATES[2]));
template.classes.crypto = { minBps: 0, targetBps: 0, maxBps: 10000 };

console.log(Domain.validateTargetTemplate(template)); // { ok: true }
```

#### 违反的不变量

- 5A 工作项与测试标题声明的“资产类别不重不漏”。
- D-046 ⑤：模板固定为六类；实现不能接受未冻结类别。
- fail closed 原则：未知类别不能被静默忽略。

#### 修复门槛

- 校验 `Object.keys(tpl.classes)` 与 `RISK_CLASSES` 精确相等；缺失或额外类别均返回稳定错误码。
- 增加额外类别、继承属性/异常对象形状等反例。

### 6. 测试证据

#### 5A 定向

```text
node --test tests/domain-phase5a.test.js
18/18 通过
```

#### 全量回归

首次在受限沙箱内执行时，HTTP 测试因无法监听 `127.0.0.1`、Keychain 测试因权限受限而失败，属于执行环境限制，不计为产品回归失败。随后在真实用户权限下重跑：

```text
node --test
504/504 通过
```

全程未访问真实行情网络；schema 保持 v7。

#### 额外反向验证

```text
extra_class_template = {"ok":true}
unknown_target_version = {"ok":true,"approvedInstruments":{}}
mutable_export_before_after = {"before":15,"after":12}
```

### 7. 下一轮复核清单

1. 优先复核 G5A-1：全部对外规则对象的深层修改均不能改变评分、模板或契约结果。
2. 复核未知 `targetVersion` 明确失败；历史版本支持必须依赖显式版本目录。
3. 复核目标模板对额外类别 fail closed，且内置模板仍全部通过。
4. 运行 5A 定向测试和全量 504 项回归；若增加反例，更新新的总数。
5. 确认仍为零迁移、零 API、零页面、零真实网络。
6. 三项全部闭合后，才可把本文件结论更新为“通过”并切换到 5B。
