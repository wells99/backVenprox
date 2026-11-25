import { createHash } from 'node:crypto';
import type { BusinessRepository, Category, Customer, Entity, EntityKind, Intention, PageQuery, Product, Proposal, StockBalance, StockMovement, StoreSettings, TerminalSettings } from '../../../application/src/business-ports.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import { cashRepository } from './cash-repository.js';
import { salesRepository } from './sales-repository.js';

export interface BusinessSql { all(sql:string,values?:unknown[]):Promise<Record<string,unknown>[]>;run(sql:string,values?:unknown[]):Promise<void>;forUpdate:string;active():void }
const moneyFields=new Set(['price_cents','cost_cents','quantity_milli','delta_milli','before_milli','after_milli','unit_cost_cents','version','base_version']);
const booleanFields=new Set(['active','automatic_printing','images_enabled']);
function decode(row:Record<string,unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key,value])=>{
    if(moneyFields.has(key)&&value!==null){const number=Number(value);if(!Number.isSafeInteger(number))throw new ApplicationError('INVALID_PERSISTED_NUMBER','Valor persistido fora da faixa segura.','unavailable');return[key,number];}
    if(booleanFields.has(key))return[key,Number(value)===1];
    return[key,value];
  }));
}
function stable(value:unknown):unknown {
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,stable(item)]));
  return value;
}
export const businessHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function barcodeId(store:string,product:string,barcode:string) {
  const bytes=createHash('sha256').update(`venprox-barcode-v1:${store}:${product}:${barcode}`).digest().subarray(0,16);bytes[6]=(bytes[6]!&15)|128;bytes[8]=(bytes[8]!&63)|128;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function businessRepository(sql:BusinessSql,storeId:string):BusinessRepository {
  async function rows<T>(table:string,predicate='',values:unknown[]=[]):Promise<T[]> {
    sql.active();return (await sql.all(`SELECT * FROM ${table} WHERE store_id=? ${predicate}`,[storeId,...values])).map(decode) as T[];
  }
  async function one<T>(table:string,predicate:string,values:unknown[]) {return (await rows<T>(table,predicate,values))[0];}
  async function save(table:string,value:object,keys:string[]) {
    sql.active();const record=value as Record<string,unknown>;
    if(record.store_id!==storeId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');
    const columns=Object.keys(record),updates=columns.filter((column)=>!keys.includes(column));
    const predicate=keys.map((column)=>`${column}=?`).join(' AND '),keyValues=keys.map((column)=>record[column]);
    const convert=(value:unknown)=>typeof value==='boolean'?Number(value):value;
    if((await sql.all(`SELECT 1 FROM ${table} WHERE ${predicate}`,keyValues)).length)await sql.run(`UPDATE ${table} SET ${updates.map((column)=>`${column}=?`).join(',')} WHERE ${predicate}`,[...updates.map((column)=>convert(record[column])),...keyValues]);
    else await sql.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,columns.map((column)=>convert(record[column])));
  }
  async function product(id:string):Promise<Product|undefined> {
    const row=await one<Omit<Product,'barcodes'>>('products','AND id=?',[id]);
    if(!row)return undefined;
    const barcodes=await rows<{barcode:string}>('product_barcodes','AND product_id=? AND active=1 ORDER BY barcode',[id]);
    return {...row,barcodes:barcodes.map((item)=>item.barcode)};
  }
  async function saveProduct(value:Product) {
    const {barcodes,...row}=value;await save('products',row,['store_id','id']);
    const existing=await rows<{id:string;barcode:string;active:boolean;version:number}>('product_barcodes','AND product_id=?',[value.id]);
    for(const previous of existing) if(previous.active!==barcodes.includes(previous.barcode))await sql.run('UPDATE product_barcodes SET active=?,version=version+1 WHERE store_id=? AND id=?',[Number(barcodes.includes(previous.barcode)),storeId,previous.id]);
    for(const barcode of barcodes)if(!existing.some((item)=>item.barcode===barcode))await sql.run('INSERT INTO product_barcodes(id,store_id,product_id,barcode,active,version) VALUES(?,?,?,?,1,1)',[barcodeId(storeId,value.id,barcode),storeId,value.id,barcode]);
  }
  async function page(kind:EntityKind,query:PageQuery):Promise<Entity[]> {
    const clauses:string[]=[],values:unknown[]=[];
    if(query.after){clauses.push('id>?');values.push(query.after);}
    if(query.active!==undefined){clauses.push('active=?');values.push(Number(query.active));}
    if(query.q){
      const escaped=query.q.replaceAll('=','==').replaceAll('%','=%').replaceAll('_','=_');
      const basic="search_key LIKE ? ESCAPE '='";
      clauses.push(kind==='products'?`(${basic} OR code_key LIKE ? ESCAPE '=' OR EXISTS(SELECT 1 FROM product_barcodes b WHERE b.store_id=products.store_id AND b.product_id=products.id AND b.active=1 AND b.barcode=?))`:basic);
      values.push(`%${escaped}%`); if(kind==='products')values.push(`%${(query.code_q??query.q.toUpperCase()).replaceAll('=','==').replaceAll('%','=%').replaceAll('_','=_')}%`,query.q);
    }
    const result=await rows<Entity>(kind,`${clauses.length?`AND ${clauses.join(' AND ')}`:''} ORDER BY id LIMIT ?`,[...values,query.limit+1]);
    if(kind==='products')return Promise.all(result.map((row)=>product(row.id).then((value)=>value!)));
    return result;
  }
  return {
    ...cashRepository(sql,storeId),
    ...salesRepository(sql,storeId),
    lockScope:async()=>{sql.active();await sql.all(`SELECT store_id FROM instance_identity WHERE store_id=?${sql.forUpdate}`,[storeId]);},
    category:(id)=>one<Category>('categories','AND id=?',[id]),saveCategory:(value)=>save('categories',value,['store_id','id']),
    product,saveProduct,codeOwner:async(key)=>(await one<{id:string}>('products','AND code_key=?',[key]))?.id,
    barcodeOwner:async(barcode)=>(await one<{product_id:string}>('product_barcodes','AND barcode=?',[barcode]))?.product_id,
    customer:(id)=>one<Customer>('customers','AND id=?',[id]),saveCustomer:(value)=>save('customers',value,['store_id','id']),page,
    settings:async()=>{
      let value=await one<StoreSettings>('store_settings','',[]);
      if(!value){await sql.run('INSERT INTO store_settings(id,store_id) VALUES(?,?)',[storeId,storeId]);value=(await one<StoreSettings>('store_settings','',[]))!;}return value;
    },saveSettings:(value)=>save('store_settings',value,['store_id','id']),
    terminalSettings:async(deviceId)=>{
      let value=await one<TerminalSettings>('terminal_settings','AND device_id=?',[deviceId]);
      if(!value){await sql.run('INSERT INTO terminal_settings(store_id,device_id) VALUES(?,?)',[storeId,deviceId]);value=(await one<TerminalSettings>('terminal_settings','AND device_id=?',[deviceId]))!;}return value;
    },saveTerminalSettings:(value)=>save('terminal_settings',value,['store_id','device_id']),
    intention:(id)=>one<Intention>('catalog_intentions','AND intention_id=?',[id]),saveIntention:(value)=>save('catalog_intentions',value,['store_id','intention_id']),
    proposal:(id)=>one<Proposal>('catalog_proposals','AND intention_id=?',[id]),saveProposal:(value)=>save('catalog_proposals',value,['store_id','intention_id']),
    proposals:(kind)=>rows<Proposal>('catalog_proposals',`${kind?'AND entity_type=?':''} ORDER BY intention_id LIMIT 100`,kind?[kind]:[]),
    balance:async(productId)=>(await one<StockBalance>('stock_balances','AND product_id=?',[productId]))??{store_id:storeId,product_id:productId,quantity_milli:0,version:0},
    saveBalance:(value)=>save('stock_balances',value,['store_id','product_id']),
    movements:async(query)=>{
      const clauses:string[]=[],values:unknown[]=[];
      if(query.product_id){clauses.push('product_id=?');values.push(query.product_id);}
      if(query.from){clauses.push('occurred_at>=?');values.push(query.from);}
      if(query.to){clauses.push('occurred_at<=?');values.push(query.to);}
      if(query.after_at&&query.after_id){clauses.push('(occurred_at>? OR(occurred_at=? AND id>?))');values.push(query.after_at,query.after_at,query.after_id);}
      return rows<StockMovement>('stock_movements',`${clauses.length?`AND ${clauses.join(' AND ')}`:''} ORDER BY occurred_at,id LIMIT ?`,[...values,query.limit+1]);
    },
    movementByOrigin:(origin,kind,item)=>one<StockMovement>('stock_movements','AND origin_id=? AND kind=? AND item_id=?',[origin,kind,item]),
    appendMovement:async(value)=>{
      if(value.store_id!==storeId)throw new ApplicationError('SCOPE_MISMATCH','Escopo inválido.','forbidden');
      sql.active();const columns=Object.keys(value);await sql.run(`INSERT INTO stock_movements(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,Object.values(value));
    },
    ledgerSum:async(productId)=>{
      const rows=await sql.all('SELECT delta_milli FROM stock_movements WHERE store_id=? AND product_id=? ORDER BY occurred_at,id',[storeId,productId]);
      return rows.reduce((total,row)=>total+BigInt(String(row.delta_milli)),0n).toString();
    },
  };
}
