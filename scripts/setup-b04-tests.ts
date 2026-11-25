import { createConnection } from 'mysql2/promise';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';
try {
  if (process.env.MYSQL_HOST !== '127.0.0.1' || process.env.MYSQL_PORT !== '3308') throw new Error('LOCAL_TEST_ONLY');
  const connection = await createConnection({ host: '127.0.0.1', port: 3308, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD! });
  try {
    await connection.query('CREATE DATABASE IF NOT EXISTS venprox_b04_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    await connection.query("GRANT ALL ON venprox_b04_test.* TO 'venprox_migration'@'%'");
    await connection.query('CREATE DATABASE IF NOT EXISTS venprox_b04_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    await connection.query("GRANT ALL ON venprox_b04_restore_test.* TO 'venprox_migration'@'%'");
    console.log('Banco isolado de testes B04 preparado; nenhuma credencial exibida.');
  } finally { await connection.end(); }
} catch (error) { reportBootFailure('setup-b04-tests',error); }
