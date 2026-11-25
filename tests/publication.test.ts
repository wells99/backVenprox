import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { createConnection } from 'mysql2/promise';
import { Value } from 'typebox/value';
import { Ajv } from 'ajv';
import formats, { type FormatsPlugin } from 'ajv-formats';
import { syncFixture } from './sync-fixture.js';
import { fails } from './financial-fixture.js';
import { DownloadService } from '../packages/application/src/download-service.js';
import { SyncService } from '../packages/application/src/sync-service.js';
import { CatalogService } from '../packages/application/src/catalog-service.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import type { DownloadDependencies, SnapshotRecord } from '../packages/application/src/publication-ports.js';
import { atomicSyncPublication, mysqlSyncUnitOfWork } from '../packages/infrastructure/mysql/src/sync.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { syncHashValue } from '../packages/infrastructure/security/src/sync-validation.js';
import { publicationValue } from '../packages/infrastructure/persistence/src/publication-repository.js';
import { ChangesResponse, ManifestResponse, SnapshotPageResponse } from '../packages/contracts/src/download.js';
import { buildApi } from '../apps/api/src/app.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';

const deferred=()=>{let resolve!:()=>void;return {promise:new Promise<void>((done)=>{resolve=done;}),resolve:()=>resolve()};};
test('B11 projeção publicada exclui provas de origem e segredos recursivamente',()=>{
  assert.deepEqual(publicationValue({password_hash:'hidden',items:[{authorization_context:'hidden',completion_hash:'hidden',id:'kept'}]}),{items:[{id:'kept'}]});
});
test('B11 MySQL real: commit/cursor, snapshots e contratos HTTP',{skip:!process.env.MYSQL_PASSWORD,timeout:240000},async(t)=>{
  const f=await syncFixture('b11'),uow=mysqlSyncUnitOfWork(f.store),sync=new SyncService({...f.deps,unitOfWork:uow,publication:atomicSyncPublication});
  const deps:DownloadDependencies={unitOfWork:uow,storeId:f.identity.store_id,clock:f.businessDeps.clock,ids:f.deps.ids,digest:f.crypto.digest,hash:syncHashValue,bytes:(v)=>Buffer.byteLength(JSON.stringify(v))};
  const download=new DownloadService(deps),catalog=new CatalogService({...f.businessDeps,local:false,remoteWritesEnabled:true});
  const credential=f.device.credential,context=f.context;
  const all=()=>download.changes(credential,'0',100);
  const state=()=>uow.run(async(tx)=>{await tx.publication.lock();return tx.publication.state();});
  const snapTables=['server_changes','store_sync_sequence','server_inbox','server_device_state','stock_movements','stock_balances','audit_log','categories','catalog_intentions'];
  const saved=async()=>Object.fromEntries(await Promise.all(snapTables.map(async(table)=>[table,(await f.rows(table)).map((row)=>JSON.stringify(row)).sort()])));
  try{
    await t.test('cadastros e referências autorizadas publicam sem outbox; replay e rollback preservam tudo',async()=>{
      const before=(await all()).items.length,intention=randomUUID();
      const category=await catalog.createCategory(context,intention,{name:'Mesmo instante'});
      assert.deepEqual(await catalog.createCategory(context,intention,{name:'Mesmo instante'}),category);
      assert.equal((await all()).items.length,before+1);assert.equal(await f.count('operation_outbox'),0);
      const snapshot=await saved();
      const fault=new CatalogService({...catalog.deps,unitOfWork:{run:(work)=>catalog.deps.unitOfWork.run((tx)=>work({...tx,publication:{publish:async(value)=>{await tx.publication!.publish(value);throw new ApplicationError('INJECTED_FAILURE','Falha.','unavailable');}}}))}});
      await assert.rejects(fault.createCategory(context,randomUUID(),{name:'Não confirmada'}),fails('INJECTED_FAILURE'));assert.deepEqual(await saved(),snapshot);
      assert.ok((await all()).items.some((c)=>c.type==='authorization.user.updated.v1'));assert.ok((await all()).items.some((c)=>c.type==='authorization.device.updated.v1'));
      assert.doesNotMatch(JSON.stringify((await all()).items),/password_hash|credential_hash|authorization_context|completion_hash/);
    });
    await t.test('A segura cursor até commit; B e leitor não ultrapassam; rollback não cria lacuna',async()=>{
      const entered=deferred(),release=deferred(),baseline=await state(),idA=randomUUID();let bDone=false;
      const a=uow.run(async(tx)=>{await tx.publication.lock();await tx.publication.publish({operation_id:idA,type:'test.required.v1',source:'web',payload:{active:false},published_at:f.now});entered.resolve();await release.promise;});
      await entered.promise;
      const b=catalog.createCategory(context,randomUUID(),{name:'B após A'}).then((v)=>{bDone=true;return v;});
      const reading=download.changes(credential,baseline.cursor,1);
      const connection=await createConnection(f.options);
      try{const [rows]=await connection.query('SELECT cursor_value FROM store_sync_sequence WHERE store_id=?',[f.identity.store_id]);assert.equal(String((rows as {cursor_value:string}[])[0]!.cursor_value),baseline.cursor);assert.equal(bDone,false);}finally{await connection.end();release.resolve();}
      await Promise.all([a,b]);const page=await reading;assert.equal(page.items.length,1);assert.equal(page.items[0]!.operation_id,idA);assert.equal(page.next_cursor,String(BigInt(baseline.cursor)+1n));
      const rest=await download.changes(credential,page.next_cursor,1);assert.equal(rest.items.length,1);assert.equal(rest.next_cursor,String(BigInt(baseline.cursor)+2n));
      const after=await state();await assert.rejects(uow.run(async(tx)=>{await tx.publication.lock();await tx.publication.publish({operation_id:randomUUID(),type:'rolled.back.v1',source:'web',payload:{},published_at:f.now});throw new ApplicationError('INJECTED_FAILURE','Falha.','unavailable');}),fails('INJECTED_FAILURE'));assert.deepEqual(await state(),after);
      const cursors=(await all()).items.map((c)=>c.cursor);assert.deepEqual(cursors,cursors.map((_,i)=>String(i+1)));
      // A new connection resumes exactly after the last included cursor.
      const reconnected=await MysqlStore.connect(f.options,{store_id:f.identity.store_id});try{const next=await new DownloadService({...deps,unitOfWork:mysqlSyncUnitOfWork(reconnected)}).changes(credential,rest.next_cursor);assert.equal(next.items.length,0);assert.equal(next.next_cursor,rest.next_cursor);}finally{await reconnected.close();}
    });
    await t.test('publicação B10 real junto de efeitos, recibo e fronteira; falha após log reverte tudo',async()=>{
      const before=await saved(),fault=new SyncService({...f.deps,unitOfWork:uow,publication:{publish:async(tx,event,result)=>{await atomicSyncPublication.publish(tx,event,result);throw new ApplicationError('INJECTED_FAILURE','Falha.','unavailable');}}});
      await assert.rejects(fault.push(credential,[f.events[0]!]),fails('INJECTED_FAILURE'));assert.deepEqual(await saved(),before);
      const prior=BigInt((await state()).cursor),response=await sync.push(credential,f.events);assert.ok(response.items.every((r)=>r.status==='applied'),JSON.stringify(response));
      assert.equal(BigInt((await state()).cursor),prior+BigInt(f.events.length));assert.equal(await f.count('server_publication_probes'),0);
      const received=(await download.changes(credential,String(prior))).items;assert.ok(received.every((event)=>event.origin?.device_id===f.device.id));assert.deepEqual(received.map((event)=>event.origin!.device_seq),f.events.map((event)=>event.device_seq));
      const after=await state();assert.ok((await sync.push(credential,f.events)).items.every((r)=>r.status==='duplicate'));assert.deepEqual(await state(),after);
      assert.equal(await f.count('sales'),2);assert.equal(await f.count('sale_reversals'),1);assert.equal(await f.count('server_cash_reconciliations'),2);
    });
    await t.test('captura sob barreira tem corte coerente; download imutável não trava escritor',async()=>{
      const seed=await createConnection(f.options);try{await seed.query('INSERT INTO categories(id,store_id,name,search_key,active,version) VALUES ?',[Array.from({length:205},()=>[randomUUID(),f.identity.store_id,'Página de laboratório','pagina de laboratorio',1,1])]);}finally{await seed.end();}
      const captured=deferred(),release=deferred(),before=await state();let updated=false;
      const waiting=new DownloadService({...deps,unitOfWork:{run:(work)=>uow.run((tx)=>work({...tx,publication:{...tx.publication,capture:async(kind)=>{const result=await tx.publication.capture(kind);captured.resolve();await release.promise;return result;}}}))}});
      const creating=waiting.createSnapshot(credential,'initial');await captured.promise;
      const writing=catalog.updateProduct(context,f.product.id,randomUUID(),1,{price_cents:333,active:false}).then(()=>{updated=true;});
      assert.equal(updated,false);release.resolve();const manifest=await creating;await writing;
      assert.equal(manifest.cut_cursor,before.cursor);assert.equal(manifest.modules.credit,0);assert.equal(manifest.modules.reminders,0);assert.equal('sales' in manifest.counts,false);assert.equal('auth_devices'in manifest.counts,false);
      assert.ok(Value.Check(ManifestResponse,{data:manifest,meta:{request_id:'test'}}));
      const pages=await Promise.all(manifest.pages.map((p)=>download.page(credential,manifest.id,p.page)));
      assert.ok(pages.length>=3);
      const product=pages.flatMap((p)=>p.records).find((r)=>r.table==='products'&&r.value.id===f.product.id)!;assert.equal(Number(product.value.price_cents),100);assert.equal(Number(product.value.active),1);
      for(const page of pages){assert.equal(page.checksum,syncHashValue(page.records));assert.deepEqual(await download.page(credential,manifest.id,page.page),page);assert.ok(Value.Check(SnapshotPageResponse,{data:page,meta:{request_id:'test'}}));}
      assert.equal(manifest.checksum,syncHashValue(pages.map((p)=>p.checksum)));assert.ok((await download.changes(credential,manifest.cut_cursor)).items.some((e)=>e.type==='product.updated.v1'));
      assert.doesNotMatch(JSON.stringify(pages),/password_hash|credential_hash|authorization_context|access_hash|refresh_hash/);
      assert.ok(manifest.capture_ms<2000);console.log(JSON.stringify({evidence:'B11_initial',records:pages.reduce((n,p)=>n+p.records.length,0),bytes:manifest.bytes,capture_ms:manifest.capture_ms}));
    });
    await t.test('operacional conserva histórico recebido, IDs e módulos; exige recuperação e destino certo',async()=>{
      await assert.rejects(download.createSnapshot(credential,'operational'),fails('RECOVERY_AUTHORIZATION_REQUIRED'));
      await assert.rejects(download.createSnapshot(credential,'operational',{...context,permissions:['catalog.read']}),fails('RECOVERY_AUTHORIZATION_REQUIRED'));
      const started=performance.now(),manifest=await download.createSnapshot(credential,'operational',context),elapsed=Math.ceil(performance.now()-started);
      const records=(await Promise.all(manifest.pages.map((p)=>download.page(credential,manifest.id,p.page,context)))).flatMap((p)=>p.records);
      assert.equal(manifest.counts.sales,2);assert.equal(manifest.counts.sale_reversals,1);assert.equal(manifest.counts.cash_closures,2);assert.ok(records.some((r)=>r.table==='sales'&&r.value.id===f.saleId));
      assert.ok(records.some((r)=>r.table==='stock_movements'));assert.ok(records.some((r)=>r.table==='sale_items'));assert.ok(records.some((r)=>r.table==='sale_payments'));assert.equal(manifest.modules.sales,1);
      assert.doesNotMatch(JSON.stringify(records),/password_hash|credential_hash|authorization_context|access_hash|refresh_hash|csrf_hash/);
      await assert.rejects(download.manifest(credential,manifest.id),fails('RECOVERY_AUTHORIZATION_REQUIRED'));
      const other=await f.newDevice();await assert.rejects(download.manifest(other.credential,manifest.id,context),fails('SNAPSHOT_NOT_FOUND'));
      const expired=new DownloadService({...deps,clock:{now:()=>new Date('2026-11-25T14:00:00.000Z')}}),renewed={...context,expires_at:'2026-11-25T15:00:00.000Z'};
      assert.equal((await expired.manifest(credential,manifest.id,renewed)).state,'expired');await assert.rejects(expired.page(credential,manifest.id,0,renewed),fails('SNAPSHOT_EXPIRED'));
      await assert.rejects(download.page(credential,manifest.id,999,context),fails('SNAPSHOT_PAGE_NOT_FOUND'));
      console.log(JSON.stringify({evidence:'B11_operational',records:records.length,bytes:manifest.bytes,capture_ms:manifest.capture_ms,total_ms:elapsed}));
    });
    await t.test('limites de captura não persistem manifesto parcial; piso vencido nunca devolve vazio',async()=>{
      const before=await f.count('server_snapshots');
      const record:SnapshotRecord={table:'customers',value:{id:randomUUID(),name:'x'.repeat(256*1024)}};
      const oversized=new DownloadService({...deps,unitOfWork:{run:(work)=>uow.run((tx)=>work({...tx,publication:{...tx.publication,capture:async()=>({records:[record],counts:{customers:1},capture_ms:1})}}))}});
      await assert.rejects(oversized.createSnapshot(credential,'initial'),fails('SNAPSHOT_LIMIT_EXCEEDED'));assert.equal(await f.count('server_snapshots'),before);
      const connectionLimit=await createConnection(f.options),categoryIds=Array.from({length:5001},()=>randomUUID()),proposalIds=Array.from({length:5},()=>randomUUID());
      try{
        await connectionLimit.query('INSERT INTO categories(id,store_id,name,search_key,active,version) VALUES ?',[categoryIds.map((id)=>[id,f.identity.store_id,'B11 limit fixture','b11 limit fixture',1,1])]);
        await assert.rejects(download.createSnapshot(credential,'initial'),fails('SNAPSHOT_LIMIT_EXCEEDED'));
        await connectionLimit.query('DELETE FROM categories WHERE id IN (?)',[categoryIds]);
        await connectionLimit.query('INSERT INTO server_catalog_proposals VALUES ?',[proposalIds.map((id)=>[id,f.identity.store_id,f.device.id,'test.fixture',JSON.stringify({name:'x'.repeat(900000)})])]);
        await assert.rejects(download.createSnapshot(credential,'operational',context),fails('SNAPSHOT_LIMIT_EXCEEDED'));
      }finally{await connectionLimit.query('DELETE FROM categories WHERE id IN (?)',[categoryIds]);await connectionLimit.query('DELETE FROM server_catalog_proposals WHERE operation_id IN (?)',[proposalIds]);await connectionLimit.end();}
      const slow=new DownloadService({...deps,unitOfWork:{run:(work)=>uow.run(async(tx)=>{const original=tx.publication.capture;return work({...tx,publication:{...tx.publication,capture:async(kind)=>{const result=await original(kind);await new Promise((done)=>setTimeout(done,2100));return result;}}});})}});
      await assert.rejects(slow.createSnapshot(credential,'initial'),fails('SNAPSHOT_LIMIT_EXCEEDED'));assert.equal(await f.count('server_snapshots'),before);
      const failedSave=new DownloadService({...deps,unitOfWork:{run:(work)=>uow.run((tx)=>work({...tx,publication:{...tx.publication,saveSnapshot:async(manifest,pages)=>{await tx.publication.saveSnapshot(manifest,pages);throw new ApplicationError('INJECTED_FAILURE','Falha.','unavailable');}}}))}});
      const pagesBefore=await f.count('server_snapshot_pages');await assert.rejects(failedSave.createSnapshot(credential,'initial'),fails('INJECTED_FAILURE'));assert.equal(await f.count('server_snapshots'),before);assert.equal(await f.count('server_snapshot_pages'),pagesBefore);
      await assert.rejects(download.changes(credential,'01'),fails('INVALID_CURSOR_OR_LIMIT'));await assert.rejects(download.changes(credential,'9223372036854775808'),fails('INVALID_CURSOR_OR_LIMIT'));await assert.rejects(download.changes(credential,'9223372036854775807'),fails('CURSOR_AHEAD'));
      const connection=await createConnection(f.options);try{await connection.query('UPDATE store_sync_sequence SET retention_floor=1 WHERE store_id=?',[f.identity.store_id]);}finally{await connection.end();}
      await assert.rejects(download.changes(credential,'0'),fails('SNAPSHOT_REQUIRED'));assert.equal((await download.changes(credential,'1')).retention_floor,'1');
    });
    await t.test('HTTP/OpenAPI: quatro rotas, permissões, CSRF, erros e schemas reais',async()=>{
      const app=buildApi({environment:'development',logger:createLogger('test','silent'),ids:f.deps.ids,getCompatibility:createGetCompatibility(createCompatibilityPolicy('0.1.0',[1]),'0.1.0'),auth:{service:f.auth,origin:'http://test',secureCookies:false,download,sync}});
      const headers={'x-device-credential':credential},cookie=`venprox_access=${f.login.access}`,csrf={'origin':'http://test','x-csrf-token':f.login.csrf,cookie};
      try{
        await app.ready();const spec=app.swagger();assert.ok('openapi'in spec);const paths=Object.keys(spec.paths!).filter((p)=>p.startsWith('/api/v1/sync/'));assert.equal(paths.length,7);assert.equal(paths.includes('/api/v1/sync/snapshot'),false);
        const ajv=new Ajv({strict:false});(formats as unknown as FormatsPlugin)(ajv);
        for(const path of paths.filter((p)=>!p.includes('receipts')&&!p.includes('device-state')&&!p.includes('push'))){
          const op:{description?:string;security?:unknown[];responses?:Record<string,unknown>}=(spec.paths![path]!.get??spec.paths![path]!.post)!;
          assert.ok(op.description);assert.ok(op.security?.length);
          for(const response of Object.values(op.responses!)){
            const schema:object&{example?:unknown}=(response as {content:Record<string,{schema:object&{example?:unknown}}>}).content['application/json']!.schema;
            if(schema.example)assert.equal(ajv.validate(schema,schema.example),true,JSON.stringify(ajv.errors));
          }
        }
        assert.equal((await app.inject('/api/v1/sync/changes')).statusCode,422);
        assert.equal((await app.inject({url:'/api/v1/sync/changes',headers:{'x-device-credential':'x'.repeat(32)}})).statusCode,401);
        assert.equal((await app.inject({url:'/api/v1/sync/changes?after=0',headers})).json().error.code,'SNAPSHOT_REQUIRED');
        const changes=await app.inject({url:'/api/v1/sync/changes?after=1&limit=2',headers});assert.equal(changes.statusCode,200);assert.ok(Value.Check(ChangesResponse,changes.json()));
        assert.equal((await app.inject({method:'POST',url:'/api/v1/sync/snapshots',headers,payload:{kind:'operational'}})).statusCode,403);
        assert.equal((await app.inject({method:'POST',url:'/api/v1/sync/snapshots',headers:{...headers,...csrf,'x-csrf-token':'wrong'},payload:{kind:'operational'}})).statusCode,403);
        const created=await app.inject({method:'POST',url:'/api/v1/sync/snapshots',headers:{...headers,...csrf},payload:{kind:'operational'}});assert.equal(created.statusCode,201,created.body);assert.ok(Value.Check(ManifestResponse,created.json()));
        const id=created.json().data.id,url=`/api/v1/sync/snapshots/${id}`;
        assert.equal((await app.inject({url,headers})).statusCode,403);assert.equal((await app.inject({url,headers:{...headers,cookie}})).statusCode,200);
        const page=await app.inject({url:`${url}/pages/0`,headers:{...headers,cookie}});assert.equal(page.statusCode,200);assert.ok(Value.Check(SnapshotPageResponse,page.json()));
        for(const payload of [{kind:'initial',extra:1},{kind:'unknown'}])assert.equal((await app.inject({method:'POST',url:'/api/v1/sync/snapshots',headers,payload})).statusCode,422);
      }finally{await app.close();}
    });
  }finally{await f.close();}
});
