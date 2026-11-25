import type { RowDataPacket } from 'mysql2/promise';
import type { MysqlStore } from './store.js';
import type { SyncDependencies, SyncTransaction } from '../../../application/src/sync-ports.js';
import { businessRepository, type BusinessSql } from '../../persistence/src/business-repository.js';
import { syncRepository } from '../../persistence/src/sync-repository.js';
export function mysqlSyncUnitOfWork(store:MysqlStore):SyncDependencies['unitOfWork'] {
  return store.unitOfWork<SyncTransaction>((connection,core,active)=>{
    const sql:BusinessSql={active,forUpdate:' FOR UPDATE',all:async(query,values=[])=>{active();const [rows]=await connection.query<RowDataPacket[]>(query.endsWith(' FOR UPDATE')?query:`${query} FOR UPDATE`,values);return rows;},run:async(query,values=[])=>{active();await connection.query(query,values);}};
    return {...core,business:businessRepository(sql,store.identity.store_id),sync:syncRepository(sql,store.identity.store_id)};
  });
}
