import type { SyncRepository, SyncInbox, SyncDevice, OriginEvidence } from '../../../application/src/sync-ports.js';
import type { BusinessSql } from './business-repository.js';
export function syncRepository(sql:BusinessSql,storeId:string):SyncRepository {
  async function one<T>(table:string,predicate:string,values:unknown[]):Promise<T|undefined>{sql.active();return (await sql.all(`SELECT * FROM ${table} WHERE store_id=? ${predicate}`,[storeId,...values]))[0] as T|undefined;}
  async function insert(table:string,value:Record<string,unknown>){sql.active();const keys=Object.keys(value);await sql.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,Object.values(value));}
  return {
    device:async(hash)=>{const row=await one<SyncDevice>('auth_devices','AND credential_hash=?',[hash]);return row?{id:row.id,code:row.code,active:Number(row.active)===1}:undefined;},
    frontier:async(device)=>String((await one<{received_seq:string}>('server_device_state','AND device_id=?',[device]))?.received_seq??'0'),
    advance:async(device,seq)=>{const row=await one('server_device_state','AND device_id=?',[device]);if(row)await sql.run('UPDATE server_device_state SET received_seq=? WHERE store_id=? AND device_id=?',[seq,storeId,device]);else await insert('server_device_state',{store_id:storeId,device_id:device,received_seq:seq});},
    inbox:(id)=>one<SyncInbox>('server_inbox','AND operation_id=?',[id]).then((row)=>row?{...row,device_seq:String(row.device_seq)}:undefined),
    inboxSequence:(device,seq)=>one<SyncInbox>('server_inbox','AND device_id=? AND device_seq=?',[device,seq]),
    insertInbox:(value)=>insert('server_inbox',{...value}),
    finishInbox:async(id,status,receipt)=>{sql.active();await sql.run('UPDATE server_inbox SET state=?,receipt_json=? WHERE store_id=? AND operation_id=?',[status,receipt,storeId,id]);},
    incident:(id,envelope,receipt)=>insert('server_sync_incidents',{id,store_id:storeId,device_id:envelope.device_id,operation_id:envelope.operation_id,envelope_json:JSON.stringify(envelope),receipt_json:JSON.stringify(receipt)}),
    originEvidence:async(context)=>{
      const user=await one<{permissions_version:number;role:string}>('auth_users','AND id=?',[context.user_id]);
      const role=user?await one<{permissions:string|string[]}>('auth_roles','AND role=?',[user.role]):undefined;
      const permissions=role?(Array.isArray(role.permissions)?role.permissions:JSON.parse(String(role.permissions)) as string[]):[];
      const session=await one<{user_id:string;access_expires:string;revoked_at:string|null}>('auth_sessions','AND id=?',[context.authorization_id]);
      const grant=await one<NonNullable<OriginEvidence['grant']>>('auth_grants','AND id=?',[context.authorization_id]);
      const rows=await sql.all("SELECT occurred_at,permissions_version FROM audit_log WHERE store_id=? AND authorization_id=? AND actor_user_id=? AND action IN('auth.login','auth.refreshed')",[storeId,context.authorization_id,context.user_id]);
      return {user_version:user?Number(user.permissions_version):null,permissions,session_user_id:session?.user_id??null,session_expires:session?.access_expires??null,session_revoked_at:session?.revoked_at??null,grant:grant?{...grant,permissions_version:Number(grant.permissions_version)}:null,authorizations:rows.map((row)=>({occurred_at:String(row.occurred_at),permissions_version:Number(row.permissions_version)}))};
    },
    savepoint:async()=>{sql.active();await sql.run('SAVEPOINT sync_effects');},rollbackEffects:async()=>{sql.active();await sql.run('ROLLBACK TO SAVEPOINT sync_effects');},
    entityExists:async(table,id)=>{sql.active();return (await sql.all(`SELECT id FROM ${table} WHERE id=?`,[id])).length>0;},
    stagePublication:(event,result)=>insert('server_publication_probes',{operation_id:event.operation_id,store_id:storeId,event_json:JSON.stringify(event),result_json:JSON.stringify(result)}),
    recordProposal:(event)=>insert('server_catalog_proposals',{operation_id:event.operation_id,store_id:storeId,device_id:event.device_id,type:event.type,payload_json:JSON.stringify(event.payload)}),
    setReceivedSessionFrontier:async(id,seq)=>{const row=await one('server_session_frontiers','AND session_id=?',[id]);if(row)await sql.run('UPDATE server_session_frontiers SET device_seq=? WHERE store_id=? AND session_id=?',[seq,storeId,id]);else await insert('server_session_frontiers',{store_id:storeId,session_id:id,device_seq:seq});},
    receivedSessionFrontier:async(id)=>String((await one<{device_seq:string}>('server_session_frontiers','AND session_id=?',[id]))?.device_seq??'0'),
    reconcile:(id,device,seq)=>insert('server_cash_reconciliations',{closure_id:id,store_id:storeId,device_id:device,through_seq:seq}),
  };
}
