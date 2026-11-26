import type { SqliteStore } from './store.js';
import { businessRepository } from '../../persistence/src/business-repository.js';
import { readRepository } from '../../persistence/src/read-repository.js';
import type { ReadDependencies } from '../../../application/src/read-ports.js';
export function sqliteReadUnitOfWork(store:SqliteStore):ReadDependencies['unitOfWork']{return store.unitOfWork((db,_core,active)=>{const sql={active,forUpdate:'',all:async(query:string,values:unknown[]=[])=>{active();return db.prepare(query).all(...values) as Record<string,unknown>[];},run:async(query:string,values:unknown[]=[])=>{active();db.prepare(query).run(...values);}};return {business:businessRepository(sql,store.identity.store_id),read:readRepository(sql,store.identity.store_id,store.identity.device_id!)};});}
