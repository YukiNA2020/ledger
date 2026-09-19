# Phase 5A 独立复核与验收缺口

> 复核日期：2026-09-19  
> 复核对象：`2.4.0-phase5a`（提交 `6efbb16` + `39dcbcf`）  
> 复核范围：`PHASE5_BREAKDOWN.md` §4、`DECISIONS.md` D-046、`ACCEPTANCE.md` S5.1–S5.3 中属于 5A 的规则与契约部分  
> 本轮结论：**暂不通过验收，不进入 Phase 5B。**

## 补口轮次与逐条状态（倒序，最新在上）

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
