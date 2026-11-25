import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
export const sqliteCashMigration:Migration={version:7,steps:[
  {table:'cash_sessions',columns:['id','store_id','device_id','operator_id','opened_at','business_date','time_zone','opening_cents','status','version','open_device'],sql:`CREATE TABLE IF NOT EXISTS cash_sessions(
    id TEXT PRIMARY KEY NOT NULL,store_id TEXT NOT NULL,device_id TEXT NOT NULL,operator_id TEXT NOT NULL,opened_at TEXT NOT NULL,business_date TEXT NOT NULL,time_zone TEXT NOT NULL,
    opening_cents INTEGER NOT NULL CHECK(opening_cents BETWEEN 0 AND 9007199254740991),status TEXT NOT NULL CHECK(status IN('open','closed')),version INTEGER NOT NULL CHECK(version>0),open_device TEXT,
    CHECK((status='open' AND open_device IS NOT NULL AND open_device=device_id) OR(status='closed' AND open_device IS NULL)),UNIQUE(store_id,open_device),UNIQUE(store_id,id),UNIQUE(store_id,id,device_id),FOREIGN KEY(store_id) REFERENCES instance_identity(store_id))`},
  {table:'cash_movements',columns:['id','store_id','session_id','device_id','operator_id','operation_id','origin_id','component_id','kind','method','amount_cents','reason','occurred_at'],sql:`CREATE TABLE IF NOT EXISTS cash_movements(
    id TEXT PRIMARY KEY NOT NULL,store_id TEXT NOT NULL,session_id TEXT NOT NULL,device_id TEXT NOT NULL,operator_id TEXT NOT NULL,operation_id TEXT NOT NULL,origin_id TEXT NOT NULL,component_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN('opening','supply','withdrawal','sale','refund','credit_receipt')),method TEXT NOT NULL CHECK(method IN('cash','credit','debit','pix')),
    amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN -9007199254740991 AND 9007199254740991),reason TEXT NOT NULL,occurred_at TEXT NOT NULL,
    CHECK((kind='opening' AND amount_cents>=0 AND method='cash') OR(kind='supply' AND amount_cents>0 AND method='cash') OR(kind='withdrawal' AND amount_cents<0 AND method='cash') OR(kind IN('sale','credit_receipt') AND amount_cents>0) OR(kind='refund' AND amount_cents<0)),
    UNIQUE(store_id,origin_id,kind,component_id),FOREIGN KEY(store_id,session_id,device_id) REFERENCES cash_sessions(store_id,id,device_id))`},
]};
