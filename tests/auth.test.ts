import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { Ajv } from 'ajv';
import formats, { type FormatsPlugin } from 'ajv-formats';
import { buildApi } from '../apps/api/src/app.js';
import { AuthService } from '../packages/application/src/auth-service.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { createAuthCrypto, generateAuthKeys } from '../packages/infrastructure/security/src/crypto.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { authUnitOfWork } from '../packages/infrastructure/mysql/src/auth-repository.js';
import { provisionAuth } from '../packages/infrastructure/mysql/src/auth-provision.js';
import { mysqlMigrations } from '../migrations/mysql/registry.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { identityGateway } from '../packages/infrastructure/security/src/identity-gateway.js';

test('B04 HTTP/MySQL real: setup único, sessões, CSRF, usuários, convites, terminais e revogação', { skip: !process.env.MYSQL_PASSWORD, timeout: 90000 }, async (t) => {
  assert.equal(process.env.MYSQL_HOST,'127.0.0.1'); assert.equal(process.env.MYSQL_PORT,'3308');
  const options = { host:'127.0.0.1',port:3308,database:'venprox_b04_test',user:'venprox_migration',password:process.env.MYSQL_PASSWORD! };
  const connection = await createConnection(options);
  const tables = [...new Set(mysqlMigrations.flatMap((migration) => migration.steps).filter((step) => step.sql.startsWith('CREATE TABLE')).map((step) => step.table))].reverse();
  const clear = async () => { for (const table of [...tables,'schema_migrations']) await connection.query(`DROP TABLE IF EXISTS ${table}`); };
  await clear();
  const storeId = randomUUID();
  const store = await MysqlStore.connect(options,{store_id:storeId});
  const keys = generateAuthKeys(); const crypto = createAuthCrypto(keys.privateKey,keys.fingerprintKey);
  let now = Date.parse('2026-11-24T12:00:00Z');
  const token = crypto.token();
  const logs: string[] = [];
  const service = new AuthService({ storeId, unitOfWork: authUnitOfWork(store), crypto, clock: {now:() => new Date(now)}, ids:{generate:randomUUID} });
  const httpOptions={service,origin:'https://pdv.test',secureCookies:true};
  const app = buildApi({ environment:'development',ids:{generate:randomUUID},logger:createLogger('auth-test','info',{write:(chunk:string) => {logs.push(chunk);}}),
    getCompatibility:createGetCompatibility(createCompatibilityPolicy('0.1.0',[1]),'0.1.0'),auth:httpOptions });
  const origin = { origin:'https://pdv.test' };
  const password = '  Secret-valid-123!  ';
  const login = async (name = 'owner', value = password) => app.inject({method:'POST',url:'/api/v1/auth/login',headers:origin,payload:{login:name,password:value}});
  const sessionHeaders = (response: Awaited<ReturnType<typeof login>>) => ({ ...origin, cookie: response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '), 'x-csrf-token': response.json().data.csrf_token });
  let ownerHeaders: ReturnType<typeof sessionHeaders>;
  let operatorId = '';
  let operatorHeaders: ReturnType<typeof sessionHeaders>;
  let deviceId = '';
  let credential = '';
  try {
    await store.migrate(); await store.provisionIdentity();
    await provisionAuth(options,storeId,crypto.digest(token),new Date(now+3600000).toISOString(),0);
    await t.test('ativação paralela cria só um administrador e nunca reabre setup',async () => {
      const body = {installation_token:token,store_name:'Loja de teste',login:' Owner ',name:'Dono',password};
      assert.equal((await app.inject({method:'POST',url:'/api/v1/setup/activate',payload:body})).statusCode,403);
      const responses = await Promise.all([1,2].map(() => app.inject({method:'POST',url:'/api/v1/setup/activate',headers:origin,payload:body})));
      assert.deepEqual(responses.map((response) => response.statusCode).sort(),[201,409]);
      const [rows] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM auth_users'); assert.equal(Number(rows[0]!.n),1);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/setup/activate',headers:origin,payload:body})).statusCode,403);
      assert.equal((await login('owner',password.trim())).statusCode,401);
      const signedIn = await login(); assert.equal(signedIn.statusCode,200); ownerHeaders = sessionHeaders(signedIn);
      for (const cookie of signedIn.cookies) { assert.equal(cookie.httpOnly,true); assert.equal(cookie.secure,true); assert.equal(cookie.sameSite,'Strict'); }
      assert.equal(signedIn.body.includes('password_hash'),false); assert.equal(signedIn.body.includes('refresh_hash'),false);
    });
    await t.test('CSRF/origem e escopo não podem ser escolhidos pelo cliente',async () => {
      const user = {operation_id:randomUUID(),login:'operator',name:'Operador',password:'Operator-Secret-123!',role:'operator'};
      assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/users',headers:{...ownerHeaders!,origin:'https://evil.test'},payload:user})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/users',headers:{origin:origin.origin,cookie:ownerHeaders!.cookie},payload:user})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/users',headers:ownerHeaders!,payload:{...user,store_id:randomUUID()}})).statusCode,422);
      const created = await app.inject({method:'POST',url:'/api/v1/admin/users',headers:ownerHeaders!,payload:user}); assert.equal(created.statusCode,201); operatorId = created.json().data.id;
      const replay = await app.inject({method:'POST',url:'/api/v1/admin/users',headers:ownerHeaders!,payload:user}); assert.equal(replay.json().data.id,operatorId);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/admin/users',headers:ownerHeaders!,payload:{...user,name:'Mudado'}})).statusCode,409);
      const operator = await login('operator','Operator-Secret-123!'); operatorHeaders = sessionHeaders(operator);
      assert.equal((await app.inject({url:'/api/v1/admin/users',headers:operatorHeaders})).statusCode,403);
      assert.equal((await app.inject('/api/v1/admin/devices')).statusCode,401);
      assert.equal((await app.inject({method:'PATCH',url:`/api/v1/admin/users/${randomUUID()}`,headers:ownerHeaders!,payload:{operation_id:randomUUID(),expected_version:1,active:false}})).statusCode,404);
    });
    await t.test('convite é de uso único e credencial de terminal não administra usuários',async () => {
      const invitation = await app.inject({method:'POST',url:'/api/v1/admin/devices/invitations',headers:ownerHeaders!,payload:{}}); assert.equal(invitation.statusCode,201);
      deviceId = randomUUID();
      const enrolled = await app.inject({method:'POST',url:'/api/v1/devices/enroll',headers:origin,payload:{invitation_token:invitation.json().data.invitation_token,device_id:deviceId}});
      assert.equal(enrolled.statusCode,201); assert.equal(enrolled.json().data.code,'CX01'); credential = enrolled.json().data.device_credential;
      assert.equal((await app.inject({method:'POST',url:'/api/v1/devices/enroll',headers:origin,payload:{invitation_token:invitation.json().data.invitation_token,device_id:randomUUID()}})).statusCode,403);
      assert.equal((await app.inject({url:'/api/v1/admin/users',headers:{authorization:`Bearer ${credential}`}})).statusCode,401);
      const listed = await app.inject({url:'/api/v1/admin/devices',headers:ownerHeaders!}); assert.equal(listed.body.includes(credential),false);
      const disabled = await app.inject({method:'POST',url:'/api/v1/auth/offline-grant',headers:{...operatorHeaders!,'x-device-credential':credential},payload:{}});
      assert.equal(disabled.statusCode,409); assert.equal(disabled.json().error.code,'OFFLINE_DISABLED');
      // Política habilitada somente nesta instalação descartável de teste.
      await connection.query('UPDATE auth_installation SET offline_ttl_seconds=86400');
      const allowed = await app.inject({method:'POST',url:'/api/v1/auth/offline-grant',headers:{...operatorHeaders!,'x-device-credential':credential},payload:{}});
      assert.equal(allowed.statusCode,200); const context = crypto.verifyGrant(allowed.json().data.authorization,crypto.publicKey());
      assert.equal(context.device_id,deviceId); assert.equal(context.store_id,storeId); assert.equal(context.user_id,operatorId);
      assert.equal(context.permissions.includes('users.manage'),false);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/offline-grant',headers:{...operatorHeaders!,'x-device-credential':crypto.token()},payload:{}})).statusCode,401);
    });
    await t.test('rotação/revogação mantêm fatos e negam credencial anterior; replay não repete segredo',async () => {
      const operation = {operation_id:randomUUID(),expected_version:1};
      const rotated = await app.inject({method:'POST',url:`/api/v1/admin/devices/${deviceId}/rotate`,headers:ownerHeaders!,payload:operation}); assert.equal(rotated.statusCode,200);
      assert.ok(rotated.json().data.device_credential); assert.notEqual(rotated.json().data.device_credential,credential);
      const replay = await app.inject({method:'POST',url:`/api/v1/admin/devices/${deviceId}/rotate`,headers:ownerHeaders!,payload:operation}); assert.equal(replay.json().data.device_credential,undefined);
      const revoked = await app.inject({method:'POST',url:`/api/v1/admin/devices/${deviceId}/revoke`,headers:ownerHeaders!,payload:{operation_id:randomUUID(),expected_version:2}}); assert.equal(revoked.statusCode,200);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/offline-grant',headers:{...operatorHeaders!,'x-device-credential':rotated.json().data.device_credential},payload:{}})).statusCode,401);
      const [rows] = await connection.query<RowDataPacket[]>('SELECT revoked_at FROM auth_grants'); assert.ok(rows.every((row) => row.revoked_at));
    });
    await t.test('refresh rotacionado/revogado e alterações de usuário invalidam sessão; último admin é preservado',async () => {
      const before = ownerHeaders!;
      const refreshed = await app.inject({method:'POST',url:'/api/v1/auth/refresh',headers:before,payload:{}}); assert.equal(refreshed.statusCode,200); ownerHeaders = sessionHeaders(refreshed);
      assert.equal((await app.inject({url:'/api/v1/auth/me',headers:before})).statusCode,401);
      assert.ok([401,403].includes((await app.inject({method:'POST',url:'/api/v1/auth/refresh',headers:before,payload:{}})).statusCode));
      const edited = await app.inject({method:'PATCH',url:`/api/v1/admin/users/${operatorId}`,headers:ownerHeaders,payload:{operation_id:randomUUID(),expected_version:1,active:false}}); assert.equal(edited.statusCode,200);
      assert.equal((await app.inject({url:'/api/v1/auth/me',headers:operatorHeaders!})).statusCode,401);
      const me = await app.inject({url:'/api/v1/auth/me',headers:ownerHeaders});
      assert.equal((await app.inject({method:'PATCH',url:`/api/v1/admin/users/${me.json().data.user.id}`,headers:ownerHeaders,payload:{operation_id:randomUUID(),expected_version:1,role:'operator'}})).statusCode,409);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:ownerHeaders,payload:{}})).statusCode,200);
      assert.equal((await app.inject({url:'/api/v1/auth/me',headers:ownerHeaders})).statusCode,401);
    });
    await t.test('limites de tentativas são persistentes e erros não enumeram usuários',async () => {
      const missing = await login('unknown','wrong'); const wrong = await login('owner','wrong');
      assert.equal(missing.json().error.code,wrong.json().error.code); assert.equal(missing.json().error.message,wrong.json().error.message);
      for (let i=0;i<9;i++) await login('owner','wrong');
      const limited = await login(); assert.equal(limited.statusCode,429); assert.ok(limited.headers['retry-after']);
      now += 901000; assert.equal((await login()).statusCode,200);
    });
    await t.test('OpenAPI cobre todas as rotas e nenhuma resposta/listagem expõe hash ou token de sessão',async () => {
      const spec = app.swagger(); assert.ok('openapi' in spec);
      const ids = new Set<string>();
      const ajv = new Ajv({strict:false}); (formats as unknown as FormatsPlugin)(ajv);
      for (const item of Object.values(spec.paths!)) for (const [method, operation] of Object.entries(item!)) {
        if (!['get','post','patch'].includes(method)) continue;
        const op = operation as {operationId:string;tags:string[];description:string;responses:Record<string,{content?:Record<string,{schema:object}>}>};
        assert.equal(ids.has(op.operationId),false); ids.add(op.operationId); assert.ok(op.tags.length); assert.ok(op.description);
        for (const response of Object.values(op.responses)) if (response.content?.['application/json']) {
          const schema = response.content['application/json'].schema as {example?:unknown};
          const validate = ajv.compile(schema);
          assert.notEqual(schema.example,undefined);
          assert.equal(validate(schema.example),true,JSON.stringify(validate.errors));
        }
      }
      assert.equal(ids.size,16);
      assert.equal(JSON.stringify(spec).includes('password_hash'),false);
      assert.equal(logs.join('').includes(password),false); assert.equal(logs.join('').includes(token),false); assert.equal(logs.join('').includes(credential),false);
      const [rows] = await connection.query<RowDataPacket[]>('SELECT action,actor_user_id,permissions_version,authorization_origin,authorization_id FROM audit_log');
      assert.ok(rows.some((row) => row.action==='setup.activated'&&row.actor_user_id&&row.authorization_origin==='setup'));
      assert.ok(rows.filter((row)=>row.action==='user.created').every((row)=>row.actor_user_id&&row.permissions_version&&row.authorization_id&&row.authorization_origin==='online'));
    });
    await assert.rejects(service.authenticate('unknown'),(error:unknown) => error instanceof ApplicationError && error.kind==='unauthenticated');
    await t.test('gateway nativo usa HTTP real, mantém cookies fora dos DTOs e obtém concessão vinculada ao terminal',async () => {
      const address=await app.listen({host:'127.0.0.1',port:0}); httpOptions.origin=address;
      const owner=await service.login('owner',password,'gateway-proof');
      const invitation=await service.invitation(owner.access);
      const gateway=identityGateway(address);
      const paired=await gateway.enroll(invitation.invitation_token,randomUUID());
      const result=await gateway.login('owner',password,paired);
      assert.ok(result.device.session?.cookies.includes('venprox_refresh=')); assert.equal(result.device.offline_enabled,true);
      const grant=crypto.verifyGrant(result.authorization!,paired.grant_public_key); assert.equal(grant.device_id,paired.device_id);
      await gateway.logout(result.device);
      assert.equal((await fetch(`${address}/api/v1/auth/me`,{headers:{cookie:result.device.session!.cookies}})).status,401);
      assert.equal(logs.join('').includes(paired.device_credential),false); assert.equal(logs.join('').includes(password),false);
    });
    await t.test('backup/restauração inclui usuários, sessões, permissões e setup fechado sem reativar administrador',async () => {
      const directory=await mkdtemp(join(tmpdir(),'venprox-b04-backup-'));
      const restoreOptions={...options,database:'venprox_b04_restore_test'};
      const restoredConnection=await createConnection(restoreOptions);
      const clearRestore=async()=>{for(const table of [...tables,'schema_migrations'])await restoredConnection.query(`DROP TABLE IF EXISTS ${table}`);};
      let restored: MysqlStore|undefined;
      try {
        await clearRestore();
        const session=await service.login('owner',password,'backup-proof');
        const file=join(directory,'identity.json'); await store.backup(file);
        restored=await MysqlStore.connect(restoreOptions,{store_id:storeId}); await restored.migrate(); await restored.restore(file);
        const recovered=new AuthService({storeId,unitOfWork:authUnitOfWork(restored),crypto,clock:{now:()=>new Date(now)},ids:{generate:randomUUID}});
        assert.equal((await recovered.authenticate(session.access)).permissions.includes('users.manage'),true);
        await assert.rejects(recovered.activate({installation_token:token,store_name:'Não reabrir',login:'duplicate',name:'Duplicado',password},'restore-proof'));
        const [audit]=await restoredConnection.query<RowDataPacket[]>('SELECT actor_user_id,authorization_origin FROM audit_log WHERE action=?',['setup.activated']);
        assert.ok(audit[0]!.actor_user_id); assert.equal(audit[0]!.authorization_origin,'setup');
      } finally {
        await restored?.close(); await clearRestore(); await restoredConnection.end();
        assert.equal(await realpath(dirname(directory)),await realpath(tmpdir())); assert.ok(basename(directory).startsWith('venprox-b04-')); await rm(directory,{recursive:true,force:true});
      }
    });
  } finally { await app.close(); await store.close(); await clear(); await connection.end(); }
});
