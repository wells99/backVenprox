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
  const unauthenticated=once(local,'message',{signal:AbortSignal.timeout(10000)}); local.send({type:'auth.getContext',request_id:'auth-smoke'});
  assert.equal((await unauthenticated)[0].error.code,'AUTHENTICATION_REQUIRED');
  const status=once(local,'message',{signal:AbortSignal.timeout(10000)}); local.send({type:'device.getStatus',request_id:'device-smoke'});
  assert.equal((await status)[0].data.offline_enabled,false);
  api.disconnect(); local.send({type:'shutdown',request_id:'stop-smoke'});
  assert.equal((await stoppedApi)[0],0); assert.equal((await stoppedLocal)[0],0);
  console.log(JSON.stringify({api_boot:true,unauthenticated_http_rejected:true,unauthenticated_ipc_rejected:true,local_without_mysql_credentials:true,offline_enabled:false,shutdown:true}));
} finally {
  if(api.exitCode===null)api.kill(); if(local.exitCode===null)local.kill();
}
