import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { test } from 'node:test';
import { createConnection, type ConnectionOptions } from 'mysql2/promise';
import { Value } from 'typebox/value';
import { Ajv } from 'ajv';
import formats,{type FormatsPlugin} from 'ajv-formats';
import { CatalogService } from '../packages/application/src/catalog-service.js';
import { StockService } from '../packages/application/src/stock-service.js';
import { CashService } from '../packages/application/src/cash-service.js';
import type { BusinessContext, BusinessDependencies, Product } from '../packages/application/src/business-ports.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { permissions, rolePermissions } from '../packages/domain/src/authorization.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { sqliteBusinessUnitOfWork } from '../packages/infrastructure/sqlite/src/business.js';
import { mysqlBusinessUnitOfWork } from '../packages/infrastructure/mysql/src/business.js';
import { businessHash } from '../packages/infrastructure/persistence/src/business-repository.js';
import { mysqlMigrations } from '../migrations/mysql/registry.js';
import { catalogLabWrites } from '../packages/infrastructure/runtime/src/catalog-config.js';
import { boundBusinessHandler } from '../packages/infrastructure/native/src/business-boundary.js';
import { BusinessIpcResponse, businessIpcCommands, businessEnvelope } from '../packages/contracts/src/catalog-stock.js';
import { executeBusiness } from '../apps/local-service/src/business.js';
import { buildApi } from '../apps/api/src/app.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { AuthService } from '../packages/application/src/auth-service.js';
import { createAuthCrypto, generateAuthKeys } from '../packages/infrastructure/security/src/crypto.js';
import { authUnitOfWork } from '../packages/infrastructure/mysql/src/auth-repository.js';
import { provisionAuth } from '../packages/infrastructure/mysql/src/auth-provision.js';

const fails=(code:string)=>(error:unknown)=>error instanceof ApplicationError&&error.code===code;
const now='2026-11-25T12:00:00.000Z';
const tables=[...new Set(mysqlMigrations.flatMap((m)=>m.steps).filter((s)=>s.sql.startsWith('CREATE TABLE')).map((s)=>s.table))].reverse();
const sqlOptions=(database:string):ConnectionOptions=>({host:'127.0.0.1',port:3308,database,user:'venprox_migration',password:process.env.MYSQL_PASSWORD!});
async function clearMysql(database:string){
  assert.ok(['venprox_b05_test','venprox_b05_restore_test'].includes(database));
  const connection=await createConnection(sqlOptions(database));
  try{for(const table of [...tables,'schema_migrations'])await connection.query(`DROP TABLE IF EXISTS ${table}`);}finally{await connection.end();}
}
async function fixture(engine:'sqlite'|'mysql'){
  const directory=await mkdtemp(join(tmpdir(),'venprox-b05-'));
  const storeId=randomUUID(),deviceId=randomUUID();
  if(engine==='mysql'){assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_PORT,'3308');await clearMysql('venprox_b05_test');}
  const store=engine==='sqlite'?SqliteStore.open(join(directory,'terminal.db'),{store_id:storeId,device_id:deviceId},true):await MysqlStore.connect(sqlOptions('venprox_b05_test'),{store_id:storeId});
  await store.migrate();await store.provisionIdentity();
  const deps:BusinessDependencies={unitOfWork:store instanceof SqliteStore?sqliteBusinessUnitOfWork(store):mysqlBusinessUnitOfWork(store),storeId,deviceId,local:false,remoteWritesEnabled:true,clock:{now:()=>new Date(now)},ids:{generate:randomUUID},hash:businessHash};
  const context:BusinessContext={store_id:storeId,device_id:deviceId,user_id:randomUUID(),permissions,permissions_version:1,authorization_id:randomUUID(),authorization_origin:'online',authorized_at:now,expires_at:'2026-11-26T12:00:00.000Z'};
  return {store,deps,context,directory,catalog:new CatalogService(deps),stock:new StockService({...deps,local:true}),async close(){
    await store.close();if(engine==='mysql')await clearMysql('venprox_b05_test');
    assert.equal(await realpath(dirname(directory)),await realpath(tmpdir()));assert.ok(basename(directory).startsWith('venprox-b05-'));await rm(directory,{recursive:true,force:true});
  }};
}

for(const engine of ['sqlite','mysql'] as const)test(`B05/B06 ${engine}: catálogo versionado e livro/projeção transacionais`,{skip:engine==='mysql'&&!process.env.MYSQL_PASSWORD,timeout:90000},async(t)=>{
  const f=await fixture(engine),{catalog,stock,context:admin,deps}=f;
  const operator={...admin,permissions:rolePermissions.operator};
  let id='',categoryId='';
  const create=async(code:string,extra:Partial<Product>={})=>await catalog.createProduct(admin,randomUUID(),{name:'Produto',internal_code:code,unit:'unit',price_cents:100,...extra}) as Product;
  const balance=()=>deps.unitOfWork.run((tx)=>tx.business.balance(id));
  const sale=async(origin:string,quantities:number[],anonymous=false)=>stock.transaction((tx)=>stock.recordSale(tx,admin,origin,quantities.map((quantity,index)=>({product_id:anonymous?null:id,item_id:`550e8400-e29b-41d4-a716-${String(index).padStart(12,'0')}`,quantity_milli:quantity}))));
  try{
    await t.test('normalização, barcode com zeros, replay e isolamento de permissão',async()=>{
      categoryId=String((await catalog.createCategory(admin,randomUUID(),{name:' Mercearia '})).id);
      const intention=randomUUID(),input={name:' Cafe\u0301 ',internal_code:' café-01 ',unit:'unit' as const,price_cents:1500,cost_cents:0,barcodes:['00123'],category_id:categoryId};
      const product=await catalog.createProduct(admin,intention,input) as Product;id=product.id;
      assert.equal(product.name,'Café');assert.equal(product.internal_code,'café-01');assert.equal(product.cost_cents,0);assert.deepEqual(product.barcodes,['00123']);
      assert.deepEqual(await catalog.createProduct(admin,intention,input),product);
      await assert.rejects(catalog.createProduct(admin,intention,{...input,price_cents:1600}),fails('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(create('CAFE\u0301-01'),fails('PRODUCT_CODE_IN_USE'));
      await assert.rejects(create('OUTRO',{barcodes:['00123']}),fails('BARCODE_IN_USE'));
      await assert.rejects(create('ß'.repeat(64)),fails('INVALID_TEXT'));
      const view=await catalog.get(operator,'products',id);assert.equal('cost_cents' in view,false);assert.equal('store_id' in view,false);assert.equal('code_key' in view,false);
      assert.equal((await catalog.list(operator,'products',{q:'00123'})).items.length,1);
      assert.equal((await catalog.list(operator,'products',{q:'cafe'})).items.length,1);
      assert.equal((await catalog.list(operator,'products',{q:'cafe\u0301-01'})).items.length,1);
      assert.equal((await catalog.list(operator,'products',{q:'%'})).items.length,0);
      await assert.rejects(catalog.createProduct(operator,randomUUID(),input),fails('PERMISSION_DENIED'));
      await assert.rejects(catalog.list({...admin,store_id:randomUUID()},'products'),fails('SCOPE_MISMATCH'));
      await assert.rejects(catalog.list({...admin,expires_at:now},'products'),fails('AUTHENTICATION_REQUIRED'));
    });
    await t.test('colisão simultânea, paginação estável, versão obsoleta e reativação',async()=>{
      const results=await Promise.allSettled([create(' CONCORRENTE '),create('concorrente')]);
      assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);assert.equal(results.filter((r)=>r.status==='rejected').length,1);
      const first=await catalog.list(admin,'products',{limit:1});assert.ok(first.next_cursor);
      const second=await catalog.list(admin,'products',{limit:1,after:first.next_cursor!});assert.notEqual(first.items[0]!.id,second.items[0]!.id);
      const intention=randomUUID();const updated=await catalog.updateProduct(admin,id,intention,1,{active:false}) as Product;
      assert.equal(updated.version,2);assert.equal(updated.active,false);assert.deepEqual(await catalog.updateProduct(admin,id,intention,1,{active:false}),updated);
      await assert.rejects(catalog.updateProduct(admin,id,randomUUID(),1,{price_cents:1}),(error:unknown)=>error instanceof ApplicationError&&error.conflict?.current_version===2);
      await catalog.updateProduct(admin,id,randomUUID(),2,{active:true});
      const a=await catalog.createCustomer(admin,randomUUID(),{name:'Mesmo nome'}) as {id:string},b=await catalog.createCustomer(admin,randomUUID(),{name:'Mesmo nome'}) as {id:string};assert.notEqual(a.id,b.id);
    });
    await t.test('padrões persistidos e bloqueio de publicação operacional',async()=>{
      const settings=await catalog.settings(admin);assert.equal(settings.store.stock_policy,'permissive');assert.equal(settings.store.images_enabled,false);
      assert.deepEqual(await new CatalogService(deps).settings(admin),settings);
      await assert.rejects(catalog.changeSettings(admin,randomUUID(),1,{stock_policy:'require_stock'}),fails('STRICT_SCOPE_ACKNOWLEDGEMENT_REQUIRED'));
      await assert.rejects(new CatalogService({...deps,remoteWritesEnabled:false}).createCategory(admin,randomUUID(),{name:'Bloqueado'}),fails('CATALOG_PUBLICATION_REQUIRED'));
    });
    await t.test('entrada custo desconhecido, repetição e validação de inteiros/unidade',async()=>{
      const intention=randomUUID(),input={product_id:id,quantity_milli:5000,unit_cost_cents:null,reason:' Recebimento '};
      const entry=await stock.registerEntry(admin,intention,input);assert.equal(entry.balance.quantity_milli,5000);assert.equal(entry.movement.unit_cost_cents,null);assert.equal(entry.scope,'local_terminal');
      assert.deepEqual(await stock.registerEntry(admin,intention,input),entry);
      for(const quantity of [0,-1000,1,1000.1,Number.MAX_SAFE_INTEGER+1])await assert.rejects(stock.registerEntry(admin,randomUUID(),{...input,quantity_milli:quantity}),fails('INVALID_QUANTITY'));
      await assert.rejects(stock.registerEntry(operator,randomUUID(),input),fails('PERMISSION_DENIED'));
      await assert.rejects(new StockService(deps).registerEntry(admin,randomUUID(),input),fails('LOCAL_STOCK_ONLY'));
      await assert.rejects(catalog.updateProduct(admin,id,randomUUID(),3,{unit:'kg'}),fails('UNIT_HAS_MOVEMENTS'));
    });
    await t.test('rollback de movimento/projeção/outbox/auditoria, inclusive falha no evento',async()=>{
      const before=await balance(),count=(await stock.movements(admin,{product_id:id})).items.length;
      const fault=new StockService({...deps,local:true,unitOfWork:{run:(work)=>deps.unitOfWork.run((tx)=>work({...tx,audit:{append:async()=>{throw new ApplicationError('INJECTED_FAILURE','Falha de teste.','unavailable');}}}))}});
      const intention=randomUUID(),input={product_id:id,quantity_milli:1000,unit_cost_cents:null,reason:'Falha'};
      await assert.rejects(fault.registerEntry(admin,intention,input),fails('INJECTED_FAILURE'));
      assert.deepEqual(await balance(),before);assert.equal((await stock.movements(admin,{product_id:id})).items.length,count);
      assert.equal(await deps.unitOfWork.run((tx)=>tx.business.intention(intention)),undefined);
      await stock.registerEntry(admin,intention,input);assert.equal((await balance()).quantity_milli,before.quantity_milli+1000);
      await assert.rejects(stock.transaction(async(tx)=>{await stock.recordSale(tx,admin,randomUUID(),[{item_id:randomUUID(),product_id:id,quantity_milli:1000}]);throw new ApplicationError('INJECTED_FAILURE','Falha de teste.','unavailable');}),fails('INJECTED_FAILURE'));
      assert.equal((await balance()).quantity_milli,before.quantity_milli+1000);
    });
    await t.test('ajuste absoluto usa base/versão, permissivo negativo e avulso sem movimento',async()=>{
      const before=await balance(),origin=randomUUID();await sale(origin,[1000]);
      await assert.rejects(stock.adjustCount(admin,randomUUID(),{product_id:id,counted_milli:9000,expected_version:before.version,expected_quantity_milli:before.quantity_milli,reason:'Contagem antiga'}),fails('STOCK_COUNT_CONFLICT'));
      const current=await balance(),intention=randomUUID(),input={product_id:id,counted_milli:2000,expected_version:current.version,expected_quantity_milli:current.quantity_milli,reason:'Inventário local'};
      const result=await stock.adjustCount(admin,intention,input);assert.equal(result.balance.quantity_milli,2000);assert.deepEqual(await stock.adjustCount(admin,intention,input),result);
      const noChange=await balance();await stock.adjustCount(admin,randomUUID(),{...input,counted_milli:2000,expected_version:noChange.version,expected_quantity_milli:2000});assert.deepEqual(await balance(),noChange);
      await sale(randomUUID(),[3000]);assert.equal((await balance()).quantity_milli,-1000);
      const count=(await stock.movements(admin)).items.length;assert.deepEqual(await sale(randomUUID(),[1000],true),[]);assert.equal((await stock.movements(admin)).items.length,count);
    });
    await t.test('estrito agrega itens repetidos, serializa venda/contagem e estorna por origem',async()=>{
      const current=await balance();await stock.adjustCount(admin,randomUUID(),{product_id:id,counted_milli:3000,expected_version:current.version,expected_quantity_milli:current.quantity_milli,reason:'Contagem'});
      await deps.unitOfWork.run(async(tx)=>{await tx.business.lockScope();const settings=await tx.business.settings();await tx.business.saveSettings({...settings,stock_policy:'require_stock',version:settings.version+1});});
      await assert.rejects(sale(randomUUID(),[2000,2000]),fails('INSUFFICIENT_LOCAL_STOCK'));assert.equal((await balance()).quantity_milli,3000);
      await assert.rejects(sale(randomUUID(),[1000],true),fails('PRODUCT_REQUIRED'));
      const origin=randomUUID(),movements=await sale(origin,[1000,1000]);assert.equal((await balance()).quantity_milli,1000);
      const product=await deps.unitOfWork.run((tx)=>tx.business.product(id));await deps.unitOfWork.run((tx)=>tx.business.saveProduct({...product!,cost_cents:999}));
      assert.deepEqual(await sale(origin,[1000,1000]),movements);assert.equal((await balance()).quantity_milli,1000);
      const before=await balance();const concurrent=await Promise.allSettled([sale(randomUUID(),[1000]),stock.adjustCount(admin,randomUUID(),{product_id:id,counted_milli:2000,expected_version:before.version,expected_quantity_milli:before.quantity_milli,reason:'Contagem concorrente'})]);
      assert.equal(concurrent[0]!.status,'fulfilled');if(concurrent[1]!.status==='rejected')assert.ok(fails('STOCK_COUNT_CONFLICT')(concurrent[1]!.reason));
      assert.equal((await balance()).quantity_milli,concurrent[1]!.status==='fulfilled'?1000:0);
      const lines=movements.map((m)=>({product_id:m.product_id,item_id:m.item_id,quantity_milli:-m.delta_milli}));
      await catalog.updateProduct(admin,id,randomUUID(),3,{active:false});
      const reverse=()=>stock.transaction((tx)=>stock.recordFullReversal(tx,admin,origin,lines));const restored=await reverse();assert.deepEqual(await reverse(),restored);
      assert.equal(restored[0]!.unit_cost_cents,0);assert.equal((await stock.movements(operator)).items.some((row)=>'unit_cost_cents' in row),false);
      const page=await stock.movements(admin,{limit:1});assert.ok(page.next_cursor);const next=await stock.movements(admin,{limit:1,after:page.next_cursor!});assert.notEqual(next.items[0]!.id,page.items[0]!.id);
      assert.ok((await stock.movements(admin,{from:'2026-11-25T12:00:00Z',to:'2026-11-25T12:00:00.000Z'})).items.length>0);
      await assert.rejects(stock.movements(admin,{from:'2026-02-30T12:00:00Z'}),fails('INVALID_DATE'));
    });
    await t.test('reconstrução pelo livro, histórico preservado e backup restaurável',async()=>{
      const before=await balance(),count=(await stock.movements(admin)).items.length;
      await deps.unitOfWork.run((tx)=>tx.business.saveBalance({...before,quantity_milli:987000}));
      const result=await stock.rebuild(admin,randomUUID(),id);assert.equal(result.quantity_milli,before.quantity_milli);assert.equal((await stock.movements(admin)).items.length,count);
      const backup=join(f.directory,engine==='sqlite'?'backup.db':'backup.json');await f.store.backup(backup);
      if(f.store instanceof SqliteStore){
        const path=join(f.directory,'restored.db');await copyFile(backup,path);const copy=SqliteStore.open(path,{store_id:deps.storeId,device_id:deps.deviceId});
        try{assert.deepEqual(await sqliteBusinessUnitOfWork(copy).run((tx)=>tx.business.balance(id)),await balance());}finally{await copy.close();}
      }else{
        await clearMysql('venprox_b05_restore_test');const copy=await MysqlStore.connect(sqlOptions('venprox_b05_restore_test'),{store_id:deps.storeId});
        try{await copy.migrate();await copy.restore(backup);assert.deepEqual(await mysqlBusinessUnitOfWork(copy).run((tx)=>tx.business.balance(id)),await balance());}finally{await copy.close();await clearMysql('venprox_b05_restore_test');}
      }
    });
  }finally{await f.close();}
});

test('B05 SQLite/IPC: propostas separadas, conflitos preservados, cliente mínimo UUID e preferências persistidas',async()=>{
  const f=await fixture('sqlite'),local=new CatalogService({...f.deps,local:true}),context=f.context;
  const send=async(command:unknown)=>{
    assert.ok(Value.Check(businessIpcCommands,command));const data=await executeBusiness(command,context,local,f.stock);
    assert.ok(Value.Check(BusinessIpcResponse,businessEnvelope(data,'ipc')),JSON.stringify(data));return data;
  };
  try{
    const input={name:'Pendente',internal_code:'P-01',unit:'unit',price_cents:100,cost_cents:null};
    const proposal=await send({type:'products.proposeCreate',request_id:'ipc',intention_id:randomUUID(),input}) as {entity_id:string};
    assert.equal((await local.list(context,'products')).items.length,0);await assert.rejects(f.stock.registerEntry(context,randomUUID(),{product_id:proposal.entity_id,quantity_milli:1000,unit_cost_cents:null,reason:'Não confirmado'}),fails('PRODUCT_NOT_FOUND'));
    const accepted=await f.catalog.createProduct(context,randomUUID(),{...input,unit:'unit',internal_code:'ACCEPTED'}) as Product;
    await send({type:'products.proposeUpdate',request_id:'ipc',id:accepted.id,intention_id:randomUUID(),input:{expected_version:1,name:'Rascunho'}});
    assert.equal((await local.get(context,'products',accepted.id)).name,'Pendente');
    await f.catalog.updateProduct(context,accepted.id,randomUUID(),1,{name:'Servidor versão 2'});
    const conflict=await send({type:'products.proposeUpdate',request_id:'ipc',id:accepted.id,intention_id:randomUUID(),input:{expected_version:1,name:'Preservar rascunho'}}) as {status:string};assert.equal(conflict.status,'conflict');
    const pending=await send({type:'catalog.getPending',request_id:'ipc'}) as {items:unknown[]};assert.equal(pending.items.length,3);
    const customer=randomUUID(),operator={...context,permissions:rolePermissions.operator};
    const created=await local.createCustomer(operator,randomUUID(),{name:'Cliente offline'},customer) as {proposal:{id:string;confirmation_state:string}};
    assert.equal(created.proposal.id,customer);assert.equal(created.proposal.confirmation_state,'local_pending');assert.equal((await local.list(operator,'customers')).items.length,1);
    const defaults=await send({type:'settings.get',request_id:'ipc'}) as {terminal:{version:number;automatic_printing:boolean}};assert.equal(defaults.terminal.automatic_printing,false);
    await send({type:'settings.changeTerminal',request_id:'ipc',intention_id:randomUUID(),expected_version:1,automatic_printing:false});
    const settings=await send({type:'settings.change',request_id:'ipc',intention_id:randomUUID(),input:{expected_version:1,stock_policy:'require_stock',strict_scope:'local_terminal'}}) as {status:string};assert.equal(settings.status,'pending');assert.equal((await local.settings(context)).store.stock_policy,'permissive');
    const entryProduct=accepted.id;
    await send({type:'stock.registerEntry',request_id:'ipc',intention_id:randomUUID(),input:{product_id:entryProduct,quantity_milli:1000,unit_cost_cents:null,reason:'Entrada'}});
    await send({type:'stock.getBalances',request_id:'ipc',query:{product_id:entryProduct}});await send({type:'stock.getMovements',request_id:'ipc',query:{}});
    const path=(f.store as SqliteStore).path;await f.store.close();const reopened=SqliteStore.open(path,{store_id:f.deps.storeId,device_id:f.deps.deviceId});
    try{const restarted=new CatalogService({...f.deps,local:true,unitOfWork:sqliteBusinessUnitOfWork(reopened)});assert.equal((await restarted.settings(context)).terminal!.version,2);assert.equal((await restarted.pending(context)).items.length,5);}finally{await reopened.close();}
  }finally{await f.close();}
});

test('B05/B06 fronteiras: laboratório restrito, remetente IPC real e DTO sem SQL/permissões',async()=>{
  assert.equal(catalogLabWrites({}),false);
  const env={CATALOG_LAB_WRITES:'true',NODE_ENV:'test',MYSQL_HOST:'127.0.0.1',MYSQL_PORT:'3308',MYSQL_DATABASE:'venprox_b05_test'};
  assert.equal(catalogLabWrites(env),true);for(const patch of [{NODE_ENV:'production'},{MYSQL_HOST:'example.invalid'},{MYSQL_DATABASE:'production'},{MYSQL_PORT:'3306'}])assert.throws(()=>catalogLabWrites({...env,...patch}));
  const handler=boundBusinessHandler(1,'file:///app/index.html',async()=>({ok:true})),sender={webContentsId:1,mainFrame:true,frameUrl:'file:///app/index.html#catalog'};
  assert.deepEqual(await handler(sender,{type:'settings.get',request_id:'ipc'}),{ok:true});
  await assert.rejects(handler({...sender,mainFrame:false},{type:'settings.get',request_id:'ipc'}),fails('IPC_ORIGIN_REJECTED'));
  for(const extra of [{store_id:randomUUID()},{user_id:randomUUID()},{sql:'SELECT 1'},{permissions:['catalog.write']}])await assert.rejects(handler(sender,{type:'settings.get',request_id:'ipc',...extra}),fails('INVALID_COMMAND'));
});

test('B05/B06 HTTP real em MySQL isolado: cookies/CSRF, schemas, custo e gate operacional',{skip:!process.env.MYSQL_PASSWORD,timeout:90000},async()=>{
  const f=await fixture('mysql'),store=f.store as MysqlStore,keys=generateAuthKeys(),crypto=createAuthCrypto(keys.privateKey,keys.fingerprintKey),token=crypto.token();
  const service=new AuthService({unitOfWork:authUnitOfWork(store),storeId:f.deps.storeId,crypto,clock:f.deps.clock,ids:f.deps.ids});
  const origin='https://pdv.test',business={catalog:f.catalog,stock:new StockService(f.deps),cash:new CashService(f.deps)};
  const app=buildApi({environment:'development',ids:f.deps.ids,logger:createLogger('business-test','silent'),auth:{service,origin,secureCookies:true,business},getCompatibility:createGetCompatibility(createCompatibilityPolicy('0.1.0',[1]),'0.1.0')});
  const inventory:string[]=[];
  app.addHook('onRoute',(route)=>{if(!/^\/api\/v1\/(categories|products|customers|settings|stock|cash-sessions)(\/|$)/.test(route.url))return;
    for(const method of Array.isArray(route.method)?route.method:[route.method])if(method!=='HEAD')inventory.push(`${method.toLowerCase()} ${route.url.replace(':id','{id}')}`);});
  const ajv=new Ajv({strict:false});(formats as unknown as FormatsPlugin)(ajv);
  type Operation={description?:string;operationId?:string;tags?:string[];security?:unknown[];responses:Record<string,{content:Record<string,{schema:{example?:unknown}}>}>;requestBody?:{content:Record<string,{schema:{example?:unknown}}>}};
  const document=()=>app.swagger() as unknown as {paths:Record<string,Record<string,Operation>>};
  const check=(response:{statusCode:number;json():unknown},path:string,method='get')=>{
    const schema=document().paths[path]![method]!.responses[String(response.statusCode)]!.content['application/json']!.schema;
    assert.ok(ajv.validate(schema,response.json()),JSON.stringify(ajv.errors));
  };
  try{
    await provisionAuth(sqlOptions('venprox_b05_test'),f.deps.storeId,crypto.digest(token),'2026-11-25T13:00:00.000Z',0);
    await service.activate({installation_token:token,store_name:'Laboratório',login:'owner',name:'Dono',password:'Example-only-password-123!'},'test');
    const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{login:'owner',password:'Example-only-password-123!'}});assert.equal(login.statusCode,200);
    const headers={origin,cookie:login.cookies.map((c)=>`${c.name}=${c.value}`).join('; '),'x-csrf-token':login.json().data.csrf_token,'idempotency-key':randomUUID()};
    assert.equal((await app.inject('/api/v1/products')).statusCode,401);
    const input={name:'Café',internal_code:'CAFE',unit:'unit',price_cents:100,cost_cents:null};
    assert.equal((await app.inject({method:'POST',url:'/api/v1/products',headers:{...headers,'x-csrf-token':'wrong'},payload:input})).statusCode,403);
    for(const patch of [{quantity_milli:1000},{store_id:randomUUID()},{price_cents:'100'},{cost_cents:-1}])assert.equal((await app.inject({method:'POST',url:'/api/v1/products',headers,payload:{...input,...patch}})).statusCode,422);
    const created=await app.inject({method:'POST',url:'/api/v1/products',headers,payload:input});assert.equal(created.statusCode,201,created.body);const id=created.json().data.id;
    check(created,'/api/v1/products','post');
    assert.equal((await app.inject({method:'POST',url:'/api/v1/products',headers,payload:input})).json().data.id,id);
    const updated=await app.inject({method:'PATCH',url:`/api/v1/products/${id}`,headers:{...headers,'idempotency-key':randomUUID()},payload:{expected_version:1,price_cents:200}});assert.equal(updated.statusCode,200,updated.body);
    const stale=await app.inject({method:'PATCH',url:`/api/v1/products/${id}`,headers:{...headers,'idempotency-key':randomUUID()},payload:{expected_version:1,price_cents:300}});assert.equal(stale.statusCode,409);assert.equal(stale.json().error.conflict.current_version,2);
    check(updated,'/api/v1/products/{id}','patch');check(stale,'/api/v1/products/{id}','patch');
    const list=await app.inject({url:'/api/v1/products?limit=1&q=cafe',headers});assert.equal(list.statusCode,200,list.body);assert.equal(list.json().meta.scope,'server_received');
    check(list,'/api/v1/products');
    assert.equal((await app.inject({url:'/api/v1/products?limit=101',headers})).statusCode,422);
    const user=await service.createUser(login.cookies.find((c)=>c.name==='venprox_access')!.value,{operation_id:randomUUID(),login:'operator',name:'Operador',password:'Operator-example-123!',role:'operator'});
    const operator=await service.login(user.login,'Operator-example-123!','operator');
    const hidden=await app.inject({url:`/api/v1/products/${id}`,headers:{cookie:`venprox_access=${operator.access}`}});assert.equal(hidden.statusCode,200);assert.equal('cost_cents' in hidden.json().data,false);
    for(const url of ['/api/v1/categories','/api/v1/customers','/api/v1/settings','/api/v1/stock/balances','/api/v1/stock/movements']){const response=await app.inject({url,headers});assert.equal(response.statusCode,200,response.body);check(response,url);}
    assert.equal((await app.inject({method:'POST',url:'/api/v1/stock/set-balance',headers,payload:{}})).statusCode,404);
    const opened=await new CashService({...f.deps,local:true}).open(f.context,randomUUID(),{opening_cents:0,business_date:'2026-11-25',time_zone:'America/Sao_Paulo'});
    for(const path of ['/api/v1/cash-sessions','/api/v1/cash-sessions/{id}','/api/v1/cash-sessions/{id}/movements']){const url=path.replace('{id}',opened.session.id);assert.equal((await app.inject(url)).statusCode,401);const response=await app.inject({url,headers});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().meta.scope,'server_received');check(response,path);}
    for(const url of ['/api/v1/cash-sessions','/api/v1/cash-sessions/open'])assert.equal((await app.inject({method:'POST',url,headers,payload:{}})).statusCode,404);
    business.catalog=new CatalogService({...f.deps,remoteWritesEnabled:false});
    assert.equal((await app.inject({method:'POST',url:'/api/v1/products',headers:{...headers,'idempotency-key':randomUUID()},payload:input})).statusCode,503);
    const spec=document(),registered:string[]=[];const ids=new Set<string>();
    for(const [path,operations] of Object.entries(spec.paths))for(const [method,operation] of Object.entries(operations)){
      assert.ok(operation.operationId);assert.equal(ids.has(operation.operationId),false);ids.add(operation.operationId);
      if(!/^\/api\/v1\/(categories|products|customers|settings|stock|cash-sessions)(\/|$)/.test(path))continue;
      registered.push(`${method} ${path}`);assert.ok(operation.description);assert.ok(operation.tags?.length);assert.deepEqual(operation.security,[{sessionCookie:[]}]);
      for(const response of Object.values(operation.responses)){const schema=response.content['application/json']!.schema;assert.ok(schema.example);assert.ok(ajv.validate(schema,schema.example),JSON.stringify(ajv.errors));}
      if(operation.requestBody){const schema=operation.requestBody.content['application/json']!.schema;assert.ok(schema.example);assert.ok(ajv.validate(schema,schema.example),JSON.stringify(ajv.errors));}
    }assert.equal(registered.length,19);assert.deepEqual(registered.sort(),inventory.sort());
  }finally{await app.close();await f.close();}
});
