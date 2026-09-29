// 仅使用 setup() 创建的临时数据库和离线 FX fixture。SIGTERM 清理自己的目录。
const root=require('node:path').resolve(__dirname, '../..');
const {setup}=require(root+'/tests/server-helpers');
const config=require(root+'/server/config');
const api=require(root+'/server/api');
const http=require('node:http');
const ctx=setup('ledger-fix5d-browser-');
Object.assign(ctx,{host:config.HOST,port:Number(process.argv[2]),token:'isolated-browser-verification-token',repoRoot:root,backupKeep:30,backupMinIntervalMs:60000,startedAt:new Date().toISOString(),marketDataFetcher:{fx:require(root+'/server/providers/fixture').getFxRates},logger:{info(){},warn(){},error(){}}});
const server=http.createServer(api.createHandlerEntry(ctx));
server.listen(ctx.port,ctx.host,()=>console.log(JSON.stringify({pid:process.pid,port:ctx.port,dir:ctx.dir})));
process.on('SIGTERM',()=>server.close(()=>{ctx.close();process.exit(0)}));
