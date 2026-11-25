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
import { LocalAuthService } from '../../../packages/application/src/local-auth.js';
import { ApplicationError } from '../../../packages/application/src/application-error.js';
import { authIpcCommands, AuthIpcResponse } from '../../../packages/contracts/src/auth.js';
import { normalizeLoginKey } from '../../../packages/contracts/src/common.js';
import { sqliteAuthCache } from '../../../packages/infrastructure/sqlite/src/auth-cache.js';
import { windowsSecretProtector } from '../../../packages/infrastructure/native/src/dpapi.js';
import { identityGateway } from '../../../packages/infrastructure/security/src/identity-gateway.js';
import { createAuthCrypto, generateAuthKeys } from '../../../packages/infrastructure/security/src/crypto.js';

try {
  assertSupportedRuntime();
  const config = loadLocalConfig(process.env);
  const logger = createLogger('local-service', config.logLevel);
  const sqlite = config.databasePath === ':memory:' ? openSqliteRuntime(config.databasePath)
    : await openLocalPersistence(config.databasePath, config.identity!);
  const getDiagnostics = createGetLocalDiagnostics(sqlite.repository, systemClock);
  let localAuth: LocalAuthService | undefined;
  if ('store' in sqlite && sqlite.store instanceof SqliteStore && process.env.AUTH_API_ORIGIN) {
    const ephemeral = generateAuthKeys();
    localAuth = new LocalAuthService({ storeId: config.identity!.store_id, deviceId: config.identity!.device_id,
      cache: sqliteAuthCache(sqlite.store, windowsSecretProtector(`venprox-auth-v1:${config.identity!.store_id}:${config.identity!.device_id}`)),
      gateway: identityGateway(process.env.AUTH_API_ORIGIN), crypto: createAuthCrypto(ephemeral.privateKey,ephemeral.fingerprintKey), clock: systemClock });
  }
  // Mantém o processo dedicado vivo também na execução manual, sem abrir porta TCP.
  const keepAlive = setInterval(() => {}, 60_000);
  const shutdown = installShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    close: async () => {
      clearInterval(keepAlive);
      process.off('message', onMessage);
      await sqlite.close();
      if (process.connected) process.disconnect();
    },
  });
  async function onMessage(message: unknown) {
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
