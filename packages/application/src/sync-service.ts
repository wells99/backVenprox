import { ApplicationError } from './application-error.js';
import { SyncRejection, type SyncDependencies, type SyncEnvelope, type SyncReceipt, type SyncTransaction, type SyncDevice } from './sync-ports.js';
import { SyncHandlers } from './sync-handlers.js';
import { validSequence } from '../../domain/src/sync.js';
import type { Permission } from '../../domain/src/authorization.js';
export class SyncService {
  constructor(readonly deps:SyncDependencies){}
  private async run<T>(credential:string,work:(tx:SyncTransaction,device:SyncDevice)=>Promise<T>):Promise<T>{return this.deps.unitOfWork.run(async(tx)=>{
    await tx.business.lockScope();const device=await tx.sync.device(this.deps.digest(credential));if(!credential||!device?.active)throw new ApplicationError('DEVICE_AUTHENTICATION_REQUIRED','Credencial de terminal inválida.','unauthenticated');return work(tx,device);
  });}
  private receipt(e:SyncEnvelope,status:SyncReceipt['status'],code:string,result:SyncReceipt['result']=null):SyncReceipt{return {operation_id:e.operation_id,device_id:e.device_id,device_seq:e.device_seq,payload_hash:e.payload_hash,status,code,result};}
  private async incident(tx:SyncTransaction,e:SyncEnvelope,receipt:SyncReceipt){const id=this.deps.ids.generate();await tx.sync.incident(id,e,receipt);await tx.audit.append({operation_id:id,store_id:e.store_id,device_id:e.device_id,occurred_at:this.deps.clock.now().toISOString(),action:'sync.incident_recorded'});return receipt;}
  async deviceState(credential:string){return this.run(credential,async(tx,device)=>({store_id:this.deps.storeId,device_id:device.id,received_seq:await tx.sync.frontier(device.id),accepted_protocols:[1],sync_enabled:this.deps.writesEnabled,local_pending:'unknown' as const}));}
  async getReceipt(credential:string,id:string){return this.run(credential,async(tx,device)=>{const row=await tx.sync.inbox(id);if(!row||row.device_id!==device.id)throw new ApplicationError('RECEIPT_NOT_FOUND','Recibo não encontrado.','not_found');return JSON.parse(row.receipt_json) as SyncReceipt;});}
  async push(credential:string,items:SyncEnvelope[]){
    const device=await this.run(credential,async(_tx,device)=>device);
    if(!this.deps.writesEnabled)throw new ApplicationError('SYNC_PUBLICATION_REQUIRED','Recepção operacional aguarda publicação atômica B11.','unavailable');
    const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
    if(!items.length||items.length>50||bytes({items})>512*1024||items.some((e)=>bytes(e)>64*1024))throw new ApplicationError('SYNC_BATCH_LIMIT','Lote excede os limites de sincronização.','content');
    if(items.some((e)=>!validSequence(e.device_seq)))throw new ApplicationError('INVALID_DEVICE_SEQUENCE','Sequência fora da faixa suportada.','content');
    if(items.some((e)=>e.store_id!==this.deps.storeId||e.device_id!==device.id))throw new ApplicationError('SCOPE_MISMATCH','Envelope pertence a outra origem.','forbidden');
    const receipts:SyncReceipt[]=[];let stopped=false;
    for(const event of items){if(stopped){receipts.push(this.receipt(event,'blocked','PREVIOUS_OPERATION_BLOCKED'));continue;}
      const receipt=await this.receive(credential,event);receipts.push(receipt);stopped=!['applied','duplicate'].includes(receipt.status);
    }return {items:receipts};
  }
  private permission(type:string,payload:unknown):Permission|undefined {
    if(type==='customers.proposal.v1'){const p=payload as {base_version:number;proposal:{confirmation_state?:string}};if(p.base_version===0&&p.proposal.confirmation_state==='local_pending')return 'sales.create';}
    if(type==='cash.opened')return 'cash.open';if(type==='cash.closed')return 'cash.close';if(type==='cash.movement_recorded')return 'cash.adjust';if(type==='sale.completed'||type==='customer.created.v1')return 'sales.create';if(type==='sale.reversed')return 'sales.reverse';if(type==='stock.projection.rebuilt.v1')return 'recovery.manage';if(type.startsWith('stock.'))return 'stock.adjust';if(type.startsWith('settings.')||type==='terminal.settings.updated.v1')return 'settings.manage';if(/^(products|categories|customers)\.proposal/.test(type))return 'catalog.write';return undefined;
  }
  async validateOrigin(tx:SyncTransaction,e:SyncEnvelope){
    const c=e.origin_authorization.context,time=Date.parse(e.occurred_at_device),start=Date.parse(c.authorized_at),end=Date.parse(c.expires_at),permission=this.permission(e.type,e.payload);
    if(c.store_id!==e.store_id||c.device_id!==e.device_id||!Number.isFinite(time)||!Number.isFinite(start)||!Number.isFinite(end)||time<start||time>=end||time>this.deps.clock.now().getTime()+300000||!permission||!c.permissions.includes(permission))throw new SyncRejection('quarantined','ORIGIN_AUTHORIZATION_INVALID');
    const evidence=await tx.sync.originEvidence(c);
    if(c.authorization_origin==='offline'){
      if(!e.origin_authorization.signature)throw new SyncRejection('quarantined','ORIGIN_AUTHORIZATION_UNPROVEN');
      let signed;try{signed=this.deps.verifyOriginSignature(e.origin_authorization.signature??'');}catch{throw new SyncRejection('quarantined','ORIGIN_SIGNATURE_INVALID');}
      const grant=evidence.grant;if(this.deps.hashValue(signed)!==this.deps.hashValue(c)||!grant||grant.user_id!==c.user_id||grant.device_id!==e.device_id||grant.permissions_version!==c.permissions_version||grant.issued_at!==c.authorized_at||grant.expires_at!==c.expires_at||grant.revoked_at!==null&&Date.parse(grant.revoked_at)<=time)throw new SyncRejection('quarantined','ORIGIN_AUTHORIZATION_UNPROVEN');return;
    }
    const knownWindow=evidence.authorizations.some((a)=>a.permissions_version===c.permissions_version&&Date.parse(a.occurred_at)<=start+1000&&end<=Date.parse(a.occurred_at)+901000);
    if(e.origin_authorization.signature!==null||evidence.session_user_id!==c.user_id||evidence.user_version!==c.permissions_version||!evidence.session_expires||end>Date.parse(evidence.session_expires)||evidence.session_revoked_at!==null&&Date.parse(evidence.session_revoked_at)<=time||!knownWindow||this.deps.hashValue([...c.permissions].sort())!==this.deps.hashValue([...evidence.permissions].sort()))throw new SyncRejection('quarantined','ORIGIN_AUTHORIZATION_UNPROVEN');
  }
  private async receive(credential:string,e:SyncEnvelope):Promise<SyncReceipt>{return this.run(credential,async(tx,device)=>{
    if(device.id!==e.device_id)throw new ApplicationError('SCOPE_MISMATCH','Origem inválida.','forbidden');let hash:string,canonical=true;
    try{hash=this.deps.hashEnvelope(e);}catch{hash=this.deps.digest(JSON.stringify(e));canonical=false;}
    const prior=await tx.sync.inbox(e.operation_id),collision=await tx.sync.inboxSequence(e.device_id,e.device_seq);
    if(prior){if(prior.device_id===e.device_id&&prior.payload_hash===e.payload_hash&&prior.envelope_hash===hash){const receipt=JSON.parse(prior.receipt_json) as SyncReceipt;return receipt.status==='applied'?{...receipt,status:'duplicate',code:'DUPLICATE'}:receipt;}
      return this.incident(tx,e,this.receipt(e,'conflict','OPERATION_CONTENT_CONFLICT'));}
    if(collision)return this.incident(tx,e,this.receipt(e,'conflict','DEVICE_SEQUENCE_CONFLICT'));
    const at=this.deps.clock.now().toISOString();await tx.sync.insertInbox({operation_id:e.operation_id,store_id:e.store_id,device_id:e.device_id,device_seq:e.device_seq,payload_hash:e.payload_hash,envelope_hash:hash,envelope_json:JSON.stringify(e),receipt_json:JSON.stringify(this.receipt(e,'blocked','PROCESSING')),state:'processing',received_at:at});
    await tx.sync.savepoint();
    try{
      if(!validSequence(e.device_seq))throw new SyncRejection('quarantined','INVALID_DEVICE_SEQUENCE');
      if(!canonical||hash!==e.payload_hash)throw new SyncRejection('quarantined','PAYLOAD_HASH_MISMATCH');
      if(e.protocol_version!==1||e.payload_version!==1)throw new SyncRejection('quarantined','UNSUPPORTED_PROTOCOL_OR_PAYLOAD');
      if(BigInt(e.device_seq)!==BigInt(await tx.sync.frontier(e.device_id))+1n)throw new SyncRejection('blocked','SEQUENCE_GAP');
      if(!this.deps.validatePayload(e.type,e.payload_version,e.payload))throw new SyncRejection('quarantined','UNSUPPORTED_OR_INVALID_PAYLOAD');
      await this.validateOrigin(tx,e);
      for(const id of e.dependencies){const dependency=await tx.sync.inbox(id);if(!dependency||dependency.state!=='applied')throw new SyncRejection('blocked','DEPENDENCY_MISSING');}
      const result=await new SyncHandlers(this.deps).apply(tx,e,device.code);
      await tx.audit.append({operation_id:e.operation_id,store_id:e.store_id,device_id:e.device_id,occurred_at:e.occurred_at_device,action:e.type,actor_user_id:e.origin_authorization.context.user_id,permissions_version:e.origin_authorization.context.permissions_version,authorization_id:e.origin_authorization.context.authorization_id,authorization_origin:e.origin_authorization.context.authorization_origin});
      await this.deps.publication.publish(tx,e,result);
      const receipt=this.receipt(e,'applied','APPLIED',result);await tx.sync.finishInbox(e.operation_id,'applied',JSON.stringify(receipt));await tx.sync.advance(e.device_id,e.device_seq);return receipt;
    }catch(error){if(!(error instanceof SyncRejection))throw error;await tx.sync.rollbackEffects();const receipt=this.receipt(e,error.status,error.code);await tx.audit.append({operation_id:e.operation_id,store_id:e.store_id,device_id:e.device_id,occurred_at:at,action:`sync.${error.status}`});await tx.sync.finishInbox(e.operation_id,error.status,JSON.stringify(receipt));return receipt;}
  });}
}
