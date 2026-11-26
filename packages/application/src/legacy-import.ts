import type { BusinessContext,ProductInput,CustomerInput } from './business-ports.js';
import { ApplicationError } from './application-error.js';
export type LegacyRow={source_record_id:string;kind:'product';data:ProductInput}|{source_record_id:string;kind:'customer';data:CustomerInput}|{source_record_id:string;kind:'category';data:{name:string;active?:boolean}}|{source_record_id:string;kind:'opening_stock';data:{product_id:string;quantity_milli:number;unit_cost_cents:number|null}};
export interface LegacyFile {format:1;batch_id:string;source:string;rows:LegacyRow[]}
export interface ImportResult {batch_id:string;input_hash:string;applied:number;rejected:number;items:{row:number;id?:string;code:string}[]}
export interface LegacyPort {
 hash(file:LegacyFile):string;id(key:string):string;
 begin(id:string,hash:string,actor:string):Promise<ImportResult|undefined>;finish(id:string,result:ImportResult):Promise<void>;
 apply(context:BusinessContext,row:LegacyRow,intention:string,entityId:string):Promise<string>;
}
export class LegacyImportService {
 constructor(readonly port:LegacyPort,readonly storeId:string,readonly now:()=>string){}
 async apply(context:BusinessContext,file:LegacyFile,confirmedHash:string){
  if(context.store_id!==this.storeId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');
  if(context.expires_at<=this.now()||context.authorized_at>this.now())throw new ApplicationError('AUTHENTICATION_REQUIRED','Renove a autenticação.','unauthenticated');
  if(!['recovery.manage','users.manage','catalog.write'].every(p=>context.permissions.some(permission=>permission===p)))throw new ApplicationError('PERMISSION_DENIED','Importação exige administrador.','forbidden');
  const hash=this.port.hash(file);if(hash!==confirmedHash)throw new ApplicationError('IMPORT_CONFIRMATION_MISMATCH','Confirme o hash da simulação revisada.','conflict');
  const previous=await this.port.begin(file.batch_id,hash,context.user_id);if(previous)return previous;
  const result:ImportResult={batch_id:file.batch_id,input_hash:hash,applied:0,rejected:0,items:[]};
  // Resume uses the same intention per source/record, including across batches.
  for(let i=0;i<file.rows.length;i++){const row=file.rows[i]!,key=JSON.stringify([this.storeId,file.source,row.kind,row.source_record_id]);
   try{const id=await this.port.apply(context,row,this.port.id('intention:'+key),this.port.id('entity:'+key));result.items.push({row:i+1,id,code:'APPLIED_OR_REPLAYED'});result.applied++;}
   catch(error){result.items.push({row:i+1,code:error instanceof ApplicationError?error.code:'IMPORT_ROW_UNAVAILABLE'});result.rejected++;}
  }
  await this.port.finish(file.batch_id,result);return result;
 }
}
