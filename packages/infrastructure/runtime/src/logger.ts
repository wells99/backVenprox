import pino, { type DestinationStream } from 'pino';
import type { LogLevel } from './config.js';

export function createLogger(service: string, level: LogLevel, destination?: DestinationStream) {
  const options: pino.LoggerOptions = {
    name: service,
    level,
    base: { service },
    redact: {
      paths: [
        'password', 'token', 'secret', 'authorization', 'cookie',
        'installation_token','invitation_token','device_credential','access','refresh','csrf','private_key','password_hash',
        '*.password', '*.token', '*.secret', '*.authorization', '*.cookie',
        '*.installation_token','*.invitation_token','*.device_credential','*.access','*.refresh','*.csrf','*.password_hash',
        'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
        'req.body', 'body', 'connection', 'database_url',
      ],
      censor: '[REDACTED]',
    },
    // Mensagens/stack de drivers podem conter SQL, caminhos e senhas.
    serializers: { err: () => ({ code: 'INTERNAL_ERROR' }) },
  };
  return destination ? pino(options, destination) : pino(options);
}

export function reportBootFailure(service: string, error: unknown): void {
  const logger = createLogger(service, 'error');
  const field = error instanceof Error && error.name === 'ConfigurationError' && 'field' in error
    ? String(error.field) : undefined;
  logger.error({ event: 'boot_failed', code: field ? 'INVALID_CONFIGURATION' : 'STARTUP_FAILED', field },
    field ? `Configuração inválida: ${field}.` : 'Não foi possível iniciar o processo.');
  process.exitCode = 1;
}
