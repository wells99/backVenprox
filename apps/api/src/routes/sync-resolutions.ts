import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { BusinessContext } from '../../../../packages/application/src/business-ports.js';
import type { SyncResolutionService } from '../../../../packages/application/src/sync-resolution-service.js';
import type { ResolutionCommand } from '../../../../packages/application/src/sync-resolution-ports.js';
import { ResolutionBody,ResolutionResponse,ResolutionHeaders,ResolutionParams } from '../../../../packages/contracts/src/sync-resolutions.js';
import { SyncErrors } from '../../../../packages/contracts/src/sync.js';
export type ResolutionHttpService=Pick<SyncResolutionService,'get'|'submit'>;
export function registerSyncResolutionRoutes(router:FastifyInstance,service:ResolutionHttpService,authenticate:(r:FastifyRequest)=>Promise<BusinessContext>,mutation:(r:FastifyRequest)=>Promise<void>){
  const base={tags:['Sync'],security:[{sessionCookie:[]}],response:SyncErrors},wrap=<T>(data:T,r:FastifyRequest)=>({data,meta:{request_id:r.id}});
  router.post('/api/v1/admin/sync-resolutions',{preHandler:mutation,schema:{...base,operationId:'submitSyncResolution',headers:ResolutionHeaders,body:ResolutionBody,response:{...SyncErrors,201:ResolutionResponse},description:'Administrador online com recovery.manage + users.manage; Origin/CSRF, Idempotency-Key UUID, versão 1 e justificativa. Confirmação financeira somente para origem antiga não comprovável, com invariantes/hash/dependências válidos; nunca descarta venda paga nem altera envelope/IDs. Revisão, efeitos, publicação, recibo e fronteira são atômicos. Proposta obsoleta exige reapply_proposal com versão atual e patch explícito, sob nova intenção. Original e recibo anterior ficam preservados.'}},async(r,reply)=>reply.code(201).send(wrap(await service.submit(await authenticate(r),String(r.headers['idempotency-key']),r.body as ResolutionCommand),r)));
  router.get('/api/v1/admin/sync-resolutions/:id',{schema:{...base,operationId:'getSyncResolution',params:ResolutionParams,response:{...SyncErrors,200:ResolutionResponse},description:'Consulta administrativa identificada na própria loja. Retorna decisão/recibo seguro, sem envelope bruto, prova de origem ou credenciais. Ausência/outra loja retorna 404.'}},async(r)=>wrap(await service.get(await authenticate(r),(r.params as {id:string}).id),r));
}
