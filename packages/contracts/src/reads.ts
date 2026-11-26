import { Type,type Static } from 'typebox';
import { UuidSchema as uuid,UtcInstantSchema as instant,CentsSchema as cents,DecimalCursorSchema as cursor,RequestIdSchema,MetaSchema,successSchema } from './common.js';
import { ReadSale } from './sales.js';
import { ReversalResult,RawClosure } from './reversals.js';
const closed={additionalProperties:false},nullableText=Type.Union([Type.String(),Type.Null()]),signed=Type.Integer({minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER}),count=Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER}),optionalId=Type.Optional(uuid),nullableInstant=Type.Union([instant,Type.Null()]);
const totals=Type.Object({cash:signed,credit:signed,debit:signed,pix:signed},closed),scope=Type.Union([Type.Literal('local_terminal'),Type.Literal('server_received')]),metadata={scope,as_of:instant};
export const ReadSalesQuery=Type.Object({from:Type.Optional(instant),to:Type.Optional(instant),device_id:optionalId,session_id:optionalId,operator_id:optionalId,customer_id:optionalId,operation_id:optionalId,status:Type.Optional(Type.Union([Type.Literal('completed'),Type.Literal('reversed')])),after:Type.Optional(cursor),limit:Type.Optional(Type.String({pattern:'^([1-9][0-9]?|100)$'}))},closed);
export const ReadNativeSalesQuery=Type.Object({...ReadSalesQuery.properties,limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},closed);
export const ReportQuery=Type.Object({from:instant,to:instant,time_zone:Type.String({minLength:1,maxLength:100}),device_id:optionalId,group:Type.Optional(Type.Union([Type.Literal('day'),Type.Literal('hour')]))},closed);
export const ReportEventsQuery=Type.Object({...ReportQuery.properties,after:Type.Optional(cursor),limit:ReadSalesQuery.properties.limit},closed),NativeReportEventsQuery=Type.Object({...ReportEventsQuery.properties,limit:ReadNativeSalesQuery.properties.limit},closed);
export const TerminalReport=Type.Object({download_cursor:cursor,pending:count,in_flight:count,acknowledged:count,conflicts:count,oldest_pending_at:nullableInstant,last_receipt_at:nullableInstant,phase:Type.String({pattern:'^[a-z_]{1,64}$'}),last_code:Type.Union([Type.String({pattern:'^[A-Z][A-Z0-9_]{0,99}$'}),Type.Null()]),automatic_sync_enabled:Type.Boolean(),schema_version:Type.Integer({minimum:1,maximum:9999}),protocol_version:Type.Literal(1)},closed);
const terminal=Type.Object({device_id:uuid,code:Type.String(),active:Type.Boolean(),version:count,received_seq:Type.String({pattern:'^(0|[1-9][0-9]{0,18})$'}),last_report_at:nullableInstant,last_contact_at:nullableInstant,impeded_operations:count,queue_state:Type.Union(['unknown','stale','reported'].map((v)=>Type.Literal(v))),report:Type.Union([TerminalReport,Type.Null()])},closed);
const saleRow=Type.Object({id:uuid,number:Type.String(),device_id:uuid,device_code:Type.String(),operator_id:uuid,session_id:uuid,customer_id:Type.Union([uuid,Type.Null()]),customer_name:nullableText,local_commit_at:instant,business_date:Type.String(),time_zone:Type.String(),total_cents:cents,discount_cents:cents,status:Type.Union([Type.Literal('completed'),Type.Literal('reversed')]),sync_status:Type.Union(['pending','acknowledged','received'].map((v)=>Type.Literal(v)))},closed);
const page={next_cursor:Type.Union([cursor,Type.Null()]),...metadata};
export const SalesPage=Type.Object({items:Type.Array(saleRow,{maxItems:100}),...page},closed);
const {sync_status:_sync,...reversal}=ReversalResult.properties;
export const ReadReversal=Type.Object(reversal,closed);
export const SaleDetail=Type.Object({sale:ReadSale,reversal:Type.Union([ReadReversal,Type.Null()]),...metadata},closed);
export const ReversalPage=Type.Object({items:Type.Array(ReadReversal,{maxItems:1}),...metadata},closed);
const {store_id:_store,authorization_context:_auth,expected_json:_expected,counted_json:_counted,difference_json:_diff,...closure}=RawClosure.properties;
export const ReadClosure=Type.Object({closure:Type.Union([Type.Object({...closure,expected_by_method:totals,counted_by_method:Type.Object({cash:cents,credit:cents,debit:cents,pix:cents},closed),difference_by_method:totals,reconciliation:Type.Union([Type.Literal('pending'),Type.Literal('reconciled')])},closed),Type.Null()]),...metadata},closed);
export const TerminalPage=Type.Object({items:Type.Array(terminal,{maxItems:100}),...page},closed);
export const ReportSummary=Type.Object({...metadata,bucket_coverage:Type.Union([Type.Literal('complete'),Type.Literal('limit_exceeded')]),buckets:Type.Array(Type.Object({key:Type.String(),label:Type.String(),from:instant,to:instant,sales_cents:cents,refunds_cents:cents,net_cents:signed},closed),{maxItems:5000}),period:Type.Object({...ReportQuery.properties,interval:Type.Literal('[from,to)')},closed),criteria:Type.Object({sales:Type.Literal('sale.local_commit_at'),refunds:Type.Literal('reversal.occurred_at'),cash:Type.Literal('movement.occurred_at'),ticket:Type.Literal('gross / sale_count'),cost:Type.Literal('historical_item_snapshot'),stock_scope:Type.Literal('local_terminal')},closed),gross_sales_cents:cents,sale_count:count,refunds_cents:cents,refund_count:count,net_movement_cents:signed,average_ticket_cents:Type.Union([cents,Type.Null()]),receipts_by_method:totals,refunds_by_method:totals,other_receipts_by_method:totals,drawer_movement_cents:signed,cost_coverage:Type.Optional(Type.Object({known_item_count:count,unknown_item_count:count,known_revenue_cents:cents,known_cost_cents:cents,known_refund_cents:cents,refunded_cost_cents:cents,estimated_gross_result_cents:Type.Union([signed,Type.Null()])},closed)),coverage:Type.Union([Type.Object({device_id:uuid},closed),Type.Object({terminals:Type.Array(terminal,{maxItems:101})},closed)])},closed);
export const ReportEventsPage=Type.Object({items:Type.Array(Type.Object({id:uuid,sale_id:uuid,number:Type.String(),occurred_at:instant,kind:Type.Union([Type.Literal('sale'),Type.Literal('reversal')]),amount_cents:signed,device_id:uuid},closed),{maxItems:100}),...page},closed);
export const ReadIdParams=Type.Object({id:uuid},closed),TerminalParams=Type.Object({device_id:uuid},closed),TerminalQuery=Type.Object({after:Type.Optional(cursor)},closed);
const common={request_id:RequestIdSchema};
export const readCommands=Type.Union([
  Type.Object({type:Type.Literal('query.sales'),...common,query:ReadNativeSalesQuery},closed),
  Type.Object({type:Type.Literal('query.sale'),...common,id:uuid},closed),
  Type.Object({type:Type.Literal('query.reversals'),...common,id:uuid},closed),
  Type.Object({type:Type.Literal('query.closure'),...common,id:uuid},closed),
  Type.Object({type:Type.Literal('query.reportEvents'),...common,query:NativeReportEventsQuery},closed),
  Type.Object({type:Type.Literal('query.summary'),...common,query:ReportQuery},closed),
]);
export const QueryResponse=Type.Object({type:Type.Literal('query.result'),data:Type.Union([SalesPage,SaleDetail,ReversalPage,ReadClosure,ReportSummary,ReportEventsPage]),meta:MetaSchema},closed);
export const SalesPageResponse=successSchema(SalesPage),SaleDetailResponse=successSchema(SaleDetail),ReversalsResponse=successSchema(ReversalPage),ReadClosureResponse=successSchema(ReadClosure),ReportResponse=successSchema(ReportSummary),TerminalsResponse=successSchema(TerminalPage),ReportAcceptedResponse=successSchema(Type.Object({accepted:Type.Literal(true)},closed));
export type ReadCommand=Static<typeof readCommands>;

export const ReportEventsResponse=successSchema(ReportEventsPage);
