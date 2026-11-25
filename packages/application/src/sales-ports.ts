import type { Unit, StockPolicy } from '../../domain/src/catalog-stock.js';
import type { ManualPayment } from '../../domain/src/sales.js';
export type DraftItemInput={id:string;product_id:string;expected_product_version:number;quantity_milli:number;item_discount_cents?:number}|{id:string;product_id:null;description:string;price_cents:number;quantity_milli:number;item_discount_cents?:number};
export interface DraftInput {items:DraftItemInput[];customer_id:string|null;note:string|null;discount_cents:number}
export interface DraftItem {id:string;store_id:string;sale_id:string;product_id:string|null;product_version:number|null;line_type:'catalog'|'manual';description:string;unit:Unit;price_cents:number;unit_cost_cents:number|null;quantity_milli:number;item_discount_cents:number}
export interface SaleDraft {id:string;store_id:string;device_id:string;operator_id:string;version:number;status:'draft'|'completed';customer_id:string|null;customer_name:string|null;note:string|null;discount_cents:number;updated_at:string}
export interface SaleItem extends DraftItem {subtotal_cents:number;sale_discount_cents:number;total_cents:number;cost_total_cents:number|null}
export interface SalePayment extends ManualPayment {store_id:string;sale_id:string;confirmation:'manual'}
export interface Sale {id:string;store_id:string;device_id:string;device_code:string;device_seq:string;number:string;session_id:string;operator_id:string;customer_id:string|null;customer_name:string|null;note:string|null;business_date:string;time_zone:string;subtotal_cents:number;discount_cents:number;sale_discount_cents:number;total_cents:number;tendered_cents:number;change_cents:number;stock_policy:StockPolicy;settings_version:number;pricing_policy:'catalog_integer_positive_v1';authorization_context:string;completion_intention_id:string;completion_hash:string;draft_version:number;local_commit_at:string}
export interface SaleAggregate {sale:Sale;items:SaleItem[];payments:SalePayment[]}
export interface SalesRepository {
  draft(id:string):Promise<SaleDraft|undefined>;draftItems(id:string):Promise<DraftItem[]>;saveDraft(value:SaleDraft):Promise<void>;replaceDraftItems(id:string,items:DraftItem[]):Promise<void>;
  sale(id:string):Promise<SaleAggregate|undefined>;saleByIntention(id:string):Promise<SaleAggregate|undefined>;
  insertSale(value:Sale):Promise<void>;insertSaleItem(value:SaleItem):Promise<void>;insertSalePayment(value:SalePayment):Promise<void>;
}
