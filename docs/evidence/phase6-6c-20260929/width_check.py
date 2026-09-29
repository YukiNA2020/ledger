"""6C 决策与待执行：三档宽度与关键状态检查（隔离 fixture，绝不触碰私人账本）。

用法：python3 width_check.py <端口>
  先启动隔离服务：node docs/evidence/phase5d-wiring-server.cjs <端口>
覆盖：
  1) 决策页首帧「读取中」（延迟响应）、读取失败（500）、重试恢复三态；
  2) 1440 / 1100 / 390 三档 × 18 条路由无装饰表情、无横向溢出；
  3) 决定弹层与详情弹层三档不溢出、不裁切；
  4) 决定入口行、卡片理由与月份换行不挤压按钮。
输出：width-result.json 与 width-*.png 截图。
"""
import json, re, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

base = 'http://127.0.0.1:' + sys.argv[1]
out = Path(__file__).parent
report = {'states': [], 'pages': [], 'errors': []}
emoji = re.compile('[\U0001F000-\U0001FAFF☀-➿]')
routes = ['home', 'cashflow', 'add', 'list', 'stats', 'settings', 'import', 'accounts',
          'categories', 'budget', 'health', 'reimburse', 'recurring', 'assets', 'close',
          'risk', 'targets', 'decisions']


def ok(cond, label):
    if not cond:
        raise AssertionError(label)


def seed(page):
    """写入 6C 事实链：虚拟资产 + 正式月结 + 风险评估 + 目标版本 + 认可标的。"""
    status = page.evaluate('''async () => {
      const TOKEN = Store.readSessionToken();
      const today = Domain.localTodayISO();
      const ty = +today.slice(0, 4), tm = +today.slice(5, 7);
      const monthEnd = today.slice(0, 8) + String(new Date(Date.UTC(ty, tm, 0)).getUTCDate()).padStart(2, '0');
      const dates = Array.from(new Set([today, monthEnd]));
      const rows = (ins, price, currency) => dates.map(d =>
        ({ instrumentId: ins, priceMinor: price, currency: currency, priceDate: d, provider: 'manual', status: 'ok' }));
      const a = Domain.emptyAssets();
      a.assetAccounts = [
        { id: 'c6-acc-cash', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: 'C6' },
        { id: 'c6-acc-broker', name: '券商户', kind: 'broker', pool: 'investable', institution: 'C6' },
        { id: 'c6-acc-safe', name: '应急金', kind: 'deposit', pool: 'safety', institution: 'C6' }
      ];
      a.assetUnits = [
        { id: 'c6-u-cny', accountId: 'c6-acc-cash', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' },
        { id: 'c6-u-safe', accountId: 'c6-acc-safe', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' }
      ];
      a.instruments = [
        { id: 'c6-ins-bond', symbol: 'C6BND', exchange: 'NASDAQ', currency: 'USD', name: '债基', instrumentType: 'etf', assetClass: 'fixed_income', exposureMarket: 'US', classificationStatus: 'confirmed' },
        { id: 'c6-ins-voo', symbol: 'C6VOO', exchange: 'SSE', currency: 'CNY', name: '宽基A', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
        { id: 'c6-ins-thm', symbol: 'C6THM', exchange: 'SSE', currency: 'CNY', name: '主题', instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' }
      ];
      a.holdings = [
        { id: 'c6-h-bond', accountId: 'c6-acc-broker', instrumentId: 'c6-ins-bond', quantity: '5000', costMinor: 5000000, asOf: today },
        { id: 'c6-h-voo', accountId: 'c6-acc-broker', instrumentId: 'c6-ins-voo', quantity: '50000', costMinor: 5000000, asOf: today },
        { id: 'c6-h-thm', accountId: 'c6-acc-broker', instrumentId: 'c6-ins-thm', quantity: '70000', costMinor: 7000000, asOf: today }
      ];
      a.quotes = rows('c6-ins-bond', 1000, 'USD').concat(rows('c6-ins-voo', 100, 'CNY')).concat(rows('c6-ins-thm', 100, 'CNY'));
      a.fxRates = dates.map(d => ({ base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: d, provider: 'manual', status: 'ok' }));

      const base = await (await fetch('/api/v1/state', { headers: { Accept: 'application/json' } })).json();
      const st = Object.assign({}, base, {
        accounts: [], categories: [], txns: [], settings: {}, assets: a,
        riskAssessments: [], allocationTargets: [], approvedInstruments: [], recommendations: [],
        decisions: [], decisionEvents: [], decisionLinks: []
      });
      const put = await fetch('/api/v1/state', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN },
        body: JSON.stringify({ state: st })
      });
      if (put.status !== 200) return 'put:' + put.status;
      const post = async (path, body) => (await fetch('/api/v1/' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ledger-token': TOKEN },
        body: JSON.stringify(body)
      })).status;
      const close = await post('monthly-closes', { month: today.slice(0, 7) });
      if (close !== 201 && close !== 200) return 'close:' + close;
      const CAP = Domain.RISK_QUESTIONS.filter(q => q.kind === 'capacity');
      const WIL = Domain.RISK_QUESTIONS.filter(q => q.kind === 'willingness');
      const pick = (list, scores) => list.map((q, i) =>
        ({ questionId: q.id, optionId: q.options.filter(o => o.score === scores[i])[0].id }));
      const answers = pick(CAP, [1, 1, 1, 2, 2]).concat(pick(WIL, [2, 2, 1, 1]));
      const risk = await post('risk-assessments', { answers: answers, assessedAt: today, reason: 'initial' });
      if (risk !== 201) return 'risk:' + risk;
      const tgt = await post('targets', {});
      if (tgt !== 201 && tgt !== 200) return 'targets:' + tgt;
      const inst = await post('approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['c6-ins-voo'] });
      if (inst !== 200) return 'inst:' + inst;
      return 'ok';
    }''')
    ok(status == 'ok', '前置事实链写入失败：' + str(status))


def run_advice(page, amount):
    """生成一笔新的正式建议，返回结果块是否带可决策入口。"""
    page.evaluate("(a)=>location.hash='targets'", amount)
    page.wait_for_selector('#view [data-action="target:reload"]')
    page.locator('#view [data-action="target:reload"]').first.click()
    page.wait_for_selector('#view [data-action="advice:run"]')
    page.evaluate('''(amount) => {
      const inp = document.querySelector('#view [data-input="advice:amount"]');
      inp.value = String(amount);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#view [data-action="advice:run"]').click();
    }''', amount)
    page.wait_for_function('''(amount) => {
      const b = document.querySelector('#view [data-advice-result]');
      return b && b.getAttribute('data-advice-allocated') === String(amount * 100);
    }''', arg=amount, timeout=20000)


def sheet_ok(page, width, route, name):
    page.wait_for_selector('#sheet-mask:not(.hidden)')
    time.sleep(0.2)
    text = page.locator('#sheet').inner_text()
    ok(not emoji.search(text), (width, route, name, 'emoji'))
    ok(page.locator('#sheet').evaluate('(e)=>e.scrollWidth<=e.clientWidth'), (width, route, name, 'sheet overflow'))
    ok(page.evaluate('document.documentElement.scrollWidth<=innerWidth'), (width, route, name, 'page overflow'))
    page.screenshot(path=str(out / f'{name}-{width}.png'))
    report['pages'].append({'width': width, 'route': route, 'check': name, 'pass': True})


with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    q = b.new_page(viewport={'width': 1440, 'height': 900})
    q.on('pageerror', lambda e: report['errors'].append(str(e)))
    q.goto(base + '/', wait_until='networkidle')
    seed(q)

    # ① 首帧读取中：延迟决策读取，不得把「还没读到」渲染成空清单
    held = []
    q.route('**/api/v1/decisions*', lambda r: held.append(r))   # 扣住响应，读取中状态可稳定截图
    q.evaluate("()=>location.hash='decisions'")
    q.wait_for_selector('#view.view-decisions [data-dec-loading]', timeout=6000)
    ok('还没有待执行的决策' not in q.locator('#view').inner_text(), '读取中不得渲染空态')
    q.screenshot(path=str(out / 'decisions-loading-1440.png'))
    report['states'].append({'state': 'loading', 'pass': True})
    held[0].continue_()
    q.unroute('**/api/v1/decisions*')
    q.wait_for_selector('#view.view-decisions [data-action="dec:reload"]', timeout=15000)

    # ② 读取失败：必须显式失败卡 + 重试入口，且不冒充「还没有决策」
    q.route('**/api/v1/decisions*', lambda r: r.fulfill(
        status=500, content_type='application/json',
        body='{"error":{"code":"internal_error","message":"模拟读取失败","retryable":true}}'))
    q.locator('#view [data-action="dec:reload"]').first.click()
    q.wait_for_selector('#view.view-decisions [data-dec-error]', timeout=6000)
    ok('决策读取失败' in q.locator('#view').inner_text(), '失败卡文案')
    ok(q.locator('#view [data-dec-empty]').count() == 0, '失败不得冒充空态')
    ok('还没有待执行的决策' not in q.locator('#view').inner_text(), '失败不得出现空态文案')
    q.screenshot(path=str(out / 'decisions-error-1440.png'))
    report['states'].append({'state': 'error', 'pass': True})
    q.unroute('**/api/v1/decisions*')

    # ③ 重试恢复
    q.locator('#view [data-dec-error] [data-action="dec:reload"]').click()
    q.wait_for_selector('#view.view-decisions [data-dec-empty]', timeout=15000)
    report['states'].append({'state': 'empty-after-retry', 'pass': True})

    # ④ 生成正式建议并接受一单（决定弹层 + 卡片 + 详情弹层都要三档过检）
    run_advice(q, 2000)
    ok(q.locator('#view [data-action="dec:open"]').count() == 1, '决定入口可见')
    q.locator('#view [data-action="dec:open"]').click()
    q.wait_for_selector('#dec-note')
    q.evaluate('''() => {
      const box = document.querySelector('#dec-note');
      box.value = '宽度检查：把闲置现金先按目标配置投入宽基，按目标配置执行，理由充分且可复核。';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }''')
    q.locator('#sheet [data-action="dec:submit"][data-intent="accepted"]').click()
    q.wait_for_function("()=>document.querySelector('#sheet-mask').classList.contains('hidden')", timeout=8000)
    report['states'].append({'state': 'accepted', 'pass': True})

    for width in [1440, 1100, 390]:
        if width != 1440:
            q.close()
            q = b.new_page(viewport={'width': width, 'height': 900})
            q.on('pageerror', lambda e: report['errors'].append(str(e)))
            q.goto(base + '/', wait_until='networkidle')
        for route in routes:
            q.evaluate('(r)=>location.hash=r', route)
            q.wait_for_selector('#view.view-' + route)
            q.wait_for_timeout(120)
            text = q.locator('#view').inner_text()
            ok(not emoji.search(text), (width, route, 'emoji'))
            ok(q.evaluate('document.documentElement.scrollWidth<=innerWidth'), (width, route, 'overflow'))
            if route == 'targets':
                entry = q.locator('#view [data-dec-entry]')
                ok(entry.count() <= 1, (width, route, '决定入口数量'))
                if entry.count():
                    ok(entry.first.evaluate('(e)=>e.scrollWidth<=e.clientWidth'), (width, route, '决定入口行溢出'))
            if route == 'decisions':
                q.screenshot(path=str(out / f'decisions-{width}.png'))
            report['pages'].append({'width': width, 'route': route, 'pass': True})

        # 决定弹层：换一个新金额重新生成建议，保证入口仍未决策
        q.evaluate("(a)=>location.hash='targets'", 3000)
        run_advice(q, 3000)
        if q.locator('#view [data-action="dec:open"]').count():
            q.locator('#view [data-action="dec:open"]').click()
            q.wait_for_selector('#dec-note')
            sheet_ok(q, width, 'targets', 'decide-sheet')
            q.locator('#sheet .close').click()
            q.wait_for_function("()=>document.querySelector('#sheet-mask').classList.contains('hidden')")

        # 详情弹层
        q.evaluate("()=>location.hash='decisions'")
        q.wait_for_selector('#view.view-decisions [data-action="dec:detail"]')
        q.locator('#view [data-action="dec:detail"]').first.click()
        sheet_ok(q, width, 'decisions', 'detail-sheet')
        q.locator('#sheet .close').click()
        q.wait_for_function("()=>document.querySelector('#sheet-mask').classList.contains('hidden')")

        # 卡片理由与月份换行不挤压按钮
        ok(q.locator('#view .dec-card').first.evaluate('(e)=>e.scrollWidth<=e.clientWidth'), (width, 'decisions', 'card overflow'))
    b.close()

assert not report['errors'], report['errors']
(out / 'width-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print('states', len(report['states']), '· page checks', len(report['pages']), 'passed')
