import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile,writeFile,readdir } from 'node:fs/promises';
import { Value } from 'typebox/value';
import { financialFixture,fails } from './financial-fixture.js';
import { syncFixture } from './sync-fixture.js';
import { RecoveryService } from '../packages/application/src/recovery.js';
import { reconcileRecoveredCopy } from '../packages/application/src/recovery-reconciliation.js';
import { SyncService } from '../packages/application/src/sync-service.js';
import { sqliteRecoveryPort } from '../packages/infrastructure/sqlite/src/recovery.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { boundRecoveryHandler } from '../packages/infrastructure/native/src/recovery-boundary.js';
import { RecoveryReport,RecoverySummary } from '../packages/contracts/src/recovery.js';
test('B18 backup SQLite/WAL, criptografia, isolamento, permissões, adulteração e contador',{timeout:30000},async()=>{
 const f=await financialFixture('sqlite','b18');assert.ok(f.store instanceof SqliteStore);const store=f.store,root=join(f.directory,'backups'),work=join(f.directory,'recovery'),key=join(f.directory,'secret.key');await writeFile(key,randomBytes(32).toString('hex'));
 try{await f.cash.open(f.context,randomUUID(),{opening_cents:100,business_date:'2026-11-25',time_zone:'America/Sao_Paulo'});const port=sqliteRecoveryPort(store,root,key,work),service=new RecoveryService(port,f.identity.store_id,f.identity.device_id,()=>f.deps.clock.now().toISOString());
  await assert.rejects(service.prepareCopy({...f.context,permissions:[]}),fails('PERMISSION_DENIED'));const before=await port.inspect();assert.ok(Value.Check(RecoverySummary,before));const copy=await service.prepareCopy(f.context);assert.ok(Value.Check(RecoveryReport,copy));assert.equal(copy.summary.pending,1);assert.equal(copy.summary.totals.cash_cents,'100');assert.equal(await readFile(join(root,copy.copy_id,'payload.enc'),'utf8').then(s=>s.includes('SQLite format 3')),false);
  const restored=await service.validateCopy(f.context,copy.copy_id);assert.equal(restored.status,'validated');assert.equal(restored.summary.fingerprint,copy.summary.fingerprint);const validation=JSON.parse(await readFile(join(root,copy.copy_id,'validation.json'),'utf8')) as {working_id:string},isolated=SqliteStore.open(join(work,validation.working_id,'restored.db'),f.identity);try{await assert.rejects(isolated.unitOfWork().run(tx=>tx.sequences.next(f.identity.device_id)),fails('RECOVERY_RECONCILIATION_REQUIRED'));assert.equal((isolated.database.prepare('SELECT COUNT(*) AS n FROM operation_outbox').get() as {n:number}).n,1);}finally{await isolated.close();}
  assert.equal((await port.inspect()).pending,before.pending);assert.equal((await port.inspect()).totals.cash_cents,before.totals.cash_cents);
  assert.equal((await sqliteRecoveryPort(f.identity,root,key,work).validate(copy.copy_id)).status,'validated');
  const originalKey=await readFile(key);await writeFile(key,randomBytes(32).toString('hex'));await assert.rejects(port.validate(copy.copy_id),fails('BACKUP_AUTHENTICATION_FAILED'));await writeFile(key,originalKey);
  const bytes=await readFile(join(root,copy.copy_id,'payload.enc'));bytes[0]=bytes[0]!^1;await writeFile(join(root,copy.copy_id,'payload.enc'),bytes);await assert.rejects(port.validate(copy.copy_id),fails('BACKUP_CHECKSUM_MISMATCH'));assert.equal((await port.inspect()).pending,1);
  store.database.prepare('UPDATE device_sequences SET sequence_value=0').run();assert.equal((await port.inspect()).sequence_valid,false);
  const wrong=sqliteRecoveryPort(store,join(f.directory,'secret.key'),key,work);await assert.rejects(wrong.prepare());assert.ok((await readdir(work)).length>=1);
  const frame={webContentsId:3,mainFrame:true,frameUrl:'file:///app/index.html'},handler=boundRecoveryHandler(3,frame.frameUrl,async c=>c);await assert.rejects(handler(frame,{type:'recovery.prepareCopy',request_id:'test',path:'C:\\arbitrary'}),fails('INVALID_COMMAND'));await assert.rejects(handler({...frame,mainFrame:false},{type:'recovery.inspect',request_id:'test'}),fails('IPC_ORIGIN_REJECTED'));
 }finally{await f.close();}
});
test('B18 backup antigo confronta recibos reais sem reexecutar venda e recusa contador/clones',{skip:!process.env.MYSQL_PASSWORD,timeout:120000},async()=>{
 const f=await syncFixture('b18');try{const root=join(f.directory,'backups'),key=join(f.directory,'secret.key');await writeFile(key,randomBytes(32).toString('hex'));const port=sqliteRecoveryPort(f.local,root,key,join(f.directory,'restore')),copy=await port.prepare(),remote=new SyncService(f.deps),sent=f.events.slice(0,3),receipt=await remote.push(f.device.credential,sent);assert.ok(receipt.items.every(r=>r.status==='applied'));const server=await remote.deviceState(f.device.credential),operations=f.events.map(e=>({operation_id:e.operation_id,device_seq:e.device_seq,payload_hash:e.payload_hash,acknowledged:false})),count=await f.count('sales'),plan=await reconcileRecoveredCopy(copy.summary,server.received_seq,operations,true,id=>remote.getReceipt(f.device.credential,id));assert.equal(plan.already_received,sent.length);assert.equal(await f.count('sales'),count);assert.equal((await port.inspect()).pending,copy.summary.pending);await assert.rejects(reconcileRecoveredCopy(copy.summary,server.received_seq,operations,false,id=>remote.getReceipt(f.device.credential,id)),fails('ORIGINAL_RETIREMENT_REQUIRED'));await assert.rejects(reconcileRecoveredCopy({...copy.summary,local_seq:'0',sequence_valid:false},server.received_seq,operations,true,id=>remote.getReceipt(f.device.credential,id)),fails('RECOVERY_COUNTER_LOST'));await assert.rejects(reconcileRecoveredCopy(copy.summary,server.received_seq,operations.map((o,i)=>i===0?{...o,payload_hash:'0'.repeat(64)}:o),true,id=>remote.getReceipt(f.device.credential,id)),fails('RECOVERY_RECEIPT_MISMATCH'));}finally{await f.close();}
});
