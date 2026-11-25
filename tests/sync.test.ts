import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Value } from 'typebox/value';
import { syncFixture } from './sync-fixture.js';
import { fails } from './financial-fixture.js';
import { SyncService } from '../packages/application/src/sync-service.js';
import type { SyncDependencies, SyncTransaction } from '../packages/application/src/sync-ports.js';
import type { BusinessRepository } from '../packages/application/src/business-ports.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { canonicalJson } from '../packages/domain/src/sync.js';
import { syncEnvelopeHash, syncHashValue } from '../packages/infrastructure/security/src/sync-validation.js';
import { syncLabWrites } from '../packages/infrastructure/runtime/src/sync-config.js';
import { SyncBatch, PushResponse } from '../packages/contracts/src/sync.js';
import { createConnection } from 'mysql2/promise';
import { buildApi } from '../apps/api/src/app.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { Ajv } from 'ajv';
import formats, { type FormatsPlugin } from 'ajv-formats';

test('B10 canonicalização v1 e gate: vetores Unicode, ordem, inteiros e ambiente isolado',()=>{
  const value={b:'ação',a:[1,'9007199254740993',null]};assert.equal(canonicalJson(value),'{"a":[1,"9007199254740993",null],"b":"ação"}');assert.equal(syncHashValue(value),'5245b105100eb18666ab5ce3bd3dfe73637c360edf647eda42e7b03af2895c7f');assert.equal(syncHashValue(value),syncHashValue({a:value.a,b:value.b}));assert.notEqual(syncHashValue('é'),syncHashValue('e\u0301'));
  for(const number of [0.5,-0,NaN,Infinity,9007199254740992])assert.throws(()=>canonicalJson(number));assert.equal(syncLabWrites({}),false);const env={SYNC_LAB_WRITES:'true',NODE_ENV:'test',MYSQL_HOST:'127.0.0.1',MYSQL_PORT:'3308',MYSQL_DATABASE:'venprox_b10_test'};assert.equal(syncLabWrites(env),true);for(const patch of [{NODE_ENV:'production'},{MYSQL_HOST:'example.invalid'},{MYSQL_DATABASE:'venprox_b03'}])assert.throws(()=>syncLabWrites({...env,...patch}));
});
test('B10 MySQL real: recepção histórica, recibos, quarentena, ordem e atomicidade',{skip:!process.env.MYSQL_PASSWORD,timeout:240000},async(t)=>{
  const f=await syncFixture(),{sync,deps,device,events}=f;
  const tables=['server_inbox','server_device_state','server_sync_incidents','server_publication_probes','server_catalog_proposals','server_session_frontiers','server_cash_reconciliations','sales','sale_items','sale_payments','sale_reversals','reversal_items','refund_payments','cash_closures','cash_sessions','cash_movements','stock_movements','stock_balances','audit_log'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async(table)=>[table,(await f.rows(table)).map((row)=>JSON.stringify(row)).sort()])));
  const openingFor=(dev:{id:string;credential:string},sequence='1')=>{
    const event=f.clone(events.find((e)=>e.type==='cash.opened')!,{device_id:dev.id,device_seq:sequence,operation_id:randomUUID()});event.origin_authorization.context.device_id=dev.id;
    const p=event.payload as {session:{id:string;device_id:string};movement:{id:string;session_id:string;device_id:string;operation_id:string;origin_id:string;component_id:string}};p.session.id=randomUUID();p.session.device_id=dev.id;p.movement={...p.movement,id:randomUUID(),session_id:p.session.id,device_id:dev.id,operation_id:event.operation_id,origin_id:p.session.id,component_id:p.session.id};event.payload_hash=syncEnvelopeHash(event);return event;
  };
  try{
    await t.test('credencial restrita, escopo/limites e gate operacional sem efeitos',async()=>{
      await assert.rejects(sync.push('invalid',events),fails('DEVICE_AUTHENTICATION_REQUIRED'));
      await assert.rejects(new SyncService({...deps,writesEnabled:false}).push(device.credential,events),fails('SYNC_PUBLICATION_REQUIRED'));
      await assert.rejects(sync.push(device.credential,[f.clone(events[0]!,{store_id:randomUUID()})]),fails('SCOPE_MISMATCH'));
      await assert.rejects(sync.push(device.credential,Array.from({length:51},()=>events[0]!)),fails('SYNC_BATCH_LIMIT'));
      await assert.rejects(sync.push(device.credential,[f.clone(events[0]!,{device_seq:'9223372036854775808'})]),fails('INVALID_DEVICE_SEQUENCE'));
      assert.ok(Value.Check(SyncBatch,{items:events}));assert.equal(await f.count('server_inbox'),0);assert.equal((await sync.deviceState(device.credential)).local_pending,'unknown');
    });
    await t.test('entry, abertura, falhas após cada escrita e antes de commit não deixam recibo/efeito parcial',async()=>{
      assert.equal((await sync.push(device.credential,[events[0]!])).items[0]!.status,'applied');const event=events[1]!,before=await snapshot();let failedWrites=0;
      for(let failAt=1;failAt<40;failAt++){
        let writes=0;const fault:SyncDependencies={...deps,unitOfWork:{run:(work)=>deps.unitOfWork.run(async(tx)=>{
          const after=()=>{if(++writes===failAt)throw new ApplicationError('INJECTED_FAILURE','Falha.','unavailable');};
          const business=new Proxy(tx.business,{get(target,key){const fn=target[key as keyof BusinessRepository];return typeof fn==='function'?async(...args:unknown[])=>{const result=await (fn as (...args:unknown[])=>Promise<unknown>).apply(target,args);if(/^(insert|save|append|bump|close)/.test(String(key)))after();return result;}:fn;}});
          const syncPort=new Proxy(tx.sync,{get(target,key){const fn=Reflect.get(target,key);return async(...args:unknown[])=>{const result=await fn.apply(target,args);if(/^(insert|finish|advance|stage|set|record|reconcile)/.test(String(key)))after();return result;};}});
          const result=await work({...tx,business,sync:syncPort,audit:{append:async(event)=>{await tx.audit.append(event);after();}}} as SyncTransaction);after();return result;
        })}};
        try{const result=await new SyncService(fault).push(device.credential,[event]);assert.equal(result.items[0]!.status,'applied');assert.ok(failedWrites>=8);break;}catch(error){assert.ok(fails('INJECTED_FAILURE')(error));failedWrites++;assert.deepEqual(await snapshot(),before);}
      }
      assert.equal((await sync.deviceState(device.credential)).received_seq,'2');
    });
    await t.test('venda histórica não usa preço/estado/política/estoque atual; resposta perdida e 100 reenvios',async()=>{
      await f.businessDeps.unitOfWork.run(async(tx)=>{await tx.business.saveProduct({...f.product,price_cents:900,cost_cents:800,active:false,version:2});await tx.business.saveBalance({store_id:f.identity.store_id,product_id:f.product.id,quantity_milli:0,version:99});});
      const event=events[2]!,before=await snapshot();
      for(const point of ['after_sale','after_receipt','after_commit'] as const){
        const child=fork(resolve('scripts/sync-crash-probe.ts'),[],{execArgv:['--import','tsx'],env:{...process.env,MYSQL_DATABASE:'venprox_b10_test',STORE_ID:f.identity.store_id},stdio:['ignore','ignore','ignore','ipc']});
        try{assert.equal((await once(child,'message',{signal:AbortSignal.timeout(15000)}))[0].type,'ready');const paused=once(child,'message',{signal:AbortSignal.timeout(20000)});child.send({point,credential:device.credential,event});assert.deepEqual((await paused)[0],{type:'paused',point});const exited=once(child,'exit');child.kill();await exited;}finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
        if(point!=='after_commit')assert.deepEqual(await snapshot(),before);
      }
      const first=await sync.getReceipt(device.credential,event.operation_id);assert.equal(first.status,'applied');assert.ok(Value.Check(PushResponse,{data:{items:[first]},meta:{request_id:'sync-test'}}));
      for(let batch=0;batch<10;batch++){const repeats=await Promise.all(Array.from({length:10},()=>sync.push(device.credential,[event])));for(const repeat of repeats){assert.equal(repeat.items[0]!.status,'duplicate');assert.deepEqual(repeat.items[0]!.result,first.result);}}
      assert.equal(await f.count('sales'),1);assert.equal(await f.count('sale_items'),1);assert.equal(await f.count('sale_payments'),1);assert.equal((await f.businessDeps.unitOfWork.run((tx)=>tx.business.balance(f.product.id))).quantity_milli,-1000);
      assert.equal((await f.businessDeps.unitOfWork.run((tx)=>tx.business.sale(f.saleId)))!.sale.total_cents,100);assert.deepEqual(await sync.getReceipt(device.credential,event.operation_id),first);
    });
    await t.test('avulso, caixa, fechamento, restituição em nova sessão, propostas e eventos sem delta duplicado',async()=>{
      const result=await sync.push(device.credential,events.slice(3));assert.ok(result.items.every((r)=>r.status==='applied'),JSON.stringify(result));assert.equal((await sync.deviceState(device.credential)).received_seq,String(events.length));
      assert.equal(await f.count('sales'),2);assert.equal(await f.count('sale_reversals'),1);assert.equal(await f.count('server_cash_reconciliations'),2);assert.equal(await f.count('server_catalog_proposals'),3);assert.equal(await f.count('customers'),1);assert.equal(await f.count('server_publication_probes'),events.length);assert.equal(await f.count('operation_outbox'),0);
      assert.equal((await f.businessDeps.unitOfWork.run((tx)=>tx.business.balance(f.product.id))).quantity_milli,0);assert.deepEqual(await f.businessDeps.unitOfWork.run((tx)=>tx.business.cashTotals(f.sessionId)),{cash:110,pix:50,credit:0,debit:0});assert.deepEqual(await f.businessDeps.unitOfWork.run((tx)=>tx.business.cashTotals(f.nextSessionId)),{cash:0,pix:-100,credit:0,debit:0});
    });
    await t.test('mesmo ID/conteúdo divergente e sequência colidente preservam recibo original e incidente',async()=>{
      const original=await sync.getReceipt(device.credential,events[2]!.operation_id),bad=f.clone(events[2]!);(bad.payload as {sale:{note:string|null}}).sale.note='Conteúdo alterado';bad.payload_hash=syncEnvelopeHash(bad);assert.equal((await sync.push(device.credential,[bad])).items[0]!.code,'OPERATION_CONTENT_CONFLICT');
      const collision=f.clone(events[2]!,{operation_id:randomUUID()});assert.equal((await sync.push(device.credential,[collision])).items[0]!.code,'DEVICE_SEQUENCE_CONFLICT');assert.deepEqual(await sync.getReceipt(device.credential,events[2]!.operation_id),original);assert.equal(await f.count('server_sync_incidents'),2);
    });
    await t.test('hash/protocolo/origem ambígua e dependência/seq faltante ficam duráveis sem avançar',async()=>{
      for(const [mode,code] of [['hash','PAYLOAD_HASH_MISMATCH'],['protocol','UNSUPPORTED_PROTOCOL_OR_PAYLOAD'],['authorization','ORIGIN_AUTHORIZATION_UNPROVEN'],['dependency','DEPENDENCY_MISSING'],['sequence','SEQUENCE_GAP']] as const){
        const dev=await f.newDevice(),event=openingFor(dev,mode==='sequence'?'9007199254740993':'1');if(mode==='protocol')event.protocol_version=0;if(mode==='authorization')event.origin_authorization.context.authorization_id=randomUUID();if(mode==='dependency')event.dependencies=[randomUUID()];event.payload_hash=syncEnvelopeHash(event);if(mode==='hash')event.payload_hash='0'.repeat(64);
        const result=(await sync.push(dev.credential,[event])).items[0]!;assert.equal(result.code,code);assert.equal((await sync.deviceState(dev.credential)).received_seq,'0');assert.deepEqual(await sync.getReceipt(dev.credential,event.operation_id),result);assert.deepEqual((await sync.push(dev.credential,[event])).items[0],result);
      }
      const dev=await f.newDevice(),first=openingFor(dev);first.protocol_version=0;first.payload_hash=syncEnvelopeHash(first);const second=f.clone(first,{operation_id:randomUUID(),device_seq:'2',protocol_version:1});const result=await sync.push(dev.credential,[first,second]);assert.equal(result.items[1]!.code,'PREVIOUS_OPERATION_BLOCKED');await assert.rejects(sync.getReceipt(dev.credential,second.operation_id),fails('RECEIPT_NOT_FOUND'));
    });
    await t.test('cliente mínimo mantém sales.create do operador e origem offline exige assinatura histórica',async()=>{
      await f.auth.createUser(f.login.access,{operation_id:randomUUID(),login:'operator',name:'Operador',password:'Operator-sync-example-123!',role:'operator'});const login=await f.auth.login('operator','Operator-sync-example-123!','operator-test'),dev=await f.newDevice();
      const event=f.clone(events.find((e)=>e.type==='customers.proposal.v1')!,{operation_id:randomUUID(),device_id:dev.id,device_seq:'1'});event.origin_authorization.context={...login.context,device_id:dev.id};const p=event.payload as {entity_id:string;proposal:{id:string}};p.entity_id=randomUUID();p.proposal.id=p.entity_id;event.payload_hash=syncEnvelopeHash(event);assert.equal((await sync.push(dev.credential,[event])).items[0]!.status,'applied');
      const signedDevice=await f.newDevice(),offline=openingFor(signedDevice),c={...offline.origin_authorization.context,authorization_id:randomUUID(),authorization_origin:'offline' as const};offline.origin_authorization={context:c,signature:f.crypto.signGrant(c)};offline.payload_hash=syncEnvelopeHash(offline);
      const db=await createConnection(f.options);try{await db.query('INSERT INTO auth_grants VALUES(?,?,?,?,?,?,?,NULL)',[c.authorization_id,c.store_id,c.user_id,c.device_id,c.authorized_at,c.expires_at,c.permissions_version]);}finally{await db.end();}
      assert.equal((await sync.push(signedDevice.credential,[offline])).items[0]!.status,'applied');
      const invalidDevice=await f.newDevice(),invalid=openingFor(invalidDevice);invalid.origin_authorization.context.authorization_origin='offline';invalid.origin_authorization.signature='invalid-signature'.repeat(3);invalid.payload_hash=syncEnvelopeHash(invalid);assert.equal((await sync.push(invalidDevice.credential,[invalid])).items[0]!.code,'ORIGIN_SIGNATURE_INVALID');
      const textDevice=await f.newDevice(),invalidCustomer=f.clone(events.find((e)=>e.type==='customers.proposal.v1')!,{operation_id:randomUUID(),device_id:textDevice.id,device_seq:'1'});invalidCustomer.origin_authorization.context.device_id=textDevice.id;const text=invalidCustomer.payload as {entity_id:string;proposal:{id:string;phone:string|null}};text.entity_id=randomUUID();text.proposal.id=text.entity_id;text.proposal.phone='1'.repeat(41);invalidCustomer.payload_hash=syncEnvelopeHash(invalidCustomer);const beforeCustomers=await f.count('customers');assert.equal((await sync.push(textDevice.credential,[invalidCustomer])).items[0]!.code,'INVALID_HISTORICAL_CUSTOMER');assert.equal(await f.count('customers'),beforeCustomers);
      assert.equal(Number((await f.rows('auth_installation'))[0]!.offline_ttl_seconds),0);
    });
    await t.test('HTTP/OpenAPI: três rotas, schemas/exemplos reais, credencial, lote maior que 64 KiB e gate',async()=>{
      let target=sync;const service={push:(...args:Parameters<SyncService['push']>)=>target.push(...args),getReceipt:(...args:Parameters<SyncService['getReceipt']>)=>target.getReceipt(...args),deviceState:(...args:Parameters<SyncService['deviceState']>)=>target.deviceState(...args)};
      const app=buildApi({environment:'development',logger:createLogger('sync-http-test','silent'),ids:f.businessDeps.ids,auth:{service:f.auth,origin:'https://sync.test',secureCookies:true,sync:service},getCompatibility:createGetCompatibility(createCompatibilityPolicy('0.1.0',[1]),'0.1.0')});
      const inventory:string[]=[];app.addHook('onRoute',(route)=>{if(route.url.startsWith('/api/v1/sync/')&&route.method!=='HEAD')inventory.push(`${String(route.method).toLowerCase()} ${route.url.replace(':operation_id','{operation_id}')}`);});
      const headers={'x-device-credential':device.credential},ajv=new Ajv({strict:false});(formats as unknown as FormatsPlugin)(ajv);
      try{
        await app.ready();const spec=app.swagger() as unknown as {paths:Record<string,Record<string,{operationId:string;security:unknown[];responses:Record<string,{content:Record<string,{schema:object&{example?:unknown}}>}>;requestBody?:{content:Record<string,{schema:object&{example?:unknown}}>}}>>};const documented:string[]=[];
        for(const [path,methods] of Object.entries(spec.paths))if(path.startsWith('/api/v1/sync/'))for(const [method,op] of Object.entries(methods)){documented.push(`${method} ${path}`);assert.deepEqual(op.security,[{deviceCredential:[]}]);for(const response of Object.values(op.responses)){const schema=response.content['application/json']!.schema;assert.ok(schema.example);assert.ok(ajv.validate(schema,schema.example),JSON.stringify(ajv.errors));}if(op.requestBody){const schema=op.requestBody.content['application/json']!.schema;assert.ok(ajv.validate(schema,schema.example),JSON.stringify(ajv.errors));}}
        assert.equal(documented.length,3);assert.deepEqual(documented.sort(),inventory.sort());
        assert.equal((await app.inject({url:'/api/v1/sync/device-state',headers:{'x-device-credential':'x'.repeat(43)}})).statusCode,401);
        for(const url of ['/api/v1/sync/device-state',`/api/v1/sync/receipts/${events[2]!.operation_id}`]){const response=await app.inject({url,headers});assert.equal(response.statusCode,200,response.body);}
        const batch={items:Array.from({length:50},()=>events[2]!)};assert.ok(Buffer.byteLength(JSON.stringify(batch))>65536);const response=await app.inject({method:'POST',url:'/api/v1/sync/push',headers,payload:batch});assert.equal(response.statusCode,200,response.body);assert.ok(response.json().data.items.every((r:{status:string})=>r.status==='duplicate'));assert.ok(ajv.validate(spec.paths['/api/v1/sync/push']!.post!.responses['200']!.content['application/json']!.schema,response.json()));
        for(const payload of [{items:events,sql:'SELECT 1'},{items:Array.from({length:51},()=>events[0]!)},{items:[{...events[0]!,device_seq:1}]}])assert.equal((await app.inject({method:'POST',url:'/api/v1/sync/push',headers,payload})).statusCode,422);
        assert.equal((await app.inject({method:'POST',url:'/api/v1/sync/push',headers,payload:{items:[{...events[0]!,payload:{large:'x'.repeat(600000)}}]}})).statusCode,413);
        target=new SyncService({...deps,writesEnabled:false});const blocked=await app.inject({method:'POST',url:'/api/v1/sync/push',headers,payload:{items:[events[0]!]}});assert.equal(blocked.statusCode,503);assert.equal(blocked.json().error.code,'SYNC_PUBLICATION_REQUIRED');
      }finally{await app.close();}
    });
    await t.test('origem expirada hoje é aceita somente na janela original; logout posterior não apaga fato histórico',async()=>{
      const dev=await f.newDevice(),event=openingFor(dev);await f.auth.logout(f.login.access);const result=(await sync.push(dev.credential,[event])).items[0]!;
      // Logout é no mesmo instante fixo do evento: a origem fica revogada nesse instante.
      assert.equal(result.status,'quarantined');const c=await createConnection(f.options);try{await c.query('UPDATE auth_sessions SET revoked_at=? WHERE id=?',['2026-11-25T12:01:00.000Z',f.context.authorization_id]);}finally{await c.end();}
      const deviceId=randomUUID(),c2=await createConnection(f.options),credential=f.crypto.token();try{await c2.query("INSERT INTO auth_devices VALUES(?,?,?, ?,1,1)",[deviceId,f.identity.store_id,'CX99',f.crypto.digest(credential)]);}finally{await c2.end();}
      const historical=openingFor({id:deviceId,credential});assert.equal((await sync.push(credential,[historical])).items[0]!.status,'applied');
    });
  }finally{await f.close();}
});
