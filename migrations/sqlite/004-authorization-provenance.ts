import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
const original = ['operation_id','store_id','device_id','occurred_at','action'];
export const sqliteAuthorizationMigration: Migration = { version: 4, steps: [
  {table:'audit_log',columns:[...original,'actor_user_id'],sql:'ALTER TABLE audit_log ADD COLUMN actor_user_id TEXT'},
  {table:'audit_log',columns:[...original,'actor_user_id','permissions_version'],sql:'ALTER TABLE audit_log ADD COLUMN permissions_version INTEGER'},
  {table:'audit_log',columns:[...original,'actor_user_id','permissions_version','authorization_origin'],sql:"ALTER TABLE audit_log ADD COLUMN authorization_origin TEXT NOT NULL DEFAULT 'technical'"},
  {table:'audit_log',columns:[...original,'actor_user_id','permissions_version','authorization_origin','authorization_id'],sql:'ALTER TABLE audit_log ADD COLUMN authorization_id TEXT'},
  {table:'operation_outbox',columns:['operation_id','store_id','device_id','device_seq','occurred_at','event_type','payload','state','authorization_context'],sql:'ALTER TABLE operation_outbox ADD COLUMN authorization_context TEXT CHECK(authorization_context IS NULL OR json_valid(authorization_context))'},
] };
