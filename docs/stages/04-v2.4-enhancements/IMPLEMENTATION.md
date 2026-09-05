# 第四阶段实施方案：V2.4 可选增强

> 目标版本：`v2.4.0`
> 前置条件：第三阶段 `v2.0.0` 已正式验收，且用户明确确认启动 V2.4。
> 功能范围：负债账户、粘贴文本快速记账、标签系统、WebAuthn 生物识别解锁。

## 1. 实施原则

四项能力必须能独立开发、独立测试、独立关闭，不能做成一次不可拆分的大改。推荐顺序：Schema 迁移基础 → 标签 → 负债账户 → 粘贴记账 → WebAuthn。WebAuthn 风险最高，最后接入。

本阶段保持 Web 版“零构建、零运行时依赖、零外联”。允许增加本地 UMD 模块和 `<script>`，不允许引入 CDN 或把账目送到云端解析。

## 2. 目标目录与模块边界

建议增加：

```text
js/
├── core.js                 # 现有公共财务口径、Schema 迁移入口
├── liability.js            # 负债余额/账单日/还款纯逻辑
├── quick-entry.js          # 粘贴文本解析纯逻辑
├── tags.js                 # 标签规范化、过滤、汇总纯逻辑
├── passkey.js              # WebAuthn PRF 能力检测与密钥包装
├── db.js                   # v1/v2 锁格式与 envelope encryption
└── app.js                  # 页面编排，不复制上述业务规则
tests/
├── migration.test.js
├── liability.test.js
├── quick-entry.test.js
├── tags.test.js
└── passkey-browser.html    # 只在安全上下文和支持设备上运行
```

每个新模块采用与 `core.js` 一致的 UMD 形式，使 Node 可 `require`、浏览器可挂载全局对象。`index.html` 明确脚本加载顺序，`sw.js` 把新增文件加入应用壳。

## 3. WP4.0 Schema 与迁移基础

### 3.1 统一版本常量

在 `core.js` 导出：

```js
CURRENT_SCHEMA_VERSION = 2
migrateState(rawState)
migrateBackup(backup)
validateState(state)
```

不要在 `app.js`、`db.js` 和备份函数中分别硬编码版本。启动流程应为：读取原始状态 → 判断加密格式并解锁 → 迁移内存状态 → 校验 → 原子保存 → 渲染。迁移失败时保留原数据并显示可操作错误，不能自动初始化为空账本。

### 3.2 Schema v2 增量

```js
account = {
  // 现有字段保留
  type: 'wechat' | 'alipay' | 'bank' | 'cash' | 'liability',
  liabilityKind?: 'credit-card' | 'consumer-credit',
  creditLimit?: number,        // 分；可空
  statementDay?: number,       // 1..31；可空
  dueDay?: number              // 1..31；可空
}

transaction = {
  // 现有字段保留
  tags?: string[]              // 去重、trim 后的显示名称
}

settings = {
  schemaVersion: 2,
  tags: string[],
  featureFlags: {
    liability: boolean,
    quickEntry: boolean,
    tags: boolean,
    passkey: boolean
  },
  lock: { /* v1 或 v2 lock 结构，见 WP4.4 */ }
}
```

兼容规则：缺少 `tags` 等价于空数组；旧账户默认是资产账户；旧 Schema 1 恢复后迁移到 2；未来 Schema 仍拒绝。备份必须保留所有未知的非危险业务字段，避免旧客户端恢复新备份时静默截断；不兼容时应明确拒绝。

测试：空状态、完整 v1、加密 v1、缺失可选字段、损坏字段、重复迁移幂等、v2 备份往返、未来版本拒绝。

## 4. WP4.1 标签系统

### 4.1 产品行为

- 一笔交易可有 0–10 个标签；单标签 trim 后 1–20 个字符。
- 标签区分显示名称但匹配时大小写不敏感；`旅行` 与 ` 旅行 ` 视为同一标签。
- 标签不替代分类：分类用于唯一归属和预算口径，标签用于跨分类主题，如“出差”“装修”“约会”。
- 明细支持多标签筛选，默认“同时包含全部所选标签”；提供“任一标签”切换。
- 交易详情、手动记账、编辑、导入确认可增删标签。
- CSV 增加“标签”列，以 `|` 分隔并走既有 CSV 转义；JSON 自然保留数组。
- 统计页第一版只做标签金额/笔数排行，不把标签金额合计解释成总支出，因为多标签会重复计数。

### 4.2 核心接口

`tags.js` 至少导出：

```js
normalizeTag(value) -> string
normalizeTags(values, limits?) -> string[]
filterByTags(txns, selected, mode) -> txn[]
aggregateByTag(txns, opts) -> { [tag]: { sum, count } }
renameTag(txns, settings, from, to) -> newStateParts
deleteTag(txns, settings, tag) -> newStateParts
```

纯函数不得直接改入参数。重命名和删除需要一次性更新交易与标签目录，并在成功后只调用一次 `save()`。

### 4.3 验收

- 中英文、空白、重复、大小写、上限和 CSV 特殊字符均有测试。
- 退款、报销、已映射交易的标签统计遵循 `Core.visibleTxns` 和现有净额口径。
- 删除标签不删除交易；旧备份恢复后所有交易可见。

## 5. WP4.2 信用/负债账户与还款语义

### 5.1 核心会计约定

沿用现有交易模型，不新增“还款”交易类型：

- 信用卡/花呗消费：`type=expense`，`account=<负债账户>`。这笔钱计真实支出。
- 银行卡还信用卡：`type=transfer`，`account=<资产账户>`，`accountTo=<负债账户>`。这笔钱不计收支。
- 退款回信用卡：仍是退款收入记录并通过 `refundOf` 关联原支出；账户资金位置按实际流向变化。
- 负债账户内部原始余额采用“资产头寸”符号：欠款为负、溢缴为正。用户输入“初始欠款 ¥1,000”时存为 `initialBalance=-100000`。

这样可复用现有 `accountBalance`：消费会让余额更负，还款转入会让余额靠近零。UI 不直接显示负号，而调用负债展示函数。

### 5.2 核心接口

`liability.js` 至少导出：

```js
accountPosition(account, txns) -> {
  raw,              // 现有 accountBalance 结果
  debt,             // max(0, -raw)
  overpayment,      // max(0, raw)
  availableCredit   // creditLimit 可用时返回 max(0, creditLimit-debt)
}
validateLiabilityAccount(account) -> { ok, errors }
statementWindow(year, month, statementDay) -> { from, to }
nextDueDate(baseDate, dueDay) -> 'YYYY-MM-DD'
```

首页资产汇总必须区分：资产余额、负债总额、净资产 = 所有账户 `raw` 之和。不得把负债账户欠款作为正资产相加。

### 5.3 导入与自动识别

- 账户映射允许把“招商银行信用卡(1234)”“花呗”等支付方式映射到负债账户。
- `TRANSFER_RE` 识别还款仍只生成转账候选；只有明确的付款资产账户与收款负债账户都存在时才组成完整转账。
- 不凭“信用卡还款”文本猜金额方向；方向不明继续让用户确认。
- 去重规则保持候选唯一和渠道痕迹约束，不能因负债账户而放宽。

### 5.4 验收样例

固定场景：初始信用卡欠款 ¥1,000；刷卡消费 ¥200；银行卡还款 ¥600；刷卡消费退款 ¥50。逐笔核对：真实支出净额 ¥150、还款不计收支、卡欠款从 ¥1,000 变为 ¥550、银行卡余额减少 ¥600。再覆盖全额还款、超额还款、退款跨月、删除/恢复负债账户。

## 6. WP4.3 粘贴文本快速记账

### 6.1 产品入口

在“记一笔”增加“粘贴识别”入口：用户主动粘贴文本或点击“读取剪贴板”。不后台监听剪贴板，不在页面加载时申请权限。识别结果必须进入普通记账确认页，用户确认后才保存。

首版支持明确、可解释的规则，不使用 LLM：

```text
午饭 25.8 招行
支出 25.80 午饭 #餐饮 #出差
工资 +10000 招行 #九月
转账 500 招行 到 支付宝
2026-09-05 瑞幸 18.5 微信
```

解析优先级：日期 → 显式类型/正负号 → 金额 → “从/到”账户 → `#标签` → 分类/账户别名 → 剩余文本作为商户或备注。若出现多个金额、方向冲突、账户歧义或无法确定类型，返回候选与警告，不自动保存。

### 6.2 核心接口

`quick-entry.js` 至少导出：

```js
tokenizeQuickEntry(text) -> token[]
parseQuickEntry(text, { accounts, categories, today }) -> {
  draft, confidence, warnings, unresolved
}
formatQuickEntryPreview(result) -> displayModel
```

`draft` 复用现有 `state.addDraft` 字段，不创建第二套交易模型。账户/分类命中调用既有别名和关键词逻辑；金额仍通过 `Core.yuanToCents`。

### 6.3 PWA 分享扩展

Web Share Target 作为渐进增强，不是本工作包发布门槛。只有在 Chrome/Android 与现有静态服务器上完成 POST、离线、SW 升级和隐私验证后，才在 `manifest.webmanifest` 增加 `share_target`。Safari/iOS 不支持时保留粘贴入口，不做 UA 欺骗。

### 6.4 验收

- 至少 30 条规则 fixture，覆盖中英文标点、负数、两位小数、日期、别名、未知词、歧义、恶意超长文本。
- 低置信结果绝不直接写入；取消确认不产生交易。
- 剪贴板权限拒绝时显示手动粘贴入口，不影响普通记账。
- 解析过程完全本地，Network 面板无外域请求。

## 7. WP4.4 WebAuthn 生物识别解锁

### 7.1 安全边界

WebAuthn 的普通认证断言只能证明“用户完成了平台验证”，本身不能直接解密 AES-GCM 数据。禁止把普通 `navigator.credentials.get()` 成功后直接视为获得现有密码密钥，这会形成安全假象。

仅在浏览器支持 WebAuthn PRF 扩展且运行于安全上下文时提供生物识别解锁。密码解锁永远保留为恢复通道；PRF 不支持时隐藏启用按钮并说明原因。

### 7.2 锁格式 v2：信封加密

迁移为随机数据密钥（DEK）加密交易，密码和 WebAuthn 各自只包装 DEK：

```js
settings.lock = {
  enabled: true,
  version: 2,
  passwordWrap: { kdf, iter, salt, iv, data },
  passkeyWrap?: { credentialId, prfSalt, iv, data }
}

txns = { enc: 2, alg: 'AES-GCM', iv, data }
```

流程：

1. 开启/迁移锁：生成随机 256-bit DEK；用 DEK 加密交易。
2. 密码路径：PBKDF2 派生 KEK，用 KEK 加密 DEK，存入 `passwordWrap`。
3. Passkey 路径：注册 discoverable platform credential；由 PRF 输出经 HKDF 派生 KEK，再包装同一 DEK。
4. 解锁后 DEK 只驻留内存；页面隐藏/超时可按产品设置清除内存。
5. 删除生物识别只删除 `passkeyWrap`，不重加密交易；改密码只重包 DEK。

从 v1 迁移：必须先用旧密码成功解密交易，再建立 v2 DEK 和双包装；任何一步失败均保留 v1 数据。迁移提交后立刻执行读回验证，再删除旧密文。

### 7.3 风险控制

- `credentialId` 不是秘密，可以存储；PRF 输出、DEK、密码不得写日志或落盘明文。
- `rpId`/origin 改变会使凭据不可用，因此 localhost 端口、正式域名和安装态要单独验证。
- 设备删除凭据、浏览器重装或不支持 PRF 时回退密码。
- 不实现仅靠本地布尔值绕过的“生物识别锁”。
- 若 PRF 跨目标浏览器兼容性不足，把功能保留为实验开关，不阻塞其余 V2.4 发布。

### 7.4 验收

- v1 密码锁到 v2 信封加密迁移无损，旧密码仍可解锁。
- 正确 Passkey 可解锁；取消、失败、换设备均不泄露数据并能回退密码。
- 删除 Passkey 后密码路径正常；改密码后旧密码失败、新密码成功。
- IndexedDB 中不出现交易明文、DEK、密码或 PRF 输出。
- 只在真实支持设备上将功能标记为通过；模拟器通过不能代替真机。

## 8. 集成与发布门禁

每完成一个工作包都运行原有全套测试，并增加浏览器验收。最终必须满足：

| 范围 | 门槛 |
|---|---|
| 兼容 | v1/v2 明文与加密状态、v1/v2 备份均可按规则迁移；未来版本拒绝 |
| 财务 | 负债消费计支出、还款不计收支、退款/报销/去重不回归 |
| 标签 | CRUD、筛选、汇总、CSV/JSON 往返无损 |
| 快记 | 歧义不落盘，明确文本填充普通表单，零外联 |
| 安全 | WebAuthn 仅 PRF 可用时启用，密码恢复路径始终存在 |
| PWA | 新脚本全部入缓存，旧 SW 升级正常，离线可用 |
| 文档 | README/STATUS/TEST/CHANGELOG 与版本一致 |

建议每个工作包一个 feature commit 和一个 test/docs commit。所有工作包合并后使用 RC（如 `v2.4.0-rc.1`）执行第三阶段同等级的发布检查，再发布 `v2.4.0`。

## 9. 回滚策略

- 功能回滚：关闭对应 `featureFlags`，但不能删除已写入的新字段。
- Schema 回滚：应用代码可以回退，数据不能降级覆盖；旧客户端遇到 Schema 2 应明确拒绝并提示使用新版。
- Passkey 回滚：移除 `passkeyWrap`，保留 `passwordWrap` 和现有 DEK 密文。
- 负债账户回滚：保留账户与交易，只隐藏增强视图会造成误解，因此必须先迁回普通账户或保持只读展示，不能直接改类型。

## 10. 决策门与 Agent 启动提示

开始实现前请用户确认四项能力是全部做，还是按工作包逐项启用。默认建议先交付标签、负债账户和粘贴记账；WebAuthn 以兼容性探针结果决定是否进入正式范围。

```text
你负责小账本第四阶段 V2.4 可选增强。
项目目录：/Users/jing/Desktop/some_code/account/ledger
先读 STATUS.md、TEST.md、docs/stages/README.md 和
docs/stages/04-v2.4-enhancements/IMPLEMENTATION.md。
确认第三阶段 v2.0.0 已发布，并向用户确认本次领取的 WP4.x。
严格按 WP4.0 Schema 迁移基础先行，再实现所领取功能。
测试只使用虚构数据，保持 Web 运行时零依赖、零外联。
WebAuthn 不得做成只校验本地布尔值的安全假象；PRF 不支持时必须安全降级。
完成后报告迁移兼容性、测试证据、浏览器支持范围、风险和 commit hash。
```
