import type { UnitOfWork, Clock, IdGenerator } from './ports.js';
import type { AuthorizedContext } from '../../domain/src/authorization.js';
import type { SyncTransaction } from './sync-ports.js';

export interface ChangeProjection {stock_deltas:{id:string;product_id:string;delta_milli:number}[];proposal_outcome?:{operation_id:string;resolution_id:string;outcome:'accepted'|'rejected'}}
export interface Publication {operation_id:string;type:string;source:'web'|'device'|'identity';origin?:{device_id:string;device_seq:string}|null;payload:unknown;published_at:string;projection?:ChangeProjection}
export interface PublishedChange extends Publication {cursor:string;event_version:1|2;required:boolean}
export type SnapshotKind='initial'|'operational';
export interface SnapshotRecord {table:string;value:Record<string,unknown>}
export interface SnapshotPage {page:number;checksum:string;records:SnapshotRecord[]}
export interface SnapshotManifest {
  id:string;store_id:string;device_id:string;kind:SnapshotKind;state:'ready'|'expired';cut_cursor:string;
  created_at:string;expires_at:string;schema_version:11|14;protocol_version:1;event_version:1|2;device_received_seq?:string;
  modules:Record<string,number>;counts:Record<string,number>;pages:{page:number;checksum:string;records:number}[];
  checksum:string;bytes:number;capture_ms:number;
}
export interface PublicationRepository {
  lock():Promise<void>;publish(value:Publication):Promise<void>;
  state():Promise<{cursor:string;floor:string}>;changes(after:string,limit:number):Promise<PublishedChange[]>;
  capture(kind:SnapshotKind):Promise<{records:SnapshotRecord[];counts:Record<string,number>;capture_ms:number}>;
  saveSnapshot(manifest:SnapshotManifest,pages:SnapshotPage[]):Promise<void>;
  manifest(id:string,deviceId:string):Promise<SnapshotManifest|undefined>;page(id:string,page:number):Promise<SnapshotPage|undefined>;
}
export interface DownloadTransaction extends SyncTransaction {publication:PublicationRepository}
export interface DownloadDependencies {unitOfWork:UnitOfWork<DownloadTransaction>;storeId:string;clock:Clock;ids:IdGenerator;digest:(value:string)=>string;hash:(value:unknown)=>string;bytes:(value:unknown)=>number}
export type RecoveryContext=AuthorizedContext|undefined;
