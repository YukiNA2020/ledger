// 审计复现：只使用临时数据库与现有测试的虚构数据 helper，不修改产品实现。
const fs = require('node:fs');
const Module = require('node:module');
const root = require('node:path').resolve(__dirname, '../..');
const filename = root + '/tests/server-phase5d.test.js';
const header = fs.readFileSync(filename, 'utf8').split('/* ================= 1. S5.2')[0];
const probe = String.raw`
(async () => {
 const ctx = setup('ledger-review-probes-'); const srv = await startServer(ctx);
 try {
  const f = await seedAdviceChain(srv.port); const body = recommendBody(f);
  const one = await post(srv.port, '/api/v1/recommendations', body);
  ctx.nowIso = () => '2026-09-30T08:00:01.000Z';
  const two = await post(srv.port, '/api/v1/recommendations', body);
  console.log(JSON.stringify({probe:'same input one second later', first:one.status, second:two.status, error:two.json.error}));
  ctx.nowIso = () => NOW_ISO;
  await post(srv.port, '/api/v1/approved-instruments', {assetClass:'broad_equity',instrumentIds:['ins-vgt','ins-voo']});
  const three = await post(srv.port, '/api/v1/recommendations', body);
  console.log(JSON.stringify({probe:'mapping order changed same day', status:three.status, error:three.json.error}));
  const change = await post(srv.port, '/api/v1/account-units', {id:'u-cny',accountId:'acc-cash',currency:'CNY',balanceMinor:60000000,asOf:TODAY,sourceType:'manual'});
  const fresh = await post(srv.port, '/api/v1/recommendations', recommendBody(f, {newFundsMinor:200002}));
  console.log(JSON.stringify({probe:'balance changed after close without resealing', write:change.status, status:fresh.status, adviceStatus:fresh.json.status, currentCash:fresh.json.formalRecommendation?.currentAllocation?.find(x=>x.assetClass==='cash'), sealedCash:JSON.parse(R.getCloseSnapshot(ctx.db,f.snapshot.id).payloadJson).overview.riskClasses.find(x=>x.assetClass==='cash'), sameSnapshot:fresh.json.recommendation?.snapshotId===f.snapshot.id}));
  const state = (await get(srv.port,'/api/v1/state')).json;
  
  const pageState = {accounts:state.accounts,categories:state.categories,txns:state.txns,settings:state.settings,assets:state.assets};
  const write = await request(srv.port,'PUT','/api/v1/state',{body:{state:pageState,preserveCompanionCollections:true}});
  const history = (await get(srv.port,'/api/v1/recommendations')).json;
  const live = await post(srv.port,'/api/v1/recommendations',recommendBody(f,{newFundsMinor:200001}));
  console.log(JSON.stringify({probe:'ordinary five-key save loses close history', write:write.status, closeCount:(await get(srv.port,'/api/v1/monthly-closes')).json.items.length, recommendationCount:history.total, validRecommendationCount:history.items.length, invalidCount:history.invalidCount, subsequentAdvice:live.status,error:live.json.error}));
 } finally { await srv.close(); ctx.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});`;
const mod = new Module(filename, module); mod.filename=filename; mod.paths=Module._nodeModulePaths(root+'/tests'); mod._compile(header+probe,filename);
