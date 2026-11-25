import type { Audit, UnitOfWork } from './ports.js';
import type { AuthorizedContext } from '../../domain/src/authorization.js';

export interface OperationRecord {
  operation_id: string;
  store_id: string;
  device_id: string;
  device_seq: string;
  occurred_at: string;
  event_type: string;
  payload: string;
  authorization?: AuthorizedContext;
}
export interface PersistenceRepositories {
  sequences: { next(deviceId: string): Promise<string> };
  outbox: { append(operation: OperationRecord): Promise<void> };
  audit: Audit;
}
export type PersistenceUnitOfWork = UnitOfWork<PersistenceRepositories>;
export interface DatabaseIdentity { store_id: string; device_id?: string }

export type PersistenceFailure = 'DATABASE_MISSING' | 'DATABASE_UNAVAILABLE' | 'DATABASE_BUSY' | 'DATABASE_PERMISSION'
  | 'DATABASE_FULL' | 'DATABASE_CORRUPT' | 'SCHEMA_INCOMPATIBLE' | 'MIGRATION_FAILED' | 'CHECKSUM_MISMATCH'
  | 'IDENTITY_MISMATCH' | 'UNIQUE_CONFLICT' | 'FOREIGN_KEY_CONFLICT' | 'DEADLOCK' | 'INVALID_PERSISTED_VALUE' | 'TRANSACTION_CLOSED';
export class PersistenceError extends Error {
  constructor(readonly code: PersistenceFailure, readonly retryable = false) { super(code); }
}
