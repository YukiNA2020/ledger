# 第五阶段实施方案：V3 微信小程序

> 目标版本：`v3.0.0`
> 技术路线：uni-app（Vue 3）编译到微信小程序，数据本地保存，通过 JSON 文件与 Web 版互通。
> 前置条件：V2.0 正式发布；V2.4 不是硬依赖。

## 1. 立项目标与硬边界

V3 的目标不是把 2,000 多行 `app.js` 原样翻译成 Vue，而是复用已经验证的财务核心和数据契约，在微信内提供高频记账、查看、导入、去重与文件搬迁能力。

硬边界：

- 不做登录、云数据库、云函数、服务器同步、广告、埋点或 uni 统计。
- 不读取通讯录、位置、相册等与记账无关的权限。
- 不接银行 API，不在后台抓取微信消息，不承诺“自动记账”。
- 浏览器和小程序不实时同步；唯一互通方式是用户主动导出/导入 JSON 文件。
- 发布/提审属于外部操作，必须由用户明确授权。开发 Agent 只能构建本地代码和测试包。

## 2. 开工前平台预检（必须先做）

平台规则和 API 会变化，实施 Agent 开工当天必须在官方文档重新核验并把日期、链接和结论写入 `miniapp/docs/PLATFORM_CHECK.md`：

1. 个人主体是否仍可选择记账/工具类目，是否需要备案、隐私指引或额外资质。
2. `uni.chooseFile` / `wx.chooseMessageFile`、FileSystemManager、文件分享/保存 API 的真机支持范围。
3. 本地 Storage、用户文件和单文件容量限制；不要把本文档中的设计目标误当成平台永久保证。
4. 主包/分包体积限制和基础库最低版本。
5. 小程序运行时的 Web Crypto / SubtleCrypto 能力。没有可靠、可审计的密码学实现时，不迁移 Web 版应用锁。

参考入口（2026-09-05 核验）：

- [uni-app 官方文档](https://uniapp.dcloud.net.cn/)
- [uni-app 文件选择 API](https://uniapp.dcloud.net.cn/api/media/file)
- [uni-app Storage API](https://uniapp.dcloud.net.cn/api/storage/storage.html)
- [uni-app 页面与分包配置](https://uniapp.dcloud.net.cn/collocation/pages)
- [微信开放文档：小程序](https://developers.weixin.qq.com/miniprogram/dev/framework/)

若预检发现个人主体不能发布目标类目，阶段输出改为“可在开发者工具/体验版自用的技术验证”，不得绕过平台规则。

## 3. 版本范围

### V3.0 必须实现

- 本地初始化、账户与分类管理。
- 手动支出/收入/转账、编辑、删除。
- 首页月度收支、账户余额、明细筛选和基础统计。
- 从微信会话选择 CSV/JSON 文件，解析微信、支付宝、招行/中行及通用银行 CSV。
- 同源幂等、跨源候选唯一/渠道痕迹一致的去重规则、人工确认和撤销。
- Web ↔ 小程序 JSON 备份互通。
- 全程本地存储，断网可完成除选择/分享外的核心记账。

### V3.0 可延后到 V3.1

- 预算、消费体检、订阅检测、退款、报销、周期记账、二级分类的完整 UI。
- V2.4 的负债账户、标签、粘贴记账。
- 生物识别或密码应用锁。

延后只影响 UI，不得丢弃导入 JSON 中暂不识别的字段。小程序必须“保留并再导出”未知兼容字段，或在无法保证时拒绝该 Schema。

## 4. 工程目录

在现有仓库新增独立工程，不改写 Web 根目录结构：

```text
miniapp/
├── package.json
├── manifest.json              # 微信配置；关闭 uniStatistics
├── pages.json
├── App.vue
├── main.js
├── src/
│   ├── pages/
│   │   ├── home/
│   │   ├── add/
│   │   ├── list/
│   │   ├── stats/
│   │   ├── import/
│   │   └── settings/
│   ├── components/
│   ├── domain/core.js         # 从 Web core 同步的兼容副本
│   ├── domain/core-adapter.js # 平台无关调用与返回值适配
│   ├── repository/
│   │   ├── ledger-repository.js
│   │   ├── storage-adapter.js
│   │   └── migration.js
│   ├── services/
│   │   ├── file-service.js
│   │   └── backup-service.js
│   └── store/ledger-store.js
├── scripts/sync-core.mjs
├── tests/
│   ├── core-parity.test.js
│   ├── repository.test.js
│   ├── backup-interop.test.js
│   └── fixtures/
└── docs/
    ├── PLATFORM_CHECK.md
    ├── PRIVACY_CHECKLIST.md
    └── RELEASE_CHECKLIST.md
```

采用 CLI 工程并锁定依赖版本，提交 lockfile。构建依赖只用于 `miniapp/`，不能被 Web 版运行时引用。默认使用原生 tabBar，避免无必要的自定义 tabBar性能成本。

## 5. WP5.0 共享核心与契约测试

### 5.1 复用策略

Web 版 `js/core.js` 继续作为当前财务规则的权威实现。`scripts/sync-core.mjs` 把它复制到 `miniapp/src/domain/core.js`，并写入源文件 SHA-256。禁止人工同时修改两份。

同步脚本完成三件事：

1. 复制字节内容，不做正则改写业务逻辑。
2. 生成 `core-version.json`，包含源提交、源哈希、Schema 版本。
3. 运行 Node parity tests；哈希不一致或核心 fixture 结果不同则构建失败。

`core-adapter.js` 只解决 UMD/CommonJS/ESM 导入和平台 API 差异，不复制解析、去重或聚合规则。若 uni-app 构建器无法安全打包 UMD，先写 ADR 比较“直接导入、构建时包装、核心迁移为双格式源文件”三种方案，再选改动最小者。

### 5.2 契约 fixture

复用根目录全部脱敏 CSV 和 `acceptance_backup.json`。Web 与小程序必须对同一输入产出一致的：

- 有效/错误行数。
- 交易金额、日期、方向、来源、账户和分类。
- 去重分组、自动合并、人工确认、转账配对。
- 月度收入、支出、结余和账户余额。
- 备份恢复后的 ID 与关联字段。

完成门槛：根目录 Node 测试仍全绿；miniapp parity tests 全绿；核心差异有逐字段报告。

## 6. WP5.1 本地 Repository 与原子保存

### 6.1 为什么不能直接复制 IndexedDB

小程序没有浏览器 IndexedDB。不要在页面里散落 `uni.getStorageSync`；所有持久化必须经过 `LedgerRepository`，上层只接收完整领域状态。

### 6.2 Repository 接口

```ts
interface LedgerRepository {
  open(): Promise<void>
  loadState(): Promise<LedgerState>
  saveState(state: LedgerState): Promise<void>
  clearAll(confirmToken: string): Promise<void>
  exportState(): Promise<Backup>
  importState(backup: Backup): Promise<ImportPreview>
  commitImport(previewId: string): Promise<void>
}
```

实现规则：

- 账户、分类、设置和索引存 Storage；交易按月份分块，如 `ledger:txns:2026-09`，避免单个超大 JSON。
- `ledger:manifest` 记录 Schema、月份块列表、每块记录数和校验摘要。
- 写入采用 staging key：先写新块并读回校验，再切换 manifest，最后清理旧块。应用中途退出时，下次启动可依据 manifest 恢复最后完整状态。
- 不在 Storage key、日志或错误上报中出现商户名、金额、备注等业务数据。
- 本地容量不足时保留旧状态，提示用户先导出备份；禁止清空后重试。

### 6.3 加密边界

V3.0 默认只承诺“小程序沙盒本地存储”，不虚构与 Web AES-GCM 等价的应用锁。预检若确认运行时存在可审计的安全密码学能力，另写 `SECURITY_ADR.md` 后实现；否则设置页明确显示“本版本暂不支持应用锁，敏感设备请使用 Web 版加密存储”。

加密 Web 备份的互通不在 V3.0 范围；当前 Web 的可迁移 JSON 备份是明文，应在选择文件和导出时醒目提示妥善保管。

### 6.4 验收

- 0、1、1,000、10,000、20,000 条虚构交易保存/冷启动恢复一致。
- 模拟保存中断后只能读到旧完整版本或新完整版本，不能读半套状态。
- 容量不足、JSON 损坏、未来 Schema 都不会覆盖原数据。
- 清空必须输入“清空”且只删除 `ledger:` 命名空间。

## 7. WP5.2 页面与核心记账闭环

### 7.1 页面映射

| Web 能力 | 小程序页面 | 实现要求 |
|---|---|---|
| 首页 | `pages/home` | 本月收支、结余、账户卡片、最近交易、记一笔入口 |
| 记一笔 | `pages/add` | 支出/收入/转账，金额、账户、分类、日期、商户/备注 |
| 明细 | `pages/list` | 月份、类型、账户、分类、关键词筛选；分页/虚拟化 |
| 统计 | `pages/stats` | 月度趋势、分类排行；图表可用 Canvas 或轻量本地实现 |
| 导入 | `pages/import` | 文件→预览→映射→去重确认→一次提交 |
| 设置 | `pages/settings` | 账户、分类、备份、恢复、清空、隐私说明 |

记账表单和交易模型必须复用领域类型；页面不能自行算余额和统计。页面切换时未提交草稿保存在内存 store，冷启动是否恢复草稿作为产品选项，不应把半条交易写入正式账本。

### 7.2 性能约束

- 首页只读当月和账户聚合所需块；明细按月分页，不在每次 tab 切换重新加载全量交易。
- 跨月统计可按月块读取并在内存聚合；缓存结果必须用交易块摘要失效。
- 导入和大统计显示明确进度并防重复点击；先保证结果一致，再优化耗时。

### 7.3 验收

用固定场景验证新增、编辑、删除、转账、补记、账户余额、月度汇总和筛选。结果与 Web 版对同一 fixture 完全一致，金额不得使用浮点存储。

## 8. WP5.3 文件导入与跨源去重

### 8.1 文件管线

微信端优先使用会话文件选择能力获取 CSV/JSON 临时路径，通过 FileSystemManager 读取 ArrayBuffer，再交给共享 `Core.decodeBytes` 和解析器。平台 API 只负责“拿到字节”，不得在 service 层重写 CSV 规则。

流程必须保持五步：

1. 选择单个文件并检查扩展名、大小和读取错误。
2. 只在内存解析，展示有效行、错误行、收支合计。
3. 确认类型、账户、转账目标和分类映射。
4. 展示自动合并、转账配对、需确认、独立记录四组结果。
5. 用户点击一次“确认导入”后原子提交；保存成功前可取消且不改变账本。

### 8.2 风险控制

- 微信分享文件可能只有临时路径；读取完成后不依赖该路径长期存在。
- GBK 支持需要真机验证 `TextDecoder` 能力。若运行时缺失，只允许引入体积可控、纯本地的解码实现，并把许可证收入 NOTICE；不得把文件上传到服务端转码。
- XLSX/PDF 继续不支持，提示用户转成 CSV。
- 去重规则与 Web v2.0 完全相同：无渠道痕迹或候选不唯一时不得自动合并。

### 8.3 验收

根目录的微信、支付宝、招行、中行、通用银行 fixture 全部真机/开发者工具走通；重复导入新增 0；组合账单汇总等于 `ACCEPTANCE.md`；导入中断和按钮双击不产生重复。

## 9. WP5.4 Web ↔ 小程序备份互通

### 9.1 互通契约

备份顶层至少包含：

```json
{
  "app": "ledger",
  "appVersion": "3.0.0",
  "schemaVersion": 1,
  "exportedAt": "ISO-8601",
  "accounts": [],
  "categories": [],
  "txns": [],
  "settings": {}
}
```

实际 `schemaVersion` 以第三/第四阶段正式值为准，示例不是要求倒退版本。两端使用同一迁移与校验规则；平台私有设置放在 `settings.platform` 下，另一端未知时原样保留或显式忽略并记录，不能污染财务字段。

### 9.2 导入采用预览 + 替换策略

V3.0 只实现“完整恢复替换”，不做两个账本自动合并。恢复前展示：来源版本、导出时间、账户/分类/交易数、覆盖警告；自动先生成当前小程序状态备份，用户再次确认后才替换。

未来如做合并，必须另立项设计 ID 冲突、关联字段和去重，不能把数组简单拼接。

### 9.3 双向验收

1. Web 生成备份 → 小程序恢复 → 核对 → 小程序再导出 → Web 恢复。
2. 小程序生成备份 → Web 恢复 → 核对 → Web 再导出 → 小程序恢复。
3. 两轮后忽略平台版本和导出时间，业务状态深比较一致。
4. 覆盖转账、映射关系、退款/报销关联、周期键、二级分类和未来可选字段。

## 10. WP5.5 隐私、真机与发布验收

### 10.1 隐私检查

- 构建配置关闭 uniStatistics 和所有云服务。
- 依赖清单逐项审计许可证、网络行为和权限；能不用依赖就不用。
- 开发者工具与真机抓包确认核心操作无业务数据外发。
- 隐私说明准确描述“数据保存在微信小程序本地沙盒；清理微信数据或卸载可能丢失，请定期导出”。
- 不申请与功能无关权限；文件选择只在用户主动操作时触发。

### 10.2 真机矩阵

至少覆盖一台近期 iOS 微信和一台 Android 微信：冷启动、前后台切换、断网记账、10k 明细、文件选择、GBK/UTF-8、JSON 往返、容量不足提示、异常退出恢复。开发者工具通过不能替代真机。

### 10.3 包体与分包

主包放首页、记账、明细、store、repository 和共享核心；统计、导入、设置可按平台最新限制放入分包。构建后记录主包/总包体积。任何超限修复优先删除无用资源和依赖，不删测试或核心校验。

### 10.4 发布门禁

- 根 Web 测试与 miniapp 测试均全绿。
- 核心 parity、双向备份、真机矩阵、隐私检查、包体检查全部通过。
- `PLATFORM_CHECK.md` 为当前日期结论，无未解决阻断项。
- README、STATUS、CHANGELOG 写清 Web 与小程序功能差异和应用锁限制。
- 用户明确授权后，才配置正式 AppID、上传体验版或提交审核。

## 11. 里程碑与提交策略

| 里程碑 | 输出 | 通过后才能进入 |
|---|---|---|
| `v3.0.0-alpha.1` | 工程、平台预检、core 同步、parity tests | Repository |
| `v3.0.0-alpha.2` | 原子本地存储、手动记账、账户分类、明细统计 | 文件导入 |
| `v3.0.0-alpha.3` | 多源 CSV、映射、去重、重复提交保护 | 互通 |
| `v3.0.0-beta.1` | 双向 JSON 互通、错误恢复 | 真机验收 |
| `v3.0.0-rc.1` | 真机、隐私、性能、包体全部通过 | 用户授权发布 |
| `v3.0.0` | 审核通过的正式版本 | 后续 V3.1 |

每个工作包至少一个实现提交和一个测试/文档提交。不要把生成产物、真实 AppID 密钥、私有配置、真实账单或开发者个人信息提交进仓库。

## 12. 主要风险与停止条件

| 风险 | 应对 | 停止条件 |
|---|---|---|
| 平台类目/备案变化 | 开工日查官方文档，必要时调整为体验版 | 不能合规发布且用户不接受体验版 |
| 本地容量不足 | 月份分块、原子 manifest、容量预警、JSON 备份 | 10k 基准无法可靠保存且无安全替代 |
| Core 双份漂移 | 同步脚本、哈希和契约测试 | 同一 fixture 出现无法解释的财务差异 |
| GBK 解码缺失 | 纯本地兼容层、许可证审计 | 只能通过云端转码才能实现 |
| 加密能力不足 | V3.0 明确不提供应用锁 | 方案需要弱加密或把密钥伪装存本地 |
| 文件导出受限 | 使用官方支持的用户文件/分享路径并真机验证 | 无法提供可靠备份恢复闭环 |

## 13. 可复制给实施 Agent 的启动提示

```text
你负责小账本第五阶段：V3 微信小程序。
项目目录：/Users/jing/Desktop/some_code/account/ledger
先读 STATUS.md、TEST.md、docs/stages/README.md 和
docs/stages/05-v3-miniapp/IMPLEMENTATION.md。
先完成 WP5.0 平台预检与 core parity，不要直接翻写 UI。
小程序代码放在独立 miniapp/，Web 版仍保持零构建、零运行时依赖。
所有账目只在本机/小程序沙盒处理，禁用云服务、统计和埋点，只用虚构 fixture。
Web 与小程序通过 JSON 文件互通，不实现云同步或数组直接拼接。
若平台缺少可靠密码学能力，不实现伪应用锁；明确保留该限制。
未经用户明确授权，不配置正式发布凭据、不上传体验版、不提交微信审核。
每个里程碑报告 parity、存储原子性、真机/工具测试、隐私检查、风险和 commit hash。
```
