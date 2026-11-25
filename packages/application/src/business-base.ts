import type { BusinessDependencies, BusinessTransaction, BusinessContext } from './business-ports.js';
import type { Permission } from '../../domain/src/authorization.js';
import { ApplicationError } from './application-error.js';
import { cursorId } from '../../domain/src/cursors.js';
export const businessError=(code:string,message='Conteúdo inválido.')=>new ApplicationError(code,message,'content');
export const businessConflict=(code:string,message='A base mudou; recarregue os dados antes de confirmar.')=>new ApplicationError(code,message,'conflict');
export const versionConflict=(current:number,expected:number)=>new ApplicationError('VERSION_CONFLICT','A base mudou; preserve a proposta e recarregue o cadastro.','conflict',false,undefined,{current_version:current,expected_version:expected});
export class BusinessBase {
  constructor(readonly deps:BusinessDependencies) {}
  now(){return this.deps.clock.now().toISOString();}
  authorize(context:BusinessContext,permission:Permission) {
    if(context.store_id!==this.deps.storeId || this.deps.local&&context.device_id!==this.deps.deviceId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');
    if(context.expires_at<=this.now()||context.authorized_at>this.now())throw new ApplicationError('AUTHENTICATION_REQUIRED','Renove a autenticação.','unauthenticated');
    if(!context.permissions.includes(permission))throw new ApplicationError('PERMISSION_DENIED','Permissão insuficiente.','forbidden');
  }
  writesAllowed(){if(!this.deps.local&&!this.deps.remoteWritesEnabled)throw new ApplicationError('CATALOG_PUBLICATION_REQUIRED','Escritas de cadastro aguardam publicação de mudanças B11; disponíveis apenas no ambiente isolado.','unavailable');}
  async transaction<T>(work:(tx:BusinessTransaction)=>Promise<T>):Promise<T>{return this.deps.unitOfWork.run(async(tx)=>{await tx.business.lockScope();return work(tx);});}
  async replay<T>(tx:BusinessTransaction,context:BusinessContext,id:string,command:unknown,work:()=>Promise<T>):Promise<T> {
    const hash=this.deps.hash(command),previous=await tx.business.intention(id);
    if(previous){if(previous.actor_id!==context.user_id||previous.command_hash!==hash)throw businessConflict('IDEMPOTENCY_CONFLICT','A intenção já foi usada com outro conteúdo.');return JSON.parse(previous.result_json) as T;}
    const result=await work();await tx.business.saveIntention({intention_id:id,store_id:this.deps.storeId,actor_id:context.user_id,command_hash:hash,result_json:JSON.stringify(result)});return result;
  }
  async event(tx:BusinessTransaction,context:BusinessContext,id:string,type:string,payload:unknown,reservedSequence?:string){
    const sequence=reservedSequence??await tx.sequences.next(this.deps.deviceId);
    await tx.outbox.append({operation_id:id,store_id:this.deps.storeId,device_id:this.deps.deviceId,device_seq:sequence,occurred_at:this.now(),event_type:type,payload:JSON.stringify(payload),authorization:context});
    await tx.audit.append({operation_id:id,store_id:this.deps.storeId,device_id:this.deps.deviceId,occurred_at:this.now(),action:type,
      actor_user_id:context.user_id,permissions_version:context.permissions_version,authorization_id:context.authorization_id,authorization_origin:context.authorization_origin});
  }
  scope(){return this.deps.local?'local_terminal' as const:'server_received' as const;}
  pageQuery(query:{q?:string;after?:string;limit?:number;active?:boolean}) {
    const limit=query.limit??50;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw businessError('INVALID_PAGE_LIMIT');
    const after=query.after===undefined?undefined:cursorId(query.after);if(query.after!==undefined&&!after)throw businessError('INVALID_CURSOR');
    return {limit,...(query.q?{q:query.q.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase(),code_q:query.q.normalize('NFC').trim().toUpperCase()}:{}),...(after?{after}:{}),...(query.active===undefined?{}:{active:query.active})};
  }
}
