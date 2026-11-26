import type { SqliteStore } from './store.js';
import type Database from 'better-sqlite3';
import type { DatabaseIdentity } from '../../../application/src/persistence.js';
import type { LocalSyncDependencies, LocalSyncRepository, LocalSyncSource, LocalDelivery, LocalSyncStatus } from '../../../application/src/local-sync-ports.js';
export function sqliteLocalSyncUnitOfWork(store:SqliteStore):LocalSyncDependencies['unitOfWork']{
  return store.unitOfWork((db,core,active)=>({sync:localSyncRepository(db,store.identity,active),audit:core.audit}));
}
export function localSyncRepository(db:Database.Database,identity:DatabaseIdentity,active:()=>void):LocalSyncRepository{
    const {store_id,device_id}=identity;
    const run=(query:string,values:unknown[]=[])=>{active();db.prepare(query).run(...values);};
    const one=<T>(query:string,values:unknown[]=[])=>{active();return db.prepare(query).get(...values) as T|undefined;};
    const sync:LocalSyncRepository={
      initialize:async()=>{run('INSERT INTO sync_state(store_id,device_id) VALUES(?,?) ON CONFLICT DO NOTHING',[store_id,device_id]);run('INSERT INTO sync_runtime(store_id,device_id) VALUES(?,?) ON CONFLICT DO NOTHING',[store_id,device_id]);},
      recoverSending:async(at)=>{run("UPDATE sync_outbox SET state='retry_wait',next_attempt_at=?,last_code='PROCESS_RESTARTED' WHERE store_id=? AND device_id=? AND state='sending'",[at,store_id,device_id]);},
      sourceNext:async()=>one<LocalSyncSource>("SELECT operation_id,store_id,device_id,CAST(device_seq AS TEXT) AS device_seq,event_type,occurred_at,payload,authorization_context FROM operation_outbox WHERE store_id=? AND device_id=? AND state='pending' ORDER BY operation_outbox.device_seq LIMIT 1",[store_id,device_id]),
      delivery:async(id)=>one<LocalDelivery>('SELECT operation_id,store_id,device_id,CAST(device_seq AS TEXT) AS device_seq,event_type,envelope_json,payload_hash,state,attempts,next_attempt_at,last_code,receipt_json FROM sync_outbox WHERE store_id=? AND device_id=? AND operation_id=?',[store_id,device_id,id]),
      save:async(value)=>{
        if(value.store_id!==store_id||value.device_id!==device_id)throw new Error('SYNC_SCOPE_MISMATCH');
        const prior=one<Pick<LocalDelivery,'envelope_json'|'payload_hash'>>('SELECT envelope_json,payload_hash FROM sync_outbox WHERE operation_id=?',[value.operation_id]);
        if(prior&&prior.envelope_json!==null&&(prior.envelope_json!==value.envelope_json||prior.payload_hash!==value.payload_hash))throw new Error('FROZEN_ENVELOPE_CHANGED');
        run(`INSERT INTO sync_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET envelope_json=excluded.envelope_json,payload_hash=excluded.payload_hash,state=excluded.state,attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,last_code=excluded.last_code,receipt_json=excluded.receipt_json`,[value.operation_id,store_id,device_id,BigInt(value.device_seq),value.event_type,value.envelope_json,value.payload_hash,value.state,value.attempts,value.next_attempt_at,value.last_code,value.receipt_json]);
      },
      acknowledge:async(id,at)=>{run("UPDATE operation_outbox SET state='acknowledged' WHERE store_id=? AND device_id=? AND operation_id=?",[store_id,device_id,id]);run('UPDATE sync_state SET last_contact_at=?,last_receipt_at=? WHERE store_id=? AND device_id=?',[at,at,store_id,device_id]);},
      contact:async(at,receipt=false)=>{run('UPDATE sync_state SET last_contact_at=?,last_receipt_at=CASE WHEN ?=1 THEN ? ELSE last_receipt_at END WHERE store_id=? AND device_id=?',[at,Number(receipt),at,store_id,device_id]);},
      requestRetry:async(at)=>{run('UPDATE sync_state SET retry_requested_at=? WHERE store_id=? AND device_id=?',[at,store_id,device_id]);run("UPDATE sync_outbox SET next_attempt_at=? WHERE store_id=? AND device_id=? AND state='retry_wait'",[at,store_id,device_id]);
        // A queued attempt must not report the previous attempt's failure.
        // Recovery remains a durable barrier that a retry cannot clear.
        run("UPDATE sync_runtime SET state=CASE WHEN state='recovery_required' THEN state ELSE 'scheduled' END,last_code=CASE WHEN state='recovery_required' THEN last_code ELSE NULL END WHERE store_id=? AND device_id=?",[store_id,device_id]);},
      status:async()=>{
        const state=one<{download_cursor:string;last_contact_at:string|null;last_receipt_at:string|null;retry_requested_at:string|null}>('SELECT * FROM sync_state WHERE store_id=? AND device_id=?',[store_id,device_id]);
        if(!state)throw new Error('SYNC_NOT_INITIALIZED');
        const counts=one<{pending:number;acknowledged:number;oldest_pending_at:string|null}>("SELECT COALESCE(SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END),0) AS pending,COALESCE(SUM(CASE WHEN state='acknowledged' THEN 1 ELSE 0 END),0) AS acknowledged,MIN(CASE WHEN state='pending' THEN occurred_at ELSE NULL END) AS oldest_pending_at FROM operation_outbox WHERE store_id=? AND device_id=?",[store_id,device_id])!;
        const delivery=one<{in_flight:number;conflicts:number}>("SELECT COALESCE(SUM(CASE WHEN state='sending' THEN 1 ELSE 0 END),0) AS in_flight,COALESCE(SUM(CASE WHEN state IN('conflict','blocked') THEN 1 ELSE 0 END),0) AS conflicts FROM sync_outbox WHERE store_id=? AND device_id=?",[store_id,device_id])!;
        const runtime=one<{enabled:number;state:string;last_code:string|null}>('SELECT enabled,state,last_code FROM sync_runtime WHERE store_id=? AND device_id=?',[store_id,device_id]);
        const catalog=one<{n:number}>('SELECT COUNT(*) AS n FROM sync_catalog_conflicts c WHERE NOT EXISTS(SELECT 1 FROM sync_proposal_outcomes o WHERE o.operation_id=c.operation_id)')!.n;
        const result:LocalSyncStatus={scope:'local_terminal',download_cursor:state.download_cursor,pending:counts.pending,acknowledged:counts.acknowledged,oldest_pending_at:counts.oldest_pending_at,in_flight:delivery.in_flight,conflicts:delivery.conflicts+catalog,last_contact_at:state.last_contact_at,last_receipt_at:state.last_receipt_at,retry_requested_at:state.retry_requested_at,automatic_sync_enabled:runtime?.enabled===1,phase:runtime?.state??'uninitialized',last_code:runtime?.last_code??null};return result;
      },
      conflicts:async()=>{active();const deliveries=db.prepare("SELECT operation_id,CAST(device_seq AS TEXT) AS device_seq,event_type,state,COALESCE(last_code,'SYNC_BLOCKED') AS code FROM sync_outbox WHERE store_id=? AND device_id=? AND state IN('conflict','blocked') ORDER BY sync_outbox.device_seq LIMIT 100").all(store_id,device_id) as Awaited<ReturnType<LocalSyncRepository['conflicts']>>;
        const catalog=db.prepare("SELECT c.operation_id,CAST(o.device_seq AS TEXT) AS device_seq,o.event_type,'conflict' AS state,c.code FROM sync_catalog_conflicts c JOIN operation_outbox o ON o.operation_id=c.operation_id WHERE NOT EXISTS(SELECT 1 FROM sync_proposal_outcomes s WHERE s.operation_id=c.operation_id) LIMIT 100").all() as Awaited<ReturnType<LocalSyncRepository['conflicts']>>;return [...deliveries,...catalog.filter((r)=>!deliveries.some((d)=>d.operation_id===r.operation_id))].slice(0,100);},
    };return sync;
}
