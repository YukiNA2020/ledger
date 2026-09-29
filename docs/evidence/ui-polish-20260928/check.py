"""Run against an isolated fixture server, never a personal ledger."""
import json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
base='http://127.0.0.1:'+sys.argv[1]
out=Path(__file__).parent
report={'pages':[], 'errors':[]}
emoji=re.compile('[\U0001F000-\U0001FAFF\u2600-\u27BF]')
routes=['home','cashflow','add','list','stats','settings','import','accounts','categories','budget','health','reimburse','recurring','assets','close','risk','targets']
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 q=b.new_page(viewport={'width':1440,'height':900})
 q.goto(base+'/tests/app-wiring.html',wait_until='domcontentloaded')
 q.wait_for_selector('body[data-result]',timeout=180000)
 report['wiring']=q.locator('#summary').inner_text()
 report['checks']=q.locator('#results li').all_text_contents()
 (out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 assert q.get_attribute('body','data-result')=='pass', report['wiring']
 q.goto(base+'/',wait_until='networkidle')
 status=q.evaluate('''async()=>{let s=await Store.loadRaw(); s.accounts=Core.defaultAccounts();s.categories=Core.defaultCategories();let r=await fetch('/api/v1/state',{method:'PUT',headers:{'Content-Type':'application/json','x-ledger-token':Store.readSessionToken()},body:JSON.stringify({state:s,forceBackup:true})});return r.status}''')
 assert status==200,status
 q.close()
 for width in [1440,1100,390]:
  q=b.new_page(viewport={'width':width,'height':900})
  q.on('pageerror',lambda e: report['errors'].append(str(e)))
  q.goto(base+'/',wait_until='networkidle')
  for route in routes:
   q.evaluate('(r)=>location.hash=r',route)
   q.wait_for_selector('#view.view-'+route)
   q.wait_for_timeout(100)
   assert not emoji.search(q.locator('#view').inner_text()),(width,route,'emoji')
   assert q.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,route,'overflow')
   if route in ['cashflow','list','stats']:
    title=q.locator('.mb-title'); before=title.inner_text()
    assert title.evaluate('(e)=>e.scrollWidth<=e.clientWidth && e.scrollHeight<=e.clientHeight'),(width,route,'month clipped')
    q.locator('[data-action="ym:prev"]').click()
    q.wait_for_function('(before)=>document.querySelector(".mb-title").innerText!==before',arg=before)
    q.locator('[data-action="ym:next"]').click()
    q.wait_for_function('(before)=>document.querySelector(".mb-title").innerText===before',arg=before)
   if route=='cashflow':q.screenshot(path=str(out/f'cashflow-{width}.png'))
   if route in ['categories','accounts','list']:
    action={'categories':'cat:edit','accounts':'acc:edit','list':'list:filterSheet'}[route]
    q.locator(f'[data-action="{action}"]').first.click()
    q.wait_for_selector('#sheet-mask:not(.hidden)')
    assert not emoji.search(q.locator('#sheet').inner_text()),(width,route,'sheet emoji')
    assert q.locator('#sheet').evaluate('(e)=>e.scrollWidth<=e.clientWidth'),(width,route,'sheet overflow')
    if route=='categories':q.wait_for_timeout(300)
    if route=='categories':q.screenshot(path=str(out/f'category-sheet-{width}.png'))
    q.locator('#sheet .close').click()
   report['pages'].append({'width':width,'route':route,'pass':True})
  q.close()
 b.close()
assert not report['errors'],report['errors']
(out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(report['wiring'],len(report['pages']),'responsive page checks passed')
