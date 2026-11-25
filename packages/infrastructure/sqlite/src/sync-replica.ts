import type Database from 'better-sqlite3';
import type { SqliteStore } from './store.js';
import { localSyncRepository } from './local-sync.js';
import { businessRepository } from '../../persistence/src/business-repository.js';
import { syncHashValue } from '../../security/src/sync-validation.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { Category,Customer,Product,StoreSettings } from '../../../application/src/business-ports.js';
import type { SyncCoordinatorDependencies,SyncReplica,SyncRuntime,ChangesPage } from '../../../application/src/sync-coordinator-ports.js';
import type { PublishedChange,SnapshotManifest,SnapshotPage,SnapshotRecord } from '../../../application/src/publication-ports.js';
import { catalogText,catalogSearchKey,units } from '../../../domain/src/catalog-stock.js';
import { assertUuid } from '../../persistence/src/shared.js';
import { syncStockQuantity } from './sync-stock.js';
const allowedTables=new Set(['categories','products','product_barcodes','customers','store_settings','auth_roles','auth_users','stock_balances','auth_devices','stock_movements','cash_sessions','cash_movements','sales','sale_items','sale_payments','sale_reversals','reversal_items','refund_payments','cash_closures','server_device_state','server_session_frontiers','server_cash_reconciliations','server_catalog_proposals','audit_log','server_sync_resolutions']);
const knownEvent=(type:string)=>/^(category|product|customer)\.(created|updated)\.v1$/.test(type)||['settings.updated.v1','cash.opened','cash.movement_recorded','cash.closed','sale.completed','sale.reversed','stock.entry.v1','stock.count.v1','stock.projection.rebuilt.v1','terminal.settings.updated.v1','authorization.user.updated.v1','authorization.device.updated.v1','sync.proposal.resolved.v1','sync.resolution.confirmed.v1'].includes(type)||/^(products|categories|customers|settings)\.proposal(?:\.conflict)?\.v1$/.test(type);
const fail=(code:string)=>new ApplicationError(code,'Não foi possível aplicar o download; a base e as pendências anteriores foram preservadas.','conflict');
const integer=(value:unknown)=>{if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!/^-?(0|[1-9][0-9]*)$/.test(value))throw fail('SYNC_NUMBER_INVALID');const n=Number(value);if(!Number.isSafeInteger(n))throw fail('SYNC_NUMBER_INVALID');return n;};
const uuid=(value:unknown)=>{if(typeof value!=='string')throw fail('SYNC_ID_INVALID');assertUuid(value);return value;};
const text=(value:unknown,max=120)=>{if(typeof value!=='string'||catalogText(value,max)!==value)throw fail('SYNC_TEXT_INVALID');return value;};
const bool=(value:unknown)=>{if(value===true||value===1)return true;if(value===false||value===0)return false;throw fail('SYNC_BOOLEAN_INVALID');};
export function sqliteCoordinatorUnitOfWork(store:SqliteStore):SyncCoordinatorDependencies['unitOfWork']{
  return store.unitOfWork((db,core,active)=>({audit:core.audit,sync:localSyncRepository(db,store.identity,active),replica:replicaRepository(db,store.identity.store_id,store.identity.device_id!,active)}));
}
function replicaRepository(db:Database.Database,storeId:string,deviceId:string,active:()=>void):SyncReplica{
  const sql={active,forUpdate:'',all:async(query:string,values:unknown[]=[])=>{active();return db.prepare(query).all(...values) as Record<string,unknown>[];},run:async(query:string,values:unknown[]=[])=>{active();db.prepare(query).run(...values);}},business=businessRepository(sql,storeId);
  const run=(query:string,values:unknown[]=[])=>{active();db.prepare(query).run(...values);};
  const one=<T>(query:string,values:unknown[]=[])=>{active();return db.prepare(query).get(...values) as T|undefined;};
  const runtime=async():Promise<SyncRuntime>=>{const r=one<{initialized:number;baseline_seq:string;state:string;last_code:string|null;enabled:number}>('SELECT * FROM sync_runtime WHERE store_id=? AND device_id=?',[storeId,deviceId]);if(!r)throw fail('SYNC_NOT_INITIALIZED');return {...r,initialized:r.initialized===1,enabled:r.enabled===1,local_seq:one<{seq:string}>('SELECT CAST(sequence_value AS TEXT) AS seq FROM device_sequences WHERE store_id=? AND device_id=?',[storeId,deviceId])?.seq??'0',cursor:one<{download_cursor:string}>('SELECT download_cursor FROM sync_state WHERE store_id=? AND device_id=?',[storeId,deviceId])!.download_cursor};};
  function record(table:string,value:Record<string,unknown>){
    if(value.store_id!==undefined&&value.store_id!==storeId)throw fail('SYNC_RECORD_SCOPE_MISMATCH');
    const key=String(value.id??value.product_id??value.role??value.device_id??value.closure_id??value.session_id??`${value.operation_id}:${value.action??''}`);
    if(!key||key==='undefined:')throw fail('SYNC_RECORD_KEY_INVALID');
    run('INSERT INTO sync_received_rows VALUES(?,?,?) ON CONFLICT(table_name,entity_key) DO UPDATE SET row_json=excluded.row_json',[table,key,JSON.stringify(value)]);
  }
  const rows=(table:string)=>(db.prepare('SELECT row_json FROM sync_received_rows WHERE table_name=? ORDER BY entity_key').all(table) as {row_json:string}[]).map((r)=>JSON.parse(r.row_json) as Record<string,unknown>);
  async function catalog(kind:'categories'|'products'|'customers'|'store_settings',v:Record<string,unknown>){
    if(v.store_id!==storeId)throw fail('SYNC_RECORD_SCOPE_MISMATCH');
    const id=uuid(v.id),version=integer(v.version);if(version<1)throw fail('SYNC_VERSION_INVALID');
    const existing=kind==='products'?await business.product(id):kind==='categories'?await business.category(id):kind==='customers'?await business.customer(id):undefined;
    if(existing&&existing.version>version)return;
    record(kind,v);
    if(kind==='store_settings'){
      if(!['permissive','require_stock'].includes(String(v.stock_policy))||v.strict_scope!=='local_terminal'||bool(v.images_enabled)!==false)throw fail('SYNC_SETTINGS_UNSUPPORTED');
      await business.saveSettings({id,store_id:storeId,version,stock_policy:v.stock_policy as StoreSettings['stock_policy'],strict_scope:'local_terminal',images_enabled:false});
    }else{
      const name=text(v.name),base={id,store_id:storeId,name,search_key:catalogSearchKey(name),active:bool(v.active),version};
      if(kind==='categories')await business.saveCategory(base as Category);
      if(kind==='customers')await business.saveCustomer({...base,phone:v.phone===null?null:text(v.phone,40),email:v.email===null?null:text(v.email,254),confirmation_state:'confirmed'} as Customer);
      if(kind==='products'){
        if(!units.includes(v.unit as Product['unit']))throw fail('SYNC_UNIT_INVALID');
        if(existing&&'unit'in existing&&existing.unit!==v.unit&&(await business.balance(id)).version>0)throw fail('SYNC_UNIT_CONFLICT');
        const price=integer(v.price_cents),cost=v.cost_cents===null?null:integer(v.cost_cents);if(price<0||cost!==null&&cost<0)throw fail('SYNC_MONEY_INVALID');
        const barcodes=Array.isArray(v.barcodes)?v.barcodes:rows('product_barcodes').filter((r)=>r.product_id===id&&bool(r.active)).map((r)=>r.barcode);
        if(barcodes.length>10||barcodes.some((b)=>typeof b!=='string'||!/^[0-9]{1,64}$/.test(b)))throw fail('SYNC_BARCODE_INVALID');
        const code=text(v.internal_code,64);
        await business.saveProduct({...base,internal_code:code,code_key:code.toUpperCase(),unit:v.unit as Product['unit'],price_cents:price,cost_cents:cost,category_id:v.category_id===null?null:uuid(v.category_id),barcodes:barcodes as string[]});
      }
    }
    const proposals=db.prepare('SELECT intention_id,base_version FROM catalog_proposals WHERE entity_type=? AND entity_id=?').all(kind==='store_settings'?'settings':kind,id) as {intention_id:string;base_version:number}[];
    for(const proposal of proposals)if(proposal.base_version<version&&!one('SELECT 1 FROM sync_proposal_outcomes WHERE operation_id=?',[proposal.intention_id])){
      run('UPDATE catalog_proposals SET status=\'conflict\' WHERE intention_id=?',[proposal.intention_id]);
      run('INSERT INTO sync_catalog_conflicts VALUES(?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET server_version=excluded.server_version',[proposal.intention_id,kind,id,proposal.base_version,version,'CATALOG_VERSION_CONFLICT']);
    }
  }
  async function balances(){
    const state=await runtime(),products=new Set([...rows('stock_balances').map((r)=>String(r.product_id)),...(db.prepare('SELECT product_id FROM stock_balances').all() as {product_id:string}[]).map((r)=>r.product_id),...(db.prepare('SELECT product_id FROM sync_stock_base').all() as {product_id:string}[]).map((r)=>r.product_id)]);
    for(const id of products){
      if(!await business.product(id))throw fail('SYNC_PRODUCT_REFERENCE_MISSING');
      const total=syncStockQuantity(db,id,state.baseline_seq);
      const prior=await business.balance(id);if(prior.quantity_milli!==Number(total))await business.saveBalance({...prior,quantity_milli:Number(total),version:prior.version+1});
    }
  }
  function outcome(value:NonNullable<PublishedChange['projection']>['proposal_outcome']){if(value){run('INSERT INTO sync_proposal_outcomes VALUES(?,?,?) ON CONFLICT DO NOTHING',[value.operation_id,value.resolution_id,value.outcome]);run('DELETE FROM sync_catalog_conflicts WHERE operation_id=?',[value.operation_id]);}}
  async function change(c:PublishedChange){
    if(!knownEvent(c.type)){if(c.required)throw fail('SYNC_EVENT_UPGRADE_REQUIRED');return;}
    if(c.event_version!==1&&c.event_version!==2)throw fail('SYNC_EVENT_UPGRADE_REQUIRED');
    if(one('SELECT 1 FROM sync_received_operations WHERE operation_id=?',[c.operation_id]))return;
    const p=c.payload as Record<string,unknown>;
    if(/^(category|product|customer)\.(created|updated)\.v1$/.test(c.type)){const root=c.type.split('.')[0]!,kind=root==='category'?'categories':root==='product'?'products':'customers';await catalog(kind,p[root] as Record<string,unknown>);}
    else if(c.type==='settings.updated.v1')await catalog('store_settings',p.settings as Record<string,unknown>);
    else if(c.type==='customer.created.v1')await catalog('customers',{...(p.customer as Record<string,unknown>),confirmation_state:'confirmed'});
    else if(c.type==='customers.proposal.v1'&&p.base_version===0&&(p.proposal as {confirmation_state?:string}).confirmation_state==='local_pending')await catalog('customers',{...(p.proposal as Record<string,unknown>),confirmation_state:'confirmed'});
    else record(`event:${c.type}`,{id:c.operation_id,...p});
    const financial=['stock.entry.v1','stock.count.v1','sale.completed','sale.reversed'].includes(c.type);
    if(financial&&!c.projection)throw fail('SYNC_EVENT_UPGRADE_REQUIRED');
    for(const delta of c.projection?.stock_deltas??[]){uuid(delta.id);uuid(delta.product_id);const n=integer(delta.delta_milli);const old=one<{quantity_milli:number}>('SELECT quantity_milli FROM sync_stock_base WHERE product_id=?',[delta.product_id])?.quantity_milli??0;const next=BigInt(old)+BigInt(n);if(next>BigInt(Number.MAX_SAFE_INTEGER)||next<BigInt(-Number.MAX_SAFE_INTEGER))throw fail('SYNC_STOCK_OUT_OF_RANGE');run('INSERT INTO sync_stock_base VALUES(?,?) ON CONFLICT(product_id) DO UPDATE SET quantity_milli=excluded.quantity_milli',[delta.product_id,Number(next)]);}
    outcome(c.projection?.proposal_outcome);
    if(c.type==='customers.proposal.v1'&&c.origin?.device_id===deviceId&&p.base_version===0)outcome({operation_id:c.operation_id,resolution_id:c.operation_id,outcome:'accepted'});
    if(c.origin?.device_id===deviceId){const local=one<{seq:string}>('SELECT CAST(device_seq AS TEXT) AS seq FROM operation_outbox WHERE operation_id=?',[c.operation_id]);if(local&&local.seq!==c.origin.device_seq)throw fail('SYNC_OWN_ORIGIN_MISMATCH');}
    run('INSERT INTO sync_received_operations VALUES(?,?,?,?)',[c.operation_id,c.cursor,c.origin?.device_id??null,c.origin?.device_seq??null]);
  }
  return {
    runtime,
    state:async(state,code,at,enabled)=>{run("UPDATE sync_runtime SET last_code=CASE WHEN state='recovery_required' THEN last_code ELSE ? END,state=CASE WHEN state='recovery_required' THEN state ELSE ? END,last_cycle_at=?,enabled=? WHERE store_id=? AND device_id=?",[code,state,at,Number(enabled),storeId,deviceId]);},
    apply:async(page:ChangesPage)=>{
      const state=await runtime();if(!state.initialized)throw fail('SNAPSHOT_REQUIRED');if(BigInt(page.retention_floor)>BigInt(state.cursor))throw fail('SNAPSHOT_REQUIRED');
      let cursor=BigInt(state.cursor);for(const c of page.items){const next=BigInt(c.cursor);if(next<=cursor){if(next<=BigInt(state.cursor))continue;throw fail('SYNC_CURSOR_ORDER_INVALID');}if(next!==cursor+1n)throw fail('SYNC_CURSOR_GAP');await change(c);cursor=next;}
      if(String(cursor)!==page.next_cursor)throw fail('SYNC_CURSOR_PAGE_MISMATCH');
      await balances();run('UPDATE sync_state SET download_cursor=? WHERE store_id=? AND device_id=?',[page.next_cursor,storeId,deviceId]);
    },
    staged:async()=>{const row=one<{manifest_json:string}>("SELECT manifest_json FROM sync_snapshot_staging WHERE state='downloading' ORDER BY rowid DESC LIMIT 1");return row?JSON.parse(row.manifest_json) as SnapshotManifest:undefined;},
    stage:async(manifest)=>{if(manifest.store_id!==storeId||manifest.device_id!==deviceId||manifest.state!=='ready'||manifest.schema_version!==14||manifest.protocol_version!==1||manifest.event_version!==2||manifest.device_received_seq===undefined||manifest.pages.some((p,i)=>p.page!==i))throw fail('SYNC_SNAPSHOT_INCOMPATIBLE');run("UPDATE sync_snapshot_staging SET state='expired' WHERE state='downloading' AND id<>?",[manifest.id]);run("INSERT INTO sync_snapshot_staging VALUES(?,?,'downloading') ON CONFLICT(id) DO NOTHING",[manifest.id,JSON.stringify(manifest)]);},
    stagedPages:async(id)=>(db.prepare('SELECT page_number FROM sync_snapshot_pages WHERE snapshot_id=? ORDER BY page_number').all(id) as {page_number:number}[]).map((r)=>r.page_number),
    stagePage:async(id,page)=>{const manifest=JSON.parse(one<{manifest_json:string}>('SELECT manifest_json FROM sync_snapshot_staging WHERE id=?',[id])!.manifest_json) as SnapshotManifest;const entry=manifest.pages.find((p)=>p.page===page.page);if(!entry||entry.checksum!==page.checksum||syncHashValue(page.records)!==page.checksum||page.records.length!==entry.records)throw fail('SYNC_SNAPSHOT_CHECKSUM_INVALID');run('INSERT INTO sync_snapshot_pages VALUES(?,?,?) ON CONFLICT DO NOTHING',[id,page.page,JSON.stringify(page)]);},
    install:async(id)=>{
      const row=one<{manifest_json:string}>('SELECT manifest_json FROM sync_snapshot_staging WHERE id=?',[id]);if(!row)throw fail('SYNC_SNAPSHOT_MISSING');const manifest=JSON.parse(row.manifest_json) as SnapshotManifest;
      const modules=new Set(['catalog','identity_references','stock','cash','sales','reversals','credit','reminders']);for(const [module,version]of Object.entries(manifest.modules))if(version>1||version>0&&!modules.has(module)||version>0&&['credit','reminders'].includes(module))throw fail('SYNC_MODULE_UPGRADE_REQUIRED');
      const seq=one<{seq:string}>('SELECT CAST(sequence_value AS TEXT) AS seq FROM device_sequences WHERE store_id=? AND device_id=?',[storeId,deviceId])?.seq??'0';if(BigInt(manifest.device_received_seq??'0')>BigInt(seq))throw fail('SYNC_RECOVERY_REQUIRED');
      const state=await runtime();if(BigInt(manifest.cut_cursor)<BigInt(state.cursor))throw fail('SYNC_SNAPSHOT_STALE');
      const pages=(db.prepare('SELECT page_json FROM sync_snapshot_pages WHERE snapshot_id=? ORDER BY page_number').all(id) as {page_json:string}[]).map((r)=>JSON.parse(r.page_json) as SnapshotPage);
      if(pages.length!==manifest.pages.length||syncHashValue(pages.map((p)=>p.checksum))!==manifest.checksum)throw fail('SYNC_SNAPSHOT_INCOMPLETE');
      const records:SnapshotRecord[]=pages.flatMap((p)=>p.records),counts:Record<string,number>={};for(const p of pages)if(syncHashValue(p.records)!==p.checksum)throw fail('SYNC_SNAPSHOT_CHECKSUM_INVALID');
      if(records.length>5000||Buffer.byteLength(JSON.stringify(pages))>4*1024*1024)throw fail('SYNC_SNAPSHOT_LIMIT');
      for(const r of records){if(!allowedTables.has(r.table))throw fail('SYNC_SNAPSHOT_TABLE_UNSUPPORTED');counts[r.table]=(counts[r.table]??0)+1;}
      for(const table of new Set([...Object.keys(counts),...Object.keys(manifest.counts)]))if((counts[table]??0)!==(manifest.counts[table]??0))throw fail('SYNC_SNAPSHOT_COUNT_MISMATCH');
      run('DELETE FROM sync_received_rows');run('DELETE FROM sync_stock_base');run('DELETE FROM sync_received_operations');
      for(const r of records)record(r.table,r.value);
      for(const kind of ['categories','products','customers','store_settings'] as const)for(const v of rows(kind))await catalog(kind,v);
      for(const v of rows('stock_balances'))run('INSERT INTO sync_stock_base VALUES(?,?)',[uuid(v.product_id),integer(v.quantity_milli)]);
      for(const v of rows('server_sync_resolutions')){if(!['accepted','rejected','confirmed'].includes(String(v.outcome)))throw fail('SYNC_RESOLUTION_INVALID');if(v.outcome!=='confirmed')outcome({operation_id:uuid(v.operation_id),resolution_id:uuid(v.id),outcome:v.outcome as 'accepted'|'rejected'});}
      const customers=db.prepare("SELECT operation_id,payload FROM operation_outbox WHERE event_type='customers.proposal.v1' AND device_seq<=CAST(? AS INTEGER)").all(manifest.device_received_seq??'0') as {operation_id:string;payload:string}[];
      for(const source of customers){const p=JSON.parse(source.payload) as {base_version:number;entity_id:string};if(p.base_version===0&&await business.customer(p.entity_id))outcome({operation_id:source.operation_id,resolution_id:source.operation_id,outcome:'accepted'});}
      run('UPDATE sync_runtime SET initialized=1,baseline_seq=? WHERE store_id=? AND device_id=?',[manifest.device_received_seq??'0',storeId,deviceId]);
      await balances();run('UPDATE sync_state SET download_cursor=? WHERE store_id=? AND device_id=?',[manifest.cut_cursor,storeId,deviceId]);run("UPDATE sync_snapshot_staging SET state='installed' WHERE id=?",[id]);
    },
  };
}
