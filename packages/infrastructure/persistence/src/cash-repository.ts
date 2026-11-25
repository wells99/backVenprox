import type { CashRepository, CashSession, CashMovement, PaymentMethod } from '../../../application/src/cash-ports.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { BusinessSql } from './business-repository.js';
export function cashRepository(sql:BusinessSql,storeId:string):CashRepository {
  async function rows<T>(table:string,where:string,values:unknown[]):Promise<T[]>{sql.active();return (await sql.all(`SELECT * FROM ${table} WHERE store_id=? ${where}`,[storeId,...values])).map((row)=>{
    const result={...row};delete result.open_device;
    for(const key of ['opening_cents','amount_cents','version'])if(key in result){const n=Number(result[key]);if(!Number.isSafeInteger(n))throw new ApplicationError('INVALID_PERSISTED_NUMBER','Valor persistido inválido.','unavailable');result[key]=n;}return result;
  }) as T[];}
  async function insert(table:string,value:CashSession|CashMovement){sql.active();if(value.store_id!==storeId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');const keys=Object.keys(value);await sql.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,Object.values(value));}
  return {
    cashSession:async(id)=>(await rows<CashSession>('cash_sessions','AND id=?',[id]))[0],
    currentCash:async(device)=>(await rows<CashSession>('cash_sessions',"AND device_id=? AND status='open'",[device]))[0],
    cashSessions:(q)=>rows<CashSession>('cash_sessions',`${q.device_id?'AND device_id=? ':''}${q.after?'AND id>? ':''}ORDER BY id LIMIT ?`,[...(q.device_id?[q.device_id]:[]),...(q.after?[q.after]:[]),q.limit+1]),
    insertCashSession:(value)=>insert('cash_sessions',{...value,open_device:value.status==='open'?value.device_id:null} as CashSession),
    bumpCashSession:async(id)=>{sql.active();await sql.run('UPDATE cash_sessions SET version=version+1 WHERE store_id=? AND id=?',[storeId,id]);},
    cashMovements:(id,q)=>rows<CashMovement>('cash_movements',`AND session_id=? ${q.after?'AND id>? ':''}${q.origin_id?'AND origin_id=? ':''}ORDER BY id LIMIT ?`,[id,...(q.after?[q.after]:[]),...(q.origin_id?[q.origin_id]:[]),q.limit+1]),
    appendCashMovement:(value)=>insert('cash_movements',value),
    cashTotals:async(id)=>{
      sql.active();const totals={cash:0n,credit:0n,debit:0n,pix:0n};
      for(const row of await sql.all('SELECT method,amount_cents FROM cash_movements WHERE store_id=? AND session_id=?',[storeId,id]))totals[row.method as PaymentMethod]+=BigInt(String(row.amount_cents));
      if(Object.values(totals).some((n)=>n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(-Number.MAX_SAFE_INTEGER)))throw new ApplicationError('CASH_TOTAL_OUT_OF_RANGE','Total de caixa fora da faixa.','content');
      return Object.fromEntries(Object.entries(totals).map(([key,n])=>[key,Number(n)])) as Record<PaymentMethod,number>;
    },
    cashPending:async(id)=>{sql.active();if((await sql.all("SELECT m.id FROM cash_movements m JOIN operation_outbox o ON o.store_id=m.store_id AND o.operation_id=m.operation_id WHERE m.store_id=? AND m.session_id=? AND o.state='pending' LIMIT 1",[storeId,id])).length)return true;
      return (await sql.all("SELECT c.id FROM cash_closures c JOIN operation_outbox o ON o.store_id=c.store_id AND o.operation_id=c.intention_id WHERE c.store_id=? AND c.session_id=? AND o.state='pending' LIMIT 1",[storeId,id])).length>0;},
  };
}
