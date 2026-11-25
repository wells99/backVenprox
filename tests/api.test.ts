import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApi } from '../apps/api/src/app.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';

test('health mínimo e compatibilidade compartilhada; request_id é gerado no servidor', async () => {
  const app = buildApi({
    logger: createLogger('test', 'silent'), ids: { generate: () => 'server-request' },
    getCompatibility: createGetCompatibility(createCompatibilityPolicy('0.1.0', [1]), '0.1.0'),
  });
  try {
    const health = await app.inject('/health');
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/compatibility', headers: { 'x-request-id': 'spoofed' } });
    assert.equal(response.headers['x-request-id'], 'server-request');
    assert.deepEqual(response.json(), {
      data: { backend_version: '0.1.0', minimum_app_version: '0.1.0', supported_protocol_versions: [1] },
      meta: { request_id: 'server-request' },
    });
    assert.equal((await app.inject('/docs')).statusCode, 404);
  } finally { await app.close(); }
});

test('falhas HTTP e logs não expõem URL sensível, headers, corpo ou erro de driver', async () => {
  const output: string[] = [];
  const logger = createLogger('test', 'info', { write: (chunk: string) => { output.push(chunk); } });
  const app = buildApi({
    logger, ids: { generate: () => 'request-1' },
    getCompatibility: createGetCompatibility(createCompatibilityPolicy('0.1.0', [1]), '0.1.0'),
  });
  app.get('/failure', async () => { throw new Error('password=secret-canary SQL SELECT'); });
  try {
    const response = await app.inject({ method: 'GET', url: '/failure?token=secret-canary', headers: {
      authorization: 'Bearer secret-canary', cookie: 'secret-canary', 'x-device-id': 'secret-canary',
    } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.includes('secret-canary'), false);
    await app.inject('/secret-canary?password=secret-canary');
    const lines = output.join('');
    assert.equal(lines.includes('secret-canary'), false);
    const completion = output.map((line) => JSON.parse(line)).find((line) => line.event === 'request_complete');
    assert.equal(completion.request_id, 'request-1');
    assert.equal(completion.operation_id, null);
    assert.equal(completion.device_id, null);
    assert.equal(typeof completion.duration_ms, 'number');
    logger.info({ password: 'secret-canary', credentials: { token: 'secret-canary' }, err: new Error('secret-canary') }, 'redaction');
    assert.equal(output.join('').includes('secret-canary'), false);
  } finally { await app.close(); }
});

test('política de compatibilidade rejeita versões inválidas e não permite mutação', () => {
  assert.throws(() => createCompatibilityPolicy('v1', [1]));
  assert.throws(() => createCompatibilityPolicy('1.0.0', []));
  assert.throws(() => createCompatibilityPolicy('1.0.0', [1, 1]));
  assert.throws(() => createCompatibilityPolicy('1.0.0', [1.5]));
  const policy = createCompatibilityPolicy('1.0.0', [2, 1]);
  assert.deepEqual(policy.supported_protocol_versions, [1, 2]);
  assert.equal(Object.isFrozen(policy.supported_protocol_versions), true);
});
