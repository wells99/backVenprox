import type { AuthorizedContext } from '../../domain/src/authorization.js';
import { catalogText } from '../../domain/src/catalog-stock.js';
import { ApplicationError } from './application-error.js';
import type { JobDependencies, Job } from './job-ports.js';
const conflict=(code='JOB_CONFLICT')=>new ApplicationError(code,'A tarefa mudou; recarregue antes de tentar novamente.','conflict');
export class JobService {
  private readonly auditDevice:string;
  constructor(readonly deps:JobDependencies){this.auditDevice=deps.ids.generate();}
  private authorize(c:AuthorizedContext,permission:'catalog.read'|'recovery.manage'){
    const now=this.deps.clock.now().toISOString();if(c.store_id!==this.deps.storeId||c.authorization_origin!=='online'||!c.permissions.includes(permission))throw new ApplicationError('PERMISSION_DENIED','Permissão insuficiente.','forbidden');
    if(c.expires_at<=now||c.authorized_at>now)throw new ApplicationError('AUTHENTICATION_REQUIRED','Renove a autenticação.','unauthenticated');
  }
  private public(job:Job){return {id:job.id,type:job.type,payload_version:job.payload_version,status:job.status,created_at:job.created_at,attempts:job.attempts,version:job.version,last_code:job.last_code,result_available:job.status==='succeeded'};}
  async requestCatalogExport(c:AuthorizedContext,key:string){
    this.authorize(c,'catalog.read');const include_costs=c.permissions.includes('costs.read'),id=this.deps.ids.generate();
    const job:Job={id,store_id:this.deps.storeId,type:'catalog.export.v1',payload_version:1,payload_json:JSON.stringify({include_costs}),deduplication_key:key,partition_key:`catalog-export:${c.user_id}`,actor_id:c.user_id,command_hash:this.deps.hash({actor:c.user_id,include_costs}),status:'queued',created_at:this.deps.clock.now().toISOString(),available_at:0,attempts:0,lease_owner:null,lease_until:0,lease_token:'0',version:1,last_code:null};
    return this.deps.unitOfWork.run(async(tx)=>{
      const value=await tx.jobs.enqueue(job);
      if(value.actor_id!==c.user_id||value.command_hash!==job.command_hash)throw conflict('IDEMPOTENCY_CONFLICT');
      if(value.id===id)await tx.audit.append({operation_id:id,store_id:this.deps.storeId,device_id:this.auditDevice,occurred_at:job.created_at,action:'job.requested',actor_user_id:c.user_id,permissions_version:c.permissions_version,authorization_origin:c.authorization_origin,authorization_id:c.authorization_id});
      return this.public(value);
    });
  }
  private async owned(c:AuthorizedContext,id:string){this.authorize(c,'catalog.read');return this.deps.unitOfWork.run(async(tx)=>{const job=await tx.jobs.get(id);if(!job||job.actor_id!==c.user_id)throw new ApplicationError('JOB_NOT_FOUND','Tarefa não encontrada.','not_found');return job;});}
  async get(c:AuthorizedContext,id:string){return this.public(await this.owned(c,id));}
  async result(c:AuthorizedContext,id:string){
    const job=await this.owned(c,id);if(job.status!=='succeeded')throw conflict('JOB_RESULT_NOT_READY');
    if((JSON.parse(job.payload_json) as {include_costs:boolean}).include_costs&&!c.permissions.includes('costs.read'))throw new ApplicationError('PERMISSION_DENIED','Permissão de custo necessária.','forbidden');
    // Completed results are immutable. Reading them does not renew an old lease.
    return this.deps.unitOfWork.run(async(tx)=>{const value=await tx.jobs.effect({id,owner:'',token:''});if(!value)throw conflict('JOB_RESULT_NOT_READY');return value;});
  }
  async retry(c:AuthorizedContext,id:string,key:string,version:number,reason:string){
    this.authorize(c,'recovery.manage');const normalized=catalogText(reason,500,true);if(!normalized||!Number.isSafeInteger(version)||version<1)throw new ApplicationError('INVALID_JOB_RETRY','Informe versão e motivo válidos.','content');
    const command_hash=this.deps.hash({id,version,reason:normalized,actor:c.user_id});
    return this.deps.unitOfWork.run(async(tx)=>{
      const prior=await tx.jobs.retryRecord(key);if(prior){if(prior.actor_id!==c.user_id||prior.command_hash!==command_hash)throw conflict('IDEMPOTENCY_CONFLICT');return this.public(JSON.parse(prior.result_json) as Job);}
      const job=await tx.jobs.retry({operation_id:key,store_id:this.deps.storeId,job_id:id,actor_id:c.user_id,command_hash,result_json:'{}',reason:normalized},version);
      await tx.audit.append({operation_id:key,store_id:this.deps.storeId,device_id:this.auditDevice,occurred_at:this.deps.clock.now().toISOString(),action:'job.retry_requested',actor_user_id:c.user_id,permissions_version:c.permissions_version,authorization_origin:c.authorization_origin,authorization_id:c.authorization_id});return this.public(job);
    });
  }
}
