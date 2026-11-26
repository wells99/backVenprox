import type { SqliteStore } from './store.js';
import { maintenanceLedger } from '../../persistence/src/maintenance.js';
export function sqliteMaintenance(store:SqliteStore){const uow=store.unitOfWork((db,_core,active)=>({all:async(q:string,v:unknown[])=>{active();return db.prepare(q).all(...v) as Record<string,unknown>[];},run:async(q:string,v:unknown[])=>{active();db.prepare(q).run(...v);}}));return maintenanceLedger(store.identity.store_id,work=>uow.run(work));}
