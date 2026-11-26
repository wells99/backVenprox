export type PaymentMethod='cash'|'credit'|'debit'|'pix';
export interface CashSession {id:string;store_id:string;device_id:string;operator_id:string;opened_at:string;business_date:string;time_zone:string;opening_cents:number;status:'open'|'closed';version:number}
export interface CashMovement {id:string;store_id:string;session_id:string;device_id:string;operator_id:string;operation_id:string;origin_id:string;component_id:string;kind:'opening'|'supply'|'withdrawal'|'sale'|'refund'|'credit_receipt';method:PaymentMethod;amount_cents:number;reason:string;occurred_at:string}
export interface CashQuery {device_id?:string;after?:string;limit:number}
export interface CashRepository {
  cashSession(id:string):Promise<CashSession|undefined>;currentCash(deviceId:string):Promise<CashSession|undefined>;
  cashSessions(query:CashQuery):Promise<CashSession[]>;insertCashSession(value:CashSession):Promise<void>;bumpCashSession(id:string):Promise<void>;
  cashMovements(sessionId:string,query:{after?:string;origin_id?:string;kind?:CashMovement['kind'];method?:PaymentMethod;limit:number}):Promise<CashMovement[]>;
  cashTotals(sessionId:string):Promise<Record<PaymentMethod,number>>;cashPending(sessionId:string):Promise<boolean>;
  appendCashMovement(value:CashMovement):Promise<void>;
}
