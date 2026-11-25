import { createHash } from 'node:crypto';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { mysqlSyncUnitOfWork } from '../packages/infrastructure/mysql/src/sync.js';
import { SyncService } from '../packages/application/src/sync-service.js';
import type { SyncEnvelope, SyncTransaction } from '../packages/application/src/sync-ports.js';
import { laboratoryPublication, syncEnvelopeHash, syncHashValue, validateSyncPayload } from '../packages/infrastructure/security/src/sync-validation.js';
import { loadAuthDatabaseOptions } from '../packages/infrastructure/runtime/src/auth-config.js';
// Processo descartável usado exclusivamente pela prova de queda B10.
if(process.env.MYSQL_HOST!=='127.0.0.1'||process.env.MYSQL_PORT!=='3308'||process.env.MYSQL_DATABASE!=='venprox_b10_test'||!process.connected)throw new Error('LOCAL_CRASH_TEST_ONLY');
const store=await MysqlStore.connect(loadAuthDatabaseOptions(process.env),{store_id:process.env.STORE_ID!}),base=mysqlSyncUnitOfWork(store);
process.on('message',async(message:{credential:string;event:SyncEnvelope;point:'after_sale'|'after_receipt'|'after_commit'})=>{
  const pause=async()=>{process.send?.({type:'paused',point:message.point});await new Promise<never>(()=>{});};
  try{
    const service=new SyncService({unitOfWork:{run:async(work)=>{
      let applied=false;const result=await base.run((tx)=>work({...tx,business:{...tx.business,insertSale:async(value)=>{await tx.business.insertSale(value);if(message.point==='after_sale')await pause();}},sync:{...tx.sync,finishInbox:async(id,status,receipt)=>{await tx.sync.finishInbox(id,status,receipt);if(status==='applied'){applied=true;if(message.point==='after_receipt')await pause();}}}} as SyncTransaction));
      if(applied&&message.point==='after_commit')await pause();return result;
    }},storeId:process.env.STORE_ID!,clock:{now:()=>new Date('2026-11-27T12:00:00.000Z')},ids:{generate:()=>{throw new Error('NO_INCIDENT_EXPECTED');}},digest:(value)=>createHash('sha256').update(value).digest('hex'),hashEnvelope:syncEnvelopeHash,hashValue:syncHashValue,validatePayload:validateSyncPayload,verifyOriginSignature:()=>{throw new Error('ONLINE_PROBE_ONLY');},publication:laboratoryPublication,writesEnabled:true});
    await service.push(message.credential,[message.event]);process.send?.({type:'unexpected_completion'});
  }catch(error){process.send?.({type:'error',code:error&&typeof error==='object'&&'code'in error?String(error.code):'CRASH_PROBE_FAILED'});}
});
process.send?.({type:'ready'});
