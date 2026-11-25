import type { UnitOfWork, Clock, IdGenerator, Audit } from './ports.js';
import type { AuthorizedContext } from '../../domain/src/authorization.js';
import type { SyncEnvelope, SyncReceipt } from './sync-ports.js';
export type DeliveryState='pending'|'sending'|'acknowledged'|'retry_wait'|'conflict'|'blocked';
export interface LocalSyncSource {operation_id:string;store_id:string;device_id:string;device_seq:string;event_type:string;occurred_at:string;payload:string;authorization_context:string|null}
export interface LocalDelivery {operation_id:string;store_id:string;device_id:string;device_seq:string;event_type:string;envelope_json:string|null;payload_hash:string|null;state:DeliveryState;attempts:number;next_attempt_at:string|null;last_code:string|null;receipt_json:string|null}
export interface LocalSyncStatus {scope:'local_terminal';download_cursor:string;pending:number;in_flight:number;acknowledged:number;conflicts:number;oldest_pending_at:string|null;last_contact_at:string|null;last_receipt_at:string|null;retry_requested_at:string|null;automatic_sync_enabled:boolean;phase:string;last_code?:string|null}
export interface LocalSyncRepository {
  initialize():Promise<void>;recoverSending(at:string):Promise<void>;
  sourceNext():Promise<LocalSyncSource|undefined>;delivery(id:string):Promise<LocalDelivery|undefined>;save(value:LocalDelivery):Promise<void>;
  acknowledge(id:string,at:string):Promise<void>;contact(at:string,receipt?:boolean):Promise<void>;requestRetry(at:string):Promise<void>;status():Promise<LocalSyncStatus>;
  conflicts():Promise<{operation_id:string;device_seq:string;event_type:string;state:'conflict'|'blocked';code:string}[]>;
}
export interface LocalSyncTransaction {sync:LocalSyncRepository;audit:Audit}
export interface LocalSyncDependencies {unitOfWork:UnitOfWork<LocalSyncTransaction>;storeId:string;deviceId:string;clock:Clock;ids:IdGenerator;
  hashEnvelope:(value:SyncEnvelope)=>string;validateEnvelope:(value:unknown)=>boolean;validateReceipt:(value:unknown)=>boolean;random:()=>number}
export type LocalSyncContext=AuthorizedContext;
export type LocalSyncReceipt=SyncReceipt;
