import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const configuration = (file:string) => parseEnv(readFileSync(file,'utf8'));
const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
const address = server.address(); assert.ok(address && typeof address!=='string'); const port=address.port;
await new Promise<void>((done,reject)=>server.close((error)=>error?reject(error):done()));
const api=fork(resolve('apps/api/src/main.ts'),[],{execArgv:['--use-system-ca','--import','tsx'],env:{...process.env,...configuration('.env.remote'),...configuration('.env.b04'),API_PORT:String(port),LOG_LEVEL:'silent'},stdio:['ignore','ignore','ignore','ipc']});
const localEnv={...process.env,...configuration('.env.local.b04'),LOG_LEVEL:'silent'};
for(const key of Object.keys(localEnv)) if(key.startsWith('MYSQL_') || ['AUTH_INSTALLATION_TOKEN','AUTH_SIGNING_KEY_FILE','AUTH_FINGERPRINT_KEY'].includes(key)) delete (localEnv as NodeJS.ProcessEnv)[key];
const local=fork(resolve('apps/local-service/src/main.ts'),[],{execArgv:['--use-system-ca','--import','tsx'],env:localEnv,stdio:['ignore','ignore','ignore','ipc']});
const stoppedApi=once(api,'exit'),stoppedLocal=once(local,'exit');
try {
  const [[ready]] = await Promise.all([once(api,'message',{signal:AbortSignal.timeout(20000)}),once(local,'message',{signal:AbortSignal.timeout(20000)})]);
  assert.equal(ready.type,'ready');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`)).status,401);
  const spec=await(await fetch(`http://127.0.0.1:${port}/openapi.json`)).json() as {paths:object};
  assert.ok(Object.keys(spec.paths).includes('/api/v1/setup/activate'));
  for(const path of ['/api/v1/products','/api/v1/categories','/api/v1/customers','/api/v1/settings','/api/v1/stock/balances','/api/v1/stock/movements','/api/v1/cash-sessions','/api/v1/sales','/api/v1/admin/sync-status','/api/v1/admin/backups/status']){
    assert.ok(Object.keys(spec.paths).includes(path));assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status,401);
  }
  for(const path of ['/api/v1/sync/push','/api/v1/sync/device-state','/api/v1/sync/receipts/{operation_id}','/api/v1/sync/changes','/api/v1/sync/snapshots','/api/v1/sync/snapshots/{id}','/api/v1/sync/snapshots/{id}/pages/{page}'])assert.ok(Object.keys(spec.paths).includes(path));
  assert.equal(Object.keys(spec.paths).includes('/api/v1/sync/snapshot'),false);
  for(const path of ['/api/v1/exports/catalog','/api/v1/jobs/{id}','/api/v1/jobs/{id}/result','/api/v1/admin/jobs/{id}/retry'])assert.ok(Object.keys(spec.paths).includes(path));
  for(const path of ['/api/v1/admin/sync-resolutions','/api/v1/admin/sync-resolutions/{id}'])assert.ok(Object.keys(spec.paths).includes(path));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/admin/sync-resolutions/550e8400-e29b-41d4-a716-446655440000`)).status,401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000`)).status,401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/sync/changes`,{headers:{'x-device-credential':'x'.repeat(43)}})).status,401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/sync/device-state`,{headers:{'x-device-credential':'x'.repeat(43)}})).status,401);
  const unauthenticated=once(local,'message',{signal:AbortSignal.timeout(10000)}); local.send({type:'auth.getContext',request_id:'auth-smoke'});
  assert.equal((await unauthenticated)[0].error.code,'AUTHENTICATION_REQUIRED');
  const business=once(local,'message',{signal:AbortSignal.timeout(10000)});local.send({type:'settings.get',request_id:'business-smoke'});
  assert.equal((await business)[0].error.code,'AUTHENTICATION_REQUIRED');
  for(const command of [{type:'cash.getCurrent'},{type:'sales.getCompletionResult',intention_id:'550e8400-e29b-41d4-a716-446655440000'}]){const result=once(local,'message',{signal:AbortSignal.timeout(10000)});local.send({...command,request_id:'financial-smoke'});assert.equal((await result)[0].error.code,'AUTHENTICATION_REQUIRED');}
  for(const type of ['recovery.inspect','recovery.prepareCopy','sync.getStatus','sync.requestRetry','sync.listConflicts']){const result=once(local,'message',{signal:AbortSignal.timeout(10000)});local.send({type,request_id:'sync-smoke'});assert.equal((await result)[0].error.code,'AUTHENTICATION_REQUIRED');}
  const review=once(local,'message',{signal:AbortSignal.timeout(10000)});local.send({type:'sync.submitResolution',request_id:'resolution-smoke',intention_id:'550e8400-e29b-41d4-a716-446655440000',operation_id:'550e8400-e29b-41d4-a716-446655440000',expected_version:1,action:'confirm_original',reason:'Conferência de contrato sem sessão'});assert.equal((await review)[0].error.code,'AUTHENTICATION_REQUIRED');
  for(const [type,query] of [['query.sales',{}],['query.summary',{from:'2026-11-25T00:00:00.000Z',to:'2026-11-26T00:00:00.000Z',time_zone:'America/Sao_Paulo'}],['query.reportEvents',{from:'2026-11-25T00:00:00.000Z',to:'2026-11-26T00:00:00.000Z',time_zone:'America/Sao_Paulo'}]] as const){const result=once(local,'message',{signal:AbortSignal.timeout(10000)});local.send({type,query,request_id:'query-smoke'});assert.equal((await result)[0].error.code,'AUTHENTICATION_REQUIRED');}
  for(const path of ['/api/v1/reports/summary','/api/v1/reports/movements','/api/v1/sales/{id}','/api/v1/sales/{id}/reversals','/api/v1/cash-sessions/{id}/closure','/api/v1/admin/sync-status/{device_id}','/api/v1/sync/status'])assert.ok(Object.keys(spec.paths).includes(path));
  const status=once(local,'message',{signal:AbortSignal.timeout(10000)}); local.send({type:'device.getStatus',request_id:'device-smoke'});
  assert.equal((await status)[0].data.offline_enabled,false);
  api.disconnect(); local.send({type:'shutdown',request_id:'stop-smoke'});
  assert.equal((await stoppedApi)[0],0); assert.equal((await stoppedLocal)[0],0);
  console.log(JSON.stringify({api_boot:true,business_routes_registered:true,unauthenticated_http_rejected:true,unauthenticated_ipc_rejected:true,local_without_mysql_credentials:true,offline_enabled:false,shutdown:true}));
} finally {
  // Em falhas do smoke, primeiro libera o dono SQLite pelo protocolo normal.
  for(const [child,mode] of [[local,'local'],[api,'api']] as const){
    if(child.exitCode!==null||child.signalCode!==null)continue;
    const exited=once(child,'exit',{signal:AbortSignal.timeout(5000)});
    if(child.connected){if(mode==='local')child.send({type:'shutdown',request_id:'cleanup-smoke'});else child.disconnect();}else child.kill();
    await exited.catch(()=>child.kill());
  }
}
