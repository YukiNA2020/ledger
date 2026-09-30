"""Phase 6D wiring runner（隔离 fixture，绝不触碰私人账本）。

用法：python3 run_wiring_6d.py <端口>
  - 启动 docs/evidence/phase5d-wiring-server.cjs 隔离服务（全新临时数据库，SIGTERM 自清理）；
  - Playwright 全新 Chromium profile 打开 /tests/app-wiring.html?v=6d；
  - 等待 body[data-result]，断言 pass，逐项保存检查结果与 console/pageerror 日志。
输出：当前目录下 wiring-run-<port>.json（含每项检查名与结果）。
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[3]  # ledger/
port = int(sys.argv[1])
base = f'http://127.0.0.1:{port}'

server = subprocess.Popen(
    ['node', str(root / 'docs/evidence/phase5d-wiring-server.cjs'), str(port)],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)
try:
    line = server.stdout.readline().strip()
    info = json.loads(line)
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

    logs = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context()  # 全新 profile：无旧 Service Worker、无旧缓存
        q = ctx.new_page()
        q.on('pageerror', lambda e: logs.append('pageerror: ' + str(e)))
        q.on('response', lambda r: logs.append(
            f'response: {r.status} {r.request.method} {r.url[-60:]} body={r.text()[:220]!r}')
            if '/api/v1/decisions' in r.url or '/api/v1/recommendations' in r.url else None)
        q.on('console', lambda m: logs.append(f'console.{m.type}: {m.text}')
             if m.type in ('error', 'warning') or m.text.startswith('DRILL:') else None)
        q.goto(base + '/tests/app-wiring.html?v=6d', wait_until='domcontentloaded')
        q.wait_for_selector('body[data-result]', timeout=240000)
        result = q.get_attribute('body', 'data-result')
        summary = q.locator('#summary').inner_text()
        checks = q.locator('#results li').all_text_contents()
        dump = q.evaluate("""() => ({
          sheet: (document.querySelector('#sheet')||{}).textContent || '',
          hash: location.hash
        })""")
        ctx.close()
        b.close()
    print('summary:', summary)
    print('result:', result)
    for c in checks:
        print(('PASS ' if c.startswith('✅') else 'FAIL ') + c[:160])
    for l in logs:
        print('LOG', l[:200])
    if result != 'pass':
        print('SHEET DUMP:', dump.get('sheet','')[:600])
    out = Path(__file__).parent / f'wiring-run-{port}.json'
    out.write_text(json.dumps({
        'url': base + '/tests/app-wiring.html?v=6d',
        'dbDir': info.get('dir'), 'result': result, 'summary': summary,
        'checks': checks, 'logs': logs, 'dump': dump,
    }, ensure_ascii=False, indent=2))
    if result != 'pass':
        raise SystemExit('WIRING FAILED')
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except Exception:
        server.kill()
