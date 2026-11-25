import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CashService } from '../../../../packages/application/src/cash-service.js';
import type { BusinessContext } from '../../../../packages/application/src/business-ports.js';
import { CashListQuery, CashMovementQuery, CashPageResponse, CashResponse, CashMovementsResponse, type CashHttpQuery, type CashHttpMovementQuery } from '../../../../packages/contracts/src/cash.js';
import { IdParams } from '../../../../packages/contracts/src/catalog-stock.js';
import { ErrorSchema } from '../../../../packages/contracts/src/common.js';
export type CashHttpService=Pick<CashService,'list'|'get'|'movements'>;
export function registerCashRoutes(router:FastifyInstance,cash:CashHttpService,authenticate:(request:FastifyRequest)=>Promise<BusinessContext>){
  const errors={400:ErrorSchema,401:ErrorSchema,403:ErrorSchema,404:ErrorSchema,409:ErrorSchema,422:ErrorSchema,500:ErrorSchema,503:ErrorSchema};
  const base={tags:['Cash'],security:[{sessionCookie:[]}],description:'Exige sales.read. Consolidado recebido pelo servidor: scope=server_received/as_of; não inclui fatos ainda offline. Abertura e ajustes somente no terminal local.'};
  const page=(result:{items:unknown[];next_cursor:string|null;scope:string;as_of:string},request:FastifyRequest)=>({data:{items:result.items},meta:{request_id:request.id,next_cursor:result.next_cursor,scope:result.scope,as_of:result.as_of}});
  router.get('/api/v1/cash-sessions',{schema:{...base,operationId:'listCashSessions',querystring:CashListQuery,response:{...errors,200:CashPageResponse}}},async(request)=>{const raw=request.query as CashHttpQuery;return page(await cash.list(await authenticate(request),{...raw,...(raw.limit===undefined?{}:{limit:Number(raw.limit)})} as Parameters<CashService['list']>[1]),request);});
  router.get('/api/v1/cash-sessions/:id',{schema:{...base,operationId:'getCashSession',params:IdParams,response:{...errors,200:CashResponse}}},async(request)=>{const {scope,as_of,...data}=await cash.get(await authenticate(request),(request.params as {id:string}).id);return {data,meta:{request_id:request.id,scope,as_of}};});
  router.get('/api/v1/cash-sessions/:id/movements',{schema:{...base,operationId:'getCashMovements',params:IdParams,querystring:CashMovementQuery,response:{...errors,200:CashMovementsResponse}}},async(request)=>{const raw=request.query as CashHttpMovementQuery;return page(await cash.movements(await authenticate(request),(request.params as {id:string}).id,{...raw,...(raw.limit===undefined?{}:{limit:Number(raw.limit)})} as Parameters<CashService['movements']>[2]),request);});
}
