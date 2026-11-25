import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Value } from 'typebox/value';
import { createConnection } from 'mysql2/promise';
import { financialFixture, fails } from './financial-fixture.js';
import { CashService } from '../packages/application/src/cash-service.js';
import { CatalogService } from '../packages/application/src/catalog-service.js';
import { StockService } from '../packages/application/src/stock-service.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { sqliteBusinessUnitOfWork } from '../packages/infrastructure/sqlite/src/business.js';
import { businessIpcCommands, BusinessIpcResponse, businessEnvelope } from '../packages/contracts/src/catalog-stock.js';
import { executeBusiness } from '../apps/local-service/src/business.js';
const opening={opening_cents:0,business_date:'2026-11-25',time_zone:'America/Sao_Paulo'};
for(const engine of ['sqlite','mysql'] as const)test(`B07 ${engine}: caixa, intenção, concorrência, permissão e rollback`,{skip:engine==='mysql'&&!process.env.MYSQL_PASSWORD,timeout:90000},async(t)=>{
  const f=await financialFixture(engine,'b07'),{cash,context,deps}=f;
  const send=async(command:unknown)=>{assert.ok(Value.Check(businessIpcCommands,command));const result=await executeBusiness(command as Parameters<typeof executeBusiness>[0],context,new CatalogService(deps),new StockService(deps),cash);assert.ok(Value.Check(BusinessIpcResponse,businessEnvelope(result,'ipc')),JSON.stringify(result));return result;};
  try{
    await t.test('abertura explícita zero, data/fuso, DTO fechado, replay e duas aberturas',async()=>{
      assert.equal((await cash.current(context)).session,null);
      assert.equal(Value.Check(businessIpcCommands,{type:'cash.open',request_id:'ipc',intention_id:randomUUID(),input:{business_date:opening.business_date,time_zone:opening.time_zone}}),false);
      for(const amount of [-1,0.5,Number.MAX_SAFE_INTEGER+1,undefined])await assert.rejects(cash.open(context,randomUUID(),{...opening,opening_cents:amount!}),fails('INVALID_OPENING_AMOUNT'));
      await assert.rejects(cash.open(context,randomUUID(),{...opening,time_zone:'Invalid/Zone'}),fails('INVALID_BUSINESS_DATE'));
      await assert.rejects(cash.open({...context,permissions:[]},randomUUID(),opening),fails('PERMISSION_DENIED'));
      const failedId=randomUUID(),fault=new CashService({...deps,unitOfWork:{run:(work)=>deps.unitOfWork.run((tx)=>work({...tx,outbox:{append:async()=>{throw new ApplicationError('INJECTED_FAILURE','Falha.','unavailable');}}}))}});
      await assert.rejects(fault.open(context,failedId,opening),fails('INJECTED_FAILURE'));assert.equal(await f.count('cash_sessions'),0);assert.equal(await f.count('cash_movements'),0);assert.equal(await f.count('device_sequences'),0);
      const intention=randomUUID(),first=await cash.open(context,intention,opening);assert.equal(first.session.opening_cents,0);assert.equal(first.session.pending_sync,true);
      assert.deepEqual(await cash.open(context,intention,opening),first);await assert.rejects(cash.open(context,intention,{...opening,opening_cents:1}),fails('IDEMPOTENCY_CONFLICT'));
      const tomorrow=new CashService({...deps,clock:{now:()=>new Date('2026-11-26T06:00:00.000Z')}});assert.deepEqual(await tomorrow.open(context,intention,opening),first);
      const concurrent=await Promise.allSettled([cash.open(context,randomUUID(),opening),cash.open(context,randomUUID(),opening)]);assert.equal(concurrent.filter((r)=>r.status==='rejected'&&fails('CASH_ALREADY_OPEN')(r.reason)).length,2);
      for(const command of [{type:'cash.getCurrent',request_id:'ipc'},{type:'cash.listSessions',request_id:'ipc',query:{}},{type:'cash.getSession',request_id:'ipc',id:first.session.id},{type:'cash.getMovements',request_id:'ipc',id:first.session.id,query:{}}])await send(command);
      assert.equal(await f.count('cash_sessions'),1);assert.equal(await f.count('cash_movements'),1);
    });
    await t.test('suprimento/sangria, motivo/permissão, saldo e sessão esperada',async()=>{
      const session=(await cash.current(context)).session!,input={session_id:session.id,amount_cents:100,reason:'Fundo adicional'};
      await assert.rejects(cash.register({...context,permissions:['sales.create']},randomUUID(),'supply',input),fails('PERMISSION_DENIED'));
      await assert.rejects(cash.register(context,randomUUID(),'supply',{...input,reason:'  '}),fails('REASON_REQUIRED'));
      await assert.rejects(cash.register(context,randomUUID(),'withdrawal',input),fails('INSUFFICIENT_CASH'));
      const intention=randomUUID(),supply=await cash.register(context,intention,'supply',input);assert.deepEqual(await cash.register(context,intention,'supply',input),supply);
      const withdrawal=await cash.register(context,randomUUID(),'withdrawal',{...input,amount_cents:40,reason:'Retirada'});assert.deepEqual(withdrawal.session.expected_by_method,{cash:60,credit:0,debit:0,pix:0});
      await assert.rejects(cash.register(context,randomUUID(),'supply',{...input,session_id:randomUUID()}),fails('CASH_SESSION_REQUIRED'));
      const page=await cash.movements(context,session.id,{limit:1});assert.ok(page.next_cursor);assert.notEqual((await cash.movements(context,session.id,{limit:1,after:page.next_cursor!})).items[0]!.id,page.items[0]!.id);
      assert.equal((await cash.movements(context,session.id,{origin_id:intention})).items.length,1);
    });
    await t.test('falha na outbox/auditoria reverte sessão, movimento, sequência e intenção',async()=>{
      const before=await cash.current(context),counts=await Promise.all(['cash_movements','operation_outbox','audit_log','catalog_intentions'].map((table)=>f.count(table)));
      for(const point of ['outbox','audit'] as const){const fault=new CashService({...deps,unitOfWork:{run:(work)=>deps.unitOfWork.run((tx)=>work({...tx,[point]:{append:async()=>{throw new ApplicationError('INJECTED_FAILURE','Falha.','unavailable');}}}))}});
        await assert.rejects(fault.register(context,randomUUID(),'supply',{session_id:before.session!.id,amount_cents:10,reason:'Falha'}),fails('INJECTED_FAILURE'));
        assert.deepEqual(await cash.current(context),before);assert.deepEqual(await Promise.all(['cash_movements','operation_outbox','audit_log','catalog_intentions'].map((table)=>f.count(table))),counts);}
    });
    await t.test('três terminais independentes e constraint protege contra abertura direta duplicada',async()=>{
      if(engine==='mysql'){
        for(let n=0;n<2;n++){const device=randomUUID(),other=new CashService({...deps,deviceId:device}),ctx={...context,device_id:device};const results=await Promise.allSettled([other.open(ctx,randomUUID(),opening),other.open(ctx,randomUUID(),opening)]);assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);const row=(await other.current(ctx)).session!;await assert.rejects(cash.register(context,randomUUID(),'supply',{session_id:row.id,amount_cents:1,reason:'Outro terminal'}),fails('CASH_SESSION_REQUIRED'));}
        assert.equal((await new CashService({...deps,local:false}).list({...context,device_id:null})).items.length,3);
      }else{for(let n=0;n<2;n++){const other=await financialFixture('sqlite','b07');try{await other.cash.open(other.context,randomUUID(),opening);assert.equal((await other.cash.list(other.context)).items.length,1);}finally{await other.close();}}}
      const original=await deps.unitOfWork.run((tx)=>tx.business.currentCash(deps.deviceId));await assert.rejects(deps.unitOfWork.run((tx)=>tx.business.insertCashSession({...original!,id:randomUUID()})));
    });
    await t.test('sessão fechada recusa movimento; reinício recupera abertura e livro sem rede',async()=>{
      const id=(await cash.current(context)).session!.id;
      if(f.store instanceof SqliteStore){const store=f.store;store.database.prepare("UPDATE cash_sessions SET status='closed',open_device=NULL WHERE id=?").run(id);}
      else{const c=await createConnection(f.options);try{await c.query("UPDATE cash_sessions SET status='closed',open_device=NULL WHERE id=?",[id]);}finally{await c.end();}}
      await assert.rejects(cash.register(context,randomUUID(),'supply',{session_id:id,amount_cents:1,reason:'Fechado'}),fails('CASH_SESSION_CLOSED'));
      await assert.rejects(new CashService({...deps,local:false}).open(context,randomUUID(),opening),fails('LOCAL_CASH_ONLY'));
      if(f.store instanceof SqliteStore){const path=f.store.path;await f.store.close();const restarted=SqliteStore.open(path,f.identity);try{const after=new CashService({...deps,unitOfWork:sqliteBusinessUnitOfWork(restarted)});assert.equal((await after.get(context,id)).session.expected_by_method.cash,60);assert.equal((await after.movements(context,id)).items.length,3);}finally{await restarted.close();}}
    });
  }finally{await f.close();}
});
