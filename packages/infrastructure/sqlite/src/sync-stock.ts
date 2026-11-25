import type Database from 'better-sqlite3';
import { ApplicationError } from '../../../application/src/application-error.js';
export function syncStockQuantity(db:Database.Database,productId:string,baselineSeq:string):bigint{
  const base=(db.prepare('SELECT quantity_milli FROM sync_stock_base WHERE product_id=?').get(productId) as {quantity_milli:number}|undefined)?.quantity_milli??0;
  const pending=db.prepare('SELECT CAST(m.delta_milli AS TEXT) AS delta FROM stock_movements m LEFT JOIN sync_local_movements l ON l.movement_id=m.id WHERE m.product_id=? AND (l.movement_id IS NULL OR(l.device_seq>CAST(? AS INTEGER) AND NOT EXISTS(SELECT 1 FROM sync_received_operations o WHERE o.operation_id=l.operation_id)))').all(productId,baselineSeq) as {delta:string}[];
  const total=pending.reduce((sum,r)=>sum+BigInt(r.delta),BigInt(base));
  if(total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(-Number.MAX_SAFE_INTEGER))throw new ApplicationError('SYNC_STOCK_OUT_OF_RANGE','Projeção de estoque fora da faixa suportada.','conflict');
  return total;
}
