import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { LocalAuthService, type PairedDevice, type RemoteIdentityGateway } from '../packages/application/src/local-auth.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import type { AuthorizedContext } from '../packages/domain/src/authorization.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { sqliteAuthCache } from '../packages/infrastructure/sqlite/src/auth-cache.js';
import { windowsSecretProtector } from '../packages/infrastructure/native/src/dpapi.js';
import { boundIdentityHandler } from '../packages/infrastructure/native/src/identity-boundary.js';
import { createAuthCrypto, generateAuthKeys } from '../packages/infrastructure/security/src/crypto.js';
const errorCode = (code:string) => (error:unknown) => error instanceof ApplicationError && error.code===code;

test('B04 Windows real: DPAPI, escopo de terminal, autorização offline assinada, relógio, limites e fila preservada', {skip:process.platform!=='win32', timeout:90000}, async () => {
  const directory = await mkdtemp(join(tmpdir(),'venprox-b04-offline-'));
  const identity = {store_id:randomUUID(),device_id:randomUUID()};
  const store = SqliteStore.open(join(directory,'terminal.db'),identity,true);
  const keys = generateAuthKeys(); const crypto = createAuthCrypto(keys.privateKey,keys.fingerprintKey);
  const protector = windowsSecretProtector(`venprox-auth-v1:${identity.store_id}:${identity.device_id}`);
  const cache = sqliteAuthCache(store,protector);
  const password = '  Offline-secret-password!  ';
  const credential = crypto.token();
  const device: PairedDevice = { ...identity,code:'CX01',device_credential:credential,grant_public_key:crypto.publicKey() };
  let now = Date.parse('2026-11-24T12:00:00Z');
  let enabled = false;
  let unavailable = false;
  const userId = randomUUID();
  const context: AuthorizedContext = {store_id:identity.store_id,user_id:userId,device_id:identity.device_id,permissions:['sales.create'],permissions_version:2,
    authorization_id:randomUUID(),authorization_origin:'offline',authorized_at:new Date(now).toISOString(),expires_at:new Date(now+86400000).toISOString()};
  const gateway: RemoteIdentityGateway = {
    enroll:async () => device,
    login:async () => {
      if (unavailable) throw new Error('network unavailable');
      return {context:{...context,authorization_origin:'online',expires_at:new Date(now+900000).toISOString()},device:{...device,offline_enabled:enabled},...(enabled?{authorization:crypto.signGrant(context)}:{})};
    }, logout:async () => {},
  };
  const service = () => new LocalAuthService({storeId:identity.store_id,deviceId:identity.device_id,cache,gateway,crypto,clock:{now:()=>new Date(now)}});
  try {
    await store.migrate(); await store.provisionIdentity();
    const encrypted = await protector.protect('private-canary');
    assert.equal(encrypted.includes('private-canary'),false); assert.equal(await protector.unprotect(encrypted),'private-canary');
    await assert.rejects(windowsSecretProtector('different-device').unprotect(encrypted),errorCode('PROTECTED_STORAGE_UNAVAILABLE'));
    const auth = service();
    await assert.rejects(auth.getContext(),errorCode('AUTHENTICATION_REQUIRED'));
    await assert.rejects(auth.loginOffline('operator',password),errorCode('DEVICE_NOT_PAIRED'));
    await auth.enroll(crypto.token());
    assert.equal((await auth.deviceStatus()).offline_enabled,false);
    await auth.loginOnline('operator',password);
    await assert.rejects(auth.loginOffline('operator',password),errorCode('OFFLINE_DISABLED'));
    enabled = true;
    await auth.loginOnline('operator',password);
    assert.equal((await auth.deviceStatus()).offline_enabled,true);
    const encryptedRow = store.database.prepare('SELECT ciphertext FROM auth_local_grants').get() as {ciphertext:string};
    assert.equal(encryptedRow.ciphertext.includes(password),false); assert.equal(encryptedRow.ciphertext.includes('$argon2'),false);
    const pairedRow = store.database.prepare('SELECT ciphertext FROM auth_local_device').get() as {ciphertext:string}; assert.equal(pairedRow.ciphertext.includes(credential),false);
    await store.unitOfWork().run(async (repositories) => {
      const seq=await repositories.sequences.next(identity.device_id);
      const operationId=randomUUID();
      await repositories.outbox.append({operation_id:operationId,...identity,device_seq:seq,event_type:'test.pending',occurred_at:new Date(now).toISOString(),payload:'{}',authorization:context});
      await repositories.audit.append({operation_id:operationId,...identity,occurred_at:new Date(now).toISOString(),action:'test.authorized',actor_user_id:userId,permissions_version:context.permissions_version,authorization_origin:'offline',authorization_id:context.authorization_id});
    });
    unavailable = true;
    await auth.logout();
    await assert.rejects(auth.loginOffline('unknown',password),errorCode('INVALID_OFFLINE_CREDENTIALS'));
    await assert.rejects(auth.loginOffline('operator',password.trim()),errorCode('INVALID_OFFLINE_CREDENTIALS'));
    const accepted=await auth.loginOffline('operator',password);
    assert.equal(accepted.context.authorization_id,context.authorization_id); assert.equal(accepted.context.permissions.includes('users.manage'),false);
    now+=1000; await auth.getContext(); now-=500;
    await assert.rejects(auth.getContext(),errorCode('CLOCK_ROLLBACK_DETECTED')); now+=1000;
    await auth.logout();
    const cached=await cache.grant('operator');
    await cache.saveGrant({...cached!,authorization:cached!.authorization.slice(0,-3)+'AAA'},new Date(now).toISOString());
    await assert.rejects(auth.loginOffline('operator',password),errorCode('OFFLINE_AUTHORIZATION_INVALID'));
    await cache.saveGrant({...cached!,authorization:crypto.signGrant({...context,store_id:randomUUID()})},new Date(now).toISOString());
    await assert.rejects(auth.loginOffline('operator',password),errorCode('OFFLINE_AUTHORIZATION_EXPIRED'));
    await cache.saveGrant(cached!,new Date(now).toISOString());
    for(let i=0;i<5;i++) await assert.rejects(auth.loginOffline('operator','wrong'),errorCode('INVALID_OFFLINE_CREDENTIALS'));
    await assert.rejects(service().loginOffline('operator',password),errorCode('OFFLINE_RATE_LIMITED'));
    now+=301000;
    await service().loginOffline('operator',password);
    now=Date.parse(context.expires_at)+1;
    await assert.rejects(service().loginOffline('operator',password),errorCode('OFFLINE_AUTHORIZATION_EXPIRED'));
    assert.equal((store.database.prepare('SELECT COUNT(*) AS n FROM operation_outbox').get() as {n:number}).n,1);
    const historical=store.database.prepare('SELECT authorization_context FROM operation_outbox').get() as {authorization_context:string};
    assert.equal(JSON.parse(historical.authorization_context).authorization_id,context.authorization_id);
    assert.equal(JSON.parse(historical.authorization_context).expires_at,context.expires_at);
  } finally {
    await store.close();
    assert.equal(await realpath(dirname(directory)),await realpath(tmpdir())); assert.ok(basename(directory).startsWith('venprox-b04-'));
    await rm(directory,{recursive:true,force:true});
  }
});

test('B04 fronteira de preload: janela/frame/origem e DTO verificados; não existe SQL/IPC genérico',async () => {
  let calls=0;
  const handle=boundIdentityHandler(12,'app://venprox/index.html',async () => {calls++;return {ok:true};});
  const command={type:'auth.getContext',request_id:'test-request'};
  const sender={webContentsId:12,mainFrame:true,frameUrl:'app://venprox/index.html#home'};
  assert.deepEqual(await handle(sender,command),{ok:true});
  for(const invalid of [{...sender,webContentsId:13},{...sender,mainFrame:false},{...sender,frameUrl:'app://evil/index.html'},{...sender,frameUrl:'app://venprox/other.html'}]) await assert.rejects(handle(invalid,command),errorCode('IPC_ORIGIN_REJECTED'));
  await assert.rejects(handle(sender,{...command,permissions:['users.manage']}),errorCode('INVALID_COMMAND'));
  await assert.rejects(handle(sender,{type:'sql',request_id:'test-request',sql:'SELECT 1'}),errorCode('INVALID_COMMAND'));
  assert.equal(calls,1);
});
