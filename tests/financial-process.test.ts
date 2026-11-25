import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { Value } from 'typebox/value';
import { financialFixture } from './financial-fixture.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { sqliteBusinessUnitOfWork } from '../packages/infrastructure/sqlite/src/business.js';
import { AuthService } from '../packages/application/src/auth-service.js';
import type { Product } from '../packages/application/src/business-ports.js';
import { authUnitOfWork } from '../packages/infrastructure/mysql/src/auth-repository.js';
import { provisionAuth } from '../packages/infrastructure/mysql/src/auth-provision.js';
import { createAuthCrypto, generateAuthKeys } from '../packages/infrastructure/security/src/crypto.js';
import { buildApi } from '../apps/api/src/app.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { businessDate } from '../packages/domain/src/cash.js';
import { BusinessIpcResponse } from '../packages/contracts/src/catalog-stock.js';
import { SaleCompletedEvent } from '../packages/contracts/src/sales.js';

test('B07/B08 processo Windows real: login online, venda sem servidor, reinício e recuperação sem habilitar offline',{skip:!process.env.MYSQL_PASSWORD,timeout:120000},async()=>{
  const f=await financialFixture('mysql','b08_ipc');assert.ok(f.store instanceof MysqlStore);
  const keys=generateAuthKeys(),crypto=createAuthCrypto(keys.privateKey,keys.fingerprintKey),token=crypto.token(),password='Laboratory-only-password-123!';
  const service=new AuthService({unitOfWork:authUnitOfWork(f.store),storeId:f.identity.store_id,crypto,clock:{now:()=>new Date()},ids:{generate:randomUUID}});
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const address=reserve.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>((done,reject)=>reserve.close((error)=>error?reject(error):done()));
  const origin=`http://127.0.0.1:${port}`,makeApp=()=>buildApi({environment:'test',ids:{generate:randomUUID},logger:createLogger('financial-process','silent'),auth:{service,origin,secureCookies:false},getCompatibility:createGetCompatibility(createCompatibilityPolicy('0.1.0',[1]),'0.1.0')});
  let app=makeApp(),child:ChildProcess|undefined;const path=join(f.directory,'ipc-terminal.db'),logs:string[]=[];
  const start=async()=>{const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MYSQL_')&&!key.startsWith('AUTH_')));
    child=fork(resolve('apps/local-service/src/main.ts'),[],{execArgv:['--import','tsx'],env:{...env,NODE_ENV:'test',LOG_LEVEL:'silent',LOCAL_DATABASE_PATH:path,STORE_ID:f.identity.store_id,DEVICE_ID:f.identity.device_id,AUTH_API_ORIGIN:origin},stdio:['ignore','pipe','pipe','ipc']});
    child.stdout?.on('data',(value)=>logs.push(String(value)));child.stderr?.on('data',(value)=>logs.push(String(value)));
    assert.equal((await once(child,'message',{signal:AbortSignal.timeout(15000)}))[0].type,'ready');
  };
  const send=async(command:object)=>{assert.ok(child);const reply=once(child,'message',{signal:AbortSignal.timeout(15000)});child.send({...command,request_id:'financial-ipc'});const [result]=await reply;if(result.type==='business.result')assert.ok(Value.Check(BusinessIpcResponse,result),JSON.stringify(result));return result;};
  const stop=async()=>{assert.ok(child);const exited=once(child,'exit',{signal:AbortSignal.timeout(15000)});child.send({type:'shutdown',request_id:'stop'});assert.equal((await exited)[0],0);child=undefined;};
  try{
    await provisionAuth(f.options,f.identity.store_id,crypto.digest(token),new Date(Date.now()+3600000).toISOString(),0);
    await service.activate({installation_token:token,store_name:'Laboratório IPC',login:'owner',name:'Dono',password},'test');const login=await service.login('owner',password,'test'),invite=await service.invitation(login.access);
    const created=await f.catalog.createProduct(f.context,randomUUID(),{name:'Produto IPC',internal_code:'IPC',unit:'unit',price_cents:100,cost_cents:null}) as Product;
    const product=(await f.deps.unitOfWork.run((tx)=>tx.business.product(created.id)))!;
    const local=SqliteStore.open(path,f.identity,true);try{await local.migrate();await local.provisionIdentity();await sqliteBusinessUnitOfWork(local).run((tx)=>tx.business.saveProduct(product));}finally{await local.close();}
    await app.listen({host:'127.0.0.1',port});await start();
    assert.equal((await send({type:'device.enroll',invitation_token:invite.invitation_token})).data.paired,true);
    const auth=await send({type:'auth.loginOnline',login:'owner',password});assert.equal(auth.type,'auth.result');assert.ok(auth.data.context.permissions.includes('sales.discount'));
    assert.equal((await send({type:'device.getStatus'})).data.offline_enabled,false);
    await app.close(); // Sem servidor de identidade/sync durante as escritas locais.
    const opened=await send({type:'cash.open',intention_id:randomUUID(),input:{opening_cents:0,business_date:businessDate(new Date().toISOString(),'America/Sao_Paulo'),time_zone:'America/Sao_Paulo'}});assert.equal(opened.type,'business.result');
    const saleId=randomUUID(),intent=randomUUID(),draftInput={items:[{id:randomUUID(),product_id:product.id,expected_product_version:1,quantity_milli:1000},{id:randomUUID(),product_id:null,description:'Avulso IPC',price_cents:100,quantity_milli:1000}],customer_id:null,note:null,discount_cents:1};
    assert.equal((await send({type:'sales.createDraft',sale_id:saleId,intention_id:randomUUID(),input:draftInput})).data.draft.totals.total_cents,199);
    const input={sale_id:saleId,session_id:opened.data.session.id,expected_draft_version:1,expected_settings_version:1,payments:[{id:randomUUID(),method:'cash',applied_cents:99,tendered_cents:200,change_cents:101},{id:randomUUID(),method:'pix',applied_cents:100,tendered_cents:100,change_cents:0}]};
    const completed=await send({type:'sales.complete',intention_id:intent,input});assert.equal(completed.type,'business.result');assert.equal(completed.data.completion.sync_status,'pending');assert.equal(completed.data.completion.sale.total_cents,199);await stop();
    const persisted=SqliteStore.open(path,f.identity);try{
      for(const [table,count] of [['sales',1],['sale_items',2],['sale_payments',2],['stock_movements',1],['cash_movements',3],['operation_outbox',2]])assert.equal((persisted.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n,count);
      const event=persisted.database.prepare("SELECT payload FROM operation_outbox WHERE event_type='sale.completed'").get() as {payload:string};assert.ok(Value.Check(SaleCompletedEvent,JSON.parse(event.payload)));
    }finally{await persisted.close();}
    await start();assert.equal((await send({type:'sales.getCompletionResult',intention_id:intent})).error.code,'AUTHENTICATION_REQUIRED');assert.equal((await send({type:'auth.loginOffline',login:'owner',password})).error.code,'OFFLINE_DISABLED');
    app=makeApp();await app.listen({host:'127.0.0.1',port});assert.equal((await send({type:'auth.loginOnline',login:'owner',password})).type,'auth.result');
    assert.deepEqual((await send({type:'sales.getCompletionResult',intention_id:intent})).data,completed.data);
    await app.close();assert.deepEqual((await send({type:'sales.complete',intention_id:intent,input})).data,completed.data);
    const preview=await send({type:'cash.previewClose',session_id:opened.data.session.id});assert.equal(preview.type,'business.result');
    const closed=await send({type:'cash.close',intention_id:randomUUID(),input:{session_id:opened.data.session.id,expected_version:preview.data.preview.session_version,expected_device_seq:preview.data.preview.previous_device_seq,counted_by_method:preview.data.preview.expected_by_method,reason:null}});assert.equal(closed.data.closure.state,'closed_local');
    const next=await send({type:'cash.open',intention_id:randomUUID(),input:{opening_cents:0,business_date:businessDate(new Date().toISOString(),'America/Sao_Paulo'),time_zone:'America/Sao_Paulo'}});
    const reversed=await send({type:'sales.reverse',intention_id:randomUUID(),input:{sale_id:saleId,session_id:next.data.session.id,reason:'Cancelamento de laboratório',payments:[{id:randomUUID(),method:'cash',amount_cents:99},{id:randomUUID(),method:'pix',amount_cents:100}]}});assert.equal(reversed.data.reversal.total_cents,199);
    assert.deepEqual((await send({type:'cash.getClosure',session_id:opened.data.session.id})).data,closed.data);await stop();
    assert.equal(logs.join('').includes(password),false);
  }finally{if(child){const exited=once(child,'exit');child.kill();await exited;}await app.close();await f.close();}
});
