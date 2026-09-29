// Independent arithmetic/invariants; all inputs fictional, no network or database.
'use strict';
const assert = require('node:assert/strict');
const D = require('../../../js/domain');
const F = require('../../../tests/fixtures/phase5-risk-rules.json');
const classes = ['cash','fixed_income','broad_equity','theme_equity','stock','other'];
const today = '2026-09-30';
const split = (sum, n) => Array.from({length:n}, () => {const s=Math.min(sum,3);sum-=s;return s;});
function answers(cap, wil) {
  const values = cap.concat(wil);
  return F.questions.map((q,i)=>({questionId:q.id, optionId:q.options.find(o=>o.score===values[i]).id}));
}
function level(score, bounds) { return bounds.filter(x=>score>=x).length; }
let scoresChecked = 0;
// All 1,024 capacity option combinations crossed with all 13 willingness totals.
for(let mask=0;mask<1024;mask++) {
  const cap=Array.from({length:5},(_,i)=>(mask >> (2*i))&3);
  const capacity=cap.reduce((a,b)=>a+b,0);
  for(let w=0;w<=12;w++) {
    const r=D.scoreRiskAnswers(answers(cap,split(w,4)));
    assert(r.ok);
    const capLevel=level(capacity,[0,4,7,10,13]);
    const wilLevel=level(w,[0,3,6,9,11]);
    const hardCap=[0,1,2,4].some(i=>cap[i]===0)?2:5;
    assert.equal(r.capacityScore,capacity);
    assert.equal(r.willingnessScore,w);
    assert.equal(r.ceiling,Math.min(capLevel,wilLevel,hardCap));
    scoresChecked++;
  }
}
function targetForLevel(n) {
  const r=D.computeRiskAssessment({answers:answers([3,3,3,3,3],split([0,3,6,9,11][n-1],4)),assessedAt:today,reason:'initial'},{today});
  assert(r.ok);
  const ra={id:'ra-'+n,createdAt:today+'T00:00:00.000Z',...r.record};
  const t=D.computeAllocationTarget(ra,{today});
  assert(t.ok);
  return {id:'at-'+n,createdAt:today+'T00:00:00.000Z',...t.target};
}
function allocate(t,values,req,avail,reverse=false) {
  const total=values.reduce((a,b)=>a+b,0);
  const riskClasses=classes.map((assetClass,i)=>({assetClass,valueMinor:values[i]}));
  if(reverse)riskClasses.reverse();
  const deviation=D.computeAllocationDeviation(t,{asOf:today,valuationStatus:'formal',canAdvise:true,
    pools:{safetyMinor:0,investableMinor:total,restrictedMinor:0},blockers:[],riskClasses});
  assert(deviation.ok);
  const out=D.computeNewFundsAllocation({target:t,deviation,requestedNewFundsMinor:req,newFundsAvailableMinor:avail});
  assert(out.ok,JSON.stringify(out.error));
  return out.allocation;
}
const t3=targetForLevel(3);
const manual=[];
// Exact S5.2: all other categories within their bands, only broad equity below min.
const s52=allocate(t3,[350000,300000,150000,200000,0,0],200000,350000);
assert.deepEqual(s52.classes.map(c=>c.allocatedMinor),[0,0,200000,0,0,0]);
assert.equal(s52.plannedTotalMinor,1000000);
manual.push({case:'S5.2 other categories within bands',requestedMinor:200000,allocatedMinor:[0,0,200000,0,0,0]});
for(const [requested,expected] of [[1,[0,0,1,0,0,0]],[200000,[0,57142,142858,0,0,0]],[800000,[0,200000,350000,50000,0,0]]]) {
  const r=allocate(t3,[800000,100000,50000,50000,0,0],requested,800000);
  assert.deepEqual(r.classes.map(c=>c.allocatedMinor),expected);
  assert.equal(r.plannedTotalMinor,1000000);
  manual.push({requestedMinor:requested,allocatedMinor:expected,unallocatedMinor:r.unallocatedMinor});
}
let seed=20260927;
const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
let portfoliosChecked=0;
for(let n=1;n<=5;n++) {
  const t=targetForLevel(n);
  for(let i=0;i<1000;i++) {
    const values=classes.map(()=>random(i%2?10000000:100));
    const total=values.reduce((a,b)=>a+b,0);
    const avail=random(values[0]+1),req=i%11===0?0:random(total+1);
    const r=allocate(t,values,req,avail);
    const cashFloor=Number((BigInt(total)*BigInt(t.classes.cash.minBps)+9999n)/10000n);
    assert.equal(r.plannedTotalMinor,total);
    assert.equal(r.allocatedTotalMinor,r.classes.reduce((sum,c)=>sum+c.allocatedMinor,0));
    assert.equal(r.allocatedTotalMinor+r.unallocatedMinor,Math.min(req,avail));
    assert(r.allocatedTotalMinor<=Math.max(0,values[0]-cashFloor));
    for(let k=0;k<6;k++) {
      const c=r.classes[k];
      assert(Number.isSafeInteger(c.allocatedMinor)&&c.allocatedMinor>=0);
      if(c.basis==='above_max'||c.assetClass==='cash'||c.assetClass==='stock') assert.equal(c.allocatedMinor,0);
      const targetCeil=Number((BigInt(total)*BigInt(t.classes[c.assetClass].targetBps)+9999n)/10000n);
      assert(c.allocatedMinor<=Math.max(0,targetCeil-values[k]));
    }
    assert.deepEqual(allocate(t,values,req,avail,true),r);
    portfoliosChecked++;
  }
}
console.log(JSON.stringify({ok:true,scoresChecked,portfoliosChecked,manual},null,2));
