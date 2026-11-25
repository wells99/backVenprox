import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
// Alinha compatibilidade de schema; inbox é exclusivamente remota. B12 evolui a fila local.
export const sqliteSyncMigration:Migration={version:10,steps:[]};
