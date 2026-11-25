import { BusinessBase, businessConflict, businessError } from './business-base.js';
import type { BusinessContext, BusinessTransaction, Product, StockMovement } from './business-ports.js';
import { ApplicationError } from './application-error.js';
import { catalogText, stockRequirements, sumQuantity, validMoney, validQuantity } from '../../domain/src/catalog-stock.js';
import { idCursor, movementCursor, parseMovementCursor } from '../../domain/src/cursors.js';

export interface StockLine {item_id:string;product_id:string|null;quantity_milli:number}
const reasonText=(value:string)=>{const result=catalogText(value,500,true);if(!result)throw businessError('REASON_REQUIRED');return result;};
export class StockService extends BusinessBase {
  private local(){if(!this.deps.local)throw new ApplicationError('LOCAL_STOCK_ONLY','Movimentos são registrados no serviço local.','forbidden');}
  private async product(tx:BusinessTransaction,id:string,active=true):Promise<Product>{
    const product=await tx.business.product(id);if(!product)throw new ApplicationError('PRODUCT_NOT_FOUND','Produto não encontrado.','not_found');
    if(active&&!product.active)throw businessConflict('PRODUCT_INACTIVE','Produto inativo.');return product;
  }
  private visible(movement:StockMovement,context:BusinessContext){
    const {store_id:_store,authorization_context:_authorization,unit_cost_cents,...rest}=movement;
    return {...rest,...(context.permissions.includes('costs.read')?{unit_cost_cents}:{})};
  }
  async balances(context:BusinessContext,query:{q?:string;after?:string;limit?:number;active?:boolean;product_id?:string}={}){
    this.authorize(context,'catalog.read');const page=this.pageQuery(query);
    return this.transaction(async(tx)=>{const rows=query.product_id?[await this.product(tx,query.product_id,false)]:await tx.business.page('products',page),items=rows.slice(0,page.limit);
      return {items:await Promise.all(items.map(async(product)=>{const {store_id:_store,...balance}=await tx.business.balance(product.id);return {name:product.name,active:product.active,unit:(product as Product).unit,...balance};})),
        next_cursor:rows.length>page.limit?idCursor(items.at(-1)!.id):null,scope:this.scope(),as_of:this.now()};});
  }
  async movements(context:BusinessContext,query:{product_id?:string;from?:string;to?:string;after?:string;limit?:number}={}){
    this.authorize(context,'catalog.read');const {limit}=this.pageQuery(query.limit===undefined?{}:{limit:query.limit});
    const after=query.after===undefined?undefined:parseMovementCursor(query.after);
    if(query.after!==undefined&&!after)throw businessError('INVALID_CURSOR');
    for(const date of [query.from,query.to])if(date!==undefined&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,19)!==date.slice(0,19)))throw businessError('INVALID_DATE');
    const from=query.from?new Date(query.from).toISOString():undefined,to=query.to?new Date(query.to).toISOString():undefined;
    if(from&&to&&from>to)throw businessError('INVALID_DATE_RANGE');
    return this.transaction(async(tx)=>{const rows=await tx.business.movements({limit,...(query.product_id?{product_id:query.product_id}:{}),...(from?{from}:{}),...(to?{to}:{}),...(after?{after_at:after.at,after_id:after.id}:{})});
      const items=rows.slice(0,limit),last=items.at(-1);return {items:items.map((row)=>this.visible(row,context)),next_cursor:rows.length>limit&&last?movementCursor(last.occurred_at,last.id):null,scope:this.scope(),as_of:this.now()};});
  }
  private async append(tx:BusinessTransaction,context:BusinessContext,product:Product,kind:StockMovement['kind'],origin:string,item:string,delta:number,cost:number|null,reason:string){
    const previous=await tx.business.movementByOrigin(origin,kind,item);
    if(previous){if(previous.product_id!==product.id||previous.delta_milli!==delta||previous.unit_cost_cents!==cost||previous.reason!==reason)throw businessConflict('MOVEMENT_ORIGIN_CONFLICT');return previous;}
    if(!validQuantity(delta,product.unit,true))throw businessError('INVALID_QUANTITY');
    const balance=await tx.business.balance(product.id),after=sumQuantity([balance.quantity_milli,delta]);if(after===undefined)throw businessError('QUANTITY_OUT_OF_RANGE');
    const movement:StockMovement={id:this.deps.ids.generate(),store_id:this.deps.storeId,product_id:product.id,device_id:this.deps.deviceId,operator_id:context.user_id,kind,origin_id:origin,item_id:item,delta_milli:delta,before_milli:balance.quantity_milli,after_milli:after,unit:product.unit,unit_cost_cents:cost,reason,occurred_at:this.now(),authorization_context:JSON.stringify(context)};
    await tx.business.appendMovement(movement);await tx.business.saveBalance({...balance,quantity_milli:after,version:balance.version+1});return movement;
  }
  async registerEntry(context:BusinessContext,intention:string,input:{product_id:string;quantity_milli:number;unit_cost_cents:number|null;reason:string;kind?:'entry'|'opening'}){
    this.local();this.authorize(context,'stock.adjust');
    if(input.unit_cost_cents!==null&&!validMoney(input.unit_cost_cents))throw businessError('INVALID_COST');
    const normalized={...input,kind:input.kind??'entry',reason:reasonText(input.reason)};
    const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'stock.entry',input:normalized},async()=>{
      const product=await this.product(tx,input.product_id);if(!validQuantity(input.quantity_milli,product.unit))throw businessError('INVALID_QUANTITY');
      const movement=await this.append(tx,context,product,normalized.kind,intention,product.id,input.quantity_milli,input.unit_cost_cents,normalized.reason);
      await this.event(tx,context,intention,'stock.entry.v1',{movement});return {movement,balance:await tx.business.balance(product.id)};
    }));const {store_id:_store,...balance}=result.balance;
    return {movement:this.visible(result.movement,context),balance,scope:this.scope(),as_of:result.movement.occurred_at};
  }
  async adjustCount(context:BusinessContext,intention:string,input:{product_id:string;counted_milli:number;expected_quantity_milli:number;expected_version:number;reason:string}){
    this.local();this.authorize(context,'stock.adjust');const reason=reasonText(input.reason);
    const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'stock.count',input:{...input,reason}},async()=>{
      const product=await this.product(tx,input.product_id),balance=await tx.business.balance(product.id);
      if(!validQuantity(input.counted_milli,product.unit,false,true))throw businessError('INVALID_QUANTITY');
      if(balance.version!==input.expected_version||balance.quantity_milli!==input.expected_quantity_milli)throw businessConflict('STOCK_COUNT_CONFLICT','O saldo mudou desde a contagem; confira novamente.');
      const delta=sumQuantity([input.counted_milli,-balance.quantity_milli]);if(delta===undefined)throw businessError('QUANTITY_OUT_OF_RANGE');
      const movement=delta===0?null:await this.append(tx,context,product,'adjustment',intention,product.id,delta,null,reason);
      await this.event(tx,context,intention,'stock.count.v1',{product_id:product.id,counted_milli:input.counted_milli,expected_version:input.expected_version,reason,movement});return {movement,balance:await tx.business.balance(product.id),as_of:this.now()};
    }));const {store_id:_store,...balance}=result.balance;return {movement:result.movement?this.visible(result.movement,context):null,balance,scope:this.scope(),as_of:result.as_of};
  }
  // B07/B09 chamam estes auxiliares dentro da mesma transação da venda/estorno.
  // Não existem rotas HTTP/IPC para fabricar saídas ou estornos isolados.
  async recordSale(tx:BusinessTransaction,context:BusinessContext,origin:string,lines:readonly StockLine[]){
    this.local();this.authorize(context,'sales.create');
    if(new Set(lines.map((line)=>line.item_id)).size!==lines.length)throw businessError('DUPLICATE_SALE_ITEM');
    const settings=await tx.business.settings(),requirements=stockRequirements(settings.stock_policy,lines);
    if('error' in requirements)throw businessError(requirements.error);
    const products=new Map<string,Product>();
    for(const [id,total] of requirements.totals){
      const product=await this.product(tx,id);products.set(id,product);
      for(const line of lines.filter((line)=>line.product_id===id))if(!validQuantity(line.quantity_milli,product.unit))throw businessError('INVALID_QUANTITY');
      const previous=await Promise.all(lines.filter((line)=>line.product_id===id).map((line)=>tx.business.movementByOrigin(origin,'sale',line.item_id)));
      if(previous.some(Boolean)&&previous.some((row)=>!row))throw businessConflict('MOVEMENT_ORIGIN_CONFLICT');
      if(!previous.some(Boolean)&&settings.stock_policy==='require_stock'&&(await tx.business.balance(id)).quantity_milli<total)throw businessConflict('INSUFFICIENT_LOCAL_STOCK','Saldo insuficiente neste terminal.');
    }
    const movements:StockMovement[]=[];
    for(const line of lines)if(line.product_id!==null){const previous=await tx.business.movementByOrigin(origin,'sale',line.item_id);movements.push(await this.append(tx,context,products.get(line.product_id)!,'sale',origin,line.item_id,-line.quantity_milli,previous?previous.unit_cost_cents:products.get(line.product_id)!.cost_cents,'Venda'));}
    return movements;
  }
  async recordFullReversal(tx:BusinessTransaction,context:BusinessContext,saleId:string,lines:readonly StockLine[]){
    this.local();this.authorize(context,'sales.reverse');const result:StockMovement[]=[];
    if(new Set(lines.map((line)=>line.item_id)).size!==lines.length)throw businessError('DUPLICATE_SALE_ITEM');
    for(const line of lines){if(line.product_id===null)continue;
      const original=await tx.business.movementByOrigin(saleId,'sale',line.item_id);
      if(!original||original.product_id!==line.product_id||original.delta_milli!==-line.quantity_milli)throw businessConflict('ORIGINAL_MOVEMENT_MISMATCH');
      result.push(await this.append(tx,context,await this.product(tx,line.product_id,false),'reversal',saleId,line.item_id,line.quantity_milli,original.unit_cost_cents,'Estorno integral'));
    }return result;
  }
  async rebuild(context:BusinessContext,intention:string,productId:string){
    this.local();this.authorize(context,'recovery.manage');
    const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'stock.rebuild',product_id:productId},async()=>{
      await this.product(tx,productId,false);const total=BigInt(await tx.business.ledgerSum(productId));
      if(total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(-Number.MAX_SAFE_INTEGER))throw businessError('QUANTITY_OUT_OF_RANGE');
      const previous=await tx.business.balance(productId),balance={...previous,quantity_milli:Number(total),version:previous.version+1};
      await tx.business.saveBalance(balance);await this.event(tx,context,intention,'stock.projection.rebuilt.v1',{previous,balance});return {...balance,as_of:this.now()};
    }));const {store_id:_store,...balance}=result;return {...balance,scope:this.scope()};
  }
}
