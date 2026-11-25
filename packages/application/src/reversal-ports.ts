import type { PaymentMethod } from './cash-ports.js';
export type CashTotals=Record<PaymentMethod,number>;
export interface SaleReversal {id:string;store_id:string;sale_id:string;device_id:string;session_id:string;operator_id:string;intention_id:string;reason:string;total_cents:number;occurred_at:string;authorization_context:string}
export interface ReversalItem {id:string;store_id:string;reversal_id:string;sale_id:string;sale_item_id:string;quantity_milli:number;amount_cents:number;stock_movement_id:string|null}
export interface RefundPayment {id:string;store_id:string;reversal_id:string;method:PaymentMethod;amount_cents:number;confirmation:'manual'}
export interface ReversalAggregate {reversal:SaleReversal;items:ReversalItem[];payments:RefundPayment[]}
export interface CashClosure {id:string;store_id:string;session_id:string;device_id:string;operator_id:string;intention_id:string;session_version:number;previous_device_seq:string;device_seq:string;expected_json:string;counted_json:string;difference_json:string;reason:string|null;closed_at:string;authorization_context:string}
export interface ReversalRepository {
  reversalForSale(id:string):Promise<ReversalAggregate|undefined>;insertReversal(value:SaleReversal):Promise<void>;insertReversalItem(value:ReversalItem):Promise<void>;insertRefundPayment(value:RefundPayment):Promise<void>;
  cashClosure(sessionId:string):Promise<CashClosure|undefined>;insertCashClosure(value:CashClosure):Promise<void>;closeCashSession(id:string):Promise<void>;cashFrontier(sessionId:string):Promise<string>;
}
