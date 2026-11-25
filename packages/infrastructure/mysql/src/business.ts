import type { RowDataPacket } from 'mysql2/promise';
import type { MysqlStore } from './store.js';
import { businessRepository } from '../../persistence/src/business-repository.js';
import type { BusinessDependencies, BusinessTransaction } from '../../../application/src/business-ports.js';
import { publicationRepository } from '../../persistence/src/publication-repository.js';

export function mysqlBusinessUnitOfWork(store:MysqlStore):BusinessDependencies['unitOfWork'] {
  return store.unitOfWork<BusinessTransaction>((connection,core,active)=>{const sql={active,forUpdate:' FOR UPDATE',
    // assertReady pode ter aberto um snapshot antes de esperar o lock da loja.
    // Leituras atuais evitam validar uma versão/unicidade antiga após a espera.
    all:async(sql:string,values:unknown[]=[])=>{active();const [rows]=await connection.query<RowDataPacket[]>(sql.endsWith(' FOR UPDATE')?sql:`${sql} FOR UPDATE`,values);return rows;},
    run:async(sql:string,values:unknown[]=[])=>{active();await connection.query(sql,values);},
  };const publication=publicationRepository(sql,store.identity.store_id),business=businessRepository(sql,store.identity.store_id);
  return {...core,publication,business:{...business,lockScope:()=>publication.lock()}};});
}
