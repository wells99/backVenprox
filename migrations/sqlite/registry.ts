import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
import { sqliteAuthMigration } from './003-auth.js';
import { sqliteAuthorizationMigration } from './004-authorization-provenance.js';

export const sqliteMigrations: readonly Migration[] = [
  { version: 1, steps: [
    { table: 'instance_identity', columns: ['singleton', 'store_id', 'device_id'], sql: `CREATE TABLE IF NOT EXISTS instance_identity (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL)` },
    { table: 'device_sequences', columns: ['store_id', 'device_id', 'sequence_value'], sql: `CREATE TABLE IF NOT EXISTS device_sequences (
      store_id TEXT NOT NULL, device_id TEXT NOT NULL, sequence_value INTEGER NOT NULL CHECK(sequence_value>=0),
      PRIMARY KEY(store_id,device_id), FOREIGN KEY(store_id) REFERENCES instance_identity(store_id))` },
    { table: 'operation_outbox', columns: ['operation_id','store_id','device_id','device_seq','occurred_at','event_type','payload','state'], sql: `CREATE TABLE IF NOT EXISTS operation_outbox (
      operation_id TEXT PRIMARY KEY NOT NULL, store_id TEXT NOT NULL, device_id TEXT NOT NULL, device_seq INTEGER NOT NULL CHECK(device_seq>0),
      occurred_at TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','acknowledged')),
      UNIQUE(store_id,device_id,device_seq), FOREIGN KEY(store_id,device_id) REFERENCES device_sequences(store_id,device_id))` },
    { table: 'audit_log', columns: ['operation_id','store_id','device_id','occurred_at','action'], sql: `CREATE TABLE IF NOT EXISTS audit_log (
      operation_id TEXT NOT NULL, store_id TEXT NOT NULL, device_id TEXT NOT NULL, occurred_at TEXT NOT NULL, action TEXT NOT NULL,
      PRIMARY KEY(operation_id,action), FOREIGN KEY(store_id) REFERENCES instance_identity(store_id))` },
  ] },
  { version: 2, steps: [{ table: 'operation_outbox', columns: ['operation_id','store_id','device_id','device_seq','occurred_at','event_type','payload','state'],
    sql: 'CREATE INDEX IF NOT EXISTS outbox_pending ON operation_outbox(state,store_id,device_id,device_seq)' }] },
  sqliteAuthMigration,
  sqliteAuthorizationMigration,
];
