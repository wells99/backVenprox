import type { Logger } from 'pino';

export function installShutdown(options: {
  logger: Logger;
  timeoutMs: number;
  close: () => Promise<void> | void;
}) {
  let pending: Promise<void> | undefined;
  const onSignal = () => { void shutdown('signal'); };
  const onDisconnect = () => { void shutdown('parent_disconnected'); };

  function shutdown(reason: string): Promise<void> {
    if (pending) return pending;
    pending = (async () => {
      const timeout = setTimeout(() => {
        options.logger.error({ event: 'shutdown_timeout' }, 'Tempo de desligamento excedido.');
        process.exit(1);
      }, options.timeoutMs);
      options.logger.info({ event: 'shutdown_started', reason }, 'Encerrando processo.');
      try {
        await options.close();
        options.logger.info({ event: 'shutdown_complete' }, 'Processo encerrado.');
      } catch {
        options.logger.error({ event: 'shutdown_failed' }, 'Falha no desligamento.');
        process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('disconnect', onDisconnect);
      }
    })();
    return pending;
  }

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('disconnect', onDisconnect);
  return shutdown;
}
