import type { AuthorizedContext } from '../../domain/src/authorization.js';
import { ApplicationError } from './application-error.js';
export class BackupStatusService {
 constructor(readonly storeId:string,readonly query:()=>Promise<{id:string;created_at:string;status:string;verified:boolean}|null>,readonly now:()=>string){}
 async status(c:AuthorizedContext){if(c.store_id!==this.storeId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');if(c.expires_at<=this.now()||c.authorized_at>this.now())throw new ApplicationError('AUTHENTICATION_REQUIRED','Renove a autenticação.','unauthenticated');if(!c.permissions.includes('recovery.manage')||!c.permissions.includes('users.manage'))throw new ApplicationError('PERMISSION_DENIED','Permissão administrativa necessária.','forbidden');return {scope:'server_received' as const,as_of:this.now(),last_backup:await this.query(),recommended_interval_hours:24 as const,external_copy_state:'unknown' as const};}
}
