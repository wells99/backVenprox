import type { RowDataPacket } from 'mysql2/promise';
import type { MysqlStore } from './store.js';
import { businessRepository } from '../../persistence/src/business-repository.js';
import { readRepository } from '../../persistence/src/read-repository.js';
import type { ReadDependencies } from '../../../application/src/read-ports.js';
export function mysqlReadUnitOfWork(store:MysqlStore):ReadDependencies['unitOfWork']{return store.unitOfWork((connection,_core,active)=>{const sql={active,forUpdate:'',all:async(query:string,values:unknown[]=[])=>{active();const [rows]=await connection.query<RowDataPacket[]>({sql:query,timeout:5000},values);return rows;},run:async(query:string,values:unknown[]=[])=>{active();await connection.query(query,values);}};return {business:businessRepository(sql,store.identity.store_id),read:readRepository(sql,store.identity.store_id)};});}
