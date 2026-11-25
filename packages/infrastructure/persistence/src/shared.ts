import { createHash } from 'node:crypto';
import { PersistenceError, type DatabaseIdentity, type OperationRecord } from '../../../application/src/persistence.js';

export interface MigrationStep { sql: string; table: string; columns: readonly string[]; checkColumn?: string }
export interface Migration { version: number; steps: readonly MigrationStep[] }
export const checksum = (migration: Migration) => createHash('sha256').update(JSON.stringify(migration)).digest('hex');
export const maxSequence = 9223372036854775807n;
export function assertIdentity(actual: DatabaseIdentity | undefined, expected: DatabaseIdentity) {
  if (!actual || actual.store_id !== expected.store_id || actual.device_id !== expected.device_id) throw new PersistenceError('IDENTITY_MISMATCH');
}
export function assertUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new PersistenceError('INVALID_PERSISTED_VALUE');
}
export function validateOperation(value: OperationRecord, identity: DatabaseIdentity) {
  assertUuid(value.operation_id); assertUuid(value.store_id); assertUuid(value.device_id);
  if (value.store_id !== identity.store_id || (identity.device_id && identity.device_id !== value.device_id)) throw new PersistenceError('IDENTITY_MISMATCH');
  if (!/^[1-9][0-9]{0,18}$/.test(value.device_seq) || BigInt(value.device_seq) > maxSequence ||
      !value.event_type || value.event_type.length > 100 || value.payload.length > 65536 ||
      !/^\d{4}-\d\d-\d\dT.*Z$/.test(value.occurred_at) || !Number.isFinite(Date.parse(value.occurred_at))) throw new PersistenceError('INVALID_PERSISTED_VALUE');
  try { JSON.parse(value.payload); } catch { throw new PersistenceError('INVALID_PERSISTED_VALUE'); }
  if(value.authorization) {
    const context=value.authorization;
    assertUuid(context.user_id);assertUuid(context.authorization_id);
    if(context.store_id!==value.store_id || (context.device_id!==value.device_id&&!(context.device_id===null&&!identity.device_id&&context.authorization_origin==='online')) || !Number.isSafeInteger(context.permissions_version) || context.permissions_version<1 ||
      !['online','offline'].includes(context.authorization_origin) || !Array.isArray(context.permissions)) throw new PersistenceError('IDENTITY_MISMATCH');
  }
}
export function translatePersistenceError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ER_DUP_ENTRY' || code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return new PersistenceError('UNIQUE_CONFLICT');
  if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2' || code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return new PersistenceError('FOREIGN_KEY_CONFLICT');
  if (code === 'ER_LOCK_DEADLOCK') return new PersistenceError('DEADLOCK', true);
  if (code === 'ER_LOCK_WAIT_TIMEOUT' || code.startsWith('SQLITE_BUSY') || code === 'SQLITE_LOCKED' || code === 'EEXIST') return new PersistenceError('DATABASE_BUSY', true);
  if (['SQLITE_FULL', 'ENOSPC', 'ER_DISK_FULL'].includes(code)) return new PersistenceError('DATABASE_FULL');
  if (['SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(code)) return new PersistenceError('DATABASE_CORRUPT');
  if (['EACCES', 'EPERM', 'SQLITE_READONLY', 'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR'].includes(code)) return new PersistenceError('DATABASE_PERMISSION');
  if (['ENOENT', 'ER_BAD_DB_ERROR', 'SQLITE_CANTOPEN'].includes(code)) return new PersistenceError('DATABASE_MISSING');
  if (code.startsWith('SQLITE_CONSTRAINT') || code === 'ER_CHECK_CONSTRAINT_VIOLATED' || code === 'ER_WARN_DATA_OUT_OF_RANGE') return new PersistenceError('INVALID_PERSISTED_VALUE');
  return new PersistenceError('DATABASE_UNAVAILABLE', true);
}
