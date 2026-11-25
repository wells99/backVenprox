import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { UuidSchema as uuid, CentsSchema as cents, UtcInstantSchema as instant } from './common.js';
import { Movement, Product, Category, Customer, StoreSettings } from './catalog-stock.js';
import { CashMovement } from './cash.js';
import { SaleCompletedEvent } from './sales.js';
import { CashClosedEvent, SaleReversedEvent } from './reversals.js';
const closed={additionalProperties:false},version=Type.Integer({minimum:1}),context=Type.String();
const rawStock=Type.Object({...Movement.properties,store_id:uuid,authorization_context:context,unit_cost_cents:Type.Union([cents,Type.Null()])},closed);
const rawCash=Type.Object({...CashMovement.properties,store_id:uuid},closed);
const rawSession=Type.Object({id:uuid,store_id:uuid,device_id:uuid,operator_id:uuid,opened_at:instant,business_date:Type.String({format:'date'}),time_zone:Type.String(),opening_cents:cents,status:Type.Literal('open'),version:Type.Literal(1)},closed);
const rawProduct=Type.Object({...Product.properties,store_id:uuid,search_key:Type.String(),code_key:Type.String(),cost_cents:Type.Union([cents,Type.Null()])},closed);
const rawCategory=Type.Object({...Category.properties,store_id:uuid,search_key:Type.String()},closed);
const rawCustomer=Type.Object({...Customer.properties,store_id:uuid,search_key:Type.String()},closed);
const rawSettings=Type.Object({...StoreSettings.properties,store_id:uuid},closed);
const proposal=Type.Object({entity_type:Type.Union([Type.Literal('products'),Type.Literal('categories'),Type.Literal('customers'),Type.Literal('settings')]),entity_id:uuid,base_version:Type.Integer({minimum:0}),proposal:Type.Union([rawProduct,rawCategory,rawCustomer,rawSettings])},closed);
const balance=Type.Object({store_id:uuid,product_id:uuid,quantity_milli:Type.Integer({minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER}),version:Type.Integer({minimum:0})},closed);
const schemas={
  'cash.opened':Type.Object({schema_version:Type.Literal(1),session:rawSession,movement:rawCash},closed),
  'cash.movement_recorded':Type.Object({schema_version:Type.Literal(1),movement:rawCash},closed),
  'sale.completed':SaleCompletedEvent,'sale.reversed':SaleReversedEvent,'cash.closed':CashClosedEvent,
  'stock.entry.v1':Type.Object({movement:rawStock},closed),
  'stock.count.v1':Type.Object({product_id:uuid,counted_milli:cents,expected_version:Type.Integer({minimum:0}),reason:Type.String(),movement:Type.Union([rawStock,Type.Null()])},closed),
  'stock.projection.rebuilt.v1':Type.Object({previous:balance,balance},closed),
  'customer.created.v1':Type.Object({customer:rawCustomer},closed),
  'terminal.settings.updated.v1':Type.Object({settings:Type.Object({store_id:uuid,device_id:uuid,version,automatic_printing:Type.Literal(false)},closed)},closed),
};
export function validateSyncPayload(type:string,payloadVersion:number,payload:unknown):boolean {
  if(payloadVersion!==1)return false;
  const schema=type in schemas?schemas[type as keyof typeof schemas]:/^(products|categories|customers|settings)\.proposal(?:\.conflict)?\.v1$/.test(type)?proposal:undefined;
  return schema!==undefined&&Value.Check(schema,payload);
}
