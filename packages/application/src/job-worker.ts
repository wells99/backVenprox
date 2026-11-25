import { ApplicationError } from './application-error.js';
import { JobLeaseLost, type Job, type JobDependencies, type JobLease, type CatalogExportSource } from './job-ports.js';
import { PersistenceError } from './persistence.js';
export class JobWorker {
  constructor(readonly deps:JobDependencies,readonly source:CatalogExportSource,readonly owner:string,readonly leaseMs=10000){}
  lease(job:Job):JobLease{return {id:job.id,owner:this.owner,token:job.lease_token};}
  claim(){return this.deps.unitOfWork.run((tx)=>tx.jobs.claim(this.owner,this.leaseMs));}
  renew(job:Job){return this.deps.unitOfWork.run((tx)=>tx.jobs.renew(this.lease(job),this.leaseMs));}
  async execute(job:Job,signal:AbortSignal){
    signal.throwIfAborted();
    const lease=this.lease(job),prior=await this.deps.unitOfWork.run((tx)=>tx.jobs.effect(lease));if(prior)return;
    signal.throwIfAborted();
    const payload=JSON.parse(job.payload_json) as {include_costs?:unknown};
    if(job.type!=='catalog.export.v1'||job.payload_version!==1||typeof payload.include_costs!=='boolean')throw new ApplicationError('JOB_PAYLOAD_UNSUPPORTED','Contrato de tarefa inválido.','content');
    const items=await this.source.read(payload.include_costs,signal);signal.throwIfAborted();
    if(items.length>1000||new TextEncoder().encode(JSON.stringify(items)).length>2*1024*1024)throw new ApplicationError('EXPORT_LIMIT_EXCEEDED','Exportação excede 1.000 produtos ou 2 MiB.','content');
    const result={schema_version:1 as const,items,checksum:this.deps.hash(items),created_at:this.deps.clock.now().toISOString()};
    await this.deps.unitOfWork.run((tx)=>tx.jobs.commitEffect(lease,result));
  }
  acknowledge(job:Job){return this.deps.unitOfWork.run((tx)=>tx.jobs.finish(this.lease(job)));}
  async failed(job:Job,error:unknown,random:number){
    if(error instanceof JobLeaseLost)return;
    const transient=error instanceof PersistenceError&&error.retryable||error instanceof ApplicationError&&error.retryable;
    const code=error instanceof ApplicationError?['EXPORT_LIMIT_EXCEEDED','JOB_PAYLOAD_UNSUPPORTED'].includes(error.code)?error.code:'JOB_EXECUTION_FAILED':transient?'JOB_PERSISTENCE_RETRY':'JOB_EXECUTION_FAILED';
    const delay=transient?Math.ceil(Math.min(300000,1000*2**job.attempts)*(0.5+Math.max(0,Math.min(1,random))/2)):null;
    await this.deps.unitOfWork.run((tx)=>tx.jobs.fail(this.lease(job),code,delay));
  }
}
