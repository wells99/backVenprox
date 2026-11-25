import { Type, type Static, type TSchema } from 'typebox';
import { BarcodeSchema, CentsSchema, DecimalCursorSchema, MetaSchema, QuantityMilliSchema, RequestIdSchema, UtcInstantSchema, UuidSchema, successSchema } from './common.js';
import { cashCommands, CashResult, CashAdjustmentResult, CashPage, CashMovements } from './cash.js';
import { salesCommands, DraftResult, CompletionResult } from './sales.js';
const closed={additionalProperties:false};
const Name=Type.String({minLength:1,maxLength:1024,description:'NFC/trim, até 120 caracteres normalizados.'});
const Version=Type.Integer({minimum:1,maximum:2147483646});
const NullableId=Type.Union([UuidSchema,Type.Null()]);
const Cost=Type.Union([CentsSchema,Type.Null()]);
const Unit=Type.Union(['unit','kg','g','liter','milliliter','box','pack'].map((value)=>Type.Literal(value)));
const Policy=Type.Union([Type.Literal('permissive'),Type.Literal('require_stock')]);
const categoryFields={name:Name,active:Type.Optional(Type.Boolean())};
const productFields={name:Name,internal_code:Type.String({minLength:1,maxLength:512}),unit:Unit,price_cents:CentsSchema,
  cost_cents:Type.Optional(Cost),category_id:Type.Optional(NullableId),barcodes:Type.Optional(Type.Array(BarcodeSchema,{maxItems:10,uniqueItems:true})),active:Type.Optional(Type.Boolean())};
const customerFields={name:Name,phone:Type.Optional(Type.Union([Type.String({minLength:1,maxLength:160}),Type.Null()])),email:Type.Optional(Type.Union([Type.String({minLength:1,maxLength:512}),Type.Null()])),active:Type.Optional(Type.Boolean())};
export const CategoryInput=Type.Object(categoryFields,closed);
export const ProductInput=Type.Object(productFields,closed);
export const CustomerInput=Type.Object(customerFields,closed);
const CategoryPatch=Type.Partial(CategoryInput);
const ProductPatch=Type.Partial(ProductInput);
const CustomerPatch=Type.Partial(CustomerInput);
export const CategoryUpdate=Type.Object({expected_version:Version,...CategoryPatch.properties},{...closed,minProperties:2});
export const ProductUpdate=Type.Object({expected_version:Version,...ProductPatch.properties},{...closed,minProperties:2});
export const CustomerUpdate=Type.Object({expected_version:Version,...CustomerPatch.properties},{...closed,minProperties:2});
export const SettingsPatch=Type.Object({stock_policy:Type.Optional(Policy),strict_scope:Type.Optional(Type.Literal('local_terminal')),images_enabled:Type.Optional(Type.Literal(false))},{...closed,minProperties:1});
export const SettingsUpdate=Type.Object({expected_version:Version,...SettingsPatch.properties},{...closed,minProperties:2});
export const IdParams=Type.Object({id:UuidSchema},closed);
export const IntentionHeaders=Type.Object({'idempotency-key':UuidSchema},{additionalProperties:true});
export const Category=Type.Object({id:UuidSchema,name:Type.String(),active:Type.Boolean(),version:Version},closed);
export const Product=Type.Object({id:UuidSchema,name:Type.String(),internal_code:Type.String(),unit:Unit,price_cents:CentsSchema,cost_cents:Type.Optional(Cost),category_id:NullableId,barcodes:Type.Array(BarcodeSchema,{maxItems:10}),active:Type.Boolean(),version:Version},closed);
export const Customer=Type.Object({id:UuidSchema,name:Type.String(),phone:Type.Union([Type.String(),Type.Null()]),email:Type.Union([Type.String(),Type.Null()]),active:Type.Boolean(),version:Version,confirmation_state:Type.Union([Type.Literal('confirmed'),Type.Literal('local_pending')])},closed);
export const StoreSettings=Type.Object({id:UuidSchema,version:Version,stock_policy:Policy,strict_scope:Type.Literal('local_terminal'),images_enabled:Type.Literal(false)},closed);
export const TerminalSettings=Type.Object({store_id:UuidSchema,device_id:UuidSchema,version:Version,automatic_printing:Type.Literal(false)},closed);
export const Settings=Type.Object({store:StoreSettings,terminal:Type.Optional(TerminalSettings),scope:Type.Union([Type.Literal('local_terminal'),Type.Literal('server_received')])},closed);
export const Entity=Type.Union([Product,Category,Customer]);
const EntityKind=Type.Union([Type.Literal('categories'),Type.Literal('products'),Type.Literal('customers')]);
export const Proposal=Type.Object({intention_id:UuidSchema,entity_type:Type.Union([EntityKind,Type.Literal('settings')]),entity_id:UuidSchema,base_version:Type.Integer({minimum:0}),status:Type.Union([Type.Literal('pending'),Type.Literal('conflict')]),base:Type.Union([Entity,StoreSettings,Type.Null()]),proposal:Type.Union([Entity,StoreSettings])},closed);
export const ListQuery=Type.Object({q:Type.Optional(Type.String({maxLength:120})),after:Type.Optional(DecimalCursorSchema),limit:Type.Optional(Type.String({pattern:'^([1-9][0-9]?|100)$'})),active:Type.Optional(Type.Union([Type.Literal('true'),Type.Literal('false')]))},closed);
export const BalanceQuery=Type.Object({...ListQuery.properties,product_id:Type.Optional(UuidSchema)},closed);
const NativeListQuery=Type.Object({q:Type.Optional(Type.String({maxLength:120})),after:Type.Optional(DecimalCursorSchema),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),active:Type.Optional(Type.Boolean())},closed);
const NativeBalanceQuery=Type.Object({...NativeListQuery.properties,product_id:Type.Optional(UuidSchema)},closed);
export const MovementQuery=Type.Object({product_id:Type.Optional(UuidSchema),from:Type.Optional(UtcInstantSchema),to:Type.Optional(UtcInstantSchema),after:Type.Optional(DecimalCursorSchema),limit:ListQuery.properties.limit},closed);
const NativeMovementQuery=Type.Object({...MovementQuery.properties,limit:NativeListQuery.properties.limit},closed);
const SignedQuantity=Type.Integer({minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER});
export const Balance=Type.Object({product_id:UuidSchema,quantity_milli:SignedQuantity,version:Type.Integer({minimum:0})},closed);
export const BalanceItem=Type.Object({...Balance.properties,name:Type.String(),active:Type.Boolean(),unit:Unit},closed);
export const Movement=Type.Object({id:UuidSchema,product_id:UuidSchema,device_id:UuidSchema,operator_id:UuidSchema,kind:Type.Union(['entry','opening','adjustment','sale','reversal'].map((value)=>Type.Literal(value))),origin_id:UuidSchema,item_id:UuidSchema,delta_milli:SignedQuantity,before_milli:SignedQuantity,after_milli:SignedQuantity,unit:Unit,unit_cost_cents:Type.Optional(Cost),reason:Type.String(),occurred_at:UtcInstantSchema},closed);
export const EntryInput=Type.Object({product_id:UuidSchema,quantity_milli:QuantityMilliSchema,unit_cost_cents:Cost,reason:Type.String({minLength:1,maxLength:2000}),kind:Type.Optional(Type.Union([Type.Literal('entry'),Type.Literal('opening')]))},closed);
export const CountInput=Type.Object({product_id:UuidSchema,counted_milli:CentsSchema,expected_quantity_milli:SignedQuantity,expected_version:Type.Integer({minimum:0}),reason:Type.String({minLength:1,maxLength:2000})},closed);
export const CountResult=Type.Object({movement:Type.Union([Movement,Type.Null()]),balance:Balance},closed);
const scopeFields={scope:Type.Union([Type.Literal('local_terminal'),Type.Literal('server_received')]),as_of:UtcInstantSchema};
export const page=(item:typeof Entity|typeof Movement|typeof BalanceItem)=>Type.Object({items:Type.Array(item,{maxItems:100}),next_cursor:Type.Union([DecimalCursorSchema,Type.Null()]),...scopeFields},closed);
export const CatalogPage=page(Entity),BalancesPage=page(BalanceItem),MovementsPage=page(Movement);
export const EntityResponse=successSchema(Entity),CatalogResponse=successSchema(Type.Object({items:Type.Array(Entity,{maxItems:100})},closed));
export const SettingsResponse=successSchema(Settings),BalancesResponse=successSchema(Type.Object({items:Type.Array(BalanceItem,{maxItems:100})},closed)),MovementsResponse=successSchema(Type.Object({items:Type.Array(Movement,{maxItems:100})},closed));
const command=<T extends string,F extends Record<string,TSchema>>(type:T,fields:F)=>Type.Object({type:Type.Literal(type),request_id:RequestIdSchema,...fields},closed);
const intention={intention_id:UuidSchema};
export const businessIpcCommands=Type.Union([
  cashCommands,
  salesCommands,
  command('catalog.search',{entity_type:EntityKind,query:NativeListQuery}),
  command('catalog.getPending',{entity_type:Type.Optional(Type.Union([EntityKind,Type.Literal('settings')]))}),
  command('products.proposeCreate',{...intention,input:ProductInput}),
  command('products.proposeUpdate',{...intention,id:UuidSchema,input:ProductUpdate}),
  command('categories.proposeUpdate',{...intention,id:UuidSchema,input:CategoryUpdate}),
  command('customers.createMinimal',{...intention,id:UuidSchema,input:CustomerInput}),
  command('customers.proposeUpdate',{...intention,id:UuidSchema,input:CustomerUpdate}),
  command('settings.get',{}),command('settings.change',{...intention,input:SettingsUpdate}),
  command('settings.changeTerminal',{...intention,expected_version:Version,automatic_printing:Type.Literal(false)}),
  command('stock.getBalances',{query:NativeBalanceQuery}),command('stock.getMovements',{query:NativeMovementQuery}),
  command('stock.registerEntry',{...intention,input:EntryInput}),command('stock.adjustCount',{...intention,input:CountInput}),
  command('stock.rebuildProjection',{...intention,product_id:UuidSchema}),
]);
export type BusinessIpcCommand=Static<typeof businessIpcCommands>;
export type HttpListQuery=Static<typeof ListQuery>;
export type HttpBalanceQuery=Static<typeof BalanceQuery>;
export type HttpMovementQuery=Static<typeof MovementQuery>;
export type ProductInputDto=Static<typeof ProductInput>;
export type CategoryInputDto=Static<typeof CategoryInput>;
export type CustomerInputDto=Static<typeof CustomerInput>;
export type ProductUpdateDto=Static<typeof ProductUpdate>;
export type CategoryUpdateDto=Static<typeof CategoryUpdate>;
export type CustomerUpdateDto=Static<typeof CustomerUpdate>;
export type SettingsUpdateDto=Static<typeof SettingsUpdate>;
export type CatalogListQuery=Static<typeof NativeListQuery>;
export type StockMovementQuery=Static<typeof NativeMovementQuery>;
const IpcSettings=Type.Object({store:StoreSettings,terminal:Type.Optional(TerminalSettings)},closed);
export const BusinessIpcResponse=Type.Object({type:Type.Literal('business.result'),data:Type.Union([
  CashResult,CashAdjustmentResult,CashPage,CashMovements,
  DraftResult,CompletionResult,
  Type.Object({items:Type.Array(Entity,{maxItems:100})},closed),Type.Object({items:Type.Array(BalanceItem,{maxItems:100})},closed),Type.Object({items:Type.Array(Movement,{maxItems:100})},closed),Proposal,IpcSettings,TerminalSettings,
  Type.Object({items:Type.Array(Proposal,{maxItems:100})},closed),
  Type.Object({movement:Movement,balance:Balance},closed),CountResult,Balance]),meta:MetaSchema},closed);
export function businessEnvelope(data:unknown,requestId:string){
  if(data&&typeof data==='object'){
    const {scope,as_of,next_cursor,...value}=data as Record<string,unknown>;
    return {type:'business.result',data:value,meta:{request_id:requestId,...(scope===undefined?{}:{scope}),...(as_of===undefined?{}:{as_of}),...(next_cursor===undefined?{}:{next_cursor})}};
  }return {type:'business.result',data,meta:{request_id:requestId}};
}

const exampleId='550e8400-e29b-41d4-a716-446655440000';
Object.assign(ProductInput,{example:{name:'Café de exemplo',internal_code:'CAFE-01',unit:'unit',price_cents:1500,cost_cents:null,barcodes:['00123']}});
Object.assign(CategoryInput,{example:{name:'Mercearia'}});Object.assign(CustomerInput,{example:{name:'Cliente de exemplo'}});
Object.assign(ProductUpdate,{example:{expected_version:1,price_cents:1700}});
Object.assign(CategoryUpdate,{example:{expected_version:1,name:'Nome revisado'}});Object.assign(CustomerUpdate,{example:{expected_version:1,active:false}});
Object.assign(SettingsUpdate,{example:{expected_version:1,stock_policy:'require_stock',strict_scope:'local_terminal'}});
Object.assign(EntryInput,{example:{product_id:exampleId,quantity_milli:1000,unit_cost_cents:null,reason:'Recebimento'}});
const productExample={id:exampleId,name:'Café de exemplo',internal_code:'CAFE-01',unit:'unit',price_cents:1500,cost_cents:null,category_id:null,barcodes:['00123'],active:true,version:1};
const storeExample={id:exampleId,version:1,stock_policy:'permissive',strict_scope:'local_terminal',images_enabled:false};
const envelope=(data:unknown,extra={})=>({data,meta:{request_id:'example-request',...extra}});
Object.assign(Product,{example:productExample});Object.assign(Category,{example:{id:exampleId,name:'Mercearia',active:true,version:1}});
Object.assign(Customer,{example:{id:exampleId,name:'Cliente de exemplo',phone:null,email:null,active:true,version:1,confirmation_state:'confirmed'}});
Object.assign(StoreSettings,{example:storeExample});
Object.assign(CatalogResponse,{example:envelope({items:[productExample]},{next_cursor:null,scope:'server_received',as_of:'2026-11-25T12:00:00.000Z'})});
Object.assign(SettingsResponse,{example:envelope({store:storeExample,scope:'server_received'})});
Object.assign(BalancesResponse,{example:envelope({items:[{product_id:exampleId,name:'Café de exemplo',active:true,unit:'unit',quantity_milli:1000,version:1}]},{next_cursor:null,scope:'server_received',as_of:'2026-11-25T12:00:00.000Z'})});
Object.assign(MovementsResponse,{example:envelope({items:[{id:exampleId,product_id:exampleId,device_id:exampleId,operator_id:exampleId,kind:'entry',origin_id:exampleId,item_id:exampleId,delta_milli:1000,before_milli:0,after_milli:1000,unit:'unit',unit_cost_cents:null,reason:'Recebimento de exemplo',occurred_at:'2026-11-25T12:00:00.000Z'}]},{next_cursor:null,scope:'server_received',as_of:'2026-11-25T12:00:00.000Z'})});
