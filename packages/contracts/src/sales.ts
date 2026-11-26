import { Type } from 'typebox';
import { CentsSchema as cents, UuidSchema as uuid, UtcInstantSchema as instant, RequestIdSchema, BusinessDateSchema } from './common.js';
const closed={additionalProperties:false},nullableId=Type.Union([uuid,Type.Null()]),nullableText=Type.Union([Type.String(),Type.Null()]);
const version=Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER});
const quantity=Type.Integer({minimum:1000,maximum:Number.MAX_SAFE_INTEGER,multipleOf:1000});
const itemInputFields={id:uuid,quantity_milli:quantity,item_discount_cents:Type.Optional(cents)};
const itemInput=Type.Union([
  Type.Object({...itemInputFields,product_id:uuid,expected_product_version:version},closed),
  Type.Object({...itemInputFields,product_id:Type.Null(),description:Type.String({minLength:1,maxLength:1024}),price_cents:cents},closed),
]);
const input=Type.Object({items:Type.Array(itemInput,{maxItems:50}),customer_id:nullableId,note:Type.Union([Type.String({minLength:1,maxLength:8000}),Type.Null()]),discount_cents:cents},closed);
export const Payment=Type.Object({id:uuid,method:Type.Union(['cash','credit','debit','pix'].map((method)=>Type.Literal(method))),applied_cents:Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}),tendered_cents:cents,change_cents:cents},closed);
const baseItemFields={id:uuid,sale_id:uuid,product_id:nullableId,product_version:Type.Union([version,Type.Null()]),line_type:Type.Union([Type.Literal('catalog'),Type.Literal('manual')]),description:Type.String(),unit:Type.Union(['unit','kg','g','liter','milliliter','box','pack'].map((unit)=>Type.Literal(unit))),price_cents:cents,quantity_milli:quantity,item_discount_cents:cents};
const cost=Type.Union([cents,Type.Null()]);
const draftItem=Type.Object({...baseItemFields,unit_cost_cents:Type.Optional(cost)},closed);
const finalFields={subtotal_cents:cents,sale_discount_cents:cents,total_cents:cents,cost_total_cents:cost};
const finalItem=Type.Object({...baseItemFields,...finalFields,unit_cost_cents:Type.Optional(cost),cost_total_cents:Type.Optional(cost)},closed);
const saleFields={id:uuid,device_id:uuid,device_code:Type.String({pattern:'^CX[0-9]{2,12}$'}),device_seq:Type.String({pattern:'^[1-9][0-9]{0,18}$'}),number:Type.String(),session_id:uuid,operator_id:uuid,customer_id:nullableId,customer_name:nullableText,note:nullableText,business_date:BusinessDateSchema,time_zone:Type.String(),subtotal_cents:cents,discount_cents:cents,sale_discount_cents:cents,total_cents:cents,tendered_cents:cents,change_cents:cents,stock_policy:Type.Union([Type.Literal('permissive'),Type.Literal('require_stock')]),settings_version:version,pricing_policy:Type.Literal('catalog_integer_positive_v1'),completion_intention_id:uuid,draft_version:version,local_commit_at:instant};
const paymentFields={...Payment.properties,sale_id:uuid,confirmation:Type.Literal('manual')};
export const ReadSale=Type.Object({...saleFields,items:Type.Array(finalItem,{minItems:1,maxItems:50}),payments:Type.Array(Type.Object(paymentFields,closed),{minItems:1,maxItems:10}),reversed:Type.Boolean(),sync_status:Type.Union([Type.Literal('pending'),Type.Literal('acknowledged'),Type.Literal('received')]),operator_name:nullableText},closed);
const lineTotals=Type.Object({id:uuid,subtotal_cents:cents,item_discount_cents:cents,sale_discount_cents:cents,total_cents:cents},closed);
const draft=Type.Object({id:uuid,device_id:uuid,operator_id:uuid,version,status:Type.Union([Type.Literal('draft'),Type.Literal('completed')]),customer_id:nullableId,customer_name:nullableText,note:nullableText,discount_cents:cents,updated_at:instant,items:Type.Array(draftItem,{maxItems:50}),totals:Type.Object({subtotal_cents:cents,discount_cents:cents,sale_discount_cents:cents,total_cents:cents,lines:Type.Array(lineTotals,{maxItems:50})},closed)},closed);
export const DraftResult=Type.Object({draft,settings_version:Type.Optional(version)},closed);
const completion=Type.Object({sale:Type.Object({...saleFields,items:Type.Array(finalItem,{minItems:1,maxItems:50}),payments:Type.Array(Type.Object(paymentFields,closed),{minItems:1,maxItems:10})},closed),local_commit_at:instant,sync_status:Type.Literal('pending')},closed);
export const CompletionResult=Type.Object({completion:Type.Union([completion,Type.Null()])},closed);
const common={request_id:RequestIdSchema};
export const salesCommands=Type.Union([
  Type.Object({type:Type.Literal('sales.createDraft'),...common,intention_id:uuid,sale_id:uuid,input},closed),
  Type.Object({type:Type.Literal('sales.getDraft'),...common,sale_id:uuid},closed),
  Type.Object({type:Type.Literal('sales.updateDraft'),...common,intention_id:uuid,sale_id:uuid,expected_version:version,input},closed),
  Type.Object({type:Type.Literal('sales.complete'),...common,intention_id:uuid,input:Type.Object({sale_id:uuid,session_id:uuid,expected_draft_version:version,expected_settings_version:version,payments:Type.Array(Payment,{minItems:1,maxItems:10})},closed)},closed),
  Type.Object({type:Type.Literal('sales.getCompletionResult'),...common,intention_id:uuid},closed),
]);
// Agregado completo de sync: os efeitos são derivados uma única vez pelo receptor B10.
export const SaleCompletedEvent=Type.Object({schema_version:Type.Literal(1),sale:Type.Object({...saleFields,store_id:uuid,authorization_context:Type.String(),completion_hash:Type.String({pattern:'^[0-9a-f]{64}$'})},closed),items:Type.Array(Type.Object({...baseItemFields,...finalFields,store_id:uuid,unit_cost_cents:cost},closed),{minItems:1,maxItems:50}),payments:Type.Array(Type.Object({...paymentFields,store_id:uuid},closed),{minItems:1,maxItems:10}),stock_movement_ids:Type.Array(Type.Object({item_id:uuid,id:uuid},closed),{maxItems:50}),cash_movement_ids:Type.Array(Type.Object({payment_id:uuid,id:uuid},closed),{minItems:1,maxItems:10}),dependencies:Type.Object({cash_session_id:uuid},closed)},closed);
