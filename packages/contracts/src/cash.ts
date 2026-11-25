import { Type, type Static } from 'typebox';
import { BusinessDateSchema, CentsSchema, DecimalCursorSchema, RequestIdSchema, UtcInstantSchema, UuidSchema, successSchema } from './common.js';
const closed={additionalProperties:false};
const signed=Type.Integer({minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER});
export const CashSession=Type.Object({id:UuidSchema,device_id:UuidSchema,operator_id:UuidSchema,opened_at:UtcInstantSchema,business_date:BusinessDateSchema,time_zone:Type.String(),opening_cents:CentsSchema,status:Type.Union([Type.Literal('open'),Type.Literal('closed')]),version:Type.Integer({minimum:1}),expected_by_method:Type.Object({cash:signed,credit:signed,debit:signed,pix:signed},closed),pending_sync:Type.Boolean()},closed);
export const CashMovement=Type.Object({id:UuidSchema,session_id:UuidSchema,device_id:UuidSchema,operator_id:UuidSchema,operation_id:UuidSchema,origin_id:UuidSchema,component_id:UuidSchema,kind:Type.Union(['opening','supply','withdrawal','sale','refund','credit_receipt'].map((v)=>Type.Literal(v))),method:Type.Union(['cash','credit','debit','pix'].map((v)=>Type.Literal(v))),amount_cents:signed,reason:Type.String(),occurred_at:UtcInstantSchema},closed);
export const CashListQuery=Type.Object({device_id:Type.Optional(UuidSchema),after:Type.Optional(DecimalCursorSchema),limit:Type.Optional(Type.String({pattern:'^([1-9][0-9]?|100)$'}))},closed);
export const CashMovementQuery=Type.Object({after:CashListQuery.properties.after,limit:CashListQuery.properties.limit,origin_id:Type.Optional(UuidSchema)},closed);
const nativePage={after:CashListQuery.properties.after,limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))};
const open=Type.Object({opening_cents:CentsSchema,business_date:BusinessDateSchema,time_zone:Type.String({minLength:1,maxLength:100})},closed);
const adjustment=Type.Object({session_id:UuidSchema,amount_cents:Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}),reason:Type.String({minLength:1,maxLength:2000})},closed);
export const cashCommands=Type.Union([
  Type.Object({type:Type.Literal('cash.getCurrent'),request_id:RequestIdSchema},closed),
  Type.Object({type:Type.Literal('cash.listSessions'),request_id:RequestIdSchema,query:Type.Object(nativePage,closed)},closed),
  Type.Object({type:Type.Literal('cash.getSession'),request_id:RequestIdSchema,id:UuidSchema},closed),
  Type.Object({type:Type.Literal('cash.getMovements'),request_id:RequestIdSchema,id:UuidSchema,query:Type.Object({...nativePage,origin_id:Type.Optional(UuidSchema)},closed)},closed),
  Type.Object({type:Type.Literal('cash.open'),request_id:RequestIdSchema,intention_id:UuidSchema,input:open},closed),
  Type.Object({type:Type.Literal('cash.registerSupply'),request_id:RequestIdSchema,intention_id:UuidSchema,input:adjustment},closed),
  Type.Object({type:Type.Literal('cash.registerWithdrawal'),request_id:RequestIdSchema,intention_id:UuidSchema,input:adjustment},closed),
]);
export const CashResult=Type.Object({session:Type.Union([CashSession,Type.Null()])},closed);
export const CashAdjustmentResult=Type.Object({session:CashSession,movement:CashMovement},closed);
export const CashPage=Type.Object({items:Type.Array(CashSession,{maxItems:100})},closed);
export const CashMovements=Type.Object({items:Type.Array(CashMovement,{maxItems:100})},closed);
const id='550e8400-e29b-41d4-a716-446655440000';
const session={id,device_id:id,operator_id:id,opened_at:'2026-11-25T12:00:00.000Z',business_date:'2026-11-25',time_zone:'America/Sao_Paulo',opening_cents:0,status:'open',version:1,expected_by_method:{cash:0,credit:0,debit:0,pix:0},pending_sync:false};
Object.assign(CashResult,{example:{session}});Object.assign(CashPage,{example:{items:[session]}});Object.assign(CashMovements,{example:{items:[]}});
export const CashResponse=successSchema(CashResult),CashPageResponse=successSchema(CashPage),CashMovementsResponse=successSchema(CashMovements);
export type CashHttpQuery=Static<typeof CashListQuery>;
export type CashHttpMovementQuery=Static<typeof CashMovementQuery>;
