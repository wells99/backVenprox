import type { SqliteStore } from './store.js';
import { businessRepository } from '../../persistence/src/business-repository.js';
import type { BusinessDependencies, BusinessTransaction } from '../../../application/src/business-ports.js';
import { syncStockQuantity } from './sync-stock.js';

export function sqliteBusinessUnitOfWork(store:SqliteStore):BusinessDependencies['unitOfWork'] {
  return store.unitOfWork<BusinessTransaction>((db,core,active)=>{const business=businessRepository({active,forUpdate:'',
    all:async(sql,values=[])=>{active();return db.prepare(sql).all(...values) as Record<string,unknown>[];},
    run:async(sql,values=[])=>{active();db.prepare(sql).run(...values);},
  },store.identity.store_id);return {...core,business:{...business,stockProjectionSum:async(id)=>{active();const runtime=db.prepare('SELECT initialized,baseline_seq FROM sync_runtime WHERE store_id=? AND device_id=?').get(store.identity.store_id,store.identity.device_id!) as {initialized:number;baseline_seq:string}|undefined;return runtime?.initialized===1?String(syncStockQuantity(db,id,runtime.baseline_seq)):business.ledgerSum(id);}}};});
}
