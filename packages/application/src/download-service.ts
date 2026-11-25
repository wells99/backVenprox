import { ApplicationError } from './application-error.js';
import type { DownloadDependencies, DownloadTransaction, RecoveryContext, SnapshotKind, SnapshotManifest, SnapshotPage, SnapshotRecord } from './publication-ports.js';
import { validSequence } from '../../domain/src/sync.js';

const fail=(code:string,message:string,kind:'content'|'conflict'|'forbidden'|'not_found'='content')=>new ApplicationError(code,message,kind);
export class DownloadService {
  constructor(readonly deps:DownloadDependencies){}
  private run<T>(credential:string,work:(tx:DownloadTransaction,deviceId:string)=>Promise<T>,barrier=false){return this.deps.unitOfWork.run(async(tx)=>{
    if(barrier)await tx.publication.lock();
    const device=await tx.sync.device(this.deps.digest(credential));
    if(!credential||!device?.active)throw new ApplicationError('DEVICE_AUTHENTICATION_REQUIRED','Credencial de terminal inválida.','unauthenticated');
    return work(tx,device.id);
  });}
  private recovery(context:RecoveryContext){const now=this.deps.clock.now().toISOString();
    if(!context||context.store_id!==this.deps.storeId||context.authorization_origin!=='online'||context.expires_at<=now||context.authorized_at>now||!context.permissions.includes('recovery.manage'))throw fail('RECOVERY_AUTHORIZATION_REQUIRED','Autorização online recovery.manage necessária.','forbidden');
  }
  async changes(credential:string,after='0',limit=50){
    if(after!=='0'&&!validSequence(after)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail('INVALID_CURSOR_OR_LIMIT','Cursor decimal ou limite inválido.');
    return this.run(credential,async(tx)=>{
      const state=await tx.publication.state();
      if(BigInt(after)<BigInt(state.floor))throw fail('SNAPSHOT_REQUIRED','Cursor anterior ao piso disponível; obtenha um snapshot.','conflict');
      if(BigInt(after)>BigInt(state.cursor))throw fail('CURSOR_AHEAD','Cursor posterior ao estado recebido.','conflict');
      const rows=await tx.publication.changes(after,limit+1),items=rows.slice(0,limit);
      return {items,next_cursor:items.at(-1)?.cursor??after,retention_floor:state.floor,has_more:rows.length>limit,protocol_version:1 as const,event_version:2 as const};
    },true);
  }
  async createSnapshot(credential:string,kind:SnapshotKind,context?:RecoveryContext){
    if(!['initial','operational'].includes(kind))throw fail('INVALID_SNAPSHOT_KIND','Tipo de captura inválido.');
    if(kind==='operational')this.recovery(context);
    const snapshotId=this.deps.ids.generate();
    return this.run(credential,async(tx,deviceId)=>{
      const cut=await tx.publication.state(),capture=await tx.publication.capture(kind),pages:SnapshotPage[]=[];
      let records:SnapshotRecord[]=[];
      const flush=()=>{if(records.length){pages.push({page:pages.length,checksum:this.deps.hash(records),records});records=[];}};
      for(const record of capture.records){
        if(this.deps.bytes(record)>256*1024)throw fail('SNAPSHOT_LIMIT_EXCEEDED','Registro excede o limite de página de 256 KiB.');
        if(records.length===100||this.deps.bytes([...records,record])>256*1024)flush();records.push(record);
      }flush();
      const created=this.deps.clock.now(),manifest:SnapshotManifest={id:snapshotId,store_id:this.deps.storeId,device_id:deviceId,kind,state:'ready',cut_cursor:cut.cursor,created_at:created.toISOString(),expires_at:new Date(created.getTime()+3600000).toISOString(),schema_version:14,protocol_version:1,event_version:2,device_received_seq:await tx.sync.frontier(deviceId),
        modules:{catalog:1,identity_references:1,stock:1,...(kind==='operational'?{cash:1,sales:1,reversals:1}:{}),credit:0,reminders:0},counts:capture.counts,pages:pages.map((p)=>({page:p.page,checksum:p.checksum,records:p.records.length})),checksum:this.deps.hash(pages.map((p)=>p.checksum)),bytes:this.deps.bytes(pages),capture_ms:capture.capture_ms};
      if(manifest.bytes>4*1024*1024)throw fail('SNAPSHOT_LIMIT_EXCEEDED','Captura excede 4 MiB.');
      await tx.publication.saveSnapshot(manifest,pages);
      await tx.audit.append({operation_id:manifest.id,store_id:this.deps.storeId,device_id:deviceId,occurred_at:manifest.created_at,action:`sync.snapshot.${kind}.created`,...(context?{actor_user_id:context.user_id,permissions_version:context.permissions_version,authorization_origin:context.authorization_origin,authorization_id:context.authorization_id}:{})});
      return manifest;
    },true);
  }
  private async find(tx:DownloadTransaction,deviceId:string,id:string,context?:RecoveryContext){
    const manifest=await tx.publication.manifest(id,deviceId);
    if(!manifest)throw fail('SNAPSHOT_NOT_FOUND','Captura não encontrada.','not_found');
    if(manifest.kind==='operational')this.recovery(context);
    return {...manifest,state:manifest.expires_at<=this.deps.clock.now().toISOString()?'expired' as const:'ready' as const};
  }
  async manifest(credential:string,id:string,context?:RecoveryContext){return this.run(credential,(tx,device)=>this.find(tx,device,id,context));}
  async page(credential:string,id:string,page:number,context?:RecoveryContext){
    if(!Number.isSafeInteger(page)||page<0)throw fail('INVALID_SNAPSHOT_PAGE','Página inválida.');
    return this.run(credential,async(tx,device)=>{
      const manifest=await this.find(tx,device,id,context);
      if(manifest.state==='expired')throw fail('SNAPSHOT_EXPIRED','Captura expirada; solicite outra.','conflict');
      const result=await tx.publication.page(id,page);if(!result)throw fail('SNAPSHOT_PAGE_NOT_FOUND','Página não encontrada.','not_found');return result;
    });
  }
}
