import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { CatalogService } from '../../../../packages/application/src/catalog-service.js';
import type { StockService } from '../../../../packages/application/src/stock-service.js';
import type { BusinessContext } from '../../../../packages/application/src/business-ports.js';
import * as schemas from '../../../../packages/contracts/src/catalog-stock.js';
import { ErrorSchema, successSchema } from '../../../../packages/contracts/src/common.js';
import { registerCashRoutes, type CashHttpService } from './cash.js';

export interface BusinessHttpServices {catalog:Pick<CatalogService,'list'|'get'|'createCategory'|'updateCategory'|'createProduct'|'updateProduct'|'createCustomer'|'updateCustomer'|'settings'|'changeSettings'>;stock:Pick<StockService,'balances'|'movements'>;cash?:CashHttpService}
export function registerBusinessRoutes(router:FastifyInstance,services:BusinessHttpServices,authenticate:(request:FastifyRequest)=>Promise<BusinessContext>,mutation:(request:FastifyRequest)=>Promise<void>){
  if(services.cash)registerCashRoutes(router,services.cash,authenticate);
  const errors={400:ErrorSchema,401:ErrorSchema,403:ErrorSchema,404:ErrorSchema,409:ErrorSchema,413:ErrorSchema,422:ErrorSchema,500:ErrorSchema,503:ErrorSchema};
  const base=(operationId:string,tag='Catalog')=>({operationId,tags:[tag],security:[{sessionCookie:[]}],response:errors,description:'Consulta autenticada da loja da instalação; exige catalog.read. Retorna somente campos autorizados, nunca credenciais. Cadastro não encontrado retorna 404.'});
  const wrap=(data:unknown,request:FastifyRequest)=>({data,meta:{request_id:request.id}});
  const page=(result:{items:unknown[];next_cursor:string|null;scope:string;as_of:string},request:FastifyRequest)=>({data:{items:result.items},meta:{request_id:request.id,next_cursor:result.next_cursor,scope:result.scope,as_of:result.as_of}});
  const query=(raw:schemas.HttpListQuery)=>({...raw,...(raw.limit===undefined?{}:{limit:Number(raw.limit)}),...(raw.active===undefined?{}:{active:raw.active==='true'})}) as {q?:string;after?:string;limit?:number;active?:boolean};
  const intention=(request:FastifyRequest)=>String(request.headers['idempotency-key']);
  for(const kind of ['categories','products','customers'] as const){
    const item=kind==='products'?schemas.Product:kind==='categories'?schemas.Category:schemas.Customer;
    const input=kind==='products'?schemas.ProductInput:kind==='categories'?schemas.CategoryInput:schemas.CustomerInput;
    const update=kind==='products'?schemas.ProductUpdate:kind==='categories'?schemas.CategoryUpdate:schemas.CustomerUpdate;
    router.get(`/api/v1/${kind}`,{schema:{...base(`list_${kind}`),querystring:schemas.ListQuery,response:{...errors,200:schemas.CatalogResponse},description:'Base confirmada conhecida pelo servidor; paginação por ID, q por nome/código/barcode, active opcional. Custo exige costs.read.'}},async(request)=>page(await services.catalog.list(await authenticate(request),kind,query(request.query as schemas.HttpListQuery)),request));
    router.get(`/api/v1/${kind}/:id`,{schema:{...base(`get_${kind}`),params:schemas.IdParams,response:{...errors,200:successSchema(item)}}},async(request)=>wrap(await services.catalog.get(await authenticate(request),kind,(request.params as {id:string}).id),request));
    router.post(`/api/v1/${kind}`,{preHandler:mutation,schema:{...base(`create_${kind}`),headers:schemas.IntentionHeaders,body:input,response:{...errors,201:successSchema(item)},description:'catalog.write, Origin e X-CSRF-Token. Idempotency-Key UUID estável. Até B11, escrita somente em banco isolado de laboratório; perfil operacional retorna 503 CATALOG_PUBLICATION_REQUIRED.'}},async(request,reply)=>{
      const context=await authenticate(request),key=intention(request);
      const result=kind==='products'?await services.catalog.createProduct(context,key,request.body as schemas.ProductInputDto):kind==='categories'?await services.catalog.createCategory(context,key,request.body as schemas.CategoryInputDto):await services.catalog.createCustomer(context,key,request.body as schemas.CustomerInputDto);
      return reply.code(201).send(wrap(result,request));
    });
    router.patch(`/api/v1/${kind}/:id`,{preHandler:mutation,schema:{...base(`update_${kind}`),params:schemas.IdParams,headers:schemas.IntentionHeaders,body:update,response:{...errors,200:successSchema(item)},description:'Idempotency-Key + expected_version. Ausente preserva; null somente em campos opcionais anuláveis. Inativação/reativação auditada, sem exclusão física. 409 inclui versão atual; UI preserva o corpo enviado. Escrita operacional aguarda B11.'}},async(request)=>{
      const context=await authenticate(request),key=intention(request),id=(request.params as {id:string}).id;
      let result:unknown;
      if(kind==='products'){const {expected_version,...patch}=request.body as schemas.ProductUpdateDto;result=await services.catalog.updateProduct(context,id,key,expected_version,patch);}
      else if(kind==='categories'){const {expected_version,...patch}=request.body as schemas.CategoryUpdateDto;result=await services.catalog.updateCategory(context,id,key,expected_version,patch);}
      else {const {expected_version,...patch}=request.body as schemas.CustomerUpdateDto;result=await services.catalog.updateCustomer(context,id,key,expected_version,patch);}
      return wrap(result,request);
    });
  }
  router.get('/api/v1/settings',{schema:{...base('getSettings','Settings'),response:{...errors,200:schemas.SettingsResponse}}},async(request)=>wrap(await services.catalog.settings(await authenticate(request)),request));
  router.patch('/api/v1/settings',{preHandler:mutation,schema:{...base('changeSettings','Settings'),headers:schemas.IntentionHeaders,body:schemas.SettingsUpdate,response:{...errors,200:successSchema(schemas.StoreSettings)},description:'settings.manage. Require_stock exige strict_scope=local_terminal explícito; não garante estoque global. Escrita operacional aguarda B11; imagens permanecem desativadas.'}},async(request)=>{const {expected_version,...patch}=request.body as schemas.SettingsUpdateDto;return wrap(await services.catalog.changeSettings(await authenticate(request),intention(request),expected_version,patch),request);});
  router.get('/api/v1/stock/balances',{schema:{...base('getStockBalances','Stock'),querystring:schemas.BalanceQuery,response:{...errors,200:schemas.BalancesResponse},description:'Saldo recebido pelo servidor, scope=server_received e as_of; não representa todos os caixas offline. product_id opcional.'}},async(request)=>{const raw=request.query as schemas.HttpBalanceQuery;return page(await services.stock.balances(await authenticate(request),{...query(raw),...(raw.product_id?{product_id:raw.product_id}:{})}),request);});
  router.get('/api/v1/stock/movements',{schema:{...base('getStockMovements','Stock'),querystring:schemas.MovementQuery,response:{...errors,200:schemas.MovementsResponse},description:'Ordenação crescente por instante UTC e ID; filtros product_id/from/to, cursor estável, limite até 100. Não há mutações web de estoque.'}},async(request)=>{const raw=request.query as schemas.HttpMovementQuery;return page(await services.stock.movements(await authenticate(request),{...raw,...(raw.limit===undefined?{}:{limit:Number(raw.limit)})} as Parameters<StockService['movements']>[1]),request);});
}
