import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
import { sqliteSalesMigration } from './008-sales.js';
import { sqliteReversalMigration } from './009-reversals.js';
import { sqliteCashMigration } from './007-cash.js';
const definitions=[['sales','sales_period','store_id,local_commit_at,id'],['sale_items','sale_item_lookup','store_id,sale_id'],['sale_reversals','reversal_period','store_id,occurred_at,id'],['cash_movements','cash_period','store_id,occurred_at,kind,method']] as const;
export const sqliteQueryMigration:Migration={version:15,steps:definitions.map(([table,index,columns])=>({table,columns:[...sqliteSalesMigration.steps,...sqliteReversalMigration.steps,...sqliteCashMigration.steps].find((s)=>s.table===table)!.columns,sql:`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(${columns})`}))};
