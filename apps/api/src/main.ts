import { createCompatibilityPolicy } from '../../../packages/domain/src/compatibility.js';
import { createGetCompatibility } from '../../../packages/application/src/get-compatibility.js';
import { ConfigurationError, loadApiConfig } from '../../../packages/infrastructure/runtime/src/config.js';
import { createLogger, reportBootFailure } from '../../../packages/infrastructure/runtime/src/logger.js';
import { assertSupportedRuntime, backendVersion, uuidGenerator } from '../../../packages/infrastructure/runtime/src/system.js';
import { installShutdown } from '../../../packages/infrastructure/runtime/src/shutdown.js';
import { buildApi } from './app.js';
import { AuthService } from '../../../packages/application/src/auth-service.js';
import { MysqlStore } from '../../../packages/infrastructure/mysql/src/store.js';
import { authUnitOfWork } from '../../../packages/infrastructure/mysql/src/auth-repository.js';
import { loadAuthConfig } from '../../../packages/infrastructure/runtime/src/auth-config.js';
import { createAuthCrypto } from '../../../packages/infrastructure/security/src/crypto.js';
import { systemClock } from '../../../packages/infrastructure/runtime/src/system.js';
import { CatalogService } from '../../../packages/application/src/catalog-service.js';
import { StockService } from '../../../packages/application/src/stock-service.js';
import { CashService } from '../../../packages/application/src/cash-service.js';
import { mysqlBusinessUnitOfWork } from '../../../packages/infrastructure/mysql/src/business.js';
import { businessHash } from '../../../packages/infrastructure/persistence/src/business-repository.js';
import { catalogLabWrites } from '../../../packages/infrastructure/runtime/src/catalog-config.js';

try {
  assertSupportedRuntime();
  const config = loadApiConfig(process.env);
  const logger = createLogger('api', config.logLevel);
  let authStore: MysqlStore | undefined;
  let auth: Parameters<typeof buildApi>[0]['auth'];
  if(process.env.AUTH_ENABLED!==undefined && !['true','false'].includes(process.env.AUTH_ENABLED))throw new ConfigurationError('AUTH_ENABLED');
  if (process.env.AUTH_ENABLED === 'true') {
    const settings = loadAuthConfig(process.env);
    const remoteWritesEnabled=catalogLabWrites(process.env);
    authStore = await MysqlStore.connect(settings.mysql, { store_id: settings.storeId });
    try { await authStore.assertReady(); await authUnitOfWork(authStore).run(async () => {}); }
    catch (error) { await authStore.close(); throw error; }
    auth = { service: new AuthService({ unitOfWork: authUnitOfWork(authStore), storeId: settings.storeId,
      crypto: createAuthCrypto(settings.privateKey, settings.fingerprintKey), clock: systemClock, ids: uuidGenerator }),
      origin: settings.origin, secureCookies: settings.secureCookies };
    const business={unitOfWork:mysqlBusinessUnitOfWork(authStore),storeId:settings.storeId,deviceId:uuidGenerator.generate(),local:false,
      clock:systemClock,ids:uuidGenerator,hash:businessHash,remoteWritesEnabled};
    auth.business={catalog:new CatalogService(business),stock:new StockService(business),cash:new CashService(business)};
  }
  const app = buildApi({
    ...(auth ? { auth } : {}),
    environment: config.nodeEnv,
    logger,
    ids: uuidGenerator,
    getCompatibility: createGetCompatibility(createCompatibilityPolicy('0.1.0', [1]), backendVersion),
  });
  try {
    const address = await app.listen({ host: config.host, port: config.port });
    installShutdown({ logger, timeoutMs: config.shutdownTimeoutMs, close: async () => { await app.close(); await authStore?.close(); } });
    logger.info({ event: 'ready', address }, 'API iniciada.');
    if (process.send) process.send({ type: 'ready', service: 'api', address });
  } catch (error) {
    await app.close();
    await authStore?.close();
    throw error;
  }
} catch (error) {
  reportBootFailure('api', error);
  if (process.connected) process.disconnect();
}
