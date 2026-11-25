import type { JobWorker } from '../../../application/src/job-worker.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import { JobLeaseLost } from '../../../application/src/job-ports.js';
export function jobLoop(worker:JobWorker,options:{mode:'once'|'run';leaseMs:number;timeoutMs:number;pollMs:number;maxJobs:number;onEvent:(value:{event:string;job_id?:string;duration_ms?:number})=>void}){
  let stopping=false,current:AbortController|undefined;
  let wake: (()=>void)|undefined;
  const done=(async()=>{
    let attempted=0;
    while(!stopping&&(options.mode==='run'||attempted<options.maxJobs)){
      let job;
      try{job=await worker.claim();}catch{options.onEvent({event:'job_claim_unavailable'});if(options.mode==='once')break;}
      if(!job){if(options.mode==='once')break;await new Promise<void>((resolve)=>{const timer=setTimeout(resolve,options.pollMs);wake=()=>{clearTimeout(timer);resolve();};});wake=undefined;continue;}
      attempted++;const started=Date.now(),controller=new AbortController();current=controller;let renewing=false;
      if(stopping)controller.abort(new ApplicationError('JOB_SHUTDOWN','Executor encerrando.','unavailable',true));
      const timeout=setTimeout(()=>controller.abort(new ApplicationError('JOB_TIMEOUT','Tempo de execução excedido.','unavailable',true)),options.timeoutMs);
      const heartbeat=setInterval(()=>{if(renewing)return;renewing=true;void worker.renew(job).then((ok)=>{if(!ok)controller.abort(new JobLeaseLost());}).catch(()=>controller.abort(new JobLeaseLost())).finally(()=>{renewing=false;});},Math.floor(options.leaseMs/3));
      try{
        await worker.execute(job,controller.signal);controller.signal.throwIfAborted();await worker.acknowledge(job);options.onEvent({event:'job_succeeded',job_id:job.id,duration_ms:Date.now()-started});
      }catch(error){try{await worker.failed(job,controller.signal.aborted?controller.signal.reason:error,Math.random());}catch{options.onEvent({event:'job_fencing_or_storage_failure',job_id:job.id});}options.onEvent({event:'job_attempt_stopped',job_id:job.id,duration_ms:Date.now()-started});}
      finally{clearInterval(heartbeat);clearTimeout(timeout);current=undefined;}
    }
    return attempted;
  })();
  return {done,stop:async()=>{stopping=true;wake?.();current?.abort(new ApplicationError('JOB_SHUTDOWN','Executor encerrando.','unavailable',true));await done;}};
}
