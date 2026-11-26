import { Type,type Static } from 'typebox';
import { UuidSchema,RequestIdSchema,MetaSchema,UtcInstantSchema,DecimalCursorSchema,successSchema } from './common.js';
const closed={additionalProperties:false},count=Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER});
export const RecoverySummary=Type.Object({store_id:UuidSchema,device_id:UuidSchema,schema_version:count,local_seq:DecimalCursorSchema,max_operation_seq:DecimalCursorSchema,pending:count,acknowledged:count,counts:Type.Record(Type.String({pattern:'^[a-z_]+$'}),count),totals:Type.Record(Type.String({pattern:'^[a-z_]+$'}),Type.String({pattern:'^-?[0-9]+$'})),fingerprint:Type.String({pattern:'^[a-f0-9]{64}$'}),sequence_valid:Type.Boolean()},closed);
export const RecoveryReport=Type.Object({copy_id:UuidSchema,created_at:UtcInstantSchema,status:Type.Union([Type.Literal('prepared'),Type.Literal('validated')]),summary:RecoverySummary,encrypted:Type.Literal(true),promotion:Type.Literal('manual_reconciliation_required')},closed);
export const recoveryCommands=Type.Union([
 Type.Object({type:Type.Literal('recovery.inspect'),request_id:RequestIdSchema},closed),
 Type.Object({type:Type.Literal('recovery.prepareCopy'),request_id:RequestIdSchema},closed),
 Type.Object({type:Type.Literal('recovery.validateCopy'),request_id:RequestIdSchema,copy_id:UuidSchema},closed),
 Type.Object({type:Type.Literal('recovery.getReport'),request_id:RequestIdSchema,copy_id:UuidSchema},closed),
]);
export type RecoveryCommand=Static<typeof recoveryCommands>;
export const RecoveryResponse=Type.Object({type:Type.Literal('recovery.result'),data:Type.Union([RecoverySummary,RecoveryReport]),meta:MetaSchema},closed);
export const BackupStatusResponse=successSchema(Type.Object({scope:Type.Literal('server_received'),as_of:UtcInstantSchema,last_backup:Type.Union([Type.Object({id:UuidSchema,created_at:UtcInstantSchema,status:Type.String(),verified:Type.Boolean()},closed),Type.Null()]),recommended_interval_hours:Type.Literal(24),external_copy_state:Type.Literal('unknown')},closed));
