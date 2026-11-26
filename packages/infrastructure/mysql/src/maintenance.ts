import type { RowDataPacket } from 'mysql2/promise';
import type { MysqlStore } from './store.js';
import { maintenanceLedger } from '../../persistence/src/maintenance.js';
export function mysqlMaintenance(store:MysqlStore){const uow=store.unitOfWork((connection,_core,active)=>({all:async(q:string,v:unknown[])=>{active();const [rows]=await connection.query<RowDataPacket[]>(q+' FOR UPDATE',v);return rows;},run:async(q:string,v:unknown[])=>{active();await connection.query(q,v);}}));return maintenanceLedger(store.identity.store_id,work=>uow.run(work));}
