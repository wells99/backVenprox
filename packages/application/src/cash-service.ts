import { BusinessBase, businessConflict, businessError } from './business-base.js';
import type { BusinessContext, BusinessTransaction } from './business-ports.js';
import type { CashSession, CashMovement, PaymentMethod } from './cash-ports.js';
import { ApplicationError } from './application-error.js';
import { businessDate } from '../../domain/src/cash.js';
import { catalogText, validMoney } from '../../domain/src/catalog-stock.js';
import { idCursor } from '../../domain/src/cursors.js';

export class CashService extends BusinessBase {
  local(){if(!this.deps.local)throw new ApplicationError('LOCAL_CASH_ONLY','Caixa é operado no terminal local.','forbidden');}
  async requireOpen(tx:BusinessTransaction,context:BusinessContext,id:string):Promise<CashSession>{
    this.local();this.authorize(context,'sales.create');
    const session=await tx.business.cashSession(id);
    if(!session||session.device_id!==this.deps.deviceId)throw businessConflict('CASH_SESSION_REQUIRED','Abra o caixa deste terminal antes de continuar.');
    if(session.status!=='open')throw businessConflict('CASH_SESSION_CLOSED','A sessão de caixa está fechada.');return session;
  }
  private async view(tx:BusinessTransaction,session:CashSession){const {store_id:_store,...value}=session;return {...value,expected_by_method:await tx.business.cashTotals(session.id),pending_sync:this.deps.local?await tx.business.cashPending(session.id):false};}
  async current(context:BusinessContext){this.local();this.authorize(context,'sales.read');return this.transaction(async(tx)=>{const row=await tx.business.currentCash(this.deps.deviceId);return {session:row?await this.view(tx,row):null,scope:this.scope(),as_of:this.now()};});}
  async list(context:BusinessContext,query:{device_id?:string;after?:string;limit?:number}={}){
    this.authorize(context,'sales.read');const page=this.pageQuery(query);
    return this.transaction(async(tx)=>{const rows=await tx.business.cashSessions({...page,...(this.deps.local?{device_id:this.deps.deviceId}:query.device_id?{device_id:query.device_id}:{})}),items=rows.slice(0,page.limit);
      return {items:await Promise.all(items.map((row)=>this.view(tx,row))),next_cursor:rows.length>page.limit?idCursor(items.at(-1)!.id):null,scope:this.scope(),as_of:this.now()};});
  }
  private async readable(tx:BusinessTransaction,id:string){const row=await tx.business.cashSession(id);if(!row||this.deps.local&&row.device_id!==this.deps.deviceId)throw new ApplicationError('CASH_SESSION_NOT_FOUND','Caixa não encontrado.','not_found');return row;}
  async get(context:BusinessContext,id:string){this.authorize(context,'sales.read');return this.transaction(async(tx)=>({session:await this.view(tx,await this.readable(tx,id)),scope:this.scope(),as_of:this.now()}));}
  async movements(context:BusinessContext,id:string,query:{after?:string;limit?:number;origin_id?:string}={}){
    this.authorize(context,'sales.read');const page=this.pageQuery(query);
    return this.transaction(async(tx)=>{await this.readable(tx,id);const rows=await tx.business.cashMovements(id,{...page,...(query.origin_id?{origin_id:query.origin_id}:{})}),items=rows.slice(0,page.limit);
      return {items:items.map(({store_id:_store,...value})=>value),next_cursor:rows.length>page.limit?idCursor(items.at(-1)!.id):null,scope:this.scope(),as_of:this.now()};});
  }
  async open(context:BusinessContext,intention:string,input:{opening_cents:number;business_date:string;time_zone:string}){
    this.local();this.authorize(context,'cash.open');if(!validMoney(input.opening_cents))throw businessError('INVALID_OPENING_AMOUNT');
    return this.transaction((tx)=>this.replay(tx,context,intention,{kind:'cash.open',device_id:this.deps.deviceId,input},async()=>{
      if(businessDate(this.now(),input.time_zone)!==input.business_date)throw businessError('INVALID_BUSINESS_DATE','Informe a data comercial atual no fuso escolhido.');
      this.authorize(context,'cash.open');if(await tx.business.currentCash(this.deps.deviceId))throw businessConflict('CASH_ALREADY_OPEN','Já existe caixa aberto neste terminal.');
      const session:CashSession={id:this.deps.ids.generate(),store_id:this.deps.storeId,device_id:this.deps.deviceId,operator_id:context.user_id,opened_at:this.now(),...input,status:'open',version:1};
      await tx.business.insertCashSession(session);
      const movement=await this.append(tx,context,session,intention,session.id,session.id,'opening','cash',input.opening_cents,'Abertura');
      await this.event(tx,context,intention,'cash.opened',{schema_version:1,session,movement});
      return {session:await this.view(tx,session),scope:this.scope(),as_of:this.now()};
    }));
  }
  private async append(tx:BusinessTransaction,context:BusinessContext,session:CashSession,operation:string,origin:string,component:string,kind:CashMovement['kind'],method:PaymentMethod,amount:number,reason:string){
    const movement:CashMovement={id:this.deps.ids.generate(),store_id:this.deps.storeId,session_id:session.id,device_id:this.deps.deviceId,operator_id:context.user_id,operation_id:operation,origin_id:origin,component_id:component,kind,method,amount_cents:amount,reason,occurred_at:this.now()};
    await tx.business.appendCashMovement(movement);return movement;
  }
  async register(context:BusinessContext,intention:string,kind:'supply'|'withdrawal',input:{session_id:string;amount_cents:number;reason:string}){
    this.local();this.authorize(context,'cash.adjust');if(!validMoney(input.amount_cents)||input.amount_cents===0)throw businessError('INVALID_CASH_AMOUNT');
    const reason=catalogText(input.reason,500,true);if(!reason)throw businessError('REASON_REQUIRED');
    return this.transaction((tx)=>this.replay(tx,context,intention,{kind:`cash.${kind}`,device_id:this.deps.deviceId,input:{...input,reason}},async()=>{
      this.authorize(context,'cash.adjust');const session=await tx.business.cashSession(input.session_id);
      if(!session||session.device_id!==this.deps.deviceId)throw businessConflict('CASH_SESSION_REQUIRED');if(session.status!=='open')throw businessConflict('CASH_SESSION_CLOSED');
      if(kind==='withdrawal'&&(await tx.business.cashTotals(session.id)).cash<input.amount_cents)throw businessConflict('INSUFFICIENT_CASH','A sangria excede o dinheiro esperado.');
      const movement=await this.append(tx,context,session,intention,intention,intention,kind,'cash',kind==='supply'?input.amount_cents:-input.amount_cents,reason);
      await tx.business.cashTotals(session.id);await tx.business.bumpCashSession(session.id);
      await this.event(tx,context,intention,'cash.movement_recorded',{schema_version:1,movement});
      const {store_id:_store,...visible}=movement;return {movement:visible,session:await this.view(tx,{...session,version:session.version+1}),scope:this.scope(),as_of:this.now()};
    }));
  }
  // Somente a conclusão/reversão transacional chama este auxiliar, nunca o renderer.
  async recordPayments(tx:BusinessTransaction,context:BusinessContext,sessionId:string,operation:string,saleId:string,payments:readonly {id:string;method:PaymentMethod;applied_cents:number}[]){
    const session=await this.requireOpen(tx,context,sessionId),movements:CashMovement[]=[];
    for(const payment of payments){if(!validMoney(payment.applied_cents)||payment.applied_cents===0)throw businessError('INVALID_PAYMENT');movements.push(await this.append(tx,context,session,operation,saleId,payment.id,'sale',payment.method,payment.applied_cents,'Venda'));}
    await tx.business.cashTotals(session.id);await tx.business.bumpCashSession(session.id);return movements;
  }
}
