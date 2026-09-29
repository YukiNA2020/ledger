// Reuse only fixture setup, not existing test assertions. Real loopback HTTP + temporary databases.
'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const root=path.resolve(__dirname,'../../..');
const filename=path.join(root,'tests/server-phase5d.test.js');
const prelude=fs.readFileSync(filename,'utf8').split('/* ================= 1. S5.2')[0];
const probe=String.raw`
(async()=>{
 const checks=[];
 const ctx=setup('ledger-p5-audit-'); const srv=await startServer(ctx);
 try {
  const f=await seedAdviceChain(srv.port);
  const response=await post(srv.port,'/api/v1/recommendations',recommendBody(f));
  assert.equal(response.status,201);
  const original=(await get(srv.port,'/api/v1/state')).json;
  const clone=x=>JSON.parse(JSON.stringify(x));
  // Positive control: exact JSON round trip into another, initially empty database.
  const fresh=setup('ledger-p5-empty-');
  try {
    R.writeState(fresh.db,original);
    assert.deepStrictEqual(R.readState(fresh.db),original);
    assert.equal(R.readRecommendationView(fresh.db).invalidCount,0);
    checks.push({name:'complete JSON restore into empty database',pass:true});
  }finally{fresh.close();}
  // Native SQLite backup, source edit, restore, and compare all six companion collections.
  const backup=await B.createBackup(ctx.db,ctx.paths,{reason:'phase5-review',keep:30});
  const edit=await post(srv.port,'/api/v1/account-units',{id:'u-cny',accountId:'acc-cash',currency:'CNY',balanceMinor:60000000,asOf:TODAY,sourceType:'manual'});
  assert([200,201].includes(edit.status));
  const restoredDb=await B.restoreBackup(ctx.db,ctx.paths,backup.file,{keep:30});
  assert(restoredDb.ok);ctx.adopt(restoredDb);
  const restoredState=R.readState(ctx.db);
  for(const key of ['assets','riskAssessments','allocationTargets','approvedInstruments','recommendations','monthlyCloses','closeSnapshots']) {
    assert.deepStrictEqual(restoredState[key],original[key]);
  }
  checks.push({name:'native SQLite backup and restore full chain',pass:true});
  // Negative control: changed snapshot contents with the original hash must be rejected atomically.
  R.writeState(ctx.db,original);
  const broken=clone(original);broken.closeSnapshots[0].payloadJson='{}';
  const bad=await request(srv.port,'PUT','/api/v1/state',{body:{state:broken,forceBackup:true}});
  assert(bad.status>=400);assert.deepStrictEqual(R.readState(ctx.db),original);
  checks.push({name:'invalid snapshot restore rejected and rolled back',pass:true,status:bad.status});
  // All records are individually valid. Only the cross-record immutable identity is broken.
  for(const mode of ['different_level','same_level_different_answers']) {
    R.writeState(ctx.db,original);
    const changed=clone(original);
    const payload=mode==='different_level'?L1:{...L3,answers:clientAnswers([2,1,1,2,2],[2,2,1,1])};
    const computed=Domain.computeRiskAssessment(payload,{today:TODAY});assert(computed.ok);
    changed.riskAssessments[0]={...changed.riskAssessments[0],...computed.record};
    const target=Domain.computeAllocationTarget(changed.riskAssessments[0],{today:TODAY,effectiveFrom:changed.allocationTargets[0].effectiveFrom});assert(target.ok);
    changed.allocationTargets[0]={...changed.allocationTargets[0],...target.target};
    const restored=await request(srv.port,'PUT','/api/v1/state',{body:{state:changed,forceBackup:true}});
    const view=R.readRecommendationView(ctx.db);
    const rec=view.items[0];
    const live=R.readRiskAssessments(ctx.db)[0];
    const captured=rec?.gate.capture.riskAssessments.find(x=>x.id===live.id);
    checks.push({name:mode,pass:restored.status>=400,expected:'reject mismatched referenced immutable records and roll back',
      restoreStatus:restored.status,invalidCount:view.invalidCount,recommendationStatus:rec?.status,
      liveCeiling:live.ceiling,capturedCeiling:captured?.ceiling,liveCapacityScore:live.capacityScore,
      capturedCapacityScore:captured?.capacityScore,assessmentIdSame:live.id===rec?.assessmentId,
      targetIdSame:changed.allocationTargets[0].id===rec?.targetId});
  }
 }finally{await srv.close();ctx.close();}
 console.log(JSON.stringify({checks,passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length},null,2));
 if(checks.some(x=>!x.pass))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=2;});
`;
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(prelude+probe,filename);
