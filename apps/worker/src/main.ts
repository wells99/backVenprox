import { loadWorkerConfig } from '../../../packages/infrastructure/runtime/src/config.js';
import { createLogger, reportBootFailure } from '../../../packages/infrastructure/runtime/src/logger.js';
import { assertSupportedRuntime } from '../../../packages/infrastructure/runtime/src/system.js';
import { installShutdown } from '../../../packages/infrastructure/runtime/src/shutdown.js';
import { MysqlStore } from '../../../packages/infrastructure/mysql/src/store.js';
import { loadAuthDatabaseOptions } from '../../../packages/infrastructure/runtime/src/auth-config.js';
import { mysqlJobUnitOfWork } from '../../../packages/infrastructure/mysql/src/jobs.js';
import { mysqlCatalogExport } from '../../../packages/infrastructure/mysql/src/catalog-export.js';
import { JobWorker } from '../../../packages/application/src/job-worker.js';
import { systemClock, uuidGenerator } from '../../../packages/infrastructure/runtime/src/system.js';
import { businessHash } from '../../../packages/infrastructure/persistence/src/business-repository.js';
import { jobLoop } from '../../../packages/infrastructure/runtime/src/job-loop.js';

let store:MysqlStore|undefined;
try {
  assertSupportedRuntime();
  const config = loadWorkerConfig(process.env);
  const logger = createLogger('worker', config.logLevel);
  let loop:ReturnType<typeof jobLoop>|undefined;
  if(config.mode!=='standby'){
    store=await MysqlStore.connect(loadAuthDatabaseOptions(process.env),{store_id:process.env.STORE_ID!},2);
    try{await store.assertReady();}catch(error){await store.close();store=undefined;throw error;}
  }
  const keepAlive = config.mode==='standby'?setInterval(() => {}, 60_000):undefined;
  const shutdown=installShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    close: async() => {
      if(keepAlive)clearInterval(keepAlive);
      await loop?.stop();await store?.close();store=undefined;
      if (process.connected) process.disconnect();
    },
  });
  logger.info({ event: 'ready', mode: config.mode, jobs_enabled:config.mode!=='standby',pool_limit:config.mode==='standby'?0:2 }, 'Executor iniciado.');
  if (process.connected) process.send?.({ type: 'ready', service: 'worker', jobs_enabled:config.mode!=='standby' });
  if(store){
    const worker=new JobWorker({unitOfWork:mysqlJobUnitOfWork(store),storeId:store.identity.store_id,clock:systemClock,ids:uuidGenerator,hash:businessHash},mysqlCatalogExport(store),uuidGenerator.generate(),config.leaseMs);
    loop=jobLoop(worker,{...config,mode:config.mode as 'once'|'run',onEvent:(event)=>logger.info(event,'Estado da tarefa.')});
    if(config.mode==='once'){await loop.done;await shutdown('bounded_completion');}
  }
} catch (error) {
  await store?.close();
  reportBootFailure('worker', error);
  if (process.connected) process.disconnect();
}
