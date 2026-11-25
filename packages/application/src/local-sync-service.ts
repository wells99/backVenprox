import { ApplicationError } from './application-error.js';
import type { LocalSyncDependencies, LocalSyncContext, LocalDelivery, LocalSyncReceipt } from './local-sync-ports.js';
import type { SyncEnvelope } from './sync-ports.js';
import type { AuthorizedContext } from '../../domain/src/authorization.js';
const failure=(code:string)=>new ApplicationError(code,'Não foi possível avançar esta operação; o conteúdo original foi preservado.','conflict');
// Durable outbox primitives for the B12 coordinator. No network or financial
// reexecution occurs here; only a verified receipt may acknowledge the source.
export class LocalSyncService {
  constructor(readonly deps:LocalSyncDependencies){}
  private now(){return this.deps.clock.now().toISOString();}
  private authorize(context:LocalSyncContext){
    if(context.store_id!==this.deps.storeId||context.device_id!==this.deps.deviceId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');
    if(context.expires_at<=this.now()||context.authorized_at>this.now())throw new ApplicationError('AUTHENTICATION_REQUIRED','Renove a autenticação.','unauthenticated');
    if(!context.permissions.includes('catalog.read'))throw new ApplicationError('PERMISSION_DENIED','Permissão insuficiente.','forbidden');
  }
  async initialize(){await this.deps.unitOfWork.run(async(tx)=>{await tx.sync.initialize();await tx.sync.recoverSending(this.now());});}
  async getStatus(context:LocalSyncContext){this.authorize(context);return this.deps.unitOfWork.run((tx)=>tx.sync.status());}
  async listConflicts(context:LocalSyncContext){this.authorize(context);return this.deps.unitOfWork.run(async(tx)=>({items:await tx.sync.conflicts()}));}
  async requestRetry(context:LocalSyncContext){this.authorize(context);const id=this.deps.ids.generate();return this.deps.unitOfWork.run(async(tx)=>{
    await tx.sync.requestRetry(this.now());await tx.audit.append({operation_id:id,store_id:this.deps.storeId,device_id:this.deps.deviceId,occurred_at:this.now(),action:'sync.retry_requested',actor_user_id:context.user_id,permissions_version:context.permissions_version,authorization_id:context.authorization_id,authorization_origin:context.authorization_origin});
    return {scheduled:true as const,automatic_sync_enabled:(await tx.sync.status()).automatic_sync_enabled};
  });}
  async prepareNext(originSignature:string|null=null,forAdministrativeReview=false):Promise<LocalDelivery|undefined>{return this.deps.unitOfWork.run(async(tx)=>{
    const source=await tx.sync.sourceNext();if(!source)return undefined;
    if(source.store_id!==this.deps.storeId||source.device_id!==this.deps.deviceId)throw new ApplicationError('SCOPE_MISMATCH','Origem pertence a outro terminal.','forbidden');
    const previous=await tx.sync.delivery(source.operation_id);if(previous&&!(previous.envelope_json===null&&previous.last_code==='ORIGIN_PROOF_REQUIRED'&&(originSignature||forAdministrativeReview)))return previous;
    const base:LocalDelivery={operation_id:source.operation_id,store_id:source.store_id,device_id:source.device_id,device_seq:source.device_seq,event_type:source.event_type,envelope_json:null,payload_hash:null,state:'pending',attempts:0,next_attempt_at:null,last_code:null,receipt_json:null};
    let envelope:SyncEnvelope;
    try{
      const context=JSON.parse(source.authorization_context??'null') as AuthorizedContext|null;
      if(!context||context.store_id!==this.deps.storeId||context.device_id!==this.deps.deviceId)throw failure('ORIGIN_AUTHORIZATION_MISSING');
      if(context.authorization_origin==='offline'&&!originSignature&&!forAdministrativeReview)throw failure('ORIGIN_PROOF_REQUIRED');
      envelope={protocol_version:1,payload_version:1,store_id:source.store_id,device_id:source.device_id,operation_id:source.operation_id,device_seq:source.device_seq,type:source.event_type,occurred_at_device:source.occurred_at,origin_authorization:{context,signature:context.authorization_origin==='offline'?originSignature:null},dependencies:[],payload:JSON.parse(source.payload),payload_hash:'0'.repeat(64)};
      envelope.payload_hash=this.deps.hashEnvelope(envelope);
      if(!this.deps.validateEnvelope(envelope)||new TextEncoder().encode(JSON.stringify(envelope)).length>64*1024)throw failure('SYNC_OPERATION_LIMIT_OR_CONTRACT');
    }catch(error){
      const code=error instanceof ApplicationError?error.code:'ORIGIN_ENVELOPE_INVALID';const blocked={...base,state:'blocked' as const,last_code:code};await tx.sync.save(blocked);return blocked;
    }
    const value={...base,envelope_json:JSON.stringify(envelope),payload_hash:envelope.payload_hash};await tx.sync.save(value);return value;
  });}
  async markSending(id:string){return this.deps.unitOfWork.run(async(tx)=>{
    const next=await tx.sync.sourceNext(),row=await tx.sync.delivery(id);
    if(!row||next?.operation_id!==id||!row.envelope_json||!['pending','retry_wait'].includes(row.state)||row.next_attempt_at!==null&&row.next_attempt_at>this.now())throw failure('SYNC_OPERATION_NOT_ELIGIBLE');
    const value={...row,state:'sending' as const,attempts:row.attempts+1,next_attempt_at:null};await tx.sync.save(value);return JSON.parse(value.envelope_json!) as SyncEnvelope;
  });}
  async acceptReceipt(id:string,value:unknown){
    if(!this.deps.validateReceipt(value))throw failure('SYNC_RECEIPT_INVALID');const receipt=value as LocalSyncReceipt;
    return this.deps.unitOfWork.run(async(tx)=>{
      const row=await tx.sync.delivery(id);
      if(!row||receipt.operation_id!==id||receipt.device_id!==this.deps.deviceId||receipt.device_seq!==row.device_seq||receipt.payload_hash!==row.payload_hash)throw failure('SYNC_RECEIPT_MISMATCH');
      if(row.state==='acknowledged'){
        const prior=JSON.parse(row.receipt_json!) as LocalSyncReceipt;
        if(prior.result?.entity_id!==receipt.result?.entity_id||prior.result?.received_at!==receipt.result?.received_at||prior.result?.reconciliation!==receipt.result?.reconciliation||!['applied','duplicate'].includes(receipt.status))throw failure('SYNC_RECEIPT_MISMATCH');return {acknowledged:true};
      }
      const resolved=['APPLIED_BY_RESOLUTION','RESOLVED_WITHOUT_EFFECT'].includes(receipt.code);
      if(row.state!=='sending'&&!resolved)throw failure('SYNC_OPERATION_NOT_SENDING');
      if(receipt.code==='RESOLVED_WITHOUT_EFFECT'&&!/^(products|categories|customers|settings)\.proposal/.test(row.event_type)&&row.event_type!=='terminal.settings.updated.v1')throw failure('SYNC_RESOLUTION_INVALID');
      await tx.sync.contact(this.now(),true);
      if(['applied','duplicate'].includes(receipt.status)){
        if(!receipt.result)throw failure('SYNC_RECEIPT_INVALID');
        await tx.sync.save({...row,state:'acknowledged',receipt_json:JSON.stringify(receipt),last_code:receipt.code});await tx.sync.acknowledge(id,this.now());return {acknowledged:true};
      }
      await tx.sync.save({...row,state:receipt.status==='conflict'?'conflict':'blocked',receipt_json:JSON.stringify(receipt),last_code:receipt.code});return {acknowledged:false};
    });
  }
  async retryAfterFailure(id:string){return this.deps.unitOfWork.run(async(tx)=>{
    const row=await tx.sync.delivery(id);if(!row||row.state!=='sending')throw failure('SYNC_OPERATION_NOT_SENDING');
    const jitter=Math.max(0,Math.min(1,this.deps.random())),seconds=Math.min(300,2**Math.min(row.attempts,9))*(0.5+jitter/2);
    await tx.sync.save({...row,state:'retry_wait',next_attempt_at:new Date(this.deps.clock.now().getTime()+Math.ceil(seconds*1000)).toISOString(),last_code:'REMOTE_RESPONSE_UNCERTAIN'});
  });}
}
