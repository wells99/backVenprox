import type { PairedDevice } from './local-auth.js';
import type { LocalSyncDependencies,LocalSyncTransaction } from './local-sync-ports.js';
import type { PublishedChange,SnapshotManifest,SnapshotPage } from './publication-ports.js';
import type { SyncEnvelope,SyncReceipt } from './sync-ports.js';
import type { UnitOfWork } from './ports.js';
import type { TerminalReport } from './read-ports.js';
export interface ChangesPage {items:PublishedChange[];next_cursor:string;retention_floor:string;has_more:boolean;protocol_version:1;event_version:1|2}
export interface SyncRuntime {initialized:boolean;cursor:string;local_seq:string;baseline_seq:string;state:string;last_code:string|null;enabled:boolean}
export interface SyncReplica {
  runtime():Promise<SyncRuntime>;state(value:string,code:string|null,at:string,enabled:boolean):Promise<void>;
  apply(page:ChangesPage):Promise<void>;
  staged():Promise<SnapshotManifest|undefined>;stage(manifest:SnapshotManifest):Promise<void>;stagedPages(id:string):Promise<number[]>;stagePage(id:string,page:SnapshotPage):Promise<void>;install(id:string):Promise<void>;
}
export interface CoordinatorTransaction extends LocalSyncTransaction {replica:SyncReplica}
export interface SyncGateway {
  report?(device:PairedDevice,value:TerminalReport):Promise<void>;
  compatible(device:PairedDevice):Promise<{received_seq:string;store_id:string;device_id:string;sync_enabled:boolean}>;
  changes(device:PairedDevice,after:string):Promise<ChangesPage>;push(device:PairedDevice,value:SyncEnvelope):Promise<SyncReceipt>;receipt(device:PairedDevice,id:string):Promise<SyncReceipt>;
  snapshot(device:PairedDevice):Promise<SnapshotManifest>;manifest(device:PairedDevice,id:string):Promise<SnapshotManifest>;page(device:PairedDevice,id:string,page:number):Promise<SnapshotPage>;
}
export interface SyncCoordinatorDependencies extends Omit<LocalSyncDependencies,'unitOfWork'> {unitOfWork:UnitOfWork<CoordinatorTransaction>;gateway:SyncGateway;device:()=>Promise<PairedDevice|undefined>;proof:(authorizationId:string)=>Promise<string|undefined>;maxOperations?:number;maxPages?:number}
