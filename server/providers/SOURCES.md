# 行情与汇率数据源证据档

> 建立日期：2026-09-15（Phase 4A 验收补口）
> 用途：为 `DECISIONS.md` D-036（汇率源）与 D-038（行情源启用门禁）提供**可复现**的探测证据。
> 规则：本档只记录「实测结果」与「官方文档原文」，不写推测。任何未实测的能力都必须标注为"未验证"。
> 注意：本档的探测是**一次性人工取证**，不属于自动测试；自动测试一律离线（AGENTS.md 测试门禁）。

## 0. 探测环境与复现方式

- 日期：2026-09-15，macOS，本机直连（无代理、`curl` 默认 User-Agent）。
- 复现：直接执行下面各节给出的 `curl` 命令即可；输出中的 `HTTP=` / `type=` / `size=` 由 `curl -w` 输出。
- 探测代码均为公开代码（`voo.us`、`0700.HK`、`510300.SS`、`USD/CNY`），不含任何账户、持仓或余额信息。

## 1. 汇率：Frankfurter（选定，D-036）

### 1.1 实测

```bash
# 默认端点（多来源混合）
curl -sS -o /tmp/p_f_default.json -w "HTTP=%{http_code} type=%{content_type}\n" \
  "https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY,HKD"
# → HTTP=200 type=application/json
# → [{"date":"2026-09-15","base":"USD","quote":"CNY","rate":6.708},
#    {"date":"2026-09-15","base":"USD","quote":"HKD","rate":7.8498}]

# provider-pin 端点（ECB 参考汇率）
curl -sS -o /tmp/p_f_ecb.json -w "HTTP=%{http_code} type=%{content_type}\n" \
  "https://api.frankfurter.dev/v2/providers/ecb/rates?base=USD&quotes=CNY,HKD"
# → HTTP=200 type=application/json
# → [{"date":"2026-09-15","base":"USD","quote":"CNY","rate":6.7115},
#    {"date":"2026-09-15","base":"USD","quote":"HKD","rate":7.8445}]
```

**关键差异（同一天、同一币对，值不同）：**

| 币对 | `/v2/rates`（默认） | `/v2/providers/ecb/rates` | 差 |
|---|---|---|---|
| USD/CNY | 6.708 | 6.7115 | −0.0035 |
| USD/HKD | 7.8498 | 7.8445 | +0.0053 |

→ **结论：v2 默认端点是多来源混合值。产品口径要求 ECB 参考汇率，因此必须固定使用 `/v2/providers/ecb/...`，不得使用默认端点。**

### 1.2 官方文档（原文引用）

- 文档入口：`https://frankfurter.dev`
- provider-pin 章节：`https://frankfurter.dev/#rates-by-provider`
  - ECB 端点：`https://api.frankfurter.dev/v2/providers/ecb/rates`
  - ECB 单币对端点：`https://api.frankfurter.dev/v2/providers/ecb/rate/eur/usd`
- 提供商列表：`https://api.frankfurter.dev/v2/providers`（单提供商详情 `/v2/providers/ecb`）
- 错误码章节：`https://frankfurter.dev/#errors`
- 自托管：`https://frankfurter.dev/deploy/`
- 项目仓库：`https://github.com/lineofflight/frankfurter`

| 项目 | 官方说明（原文） |
|---|---|
| 认证 | "The public API lives at api.frankfurter.dev. It requires no API key." → **无 key** |
| 限额 | "There are no quotas. Requests are rate-limited to prevent abuse, but there are no monthly or daily caps. For high-volume use, consider caching responses, self-hosting, or querying the datasets directly." → **无配额，仅防滥用限流** |
| 商用 | "Is the API free for commercial use? Yes, absolutely. See each provider's terms for details on the underlying data." |
| 自托管 | "The project is open source, so you can also self-host for full control." |
| 覆盖 | 站点概览："tracks daily exchange rates from 98 central banks and official sources, covering 205 currencies back to 1948." |

**⚠️ 关于"多少个币种"：不要写固定数字。**
- 站点概览的 205 种 / 98 家是 **v2 全量**（跨 provider 合并）的规模，不是 ECB 子集。
- 本次实测 `GET /v2/providers/ecb/currencies` → **HTTP 404** `{"status":404,"message":"not found"}`，即 ECB 子集没有可查询的计数端点。
- 因此 4A 初稿 D-036 里的"覆盖 33 种 ECB 篮子货币"**无法复核且已与官方页面不一致** → 已在 D-036 中删除固定数量，只保留"ECB 官方参考汇率篮子，含 CNY/HKD/USD"。

### 1.3 失败语义（映射到契约五类错误）

| 上游表现 | 契约错误码 |
|---|---|
| 连接超时 / 无响应 | `timeout` |
| HTTP 429 或限流响应 | `rate_limit` |
| 非交易日无新数据（`date` 为更早的交易日） | **不是错误**：按 `date` 作为 `rateDate` 落库（D-007 接受最近有效交易日） |
| HTTP 404 / 未知币种 | `not_found` |
| HTTP 200 但 JSON 无法解析、缺 `date/base/quote/rate`、`rate <= 0` | `invalid_payload` |
| HTTP 401 / 403 | `auth` |

## 2. 行情：Stooq（**实测不可用，已否决**）

```bash
curl -sS -m 15 -o /tmp/p_stooq_l.txt -w "HTTP=%{http_code} type=%{content_type} size=%{size_download}\n" \
  "https://stooq.com/q/l/?s=voo.us&f=sd2t2ohlcv&h&e=csv"
# → HTTP=404 type=text/html size=271
# → <meta charset=utf-8><title>Stooq</title>...The page you requested does not exist<br>or has been moved

curl -sS -m 15 -o /tmp/p_stooq_d.txt -w "HTTP=%{http_code} type=%{content_type} size=%{size_download}\n" \
  "https://stooq.com/q/d/l/?s=voo.us&i=d"
# → HTTP=200 type=text/html; charset=utf-8 size=796
# → <!DOCTYPE html><html>...<noscript>This site requires JavaScript to verify your browser.</noscript>
#    <script nonce="MFoE1Z4BROcCNO_duOBt8w">(async()=>{const c="AAAAAGqpWnyRzRoKTEo4 ...

curl -sS -m 15 -o /tmp/p_sp.txt -w "HTTP=%{http_code} type=%{content_type} size=%{size_download}\n" \
  "https://stooq.pl/q/l/?s=voo.us&f=sd2t2ohlcv&h&e=csv"
# → HTTP=404 type=text/html size=279
```

**结论（三条硬证据）：**
1. `/q/l/` 单标的 CSV 路径在 `.com` 与 `.pl` 都是 **404**；
2. `/q/d/l/` 日线 CSV 路径返回 **HTML + JS 浏览器验证挑战**，**不返回 CSV** —— Node 服务无法在没有浏览器执行环境的情况下取得数据；
3. 官方站点没有给出可复核的 **API 版本、调用限额、自动化使用授权与稳定性承诺**，也无法证明 `0700.HK` / `510300.SS` 可通过自动接口获取。

→ Stooq **不满足** Phase 4A 的冻结标准，已在 D-036 修订中移除。

## 3. 行情：Yahoo Finance chart（**实测不可用，已否决**）

```bash
curl -sS -m 15 -H "User-Agent: Mozilla/5.0" \
  "https://query1.finance.yahoo.com/v8/finance/chart/VOO?range=5d&interval=1d"
# → HTTP=403 type=text/html size=3369（Yahoo "sad panda" 错误页）

# 同样 403：.../chart/0700.HK?range=5d&interval=1d 与 .../chart/510300.SS?range=5d&interval=1d
```

**结论：** 覆盖面最全，但既非官方 API，当前又被反爬直接拒绝（403）。与产品「稳定优先、失败必须可见」的口径冲突，不作为主源。

## 4. 行情：Twelve Data（**参考数据可用 → 用作 D-037 元数据候选源；日终行情免费层不覆盖 A/H**）

### 4.1 实测

```bash
# 日线（demo key，仅体验用）
curl -sS -m 15 "https://api.twelvedata.com/time_series?symbol=AAPL&interval=1day&outputsize=3&apikey=demo"
# → HTTP=200，含 meta.{symbol,interval,currency,exchange,mic_code,type} 与 values[{datetime,open,high,low,close,volume}]

# 标的检索（港股）
curl -sS -m 20 "https://api.twelvedata.com/symbol_search?symbol=2800&exchange=HKEX&apikey=demo"
# → HTTP=200 {"data":[{"symbol":"2800","instrument_name":"Tracker Fund of Hong Kong",
#    "exchange":"HKEX","mic_code":"XHKG","exchange_timezone":"Asia/Hong_Kong",
#    "instrument_type":"ETF","country":"Hong Kong","currency":"HKD"}, ...]}

# 标的检索（A 股 ETF）
curl -sS -m 20 "https://api.twelvedata.com/symbol_search?symbol=510300&exchange=SSE&apikey=demo"
# → HTTP=200 {"data":[{"symbol":"510300","instrument_name":"Huatai-PB CSI 300 ETF",
#    "exchange":"SSE","mic_code":"XSHG","exchange_timezone":"Asia/Shanghai",
#    "instrument_type":"ETF","country":"China","currency":"CNY"}],"status":"ok"}

# 港股日线（demo key 受限）
curl -sS -m 20 "https://api.twelvedata.com/time_series?symbol=0700.HK&interval=1day&outputsize=2&apikey=demo"
# → HTTP=401 {"code":401,"message":"The 'demo' API key is only used for initial familiarity..."}
```

### 4.2 官方条款与限额

- 定价与限额：`https://twelvedata.com/pricing`（2026-09-15 抓取）

| 套餐 | 价格 | credits | 每日上限 | 市场数 | 关键能力 |
|---|---|---|---|---|---|
| Basic | 免费 | 8/分 | 800/天 | **3** | 实时美股股票与 ETF、实时外汇、实时加密、**参考数据**、技术指标、批量请求、**Global trial symbols** |
| Grow | $29/月起 | 55+/分 | 无限制 | 27 | 以上 + **EOD global equities and ETFs market data**、实时美股、商品、基本面 |
| Pro | $99/月起 | 610+/分 | 无限制 | 76 | 以上 + 实时欧股、延时澳股、固收、基金 NAV、数据插件 |
| Ultra | $329/月起 | 2,584+/分 | 无限制 | 85 | 以上 + All markets、内部非展示数据、基金指标 |

- 使用条款：`https://twelvedata.com/terms`
  - §2.2 Data license：数据仅授权 **Internal Use**；对外再分发需另购 Redistribution Rights Add-on。
  - §2.3 (l)：**禁止** 将 Free Tier 数据用于商业用途。
  - §2.3 (g)：不得超出文档允许的时限缓存数据。
- 接口文档：`https://twelvedata.com/docs`

### 4.3 判断

| 能力 | 结论 | 依据 |
|---|---|---|
| 元数据 / 标的检索（`/symbol_search`） | ✅ **可用**：实测返回 HKEX / SSE 的 ETF 名称、币种、交易所、MIC、`instrument_type` | 4.1 实测 + Basic 套餐明确包含"参考数据" |
| A/H 日终行情（`/time_series`） | ❌ **免费层不覆盖**：Basic 仅 3 个市场 + "Global trial symbols"；EOD global equities and ETFs 属 Grow（$29/月） | 定价页对比 |
| 认证方式 | `apikey` 查询参数（4D 由 macOS Keychain 提供） | 文档 |
| 失败语义 | 401 → `auth`；429 → `rate_limit`；`code:404` → `not_found`；`status:"error"` 且原因非上述 → `invalid_payload` | 4.1 实测 + 文档 |

→ **元数据用途采用（D-037）；日终行情不作为免费主源**（免费层不覆盖 A/H，付费层属"需用户决策的成本项"，见 D-038）。

## 5. 行情：Alpha Vantage（备选，未采用）

```bash
curl -sS -m 15 -o /tmp/p_av.json -w "HTTP=%{http_code} type=%{content_type} size=%{size_download}\n" \
  "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=IBM&apikey=demo"
# → HTTP=200 type=application/json size=21309
# → {"Meta Data":{"2. Symbol":"IBM","3. Last Refreshed":"2026-09-14",...},"Time Series (Daily)":{...}}
```

- 免费层 25 请求/天，覆盖以美股为主，港股 / A 股日终覆盖不可靠。
- **未采用**：限额过紧且 A/H 覆盖不足；未做进一步购买评估（避免在此阶段引入订阅）。

## 6. 行情：腾讯 / 东方财富公开行情端点（**实测可达，但无官方条款 → 不冻结为主源**）

```bash
curl -sS -m 15 "https://qt.gtimg.cn/q=sh510300,hk00700,usVOO"
# → HTTP=200 type=text/html; charset=GBK，一次返回 A 股 / 港股 / 美股三条记录
#   含日期字段：A 股 "20260915161443"，港股 "2026/09/15 16:08:34"

curl -sS -m 15 "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh510300,day,,,5,qfq"
# → HTTP=200 JSON，返回日线数组：["2026-09-15","4.54","4.52","4.57","4.52","697..."]

curl -sS -m 15 "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.510300&fields1=f1,f2,f3&fields2=f51,f52,f53&klt=101&fqt=1&end=20500101&lmt=3"
# → HTTP=200 {"data":{"code":"510300","name":"沪深300ETF华泰柏瑞",
#    "klines":["2026-09-11,4.592,4.579","2026-09-14,4.551,4.552","2026-09-15,4.541,4.523"]}}
```

| 维度 | 观察 |
|---|---|
| 覆盖 | A 股 / 港股 / 美股，**实测全部可达** |
| 认证 | 无 key |
| 限额 | 未公开 |
| 官方条款 / 自动化授权 | **未公开**（无 API 文档、无 ToS、无 SLA、无速率承诺） |
| 编码 | 腾讯 `qt.gtimg.cn` 为 **GBK**；K 线端点为 UTF-8 |
| 稳定性承诺 | **无** |

→ **不满足** 4A 的冻结标准（缺官方条款、限额、授权与稳定性承诺）。仅作为"需用户显式接受非官方风险的降级通道"候选记录，**不写入 D-036 作为已冻结主源**。

## 7. 汇总判断（Phase 4A 补口结论）

| 候选 | 覆盖 A/H/US ETF 日终 | 免费 | 无 key | 有官方条款 / 限额 / 授权 | 结论 |
|---|---|---|---|---|---|
| Frankfurter（pin ECB） | 汇率 ✅ | ✅ | ✅ | ✅ | **选定（D-036，仅汇率）** |
| Stooq | 未证实 | ✅ | ✅ | ❌（且接口实测失效） | **否决** |
| Yahoo chart | 是 | ✅ | ✅ | ❌（且实测 403） | **否决** |
| Twelve Data Basic | ❌（仅 3 市场） | ✅ | ❌ 需 key | ✅ | 仅元数据采用（D-037） |
| Twelve Data Grow | 是 | ❌（$29/月） | ❌ 需 key | ✅ | **需用户决策的成本项**（D-038 门禁内） |
| Alpha Vantage | ❌ | 限额过紧 | ❌ 需 key | ✅ | 未采用 |
| 腾讯 / 东方财富 | 是 | ✅ | ✅ | ❌ | 不冻结；仅记为降级通道候选 |

**核心结论：** 截至 2026-09-15，**"免费 + 无 key + 有官方条款 + 覆盖 A/H/US ETF 日终"的行情源不存在**。
因此 D-036 的行情部分不冻结端点，改为冻结**启用门禁**（D-038）；门禁未通过前，自动抓取默认关闭，行情以**手动补价 + 本地缓存**为唯一事实来源。

## 8. 行情门禁复核（Phase 4D 开工前，2026-09-17）

> 复核目的：D-038 规定 4D 接入任何自动行情源前必须逐条满足六条门禁。本节是 **4D 开工前的强制复测**，用于判定 4D 的行情侧是「启用自动抓取」还是「保持默认关闭」。
> 复现环境：macOS（本机），`curl -sS -m 20`，未带任何 API key（`demo` 字样者为候选方文档公开的体验 key）。**本节命令全部为人工取证，不属于自动测试**；`node --test` 仍保持零公网访问。

### 8.1 汇率：Frankfurter（固定 ECB 端点）—— 复核通过

```bash
curl -sS -o /tmp/fx1.json -w "HTTP=%{http_code} type=%{content_type} size=%{size_download}\n" \
  "https://api.frankfurter.dev/v2/providers/ecb/rates?base=USD&quotes=CNY,HKD"
# → HTTP=200 type=application/json; charset=utf-8 size=127
# → [{"date":"2026-09-16","base":"USD","quote":"CNY","rate":6.7071},
#    {"date":"2026-09-16","base":"USD","quote":"HKD","rate":7.8449}]

curl -sS -o /tmp/fx2.json -w "HTTP=%{http_code} type=%{content_type} size=%{size_download}\n" \
  "https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY,HKD"
# → HTTP=200 type=application/json; charset=utf-8 size=127
# → [{"date":"2026-09-17","base":"USD","quote":"CNY","rate":6.7065},
#    {"date":"2026-09-17","base":"USD","quote":"HKD","rate":7.8519}]
```

- **再次印证 D-036 必须 pin provider 端点**：同一时刻，pin ECB 端点给出 `date=2026-09-16`（ECB 前一工作日参考汇率），默认端点给出 `date=2026-09-17` 且**数值不同**（USD/CNY 6.7071 vs 6.7065，USD/HKD 7.8449 vs 7.8519）。默认端点仍是多来源混合值，不满足"ECB 参考汇率"口径。
- 条款与限额：`https://frankfurter.dev/`（2026-09-17 抓取）—— 页面明示 **"No API key"**（无 key）、**"open source"**（开源可自托管）；免费、无 key、无需注册。
- 结论：**4D 汇率侧可直接接入自动更新**（唯一通过门禁的源，D-036）。

### 8.2 行情候选逐一复测（全部不通过）

```bash
# Stooq：单标的报价 CSV
curl -sS -m 20 "https://stooq.com/q/l/?s=voo.us&f=sd2t2ohlcv&h&e=csv"
# → HTTP=404 type=text/html size=271
# Stooq：日线 CSV
curl -sS -m 20 "https://stooq.com/q/d/l/?s=voo.us&i=d"
# → HTTP=200 type=text/html; charset=utf-8 size=796
#   （仍是 "This site requires JavaScript to verify your browser." 挑战页，非 CSV）

# Yahoo chart
curl -sS -m 20 "https://query1.finance.yahoo.com/v8/finance/chart/VOO?range=5d&interval=1d"
# → HTTP=429 type=text/html size=23

# Twelve Data：港股日线（文档公开的 demo key）
curl -sS -m 20 "https://api.twelvedata.com/time_series?symbol=2800&exchange=HKEX&interval=1day&outputsize=2&apikey=demo"
# → HTTP=401 type=application/json; charset=utf-8 size=298

# Alpha Vantage（demo key，仅美股）
curl -sS -m 20 "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=IBM&apikey=demo"
# → HTTP=200 type=application/json size=21307（仍可用，但 A/H 覆盖与限额见 §5）

# Financial Modeling Prep
curl -sS -m 20 "https://financialmodelingprep.com/api/v3/quote-share?symbol=VOO&apikey=demo"
# → HTTP=401 type=application/json; charset=utf-8 size=184

# EODHD
curl -sS -m 20 "https://eodhd.com/api/eod/VOO.US?api_token=demo&fmt=json"
# → HTTP=403 type=text/html; charset=utf-8 size=9

# Polygon.io（无 key）
curl -sS -m 20 "https://api.polygon.io/v2/aggs/ticker/VOO/prev?apiKey="
# → HTTP=401 type=application/json size=101

# Finnhub（demo token）
curl -sS -m 20 "https://finnhub.io/api/v1/quote?symbol=AAPL&token=demo"
# → HTTP=401 type=application/json; charset=utf-8 size=28
```

与 2026-09-15 相比的变化：Yahoo 由 `403` 变为 `429`（同样不可用）；其余候选结论不变。**新增复测的 FMP / EODHD / Polygon / Finnhub 四家在不携带真实 key 时全部 401/403，且均为「需 key + A/H 日终属付费层或覆盖不足」的同一形态。**

### 8.3 降级通道候选（腾讯 / 东方财富）—— 仍可达，仍不冻结

```bash
curl -sS -m 20 "https://qt.gtimg.cn/q=sh510300,hk00700,usVOO"
# → HTTP=200 type=text/html; charset=GBK size=1304
# → v_sh510300="1~沪深300ETF华泰柏瑞~510300~4.532~4.550~4.539~...~20260917161444~-0.018~-0.40~..."

curl -sS -m 20 "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.510300&fields1=f1,f2,f3&fields2=f51,f52,f53&klt=101&fqt=1&end=20500101&lmt=3"
# → HTTP=200 type=application/json; charset=UTF-8 size=226
# → {"rc":0,...,"data":{"code":"510300","name":"沪深300ETF华泰柏瑞",
#    "klines":["2026-09-15,4.541,4.523","2026-09-16,4.522,4.550","2026-09-17,4.539,4.532"]}}
```

- 覆盖（A 股 / 港股 / 美股）、无 key、可返回当日与历史日线 —— 实测仍全部可达，**但依赖"无文档、无 ToS、无限额、无 SLA"的公开端点**。
- 结论不变：**不满足 D-038 门禁，不得作为已确认主源**；仅保留为"需用户显式接受非官方风险"的降级通道候选（4D 未启用，D-044）。

### 8.4 六条门禁逐条对照（2026-09-17 复测结论）

| 候选 | ①官方条款含自动化授权 | ②API 版本与文档 | ③限额 | ④认证方式 | ⑤市场覆盖声明（A/H/US ETF 日终） | ⑥失败语义映射 | 是否通过 |
|---|---|---|---|---|---|---|---|
| Frankfurter（pin ECB） | ✅（`frankfurter.dev`） | ✅ `/v2/providers/ecb/rates` | ✅ 无配额（仅防滥用） | ✅ 无 key | 不适用（汇率） | ✅ §1.3 | **✅ 仅汇率** |
| Stooq | ❌ | ❌ | ❌ | — | ❌（接口实测失效） | ❌ | ❌ |
| Yahoo chart | ❌ | ❌（非公开 API） | ❌ | ❌ | ❌（429） | ❌ | ❌ |
| Twelve Data Basic | ✅ | ✅ | ✅ 8/分、800/天 | ✅ apikey | ❌ 仅 3 市场（A/H 属 Grow $29/月） | ✅ | ❌ |
| Alpha Vantage | ✅ | ✅ | ⚠️ 25/天 | ✅ apikey | ❌ 以美股为主 | ✅ | ❌ |
| FMP / EODHD / Polygon / Finnhub | 部分 ✅ | ✅ | 各不同 | ✅ apikey | ❌（免费层不含 A/H 日终） | 未逐一取证 | ❌ |
| 腾讯 / 东方财富 | ❌ 无 | ❌ 无 | ❌ 未公开 | ✅ 无 key | 是 | ❌ | ❌ |

**4D 门禁结论（2026-09-17）：仍无任何候选同时通过六条门禁。**
→ 因此 4D **不启用自动行情抓取**（产品内开关默认 `off`）；行情继续保持「手动补价 + 本地缓存」为唯一事实来源，未覆盖/失败标的走手动补价。
→ 4D **启用汇率自动更新**（Frankfurter pin ECB，D-036），并保留 Phase 3 的手动汇率登记兜底。
→ 若今后要启用自动抓取，必须先把本节 §8.1–§8.3 的证据补齐到某候选满足六条门禁，再以新决策条目替换 D-038 的对应结论；**不得以"免费能用就行"静默接入无条款端点**。
