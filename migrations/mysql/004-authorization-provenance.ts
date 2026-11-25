import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
const original = ['operation_id','store_id','device_id','occurred_at','action'];
export const mysqlAuthorizationMigration: Migration = { version: 4, steps: [
  {table:'audit_log',checkColumn:'actor_user_id',columns:[...original,'actor_user_id'],sql:'ALTER TABLE audit_log ADD COLUMN actor_user_id VARCHAR(36) NULL'},
  {table:'audit_log',checkColumn:'permissions_version',columns:[...original,'actor_user_id','permissions_version'],sql:'ALTER TABLE audit_log ADD COLUMN permissions_version INT NULL'},
  {table:'audit_log',checkColumn:'authorization_origin',columns:[...original,'actor_user_id','permissions_version','authorization_origin'],sql:"ALTER TABLE audit_log ADD COLUMN authorization_origin VARCHAR(20) NOT NULL DEFAULT 'technical'"},
  {table:'audit_log',checkColumn:'authorization_id',columns:[...original,'actor_user_id','permissions_version','authorization_origin','authorization_id'],sql:'ALTER TABLE audit_log ADD COLUMN authorization_id VARCHAR(36) NULL'},
  {table:'operation_outbox',checkColumn:'authorization_context',columns:['operation_id','store_id','device_id','device_seq','occurred_at','event_type','payload','state','authorization_context'],sql:'ALTER TABLE operation_outbox ADD COLUMN authorization_context TEXT NULL CHECK(authorization_context IS NULL OR JSON_VALID(authorization_context))'},
] };
