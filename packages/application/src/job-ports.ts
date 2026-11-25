import type { Audit, Clock, IdGenerator, UnitOfWork } from './ports.js';
import { ApplicationError } from './application-error.js';
export interface Job {id:string;store_id:string;type:'catalog.export.v1';payload_version:1;payload_json:string;deduplication_key:string;partition_key:string;actor_id:string;command_hash:string;status:'queued'|'running'|'retry_wait'|'succeeded'|'failed_review';created_at:string;available_at:number;attempts:number;lease_owner:string|null;lease_until:number;lease_token:string;version:number;last_code:string|null}
export interface JobLease {id:string;owner:string;token:string}
export interface CatalogExport {schema_version:1;items:Record<string,unknown>[];checksum:string;created_at:string}
export interface JobRetry {operation_id:string;store_id:string;job_id:string;actor_id:string;command_hash:string;result_json:string;reason:string}
export interface JobRepository {
  enqueue(value:Job):Promise<Job>;get(id:string):Promise<Job|undefined>;
  claim(owner:string,leaseMs:number):Promise<Job|undefined>;renew(lease:JobLease,leaseMs:number):Promise<boolean>;
  effect(lease:JobLease):Promise<CatalogExport|undefined>;commitEffect(lease:JobLease,result:CatalogExport):Promise<void>;
  finish(lease:JobLease):Promise<void>;fail(lease:JobLease,code:string,retryDelayMs:number|null):Promise<void>;
  retry(value:JobRetry,expectedVersion:number):Promise<Job>;retryRecord(id:string):Promise<JobRetry|undefined>;
  metrics():Promise<{queued:number;running:number;failed_review:number;succeeded:number;expired_leases:number;oldest_wait_ms:number}>;
}
export interface JobTransaction {jobs:JobRepository;audit:Audit}
export interface JobDependencies {unitOfWork:UnitOfWork<JobTransaction>;storeId:string;clock:Clock;ids:IdGenerator;hash:(value:unknown)=>string}
export interface CatalogExportSource {read(includeCosts:boolean,signal:AbortSignal):Promise<Record<string,unknown>[]>}
export class JobLeaseLost extends ApplicationError {constructor(){super('JOB_LEASE_LOST','Reserva da tarefa expirada ou reatribuída.','conflict');}}
