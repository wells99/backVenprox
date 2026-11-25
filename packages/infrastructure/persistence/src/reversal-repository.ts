import type { CashClosure, ReversalRepository, SaleReversal, ReversalItem, RefundPayment } from '../../../application/src/reversal-ports.js';
import type { BusinessSql } from './business-repository.js';
import { ApplicationError } from '../../../application/src/application-error.js';
export function reversalRepository(sql:BusinessSql,storeId:string):ReversalRepository {
  async function rows<T>(table:string,predicate:string,values:unknown[]):Promise<T[]>{sql.active();return (await sql.all(`SELECT * FROM ${table} WHERE store_id=? ${predicate}`,[storeId,...values])).map((row)=>Object.fromEntries(Object.entries(row).map(([key,value])=>{
    if(value!==null&&(key.endsWith('_cents')||['quantity_milli','session_version'].includes(key))){const n=Number(value);if(!Number.isSafeInteger(n))throw new ApplicationError('INVALID_PERSISTED_NUMBER','Valor inválido.','unavailable');return[key,n];}return[key,value];
  }))) as T[];}
  async function insert(table:string,value:object){sql.active();const record=value as Record<string,unknown>;if(record.store_id!==storeId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');const keys=Object.keys(record);await sql.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,Object.values(record));}
  return {
    reversalForSale:async(id)=>{const reversal=(await rows<SaleReversal>('sale_reversals','AND sale_id=?',[id]))[0];return reversal?{reversal,items:await rows<ReversalItem>('reversal_items','AND reversal_id=? ORDER BY id',[reversal.id]),payments:await rows<RefundPayment>('refund_payments','AND reversal_id=? ORDER BY id',[reversal.id])}:undefined;},
    insertReversal:(v)=>insert('sale_reversals',v),insertReversalItem:(v)=>insert('reversal_items',v),insertRefundPayment:(v)=>insert('refund_payments',v),
    cashClosure:async(id)=>(await rows<CashClosure>('cash_closures','AND session_id=?',[id]))[0],insertCashClosure:(v)=>insert('cash_closures',v),
    closeCashSession:async(id)=>{sql.active();await sql.run("UPDATE cash_sessions SET status='closed',open_device=NULL,version=version+1 WHERE store_id=? AND id=? AND status='open'",[storeId,id]);},
    cashFrontier:async(id)=>{sql.active();const rows=await sql.all('SELECT o.device_seq FROM operation_outbox o JOIN cash_movements m ON m.store_id=o.store_id AND m.operation_id=o.operation_id WHERE m.store_id=? AND m.session_id=?',[storeId,id]);return rows.reduce((n,row)=>BigInt(String(row.device_seq))>n?BigInt(String(row.device_seq)):n,0n).toString();},
  };
}
