import type { Clock, RuntimeDiagnosticsRepository } from './ports.js';

export function createGetLocalDiagnostics(
  repository: RuntimeDiagnosticsRepository,
  clock: Clock,
) {
  return () => {
    const runtime = repository.inspect();
    return ({
    status: 'ok' as const,
    checked_at: clock.now().toISOString(),
    ...runtime,
    persistence_ready: runtime.persistence_ready ?? false,
  });
  };
}
