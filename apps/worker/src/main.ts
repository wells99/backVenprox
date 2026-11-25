import { loadWorkerConfig } from '../../../packages/infrastructure/runtime/src/config.js';
import { createLogger, reportBootFailure } from '../../../packages/infrastructure/runtime/src/logger.js';
import { assertSupportedRuntime } from '../../../packages/infrastructure/runtime/src/system.js';
import { installShutdown } from '../../../packages/infrastructure/runtime/src/shutdown.js';

try {
  assertSupportedRuntime();
  const config = loadWorkerConfig(process.env);
  const logger = createLogger('worker', config.logLevel);
  const keepAlive = setInterval(() => {}, 60_000);
  installShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    close: () => {
      clearInterval(keepAlive);
      if (process.connected) process.disconnect();
    },
  });
  logger.info({ event: 'ready', mode: config.mode, jobs_enabled: false }, 'Worker em espera; fila ainda não implementada.');
  if (process.connected) process.send?.({ type: 'ready', service: 'worker', jobs_enabled: false });
} catch (error) {
  reportBootFailure('worker', error);
  if (process.connected) process.disconnect();
}
