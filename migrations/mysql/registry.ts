import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
import { mysqlPublicationMigration } from './011-publication.js';
import { mysqlLocalSyncMigration } from './012-local-sync-protocol.js';
import { mysqlJobsMigration } from './013-jobs.js';
import { mysqlSyncResolutionsMigration } from './014-sync-resolutions.js';
import { mysqlAuthMigration } from './003-auth.js';
import { mysqlAuthorizationMigration } from './004-authorization-provenance.js';
import { mysqlCatalogMigration } from './005-catalog.js';
import { mysqlStockMigration } from './006-stock.js';
import { mysqlCashMigration } from './007-cash.js';
import { mysqlSalesMigration } from './008-sales.js';
import { mysqlReversalMigration } from './009-reversals.js';
import { mysqlSyncMigration } from './010-sync.js';

const suffix = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
export const mysqlMigrations: readonly Migration[] = [
  { version: 1, steps: [
    { table: 'instance_identity', columns: ['singleton','store_id'], sql: `CREATE TABLE IF NOT EXISTS instance_identity (
      singleton TINYINT PRIMARY KEY CHECK(singleton=1), store_id VARCHAR(36) NOT NULL UNIQUE)${suffix}` },
    { table: 'device_sequences', columns: ['store_id','device_id','sequence_value'], sql: `CREATE TABLE IF NOT EXISTS device_sequences (
      store_id VARCHAR(36) NOT NULL, device_id VARCHAR(36) NOT NULL, sequence_value BIGINT NOT NULL CHECK(sequence_value>=0),
      PRIMARY KEY(store_id,device_id), FOREIGN KEY(store_id) REFERENCES instance_identity(store_id))${suffix}` },
    { table: 'operation_outbox', columns: ['operation_id','store_id','device_id','device_seq','occurred_at','event_type','payload','state'], sql: `CREATE TABLE IF NOT EXISTS operation_outbox (
      operation_id VARCHAR(36) PRIMARY KEY, store_id VARCHAR(36) NOT NULL, device_id VARCHAR(36) NOT NULL, device_seq BIGINT NOT NULL CHECK(device_seq>0),
      occurred_at VARCHAR(30) NOT NULL, event_type VARCHAR(100) NOT NULL, payload MEDIUMTEXT NOT NULL CHECK(JSON_VALID(payload)),
      state VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','acknowledged')),
      UNIQUE(store_id,device_id,device_seq), FOREIGN KEY(store_id,device_id) REFERENCES device_sequences(store_id,device_id))${suffix}` },
    { table: 'audit_log', columns: ['operation_id','store_id','device_id','occurred_at','action'], sql: `CREATE TABLE IF NOT EXISTS audit_log (
      operation_id VARCHAR(36) NOT NULL, store_id VARCHAR(36) NOT NULL, device_id VARCHAR(36) NOT NULL, occurred_at VARCHAR(30) NOT NULL,
      action VARCHAR(100) NOT NULL, PRIMARY KEY(operation_id,action), FOREIGN KEY(store_id) REFERENCES instance_identity(store_id))${suffix}` },
  ] },
  { version: 2, steps: [{ table: 'operation_outbox', columns: ['operation_id','store_id','device_id','device_seq','occurred_at','event_type','payload','state'],
    sql: 'CREATE INDEX outbox_pending ON operation_outbox(state,store_id,device_id,device_seq)' }] },
  mysqlAuthMigration,
  mysqlAuthorizationMigration,
  mysqlCatalogMigration,
  mysqlStockMigration,
  mysqlCashMigration,
  mysqlSalesMigration,
  mysqlReversalMigration,
  mysqlSyncMigration,
  mysqlPublicationMigration,
  mysqlLocalSyncMigration,
  mysqlJobsMigration,
  mysqlSyncResolutionsMigration,
];
