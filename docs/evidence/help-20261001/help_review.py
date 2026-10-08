"""操作说明验收：临时虚构账本、三档布局、键盘、离线与启动失败。"""
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
base = 'http://127.0.0.1:' + sys.argv[1]
report = {'checks': [], 'pageErrors': [], 'externalRequests': [], 'helpWrites': []}
server = subprocess.Popen(['node', 'docs/evidence/phase5d-wiring-server.cjs', sys.argv[1]],
                          cwd=ROOT, stdout=subprocess.PIPE, text=True)


def check(value, name):
    assert value, name
    report['checks'].append(name)


try:
    report['server'] = json.loads(server.stdout.readline())
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        page = ctx.new_page()
        page.on('pageerror', lambda err: report['pageErrors'].append(str(err)))

        def request_seen(req):
            if urlparse(req.url).hostname not in ('127.0.0.1', None):
                report['externalRequests'].append(req.url)

        ctx.on('request', request_seen)
        page.goto(base + '/#help', wait_until='networkidle')
        page.wait_for_selector('[data-help-page]')
        check(page.locator('[data-help-section]').count() == 9, '直接打开 #help，完整九章')
        page.evaluate('() => navigator.serviceWorker.ready')
        page.wait_for_function('() => !!navigator.serviceWorker.controller')
        ctx.on('request', lambda req: report['helpWrites'].append(req.url)
               if req.method not in ('GET', 'HEAD') else None)
        before = page.evaluate('async () => JSON.stringify(await (await fetch("/api/v1/state")).json())')
        for width in (1440, 1100, 390):
            page.set_viewport_size({'width': width, 'height': 1000})
            page.evaluate('() => window.scrollTo(0,0)')
            check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{width}px 帮助页无溢出')
            page.screenshot(path=str(OUT / f'help-overview-{width}.png'))
            page.locator('#help-search').fill('交易 汇率')
            check(page.locator('#help-execution').count() == 1, f'{width}px 多关键词搜索')
            check(page.evaluate('document.activeElement.id === "help-search"'), f'{width}px 搜索保留焦点')
            check(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{width}px 搜索结果无溢出')
            page.screenshot(path=str(OUT / f'help-search-{width}.png'))
            page.locator('.help-search [data-action="help:clear"]').click()
            page.locator('.help-toc [data-section="monthly"]').focus()
            page.keyboard.press('Enter')
            check(page.evaluate('document.activeElement === document.querySelector("#help-monthly h2")'),
                  f'{width}px 键盘目录定位并转移焦点')
            page.screenshot(path=str(OUT / f'help-monthly-{width}.png'))
        page.locator('.help-toc [data-section="problems"]').click()
        faq = page.locator('#help-problems summary').first
        faq.focus()
        page.keyboard.press('Enter')
        check(page.locator('#help-problems details').first.get_attribute('open') is not None, 'FAQ 键盘展开')
        page.locator('#help-search').fill('<img src=x onerror=alert(1)>')
        check(page.locator('.help-no-results').count() == 1, '无结果提示与 HTML 字符安全处理')
        page.locator('.help-no-results button').click()
        page.reload(wait_until='networkidle')
        check(page.locator('[data-help-section]').count() == 9, '刷新仍保留帮助路由')
        after = page.evaluate('async () => JSON.stringify(await (await fetch("/api/v1/state")).json())')
        check(after == before and not report['helpWrites'], '阅读、搜索和刷新不写账本')
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.locator('#tabbar [data-action="nav:home"]').click()
        page.wait_for_selector('#view.view-home')
        page.screenshot(path=str(OUT / 'home-help-entry-1440.png'))
        page.locator('#view [data-action="nav:help"]').click()
        page.wait_for_selector('[data-help-page]')
        page.locator('#help-start [data-action="nav:assets"]').first.click()
        page.wait_for_selector('#view.view-assets')
        page.go_back(wait_until='domcontentloaded')
        page.wait_for_selector('[data-help-page]')
        check(True, '首页入口、业务快捷跳转与浏览器后退')
        ctx.set_offline(True)
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('[data-help-page]')
        check(page.locator('[data-help-section]').count() == 9, '断网刷新后应用壳和九章仍可读')
        page.locator('#help-search').fill('start.command')
        check(page.locator('#help-start').count() == 1, '断网仍可搜索启动方法')
        page.screenshot(path=str(OUT / 'help-offline-1440.png'))
        ctx.close()

        broken = browser.new_context(service_workers='block', viewport={'width': 1440, 'height': 1000})
        broken.route('**/api/v1/state', lambda route: route.fulfill(status=500, content_type='application/json',
                     body='{"error":{"code":"internal_error","message":"模拟账本读取失败"}}'))
        q = broken.new_page()
        q.on('pageerror', lambda err: report['pageErrors'].append(str(err)))
        q.goto(base + '/', wait_until='networkidle')
        q.locator('[data-action="nav:help"]').click()
        q.wait_for_selector('[data-help-page]')
        check(q.locator('[data-help-section]').count() == 9, '读取失败页仍有帮助入口')
        check('账本数据尚未加载' in q.locator('#view').inner_text(), '未启动状态保持显式提示')
        check(q.locator('.help-shortcut[data-action^="nav:"]:enabled').count() == 0, '未加载时业务快捷入口禁用')
        q.screenshot(path=str(OUT / 'help-startup-failed-1440.png'))
        q.reload(wait_until='networkidle')
        q.wait_for_selector('[data-help-page]')
        check(q.locator('[data-help-section]').count() == 9, '读取失败时 #help 仍支持直接刷新')
        broken.close()
        browser.close()
    check(not report['pageErrors'], '页面运行异常为零')
    check(not report['externalRequests'], '外部请求为零')
    report['pass'] = True
finally:
    (OUT / 'help-review.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    server.terminate()
    server.wait(timeout=10)
print('help checks', len(report['checks']), 'passed')
