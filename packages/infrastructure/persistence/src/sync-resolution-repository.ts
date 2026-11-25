import type { ResolutionRepository,ResolutionRecord } from '../../../application/src/sync-resolution-ports.js';
import type { BusinessSql } from './business-repository.js';
export function resolutionRepository(sql:BusinessSql,storeId:string):ResolutionRepository{
  const find=async(field:'id'|'operation_id',id:string)=>(await sql.all(`SELECT * FROM server_sync_resolutions WHERE store_id=? AND ${field}=?`,[storeId,id]))[0] as unknown as ResolutionRecord|undefined;
  return {
    byId:(id)=>find('id',id),byOperation:(id)=>find('operation_id',id),
    deviceCode:async(id)=>{const row=(await sql.all('SELECT code FROM auth_devices WHERE store_id=? AND id=?',[storeId,id]))[0];return row?String(row.code):undefined;},
    insert:async(value)=>{if(value.store_id!==storeId)throw new Error('RESOLUTION_SCOPE_MISMATCH');const fields=Object.keys(value);await sql.run(`INSERT INTO server_sync_resolutions(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,Object.values(value));},
  };
}
