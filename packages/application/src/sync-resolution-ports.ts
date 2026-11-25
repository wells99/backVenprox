import type { SyncDependencies,SyncTransaction,SyncReceipt } from './sync-ports.js';
import type { UnitOfWork } from './ports.js';
export type ResolutionAction='confirm_original'|'retry_original'|'accept_proposal'|'reject_proposal'|'reapply_proposal';
export interface ResolutionCommand {operation_id:string;expected_version:number;action:ResolutionAction;reason:string;expected_entity_version?:number;patch?:Record<string,unknown>}
export interface ResolutionResult {id:string;operation_id:string;device_id:string;action:ResolutionAction;version:2;receipt:SyncReceipt;outcome:'accepted'|'rejected'|'confirmed';created_at:string}
export interface ResolutionRecord {id:string;store_id:string;operation_id:string;actor_id:string;command_hash:string;action:ResolutionAction;reason:string;original_receipt_json:string;result_json:string;created_at:string}
export interface ResolutionRepository {byId(id:string):Promise<ResolutionRecord|undefined>;byOperation(id:string):Promise<ResolutionRecord|undefined>;deviceCode(id:string):Promise<string|undefined>;insert(value:ResolutionRecord):Promise<void>}
export interface ResolutionTransaction extends SyncTransaction {resolutions:ResolutionRepository}
export interface ResolutionDependencies extends Omit<SyncDependencies,'unitOfWork'> {unitOfWork:UnitOfWork<ResolutionTransaction>}
