import { Type, type Static } from 'typebox';
import { UuidSchema, RequestIdSchema, MetaSchema, UtcInstantSchema } from './common.js';
import { ResolutionBody, ResolutionResult } from './sync-resolutions.js';
const closed={additionalProperties:false},decimal=Type.String({pattern:'^(0|[1-9][0-9]{0,18})$'}),instant=Type.Union([UtcInstantSchema,Type.Null()]);
const command=<T extends string>(type:T)=>Type.Object({type:Type.Literal(type),request_id:RequestIdSchema},closed);
export const localSyncCommands=Type.Union([command('sync.getStatus'),command('sync.requestRetry'),command('sync.listConflicts'),Type.Object({type:Type.Literal('sync.submitResolution'),request_id:RequestIdSchema,intention_id:UuidSchema,...ResolutionBody.properties},closed)]);
export type LocalSyncCommand=Static<typeof localSyncCommands>;
export const LocalSyncStatus=Type.Object({scope:Type.Literal('local_terminal'),download_cursor:decimal,pending:Type.Integer({minimum:0}),in_flight:Type.Integer({minimum:0}),acknowledged:Type.Integer({minimum:0}),conflicts:Type.Integer({minimum:0}),oldest_pending_at:instant,last_contact_at:instant,last_receipt_at:instant,retry_requested_at:instant,automatic_sync_enabled:Type.Boolean(),phase:Type.String({minLength:1,maxLength:64}),last_code:Type.Optional(Type.Union([Type.String(),Type.Null()]))},closed);
export const LocalSyncResponse=Type.Object({type:Type.Literal('sync.result'),data:Type.Union([ResolutionResult,LocalSyncStatus,Type.Object({scheduled:Type.Literal(true),automatic_sync_enabled:Type.Boolean()},closed),Type.Object({items:Type.Array(Type.Object({operation_id:UuidSchema,device_seq:decimal,event_type:Type.String(),state:Type.Union([Type.Literal('conflict'),Type.Literal('blocked')]),code:Type.String()},closed),{maxItems:100})},closed)]),meta:MetaSchema},closed);
