import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { loadAuthDatabaseOptions } from '../packages/infrastructure/runtime/src/auth-config.js';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';

try {
  const file = process.argv.includes('--local') ? '.env.b04.local' : '.env.b04';
  const content = readFileSync(file,'utf8');
  const token = randomBytes(32).toString('base64url');
  const connection = await createConnection(loadAuthDatabaseOptions(process.env));
  try {
    const [result] = await connection.execute('UPDATE auth_installation SET setup_hash=?,setup_expires=? WHERE store_id=? AND activated_at IS NULL',
      [createHash('sha256').update(token).digest('hex'),new Date(Date.now()+3600000).toISOString(),process.env.STORE_ID!]);
    if (!('affectedRows' in result) || result.affectedRows!==1) throw new Error('SETUP_ALREADY_CLOSED');
    writeFileSync(file,content.replace(/^AUTH_INSTALLATION_TOKEN=.*$/m,`AUTH_INSTALLATION_TOKEN=${token}`),{mode:0o600});
    console.log('Token temporário renovado no arquivo privado. Setup ativado nunca é reaberto.');
  } finally { await connection.end(); }
} catch (error) { reportBootFailure('renew-setup',error); }
