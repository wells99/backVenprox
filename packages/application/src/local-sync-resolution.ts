import { ApplicationError } from './application-error.js';
import type { SyncCoordinator } from './sync-coordinator.js';
import type { BusinessContext } from './business-ports.js';
import type { PairedDevice } from './local-auth.js';
import type { ResolutionCommand,ResolutionResult } from './sync-resolution-ports.js';
export class LocalSyncResolutionService {
  constructor(readonly coordinator:SyncCoordinator,readonly submitRemote:(device:PairedDevice,id:string,command:ResolutionCommand)=>Promise<ResolutionResult>){}
  async submit(context:BusinessContext,id:string,command:ResolutionCommand){
    const {deps,outbox}=this.coordinator,at=deps.clock.now().toISOString();
    if(context.store_id!==deps.storeId||context.device_id!==deps.deviceId||context.authorization_origin!=='online'||!context.permissions.includes('recovery.manage')||!context.permissions.includes('users.manage'))throw new ApplicationError('PERMISSION_DENIED','Revisão administrativa online necessária.','forbidden');
    if(context.expires_at<=at||context.authorized_at>at)throw new ApplicationError('AUTHENTICATION_REQUIRED','Renove a autenticação.','unauthenticated');
    return this.coordinator.exclusive(async()=>{
      if((await deps.unitOfWork.run((tx)=>tx.replica.runtime())).state==='recovery_required')throw new ApplicationError('SYNC_RECOVERY_REQUIRED','Recupere a identidade antes de revisar a fila.','conflict');
      const device=await deps.device();if(!device?.session)throw new ApplicationError('AUTHENTICATION_REQUIRED','Renove a autenticação online.','unauthenticated');
      const delivery=await deps.unitOfWork.run((tx)=>tx.sync.delivery(command.operation_id));
      if(!delivery)throw new ApplicationError('SYNC_RESOLUTION_LOCAL_MISSING','Consulte a pendência antes de revisar.','conflict');
      try{await deps.gateway.receipt(device,command.operation_id);}catch(error){
        if(!(error instanceof ApplicationError&&error.kind==='not_found'))throw error;
        const row=await outbox.prepareNext(null,true);
        if(row?.operation_id!==command.operation_id||!row.envelope_json||!['pending','retry_wait'].includes(row.state))throw new ApplicationError('SYNC_RESOLUTION_NOT_ELIGIBLE','A operação precisa preservar origem e ordem para ser revisada.','conflict');
        await outbox.requestRetry(context);const envelope=await outbox.markSending(row.operation_id);
        try{const receipt=await deps.gateway.push(device,envelope);await outbox.acceptReceipt(row.operation_id,receipt);}catch(error){await outbox.retryAfterFailure(row.operation_id);throw error;}
      }
      const result=await this.submitRemote(device,id,command);
      if(result.id!==id||result.operation_id!==command.operation_id||result.device_id!==deps.deviceId)throw new ApplicationError('SYNC_RESOLUTION_MISMATCH','Resposta de outra resolução.','conflict');
      await outbox.acceptReceipt(command.operation_id,result.receipt);return result;
    });
  }
}
