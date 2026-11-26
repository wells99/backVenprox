import type { AuthorizedContext } from '../../domain/src/authorization.js';
import { ApplicationError } from './application-error.js';
export interface RecoverySummary {
 store_id:string;device_id:string;schema_version:number;local_seq:string;max_operation_seq:string;pending:number;acknowledged:number;
 counts:Record<string,number>;totals:Record<string,string>;fingerprint:string;sequence_valid:boolean;
}
export interface RecoveryReport {copy_id:string;created_at:string;status:'prepared'|'validated';summary:RecoverySummary;encrypted:true;promotion:'manual_reconciliation_required'}
export interface RecoveryPort {
 inspect():Promise<RecoverySummary>;
 prepare():Promise<RecoveryReport>;
 validate(id:string):Promise<RecoveryReport>;
 report(id:string):Promise<RecoveryReport>;
 audit(context:AuthorizedContext,action:string,copyId?:string):Promise<void>;
}
export class RecoveryService {
 constructor(readonly port:RecoveryPort,readonly storeId:string,readonly deviceId:string,readonly now:()=>string){}
 private authorize(c:AuthorizedContext){if(c.store_id!==this.storeId||c.device_id!==this.deviceId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');if(c.expires_at<=this.now()||c.authorized_at>this.now())throw new ApplicationError('AUTHENTICATION_REQUIRED','Renove a autenticação.','unauthenticated');if(!c.permissions.includes('recovery.manage')||!c.permissions.includes('users.manage'))throw new ApplicationError('PERMISSION_DENIED','Permissão administrativa necessária.','forbidden');}
 async inspect(c:AuthorizedContext){this.authorize(c);return this.port.inspect();}
 async prepareCopy(c:AuthorizedContext){this.authorize(c);await this.port.audit(c,'recovery.copy_requested');const report=await this.port.prepare();await this.port.audit(c,'recovery.copy_prepared',report.copy_id);return report;}
 async validateCopy(c:AuthorizedContext,id:string){this.authorize(c);const report=await this.port.validate(id);await this.port.audit(c,'recovery.copy_validated',id);return report;}
 async getReport(c:AuthorizedContext,id:string){this.authorize(c);return this.port.report(id);}
}
