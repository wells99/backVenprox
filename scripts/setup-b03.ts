import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'mysql2/promise';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';

async function setup() {
if (!existsSync('.env.b03')) {
  const root = join(process.env.LOCALAPPDATA!, 'Venprox', 'development', 'b03');
  mkdirSync(root, { recursive: true });
  writeFileSync('.env.b03', [
    'MYSQL_HOST=127.0.0.1', 'MYSQL_PORT=3308', 'MYSQL_DATABASE=venprox_b03', 'MYSQL_USER=venprox_migration',
    `MYSQL_PASSWORD=${randomBytes(24).toString('hex')}`, `MYSQL_API_PASSWORD=${randomBytes(24).toString('hex')}`,
    `MYSQL_ROOT_PASSWORD=${randomBytes(24).toString('hex')}`, `STORE_ID=${randomUUID()}`, `DEVICE_ID=${randomUUID()}`,
    `LOCAL_DATABASE_PATH=${join(root, 'terminal.db').replaceAll('\\', '/')}`, '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
}
process.loadEnvFile('.env.b03');
if (process.env.MYSQL_HOST !== '127.0.0.1' || process.env.MYSQL_PORT !== '3308' || process.env.MYSQL_DATABASE !== 'venprox_b03') throw new Error('ISOLATED_DEVELOPMENT_ONLY');
writeFileSync('compose.b03.yaml', `name: venprox-b03
services:
  mysql:
    image: mysql@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902
    ports: ["127.0.0.1:3308:3306"]
    environment:
      MYSQL_DATABASE: venprox_b03
      MYSQL_USER: venprox_migration
      MYSQL_PASSWORD: \${MYSQL_PASSWORD}
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
      MYSQL_ROOT_HOST: "%"
    volumes: ["b03-data:/var/lib/mysql"]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
      interval: 2s
      timeout: 3s
      retries: 30
volumes:
  b03-data:
`);
execFileSync('docker', ['compose', '--env-file', '.env.b03', '-f', 'compose.b03.yaml', 'up', '-d', '--wait', '--wait-timeout', '90'], { stdio: 'inherit', windowsHide: true });
const connection = await createConnection({ host: '127.0.0.1', port: 3308, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD! });
try {
  await connection.query('CREATE DATABASE IF NOT EXISTS venprox_b03_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
  await connection.query("GRANT ALL ON venprox_b03_test.* TO 'venprox_migration'@'%'");
  await connection.query("CREATE USER IF NOT EXISTS 'venprox_api'@'%' IDENTIFIED BY ?", [process.env.MYSQL_API_PASSWORD]);
  await connection.query("GRANT SELECT, INSERT, UPDATE, DELETE ON venprox_b03.* TO 'venprox_api'@'%'");
  console.log('MySQL isolado B03 preparado na porta 3308; bancos de desenvolvimento/teste e usuários separados. Segredos apenas em .env.b03.');
} finally { await connection.end(); }
}
await setup().catch((error: unknown) => reportBootFailure('setup-b03', error));
