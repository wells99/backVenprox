import type { CatalogExportSource } from '../../../application/src/job-ports.js';
import type { MysqlStore } from './store.js';
import type { RowDataPacket } from 'mysql2/promise';
export function mysqlCatalogExport(store:MysqlStore):CatalogExportSource{
  const uow=store.unitOfWork((connection,_core,active)=>({read:async(includeCosts:boolean,signal:AbortSignal)=>{
    active();signal.throwIfAborted();
    await connection.query('SELECT store_id FROM instance_identity WHERE store_id=? FOR UPDATE',[store.identity.store_id]);
    const [rows]=await connection.query<RowDataPacket[]>(`SELECT id,name,internal_code,unit,price_cents,category_id,active,version${includeCosts?',cost_cents':''} FROM products WHERE store_id=? ORDER BY id LIMIT 1001 FOR UPDATE`,[store.identity.store_id]);
    signal.throwIfAborted();return rows.map((row)=>({...row,active:Number(row.active)===1}));
  }}));
  return {read:(includeCosts,signal)=>uow.run((tx)=>tx.read(includeCosts,signal))};
}
