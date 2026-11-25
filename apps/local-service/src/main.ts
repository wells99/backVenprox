import { Value } from 'typebox/value';
import { createGetLocalDiagnostics } from '../../../packages/application/src/get-local-diagnostics.js';
import { LocalCommandSchema } from '../../../packages/contracts/src/system.js';
import { errorResponse, withinPayloadLimits } from '../../../packages/contracts/src/common.js';
import type { LocalDiagnostics } from '../../../packages/contracts/src/ipc.js';
import { loadLocalConfig } from '../../../packages/infrastructure/runtime/src/config.js';
import { createLogger, reportBootFailure } from '../../../packages/infrastructure/runtime/src/logger.js';
import { assertSupportedRuntime, systemClock } from '../../../packages/infrastructure/runtime/src/system.js';
import { installShutdown } from '../../../packages/infrastructure/runtime/src/shutdown.js';
import { openSqliteRuntime } from '../../../packages/infrastructure/sqlite/src/runtime-diagnostics.js';
import { openLocalPersistence, SqliteStore } from '../../../packages/infrastructure/sqlite/src/store.js';
import { LocalAuthService, type LocalIdentityCache } from '../../../packages/application/src/local-auth.js';
import { ApplicationError } from '../../../packages/application/src/application-error.js';
import { PersistenceError } from '../../../packages/application/src/persistence.js';
import { authIpcCommands, AuthIpcResponse } from '../../../packages/contracts/src/auth.js';
import { normalizeLoginKey } from '../../../packages/contracts/src/common.js';
import { sqliteAuthCache } from '../../../packages/infrastructure/sqlite/src/auth-cache.js';
import { windowsSecretProtector } from '../../../packages/infrastructure/native/src/dpapi.js';
import { identityGateway } from '../../../packages/infrastructure/security/src/identity-gateway.js';
import { createAuthCrypto, generateAuthKeys } from '../../../packages/infrastructure/security/src/crypto.js';
import { CatalogService } from '../../../packages/application/src/catalog-service.js';
import { StockService } from '../../../packages/application/src/stock-service.js';
import { CashService } from '../../../packages/application/src/cash-service.js';
import { SalesService } from '../../../packages/application/src/sales-service.js';
import { ReversalService } from '../../../packages/application/src/reversal-service.js';
import { ClosureService } from '../../../packages/application/src/closure-service.js';
import { sqliteBusinessUnitOfWork } from '../../../packages/infrastructure/sqlite/src/business.js';
import { businessHash } from '../../../packages/infrastructure/persistence/src/business-repository.js';
import { uuidGenerator } from '../../../packages/infrastructure/runtime/src/system.js';
import { businessIpcCommands, BusinessIpcResponse, businessEnvelope } from '../../../packages/contracts/src/catalog-stock.js';
import { executeBusiness } from './business.js';
import { LocalSyncService } from '../../../packages/application/src/local-sync-service.js';
import { sqliteLocalSyncUnitOfWork } from '../../../packages/infrastructure/sqlite/src/local-sync.js';
import { localSyncCommands, LocalSyncResponse } from '../../../packages/contracts/src/local-sync.js';
import { SyncEnvelope, SyncReceipt } from '../../../packages/contracts/src/sync.js';
import { syncEnvelopeHash } from '../../../packages/infrastructure/security/src/sync-validation.js';
import { SyncCoordinator } from '../../../packages/application/src/sync-coordinator.js';
import { LocalSyncResolutionService } from '../../../packages/application/src/local-sync-resolution.js';
import { sqliteCoordinatorUnitOfWork } from '../../../packages/infrastructure/sqlite/src/sync-replica.js';
import { syncGateway,syncHttpClient } from '../../../packages/infrastructure/security/src/sync-gateway.js';
import { ResolutionResponse } from '../../../packages/contracts/src/sync-resolutions.js';
import type { ResolutionResult } from '../../../packages/application/src/sync-resolution-ports.js';
import { syncLoop } from '../../../packages/infrastructure/runtime/src/sync-loop.js';

try {
  assertSupportedRuntime();
  const config = loadLocalConfig(process.env);
  const logger = createLogger('local-service', config.logLevel);
  const sqlite = config.databasePath === ':memory:' ? openSqliteRuntime(config.databasePath)
    : await openLocalPersistence(config.databasePath, config.identity!);
  const getDiagnostics = createGetLocalDiagnostics(sqlite.repository, systemClock);
  let localAuth: LocalAuthService | undefined;
  let cache:LocalIdentityCache|undefined;
  const network=new AbortController();
  const localSync='store'in sqlite&&sqlite.store instanceof SqliteStore?new LocalSyncService({unitOfWork:sqliteLocalSyncUnitOfWork(sqlite.store),storeId:config.identity!.store_id,deviceId:config.identity!.device_id,clock:systemClock,ids:uuidGenerator,hashEnvelope:syncEnvelopeHash,validateEnvelope:(value)=>Value.Check(SyncEnvelope,value),validateReceipt:(value)=>Value.Check(SyncReceipt,value),random:Math.random}):undefined;
  await localSync?.initialize();
  const business='store' in sqlite&&sqlite.store instanceof SqliteStore?{unitOfWork:sqliteBusinessUnitOfWork(sqlite.store),
    storeId:config.identity!.store_id,deviceId:config.identity!.device_id,local:true,clock:systemClock,ids:uuidGenerator,hash:businessHash,remoteWritesEnabled:false}:undefined;
  const catalog=business?new CatalogService(business):undefined,stock=business?new StockService(business):undefined;
  const cash=business?new CashService(business):undefined;
  const sales=business?new SalesService(business,async()=>String((await localAuth?.deviceStatus())?.code??'')):undefined;
  const reversal=business?new ReversalService(business):undefined,closure=business?new ClosureService(business):undefined;
  if ('store' in sqlite && sqlite.store instanceof SqliteStore && process.env.AUTH_API_ORIGIN) {
    const ephemeral = generateAuthKeys();
    cache=sqliteAuthCache(sqlite.store, windowsSecretProtector(`venprox-auth-v1:${config.identity!.store_id}:${config.identity!.device_id}`));
    localAuth = new LocalAuthService({ storeId: config.identity!.store_id, deviceId: config.identity!.device_id,
      cache,
      gateway: identityGateway(process.env.AUTH_API_ORIGIN), crypto: createAuthCrypto(ephemeral.privateKey,ephemeral.fingerprintKey), clock: systemClock });
  }
  const coordinator=localSync&&cache&&process.env.AUTH_API_ORIGIN&&'store'in sqlite&&sqlite.store instanceof SqliteStore?new SyncCoordinator({...localSync.deps,unitOfWork:sqliteCoordinatorUnitOfWork(sqlite.store),gateway:syncGateway(process.env.AUTH_API_ORIGIN,network.signal),device:()=>cache!.device(),proof:(id)=>cache!.proof!(id)}):undefined;
  const request=process.env.AUTH_API_ORIGIN?syncHttpClient(process.env.AUTH_API_ORIGIN,network.signal):undefined;
  const resolutions=coordinator&&request?new LocalSyncResolutionService(coordinator,async(device,id,command)=>(await request('/api/v1/admin/sync-resolutions',device,ResolutionResponse,command,true,{'idempotency-key':id})).data as ResolutionResult):undefined;
  if(coordinator)await coordinator.deps.unitOfWork.run((tx)=>tx.replica.state(config.syncEnabled?'starting':'disabled',null,systemClock.now().toISOString(),config.syncEnabled));
  const synchronization=config.syncEnabled&&coordinator?syncLoop(()=>coordinator.cycle(),config.syncPollMs,()=>logger.warn({event:'sync_cycle_unavailable'},'Ciclo de sincronização interrompido; pendências preservadas.')):undefined;
  // Mantém o processo dedicado vivo também na execução manual, sem abrir porta TCP.
  const keepAlive = setInterval(() => {}, 60_000);
  const shutdown = installShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    close: async () => {
      clearInterval(keepAlive);
      process.off('message', onMessage);
      network.abort();
      await synchronization?.stop();
      await coordinator?.exclusive(async()=>{});
      await sqlite.close();
      if (process.connected) process.disconnect();
    },
  });
  async function onMessage(message: unknown) {
    if(withinPayloadLimits(message)&&Value.Check(localSyncCommands,message)){
      try{
        if(!localAuth||!localSync)throw new ApplicationError('SYNC_NOT_CONFIGURED','Sincronização local não configurada.','unavailable');
        const {context}=await localAuth.getContext();
        let data:unknown;
        if(message.type==='sync.submitResolution'){
          if(!resolutions)throw new ApplicationError('SYNC_NOT_CONFIGURED','Sincronização local não configurada.','unavailable');
          const {type:_type,request_id:_request,intention_id,...command}=message;data=await resolutions.submit(context,intention_id,command);synchronization?.wake();
        }else data=message.type==='sync.getStatus'?await localSync.getStatus(context):message.type==='sync.requestRetry'?await localSync.requestRetry(context):await localSync.listConflicts(context);
        if(message.type==='sync.requestRetry')synchronization?.wake();
        const result={type:'sync.result',data,meta:{request_id:message.request_id}};
        if(!Value.Check(LocalSyncResponse,result))throw new Error('INVALID_SYNC_IPC_OUTPUT');
        if(process.connected)process.send?.(result);
      }catch(error){
        const response=error instanceof ApplicationError?errorResponse(error.code,error.message,message.request_id,[],error.retryable)
          :error instanceof PersistenceError?errorResponse(error.code,'Não foi possível ler a fila local; preserve os dados e confira o diagnóstico.',message.request_id,[],error.retryable)
          :errorResponse('LOCAL_SYNC_UNAVAILABLE','Não foi possível ler a fila local; preserve os dados e confira o diagnóstico.',message.request_id);
        if(process.connected)process.send?.({type:'error',...response});
      }return;
    }
    if(withinPayloadLimits(message)&&Value.Check(businessIpcCommands,message)){
      try{
        if(!localAuth||!catalog||!stock)throw new ApplicationError('BUSINESS_NOT_CONFIGURED','Operação local não configurada.','unavailable');
        const {context}=await localAuth.getContext();
        const data=await executeBusiness(message,context,catalog,stock,cash,sales,reversal,closure);
        const result=businessEnvelope(data,message.request_id);
        if(!Value.Check(BusinessIpcResponse,result))throw new Error('INVALID_IPC_OUTPUT');
        if(process.connected)process.send?.(result);
      }catch(error){
        const response=error instanceof ApplicationError?errorResponse(error.code,error.message,message.request_id,[],error.retryable,error.conflict)
          :error instanceof PersistenceError?errorResponse(error.code,'Não foi possível gravar ou consultar os dados locais. Preserve a intenção e confira o resultado antes de tentar novamente.',message.request_id,[],error.retryable)
          :errorResponse('BUSINESS_UNAVAILABLE','Não foi possível concluir a operação local.',message.request_id);
        if(process.connected)process.send?.({type:'error',...response});
      }return;
    }
    if (withinPayloadLimits(message) && Value.Check(authIpcCommands,message)) {
      try {
        if (!localAuth) throw new ApplicationError('AUTH_NOT_CONFIGURED','Identidade local não configurada.','unavailable');
        let data: unknown;
        switch (message.type) {
          case 'device.enroll': data = await localAuth.enroll(message.invitation_token); break;
          case 'device.getStatus': data = await localAuth.deviceStatus(); break;
          case 'auth.loginOnline': data = await localAuth.loginOnline(normalizeLoginKey(message.login),message.password); break;
          case 'auth.loginOffline': data = await localAuth.loginOffline(normalizeLoginKey(message.login),message.password); break;
          case 'auth.getContext': data = await localAuth.getContext(); break;
          case 'auth.logout': data = await localAuth.logout(); break;
        }
        const result = { type: 'auth.result', data, meta: { request_id: message.request_id } };
        if (!Value.Check(AuthIpcResponse,result)) throw new Error('INVALID_IPC_OUTPUT');
        if(message.type==='device.enroll'||message.type==='auth.loginOnline')synchronization?.wake();
        if (process.connected) process.send?.(result);
      } catch (error) {
        const response = error instanceof ApplicationError ? errorResponse(error.code,error.message,message.request_id,[],error.retryable)
          : errorResponse('IDENTITY_UNAVAILABLE','Não foi possível concluir o comando de identidade.',message.request_id);
        if (process.connected) process.send?.({ type: 'error', ...response });
      }
      return;
    }
    if (!withinPayloadLimits(message) || !Value.Check(LocalCommandSchema, message)) {
      logger.warn({ event: 'invalid_ipc_command' }, 'Comando IPC inválido.');
      if (process.connected) process.send?.({ type: 'error', ...errorResponse('INVALID_COMMAND', 'Comando IPC inválido.', 'invalid-ipc') });
      return;
    }
    if (message.type === 'shutdown') {
      void shutdown('ipc');
      return;
    }
    const result: LocalDiagnostics = { type: 'diagnostics', meta: { request_id: message.request_id }, data: getDiagnostics() };
    if (process.connected) process.send?.(result);
  }
  process.on('message', onMessage);
  logger.info({ event: 'ready', ...getDiagnostics() }, 'Serviço local iniciado sem dependência de rede.');
  if (process.connected) process.send?.({ type: 'ready', service: 'local-service' });
} catch (error) {
  reportBootFailure('local-service', error);
  if (process.connected) process.disconnect();
}
