import { BusinessBase, businessConflict, businessError } from './business-base.js';
import type { BusinessContext } from './business-ports.js';
import type { ReversalAggregate, SaleReversal, ReversalItem } from './reversal-ports.js';
import type { PaymentMethod } from './cash-ports.js';
import { ApplicationError } from './application-error.js';
import { catalogText } from '../../domain/src/catalog-stock.js';
import { refundTotal } from '../../domain/src/reversals.js';
import { CashService } from './cash-service.js';
import { StockService } from './stock-service.js';
export class ReversalService extends BusinessBase {
  private visible(result:ReversalAggregate){const {store_id:_store,authorization_context:_auth,...reversal}=result.reversal;return {reversal,items:result.items.map(({store_id:_s,...item})=>item),payments:result.payments.map(({store_id:_s,...p})=>p),sync_status:'pending' as const};}
  async reverse(context:BusinessContext,intention:string,input:{sale_id:string;session_id:string;reason:string;payments:{id:string;method:PaymentMethod;amount_cents:number}[]}){
    if(!this.deps.local)throw new ApplicationError('LOCAL_SALES_ONLY','Reversão é registrada no terminal local.','forbidden');this.authorize(context,'sales.reverse');
    const reason=catalogText(input.reason,500,true);if(!reason)throw businessError('REASON_REQUIRED');const total=refundTotal(input.payments);if(total===undefined)throw businessError('INVALID_REFUND_PAYMENTS');
    const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'sales.reverse',device_id:this.deps.deviceId,input:{...input,reason}},async()=>{
      this.authorize(context,'sales.reverse');const original=await tx.business.sale(input.sale_id);if(!original)throw new ApplicationError('SALE_NOT_FOUND','Venda não encontrada.','not_found');
      if(await tx.business.reversalForSale(input.sale_id))throw businessConflict('ALREADY_REVERSED','A venda já foi integralmente revertida.');
      if(total>BigInt(original.sale.total_cents))throw businessError('REFUND_EXCEEDS_REMAINING');if(total!==BigInt(original.sale.total_cents))throw businessError('FULL_REFUND_REQUIRED','O cancelamento desta etapa exige restituição integral.');
      await new CashService(this.deps).requireOpen(tx,context,input.session_id,'sales.reverse');
      const reversal:SaleReversal={id:this.deps.ids.generate(),store_id:this.deps.storeId,sale_id:input.sale_id,device_id:this.deps.deviceId,session_id:input.session_id,operator_id:context.user_id,intention_id:intention,reason,total_cents:original.sale.total_cents,occurred_at:this.now(),authorization_context:JSON.stringify(context)};
      await tx.business.insertReversal(reversal);
      const restored=await new StockService(this.deps).recordFullReversal(tx,context,original.sale.id,original.items.map((item)=>({item_id:item.id,product_id:item.product_id,quantity_milli:item.quantity_milli})));
      const items:ReversalItem[]=original.items.map((item)=>({id:this.deps.ids.generate(),store_id:this.deps.storeId,reversal_id:reversal.id,sale_id:original.sale.id,sale_item_id:item.id,quantity_milli:item.quantity_milli,amount_cents:item.total_cents,stock_movement_id:restored.find((m)=>m.item_id===item.id)?.id??null}));
      for(const item of items)await tx.business.insertReversalItem(item);
      const payments=input.payments.map((p)=>({...p,store_id:this.deps.storeId,reversal_id:reversal.id,confirmation:'manual' as const})).sort((a,b)=>a.id<b.id?-1:1);for(const p of payments)await tx.business.insertRefundPayment(p);
      const cash=await new CashService(this.deps).recordRefunds(tx,context,input.session_id,intention,reversal.id,payments,reason);
      const aggregate={reversal,items,payments};await this.event(tx,context,intention,'sale.reversed',{schema_version:1,...aggregate,cash_movement_ids:cash.map((m)=>({payment_id:m.component_id,id:m.id})),dependencies:{sale_id:original.sale.id,cash_session_id:input.session_id}});return aggregate;
    }));return this.visible(result);
  }
}
