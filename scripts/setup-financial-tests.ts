import { createConnection } from 'mysql2/promise';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';
try{
  if(process.env.MYSQL_HOST!=='127.0.0.1'||process.env.MYSQL_PORT!=='3308')throw new Error('LOCAL_TEST_ONLY');
  const connection=await createConnection({host:'127.0.0.1',port:3308,user:'root',password:process.env.MYSQL_ROOT_PASSWORD!});
  try{for(const database of ['venprox_b07_test','venprox_b08_test','venprox_b08_ipc_test','venprox_b08_restore_test','venprox_b09_test','venprox_b10_test']){await connection.query(`CREATE DATABASE IF NOT EXISTS ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);await connection.query(`GRANT ALL ON ${database}.* TO 'venprox_migration'@'%'`);}console.log('Bancos descartáveis financeiros preparados.');}finally{await connection.end();}
}catch(error){reportBootFailure('financial-tests',error);}
