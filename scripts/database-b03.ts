import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';
import { loadPersistenceConfig } from '../packages/infrastructure/runtime/src/config.js';

try {
  const mode = process.argv[2];
  if (!['init', 'status', 'backup'].includes(mode ?? '')) throw new Error('INVALID_MODE');
  const { path, identity, mysql: options } = loadPersistenceConfig(process.env);
  if (options.host !== '127.0.0.1' || options.port !== 3308 || options.database !== 'venprox_b03') throw new Error('ISOLATED_DEVELOPMENT_ONLY');
  const sqlite = SqliteStore.open(path, identity, mode === 'init' && !existsSync(path), mode === 'init');
  let mysql: MysqlStore | undefined;
  try {
    mysql = await MysqlStore.connect(options, { store_id: identity.store_id });
    if (mode === 'init') {
      await sqlite.migrate();
      if (!sqlite.database.prepare('SELECT store_id FROM instance_identity').get()) await sqlite.provisionIdentity();
      await mysql.migrate();
      const connection = await createConnection(options);
      try {
        const [rows] = await connection.query('SELECT store_id FROM instance_identity');
        if (Array.isArray(rows) && rows.length === 0) await mysql.provisionIdentity();
      } finally { await connection.end(); }
    }
    if (mode === 'backup') {
      await sqlite.backup(join(dirname(path), `backup-${randomUUID()}.db`));
      await mysql.backup(join(dirname(path), `mysql-backup-${randomUUID()}.json`));
      console.log('Backups consistentes criados no diretório privado de dados B03.');
    }
    console.log(JSON.stringify({ sqlite: sqlite.status(), mysql: await mysql.status() }));
  } finally { await sqlite.close(); await mysql?.close(); }
} catch (error) { reportBootFailure('database-b03', error); }
