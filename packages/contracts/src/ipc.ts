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
  'sales.createDraft':{dto:'businessIpcCommands',permission:'sales.create (+sales.discount)',use_case:'SalesService.createDraft',response:'BusinessIpcResponse'},
  'sales.getDraft':{dto:'businessIpcCommands',permission:'sales.read',use_case:'SalesService.getDraft',response:'BusinessIpcResponse'},
  'sales.updateDraft':{dto:'businessIpcCommands',permission:'sales.create (+sales.discount)',use_case:'SalesService.updateDraft',response:'BusinessIpcResponse'},
  'sales.complete':{dto:'businessIpcCommands',permission:'sales.create (+sales.discount)',use_case:'SalesService.complete',response:'BusinessIpcResponse'},
  'sales.getCompletionResult':{dto:'businessIpcCommands',permission:'sales.read',use_case:'SalesService.getCompletionResult',response:'BusinessIpcResponse'},
  'cash.getCurrent':{dto:'businessIpcCommands',permission:'sales.read',use_case:'CashService.current',response:'BusinessIpcResponse'},
  'cash.listSessions':{dto:'businessIpcCommands',permission:'sales.read',use_case:'CashService.list',response:'BusinessIpcResponse'},
  'cash.getSession':{dto:'businessIpcCommands',permission:'sales.read',use_case:'CashService.get',response:'BusinessIpcResponse'},
  'cash.getMovements':{dto:'businessIpcCommands',permission:'sales.read',use_case:'CashService.movements',response:'BusinessIpcResponse'},
  'cash.open':{dto:'businessIpcCommands',permission:'cash.open',use_case:'CashService.open',response:'BusinessIpcResponse'},
  'cash.registerSupply':{dto:'businessIpcCommands',permission:'cash.adjust',use_case:'CashService.register',response:'BusinessIpcResponse'},
  'cash.registerWithdrawal':{dto:'businessIpcCommands',permission:'cash.adjust',use_case:'CashService.register',response:'BusinessIpcResponse'},
  diagnostics: { dto: 'LocalCommandSchema', permission: 'trusted_supervisor', use_case: 'getLocalDiagnostics', response: 'LocalDiagnosticsSchema' },
  shutdown: { dto: 'LocalCommandSchema', permission: 'trusted_supervisor', use_case: 'controlledShutdown', response: 'process_exit' },
  'device.enroll': { dto: 'authIpcCommands', permission: 'trusted_supervisor_and_one_time_invitation', use_case: 'enroll', response: 'AuthIpcResponse' },
  'device.getStatus': { dto: 'authIpcCommands', permission: 'trusted_supervisor', use_case: 'deviceStatus', response: 'AuthIpcResponse' },
  'auth.loginOnline': { dto: 'authIpcCommands', permission: 'paired_terminal_and_online_user', use_case: 'loginOnline', response: 'AuthIpcResponse' },
  'auth.loginOffline': { dto: 'authIpcCommands', permission: 'paired_terminal_and_signed_unexpired_grant', use_case: 'loginOffline', response: 'AuthIpcResponse' },
  'auth.getContext': { dto: 'authIpcCommands', permission: 'authorized_user', use_case: 'getContext', response: 'AuthIpcResponse' },
  'auth.logout': { dto: 'authIpcCommands', permission: 'trusted_supervisor', use_case: 'logout', response: 'AuthIpcResponse' },
  'catalog.search': { dto:'businessIpcCommands',permission:'catalog.read',use_case:'CatalogService.list',response:'BusinessIpcResponse' },
  'catalog.getPending': { dto:'businessIpcCommands',permission:'catalog.read',use_case:'CatalogService.pending',response:'BusinessIpcResponse' },
  'products.proposeCreate': { dto:'businessIpcCommands',permission:'catalog.write',use_case:'CatalogService.createProduct',response:'BusinessIpcResponse' },
  'products.proposeUpdate': { dto:'businessIpcCommands',permission:'catalog.write',use_case:'CatalogService.updateProduct',response:'BusinessIpcResponse' },
  'categories.proposeUpdate': { dto:'businessIpcCommands',permission:'catalog.write',use_case:'CatalogService.updateCategory',response:'BusinessIpcResponse' },
  'customers.createMinimal': { dto:'businessIpcCommands',permission:'sales.create',use_case:'CatalogService.createCustomer',response:'BusinessIpcResponse' },
  'customers.proposeUpdate': { dto:'businessIpcCommands',permission:'catalog.write',use_case:'CatalogService.updateCustomer',response:'BusinessIpcResponse' },
  'settings.get': { dto:'businessIpcCommands',permission:'catalog.read',use_case:'CatalogService.settings',response:'BusinessIpcResponse' },
  'settings.change': { dto:'businessIpcCommands',permission:'settings.manage',use_case:'CatalogService.changeSettings',response:'BusinessIpcResponse' },
  'settings.changeTerminal': { dto:'businessIpcCommands',permission:'settings.manage',use_case:'CatalogService.changeTerminalSettings',response:'BusinessIpcResponse' },
  'stock.getBalances': { dto:'businessIpcCommands',permission:'catalog.read',use_case:'StockService.balances',response:'BusinessIpcResponse' },
  'stock.getMovements': { dto:'businessIpcCommands',permission:'catalog.read',use_case:'StockService.movements',response:'BusinessIpcResponse' },
  'stock.registerEntry': { dto:'businessIpcCommands',permission:'stock.adjust',use_case:'StockService.registerEntry',response:'BusinessIpcResponse' },
  'stock.adjustCount': { dto:'businessIpcCommands',permission:'stock.adjust',use_case:'StockService.adjustCount',response:'BusinessIpcResponse' },
  'stock.rebuildProjection': { dto:'businessIpcCommands',permission:'recovery.manage',use_case:'StockService.rebuild',response:'BusinessIpcResponse' },
} as const;
