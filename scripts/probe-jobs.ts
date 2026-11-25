import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { loadAuthDatabaseOptions } from '../packages/infrastructure/runtime/src/auth-config.js';
import { mysqlJobUnitOfWork } from '../packages/infrastructure/mysql/src/jobs.js';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';
try{
  const store=await MysqlStore.connect(loadAuthDatabaseOptions(process.env),{store_id:process.env.STORE_ID!},2);
  try{
    const result=await store.unitOfWork((connection)=>({query:async()=>{
      await connection.query('SELECT max_active FROM job_policies WHERE store_id=? FOR UPDATE SKIP LOCKED',[store.identity.store_id]);
      await connection.query('SELECT j.id FROM jobs j JOIN job_partitions p ON p.store_id=j.store_id AND p.partition_key=j.partition_key WHERE j.store_id=? AND p.lease_until=0 ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE SKIP LOCKED',[store.identity.store_id]);
      return {transactional_skip_locked:true};
    }})).run((tx)=>tx.query());
    const status=await store.status(),metrics=await mysqlJobUnitOfWork(store).run((tx)=>tx.jobs.metrics());
    console.log(JSON.stringify({engine:status.engine,engine_version:status.engine_version,schema_version:status.schema_version,...result,metrics,business_data_written:false}));
  }finally{await store.close();}
}catch(error){reportBootFailure('probe-jobs',error);}
