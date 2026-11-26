import type { Clock,UnitOfWork } from './ports.js';
import type { BusinessContext,BusinessRepository } from './business-ports.js';
export interface SalesFilter {from?:string;to?:string;device_id?:string;session_id?:string;operator_id?:string;customer_id?:string;operation_id?:string;status?:'completed'|'reversed';after?:string;limit?:number}
export interface ReadRange {from:string;to:string;time_zone:string;device_id?:string;group?:'day'|'hour'}
export interface ReportEventQuery extends ReadRange {after?:string;limit?:number}
export interface TerminalReport {download_cursor:string;pending:number;in_flight:number;acknowledged:number;conflicts:number;oldest_pending_at:string|null;last_receipt_at:string|null;phase:string;last_code:string|null;automatic_sync_enabled:boolean;schema_version:number;protocol_version:1}
export interface ReadRepository {
  sales(query:SalesFilter&{limit:number;after_at?:string;after_id?:string}):Promise<Record<string,unknown>[]>;
  saleState(id:string):Promise<{reversed:boolean;sync_status:'pending'|'acknowledged'|'received';operator_name:string|null}|undefined>;
  summary(range:ReadRange):Promise<{totals:Record<string,string>;movements:{kind:string;method:string;amount:string}[];minutes:{minute:string;sales_cents:string;refunds_cents:string}[]}>;
  events(query:ReadRange&{limit:number;after_at?:string;after_id?:string;after_kind?:string}):Promise<{id:string;sale_id:string;number:string;occurred_at:string;kind:'sale'|'reversal';amount_cents:number;device_id:string}[]>;
  terminals(after?:string,id?:string):Promise<Record<string,unknown>[]>;
  report(credentialHash:string,value:TerminalReport,at:string):Promise<boolean>;
  closureState(id:string):Promise<boolean>;
}
export interface ReadTransaction {read:ReadRepository;business:BusinessRepository}
export interface ReadDependencies {unitOfWork:UnitOfWork<ReadTransaction>;storeId:string;deviceId?:string;local:boolean;clock:Clock;digest?:(value:string)=>string}
export type ReadContext=BusinessContext;
