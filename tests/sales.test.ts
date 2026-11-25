import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConnection } from 'mysql2/promise';
import { Value } from 'typebox/value';
import { financialFixture, fails } from './financial-fixture.js';
import { SalesService } from '../packages/application/src/sales-service.js';
import { CashService } from '../packages/application/src/cash-service.js';
import { CatalogService } from '../packages/application/src/catalog-service.js';
import type { BusinessDependencies, BusinessRepository, BusinessTransaction, Product } from '../packages/application/src/business-ports.js';
import type { DraftInput } from '../packages/application/src/sales-ports.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { PersistenceError } from '../packages/application/src/persistence.js';
import { priceSale, lineSubtotal, validPayments } from '../packages/domain/src/sales.js';
import { rolePermissions } from '../packages/domain/src/authorization.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { sqliteBusinessUnitOfWork } from '../packages/infrastructure/sqlite/src/business.js';
import { mysqlBusinessUnitOfWork } from '../packages/infrastructure/mysql/src/business.js';
import { businessIpcCommands, BusinessIpcResponse, businessEnvelope } from '../packages/contracts/src/catalog-stock.js';
import { SaleCompletedEvent } from '../packages/contracts/src/sales.js';
import { executeBusiness } from '../apps/local-service/src/business.js';
import { mysqlMigrations } from '../migrations/mysql/registry.js';
import { provisionAuth } from '../packages/infrastructure/mysql/src/auth-provision.js';
import { businessHash } from '../packages/infrastructure/persistence/src/business-repository.js';

const empty:DraftInput={items:[],customer_id:null,note:null,discount_cents:0};
const manual=(price=100):DraftInput=>({...empty,items:[{id:randomUUID(),product_id:null,description:'Avulso',price_cents:price,quantity_milli:1000}]});
const payment=(amount=100,method:'cash'|'credit'|'debit'|'pix'='cash')=>({id:randomUUID(),method,applied_cents:amount,tendered_cents:amount,change_cents:0});
test('B08 domínio: arredondamento, maior resto/ID estável, limites e pagamento manual',()=>{
  assert.equal(lineSubtotal(1,500),1);assert.equal(lineSubtotal(1,499),0);assert.equal(lineSubtotal(Number.MAX_SAFE_INTEGER,1000),Number.MAX_SAFE_INTEGER);assert.equal(lineSubtotal(Number.MAX_SAFE_INTEGER,2000),undefined);
  const ids=['550e8400-e29b-41d4-a716-446655440001','550e8400-e29b-41d4-a716-446655440002','550e8400-e29b-41d4-a716-446655440003'];
  const lines=ids.map((id)=>({id,price_cents:1,quantity_milli:1000,item_discount_cents:0}));const priced=priceSale(lines,1);assert.ok(!('error'in priced));assert.deepEqual(priced.lines.map((l)=>l.sale_discount_cents),[1,0,0]);assert.equal(priced.total_cents,2);
  const reverse=priceSale([...lines].reverse(),1);assert.ok(!('error'in reverse));assert.equal(reverse.lines.find((l)=>l.id===ids[0])!.sale_discount_cents,1);
  for(const discount of [3,4,-1,0.1,Number.MAX_SAFE_INTEGER+1])assert.ok('error'in priceSale(lines,discount));
  assert.equal(validPayments([{...payment(100),tendered_cents:200,change_cents:100}],100),true);assert.equal(validPayments([{...payment(100,'pix'),tendered_cents:200,change_cents:100}],100),false);
});
for(const engine of ['sqlite','mysql'] as const)test(`B08 ${engine}: rascunhos e conclusão financeira atômica`,{skip:engine==='mysql'&&!process.env.MYSQL_PASSWORD,timeout:180000},async(t)=>{
  const f=await financialFixture(engine,'b08'),{deps,context,cash,stock,catalog}=f,sales=new SalesService(deps,async()=>'CX01'),operator={...context,permissions:rolePermissions.operator};
  let sessionId='',productId='',saleId='',intention='';
  const send=async(command:unknown)=>{assert.ok(Value.Check(businessIpcCommands,command),JSON.stringify(command));const result=await executeBusiness(command as Parameters<typeof executeBusiness>[0],context,catalog,stock,cash,sales);assert.ok(Value.Check(BusinessIpcResponse,businessEnvelope(result,'ipc')),JSON.stringify(result));return result;};
  const completeInput=(id:string,payments=[payment()])=>({sale_id:id,session_id:sessionId,expected_draft_version:1,expected_settings_version:1,payments});
  try{
    await t.test('rascunho cria/edita/remove por versão; cliente mínimo, observação e permissão',async()=>{
      saleId=randomUUID();const createId=randomUUID(),draft=await sales.createDraft(context,createId,saleId,empty);assert.equal(draft.draft.version,1);assert.deepEqual(await sales.createDraft(context,createId,saleId,empty),draft);assert.equal(await f.count('operation_outbox'),0);
      const created=await catalog.createProduct(context,randomUUID(),{name:'Café',internal_code:'CAFE',unit:'unit',price_cents:100,cost_cents:0}) as Product;productId=created.id;
      const customer=(engine==='sqlite'?await new CatalogService({...deps,local:true}).createCustomer(context,randomUUID(),{name:'Cliente local'},randomUUID()):await catalog.createCustomer(context,randomUUID(),{name:'Cliente confirmado'})) as {proposal?:{id:string};id?:string};
      const customerId=String('proposal' in customer?(customer.proposal as {id:string}).id:customer.id);
      const input:DraftInput={items:[{id:randomUUID(),product_id:productId,expected_product_version:1,quantity_milli:2000}],customer_id:customerId,note:'  Observação\r\nlocal ',discount_cents:1};
      await assert.rejects(sales.updateDraft(operator,randomUUID(),saleId,1,input),fails('PERMISSION_DENIED'));
      const updated=await sales.updateDraft(context,randomUUID(),saleId,1,input);assert.equal(updated.draft.version,2);assert.equal(updated.draft.note,'Observação\nlocal');assert.equal(updated.draft.totals.total_cents,199);
      await assert.rejects(sales.updateDraft(context,randomUUID(),saleId,1,empty),fails('VERSION_CONFLICT'));
      const removed=await sales.updateDraft(context,randomUUID(),saleId,2,empty);assert.equal(removed.draft.items.length,0);
      await send({type:'sales.getDraft',request_id:'ipc',sale_id:saleId});
      for(const input of [{...manual(),discount_cents:100},{...manual(),items:[{...manual().items[0]!,quantity_milli:500}]},manual(0)])await assert.rejects(sales.createDraft(context,randomUUID(),randomUUID(),input));
      const command={type:'sales.createDraft',request_id:'ipc',intention_id:randomUUID(),sale_id:randomUUID(),input:{...empty,items:[{id:randomUUID(),product_id:productId,expected_product_version:1,quantity_milli:1000,price_cents:1}]}};assert.equal(Value.Check(businessIpcCommands,command),false);
    });
    await t.test('sessão/permissão/política/preço e cobertura são revalidados sem efeitos parciais',async()=>{
      const id=randomUUID();await sales.createDraft(context,randomUUID(),id,manual());
      await assert.rejects(sales.complete(context,randomUUID(),completeInput(id)),fails('CASH_SESSION_REQUIRED'));
      sessionId=(await cash.open(context,randomUUID(),{opening_cents:0,business_date:'2026-11-25',time_zone:'America/Sao_Paulo'})).session.id;
      await assert.rejects(sales.complete({...context,permissions:[]},randomUUID(),completeInput(id)),fails('PERMISSION_DENIED'));
      await assert.rejects(sales.complete(context,randomUUID(),{...completeInput(id),expected_settings_version:2}),fails('SALE_POLICY_CHANGED'));
      for(const payments of [[payment(99)],[{...payment(),method:'pix' as const,tendered_cents:200,change_cents:100}],[{...payment(),tendered_cents:99}],[]])await assert.rejects(sales.complete(context,randomUUID(),completeInput(id,payments)),fails('INVALID_PAYMENTS'));
      assert.equal(await f.count('sales'),0);assert.equal((await sales.getDraft(context,id)).draft.status,'draft');
      const productDraft=randomUUID();await sales.createDraft(context,randomUUID(),productDraft,{...empty,items:[{id:randomUUID(),product_id:productId,expected_product_version:1,quantity_milli:1000}]});
      await catalog.updateProduct(context,productId,randomUUID(),1,{price_cents:110});await assert.rejects(sales.complete(context,randomUUID(),completeInput(productDraft,[payment(100)])),fails('SALE_PRICE_CHANGED'));
      await catalog.updateProduct(context,productId,randomUUID(),2,{price_cents:100});
    });
    await t.test('misto/troco, snapshots, estoque permissivo e evento completo com IDs dos efeitos',async()=>{
      saleId=randomUUID();const first=randomUUID(),second=randomUUID(),input:DraftInput={...empty,discount_cents:1,items:[{id:first,product_id:productId,expected_product_version:3,quantity_milli:1000},{id:second,product_id:null,description:' Avulso ',price_cents:100,quantity_milli:1000}]};
      await send({type:'sales.createDraft',request_id:'ipc',sale_id:saleId,intention_id:randomUUID(),input});intention=randomUUID();const payments=[{...payment(99),tendered_cents:200,change_cents:101},payment(100,'pix')];
      const result=await sales.complete(context,intention,completeInput(saleId,payments));assert.ok(result.completion);const sale=result.completion.sale;
      assert.equal(sale.total_cents,199);assert.equal(sale.discount_cents,1);assert.equal(sale.change_cents,101);assert.match(sale.number,/^CX01-[0-9]{6,}$/);assert.equal(sale.items.find((i)=>i.id===first)!.unit_cost_cents,0);assert.equal(sale.items.find((i)=>i.id===second)!.unit_cost_cents,null);
      assert.equal((await deps.unitOfWork.run((tx)=>tx.business.balance(productId))).quantity_milli,-1000);
      assert.deepEqual((await cash.current(context)).session!.expected_by_method,{cash:99,credit:0,debit:0,pix:100});
      const rows=await f.rows('operation_outbox'),event=rows.find((row)=>row.operation_id===intention)!;const payload=JSON.parse(String(event.payload));assert.ok(Value.Check(SaleCompletedEvent,payload),JSON.stringify([...Value.Errors(SaleCompletedEvent,payload)]));assert.equal(payload.stock_movement_ids.length,1);assert.equal(payload.cash_movement_ids.length,2);assert.equal('stock_movements'in payload,false);assert.equal(String(event.device_seq),sale.device_seq);
      assert.ok(BigInt(String(rows.find((row)=>row.event_type==='cash.opened')!.device_seq))<BigInt(sale.device_seq));
      assert.deepEqual(await sales.complete(context,intention,completeInput(saleId,payments)),result);assert.deepEqual(await sales.getCompletionResult(context,intention),result);
      const alias=randomUUID();assert.deepEqual(await sales.complete(context,alias,completeInput(saleId,payments)),result);assert.deepEqual(await sales.getCompletionResult(context,alias),result);
      await assert.rejects(sales.complete(context,intention,completeInput(saleId,[payment(199)])),fails('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(sales.updateDraft(context,randomUUID(),saleId,2,empty),fails('SALE_ALREADY_COMPLETED'));
      const hidden=await sales.getCompletionResult(operator,intention);assert.equal('unit_cost_cents'in hidden.completion!.sale.items[0]!,false);assert.equal('cost_total_cents'in hidden.completion!.sale.items[0]!,false);assert.equal('authorization_context'in hidden.completion!.sale,false);
      await send({type:'sales.getCompletionResult',request_id:'ipc',intention_id:intention});
      await catalog.updateProduct(context,productId,randomUUID(),3,{price_cents:999,cost_cents:333});assert.deepEqual(await sales.getCompletionResult(context,intention),result);
    });
    await t.test('estrito agrega linhas repetidas, recusa avulso, concorrência/replay não duplicam efeitos',async()=>{
      await deps.unitOfWork.run(async(tx)=>{const settings=await tx.business.settings();await tx.business.saveSettings({...settings,stock_policy:'require_stock',version:2});});
      const balance=await deps.unitOfWork.run((tx)=>tx.business.balance(productId));await stock.adjustCount(context,randomUUID(),{product_id:productId,counted_milli:1000,expected_quantity_milli:balance.quantity_milli,expected_version:balance.version,reason:'Contagem'});
      const id=randomUUID(),line=()=>({id:randomUUID(),product_id:productId,expected_product_version:4,quantity_milli:1000});await sales.createDraft(context,randomUUID(),id,{...empty,items:[line(),line()]});
      await assert.rejects(sales.complete(context,randomUUID(),{...completeInput(id,[payment(1998)]),expected_settings_version:2}),fails('INSUFFICIENT_LOCAL_STOCK'));
      const avulso=randomUUID();await sales.createDraft(context,randomUUID(),avulso,manual());await assert.rejects(sales.complete(context,randomUUID(),{...completeInput(avulso),expected_settings_version:2}),fails('PRODUCT_REQUIRED'));
      const single=randomUUID();await sales.createDraft(context,randomUUID(),single,{...empty,items:[line()]});const intent=randomUUID(),input={...completeInput(single,[payment(999,'debit')]),expected_settings_version:2};
      const concurrent=await Promise.all([sales.complete(context,intent,input),sales.complete(context,intent,input)]);assert.deepEqual(concurrent[0],concurrent[1]);assert.equal((await deps.unitOfWork.run((tx)=>tx.business.balance(productId))).quantity_milli,0);
      assert.equal((await stock.movements(context)).items.filter((m)=>m.origin_id===single).length,1);assert.equal((await cash.movements(context,sessionId,{origin_id:single})).items.length,1);
      await deps.unitOfWork.run(async(tx)=>{const settings=await tx.business.settings();await tx.business.saveSettings({...settings,stock_policy:'permissive',version:1});});
    });
    await t.test('injeção depois de cada escrita e antes do commit reverte todo o agregado',async()=>{
      const id=randomUUID(),intent=randomUUID();await sales.createDraft(context,randomUUID(),id,{...empty,items:[{id:randomUUID(),product_id:productId,expected_product_version:4,quantity_milli:1000}]});const input=completeInput(id,[payment(999,'credit')]);
      const tables=['sales','sale_items','sale_payments','stock_movements','stock_balances','cash_movements','cash_sessions','sale_drafts','sale_draft_items','operation_outbox','audit_log','device_sequences','catalog_intentions'];
      const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async(table)=>[table,(await f.rows(table)).map((row)=>JSON.stringify(row)).sort()])));
      const before=await snapshot();let writes=0;
      const failureDeps=(failAt:number,code='INJECTED_FAILURE'):BusinessDependencies=>({...deps,unitOfWork:{run:(work)=>deps.unitOfWork.run(async(tx)=>{
        const after=()=>{if(++writes===failAt)throw code==='SQLITE_FULL'?{code}:new ApplicationError(code,'Falha.','unavailable');};
        const business=new Proxy(tx.business,{get(target,key){const value=target[key as keyof BusinessRepository];if(typeof value!=='function')return value;return async(...args:unknown[])=>{const result=await (value as (...args:unknown[])=>Promise<unknown>).apply(target,args);if(/^(insert|save|replace|append|bump)/.test(String(key)))after();return result;};}});
        const wrap=(port:'sequences'|'outbox'|'audit')=>new Proxy(tx[port],{get(target,key){const fn=Reflect.get(target,key);return async(...args:unknown[])=>{const result=await fn.apply(target,args);after();return result;};}});
        const result=await work({...tx,business,sequences:wrap('sequences'),outbox:wrap('outbox'),audit:wrap('audit')} as BusinessTransaction);after();return result;
      })}});
      for(let failAt=1;;failAt++){
        writes=0;const fault=new SalesService(failureDeps(failAt),async()=>'CX01');
        if(failAt>30)throw new Error('UNEXPECTED_WRITE_COUNT');
        let failed=false;try{await fault.complete(context,intent,input);}catch(error){assert.ok(fails('INJECTED_FAILURE')(error));failed=true;}
        if(!failed){assert.ok(failAt>=12);break;}
        assert.deepEqual(await snapshot(),before,`Falha após escrita ${failAt}`);assert.equal((await sales.getCompletionResult(context,intent)).completion,null);
      }
      assert.ok((await sales.getCompletionResult(context,intent)).completion);
      const fullId=randomUUID();await sales.createDraft(context,randomUUID(),fullId,manual());writes=0;
      await assert.rejects(new SalesService(failureDeps(2,'SQLITE_FULL'),async()=>'CX01').complete(context,randomUUID(),completeInput(fullId)),(e:unknown)=>e instanceof PersistenceError&&e.code==='DATABASE_FULL');assert.equal((await sales.getDraft(context,fullId)).draft.status,'draft');
    });
    await t.test('resposta perdida depois do commit, reabertura/backup e DTO recuperam a mesma venda',async()=>{
      const id=randomUUID(),intent=randomUUID(),input=completeInput(id);await sales.createDraft(context,randomUUID(),id,manual());
      const lost=new SalesService({...deps,unitOfWork:{run:async(work)=>{await deps.unitOfWork.run(work);throw new Error('RESPONSE_LOST_AFTER_COMMIT');}}},async()=>'CX01');await assert.rejects(lost.complete(context,intent,input));const durable=await sales.complete(context,intent,input);assert.deepEqual(await sales.getCompletionResult(context,intent),durable);
      const backup=join(f.directory,engine==='sqlite'?'sales-backup.db':'sales-backup.json');await f.store.backup(backup);
      if(f.store instanceof MysqlStore){const options={...f.options,database:'venprox_b08_restore_test'},c=await createConnection(options),tables=[...new Set(mysqlMigrations.flatMap((m)=>m.steps).filter((s)=>s.sql.startsWith('CREATE TABLE')).map((s)=>s.table))].reverse();
        const clear=async()=>{assert.equal(options.database,'venprox_b08_restore_test');for(const table of [...tables,'schema_migrations'])await c.query(`DROP TABLE IF EXISTS ${table}`);};
        await clear();const restored=await MysqlStore.connect(options,{store_id:f.identity.store_id});try{await restored.migrate();await restored.restore(backup);const copy=new SalesService({...deps,unitOfWork:mysqlBusinessUnitOfWork(restored)},async()=>'CX01');assert.deepEqual(await copy.getCompletionResult(context,intent),durable);assert.deepEqual((await new CashService({...deps,unitOfWork:mysqlBusinessUnitOfWork(restored)}).current(context)).session!.expected_by_method,(await cash.current(context)).session!.expected_by_method);}finally{await restored.close();await clear();await c.end();}}
      if(f.store instanceof SqliteStore){const restoredPath=join(f.directory,'restored.db');await copyFile(backup,restoredPath);const restored=SqliteStore.open(restoredPath,f.identity);try{const restarted=new SalesService({...deps,unitOfWork:sqliteBusinessUnitOfWork(restored)},async()=>'CX01');assert.deepEqual(await restarted.getCompletionResult(context,intent),durable);assert.equal((await new CashService({...deps,unitOfWork:sqliteBusinessUnitOfWork(restored)}).current(context)).session!.id,sessionId);}finally{await restored.close();}
        const path=f.store.path;await f.store.close();const reopened=SqliteStore.open(path,f.identity);try{assert.deepEqual(await new SalesService({...deps,unitOfWork:sqliteBusinessUnitOfWork(reopened)},async()=>'CX01').complete(context,intent,input),durable);}finally{await reopened.close();}}
    });
  }finally{await f.close();}
});

test('B08 SQLite: falta real de páginas não confirma venda',async()=>{
  const f=await financialFixture('sqlite','b08'),sales=new SalesService(f.deps,async()=>'CX01');assert.ok(f.store instanceof SqliteStore);
  try{const session=(await f.cash.open(f.context,randomUUID(),{opening_cents:0,business_date:'2026-11-25',time_zone:'America/Sao_Paulo'})).session,id=randomUUID();
    await sales.createDraft(f.context,randomUUID(),id,{...empty,items:Array.from({length:50},()=>({id:randomUUID(),product_id:null,description:'Produto avulso de teste '.repeat(4),price_cents:100,quantity_milli:1000}))});
    const pages=Number(f.store.database.pragma('page_count',{simple:true}));f.store.database.pragma(`max_page_count=${pages}`);
    await assert.rejects(sales.complete(f.context,randomUUID(),{sale_id:id,session_id:session.id,expected_draft_version:1,expected_settings_version:1,payments:[payment(5000)]}),(error:unknown)=>error instanceof PersistenceError&&error.code==='DATABASE_FULL');
    f.store.database.pragma('max_page_count=1073741823');assert.equal(await f.count('sales'),0);assert.equal((await sales.getDraft(f.context,id)).draft.status,'draft');assert.equal((await f.cash.current(f.context)).session!.expected_by_method.cash,0);
  }finally{await f.close();}
});

test('B08 migração 7→8 MySQL: permissão administrativa, falha/checkpoint atômico e credenciais preservadas',{skip:!process.env.MYSQL_PASSWORD,timeout:90000},async()=>{
  const f=await financialFixture('mysql','b08',7),c=await createConnection(f.options),userId=randomUUID();
  try{
    await provisionAuth(f.options,f.identity.store_id,businessHash('fixture-setup'), '2026-11-26T12:00:00.000Z',0);
    await c.query("UPDATE auth_roles SET permissions=? WHERE role='admin'",[JSON.stringify(rolePermissions.admin.filter((p)=>p!=='sales.discount'))]);
    await c.query("INSERT INTO auth_users VALUES(?,?,?,'Dono anterior',?,'admin',1,1,1)",[userId,f.identity.store_id,'prior-owner','prior-password-hash-preserved']);
    await assert.rejects(f.store.migrate(mysqlMigrations,(version,step)=>{if(version===8&&step===6)throw new Error('INTERRUPTED_PERMISSION_UPDATE');}));
    assert.equal(Number((await f.rows('auth_users'))[0]!.permissions_version),1);
    await f.store.migrate();await f.store.migrate();const users=await f.rows('auth_users'),roles=await f.rows('auth_roles');
    assert.equal(users[0]!.id,userId);assert.equal(users[0]!.password_hash,'prior-password-hash-preserved');assert.equal(Number(users[0]!.permissions_version),2);assert.equal(Number(users[0]!.version),1);
    const admin=roles.find((row)=>row.role==='admin')!,operator=roles.find((row)=>row.role==='operator')!;
    assert.equal(Number(admin.version),2);assert.ok(JSON.parse(String(admin.permissions)).includes('sales.discount'));assert.equal(JSON.parse(String(operator.permissions)).includes('sales.discount'),false);
  }finally{await c.end();await f.close();}
});
