import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { provisionAuth } from '../packages/infrastructure/mysql/src/auth-provision.js';
import { authUnitOfWork } from '../packages/infrastructure/mysql/src/auth-repository.js';
import { sqliteAuthCache } from '../packages/infrastructure/sqlite/src/auth-cache.js';
import { windowsSecretProtector } from '../packages/infrastructure/native/src/dpapi.js';
import { createAuthCrypto, generateAuthKeys } from '../packages/infrastructure/security/src/crypto.js';
import { AuthService } from '../packages/application/src/auth-service.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { systemClock, uuidGenerator } from '../packages/infrastructure/runtime/src/system.js';

export const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const database = 'venprox_simulation';
const origin = 'http://127.0.0.1:3334';
type Profile = { store_id: string; device_id: string; login: string; password: string;
  fingerprint_key: string; setup_token: string; ready: boolean };
const privateWrite = (file: string, content: string) => writeFileSync(file, content, { mode: 0o600 });
const envText = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';

// This profile never loads .env.remote/.env.b04 or reuses the store's terminal/profile.
export async function prepareSimulation() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('WINDOWS_REQUIRED');
  const dockerEnv = parseEnv(readFileSync(join(backend, '.env.b03'), 'utf8'));
  if (dockerEnv.MYSQL_HOST !== '127.0.0.1' || dockerEnv.MYSQL_PORT !== '3308' ||
      dockerEnv.MYSQL_DATABASE !== 'venprox_b03' || !dockerEnv.MYSQL_ROOT_PASSWORD ||
      !dockerEnv.MYSQL_USER || !dockerEnv.MYSQL_PASSWORD) throw new Error('LOCAL_DOCKER_CONFIGURATION_REQUIRED');
  execFileSync('docker', ['compose', '--env-file', '.env.b03', '-f', 'compose.b03.yaml', 'up', '-d', '--wait', '--wait-timeout', '90'],
    { cwd: backend, stdio: 'inherit', windowsHide: true });
  const directory = join(process.env.LOCALAPPDATA, 'Venprox', 'development', 'simulation');
  mkdirSync(directory, { recursive: true });
  const profileFile = join(directory, 'profile.json');
  const keyFile = join(directory, 'signing-key.pem');
  if (!existsSync(profileFile)) {
    if (existsSync(keyFile) || existsSync(join(directory, 'terminal.db'))) throw new Error('SIMULATION_PROFILE_MISSING');
    const keys = generateAuthKeys();
    writeFileSync(keyFile, keys.privateKey, { flag: 'wx', mode: 0o600 });
    writeFileSync(profileFile, JSON.stringify({ store_id: randomUUID(), device_id: randomUUID(), login: 'admin.local',
      password: randomBytes(24).toString('base64url'), fingerprint_key: keys.fingerprintKey,
      setup_token: randomBytes(32).toString('base64url'), ready: false } satisfies Profile, null, 2), { flag: 'wx', mode: 0o600 });
  }
  const profile = JSON.parse(readFileSync(profileFile, 'utf8')) as Profile;
  const options = { host: '127.0.0.1', port: 3308, database, user: dockerEnv.MYSQL_USER, password: dockerEnv.MYSQL_PASSWORD };
  const root = await createConnection({ host: options.host, port: options.port, user: 'root', password: dockerEnv.MYSQL_ROOT_PASSWORD });
  try {
    const [tables] = await root.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', [database]);
    if (profile.ready && !tables.some(table => table.TABLE_NAME === 'auth_installation')) throw new Error('SIMULATION_RESTORE_REQUIRED');
    await root.query('CREATE DATABASE IF NOT EXISTS venprox_simulation CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    // Only grant access to the dedicated simulation database, never the existing store.
    await root.query('GRANT ALL ON venprox_simulation.* TO ?@\'%\'', [options.user]);
  } finally { await root.end(); }
  const check = await createConnection(options);
  let hasIdentity = false;
  try {
    const [tables] = await check.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    if (tables.length && !tables.some(table => table.TABLE_NAME === 'instance_identity')) throw new Error('UNRECOGNIZED_SIMULATION_DATABASE');
    if (tables.some(table => table.TABLE_NAME === 'instance_identity')) {
      const [rows] = await check.query<RowDataPacket[]>('SELECT store_id FROM instance_identity');
      hasIdentity = rows.length > 0;
      if (hasIdentity && (rows.length !== 1 || rows[0]!.store_id !== profile.store_id)) throw new Error('SIMULATION_IDENTITY_MISMATCH');
    }
  } finally { await check.end(); }
  const mysql = await MysqlStore.connect(options, { store_id: profile.store_id });
  try {
    await mysql.migrate();
    if (!hasIdentity) await mysql.provisionIdentity();
    await mysql.assertReady();
    const crypto = createAuthCrypto(readFileSync(keyFile, 'utf8'), profile.fingerprint_key);
    const unitOfWork = authUnitOfWork(mysql);
    const auth = new AuthService({ unitOfWork, storeId: profile.store_id, crypto, clock: systemClock, ids: uuidGenerator });
    const installation = await unitOfWork.run(tx => tx.auth.installation()).catch((error: unknown) => {
      if (error instanceof ApplicationError && error.code === 'INSTALLATION_NOT_PROVISIONED') return undefined;
      throw error;
    });
    if (!installation) {
      if (profile.ready) throw new Error('SIMULATION_RESTORE_REQUIRED');
      await provisionAuth(options, profile.store_id, crypto.digest(profile.setup_token), new Date(Date.now() + 3600000).toISOString(), 0);
    }
    if (!installation?.activated_at) {
      if (profile.ready) throw new Error('SIMULATION_RESTORE_REQUIRED');
      await auth.activate({ installation_token: profile.setup_token, store_name: 'Simulação local Docker',
        login: profile.login, name: 'Administrador local', password: profile.password }, '127.0.0.1');
    }
    const path = join(directory, 'terminal.db');
    if (profile.ready && !existsSync(path)) throw new Error('SIMULATION_RESTORE_REQUIRED');
    const sqlite = SqliteStore.open(path, { store_id: profile.store_id, device_id: profile.device_id }, !existsSync(path), true);
    try {
      await sqlite.migrate();
      if (!sqlite.database.prepare('SELECT store_id FROM instance_identity').get()) await sqlite.provisionIdentity();
      const cache = sqliteAuthCache(sqlite, windowsSecretProtector(`venprox-auth-v1:${profile.store_id}:${profile.device_id}`));
      if (!await cache.device()) {
        const session = await auth.login(profile.login, profile.password, '127.0.0.1');
        try {
          const invite = await auth.invitation(session.access);
          await cache.saveDevice(await auth.enroll(invite.invitation_token, profile.device_id, '127.0.0.1'));
        } finally { await auth.logout(session.access); }
      }
    } finally { await sqlite.close(); }
    const apiEnv = { NODE_ENV: 'development', LOG_LEVEL: 'info', API_HOST: options.host, API_PORT: '3334', AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin, STORE_ID: profile.store_id, AUTH_SIGNING_KEY_FILE: keyFile.replaceAll('\\', '/'), AUTH_FINGERPRINT_KEY: profile.fingerprint_key,
      MYSQL_HOST: options.host, MYSQL_PORT: String(options.port), MYSQL_DATABASE: database, MYSQL_USER: options.user, MYSQL_PASSWORD: options.password };
    const localEnv = { NODE_ENV: 'development', LOG_LEVEL: 'info', STORE_ID: profile.store_id, DEVICE_ID: profile.device_id, AUTH_API_ORIGIN: origin,
      LOCAL_DATABASE_PATH: path.replaceAll('\\', '/'), LOCAL_SYNC_ENABLED: 'true', LOCAL_SYNC_POLL_MS: '1000',
      VENPROX_UI_DATA_DIRECTORY: join(directory, 'interface').replaceAll('\\', '/') };
    privateWrite(join(backend, '.env.simulation.api'), envText(apiEnv));
    privateWrite(join(backend, '.env.simulation.local'), envText(localEnv));
    profile.ready = true;
    privateWrite(profileFile, JSON.stringify(profile, null, 2));
    const credentialsFile = join(directory, 'acesso-local.txt');
    privateWrite(credentialsFile, `SIMULAÇÃO LOCAL DOCKER\nLogin: ${profile.login}\nSenha: ${profile.password}\n\nUse somente neste ambiente de testes.\n`);
    console.log(`Simulação pronta: MySQL 127.0.0.1:3308/${database}; API ${origin}.`);
    console.log(`Login e senha locais: ${credentialsFile}`);
    return { apiEnv, localEnv, directory, credentialsFile };
  } finally { await mysql.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSimulation().catch(error => {
    console.error('Não foi possível preparar a simulação:', error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'Confira Docker e o arquivo privado .env.b03.');
    process.exitCode = 1;
  });
}
