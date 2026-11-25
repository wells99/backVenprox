import type { SalesRepository, SaleDraft, DraftItem, Sale, SaleItem, SalePayment, SaleAggregate } from '../../../application/src/sales-ports.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { BusinessSql } from './business-repository.js';
export function salesRepository(sql:BusinessSql,storeId:string):SalesRepository {
  async function rows<T>(table:string,predicate:string,values:unknown[]):Promise<T[]>{sql.active();return (await sql.all(`SELECT * FROM ${table} WHERE store_id=? ${predicate}`,[storeId,...values])).map((row)=>Object.fromEntries(Object.entries(row).map(([key,value])=>{
    if(value!==null&&(key.endsWith('_cents')||key.endsWith('_version')||['version','quantity_milli'].includes(key))){const n=Number(value);if(!Number.isSafeInteger(n))throw new ApplicationError('INVALID_PERSISTED_NUMBER','Valor persistido inválido.','unavailable');return[key,n];}return[key,value];
  }))) as T[];}
  async function insert(table:string,value:object){sql.active();const record=value as Record<string,unknown>;if(record.store_id!==storeId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');const keys=Object.keys(record);await sql.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,Object.values(record));}
  async function aggregate(predicate:string,values:unknown[]):Promise<SaleAggregate|undefined>{const sale=(await rows<Sale>('sales',predicate,values))[0];return sale?{sale,items:await rows<SaleItem>('sale_items','AND sale_id=? ORDER BY id',[sale.id]),payments:await rows<SalePayment>('sale_payments','AND sale_id=? ORDER BY id',[sale.id])}:undefined;}
  return {
    draft:async(id)=>(await rows<SaleDraft>('sale_drafts','AND id=?',[id]))[0],draftItems:(id)=>rows<DraftItem>('sale_draft_items','AND sale_id=? ORDER BY id',[id]),
    saveDraft:async(value)=>{const {id,store_id,...rest}=value;if((await rows<SaleDraft>('sale_drafts','AND id=?',[id])).length){const keys=Object.keys(rest);await sql.run(`UPDATE sale_drafts SET ${keys.map((key)=>`${key}=?`).join(',')} WHERE store_id=? AND id=?`,[...Object.values(rest),store_id,id]);}else await insert('sale_drafts',value);},
    replaceDraftItems:async(id,items)=>{sql.active();await sql.run('DELETE FROM sale_draft_items WHERE store_id=? AND sale_id=?',[storeId,id]);for(const item of items)await insert('sale_draft_items',item);},
    sale:(id)=>aggregate('AND id=?',[id]),saleByIntention:(id)=>aggregate('AND completion_intention_id=?',[id]),
    insertSale:(v)=>insert('sales',v),insertSaleItem:(v)=>insert('sale_items',v),insertSalePayment:(v)=>insert('sale_payments',v),
  };
}
