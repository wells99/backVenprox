import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'mysql2/promise';
import { ConfigurationError } from './config.js';

export function loadAuthDatabaseOptions(env: NodeJS.ProcessEnv): ConnectionOptions {
  const required = (field: string) => { if (!env[field]) throw new ConfigurationError(field); return env[field]!; };
  const host = required('MYSQL_HOST');
  const local = ['127.0.0.1','localhost','::1'].includes(host);
  const port = Number(env.MYSQL_PORT ?? 3306);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new ConfigurationError('MYSQL_PORT');
  return { host, port, database: required('MYSQL_DATABASE'), user: required('MYSQL_USER'), password: required('MYSQL_PASSWORD'),
    ...(local ? {} : { ssl: { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2', ...(env.MYSQL_SSL_CA_FILE ? { ca: readFileSync(env.MYSQL_SSL_CA_FILE, 'utf8') } : {}) } }) };
}
export function loadAuthConfig(env: NodeJS.ProcessEnv) {
  const required = (field: string) => { if (!env[field]) throw new ConfigurationError(field); return env[field]!; };
  const origin = required('AUTH_ORIGIN');
  let url: URL;
  try { url = new URL(origin); } catch { throw new ConfigurationError('AUTH_ORIGIN'); }
  if (url.origin !== origin || !['http:','https:'].includes(url.protocol) ||
      (env.NODE_ENV === 'production' && url.protocol !== 'https:') ||
      (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new ConfigurationError('AUTH_ORIGIN');
  return { mysql: loadAuthDatabaseOptions(env), storeId: required('STORE_ID'), origin, secureCookies: url.protocol === 'https:',
    privateKey: readFileSync(required('AUTH_SIGNING_KEY_FILE'), 'utf8'), fingerprintKey: required('AUTH_FINGERPRINT_KEY') };
}
