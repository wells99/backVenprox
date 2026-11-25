import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import formats, { type FormatsPlugin } from 'ajv-formats';
import { Type } from 'typebox';
import { buildApi } from '../apps/api/src/app.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { ErrorSchema } from '../packages/contracts/src/common.js';

function setup(environment = 'test') {
  return buildApi({ environment, logger: createLogger('test', 'silent'), ids: { generate: () => 'test-request' },
    getCompatibility: createGetCompatibility(createCompatibilityPolicy('0.1.0', [1]), '0.1.0') });
}

test('inventário HTTP coincide com OpenAPI; exemplos e respostas obedecem aos schemas', async () => {
  const app = setup('development');
  const inventory: string[] = [];
  app.addHook('onRoute', (route) => {
    if (!route.schema?.hide && route.method === 'GET') inventory.push(route.url);
  });
  try {
    await app.ready();
    const spec = app.swagger();
    assert.ok('openapi' in spec);
    assert.equal(spec.openapi, '3.0.3');
    assert.deepEqual(Object.keys(spec.paths!).sort(), inventory.sort());
    const ids = new Set();
    const ajv = new Ajv({ strict: false });
    (formats as unknown as FormatsPlugin)(ajv);
    for (const path of inventory) {
      const operation: { description?: string; tags?: string[]; operationId?: string; security?: unknown[]; responses?: Record<string, unknown> } = spec.paths![path]!.get!;
      assert.ok(operation.description);
      assert.ok(operation.tags?.length);
      assert.ok(operation.operationId);
      assert.equal(ids.has(operation.operationId), false);
      ids.add(operation.operationId);
      assert.deepEqual(operation.security, []);
      const responseSchema = (operation.responses!['200'] as { content: Record<string, { schema: object }> }).content['application/json']!.schema;
      const example = (responseSchema as { example: unknown }).example;
      assert.equal(ajv.validate(responseSchema, example), true, JSON.stringify(ajv.errors));
      const response = await app.inject(path);
      assert.equal(ajv.validate(responseSchema, response.json()), true, JSON.stringify(ajv.errors));
    }
    assert.equal((await app.inject('/openapi.json')).json().openapi, '3.0.3');
    const docs = await app.inject('/docs/');
    assert.equal(docs.statusCode, 200);
    assert.match(docs.body, /swagger/i);
    assert.equal((await app.inject('/docs/static/swagger-ui.css')).statusCode, 200);
  } finally { await app.close(); }
});

test('produção desativa docs, JSON, YAML, HTML e recursos estáticos', async () => {
  const app = setup('production');
  try {
    for (const path of ['/docs', '/docs/', '/docs/json', '/docs/yaml', '/docs/static/swagger-ui.css', '/openapi.json']) {
      assert.equal((await app.inject(path)).statusCode, 404, path);
    }
  } finally { await app.close(); }
});

test('validação HTTP efetiva rejeita extras/coerção e preserva senha e texto SQL', async () => {
  const app = setup();
  const schema = Type.Object({ password: Type.String(), name: Type.String(), cents: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false });
  let calls = 0;
  app.post('/test-input', { schema: { body: schema, response: { 200: schema } } }, async (request) => {
    calls++;
    return { ...(request.body as object), private_token: 'never-expose' };
  });
  try {
    const input = { password: '  á\u0301 SECRET  ', name: "D'Ávila; SELECT * FROM sales;", cents: 20 };
    const valid = await app.inject({ method: 'POST', url: '/test-input', payload: input });
    assert.deepEqual(valid.json(), input);
    for (const payload of [{ ...input, extra: true }, { ...input, cents: '20' }, { ...input, cents: 2.5 }]) {
      const result = await app.inject({ method: 'POST', url: '/test-input', payload });
      assert.equal(result.statusCode, 422);
      assert.equal(result.json().error.retryable, false);
      assert.ok(result.json().error.field_errors.length);
      assert.equal(result.body.includes('SECRET'), false);
    }
    assert.equal(calls, 1);
    const malformed = await app.inject({ method: 'POST', url: '/test-input', headers: { 'content-type': 'application/json' }, payload: '{' });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, 'MALFORMED_JSON');
    const large = await app.inject({ method: 'POST', url: '/test-input', payload: { ...input, password: 'x'.repeat(70000) } });
    assert.equal(large.statusCode, 413);
    const unsupported = await app.inject({ method: 'POST', url: '/test-input', headers: { 'content-type': 'application/xml' }, payload: '<test/>' });
    assert.equal(unsupported.statusCode, 415);
    const deep = await app.inject({ method: 'POST', url: '/test-input', payload: JSON.parse('{"x":'.repeat(20) + '0' + '}'.repeat(20)) });
    assert.equal(deep.statusCode, 422);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('erros públicos da aplicação mapeiam status e retry-after; erros inesperados são opacos', async () => {
  const app = setup();
  const failures = [
    ['content', 422], ['unauthenticated', 401], ['forbidden', 403], ['not_found', 404],
    ['conflict', 409], ['rate_limited', 429], ['unavailable', 503],
  ] as const;
  for (const [kind] of failures) app.get(`/test-${kind}`, async () => { throw new ApplicationError('TEST_ERROR', 'Mensagem pública.', kind, kind === 'unavailable', 10); });
  app.get('/unexpected', async () => { throw new Error('secret SQL connection'); });
  try {
    const ajv = new Ajv({ strict: false });
    for (const [kind, status] of failures) {
      const response = await app.inject(`/test-${kind}`);
      assert.equal(response.statusCode, status);
      assert.equal(ajv.validate(ErrorSchema, response.json()), true);
      if (status === 429) assert.equal(response.headers['retry-after'], '10');
    }
    const unexpected = await app.inject('/unexpected');
    assert.equal(unexpected.statusCode, 500);
    assert.equal(unexpected.body.includes('secret'), false);
    assert.equal(ajv.validate(ErrorSchema, unexpected.json()), true);
  } finally { await app.close(); }
});
