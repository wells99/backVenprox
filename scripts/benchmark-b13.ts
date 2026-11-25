import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cpus,totalmem,platform,release } from 'node:os';
import { writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'mysql2/promise';
import { Value } from 'typebox/value';
import { syncFixture } from '../tests/sync-fixture.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { sqliteBusinessUnitOfWork } from '../packages/infrastructure/sqlite/src/business.js';
import { sqliteLocalSyncUnitOfWork } from '../packages/infrastructure/sqlite/src/local-sync.js';
import { mysqlSyncUnitOfWork,atomicSyncPublication } from '../packages/infrastructure/mysql/src/sync.js';
import { CatalogService } from '../packages/application/src/catalog-service.js';
import { StockService } from '../packages/application/src/stock-service.js';
import { CashService } from '../packages/application/src/cash-service.js';
import { SalesService } from '../packages/application/src/sales-service.js';
import { LocalSyncService } from '../packages/application/src/local-sync-service.js';
import { SyncService } from '../packages/application/src/sync-service.js';
import type { SyncEnvelope as Envelope,SyncReceipt as Receipt } from '../packages/application/src/sync-ports.js';
import { SyncEnvelope,SyncReceipt,PushResponse } from '../packages/contracts/src/sync.js';
import { syncEnvelopeHash } from '../packages/infrastructure/security/src/sync-validation.js';
import { buildApi } from '../apps/api/src/app.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { ApplicationError } from '../packages/application/src/application-error.js';

// Destructive cleanup is exclusively the named disposable fixture. Never uses
// the store's configured database, never sends a real terminal's outbox.
assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_PORT,'3308');
const targetOperations=Number(process.env.B13_LOAD_OPERATIONS??10000);assert.ok(Number.isSafeInteger(targetOperations)&&targetOperations>=60&&targetOperations<=10000);
const f=await syncFixture('b13_load'),others:SqliteStore[]=[];
const second=await MysqlStore.connect(f.options,{store_id:f.identity.store_id});
const apis=[f.store,second].map((store)=>buildApi({environment:'test',logger:createLogger('b13-load','silent'),ids:f.deps.ids,getCompatibility:createGetCompatibility(createCompatibilityPolicy('0.1.0',[1]),'0.1.0'),auth:{service:f.auth,origin:'http://127.0.0.1',secureCookies:false,sync:new SyncService({...f.deps,unitOfWork:mysqlSyncUnitOfWork(store),publication:atomicSyncPublication})}}));
const terminals=[{store:f.local,deps:f.localDeps,context:f.context,device:f.device}],localMs:number[]=[],remoteMs:number[]=[];
const batchSize=20;let uncertainRetries=0;
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]??0;
const counters=async()=>{const connection=await createConnection(f.options);try{const [rows]=await connection.query("SHOW GLOBAL STATUS WHERE Variable_name IN('Innodb_deadlocks','Innodb_data_read','Innodb_data_written')");return Object.fromEntries((rows as {Variable_name:string;Value:string}[]).map((r)=>[r.Variable_name,Number(r.Value)]));}finally{await connection.end();}};
const opening={opening_cents:0,business_date:'2026-11-25',time_zone:'America/Sao_Paulo'};
try{
  for(let index=1;index<3;index++){
    const device=await f.newDevice(),store=SqliteStore.open(join(f.directory,`terminal-${index}.db`),{store_id:f.identity.store_id,device_id:device.id},true);others.push(store);await store.migrate();await store.provisionIdentity();
    const deps={...f.localDeps,unitOfWork:sqliteBusinessUnitOfWork(store),deviceId:device.id},context={...f.context,device_id:device.id};await deps.unitOfWork.run((tx)=>tx.business.saveProduct(f.product));terminals.push({store,deps,context,device});
  }
  // Local commits while both HTTP servers are stopped. No offline login is enabled.
  await Promise.all(terminals.map(async(t)=>{
    const cash=new CashService(t.deps),stock=new StockService(t.deps),sales=new SalesService(t.deps,async()=>t.device.code);
    await stock.registerEntry(t.context,randomUUID(),{product_id:f.product.id,quantity_milli:1000,unit_cost_cents:5,reason:'Ensaio três terminais'});
    const session=(await cash.open(t.context,randomUUID(),opening)).session;
    const id=randomUUID();await sales.createDraft(t.context,randomUUID(),id,{items:[{id:randomUUID(),product_id:f.product.id,expected_product_version:1,quantity_milli:1000}],customer_id:null,note:null,discount_cents:0});
    const start=performance.now();await sales.complete(t.context,randomUUID(),{sale_id:id,session_id:session.id,expected_draft_version:1,expected_settings_version:t===terminals[0]?2:1,payments:[{id:randomUUID(),method:'cash',applied_cents:100,tendered_cents:100,change_cents:0}]});localMs.push(performance.now()-start);
  }));
  const urls=await Promise.all(apis.map((api)=>api.listen({host:'127.0.0.1',port:0})));
  // More local sales with the remote API reachable; writes still commit locally.
  await Promise.all(terminals.map(async(t)=>{
    const stock=new StockService(t.deps),cash=new CashService(t.deps),sales=new SalesService(t.deps,async()=>t.device.code);
    await stock.registerEntry(t.context,randomUUID(),{product_id:f.product.id,quantity_milli:1000,unit_cost_cents:null,reason:'Ensaio online'});
    const session=(await cash.current(t.context)).session!;const id=randomUUID();
    await sales.createDraft(t.context,randomUUID(),id,{items:[{id:randomUUID(),product_id:f.product.id,expected_product_version:1,quantity_milli:1000}],customer_id:null,note:null,discount_cents:0});
    const start=performance.now();await sales.complete(t.context,randomUUID(),{sale_id:id,session_id:session.id,expected_draft_version:1,expected_settings_version:t===terminals[0]?2:1,payments:[{id:randomUUID(),method:'pix',applied_cents:100,tendered_cents:100,change_cents:0}]});localMs.push(performance.now()-start);
  }));
  // Strict stock is a local guarantee: CX02 has no stock, CX01 still has stock.
  const strict=terminals[1]!;await strict.deps.unitOfWork.run(async(tx)=>{const settings=await tx.business.settings();await tx.business.saveSettings({...settings,stock_policy:'require_stock',version:2});});
  const strictSales=new SalesService(strict.deps,async()=>strict.device.code),strictId=randomUUID(),strictCash=(await new CashService(strict.deps).current(strict.context)).session!;
  await strictSales.createDraft(strict.context,randomUUID(),strictId,{items:[{id:randomUUID(),product_id:f.product.id,expected_product_version:1,quantity_milli:1000}],customer_id:null,note:null,discount_cents:0});
  await assert.rejects(strictSales.complete(strict.context,randomUUID(),{sale_id:strictId,session_id:strictCash.id,expected_draft_version:1,expected_settings_version:2,payments:[{id:randomUUID(),method:'cash',applied_cents:100,tendered_cents:100,change_cents:0}]}),(e:unknown)=>e instanceof ApplicationError&&e.code==='INSUFFICIENT_LOCAL_STOCK');
  assert.ok((await terminals[0]!.deps.unitOfWork.run((tx)=>tx.business.balance(f.product.id))).quantity_milli>0);
  let count=terminals.reduce((sum,t)=>sum+Number((t.store.database.prepare('SELECT COUNT(*) AS n FROM operation_outbox').get() as {n:number}).n),0);
  const versions=await Promise.all(terminals.map((t)=>t.deps.unitOfWork.run((tx)=>tx.business.terminalSettings(t.device.id).then((v)=>v.version))));
  const preparedAt=performance.now();
  while(count<targetOperations){const index=count%3,t=terminals[index]!;await new CatalogService(t.deps).changeTerminalSettings(t.context,randomUUID(),versions[index]!,false);versions[index]!++;count++;}
  const events=terminals.map((t)=>{
    const rows=t.store.database.prepare('SELECT operation_id,CAST(device_seq AS TEXT) AS sequence,event_type,occurred_at,payload,authorization_context FROM operation_outbox ORDER BY operation_outbox.device_seq').all() as {operation_id:string;sequence:string;event_type:string;occurred_at:string;payload:string;authorization_context:string}[];
    return rows.map((row)=>{const envelope:Envelope={protocol_version:1,payload_version:1,store_id:f.identity.store_id,device_id:t.device.id,operation_id:row.operation_id,device_seq:row.sequence,type:row.event_type,occurred_at_device:row.occurred_at,origin_authorization:{context:JSON.parse(row.authorization_context),signature:null},dependencies:[],payload:JSON.parse(row.payload),payload_hash:'0'.repeat(64)};envelope.payload_hash=syncEnvelopeHash(envelope);return envelope;});
  });
  assert.equal(events.flat().length,targetOperations);
  const send=async(index:number,batch:Envelope[],apiIndex:number)=>{
    const start=performance.now();let response:Response|undefined;
    for(let attempt=0;attempt<5;attempt++){
      try{response=await fetch(`${urls[(apiIndex+attempt)%2]}/api/v1/sync/push`,{method:'POST',headers:{'content-type':'application/json','x-device-credential':terminals[index]!.device.credential},body:JSON.stringify({items:batch}),signal:AbortSignal.timeout(60000)});break;}
      catch(error){uncertainRetries++;if(attempt===4)throw error;}
    }
    assert.ok(response);
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));assert.ok(Value.Check(PushResponse,value));remoteMs.push(performance.now()-start);return (value as {data:{items:Receipt[]}}).data.items;
  };
  // A fourth, blocked test device proves isolation without occupying a real
  // sequence of the three converging cash registers (B12 resolution is pending).
  const blocked=await f.newDevice(),blockedEvent=f.clone(events[0]![0]!,{device_id:blocked.id,device_seq:'2',operation_id:randomUUID()});blockedEvent.origin_authorization.context.device_id=blocked.id;blockedEvent.payload_hash=syncEnvelopeHash(blockedEvent);
  const blockedReply=await fetch(`${urls[0]}/api/v1/sync/push`,{method:'POST',headers:{'content-type':'application/json','x-device-credential':blocked.credential},body:JSON.stringify({items:[blockedEvent]})});assert.equal((await blockedReply.json() as {data:{items:Receipt[]}}).data.items[0]!.status,'blocked');
  const services=terminals.map((t)=>new LocalSyncService({unitOfWork:sqliteLocalSyncUnitOfWork(t.store),storeId:f.identity.store_id,deviceId:t.device.id,clock:t.deps.clock,ids:t.deps.ids,hashEnvelope:syncEnvelopeHash,validateEnvelope:(v)=>Value.Check(SyncEnvelope,v),validateReceipt:(v)=>Value.Check(SyncReceipt,v),random:()=>1}));await Promise.all(services.map((s)=>s.initialize()));
  const initialCounters=await counters(),cpu=process.cpuUsage(),usage=process.resourceUsage(),started=performance.now();let drained=0;
  const processCounters=[{...f.store.metrics},{...second.metrics}];
  const consume=async(index:number,offset=0)=>{
    const list=events[index]!,s=services[index]!;
    for(let after=offset;after<list.length;after+=batchSize){
      const batch=list.slice(after,after+batchSize);let receipts=await send(index,batch,(index+after/batchSize)%2);
      assert.ok(receipts.every((r)=>r.status==='applied'||r.status==='duplicate'),JSON.stringify(receipts));
      if(after===0){const original=receipts;receipts=await send(index,batch,1-(index%2));assert.ok(receipts.every((r)=>r.status==='duplicate'));assert.deepEqual(receipts.map((r)=>r.result),original.map((r)=>r.result));}
      for(const receipt of receipts){const row=await s.prepareNext();assert.ok(row);assert.equal(row.operation_id,receipt.operation_id);await s.markSending(row.operation_id);await s.acceptReceipt(row.operation_id,receipt);drained++;}
      if(drained%1000<batchSize)console.log(JSON.stringify({event:'b13_drain_progress',received:drained,total:targetOperations}));
    }
  };
  // Reconnect in reverse terminal order, then keep one chain per device in flight.
  const first=events[2]!.slice(0,batchSize),firstReceipts=await send(2,first,0);for(const r of firstReceipts){const row=(await services[2]!.prepareNext())!;await services[2]!.markSending(row.operation_id);await services[2]!.acceptReceipt(row.operation_id,r);drained++;}
  await Promise.all([consume(2,batchSize),consume(1),consume(0)]);
  assert.equal(drained,targetOperations);const elapsed=performance.now()-started;
  const connection=await createConnection(f.options);try{
    const [inbox]=await connection.query("SELECT COUNT(*) AS n FROM server_inbox WHERE state='applied'");assert.equal(Number((inbox as {n:number}[])[0]!.n),targetOperations);
    const [receivedSales]=await connection.query('SELECT id,number FROM sales');const localSales=terminals.flatMap((t)=>t.store.database.prepare('SELECT id,number FROM sales').all() as {id:string;number:string}[]);assert.equal((receivedSales as unknown[]).length,localSales.length);assert.equal(new Set(localSales.map((s)=>s.number)).size,localSales.length);
    assert.deepEqual((receivedSales as {id:string;number:string}[]).map((s)=>`${s.id}:${s.number}`).sort(),localSales.map((s)=>`${s.id}:${s.number}`).sort());
    for(const t of terminals){
      const local=t.store.database.prepare('SELECT session_id,method,SUM(amount_cents) AS total FROM cash_movements GROUP BY session_id,method').all() as {session_id:string;method:string;total:number}[];
      for(const row of local){const [remote]=await connection.query('SELECT SUM(amount_cents) AS total FROM cash_movements WHERE store_id=? AND session_id=? AND method=?',[f.identity.store_id,row.session_id,row.method]);assert.equal(Number((remote as {total:string}[])[0]!.total),row.total);}
    }
    const localStock=terminals.reduce((sum,t)=>sum+Number((t.store.database.prepare('SELECT COALESCE(SUM(delta_milli),0) AS n FROM stock_movements').get() as {n:number}).n),0);assert.equal((await f.businessDeps.unitOfWork.run((tx)=>tx.business.balance(f.product.id))).quantity_milli,localStock);
    const [blockedRows]=await connection.query("SELECT COUNT(*) AS n FROM server_inbox WHERE device_id=? AND state='blocked'",[blocked.id]);assert.equal(Number((blockedRows as {n:number}[])[0]!.n),1);
  }finally{await connection.end();}
  for(let index=0;index<3;index++){const status=await services[index]!.getStatus(terminals[index]!.context);assert.equal(status.pending,0);assert.equal(status.acknowledged,events[index]!.length);assert.equal(status.automatic_sync_enabled,false);}
  const finalCounters=await counters(),finalUsage=process.resourceUsage(),report={schema:13,operations:targetOperations,terminals:terminals.map((t)=>t.device.code),separate_sqlites:3,api_instances:2,blocked_extra_device_isolated:true,duplicate_batches:2,financial_sales:terminals.reduce((n,t)=>n+Number((t.store.database.prepare('SELECT COUNT(*) AS n FROM sales').get() as {n:number}).n),0),offline_login_enabled:false,local_strict_scope:true,preparation_ms:Math.round(started-preparedAt),drain_ms:Math.round(elapsed),operations_per_second:Math.round(targetOperations*1000/elapsed),local_sale_p95_ms:Math.ceil(percentile(localMs,.95)),http_batch_p95_ms:Math.ceil(percentile(remoteMs,.95)),cpu_microseconds:process.cpuUsage(cpu),filesystem_io_delta:{reads:finalUsage.fsRead-usage.fsRead,writes:finalUsage.fsWrite-usage.fsWrite},mysql_instance_deltas:Object.fromEntries(Object.keys(initialCounters).map((key)=>[key,finalCounters[key]!-initialCounters[key]!])),hardware:{os:`${platform()} ${release()}`,cpu:cpus()[0]?.model,logical_cpus:cpus().length,memory_bytes:totalmem(),node:process.version},verified:{ids:true,cash_by_session:true,stock_ledger:true,receipts:true,no_local_pending:true}};
  const transactionDeltas=Object.fromEntries(Object.keys(f.store.metrics).map((key)=>[key,[f.store,second].reduce((sum,store,index)=>sum+store.metrics[key as keyof typeof store.metrics]-processCounters[index]![key as keyof typeof store.metrics],0)]));
  const finalReport={...report,batch_size:batchSize,uncertain_response_retries:uncertainRetries,mysql_process_deltas:transactionDeltas};await mkdir('artifacts',{recursive:true});await writeFile(targetOperations===10000?'artifacts/b13-benchmark.json':`artifacts/b13-benchmark-${targetOperations}.json`,JSON.stringify(finalReport,null,2));console.log(JSON.stringify(finalReport));
}finally{await Promise.all(apis.map((api)=>api.close()));await second.close();for(const store of others)await store.close();await f.close();}
