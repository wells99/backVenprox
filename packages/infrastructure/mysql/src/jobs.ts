import type { RowDataPacket } from 'mysql2/promise';
import type { MysqlStore } from './store.js';
import type { CatalogExport, Job, JobDependencies, JobLease, JobRepository, JobRetry } from '../../../application/src/job-ports.js';
import { JobLeaseLost } from '../../../application/src/job-ports.js';
import { ApplicationError } from '../../../application/src/application-error.js';
export function mysqlJobUnitOfWork(store:MysqlStore):JobDependencies['unitOfWork']{
  return store.unitOfWork((connection,core,active)=>{
    const storeId=store.identity.store_id,type='catalog.export.v1';
    const all=async<T>(query:string,values:unknown[]=[]):Promise<T[]>=>{active();const [rows]=await connection.query<RowDataPacket[]>(query,values);return rows as T[];};
    const run=async(query:string,values:unknown[]=[])=>{active();await connection.query(query,values);};
    const now=async()=>Number((await all<{at:string}>('SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS at'))[0]!.at);
    const decode=(row:Job)=>({...row,available_at:Number(row.available_at),lease_until:Number(row.lease_until),lease_token:String(row.lease_token)});
    const get=async(id:string,lock=false)=>{const row=(await all<Job>(`SELECT * FROM jobs WHERE store_id=? AND id=?${lock?' FOR UPDATE':''}`,[storeId,id]))[0];return row?decode(row):undefined;};
    const gate=async(skip=false)=>{const rows=await all<{max_active:number}>(`SELECT max_active FROM job_policies WHERE store_id=? AND type=? FOR UPDATE${skip?' SKIP LOCKED':''}`,[storeId,type]);return rows[0]?.max_active;};
    async function owned(lease:JobLease){
      await gate();const job=await get(lease.id,true),at=await now();
      if(!job||job.status!=='running'||job.lease_owner!==lease.owner||job.lease_token!==lease.token||job.lease_until<=at)throw new JobLeaseLost();
      const p=(await all<{job_id:string;lease_token:string}>('SELECT job_id,lease_token FROM job_partitions WHERE store_id=? AND partition_key=? FOR UPDATE',[storeId,job.partition_key]))[0];
      if(p?.job_id!==job.id||String(p.lease_token)!==lease.token)throw new JobLeaseLost();return {job,at};
    }
    async function release(job:Job,at:number,status:Job['status'],code:string,available:number){
      await run('UPDATE jobs SET status=?,last_code=?,available_at=?,lease_owner=NULL,lease_until=0,version=version+1 WHERE store_id=? AND id=?',[status,code,available,storeId,job.id]);
      await run('UPDATE job_partitions SET job_id=NULL,lease_until=0 WHERE store_id=? AND partition_key=? AND job_id=? AND lease_token=?',[storeId,job.partition_key,job.id,job.lease_token]);
      await run('UPDATE job_attempts SET finished_at=?,code=? WHERE store_id=? AND job_id=? AND lease_token=?',[at,code,storeId,job.id,job.lease_token]);
    }
    const jobs:JobRepository={
      get,
      enqueue:async(value)=>{
        if(value.store_id!==storeId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');
        await all('SELECT store_id FROM instance_identity WHERE store_id=? FOR UPDATE',[storeId]);
        await run('INSERT INTO job_policies VALUES(?,?,2) ON DUPLICATE KEY UPDATE type=type',[storeId,type]);
        await gate();
        const existing=(await all<Job>('SELECT * FROM jobs WHERE store_id=? AND deduplication_key=? FOR UPDATE',[storeId,value.deduplication_key]))[0];if(existing)return decode(existing);
        await run('INSERT INTO job_partitions(store_id,partition_key) VALUES(?,?) ON DUPLICATE KEY UPDATE partition_key=partition_key',[storeId,value.partition_key]);
        const fields=Object.keys(value);await run(`INSERT INTO jobs(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,Object.values(value));return value;
      },
      claim:async(owner,leaseMs)=>{
        const max=await gate(true);if(!max)return undefined;const at=await now();
        const running=await all('SELECT id FROM jobs WHERE store_id=? AND type=? AND status=\'running\' AND lease_until>? FOR UPDATE',[storeId,type,at]);if(running.length>=max)return undefined;
        const rows=await all<Job>(`SELECT j.* FROM jobs j JOIN job_partitions p ON p.store_id=j.store_id AND p.partition_key=j.partition_key WHERE j.store_id=? AND j.type=? AND ((j.status IN('queued','retry_wait') AND j.available_at<=?) OR(j.status='running' AND j.lease_until<=?)) AND p.lease_until<=? ORDER BY j.available_at,j.created_at,j.id LIMIT 1 FOR UPDATE SKIP LOCKED`,[storeId,type,at,at,at]);
        if(!rows[0])return undefined;const job=decode(rows[0]);
        if(job.attempts>=5){await release(job,at,'failed_review','LEASE_ATTEMPTS_EXHAUSTED',at);return undefined;}
        if(BigInt(job.lease_token)>=9223372036854775807n)throw new ApplicationError('JOB_TOKEN_EXHAUSTED','Geração esgotada.','unavailable');
        if(job.status==='running')await run('UPDATE job_attempts SET finished_at=?,code=\'LEASE_EXPIRED\' WHERE store_id=? AND job_id=? AND lease_token=? AND finished_at IS NULL',[at,storeId,job.id,job.lease_token]);
        const token=String(BigInt(job.lease_token)+1n),until=at+leaseMs;
        await run("UPDATE jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_until=?,lease_token=?,version=version+1,last_code=NULL WHERE store_id=? AND id=?",[owner,until,token,storeId,job.id]);
        await run('UPDATE job_partitions SET job_id=?,lease_token=?,lease_until=? WHERE store_id=? AND partition_key=?',[job.id,token,until,storeId,job.partition_key]);
        await run('INSERT INTO job_attempts VALUES(?,?,?,?,?,NULL,NULL)',[storeId,job.id,token,owner,at]);
        return {...job,status:'running',attempts:job.attempts+1,lease_owner:owner,lease_until:until,lease_token:token,version:job.version+1,last_code:null};
      },
      renew:async(lease,ms)=>{try{const {job,at}=await owned(lease);await run('UPDATE jobs SET lease_until=? WHERE store_id=? AND id=?',[at+ms,storeId,job.id]);await run('UPDATE job_partitions SET lease_until=? WHERE store_id=? AND partition_key=?',[at+ms,storeId,job.partition_key]);return true;}catch(error){if(error instanceof JobLeaseLost)return false;throw error;}},
      effect:async(lease)=>{
        await gate();
        const job=await get(lease.id,true);if(!job)throw new JobLeaseLost();
        if(job.status!=='succeeded'||lease.owner!==''||lease.token!=='')await owned(lease);
        const row=(await all<{result_json:string}>('SELECT result_json FROM job_effects WHERE store_id=? AND job_id=?',[storeId,lease.id]))[0];return row?JSON.parse(row.result_json) as CatalogExport:undefined;
      },
      commitEffect:async(lease,result)=>{await owned(lease);await run('INSERT INTO job_effects VALUES(?,?,?) ON DUPLICATE KEY UPDATE job_id=job_id',[storeId,lease.id,JSON.stringify(result)]);await owned(lease);},
      finish:async(lease)=>{const {job,at}=await owned(lease);const effect=await all('SELECT job_id FROM job_effects WHERE store_id=? AND job_id=? FOR UPDATE',[storeId,job.id]);if(!effect.length)throw new ApplicationError('JOB_EFFECT_MISSING','Resultado ainda não confirmado.','conflict');await release(job,at,'succeeded','COMPLETED',at);},
      fail:async(lease,code,delay)=>{const {job,at}=await owned(lease),retry=delay!==null&&job.attempts<5;await release(job,at,retry?'retry_wait':'failed_review',code,retry?at+delay!:at);},
      retryRecord:async(id)=>(await all<JobRetry>('SELECT * FROM job_retries WHERE store_id=? AND operation_id=? FOR UPDATE',[storeId,id]))[0],
      retry:async(value,version)=>{
        await gate();const job=await get(value.job_id,true);
        if(!job)throw new ApplicationError('JOB_NOT_FOUND','Tarefa não encontrada.','not_found');
        if(job.status!=='failed_review'||job.version!==version)throw new ApplicationError('JOB_VERSION_OR_STATE_CONFLICT','Confira a versão e o estado da tarefa.','conflict');
        await run("UPDATE jobs SET status='queued',attempts=0,available_at=0,last_code=NULL,version=version+1 WHERE store_id=? AND id=?",[storeId,job.id]);
        const result={...job,status:'queued' as const,attempts:0,available_at:0,last_code:null,version:job.version+1};
        await run('INSERT INTO job_retries VALUES(?,?,?,?,?,?,?)',[value.operation_id,storeId,job.id,value.actor_id,value.command_hash,JSON.stringify(result),value.reason]);return result;
      },
      metrics:async()=>{const at=await now();const [row]=await all<Record<string,string>>(`SELECT COALESCE(SUM(status IN('queued','retry_wait')),0) AS queued,COALESCE(SUM(status='running'),0) AS running,COALESCE(SUM(status='failed_review'),0) AS failed_review,COALESCE(SUM(status='succeeded'),0) AS succeeded,COALESCE(SUM(status='running' AND lease_until<=?),0) AS expired_leases,COALESCE(MAX(CASE WHEN status IN('queued','retry_wait') THEN GREATEST(0,TIMESTAMPDIFF(MICROSECOND,STR_TO_DATE(created_at,'%Y-%m-%dT%H:%i:%s.%fZ'),UTC_TIMESTAMP(3)) DIV 1000) ELSE NULL END),0) AS oldest_wait_ms FROM jobs WHERE store_id=?`,[at,storeId]);return Object.fromEntries(Object.entries(row!).map(([k,v])=>[k,Number(v)])) as Awaited<ReturnType<JobRepository['metrics']>>;},
    };return {jobs,audit:core.audit};
  });
}
