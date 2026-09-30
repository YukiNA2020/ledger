"""G5-R4 真人四问计时 · 隔离演示账本准备脚本（绝不触碰私人账本）。

用法：python3 run_6e3_demo.py <端口> [--variant a|b] [--serve-only --answers-file <路径>]
  --variant a|b：两套互斥的演示数据（金额 / 池结构 / 风险暴露排序全部不同），复测必须换变体防背答案；
  --serve-only：播种后常驻（SIGTERM 停止并清理），答案表只写入 --answers-file，不在终端打印
  （供主测人后台启动后把浏览器交给受测者；作答完成前不要打开答案文件）。
  1. 启动 docs/evidence/phase5d-wiring-server.cjs 隔离服务（全新临时数据库，SIGTERM 自清理）；
  2. 写入完整的虚构演示事实链：多池资产 → 正式月结 → 风险评估 → 目标版本 → 认可标的
     → 正式建议（数据与 5E-6 / 宽度检查的 seed 同源，已证明能生成 formal 建议）；
  3. 用服务端 GET /overview、/targets/current、/recommendations 生成标准答案表
     （只打印给主测人，受测者不可见）；净资产、可投资资产、主要风险暴露、
     新增资金优先方向四个口径与 wiring 第 34 项「一分钟理解演练」完全同源；
  4. 服务保持运行：主测人打开 http://127.0.0.1:<端口>/ ，页面加载完成后开始计时；
     回车后停止服务并清理临时目录。

计时与判定规则见 docs/evidence/phase6/6e-r4.md（四题全对且总耗时 ≤60 秒才通过；
页面加载用时另记，不充当理解时间；不得用自动化 DOM 读值或 agent 自答代替真人）。
"""
import calendar
import json
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[3]  # ledger/
args = sys.argv[1:]
serve_only = '--serve-only' in args
answers_file = args[args.index('--answers-file') + 1] if '--answers-file' in args else None
variant = args[args.index('--variant') + 1] if '--variant' in args else 'a'
assert variant in ('a', 'b', 'c'), '--variant 只支持 a / b / c（多套互斥演示数据，防背答案）'
port = int(args[0])
base = f'http://127.0.0.1:{port}'
TOKEN = 'isolated-browser-verification-token'


def fmt(minor):
    if minor is None:
        return '不可判定'
    sign = '-' if minor < 0 else ''
    minor = abs(minor)
    return f'{sign}¥{minor // 100:,}.{minor % 100:02d}'


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Ledger-Token': TOKEN,
        'Origin': base,
    })
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read().decode())


server = subprocess.Popen(
    ['node', str(root / 'docs/evidence/phase5d-wiring-server.cjs'), str(port)],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)


def _stop(*_):
    # SIGTERM / SIGINT 转成 SystemExit，让 finally 里的子服务清理照常执行
    raise SystemExit(0)


if serve_only:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
try:
    info = json.loads(server.stdout.readline().strip())
    print('server:', json.dumps(info))
    deadline = time.time() + 15
    while True:
        try:
            urllib.request.urlopen(base + '/api/v1/health', timeout=1)
            break
        except Exception:
            if time.time() > deadline:
                raise SystemExit('health check timeout')
            time.sleep(0.3)

    today = time.strftime('%Y-%m-%d')
    month = today[:7]
    ty, tm = int(today[:4]), int(today[5:7])
    last_day = calendar.monthrange(ty, tm)[1]
    # 今天与本地月末都写入行情 / 汇率，保证当月正式口径（与宽度检查 seed 同源）
    dates = sorted({today, f'{ty}-{tm:02d}-{last_day:02d}'})

    # 变体 a（首轮口径）：固定收益最大、方向补宽基；变体 b：宽基最大、方向补固收——
    # 四个答案与变体 a 全部不同，防止重复测试变成背答案。
    if variant == 'a':
        a = {
            'assetAccounts': [
                {'id': 'r4-acc-cash', 'name': '投资现金户', 'kind': 'deposit', 'pool': 'investable', 'institution': '演示银行'},
                {'id': 'r4-acc-broker', 'name': '券商户', 'kind': 'broker', 'pool': 'investable', 'institution': '演示券商'},
                {'id': 'r4-acc-safe', 'name': '应急金', 'kind': 'deposit', 'pool': 'safety', 'institution': '演示银行'},
                {'id': 'r4-acc-card', 'name': '信用卡', 'kind': 'credit', 'pool': 'restricted', 'institution': '演示银行'},
            ],
            'assetUnits': [
                {'id': 'r4-u-cash', 'accountId': 'r4-acc-cash', 'currency': 'CNY', 'balanceMinor': 30000000, 'asOf': today, 'sourceType': 'manual'},
                {'id': 'r4-u-safe', 'accountId': 'r4-acc-safe', 'currency': 'CNY', 'balanceMinor': 20000000, 'asOf': today, 'sourceType': 'manual'},
            ],
            'liabilities': [
                {'id': 'r4-l-card', 'accountId': 'r4-acc-card', 'currency': 'CNY', 'balanceMinor': 5000000, 'asOf': today, 'sourceType': 'manual'},
            ],
            'instruments': [
                {'id': 'r4-ins-bond', 'symbol': 'R4BND', 'exchange': 'NASDAQ', 'currency': 'USD', 'name': '演示债基', 'instrumentType': 'etf', 'assetClass': 'fixed_income', 'exposureMarket': 'US', 'classificationStatus': 'confirmed'},
                {'id': 'r4-ins-voo', 'symbol': 'R4VOO', 'exchange': 'SSE', 'currency': 'CNY', 'name': '演示宽基', 'instrumentType': 'etf', 'assetClass': 'broad_equity', 'exposureMarket': 'CN', 'classificationStatus': 'confirmed'},
                {'id': 'r4-ins-thm', 'symbol': 'R4THM', 'exchange': 'SSE', 'currency': 'CNY', 'name': '演示主题', 'instrumentType': 'fund', 'assetClass': 'theme_equity', 'exposureMarket': 'CN', 'classificationStatus': 'confirmed'},
            ],
            'holdings': [
                {'id': 'r4-h-bond', 'accountId': 'r4-acc-broker', 'instrumentId': 'r4-ins-bond', 'quantity': '5000', 'costMinor': 5000000, 'asOf': today},
                {'id': 'r4-h-voo', 'accountId': 'r4-acc-broker', 'instrumentId': 'r4-ins-voo', 'quantity': '50000', 'costMinor': 5000000, 'asOf': today},
                {'id': 'r4-h-thm', 'accountId': 'r4-acc-broker', 'instrumentId': 'r4-ins-thm', 'quantity': '70000', 'costMinor': 7000000, 'asOf': today},
            ],
            'quotes': [], 'fxRates': [], 'securityEvents': [],
        }
        prices = [('r4-ins-bond', 1000, 'USD'), ('r4-ins-voo', 100, 'CNY'), ('r4-ins-thm', 100, 'CNY')]
        approved = [('broad_equity', ['r4-ins-voo'])]
    elif variant == 'b':
        a = {
            'assetAccounts': [
                {'id': 'r4b-acc-cash', 'name': '活期理财户', 'kind': 'deposit', 'pool': 'investable', 'institution': '演示银行'},
                {'id': 'r4b-acc-broker', 'name': '证券账户', 'kind': 'broker', 'pool': 'investable', 'institution': '演示券商'},
                {'id': 'r4b-acc-safe', 'name': '应急储备', 'kind': 'deposit', 'pool': 'safety', 'institution': '演示银行'},
                {'id': 'r4b-acc-card', 'name': '消费信贷', 'kind': 'credit', 'pool': 'restricted', 'institution': '演示银行'},
            ],
            'assetUnits': [
                {'id': 'r4b-u-cash', 'accountId': 'r4b-acc-cash', 'currency': 'CNY', 'balanceMinor': 15000000, 'asOf': today, 'sourceType': 'manual'},
                {'id': 'r4b-u-safe', 'accountId': 'r4b-acc-safe', 'currency': 'CNY', 'balanceMinor': 10000000, 'asOf': today, 'sourceType': 'manual'},
            ],
            'liabilities': [
                {'id': 'r4b-l-card', 'accountId': 'r4b-acc-card', 'currency': 'CNY', 'balanceMinor': 6000000, 'asOf': today, 'sourceType': 'manual'},
            ],
            'instruments': [
                {'id': 'r4b-ins-bond', 'symbol': 'R4BGBD', 'exchange': 'NASDAQ', 'currency': 'USD', 'name': '利率债ETF', 'instrumentType': 'etf', 'assetClass': 'fixed_income', 'exposureMarket': 'US', 'classificationStatus': 'confirmed'},
                {'id': 'r4b-ins-voo', 'symbol': 'R4BIDX', 'exchange': 'SSE', 'currency': 'CNY', 'name': '沪深宽基ETF', 'instrumentType': 'etf', 'assetClass': 'broad_equity', 'exposureMarket': 'CN', 'classificationStatus': 'confirmed'},
                {'id': 'r4b-ins-thm', 'symbol': 'R4BTOP', 'exchange': 'SSE', 'currency': 'CNY', 'name': '消费主题基金', 'instrumentType': 'fund', 'assetClass': 'theme_equity', 'exposureMarket': 'CN', 'classificationStatus': 'confirmed'},
            ],
            'holdings': [
                {'id': 'r4b-h-bond', 'accountId': 'r4b-acc-broker', 'instrumentId': 'r4b-ins-bond', 'quantity': '5000', 'costMinor': 7000000, 'asOf': today},
                {'id': 'r4b-h-voo', 'accountId': 'r4b-acc-broker', 'instrumentId': 'r4b-ins-voo', 'quantity': '4000', 'costMinor': 30000000, 'asOf': today},
                {'id': 'r4b-h-thm', 'accountId': 'r4b-acc-broker', 'instrumentId': 'r4b-ins-thm', 'quantity': '30000', 'costMinor': 3000000, 'asOf': today},
            ],
            'quotes': [], 'fxRates': [], 'securityEvents': [],
        }
        prices = [('r4b-ins-bond', 200, 'USD'), ('r4b-ins-voo', 8000, 'CNY'), ('r4b-ins-thm', 100, 'CNY')]
        approved = [('broad_equity', ['r4b-ins-voo']), ('fixed_income', ['r4b-ins-bond']),
                    ('theme_equity', ['r4b-ins-thm'])]
    else:
        # 变体 C（L3 目标：现金 1500~3500 / 固收 2000~4500 / 宽基 3000~5000 / 主题 500~2000）：
        # 现金 42% 超上限成为最大暴露；主题 3% 低于下限 → 方向补主题。四答案与 A / B 全不同。
        a = {
            'assetAccounts': [
                {'id': 'r4c-acc-cash', 'name': '货币现金户', 'kind': 'deposit', 'pool': 'investable', 'institution': '演示银行'},
                {'id': 'r4c-acc-broker', 'name': '基金账户', 'kind': 'broker', 'pool': 'investable', 'institution': '演示券商'},
                {'id': 'r4c-acc-safe', 'name': '安全垫账户', 'kind': 'deposit', 'pool': 'safety', 'institution': '演示银行'},
                {'id': 'r4c-acc-card', 'name': '车贷月供卡', 'kind': 'credit', 'pool': 'restricted', 'institution': '演示银行'},
            ],
            'assetUnits': [
                {'id': 'r4c-u-cash', 'accountId': 'r4c-acc-cash', 'currency': 'CNY', 'balanceMinor': 25200000, 'asOf': today, 'sourceType': 'manual'},
                {'id': 'r4c-u-safe', 'accountId': 'r4c-acc-safe', 'currency': 'CNY', 'balanceMinor': 18000000, 'asOf': today, 'sourceType': 'manual'},
            ],
            'liabilities': [
                {'id': 'r4c-l-card', 'accountId': 'r4c-acc-card', 'currency': 'CNY', 'balanceMinor': 7000000, 'asOf': today, 'sourceType': 'manual'},
            ],
            'instruments': [
                {'id': 'r4c-ins-bond', 'symbol': 'R4CZAI', 'exchange': 'SSE', 'currency': 'CNY', 'name': '短债基金', 'instrumentType': 'fund', 'assetClass': 'fixed_income', 'exposureMarket': 'CN', 'classificationStatus': 'confirmed'},
                {'id': 'r4c-ins-voo', 'symbol': 'R4CETF', 'exchange': 'SSE', 'currency': 'CNY', 'name': '指数宽基ETF', 'instrumentType': 'etf', 'assetClass': 'broad_equity', 'exposureMarket': 'CN', 'classificationStatus': 'confirmed'},
                {'id': 'r4c-ins-thm', 'symbol': 'R4CNEW', 'exchange': 'SSE', 'currency': 'CNY', 'name': '新能源主题', 'instrumentType': 'fund', 'assetClass': 'theme_equity', 'exposureMarket': 'CN', 'classificationStatus': 'confirmed'},
            ],
            'holdings': [
                {'id': 'r4c-h-bond', 'accountId': 'r4c-acc-broker', 'instrumentId': 'r4c-ins-bond', 'quantity': '13200', 'costMinor': 13200000, 'asOf': today},
                {'id': 'r4c-h-voo', 'accountId': 'r4c-acc-broker', 'instrumentId': 'r4c-ins-voo', 'quantity': '2200', 'costMinor': 19800000, 'asOf': today},
                {'id': 'r4c-h-thm', 'accountId': 'r4c-acc-broker', 'instrumentId': 'r4c-ins-thm', 'quantity': '18000', 'costMinor': 1800000, 'asOf': today},
            ],
            'quotes': [], 'fxRates': [], 'securityEvents': [],
        }
        prices = [('r4c-ins-bond', 1000, 'CNY'), ('r4c-ins-voo', 9000, 'CNY'), ('r4c-ins-thm', 100, 'CNY')]
        approved = [('broad_equity', ['r4c-ins-voo']), ('fixed_income', ['r4c-ins-bond']),
                    ('theme_equity', ['r4c-ins-thm'])]
    for ins, price, currency in prices:
        a['quotes'] += [{'instrumentId': ins, 'priceMinor': price, 'currency': currency, 'priceDate': d,
                         'provider': 'manual', 'status': 'ok'} for d in dates]
    a['fxRates'] = [{'base': 'USD', 'quote': 'CNY', 'rateDecimal': '7.0000', 'rateDate': d,
                     'provider': 'manual', 'status': 'ok'} for d in dates]

    state = call('GET', '/api/v1/state')
    st = state | {'accounts': [], 'categories': [], 'txns': [], 'settings': {}, 'assets': a,
                  'riskAssessments': [], 'allocationTargets': [], 'approvedInstruments': [],
                  'recommendations': [], 'decisions': [], 'decisionEvents': [], 'decisionLinks': []}
    call('PUT', '/api/v1/state', {'state': st})

    close = call('POST', '/api/v1/monthly-closes', {'month': month})
    assert close['close']['status'] == 'formal', '演示前置失败：月结未达正式口径'

    # 评估答案组合（能力 [1,1,1,2,2]，意愿 [2,2,1,1]）从冻结的领域常量生成，不在 Python 里复刻规则
    answers_json = subprocess.run(
        ['node', '-e', (
            'const D=require("./js/domain.js");'
            'const cap=D.RISK_QUESTIONS.filter(q=>q.kind==="capacity");'
            'const wil=D.RISK_QUESTIONS.filter(q=>q.kind==="willingness");'
            'const pick=(list,scores)=>list.map((q,i)=>({questionId:q.id,optionId:q.options.filter(o=>o.score===scores[i])[0].id}));'
            'console.log(JSON.stringify(pick(cap,[1,1,1,2,2]).concat(pick(wil,[2,2,1,1]))));'
        )],
        cwd=root, capture_output=True, text=True, check=True).stdout.strip()
    assessment = call('POST', '/api/v1/risk-assessments',
                      {'answers': json.loads(answers_json), 'assessedAt': today, 'reason': 'initial'})
    target = call('POST', '/api/v1/targets', {})
    for asset_class, ids in approved:
        call('POST', '/api/v1/approved-instruments', {'assetClass': asset_class, 'instrumentIds': ids})

    rec = call('POST', '/api/v1/recommendations', {
        'snapshotRef': {'closeId': close['close']['id'], 'snapshotId': close['snapshot']['id'],
                        'payloadHash': close['snapshot']['payloadHash']},
        'assessmentRef': {'id': assessment['item']['id'], 'ruleVersion': assessment['item']['ruleVersion']},
        'targetVersion': target['item']['templateVersion'],
        'ruleVersion': assessment['item']['ruleVersion'],
        'newFundsMinor': 200000,
    })['recommendation']
    assert rec['status'] == 'formal', '演示前置失败：建议未达正式口径'

    ov = call('GET', '/api/v1/overview')
    cur = call('GET', '/api/v1/targets/current')
    assert ov['canAdvise'] is True, '演示前置失败：总览未达可建议口径'

    labels = {'cash': '现金', 'fixed_income': '固定收益', 'broad_equity': '宽基权益',
              'theme_equity': '主题权益', 'stock': '个股', 'other': '其他'}
    nonzero = [r for r in ov['riskClasses'] if r['valueMinor'] > 0]
    top = sorted(nonzero, key=lambda r: -r['valueMinor'])[0]
    alloc = {c['assetClass']: c for c in rec['result']['categoryAllocations']}
    top_alloc = sorted(alloc.values(), key=lambda c: -c['allocatedMinor'])[0]
    # 方向说明按实际补入类别输出（低于区间下限 = 优先去向），不用「偏离最大」替代——
    # 偏离最大 ≠ 低于下限（如 2200bps 偏离 −800 但仍在 2000~4500 带内）。
    recv = next(c for c in cur['allocation']['classes'] if c['assetClass'] == top_alloc['assetClass'])
    band_text = {'below_min': '低于下限', 'within': '区间内', 'above_max': '高于上限'}.get(recv.get('band'), recv.get('band'))
    symbols = [i.get('symbol') for i in rec['result'].get('instrumentAllocations') or []]

    sheet_lines = [
        '================ G5-R4 标准答案表（作答完成前不要打开） ================',
        f'数据来源：隔离演示账本（临时目录 {info["dir"]}）· 数据日 {today} · schema v11',
        f'① 净资产：{fmt(ov["netWorthMinor"])}（总资产 {fmt(ov["totalAssetsMinor"])} − 总负债 {fmt(ov["totalLiabilitiesMinor"])}）',
        f'② 可投资资产：{fmt(ov["pools"]["investableMinor"])}',
        f'   注意区分：可新增投资资金（本月建议请求金额）＝ {fmt(rec["requestedNewFundsMinor"])}，两者不是同一个数。',
        f'③ 主要风险暴露：{labels[top["assetClass"]]} {fmt(top["valueMinor"])}'
        + (f'（占可投资 {top["pct"]}%）' if top.get('pct') is not None else ''),
        f'④ 新增资金优先方向：{labels[top_alloc["assetClass"]]}当前 {recv["deviationBps"] + recv["targetBps"]}bps，'
        f'{band_text}（目标 {recv["targetBps"]}bps，区间 {recv["minBps"]}~{recv["maxBps"]}bps，偏离 {recv["deviationBps"]:+d}bps）'
        f'→ 建议把 {fmt(rec["requestedNewFundsMinor"])} 优先补入 {labels[top_alloc["assetClass"]]}'
        f'（{fmt(top_alloc["allocatedMinor"])}'
        + (f'，标的 {"、".join(symbols)}' if symbols else '') + '）',
        '',
        '判定：四题全部正确 且 总耗时 ≤60 秒 才通过；页面加载用时另记，不充当理解时间。',
        '受测者入口：' + base + '/',
    ]
    sheet_text = '\n'.join(sheet_lines)

    if serve_only:
        if not answers_file:
            raise SystemExit('--serve-only 需要同时给出 --answers-file <路径>')
        Path(answers_file).write_text(sheet_text + '\n', encoding='utf-8')
        print('演示账本已就绪；标准答案表已写入（作答完成前不要打开）：' + answers_file)
        print('受测者入口：' + base + '/')
        print('演示服务保持运行；停止方式：kill 该进程（SIGTERM 会自动清理临时目录）。')
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            pass
    else:
        print()
        print(sheet_text)
        print()
        print('演示服务保持运行；主测人按回车停止并清理。')
        try:
            input()
        except EOFError:
            pass
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except Exception:
        server.kill()
    print('演示服务已停止，临时数据目录已清理。')
