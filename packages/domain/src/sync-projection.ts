// Only extracts immutable movement IDs; it never recalculates a financial case.
export function eventMovementIds(type:string,payload:unknown):string[]{
  const p=payload as {movement?:{id:string}|null;stock_movement_ids?:{id:string}[];items?:{stock_movement_id?:string|null}[]};
  if(type==='stock.entry.v1'||type==='stock.count.v1')return p.movement?[p.movement.id]:[];
  if(type==='sale.completed')return (p.stock_movement_ids??[]).map((m)=>m.id);
  if(type==='sale.reversed')return (p.items??[]).flatMap((m)=>m.stock_movement_id?[m.stock_movement_id]:[]);
  return [];
}
