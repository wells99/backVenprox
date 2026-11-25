import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
// B12 first slice is local. Administrative resolution DDL belongs to its next slice.
export const mysqlLocalSyncMigration:Migration={version:12,steps:[]};
