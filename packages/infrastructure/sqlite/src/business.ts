import type { SqliteStore } from './store.js';
import { businessRepository } from '../../persistence/src/business-repository.js';
import type { BusinessDependencies, BusinessTransaction } from '../../../application/src/business-ports.js';

export function sqliteBusinessUnitOfWork(store:SqliteStore):BusinessDependencies['unitOfWork'] {
  return store.unitOfWork<BusinessTransaction>((db,core,active)=>({...core,business:businessRepository({active,forUpdate:'',
    all:async(sql,values=[])=>{active();return db.prepare(sql).all(...values) as Record<string,unknown>[];},
    run:async(sql,values=[])=>{active();db.prepare(sql).run(...values);},
  },store.identity.store_id)}));
}
