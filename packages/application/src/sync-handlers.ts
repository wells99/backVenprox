import { SyncRejection, type SyncDependencies, type SyncEnvelope, type SyncTransaction, type SyncReceipt } from './sync-ports.js';
import type { CashMovement, CashSession } from './cash-ports.js';
import type { SaleAggregate } from './sales-ports.js';
import type { ReversalAggregate, CashClosure, CashTotals } from './reversal-ports.js';
import type { Customer, StockMovement, StockBalance } from './business-ports.js';
import { priceSale, lineSubtotal, validPayments } from '../../domain/src/sales.js';
import { cashDifference, refundTotal } from '../../domain/src/reversals.js';
import { businessDate } from '../../domain/src/cash.js';
import { catalogText, catalogSearchKey, sumQuantity, validQuantity } from '../../domain/src/catalog-stock.js';

function invalid(code='INVALID_HISTORICAL_FACT'):never {throw new SyncRejection('quarantined',code);}
function missing(code='DEPENDENCY_MISSING'):never {throw new SyncRejection('blocked',code);}
type Effects={stock_movement_ids:{id:string;item_id:string}[];cash_movement_ids:{id:string;payment_id:string}[];dependencies:{cash_session_id:string}};
export class SyncHandlers {
  constructor(readonly deps:SyncDependencies){}
  private equal(a:unknown,b:unknown){try{return this.deps.hashValue(a)===this.deps.hashValue(b);}catch{return false;}}
  private context(e:SyncEnvelope,raw:string){let value:unknown;try{value=JSON.parse(raw);}catch{invalid('INVALID_AUTHORIZATION_SNAPSHOT');}if(!this.equal(value,e.origin_authorization.context))invalid('AUTHORIZATION_SNAPSHOT_MISMATCH');}
  private scope(e:SyncEnvelope,value:{store_id:string;device_id?:string;operator_id?:string}){if(value.store_id!==e.store_id||value.device_id!==undefined&&value.device_id!==e.device_id||value.operator_id!==undefined&&value.operator_id!==e.origin_authorization.context.user_id)invalid('HISTORICAL_SCOPE_MISMATCH');}
  private time(e:SyncEnvelope,at:string){if(!Number.isFinite(Date.parse(at))||Date.parse(at)<Date.parse(e.origin_authorization.context.authorized_at)||Date.parse(at)>Date.parse(e.occurred_at_device))invalid('HISTORICAL_TIME_MISMATCH');}
  private customerSnapshot(customer:Customer){if(catalogText(customer.name)!==customer.name||customer.search_key!==catalogSearchKey(customer.name)||customer.phone!==null&&catalogText(customer.phone,40)!==customer.phone||customer.email!==null&&(catalogText(customer.email,254)!==customer.email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)))invalid('INVALID_HISTORICAL_CUSTOMER');}
  private async fresh(tx:SyncTransaction,table:Parameters<SyncTransaction['sync']['entityExists']>[0],id:string){if(await tx.sync.entityExists(table,id))throw new SyncRejection('conflict','ENTITY_ID_CONFLICT');}
  private async session(tx:SyncTransaction,e:SyncEnvelope,id:string){const session=await tx.business.cashSession(id);if(!session)missing('CASH_OPENING_MISSING');if(session.device_id!==e.device_id)invalid('CASH_OWNER_MISMATCH');if(session.status!=='open')invalid('CASH_SESSION_CLOSED');return session;}
  private async stock(tx:SyncTransaction,e:SyncEnvelope,value:Pick<StockMovement,'id'|'product_id'|'kind'|'origin_id'|'item_id'|'delta_milli'|'unit'|'unit_cost_cents'|'reason'>){
    if(!await tx.business.product(value.product_id))missing('PRODUCT_REFERENCE_MISSING');if(!validQuantity(value.delta_milli,value.unit,true))invalid('INVALID_STOCK_DELTA');
    await this.fresh(tx,'stock_movements',value.id);if(await tx.business.movementByOrigin(value.origin_id,value.kind,value.item_id))throw new SyncRejection('conflict','MOVEMENT_ORIGIN_CONFLICT');
    const balance=await tx.business.balance(value.product_id),after=sumQuantity([balance.quantity_milli,value.delta_milli]);if(after===undefined)invalid('QUANTITY_OUT_OF_RANGE');
    await tx.business.appendMovement({...value,store_id:e.store_id,device_id:e.device_id,operator_id:e.origin_authorization.context.user_id,before_milli:balance.quantity_milli,after_milli:after,occurred_at:e.occurred_at_device,authorization_context:JSON.stringify(e.origin_authorization.context)});
    await tx.business.saveBalance({...balance,quantity_milli:after,version:balance.version+1});
  }
  private async cash(tx:SyncTransaction,e:SyncEnvelope,value:CashMovement){this.scope(e,value);this.time(e,value.occurred_at);if(catalogText(value.reason,500,true)!==value.reason)invalid('INVALID_HISTORICAL_REASON');if(value.operation_id!==e.operation_id)invalid('MOVEMENT_OPERATION_MISMATCH');await this.session(tx,e,value.session_id);await this.fresh(tx,'cash_movements',value.id);await tx.business.appendCashMovement(value);}
  private async touchSession(tx:SyncTransaction,e:SyncEnvelope,id:string){await tx.business.cashTotals(id);await tx.business.bumpCashSession(id);await tx.sync.setReceivedSessionFrontier(id,e.device_seq);}
  async apply(tx:SyncTransaction,e:SyncEnvelope,deviceCode:string):Promise<NonNullable<SyncReceipt['result']>>{
    const result=(id:string|null,reconciliation:'not_applicable'|'reconciled'='not_applicable')=>({entity_id:id,received_at:this.deps.clock.now().toISOString(),reconciliation});
    if(e.type==='cash.opened'){
      const p=e.payload as {session:CashSession;movement:CashMovement},s=p.session,m=p.movement;this.scope(e,s);this.scope(e,m);this.time(e,s.opened_at);
      if(s.status!=='open'||s.version!==1||businessDate(s.opened_at,s.time_zone)!==s.business_date||m.session_id!==s.id||m.kind!=='opening'||m.method!=='cash'||m.origin_id!==s.id||m.component_id!==s.id||m.amount_cents!==s.opening_cents)invalid();
      if(await tx.business.currentCash(e.device_id))throw new SyncRejection('conflict','CASH_ALREADY_OPEN');await this.fresh(tx,'cash_sessions',s.id);await tx.business.insertCashSession(s);await this.cash(tx,e,m);await tx.sync.setReceivedSessionFrontier(s.id,e.device_seq);return result(s.id);
    }
    if(e.type==='cash.movement_recorded'){
      const {movement:m}=e.payload as {movement:CashMovement};if(!['supply','withdrawal'].includes(m.kind)||m.method!=='cash'||m.origin_id!==e.operation_id||m.component_id!==e.operation_id||catalogText(m.reason,500,true)!==m.reason||m.kind==='supply'&&m.amount_cents<=0||m.kind==='withdrawal'&&m.amount_cents>=0)invalid();
      await this.session(tx,e,m.session_id);if(m.kind==='withdrawal'&&(await tx.business.cashTotals(m.session_id)).cash<-m.amount_cents)invalid('INVALID_HISTORICAL_WITHDRAWAL');await this.cash(tx,e,m);await this.touchSession(tx,e,m.session_id);return result(m.id);
    }
    if(e.type==='sale.completed')return this.sale(tx,e,deviceCode);
    if(e.type==='sale.reversed')return this.reverse(tx,e);
    if(e.type==='cash.closed')return this.close(tx,e);
    if(e.type==='stock.entry.v1'||e.type==='stock.count.v1'){
      const p=e.payload as {product_id?:string;counted_milli?:number;expected_version?:number;reason?:string;movement:StockMovement|null},m=p.movement;
      if(m){this.scope(e,m);this.context(e,m.authorization_context);this.time(e,m.occurred_at);if(m.origin_id!==e.operation_id||m.item_id!==m.product_id||m.after_milli!==sumQuantity([m.before_milli,m.delta_milli])||catalogText(m.reason,500,true)!==m.reason)invalid();
        if(e.type==='stock.entry.v1'&&(!['entry','opening'].includes(m.kind)||m.delta_milli<=0))invalid();
        if(e.type==='stock.count.v1'&&(m.kind!=='adjustment'||m.product_id!==p.product_id||m.after_milli!==p.counted_milli||m.reason!==p.reason||m.unit_cost_cents!==null))invalid();await this.stock(tx,e,m);return result(m.id);
      }
      if(e.type!=='stock.count.v1'||!p.product_id||!await tx.business.product(p.product_id)||!catalogText(p.reason,500,true))invalid();return result(p.product_id);
    }
    if(e.type==='stock.projection.rebuilt.v1'){
      const p=e.payload as {previous:StockBalance;balance:StockBalance};this.scope(e,p.previous);this.scope(e,p.balance);if(p.previous.product_id!==p.balance.product_id||p.balance.version!==p.previous.version+1)invalid();if(!await tx.business.product(p.balance.product_id))missing('PRODUCT_REFERENCE_MISSING');return result(p.balance.product_id);
    }
    if(e.type==='customer.created.v1'){
      const {customer}=e.payload as {customer:Customer};this.scope(e,customer);this.customerSnapshot(customer);if(customer.version!==1||customer.confirmation_state!=='local_pending')invalid();const prior=await tx.business.customer(customer.id);if(prior)throw new SyncRejection('conflict','CUSTOMER_ID_CONFLICT');await tx.business.saveCustomer({...customer,confirmation_state:'confirmed'});return result(customer.id);
    }
    if(e.type==='terminal.settings.updated.v1'){
      const {settings}=e.payload as {settings:{store_id:string;device_id:string;version:number;automatic_printing:false}};this.scope(e,settings);await tx.sync.recordProposal(e);return result(settings.device_id);
    }
    if(/^(products|categories|customers|settings)\.proposal(?:\.conflict)?\.v1$/.test(e.type)){
      const p=e.payload as {entity_type:string;entity_id:string;base_version:number;proposal:{id:string;store_id:string;version:number;confirmation_state?:string}};this.scope(e,p.proposal);if(p.entity_type!==e.type.split('.')[0]||p.entity_id!==p.proposal.id)invalid();
      if(p.entity_type==='customers'&&p.base_version===0&&p.proposal.confirmation_state==='local_pending'){
        const customer=p.proposal as Customer;this.customerSnapshot(customer);if(customer.version!==1)invalid();if(await tx.business.customer(customer.id))throw new SyncRejection('conflict','CUSTOMER_ID_CONFLICT');await tx.business.saveCustomer({...customer,confirmation_state:'confirmed'});
      }
      await tx.sync.recordProposal(e);return result(p.entity_id);
    }
    invalid('UNSUPPORTED_OPERATION');
  }
  private async sale(tx:SyncTransaction,e:SyncEnvelope,deviceCode:string){
    const p=e.payload as SaleAggregate&Effects,s=p.sale;this.scope(e,s);this.context(e,s.authorization_context);this.time(e,s.local_commit_at);
    if(s.customer_name!==null&&catalogText(s.customer_name)!==s.customer_name||s.note!==null&&catalogText(s.note,2000,true)!==s.note)invalid('INVALID_HISTORICAL_TEXT');
    if(s.device_code!==deviceCode||s.device_seq!==e.device_seq||s.number!==`${deviceCode}-${e.device_seq.padStart(6,'0')}`||s.completion_intention_id!==e.operation_id||p.dependencies.cash_session_id!==s.session_id)invalid();
    const session=await this.session(tx,e,s.session_id);if(session.business_date!==s.business_date||session.time_zone!==s.time_zone)invalid('SALE_SESSION_SNAPSHOT_MISMATCH');
    if(s.customer_id&&!await tx.business.customer(s.customer_id))missing('CUSTOMER_REFERENCE_MISSING');
    await this.fresh(tx,'sales',s.id);if(new Set(p.items.map((i)=>i.id)).size!==p.items.length)invalid('DUPLICATE_ITEM');
    const prices=priceSale(p.items,s.sale_discount_cents);if('error'in prices||s.subtotal_cents!==prices.subtotal_cents||s.discount_cents!==prices.discount_cents||s.total_cents!==prices.total_cents||!validPayments(p.payments,s.total_cents)||s.tendered_cents!==p.payments.reduce((n,v)=>n+v.tendered_cents,0)||s.change_cents!==p.payments.reduce((n,v)=>n+v.change_cents,0))invalid('HISTORICAL_TOTAL_MISMATCH');
    if(s.discount_cents>0&&!e.origin_authorization.context.permissions.includes('sales.discount'))invalid('ORIGIN_PERMISSION_MISSING');
    const catalog=p.items.filter((i)=>i.product_id!==null);if(p.stock_movement_ids.length!==catalog.length||new Set(p.stock_movement_ids.map((m)=>m.item_id)).size!==catalog.length||p.cash_movement_ids.length!==p.payments.length||new Set(p.cash_movement_ids.map((m)=>m.payment_id)).size!==p.payments.length)invalid('EFFECT_ID_MISMATCH');
    for(const [index,item] of p.items.entries()){
      this.scope(e,item);const final=prices.lines[index]!;if(catalogText(item.description)!==item.description||item.sale_id!==s.id||item.quantity_milli%1000!==0||item.subtotal_cents!==final.subtotal_cents||item.sale_discount_cents!==final.sale_discount_cents||item.total_cents!==final.total_cents||item.cost_total_cents!==(item.unit_cost_cents===null?null:lineSubtotal(item.unit_cost_cents,item.quantity_milli)))invalid('HISTORICAL_ITEM_MISMATCH');
      if(item.product_id===null){if(item.line_type!=='manual'||item.product_version!==null||item.unit_cost_cents!==null||item.unit!=='unit'||s.stock_policy==='require_stock')invalid('HISTORICAL_MANUAL_ITEM_INVALID');}
      else if(item.line_type!=='catalog'||item.product_version===null||!p.stock_movement_ids.some((m)=>m.item_id===item.id))invalid('HISTORICAL_PRODUCT_ITEM_INVALID');
      if(item.product_id&&!await tx.business.product(item.product_id))missing('PRODUCT_REFERENCE_MISSING');
    }
    await tx.business.insertSale(s);
    for(const item of p.items){await this.fresh(tx,'sale_items',item.id);await tx.business.insertSaleItem(item);}
    for(const pay of p.payments){this.scope(e,pay);if(pay.sale_id!==s.id||pay.confirmation!=='manual'||!p.cash_movement_ids.some((m)=>m.payment_id===pay.id))invalid('HISTORICAL_PAYMENT_MISMATCH');await this.fresh(tx,'sale_payments',pay.id);await tx.business.insertSalePayment(pay);}
    for(const item of catalog){const id=p.stock_movement_ids.find((m)=>m.item_id===item.id)!.id;await this.stock(tx,e,{id,product_id:item.product_id!,kind:'sale',origin_id:s.id,item_id:item.id,delta_milli:-item.quantity_milli,unit:item.unit,unit_cost_cents:item.unit_cost_cents,reason:'Venda'});}
    for(const pay of p.payments){const id=p.cash_movement_ids.find((m)=>m.payment_id===pay.id)!.id;await this.cash(tx,e,{id,store_id:e.store_id,session_id:s.session_id,device_id:e.device_id,operator_id:s.operator_id,operation_id:e.operation_id,origin_id:s.id,component_id:pay.id,kind:'sale',method:pay.method,amount_cents:pay.applied_cents,reason:'Venda',occurred_at:e.occurred_at_device});}
    await this.touchSession(tx,e,s.session_id);return {entity_id:s.id,received_at:this.deps.clock.now().toISOString(),reconciliation:'not_applicable' as const};
  }
  private async reverse(tx:SyncTransaction,e:SyncEnvelope){
    const p=e.payload as ReversalAggregate&{cash_movement_ids:Effects['cash_movement_ids'];dependencies:{sale_id:string;cash_session_id:string}},r=p.reversal;this.scope(e,r);this.context(e,r.authorization_context);this.time(e,r.occurred_at);
    if(r.intention_id!==e.operation_id||p.dependencies.sale_id!==r.sale_id||p.dependencies.cash_session_id!==r.session_id||catalogText(r.reason,500,true)!==r.reason)invalid();
    const original=await tx.business.sale(r.sale_id);if(!original)missing('ORIGINAL_SALE_MISSING');await this.session(tx,e,r.session_id);if(await tx.business.reversalForSale(r.sale_id))throw new SyncRejection('conflict','ALREADY_REVERSED');
    if(r.total_cents!==original.sale.total_cents||refundTotal(p.payments)!==BigInt(r.total_cents)||p.items.length!==original.items.length||new Set(p.items.map((i)=>i.sale_item_id)).size!==original.items.length||p.cash_movement_ids.length!==p.payments.length||new Set(p.cash_movement_ids.map((m)=>m.payment_id)).size!==p.payments.length)invalid('HISTORICAL_REFUND_MISMATCH');
    await this.fresh(tx,'sale_reversals',r.id);await tx.business.insertReversal(r);
    for(const item of p.items){this.scope(e,item);const before=original.items.find((i)=>i.id===item.sale_item_id);if(!before||item.sale_id!==r.sale_id||item.reversal_id!==r.id||item.quantity_milli!==before.quantity_milli||item.amount_cents!==before.total_cents)invalid('REVERSAL_ITEM_MISMATCH');
      if(before.product_id){const movement=await tx.business.movementByOrigin(r.sale_id,'sale',before.id);if(!movement||!item.stock_movement_id)missing('ORIGINAL_STOCK_MOVEMENT_MISSING');await this.stock(tx,e,{id:item.stock_movement_id,product_id:movement.product_id,kind:'reversal',origin_id:r.sale_id,item_id:before.id,delta_milli:before.quantity_milli,unit:movement.unit,unit_cost_cents:movement.unit_cost_cents,reason:'Estorno integral'});}
      else if(item.stock_movement_id!==null)invalid('MANUAL_ITEM_STOCK_INVALID');await this.fresh(tx,'reversal_items',item.id);await tx.business.insertReversalItem(item);
    }
    for(const pay of p.payments){this.scope(e,pay);if(pay.reversal_id!==r.id||pay.confirmation!=='manual')invalid();const mapping=p.cash_movement_ids.find((m)=>m.payment_id===pay.id);if(!mapping)invalid('EFFECT_ID_MISMATCH');await this.fresh(tx,'refund_payments',pay.id);await tx.business.insertRefundPayment(pay);
      await this.cash(tx,e,{id:mapping.id,store_id:e.store_id,session_id:r.session_id,device_id:e.device_id,operator_id:r.operator_id,operation_id:e.operation_id,origin_id:r.id,component_id:pay.id,kind:'refund',method:pay.method,amount_cents:-pay.amount_cents,reason:r.reason,occurred_at:e.occurred_at_device});}
    await this.touchSession(tx,e,r.session_id);return {entity_id:r.id,received_at:this.deps.clock.now().toISOString(),reconciliation:'not_applicable' as const};
  }
  private async close(tx:SyncTransaction,e:SyncEnvelope){
    const p=e.payload as {closure:CashClosure;dependencies:{cash_session_id:string}},c=p.closure;this.scope(e,c);this.context(e,c.authorization_context);this.time(e,c.closed_at);if(c.reason!==null&&catalogText(c.reason,500,true)!==c.reason)invalid('INVALID_CLOSURE_REASON');
    if(c.intention_id!==e.operation_id||c.device_seq!==e.device_seq||p.dependencies.cash_session_id!==c.session_id)invalid();const s=await this.session(tx,e,c.session_id);
    if(c.session_version!==s.version||c.previous_device_seq!==await tx.sync.receivedSessionFrontier(s.id)||BigInt(c.previous_device_seq)>=BigInt(c.device_seq))invalid('CLOSURE_FRONTIER_MISMATCH');
    let expected:CashTotals,counted:CashTotals,difference:CashTotals;try{expected=JSON.parse(c.expected_json);counted=JSON.parse(c.counted_json);difference=JSON.parse(c.difference_json);}catch{invalid('INVALID_CLOSURE_TOTALS');}
    const computed=cashDifference(await tx.business.cashTotals(s.id),counted);if(!computed||!this.equal(expected,await tx.business.cashTotals(s.id))||!this.equal(difference,computed)||Object.values(computed).some((v)=>v!==0)&&!catalogText(c.reason,500,true))invalid('CLOSURE_TOTAL_MISMATCH');
    await this.fresh(tx,'cash_closures',c.id);await tx.business.insertCashClosure(c);await tx.business.closeCashSession(s.id);await tx.sync.reconcile(c.id,e.device_id,e.device_seq);return {entity_id:c.id,received_at:this.deps.clock.now().toISOString(),reconciliation:'reconciled' as const};
  }
}
