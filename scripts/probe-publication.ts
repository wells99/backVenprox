import { performance } from 'node:perf_hooks';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { mysqlSyncUnitOfWork } from '../packages/infrastructure/mysql/src/sync.js';
import { loadAuthDatabaseOptions } from '../packages/infrastructure/runtime/src/auth-config.js';
import { loadPersistenceConfig } from '../packages/infrastructure/runtime/src/config.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';
import { syncHashValue } from '../packages/infrastructure/security/src/sync-validation.js';
// Read consistent state through the real B11 barrier and ALWAYS roll back.
// No device enrollment, business fixtures or snapshots are committed in the store.
try{
  const remote=process.argv.includes('--remote'),local=remote?undefined:loadPersistenceConfig(process.env);
  const options=remote?loadAuthDatabaseOptions(process.env):local!.mysql,storeId=remote?process.env.STORE_ID!:local!.identity.store_id;
  const store=await MysqlStore.connect(options,{store_id:storeId});
  try{
    const status=await store.status(),uow=mysqlSyncUnitOfWork(store);
    for(const kind of ['initial','operational'] as const){
      const started=performance.now();let evidence:object|undefined;
      try{await uow.run(async(tx)=>{
        await tx.publication.lock();const cut=await tx.publication.state(),capture=await tx.publication.capture(kind);
        syncHashValue(capture.records);
        evidence={target:remote?'external':'local_mysql',engine:status.engine,schema_version:status.schema_version,kind,records:capture.records.length,bytes:Buffer.byteLength(JSON.stringify(capture.records)),capture_ms:capture.capture_ms,total_ms:Math.ceil(performance.now()-started),cursor:cut.cursor};
        throw new ApplicationError('PROBE_ROLLBACK','Prova sem commit.','unavailable');
      });}catch(error){if(!(error instanceof ApplicationError&&error.code==='PROBE_ROLLBACK'))throw error;}
      console.log(JSON.stringify({...evidence,rolled_back:true}));
    }
  }finally{await store.close();}
}catch(error){reportBootFailure('probe-publication',error);}
