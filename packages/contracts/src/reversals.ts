import { Type } from 'typebox';
import { CentsSchema as cents, UuidSchema as uuid, UtcInstantSchema as instant, RequestIdSchema } from './common.js';
const closed={additionalProperties:false},version=Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}),sequence=Type.String({pattern:'^(0|[1-9][0-9]{0,18})$'}),reason=Type.String({minLength:1,maxLength:2000});
const method=Type.Union([Type.Literal('cash'),Type.Literal('credit'),Type.Literal('debit'),Type.Literal('pix')]),signed=Type.Integer({minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER});
export const CashTotals=Type.Object({cash:signed,credit:signed,debit:signed,pix:signed},closed);
const counts=Type.Object({cash:cents,credit:cents,debit:cents,pix:cents},closed);
const reversalFields={id:uuid,sale_id:uuid,device_id:uuid,session_id:uuid,operator_id:uuid,intention_id:uuid,reason:Type.String(),total_cents:cents,occurred_at:instant};
const itemFields={id:uuid,reversal_id:uuid,sale_id:uuid,sale_item_id:uuid,quantity_milli:Type.Integer({minimum:1000,maximum:Number.MAX_SAFE_INTEGER,multipleOf:1000}),amount_cents:cents,stock_movement_id:Type.Union([uuid,Type.Null()])};
const refundFields={id:uuid,reversal_id:uuid,method,amount_cents:cents,confirmation:Type.Literal('manual')};
export const RawReversal=Type.Object({...reversalFields,store_id:uuid,authorization_context:Type.String()},closed);
export const RawReversalItem=Type.Object({...itemFields,store_id:uuid},closed);
export const RawRefundPayment=Type.Object({...refundFields,store_id:uuid},closed);
const closureFields={id:uuid,session_id:uuid,device_id:uuid,operator_id:uuid,intention_id:uuid,session_version:version,previous_device_seq:sequence,device_seq:sequence,reason:Type.Union([Type.String(),Type.Null()]),closed_at:instant};
export const RawClosure=Type.Object({...closureFields,store_id:uuid,expected_json:Type.String(),counted_json:Type.String(),difference_json:Type.String(),authorization_context:Type.String()},closed);
export const ReversalResult=Type.Object({reversal:Type.Object(reversalFields,closed),items:Type.Array(Type.Object(itemFields,closed),{maxItems:50}),payments:Type.Array(Type.Object(refundFields,closed),{maxItems:10}),sync_status:Type.Literal('pending')},closed);
export const ClosureResult=Type.Object({closure:Type.Object({...closureFields,expected_by_method:CashTotals,counted_by_method:counts,difference_by_method:CashTotals,state:Type.Literal('closed_local'),reconciliation:Type.Literal('pending')},closed),sync_status:Type.Literal('pending')},closed);
export const ClosurePreview=Type.Object({preview:Type.Object({session_id:uuid,session_version:version,previous_device_seq:sequence,expected_by_method:CashTotals},closed)},closed);
export const reversalCommands=Type.Union([
  Type.Object({type:Type.Literal('sales.reverse'),request_id:RequestIdSchema,intention_id:uuid,input:Type.Object({sale_id:uuid,session_id:uuid,reason,payments:Type.Array(Type.Object({id:uuid,method,amount_cents:Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER})},closed),{minItems:1,maxItems:10})},closed)},closed),
  Type.Object({type:Type.Literal('cash.previewClose'),request_id:RequestIdSchema,session_id:uuid},closed),
  Type.Object({type:Type.Literal('cash.close'),request_id:RequestIdSchema,intention_id:uuid,input:Type.Object({session_id:uuid,expected_version:version,expected_device_seq:sequence,counted_by_method:counts,reason:Type.Union([reason,Type.Null()])},closed)},closed),
  Type.Object({type:Type.Literal('cash.getClosure'),request_id:RequestIdSchema,session_id:uuid},closed),
]);
export const SaleReversedEvent=Type.Object({schema_version:Type.Literal(1),reversal:RawReversal,items:Type.Array(RawReversalItem,{minItems:1,maxItems:50}),payments:Type.Array(RawRefundPayment,{minItems:1,maxItems:10}),cash_movement_ids:Type.Array(Type.Object({payment_id:uuid,id:uuid},closed),{minItems:1,maxItems:10}),dependencies:Type.Object({sale_id:uuid,cash_session_id:uuid},closed)},closed);
export const CashClosedEvent=Type.Object({schema_version:Type.Literal(1),closure:RawClosure,dependencies:Type.Object({cash_session_id:uuid},closed)},closed);
