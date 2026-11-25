import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConnection } from 'mysql2/promise';
import { Value } from 'typebox/value';
import { syncFixture } from './sync-fixture.js';
import { fails } from './financial-fixture.js';
import { SyncCoordinator } from '../packages/application/src/sync-coordinator.js';
import { LocalSyncResolutionService } from '../packages/application/src/local-sync-resolution.js';
import { SyncResolutionService } from '../packages/application/src/sync-resolution-service.js';
import { SyncService } from '../packages/application/src/sync-service.js';
import { DownloadService } from '../packages/application/src/download-service.js';
import { CatalogService } from '../packages/application/src/catalog-service.js';
import { StockService } from '../packages/application/src/stock-service.js';
import { CashService } from '../packages/application/src/cash-service.js';
import { SalesService } from '../packages/application/src/sales-service.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import type { PairedDevice } from '../packages/application/src/local-auth.js';
import type { ResolutionCommand,ResolutionResult as Result } from '../packages/application/src/sync-resolution-ports.js';
import { sqliteCoordinatorUnitOfWork } from '../packages/infrastructure/sqlite/src/sync-replica.js';
import { sqliteBusinessUnitOfWork } from '../packages/infrastructure/sqlite/src/business.js';
import { sqliteAuthCache } from '../packages/infrastructure/sqlite/src/auth-cache.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { mysqlSyncUnitOfWork,atomicSyncPublication } from '../packages/infrastructure/mysql/src/sync.js';
import { syncGateway,syncHttpClient } from '../packages/infrastructure/security/src/sync-gateway.js';
import { syncEnvelopeHash,syncHashValue } from '../packages/infrastructure/security/src/sync-validation.js';
import { SyncEnvelope,SyncReceipt } from '../packages/contracts/src/sync.js';
import { ResolutionResponse } from '../packages/contracts/src/sync-resolutions.js';
import { localSyncCommands } from '../packages/contracts/src/local-sync.js';
import { buildApi } from '../apps/api/src/app.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { syncLoop } from '../packages/infrastructure/runtime/src/sync-loop.js';
import { loadLocalConfig } from '../packages/infrastructure/runtime/src/config.js';

test('B12 IPC de resolução fechado e configuração explícita',()=>{
  const command={type:'sync.submitResolution',request_id:'test',intention_id:randomUUID(),operation_id:randomUUID(),expected_version:1,action:'confirm_original',reason:'Conferência identificada'};
  assert.ok(Value.Check(localSyncCommands,command));
  for(const extra of [{sql:'DELETE FROM sales'},{permissions:['recovery.manage']},{device_credential:'secret'},{payload:{}}])assert.equal(Value.Check(localSyncCommands,{...command,...extra}),false);
  assert.equal(loadLocalConfig({LOCAL_DATABASE_PATH:':memory:'}).syncEnabled,false);
  assert.throws(()=>loadLocalConfig({LOCAL_DATABASE_PATH:':memory:',LOCAL_SYNC_ENABLED:'yes'}));
  assert.throws(()=>loadLocalConfig({LOCAL_DATABASE_PATH:':memory:',LOCAL_SYNC_ENABLED:'true'}));
});
test('B12 agendador serializa, acorda e encerra sem novo ciclo',async()=>{
  let release!:()=>void,started!:()=>void,calls=0;
  const entered=new Promise<void>((r)=>{started=r;}),wait=new Promise<void>((r)=>{release=r;});
  const loop=syncLoop(async()=>{calls++;started();await wait;},60000,()=>assert.fail('cycle failed'));
  await entered;loop.wake();const stopped=loop.stop();release();await stopped;assert.equal(calls,1);
});
test('B12 coordenador HTTP real, snapshots, conflitos e revisão atômica',{skip:!process.env.MYSQL_PASSWORD,timeout:240000},async(t)=>{
  const f=await syncFixture('b12_final'),uow=mysqlSyncUnitOfWork(f.store),remote=new SyncService({...f.deps,publication:atomicSyncPublication}),resolutions=new SyncResolutionService({...f.deps,clock:f.businessDeps.clock,unitOfWork:uow,publication:atomicSyncPublication});
  const download=new DownloadService({unitOfWork:uow,storeId:f.identity.store_id,clock:f.businessDeps.clock,ids:f.deps.ids,digest:f.crypto.digest,hash:syncHashValue,bytes:(v)=>Buffer.byteLength(JSON.stringify(v))});
  const auth={service:f.auth,origin:'http://127.0.0.1',secureCookies:false,sync:remote,download,resolutions};
  const app=buildApi({logger:createLogger('b12-test','silent'),ids:f.deps.ids,getCompatibility:createGetCompatibility(createCompatibilityPolicy('0.1.0',[1]),'0.1.0'),auth});
  let local=f.local,origin='',dropSale=true,coordinator:SyncCoordinator;
  const device:PairedDevice={store_id:f.identity.store_id,device_id:f.device.id,code:f.device.code,device_credential:f.device.credential,grant_public_key:f.crypto.publicKey(),offline_enabled:false,session:{cookies:`venprox_access=${f.login.access}`,csrf:f.login.csrf}};
  const sql=async(query:string,args:unknown[]=[])=>{const c=await createConnection(f.options);try{await c.query(query,args);}finally{await c.end();}};
  const localRows=(table:string)=>{assert.match(table,/^[a-z_]+$/);return local.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();};
  const facts=()=>Object.fromEntries(['sales','sale_items','sale_payments','stock_movements','cash_sessions','cash_movements','sale_reversals','cash_closures'].map((table)=>[table,localRows(table)]));
  const localBusiness=()=>({...f.localDeps,unitOfWork:sqliteBusinessUnitOfWork(local)});
  const runtime=()=>sqliteCoordinatorUnitOfWork(local).run((tx)=>tx.replica.runtime());
  const balance=()=>localBusiness().unitOfWork.run((tx)=>tx.business.balance(f.product.id));
  try{
    origin=await app.listen({host:'127.0.0.1',port:0});auth.origin=origin;
    const gateway=syncGateway(origin),request=syncHttpClient(origin);
    const make=(maxPages=5,maxOperations=30)=>new SyncCoordinator({unitOfWork:sqliteCoordinatorUnitOfWork(local),storeId:f.identity.store_id,deviceId:f.device.id,clock:f.businessDeps.clock,ids:f.deps.ids,hashEnvelope:syncEnvelopeHash,validateEnvelope:(v)=>Value.Check(SyncEnvelope,v),validateReceipt:(v)=>Value.Check(SyncReceipt,v),random:()=>1,device:async()=>device,proof:async()=>undefined,maxPages,maxOperations,gateway:{...gateway,push:async(d,e)=>{const result=await gateway.push(d,e);if(dropSale&&e.type==='sale.completed'){dropSale=false;throw new ApplicationError('TEST_RESPONSE_LOST','Resposta perdida depois do commit.','unavailable',true);}return result;}}});
    const submitRemote=async(d:PairedDevice,id:string,command:ResolutionCommand)=>(await request('/api/v1/admin/sync-resolutions',d,ResolutionResponse,command,true,{'idempotency-key':id})).data as Result;
    const saved=facts();
    await t.test('snapshot em staging retoma após reabertura e rollback preserva a base e a fila',async()=>{
      await sql('INSERT INTO categories(id,store_id,name,search_key,active,version) VALUES ?',[Array.from({length:205},()=>[randomUUID(),f.identity.store_id,'Página teste','pagina teste',1,1])]);
      coordinator=make(1,0);await coordinator.outbox.initialize();await coordinator.cycle();assert.equal((await runtime()).state,'snapshot_downloading');assert.equal((await runtime()).initialized,false);assert.equal(await f.count('server_inbox'),0);assert.deepEqual(facts(),saved);
      const stage=(await coordinator.deps.unitOfWork.run((tx)=>tx.replica.staged()))!,page=await gateway.page(device,stage.id,1);
      await assert.rejects(coordinator.deps.unitOfWork.run((tx)=>tx.replica.stagePage(stage.id,{...page,checksum:'0'.repeat(64)})),fails('SYNC_SNAPSHOT_CHECKSUM_INVALID'));
      const path=local.path;await local.close();local=SqliteStore.open(path,f.identity);coordinator=make(1,0);await coordinator.outbox.initialize();
      for(const descriptor of stage.pages)await coordinator.deps.unitOfWork.run(async(tx)=>tx.replica.stagePage(stage.id,await gateway.page(device,stage.id,descriptor.page)));
      await assert.rejects(coordinator.deps.unitOfWork.run(async(tx)=>{await tx.replica.install(stage.id);throw new ApplicationError('INJECTED_FAILURE','Falha após instalação.','unavailable');}),fails('INJECTED_FAILURE'));
      assert.equal((await runtime()).cursor,'0');assert.equal((await runtime()).initialized,false);assert.deepEqual(facts(),saved);
      await coordinator.cycle();assert.equal((await runtime()).initialized,true);assert.equal((await balance()).quantity_milli,2000);assert.deepEqual(facts(),saved);
    });
    await t.test('resposta perdida depois de venda paga retenta o mesmo envelope sem dupla baixa',async()=>{
      coordinator=make();await coordinator.cycle();assert.equal((await runtime()).state,'retry_wait');assert.equal(await f.count('sales'),1);
      const pending=(await coordinator.outbox.prepareNext())!;assert.equal(pending.event_type,'sale.completed');assert.equal(pending.state,'retry_wait');
      const frozen=pending.envelope_json;await coordinator.outbox.requestRetry(f.context);await coordinator.cycle();
      const status=await coordinator.outbox.getStatus(f.context);assert.equal(status.pending,0);assert.equal(status.acknowledged,f.events.length);assert.equal(status.phase,'idle');assert.equal((await balance()).quantity_milli,2000);assert.deepEqual(facts(),saved);
      assert.equal((await coordinator.deps.unitOfWork.run((tx)=>tx.sync.delivery(pending.operation_id)))!.envelope_json,frozen);
      assert.equal(await f.count('sales'),2);assert.equal(await f.count('sale_reversals'),1);assert.equal(await f.count('cash_closures'),2);assert.equal((await remote.deviceState(f.device.credential)).received_seq,String(f.events.length));
      const before=await runtime();const empty=await gateway.changes(device,before.cursor);await coordinator.deps.unitOfWork.run((tx)=>tx.replica.apply(empty));assert.equal((await runtime()).cursor,before.cursor);
    });
    await t.test('mudança obrigatória desconhecida reverte página inteira; opcional avança sem efeitos',async()=>{
      const before=await runtime(),cursor=BigInt(before.cursor),change={cursor:String(cursor+1n),event_version:2 as const,required:true,operation_id:randomUUID(),type:'category.created.v1',source:'web' as const,origin:null,published_at:f.now,payload:{category:{id:randomUUID(),store_id:f.identity.store_id,name:'Rollback',active:true,version:1}},projection:{stock_deltas:[]}};
      const unknown={...change,cursor:String(cursor+2n),operation_id:randomUUID(),type:'future.required.v9',payload:{}};
      const count=localRows('categories').length;
      await assert.rejects(coordinator.deps.unitOfWork.run((tx)=>tx.replica.apply({items:[change,unknown],next_cursor:unknown.cursor,retention_floor:'0',has_more:false,protocol_version:1,event_version:2})),fails('SYNC_EVENT_UPGRADE_REQUIRED'));
      assert.equal((await runtime()).cursor,before.cursor);assert.equal(localRows('categories').length,count);
      // Optional-event behavior is exercised in a rolled-back transaction, keeping the real server cursor authoritative.
      await assert.rejects(coordinator.deps.unitOfWork.run(async(tx)=>{await tx.replica.apply({items:[{...unknown,cursor:change.cursor,required:false}],next_cursor:change.cursor,retention_floor:'0',has_more:false,protocol_version:1,event_version:2});assert.equal((await tx.replica.runtime()).cursor,change.cursor);throw new ApplicationError('TEST_ROLLBACK','Rollback.','unavailable');}),fails('TEST_ROLLBACK'));
    });
    await t.test('proposta offline preserva base; reaplicação muda apenas o patch e usa nova intenção',async()=>{
      const intention=randomUUID(),localCatalog=new CatalogService(localBusiness()),web=new CatalogService({...f.businessDeps,local:false,remoteWritesEnabled:true});
      await localCatalog.updateProduct(f.context,f.product.id,intention,1,{price_cents:250});
      const original=local.database.prepare('SELECT * FROM catalog_proposals WHERE intention_id=?').get(intention) as {base_json:string;proposal_json:string};
      await web.updateProduct(f.context,f.product.id,randomUUID(),1,{name:'Nome atualizado web',price_cents:150});await coordinator.cycle();
      const stored=local.database.prepare('SELECT * FROM catalog_proposals WHERE intention_id=?').get(intention) as typeof original&{status:string};assert.equal(stored.base_json,original.base_json);assert.equal(stored.proposal_json,original.proposal_json);assert.equal(stored.status,'conflict');
      const id=randomUUID(),command:ResolutionCommand={operation_id:intention,expected_version:1,action:'accept_proposal',reason:'Revisão de preço'};
      await assert.rejects(resolutions.submit(f.context,id,command),fails('CATALOG_VERSION_CONFLICT'));
      const manager=new LocalSyncResolutionService(coordinator,submitRemote),reapply={...command,action:'reapply_proposal' as const,expected_entity_version:2,patch:{price_cents:250}};
      const result=await manager.submit(f.context,id,reapply);assert.equal(result.id,id);assert.equal(result.outcome,'accepted');assert.deepEqual(await manager.submit(f.context,id,reapply),result);await coordinator.cycle();
      const product=await localBusiness().unitOfWork.run((tx)=>tx.business.product(f.product.id));assert.equal(product!.name,'Nome atualizado web');assert.equal(product!.price_cents,250);assert.equal(product!.version,3);assert.equal(stored.proposal_json,original.proposal_json);
      assert.equal((await localBusiness().unitOfWork.run((tx)=>tx.business.proposals('products'))).some((p)=>p.intention_id===intention),false);
      await assert.rejects(manager.submit({...f.context,authorization_origin:'offline'},randomUUID(),reapply),fails('PERMISSION_DENIED'));
      await assert.rejects(resolutions.submit(f.context,id,{...reapply,reason:'Outra razão'}),fails('IDEMPOTENCY_CONFLICT'));
    });
    await t.test('origem de outro terminal entra na projeção; piso de retenção preserva movimento local ainda pendente',async()=>{
      const foreign=await f.newDevice(),id=randomUUID(),context={...f.context,device_id:foreign.id},event=structuredClone(f.events[0]!);event.operation_id=id;event.device_id=foreign.id;event.device_seq='1';event.origin_authorization={context,signature:null};
      const p=event.payload as {movement:Record<string,unknown>};p.movement={...p.movement,id:randomUUID(),device_id:foreign.id,origin_id:id,authorization_context:JSON.stringify(context)};event.payload_hash=syncEnvelopeHash(event);
      assert.equal((await remote.push(foreign.credential,[event])).items[0]!.status,'applied');await coordinator.cycle();assert.equal((await balance()).quantity_milli,4000);
      const stock=new StockService(localBusiness());await stock.registerEntry(f.context,randomUUID(),{product_id:f.product.id,quantity_milli:1000,unit_cost_cents:5,reason:'Pendente durante snapshot'});
      const prior=facts(),before=(await runtime()).cursor;await new CatalogService({...f.businessDeps,local:false,remoteWritesEnabled:true}).createCategory(f.context,randomUUID(),{name:'Depois do cursor'});
      const state=await uow.run(async(tx)=>{await tx.publication.lock();return tx.publication.state();});assert.ok(BigInt(state.cursor)>BigInt(before));await sql('UPDATE store_sync_sequence SET retention_floor=cursor_value WHERE store_id=?',[f.identity.store_id]);
      coordinator=make(1,0);await coordinator.cycle();assert.equal((await runtime()).state,'snapshot_downloading');
      const expired=(await coordinator.deps.unitOfWork.run((tx)=>tx.replica.staged()))!;await sql("UPDATE server_snapshots SET manifest_json=JSON_SET(manifest_json,'$.expires_at',?) WHERE id=?",['2026-11-25T11:00:00.000Z',expired.id]);await coordinator.cycle();assert.equal((local.database.prepare('SELECT state FROM sync_snapshot_staging WHERE id=?').get(expired.id) as {state:string}).state,'expired');
      for(let i=0;i<10&&(await runtime()).cursor!==state.cursor;i++)await coordinator.cycle();
      assert.equal((await runtime()).cursor,state.cursor);assert.equal((await balance()).quantity_milli,5000);assert.deepEqual(facts(),prior);assert.equal((await coordinator.outbox.getStatus(f.context)).pending,1);
      const accepted=(await f.rows('server_sync_resolutions'))[0]!;assert.ok(local.database.prepare('SELECT 1 FROM sync_proposal_outcomes WHERE operation_id=?').get(accepted.operation_id));
      coordinator=make();await coordinator.cycle();assert.equal((await balance()).quantity_milli,5000);assert.equal((await coordinator.outbox.getStatus(f.context)).pending,0);
      await new StockService(localBusiness()).rebuild(f.context,randomUUID(),f.product.id);assert.equal((await balance()).quantity_milli,5000);await coordinator.cycle();
    });
    await t.test('venda paga em quarentena exige admin, justificativa e resolução atômica, sem reescrever o original',async()=>{
      const business=localBusiness(),cash=new CashService(business),sales=new SalesService(business,async()=>f.device.code),session=(await cash.open(f.context,randomUUID(),{opening_cents:0,business_date:'2026-11-25',time_zone:'America/Sao_Paulo'})).session;
      await coordinator.cycle();const sale=randomUUID(),operation=randomUUID();await sales.createDraft(f.context,randomUUID(),sale,{items:[{id:randomUUID(),product_id:f.product.id,expected_product_version:3,quantity_milli:1000}],customer_id:null,note:null,discount_cents:0});await sales.complete(f.context,operation,{sale_id:sale,session_id:session.id,expected_draft_version:1,expected_settings_version:1,payments:[{id:randomUUID(),method:'cash',applied_cents:250,tendered_cents:250,change_cents:0}]});
      const originalFacts=facts();await sql('UPDATE auth_users SET permissions_version=permissions_version+1 WHERE id=?',[f.context.user_id]);await coordinator.cycle();assert.equal((await runtime()).last_code,'ORIGIN_AUTHORIZATION_UNPROVEN');assert.equal(await f.count('sales'),2);
      const frozen=(await coordinator.deps.unitOfWork.run((tx)=>tx.sync.delivery(operation)))!,original=(await f.rows('server_inbox')).find((r)=>r.operation_id===operation)!;
      const login=await f.auth.login('owner','Sync-test-only-password-123!','resolution'),admin={...login.context,device_id:f.device.id};device.session={cookies:`venprox_access=${login.access}`,csrf:login.csrf};
      const id=randomUUID(),command:ResolutionCommand={operation_id:operation,expected_version:1,action:'confirm_original',reason:'Administrador conferiu a venda paga, itens e recebimento original'};
      await assert.rejects(resolutions.submit(admin,randomUUID(),{...command,action:'reject_proposal'}),fails('SYNC_FINANCIAL_DISCARD_FORBIDDEN'));
      await assert.rejects(resolutions.submit({...admin,permissions:['catalog.read']},id,command),fails('PERMISSION_DENIED'));
      const missingCsrf=await fetch(`${origin}/api/v1/admin/sync-resolutions`,{method:'POST',headers:{origin,cookie:device.session.cookies,'content-type':'application/json','idempotency-key':id},body:JSON.stringify(command)});assert.equal(missingCsrf.status,403);
      const extra=await fetch(`${origin}/api/v1/admin/sync-resolutions`,{method:'POST',headers:{origin,cookie:device.session.cookies,'x-csrf-token':device.session.csrf,'content-type':'application/json','idempotency-key':id},body:JSON.stringify({...command,sql:'DELETE'})});assert.equal(extra.status,422);
      const tables=['sales','stock_movements','cash_movements','server_changes','server_device_state','server_inbox','server_sync_resolutions','audit_log'],savedRemote=async()=>Object.fromEntries(await Promise.all(tables.map(async(table)=>[table,(await f.rows(table)).map((r)=>JSON.stringify(r)).sort()]))),before=await savedRemote();
      const fault=new SyncResolutionService({...resolutions.deps,unitOfWork:{run:(work)=>uow.run((tx)=>work({...tx,resolutions:{...tx.resolutions,insert:async(row)=>{await tx.resolutions.insert(row);throw new ApplicationError('INJECTED_FAILURE','Falha depois da revisão.','unavailable');}}}))}});
      await assert.rejects(fault.submit(admin,id,command),fails('INJECTED_FAILURE'));assert.deepEqual(await savedRemote(),before);
      const [a,b]=await Promise.all([resolutions.submit(admin,id,command),resolutions.submit(admin,id,command)]);assert.deepEqual(a,b);assert.equal(a.receipt.code,'APPLIED_BY_RESOLUTION');
      await coordinator.cycle();assert.equal((await coordinator.outbox.getStatus(admin)).pending,0);assert.equal(await f.count('sales'),3);assert.deepEqual(facts(),originalFacts);assert.equal((await balance()).quantity_milli,4000);
      const current=(await f.rows('server_inbox')).find((r)=>r.operation_id===operation)!;assert.equal(current.envelope_json,original.envelope_json);assert.equal(current.envelope_hash,original.envelope_hash);assert.equal((await coordinator.deps.unitOfWork.run((tx)=>tx.sync.delivery(operation)))!.envelope_json,frozen.envelope_json);
      const resolution=(await f.rows('server_sync_resolutions')).find((r)=>r.id===id)!;assert.equal(resolution.actor_id,admin.user_id);assert.equal(resolution.reason,command.reason);assert.ok(resolution.original_receipt_json);
      assert.deepEqual((await request(`/api/v1/admin/sync-resolutions/${id}`,device,ResolutionResponse,undefined,true)).data,a);
      // A historical offline proof can be unavailable; only the explicit admin command may submit it for review.
      const offline={...f.context,authorization_origin:'offline' as const,authorization_id:randomUUID()},unprovenSale=randomUUID(),unprovenOperation=randomUUID();
      await sales.createDraft(offline,randomUUID(),unprovenSale,{items:[{id:randomUUID(),product_id:f.product.id,expected_product_version:3,quantity_milli:1000}],customer_id:null,note:null,discount_cents:0});await sales.complete(offline,unprovenOperation,{sale_id:unprovenSale,session_id:session.id,expected_draft_version:1,expected_settings_version:1,payments:[{id:randomUUID(),method:'pix',applied_cents:250,tendered_cents:250,change_cents:0}]});
      const missingProofFacts=facts();await coordinator.cycle();assert.equal((await runtime()).last_code,'ORIGIN_PROOF_REQUIRED');assert.equal((await coordinator.outbox.prepareNext())!.envelope_json,null);
      const manager=new LocalSyncResolutionService(coordinator,submitRemote),review=await manager.submit(admin,randomUUID(),{...command,operation_id:unprovenOperation,reason:'Conferência identificada da venda paga cuja prova antiga não está disponível'});assert.equal(review.receipt.code,'APPLIED_BY_RESOLUTION');assert.deepEqual(facts(),missingProofFacts);await coordinator.cycle();assert.equal((await balance()).quantity_milli,3000);assert.equal(await f.count('sales'),4);
      // Review never legitimizes a divergent original hash.
      const invalidDevice=await f.newDevice(),invalid=structuredClone(f.events[0]!);invalid.device_id=invalidDevice.id;invalid.operation_id=randomUUID();invalid.device_seq='1';invalid.origin_authorization.context.device_id=invalidDevice.id;invalid.payload_hash='f'.repeat(64);
      assert.equal((await remote.push(invalidDevice.credential,[invalid])).items[0]!.code,'PAYLOAD_HASH_MISMATCH');await assert.rejects(resolutions.submit(admin,randomUUID(),{...command,operation_id:invalid.operation_id}),fails('SYNC_RESOLUTION_ENVELOPE_INVALID'));
      // A restored file behind an already received sequence must stop new writes.
      const source=(await remote.deviceState(f.device.credential)).received_seq;local.database.prepare('UPDATE device_sequences SET sequence_value=? WHERE store_id=? AND device_id=?').run(Number(source)-1,f.identity.store_id,f.device.id);await coordinator.cycle();assert.equal((await runtime()).state,'recovery_required');await coordinator.cycle();assert.equal((await runtime()).state,'recovery_required');await coordinator.deps.unitOfWork.run((tx)=>tx.replica.state('disabled',null,f.now,false));assert.equal((await runtime()).state,'recovery_required');
      await assert.rejects(new StockService(localBusiness()).registerEntry(admin,randomUUID(),{product_id:f.product.id,quantity_milli:1000,unit_cost_cents:5,reason:'Não pode escrever sobre restauração antiga'}),fails('SYNC_RECOVERY_REQUIRED'));
    });
    await t.test('provas históricas protegidas sobrevivem à renovação da concessão',async()=>{
      const protector={protect:async(value:string)=>Buffer.from(value).toString('base64'),unprotect:async(value:string)=>Buffer.from(value,'base64').toString('utf8')},cache=sqliteAuthCache(local,protector),one={...f.context,authorization_origin:'offline' as const,authorization_id:randomUUID()},two={...one,authorization_id:randomUUID()};
      const token=(value:typeof one)=>f.crypto.signGrant(value),grant={user_id:one.user_id,login_key:'owner',password_hash:'protected-test-hash',authorization:token(one)};
      await cache.saveGrant(grant,f.now);local.database.prepare('DELETE FROM sync_origin_proofs WHERE authorization_id=?').run(one.authorization_id);await cache.saveGrant({...grant,authorization:token(two)},f.now);assert.equal(await cache.proof!(one.authorization_id),token(one));assert.equal(await cache.proof!(two.authorization_id),token(two));assert.notEqual((localRows('sync_origin_proofs')[0] as {ciphertext:string}).ciphertext,token(one));
      local.database.prepare('DELETE FROM sync_origin_proofs WHERE authorization_id=?').run(two.authorization_id);assert.equal(await cache.proof!(two.authorization_id),token(two));
    });
  }finally{await app.close();await local.close();await f.close();}
});
