import { LocalSyncService } from './local-sync-service.js';
import { ApplicationError } from './application-error.js';
import type { SyncCoordinatorDependencies } from './sync-coordinator-ports.js';
import type { PairedDevice } from './local-auth.js';
export class SyncCoordinator {
  private active:Promise<void>|undefined;
  readonly outbox:LocalSyncService;
  constructor(readonly deps:SyncCoordinatorDependencies){this.outbox=new LocalSyncService(deps);}
  // An explicit request made during a running cycle must get a fresh contact
  // after that cycle finishes, including its telemetry. Polling may coalesce.
  requestCycle():Promise<void>{return this.active?this.active.then(()=>this.cycle()):this.cycle();}
  cycle():Promise<void>{if(this.active)return this.active;const pending=this.work().then(async()=>{if(!this.deps.gateway.report)return;try{const device=await this.deps.device();if(device){const status=await this.deps.unitOfWork.run((tx)=>tx.sync.status());await this.deps.gateway.report(device,{download_cursor:status.download_cursor,pending:status.pending,in_flight:status.in_flight,acknowledged:status.acknowledged,conflicts:status.conflicts,oldest_pending_at:status.oldest_pending_at,last_receipt_at:status.last_receipt_at,phase:status.phase,last_code:status.last_code??null,automatic_sync_enabled:status.automatic_sync_enabled,schema_version:16,protocol_version:1});}}catch{ /* Telemetry never acknowledges financial operations. */ }}).finally(()=>{if(this.active===pending)this.active=undefined;});this.active=pending;return pending;}
  exclusive<T>(work:()=>Promise<T>):Promise<T>{const result=(this.active??Promise.resolve()).then(work),pending=result.then(()=>{},()=>{});this.active=pending;void pending.then(()=>{if(this.active===pending)this.active=undefined;});return result;}
  private state(value:string,code:string|null=null){return this.deps.unitOfWork.run((tx)=>tx.replica.runtime().then(runtime=>tx.replica.state(value,code,this.deps.clock.now().toISOString(),runtime.enabled)));}
  private async bootstrap(device:PairedDevice){
    let manifest=await this.deps.unitOfWork.run((tx)=>tx.replica.staged());
    if(manifest){const current=await this.deps.gateway.manifest(device,manifest.id);if(current.state==='expired')manifest=undefined;else if(current.id!==manifest.id||current.store_id!==manifest.store_id||current.device_id!==manifest.device_id||current.checksum!==manifest.checksum||current.cut_cursor!==manifest.cut_cursor)throw new ApplicationError('SYNC_SNAPSHOT_INCOMPATIBLE','Manifesto alterado durante a instalação.','conflict');}
    if(!manifest){manifest=await this.deps.gateway.snapshot(device);await this.deps.unitOfWork.run((tx)=>tx.replica.stage(manifest!));}
    const existing=new Set(await this.deps.unitOfWork.run((tx)=>tx.replica.stagedPages(manifest!.id)));let fetched=0;
    for(const page of manifest.pages){if(existing.has(page.page))continue;if(fetched++>=(this.deps.maxPages??5)){await this.state('snapshot_downloading');return false;}const value=await this.deps.gateway.page(device,manifest.id,page.page);await this.deps.unitOfWork.run((tx)=>tx.replica.stagePage(manifest!.id,value));}
    await this.deps.unitOfWork.run((tx)=>tx.replica.install(manifest!.id));return true;
  }
  private async download(device:PairedDevice){
    for(let count=0;count<(this.deps.maxPages??2);count++){
      const runtime=await this.deps.unitOfWork.run((tx)=>tx.replica.runtime());
      const page=await this.deps.gateway.changes(device,runtime.cursor);await this.deps.unitOfWork.run((tx)=>tx.replica.apply(page));if(!page.has_more)return;
    }
  }
  private async work(){
    let sending:string|undefined;
    try{
      if((await this.deps.unitOfWork.run((tx)=>tx.replica.runtime())).state==='recovery_required')return;
      const device=await this.deps.device();if(!device){await this.state('unpaired','DEVICE_NOT_PAIRED');return;}
      if(device.store_id!==this.deps.storeId||device.device_id!==this.deps.deviceId)throw new ApplicationError('SYNC_DEVICE_SCOPE_MISMATCH','Terminal de outra instalação.','forbidden');
      await this.state('checking');const server=await this.deps.gateway.compatible(device);
      if(server.store_id!==this.deps.storeId||server.device_id!==this.deps.deviceId)throw new ApplicationError('SYNC_DEVICE_SCOPE_MISMATCH','Servidor retornou outra origem.','forbidden');
      if(!server.sync_enabled)throw new ApplicationError('SYNC_REMOTE_DISABLED','Servidor ainda não recebe sincronização.','unavailable',true);
      await this.deps.unitOfWork.run((tx)=>tx.sync.contact(this.deps.clock.now().toISOString()));
      const runtime=await this.deps.unitOfWork.run((tx)=>tx.replica.runtime());
      if(BigInt(server.received_seq)>BigInt(runtime.local_seq))throw new ApplicationError('SYNC_RECOVERY_REQUIRED','A fronteira remota supera a sequência local; preserve os dados e faça a recuperação.','conflict');
      const staged=await this.deps.unitOfWork.run((tx)=>tx.replica.staged());
      if((!runtime.initialized||staged)&&!await this.bootstrap(device))return;
      try{await this.download(device);}catch(error){if(!(error instanceof ApplicationError&&error.code==='SNAPSHOT_REQUIRED'))throw error;if(!await this.bootstrapFresh(device))return;await this.download(device);}
      for(let count=0;count<(this.deps.maxOperations??10);count++){
        const source=await this.deps.unitOfWork.run((tx)=>tx.sync.sourceNext());if(!source)break;
        let context:{authorization_origin?:string;authorization_id?:string}|null=null;try{context=JSON.parse(source.authorization_context??'null') as {authorization_origin?:string;authorization_id?:string}|null;}catch{ /* prepareNext records the invalid origin durably. */ }
        const proof=context?.authorization_origin==='offline'&&context.authorization_id?await this.deps.proof(context.authorization_id):undefined;
        const row=await this.outbox.prepareNext(proof??null);if(!row)break;
        if(row.state==='blocked'||row.state==='conflict'){
          try{const receipt=await this.deps.gateway.receipt(device,row.operation_id);if(['APPLIED_BY_RESOLUTION','RESOLVED_WITHOUT_EFFECT'].includes(receipt.code)&&['applied','duplicate'].includes(receipt.status)){await this.outbox.acceptReceipt(row.operation_id,receipt);continue;}}catch(error){if(!(error instanceof ApplicationError&&error.kind==='not_found'))throw error;}
          await this.state('blocked',row.last_code);return;
        }
        if(row.next_attempt_at&&row.next_attempt_at>this.deps.clock.now().toISOString()){await this.state('retry_wait',row.last_code);return;}
        const envelope=await this.outbox.markSending(row.operation_id);sending=row.operation_id;
        const receipt=await this.deps.gateway.push(device,envelope);await this.outbox.acceptReceipt(row.operation_id,receipt);sending=undefined;
        if(!['applied','duplicate'].includes(receipt.status)){await this.state('blocked',receipt.code);return;}
      }
      await this.download(device);await this.state('idle');
    }catch(error){
      if(sending)await this.outbox.retryAfterFailure(sending);
      const code=error instanceof ApplicationError?error.code:'SYNC_STORAGE_OR_TRANSPORT_FAILED';
      await this.state(code==='SYNC_RECOVERY_REQUIRED'?'recovery_required':/UPGRADE|INCOMPATIBLE|UNSUPPORTED/.test(code)?'upgrade_required':error instanceof ApplicationError&&!error.retryable?'blocked':'retry_wait',code);
    }
  }
  private async bootstrapFresh(device:PairedDevice){const manifest=await this.deps.gateway.snapshot(device);await this.deps.unitOfWork.run((tx)=>tx.replica.stage(manifest));return this.bootstrap(device);}
}
