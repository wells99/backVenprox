import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Value } from 'typebox/value';
import { financialFixture, fails } from './financial-fixture.js';
import { everyWriteRollback } from './transaction-faults.js';
import { SalesService } from '../packages/application/src/sales-service.js';
import { ClosureService } from '../packages/application/src/closure-service.js';
import { ReversalService } from '../packages/application/src/reversal-service.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { sqliteBusinessUnitOfWork } from '../packages/infrastructure/sqlite/src/business.js';
import { CashClosedEvent, SaleReversedEvent } from '../packages/contracts/src/reversals.js';
import { BusinessIpcResponse, businessEnvelope } from '../packages/contracts/src/catalog-stock.js';
import { executeBusiness } from '../apps/local-service/src/business.js';
const opening={opening_cents:0,business_date:'2026-11-25',time_zone:'America/Sao_Paulo'};
for(const engine of ['sqlite','mysql'] as const)test(`B09 ${engine}: restituição integral e fechamento imutável`,{skip:engine==='mysql'&&!process.env.MYSQL_PASSWORD,timeout:180000},async(t)=>{
  const f=await financialFixture(engine,'b09'),{deps,context,cash,stock,catalog}=f,sales=new SalesService(deps,async()=>'CX01'),closure=new ClosureService(deps),reversal=new ReversalService(deps);
  let sessionId='',saleId='',productId='';
  const createSale=async()=>{const id=randomUUID();await sales.createDraft(context,randomUUID(),id,{customer_id:null,note:null,discount_cents:0,items:[{id:randomUUID(),product_id:productId,expected_product_version:1,quantity_milli:1000},{id:randomUUID(),product_id:null,description:'Avulso',price_cents:100,quantity_milli:1000}]});await sales.complete(context,randomUUID(),{sale_id:id,session_id:sessionId,expected_draft_version:1,expected_settings_version:1,payments:[{id:randomUUID(),method:'cash',applied_cents:100,tendered_cents:200,change_cents:100},{id:randomUUID(),method:'pix',applied_cents:100,tendered_cents:100,change_cents:0}]});return id;};
  const refunds=()=>[{id:randomUUID(),method:'cash' as const,amount_cents:100},{id:randomUUID(),method:'pix' as const,amount_cents:100}];
  const closeInput=async()=>{const {preview}=await closure.preview(context,sessionId);return {session_id:sessionId,expected_version:preview.session_version,expected_device_seq:preview.previous_device_seq,counted_by_method:preview.expected_by_method,reason:null};};
  const snapshot=async()=>Object.fromEntries(await Promise.all(['sales','sale_items','sale_payments','sale_reversals','reversal_items','refund_payments','cash_closures','cash_sessions','cash_movements','stock_movements','stock_balances','device_sequences','operation_outbox','audit_log','catalog_intentions'].map(async(table)=>[table,(await f.rows(table)).map((row)=>JSON.stringify(row)).sort()])));
  const send=async(command:Parameters<typeof executeBusiness>[0])=>{const result=await executeBusiness(command,context,catalog,stock,cash,sales,reversal,closure);assert.ok(Value.Check(BusinessIpcResponse,businessEnvelope(result,'ipc')),JSON.stringify(result));return result;};
  try{
    sessionId=(await cash.open(context,randomUUID(),opening)).session.id;productId=String((await catalog.createProduct(context,randomUUID(),{name:'Produto',internal_code:'B09',unit:'unit',price_cents:100,cost_cents:null}) as {id:string}).id);saleId=await createSale();
    await t.test('permissão, motivo, sessão do terminal e limite integral sem efeitos parciais',async()=>{
      const input={sale_id:saleId,session_id:sessionId,reason:'Cancelamento',payments:refunds()},before=await snapshot();
      await assert.rejects(reversal.reverse({...context,permissions:['sales.read']},randomUUID(),input),fails('PERMISSION_DENIED'));
      await assert.rejects(reversal.reverse(context,randomUUID(),{...input,reason:' '}),fails('REASON_REQUIRED'));
      await assert.rejects(reversal.reverse(context,randomUUID(),{...input,session_id:randomUUID()}),fails('CASH_SESSION_REQUIRED'));
      await assert.rejects(reversal.reverse(context,randomUUID(),{...input,payments:[{id:randomUUID(),method:'cash',amount_cents:201}]}),fails('REFUND_EXCEEDS_REMAINING'));
      await assert.rejects(reversal.reverse(context,randomUUID(),{...input,payments:[{id:randomUUID(),method:'cash',amount_cents:199}]}),fails('FULL_REFUND_REQUIRED'));
      await assert.rejects(reversal.reverse({...context,device_id:randomUUID()},randomUUID(),input),fails('SCOPE_MISMATCH'));assert.deepEqual(await snapshot(),before);
    });
    let firstClosure:Awaited<ReturnType<ClosureService['close']>>;
    await t.test('prévia obsoleta, diferença com motivo, concorrência e sessão fechada recusam escrita',async()=>{
      const stale=await closeInput();await cash.register(context,randomUUID(),'supply',{session_id:sessionId,amount_cents:1,reason:'Suprimento'});
      await assert.rejects(closure.close(context,randomUUID(),stale),fails('CLOSURE_STALE'));const input=await closeInput();
      await assert.rejects(closure.close(context,randomUUID(),{...input,counted_by_method:{...input.counted_by_method,cash:100}}),fails('REASON_REQUIRED'));
      const intent=randomUUID(),pair=await Promise.all([closure.close(context,intent,input),closure.close(context,intent,input)]);assert.deepEqual(pair[0],pair[1]);firstClosure=pair[0]!;
      assert.equal(firstClosure.closure.state,'closed_local');assert.equal(firstClosure.closure.reconciliation,'pending');
      await assert.rejects(closure.close(context,randomUUID(),input),fails('CASH_SESSION_CLOSED'));await assert.rejects(cash.register(context,randomUUID(),'supply',{session_id:sessionId,amount_cents:1,reason:'Fechado'}),fails('CASH_SESSION_CLOSED'));
      await assert.rejects(reversal.reverse(context,randomUUID(),{sale_id:saleId,session_id:sessionId,reason:'Caixa fechado',payments:refunds()}),fails('CASH_SESSION_CLOSED'));
      await send({type:'cash.getClosure',request_id:'ipc',session_id:sessionId});
    });
    await t.test('restituição na nova sessão preserva fechamento anterior; replay/concorrência restauram uma vez',async()=>{
      const previousSession=sessionId;sessionId=(await cash.open(context,randomUUID(),opening)).session.id;assert.notEqual(previousSession,sessionId);
      const intent=randomUUID(),input={sale_id:saleId,session_id:sessionId,reason:'Restituição após fechamento',payments:refunds()},pair=await Promise.all([reversal.reverse(context,intent,input),reversal.reverse(context,intent,input)]);assert.deepEqual(pair[0],pair[1]);assert.equal((await deps.unitOfWork.run((tx)=>tx.business.balance(productId))).quantity_milli,0);
      assert.equal(pair[0].items.filter((i)=>i.stock_movement_id!==null).length,1);assert.equal((await f.rows('stock_movements')).filter((row)=>row.kind==='reversal').length,1);
      assert.deepEqual((await cash.current(context)).session!.expected_by_method,{cash:-100,pix:-100,credit:0,debit:0});assert.deepEqual(await closure.get(context,previousSession),firstClosure!);
      await assert.rejects(reversal.reverse(context,randomUUID(),input),fails('ALREADY_REVERSED'));await assert.rejects(reversal.reverse(context,intent,{...input,reason:'Outro conteúdo'}),fails('IDEMPOTENCY_CONFLICT'));
      const response=await send({type:'sales.reverse',request_id:'ipc',intention_id:intent,input});assert.ok(response);
      for(const row of await f.rows('operation_outbox')){if(row.event_type==='sale.reversed')assert.ok(Value.Check(SaleReversedEvent,JSON.parse(String(row.payload))));if(row.event_type==='cash.closed')assert.ok(Value.Check(CashClosedEvent,JSON.parse(String(row.payload))));}
    });
    await t.test('falha após cada escrita da reversão e fechamento reverte livro/caixa/seq/outbox/auditoria',async()=>{
      const id=await createSale(),intent=randomUUID(),input={sale_id:id,session_id:sessionId,reason:'Teste atômico',payments:refunds()};
      await everyWriteRollback(deps,snapshot,(fault)=>new ReversalService(fault).reverse(context,intent,input));
      const preview=await closeInput(),close={...preview,counted_by_method:{cash:0,credit:0,debit:0,pix:0},reason:'Conferência com diferença'};
      await everyWriteRollback(deps,snapshot,(fault)=>new ClosureService(fault).close(context,randomUUID(),close));
    });
    await t.test('caixa zero após nova abertura, resposta perdida e backup/reinício mantêm fechamento',async()=>{
      sessionId=(await cash.open(context,randomUUID(),opening)).session.id;const input=await closeInput(),intent=randomUUID();
      const lost=new ClosureService({...deps,unitOfWork:{run:async(work)=>{await deps.unitOfWork.run(work);throw new Error('RESPONSE_LOST');}}});await assert.rejects(lost.close(context,intent,input));const durable=await closure.close(context,intent,input);assert.equal(durable.closure.expected_by_method.cash,0);
      const backup=join(f.directory,engine==='sqlite'?'backup.db':'backup.json');await f.store.backup(backup);
      if(f.store instanceof SqliteStore){const path=join(f.directory,'copy.db');await copyFile(backup,path);const copy=SqliteStore.open(path,f.identity);try{assert.deepEqual(await new ClosureService({...deps,unitOfWork:sqliteBusinessUnitOfWork(copy)}).get(context,sessionId),durable);}finally{await copy.close();}}
    });
  }finally{await f.close();}
});
