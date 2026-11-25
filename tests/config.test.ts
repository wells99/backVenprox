import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConfigurationError, loadApiConfig, loadLocalConfig, loadMysqlProbeConfig, loadWorkerConfig,
} from '../packages/infrastructure/runtime/src/config.js';

test('cada processo valida a própria configuração e não exige credenciais de outro processo', () => {
  assert.equal(loadApiConfig({}).port, 3333);
  assert.equal(loadLocalConfig({ LOCAL_DATABASE_PATH: ':memory:' }).databasePath, ':memory:');
  assert.equal(loadWorkerConfig({ WORKER_MODE: 'standby' }).mode, 'standby');
});

test('configuração inválida falha sem incluir o valor fornecido', () => {
  for (const env of [{ API_PORT: 'secret-canary' }, { API_PORT: '1e3' }, { API_PORT: '65536' },
    { NODE_ENV: 'secret-canary' }, { LOG_LEVEL: 'secret-canary' }, { SHUTDOWN_TIMEOUT_MS: '0' }]) {
    assert.throws(() => loadApiConfig(env), (error: unknown) =>
      error instanceof ConfigurationError && !error.message.includes('secret-canary'));
  }
  assert.throws(() => loadLocalConfig({}), ConfigurationError);
  assert.throws(() => loadLocalConfig({ LOCAL_DATABASE_PATH: './missing.db' }), ConfigurationError);
  assert.throws(() => loadLocalConfig({ LOCAL_DATABASE_PATH: '\\\\server\\cash.db' }), ConfigurationError);
  assert.throws(() => loadLocalConfig({ NODE_ENV: 'production', LOCAL_DATABASE_PATH: ':memory:' }), ConfigurationError);
  assert.throws(() => loadWorkerConfig({}), ConfigurationError);
  assert.throws(() => loadWorkerConfig({ WORKER_MODE: 'execute' }), ConfigurationError);
});

test('prova MySQL exige opt-in e destino de desenvolvimento local', () => {
  assert.throws(() => loadMysqlProbeConfig({}), ConfigurationError);
  assert.throws(() => loadMysqlProbeConfig({ MYSQL_PROBE_ALLOW_WRITE: 'true', MYSQL_HOST: 'production.example' }), ConfigurationError);
});
