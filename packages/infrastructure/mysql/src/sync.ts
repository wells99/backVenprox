import type { RowDataPacket } from 'mysql2/promise';
import type { MysqlStore } from './store.js';
import type { SyncDependencies, SyncTransaction } from '../../../application/src/sync-ports.js';
import { businessRepository, type BusinessSql } from '../../persistence/src/business-repository.js';
import { syncRepository } from '../../persistence/src/sync-repository.js';
import { publicationRepository } from '../../persistence/src/publication-repository.js';
import type { DownloadTransaction } from '../../../application/src/publication-ports.js';
import type { ResolutionTransaction } from '../../../application/src/sync-resolution-ports.js';
import { resolutionRepository } from '../../persistence/src/sync-resolution-repository.js';
export function mysqlSyncUnitOfWork(store:MysqlStore) {
  return store.unitOfWork<DownloadTransaction&ResolutionTransaction>((connection,core,active)=>{
    const sql:BusinessSql={active,forUpdate:' FOR UPDATE',all:async(query,values=[])=>{active();const [rows]=await connection.query<RowDataPacket[]>(query.endsWith(' FOR UPDATE')?query:`${query} FOR UPDATE`,values);return rows;},run:async(query,values=[])=>{active();await connection.query(query,values);}};
    const publication=publicationRepository(sql,store.identity.store_id),business=businessRepository(sql,store.identity.store_id);
    return {...core,publication,business:{...business,lockScope:()=>publication.lock()},sync:syncRepository(sql,store.identity.store_id),resolutions:resolutionRepository(sql,store.identity.store_id)};
  });
}
export const atomicSyncPublication:SyncDependencies['publication']={publish:async(tx:SyncTransaction,envelope,result)=>{
  if(!tx.publication)throw new Error('PUBLICATION_REQUIRED');
  const stock_deltas:{id:string;product_id:string;delta_milli:number}[]=[],p=envelope.payload as {movement?:{id:string;product_id:string;delta_milli:number}|null;stock_movement_ids?:{id:string;item_id:string}[];items?:{id:string;product_id?:string|null;quantity_milli:number;sale_item_id?:string;stock_movement_id?:string|null}[];reversal?:{sale_id:string}};
  if(envelope.type==='stock.entry.v1'||envelope.type==='stock.count.v1'){if(p.movement)stock_deltas.push({id:p.movement.id,product_id:p.movement.product_id,delta_milli:p.movement.delta_milli});}
  if(envelope.type==='sale.completed')for(const m of p.stock_movement_ids??[]){const item=p.items!.find((i)=>i.id===m.item_id)!;stock_deltas.push({id:m.id,product_id:item.product_id!,delta_milli:-item.quantity_milli});}
  if(envelope.type==='sale.reversed')for(const item of p.items??[]){if(!item.stock_movement_id)continue;const original=await tx.business.movementByOrigin(p.reversal!.sale_id,'sale',item.sale_item_id!);if(!original)throw new Error('ORIGINAL_MOVEMENT_MISSING');stock_deltas.push({id:item.stock_movement_id,product_id:original.product_id,delta_milli:item.quantity_milli});}
  await tx.publication.publish({operation_id:envelope.operation_id,type:envelope.type,source:'device',origin:{device_id:envelope.device_id,device_seq:envelope.device_seq},payload:envelope.payload,published_at:result!.received_at,projection:{stock_deltas}});
}};
