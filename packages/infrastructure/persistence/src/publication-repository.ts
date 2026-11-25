import { performance } from 'node:perf_hooks';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { PublicationRepository, PublishedChange, SnapshotRecord, SnapshotManifest, SnapshotPage } from '../../../application/src/publication-ports.js';
import type { BusinessSql } from './business-repository.js';
import { canonicalJson } from '../../../domain/src/sync.js';
// No transport exports session material, passwords, origin proofs or command hashes.
const privateFields=new Set(['password_hash','credential_hash','authorization_context','origin_authorization','completion_hash','command_hash','authorization_id','open_device']);
export function publicationValue(value:unknown):unknown {
  if(Array.isArray(value))return value.map(publicationValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!privateFields.has(key)).map(([key,item])=>[key,publicationValue(item)]));
  return value;
}
export const snapshotLimits={records:5000,bytes:4*1024*1024,milliseconds:2000,pageRecords:100,pageBytes:256*1024};
const initial=['categories','products','product_barcodes','customers','store_settings','auth_roles','auth_users','stock_balances','server_sync_resolutions'];
const operational=[...initial,'auth_devices','stock_movements','cash_sessions','cash_movements','sales','sale_items','sale_payments','sale_reversals','reversal_items','refund_payments','cash_closures','server_device_state','server_session_frontiers','server_cash_reconciliations','server_catalog_proposals','audit_log'];
const safeColumns:Record<string,string>={auth_users:'id,store_id,name,role,active,permissions_version,version',auth_devices:'id,store_id,code,active,version',auth_roles:'store_id,role,permissions,version',server_sync_resolutions:"id,store_id,operation_id,JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.outcome')) AS outcome"};
export function publicationRepository(sql:BusinessSql,storeId:string):PublicationRepository {
  let barrierStarted=0;
  const limitError=()=>new ApplicationError('SNAPSHOT_LIMIT_EXCEEDED','Captura excede 5.000 registros, 4 MiB ou 2 segundos. Capturas maiores dependem de B13.','content');
  async function state(){const row=(await sql.all('SELECT cursor_value,retention_floor FROM store_sync_sequence WHERE store_id=?',[storeId]))[0];return {cursor:String(row?.cursor_value??'0'),floor:String(row?.retention_floor??'0')};}
  return {
    lock:async()=>{await sql.all('SELECT store_id FROM instance_identity WHERE store_id=? FOR UPDATE',[storeId]);barrierStarted=performance.now();await sql.run('INSERT INTO store_sync_sequence(store_id) VALUES(?) ON DUPLICATE KEY UPDATE store_id=store_id',[storeId]);await state();},
    state,
    publish:async(value)=>{
      if(!barrierStarted)throw new ApplicationError('PUBLICATION_LOCK_REQUIRED','Barreira de publicação obrigatória.','unavailable');
      const previous=await state(),next=BigInt(previous.cursor)+1n;
      if(next>9223372036854775807n)throw new ApplicationError('CURSOR_EXHAUSTED','Sequência de publicação esgotada.','unavailable');
      await sql.run('UPDATE store_sync_sequence SET cursor_value=? WHERE store_id=?',[String(next),storeId]);
      await sql.run('INSERT INTO server_changes(store_id,cursor_value,operation_id,type,source,origin_device_id,origin_device_seq,published_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?)',[storeId,String(next),value.operation_id,value.type,value.source,value.origin?.device_id??null,value.origin?.device_seq??null,value.published_at,canonicalJson({publication_format:2,payload:publicationValue(value.payload),projection:value.projection??{stock_deltas:[]}})]);
    },
    changes:async(after,limit)=>(await sql.all('SELECT * FROM server_changes WHERE store_id=? AND cursor_value>? ORDER BY cursor_value LIMIT ?',[storeId,after,limit])).map((row)=>{const body=JSON.parse(String(row.payload_json)) as {publication_format?:number;payload:unknown;projection:NonNullable<PublishedChange['projection']>};return {cursor:String(row.cursor_value),event_version:body.publication_format===2?2 as const:1 as const,required:true,operation_id:String(row.operation_id),type:String(row.type),source:row.source as PublishedChange['source'],origin:row.origin_device_id===null?null:{device_id:String(row.origin_device_id),device_seq:String(row.origin_device_seq)},published_at:String(row.published_at),payload:body.publication_format===2?body.payload:body,...(body.publication_format===2?{projection:body.projection}:{})};}),
    capture:async(kind)=>{
      const started=performance.now(),records:SnapshotRecord[]=[],counts:Record<string,number>={};let bytes=0;
      const tables=kind==='initial'?initial:operational;
      // One bounded current-read round trip discovers empty modules. Each subquery
      // locks its reference; the store barrier prevents any participating writer
      // from inserting/updating between this probe and the materialization.
      const present=(await sql.all(`SELECT ${tables.map((table)=>`(SELECT store_id FROM ${table} WHERE store_id=? LIMIT 1 FOR UPDATE) AS ${table}`).join(',')}`,tables.map(()=>storeId)))[0]!;
      for(const table of tables){
        if(performance.now()-started>snapshotLimits.milliseconds)throw limitError();
        // Fixed allowlist, bounded SQL. Locking reads see commits made before our barrier.
        const rows=present[table]===null?[]:await sql.all(`SELECT ${safeColumns[table]??'*'} FROM ${table} WHERE store_id=? LIMIT ?`,[storeId,snapshotLimits.records-records.length+1]);
        // The effective B05 defaults also exist before their first lazy SQL save.
        if(table==='store_settings'&&!rows.length)rows.push({id:storeId,store_id:storeId,version:1,stock_policy:'permissive',strict_scope:'local_terminal',images_enabled:0});
        counts[table]=rows.length;
        for(const row of rows){
          const value=publicationValue(row) as Record<string,unknown>;
          // MariaDB may return JSON arrays natively; stabilize both supported engines.
          if(table==='auth_roles'&&typeof value.permissions==='string')value.permissions=JSON.parse(value.permissions);
          const record={table,value};bytes+=Buffer.byteLength(canonicalJson(record));records.push(record);
          if(records.length>snapshotLimits.records||bytes>snapshotLimits.bytes||performance.now()-started>snapshotLimits.milliseconds)throw limitError();
        }
      }
      records.sort((a,b)=>{const x=canonicalJson(a),y=canonicalJson(b);return x<y?-1:x>y?1:0;});
      return {records,counts,capture_ms:Math.ceil(performance.now()-started)};
    },
    saveSnapshot:async(manifest,pages)=>{
      if(!barrierStarted||performance.now()-barrierStarted>snapshotLimits.milliseconds)throw limitError();
      await sql.run('INSERT INTO server_snapshots VALUES(?,?,?,?)',[manifest.id,storeId,manifest.device_id,JSON.stringify(manifest)]);
      for(const page of pages)await sql.run('INSERT INTO server_snapshot_pages VALUES(?,?,?,?)',[storeId,manifest.id,page.page,JSON.stringify(page)]);
      if(performance.now()-barrierStarted>snapshotLimits.milliseconds)throw limitError();
    },
    manifest:async(id,deviceId)=>{const row=(await sql.all('SELECT manifest_json FROM server_snapshots WHERE store_id=? AND id=? AND device_id=?',[storeId,id,deviceId]))[0];return row?JSON.parse(String(row.manifest_json)) as SnapshotManifest:undefined;},
    page:async(id,page)=>{const row=(await sql.all('SELECT page_json FROM server_snapshot_pages WHERE store_id=? AND snapshot_id=? AND page_number=?',[storeId,id,page]))[0];return row?JSON.parse(String(row.page_json)) as SnapshotPage:undefined;},
  };
}
