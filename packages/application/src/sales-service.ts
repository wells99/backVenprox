import { BusinessBase, businessConflict, businessError, versionConflict } from './business-base.js';
import type { BusinessContext, BusinessDependencies, BusinessTransaction } from './business-ports.js';
import type { DraftInput, DraftItem, SaleDraft, Sale, SaleItem, SaleAggregate } from './sales-ports.js';
import { ApplicationError } from './application-error.js';
import { catalogText, validMoney } from '../../domain/src/catalog-stock.js';
import { lineSubtotal, priceSale, validPayments, type ManualPayment } from '../../domain/src/sales.js';
import { StockService } from './stock-service.js';
import { CashService } from './cash-service.js';

export class SalesService extends BusinessBase {
  constructor(deps:BusinessDependencies,readonly deviceCode:()=>Promise<string>){super(deps);}
  private local(){if(!this.deps.local)throw new ApplicationError('LOCAL_SALES_ONLY','Venda é concluída no terminal local.','forbidden');}
  private guard(context:BusinessContext,permission:'sales.create'|'sales.read'='sales.create'){this.local();this.authorize(context,permission);}
  private async draft(tx:BusinessTransaction,id:string){const draft=await tx.business.draft(id);if(!draft||draft.device_id!==this.deps.deviceId)throw new ApplicationError('DRAFT_NOT_FOUND','Rascunho não encontrado.','not_found');return draft;}
  private visibleItem<T extends {store_id:string;unit_cost_cents:number|null}>(item:T,context:BusinessContext){const {store_id:_store,unit_cost_cents,...rest}=item;const visible={...rest} as Record<string,unknown>;if(!context.permissions.includes('costs.read'))delete visible.cost_total_cents;else visible.unit_cost_cents=unit_cost_cents;return visible;}
  private draftView(draft:SaleDraft,items:DraftItem[],context:BusinessContext){const {store_id:_store,...value}=draft;return {draft:{...value,items:items.map((item)=>this.visibleItem(item,context)),totals:items.length?this.prices(items,draft.discount_cents):{subtotal_cents:0,discount_cents:0,sale_discount_cents:0,total_cents:0,lines:[]}}};}
  private completedView(aggregate:SaleAggregate,context:BusinessContext){const {store_id:_store,authorization_context:_authorization,completion_hash:_hash,...sale}=aggregate.sale;
    return {completion:{sale:{...sale,items:aggregate.items.map((item)=>this.visibleItem(item,context)),payments:aggregate.payments.map(({store_id:_s,...payment})=>payment)},local_commit_at:sale.local_commit_at,sync_status:'pending' as const}};
  }
  private prices(items:DraftItem[],discount:number){const priced=priceSale(items,discount);if('error' in priced)throw businessError(priced.error);return priced;}
  private async resolve(tx:BusinessTransaction,context:BusinessContext,saleId:string,input:DraftInput){
    if(!validMoney(input.discount_cents)||!Array.isArray(input.items)||input.items.length>50||new Set(input.items.map((line)=>line.id)).size!==input.items.length)throw businessError('INVALID_SALE_ITEMS');
    const note=input.note===null?null:catalogText(input.note,2000,true);if(input.note!==null&&!note)throw businessError('INVALID_NOTE');
    const customer=input.customer_id===null?undefined:await tx.business.customer(input.customer_id);if(input.customer_id!==null&&(!customer||!customer.active))throw businessError('CUSTOMER_UNAVAILABLE');
    const items:DraftItem[]=[];
    for(const inputItem of input.items){
      if(!Number.isSafeInteger(inputItem.quantity_milli)||inputItem.quantity_milli<=0||inputItem.quantity_milli%1000!==0)throw businessError('FRACTIONAL_SALES_DISABLED','Venda fracionada ainda não está habilitada.');
      const item_discount_cents=inputItem.item_discount_cents??0;if(!validMoney(item_discount_cents))throw businessError('INVALID_DISCOUNT');
      if(input.discount_cents>0||item_discount_cents>0)this.authorize(context,'sales.discount');
      let snapshot:Pick<DraftItem,'product_id'|'product_version'|'line_type'|'description'|'unit'|'price_cents'|'unit_cost_cents'>;
      if(inputItem.product_id!==null){const product=await tx.business.product(inputItem.product_id);if(!product||!product.active)throw businessConflict('PRODUCT_UNAVAILABLE');if(product.version!==inputItem.expected_product_version)throw versionConflict(product.version,inputItem.expected_product_version);
        snapshot={product_id:product.id,product_version:product.version,line_type:'catalog',description:product.name,unit:product.unit,price_cents:product.price_cents,unit_cost_cents:product.cost_cents};
      }else{const description=catalogText(inputItem.description);if(!description||!validMoney(inputItem.price_cents))throw businessError('INVALID_MANUAL_ITEM');snapshot={product_id:null,product_version:null,line_type:'manual',description,unit:'unit',price_cents:inputItem.price_cents,unit_cost_cents:null};}
      items.push({id:inputItem.id,store_id:this.deps.storeId,sale_id:saleId,...snapshot,quantity_milli:inputItem.quantity_milli,item_discount_cents});
    }
    items.sort((a,b)=>a.id<b.id?-1:1);if(items.length)this.prices(items,input.discount_cents);else if(input.discount_cents>0)throw businessError('INVALID_DISCOUNT');
    return {items,note:note??null,customer_id:input.customer_id,customer_name:customer?.name??null};
  }
  private async auditDraft(tx:BusinessTransaction,context:BusinessContext,intention:string){await tx.audit.append({operation_id:intention,store_id:this.deps.storeId,device_id:this.deps.deviceId,occurred_at:this.now(),action:'sale.draft_saved',actor_user_id:context.user_id,permissions_version:context.permissions_version,authorization_id:context.authorization_id,authorization_origin:context.authorization_origin});}
  async createDraft(context:BusinessContext,intention:string,id:string,input:DraftInput){
    this.guard(context);const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'sales.createDraft',device_id:this.deps.deviceId,id,input},async()=>{
      this.guard(context);if(await tx.business.draft(id)||await tx.business.sale(id))throw businessConflict('SALE_ID_ALREADY_USED');
      const {items,...snapshot}=await this.resolve(tx,context,id,input),draft:SaleDraft={id,store_id:this.deps.storeId,device_id:this.deps.deviceId,operator_id:context.user_id,version:1,status:'draft',...snapshot,discount_cents:input.discount_cents,updated_at:this.now()};
      await tx.business.saveDraft(draft);await tx.business.replaceDraftItems(id,items);await this.auditDraft(tx,context,intention);return {draft,items};
    }));return this.draftView(result.draft,result.items,context);
  }
  async updateDraft(context:BusinessContext,intention:string,id:string,expected:number,input:DraftInput){
    this.guard(context);const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'sales.updateDraft',device_id:this.deps.deviceId,id,expected,input},async()=>{
      this.guard(context);const previous=await this.draft(tx,id);if(previous.status!=='draft')throw businessConflict('SALE_ALREADY_COMPLETED');if(previous.version!==expected)throw versionConflict(previous.version,expected);
      const {items,...snapshot}=await this.resolve(tx,context,id,input),draft={...previous,...snapshot,discount_cents:input.discount_cents,version:previous.version+1,updated_at:this.now()};
      await tx.business.saveDraft(draft);await tx.business.replaceDraftItems(id,items);await this.auditDraft(tx,context,intention);return {draft,items};
    }));return this.draftView(result.draft,result.items,context);
  }
  async getDraft(context:BusinessContext,id:string){this.guard(context,'sales.read');return this.transaction(async(tx)=>{const draft=await this.draft(tx,id);return {...this.draftView(draft,await tx.business.draftItems(id),context),settings_version:(await tx.business.settings()).version};});}
  async complete(context:BusinessContext,intention:string,input:{sale_id:string;session_id:string;expected_draft_version:number;expected_settings_version:number;payments:ManualPayment[]}){
    this.guard(context);const code=await this.deviceCode();if(!/^CX[0-9]{2,12}$/.test(code))throw businessError('DEVICE_CODE_REQUIRED');
    const command={kind:'sales.complete',device_id:this.deps.deviceId,input},hash=this.deps.hash(command);
    const result=await this.transaction((tx)=>this.replay(tx,context,intention,command,async()=>{
      this.guard(context);const prior=await tx.business.sale(input.sale_id);if(prior){if(prior.sale.device_id!==this.deps.deviceId||prior.sale.operator_id!==context.user_id||prior.sale.completion_hash!==hash)throw businessConflict('SALE_ALREADY_COMPLETED');return prior;}
      const draft=await this.draft(tx,input.sale_id);if(draft.status!=='draft')throw businessConflict('SALE_ALREADY_COMPLETED');if(draft.version!==input.expected_draft_version)throw versionConflict(draft.version,input.expected_draft_version);
      const settings=await tx.business.settings();if(settings.version!==input.expected_settings_version)throw businessConflict('SALE_POLICY_CHANGED','As regras mudaram; confira a venda novamente.');
      const stock=new StockService(this.deps),cash=new CashService(this.deps),session=await cash.requireOpen(tx,context,input.session_id),items=await tx.business.draftItems(draft.id),totals=this.prices(items,draft.discount_cents);
      if(totals.discount_cents>0)this.authorize(context,'sales.discount');
      for(const item of items){if(item.product_id){const product=await tx.business.product(item.product_id);if(!product||!product.active)throw businessConflict('PRODUCT_UNAVAILABLE');if(product.version!==item.product_version||product.price_cents!==item.price_cents||product.unit!==item.unit||product.cost_cents!==item.unit_cost_cents)throw businessConflict('SALE_PRICE_CHANGED','O cadastro mudou; atualize o rascunho antes de concluir.');}}
      if(draft.customer_id){const customer=await tx.business.customer(draft.customer_id);if(!customer?.active)throw businessConflict('CUSTOMER_UNAVAILABLE');}
      if(!validPayments(input.payments,totals.total_cents))throw businessError('INVALID_PAYMENTS','Confira os valores aplicados, entregues e o troco.');
      const sequence=await tx.sequences.next(this.deps.deviceId),at=this.now();
      const sale:Sale={id:draft.id,store_id:this.deps.storeId,device_id:this.deps.deviceId,device_code:code,device_seq:sequence,number:`${code}-${sequence.padStart(6,'0')}`,session_id:session.id,operator_id:context.user_id,customer_id:draft.customer_id,customer_name:draft.customer_name,note:draft.note,business_date:session.business_date,time_zone:session.time_zone,
        subtotal_cents:totals.subtotal_cents,discount_cents:totals.discount_cents,sale_discount_cents:totals.sale_discount_cents,total_cents:totals.total_cents,tendered_cents:input.payments.reduce((n,p)=>n+p.tendered_cents,0),change_cents:input.payments.reduce((n,p)=>n+p.change_cents,0),stock_policy:settings.stock_policy,settings_version:settings.version,pricing_policy:'catalog_integer_positive_v1',authorization_context:JSON.stringify(context),completion_intention_id:intention,completion_hash:hash,draft_version:draft.version,local_commit_at:at};
      await tx.business.insertSale(sale);
      const finalItems:SaleItem[]=items.map((item,index)=>{const {id:_id,...prices}=totals.lines[index]!;const cost=item.unit_cost_cents===null?null:lineSubtotal(item.unit_cost_cents,item.quantity_milli);if(cost===undefined)throw businessError('COST_OUT_OF_RANGE');return {...item,...prices,cost_total_cents:cost};});
      for(const item of finalItems)await tx.business.insertSaleItem(item);
      const payments=input.payments.map((payment)=>({...payment,store_id:this.deps.storeId,sale_id:sale.id,confirmation:'manual' as const})).sort((a,b)=>a.id<b.id?-1:1);for(const payment of payments)await tx.business.insertSalePayment(payment);
      const stockMovements=await stock.recordSale(tx,context,sale.id,items.map((item)=>({item_id:item.id,product_id:item.product_id,quantity_milli:item.quantity_milli})));
      const cashMovements=await cash.recordPayments(tx,context,session.id,intention,sale.id,payments);
      await tx.business.saveDraft({...draft,status:'completed',version:draft.version+1,updated_at:at});
      const aggregate={sale,items:finalItems,payments};
      // Um único agregado autoritativo. O servidor deriva efeitos; IDs preservam identidade sem uma segunda lista de deltas a aplicar.
      await this.event(tx,context,intention,'sale.completed',{schema_version:1,...aggregate,stock_movement_ids:stockMovements.map((m)=>({item_id:m.item_id,id:m.id})),cash_movement_ids:cashMovements.map((m)=>({payment_id:m.component_id,id:m.id})),dependencies:{cash_session_id:session.id}},sequence);
      return aggregate;
    }));return this.completedView(result,context);
  }
  async getCompletionResult(context:BusinessContext,intention:string){this.guard(context,'sales.read');return this.transaction(async(tx)=>{
    let result=await tx.business.saleByIntention(intention);
    if(!result){const replay=await tx.business.intention(intention);if(replay&&replay.actor_id===context.user_id){const saved=JSON.parse(replay.result_json) as Partial<SaleAggregate>;if(saved.sale?.id)result=await tx.business.sale(saved.sale.id);}}
    if(!result||result.sale.device_id!==this.deps.deviceId)return {completion:null};return this.completedView(result,context);
  });}
}
