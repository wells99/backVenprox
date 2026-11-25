import type { RowDataPacket } from 'mysql2/promise';
import type { MysqlStore } from './store.js';
import { businessRepository } from '../../persistence/src/business-repository.js';
import type { BusinessDependencies, BusinessTransaction } from '../../../application/src/business-ports.js';

export function mysqlBusinessUnitOfWork(store:MysqlStore):BusinessDependencies['unitOfWork'] {
  return store.unitOfWork<BusinessTransaction>((connection,core,active)=>({...core,business:businessRepository({active,forUpdate:' FOR UPDATE',
    // assertReady pode ter aberto um snapshot antes de esperar o lock da loja.
    // Leituras atuais evitam validar uma versão/unicidade antiga após a espera.
    all:async(sql,values=[])=>{active();const [rows]=await connection.query<RowDataPacket[]>(sql.endsWith(' FOR UPDATE')?sql:`${sql} FOR UPDATE`,values);return rows;},
    run:async(sql,values=[])=>{active();await connection.query(sql,values);},
  },store.identity.store_id)}));
}
