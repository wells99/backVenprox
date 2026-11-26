import type Database from 'better-sqlite3';
import type {DatabaseIdentity} from '../../../application/src/persistence.js';
import {createHash} from 'node:crypto';
import { readFile,writeFile,realpath } from 'node:fs/promises';
import { join,relative } from 'node:path';
import { SqliteStore } from './store.js';
import { inspectRecoveryDatabase } from './recovery.js';
import { sqliteAuthCache } from './auth-cache.js';
import { windowsSecretProtector } from '../../native/src/dpapi.js';
import { syncGateway } from '../../security/src/sync-gateway.js';
import { syncEnvelopeHash } from '../../security/src/sync-validation.js';
import type { SyncEnvelope as Envelope } from '../../../application/src/sync-ports.js';
import { reconcileRecoveredCopy } from '../../../application/src/recovery-reconciliation.js';
import { backupFailure } from '../../security/src/backup-crypto.js';
export async function activateRecoveredCopy(original:{path:string;identity:DatabaseIdentity;database?:Database.Database},backupRoot:string,workRoot:string,copyId:string,origin:string,sourceUnavailable=false){
 if(!/^[a-f0-9-]{36}$/.test(copyId))throw backupFailure('BACKUP_ID_INVALID');
 const validation=JSON.parse(await readFile(join(backupRoot,copyId,'validation.json'),'utf8')) as {working_id:string};if(!/^[a-f0-9-]{36}$/.test(validation.working_id))throw backupFailure('BACKUP_VALIDATION_REQUIRED');
 const root=await realpath(workRoot),path=await realpath(join(root,validation.working_id,'restored.db'));if(relative(root,path)!==join(validation.working_id,'restored.db'))throw backupFailure('BACKUP_PATH_INVALID');
 const restored=SqliteStore.open(path,original.identity);try{
  restored.assertReady();if(!restored.database.prepare("SELECT 1 FROM maintenance_runs WHERE store_id=? AND id=? AND kind='recovery' AND status IN('held','released')").get(original.identity.store_id,copyId))throw backupFailure('BACKUP_VALIDATION_REQUIRED');const summary=inspectRecoveryDatabase(restored.database,original.identity);if(original.database){const source=inspectRecoveryDatabase(original.database,original.identity);if(summary.local_seq!==source.local_seq)throw backupFailure('ORIGINAL_HAS_DIFFERENT_OPERATIONS');const digest=(db:Database.Database)=>createHash('sha256').update(JSON.stringify(db.prepare('SELECT operation_id,device_seq,event_type,payload,authorization_context,occurred_at FROM operation_outbox ORDER BY device_seq').safeIntegers().all(),(_k,v)=>typeof v==='bigint'?v.toString():v)).digest('hex');if(digest(original.database)!==digest(restored.database))throw backupFailure('ORIGINAL_HAS_DIFFERENT_OPERATIONS');}else if(!sourceUnavailable)throw backupFailure('RECOVERY_SOURCE_UNAVAILABLE');
  const cache=sqliteAuthCache(restored,windowsSecretProtector(`venprox-auth-v1:${summary.store_id}:${summary.device_id}`)),device=await cache.device();if(!device)throw backupFailure('DEVICE_NOT_PAIRED');const gateway=syncGateway(origin),server=await gateway.compatible(device),rows=restored.database.prepare('SELECT * FROM operation_outbox ORDER BY device_seq').safeIntegers().all() as {operation_id:string;device_seq:bigint;event_type:string;occurred_at:string;authorization_context:string;payload:string;state:string}[],operations=[];
  for(const row of rows){const context=JSON.parse(row.authorization_context) as Envelope['origin_authorization']['context'],signature=context.authorization_origin==='offline'?await cache.proof!(context.authorization_id):null;if(context.authorization_origin==='offline'&&!signature)throw backupFailure('ORIGIN_PROOF_REQUIRED');const envelope:Envelope={protocol_version:1,payload_version:1,store_id:summary.store_id,device_id:summary.device_id,operation_id:row.operation_id,device_seq:String(row.device_seq),type:row.event_type,occurred_at_device:row.occurred_at,origin_authorization:{context,signature:signature??null},dependencies:[],payload:JSON.parse(row.payload),payload_hash:'0'.repeat(64)};envelope.payload_hash=syncEnvelopeHash(envelope);operations.push({operation_id:row.operation_id,device_seq:String(row.device_seq),payload_hash:envelope.payload_hash,acknowledged:row.state!=='pending'});}
  const plan=await reconcileRecoveredCopy(summary,server.received_seq,operations,true,id=>gateway.receipt(device,id));
  // Original remains preserved, but normal boot refuses it. Crash here leaves the restored copy held.
  let prior:{copy_id:string;working_id:string}|undefined;try{prior=JSON.parse(await readFile(original.path+'.retired','utf8')) as {copy_id:string;working_id:string};}catch{/* First activation. */}if(prior&&(prior.copy_id!==copyId||prior.working_id!==validation.working_id))throw backupFailure('ORIGINAL_RETIRED_FOR_ANOTHER_COPY');if(!prior)await writeFile(original.path+'.retired',JSON.stringify({copy_id:copyId,working_id:validation.working_id,retired_at:new Date().toISOString()}),{flag:'wx',mode:0o600});
  await restored.unitOfWork((db)=>db).run(async db=>{db.prepare("UPDATE maintenance_runs SET status='released',report_json=? WHERE store_id=? AND id=? AND kind='recovery' AND status='held'").run(JSON.stringify(plan),summary.store_id,copyId);});
  await writeFile(join(root,validation.working_id,'activation.env'),`LOCAL_DATABASE_PATH=${path}\n`,{mode:0o600});
  return {...plan,activation_id:validation.working_id,original_database_preserved:true,original_boot_blocked:true};
 }finally{await restored.close();}
}
