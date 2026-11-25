import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { provisionAuth } from '../packages/infrastructure/mysql/src/auth-provision.js';
import { loadAuthDatabaseOptions } from '../packages/infrastructure/runtime/src/auth-config.js';
import { generateAuthKeys, createAuthCrypto, measurePasswordHash } from '../packages/infrastructure/security/src/crypto.js';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';

try {
  const options = loadAuthDatabaseOptions(process.env);
  const storeId = process.env.STORE_ID!;
  const localPath = process.env.LOCAL_DATABASE_PATH!;
  const local = process.argv.includes('--local');
  const profile = local ? 'b04-local' : 'b04';
  const envFile = local ? '.env.b04.local' : '.env.b04';
  const marker = join(dirname(localPath), `${profile}-installation.json`);
  const prior = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) as { store_id: string; database_key: string } : undefined;
  const databaseKey = createHash('sha256').update(`${options.host}:${options.port}:${options.database}`).digest('hex');
  if (prior && (prior.store_id !== storeId || prior.database_key !== databaseKey)) throw new Error('INSTALLATION_SCOPE_MISMATCH');
  const connection = await createConnection(options);
  let installationExists = false;
  try {
    const [tables] = await connection.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    if (prior && !tables.some((table) => table.TABLE_NAME === 'auth_installation')) throw new Error('RESTORE_REQUIRED');
    if (!prior && tables.length && !tables.some((table) => table.TABLE_NAME === 'instance_identity')) throw new Error('UNRECOGNIZED_DATABASE');
    if(tables.some((table)=>table.TABLE_NAME==='instance_identity')) {
      const [identity]=await connection.query<RowDataPacket[]>('SELECT store_id FROM instance_identity');
      if(identity.length && identity[0]!.store_id!==storeId)throw new Error('IDENTITY_MISMATCH');
    }
    if (tables.some((table) => table.TABLE_NAME === 'auth_installation')) {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT store_id FROM auth_installation');
      installationExists = rows.some((row) => row.store_id === storeId);
      if (prior && !installationExists) throw new Error('RESTORE_REQUIRED');
    }
  } finally { await connection.end(); }
  if (installationExists) {
    const mysql=await MysqlStore.connect(options,{store_id:storeId});
    try { await mysql.migrate(); await mysql.assertReady(); } finally { await mysql.close(); }
    console.log('Instalação já provisionada; token/administrador não foram recriados.');
  } else {
    if (existsSync(envFile)) throw new Error('EXISTING_PRIVATE_CONFIGURATION');
    const keys = generateAuthKeys();
    const setupToken = randomBytes(32).toString('base64url');
    const keyPath = join(dirname(localPath), `${profile}-signing-key.pem`);
    writeFileSync(keyPath, keys.privateKey, { flag: 'wx', mode: 0o600 });
    writeFileSync(envFile, ['AUTH_ENABLED=true','NODE_ENV=development','AUTH_ORIGIN=http://127.0.0.1:3333','AUTH_API_ORIGIN=http://127.0.0.1:3333',
      `STORE_ID=${storeId}`,`AUTH_SIGNING_KEY_FILE=${keyPath.replaceAll('\\','/')}`,`AUTH_FINGERPRINT_KEY=${keys.fingerprintKey}`,
      `AUTH_INSTALLATION_TOKEN=${setupToken}`,'AUTH_OFFLINE_TTL_SECONDS=0',`LOCAL_DATABASE_PATH=${localPath.replaceAll('\\','/')}`,`DEVICE_ID=${process.env.DEVICE_ID}`,''
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    // Marcador fora do banco impede reabrir setup automaticamente após perda da base.
    writeFileSync(marker, JSON.stringify({ store_id: storeId, database_key: databaseKey, status: 'provisioning' }), { flag: 'wx', mode: 0o600 });
    const mysql = await MysqlStore.connect(options, { store_id: storeId });
    try {
      await mysql.migrate();
      const check = await createConnection(options);
      try {
        const [identity] = await check.query<RowDataPacket[]>('SELECT store_id FROM instance_identity');
        if (!identity.length) await mysql.provisionIdentity(); else if (identity[0]!.store_id !== storeId) throw new Error('IDENTITY_MISMATCH');
      } finally { await check.end(); }
      await provisionAuth(options, storeId, createHash('sha256').update(setupToken).digest('hex'), new Date(Date.now() + 3600_000).toISOString(), 0);
      console.log(JSON.stringify({ remote: await mysql.status(), setup: 'pending_owner_activation', offline_enabled: false, credentials_redacted: true }));
    } finally { await mysql.close(); }
    writeFileSync(marker, JSON.stringify({ store_id: storeId, database_key: databaseKey, status: 'provisioned' }), { mode: 0o600 });
    const sqlite = SqliteStore.open(localPath, { store_id: storeId, device_id: process.env.DEVICE_ID! }, false, true);
    try { await sqlite.migrate(); console.log(JSON.stringify({ local: sqlite.status() })); } finally { await sqlite.close(); }
    console.log(JSON.stringify({ password_hash_proof: await measurePasswordHash(createAuthCrypto(keys.privateKey, keys.fingerprintKey)) }));
    console.log(`Token de instalação temporário em ${envFile} privado. Nenhum administrador/senha foi criado automaticamente.`);
  }
  if (!existsSync('.env.local.b04')) writeFileSync('.env.local.b04',[
    'NODE_ENV=development','LOG_LEVEL=info','AUTH_API_ORIGIN=http://127.0.0.1:3333',`STORE_ID=${storeId}`,`DEVICE_ID=${process.env.DEVICE_ID}`,
    `LOCAL_DATABASE_PATH=${localPath.replaceAll('\\','/')}`,'',
  ].join('\n'),{flag:'wx',mode:0o600});
  const currentLocal=SqliteStore.open(localPath,{store_id:storeId,device_id:process.env.DEVICE_ID!},false,true);
  try { await currentLocal.migrate(); } finally { await currentLocal.close(); }
} catch (error) { reportBootFailure('init-auth', error); }
