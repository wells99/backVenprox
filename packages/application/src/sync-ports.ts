import type { BusinessTransaction } from './business-ports.js';
import type { AuthorizedContext } from '../../domain/src/authorization.js';
import type { Clock, IdGenerator, UnitOfWork } from './ports.js';
export interface SyncEnvelope {protocol_version:number;payload_version:number;store_id:string;device_id:string;operation_id:string;device_seq:string;type:string;occurred_at_device:string;origin_authorization:{context:AuthorizedContext;signature:string|null};dependencies:string[];payload:unknown;payload_hash:string}
export type ReceiptStatus='applied'|'duplicate'|'conflict'|'blocked'|'quarantined';
export interface SyncReceipt {operation_id:string;device_id:string;device_seq:string;payload_hash:string;status:ReceiptStatus;code:string;result:{entity_id:string|null;received_at:string;reconciliation:'not_applicable'|'reconciled'}|null}
export interface SyncInbox {operation_id:string;store_id:string;device_id:string;device_seq:string;payload_hash:string;envelope_hash:string;envelope_json:string;receipt_json:string;state:'processing'|'applied'|'conflict'|'blocked'|'quarantined';received_at:string}
export interface SyncDevice {id:string;code:string;active:boolean}
export interface OriginEvidence {user_version:number|null;permissions:string[];session_user_id:string|null;session_expires:string|null;session_revoked_at:string|null;authorizations:{occurred_at:string;permissions_version:number}[];grant:{user_id:string;device_id:string;permissions_version:number;issued_at:string;expires_at:string;revoked_at:string|null}|null}
export interface SyncRepository {
  device(credentialHash:string):Promise<SyncDevice|undefined>;frontier(deviceId:string):Promise<string>;advance(deviceId:string,sequence:string):Promise<void>;
  inbox(id:string):Promise<SyncInbox|undefined>;inboxSequence(deviceId:string,sequence:string):Promise<SyncInbox|undefined>;insertInbox(value:SyncInbox):Promise<void>;finishInbox(id:string,status:SyncInbox['state'],receipt:string):Promise<void>;
  incident(id:string,envelope:SyncEnvelope,receipt:SyncReceipt):Promise<void>;originEvidence(context:AuthorizedContext):Promise<OriginEvidence>;
  savepoint():Promise<void>;rollbackEffects():Promise<void>;entityExists(table:'sales'|'sale_items'|'sale_payments'|'cash_sessions'|'cash_movements'|'stock_movements'|'cash_closures'|'sale_reversals'|'reversal_items'|'refund_payments',id:string):Promise<boolean>;
  stagePublication(envelope:SyncEnvelope,result:SyncReceipt['result']):Promise<void>;recordProposal(envelope:SyncEnvelope):Promise<void>;
  setReceivedSessionFrontier(sessionId:string,sequence:string):Promise<void>;receivedSessionFrontier(sessionId:string):Promise<string>;reconcile(closureId:string,deviceId:string,sequence:string):Promise<void>;
}
export interface SyncTransaction extends BusinessTransaction {sync:SyncRepository}
export interface SyncPublicationPort {publish(tx:SyncTransaction,envelope:SyncEnvelope,result:SyncReceipt['result']):Promise<void>}
export interface SyncDependencies {unitOfWork:UnitOfWork<SyncTransaction>;storeId:string;clock:Clock;ids:IdGenerator;digest:(value:string)=>string;hashEnvelope:(envelope:SyncEnvelope)=>string;hashValue:(value:unknown)=>string;validatePayload:(type:string,version:number,value:unknown)=>boolean;verifyOriginSignature:(signature:string)=>AuthorizedContext;publication:SyncPublicationPort;writesEnabled:boolean}
export class SyncRejection extends Error {constructor(readonly status:'conflict'|'blocked'|'quarantined',readonly code:string){super(code);}}
