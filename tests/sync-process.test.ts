import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Value } from 'typebox/value';
import { financialFixture } from './financial-fixture.js';
import { AuthService } from '../packages/application/src/auth-service.js';
import { CatalogService } from '../packages/application/src/catalog-service.js';
import { SyncService } from '../packages/application/src/sync-service.js';
import { SyncResolutionService } from '../packages/application/src/sync-resolution-service.js';
import { DownloadService } from '../packages/application/src/download-service.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { authUnitOfWork } from '../packages/infrastructure/mysql/src/auth-repository.js';
import { provisionAuth } from '../packages/infrastructure/mysql/src/auth-provision.js';
import { mysqlSyncUnitOfWork,atomicSyncPublication } from '../packages/infrastructure/mysql/src/sync.js';
import { createAuthCrypto,generateAuthKeys } from '../packages/infrastructure/security/src/crypto.js';
import { syncHashValue,syncEnvelopeHash,validateSyncPayload } from '../packages/infrastructure/security/src/sync-validation.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { buildApi } from '../apps/api/src/app.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { businessDate } from '../packages/domain/src/cash.js';
import { LocalSyncResponse } from '../packages/contracts/src/local-sync.js';
import type { Product } from '../packages/application/src/business-ports.js';

test('B12 processo nativo: agenda real, venda sem rede, retomada e resolução IPC protegida',{skip:!process.env.MYSQL_PASSWORD,timeout:120000},async()=>{
  const f=await financialFixture('mysql','b12_ipc');assert.ok(f.store instanceof MysqlStore);
  const clock={now:()=>new Date()},keys=generateAuthKeys(),crypto=createAuthCrypto(keys.privateKey,keys.fingerprintKey),token=crypto.token(),password='Native-sync-test-only-password-123!';
  const auth=new AuthService({unitOfWork:authUnitOfWork(f.store),storeId:f.identity.store_id,clock,ids:f.deps.ids,crypto}),uow=mysqlSyncUnitOfWork(f.store);
  const sync=new SyncService({unitOfWork:uow,storeId:f.identity.store_id,clock,ids:f.deps.ids,digest:crypto.digest,hashEnvelope:syncEnvelopeHash,hashValue:syncHashValue,validatePayload:validateSyncPayload,verifyOriginSignature:(s)=>crypto.verifyGrant(s,crypto.publicKey()),publication:atomicSyncPublication,writesEnabled:true});
  const download=new DownloadService({unitOfWork:uow,storeId:f.identity.store_id,clock,ids:f.deps.ids,digest:crypto.digest,hash:syncHashValue,bytes:(v)=>Buffer.byteLength(JSON.stringify(v))}),resolutions=new SyncResolutionService({...sync.deps,unitOfWork:uow});
  const options={service:auth,origin:'http://127.0.0.1',secureCookies:false,sync,download,resolutions},makeApp=()=>buildApi({logger:createLogger('b12-native','silent'),ids:f.deps.ids,auth:options,getCompatibility:createGetCompatibility(createCompatibilityPolicy('0.1.0',[1]),'0.1.0')});
  let app=makeApp(),child:ChildProcess|undefined,origin='',port=0;
  const logs:string[]=[],path=join(f.directory,'native-sync.db');
  const start=async()=>{
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MYSQL_')&&!key.startsWith('AUTH_')&&!key.startsWith('LOCAL_SYNC_')));
    child=fork(resolve('apps/local-service/src/main.ts'),[],{execArgv:['--import','tsx'],env:{...env,NODE_ENV:'test',LOG_LEVEL:'silent',LOCAL_DATABASE_PATH:path,STORE_ID:f.identity.store_id,DEVICE_ID:f.identity.device_id,AUTH_API_ORIGIN:origin,LOCAL_SYNC_ENABLED:'true',LOCAL_SYNC_POLL_MS:'1000'},stdio:['ignore','pipe','pipe','ipc']});
    child.stdout?.on('data',(v)=>logs.push(String(v)));child.stderr?.on('data',(v)=>logs.push(String(v)));
    assert.equal((await once(child,'message',{signal:AbortSignal.timeout(15000)}))[0].type,'ready');
  };
  // IPC replies are validated by the production process before crossing the native boundary.
  const send=async(command:object)=>{assert.ok(child);const received=once(child,'message',{signal:AbortSignal.timeout(15000)});child.send({...command,request_id:'b12-native'});const result=(await received)[0];if(result.type==='sync.result')assert.ok(Value.Check(LocalSyncResponse,result),JSON.stringify(result));return result;};
  const wait=async(predicate:(value:Awaited<ReturnType<typeof send>>)=>boolean)=>{const until=Date.now()+20000;let result;do{result=await send({type:'sync.getStatus'});if(predicate(result))return result;await delay(100);}while(Date.now()<until);assert.fail(`Sincronização não terminou: ${JSON.stringify(result)}`);};
  const stop=async()=>{assert.ok(child);const exited=once(child,'exit',{signal:AbortSignal.timeout(15000)});child.send({type:'shutdown',request_id:'stop'});assert.equal((await exited)[0],0);child=undefined;};
  try{
    await provisionAuth(f.options,f.identity.store_id,crypto.digest(token),new Date(Date.now()+3600000).toISOString(),0);await auth.activate({installation_token:token,store_name:'Native sync lab',login:'owner',name:'Administrador',password},'test');const login=await auth.login('owner',password,'test'),invite=await auth.invitation(login.access),context={...login.context,device_id:f.identity.device_id};
    const catalog=new CatalogService({...f.deps,local:false,remoteWritesEnabled:true,clock}),product=await catalog.createProduct(context,randomUUID(),{name:'Produto remoto',internal_code:'NATIVE',unit:'unit',price_cents:100}) as Product;
    const local=SqliteStore.open(path,f.identity,true);try{await local.migrate();await local.provisionIdentity();}finally{await local.close();}
    origin=await app.listen({host:'127.0.0.1',port:0});options.origin=origin;port=Number(new URL(origin).port);await start();
    assert.equal((await send({type:'device.enroll',invitation_token:invite.invitation_token})).data.paired,true);assert.equal((await send({type:'auth.loginOnline',login:'owner',password})).type,'auth.result');
    const ready=await wait((r)=>r.data?.phase==='idle');assert.equal(ready.data.automatic_sync_enabled,true);assert.equal((await send({type:'device.getStatus'})).data.offline_enabled,false);
    const products=await send({type:'catalog.search',entity_type:'products',query:{}});assert.equal(products.data.items[0].id,product.id);
    await app.close();
    const entry=await send({type:'stock.registerEntry',intention_id:randomUUID(),input:{product_id:product.id,quantity_milli:2000,unit_cost_cents:5,reason:'Recebido sem rede'}});assert.equal(entry.type,'business.result');
    const opened=await send({type:'cash.open',intention_id:randomUUID(),input:{opening_cents:0,business_date:businessDate(new Date().toISOString(),'America/Sao_Paulo'),time_zone:'America/Sao_Paulo'}});assert.equal(opened.type,'business.result');
    const sale=randomUUID(),operation=randomUUID();assert.equal((await send({type:'sales.createDraft',intention_id:randomUUID(),sale_id:sale,input:{items:[{id:randomUUID(),product_id:product.id,expected_product_version:1,quantity_milli:1000}],customer_id:null,note:null,discount_cents:0}})).type,'business.result');
    assert.equal((await send({type:'sales.complete',intention_id:operation,input:{sale_id:sale,session_id:opened.data.session.id,expected_draft_version:1,expected_settings_version:1,payments:[{id:randomUUID(),method:'cash',applied_cents:100,tendered_cents:100,change_cents:0}]}})).type,'business.result');assert.equal((await send({type:'sync.getStatus'})).data.pending,3);
    app=makeApp();await app.listen({host:'127.0.0.1',port});assert.equal((await send({type:'sync.requestRetry'})).data.automatic_sync_enabled,true);await wait((r)=>r.data?.pending===0&&r.data.phase==='idle');assert.equal(await f.count('sales'),1);assert.equal((await f.deps.unitOfWork.run((tx)=>tx.business.balance(product.id))).quantity_milli,1000);
    const proposal=randomUUID();assert.equal((await send({type:'products.proposeUpdate',id:product.id,intention_id:proposal,input:{expected_version:1,price_cents:250}})).type,'business.result');await catalog.updateProduct(context,product.id,randomUUID(),1,{name:'Nome web preservado',price_cents:150});await wait((r)=>r.data?.conflicts>=1&&r.data.pending===0);
    const resolution=await send({type:'sync.submitResolution',intention_id:randomUUID(),operation_id:proposal,expected_version:1,action:'reapply_proposal',expected_entity_version:2,patch:{price_cents:250},reason:'Administrador conferiu a proposta e manteve o nome atualizado na web'});assert.equal(resolution.type,'sync.result',JSON.stringify(resolution));assert.equal(resolution.data.outcome,'accepted');await wait((r)=>r.data?.conflicts===0&&r.data.phase==='idle');
    const updated=await send({type:'catalog.search',entity_type:'products',query:{}});assert.equal(updated.data.items[0].name,'Nome web preservado');assert.equal(updated.data.items[0].price_cents,250);
    await stop();await start();assert.equal((await send({type:'auth.getContext'})).error.code,'AUTHENTICATION_REQUIRED');assert.equal((await send({type:'auth.loginOffline',login:'owner',password})).error.code,'OFFLINE_DISABLED');assert.equal((await send({type:'auth.loginOnline',login:'owner',password})).type,'auth.result');await wait((r)=>r.data?.pending===0&&r.data.phase==='idle');assert.equal(await f.count('sales'),1);await stop();
    assert.equal(logs.join('').includes(password),false);
  }finally{if(child){const exited=once(child,'exit');child.kill();await exited;}await app.close();await f.close();}
});
