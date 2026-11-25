import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
// The remote job executor never opens the terminal SQLite.
export const sqliteJobsMigration:Migration={version:13,steps:[]};
