import { isAbsolute } from 'node:path';

type Environment = Readonly<Record<string, string | undefined>>;
const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = typeof logLevels[number];

export class ConfigurationError extends Error {
  constructor(readonly field: string) {
    // Nunca incluir o valor informado: ele pode conter credencial.
    super(`Configuração inválida: ${field}. Confira o arquivo de exemplo do processo.`);
    this.name = 'ConfigurationError';
  }
}

function required(env: Environment, field: string): string {
  const value = env[field];
  if (value === undefined || value.length === 0) throw new ConfigurationError(field);
  return value;
}

function integer(env: Environment, field: string, fallback: number, min: number, max: number): number {
  const raw = env[field] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(field);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigurationError(field);
  return value;
}

function common(env: Environment) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new ConfigurationError('NODE_ENV');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!logLevels.includes(logLevel as LogLevel)) throw new ConfigurationError('LOG_LEVEL');
  return {
    nodeEnv,
    logLevel: logLevel as LogLevel,
    shutdownTimeoutMs: integer(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, 100, 60_000),
  };
}

export function loadApiConfig(env: Environment) {
  const host = env.API_HOST ?? '127.0.0.1';
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) throw new ConfigurationError('API_HOST');
  return { ...common(env), host, port: integer(env, 'API_PORT', 3333, 1, 65_535) };
}

export function loadLocalConfig(env: Environment) {
  const base = common(env);
  const databasePath = required(env, 'LOCAL_DATABASE_PATH');
  if (databasePath === ':memory:') {
    if (base.nodeEnv === 'production') throw new ConfigurationError('LOCAL_DATABASE_PATH');
  } else if (!isAbsolute(databasePath) || databasePath.startsWith('\\\\') || databasePath.startsWith('//')) {
    throw new ConfigurationError('LOCAL_DATABASE_PATH');
  }
  const storeId = env.STORE_ID;
  const deviceId = env.DEVICE_ID;
  if (databasePath !== ':memory:') {
    for (const [field, value] of [['STORE_ID', storeId], ['DEVICE_ID', deviceId]] as const) {
      if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new ConfigurationError(field);
    }
  }
  return { ...base, databasePath, identity: storeId && deviceId ? { store_id: storeId, device_id: deviceId } : undefined };
}

export function loadWorkerConfig(env: Environment) {
  const mode = required(env, 'WORKER_MODE');
  if (mode !== 'standby') throw new ConfigurationError('WORKER_MODE');
  return { ...common(env), mode };
}

export function loadMysqlProbeConfig(env: Environment) {
  if (env.MYSQL_PROBE_ALLOW_WRITE !== 'true') throw new ConfigurationError('MYSQL_PROBE_ALLOW_WRITE');
  const host = required(env, 'MYSQL_HOST');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new ConfigurationError('MYSQL_HOST');
  return {
    host,
    port: integer(env, 'MYSQL_PORT', 3307, 1, 65_535),
    database: required(env, 'MYSQL_DATABASE'),
    user: required(env, 'MYSQL_USER'),
    password: required(env, 'MYSQL_PASSWORD'),
  };
}

export function loadPersistenceConfig(env: Environment) {
  const storeId = required(env, 'STORE_ID');
  const deviceId = required(env, 'DEVICE_ID');
  for (const [field, value] of [['STORE_ID', storeId], ['DEVICE_ID', deviceId]] as const) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new ConfigurationError(field);
  }
  const path = required(env, 'LOCAL_DATABASE_PATH');
  if (!isAbsolute(path)) throw new ConfigurationError('LOCAL_DATABASE_PATH');
  const database = required(env, 'MYSQL_DATABASE');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(database)) throw new ConfigurationError('MYSQL_DATABASE');
  return { path, identity: { store_id: storeId, device_id: deviceId }, mysql: {
    host: required(env, 'MYSQL_HOST'), port: integer(env, 'MYSQL_PORT', 3306, 1, 65535), database,
    user: required(env, 'MYSQL_USER'), password: required(env, 'MYSQL_PASSWORD'),
  } };
}
