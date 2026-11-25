import { Type, type Static } from 'typebox';
import { ErrorSchema, RequestIdSchema, UtcInstantSchema } from './common.js';

export const LocalDiagnosticsSchema = Type.Object({
  type: Type.Literal('diagnostics'),
  data: Type.Object({
    status: Type.Literal('ok'), checked_at: UtcInstantSchema, persistence_ready: Type.Boolean(),
    schema_version: Type.Optional(Type.Integer({ minimum: 1 })), migration_state: Type.Optional(Type.Literal('applied')),
    engine: Type.Literal('sqlite'), engine_version: Type.String(),
    storage_mode: Type.Union([Type.Literal('ephemeral'), Type.Literal('existing_file')]),
  }, { additionalProperties: false }),
  meta: Type.Object({ request_id: RequestIdSchema }, { additionalProperties: false }),
}, { additionalProperties: false });
export const LocalErrorSchema = Type.Object({ type: Type.Literal('error'), error: ErrorSchema.properties.error }, { additionalProperties: false });
export type LocalDiagnostics = Static<typeof LocalDiagnosticsSchema>;
export const ipcCatalog = {
  diagnostics: { dto: 'LocalCommandSchema', permission: 'trusted_supervisor', use_case: 'getLocalDiagnostics', response: 'LocalDiagnosticsSchema' },
  shutdown: { dto: 'LocalCommandSchema', permission: 'trusted_supervisor', use_case: 'controlledShutdown', response: 'process_exit' },
  'device.enroll': { dto: 'authIpcCommands', permission: 'trusted_supervisor_and_one_time_invitation', use_case: 'enroll', response: 'AuthIpcResponse' },
  'device.getStatus': { dto: 'authIpcCommands', permission: 'trusted_supervisor', use_case: 'deviceStatus', response: 'AuthIpcResponse' },
  'auth.loginOnline': { dto: 'authIpcCommands', permission: 'paired_terminal_and_online_user', use_case: 'loginOnline', response: 'AuthIpcResponse' },
  'auth.loginOffline': { dto: 'authIpcCommands', permission: 'paired_terminal_and_signed_unexpired_grant', use_case: 'loginOffline', response: 'AuthIpcResponse' },
  'auth.getContext': { dto: 'authIpcCommands', permission: 'authorized_user', use_case: 'getContext', response: 'AuthIpcResponse' },
  'auth.logout': { dto: 'authIpcCommands', permission: 'trusted_supervisor', use_case: 'logout', response: 'AuthIpcResponse' },
} as const;
