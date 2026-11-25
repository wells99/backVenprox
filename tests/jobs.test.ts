import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConnection } from 'mysql2/promise';
import { Value } from 'typebox/value';
import { syncFixture } from './sync-fixture.js';
import { fails } from './financial-fixture.js';
import { JobService } from '../packages/application/src/job-service.js';
import { JobWorker } from '../packages/application/src/job-worker.js';
import { mysqlJobUnitOfWork } from '../packages/infrastructure/mysql/src/jobs.js';
import { mysqlCatalogExport } from '../packages/infrastructure/mysql/src/catalog-export.js';
import { JobLeaseLost, type JobDependencies } from '../packages/application/src/job-ports.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { PersistenceError } from '../packages/application/src/persistence.js';
import { jobLoop } from '../packages/infrastructure/runtime/src/job-loop.js';
import { JobResponse,JobExportResponse } from '../packages/contracts/src/jobs.js';
import { buildApi } from '../apps/api/src/app.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';

test('B13 MySQL real: fila, leases, fencing, efeitos, workers e HTTP',{skip:!process.env.MYSQL_PASSWORD,timeout:180000},async(t)=>{
  const f=await syncFixture('b13'),uow=mysqlJobUnitOfWork(f.store),deps:JobDependencies={unitOfWork:uow,storeId:f.identity.store_id,clock:f.businessDeps.clock,ids:f.deps.ids,hash:f.businessDeps.hash},service=new JobService(deps),source=mysqlCatalogExport(f.store);
  const worker=(owner=randomUUID())=>new JobWorker(deps,source,owner),a=worker(),b=worker(),c=worker();
  const contexts=[f.context,{...f.context,user_id:randomUUID()},{...f.context,user_id:randomUUID()}];
  const sql=async(query:string,values:unknown[]=[])=>{const connection=await createConnection(f.options);try{await connection.query(query,values);}finally{await connection.end();}};
  const expire=async(id:string)=>{await sql('UPDATE jobs SET lease_until=0 WHERE id=?',[id]);await sql('UPDATE job_partitions SET lease_until=0 WHERE job_id=?',[id]);};
  const drain=async()=>{for(let i=0;i<30;i++){const job=await a.claim();if(!job)return;await a.execute(job,new AbortController().signal);await a.acknowledge(job);}};
  try{
    await t.test('intenção/auditoria atômicas, dedup estável, conteúdo e solicitante protegidos',async()=>{
      const bad=new JobService({...deps,unitOfWork:{run:(work)=>uow.run((tx)=>work({...tx,audit:{append:async()=>{throw new ApplicationError('INJECTED_FAILURE','Falha.','unavailable');}}}))}});
      await assert.rejects(bad.requestCatalogExport(f.context,randomUUID()),fails('INJECTED_FAILURE'));assert.equal(await f.count('jobs'),0);assert.equal(await f.count('job_policies'),0);
      const key=randomUUID(),job=await service.requestCatalogExport(f.context,key);assert.deepEqual(await service.requestCatalogExport(f.context,key),job);
      await assert.rejects(service.requestCatalogExport(contexts[1]!,key),fails('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(service.get(contexts[1]!,job.id),fails('JOB_NOT_FOUND'));assert.ok(Value.Check(JobResponse,{data:job,meta:{request_id:'test'}}));
    });
    await t.test('reserva concorrente é exclusiva; limite de duas tarefas e uma ativa por partição',async()=>{
      await service.requestCatalogExport(f.context,randomUUID());await service.requestCatalogExport(contexts[1]!,randomUUID());await service.requestCatalogExport(contexts[2]!,randomUUID());
      let [one,two]=await Promise.all([a.claim(),b.claim()]);if(!one)one=await a.claim();if(!two)two=await b.claim();assert.ok(one&&two);assert.notEqual(one.id,two.id);assert.notEqual(one.partition_key,two.partition_key);assert.equal(await c.claim(),undefined);
      await expire(one.id);const renewed=await c.claim();assert.ok(renewed);assert.equal(renewed.id,one.id);assert.notEqual(renewed.lease_token,one.lease_token);
      assert.equal(await a.renew(one),false);await assert.rejects(a.execute(one,new AbortController().signal),JobLeaseLost);await assert.rejects(a.acknowledge(one),JobLeaseLost);
      await c.execute(renewed,new AbortController().signal);await c.acknowledge(renewed);await b.execute(two,new AbortController().signal);await b.acknowledge(two);await drain();
      assert.equal(await f.count('job_effects'),4);assert.equal((await uow.run((tx)=>tx.jobs.metrics())).succeeded,4);
      await service.requestCatalogExport(f.context,randomUUID());let entered!:()=>void,release!:()=>void;
      const ready=new Promise<void>((resolve)=>{entered=resolve;}),pause=new Promise<void>((resolve)=>{release=resolve;});
      const old=new JobWorker(deps,{read:async(cost,signal)=>{const rows=await source.read(cost,signal);entered();await pause;return rows;}},a.owner);
      const stale=await old.claim();assert.ok(stale);const lateWrite=assert.rejects(old.execute(stale,new AbortController().signal),JobLeaseLost);
      await ready;await expire(stale.id);const replacement=await b.claim();assert.ok(replacement);await b.execute(replacement,new AbortController().signal);await b.acknowledge(replacement);release();await lateWrite;assert.equal(await f.count('job_effects'),5);
    });
    await t.test('queda real após efeito confirmado e antes do ACK retoma sem duplicar resultado',async()=>{
      const requested=await service.requestCatalogExport(f.context,randomUUID());
      const child=fork(resolve('scripts/jobs-crash-probe.ts'),[],{execArgv:['--import','tsx'],env:{...process.env,MYSQL_DATABASE:'venprox_b13_test',STORE_ID:f.identity.store_id},stdio:['ignore','ignore','ignore','ipc']});
      let lease:{id:string;token:string;owner:string};
      try{assert.equal((await once(child,'message',{signal:AbortSignal.timeout(15000)}))[0].type,'ready');const effect=once(child,'message',{signal:AbortSignal.timeout(15000)});child.send({run:true});const message=(await effect)[0];assert.equal(message.type,'effect_committed');assert.equal(message.id,requested.id);lease=message;const exited=once(child,'exit');child.kill();await exited;}finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
      const before=await f.count('job_effects');await expire(requested.id);const next=await b.claim();assert.ok(next);assert.equal(next.id,requested.id);assert.notEqual(next.lease_token,lease!.token);
      await assert.rejects(uow.run((tx)=>tx.jobs.finish(lease!)),JobLeaseLost);
      const replay=new JobWorker(deps,{read:async()=>{throw new Error('MUST_REUSE_COMMITTED_EFFECT');}},b.owner);await replay.execute(next,new AbortController().signal);await replay.acknowledge(next);
      assert.equal(await f.count('job_effects'),before);const result=await service.result(f.context,requested.id);assert.ok(Value.Check(JobExportResponse,{data:result,meta:{request_id:'test'}}));assert.equal(result.items.length,1);assert.equal(result.items[0]!.id,f.product.id);
      await assert.rejects(service.result({...f.context,permissions:['catalog.read']},requested.id),fails('PERMISSION_DENIED'));assert.doesNotMatch(JSON.stringify(result),/password_hash|credential_hash|authorization_context/);
    });
    await t.test('transitório tem backoff/teto de tentativas; permanente exige retry auditado com versão',async()=>{
      const requested=await service.requestCatalogExport(f.context,randomUUID());let job=await a.claim();assert.ok(job);assert.equal(job.id,requested.id);
      await a.failed(job,new ApplicationError('EXPORT_LIMIT_EXCEEDED','Limite.','content'),1);const failed=await service.get(f.context,requested.id);assert.equal(failed.status,'failed_review');
      await assert.rejects(service.retry(f.context,failed.id,randomUUID(),failed.version-1,'Infraestrutura corrigida'),fails('JOB_VERSION_OR_STATE_CONFLICT'));
      const key=randomUUID(),retry=await service.retry(f.context,failed.id,key,failed.version,'Infraestrutura corrigida');assert.deepEqual(await service.retry(f.context,failed.id,key,failed.version,'Infraestrutura corrigida'),retry);assert.equal(await f.count('job_retries'),1);
      for(let attempt=1;attempt<=5;attempt++){job=await a.claim();assert.ok(job);await a.failed(job,new PersistenceError('DATABASE_UNAVAILABLE',true),1);const row=await uow.run((tx)=>tx.jobs.get(job!.id));assert.ok(row);assert.equal(row.attempts,attempt);assert.equal(row.status,attempt===5?'failed_review':'retry_wait');if(attempt<5){assert.ok(row.available_at>0);await sql('UPDATE jobs SET available_at=0 WHERE id=?',[job.id]);}}
      assert.equal((await service.get(f.context,requested.id)).status,'failed_review');await assert.rejects(service.retry({...f.context,permissions:['catalog.read']},requested.id,randomUUID(),7,'Motivo'),fails('PERMISSION_DENIED'));
    });
    await t.test('heartbeat renova durante execução; timeout conserva tentativa para retry',async()=>{
      const job=await service.requestCatalogExport(contexts[1]!,randomUUID());
      const delayed=new JobWorker(deps,{read:async(cost,signal)=>{await new Promise((done)=>setTimeout(done,1800));return source.read(cost,signal);}},randomUUID(),1200);
      await jobLoop(delayed,{mode:'once',leaseMs:1200,timeoutMs:4000,pollMs:100,maxJobs:1,onEvent:()=>{}}).done;assert.equal((await service.get(contexts[1]!,job.id)).status,'succeeded');
      const timed=await service.requestCatalogExport(contexts[2]!,randomUUID()),slow=new JobWorker(deps,{read:async(_cost,signal)=>{await new Promise<void>((_done,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return [];}},randomUUID());
      await jobLoop(slow,{mode:'once',leaseMs:10000,timeoutMs:300,pollMs:100,maxJobs:1,onEvent:()=>{}}).done;assert.equal((await service.get(contexts[2]!,timed.id)).status,'retry_wait');
      await sql('UPDATE jobs SET available_at=0 WHERE id=?',[timed.id]);await drain();
    });
    await t.test('dois processos workers reais drenam tarefas sem API iniciar loop',async()=>{
      for(let i=0;i<6;i++)await service.requestCatalogExport(contexts[i%3]!,randomUUID());
      const run=async()=>{const child=fork(resolve('apps/worker/src/main.ts'),[],{execArgv:['--import','tsx'],env:{...process.env,WORKER_MODE:'once',WORKER_MAX_JOBS:'20',WORKER_LEASE_MS:'3000',LOG_LEVEL:'silent',MYSQL_DATABASE:'venprox_b13_test',STORE_ID:f.identity.store_id},stdio:['ignore','ignore','ignore','ipc']});const exited=once(child,'exit');try{assert.equal((await once(child,'message',{signal:AbortSignal.timeout(15000)}))[0].jobs_enabled,true);assert.equal((await exited)[0],0);}finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}}};
      const singleStart=performance.now();await run();const singleMs=Math.ceil(performance.now()-singleStart);assert.equal((await uow.run((tx)=>tx.jobs.metrics())).queued,0);
      for(let i=0;i<6;i++)await service.requestCatalogExport(contexts[i%3]!,randomUUID());
      const dualStart=performance.now();await Promise.all([run(),run()]);const dualMs=Math.ceil(performance.now()-dualStart);const metrics=await uow.run((tx)=>tx.jobs.metrics());assert.equal(metrics.queued,0);assert.equal(metrics.running,0);assert.equal(await f.count('job_effects'),metrics.succeeded);
      console.log(JSON.stringify({evidence:'B13_worker_processes',jobs_per_sample:6,one_worker_ms:singleMs,two_workers_ms:dualMs,api_pool_limit:4,per_worker_pool_limit:2}));
    });
    await t.test('HTTP/OpenAPI autentica, limita solicitante, CSRF/versão e não aceita código livre',async()=>{
      const app=buildApi({environment:'development',logger:createLogger('jobs-test','silent'),ids:f.deps.ids,getCompatibility:createGetCompatibility(createCompatibilityPolicy('0.1.0',[1]),'0.1.0'),auth:{service:f.auth,origin:'http://jobs.test',secureCookies:false,jobs:service}});
      const headers={origin:'http://jobs.test',cookie:`venprox_access=${f.login.access}`,'x-csrf-token':f.login.csrf,'idempotency-key':randomUUID()};
      try{await app.ready();const spec=app.swagger();assert.ok('openapi'in spec);assert.ok(spec.paths!['/api/v1/jobs/{id}']);assert.ok(spec.paths!['/api/v1/admin/jobs/{id}/retry']);
        const created=await app.inject({method:'POST',url:'/api/v1/exports/catalog',headers,payload:{}});assert.equal(created.statusCode,202,created.body);const id=created.json().data.id;
        assert.equal((await app.inject({url:`/api/v1/jobs/${id}`})).statusCode,401);assert.equal((await app.inject({url:`/api/v1/jobs/${id}`,headers})).statusCode,200);assert.equal((await app.inject({url:`/api/v1/jobs/${id}/result`,headers})).statusCode,409);
        assert.equal((await app.inject({method:'POST',url:'/api/v1/exports/catalog',headers,payload:{function:'eval'}})).statusCode,422);assert.equal((await app.inject({method:'POST',url:'/api/v1/exports/catalog',headers:{...headers,'x-csrf-token':'wrong'},payload:{}})).statusCode,403);
        await drain();const result=await app.inject({url:`/api/v1/jobs/${id}/result`,headers});assert.equal(result.statusCode,200,result.body);assert.ok(Value.Check(JobExportResponse,result.json()));
      }finally{await app.close();}
    });
  }finally{await f.close();}
});
