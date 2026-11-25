import { BusinessBase, businessConflict, businessError } from './business-base.js';
import type { BusinessContext } from './business-ports.js';
import type { CashClosure, CashTotals } from './reversal-ports.js';
import { CashService } from './cash-service.js';
import { catalogText } from '../../domain/src/catalog-stock.js';
import { cashDifference } from '../../domain/src/reversals.js';
import { ApplicationError } from './application-error.js';
export class ClosureService extends BusinessBase {
  private guard(context:BusinessContext,permission:'cash.close'|'sales.read'='cash.close'){if(!this.deps.local)throw new ApplicationError('LOCAL_CASH_ONLY','Fechamento é registrado no terminal local.','forbidden');this.authorize(context,permission);}
  private view(value:CashClosure){const {store_id:_store,authorization_context:_auth,expected_json,counted_json,difference_json,...closure}=value;return {closure:{...closure,expected_by_method:JSON.parse(expected_json) as CashTotals,counted_by_method:JSON.parse(counted_json) as CashTotals,difference_by_method:JSON.parse(difference_json) as CashTotals,state:'closed_local' as const,reconciliation:'pending' as const},sync_status:'pending' as const};}
  async preview(context:BusinessContext,sessionId:string){this.guard(context);return this.transaction(async(tx)=>{const session=await new CashService(this.deps).requireOpen(tx,context,sessionId,'cash.close');return {preview:{session_id:sessionId,session_version:session.version,previous_device_seq:await tx.business.cashFrontier(sessionId),expected_by_method:await tx.business.cashTotals(sessionId)},scope:this.scope(),as_of:this.now()};});}
  async close(context:BusinessContext,intention:string,input:{session_id:string;expected_version:number;expected_device_seq:string;counted_by_method:CashTotals;reason:string|null}){
    this.guard(context);const reason=input.reason===null?null:catalogText(input.reason,500,true);if(input.reason!==null&&!reason)throw businessError('INVALID_REASON');
    const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'cash.close',device_id:this.deps.deviceId,input:{...input,reason}},async()=>{
      this.guard(context);if(await tx.business.cashClosure(input.session_id))throw businessConflict('CASH_SESSION_CLOSED');
      const session=await new CashService(this.deps).requireOpen(tx,context,input.session_id,'cash.close'),frontier=await tx.business.cashFrontier(session.id);
      if(session.version!==input.expected_version||frontier!==input.expected_device_seq)throw businessConflict('CLOSURE_STALE','O caixa mudou após a prévia; confira novamente.');
      const expected=await tx.business.cashTotals(session.id),difference=cashDifference(expected,input.counted_by_method);if(!difference)throw businessError('INVALID_CASH_COUNT');
      if(Object.values(difference).some((n)=>n!==0)&&!reason)throw businessError('REASON_REQUIRED','Informe o motivo da diferença de conferência.');
      const sequence=await tx.sequences.next(this.deps.deviceId),closure:CashClosure={id:this.deps.ids.generate(),store_id:this.deps.storeId,session_id:session.id,device_id:this.deps.deviceId,operator_id:context.user_id,intention_id:intention,session_version:session.version,previous_device_seq:frontier,device_seq:sequence,expected_json:JSON.stringify(expected),counted_json:JSON.stringify(input.counted_by_method),difference_json:JSON.stringify(difference),reason:reason??null,closed_at:this.now(),authorization_context:JSON.stringify(context)};
      await tx.business.insertCashClosure(closure);await tx.business.closeCashSession(session.id);await this.event(tx,context,intention,'cash.closed',{schema_version:1,closure,dependencies:{cash_session_id:session.id}},sequence);return closure;
    }));return this.view(result);
  }
  async get(context:BusinessContext,sessionId:string){this.guard(context,'sales.read');return this.transaction(async(tx)=>{const value=await tx.business.cashClosure(sessionId);if(!value||value.device_id!==this.deps.deviceId)throw new ApplicationError('CLOSURE_NOT_FOUND','Fechamento não encontrado.','not_found');return this.view(value);});}
}
