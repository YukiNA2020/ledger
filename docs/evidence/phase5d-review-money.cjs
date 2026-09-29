// 审计复现：只复用测试的确定性目标构造，不发网络、不写数据库。
const fs=require('node:fs'),Module=require('node:module');
const root=require('node:path').resolve(__dirname,'../..'), filename=root+'/tests/domain-phase5d.test.js';
const src=fs.readFileSync(filename,'utf8').split("test('5D-1")[0];
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(root+'/tests');
m._compile(src+String.raw`
const values={cash:800000,fixed_income:100000,broad_equity:50000,theme_equity:50000,stock:0,other:0};
const out=mustAlloc(T3,deviationOf(T3,values),800000,800000);
console.log(JSON.stringify({totalMinor:1000000,cashAlreadyInTotal:800000,plannedTotalMinor:out.plannedTotalMinor,allocated:out.allocatedTotalMinor,classes:out.classes.map(r=>({class:r.assetClass,allocated:r.allocatedMinor,minNeed:r.minNeedMinor,maxBps:r.maxBps,actualAfterPct:r.assetClass==='cash'?(r.valueMinor-out.allocatedTotalMinor+r.allocatedMinor)/10000:(r.valueMinor+r.allocatedMinor)/10000}))}));
`,filename);
