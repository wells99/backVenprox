import type { Migration } from '../../packages/infrastructure/persistence/src/shared.js';
const suffix=' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
export const mysqlCashMigration:Migration={version:7,steps:[
  {table:'cash_sessions',columns:['id','store_id','device_id','operator_id','opened_at','business_date','time_zone','opening_cents','status','version','open_device'],sql:`CREATE TABLE IF NOT EXISTS cash_sessions(
    id VARCHAR(36) PRIMARY KEY,store_id VARCHAR(36) NOT NULL,device_id VARCHAR(36) NOT NULL,operator_id VARCHAR(36) NOT NULL,opened_at VARCHAR(30) NOT NULL,business_date VARCHAR(10) NOT NULL,time_zone VARCHAR(100) NOT NULL,
    opening_cents BIGINT NOT NULL CHECK(opening_cents BETWEEN 0 AND 9007199254740991),status VARCHAR(10) NOT NULL CHECK(status IN('open','closed')),version BIGINT NOT NULL CHECK(version>0),open_device VARCHAR(36) NULL,
    CHECK((status='open' AND open_device IS NOT NULL AND open_device=device_id) OR(status='closed' AND open_device IS NULL)),UNIQUE(store_id,open_device),UNIQUE(store_id,id),UNIQUE(store_id,id,device_id),FOREIGN KEY(store_id) REFERENCES instance_identity(store_id))${suffix}`},
  {table:'cash_movements',columns:['id','store_id','session_id','device_id','operator_id','operation_id','origin_id','component_id','kind','method','amount_cents','reason','occurred_at'],sql:`CREATE TABLE IF NOT EXISTS cash_movements(
    id VARCHAR(36) PRIMARY KEY,store_id VARCHAR(36) NOT NULL,session_id VARCHAR(36) NOT NULL,device_id VARCHAR(36) NOT NULL,operator_id VARCHAR(36) NOT NULL,operation_id VARCHAR(36) NOT NULL,origin_id VARCHAR(36) NOT NULL,component_id VARCHAR(36) NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK(kind IN('opening','supply','withdrawal','sale','refund','credit_receipt')),method VARCHAR(10) NOT NULL CHECK(method IN('cash','credit','debit','pix')),
    amount_cents BIGINT NOT NULL CHECK(amount_cents BETWEEN -9007199254740991 AND 9007199254740991),reason VARCHAR(500) NOT NULL,occurred_at VARCHAR(30) NOT NULL,
    CHECK((kind='opening' AND amount_cents>=0 AND method='cash') OR(kind='supply' AND amount_cents>0 AND method='cash') OR(kind='withdrawal' AND amount_cents<0 AND method='cash') OR(kind IN('sale','credit_receipt') AND amount_cents>0) OR(kind='refund' AND amount_cents<0)),
    UNIQUE(store_id,origin_id,kind,component_id),INDEX cash_history(store_id,session_id,id),FOREIGN KEY(store_id,session_id,device_id) REFERENCES cash_sessions(store_id,id,device_id))${suffix}`},
]};
