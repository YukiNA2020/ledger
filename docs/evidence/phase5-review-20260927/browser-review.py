"""Local fixture only. Requires the existing Python Playwright installation."""
import json
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
port = int(sys.argv[1])
base = f"http://127.0.0.1:{port}"
server = subprocess.Popen(
    ["node", "docs/evidence/phase5d-wiring-server.cjs", str(port)],
    cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
report = {"port": port, "console": [], "pageErrors": [], "externalRequests": []}
try:
    report["server"] = json.loads(server.stdout.readline())
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        def route_request(route):
            url = route.request.url
            if urlparse(url).hostname not in ("127.0.0.1", None):
                report["externalRequests"].append(url)
                route.abort()
            else:
                route.continue_()
        context.route("**/*", route_request)
        page = context.new_page()
        page.on("console", lambda msg: report["console"].append({"type": msg.type, "text": msg.text}))
        page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
        started = time.monotonic()
        page.goto(base + "/tests/app-wiring.html?v=5e6", wait_until="domcontentloaded")
        page.wait_for_selector("body[data-result]", timeout=180000)
        report["elapsedSeconds"] = round(time.monotonic() - started, 3)
        report["result"] = page.get_attribute("body", "data-result")
        report["summary"] = page.inner_text("#summary")
        report["checks"] = page.locator("#results li").all_text_contents()
        print(report["summary"], flush=True)
        assert report["result"] == "pass", report["checks"]
        # Phase5 复验原本 34 项；Phase 6C 追加 2 项「决策与待执行」浏览器接线检查（36 项）：
        # 6C 决定/清单/详情/门禁/慢响应，以及详情弹层慢响应不覆盖后打开的另一条。
        assert len(report["checks"]) == 36
        assert not report["externalRequests"]
        assert not report["pageErrors"]

        # The harness hides #app. Probe actual visible UI at the production route.
        report["wiringConsole"] = list(report["console"])
        page.goto(base + "/", wait_until="networkidle")
        page.locator('[data-action="nav:targets"]').first.click()
        page.locator('[data-input="advice:amount"]').fill('2000')
        page.locator('[data-action="advice:run"]').click()
        page.wait_for_selector('[data-advice-result][data-advice-status="formal"]')
        before = page.locator('[data-advice-result]').inner_text()
        for count in (1, 0):
            # 目标页异步重绘会替换同一按钮；从当前 DOM 取元素触发真实委托点击，
            # 避免 Playwright 等旧节点稳定时无限重试 detached 元素。
            page.evaluate("""() => {
                const button = document.querySelector('[data-action="map:remove"][data-cls="broad_equity"]');
                if (!button) throw new Error('缺少宽基映射移除按钮');
                button.click();
            }""")
            page.wait_for_function("n => document.querySelectorAll('[data-action=\"map:remove\"][data-cls=\"broad_equity\"]').length === n", arg=count)
        mapping_probe = page.evaluate("""async () => {
            const current = await Store.allocationCurrent();
            const el = document.querySelector('[data-advice-result]');
            return {currentMappingCount: current.mapping.rows.filter(r=>r.assetClass==='broad_equity').length,
                adviceStatus: el?.dataset.adviceStatus, adviceText: el?.innerText};
        }""")
        mapping_probe["unchangedAfterRevocation"] = mapping_probe["adviceText"] == before
        report["mappingRevocationProbe"] = mapping_probe
        print('Mapping revocation probe: ' + json.dumps({k:v for k,v in mapping_probe.items() if k != 'adviceText'}, ensure_ascii=False), flush=True)
        page.screenshot(path=str(OUT / f"revoked-mapping-{port}.png"))

        # A real API update followed by the product's refresh button.
        report["staleUpdateStatus"] = page.evaluate("""async () => {
            const s = await Store.loadRaw(); const old = new Date(); old.setDate(old.getDate()-10);
            s.assets.quotes = [...new Map(s.assets.quotes.map(q=>[q.instrumentId,{...q,priceDate:Domain.localTodayISO(old)}])).values()];
            const r=await fetch('/api/v1/state',{method:'PUT',headers:{'Content-Type':'application/json',
                'x-ledger-token':Store.readSessionToken()},body:JSON.stringify({state:s,forceBackup:true})});return r.status;
        }""")
        assert report["staleUpdateStatus"] == 200
        page.locator('[data-action="target:reload"]').click()
        page.wait_for_function("document.querySelector('#view').innerText.includes('当前为估算口径')")
        report["staleQuoteProbe"] = page.evaluate("""async () => ({
            apiCanAdvise:(await Store.allocationCurrent()).allocation.canAdvise,
            pageSaysEstimate:document.querySelector('#view').innerText.includes('当前为估算口径'),
            adviceStatus:document.querySelector('[data-advice-result]')?.dataset.adviceStatus,
            adviceText:document.querySelector('[data-advice-result]')?.innerText
        })""")
        print('Stale quote probe: ' + json.dumps({k:v for k,v in report["staleQuoteProbe"].items() if k != 'adviceText'}, ensure_ascii=False), flush=True)
        page.locator('#view').screenshot(path=str(OUT / f"stale-view-{port}.png"))

        # Offline behavior must use the production route, whose service worker covers '/'.
        offline = context.new_page()
        offline.goto(base + "/", wait_until="networkidle")
        offline.evaluate("navigator.serviceWorker.ready")
        offline.reload(wait_until="networkidle")
        offline.wait_for_selector('[data-action="know:open"][data-card-id="card-fx-risk"]')
        context.set_offline(True)
        offline.reload(wait_until="domcontentloaded")
        offline.wait_for_function("document.querySelector('#view').innerText.length > 0")
        report["offlineProbe"] = offline.evaluate("""() => ({
            body:document.querySelector('#view').innerText,
            catalogLoaded:!!window.Knowledge?.getCard('card-fx-risk'),
            knowledgeEntryCount:document.querySelectorAll('[data-action="know:open"]').length,
            serviceWorkerControlled:!!navigator.serviceWorker.controller
        })""")
        offline.screenshot(path=str(OUT / f"offline-view-{port}.png"), full_page=True)
        print('Offline probe: ' + json.dumps(report["offlineProbe"], ensure_ascii=False), flush=True)
        if report["offlineProbe"]["knowledgeEntryCount"]:
            offline.locator('[data-action="know:open"]').first.click()
            report["offlineKnowledge"] = offline.locator('#sheet').inner_text()
        report["findings"] = []
        if mapping_probe["currentMappingCount"] == 0 and mapping_probe["unchangedAfterRevocation"]:
            report["findings"].append('revoked_mapping_still_in_formal_advice')
        if not report["staleQuoteProbe"]["apiCanAdvise"] and report["staleQuoteProbe"]["adviceStatus"] == 'formal':
            report["findings"].append('stale_valuation_still_displays_all_gates_passed')
        if report["offlineProbe"]["catalogLoaded"] and not report["offlineProbe"]["knowledgeEntryCount"]:
            report["findings"].append('cached_knowledge_has_no_offline_ui_entry')
        report["auditPassed"] = not report["findings"]
        context.set_offline(False)
        browser.close()
finally:
    server.send_signal(signal.SIGTERM)
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
    (OUT / f"browser-{port}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({k: report.get(k) for k in ("port", "result", "summary", "elapsedSeconds", "externalRequests")}, ensure_ascii=False), flush=True)
sys.exit(0 if report.get('auditPassed') else 1)
