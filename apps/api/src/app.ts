import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { Logger } from 'pino';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ContractInputError, errorResponse, withinPayloadLimits } from '../../../packages/contracts/src/common.js';
import { ApplicationError } from '../../../packages/application/src/application-error.js';
import type { IdGenerator } from '../../../packages/application/src/ports.js';
import type { createGetCompatibility } from '../../../packages/application/src/get-compatibility.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerAuthRoutes, type AuthHttpOptions } from './routes/auth.js';
import { PersistenceError } from '../../../packages/application/src/persistence.js';

export function buildApi(dependencies: {
  logger: Logger;
  ids: IdGenerator;
  getCompatibility: ReturnType<typeof createGetCompatibility>;
  environment?: string;
  auth?: AuthHttpOptions;
}) {
  const logger: FastifyBaseLogger = dependencies.logger;
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => dependencies.ids.generate(),
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false },
      plugins: [(compiler) => { compiler.addKeyword({keyword:'example',valid:true}); return compiler; }] },
  });

  app.register(swagger, {
    openapi: { openapi: '3.0.3', info: { title: 'Venprox API', version: '0.1.0', description: 'Contratos HTTP do backend Venprox. Limite geral: 64 KiB, profundidade 16, arrays até 100 itens. /sync/push tem limite próprio de 512 KiB/50 operações e publicação atômica. Download com cursor e snapshots imutáveis B11; instalação/sincronizador local em B12. Mutações financeiras locais via IPC.' },
      tags: [{name:'Queries',description:'Consultas autorizadas, abrangência e relatórios.'},{ name: 'System', description: 'Liveness e compatibilidade de versões.' },{name:'Jobs',description:'Exportações assíncronas, leases e retentativas auditadas.'}, { name: 'Identity', description: 'Setup, sessões, usuários e terminais.' },
        {name:'Catalog',description:'Categorias, produtos e clientes versionados.'},{name:'Settings',description:'Preferências e escopo da política de estoque.'},{name:'Stock',description:'Livro e projeções recebidos pelo servidor.'},{name:'Sync',description:'Recepção idempotente, log ordenado e capturas imutáveis autenticadas por terminal.'}],
      components: { securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'venprox_access' },deviceCredential:{type:'apiKey',in:'header',name:'X-Device-Credential'} } }, },
  });
  if (dependencies.environment === 'development') {
    app.register(swaggerUi, { routePrefix: '/docs' });
    app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  }
  app.addHook('preValidation', async (request, reply) => {
    const sync=request.routeOptions.url==='/api/v1/sync/push';
    if (!withinPayloadLimits(request.body,sync?24:16,sync?50000:1000,sync?512*1024:65536)) {
      return reply.code(422).send(errorResponse('PAYLOAD_LIMIT_EXCEEDED', 'Estrutura do conteúdo excede o limite permitido.', request.id));
    }
  });

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('x-request-id', _request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    dependencies.logger.info({
      event: 'request_complete',
      request_id: request.id,
      // Preenchidos a partir de contexto autorizado nas etapas de identidade/operações.
      operation_id: null,
      device_id: null,
      duration_ms: reply.elapsedTime,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status_code: reply.statusCode,
    }, 'Requisição concluída.');
  });
  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send(errorResponse('NOT_FOUND', 'Rota não encontrada.', request.id));
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof PersistenceError) {
      const conflict = ['UNIQUE_CONFLICT','FOREIGN_KEY_CONFLICT'].includes(error.code);
      return reply.code(conflict ? 409 : 503).send(errorResponse(conflict ? 'STATE_CONFLICT' : 'PERSISTENCE_UNAVAILABLE',
        conflict ? 'A operação conflita com o estado atual.' : 'Não foi possível acessar a persistência.', request.id, [], error.retryable));
    }
    const statusCode = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode : 500;
    const kinds = { content: 422, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409, rate_limited: 429, unavailable: 503 };
    const validation = error instanceof Error && 'validation' in error && Array.isArray(error.validation) ? error.validation : undefined;
    const code = error instanceof ApplicationError ? kinds[error.kind] : error instanceof ContractInputError || validation ? 422
      : statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    dependencies.logger.error({ event: 'request_failed', request_id: request.id, status_code: code }, 'Falha na requisição.');
    if (error instanceof ApplicationError) {
      if (code === 429 && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds! >= 0) reply.header('retry-after', error.retryAfterSeconds!);
      return reply.code(code).send(errorResponse(error.code, error.message, request.id, [], error.retryable,error.conflict));
    }
    const fieldErrors = validation?.map((item) => ({ path: String(item.instancePath ?? ''), code: String(item.keyword ?? 'invalid'), message: 'Campo inválido.' }))
      ?? (error instanceof ContractInputError ? [{ path: `/${error.field}`, code: 'invalid', message: 'Campo inválido.' }] : []);
    const codes: Record<number, string> = { 400: 'MALFORMED_JSON', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'VALIDATION_ERROR' };
    return reply.code(code).send(errorResponse(code === 500 ? 'INTERNAL_ERROR' : codes[code] ?? 'INVALID_REQUEST',
      code === 500 ? 'Não foi possível concluir a requisição.' : 'Requisição inválida.', request.id, fieldErrors));
  });
  app.register(async (scope) => { registerSystemRoutes(scope, dependencies.getCompatibility); });
  if (dependencies.auth) app.register((scope) => registerAuthRoutes(scope, dependencies.auth!));
  return app;
}
