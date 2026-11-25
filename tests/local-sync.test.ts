import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { syncFixture } from './sync-fixture.js';
import { financialFixture, fails } from './financial-fixture.js';
import { LocalSyncService } from '../packages/application/src/local-sync-service.js';
import type { LocalSyncDependencies } from '../packages/application/src/local-sync-ports.js';
import { sqliteLocalSyncUnitOfWork } from '../packages/infrastructure/sqlite/src/local-sync.js';
import { syncEnvelopeHash } from '../packages/infrastructure/security/src/sync-validation.js';
import { atomicSyncPublication } from '../packages/infrastructure/mysql/src/sync.js';
import { SyncService } from '../packages/application/src/sync-service.js';
import { SyncEnvelope, SyncReceipt } from '../packages/contracts/src/sync.js';
import { LocalSyncResponse } from '../packages/contracts/src/local-sync.js';
import { boundSyncHandler } from '../packages/infrastructure/native/src/sync-boundary.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
const validation={hashEnvelope:syncEnvelopeHash,validateEnvelope:(v:unknown)=>Value.Check(SyncEnvelope,v),validateReceipt:(v:unknown)=>Value.Check(SyncReceipt,v),random:()=>1};

test('B12 início: fronteira IPC nega SQL, loja/permissões e remetente falsos',async()=>{
  const sender={webContentsId:7,mainFrame:true,frameUrl:'file:///app/index.html'},handler=boundSyncHandler(7,sender.frameUrl,async(command)=>command);
  assert.equal((await handler(sender,{type:'sync.getStatus',request_id:'test'}) as {type:string}).type,'sync.getStatus');
  for(const command of [{type:'sync.getStatus',request_id:'test',sql:'SELECT 1'},{type:'sync.requestRetry',request_id:'test',store_id:randomUUID()},{type:'sync.submitResolution',request_id:'test'}])await assert.rejects(handler(sender,command),fails('INVALID_COMMAND'));
  await assert.rejects(handler({...sender,mainFrame:false},{type:'sync.getStatus',request_id:'test'}),fails('IPC_ORIGIN_REJECTED'));
});
test('B12 início SQLite: bloqueio por prova ausente conserva origem e não libera próxima sequência',async()=>{
  const f=await financialFixture('sqlite','b12');
  const deps:LocalSyncDependencies={...validation,unitOfWork:sqliteLocalSyncUnitOfWork(f.store as SqliteStore),storeId:f.identity.store_id,deviceId:f.identity.device_id,clock:f.deps.clock,ids:f.deps.ids},service=new LocalSyncService(deps);
  try{
    await service.initialize();
    const id=randomUUID();await f.deps.unitOfWork.run(async(tx)=>{const seq=await tx.sequences.next(f.identity.device_id);await tx.outbox.append({operation_id:id,store_id:f.identity.store_id,device_id:f.identity.device_id,device_seq:seq,event_type:'stock.projection.rebuilt.v1',occurred_at:f.context.authorized_at,payload:'{}',authorization:{...f.context,authorization_origin:'offline'}});});
    const before=await f.rows('operation_outbox'),prepared=await service.prepareNext();assert.equal(prepared!.state,'blocked');assert.equal(prepared!.last_code,'ORIGIN_PROOF_REQUIRED');assert.equal(prepared!.envelope_json,null);
    await service.requestRetry(f.context);assert.equal((await service.prepareNext())!.state,'blocked');await assert.rejects(service.markSending(id),fails('SYNC_OPERATION_NOT_ELIGIBLE'));assert.deepEqual(await f.rows('operation_outbox'),before);
    const conflicts=await service.listConflicts(f.context);assert.equal(conflicts.items.length,1);assert.doesNotMatch(JSON.stringify(conflicts),/envelope_json|authorization_context|password|signature/);
    await assert.rejects(service.getStatus({...f.context,permissions:[]}),fails('PERMISSION_DENIED'));await assert.rejects(service.getStatus({...f.context,device_id:randomUUID()}),fails('SCOPE_MISMATCH'));
  }finally{await f.close();}
});
test('B12 início SQLite/MySQL reais: envio controlado, resposta perdida, recibo e reinício',{skip:!process.env.MYSQL_PASSWORD,timeout:120000},async(t)=>{
  const f=await syncFixture('b12'),uow=sqliteLocalSyncUnitOfWork(f.local),deps:LocalSyncDependencies={...validation,unitOfWork:uow,storeId:f.identity.store_id,deviceId:f.identity.device_id,clock:f.businessDeps.clock,ids:f.deps.ids},service=new LocalSyncService(deps),remote=new SyncService({...f.deps,publication:atomicSyncPublication});
  try{
    await service.initialize();
    await t.test('envelope congelado e status não fingem envio automático',async()=>{
      const first=await service.prepareNext();assert.equal(first!.payload_hash,f.events[0]!.payload_hash);assert.equal(first!.envelope_json,(await service.prepareNext())!.envelope_json);
      const status=await service.getStatus(f.context);assert.equal(status.pending,f.events.length);assert.equal(status.download_cursor,'0');assert.equal(status.last_contact_at,null);assert.equal(status.automatic_sync_enabled,false);assert.ok(Value.Check(LocalSyncResponse,{type:'sync.result',data:status,meta:{request_id:'test'}}));
    });
    await t.test('commit remoto com resposta perdida mantém fila; reenvio recupera duplicate sem novo efeito',async()=>{
      const first=(await service.prepareNext())!,envelope=await service.markSending(first.operation_id);
      assert.equal((await remote.push(f.device.credential,[envelope])).items[0]!.status,'applied');
      await service.retryAfterFailure(first.operation_id);assert.equal((await service.prepareNext())!.payload_hash,first.payload_hash);assert.equal((await service.getStatus(f.context)).acknowledged,0);
      await assert.rejects(service.markSending(first.operation_id),fails('SYNC_OPERATION_NOT_ELIGIBLE'));await service.requestRetry(f.context);
      const retry=await service.markSending(first.operation_id);assert.deepEqual(retry,envelope);const receipt=(await remote.push(f.device.credential,[retry])).items[0]!;assert.equal(receipt.status,'duplicate');assert.equal(await f.count('stock_movements'),1);
      await assert.rejects(service.acceptReceipt(first.operation_id,{...receipt,payload_hash:'f'.repeat(64)}),fails('SYNC_RECEIPT_MISMATCH'));
      const before=f.local.database.prepare('SELECT * FROM operation_outbox ORDER BY device_seq').all();
      const fault=new LocalSyncService({...deps,unitOfWork:{run:(work)=>uow.run((tx)=>work({...tx,sync:{...tx.sync,acknowledge:async(id,at)=>{await tx.sync.acknowledge(id,at);throw new ApplicationError('INJECTED_FAILURE','Falha.','unavailable');}}}))}});
      await assert.rejects(fault.acceptReceipt(first.operation_id,receipt),fails('INJECTED_FAILURE'));assert.deepEqual(f.local.database.prepare('SELECT * FROM operation_outbox ORDER BY device_seq').all(),before);assert.equal((await service.prepareNext())!.state,'sending');
      await service.acceptReceipt(first.operation_id,receipt);assert.equal((await service.getStatus(f.context)).acknowledged,1);assert.deepEqual(await service.acceptReceipt(first.operation_id,receipt),{acknowledged:true});
    });
    await t.test('sending recupera elegibilidade e sequência contígua; todas as vendas/caixas chegam uma vez',async()=>{
      const next=(await service.prepareNext())!,frozen=await service.markSending(next.operation_id);await service.initialize();assert.equal((await service.prepareNext())!.state,'retry_wait');
      const recovered=(await service.prepareNext())!;assert.equal(recovered.next_attempt_at,deps.clock.now().toISOString());
      const resumed=await service.markSending(next.operation_id);assert.deepEqual(resumed,frozen);await service.acceptReceipt(next.operation_id,(await remote.push(f.device.credential,[resumed])).items[0]!);
      for(let row=await service.prepareNext();row;row=await service.prepareNext()){
        assert.equal(row.state,'pending',`${row.event_type}: ${row.last_code}`);
        const event=await service.markSending(row.operation_id),receipt=(await remote.push(f.device.credential,[event])).items[0]!;assert.equal(receipt.status,'applied',JSON.stringify(receipt));await service.acceptReceipt(row.operation_id,receipt);
      }
      const status=await service.getStatus(f.context);assert.equal(status.pending,0);assert.equal(status.acknowledged,f.events.length);assert.ok(status.last_receipt_at);
      assert.equal(await f.count('sales'),2);assert.equal(await f.count('sale_reversals'),1);assert.equal(await f.count('cash_closures'),2);assert.equal(await f.count('server_publication_probes'),0);
      assert.equal((await remote.deviceState(f.device.credential)).received_seq,String(f.events.length));
      assert.equal((await f.businessDeps.unitOfWork.run((tx)=>tx.business.balance(f.product.id))).quantity_milli,2000);
    });
    await t.test('recibo impedido não é acknowledged e nova tentativa não pula nem apaga a origem',async()=>{
      await f.localDeps.unitOfWork.run((tx)=>tx.outbox.append({operation_id:randomUUID(),store_id:f.identity.store_id,device_id:f.identity.device_id,device_seq:String(f.events.length+1),event_type:'test.blocked.v1',occurred_at:f.now,payload:'{}',authorization:f.context}));
      const row=(await service.prepareNext())!,event=await service.markSending(row.operation_id);
      await service.acceptReceipt(row.operation_id,{operation_id:event.operation_id,device_id:event.device_id,device_seq:event.device_seq,payload_hash:event.payload_hash,status:'quarantined',code:'ORIGIN_AUTHORIZATION_UNPROVEN',result:null});
      await service.requestRetry(f.context);assert.equal((await service.prepareNext())!.state,'blocked');assert.equal((await service.getStatus(f.context)).pending,1);assert.equal((await service.listConflicts(f.context)).items.length,1);
      await assert.rejects(service.markSending(row.operation_id),fails('SYNC_OPERATION_NOT_ELIGIBLE'));
      const path=f.local.path;await f.local.close();const reopened=SqliteStore.open(path,f.identity);try{const restarted=new LocalSyncService({...deps,unitOfWork:sqliteLocalSyncUnitOfWork(reopened)});await restarted.initialize();assert.equal((await restarted.prepareNext())!.state,'blocked');assert.equal((await restarted.getStatus(f.context)).acknowledged,f.events.length);}finally{await reopened.close();}
    });
  }finally{await f.close();}
});
