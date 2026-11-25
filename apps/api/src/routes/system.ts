import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { CompatibilitySchema, HealthSchema } from '../../../../packages/contracts/src/system.js';
import type { createGetCompatibility } from '../../../../packages/application/src/get-compatibility.js';
import { ErrorSchema } from '../../../../packages/contracts/src/common.js';

export function registerSystemRoutes(
  app: FastifyInstance,
  getCompatibility: ReturnType<typeof createGetCompatibility>,
) {
  const router = app.withTypeProvider<TypeBoxTypeProvider>();
  router.get('/health', { schema: {
    tags: ['System'], operationId: 'getHealth', summary: 'Verificar liveness',
    description: 'Consulta pública e idempotente, sem corpo ou parâmetros. Não consulta banco/fila nem comprova readiness. Resposta mínima é exceção ao envelope data/meta.',
    security: [], response: { 200: { ...HealthSchema, example: { status: 'ok' } }, 500: ErrorSchema },
  } }, async () => ({ status: 'ok' as const }));
  router.get('/api/v1/compatibility', {
    schema: { tags: ['System'], operationId: 'getCompatibility', summary: 'Consultar compatibilidade',
      description: 'Consulta pública e idempotente das versões aceitas. Sem corpo, query ou parâmetros de caminho. Não autentica dispositivo nem provisiona loja. Limites globais descritos na API.',
      security: [], response: { 200: { ...CompatibilitySchema, example: {
        data: { backend_version: '0.1.0', minimum_app_version: '0.1.0', supported_protocol_versions: [1] }, meta: { request_id: 'example-request' },
      } }, 500: ErrorSchema }, },
  }, async (request) => ({ data: getCompatibility(), meta: { request_id: request.id } }));
}
