import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { loadAuthConfig } from '../packages/infrastructure/runtime/src/auth-config.js';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';
try {
  const config=loadAuthConfig(process.env);
  const store=await MysqlStore.connect(config.mysql,{store_id:config.storeId});
  try {
    await store.backup(join(dirname(process.env.AUTH_SIGNING_KEY_FILE!),`remote-b04-backup-${randomUUID()}.json`));
    console.log('Backup consistente da identidade remota criado no diretório privado; segredos não exibidos.');
  } finally { await store.close(); }
} catch(error) {reportBootFailure('backup-auth',error);}
